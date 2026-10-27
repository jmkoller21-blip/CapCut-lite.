//! A small HTTP/1.1 server on 127.0.0.1 (std only). It serves the UI, the JSON command API and
//! media files (with Range support so video can seek). Access control:
//!   * bound to loopback only
//!   * the Host header must be this server (blocks DNS-rebinding)
//!   * every request needs the per-launch token, carried in a cookie set at first load
//!   * media is served only for files the user added (or this app's own folders)

use crate::cmd::{App, Paths};
use crate::json::Json;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct Handle {
    pub port: u16,
    pub token: String,
    pub app: Arc<App>,
}

impl Handle {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/?t={}", self.port, self.token)
    }
}

fn random_token() -> String {
    // RandomState is seeded from the operating system's random source, so this is unguessable.
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..4u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

pub fn start(paths: Paths, port: u16, fixed_token: Option<String>) -> Result<Handle, String> {
    let app = App::new(paths)?;
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("could not start the local server: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = fixed_token.unwrap_or_else(random_token);
    let (app2, token2) = (app.clone(), token.clone());
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if let Ok(stream) = conn {
                let (a, t) = (app2.clone(), token2.clone());
                std::thread::spawn(move || {
                    let _ = handle(stream, &a, &t, port);
                });
            }
        }
    });
    Ok(Handle { port, token, app })
}

struct Req {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

pub fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16);
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub fn url_encode(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{:02X}", b));
        }
    }
    o
}

fn read_request(stream: &mut TcpStream) -> Result<Req, String> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(30))).ok();
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    let mut parts = line.split_whitespace();
    let method = parts.next().ok_or("bad request")?.to_string();
    let target = parts.next().ok_or("bad request")?.to_string();
    let (path, qs) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };
    let mut query = HashMap::new();
    for kv in qs.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        query.insert(url_decode(k), url_decode(v));
    }
    let mut headers = HashMap::new();
    let mut total = 0usize;
    loop {
        let mut h = String::new();
        let n = reader.read_line(&mut h).map_err(|e| e.to_string())?;
        total += n;
        if n == 0 || total > 64 * 1024 {
            return Err("bad headers".into());
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > 256 * 1024 * 1024 {
        return Err("request too large".into());
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    Ok(Req { method, path: url_decode(&path), query, headers, body })
}

fn respond(stream: &mut TcpStream, code: u16, ctype: &str, extra: &[(&str, String)], body: &[u8]) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        206 => "Partial Content",
        302 => "Found",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        416 => "Range Not Satisfiable",
        _ => "Error",
    };
    let mut head = format!("HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n", code, reason, ctype, body.len());
    for (k, v) in extra {
        head.push_str(&format!("{}: {}\r\n", k, v));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)
}

pub fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

fn cookie_token(headers: &HashMap<String, String>) -> Option<String> {
    let c = headers.get("cookie")?;
    c.split(';').filter_map(|p| p.trim().strip_prefix("lt=")).next().map(|s| s.to_string())
}

fn handle(mut stream: TcpStream, app: &Arc<App>, token: &str, port: u16) -> Result<(), String> {
    let req = match read_request(&mut stream) {
        Ok(r) => r,
        Err(e) => {
            let _ = respond(&mut stream, 400, "text/plain", &[], e.as_bytes());
            return Ok(());
        }
    };
    let io = |r: std::io::Result<()>| r.map_err(|e| e.to_string());

    // DNS-rebinding guard
    let host = req.headers.get("host").cloned().unwrap_or_default();
    if host != format!("127.0.0.1:{}", port) && host != format!("localhost:{}", port) {
        return io(respond(&mut stream, 403, "text/plain", &[], b"forbidden"));
    }
    // token: first load passes ?t=, then a cookie carries it
    let from_query = req.query.get("t").map(|t| t == token).unwrap_or(false);
    let from_cookie = cookie_token(&req.headers).map(|t| t == token).unwrap_or(false);
    if !from_query && !from_cookie {
        return io(respond(&mut stream, 403, "text/plain", &[], b"forbidden"));
    }
    if from_query && req.path == "/" {
        let cookie = format!("lt={}; Path=/; HttpOnly; SameSite=Strict", token);
        return io(respond(&mut stream, 302, "text/plain", &[("Set-Cookie", cookie), ("Location", "/".to_string())], b""));
    }
    if !from_cookie && !from_query {
        return io(respond(&mut stream, 403, "text/plain", &[], b"forbidden"));
    }

    // ---- API
    if req.method == "POST" && req.path.starts_with("/api/") {
        let cmd = &req.path[5..];
        let args = if req.body.is_empty() { Ok(Json::Obj(vec![])) } else { Json::parse(&String::from_utf8_lossy(&req.body)) };
        let body = match args {
            Err(e) => Json::obj(vec![("ok", Json::Bool(false)), ("error", Json::s(&format!("bad request: {}", e)))]),
            Ok(a) => match app.dispatch(cmd, &a) {
                Ok(v) => Json::obj(vec![("ok", Json::Bool(true)), ("data", v)]),
                Err(e) => Json::obj(vec![("ok", Json::Bool(false)), ("error", Json::s(&e))]),
            },
        };
        return io(respond(&mut stream, 200, "application/json", &[("Cache-Control", "no-store".into())], body.to_string().as_bytes()));
    }
    if req.method == "POST" && req.path == "/upload" {
        let name = req.query.get("name").cloned().unwrap_or_else(|| "voice.webm".into());
        let body = match app.save_upload(&name, &req.body) {
            Ok(p) => Json::obj(vec![("ok", Json::Bool(true)), ("data", Json::obj(vec![("path", Json::s(&p))]))]),
            Err(e) => Json::obj(vec![("ok", Json::Bool(false)), ("error", Json::s(&e))]),
        };
        return io(respond(&mut stream, 200, "application/json", &[], body.to_string().as_bytes()));
    }
    if req.method != "GET" && req.method != "HEAD" {
        return io(respond(&mut stream, 400, "text/plain", &[], b"unsupported"));
    }

    // ---- files by absolute path (media the user added, caches, stock)
    if req.path == "/file" {
        let p = req.query.get("p").cloned().unwrap_or_default();
        let path = PathBuf::from(&p);
        if !app.is_allowed(&path) {
            return io(respond(&mut stream, 403, "text/plain", &[], b"not available"));
        }
        return serve_file(&mut stream, &path, &req, false);
    }

    // ---- static UI
    let rel = if req.path == "/" { "index.html".to_string() } else { req.path.trim_start_matches('/').to_string() };
    if rel.split('/').any(|s| s == ".." || s.contains('\\') || s.contains(':')) {
        return io(respond(&mut stream, 403, "text/plain", &[], b"forbidden"));
    }
    let path = app.paths.ui_dir.join(&rel);
    serve_file(&mut stream, &path, &req, true)
}

fn serve_file(stream: &mut TcpStream, path: &Path, req: &Req, is_ui: bool) -> Result<(), String> {
    let io = |r: std::io::Result<()>| r.map_err(|e| e.to_string());
    let mut f = match std::fs::File::open(path) {
        Ok(f) if path.is_file() => f,
        _ => return io(respond(stream, 404, "text/plain", &[], b"not found")),
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let ctype = mime(path);
    let cache = if is_ui { "no-cache" } else { "private, max-age=3600" };
    let mut start = 0u64;
    let mut end = len.saturating_sub(1);
    let mut partial = false;
    if let Some(r) = req.headers.get("range") {
        if let Some(spec) = r.strip_prefix("bytes=") {
            let (a, b) = spec.split_once('-').unwrap_or((spec, ""));
            if a.is_empty() {
                // suffix range: last N bytes
                if let Ok(n) = b.parse::<u64>() {
                    start = len.saturating_sub(n);
                }
            } else if let Ok(s) = a.parse::<u64>() {
                start = s;
                if let Ok(e) = b.parse::<u64>() {
                    end = e.min(len.saturating_sub(1));
                }
            }
            if start >= len || start > end {
                return io(respond(stream, 416, "text/plain", &[("Content-Range", format!("bytes */{}", len))], b""));
            }
            partial = true;
        }
    }
    let count = if len == 0 { 0 } else { end - start + 1 };
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nCache-Control: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n",
        if partial { 206 } else { 200 },
        if partial { "Partial Content" } else { "OK" },
        ctype, count, cache
    );
    if partial {
        head.push_str(&format!("Content-Range: bytes {}-{}/{}\r\n", start, end, len));
    }
    head.push_str("\r\n");
    io(stream.write_all(head.as_bytes()))?;
    if req.method == "HEAD" || count == 0 {
        return Ok(());
    }
    use std::io::Seek;
    f.seek(std::io::SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut remaining = count;
    let mut buf = vec![0u8; 64 * 1024];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = f.read(&mut buf[..want]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if stream.write_all(&buf[..n]).is_err() {
            break; // the player closed the connection (seek or stop)
        }
        remaining -= n as u64;
    }
    Ok(())
}

/// Blocks forever. Used by the dev server and tests.
pub fn run_blocking(paths: Paths, port: u16, token: Option<String>) -> Result<(), String> {
    let h = start(paths, port, token)?;
    println!("Lite Editor engine listening: {}", h.url());
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_roundtrip() {
        for p in ["C:\\Users\\Jo Smith\\Videos\\clip (1).mp4", "/tmp/é ü/файл.mp4", "a+b%c", "%", "%4", "%41", "100%"] {
            if !p.contains('%') && !p.contains('+') {
                assert_eq!(url_decode(&url_encode(p)), p);
            }
        }
        assert_eq!(url_decode("a%20b%2Fc"), "a b/c");
        assert_eq!(url_decode("%41"), "A");
        assert_eq!(url_decode("%zz%4"), "%zz%4");
        assert_eq!(url_decode("a+b"), "a b");
    }

    #[test]
    fn tokens_differ() {
        assert_ne!(random_token(), random_token());
        assert_eq!(random_token().len(), 64);
    }
}

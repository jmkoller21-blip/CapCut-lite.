use engine::cmd::Paths;
use engine::json::Json;
use engine::server::{self, url_encode, Handle};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("lite-srv-{}-{}", name, engine::store::new_id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

struct Resp {
    code: u16,
    headers: String,
    body: Vec<u8>,
}

fn http(h: &Handle, method: &str, path: &str, extra: &[(&str, &str)], body: &[u8], host: Option<&str>) -> Resp {
    let mut s = TcpStream::connect(("127.0.0.1", h.port)).unwrap();
    let host = host.map(|x| x.to_string()).unwrap_or(format!("127.0.0.1:{}", h.port));
    let mut req = format!("{} {} HTTP/1.1\r\nHost: {}\r\nContent-Length: {}\r\n", method, path, host, body.len());
    for (k, v) in extra {
        req.push_str(&format!("{}: {}\r\n", k, v));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).unwrap();
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&buf[..split]).to_string();
    let code: u16 = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    Resp { code, headers: head, body: buf[split + 4..].to_vec() }
}

fn setup() -> (Handle, PathBuf) {
    let ui = tmp("ui");
    std::fs::write(ui.join("index.html"), "<html>ok</html>").unwrap();
    std::fs::create_dir_all(ui.join("js")).unwrap();
    std::fs::write(ui.join("js/a.js"), "1").unwrap();
    let stock = tmp("stock");
    let data = tmp("data");
    let paths = Paths { data_dir: data, ui_dir: ui, stock_dir: stock, font_dir: PathBuf::from("/usr/share/fonts/opentype/inter"), ffmpeg_dir: None };
    let h = server::start(paths, 0, Some("tok123".into())).unwrap();
    (h, tmp("media"))
}

fn api(h: &Handle, cmd: &str, args: &str) -> Json {
    let r = http(h, "POST", &format!("/api/{}", cmd), &[("Cookie", "lt=tok123")], args.as_bytes(), None);
    assert_eq!(r.code, 200);
    Json::parse(&String::from_utf8_lossy(&r.body)).unwrap()
}

fn ok(j: &Json) -> &Json {
    assert!(j.bool_or("ok", false), "api error: {}", j.str_or("error", "?"));
    j.get("data").unwrap()
}

fn gen(path: &Path, vf: &str, extra: &[&str]) {
    let mut c = Command::new("ffmpeg");
    c.args(["-y", "-v", "error", "-f", "lavfi", "-i", vf, "-f", "lavfi", "-i", "sine=frequency=330:d=3", "-shortest"]);
    c.args(extra).arg(path);
    assert!(c.status().unwrap().success());
}

fn wait_job(h: &Handle, id: &str) -> Json {
    for _ in 0..300 {
        let j = api(h, "job_status", &format!(r#"{{"id":"{}"}}"#, id));
        let d = ok(&j).clone();
        if d.str_or("state", "") != "running" {
            return d;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    panic!("job did not finish");
}

#[test]
fn access_control() {
    let (h, _) = setup();
    assert_eq!(http(&h, "GET", "/", &[], b"", None).code, 403, "no token");
    assert_eq!(http(&h, "GET", "/?t=wrong", &[], b"", None).code, 403, "wrong token");
    assert_eq!(http(&h, "GET", "/?t=tok123", &[], b"", Some("evil.example.com")).code, 403, "wrong host (DNS rebinding)");
    let r = http(&h, "GET", "/?t=tok123", &[], b"", None);
    assert_eq!(r.code, 302);
    assert!(r.headers.contains("Set-Cookie: lt=tok123") && r.headers.contains("HttpOnly") && r.headers.contains("SameSite=Strict"));
    let r = http(&h, "GET", "/", &[("Cookie", "lt=tok123")], b"", None);
    assert_eq!((r.code, String::from_utf8_lossy(&r.body).to_string()), (200, "<html>ok</html>".to_string()));
    assert_eq!(http(&h, "GET", "/js/a.js", &[("Cookie", "lt=tok123")], b"", None).code, 200);
    assert_eq!(http(&h, "GET", "/../etc/passwd", &[("Cookie", "lt=tok123")], b"", None).code, 403);
    assert_eq!(http(&h, "GET", "/%2e%2e/etc/passwd", &[("Cookie", "lt=tok123")], b"", None).code, 403);
    assert_eq!(http(&h, "GET", "/nothing.js", &[("Cookie", "lt=tok123")], b"", None).code, 404);
    // arbitrary files are not readable
    let r = http(&h, "GET", &format!("/file?p={}", url_encode("/etc/passwd")), &[("Cookie", "lt=tok123")], b"", None);
    assert_eq!(r.code, 403);
    // API needs the token too
    assert_eq!(http(&h, "POST", "/api/project_list", &[], b"{}", None).code, 403);
    // unknown command is a clean error, not a crash
    let j = api(&h, "does_not_exist", "{}");
    assert!(!j.bool_or("ok", true));
    let r = http(&h, "POST", "/api/project_list", &[("Cookie", "lt=tok123")], b"{bad json", None);
    assert!(String::from_utf8_lossy(&r.body).contains("bad request"));
}

#[test]
fn project_lifecycle() {
    let (h, _) = setup();
    let d = ok(&api(&h, "project_new", r#"{"name":"My cut","width":1280,"height":720,"fps":25}"#)).clone();
    let id = d.str_or("id", "");
    assert_eq!(d.get("tracks").unwrap().as_arr().len(), 4);
    assert_eq!(d.i64_or("width", 0), 1280);
    let mut doc = d.clone();
    if let Json::Obj(items) = &mut doc {
        for (k, v) in items.iter_mut() {
            if k == "name" {
                *v = Json::s("Renamed");
            }
        }
    }
    ok(&api(&h, "project_save", &format!(r#"{{"doc":{}}}"#, doc.to_string())));
    let l = ok(&api(&h, "project_load", &format!(r#"{{"id":"{}"}}"#, id))).clone();
    assert_eq!(l.str_or("name", ""), "Renamed");
    let list = ok(&api(&h, "project_list", "{}")).clone();
    assert_eq!(list.as_arr().len(), 1);
    assert!(!api(&h, "project_load", r#"{"id":"../../x"}"#).bool_or("ok", true));
    ok(&api(&h, "project_delete", &format!(r#"{{"id":"{}"}}"#, id)));
    assert_eq!(ok(&api(&h, "project_list", "{}")).as_arr().len(), 0);
}

#[test]
fn import_proxy_range_waveform_export() {
    let (h, media) = setup();
    let info = ok(&api(&h, "sys_info", "{}")).clone();
    assert!(info.get("ffmpeg").unwrap().as_str().is_some());
    assert!(info.get("encoders").unwrap().as_arr().len() >= 1);

    // a small H.264 clip: plays directly, no proxy. A 1080p clip and an AVI: need proxies.
    let small = media.join("small.mp4");
    gen(&small, "testsrc=s=640x360:r=30:d=3", &["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
    let big = media.join("big.mp4");
    gen(&big, "testsrc2=s=1920x1080:r=30:d=3", &["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
    let avi = media.join("old name (1).avi");
    gen(&avi, "testsrc=s=320x240:r=25:d=3", &["-c:v", "mpeg4", "-c:a", "mp3"]);
    let wav = media.join("tone.wav");
    assert!(Command::new("ffmpeg").args(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=500:d=2"]).arg(&wav).status().unwrap().success());
    let notmedia = media.join("notes.txt");
    std::fs::write(&notmedia, "hello").unwrap();

    let paths: Vec<String> = [&small, &big, &avi, &wav, &notmedia, &media.join("missing.mp4")].iter().map(|p| format!("\"{}\"", p.to_string_lossy())).collect();
    let r = ok(&api(&h, "media_import", &format!(r#"{{"paths":[{}]}}"#, paths.join(",")))).clone();
    let items = r.get("items").unwrap().as_arr().to_vec();
    assert_eq!(items.len(), 6);
    let by = |n: &str| items.iter().find(|i| i.str_or("name", "") == n).unwrap().clone();
    let s = by("small.mp4");
    assert_eq!(s.str_or("kind", ""), "video");
    assert!(s.get("proxy_job").is_none(), "small h264 mp4 needs no proxy");
    assert!(s.bool_or("thumb", false));
    assert!(s.bool_or("has_audio", false));
    assert_eq!((s.i64_or("w", 0), s.i64_or("h", 0)), (640, 360));
    assert!((s.f64_or("dur", 0.0) / 1e6 - 3.0).abs() < 0.3);
    assert!(by("notes.txt").get("error").is_some());
    assert!(by("missing.mp4").get("error").is_some());
    assert_eq!(by("tone.wav").str_or("kind", ""), "audio");
    assert!(by("tone.wav").get("proxy_job").is_none(), "wav plays directly");

    for name in ["big.mp4", "old name (1).avi"] {
        let it = by(name);
        let job = it.str_or("proxy_job", "");
        assert!(!job.is_empty(), "{} needs a proxy", name);
        let d = wait_job(&h, &job);
        assert_eq!(d.str_or("state", ""), "done", "{}: {}", name, d.str_or("message", ""));
        let proxy = d.get("result").unwrap().str_or("proxy", "");
        assert!(Path::new(&proxy).exists());
        let pi = Command::new("ffprobe").args(["-v", "error", "-show_entries", "stream=codec_name,height", "-of", "compact", &proxy]).output().unwrap();
        let txt = String::from_utf8_lossy(&pi.stdout).to_string();
        assert!(txt.contains("h264") || txt.contains("vp8"), "proxy codec: {}", txt);
        // the proxy is served with range support
        let r = http(&h, "GET", &format!("/file?p={}", url_encode(&proxy)), &[("Cookie", "lt=tok123"), ("Range", "bytes=0-99")], b"", None);
        assert_eq!(r.code, 206, "{}", r.headers);
        assert_eq!(r.body.len(), 100);
        assert!(r.headers.contains("Content-Range: bytes 0-99/"));
        let r2 = http(&h, "GET", &format!("/file?p={}", url_encode(&proxy)), &[("Cookie", "lt=tok123"), ("Range", "bytes=-50")], b"", None);
        assert_eq!((r2.code, r2.body.len()), (206, 50));
        let r3 = http(&h, "GET", &format!("/file?p={}", url_encode(&proxy)), &[("Cookie", "lt=tok123"), ("Range", "bytes=999999999-")], b"", None);
        assert_eq!(r3.code, 416);
    }
    // the original (imported) file is served too, and the thumbnail
    let r = http(&h, "GET", &format!("/file?p={}", url_encode(&small.to_string_lossy())), &[("Cookie", "lt=tok123")], b"", None);
    assert_eq!(r.code, 200);
    assert_eq!(r.body.len() as u64, std::fs::metadata(&small).unwrap().len());
    let th = format!("{}/cache/thumbs/{}.jpg", info.str_or("data_dir", ""), s.str_or("id", ""));
    let r = http(&h, "GET", &format!("/file?p={}", url_encode(&th)), &[("Cookie", "lt=tok123")], b"", None);
    assert_eq!(r.code, 200);
    assert_eq!(&r.body[..2], &[0xff, 0xd8], "jpeg");
    // a file that was never added stays private
    let other = media.join("secret.txt");
    std::fs::write(&other, "x").unwrap();
    assert_eq!(http(&h, "GET", &format!("/file?p={}", url_encode(&other.to_string_lossy())), &[("Cookie", "lt=tok123")], b"", None).code, 403);

    // waveform
    let w = ok(&api(&h, "waveform", &format!(r#"{{"id":"{}","path":"{}"}}"#, s.str_or("id", ""), small.to_string_lossy()))).clone();
    let peaks = w.get("peaks").unwrap().as_arr();
    assert!(peaks.len() >= 55 && peaks.len() <= 65, "3s at 50ms: {}", peaks.len());
    assert!(peaks.iter().any(|p| p.as_f64().unwrap() > 50.0));

    // upload (voice recording)
    let up = http(&h, "POST", "/upload?name=voice.webm", &[("Cookie", "lt=tok123")], b"fakebytes", None);
    let uj = Json::parse(&String::from_utf8_lossy(&up.body)).unwrap();
    let upath = uj.get("data").unwrap().str_or("path", "");
    assert!(Path::new(&upath).exists() && upath.ends_with(".webm"));

    // export through the API
    let doc = format!(
        r#"{{"id":"x","name":"E","width":640,"height":360,"fps":30,
        "media":[{},{}],
        "tracks":[{{"id":"v","kind":"video","clips":[
          {{"id":"c1","media":"{}","start":0,"dur":1500000}},
          {{"id":"c2","media":"{}","start":1500000,"dur":1500000,"transition_in":{{"kind":"dissolve","dur":500000}}}}]}}]}}"#,
        by("small.mp4").to_string(), by("old name (1).avi").to_string(), by("small.mp4").str_or("id", ""), by("old name (1).avi").str_or("id", "")
    );
    let out = media.join("final.mp4");
    let r = api(&h, "export_start", &format!(r#"{{"doc":{},"settings":{{"path":"{}","width":640,"height":360,"fps":30,"quality":"low"}}}}"#, doc, out.to_string_lossy()));
    let job = ok(&r).str_or("job", "");
    let d = wait_job(&h, &job);
    assert_eq!(d.str_or("state", ""), "done", "{}", d.str_or("message", ""));
    assert!(out.exists());
    let pi = Command::new("ffprobe").args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"]).arg(&out).output().unwrap();
    let dur: f64 = String::from_utf8_lossy(&pi.stdout).trim().parse().unwrap();
    assert!((dur - 3.0).abs() < 0.2, "export duration {}", dur);
    // cancel a second export immediately
    let out2 = media.join("cancelled.mp4");
    let r = api(&h, "export_start", &format!(r#"{{"doc":{},"settings":{{"path":"{}","width":1280,"height":720,"fps":30,"quality":"high"}}}}"#, doc, out2.to_string_lossy()));
    let job = ok(&r).str_or("job", "");
    api(&h, "job_cancel", &format!(r#"{{"id":"{}"}}"#, job));
    let d = wait_job(&h, &job);
    assert!(d.str_or("state", "") == "cancelled" || d.str_or("state", "") == "done", "{:?}", d.to_string());
    // bad export requests are clean errors
    let r = api(&h, "export_start", r#"{"doc":{"width":640,"height":360,"tracks":[]},"settings":{"path":"/tmp/x.mp4"}}"#);
    assert!(!r.bool_or("ok", true));
}

#[test]
fn settings_and_cache() {
    let (h, _) = setup();
    ok(&api(&h, "settings_set", r#"{"settings":{"proxy_height":360,"theme":"dark"}}"#));
    assert_eq!(ok(&api(&h, "settings_get", "{}")).i64_or("proxy_height", 0), 360);
    assert!(ok(&api(&h, "cache_info", "{}")).f64_or("bytes", -1.0) >= 0.0);
    ok(&api(&h, "cache_clear", "{}"));
    assert!(!api(&h, "pick_open", "{}").bool_or("ok", true), "no native dialog on this platform");
}

//! Media import: probe, thumbnail, preview proxy, waveform.

use crate::ff::{Ff, MediaInfo};
use crate::json::Json;
use crate::model::{MediaKind, US};
use crate::store::{fnv, Store};
use std::path::{Path, PathBuf};
use std::process::Stdio;

pub fn media_id(path: &str) -> String {
    let meta = std::fs::metadata(path).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("m{}", &fnv(&format!("{}|{}|{}", path, size, mtime))[..12])
}

const SAFE_VIDEO: [&str; 4] = ["h264", "vp8", "vp9", "av1"];
const SAFE_AUDIO: [&str; 7] = ["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_f32le"];

/// Whether the preview (a browser engine) can play this file directly and cheaply.
pub fn needs_proxy(info: &MediaInfo, path: &str, proxy_height: u32) -> bool {
    let ext = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let c = info.container.as_str();
    match info.kind {
        MediaKind::Image => matches!(ext.as_str(), "tif" | "tiff"),
        MediaKind::Audio => {
            let ok_codec = SAFE_AUDIO.contains(&info.acodec.as_str());
            let ok_cont = ["mp3", "wav", "mp4", "ogg", "flac", "webm", "matroska"].iter().any(|k| c.contains(k));
            !(ok_codec && ok_cont)
        }
        MediaKind::Video => {
            let ok_v = SAFE_VIDEO.contains(&info.vcodec.as_str());
            let ok_pix = info.pix_fmt == "yuv420p" || info.pix_fmt == "yuvj420p" || info.pix_fmt.is_empty();
            let ok_cont = c.contains("mp4") || c.contains("webm");
            let ok_a = !info.has_audio || SAFE_AUDIO.contains(&info.acodec.as_str());
            let small = info.h <= proxy_height.max(720);
            !(ok_v && ok_pix && ok_cont && ok_a && small && !info.rotated)
        }
    }
}

pub fn record(path: &str, info: &MediaInfo) -> Json {
    let name = Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path).to_string();
    let kind = match info.kind {
        MediaKind::Video => "video",
        MediaKind::Audio => "audio",
        MediaKind::Image => "image",
    };
    Json::obj(vec![
        ("id", Json::s(&media_id(path))),
        ("path", Json::s(path)),
        ("name", Json::s(&name)),
        ("kind", Json::s(kind)),
        ("dur", Json::n(info.dur as f64)),
        ("w", Json::n(info.w as f64)),
        ("h", Json::n(info.h as f64)),
        ("fps", Json::n(info.fps)),
        ("has_audio", Json::Bool(info.has_audio)),
    ])
}

pub fn thumb_path(store: &Store, id: &str) -> PathBuf {
    store.cache_dir("thumbs").join(format!("{}.jpg", id))
}

pub fn make_thumb(ff: &Ff, store: &Store, id: &str, path: &str, info: &MediaInfo) -> bool {
    if info.kind == MediaKind::Audio {
        return false;
    }
    let out = thumb_path(store, id);
    if out.exists() {
        return true;
    }
    let at = if info.kind == MediaKind::Video { (info.dur as f64 / US as f64 * 0.1).min(5.0) } else { 0.0 };
    let st = ff
        .ffmpeg()
        .args(["-y", "-ss", &format!("{:.3}", at), "-i", path, "-frames:v", "1", "-vf", "scale=-2:96", "-q:v", "6"])
        .arg(&out)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    matches!(st, Ok(s) if s.success()) && out.exists()
}

/// Where a proxy for this media lives, and the encoder args for it.
pub fn proxy_target(store: &Store, id: &str, info: &MediaInfo, encoder: &str, proxy_height: u32) -> (PathBuf, Vec<String>) {
    let dir = store.cache_dir("proxies");
    match info.kind {
        MediaKind::Audio => (dir.join(format!("{}.m4a", id)), vec!["-vn".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "128k".into()]),
        MediaKind::Image => (dir.join(format!("{}.png", id)), vec![]),
        MediaKind::Video => {
            let (ext, mut a): (&str, Vec<String>) = if encoder == "libvpx" {
                ("webm", vec!["-c:v".into(), "libvpx".into(), "-deadline".into(), "realtime".into(), "-cpu-used".into(), "8".into(), "-b:v".into(), "1500k".into(), "-g".into(), "15".into()])
            } else if encoder == "libx264" {
                ("mp4", vec!["-c:v".into(), "libx264".into(), "-preset".into(), "ultrafast".into(), "-crf".into(), "30".into(), "-g".into(), "15".into(), "-bf".into(), "0".into()])
            } else {
                ("mp4", vec!["-c:v".into(), encoder.to_string(), "-b:v".into(), "1800k".into(), "-g".into(), "15".into()])
            };
            let _ = proxy_height;
            a.extend(["-pix_fmt".into(), "yuv420p".into()]);
            if info.has_audio {
                if ext == "webm" {
                    a.extend(["-c:a".into(), "libopus".into(), "-b:a".into(), "96k".into()]);
                } else {
                    a.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "96k".into(), "-ac".into(), "2".into()]);
                }
            } else {
                a.push("-an".into());
            }
            if ext == "mp4" {
                a.extend(["-movflags".into(), "+faststart".into()]);
            }
            (dir.join(format!("{}.{}", id, ext)), a)
        }
    }
}

/// Builds the proxy. Blocking; run it on a worker thread.
pub fn make_proxy(ff: &Ff, store: &Store, id: &str, path: &str, info: &MediaInfo, encoder: &str, proxy_height: u32, cancel: &std::sync::atomic::AtomicBool) -> Result<PathBuf, String> {
    let (out, enc_args) = proxy_target(store, id, info, encoder, proxy_height);
    if out.exists() && std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(out);
    }
    let part = out.with_extension(format!("part.{}", out.extension().and_then(|e| e.to_str()).unwrap_or("mp4")));
    let mut cmd = ff.ffmpeg();
    cmd.arg("-y").arg("-i").arg(path);
    match info.kind {
        MediaKind::Video => {
            let ph = proxy_height.max(144) & !1;
            let mut vf = format!("scale=-2:'min({},ih)':flags=bilinear", ph);
            if info.fps > 30.5 {
                vf.push_str(",fps=30");
            }
            cmd.args(["-vf", &vf]);
        }
        MediaKind::Image => {
            cmd.args(["-frames:v", "1", "-vf", "scale='min(1920,iw)':-2"]);
        }
        MediaKind::Audio => {}
    }
    cmd.args(&enc_args).arg(&part);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("could not start FFmpeg: {}", e))?;
    // poll so a cancel can stop it
    loop {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&part);
            return Err("cancelled".into());
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() || !part.exists() {
        let _ = std::fs::remove_file(&part);
        let msg = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = msg.lines().rev().take(3).collect();
        return Err(format!("could not create the preview copy: {}", tail.join(" | ")));
    }
    std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Peak levels, 0..255, one per `bucket_ms`.
pub fn waveform(ff: &Ff, store: &Store, id: &str, path: &str) -> Result<Json, String> {
    let cache = store.cache_dir("waves").join(format!("{}.json", id));
    if let Ok(s) = std::fs::read_to_string(&cache) {
        if let Ok(j) = Json::parse(&s) {
            return Ok(j);
        }
    }
    let out = ff
        .ffmpeg()
        .args(["-i", path, "-vn", "-ac", "1", "-ar", "4000", "-f", "s16le", "-"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if out.stdout.len() < 2 {
        return Err("no audio".into());
    }
    let bucket = 200usize; // 50 ms at 4 kHz
    let mut peaks: Vec<Json> = Vec::new();
    for chunk in out.stdout.chunks(bucket * 2) {
        let mut m = 0i32;
        for s in chunk.chunks_exact(2) {
            let v = i16::from_le_bytes([s[0], s[1]]) as i32;
            m = m.max(v.abs());
        }
        // gentle curve so quiet parts stay visible
        let level = ((m as f64 / 32768.0).powf(0.6) * 255.0).round().min(255.0);
        peaks.push(Json::n(level));
    }
    let j = Json::obj(vec![("bucket_ms", Json::n(50.0)), ("peaks", Json::Arr(peaks))]);
    let _ = std::fs::write(&cache, j.to_string());
    Ok(j)
}

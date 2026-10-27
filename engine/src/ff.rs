//! FFmpeg process helpers. FFmpeg is a separate bundled executable (LGPL build),
//! never linked, which keeps this crate dependency-free.

use crate::json::Json;
use crate::model::{MediaKind, US};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

#[derive(Clone, Debug)]
pub struct Ff {
    dir: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct MediaInfo {
    pub kind: MediaKind,
    pub dur: i64,
    pub w: u32,
    pub h: u32,
    pub fps: f64,
    pub has_audio: bool,
}

static USABLE_ENCODERS: Mutex<Option<Vec<String>>> = Mutex::new(None);

const IMAGE_EXT: [&str; 7] = ["png", "jpg", "jpeg", "bmp", "webp", "tif", "tiff"];

impl Ff {
    /// Looks in LITE_FFMPEG_DIR first (set by the app to its bundled folder), then PATH.
    pub fn locate() -> Ff {
        let dir = std::env::var_os("LITE_FFMPEG_DIR").map(PathBuf::from).filter(|d| d.is_dir());
        Ff { dir }
    }

    pub fn with_dir(dir: &Path) -> Ff {
        Ff { dir: Some(dir.to_path_buf()) }
    }

    fn exe(&self, name: &str) -> PathBuf {
        let file = if cfg!(windows) { format!("{}.exe", name) } else { name.to_string() };
        match &self.dir {
            Some(d) => d.join(file),
            None => PathBuf::from(file),
        }
    }

    pub fn command(&self, name: &str) -> Command {
        let mut c = Command::new(self.exe(name));
        if let Some(d) = &self.dir {
            // Shared FFmpeg builds keep their DLLs next to the executables.
            let mut paths = vec![d.clone()];
            if let Some(p) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&p));
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                c.env("PATH", joined);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        c
    }

    pub fn ffmpeg(&self) -> Command {
        let mut c = self.command("ffmpeg");
        c.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
        c
    }

    pub fn version(&self) -> Option<String> {
        let out = self.command("ffmpeg").arg("-version").stdin(Stdio::null()).output().ok()?;
        String::from_utf8_lossy(&out.stdout).lines().next().map(|s| s.to_string())
    }

    pub fn available(&self) -> bool {
        self.version().is_some()
    }

    pub fn is_image_path(path: &str) -> bool {
        Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| IMAGE_EXT.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false)
    }

    pub fn probe(&self, path: &str) -> Result<MediaInfo, String> {
        let out = self
            .command("ffprobe")
            .args([
                "-v", "error",
                "-show_entries",
                "stream=codec_type,width,height,r_frame_rate,avg_frame_rate,duration:stream_tags=rotate:stream_side_data=rotation:format=duration",
                "-of", "json",
            ])
            .arg(path)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("could not run ffprobe: {}", e))?;
        if !out.status.success() {
            return Err("this file could not be read as media".into());
        }
        let j = Json::parse(&String::from_utf8_lossy(&out.stdout))?;
        let mut has_audio = false;
        let (mut w, mut h, mut fps, mut sdur) = (0u32, 0u32, 0.0f64, 0.0f64);
        let mut has_video = false;
        for s in j.get("streams").map(|s| s.as_arr()).unwrap_or(&[]) {
            match s.str_or("codec_type", "").as_str() {
                "audio" => has_audio = true,
                "video" if !has_video => {
                    has_video = true;
                    w = s.i64_or("width", 0).max(0) as u32;
                    h = s.i64_or("height", 0).max(0) as u32;
                    fps = parse_rate(&s.str_or("avg_frame_rate", "0/0"))
                        .or_else(|| parse_rate(&s.str_or("r_frame_rate", "0/0")))
                        .unwrap_or(30.0);
                    sdur = s.str_or("duration", "0").parse().unwrap_or(0.0);
                    let mut rot = s.get("tags").map(|t| t.str_or("rotate", "0")).unwrap_or_default().parse::<f64>().unwrap_or(0.0);
                    for sd in s.get("side_data_list").map(|x| x.as_arr()).unwrap_or(&[]) {
                        rot = sd.f64_or("rotation", rot);
                    }
                    if (rot.abs() as i64 / 90) % 2 == 1 {
                        std::mem::swap(&mut w, &mut h);
                    }
                }
                _ => {}
            }
        }
        let fdur: f64 = j.get("format").map(|f| f.str_or("duration", "0")).unwrap_or_default().parse().unwrap_or(0.0);
        let secs = if fdur > 0.0 { fdur } else { sdur };
        if !has_video && !has_audio {
            return Err("no audio or video found in this file".into());
        }
        if has_video && Self::is_image_path(path) {
            return Ok(MediaInfo { kind: MediaKind::Image, dur: 5 * US, w, h, fps: 30.0, has_audio: false });
        }
        if !has_video {
            return Ok(MediaInfo { kind: MediaKind::Audio, dur: (secs * US as f64) as i64, w: 0, h: 0, fps: 0.0, has_audio: true });
        }
        Ok(MediaInfo { kind: MediaKind::Video, dur: (secs * US as f64) as i64, w, h, fps, has_audio })
    }

    pub fn encoder_names(&self) -> Vec<String> {
        let out = match self.command("ffmpeg").args(["-hide_banner", "-encoders"]).stdin(Stdio::null()).output() {
            Ok(o) => o,
            Err(_) => return vec![],
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let mut it = l.split_whitespace();
                let flags = it.next()?;
                let name = it.next()?;
                if flags.starts_with('V') { Some(name.to_string()) } else { None }
            })
            .collect()
    }

    /// H.264 encoders that actually start on this machine, best first.
    /// Hardware encoders are listed by FFmpeg even without the hardware, so each is test-run once.
    pub fn usable_h264_encoders(&self) -> Vec<String> {
        if let Some(v) = USABLE_ENCODERS.lock().unwrap().as_ref() {
            return v.clone();
        }
        let have = self.encoder_names();
        let order = ["libx264", "h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libopenh264", "mpeg4"];
        let mut ok = Vec::new();
        for name in order {
            if !have.iter().any(|h| h == name) {
                continue;
            }
            let status = self
                .ffmpeg()
                .args(["-f", "lavfi", "-i", "color=c=black:s=320x240:r=10:d=0.3", "-pix_fmt", "yuv420p", "-c:v", name, "-f", "null", "-"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if matches!(status, Ok(s) if s.success()) {
                ok.push(name.to_string());
            }
        }
        *USABLE_ENCODERS.lock().unwrap() = Some(ok.clone());
        ok
    }
}

fn parse_rate(s: &str) -> Option<f64> {
    let (a, b) = s.split_once('/')?;
    let (a, b): (f64, f64) = (a.parse().ok()?, b.parse().ok()?);
    if b > 0.0 && a > 0.0 { Some(a / b) } else { None }
}

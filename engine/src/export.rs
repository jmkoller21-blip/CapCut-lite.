//! Export: turns a Project into one FFmpeg filter graph and runs it.
//!
//! Compositing model (must match the UI preview):
//!   * a black canvas of the export size
//!   * video tracks bottom to top; each clip is fitted inside the canvas ("contain"),
//!     multiplied by its scale, mirrored, colour-adjusted, rotated, faded, then overlaid
//!     centred at (x, y) offset from the canvas centre. x, y are in project pixels.
//!   * a clip with a transition-in animates over its first `dur`, on top of the previous clip's
//!     last frame (held), so the transition needs no overlap on the timeline.
//!   * text tracks are drawn last with drawtext.
//!   * audio: every clip with sound is trimmed, speed-changed, faded, delayed and mixed.

use crate::ff::Ff;
use crate::model::*;
use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct Settings {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub quality: String, // low | medium | high
    pub encoder: String, // auto or a specific encoder name
    pub audio_only: bool,
    pub font_regular: String, // font files for drawtext
    pub font_bold: String,
    pub work_dir: PathBuf,
}

pub struct Plan {
    pub input_args: Vec<String>,
    pub script: String,
    pub out_args: Vec<String>,
    pub total_us: i64,
    pub files: Vec<PathBuf>, // temp files to delete afterwards
}

static UNIQUE: AtomicU64 = AtomicU64::new(1);

/// A name that no other export in this process (or another instance) will pick.
pub fn unique() -> String {
    format!("{}_{}", std::process::id(), UNIQUE.fetch_add(1, Ordering::Relaxed))
}

fn secs(us: i64) -> String {
    format!("{:.6}", us as f64 / 1_000_000.0)
}

/// Escape a file path for use inside a filter option value (wrapped in single quotes).
fn esc_path(p: &str) -> String {
    p.replace('\\', "/").replace(':', "\\:").replace('\'', "\\'")
}

pub fn tempo_chain(speed: f64) -> String {
    let mut s = speed;
    let mut parts = Vec::new();
    while s < 0.5 {
        parts.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    while s > 2.0 {
        parts.push("atempo=2.0".to_string());
        s /= 2.0;
    }
    parts.push(format!("atempo={:.6}", s));
    parts.join(",")
}

fn color_hex(c: &str) -> String {
    let h = c.trim().trim_start_matches('#');
    if h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        format!("0x{}", h)
    } else {
        "white".to_string()
    }
}

/// A clip cut down to the export window [t0, t1).
#[derive(Clone)]
struct Win<'a> {
    start: i64, // relative to window start
    dur: i64,
    src_in: i64,
    tail: i64,        // held-frame extension (video only)
    trans: Option<&'a Transition>,
}

fn window<'a>(c: &'a Clip, tail: i64, t0: i64, t1: i64) -> Option<Win<'a>> {
    let vis_end = c.end() + tail;
    let s = c.start.max(t0);
    let e = vis_end.min(t1);
    if e <= s {
        return None;
    }
    let skip = (s - c.start).max(0);
    let content_end = c.end().min(t1);
    let dur = (content_end - s).max(0);
    let tail_left = (e - content_end.max(s)).max(0);
    Some(Win {
        start: s - t0,
        dur,
        src_in: c.src_in + (skip as f64 * c.speed) as i64,
        tail: tail_left,
        trans: if skip == 0 { c.transition_in.as_ref() } else { None },
    })
}

pub fn plan(p: &Project, s: &Settings, t0: i64, t1: i64) -> Result<Plan, String> {
    let (w, h) = (s.width.max(16) & !1, s.height.max(16) & !1);
    let total = (t1 - t0).max(0);
    if total <= 0 {
        return Err("the timeline is empty".into());
    }
    let k = w as f64 / p.width as f64; // project px -> export px
    let fps = s.fps;
    let mut inputs: Vec<String> = Vec::new();
    let mut n_inputs = 0usize;
    let mut g = String::new();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut audio_labels: Vec<String> = Vec::new();

    // Missing files are reported up front, all at once.
    let mut missing = Vec::new();
    for t in &p.tracks {
        for c in &t.clips {
            if let Some(m) = c.media_id.as_ref().and_then(|id| p.media.get(id)) {
                if !Path::new(&m.path).exists() && !missing.contains(&m.path) {
                    missing.push(m.path.clone());
                }
            }
        }
    }
    if !missing.is_empty() {
        return Err(format!("these files are missing: {}", missing.join(", ")));
    }

    let mut cur = "base".to_string();
    if !s.audio_only {
        let _ = write!(g, "color=c=black:s={}x{}:r={:.4}:d={}[base];\n", w, h, fps, secs(total));
    }
    let mut stage = 0usize;

    for track in &p.tracks {
        match track.kind {
            TrackKind::Video => {
                for (ci, c) in track.clips.iter().enumerate() {
                    let m = match c.media_id.as_ref().and_then(|id| p.media.get(id)) {
                        Some(m) => m,
                        None => continue,
                    };
                    // held-frame tail when the next adjacent clip has a transition-in
                    let tail = match track.clips.get(ci + 1) {
                        Some(n) if (n.start - c.end()).abs() < 2000 => {
                            n.transition_in.as_ref().map(|t| t.dur.min(n.dur)).unwrap_or(0)
                        }
                        _ => 0,
                    };
                    let tail = if m.kind == MediaKind::Audio { 0 } else { tail };
                    let wn = match window(c, tail, t0, t1) {
                        Some(x) => x,
                        None => continue,
                    };
                    let idx = n_inputs;

                    // ---- input
                    let src_len = (wn.dur as f64 * c.speed) as i64;
                    match m.kind {
                        MediaKind::Image => {
                            if s.audio_only {
                                continue;
                            }
                            inputs.extend([
                                "-loop".into(), "1".into(), "-framerate".into(), format!("{:.4}", fps),
                                "-t".into(), secs(wn.dur + wn.tail), "-i".into(), m.path.clone(),
                            ]);
                        }
                        _ => {
                            inputs.extend([
                                "-ss".into(), secs(wn.src_in), "-t".into(), secs(src_len + 100_000),
                                "-i".into(), m.path.clone(),
                            ]);
                        }
                    }
                    n_inputs += 1;

                    // ---- video chain
                    if m.kind != MediaKind::Audio && !s.audio_only && !track.hidden {
                        let mut f = String::new();
                        let _ = write!(f, "[{}:v]setpts=(PTS-STARTPTS)/{:.6},fps={:.4},", idx, c.speed, fps);
                        let _ = write!(f, "scale={}:{}:force_original_aspect_ratio=decrease:flags=bilinear,", w, h);
                        // zoom-in transition scales per frame; otherwise the static user scale
                        let user_scale = c.scale;
                        let zoom = wn.trans.filter(|t| t.kind == "zoom");
                        if let Some(t) = zoom {
                            let d = t.dur.min(c.dur) as f64 / 1e6;
                            let _ = write!(
                                f,
                                "scale=w='max(2,trunc(iw*{:.5}*(0.5+0.5*min(1,t/{:.4}))/2)*2)':h='max(2,trunc(ih*{:.5}*(0.5+0.5*min(1,t/{:.4}))/2)*2)':eval=frame,",
                                user_scale, d, user_scale, d
                            );
                        } else if (user_scale - 1.0).abs() > 0.0005 {
                            let _ = write!(
                                f,
                                "scale=w='max(2,trunc(iw*{:.5}/2)*2)':h='max(2,trunc(ih*{:.5}/2)*2)',",
                                user_scale, user_scale
                            );
                        }
                        if c.mirror {
                            f.push_str("hflip,");
                        }
                        let a = &c.adj;
                        if !a.is_identity() {
                            if (a.brightness).abs() > 0.001 || (a.contrast - 1.0).abs() > 0.001 || (a.saturation - 1.0).abs() > 0.001 {
                                let _ = write!(f, "eq=brightness={:.4}:contrast={:.4}:saturation={:.4},", a.brightness, a.contrast, a.saturation);
                            }
                            if a.hue.abs() > 0.01 {
                                let _ = write!(f, "hue=h={:.3},", a.hue);
                            }
                            if a.warmth.abs() > 0.001 {
                                let wv = a.warmth * 0.18;
                                let _ = write!(f, "format=gbrp,colorbalance=rs={:.4}:gs={:.4}:bs={:.4}:rm={:.4}:bm={:.4},", wv, wv * 0.25, -wv, wv * 0.6, -wv * 0.6);
                            }
                            if a.blur >= 0.5 {
                                let r = (a.blur * k).clamp(1.0, 40.0);
                                let _ = write!(f, "boxblur=luma_radius={:.1}:luma_power=2:chroma_radius={:.1}:chroma_power=2,", r, (r / 2.0).max(1.0));
                            }
                        }
                        f.push_str("format=rgba,");
                        if c.opacity < 0.999 {
                            let _ = write!(f, "colorchannelmixer=aa={:.4},", c.opacity);
                        }
                        if c.rot.abs() > 0.01 {
                            let rad = c.rot.to_radians();
                            let _ = write!(f, "rotate=a={:.6}:ow='rotw({:.6})':oh='roth({:.6})':c=black@0,", rad, rad, rad);
                        }
                        if let Some(t) = wn.trans {
                            let d = t.dur.min(c.dur) as f64 / 1e6;
                            if t.kind == "dissolve" || t.kind == "zoom" {
                                let _ = write!(f, "fade=t=in:st=0:d={:.4}:alpha=1,", d);
                            }
                        }
                        if wn.tail > 0 {
                            let _ = write!(f, "tpad=stop_mode=clone:stop_duration={},", secs(wn.tail));
                        }
                        let _ = write!(f, "setpts=PTS+{}/TB[v{}];\n", secs(wn.start), idx);
                        g.push_str(&f);

                        // overlay position
                        let cx = c.x * k;
                        let cy = c.y * k;
                        let (mut xe, mut ye) = (format!("(W-w)/2+({:.3})", cx), format!("(H-h)/2+({:.3})", cy));
                        if let Some(t) = wn.trans {
                            let d = t.dur.min(c.dur) as f64 / 1e6;
                            let prog = format!("(1-min(1,max(0,(t-{:.6})/{:.4})))", wn.start as f64 / 1e6, d);
                            match t.kind.as_str() {
                                "slide-left" => xe = format!("{}+W*{}", xe, prog),
                                "slide-right" => xe = format!("{}-W*{}", xe, prog),
                                "slide-up" => ye = format!("{}+H*{}", ye, prog),
                                _ => {}
                            }
                        }
                        stage += 1;
                        let _ = write!(
                            g,
                            "[{}][v{}]overlay=x='{}':y='{}':eof_action=pass:repeatlast=0[s{}];\n",
                            cur, idx, xe, ye, stage
                        );
                        cur = format!("s{}", stage);
                    }

                    // ---- audio chain
                    if m.has_audio && !track.muted && m.kind != MediaKind::Image && wn.dur > 0 {
                        audio_chain(&mut g, idx, c, &wn, &mut audio_labels);
                    }
                }
            }
            TrackKind::Audio => {
                for c in &track.clips {
                    let m = match c.media_id.as_ref().and_then(|id| p.media.get(id)) {
                        Some(m) if m.has_audio => m,
                        _ => continue,
                    };
                    let wn = match window(c, 0, t0, t1) {
                        Some(x) => x,
                        None => continue,
                    };
                    if track.muted {
                        continue;
                    }
                    let idx = n_inputs;
                    let src_len = (wn.dur as f64 * c.speed) as i64;
                    inputs.extend(["-ss".into(), secs(wn.src_in), "-t".into(), secs(src_len + 100_000), "-i".into(), m.path.clone()]);
                    n_inputs += 1;
                    audio_chain(&mut g, idx, c, &wn, &mut audio_labels);
                }
            }
            TrackKind::Text => {
                if s.audio_only || track.hidden {
                    continue;
                }
                for c in &track.clips {
                    let t = match &c.text {
                        Some(t) if !t.content.trim().is_empty() => t,
                        _ => continue,
                    };
                    let wn = match window(c, 0, t0, t1) {
                        Some(x) => x,
                        None => continue,
                    };
                    stage += 1;
                    let tf = s.work_dir.join(format!("text_{}_{}.txt", unique(), stage));
                    std::fs::write(&tf, t.content.replace("\r\n", "\n")).map_err(|e| format!("could not write a temp file: {}", e))?;
                    files.push(tf.clone());
                    let font = if t.bold { &s.font_bold } else { &s.font_regular };
                    let size = (t.size * h as f64).max(8.0);
                    let mut d = format!(
                        "drawtext=fontfile='{}':textfile='{}':fontsize={:.1}:fontcolor={}:x='(w-text_w)/2+({:.3})':y='(h-text_h)/2+({:.3})':text_align=center",
                        esc_path(font), esc_path(&tf.to_string_lossy()), size, color_hex(&t.color), c.x * k, c.y * k
                    );
                    if t.outline {
                        let _ = write!(d, ":borderw={:.1}:bordercolor=black", (size / 16.0).max(1.0));
                    }
                    if t.shadow {
                        let _ = write!(d, ":shadowx={:.1}:shadowy={:.1}:shadowcolor=black@0.7", (size / 18.0).max(1.0), (size / 18.0).max(1.0));
                    }
                    if t.boxed {
                        let _ = write!(d, ":box=1:boxcolor=black@0.55:boxborderw={:.1}", (size / 4.0).max(2.0));
                    }
                    let _ = write!(d, ":enable='between(t,{},{})'", secs(wn.start), secs(wn.start + wn.dur));
                    let _ = write!(g, "[{}]{}[s{}];\n", cur, d, stage);
                    cur = format!("s{}", stage);
                }
            }
        }
    }

    // ---- final video label
    let mut out_args: Vec<String> = Vec::new();
    if !s.audio_only {
        let _ = write!(g, "[{}]format=yuv420p[vout];\n", cur);
    }
    // ---- mix audio (always present so players get a track)
    let _ = write!(g, "anullsrc=r=48000:cl=stereo,atrim=0:{}[asil];\n", secs(total));
    let mut labels = vec!["[asil]".to_string()];
    labels.extend(audio_labels.iter().cloned());
    let _ = write!(
        g,
        "{}amix=inputs={}:duration=longest:normalize=0:dropout_transition=0,alimiter=limit=0.95,atrim=0:{}[aout]",
        labels.join(""),
        labels.len(),
        secs(total)
    );

    if !s.audio_only {
        out_args.extend(["-map".into(), "[vout]".into()]);
    }
    out_args.extend(["-map".into(), "[aout]".into()]);

    let ext = Path::new(&s.path).extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_ascii_lowercase();
    if s.audio_only {
        match ext.as_str() {
            "wav" => out_args.extend(["-c:a".into(), "pcm_s16le".into()]),
            "mp3" => out_args.extend(["-c:a".into(), "libmp3lame".into(), "-b:a".into(), "192k".into()]),
            _ => out_args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]),
        }
    } else {
        out_args.extend(encoder_args(&s.encoder, &s.quality, w, h, fps));
        out_args.extend(["-r".into(), format!("{:.4}", fps), "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
        if ext == "mp4" || ext == "mov" || ext == "m4v" {
            out_args.extend(["-movflags".into(), "+faststart".into()]);
        }
    }
    out_args.extend(["-ar".into(), "48000".into(), "-t".into(), secs(total)]);

    Ok(Plan { input_args: inputs, script: g, out_args, total_us: total, files })
}

fn audio_chain(g: &mut String, idx: usize, c: &Clip, wn: &Win, labels: &mut Vec<String>) {
    let dur_s = wn.dur as f64 / 1e6;
    let mut f = format!("[{}:a]asetpts=PTS-STARTPTS,{},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,", idx, tempo_chain(c.speed));
    if (c.volume - 1.0).abs() > 0.001 {
        let _ = write!(f, "volume={:.4},", c.volume);
    }
    let fi = (c.fade_in as f64 / 1e6).min(dur_s);
    let fo = (c.fade_out as f64 / 1e6).min(dur_s);
    if fi > 0.01 {
        let _ = write!(f, "afade=t=in:st=0:d={:.4},", fi);
    }
    if fo > 0.01 {
        let _ = write!(f, "afade=t=out:st={:.4}:d={:.4},", (dur_s - fo).max(0.0), fo);
    }
    let delay_ms = (wn.start / 1000).max(0);
    let _ = write!(f, "atrim=0:{:.6},adelay={}|{}[a{}];\n", dur_s, delay_ms, delay_ms, idx);
    g.push_str(&f);
    labels.push(format!("[a{}]", idx));
}

pub fn encoder_args(encoder: &str, quality: &str, w: u32, h: u32, fps: f64) -> Vec<String> {
    let bpp = match quality {
        "low" => 0.06,
        "high" => 0.16,
        _ => 0.10,
    };
    let bitrate = ((w as f64 * h as f64 * fps.max(1.0) * bpp) as u64).clamp(500_000, 120_000_000);
    let kb = format!("{}k", bitrate / 1000);
    let crf = match quality {
        "low" => "28",
        "high" => "18",
        _ => "23",
    };
    let mut a: Vec<String> = vec!["-c:v".into(), encoder.to_string()];
    match encoder {
        "libx264" => a.extend(["-preset".into(), "veryfast".into(), "-crf".into(), crf.into()]),
        "h264_nvenc" => a.extend(["-preset".into(), "p4".into(), "-b:v".into(), kb]),
        "h264_qsv" | "h264_amf" | "h264_mf" | "libopenh264" => a.extend(["-b:v".into(), kb]),
        "mpeg4" => a.extend(["-q:v".into(), (if quality == "high" { "2" } else if quality == "low" { "6" } else { "4" }).into()]),
        _ => a.extend(["-b:v".into(), kb]),
    }
    a.extend(["-pix_fmt".into(), "yuv420p".into()]);
    a
}

pub struct Progress {
    pub pct: Mutex<f64>,
    pub cancel: AtomicBool,
}

impl Progress {
    pub fn new() -> Arc<Progress> {
        Arc::new(Progress { pct: Mutex::new(0.0), cancel: AtomicBool::new(false) })
    }
}

pub fn pick_encoder(ff: &Ff, wanted: &str) -> Result<String, String> {
    let usable = ff.usable_h264_encoders();
    if wanted != "auto" && !wanted.is_empty() && usable.iter().any(|e| e == wanted) {
        return Ok(wanted.to_string());
    }
    // best first, but skip mpeg4 unless nothing else works
    usable
        .iter()
        .find(|e| *e != "mpeg4" && *e != "libvpx")
        .or_else(|| usable.iter().find(|e| *e == "mpeg4"))
        .cloned()
        .ok_or_else(|| "no video encoder is available in the bundled FFmpeg".to_string())
}

/// Runs the plan. Blocks until finished, cancelled or failed.
pub fn run(ff: &Ff, plan: &Plan, out_path: &str, work_dir: &Path, prog: &Progress) -> Result<(), String> {
    std::fs::create_dir_all(work_dir).ok();
    let script_path = work_dir.join(format!("graph_{}.txt", unique()));
    std::fs::write(&script_path, &plan.script).map_err(|e| format!("could not write a temp file: {}", e))?;
    let tmp_out = format!("{}.part", out_path);
    let ext = Path::new(out_path).extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_string();

    let mut cmd = ff.ffmpeg();
    cmd.args(["-y", "-progress", "pipe:1", "-nostats"]);
    cmd.args(&plan.input_args);
    cmd.arg("-filter_complex_script").arg(&script_path);
    cmd.args(&plan.out_args);
    // keep the partial file's extension so ffmpeg picks the right muxer
    let fmt = match ext.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => "mp4",
        "mov" => "mov",
        "m4a" => "ipod",
        "mp3" => "mp3",
        "wav" => "wav",
        _ => "mp4",
    };
    cmd.args(["-f", fmt]).arg(&tmp_out);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("could not start FFmpeg: {}", e))?;

    let err_buf = Arc::new(Mutex::new(String::new()));
    let mut stderr = child.stderr.take().unwrap();
    let eb = err_buf.clone();
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut chunk) {
            if n == 0 {
                break;
            }
            s.push_str(&String::from_utf8_lossy(&chunk[..n]));
            if s.len() > 12_000 {
                let cut = s.len() - 8_000;
                s = s[cut..].to_string();
            }
        }
        *eb.lock().unwrap() = s;
    });

    let stdout = child.stdout.take().unwrap();
    // cancellation is checked each time FFmpeg reports progress (about twice a second)
    let total = plan.total_us.max(1) as f64;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut killed = false;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if let Some(v) = line.trim().strip_prefix("out_time_us=").or_else(|| line.trim().strip_prefix("out_time_ms=")) {
            if let Ok(us) = v.parse::<i64>() {
                *prog.pct.lock().unwrap() = (us as f64 / total * 100.0).clamp(0.0, 99.0);
            }
        }
        if prog.cancel.load(Ordering::Relaxed) && !killed {
            let _ = child.kill();
            killed = true;
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = err_thread.join();
    let _ = std::fs::remove_file(&script_path);
    for f in &plan.files {
        let _ = std::fs::remove_file(f);
    }
    if killed || prog.cancel.load(Ordering::Relaxed) {
        let _ = std::fs::remove_file(&tmp_out);
        return Err("cancelled".into());
    }
    if !status.success() {
        let _ = std::fs::remove_file(&tmp_out);
        let log = err_buf.lock().unwrap().clone();
        let tail: Vec<&str> = log.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("export failed: {}", tail.join(" | ")));
    }
    std::fs::rename(&tmp_out, out_path).map_err(|e| format!("could not save the file: {}", e))?;
    *prog.pct.lock().unwrap() = 100.0;
    Ok(())
}

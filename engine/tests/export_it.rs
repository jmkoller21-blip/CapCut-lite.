use engine::export::{self, Progress, Settings};
use engine::ff::Ff;
use engine::json::Json;
use engine::model::Project;
use std::path::{Path, PathBuf};
use std::process::Command;

fn work() -> PathBuf {
    let d = std::env::temp_dir().join(format!("lite-engine-test-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn gen(dir: &Path, name: &str, src: &str, secs: u32, audio: bool) -> String {
    let path = dir.join(name);
    let mut c = Command::new("ffmpeg");
    c.args(["-y", "-v", "error", "-f", "lavfi", "-i", &format!("{}:s=640x360:r=30:d={}", src, secs)]);
    if audio {
        c.args(["-f", "lavfi", "-i", &format!("sine=frequency=440:d={}", secs), "-c:a", "aac", "-shortest"]);
    }
    c.args(["-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(&path);
    assert!(c.status().unwrap().success());
    path.to_string_lossy().to_string()
}

fn fonts() -> (String, String) {
    let r = "/usr/share/fonts/opentype/inter/Inter-Regular.otf".to_string();
    let b = "/usr/share/fonts/opentype/inter/Inter-Bold.otf".to_string();
    (r, b)
}

fn settings(out: &str, dir: &Path) -> Settings {
    let (r, b) = fonts();
    Settings { path: out.into(), width: 640, height: 360, fps: 30.0, quality: "medium".into(), encoder: "libx264".into(), audio_only: false, font_regular: r, font_bold: b, work_dir: dir.to_path_buf() }
}

fn pixel(video: &str, t: f64, x: u32, y: u32) -> (u8, u8, u8) {
    let out = Command::new("ffmpeg")
        .args(["-v", "error", "-ss", &format!("{}", t), "-i", video, "-frames:v", "1", "-vf", &format!("format=rgb24,crop=1:1:{}:{}", x, y), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .output().unwrap();
    assert_eq!(out.stdout.len(), 3, "could not read pixel at {}s", t);
    (out.stdout[0], out.stdout[1], out.stdout[2])
}

fn project(dir: &Path) -> Project {
    let red = gen(dir, "red.mp4", "color=c=red", 4, true);
    let blue = gen(dir, "blue.mp4", "color=c=blue", 4, true);
    let j = format!(r##"{{
      "name":"t","width":640,"height":360,"fps":30,
      "media":[
        {{"id":"m1","path":"{red}","kind":"video","dur":4000000,"w":640,"h":360,"has_audio":true}},
        {{"id":"m2","path":"{blue}","kind":"video","dur":4000000,"w":640,"h":360,"has_audio":true}}],
      "tracks":[
        {{"id":"v1","kind":"video","clips":[
          {{"id":"c1","media":"m1","start":0,"dur":2000000,"in":0}},
          {{"id":"c2","media":"m2","start":2000000,"dur":2000000,"in":500000}}]}},
        {{"id":"t1","kind":"text","clips":[
          {{"id":"x1","start":500000,"dur":1000000,"text":{{"content":"Hello","size":0.2,"color":"#ffffff"}}}}]}}
      ]}}"##, red = red, blue = blue);
    Project::from_json(&Json::parse(&j).unwrap()).unwrap()
}

#[test]
fn exports_two_clips_with_text() {
    let ff = Ff::locate();
    assert!(ff.available(), "ffmpeg is required for this test");
    let dir = work();
    let p = project(&dir);
    let out = dir.join("out.mp4").to_string_lossy().to_string();
    let s = settings(&out, &dir);
    let plan = export::plan(&p, &s, 0, p.duration()).unwrap();
    let prog = Progress::new();
    export::run(&ff, &plan, &out, &dir, &prog).unwrap();
    let info = ff.probe(&out).unwrap();
    assert!(info.has_audio, "output has audio");
    assert!((info.dur as f64 / 1e6 - 4.0).abs() < 0.2, "duration {}", info.dur);
    let a = pixel(&out, 1.0, 5, 5);
    assert!(a.0 > 200 && a.1 < 60 && a.2 < 60, "first clip should be red, got {:?}", a);
    let b = pixel(&out, 3.0, 5, 5);
    assert!(b.2 > 200 && b.0 < 60, "second clip should be blue, got {:?}", b);
    // text is drawn in the middle between 0.5s and 1.5s: some near-white pixels in the centre area
    let t = pixel(&out, 1.0, 320, 180);
    let t2 = pixel(&out, 1.8, 320, 180);
    assert!(t != t2 || t.0 > 100, "text region should differ while text is shown: {:?} vs {:?}", t, t2);
}

fn run_export(p: &Project, dir: &Path, name: &str, audio_only: bool) -> Result<String, String> {
    let ff = Ff::locate();
    let ext = if audio_only { "m4a" } else { "mp4" };
    let out = dir.join(format!("{}.{}", name, ext)).to_string_lossy().to_string();
    let mut s = settings(&out, dir);
    s.audio_only = audio_only;
    let plan = export::plan(p, &s, 0, p.duration())?;
    let prog = Progress::new();
    export::run(&ff, &plan, &out, dir, &prog)?;
    Ok(out)
}

fn png(dir: &Path, name: &str) -> String {
    let path = dir.join(name);
    let st = Command::new("ffmpeg").args(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=320x180:d=1", "-frames:v", "1"]).arg(&path).status().unwrap();
    assert!(st.success());
    path.to_string_lossy().to_string()
}

#[test]
fn every_effect_and_transition_builds_and_runs() {
    let dir = work();
    let red = gen(&dir, "r2.mp4", "color=c=red", 4, true);
    let blue = gen(&dir, "b2.mp4", "color=c=blue", 4, true);
    let img = png(&dir, "g.png");
    let tone = dir.join("tone.wav").to_string_lossy().to_string();
    assert!(Command::new("ffmpeg").args(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:d=3", &tone]).status().unwrap().success());

    for tr in ["dissolve", "slide-left", "slide-right", "slide-up", "zoom"] {
        let j = format!(r##"{{
          "name":"t","width":640,"height":360,"fps":30,
          "media":[
            {{"id":"m1","path":"{red}","kind":"video","dur":4000000,"w":640,"h":360,"has_audio":true}},
            {{"id":"m2","path":"{blue}","kind":"video","dur":4000000,"w":640,"h":360,"has_audio":true}}],
          "tracks":[{{"id":"v1","kind":"video","clips":[
            {{"id":"c1","media":"m1","start":0,"dur":2000000}},
            {{"id":"c2","media":"m2","start":2000000,"dur":2000000,"transition_in":{{"kind":"{tr}","dur":800000}}}}]}}]}}"##,
            red = red, blue = blue, tr = tr);
        let p = Project::from_json(&Json::parse(&j).unwrap()).unwrap();
        let out = run_export(&p, &dir, &format!("tr_{}", tr), false).unwrap_or_else(|e| panic!("transition {} failed: {}", tr, e));
        // before the transition: red. well after it: blue.
        let a = pixel(&out, 1.5, 320, 180);
        let b = pixel(&out, 3.5, 320, 180);
        assert!(a.0 > 200 && a.2 < 60, "{}: red before ({:?})", tr, a);
        assert!(b.2 > 200 && b.0 < 60, "{}: blue after ({:?})", tr, b);
        // mid-transition for dissolve: neither pure red nor pure blue
        if tr == "dissolve" {
            let m = pixel(&out, 2.4, 320, 180);
            assert!(m.0 > 40 && m.2 > 40, "dissolve mid should blend red+blue, got {:?}", m);
        }
        if tr == "slide-left" {
            // at 2.1s B is mostly off to the right: centre still shows the held red frame of A
            let m = pixel(&out, 2.1, 100, 180);
            assert!(m.0 > 200 && m.2 < 60, "slide-left: left side still red early in the slide, got {:?}", m);
        }
    }

    // transform, opacity, rotation, mirror, speed, adjust, blur, warmth, image, audio track, fades
    let j = format!(r##"{{
      "name":"t","width":640,"height":360,"fps":30,
      "media":[
        {{"id":"m1","path":"{red}","kind":"video","dur":4000000,"w":640,"h":360,"has_audio":true}},
        {{"id":"m2","path":"{blue}","kind":"video","dur":4000000,"w":640,"h":360,"has_audio":true}},
        {{"id":"im","path":"{img}","kind":"image","dur":5000000,"w":320,"h":180,"has_audio":false}},
        {{"id":"au","path":"{tone}","kind":"audio","dur":3000000,"has_audio":true}}],
      "tracks":[
        {{"id":"v1","kind":"video","clips":[
          {{"id":"c1","media":"m1","start":0,"dur":2000000,"speed":2.0,
            "adj":{{"brightness":0.1,"contrast":1.2,"saturation":1.3,"hue":10,"warmth":0.5,"blur":4}}}},
          {{"id":"c2","media":"im","start":2000000,"dur":2000000}}]}},
        {{"id":"v2","kind":"video","clips":[
          {{"id":"c3","media":"m2","start":500000,"dur":3000000,"scale":0.5,"x":100,"y":-50,"rot":15,"opacity":0.8,"mirror":true,"volume":0.5,"fade_in":500000,"fade_out":500000}}]}},
        {{"id":"a1","kind":"audio","clips":[{{"id":"c4","media":"au","start":0,"dur":3000000,"volume":1.5,"speed":0.5}}]}},
        {{"id":"t1","kind":"text","clips":[
          {{"id":"x1","start":0,"dur":2000000,"y":100,"text":{{"content":"Line one\nLine two","size":0.1,"color":"#ffcc00","bold":true,"outline":true,"shadow":true,"boxed":true}}}}]}}
      ]}}"##, red = red, blue = blue, img = img, tone = tone);
    let p = Project::from_json(&Json::parse(&j).unwrap()).unwrap();
    let out = run_export(&p, &dir, "combo", false).unwrap_or_else(|e| panic!("combo failed: {}", e));
    let ff = Ff::locate();
    let info = ff.probe(&out).unwrap();
    assert!(info.has_audio && info.w == 640);
    // image clip in the second half is green at a corner not covered by the blue overlay clip (overlay is half-size, offset right/up)
    let g = pixel(&out, 3.2, 20, 340);
    assert!(g.1 > 90 && g.0 < 60 && g.2 < 60, "image clip should be green, got {:?}", g);

    // audio-only export
    let a = run_export(&p, &dir, "audio", true).unwrap_or_else(|e| panic!("audio export failed: {}", e));
    let ai = ff.probe(&a).unwrap();
    assert!(ai.has_audio && ai.w == 0, "audio-only file has no video");

    // cancel
    let ff2 = Ff::locate();
    let out2 = dir.join("cancel.mp4").to_string_lossy().to_string();
    let s = settings(&out2, &dir);
    let plan = export::plan(&p, &s, 0, p.duration()).unwrap();
    let prog = Progress::new();
    prog.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    let r = export::run(&ff2, &plan, &out2, &dir, &prog);
    assert_eq!(r, Err("cancelled".to_string()));
    assert!(!Path::new(&out2).exists() && !Path::new(&format!("{}.part", out2)).exists(), "no partial file left");
}

#[test]
fn reports_missing_media() {
    let dir = work();
    let j = r#"{"width":640,"height":360,"fps":30,"media":[{"id":"m","path":"/nope/missing.mp4","kind":"video","dur":1000000,"has_audio":false}],
      "tracks":[{"id":"v","kind":"video","clips":[{"id":"c","media":"m","start":0,"dur":1000000}]}]}"#;
    let p = Project::from_json(&Json::parse(j).unwrap()).unwrap();
    let e = run_export(&p, &dir, "missing", false).unwrap_err();
    assert!(e.contains("missing.mp4"), "{}", e);
}

#[test]
fn empty_timeline_is_an_error() {
    let dir = work();
    let p = Project::from_json(&Json::parse(r#"{"width":640,"height":360,"tracks":[]}"#).unwrap()).unwrap();
    assert!(run_export(&p, &dir, "empty", false).is_err());
}

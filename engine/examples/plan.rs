//! Debug helper: cargo run --example plan -- project.json out.mp4 [width height]
use engine::export::{self, Progress, Settings};
use engine::ff::Ff;
use engine::json::Json;
use engine::model::Project;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let j = Json::parse(&std::fs::read_to_string(&a[1]).unwrap()).unwrap();
    let p = Project::from_json(&j).unwrap();
    let ff = Ff::locate();
    let dir = std::env::temp_dir();
    let enc = export::pick_encoder(&ff, "auto").unwrap();
    let s = Settings {
        path: a[2].clone(), width: p.width, height: p.height, fps: p.fps, quality: "medium".into(), encoder: enc,
        audio_only: false,
        font_regular: "/usr/share/fonts/opentype/inter/Inter-Regular.otf".into(),
        font_bold: "/usr/share/fonts/opentype/inter/Inter-Bold.otf".into(), work_dir: dir.clone(),
    };
    let plan = export::plan(&p, &s, 0, p.duration()).unwrap();
    println!("INPUTS: {:?}\n\nGRAPH:\n{}\n\nOUT: {:?}", plan.input_args, plan.script, plan.out_args);
    let prog = Progress::new();
    match export::run(&ff, &plan, &a[2], &dir, &prog) {
        Ok(()) => println!("OK"),
        Err(e) => println!("ERR {}", e),
    }
}

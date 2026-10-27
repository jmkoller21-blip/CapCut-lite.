//! Dev server: cargo run --release --example devserver -- <ui_dir> [port] [stock_dir]
use engine::cmd::Paths;
use std::path::PathBuf;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let ui = PathBuf::from(a.get(1).expect("ui dir"));
    let port: u16 = a.get(2).and_then(|p| p.parse().ok()).unwrap_or(7788);
    let stock = a.get(3).map(PathBuf::from).unwrap_or_else(|| ui.join("../stock"));
    let data = std::env::var_os("LITE_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("lite-editor-dev"));
    let fonts = std::env::var_os("LITE_FONT_DIR").map(PathBuf::from).unwrap_or_else(|| ui.join("fonts"));
    let paths = Paths { data_dir: data, ui_dir: ui, stock_dir: stock, font_dir: fonts, ffmpeg_dir: None };
    engine::server::run_blocking(paths, port, Some("devtoken".into())).unwrap();
}

// The Windows shell: starts the local engine, then opens one window on it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use engine::cmd::Paths;
use std::path::{Path, PathBuf};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Tauri can hand back `\\?\C:\...` paths on Windows; plain paths behave better with other tools.
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

fn log_failure(dir: &Path, msg: &str) {
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(dir.join("startup-error.txt"), msg);
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let res = plain(app.path().resource_dir()?);
            let data = plain(app.path().app_local_data_dir()?);
            let ui = res.join("ui");
            let ffmpeg = res.join("ffmpeg");
            let paths = Paths {
                data_dir: data.clone(),
                ui_dir: ui.clone(),
                stock_dir: res.join("stock"),
                font_dir: ui.join("fonts"),
                ffmpeg_dir: if ffmpeg.is_dir() { Some(ffmpeg) } else { None },
            };
            // Test hook for CI: a fixed port and token let a script reach the engine. Unset for normal use.
            let port: u16 = std::env::var("LITE_TEST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
            let token: Option<String> = std::env::var("LITE_TEST_TOKEN").ok().filter(|t| !t.is_empty());
            let handle = match engine::server::start(paths, port, token) {
                Ok(h) => h,
                Err(e) => {
                    log_failure(&data, &e);
                    return Err(e.into());
                }
            };
            let url = handle.url().parse().map_err(|_| "bad local address")?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Lite Editor")
                .inner_size(1360.0, 820.0)
                .min_inner_size(1000.0, 620.0)
                .build()?;
            app.manage(handle); // keeps the engine alive for the life of the app
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the editor could not start");
}

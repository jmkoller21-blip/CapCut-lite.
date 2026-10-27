//! Native file dialogs. On Windows these use PowerShell and Windows Forms (present on every
//! Windows 10/11 install), so no extra component ships with the app. Elsewhere they report
//! that no native dialog exists and the UI falls back to a path prompt.

use crate::json::Json;

#[cfg(windows)]
fn run_ps(script: &str, envs: &[(&str, String)]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let mut c = std::process::Command::new("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script]);
    for (k, v) in envs {
        c.env(k, v);
    }
    c.creation_flags(0x0800_0000);
    let out = c.output().map_err(|e| format!("could not open the file dialog: {}", e))?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(windows)]
const PRELUDE: &str = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::EnableVisualStyles(); $f=New-Object System.Windows.Forms.Form; $f.TopMost=$true; $f.ShowInTaskbar=$false; $f.Opacity=0; $f.StartPosition='CenterScreen'; $f.Show(); ";

#[allow(dead_code)]
fn filter_for(kind: &str) -> &'static str {
    match kind {
        "media" => "Media files|*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.wmv;*.flv;*.mpg;*.mpeg;*.ts;*.mts;*.m2ts;*.3gp;*.mp3;*.wav;*.m4a;*.aac;*.ogg;*.opus;*.flac;*.wma;*.png;*.jpg;*.jpeg;*.bmp;*.webp;*.tif;*.tiff|All files|*.*",
        "srt" => "Subtitles|*.srt|All files|*.*",
        _ => "All files|*.*",
    }
}

#[cfg(windows)]
pub fn open(a: &Json) -> Result<Json, String> {
    let script = format!(
        "{}$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title=$env:LITE_TITLE; $d.Filter=$env:LITE_FILTER; $d.Multiselect=($env:LITE_MULTI -eq '1'); if($d.ShowDialog($f) -eq 'OK'){{ $d.FileNames -join \"`n\" }}; $f.Close()",
        PRELUDE
    );
    let out = run_ps(
        &script,
        &[
            ("LITE_TITLE", a.str_or("title", "Choose files")),
            ("LITE_FILTER", filter_for(&a.str_or("kind", "media")).to_string()),
            ("LITE_MULTI", if a.bool_or("multi", true) { "1".into() } else { "0".into() }),
        ],
    )?;
    let paths: Vec<Json> = out.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).map(Json::s).collect();
    Ok(Json::obj(vec![("paths", Json::Arr(paths))]))
}

#[cfg(windows)]
pub fn save(a: &Json) -> Result<Json, String> {
    let ext = a.str_or("ext", "mp4");
    let script = format!(
        "{}$d=New-Object System.Windows.Forms.SaveFileDialog; $d.Title=$env:LITE_TITLE; $d.FileName=$env:LITE_NAME; $d.DefaultExt=$env:LITE_EXT; $d.Filter=$env:LITE_FILTER; $d.OverwritePrompt=$true; if($d.ShowDialog($f) -eq 'OK'){{ $d.FileName }}; $f.Close()",
        PRELUDE
    );
    let out = run_ps(
        &script,
        &[
            ("LITE_TITLE", a.str_or("title", "Save as")),
            ("LITE_NAME", a.str_or("default_name", "video")),
            ("LITE_EXT", ext.clone()),
            ("LITE_FILTER", format!("{} file|*.{}|All files|*.*", ext.to_uppercase(), ext)),
        ],
    )?;
    Ok(Json::obj(vec![("path", Json::s(out.lines().next().unwrap_or("").trim()))]))
}

#[cfg(windows)]
pub fn reveal(path: &str) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("explorer.exe").raw_arg(format!("/select,\"{}\"", path.replace('/', "\\"))).creation_flags(0x0800_0000).spawn();
}

#[cfg(not(windows))]
pub fn open(_a: &Json) -> Result<Json, String> {
    Err("no_native_dialog".into())
}

#[cfg(not(windows))]
pub fn save(_a: &Json) -> Result<Json, String> {
    Err("no_native_dialog".into())
}

#[cfg(not(windows))]
pub fn reveal(_path: &str) {}

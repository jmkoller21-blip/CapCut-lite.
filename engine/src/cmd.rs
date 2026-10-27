//! Command layer: every action the UI can ask for, as `dispatch(cmd, args) -> Result<Json, String>`.
//! The HTTP server and the tests both call this, so there is one code path.

use crate::export::{self, Progress, Settings};
use crate::ff::Ff;
use crate::json::Json;
use crate::media;
use crate::model::{MediaKind, Project};
use crate::store::{new_id, now_secs, Store};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub ui_dir: PathBuf,
    pub stock_dir: PathBuf,
    pub font_dir: PathBuf,
    pub ffmpeg_dir: Option<PathBuf>,
}

pub struct Job {
    pub kind: String,
    pub state: String, // running | done | error | cancelled
    pub message: String,
    pub result: Json,
    pub progress: Arc<Progress>,
    pub cancel: Arc<AtomicBool>,
}

pub struct App {
    pub ff: Ff,
    pub store: Store,
    pub paths: Paths,
    jobs: Mutex<HashMap<String, Job>>,
    allowed: Mutex<Vec<PathBuf>>,
}

fn canon(p: &str) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p))
}

impl App {
    pub fn new(paths: Paths) -> Result<Arc<App>, String> {
        let store = Store::new(&paths.data_dir)?;
        let ff = match &paths.ffmpeg_dir {
            Some(d) => Ff::with_dir(d),
            None => Ff::locate(),
        };
        Ok(Arc::new(App { ff, store, paths, jobs: Mutex::new(HashMap::new()), allowed: Mutex::new(Vec::new()) }))
    }

    /// Files the browser side may read: media the user added, plus our own folders.
    pub fn allow(&self, path: &str) {
        let c = canon(path);
        let mut a = self.allowed.lock().unwrap();
        if !a.contains(&c) {
            a.push(c);
        }
    }

    pub fn is_allowed(&self, path: &Path) -> bool {
        let c = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if c.starts_with(canon(&self.paths.data_dir.to_string_lossy())) || c.starts_with(canon(&self.paths.stock_dir.to_string_lossy())) {
            return true;
        }
        self.allowed.lock().unwrap().iter().any(|a| *a == c)
    }

    fn proxy_height(&self) -> u32 {
        self.store.get_settings().i64_or("proxy_height", 540).clamp(144, 1080) as u32
    }

    // ---------- jobs
    fn add_job(&self, kind: &str) -> (String, Arc<Progress>, Arc<AtomicBool>) {
        let id = new_id();
        let prog = Progress::new();
        let cancel = Arc::new(AtomicBool::new(false));
        self.jobs.lock().unwrap().insert(
            id.clone(),
            Job { kind: kind.into(), state: "running".into(), message: String::new(), result: Json::Null, progress: prog.clone(), cancel: cancel.clone() },
        );
        (id, prog, cancel)
    }

    fn finish_job(&self, id: &str, r: Result<Json, String>) {
        if let Some(j) = self.jobs.lock().unwrap().get_mut(id) {
            match r {
                Ok(v) => {
                    j.state = "done".into();
                    j.result = v;
                    *j.progress.pct.lock().unwrap() = 100.0;
                }
                Err(e) if e == "cancelled" => {
                    j.state = "cancelled".into();
                    j.message = e;
                }
                Err(e) => {
                    j.state = "error".into();
                    j.message = e;
                }
            }
        }
    }

    fn job_json(&self, id: &str) -> Json {
        match self.jobs.lock().unwrap().get(id) {
            None => Json::obj(vec![("state", Json::s("unknown"))]),
            Some(j) => Json::obj(vec![
                ("id", Json::s(id)),
                ("kind", Json::s(&j.kind)),
                ("state", Json::s(&j.state)),
                ("pct", Json::n(*j.progress.pct.lock().unwrap())),
                ("message", Json::s(&j.message)),
                ("result", j.result.clone()),
            ]),
        }
    }

    // ---------- dispatch
    pub fn dispatch(self: &Arc<App>, cmd: &str, a: &Json) -> Result<Json, String> {
        match cmd {
            "sys_info" => Ok(self.sys_info()),
            "project_list" => Ok(Json::Arr(self.store.list_projects())),
            "project_new" => {
                let mut doc = vec![
                    ("id".to_string(), Json::s(&new_id())),
                    ("version".to_string(), Json::n(1.0)),
                    ("name".to_string(), Json::s(&a.str_or("name", "Untitled project"))),
                    ("width".to_string(), Json::n(a.f64_or("width", 1920.0))),
                    ("height".to_string(), Json::n(a.f64_or("height", 1080.0))),
                    ("fps".to_string(), Json::n(a.f64_or("fps", 30.0))),
                    ("updated".to_string(), Json::n(now_secs() as f64)),
                    ("media".to_string(), Json::Arr(vec![])),
                    ("markers".to_string(), Json::Arr(vec![])),
                    (
                        "tracks".to_string(),
                        Json::Arr(vec![
                            track("t-text", "text"),
                            track("t-v2", "video"),
                            track("t-v1", "video"),
                            track("t-a1", "audio"),
                        ]),
                    ),
                ];
                // tracks are stored bottom to top, so reverse the display order above
                if let Some((_, Json::Arr(t))) = doc.iter_mut().find(|(k, _)| k == "tracks") {
                    t.reverse();
                }
                let doc = Json::Obj(doc);
                self.store.save_project(&doc)?;
                Ok(doc)
            }
            "project_load" => {
                let doc = self.store.load_project(&a.str_or("id", ""))?;
                for m in doc.get("media").map(|m| m.as_arr()).unwrap_or(&[]) {
                    self.allow(&m.str_or("path", ""));
                    if let Some(p) = m.get("proxy").and_then(|p| p.as_str()) {
                        self.allow(p);
                    }
                }
                Ok(doc)
            }
            "project_save" => {
                let mut doc = a.get("doc").cloned().ok_or("missing doc")?;
                if let Json::Obj(items) = &mut doc {
                    items.retain(|(k, _)| k != "updated");
                    items.push(("updated".into(), Json::n(now_secs() as f64)));
                }
                self.store.save_project(&doc)?;
                Ok(Json::obj(vec![("ok", Json::Bool(true))]))
            }
            "project_delete" => {
                self.store.delete_project(&a.str_or("id", ""))?;
                Ok(Json::obj(vec![("ok", Json::Bool(true))]))
            }
            "media_import" => self.media_import(a),
            "media_check" => Ok(self.media_check(a)),
            "job_status" => Ok(self.job_json(&a.str_or("id", ""))),
            "job_cancel" => {
                if let Some(j) = self.jobs.lock().unwrap().get(&a.str_or("id", "")) {
                    j.cancel.store(true, Ordering::Relaxed);
                    j.progress.cancel.store(true, Ordering::Relaxed);
                }
                Ok(Json::obj(vec![("ok", Json::Bool(true))]))
            }
            "waveform" => {
                let path = a.str_or("path", "");
                self.allow(&path);
                media::waveform(&self.ff, &self.store, &a.str_or("id", &media::media_id(&path)), &path)
            }
            "pick_open" => crate::dialogs::open(a),
            "pick_save" => crate::dialogs::save(a),
            "export_start" => self.export_start(a),
            "stock_list" => Ok(self.stock_list()),
            "reveal" => {
                crate::dialogs::reveal(&a.str_or("path", ""));
                Ok(Json::obj(vec![("ok", Json::Bool(true))]))
            }
            "read_text" => {
                let path = a.str_or("path", "");
                let md = std::fs::metadata(&path).map_err(|e| e.to_string())?;
                if md.len() > 4_000_000 {
                    return Err("that file is too large".into());
                }
                let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
                let text = String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}').to_string();
                Ok(Json::obj(vec![("text", Json::s(&text))]))
            }
            "settings_get" => Ok(self.store.get_settings()),
            "settings_set" => {
                self.store.set_settings(a.get("settings").ok_or("missing settings")?)?;
                Ok(Json::obj(vec![("ok", Json::Bool(true))]))
            }
            "cache_info" => Ok(Json::obj(vec![("bytes", Json::n(self.store.cache_size() as f64))])),
            "cache_clear" => {
                self.store.clear_cache();
                Ok(Json::obj(vec![("ok", Json::Bool(true))]))
            }
            _ => Err(format!("unknown command: {}", cmd)),
        }
    }

    fn sys_info(&self) -> Json {
        let version = self.ff.version();
        let encoders: Vec<Json> = if version.is_some() { self.ff.usable_h264_encoders().iter().map(|e| Json::s(e)).collect() } else { vec![] };
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        Json::obj(vec![
            ("app_version", Json::s(env!("CARGO_PKG_VERSION"))),
            ("ffmpeg", version.map(|v| Json::s(&v)).unwrap_or(Json::Null)),
            ("encoders", Json::Arr(encoders)),
            ("cores", Json::n(cores as f64)),
            ("os", Json::s(std::env::consts::OS)),
            ("data_dir", Json::s(&self.paths.data_dir.to_string_lossy())),
        ])
    }

    fn media_import(self: &Arc<App>, a: &Json) -> Result<Json, String> {
        if !self.ff.available() {
            return Err("FFmpeg was not found, so media cannot be read".into());
        }
        let ph = self.proxy_height();
        let mut out: Vec<Json> = Vec::new();
        for pv in a.get("paths").map(|p| p.as_arr()).unwrap_or(&[]) {
            let path = match pv.as_str() {
                Some(p) => p.to_string(),
                None => continue,
            };
            let name = Path::new(&path).file_name().and_then(|n| n.to_str()).unwrap_or(&path).to_string();
            if !Path::new(&path).is_file() {
                out.push(Json::obj(vec![("path", Json::s(&path)), ("name", Json::s(&name)), ("error", Json::s("the file does not exist"))]));
                continue;
            }
            let info = match self.ff.probe(&path) {
                Ok(i) => i,
                Err(e) => {
                    out.push(Json::obj(vec![("path", Json::s(&path)), ("name", Json::s(&name)), ("error", Json::s(&e))]));
                    continue;
                }
            };
            self.allow(&path);
            let mut rec = media::record(&path, &info);
            let id = rec.str_or("id", "");
            let has_thumb = media::make_thumb(&self.ff, &self.store, &id, &path, &info);
            let mut extra: Vec<(String, Json)> = vec![("thumb".into(), Json::Bool(has_thumb))];
            if media::needs_proxy(&info, &path, ph) {
                let job = self.start_proxy(&id, &path, info.clone(), ph);
                extra.push(("proxy_job".into(), Json::s(&job)));
                extra.push(("proxy".into(), Json::s("")));
            } else {
                extra.push(("proxy".into(), Json::s("")));
            }
            if let Json::Obj(items) = &mut rec {
                items.extend(extra);
            }
            out.push(rec);
        }
        Ok(Json::obj(vec![("items", Json::Arr(out))]))
    }

    fn start_proxy(self: &Arc<App>, id: &str, path: &str, info: crate::ff::MediaInfo, ph: u32) -> String {
        let (job, _prog, cancel) = self.add_job("proxy");
        let me = self.clone();
        let (id, path, job2) = (id.to_string(), path.to_string(), job.clone());
        std::thread::spawn(move || {
            let enc = if info.kind == MediaKind::Video {
                let usable = me.ff.usable_h264_encoders();
                // prefer a software or hardware H.264 encoder; fall back to VP8 (always playable in the browser engine)
                usable.iter().find(|e| *e != "mpeg4" && *e != "libvpx").or_else(|| usable.iter().find(|e| *e == "libvpx")).cloned().unwrap_or_else(|| "libvpx".to_string())
            } else {
                String::new()
            };
            let r = media::make_proxy(&me.ff, &me.store, &id, &path, &info, &enc, ph, &cancel);
            match r {
                Ok(p) => {
                    let ps = p.to_string_lossy().to_string();
                    me.allow(&ps);
                    me.finish_job(&job2, Ok(Json::obj(vec![("proxy", Json::s(&ps))])));
                }
                Err(e) => me.finish_job(&job2, Err(e)),
            }
        });
        job
    }

    /// For each media item of a loaded project: is the file still there, and does it have a usable proxy?
    fn media_check(self: &Arc<App>, a: &Json) -> Json {
        let ph = self.proxy_height();
        let mut out = Vec::new();
        for m in a.get("items").map(|m| m.as_arr()).unwrap_or(&[]) {
            let id = m.str_or("id", "");
            let path = m.str_or("path", "");
            let exists = Path::new(&path).is_file();
            let mut item = vec![("id".to_string(), Json::s(&id)), ("exists".to_string(), Json::Bool(exists))];
            if exists {
                self.allow(&path);
                if let Ok(info) = self.ff.probe(&path) {
                    if media::needs_proxy(&info, &path, ph) {
                        let existing = m.str_or("proxy", "");
                        if !existing.is_empty() && Path::new(&existing).is_file() {
                            self.allow(&existing);
                        } else {
                            let job = self.start_proxy(&id, &path, info, ph);
                            item.push(("proxy_job".into(), Json::s(&job)));
                        }
                    }
                }
                let kind = m.str_or("kind", "video");
                if kind != "audio" && !media::thumb_path(&self.store, &id).exists() {
                    if let Ok(info) = self.ff.probe(&path) {
                        media::make_thumb(&self.ff, &self.store, &id, &path, &info);
                    }
                }
            }
            out.push(Json::Obj(item));
        }
        Json::obj(vec![("items", Json::Arr(out))])
    }

    fn export_start(self: &Arc<App>, a: &Json) -> Result<Json, String> {
        let doc = a.get("doc").ok_or("missing project")?;
        let st = a.get("settings").ok_or("missing settings")?;
        let project = Project::from_json(doc)?;
        let path = st.str_or("path", "");
        if path.is_empty() {
            return Err("choose where to save the file".into());
        }
        let audio_only = st.bool_or("audio_only", false);
        let encoder = if audio_only { String::new() } else { export::pick_encoder(&self.ff, &st.str_or("encoder", "auto"))? };
        let font = |n: &str| self.paths.font_dir.join(n).to_string_lossy().to_string();
        let settings = Settings {
            path: path.clone(),
            width: st.i64_or("width", project.width as i64).clamp(16, 7680) as u32,
            height: st.i64_or("height", project.height as i64).clamp(16, 4320) as u32,
            fps: st.f64_or("fps", project.fps).clamp(1.0, 120.0),
            quality: st.str_or("quality", "medium"),
            encoder,
            audio_only,
            font_regular: font("Inter-Regular.otf"),
            font_bold: font("Inter-Bold.otf"),
            work_dir: self.store.tmp_dir(),
        };
        let plan = export::plan(&project, &settings, 0, project.duration())?;
        let (job, prog, _cancel) = self.add_job("export");
        let me = self.clone();
        let (job2, work) = (job.clone(), settings.work_dir.clone());
        std::thread::spawn(move || {
            let r = export::run(&me.ff, &plan, &path, &work, &prog).map(|_| Json::obj(vec![("path", Json::s(&path))]));
            me.finish_job(&job2, r);
        });
        Ok(Json::obj(vec![("job", Json::s(&job))]))
    }

    fn stock_list(&self) -> Json {
        let idx = self.paths.stock_dir.join("index.json");
        let items = std::fs::read_to_string(&idx).ok().and_then(|s| Json::parse(&s).ok()).unwrap_or(Json::Arr(vec![]));
        let mut out = Vec::new();
        for it in items.as_arr() {
            let mut o = match it {
                Json::Obj(v) => v.clone(),
                _ => continue,
            };
            let file = it.str_or("file", "");
            let abs = self.paths.stock_dir.join(&file);
            o.push(("path".into(), Json::s(&abs.to_string_lossy())));
            let th = it.str_or("thumb", "");
            if !th.is_empty() {
                o.push(("thumb_path".into(), Json::s(&self.paths.stock_dir.join(th).to_string_lossy())));
            }
            out.push(Json::Obj(o));
        }
        Json::Arr(out)
    }

    /// Voice recordings and other uploads land here. Returns the saved path.
    pub fn save_upload(&self, name: &str, data: &[u8]) -> Result<String, String> {
        let ext = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("webm");
        let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(5).collect();
        let file = self.store.recordings_dir().join(format!("voice-{}.{}", new_id(), if ext.is_empty() { "webm".into() } else { ext }));
        std::fs::write(&file, data).map_err(|e| e.to_string())?;
        let p = file.to_string_lossy().to_string();
        self.allow(&p);
        Ok(p)
    }

    pub fn quiet_command(&self, name: &str) -> std::process::Command {
        let mut c = std::process::Command::new(name);
        c.stdin(Stdio::null());
        c
    }
}

fn track(id: &str, kind: &str) -> Json {
    Json::obj(vec![("id", Json::s(id)), ("kind", Json::s(kind)), ("muted", Json::Bool(false)), ("hidden", Json::Bool(false)), ("locked", Json::Bool(false)), ("clips", Json::Arr(vec![]))])
}

//! Local storage: projects, settings and caches under one data folder.
//! Saves are atomic (write a temp file, then rename) and keep three backups.

use crate::json::Json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub struct Store {
    pub root: PathBuf,
}

pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn new_id() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}{:03x}", n, c & 0xfff)
}

/// FNV-1a, stable across runs and platforms (used for cache file names).
pub fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", h)
}

pub fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Store {
    pub fn new(root: &Path) -> Result<Store, String> {
        let s = Store { root: root.to_path_buf() };
        for d in ["projects", "cache/thumbs", "cache/proxies", "cache/waves", "tmp", "recordings"] {
            fs::create_dir_all(root.join(d)).map_err(|e| format!("could not create {}: {}", root.join(d).display(), e))?;
        }
        Ok(s)
    }

    pub fn tmp_dir(&self) -> PathBuf {
        self.root.join("tmp")
    }
    pub fn cache_dir(&self, sub: &str) -> PathBuf {
        self.root.join("cache").join(sub)
    }
    pub fn recordings_dir(&self) -> PathBuf {
        self.root.join("recordings")
    }

    fn project_path(&self, id: &str) -> Result<PathBuf, String> {
        if !safe_id(id) {
            return Err("invalid project id".into());
        }
        Ok(self.root.join("projects").join(format!("{}.json", id)))
    }

    pub fn write_atomic(path: &Path, data: &[u8], keep_backups: bool) -> Result<(), String> {
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, data).map_err(|e| format!("could not write {}: {}", tmp.display(), e))?;
        if keep_backups && path.exists() {
            // rotate: .bak2 -> .bak3, .bak1 -> .bak2, current -> .bak1
            for i in (1..3).rev() {
                let from = path.with_extension(format!("json.bak{}", i));
                let to = path.with_extension(format!("json.bak{}", i + 1));
                if from.exists() {
                    let _ = fs::rename(&from, &to);
                }
            }
            let _ = fs::copy(path, path.with_extension("json.bak1"));
        }
        fs::rename(&tmp, path).map_err(|e| format!("could not save {}: {}", path.display(), e))
    }

    pub fn save_project(&self, doc: &Json) -> Result<(), String> {
        let id = doc.str_or("id", "");
        let path = self.project_path(&id)?;
        Store::write_atomic(&path, doc.to_string().as_bytes(), true)
    }

    pub fn load_project(&self, id: &str) -> Result<Json, String> {
        let path = self.project_path(id)?;
        let try_read = |p: &Path| -> Result<Json, String> {
            let s = fs::read_to_string(p).map_err(|e| e.to_string())?;
            Json::parse(&s)
        };
        match try_read(&path) {
            Ok(j) => Ok(j),
            Err(first) => {
                // fall back to the newest readable backup
                for i in 1..=3 {
                    let b = path.with_extension(format!("json.bak{}", i));
                    if let Ok(j) = try_read(&b) {
                        return Ok(j);
                    }
                }
                Err(format!("could not open the project: {}", first))
            }
        }
    }

    pub fn delete_project(&self, id: &str) -> Result<(), String> {
        let path = self.project_path(id)?;
        let _ = fs::remove_file(&path);
        for i in 1..=3 {
            let _ = fs::remove_file(path.with_extension(format!("json.bak{}", i)));
        }
        Ok(())
    }

    pub fn list_projects(&self) -> Vec<Json> {
        let mut items: Vec<(i64, Json)> = Vec::new();
        if let Ok(rd) = fs::read_dir(self.root.join("projects")) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(s) = fs::read_to_string(&p) {
                    if let Ok(j) = Json::parse(&s) {
                        let clips: usize = j.get("tracks").map(|t| t.as_arr().iter().map(|t| t.get("clips").map(|c| c.as_arr().len()).unwrap_or(0)).sum()).unwrap_or(0);
                        let updated = j.i64_or("updated", 0);
                        items.push((
                            updated,
                            Json::obj(vec![
                                ("id", Json::s(&j.str_or("id", ""))),
                                ("name", Json::s(&j.str_or("name", "Untitled"))),
                                ("updated", Json::n(updated as f64)),
                                ("width", Json::n(j.f64_or("width", 1920.0))),
                                ("height", Json::n(j.f64_or("height", 1080.0))),
                                ("fps", Json::n(j.f64_or("fps", 30.0))),
                                ("clips", Json::n(clips as f64)),
                            ]),
                        ));
                    }
                }
            }
        }
        items.sort_by(|a, b| b.0.cmp(&a.0));
        items.into_iter().map(|x| x.1).collect()
    }

    pub fn get_settings(&self) -> Json {
        fs::read_to_string(self.root.join("settings.json")).ok().and_then(|s| Json::parse(&s).ok()).unwrap_or(Json::Obj(vec![]))
    }

    pub fn set_settings(&self, j: &Json) -> Result<(), String> {
        Store::write_atomic(&self.root.join("settings.json"), j.to_string().as_bytes(), false)
    }

    /// Total size of the proxy and thumbnail caches, in bytes.
    pub fn cache_size(&self) -> u64 {
        fn dir_size(p: &Path) -> u64 {
            fs::read_dir(p).map(|rd| rd.flatten().map(|e| e.metadata().map(|m| if m.is_dir() { dir_size(&e.path()) } else { m.len() }).unwrap_or(0)).sum()).unwrap_or(0)
        }
        dir_size(&self.root.join("cache"))
    }

    pub fn clear_cache(&self) {
        for d in ["thumbs", "proxies", "waves"] {
            let p = self.cache_dir(d);
            let _ = fs::remove_dir_all(&p);
            let _ = fs::create_dir_all(&p);
        }
        let _ = fs::remove_dir_all(self.tmp_dir());
        let _ = fs::create_dir_all(self.tmp_dir());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lite-store-{}-{}", name, new_id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn save_load_backup_and_corruption() {
        let s = Store::new(&tmp("a")).unwrap();
        let doc = |name: &str| Json::obj(vec![("id", Json::s("p1")), ("name", Json::s(name)), ("updated", Json::n(5.0))]);
        s.save_project(&doc("one")).unwrap();
        s.save_project(&doc("two")).unwrap();
        assert_eq!(s.load_project("p1").unwrap().str_or("name", ""), "two");
        // corrupt the main file: the newest backup is used
        fs::write(s.root.join("projects/p1.json"), "{broken").unwrap();
        assert_eq!(s.load_project("p1").unwrap().str_or("name", ""), "one");
        assert_eq!(s.list_projects().len(), 0 + if fs::read_to_string(s.root.join("projects/p1.json")).ok().and_then(|x| Json::parse(&x).ok()).is_some() { 1 } else { 0 });
    }

    #[test]
    fn ids_are_validated() {
        let s = Store::new(&tmp("b")).unwrap();
        assert!(s.load_project("../etc/passwd").is_err());
        assert!(s.delete_project("a/b").is_err());
        assert!(safe_id("abc-123_x"));
        assert!(!safe_id(""));
    }

    #[test]
    fn list_orders_newest_first() {
        let s = Store::new(&tmp("c")).unwrap();
        for (id, t) in [("a", 1.0), ("b", 3.0), ("c", 2.0)] {
            s.save_project(&Json::obj(vec![("id", Json::s(id)), ("name", Json::s(id)), ("updated", Json::n(t))])).unwrap();
        }
        let names: Vec<String> = s.list_projects().iter().map(|j| j.str_or("id", "")).collect();
        assert_eq!(names, vec!["b", "c", "a"]);
    }

    #[test]
    fn fnv_is_stable() {
        assert_eq!(fnv("hello"), fnv("hello"));
        assert_ne!(fnv("a"), fnv("b"));
        assert_eq!(fnv("a"), "af63dc4c8601ec8c");
    }
}

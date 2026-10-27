//! Project model, parsed from the JSON the UI sends. Times are integer microseconds.

use crate::json::Json;
use std::collections::HashMap;

pub const US: i64 = 1_000_000;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TrackKind {
    Video,
    Audio,
    Text,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

#[derive(Clone, Debug)]
pub struct Media {
    pub id: String,
    pub path: String,
    pub proxy: Option<String>,
    pub kind: MediaKind,
    pub dur: i64,
    pub w: u32,
    pub h: u32,
    pub has_audio: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Adjust {
    pub brightness: f64, // -1..1
    pub contrast: f64,   // 0..2, 1 = unchanged
    pub saturation: f64, // 0..2, 1 = unchanged
    pub filter: String,  // "", mono, warm, cool, vivid, fade, vintage
    pub strength: f64,   // 0..1
}

impl Adjust {
    pub fn is_identity(&self) -> bool {
        self.brightness.abs() < 0.001
            && (self.contrast - 1.0).abs() < 0.001
            && (self.saturation - 1.0).abs() < 0.001
            && (self.filter.is_empty() || self.strength <= 0.001)
    }
}

#[derive(Clone, Debug)]
pub struct TextSpec {
    pub content: String,
    pub size: f64, // fraction of canvas height
    pub color: String,
    pub bold: bool,
    pub outline: bool,
    pub shadow: bool,
    pub boxed: bool,
}

#[derive(Clone, Debug)]
pub struct Transition {
    pub kind: String,
    pub dur: i64,
}

#[derive(Clone, Debug)]
pub struct Clip {
    pub id: String,
    pub media_id: Option<String>,
    pub start: i64,
    pub dur: i64,
    pub src_in: i64,
    pub speed: f64,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rot: f64,
    pub opacity: f64,
    pub mirror: bool,
    pub volume: f64,
    pub fade_in: i64,
    pub fade_out: i64,
    pub adj: Adjust,
    pub text: Option<TextSpec>,
    pub transition_in: Option<Transition>,
}

impl Clip {
    pub fn end(&self) -> i64 {
        self.start + self.dur
    }
}

#[derive(Clone, Debug)]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    pub muted: bool,
    pub hidden: bool,
    pub clips: Vec<Clip>,
}

#[derive(Clone, Debug)]
pub struct Project {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub tracks: Vec<Track>, // bottom to top
    pub media: HashMap<String, Media>,
}

impl Project {
    pub fn from_json(j: &Json) -> Result<Project, String> {
        let width = j.i64_or("width", 1920).clamp(16, 7680) as u32;
        let height = j.i64_or("height", 1080).clamp(16, 4320) as u32;
        let fps = j.f64_or("fps", 30.0).clamp(1.0, 120.0);
        let mut media = HashMap::new();
        for m in j.get("media").map(|m| m.as_arr()).unwrap_or(&[]) {
            let kind = match m.str_or("kind", "video").as_str() {
                "audio" => MediaKind::Audio,
                "image" => MediaKind::Image,
                _ => MediaKind::Video,
            };
            let id = m.str_or("id", "");
            if id.is_empty() {
                continue;
            }
            let proxy = m.get("proxy").and_then(|p| p.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
            media.insert(
                id.clone(),
                Media {
                    id,
                    path: m.str_or("path", ""),
                    proxy,
                    kind,
                    dur: m.i64_or("dur", 0),
                    w: m.i64_or("w", 0).max(0) as u32,
                    h: m.i64_or("h", 0).max(0) as u32,
                    has_audio: m.bool_or("has_audio", false),
                },
            );
        }
        let mut tracks = Vec::new();
        for t in j.get("tracks").map(|t| t.as_arr()).unwrap_or(&[]) {
            let kind = match t.str_or("kind", "video").as_str() {
                "audio" => TrackKind::Audio,
                "text" => TrackKind::Text,
                _ => TrackKind::Video,
            };
            let mut clips = Vec::new();
            for c in t.get("clips").map(|c| c.as_arr()).unwrap_or(&[]) {
                let adj = match c.get("adj") {
                    Some(a) => Adjust {
                        brightness: a.f64_or("brightness", 0.0),
                        contrast: a.f64_or("contrast", 1.0),
                        saturation: a.f64_or("saturation", 1.0),
                        filter: a.str_or("filter", ""),
                        strength: a.f64_or("strength", 1.0),
                    },
                    None => Adjust { contrast: 1.0, saturation: 1.0, strength: 1.0, ..Default::default() },
                };
                let text = c.get("text").map(|x| TextSpec {
                    content: x.str_or("content", ""),
                    size: x.f64_or("size", 0.08).clamp(0.01, 0.5),
                    color: x.str_or("color", "#ffffff"),
                    bold: x.bool_or("bold", true),
                    outline: x.bool_or("outline", true),
                    shadow: x.bool_or("shadow", false),
                    boxed: x.bool_or("boxed", false),
                });
                let transition_in = c.get("transition_in").and_then(|t| {
                    let kind = t.str_or("kind", "");
                    let dur = t.i64_or("dur", 0);
                    if kind.is_empty() || dur <= 0 { None } else { Some(Transition { kind, dur }) }
                });
                let dur = c.i64_or("dur", 0);
                if dur <= 0 {
                    continue;
                }
                clips.push(Clip {
                    id: c.str_or("id", ""),
                    media_id: c.get("media").and_then(|m| m.as_str()).map(|s| s.to_string()),
                    start: c.i64_or("start", 0).max(0),
                    dur,
                    src_in: c.i64_or("in", 0).max(0),
                    speed: c.f64_or("speed", 1.0).clamp(0.1, 16.0),
                    x: c.f64_or("x", 0.0),
                    y: c.f64_or("y", 0.0),
                    scale: c.f64_or("scale", 1.0).clamp(0.01, 20.0),
                    rot: c.f64_or("rot", 0.0),
                    opacity: c.f64_or("opacity", 1.0).clamp(0.0, 1.0),
                    mirror: c.bool_or("mirror", false),
                    volume: c.f64_or("volume", 1.0).clamp(0.0, 4.0),
                    fade_in: c.i64_or("fade_in", 0).max(0),
                    fade_out: c.i64_or("fade_out", 0).max(0),
                    adj,
                    text,
                    transition_in,
                });
            }
            clips.sort_by_key(|c| c.start);
            tracks.push(Track {
                id: t.str_or("id", ""),
                kind,
                muted: t.bool_or("muted", false),
                hidden: t.bool_or("hidden", false),
                clips,
            });
        }
        Ok(Project { name: j.str_or("name", "Untitled"), width, height, fps, tracks, media })
    }

    /// End of the last clip on any track.
    pub fn duration(&self) -> i64 {
        self.tracks.iter().flat_map(|t| t.clips.iter()).map(|c| c.end()).max().unwrap_or(0)
    }
}

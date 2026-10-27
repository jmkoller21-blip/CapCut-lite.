// Project state, undo/redo, and the edit operations. Times are integer microseconds.
import { api } from './api.js';

export const US = 1e6;
export const MIN_DUR = 100000; // 0.1 s
export const S = {
  doc: null, sel: null, t: 0, playing: false, pps: 80, snap: true,
  undo: [], redo: [], dirty: false, sys: null, settings: {}, saving: false,
};

const listeners = {};
export const on = (ev, fn) => { (listeners[ev] ||= []).push(fn); };
export const emit = (ev, d) => { (listeners[ev] || []).forEach((f) => f(d)); };

export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const frameUs = () => US / (S.doc ? S.doc.fps : 30);

export function fmtTime(us, withFrames = true) {
  us = Math.max(0, Math.round(us));
  const total = us / US;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((us % US) / frameUs());
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${withFrames ? '.' + String(f).padStart(2, '0') : ''}`;
}
export function fmtDur(us) {
  const s = Math.round(us / US);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---- lookups
export const tracksTopDown = () => [...S.doc.tracks].reverse();
export const media = (id) => S.doc.media.find((m) => m.id === id);
export function findClip(id) {
  if (!S.doc || !id) return null;
  for (const tr of S.doc.tracks) {
    const clip = tr.clips.find((c) => c.id === id);
    if (clip) return { clip, track: tr };
  }
  return null;
}
export const selected = () => findClip(S.sel);
export function duration() {
  let d = 0;
  for (const tr of S.doc.tracks) for (const c of tr.clips) d = Math.max(d, c.start + c.dur);
  return d;
}
export const clipEnd = (c) => c.start + c.dur;
export function clipKind(c, tr) {
  if (c.text) return 'text';
  const m = media(c.media);
  return m ? m.kind : tr.kind;
}
export function trackLabel(tr) {
  const same = S.doc.tracks.filter((t) => t.kind === tr.kind);
  const idx = same.indexOf(tr) + 1; // bottom up
  if (tr.kind === 'text') return same.length > 1 ? 'Text ' + idx : 'Text';
  if (tr.kind === 'audio') return 'Audio ' + idx;
  return 'Video ' + idx;
}

// ---- undo
let gesture = false;
let gestureSnap = null;
let last = { key: null, t: 0 };
const snapshot = () => JSON.stringify({ tracks: S.doc.tracks, markers: S.doc.markers });
function restore(s) {
  const o = JSON.parse(s);
  S.doc.tracks = o.tracks;
  S.doc.markers = o.markers || [];
  if (S.sel && !findClip(S.sel)) S.sel = null;
}
export function mutate(label, fn, opts = {}) {
  if (!gesture) {
    const now = performance.now();
    if (!(opts.coalesce && last.key === opts.coalesce && now - last.t < 1000)) {
      S.undo.push(snapshot());
      if (S.undo.length > 100) S.undo.shift();
    }
    last = { key: opts.coalesce || null, t: now };
  }
  S.redo.length = 0;
  fn();
  markDirty();
  emit('change', { source: opts.source || 'edit', label });
}
// A gesture (drag, trim) is one undo step however many mutate calls it makes.
export function beginGesture() { gesture = true; gestureSnap = snapshot(); }
export function endGesture() {
  if (!gesture) return;
  gesture = false;
  if (gestureSnap !== snapshot()) {
    S.undo.push(gestureSnap);
    if (S.undo.length > 100) S.undo.shift();
  }
  gestureSnap = null;
  last = { key: null, t: 0 };
}
export function undo() {
  if (!S.undo.length) return;
  S.redo.push(snapshot());
  restore(S.undo.pop());
  last = { key: null, t: 0 };
  markDirty();
  emit('change', { source: 'undo' });
}
export function redo() {
  if (!S.redo.length) return;
  S.undo.push(snapshot());
  restore(S.redo.pop());
  last = { key: null, t: 0 };
  markDirty();
  emit('change', { source: 'undo' });
}

// ---- saving
let saveTimer = null;
export function markDirty() {
  S.dirty = true;
  emit('savestate', 'dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}
export async function saveNow() {
  clearTimeout(saveTimer);
  if (!S.doc || (!S.dirty && !S.saving)) return;
  if (S.saving) { saveTimer = setTimeout(saveNow, 300); return; }
  S.saving = true;
  S.dirty = false;
  emit('savestate', 'saving');
  try {
    await api('project_save', { doc: S.doc });
    emit('savestate', S.dirty ? 'dirty' : 'saved');
  } catch (e) {
    S.dirty = true;
    emit('savestate', 'error');
  } finally {
    S.saving = false;
  }
}

// ---- track and clip helpers
export function trackAcceptsKind(tr, kind) {
  if (tr.kind === 'text') return kind === 'text';
  if (tr.kind === 'audio') return kind === 'audio';
  return kind === 'video' || kind === 'image';
}
export function overlaps(tr, start, dur, exceptId) {
  const end = start + dur;
  return tr.clips.some((c) => c.id !== exceptId && c.start < end && clipEnd(c) > start);
}
export function neighbours(tr, c) {
  let prevEnd = 0, nextStart = Infinity;
  for (const o of tr.clips) {
    if (o.id === c.id) continue;
    if (clipEnd(o) <= c.start + 1) prevEnd = Math.max(prevEnd, clipEnd(o));
    else if (o.start >= clipEnd(c) - 1) nextStart = Math.min(nextStart, o.start);
  }
  return { prevEnd, nextStart };
}
export function defaultAdj() { return { brightness: 0, contrast: 1, saturation: 1, hue: 0, warmth: 0, blur: 0 }; }
export function newClip(m, start) {
  const dur = m.kind === 'image' ? 5 * US : m.dur;
  return {
    id: uid(), media: m.id, start, dur, in: 0, speed: 1, x: 0, y: 0, scale: 1, rot: 0, opacity: 1,
    mirror: false, volume: 1, fade_in: 0, fade_out: 0, adj: defaultAdj(),
  };
}
export function newTextClip(start, preset = {}) {
  return {
    id: uid(), start, dur: 4 * US, in: 0, speed: 1, x: 0, y: preset.y ?? 0, scale: 1, rot: 0, opacity: 1, mirror: false,
    volume: 1, fade_in: 0, fade_out: 0, adj: defaultAdj(),
    text: { content: preset.content || 'Your text', size: preset.size || 0.09, color: preset.color || '#ffffff', bold: preset.bold ?? true, outline: preset.outline ?? true, shadow: !!preset.shadow, boxed: !!preset.boxed },
  };
}

// First track of the right kind with room at `start`, scanning bottom up. Returns {track, start}.
export function placeOn(kind, start, dur, preferTrackId) {
  const cands = S.doc.tracks.filter((t) => trackAcceptsKind(t, kind));
  const ordered = preferTrackId ? [...cands.filter((t) => t.id === preferTrackId), ...cands.filter((t) => t.id !== preferTrackId)] : cands;
  for (const tr of ordered) if (!tr.locked && !overlaps(tr, start, dur)) return { track: tr, start };
  const tr = ordered.find((t) => !t.locked) || ordered[0];
  if (!tr) return null;
  const endOfLast = tr.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  return { track: tr, start: Math.max(start, endOfLast) };
}

export function addClipToTrack(tr, clip) {
  tr.clips.push(clip);
  tr.clips.sort((a, b) => a.start - b.start);
}

export function addMediaClip(m, start, preferTrackId) {
  const probe = newClip(m, 0);
  const spot = placeOn(m.kind, start, probe.dur, preferTrackId);
  if (!spot) return null;
  let created = null;
  mutate('Add clip', () => {
    created = { ...probe, start: spot.start };
    addClipToTrack(spot.track, created);
    S.sel = created.id;
  });
  return created;
}

export function addTextClip(preset, start) {
  const c = newTextClip(start, preset);
  const spot = placeOn('text', start, c.dur);
  if (!spot) return null;
  c.start = spot.start;
  mutate('Add text', () => { addClipToTrack(spot.track, c); S.sel = c.id; });
  return c;
}

export function splitAt(t) {
  const sel = selected();
  const targets = [];
  if (sel && t > sel.clip.start + MIN_DUR / 2 && t < clipEnd(sel.clip) - MIN_DUR / 2) targets.push(sel);
  else if (!sel) {
    for (const tr of S.doc.tracks) {
      if (tr.locked) continue;
      for (const c of tr.clips) if (t > c.start + MIN_DUR / 2 && t < clipEnd(c) - MIN_DUR / 2) targets.push({ clip: c, track: tr });
    }
  }
  if (!targets.length) return false;
  mutate('Split', () => {
    for (const { clip: c, track: tr } of targets) {
      const right = JSON.parse(JSON.stringify(c));
      right.id = uid();
      right.start = t;
      right.dur = clipEnd(c) - t;
      right.in = c.in + Math.round((t - c.start) * c.speed);
      right.transition_in = null;
      right.fade_in = 0;
      c.dur = t - c.start;
      c.fade_out = 0;
      addClipToTrack(tr, right);
      if (S.sel === c.id) S.sel = right.id;
    }
  });
  return true;
}

export function trimSide(side, t) {
  const sel = selected();
  if (!sel) return false;
  const c = sel.clip;
  if (sel.track.locked || !(t > c.start + MIN_DUR / 2 && t < clipEnd(c) - MIN_DUR / 2)) return false;
  mutate(side === 'left' ? 'Delete left' : 'Delete right', () => {
    if (side === 'left') {
      c.in += Math.round((t - c.start) * c.speed);
      c.dur = clipEnd(c) - t;
      c.start = t;
      c.fade_in = 0;
      c.transition_in = null;
    } else {
      c.dur = t - c.start;
      c.fade_out = 0;
    }
  });
  return true;
}

export function deleteClip(id, ripple) {
  const f = findClip(id);
  if (!f || f.track.locked) return false;
  mutate(ripple ? 'Ripple delete' : 'Delete', () => {
    const { clip: c, track: tr } = f;
    tr.clips = tr.clips.filter((x) => x.id !== id);
    if (ripple) for (const o of tr.clips) if (o.start >= clipEnd(c) - 1) o.start -= c.dur;
    if (S.sel === id) S.sel = null;
  });
  return true;
}

export function setSpeed(c, tr, speed) {
  speed = clamp(speed, 0.1, 16);
  const srcSpan = c.dur * c.speed;
  let dur = Math.max(MIN_DUR, Math.round(srcSpan / speed));
  const { nextStart } = neighbours(tr, c);
  if (c.start + dur > nextStart) dur = Math.max(MIN_DUR, nextStart - c.start);
  c.speed = speed;
  c.dur = dur;
}

export function addTrack(kind) {
  const id = 't-' + uid();
  const tr = { id, kind, muted: false, hidden: false, locked: false, clips: [] };
  mutate('Add track', () => {
    const tracks = S.doc.tracks;
    if (kind === 'audio') {
      tracks.unshift(tr); // below everything
    } else {
      // above the top video track, below text
      let idx = tracks.map((t) => t.kind).lastIndexOf('video');
      tracks.splice(idx + 1, 0, tr);
    }
  });
}
export function removeTrack(id) {
  const tr = S.doc.tracks.find((t) => t.id === id);
  if (!tr || tr.clips.length) return false;
  if (S.doc.tracks.filter((t) => t.kind === tr.kind).length < 2) return false;
  mutate('Remove track', () => { S.doc.tracks = S.doc.tracks.filter((t) => t.id !== id); });
  return true;
}
export function toggleTrack(id, key) {
  const tr = S.doc.tracks.find((t) => t.id === id);
  if (tr) mutate('Track ' + key, () => { tr[key] = !tr[key]; });
}

// Snap points: 0, playhead, markers and every clip edge except the clip being moved.
export function snapPoints(exceptId) {
  const pts = [0, S.t];
  for (const m of S.doc.markers || []) pts.push(m.time);
  for (const tr of S.doc.tracks) for (const c of tr.clips) if (c.id !== exceptId) { pts.push(c.start, clipEnd(c)); }
  return pts;
}
export function snapTime(t, exceptId, thresholdUs) {
  if (!S.snap) return { t, hit: null };
  let best = null, bd = thresholdUs;
  for (const p of snapPoints(exceptId)) {
    const d = Math.abs(p - t);
    if (d <= bd) { bd = d; best = p; }
  }
  return best === null ? { t, hit: null } : { t: best, hit: best };
}

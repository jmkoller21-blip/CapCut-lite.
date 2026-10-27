// Timeline: one canvas, redrawn on demand. Only the visible time range is drawn, so hundreds of
// clips stay cheap. Track headers are plain DOM beside it.
import { api, fileUrl } from './api.js';
import { icon } from './icons.js';
import {
  S, US, MIN_DUR, media, tracksTopDown, clipEnd, clipKind, clamp, frameUs, findClip, mutate, beginGesture,
  endGesture, on, emit, duration, trackLabel, trackAcceptsKind, snapTime, neighbours, overlaps, addTrack,
  removeTrack, toggleTrack, splitAt, trimSide, deleteClip, selected,
} from './state.js';
import { seek } from './preview.js';

const RULER = 24;
const TH = 44;
const canvas = document.getElementById('tl-canvas');
const scroller = document.getElementById('tl-scroll');
const spacer = document.getElementById('tl-spacer');
const heads = document.getElementById('tl-heads');
const toolbar = document.getElementById('tl-toolbar');
const ctx = canvas.getContext('2d');
const thumbs = new Map();
const waves = new Map();
let dpr = 1, W = 300, H = 100, viewX = 0, drawQueued = false;
let snapLine = null, ghost = null, drag = null, headSig = '';
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
let C = {};

const xOf = (t) => (t / US) * S.pps - viewX;
const tOf = (x) => ((x + viewX) / S.pps) * US;
const rows = () => tracksTopDown();

export function initTimeline() {
  C = {
    bg: css('--c-bg'), surface: css('--c-surface'), surface2: css('--c-surface-2'), border: css('--c-border'), text: css('--c-text'),
    muted: css('--c-text-muted'), accent: css('--c-accent'), play: css('--c-playhead'), video: css('--c-track-video'),
    audio: css('--c-track-audio'), text_: css('--c-track-text'), warn: css('--c-warning'),
  };
  buildToolbar();
  new ResizeObserver(() => { resize(); }).observe(scroller);
  scroller.addEventListener('scroll', () => { viewX = scroller.scrollLeft; schedule(); });
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', hoverMove);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('dragover', dragOver);
  canvas.addEventListener('dragleave', () => { ghost = null; schedule(); });
  canvas.addEventListener('drop', dropped);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  on('change', () => { resize(); buildHeads(); });
  on('time', () => { followPlayhead(); schedule(); });
  on('select', schedule);
  on('frame', () => {});
}

export function openTimeline() { headSig = ''; viewX = 0; scroller.scrollLeft = 0; thumbs.clear(); waves.clear(); resize(); buildHeads(); }

// ---- sizing
export function resize() {
  if (!S.doc) return;
  dpr = window.devicePixelRatio || 1;
  W = Math.max(200, scroller.clientWidth);
  H = RULER + rows().length * TH;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  spacer.style.width = Math.max(W, (duration() / US) * S.pps + W * 0.6) + 'px';
  viewX = scroller.scrollLeft;
  schedule();
}
function schedule() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}
function followPlayhead() {
  if (!S.playing) return;
  const x = xOf(S.t);
  if (x > W - 30 || x < 0) { scroller.scrollLeft = Math.max(0, (S.t / US) * S.pps - W * 0.2); viewX = scroller.scrollLeft; }
}

// ---- zoom
export function setZoom(pps, anchorX) {
  const ax = anchorX ?? W / 2;
  const tAnchor = tOf(ax);
  S.pps = clamp(pps, 8, 800);
  spacer.style.width = Math.max(W, (duration() / US) * S.pps + W * 0.6) + 'px';
  scroller.scrollLeft = Math.max(0, (tAnchor / US) * S.pps - ax);
  viewX = scroller.scrollLeft;
  schedule();
}
export const zoomBy = (f) => setZoom(S.pps * f);
export function zoomFit() {
  const d = duration();
  if (!d) return;
  setZoom(((W - 40) / (d / US)), 0);
  scroller.scrollLeft = 0;
}
function wheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  setZoom(S.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left);
}

// ---- toolbar and headers
function tb(id, ic, title, fn) {
  const b = document.createElement('button');
  b.className = 'btn icon ghost';
  b.id = id;
  b.title = title;
  b.setAttribute('aria-label', title.replace(/ \(.*\)/, ''));
  b.innerHTML = icon(ic);
  b.addEventListener('click', fn);
  toolbar.appendChild(b);
  return b;
}
const sep = () => { const s = document.createElement('span'); s.style.cssText = 'width:1px;height:16px;background:var(--c-border);margin:0 4px'; toolbar.appendChild(s); };
function buildToolbar() {
  toolbar.innerHTML = '';
  tb('tb-split', 'scissors', 'Split at playhead (S)', () => doSplit());
  tb('tb-dl', 'trimLeft', 'Delete left of playhead (Q)', () => trimSide('left', S.t));
  tb('tb-dr', 'trimRight', 'Delete right of playhead (W)', () => trimSide('right', S.t));
  tb('tb-del', 'trash', 'Delete clip (Delete)', () => S.sel && deleteClip(S.sel, false));
  tb('tb-rip', 'rippleDel', 'Ripple delete: remove and close the gap (Shift+Delete)', () => S.sel && deleteClip(S.sel, true));
  sep();
  const sn = tb('tb-snap', 'magnet', 'Snapping (N)', () => { S.snap = !S.snap; sn.classList.toggle('on', S.snap); });
  sn.classList.toggle('on', S.snap);
  tb('tb-mark', 'flag', 'Add or remove a marker at the playhead (M)', () => toggleMarker());
  sep();
  const v = tb('tb-addv', 'film', 'Add a video track', () => addTrack('video'));
  v.insertAdjacentHTML('beforeend', icon('plus'));
  const a = tb('tb-adda', 'music', 'Add an audio track', () => addTrack('audio'));
  a.insertAdjacentHTML('beforeend', icon('plus'));
  const g = document.createElement('span'); g.className = 'grow'; toolbar.appendChild(g);
  tb('tb-zo', 'zoomOut', 'Zoom out (-)', () => zoomBy(1 / 1.3));
  tb('tb-zi', 'zoomIn', 'Zoom in (+)', () => zoomBy(1.3));
  const fit = document.createElement('button');
  fit.className = 'btn sm ghost'; fit.textContent = 'Fit'; fit.title = 'Fit the whole project in view'; fit.addEventListener('click', zoomFit);
  toolbar.appendChild(fit);
}
export function doSplit() {
  if (!splitAt(S.t)) emit('toast', { text: 'Move the playhead over a clip to split it.' });
}
export function toggleMarker() {
  const near = (S.doc.markers || []).find((m) => Math.abs(m.time - S.t) < frameUs());
  mutate('Marker', () => {
    S.doc.markers = S.doc.markers || [];
    if (near) S.doc.markers = S.doc.markers.filter((m) => m !== near);
    else S.doc.markers.push({ id: Math.random().toString(36).slice(2, 8), time: S.t, label: '' });
  });
}

function buildHeads() {
  const sig = rows().map((t) => t.id + (t.muted ? 'm' : '') + (t.hidden ? 'h' : '') + (t.locked ? 'l' : '') + t.clips.length).join('|');
  if (sig === headSig) return;
  headSig = sig;
  heads.innerHTML = '';
  for (const tr of rows()) {
    const d = document.createElement('div');
    d.className = 'head';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = trackLabel(tr);
    d.appendChild(nm);
    const mk = (key, on_, off, label) => {
      const b = document.createElement('button');
      b.className = 'btn icon' + (tr[key] ? ' on' : '');
      b.innerHTML = icon(tr[key] ? on_ : off);
      b.title = label;
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-pressed', String(!!tr[key]));
      b.addEventListener('click', () => toggleTrack(tr.id, key));
      d.appendChild(b);
    };
    if (tr.kind !== 'audio') mk('hidden', 'eyeOff', 'eye', tr.hidden ? 'Show track' : 'Hide track');
    if (tr.kind !== 'text') mk('muted', 'volumeOff', 'volume', tr.muted ? 'Unmute track' : 'Mute track');
    mk('locked', 'lock', 'unlock', tr.locked ? 'Unlock track' : 'Lock track');
    if (!tr.clips.length && S.doc.tracks.filter((t) => t.kind === tr.kind).length > 1) {
      const b = document.createElement('button');
      b.className = 'btn icon'; b.innerHTML = icon('x'); b.title = 'Remove empty track'; b.setAttribute('aria-label', 'Remove empty track');
      b.addEventListener('click', () => removeTrack(tr.id));
      d.appendChild(b);
    }
    heads.appendChild(d);
  }
}

// ---- drawing
function thumbFor(m) {
  if (!m || m.kind === 'audio' || !S.sys) return null;
  let t = thumbs.get(m.id);
  if (t === undefined) {
    t = new Image();
    t.onload = schedule;
    t.onerror = () => thumbs.set(m.id, null);
    t.src = fileUrl(S.sys.data_dir + '/cache/thumbs/' + m.id + '.jpg');
    thumbs.set(m.id, t);
  }
  return t && t.complete && t.naturalWidth ? t : null;
}
function waveFor(m) {
  if (!m || m.kind !== 'audio') return null;
  const w = waves.get(m.id);
  if (w === undefined) {
    waves.set(m.id, 'loading');
    api('waveform', { id: m.id, path: m.path }).then((j) => { waves.set(m.id, j); schedule(); }).catch(() => waves.set(m.id, null));
    return null;
  }
  return w && w !== 'loading' ? w : null;
}
function ticks() {
  const steps = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  const step = steps.find((s) => s * S.pps >= 80) || 1800;
  ctx.fillStyle = C.surface;
  ctx.fillRect(0, 0, W, RULER);
  ctx.strokeStyle = C.border;
  ctx.fillStyle = C.muted;
  ctx.font = '10px ' + css('--font-mono');
  ctx.textBaseline = 'middle';
  const t0 = Math.floor(tOf(0) / US / step) * step;
  for (let s = t0; s * S.pps - viewX < W + 60; s += step) {
    const x = Math.round(s * S.pps - viewX) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, RULER - 9); ctx.lineTo(x, RULER); ctx.stroke();
    const m = Math.floor(s / 60), sec = s - m * 60;
    ctx.fillText(`${m}:${(sec < 10 ? '0' : '') + (step < 1 ? sec.toFixed(2) : Math.round(sec))}`, x + 4, 9);
    if (step >= 1) for (let k = 1; k < 5; k++) { const mx = Math.round((s + (step * k) / 5) * S.pps - viewX) + 0.5; ctx.beginPath(); ctx.moveTo(mx, RULER - 4); ctx.lineTo(mx, RULER); ctx.stroke(); }
  }
}
function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawClip(c, tr, y) {
  const x0 = xOf(c.start), x1 = xOf(clipEnd(c));
  if (x1 < -4 || x0 > W + 4) return;
  const kind = clipKind(c, tr);
  const m = media(c.media);
  const w = Math.max(2, x1 - x0);
  const top = y + 2, h = TH - 4;
  ctx.save();
  rr(x0, top, w, h, 4);
  ctx.clip();
  ctx.fillStyle = kind === 'audio' ? C.audio : kind === 'text' ? C.text_ : C.video;
  ctx.globalAlpha = tr.muted && kind === 'audio' ? 0.45 : 1;
  ctx.fillRect(x0, top, w, h);
  ctx.globalAlpha = 1;
  const th = kind === 'video' || kind === 'image' ? thumbFor(m) : null;
  if (th) {
    const tw = (th.naturalWidth / th.naturalHeight) * h;
    for (let px = x0; px < x1 && px < W; px += tw) { if (px + tw > 0) ctx.drawImage(th, px, top, tw, h); }
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(x0, top, w, h);
  }
  const wv = waveFor(m);
  if (wv && wv.peaks) {
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    const mid = top + h / 2;
    for (let px = Math.max(0, Math.floor(x0)); px < Math.min(W, x1); px += 2) {
      const tUs = tOf(px + viewX * 0 ) - c.start; // time from clip start at this pixel
      const srcMs = (c.in + tUs * c.speed) / 1000;
      const i = Math.floor(srcMs / wv.bucket_ms);
      const p = (wv.peaks[i] || 0) / 255;
      const bh = Math.max(1, p * (h - 8));
      ctx.fillRect(px, mid - bh / 2, 1.5, bh);
    }
  }
  if (m && m.missing) {
    ctx.fillStyle = 'rgba(255,128,128,.35)';
    ctx.fillRect(x0, top, w, h);
  }
  ctx.restore();
  // label
  ctx.save();
  rr(x0, top, w, h, 4); ctx.clip();
  ctx.fillStyle = '#fff';
  ctx.font = '500 11px ' + css('--font-sans');
  ctx.textBaseline = 'top';
  const label = (c.text ? c.text.content.replace(/\s+/g, ' ') : m ? m.name : '') + (c.speed !== 1 ? `  ${c.speed}×` : '');
  ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 2;
  ctx.fillText(label, Math.max(x0, 0) + 6, top + 4);
  ctx.restore();
  if (c.transition_in) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(x0 + 1, top + h - 1); ctx.lineTo(x0 + 12, top + h - 1); ctx.lineTo(x0 + 1, top + h - 12); ctx.closePath(); ctx.fill(); }
  if (tr.locked) {
    ctx.save(); rr(x0, top, w, h, 4); ctx.clip();
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    for (let k = -h; k < w; k += 8) { ctx.beginPath(); ctx.moveTo(x0 + k, top + h); ctx.lineTo(x0 + k + h, top); ctx.stroke(); }
    ctx.restore();
  }
  if (c.id === S.sel) {
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
    rr(x0 + 1, top + 1, Math.max(1, w - 2), h - 2, 4); ctx.stroke();
    ctx.lineWidth = 1; ctx.fillStyle = C.accent;
    ctx.fillRect(x0 + 2, top + h / 2 - 7, 3, 14); ctx.fillRect(x1 - 5, top + h / 2 - 7, 3, 14);
  }
}
function draw() {
  if (!S.doc) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const rs = rows();
  rs.forEach((tr, i) => {
    const y = RULER + i * TH;
    ctx.fillStyle = i % 2 ? C.bg : '#171a1f';
    ctx.fillRect(0, y, W, TH);
    ctx.fillStyle = C.border;
    ctx.fillRect(0, y + TH - 1, W, 1);
    for (const c of tr.clips) drawClip(c, tr, y);
  });
  if (ghost) {
    ctx.fillStyle = 'rgba(134,160,255,.25)';
    ctx.strokeStyle = C.accent;
    const gx = xOf(ghost.t), gw = Math.max(20, (ghost.dur / US) * S.pps);
    ctx.fillRect(gx, RULER + ghost.row * TH + 2, gw, TH - 4);
    ctx.strokeRect(gx + 0.5, RULER + ghost.row * TH + 2.5, gw - 1, TH - 5);
  }
  ticks();
  for (const mk of S.doc.markers || []) {
    const x = xOf(mk.time);
    if (x < -8 || x > W + 8) continue;
    ctx.fillStyle = C.warn;
    ctx.beginPath(); ctx.moveTo(x, RULER - 14); ctx.lineTo(x + 8, RULER - 10); ctx.lineTo(x, RULER - 6); ctx.closePath(); ctx.fill();
    ctx.fillRect(x - 0.5, RULER - 14, 1, H - RULER + 14);
  }
  if (snapLine !== null) { const x = xOf(snapLine); ctx.fillStyle = C.warn; ctx.fillRect(Math.round(x), 0, 1, H); }
  const px = Math.round(xOf(S.t)) + 0.5;
  if (px >= -6 && px <= W + 6) {
    ctx.strokeStyle = C.play; ctx.fillStyle = C.play; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 9); ctx.closePath(); ctx.fill();
  }
}

// ---- hit testing and pointer interaction
function hit(px, py) {
  if (py < RULER) return { type: 'ruler' };
  const row = Math.floor((py - RULER) / TH);
  const tr = rows()[row];
  if (!tr) return { type: 'empty', row };
  for (let i = tr.clips.length - 1; i >= 0; i--) {
    const c = tr.clips[i];
    const x0 = xOf(c.start), x1 = xOf(clipEnd(c));
    if (px >= x0 - 1 && px <= x1 + 1) {
      const hw = Math.min(9, (x1 - x0) / 3);
      const type = px - x0 <= hw ? 'trimL' : x1 - px <= hw ? 'trimR' : 'body';
      return { type, clip: c, track: tr, row };
    }
  }
  return { type: 'empty', track: tr, row };
}
function pos(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function hoverMove(e) {
  if (drag) return;
  const { x, y } = pos(e);
  const h = hit(x, y);
  canvas.style.cursor = h.type === 'trimL' || h.type === 'trimR' ? 'ew-resize' : h.type === 'body' ? 'grab' : h.type === 'ruler' ? 'pointer' : 'default';
}
const thresholdUs = () => (8 / S.pps) * US;
const frameRound = (t) => Math.round(t / frameUs()) * frameUs();

function gapClamp(tr, id, start, dur) {
  const others = tr.clips.filter((c) => c.id !== id).sort((a, b) => a.start - b.start);
  const gaps = [];
  let cur = 0;
  for (const o of others) { if (o.start - cur >= dur) gaps.push([cur, o.start]); cur = Math.max(cur, clipEnd(o)); }
  gaps.push([cur, Infinity]);
  let best = null, bd = Infinity;
  for (const [a, b] of gaps) {
    const s = clamp(start, a, b - dur);
    const d = Math.abs(s - start);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

function pointerDown(e) {
  if (e.button !== 0 && e.button !== 2) return;
  const { x, y } = pos(e);
  const h = hit(x, y);
  canvas.setPointerCapture(e.pointerId);
  if (S.playing) emit('pauseRequest');
  if (h.type === 'ruler') {
    drag = { mode: 'scrub' };
    seek(frameRound(Math.max(0, tOf(x))));
  } else if (h.type === 'empty') {
    S.sel = null; emit('select');
    drag = { mode: 'scrub' };
    seek(frameRound(Math.max(0, tOf(x))));
  } else {
    S.sel = h.clip.id; emit('select');
    if (h.track.locked || e.button === 2) { drag = null; return; }
    const c = h.clip;
    drag = { mode: h.type === 'body' ? 'move' : h.type, id: c.id, grab: tOf(x) - c.start, startX: x, trackId: h.track.id, moved: false };
    beginGesture();
  }
  schedule();
  canvas.addEventListener('pointermove', dragMove);
  canvas.addEventListener('pointerup', dragEnd);
  canvas.addEventListener('pointercancel', dragEnd);
}

function dragMove(e) {
  if (!drag) return;
  const { x, y } = pos(e);
  if (drag.mode === 'scrub') { seek(frameRound(Math.max(0, tOf(x)))); return; }
  const f = findClip(drag.id);
  if (!f) return;
  if (!drag.moved && Math.abs(x - drag.startX) < 3 && drag.mode !== 'move') return;
  drag.moved = true;
  const c = f.clip;
  snapLine = null;
  if (drag.mode === 'move') {
    let ns = tOf(x) - drag.grab;
    const a = snapTime(ns, c.id, thresholdUs());
    const b = snapTime(ns + c.dur, c.id, thresholdUs());
    if (a.hit !== null && (b.hit === null || Math.abs(a.t - ns) <= Math.abs(b.t - ns - c.dur))) { ns = a.t; snapLine = a.hit; }
    else if (b.hit !== null) { ns = b.t - c.dur; snapLine = b.hit; }
    ns = Math.max(0, ns);
    let target = f.track;
    const row = Math.floor((y - RULER) / TH);
    const rt = rows()[clamp(row, 0, rows().length - 1)];
    if (rt && !rt.locked && trackAcceptsKind(rt, clipKind(c, f.track))) target = rt;
    const placed = gapClamp(target, c.id, ns, c.dur);
    if (placed !== null) {
      if (placed !== ns) snapLine = null;
      mutate('Move clip', () => {
        if (target !== f.track) {
          f.track.clips = f.track.clips.filter((k) => k.id !== c.id);
          target.clips.push(c);
        }
        c.start = Math.round(placed);
        target.clips.sort((p, q) => p.start - q.start);
      });
    }
  } else if (drag.mode === 'trimL') {
    const m = media(c.media);
    const { prevEnd } = neighbours(f.track, c);
    let ns = snapOne(tOf(x), c.id);
    const srcLimit = m && m.kind !== 'image' && !c.text ? c.start - c.in / c.speed : 0;
    ns = clamp(ns, Math.max(prevEnd, srcLimit), clipEnd(c) - MIN_DUR);
    mutate('Trim start', () => {
      const d = ns - c.start;
      if (m && m.kind !== 'image' && !c.text) c.in = Math.max(0, c.in + Math.round(d * c.speed));
      c.dur = clipEnd(c) - ns;
      c.start = Math.round(ns);
    });
  } else if (drag.mode === 'trimR') {
    const m = media(c.media);
    const { nextStart } = neighbours(f.track, c);
    let ne = snapOne(tOf(x), c.id);
    const srcMax = m && m.kind !== 'image' && !c.text ? c.start + (m.dur - c.in) / c.speed : Infinity;
    ne = clamp(ne, c.start + MIN_DUR, Math.min(nextStart, srcMax));
    mutate('Trim end', () => { c.dur = Math.round(ne - c.start); });
  }
  schedule();
}
function snapOne(t, id) {
  const r = snapTime(t, id, thresholdUs());
  snapLine = r.hit;
  return r.t;
}
function dragEnd() {
  canvas.removeEventListener('pointermove', dragMove);
  canvas.removeEventListener('pointerup', dragEnd);
  canvas.removeEventListener('pointercancel', dragEnd);
  if (drag && drag.mode !== 'scrub') endGesture();
  drag = null;
  snapLine = null;
  schedule();
}

// ---- drag and drop from the panels
function dragOver(e) {
  if (!e.dataTransfer.types.includes('application/x-lite')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const { x, y } = pos(e);
  const row = clamp(Math.floor((y - RULER) / TH), 0, rows().length - 1);
  ghost = { row, t: Math.max(0, snapTime(tOf(x), null, thresholdUs()).t), dur: (S.dragDur || 4 * US) };
  schedule();
}
function dropped(e) {
  const raw = e.dataTransfer.getData('application/x-lite');
  ghost = null;
  schedule();
  if (!raw) return;
  e.preventDefault();
  const { x, y } = pos(e);
  const row = clamp(Math.floor((y - RULER) / TH), 0, rows().length - 1);
  const tr = rows()[row];
  emit('tldrop', { data: JSON.parse(raw), t: Math.max(0, snapTime(tOf(x), null, thresholdUs()).t), trackId: tr && tr.id });
}

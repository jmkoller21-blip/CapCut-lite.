// Preview stage and playback. Uses the browser's own video decoder on the proxy copies the engine
// makes, so it stays light. Geometry follows the export: each clip is fitted inside the frame, then
// scaled and moved around the frame centre. Media elements exist only near the playhead.
import { fileUrl } from './api.js';
import {
  S, US, media, clipEnd, selected, findClip, clamp, mutate, beginGesture, endGesture, on, emit,
  duration, clipKind, frameUs,
} from './state.js';

const stage = document.getElementById('stage');
const wrap = document.getElementById('stagewrap');
const hint = document.getElementById('stage-hint');
const entries = new Map(); // clip id -> entry
let K = 1; // stage pixels per project pixel
let selbox = null;
let msg = null;
let raf = 0;
let lastTs = 0;

export const getK = () => K;

function mkSelbox() {
  selbox = document.createElement('div');
  selbox.id = 'selbox';
  selbox.style.zIndex = '1000';
  selbox.innerHTML = '<div class="h" title="Drag to resize"></div>';
  stage.appendChild(selbox);
  msg = document.createElement('div');
  msg.className = 'overlay-msg';
  msg.style.zIndex = '1001';
  msg.hidden = true;
  stage.appendChild(msg);
}

export function initPreview() {
  mkSelbox();
  new ResizeObserver(layoutStage).observe(wrap);
  on('change', (d) => {
    if (d.source === 'stage') { render(true); return; }
    layoutStage();
  });
  stage.addEventListener('pointerdown', stagePointerDown);
  selbox.addEventListener('pointerdown', selboxDown);
  selbox.querySelector('.h').addEventListener('pointerdown', handleDown);
}

export function layoutStage() {
  if (!S.doc || !wrap.clientWidth) return;
  const aw = wrap.clientWidth - 32;
  const ah = wrap.clientHeight - 32;
  const ar = S.doc.width / S.doc.height;
  let w = aw;
  let h = aw / ar;
  if (h > ah) { h = ah; w = ah * ar; }
  w = Math.max(80, Math.floor(w));
  h = Math.max(45, Math.floor(h));
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  K = w / S.doc.width;
  render(true);
}

const srcFor = (m) => fileUrl(m.proxy || m.path);

function activeAt(t) {
  const act = [];
  const soon = [];
  S.doc.tracks.forEach((tr, ti) => {
    tr.clips.forEach((c, ci) => {
      const n = tr.clips[ci + 1];
      let tail = 0;
      if (tr.kind === 'video' && n && Math.abs(n.start - clipEnd(c)) < 2000 && n.transition_in) tail = Math.min(n.transition_in.dur, n.dur);
      if (t >= c.start && t < clipEnd(c)) act.push({ c, tr, ti, frozen: false });
      else if (tail && t >= clipEnd(c) && t < clipEnd(c) + tail) act.push({ c, tr, ti, frozen: true });
      else if (c.start > t && c.start < t + 1.5 * US) soon.push({ c, tr, ti });
    });
  });
  return { act, soon };
}

function ensure(c, tr, ti) {
  let e = entries.get(c.id);
  if (e) { e.clip = c; e.track = tr; return e; }
  const kind = clipKind(c, tr);
  e = { id: c.id, kind, clip: c, track: tr, src: '', failed: false, pendingT: 0, lastSeek: -1 };
  if (kind === 'audio') {
    e.el = new Audio();
    e.el.preload = 'auto';
  } else {
    const layer = document.createElement('div');
    layer.className = 'layer' + (kind === 'text' ? ' text' : '');
    layer.style.zIndex = String(ti + 1);
    layer.style.display = 'none';
    e.layer = layer;
    if (kind === 'text') {
      e.span = document.createElement('span');
      layer.appendChild(e.span);
    } else if (kind === 'image') {
      e.el = document.createElement('img');
      e.el.alt = '';
      layer.appendChild(e.el);
    } else {
      e.el = document.createElement('video');
      e.el.playsInline = true;
      e.el.preload = 'auto';
      e.el.muted = false;
      layer.appendChild(e.el);
    }
    stage.insertBefore(layer, selbox);
  }
  if (e.el && (kind === 'video' || kind === 'audio')) {
    e.el.addEventListener('loadedmetadata', () => { if (e.pendingT > 0) e.el.currentTime = e.pendingT; });
    e.el.addEventListener('error', () => { e.failed = true; updateMessage(); });
  } else if (e.el && kind === 'image') {
    e.el.addEventListener('error', () => { e.failed = true; updateMessage(); });
  }
  entries.set(c.id, e);
  return e;
}

function drop(e) {
  if (e.el) {
    if (e.el.pause) e.el.pause();
    e.el.removeAttribute('src');
    if (e.el.load) e.el.load();
  }
  if (e.layer) e.layer.remove();
  entries.delete(e.id);
}

export function clearPreview() {
  for (const e of [...entries.values()]) drop(e);
  if (msg) msg.hidden = true;
}

function cssFilter(a, k) {
  if (!a) return '';
  const f = [];
  if (Math.abs(a.brightness || 0) > 0.001) f.push(`brightness(${(1 + a.brightness).toFixed(3)})`);
  if (Math.abs((a.contrast ?? 1) - 1) > 0.001) f.push(`contrast(${a.contrast})`);
  if (Math.abs((a.saturation ?? 1) - 1) > 0.001) f.push(`saturate(${a.saturation})`);
  if (Math.abs(a.hue || 0) > 0.01) f.push(`hue-rotate(${a.hue}deg)`);
  if ((a.warmth || 0) > 0.01) f.push(`sepia(${(a.warmth * 0.35).toFixed(3)})`);
  if ((a.warmth || 0) < -0.01) f.push(`hue-rotate(${(a.warmth * 14).toFixed(1)}deg)`);
  if ((a.blur || 0) >= 0.5) f.push(`blur(${(a.blur * k).toFixed(2)}px)`);
  return f.join(' ');
}

function applyVisual(e, c, t, frozen) {
  let x = c.x * K, y = c.y * K, sc = c.scale, op = c.opacity;
  const tr = c.transition_in;
  if (tr && !frozen && e.kind !== 'text') {
    const d = Math.max(1, Math.min(tr.dur, c.dur));
    const p = clamp((t - c.start) / d, 0, 1);
    if (p < 1) {
      switch (tr.kind) {
        case 'dissolve': op *= p; break;
        case 'zoom': op *= p; sc *= 0.5 + 0.5 * p; break;
        case 'slide-left': x += S.doc.width * K * (1 - p); break;
        case 'slide-right': x -= S.doc.width * K * (1 - p); break;
        case 'slide-up': y += S.doc.height * K * (1 - p); break;
        default: break;
      }
    }
  }
  e.layer.style.transform = `translate(${x}px,${y}px) rotate(${c.rot}deg) scale(${sc}) ${c.mirror ? 'scaleX(-1)' : ''}`;
  e.layer.style.opacity = String(op);
  e.layer.style.display = e.track.hidden ? 'none' : '';
  if (e.kind === 'text') {
    const tx = c.text;
    const px = Math.max(8, tx.size * S.doc.height) * K;
    const s = e.span;
    if (s.textContent !== tx.content) s.textContent = tx.content;
    s.style.fontSize = px + 'px';
    s.style.color = tx.color;
    s.style.fontWeight = tx.bold ? '700' : '400';
    const shadows = [];
    if (tx.outline) {
      const b = Math.max(1, px / 16);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [.7, .7], [-.7, .7], [.7, -.7], [-.7, -.7]]) shadows.push(`${(dx * b).toFixed(2)}px ${(dy * b).toFixed(2)}px 0 #000`);
    }
    if (tx.shadow) { const d = Math.max(1, px / 18); shadows.push(`${d}px ${d}px 0 rgba(0,0,0,.7)`); }
    s.style.textShadow = shadows.join(',');
    s.style.background = tx.boxed ? 'rgba(0,0,0,.55)' : 'none';
    s.style.padding = tx.boxed ? `${px / 4}px` : '0';
  } else {
    e.el.style.filter = cssFilter(c.adj, K);
  }
}

function syncMedia(e, c, t, playing, frozen) {
  const m = media(c.media);
  if (!m || !e.el) return;
  const want = srcFor(m);
  if (e.src !== want) {
    e.src = want;
    e.failed = false;
    e.el.src = want;
    e.lastSeek = -1;
  }
  if (e.kind === 'image') return;
  const el = e.el;
  const rate = clamp(c.speed, 0.0625, 16);
  if (el.playbackRate !== rate) el.playbackRate = rate;
  const srcT = frozen ? Math.max(0, (c.in + c.dur * c.speed) / US - 0.05) : Math.max(0, (c.in + (t - c.start) * c.speed) / US);
  const fs = frameUs() / US;
  if (frozen || !playing) {
    if (!el.paused) el.pause();
    if (el.readyState < 1) { e.pendingT = srcT; }
    else if (Math.abs(el.currentTime - srcT) > fs * 0.6 && Math.abs(e.lastSeek - srcT) > 0.001) { el.currentTime = srcT; e.lastSeek = srcT; }
  } else if (el.paused) {
    if (el.readyState < 1) e.pendingT = srcT; else el.currentTime = srcT;
    el.play().catch(() => {});
  } else if (el.readyState >= 1 && Math.abs(el.currentTime - srcT) > 0.35) {
    el.currentTime = srcT;
  }
  // volume with fades
  const fi = c.fade_in > 0 ? clamp((t - c.start) / c.fade_in, 0, 1) : 1;
  const fo = c.fade_out > 0 ? clamp((clipEnd(c) - t) / c.fade_out, 0, 1) : 1;
  el.volume = clamp(c.volume * Math.min(fi, fo), 0, 1);
  el.muted = !!e.track.muted || frozen || !m.has_audio;
}

function updateMessage() {
  const bad = [...entries.values()].filter((e) => e.failed && e.layer && e.layer.style.display !== 'none');
  if (!bad.length) { msg.hidden = true; return; }
  const m = media(bad[0].clip.media);
  msg.hidden = false;
  msg.textContent = m && m.proxy_job ? 'Preparing a smooth preview…' : 'This file cannot be previewed here. Export will still include it.';
}

export function render(force) {
  if (!S.doc) return;
  const t = S.t;
  const { act, soon } = activeAt(t);
  const keep = new Set();
  for (const { c, tr, ti, frozen } of act) {
    keep.add(c.id);
    const e = ensure(c, tr, ti);
    e.frozen = frozen;
    if (e.layer) e.layer.style.zIndex = String(ti + 1);
    if (e.kind === 'audio') {
      if (!e.src || e.src !== srcFor(media(c.media) || { path: '' })) syncMedia(e, c, t, S.playing, false);
      else syncMedia(e, c, t, S.playing, false);
    } else {
      if (e.kind !== 'text') syncMedia(e, c, t, S.playing, frozen);
      applyVisual(e, c, t, frozen);
    }
  }
  for (const { c, tr, ti } of soon) {
    const kind = clipKind(c, tr);
    if (kind !== 'video' && kind !== 'audio') continue;
    keep.add(c.id);
    const e = ensure(c, tr, ti);
    if (e.layer) e.layer.style.display = 'none';
    const m = media(c.media);
    if (m && e.src !== srcFor(m)) { e.src = srcFor(m); e.el.src = e.src; e.pendingT = c.in / US; e.failed = false; }
    if (e.el && !e.el.paused) e.el.pause();
  }
  for (const e of [...entries.values()]) if (!keep.has(e.id)) drop(e);
  hint.textContent = duration() === 0 ? 'Add media from the left to begin' : '';
  updateMessage();
  updateSel(act);
  emit('frame', t);
}

// ---- selection box and direct manipulation on the stage
function geom(e, c) {
  const W = S.doc.width, H = S.doc.height;
  let w, h;
  if (e.kind === 'text') {
    w = e.span.offsetWidth; h = e.span.offsetHeight;
  } else {
    const m = media(c.media);
    const mw = (m && m.w) || W, mh = (m && m.h) || H;
    const s = Math.min(W / mw, H / mh);
    w = mw * s * K * c.scale; h = mh * s * K * c.scale;
  }
  const cx = stage.clientWidth / 2 + c.x * K;
  const cy = stage.clientHeight / 2 + c.y * K;
  return { w, h, cx, cy };
}

function updateSel(act) {
  const f = selected();
  const a = f && act.find((x) => x.c.id === f.clip.id && !x.frozen);
  const e = a && entries.get(f.clip.id);
  if (!a || !e || e.kind === 'audio' || f.track.hidden) { selbox.style.display = 'none'; return; }
  const g = geom(e, f.clip);
  selbox.style.display = 'block';
  selbox.classList.toggle('hasmove', !f.track.locked);
  selbox.style.width = g.w + 'px';
  selbox.style.height = g.h + 'px';
  selbox.style.left = g.cx - g.w / 2 + 'px';
  selbox.style.top = g.cy - g.h / 2 + 'px';
  selbox.style.transform = `rotate(${f.clip.rot}deg)`;
}

function stagePointerDown(ev) {
  if (ev.target.closest('#selbox')) return;
  const r = stage.getBoundingClientRect();
  const px = ev.clientX - r.left, py = ev.clientY - r.top;
  const { act } = activeAt(S.t);
  const vis = act.filter((a) => !a.frozen && !a.tr.hidden && clipKind(a.c, a.tr) !== 'audio').sort((a, b) => b.ti - a.ti);
  for (const a of vis) {
    const e = entries.get(a.c.id);
    if (!e) continue;
    const g = geom(e, a.c);
    if (Math.abs(px - g.cx) <= g.w / 2 && Math.abs(py - g.cy) <= g.h / 2) {
      S.sel = a.c.id;
      emit('select');
      render();
      return;
    }
  }
  S.sel = null;
  emit('select');
  render();
}

function selboxDown(ev) {
  if (ev.target.classList.contains('h')) return;
  const f = selected();
  if (!f || f.track.locked) return;
  ev.preventDefault();
  selbox.setPointerCapture(ev.pointerId);
  const sx = ev.clientX, sy = ev.clientY, ox = f.clip.x, oy = f.clip.y;
  beginGesture();
  const move = (e2) => {
    mutate('Move', () => {
      f.clip.x = Math.round(ox + (e2.clientX - sx) / K);
      f.clip.y = Math.round(oy + (e2.clientY - sy) / K);
    }, { source: 'stage' });
    emit('propsrefresh');
  };
  const up = () => {
    selbox.removeEventListener('pointermove', move);
    selbox.removeEventListener('pointerup', up);
    endGesture();
    emit('propsrefresh');
  };
  selbox.addEventListener('pointermove', move);
  selbox.addEventListener('pointerup', up);
}

function handleDown(ev) {
  const f = selected();
  if (!f || f.track.locked) return;
  ev.preventDefault();
  ev.stopPropagation();
  const h = ev.currentTarget;
  h.setPointerCapture(ev.pointerId);
  const r = stage.getBoundingClientRect();
  const cx = r.left + stage.clientWidth / 2 + f.clip.x * K;
  const cy = r.top + stage.clientHeight / 2 + f.clip.y * K;
  const d0 = Math.max(8, Math.hypot(ev.clientX - cx, ev.clientY - cy));
  const s0 = f.clip.scale;
  beginGesture();
  const move = (e2) => {
    const d = Math.hypot(e2.clientX - cx, e2.clientY - cy);
    mutate('Resize', () => { f.clip.scale = clamp(Math.round((s0 * d / d0) * 100) / 100, 0.05, 10); }, { source: 'stage' });
    emit('propsrefresh');
  };
  const up = () => {
    h.removeEventListener('pointermove', move);
    h.removeEventListener('pointerup', up);
    endGesture();
    emit('propsrefresh');
  };
  h.addEventListener('pointermove', move);
  h.addEventListener('pointerup', up);
}

// ---- transport
export function seek(t) {
  S.t = clamp(Math.round(t), 0, Math.max(duration(), 0) + 60 * US);
  render();
  emit('time');
}
export function stepFrames(n) {
  if (S.playing) pause();
  seek(S.t + n * frameUs());
}
function tick(ts) {
  if (!S.playing) return;
  const dt = Math.min(100000, (ts - lastTs) * 1000);
  lastTs = ts;
  const end = duration();
  S.t = Math.min(S.t + dt, end);
  render();
  emit('time');
  if (S.t >= end) pause();
  else raf = requestAnimationFrame(tick);
}
export function play() {
  if (S.playing || !S.doc) return;
  const end = duration();
  if (!end) return;
  if (S.t >= end - 1000) S.t = 0;
  S.playing = true;
  lastTs = performance.now();
  raf = requestAnimationFrame(tick);
  emit('playstate');
}
export function pause() {
  const was = S.playing;
  S.playing = false;
  cancelAnimationFrame(raf);
  render();
  if (was) emit('playstate');
}
export function togglePlay() { if (S.playing) pause(); else play(); }

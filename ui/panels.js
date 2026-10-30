// Left-hand tool panels: media, stock, text, transitions, filters, audio. Items can be clicked
// (added at the playhead or applied to the selected clip) or dragged onto the timeline.
import { api, fileUrl, upload } from './api.js';
import { icon } from './icons.js';
import {
  S, US, on, emit, mutate, media, addMediaClip, addTextClip, selected, clipKind, fmtDur, defaultAdj, newTextClip, uid, clipEnd,
  addClipToTrack, overlaps,
} from './state.js';
import { h, toast, pickFiles } from './ui.js';
import { importPaths } from './library.js';
import { TRANSITIONS } from './props.js';

const TABS = [
  { id: 'media', label: 'Media', icon: 'film' },
  { id: 'stock', label: 'Stock', icon: 'box' },
  { id: 'text', label: 'Text', icon: 'type' },
  { id: 'trans', label: 'Transitions', icon: 'layers' },
  { id: 'filters', label: 'Filters', icon: 'sparkle' },
  { id: 'audio', label: 'Audio', icon: 'music' },
];
let tab = 'media';
let stock = null;
let stockCat = 'All';
let previewAudio = null;

export const FILTERS = [
  { id: 'none', label: 'Original', adj: {} },
  { id: 'vivid', label: 'Vivid', adj: { saturation: 1.5, contrast: 1.1 } },
  { id: 'mono', label: 'Mono', adj: { saturation: 0, contrast: 1.12 } },
  { id: 'warm', label: 'Warm', adj: { warmth: 0.55, saturation: 1.1 } },
  { id: 'cool', label: 'Cool', adj: { warmth: -0.55, saturation: 1.05 } },
  { id: 'fade', label: 'Faded', adj: { contrast: 0.85, brightness: 0.05, saturation: 0.75 } },
  { id: 'vintage', label: 'Vintage', adj: { saturation: 0.7, warmth: 0.4, contrast: 0.92, brightness: 0.03 } },
  { id: 'drama', label: 'Dramatic', adj: { contrast: 1.35, saturation: 0.85, brightness: -0.05 } },
  { id: 'soft', label: 'Soft focus', adj: { blur: 3, brightness: 0.03 } },
];

const TEXT_PRESETS = (H) => [
  { name: 'Title', sample: 'Your title', preset: { content: 'Your title', size: 0.12, bold: true, outline: true, y: 0 }, css: 'font-size:20px;font-weight:700' },
  { name: 'Subtitle', sample: 'A line of subtitle text', preset: { content: 'Subtitle goes here', size: 0.055, bold: true, outline: true, y: Math.round(H * 0.36) }, css: 'font-size:14px;font-weight:600' },
  { name: 'Lower third', sample: 'Name  ·  Role', preset: { content: 'Name · Role', size: 0.05, bold: true, outline: false, boxed: true, y: Math.round(H * 0.33) }, css: 'font-size:14px;background:#000;padding:1px 6px;display:inline-block' },
  { name: 'Caption', sample: 'Caption text', preset: { content: 'Caption text', size: 0.045, bold: false, outline: false, boxed: true, y: Math.round(H * 0.4) }, css: 'font-size:12px;background:#000;padding:1px 6px;display:inline-block' },
  { name: 'Big idea', sample: 'BIG IDEA', preset: { content: 'BIG IDEA', size: 0.17, color: '#ffd84a', bold: true, outline: true, shadow: true, y: 0 }, css: 'font-size:22px;font-weight:800;color:#ffd84a' },
];

const body = () => document.getElementById('left-body');
const dragData = (e, data, dur) => {
  e.dataTransfer.setData('application/x-lite', JSON.stringify(data));
  e.dataTransfer.effectAllowed = 'copy';
  S.dragDur = dur || 4 * US;
};
const thumbUrl = (m) => (S.sys && m.thumb !== false ? fileUrl(S.sys.data_dir + '/cache/thumbs/' + m.id + '.jpg') : null);

export function initPanels() {
  const tabs = document.getElementById('left-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const t of TABS) {
    const b = h('button', { role: 'tab', id: 'tab-' + t.id, 'aria-selected': t.id === tab ? 'true' : 'false', title: t.label },
      h('span', { html: icon(t.icon) }), h('span', { text: t.label, style: 'font-size:11px' }));
    b.addEventListener('click', () => { tab = t.id; renderPanel(); });
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = TABS.findIndex((x) => x.id === tab) + (e.key === 'ArrowRight' ? 1 : -1);
      tab = TABS[(i + TABS.length) % TABS.length].id;
      renderPanel();
      document.getElementById('tab-' + tab).focus();
    });
    tabs.append(b);
  }
  on('media', () => { if (tab === 'media') renderPanel(); });
  on('tldrop', (d) => handleDrop(d.data, d.t, d.trackId));
  renderPanel();
}

export function renderPanel() {
  for (const t of TABS) document.getElementById('tab-' + t.id)?.setAttribute('aria-selected', t.id === tab ? 'true' : 'false');
  const el = body();
  if (!el) return;
  el.replaceChildren();
  el.setAttribute('role', 'tabpanel');
  if (!S.doc) return; // no project open yet
  if (tab === 'media') mediaTab(el);
  else if (tab === 'stock') stockTab(el);
  else if (tab === 'text') textTab(el);
  else if (tab === 'trans') transTab(el);
  else if (tab === 'filters') filtersTab(el);
  else audioTab(el);
}

function tile({ label, thumb, thumbIcon, dur, badge, off, draggable, onAdd, data, durUs, style }) {
  const th = h('div', { class: 'th', style: (thumb ? `background-image:url("${thumb}");` : '') + (style || '') });
  if (!thumb && thumbIcon) th.innerHTML = thumbIcon;
  const t = h('div', { class: 'tile' + (off ? ' off' : ''), tabindex: '0', role: 'button', 'aria-label': label, title: label },
    th, dur ? h('span', { class: 'dur', text: dur }) : null, badge ? h('span', { class: 'badge', text: badge }) : null,
    h('div', { class: 'lb', text: label }));
  const add = h('button', { class: 'add', 'aria-label': 'Add ' + label, title: 'Add', html: icon('plus') });
  add.addEventListener('click', (e) => { e.stopPropagation(); onAdd(); });
  t.append(add);
  t.addEventListener('click', onAdd);
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAdd(); } });
  if (draggable !== false && data) {
    t.draggable = true;
    t.addEventListener('dragstart', (e) => dragData(e, data, durUs));
  }
  return t;
}

// ---------- media
function mediaTab(el) {
  el.append(h('div', { class: 'panel-h' }, h('h3', { text: 'Your media' }),
    h('button', { class: 'btn primary sm', id: 'btn-import', html: icon('plus') + ' Import', onclick: importFlow })));
  const list = S.doc.media;
  if (!list.length) {
    el.append(h('div', { class: 'empty' },
      h('p', { style: 'margin:0 0 8px', text: 'Nothing here yet.' }),
      h('p', { class: 'small', style: 'margin:0 0 12px', text: 'Import videos, photos or audio from your computer, then click an item or drag it onto the timeline.' }),
      h('button', { class: 'btn primary', text: 'Import media', onclick: importFlow })));
    return;
  }
  const grid = h('div', { class: 'grid' });
  for (const m of list) {
    const durTxt = m.kind === 'image' ? '' : fmtDur(m.dur);
    grid.append(tile({
      label: m.name, thumb: m.kind === 'audio' ? null : thumbUrl(m), thumbIcon: m.kind === 'audio' ? icon('music') : (m.kind === 'image' ? icon('image') : icon('film')),
      dur: durTxt, badge: m.missing ? 'Missing' : (m.proxy_job ? 'Preparing' : ''), off: m.missing,
      data: { type: 'media', id: m.id }, durUs: m.kind === 'image' ? 5 * US : m.dur,
      onAdd: () => { if (m.missing) relink(m); else addMedia(m); },
    }));
  }
  el.append(grid, h('p', { class: 'hint', text: 'Click an item to add it at the playhead.' }));
}

export async function importFlow() {
  const paths = await pickFiles({ title: 'Import media', kind: 'media', multi: true });
  if (!paths.length) return;
  const items = await importPaths(paths);
  if (items.length === 1 && S.doc.media.length === 1) addMedia(items[0]);
}

function addMedia(m, t = S.t, trackId) {
  const c = addMediaClip(m, t, trackId);
  if (!c) toast('There is no free track for that. Add a track first.', 'error');
}

async function relink(m) {
  toast('That file was moved or deleted. Choose where it is now.');
  const p = await pickFiles({ title: 'Locate ' + m.name, kind: 'media', multi: false });
  if (!p.length) return;
  const got = await importPaths([p[0]]);
  const nm = got[0];
  if (!nm || nm.id === m.id) return;
  mutate('Relink media', () => {
    for (const tr of S.doc.tracks) for (const c of tr.clips) if (c.media === m.id) c.media = nm.id;
  });
  S.doc.media = S.doc.media.filter((x) => x.id !== m.id);
  emit('change', { source: 'media' });
  emit('media');
}

// ---------- stock
async function loadStock() {
  if (stock) return stock;
  try { stock = await api('stock_list'); } catch (e) { stock = []; toast(e.message, 'error'); }
  return stock;
}

function stockTab(el) {
  el.append(h('div', { class: 'panel-h' }, h('h3', { text: 'Stock library' })));
  loadStock().then((items) => {
    if (tab !== 'stock') return;
    const vis = items.filter((s) => s.kind === 'video' || s.kind === 'image');
    const cats = ['All', ...new Set(vis.map((s) => s.category))];
    const chips = h('div', { class: 'chips' }, cats.map((c) => h('button', { class: 'chip', 'aria-pressed': c === stockCat ? 'true' : 'false', text: c, onclick: () => { stockCat = c; renderPanel(); } })));
    const grid = h('div', { class: 'grid' });
    for (const s of vis.filter((x) => stockCat === 'All' || x.category === stockCat)) {
      grid.append(tile({
        label: s.title, thumb: s.thumb_path ? fileUrl(s.thumb_path) : null, dur: s.kind === 'video' ? fmtDur(s.dur) : '',
        data: { type: 'stock', path: s.path }, durUs: s.kind === 'image' ? 5 * US : s.dur,
        onAdd: () => addStock(s),
      }));
    }
    el.append(chips, grid, h('p', { class: 'hint', text: 'Original clips and pictures made for this app, free to use anywhere (CC0).' }));
  });
}

async function addStock(s, t = S.t, trackId) {
  const got = await importPaths([s.path]);
  if (got[0]) addMedia(got[0], t, trackId);
}

// ---------- text
function textTab(el) {
  el.append(h('div', { class: 'panel-h' }, h('h3', { text: 'Text' })));
  for (const p of TEXT_PRESETS(S.doc.height)) {
    const b = h('button', { class: 'preset', draggable: 'true' }, h('div', { class: 'small muted', text: p.name }), h('div', { style: p.css, text: p.sample }));
    b.addEventListener('click', () => { if (!addTextClip(p.preset, S.t)) toast('There is no free text track.', 'error'); });
    b.addEventListener('dragstart', (e) => dragData(e, { type: 'text', preset: p.preset }, 4 * US));
    el.append(b);
  }
  el.append(h('div', { class: 'sec' }, h('h4', { text: 'Subtitles' }),
    h('button', { class: 'btn', text: 'Import .srt file', onclick: importSrt }),
    h('p', { class: 'hint', text: 'Each subtitle becomes a text clip you can restyle.' })));
}

function parseSrt(text) {
  const cues = [];
  const toUs = (s) => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
    return m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * US + Math.round(+('0.' + m[4]) * US) : null;
  };
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = toUs(a), end = toUs(b);
    const content = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (start === null || end === null || end <= start || !content) continue;
    cues.push({ start, dur: end - start, content });
  }
  return cues;
}

async function importSrt() {
  const p = await pickFiles({ title: 'Choose a subtitle file', kind: 'srt', multi: false });
  if (!p.length) return;
  let text;
  try { text = (await api('read_text', { path: p[0] })).text; } catch (e) { toast(e.message, 'error'); return; }
  const cues = parseSrt(text).slice(0, 2000);
  if (!cues.length) { toast('No subtitles were found in that file.', 'error'); return; }
  mutate('Import subtitles', () => {
    for (const cue of cues) {
      const c = newTextClip(cue.start, { content: cue.content, size: 0.05, bold: true, outline: true, boxed: false, y: Math.round(S.doc.height * 0.36) });
      c.dur = cue.dur;
      let tr = S.doc.tracks.find((t) => t.kind === 'text' && !t.locked && !overlaps(t, c.start, c.dur));
      if (!tr) {
        tr = { id: 't-' + uid(), kind: 'text', muted: false, hidden: false, locked: false, clips: [] };
        S.doc.tracks.push(tr);
      }
      addClipToTrack(tr, c);
    }
  });
  toast(`Added ${cues.length} subtitle${cues.length === 1 ? '' : 's'}.`);
}

// ---------- transitions and filters (applied to a clip)
function targetClip(trackId, t) {
  if (trackId) {
    const tr = S.doc.tracks.find((x) => x.id === trackId);
    if (tr) {
      const hit = tr.clips.find((c) => t >= c.start && t < clipEnd(c));
      const near = [...tr.clips].sort((a, b) => Math.abs(a.start - t) - Math.abs(b.start - t))[0];
      const c = hit || near;
      if (c) return { clip: c, track: tr };
    }
  }
  return selected();
}

function applyTransition(f, kind) {
  if (!f) { toast('Select a clip first, then pick a transition.'); return; }
  const k = clipKind(f.clip, f.track);
  if (k !== 'video' && k !== 'image') { toast('Transitions work on video and picture clips.'); return; }
  mutate('Transition', () => { f.clip.transition_in = kind ? { kind, dur: Math.min(600000, f.clip.dur) } : null; });
}

function applyFilter(f, preset) {
  if (!f) { toast('Select a clip first, then pick a filter.'); return; }
  const k = clipKind(f.clip, f.track);
  if (k !== 'video' && k !== 'image') { toast('Filters work on video and picture clips.'); return; }
  mutate('Filter: ' + preset.label, () => { f.clip.adj = { ...defaultAdj(), ...preset.adj }; });
}

const ARROW = (rot) => `<span style="display:inline-block;transform:rotate(${rot}deg)">${icon('arrowLeft')}</span>`;
function transTab(el) {
  el.append(h('div', { class: 'panel-h' }, h('h3', { text: 'Transitions' })));
  const icons = { '': icon('x'), dissolve: icon('layers'), zoom: icon('zoomIn'), 'slide-left': ARROW(0), 'slide-right': ARROW(180), 'slide-up': ARROW(90) };
  const grid = h('div', { class: 'grid' });
  for (const t of TRANSITIONS) {
    grid.append(tile({ label: t.label, thumbIcon: icons[t.id], data: { type: 'transition', kind: t.id }, durUs: 2 * US, onAdd: () => applyTransition(selected(), t.id) }));
  }
  el.append(grid, h('p', { class: 'hint', text: 'Select a clip, then click a transition, or drag one onto a clip. It plays as that clip begins.' }));
}

const swatch = (adj) => {
  const a = { ...defaultAdj(), ...adj };
  const f = [`brightness(${1 + a.brightness})`, `contrast(${a.contrast})`, `saturate(${a.saturation})`, `hue-rotate(${a.hue}deg)`];
  if (a.warmth > 0) f.push(`sepia(${(a.warmth * 0.45).toFixed(2)})`);
  if (a.warmth < 0) f.push(`hue-rotate(${Math.round(a.warmth * 25)}deg)`);
  if (a.blur) f.push(`blur(${Math.min(2, a.blur / 2)}px)`);
  return `background-image:linear-gradient(135deg,#e0724a,#f2c14e 35%,#4aa3a0 65%,#3b5bdb);filter:${f.join(' ')}`;
};
function filtersTab(el) {
  el.append(h('div', { class: 'panel-h' }, h('h3', { text: 'Filters' })));
  const grid = h('div', { class: 'grid' });
  for (const f of FILTERS) {
    grid.append(tile({ label: f.label, style: swatch(f.adj), data: { type: 'filter', id: f.id }, durUs: 4 * US, onAdd: () => applyFilter(selected(), f) }));
  }
  el.append(grid, h('p', { class: 'hint', text: 'Select a clip, then click a filter. Fine-tune it under Colour on the right.' }));
}

// ---------- audio
function audioTab(el) {
  el.append(h('div', { class: 'panel-h' }, h('h3', { text: 'Audio' })));
  const rec = h('button', { class: 'btn', id: 'btn-record', html: icon('mic') + ' Record voiceover' });
  rec.addEventListener('click', () => toggleRecord(rec));
  el.append(rec, h('p', { class: 'hint', text: 'Recording starts at the playhead and is added as an audio clip.' }));
  const list = h('div', {});
  el.append(h('div', { class: 'sec' }, h('h4', { text: 'Music and sounds' }), list));
  loadStock().then((items) => {
    if (tab !== 'audio') return;
    const au = items.filter((s) => s.kind === 'audio');
    for (const cat of [...new Set(au.map((s) => s.category))]) {
      list.append(h('div', { class: 'small muted', style: 'margin:8px 0 4px', text: cat }));
      for (const s of au.filter((x) => x.category === cat)) {
        const play = h('button', { class: 'btn icon ghost', 'aria-label': 'Preview ' + s.title, title: 'Preview', html: icon('play') });
        play.addEventListener('click', () => previewSound(s, play));
        const add = h('button', { class: 'btn sm', text: 'Add', onclick: () => addStock(s) });
        const row = h('div', { class: 'row', draggable: 'true', style: 'gap:8px;align-items:center;margin-bottom:4px' },
          play, h('span', { class: 'grow', text: s.title, style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }), h('span', { class: 'small muted', text: fmtDur(s.dur) }), add);
        row.addEventListener('dragstart', (e) => dragData(e, { type: 'stock', path: s.path }, s.dur));
        list.append(row);
      }
    }
    list.append(h('p', { class: 'hint', text: 'Original loops and sounds made for this app (CC0).' }));
  });
}

function previewSound(s, btn) {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; document.querySelectorAll('#left-body .btn.icon[title="Stop"]').forEach((b) => { b.innerHTML = icon('play'); b.title = 'Preview'; }); }
  const a = new Audio(fileUrl(s.path));
  previewAudio = a;
  btn.innerHTML = icon('stop');
  btn.title = 'Stop';
  a.addEventListener('ended', () => { btn.innerHTML = icon('play'); btn.title = 'Preview'; previewAudio = null; });
  a.play().catch(() => toast('This sound could not be played.', 'error'));
}

let recorder = null;
async function toggleRecord(btn) {
  if (recorder) { recorder.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Recording is not available on this computer.', 'error'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) {
    toast('The microphone could not be used. Check that it is plugged in and allowed.', 'error');
    return;
  }
  const startAt = S.t;
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    btn.innerHTML = icon('mic') + ' Record voiceover';
    if (!chunks.length) return;
    try {
      const path = await upload(new Blob(chunks, { type: 'audio/webm' }), 'voice.webm');
      const got = await importPaths([path]);
      if (got[0]) addMedia(got[0], startAt);
    } catch (e) { toast(e.message, 'error'); }
  };
  recorder.start();
  btn.innerHTML = icon('stop') + ' Stop recording';
}

// ---------- drops from the timeline's drag and drop
export async function handleDrop(d, t, trackId) {
  if (!S.doc || !d) return;
  if (d.type === 'media') {
    const m = media(d.id);
    if (m) { if (m.missing) relink(m); else addMedia(m, t, trackId); }
  } else if (d.type === 'stock') {
    await addStock({ path: d.path }, t, trackId);
  } else if (d.type === 'text') {
    if (!addTextClip(d.preset, t)) toast('There is no free text track.', 'error');
  } else if (d.type === 'transition') {
    applyTransition(targetClip(trackId, t), d.kind);
  } else if (d.type === 'filter') {
    applyFilter(targetClip(trackId, t), FILTERS.find((f) => f.id === d.id) || FILTERS[0]);
  }
}

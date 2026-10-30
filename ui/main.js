// Entry point: starts the editor, builds the home screen, transport, export dialog and shortcuts.
import { api, waitJob } from './api.js';
import { icon } from './icons.js';
import {
  S, US, on, emit, undo, redo, saveNow, markDirty, splitAt, trimSide, deleteClip, fmtTime, duration,
} from './state.js';
import { initPreview, layoutStage, clearPreview, seek, togglePlay, stepFrames, pause } from './preview.js';
import { initTimeline, openTimeline, zoomBy, doSplit, toggleMarker } from './timeline.js';
import { initProps } from './props.js';
import { initPanels, renderPanel } from './panels.js';
import { checkMedia } from './library.js';
import { h, toast, openModal, confirmBox, pickSave, modalOpen } from './ui.js';

const $ = (id) => document.getElementById(id);

const ASPECTS = [
  { id: '1280x720', label: 'Landscape 16:9, 720p (easiest on older PCs)', w: 1280, h: 720 },
  { id: '1920x1080', label: 'Landscape 16:9, 1080p', w: 1920, h: 1080 },
  { id: '1080x1920', label: 'Portrait 9:16 (phone video)', w: 1080, h: 1920 },
  { id: '1080x1080', label: 'Square 1:1', w: 1080, h: 1080 },
  { id: '1080x1350', label: 'Portrait 4:5', w: 1080, h: 1350 },
];

// ---------------------------------------------------------------- boot
async function boot() {
  $('btn-home').innerHTML = icon('arrowLeft') + ' Projects';
  $('btn-undo').innerHTML = icon('undo');
  $('btn-redo').innerHTML = icon('redo');
  $('btn-keys').innerHTML = icon('keyboard');
  $('btn-export').innerHTML = icon('download') + ' Export';
  try {
    S.sys = await api('sys_info');
    S.settings = await api('settings_get');
  } catch (e) {
    $('home').replaceChildren(h('div', { class: 'wrap' }, h('h1', { text: 'Lite Editor' }),
      h('p', { class: 'err', text: e.message }), h('p', { class: 'muted', text: 'Close the app and open it again.' })));
    return;
  }
  initPreview();
  initTimeline();
  initProps();
  initPanels();
  buildTransport();
  wire();
  await showHome();
}

function wire() {
  $('btn-home').addEventListener('click', showHome);
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-keys').addEventListener('click', showKeys);
  $('btn-export').addEventListener('click', exportFlow);
  $('proj-name').addEventListener('change', () => {
    if (!S.doc) return;
    S.doc.name = $('proj-name').value.trim() || 'Untitled project';
    $('proj-name').value = S.doc.name;
    markDirty();
  });
  on('savestate', (st) => {
    $('save-state').textContent = { dirty: 'Unsaved changes', saving: 'Saving…', saved: 'Saved', error: 'Could not save' }[st] || '';
    $('save-state').classList.toggle('err', st === 'error');
  });
  on('toast', (d) => toast(d.text, d.kind));
  on('change', () => { syncUndo(); syncHint(); syncTime(); });
  on('time', syncTime);
  on('playstate', syncPlay);
  window.addEventListener('beforeunload', () => { saveNow(); });
  window.addEventListener('keydown', onKey);
  // After a mouse click, drop focus from the button so Space plays the video instead of pressing it again.
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button, .tile');
    if (b && e.detail > 0 && !b.closest('.modal')) b.blur();
  }, true);
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

function syncUndo() {
  $('btn-undo').disabled = !S.undo.length;
  $('btn-redo').disabled = !S.redo.length;
}
function syncHint() {
  if (!S.doc) return;
  const empty = !S.doc.tracks.some((t) => t.clips.length);
  $('stage-hint').textContent = empty ? 'Import media on the left, then click it or drag it onto the timeline.' : '';
}

// ---------------------------------------------------------------- transport
function buildTransport() {
  const tp = $('transport');
  const mk = (id, ic, title, fn) => h('button', { class: 'btn icon ghost', id, title, 'aria-label': title.replace(/ \(.*\)/, ''), html: icon(ic), onclick: fn });
  tp.append(
    mk('tp-start', 'toStart', 'Go to start (Home)', () => { pause(); seek(0); }),
    mk('tp-back', 'stepBack', 'Back one frame (Left)', () => stepFrames(-1)),
    mk('tp-play', 'play', 'Play (Space)', togglePlay),
    mk('tp-fwd', 'stepFwd', 'Forward one frame (Right)', () => stepFrames(1)),
    mk('tp-end', 'toEnd', 'Go to end (End)', () => { pause(); seek(duration()); }),
    h('span', { class: 'timecode', id: 'timecode', role: 'timer', 'aria-label': 'Playhead time' }));
}
function syncTime() {
  if (!S.doc) return;
  $('timecode').textContent = `${fmtTime(S.t)} / ${fmtTime(duration())}`;
}
function syncPlay() {
  const b = $('tp-play');
  b.innerHTML = icon(S.playing ? 'pause' : 'play');
  b.title = S.playing ? 'Pause (Space)' : 'Play (Space)';
  b.setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
}

// ---------------------------------------------------------------- home
const ago = (secs) => {
  const d = Math.max(0, Date.now() / 1000 - secs);
  if (d < 90) return 'just now';
  if (d < 3600) return Math.round(d / 60) + ' min ago';
  if (d < 86400) return Math.round(d / 3600) + ' h ago';
  return new Date(secs * 1000).toLocaleDateString();
};

async function showHome() {
  if (S.doc) { pause(); await saveNow(); }
  S.doc = null;
  clearPreview();
  $('editor').hidden = true;
  $('home').hidden = false;
  let list = [];
  try { list = await api('project_list'); } catch (e) { toast(e.message, 'error'); }
  const wrap = h('div', { class: 'wrap' });
  wrap.append(h('div', { class: 'row', style: 'align-items:center;gap:12px' },
    h('h1', { class: 'grow', text: 'Lite Editor' }),
    h('button', { class: 'btn', id: 'btn-settings', html: icon('gear') + ' Settings', onclick: showSettings })));
  wrap.append(h('p', { class: 'muted', style: 'margin:4px 0 0', text: 'A light video editor that works offline, even on older computers.' }));
  if (!S.sys.ffmpeg) {
    wrap.append(h('div', { class: 'banner', style: 'margin-top:16px', role: 'alert' },
      h('span', { text: 'The video engine was not found, so importing and exporting will not work. Reinstalling the app usually fixes this.' })));
  }
  const cards = h('div', { class: 'cards' });
  cards.append(h('div', { class: 'card new', id: 'card-new', tabindex: '0', role: 'button', 'aria-label': 'New project', onclick: newProject,
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); newProject(); } } },
  h('div', { class: 'pv', html: icon('plus').replace('<svg', '<svg width="36" height="36"') }),
  h('div', { class: 'meta' }, h('b', { text: 'New project' }), h('span', { class: 'muted small', text: 'Start from an empty timeline' }))));
  for (const p of list) {
    const ar = p.width / p.height;
    const bw = ar >= 1 ? 64 : Math.round(64 * ar), bh = ar >= 1 ? Math.round(64 / ar) : 64;
    const del = h('button', { class: 'btn icon sm danger del', title: 'Delete project', 'aria-label': 'Delete ' + p.name, html: icon('trash') });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await confirmBox('Delete this project?', `"${p.name}" will be removed. Your original media files are not touched.`, 'Delete', true)) {
        try { await api('project_delete', { id: p.id }); } catch (err) { toast(err.message, 'error'); }
        showHome();
      }
    });
    const open = () => openProject(p.id);
    cards.append(h('div', { class: 'card', tabindex: '0', role: 'button', 'aria-label': 'Open ' + p.name, onclick: open,
      onkeydown: (e) => { if (e.key === 'Enter') open(); } },
    h('div', { class: 'pv' }, h('div', { class: 'ar', style: `width:${bw}px;height:${bh}px` })),
    h('div', { class: 'meta' }, h('b', { text: p.name }),
      h('span', { class: 'muted small', text: `${p.width}×${p.height} · ${p.clips} clip${p.clips === 1 ? '' : 's'} · ${ago(p.updated)}` })), del));
  }
  wrap.append(cards);
  if (!list.length) wrap.append(h('p', { class: 'muted', style: 'margin-top:24px', text: 'No projects yet. Choose New project to begin.' }));
  $('home').replaceChildren(wrap);
}

function newProject() {
  const name = h('input', { type: 'text', class: 'field', maxlength: '80', value: 'My first video', 'aria-label': 'Project name', style: 'width:100%' });
  const size = h('select', { class: 'field', 'aria-label': 'Size' }, ASPECTS.map((a) => h('option', { value: a.id, text: a.label })));
  const fps = h('select', { class: 'field', 'aria-label': 'Frame rate' }, [24, 25, 30, 60].map((f) => h('option', { value: f, text: f + ' frames per second' })));
  fps.value = '30';
  const create = async () => {
    const a = ASPECTS.find((x) => x.id === size.value);
    try {
      const doc = await api('project_new', { name: name.value.trim() || 'Untitled project', width: a.w, height: a.h, fps: Number(fps.value) });
      openDoc(doc);
    } catch (e) { toast(e.message, 'error'); return false; }
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.close(); create(); } });
  const m = openModal({
    title: 'New project',
    body: [h('div', { class: 'mrow' }, h('label', { text: 'Name' }), name), h('div', { class: 'mrow' }, h('label', { text: 'Size' }), size), h('div', { class: 'mrow' }, h('label', { text: 'Frame rate' }), fps),
      h('p', { class: 'hint', style: 'margin:0', text: 'Smaller sizes keep editing smooth on older computers. You can still choose a different size when you export.' })],
    footer: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', onClick: () => { create(); } }],
  });
}

async function openProject(id) {
  try { openDoc(await api('project_load', { id })); } catch (e) { toast(e.message, 'error'); }
}

function openDoc(doc) {
  doc.markers ||= [];
  doc.media ||= [];
  for (const t of doc.tracks || []) {
    t.clips ||= [];
    t.locked ||= false; t.muted ||= false; t.hidden ||= false;
  }
  S.doc = doc;
  S.sel = null; S.t = 0; S.undo = []; S.redo = []; S.dirty = false; S.playing = false;
  $('home').hidden = true;
  $('editor').hidden = false;
  $('proj-name').value = doc.name;
  $('save-state').textContent = '';
  clearPreview();
  requestAnimationFrame(() => {
    openTimeline();
    layoutStage();
    renderPanel();
    emit('change', { source: 'open' });
    emit('select');
    emit('playstate');
    checkMedia();
  });
}

// ---------------------------------------------------------------- settings
async function showSettings() {
  let bytes = 0;
  try { bytes = (await api('cache_info')).bytes; } catch (e) { /* shown as 0 */ }
  const mb = (b) => (b / 1048576).toFixed(b > 1e8 ? 0 : 1) + ' MB';
  const ph = h('select', { class: 'field', 'aria-label': 'Preview quality' },
    [[360, 'Smallest (best for slow computers)'], [540, 'Balanced'], [720, 'Sharper']].map(([v, t]) => h('option', { value: v, text: t })));
  ph.value = String(S.settings.proxy_height || 540);
  const cacheTxt = h('span', { text: mb(bytes) });
  const clear = h('button', { class: 'btn sm', text: 'Clear', onclick: async () => { await api('cache_clear'); cacheTxt.textContent = mb(0); toast('Preview files cleared. They are rebuilt when needed.'); } });
  openModal({
    title: 'Settings',
    body: [
      h('div', { class: 'mrow' }, h('label', { text: 'Preview quality' }), ph),
      h('p', { class: 'hint', style: 'margin:0', text: 'Big videos get a small stand-in copy so playback stays smooth. Exports always use the original files.' }),
      h('div', { class: 'mrow' }, h('label', { text: 'Preview files' }), h('div', { class: 'row', style: 'gap:12px;align-items:center' }, cacheTxt, clear)),
      h('p', { class: 'small muted', style: 'margin:0', text: `Version ${S.sys.app_version}. ${S.sys.ffmpeg ? S.sys.ffmpeg.split(' Copyright')[0] : 'Video engine not found.'} Third-party licences are in the app folder (THIRD_PARTY_LICENSES.txt).` }),
    ],
    footer: [{ label: 'Close' }, { label: 'Save', kind: 'primary', onClick: async () => {
      S.settings = { ...S.settings, proxy_height: Number(ph.value) };
      try { await api('settings_set', { settings: S.settings }); } catch (e) { toast(e.message, 'error'); }
    } }],
  });
}

// ---------------------------------------------------------------- shortcuts
const KEYS = [
  ['Space', 'Play or pause'], ['Left / Right', 'Back or forward one frame (Shift: one second)'], ['Home / End', 'Go to start or end'],
  ['S', 'Split the clip at the playhead'], ['Q / W', 'Delete everything left / right of the playhead'], ['Delete', 'Delete the selected clip'],
  ['Shift+Delete', 'Delete and close the gap'], ['M', 'Add or remove a marker'], ['N', 'Turn snapping on or off'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['+ / -', 'Zoom the timeline'], ['Ctrl+S', 'Save now'], ['Ctrl+E', 'Export'], ['?', 'Show this list'],
];
function showKeys() {
  openModal({ title: 'Keyboard shortcuts', body: h('table', { class: 'keys' }, KEYS.map(([k, d]) => h('tr', {}, h('td', { text: k }), h('td', { text: d })))), footer: [{ label: 'Close', kind: 'primary' }] });
}

function typing(t) {
  return t && (t.tagName === 'INPUT' && !['range', 'checkbox', 'color', 'button'].includes(t.type) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
function onKey(e) {
  if (!S.doc || modalOpen() || typing(e.target)) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
  if (ctrl && (k === 's' || k === 'S')) { e.preventDefault(); saveNow().then(() => toast('Saved.')); return; }
  if (ctrl && (k === 'e' || k === 'E')) { e.preventDefault(); exportFlow(); return; }
  if (ctrl || e.altKey) return;
  if (k === ' ' && e.target.closest && e.target.closest('button, .tile, [role=tab]')) return; // let the focused control act
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'ArrowLeft') { e.preventDefault(); if (e.shiftKey) { pause(); seek(S.t - US); } else stepFrames(-1); }
  else if (k === 'ArrowRight') { e.preventDefault(); if (e.shiftKey) { pause(); seek(S.t + US); } else stepFrames(1); }
  else if (k === 'Home') { e.preventDefault(); pause(); seek(0); }
  else if (k === 'End') { e.preventDefault(); pause(); seek(duration()); }
  else if (k === 's' || k === 'S') doSplit();
  else if (k === 'q' || k === 'Q') { if (!trimSide('left', S.t)) toast('Select a clip and put the playhead inside it first.'); }
  else if (k === 'w' || k === 'W') { if (!trimSide('right', S.t)) toast('Select a clip and put the playhead inside it first.'); }
  else if (k === 'Delete' || k === 'Backspace') { if (S.sel) { e.preventDefault(); deleteClip(S.sel, e.shiftKey); } }
  else if (k === 'm' || k === 'M') toggleMarker();
  else if (k === 'n' || k === 'N') $('tb-snap')?.click();
  else if (k === '+' || k === '=') zoomBy(1.3);
  else if (k === '-' || k === '_') zoomBy(1 / 1.3);
  else if (k === '?') showKeys();
  else if (k === 'Escape') { if (S.sel) { S.sel = null; emit('select'); } }
}

// ---------------------------------------------------------------- export
const ENCODER_NAMES = {
  libx264: 'Software H.264 (works on every computer)', h264_nvenc: 'NVIDIA graphics card (fast)', h264_qsv: 'Intel graphics (fast)',
  h264_amf: 'AMD graphics (fast)', h264_mf: 'Windows built-in encoder', libopenh264: 'Software OpenH264', mpeg4: 'Basic MPEG-4 (older, larger files)',
};
const even = (n) => Math.max(16, Math.round(n / 2) * 2);
function dimsFor(shortSide) {
  if (!shortSide) return { w: S.doc.width, h: S.doc.height };
  const ar = S.doc.width / S.doc.height;
  return ar >= 1 ? { w: even(shortSide * ar), h: even(shortSide) } : { w: even(shortSide), h: even(shortSide / ar) };
}

async function exportFlow() {
  if (!S.doc) return;
  if (!duration()) { toast('Add something to the timeline before exporting.'); return; }
  pause();
  await saveNow();
  const base = S.doc.name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'video';
  const isWin = S.sys.os === 'windows';
  const path = h('input', { type: 'text', class: 'field', style: 'flex:1;min-width:0', 'aria-label': 'Save to', placeholder: 'Choose where to save…',
    value: isWin ? '' : `${S.sys.data_dir}/${base}.mp4` });
  const browse = h('button', { class: 'btn sm', id: 'ex-browse', text: 'Browse…' });
  const mkSel = (label, opts, val) => { const s = h('select', { class: 'field', 'aria-label': label }, opts.map(([v, t]) => h('option', { value: v, text: t }))); s.value = val; return s; };
  const res = mkSel('Resolution', [['0', `Same as project (${S.doc.width}×${S.doc.height})`], ['2160', '4K (needs a fast computer)'], ['1080', 'Full HD 1080p'], ['720', 'HD 720p (easy on older PCs)'], ['480', '480p (smallest file)']], '0');
  const fps = mkSel('Frame rate', [['0', `Same as project (${S.doc.fps})`], ['24', '24'], ['30', '30'], ['60', '60']], '0');
  const quality = mkSel('Quality', [['low', 'Smaller file, faster'], ['medium', 'Balanced'], ['high', 'Best quality, bigger file']], 'medium');
  const encs = (S.sys.encoders || []);
  const enc = mkSel('Encoder', [['auto', 'Automatic (recommended)'], ...encs.map((e) => [e, ENCODER_NAMES[e] || e])], 'auto');
  const audioOnly = h('input', { type: 'checkbox' });
  const status = h('div', { class: 'small', role: 'status', 'aria-live': 'polite' });
  const bar = h('div', { class: 'progress', hidden: true }, h('i', {}));
  audioOnly.addEventListener('change', () => {
    path.value = path.value.replace(/\.[A-Za-z0-9]+$/, '') + (audioOnly.checked ? '.m4a' : '.mp4');
    for (const s of [res, fps, quality, enc]) s.disabled = audioOnly.checked;
  });
  browse.addEventListener('click', async () => {
    const p = await pickSave({ title: 'Export video', ext: audioOnly.checked ? 'm4a' : 'mp4', default_name: base });
    if (p === null) toast('Type the full path in the box.');
    else if (p) path.value = p;
  });
  let jobId = null, running = false, finished = '';
  const body = [
    h('div', { class: 'mrow' }, h('label', { text: 'Save to' }), h('div', { class: 'row', style: 'gap:8px' }, path, browse)),
    h('div', { class: 'mrow' }, h('label', { text: 'Resolution' }), res),
    h('div', { class: 'mrow' }, h('label', { text: 'Frame rate' }), fps),
    h('div', { class: 'mrow' }, h('label', { text: 'Quality' }), quality),
    h('div', { class: 'mrow' }, h('label', { text: 'Encoder' }), enc),
    h('div', { class: 'mrow' }, h('span', {}), h('label', { class: 'check' }, audioOnly, 'Audio only')),
    bar, status,
  ];
  const m = openModal({
    title: 'Export', body, dismissable: true,
    onClose: () => { if (running && jobId) api('job_cancel', { id: jobId }).catch(() => {}); },
    footer: [
      { label: 'Cancel', onClick: () => { if (running && jobId) api('job_cancel', { id: jobId }).catch(() => {}); } },
      {
        label: 'Export', kind: 'primary', close: false,
        onClick: async (mm, btn) => {
          if (running) return false;
          if (finished) { api('reveal', { path: finished }).catch(() => {}); return false; }
          let out = path.value.trim();
          if (!out) {
            const p = await pickSave({ title: 'Export video', ext: audioOnly.checked ? 'm4a' : 'mp4', default_name: base });
            if (!p) { status.textContent = 'Choose where to save the file first.'; return false; }
            out = path.value = p;
          }
          const d = dimsFor(Number(res.value));
          running = true;
          btn.disabled = true;
          for (const s of [path, browse, res, fps, quality, enc, audioOnly]) s.disabled = true;
          bar.hidden = false;
          status.className = 'small';
          status.textContent = 'Exporting…';
          try {
            const r = await api('export_start', { doc: S.doc, settings: {
              path: out, width: d.w, height: d.h, fps: Number(fps.value) || S.doc.fps, quality: quality.value, encoder: enc.value, audio_only: audioOnly.checked } });
            jobId = r.job;
            const j = await waitJob(r.job, (pct) => { bar.firstChild.style.width = pct.toFixed(1) + '%'; status.textContent = `Exporting… ${Math.round(pct)}%`; });
            running = false;
            if (j.state === 'done') {
              bar.firstChild.style.width = '100%';
              status.className = 'small ok';
              status.textContent = 'Done. Saved to ' + out;
              mm.buttons['Cancel'].textContent = 'Close';
              btn.textContent = 'Show in folder';
              btn.disabled = false;
              finished = out;
            } else {
              status.className = 'small ' + (j.state === 'cancelled' ? '' : 'err');
              status.textContent = j.state === 'cancelled' ? 'Export cancelled.' : 'The export did not finish: ' + (j.message || 'unknown problem');
              reopenControls();
            }
          } catch (e) {
            running = false;
            status.className = 'small err';
            status.textContent = e.message;
            reopenControls();
          }
          return false;
          function reopenControls() {
            btn.disabled = false;
            bar.hidden = true;
            for (const s of [path, browse, audioOnly]) s.disabled = false;
            if (!audioOnly.checked) for (const s of [res, fps, quality, enc]) s.disabled = false;
          }
        },
      },
    ],
  });
  return m;
}

boot();

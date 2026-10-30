// Properties panel: edits the selected clip. Every change is one undoable step per drag.
import {
  S, US, on, mutate, selected, media, clipKind, setSpeed, deleteClip, duration, clamp, defaultAdj, fmtDur,
} from './state.js';
import { h } from './ui.js';

export const TRANSITIONS = [
  { id: '', label: 'None' },
  { id: 'dissolve', label: 'Dissolve' },
  { id: 'zoom', label: 'Zoom in' },
  { id: 'slide-left', label: 'Slide left' },
  { id: 'slide-right', label: 'Slide right' },
  { id: 'slide-up', label: 'Slide up' },
];

let syncs = [];
const root = () => document.getElementById('props');

export function initProps() {
  on('select', render);
  on('change', (d) => { if (d && d.source === 'prop') return; render(); });
  on('propsrefresh', () => syncs.forEach((f) => f()));
}

const shown = (v, step) => {
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return Number(v).toFixed(dec);
};

function sec(title, ...rows) { return h('div', { class: 'sec' }, h('h4', { text: title }), ...rows); }

function slider(label, get, set, { min, max, step, def, key }) {
  const range = h('input', { type: 'range', min, max, step, 'aria-label': label });
  const num = h('input', { type: 'number', class: 'field', min, max, step, 'aria-label': label + ' value' });
  const sync = () => { const v = get(); range.value = v; num.value = shown(v, step); };
  const apply = (v) => {
    if (!Number.isFinite(v)) { sync(); return; }
    v = clamp(v, min, max);
    mutate(label, () => set(v), { coalesce: key || label, source: 'prop' });
    sync();
  };
  range.addEventListener('input', () => apply(parseFloat(range.value)));
  num.addEventListener('change', () => apply(parseFloat(num.value)));
  if (def !== undefined) range.addEventListener('dblclick', () => apply(def));
  range.title = def !== undefined ? 'Double-click to reset' : '';
  syncs.push(sync);
  sync();
  return h('div', { class: 'prow' }, h('label', { text: label }), range, num);
}

function check(label, get, set) {
  const box = h('input', { type: 'checkbox' });
  box.checked = !!get();
  box.addEventListener('change', () => { mutate(label, () => set(box.checked), { source: 'prop' }); });
  syncs.push(() => { box.checked = !!get(); });
  return h('div', { class: 'prow two' }, h('span', {}), h('label', { class: 'check' }, box, label));
}

function render() {
  const el = root();
  if (!el) return;
  syncs = [];
  el.replaceChildren();
  if (!S.doc) return;
  const f = selected();
  if (!f) { el.append(projectInfo()); return; }
  const { clip: c, track: tr } = f;
  const kind = clipKind(c, tr);
  const m = media(c.media);
  const visual = kind === 'video' || kind === 'image' || kind === 'text';
  const locked = tr.locked;

  el.append(h('div', { class: 'sec' },
    h('b', { text: kind === 'text' ? 'Text' : (m ? m.name : 'Clip'), style: 'display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }),
    h('div', { class: 'hint', text: `${kind[0].toUpperCase() + kind.slice(1)} clip, ${(c.dur / US).toFixed(2)} s${locked ? ', track is locked' : ''}` })));

  if (c.text) {
    const ta = h('textarea', { rows: 3, style: 'width:100%', 'aria-label': 'Text' });
    ta.value = c.text.content;
    ta.addEventListener('input', () => mutate('Edit text', () => { c.text.content = ta.value; }, { coalesce: 'text:' + c.id, source: 'prop' }));
    const color = h('input', { type: 'color', 'aria-label': 'Text colour' });
    color.value = /^#[0-9a-f]{6}$/i.test(c.text.color) ? c.text.color : '#ffffff';
    color.addEventListener('input', () => mutate('Text colour', () => { c.text.color = color.value; }, { coalesce: 'tcolor:' + c.id, source: 'prop' }));
    el.append(sec('Text', ta,
      slider('Size', () => c.text.size, (v) => { c.text.size = v; }, { min: 0.02, max: 0.3, step: 0.005, def: 0.09 }),
      h('div', { class: 'prow two' }, h('label', { text: 'Colour' }), color),
      check('Bold', () => c.text.bold, (v) => { c.text.bold = v; }),
      check('Outline', () => c.text.outline, (v) => { c.text.outline = v; }),
      check('Shadow', () => c.text.shadow, (v) => { c.text.shadow = v; }),
      check('Background box', () => c.text.boxed, (v) => { c.text.boxed = v; })));
  }

  if (visual) {
    el.append(sec('Position and size',
      slider('X', () => c.x, (v) => { c.x = Math.round(v); }, { min: -S.doc.width, max: S.doc.width, step: 1, def: 0 }),
      slider('Y', () => c.y, (v) => { c.y = Math.round(v); }, { min: -S.doc.height, max: S.doc.height, step: 1, def: 0 }),
      slider('Scale', () => c.scale, (v) => { c.scale = v; }, { min: 0.1, max: 4, step: 0.01, def: 1 }),
      slider('Rotation', () => c.rot, (v) => { c.rot = v; }, { min: -180, max: 180, step: 1, def: 0 }),
      slider('Opacity', () => c.opacity, (v) => { c.opacity = v; }, { min: 0, max: 1, step: 0.01, def: 1 }),
      kind !== 'text' ? check('Mirror', () => c.mirror, (v) => { c.mirror = v; }) : null));
  }

  if (kind === 'video' || kind === 'audio') {
    el.append(sec('Speed',
      slider('Speed', () => c.speed, (v) => setSpeed(c, tr, v), { min: 0.25, max: 4, step: 0.05, def: 1 }),
      h('div', { class: 'hint', text: 'Changing the speed changes how long the clip is.' })));
  }

  if (kind === 'audio' || (kind === 'video' && m && m.has_audio)) {
    const maxFade = Math.max(0.1, Math.min(5, c.dur / US / 2));
    el.append(sec('Audio',
      slider('Volume', () => c.volume, (v) => { c.volume = v; }, { min: 0, max: 2, step: 0.01, def: 1 }),
      slider('Fade in', () => c.fade_in / US, (v) => { c.fade_in = Math.round(v * US); }, { min: 0, max: maxFade, step: 0.1, def: 0 }),
      slider('Fade out', () => c.fade_out / US, (v) => { c.fade_out = Math.round(v * US); }, { min: 0, max: maxFade, step: 0.1, def: 0 })));
  }

  if (kind === 'video' || kind === 'image') {
    const adj = () => (c.adj ||= defaultAdj());
    const reset = h('button', { class: 'btn sm', text: 'Reset colour', onclick: () => { mutate('Reset colour', () => { c.adj = defaultAdj(); }); } });
    el.append(sec('Colour',
      slider('Brightness', () => adj().brightness, (v) => { adj().brightness = v; }, { min: -1, max: 1, step: 0.01, def: 0 }),
      slider('Contrast', () => adj().contrast, (v) => { adj().contrast = v; }, { min: 0, max: 2, step: 0.01, def: 1 }),
      slider('Saturation', () => adj().saturation, (v) => { adj().saturation = v; }, { min: 0, max: 3, step: 0.01, def: 1 }),
      slider('Hue', () => adj().hue, (v) => { adj().hue = v; }, { min: -180, max: 180, step: 1, def: 0 }),
      slider('Warmth', () => adj().warmth, (v) => { adj().warmth = v; }, { min: -1, max: 1, step: 0.01, def: 0 }),
      slider('Blur', () => adj().blur, (v) => { adj().blur = v; }, { min: 0, max: 40, step: 0.5, def: 0 }),
      h('div', { class: 'prow two' }, h('span', {}), reset)));

    const sel = h('select', { class: 'field', 'aria-label': 'Transition' }, TRANSITIONS.map((t) => h('option', { value: t.id, text: t.label })));
    sel.value = c.transition_in ? c.transition_in.kind : '';
    sel.addEventListener('change', () => {
      mutate('Transition', () => {
        c.transition_in = sel.value ? { kind: sel.value, dur: c.transition_in ? c.transition_in.dur : 600000 } : null;
      });
    });
    const rows = [h('div', { class: 'prow two' }, h('label', { text: 'Style' }), sel)];
    if (c.transition_in) {
      rows.push(slider('Length', () => (c.transition_in ? c.transition_in.dur / US : 0.6), (v) => { if (c.transition_in) c.transition_in.dur = Math.round(v * US); },
        { min: 0.1, max: Math.max(0.2, Math.min(3, c.dur / US)), step: 0.05, def: 0.6 }));
    }
    el.append(sec('Transition in', ...rows, h('div', { class: 'hint', text: 'Plays as this clip begins.' })));
  }

  el.append(sec('Clip',
    h('div', { class: 'row', style: 'gap:8px' },
      h('button', { class: 'btn sm danger', text: 'Delete', onclick: () => deleteClip(c.id, false) }),
      h('button', { class: 'btn sm', text: 'Delete and close gap', onclick: () => deleteClip(c.id, true) }))));
}

function projectInfo() {
  let clips = 0;
  for (const t of S.doc.tracks) clips += t.clips.length;
  return h('div', {},
    sec('Project',
      h('div', { class: 'prow two' }, h('label', { text: 'Size' }), h('span', { text: `${S.doc.width} × ${S.doc.height}` })),
      h('div', { class: 'prow two' }, h('label', { text: 'Frame rate' }), h('span', { text: `${S.doc.fps} fps` })),
      h('div', { class: 'prow two' }, h('label', { text: 'Length' }), h('span', { text: duration() ? fmtDur(duration()) : 'empty' })),
      h('div', { class: 'prow two' }, h('label', { text: 'Clips' }), h('span', { text: String(clips) }))),
    h('p', { class: 'hint', text: 'Select a clip on the timeline or in the preview to edit it here.' }));
}

export { render as renderProps };

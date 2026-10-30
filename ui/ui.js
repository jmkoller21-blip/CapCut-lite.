// Small UI helpers: element builder, modal, toast, confirm, and file pickers.
import { api } from './api.js';

// h('div', {class: 'x', onclick: fn, text: 'hi'}, child, child)
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

export function toast(text, kind = 'info', ms = 4200) {
  const root = document.getElementById('toasts');
  const t = h('div', { class: 'toast' + (kind === 'error' ? ' error' : ''), text });
  root.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? Math.max(ms, 7000) : ms);
}

let openCount = 0;
export const modalOpen = () => openCount > 0;

// openModal({title, body, footer: [{label, kind, onClick}], wide, onClose}) -> {close, el, body}
export function openModal({ title, body, footer = [], wide = false, onClose, dismissable = true }) {
  const root = document.getElementById('modal-root');
  const prev = document.activeElement;
  const scrim = h('div', { class: 'scrim' });
  const titleId = 'm-' + Math.random().toString(36).slice(2, 7);
  const bodyEl = h('div', { class: 'body' }, body);
  const closeBtn = h('button', { class: 'btn icon ghost', 'aria-label': 'Close', title: 'Close' });
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const modal = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('header', {}, h('h2', { id: titleId, text: title }), dismissable ? closeBtn : null),
    bodyEl,
    footer.length ? h('footer', {}) : null);
  const api2 = { el: modal, body: bodyEl };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openCount--;
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
    if (prev && prev.focus) prev.focus();
    if (onClose) onClose();
  };
  api2.close = close;
  const footEl = modal.querySelector('footer');
  api2.buttons = {};
  for (const f of footer) {
    const b = h('button', { class: 'btn ' + (f.kind || 'secondary'), text: f.label });
    b.addEventListener('click', () => { if (f.onClick) { const r = f.onClick(api2, b); if (r === false) return; } if (f.close !== false) close(); });
    footEl.append(b);
    api2.buttons[f.label] = b;
  }
  function onKey(e) {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      const f = [...modal.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  closeBtn.addEventListener('click', close);
  if (dismissable) scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(); });
  document.addEventListener('keydown', onKey, true);
  scrim.append(modal);
  root.append(scrim);
  openCount++;
  const first = modal.querySelector('input, select, textarea') || footEl?.querySelector('.btn.primary') || closeBtn;
  setTimeout(() => first && first.focus(), 0);
  return api2;
}

export function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title,
      body: h('p', { style: 'margin:0', text }),
      footer: [
        { label: 'Cancel', onClick: () => { answered = true; resolve(false); } },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => { answered = true; resolve(true); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

// Ask for text paths when the system file dialog is not available (browser preview, tests).
function askPaths(title, multi) {
  return new Promise((resolve) => {
    const ta = h('textarea', { rows: multi ? 4 : 1, style: 'width:100%;font-family:var(--font-mono)', 'aria-label': 'File path' });
    let done = false;
    openModal({
      title,
      body: [h('p', { class: 'muted', style: 'margin:0', text: 'A file picker is not available here. Type or paste a full file path' + (multi ? ' (one per line).' : '.') }), ta],
      footer: [
        { label: 'Cancel', onClick: () => { done = true; resolve([]); } },
        { label: 'OK', kind: 'primary', onClick: () => { done = true; resolve(ta.value.split('\n').map((s) => s.trim()).filter(Boolean)); } },
      ],
      onClose: () => { if (!done) resolve([]); },
    });
  });
}

export async function pickFiles({ title = 'Choose files', kind = 'media', multi = true } = {}) {
  try {
    const r = await api('pick_open', { title, kind, multi });
    return r.paths || [];
  } catch (e) {
    if (String(e.message).includes('no_native_dialog')) return askPaths(title, multi);
    toast(e.message, 'error');
    return [];
  }
}

// Returns a path, '' if cancelled, or null if no native dialog exists (caller falls back to a typed path).
export async function pickSave({ title = 'Save as', ext = 'mp4', default_name = 'video' } = {}) {
  try {
    const r = await api('pick_save', { title, ext, default_name });
    return r.path || '';
  } catch (e) {
    if (String(e.message).includes('no_native_dialog')) return null;
    toast(e.message, 'error');
    return '';
  }
}

// Talks to the local engine. The per-launch token travels in a cookie set when the page loads.
export async function api(cmd, args = {}) {
  let r;
  try {
    r = await fetch('/api/' + cmd, { method: 'POST', body: JSON.stringify(args), credentials: 'same-origin' });
  } catch (e) {
    throw new Error('The editor engine is not responding. Close and reopen the app.');
  }
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Something went wrong');
  return j.data;
}

export const fileUrl = (p) => '/file?p=' + encodeURIComponent(p);

export async function upload(blob, name) {
  const r = await fetch('/upload?name=' + encodeURIComponent(name), { method: 'POST', body: blob, credentials: 'same-origin' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Upload failed');
  return j.data.path;
}

// Wait for an engine job (export, proxy). onProgress gets 0..100.
export async function waitJob(id, onProgress, shouldStop) {
  for (;;) {
    const j = await api('job_status', { id });
    if (onProgress) onProgress(j.pct || 0, j);
    if (j.state !== 'running') return j;
    if (shouldStop && shouldStop()) return j;
    await new Promise((r) => setTimeout(r, 400));
  }
}

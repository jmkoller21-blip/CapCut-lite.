// End-to-end UI smoke test. Drives the real UI in headless Chromium against the real engine.
// Usage: node tools/smoke-ui.js <base-url-with-token> <media-dir> <out-dir>
//   e.g. node tools/smoke-ui.js "http://127.0.0.1:7788/?t=devtoken" /tmp/lite-smoke/media /tmp/lite-smoke/out
// The media dir needs clipA.mp4 (video + audio) and clipB.mp4.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require(process.env.PLAYWRIGHT_DIR || '/opt/node22/lib/node_modules/playwright');

const [url, mediaDir, outDir] = process.argv.slice(2);
if (!url || !mediaDir || !outDir) { console.error('usage: smoke-ui.js <url> <media-dir> <out-dir>'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const problems = [];
const steps = [];
const ok = (name, detail = '') => { steps.push(['ok', name, detail]); console.log('  ok  ', name, detail); };
const bad = (name, detail = '') => { steps.push(['FAIL', name, detail]); problems.push(name + ' ' + detail); console.log('  FAIL', name, detail); };
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, permissions: [] });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('favicon')) problems.push(`http ${r.status()}: ${r.url()}`); });
  const shot = (n) => page.screenshot({ path: path.join(outDir, n + '.png') });
  const apiCall = (cmd, args) => page.evaluate(async ([c, a]) => (await fetch('/api/' + c, { method: 'POST', body: JSON.stringify(a || {}) })).json(), [cmd, args]);

  try {
    // ---- home
    await page.goto(url);
    await page.waitForSelector('#card-new', { timeout: 15000 });
    ok('home screen loads');
    await shot('01-home');

    // ---- new project
    await page.click('#card-new');
    await page.waitForSelector('.modal');
    await page.fill('.modal input[aria-label="Project name"]', 'Smoke test');
    await page.selectOption('.modal select[aria-label="Size"]', '1280x720');
    await page.click('.modal footer .btn.primary');
    await page.waitForSelector('#editor:not([hidden])', { timeout: 10000 });
    ok('new project opens the editor');
    await shot('02-empty-editor');

    // ---- import (no native dialog on Linux, so the path box appears)
    await page.click('#btn-import');
    await page.waitForSelector('textarea[aria-label="File path"]');
    await page.fill('textarea[aria-label="File path"]', path.join(mediaDir, 'clipA.mp4') + '\n' + path.join(mediaDir, 'clipB.mp4'));
    await page.click('.modal footer .btn.primary');
    await page.waitForSelector('#left-body .tile', { timeout: 20000 });
    const tiles = await page.locator('#left-body .tile').count();
    check(tiles === 2, 'two media tiles after import', 'tiles=' + tiles);
    await shot('03-imported');

    // ---- add both clips to the timeline
    await page.locator('#left-body .tile').nth(0).click();
    await page.locator('#left-body .tile').nth(1).click();
    await page.waitForTimeout(700);
    const timecode1 = await page.textContent('#timecode');
    check(/\/ 00:06/.test(timecode1), 'timeline length is 6 s after adding clips', timecode1);
    await shot('04-on-timeline');

    // ---- split the selected clip (clip B, 4 s) at 2 s
    await page.click('#tp-start');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('s');
    await page.waitForTimeout(300);
    let doc = await saved(page, apiCall);
    const clipCount = doc.tracks.reduce((n, t) => n + t.clips.length, 0);
    check(clipCount === 3, 'split makes 3 clips', 'clips=' + clipCount);

    // ---- undo and redo
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    doc = await saved(page, apiCall);
    check(doc.tracks.reduce((n, t) => n + t.clips.length, 0) === 2, 'undo removes the split');
    await page.keyboard.press('Control+y');
    await page.waitForTimeout(200);
    doc = await saved(page, apiCall);
    check(doc.tracks.reduce((n, t) => n + t.clips.length, 0) === 3, 'redo restores the split');

    // ---- text
    await page.click('#tab-text');
    await page.locator('#left-body .preset').first().click();
    await page.waitForTimeout(400);
    await page.fill('#props textarea', 'Hello smoke test');
    await page.waitForTimeout(300);
    doc = await saved(page, apiCall);
    const textClips = doc.tracks.flatMap((t) => t.clips).filter((c) => c.text);
    check(textClips.length === 1 && textClips[0].text.content === 'Hello smoke test', 'text clip added and edited');
    await shot('05-text');

    // ---- select the clip on the bottom video track by clicking the canvas, then add a transition + filter
    const box = await page.locator('#tl-canvas').boundingBox();
    // rows top-down: text, video 2, video 1, audio 1 -> video 1 is row index 2
    await page.mouse.click(box.x + 150, box.y + 24 + 2 * 44 + 22);
    await page.waitForTimeout(250);
    check(await page.locator('#props .sec h4', { hasText: 'Colour' }).count() === 1, 'clicking a clip selects it (colour section visible)');
    await page.click('#tab-trans');
    await page.locator('#left-body .tile', { hasText: 'Dissolve' }).click();
    await page.click('#tab-filters');
    await page.locator('#left-body .tile', { hasText: 'Mono' }).click();
    await page.waitForTimeout(300);
    doc = await saved(page, apiCall);
    const vclip = doc.tracks.flatMap((t) => t.clips).find((c) => c.media && c.transition_in);
    check(!!vclip && vclip.transition_in.kind === 'dissolve', 'transition applied');
    check(!!vclip && vclip.adj && vclip.adj.saturation === 0, 'filter applied (mono sets saturation to 0)');
    await shot('06-transition-filter');

    // ---- stock library
    await page.click('#tab-stock');
    await page.waitForSelector('#left-body .tile', { timeout: 5000 });
    const stockTiles = await page.locator('#left-body .tile').count();
    check(stockTiles >= 6, 'stock library lists items', 'tiles=' + stockTiles);
    await page.click('#tab-audio');
    await page.waitForSelector('#left-body .sec .btn.sm', { timeout: 5000 });
    ok('audio panel lists sounds');

    // ---- playback does not throw
    await page.click('#tp-start');
    await page.click('#tp-play');
    await page.waitForTimeout(1200);
    await page.click('#tp-play');
    ok('play and pause run');

    // ---- keyboard help and settings
    await page.keyboard.press('?');
    await page.waitForSelector('.modal table.keys');
    await page.keyboard.press('Escape');
    ok('shortcut list opens and closes');

    // ---- export
    await page.click('#btn-export');
    await page.waitForSelector('.modal');
    await page.selectOption('.modal select[aria-label="Resolution"]', '720');
    await page.selectOption('.modal select[aria-label="Quality"]', 'low');
    const outFile = path.join(outDir, 'smoke-export.mp4');
    try { fs.unlinkSync(outFile); } catch (e) { /* none */ }
    await page.fill('.modal input[aria-label="Save to"]', outFile);
    await page.click('.modal footer .btn.primary');
    await page.waitForFunction(() => /Done\.|did not finish|cancelled/.test(document.querySelector('.modal [role=status]')?.textContent || ''), null, { timeout: 180000 });
    const exportStatus = await page.textContent('.modal [role=status]');
    check(/Done\./.test(exportStatus), 'export finishes', exportStatus.slice(0, 120));
    await shot('07-exported');
    await page.keyboard.press('Escape');

    // ---- inspect the exported file
    if (fs.existsSync(outFile)) {
      const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,duration', '-of', 'json', outFile]).toString());
      const v = info.streams.find((s) => s.codec_type === 'video');
      const a = info.streams.find((s) => s.codec_type === 'audio');
      check(!!v && v.width === 1280 && v.height === 720, 'exported video is 1280x720', v ? `${v.codec_name} ${v.width}x${v.height}` : 'no video stream');
      check(!!a, 'exported file has audio', a ? a.codec_name : 'no audio stream');
      const dur = parseFloat((v || {}).duration || '0');
      check(Math.abs(dur - 6) < 0.5, 'exported length is about 6 s', 'dur=' + dur);
      // frame at 1 s and 4 s should not be black; brightness via signalstats
      for (const ts of ['0.5', '4.5']) {
        const out = execFileSync('ffmpeg', ['-v', 'error', '-ss', ts, '-i', outFile, '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-']).toString();
        const m = /YAVG=([\d.]+)/.exec(out);
        check(!!m && parseFloat(m[1]) > 20, `frame at ${ts}s is not black`, m ? 'YAVG=' + m[1] : out.slice(0, 80));
      }
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', outFile, '-frames:v', '1', path.join(outDir, 'export-frame-1s.png')]);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '4.5', '-i', outFile, '-frames:v', '1', path.join(outDir, 'export-frame-4s.png')]);
    } else {
      bad('exported file exists', outFile);
    }

    // ---- reopen from home
    await page.click('#btn-home');
    await page.waitForSelector('.card:not(.new)', { timeout: 8000 });
    await page.locator('.card:not(.new)').first().click();
    await page.waitForSelector('#editor:not([hidden])');
    await page.waitForTimeout(500);
    const timecode2 = await page.textContent('#timecode');
    check(/\/ 00:06/.test(timecode2), 'project reopens with its clips', timecode2);
    await shot('08-reopened');
  } catch (e) {
    bad('test aborted', e.message.split('\n')[0]);
    try { await shot('99-failure'); } catch (e2) { /* ignore */ }
  }

  await browser.close();
  const unique = [...new Set(problems)];
  console.log('\n' + (unique.length ? unique.length + ' problem(s):\n - ' + unique.join('\n - ') : 'no problems'));
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ steps, problems: unique }, null, 2));
  process.exit(unique.length ? 1 : 0);
})();

// the editor autosaves ~0.8 s after a change; wait for it, then read the saved project through the API
async function saved(page, apiCall) {
  await page.waitForTimeout(1100);
  const list = await apiCall('project_list');
  const p = list.data.find((x) => x.name === 'Smoke test');
  return (await apiCall('project_load', { id: p.id })).data;
}

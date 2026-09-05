// End-to-end smoke test: loads extension/ into Chromium, records ~3 s of the
// screen via the library page, and checks the recording lands in the list.
// Run: node tools/smoke.mjs   (needs a display or xvfb-run)
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../extension');
const userDataDir = mkdtempSync(resolve(tmpdir(), 'snippetvideo-'));
const errors = [];

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  executablePath: process.env.CHROME_PATH,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--auto-select-desktop-capture-source=Entire screen',
    '--no-first-run',
  ],
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const logs = [];
sw.on('console', (m) => {
  logs.push(`sw ${m.type()}: ${m.text()}`);
  if (m.type() === 'error') errors.push(`sw: ${m.text()}`);
});
async function dump(label) {
  console.error(label, 'state:', JSON.stringify(await sw.evaluate(() => chrome.storage.session.get('recorderState'))));
  console.error('logs:\n' + logs.join('\n'));
  await context.close();
  process.exit(1);
}
const extId = new URL(sw.url()).host;
console.log('extension', extId, 'sw', sw.url());

// Settings: no countdown so the test is quick.
const options = await context.newPage();
options.on('pageerror', (e) => errors.push(`options: ${e.message}`));
await options.goto(`chrome-extension://${extId}/options.html`);
await options.selectOption('#countdownSeconds', '0');
await options.selectOption('#fps', '30');
await options.waitForTimeout(200);

const lib = await context.newPage();
lib.on('pageerror', (e) => errors.push(`library: ${e.message}`));
lib.on('console', (m) => {
  logs.push(`lib ${m.type()}: ${m.text()}`);
  if (m.type() === 'error') errors.push(`library console: ${m.text()}`);
});
lib.on('pageerror', (e) => logs.push(`lib pageerror: ${e.message}`));
await lib.goto(`chrome-extension://${extId}/library.html`);
await lib.waitForSelector('.empty');
console.log('library shows empty state');

const stateText = () => lib.locator('#stateText').textContent();
// Simulate the toolbar click (chrome.action.onClicked) from the service worker.
await sw.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  chrome.action.onClicked.dispatch(tab);
});
try {
  await lib.waitForFunction(() => document.getElementById('stateText').textContent === 'Recording', null, { timeout: 15000 });
} catch {
  await dump('start failed.');
}
console.log('recording started; title =', await lib.title());
await lib.waitForTimeout(1500);

await lib.click('#pause');
await lib.waitForFunction(() => document.getElementById('stateText').textContent === 'Paused', null, { timeout: 5000 });
console.log('paused');
await lib.waitForTimeout(800);
await lib.click('#pause');
await lib.waitForFunction(() => document.getElementById('stateText').textContent === 'Recording', null, { timeout: 5000 });
console.log('resumed');
await lib.waitForTimeout(1500);

await lib.click('#record');
try {
  await lib.waitForFunction(() => document.querySelectorAll('.card').length === 1, null, { timeout: 30000 });
} catch {
  await dump('stop failed.');
}
await lib.waitForFunction(() => document.getElementById('stateText').textContent === 'Idle', null, { timeout: 30000 });
const meta = await lib.locator('.card .meta').textContent();
console.log('recording listed:', meta);

// Verify the saved file is a WebM with a patched duration (seekable).
const probe = await lib.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('recordings');
  const files = [];
  for await (const [name, h] of dir.entries()) {
    const f = await h.getFile();
    const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
    const url = URL.createObjectURL(f);
    const video = document.createElement('video');
    video.src = url;
    const duration = await new Promise((res) => {
      video.onloadedmetadata = () => res(video.duration);
      video.onerror = () => res(-1);
    });
    files.push({ name, size: f.size, magic: Array.from(head).map((b) => b.toString(16)).join(' '), duration });
  }
  return files;
});
console.log('opfs files:', JSON.stringify(probe));
const file = probe[0];
if (!file || file.magic !== '1a 45 df a3') errors.push('file is not a WebM/EBML container');
if (!file || !(file.duration > 2 && file.duration < 10)) errors.push(`unexpected media duration ${file?.duration}`);

// Auto-download (on by default) should have produced a download item.
const downloads = await sw.evaluate(() => chrome.downloads.search({}).then((d) => d.map((x) => ({ state: x.state, filename: x.filename }))));
console.log('downloads:', JSON.stringify(downloads));
if (!downloads.some((d) => d.state === 'complete')) errors.push('auto-download did not complete');

// Orphan recovery: drop an unindexed file into OPFS and reload the library.
await lib.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('recordings');
  const h = await dir.getFileHandle('orphan-test.webm', { create: true });
  const w = await h.createWritable();
  await w.write(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]));
  await w.close();
});
await lib.reload();
await lib.waitForFunction(() => document.querySelectorAll('.card').length === 2, null, { timeout: 10000 });
console.log('orphan recovered:', (await lib.locator('.badge').allTextContents()).join(','));

// ---------- editor ----------
const realCard = lib.locator('.card', { hasNotText: 'recovered' }).first();
const [editor] = await Promise.all([context.waitForEvent('page'), realCard.getByRole('button', { name: 'Edit' }).click()]);
editor.on('pageerror', (e) => errors.push(`editor: ${e.message}`));
editor.on('console', (m) => m.type() === 'error' && errors.push(`editor console: ${m.text()}`));
await editor.waitForLoadState();
await editor.waitForSelector('.tl-clip');
console.log('editor opened:', await editor.title(), '| time:', await editor.locator('#time').textContent());

await editor.waitForFunction(() => [...document.querySelectorAll('.tl-thumbs img')].some((i) => i.src.startsWith('data:image')), null, { timeout: 15000 });
console.log('thumbnails rendered');

// Play for a moment, then pause.
await editor.keyboard.press('Space');
await editor.waitForTimeout(1200);
await editor.keyboard.press('Space');
const played = await editor.evaluate(() => window.__snippet.project && document.getElementById('time').textContent);
console.log('after playback:', played);
if (!/^0:0[1-3]\.\d\d \//.test(played)) errors.push(`playback did not advance: ${played}`);

// Split in the middle, undo, redo, then reload to confirm autosave.
await editor.evaluate(() => window.__snippet.seek(1500));
await editor.keyboard.press('s');
await editor.waitForFunction(() => document.querySelectorAll('.tl-clip').length === 2);
await editor.keyboard.press('Control+z');
await editor.waitForFunction(() => document.querySelectorAll('.tl-clip').length === 1);
await editor.keyboard.press('Control+Shift+z');
await editor.waitForFunction(() => document.querySelectorAll('.tl-clip').length === 2);
await editor.waitForFunction(() => document.getElementById('saved').textContent === 'Saved');
await editor.reload();
await editor.waitForFunction(() => document.querySelectorAll('.tl-clip').length === 2);
const durations = await editor.evaluate(() => window.__snippet.project.clips.map((c) => c.outMs - c.inMs));
console.log('split persisted, clip durations:', durations);
if (process.env.SHOT) {
  await editor.setViewportSize({ width: 1280, height: 760 });
  await editor.locator('.tl-clip').first().click();
  await editor.waitForTimeout(500);
  await editor.screenshot({ path: process.env.SHOT });
}
if (Math.abs(durations[0] - 1500) > 5) errors.push(`first clip should be 1500 ms, got ${durations[0]}`);

// Select the second clip and delete it.
await editor.locator('.tl-clip').nth(1).click();
await editor.keyboard.press('Delete');
await editor.waitForFunction(() => document.querySelectorAll('.tl-clip').length === 1);
console.log('delete works');

// ---------- freeze, crop, zoom, fade ----------
const clipId = await editor.evaluate(() => window.__snippet.project.clips[0].id);
await editor.evaluate(() => window.__snippet.seek(400));
await editor.evaluate(() => window.__snippet.freeze());
await editor.waitForFunction(() => document.querySelectorAll('.tl-clip').length === 3);
const kinds = await editor.evaluate(() => window.__snippet.project.clips.map((c) => c.kind));
console.log('after freeze, clip kinds:', kinds);
if (kinds[1] !== 'freeze') errors.push(`expected a freeze clip in the middle, got ${JSON.stringify(kinds)}`);
await editor.waitForSelector('.tl-clip.freeze');

await editor.evaluate((id) => window.__snippet.select(id), clipId);
await editor.evaluate(() => window.__snippet.seek(100)); // inside clipId's own 0-400ms span, not the freeze clip after it
await editor.evaluate((id) => window.__snippet.setCrop(id, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }), clipId);
await editor.evaluate((id) => window.__snippet.addZoomKeyframe(id, { tMs: 0, x: 0.5, y: 0.5, scale: 2 }), clipId);
await editor.evaluate((id) => window.__snippet.setFade(id, { fadeInMs: 200, fadeOutMs: 200 }), clipId);
const effects = await editor.evaluate((id) => {
  const c = window.__snippet.project.clips.find((x) => x.id === id);
  return { crop: c.crop, zoomKeyframes: c.zoomKeyframes, fadeInMs: c.fadeInMs, fadeOutMs: c.fadeOutMs };
}, clipId);
console.log('clip effects:', JSON.stringify(effects));
if (!effects.crop || effects.crop.w !== 0.5) errors.push('crop was not applied');
if (!effects.zoomKeyframes?.length) errors.push('zoom keyframe was not added');
if (effects.fadeInMs !== 200 || effects.fadeOutMs !== 200) errors.push('fade was not applied');
await editor.waitForSelector('#zoomList .row');
const transform = await editor.evaluate(() => document.querySelector('.stage video:not([hidden])')?.style.transform);
console.log('preview transform with crop+zoom:', transform);
if (!transform || transform === 'none') errors.push('crop/zoom did not change the preview transform');

// ---------- image slide ----------
const pngPath = resolve(userDataDir, 'logo.png');
// A minimal 1x1 PNG, valid enough for <img> to decode.
writeFileSync(
  pngPath,
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);
await editor.locator('#imageFile').setInputFiles(pngPath);
await editor.waitForFunction(() => document.querySelectorAll('.tl-clip').length === 4, null, { timeout: 10000 });
const lastKind = await editor.evaluate(() => window.__snippet.project.clips.at(-1).kind);
console.log('image slide added, last clip kind:', lastKind);
if (lastKind !== 'image') errors.push('image slide was not added as the last clip');

// ---------- annotation layer ----------
await editor.evaluate(() => window.__snippet.seek(0));
await editor.click('#layerAddText');
await editor.waitForSelector('.tl-layer');
await editor.waitForSelector('.stage-layer.text');
console.log('annotation layer added and rendered on the stage');

// The library lists the project.
await lib.bringToFront();
await lib.waitForFunction(() => document.querySelectorAll('#projects .card').length === 1);
console.log('project listed in library');

await context.close();
if (errors.length) {
  console.error('FAILURES:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('SMOKE OK');

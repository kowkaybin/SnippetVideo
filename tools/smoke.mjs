// End-to-end smoke test: loads extension/ into Chromium, records ~3 s of the
// screen via the library page, and checks the recording lands in the list.
// Run: node tools/smoke.mjs   (needs a display or xvfb-run)
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
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

await context.close();
if (errors.length) {
  console.error('FAILURES:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('SMOKE OK');

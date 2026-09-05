import { STATE_KEY, send } from '../shared/messages.js';
import * as recorder from './recorder.js';
import { listRecordings, readRecordingFile, recoverOrphans, removeRecording } from '../shared/library.js';
import { formatBytes, formatDuration } from '../shared/format.js';
import { QUALITY_PRESETS } from '../shared/settings.js';

const $ = (id) => document.getElementById(id);
const dot = $('dot');
const timer = $('timer');
const stateText = $('stateText');
const recordBtn = $('record');
const pauseBtn = $('pause');
const list = $('list');

// ---------- recorder status ----------

function renderState(state) {
  dot.className = `dot ${state.phase}`;
  let title = 'SnippetVideo';
  let elapsed = 0;
  let text = 'Idle';
  let recordLabel = 'Record';
  let pauseEnabled = false;
  let pauseLabel = 'Pause';
  switch (state.phase) {
    case 'picking':
      text = 'Choose what to record in Chrome’s picker…';
      recordLabel = 'Cancel';
      break;
    case 'countdown':
      text = `Starting in ${state.remaining}…`;
      title = `${state.remaining}… SnippetVideo`;
      recordLabel = 'Cancel';
      break;
    case 'recording':
      elapsed = state.elapsedMs;
      text = 'Recording';
      title = `● ${formatDuration(elapsed)} – SnippetVideo`;
      recordLabel = 'Stop';
      pauseEnabled = true;
      break;
    case 'paused':
      elapsed = state.elapsedMs;
      text = 'Paused';
      title = `‖ ${formatDuration(elapsed)} – SnippetVideo`;
      recordLabel = 'Stop';
      pauseEnabled = true;
      pauseLabel = 'Resume';
      break;
    case 'stopping':
      text = 'Saving…';
      break;
    case 'error':
      text = `Error: ${state.message}`;
      break;
  }
  timer.textContent = formatDuration(elapsed);
  stateText.textContent = text;
  recordBtn.textContent = recordLabel;
  recordBtn.disabled = state.phase === 'stopping';
  pauseBtn.disabled = !pauseEnabled;
  pauseBtn.textContent = pauseLabel;
  document.title = title;
}

recordBtn.addEventListener('click', () => void send({ target: 'background', type: 'ui:toggle-recording' }));
pauseBtn.addEventListener('click', () => void send({ target: 'background', type: 'ui:toggle-pause' }));
$('openSettings').addEventListener('click', () => void chrome.runtime.openOptionsPage());

// ---------- recorder host ----------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'control') return;
  const run = async () => {
    switch (message.type) {
      case 'start':
        await recorder.start(message.settings);
        break;
      case 'stop':
        await recorder.stop();
        break;
      case 'pause':
        recorder.pause();
        break;
      case 'resume':
        recorder.resume();
        break;
    }
  };
  void run().finally(() => sendResponse(undefined));
  return true;
});

window.addEventListener('beforeunload', (e) => {
  if (!recorder.isActive()) return;
  e.preventDefault();
  e.returnValue = '';
});

chrome.storage.session.onChanged.addListener((changes) => {
  const next = changes[STATE_KEY]?.newValue;
  if (next) renderState(next);
});
chrome.storage.local.onChanged.addListener((changes) => {
  if (changes['recordings']) void renderList();
});

// ---------- recordings ----------

const objectUrls = new Map();

async function urlFor(id) {
  const cached = objectUrls.get(id);
  if (cached) return cached;
  const file = await readRecordingFile(id);
  const url = URL.createObjectURL(file);
  objectUrls.set(id, url);
  return url;
}

function card(r) {
  const el = document.createElement('div');
  el.className = 'panel card';
  const info = document.createElement('div');
  const name = document.createElement('div');
  name.textContent = r.name;
  for (const [flag, label] of [
    [r.autoStopped, 'auto-stopped'],
    [r.recovered, 'recovered'],
  ]) {
    if (!flag) continue;
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = label;
    name.append(' ', b);
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = [
    new Date(r.createdAt).toLocaleString(),
    r.durationMs > 0 ? formatDuration(r.durationMs) : '',
    formatBytes(r.bytes),
    r.width && r.height ? `${r.width}×${r.height}` : '',
    `${r.fps} fps`,
    QUALITY_PRESETS[r.quality]?.label ?? r.quality,
  ]
    .filter(Boolean)
    .join(' · ');
  info.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const play = document.createElement('button');
  play.textContent = 'Play';
  const download = document.createElement('button');
  download.textContent = 'Download';
  const del = document.createElement('button');
  del.textContent = 'Delete';
  del.className = 'danger';
  actions.append(play, download, del);
  el.append(info, actions);

  play.addEventListener('click', async () => {
    let video = el.querySelector('video');
    if (video) {
      video.remove();
      play.textContent = 'Play';
      return;
    }
    video = document.createElement('video');
    video.controls = true;
    video.src = await urlFor(r.id);
    el.append(video);
    play.textContent = 'Hide';
    void video.play();
  });
  download.addEventListener('click', async () => {
    const a = document.createElement('a');
    a.href = await urlFor(r.id);
    a.download = `${r.name}.webm`;
    a.click();
  });
  del.addEventListener('click', async () => {
    if (!confirm(`Delete ${r.name}? This cannot be undone.`)) return;
    const url = objectUrls.get(r.id);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(r.id);
    await removeRecording(r.id);
  });
  return el;
}

async function renderList() {
  const items = await listRecordings();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'panel empty';
    empty.textContent = 'No recordings yet. Click the toolbar icon or press Alt+Shift+R to start.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...items.map(card));
}

async function init() {
  const state = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] ?? { phase: 'idle' };
  renderState(state);
  await renderList();
  // Adopt files left behind by a control window that closed mid-recording.
  if (state.phase === 'idle' && (await recoverOrphans()) > 0) await renderList();
}
void init();

/**
 * Service worker: owns the recorder state machine, the toolbar button, hotkeys,
 * and the control window lifecycle. The media stream and MediaRecorder live in
 * the control window (library.html), because Chrome binds a desktopCapture
 * stream to the page that opened the picker.
 */
import { loadSettings } from '../shared/settings.js';
import { STATE_KEY, send } from '../shared/messages.js';
import { addRecording } from '../shared/library.js';
import { formatBadge, formatDuration } from '../shared/format.js';

const LIBRARY_URL = 'library.html';
const MENU_LIBRARY = 'open-library';

// ---------- state ----------

async function getState() {
  const stored = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY];
  return stored ?? { phase: 'idle' };
}

async function setState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: state });
  await reflectState(state);
}

// Root-absolute: relative paths would resolve against background/, not the extension root.
const iconSet = (name) => Object.fromEntries([16, 32, 48, 128].map((px) => [px, `/icons/${name}-${px}.png`]));
const ICONS = { idle: iconSet('idle'), rec: iconSet('rec'), pause: iconSet('pause') };

async function reflectState(state) {
  let badge = '';
  let color = '#6e6e76';
  let icon = ICONS.idle;
  let title = 'SnippetVideo: click to record';
  switch (state.phase) {
    case 'picking':
      badge = '…';
      title = 'SnippetVideo: choose what to record (click to cancel)';
      break;
    case 'countdown':
      badge = String(state.remaining);
      color = '#ea8a00';
      icon = ICONS.rec;
      title = `SnippetVideo: starting in ${state.remaining}s (click to cancel)`;
      break;
    case 'recording':
      badge = formatBadge(state.elapsedMs);
      color = '#dc2626';
      icon = ICONS.rec;
      title = `SnippetVideo: recording ${formatDuration(state.elapsedMs)} (click to stop)`;
      break;
    case 'paused':
      badge = 'II';
      color = '#ea8a00';
      icon = ICONS.pause;
      title = `SnippetVideo: paused at ${formatDuration(state.elapsedMs)} (click to stop)`;
      break;
    case 'stopping':
      badge = '…';
      color = '#dc2626';
      icon = ICONS.rec;
      title = 'SnippetVideo: saving…';
      break;
    case 'error':
      badge = 'ERR';
      color = '#dc2626';
      title = `SnippetVideo error: ${state.message}`;
      break;
  }
  // Cosmetic; never let a badge/icon failure derail the recorder.
  await Promise.allSettled([
    chrome.action.setBadgeText({ text: badge }),
    chrome.action.setBadgeBackgroundColor({ color }),
    chrome.action.setBadgeTextColor({ color: '#ffffff' }),
    chrome.action.setIcon({ path: icon }),
    chrome.action.setTitle({ title }),
  ]).then((results) => {
    for (const r of results) if (r.status === 'rejected') console.warn('action update failed:', r.reason);
  });
}

// ---------- control window ----------

const BOUNDS_KEY = 'controlWindowBounds'; // { left?, top?, width, height }

async function findControlTab() {
  const [tab] = await chrome.tabs.query({ url: chrome.runtime.getURL(LIBRARY_URL) });
  return tab;
}

/**
 * The control window is a small popup (no tabs, no toolbar) that shows the
 * timer and the recordings list, hosts the recorder, and anchors Chrome's
 * source picker. It can live on a second monitor.
 */
async function ensureControlWindow(focus) {
  const existing = await findControlTab();
  if (existing?.id !== undefined) {
    if (focus) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
    }
    return existing;
  }
  const saved = (await chrome.storage.local.get(BOUNDS_KEY))[BOUNDS_KEY];
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(LIBRARY_URL),
    type: 'popup',
    focused: focus,
    width: saved?.width ?? 460,
    height: saved?.height ?? 640,
    ...(saved?.left !== undefined ? { left: saved.left } : {}),
    ...(saved?.top !== undefined ? { top: saved.top } : {}),
  });
  const tabId = win?.tabs?.[0]?.id ?? (await chrome.tabs.query({ windowId: win?.id }))[0]?.id;
  if (tabId === undefined) throw new Error('Could not open the control window');
  return waitForTabLoad(tabId);
}

/** The page must have loaded (and registered its message listener) before we talk to it. */
async function waitForTabLoad(tabId) {
  for (let i = 0; i < 50; i++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url) return tab;
    await new Promise((r) => setTimeout(r, 100));
  }
  return chrome.tabs.get(tabId);
}

chrome.windows.onBoundsChanged.addListener((win) => {
  if (win.type !== 'popup' || win.id === undefined) return;
  void chrome.tabs.query({ windowId: win.id, url: chrome.runtime.getURL(LIBRARY_URL) }).then((tabs) => {
    if (tabs.length === 0) return;
    const bounds = { left: win.left, top: win.top, width: win.width ?? 460, height: win.height ?? 640 };
    void chrome.storage.local.set({ [BOUNDS_KEY]: bounds });
  });
});

// If the control window goes away mid-recording the recorder died with it.
// Chunks already written to OPFS are recovered by the library page on next open.
chrome.tabs.onRemoved.addListener(() => {
  void (async () => {
    const state = await getState();
    if (state.phase === 'idle' || state.phase === 'error') return;
    if (!(await findControlTab())) await setState({ phase: 'idle' });
  })();
});

// ---------- actions ----------

async function startRecording() {
  const state = await getState();
  if (state.phase !== 'idle' && state.phase !== 'error') return;
  try {
    await setState({ phase: 'picking' });
    const settings = await loadSettings();
    // The picker dialog attaches to the control window, so it must be in front.
    await ensureControlWindow(true);
    await send({ target: 'control', type: 'start', settings });
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
  }
}

async function stopRecording() {
  const state = await getState();
  if (state.phase === 'idle' || state.phase === 'stopping' || state.phase === 'error') return;
  if (!(await findControlTab())) {
    await setState({ phase: 'idle' });
    return;
  }
  if (state.phase === 'recording' || state.phase === 'paused') await setState({ phase: 'stopping' });
  await send({ target: 'control', type: 'stop' });
}

async function toggleRecording() {
  const state = await getState();
  if (state.phase === 'idle' || state.phase === 'error') await startRecording();
  else await stopRecording();
}

async function togglePause() {
  const state = await getState();
  if (state.phase === 'recording') await send({ target: 'control', type: 'pause' });
  else if (state.phase === 'paused') await send({ target: 'control', type: 'resume' });
}

async function fail(message) {
  await setState({ phase: 'error', message });
  setTimeout(() => {
    void getState().then((s) => {
      if (s.phase === 'error') void setState({ phase: 'idle' });
    });
  }, 6000);
}

/** Restores focus to whichever window was active before the picker took it. */
async function refocus(previousWindowId) {
  const control = await findControlTab();
  if (previousWindowId === undefined || previousWindowId === control?.windowId) return;
  await chrome.windows.update(previousWindowId, { focused: true }).catch(() => undefined);
}

let windowBeforePicker;

/** Waits for a chrome.downloads item to finish; the page keeps the blob URL alive meanwhile. */
function waitForDownload(downloadId) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, 5 * 60 * 1000);
    function done() {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve();
    }
    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') done();
    }
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

// ---------- wiring ----------

chrome.runtime.onInstalled.addListener(() => {
  void setState({ phase: 'idle' });
  chrome.contextMenus.create({ id: MENU_LIBRARY, title: 'Recordings library', contexts: ['action'] });
});
chrome.runtime.onStartup.addListener(() => void setState({ phase: 'idle' }));

chrome.action.onClicked.addListener((tab) => {
  windowBeforePicker = tab.windowId;
  void toggleRecording();
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-recording') {
    windowBeforePicker = tab?.windowId;
    void toggleRecording();
  } else if (command === 'toggle-pause') void togglePause();
  else if (command === 'open-library') void ensureControlWindow(true);
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_LIBRARY) void ensureControlWindow(true);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'background') return;
  void handleMessage(message).finally(() => sendResponse(undefined));
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'countdown':
      await refocus(windowBeforePicker);
      windowBeforePicker = undefined;
      await setState({ phase: 'countdown', remaining: message.remaining });
      break;
    case 'started':
      await refocus(windowBeforePicker);
      windowBeforePicker = undefined;
      await setState({ phase: 'recording', elapsedMs: 0 });
      break;
    case 'tick':
      await setState({ phase: message.paused ? 'paused' : 'recording', elapsedMs: message.elapsedMs });
      break;
    case 'cancelled':
      windowBeforePicker = undefined;
      await setState({ phase: 'idle' });
      break;
    case 'failed':
      windowBeforePicker = undefined;
      await fail(message.message);
      break;
    case 'finished': {
      await addRecording(message.recording);
      await setState({ phase: 'idle' });
      const settings = await loadSettings();
      if (settings.autoDownload) {
        try {
          const id = await chrome.downloads.download({
            url: message.blobUrl,
            filename: `SnippetVideo/${message.recording.name}.webm`,
            conflictAction: 'uniquify',
            saveAs: false,
          });
          await waitForDownload(id);
        } catch (err) {
          console.warn('auto-download failed', err);
        }
      }
      break;
    }
    case 'ui:toggle-recording':
      windowBeforePicker = undefined;
      await toggleRecording();
      break;
    case 'ui:toggle-pause':
      await togglePause();
      break;
    case 'ui:open-library':
      await ensureControlWindow(true);
      break;
  }
}

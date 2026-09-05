/** @typedef {'tab'|'window'|'screen'} SourceKind */
/** @typedef {25|30|50|60} Fps */
/** @typedef {'low'|'medium'|'high'|'ultra'} QualityPreset */
/** @typedef {'system'|'light'|'dark'} Theme */

/**
 * @typedef {object} Settings
 * @property {SourceKind} defaultSource   Which pane Chrome's picker opens on.
 * @property {Fps} fps
 * @property {QualityPreset} quality
 * @property {0|3|5|10} countdownSeconds  Seconds before recording starts. 0 disables.
 * @property {number} maxDurationMinutes  Hard stop after this many minutes.
 * @property {boolean} autoDownload       Download as soon as a recording finishes.
 * @property {boolean} includeCursor      Include the mouse cursor (best effort).
 * @property {Theme} theme                Appearance of every SnippetVideo page.
 */

export const FPS_OPTIONS = [25, 30, 50, 60];
export const COUNTDOWN_OPTIONS = [0, 3, 5, 10];
export const THEME_OPTIONS = [
  { value: 'system', label: 'Match system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export const QUALITY_PRESETS = {
  low: { label: 'Low', bitsPerSecond: 2_000_000, hint: '2 Mbps, small files, soft text' },
  medium: { label: 'Medium', bitsPerSecond: 5_000_000, hint: '5 Mbps, good for most screen content' },
  high: { label: 'High', bitsPerSecond: 10_000_000, hint: '10 Mbps, crisp text and motion' },
  ultra: { label: 'Ultra', bitsPerSecond: 20_000_000, hint: '20 Mbps, near-lossless, large files' },
};

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  defaultSource: 'tab',
  fps: 30,
  quality: 'high',
  countdownSeconds: 3,
  maxDurationMinutes: 15,
  autoDownload: true,
  includeCursor: true,
  theme: 'system',
};

const KEY = 'settings';

/** @returns {Promise<Settings>} */
export async function loadSettings() {
  const stored = (await chrome.storage.sync.get(KEY))[KEY];
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

/** @param {Settings} settings */
export async function saveSettings(settings) {
  await chrome.storage.sync.set({ [KEY]: settings });
}

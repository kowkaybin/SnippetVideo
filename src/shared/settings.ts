export type SourceKind = 'tab' | 'window' | 'screen';
export type Fps = 25 | 30 | 50 | 60;
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  /** Which pane Chrome's picker opens on. The user can still switch panes. */
  defaultSource: SourceKind;
  fps: Fps;
  quality: QualityPreset;
  /** Seconds before recording starts after picking a source. 0 disables. */
  countdownSeconds: 0 | 3 | 5 | 10;
  /** Hard stop after this many minutes. */
  maxDurationMinutes: number;
  /** Trigger a browser download as soon as a recording finishes. */
  autoDownload: boolean;
  /** Ask Chrome to include the mouse cursor in the capture (best effort). */
  includeCursor: boolean;
}

export const FPS_OPTIONS: readonly Fps[] = [25, 30, 50, 60];
export const COUNTDOWN_OPTIONS = [0, 3, 5, 10] as const;

export const QUALITY_PRESETS: Record<QualityPreset, { label: string; bitsPerSecond: number; hint: string }> = {
  low: { label: 'Low', bitsPerSecond: 2_000_000, hint: '2 Mbps, small files, soft text' },
  medium: { label: 'Medium', bitsPerSecond: 5_000_000, hint: '5 Mbps, good for most screen content' },
  high: { label: 'High', bitsPerSecond: 10_000_000, hint: '10 Mbps, crisp text and motion' },
  ultra: { label: 'Ultra', bitsPerSecond: 20_000_000, hint: '20 Mbps, near-lossless, large files' },
};

export const DEFAULT_SETTINGS: Settings = {
  defaultSource: 'tab',
  fps: 30,
  quality: 'high',
  countdownSeconds: 3,
  maxDurationMinutes: 15,
  autoDownload: true,
  includeCursor: true,
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.sync.get(KEY))[KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [KEY]: settings });
}

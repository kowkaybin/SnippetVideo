import type { Settings } from './settings';
import type { RecordingMeta } from './library';

/** Recorder lifecycle as seen by every page. Persisted in chrome.storage.session. */
export type RecorderState =
  | { phase: 'idle' }
  | { phase: 'picking' }
  | { phase: 'countdown'; remaining: number }
  | { phase: 'recording'; elapsedMs: number }
  | { phase: 'paused'; elapsedMs: number }
  | { phase: 'stopping' }
  | { phase: 'error'; message: string };

export const STATE_KEY = 'recorderState';

/**
 * Messages from the service worker to the control window, which hosts the
 * recorder. (Chrome binds a desktopCapture stream to the page that opened the
 * picker, so the picker and MediaRecorder must live in the same page.)
 */
export type ToControl =
  | { target: 'control'; type: 'start'; settings: Settings }
  | { target: 'control'; type: 'stop' }
  | { target: 'control'; type: 'pause' }
  | { target: 'control'; type: 'resume' };

/** Progress reports from the control window back to the service worker. */
export type FromControl =
  | { target: 'background'; type: 'countdown'; remaining: number }
  | { target: 'background'; type: 'started' }
  | { target: 'background'; type: 'tick'; elapsedMs: number; paused: boolean }
  | { target: 'background'; type: 'finished'; recording: RecordingMeta; blobUrl: string }
  | { target: 'background'; type: 'failed'; message: string }
  | { target: 'background'; type: 'cancelled' };

/** User intents from UI buttons; the service worker owns the decision. */
export type FromUi =
  | { target: 'background'; type: 'ui:toggle-recording' }
  | { target: 'background'; type: 'ui:toggle-pause' };

export type AnyMessage = ToControl | FromControl | FromUi;

export function send(message: AnyMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

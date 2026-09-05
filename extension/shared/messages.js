/**
 * Message protocol between the service worker and the pages. Every message
 * carries a `target`:
 *
 *   'control'    service worker → control window (library.html), which hosts
 *                the recorder. Chrome binds a desktopCapture stream to the page
 *                that opened the picker, so picker and MediaRecorder must live
 *                in the same page.
 *                  { type: 'start', settings } | { type: 'stop' } | { type: 'pause' } | { type: 'resume' }
 *
 *   'background' control window / UI → service worker.
 *                  { type: 'countdown', remaining }
 *                  { type: 'started' }
 *                  { type: 'tick', elapsedMs, paused }
 *                  { type: 'finished', recording, blobUrl }
 *                  { type: 'failed', message }
 *                  { type: 'cancelled' }
 *                  { type: 'ui:toggle-recording' } | { type: 'ui:toggle-pause' }
 *
 * Recorder state, persisted in chrome.storage.session under STATE_KEY:
 *   { phase: 'idle' | 'picking' | 'stopping' }
 *   { phase: 'countdown', remaining }
 *   { phase: 'recording' | 'paused', elapsedMs }
 *   { phase: 'error', message }
 */

export const STATE_KEY = 'recorderState';

/** Fire-and-forget send; a missing receiver is not an error here. */
export function send(message) {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

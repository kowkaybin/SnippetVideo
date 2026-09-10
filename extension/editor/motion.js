/**
 * Motion analysis for auto-purge: how much the picture changes between
 * successive samples of a recording. Browser-bound (a <video> and a small
 * canvas); the decisions about what to cut are in shared/idle.js.
 *
 * Score per sample = pixels whose grey level moved by more than PIXEL_DELTA
 * since the previous sample, per 10,000 pixels - a count, not a mean, so a
 * cursor or a caret (a few dozen pixels) registers while VP9's faint
 * flicker on flat areas does not.
 */
import { VideoSource } from './videoSource.js';

const SAMPLE_W = 320;
const PIXEL_DELTA = 24;

/**
 * @param {File|Blob} file the recording
 * @param {{ fromMs: number, toMs: number, intervalMs?: number, onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} opts
 * @returns {Promise<Array<{ tMs: number, score: number }>>} clip-local samples (tMs relative to fromMs), ascending
 */
export async function analyzeMotion(file, { fromMs, toMs, intervalMs = 200, onProgress = () => {}, signal } = {}) {
  const source = new VideoSource(file);
  try {
    await source.ready;
    const { videoWidth: vw, videoHeight: vh } = source.video;
    const w = SAMPLE_W;
    const h = Math.max(1, Math.round((SAMPLE_W * vh) / Math.max(1, vw)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const times = [];
    for (let t = fromMs; t < toMs; t += intervalMs) times.push(t);
    if (times.length === 0 || times[times.length - 1] < toMs - intervalMs / 2) times.push(Math.max(fromMs, toMs - 1));
    let prev = null;
    const samples = [];
    for (let i = 0; i < times.length; i++) {
      if (signal?.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
      await source.seek(times[i]);
      ctx.drawImage(source.video, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      const grey = new Uint8Array(w * h);
      for (let p = 0, g = 0; p < data.length; p += 4, g++) grey[g] = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
      let changed = 0;
      if (prev) for (let g = 0; g < grey.length; g++) if (Math.abs(grey[g] - prev[g]) > PIXEL_DELTA) changed++;
      samples.push({ tMs: times[i] - fromMs, score: prev ? (changed / grey.length) * 10000 : 0 });
      prev = grey;
      onProgress(i + 1, times.length);
    }
    return samples;
  } finally {
    source.destroy();
  }
}

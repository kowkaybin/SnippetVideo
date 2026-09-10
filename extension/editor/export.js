/**
 * Export: turn a project into one MP4 file, entirely in the editor tab.
 *
 * Decode → composite → encode → mux:
 *  - decode: a hidden <video> per recording, seeked to the exact source time
 *    each output frame needs (the technique thumbs.js already relies on) - no
 *    VideoDecoder, the browser's own WebM demux/decode is simpler and proven.
 *  - composite: for each output frame time, draw onto a canvas with the same
 *    project.js functions the live player uses (clipAt, viewRectAt,
 *    fadeAlphaAt, overlaysAt) and the same drawOverlay the stage canvas uses.
 *    Crop/zoom becomes a real drawImage source rectangle here rather than the
 *    CSS scale() approximation the preview shows - the one place export is
 *    more accurate than the editor, not merely a recording of it.
 *  - encode: VideoEncoder (WebCodecs), one VideoFrame per output frame with an
 *    exact timestamp. Frame-exact by construction; nothing depends on how
 *    fast the machine happens to render.
 *  - mux: the vendored mp4-muxer wraps the chunks into a regular MP4.
 *
 * Runs slower than real time for long timelines (every video frame is a seek
 * plus a draw plus an encode), so it reports progress and can be cancelled.
 */
import { ArrayBufferTarget, Muxer } from '../vendor/mp4-muxer.js';
import { clipAt, clipDuration, fadeAlphaAt, outputSize, overlaysAt, viewRectAt } from '../shared/project.js';
import { drawOverlay } from '../shared/overlayRender.js';
import { readAssetFile, readRecordingFile } from '../shared/library.js';
import { evenSize, fitRect, frameTimesMs, pickCodec } from '../shared/exportPlan.js';

const FULL_VIEW = { x: 0, y: 0, w: 1, h: 1 };

/** A recording as a seekable frame source. */
class VideoSource {
  constructor(file) {
    this.url = URL.createObjectURL(file);
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.preload = 'auto';
    this.video.src = this.url;
    this.lastMs = null;
    this.ready = new Promise((resolve, reject) => {
      this.video.addEventListener('loadeddata', resolve, { once: true });
      this.video.addEventListener('error', () => reject(new Error('recording failed to load')), { once: true });
    });
  }

  /** Resolve once the frame at `ms` is decoded and drawable; a repeat of the last time is free. */
  async seek(ms) {
    await this.ready;
    if (this.lastMs !== null && Math.abs(this.lastMs - ms) < 0.5) return;
    await new Promise((resolve) => {
      const done = () => resolve();
      this.video.addEventListener('seeked', done, { once: true });
      this.video.addEventListener('error', done, { once: true });
      this.video.currentTime = ms / 1000;
    });
    this.lastMs = ms;
  }

  destroy() {
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  });
  return img;
}

/**
 * @param {import('../shared/project.js').Project} project
 * @param {{
 *   recordings: Array<{ id: string, width?: number, height?: number }>,
 *   assets: Array<{ id: string, width?: number, height?: number }>,
 *   fps?: number,
 *   bitsPerSecond?: number,
 *   onProgress?: (done: number, total: number) => void,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{ blob: Blob, codec: string, label: string, width: number, height: number, frames: number }>}
 */
export async function exportProject(project, { recordings, assets, fps = 30, bitsPerSecond = 10_000_000, onProgress = () => {}, signal } = {}) {
  const recordingsById = new Map(recordings.map((r) => [r.id, r]));
  const assetsById = new Map(assets.map((a) => [a.id, a]));
  const { width, height } = evenSize(outputSize(project, recordingsById, assetsById));
  const times = frameTimesMs(project.clips.reduce((sum, c) => sum + clipDuration(c), 0), fps);
  if (times.length === 0) throw new Error('Nothing to export - the project is empty.');
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser has no WebCodecs VideoEncoder.');

  const picked = await pickCodec({ width, height, fps, bitsPerSecond }, (c) => VideoEncoder.isConfigSupported(c));
  if (!picked) throw new Error(`No supported video encoder for ${width}x${height} (tried H.264, AV1, VP9).`);

  // Every recording/asset the timeline references, loaded up front.
  const sources = new Map();
  const images = new Map();
  const throwIfCancelled = () => {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
  };
  try {
    for (const clip of project.clips) {
      if (clip.kind === 'image' && !images.has(clip.assetId)) images.set(clip.assetId, await loadImage(await readAssetFile(clip.assetId)));
      else if (clip.kind !== 'image' && !sources.has(clip.recordingId)) sources.set(clip.recordingId, new VideoSource(await readRecordingFile(clip.recordingId)));
    }
    for (const overlay of project.overlays ?? []) {
      const id = overlay.source === 'image' ? overlay.content.assetId : null;
      if (id && !images.has(id)) images.set(id, await loadImage(await readAssetFile(id)));
    }
    await Promise.all([...sources.values()].map((s) => s.ready));
    throwIfCancelled();

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({ target, video: { codec: picked.mux, width, height, frameRate: fps }, fastStart: 'in-memory' });
    let encodeError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        encodeError = e;
      },
    });
    encoder.configure({ ...picked.config, latencyMode: 'quality' });
    const keyEvery = Math.max(1, Math.round(fps * 2)); // a keyframe every ~2s keeps seeking snappy without bloating the file
    const frameUs = Math.round(1e6 / fps);

    try {
      for (let i = 0; i < times.length; i++) {
        throwIfCancelled();
        if (encodeError) throw encodeError;
        await renderFrame(ctx, project, times[i], width, height, sources, images);
        const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: frameUs });
        encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
        frame.close();
        // Don't let the encoder queue run away: wait for it to drain a little if we're ahead.
        if (encoder.encodeQueueSize > 8) await new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true }));
        onProgress(i + 1, times.length);
      }
      await encoder.flush();
      if (encodeError) throw encodeError;
    } finally {
      if (encoder.state !== 'closed') encoder.close();
    }
    muxer.finalize();
    return { blob: new Blob([target.buffer], { type: 'video/mp4' }), codec: picked.codec, label: picked.label, width, height, frames: times.length };
  } finally {
    for (const s of sources.values()) s.destroy();
    for (const img of images.values()) URL.revokeObjectURL(img.src);
  }
}

/** Composite project time `tMs` into `ctx`: clip (with crop/zoom), its fade, then the overlays - the same order the stage shows. */
async function renderFrame(ctx, project, tMs, W, H, sources, images) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const loc = clipAt(project, tMs);
  if (loc) {
    const { clip } = loc;
    const localMs = tMs - loc.startMs;
    if (clip.kind === 'image') {
      const img = images.get(clip.assetId);
      if (img?.naturalWidth) {
        const d = fitRect(img.naturalWidth, img.naturalHeight, W, H, 'contain');
        ctx.drawImage(img, d.x, d.y, d.w, d.h);
      }
    } else {
      const source = sources.get(clip.recordingId);
      if (source) {
        await source.seek(clip.kind === 'freeze' ? clip.atMs : loc.sourceMs);
        drawVideo(ctx, source.video, viewRectAt(clip, localMs), W, H);
      }
    }
    const alpha = fadeAlphaAt(clip, localMs, clipDuration(clip));
    if (alpha > 0) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }
  for (const overlay of overlaysAt(project, tMs)) {
    const image = overlay.source === 'image' ? images.get(overlay.content.assetId) : undefined;
    drawOverlay(ctx, overlay, tMs - overlay.startMs, W, H, { image });
  }
}

/**
 * Draw the part of the video `view` (a source-fraction rectangle from
 * viewRectAt) selects. Uncropped: the whole frame, letterboxed like the
 * preview's object-fit: contain. Cropped/zoomed: that source rectangle fills
 * the frame (object-fit: cover of the selected region), which is what the
 * preview's scale()-around-the-center approximates.
 */
function drawVideo(ctx, video, view, W, H) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const full = view.x === FULL_VIEW.x && view.y === FULL_VIEW.y && view.w === FULL_VIEW.w && view.h === FULL_VIEW.h;
  const sx = view.x * vw;
  const sy = view.y * vh;
  const sw = view.w * vw;
  const sh = view.h * vh;
  const d = fitRect(sw, sh, W, H, full ? 'contain' : 'cover');
  ctx.drawImage(video, sx, sy, sw, sh, d.x, d.y, d.w, d.h);
}

/**
 * The pure, testable half of export: which output frames exist, which codec
 * to ask for, and how a source rectangle lands in the output frame. Nothing
 * here touches a canvas, a <video>, or WebCodecs - editor/export.js does that,
 * iterating over what these functions decide.
 */

/**
 * Timestamps (ms) of every output frame for a project of `durationMs` at `fps`:
 * 0, 1000/fps, 2000/fps, ... up to but not including the end. Computed as
 * i * 1000 / fps rather than by accumulating a step, so the 10,000th frame is
 * exactly where it should be, not where floating-point drift left it.
 * @returns {number[]}
 */
export function frameTimesMs(durationMs, fps) {
  if (!(durationMs > 0) || !(fps > 0)) return [];
  const count = Math.ceil((durationMs * fps) / 1000);
  return Array.from({ length: count }, (_, i) => (i * 1000) / fps);
}

/**
 * Codec candidates in order of preference, all muxed into MP4: H.264 plays
 * everywhere and is what "an .mp4" means to most people; AV1 and VP9 are
 * there for browsers without an H.264 encoder (open-source Chromium builds),
 * where the file is still a valid MP4 that Chrome/Edge/Firefox/VLC play.
 * Levels step up above 1080p so the encoder isn't asked for something its
 * declared level can't hold.
 */
export function codecCandidates(width, height) {
  const big = width * height > 1920 * 1080;
  return [
    { codec: big ? 'avc1.640033' : 'avc1.64002a', mux: 'avc', label: 'H.264', extra: { avc: { format: 'avc' } } },
    { codec: big ? 'av01.0.13M.08' : 'av01.0.09M.08', mux: 'av1', label: 'AV1' },
    { codec: big ? 'vp09.00.51.08' : 'vp09.00.41.08', mux: 'vp9', label: 'VP9' },
  ];
}

/**
 * First supported candidate, or null. `isSupported(config)` is
 * VideoEncoder.isConfigSupported in the browser, a stub in tests.
 * @param {(config: object) => Promise<{ supported: boolean }>} isSupported
 */
export async function pickCodec({ width, height, fps, bitsPerSecond }, isSupported) {
  for (const candidate of codecCandidates(width, height)) {
    const config = { codec: candidate.codec, width, height, bitrate: bitsPerSecond, framerate: fps, ...candidate.extra };
    try {
      if ((await isSupported(config)).supported) return { ...candidate, config };
    } catch {
      // an unparseable codec string throws rather than returning unsupported; treat it the same
    }
  }
  return null;
}

/**
 * Where a `srcW x srcH` picture goes inside a `dstW x dstH` frame, keeping
 * its aspect ratio: 'contain' letterboxes (whole picture visible, centered),
 * 'cover' fills the frame (edges cropped, centered) - the same two behaviours
 * the editor's CSS `object-fit` gives the live preview.
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function fitRect(srcW, srcH, dstW, dstH, mode) {
  if (!(srcW > 0) || !(srcH > 0)) return { x: 0, y: 0, w: dstW, h: dstH };
  const scale = mode === 'cover' ? Math.max(dstW / srcW, dstH / srcH) : Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h };
}

/** H.264 (4:2:0) needs even dimensions; round down rather than up so nothing is invented. */
export function evenSize({ width, height }) {
  return { width: Math.max(2, width - (width % 2)), height: Math.max(2, height - (height % 2)) };
}

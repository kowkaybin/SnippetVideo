/**
 * Timeline thumbnails. One hidden <video> per recording, seeks are queued so
 * they run one at a time, results are cached by (recording, time rounded to
 * 250 ms) as small JPEG data URLs.
 */
const W = 96;
const H = 54;

export class Thumbnailer {
  constructor() {
    this.videos = new Map(); // recordingId → { video, ready: Promise }
    this.cache = new Map(); // key → dataURL
    this.queue = Promise.resolve();
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
  }

  source(recordingId, blobUrl) {
    let entry = this.videos.get(recordingId);
    if (entry) return entry;
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = blobUrl;
    const ready = new Promise((resolve) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', resolve, { once: true });
    });
    entry = { video, ready };
    this.videos.set(recordingId, entry);
    return entry;
  }

  /** @returns {Promise<string>} data URL, or '' when the frame cannot be produced */
  frame(recordingId, blobUrl, timeMs) {
    const key = `${recordingId}@${Math.round(timeMs / 250)}`;
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const job = this.queue.then(async () => {
      const again = this.cache.get(key);
      if (again) return again;
      const { video, ready } = this.source(recordingId, blobUrl);
      await ready;
      if (!video.videoWidth) return '';
      await new Promise((resolve) => {
        const done = () => resolve();
        video.addEventListener('seeked', done, { once: true });
        video.addEventListener('error', done, { once: true });
        video.currentTime = timeMs / 1000;
      });
      const ctx = this.canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, W, H);
      const url = this.canvas.toDataURL('image/jpeg', 0.6);
      this.cache.set(key, url);
      return url;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  destroy() {
    for (const { video } of this.videos.values()) video.remove();
    this.videos.clear();
  }
}

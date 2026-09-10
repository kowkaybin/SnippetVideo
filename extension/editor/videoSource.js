/**
 * A recording as a seekable frame source: a hidden <video> that resolves once
 * the frame at a given time is decoded and drawable. Shared by export
 * (one frame per output frame) and motion analysis (one frame per sample);
 * the seek-and-wait technique is the one thumbs.js proved first.
 */
export class VideoSource {
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


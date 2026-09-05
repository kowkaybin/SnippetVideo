/**
 * Preview player. One <video> per source recording; the active one is shown
 * and driven natively, and the player advances to the next clip when the
 * active video reaches its out point. Accurate enough for editing; export
 * re-renders frame-exactly with WebCodecs later.
 */
import { clipAt, projectDuration } from '../shared/project.js';
import { readRecordingFile } from '../shared/library.js';

export class Player {
  /** @param {HTMLElement} stage container that receives the <video> elements */
  constructor(stage) {
    this.stage = stage;
    this.videos = new Map(); // recordingId → HTMLVideoElement
    this.urls = new Map(); // recordingId → blob URL
    this.project = { clips: [] };
    this.timeMs = 0;
    this.playing = false;
    this.active = null;
    this.listeners = new Set();
    this.raf = 0;
    /** Called with (recordingId, durationMs) once a source's real length is known. */
    this.onSourceDuration = null;
  }

  onTick(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.timeMs, this.playing);
  }

  /** Make sure every recording in the project has a loaded <video>. */
  async setProject(project) {
    this.project = project;
    const needed = new Set(project.clips.map((c) => c.recordingId));
    await Promise.all([...needed].filter((id) => !this.videos.has(id)).map((id) => this.loadSource(id)));
    for (const [id, video] of this.videos) {
      if (!needed.has(id)) {
        video.remove();
        URL.revokeObjectURL(this.urls.get(id));
        this.videos.delete(id);
        this.urls.delete(id);
      }
    }
    this.seek(Math.min(this.timeMs, projectDuration(project)));
  }

  async loadSource(recordingId) {
    const file = await readRecordingFile(recordingId);
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    video.hidden = true;
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration)) this.onSourceDuration?.(recordingId, Math.round(video.duration * 1000));
    });
    this.stage.append(video);
    this.videos.set(recordingId, video);
    this.urls.set(recordingId, url);
    await new Promise((resolve) => {
      if (video.readyState >= 1) resolve();
      else {
        video.addEventListener('loadedmetadata', resolve, { once: true });
        video.addEventListener('error', resolve, { once: true });
      }
    });
  }

  blobUrl(recordingId) {
    return this.urls.get(recordingId);
  }

  get durationMs() {
    return projectDuration(this.project);
  }

  /** Show the frame at project time `tMs` (does not change play state). */
  seek(tMs) {
    const duration = this.durationMs;
    this.timeMs = Math.max(0, Math.min(duration, tMs));
    const loc = clipAt(this.project, this.timeMs);
    const video = loc ? this.videos.get(loc.clip.recordingId) : null;
    if (this.active && this.active !== video) {
      this.active.pause();
      this.active.hidden = true;
    }
    this.active = video ?? null;
    if (video && loc) {
      video.hidden = false;
      const target = loc.sourceMs / 1000;
      if (Math.abs(video.currentTime - target) > 0.015) video.currentTime = target;
    }
    this.emit();
  }

  play() {
    if (this.playing) return;
    if (this.durationMs === 0) return;
    if (this.timeMs >= this.durationMs) this.seek(0);
    this.playing = true;
    this.startActive();
    this.loop();
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.active?.pause();
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  startActive() {
    const loc = clipAt(this.project, this.timeMs);
    if (!loc) return;
    const video = this.videos.get(loc.clip.recordingId);
    if (!video) return;
    this.seek(this.timeMs);
    void video.play().catch(() => undefined);
  }

  loop() {
    this.raf = requestAnimationFrame(() => {
      if (!this.playing) return;
      const loc = clipAt(this.project, this.timeMs);
      const video = this.active;
      if (loc && video) {
        const sourceMs = video.currentTime * 1000;
        const clipEnd = loc.clip.outMs;
        if (sourceMs >= clipEnd - 1 || video.ended) {
          const nextStart = loc.startMs + (loc.clip.outMs - loc.clip.inMs);
          if (nextStart >= this.durationMs) {
            this.timeMs = this.durationMs;
            this.pause();
            this.seek(this.durationMs);
            return;
          }
          this.timeMs = nextStart;
          this.startActive();
        } else {
          this.timeMs = loc.startMs + Math.max(0, sourceMs - loc.clip.inMs);
        }
      }
      this.emit();
      this.loop();
    });
  }

  destroy() {
    this.pause();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    for (const v of this.videos.values()) v.remove();
    this.videos.clear();
    this.urls.clear();
  }
}

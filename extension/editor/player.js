/**
 * Preview player. One <video> per source recording, one <img> per image
 * asset; the active element is shown and driven, and the player advances to
 * the next clip when it reaches its end. Video timing follows the video's own
 * clock (decode isn't perfectly wall-clock); freeze/image clips have no such
 * clock, so they advance by wall-clock delta instead.
 *
 * Crop and zoom are approximated in CSS: `viewRectAt` (shared/project.js)
 * composes them into one source-fraction rectangle, and this player renders
 * it as `object-fit: cover` plus a single `transform: scale()` around a
 * `transform-origin` at the rectangle's center. That's a preview
 * approximation (uniform scale, not a true independent x/y crop) — accurate
 * enough for editing; export re-renders frame-exactly with WebCodecs later.
 */
import { clipAt, clipDuration, fadeAlphaAt, projectDuration, viewRectAt } from '../shared/project.js';
import { readAssetFile, readRecordingFile } from '../shared/library.js';

const FULL_VIEW = { x: 0, y: 0, w: 1, h: 1 };

export class Player {
  /** @param {HTMLElement} stage container that receives the <video>/<img> elements */
  constructor(stage) {
    this.stage = stage;
    this.videos = new Map(); // recordingId → HTMLVideoElement
    this.videoUrls = new Map(); // recordingId → blob URL
    this.images = new Map(); // assetId → HTMLImageElement
    this.imageUrls = new Map(); // assetId → blob URL
    this.project = { clips: [] };
    this.timeMs = 0;
    this.playing = false;
    this.active = null; // currently visible <video> or <img>
    this.listeners = new Set();
    this.raf = 0;
    this.wallLast = 0;
    this.fade = document.createElement('div');
    this.fade.className = 'fade-overlay';
    this.stage.append(this.fade);
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

  /** Make sure every recording/asset the project references is loaded. */
  async setProject(project) {
    this.project = project;
    const neededRecordings = new Set(project.clips.filter((c) => c.recordingId).map((c) => c.recordingId));
    const neededAssets = new Set(project.clips.filter((c) => c.assetId).map((c) => c.assetId));
    await Promise.all([
      ...[...neededRecordings].filter((id) => !this.videos.has(id)).map((id) => this.loadVideo(id)),
      ...[...neededAssets].filter((id) => !this.images.has(id)).map((id) => this.loadImage(id)),
    ]);
    for (const [id, video] of this.videos) {
      if (!neededRecordings.has(id)) {
        video.remove();
        URL.revokeObjectURL(this.videoUrls.get(id));
        this.videos.delete(id);
        this.videoUrls.delete(id);
      }
    }
    for (const [id, img] of this.images) {
      if (!neededAssets.has(id)) {
        img.remove();
        URL.revokeObjectURL(this.imageUrls.get(id));
        this.images.delete(id);
        this.imageUrls.delete(id);
      }
    }
    this.seek(Math.min(this.timeMs, projectDuration(project)));
  }

  async loadVideo(recordingId) {
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
    this.videoUrls.set(recordingId, url);
    await new Promise((resolve) => {
      if (video.readyState >= 1) resolve();
      else {
        video.addEventListener('loadedmetadata', resolve, { once: true });
        video.addEventListener('error', resolve, { once: true });
      }
    });
  }

  async loadImage(assetId) {
    const file = await readAssetFile(assetId);
    const url = URL.createObjectURL(file);
    const img = document.createElement('img');
    img.src = url;
    img.hidden = true;
    img.draggable = false;
    this.stage.append(img);
    this.images.set(assetId, img);
    this.imageUrls.set(assetId, url);
    await new Promise((resolve) => {
      if (img.complete) resolve();
      else {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }
    });
  }

  blobUrl(recordingId) {
    return this.videoUrls.get(recordingId);
  }

  imageUrl(assetId) {
    return this.imageUrls.get(assetId);
  }

  get durationMs() {
    return projectDuration(this.project);
  }

  elementFor(clip) {
    if (clip.kind === 'image') return this.images.get(clip.assetId) ?? null;
    return this.videos.get(clip.recordingId) ?? null;
  }

  /** Hide every element except `el`, and remember it as active. */
  show(el) {
    if (this.active && this.active !== el) {
      if (this.active.tagName === 'VIDEO') this.active.pause();
      this.active.hidden = true;
    }
    this.active = el;
    if (el) el.hidden = false;
  }

  /** Apply this clip's crop/zoom/fade to whatever is currently shown. */
  applyEffects(clip, localMs) {
    const el = this.active;
    if (!el) return;
    const view = viewRectAt(clip, localMs);
    const noView = view.x === FULL_VIEW.x && view.y === FULL_VIEW.y && view.w === FULL_VIEW.w && view.h === FULL_VIEW.h;
    if (noView) {
      el.style.objectFit = 'contain';
      el.style.transform = 'none';
    } else {
      el.style.objectFit = 'cover';
      el.style.transformOrigin = `${(view.x + view.w / 2) * 100}% ${(view.y + view.h / 2) * 100}%`;
      el.style.transform = `scale(${1 / Math.max(0.001, Math.min(view.w, view.h))})`;
    }
    this.fade.style.opacity = String(fadeAlphaAt(clip, localMs, clipDuration(clip)));
  }

  /** Show the frame at project time `tMs` (does not change play state). */
  seek(tMs) {
    const duration = this.durationMs;
    this.timeMs = Math.max(0, Math.min(duration, tMs));
    const loc = clipAt(this.project, this.timeMs);
    if (!loc) {
      this.show(null);
      this.emit();
      return;
    }
    const clip = loc.clip;
    const el = this.elementFor(clip);
    this.show(el);
    if (el && clip.kind !== 'image') {
      const target = (clip.kind === 'freeze' ? clip.atMs : loc.sourceMs) / 1000;
      if (Math.abs(el.currentTime - target) > 0.015) el.currentTime = target;
    }
    this.applyEffects(clip, this.timeMs - loc.startMs);
    this.emit();
  }

  play() {
    if (this.playing) return;
    if (this.durationMs === 0) return;
    if (this.timeMs >= this.durationMs) this.seek(0);
    this.playing = true;
    this.wallLast = 0;
    this.startActive();
    this.loop();
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (this.active?.tagName === 'VIDEO') this.active.pause();
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  startActive() {
    const loc = clipAt(this.project, this.timeMs);
    if (!loc) return;
    this.wallLast = 0;
    const clip = loc.clip;
    const el = this.elementFor(clip);
    this.show(el);
    if (!el) return;
    if (clip.kind === 'video') {
      el.currentTime = loc.sourceMs / 1000;
      void el.play().catch(() => undefined);
    } else if (clip.kind === 'freeze') {
      el.pause();
      const target = clip.atMs / 1000;
      if (Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
    }
    this.applyEffects(clip, this.timeMs - loc.startMs);
  }

  advance(loc) {
    const nextStart = loc.startMs + clipDuration(loc.clip);
    if (nextStart >= this.durationMs) {
      this.timeMs = this.durationMs;
      this.pause();
      this.seek(this.durationMs);
      return;
    }
    this.timeMs = nextStart;
    this.startActive();
  }

  loop() {
    this.raf = requestAnimationFrame((now) => {
      if (!this.playing) return;
      const loc = clipAt(this.project, this.timeMs);
      if (loc) {
        const clip = loc.clip;
        if (clip.kind === 'video') {
          const video = this.active;
          if (video) {
            const sourceMs = video.currentTime * 1000;
            if (sourceMs >= clip.outMs - 1 || video.ended) this.advance(loc);
            else this.timeMs = loc.startMs + Math.max(0, sourceMs - clip.inMs);
          }
        } else {
          const dt = this.wallLast ? now - this.wallLast : 16;
          const localMs = this.timeMs - loc.startMs + dt;
          if (localMs >= clipDuration(clip)) this.advance(loc);
          else this.timeMs = loc.startMs + localMs;
        }
        const loc2 = clipAt(this.project, this.timeMs);
        if (loc2) this.applyEffects(loc2.clip, this.timeMs - loc2.startMs);
      }
      this.wallLast = now;
      this.emit();
      this.loop();
    });
  }

  destroy() {
    this.pause();
    for (const url of this.videoUrls.values()) URL.revokeObjectURL(url);
    for (const url of this.imageUrls.values()) URL.revokeObjectURL(url);
    for (const v of this.videos.values()) v.remove();
    for (const img of this.images.values()) img.remove();
    this.videos.clear();
    this.videoUrls.clear();
    this.images.clear();
    this.imageUrls.clear();
    this.fade.remove();
  }
}

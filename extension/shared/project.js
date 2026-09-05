/**
 * Editor project model. A project is an ordered list of clips; recording and
 * asset files are never modified: every edit is a new project value, which
 * keeps undo trivial (swap the reference).
 *
 * Three clip kinds share the timeline:
 *  - 'video'  a slice of a recording, played back at its own pace.
 *  - 'freeze' a single frame of a recording, held still for `holdMs`.
 *  - 'image'  an uploaded image (logo/slide), held still for `durationMs`.
 *
 * Any clip may also carry a static `crop`, animated `zoomKeyframes` (a
 * momentary zoom that pans/scales over the clip), and `fadeInMs`/`fadeOutMs`
 * (fade to black at its edges). `viewRectAt` composes crop + zoom into one
 * source-fraction rectangle; the player approximates it in CSS (object-fit:
 * cover + a single scale) — good enough for editing, and export re-renders
 * frame-exactly later.
 *
 * `layers` sit on the project itself (not a clip): simple shape/text
 * annotations positioned as fractions of the stage, each visible for a
 * project-time window, independent of which clip is playing underneath.
 *
 * @typedef {object} ZoomKeyframe
 * @property {number} tMs   clip-local time
 * @property {number} x     focal point, fraction of the (cropped) frame, 0..1
 * @property {number} y
 * @property {number} scale 1 = no zoom
 *
 * @typedef {object} Crop
 * @property {number} x fraction of the source frame, 0..1
 * @property {number} y
 * @property {number} w
 * @property {number} h
 *
 * @typedef {object} Clip
 * @property {string} id
 * @property {'video'|'freeze'|'image'} kind
 * @property {string} [recordingId]      video/freeze
 * @property {number} [inMs]             video: start in the source recording
 * @property {number} [outMs]            video: end in the source recording (exclusive)
 * @property {number} [atMs]             freeze: source frame to hold
 * @property {number} [holdMs]           freeze: how long to hold it
 * @property {string} [assetId]          image: uploaded image id
 * @property {number} [durationMs]       image: how long to show it
 * @property {number} [sourceDurationMs] video/freeze: length of the source, for trim bounds
 * @property {Crop} [crop]
 * @property {ZoomKeyframe[]} [zoomKeyframes]
 * @property {number} [fadeInMs]
 * @property {number} [fadeOutMs]
 *
 * @typedef {object} Layer
 * @property {string} id
 * @property {'rect'|'ellipse'|'text'|'arrow'} kind
 * @property {number} x fraction of the stage, 0..1 (arrow: first point)
 * @property {number} y
 * @property {number} w fraction of the stage (arrow: second point x)
 * @property {number} h (arrow: second point y)
 * @property {string} color
 * @property {string} text        text layers only
 * @property {number} fontSize    text layers only, px at 1x stage
 * @property {number} startMs     project time the layer appears
 * @property {number} durationMs
 *
 * @typedef {object} Project
 * @property {string} id
 * @property {string} name
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {Clip[]} clips
 * @property {Layer[]} layers
 */

/** Shortest clip the editor allows, so nothing collapses to zero. */
export const MIN_CLIP_MS = 100;
/** Shortest layer duration. */
export const MIN_LAYER_MS = 200;
/** Default hold for an inserted freeze frame. */
export const DEFAULT_FREEZE_MS = 2000;
/** Default duration for a new image/logo slide. */
export const DEFAULT_IMAGE_MS = 3000;

const PROJECTS_KEY = 'projects';

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ---------- construction ----------

/** @returns {Project} */
export function createProject(name, clips = []) {
  const now = Date.now();
  return { id: uid(), name, createdAt: now, updatedAt: now, clips, layers: [] };
}

/**
 * @param {{ id: string, durationMs: number }} recording
 * @returns {Clip}
 */
export function clipFromRecording(recording, inMs = 0, outMs = recording.durationMs) {
  return {
    id: uid(),
    kind: 'video',
    recordingId: recording.id,
    inMs,
    outMs,
    sourceDurationMs: recording.durationMs,
  };
}

/**
 * A single held frame from a recording.
 * @param {{ id: string, durationMs: number }} recording
 */
export function freezeClipFromRecording(recording, atMs, holdMs = DEFAULT_FREEZE_MS) {
  return {
    id: uid(),
    kind: 'freeze',
    recordingId: recording.id,
    atMs: Math.max(0, Math.round(atMs)),
    holdMs: Math.max(MIN_CLIP_MS, Math.round(holdMs)),
    sourceDurationMs: recording.durationMs,
  };
}

/** @param {{ id: string }} asset */
export function imageClipFromAsset(asset, durationMs = DEFAULT_IMAGE_MS) {
  return { id: uid(), kind: 'image', assetId: asset.id, durationMs: Math.max(MIN_CLIP_MS, Math.round(durationMs)) };
}

// ---------- queries ----------

export function clipDuration(clip) {
  if (clip.kind === 'freeze') return Math.max(0, clip.holdMs);
  if (clip.kind === 'image') return Math.max(0, clip.durationMs);
  return Math.max(0, clip.outMs - clip.inMs);
}

export function projectDuration(project) {
  return project.clips.reduce((sum, c) => sum + clipDuration(c), 0);
}

/** Project time at which the clip starts, or -1 if absent. */
export function clipStart(project, clipId) {
  let t = 0;
  for (const c of project.clips) {
    if (c.id === clipId) return t;
    t += clipDuration(c);
  }
  return -1;
}

/**
 * Locate the clip playing at project time `tMs`.
 * Past the end, returns the last clip positioned at its final millisecond so a
 * stopped player still shows a frame.
 * @returns {{ clip: Clip, index: number, startMs: number, sourceMs: number } | null}
 */
export function clipAt(project, tMs) {
  const clips = project.clips;
  if (clips.length === 0) return null;
  let start = 0;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const d = clipDuration(clip);
    if (tMs < start + d) return { clip, index: i, startMs: start, sourceMs: sourceMsFor(clip, tMs - start) };
    start += d;
  }
  const last = clips[clips.length - 1];
  return { clip: last, index: clips.length - 1, startMs: start - clipDuration(last), sourceMs: sourceMsFor(last, clipDuration(last)) };
}

/** Where a clip-local time points to in its source; meaningless (0) for image clips. */
function sourceMsFor(clip, localMs) {
  if (clip.kind === 'freeze') return clip.atMs;
  if (clip.kind === 'image') return 0;
  return clip.inMs + localMs;
}

// ---------- edits (all return a new Project) ----------

function withClips(project, clips) {
  return { ...project, clips, updatedAt: Date.now() };
}

export function addClip(project, clip, atIndex = project.clips.length) {
  const clips = project.clips.slice();
  clips.splice(Math.max(0, Math.min(atIndex, clips.length)), 0, clip);
  return withClips(project, clips);
}

export function removeClip(project, clipId) {
  const clips = project.clips.filter((c) => c.id !== clipId);
  return clips.length === project.clips.length ? project : withClips(project, clips);
}

/** Move a clip so that it ends up at `toIndex` in the resulting list. */
export function moveClip(project, clipId, toIndex) {
  const from = project.clips.findIndex((c) => c.id === clipId);
  if (from < 0) return project;
  const clips = project.clips.slice();
  const [clip] = clips.splice(from, 1);
  clips.splice(Math.max(0, Math.min(toIndex, clips.length)), 0, clip);
  return withClips(project, clips);
}

/**
 * Set new in/out points, clamped to the source and to MIN_CLIP_MS. Pass only
 * the side you are changing; the other is kept.
 */
export function trimClip(project, clipId, { inMs, outMs }) {
  const idx = project.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return project;
  const clip = project.clips[idx];
  if (clip.kind !== 'video') return project;
  const max = clip.sourceDurationMs > 0 ? clip.sourceDurationMs : Infinity;
  let nextOut = outMs ?? clip.outMs;
  let nextIn = inMs ?? clip.inMs;
  nextOut = Math.min(max, Math.max(MIN_CLIP_MS, nextOut));
  nextIn = Math.max(0, Math.min(nextOut - MIN_CLIP_MS, nextIn));
  if (nextOut - nextIn < MIN_CLIP_MS) nextOut = nextIn + MIN_CLIP_MS;
  if (nextIn === clip.inMs && nextOut === clip.outMs) return project;
  const clips = project.clips.slice();
  clips[idx] = { ...clip, inMs: nextIn, outMs: nextOut };
  return withClips(project, clips);
}

/**
 * Split the clip under project time `tMs` into two. No-op when the cut would
 * leave either side shorter than MIN_CLIP_MS.
 */
export function splitAt(project, tMs) {
  const loc = clipAt(project, tMs);
  if (!loc || loc.clip.kind !== 'video') return project;
  const { clip, index, startMs } = loc;
  const offset = tMs - startMs;
  const d = clipDuration(clip);
  if (offset < MIN_CLIP_MS || d - offset < MIN_CLIP_MS) return project;
  const cut = clip.inMs + offset;
  const left = { ...clip, outMs: cut };
  const right = { ...clip, id: uid(), inMs: cut };
  const clips = project.clips.slice();
  clips.splice(index, 1, left, right);
  return withClips(project, clips);
}

export function renameProject(project, name) {
  return { ...project, name, updatedAt: Date.now() };
}

/**
 * Insert a held frame from the video clip under project time `tMs`, splitting
 * that clip there first (unless `tMs` already falls on a clip boundary).
 * No-op away from a video clip.
 */
export function insertFreezeAt(project, tMs, holdMs = DEFAULT_FREEZE_MS) {
  const loc = clipAt(project, tMs);
  if (!loc || loc.clip.kind !== 'video') return project;
  const freeze = freezeClipFromRecording({ id: loc.clip.recordingId, durationMs: loc.clip.sourceDurationMs }, loc.sourceMs, holdMs);
  const offset = tMs - loc.startMs;
  const d = clipDuration(loc.clip);
  if (offset <= 0) return addClip(project, freeze, loc.index);
  if (offset >= d) return addClip(project, freeze, loc.index + 1);
  const split = splitAt(project, tMs);
  if (split === project) return project; // too close to an edge to split cleanly
  return addClip(split, freeze, loc.index + 1);
}

/** Change how long a 'freeze' or 'image' clip is held. No-op for 'video' clips (use trimClip). */
export function setClipDuration(project, clipId, ms) {
  const idx = project.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return project;
  const clip = project.clips[idx];
  if (clip.kind !== 'freeze' && clip.kind !== 'image') return project;
  const field = clip.kind === 'freeze' ? 'holdMs' : 'durationMs';
  const next = Math.max(MIN_CLIP_MS, Math.round(ms));
  if (clip[field] === next) return project;
  const clips = project.clips.slice();
  clips[idx] = { ...clip, [field]: next };
  return withClips(project, clips);
}

// ---------- crop, zoom, fade (any clip kind) ----------

function updateClip(project, clipId, patch) {
  const idx = project.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return project;
  const clips = project.clips.slice();
  clips[idx] = { ...clips[idx], ...(typeof patch === 'function' ? patch(clips[idx]) : patch) };
  return withClips(project, clips);
}

/** Keep a fractional {x,y,w,h} rect inside [0,1] with a minimum size. Shared by crop and layers. */
function clampFractionRect({ x, y, w, h }, min = 0.02) {
  const cw = Math.min(1, Math.max(min, w));
  const ch = Math.min(1, Math.max(min, h));
  const cx = Math.min(1 - cw, Math.max(0, x));
  const cy = Math.min(1 - ch, Math.max(0, y));
  return { x: cx, y: cy, w: cw, h: ch };
}

/** Set (or, with `crop: null`, clear) a clip's static crop rectangle. */
export function setCrop(project, clipId, crop) {
  return updateClip(project, clipId, { crop: crop ? clampFractionRect(crop, 0.05) : undefined });
}

/**
 * Add or replace a zoom keyframe at `kf.tMs` (clip-local). A keyframe within
 * 30ms of an existing one replaces it, so dragging in place doesn't pile up.
 */
export function addZoomKeyframe(project, clipId, kf) {
  const idx = project.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return project;
  const clip = project.clips[idx];
  const next = {
    tMs: Math.max(0, Math.round(kf.tMs)),
    x: Math.min(1, Math.max(0, kf.x)),
    y: Math.min(1, Math.max(0, kf.y)),
    scale: Math.min(6, Math.max(1, kf.scale)),
  };
  const kept = (clip.zoomKeyframes ?? []).filter((k) => Math.abs(k.tMs - next.tMs) > 30);
  const zoomKeyframes = [...kept, next].sort((a, b) => a.tMs - b.tMs);
  return updateClip(project, clipId, { zoomKeyframes });
}

export function removeZoomKeyframe(project, clipId, tMs) {
  const idx = project.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return project;
  const before = project.clips[idx].zoomKeyframes ?? [];
  const zoomKeyframes = before.filter((k) => k.tMs !== tMs);
  if (zoomKeyframes.length === before.length) return project;
  return updateClip(project, clipId, { zoomKeyframes });
}

/** Interpolated zoom for a clip-local time; `{x:0.5,y:0.5,scale:1}` (no zoom) when unset. */
export function zoomAt(clip, localMs) {
  const kfs = clip.zoomKeyframes;
  if (!kfs || kfs.length === 0) return { x: 0.5, y: 0.5, scale: 1 };
  if (localMs <= kfs[0].tMs) return { x: kfs[0].x, y: kfs[0].y, scale: kfs[0].scale };
  const last = kfs[kfs.length - 1];
  if (localMs >= last.tMs) return { x: last.x, y: last.y, scale: last.scale };
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (localMs >= a.tMs && localMs <= b.tMs) {
      const t = (localMs - a.tMs) / (b.tMs - a.tMs || 1);
      return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), scale: lerp(a.scale, b.scale, t) };
    }
  }
  return { x: last.x, y: last.y, scale: last.scale };
}

/**
 * Compose a clip's static crop with its momentary zoom into one source-fraction
 * rectangle to display, clamped so it never runs outside the crop (or the full
 * frame, when uncropped). `{x:0,y:0,w:1,h:1}` means "show everything".
 */
export function viewRectAt(clip, localMs) {
  const crop = clip.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const z = zoomAt(clip, localMs);
  const w = crop.w / z.scale;
  const h = crop.h / z.scale;
  const x = Math.min(crop.x + crop.w - w, Math.max(crop.x, crop.x + z.x * crop.w - w / 2));
  const y = Math.min(crop.y + crop.h - h, Math.max(crop.y, crop.y + z.y * crop.h - h / 2));
  return { x, y, w, h };
}

/** Set fade-to-black durations at a clip's edges, clamped so they can't overlap past its middle. */
export function setFade(project, clipId, { fadeInMs, fadeOutMs }) {
  return updateClip(project, clipId, (clip) => {
    const half = Math.floor(clipDuration(clip) / 2);
    const clamp = (ms, fallback) => (ms == null ? fallback : Math.max(0, Math.min(half, Math.round(ms))));
    return { fadeInMs: clamp(fadeInMs, clip.fadeInMs ?? 0), fadeOutMs: clamp(fadeOutMs, clip.fadeOutMs ?? 0) };
  });
}

/** Black-overlay opacity (0..1) for a clip-local time, from its fade in/out. */
export function fadeAlphaAt(clip, localMs, durationMs) {
  const fin = clip.fadeInMs ?? 0;
  const fout = clip.fadeOutMs ?? 0;
  let alpha = 0;
  if (fin > 0 && localMs < fin) alpha = Math.max(alpha, 1 - localMs / fin);
  if (fout > 0 && localMs > durationMs - fout) alpha = Math.max(alpha, 1 - (durationMs - localMs) / fout);
  return Math.min(1, Math.max(0, alpha));
}

// ---------- layers (project-level annotations) ----------

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/**
 * Every layer kind but 'arrow' uses {x,y,w,h} as a box; 'arrow' reuses the same
 * fields as two endpoints (x,y)→(w,h), so it gets its own, size-free clamp.
 */
function clampLayerRect(layer) {
  if (layer.kind === 'arrow') return { x: clamp01(layer.x), y: clamp01(layer.y), w: clamp01(layer.w), h: clamp01(layer.h) };
  return clampFractionRect(layer);
}

/** @returns {Project} */
export function addLayer(project, layer) {
  const kind = layer.kind ?? 'rect';
  const isArrow = kind === 'arrow';
  const rect = clampLayerRect({
    kind,
    x: layer.x ?? (isArrow ? 0.25 : 0.3),
    y: layer.y ?? (isArrow ? 0.25 : 0.3),
    w: layer.w ?? (isArrow ? 0.75 : 0.3),
    h: layer.h ?? (isArrow ? 0.55 : 0.15),
  });
  const full = {
    id: uid(),
    kind,
    ...rect,
    color: layer.color ?? '#ff4d4f',
    text: layer.text ?? '',
    fontSize: layer.fontSize ?? 28,
    startMs: Math.max(0, Math.round(layer.startMs ?? 0)),
    durationMs: Math.max(MIN_LAYER_MS, Math.round(layer.durationMs ?? 3000)),
  };
  return { ...project, layers: [...(project.layers ?? []), full], updatedAt: Date.now() };
}

export function updateLayer(project, layerId, patch) {
  const layers = project.layers ?? [];
  const idx = layers.findIndex((l) => l.id === layerId);
  if (idx < 0) return project;
  let layer = { ...layers[idx], ...patch };
  if (patch.x != null || patch.y != null || patch.w != null || patch.h != null) layer = { ...layer, ...clampLayerRect(layer) };
  if (layer.durationMs != null) layer.durationMs = Math.max(MIN_LAYER_MS, Math.round(layer.durationMs));
  if (layer.startMs != null) layer.startMs = Math.max(0, Math.round(layer.startMs));
  const next = layers.slice();
  next[idx] = layer;
  return { ...project, layers: next, updatedAt: Date.now() };
}

export function removeLayer(project, layerId) {
  const layers = (project.layers ?? []).filter((l) => l.id !== layerId);
  return layers.length === (project.layers ?? []).length ? project : { ...project, layers, updatedAt: Date.now() };
}

/** Layers visible at project time `tMs`. */
export function layersAt(project, tMs) {
  return (project.layers ?? []).filter((l) => tMs >= l.startMs && tMs < l.startMs + l.durationMs);
}

// ---------- storage (chrome.storage.local) ----------

/** @returns {Promise<Project[]>} newest first */
export async function listProjects() {
  const list = (await chrome.storage.local.get(PROJECTS_KEY))[PROJECTS_KEY] ?? [];
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id) {
  return (await listProjects()).find((p) => p.id === id) ?? null;
}

export async function saveProject(project) {
  const list = (await listProjects()).filter((p) => p.id !== project.id);
  await chrome.storage.local.set({ [PROJECTS_KEY]: [project, ...list] });
}

export async function deleteProject(id) {
  const list = (await listProjects()).filter((p) => p.id !== id);
  await chrome.storage.local.set({ [PROJECTS_KEY]: list });
}

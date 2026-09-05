/**
 * Editor project model. A project is an ordered list of clips; each video clip
 * references a recording by id with in/out points in source milliseconds.
 * Recording files are never modified: every edit is a new project value.
 *
 * All helpers are pure and return new objects, which keeps undo trivial.
 *
 * @typedef {object} Clip
 * @property {string} id
 * @property {'video'} kind          'freeze' and 'image' arrive in later phases
 * @property {string} recordingId
 * @property {number} inMs           start in the source recording
 * @property {number} outMs          end in the source recording (exclusive)
 * @property {number} sourceDurationMs  length of the source, for trim bounds
 *
 * @typedef {object} Project
 * @property {string} id
 * @property {string} name
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {Clip[]} clips
 */

/** Shortest clip the editor allows, so nothing collapses to zero. */
export const MIN_CLIP_MS = 100;

const PROJECTS_KEY = 'projects';

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- construction ----------

/** @returns {Project} */
export function createProject(name, clips = []) {
  const now = Date.now();
  return { id: uid(), name, createdAt: now, updatedAt: now, clips };
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

// ---------- queries ----------

export function clipDuration(clip) {
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
    if (tMs < start + d) return { clip, index: i, startMs: start, sourceMs: clip.inMs + (tMs - start) };
    start += d;
  }
  const last = clips[clips.length - 1];
  return { clip: last, index: clips.length - 1, startMs: start - clipDuration(last), sourceMs: last.outMs };
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
  if (!loc) return project;
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

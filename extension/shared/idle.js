/**
 * Auto-purge of idle stretches: "skip the parts where nothing moves."
 *
 * The browser-bound half (editor/motion.js) turns a recording into motion
 * samples - for each sample time, how much the picture changed since the
 * previous sample. Everything that decides what to cut lives here, pure and
 * unit-tested: which stretches count as active, how much slack to keep
 * around them, which idle gaps are too short to be worth a cut, and how the
 * clip gets replaced by the kept pieces.
 *
 * @typedef {{ tMs: number, score: number }} MotionSample
 *   clip-local time and the change since the previous sample (changed pixels
 *   per 10,000; 0 for the first sample)
 * @typedef {{ startMs: number, endMs: number }} Range  clip-local, half-open
 */
import { MIN_CLIP_MS } from './project.js';

export const IDLE_DEFAULTS = {
  /** Motion at or above this (changed pixels per 10,000) counts as movement. */
  threshold: 2,
  /** Keep this much before a movement starts... */
  padBeforeMs: 300,
  /** ...and this much after it ends, so cuts don't feel abrupt. */
  padAfterMs: 500,
  /** Idle gaps shorter than this are not worth a cut; they stay in. */
  minIdleMs: 1000,
  /** How often the picture is sampled during analysis. */
  intervalMs: 200,
};

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The stretches of a clip worth keeping. A sample's score describes the
 * change between the previous sample and it, so movement at sample i is
 * taken to have happened somewhere in (t[i-1], t[i]]; that whole interval
 * is kept, plus the padding on either side. Overlapping keeps merge; idle
 * gaps shorter than `minIdleMs` are bridged. Empty when nothing moved at all
 * (the caller decides what that means - it is never "delete the clip").
 * @param {MotionSample[]} samples ascending by tMs
 * @param {number} durationMs clip length
 * @returns {Range[]}
 */
export function activeRanges(samples, durationMs, opts = {}) {
  const { threshold, padBeforeMs, padAfterMs, minIdleMs } = { ...IDLE_DEFAULTS, ...opts };
  const ranges = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].score < threshold) continue;
    const from = (i > 0 ? samples[i - 1].tMs : samples[i].tMs) - padBeforeMs;
    const to = samples[i].tMs + padAfterMs;
    const last = ranges[ranges.length - 1];
    if (last && from <= last.endMs) last.endMs = Math.max(last.endMs, to);
    else ranges.push({ startMs: from, endMs: to });
  }
  const bridged = [];
  for (const r of ranges) {
    const last = bridged[bridged.length - 1];
    if (last && r.startMs - last.endMs < minIdleMs) last.endMs = r.endMs;
    else bridged.push({ ...r });
  }
  return bridged
    .map((r) => ({ startMs: Math.max(0, r.startMs), endMs: Math.min(durationMs, r.endMs) }))
    .filter((r) => r.endMs > r.startMs);
}

/** What applying `ranges` to a clip of `durationMs` would do, for the UI to show before committing. */
export function idleSummary(ranges, durationMs) {
  const keptMs = ranges.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
  return { keptMs, removedMs: Math.max(0, durationMs - keptMs), pieces: ranges.length };
}

/**
 * Replace a video clip with one clip per kept range (clip-local ms, relative
 * to the clip's own in-point). Ranges too short to be a clip are dropped;
 * if none survive, the project is returned unchanged - auto-purge never
 * deletes a clip outright. The first piece keeps the clip's id so a
 * selection on it survives. Overlays are project-time and stay put, the
 * same as every other edit that shortens the timeline.
 */
export function replaceClipWithRanges(project, clipId, ranges) {
  const idx = project.clips.findIndex((c) => c.id === clipId);
  if (idx < 0 || project.clips[idx].kind !== 'video') return project;
  const clip = project.clips[idx];
  const pieces = ranges
    .map((r) => ({ inMs: clip.inMs + Math.round(r.startMs), outMs: clip.inMs + Math.round(r.endMs) }))
    .map((r) => ({ inMs: Math.max(clip.inMs, r.inMs), outMs: Math.min(clip.outMs, r.outMs) }))
    .filter((r) => r.outMs - r.inMs >= MIN_CLIP_MS)
    .map((r, i) => ({ ...clip, id: i === 0 ? clip.id : uid(), inMs: r.inMs, outMs: r.outMs }));
  if (pieces.length === 0) return project;
  const clips = project.clips.slice();
  clips.splice(idx, 1, ...pieces);
  return { ...project, clips, updatedAt: Date.now() };
}

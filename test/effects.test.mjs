import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addOverlay,
  addOverlayKeyframe,
  addTrack,
  addZoomKeyframe,
  assignOverlayRows,
  clipDuration,
  clipFromRecording,
  createProject,
  fadeAlphaAt,
  freezeClipFromRecording,
  imageClipFromAsset,
  insertFreezeAt,
  moveTrack,
  overlayBoxAt,
  overlaysAt,
  overlayTransformAt,
  projectDuration,
  removeOverlay,
  removeOverlayKeyframe,
  removeTrack,
  removeZoomKeyframe,
  renameTrack,
  setClipDuration,
  setCrop,
  setFade,
  splitAt,
  updateOverlay,
  viewRectAt,
  zoomAt,
} from '../extension/shared/project.js';

const recA = { id: 'A', durationMs: 10_000 };

describe('freeze frames', () => {
  it('splits a video clip and inserts a held frame mid-clip', () => {
    const a = clipFromRecording(recA, 0, 10_000);
    const project = createProject('t', [a]);
    const next = insertFreezeAt(project, 4_000, 1_500);
    assert.equal(next.clips.length, 3);
    assert.equal(next.clips[0].kind, 'video');
    assert.deepEqual([next.clips[0].inMs, next.clips[0].outMs], [0, 4_000]);
    assert.equal(next.clips[1].kind, 'freeze');
    assert.equal(next.clips[1].atMs, 4_000);
    assert.equal(next.clips[1].holdMs, 1_500);
    assert.equal(next.clips[2].kind, 'video');
    assert.deepEqual([next.clips[2].inMs, next.clips[2].outMs], [4_000, 10_000]);
    assert.equal(projectDuration(next), 10_000 + 1_500);
  });

  it('inserts without splitting when already on a clip boundary', () => {
    const a = clipFromRecording(recA, 0, 10_000);
    const project = createProject('t', [a]);
    const atStart = insertFreezeAt(project, 0, 1_000);
    assert.equal(atStart.clips.length, 2);
    assert.equal(atStart.clips[0].kind, 'freeze');
    const atEnd = insertFreezeAt(project, 10_000, 1_000);
    assert.equal(atEnd.clips.length, 2);
    assert.equal(atEnd.clips[1].kind, 'freeze');
  });

  it('is a no-op off a video clip, or on an empty project', () => {
    const freeze = freezeClipFromRecording(recA, 500);
    const project = createProject('t', [freeze]);
    assert.equal(insertFreezeAt(project, 500), project);
    const empty = createProject('empty');
    assert.equal(insertFreezeAt(empty, 0), empty);
  });

  it('splitAt also divides a freeze hold in two (same frame, no source range to split)', () => {
    const freeze = freezeClipFromRecording(recA, 500, 2_000);
    const project = createProject('t', [freeze]);
    const next = splitAt(project, 1_200);
    assert.equal(next.clips.length, 2);
    assert.equal(next.clips[0].kind, 'freeze');
    assert.equal(next.clips[0].atMs, 500, 'both halves hold the same source frame');
    assert.equal(next.clips[0].holdMs, 1_200);
    assert.equal(next.clips[1].atMs, 500);
    assert.equal(next.clips[1].holdMs, 800);
    assert.notEqual(next.clips[1].id, freeze.id);
    assert.equal(projectDuration(next), 2_000);
  });

  it('splitAt refuses to split an image clip', () => {
    const image = imageClipFromAsset({ id: 'img1' }, 2_000);
    const project = createProject('t', [image]);
    assert.equal(splitAt(project, 1_000), project);
  });
});

describe('freeze and image clip durations', () => {
  it('clipDuration reads holdMs / durationMs, not in/out', () => {
    const freeze = freezeClipFromRecording(recA, 500, 2_000);
    assert.equal(clipDuration(freeze), 2_000);
    const image = imageClipFromAsset({ id: 'img1' }, 3_000);
    assert.equal(clipDuration(image), 3_000);
  });

  it('setClipDuration changes freeze/image only, clamped to MIN_CLIP_MS', () => {
    const freeze = freezeClipFromRecording(recA, 0, 2_000);
    const video = clipFromRecording(recA, 0, 5_000);
    let p = createProject('t', [freeze, video]);
    p = setClipDuration(p, freeze.id, 500);
    assert.equal(p.clips[0].holdMs, 500);
    p = setClipDuration(p, freeze.id, 10);
    assert.equal(p.clips[0].holdMs, 100);
    const untouched = setClipDuration(p, video.id, 999);
    assert.equal(untouched, p, 'video clips are unaffected (use trimClip)');
  });
});

describe('crop', () => {
  it('sets and clamps a crop rectangle', () => {
    const a = clipFromRecording(recA, 0, 10_000);
    let p = createProject('t', [a]);
    p = setCrop(p, a.id, { x: -1, y: 0.9, w: 2, h: 0.01 });
    assert.deepEqual(p.clips[0].crop, { x: 0, y: 0.9, w: 1, h: 0.05 });
  });

  it('clears a crop with null', () => {
    const a = clipFromRecording(recA, 0, 10_000);
    let p = createProject('t', [a]);
    p = setCrop(p, a.id, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    p = setCrop(p, a.id, null);
    assert.equal(p.clips[0].crop, undefined);
  });
});

describe('zoom keyframes', () => {
  it('interpolates linearly between keyframes and holds at the ends', () => {
    const a = clipFromRecording(recA, 0, 10_000);
    let p = createProject('t', [a]);
    p = addZoomKeyframe(p, a.id, { tMs: 1_000, x: 0.5, y: 0.5, scale: 1 });
    p = addZoomKeyframe(p, a.id, { tMs: 3_000, x: 0.8, y: 0.2, scale: 3 });
    const clip = p.clips[0];
    assert.deepEqual(zoomAt(clip, 0), { x: 0.5, y: 0.5, scale: 1 }, 'before first keyframe: holds');
    assert.deepEqual(zoomAt(clip, 2_000), { x: 0.65, y: 0.35, scale: 2 }, 'midpoint');
    assert.deepEqual(zoomAt(clip, 9_000), { x: 0.8, y: 0.2, scale: 3 }, 'after last: holds');
  });

  it('a keyframe near an existing one replaces it instead of stacking', () => {
    const a = clipFromRecording(recA, 0, 10_000);
    let p = createProject('t', [a]);
    p = addZoomKeyframe(p, a.id, { tMs: 1_000, x: 0.5, y: 0.5, scale: 2 });
    p = addZoomKeyframe(p, a.id, { tMs: 1_010, x: 0.6, y: 0.6, scale: 3 });
    assert.equal(p.clips[0].zoomKeyframes.length, 1);
    assert.equal(p.clips[0].zoomKeyframes[0].scale, 3);
  });

  it('removeZoomKeyframe drops one by time, no-op if absent', () => {
    const a = clipFromRecording(recA, 0, 10_000);
    let p = createProject('t', [a]);
    p = addZoomKeyframe(p, a.id, { tMs: 1_000, x: 0.5, y: 0.5, scale: 2 });
    assert.equal(removeZoomKeyframe(p, a.id, 5_000), p);
    p = removeZoomKeyframe(p, a.id, 1_000);
    assert.deepEqual(p.clips[0].zoomKeyframes, []);
  });

  it('scale and focal point are clamped to sane ranges', () => {
    const a = clipFromRecording(recA, 0, 10_000);
    let p = createProject('t', [a]);
    p = addZoomKeyframe(p, a.id, { tMs: 0, x: -1, y: 2, scale: 50 });
    assert.deepEqual(p.clips[0].zoomKeyframes[0], { tMs: 0, x: 0, y: 1, scale: 6 });
  });
});

describe('viewRectAt composes crop and zoom', () => {
  it('is the full frame with no crop or zoom', () => {
    const a = clipFromRecording(recA, 0, 10_000);
    assert.deepEqual(viewRectAt(a, 0), { x: 0, y: 0, w: 1, h: 1 });
  });

  it('zoom alone narrows around its focal point', () => {
    const a = clipFromRecording(recA, 0, 10_000);
    let p = createProject('t', [a]);
    p = addZoomKeyframe(p, a.id, { tMs: 0, x: 0.5, y: 0.5, scale: 2 });
    assert.deepEqual(viewRectAt(p.clips[0], 0), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  });

  it('zoom is confined inside an existing crop', () => {
    const a = clipFromRecording(recA, 0, 10_000);
    let p = createProject('t', [a]);
    p = setCrop(p, a.id, { x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
    p = addZoomKeyframe(p, a.id, { tMs: 0, x: 0, y: 0, scale: 2 }); // wants top-left corner
    const view = viewRectAt(p.clips[0], 0);
    // half-size window, clamped to stay within the 0.2..0.6 crop on both axes
    assert.deepEqual(view, { x: 0.2, y: 0.2, w: 0.2, h: 0.2 });
  });
});

describe('fade to black', () => {
  it('clamps fade lengths to half the clip and computes overlay alpha', () => {
    const a = clipFromRecording(recA, 0, 2_000); // 2s clip
    let p = createProject('t', [a]);
    p = setFade(p, a.id, { fadeInMs: 5_000, fadeOutMs: 400 });
    const clip = p.clips[0];
    assert.equal(clip.fadeInMs, 1_000, 'clamped to half the clip');
    assert.equal(clip.fadeOutMs, 400);
    assert.equal(fadeAlphaAt(clip, 0, 2_000), 1, 'fully black at the very start of a fade-in');
    assert.equal(fadeAlphaAt(clip, 1_000, 2_000), 0, 'fade-in finished');
    assert.equal(fadeAlphaAt(clip, 1_800, 2_000), 0.5, 'halfway through fade-out');
    assert.equal(fadeAlphaAt(clip, 1_999, 2_000), Math.min(1, 1 - 1 / 400), 'near the very end');
  });
});

describe('overlays', () => {
  it('adds with a default keyframe, updates content, and is visible only in its time window', () => {
    let p = createProject('t');
    p = addOverlay(p, { source: 'text', content: { text: 'hello' }, startMs: 1_000, durationMs: 2_000 });
    const overlay = p.overlays[0];
    assert.equal(overlay.source, 'text');
    assert.equal(overlay.content.text, 'hello');
    assert.equal(overlay.keyframes.length, 1, 'a new overlay always has at least one keyframe');
    assert.deepEqual(overlaysAt(p, 999), []);
    assert.deepEqual(overlaysAt(p, 1_000), [overlay]);
    assert.deepEqual(overlaysAt(p, 2_999), [overlay]);
    assert.deepEqual(overlaysAt(p, 3_000), []);

    p = updateOverlay(p, overlay.id, { content: { text: 'bye' } });
    assert.equal(p.overlays[0].content.text, 'bye');
    assert.equal(p.overlays[0].content.color, '#ffffff', 'partial content patch merges, not replaces');

    p = removeOverlay(p, overlay.id);
    assert.deepEqual(p.overlays, []);
    assert.equal(removeOverlay(p, 'nope'), p);
  });

  it('enforces a minimum duration, non-negative start, and a minimum box size', () => {
    let p = createProject('t');
    p = addOverlay(p, { startMs: -50, durationMs: 10, w: 0, h: -1 });
    const o = p.overlays[0];
    assert.equal(o.startMs, 0);
    assert.equal(o.durationMs, 200);
    assert.equal(o.w, 0.02);
    assert.equal(o.h, 0.02);
  });

  it('arrow content carries its own endpoints, other shapes do not', () => {
    let p = createProject('t');
    p = addOverlay(p, { source: 'shape', content: { kind: 'arrow' } });
    assert.deepEqual(p.overlays[0].content, { kind: 'arrow', fill: null, stroke: '#ff4d4f', strokeWidth: 3, cornerRadius: 0, x1: 0, y1: 0, x2: 1, y2: 1 });
    p = addOverlay(p, { source: 'shape', content: { kind: 'rect' } });
    assert.deepEqual(p.overlays[1].content, { kind: 'rect', fill: null, stroke: '#ff4d4f', strokeWidth: 3, cornerRadius: 0 });
  });

  it('a bare legacy `color` (pre-preset overlays) is treated as the stroke', () => {
    let p = createProject('t');
    p = addOverlay(p, { source: 'shape', content: { kind: 'rect', color: '#00ff00' } });
    assert.equal(p.overlays[0].content.stroke, '#00ff00');
  });

  it('new overlays default onto the project\'s first track', () => {
    let p = createProject('t');
    p = addOverlay(p, {});
    assert.equal(p.overlays[0].trackId, p.tracks[0].id);
  });
});

describe('overlay keyframes and transform', () => {
  it('interpolates position/scale/rotation/opacity, holding at the ends', () => {
    let p = createProject('t');
    p = addOverlay(p, { keyframes: [{ tMs: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 0 }] });
    const id = p.overlays[0].id;
    p = addOverlayKeyframe(p, id, { tMs: 2_000, x: 1, y: 1, scale: 2, rotation: 90, opacity: 1 });
    const overlay = p.overlays[0];
    assert.deepEqual(overlayTransformAt(overlay, 0), { x: 0, y: 0, scale: 1, rotation: 0, opacity: 0 });
    assert.deepEqual(overlayTransformAt(overlay, 1_000), { x: 0.5, y: 0.5, scale: 1.5, rotation: 45, opacity: 0.5 });
    assert.deepEqual(overlayTransformAt(overlay, 5_000), { x: 1, y: 1, scale: 2, rotation: 90, opacity: 1 }, 'holds past the last keyframe');
  });

  it('a keyframe near an existing one replaces it instead of stacking', () => {
    let p = createProject('t');
    p = addOverlay(p, {}); // starts with one default keyframe at tMs: 0
    const id = p.overlays[0].id;
    p = addOverlayKeyframe(p, id, { tMs: 1_000, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 });
    p = addOverlayKeyframe(p, id, { tMs: 1_010, x: 0.9, y: 0.9, scale: 2, rotation: 0, opacity: 1 });
    assert.equal(p.overlays[0].keyframes.length, 2, 'the 1010 kf replaced the 1000 one, but the default at 0 remains');
    assert.equal(p.overlays[0].keyframes[1].scale, 2);
  });

  it('removeOverlayKeyframe refuses to remove the last one', () => {
    let p = createProject('t');
    p = addOverlay(p, {});
    const id = p.overlays[0].id;
    const untouched = removeOverlayKeyframe(p, id, p.overlays[0].keyframes[0].tMs);
    assert.equal(untouched, p, 'an overlay always keeps at least one keyframe');
    p = addOverlayKeyframe(p, id, { tMs: 1_000, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 });
    p = removeOverlayKeyframe(p, id, 0);
    assert.equal(p.overlays[0].keyframes.length, 1);
  });

  it('scale/opacity are clamped, but position is not (off-stage keyframes are intentional)', () => {
    let p = createProject('t');
    p = addOverlay(p, { keyframes: [{ tMs: 0, x: -5, y: 5, scale: 50, rotation: 720, opacity: 3 }] });
    assert.deepEqual(p.overlays[0].keyframes[0], { tMs: 0, x: -5, y: 5, scale: 10, rotation: 720, opacity: 1 });
  });

  it('overlayBoxAt positions the box by anchor, and pivots rotation on the anchor point', () => {
    let p = createProject('t');
    p = addOverlay(p, { anchor: 'center', w: 0.2, h: 0.1, keyframes: [{ tMs: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 }] });
    let box = overlayBoxAt(p.overlays[0], 0);
    assert.deepEqual(box, { x: 0.4, y: 0.45, w: 0.2, h: 0.1, cx: 0.5, cy: 0.5, rotation: 0, opacity: 1 });

    p = addOverlay(p, { anchor: 'top-left', w: 0.2, h: 0.1, keyframes: [{ tMs: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 }] });
    box = overlayBoxAt(p.overlays[1], 0);
    assert.deepEqual(box, { x: 0.5, y: 0.5, w: 0.2, h: 0.1, cx: 0.5, cy: 0.5, rotation: 0, opacity: 1 });
  });
});

describe('automatic overlay row-packing', () => {
  it('non-overlapping overlays share row 0', () => {
    const a = { id: 'a', startMs: 0, durationMs: 1_000 };
    const b = { id: 'b', startMs: 1_000, durationMs: 1_000 };
    const rows = assignOverlayRows([a, b]);
    assert.equal(rows.get('a'), 0);
    assert.equal(rows.get('b'), 0);
  });

  it('overlapping overlays open a new row', () => {
    const a = { id: 'a', startMs: 0, durationMs: 2_000 };
    const b = { id: 'b', startMs: 1_000, durationMs: 2_000 };
    const rows = assignOverlayRows([a, b]);
    assert.notEqual(rows.get('a'), rows.get('b'));
  });

  it('reuses a freed row rather than always growing', () => {
    const a = { id: 'a', startMs: 0, durationMs: 1_000 };
    const b = { id: 'b', startMs: 0, durationMs: 2_000 }; // collides with a: row 1
    const c = { id: 'c', startMs: 1_500, durationMs: 500 }; // free of a's row (0) by then
    const rows = assignOverlayRows([a, b, c]);
    assert.equal(rows.get('a'), 0);
    assert.equal(rows.get('b'), 1);
    assert.equal(rows.get('c'), 0);
  });
});

describe('tracks (manual overlay grouping)', () => {
  it('a new project starts with one track, and can add more', () => {
    let p = createProject('t');
    assert.equal(p.tracks.length, 1);
    p = addTrack(p, 'Captions');
    assert.equal(p.tracks.length, 2);
    assert.equal(p.tracks[1].name, 'Captions');
  });

  it('addTrack falls back to a numbered name when none is given', () => {
    let p = createProject('t');
    p = addTrack(p, '');
    assert.equal(p.tracks[1].name, 'Track 2');
  });

  it('renameTrack renames just the one track', () => {
    let p = createProject('t');
    p = addTrack(p, 'Logo');
    p = renameTrack(p, p.tracks[0].id, 'Main captions');
    assert.equal(p.tracks[0].name, 'Main captions');
    assert.equal(p.tracks[1].name, 'Logo');
  });

  it('removeTrack moves its overlays to the previous track and refuses to remove the last one', () => {
    let p = createProject('t');
    p = addTrack(p, 'Track 2');
    const [track1, track2] = p.tracks;
    p = addOverlay(p, { trackId: track2.id });
    p = removeTrack(p, track2.id);
    assert.equal(p.tracks.length, 1);
    assert.equal(p.overlays[0].trackId, track1.id, 'orphaned overlay moved to the remaining track');
    assert.equal(removeTrack(p, p.tracks[0].id), p, 'refuses to remove the last track');
  });

  it('removeTrack falls back to the track after it when removing the first track', () => {
    let p = createProject('t');
    p = addTrack(p, 'Track 2');
    p = addTrack(p, 'Track 3');
    const [track1, track2, track3] = p.tracks;
    p = addOverlay(p, { trackId: track1.id });
    p = removeTrack(p, track1.id);
    assert.deepEqual(p.tracks.map((t) => t.id), [track2.id, track3.id]);
    assert.equal(p.overlays[0].trackId, track2.id, 'the first track\'s overlay moved to the next one, not a previous one that no longer exists');
  });

  it('moveTrack reorders tracks for display', () => {
    let p = createProject('t');
    p = addTrack(p, 'B');
    p = addTrack(p, 'C');
    const bId = p.tracks[1].id;
    p = moveTrack(p, bId, 0);
    assert.deepEqual(p.tracks.map((t) => t.name), ['B', 'Track 1', 'C']);
  });

  it('updateOverlay ignores a trackId that does not belong to the project', () => {
    let p = createProject('t');
    p = addOverlay(p, {});
    const original = p.overlays[0].trackId;
    p = updateOverlay(p, p.overlays[0].id, { trackId: 'nope' });
    assert.equal(p.overlays[0].trackId, original);
  });
});

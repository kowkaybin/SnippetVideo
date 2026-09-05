import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addLayer,
  addZoomKeyframe,
  clipDuration,
  clipFromRecording,
  createProject,
  fadeAlphaAt,
  freezeClipFromRecording,
  imageClipFromAsset,
  insertFreezeAt,
  layersAt,
  projectDuration,
  removeLayer,
  removeZoomKeyframe,
  setClipDuration,
  setCrop,
  setFade,
  updateLayer,
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

describe('layers', () => {
  it('adds with defaults, updates, and is visible only in its time window', () => {
    let p = createProject('t');
    p = addLayer(p, { kind: 'text', text: 'hello', startMs: 1_000, durationMs: 2_000 });
    const layer = p.layers[0];
    assert.equal(layer.kind, 'text');
    assert.equal(layer.text, 'hello');
    assert.deepEqual(layersAt(p, 999), []);
    assert.deepEqual(layersAt(p, 1_000), [layer]);
    assert.deepEqual(layersAt(p, 2_999), [layer]);
    assert.deepEqual(layersAt(p, 3_000), []);

    p = updateLayer(p, layer.id, { text: 'bye', x: 0.1 });
    assert.equal(p.layers[0].text, 'bye');
    assert.equal(p.layers[0].x, 0.1);

    p = removeLayer(p, layer.id);
    assert.deepEqual(p.layers, []);
    assert.equal(removeLayer(p, 'nope'), p);
  });

  it('enforces a minimum duration and non-negative start', () => {
    let p = createProject('t');
    p = addLayer(p, { startMs: -50, durationMs: 10 });
    assert.equal(p.layers[0].startMs, 0);
    assert.equal(p.layers[0].durationMs, 200);
  });
});

describe('layer rects are clamped like crop rects', () => {
  it('keeps a layer inside [0,1] with a minimum size', () => {
    let p = createProject('t');
    p = addLayer(p, { x: 0.5, y: 0.5, w: 0.3, h: 0.3 });
    p = updateLayer(p, p.layers[0].id, { x: -0.5, y: 0.95, w: 2, h: 0.001 });
    assert.deepEqual(
      { x: p.layers[0].x, y: p.layers[0].y, w: p.layers[0].w, h: p.layers[0].h },
      { x: 0, y: 0.95, w: 1, h: 0.02 },
    );
  });
});

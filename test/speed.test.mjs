import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SPEED, MIN_CLIP_MS, MIN_SPEED, clipAt, clipDuration, clipFromRecording, clipSpeed, createProject, projectDuration, setClipSpeed, sourceMsFor, splitAt } from '../extension/shared/project.js';
import { speedUpIdleRanges } from '../extension/shared/idle.js';

const rec = { id: 'A', durationMs: 10_000 };

describe('clip speed', () => {
  it('defaults to 1 and is stored as absent at 1', () => {
    let p = createProject('t', [clipFromRecording(rec, 0, 4_000)]);
    const id = p.clips[0].id;
    assert.equal(clipSpeed(p.clips[0]), 1);
    p = setClipSpeed(p, id, 4);
    assert.equal(p.clips[0].speed, 4);
    p = setClipSpeed(p, id, 1);
    assert.equal('speed' in p.clips[0], false);
  });

  it('clamps to the allowed range and ignores non-video clips', () => {
    let p = createProject('t', [clipFromRecording(rec, 0, 4_000), { id: 'img', kind: 'image', assetId: 'x', durationMs: 1000 }]);
    p = setClipSpeed(p, p.clips[0].id, 99);
    assert.equal(p.clips[0].speed, MAX_SPEED);
    p = setClipSpeed(p, p.clips[0].id, 0.01);
    assert.equal(p.clips[0].speed, MIN_SPEED);
    assert.equal(setClipSpeed(p, 'img', 4), p);
    assert.equal(setClipSpeed(p, 'nope', 4), p);
  });

  it('divides the clip duration and multiplies the source clock', () => {
    let p = createProject('t', [clipFromRecording(rec, 1_000, 5_000), clipFromRecording(rec, 0, 2_000)]);
    p = setClipSpeed(p, p.clips[0].id, 20);
    assert.equal(clipDuration(p.clips[0]), 200);
    assert.equal(projectDuration(p), 2_200);
    assert.equal(sourceMsFor(p.clips[0], 150), 1_000 + 150 * 20);
    assert.deepEqual(clipAt(p, 150), { clip: p.clips[0], index: 0, startMs: 0, sourceMs: 4_000 });
    assert.deepEqual(clipAt(p, 200), { clip: p.clips[1], index: 1, startMs: 200, sourceMs: 0 });
  });

  it('splits a sped-up clip at the source frame under the playhead, both halves keeping the speed', () => {
    let p = createProject('t', [clipFromRecording(rec, 0, 8_000)]);
    p = setClipSpeed(p, p.clips[0].id, 4); // plays for 2000ms
    p = splitAt(p, 500); // 500 output ms in = 2000 source ms in
    assert.equal(p.clips.length, 2);
    assert.deepEqual([p.clips[0].inMs, p.clips[0].outMs, p.clips[0].speed], [0, 2_000, 4]);
    assert.deepEqual([p.clips[1].inMs, p.clips[1].outMs, p.clips[1].speed], [2_000, 8_000, 4]);
    assert.equal(projectDuration(p), 2_000);
  });

  it('the split minimum is about the source range kept, not output time', () => {
    let p = createProject('t', [clipFromRecording(rec, 0, 8_000)]);
    p = setClipSpeed(p, p.clips[0].id, 20); // 400ms of output
    const split = splitAt(p, 10); // 200 source ms in: fine, even though it plays for 10ms
    assert.equal(split.clips.length, 2);
    assert.equal(splitAt(p, 2), p, '2 output ms = 40 source ms, under MIN_CLIP_MS');
    assert.ok(MIN_CLIP_MS > 40);
  });
});

describe('speedUpIdleRanges', () => {
  const clipOf = (p) => p.clips[0];

  it('splits into active pieces at the own speed and idle pieces at the given speed', () => {
    let p = createProject('t', [clipFromRecording(rec, 1_000, 6_000)]);
    const id = clipOf(p).id;
    p = speedUpIdleRanges(p, id, [{ startMs: 1_000, endMs: 3_000 }], 20);
    assert.deepEqual(
      p.clips.map((c) => [c.inMs, c.outMs, c.speed ?? 1]),
      [
        [1_000, 2_000, 20], // idle before
        [2_000, 4_000, 1], // active
        [4_000, 6_000, 20], // idle after
      ],
    );
    assert.equal(p.clips[0].id, id, 'first piece keeps the id');
    assert.equal(projectDuration(p), 50 + 2_000 + 100);
  });

  it('keeps an existing speed on the active pieces', () => {
    let p = createProject('t', [{ ...clipFromRecording(rec, 0, 4_000), speed: 2 }]);
    p = speedUpIdleRanges(p, clipOf(p).id, [{ startMs: 0, endMs: 2_000 }], 10);
    assert.deepEqual(
      p.clips.map((c) => c.speed),
      [2, 10],
    );
  });

  it('folds gaps and pieces shorter than a clip into their neighbour', () => {
    let p = createProject('t', [clipFromRecording(rec, 0, 4_000)]);
    // 40ms idle gap at the start and a 30ms active sliver in the middle: both below MIN_CLIP_MS
    p = speedUpIdleRanges(p, clipOf(p).id, [{ startMs: 40, endMs: 2_000 }, { startMs: 3_000, endMs: 3_030 }], 20);
    assert.deepEqual(
      p.clips.map((c) => [c.inMs, c.outMs, c.speed ?? 1]),
      [
        [0, 2_000, 1],
        [2_000, 4_000, 20],
      ],
    );
  });

  it('no idle stretch long enough: unchanged project', () => {
    const p = createProject('t', [clipFromRecording(rec, 0, 4_000)]);
    assert.equal(speedUpIdleRanges(p, clipOf(p).id, [{ startMs: 0, endMs: 4_000 }], 20), p);
    assert.equal(speedUpIdleRanges(p, 'nope', [], 20), p);
  });
});

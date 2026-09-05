import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_CLIP_MS,
  addClip,
  clipAt,
  clipFromRecording,
  clipStart,
  createProject,
  moveClip,
  projectDuration,
  removeClip,
  splitAt,
  trimClip,
} from '../extension/shared/project.js';

const recA = { id: 'A', durationMs: 10_000 };
const recB = { id: 'B', durationMs: 4_000 };

function twoClips() {
  const a = clipFromRecording(recA, 1_000, 6_000); // 5 s
  const b = clipFromRecording(recB); // 4 s
  return { project: createProject('t', [a, b]), a, b };
}

describe('duration and lookup', () => {
  it('sums clip durations', () => {
    const { project } = twoClips();
    assert.equal(projectDuration(project), 9_000);
    assert.equal(projectDuration(createProject('empty')), 0);
  });

  it('maps project time to clip and source time', () => {
    const { project, a, b } = twoClips();
    assert.deepEqual(clipAt(project, 0), { clip: a, index: 0, startMs: 0, sourceMs: 1_000 });
    assert.deepEqual(clipAt(project, 4_999), { clip: a, index: 0, startMs: 0, sourceMs: 5_999 });
    assert.deepEqual(clipAt(project, 5_000), { clip: b, index: 1, startMs: 5_000, sourceMs: 0 });
    assert.deepEqual(clipAt(project, 7_500), { clip: b, index: 1, startMs: 5_000, sourceMs: 2_500 });
  });

  it('past the end, returns the last clip at its final millisecond', () => {
    const { project, b } = twoClips();
    assert.deepEqual(clipAt(project, 99_000), { clip: b, index: 1, startMs: 5_000, sourceMs: 4_000 });
    assert.equal(clipAt(createProject('empty'), 0), null);
  });

  it('finds clip start times', () => {
    const { project, a, b } = twoClips();
    assert.equal(clipStart(project, a.id), 0);
    assert.equal(clipStart(project, b.id), 5_000);
    assert.equal(clipStart(project, 'nope'), -1);
  });
});

describe('edits are non-destructive', () => {
  it('add, remove and move return new projects', () => {
    const { project, a, b } = twoClips();
    const c = clipFromRecording(recA, 0, 1_000);
    const added = addClip(project, c, 1);
    assert.deepEqual(added.clips.map((x) => x.id), [a.id, c.id, b.id]);
    assert.equal(project.clips.length, 2, 'original untouched');
    const moved = moveClip(added, c.id, 2);
    assert.deepEqual(moved.clips.map((x) => x.id), [a.id, b.id, c.id]);
    const removed = removeClip(moved, a.id);
    assert.deepEqual(removed.clips.map((x) => x.id), [b.id, c.id]);
    assert.equal(removeClip(removed, 'nope'), removed, 'unknown id is a no-op');
  });

  it('trims within source bounds and minimum length', () => {
    const { project, a } = twoClips();
    let p = trimClip(project, a.id, { inMs: -500 });
    assert.equal(p.clips[0].inMs, 0);
    p = trimClip(p, a.id, { outMs: 50_000 });
    assert.equal(p.clips[0].outMs, 10_000);
    p = trimClip(p, a.id, { inMs: 9_990 });
    assert.equal(p.clips[0].outMs - p.clips[0].inMs, MIN_CLIP_MS);
    assert.equal(p.clips[0].outMs, 10_000);
    assert.equal(trimClip(p, a.id, {}), p, 'no change is a no-op');
  });

  it('splits at project time and keeps total duration', () => {
    const { project, a } = twoClips();
    const split = splitAt(project, 2_000);
    assert.equal(split.clips.length, 3);
    assert.equal(projectDuration(split), 9_000);
    assert.equal(split.clips[0].id, a.id);
    assert.deepEqual([split.clips[0].inMs, split.clips[0].outMs], [1_000, 3_000]);
    assert.deepEqual([split.clips[1].inMs, split.clips[1].outMs], [3_000, 6_000]);
    assert.equal(split.clips[1].recordingId, 'A');
    assert.notEqual(split.clips[1].id, a.id);
  });

  it('refuses splits that would create a sliver', () => {
    const { project } = twoClips();
    assert.equal(splitAt(project, 20), project);
    assert.equal(splitAt(project, 4_990), project);
    assert.equal(splitAt(project, 5_000 + 50), project);
    assert.equal(splitAt(createProject('empty'), 0).clips.length, 0);
  });
});

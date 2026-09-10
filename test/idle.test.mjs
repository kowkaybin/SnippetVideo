import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeRanges, idleSummary, replaceClipWithRanges } from '../extension/shared/idle.js';
import { createProject } from '../extension/shared/project.js';

const samples = (scores, intervalMs = 100) => scores.map((score, i) => ({ tMs: i * intervalMs, score }));
const opts = { threshold: 1, padBeforeMs: 0, padAfterMs: 0, minIdleMs: 0 };

describe('activeRanges', () => {
  it('keeps the interval a movement happened in - from the previous sample to this one', () => {
    // movement detected at t=300 means it happened somewhere in (200, 300]
    assert.deepEqual(activeRanges(samples([0, 0, 0, 5, 0, 0]), 600, opts), [{ startMs: 200, endMs: 300 }]);
  });

  it('merges consecutive active samples into one range', () => {
    assert.deepEqual(activeRanges(samples([0, 5, 5, 5, 0]), 500, opts), [{ startMs: 0, endMs: 300 }]);
  });

  it('pads before and after each movement', () => {
    const r = activeRanges(samples([0, 0, 0, 5, 0, 0, 0, 0]), 800, { ...opts, padBeforeMs: 50, padAfterMs: 120 });
    assert.deepEqual(r, [{ startMs: 150, endMs: 420 }]);
  });

  it('bridges idle gaps shorter than minIdleMs, keeps longer ones as cuts', () => {
    const scores = [0, 5, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 5];
    assert.deepEqual(activeRanges(samples(scores), 1300, { ...opts, minIdleMs: 350 }), [
      { startMs: 0, endMs: 500 }, // gap 100..400 (300ms) bridged
      { startMs: 1100, endMs: 1200 }, // gap 500..1100 (600ms) kept as a cut
    ]);
  });

  it('clamps padding to the clip, and pads that overlap merge', () => {
    // movements at 100 and 900 with 500ms pads: [0..600] and [300..1000] overlap -> one range, clamped to the clip
    const r = activeRanges(samples([0, 5, 0, 0, 0, 0, 0, 0, 0, 5]), 1000, { ...opts, padBeforeMs: 500, padAfterMs: 500 });
    assert.deepEqual(r, [{ startMs: 0, endMs: 1000 }]);
  });

  it('honours the threshold: faint change below it is idle', () => {
    assert.deepEqual(activeRanges(samples([0, 0.5, 0.9, 0]), 400, { ...opts, threshold: 1 }), []);
    assert.deepEqual(activeRanges(samples([0, 0.5, 1, 0]), 400, { ...opts, threshold: 1 }), [{ startMs: 100, endMs: 200 }]);
  });

  it('is empty when nothing ever moved', () => {
    assert.deepEqual(activeRanges(samples([0, 0, 0]), 300, opts), []);
    assert.deepEqual(activeRanges([], 300, opts), []);
  });

  it('uses the defaults when no options are given', () => {
    // one movement at 2000ms: keep [1800 - 300, 2000 + 500]
    const r = activeRanges(samples([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3], 200), 5000);
    assert.deepEqual(r, [{ startMs: 1500, endMs: 2500 }]);
  });
});

describe('idleSummary', () => {
  it('totals kept and removed time', () => {
    assert.deepEqual(idleSummary([{ startMs: 100, endMs: 400 }, { startMs: 900, endMs: 1000 }], 2000), { keptMs: 400, removedMs: 1600, pieces: 2 });
  });
});

describe('replaceClipWithRanges', () => {
  const clip = { id: 'c1', kind: 'video', recordingId: 'r', inMs: 1000, outMs: 6000, sourceDurationMs: 10000 };
  const other = { id: 'c2', kind: 'image', assetId: 'a', durationMs: 500 };
  const project = createProject('p', [clip, other]);

  it('splits the clip into one piece per range, offset by the clip\'s own in-point, in place', () => {
    const next = replaceClipWithRanges(project, 'c1', [
      { startMs: 0, endMs: 1500 },
      { startMs: 3000, endMs: 5000 },
    ]);
    assert.equal(next.clips.length, 3);
    assert.deepEqual(next.clips.map((c) => [c.inMs, c.outMs]).slice(0, 2), [
      [1000, 2500],
      [4000, 6000],
    ]);
    assert.equal(next.clips[0].id, 'c1', 'first piece keeps the id');
    assert.notEqual(next.clips[1].id, 'c1');
    assert.equal(next.clips[2], other, 'untouched clips are the same objects');
    assert.equal(project.clips.length, 2, 'non-destructive');
  });

  it('drops pieces shorter than a clip may be, and refuses to delete the clip outright', () => {
    assert.equal(replaceClipWithRanges(project, 'c1', [{ startMs: 0, endMs: 20 }]), project);
    assert.equal(replaceClipWithRanges(project, 'c1', []), project);
  });

  it('ignores ranges beyond the clip and non-video clips', () => {
    const next = replaceClipWithRanges(project, 'c1', [{ startMs: 4000, endMs: 9000 }]);
    assert.deepEqual([next.clips[0].inMs, next.clips[0].outMs], [5000, 6000]);
    assert.equal(replaceClipWithRanges(project, 'c2', [{ startMs: 0, endMs: 100 }]), project);
  });
});

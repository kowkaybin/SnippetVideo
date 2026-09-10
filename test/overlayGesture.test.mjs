import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { edgeResizeFromDrag, rotationFromDrag, scaleFromDrag } from '../extension/editor/overlayGesture.js';

describe('scaleFromDrag', () => {
  it('scales up proportionally to distance from the anchor, regardless of direction', () => {
    const start = { cx: 100, cy: 100, startHandleX: 150, startHandleY: 100, startScale: 1 }; // handle 50px right of anchor
    assert.equal(scaleFromDrag(start, 200, 100), 2, 'twice as far -> double scale');
    assert.equal(scaleFromDrag(start, 125, 100), 0.5, 'half as far -> half scale');
    assert.equal(scaleFromDrag(start, 150, 100), 1, 'no movement -> unchanged');
  });

  it('is rotation-invariant: only distance from the anchor matters, not angle', () => {
    const start = { cx: 0, cy: 0, startHandleX: 30, startHandleY: 40, startScale: 1 }; // distance 50
    // Same distance (50) but a totally different direction should give the same scale.
    assert.equal(scaleFromDrag(start, 0, 100), 2);
    assert.equal(scaleFromDrag(start, -100, 0), 2);
  });

  it('multiplies onto a non-1 starting scale', () => {
    const start = { cx: 0, cy: 0, startHandleX: 10, startHandleY: 0, startScale: 3 };
    assert.equal(scaleFromDrag(start, 20, 0), 6);
  });

  it('holds the starting scale if the handle started right on the anchor (no distance to compare against)', () => {
    const start = { cx: 50, cy: 50, startHandleX: 50, startHandleY: 50, startScale: 2 };
    assert.equal(scaleFromDrag(start, 90, 90), 2);
  });
});

describe('rotationFromDrag', () => {
  it('is 0deg when the pointer is straight above the anchor (the handle\'s rest position)', () => {
    assert.equal(rotationFromDrag(0, 0, 0, -10), 0);
  });

  it('is 90deg to the right (east), clockwise positive', () => {
    assert.equal(rotationFromDrag(0, 0, 10, 0), 90);
  });

  it('is 270deg to the left (west) - atan2 wraps to (-180, 180], so this comes out as 270, not -90; same angle either way', () => {
    assert.equal(rotationFromDrag(0, 0, -10, 0), 270);
  });

  it('is 180deg straight below', () => {
    assert.equal(rotationFromDrag(0, 0, 0, 10), 180);
  });

  it('works around a non-origin anchor point', () => {
    assert.equal(rotationFromDrag(500, 300, 500, 250), 0);
    assert.equal(rotationFromDrag(500, 300, 550, 300), 90);
  });
});

describe('edgeResizeFromDrag', () => {
  const box = { cx: 100, cy: 100, boxW: 80, boxH: 40, rotation: 0, ax: 0.5, ay: 0.5 };
  const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} vs ${expected}`);

  it('grows width from the right edge and keeps the left edge fixed (center anchor shifts half-way)', () => {
    const r = edgeResizeFromDrag({ ...box, edge: 'right' }, 20, 0);
    assert.equal(r.boxW, 100);
    assert.equal(r.boxH, 40);
    close(r.cx, 110, 'anchor moves by half the growth');
    close(r.cy, 100, 'y untouched');
    close(r.cx - r.boxW / 2, box.cx - box.boxW / 2, 'left edge stays where it was');
  });

  it('keeps the anchor still when it sits on the fixed edge', () => {
    const r = edgeResizeFromDrag({ ...box, edge: 'right', ax: 0 }, 20, 0); // anchor on the left edge
    close(r.cx, 100, 'anchor did not move');
    assert.equal(r.boxW, 100);
  });

  it('moves the anchor with the edge when it sits on the dragged edge', () => {
    const r = edgeResizeFromDrag({ ...box, edge: 'right', ax: 1 }, 20, 0);
    close(r.cx, 120, 'anchor rides along');
  });

  it('grows from the left edge when dragged leftwards, keeping the right edge fixed', () => {
    const r = edgeResizeFromDrag({ ...box, edge: 'left' }, -20, 0);
    assert.equal(r.boxW, 100);
    close(r.cx, 90, 'anchor moves left by half');
    close(r.cx + r.boxW / 2, box.cx + box.boxW / 2, 'right edge stays where it was');
  });

  it('handles the vertical edges the same way', () => {
    const b = edgeResizeFromDrag({ ...box, edge: 'bottom' }, 0, 30);
    assert.equal(b.boxH, 70);
    assert.equal(b.boxW, 80);
    close(b.cy, 115, 'anchor moves down by half');
    const t = edgeResizeFromDrag({ ...box, edge: 'top' }, 0, -30);
    assert.equal(t.boxH, 70);
    close(t.cy, 85, 'anchor moves up by half');
  });

  it('ignores pointer movement perpendicular to the edge', () => {
    const r = edgeResizeFromDrag({ ...box, edge: 'right' }, 0, 50);
    assert.equal(r.boxW, 80);
    close(r.cx, 100, 'no shift');
  });

  it('follows the rotated axis: a box turned 90deg has its width axis pointing down the screen', () => {
    const r = edgeResizeFromDrag({ ...box, edge: 'right', rotation: 90 }, 0, 20); // drag straight down
    close(r.boxW, 100, 'width grew');
    close(r.cx, 100, 'no sideways shift');
    close(r.cy, 110, 'anchor slid down the rotated width axis by half');
  });

  it('never shrinks below the minimum, and the anchor shift matches the clamped growth', () => {
    const r = edgeResizeFromDrag({ ...box, edge: 'right', minPx: 10 }, -500, 0);
    assert.equal(r.boxW, 10);
    close(r.cx, 100 + 0.5 * (10 - 80), 'shift reflects the actual (clamped) change, not the raw drag');
  });
});

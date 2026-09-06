import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rotationFromDrag, scaleFromDrag } from '../extension/editor/overlayGesture.js';

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

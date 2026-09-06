/**
 * Pure geometry for dragging an overlay directly on the stage: move, resize
 * (a corner handle), rotate (the rotate handle). All in pixel coordinates,
 * no DOM.
 *
 * Move needs nothing beyond a coordinate delta (translating a rotated box is
 * rotation-invariant), so it's not here - editors/editor.js does it inline.
 *
 * Resize and rotate both pivot around the overlay's anchor point (cx, cy).
 * The trick that keeps this simple despite rotation: scale is computed from
 * *distance* between the anchor and the pointer, which doesn't care what
 * angle the box is sitting at, so there's no need to "unrotate" anything to
 * get the magnitude right. The selection UI (editor.js) supplies `cx, cy`
 * and a drag handle's on-screen position by reading real, browser-computed
 * values (getBoundingClientRect on a CSS `transform: rotate()`-ed element),
 * not by re-deriving rotated corner positions by hand.
 */

/**
 * New scale from dragging a resize handle.
 * @param {{ cx: number, cy: number, startHandleX: number, startHandleY: number, startScale: number }} start
 *   the anchor point, the handle's on-screen position when the drag began, and the scale at that moment
 * @param {number} curX current pointer position
 * @param {number} curY
 * @returns {number}
 */
export function scaleFromDrag({ cx, cy, startHandleX, startHandleY, startScale }, curX, curY) {
  const startDist = Math.hypot(startHandleX - cx, startHandleY - cy);
  if (startDist < 1) return startScale;
  const curDist = Math.hypot(curX - cx, curY - cy);
  return startScale * (curDist / startDist);
}

/**
 * Rotation (degrees) from dragging the rotate handle, which rests directly
 * above the anchor point at rotation 0. Positive is clockwise, matching both
 * CSS `rotate()` and canvas `ctx.rotate()`.
 * @param {number} cx anchor point
 * @param {number} cy
 * @param {number} curX current pointer position
 * @param {number} curY
 * @returns {number}
 */
export function rotationFromDrag(cx, cy, curX, curY) {
  // atan2's 0deg points east; the handle's rest position is north (straight
  // up), which is -90deg in that convention, so shift by +90 to make north = 0.
  return (Math.atan2(curY - cy, curX - cx) * 180) / Math.PI + 90;
}

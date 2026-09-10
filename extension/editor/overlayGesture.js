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

/**
 * Drag one edge of the box to change the overlay's own width or height (its
 * `w`/`h`, not its scale), keeping the opposite edge fixed on screen. This is
 * the one gesture that has to think in the box's own axes: the pointer delta
 * is projected onto the box's (rotated) width or height axis. And because the
 * anchor point can sit anywhere along that axis, holding the far edge still
 * generally moves the anchor - so a new anchor position comes back too.
 * All pixels; the caller converts to stage fractions.
 * @param {{ edge: 'left'|'right'|'top'|'bottom', cx: number, cy: number, boxW: number, boxH: number,
 *           rotation: number, ax: number, ay: number, minPx?: number }} start
 *   anchor point, box size and rotation (degrees) at drag start; ax/ay the anchor's
 *   fractional offset across the box (0 = left/top edge, 1 = right/bottom edge)
 * @param {number} dx pointer delta since drag start
 * @param {number} dy
 * @returns {{ cx: number, cy: number, boxW: number, boxH: number }}
 */
export function edgeResizeFromDrag({ edge, cx, cy, boxW, boxH, rotation, ax, ay, minPx = 8 }, dx, dy) {
  const r = (rotation * Math.PI) / 180;
  const horizontal = edge === 'left' || edge === 'right';
  // Unit vector of the axis this edge moves along, on screen: the box's width
  // axis is (cos r, sin r); its height axis is that turned a quarter clockwise.
  const axisX = horizontal ? Math.cos(r) : -Math.sin(r);
  const axisY = horizontal ? Math.sin(r) : Math.cos(r);
  const along = dx * axisX + dy * axisY;
  const positiveEdge = edge === 'right' || edge === 'bottom'; // the edge at the far end of its axis
  const size = horizontal ? boxW : boxH;
  const next = Math.max(minPx, size + (positiveEdge ? along : -along));
  const grown = next - size;
  // Far edge dragged: the near edge stays put, so the anchor (a fraction of the
  // way along) shifts by that fraction of the growth. Near edge dragged: the
  // far edge stays put, so the anchor shifts the other way by the remainder.
  const at = horizontal ? ax : ay;
  const shift = positiveEdge ? at * grown : -(1 - at) * grown;
  return {
    cx: cx + axisX * shift,
    cy: cy + axisY * shift,
    boxW: horizontal ? next : boxW,
    boxH: horizontal ? boxH : next,
  };
}

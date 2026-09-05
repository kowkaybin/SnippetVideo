/**
 * Draws one overlay onto a canvas 2D context. Pure canvas primitives, no DOM
 * involved — the same reason this module exists at all: the live editor and
 * the future export pass can both call `drawOverlay` and are guaranteed to
 * agree, since neither is approximating the other (unlike crop/zoom's CSS
 * approximation of the canvas-exact export math).
 *
 * All coordinates in `overlay` are fractions of the stage (0..1, except
 * position which may go outside that range for off-stage keyframes); callers
 * pass the actual pixel size of the surface being drawn to.
 */
import { overlayBoxAt } from './project.js';

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./project.js').Overlay} overlay
 * @param {number} localMs overlay-local time (project time minus overlay.startMs)
 * @param {number} stageW pixel width of the surface being drawn to
 * @param {number} stageH pixel height
 * @param {{ image?: CanvasImageSource }} [opts] the loaded image, for 'image'-source overlays
 */
export function drawOverlay(ctx, overlay, localMs, stageW, stageH, opts = {}) {
  const box = overlayBoxAt(overlay, localMs);
  const x = box.x * stageW;
  const y = box.y * stageH;
  const w = box.w * stageW;
  const h = box.h * stageH;
  const cx = box.cx * stageW;
  const cy = box.cy * stageH;

  ctx.save();
  ctx.globalAlpha = box.opacity;
  ctx.translate(cx, cy);
  ctx.rotate((box.rotation * Math.PI) / 180);
  ctx.translate(-cx, -cy);

  if (overlay.source === 'shape') drawShape(ctx, overlay.content, x, y, w, h);
  else if (overlay.source === 'text') drawText(ctx, overlay.content, x, y, w, h, stageH);
  else if (overlay.source === 'image' && opts.image) ctx.drawImage(opts.image, x, y, w, h);

  ctx.restore();
}

function strokeWidthFor(w, h) {
  return Math.max(2, Math.min(w, h) * 0.04);
}

function drawShape(ctx, content, x, y, w, h) {
  ctx.strokeStyle = content.color;
  ctx.fillStyle = content.color;
  ctx.lineWidth = strokeWidthFor(w, h);
  if (content.kind === 'rect') {
    ctx.strokeRect(x, y, w, h);
  } else if (content.kind === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (content.kind === 'arrow') {
    drawArrow(ctx, x + content.x1 * w, y + content.y1 * h, x + content.x2 * w, y + content.y2 * h);
  }
}

function drawArrow(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(10, ctx.lineWidth * 3);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawText(ctx, content, x, y, w, h, stageH) {
  ctx.fillStyle = content.color;
  // fontSize is a fraction of stage height, not px, so it scales the same in
  // a small live preview and a full-resolution export.
  ctx.font = `700 ${Math.max(1, content.fontSize * stageH)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(content.text, x + w / 2, y + h / 2);
}

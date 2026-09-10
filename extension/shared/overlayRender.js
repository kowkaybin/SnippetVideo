/**
 * Draws one overlay onto a canvas 2D context. Pure canvas primitives, no DOM
 * involved — the same reason this module exists at all: the live editor, the
 * export pass and the preset preview tiles all call `drawOverlay` and are
 * guaranteed to agree, since none is approximating another (unlike crop/zoom's
 * CSS approximation of the canvas-exact export math).
 *
 * All coordinates in `overlay` are fractions of the stage (0..1, except
 * position which may go outside that range for off-stage keyframes); callers
 * pass the actual pixel size of the surface being drawn to. Pixel-ish style
 * values (stroke width) are specified for a 1280px-wide frame and scale with
 * the surface, so a 4px stroke is the same fraction of the picture in the
 * ~1000px preview, the 1280px tile and a 1920px export.
 */
import { overlayBoxAt } from './project.js';

/** Width the pixel-valued style fields (strokeWidth) are specified against. */
export const REFERENCE_WIDTH = 1280;

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

  if (overlay.source === 'shape') drawShape(ctx, overlay.content, x, y, w, h, stageW / REFERENCE_WIDTH);
  else if (overlay.source === 'text') drawText(ctx, overlay.content, x, y, w, h);
  else if (overlay.source === 'image' && opts.image) ctx.drawImage(opts.image, x, y, w, h);

  ctx.restore();
}

/** A soft drop shadow sized to the thing casting it; `off` clears it again. */
function shadow(ctx, on, size) {
  if (!on) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    return;
  }
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = size;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = size * 0.4;
}

function drawShape(ctx, content, x, y, w, h, px) {
  ctx.lineWidth = (content.strokeWidth ?? Math.max(2, Math.min(w, h) * 0.04)) * px;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (content.dash) ctx.setLineDash([ctx.lineWidth * 3, ctx.lineWidth * 2]);
  shadow(ctx, content.shadow, Math.max(4, Math.min(w, h) * 0.12));
  if (content.kind === 'arrow') {
    ctx.strokeStyle = content.stroke;
    ctx.fillStyle = content.stroke;
    drawArrow(ctx, x + content.x1 * w, y + content.y1 * h, x + content.x2 * w, y + content.y2 * h);
    return;
  }
  const path = new Path2D();
  if (content.kind === 'ellipse') {
    path.ellipse(x + w / 2, y + h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2);
  } else {
    // cornerRadius is a fraction of the box's shorter side: 0 square, 0.5 a pill.
    const r = Math.max(0, Math.min(content.cornerRadius ?? 0, 0.5)) * Math.min(w, h);
    if (r > 0) path.roundRect(x, y, w, h, r);
    else path.rect(x, y, w, h);
  }
  if (content.fill) {
    ctx.fillStyle = content.fill;
    ctx.fill(path);
    shadow(ctx, false); // the fill already cast it; a second one under the stroke would double up
  }
  if (content.stroke && ctx.lineWidth > 0) {
    ctx.strokeStyle = content.stroke;
    ctx.stroke(path);
  }
}

function drawArrow(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(10, ctx.lineWidth * 3);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawText(ctx, content, x, y, w, h) {
  // The text fits its box: type size comes from the box height, then shrinks
  // if the line would overrun the box width. So the selection chrome the
  // editor draws around the box is exactly the text's edit bound, and scaling
  // the box scales the text - no separate font-size to keep in step.
  const family = content.fontFamily ?? 'system-ui, sans-serif';
  const weight = content.fontWeight ?? '700';
  const text = content.uppercase ? String(content.text).toUpperCase() : String(content.text);
  const accentW = content.accent ? h * 0.1 : 0;
  const padX = h * 0.25;
  const padLeft = padX + (accentW ? accentW + h * 0.2 : 0);
  let fontPx = Math.max(1, h / 1.3);
  const setFont = () => {
    ctx.font = `${weight} ${fontPx}px ${family}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${fontPx * (content.tracking ?? 0)}px`;
  };
  setFont();
  const textW = ctx.measureText(text).width;
  const maxW = Math.max(1, w - padLeft - padX);
  if (textW > maxW) {
    fontPx = Math.max(1, fontPx * (maxW / textW));
    setFont();
  }

  if (content.background) {
    const bg = new Path2D();
    const r = Math.max(0, Math.min(content.cornerRadius ?? 0.15, 0.5)) * Math.min(w, h);
    bg.roundRect(x, y, w, h, r);
    shadow(ctx, content.shadow, h * 0.25);
    ctx.fillStyle = content.background;
    ctx.fill(bg);
    shadow(ctx, false);
    if (accentW) {
      ctx.fillStyle = content.accent;
      const bar = new Path2D();
      bar.roundRect(x + padX, y + h * 0.22, accentW, h * 0.56, accentW / 2);
      ctx.fill(bar);
    }
  } else {
    // No card to cast the shadow, so the glyphs themselves do.
    shadow(ctx, content.shadow, h * 0.18);
  }

  const align = content.align ?? 'center';
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  const tx = align === 'left' ? x + padLeft : align === 'right' ? x + w - padX : x + padLeft + (w - padLeft - padX) / 2;
  const ty = y + h / 2;
  if (content.outline) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = fontPx * 0.12;
    ctx.strokeStyle = content.outline;
    ctx.strokeText(text, tx, ty);
    shadow(ctx, false);
  }
  ctx.fillStyle = content.color;
  ctx.fillText(text, tx, ty);
}

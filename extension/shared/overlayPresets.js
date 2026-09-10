/**
 * Overlay presets: designed starting points for the things people actually
 * put on a screen recording - a title, a lower third, a callout box, a step
 * badge. Each preset is a complete look (content) plus a sensible layout
 * (size, anchor, position) so "add" drops something presentable, and the
 * same content doubles as a one-click style for an overlay that already
 * exists. Pure data + pure helpers; the editor renders each preset's preview
 * through the very same drawOverlay the stage and export use, so the tile is
 * what you get.
 *
 * Positions and sizes are stage fractions (see project.js). `square: true`
 * means the box should be square on screen, so its w is derived from h and
 * the frame's aspect ratio when the preset is instantiated.
 */

/** @typedef {import('./project.js').Overlay} Overlay */

/**
 * @typedef {object} OverlayPreset
 * @property {string} id
 * @property {string} name
 * @property {'text'|'shape'} source
 * @property {object} content   full content for a new overlay (see project.js)
 * @property {number} w
 * @property {number} h
 * @property {boolean} [square]
 * @property {Overlay['anchor']} anchor
 * @property {number} x
 * @property {number} y
 */

const DARK = 'rgba(15, 15, 20, 0.86)';
const RED = '#ff3b30';

/** @type {OverlayPreset[]} */
export const OVERLAY_PRESETS = [
  // ----- text -----
  {
    id: 'title',
    name: 'Title',
    source: 'text',
    content: { text: 'Title', color: '#ffffff', background: null, fontFamily: 'system-ui, sans-serif', fontWeight: '800', align: 'center', shadow: true },
    w: 0.6,
    h: 0.14,
    anchor: 'center',
    x: 0.5,
    y: 0.5,
  },
  {
    id: 'subtitle',
    name: 'Subtitle',
    source: 'text',
    content: { text: 'Subtitle', color: '#ffffff', background: null, fontFamily: 'system-ui, sans-serif', fontWeight: '600', align: 'center', outline: '#000000' },
    w: 0.7,
    h: 0.07,
    anchor: 'bottom',
    x: 0.5,
    y: 0.92,
  },
  {
    id: 'lower-third',
    name: 'Lower third',
    source: 'text',
    content: { text: 'Name or topic', color: '#ffffff', background: DARK, cornerRadius: 0.15, fontFamily: 'system-ui, sans-serif', fontWeight: '700', align: 'left', accent: '#dc2626', shadow: true },
    w: 0.42,
    h: 0.085,
    anchor: 'bottom-left',
    x: 0.05,
    y: 0.9,
  },
  {
    id: 'caption',
    name: 'Caption',
    source: 'text',
    content: { text: 'Caption', color: '#ffffff', background: 'rgba(0, 0, 0, 0.7)', cornerRadius: 0.3, fontFamily: 'system-ui, sans-serif', fontWeight: '600', align: 'center' },
    w: 0.55,
    h: 0.075,
    anchor: 'bottom',
    x: 0.5,
    y: 0.93,
  },
  {
    id: 'label',
    name: 'Label',
    source: 'text',
    content: { text: 'New', color: '#111111', background: '#fde047', cornerRadius: 0.25, fontFamily: 'system-ui, sans-serif', fontWeight: '700', align: 'center', uppercase: true, tracking: 0.08 },
    w: 0.14,
    h: 0.05,
    anchor: 'top-left',
    x: 0.04,
    y: 0.06,
  },
  {
    id: 'badge',
    name: 'Step badge',
    source: 'text',
    content: { text: '1', color: '#ffffff', background: '#dc2626', cornerRadius: 0.5, fontFamily: 'system-ui, sans-serif', fontWeight: '800', align: 'center', shadow: true },
    w: 0.1,
    h: 0.1,
    square: true,
    anchor: 'center',
    x: 0.12,
    y: 0.15,
  },
  {
    id: 'key',
    name: 'Keystroke',
    source: 'text',
    content: { text: 'Ctrl + K', color: '#111111', background: '#f4f4f5', cornerRadius: 0.2, fontFamily: 'ui-monospace, monospace', fontWeight: '700', align: 'center', shadow: true },
    w: 0.16,
    h: 0.06,
    anchor: 'center',
    x: 0.5,
    y: 0.5,
  },
  {
    id: 'note',
    name: 'Note',
    source: 'text',
    content: { text: 'A short note', color: '#1c1c22', background: '#ffffff', cornerRadius: 0.15, fontFamily: 'system-ui, sans-serif', fontWeight: '500', align: 'left', accent: '#2563eb', shadow: true },
    w: 0.34,
    h: 0.09,
    anchor: 'top-right',
    x: 0.96,
    y: 0.06,
  },

  // ----- shapes -----
  {
    id: 'callout',
    name: 'Callout',
    source: 'shape',
    content: { kind: 'rect', fill: null, stroke: RED, strokeWidth: 4, cornerRadius: 0.1, shadow: true },
    w: 0.3,
    h: 0.18,
    anchor: 'center',
    x: 0.5,
    y: 0.5,
  },
  {
    id: 'focus',
    name: 'Focus',
    source: 'shape',
    content: { kind: 'rect', fill: null, stroke: '#ffffff', strokeWidth: 3, cornerRadius: 0.04, dash: true, shadow: true },
    w: 0.3,
    h: 0.18,
    anchor: 'center',
    x: 0.5,
    y: 0.5,
  },
  {
    id: 'highlight',
    name: 'Highlight',
    source: 'shape',
    content: { kind: 'rect', fill: 'rgba(255, 214, 10, 0.4)', stroke: null, strokeWidth: 0, cornerRadius: 0.1 },
    w: 0.3,
    h: 0.06,
    anchor: 'center',
    x: 0.5,
    y: 0.5,
  },
  {
    id: 'filled',
    name: 'Solid',
    source: 'shape',
    content: { kind: 'rect', fill: '#ff4d4f', stroke: null, strokeWidth: 0, cornerRadius: 0.06, shadow: true },
    w: 0.3,
    h: 0.15,
    anchor: 'center',
    x: 0.5,
    y: 0.5,
  },
  {
    id: 'panel',
    name: 'Panel',
    source: 'shape',
    content: { kind: 'rect', fill: DARK, stroke: null, strokeWidth: 0, cornerRadius: 0.1, shadow: true },
    w: 0.4,
    h: 0.25,
    anchor: 'center',
    x: 0.5,
    y: 0.5,
  },
  {
    id: 'pill',
    name: 'Pill',
    source: 'shape',
    content: { kind: 'rect', fill: '#2563eb', stroke: null, strokeWidth: 0, cornerRadius: 0.5, shadow: true },
    w: 0.2,
    h: 0.06,
    anchor: 'center',
    x: 0.5,
    y: 0.5,
  },
  {
    id: 'ring',
    name: 'Ring',
    source: 'shape',
    content: { kind: 'ellipse', fill: null, stroke: RED, strokeWidth: 4, cornerRadius: 0, shadow: true },
    w: 0.25,
    h: 0.25,
    square: true,
    anchor: 'center',
    x: 0.5,
    y: 0.5,
  },
  {
    id: 'dot',
    name: 'Dot',
    source: 'shape',
    content: { kind: 'ellipse', fill: RED, stroke: null, strokeWidth: 0, cornerRadius: 0, shadow: true },
    w: 0.05,
    h: 0.05,
    square: true,
    anchor: 'center',
    x: 0.5,
    y: 0.5,
  },
  {
    id: 'arrow',
    name: 'Arrow',
    source: 'shape',
    content: { kind: 'arrow', fill: null, stroke: RED, strokeWidth: 5, cornerRadius: 0, shadow: true, x1: 0, y1: 1, x2: 1, y2: 0 },
    w: 0.25,
    h: 0.2,
    anchor: 'center',
    x: 0.5,
    y: 0.5,
  },
  {
    id: 'arrow-white',
    name: 'Arrow (white)',
    source: 'shape',
    content: { kind: 'arrow', fill: null, stroke: '#ffffff', strokeWidth: 4, cornerRadius: 0, shadow: true, x1: 0, y1: 1, x2: 1, y2: 0 },
    w: 0.25,
    h: 0.2,
    anchor: 'center',
    x: 0.5,
    y: 0.5,
  },
];

export function presetById(id) {
  return OVERLAY_PRESETS.find((p) => p.id === id);
}

/**
 * The presets whose look can be applied to `overlay` as-is: same source, and
 * for shapes the same family (an arrow only has a stroke, so box/ellipse looks
 * don't translate to it and vice versa).
 * @param {Overlay} overlay
 */
export function stylePresetsFor(overlay) {
  if (!overlay || overlay.source === 'image') return [];
  const arrow = overlay.source === 'shape' && overlay.content?.kind === 'arrow';
  return OVERLAY_PRESETS.filter((p) => p.source === overlay.source && (p.source !== 'shape' || (p.content.kind === 'arrow') === arrow));
}

/**
 * The content patch that restyles an existing overlay: everything about the
 * look, nothing about what it is (its text, its shape kind, arrow endpoints)
 * or where it sits.
 * @param {OverlayPreset} preset
 */
export function stylePatch(preset) {
  const { kind, text, x1, y1, x2, y2, ...look } = preset.content;
  // Optional look fields the preset leaves out are switched *off*, otherwise a
  // preset could never remove a shadow or an accent bar set by a previous one.
  const off = preset.source === 'text' ? { outline: null, accent: null, shadow: false, uppercase: false, tracking: 0, cornerRadius: 0.15, align: 'center' } : { dash: false, shadow: false };
  return { ...off, ...look };
}

/**
 * The addOverlay() input for a fresh overlay from `preset`, laid out where the
 * preset wants it.
 * @param {OverlayPreset} preset
 * @param {{ startMs?: number, durationMs?: number, frameAr?: number }} [opts]
 *   frameAr is the output frame's width/height, needed to keep `square` presets square.
 */
export function overlayFromPreset(preset, opts = {}) {
  const frameAr = opts.frameAr ?? 16 / 9;
  const w = preset.square ? preset.h / frameAr : preset.w;
  return {
    name: preset.name,
    source: preset.source,
    content: { ...preset.content },
    anchor: preset.anchor,
    w,
    h: preset.h,
    startMs: opts.startMs ?? 0,
    durationMs: opts.durationMs,
    keyframes: [{ tMs: 0, x: preset.x, y: preset.y, scale: 1, rotation: 0, opacity: 1 }],
  };
}

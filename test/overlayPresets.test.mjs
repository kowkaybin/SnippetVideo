import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OVERLAY_PRESETS, overlayFromPreset, presetById, stylePatch, stylePresetsFor } from '../extension/shared/overlayPresets.js';
import { addOverlay, createProject, updateOverlay } from '../extension/shared/project.js';

describe('overlay presets', () => {
  it('every preset is complete: unique id, a source, a full content, a layout inside the frame', () => {
    const ids = new Set();
    for (const p of OVERLAY_PRESETS) {
      assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
      ids.add(p.id);
      assert.ok(['text', 'shape'].includes(p.source), p.id);
      assert.ok(p.w > 0 && p.w <= 1 && p.h > 0 && p.h <= 1, `${p.id} size`);
      assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, `${p.id} position`);
      assert.ok(typeof p.anchor === 'string', p.id);
      if (p.source === 'text') assert.equal(typeof p.content.text, 'string', p.id);
      else assert.ok(['rect', 'ellipse', 'arrow'].includes(p.content.kind), p.id);
    }
  });

  it('a preset instantiates through addOverlay with its look and layout intact', () => {
    const p = addOverlay(createProject('t'), overlayFromPreset(presetById('lower-third'), { startMs: 1200, durationMs: 4000 }));
    const o = p.overlays[0];
    assert.equal(o.source, 'text');
    assert.equal(o.name, 'Lower third');
    assert.equal(o.anchor, 'bottom-left');
    assert.equal(o.startMs, 1200);
    assert.equal(o.durationMs, 4000);
    assert.deepEqual(o.keyframes, [{ tMs: 0, x: 0.05, y: 0.9, scale: 1, rotation: 0, opacity: 1 }]);
    assert.equal(o.content.accent, '#dc2626');
    assert.equal(o.content.align, 'left');
    assert.equal(o.content.shadow, true);
  });

  it('square presets get their width from the frame aspect ratio', () => {
    const badge = presetById('badge');
    assert.equal(overlayFromPreset(badge, { frameAr: 2 }).w, badge.h / 2);
    assert.equal(overlayFromPreset(badge).w, badge.h / (16 / 9));
    assert.equal(overlayFromPreset(presetById('title'), { frameAr: 2 }).w, presetById('title').w);
  });

  it('style presets are filtered by what the overlay is', () => {
    const base = createProject('t');
    const text = addOverlay(base, { source: 'text' }).overlays[0];
    const rect = addOverlay(base, { source: 'shape', content: { kind: 'rect' } }).overlays[0];
    const arrow = addOverlay(base, { source: 'shape', content: { kind: 'arrow' } }).overlays[0];
    const image = addOverlay(base, { source: 'image', content: { assetId: 'a' } }).overlays[0];
    assert.ok(stylePresetsFor(text).every((p) => p.source === 'text'));
    assert.ok(stylePresetsFor(rect).length > 0 && stylePresetsFor(rect).every((p) => p.source === 'shape' && p.content.kind !== 'arrow'));
    assert.ok(stylePresetsFor(arrow).length > 0 && stylePresetsFor(arrow).every((p) => p.content.kind === 'arrow'));
    assert.deepEqual(stylePresetsFor(image), []);
    assert.deepEqual(stylePresetsFor(null), []);
  });

  it('a style patch changes the look but keeps text, kind and endpoints', () => {
    let p = addOverlay(createProject('t'), { source: 'text', content: { text: 'Hello', accent: '#000' } });
    p = updateOverlay(p, p.overlays[0].id, { content: stylePatch(presetById('caption')) });
    const c = p.overlays[0].content;
    assert.equal(c.text, 'Hello');
    assert.equal(c.background, 'rgba(0, 0, 0, 0.7)');
    assert.equal(c.accent, null, 'a look the preset lacks is switched off, not left over');

    let s = addOverlay(createProject('t'), { source: 'shape', content: { kind: 'arrow', x1: 0.2, y1: 0.2 } });
    s = updateOverlay(s, s.overlays[0].id, { content: stylePatch(presetById('arrow-white')) });
    assert.equal(s.overlays[0].content.kind, 'arrow');
    assert.equal(s.overlays[0].content.x1, 0.2);
    assert.equal(s.overlays[0].content.stroke, '#ffffff');
  });
});

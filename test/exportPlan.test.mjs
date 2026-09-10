import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { codecCandidates, evenSize, fitRect, frameTimesMs, pickCodec } from '../extension/shared/exportPlan.js';

describe('frameTimesMs', () => {
  it('steps from 0 by 1000/fps and stops before the end', () => {
    assert.deepEqual(frameTimesMs(100, 10), [0]);
    assert.deepEqual(frameTimesMs(101, 10), [0, 100]);
    assert.deepEqual(frameTimesMs(1000, 4), [0, 250, 500, 750]);
  });

  it('covers a partial last frame interval (a 1.05s project at 1fps still needs a second frame)', () => {
    assert.deepEqual(frameTimesMs(1050, 1), [0, 1000]);
  });

  it('does not drift: frame 30000 at 30fps is exactly 1,000,000 ms', () => {
    const times = frameTimesMs(1_000_001, 30);
    assert.equal(times[30000], 1_000_000);
  });

  it('is empty for an empty project or a nonsense fps', () => {
    assert.deepEqual(frameTimesMs(0, 30), []);
    assert.deepEqual(frameTimesMs(1000, 0), []);
  });
});

describe('pickCodec', () => {
  it('prefers H.264 in an MP4 when the browser can encode it', async () => {
    const picked = await pickCodec({ width: 1280, height: 720, fps: 30, bitsPerSecond: 5e6 }, async () => ({ supported: true }));
    assert.equal(picked.mux, 'avc');
    assert.equal(picked.label, 'H.264');
    assert.equal(picked.config.avc.format, 'avc', 'MP4 wants length-prefixed (AVCC) NAL units, not Annex B');
    assert.equal(picked.config.bitrate, 5e6);
  });

  it('falls through to AV1, then VP9, when earlier candidates are unsupported', async () => {
    const onlyVp9 = async (c) => ({ supported: c.codec.startsWith('vp09') });
    assert.equal((await pickCodec({ width: 1280, height: 720, fps: 30, bitsPerSecond: 1 }, onlyVp9)).mux, 'vp9');
    const noH264 = async (c) => ({ supported: !c.codec.startsWith('avc1') });
    assert.equal((await pickCodec({ width: 1280, height: 720, fps: 30, bitsPerSecond: 1 }, noH264)).mux, 'av1');
  });

  it('treats a throwing support check like "unsupported" and returns null when nothing works', async () => {
    const boom = async () => {
      throw new TypeError('bad codec string');
    };
    assert.equal(await pickCodec({ width: 1280, height: 720, fps: 30, bitsPerSecond: 1 }, boom), null);
  });

  it('asks for higher levels above 1080p', () => {
    assert.equal(codecCandidates(1920, 1080)[0].codec, 'avc1.64002a');
    assert.equal(codecCandidates(2560, 1440)[0].codec, 'avc1.640033');
  });
});

describe('fitRect', () => {
  it('contain letterboxes a wide picture into a taller frame', () => {
    assert.deepEqual(fitRect(200, 100, 100, 100, 'contain'), { x: 0, y: 25, w: 100, h: 50 });
  });

  it('cover fills the frame and crops the excess, centered', () => {
    assert.deepEqual(fitRect(200, 100, 100, 100, 'cover'), { x: -50, y: 0, w: 200, h: 100 });
  });

  it('a picture already the frame\'s shape fills it exactly either way', () => {
    assert.deepEqual(fitRect(1280, 720, 1920, 1080, 'contain'), { x: 0, y: 0, w: 1920, h: 1080 });
    assert.deepEqual(fitRect(1280, 720, 1920, 1080, 'cover'), { x: 0, y: 0, w: 1920, h: 1080 });
  });

  it('degenerate source falls back to the whole frame rather than dividing by zero', () => {
    assert.deepEqual(fitRect(0, 0, 10, 20, 'contain'), { x: 0, y: 0, w: 10, h: 20 });
  });
});

describe('evenSize', () => {
  it('rounds odd dimensions down (H.264 chroma subsampling needs even sizes)', () => {
    assert.deepEqual(evenSize({ width: 1281, height: 721 }), { width: 1280, height: 720 });
    assert.deepEqual(evenSize({ width: 1280, height: 720 }), { width: 1280, height: 720 });
  });
});

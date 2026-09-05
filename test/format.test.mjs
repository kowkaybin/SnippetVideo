// Run with: node --test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatBadge, formatBytes, formatDuration, recordingName } from '../extension/shared/format.js';

describe('formatDuration', () => {
  it('formats seconds and minutes', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(59_000), '0:59');
    assert.equal(formatDuration(61_500), '1:01');
    assert.equal(formatDuration(3_600_000), '1:00:00');
    assert.equal(formatDuration(3_725_000), '1:02:05');
  });
});

describe('formatBadge', () => {
  it('keeps short timers verbatim and compresses long ones to fit the badge', () => {
    assert.equal(formatBadge(5_000), '0:05');
    assert.equal(formatBadge(599_000), '9:59');
    assert.equal(formatBadge(600_000), '10m');
    assert.equal(formatBadge(3_660_000), '1h1m');
    assert.ok(formatBadge(3_660_000).length <= 4);
  });
});

describe('formatBytes', () => {
  it('scales units', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(150 * 1024 * 1024), '150 MB');
  });
});

describe('recordingName', () => {
  it('is filesystem safe and sortable', () => {
    const name = recordingName(new Date(2026, 8, 5, 14, 3, 22));
    assert.equal(name, 'snippet-2026-09-05_14-03-22');
    assert.match(name, /^[a-z0-9_-]+$/);
  });
});

describe('formatTimecode', () => {
  it('adds hundredths', async () => {
    const { formatTimecode } = await import('../extension/shared/format.js');
    assert.equal(formatTimecode(0), '0:00.00');
    assert.equal(formatTimecode(1_234), '0:01.23');
    assert.equal(formatTimecode(65_005), '1:05.00');
  });
});

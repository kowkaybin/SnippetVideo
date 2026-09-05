import { describe, expect, it } from 'vitest';
import { formatBadge, formatBytes, formatDuration, recordingName } from '../src/shared/format';

describe('formatDuration', () => {
  it('formats seconds and minutes', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(59_000)).toBe('0:59');
    expect(formatDuration(61_500)).toBe('1:01');
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });
});

describe('formatBadge', () => {
  it('keeps short timers verbatim and compresses long ones to fit the badge', () => {
    expect(formatBadge(5_000)).toBe('0:05');
    expect(formatBadge(599_000)).toBe('9:59');
    expect(formatBadge(600_000)).toBe('10m');
    expect(formatBadge(3_660_000)).toBe('1h1m');
    expect(formatBadge(3_660_000).length).toBeLessThanOrEqual(4);
  });
});

describe('formatBytes', () => {
  it('scales units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
  });
});

describe('recordingName', () => {
  it('is filesystem safe and sortable', () => {
    const name = recordingName(new Date(2026, 8, 5, 14, 3, 22));
    expect(name).toBe('snippet-2026-09-05_14-03-22');
    expect(name).toMatch(/^[a-z0-9_-]+$/);
  });
});

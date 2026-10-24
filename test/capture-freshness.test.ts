import { describe, expect, test } from 'bun:test';
import {
  CAPTURE_COUNT_KEYS,
  captureFreshness,
  captureFreshnessCounts,
  captureFreshnessFromCounts,
  captureStaleThresholdSeconds,
  DEFAULT_CAPTURE_STALE_THRESHOLD_SECONDS,
} from '../src/workers/connector-store/capture-freshness.ts';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');

describe('captureFreshness', () => {
  test('the threshold itself is still fresh; one second past it is stale', () => {
    expect(captureFreshness('2026-10-24T11:00:00.000Z', NOW, 3_600)).toEqual({ status: 'fresh', threshold_seconds: 3_600, age_seconds: 3_600 });
    expect(captureFreshness('2026-10-24T10:59:59.000Z', NOW, 3_600)).toEqual({ status: 'stale', threshold_seconds: 3_600, age_seconds: 3_601 });
  });

  test('a time in the future is age zero, not a negative age', () => {
    expect(captureFreshness('2026-10-24T12:05:00.000Z', NOW, 60)).toEqual({ status: 'fresh', threshold_seconds: 60, age_seconds: 0 });
  });

  test('no time, or one that cannot be read, is unavailable and carries no age', () => {
    for (const newest of [undefined, '', 'yesterday']) {
      expect(captureFreshness(newest, NOW, 60)).toEqual({ status: 'unavailable', threshold_seconds: 60 });
    }
    expect(captureFreshness('2026-10-24T11:00:00.000Z', Number.NaN, 60)).toEqual({ status: 'unavailable', threshold_seconds: 60 });
  });
});

describe('capture freshness counts', () => {
  test('every verdict survives the counts the scheduler stores', () => {
    for (const verdict of [
      captureFreshness('2026-10-24T11:59:00.000Z', NOW, 600),
      captureFreshness('2026-10-20T11:59:00.000Z', NOW, 600),
      captureFreshness(undefined, NOW, 600),
    ]) {
      expect(captureFreshnessFromCounts(captureFreshnessCounts(verdict))).toEqual(verdict);
    }
  });

  test('the counts are whole non-negative numbers under the documented keys', () => {
    const counts = captureFreshnessCounts(captureFreshness('2026-10-20T12:00:00.000Z', NOW, 600));
    expect(Object.keys(counts).sort()).toEqual([
      CAPTURE_COUNT_KEYS.ageSeconds,
      CAPTURE_COUNT_KEYS.fresh,
      CAPTURE_COUNT_KEYS.stale,
      CAPTURE_COUNT_KEYS.thresholdSeconds,
      CAPTURE_COUNT_KEYS.unavailable,
    ].sort());
    for (const value of Object.values(counts)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
  });

  test('counts that carry no verdict, or an ambiguous one, read as none rather than a guess', () => {
    expect(captureFreshnessFromCounts({ items_seen: 4 })).toBeUndefined();
    // Two flags at once.
    expect(captureFreshnessFromCounts({ capture_fresh: 1, capture_stale: 1, capture_unavailable: 0, capture_stale_threshold_seconds: 60 })).toBeUndefined();
    // No flag.
    expect(captureFreshnessFromCounts({ capture_fresh: 0, capture_stale: 0, capture_unavailable: 0, capture_stale_threshold_seconds: 60 })).toBeUndefined();
    // No usable threshold.
    expect(captureFreshnessFromCounts({ capture_stale: 1, capture_stale_threshold_seconds: 0 })).toBeUndefined();
    expect(captureFreshnessFromCounts({ capture_stale: 1 })).toBeUndefined();
  });

  test('an unavailable verdict never carries an age, even if one is stored', () => {
    expect(captureFreshnessFromCounts({ capture_unavailable: 1, capture_stale_threshold_seconds: 60, capture_age_seconds: 5 }))
      .toEqual({ status: 'unavailable', threshold_seconds: 60 });
  });
});

describe('captureStaleThresholdSeconds', () => {
  test('an explicit option wins over the environment, and the environment over the default', () => {
    expect(captureStaleThresholdSeconds(90, '120', 'X')).toBe(90);
    expect(captureStaleThresholdSeconds(undefined, '120', 'X')).toBe(120);
    expect(captureStaleThresholdSeconds(undefined, undefined, 'X')).toBe(DEFAULT_CAPTURE_STALE_THRESHOLD_SECONDS);
    expect(captureStaleThresholdSeconds(undefined, '   ', 'X')).toBe(DEFAULT_CAPTURE_STALE_THRESHOLD_SECONDS);
  });

  test('the default is eighteen hours', () => {
    expect(DEFAULT_CAPTURE_STALE_THRESHOLD_SECONDS).toBe(18 * 3_600);
  });

  test('anything but a positive whole number is refused with the source named', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => captureStaleThresholdSeconds(bad, undefined, 'Telegram')).toThrow('Telegram capture stale threshold must be a positive integer.');
    }
    expect(() => captureStaleThresholdSeconds(undefined, 'abc', 'WhatsApp')).toThrow('WhatsApp capture stale threshold must be a positive integer.');
  });
});

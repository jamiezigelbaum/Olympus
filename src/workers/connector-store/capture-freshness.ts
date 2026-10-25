// What the newest captured message says about a live messaging feed.
//
// A capture spool is appended to by a helper that holds a linked session. A
// pull of that spool into the store can succeed on schedule while the helper
// has captured nothing for days, so "synced a minute ago" says nothing about
// whether new messages are arriving. Each live chat source states that second
// fact in its pull receipt as the counts below; the dashboard reads them back
// from the scheduler's persisted result. One definition here keeps the two
// sources' verdicts and the dashboard's reading of them the same.

/** The silence, in seconds, after which a feed with a captured message reads stale (18 hours). */
export const DEFAULT_CAPTURE_STALE_THRESHOLD_SECONDS = 64_800;

export type CaptureFreshnessState = 'fresh' | 'stale' | 'unavailable';

export interface CaptureFreshness {
  status: CaptureFreshnessState;
  threshold_seconds: number;
  /** Absent when no captured message carries a readable time. */
  age_seconds?: number;
}

/** The receipt count keys that carry a verdict. The dashboard reads exactly these. */
export const CAPTURE_COUNT_KEYS = {
  fresh: 'capture_fresh',
  stale: 'capture_stale',
  unavailable: 'capture_unavailable',
  thresholdSeconds: 'capture_stale_threshold_seconds',
  ageSeconds: 'capture_age_seconds',
  quiet: 'capture_quiet',
} as const;

// A type alias, not an interface: scheduler counts are a Record<string, number>,
// which an interface does not satisfy.
export type CaptureFreshnessCounts = {
  capture_fresh: number;
  capture_stale: number;
  capture_unavailable: number;
  capture_stale_threshold_seconds: number;
  capture_age_seconds?: number;
  /** Present only for a feed whose helper reports that it is running (see captureLiveness). */
  capture_quiet?: number;
};

/**
 * A verdict that also knows whether the helper is running: `quiet` is a feed
 * whose helper says it is capturing while no message arrived within the
 * threshold, which is an account with nothing to say, not a stalled capture.
 */
export interface CaptureLiveness extends CaptureFreshness {
  quiet: boolean;
}

/**
 * The verdict for the newest captured message time. A missing or unreadable
 * time is "unavailable": nothing was captured yet, or nothing says when, so
 * the feed cannot be called fresh or stale.
 */
export function captureFreshness(
  newestTimestamp: string | undefined,
  nowMs: number,
  thresholdSeconds: number,
): CaptureFreshness {
  const newestMs = newestTimestamp ? Date.parse(newestTimestamp) : Number.NaN;
  if (!Number.isFinite(nowMs) || !Number.isFinite(newestMs)) {
    return { status: 'unavailable', threshold_seconds: thresholdSeconds };
  }
  const ageSeconds = Math.max(0, Math.floor((nowMs - newestMs) / 1_000));
  return {
    status: ageSeconds > thresholdSeconds ? 'stale' : 'fresh',
    threshold_seconds: thresholdSeconds,
    age_seconds: ageSeconds,
  };
}

/**
 * The verdict for a feed whose helper also writes a heartbeat (the last time
 * it knew it was capturing). The feed's age is the age of the newer of its
 * newest captured record and its heartbeat, so a quiet account whose helper
 * is running reads fresh, and a helper that stopped reads stale one threshold
 * after it stopped, whatever its last message said. Without a heartbeat this
 * is exactly captureFreshness of the newest record.
 */
export function captureLiveness(
  newestRecordAt: string | undefined,
  heartbeatAt: string | undefined,
  nowMs: number,
  thresholdSeconds: number,
): CaptureLiveness {
  const record = captureFreshness(newestRecordAt, nowMs, thresholdSeconds);
  const heartbeat = captureFreshness(heartbeatAt, nowMs, thresholdSeconds);
  const newer = heartbeat.age_seconds !== undefined
    && (record.age_seconds === undefined || heartbeat.age_seconds < record.age_seconds)
    ? heartbeat
    : record;
  return { ...newer, quiet: heartbeat.status === 'fresh' && record.status !== 'fresh' };
}

/** The verdict as scheduler counts: non-negative whole numbers, no timestamp. */
export function captureFreshnessCounts(capture: CaptureFreshness | CaptureLiveness): CaptureFreshnessCounts {
  return {
    capture_fresh: capture.status === 'fresh' ? 1 : 0,
    capture_stale: capture.status === 'stale' ? 1 : 0,
    capture_unavailable: capture.status === 'unavailable' ? 1 : 0,
    capture_stale_threshold_seconds: capture.threshold_seconds,
    ...(capture.age_seconds !== undefined ? { capture_age_seconds: capture.age_seconds } : {}),
    ...('quiet' in capture ? { capture_quiet: capture.quiet ? 1 : 0 } : {}),
  };
}

/**
 * The verdict back from a receipt's counts, or undefined when the counts carry
 * none (a source that reports no capture freshness, or a task that is not its
 * pull). Exactly one of the three flags must be set; anything else is no
 * verdict rather than a guess.
 */
export function captureFreshnessFromCounts(counts: Readonly<Record<string, number>>): CaptureFreshness | undefined {
  const flagged = (['fresh', 'stale', 'unavailable'] as const)
    .filter((status) => counts[CAPTURE_COUNT_KEYS[status]] === 1);
  const threshold = counts[CAPTURE_COUNT_KEYS.thresholdSeconds];
  if (flagged.length !== 1 || typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold <= 0) {
    return undefined;
  }
  const age = counts[CAPTURE_COUNT_KEYS.ageSeconds];
  const status = flagged[0]!;
  return {
    status,
    threshold_seconds: threshold,
    ...(status !== 'unavailable' && typeof age === 'number' && Number.isSafeInteger(age) && age >= 0
      ? { age_seconds: age }
      : {}),
  };
}

/**
 * The stale threshold in seconds from an explicit option, else an environment
 * value, else the default. A positive whole number is required: a feed's
 * freshness cannot be judged against anything else.
 */
export function captureStaleThresholdSeconds(
  configured: number | undefined,
  environmentValue: string | undefined,
  label: string,
): number {
  const raw = configured ?? (
    environmentValue?.trim() ? Number(environmentValue) : DEFAULT_CAPTURE_STALE_THRESHOLD_SECONDS
  );
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error(`${label} capture stale threshold must be a positive integer.`);
  }
  return raw;
}

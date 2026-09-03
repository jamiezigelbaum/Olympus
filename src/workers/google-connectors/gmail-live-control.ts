// Cadence and bound policy for the dark Gmail connector-store lane. Only the
// two store tasks read this config; the bounds are host policy so they can be
// tightened without a code change.

export const GMAIL_STORE_PULL_INTERVAL_MS = 30 * 60_000;
export const GMAIL_STORE_PULL_FRESHNESS_THRESHOLD_MS = 2 * 60 * 60_000;
export const GMAIL_STORE_PULL_MAX_ITEMS = 200;
export const GMAIL_STORE_RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;
export const GMAIL_STORE_RECONCILE_FRESHNESS_THRESHOLD_MS = 26 * 60 * 60_000;

export const GMAIL_DAILY_REQUEST_GUARD_REASON = 'gmail_daily_api_request_guard';

export interface GmailLiveSyncConfig {
  storePullIntervalMs: number;
  storePullFreshnessThresholdMs: number;
  /** Hard per-run item bound; a bounded slice can never reconcile absence. */
  storePullMaxItems: number;
  storeReconcileIntervalMs: number;
  storeReconcileFreshnessThresholdMs: number;
}

export function defaultGmailLiveSyncConfig(
  env: Record<string, string | undefined> = process.env,
): GmailLiveSyncConfig {
  return {
    storePullIntervalMs: positiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_GMAIL_STORE_PULL_INTERVAL_SECONDS,
      GMAIL_STORE_PULL_INTERVAL_MS / 1_000,
    ) * 1_000,
    storePullFreshnessThresholdMs: positiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_GMAIL_STORE_PULL_STALE_SECONDS,
      GMAIL_STORE_PULL_FRESHNESS_THRESHOLD_MS / 1_000,
    ) * 1_000,
    storePullMaxItems: boundedPositiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_GMAIL_STORE_PULL_MAX_ITEMS,
      GMAIL_STORE_PULL_MAX_ITEMS,
      1,
      10_000,
    ),
    storeReconcileIntervalMs: positiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_GMAIL_STORE_RECONCILE_INTERVAL_SECONDS,
      GMAIL_STORE_RECONCILE_INTERVAL_MS / 1_000,
    ) * 1_000,
    storeReconcileFreshnessThresholdMs: positiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_GMAIL_STORE_RECONCILE_STALE_SECONDS,
      GMAIL_STORE_RECONCILE_FRESHNESS_THRESHOLD_MS / 1_000,
    ) * 1_000,
  };
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError('Gmail live sync configuration must be a positive integer.');
  }
  return parsed;
}

function boundedPositiveIntegerEnv(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = positiveIntegerEnv(value, fallback);
  if (parsed < minimum || parsed > maximum) {
    throw new TypeError(
      `Gmail live sync configuration must be between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

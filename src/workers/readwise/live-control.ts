// Cadence and bound policy for the canonical Readwise connector-store lane.
// Both provider tasks use the shared worker scheduler and read this config.

export const READWISE_STORE_PULL_INTERVAL_MS = 15 * 60_000;
export const READWISE_STORE_PULL_FRESHNESS_THRESHOLD_MS = 60 * 60_000;
export const READWISE_STORE_PULL_MAX_ITEMS = 200;
export const READWISE_STORE_RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;
export const READWISE_STORE_RECONCILE_FRESHNESS_THRESHOLD_MS = 26 * 60 * 60_000;

export const READWISE_DAILY_REQUEST_GUARD_REASON = 'readwise_daily_api_request_guard';

export interface ReadwiseLiveSyncConfig {
  storePullIntervalMs: number;
  storePullFreshnessThresholdMs: number;
  /** Hard per-run item bound; a bounded slice can never reconcile absence. */
  storePullMaxItems: number;
  storeReconcileIntervalMs: number;
  storeReconcileFreshnessThresholdMs: number;
}

export function defaultReadwiseLiveSyncConfig(
  env: Record<string, string | undefined> = process.env,
): ReadwiseLiveSyncConfig {
  return {
    storePullIntervalMs: positiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_READWISE_STORE_PULL_INTERVAL_SECONDS,
      READWISE_STORE_PULL_INTERVAL_MS / 1_000,
    ) * 1_000,
    storePullFreshnessThresholdMs: positiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_READWISE_STORE_PULL_STALE_SECONDS,
      READWISE_STORE_PULL_FRESHNESS_THRESHOLD_MS / 1_000,
    ) * 1_000,
    storePullMaxItems: boundedPositiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_READWISE_STORE_PULL_MAX_ITEMS,
      READWISE_STORE_PULL_MAX_ITEMS,
      1,
      10_000,
    ),
    storeReconcileIntervalMs: positiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_READWISE_STORE_RECONCILE_INTERVAL_SECONDS,
      READWISE_STORE_RECONCILE_INTERVAL_MS / 1_000,
    ) * 1_000,
    storeReconcileFreshnessThresholdMs: positiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_READWISE_STORE_RECONCILE_STALE_SECONDS,
      READWISE_STORE_RECONCILE_FRESHNESS_THRESHOLD_MS / 1_000,
    ) * 1_000,
  };
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError('Readwise live sync configuration must be a positive integer.');
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
      `Readwise live sync configuration must be between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

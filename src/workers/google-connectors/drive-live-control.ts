// Cadence and bound policy for the dark Google Drive connector-store lane.
// Only the two store tasks read this config; the bounds are host policy so they
// can be tightened without a code change.

export const GOOGLE_DRIVE_STORE_PULL_INTERVAL_MS = 30 * 60_000;
export const GOOGLE_DRIVE_STORE_PULL_FRESHNESS_THRESHOLD_MS = 2 * 60 * 60_000;
export const GOOGLE_DRIVE_STORE_PULL_MAX_ITEMS = 200;
export const GOOGLE_DRIVE_STORE_RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;
export const GOOGLE_DRIVE_STORE_RECONCILE_FRESHNESS_THRESHOLD_MS = 26 * 60 * 60_000;

export const GOOGLE_DRIVE_DAILY_REQUEST_GUARD_REASON = 'google_drive_daily_api_request_guard';

export interface GoogleDriveLiveSyncConfig {
  storePullIntervalMs: number;
  storePullFreshnessThresholdMs: number;
  /** Hard per-run item bound; a bounded slice can never reconcile absence. */
  storePullMaxItems: number;
  storeReconcileIntervalMs: number;
  storeReconcileFreshnessThresholdMs: number;
}

export function defaultGoogleDriveLiveSyncConfig(
  env: Record<string, string | undefined> = process.env,
): GoogleDriveLiveSyncConfig {
  return {
    storePullIntervalMs: positiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_STORE_PULL_INTERVAL_SECONDS,
      GOOGLE_DRIVE_STORE_PULL_INTERVAL_MS / 1_000,
    ) * 1_000,
    storePullFreshnessThresholdMs: positiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_STORE_PULL_STALE_SECONDS,
      GOOGLE_DRIVE_STORE_PULL_FRESHNESS_THRESHOLD_MS / 1_000,
    ) * 1_000,
    storePullMaxItems: boundedPositiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_STORE_PULL_MAX_ITEMS,
      GOOGLE_DRIVE_STORE_PULL_MAX_ITEMS,
      1,
      10_000,
    ),
    storeReconcileIntervalMs: positiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_STORE_RECONCILE_INTERVAL_SECONDS,
      GOOGLE_DRIVE_STORE_RECONCILE_INTERVAL_MS / 1_000,
    ) * 1_000,
    storeReconcileFreshnessThresholdMs: positiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_STORE_RECONCILE_STALE_SECONDS,
      GOOGLE_DRIVE_STORE_RECONCILE_FRESHNESS_THRESHOLD_MS / 1_000,
    ) * 1_000,
  };
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError('Google Drive live sync configuration must be a positive integer.');
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
      `Google Drive live sync configuration must be between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

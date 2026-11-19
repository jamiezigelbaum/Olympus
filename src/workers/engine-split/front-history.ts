/**
 * The background owns source-dashboard.sqlite. The front reads its history on
 * the pool and hands count samples to the background to record.
 */
import { assertWritableStoreOpenAllowed } from '../../core/store-write-guard.ts';
import { createDashboardHeldRead } from '../dashboard/held-read.ts';
import {
  defaultSourceDashboardHistoryDbPath, readDashboardHistoryOnPool, SqliteSourceDashboardHistory,
  type FrontSourceDashboardHistory, type SourceDashboardHistoryReader, type SourceDashboardHistorySample,
} from '../source-dashboard.ts';
import type { EngineCommandClient } from './client.ts';

/** The worker's writable dashboard history: refused in the engine split's front, which never records. */
export function openWritableDashboardHistory(path = defaultSourceDashboardHistoryDbPath()): SqliteSourceDashboardHistory {
  assertWritableStoreOpenAllowed('dashboard history', path);
  return new SqliteSourceDashboardHistory(path);
}

export function createFrontDashboardHistory(input: {
  path: string;
  client: Pick<EngineCommandClient, 'post'>;
  minIntervalMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}): FrontSourceDashboardHistory {
  const now = input.now ?? Date.now;
  const log = input.log ?? ((line: string) => console.warn(line));
  const minIntervalMs = input.minIntervalMs ?? 30_000;
  let lastSent = Number.NEGATIVE_INFINITY;
  let lastReadWarning = Number.NEGATIVE_INFINITY;
  const history = createDashboardHeldRead<SourceDashboardHistoryReader>(5_000, (error) => {
    const at = now();
    if (at - lastReadWarning < minIntervalMs) return;
    lastReadWarning = at;
    const code = (error as { code?: unknown } | undefined)?.code;
    log(`[engine-split] dashboard history unavailable: sqlite_code=${typeof code === 'string' && /^[A-Z_0-9]+$/.test(code) ? code : 'unknown'}`);
  }, now);
  return {
    record(samples: SourceDashboardHistorySample[]) {
      if (samples.length === 0 || now() - lastSent < minIntervalMs) return;
      lastSent = now();
      void input.client.post({ kind: 'dashboard_samples', samples: samples as unknown as Record<string, unknown>[] }).catch(() => undefined);
    },
    readForDashboard: (samples, at) => history(() => readDashboardHistoryOnPool(input.path, samples, at)),
  };
}

/**
 * The dashboard's progress history as the engine split's front sees it. The
 * background owns `source-dashboard.sqlite`; the front reads progress from a
 * read-only open and hands each render's count samples to the background
 * (`dashboard_samples`), which records them. No sample text exists: a
 * sample is ids, a time and counts.
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import { assertWritableStoreOpenAllowed } from '../../core/store-write-guard.ts';
import { defaultSourceDashboardHistoryDbPath, SqliteSourceDashboardHistory, type SourceDashboardHistory, type SourceDashboardHistorySample } from '../source-dashboard.ts';

/** The worker's writable dashboard history: refused in the engine split's front, which never records. */
export function openWritableDashboardHistory(path = defaultSourceDashboardHistoryDbPath()): SqliteSourceDashboardHistory {
  assertWritableStoreOpenAllowed('dashboard history', path);
  return new SqliteSourceDashboardHistory(path);
}

/**
 * The dashboard history's own reads (`progressFor`, `movementFor`,
 * `sampleCount`, which only query) on a read-only, query-only connection.
 * The history class opens its file writable, and the dashboard's guarded
 * files stay as reviewed (config/dashboard-design-review.json), so the
 * reader borrows the class's methods over this connection instead.
 */
export function openReadOnlyDashboardHistory(path: string): Pick<SqliteSourceDashboardHistory, 'progressFor' | 'movementFor' | 'sampleCount' | 'close'> {
  const db = new Database(path, { readonly: true, create: false });
  try {
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON;');
  } catch (error) {
    closeSqliteStore(db, { checkpoint: false });
    throw error;
  }
  const methods = SqliteSourceDashboardHistory.prototype;
  const self = { db } as unknown as SqliteSourceDashboardHistory;
  return {
    progressFor: (sample, now) => methods.progressFor.call(self, sample, now),
    movementFor: (sample, now) => methods.movementFor.call(self, sample, now),
    sampleCount: () => methods.sampleCount.call(self),
    close: () => closeSqliteStore(db, { checkpoint: false }),
  };
}
import type { EngineCommandClient } from './client.ts';

export function createFrontDashboardHistory(input: {
  path: string;
  client: Pick<EngineCommandClient, 'post'>;
  /** Samples are sent at most this often; the background records one batch per interval. */
  minIntervalMs?: number;
  now?: () => number;
}): SourceDashboardHistory {
  const now = input.now ?? (() => Date.now());
  const minIntervalMs = input.minIntervalMs ?? 30_000;
  let reader: ReturnType<typeof openReadOnlyDashboardHistory> | undefined;
  let lastSent = Number.NEGATIVE_INFINITY;
  const read = (): ReturnType<typeof openReadOnlyDashboardHistory> | undefined => {
    if (!reader && existsSync(input.path)) {
      try { reader = openReadOnlyDashboardHistory(input.path); }
      catch { reader = undefined; }
    }
    return reader;
  };
  return {
    record(samples: SourceDashboardHistorySample[]) {
      if (samples.length === 0 || now() - lastSent < minIntervalMs) return;
      lastSent = now();
      void input.client.post({ kind: 'dashboard_samples', samples: samples as unknown as Record<string, unknown>[] }).catch(() => undefined);
    },
    progressFor: (sample, at) => read()?.progressFor(sample, at),
    movementFor: (sample, at) => read()?.movementFor(sample, at),
    sampleCount: () => read()?.sampleCount() ?? 0,
  };
}

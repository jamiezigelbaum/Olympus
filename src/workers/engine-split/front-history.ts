/**
 * The dashboard's progress history as the engine split's front sees it. The
 * background owns `source-dashboard.sqlite`; the front reads progress from a
 * read-only open and hands each render's count samples to the background
 * (`dashboard_samples`), which records them. No sample text exists: a
 * sample is ids, a time and counts.
 */
import { SQLiteError } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import { assertWritableStoreOpenAllowed } from '../../core/store-write-guard.ts';
import { openSourceDashboardFileReadOnly } from '../source-ingestion-ledger.ts';
import { defaultSourceDashboardHistoryDbPath, SqliteSourceDashboardHistory, type SourceDashboardHistory, type SourceDashboardHistorySample } from '../source-dashboard.ts';
import type { EngineCommandClient } from './client.ts';

/** The worker's writable dashboard history: refused in the engine split's front, which never records. */
export function openWritableDashboardHistory(path = defaultSourceDashboardHistoryDbPath()): SqliteSourceDashboardHistory {
  assertWritableStoreOpenAllowed('dashboard history', path);
  return new SqliteSourceDashboardHistory(path);
}

/**
 * The dashboard history's own reads (`progressFor`, `movementFor`,
 * `sampleCount`, which only query) on a read-only, query-only connection.
 * Share the history class's read methods without running its writable constructor.
 */
export function openReadOnlyDashboardHistory(path: string): Pick<SqliteSourceDashboardHistory, 'progressFor' | 'movementFor' | 'sampleCount' | 'close'> {
  const db = openSourceDashboardFileReadOnly(path);
  const methods = SqliteSourceDashboardHistory.prototype;
  const self = { db } as unknown as SqliteSourceDashboardHistory;
  return {
    progressFor: (sample, now) => methods.progressFor.call(self, sample, now),
    movementFor: (sample, now) => methods.movementFor.call(self, sample, now),
    sampleCount: () => methods.sampleCount.call(self),
    close: () => closeSqliteStore(db, { checkpoint: false }),
  };
}

export function createFrontDashboardHistory(input: {
  path: string;
  client: Pick<EngineCommandClient, 'post'>;
  /** Minimum interval between sample batches and between history read warnings. */
  minIntervalMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}): SourceDashboardHistory {
  const now = input.now ?? (() => Date.now());
  const log = input.log ?? ((line: string) => console.warn(line));
  const minIntervalMs = input.minIntervalMs ?? 30_000;
  let reader: ReturnType<typeof openReadOnlyDashboardHistory> | undefined;
  let lastSent = Number.NEGATIVE_INFINITY;
  let lastReadWarning = Number.NEGATIVE_INFINITY;
  const read = <T>(query: (history: NonNullable<typeof reader>) => T): T | undefined => {
    try {
      if (!reader && existsSync(input.path)) reader = openReadOnlyDashboardHistory(input.path);
      return reader && query(reader);
    } catch (error) {
      if (!(error instanceof SQLiteError)) throw error;
      const at = now();
      if (at - lastReadWarning >= minIntervalMs) {
        lastReadWarning = at;
        log(`[engine-split] dashboard history unavailable: sqlite_code=${error.code ?? error.errno}`);
      }
      return undefined;
    }
  };
  return {
    record(samples: SourceDashboardHistorySample[]) {
      if (samples.length === 0 || now() - lastSent < minIntervalMs) return;
      lastSent = now();
      void input.client.post({ kind: 'dashboard_samples', samples: samples as unknown as Record<string, unknown>[] }).catch(() => undefined);
    },
    readForDashboard: read,
    progressFor: (sample, at) => read((history) => history.progressFor(sample, at)),
    movementFor: (sample, at) => read((history) => history.movementFor(sample, at)),
    sampleCount: () => read((history) => history.sampleCount()) ?? 0,
  };
}

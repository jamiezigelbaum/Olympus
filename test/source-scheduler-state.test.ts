import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  LocalSourceSchedulerStateStore,
  SOURCE_CHECKPOINT_MAX_LENGTH,
  SOURCE_SCHEDULER_STATE_STORE_ID,
  defaultSourceSchedulerStateDbPath,
  type SourceSchedulerTaskStateKey,
} from '../src/workers/source-scheduler-state.ts';

const KEY: SourceSchedulerTaskStateKey = {
  sourceId: 'x.bookmarks',
  corpusId: 'secure_local.x.bookmarks',
  taskId: 'x.bookmarks_head',
};

describe('source scheduler state store', () => {
  test('uses the Olympus data root and creates a private database', () => {
    expect(defaultSourceSchedulerStateDbPath({ XDG_DATA_HOME: '/private/olympus-data' }))
      .toBe('/private/olympus-data/openclaw/olympus/source-scheduler.sqlite');

    withFixture((path) => {
      const store = new LocalSourceSchedulerStateStore(path);
      try {
        expect(store.get(KEY)).toBeUndefined();
        expect(store.list()).toEqual([]);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      } finally {
        store.close();
      }
    });
  });

  test('atomically upserts attempts without disturbing prior result state', () => {
    withFixture((path) => {
      const store = new LocalSourceSchedulerStateStore(path);
      try {
        expect(store.recordAttempt({
          ...KEY,
          attemptedAt: '2026-07-18T12:00:00.000Z',
        })).toEqual({
          ...KEY,
          stateVersion: 1,
          attemptPending: true,
          lastAttemptAt: '2026-07-18T12:00:00.000Z',
          consecutiveFailures: 0,
          updatedAt: '2026-07-18T12:00:00.000Z',
        });

        store.recordSuccess({
          ...KEY,
          completedAt: '2026-07-18T12:00:01.000Z',
          resultStatus: 'idle',
          checkpoint: 'bookmark-100',
        });
        const state = store.recordAttempt({
          ...KEY,
          attemptedAt: '2026-07-18T12:00:30.000Z',
        });

        expect(state).toMatchObject({
          attemptPending: true,
          checkpoint: 'bookmark-100',
          lastAttemptAt: '2026-07-18T12:00:30.000Z',
          lastSuccessAt: '2026-07-18T12:00:01.000Z',
          lastResultStatus: 'idle',
        });
      } finally {
        store.close();
      }
    });
  });

  test('round-trips safe result data and implements checkpoint set, preserve, and clear', () => {
    withFixture((path) => {
      const store = new LocalSourceSchedulerStateStore(path);
      try {
        const first = store.recordSuccess({
          ...KEY,
          completedAt: '2026-07-18T12:00:02.000Z',
          resultStatus: 'progress',
          counts: { items_indexed: 2, items_seen: 3 },
          warnings: ['rate_limited', 'rate_limited'],
          checkpoint: 'bookmark-101',
          notBeforeAt: '2026-07-18T12:01:00.000Z',
          effectiveIntervalMs: 60_000,
          degradedReason: 'rate_limit_guard',
        });
        expect(first).toMatchObject({
          checkpoint: 'bookmark-101',
          lastCompletedAt: '2026-07-18T12:00:02.000Z',
          lastSuccessAt: '2026-07-18T12:00:02.000Z',
          consecutiveFailures: 0,
          lastResultStatus: 'progress',
          lastCounts: { items_indexed: 2, items_seen: 3 },
          lastWarnings: ['rate_limited'],
          notBeforeAt: '2026-07-18T12:01:00.000Z',
          effectiveIntervalMs: 60_000,
          degradedReason: 'rate_limit_guard',
        });

        const preserved = store.recordSuccess({
          ...KEY,
          completedAt: '2026-07-18T12:02:00.000Z',
          resultStatus: 'idle',
        });
        expect(preserved.checkpoint).toBe('bookmark-101');
        expect(preserved.notBeforeAt).toBeUndefined();
        expect(preserved.effectiveIntervalMs).toBeUndefined();
        expect(preserved.degradedReason).toBeUndefined();
        expect(preserved.lastCounts).toBeUndefined();
        expect(preserved.lastWarnings).toBeUndefined();

        const cleared = store.recordSuccess({
          ...KEY,
          completedAt: '2026-07-18T12:03:00.000Z',
          resultStatus: 'idle',
          checkpoint: null,
        });
        expect(cleared.checkpoint).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  test('shares the connector cursor bound and rejects empty or over-bound checkpoints', () => {
    withFixture((path) => {
      const store = new LocalSourceSchedulerStateStore(path);
      try {
        const aboveLegacyBound = 'c'.repeat(4_097);
        expect(store.recordSuccess({
          ...KEY,
          completedAt: '2026-08-27T22:33:53.000Z',
          resultStatus: 'progress',
          checkpoint: aboveLegacyBound,
        }).checkpoint).toBe(aboveLegacyBound);

        const atSharedBound = 'm'.repeat(SOURCE_CHECKPOINT_MAX_LENGTH);
        expect(store.recordSuccess({
          ...KEY,
          completedAt: '2026-08-27T22:33:54.000Z',
          resultStatus: 'progress',
          checkpoint: atSharedBound,
        }).checkpoint).toBe(atSharedBound);

        expect(() => store.recordSuccess({
          ...KEY,
          completedAt: '2026-08-27T22:33:55.000Z',
          resultStatus: 'progress',
          checkpoint: 'x'.repeat(SOURCE_CHECKPOINT_MAX_LENGTH + 1),
        })).toThrow(/bounded non-empty string/);
        expect(() => store.recordSuccess({
          ...KEY,
          completedAt: '2026-08-27T22:33:56.000Z',
          resultStatus: 'progress',
          checkpoint: '',
        })).toThrow(/bounded non-empty string/);
        expect(() => store.recordSuccess({
          ...KEY,
          completedAt: '2026-08-27T22:33:57.000Z',
          resultStatus: 'progress',
          checkpoint: 42,
        } as unknown as Parameters<typeof store.recordSuccess>[0])).toThrow(/bounded non-empty string/);
      } finally {
        store.close();
      }
    });
  });

  test('increments failures across restart while preserving success and checkpoint', () => {
    withFixture((path) => {
      let store = new LocalSourceSchedulerStateStore(path);
      store.recordSuccess({
        ...KEY,
        completedAt: '2026-07-18T12:00:00.000Z',
        resultStatus: 'progress',
        checkpoint: 'bookmark-102',
        effectiveIntervalMs: 45_000,
        degradedReason: 'cost_guard',
      });
      store.recordAttempt({ ...KEY, attemptedAt: '2026-07-18T12:00:30.000Z' });
      store.recordFailure({
        ...KEY,
        completedAt: '2026-07-18T12:00:31.000Z',
        notBeforeAt: '2026-07-18T12:01:31.000Z',
        errorKind: 'rate_limited',
        errorHash: '0123456789abcdef',
        warnings: ['rate_limited'],
      });
      store.close();

      store = new LocalSourceSchedulerStateStore(path);
      try {
        const failed = store.recordFailure({
          ...KEY,
          completedAt: '2026-07-18T12:01:32.000Z',
          notBeforeAt: '2026-07-18T12:03:32.000Z',
          errorKind: 'network',
          errorHash: 'fedcba9876543210',
          effectiveIntervalMs: 120_000,
          degradedReason: 'provider_backoff',
        });
        expect(failed).toMatchObject({
          checkpoint: 'bookmark-102',
          lastAttemptAt: '2026-07-18T12:00:30.000Z',
          lastSuccessAt: '2026-07-18T12:00:00.000Z',
          lastCompletedAt: '2026-07-18T12:01:32.000Z',
          notBeforeAt: '2026-07-18T12:03:32.000Z',
          consecutiveFailures: 2,
          lastErrorKind: 'network',
          lastErrorHash: 'fedcba9876543210',
          lastResultStatus: 'failed',
          effectiveIntervalMs: 120_000,
          degradedReason: 'provider_backoff',
        });
      } finally {
        store.close();
      }
    });
  });

  // Every deploy after a guarded run took the degrade path on a marker the
  // recovered task had already outlived (live 2026-07-27,
  // `advisory_degraded_reason`). A success with no degradation of its own must
  // clear the marker outright — the scheduler's status is what the health
  // monitor and the X activation gate read, and a marker that survives a
  // healthy run is a false alarm on every subsequent deploy.
  test('a healthy success clears a stale degradation marker, and only its own carries', () => {
    withFixture((path) => {
      const store = new LocalSourceSchedulerStateStore(path);
      try {
        store.recordFailure({
          ...KEY,
          completedAt: '2026-07-27T00:00:00.000Z',
          notBeforeAt: '2026-07-27T01:00:00.000Z',
          errorKind: 'api_request_guard',
          errorHash: '0123456789abcdef',
          degradedReason: 'daily_api_request_guard',
        });
        expect(store.get(KEY)?.degradedReason).toBe('daily_api_request_guard');

        const recovered = store.recordSuccess({
          ...KEY,
          completedAt: '2026-07-27T02:00:00.000Z',
          resultStatus: 'progress',
        });
        expect(recovered.degradedReason).toBeUndefined();
        expect(recovered.lastErrorKind).toBeUndefined();
        expect(recovered.consecutiveFailures).toBe(0);
        expect(store.get(KEY)?.degradedReason).toBeUndefined();

        // A success that is itself degraded still says so, and the next clean
        // success clears that too.
        store.recordSuccess({
          ...KEY,
          completedAt: '2026-07-27T03:00:00.000Z',
          resultStatus: 'progress',
          degradedReason: 'daily_api_request_guard',
        });
        expect(store.get(KEY)?.degradedReason).toBe('daily_api_request_guard');
        store.recordSuccess({
          ...KEY,
          completedAt: '2026-07-27T04:00:00.000Z',
          resultStatus: 'idle',
        });
        expect(store.get(KEY)?.degradedReason).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  // 2026-07-26 incident: adopting a newer external success erased
  // last_attempt_at, so a task the scheduler had genuinely tried (and that a
  // budget guard refused) read as "no attempt recorded".
  test('adoption keeps attempt history while resetting every failure marker', () => {
    withFixture((path) => {
      const store = new LocalSourceSchedulerStateStore(path);
      try {
        store.recordAttempt({ ...KEY, attemptedAt: '2026-07-18T12:00:00.000Z' });
        store.recordFailure({
          ...KEY,
          completedAt: '2026-07-18T12:00:01.000Z',
          notBeforeAt: '2026-07-19T00:00:00.000Z',
          errorKind: 'task_failed',
          errorHash: '0123456789abcdef',
          degradedReason: 'daily_api_request_guard',
        });

        const adopted = store.adoptExternalSuccess({
          ...KEY,
          completedAt: '2026-07-18T12:30:00.000Z',
          resultStatus: 'idle',
          counts: { items_seen: 3 },
        });
        expect(adopted).toMatchObject({
          attemptPending: false,
          lastAttemptAt: '2026-07-18T12:00:00.000Z',
          lastCompletedAt: '2026-07-18T12:30:00.000Z',
          lastSuccessAt: '2026-07-18T12:30:00.000Z',
          consecutiveFailures: 0,
          lastResultStatus: 'idle',
          lastCounts: { items_seen: 3 },
        });
        expect(adopted.lastErrorKind).toBeUndefined();
        expect(adopted.lastErrorHash).toBeUndefined();
        expect(adopted.notBeforeAt).toBeUndefined();
        expect(adopted.degradedReason).toBeUndefined();
        expect(adopted.effectiveIntervalMs).toBeUndefined();

        // The preserved attempt must not resurrect itself as newer activity:
        // an older/equal external clock is still refused, and a genuinely
        // newer one still adopts.
        const stale = store.adoptExternalSuccess({
          ...KEY,
          completedAt: '2026-07-18T12:29:00.000Z',
          resultStatus: 'idle',
        });
        expect(stale).toMatchObject({
          lastSuccessAt: '2026-07-18T12:30:00.000Z',
          lastAttemptAt: '2026-07-18T12:00:00.000Z',
        });
        const newer = store.adoptExternalSuccess({
          ...KEY,
          completedAt: '2026-07-18T12:31:00.000Z',
          resultStatus: 'progress',
        });
        expect(newer).toMatchObject({
          lastSuccessAt: '2026-07-18T12:31:00.000Z',
          lastAttemptAt: '2026-07-18T12:00:00.000Z',
        });
      } finally {
        store.close();
      }
    });
  });

  test('adoption never erases a pending attempt that is newer than the external clock', () => {
    withFixture((path) => {
      const store = new LocalSourceSchedulerStateStore(path);
      try {
        store.recordAttempt({ ...KEY, attemptedAt: '2026-07-18T12:05:00.000Z' });
        const refused = store.adoptExternalSuccess({
          ...KEY,
          completedAt: '2026-07-18T12:04:00.000Z',
          resultStatus: 'idle',
        });
        expect(refused).toMatchObject({
          attemptPending: true,
          lastAttemptAt: '2026-07-18T12:05:00.000Z',
        });
        expect(refused.lastSuccessAt).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  test('lists current-version rows in a stable key order', () => {
    withFixture((path) => {
      const store = new LocalSourceSchedulerStateStore(path);
      try {
        for (const key of [
          { sourceId: 'z.source', corpusId: 'a.corpus', taskId: 'task' },
          { sourceId: 'a.source', corpusId: 'z.corpus', taskId: 'task.2' },
          { sourceId: 'a.source', corpusId: 'a.corpus', taskId: 'task.1' },
        ]) {
          store.recordAttempt({ ...key, attemptedAt: '2026-07-18T12:00:00.000Z' });
        }
        expect(store.list().map((state) => `${state.sourceId}/${state.corpusId}/${state.taskId}`)).toEqual([
          'a.source/a.corpus/task.1',
          'a.source/z.corpus/task.2',
          'z.source/a.corpus/task',
        ]);
      } finally {
        store.close();
      }
    });
  });

  test('accepts only structured failure telemetry and never stores raw error input', () => {
    withFixture((path) => {
      const store = new LocalSourceSchedulerStateStore(path);
      try {
        const rawError = 'private provider error at /secret/path';
        const state = store.recordFailure({
          ...KEY,
          completedAt: '2026-07-18T12:00:01.000Z',
          notBeforeAt: '2026-07-18T12:01:01.000Z',
          errorKind: 'temporary',
          errorHash: '0123456789abcdef',
          errorMessage: rawError,
        } as Parameters<typeof store.recordFailure>[0] & { errorMessage: string });

        expect(JSON.stringify(state)).not.toContain(rawError);
        expect(() => store.recordFailure({
          ...KEY,
          completedAt: '2026-07-18T12:02:01.000Z',
          notBeforeAt: '2026-07-18T12:03:01.000Z',
          errorKind: rawError,
          errorHash: '0123456789abcdef',
        })).toThrow(/safe categorical token/);
        expect(() => store.recordFailure({
          ...KEY,
          completedAt: '2026-07-18T12:02:01.000Z',
          notBeforeAt: '2026-07-18T12:03:01.000Z',
          errorKind: 'temporary',
          errorHash: rawError,
        })).toThrow(/hexadecimal digest/);
        expect(() => store.recordSuccess({
          ...KEY,
          completedAt: '2026-07-18T12:02:01.000Z',
          resultStatus: 'idle',
          warnings: [rawError],
        })).toThrow(/safe categorical token/);

        const schema = querySchema(path);
        expect(schema).not.toContain('error_message');
        expect(schema).not.toContain('raw_error');
      } finally {
        store.close();
      }
    });
  });

  test('fails closed on corrupt result JSON and skips unknown row versions', () => {
    withFixture((path) => {
      let store = new LocalSourceSchedulerStateStore(path);
      store.recordSuccess({
        ...KEY,
        completedAt: '2026-07-18T12:00:00.000Z',
        resultStatus: 'progress',
        counts: { items_seen: 1 },
        warnings: ['rate_limited'],
      });
      store.close();

      const db = new Database(path);
      db.query(`
        UPDATE source_scheduler_task_state
        SET last_counts_json = ?, last_warnings_json = ?
        WHERE source_id = ? AND corpus_id = ? AND task_id = ?
      `).run('{not-json', '["rate_limited", "private warning text"]', KEY.sourceId, KEY.corpusId, KEY.taskId);
      db.close();

      store = new LocalSourceSchedulerStateStore(path);
      const corrupt = store.get(KEY);
      expect(corrupt).toMatchObject({ lastResultStatus: 'progress' });
      expect(corrupt?.lastCounts).toBeUndefined();
      expect(corrupt?.lastWarnings).toBeUndefined();
      store.close();

      const versionDb = new Database(path);
      versionDb.query(`
        UPDATE source_scheduler_task_state
        SET state_version = 2
        WHERE source_id = ? AND corpus_id = ? AND task_id = ?
      `).run(KEY.sourceId, KEY.corpusId, KEY.taskId);
      versionDb.close();

      store = new LocalSourceSchedulerStateStore(path);
      try {
        expect(store.get(KEY)).toBeUndefined();
        expect(store.list()).toEqual([]);
        expect(() => store.recordAttempt({
          ...KEY,
          attemptedAt: '2026-07-18T13:00:00.000Z',
        })).toThrow(/unsupported state_version/);
      } finally {
        store.close();
      }
    });
  });

  test('refuses a database schema newer than this build', () => {
    withFixture((path) => {
      const db = new Database(path, { create: true });
      db.exec(`
        CREATE TABLE schema_version (
          store_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      db.query('INSERT INTO schema_version (store_id, version, applied_at) VALUES (?, ?, ?)')
        .run(SOURCE_SCHEDULER_STATE_STORE_ID, 99, '2026-07-18T12:00:00.000Z');
      db.close();

      expect(() => new LocalSourceSchedulerStateStore(path)).toThrow(/schema_version 99/);
    });
  });

  test('migrates a v1 scheduler store to the guarded unpark control table', () => {
    withFixture((path) => {
      let store = new LocalSourceSchedulerStateStore(path);
      store.recordFailure({
        ...KEY,
        completedAt: '2026-07-29T09:00:00.000Z',
        notBeforeAt: '2026-07-30T00:00:00.000Z',
        errorKind: 'task_failed',
        errorHash: '0123456789abcdef',
      });
      store.close();

      const old = new Database(path);
      old.exec('DROP TABLE source_scheduler_unpark_request;');
      old.query('UPDATE schema_version SET version = 1 WHERE store_id = ?')
        .run(SOURCE_SCHEDULER_STATE_STORE_ID);
      old.close();

      store = new LocalSourceSchedulerStateStore(path);
      try {
        expect(store.get(KEY)?.notBeforeAt).toBe('2026-07-30T00:00:00.000Z');
        store.requestUnpark({
          sourceId: KEY.sourceId,
          taskId: KEY.taskId,
          expectedNotBeforeAt: '2026-07-30T00:00:00.000Z',
          reason: 'incident_probe',
          requestedAt: '2026-07-29T10:00:00.000Z',
        });
        expect(store.pendingUnparks()).toEqual([
          expect.objectContaining({ ...KEY, reason: 'incident_probe' }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  test('a stranded pending unpark can be cancelled and requested again', () => {
    withFixture((path) => {
      const store = new LocalSourceSchedulerStateStore(path);
      try {
        store.recordFailure({
          ...KEY,
          completedAt: '2026-07-29T09:00:00.000Z',
          notBeforeAt: '2026-07-30T00:00:00.000Z',
          errorKind: 'task_failed',
          errorHash: '0123456789abcdef',
        });
        store.requestUnpark({
          sourceId: KEY.sourceId,
          taskId: KEY.taskId,
          expectedNotBeforeAt: '2026-07-30T00:00:00.000Z',
          reason: 'manual_lane_probe',
          requestedAt: '2026-07-29T10:00:00.000Z',
        });
        expect(store.cancelUnpark({
          sourceId: KEY.sourceId,
          taskId: KEY.taskId,
          expectedNotBeforeAt: '2026-07-30T00:00:00.000Z',
          reason: 'lane_not_loaded',
          cancelledAt: '2026-07-29T10:01:00.000Z',
        })).toMatchObject({
          kind: 'source_scheduler_unpark_cancelled',
          source_id: KEY.sourceId,
          task_id: KEY.taskId,
          reason: 'lane_not_loaded',
        });
        expect(store.pendingUnparks()).toEqual([]);
        expect(() => store.requestUnpark({
          sourceId: KEY.sourceId,
          taskId: KEY.taskId,
          expectedNotBeforeAt: '2026-07-30T00:00:00.000Z',
          reason: 'manual_lane_probe',
          requestedAt: '2026-07-29T10:02:00.000Z',
        })).not.toThrow();
      } finally {
        store.close();
      }
    });
  });
});

function withFixture(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-source-scheduler-state-'));
  try {
    run(join(dir, 'scheduler.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function querySchema(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query("SELECT sql FROM sqlite_master WHERE type = 'table'").all() as Array<{ sql?: string }>;
    return rows.map((row) => row.sql ?? '').join('\n').toLowerCase();
  } finally {
    db.close();
  }
}

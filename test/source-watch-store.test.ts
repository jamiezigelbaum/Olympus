import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  createSourceWatchExecutorCapability,
  createTrustedSourceWatchOwnerContext,
  defaultSourceWatchDbPath,
  LocalSourceWatchStore,
  SOURCE_WATCH_MAX_LEASE_MS,
  SOURCE_WATCH_MAX_RETRY_MS,
  SOURCE_WATCH_MIN_LEASE_MS,
  SOURCE_WATCH_MIN_RETENTION_MS,
  SOURCE_WATCH_MIN_RETRY_MS,
  SOURCE_WATCH_STORE_ID,
  sourceWatchDeliveryKey,
  type CreateSourceWatchInput,
  type SourceWatchCanonicalRef,
  type SourceWatchClock,
  type SourceWatchExecutorCapability,
  type TrustedSourceWatchOwnerContext,
} from '../src/core/source-watch.ts';

const START = '2026-07-18T12:00:00.000Z';
const CORPUS = 'secure_local.whatsapp.messages';
const TASK_A = '019f6ff4-2fb0-70a3-91dd-3ef3ada9354f';
const TASK_B = '019f6ff3-229e-7112-ab5c-eadaa5782d81';

const OWNER_A = createTrustedSourceWatchOwnerContext({
  ownerId: 'owner-a',
  routeKind: 'openclaw_task',
  routeTargetId: TASK_A,
  routeAccountId: 'castor',
});
const OWNER_A_SECOND_ROUTE = createTrustedSourceWatchOwnerContext({
  ownerId: 'owner-a',
  routeKind: 'openclaw_task',
  routeTargetId: TASK_B,
});
const OWNER_B = createTrustedSourceWatchOwnerContext({
  ownerId: 'another-owner',
  routeKind: 'openclaw_channel',
  routeTargetId: 'telegram:123456789',
});
const EXECUTOR = createSourceWatchExecutorCapability({ executorId: 'watch-executor' });
const EXECUTOR_B = createSourceWatchExecutorCapability({ executorId: 'watch-executor-b' });

describe('durable source watch store', () => {
  test('requires an absolute data root and hardens the leaf directory and SQLite files', () => {
    expect(defaultSourceWatchDbPath({ XDG_DATA_HOME: '/private/olympus-data' }))
      .toBe('/private/olympus-data/openclaw/olympus/source-watches.sqlite');
    expect(() => defaultSourceWatchDbPath({ XDG_DATA_HOME: 'relative/data' })).toThrow(/absolute/);
    expect(() => new LocalSourceWatchStore('relative.sqlite')).toThrow(/absolute/);
    expect(() => new LocalSourceWatchStore(':memory:')).toThrow(/absolute/);
    expect(() => new LocalSourceWatchStore('/tmp/source-watches.sqlite')).toThrow(/dedicated private leaf/);

    withFixture((path) => {
      chmodSync(join(path, '..'), 0o755);
      const clock = new MutableClock(START);
      const store = new LocalSourceWatchStore(path, { clock });
      store.createWatch(watchInput('watch-private'), OWNER_A);
      expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${path}${suffix}`;
        if (existsSync(sidecar)) expect(statSync(sidecar).mode & 0o777).toBe(0o600);
      }

      const db = new Database(path, { readonly: true });
      try {
        const names = (db.query(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'source_watch%'
          ORDER BY name
        `).all() as Array<{ name: string }>).map((row) => row.name);
        expect(names).toEqual([
          'source_watch_matches',
          'source_watch_outbox',
          'source_watch_watermarks',
          'source_watches',
        ]);
        const schema = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table'").all() as Array<{ sql?: string }>)
          .map((row) => row.sql ?? '')
          .join('\n')
          .toLowerCase();
        expect(schema).not.toContain('provider_cursor');
        expect(schema).not.toContain('raw_body');
        expect(schema).not.toContain('source_body');
      } finally {
        db.close();
        store.close();
      }
    });

    withFixture((path) => {
      const target = join(path, '..', 'symlink-target.sqlite');
      writeFileSync(target, 'not-a-database', { mode: 0o600 });
      symlinkSync(target, path);
      expect(() => new LocalSourceWatchStore(path)).toThrow(/not a symlink/);
    });
  });

  test('uses closed canonical routes and distinct unforgeable owner/executor powers', () => {
    expect(() => createTrustedSourceWatchOwnerContext({
      ownerId: 'owner-a',
      routeKind: 'arbitrary' as 'openclaw_task',
      routeTargetId: TASK_A,
    })).toThrow(/routeKind/);
    expect(() => createTrustedSourceWatchOwnerContext({
      ownerId: 'owner-a',
      routeKind: 'openclaw_task',
      routeTargetId: `task:${TASK_A}`,
    })).toThrow(/canonical lowercase task UUID/);
    expect(() => createTrustedSourceWatchOwnerContext({
      ownerId: 'owner-a',
      routeKind: 'openclaw_channel',
      routeTargetId: 'unknown-provider:123',
    })).toThrow(/supported channel/);

    withFixture((path) => {
      const store = new LocalSourceWatchStore(path, { clock: new MutableClock(START) });
      try {
        const forgedOwner = {
          ownerId: 'owner-a',
          routeKind: 'openclaw_task',
          routeTargetId: TASK_A,
        } as TrustedSourceWatchOwnerContext;
        const forgedExecutor = {
          executorId: 'watch-executor',
        } as SourceWatchExecutorCapability;
        expect(() => store.createWatch(watchInput('watch-forged'), forgedOwner)).toThrow(/authentic context/);
        store.createWatch(watchInput('watch-capability'), OWNER_A);
        expect(() => store.recordMatch(forgedExecutor, {
          watchId: 'watch-capability', ref: itemRef('message-1', 'v1'),
        })).toThrow(/authentic capability/);
        expect(() => store.createWatch({
          ...watchInput('watch-route-injection'),
          routeTargetId: TASK_B,
        } as CreateSourceWatchInput & { routeTargetId: string }, OWNER_A)).toThrow(/cannot accept field/);
        expect(() => store.recordMatch(EXECUTOR, {
          watchId: 'watch-capability',
          ref: {
            ...itemRef('message-1', 'v1'),
            rawBody: 'SECURE-LOCAL-BODY',
          } as SourceWatchCanonicalRef & { rawBody: string },
        })).toThrow(/canonical ref cannot accept field/);
      } finally {
        store.close();
      }
    });
  });

  test('uses its injected clock as authority and rejects caller-authored transition times', () => {
    withFixture((path) => {
      const clock = new MutableClock(START);
      const store = new LocalSourceWatchStore(path, { clock });
      try {
        expect(() => store.createWatch({
          ...watchInput('watch-spoofed-time'),
          createdAt: '2030-01-01T00:00:00.000Z',
        } as CreateSourceWatchInput & { createdAt: string }, OWNER_A)).toThrow(/cannot accept field/);
        const created = store.createWatch(watchInput('watch-clock'), OWNER_A);
        expect(created.createdAt).toBe(START);

        clock.set('2026-07-18T12:01:00.000Z');
        expect(() => store.recordMatch(EXECUTOR, {
          watchId: 'watch-clock',
          ref: itemRef('message-spoof', 'v1'),
          matchedAt: '2030-01-01T00:00:00.000Z',
        } as Parameters<typeof store.recordMatch>[1] & { matchedAt: string })).toThrow(/cannot accept field/);
        const match = store.recordMatch(EXECUTOR, {
          watchId: 'watch-clock', ref: itemRef('message-1', 'v1'),
        });
        expect(match.matchedAt).toBe('2026-07-18T12:01:00.000Z');

        const lease = store.leaseDeliveries(EXECUTOR, {
          leaseDurationMs: 10_000,
        })[0];
        expect(lease?.leaseExpiresAt).toBe('2026-07-18T12:01:10.000Z');

        clock.set('2026-07-18T11:59:00.000Z');
        expect(() => store.cancelWatch(OWNER_A, {
          watchId: 'watch-clock', reason: 'clock_test',
        })).toThrow(/clock moved backward/);
      } finally {
        store.close();
      }
    });
  });

  test('scopes management by authenticated owner and paginates every listing', () => {
    withFixture((path) => {
      const clock = new MutableClock(START);
      const store = new LocalSourceWatchStore(path, { clock });
      try {
        for (const id of ['watch-a1', 'watch-a2', 'watch-a3']) {
          store.createWatch(watchInput(id), OWNER_A);
          clock.advance(1_000);
        }
        store.createWatch(watchInput('watch-b1'), OWNER_B);

        const first = store.listWatches(OWNER_A, { limit: 2 });
        expect(first.items.map((watch) => watch.watchId)).toEqual(['watch-a1', 'watch-a2']);
        expect(first.nextCursor).toBeDefined();
        if (!first.nextCursor) throw new Error('expected next cursor');
        const second = store.listWatches(OWNER_A, { limit: 2, cursor: first.nextCursor });
        expect(second.items.map((watch) => watch.watchId)).toEqual(['watch-a3']);
        expect(second.nextCursor).toBeUndefined();
        expect(store.listWatches(OWNER_B).items.map((watch) => watch.watchId)).toEqual(['watch-b1']);
        expect(store.getWatch(OWNER_A, 'watch-b1')).toBeUndefined();
        expect(() => store.cancelWatch(OWNER_A, {
          watchId: 'watch-b1', reason: 'not_owner',
        })).toThrow(/owner scope/);
        expect(() => store.listWatches(OWNER_A, { limit: 101 })).toThrow(/limit/);
        expect(store.listExecutableWatches(EXECUTOR, { corpusId: CORPUS }).items).toHaveLength(4);
      } finally {
        store.close();
      }
    });
  });

  test('validates a target before target-scoped expiry and keeps global expiry explicit', () => {
    withFixture((path) => {
      const clock = new MutableClock(START);
      const store = new LocalSourceWatchStore(path, { clock });
      try {
        for (const id of ['watch-expire-a', 'watch-expire-b', 'watch-expire-c']) {
          store.createWatch(watchInput(id, {
            expiresAt: '2026-07-18T12:01:00.000Z',
          }), OWNER_A);
        }
        clock.set('2026-07-18T12:02:00.000Z');

        // Wrong owner cannot use a target lookup as a global maintenance trigger.
        expect(store.getWatch(OWNER_B, 'watch-expire-a')).toBeUndefined();
        expect(queryWatchStatus(path, 'watch-expire-a')).toBe('active');
        expect(queryWatchStatus(path, 'watch-expire-b')).toBe('active');
        expect(() => store.recordMatch(EXECUTOR, {
          watchId: 'missing-target', ref: itemRef('message-1', 'v1'),
        })).toThrow(/target does not exist/);
        expect(queryWatchStatus(path, 'watch-expire-b')).toBe('active');

        expect(store.getWatch(OWNER_A, 'watch-expire-a')?.status).toBe('expired');
        expect(queryWatchStatus(path, 'watch-expire-b')).toBe('active');
        expect(() => store.recordMatch(EXECUTOR, {
          watchId: 'watch-expire-b', ref: itemRef('late-message', 'v1'),
        })).toThrow(/expired/);
        // The rejecting match must not roll its target-only expiry back.
        expect(queryWatchStatus(path, 'watch-expire-b')).toBe('expired');
        expect(store.expireDueWatches(EXECUTOR, { limit: 1 })).toBe(1);
        expect(store.expireDueWatches(EXECUTOR, { limit: 10 })).toBe(0);
      } finally {
        store.close();
      }
    });
  });

  test('orders equal-time watermarks by a deterministic canonical tuple', () => {
    withFixture((path) => {
      const clock = new MutableClock(START);
      const store = new LocalSourceWatchStore(path, { clock });
      try {
        store.createWatch(watchInput('watch-watermark-a'), OWNER_A);
        store.createWatch(watchInput('watch-watermark-b'), OWNER_A);
        const observed = '2026-07-18T11:59:00.000Z';

        const high = store.recordWatermark(EXECUTOR, {
          watchId: 'watch-watermark-a', ref: itemRef('z-item', 'v1'), sourceObservedAt: observed,
        });
        const remainsHigh = store.recordWatermark(EXECUTOR, {
          watchId: 'watch-watermark-a', ref: itemRef('a-item', 'v9'), sourceObservedAt: observed,
        });
        expect(remainsHigh).toEqual(high);

        store.recordWatermark(EXECUTOR, {
          watchId: 'watch-watermark-b', ref: itemRef('a-item', 'v9'), sourceObservedAt: observed,
        });
        const converged = store.recordWatermark(EXECUTOR, {
          watchId: 'watch-watermark-b', ref: itemRef('z-item', 'v1'), sourceObservedAt: observed,
        });
        expect(converged.ref).toEqual(high.ref);

        clock.advance(10_000);
        const exactReplay = store.recordWatermark(EXECUTOR, {
          watchId: 'watch-watermark-a', ref: itemRef('z-item', 'v1'), sourceObservedAt: observed,
        });
        expect(exactReplay.recordedAt).toBe(high.recordedAt);
        expect(() => store.recordWatermark(EXECUTOR, {
          watchId: 'watch-watermark-a',
          ref: itemRef('future', 'v1'),
          sourceObservedAt: '2026-07-18T12:06:00.001Z',
        })).toThrow(/future clock skew/);
      } finally {
        store.close();
      }
    });
  });

  test('uses the canonical ref for a stable delivery key and atomic one-shot idempotency', () => {
    withFixture((path) => {
      const clock = new MutableClock(START);
      const store = new LocalSourceWatchStore(path, { clock });
      try {
        const ref = itemRef('message-123', 'edit-7');
        const key = sourceWatchDeliveryKey('watch-once', ref);
        expect(key).toMatch(/^[a-f0-9]{64}$/);
        expect(sourceWatchDeliveryKey('watch-once', ref)).toBe(key);
        expect(sourceWatchDeliveryKey('watch-once', itemRef('message-123', 'edit-8'))).not.toBe(key);

        store.createWatch(watchInput('watch-once', { mode: 'one_shot' }), OWNER_A);
        const first = store.recordMatch(EXECUTOR, { watchId: 'watch-once', ref });
        expect(first.deliveryKey).toBe(key);
        expect(store.recordMatch(EXECUTOR, { watchId: 'watch-once', ref })).toEqual(first);
        expect(store.getWatch(OWNER_A, 'watch-once')).toMatchObject({
          status: 'completed', completedAt: START,
        });
        expect(() => store.recordMatch(EXECUTOR, {
          watchId: 'watch-once', ref: itemRef('message-124', 'v1'),
        })).toThrow(/completed/);
        expect(store.listMatches(EXECUTOR, { limit: 1 }).items).toEqual([first]);
        expect(store.listOutbox(EXECUTOR, { limit: 1 }).items[0]).toMatchObject({
          deliveryKey: key, status: 'pending', leaseGeneration: 0,
        });
        expect(() => store.listMatches(EXECUTOR, { limit: 101 })).toThrow(/limit/);
        expect(() => store.listOutbox(EXECUTOR, { cursor: 'not-a-cursor' })).toThrow(/cursor/);
      } finally {
        store.close();
      }
    });
  });

  test('enforces composite foreign keys and validates the complete v1 schema', () => {
    withFixture((path) => {
      const store = new LocalSourceWatchStore(path, { clock: new MutableClock(START) });
      store.createWatch(watchInput('watch-fk'), OWNER_A);
      store.recordWatermark(EXECUTOR, {
        watchId: 'watch-fk', ref: itemRef('message-1', 'v1'), sourceObservedAt: START,
      });
      store.recordMatch(EXECUTOR, { watchId: 'watch-fk', ref: itemRef('message-1', 'v1') });
      store.close();

      const db = new Database(path);
      try {
        db.exec('PRAGMA foreign_keys = ON;');
        expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(() => db.query(`
          INSERT INTO source_watch_watermarks (
            watch_id, corpus_id, local_item_id, source_version, source_observed_at, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run('watch-fk', 'wrong.corpus', 'item', 'v1', START, START)).toThrow();
        expect(() => db.query(`
          UPDATE source_watch_outbox SET corpus_id = 'wrong.corpus'
        `).run()).toThrow();
      } finally {
        db.close();
      }

      const reopened = new LocalSourceWatchStore(path, { clock: new MutableClock(START) });
      reopened.close();
    });
  });

  test('refuses unversioned collisions, partial v1 schemas, and future schemas', () => {
    withFixture((path) => {
      let db = new Database(path, { create: true });
      db.exec('CREATE TABLE source_watches (watch_id TEXT PRIMARY KEY);');
      db.close();
      expect(() => new LocalSourceWatchStore(path)).toThrow(/unversioned\/colliding/);
    });

    withFixture((path) => {
      let db = new Database(path, { create: true });
      db.exec(`
        CREATE TABLE schema_version (
          store_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE source_watches (watch_id TEXT PRIMARY KEY);
      `);
      db.query('INSERT INTO schema_version (store_id, version, applied_at) VALUES (?, 1, ?)')
        .run(SOURCE_WATCH_STORE_ID, START);
      db.close();
      expect(() => new LocalSourceWatchStore(path)).toThrow(/required v1 columns/);
    });

    withFixture((path) => {
      const db = new Database(path, { create: true });
      db.exec(`
        CREATE TABLE schema_version (
          store_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      db.query('INSERT INTO schema_version (store_id, version, applied_at) VALUES (?, 99, ?)')
        .run(SOURCE_WATCH_STORE_ID, START);
      db.close();
      expect(() => new LocalSourceWatchStore(path)).toThrow(/schema_version 99/);
    });
  });

  test('bounds leases/retries and records retry then delivery through the current fence', () => {
    withFixture((path) => {
      const clock = new MutableClock(START);
      const store = new LocalSourceWatchStore(path, { clock });
      try {
        store.createWatch(watchInput('watch-retry'), OWNER_A);
        const match = store.recordMatch(EXECUTOR, {
          watchId: 'watch-retry', ref: itemRef('message-1', 'v1'),
        });
        expect(() => store.leaseDeliveries(EXECUTOR, {
          leaseDurationMs: SOURCE_WATCH_MIN_LEASE_MS - 1,
        })).toThrow(/leaseDurationMs/);
        expect(() => store.leaseDeliveries(EXECUTOR, {
          leaseDurationMs: SOURCE_WATCH_MAX_LEASE_MS + 1,
        })).toThrow(/leaseDurationMs/);

        const first = store.leaseDeliveries(EXECUTOR, { leaseDurationMs: 10_000 })[0];
        expect(first).toMatchObject({
          deliveryKey: match.deliveryKey,
          downstreamIdempotencyKey: match.deliveryKey,
          queryText: 'Tell me when a newly indexed item matches this saved watch.',
          watchMode: 'continuous',
          leaseGeneration: 1,
          attemptCount: 1,
        });
        if (!first) throw new Error('expected first lease');
        clock.set('2026-07-18T11:59:59.000Z');
        expect(() => store.recordDelivered(EXECUTOR, fence(first))).toThrow(/clock moved backward/);
        clock.set(START);
        expect(() => store.recordDeliveryFailure(EXECUTOR, {
          ...fence(first),
          retryAfterMs: SOURCE_WATCH_MIN_RETRY_MS - 1,
          errorKind: 'temporary', errorHash: 'a'.repeat(64),
        })).toThrow(/retryAfterMs/);
        expect(() => store.recordDeliveryFailure(EXECUTOR, {
          ...fence(first),
          retryAfterMs: SOURCE_WATCH_MAX_RETRY_MS + 1,
          errorKind: 'temporary', errorHash: 'a'.repeat(64),
        })).toThrow(/retryAfterMs/);

        const retry = store.recordDeliveryFailure(EXECUTOR, {
          ...fence(first),
          retryAfterMs: 2_000,
          errorKind: 'transient_network', errorHash: 'a'.repeat(64),
        });
        expect(retry).toMatchObject({ status: 'retry', attemptCount: 1 });
        expect(store.leaseDeliveries(EXECUTOR, { leaseDurationMs: 10_000 })).toEqual([]);
        clock.advance(2_000);
        const second = store.leaseDeliveries(EXECUTOR, { leaseDurationMs: 10_000 })[0];
        expect(second).toMatchObject({ leaseGeneration: 2, attemptCount: 2 });
        if (!second) throw new Error('expected second lease');
        const delivered = store.recordDelivered(EXECUTOR, fence(second));
        expect(delivered).toMatchObject({ status: 'delivered', attemptCount: 2 });
        expect(store.recordDelivered(EXECUTOR, fence(second))).toEqual(delivered);
        expect(() => store.recordDelivered(EXECUTOR_B, fence(second))).toThrow(/stale|another executor/);
      } finally {
        store.close();
      }
    });
  });

  test('rejects same-owner stale ACK/failure after an expired lease is fenced again', () => {
    withFixture((path) => {
      const clock = new MutableClock(START);
      const store = new LocalSourceWatchStore(path, { clock });
      try {
        store.createWatch(watchInput('watch-fence'), OWNER_A);
        store.recordMatch(EXECUTOR, {
          watchId: 'watch-fence', ref: itemRef('message-1', 'v1'),
        });
        const first = store.leaseDeliveries(EXECUTOR, { leaseDurationMs: 1_000 })[0];
        if (!first) throw new Error('expected first lease');
        clock.advance(1_000);
        const second = store.leaseDeliveries(EXECUTOR, { leaseDurationMs: 1_000 })[0];
        if (!second) throw new Error('expected second lease');
        expect(second.leaseOwner).toBe(first.leaseOwner);
        expect(second.leaseGeneration).toBe(first.leaseGeneration + 1);
        expect(second.leaseToken).not.toBe(first.leaseToken);
        expect(() => store.recordDelivered(EXECUTOR, fence(first))).toThrow(/fence is stale/);
        expect(() => store.recordDeliveryFailure(EXECUTOR, {
          ...fence(first),
          retryAfterMs: 1_000,
          errorKind: 'stale', errorHash: 'b'.repeat(64),
        })).toThrow(/fence is stale/);
        expect(store.recordDelivered(EXECUTOR, fence(second)).status).toBe('delivered');
      } finally {
        store.close();
      }
    });
  });

  test('supports crash-after-send replay with a stable downstream idempotency key', () => {
    withFixture((path) => {
      const clock = new MutableClock(START);
      let store = new LocalSourceWatchStore(path, { clock });
      store.createWatch(watchInput('watch-crash-send'), OWNER_A);
      store.recordMatch(EXECUTOR, {
        watchId: 'watch-crash-send', ref: itemRef('message-1', 'v1'),
      });
      const sentBeforeCrash = store.leaseDeliveries(EXECUTOR, { leaseDurationMs: 1_000 })[0];
      if (!sentBeforeCrash) throw new Error('expected pre-crash lease');
      const downstreamSeen = new Set([sentBeforeCrash.downstreamIdempotencyKey]);
      // Simulated: downstream accepted the send, then this process died before ACK.
      store.close();

      clock.advance(1_000);
      store = new LocalSourceWatchStore(path, { clock });
      try {
        const replay = store.leaseDeliveries(EXECUTOR, { leaseDurationMs: 1_000 })[0];
        if (!replay) throw new Error('expected replay lease');
        expect(replay.downstreamIdempotencyKey).toBe(sentBeforeCrash.downstreamIdempotencyKey);
        expect(replay.deliveryKey).toBe(sentBeforeCrash.deliveryKey);
        expect(replay.leaseToken).not.toBe(sentBeforeCrash.leaseToken);
        expect(replay.leaseGeneration).toBe(sentBeforeCrash.leaseGeneration + 1);
        const downstreamAcceptedAsNew = !downstreamSeen.has(replay.downstreamIdempotencyKey);
        expect(downstreamAcceptedAsNew).toBe(false);
        expect(store.recordDelivered(EXECUTOR, fence(replay)).status).toBe('delivered');
      } finally {
        store.close();
      }
    });
  });

  test('dead-letters at the attempt bound and cancellation invalidates active leases', () => {
    withFixture((path) => {
      const clock = new MutableClock(START);
      const store = new LocalSourceWatchStore(path, { clock });
      try {
        store.createWatch(watchInput('watch-dead', { maxDeliveryAttempts: 2 }), OWNER_A);
        store.recordMatch(EXECUTOR, { watchId: 'watch-dead', ref: itemRef('dead-1', 'v1') });
        const first = store.leaseDeliveries(EXECUTOR, { leaseDurationMs: 10_000 })[0];
        if (!first) throw new Error('expected first lease');
        store.recordDeliveryFailure(EXECUTOR, {
          ...fence(first), retryAfterMs: 1_000, errorKind: 'temporary', errorHash: 'c'.repeat(64),
        });
        clock.advance(1_000);
        const second = store.leaseDeliveries(EXECUTOR, { leaseDurationMs: 10_000 })[0];
        if (!second) throw new Error('expected second lease');
        const dead = store.recordDeliveryFailure(EXECUTOR, {
          ...fence(second), retryAfterMs: 1_000, errorKind: 'temporary', errorHash: 'd'.repeat(64),
        });
        expect(dead).toMatchObject({ status: 'dead_letter', attemptCount: 2 });

        store.createWatch(watchInput('watch-cancel'), OWNER_A);
        store.recordMatch(EXECUTOR, { watchId: 'watch-cancel', ref: itemRef('cancel-1', 'v1') });
        const active = store.leaseDeliveries(EXECUTOR, { leaseDurationMs: 10_000 })[0];
        if (!active) throw new Error('expected active lease');
        expect(() => store.cancelWatch(OWNER_B, {
          watchId: 'watch-cancel', reason: 'wrong_owner',
        })).toThrow(/owner scope/);
        expect(store.cancelWatch(OWNER_A_SECOND_ROUTE, {
          watchId: 'watch-cancel', reason: 'user_cancelled',
        })).toMatchObject({ status: 'cancelled', cancelReason: 'user_cancelled' });
        expect(store.getOutboxEntry(EXECUTOR, active.deliveryKey)).toMatchObject({ status: 'cancelled' });
        expect(() => store.recordDelivered(EXECUTOR, fence(active))).toThrow(/not actively leased/);
      } finally {
        store.close();
      }
    });
  });

  test('treats watch expiry as a matching deadline, never a delivery deadline', () => {
    withFixture((path) => {
      const clock = new MutableClock(START);
      const store = new LocalSourceWatchStore(path, { clock });
      try {
        store.createWatch(watchInput('watch-deadline', {
          expiresAt: '2026-07-18T12:01:00.000Z',
        }), OWNER_A);
        clock.set('2026-07-18T12:00:30.000Z');
        const accepted = store.recordMatch(EXECUTOR, {
          watchId: 'watch-deadline', ref: itemRef('before-deadline', 'v1'),
        });

        clock.set('2026-07-18T12:02:00.000Z');
        expect(store.expireDueWatches(EXECUTOR)).toBe(1);
        expect(store.getWatch(OWNER_A, 'watch-deadline')?.status).toBe('expired');
        expect(() => store.recordMatch(EXECUTOR, {
          watchId: 'watch-deadline', ref: itemRef('after-deadline', 'v1'),
        })).toThrow(/expired/);

        const lease = store.leaseDeliveries(EXECUTOR, { leaseDurationMs: 10_000 })[0];
        expect(lease?.deliveryKey).toBe(accepted.deliveryKey);
        if (!lease) throw new Error('expected pre-deadline delivery');
        expect(store.recordDelivered(EXECUTOR, fence(lease)).status).toBe('delivered');
      } finally {
        store.close();
      }
    });
  });

  test('purges terminal delivery state only after bounded retention and in bounded batches', () => {
    withFixture((path) => {
      const clock = new MutableClock(START);
      const store = new LocalSourceWatchStore(path, { clock });
      try {
        store.createWatch(watchInput('watch-retention'), OWNER_A);
        for (const item of ['retention-1', 'retention-2']) {
          store.recordMatch(EXECUTOR, {
            watchId: 'watch-retention', ref: itemRef(item, 'v1'),
          });
        }
        const leases = store.leaseDeliveries(EXECUTOR, { leaseDurationMs: 10_000, limit: 2 });
        expect(leases).toHaveLength(2);
        for (const lease of leases) store.recordDelivered(EXECUTOR, fence(lease));
        store.cancelWatch(OWNER_A, {
          watchId: 'watch-retention', reason: 'retention_test',
        });

        expect(() => store.purgeTerminalDeliveries(EXECUTOR, {
          retentionMs: SOURCE_WATCH_MIN_RETENTION_MS - 1,
        })).toThrow(/retentionMs/);
        expect(store.purgeTerminalDeliveries(EXECUTOR, {
          retentionMs: SOURCE_WATCH_MIN_RETENTION_MS,
          limit: 1,
        })).toEqual({ purged: 0 });
        clock.advance(SOURCE_WATCH_MIN_RETENTION_MS);
        expect(store.purgeTerminalDeliveries(EXECUTOR, {
          retentionMs: SOURCE_WATCH_MIN_RETENTION_MS,
          limit: 1,
        })).toEqual({ purged: 1 });
        expect(store.listMatches(EXECUTOR).items).toHaveLength(1);
        expect(store.purgeTerminalDeliveries(EXECUTOR, {
          retentionMs: SOURCE_WATCH_MIN_RETENTION_MS,
          limit: 1,
        })).toEqual({ purged: 1 });
        expect(store.listMatches(EXECUTOR).items).toEqual([]);
        expect(store.listOutbox(EXECUTOR).items).toEqual([]);
        expect(store.purgeTerminalWatches(EXECUTOR, {
          retentionMs: SOURCE_WATCH_MIN_RETENTION_MS,
          limit: 1,
        })).toEqual({ purged: 1 });
        expect(store.getWatch(OWNER_A, 'watch-retention')).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });
});

class MutableClock implements SourceWatchClock {
  private currentMs: number;

  constructor(timestamp: string) {
    this.currentMs = Date.parse(timestamp);
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  set(timestamp: string): void {
    this.currentMs = Date.parse(timestamp);
  }

  advance(milliseconds: number): void {
    this.currentMs += milliseconds;
  }
}

function watchInput(
  watchId: string,
  overrides: Partial<CreateSourceWatchInput> = {},
): CreateSourceWatchInput {
  return {
    watchId,
    corpusId: CORPUS,
    queryText: 'Tell me when a newly indexed item matches this saved watch.',
    mode: 'continuous',
    ...overrides,
  };
}

function itemRef(localItemId: string, sourceVersion: string): SourceWatchCanonicalRef {
  return { corpusId: CORPUS, localItemId, sourceVersion };
}

function fence(lease: {
  deliveryKey: string;
  leaseToken: string;
  leaseGeneration: number;
}) {
  return {
    deliveryKey: lease.deliveryKey,
    leaseToken: lease.leaseToken,
    leaseGeneration: lease.leaseGeneration,
  };
}

function queryWatchStatus(path: string, watchId: string): string | undefined {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query('SELECT status FROM source_watches WHERE watch_id = ?')
      .get(watchId) as { status?: string } | null;
    return row?.status;
  } finally {
    db.close();
  }
}

function withFixture(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-source-watch-'));
  const leaf = join(dir, 'private-state');
  mkdirSync(leaf, { mode: 0o700 });
  try {
    run(join(leaf, 'watches.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

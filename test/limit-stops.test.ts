import { SourceScheduler } from '../src/workers/source-scheduler.ts';
import { createFrontScheduler } from '../src/workers/engine-split/front-scheduler.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearLimitStop, initializeLimitStops, listOpenLimitStops, registerLimit,
  registeredLimits, reportLimitStop, withinOverrunMargin, type LimitStop,
} from '../src/core/limit-stops.ts';
import { forgetSourceSchedulerState, LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';

const roots: string[] = [];
function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-limit-stops-'));
  roots.push(root);
  return join(root, 'state.sqlite');
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function withDb<T>(path: string, action: (db: Database) => T): T {
  const db = new Database(path);
  try { return action(db); } finally { db.close(); }
}
// Every listing reads at a fixed time inside the stops' day, never the wall clock.
const AT = new Date('2026-11-12T13:00:00.000Z');
const listAt = (path: string, now = AT): LimitStop[] => withDb(path, (db) => listOpenLimitStops(db, now));

const registration = {
  id: 'test.limit', kind: 'cost', scope: 'answer', label: 'Daily cost', unit: 'usd', continue: 'raise',
} as const;
const stop = {
  id: registration.id, subject: 'answer', since: '2026-11-12T12:00:00.000Z', limit: 2, used: 2,
  waiting: { items: 4, runs: 1 }, toContinue: { cost: 0.2, time: 100, raiseTo: 3 },
  resumesAt: '2026-11-13T00:00:00.000Z',
} satisfies LimitStop;
registerLimit(registration);

describe('limit stops', () => {
  test('registers idempotently and rejects conflicting definitions', () => {
    registerLimit({ ...registration });
    expect(registeredLimits().filter((item) => item.id === registration.id)).toEqual([registration]);
    expect(() => registerLimit({ ...registration, unit: 'calls' })).toThrow('differently');
  });

  test('report, list and clear are idempotent per id and subject; a new stop reopens', () => {
    const db = new Database(':memory:');
    try {
      initializeLimitStops(db);
      reportLimitStop(stop, db);
      reportLimitStop(stop, db);
      expect(listOpenLimitStops(db, AT)).toEqual([stop]);
      reportLimitStop({ ...stop, since: '2026-11-12T13:00:00.000Z', used: 2.1 }, db);
      expect(listOpenLimitStops(db, AT)[0]).toEqual({ ...stop, used: 2.1 });
      reportLimitStop({ ...stop, subject: 'other' }, db);
      clearLimitStop(stop.id, stop.subject, db);
      const cleared = db.query('SELECT cleared_at FROM limit_stops WHERE subject = ?').get(stop.subject);
      expect(cleared).toMatchObject({ cleared_at: expect.any(String) });
      clearLimitStop(stop.id, stop.subject, db);
      expect(db.query('SELECT cleared_at FROM limit_stops WHERE subject = ?').get(stop.subject)).toEqual(cleared);
      expect(listOpenLimitStops(db, AT)).toEqual([{ ...stop, subject: 'other' }]);
      const reopened = { id: stop.id, subject: stop.subject, since: '2026-11-13T12:00:00.000Z', limit: 2, used: 2 };
      reportLimitStop(reopened, db);
      expect(listOpenLimitStops(db, AT).find((row) => row.subject === stop.subject)).toEqual(reopened);
      expect(db.query('SELECT COUNT(*) AS n FROM limit_stops').get()).toEqual({ n: 2 });
    } finally { db.close(); }
  });

  test('survives reopening the engine database, including clears', () => {
    const path = databasePath();
    const db = new Database(path);
    initializeLimitStops(db);
    reportLimitStop(stop, db);
    db.close();
    const reader = new Database(path, { readonly: true });
    try { expect(listOpenLimitStops(reader, AT)).toEqual([stop]); } finally { reader.close(); }
    withDb(path, (db) => clearLimitStop(stop.id, stop.subject, db));
    expect(listAt(path)).toEqual([]);
    withDb(path, (db) => reportLimitStop(stop, db));
    expect(listAt(path)).toEqual([stop]);
  });

  test('reads do not migrate an older database', () => {
    const path = databasePath();
    const db = new Database(path);
    db.close();
    expect(listAt(path)).toEqual([]);
    const reader = new Database(path, { readonly: true });
    try { expect(reader.query('SELECT name FROM sqlite_master').all()).toEqual([]); } finally { reader.close(); }
  });

  test('unregistered ids throw and write nothing', () => {
    const db = new Database(':memory:');
    try {
      initializeLimitStops(db);
      expect(() => reportLimitStop({ ...stop, id: 'test.unknown' }, db)).toThrow('Unregistered limit');
      expect(listOpenLimitStops(db, AT)).toEqual([]);
    } finally { db.close(); }
  });

  test('overrun margins are bounded and unknown prices never qualify', () => {
    for (const [kind, limit, needed, expected] of [
      ['cost', 2, 2.20, true], ['cost', 2, 2.21, false],
      ['cost', 10, 10.50, true], ['cost', 10, 11, false],
      ['requests', 100, 110, true], ['requests', 100, 111, false],
      ['calls', 10, 11, true], ['calls', 10, 12, false],
      ['size', 100, 101, false], ['funding', 2, 2.01, false], ['time', 100, 101, false],
      ['cost', 2, null, false], ['cost', 2, undefined, false], ['cost', 2, NaN, false],
      ['cost', Infinity, 2, false], ['cost', -1, 0, false], ['cost', 2, -1, false],
    ] as const) expect(withinOverrunMargin(kind, limit, needed)).toBe(expected);
  });

  test('failure markers replace stops and a reporting failure rolls back the marker', () => {
    const path = databasePath();
    const store = new LocalSourceSchedulerStateStore(path);
    const db = new Database(path);
    const key = { sourceId: 'x.bookmarks', corpusId: 'corpus', taskId: 'head' };
    const failure = {
      ...key, completedAt: stop.since, notBeforeAt: stop.resumesAt!,
      errorKind: 'api_request_guard', errorHash: '0123456789abcdef',
    };
    try {
      store.recordFailure({ ...failure, degradedReason: 'daily_cost_guard' });
      expect(listAt(path).map((row) => row.id)).toEqual(['x.daily_cost']);
      store.recordFailure({ ...failure, degradedReason: 'daily_api_request_guard' });
      expect(listAt(path).map((row) => row.id)).toEqual(['x.daily_requests']);
      db.exec(`CREATE TRIGGER refuse_stop BEFORE INSERT ON limit_stops
        BEGIN SELECT RAISE(ABORT, 'report failed'); END`);
      expect(() => store.recordFailure({ ...failure, degradedReason: 'daily_cost_guard' })).toThrow('report failed');
      expect(store.get(key)?.degradedReason).toBe('daily_api_request_guard');
      expect(listAt(path).map((row) => row.id)).toEqual(['x.daily_requests']);
      store.recordSuccess({ ...key, completedAt: stop.since, resultStatus: 'idle', degradedReason: 'embedding_items_failed' });
      expect(listAt(path)).toEqual([]);
    } finally { db.close(); store.close(); }
  });

  test.each([
    ['daily_cost_guard', 'x.daily_cost'], ['daily_api_request_guard', 'x.daily_requests'],
    ['daily_resource_read_guard', 'x.daily_resource_reads'],
    ['readwise_daily_api_request_guard', 'readwise.daily_requests'],
    ['gmail_daily_api_request_guard', 'gmail.daily_requests'],
    ['google_drive_daily_api_request_guard', 'drive.daily_requests'],
    ['head_api_request_reserve_guard', 'x.head_reserve_requests'],
    ['head_resource_read_reserve_guard', 'x.head_reserve_reads'],
    ['head_cost_reserve_guard', 'x.head_reserve_cost'],
  ])('scheduler marker %s reports and clears %s atomically', (reason, id) => {
    const path = databasePath();
    const store = new LocalSourceSchedulerStateStore(path);
    const key = { sourceId: 'source', corpusId: 'corpus', taskId: 'pull' };
    const completedAt = stop.since;
    const parked = { ...key, completedAt, resultStatus: 'idle' as const, degradedReason: reason, notBeforeAt: stop.resumesAt };
    try {
      store.recordSuccess(parked);
      expect(listAt(path)).toEqual([{
        id, subject: JSON.stringify(['source', 'corpus', 'pull']), since: completedAt,
        limit: null, used: null, resumesAt: stop.resumesAt,
      }]);
      store.recordSuccess({ ...parked, taskId: 'reconcile' });
      store.recordSuccess({ ...key, completedAt, resultStatus: 'idle' });
      expect(listAt(path)).toHaveLength(1);
      store.adoptExternalSuccess({ ...key, taskId: 'reconcile', completedAt: '2026-11-12T13:00:00.000Z', resultStatus: 'idle' });
      expect(listAt(path)).toEqual([]);
    } finally { store.close(); }
  });

  test('a task parked before the record existed gets its stop when the store opens', () => {
    const path = databasePath();
    const key = { sourceId: 'source', corpusId: 'corpus', taskId: 'pull' };
    const first = new LocalSourceSchedulerStateStore(path);
    first.recordSuccess({ ...key, completedAt: stop.since, resultStatus: 'idle', degradedReason: 'daily_cost_guard', notBeforeAt: stop.resumesAt });
    first.close();
    // An install upgraded across this change: the marker is set, the record is not.
    const raw = new Database(path);
    raw.exec('DELETE FROM limit_stops');
    raw.close();
    expect(listAt(path)).toEqual([]);
    const reopened = new LocalSourceSchedulerStateStore(path);
    try {
      expect(listAt(path).map((row) => [row.id, row.subject, row.resumesAt])).toEqual([
        ['x.daily_cost', JSON.stringify(['source', 'corpus', 'pull']), stop.resumesAt],
      ]);
    } finally { reopened.close(); }
    const again = new LocalSourceSchedulerStateStore(path);
    try { expect(listAt(path)).toHaveLength(1); } finally { again.close(); }
  });

  test('forgetting a source removes its stops and keeps other sources and non-scheduler subjects', () => {
    const path = databasePath();
    const store = new LocalSourceSchedulerStateStore(path);
    const parked = (sourceId: string, corpusId: string) => store.recordSuccess({
      sourceId, corpusId, taskId: 'pull', completedAt: stop.since, resultStatus: 'idle', degradedReason: 'daily_cost_guard',
    });
    try {
      parked('gone', 'gone-corpus');
      parked('kept', 'kept-corpus');
      withDb(path, (db) => reportLimitStop(stop, db));
    } finally { store.close(); }
    expect(forgetSourceSchedulerState(path, { sourceIds: ['gone'], corpusIds: [] }, { dryRun: true })).toBeGreaterThanOrEqual(2);
    expect(listAt(path)).toHaveLength(3);
    forgetSourceSchedulerState(path, { sourceIds: ['gone'], corpusIds: [] });
    expect(listAt(path).map((row) => row.subject).sort()).toEqual(
      [JSON.stringify(['kept', 'kept-corpus', 'pull']), stop.subject].sort());
    forgetSourceSchedulerState(path, { sourceIds: [], corpusIds: ['kept-corpus'] });
    expect(listAt(path).map((row) => row.subject)).toEqual([stop.subject]);
  });

  test('a daily stop ends when its UTC day does, even if the task never runs again', () => {
    const path = databasePath();
    const store = new LocalSourceSchedulerStateStore(path);
    const key = { sourceId: 'source', corpusId: 'corpus', taskId: 'pull' };
    try {
      // Booked to retry in two days: the budget still resets at midnight.
      store.recordSuccess({ ...key, completedAt: stop.since, resultStatus: 'idle', degradedReason: 'daily_cost_guard',
        notBeforeAt: '2026-11-14T00:00:00.000Z' });
      const [open] = listAt(path, new Date(stop.since));
      expect(open?.resumesAt).toBe('2026-11-13T00:00:00.000Z');
      expect(listAt(path, new Date('2026-11-12T23:59:59.000Z'))).toHaveLength(1);
      expect(listAt(path, new Date('2026-11-13T00:00:00.000Z'))).toEqual([]);
    } finally { store.close(); }
    // Reopening backfills the expired marker, but it still does not list as open.
    const reopened = new LocalSourceSchedulerStateStore(path);
    try { expect(reopened.openLimitStops(new Date('2026-11-13T09:00:00.000Z'))).toEqual([]); } finally { reopened.close(); }
  });

  test('the same limit hit again the next day starts a new stop', () => {
    const path = databasePath();
    const store = new LocalSourceSchedulerStateStore(path);
    const key = { sourceId: 'source', corpusId: 'corpus', taskId: 'pull' };
    const park = (completedAt: string) => store.recordFailure({
      ...key, completedAt, notBeforeAt: '2026-11-20T00:00:00.000Z', degradedReason: 'daily_cost_guard',
      errorKind: 'api_request_guard', errorHash: '0123456789abcdef',
    });
    try {
      park('2026-11-12T12:00:00.000Z');
      park('2026-11-12T18:00:00.000Z');
      expect(listAt(path, new Date('2026-11-12T19:00:00.000Z'))[0]?.since).toBe('2026-11-12T12:00:00.000Z');
      park('2026-11-13T09:00:00.000Z');
      const [next] = listAt(path, new Date('2026-11-13T10:00:00.000Z'));
      expect(next?.since).toBe('2026-11-13T09:00:00.000Z');
      expect(next?.resumesAt).toBe('2026-11-14T00:00:00.000Z');
    } finally { store.close(); }
  });
});

test('scheduler status carries owning-store stops through the front snapshot, without front writes', () => {
  const store = new LocalSourceSchedulerStateStore(databasePath());
  const now = new Date('2026-11-12T13:00:00.000Z');
  const key = { sourceId: 'x.bookmarks', corpusId: 'internal.x.bookmarks', taskId: 'pull' };
  try {
    store.recordSuccess({ ...key, completedAt: now.toISOString(), resultStatus: 'idle', degradedReason: 'daily_cost_guard' });
    const scheduler = new SourceScheduler({ enabled: true, tickMs: 1000, errorBackoffMs: 1000, maxTransientRetries: 0, sources: [], stateStore: store });
    const front = createFrontScheduler({ client: { post: async () => { throw new Error('read must not post'); } },
      snapshot: () => ({ stale: false, snapshot: { scheduler: scheduler.status(now) } } as import('../src/workers/engine-split/snapshot.ts').EngineStatusRead) });
    expect(front.status().limit_stops).toEqual(store.openLimitStops(now));
    expect(front.status().limit_stops).toHaveLength(1);
    store.recordSuccess({ ...key, completedAt: now.toISOString(), resultStatus: 'idle' });
    expect(front.status().limit_stops).toEqual([]);
  } finally { store.close(); }
});

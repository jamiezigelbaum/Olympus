import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
      expect(listOpenLimitStops(db)).toEqual([stop]);
      reportLimitStop({ ...stop, since: '2026-11-12T13:00:00.000Z', used: 2.1 }, db);
      expect(listOpenLimitStops(db)[0]).toEqual({ ...stop, used: 2.1 });
      reportLimitStop({ ...stop, subject: 'other' }, db);
      clearLimitStop(stop.id, stop.subject, db);
      const cleared = db.query('SELECT cleared_at FROM limit_stops WHERE subject = ?').get(stop.subject);
      expect(cleared).toMatchObject({ cleared_at: expect.any(String) });
      clearLimitStop(stop.id, stop.subject, db);
      expect(db.query('SELECT cleared_at FROM limit_stops WHERE subject = ?').get(stop.subject)).toEqual(cleared);
      expect(listOpenLimitStops(db)).toEqual([{ ...stop, subject: 'other' }]);
      const reopened = { id: stop.id, subject: stop.subject, since: '2026-11-13T12:00:00.000Z', limit: 2, used: 2 };
      reportLimitStop(reopened, db);
      expect(listOpenLimitStops(db).find((row) => row.subject === stop.subject)).toEqual(reopened);
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
    try { expect(listOpenLimitStops(reader)).toEqual([stop]); } finally { reader.close(); }
    clearLimitStop(stop.id, stop.subject, path);
    expect(listOpenLimitStops(path)).toEqual([]);
    reportLimitStop(stop, path);
    expect(listOpenLimitStops(path)).toEqual([stop]);
  });

  test('reads do not create a database or migrate an older one', () => {
    const path = databasePath();
    expect(listOpenLimitStops(path)).toEqual([]);
    expect(existsSync(path)).toBe(false);
    const db = new Database(path);
    db.close();
    expect(listOpenLimitStops(path)).toEqual([]);
    const reader = new Database(path, { readonly: true });
    try { expect(reader.query('SELECT name FROM sqlite_master').all()).toEqual([]); } finally { reader.close(); }
  });

  test('unregistered ids throw before opening storage', () => {
    const path = databasePath();
    expect(() => reportLimitStop({ ...stop, id: 'test.unknown' }, path)).toThrow('Unregistered limit');
    expect(existsSync(path)).toBe(false);
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
      expect(listOpenLimitStops(path).map((row) => row.id)).toEqual(['x.daily_cost']);
      store.recordFailure({ ...failure, degradedReason: 'daily_api_request_guard' });
      expect(listOpenLimitStops(path).map((row) => row.id)).toEqual(['x.daily_requests']);
      db.exec(`CREATE TRIGGER refuse_stop BEFORE INSERT ON limit_stops
        BEGIN SELECT RAISE(ABORT, 'report failed'); END`);
      expect(() => store.recordFailure({ ...failure, degradedReason: 'daily_cost_guard' })).toThrow('report failed');
      expect(store.get(key)?.degradedReason).toBe('daily_api_request_guard');
      expect(listOpenLimitStops(path).map((row) => row.id)).toEqual(['x.daily_requests']);
      store.recordSuccess({ ...key, completedAt: stop.since, resultStatus: 'idle', degradedReason: 'embedding_items_failed' });
      expect(listOpenLimitStops(path)).toEqual([]);
    } finally { db.close(); store.close(); }
  });

  test.each([
    ['daily_cost_guard', 'x.daily_cost'], ['daily_api_request_guard', 'x.daily_requests'],
    ['daily_resource_read_guard', 'x.daily_resource_reads'],
    ['readwise_daily_api_request_guard', 'readwise.daily_requests'],
    ['gmail_daily_api_request_guard', 'gmail.daily_requests'],
    ['google_drive_daily_api_request_guard', 'drive.daily_requests'],
  ])('scheduler marker %s reports and clears %s atomically', (reason, id) => {
    const path = databasePath();
    const store = new LocalSourceSchedulerStateStore(path);
    const key = { sourceId: 'source', corpusId: 'corpus', taskId: 'pull' };
    const completedAt = stop.since;
    const parked = { ...key, completedAt, resultStatus: 'idle' as const, degradedReason: reason, notBeforeAt: stop.resumesAt };
    try {
      store.recordSuccess(parked);
      expect(listOpenLimitStops(path)).toEqual([{
        id, subject: JSON.stringify(['source', 'corpus', 'pull']), since: completedAt,
        limit: null, used: null, resumesAt: stop.resumesAt,
      }]);
      store.recordSuccess({ ...parked, taskId: 'reconcile' });
      store.recordSuccess({ ...key, completedAt, resultStatus: 'idle' });
      expect(listOpenLimitStops(path)).toHaveLength(1);
      store.adoptExternalSuccess({ ...key, taskId: 'reconcile', completedAt: '2026-11-12T13:00:00.000Z', resultStatus: 'idle' });
      expect(listOpenLimitStops(path)).toEqual([]);
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
    expect(listOpenLimitStops(path)).toEqual([]);
    const reopened = new LocalSourceSchedulerStateStore(path);
    try {
      expect(listOpenLimitStops(path).map((row) => [row.id, row.subject, row.resumesAt])).toEqual([
        ['x.daily_cost', JSON.stringify(['source', 'corpus', 'pull']), stop.resumesAt],
      ]);
    } finally { reopened.close(); }
    const again = new LocalSourceSchedulerStateStore(path);
    try { expect(listOpenLimitStops(path)).toHaveLength(1); } finally { again.close(); }
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
      reportLimitStop(stop, path);
    } finally { store.close(); }
    expect(forgetSourceSchedulerState(path, { sourceIds: ['gone'], corpusIds: [] }, { dryRun: true })).toBeGreaterThanOrEqual(2);
    expect(listOpenLimitStops(path)).toHaveLength(3);
    forgetSourceSchedulerState(path, { sourceIds: ['gone'], corpusIds: [] });
    expect(listOpenLimitStops(path).map((row) => row.subject).sort()).toEqual(
      [JSON.stringify(['kept', 'kept-corpus', 'pull']), stop.subject].sort());
    forgetSourceSchedulerState(path, { sourceIds: [], corpusIds: ['kept-corpus'] });
    expect(listOpenLimitStops(path).map((row) => row.subject)).toEqual([stop.subject]);
  });
});

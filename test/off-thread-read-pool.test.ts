// The read pool behind the Ask keyword search (#1079): a query past its
// deadline never holds up the next one beyond the pool's bound, a thread that
// cannot be stopped keeps its place until it has stopped, a thread that
// cannot start makes the lane busy (never a read on the request thread), a
// deadline is checked when a query is sent and when its rows come back, and a
// closed store's pool connections are released.

import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  OffThreadReadBusyError,
  READ_POOL_SIZE,
  readOnPool,
  readPoolThreadsForTests,
  setReadPoolClockForTests,
  setReadPoolObserverForTests,
  setReadPoolWorkerFactoryForTests,
  shutdownReadPool,
  withOffThreadSnapshot,
  type StoreRead,
} from '../src/workers/connector-store/off-thread-reads.ts';
import { createTestClock, waitFor } from './helpers/test-clock.ts';

const roots: string[] = [];
afterEach(async () => {
  setReadPoolClockForTests();
  setReadPoolObserverForTests();
  setReadPoolWorkerFactoryForTests();
  shutdownReadPool();
  await waitFor(() => readPoolThreadsForTests().live + readPoolThreadsForTests().stopping === 0, { description: 'the pool stopped' });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 30_000);

function storeFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-read-pool-'));
  roots.push(root);
  const path = join(root, 'store.sqlite');
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE items (n INTEGER); INSERT INTO items VALUES (1), (2), (3);');
  db.close();
  return path;
}

// A statement that runs for a few seconds on its thread: only a
// deadline gives it up, and its thread stops when it ends.
const SLOW: StoreRead = {
  mode: 'get',
  sql: 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000000) SELECT COUNT(*) AS c FROM n',
  params: [],
};
const COUNT: StoreRead = { mode: 'get', sql: 'SELECT COUNT(*) AS c FROM items', params: [] };

describe('read pool', () => {
  test('stuck queries past their deadline fail busy, keep their places until their threads stop, and the next query then runs', async () => {
    const path = storeFile();
    const clock = createTestClock();
    setReadPoolClockForTests(clock);
    const started: string[] = [];
    setReadPoolObserverForTests((_, read) => started.push(read.sql));
    const stuck = Array.from({ length: READ_POOL_SIZE }, () => readOnPool(path, SLOW, { deadlineAtMs: clock.now() + 1_000 }).then(() => 'answered', (error) => error));
    // Queued behind them: one that must wait out the stuck threads, one whose deadline comes first.
    const next = readOnPool(path, COUNT, { deadlineAtMs: clock.now() + 600_000 });
    const tooSoon = readOnPool(path, COUNT, { deadlineAtMs: clock.now() + 2_000 }).then(() => 'answered', (error) => error);
    await waitFor(() => started.length === READ_POOL_SIZE, { description: 'both slow queries running' });
    await clock.advance(1_000);
    for (const outcome of await Promise.all(stuck)) expect(outcome).toBeInstanceOf(OffThreadReadBusyError);
    // Terminated, but bun:sqlite cannot interrupt them: they still hold the pool's places, and no thread is added.
    expect(readPoolThreadsForTests()).toEqual({ live: 0, stopping: READ_POOL_SIZE });
    await clock.advance(1_000);
    expect(await tooSoon).toBeInstanceOf(OffThreadReadBusyError);
    expect(started).toHaveLength(READ_POOL_SIZE);
    // When a stuck thread stops, its place goes to the next query.
    expect(((await next) as { c: number }).c).toBe(3);
    expect(readPoolThreadsForTests().live + readPoolThreadsForTests().stopping).toBeLessThanOrEqual(READ_POOL_SIZE);
  });

  test('a thread that cannot start makes the query busy at its deadline, and the next start is tried again', async () => {
    const path = storeFile();
    const clock = createTestClock();
    setReadPoolClockForTests(clock);
    let attempts = 0;
    setReadPoolWorkerFactoryForTests(() => {
      attempts += 1;
      throw new Error('no thread');
    });
    const refused = readOnPool(path, COUNT, { deadlineAtMs: clock.now() + 1_000 }).then(() => 'answered', (error) => error);
    await clock.advance(1_000);
    expect(await refused).toBeInstanceOf(OffThreadReadBusyError);
    expect(attempts).toBeGreaterThan(0);
    // Not remembered: once threads can start again, the pool reads.
    setReadPoolWorkerFactoryForTests();
    expect(((await readOnPool(path, COUNT, { deadlineAtMs: clock.now() + 60_000 })) as { c: number }).c).toBe(3);
  });

  test('a store search whose thread cannot start is busy, and reads nothing on the request thread', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-read-pool-store-'));
    roots.push(root);
    const store = new LocalConnectorStore({ dbPath: join(root, 'files.sqlite'), corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' });
    try {
      const clock = createTestClock();
      setReadPoolClockForTests(clock);
      setReadPoolWorkerFactoryForTests(() => { throw new Error('no thread'); });
      const db = (store as unknown as { db: { query: (sql: string) => unknown } }).db;
      const original = db.query;
      let fts = 0;
      db.query = (sql: string) => {
        if (sql.includes('connector_store_fts')) fts += 1;
        return original.call(db, sql);
      };
      const search = store.searchItemsDetailedOffThread('orchard', 10, undefined, undefined, {}, { deadlineAtMs: clock.now() + 1_000 })
        .then(() => 'answered', (error) => error);
      await clock.advance(1_000);
      expect(await search).toBeInstanceOf(OffThreadReadBusyError);
      expect(fts).toBe(0);
      db.query = original;
    } finally {
      store.close();
    }
  });

  test('a deadline is checked when the query is sent and when its rows come back, not only by its timer', async () => {
    const path = storeFile();
    const clock = createTestClock();
    setReadPoolClockForTests(clock);
    const sent: string[] = [];
    setReadPoolObserverForTests((_, read) => sent.push(read.sql));
    // Rows that come back after the deadline: the clock moves past it without the timer firing.
    const late = readOnPool(path, COUNT, { deadlineAtMs: clock.now() + 1_000 }).then(() => 'answered', (error) => error);
    clock.set(clock.now() + 5_000);
    expect(await late).toBeInstanceOf(OffThreadReadBusyError);

    // A query whose deadline passed while it waited for a thread is never sent.
    shutdownReadPool();
    await waitFor(() => readPoolThreadsForTests().live + readPoolThreadsForTests().stopping === 0, { description: 'the pool stopped' });
    setReadPoolWorkerFactoryForTests(() => { throw new Error('no thread yet'); });
    const waited = readOnPool(path, COUNT, { deadlineAtMs: clock.now() + 1_000 }).then(() => 'answered', (error) => error);
    clock.set(clock.now() + 5_000);
    setReadPoolWorkerFactoryForTests();
    const after = await readOnPool(path, COUNT, { deadlineAtMs: clock.now() + 60_000 });
    expect((after as { c: number }).c).toBe(3);
    expect(await waited).toBeInstanceOf(OffThreadReadBusyError);
    expect(sent.filter((sql) => sql === COUNT.sql)).toHaveLength(2);
  });

  test("closing a store releases the pool's connections to its file", async () => {
    if (!existsSync('/proc/self/fd')) return;
    const root = mkdtempSync(join(tmpdir(), 'olympus-read-pool-release-'));
    roots.push(root);
    const path = join(root, 'files.sqlite');
    const openOn = () => readdirSync('/proc/self/fd').filter((fd) => {
      try { return readlinkSync(`/proc/self/fd/${fd}`) === path; } catch { return false; }
    }).length;
    const store = new LocalConnectorStore({ dbPath: path, corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' });
    await store.searchItemsDetailedOffThread('orchard', 10);
    expect(openOn()).toBeGreaterThan(1);
    store.close();
    await waitFor(() => openOn() === 0, { description: 'every connection to the closed store released' });
  });

  test('a status snapshot waits for a thread no search runs on: a search past its deadline does not take the snapshot down with it', async () => {
    const path = storeFile();
    const clock = createTestClock();
    setReadPoolClockForTests(clock);
    const started: string[] = [];
    setReadPoolObserverForTests((_, read) => started.push(read.sql));
    const stuck = Array.from({ length: READ_POOL_SIZE }, () => readOnPool(path, SLOW, { deadlineAtMs: clock.now() + 1_000 }).then(() => 'answered', (error) => error));
    await waitFor(() => started.length === READ_POOL_SIZE, { description: 'both slow queries running' });
    const snapshot = withOffThreadSnapshot(path, async (read) => read(COUNT));
    await clock.advance(1_000);
    for (const outcome of await Promise.all(stuck)) expect(outcome).toBeInstanceOf(OffThreadReadBusyError);
    expect(((await snapshot) as { c: number }).c).toBe(3);
  });

  test("closing a store cancels its waiting queries and no search reopens it", async () => {
    const busyPath = storeFile();
    const root = mkdtempSync(join(tmpdir(), 'olympus-read-pool-closing-'));
    roots.push(root);
    const path = join(root, 'files.sqlite');
    const store = new LocalConnectorStore({ dbPath: path, corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' });
    const sent: string[] = [];
    setReadPoolObserverForTests((dbPath) => sent.push(dbPath));
    // Both threads busy on another store: the closing store's search waits in its queue.
    const holders = Array.from({ length: READ_POOL_SIZE }, () => readOnPool(busyPath, SLOW));
    await waitFor(() => sent.length === READ_POOL_SIZE, { description: 'both threads busy' });
    const waiting = store.searchItemsDetailedOffThread('orchard', 10).then(() => 'answered', (error) => error);
    store.close();
    expect(await waiting).toBeInstanceOf(OffThreadReadBusyError);
    await Promise.all(holders);
    // A search started after the close never reaches the pool either.
    expect(await store.searchItemsDetailedOffThread('orchard', 10).then(() => 'answered', (error) => error)).toBeInstanceOf(OffThreadReadBusyError);
    expect(sent.filter((dbPath) => dbPath === path)).toEqual([]);
  });

  test('with every pool place held by stopping threads, a store status waits for the pool and reads nothing on the request thread', async () => {
    const busyPath = storeFile();
    const root = mkdtempSync(join(tmpdir(), 'olympus-read-pool-status-'));
    roots.push(root);
    const store = new LocalConnectorStore({ dbPath: join(root, 'files.sqlite'), corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' });
    try {
      const clock = createTestClock();
      setReadPoolClockForTests(clock);
      const started: string[] = [];
      setReadPoolObserverForTests((_, read) => started.push(read.sql));
      const stuck = Array.from({ length: READ_POOL_SIZE }, () => readOnPool(busyPath, SLOW, { deadlineAtMs: clock.now() + 1_000 }).then(() => 'answered', (error) => error));
      await waitFor(() => started.length === READ_POOL_SIZE, { description: 'both slow queries running' });
      await clock.advance(1_000);
      for (const outcome of await Promise.all(stuck)) expect(outcome).toBeInstanceOf(OffThreadReadBusyError);
      expect(readPoolThreadsForTests()).toEqual({ live: 0, stopping: READ_POOL_SIZE });
      const db = (store as unknown as { db: { query: (sql: string) => unknown } }).db;
      const original = db.query;
      let here = 0;
      // The store's whole-store counts (statusSteps): read on the pool, never here.
      db.query = (sql: string) => {
        if (sql.includes('WITH flags AS MATERIALIZED')) here += 1;
        return original.call(db, sql);
      };
      const status = await store.statusOffThread();
      db.query = original;
      expect(status.counts.items).toBe(0);
      expect(here).toBe(0);
    } finally {
      store.close();
    }
  });
});

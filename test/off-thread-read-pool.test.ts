// The read pool behind the Ask keyword search (#1079): a query past its
// deadline retains only its store's executor until SQLite ends, a thread that
// cannot be stopped keeps its place until it has stopped, a thread that
// cannot start makes the lane busy (never a read on the request thread), a
// deadline is checked when a query is sent and when its rows come back, and a
// closed store's pool connections are released.

import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { withSourceIndexReadProgress } from '../src/core/source-index/read-progress.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  BACKGROUND_READS,
  OffThreadReadBusyError,
  readInBackground,
  openOffThreadSnapshot,
  READ_POOL_RESCORE_READERS,
  READ_POOL_SIZE,
  readOnPool,
  readPoolDiagnostics,
  readPoolMemoryCounts,
  sampleReadPoolMemory,
  readPoolThreadsForTests,
  releaseOffThreadReads,
  setReadPoolClockForTests,
  setReadPoolObserverForTests,
  setReadPoolLostReplyCheckForTests,
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
  setReadPoolLostReplyCheckForTests();
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
// deadline gives its result up; the warm thread becomes free when it ends.
const SLOW: StoreRead = {
  mode: 'get',
  sql: 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000000) SELECT COUNT(*) AS c FROM n',
  params: [],
};
const COUNT: StoreRead = { mode: 'get', sql: 'SELECT COUNT(*) AS c FROM items', params: [] };

// A real reader thread whose replies this thread never receives while
// `drop` says so: Bun can lose a Worker's reply this way (16 Nov trace: the
// reader posted reply 145, the request thread never got it).
function losingReplies(drop: (reply: { id?: number; diagnostic?: string; rows?: unknown }, worker: number) => boolean): () => void {
  let made = 0;
  setReadPoolWorkerFactoryForTests((url) => {
    const real = new Worker(url);
    const worker = made++;
    return new Proxy(real, {
      set(target, key, value) {
        if (key === 'onmessage') {
          target.onmessage = (event: MessageEvent) => { if (!drop(event.data, worker)) value(event); };
          return true;
        }
        return Reflect.set(target, key, value);
      },
      get(target, key) {
        const field = Reflect.get(target, key);
        return typeof field === 'function' ? field.bind(target) : field;
      },
    });
  });
  return () => setReadPoolWorkerFactoryForTests();
}

describe('read pool', () => {
  test('memory counts include idle snapshot connections and retiring workers until close', async () => {
    const path = storeFile();
    expect(readPoolMemoryCounts()).toEqual({ read_workers: 0, read_connections: 0 });
    // The connection total lives in shared memory, independent of diagnostic replies.
    losingReplies(reply => reply.diagnostic === 'open');
    await readOnPool(path, COUNT);
    const first = await openOffThreadSnapshot(path);
    const second = await openOffThreadSnapshot(path);
    expect(readPoolMemoryCounts()).toEqual({ read_workers: 1, read_connections: 3 });
    await first.close(); await second.close();
    expect(readPoolMemoryCounts()).toEqual({ read_workers: 1, read_connections: 3 });
    await waitFor(() => sampleReadPoolMemory(false).read_heap_workers === 1, { description: 'idle reader heap report' });
    const front = sampleReadPoolMemory(false);
    expect(front.read_heap_size_mb).toBeGreaterThan(0);
    expect(front.read_extra_memory_mb).toBeGreaterThanOrEqual(0);
    expect(front.read_array_buffers_mb).toBeGreaterThanOrEqual(0);
    expect(front).not.toHaveProperty('sqlite_read_connections_sampled');
    await waitFor(() => sampleReadPoolMemory().sqlite_read_connections_sampled === 3, { description: 'idle reader memory report' });
    const memory = sampleReadPoolMemory();
    expect(memory.read_heap_workers).toBe(1);
    expect(memory.read_heap_size_mb).toBeGreaterThan(0);
    using db = new Database(path, { readonly: true });
    const [cacheSize] = db.query('PRAGMA cache_size').values()[0]! as number[];
    const [pageSize] = db.query('PRAGMA page_size').values()[0]! as number[];
    expect(memory.sqlite_read_cache_budget_mb).toBe(3 * (cacheSize! < 0 ? -1024 * cacheSize! : cacheSize! * pageSize!));
    shutdownReadPool();
    expect(readPoolMemoryCounts().read_workers).toBe(1);
    await waitFor(() => readPoolMemoryCounts().read_workers === 0, { description: 'memory counters release stopped readers' });
    expect(readPoolMemoryCounts()).toEqual({ read_workers: 0, read_connections: 0 });
    expect(sampleReadPoolMemory().read_heap_workers).toBe(0);
  });

  test('a scan snapshot runs on its own worker of the store, never queued behind a slow shared read', async () => {
    const path = storeFile();
    const started: string[] = [];
    setReadPoolObserverForTests((_, read) => started.push(read.sql));
    let slowDone = false;
    const slow = readOnPool(path, SLOW).then(() => { slowDone = true; });
    await waitFor(() => started.length === 1, { description: 'the slow shared read running' });
    const scanned = await withOffThreadSnapshot(path, async (read) => read(COUNT), { lane: 'scan' }) as { c: number };
    expect(scanned.c).toBe(3);
    expect(slowDone).toBe(false);
    expect(readPoolThreadsForTests().live).toBe(2);
    await slow;
    // Releasing the store stops both of its workers.
    releaseOffThreadReads(path);
    await waitFor(() => readPoolThreadsForTests().live === 0, { description: 'both workers released' });
  });

  test('an owner read never waits behind a slow background statement: finders and counts have their own worker', async () => {
    const path = storeFile();
    const started: string[] = [];
    setReadPoolObserverForTests((_, read) => started.push(read.sql), { snapshots: true });
    let slowDone = false;
    // A finder's long statement, and a background snapshot held open beside it.
    const slow = readInBackground(path, SLOW).then(() => { slowDone = true; });
    await waitFor(() => started.length === 1, { description: 'the slow background read running' });
    const owner = await readOnPool(path, COUNT) as { c: number };
    expect(owner.c).toBe(3);
    expect(slowDone).toBe(false);
    expect(readPoolThreadsForTests().live).toBe(2);
    // A second background read queues on the background worker, not the shared one.
    let queuedDone = false;
    const queued = withOffThreadSnapshot(path, async (read) => read(COUNT), BACKGROUND_READS).then(() => { queuedDone = true; });
    expect((await readOnPool(path, COUNT) as { c: number }).c).toBe(3);
    expect(queuedDone).toBe(false);
    expect(readPoolThreadsForTests().live).toBe(2);
    await Promise.all([slow, queued]);
    releaseOffThreadReads(path);
    await waitFor(() => readPoolThreadsForTests().live === 0, { description: 'both workers released' });
  }, 30_000);

  test('re-score side readers each take a worker of their own, and one more is refused rather than queued', async () => {
    const path = storeFile();
    const side = await Promise.all(Array.from({ length: READ_POOL_RESCORE_READERS }, () => openOffThreadSnapshot(path, { lane: 'rescore', noWait: true })));
    expect(readPoolThreadsForTests().live).toBe(READ_POOL_RESCORE_READERS);
    const counts = await Promise.all(side.map((reader) => reader.read(COUNT))) as Array<{ c: number }>;
    expect(counts.map((row) => row.c)).toEqual(side.map(() => 3));
    expect(await openOffThreadSnapshot(path, { lane: 'rescore', noWait: true }).then(() => 'opened', (error) => error)).toBeInstanceOf(OffThreadReadBusyError);
    await Promise.all(side.map((reader) => reader.close()));
    // Free again once closed.
    const again = await openOffThreadSnapshot(path, { lane: 'rescore', noWait: true });
    await again.close();
    expect(readPoolThreadsForTests().live).toBe(READ_POOL_RESCORE_READERS);
    releaseOffThreadReads(path);
    await waitFor(() => readPoolThreadsForTests().live === 0, { description: 'the side workers released' });
  });

  test('abandoned queries fail busy, retain their store executor until SQL ends, and the next query then runs', async () => {
    const path = storeFile();
    const clock = createTestClock();
    setReadPoolClockForTests(clock);
    const started: string[] = [];
    setReadPoolObserverForTests((_, read) => started.push(read.sql));
    const stuck = Array.from({ length: READ_POOL_SIZE }, () => readOnPool(path, SLOW, { deadlineAtMs: clock.now() + 1_000 }).then(() => 'answered', (error) => error));
    // Queued behind them: one that must wait out the stuck threads, one whose deadline comes first.
    const next = readOnPool(path, COUNT, { deadlineAtMs: clock.now() + 600_000 });
    const tooSoon = readOnPool(path, COUNT, { deadlineAtMs: clock.now() + 2_000 }).then(() => 'answered', (error) => error);
    await waitFor(() => started.length === READ_POOL_SIZE, { description: 'the store query running' });
    await clock.advance(1_000);
    for (const outcome of await Promise.all(stuck)) expect(outcome).toBeInstanceOf(OffThreadReadBusyError);
    // Abandoned results keep their live executor: no replacement or extra statement is started.
    expect(readPoolThreadsForTests()).toEqual({ live: READ_POOL_SIZE, stopping: 0 });
    await clock.advance(1_000);
    expect(await tooSoon).toBeInstanceOf(OffThreadReadBusyError);
    expect(started).toHaveLength(READ_POOL_SIZE);
    // When the statement ends, the SAME executor serves the next query.
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

  test('snapshots reuse their thread\'s connections instead of opening and closing one each, and still see each commit and a replaced file (olympus-ops#151)', async () => {
    const path = storeFile();
    const writer = new Database(path);
    try {
      for (let n = 0; n < 20; n++) {
        writer.run('INSERT INTO items VALUES (?)', [100 + n]);
        const seen = await withOffThreadSnapshot(path, async (read) => (await read(COUNT) as { c: number }).c);
        expect(seen).toBe(4 + n);
      }
    } finally { writer.close(); }
    // One query connection plus idle snapshot connections, not one per snapshot.
    expect(readPoolDiagnostics().stores[path]!.opens).toBeLessThanOrEqual(READ_POOL_SIZE * 3);
    const replacement = storeFile();
    rmSync(path);
    const moved = new Database(replacement);
    moved.exec('VACUUM INTO ' + "'" + path.replaceAll("'", "''") + "'");
    moved.close();
    expect(await withOffThreadSnapshot(path, async (read) => (await read(COUNT) as { c: number }).c)).toBe(3);
  });

  test('a status snapshot waits for a thread no search runs on: a search past its deadline does not take the snapshot down with it', async () => {
    const path = storeFile();
    const clock = createTestClock();
    setReadPoolClockForTests(clock);
    const started: string[] = [];
    setReadPoolObserverForTests((_, read) => started.push(read.sql));
    const stuck = Array.from({ length: READ_POOL_SIZE }, () => readOnPool(path, SLOW, { deadlineAtMs: clock.now() + 1_000 }).then(() => 'answered', (error) => error));
    await waitFor(() => started.length === READ_POOL_SIZE, { description: 'the store query running' });
    const snapshot = withOffThreadSnapshot(path, async (read) => read(COUNT));
    await clock.advance(1_000);
    for (const outcome of await Promise.all(stuck)) expect(outcome).toBeInstanceOf(OffThreadReadBusyError);
    expect(((await snapshot) as { c: number }).c).toBe(3);
  });

  test('a search takes its turn between the reads of an open snapshot instead of waiting for all of it (#1305)', async () => {
    const path = storeFile();
    const order: string[] = [];
    let search: Promise<unknown> | undefined;
    await withOffThreadSnapshot(path, async (read) => {
      await read(COUNT);
      search = readOnPool(path, COUNT).then((rows) => { order.push('search'); return rows; });
      // The scan yields between pages, as the vector scan does.
      await Promise.resolve();
      for (let page = 0; page < 3; page += 1) {
        await read(COUNT);
        order.push(`page ${page}`);
      }
    });
    expect(((await search) as { c: number }).c).toBe(3);
    expect(order.indexOf('search')).toBeLessThan(order.indexOf('page 2'));
  });

  test('a read that waited in the queue tells its lane when it starts, so a wait behind other reads is not silence', async () => {
    const path = storeFile();
    const sent: string[] = [];
    setReadPoolObserverForTests((_, read) => sent.push(read.sql));
    const holders = Array.from({ length: READ_POOL_SIZE }, () => readOnPool(path, SLOW));
    await waitFor(() => sent.length === READ_POOL_SIZE, { description: 'the store workers busy' });
    let reports = 0;
    const queued = withSourceIndexReadProgress(() => { reports += 1; }, () => readOnPool(path, COUNT));
    expect(reports).toBe(0);
    await queued;
    expect(reports).toBe(2); // once when it left the queue, once when its rows came back
    await Promise.all(holders);
  });

  test("closing a store cancels its waiting queries and no search reopens it", async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-read-pool-closing-'));
    roots.push(root);
    const path = join(root, 'files.sqlite');
    const store = new LocalConnectorStore({ dbPath: path, corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' });
    const sent: string[] = [];
    setReadPoolObserverForTests((dbPath) => sent.push(dbPath));
    // Its worker is busy: the closing store's search waits in its queue.
    const holders = Array.from({ length: READ_POOL_SIZE }, () => readOnPool(path, SLOW).catch(error => error));
    await waitFor(() => sent.length === READ_POOL_SIZE, { description: 'the store worker busy' });
    const waiting = store.searchItemsDetailedOffThread('orchard', 10).then(() => 'answered', (error) => error);
    store.close();
    expect(await waiting).toBeInstanceOf(OffThreadReadBusyError);
    for (const outcome of await Promise.all(holders)) expect(outcome).toBeInstanceOf(OffThreadReadBusyError);
    // A search started after the close never reaches the pool either.
    expect(await store.searchItemsDetailedOffThread('orchard', 10).then(() => 'answered', (error) => error)).toBeInstanceOf(OffThreadReadBusyError);
    expect(sent.filter((dbPath) => dbPath === path)).toHaveLength(1); // only the original slow SQL
  });

  test('with abandoned SQL in its worker, a store status waits and reads nothing on the request thread', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-read-pool-status-'));
    roots.push(root);
    const store = new LocalConnectorStore({ dbPath: join(root, 'files.sqlite'), corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal' });
    try {
      const clock = createTestClock();
      setReadPoolClockForTests(clock);
      const started: string[] = [];
      setReadPoolObserverForTests((_, read) => started.push(read.sql));
      const stuck = Array.from({ length: READ_POOL_SIZE }, () => readOnPool(join(root, 'files.sqlite'), SLOW, { deadlineAtMs: clock.now() + 1_000 }).then(() => 'answered', (error) => error));
      await waitFor(() => started.length === READ_POOL_SIZE, { description: 'the store query running' });
      await clock.advance(1_000);
      for (const outcome of await Promise.all(stuck)) expect(outcome).toBeInstanceOf(OffThreadReadBusyError);
      expect(readPoolThreadsForTests()).toEqual({ live: READ_POOL_SIZE, stopping: 0 });
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

  test("a store's release cancels its snapshots that wait for a thread or have one reserved but not yet open", async () => {
    const path = storeFile();
    const started: string[] = [];
    setReadPoolObserverForTests((_, read) => started.push(read.sql));
    // Reserved but not yet open: the release lands before the snapshot sends its open.
    const reserved = withOffThreadSnapshot(path, async (read) => read(COUNT)).then(() => 'answered', (error) => error);
    releaseOffThreadReads(path);
    expect(await reserved).toBeInstanceOf(OffThreadReadBusyError);
    // Waiting: this store's only worker runs SQL.
    const holders = Array.from({ length: READ_POOL_SIZE }, () => readOnPool(path, SLOW).catch(error => error));
    await waitFor(() => started.length === READ_POOL_SIZE, { description: 'the store worker busy' });
    const waiting = withOffThreadSnapshot(path, async (read) => read(COUNT)).then(() => 'answered', (error) => error);
    releaseOffThreadReads(path);
    expect(await waiting).toBeInstanceOf(OffThreadReadBusyError);
    for (const outcome of await Promise.all(holders)) expect(outcome).toBeInstanceOf(OffThreadReadBusyError);
    // The store, opened again, is read as usual.
    expect(((await withOffThreadSnapshot(path, async (read) => read(COUNT))) as { c: number }).c).toBe(3);
  });
});

describe('read transactions and checkpoints', () => {
  // A snapshot held across a walk pinned the WAL: no checkpoint could reset
  // it, and a ledger's WAL stood at 6 GB through a gate run (16 Nov).
  test('a background walk holds no read between its reads, so a checkpoint completes; a shared snapshot still holds one', async () => {
    const path = storeFile();
    const writer = new Database(path);
    const checkpointBetweenReads = async (lane: 'background' | 'shared', perRead?: boolean) => withOffThreadSnapshot(path, async (read) => {
      await read(COUNT);
      writer.exec('INSERT INTO items VALUES (4)');
      const result = writer.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
      await read(COUNT);
      return result.busy;
    }, { lane, ...(perRead ? { perRead } : {}) });
    expect(await checkpointBetweenReads('background')).toBe(0);
    expect(await checkpointBetweenReads('shared')).toBe(1);
    // An Ask's visibility reads ask for a transaction per read.
    expect(await checkpointBetweenReads('shared', true)).toBe(0);
    writer.close();
  });

  test('a lost reply to a snapshot open or a background read is retried once on a fresh worker, and counted', async () => {
    const path = storeFile();
    setReadPoolLostReplyCheckForTests(50);
    const before = readPoolDiagnostics();
    // The first worker never answers its first open.
    let lost = 0;
    losingReplies((reply, worker) => worker === 0 && reply.diagnostic === undefined && lost++ === 0);
    expect(((await readInBackground(path, COUNT)) as { c: number }).c).toBe(3);
    // Another store, so its walk starts a worker of its own: it loses a read's reply between reads.
    const other = storeFile();
    let reads = 0;
    losingReplies((reply, worker) => worker === 0 && reply.diagnostic === undefined && reply.rows !== null && reads++ === 1);
    const counts = await withOffThreadSnapshot(other, async (read) => [await read(COUNT), await read(COUNT), await read(COUNT)], BACKGROUND_READS);
    expect(counts.map((row) => (row as { c: number }).c)).toEqual([3, 3, 3]);
    const after = readPoolDiagnostics();
    expect(after.lostReplies - before.lostReplies).toBe(2);
    expect(after.retries - before.retries).toBe(2);
    expect(after.lateReplies - before.lateReplies).toBe(0);
  });

  test('a slow statement is never cut: only a reply the reader finished and never delivered counts as lost', async () => {
    const path = storeFile();
    setReadPoolLostReplyCheckForTests(50);
    const before = readPoolDiagnostics();
    // Runs for seconds, many checks long.
    expect(((await readInBackground(path, SLOW)) as { c: number }).c).toBe(10_000_000);
    const held = await withOffThreadSnapshot(path, async (read) => read(SLOW));
    expect((held as { c: number }).c).toBe(10_000_000);
    const after = readPoolDiagnostics();
    expect(after.lostReplies - before.lostReplies).toBe(0);
    expect(after.terminations - before.terminations).toBe(0);
  });

  test('a held snapshot whose read reply is lost fails at once rather than move to another state', async () => {
    const path = storeFile();
    setReadPoolLostReplyCheckForTests(50);
    let reads = 0;
    losingReplies((reply) => reply.diagnostic === undefined && reply.rows !== null && reads++ === 0);
    const failed = await withOffThreadSnapshot(path, async (read) => read(COUNT)).then(() => 'answered', (error) => error);
    expect(String(failed)).toContain('lost');
  });

  test("a pool query whose reply is lost runs again on a fresh worker and frees its store's executor", async () => {
    const path = storeFile();
    setReadPoolLostReplyCheckForTests(50);
    let lost = 0;
    losingReplies((reply, worker) => worker === 0 && reply.diagnostic === undefined && lost++ === 0);
    expect(((await readOnPool(path, COUNT, { deadlineAtMs: Date.now() + 60_000 })) as { c: number }).c).toBe(3);
    expect(((await readOnPool(path, COUNT, { deadlineAtMs: Date.now() + 60_000 })) as { c: number }).c).toBe(3);
  });
});

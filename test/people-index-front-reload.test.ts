import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPeopleIndex, type PeoplePerson } from '../src/core/people-index.ts';
import type { PeopleReadWorker } from '../src/core/people-read-worker.ts';
import { frontLoopSqlHealth, frontLoopSqlSites, resetFrontLoopSqlGuardForTests, watchFrontLoopSql } from '../src/core/front-loop-sql-guard.ts';
import { installMainThreadSqlTrace } from '../src/workers/connector-store/main-thread-sql-trace.ts';

// Real JSON payloads and SQLite pages: a fake clock cannot measure whether
// the loop turns. All databases, WALs and seed data live outside the checkout.
let dir: string;
let dbPath: string;
let writer: Database;
let front: LocalPeopleIndex | undefined;
const restores: Array<() => void> = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'people-front-reload-'));
  dbPath = join(dir, 'people.sqlite');
  const setup = new LocalPeopleIndex({ dbPath });
  setup.close();
  writer = new Database(dbPath);
  // A writer must be able to commit while the reader holds its snapshot.
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000');
  // Keep the bulk fixture's pages in cache until commit instead of churning
  // the small default SQLite cache while building the identity indexes.
  writer.exec('PRAGMA cache_size = -65536');
  // Bulk SQL avoids 80,000 JS-to-SQLite insert calls in the setup hook.
  writer.transaction(() => writer.exec(`
    WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM numbers WHERE n < 19999)
    INSERT INTO people_persons
      SELECT printf('person-%05d', n), 'Alexandra Person ' || n, 0, 1, 300,
        json_array('Linked by email address', 'Linked by your contacts') FROM numbers;
    WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM numbers WHERE n < 19999),
      providers(j) AS (VALUES (0), (1), (2))
    INSERT INTO people_identities
      SELECT 'sender:provider-' || j || ':alexandra.' || n || '@example.com', 'provider-' || j,
        'alexandra.' || n || '@example.com', 'Alexandra Person ' || n,
        json_array('email:alexandra.' || n || '@example.com', printf('phone:+1415%07d', n)),
        json_array('Alexandra Person ' || n, 'Alex Person ' || n, 'Александра ' || n),
        0, 100, printf('person-%05d', n),
        json_array('internal.account-' || j || '.messages', 'internal.archive-' || j), 'email'
      FROM numbers CROSS JOIN providers;
  `))();
});

afterEach(async () => {
  resetFrontLoopSqlGuardForTests();
  for (const restore of restores.splice(0)) restore();
  const reader = (front as unknown as ReloadInternals | undefined)?.readWorker;
  front?.close();
  await reader?.close();
  front = undefined;
});
afterAll(() => {
  writer?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Inspect private mechanics without adding a production diagnostics surface.
type ReloadInternals = {
  db: Database;
  readWorker: PeopleReadWorker;
  loadPeopleInTurns(reader: PeopleReadWorker): Promise<void>;
  setPeople(people: PeoplePerson[], bySender?: Map<string, PeoplePerson>): void;
};
async function openFront() {
  front = new LocalPeopleIndex({ dbPath, readOnly: true });
  // The worker establishes its own connection-local data_version baseline.
  await front.reloadIfChanged();
  return { index: front, internal: front as unknown as ReloadInternals };
}

// Await the actual worker I/O before asserting: Bun's promise rejection
// matcher can hold delivery of Worker messages while waiting for a rejection.
async function reloadFailure(index: LocalPeopleIndex): Promise<Error> {
  let error: unknown;
  try { await index.reloadIfChanged(); } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

/** Include the first and last tick so a wholly synchronous reload cannot pass. */
function measureGaps(work: () => void | Promise<void>): Promise<{ maxMs: number; ticks: number }> {
  return new Promise((resolve, reject) => {
    let last = performance.now();
    let maxMs = 0;
    let ticks = 0;
    let started = false;
    let done = false;
    const timer = setInterval(() => {
      const now = performance.now();
      maxMs = Math.max(maxMs, now - last);
      last = now;
      ticks += 1;
      if (done) {
        clearInterval(timer);
        resolve({ maxMs, ticks });
      } else if (!started) {
        started = true;
        Promise.resolve().then(work).then(() => { done = true; }, (error) => {
          clearInterval(timer);
          reject(error);
        });
      }
    }, 5);
  });
}

describe('front people reload', () => {
  test('unchanged data_version reads no people rows, including after a completed reload', async () => {
    const { index, internal } = await openFront();
    const read = spyOn(internal.readWorker, 'read');
    const check = spyOn(internal.readWorker, 'beginIfChanged');
    restores.push(() => { read.mockRestore(); check.mockRestore(); });
    const oldPeople = index.list();
    await index.reloadIfChanged();
    expect(read).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
    expect(index.list()).toBe(oldPeople);

    writer.exec('UPDATE people_persons SET item_count = item_count + 1 WHERE person_id = \'person-00000\'');
    await index.reloadIfChanged();
    expect(read.mock.calls.length).toBeGreaterThan(0);
    read.mockClear();
    await index.reloadIfChanged();
    expect(read).not.toHaveBeenCalled();
  });

  test('several changed reloads run zero people SQLite statements on the front loop after construction', async () => {
    installMainThreadSqlTrace();
    front = new LocalPeopleIndex({ dbPath, readOnly: true });
    watchFrontLoopSql({ mode: 'record', allowed: [], log: () => undefined });
    for (let i = 0; i < 3; i += 1) {
      writer.exec('UPDATE people_persons SET item_count = item_count + 1 WHERE person_id = \'person-00000\'');
      await front.reloadIfChanged();
    }
    await front.reloadIfChanged();
    // The writer is watched too, proving the trace is active in this process.
    expect(frontLoopSqlHealth()!.statements).toBe(3);
    expect(frontLoopSqlSites().filter(({ site }) => site.includes('people-index.ts'))).toEqual([]);
    console.log('people reload front-loop SQLite statements: 0 (3 changed reloads)');
  });

  test('a changed index yields between keyset pages and equals a synchronous load', async () => {
    const { index, internal } = await openFront();
    const sync = await measureGaps(() => index.reload());
    writer.exec('UPDATE people_persons SET display_name = \'Updated name\' WHERE person_id = \'person-10000\'');
    const originalSet = internal.setPeople.bind(internal);
    let swapMs = 0;
    let prepared = false;
    const swap = spyOn(internal, 'setPeople').mockImplementation((people, bySender) => {
      const start = performance.now();
      originalSet(people, bySender);
      swapMs = Math.max(swapMs, performance.now() - start);
      prepared = bySender !== undefined;
    });
    restores.push(() => swap.mockRestore());
    const async = await measureGaps(() => index.reloadIfChanged());
    console.log(`people reload (60,000 identities / 20,000 persons): sync gap=${sync.maxMs.toFixed(1)} ms; async gap=${async.maxMs.toFixed(1)} ms; swap=${swapMs.toFixed(3)} ms; ticks=${async.ticks}`);
    expect(async.ticks).toBeGreaterThan(2);
    expect(async.maxMs).toBeLessThan(250);
    expect(prepared).toBe(true);
    expect(swapMs).toBeLessThan(100);
    const loaded = index.list();
    swap.mockRestore();
    index.reload();
    expect(loaded).toEqual(index.list());
    expect(loaded).toHaveLength(20_000);
    expect(loaded.reduce((sum, person) => sum + person.identities.length, 0)).toBe(60_000);
    expect(index.citationName('provider-1', 'alexandra.10000@example.com')?.displayName).toBe('Updated name');
  });

  test('overlapping calls share a snapshot and coalesce a writer commit into one extra load', async () => {
    const { index, internal } = await openFront();
    const oldPeople = index.list();
    const oldSender = index.personForSender('provider-0', 'alexandra.10000@example.com');
    writer.exec('UPDATE people_persons SET display_name = \'First commit\' WHERE person_id = \'person-10000\'');
    const reader = internal.readWorker;
    const read = reader.read.bind(reader);
    const snapshots: PeoplePerson[][] = [];
    let pages = 0;
    let second: Promise<void> | undefined;
    let third: Promise<void> | undefined;
    const page = spyOn(reader, 'read').mockImplementation(async (sql, params) => {
      const rows = await read(sql, params);
      if (++pages === 1) {
        // The first SELECT has pinned the worker's transaction, not this thread's.
        expect(internal.db.inTransaction).toBe(false);
        expect(index.list()).toBe(oldPeople);
        expect(index.personForSender('provider-0', 'alexandra.10000@example.com')).toBe(oldSender);
        const versionBefore = await read<{ data_version: number }>('PRAGMA data_version');
        writer.transaction(() => {
          writer.exec('UPDATE people_persons SET display_name = \'Second commit\' WHERE person_id = \'person-10000\'');
          writer.exec('UPDATE people_identities SET names_json = \'["Second commit"]\' WHERE person_id = \'person-10000\'');
        })();
        // An in-snapshot version must not hide that newer commit after COMMIT.
        expect(await read('PRAGMA data_version')).toEqual(versionBefore);
        second = index.reloadIfChanged();
        third = index.reloadIfChanged();
      }
      return rows as never[];
    });
    const setPeople = internal.setPeople.bind(internal);
    const swap = spyOn(internal, 'setPeople').mockImplementation((people, bySender) => {
      setPeople(people, bySender);
      snapshots.push(index.list());
    });
    restores.push(() => { page.mockRestore(); swap.mockRestore(); });
    const first = index.reloadIfChanged();
    await first;
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(snapshots).toHaveLength(2);
    const firstPerson = snapshots[0]!.find((p) => p.personId === 'person-10000')!;
    expect(firstPerson.displayName).toBe('First commit');
    expect(firstPerson.identities.every((i) => i.names[0] !== 'Second commit')).toBe(true);
    const finalPerson = index.person('person-10000')!;
    expect(finalPerson.displayName).toBe('Second commit');
    expect(finalPerson.identities.every((i) => i.names[0] === 'Second commit')).toBe(true);
    expect(index.personForSender('provider-0', 'alexandra.10000@example.com')).toBe(finalPerson);
    await index.reloadIfChanged();
    expect(snapshots).toHaveLength(2);
  });

  test('a commit during a load is picked up even without another caller', async () => {
    const { index, internal } = await openFront();
    writer.exec('UPDATE people_persons SET item_count = item_count + 1 WHERE person_id = \'person-00000\'');
    const reader = internal.readWorker;
    const read = reader.read.bind(reader);
    let pages = 0;
    const page = spyOn(reader, 'read').mockImplementation(async (sql, params) => {
      const rows = await read(sql, params);
      if (++pages === 1) writer.exec('UPDATE people_persons SET display_name = \'No extra caller\' WHERE person_id = \'person-19999\'');
      return rows as never[];
    });
    const swap = spyOn(internal, 'setPeople');
    restores.push(() => { page.mockRestore(); swap.mockRestore(); });
    await index.reloadIfChanged();
    expect(swap).toHaveBeenCalledTimes(2);
    expect(index.person('person-19999')?.displayName).toBe('No extra caller');
  });

  test('a failed page rolls back, keeps the old maps, and permits a retry', async () => {
    const { index, internal } = await openFront();
    const oldPeople = index.list();
    const oldSender = index.personForSender('provider-0', 'alexandra.0@example.com');
    const key = 'sender:provider-0:alexandra.0@example.com';
    const original = writer.query('SELECT keys_json FROM people_identities WHERE identity_key = ?').get(key) as { keys_json: string };
    writer.query('UPDATE people_identities SET keys_json = ? WHERE identity_key = ?').run('{bad json', key);
    try {
      await reloadFailure(index);
      expect(internal.db.inTransaction).toBe(false);
      expect(index.list()).toBe(oldPeople);
      expect(index.personForSender('provider-0', 'alexandra.0@example.com')).toBe(oldSender);
    } finally {
      writer.query('UPDATE people_identities SET keys_json = ? WHERE identity_key = ?').run(original.keys_json, key);
    }
    await index.reloadIfChanged();
    expect(index.list()).not.toBe(oldPeople);
    expect(index.personForSender('provider-0', 'alexandra.0@example.com')).toEqual(oldSender);
  });

  test('a worker SQL failure rejects the reload and the next call starts a fresh reader', async () => {
    const { index, internal } = await openFront();
    const oldPeople = index.list();
    const reader = internal.readWorker;
    const read = reader.read.bind(reader);
    const page = spyOn(reader, 'read').mockImplementation(() => read('SELECT missing_people_column FROM people_persons') as Promise<never[]>);
    restores.push(() => page.mockRestore());
    writer.exec('UPDATE people_persons SET item_count = item_count + 1 WHERE person_id = \'person-00000\'');
    expect((await reloadFailure(index)).message).toContain('missing_people_column');
    expect(index.list()).toBe(oldPeople);
    expect(internal.readWorker).toBeUndefined();
    await index.reloadIfChanged();
    expect(internal.readWorker).not.toBe(reader);
    expect(index.list()).not.toBe(oldPeople);
  });

  test('an abruptly stopped worker rejects its pending request and permits a fresh reload', async () => {
    const { index, internal } = await openFront();
    const oldPeople = index.list();
    const reader = internal.readWorker;
    const thread = (reader as unknown as { worker: Worker }).worker;
    const check = reader.beginIfChanged.bind(reader);
    const begin = spyOn(reader, 'beginIfChanged').mockImplementation(() => {
      const pending = check();
      thread.terminate();
      return pending;
    });
    restores.push(() => begin.mockRestore());
    expect((await reloadFailure(index)).message).toContain('People reader stopped');
    expect(index.list()).toBe(oldPeople);
    await index.reloadIfChanged();
    expect(internal.readWorker).not.toBe(reader);
  });

  test('closing during a reload stops the worker, rejects the reload and never swaps', async () => {
    const { index, internal } = await openFront();
    const oldPeople = index.list();
    const reader = internal.readWorker;
    const read = reader.read.bind(reader);
    const page = spyOn(reader, 'read').mockImplementation(async (sql, params) => {
      const rows = await read(sql, params);
      index.close();
      front = undefined;
      return rows as never[];
    });
    restores.push(() => page.mockRestore());
    writer.exec('UPDATE people_persons SET item_count = item_count + 1 WHERE person_id = \'person-00000\'');
    expect((await reloadFailure(index)).message).toContain('People reader closed');
    expect(index.list()).toBe(oldPeople);
    expect(internal.readWorker).toBeUndefined();
    expect((await reloadFailure(index)).message).toContain('People index is closed');
  });
});

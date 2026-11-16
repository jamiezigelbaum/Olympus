import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPeopleIndex, type PeoplePerson } from '../src/core/people-index.ts';

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
  writer.exec('PRAGMA journal_mode = WAL');
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

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  front?.close();
  front = undefined;
});
afterAll(() => {
  writer?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Inspect private mechanics without adding a production diagnostics surface.
type ReloadInternals = {
  db: Database;
  loadPeopleInTurns(): Promise<void>;
  setPeople(people: PeoplePerson[], bySender?: Map<string, PeoplePerson>): void;
};
function openFront() {
  front = new LocalPeopleIndex({ dbPath, readOnly: true });
  return { index: front, internal: front as unknown as ReloadInternals };
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
    const { index, internal } = openFront();
    const query = spyOn(internal.db, 'query');
    restores.push(() => query.mockRestore());
    await index.reloadIfChanged();
    expect(query.mock.calls.filter(([sql]) => /FROM people_(persons|identities)/.test(sql))).toHaveLength(0);
    expect(query.mock.calls.some(([sql]) => sql === 'PRAGMA data_version')).toBe(true);

    writer.exec('UPDATE people_persons SET item_count = item_count + 1 WHERE person_id = \'person-00000\'');
    await index.reloadIfChanged();
    query.mockClear();
    await index.reloadIfChanged();
    expect(query.mock.calls.filter(([sql]) => /FROM people_(persons|identities)/.test(sql))).toHaveLength(0);
  });

  test('a changed index yields between keyset pages and equals a synchronous load', async () => {
    const { index, internal } = openFront();
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
    const { index, internal } = openFront();
    const oldPeople = index.list();
    const oldSender = index.personForSender('provider-0', 'alexandra.10000@example.com');
    writer.exec('UPDATE people_persons SET display_name = \'First commit\' WHERE person_id = \'person-10000\'');
    const load = internal.loadPeopleInTurns.bind(internal);
    const snapshots: PeoplePerson[][] = [];
    let loads = 0;
    let second: Promise<void> | undefined;
    let third: Promise<void> | undefined;
    const spy = spyOn(internal, 'loadPeopleInTurns').mockImplementation(async () => {
      loads += 1;
      const loading = load(); // Reads the first page and yields with BEGIN still open.
      if (loads === 1) {
        expect(internal.db.inTransaction).toBe(true);
        expect(index.list()).toBe(oldPeople);
        expect(index.personForSender('provider-0', 'alexandra.10000@example.com')).toBe(oldSender);
        writer.transaction(() => {
          writer.exec('UPDATE people_persons SET display_name = \'Second commit\' WHERE person_id = \'person-10000\'');
          writer.exec('UPDATE people_identities SET names_json = \'["Second commit"]\' WHERE person_id = \'person-10000\'');
        })();
        second = index.reloadIfChanged();
        third = index.reloadIfChanged();
      }
      await loading;
      snapshots.push(index.list());
    });
    restores.push(() => spy.mockRestore());
    const first = index.reloadIfChanged();
    await first;
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(loads).toBe(2);
    const firstPerson = snapshots[0]!.find((p) => p.personId === 'person-10000')!;
    expect(firstPerson.displayName).toBe('First commit');
    expect(firstPerson.identities.every((i) => i.names[0] !== 'Second commit')).toBe(true);
    const finalPerson = index.person('person-10000')!;
    expect(finalPerson.displayName).toBe('Second commit');
    expect(finalPerson.identities.every((i) => i.names[0] === 'Second commit')).toBe(true);
    expect(index.personForSender('provider-0', 'alexandra.10000@example.com')).toBe(finalPerson);
    await index.reloadIfChanged();
    expect(loads).toBe(2);
  });

  test('a commit during a load is picked up even without another caller', async () => {
    const { index, internal } = openFront();
    writer.exec('UPDATE people_persons SET item_count = item_count + 1 WHERE person_id = \'person-00000\'');
    const load = internal.loadPeopleInTurns.bind(internal);
    let loads = 0;
    const spy = spyOn(internal, 'loadPeopleInTurns').mockImplementation(async () => {
      loads += 1;
      const loading = load();
      if (loads === 1) writer.exec('UPDATE people_persons SET display_name = \'No extra caller\' WHERE person_id = \'person-19999\'');
      await loading;
    });
    restores.push(() => spy.mockRestore());
    await index.reloadIfChanged();
    expect(loads).toBe(2);
    expect(index.person('person-19999')?.displayName).toBe('No extra caller');
  });

  test('a failed page rolls back, keeps the old maps, and permits a retry', async () => {
    const { index, internal } = openFront();
    const oldPeople = index.list();
    const oldSender = index.personForSender('provider-0', 'alexandra.0@example.com');
    const key = 'sender:provider-0:alexandra.0@example.com';
    const original = writer.query('SELECT keys_json FROM people_identities WHERE identity_key = ?').get(key) as { keys_json: string };
    writer.query('UPDATE people_identities SET keys_json = ? WHERE identity_key = ?').run('{bad json', key);
    try {
      await expect(index.reloadIfChanged()).rejects.toThrow();
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
});

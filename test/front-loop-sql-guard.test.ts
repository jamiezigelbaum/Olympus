// The engine front is to run no SQLite on its loop thread
// (src/core/front-loop-sql-guard.ts; freeze-proof design, 16 Nov 2026).
//
// Until the last statement has moved off the loop, the front records: every
// statement is counted, and from source each call site is checked against
// config/front-loop-sql-allowance.json. That list only shrinks: the ceilings
// below go down with it and never up. The product never throws; whether it
// ever will is decided after 1.5.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrontLoopSqlError, frontLoopSqlHealth, frontLoopSqlSites, resetFrontLoopSqlGuardForTests, watchFrontLoopSql } from '../src/core/front-loop-sql-guard.ts';
import { installMainThreadSqlTrace } from '../src/workers/connector-store/main-thread-sql-trace.ts';

const ROOT = join(import.meta.dir, '..');
/** Sites still allowed per family. Lower a number when you delete lines; never raise one. */
// Seeded 16 Nov 2026 from three measured runs (an installed store, a 40k gate store and a fresh install).
const CEILINGS = { A: 17, B: 39, C: 16 } as const;

const roots: string[] = [];
afterEach(() => {
  resetFrontLoopSqlGuardForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fileDb(): Database {
  const root = mkdtempSync(join(tmpdir(), 'olympus-front-loop-sql-'));
  roots.push(root);
  installMainThreadSqlTrace();
  const db = new Database(join(root, 'store.sqlite'));
  db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)');
  return db;
}

describe('SQLite on the front\'s loop', () => {
  test('recorded: every statement is counted, and a call site off the list is logged once and kept for health', () => {
    const db = fileDb();
    const lines: string[] = [];
    watchFrontLoopSql({ mode: 'record', allowed: [], log: (line) => lines.push(line) });
    const read = () => db.query('SELECT count(*) AS n FROM item').get();
    read(); read();
    db.exec('INSERT INTO item (name) VALUES (\'one\')');
    const health = frontLoopSqlHealth()!;
    expect(health).toMatchObject({ mode: 'record', statements: 3 });
    expect(health.unlisted!.length).toBe(health.sites!);
    expect(lines).toHaveLength(health.sites!);
    expect(lines[0]).toMatch(/^\[olympus\] front loop sql: unlisted site /);
    expect(frontLoopSqlSites().reduce((sum, site) => sum + site.statements, 0)).toBe(3);
    db.close();
  });

  test('a listed call site is counted and not reported', () => {
    const db = fileDb();
    const read = () => db.query('SELECT count(*) AS n FROM item').get();
    watchFrontLoopSql({ mode: 'record', allowed: [], log: () => undefined });
    read();
    const [site] = frontLoopSqlHealth()!.unlisted!;
    const lines: string[] = [];
    watchFrontLoopSql({ mode: 'record', allowed: [site!], log: (line) => lines.push(line) });
    read();
    expect(frontLoopSqlHealth()).toEqual({ mode: 'record', statements: 1, sites: 1, unlisted: [] });
    expect(lines).toEqual([]);
    db.close();
  });

  test('a packaged engine has no list: statements are counted and no site is named', () => {
    const db = fileDb();
    watchFrontLoopSql({ mode: 'record', log: () => { throw new Error('nothing to log'); } });
    db.query('SELECT count(*) AS n FROM item').get();
    expect(frontLoopSqlHealth()).toEqual({ mode: 'record', statements: 1 });
    db.close();
  });

  test('throw mode: a statement on a file throws at the call; a :memory: database is the caller\'s own', () => {
    const db = fileDb();
    const statement = db.query('SELECT count(*) AS n FROM item');
    watchFrontLoopSql({ mode: 'throw' });
    let thrown: unknown;
    try { statement.get(); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(FrontLoopSqlError);
    expect((thrown as FrontLoopSqlError).code).toBe('front_loop_sql');
    expect((thrown as Error).message).toContain('ran SQLite on its loop');
    expect(() => db.exec('DELETE FROM item')).toThrow(FrontLoopSqlError);
    const memory = new Database(':memory:');
    memory.exec('CREATE TABLE t (n INTEGER)');
    expect(memory.query('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
    memory.close();
    resetFrontLoopSqlGuardForTests();
    db.close();
  });

  test('not a front: nothing is watched', () => {
    const db = fileDb();
    db.query('SELECT 1').get();
    expect(frontLoopSqlHealth()).toBeUndefined();
    db.close();
  });
});

describe('the list of sites still on the front\'s loop', () => {
  const list = JSON.parse(readFileSync(join(ROOT, 'config/front-loop-sql-allowance.json'), 'utf8')) as { sites: Record<string, string[]> };

  test('only shrinks: each family is at or under its ceiling, and the ceiling is not above what is listed', () => {
    expect(Object.keys(list.sites).sort()).toEqual(['A', 'B', 'C']);
    for (const [family, ceiling] of Object.entries(CEILINGS)) {
      // Deleted lines without lowering the ceiling would let them come back.
      expect(`${family}: ${list.sites[family]!.length}`).toBe(`${family}: ${ceiling}`);
    }
  });

  test('names each site once, in the trace\'s words', () => {
    const all = Object.values(list.sites).flat();
    expect(new Set(all).size).toBe(all.length);
    for (const site of all) expect(site).toMatch(/^.+ [\w.-]+\.ts( < .+ [\w.-]+\.ts)?$/);
  });
});

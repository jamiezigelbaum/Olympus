import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SQLITE_STATEMENT_CACHE_SIZE } from '../src/core/sqlite-statement-cache.ts';
import { iterateRows } from '../src/core/sqlite-rows.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('sqlite statement cache', () => {
  test('a connection keeps compiled statements past its first few hundred queries', () => {
    const db = new Database(':memory:');
    for (let i = 0; i < 300; i += 1) db.query(`SELECT ${i} AS n`);
    const sql = 'SELECT 1 AS late';
    expect(db.query(sql)).toBe(db.query(sql));
    db.close();
  });

  test('the Bun-run entries raise the limit', () => {
    for (const entry of ['src/cli.ts', 'scripts/source-embedding-drain.ts']) {
      expect(readFileSync(join(import.meta.dir, '..', entry), 'utf8')).toContain('sqlite-statement-cache.ts');
    }
    expect((Database as unknown as { MAX_QUERY_CACHE_SIZE: number }).MAX_QUERY_CACHE_SIZE).toBeGreaterThanOrEqual(SQLITE_STATEMENT_CACHE_SIZE);
  });

  test('a stream left early can be streamed again', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (a INTEGER)');
    for (let i = 0; i < 10; i += 1) db.run('INSERT INTO t VALUES (?)', [i]);
    const sql = 'SELECT a FROM t WHERE a >= ? ORDER BY a';
    const first = (): number | undefined => {
      for (const row of iterateRows<{ a: number }>(db, sql, 0)) return row.a;
      return undefined;
    };
    expect(first()).toBe(0);
    expect([...iterateRows<{ a: number }>(db, sql, 5)].map((row) => row.a)).toEqual([5, 6, 7, 8, 9]);
    db.close();
  });

  test('rows are streamed only through iterateRows', () => {
    const offenders = sourceFiles(join(import.meta.dir, '..', 'src'))
      .filter((path) => !path.endsWith('sqlite-rows.ts'))
      .filter((path) => /\.iterate\(/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

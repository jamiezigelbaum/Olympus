import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SQLITE_STATEMENT_CACHE_SIZE } from '../src/core/sqlite-statement-cache.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';

describe('sqlite statement cache', () => {
  test('a connection keeps compiled statements past its first few hundred queries', () => {
    const db = new Database(':memory:');
    for (let i = 0; i < 300; i += 1) db.query(`SELECT ${i} AS n`);
    const sql = 'SELECT 1 AS late';
    expect(db.query(sql)).toBe(db.query(sql));
    db.close();
  });

  test('the hot stores load the raised limit', () => {
    expect(TierLedger).toBeDefined();
    expect(LocalConnectorStore).toBeDefined();
    expect((Database as unknown as { MAX_QUERY_CACHE_SIZE: number }).MAX_QUERY_CACHE_SIZE).toBeGreaterThanOrEqual(SQLITE_STATEMENT_CACHE_SIZE);
  });
});

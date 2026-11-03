// An item lookup by identity must use the stored normalized_conversation
// column, which the identity index covers. COALESCE(provider_conversation_id,
// '') = ? computes the same value but SQLite cannot use the index for it, so
// each lookup scans the account's every item. In settledUnreadableItems that
// held Sparta's worker 35-130 s at a time on every status publish (2026-11-03).

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dir, '..', 'src', 'workers', 'connector-store');
const UNINDEXED = /COALESCE\(\s*(?:\w+\.)?provider_conversation_id\s*,\s*''\s*\)\s*=\s*\?/;

describe('identity lookups use the identity index', () => {
  test('no connector-store query matches the conversation by expression', () => {
    const offenders = readdirSync(DIR).filter((name) => name.endsWith('.ts'))
      .filter((name) => UNINDEXED.test(readFileSync(join(DIR, name), 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('the stored column is what lets SQLite search the index on all four parts', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE items (item_pk INTEGER PRIMARY KEY, provider TEXT NOT NULL, account_scope TEXT NOT NULL,
      provider_item_id TEXT NOT NULL, provider_conversation_id TEXT,
      normalized_conversation TEXT GENERATED ALWAYS AS (COALESCE(provider_conversation_id, '')) STORED NOT NULL,
      UNIQUE(provider, account_scope, normalized_conversation, provider_item_id))`);
    const plan = (where: string) => (db.query(`EXPLAIN QUERY PLAN SELECT item_pk FROM items i WHERE ${where}`)
      .all('p', 'a', 'id', '') as { detail: string }[]).map((row) => row.detail).join(' ');
    expect(plan(`i.provider = ? AND i.account_scope = ? AND i.provider_item_id = ? AND i.normalized_conversation = ?`))
      .toContain('provider_item_id=?');
    expect(plan(`i.provider = ? AND i.account_scope = ? AND i.provider_item_id = ? AND COALESCE(i.provider_conversation_id, '') = ?`))
      .not.toContain('provider_item_id=?');
    db.close();
  });
});

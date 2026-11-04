// The one-query identity lookup must let the identities drive the join. With
// a scope filter naming the provider, SQLite once chose to walk every item of
// the provider and scan the whole identity list per item: on Sparta
// (2026-11-04) one status build held the worker for 796 s.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { identityRowsSql } from '../src/workers/connector-store/local-index.ts';

describe('identity lookup query plan', () => {
  for (const extra of ['', 'AND i.account_scope = ?', 'AND i.account_scope = ? AND i.provider = ?']) {
    test(`identities drive and probe the identity index (${extra || 'no filter'})`, () => {
      const store = new LocalConnectorStore({
        dbPath: join(mkdtempSync(join(tmpdir(), 'identity-plan-')), 'store.sqlite'),
        corpusId: 'secure_local.fakechat.messages',
        family: 'chat',
        trustDomain: 'secure_local',
      });
      try {
        const db = (store as unknown as { db: import('bun:sqlite').Database }).db;
        const params = extra.split('?').length - 1;
        const plan = (db.query(`EXPLAIN QUERY PLAN ${identityRowsSql(extra)}`)
          .all('[]', ...Array.from({ length: params }, () => 'x')) as Array<{ detail: string }>).map((row) => row.detail);
        expect(plan[0]).toStartWith('SCAN j');
        const items = plan.find((detail) => detail.includes(' i '));
        expect(items).toContain('SEARCH i USING');
        expect(items).toContain('provider_item_id=?');
      } finally {
        store.close();
      }
    });
  }
});

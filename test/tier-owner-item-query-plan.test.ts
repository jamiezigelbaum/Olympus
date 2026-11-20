import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { findOwnerTierItems, ownerTierItemId, setOwnerTierItem } from '../src/workers/classification/tier-owner-items.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { tempDir } from './helpers/tier-fixtures.ts';

function identityPlans(run: () => void): string[][] {
  const plans: string[][] = [];
  const query = Database.prototype.query;
  Database.prototype.query = function (this: Database, sql: string) {
    const statement = query.call(this, sql);
    if (/COALESCE\((?:i\.)?provider_conversation_id, ''\) = \?/.test(sql)) {
      // These equality predicates have the same plan for all bound values.
      const params = Array<SQLQueryBindings>(statement.paramsCount).fill(null);
      const plan = query.call(this, `EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
      plans.push(plan.map(({ detail }) => detail));
    }
    return statement;
  } as typeof query;
  try {
    run();
  } finally {
    Database.prototype.query = query;
  }
  return plans;
}

test('owner item changes and recent results probe the full store identity key', async () => {
  const { dir, cleanup } = tempDir('olympus-owner-item-plan-');
  const dbPath = join(dir, 'chat.sqlite');
  const provider = 'fixture-chat';
  const at = '2026-11-20T12:00:00.000Z';
  const items: RawItem[] = Array.from({ length: 3_000 }, (_, index) => ({
    identity: {
      family: 'chat', provider, accountScope: 'personal', providerItemId: 'shared-id',
      providerConversationId: `room-${index}`, localItemId: `message-${index}`,
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: `Fixture message ${index}` },
    metadata: {},
    fetchedAt: at,
  }));
  const connector: SourceConnector = {
    id: provider, family: 'chat',
    async authenticate() {},
    async *listItems() { yield { items, done: true }; },
    async fetchItem() { throw new Error('Fixture items already include content'); },
    classificationSignals() { return {}; },
  };
  try {
    const store = new LocalConnectorStore({
      dbPath, corpusId: 'internal.fixture.chat', family: 'chat', trustDomain: 'internal', tierLedger: null,
    });
    try {
      await store.syncFromConnector(connector, { fetchContent: true });
    } finally {
      store.close();
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query('SELECT COUNT(*) AS count FROM items').get()).toEqual({ count: items.length });
    } finally {
      db.close();
    }
    const itemId = ownerTierItemId(items[2_999]!.identity);
    const context = { storePaths: [dbPath] };
    const setPlans = identityPlans(() => {
      expect(setOwnerTierItem({ itemId, choice: 'private', allowLower: true }, context))
        .toMatchObject({ ok: true, item: { item_id: itemId } });
    });
    const findPlans = identityPlans(() => {
      expect(findOwnerTierItems({ recent: true, withPreview: true }, context).items)
        .toMatchObject([{ item_id: itemId, preview: 'Fixture message 2999' }]);
    });

    const itemSearch = expect.stringMatching(
      /^SEARCH (?:items|i) USING INDEX sqlite_autoindex_items_\d+ \(provider=\? AND account_scope=\? AND normalized_conversation=\? AND provider_item_id=\?\)$/,
    );
    const plans = [...setPlans, ...findPlans];
    expect(setPlans).toHaveLength(2);
    expect(findPlans).toHaveLength(3);
    expect(plans.map((plan) => plan[0])).toEqual(Array(5).fill(itemSearch));
    expect(plans.flat()).not.toContainEqual(expect.stringMatching(/^SCAN\b/));
  } finally {
    cleanup();
  }
});

test('owner item changes, recent results and previews read stores without the generated key', () => {
  const { dir, cleanup } = tempDir('olympus-owner-item-legacy-');
  const dbPath = join(dir, 'legacy.sqlite');
  try {
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE items (
          item_pk INTEGER PRIMARY KEY, provider TEXT, family TEXT, account_scope TEXT,
          provider_item_id TEXT, provider_conversation_id TEXT, local_item_id TEXT,
          title TEXT, locator_uri TEXT, tombstoned INTEGER
        );
        CREATE TABLE chunks (item_pk INTEGER, chunk_index INTEGER, bounded_text TEXT);
        INSERT INTO items VALUES (1, 'fixture-chat', 'chat', 'personal', 'item', NULL, 'local-item', 'Fixture title', NULL, 0);
        INSERT INTO chunks VALUES (1, 0, 'Fixture preview');
      `);
    } finally {
      db.close();
    }
    const itemId = ownerTierItemId({ provider: 'fixture-chat', accountScope: 'personal', providerItemId: 'item' });
    const context = { storePaths: [dbPath] };
    expect(setOwnerTierItem({ itemId, choice: 'private', allowLower: true }, context))
      .toMatchObject({ ok: true, item: { item_id: itemId, title: 'Fixture title' } });
    expect(findOwnerTierItems({ recent: true, withPreview: true }, context).items)
      .toMatchObject([{ item_id: itemId, title: 'Fixture title', preview: 'Fixture preview' }]);
  } finally {
    cleanup();
  }
});

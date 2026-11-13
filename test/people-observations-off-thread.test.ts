// The people index's sender read (#1305): it ran on the worker's main thread
// and read every full row of every authored store, about a minute on a large
// install. It now reads a covering index, on the store's read pool. The
// senders it reports must be exactly the ones the original single query
// reported, and a copy the tier ledger hides or holds must still name no one.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { SourceConnector } from '../src/core/contracts.ts';
import type { PeopleSenderObservation } from '../src/core/people-index.ts';
import { isSecureSensitivity, SOURCE_TRUST_TIERS } from '../src/core/source-index/types.ts';
import { setReadPoolObserverForTests, type StoreRead } from '../src/workers/connector-store/off-thread-reads.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  FIXTURE_PLACEMENT,
  fixtureConnector,
  openTierFixture,
  tempDir,
  type FixtureSpec,
} from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  setReadPoolObserverForTests(undefined);
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// The people query as it was before #1305, kept here as the oracle.
const ORACLE_SQL = `
  SELECT i.provider AS provider, i.sender_id AS sender_id, i.sender_label AS sender_label,
    i.provider_conversation_id AS conversation_id, i.trust_tier AS trust_tier,
    MAX(COALESCE(i.sender_is_owner, 0)) AS is_owner, COUNT(*) AS item_count
  FROM items i
  WHERE i.tombstoned = 0
    AND ((i.sender_id IS NOT NULL AND TRIM(i.sender_id) <> '') OR (i.sender_label IS NOT NULL AND TRIM(i.sender_label) <> ''))
    AND i.item_pk NOT IN (SELECT value FROM json_each(?))
  GROUP BY i.provider, i.sender_id, i.sender_label, i.provider_conversation_id, i.trust_tier`;

interface OracleRow {
  provider: string;
  sender_id: string | null;
  sender_label: string | null;
  conversation_id: string | null;
  trust_tier: string;
  is_owner: number;
  item_count: number;
}

function storeDb(store: LocalConnectorStore): Database {
  return (store as unknown as { db: Database }).db;
}

/** The original query and its per-sender roll-up, over the hidden and held copies the store sees now. */
function oracle(store: LocalConnectorStore): PeopleSenderObservation[] {
  const internals = store as unknown as {
    tierHiddenItemPks(): { hidden: number[]; held: number[] };
    corpusId: string;
    trustDomain: Parameters<typeof isSecureSensitivity>[0]['trustDomain'];
  };
  const tier = internals.tierHiddenItemPks();
  const rows = storeDb(store).query(ORACLE_SQL).all(JSON.stringify([...tier.hidden, ...tier.held])) as OracleRow[];
  const bySender = new Map<string, { observation: PeopleSenderObservation; conversations: Set<string>; anyPublic: boolean }>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.sender_id ?? ''}\u0000${row.sender_label ?? ''}`;
    let entry = bySender.get(key);
    if (!entry) {
      entry = {
        observation: {
          provider: row.provider,
          ...(row.sender_id?.trim() ? { senderId: row.sender_id.trim() } : {}),
          ...(row.sender_label?.trim() ? { senderLabel: row.sender_label.trim() } : {}),
          isOwner: false,
          itemCount: 0,
          corpusId: internals.corpusId,
        },
        conversations: new Set(),
        anyPublic: false,
      };
      bySender.set(key, entry);
    }
    entry.observation.isOwner ||= row.is_owner === 1;
    entry.observation.itemCount += row.item_count;
    if (row.conversation_id) entry.conversations.add(row.conversation_id);
    const tierName = SOURCE_TRUST_TIERS.find((candidate) => candidate === row.trust_tier);
    if (tierName && !isSecureSensitivity({ trustDomain: internals.trustDomain, trustTier: tierName })) entry.anyPublic = true;
  }
  return [...bySender.values()].map(({ observation, conversations, anyPublic }) => ({
    ...observation,
    ...(anyPublic ? {} : { privateOnly: true }),
    ...(conversations.size > 0 ? { conversationIds: [...conversations].sort() } : {}),
  }));
}

const bySenderKey = (a: PeopleSenderObservation, b: PeopleSenderObservation): number =>
  `${a.provider}|${a.senderId ?? ''}|${a.senderLabel ?? ''}`.localeCompare(`${b.provider}|${b.senderId ?? ''}|${b.senderLabel ?? ''}`);

const SENDERS = [
  { id: 'quinn@example.com', label: 'Quinn Holloway' },
  { id: 'ravi@example.com', label: 'Ravi Ostrander' },
  { id: 'sol@example.com', label: 'Sol Brennick' },
  { id: 'tam@example.com', label: 'Tam Ferreira' },
  { id: 'uma@example.com', label: 'Uma Calloway' },
  { id: 'vic@example.com', label: 'Vic Lindqvist' },
];
const ITEMS = 1_200;

function withSenders(connector: SourceConnector): SourceConnector {
  const tag = <T extends { identity: { providerItemId: string }; metadata: Readonly<Record<string, unknown>> }>(item: T): T => {
    const sender = SENDERS[Number(item.identity.providerItemId.replace(/\D/g, '')) % SENDERS.length]!;
    return { ...item, metadata: { ...item.metadata, senderId: sender.id, senderLabel: sender.label } };
  };
  return {
    ...connector,
    listItems(options) {
      const pages = connector.listItems(options);
      return (async function* () {
        for await (const page of pages) yield { ...page, items: page.items.map(tag) };
      })();
    },
    async fetchItem(localItemId) {
      return tag(await connector.fetchItem(localItemId));
    },
  };
}

async function senderFixture() {
  const { dir, cleanup } = tempDir('olympus-people-off-thread-');
  const fixture = openTierFixture(dir, { embed: false });
  cleanups.push(() => {
    fixture.close();
    cleanup();
  });
  const specs: FixtureSpec[] = Array.from({ length: ITEMS }, (_, n) => ({
    id: `m${n}`,
    name: `message-${n}.txt`,
    text: `message ${n} ${'with a body long enough to spill a little '.repeat(n % 7)}`,
    conversation: `chat-${n % 9}`,
  }));
  await fixture.set.sync(withSenders(fixtureConnector(() => specs)), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const store = fixture.stores.internal!;
  const db = storeDb(store);
  // The shapes the roll-up must keep apart or drop.
  db.exec(`
    UPDATE items SET tombstoned = 1 WHERE item_pk % 17 = 0;
    UPDATE items SET sender_id = NULL, sender_label = NULL WHERE item_pk % 23 = 0;
    UPDATE items SET sender_id = '   ', sender_label = '' WHERE item_pk % 29 = 0;
    UPDATE items SET sender_id = NULL WHERE item_pk % 31 = 0;
    UPDATE items SET sender_label = '  ' WHERE item_pk % 37 = 0;
    UPDATE items SET sender_is_owner = 1 WHERE sender_id = 'quinn@example.com' AND item_pk % 5 <> 0;
    UPDATE items SET trust_tier = 'S4' WHERE sender_id = 'ravi@example.com' AND item_pk % 5 = 0;
    UPDATE items SET trust_tier = 'S5' WHERE sender_id = 'sol@example.com';
  `);
  // Superseded, staged and held copies across several senders.
  const ledgerDb = (fixture.ledger as unknown as { db: Database }).db;
  ledgerDb.exec(`
    UPDATE tier_copies SET copy_state = 'superseded' WHERE rowid % 13 = 0;
    UPDATE tier_copies SET copy_state = 'staged' WHERE rowid % 19 = 0 AND copy_state = 'current';
    UPDATE tier_copies SET embed_hold = 1 WHERE rowid % 11 = 0 AND copy_state = 'current';
  `);
  return { fixture, store };
}

describe('people observations off the main thread (#1305)', () => {
  test('inline and off-thread observations equal the original query, hidden and held copies left out', async () => {
    const { store } = await senderFixture();
    const expected = oracle(store).sort(bySenderKey);
    // The fixture really has every shape: hidden and held copies, an owner, a private-only sender, several conversations.
    const tier = (store as unknown as { tierHiddenItemPks(): { hidden: number[]; held: number[] } }).tierHiddenItemPks();
    expect(tier.hidden.length).toBeGreaterThan(0);
    expect(tier.held.length).toBeGreaterThan(0);
    expect(expected.some((o) => o.isOwner)).toBe(true);
    expect(expected.some((o) => o.privateOnly)).toBe(true);
    expect(expected.some((o) => (o.conversationIds?.length ?? 0) > 1)).toBe(true);
    expect(expected.some((o) => o.senderId && !o.senderLabel)).toBe(true);
    expect(expected.some((o) => o.senderLabel && !o.senderId)).toBe(true);
    // A held or hidden copy's own count is not in any sender's total.
    const visible = (storeDb(store).query(`SELECT COUNT(*) AS n FROM items WHERE tombstoned = 0 AND (TRIM(COALESCE(sender_id, '')) <> '' OR TRIM(COALESCE(sender_label, '')) <> '')`).get() as { n: number }).n;
    expect(expected.reduce((sum, o) => sum + o.itemCount, 0)).toBeLessThan(visible);

    expect(store.peopleObservations().sort(bySenderKey)).toEqual(expected);
    expect((await store.peopleObservationsOffThread()).sort(bySenderKey)).toEqual(expected);
  }, 60_000);

  test('an item held while the pool reads names no one: the read is taken again', async () => {
    const { fixture, store } = await senderFixture();
    const db = storeDb(store);
    const ledgerDb = (fixture.ledger as unknown as { db: Database }).db;
    // One visible item gets a sender of its own.
    const visible = (store as unknown as { tierHiddenItemPks(): { hidden: number[]; held: number[] } }).tierHiddenItemPks();
    const excluded = new Set([...visible.hidden, ...visible.held]);
    const candidates = db.query(`SELECT item_pk, provider_item_id FROM items WHERE tombstoned = 0 ORDER BY item_pk`).all() as Array<{ item_pk: number; provider_item_id: string }>;
    const target = candidates.find((row) => !excluded.has(row.item_pk))!;
    db.query(`UPDATE items SET sender_id = 'zed@example.com', sender_label = 'Zed Marlow' WHERE item_pk = ?`).run(target.item_pk);
    expect((await store.peopleObservationsOffThread()).some((o) => o.senderId === 'zed@example.com')).toBe(true);

    // The item is held for classification after the hidden set was taken and before the pool reads.
    let reads = 0;
    setReadPoolObserverForTests(() => {
      reads += 1;
      if (reads === 1) ledgerDb.query(`UPDATE tier_copies SET embed_hold = 1 WHERE provider_item_id = ? AND copy_state = 'current'`).run(target.provider_item_id);
    });
    const after = await store.peopleObservationsOffThread();
    expect(after.some((o) => o.senderId === 'zed@example.com')).toBe(false);
    expect(reads).toBeGreaterThan(1);
    expect(after.sort(bySenderKey)).toEqual(oracle(store).sort(bySenderKey));
  }, 60_000);

  test('a store whose visibility moves during every pool read is read on this thread, held items still left out', async () => {
    const { fixture, store } = await senderFixture();
    const db = storeDb(store);
    const ledgerDb = (fixture.ledger as unknown as { db: Database }).db;
    const visible = (store as unknown as { tierHiddenItemPks(): { hidden: number[]; held: number[] } }).tierHiddenItemPks();
    const excluded = new Set([...visible.hidden, ...visible.held]);
    const candidates = db.query(`SELECT item_pk, provider_item_id FROM items WHERE tombstoned = 0 ORDER BY item_pk`).all() as Array<{ item_pk: number; provider_item_id: string }>;
    const target = candidates.find((row) => !excluded.has(row.item_pk))!;
    db.query(`UPDATE items SET sender_id = 'zed@example.com', sender_label = 'Zed Marlow' WHERE item_pk = ?`).run(target.item_pk);

    // A judging backlog: every pooled people read sees the ledger move (held,
    // released, held again). The hidden-child probe before each read runs on
    // the pool too (#1452); only the people reads are the attempts counted.
    let pooled = 0;
    setReadPoolObserverForTests((_path, read) => {
      if (!/GROUP BY/.test(read.sql)) return;
      pooled += 1;
      ledgerDb.query(`UPDATE tier_copies SET embed_hold = 1 - embed_hold WHERE provider_item_id = ? AND copy_state = 'current'`).run(target.provider_item_id);
    });
    const here: string[] = [];
    const original = db.query.bind(db);
    db.query = ((sql: string) => {
      if (/FROM items/.test(sql) && /GROUP BY/.test(sql)) here.push(sql);
      return original(sql);
    }) as typeof db.query;
    let observed: PeopleSenderObservation[];
    try {
      observed = await store.peopleObservationsOffThread();
    } finally {
      db.query = original;
    }
    expect(pooled).toBe(3);
    expect(here).toHaveLength(1);
    // Held after the third move: named by no one, and every other sender is back.
    expect(observed.some((o) => o.senderId === 'zed@example.com')).toBe(false);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.sort(bySenderKey)).toEqual(oracle(store).sort(bySenderKey));
  }, 60_000);

  test('a ledger write that changes no visibility does not push the read onto this thread (gate 1, ops#168)', async () => {
    const { fixture, store } = await senderFixture();
    const db = storeDb(store);
    // The sweep and the judge write the ledger every few seconds: meta, receipts, verdicts.
    let pooled = 0;
    setReadPoolObserverForTests((_path, read) => {
      if (!/GROUP BY/.test(read.sql)) return;
      pooled += 1;
      fixture.ledger.writeMeta('test-unrelated-write', String(pooled));
    });
    const here: string[] = [];
    const original = db.query.bind(db);
    db.query = ((sql: string) => {
      if (/FROM items/.test(sql) && /GROUP BY/.test(sql)) here.push(sql);
      return original(sql);
    }) as typeof db.query;
    let observed: PeopleSenderObservation[];
    try {
      observed = await store.peopleObservationsOffThread();
    } finally {
      db.query = original;
    }
    expect(pooled).toBe(1);
    expect(here).toEqual([]);
    expect(observed.sort(bySenderKey)).toEqual(oracle(store).sort(bySenderKey));
  }, 60_000);

  test('the people query reads a covering index', async () => {
    const { store } = await senderFixture();
    const db = storeDb(store);
    const sql = (store as unknown as { peopleObservationRead(excluded: number[]): StoreRead }).peopleObservationRead([1, 2, 3]);
    const plan = (db.query(`EXPLAIN QUERY PLAN ${sql.sql}`).all(...(sql.params as string[])) as Array<{ detail: string }>).map((row) => row.detail);
    expect(plan.some((detail) => /USING COVERING INDEX idx_connector_store_items_people/.test(detail))).toBe(true);
    expect(plan.some((detail) => /USE TEMP B-TREE FOR GROUP BY/.test(detail))).toBe(false);
  }, 60_000);

  test("a refresh's sender read goes through the read pool, and no items GROUP BY runs on the store's own connection", async () => {
    const { store } = await senderFixture();
    const pooled: string[] = [];
    setReadPoolObserverForTests((_dbPath, read) => pooled.push(read.sql));
    const db = storeDb(store);
    const original = db.query.bind(db);
    const here: string[] = [];
    db.query = ((sql: string) => {
      if (/FROM items/.test(sql) && /GROUP BY/.test(sql)) here.push(sql);
      return original(sql);
    }) as typeof db.query;
    try {
      await store.peopleObservationsOffThread();
    } finally {
      db.query = original;
    }
    expect(pooled.some((sql) => /FROM items/.test(sql) && /GROUP BY/.test(sql))).toBe(true);
    expect(here).toEqual([]);
  }, 60_000);
});

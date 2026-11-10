// Visibility kept in the store file (#858 option 1, docs/design/engine-split.md
// part 1). The writer saves its hidden-copy set in the store, stamped with the
// ledger and store feed cursors it covers, and the item change feed is a real
// table every connection's writes fill. A second connection (a read-only
// store) starts from the saved set and applies only the feed entries past it:
// it never rebuilds from scratch because the writer committed, and when a feed
// no longer holds the entries it needs it fails closed instead of guessing.
//
// The set decides what counts, aggregates, the vector-lane check and the
// embedding work lists leave out, exactly as before. It is never the
// authority for a returned row: every row a search returns is still checked
// against the current ledger, so a copy raised after the set was read never
// comes back.

import { Database } from 'bun:sqlite';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalConnectorStore, TierVisibilityNotCurrentError } from '../src/workers/connector-store/index.ts';
import { assertSqliteSchemaCanOpen } from '../src/core/sqlite-migrations.ts';
import type { TierLedger, TierLedgerIdentity } from '../src/workers/classification/tier-ledger.ts';
import {
  CORPORA,
  FIXTURE_PLACEMENT,
  fixtureConnector,
  localId,
  openTierFixture,
  tempDir,
  type FixtureSpec,
  type TierFixture,
} from './helpers/tier-fixtures.ts';

const MODEL = 'saved-set-fixture-model';

interface HiddenSet {
  hidden: number[];
  held: number[];
  heldForJudgment: number[];
  metadataLayer: number[];
  metadataLayerContentUnread: number[];
  moving: number;
}

interface Probe {
  db: Database;
  tierHiddenItemPks(): HiddenSet;
  visibilityLedger(): TierLedger | undefined;
}

const probe = (store: LocalConnectorStore) => store as unknown as Probe;
const sorted = (set: HiddenSet): HiddenSet => ({
  hidden: [...set.hidden].sort((a, b) => a - b),
  held: [...set.held].sort((a, b) => a - b),
  heldForJudgment: [...set.heldForJudgment].sort((a, b) => a - b),
  metadataLayer: [...set.metadataLayer].sort((a, b) => a - b),
  metadataLayerContentUnread: [...set.metadataLayerContentUnread].sort((a, b) => a - b),
  moving: set.moving,
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const SPECS: FixtureSpec[] = ['plain', 'hid', 'held', 'names', 'staged', 'late'].map((id) => ({
  id, name: `${id}.txt`, text: `Ordinary picnic notes about ${id}.`,
}));

/** Counts full rebuilds: a walk of the whole corpus asks the ledger for every copy (no identities). */
function countFullRebuilds(ledger: TierLedger): { readonly count: number; restore(): void } {
  let count = 0;
  const original = ledger.corpusVisibilityPages.bind(ledger);
  const spy = spyOn(ledger, 'corpusVisibilityPages').mockImplementation((corpusId: string, identities?: readonly TierLedgerIdentity[]) => {
    if (identities === undefined) count += 1;
    return original(corpusId, identities);
  });
  return { get count() { return count; }, restore: () => spy.mockRestore() };
}

/**
 * A fixture whose internal store holds one item in each state the set keeps:
 * hidden (superseded), held (pending judgment), names only (metadata layer), a
 * pending move's staged copy, and a child whose parent is hidden. Each
 * excluded item has a current vector; `plain` has none yet.
 */
async function fixtureWithEveryState(): Promise<{
  f: TierFixture;
  writer: LocalConnectorStore;
  ledgerDb: Database;
  storeDb: Database;
  pk: (id: string) => number;
  embed: (id: string) => void;
  addChild: (parent: string, child: string) => void;
  openReader: () => LocalConnectorStore;
}> {
  const { dir, cleanup } = tempDir();
  const f = openTierFixture(dir, { embed: false });
  cleanups.push(cleanup, () => f.close());
  await f.set.sync(fixtureConnector(() => SPECS.filter((spec) => spec.id !== 'late')), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const writer = f.stores.internal!;
  // Raw connections, as another process would write: the ledger's own repair
  // on open would undo a simulated pending hold.
  const ledgerDb = new Database(f.ledger.dbPath);
  const storeDb = new Database(f.paths.internal);
  cleanups.push(() => ledgerDb.close(), () => storeDb.close());
  storeDb.exec('PRAGMA busy_timeout = 10000;');
  const pk = (id: string) => (storeDb.query('SELECT item_pk AS pk FROM items WHERE local_item_id = ?').get(localId(id)) as { pk: number }).pk;
  const copy = (id: string, set: string) => ledgerDb.query(`UPDATE tier_copies SET ${set} WHERE provider_item_id = ? AND corpus_id = ?`)
    .run(id, CORPORA.internal);
  for (const spec of SPECS.filter((spec) => spec.id !== 'late')) {
    expect(ledgerDb.query('SELECT 1 FROM tier_copies WHERE provider_item_id = ? AND corpus_id = ?').get(spec.id, CORPORA.internal)).not.toBeNull();
  }
  copy('hid', "copy_state = 'superseded'");
  // A real pending hold: a hold with no pending judgment is repaired away by any ledger open.
  ledgerDb.query("UPDATE tier_items SET state = 'pending', content_pending = 1 WHERE provider_item_id = 'held'").run();
  copy('held', 'embed_hold = 1');
  copy('names', "layers = 'metadata'");
  copy('staged', "copy_state = 'staged'");
  ledgerDb.query("UPDATE tier_items SET state = 'moving' WHERE provider_item_id = 'staged'").run();
  // The child of the hidden item: a copy of its parent's row and chunk.
  const columns = (table: string, skip: string) => (storeDb.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name).filter((name) => name !== skip);
  const addChild = (parent: string, child: string) => {
    const itemColumns = columns('items', 'item_pk');
    const childValues: Record<string, string> = {
      provider_item_id: `'${child}'`, local_item_id: `'${localId(child)}'`, parent_local_item_id: `'${localId(parent)}'`,
    };
    storeDb.exec(`INSERT INTO items (${itemColumns.join(', ')})
      SELECT ${itemColumns.map((column) => childValues[column] ?? column).join(', ')} FROM items WHERE local_item_id = '${localId(parent)}'`);
    const chunkColumns = columns('chunks', 'chunk_pk');
    storeDb.exec(`INSERT INTO chunks (${chunkColumns.join(', ')})
      SELECT ${chunkColumns.map((column) => column === 'item_pk' ? String(pk(child)) : column).join(', ')}
      FROM chunks WHERE item_pk = ${pk(parent)}`);
  };
  addChild('hid', 'hid#child:photo');
  storeDb.exec('UPDATE chunks SET embedding_input_hash = content_hash WHERE embedding_input_hash IS NULL');
  const embed = (id: string) => storeDb.query(`INSERT OR REPLACE INTO chunk_embeddings (chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at)
    SELECT chunk_pk, ?, item_pk, embedding_input_hash, x'00000000', '2026-11-10T00:00:00Z' FROM chunks WHERE item_pk = ?`).run(MODEL, pk(id));
  for (const id of ['hid', 'held', 'names', 'staged', 'hid#child:photo']) embed(id);
  const openReader = () => {
    const reader = new LocalConnectorStore({ dbPath: f.paths.internal, corpusId: CORPORA.internal, family: 'file', trustDomain: 'internal', readOnly: true });
    cleanups.push(() => reader.close());
    return reader;
  };
  return { f, writer, ledgerDb, storeDb, pk, embed, addChild, openReader };
}

test('a second connection serves the saved set, applies the writer\'s later commits without a full rebuild, and excludes every kept state', async () => {
  const { f, writer, ledgerDb, pk, embed, openReader } = await fixtureWithEveryState();
  // The writer's set, built from scratch and saved in the store.
  const expected = sorted(probe(writer).tierHiddenItemPks());
  expect(expected.hidden).toEqual([pk('hid'), pk('staged'), pk('hid#child:photo')].sort((a, b) => a - b));
  expect(expected.held).toEqual([pk('held')]);
  expect(expected.metadataLayer).toEqual([pk('names')]);
  expect(expected.moving).toBe(1);
  expect(writer.hasEmbeddings(MODEL)).toBe(false);

  const reader = openReader();
  const rebuilds = countFullRebuilds(probe(reader).visibilityLedger()!);
  cleanups.push(() => rebuilds.restore());
  expect(sorted(probe(reader).tierHiddenItemPks())).toEqual(expected);
  // Hidden, held, names-only, staged and the hidden parent's child all have
  // vectors, and none of them switches the vector lane on.
  expect(reader.hasEmbeddings(MODEL)).toBe(false);
  expect(reader.status().counts).toEqual(writer.status().counts);
  expect(reader.status().tier).toEqual(writer.status().tier);
  // What stays allowed stays allowed: held content is still found by words.
  // Rows themselves are checked against the ledger, not the set.
  const found = (store: LocalConnectorStore) => store.searchItems('picnic', 20).map((row) => row.sourceItem.providerItemId).sort();
  expect(found(reader)).toEqual(found(writer));
  expect(found(reader)).toContain('held');
  expect(found(reader)).toContain('plain');
  expect(found(reader)).not.toContain('hid');
  expect(found(reader)).not.toContain('staged');

  // The writer commits between two reads: a vector (not visibility), then a
  // supersede on the ledger, then a new item.
  embed('plain');
  expect(reader.hasEmbeddings(MODEL)).toBe(true);
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'plain' AND corpus_id = ?").run(CORPORA.internal);
  expect(reader.hasEmbeddings(MODEL)).toBe(false);
  expect(probe(reader).tierHiddenItemPks().hidden).toContain(pk('plain'));
  await f.set.sync(fixtureConnector(() => SPECS), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  expect(reader.status().counts).toEqual(writer.status().counts);
  expect(sorted(probe(reader).tierHiddenItemPks())).toEqual(sorted(probe(writer).tierHiddenItemPks()));
  expect(found(reader)).toContain('late');
  expect(rebuilds.count).toBe(0);
});

test('a copy raised after the reader read its cursors is not returned by its next search', async () => {
  const { ledgerDb, openReader, writer } = await fixtureWithEveryState();
  probe(writer).tierHiddenItemPks();
  const reader = openReader();
  const ledger = probe(reader).visibilityLedger()!;
  const original = ledger.visibilityChangesSince.bind(ledger);
  let raised = false;
  const spy = spyOn(ledger, 'visibilityChangesSince').mockImplementation((after?: number) => {
    const changes = original(after);
    if (!raised) {
      raised = true;
      // Committed by another connection right after this reader's cursor read.
      ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'held' AND corpus_id = ?").run(CORPORA.internal);
    }
    return changes;
  });
  try {
    reader.hasEmbeddings(MODEL);
    expect(raised).toBe(true);
    expect(reader.searchItems('picnic', 20).map((row) => row.sourceItem.providerItemId)).not.toContain('held');
  } finally { spy.mockRestore(); }
});

test('a retention gap in either feed fails closed on a read-only connection until the writer saves again', async () => {
  const { ledgerDb, storeDb, openReader, writer } = await fixtureWithEveryState();
  probe(writer).tierHiddenItemPks();
  const reader = openReader();
  probe(reader).tierHiddenItemPks();

  // Ledger: more entries than its feed keeps, past both the reader's cursor and the saved stamp.
  ledgerDb.transaction(() => {
    for (let n = 0; n < 4_100; n++) ledgerDb.query("UPDATE tier_copies SET embed_hold = 0 WHERE provider_item_id = 'plain'").run();
  })();
  expect(() => probe(reader).tierHiddenItemPks()).toThrow(TierVisibilityNotCurrentError);
  expect(() => reader.hasEmbeddings(MODEL)).toThrow(TierVisibilityNotCurrentError);
  expect(() => reader.status()).toThrow(TierVisibilityNotCurrentError);
  // The writer rebuilds and saves; the reader is current again.
  const expected = sorted(probe(writer).tierHiddenItemPks());
  expect(sorted(probe(reader).tierHiddenItemPks())).toEqual(expected);

  // Store: more item writes than the item feed keeps.
  storeDb.transaction(() => {
    for (let n = 0; n < 33_000; n++) storeDb.query("UPDATE items SET tombstoned = 0 WHERE provider_item_id = 'plain'").run();
  })();
  expect(() => probe(reader).tierHiddenItemPks()).toThrow(TierVisibilityNotCurrentError);
  expect(sorted(probe(writer).tierHiddenItemPks())).toEqual(expected);
  expect(sorted(probe(reader).tierHiddenItemPks())).toEqual(expected);
}, 60_000);

test('a reopened writer starts from the saved set instead of rebuilding', async () => {
  const { f, writer, ledgerDb, pk } = await fixtureWithEveryState();
  const expected = sorted(probe(writer).tierHiddenItemPks());
  const rebuilds = countFullRebuilds(f.ledger);
  cleanups.push(() => rebuilds.restore());
  const again = new LocalConnectorStore({ dbPath: f.paths.internal, corpusId: CORPORA.internal, family: 'file', trustDomain: 'internal', tierLedger: f.ledger });
  cleanups.push(() => again.close());
  expect(sorted(probe(again).tierHiddenItemPks())).toEqual(expected);
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'plain' AND corpus_id = ?").run(CORPORA.internal);
  expect(probe(again).tierHiddenItemPks().hidden).toContain(pk('plain'));
  expect(rebuilds.count).toBe(0);
});

test('a read-only open of a store from before the saved set keeps the older full rebuild', async () => {
  const { f, writer, openReader } = await fixtureWithEveryState();
  const expected = sorted(probe(writer).tierHiddenItemPks());
  const counts = writer.status().counts;
  // Turn a copy of the store back into the shape the previous build left: no feed, no saved set.
  const oldPath = join(f.dir, 'internal-before-feed.sqlite');
  probe(writer).db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  copyFileSync(f.paths.internal, oldPath);
  const old = new Database(oldPath);
  old.exec(`DROP TRIGGER connector_store_item_visibility_insert; DROP TRIGGER connector_store_item_visibility_delete;
    DROP TRIGGER connector_store_item_visibility_update; DROP TABLE item_visibility_feed;
    DROP TABLE tier_visibility_members; DROP TABLE tier_visibility_state;`);
  old.close();
  const reader = new LocalConnectorStore({ dbPath: oldPath, corpusId: CORPORA.internal, family: 'file', trustDomain: 'internal', readOnly: true });
  cleanups.push(() => reader.close());
  expect(sorted(probe(reader).tierHiddenItemPks())).toEqual(expected);
  expect(reader.status().counts).toEqual(counts);
  expect(reader.hasEmbeddings(MODEL)).toBe(false);
  // The store with the feed still opens read-only alongside.
  expect(sorted(probe(openReader()).tierHiddenItemPks())).toEqual(expected);
});

test('the previous build still opens a store this build wrote, and its item writes reach the feed', async () => {
  const { f, writer, storeDb, pk, addChild, openReader } = await fixtureWithEveryState();
  probe(writer).tierHiddenItemPks();
  const reader = openReader();
  const rebuilds = countFullRebuilds(probe(reader).visibilityLedger()!);
  cleanups.push(() => rebuilds.restore());
  probe(reader).tierHiddenItemPks();
  // The feed and the saved set are additive: the schema version the previous
  // build (1.4.x) checks is unchanged, so rolling the binary back still opens it.
  expect(storeDb.query("SELECT version FROM schema_version WHERE store_id = 'connector-store'").get()).toEqual({ version: 15 });
  expect(() => assertSqliteSchemaCanOpen(storeDb, 'connector-store', 15)).not.toThrow();
  // The previous build's writer opens with its own TEMP change journal, whose
  // table and triggers shadow names in main for that connection.
  storeDb.exec(`CREATE TEMP TABLE tier_visibility_pks (flag TEXT, item_pk INTEGER, PRIMARY KEY (flag, item_pk));
    CREATE TEMP TABLE item_visibility_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT, account_scope TEXT,
      conversation_key TEXT, provider_item_id TEXT);
    CREATE TEMP TRIGGER item_visibility_insert AFTER INSERT ON main.items BEGIN
      INSERT INTO item_visibility_changes (provider, account_scope, conversation_key, provider_item_id)
        VALUES (NEW.provider, NEW.account_scope, NEW.normalized_conversation, NEW.provider_item_id);
      DELETE FROM item_visibility_changes WHERE seq <= (SELECT MAX(seq) - 8192 FROM item_visibility_changes);
    END;`);
  // That build writes an item that changes the set: another child of the hidden parent.
  addChild('hid', 'hid#child:scan');
  expect(probe(reader).tierHiddenItemPks().hidden).toContain(pk('hid#child:scan'));
  const again = new LocalConnectorStore({ dbPath: f.paths.internal, corpusId: CORPORA.internal, family: 'file', trustDomain: 'internal', tierLedger: f.ledger });
  cleanups.push(() => again.close());
  expect(sorted(probe(again).tierHiddenItemPks())).toEqual(sorted(probe(reader).tierHiddenItemPks()));
  expect(rebuilds.count).toBe(0);
});

test('a read-only store reads its ledger without writing it', async () => {
  const { ledgerDb, openReader, writer } = await fixtureWithEveryState();
  probe(writer).tierHiddenItemPks();
  // A hold with no pending judgment: a writable ledger open settles it.
  ledgerDb.query("UPDATE tier_copies SET embed_hold = 1 WHERE provider_item_id = 'plain' AND corpus_id = ?").run(CORPORA.internal);
  const before = ledgerDb.query('SELECT MAX(seq) AS seq FROM tier_visibility_changes').get();
  const reader = openReader();
  probe(reader).tierHiddenItemPks();
  reader.status();
  expect(ledgerDb.query('SELECT MAX(seq) AS seq FROM tier_visibility_changes').get()).toEqual(before);
  expect(ledgerDb.query("SELECT embed_hold FROM tier_copies WHERE provider_item_id = 'plain' AND corpus_id = ?").get(CORPORA.internal))
    .toEqual({ embed_hold: 1 });
});

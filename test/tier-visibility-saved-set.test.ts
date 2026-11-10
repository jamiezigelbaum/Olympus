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
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { controlPathHeadroom } from '../src/workers/control-path-headroom.ts';
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
import { createTestClock, waitFor, type TestClock } from './helpers/test-clock.ts';

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
  visibilityPublishChunk: number;
  visibilityTimers: Pick<TestClock, 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'>;
  visibilityPublishSteps(): Generator<void, void>;
  publishVisibility(): Promise<void>;
  visibilityNow: () => number;
  tierLedgerHiddenMemo: unknown;
  visibilityPublishing: Promise<void> | undefined;
  visibilityPending: unknown;
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

/** The saved set's stamp, generation and size, as a reader would find it. */
function ledgerStamp(db: Database): { generation: number; ledger_cursor: number; store_cursor: number; members: number } | null {
  return db.query(`SELECT generation, ledger_cursor, store_cursor,
    (SELECT COUNT(*) FROM tier_visibility_members m WHERE m.generation = s.generation) AS members
    FROM tier_visibility_state s WHERE id = 1`).get() as { generation: number; ledger_cursor: number; store_cursor: number; members: number } | null;
}

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
  await writer.saveVisibilityInTurns();
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
  await writer.saveVisibilityInTurns();
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

test('a retention gap in either feed never serves the saved set: a read-only connection rebuilds from the ledger', async () => {
  const { ledgerDb, storeDb, openReader, writer, pk } = await fixtureWithEveryState();
  await writer.saveVisibilityInTurns();
  const reader = openReader();
  probe(reader).tierHiddenItemPks();
  const rebuilds = countFullRebuilds(probe(reader).visibilityLedger()!);
  cleanups.push(() => rebuilds.restore());
  // Nothing here runs the writer, so the saved set stays where it was.

  // Ledger: a supersede, then more entries than its feed keeps, past both the
  // reader's cursor and the saved stamp. The saved set does not know about
  // the supersede; serving it would show the copy.
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'plain' AND corpus_id = ?").run(CORPORA.internal);
  ledgerDb.transaction(() => {
    for (let n = 0; n < 4_100; n++) ledgerDb.query("UPDATE tier_copies SET embed_hold = 0 WHERE provider_item_id = 'names'").run();
  })();
  expect(probe(reader).tierHiddenItemPks().hidden).toContain(pk('plain'));
  expect(reader.hasEmbeddings(MODEL)).toBe(false);
  const fresh = openReader();
  expect(probe(fresh).tierHiddenItemPks().hidden).toContain(pk('plain'));
  expect(reader.status().counts).toEqual(fresh.status().counts);
  expect(rebuilds.count).toBe(1);

  // Store: an item change, then more item writes than the item feed keeps.
  storeDb.query("UPDATE items SET parent_local_item_id = ? WHERE provider_item_id = 'held'").run(localId('hid'));
  storeDb.transaction(() => {
    for (let n = 0; n < 33_000; n++) storeDb.query("UPDATE items SET tombstoned = 0 WHERE provider_item_id = 'names'").run();
  })();
  expect(probe(reader).tierHiddenItemPks().hidden).toContain(pk('held'));
  expect(probe(openReader()).tierHiddenItemPks().hidden).toContain(pk('held'));
  expect(rebuilds.count).toBe(2);
}, 60_000);

test('the writer publishes its set in bounded steps and switches the saved set in one small step', async () => {
  const { ledgerDb, writer } = await fixtureWithEveryState();
  const clock = createTestClock();
  probe(writer).visibilityTimers = clock;
  probe(writer).visibilityPublishChunk = 2;
  await writer.saveVisibilityInTurns();
  const saved = () => ledgerStamp(probe(writer).db);
  const before = saved();
  expect(before?.members).toBe(4);

  // A gap: the writer rebuilds from scratch, which publishes a new generation.
  ledgerDb.transaction(() => {
    for (let n = 0; n < 4_100; n++) ledgerDb.query("UPDATE tier_copies SET embed_hold = 0 WHERE provider_item_id = 'plain'").run();
  })();
  probe(writer).tierHiddenItemPks();
  const changes = () => (probe(writer).db.query('SELECT total_changes() AS n').get() as { n: number }).n;
  const steps = probe(writer).visibilityPublishSteps();
  let largest = 0;
  let switchedAt = -1;
  for (let n = 0; ; n += 1) {
    const last = changes();
    const step = steps.next();
    largest = Math.max(largest, changes() - last);
    const now = saved();
    if (switchedAt < 0 && now?.generation !== before?.generation) {
      switchedAt = n;
      // The new set is whole the moment it is switched to.
      expect(now?.members).toBe(4);
    } else if (switchedAt < 0) {
      // Until then readers find the old set whole.
      expect(now).toEqual(before);
    }
    if (step.done) break;
  }
  expect(switchedAt).toBeGreaterThan(1);
  // No step writes more than one chunk of members (or the stamp), plus its lease row.
  expect(largest).toBeLessThanOrEqual(3);
  // The old generation is cleared, in chunks too.
  expect((probe(writer).db.query('SELECT COUNT(DISTINCT generation) AS n FROM tier_visibility_members').get() as { n: number }).n).toBe(1);
});

test('a save that finds the store busy is retried', async () => {
  const { storeDb, writer, openReader, ledgerDb, pk } = await fixtureWithEveryState();
  const clock = createTestClock();
  probe(writer).visibilityTimers = clock;
  await writer.saveVisibilityInTurns();
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'plain' AND corpus_id = ?").run(CORPORA.internal);
  const stampBefore = ledgerStamp(probe(writer).db);
  storeDb.exec('BEGIN IMMEDIATE');
  try {
    probe(writer).tierHiddenItemPks();
    await probe(writer).publishVisibility();
    expect(ledgerStamp(probe(writer).db)).toEqual(stampBefore);
  } finally {
    storeDb.exec('COMMIT');
  }
  // The retry fires on its own timer; nothing reads or saves the writer again.
  await clock.advance(1_000);
  await waitFor(() => ledgerStamp(probe(writer).db)!.ledger_cursor > stampBefore!.ledger_cursor, { description: 'the retried save' });
  const reader = openReader();
  const rebuilds = countFullRebuilds(probe(reader).visibilityLedger()!);
  cleanups.push(() => rebuilds.restore());
  expect(probe(reader).tierHiddenItemPks().hidden).toContain(pk('plain'));
  expect(rebuilds.count).toBe(0);
});

test('a read-only reader stays served from the saved set while another store\'s import moves the ledger feed past its window', async () => {
  const { f, writer, ledgerDb, openReader, pk } = await fixtureWithEveryState();
  await writer.saveVisibilityInTurns();
  const reader = openReader();
  const rebuilds = countFullRebuilds(probe(reader).visibilityLedger()!);
  cleanups.push(() => rebuilds.restore());
  expect(probe(reader).tierHiddenItemPks().moving).toBe(1);
  const cursor = () => (ledgerDb.query('SELECT MAX(seq) AS seq FROM tier_visibility_changes').get() as { seq: number }).seq;
  const start = cursor();
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'plain' AND corpus_id = ?").run(CORPORA.internal);
  // The secure_local store imports; nothing reads the internal writer, whose
  // only work is the refresh the shared ledger's movement asks of it. Its own
  // leg of each sync runs without the end-of-import refresh, so only the
  // other store's import can keep it current.
  const held = (writer as unknown as { syncFromConnectorHeld: LocalConnectorStore['syncFromConnector'] }).syncFromConnectorHeld.bind(writer);
  const ownLeg = spyOn(writer, 'syncFromConnector').mockImplementation((connector, options) => held(connector, options));
  cleanups.push(() => ownLeg.mockRestore());
  const churn: FixtureSpec[] = Array.from({ length: 3_000 }, (_, n) => ({
    id: `secure-${n}`, name: `secure-${n}.txt`, text: `Secure note ${n}.`, legacyDomain: 'secure_local' as const,
  }));
  // Mid-import, once the ledger feed has moved past its whole window since
  // the reader's last read and the writer's saved stamp, the reader serves a
  // request.
  let served = false;
  const realTurn = controlPathHeadroom.ingestionTurn.bind(controlPathHeadroom);
  const turns = spyOn(controlPathHeadroom, 'ingestionTurn').mockImplementation(() => {
    if (!served && cursor() - start > 8_192 + 500) {
      served = true;
      expect(probe(reader).tierHiddenItemPks().hidden).toContain(pk('plain'));
    }
    return realTurn();
  });
  try {
    await f.set.sync(fixtureConnector(() => [...SPECS, ...churn]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  } finally {
    turns.mockRestore();
  }
  expect(served).toBe(true);
  // The reader never rebuilt: each read applied only the feed past the saved
  // stamp, and matches a connection that rebuilds from the ledger.
  const truth = openReader();
  spyOn(truth as unknown as { savedVisibilitySteps(): Generator<void, undefined> }, 'savedVisibilitySteps')
    .mockImplementation(function* () { return undefined; });
  expect(probe(reader).tierHiddenItemPks().hidden).toContain(pk('plain'));
  expect(sorted(probe(reader).tierHiddenItemPks())).toEqual(sorted(probe(truth).tierHiddenItemPks()));
  expect(reader.hasEmbeddings(MODEL)).toBe(truth.hasEmbeddings(MODEL));
  expect(rebuilds.count).toBe(0);
}, 120_000);

/** A from-scratch build on a new read-only connection: the truth a saved set must match. */
function truthOf(openReader: () => LocalConnectorStore): HiddenSet {
  const truth = openReader();
  spyOn(truth as unknown as { savedVisibilitySteps(): Generator<void, undefined> }, 'savedVisibilitySteps')
    .mockImplementation(function* () { return undefined; });
  return sorted(probe(truth).tierHiddenItemPks());
}

/** A second writable connection on the internal store, on a test clock. */
function secondWriter(f: TierFixture, clock: TestClock): LocalConnectorStore {
  const other = new LocalConnectorStore({ dbPath: f.paths.internal, corpusId: CORPORA.internal, family: 'file', trustDomain: 'internal', tierLedger: f.ledger });
  cleanups.push(() => other.close());
  probe(other).visibilityTimers = clock;
  probe(other).visibilityNow = () => clock.now();
  return other;
}

test('an older publisher that resumes after a newer one saved never writes its older flags', async () => {
  const { f, writer, ledgerDb, openReader } = await fixtureWithEveryState();
  const clock = createTestClock();
  await writer.saveVisibilityInTurns();
  probe(writer).visibilityTimers = clock;
  probe(writer).visibilityNow = () => clock.now();
  const supersede = (state: string) => ledgerDb.query('UPDATE tier_copies SET copy_state = ? WHERE provider_item_id = ? AND corpus_id = ?')
    .run(state, 'plain', CORPORA.internal);
  // The first writer builds with `plain` hidden, then stalls mid-publish.
  supersede('superseded');
  probe(writer).tierHiddenItemPks();
  const older = probe(writer).visibilityPublishSteps();
  older.next();
  // `plain` is served again, and a second writer saves that newer set, after
  // the first writer's lease (if any) has run out.
  supersede('current');
  await clock.advance(10 * 60_000);
  const newer = secondWriter(f, clock);
  probe(newer).tierHiddenItemPks();
  await probe(newer).publishVisibility();
  // The first writer resumes.
  try { for (let step = older.next(); !step.done; step = older.next()) { /* run on */ } } catch { /* refused */ }
  expect(sorted(probe(openReader()).tierHiddenItemPks())).toEqual(truthOf(openReader));
});

test('a publisher cleaning up after its switch never deletes a generation another connection switched to', async () => {
  const { f, writer, storeDb, ledgerDb, openReader } = await fixtureWithEveryState();
  const clock = createTestClock();
  await writer.saveVisibilityInTurns();
  probe(writer).visibilityTimers = clock;
  probe(writer).visibilityNow = () => clock.now();
  probe(writer).visibilityPublishChunk = 1;
  // Nothing saved: the first writer publishes a whole new generation.
  storeDb.exec('DELETE FROM tier_visibility_state; DELETE FROM tier_visibility_members;');
  probe(writer).tierLedgerHiddenMemo = undefined;
  probe(writer).tierHiddenItemPks();
  const first = probe(writer).visibilityPublishSteps();
  const generation = () => (storeDb.query('SELECT generation FROM tier_visibility_state').get() as { generation: number } | null)?.generation;
  while (generation() === undefined) first.next();
  // Switched, about to clear older generations. A second writer publishes a
  // whole newer generation, with `plain` hidden since, in the meantime.
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'plain' AND corpus_id = ?").run(CORPORA.internal);
  await clock.advance(10 * 60_000);
  const newer = secondWriter(f, clock);
  spyOn(newer as unknown as { savedVisibilitySteps(): Generator<void, undefined> }, 'savedVisibilitySteps')
    .mockImplementation(function* () { return undefined; });
  probe(newer).tierHiddenItemPks();
  await probe(newer).publishVisibility();
  expect(generation()).toBeGreaterThan(1);
  try { for (let step = first.next(); !step.done; step = first.next()) { /* run on */ } } catch { /* refused */ }
  expect(sorted(probe(openReader()).tierHiddenItemPks())).toEqual(truthOf(openReader));
  expect(ledgerStamp(storeDb)!.members).toBe(5);
});

test('one publisher at a time: a second connection waits while the first holds the lease', async () => {
  const { f, writer, ledgerDb, openReader } = await fixtureWithEveryState();
  const clock = createTestClock();
  await writer.saveVisibilityInTurns();
  probe(writer).visibilityTimers = clock;
  probe(writer).visibilityNow = () => clock.now();
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'plain' AND corpus_id = ?").run(CORPORA.internal);
  probe(writer).tierHiddenItemPks();
  const first = probe(writer).visibilityPublishSteps();
  first.next();
  const newer = secondWriter(f, clock);
  probe(newer).tierHiddenItemPks();
  const before = ledgerStamp(probe(newer).db);
  await probe(newer).publishVisibility();
  expect(ledgerStamp(probe(newer).db)).toEqual(before);
  for (let step = first.next(); !step.done; step = first.next()) { /* run on */ }
  expect(sorted(probe(openReader()).tierHiddenItemPks())).toEqual(truthOf(openReader));
  // The second writer's retry, once the lease is free, saves its set too.
  await clock.advance(1_000);
  await waitFor(() => probe(newer).visibilityPublishing === undefined && probe(newer).visibilityPending === undefined,
    { description: 'the second writer\'s retried save' });
  expect(sorted(probe(openReader()).tierHiddenItemPks())).toEqual(truthOf(openReader));
});

test('two full publishers never share a generation', async () => {
  const { f, writer, storeDb, ledgerDb, openReader } = await fixtureWithEveryState();
  const clock = createTestClock();
  await writer.saveVisibilityInTurns();
  probe(writer).visibilityTimers = clock;
  probe(writer).visibilityNow = () => clock.now();
  probe(writer).visibilityPublishChunk = 1;
  // Both writers rebuild from scratch, so both publish a whole new generation.
  const fromScratch = (store: LocalConnectorStore) => spyOn(store as unknown as { savedVisibilitySteps(): Generator<void, undefined> },
    'savedVisibilitySteps').mockImplementation(function* () { return undefined; });
  const writerScratch = fromScratch(writer);
  cleanups.push(() => writerScratch.mockRestore());
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'plain' AND corpus_id = ?").run(CORPORA.internal);
  probe(writer).tierLedgerHiddenMemo = undefined;
  probe(writer).tierHiddenItemPks();
  const first = probe(writer).visibilityPublishSteps();
  first.next(); // picked its generation, nothing written yet
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'current' WHERE provider_item_id = 'plain' AND corpus_id = ?").run(CORPORA.internal);
  const newer = secondWriter(f, clock);
  probe(newer).visibilityPublishChunk = 1;
  fromScratch(newer);
  probe(newer).tierHiddenItemPks();
  const second = probe(newer).visibilityPublishSteps();
  // Interleave the two step by step, the second after the first's lease ran out.
  await clock.advance(10 * 60_000);
  let firstDone = false;
  let secondDone = false;
  while (!firstDone || !secondDone) {
    if (!secondDone) { try { secondDone = second.next().done === true; } catch { secondDone = true; } }
    if (!firstDone) { try { firstDone = first.next().done === true; } catch { firstDone = true; } }
  }
  expect(sorted(probe(openReader()).tierHiddenItemPks())).toEqual(truthOf(openReader));
  expect(ledgerStamp(storeDb)!.members).toBe(4);
});

test('a publish with nothing queued does not swallow the next one', async () => {
  const { writer, ledgerDb } = await fixtureWithEveryState();
  const clock = createTestClock();
  await writer.saveVisibilityInTurns();
  probe(writer).visibilityTimers = clock;
  await probe(writer).publishVisibility();
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'plain' AND corpus_id = ?").run(CORPORA.internal);
  const before = ledgerStamp(probe(writer).db)!;
  probe(writer).tierHiddenItemPks();
  const steps = spyOn(writer as unknown as Probe, 'visibilityPublishSteps');
  cleanups.push(() => steps.mockRestore());
  await probe(writer).publishVisibility();
  expect(steps).toHaveBeenCalled();
  expect(ledgerStamp(probe(writer).db)!.ledger_cursor).toBeGreaterThan(before.ledger_cursor);
});

test('a reopened writer starts from the saved set instead of rebuilding', async () => {
  const { f, writer, ledgerDb, pk } = await fixtureWithEveryState();
  const expected = sorted(probe(writer).tierHiddenItemPks());
  await writer.saveVisibilityInTurns();
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
  await writer.saveVisibilityInTurns();
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
  await writer.saveVisibilityInTurns();
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

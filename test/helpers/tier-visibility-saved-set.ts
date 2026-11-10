// The fixture and probes shared by the saved-visibility-set tests
// (tier-visibility-saved-set.test.ts, tier-visibility-import-refresh.test.ts).

import { Database } from 'bun:sqlite';
import { expect, spyOn } from 'bun:test';
import { LocalConnectorStore } from '../../src/workers/connector-store/index.ts';
import type { TierLedger, TierLedgerIdentity } from '../../src/workers/classification/tier-ledger.ts';
import {
  CORPORA,
  FIXTURE_PLACEMENT,
  fixtureConnector,
  localId,
  openTierFixture,
  tempDir,
  type FixtureSpec,
  type TierFixture,
} from './tier-fixtures.ts';
import type { TestClock } from './test-clock.ts';

export const MODEL = 'saved-set-fixture-model';

export interface HiddenSet {
  hidden: number[];
  held: number[];
  heldForJudgment: number[];
  metadataLayer: number[];
  metadataLayerContentUnread: number[];
  moving: number;
}

export interface Probe {
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

export const probe = (store: LocalConnectorStore) => store as unknown as Probe;
export const sorted = (set: HiddenSet): HiddenSet => ({
  hidden: [...set.hidden].sort((a, b) => a - b),
  held: [...set.held].sort((a, b) => a - b),
  heldForJudgment: [...set.heldForJudgment].sort((a, b) => a - b),
  metadataLayer: [...set.metadataLayer].sort((a, b) => a - b),
  metadataLayerContentUnread: [...set.metadataLayerContentUnread].sort((a, b) => a - b),
  moving: set.moving,
});

export const cleanups: Array<() => void> = [];

export const SPECS: FixtureSpec[] = ['plain', 'hid', 'held', 'names', 'staged', 'late'].map((id) => ({
  id, name: `${id}.txt`, text: `Ordinary picnic notes about ${id}.`,
}));

/** The saved set's stamp, generation and size, as a reader would find it. */
export function ledgerStamp(db: Database): { generation: number; ledger_cursor: number; store_cursor: number; members: number } | null {
  return db.query(`SELECT generation, ledger_cursor, store_cursor,
    (SELECT COUNT(*) FROM tier_visibility_members m WHERE m.generation = s.generation) AS members
    FROM tier_visibility_state s WHERE id = 1`).get() as { generation: number; ledger_cursor: number; store_cursor: number; members: number } | null;
}

/** Counts full rebuilds: a walk of the whole corpus asks the ledger for every copy (no identities). */
export function countFullRebuilds(ledger: TierLedger): { readonly count: number; restore(): void } {
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
export async function fixtureWithEveryState(): Promise<{
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

/** A from-scratch build on a new read-only connection: the truth a saved set must match. */
export function truthOf(openReader: () => LocalConnectorStore): HiddenSet {
  const truth = openReader();
  spyOn(truth as unknown as { savedVisibilitySteps(): Generator<void, undefined> }, 'savedVisibilitySteps')
    .mockImplementation(function* () { return undefined; });
  return sorted(probe(truth).tierHiddenItemPks());
}

/** A second writable connection on the internal store, on a test clock. */
export function secondWriter(f: TierFixture, clock: TestClock): LocalConnectorStore {
  const other = new LocalConnectorStore({ dbPath: f.paths.internal, corpusId: CORPORA.internal, family: 'file', trustDomain: 'internal', tierLedger: f.ledger });
  cleanups.push(() => other.close());
  probe(other).visibilityTimers = clock;
  probe(other).visibilityNow = () => clock.now();
  return other;
}

import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { TierLedger, type TierLedgerIdentity } from '../src/workers/classification/tier-ledger.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, localProvider, localId, tempDir } from './helpers/tier-fixtures.ts';

interface StoreProbe {
  db: Database;
  tierLedgerHiddenItemPks(): { hidden: number[]; held: number[]; metadataLayer: number[]; metadataLayerContentUnread: number[]; moving: number };
  itemRowsForIdentities(ids: readonly TierLedgerIdentity[], ...rest: unknown[]): unknown[];
}

/** Copy an API-created row's non-generated columns; only its identity changes. */
function multiply(db: Database, table: string, count: number, changes: Record<string, string>, where: string): void {
  const cols = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
    .filter(name => name !== 'item_pk');
  db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${count})
    INSERT INTO ${table} (${cols.join(', ')})
    SELECT ${cols.map(col => changes[col] ?? `t.${col}`).join(', ')} FROM ${table} t CROSS JOIN n WHERE ${where}`);
}

test('535k held items: each verdict refreshes one identity; moves, Secrets and deletions stay hidden', async () => {
  const tmp = tempDir();
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const stores = {
    internal: new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPORA.internal, family: 'file', trustDomain: 'internal', tierLedger: ledger }),
    secure_local: new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPORA.secure_local, family: 'file', trustDomain: 'secure_local', tierLedger: ledger }),
  };
  const secrets = new SecretLocationsIndex({ dbPath: ':memory:' });
  const provider = localProvider();
  const set = new TieredStoreSet({ setId: 'incremental', ledger, secretLocations: secrets,
    tierClassification: { holdContentUntilJudged: true, sniffer: { id: 'fixture-waiting', judge: () => ({ verdict: 'undecided', queued: true }) } },
    legs: [
      { trustDomain: 'internal', corpusId: CORPORA.internal, store: stores.internal },
      { trustDomain: 'secure_local', corpusId: CORPORA.secure_local, store: stores.secure_local, embeddingProvider: provider },
    ],
  });
  const store = stores.secure_local;
  const probe = store as unknown as StoreProbe;
  const pkOf = (id: string) => (probe.db.query('SELECT item_pk AS pk FROM items WHERE local_item_id = ?').get(id) as { pk: number } | null)?.pk;
  const ldb = (ledger as unknown as { db: Database }).db;
  const specs = ['a', 'b', 'c', 'd'].map(id => ({ id, name: `${id}.txt`, text: `Quietorchardmarker ${id} ordinary picnic notes.` }));
  try {
    await set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(ledger.copies(identityOf('a')).find(copy => copy.corpusId === store.corpusId)?.embedHold).toBe(true);
    const seedCount = 535_000 - specs.length;
    const id = "'held-' || n.x";
    ldb.transaction(() => {
      multiply(ldb, 'tier_items', seedCount, { provider_item_id: id }, "t.provider_item_id = 'a'");
      multiply(ldb, 'tier_copies', seedCount, { provider_item_id: id }, `t.provider_item_id = 'a' AND t.corpus_id = '${store.corpusId}'`);
    })();
    probe.db.transaction(() => multiply(probe.db, 'items', seedCount,
      { provider_item_id: id, local_item_id: id, title: 'NULL', search_text: 'NULL' }, "t.provider_item_id = 'a'"))();
    expect(probe.tierLedgerHiddenItemPks().held.length).toBe(535_000);
    expect(store.missingEmbeddingItemIds(provider, 10)).toEqual([]);

    const original = probe.itemRowsForIdentities.bind(store);
    let work = 0;
    const reads = spyOn(probe, 'itemRowsForIdentities').mockImplementation((ids, ...rest) => {
      work += ids.length;
      return original(ids, ...rest);
    });
    try {
      const verdict = (id: string, tier: 'private' | 'secure') => ledger.applySnifferVerdict(identityOf(id), {
        pass: 'content', tier, reason: `content:sniffer:fixture-waiting:${tier}`, modelId: 'fixture',
      }, { placementFor: decision => set.placementFor(decision) });
      verdict('a', 'secure');
      expect(probe.tierLedgerHiddenItemPks().held.length).toBe(534_999);
      expect(work).toBe(1); // the old cache remapped the entire remaining held set
      expect(store.missingEmbeddingItemIds(provider, 10)).toEqual([localId('a')]);
      // The query probes membership by pk; it must not expand the held set to
      // JSON or build a new IN-list B-tree each time.
      const plan = probe.db.query(`EXPLAIN QUERY PLAN SELECT i.item_pk FROM items i
        WHERE i.item_pk = 1 AND NOT EXISTS (SELECT 1 FROM temp.tier_visibility_pks v
          WHERE v.flag IN ('hidden', 'held', 'metadataLayer') AND v.item_pk = i.item_pk)`).all() as Array<{ detail: string }>;
      expect(plan.some(row => row.detail.includes('flag=? AND item_pk=?'))).toBe(true);

      work = 0;
      ledger.writeMeta('unrelated_tick_cursor', 'next');
      probe.tierLedgerHiddenItemPks();
      expect(work).toBe(0);
      verdict('b', 'private');
      await moveTieredItem({ set, identity: identityOf('b'), target: { metadataTier: 'private', contentTier: 'private' } });
      expect(probe.tierLedgerHiddenItemPks().hidden).toContain(pkOf(localId('b'))!);
      expect(store.searchItems('Quietorchardmarker', 10)).not.toContainEqual(expect.objectContaining({ localItemId: localId('b') }));
      expect(stores.internal.localContent(localId('b'))?.chunks.join('')).toContain('Quietorchardmarker b');
      expect(work).toBeLessThanOrEqual(8);

      // A Secret or deletion intent hides at once, before physical leg cleanup.
      ledger.putWriteIntent({ identity: identityOf('a'), connectorId: 'fixture_lane', kind: 'secret' });
      ledger.putWriteIntent({ identity: identityOf('c'), connectorId: 'fixture_lane', kind: 'deletion' });
      expect(store.missingEmbeddingItemIds(provider, 10)).toEqual([]);
      expect(store.localContent(localId('a'))).toBeUndefined();
      expect(store.localContent(localId('c'))).toBeUndefined();
      const secret = classifyItemTiers({ signals: {}, text: 'ordinary' }, { override: { kind: 'tier', tier: 'secrets' } });
      ledger.recordRoutedPlacement(identityOf('a'), secret, { copies: [], embedHold: false });
      ledger.clearWriteIntent(identityOf('a'));
      // Delete the physical item and its ledger rows: stale membership must
      // not survive a removed copy.
      const pk = pkOf(localId('c'))!;
      probe.db.query('DELETE FROM items WHERE item_pk = ?').run(pk);
      ldb.query("DELETE FROM tier_copies WHERE provider_item_id = 'c'").run();
      ldb.query("DELETE FROM tier_items WHERE provider_item_id = 'c'").run();
      ledger.clearWriteIntent(identityOf('c'));
      probe.tierLedgerHiddenItemPks();
      expect(probe.tierLedgerHiddenItemPks().hidden).toContain(pkOf(localId('a'))!);
      expect(probe.tierLedgerHiddenItemPks().held).not.toContain(pk);
      expect(store.missingEmbeddingItemIds(provider, 10)).toEqual([]);
      expect(work).toBeLessThanOrEqual(24);
    } finally { reads.mockRestore(); }
  } finally {
    stores.internal.close(); store.close(); secrets.close(); ledger.close(); tmp.cleanup();
  }
}, 120_000);

test('ledger feed includes other connections and falls back on retention gaps; moving selection has no sort', async () => {
  const tmp = tempDir();
  const ledger = new TierLedger({ dbPath: `${tmp.dir}/ledger.sqlite` });
  const store = new LocalConnectorStore({ dbPath: `${tmp.dir}/store.sqlite`, corpusId: CORPORA.internal,
    family: 'file', trustDomain: 'internal', tierLedger: ledger });
  const probe = store as unknown as StoreProbe;
  const other = new Database(ledger.dbPath);
  const decision = classifyItemTiers({ signals: {}, text: 'Ordinary picnic notes.' });
  const plan = { copies: [{ corpusId: store.corpusId, trustDomain: 'internal' as const, layers: 'both' as const }], embedHold: true };
  try {
    await store.syncFromConnector(fixtureConnector(() => [{ id: 'a', name: 'Notes', text: 'ordinary' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    ledger.recordRoutedPlacement(identityOf('a'), decision, plan);
    // Explicitly simulate a pending hold: opening a second TierLedger would
    // run its normal stale-hold repair, so the concurrent writer is raw SQLite.
    other.query("UPDATE tier_items SET state = 'pending', content_pending = 1 WHERE provider_item_id = 'a'").run();
    other.query("UPDATE tier_copies SET embed_hold = 1 WHERE provider_item_id = 'a'").run();
    expect(probe.tierLedgerHiddenItemPks().held).toHaveLength(1);
    const cursor = ledger.visibilityChangesSince().cursor;
    other.query("UPDATE tier_copies SET copy_state = 'superseded', embed_hold = 0 WHERE provider_item_id = 'a'").run();
    expect(ledger.visibilityChangesSince(cursor).identities).toEqual([{ provider: 'fixture', accountScope: 'personal', providerItemId: 'a' }]);
    expect(probe.tierLedgerHiddenItemPks()).toMatchObject({ hidden: [1], held: [] });
    // More changes than retention permits: the reader MUST bootstrap, even
    // though every retained change refers to just one identity.
    other.transaction(() => {
      for (let n = 0; n < 4_100; n++) other.query("UPDATE tier_copies SET copy_state = 'current', embed_hold = 1 WHERE provider_item_id = 'a'").run();
    })();
    expect(ledger.visibilityChangesSince(cursor).identities).toBeUndefined();
    expect(probe.tierLedgerHiddenItemPks()).toMatchObject({ hidden: [], held: [1] });
    expect((other.query('SELECT COUNT(*) AS n FROM tier_visibility_changes').get() as { n: number }).n).toBe(8192);
    // A replacement row arriving on a different store connection takes the
    // conservative full-refresh path, rather than reusing old identity->pk data.
    const writer = new Database(store.dbPath);
    try { writer.query("UPDATE items SET provider_item_id = 'replacement' WHERE item_pk = 1").run(); }
    finally { writer.close(); }
    expect(probe.tierLedgerHiddenItemPks().held).toEqual([]);
    const movePlan = other.query(`EXPLAIN QUERY PLAN SELECT * FROM tier_items INDEXED BY tier_items_move_order
      WHERE state = 'moving' ORDER BY move_attempts, decided_at, provider, account_scope, provider_item_id, conversation_key LIMIT 25`)
      .all() as Array<{ detail: string }>;
    expect(movePlan.some(row => row.detail.includes('tier_items_move_order'))).toBe(true);
    expect(movePlan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false);
  } finally { other.close(); store.close(); ledger.close(); tmp.cleanup(); }
});

test('a yielded refresh cannot rewind a newer cache or lose held flags when a pk is reused', async () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPORA.internal,
    family: 'file', trustDomain: 'internal', tierLedger: ledger });
  const probe = store as unknown as StoreProbe & { tierLedgerHiddenSteps(): Generator<void, unknown> };
  const decision = { ...classifyItemTiers({ signals: {}, text: 'Ordinary picnic notes.' }),
    state: 'pending' as const, contentPending: true };
  const plan = { copies: [{ corpusId: store.corpusId, trustDomain: 'internal' as const, layers: 'both' as const }], embedHold: true };
  try {
    await store.syncFromConnector(fixtureConnector(() => [{ id: 'a', name: 'Notes', text: 'ordinary' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    ledger.recordRoutedPlacement(identityOf('a'), decision, plan);
    expect(probe.tierLedgerHiddenItemPks().held).toEqual([1]);
    // First reader prepares a release and yields. Another reader observes a
    // later Secret/deletion intent and must keep its newer hidden state.
    const ldb = (ledger as unknown as { db: Database }).db;
    ldb.query("UPDATE tier_copies SET embed_hold = 0 WHERE provider_item_id = 'a'").run();
    const refresh = probe.tierLedgerHiddenSteps();
    expect(refresh.next().done).toBe(false);
    ledger.putWriteIntent({ identity: identityOf('a'), connectorId: 'fixture', kind: 'secret' });
    expect(probe.tierLedgerHiddenItemPks().hidden).toEqual([1]);
    while (!refresh.next().done) { /* resume the earlier reader */ }
    expect(probe.tierLedgerHiddenItemPks().hidden).toEqual([1]);
    // The ledger records the new identity before a store row is reassigned.
    // Removing the old identity's contribution after adding the new one must
    // not remove the new row's hold at that same pk.
    ledger.recordRoutedPlacement(identityOf('replacement'), decision, plan);
    probe.db.query("UPDATE items SET provider_item_id = 'replacement', local_item_id = 'personal:replacement' WHERE item_pk = 1").run();
    expect(probe.tierLedgerHiddenItemPks()).toMatchObject({ hidden: [], held: [1] });
  } finally { store.close(); ledger.close(); }
});

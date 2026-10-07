// Private rows left in a Personal or Public store (owner approval 2026-10-07:
// moved items are re-embedded by the local Private embedder). The pass reads
// each non-secure store's own stored row tiers, adopts legacy rows, queues the
// raise without hiding, and carries the move out itself, so an install whose
// Personal embedder is a cloud model never waits for `olympus tier migrate`.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import type { SourceIndexRoutedSearchHit } from '../src/core/source-index/router.ts';
import { defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { createWhatsAppTierLane } from '../src/workers/whatsapp/store-sync.ts';
import { createDropboxTierLane } from '../src/workers/dropbox-files/tier-set.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { EMBEDDING_LEDGER_OWNER_APPROVAL, readEmbeddingLedger } from '../src/workers/embedding-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { rehomePrivateTierRows } from '../src/workers/connector-store/tier-row-rehome.ts';
import { TieredStoreSet, tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import {
  CORPORA,
  FIXTURE_PLACEMENT,
  cloudProvider,
  fixtureConnector,
  identityOf,
  localId,
  localProvider,
  openLegStore,
  openTierFixture,
  snapshotStore,
  storePaths,
  tempDir,
  type FixtureSpec,
  type TierFixture,
} from './helpers/tier-fixtures.ts';

const ORCHID: FixtureSpec = { id: 'orchid', name: 'orchid-ledger.txt', text: 'Orchid ledger body that is private by its own tier.' };
const GARDEN: FixtureSpec = { id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden and the compost bins.' };

const S4_IN_INTERNAL = () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'internal' });
const S3_IN_INTERNAL = () => buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' });

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixtureIn(prefix = 'olympus-row-rehome-'): TierFixture {
  const { dir, cleanup } = tempDir(prefix);
  const fixture = openTierFixture(dir);
  cleanups.push(() => {
    fixture.close();
    cleanup();
  });
  return fixture;
}

function ledgerPath(fixture: TierFixture): string {
  return join(fixture.dir, 'embedding-ledger.jsonl');
}

/** Legacy rows written straight into the Personal store, the way a lane did before routing, S4 by their own tier. */
async function seedLegacy(fixture: TierFixture, specs: FixtureSpec[], tierFor: (spec: FixtureSpec) => 'S3' | 'S4' = () => 'S4'): Promise<void> {
  await fixture.stores.internal!.syncFromConnector(fixtureConnector(() => specs), {
    fetchContent: true,
    placement: (item) => {
      const spec = specs.find((candidate) => candidate.id === item.identity.providerItemId)!;
      return tierFor(spec) === 'S4' ? S4_IN_INTERNAL() : S3_IN_INTERNAL();
    },
  });
}

function rowTier(fixture: TierFixture, domain: 'internal' | 'secure_local', id: string): string | undefined {
  const row = fixture.stores[domain]!.activeLocalItemRow(localId(id));
  return row?.trustTier;
}

describe('Private-row re-home', () => {
  test('a legacy S4 row in a cloud-embedded Personal store is adopted, moved, and embedded by the Private store', async () => {
    const fixture = fixtureIn();
    await seedLegacy(fixture, [ORCHID, GARDEN], (spec) => (spec.id === 'orchid' ? 'S4' : 'S3'));
    const internal = fixture.stores.internal!;
    const cloudCalls = fixture.cloud.inputs.length;

    // The backstop (PR #150) is withholding the row from the cloud embedder.
    expect(internal.privateTierEmbeddingWithheld(fixture.cloud).items).toBe(1);

    const report = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
    expect(report).toMatchObject({ examined: 1, adopted: 1, queued: 1, moved: 1, failed: 0 });

    // The ledger now routes it to the Private store; the Personal copy is kept, hidden.
    const record = fixture.ledger.getCurrent(identityOf('orchid'))!;
    expect(record).toMatchObject({ routed: true, state: 'current', metadataTier: 'secure', contentTier: 'secure' });
    expect(record.reasons).toContain('row_tier:private_rehome');
    const copies = fixture.ledger.copies(identityOf('orchid'));
    expect(copies.filter((copy) => copy.state === 'current').map((copy) => copy.corpusId)).toEqual([CORPORA.secure_local]);
    expect(copies.filter((copy) => copy.state === 'superseded').map((copy) => copy.corpusId)).toEqual([CORPORA.internal]);
    expect(rowTier(fixture, 'secure_local', 'orchid')).toBe('S4');

    // The untouched Personal item stays where it is.
    expect(fixture.ledger.getCurrent(identityOf('garden'))?.routed).toBeFalsy();

    // No provider call in the move; the Private store's own embedder embeds it.
    expect(fixture.cloud.inputs.length).toBe(cloudCalls);
    const embed = await fixture.stores.secure_local!.embedChunks({ provider: fixture.local });
    expect(embed.chunksEmbedded).toBeGreaterThan(0);
    expect(fixture.local.inputs.join('\n')).toContain('Orchid ledger body');
    expect(fixture.cloud.inputs.length).toBe(cloudCalls);

    // The withheld count drains once the visible Personal copy is gone.
    expect(internal.privateTierEmbeddingWithheld(fixture.cloud).items).toBe(0);

    // The embedding-ledger note the move writes remains, with the owner's approval.
    const entries = (await readEmbeddingLedger(ledgerPath(fixture))).entries
      .filter((entry) => entry.approved_by === EMBEDDING_LEDGER_OWNER_APPROVAL && entry.what.startsWith('Tier move of one item'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'complete' });
    expect(String(entries[0]!.what)).toContain(CORPORA.secure_local);
    expect(String(entries[0]!.why)).toContain('2026-10-07');
  });

  test('a raise is queued without hiding: the item stays searchable until its move runs', async () => {
    const fixture = fixtureIn();
    await seedLegacy(fixture, [ORCHID]);
    const report = await rehomePrivateTierRows({ set: fixture.set, maxMoves: 0, embeddingLedgerPath: ledgerPath(fixture) });
    expect(report).toMatchObject({ adopted: 1, queued: 1, moved: 0 });
    const record = fixture.ledger.getCurrent(identityOf('orchid'))!;
    expect(record).toMatchObject({ state: 'moving', targetMetadataTier: 'secure', targetContentTier: 'secure' });
    const copies = fixture.ledger.copies(identityOf('orchid'));
    expect(copies.map((copy) => [copy.corpusId, copy.state])).toContainEqual([CORPORA.internal, 'current']);
    expect(fixture.stores.internal!.localContent(localId('orchid'))).toBeDefined();

    // The next call finishes the queued move.
    const next = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
    expect(next.moved).toBe(1);
    expect(fixture.stores.internal!.localContent(localId('orchid'))).toBeUndefined();
    expect(fixture.stores.secure_local!.localContent(localId('orchid'))).toBeDefined();
  });

  test('a routed Personal item whose row later carries an S4 tier is raised and moved', async () => {
    const fixture = fixtureIn();
    await fixture.set.sync(fixtureConnector(() => [GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(fixture.ledger.getCurrent(identityOf('garden'))).toMatchObject({ routed: true, contentTier: 'private' });
    // A content fetch raised the stored tier but nothing moved the item.
    (fixture.stores.internal as unknown as { db: { query(sql: string): { run(...args: unknown[]): void } } })
      .db.query("UPDATE items SET trust_tier = 'S4' WHERE local_item_id = ?").run(localId('garden'));

    const report = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
    expect(report).toMatchObject({ examined: 1, adopted: 0, queued: 1, moved: 1 });
    expect(fixture.ledger.copies(identityOf('garden')).filter((copy) => copy.state === 'current').map((copy) => copy.corpusId))
      .toEqual([CORPORA.secure_local]);
  });

  test('the sync runs the pass: a listing with nothing new still re-homes the row', async () => {
    const fixture = fixtureIn();
    await seedLegacy(fixture, [ORCHID]);
    // An unrelated empty listing is all it takes; the set settles stored rows first.
    process.env.OLYMPUS_EMBEDDING_LEDGER_PATH = ledgerPath(fixture);
    try {
      await fixture.set.sync(fixtureConnector(() => []), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    } finally {
      delete process.env.OLYMPUS_EMBEDDING_LEDGER_PATH;
    }
    expect(fixture.ledger.copies(identityOf('orchid')).filter((copy) => copy.state === 'current').map((copy) => copy.corpusId))
      .toEqual([CORPORA.secure_local]);
  });

  test('a failed move is retried on the next call, and the item stays queued meanwhile', async () => {
    const fixture = fixtureIn();
    await seedLegacy(fixture, [ORCHID]);
    const spy = spyOn(LocalConnectorStore.prototype, 'importItemCopy').mockImplementationOnce(() => {
      throw new Error('disk busy');
    });
    try {
      const first = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
      expect(first).toMatchObject({ queued: 1, moved: 0, failed: 1 });
      expect(fixture.ledger.getCurrent(identityOf('orchid'))).toMatchObject({ state: 'moving' });
      expect(fixture.ledger.moveAttempts(identityOf('orchid'))).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const second = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
    expect(second).toMatchObject({ moved: 1, failed: 0 });
    expect(fixture.ledger.getCurrent(identityOf('orchid'))).toMatchObject({ state: 'current' });
  });

  test('skips owner overrides, forced names, items with an open question, and rows whose copy lives elsewhere', async () => {
    const fixture = fixtureIn();
    const specs: FixtureSpec[] = ['override', 'forced', 'asking', 'moved'].map((id) => ({ id, name: `${id}.txt`, text: `${id} body text` }));
    await seedLegacy(fixture, specs);
    fixture.ledger.setOverride(identityOf('override'), { kind: 'tier', tier: 'private' });
    // Routed first (adopt), then marked per case.
    for (const id of ['forced', 'asking', 'moved']) {
      fixture.stores.internal!.bindTierSet(fixture.ledger);
      fixture.ledger.adoptLegacyPlacement(
        identityOf(id),
        [{ corpusId: CORPORA.internal, trustDomain: 'internal', layers: 'both' }],
        { whenMissing: { family: 'file', metadataTier: 'private', contentTier: 'private' } },
      );
    }
    const db = (fixture.ledger as unknown as { db: { query(sql: string): { run(...args: unknown[]): void } } }).db;
    db.query("UPDATE tier_items SET metadata_forced = 1 WHERE provider_item_id = 'forced'").run();
    db.query("UPDATE tier_items SET state = 'pending', content_pending = 1 WHERE provider_item_id = 'asking'").run();
    // `moved`: the ledger's current copy is somewhere else (this row is a stale kept one).
    db.query("UPDATE tier_copies SET copy_state = 'superseded', superseded_by_generation = 2 WHERE provider_item_id = 'moved'").run();

    const report = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
    expect(report).toMatchObject({ examined: 4, queued: 0, moved: 0, skipped: 4 });
    expect(fixture.ledger.getCurrent(identityOf('override'))?.routed).toBeFalsy();
  });

  test('S5 rows (Secrets) are never listed', async () => {
    const fixture = fixtureIn();
    await seedLegacy(fixture, [ORCHID]);
    (fixture.stores.internal as unknown as { db: { query(sql: string): { run(...args: unknown[]): void } } })
      .db.query("UPDATE items SET trust_tier = 'S5'").run();
    const report = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
    expect(report.examined).toBe(0);
  });

  test('the scan is bounded by a window and resumes from a persisted cursor', async () => {
    const fixture = fixtureIn();
    const specs: FixtureSpec[] = Array.from({ length: 6 }, (_, index) => ({ id: `row${index}`, name: `row${index}.txt`, text: `row ${index} body` }));
    await seedLegacy(fixture, specs);
    const seen = new Set<string>();
    let calls = 0;
    // Window of two item_pk values per call, no moves: each call examines a slice.
    for (; calls < 10 && seen.size < specs.length; calls += 1) {
      const report = await rehomePrivateTierRows({ set: fixture.set, scanWindow: 2, maxMoves: 0, embeddingLedgerPath: ledgerPath(fixture) });
      expect(report.examined).toBeLessThanOrEqual(2);
      for (const spec of specs) if (fixture.ledger.getCurrent(identityOf(spec.id))?.routed) seen.add(spec.id);
    }
    expect(seen.size).toBe(specs.length);
    expect(calls).toBe(3);
    // The cursor wrapped to the start once the end of the table was reached.
    expect(fixture.ledger.readMeta(`private_row_rehome_after:${CORPORA.internal}`)).toBe('');
  });

  test('moves are bounded per call and the rest finish on later calls', async () => {
    const fixture = fixtureIn();
    const specs: FixtureSpec[] = Array.from({ length: 5 }, (_, index) => ({ id: `row${index}`, name: `row${index}.txt`, text: `row ${index} body` }));
    await seedLegacy(fixture, specs);
    const first = await rehomePrivateTierRows({ set: fixture.set, maxMoves: 2, embeddingLedgerPath: ledgerPath(fixture) });
    expect(first).toMatchObject({ queued: 5, moved: 2 });
    const second = await rehomePrivateTierRows({ set: fixture.set, maxMoves: 10, embeddingLedgerPath: ledgerPath(fixture) });
    expect(second.moved).toBe(3);
  });

  test('a Private embedder that is a cloud model leaves the queued moves for the migration', async () => {
    const { dir, cleanup } = tempDir('olympus-row-rehome-cloud-');
    const paths = storePaths(dir);
    const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local) });
    const stores = { internal: openLegStore(paths, 'internal', ledger), secure_local: openLegStore(paths, 'secure_local', ledger) };
    cleanups.push(() => {
      stores.internal.close();
      stores.secure_local.close();
      ledger.close();
      cleanup();
    });
    const venice = Object.assign(cloudProvider(), { provider: 'venice' });
    const set = new TieredStoreSet({
      setId: 'fixture.cloud-private',
      ledger,
      legs: [
        { trustDomain: 'internal', corpusId: CORPORA.internal, store: stores.internal, legacy: true, embeddingProvider: cloudProvider() },
        { trustDomain: 'secure_local', corpusId: CORPORA.secure_local, store: stores.secure_local, legacy: true, embeddingProvider: venice },
      ],
    });
    await stores.internal.syncFromConnector(fixtureConnector(() => [ORCHID]), { fetchContent: true, placement: S4_IN_INTERNAL });
    const report = await rehomePrivateTierRows({ set, embeddingLedgerPath: join(dir, 'embedding-ledger.jsonl') });
    expect(report).toMatchObject({ queued: 1, moved: 0, awaitingMigration: 1 });
    expect(ledger.getCurrent(identityOf('orchid'))).toMatchObject({ state: 'moving' });
  });

  test('placement-policy guard: a store whose lane rests items at a Private tier is left alone', async () => {
    const { dir, cleanup } = tempDir('olympus-row-rehome-guard-');
    const paths = storePaths(dir);
    const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local) });
    const stores = { internal: openLegStore(paths, 'internal', ledger), secure_local: openLegStore(paths, 'secure_local', ledger) };
    cleanups.push(() => {
      stores.internal.close();
      stores.secure_local.close();
      ledger.close();
      cleanup();
    });
    const set = new TieredStoreSet({
      setId: 'fixture.s4-internal',
      ledger,
      legs: [
        // The lane declares its internal items rest at S4 by design.
        { trustDomain: 'internal', corpusId: CORPORA.internal, store: stores.internal, legacy: true, restingTier: 'S4', embeddingProvider: cloudProvider() },
        { trustDomain: 'secure_local', corpusId: CORPORA.secure_local, store: stores.secure_local, legacy: true, embeddingProvider: localProvider() },
      ],
    });
    await stores.internal.syncFromConnector(fixtureConnector(() => [ORCHID]), { fetchContent: true, placement: S4_IN_INTERNAL });
    const report = await rehomePrivateTierRows({ set, embeddingLedgerPath: join(dir, 'embedding-ledger.jsonl') });
    expect(report).toMatchObject({ examined: 0, queued: 0, moved: 0, guardedStores: 1 });
    expect(ledger.getCurrent(identityOf('orchid'))?.routed).toBeFalsy();
    expect(stores.internal.localContent(localId('orchid'))).toBeDefined();
  });

  describe('review fixes', () => {
    const rawDb = (store: LocalConnectorStore) => (store as unknown as { db: { query(sql: string): { run(...args: unknown[]): void } } }).db;

    function gate(fixture: TierFixture) {
      return createTierVisibilityGate(() => [{ ledger: fixture.ledger, corpusIds: new Set(Object.values(CORPORA)) }]);
    }

    /** Where the real search path serves an item's content from. */
    function searchedIn(fixture: TierFixture, term: string, id: string): string[] {
      const hits: SourceIndexRoutedSearchHit[] = [];
      for (const store of fixture.set.openStores()) {
        for (const row of store.searchItems(term, 10)) {
          if (row.sourceItem.providerItemId !== id || !row.chunk) continue;
          hits.push({ sourceItem: row.sourceItem, corpusId: store.corpusId, trustDomain: store.trustDomain, rawExposed: false });
        }
      }
      return gate(fixture)(hits).map((hit) => hit.corpusId);
    }

    function reopen(fixture: TierFixture): TierFixture {
      fixture.close();
      const next = openTierFixture(fixture.dir);
      cleanups.push(() => next.close());
      return next;
    }

    function currentCorpora(fixture: TierFixture, id: string): string[] {
      return fixture.ledger.copies(identityOf(id)).filter((copy) => copy.state === 'current').map((copy) => copy.corpusId);
    }

    async function receipts(fixture: TierFixture): Promise<number> {
      return (await readEmbeddingLedger(ledgerPath(fixture))).entries
        .filter((entry) => entry.what.startsWith('Tier move of one item')).length;
    }

    test('production Dropbox construction: an unresolved Private embedder leaves the move queued; a cloud one too; a local one moves it', async () => {
      const { dir, cleanup } = tempDir('olympus-row-rehome-dropbox-');
      const secure = new LocalConnectorStore({
        dbPath: join(dir, 'dropbox-secure.sqlite'),
        corpusId: 'secure_local.dropbox.files',
        family: 'file',
        trustDomain: 'secure_local',
      });
      const lane = createDropboxTierLane({
        secureStore: secure,
        env: {
          OLYMPUS_SOURCE_INDEX_DROPBOX_INTERNAL_CONNECTOR_STORE_DB_PATH: join(dir, 'dropbox-internal.sqlite'),
          OLYMPUS_SOURCE_INDEX_DROPBOX_PUBLIC_CONNECTOR_STORE_DB_PATH: join(dir, 'dropbox-public.sqlite'),
        },
        policy: defaultDropboxIngestionPolicy(),
      });
      cleanups.push(() => {
        lane.internal.current()?.close();
        lane.public.current()?.close();
        secure.close();
        lane.ledger.close();
        cleanup();
      });
      const internal = lane.internal.open();
      await internal.syncFromConnector(fixtureConnector(() => [ORCHID]), { fetchContent: true, placement: S4_IN_INTERNAL });
      internal.bindTierSet(lane.ledger);
      lane.ledger.adoptLegacyPlacement(
        identityOf('orchid'),
        [{ corpusId: lane.internal.corpusId, trustDomain: 'internal', layers: 'both' }],
        { whenMissing: { family: 'file', metadataTier: 'private', contentTier: 'private' } },
      );
      const embeddingLedgerPath = join(dir, 'embedding-ledger.jsonl');

      // No leg declares an embedder and nothing was told which one the Private store uses.
      expect(lane.set.privateEmbedderBackend()).toBeUndefined();
      const unknown = await rehomePrivateTierRows({ set: lane.set, embeddingLedgerPath });
      expect(unknown).toMatchObject({ queued: 1, moved: 0, awaitingMigration: 1 });

      lane.set.declarePrivateEmbedder(Object.assign(cloudProvider(), { provider: 'venice' }));
      expect(await rehomePrivateTierRows({ set: lane.set, embeddingLedgerPath })).toMatchObject({ moved: 0, awaitingMigration: 1 });

      lane.set.declarePrivateEmbedder(localProvider());
      expect(await rehomePrivateTierRows({ set: lane.set, embeddingLedgerPath })).toMatchObject({ moved: 1 });
      expect(lane.ledger.copies(identityOf('orchid')).filter((copy) => copy.state === 'current').map((copy) => copy.corpusId))
        .toEqual(['secure_local.dropbox.files']);
    });

    test('an override set after the raise was queued stops the move', async () => {
      const fixture = fixtureIn();
      await seedLegacy(fixture, [ORCHID]);
      await rehomePrivateTierRows({ set: fixture.set, maxMoves: 0, embeddingLedgerPath: ledgerPath(fixture) });
      expect(fixture.ledger.getCurrent(identityOf('orchid'))).toMatchObject({ state: 'moving' });
      fixture.ledger.setOverride(identityOf('orchid'), { kind: 'tier', tier: 'private' });
      const report = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
      expect(report.moved).toBe(0);
      expect(currentCorpora(fixture, 'orchid')).toEqual([CORPORA.internal]);
    });

    test('a move validated at one generation does not move a newer decision', async () => {
      const fixture = fixtureIn();
      await fixture.set.sync(fixtureConnector(() => [GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      const record = fixture.ledger.getCurrent(identityOf('garden'))!;
      await expect(moveTieredItem({
        set: fixture.set,
        identity: { ...identityOf('garden'), localItemId: localId('garden') },
        target: { metadataTier: 'secure', contentTier: 'secure' },
        expectedGeneration: record.generation + 7,
      })).rejects.toThrow();
      expect(currentCorpora(fixture, 'garden')).toEqual([CORPORA.internal]);
    });

    test('unrelated queued moves cannot starve ours: the scan finds our queued rows itself', async () => {
      const fixture = fixtureIn();
      await seedLegacy(fixture, [ORCHID]);
      await rehomePrivateTierRows({ set: fixture.set, maxMoves: 0, embeddingLedgerPath: ledgerPath(fixture) });
      // The ledger's queue page is entirely someone else's work.
      const spy = spyOn(TierLedger.prototype, 'listMoving').mockReturnValue([]);
      try {
        const report = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
        expect(report.moved).toBe(1);
      } finally {
        spy.mockRestore();
      }
      expect(currentCorpora(fixture, 'orchid')).toEqual([CORPORA.secure_local]);
    });

    test('an open re-judge question holds the row where it is', async () => {
      const fixture = fixtureIn();
      await fixture.set.sync(fixtureConnector(() => [GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      rawDb(fixture.stores.internal!).query("UPDATE items SET trust_tier = 'S4' WHERE local_item_id = ?").run(localId('garden'));
      const record = fixture.ledger.getCurrent(identityOf('garden'))!;
      expect(fixture.ledger.openRejudgeQuestion(identityOf('garden'), {
        expectedGeneration: record.generation,
        keepVisible: true,
        decision: {
          metadataTier: record.metadataTier, contentTier: 'secure', decidedBy: 'sniffer', reasons: ['content:sniffer'],
          state: 'current', contentRead: true, metadataPending: false, contentPending: false, metadataForced: false,
          metadataFlagged: false, engineVersion: record.engineVersion, mapRevision: record.mapRevision, snifferId: 'test',
        },
      })).toBe(true);
      const report = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
      expect(report).toMatchObject({ examined: 1, queued: 0, moved: 0, skipped: 1 });
      expect(fixture.ledger.getCurrent(identityOf('garden'))).toMatchObject({ state: 'current' });
    });

    test('a destination that keeps different text refuses for good: recorded once, counted, never retried as a failure', async () => {
      const fixture = fixtureIn();
      await fixture.set.sync(fixtureConnector(() => [GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      const identity = { ...identityOf('garden'), localItemId: localId('garden') };
      await moveTieredItem({ set: fixture.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
      await moveTieredItem({ set: fixture.set, identity, target: { metadataTier: 'private', contentTier: 'private' } });
      // The Private store keeps an older, different copy; the row is S4 again.
      rawDb(fixture.stores.secure_local!).query("UPDATE chunks SET bounded_text = 'older different text'").run();
      rawDb(fixture.stores.internal!).query("UPDATE items SET trust_tier = 'S4' WHERE local_item_id = ?").run(localId('garden'));
      const first = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
      expect(first).toMatchObject({ queued: 1, moved: 0, failed: 0, refused: 1 });
      const second = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
      expect(second).toMatchObject({ moved: 0, failed: 0, refused: 1 });
      expect(fixture.ledger.moveAttempts(identityOf('garden'))).toBe(0);
      expect(fixture.set.rowRehomeReport()?.refused).toBe(1);
      expect(currentCorpora(fixture, 'garden')).toEqual([CORPORA.internal]);
    });

    function plainSet(dir: string, secureProvider?: ReturnType<typeof localProvider>) {
      const paths = storePaths(dir);
      const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local) });
      const stores = { internal: openLegStore(paths, 'internal', ledger), secure_local: openLegStore(paths, 'secure_local', ledger) };
      cleanups.push(() => {
        stores.internal.close();
        stores.secure_local.close();
        ledger.close();
      });
      const set = new TieredStoreSet({
        setId: 'fixture.plain',
        ledger,
        splitLayers: false,
        legs: [
          { trustDomain: 'internal', corpusId: CORPORA.internal, store: stores.internal, legacy: true },
          { trustDomain: 'secure_local', corpusId: CORPORA.secure_local, store: stores.secure_local, legacy: true, ...(secureProvider ? { embeddingProvider: secureProvider } : {}) },
        ],
      });
      return { set, ledger, stores, paths };
    }

    test('old built-in vector authority never authorizes a move: an undeclared Private embedder stays unknown', async () => {
      const { dir, cleanup } = tempDir('olympus-row-rehome-authority-');
      cleanups.push(cleanup);
      const { set, stores } = plainSet(dir);
      // The Private store once embedded with a local model, so it records a local authority.
      await stores.secure_local.syncFromConnector(fixtureConnector(() => [GARDEN]), {
        fetchContent: true,
        placement: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
      });
      await stores.secure_local.embedChunks({ provider: localProvider() });
      expect(stores.secure_local.embeddingAuthorities().some((authority) => authority.backend === 'local')).toBe(true);
      await stores.internal.syncFromConnector(fixtureConnector(() => [ORCHID]), { fetchContent: true, placement: S4_IN_INTERNAL });
      expect(set.privateEmbedderBackend()).toBeUndefined();
      const report = await rehomePrivateTierRows({ set, embeddingLedgerPath: join(dir, 'embedding-ledger.jsonl') });
      expect(report).toMatchObject({ queued: 1, moved: 0, awaitingMigration: 1 });
    });

    test('Telegram-shaped and WhatsApp lanes move once the runtime declares a local Private embedder', async () => {
      const { dir, cleanup } = tempDir('olympus-row-rehome-chat-');
      cleanups.push(cleanup);
      // Telegram: the lane's own two-store set, no provider on any leg.
      const telegramDir = join(dir, 'telegram');
      require('node:fs').mkdirSync(telegramDir, { recursive: true });
      const telegram = plainSet(telegramDir);
      await telegram.stores.internal.syncFromConnector(fixtureConnector(() => [ORCHID]), { fetchContent: true, placement: S4_IN_INTERNAL });
      const ledgerFile = join(dir, 'embedding-ledger.jsonl');
      expect(await rehomePrivateTierRows({ set: telegram.set, embeddingLedgerPath: ledgerFile })).toMatchObject({ moved: 0, awaitingMigration: 1 });
      telegram.set.declarePrivateEmbedder(localProvider());
      expect(await rehomePrivateTierRows({ set: telegram.set, embeddingLedgerPath: ledgerFile })).toMatchObject({ moved: 1 });

      // WhatsApp: the production lane construction.
      const secure = new LocalConnectorStore({ dbPath: join(dir, 'wa-secure.sqlite'), corpusId: 'secure_local.whatsapp.live', family: 'chat', trustDomain: 'secure_local' });
      const lane = createWhatsAppTierLane({
        store: secure,
        env: { OLYMPUS_SOURCE_INDEX_WHATSAPP_INTERNAL_CONNECTOR_STORE_DB_PATH: join(dir, 'wa-internal.sqlite') },
      });
      cleanups.push(() => {
        lane.newStores.internal?.current()?.close();
        secure.close();
        lane.ledger.close();
      });
      const internal = lane.newStores.internal!.open();
      const chatConnector = fixtureConnector(() => [ORCHID]);
      const chat = {
        ...chatConnector,
        family: 'chat' as const,
        listItems: (...args: Parameters<typeof chatConnector.listItems>) => (async function* () {
          for await (const page of chatConnector.listItems(...args)) {
            yield { ...page, items: page.items.map((item) => ({ ...item, identity: { ...item.identity, family: 'chat' as const } })) };
          }
        })(),
      };
      await internal.syncFromConnector(chat, { fetchContent: true, placement: S4_IN_INTERNAL });
      internal.bindTierSet(lane.ledger);
      lane.ledger.adoptLegacyPlacement(
        identityOf('orchid'),
        [{ corpusId: lane.newStores.internal!.corpusId, trustDomain: 'internal', layers: 'both' }],
        { whenMissing: { family: 'file', metadataTier: 'private', contentTier: 'private' } },
      );
      expect(await rehomePrivateTierRows({ set: lane.set, embeddingLedgerPath: ledgerFile })).toMatchObject({ moved: 0, awaitingMigration: 1 });
      lane.set.declarePrivateEmbedder(localProvider());
      expect(await rehomePrivateTierRows({ set: lane.set, embeddingLedgerPath: ledgerFile })).toMatchObject({ moved: 1 });
    });

    test('225 refusing rows do not starve a healthy one, and refusals are never evicted', async () => {
      const fixture = fixtureIn('olympus-row-rehome-refusals-');
      const specs: FixtureSpec[] = Array.from({ length: 225 }, (_, index) => ({ id: `ref${index}`, name: `ref${index}.txt`, text: `refusing row ${index} body` }));
      await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      for (const spec of specs) {
        const identity = { ...identityOf(spec.id), localItemId: localId(spec.id) };
        await moveTieredItem({ set: fixture.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
        await moveTieredItem({ set: fixture.set, identity, target: { metadataTier: 'private', contentTier: 'private' } });
      }
      rawDb(fixture.stores.secure_local!).query("UPDATE chunks SET bounded_text = 'older different text'").run();
      rawDb(fixture.stores.internal!).query("UPDATE items SET trust_tier = 'S4'").run();
      const wide = { scanWindow: 100_000, candidates: 1_000, embeddingLedgerPath: ledgerPath(fixture) };
      const first = await rehomePrivateTierRows({ set: fixture.set, ...wide });
      expect(first).toMatchObject({ queued: 225, moved: 0, failed: 0, refused: 225 });

      // A healthy row appears later; 225 cached refusals must cost it nothing.
      await fixture.stores.internal!.syncFromConnector(fixtureConnector(() => [ORCHID]), { fetchContent: true, placement: S4_IN_INTERNAL });
      const second = await rehomePrivateTierRows({ set: fixture.set, ...wide, maxMoves: 25 });
      expect(second).toMatchObject({ moved: 1, failed: 0, refused: 225 });
      expect(currentCorpora(fixture, 'orchid')).toEqual([CORPORA.secure_local]);
      const third = await rehomePrivateTierRows({ set: fixture.set, ...wide, maxMoves: 25 });
      expect(third.refused).toBe(225);
    });

    test('the shared queue is not read when moves are not permitted or there is nothing of ours', async () => {
      const { dir, cleanup } = tempDir('olympus-row-rehome-queue-');
      cleanups.push(cleanup);
      const { set, stores } = plainSet(dir);
      const spy = spyOn(TierLedger.prototype, 'listMoving');
      try {
        const none = await rehomePrivateTierRows({ set, embeddingLedgerPath: join(dir, 'l.jsonl') });
        expect(none.examined).toBe(0);
        expect(spy).not.toHaveBeenCalled();
        await stores.internal.syncFromConnector(fixtureConnector(() => [ORCHID]), { fetchContent: true, placement: S4_IN_INTERNAL });
        await rehomePrivateTierRows({ set, embeddingLedgerPath: join(dir, 'l.jsonl') });
        expect(spy).not.toHaveBeenCalled(); // queued, but the provider is unknown
        set.declarePrivateEmbedder(localProvider());
        await rehomePrivateTierRows({ set, embeddingLedgerPath: join(dir, 'l.jsonl') });
        expect(spy).toHaveBeenCalled();
        spy.mockClear();
        await rehomePrivateTierRows({ set, embeddingLedgerPath: join(dir, 'l.jsonl') });
        expect(spy).not.toHaveBeenCalled(); // all of ours done, nothing outstanding
      } finally {
        spy.mockRestore();
      }
    });

    test('per-sync overhead with a 5,000-row unrelated queued backlog is bounded', async () => {
      const { dir, cleanup } = tempDir('olympus-row-rehome-backlog-');
      cleanups.push(cleanup);
      const { set, ledger, stores } = plainSet(dir, localProvider());
      const publicDecision = {
        metadataTier: 'public', contentTier: 'public', decidedBy: 'default', reasons: ['backlog'], state: 'current',
        contentRead: true, metadataPending: false, contentPending: false, metadataForced: false, metadataFlagged: false,
        engineVersion: 'x', mapRevision: 'none', snifferId: 'none',
      } as const;
      (ledger as unknown as { db: { transaction(fn: () => void): () => void } }).db.transaction(() => {
        for (let index = 0; index < 5_000; index += 1) {
          const identity = { provider: 'backlog', accountScope: 'personal', providerItemId: `b${index}` };
          ledger.adoptLegacyPlacement(identity, [{ corpusId: CORPORA.internal, trustDomain: 'internal', layers: 'both' }], {
            whenMissing: { family: 'file', metadataTier: 'private', contentTier: 'private' },
          });
          ledger.recordRoutedPlacement(identity, { ...publicDecision, reasons: ['backlog'] }, {
            copies: [{ corpusId: CORPORA.secure_local, trustDomain: 'secure_local', layers: 'both' }],
            embedHold: false,
          }, { queueWithoutHiding: true });
        }
      })();
      expect(ledger.listMoving({ limit: 5_000 })).toHaveLength(5_000);
      await stores.internal.syncFromConnector(fixtureConnector(() => [ORCHID]), { fetchContent: true, placement: S4_IN_INTERNAL });
      // Worst case: an earlier call left work waiting, so the shared queue is read.
      ledger.writeMeta('private_row_rehome_outstanding', '1');
      const started = performance.now();
      const report = await rehomePrivateTierRows({ set, embeddingLedgerPath: join(dir, 'l.jsonl') });
      const elapsed = performance.now() - started;
      console.log(`row re-home pass with 5000 unrelated queued moves: ${elapsed.toFixed(0)} ms`);
      expect(report.moved).toBe(1);
      expect(elapsed).toBeLessThan(5_000);
    });

    test('a completed move whose note was lost is recorded again, once', async () => {
      const fixture = fixtureIn();
      await seedLegacy(fixture, [ORCHID]);
      const first = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
      expect(first.moved).toBe(1);
      expect(await receipts(fixture)).toBe(1);
      // The process died between the flip and the note: the file never got it.
      require('node:fs').rmSync(ledgerPath(fixture));
      expect(await receipts(fixture)).toBe(0);
      const replay = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
      expect(replay.receiptsReplayed).toBe(1);
      expect(await receipts(fixture)).toBe(1);
      const again = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
      expect(again.receiptsReplayed).toBe(0);
      expect(await receipts(fixture)).toBe(1);
    });

    for (const boundary of ['decision', 'staging', 'import'] as const) {
      test(`restart at the ${boundary} boundary: fresh handles resume to one serving copy, source bytes kept, destination searchable`, async () => {
        let fixture = fixtureIn();
        await seedLegacy(fixture, [ORCHID]);
        const before = snapshotStore(fixture.paths.internal, [localId('orchid')]).chunks
          .map((chunk) => [chunk.chunk_index, chunk.bounded_text, chunk.embedding_input_hash]);
        expect(before.length).toBeGreaterThan(0);

        if (boundary === 'import') {
          const original = LocalConnectorStore.prototype.importItemCopy;
          const spy = spyOn(LocalConnectorStore.prototype, 'importItemCopy').mockImplementationOnce(function (this: LocalConnectorStore, ...args: Parameters<typeof original>) {
            original.apply(this, args);
            throw new Error('process died after the destination write');
          });
          try {
            const crashed = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
            expect(crashed).toMatchObject({ queued: 1, moved: 0, failed: 1 });
          } finally {
            spy.mockRestore();
          }
          expect(await receipts(fixture)).toBe(0);
        } else {
          await rehomePrivateTierRows({ set: fixture.set, maxMoves: 0, embeddingLedgerPath: ledgerPath(fixture) });
          if (boundary === 'staging') {
            const record = fixture.ledger.getCurrent(identityOf('orchid'))!;
            fixture.ledger.stageMove(identityOf('orchid'), {
              expectedGeneration: record.generation,
              target: { metadataTier: 'secure', contentTier: 'secure' },
              destination: [{ corpusId: CORPORA.secure_local, trustDomain: 'secure_local', layers: 'both' }],
              hideSource: true,
            });
          }
        }

        // Everything reopened on fresh handles before resuming.
        fixture = reopen(fixture);
        const resumed = await rehomePrivateTierRows({ set: fixture.set, embeddingLedgerPath: ledgerPath(fixture) });
        expect(resumed).toMatchObject({ moved: 1, failed: 0 });
        expect(currentCorpora(fixture, 'orchid')).toEqual([CORPORA.secure_local]);
        expect(fixture.ledger.getCurrent(identityOf('orchid'))).toMatchObject({ state: 'current' });
        const after = snapshotStore(fixture.paths.internal, [localId('orchid')]).chunks
          .map((chunk) => [chunk.chunk_index, chunk.bounded_text, chunk.embedding_input_hash]);
        expect(after).toEqual(before);
        expect(searchedIn(fixture, 'orchid', 'orchid')).toEqual([CORPORA.secure_local]);
        expect(await receipts(fixture)).toBe(1);
      });
    }
  });
});

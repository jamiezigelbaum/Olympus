// Private rows left in a Personal or Public store (owner approval 2026-10-07:
// moved items are re-embedded by the local Private embedder). The pass reads
// each non-secure store's own stored row tiers, adopts legacy rows, queues the
// raise without hiding, and carries the move out itself, so an install whose
// Personal embedder is a cloud model never waits for `olympus tier migrate`.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
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
});

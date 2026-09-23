// P1b visibility and the move primitive (design sections 3.3 and 4.2).
//
// - Superseded and staged copies are never searched, served or counted.
// - One ledger snapshot judges a whole query, so an item is never returned
//   from two tiers for the same layer, including while a sync and a move run
//   beside the queries.
// - Public <-> Personal moves copy Gemini vectors with zero provider calls.
// - A raise hides first and KEEPS the cloud vectors (hidden).
// - Rollback is a ledger flip: no store write, no embed.
// - Secrets tombstone every copy and keep only the location.
// - Every move writes an embedding-ledger entry with its chunk counts.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import type { SourceIndexRoutedSearchHit } from '../src/core/source-index/router.ts';
import { readEmbeddingLedger } from '../src/workers/embedding-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import {
  CORPORA,
  FIXTURE_PLACEMENT,
  fixtureConnector,
  identityOf,
  localId,
  openTierFixture,
  snapshotStore,
  tempDir,
  type FixtureSpec,
  type TierFixture,
} from './helpers/tier-fixtures.ts';

const GARDEN: FixtureSpec = { id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden and the compost bins.' };
const LAUNCH: FixtureSpec = { id: 'launch', name: 'launch-post.txt', text: 'Our launch post about the orchard, already on the blog.', sharing: 'public_link' };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function routedFixture(specs: FixtureSpec[] = [GARDEN, LAUNCH]): Promise<TierFixture> {
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir);
  cleanups.push(() => {
    fixture.close();
    cleanup();
  });
  await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  return fixture;
}

function gateFor(fixture: TierFixture) {
  return createTierVisibilityGate(() => [{
    ledger: fixture.ledger,
    corpusIds: new Set(Object.values(CORPORA)),
  }]);
}

/** Where an item is visible right now, per layer, through the per-store filter and the gate. */
function visibility(fixture: TierFixture, term: string, id: string): { metadata: string[]; content: string[] } {
  const hits: SourceIndexRoutedSearchHit[] = [];
  const layerOf = new Map<SourceIndexRoutedSearchHit, 'metadata' | 'content'>();
  for (const store of fixture.set.openStores()) {
    for (const row of store.searchItems(term, 10)) {
      if (row.sourceItem.providerItemId !== id) continue;
      const hit: SourceIndexRoutedSearchHit = {
        sourceItem: row.sourceItem,
        corpusId: store.corpusId,
        trustDomain: store.trustDomain,
        rawExposed: false,
      };
      hits.push(hit);
      layerOf.set(hit, row.chunk ? 'content' : 'metadata');
    }
  }
  const kept = gateFor(fixture)(hits);
  return {
    metadata: kept.filter((hit) => layerOf.get(hit) === 'metadata').map((hit) => hit.corpusId),
    content: kept.filter((hit) => layerOf.get(hit) === 'content').map((hit) => hit.corpusId),
  };
}

function ledgerPath(fixture: TierFixture): string {
  return join(fixture.dir, 'embedding-ledger.jsonl');
}

describe('P1b move primitive', () => {
  test('Public <-> Personal copies the Gemini vectors: zero provider calls, first mint, never an invalidation', async () => {
    const fixture = await routedFixture([GARDEN]);
    const internalVectors = snapshotStore(fixture.paths.internal, [localId('garden')]).vectors;
    expect(internalVectors.length).toBeGreaterThan(0);
    const cloudCalls = fixture.cloud.inputs.length;
    const invalidate = spyOn(
      LocalConnectorStore.prototype as unknown as { invalidateEmbeddingModelCurrency(modelId: string): void },
      'invalidateEmbeddingModelCurrency',
    );
    try {
      const moved = await moveTieredItem({
        set: fixture.set,
        identity: identityOf('garden'),
        target: { metadataTier: 'public', contentTier: 'public' },
        vectorIdentities: { public_safe: fixture.cloud },
        embeddingLedger: { path: ledgerPath(fixture), approvedBy: 'system-automatic' },
      });
      expect(moved).toMatchObject({ outcome: 'moved', raise: false, supersededCorpora: [CORPORA.internal] });
      expect(moved.destinations).toEqual([expect.objectContaining({
        corpusId: CORPORA.public_safe,
        vectorsCopied: internalVectors.length,
        chunksToEmbed: 0,
      })]);
      expect(fixture.cloud.inputs.length).toBe(cloudCalls);
      expect(invalidate).not.toHaveBeenCalled();

      // Same vector bytes, now in the Public store under a freshly minted authority.
      const publicStore = snapshotStore(fixture.paths.public_safe, [localId('garden')]);
      expect(publicStore.vectors.map((vector) => vector.bytes)).toEqual(internalVectors.map((vector) => vector.bytes));
      expect(String(publicStore.authority[0]!.cursor)).toContain('"providerEpoch":1');
      // The copied vectors are current: a routine embed pass has nothing to do.
      const embed = await fixture.stores.public_safe!.embedChunks({ provider: fixture.cloud });
      expect(embed.chunksEmbedded).toBe(0);
      expect(fixture.cloud.inputs.length).toBe(cloudCalls);

      // Visible only in Public now; the Personal copy is kept but never served.
      expect(visibility(fixture, 'compost', 'garden')).toEqual({ metadata: [], content: [CORPORA.public_safe] });
      expect(fixture.stores.internal!.localContent(localId('garden'))).toBeUndefined();
      expect(snapshotStore(fixture.paths.internal, [localId('garden')]).vectors).toEqual(internalVectors);

      const ledger = await readEmbeddingLedger(ledgerPath(fixture));
      expect(ledger.entries[0]).toMatchObject({
        kind: 'note',
        approved_by: 'system-automatic',
        status: 'complete',
        scope: { chunks: { [CORPORA.public_safe]: internalVectors.length } },
      });
    } finally {
      invalidate.mockRestore();
    }
  });

  test('a raise hides first, keeps the cloud vectors hidden, and a rollback is a flip with no embed', async () => {
    const fixture = await routedFixture([LAUNCH]);
    const publicVectors = snapshotStore(fixture.paths.public_safe, [localId('launch')]).vectors;
    const calls = fixture.cloud.inputs.length + fixture.local.inputs.length;

    const raised = await moveTieredItem({
      set: fixture.set,
      identity: identityOf('launch'),
      target: { metadataTier: 'secure', contentTier: 'secure' },
      embeddingLedger: { path: ledgerPath(fixture), approvedBy: 'system-automatic' },
    });
    expect(raised).toMatchObject({ outcome: 'moved', raise: true, supersededCorpora: [CORPORA.public_safe] });
    // The Private store embeds later with its own model; nothing was copied across models.
    expect(raised.destinations[0]).toMatchObject({ corpusId: CORPORA.secure_local, vectorsCopied: 0 });
    expect(raised.destinations[0]!.chunksToEmbed).toBeGreaterThan(0);
    // Cloud vectors kept, byte-identical, and hidden.
    expect(snapshotStore(fixture.paths.public_safe, [localId('launch')]).vectors).toEqual(publicVectors);
    expect(visibility(fixture, 'orchard', 'launch').content).toEqual([CORPORA.secure_local]);
    const hiddenSemantic = await fixture.stores.public_safe!.vectorSearchItems('launch post orchard', fixture.cloud, 5);
    expect(hiddenSemantic).toEqual([]);
    const publicStatus = fixture.stores.public_safe!.status();
    expect(publicStatus.tier?.supersededChunks).toBeGreaterThan(0);
    expect(publicStatus.counts.chunks).toBe(0);

    const record = fixture.ledger.getCurrent(identityOf('launch'))!;
    fixture.ledger.rollbackMove(identityOf('launch'), { expectedGeneration: record.generation });
    expect(visibility(fixture, 'orchard', 'launch').content).toEqual([CORPORA.public_safe]);
    expect((await fixture.stores.public_safe!.vectorSearchItems('launch post orchard', fixture.cloud, 5)).length).toBe(1);
    // No embed happened for either direction (the query embeds above are queries, counted separately).
    const queryEmbeds = 2;
    expect(fixture.cloud.inputs.length + fixture.local.inputs.length).toBe(calls + queryEmbeds);
  });

  test('a move to Secrets tombstones every copy, deletes their vectors and keeps the location only', async () => {
    const fixture = await routedFixture([GARDEN]);
    await moveTieredItem({
      set: fixture.set,
      identity: identityOf('garden'),
      target: { metadataTier: 'public', contentTier: 'public' },
      vectorIdentities: { public_safe: fixture.cloud },
    });
    const result = await moveTieredItem({
      set: fixture.set,
      identity: identityOf('garden'),
      target: { metadataTier: 'secrets', contentTier: 'secrets' },
      embeddingLedger: { path: ledgerPath(fixture), approvedBy: 'system-automatic' },
    });
    expect(result.outcome).toBe('secrets');
    expect(result.supersededCorpora.sort()).toEqual([CORPORA.internal, CORPORA.public_safe].sort());
    for (const path of [fixture.paths.internal, fixture.paths.public_safe]) {
      const snapshot = snapshotStore(path, [localId('garden')]);
      expect(snapshot.items).toEqual([expect.objectContaining({ tombstoned: 1 })]);
      expect(snapshot.chunks).toEqual([]);
      expect(snapshot.vectors).toEqual([]);
    }
    expect(fixture.ledger.copies(identityOf('garden'))).toEqual([]);
    expect(fixture.secrets.get(identityOf('garden'))).toMatchObject({ title: 'garden-plan.txt', findingKinds: ['owner_marked_secret'] });
    const ledger = await readEmbeddingLedger(ledgerPath(fixture));
    expect(ledger.entries[0]).toMatchObject({ kind: 'invalidation', status: 'complete' });
  });

  test('a move needs a routed item: existing (legacy) items cannot be moved by accident', async () => {
    const fixture = await routedFixture([]);
    fixture.ledger.recordDecision(identityOf('old'), {
      metadataTier: 'private',
      contentTier: 'private',
      decidedBy: 'default',
      reasons: [],
      state: 'current',
      contentRead: true,
      metadataPending: false,
      contentPending: false,
      metadataForced: false,
      metadataFlagged: false,
      engineVersion: 'x',
      mapRevision: 'none',
      snifferId: 'undecided',
    });
    await expect(moveTieredItem({
      set: fixture.set,
      identity: identityOf('old'),
      target: { metadataTier: 'public', contentTier: 'public' },
    })).rejects.toThrow(/Only a routed item can move/);
  });
});

describe('P1b visibility: never searchable in two tiers', () => {
  test('one ledger snapshot judges stale per-store results: a flip between two reads never yields both copies', async () => {
    const fixture = await routedFixture([GARDEN]);
    // Read the Personal store BEFORE the move ...
    const staleInternal = fixture.stores.internal!.searchItems('compost', 5);
    expect(staleInternal).toHaveLength(1);
    await moveTieredItem({
      set: fixture.set,
      identity: identityOf('garden'),
      target: { metadataTier: 'secure', contentTier: 'secure' },
    });
    // ... and the Private store AFTER it: the per-store reads disagree ...
    const freshSecure = fixture.stores.secure_local!.searchItems('compost', 5);
    expect(freshSecure).toHaveLength(1);
    const hits: SourceIndexRoutedSearchHit[] = [
      { sourceItem: staleInternal[0]!.sourceItem, corpusId: CORPORA.internal, trustDomain: 'internal', rawExposed: false },
      { sourceItem: freshSecure[0]!.sourceItem, corpusId: CORPORA.secure_local, trustDomain: 'secure_local', rawExposed: false },
    ];
    // ... and the gate keeps exactly the current one.
    expect(gateFor(fixture)(hits).map((hit) => hit.corpusId)).toEqual([CORPORA.secure_local]);
  });

  test('every step of a move shows the item in exactly one tier per layer (or none during a raise)', async () => {
    const fixture = await routedFixture([GARDEN]);
    const id = identityOf('garden');
    const seen = () => visibility(fixture, 'compost', 'garden');
    expect(seen().content).toEqual([CORPORA.internal]);

    // Lower-or-lateral move, step by step: source current until the flip.
    fixture.ledger.stageMove(id, {
      expectedGeneration: 1,
      target: { metadataTier: 'public', contentTier: 'public' },
      destination: [{ corpusId: CORPORA.public_safe, trustDomain: 'public_safe', layers: 'both' }],
      hideSource: false,
    });
    expect(seen().content).toEqual([CORPORA.internal]);
    const exported = fixture.stores.internal!.exportItemCopy(id)!;
    fixture.set.store('public_safe', { create: true })!.importItemCopy(exported, {
      trustTier: 'S0',
      syncConnectorId: 'test_move',
    });
    // Written but staged: still only the source.
    expect(seen().content).toEqual([CORPORA.internal]);
    fixture.ledger.completeMove(id, {
      expectedGeneration: 1,
      destination: [{ corpusId: CORPORA.public_safe, trustDomain: 'public_safe', layers: 'both' }],
    });
    expect(seen().content).toEqual([CORPORA.public_safe]);

    // Raise, step by step: hidden first, then only the destination.
    fixture.ledger.stageMove(id, {
      expectedGeneration: 2,
      target: { metadataTier: 'secure', contentTier: 'secure' },
      destination: [{ corpusId: CORPORA.secure_local, trustDomain: 'secure_local', layers: 'both' }],
      hideSource: true,
    });
    expect(seen().content).toEqual([]);
    fixture.stores.secure_local!.importItemCopy(fixture.stores.public_safe!.exportItemCopy(id)!, {
      trustTier: 'S4',
      syncConnectorId: 'test_move',
    });
    expect(seen().content).toEqual([]);
    fixture.ledger.completeMove(id, {
      expectedGeneration: 2,
      destination: [{ corpusId: CORPORA.secure_local, trustDomain: 'secure_local', layers: 'both' }],
    });
    expect(seen().content).toEqual([CORPORA.secure_local]);
  });

  test('under a concurrent sync and query loop, no query ever sees an item in two tiers for one layer', async () => {
    const fixture = await routedFixture([GARDEN, LAUNCH]);
    const specs: FixtureSpec[] = [
      // Re-judged more private: queued, hidden first.
      { ...GARDEN, version: 'v2', text: 'Compost notes. IBAN GB82WEST12345698765432 for the seeds.' },
      { ...LAUNCH },
      // New items arriving in the same run, one of them split across tiers.
      { id: 'invoice', name: 'notes-0413.txt', text: 'Compost invoice total and IBAN GB82WEST12345698765432 for the transfer.' },
      ...Array.from({ length: 40 }, (_, index) => ({ id: `bulk-${index}`, name: `bulk-${index}.txt`, text: `Compost rota number ${index}.` })),
    ];
    const observations: Array<{ metadata: string[]; content: string[] }> = [];
    let done = false;
    const watcher = (async () => {
      while (!done) {
        for (const id of ['garden', 'launch', 'invoice']) observations.push(visibility(fixture, id === 'launch' ? 'orchard' : 'compost', id));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();
    await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    await moveTieredItem({
      set: fixture.set,
      identity: identityOf('launch'),
      target: { metadataTier: 'private', contentTier: 'private' },
      vectorIdentities: { internal: fixture.cloud },
    });
    for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    done = true;
    await watcher;

    expect(observations.length).toBeGreaterThan(3);
    // The loop really watched items being visible (not an empty search).
    expect(observations.filter((observation) => observation.content.length === 1).length).toBeGreaterThan(3);
    for (const observation of observations) {
      expect(observation.metadata.length).toBeLessThanOrEqual(1);
      expect(observation.content.length).toBeLessThanOrEqual(1);
    }
    // The split item: names in Personal, body in Private — each layer once.
    const invoice = visibility(fixture, 'notes', 'invoice');
    expect(invoice.content).toEqual([CORPORA.secure_local]);
    expect(visibility(fixture, 'compost', 'garden').content).toEqual([]);
  });
});

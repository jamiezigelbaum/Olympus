// P1b routing (design docs/design/per-item-four-tier-classification.md,
// sections 2, 3.2, 4.2): a tiered store set routes NEW items by their
// recorded tiers, and nothing stored before P1b moves.
//
// The core guarantee under test: an existing store that a set adopts ends with
// its existing items byte-identical (rows, chunks, vectors, vector authority),
// with zero provider calls for them, never reaching the whole-corpus
// invalidation path, and with no copy rows in the ledger (so their visibility
// is exactly what it was).

import { existsSync } from 'node:fs';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  ACCOUNT,
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
} from './helpers/tier-fixtures.ts';

const LEGACY: FixtureSpec[] = [
  { id: 'legacy-plan', name: 'legacy-plan.txt', text: 'Quarterly plan for the orchard and the irrigation work.' },
  { id: 'legacy-lab', name: 'legacy-lab.txt', text: 'Lab panel notes kept in the private store.', legacyDomain: 'secure_local' },
  // A pre-P1b item the new classifier would place elsewhere (it is Personal
  // content in a secure store). It must stay exactly where it is.
  { id: 'legacy-misplaced', name: 'legacy-misplaced.txt', text: 'Notes about the vegetable garden rota.', legacyDomain: 'secure_local' },
];

// Built at runtime: the repository refuses literal credential patterns.
const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

const NEW: FixtureSpec[] = [
  { id: 'new-garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden and the compost bins.' },
  { id: 'new-invoice', name: 'notes-0413.txt', text: 'Invoice total and IBAN GB82WEST12345698765432 for the transfer.' },
  { id: 'new-launch', name: 'launch-post.txt', text: 'Our launch post, already on the blog.', sharing: 'public_link' },
  { id: 'new-biopsy', name: 'biopsy results.txt', text: 'The lab results confirm the diagnosis; the patient starts treatment.' },
  { id: 'new-secret', name: 'env.txt', text: `aws key ${FAKE_AWS_KEY} for the deploy` },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function workspace(): string {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  return dir;
}

/** The lane before P1b: the same traversal fed to each store with the lane's placement, then embedded. */
async function populateLegacy(dir: string, specs: readonly FixtureSpec[]): Promise<void> {
  const paths = storePaths(dir);
  const internal = openLegStore(paths, 'internal');
  const secure = openLegStore(paths, 'secure_local');
  try {
    const connector = fixtureConnector(() => specs);
    await internal.syncFromConnector(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT });
    await secure.syncFromConnector(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT });
    await internal.embedChunks({ provider: cloudProvider() });
    await secure.embedChunks({ provider: localProvider() });
  } finally {
    internal.close();
    secure.close();
  }
}

const LEGACY_IDS = LEGACY.map((spec) => localId(spec.id));

describe('P1b: existing data does not move', () => {
  test('a set adopting existing stores leaves every existing item byte-identical, re-embeds nothing and never invalidates', async () => {
    const dir = workspace();
    await populateLegacy(dir, LEGACY);
    const paths = storePaths(dir);
    const before = {
      internal: snapshotStore(paths.internal, LEGACY_IDS),
      secure: snapshotStore(paths.secure_local, LEGACY_IDS),
    };
    expect(before.internal.vectors.length).toBeGreaterThan(0);
    expect(before.secure.vectors.length).toBeGreaterThan(0);

    const invalidate = spyOn(
      LocalConnectorStore.prototype as unknown as { invalidateEmbeddingModelCurrency(modelId: string): void },
      'invalidateEmbeddingModelCurrency',
    );
    const fixture = openTierFixture(dir);
    try {
      const specs = [...LEGACY, ...NEW];
      await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });

      expect(invalidate).not.toHaveBeenCalled();
      // No provider saw a single byte of an existing item.
      const legacyTexts = LEGACY.map((spec) => spec.text!);
      for (const input of [...fixture.cloud.inputs, ...fixture.local.inputs]) {
        expect(legacyTexts.some((text) => input.includes(text))).toBe(false);
      }
      // Existing items: never routed, no copy rows, so visibility is unchanged.
      for (const spec of LEGACY) {
        expect(fixture.ledger.isRouted(identityOf(spec.id))).toBe(false);
        expect(fixture.ledger.copies(identityOf(spec.id))).toEqual([]);
      }
    } finally {
      invalidate.mockRestore();
      fixture.close();
    }

    const after = {
      internal: snapshotStore(paths.internal, LEGACY_IDS),
      secure: snapshotStore(paths.secure_local, LEGACY_IDS),
    };
    // Rows (meaningful columns), chunks, vectors (bytes and embedded_at),
    // ownership and the embedding write authority: all identical.
    expect(after.internal).toEqual(before.internal);
    expect(after.secure).toEqual(before.secure);
    // The misplaced legacy item is still in the secure store, at S4.
    expect(after.secure.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ local_item_id: localId('legacy-misplaced'), trust_tier: 'S4', tombstoned: 0 }),
    ]));
  });

  test('without any new item the set creates no store and writes no copy row', async () => {
    const dir = workspace();
    await populateLegacy(dir, LEGACY);
    const fixture = openTierFixture(dir);
    try {
      await fixture.set.sync(fixtureConnector(() => LEGACY), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      expect(existsSync(fixture.paths.public_safe)).toBe(false);
      expect(fixture.ledger.corpusHasCopies(CORPORA.internal)).toBe(false);
      expect(fixture.ledger.corpusHasCopies(CORPORA.secure_local)).toBe(false);
    } finally {
      fixture.close();
    }
  });
});

describe('P1b: new items are routed by their recorded tiers', () => {
  test('Personal, split, Public, pending and Secrets items land where their tiers say', async () => {
    const dir = workspace();
    const fixture = openTierFixture(dir);
    const invalidate = spyOn(
      LocalConnectorStore.prototype as unknown as { invalidateEmbeddingModelCurrency(modelId: string): void },
      'invalidateEmbeddingModelCurrency',
    );
    try {
      const run = await fixture.set.sync(fixtureConnector(() => NEW), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      expect(run.routing).toMatchObject({ itemsRouted: 4, itemsSecrets: 1, itemsPendingHeld: 1, itemsLegacy: 0 });

      const copies = (id: string) => fixture.ledger.copies(identityOf(id)).map((copy) => [copy.corpusId, copy.layers, copy.state, copy.embedHold]);
      expect(copies('new-garden')).toEqual([[CORPORA.internal, 'both', 'current', false]]);
      // The two-tier invariant: Personal names, Private body.
      expect(copies('new-invoice')).toEqual([
        [CORPORA.internal, 'metadata', 'current', false],
        [CORPORA.secure_local, 'content', 'current', false],
      ]);
      expect(copies('new-launch')).toEqual([[CORPORA.public_safe, 'both', 'current', false]]);
      // Pending is Private: the whole item in the secure store, held back from embedding.
      expect(copies('new-biopsy')).toEqual([[CORPORA.secure_local, 'both', 'current', true]]);
      expect(copies('new-secret')).toEqual([]);

      const internal = snapshotStore(fixture.paths.internal);
      const secure = snapshotStore(fixture.paths.secure_local);
      const publicStore = snapshotStore(fixture.paths.public_safe);
      const chunksOf = (snapshot: typeof internal, id: string) => snapshot.chunks.filter((chunk) => chunk.local_item_id === localId(id)).length;
      const vectorsOf = (snapshot: typeof internal, id: string) => snapshot.vectors.filter((vector) => vector.local_item_id === localId(id)).length;
      expect(chunksOf(internal, 'new-invoice')).toBe(0);
      expect(chunksOf(secure, 'new-invoice')).toBeGreaterThan(0);
      expect(vectorsOf(secure, 'new-invoice')).toBeGreaterThan(0);
      expect(vectorsOf(internal, 'new-garden')).toBeGreaterThan(0);
      expect(vectorsOf(publicStore, 'new-launch')).toBeGreaterThan(0);
      // Held: stored and keyword-searchable, never embedded.
      expect(chunksOf(secure, 'new-biopsy')).toBeGreaterThan(0);
      expect(vectorsOf(secure, 'new-biopsy')).toBe(0);
      expect([...fixture.local.inputs, ...fixture.cloud.inputs].some((input) => input.includes('patient starts treatment'))).toBe(false);
      // Secrets: in no store, no provider call, location only.
      for (const snapshot of [internal, secure, publicStore]) {
        expect(snapshot.items.some((item) => item.local_item_id === localId('new-secret'))).toBe(false);
      }
      expect([...fixture.local.inputs, ...fixture.cloud.inputs].some((input) => input.includes('AKIA'))).toBe(false);
      expect(fixture.secrets.get(identityOf('new-secret'))).toMatchObject({
        source: 'fixture',
        locator: '/Files/env.txt',
        title: 'env.txt',
        findingKinds: ['aws_access_key_id'],
      });
      // The Public store was created for its first item: a first mint, never a rebind.
      expect(publicStore.authority).toHaveLength(1);
      expect(String(publicStore.authority[0]!.cursor)).toContain('"providerEpoch":1');
      expect(invalidate).not.toHaveBeenCalled();
      // Ledger decisions recorded with the placement.
      expect(fixture.ledger.getCurrent(identityOf('new-invoice'))).toMatchObject({
        routed: true,
        metadataTier: 'private',
        contentTier: 'secure',
        storedTrustDomain: 'secure_local',
      });
    } finally {
      invalidate.mockRestore();
      fixture.close();
    }
  });

  test('a new item whose content was not read keeps the lane placement and is not routed', async () => {
    const dir = workspace();
    const fixture = openTierFixture(dir, { embed: false });
    try {
      const unread: FixtureSpec[] = [{ id: 'unread', name: 'scan-0001.pdf', legacyDomain: 'secure_local' }];
      const run = await fixture.set.sync(fixtureConnector(() => unread), { placement: FIXTURE_PLACEMENT });
      expect(run.routing.itemsLegacy).toBe(1);
      expect(fixture.ledger.isRouted(identityOf('unread'))).toBe(false);
      expect(fixture.stores.secure_local!.itemPresence(identityOf('unread')).active).toBe(true);
      expect(fixture.stores.internal!.itemPresence(identityOf('unread')).active).toBe(false);
      expect(existsSync(fixture.paths.public_safe)).toBe(false);
    } finally {
      fixture.close();
    }
  });

  test('a chat lane keeps an item whole in the more private store', async () => {
    const dir = workspace();
    const fixture = openTierFixture(dir, { embed: false, splitLayers: false });
    try {
      await fixture.set.sync(fixtureConnector(() => [NEW[1]!]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      expect(fixture.ledger.copies(identityOf('new-invoice')).map((copy) => [copy.corpusId, copy.layers]))
        .toEqual([[CORPORA.secure_local, 'both']]);
      expect(fixture.stores.internal!.hasItemRow(identityOf('new-invoice'))).toBe(false);
    } finally {
      fixture.close();
    }
  });

  test('the set resume point is committed only after every leg committed', async () => {
    const dir = workspace();
    const fixture = openTierFixture(dir, { embed: false });
    try {
      const connector = fixtureConnector(() => [NEW[0]!], { cursor: 'page-7' });
      // The secure leg fails after the internal leg committed.
      const failing = spyOn(fixture.stores.secure_local!, 'syncFromConnector')
        .mockImplementation(() => Promise.reject(new Error('secure leg failed')));
      await expect(fixture.set.sync(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT })).rejects.toThrow('secure leg failed');
      failing.mockRestore();
      expect(fixture.set.committedCursor(connector.id)).toBeUndefined();
      // The internal leg had already committed its own run: exactly the
      // window a per-store resume point would have skipped the secure leg past.
      expect(fixture.stores.internal!.lastCompletedSyncRun(connector.id)?.cursor).toBe('page-7');
    } finally {
      fixture.close();
    }
    const reopened = openTierFixture(dir, { embed: false });
    try {
      const connector = fixtureConnector(() => [NEW[0]!], { cursor: 'page-7' });
      await reopened.set.sync(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT });
      expect(reopened.set.committedCursor(connector.id)?.cursor).toBe('page-7');
    } finally {
      reopened.close();
    }
  });

  test('status reports pending items, and they leave the parity denominator', async () => {
    const dir = workspace();
    const fixture = openTierFixture(dir);
    try {
      await fixture.set.sync(fixtureConnector(() => NEW), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      const status = fixture.stores.secure_local!.status();
      expect(status.tier).toEqual({ pendingClassificationItems: 1, supersededChunks: 0, tierMoveInProgress: 0 });
      // Parity: every chunk in the denominator is embedded (the held one is out of it).
      expect(status.counts.embeddedChunks).toBe(status.counts.chunks);
      // A store with no routed copies reports no tier block at all (unchanged shape).
      const dir2 = workspace();
      await populateLegacy(dir2, LEGACY);
      const legacyOnly = openLegStore(storePaths(dir2), 'internal');
      try {
        expect(legacyOnly.status().tier).toBeUndefined();
      } finally {
        legacyOnly.close();
      }
    } finally {
      fixture.close();
    }
  });

  test('a routed item re-judged more private is hidden at once and queued, never moved by the sync', async () => {
    const dir = workspace();
    const fixture = openTierFixture(dir);
    try {
      const specs: FixtureSpec[] = [{ ...NEW[0]! }];
      await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      expect(fixture.stores.internal!.searchItems('compost', 5)).toHaveLength(1);
      const vectorsBefore = snapshotStore(fixture.paths.internal, [localId('new-garden')]).vectors;

      specs[0] = { ...specs[0]!, version: 'v2', text: 'Compost notes. IBAN GB82WEST12345698765432 for the seeds.' };
      const run = await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      expect(run.routing.movesQueued).toBe(1);
      expect(fixture.ledger.getCurrent(identityOf('new-garden'))).toMatchObject({ state: 'moving', targetContentTier: 'secure' });
      // Hidden first; the Personal copy (and its cloud vectors) is kept, not rewritten.
      expect(fixture.stores.internal!.searchItems('compost', 5)).toEqual([]);
      expect(snapshotStore(fixture.paths.internal, [localId('new-garden')]).vectors).toEqual(vectorsBefore);
      expect(fixture.stores.secure_local!.hasItemRow(identityOf('new-garden'))).toBe(false);
      expect(fixture.stores.internal!.status().tier).toMatchObject({ tierMoveInProgress: 1 });
      expect(fixture.stores.internal!.status().tier!.supersededChunks).toBeGreaterThan(0);
    } finally {
      fixture.close();
    }
  });
});

describe('P1b: per-leg lanes hand routed items to the right leg before their cursor moves', () => {
  test('an item listed by the Personal leg whose content is Private is written to the secure leg inline', async () => {
    const dir = workspace();
    const fixture = openTierFixture(dir, { embed: false });
    try {
      const internalLane = fixtureConnector(() => [NEW[1]!, NEW[0]!], { id: 'lane_internal', cursor: 'internal:2' });
      const secureLane = fixtureConnector(() => [], { id: 'lane_secure', cursor: 'secure:0' });
      await fixture.set.syncLegs([
        { trustDomain: 'internal', connector: internalLane, sync: { fetchContent: true, placement: FIXTURE_PLACEMENT } },
        { trustDomain: 'secure_local', connector: secureLane, sync: { fetchContent: true, placement: FIXTURE_PLACEMENT } },
      ]);
      // Split: names stay with the listing leg, the body went to the secure leg.
      expect(fixture.stores.secure_local!.exportItemCopy(identityOf('new-invoice'))?.chunks.length).toBeGreaterThan(0);
      expect(fixture.stores.internal!.exportItemCopy(identityOf('new-invoice'))?.chunks).toEqual([]);
      // The lanes' own cursors are untouched by the hand-off.
      expect(fixture.stores.internal!.lastCompletedSyncRun('lane_internal')?.cursor).toBe('internal:2');
      expect(fixture.stores.secure_local!.lastCompletedSyncRun('lane_secure')?.cursor).toBe('secure:0');
    } finally {
      fixture.close();
    }
  });
});

describe('P1b: deletion', () => {
  test('a provider deletion removes the current and the superseded copies, and the location of a deleted secret', async () => {
    const dir = workspace();
    const fixture = openTierFixture(dir);
    try {
      const specs: FixtureSpec[] = [{ ...NEW[0]! }, { ...NEW[4]! }];
      await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      // Re-judge more private: the Personal copy becomes superseded (kept).
      specs[0] = { ...specs[0]!, version: 'v2', text: 'Compost notes. IBAN GB82WEST12345698765432 for the seeds.' };
      await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      expect(fixture.ledger.copies(identityOf('new-garden'))[0]?.state).toBe('superseded');

      specs[0] = { ...specs[0]!, deleted: true };
      specs[1] = { ...specs[1]!, deleted: true };
      const run = await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      expect(run.routing.routedDeletions).toBe(2);
      const internal = snapshotStore(fixture.paths.internal, [localId('new-garden')]);
      expect(internal.items).toEqual([expect.objectContaining({ tombstoned: 1 })]);
      expect(internal.chunks).toEqual([]);
      expect(internal.vectors).toEqual([]);
      expect(fixture.ledger.copies(identityOf('new-garden'))).toEqual([]);
      expect(fixture.ledger.isRouted(identityOf('new-garden'))).toBe(true);
      expect(fixture.secrets.get(identityOf('new-secret'))).toBeUndefined();
    } finally {
      fixture.close();
    }
  });
});

export { ACCOUNT };

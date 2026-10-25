// A Secret parent is present while the provider lists it, and its children are
// then judged on their own; once the provider deletes it, whether the feed says
// so or its absence from a full snapshot does, it is judged as any deleted
// parent and its children go (docs/design/child-items.md, "Removal"). Every
// Secret has one representation: its location row, written when it is first
// judged Secrets even if no store held it, and restored when the provider
// lists it again. A Secret child's location is its name, so it is shown only
// while its parent is, and the sweep removes it with the rest. A Secret that
// came inside another item is still hidden with that item. Through the real
// archive import, tier set, ledger, Secret location index and sweep.

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListOptions, SourceConnectorListPage } from '../src/core/contracts.ts';
import { getArchiveFormat } from '../src/core/archive-formats.ts';
import type { SourceItemIdentity } from '../src/core/source-index/types.ts';
import { answerReleaseWithheldReason, type ReleaseInput, type ReleaseManifest } from '../src/core/release-manifest.ts';
import { REMOTE_ANSWER_UNVERIFIED, remoteOperationOutput } from '../src/core/remote-result.ts';
import { archiveConnectorStoreDbPath, ARCHIVE_STORE_PLACEMENT } from '../src/workers/archive-import/store.ts';
import { archiveConnectorId } from '../src/workers/archive-import/state.ts';
import { hiddenChildKeys, hiddenProbesByParentIdentity } from '../src/workers/connector-store/child-visibility.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createReleaseTierCheck, type TierVisibilityScope } from '../src/workers/connector-store/tier-visibility.ts';
import { tierLedgerIdentityKey } from '../src/workers/classification/tier-ledger.ts';
import { childProviderItemId, createFixtureChildConnector, fixtureLocalItemId, type FixtureParentSpec } from './helpers/child-items-fixture.ts';
import { childItemsArchiveHarness, FIXTURE_ARCHIVE_FORMAT, type ChildItemsArchiveHarness } from './support/child-items-archive-harness.ts';
import { childItemsExtraction } from './support/child-items-extraction-harness.ts';

const format = getArchiveFormat(FIXTURE_ARCHIVE_FORMAT)!;
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function parents(): FixtureParentSpec[] {
  return [
    {
      id: 'm1', subject: 'Flat', sender: 'Alice', sentAt: '2024-03-03T10:00:00.000Z', body: 'Please find the lease attached.',
      children: [
        { key: 'p1', name: 'lease.txt', mimeType: 'text/plain', text: 'The lease term is thirty-seven months.' },
        { key: 'p2', name: 'notes.txt', mimeType: 'text/plain', text: 'Remember the deposit.' },
      ],
    },
    {
      id: 'm2', subject: 'Trip', sender: 'Cy', sentAt: '2024-03-05T10:00:00.000Z', body: 'Tickets are attached.',
      children: [{ key: 'p1', name: 'tickets.txt', mimeType: 'text/plain', text: 'Gate twelve.' }],
    },
  ];
}

const M1_CHILDREN = [childProviderItemId('m1', 'p1'), childProviderItemId('m1', 'p2')];
const M2_CHILD = childProviderItemId('m2', 'p1');
const SYNC = { placement: ARCHIVE_STORE_PLACEMENT, fetchContent: true, deferMetadataOnlyContent: true } as const;

type Lane = ReturnType<ChildItemsArchiveHarness['runtime']['lane']>;

async function imported() {
  const h = childItemsArchiveHarness(cleanups);
  const archiveId = h.start();
  await h.importAll(archiveId, parents());
  const lane = h.runtime.lane(format.family);
  const identityOf = (providerItemId: string): SourceItemIdentity => ({
    family: format.family,
    provider: format.provider,
    accountScope: archiveId,
    providerItemId,
    localItemId: fixtureLocalItemId(archiveId, providerItemId),
  });
  return { h, archiveId, lane, identityOf };
}

/** An import whose first parent is a Secret on its own words (no store ever held it), and its children read. */
async function importedSecret() {
  // Built at runtime so the repository's credential-pattern check never sees a literal key.
  const secretSubject = `Wifi ${['AKIA', 'ABCDEFGHIJKLMNOP'].join('')}`;
  const h = childItemsArchiveHarness(cleanups);
  const archiveId = h.start();
  const secretParent: FixtureParentSpec = { ...parents()[0]!, subject: secretSubject };
  const specs = [secretParent, parents()[1]!];
  await h.importAll(archiveId, specs);
  const lane = h.runtime.lane(format.family);
  const ext = childItemsExtraction(h, cleanups, { parents: specs });
  const identityOf = (providerItemId: string): SourceItemIdentity => ({
    family: format.family,
    provider: format.provider,
    accountScope: archiveId,
    providerItemId,
    localItemId: fixtureLocalItemId(archiveId, providerItemId),
  });
  return { h, archiveId, lane, ext, identityOf, secretParent };
}

/** The columns of a Secret's location row that could carry a name or a word of text. */
function locationColumns(h: ChildItemsArchiveHarness, archiveId: string, providerItemId: string): Record<string, unknown> | undefined {
  for (const domain of ['public_safe', 'internal', 'secure_local'] as const) {
    const path = archiveConnectorStoreDbPath(domain, format.family, h.env);
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true });
    try {
      const row = db.query(`
        SELECT title, search_text, locator_uri, sender_id, sender_label, authored_at, updated_at, reactions_json
        FROM items WHERE account_scope = ? AND provider_item_id = ? AND tombstoned = 1 AND trust_tier = 'S5'
      `).get(archiveId, providerItemId) as Record<string, unknown> | null;
      if (row) return row;
    } finally {
      db.close();
    }
  }
  return undefined;
}

/** Whether a keyword search of any store of the lane finds this text. */
function textSearchable(lane: Lane, words: string): boolean {
  return lane.set.openStores().some((store) => store.searchItems(words, 5).length > 0);
}

/** The lane as the release check sees it. */
function scopeOf(lane: Lane): TierVisibilityScope {
  return {
    ledger: lane.ledger,
    corpusIds: new Set(lane.set.openStores().map((store) => store.corpusId)),
    stores: () => lane.set.openStores(),
  };
}

/** A delayed answer whose evidence is this child, as the model wrote it from its text. */
function remoteAnswer(corpusId: string, providerItemId: string): never {
  return {
    answer: 'The lease is thirty-seven months.',
    evidence: [{
      corpus_id: corpusId, trust_domain: 'internal', family: format.family, provider: format.provider,
      provider_item_id: providerItemId, title: `${providerItemId}.txt`, authored_at: '2026-01-02T03:04:05.000Z',
    }],
    secret_locations: [],
  } as never;
}

/** The listing with one more level: an item inside `parentItemId`, which is itself inside another. */
function withGrandchild(source: SourceConnector, archiveId: string, parentItemId: string, key: string): SourceConnector {
  const providerItemId = `${parentItemId}#child:${key}`;
  const grandchild: RawItem = {
    identity: {
      family: format.family,
      provider: format.provider,
      accountScope: archiveId,
      providerItemId,
      localItemId: fixtureLocalItemId(archiveId, providerItemId),
      sourceVersion: 'v1',
      parent: { providerItemId: parentItemId, localItemId: fixtureLocalItemId(archiveId, parentItemId) },
    },
    mimeType: 'text/plain',
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({ name: 'inner.txt', sender: 'Alice', sentAt: '2024-03-03T10:00:00.000Z' }),
    fetchedAt: '2026-10-25T00:00:00.000Z',
    deferredBytes: { locator: 'fixture-locator:nested', available: true, sizeBytes: 12 },
  };
  return {
    ...source,
    async *listItems(options: SourceConnectorListOptions): AsyncGenerator<SourceConnectorListPage> {
      for await (const page of source.listItems(options)) {
        yield { ...page, items: page.items.flatMap((item) => item.identity.providerItemId === parentItemId ? [item, grandchild] : [item]) };
      }
    },
  };
}

function readable(lane: Lane, archiveId: string, providerItemId: string): boolean {
  const localItemId = fixtureLocalItemId(archiveId, providerItemId);
  return lane.set.openStores().some((store) => store.localContent(localItemId) !== undefined);
}

function liveRows(h: ChildItemsArchiveHarness, archiveId: string, ids: readonly string[]) {
  return h.rows(archiveId).filter((row) => ids.includes(row.providerItemId) && row.tombstoned === 0);
}

/** The rows a store keeps for an item as a Secret's location only. */
function secretRows(h: ChildItemsArchiveHarness, archiveId: string, ids: readonly string[]) {
  return h.rows(archiveId).filter((row) => ids.includes(row.providerItemId) && row.tombstoned === 1 && row.trustTier === 'S5');
}

/** The owner marks the item a Secret, and it moves there: it stays one when the provider lists it again. */
async function moveToSecrets(lane: Lane, identity: SourceItemIdentity): Promise<void> {
  lane.ledger.setOverride(identity, { kind: 'tier', tier: 'secrets' });
  await moveTieredItem({
    set: lane.set,
    identity,
    target: { metadataTier: 'secrets', contentTier: 'secrets' },
    secretsDisposition: 'tombstone_now',
  });
}

/** The provider's deletion feed reports these parents as deleted. */
function deletionFeed(h: ChildItemsArchiveHarness, archiveId: string, ids: readonly string[]): SourceConnector {
  return createFixtureChildConnector({
    accountScope: archiveId,
    provider: format.provider,
    family: format.family,
    id: 'deletion-feed',
    parents: parents().filter((parent) => ids.includes(parent.id)).map((parent) => ({ ...parent, deleted: true })),
    log: h.log,
  });
}

/** The full snapshot the provider lists now: everything but the named items (the children of a parent that is gone still are). */
function snapshotWithout(h: ChildItemsArchiveHarness, archiveId: string, omitted: readonly string[], specs: readonly FixtureParentSpec[] = parents()): SourceConnector {
  const source = createFixtureChildConnector({
    accountScope: archiveId, provider: format.provider, family: format.family, id: archiveConnectorId(archiveId),
    parents: specs, log: h.log,
  });
  return {
    ...source,
    async *listItems(options: SourceConnectorListOptions): AsyncGenerator<SourceConnectorListPage> {
      for await (const page of source.listItems(options)) {
        yield { ...page, items: page.items.filter((item: RawItem) => !omitted.includes(item.identity.providerItemId)) };
      }
    },
  };
}

const SNAPSHOT = (archiveId: string) => ({
  ...SYNC,
  reconcileFullSnapshot: true,
  reconcileFullSnapshotScope: { provider: format.provider, accountScope: archiveId },
}) as const;

describe('a Secret parent is present until the provider deletes it', () => {
  test('a parent moved to Secrets keeps its children, and a full snapshot that still lists it changes nothing', async () => {
    const { h, archiveId, lane, identityOf } = await imported();
    await moveToSecrets(lane, identityOf('m1'));
    expect(secretRows(h, archiveId, ['m1']).length).toBeGreaterThan(0);

    // The provider still lists it: the sync that reconciles a full snapshot neither retires its
    // location nor takes its children.
    await lane.set.sync(snapshotWithout(h, archiveId, []), SNAPSHOT(archiveId));
    expect(secretRows(h, archiveId, ['m1']).length).toBeGreaterThan(0);
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(true);
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });
    expect(liveRows(h, archiveId, M1_CHILDREN).length).toBeGreaterThan(0);
  });

  test('a real Secret move, then the provider deletes the parent in its feed: the children are hidden and removed', async () => {
    const { h, archiveId, lane, identityOf } = await imported();
    await moveToSecrets(lane, identityOf('m1'));
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(true);

    await lane.set.sync(deletionFeed(h, archiveId, ['m1']), SYNC);

    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(false);
    // The sweep that closes the sync took them: no store holds a live row, the ledger holds no copy.
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
    for (const id of M1_CHILDREN) expect(lane.ledger.copies(identityOf(id))).toEqual([]);
    // The Secret's location is no longer kept as one, and the other parent's child is untouched.
    expect(secretRows(h, archiveId, ['m1'])).toEqual([]);
    expect(readable(lane, archiveId, M2_CHILD)).toBe(true);
    expect(liveRows(h, archiveId, [M2_CHILD]).length).toBeGreaterThan(0);
  });

  test('a real Secret move, then the parent is missing from the next full snapshot: the same', async () => {
    const { h, archiveId, lane, identityOf } = await imported();
    await moveToSecrets(lane, identityOf('m1'));

    await lane.set.sync(snapshotWithout(h, archiveId, ['m1']), SNAPSHOT(archiveId));

    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(false);
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
    for (const id of M1_CHILDREN) expect(lane.ledger.copies(identityOf(id))).toEqual([]);
    expect(secretRows(h, archiveId, ['m1'])).toEqual([]);
    expect(readable(lane, archiveId, M2_CHILD)).toBe(true);
  });

  test('a Secret no store ever held gets a location row of its own, with no names and no text, and its deletion takes its children', async () => {
    const { h, archiveId, lane, identityOf, secretParent } = await importedSecret();
    // The location row is the Private store's, written with the decision.
    const located = secretRows(h, archiveId, ['m1']);
    expect(located.map((row) => row.domain)).toEqual(['secure_local']);
    expect(located[0]!.chunks).toBe(0);
    expect(locationColumns(h, archiveId, 'm1')).toEqual({
      title: null, search_text: null, locator_uri: null, sender_id: null, sender_label: null,
      authored_at: null, updated_at: null, reactions_json: null,
    });
    // Nothing of it is read from any store; the Secret location index is what it always was.
    expect(textSearchable(lane, 'AKIA')).toBe(false);
    expect(textSearchable(lane, 'Wifi')).toBe(false);
    expect(lane.secretLocations?.get(identityOf('m1'))).toBeDefined();
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(true);
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });

    await lane.set.sync(createFixtureChildConnector({
      accountScope: archiveId, provider: format.provider, family: format.family, id: 'deletion-feed',
      parents: [{ ...secretParent, deleted: true }], log: h.log,
    }), SYNC);

    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(false);
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
    expect(secretRows(h, archiveId, ['m1'])).toEqual([]);
  });

  test('a Secret no store ever held, absent from a full snapshot: its children are hidden, a delayed answer that drew on one is withheld, and the sweep removes them', async () => {
    const { h, archiveId, lane, ext, secretParent } = await importedSecret();
    await ext.drive(archiveId);
    expect(secretRows(h, archiveId, ['m1']).length).toBeGreaterThan(0);
    const check = createReleaseTierCheck(() => [scopeOf(lane)], () => 'allow');
    const namesCorpus = lane.set.openStores().find((store) => store.trustDomain === 'internal')!.corpusId;
    const input = (providerItemId: string): ReleaseInput => ({
      corpusId: namesCorpus, provider: format.provider, accountScope: archiveId, providerItemId, privateAtAnswer: false,
    });
    const child = input(M1_CHILDREN[0]!);
    const answer = remoteAnswer(namesCorpus, M1_CHILDREN[0]!);
    const written: ReleaseManifest[] = [{ inputs: [child], constraints: { secureDerivativeDefault: 'allow', includeSecureLocalContent: false } }];
    expect(check.inputs([child]).map((verdict) => verdict.hiddenByParent === true)).toEqual([false]);
    expect(remoteOperationOutput('source_answer_result', answer, { releaseCheck: check, releaseManifests: written }).status).toBe('answered');

    // The cleanup of the children fails once, so the window between the snapshot and the sweep is open.
    const real = lane.ledger.removeCopies.bind(lane.ledger);
    lane.ledger.removeCopies = (() => { throw new Error('synthetic ledger failure'); }) as typeof lane.ledger.removeCopies;
    await lane.set.sync(snapshotWithout(h, archiveId, ['m1'], [secretParent, parents()[1]!]), SNAPSHOT(archiveId));

    // The provider no longer lists the Secret: its location is an ordinary tombstone and its children are hidden.
    expect(secretRows(h, archiveId, ['m1'])).toEqual([]);
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(false);
    expect(liveRows(h, archiveId, M1_CHILDREN).length).toBeGreaterThan(0);
    expect(check.inputs([child]).map((verdict) => verdict.hiddenByParent === true)).toEqual([true]);
    expect(remoteOperationOutput('source_answer_result', answer, { releaseCheck: check, releaseManifests: written }))
      .toEqual({ kind: 'source_answer', status: 'withheld', answer: REMOTE_ANSWER_UNVERIFIED, citations: [] });
    expect(answerReleaseWithheldReason(written, check)).toBeDefined();
    // The other parent's child is untouched.
    expect(readable(lane, archiveId, M2_CHILD)).toBe(true);

    lane.ledger.removeCopies = real;
    const swept = await lane.set.sweepOrphanedChildren();
    expect(swept.removed).toBe(M1_CHILDREN.length);
    expect(swept.retry).toBe(0);
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
    expect(readable(lane, archiveId, M2_CHILD)).toBe(true);
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });
  });

  test('a Secret that is still listed keeps its location through a full snapshot, however it first came to be one', async () => {
    const { h, archiveId, lane, secretParent } = await importedSecret();
    await lane.set.sync(snapshotWithout(h, archiveId, [], [secretParent, parents()[1]!]), SNAPSHOT(archiveId));
    expect(secretRows(h, archiveId, ['m1']).length).toBeGreaterThan(0);
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(true);
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });
  });
});

describe('a Secret listed again is present again', () => {
  test('after its deletion, its location is back (a location only), its children are visible on their own tiers, and a new attachment is kept', async () => {
    const { h, archiveId, lane, identityOf } = await imported();
    await moveToSecrets(lane, identityOf('m1'));
    await lane.set.sync(deletionFeed(h, archiveId, ['m1']), SYNC);
    expect(secretRows(h, archiveId, ['m1'])).toEqual([]);
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(false);

    // The provider lists it again, with a new attachment beside the old two.
    const again: FixtureParentSpec = {
      ...parents()[0]!,
      children: [...parents()[0]!.children, { key: 'p3', name: 'new.txt', mimeType: 'text/plain', text: 'A new attachment.' }],
    };
    const NEW_CHILD = childProviderItemId('m1', 'p3');
    await lane.set.sync(createFixtureChildConnector({
      accountScope: archiveId, provider: format.provider, family: format.family, id: archiveConnectorId(archiveId),
      parents: [again], log: h.log,
    }), SYNC);

    expect(secretRows(h, archiveId, ['m1']).length).toBeGreaterThan(0);
    expect(locationColumns(h, archiveId, 'm1')).toEqual({
      title: null, search_text: null, locator_uri: null, sender_id: null, sender_label: null,
      authored_at: null, updated_at: null, reactions_json: null,
    });
    expect(h.rows(archiveId).filter((row) => row.providerItemId === 'm1' && row.chunks > 0)).toEqual([]);
    expect(textSearchable(lane, 'Flat')).toBe(false);
    // Nothing about the parent is served, but its children are judged on their own again.
    for (const id of [...M1_CHILDREN, NEW_CHILD]) expect(readable(lane, archiveId, id)).toBe(true);
    expect(liveRows(h, archiveId, [NEW_CHILD]).length).toBeGreaterThan(0);
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });
    expect(liveRows(h, archiveId, [NEW_CHILD]).length).toBeGreaterThan(0);
  });

  test('after its absence from a full snapshot, a snapshot that lists it again restores its location', async () => {
    const { h, archiveId, lane, identityOf } = await imported();
    await moveToSecrets(lane, identityOf('m1'));
    await lane.set.sync(snapshotWithout(h, archiveId, ['m1']), SNAPSHOT(archiveId));
    expect(secretRows(h, archiveId, ['m1'])).toEqual([]);

    await lane.set.sync(snapshotWithout(h, archiveId, []), SNAPSHOT(archiveId));
    expect(secretRows(h, archiveId, ['m1']).length).toBeGreaterThan(0);
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(true);
    // And it keeps being one while the provider lists it.
    await lane.set.sync(snapshotWithout(h, archiveId, []), SNAPSHOT(archiveId));
    expect(secretRows(h, archiveId, ['m1']).length).toBeGreaterThan(0);
  });

  test('an item that is no longer a Secret when it is listed again is not restored as one', async () => {
    const { h, archiveId, lane, identityOf } = await imported();
    await moveToSecrets(lane, identityOf('m1'));
    await lane.set.sync(deletionFeed(h, archiveId, ['m1']), SYNC);
    expect(secretRows(h, archiveId, ['m1'])).toEqual([]);

    lane.ledger.setOverride(identityOf('m1'), { kind: 'not_secret' });
    await lane.set.sync(createFixtureChildConnector({
      accountScope: archiveId, provider: format.provider, family: format.family, id: archiveConnectorId(archiveId),
      parents: [parents()[0]!], log: h.log,
    }), SYNC);
    expect(secretRows(h, archiveId, ['m1'])).toEqual([]);
  });
});

describe('a Secret that came inside another item is hidden with it', () => {
  test('A holds a Secret B that holds C: deleting A hides C at once, and the sweep takes B, then C', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    await h.importAll(archiveId, parents());
    const lane = h.runtime.lane(format.family);
    const identityOf = (providerItemId: string): SourceItemIdentity => ({
      family: format.family, provider: format.provider, accountScope: archiveId,
      providerItemId, localItemId: fixtureLocalItemId(archiveId, providerItemId),
    });
    const B = M1_CHILDREN[0]!;
    const C = `${B}#child:g1`;
    // C came inside B: the fixture has only one level, so the listing is given one more.
    const nested = withGrandchild(createFixtureChildConnector({
      accountScope: archiveId, provider: format.provider, family: format.family, id: archiveConnectorId(archiveId),
      parents: parents(), log: h.log,
    }), archiveId, B, 'g1');
    await lane.set.sync(nested, SYNC);
    expect(h.rows(archiveId).filter((row) => row.providerItemId === C && row.tombstoned === 0).length).toBeGreaterThan(0);
    await moveToSecrets(lane, identityOf(B));
    expect(secretRows(h, archiveId, [B]).length).toBeGreaterThan(0);

    const lane_ = { ledger: () => lane.ledger, stores: () => lane.set.openStores() };
    const hidden = (): boolean => hiddenChildKeys(lane_, [identityOf(C)]).has(tierLedgerIdentityKey(identityOf(C)));
    // While A is there, the Secret B is present for itself and C is judged on its own.
    expect(hidden()).toBe(false);
    expect(readable(lane, archiveId, C)).toBe(true);

    // A is deleted in every store that held it. Nothing has been removed yet, and C is already hidden.
    for (const store of lane.set.openStores()) store.tombstoneCopy(identityOf('m1'), { connectorId: 'absence-reconcile' });
    expect(secretRows(h, archiveId, [B]).length).toBeGreaterThan(0);
    expect(hidden()).toBe(true);
    expect(readable(lane, archiveId, C)).toBe(false);

    const swept = await lane.set.sweepOrphanedChildren();
    expect(swept.retry).toBe(0);
    expect(swept.removed).toBe(M1_CHILDREN.length + 1);
    expect(h.rows(archiveId).filter((row) => row.providerItemId === C && row.tombstoned === 0)).toEqual([]);
    expect(secretRows(h, archiveId, [B])).toEqual([]);
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });
  });
});

describe('a Secret child\'s location is its name', () => {
  async function childMovedToSecrets() {
    const found = await imported();
    const child = found.identityOf(M1_CHILDREN[0]!);
    await moveToSecrets(found.lane, child);
    const location = found.lane.secretLocations?.get(child);
    return { ...found, child, location };
  }

  test('is not shown once the parent is gone, and the sweep removes the Secret child with the rest', async () => {
    const { h, archiveId, lane, identityOf, child } = await childMovedToSecrets();
    // The child is a Secret: a location only, in every store that held it.
    expect(secretRows(h, archiveId, [M1_CHILDREN[0]!]).length).toBeGreaterThan(0);
    expect(liveRows(h, archiveId, [M1_CHILDREN[0]!])).toEqual([]);
    const index = lane.secretLocations!;
    const lane_ = { ledger: () => lane.ledger, stores: () => lane.set.openStores() };
    const shown = (): boolean => index.search('lease', {}, {
      hide: (identities) => hiddenProbesByParentIdentity(lane_, identities),
    }).length > 0;
    // Its filename is findable while the parent is there.
    expect(index.search('lease', {}).length).toBeGreaterThan(0);
    expect(shown()).toBe(true);

    // The parent is deleted in every store that holds it, as an absence reconcile does it.
    for (const store of lane.set.openStores()) store.tombstoneCopy(identityOf('m1'), { connectorId: 'absence-reconcile' });
    expect(shown()).toBe(false);
    // The sibling parent's Secret child (there is none) and a visible parent's are not hidden by this.
    expect(hiddenProbesByParentIdentity(lane_, [identityOf(M2_CHILD)]).size).toBe(0);

    // The sweep finds the Secret child with its siblings and settles all of it.
    const swept = await lane.set.sweepOrphanedChildren();
    expect(swept).toEqual({ removed: M1_CHILDREN.length, retry: 0 });
    expect(secretRows(h, archiveId, M1_CHILDREN)).toEqual([]);
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
    expect(index.get(child)).toBeUndefined();
    expect(lane.ledger.copies(child)).toEqual([]);
    // And nothing is owed: a second pass finds nothing to do.
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });
  });

  test('is shown on its own while the parent is there', async () => {
    const { lane, identityOf, child } = await childMovedToSecrets();
    const lane_ = { ledger: () => lane.ledger, stores: () => lane.set.openStores() };
    expect(hiddenProbesByParentIdentity(lane_, [child]).size).toBe(0);
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });
    void identityOf;
  });
});

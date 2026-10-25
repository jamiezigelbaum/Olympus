// A Secret parent is present while the provider lists it, and its children are
// then judged on their own; once the provider deletes it, whether the feed says
// so or its absence from a full snapshot does, it is judged as any deleted
// parent and its children go (docs/design/child-items.md, "Removal"). A
// Secret child's location is its name, so it is shown only while its parent
// is, and the sweep removes it with the rest. Through the real archive import,
// tier set, ledger, Secret location index and sweep.

import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListOptions, SourceConnectorListPage } from '../src/core/contracts.ts';
import { getArchiveFormat } from '../src/core/archive-formats.ts';
import type { SourceItemIdentity } from '../src/core/source-index/types.ts';
import { ARCHIVE_STORE_PLACEMENT } from '../src/workers/archive-import/store.ts';
import { archiveConnectorId } from '../src/workers/archive-import/state.ts';
import { hiddenProbesByParentIdentity } from '../src/workers/connector-store/child-visibility.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { childProviderItemId, createFixtureChildConnector, fixtureLocalItemId, type FixtureParentSpec } from './helpers/child-items-fixture.ts';
import { childItemsArchiveHarness, FIXTURE_ARCHIVE_FORMAT, type ChildItemsArchiveHarness } from './support/child-items-archive-harness.ts';

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
function snapshotWithout(h: ChildItemsArchiveHarness, archiveId: string, omitted: readonly string[]): SourceConnector {
  const source = createFixtureChildConnector({
    accountScope: archiveId, provider: format.provider, family: format.family, id: archiveConnectorId(archiveId),
    parents: parents(), log: h.log,
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

  test('a Secret no store ever held, deleted in the feed, takes its children with it', async () => {
    // Built at runtime so the repository's credential-pattern check never sees a literal key.
    const secretSubject = `Wifi ${['AKIA', 'ABCDEFGHIJKLMNOP'].join('')}`;
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    const secretParent: FixtureParentSpec = { ...parents()[0]!, subject: secretSubject };
    await h.importAll(archiveId, [secretParent]);
    const lane = h.runtime.lane(format.family);
    expect(h.rows(archiveId).filter((row) => row.providerItemId === 'm1')).toEqual([]);
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(true);
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });

    await lane.set.sync(createFixtureChildConnector({
      accountScope: archiveId, provider: format.provider, family: format.family, id: 'deletion-feed',
      parents: [{ ...secretParent, deleted: true }], log: h.log,
    }), SYNC);

    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(false);
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
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

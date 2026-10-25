// A parent item that is tombstoned takes its children with it
// (docs/design/child-items.md, "Removal"), through the real archive import,
// tier set, ledger and extraction runtime with the fixture connector standing
// in for every format. In ONE ledger transaction the parent and its children
// are hidden and a durable cascade row is written per child; a worker then
// deletes each child's copies in every store, with retry; a crash between
// stores leaves the children hidden, never visible; a child read after its
// parent was hidden lands nothing; a parent that only moved tiers or became a
// Secret takes nothing with it; and removing the archive clears what is owed.

import { afterEach, describe, expect, test } from 'bun:test';
import { getArchiveFormat } from '../src/core/archive-formats.ts';
import { ARCHIVE_STORE_PLACEMENT } from '../src/workers/archive-import/store.ts';
import { requestArchiveRemoval, runArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import type { TierCopy } from '../src/workers/classification/tier-ledger.ts';
import type { SourceItemIdentity } from '../src/core/source-index/types.ts';
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

async function importAndRead(readChildren = true) {
  const h = childItemsArchiveHarness(cleanups);
  const archiveId = h.start();
  await h.importAll(archiveId, parents());
  const ext = childItemsExtraction(h, cleanups, { parents: parents() });
  if (readChildren) await ext.drive(archiveId);
  const lane = h.runtime.lane(format.family);
  const identityOf = (providerItemId: string): SourceItemIdentity => ({
    family: format.family,
    provider: format.provider,
    accountScope: archiveId,
    providerItemId,
    localItemId: fixtureLocalItemId(archiveId, providerItemId),
  });
  return { h, archiveId, ext, lane, identityOf };
}

/** Copies of an item that some store would still serve (current), or is staging (staged). */
function liveCopies(copies: readonly TierCopy[]): TierCopy[] {
  return copies.filter((copy) => copy.state !== 'superseded');
}

function liveRows(h: ChildItemsArchiveHarness, archiveId: string, ids: readonly string[]) {
  return h.rows(archiveId).filter((row) => ids.includes(row.providerItemId) && row.tombstoned === 0);
}

describe('a parent is deleted at the provider', () => {
  test('its children are hidden and removed from every store, and a sibling parent\'s child is untouched', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    // The children's text landed in the store.
    expect(h.rows(archiveId).filter((row) => M1_CHILDREN.includes(row.providerItemId) && row.chunks > 0).length).toBeGreaterThan(0);
    expect(lane.ledger.pendingChildCascades()).toEqual([]);

    const deletion = createFixtureChildConnector({
      accountScope: archiveId,
      provider: format.provider,
      family: format.family,
      id: 'deletion-feed',
      parents: [{ ...parents()[0]!, deleted: true }],
      log: h.log,
    });
    await lane.set.sync(deletion, { placement: ARCHIVE_STORE_PLACEMENT, fetchContent: true, deferMetadataOnlyContent: true });

    // Every copy of every child is gone, in every store; so is the parent.
    expect(liveRows(h, archiveId, ['m1', ...M1_CHILDREN])).toEqual([]);
    for (const id of M1_CHILDREN) {
      expect(lane.ledger.copies(identityOf(id))).toEqual([]);
      expect(h.rows(archiveId).filter((row) => row.providerItemId === id && row.chunks > 0)).toEqual([]);
    }
    // The work owed is done, and the other parent's child is as it was.
    expect(lane.ledger.pendingChildCascades()).toEqual([]);
    expect(liveRows(h, archiveId, [M2_CHILD]).length).toBeGreaterThan(0);
    expect(liveRows(h, archiveId, ['m2']).length).toBeGreaterThan(0);
    expect(liveCopies(lane.ledger.copies(identityOf(M2_CHILD))).length).toBeGreaterThan(0);
  });

  test('the parent and its children are hidden together before any store is touched, with one owed removal per child', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    const before = [...M1_CHILDREN, 'm1'].map((id) => liveCopies(lane.ledger.copies(identityOf(id))).length);
    expect(before.every((count) => count > 0)).toBe(true);

    const queued = lane.set.cascadeParentDeletion(identityOf('m1'));
    expect(queued).toBe(M1_CHILDREN.length);

    // Hidden: no copy is current or staged for the parent or any child. Still in the stores, not yet removed.
    for (const id of ['m1', ...M1_CHILDREN]) expect(liveCopies(lane.ledger.copies(identityOf(id)))).toEqual([]);
    expect(liveRows(h, archiveId, M1_CHILDREN).length).toBeGreaterThan(0);
    // One durable row per child, and asking again owes nothing twice.
    expect(lane.ledger.pendingChildCascades().map((owed) => owed.child.providerItemId).sort()).toEqual([...M1_CHILDREN].sort());
    expect(lane.set.cascadeParentDeletion(identityOf('m1'))).toBe(0);
    expect(lane.ledger.pendingChildCascades()).toHaveLength(M1_CHILDREN.length);
  });

  test('a failure between stores leaves the child hidden and owed, and the next pass finishes it', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    lane.set.cascadeParentDeletion(identityOf('m1'));

    // One store fails to remove one child, once.
    const stores = lane.set.openStores();
    const failing = stores.find((store) => store.childItemsOf(fixtureLocalItemId(archiveId, 'm1')).length > 0)!;
    const real = failing.tombstoneCopy.bind(failing);
    let failed = false;
    failing.tombstoneCopy = ((identity, options) => {
      if (!failed && identity.providerItemId === M1_CHILDREN[0]) {
        failed = true;
        throw new Error('synthetic store failure');
      }
      return real(identity, options);
    }) as typeof failing.tombstoneCopy;

    const first = lane.set.runChildCascade();
    expect(first).toEqual({ removed: 1, retry: 1 });
    // The failed child is owed still, counted, and hidden: no copy anywhere is current or staged.
    const owed = lane.ledger.pendingChildCascades();
    expect(owed.map((entry) => entry.child.providerItemId)).toEqual([M1_CHILDREN[0]!]);
    expect(owed[0]!.attempts).toBe(1);
    expect(liveCopies(lane.ledger.copies(identityOf(M1_CHILDREN[0]!)))).toEqual([]);

    const second = lane.set.runChildCascade();
    expect(second).toEqual({ removed: 1, retry: 0 });
    expect(lane.ledger.pendingChildCascades()).toEqual([]);
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
    for (const id of M1_CHILDREN) expect(lane.ledger.copies(identityOf(id))).toEqual([]);
  });

  test('a child read after its parent was hidden lands nothing', async () => {
    const { h, archiveId, ext, lane, identityOf } = await importAndRead(false);
    lane.set.cascadeParentDeletion(identityOf('m1'));
    const driven = await ext.drive(archiveId);
    // The sibling parent's child was read; the hidden parent's children were not landed.
    expect(driven.run.counts.indexed).toBe(1);
    expect(h.rows(archiveId).filter((row) => M1_CHILDREN.includes(row.providerItemId) && row.chunks > 0)).toEqual([]);
    for (const id of M1_CHILDREN) expect(liveCopies(lane.ledger.copies(identityOf(id)))).toEqual([]);
  });

  test('a removal owed when the archive is removed goes with it', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    lane.set.cascadeParentDeletion(identityOf('m1'));
    expect(lane.ledger.pendingChildCascades()).toHaveLength(M1_CHILDREN.length);

    requestArchiveRemoval(h.runtime.state, archiveId);
    let outcome = await runArchiveRemoval({ state: h.runtime.state, lane, archiveId });
    while (outcome.kind === 'progress') outcome = await runArchiveRemoval({ state: h.runtime.state, lane, archiveId });
    expect(outcome.kind).toBe('removed');
    expect(lane.ledger.pendingChildCascades()).toEqual([]);
    expect(h.rows(archiveId)).toEqual([]);
  });
});

describe('a store reports a parent it tombstoned', () => {
  test('a parent absent from a re-sync takes its children with it', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    // The parent's store tombstones it outside any listing, as an absence reconcile does.
    for (const store of lane.set.openStores()) {
      store.tombstoneCopy(identityOf('m1'), { connectorId: 'absence-reconcile' });
    }
    // Told once the last store let go of the parent: one owed removal per child.
    expect(lane.ledger.pendingChildCascades().map((owed) => owed.child.providerItemId).sort()).toEqual([...M1_CHILDREN].sort());
    lane.set.runChildCascade();
    expect(lane.ledger.pendingChildCascades()).toEqual([]);
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
    expect(liveRows(h, archiveId, [M2_CHILD]).length).toBeGreaterThan(0);
  });

  test('a parent that became a Secret takes nothing with it: its children are judged on their own', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    for (const store of lane.set.openStores()) {
      store.tombstoneCopy(identityOf('m1'), { connectorId: 'secrets', trustTier: 'S5' });
    }
    lane.set.runChildCascade();
    expect(lane.ledger.pendingChildCascades()).toEqual([]);
    expect(liveRows(h, archiveId, M1_CHILDREN).length).toBeGreaterThan(0);
    for (const id of M1_CHILDREN) expect(liveCopies(lane.ledger.copies(identityOf(id))).length).toBeGreaterThan(0);
  });

  test('children left behind by a report that was lost are found again', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    // The report is lost: the store tombstones with no observer listening.
    for (const store of lane.set.openStores()) store.observeParentTombstones(undefined);
    for (const store of lane.set.openStores()) store.tombstoneCopy(identityOf('m1'), { connectorId: 'absence-reconcile' });
    expect(lane.ledger.pendingChildCascades()).toEqual([]);
    expect(liveRows(h, archiveId, M1_CHILDREN).length).toBeGreaterThan(0);

    // The set looks again (rate-limited, so the clock is moved on) and removes them. The children's
    // names sit in another store than the parent's: the walk follows the parent link across stores.
    for (const store of lane.set.openStores()) store.observeParentTombstones(() => {});
    expect(lane.set.reconcileOrphanedChildren(Date.now() + 10 * 60_000)).toBe(M1_CHILDREN.length);
    lane.set.runChildCascade();
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
  });
});

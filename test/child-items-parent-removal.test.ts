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
import { join } from 'node:path';
import { getArchiveFormat } from '../src/core/archive-formats.ts';
import { ARCHIVE_STORE_PLACEMENT } from '../src/workers/archive-import/store.ts';
import { createArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { secretLocationsPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { requestArchiveRemoval, runArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { TierLedger, type TierCopy } from '../src/workers/classification/tier-ledger.ts';
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

type Lane = ReturnType<ChildItemsArchiveHarness['runtime']['lane']>;

/** Whether any store of the lane would serve this child to a reader (its names or its text). */
function childReadable(lane: Lane, archiveId: string, providerItemId: string): boolean {
  const localItemId = fixtureLocalItemId(archiveId, providerItemId);
  return lane.set.openStores().some((store) => store.localContent(localItemId) !== undefined);
}

/** Whether a keyword search of any store of the lane finds the child's text. */
function textSearchable(lane: Lane, words: string): boolean {
  return lane.set.openStores().some((store) => store.searchItems(words, 5).length > 0);
}

/** The parent is deleted in every store that holds it, as an absence reconcile does it. */
function deleteParent(lane: Lane, identity: SourceItemIdentity): void {
  for (const store of lane.set.openStores()) store.tombstoneCopy(identity, { connectorId: 'absence-reconcile' });
}

type OwedHook = (...args: unknown[]) => void;

/** The store's hook that makes a deletion durable before its tombstone commits (a private seam, replaced in tests). */
function owedHookOf(store: unknown): { get(): OwedHook; set(hook: OwedHook): void } {
  const holder = store as { parentDeletionOwed?: OwedHook };
  return { get: () => holder.parentDeletionOwed!, set: (hook) => { holder.parentDeletionOwed = hook; } };
}

/**
 * A process that dies after a store's deletion is made durable and before that store's own
 * transaction commits: the last store holding the parent throws after the hook has run, so the
 * store rolls back and the parent is still held there.
 */
function deleteParentButRollBackLastStore(lane: Lane, identity: SourceItemIdentity): void {
  const holders = lane.set.openStores().filter((store) => store.activeLocalItemRow(identity.localItemId) !== undefined);
  const last = holders[holders.length - 1]!;
  const hook = owedHookOf(last);
  const real = hook.get();
  hook.set((...args) => { real(...args); throw new Error('the store rolled the deletion back'); });
  for (const store of holders) {
    try {
      store.tombstoneCopy(identity, { connectorId: 'absence-reconcile' });
    } catch {
      // The rolled-back store; the others committed.
    }
  }
  hook.set(real);
}

/** A process that dies right after the store commits, before anything settles the deletion. */
function dieBeforeSettling(lane: Lane): void {
  (lane.set as unknown as { parentsTombstoned: () => void }).parentsTombstoned = () => { throw new Error('process died'); };
}

/** What a restarted process sees: every handle closed, the same files opened afresh. */
function restart(h: ChildItemsArchiveHarness) {
  for (const lane of h.runtime.existingLanes()) {
    for (const store of lane.set.openStores()) store.close();
    lane.secretLocations?.close();
    lane.ledger.close();
  }
  h.runtime.media.close();
  return openRuntime(h);
}

/** A second, independent handle on the same files: its own ledger and store connections. */
function openRuntime(h: ChildItemsArchiveHarness) {
  const runtime = createArchiveImportRuntime({
    env: h.env,
    statePath: join(h.base, 'xdg', 'archive-imports.json'),
    waitingQuestionsDbPath: join(h.base, 'waiting-private-questions.sqlite'),
    openSecretLocations: (secureDbPath) => new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secureDbPath) }),
  });
  cleanups.push(() => {
    runtime.media.close();
    for (const lane of runtime.existingLanes()) {
      for (const store of lane.set.openStores()) store.close();
      lane.secretLocations?.close();
      lane.ledger.close();
    }
  });
  return runtime;
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

  test('once the parent\'s last store let go, it and its children are hidden together, with one owed removal per child', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    const before = [...M1_CHILDREN, 'm1'].map((id) => liveCopies(lane.ledger.copies(identityOf(id))).length);
    expect(before.every((count) => count > 0)).toBe(true);

    deleteParent(lane, identityOf('m1'));

    // Hidden: no copy is current or staged for the parent or any child. Still in the stores, not yet removed.
    for (const id of ['m1', ...M1_CHILDREN]) expect(liveCopies(lane.ledger.copies(identityOf(id)))).toEqual([]);
    expect(liveRows(h, archiveId, M1_CHILDREN).length).toBeGreaterThan(0);
    // One durable row per child, and asking again owes nothing twice.
    expect(lane.ledger.pendingChildCascades().map((owed) => owed.child.providerItemId).sort()).toEqual([...M1_CHILDREN].sort());
    expect(lane.set.cascadeParentDeletion(identityOf('m1'))).toBe(0);
    expect(lane.ledger.pendingChildCascades()).toHaveLength(M1_CHILDREN.length);
  });

  test('a parent still held in a store is never cascaded, whoever asks', async () => {
    const { lane, identityOf } = await importAndRead();
    expect(lane.set.cascadeParentDeletion(identityOf('m1'))).toBe(0);
    expect(lane.ledger.pendingChildCascades()).toEqual([]);
    for (const id of ['m1', ...M1_CHILDREN]) expect(liveCopies(lane.ledger.copies(identityOf(id))).length).toBeGreaterThan(0);
  });

  test('a failure between stores leaves the child hidden and owed, and the next pass finishes it', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    deleteParent(lane, identityOf('m1'));

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
    deleteParent(lane, identityOf('m1'));
    const driven = await ext.drive(archiveId);
    // The sibling parent's child was read; the hidden parent's children were not landed.
    expect(driven.run.counts.indexed).toBe(1);
    expect(h.rows(archiveId).filter((row) => M1_CHILDREN.includes(row.providerItemId) && row.chunks > 0)).toEqual([]);
    for (const id of M1_CHILDREN) expect(liveCopies(lane.ledger.copies(identityOf(id)))).toEqual([]);
  });

  test('a removal owed when the archive is removed goes with it', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    deleteParent(lane, identityOf('m1'));
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

describe('a crash between the parent store\'s commit and the ledger', () => {
  test('the process dies after the parent is tombstoned and before the children are hidden: the restart finds them hidden, not served', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    // The process dies between the parent store's commit and the ledger's transaction.
    lane.ledger.hideAndQueueChildren = () => { throw new Error('process died'); };
    deleteParent(lane, identityOf('m1'));
    // The parent is gone from the stores; the ledger never recorded the cascade.
    expect(liveRows(h, archiveId, ['m1'])).toEqual([]);
    // Still, no child is served by anyone: the deletion was made durable first.
    for (const id of M1_CHILDREN) expect(childReadable(lane, archiveId, id)).toBe(false);

    const runtime = restart(h);
    const reopened = runtime.lane(format.family);
    // Nothing has synced or reconciled since the restart; the children are already not served.
    for (const id of M1_CHILDREN) expect(childReadable(reopened, archiveId, id)).toBe(false);
    for (const id of M1_CHILDREN) expect(liveCopies(reopened.ledger.copies(identityOf(id)))).toEqual([]);
    expect(reopened.ledger.pendingChildCascades().map((owed) => owed.child.providerItemId).sort()).toEqual([...M1_CHILDREN].sort());
    expect(reopened.ledger.pendingParentDeletions()).toEqual([]);
    // The sibling parent's child is untouched, and the removal still finishes.
    expect(liveCopies(reopened.ledger.copies(identityOf(M2_CHILD))).length).toBeGreaterThan(0);
    expect(childReadable(reopened, archiveId, M2_CHILD)).toBe(true);
    reopened.set.runChildCascade();
    expect(reopened.ledger.pendingChildCascades()).toEqual([]);
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
  });

  test('a deletion the ledger cannot record is not committed by the store', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    lane.ledger.holdParentDeletion = () => { throw new Error('ledger unavailable'); };
    for (const store of lane.set.openStores()) {
      try {
        store.tombstoneCopy(identityOf('m1'), { connectorId: 'absence-reconcile' });
      } catch {
        // The store refused to commit the deletion.
      }
    }
    // The parent is still held, its children are served, and nothing is owed or half-recorded.
    expect(liveRows(h, archiveId, ['m1']).length).toBeGreaterThan(0);
    expect(liveCopies(lane.ledger.copies(identityOf('m1'))).length).toBeGreaterThan(0);
    for (const id of M1_CHILDREN) expect(liveCopies(lane.ledger.copies(identityOf(id))).length).toBeGreaterThan(0);
    for (const id of M1_CHILDREN) expect(childReadable(lane, archiveId, id)).toBe(true);
    expect(lane.ledger.pendingChildCascades()).toEqual([]);
  });

  test('a deletion made durable first is cleared in the same step that owes the removals', async () => {
    const { lane, identityOf } = await importAndRead();
    const seen: number[] = [];
    const real = lane.ledger.hideAndQueueChildren.bind(lane.ledger);
    lane.ledger.hideAndQueueChildren = ((parent, children) => {
      // At the moment the removals are owed, the intent is still there to be cleared with them.
      seen.push(lane.ledger.pendingParentDeletions().length);
      return real(parent, children);
    }) as typeof lane.ledger.hideAndQueueChildren;
    deleteParent(lane, identityOf('m1'));
    expect(seen).toEqual([1]);
    expect(lane.ledger.pendingParentDeletions()).toEqual([]);
    expect(lane.ledger.pendingChildCascades()).toHaveLength(M1_CHILDREN.length);
  });
});

describe('a parent\'s deletion fails closed', () => {
  /** The same parent listed again, present, as a later run of the import does. */
  async function listAgain(h: ChildItemsArchiveHarness, lane: Lane, archiveId: string, extraChildren: FixtureParentSpec['children'] = []) {
    const parent = parents()[0]!;
    const feed = createFixtureChildConnector({
      accountScope: archiveId,
      provider: format.provider,
      family: format.family,
      id: 'relist-feed',
      parents: [{ ...parent, children: [...parent.children, ...extraChildren] }],
      log: h.log,
    });
    await lane.set.sync(feed, { placement: ARCHIVE_STORE_PLACEMENT, fetchContent: true, deferMetadataOnlyContent: true });
  }

  test('the deletion is made durable and the children are refused before the parent\'s store commits', async () => {
    const { archiveId, lane, identityOf } = await importAndRead();
    for (const id of M1_CHILDREN) expect(childReadable(lane, archiveId, id)).toBe(true);
    expect(textSearchable(lane, 'thirty-seven months')).toBe(true);

    const seenInsideTheStoreTransaction: boolean[][] = [];
    for (const store of lane.set.openStores()) {
      const hook = owedHookOf(store);
      const real = hook.get();
      hook.set((...args) => {
        real(...args);
        seenInsideTheStoreTransaction.push(M1_CHILDREN.map((id) => childReadable(lane, archiveId, id)));
      });
    }
    deleteParent(lane, identityOf('m1'));
    // The hook ran with the deletion recorded and no store committed yet: nobody could read a child by then.
    expect(seenInsideTheStoreTransaction.length).toBeGreaterThan(0);
    expect(seenInsideTheStoreTransaction[seenInsideTheStoreTransaction.length - 1]!.every((readable) => !readable)).toBe(true);
    expect(textSearchable(lane, 'thirty-seven months')).toBe(false);
  });

  test('a recovery that fails at start leaves the child unreadable, and the next pass finishes the job', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    // The process dies after the parent store commits and before anything settles.
    dieBeforeSettling(lane);
    deleteParent(lane, identityOf('m1'));
    expect(lane.ledger.pendingParentDeletions()).toHaveLength(1);

    // The restart cannot write the cascade (its ledger write fails), but it finishes opening.
    const realHide = TierLedger.prototype.hideAndQueueChildren;
    TierLedger.prototype.hideAndQueueChildren = () => { throw new Error('ledger write failed'); };
    cleanups.push(() => { TierLedger.prototype.hideAndQueueChildren = realHide; });
    const reopened = restart(h).lane(format.family);

    expect(reopened.ledger.pendingParentDeletions()).toHaveLength(1);
    expect(reopened.ledger.pendingChildCascades()).toEqual([]);
    for (const id of M1_CHILDREN) expect(childReadable(reopened, archiveId, id)).toBe(false);
    expect(textSearchable(reopened, 'thirty-seven months')).toBe(false);

    // The write works again: the next pass owes the removals, and nothing was ever readable in between.
    TierLedger.prototype.hideAndQueueChildren = realHide;
    expect(reopened.set.recoverParentDeletions()).toBe(M1_CHILDREN.length);
    expect(reopened.ledger.pendingParentDeletions()).toEqual([]);
    for (const id of M1_CHILDREN) expect(childReadable(reopened, archiveId, id)).toBe(false);
    reopened.set.runChildCascade();
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
    void identityOf;
  });

  test('another process passing by while the parent still looks active clears nothing, and the child is never readable', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    // A second process: its own ledger and store connections on the same files, opened while nothing is pending.
    const other = openRuntime(h).lane(format.family);
    other.set.openStores();

    const otherSaw: Array<{ readable: boolean; pending: number }> = [];
    for (const store of lane.set.openStores()) {
      const hook = owedHookOf(store);
      const real = hook.get();
      hook.set((...args) => {
        real(...args);
        // Between the ledger's write and this store's commit, the other process runs its recovery pass.
        other.set.recoverParentDeletions();
        otherSaw.push({
          readable: M1_CHILDREN.some((id) => childReadable(other, archiveId, id)),
          pending: other.ledger.pendingParentDeletions().length,
        });
      });
    }
    // The first process commits and dies before it settles anything.
    dieBeforeSettling(lane);
    deleteParent(lane, identityOf('m1'));

    expect(otherSaw.length).toBeGreaterThan(0);
    const during = otherSaw[otherSaw.length - 1]!;
    expect(during.readable).toBe(false);
    expect(during.pending).toBe(1);
    // After the commit, the other process still reads nothing and still sees the deletion owed.
    for (const id of M1_CHILDREN) expect(childReadable(other, archiveId, id)).toBe(false);
    expect(other.ledger.pendingParentDeletions()).toHaveLength(1);

    // A start settles it: the parent is tombstoned, so the removals are owed and the children stay unreadable.
    const reopened = restart(h).lane(format.family);
    for (const id of M1_CHILDREN) expect(childReadable(reopened, archiveId, id)).toBe(false);
    expect(reopened.ledger.pendingChildCascades().map((owed) => owed.child.providerItemId).sort()).toEqual([...M1_CHILDREN].sort());
    expect(reopened.ledger.pendingParentDeletions()).toEqual([]);
    expect(childReadable(reopened, archiveId, M2_CHILD)).toBe(true);
  });

  test('a parent still held in another store is a move, not a deletion: nothing is held until the last store lets go', async () => {
    const { archiveId, lane, identityOf } = await importAndRead();
    const holders = lane.set.openStores().filter((store) => store.activeLocalItemRow(fixtureLocalItemId(archiveId, 'm1')) !== undefined);
    expect(holders.length).toBeGreaterThan(1);

    holders[0]!.tombstoneCopy(identityOf('m1'), { connectorId: 'tier-purge' });
    expect(lane.ledger.pendingParentDeletions()).toEqual([]);
    expect(lane.ledger.pendingChildCascades()).toEqual([]);
    for (const id of M1_CHILDREN) expect(childReadable(lane, archiveId, id)).toBe(true);

    for (const store of holders.slice(1)) store.tombstoneCopy(identityOf('m1'), { connectorId: 'tier-purge' });
    expect(lane.ledger.pendingChildCascades()).toHaveLength(M1_CHILDREN.length);
    for (const id of M1_CHILDREN) expect(childReadable(lane, archiveId, id)).toBe(false);
  });

  test('a deletion the parent\'s store rolled back keeps the children hidden, with no removal owed, until the parent is seen again', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    deleteParentButRollBackLastStore(lane, identityOf('m1'));

    // The last store still holds the parent; nothing was owed, and the children's copies are kept.
    expect(lane.set.openStores().some((store) => store.activeLocalItemRow(fixtureLocalItemId(archiveId, 'm1')) !== undefined)).toBe(true);
    expect(lane.ledger.pendingChildCascades()).toEqual([]);
    expect(lane.ledger.pendingParentDeletions()).toHaveLength(1);
    for (const id of M1_CHILDREN) {
      expect(liveCopies(lane.ledger.copies(identityOf(id))).length).toBeGreaterThan(0);
      expect(childReadable(lane, archiveId, id)).toBe(false);
    }

    // A restart and a pass do not lift it: nothing has seen the parent since.
    const reopened = restart(h).lane(format.family);
    reopened.set.recoverParentDeletions();
    reopened.set.runChildCascade();
    expect(reopened.ledger.pendingParentDeletions()).toHaveLength(1);
    expect(reopened.ledger.pendingChildCascades()).toEqual([]);
    for (const id of M1_CHILDREN) expect(childReadable(reopened, archiveId, id)).toBe(false);
    expect(childReadable(reopened, archiveId, M2_CHILD)).toBe(true);
  });

  test('a parent seen again after the deletion shows its children again', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    deleteParentButRollBackLastStore(lane, identityOf('m1'));
    for (const id of M1_CHILDREN) expect(childReadable(lane, archiveId, id)).toBe(false);

    await Bun.sleep(5);
    await listAgain(h, lane, archiveId);

    expect(lane.ledger.pendingParentDeletions()).toEqual([]);
    expect(lane.ledger.pendingChildCascades()).toEqual([]);
    for (const id of M1_CHILDREN) expect(lane.ledger.heldForDeletion(identityOf(id))).toBe(false);
    expect(lane.ledger.heldForDeletion(identityOf('m1'))).toBe(false);
    for (const id of M1_CHILDREN) expect(childReadable(lane, archiveId, id)).toBe(true);
    expect(textSearchable(lane, 'thirty-seven months')).toBe(true);
  });

  test('a sighting older than the deletion cannot lift it, and one after it does', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    const children = M1_CHILDREN.map(identityOf);
    // The deletion is noted after any write the next listing can make: that listing is stale next to it.
    lane.ledger.holdParentDeletion(identityOf('m1'), children, new Date(Date.now() + 3_600_000).toISOString());
    for (const id of M1_CHILDREN) expect(childReadable(lane, archiveId, id)).toBe(false);

    await Bun.sleep(5);
    await listAgain(h, lane, archiveId);
    expect(lane.ledger.pendingParentDeletions()).toHaveLength(1);
    for (const id of M1_CHILDREN) expect(childReadable(lane, archiveId, id)).toBe(false);

    // The same deletion noted before the listing's write is lifted by it.
    lane.ledger.liftParentDeletion(identityOf('m1'));
    lane.ledger.holdParentDeletion(identityOf('m1'), children, new Date(Date.now() - 3_600_000).toISOString());
    for (const id of M1_CHILDREN) expect(childReadable(lane, archiveId, id)).toBe(false);
    await listAgain(h, lane, archiveId);
    expect(lane.ledger.pendingParentDeletions()).toEqual([]);
    for (const id of M1_CHILDREN) expect(childReadable(lane, archiveId, id)).toBe(true);
  });

  test('a child listed while its parent\'s deletion is pending is held with the rest', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    lane.ledger.holdParentDeletion(
      identityOf('m1'),
      M1_CHILDREN.map(identityOf),
      new Date(Date.now() + 3_600_000).toISOString(),
    );
    await Bun.sleep(5);
    const late = childProviderItemId('m1', 'p3');
    await listAgain(h, lane, archiveId, [{ key: 'p3', name: 'late.txt', mimeType: 'text/plain', text: 'Arrived late.' }]);
    expect(lane.ledger.heldForDeletion(identityOf(late))).toBe(true);
    // When the deletion is confirmed it takes the late child too.
    deleteParent(lane, identityOf('m1'));
    expect(lane.ledger.pendingChildCascades().map((owed) => owed.child.providerItemId)).toContain(late);
  });
});

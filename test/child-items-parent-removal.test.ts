// A child is shown only while its parent is (docs/design/child-items.md,
// "Removal"), through the real archive import, tier set, ledger and extraction
// runtime with the fixture connector standing in for every format.
//
// The rule is decided where it is read and nothing is remembered between
// reads, so there is no state to lose in a crash and none to get out of step
// with the stores: the moment a parent is tombstoned in every store that held
// it, its children are hidden on every read path (fetch by id, keyword search,
// counts, the cross-store gate, the release check and the parent label), with
// no step in between. A sweep then removes the children as a provider deletion
// would, and is cleanup only. A parent that is merely moving tiers, or a
// Secret (judged on its own words, its children on theirs), takes nothing with
// it.

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListOptions, SourceConnectorListPage } from '../src/core/contracts.ts';
import { getArchiveFormat } from '../src/core/archive-formats.ts';
import { answerReleaseWithheldReason, type ReleaseInput, type ReleaseManifest } from '../src/core/release-manifest.ts';
import { REMOTE_ANSWER_UNVERIFIED, remoteOperationOutput } from '../src/core/remote-result.ts';
import type { SourceIndexRoutedSearchHit } from '../src/core/source-index/router.ts';
import type { SourceItemIdentity } from '../src/core/source-index/types.ts';
import { ARCHIVE_STORE_PLACEMENT } from '../src/workers/archive-import/store.ts';
import { createArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { requestArchiveRemoval, runArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TierLedger, type TierCopy } from '../src/workers/classification/tier-ledger.ts';
import { secretLocationsPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createParentLabelResolver } from '../src/workers/connector-store/parent-label.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import {
  createReleaseTierCheck,
  createTierVisibilityGate,
  type TierVisibilityScope,
} from '../src/workers/connector-store/tier-visibility.ts';
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

type Lane = ReturnType<ChildItemsArchiveHarness['runtime']['lane']>;

/** Copies of an item that some store would still serve (current), or is staging (staged). */
function liveCopies(copies: readonly TierCopy[]): TierCopy[] {
  return copies.filter((copy) => copy.state !== 'superseded');
}

function liveRows(h: ChildItemsArchiveHarness, archiveId: string, ids: readonly string[]) {
  return h.rows(archiveId).filter((row) => ids.includes(row.providerItemId) && row.tombstoned === 0);
}

/** Whether any store of the lane would serve this item to a reader (its names or its text). */
function readable(lane: Lane, archiveId: string, providerItemId: string): boolean {
  const localItemId = fixtureLocalItemId(archiveId, providerItemId);
  return lane.set.openStores().some((store) => store.localContent(localItemId) !== undefined);
}

/** Whether a keyword search of any store of the lane finds this text. */
function textSearchable(lane: Lane, words: string): boolean {
  return lane.set.openStores().some((store) => store.searchItems(words, 5).length > 0);
}

/** The parent is deleted in every store that holds it, as an absence reconcile does it. */
function deleteParent(lane: Lane, identity: SourceItemIdentity): void {
  for (const store of lane.set.openStores()) store.tombstoneCopy(identity, { connectorId: 'absence-reconcile' });
}

/** What a restarted process sees: every handle closed, the same files opened afresh. */
function restart(h: ChildItemsArchiveHarness) {
  for (const lane of h.runtime.existingLanes()) {
    for (const store of lane.set.openStores()) store.close();
    lane.secretLocations?.close();
    lane.ledger.close();
  }
  h.runtime.media.close();
  const runtime = createArchiveImportRuntime({
    env: h.env,
    statePath: join(h.base, 'xdg', 'archive-imports.json'),
    waitingQuestionsDbPath: join(h.base, 'waiting-private-questions.sqlite'),
    openSecretLocations: (secureDbPath) => new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secureDbPath) }),
  });
  cleanups.push(() => {
    runtime.media.close();
    for (const reopened of runtime.existingLanes()) {
      for (const store of reopened.set.openStores()) store.close();
      reopened.secretLocations?.close();
      reopened.ledger.close();
    }
  });
  return runtime;
}

/** The lane as the cross-store gate and the release check see it. */
function scopeOf(lane: Lane): TierVisibilityScope {
  return {
    ledger: lane.ledger,
    corpusIds: new Set(lane.set.openStores().map((store) => store.corpusId)),
    stores: () => lane.set.openStores(),
  };
}

function hitOf(lane: Lane, identity: SourceItemIdentity): SourceIndexRoutedSearchHit {
  const store = lane.set.openStores().find((candidate) => candidate.activeLocalItemRow(identity.localItemId) !== undefined)!;
  return { corpusId: store.corpusId, sourceItem: identity } as unknown as SourceIndexRoutedSearchHit;
}

/** The feed lists only the items the predicate keeps: a child arriving on its own. */
function onlyItems(source: SourceConnector, keep: (item: RawItem) => boolean): SourceConnector {
  return {
    ...source,
    async *listItems(options: SourceConnectorListOptions): AsyncGenerator<SourceConnectorListPage> {
      for await (const page of source.listItems(options)) yield { ...page, items: page.items.filter(keep) };
    },
  };
}

describe('a child is hidden the moment its parent is, on every read path', () => {
  test('a parent tombstoned in every store hides its children at once, before anything is removed, and a sibling parent\'s child is untouched', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    for (const id of [...M1_CHILDREN, M2_CHILD]) expect(readable(lane, archiveId, id)).toBe(true);
    expect(textSearchable(lane, 'thirty-seven months')).toBe(true);
    const countsBefore = lane.set.openStores().map((store) => store.status().counts.items);

    deleteParent(lane, identityOf('m1'));

    // Fetch by id and keyword search: nothing of the children is served by any store.
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(false);
    expect(textSearchable(lane, 'thirty-seven months')).toBe(false);
    expect(textSearchable(lane, 'deposit')).toBe(false);
    // Counts leave them out too: the parent itself and its two children, in the store that holds the names.
    const countsAfter = lane.set.openStores().map((store) => store.status().counts.items);
    expect(countsBefore[0]! - countsAfter[0]!).toBe(3);
    // Nothing was removed: the rows and the ledger's copies are as they were. The rule is read, not stored.
    expect(liveRows(h, archiveId, M1_CHILDREN).length).toBeGreaterThan(0);
    for (const id of M1_CHILDREN) expect(liveCopies(lane.ledger.copies(identityOf(id))).length).toBeGreaterThan(0);
    // The sibling parent's child is as it was.
    expect(readable(lane, archiveId, M2_CHILD)).toBe(true);
    expect(textSearchable(lane, 'gate twelve')).toBe(true);
  });

  test('the cross-store gate drops a hit on a child whose parent is gone, and keeps one whose parent is there', async () => {
    const { lane, identityOf } = await importAndRead();
    const gate = createTierVisibilityGate(() => [scopeOf(lane)]);
    const hits = [...M1_CHILDREN, M2_CHILD].map((id) => hitOf(lane, identityOf(id)));
    expect(gate(hits)).toHaveLength(3);

    deleteParent(lane, identityOf('m1'));
    expect(gate(hits).map((hit) => hit.sourceItem.providerItemId)).toEqual([M2_CHILD]);
  });

  test('the release check marks a child gone once its parent is: a delayed answer loses the citation, or is withheld when it carried the parent\'s names', async () => {
    const { lane, identityOf, archiveId } = await importAndRead();
    const check = createReleaseTierCheck(() => [scopeOf(lane)], () => 'allow');
    const namesCorpus = lane.set.openStores().find((store) => store.trustDomain === 'internal')!.corpusId;
    const input = (providerItemId: string, extra: Partial<ReleaseInput> = {}): ReleaseInput => ({
      corpusId: namesCorpus, provider: format.provider, accountScope: archiveId, providerItemId, privateAtAnswer: false, ...extra,
    });
    const cites = (providerItemId: string): Record<string, unknown> => ({
      corpus_id: namesCorpus, trust_domain: 'internal', family: format.family, provider: format.provider,
      provider_item_id: providerItemId, title: `${providerItemId}.txt`, authored_at: '2026-01-02T03:04:05.000Z',
    });
    const answer = (...ids: string[]) => ({ answer: 'The lease is thirty-seven months.', evidence: ids.map(cites), secret_locations: [] }) as never;
    const written = (...inputs: ReleaseInput[]): ReleaseManifest[] => [{ inputs, constraints: { secureDerivativeDefault: 'allow', includeSecureLocalContent: false } }];
    const citations = (output: Record<string, unknown>): unknown[] => output.citations as unknown[];

    const child = input(M1_CHILDREN[0]!);
    const sibling = input(M2_CHILD);
    const parentNames = input('m1', { layer: 'names' });
    expect(check.inputs([child, sibling]).map((verdict) => verdict.gone)).toEqual([false, false]);
    const before = remoteOperationOutput('source_answer_result', answer(M1_CHILDREN[0]!, M2_CHILD), {
      releaseCheck: check, releaseManifests: written(child, sibling),
    });
    expect(before.status).toBe('answered');
    expect(citations(before)).toHaveLength(2);

    deleteParent(lane, identityOf('m1'));

    // The child is gone to the check although its own copies are untouched; the sibling's child is not.
    expect(lane.ledger.copies(identityOf(M1_CHILDREN[0]!)).some((copy) => copy.state === 'current')).toBe(true);
    expect(check.inputs([child, sibling]).map((verdict) => verdict.gone)).toEqual([true, false]);
    // The citation of the gone child is dropped; the sibling's stays.
    const after = remoteOperationOutput('source_answer_result', answer(M1_CHILDREN[0]!, M2_CHILD), {
      releaseCheck: check, releaseManifests: written(child, sibling),
    });
    expect(after.status).toBe('answered');
    expect(citations(after)).toHaveLength(1);
    // The paths that withhold on any gone input withhold; an answer of the sibling alone does not.
    expect(answerReleaseWithheldReason(written(child), check)).toBeDefined();
    expect(answerReleaseWithheldReason(written(sibling), check)).toBeUndefined();
    // The parent's names were in front of the model that wrote the answer, and the parent is gone: nothing of it leaves.
    // (The sync that reports the deletion forgets the parent's copy rows right after its stores tombstone it.)
    lane.ledger.removeCopies(identityOf('m1'));
    expect(remoteOperationOutput('source_answer_result', answer(M2_CHILD), {
      releaseCheck: check, releaseManifests: written(sibling, parentNames),
    })).toEqual({ kind: 'source_answer', status: 'withheld', answer: REMOTE_ANSWER_UNVERIFIED, citations: [] });
  });

  test('a deleted parent gives no label to its child\'s citation', async () => {
    const { lane, identityOf } = await importAndRead();
    const resolve = createParentLabelResolver({ stores: () => lane.set.openStores(), scopes: () => [scopeOf(lane)] });
    const namesStore = lane.set.openStores().find((store) => store.trustDomain === 'internal')!;
    const request = { corpusId: namesStore.corpusId, sourceItem: identityOf(M1_CHILDREN[0]!) };
    expect(resolve([request])[0]).toBeDefined();
    deleteParent(lane, identityOf('m1'));
    expect(resolve([request])[0]).toBeUndefined();
  });

  test('a store that cannot say what the parent is hides the child: shown only on positive evidence', async () => {
    const { archiveId, lane } = await importAndRead();
    expect(readable(lane, archiveId, M1_CHILDREN[0]!)).toBe(true);
    for (const store of lane.set.openStores()) {
      store.parentStandings = () => { throw new Error('the store cannot be read'); };
    }
    // The children are hidden; an item that is not a child is not affected.
    for (const id of [...M1_CHILDREN, M2_CHILD]) expect(readable(lane, archiveId, id)).toBe(false);
    expect(readable(lane, archiveId, 'm1')).toBe(true);
    expect(textSearchable(lane, 'thirty-seven months')).toBe(false);
  });

  test('a child held by two stores names its parent in both, so each store\'s row says whose child it is', async () => {
    const { h, archiveId } = await importAndRead();
    const rows = h.rows(archiveId).filter((row) => M1_CHILDREN.includes(row.providerItemId));
    expect(new Set(rows.map((row) => row.domain))).toEqual(new Set(['internal', 'secure_local']));
    for (const row of rows) expect(row.parent).toBe(fixtureLocalItemId(archiveId, 'm1'));
  });
});

describe('what is not a deletion takes nothing with it', () => {
  test('a parent still held in another store, or moving tiers, keeps its children shown; the sweep removes nothing', async () => {
    const { archiveId, lane, identityOf } = await importAndRead();
    const holders = lane.set.openStores().filter((store) => store.activeLocalItemRow(fixtureLocalItemId(archiveId, 'm1')) !== undefined);
    expect(holders.length).toBeGreaterThan(1);

    // One holder lets go (a purge after a move): the other still serves the parent.
    holders[0]!.tombstoneCopy(identityOf('m1'), { connectorId: 'tier-purge' });
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(true);
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });
  });

  test('a real move of the parent: its children are shown whenever it is, through the move and after it, and never once it is deleted', async () => {
    const { archiveId, lane, identityOf } = await importAndRead();
    expect(readable(lane, archiveId, 'm1')).toBe(true);
    const during: Array<{ parent: boolean; children: boolean[] }> = [];
    await moveTieredItem({
      set: lane.set,
      identity: identityOf('m1'),
      target: { metadataTier: 'secure', contentTier: 'secure' },
      beforeFlip: () => {
        during.push({ parent: readable(lane, archiveId, 'm1'), children: M1_CHILDREN.map((id) => readable(lane, archiveId, id)) });
      },
    });
    // A raise hides the parent's source copy while it moves, and its children with it: at no moment is a
    // child shown that its parent is not.
    expect(during).toHaveLength(1);
    expect(during[0]!.children.every((shown) => shown === during[0]!.parent)).toBe(true);
    // After the flip the parent is shown from its new store, and so are its children.
    expect(readable(lane, archiveId, 'm1')).toBe(true);
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(true);
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });

    deleteParent(lane, identityOf('m1'));
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(false);
    expect(readable(lane, archiveId, M2_CHILD)).toBe(true);
  });

  test('a parent that became a Secret takes nothing with it: its children are judged on their own, and the parent itself is never shown', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    await moveTieredItem({
      set: lane.set,
      identity: identityOf('m1'),
      target: { metadataTier: 'secrets', contentTier: 'secrets' },
      secretsDisposition: 'tombstone_now',
    });
    // The parent is not served by anyone, in any form.
    expect(readable(lane, archiveId, 'm1')).toBe(false);
    expect(liveRows(h, archiveId, ['m1'])).toEqual([]);
    // Its children are not hidden by it, and the sweep does not remove them.
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(true);
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });
    expect(liveRows(h, archiveId, M1_CHILDREN).length).toBeGreaterThan(0);
    for (const id of M1_CHILDREN) expect(liveCopies(lane.ledger.copies(identityOf(id))).length).toBeGreaterThan(0);
    // Its names give no label to a citation.
    const resolve = createParentLabelResolver({ stores: () => lane.set.openStores(), scopes: () => [scopeOf(lane)] });
    const namesStore = lane.set.openStores().find((store) => store.trustDomain === 'internal')!;
    expect(resolve([{ corpusId: namesStore.corpusId, sourceItem: identityOf(M1_CHILDREN[0]!) }])[0]).toBeUndefined();
  });
});

describe('a Secret that no store ever held', () => {
  // Built at runtime so the repository's credential-pattern check never sees a literal key.
  const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

  test('a parent caught as a Secret on its own words before any store wrote it keeps its children: the sweep removes nothing', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    const secretParent: FixtureParentSpec = { ...parents()[0]!, subject: `Wifi ${FAKE_AWS_KEY}` };
    await h.importAll(archiveId, [secretParent]);
    const lane = h.runtime.lane(format.family);
    // No store holds the parent at all; the ledger alone knows it is a Secret.
    expect(h.rows(archiveId).filter((row) => row.providerItemId === 'm1')).toEqual([]);
    expect(liveRows(h, archiveId, M1_CHILDREN).length).toBe(M1_CHILDREN.length);
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });
    expect(liveRows(h, archiveId, M1_CHILDREN).length).toBe(M1_CHILDREN.length);
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(true);
  });
});

describe('legacy children: a store on its own, or beside a ledger that never routed them', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const ACCOUNT = 'legacy-account';
  const PROVIDER = 'fixture-archive';

  function feed(deletedParent = false): SourceConnector {
    return createFixtureChildConnector({
      accountScope: ACCOUNT,
      provider: PROVIDER,
      parents: [{
        id: 'msg-1', subject: 'Flat', sender: 'Alice', sentAt: '2024-03-03T10:00:00.000Z', body: 'Please find the lease attached.',
        ...(deletedParent ? { deleted: true } : {}),
        children: [{ key: 'p1', name: 'lease.pdf', mimeType: 'application/pdf', text: 'The lease term is thirty-seven months.' }],
      }],
    });
  }

  for (const withLedger of [false, true]) {
    test(`never routed${withLedger ? ', a ledger beside the store' : ', no ledger'}: shown while the parent's row is, hidden once it is tombstoned`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'olympus-child-removal-'));
      dirs.push(dir);
      const ledger = withLedger ? new TierLedger({ dbPath: join(dir, 'tier-ledger.sqlite') }) : undefined;
      const store = new LocalConnectorStore({
        dbPath: join(dir, 'store.sqlite'), corpusId: 'secure_local.archive.email', family: 'email', trustDomain: 'secure_local',
        tierLedger: ledger ?? null,
      });
      cleanups.push(() => { store.close(); ledger?.close(); });
      await store.syncFromConnector(feed(), SYNC);
      const childLocal = fixtureLocalItemId(ACCOUNT, 'msg-1#child:p1');
      expect(store.searchItems('lease.pdf', 5).length).toBeGreaterThan(0);
      expect(store.localContent(childLocal)).toBeDefined();

      await store.syncFromConnector(feed(true), SYNC);
      // The parent is deleted; the child's row is still there and is not served.
      expect(store.searchItems('lease.pdf', 5)).toEqual([]);
      expect(store.localContent(childLocal)).toBeUndefined();
      const db = new Database(join(dir, 'store.sqlite'), { readonly: true });
      try {
        expect(db.query("SELECT COUNT(*) AS n FROM items WHERE provider_item_id LIKE '%#child:%' AND tombstoned = 0").get()).toEqual({ n: 1 });
      } finally {
        db.close();
      }
    });
  }
});

describe('a child listed after its parent was deleted', () => {
  test('is hidden whenever it arrives, even if the sweep cannot remove it yet, and the sweep removes it when it can', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    deleteParent(lane, identityOf('m1'));
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: M1_CHILDREN.length, retry: 0 });

    // A late listing of a new child of the deleted parent (a feed that lags the deletion). The stores
    // refuse to remove it for now, so what a reader sees is the read-time rule alone.
    const late = childProviderItemId('m1', 'p3');
    const withLate = [{ ...parents()[0]!, children: [...parents()[0]!.children, { key: 'p3', name: 'late.txt', mimeType: 'text/plain', text: 'Arrived late.' }] }];
    const feed = onlyItems(
      createFixtureChildConnector({ accountScope: archiveId, provider: format.provider, family: format.family, id: 'late-feed', parents: withLate, log: h.log }),
      (item) => item.identity.providerItemId === late,
    );
    const originals = lane.set.openStores().map((store) => [store, store.tombstoneCopy.bind(store)] as const);
    for (const [store, real] of originals) {
      store.tombstoneCopy = ((identity, options) => {
        if (identity.providerItemId === late) throw new Error('synthetic store failure');
        return real(identity, options);
      }) as typeof store.tombstoneCopy;
    }
    await lane.set.sync(feed, SYNC);

    expect(liveRows(h, archiveId, [late]).length).toBeGreaterThan(0);
    expect(readable(lane, archiveId, late)).toBe(false);
    expect(textSearchable(lane, 'arrived late')).toBe(false);

    for (const [store, real] of originals) store.tombstoneCopy = real;
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 1, retry: 0 });
    expect(liveRows(h, archiveId, [late])).toEqual([]);
  });
});

describe('the sweep removes the children of a parent that is gone, and only those', () => {
  test('every copy of every child goes, from every store, chunks and search rows with it; the other parent\'s child is untouched', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    expect(h.rows(archiveId).filter((row) => M1_CHILDREN.includes(row.providerItemId) && row.chunks > 0).length).toBeGreaterThan(0);

    deleteParent(lane, identityOf('m1'));
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: M1_CHILDREN.length, retry: 0 });

    expect(liveRows(h, archiveId, ['m1', ...M1_CHILDREN])).toEqual([]);
    for (const id of M1_CHILDREN) {
      expect(lane.ledger.copies(identityOf(id))).toEqual([]);
      expect(h.rows(archiveId).filter((row) => row.providerItemId === id && row.chunks > 0)).toEqual([]);
    }
    expect(textSearchable(lane, 'thirty-seven months')).toBe(false);
    expect(liveRows(h, archiveId, [M2_CHILD]).length).toBeGreaterThan(0);
    expect(liveCopies(lane.ledger.copies(identityOf(M2_CHILD))).length).toBeGreaterThan(0);
    expect(readable(lane, archiveId, M2_CHILD)).toBe(true);
    // Idempotent: nothing is left to do.
    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 0, retry: 0 });
  });

  test('a provider deletion through a sync takes the children with it, by the sweep that closes the sync', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    const deletion = createFixtureChildConnector({
      accountScope: archiveId,
      provider: format.provider,
      family: format.family,
      id: 'deletion-feed',
      parents: [{ ...parents()[0]!, deleted: true }],
      log: h.log,
    });
    await lane.set.sync(deletion, SYNC);

    expect(liveRows(h, archiveId, ['m1', ...M1_CHILDREN])).toEqual([]);
    for (const id of M1_CHILDREN) expect(lane.ledger.copies(identityOf(id))).toEqual([]);
    expect(liveRows(h, archiveId, [M2_CHILD, 'm2']).length).toBeGreaterThan(0);
    expect(readable(lane, archiveId, M2_CHILD)).toBe(true);
  });

  test('a child whose copy cannot be removed stays hidden and owed, and the next pass finishes it', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    deleteParent(lane, identityOf('m1'));

    const failing = lane.set.openStores().find((store) => store.activeChildrenOf({
      provider: format.provider, accountScope: archiveId, parentLocalItemId: fixtureLocalItemId(archiveId, 'm1'),
    }).length > 0)!;
    const real = failing.tombstoneCopy.bind(failing);
    let failed = false;
    failing.tombstoneCopy = ((identity, options) => {
      if (!failed && identity.providerItemId === M1_CHILDREN[0]) {
        failed = true;
        throw new Error('synthetic store failure');
      }
      return real(identity, options);
    }) as typeof failing.tombstoneCopy;

    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 1, retry: 1 });
    // The failed child is hidden all the same: the rule is read, not removed.
    expect(readable(lane, archiveId, M1_CHILDREN[0]!)).toBe(false);
    expect(liveRows(h, archiveId, [M1_CHILDREN[0]!]).length).toBeGreaterThan(0);

    expect(await lane.set.sweepOrphanedChildren()).toEqual({ removed: 1, retry: 0 });
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
    for (const id of M1_CHILDREN) expect(lane.ledger.copies(identityOf(id))).toEqual([]);
  });

  test('a sweep asked for during a sync waits for it: nothing is removed while the sync is in flight', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    deleteParent(lane, identityOf('m1'));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const base = createFixtureChildConnector({
      accountScope: archiveId, provider: format.provider, family: format.family, id: 'slow-feed', parents: [parents()[1]!], log: h.log,
    });
    const slow: SourceConnector = {
      ...base,
      async *listItems(options: SourceConnectorListOptions): AsyncGenerator<SourceConnectorListPage> {
        await gate;
        yield* base.listItems(options);
      },
    };
    const syncing = lane.set.sync(slow, SYNC);
    const sweeping = lane.set.sweepOrphanedChildren();
    await Bun.sleep(100);
    // The orphans are hidden, and still there: the sweep has not touched the account's stores.
    expect(liveRows(h, archiveId, M1_CHILDREN).length).toBeGreaterThan(0);
    for (const id of M1_CHILDREN) expect(readable(lane, archiveId, id)).toBe(false);

    release();
    await syncing;
    await sweeping;
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
    expect(liveRows(h, archiveId, [M2_CHILD]).length).toBeGreaterThan(0);
  });

  test('asked twice at once, it removes each child once', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    deleteParent(lane, identityOf('m1'));
    const [first, second] = await Promise.all([lane.set.sweepOrphanedChildren(), lane.set.sweepOrphanedChildren()]);
    expect(first).toEqual(second);
    expect(first.removed).toBe(M1_CHILDREN.length);
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
  });
});

describe('a restart changes nothing a reader sees', () => {
  test('children of a visible parent stay shown and children of a deleted parent stay hidden, with no recovery step in between', async () => {
    const { h, archiveId, identityOf, lane } = await importAndRead();
    deleteParent(lane, identityOf('m1'));

    const reopened = restart(h).lane(format.family);
    // Straight after the reopen, before any sweep or sync has run.
    for (const id of M1_CHILDREN) expect(readable(reopened, archiveId, id)).toBe(false);
    expect(readable(reopened, archiveId, M2_CHILD)).toBe(true);
    expect(textSearchable(reopened, 'thirty-seven months')).toBe(false);
    expect(textSearchable(reopened, 'gate twelve')).toBe(true);

    // The sweep that start-up runs finishes the cleanup.
    expect((await reopened.set.sweepOrphanedChildren()).retry).toBe(0);
    expect(liveRows(h, archiveId, M1_CHILDREN)).toEqual([]);
    expect(readable(reopened, archiveId, M2_CHILD)).toBe(true);
  });
});

describe('the archive is removed', () => {
  test('its children go with it whether or not the sweep has run', async () => {
    const { h, archiveId, lane, identityOf } = await importAndRead();
    deleteParent(lane, identityOf('m1'));

    requestArchiveRemoval(h.runtime.state, archiveId);
    let outcome = await runArchiveRemoval({ state: h.runtime.state, lane, archiveId });
    while (outcome.kind === 'progress') outcome = await runArchiveRemoval({ state: h.runtime.state, lane, archiveId });
    expect(outcome.kind).toBe('removed');
    expect(h.rows(archiveId)).toEqual([]);
  });
});

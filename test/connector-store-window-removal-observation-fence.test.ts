// The window-removal fence must count OBSERVATIONS, not writes.
//
// `tombstoneWindowRemovedItems` refuses a proven in-window removal when an
// owner row was last seen at or after the snapshot's observation cutoff. That
// exemption exists for a real re-observation: a lane that listed the item at
// the provider after the snapshot proved it absent.
//
// A representation restore is not that. X content recovery re-attaches text
// under the LIVE connector's owner row (`ownershipKind: 'observed'`,
// `ownerConnectorId` = the live connector), and the extraction factory does the
// same for its corpora. Advancing `last_seen_at` there made every recovery pass
// shield genuinely un-bookmarked posts — and because snapshot promotion then
// drops the item from both the prior and the current snapshot, the transition
// that produced the removal never comes back. The post stays searchable for
// ever.

import { describe, expect, test } from 'bun:test';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { buildExtractionRepresentationExpectation } from '../src/workers/file-extraction/store-sink.ts';

const ACCOUNT = 'personal';
const PROVIDER = 'fake';
const CORPUS_ID = 'secure_local.fake.files';
const OBSERVED_AT = '2026-07-24T09:00:00.000Z';
const SNAPSHOT_OBSERVED_AT = '2026-07-25T09:00:00.000Z';
const AFTER_SNAPSHOT = '2026-07-25T09:00:01.000Z';

interface PostSpec {
  id: string;
  text: string;
}

function rawItem(spec: PostSpec): RawItem {
  return {
    identity: {
      family: 'file',
      provider: PROVIDER,
      accountScope: ACCOUNT,
      providerItemId: spec.id,
      localItemId: `${ACCOUNT}:${spec.id}`,
      sourceVersion: 'rev-1',
    },
    mimeType: 'text/markdown',
    content: { kind: 'text', text: spec.text },
    metadata: Object.freeze({ name: `${spec.id}.md` }),
    fetchedAt: '2026-07-20T00:00:00.000Z',
  };
}

function connector(connectorId: string, posts: readonly PostSpec[]): SourceConnector {
  return {
    id: connectorId,
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: posts.map(rawItem), done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const spec = posts.find((post) => `${ACCOUNT}:${post.id}` === localItemId);
      if (!spec) throw new Error(`no such item ${localItemId}`);
      return rawItem(spec);
    },
    classify(): ReturnType<SourceConnector['classify']> {
      return buildSourceSensitivity({ trustDomain: 'secure_local', trustTier: 'S4' });
    },
  };
}

function windowReconcileOptions(removedLocalItemIds: readonly string[]) {
  return {
    fetchContent: true,
    reconcileFullSnapshot: true,
    reconcileAbsenceAuthority: 'complete_snapshot' as const,
    reconcileFullSnapshotScope: { provider: PROVIDER, accountScope: ACCOUNT },
    reconcileCurrentMembershipAuthority: 'provider_window_snapshot' as const,
    reconcileSnapshotObservedAt: SNAPSHOT_OBSERVED_AT,
    reconcileSnapshotCompletedAt: '2026-07-25T09:00:05.000Z',
    reconcileWindowBoundarySha256: 'a'.repeat(64),
    reconcileWindowRemovedLocalItemIds: removedLocalItemIds,
  };
}

describe('window removal fence counts provider observations only', () => {
  test('a content restore after the cutoff does not shield a removed item', async () => {
    let clock = new Date(OBSERVED_AT);
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
      now: () => clock,
    });
    const removed: PostSpec = { id: 'id:removed', text: 'uniqueremovedtoken original body' };
    const kept: PostSpec = { id: 'id:kept', text: 'still bookmarked body' };

    await store.syncFromConnector(connector('live', [removed, kept]), { fetchContent: true });

    // A recovery pass re-attaches text under the LIVE connector's owner row,
    // after the reconcile's observation cutoff. It proves nothing about
    // whether the provider still lists the post.
    clock = new Date(AFTER_SNAPSHOT);
    const recovered = rawItem({ id: removed.id, text: 'uniquerecoveredtoken recovered body' });
    const restore = store.restoreItemRepresentations({
      items: [{
        item: recovered,
        expectation: buildExtractionRepresentationExpectation(
          recovered.identity,
          'uniquerecoveredtoken recovered body',
        ),
      }],
      syncConnectorId: 'recovery',
      ownerConnectorId: 'live',
      ownershipKind: 'observed',
      classify: () => buildSourceSensitivity({ trustDomain: 'secure_local', trustTier: 'S4' }),
    });
    expect(restore.counts.itemsRestored).toBe(1);

    const reconcile = await store.syncFromConnector(
      connector('live', [kept]),
      windowReconcileOptions([`${ACCOUNT}:${removed.id}`]),
    );

    expect(reconcile.itemsTombstoned).toBe(1);
    expect(reconcile.gaps.some((gap) => gap.includes('window_removal_newer_observation_preserved')))
      .toBe(false);
    // Applied, so nothing is owed.
    expect(reconcile.windowRemovalsDeferredLocalItemIds).toEqual([]);
    expect(store.searchItems('uniquerecoveredtoken', 5)).toHaveLength(0);
    store.close();
  });

  test('a real re-listing after the cutoff still shields the item', async () => {
    let clock = new Date(OBSERVED_AT);
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
      now: () => clock,
    });
    const reobserved: PostSpec = { id: 'id:reobserved', text: 'uniquereobservedtoken live body' };
    const kept: PostSpec = { id: 'id:kept', text: 'still bookmarked body' };

    await store.syncFromConnector(connector('live', [reobserved, kept]), { fetchContent: true });
    clock = new Date(AFTER_SNAPSHOT);
    await store.syncFromConnector(connector('live', [reobserved]), { fetchContent: true });

    const reconcile = await store.syncFromConnector(
      connector('live', [kept]),
      windowReconcileOptions([`${ACCOUNT}:${reobserved.id}`]),
    );

    expect(reconcile.itemsTombstoned).toBe(0);
    expect(reconcile.gaps.some((gap) => gap.includes('window_removal_newer_observation_preserved')))
      .toBe(true);
    // Refused, so it is still owed — and reported BY ID, because the caller
    // cannot recompute the transition once the next snapshot is promoted. A
    // count in a coverage gap cannot be re-presented against a later cutoff.
    expect(reconcile.windowRemovalsDeferredLocalItemIds)
      .toEqual([`${ACCOUNT}:${reobserved.id}`]);
    expect(store.searchItems('uniquereobservedtoken', 5)).toHaveLength(1);
    store.close();
  });

  test('a by-id replay declaring local_write does not shield a removed item', async () => {
    let clock = new Date(OBSERVED_AT);
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
      now: () => clock,
    });
    const removed: PostSpec = { id: 'id:refetched', text: 'uniquerefetchedtoken original body' };
    const kept: PostSpec = { id: 'id:kept', text: 'still bookmarked body' };

    await store.syncFromConnector(connector('live', [removed, kept]), { fetchContent: true });

    // A content-repair pass replays the one item by id after the cutoff. The
    // fetch proves the content still serves, not that the provider lists it.
    clock = new Date(AFTER_SNAPSHOT);
    await store.syncFromConnector(connector('live', [removed]), {
      fetchContent: true,
      maxItems: 1,
      ownerObservation: 'local_write',
    });

    const reconcile = await store.syncFromConnector(
      connector('live', [kept]),
      windowReconcileOptions([`${ACCOUNT}:${removed.id}`]),
    );

    expect(reconcile.itemsTombstoned).toBe(1);
    expect(reconcile.windowRemovalsDeferredLocalItemIds).toEqual([]);
    expect(store.searchItems('uniquerefetchedtoken', 5)).toHaveLength(0);
    store.close();
  });
});

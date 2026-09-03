// Window-scoped removals against the shared connector store spine.
//
// A `provider_window_snapshot` reconcile proves current membership only for
// the ids inside its window, and the removal list it carries is applied by
// `tombstoneWindowRemovedItems`. The account-snapshot branch of the same
// reconcile refuses to remove a preservation-owned row; these tests pin that
// the weaker window authority refuses it too, since a post that vanished from
// the provider's bookmarks listing may have been deleted or gone protected —
// the case where the archived copy is the only one left.

import { describe, expect, test } from 'bun:test';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

const ACCOUNT = 'personal';
const PROVIDER = 'fake';
const CORPUS_ID = 'secure_local.fake.files';

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

// Ownership stamps and the reconcile's observation cutoff have to share one
// clock: a store on the wall clock stamps every owner AFTER the fixture's
// snapshot cutoff, which is a state a real reconcile can never be in.
const OBSERVED_AT = '2026-07-24T09:00:00.000Z';

function newStore(now: () => Date = () => new Date(OBSERVED_AT)): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
    now,
  });
}

function windowReconcileOptions(removedLocalItemIds: readonly string[]) {
  return {
    fetchContent: true,
    reconcileFullSnapshot: true,
    reconcileAbsenceAuthority: 'complete_snapshot' as const,
    reconcileFullSnapshotScope: { provider: PROVIDER, accountScope: ACCOUNT },
    reconcileCurrentMembershipAuthority: 'provider_window_snapshot' as const,
    reconcileSnapshotObservedAt: '2026-07-25T09:00:00.000Z',
    reconcileSnapshotCompletedAt: '2026-07-25T09:00:05.000Z',
    reconcileWindowBoundarySha256: 'a'.repeat(64),
    reconcileWindowRemovedLocalItemIds: removedLocalItemIds,
  };
}

describe('provider-window removals and preservation ownership', () => {
  test('a preservation-owned in-window removal keeps its text and is reported, not tombstoned', async () => {
    const store = newStore();
    const preserved: PostSpec = { id: 'id:preserved', text: 'uniquepreservedtoken archive body' };
    const observedOnly: PostSpec = { id: 'id:observed', text: 'uniqueremovedtoken live body' };
    const kept: PostSpec = { id: 'id:kept', text: 'still bookmarked body' };

    // The archive lane owns the preserved item; the live lane then observes
    // both it and the observed-only item, so both are provider-current.
    await store.syncFromConnector(connector('archive', [preserved]), {
      fetchContent: true,
      ownershipKind: 'preservation',
    });
    await store.syncFromConnector(connector('live', [preserved, observedOnly, kept]), {
      fetchContent: true,
    });

    const removed = await store.syncFromConnector(
      connector('live', [kept]),
      windowReconcileOptions([
        `${ACCOUNT}:${preserved.id}`,
        `${ACCOUNT}:${observedOnly.id}`,
      ]),
    );

    expect(removed.itemsTombstoned).toBe(1);
    expect(store.searchItems('uniqueremovedtoken', 5)).toHaveLength(0);
    expect(store.searchItems('uniquepreservedtoken', 5)).toHaveLength(1);
    expect(store.localContent(`${ACCOUNT}:${preserved.id}`)?.chunks.join(' '))
      .toContain('uniquepreservedtoken');
    expect(removed.gaps.some((gap) => gap.includes('window_removal_preservation_owned_preserved')))
      .toBe(true);
    store.close();
  });

  test('an observed-only in-window removal is still tombstoned', async () => {
    const store = newStore();
    const removedPost: PostSpec = { id: 'id:removed', text: 'uniqueremovedtoken live body' };
    const kept: PostSpec = { id: 'id:kept', text: 'still bookmarked body' };

    await store.syncFromConnector(connector('live', [removedPost, kept]), { fetchContent: true });
    const removed = await store.syncFromConnector(
      connector('live', [kept]),
      windowReconcileOptions([`${ACCOUNT}:${removedPost.id}`]),
    );

    expect(removed.itemsTombstoned).toBe(1);
    expect(removed.gaps.some((gap) => gap.includes('window_removal_preservation_owned_preserved')))
      .toBe(false);
    expect(store.searchItems('uniqueremovedtoken', 5)).toHaveLength(0);
    expect(store.localContent(`${ACCOUNT}:${removedPost.id}`)).toBeUndefined();
    store.close();
  });

  test('a removal is refused for an item observed at or after the snapshot cutoff', async () => {
    // A reconcile that observed its window at T proves nothing about T+1. A
    // slow or retried pass must not delete an item another lane has seen since
    // — the exemption the account-snapshot branch has always had.
    let clock = new Date(OBSERVED_AT);
    const store = newStore(() => clock);
    const reobserved: PostSpec = { id: 'id:reobserved', text: 'uniquereobservedtoken live body' };
    const kept: PostSpec = { id: 'id:kept', text: 'still bookmarked body' };

    await store.syncFromConnector(connector('live', [reobserved, kept]), { fetchContent: true });
    // A later lane re-observes the item after the window snapshot was taken.
    clock = new Date('2026-07-25T09:00:01.000Z');
    await store.syncFromConnector(connector('live', [reobserved]), { fetchContent: true });

    const removed = await store.syncFromConnector(
      connector('live', [kept]),
      windowReconcileOptions([`${ACCOUNT}:${reobserved.id}`]),
    );

    expect(removed.itemsTombstoned).toBe(0);
    expect(removed.gaps.some((gap) => gap.includes('window_removal_newer_observation_preserved')))
      .toBe(true);
    expect(store.searchItems('uniquereobservedtoken', 5)).toHaveLength(1);
    store.close();
  });
});

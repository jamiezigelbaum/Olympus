import {
  type XBookmarkFolder,
  type XBookmarkPost,
  LocalXBookmarksReconcileStateStore,
  type XBookmarksCompletedReconcileSnapshot,
  type XBookmarksReconcileLimits,
} from '../../src/workers/x-bookmarks/index.ts';

const DEFAULT_SEEDED_AT = new Date('2026-07-18T11:00:00.000Z');
const PAGE_SIZE = 100;

export function seedCanonicalXBookmarksSnapshot(
  state: LocalXBookmarksReconcileStateStore,
  input: {
    account: string;
    providerUserId: string;
    posts: readonly XBookmarkPost[];
    folders: readonly XBookmarkFolder[];
    foldersByPostId: ReadonlyMap<string, readonly XBookmarkFolder[]>;
    seededAt?: Date;
  },
): XBookmarksCompletedReconcileSnapshot {
  const seededAt = input.seededAt ?? DEFAULT_SEEDED_AT;
  const maxPostPages = Math.max(1, Math.ceil(input.posts.length / PAGE_SIZE));
  const limits: XBookmarksReconcileLimits = {
    maxItems: Math.max(PAGE_SIZE, input.posts.length),
    maxFolders: Math.max(20, input.folders.length),
    maxPagesPerScope: Math.max(10, maxPostPages),
    pageSize: PAGE_SIZE,
  };
  state.openRun(input.account, limits, input.providerUserId, seededAt);

  recordPostPages(input.posts, (posts, expectedToken, nextToken) => {
    state.recordGlobalPage({
      account: input.account,
      ...(expectedToken ? { expectedToken } : {}),
      page: { posts, ...(nextToken ? { nextToken } : {}) },
      requestedSize: PAGE_SIZE,
      limits,
      settledAt: seededAt,
    });
  });
  recordPostPages(input.posts, (posts, expectedToken, nextToken) => {
    state.recordGlobalVerificationPage({
      account: input.account,
      ...(expectedToken ? { expectedToken } : {}),
      page: {
        posts: posts.map(({ id }) => ({ id })),
        ...(nextToken ? { nextToken } : {}),
      },
      requestedSize: PAGE_SIZE,
      limits,
      settledAt: seededAt,
    });
  });
  state.recordFolderPage({
    account: input.account,
    page: { folders: [...input.folders] },
    requestedSize: PAGE_SIZE,
    limits,
    settledAt: seededAt,
  });

  let folder = state.nextMembershipFolder(input.account);
  while (folder) {
    const memberPosts = input.posts.filter((post) => (
      input.foldersByPostId.get(post.id)?.some(({ id }) => id === folder!.id) ?? false
    ));
    recordPostPages(memberPosts, (posts, expectedToken, nextToken) => {
      state.recordMembershipPage({
        account: input.account,
        folderId: folder!.id,
        ...(expectedToken ? { expectedToken } : {}),
        page: {
          posts: posts.map(({ id }) => ({ id })),
          ...(nextToken ? { nextToken } : {}),
        },
        requestedSize: PAGE_SIZE,
        limits,
        settledAt: seededAt,
      });
    });
    folder = state.nextMembershipFolder(input.account);
  }

  const promoted = state.promoteCompletedSnapshot(input.account, seededAt);
  state.markCompletedSnapshotDisposition(
    input.account,
    promoted.completedAt,
    'applied',
    seededAt,
  );
  return state.completedSnapshot(input.account)!;
}

function recordPostPages(
  posts: readonly XBookmarkPost[],
  record: (
    page: XBookmarkPost[],
    expectedToken: string | undefined,
    nextToken: string | undefined,
  ) => void,
): void {
  if (posts.length === 0) {
    record([], undefined, undefined);
    return;
  }
  for (let offset = 0; offset < posts.length; offset += PAGE_SIZE) {
    const nextOffset = offset + PAGE_SIZE;
    record(
      posts.slice(offset, nextOffset),
      offset === 0 ? undefined : `page-${offset}`,
      nextOffset < posts.length ? `page-${nextOffset}` : undefined,
    );
  }
}

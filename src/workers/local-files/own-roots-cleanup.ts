// What an earlier version indexed inside Olympus's own folders.
//
// Files on this computer never index Olympus's own folders now (paths.ts
// `ownRoots`), but an earlier version indexed one the person had chosen by
// name, and a folder that is no longer a root is never walked again, so no
// pass would ever judge what is stored under it. This removes those items from
// the index, through the deletion path every other removal takes (a connector
// listing deleted items into the lane's tier stores), so the item, its text and
// its entry in the secret-locations index go together.
//
// Which items are inside an own folder is the scanner's own question, asked of
// each stored path with the case rules of its volume (`isInsideOwnRoot`). The
// store narrows by folder ignoring ASCII case; a sibling that differs only by
// case (`~/Capture` beside `~/capture`) is another folder on a volume that keeps
// case, and is the person's, so nothing here goes by the store's match alone.
//
// It runs at worker start, before the worker answers anything, and is bounded
// by count and time so it cannot hold up start-up. What it leaves is removed by
// the next run: the next start, or the next pass of a chosen folder.

import type { RawItem, SourceConnector } from '../../core/contracts.ts';
import type { SourceItemIdentity } from '../../core/source-index/types.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import { localFilesDeletedItem } from './connector.ts';
import { isInsideOwnRoot, type DefaultExclusionContext } from './paths.ts';
import { localFilesStoreView } from './provider-store-sync.ts';
import { LOCAL_FILES_ACCOUNT_SCOPE, LOCAL_FILES_PROVIDER } from './scope.ts';
import { LOCAL_FILES_STORE_PLACEMENT } from './store.ts';

/** The store's id for the clean-up's own deletions; it is no folder's connector, and keeps no resume point. */
export const LOCAL_FILES_OWN_ROOTS_CLEANUP_CONNECTOR_ID = 'local.files.own-roots-cleanup';

/** The most indexed items under one own folder one look at the store reads (the walk's own limit). */
const SCAN_LIMIT = 250_000;
/** What a look reads first; it reads more only when everything it read belonged to siblings. */
const FIRST_LOOK = 500;
const DEFAULT_MAX_ITEMS = 5_000;
const DEFAULT_MAX_MS = 10_000;
const DEFAULT_BATCH = 200;

export interface LocalFilesOwnRootsCleanupOptions {
  store: LocalConnectorStore;
  /** The lane's tier stores, when it has them: the items may sit in any of them. */
  tierSet?: TieredStoreSet;
  /** The own folders, and how each volume treats case. */
  context: Pick<DefaultExclusionContext, 'ownRoots' | 'platform' | 'volumeIgnoresCase'>;
  /** At most this many items are removed by one run. */
  maxItems?: number;
  /** No new batch starts after this long. */
  maxMs?: number;
  /** Items removed per deletion run of the store. */
  batchSize?: number;
  /** Told what stopped a run (a message with no path or content in it). */
  log?: (message: string) => void;
}

export interface LocalFilesOwnRootsCleanupResult {
  /** Items this run removed. */
  removed: number;
  /** Nothing is left inside an own folder. */
  complete: boolean;
}

export interface LocalFilesOwnRootsCleanup {
  /**
   * Removes what is indexed inside the own folders, within the bounds. One run
   * at a time; once a run finds nothing left it answers at once. Never throws.
   */
  run(): Promise<LocalFilesOwnRootsCleanupResult>;
}

export function createLocalFilesOwnRootsCleanup(options: LocalFilesOwnRootsCleanupOptions): LocalFilesOwnRootsCleanup {
  const { store, tierSet, context } = options;
  const maxItems = Math.max(1, options.maxItems ?? DEFAULT_MAX_ITEMS);
  const maxMs = Math.max(0, options.maxMs ?? DEFAULT_MAX_MS);
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
  const view = localFilesStoreView(store, tierSet);
  let finished = (context.ownRoots ?? []).length === 0;
  let running: Promise<LocalFilesOwnRootsCleanupResult> | undefined;
  let toldWaiting = false;

  const inside = (locatorUri: string): boolean => {
    try { return isInsideOwnRoot(locatorUri, context); } catch { return false; }
  };

  /**
   * What is indexed inside an own folder, at most `limit` items. The store lists
   * what lies under a folder ignoring ASCII case, so a look is widened while it
   * keeps meeting siblings that differ only by case and are not inside.
   */
  const found = (limit: number): Array<{ identity: SourceItemIdentity; locatorUri: string }> => {
    const items = new Map<string, { identity: SourceItemIdentity; locatorUri: string }>();
    for (const base of context.ownRoots ?? []) {
      for (let window = Math.max(limit, FIRST_LOOK); ; window = Math.min(window * 4, SCAN_LIMIT)) {
        const stored = view.activeItemsUnderLocatorIfIndexed?.({
          provider: LOCAL_FILES_PROVIDER,
          accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
          locatorUri: base,
          limit: window,
        }) ?? [];
        for (const item of stored) {
          if (items.has(item.identity.providerItemId) || !inside(item.locatorUri)) continue;
          items.set(item.identity.providerItemId, item);
          if (items.size >= limit) return [...items.values()];
        }
        if (stored.length < window || window >= SCAN_LIMIT) break;
      }
    }
    return [...items.values()];
  };

  const deletionsConnector = (items: RawItem[]): SourceConnector => ({
    id: LOCAL_FILES_OWN_ROOTS_CLEANUP_CONNECTOR_ID,
    family: 'file',
    async authenticate() {},
    async *listItems() { yield { items, done: true }; },
    async fetchItem() { throw new Error('The clean-up lists deletions only.'); },
    classificationSignals() { return {}; },
  });

  const remove = async (batch: ReadonlyArray<{ identity: SourceItemIdentity; locatorUri: string }>): Promise<void> => {
    const at = new Date();
    const connector = deletionsConnector(batch.map((item) => localFilesDeletedItem(item.identity, item.locatorUri, at)));
    const sync = { placement: LOCAL_FILES_STORE_PLACEMENT, fetchContent: false };
    // Not a resume point of any folder's pass: it must not move the lane's cursor.
    if (tierSet) await tierSet.sync(connector, sync, { commitCursor: false });
    else await store.syncFromConnector(connector, sync);
  };

  const once = async (): Promise<LocalFilesOwnRootsCleanupResult> => {
    if (view.lookupsReady && !view.lookupsReady()) {
      // Asked again with every pass until it is ready: said once.
      if (!toldWaiting) options.log?.('The index of stored paths is still being prepared; what is inside Olympus\'s own folders is removed at the next run.');
      toldWaiting = true;
      return { removed: 0, complete: false };
    }
    const started = Date.now();
    let removed = 0;
    let previous = new Set<string>();
    for (;;) {
      const left = found(Math.max(1, Math.min(batchSize, maxItems - removed)));
      if (left.length === 0) {
        finished = true;
        return { removed, complete: true };
      }
      // The items just removed are still listed: the store did not take the deletion. Stop rather than ask again.
      if (left.some((item) => previous.has(item.identity.providerItemId))) {
        options.log?.('The store did not remove some items inside Olympus\'s own folders; they are tried again at the next run.');
        return { removed, complete: false };
      }
      if (removed >= maxItems || Date.now() - started >= maxMs) return { removed, complete: false };
      await remove(left);
      removed += left.length;
      previous = new Set(left.map((item) => item.identity.providerItemId));
    }
  };

  return {
    run() {
      if (finished) return Promise.resolve({ removed: 0, complete: true });
      running ??= once()
        .catch((error): LocalFilesOwnRootsCleanupResult => {
          options.log?.(`Items inside Olympus's own folders could not be removed this run (${error instanceof Error ? error.name : 'error'}); they are tried again at the next.`);
          return { removed: 0, complete: false };
        })
        .finally(() => { running = undefined; });
      return running;
    },
  };
}

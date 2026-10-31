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
// case (`~/Capture` beside an own `~/capture`) is another folder on a volume that
// keeps case, and is the person's, so nothing here goes by the store's match
// alone.
//
// The store is walked once, page by page, in its own order, from a position that
// is kept between runs: however many siblings sort first, a run goes on from
// where the last one stopped, and the clean-up is complete only when every page
// of every own folder in every store has been read. It runs at worker start,
// before the worker answers anything, and is bounded by count, by rows read and
// by time, so it cannot hold up start-up: the caller never waits longer than
// the time bound, and the deletion it asks for settles nothing else (the lane's
// next run does that). What a run leaves is removed by the next: the next pass
// of a chosen folder, or the next start.

import type { RawItem, SourceConnector } from '../../core/contracts.ts';
import type { SourceItemIdentity } from '../../core/source-index/types.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import { TIER_DOMAIN_ORDER, type TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import { localFilesDeletedItem } from './connector.ts';
import { isInsideOwnRoot, type DefaultExclusionContext } from './paths.ts';
import { localFilesStoreView } from './provider-store-sync.ts';
import { LOCAL_FILES_ACCOUNT_SCOPE, LOCAL_FILES_PROVIDER } from './scope.ts';
import { LOCAL_FILES_STORE_PLACEMENT } from './store.ts';

/** The store's id for the clean-up's own deletions; it is no folder's connector, and keeps no resume point. */
export const LOCAL_FILES_OWN_ROOTS_CLEANUP_CONNECTOR_ID = 'local.files.own-roots-cleanup';

const DEFAULT_MAX_ITEMS = 5_000;
const DEFAULT_MAX_MS = 10_000;
const DEFAULT_BATCH = 200;
const DEFAULT_PAGE = 1_000;
const DEFAULT_MAX_SCANNED = 1_000_000;

export interface LocalFilesOwnRootsCleanupOptions {
  /** The lane's tier stores: the items may sit in any of them. */
  tierSet: TieredStoreSet;
  /** The own folders, and how each volume treats case. */
  context: Pick<DefaultExclusionContext, 'ownRoots' | 'platform' | 'volumeIgnoresCase'>;
  /** At most this many items are removed by one run. */
  maxItems?: number;
  /** A run reads and removes nothing more after this long, and its caller waits no longer than this. */
  maxMs?: number;
  /** Items removed per deletion run of the store. */
  batchSize?: number;
  /** Stored paths read per page of the index. */
  pageSize?: number;
  /** At most this many stored paths are read by one run; the next run goes on from there. */
  maxScanned?: number;
  /** Told what stopped a run (a message with no path or content in it). */
  log?: (message: string) => void;
}

export interface LocalFilesOwnRootsCleanupResult {
  /** Items this run removed. */
  removed: number;
  /** Every stored path under every own folder has been read and nothing is left inside one. */
  complete: boolean;
}

export interface LocalFilesOwnRootsCleanup {
  /**
   * Removes what is indexed inside the own folders, within the bounds. One run
   * at a time; once a run finds nothing left it answers at once. Never throws.
   */
  run(): Promise<LocalFilesOwnRootsCleanupResult>;
  /**
   * Settles once no run is in flight. A pass waits for it before its own sync,
   * so a batch `run` released its caller from is never writing beside it.
   */
  idle(): Promise<void>;
}

export function createLocalFilesOwnRootsCleanup(options: LocalFilesOwnRootsCleanupOptions): LocalFilesOwnRootsCleanup {
  const { tierSet, context } = options;
  const maxItems = Math.max(1, options.maxItems ?? DEFAULT_MAX_ITEMS);
  const maxMs = Math.max(0, options.maxMs ?? DEFAULT_MAX_MS);
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
  const pageSize = Math.max(1, options.pageSize ?? DEFAULT_PAGE);
  const maxScanned = Math.max(1, options.maxScanned ?? DEFAULT_MAX_SCANNED);
  const view = localFilesStoreView(tierSet);
  // Every store the items may sit in, each walked under every own folder.
  const stores: LocalConnectorStore[] = TIER_DOMAIN_ORDER
    .flatMap((domain) => { const leg = tierSet.store(domain); return leg ? [leg] : []; });
  interface Walk { store: LocalConnectorStore; root: string; after?: string; done: boolean }
  const walks: Walk[] = stores.flatMap((leg) => (context.ownRoots ?? []).map((root): Walk => ({ store: leg, root, done: false })));
  let finished = walks.length === 0;
  let running: Promise<LocalFilesOwnRootsCleanupResult> | undefined;
  let removedNow = 0;
  let toldWaiting = false;
  let toldRemovalFailure = false;
  const resetWalks = (): void => { for (const walk of walks) { walk.done = false; delete walk.after; } };
  const reportRemovalFailure = (message: string): void => {
    if (!toldRemovalFailure) options.log?.(message);
    toldRemovalFailure = true;
  };
  const waitForIndex = (): LocalFilesOwnRootsCleanupResult => {
    if (!toldWaiting) options.log?.('The index of stored paths is still being prepared; what is inside Olympus\'s own folders is removed at the next run.');
    toldWaiting = true;
    resetWalks();
    return { removed: removedNow, complete: false };
  };
  const lookupsReady = (): boolean => view.lookupsReady?.() ?? true;

  const inside = (locatorUri: string): boolean => {
    try { return isInsideOwnRoot(locatorUri, context); } catch { return false; }
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
    // Not a resume point of any folder's pass, and nothing else settled first: the deletion is all it does.
    await tierSet.sync(connector, sync, { commitCursor: false, settle: false });
  };

  const once = async (): Promise<LocalFilesOwnRootsCleanupResult> => {
    removedNow = 0;
    if (!lookupsReady()) return waitForIndex();
    const started = Date.now();
    const timeUp = (): boolean => Date.now() - started >= maxMs;
    let scanned = 0;
    let attempted = 0;
    for (const walk of walks) {
      while (!walk.done) {
        if (timeUp() || attempted >= maxItems || scanned >= maxScanned) return { removed: removedNow, complete: false };
        if (!lookupsReady()) return waitForIndex();
        const page = walk.store.pageActiveItemsUnderLocatorIfIndexed({
          provider: LOCAL_FILES_PROVIDER,
          accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
          locatorUri: walk.root,
          limit: pageSize,
          ...(walk.after !== undefined ? { after: walk.after } : {}),
        });
        if (!lookupsReady()) return waitForIndex();
        scanned += page.items.length;
        const hits = page.items.filter((item) => inside(item.locatorUri));
        for (let index = 0; index < hits.length;) {
          // A page cut short here is read again from its start: what was removed is no longer listed.
          if (timeUp() || attempted >= maxItems) return { removed: removedNow, complete: false };
          const batch = hits.slice(index, index + Math.min(batchSize, maxItems - attempted));
          await remove(batch);
          attempted += batch.length;
          const kept = batch.filter((item) => walk.store.itemPresence(item.identity).active).length;
          removedNow += batch.length - kept;
          index += batch.length;
          // No progress is claimed for attempted deletions. Keep failed rows in the
          // next walk even if this run's count/time bound was reached by the batch.
          if (kept > 0) {
            reportRemovalFailure('The store did not remove some items inside Olympus\'s own folders; they are tried again at the next run.');
            resetWalks();
            return { removed: removedNow, complete: false };
          }
        }
        if (page.next === undefined) walk.done = true;
        else walk.after = page.next;
        // The worker stays responsive between pages.
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
    }
    // An empty projection from a concurrently invalidated index is not proof
    // that the own folders are empty. Start the walk again after backfill.
    if (!lookupsReady()) return waitForIndex();
    finished = true;
    return { removed: removedNow, complete: true };
  };

  return {
    run() {
      if (finished) return Promise.resolve({ removed: 0, complete: true });
      running ??= once()
        .catch((error): LocalFilesOwnRootsCleanupResult => {
          resetWalks();
          reportRemovalFailure(`Items inside Olympus's own folders could not be removed this run (${error instanceof Error ? error.name : 'error'}); they are tried again at the next.`);
          return { removed: removedNow, complete: false };
        })
        .finally(() => { running = undefined; });
      // The caller waits no longer than the time bound, whatever the store is doing: a batch in flight
      // finishes on its own, and the next run goes on from there.
      const work = running;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<LocalFilesOwnRootsCleanupResult>((resolve) => {
        timer = setTimeout(() => resolve({ removed: removedNow, complete: false }), maxMs);
        (timer as { unref?: () => void }).unref?.();
      });
      return Promise.race([work, bound]).finally(() => { if (timer) clearTimeout(timer); });
    },
    async idle() {
      while (running) await running;
    },
  };
}

export interface LocalFilesOwnRootsRecovery {
  /** One bounded startup pass; incomplete work continues without the scheduler. */
  initial: Promise<void>;
  /** Only a completed cleanup opens the lane to readers. */
  ready(): boolean;
  close(): void;
}

/** Finish bounded cleanup and upgraded locator projections without holding worker startup. */
export function createLocalFilesOwnRootsRecovery(options: {
  cleanup: LocalFilesOwnRootsCleanup;
  stores(): readonly Pick<LocalConnectorStore, 'locatorIdentityIndexReady' | 'ensureLocatorIdentityIndexReady'>[];
  retryMs?: number;
  maxRetryMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  log?(message: string): void;
}): LocalFilesOwnRootsRecovery {
  let closed = false;
  let complete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const setTimer = options.setTimeoutImpl ?? setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? clearTimeout;
  const retryMs = Math.max(1, options.retryMs ?? 25);
  const maxRetryMs = Math.max(retryMs, options.maxRetryMs ?? 1000);
  let delay = retryMs;
  let toldWaiting = false;
  const schedule = (progress: boolean): void => {
    if (closed || complete || timer) return;
    if (!toldWaiting) {
      toldWaiting = true;
      options.log?.('Local-file reads wait until cleanup of Olympus-owned folders completes; recovery continues in the background.');
    }
    if (progress) delay = retryMs;
    timer = setTimer(() => { timer = undefined; void recover(); }, delay);
    timer.unref();
    delay = Math.min(maxRetryMs, delay * 2);
  };
  const observe = (result: LocalFilesOwnRootsCleanupResult): void => {
    if (closed) return;
    if (result.complete) complete = true;
    else schedule(result.removed > 0);
  };
  const recover = async (): Promise<void> => {
    let progress = false;
    try {
      // A timed-out deletion batch still owns the lane until it finishes.
      await options.cleanup.idle();
      if (closed) return;
      for (const store of options.stores()) {
        if (closed) return;
        if (!store.locatorIdentityIndexReady()) {
          const backfill = await store.ensureLocatorIdentityIndexReady({ maxItems: 1000, maxWindows: 1 });
          if (closed) return;
          progress ||= backfill.scannedItems > 0;
          if (backfill.state !== 'ready') { schedule(progress); return; }
        }
      }
      observe(await options.cleanup.run());
    } catch {
      // The gate stays closed on persistent errors; retries remain bounded and cancellable.
      schedule(progress);
    }
  };
  const initial = (async () => {
    try { observe(await options.cleanup.run()); } catch { schedule(false); }
  })();
  return {
    initial,
    ready: () => !closed && complete,
    close() {
      closed = true;
      complete = false;
      if (timer) clearTimer(timer);
      timer = undefined;
    },
  };
}

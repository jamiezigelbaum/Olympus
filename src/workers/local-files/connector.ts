/**
 * Contract 1 (SourceConnector) for files on this computer.
 *
 * Thin by design: this file lists the files under ONE approved folder, reads
 * one file's bytes, and says which names and folders a file belongs to. Tiers,
 * extraction, indexing and answers are the shared pipeline. Where a file's
 * bytes are and how a read is kept inside the approved folder is the one
 * source-shaped concern, and it lives in `core/scope-safe-fs.ts`.
 *
 * Two ways to list, chosen by the cursor:
 *  - no cursor: walk the folder (`lstat`, never following a link) and emit
 *    every file the person's scope allows. The store then treats the walk as a
 *    complete snapshot, so a file that vanished while Olympus was not running
 *    is removed.
 *  - a cursor naming a change snapshot: replay what the file system reported
 *    since that snapshot and emit only those paths. A path that no longer
 *    exists becomes a deletion, and so does every indexed file under a folder
 *    that was deleted or moved away.
 *
 * A symlink is listed by its name and never read through. A file kept only in
 * iCloud (a placeholder) is listed by name and never downloaded.
 */
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, rmSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { compactClassificationSignals, namesOnlyContentScopeMetadata, signalText, signalTexts } from '../../core/classification-signals.ts';
import type {
  RawItem,
  SourceClassificationSignals,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import { FileExtractionSourceError } from '../../core/file-extraction-source.ts';
import { fileMimeTypeFromName } from '../../core/file-mime.ts';
import { ScopeRoot, ScopeSafeError, joinRelative, type ScopeStat } from '../../core/scope-safe-fs.ts';
import type { SourceItemIdentity } from '../../core/source-index/types.ts';
import { realPathOfScopePath } from './locations.ts';
import { isWithinScopePath, normalizeScopePath, scopeParentPath } from './paths.ts';
import {
  LOCAL_FILES_ACCOUNT_SCOPE,
  LOCAL_FILES_PROVIDER,
  type LocalFilesContentScope,
  type LocalFilesDecision,
} from './scope.ts';
import type { VolumeResolver } from './volume-identity.ts';
import { WatchHistoryUnavailableError, ignoreGlobsForRoot, type WatchEvent, type WatchHub } from './watch-hub.ts';

export const LOCAL_FILES_CURSOR_PREFIX = 'lf1:';
/** The cursor of a pass that left no change snapshot: the next pass walks again. */
export const LOCAL_FILES_POLL_CURSOR = `${LOCAL_FILES_CURSOR_PREFIX}poll`;

const DEFAULT_MAX_FETCH_BYTES = 64_000_000;
const DEFAULT_PAGE_SIZE = 500;
const DELETED_DESCENDANT_BATCH = 2_000;
const DELETED_DESCENDANT_MAX_BATCHES = 200;
const MAX_FOLDER_KEYS = 32;
const MAX_EVENT_PATHS = 200_000;
/** How many indexed items under a folder one full walk compares against what it met. */
const ABSENCE_SCAN_LIMIT = 250_000;

/** The approved folder is not there (renamed, deleted, or its disk is not mounted). */
export class LocalFilesRootMissingError extends Error {
  constructor(readonly scopePath: string) {
    super('A chosen folder is missing.');
    this.name = 'LocalFilesRootMissingError';
  }
}

/** The system will not let Olympus read the approved folder (a macOS permission prompt, or a mode). */
export class LocalFilesRootPermissionError extends Error {
  /** Which refusal the system gave: EPERM is the Mac's privacy rule, EACCES ordinary file permissions. */
  constructor(readonly scopePath: string, readonly errno?: 'EACCES' | 'EPERM') {
    super('Olympus is not allowed to read a chosen folder.');
    this.name = 'LocalFilesRootPermissionError';
  }
}

/** The change history this pass was to resume from cannot be replayed: list everything again. */
export class LocalFilesHistoryResetError extends Error {
  constructor(detail: string) {
    super(`The change history cannot be replayed: ${detail}`);
    this.name = 'LocalFilesHistoryResetError';
  }
}

/** The store's side of a deletion: which indexed items a deleted path stands for. */
export interface LocalFilesStoreView {
  activeIdentityForLocatorIfIndexed(input: {
    provider: string;
    accountScope: string;
    locatorUri: string;
  }): SourceItemIdentity | undefined;
  activeItemsUnderLocatorIfIndexed?(input: {
    provider: string;
    accountScope: string;
    locatorUri: string;
    limit: number;
  }): ReadonlyArray<{ identity: SourceItemIdentity; locatorUri: string }>;
  /** Files and folders directly under `/`, for a walk of the whole computer to tell one is gone. */
  activeItemsDirectlyUnderRootIfIndexed?(input: {
    provider: string;
    accountScope: string;
    limit: number;
  }): ReadonlyArray<{ identity: SourceItemIdentity; locatorUri: string }>;
  lookupsReady?(): boolean;
}

export interface LocalFilesWatch {
  hub: WatchHub;
  /** Where change snapshots for this connector are kept. */
  snapshotDir: string;
  /** Globs a live watch and a replay leave out. */
  ignore?: readonly string[];
}

export interface LocalFilesWalkStats {
  directories: number;
  files: number;
  unreadable: number;
  /** Folders and files a walk could not read; what is indexed under them is not judged by that walk. */
  unreadablePaths?: string[];
  /** The folders directly under the walked root that the walk met. */
  topLevel?: string[];
}

export interface LocalFilesConnectorOptions {
  /** The store's connector id for this folder and approval. */
  connectorId: string;
  /** The approved folder, as a scope path. */
  root: string;
  scope: LocalFilesContentScope;
  volumes: VolumeResolver;
  /** Deletions are resolved against the store; absent: deletions are not emitted. */
  store?: LocalFilesStoreView;
  /** Where a stored item lives, for reading its bytes later. */
  locate?: (localItemId: string) => string | undefined;
  watch?: LocalFilesWatch;
  maxFetchBytes?: number;
  pageSize?: number;
  /** Test seam: how many indexed items under a deleted folder one lookup returns. */
  deletedDescendantBatch?: number;
  now?: () => Date;
  onWalk?: (stats: LocalFilesWalkStats) => void;
}

export interface LocalFilesSourceConnector extends SourceConnector {
  fetchItemWithin(
    localItemId: string,
    options: { maxBytes?: number; expectedVersion?: string },
  ): Promise<RawItem>;
}

/**
 * The relative path as the file system spells it, found by matching each name
 * on its composed (NFC) form. Undefined when a name is missing, or when two
 * names compose to the same text (which one is meant cannot be told).
 */
function nameAsOnDisk(scopeRoot: ScopeRoot, rel: string): string | undefined {
  let dir = '';
  for (const part of rel.split('/')) {
    const wanted = part.normalize('NFC');
    const matches = scopeRoot.list(dir).filter((entry) => entry.name.normalize('NFC') === wanted);
    if (matches.length !== 1) return undefined;
    dir = joinRelative(dir, matches[0]!.name);
  }
  return dir;
}

export function localFilesItemId(scopePath: string): string {
  return `f1.${createHash('sha256').update(scopePath.normalize('NFC')).digest('hex').slice(0, 32)}`;
}

function identityFor(scopePath: string, version?: string): SourceItemIdentity {
  const providerItemId = localFilesItemId(scopePath);
  return {
    family: 'file',
    provider: LOCAL_FILES_PROVIDER,
    accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
    providerItemId,
    providerFileId: providerItemId,
    localItemId: `${LOCAL_FILES_ACCOUNT_SCOPE}:${providerItemId}`,
    ...(version ? { sourceVersion: version } : {}),
  };
}

/** `size.mtimeMs.dev.ino`, plus `.p` for a placeholder. Names the file as listed. */
export function localFilesSourceVersion(stat: Pick<ScopeStat, 'size' | 'mtimeMs' | 'dev' | 'ino' | 'dataless'>): string {
  return `${stat.size}.${Math.trunc(stat.mtimeMs)}.${stat.dev}.${stat.ino}${stat.dataless ? '.p' : ''}`;
}

function parseVersion(version: string | undefined): { dev: string; ino: string } | undefined {
  if (!version) return undefined;
  const parts = version.split('.');
  if (parts.length < 4) return undefined;
  const dev = parts[2];
  const ino = parts[3];
  return dev && ino ? { dev, ino } : undefined;
}

function folderKeysOf(scopePath: string): string[] {
  const keys: string[] = [];
  let parent = scopeParentPath(scopePath);
  while (parent && parent !== '/' && keys.length < MAX_FOLDER_KEYS) {
    keys.push(parent);
    parent = scopeParentPath(parent);
  }
  return keys.reverse();
}

export function createLocalFilesSourceConnector(options: LocalFilesConnectorOptions): LocalFilesSourceConnector {
  const root = normalizeScopePath(options.root);
  const now = options.now ?? (() => new Date());
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxFetchBytes = options.maxFetchBytes ?? DEFAULT_MAX_FETCH_BYTES;
  const batchSize = options.deletedDescendantBatch ?? DELETED_DESCENDANT_BATCH;

  const resolveRoot = (): { real: string; walkRoot: ScopeRoot } => {
    const configured = realPathOfScopePath(options.volumes, root);
    if (!configured) throw new LocalFilesRootMissingError(root);
    let real: string;
    try {
      real = realpathSync.native(configured);
    } catch {
      throw new LocalFilesRootMissingError(root);
    }
    try {
      return { real, walkRoot: ScopeRoot.open(real) };
    } catch (error) {
      if (error instanceof ScopeSafeError && error.code === 'not_found') throw new LocalFilesRootMissingError(root);
      if (error instanceof ScopeSafeError && error.code === 'permission') throw new LocalFilesRootPermissionError(root, error.errno);
      throw error;
    }
  };

  // Whether names differ by case on this volume is the scope's one decision
  // (a scope that cannot say compares exactly). Stored locators and event
  // paths keep the spelling the disk gave them at the time, so a case-only
  // rename on a volume that ignores case must not read as a different place.
  const foldPath = (path: string, forScopePath: string = root): string =>
    options.scope.ignoresCase?.(forScopePath) ? path.toLowerCase() : path;
  const pathIsAtOrBelow = (path: string, ancestor: string): boolean =>
    isWithinScopePath(foldPath(path, path), foldPath(ancestor, ancestor));

  const scopePathOf = (relPath: string): string => (relPath === '' ? root : posix.join(root, relPath).normalize('NFC'));

  const fileItem = (
    scopePath: string,
    name: string,
    stat: ScopeStat,
    decision: LocalFilesDecision,
  ): RawItem => {
    const mimeType = fileMimeTypeFromName(name);
    const modified = new Date(stat.mtimeMs).toISOString();
    const namesOnly = decision !== 'content' || stat.dataless;
    return {
      identity: identityFor(scopePath, localFilesSourceVersion(stat)),
      mimeType,
      content: { kind: 'metadata_only' },
      metadata: Object.freeze({
        entryKind: 'file',
        deleted: false,
        name,
        mimeType,
        locatorUri: scopePath,
        pathDisplay: scopePath,
        sizeBytes: stat.size,
        clientModifiedAt: modified,
        updatedAt: modified,
        folderKeys: folderKeysOf(scopePath),
        ...(stat.dataless ? { placeholder: true } : {}),
        ...(namesOnly ? namesOnlyContentScopeMetadata() : {}),
      }),
      fetchedAt: now().toISOString(),
    };
  };

  const symlinkItem = (scopePath: string, name: string): RawItem => ({
    identity: identityFor(scopePath, 'link'),
    mimeType: 'inode/symlink',
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({
      entryKind: 'symlink',
      deleted: false,
      name,
      mimeType: 'inode/symlink',
      locatorUri: scopePath,
      pathDisplay: scopePath,
      folderKeys: folderKeysOf(scopePath),
      ...namesOnlyContentScopeMetadata(),
    }),
    fetchedAt: now().toISOString(),
  });

  const deletedItem = (identity: SourceItemIdentity, locatorUri: string): RawItem => ({
    identity,
    mimeType: 'application/octet-stream',
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({
      entryKind: 'deleted',
      deleted: true,
      deletedIdentityResolved: true,
      name: locatorUri.slice(locatorUri.lastIndexOf('/') + 1),
      locatorUri,
      pathDisplay: locatorUri,
    }),
    fetchedAt: now().toISOString(),
  });

  /** The deletions a path that no longer exists stands for: itself, and everything indexed under it. */
  const deletionsFor = (scopePath: string, seen: Set<string>): RawItem[] => {
    const store = options.store;
    if (!store) return [];
    if (store.lookupsReady && !store.lookupsReady()) {
      throw new Error('The local files index is still being prepared; deletions wait for the next pass.');
    }
    const items: RawItem[] = [];
    const own = store.activeIdentityForLocatorIfIndexed({
      provider: LOCAL_FILES_PROVIDER,
      accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
      locatorUri: scopePath,
    });
    // The store compares locators ignoring ASCII case; on a volume that keeps
    // case, `/a` must not stand for `/A`. The id is the exact path's hash.
    const ownMatches = own && (options.scope.ignoresCase?.(scopePath) || own.providerItemId === localFilesItemId(scopePath));
    if (own && ownMatches && !seen.has(own.providerItemId)) {
      seen.add(own.providerItemId);
      items.push(deletedItem(own, scopePath));
    }
    if (store.activeItemsUnderLocatorIfIndexed) {
      const elsewhere = new Set<string>();
      for (let batch = 0; batch < DELETED_DESCENDANT_MAX_BATCHES; batch += 1) {
        const found = store.activeItemsUnderLocatorIfIndexed({
          provider: LOCAL_FILES_PROVIDER,
          accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
          locatorUri: scopePath,
          // The store lists in a fixed order and does not know what this pass
          // already collected (nothing is committed yet), so each round asks
          // for a longer prefix of the same list and keeps only the new rows.
          limit: batchSize * (batch + 1),
        });
        let fresh = 0;
        for (const descendant of found) {
          if (seen.has(descendant.identity.providerItemId) || elsewhere.has(descendant.identity.providerItemId)) continue;
          // A sibling spelled differently only by case, on a volume that keeps
          // case, is another folder: counted as progress, never deleted.
          if (!pathIsAtOrBelow(descendant.locatorUri, scopePath)) {
            elsewhere.add(descendant.identity.providerItemId);
            fresh += 1;
            continue;
          }
          seen.add(descendant.identity.providerItemId);
          items.push(deletedItem(descendant.identity, descendant.locatorUri));
          fresh += 1;
        }
        // The store lists only items still active. A batch that brought
        // nothing new means the earlier ones are not committed yet: the next
        // pass finds the rest.
        if (fresh === 0 || found.length < batchSize * (batch + 1)) break;
      }
    }
    return items;
  };

  /**
   * The deletions for indexed items under the folder that a complete walk did
   * not meet. Items under a folder or file the walk could not read are not
   * judged: only what was fully listed counts as absent. The store refuses to
   * list "everything under /", so a walk of the whole computer asks per
   * top-level folder (and per chosen folder) instead.
   */
  const absentFromWalk = (
    seenIds: ReadonlySet<string>,
    deletedSeen: Set<string>,
    unreadable: readonly string[],
    topLevel: readonly string[],
  ): RawItem[] => {
    const store = options.store;
    if (!store?.activeItemsUnderLocatorIfIndexed) return [];
    if (store.lookupsReady && !store.lookupsReady()) return [];
    const bases = root === '/'
      ? [...new Set([...topLevel, ...options.scope.roots().map((entry) => entry.scopePath).filter((path) => path !== '/')])]
      : [root];
    const absent: RawItem[] = [];
    const judge = (stored: { identity: SourceItemIdentity; locatorUri: string }, base?: string): void => {
      // The store's range ignores ASCII case; on a volume that keeps case a
      // sibling spelled differently (`/a` beside `/A`) is not under `base`.
      if (base !== undefined && !pathIsAtOrBelow(stored.locatorUri, base)) return;
      if (seenIds.has(stored.identity.providerItemId) || deletedSeen.has(stored.identity.providerItemId)) return;
      if (unreadable.some((path) => pathIsAtOrBelow(stored.locatorUri, path))) return;
      deletedSeen.add(stored.identity.providerItemId);
      absent.push(deletedItem(stored.identity, stored.locatorUri));
    };
    // Files directly under `/` belong to no top-level folder, so the per-folder
    // reads below never reach them: ask for them on their own.
    if (root === '/' && store.activeItemsDirectlyUnderRootIfIndexed) {
      for (const stored of store.activeItemsDirectlyUnderRootIfIndexed({
        provider: LOCAL_FILES_PROVIDER,
        accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
        limit: ABSENCE_SCAN_LIMIT,
      })) judge(stored);
    }
    for (const base of bases) {
      for (const stored of store.activeItemsUnderLocatorIfIndexed({
        provider: LOCAL_FILES_PROVIDER,
        accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
        locatorUri: base,
        limit: ABSENCE_SCAN_LIMIT,
      })) {
        judge(stored, base);
      }
    }
    return absent;
  };

  /**
   * The deletions for whatever is indexed inside Olympus's own folders. They are
   * never indexed now, but an earlier version indexed one the person had chosen
   * by name, and such a folder is no longer a root (`localFilesRoots`), so no
   * walk of it ever judges what is stored there. Asked on every pass, whatever
   * the pass's folder is: a store with nothing under them answers at once.
   */
  const ownRootDeletions = (deletedSeen: Set<string>): RawItem[] => {
    const store = options.store;
    const ownRoots = options.scope.ownRoots?.() ?? [];
    if (!store?.activeItemsUnderLocatorIfIndexed || ownRoots.length === 0) return [];
    if (store.lookupsReady && !store.lookupsReady()) return [];
    const items: RawItem[] = [];
    const judge = (stored: { identity: SourceItemIdentity; locatorUri: string }, base: string): void => {
      // The store's range ignores ASCII case; on a volume that keeps case a
      // sibling spelled differently (`Olympus` beside `olympus`) is not inside `base`.
      if (!pathIsAtOrBelow(stored.locatorUri, base)) return;
      if (deletedSeen.has(stored.identity.providerItemId)) return;
      deletedSeen.add(stored.identity.providerItemId);
      items.push(deletedItem(stored.identity, stored.locatorUri));
    };
    for (const base of ownRoots) {
      const self = store.activeIdentityForLocatorIfIndexed({
        provider: LOCAL_FILES_PROVIDER,
        accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
        locatorUri: base,
      });
      if (self) judge({ identity: self, locatorUri: base }, base);
      for (const stored of store.activeItemsUnderLocatorIfIndexed({
        provider: LOCAL_FILES_PROVIDER,
        accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
        locatorUri: base,
        limit: ABSENCE_SCAN_LIMIT,
      })) judge(stored, base);
    }
    return items;
  };

  /** True when a folder the person chose lies at or below `scopePath`. */
  const leadsToSelection = (scopePath: string): boolean =>
    options.scope.roots().some((entry) => entry.scopePath !== root && pathIsAtOrBelow(entry.scopePath, scopePath));

  /** Everything under `startRel` (a directory), as items, honoring the person's scope. */
  async function* walk(
    scopeRoot: ScopeRoot,
    startRel: string,
    decide: (scopePath: string) => LocalFilesDecision,
    stats: LocalFilesWalkStats,
    emitted: Set<string>,
  ): AsyncGenerator<RawItem> {
    const stack: string[] = [startRel];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = scopeRoot.list(dir);
      } catch (error) {
        if (error instanceof ScopeSafeError) {
          // A folder that cannot be read (permission, a mount point, gone):
          // skipped, counted, never fatal.
          stats.unreadable += 1;
          (stats.unreadablePaths ??= []).push(scopePathOf(dir));
          continue;
        }
        throw error;
      }
      stats.directories += 1;
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const rel = joinRelative(dir, entry.name);
        const scopePath = scopePathOf(rel);
        if (emitted.has(scopePath)) continue;
        const decision = decide(scopePath);
        if (decision === 'denied') {
          // A folder the scope leaves out can still lead to a folder the
          // person chose by name (a chosen folder inside Library, say).
          if (entry.kind === 'directory' && leadsToSelection(scopePath)) stack.push(rel);
          continue;
        }
        if (entry.kind === 'symlink') {
          emitted.add(scopePath);
          yield symlinkItem(scopePath, entry.name);
        } else if (entry.kind === 'directory') {
          if (dir === '' && root === '/') (stats.topLevel ??= []).push(scopePath);
          stack.push(rel);
        } else if (entry.kind === 'file' || entry.kind === undefined) {
          let stat: ScopeStat;
          try {
            // The directory entry already says what this is; a file's size and
            // time come from lstat, which needs no permission on the file.
            stat = scopeRoot.statEntry(rel);
          } catch (error) {
            if (error instanceof ScopeSafeError) {
              if (error.code === 'escape') {
                // A link whose type the directory did not say.
                emitted.add(scopePath);
                yield symlinkItem(scopePath, entry.name);
              } else {
                stats.unreadable += 1;
                (stats.unreadablePaths ??= []).push(scopePath);
              }
              continue;
            }
            throw error;
          }
          if (stat.kind === 'symlink') {
            emitted.add(scopePath);
            yield symlinkItem(scopePath, entry.name);
            continue;
          }
          if (stat.kind === 'directory') {
            stack.push(rel);
            continue;
          }
          if (stat.kind !== 'file') continue;
          stats.files += 1;
          emitted.add(scopePath);
          yield fileItem(scopePath, entry.name, stat, decision);
        }
      }
    }
  }

  const snapshotFile = (gen: string): string => join(options.watch!.snapshotDir, `${options.connectorId}.${gen}.snap`);

  const pruneSnapshots = (keep: readonly string[]): void => {
    if (!options.watch) return;
    const keepNames = new Set(keep.map((gen) => `${options.connectorId}.${gen}.snap`));
    try {
      for (const name of readdirSync(options.watch.snapshotDir)) {
        if (name.startsWith(`${options.connectorId}.`) && name.endsWith('.snap') && !keepNames.has(name)) {
          rmSync(join(options.watch.snapshotDir, name), { force: true });
        }
      }
    } catch { /* nothing to prune */ }
  };

  async function* changedPaths(
    scopeRoot: ScopeRoot,
    real: string,
    events: readonly WatchEvent[],
    decide: (scopePath: string) => LocalFilesDecision,
    stats: LocalFilesWalkStats,
    emitted: Set<string>,
    deletedSeen: Set<string>,
  ): AsyncGenerator<RawItem> {
    const latest = new Map<string, WatchEvent['type']>();
    for (const event of events) {
      // The whole computer is `/`; every other root is a path without a trailing slash.
      const prefix = real === '/' ? '/' : `${real}/`;
      if (!foldPath(event.path).startsWith(foldPath(prefix))) continue;
      latest.set(event.path.slice(prefix.length), event.type);
      if (latest.size > MAX_EVENT_PATHS) throw new LocalFilesHistoryResetError('too many changes to replay');
    }
    // Parents before children, so a created folder is walked once.
    const rels = [...latest.keys()].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    for (const rel of rels) {
      const scopePath = scopePathOf(rel);
      if (emitted.has(scopePath)) continue;
      const decision = decide(scopePath);
      let stat: ScopeStat | undefined;
      let linkName: string | undefined;
      try {
        stat = scopeRoot.statRelative(rel);
      } catch (error) {
        if (!(error instanceof ScopeSafeError)) throw error;
        if (error.code === 'escape') {
          // A link, or a mount point: the parent's listing says which.
          const slash = rel.lastIndexOf('/');
          const parent = slash < 0 ? '' : rel.slice(0, slash);
          const name = rel.slice(slash + 1);
          try {
            const entry = scopeRoot.list(parent).find((candidate) => candidate.name === name);
            if (entry?.kind === 'symlink') linkName = name;
          } catch { /* the parent is gone too */ }
          if (linkName === undefined) continue;
        } else if (error.code !== 'not_found') {
          stats.unreadable += 1;
          continue;
        }
      }
      if (linkName !== undefined) {
        if (decision === 'denied') continue;
        emitted.add(scopePath);
        yield symlinkItem(scopePath, linkName);
        continue;
      }
      if (!stat) {
        // Gone. Its own item and everything indexed under it go too.
        for (const deletion of deletionsFor(scopePath, deletedSeen)) yield deletion;
        continue;
      }
      if (decision === 'denied') {
        // Moved into a place the person's scope leaves out: not indexed here,
        // and nothing of it stays.
        for (const deletion of deletionsFor(scopePath, deletedSeen)) yield deletion;
        continue;
      }
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      if (stat.kind === 'file') {
        stats.files += 1;
        emitted.add(scopePath);
        yield fileItem(scopePath, name, stat, decision);
      } else if (stat.kind === 'directory' && latest.get(rel) !== 'update') {
        yield* walk(scopeRoot, rel, decide, stats, emitted);
      }
    }
  }

  return {
    id: options.connectorId,
    family: 'file',

    async authenticate(): Promise<void> {
      options.scope.assertCurrent();
    },

    listItems(listOptions?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      const cursor = listOptions?.cursor;
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        const { real, walkRoot } = resolveRoot();
        try {
          const decide = options.scope.snapshotDecider();
          const stats: LocalFilesWalkStats = { directories: 0, files: 0, unreadable: 0 };
          const emitted = new Set<string>();
          const deletedSeen = new Set<string>();
          const priorGen = cursor?.startsWith(LOCAL_FILES_CURSOR_PREFIX) ? cursor.slice(LOCAL_FILES_CURSOR_PREFIX.length) : undefined;
          const replay = priorGen !== undefined && priorGen !== 'poll';
          const nextGen = randomUUID();

          // The new snapshot is taken BEFORE the old history is read or the
          // folder is walked: a change that lands meanwhile is then seen
          // twice (harmless) and never zero times.
          let wroteSnapshot = false;
          if (options.watch) {
            try {
              await options.watch.hub.writeSnapshot(real, snapshotFile(nextGen), ignoreGlobsForRoot(options.watch.ignore ?? [], real));
              wroteSnapshot = true;
            } catch {
              wroteSnapshot = false;
            }
          }
          let events: WatchEvent[] | undefined;
          if (replay) {
            if (!options.watch) throw new LocalFilesHistoryResetError('no change watcher');
            try {
              events = await options.watch.hub.eventsSince(real, snapshotFile(priorGen), ignoreGlobsForRoot(options.watch.ignore ?? [], real));
            } catch (error) {
              if (error instanceof WatchHistoryUnavailableError) throw new LocalFilesHistoryResetError(error.message);
              throw error;
            }
          }

          let page: RawItem[] = [];
          const seenIds = new Set<string>();
          const source: AsyncGenerator<RawItem> = events
            ? changedPaths(walkRoot, real, events, decide, stats, emitted, deletedSeen)
            : walk(walkRoot, '', decide, stats, emitted);
          for await (const item of source) {
            if (item.metadata['deleted'] !== true) seenIds.add(item.identity.providerItemId);
            page.push(item);
            if (page.length >= pageSize) {
              options.scope.assertCurrent();
              yield { items: page, done: false };
              page = [];
            }
          }
          // A complete walk is a complete picture of the folder: whatever is
          // indexed under it and was not seen has been deleted or moved away
          // (for example while Olympus was not running).
          if (!events) {
            for (const deletion of absentFromWalk(seenIds, deletedSeen, stats.unreadablePaths ?? [], stats.topLevel ?? [])) {
              page.push(deletion);
              if (page.length >= pageSize) {
                options.scope.assertCurrent();
                yield { items: page, done: false };
                page = [];
              }
            }
          }
          for (const deletion of ownRootDeletions(deletedSeen)) {
            page.push(deletion);
            if (page.length >= pageSize) {
              options.scope.assertCurrent();
              yield { items: page, done: false };
              page = [];
            }
          }
          options.scope.assertCurrent();
          options.onWalk?.(stats);
          if (options.watch && wroteSnapshot) {
            options.watch.hub.noteDirectoryCount(real, stats.directories);
            pruneSnapshots([nextGen, ...(replay ? [priorGen] : [])]);
          }
          const nextCursor = wroteSnapshot ? `${LOCAL_FILES_CURSOR_PREFIX}${nextGen}` : LOCAL_FILES_POLL_CURSOR;
          // Absence was judged above only for what was fully listed, so a
          // walk with an unreadable corner is still complete for the rest.
          yield { items: page, nextCursor, done: true };
        } finally {
          walkRoot.close();
        }
      })();
    },

    async fetchItem(localItemId: string): Promise<RawItem> {
      return this.fetchItemWithin(localItemId, {});
    },

    async fetchItemWithin(localItemId, fetchOptions): Promise<RawItem> {
      const identity: SourceItemIdentity = {
        ...identityFor('/'),
        providerItemId: localItemId.slice(localItemId.indexOf(':') + 1),
        providerFileId: localItemId.slice(localItemId.indexOf(':') + 1),
        localItemId,
      };
      const refused = (metadata: Record<string, unknown>): RawItem => ({
        identity,
        mimeType: 'application/octet-stream',
        content: { kind: 'metadata_only' },
        metadata: Object.freeze(metadata),
        fetchedAt: now().toISOString(),
      });
      const locator = options.locate?.(localItemId);
      if (!locator) throw new FileExtractionSourceError('source_unavailable');
      const scopePath = normalizeScopePath(locator);
      const decide = options.scope.snapshotDecider();
      if (decide(scopePath) !== 'content') return refused({ scopeContentDenied: true });
      // The deepest approved folder that holds the file is the one it is read through.
      const holder = options.scope.roots()
        .filter((entry) => pathIsAtOrBelow(scopePath, entry.scopePath))
        .sort((a, b) => b.scopePath.length - a.scopePath.length)[0];
      if (!holder) return refused({ scopeContentDenied: true });
      const rootReal = realPathOfScopePath(options.volumes, holder.scopePath);
      if (!rootReal) throw new FileExtractionSourceError('source_unavailable');
      let scopeRoot: ScopeRoot;
      try {
        scopeRoot = ScopeRoot.open(realpathSync.native(rootReal));
      } catch {
        throw new FileExtractionSourceError('source_unavailable');
      }
      const rel = scopePath === holder.scopePath ? '' : scopePath.slice(holder.scopePath === '/' ? 1 : holder.scopePath.length + 1);
      try {
        const expected = parseVersion(fetchOptions.expectedVersion);
        const readOptions = {
          ...(expected ? { expected } : {}),
          maxBytes: Math.min(fetchOptions.maxBytes ?? maxFetchBytes, maxFetchBytes),
        };
        let bytes: Uint8Array;
        try {
          bytes = scopeRoot.readFile(rel, readOptions);
        } catch (error) {
          // Stored paths are composed (NFC); a file system that keeps the
          // spelling it was given (Linux) may hold the decomposed one.
          if (!(error instanceof ScopeSafeError) || error.code !== 'not_found' || !/[^\u0000-\u007f]/.test(rel)) throw error;
          const actual = nameAsOnDisk(scopeRoot, rel);
          if (actual === undefined || actual === rel) throw error;
          bytes = scopeRoot.readFile(actual, readOptions);
        }
        const mimeType = fileMimeTypeFromName(scopePath.slice(scopePath.lastIndexOf('/') + 1));
        return {
          identity,
          mimeType,
          content: { kind: 'bytes', mimeType, bytes },
          metadata: Object.freeze({ sizeBytes: bytes.byteLength, maxFetchBytes }),
          fetchedAt: now().toISOString(),
        };
      } catch (error) {
        if (!(error instanceof ScopeSafeError)) throw new FileExtractionSourceError('source_unavailable');
        switch (error.code) {
          case 'too_large': return refused({ contentTooLarge: true, maxFetchBytes });
          case 'not_regular': return refused({ contentUnavailable: true });
          case 'permission': throw new FileExtractionSourceError('source_permission_denied');
          default: throw new FileExtractionSourceError('source_unavailable');
        }
      } finally {
        scopeRoot.close();
      }
    },

    classificationSignals(item: RawItem): SourceClassificationSignals {
      // File facts only: the name and where it lives. No prior, no sharing
      // state; the shared classifier judges each file on its own.
      return compactClassificationSignals({
        title: signalText(item.metadata, 'name'),
        path: signalText(item.metadata, 'pathDisplay'),
        folderKeys: signalTexts(item.metadata, 'folderKeys'),
      });
    },
  };
}

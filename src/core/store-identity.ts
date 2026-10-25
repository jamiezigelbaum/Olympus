/**
 * A store's identity for the media cache (docs/design/source-storage.md,
 * "Shared files"): which account's store it is and what the store is called
 * inside the account, never where its file sits. A store the registry places
 * is `(source id, slot, store name)`, the name being a tier (`secure_local`)
 * or `<family>.<tier>` for imported archives. Moving the file (the migration
 * into account folders is a rename) changes none of it, so a picture hold
 * keyed by the identity needs no rewrite when the store moves.
 *
 * The media cache decides whether a holder is gone from the identity: the
 * registry says whether the account exists (and which incarnation of it this
 * is), and the layout resolvers say where the store would be in either layout.
 * Everything here fails toward keeping a picture: a registry that cannot be
 * read or is not there, a path that cannot be looked at, and a store that
 * might be on a volume not mounted now all say "not gone".
 *
 * Stores the registry does not place (Reflect and Roam mounts, operator
 * mounts, a `--db` of a script, a store at a path of a test's own, in-memory
 * stores) have no identity; they stay held by their path, as before.
 *
 * Deliberately light, like the registry: no SQLite and no workers.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { archiveImportFamilies } from './archive-formats.ts';
import {
  ACCOUNT_FOLDERS_DIR,
  FOLDER_LAYOUT_SOURCES,
  accountFoldersRoot,
  accountStoreNames,
  accountStorePath,
  olympusDataRoot,
  type LayoutAccountLayout,
  type LayoutEnv,
} from './olympus-layout.ts';
import {
  DEFAULT_ACCOUNT_SLOT,
  findRegistryAccount,
  readSourceRegistry,
  sourceRegistryPath,
  type SourceRegistry,
} from './source-registry.ts';

/** One store of one account. The file is wherever the account's layout puts it. */
export interface StoreIdentity {
  sourceId: string;
  slot: string;
  /** A tier (`secure_local`), or `<family>.<tier>` for imported archives. */
  store: string;
  /**
   * Which account this was: the registry entry's `created_at`, which a
   * re-created account does not share with the one it replaced. A hold taken
   * for an earlier incarnation is not the new account's. Absent on a hold
   * written before the field existed, and on a holder built for a release,
   * which is judged by name alone.
   */
  incarnation?: string;
}

/**
 * A store as the media cache holds pictures for it: its identity, plus where
 * the file was when the hold was taken (a hint for a process that resolves the
 * layout differently), the other places the layouts give it (where an earlier
 * build may have left a path marker for it), and the registry the identity was
 * read from. None of those is the identity.
 */
export interface StoreHolder {
  identity: StoreIdentity;
  path: string;
  others: readonly string[];
  registry: string;
}

const LAYOUTS: readonly LayoutAccountLayout[] = ['folder', 'legacy'];

/**
 * Where the account's store would be in a layout, or undefined where that
 * layout has no such store. The legacy layout is one account per source: its
 * paths do not depend on the slot, so they belong to the first slot alone and
 * no other account may treat them as its own.
 */
function layoutPath(identity: StoreIdentity, layout: LayoutAccountLayout, env: LayoutEnv): string | undefined {
  if (layout === 'legacy' && identity.slot !== DEFAULT_ACCOUNT_SLOT) return undefined;
  try {
    return accountStorePath({ source_id: identity.sourceId, slot: identity.slot, layout }, identity.store, env);
  } catch {
    return undefined;
  }
}

/** The file a path names, by its real folder when it is not there yet: how an earlier build's path marker named a store. */
export function storePathKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Not there (yet, or any more): its folder is the best evidence.
  }
  const folder = dirname(path);
  let real = resolve(folder);
  try {
    real = realpathSync(folder);
  } catch {
    // Keep the spelled folder.
  }
  return join(real, basename(path));
}

/**
 * The registry a hold names, spelled one way however the data folder was
 * reached (a link, another case on a volume that ignores case): a hold taken
 * through one spelling is released, and judged by the sweep, through any other.
 */
export function registryKey(env: LayoutEnv = process.env): string {
  const path = sourceRegistryPath(env);
  let folder = resolve(dirname(path));
  try {
    folder = realpathSync.native(folder);
  } catch {
    // A data folder that is not there yet: its spelling is all there is.
  }
  return join(folder, basename(path));
}

/** The identity of the store at this path, with the paths the layouts give it. */
function matchStore(
  sourceId: string,
  slot: string,
  dbPath: string,
  names: readonly string[],
  env: LayoutEnv,
): { identity: StoreIdentity; others: string[] } | undefined {
  const wanted = storePathKey(dbPath);
  for (const store of names) {
    const identity = { sourceId, slot, store };
    const paths = LAYOUTS.flatMap((layout) => layoutPath(identity, layout, env) ?? []);
    if (paths.some((path) => storePathKey(path) === wanted)) {
      return { identity, others: paths.filter((path) => storePathKey(path) !== wanted) };
    }
  }
  return undefined;
}

/**
 * The holder of a store opened through the storage service, when the registry
 * places it: an active entry for the account, and the store opened at the
 * path the account's layout gives it (in either layout, so a store caught
 * between a rename and the registry's `layout` still counts). Any other store
 * has none. A registry that cannot be read places nothing. `registry` is the
 * one the caller has just read.
 */
export function placedStoreHolder(
  account: { sourceId: string; slot?: string },
  store: { dbPath: string; family: string; trustDomain: string },
  env: LayoutEnv = process.env,
  registry?: SourceRegistry,
): StoreHolder | undefined {
  if (store.dbPath === ':memory:' || !FOLDER_LAYOUT_SOURCES.includes(account.sourceId)) return undefined;
  const slot = account.slot ?? DEFAULT_ACCOUNT_SLOT;
  try {
    const entry = findRegistryAccount(registry ?? readSourceRegistry(env), account.sourceId, slot);
    if (entry?.state !== 'active') return undefined;
    const names = [store.trustDomain, `${store.family}.${store.trustDomain}`];
    const matched = matchStore(account.sourceId, slot, store.dbPath, names, env);
    return matched && {
      ...matched,
      identity: { ...matched.identity, incarnation: entry.created_at },
      path: store.dbPath,
      registry: registryKey(env),
    };
  } catch {
    return undefined;
  }
}

/**
 * The holder of the store at this path for a source's account, whatever the
 * registry says about the account now: for the delete that releases an
 * account's pictures after its state has changed.
 */
export function storeHolderAtPath(sourceId: string, dbPath: string, env: LayoutEnv = process.env): StoreHolder | undefined {
  if (dbPath === ':memory:' || !FOLDER_LAYOUT_SOURCES.includes(sourceId)) return undefined;
  try {
    const matched = matchStore(sourceId, DEFAULT_ACCOUNT_SLOT, dbPath, accountStoreNames(sourceId, archiveImportFamilies()), env);
    return matched && { ...matched, path: dbPath, registry: registryKey(env) };
  } catch {
    return undefined;
  }
}

/**
 * What the media cache's sweep asks about holders, reading the registry once.
 * Both answers lean toward keeping.
 */
export interface StorePlacementView {
  /** The registry file this view reads; a hold written for another one is not judged. */
  readonly registry: string | undefined;
  /** Whether the store a hold names is gone, given the paths its holder last saw it at. */
  storeGone(identity: StoreIdentity, seen: readonly string[]): boolean;
  /**
   * What to do with a path marker (the way an earlier build held pictures: by
   * the file's path, which is no longer there). A path the registry places, or
   * that sits in an account folder, is judged as its identity is: `gone` or
   * `kept`, so a store renamed into its account folder is not mistaken for a
   * deleted one before it has held its pictures again, and a folder that went
   * with a deleted account does not leave its markers behind. A registry that cannot
   * be read, or is not there while the path is one it would place, says
   * `kept`. Any other path is `unplaced`: the caller decides, as it always did.
   */
  pathMarker(path: string): 'gone' | 'kept' | 'unplaced';
}

/** What reading the registry came to: a registry, no file at all (no account recorded yet), or a file that cannot be read. */
type RegistryRead =
  | { kind: 'read'; registry: SourceRegistry }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

export function storePlacementView(env: LayoutEnv = process.env): StorePlacementView {
  let registryPath: string | undefined;
  let registryName: string | undefined;
  let root: string | undefined;
  try {
    registryPath = sourceRegistryPath(env);
    registryName = registryKey(env);
    root = olympusDataRoot(env);
  } catch {
    // A data folder that cannot be worked out: nothing can be told gone.
  }
  let loaded: RegistryRead | undefined;
  const registry = (): RegistryRead => {
    if (loaded) return loaded;
    if (registryPath === undefined) return (loaded = { kind: 'unreadable' });
    try {
      const read = readSourceRegistry(env);
      // An absent file reads as an empty registry; it is not one that was read and lists nobody.
      loaded = existsSync(registryPath) ? { kind: 'read', registry: read } : { kind: 'missing' };
    } catch {
      loaded = { kind: 'unreadable' };
    }
    return loaded;
  };

  /**
   * Not there, in a folder that is: a folder that is not there may be a volume
   * not mounted now, even inside the data folder, so it says nothing. A store
   * whose whole account folder went (a delete that stopped before releasing its
   * pictures) is released by its account's state, not by its path.
   */
  const absentForSure = (path: string): boolean => isMissing(path) && !isMissing(dirname(path));

  // One sweep asks about the same store for every picture it holds.
  const verdicts = new Map<string, boolean>();
  const storeGone = (identity: StoreIdentity, seen: readonly string[]): boolean => {
    const key = JSON.stringify([identity.sourceId, identity.slot, identity.store, identity.incarnation, ...seen]);
    const known = verdicts.get(key);
    if (known !== undefined) return known;
    const gone = judgeStoreGone(identity, seen);
    verdicts.set(key, gone);
    return gone;
  };
  const judgeStoreGone = (identity: StoreIdentity, seen: readonly string[]): boolean => {
    const state = registry();
    // A registry that is not there, or cannot be read, says nothing.
    if (state.kind !== 'read') return false;
    const entry = findRegistryAccount(state.registry, identity.sourceId, identity.slot);
    // A registry that was read and does not list the account says it is gone.
    if (!entry) return true;
    // A hold of an account this one replaced is not this one's, whatever sits at the same path.
    if (identity.incarnation !== undefined && isEarlier(identity.incarnation, entry.created_at)) return true;
    if (entry.state === 'deleted') return true;
    // The delete in progress releases the pictures itself.
    if (entry.state === 'deleting') return false;
    const own = layoutPath(identity, entry.layout, env);
    if (own === undefined) return false;
    // The other layout's place only has to be empty: a store caught between a
    // rename and the registry's `layout` is there, and nothing more is asked of it.
    const other = layoutPath(identity, entry.layout === 'folder' ? 'legacy' : 'folder', env);
    return [own, ...seen].every(absentForSure) && (other === undefined || isMissing(other));
  };

  /** The account folders, as spelled and as the real path of the data folder would spell them. */
  const folderRoots = (): string[] => {
    const roots = new Set<string>();
    try {
      roots.add(resolve(accountFoldersRoot(env)));
      if (root !== undefined) roots.add(join(realpathSync(root), ACCOUNT_FOLDERS_DIR));
    } catch {
      // Keep what could be worked out.
    }
    return [...roots];
  };

  /** The account and store a path in an account folder (`<data>/sources/<id>/<slot>/stores/<name>.sqlite`) names. */
  const folderPlace = (path: string): StoreIdentity | undefined => {
    for (const folders of folderRoots()) {
      const inside = relative(folders, path);
      if (inside.startsWith('..') || isAbsolute(inside)) continue;
      const [sourceId, slot, stores, file, ...rest] = inside.split(sep);
      if (!sourceId || !slot || stores !== 'stores' || !file?.endsWith('.sqlite') || rest.length > 0) continue;
      return { sourceId, slot, store: file.slice(0, -'.sqlite'.length) };
    }
    return undefined;
  };

  /** Where the legacy layout puts the first slot's stores: paths that are an account's whether or not the registry is there. */
  let legacyPlaces: Set<string> | undefined;
  const legacyPlaced = (key: string): boolean => {
    if (!legacyPlaces) {
      legacyPlaces = new Set();
      const families = archiveImportFamilies();
      for (const sourceId of FOLDER_LAYOUT_SOURCES) {
        for (const store of accountStoreNames(sourceId, families)) {
          const path = layoutPath({ sourceId, slot: DEFAULT_ACCOUNT_SLOT, store }, 'legacy', env);
          if (path !== undefined) legacyPlaces.add(storePathKey(path));
        }
      }
    }
    return legacyPlaces.has(key);
  };

  let placed: Map<string, StoreIdentity> | undefined;
  const placedAt = (known: SourceRegistry): Map<string, StoreIdentity> => {
    if (placed) return placed;
    placed = new Map();
    const families = archiveImportFamilies();
    for (const account of known.accounts) {
      if (!FOLDER_LAYOUT_SOURCES.includes(account.source_id)) continue;
      for (const store of accountStoreNames(account.source_id, families)) {
        const identity = { sourceId: account.source_id, slot: account.slot, store };
        for (const layout of LAYOUTS) {
          const path = layoutPath(identity, layout, env);
          if (path !== undefined && !placed.has(storePathKey(path))) placed.set(storePathKey(path), identity);
        }
      }
    }
    return placed;
  };

  const pathVerdicts = new Map<string, 'gone' | 'kept' | 'unplaced'>();
  const judgePathMarker = (path: string): 'gone' | 'kept' | 'unplaced' => {
    const state = registry();
    // A registry nobody can read may say this path is a store that moved.
    if (state.kind === 'unreadable') return 'kept';
    try {
      const key = storePathKey(path);
      const inFolder = folderPlace(key) ?? folderPlace(resolve(path));
      if (state.kind === 'missing') return inFolder !== undefined || legacyPlaced(key) ? 'kept' : 'unplaced';
      const identity = placedAt(state.registry).get(key);
      if (identity) return storeGone(identity, [path]) ? 'gone' : 'kept';
      if (!inFolder) return 'unplaced';
      // In an account folder the registry no longer lists (or lists under another layout): judged as the account's store.
      return storeGone(inFolder, [path]) ? 'gone' : 'kept';
    } catch {
      return 'kept';
    }
  };

  return {
    registry: registryName,
    storeGone,
    pathMarker(path) {
      let verdict = pathVerdicts.get(path);
      if (!verdict) {
        verdict = judgePathMarker(path);
        pathVerdicts.set(path, verdict);
      }
      return verdict;
    },
  };
}

/** Whether `held` names an earlier moment than `current`; two stamps that cannot be compared are not earlier. */
function isEarlier(held: string, current: string): boolean {
  const before = Date.parse(held);
  const after = Date.parse(current);
  return Number.isFinite(before) && Number.isFinite(after) && before < after;
}

/** Whether a path is certainly not there: a dangling link counts, a folder the process may not search does not. */
function isMissing(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

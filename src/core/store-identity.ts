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
 * registry says whether the account exists, and the layout resolvers say where
 * the store would be in either layout. Everything here fails toward keeping a
 * picture: a registry that cannot be read, a path that cannot be looked at,
 * and a store that might be on a volume not mounted now all say "not gone".
 *
 * Stores the registry does not place (Reflect and Roam mounts, operator
 * mounts, a `--db` of a script, a store at a path of a test's own, in-memory
 * stores) have no identity; they stay held by their path, as before.
 *
 * Deliberately light, like the registry: no SQLite and no workers.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { archiveImportFamilies } from './archive-formats.ts';
import {
  FOLDER_LAYOUT_SOURCES,
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

/** Where the account's store would be in a layout, or undefined where that layout has no such store. */
function layoutPath(identity: StoreIdentity, layout: LayoutAccountLayout, env: LayoutEnv): string | undefined {
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
    return matched && { ...matched, path: store.dbPath, registry: sourceRegistryPath(env) };
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
    return matched && { ...matched, path: dbPath, registry: sourceRegistryPath(env) };
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
   * Whether the store a path marker names (the way an earlier build held
   * pictures: by the file's path, which is no longer there) is gone. A path the
   * registry places is judged as its identity is, so a store renamed into its
   * account folder is not mistaken for a deleted one before it has held its
   * pictures again; any other path is gone, as it always was.
   */
  pathMarkerGone(path: string): boolean;
}

export function storePlacementView(env: LayoutEnv = process.env): StorePlacementView {
  let registryPath: string | undefined;
  let root: string | undefined;
  try {
    registryPath = sourceRegistryPath(env);
    root = olympusDataRoot(env);
  } catch {
    // A data folder that cannot be worked out: nothing can be told gone.
  }
  let loaded: { registry: SourceRegistry | undefined } | undefined;
  const registry = (): SourceRegistry | undefined => {
    if (!loaded) {
      try {
        loaded = { registry: readSourceRegistry(env) };
      } catch {
        loaded = { registry: undefined };
      }
    }
    return loaded.registry;
  };

  /** Not there, and in a place where "not there" is believable: its folder is, or it sat in the data folder, which is. */
  const absentForSure = (path: string): boolean => {
    if (!isMissing(path)) return false;
    if (!isMissing(dirname(path))) return true;
    return root !== undefined && isInside(path, root) && existsSync(root);
  };

  const storeGone = (identity: StoreIdentity, seen: readonly string[]): boolean => {
    const known = registry();
    if (!known || registryPath === undefined) return false;
    const entry = findRegistryAccount(known, identity.sourceId, identity.slot);
    // A registry that does not exist says nothing; one that does, and does not list the account, says it is gone.
    if (!entry) return existsSync(registryPath);
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

  return {
    registry: registryPath,
    storeGone,
    pathMarkerGone(path) {
      const known = registry();
      // A registry nobody can read may say this path is a store that moved.
      if (!known) return false;
      let identity: StoreIdentity | undefined;
      try {
        identity = placedAt(known).get(storePathKey(path));
      } catch {
        return false;
      }
      return identity === undefined || storeGone(identity, [path]);
    },
  };
}

function isInside(path: string, folder: string): boolean {
  return resolve(path).startsWith(`${resolve(folder)}${sep}`);
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

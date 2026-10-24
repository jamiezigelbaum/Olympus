/**
 * Scope paths for files on this computer.
 *
 * A scope path is what a folder selection is called, what an indexed file's
 * locator is, and what the store compares them by: an absolute path, normalized
 * (composed Unicode, single slashes, no trailing slash). A file on a volume
 * other than the computer's own carries the volume's identity as its first
 * segment, `/@<volume id>/<path inside the volume>`, so a different disk that
 * is later mounted at the same place (`/Volumes/Backup`) has different keys and
 * starts with nothing selected, and the same disk mounted elsewhere keeps its
 * selection.
 *
 * Folders that are off by default are decided here too, from the path alone.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { olympusOwnRoots } from '../../core/olympus-layout.ts';

export const VOLUME_SEGMENT_PREFIX = '@';
const MAX_SCOPE_PATH_LENGTH = 4_096;
const UNSAFE_PATH_CHARACTERS = new RegExp('[\\x00-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029) + ']');
const VOLUME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,80}$/;


export interface SplitScopePath {
  /** Absent for the computer's own (primary) volume. */
  volumeId?: string;
  /** The absolute path inside its volume (for the primary volume: the real path). */
  path: string;
}

/** Normalizes a path or scope key; throws on anything that is not an absolute path. */
export function normalizeScopePath(value: string): string {
  const composed = value.trim().normalize('NFC');
  if (
    !composed.startsWith('/')
    || composed.length > MAX_SCOPE_PATH_LENGTH
    || UNSAFE_PATH_CHARACTERS.test(composed)
  ) throw new Error('A folder key must be an absolute path.');
  const parts: string[] = [];
  for (const part of composed.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new Error('A folder key must not contain "..".');
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function scopePathFor(path: string, volumeId?: string): string {
  const normalized = normalizeScopePath(path);
  if (!volumeId) return normalized;
  if (!VOLUME_ID_PATTERN.test(volumeId)) throw new Error('Volume identity is invalid.');
  return normalized === '/' ? `/${VOLUME_SEGMENT_PREFIX}${volumeId}` : `/${VOLUME_SEGMENT_PREFIX}${volumeId}${normalized}`;
}

export function splitScopePath(scopePath: string): SplitScopePath {
  const normalized = normalizeScopePath(scopePath);
  const parts = normalized.split('/').filter(Boolean);
  const first = parts[0];
  if (first?.startsWith(VOLUME_SEGMENT_PREFIX)) {
    const volumeId = first.slice(1);
    if (!VOLUME_ID_PATTERN.test(volumeId)) throw new Error('Volume identity is invalid.');
    return { volumeId, path: `/${parts.slice(1).join('/')}` };
  }
  return { path: normalized };
}

/** True when `path` is `root` or lies under it. */
export function isWithinScopePath(path: string, root: string): boolean {
  if (root === '/') return true;
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Whether the volume holding `scopePath` ignores case. The one decision every
 * path comparison makes (the person's saved selections, the folders that are
 * off by default, watcher replay, and telling that an indexed item is gone).
 *
 * It follows the volume itself where the context can say (a disk formatted
 * case-sensitive on a Mac, a case-insensitive USB stick on Linux), and the
 * platform's usual format otherwise: macOS volumes ignore case by default,
 * Linux ones do not.
 */
export function scopePathsIgnoreCase(
  context: Pick<DefaultExclusionContext, 'platform' | 'volumeIgnoresCase'>,
  scopePath?: string,
): boolean {
  if (context.volumeIgnoresCase) {
    let volumeId: string | undefined;
    let inside: string | undefined;
    let known = true;
    if (scopePath !== undefined) {
      try { ({ volumeId, path: inside } = splitScopePath(scopePath)); } catch { known = false; }
    }
    if (known) {
      // The path lets the resolver pick the mount that actually holds it: the
      // computer's own volumes (root, home, Data) share one prefix-free form.
      const decided = context.volumeIgnoresCase(volumeId, inside);
      if (decided !== undefined) return decided;
    }
  }
  return (context.platform ?? process.platform) === 'darwin';
}

/** `value` as compared on its volume: lower-cased where case is ignored. */
export function foldScopePath(value: string, context: Pick<DefaultExclusionContext, 'platform' | 'volumeIgnoresCase'>): string {
  return scopePathsIgnoreCase(context, value) ? value.toLowerCase() : value;
}

/** True when `path` is `root` or lies under it, compared the way their volume compares names. */
export function scopePathIsWithin(
  path: string,
  root: string,
  context: Pick<DefaultExclusionContext, 'platform' | 'volumeIgnoresCase'>,
): boolean {
  return isWithinScopePath(foldScopePath(path, context), foldScopePath(root, context));
}

export function scopePathDepth(path: string): number {
  return path === '/' ? 0 : path.split('/').length - 1;
}

export function scopeParentPath(path: string): string | undefined {
  if (path === '/') return undefined;
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

// ---------------------------------------------------------------------------
// Folders that are off by default
// ---------------------------------------------------------------------------

export type DefaultExclusionReason =
  | 'system_library'
  | 'trash'
  | 'cache'
  | 'version_control'
  | 'dependencies'
  | 'build_output'
  | 'app_bundle'
  | 'olympus_data'
  | 'synced_by_another_source';

/** What the dashboard says about a folder that is off by default. */
export const DEFAULT_EXCLUSION_LABELS: Readonly<Record<DefaultExclusionReason, string>> = Object.freeze({
  system_library: 'Application data',
  trash: 'Trash',
  cache: 'Caches',
  version_control: 'Version control',
  dependencies: 'Installed dependencies',
  build_output: 'Build output',
  app_bundle: 'Application',
  olympus_data: 'Olympus\'s own data',
  synced_by_another_source: 'Already indexed through its own source',
});

const CACHE_SEGMENTS = new Set(['caches', '.cache', '.npm', '.bun', '.yarn', '.pnpm-store', '.gradle', '.m2']);
const TRASH_SEGMENTS = new Set(['.trash', '.trashes', '.trash-1000']);
const VCS_SEGMENTS = new Set(['.git', '.hg', '.svn']);
const DEPENDENCY_SEGMENTS = new Set(['node_modules', '.venv', 'venv', 'bower_components', 'pods']);
const BUILD_SEGMENTS = new Set([
  'dist', 'build', 'target', '.next', '.nuxt', '.svelte-kit', '__pycache__', 'deriveddata', '.build', '.tox',
]);
const SYNCED_FOLDER_NAMES = new Set(['dropbox', 'google drive']);

export interface DefaultExclusionContext {
  /** The home folder of the computer's owner (a primary-volume real path). */
  home: string;
  /** Real roots of the local Dropbox folder, when the operator configured them. */
  syncedRoots?: readonly string[];
  /**
   * The folders Olympus itself writes to (core/olympus-layout.ts
   * `olympusOwnRoots`), each as it is spelled and as the file system resolves
   * it. They are never indexed, and no choice of the person turns them on.
   */
  ownRoots?: readonly string[];
  platform?: NodeJS.Platform;
  /**
   * Whether the volume with this id (undefined: the computer's own) ignores
   * case, when that is known. Undefined for "unknown": the platform's usual
   * format is used.
   */
  volumeIgnoresCase?: (volumeId: string | undefined, path?: string) => boolean | undefined;
}

export function defaultExclusionContext(
  env: Record<string, string | undefined> = process.env,
): DefaultExclusionContext {
  // The home folder as the file system names it: walked paths are real paths,
  // so a home reached through a link (/home -> /var/home) must be compared as
  // its real self or none of the folders that are off by default would match.
  let home = env.HOME?.trim() || homedir();
  try { home = realpathSync.native(home); } catch { /* keep the configured path */ }
  return { home, syncedRoots: configuredSyncedRoots(env), ownRoots: resolvedOwnRoots(env, home), platform: process.platform };
}

/**
 * Olympus's own folders as the walk will see them: walked paths are real
 * paths, so a root reached through a link (a data folder moved to another disk
 * and linked back) is listed under both spellings. A folder that does not
 * exist yet is resolved through the part of its path that does. The home
 * folder, or a folder above it, is never one of them, whatever an override
 * says: that would turn off the person's own files.
 */
function resolvedOwnRoots(env: Record<string, string | undefined>, home: string): string[] {
  const roots = new Set<string>();
  for (const root of olympusOwnRoots(env)) {
    for (const spelling of [root, realPathThroughExisting(root)]) {
      let key: string;
      try { key = normalizeScopePath(spelling); } catch { continue; }
      if (!isWithinScopePath(home, key)) roots.add(key);
    }
  }
  return [...roots];
}

/** The real path of `path`, or, when it is not there yet, of its nearest existing parent with the rest appended. */
function realPathThroughExisting(path: string): string {
  const rest: string[] = [];
  let existing = path;
  for (;;) {
    try { return join(realpathSync.native(existing), ...[...rest].reverse()); } catch { /* not there: try its parent */ }
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.push(basename(existing));
    existing = parent;
  }
}

function configuredSyncedRoots(env: Record<string, string | undefined>): string[] {
  const raw = env.OLYMPUS_SOURCE_INDEX_DROPBOX_LOCAL_ROOTS_JSON;
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const root = (entry as { rootPath?: unknown; root_path?: unknown } | null);
      const value = typeof root?.rootPath === 'string' ? root.rootPath
        : typeof root?.root_path === 'string' ? root.root_path : undefined;
      try { return value ? [normalizeScopePath(value)] : []; } catch { return []; }
    });
  } catch {
    return [];
  }
}

// The own roots by lower-cased spelling, built once per list. The exact
// comparison, which depends on how the folder's volume treats case, is made
// only on a root whose lower-cased spelling matches.
const ownRootIndexes = new WeakMap<readonly string[], Map<string, string[]>>();

function ownRootsNamed(path: string, context: Pick<DefaultExclusionContext, 'ownRoots'>): readonly string[] {
  const roots = context.ownRoots;
  if (!roots || roots.length === 0) return [];
  let index = ownRootIndexes.get(roots);
  if (!index) {
    index = new Map();
    for (const root of roots) {
      const key = root.toLowerCase();
      index.set(key, [...(index.get(key) ?? []), root]);
    }
    ownRootIndexes.set(roots, index);
  }
  return index.get(path.toLowerCase()) ?? [];
}

/** Whether `scopePath` is one of Olympus's own folders (not one inside it). */
export function isOwnRoot(
  scopePath: string,
  context: Pick<DefaultExclusionContext, 'ownRoots' | 'platform' | 'volumeIgnoresCase'>,
): boolean {
  const named = ownRootsNamed(scopePath, context);
  return named.length > 0 && named.some((root) => foldScopePath(root, context) === foldScopePath(scopePath, context));
}

/** Whether `scopePath` is one of Olympus's own folders, or lies inside one. */
export function isInsideOwnRoot(
  scopePath: string,
  context: Pick<DefaultExclusionContext, 'ownRoots' | 'platform' | 'volumeIgnoresCase'>,
): boolean {
  if (!context.ownRoots || context.ownRoots.length === 0) return false;
  const { volumeId, path } = splitScopePath(scopePath);
  // Each folder on the way down, the path itself last. A pass asks this of every
  // file, so the prefixes are cut from the normalized path rather than rebuilt.
  for (let cut = path.indexOf('/', 1); ; cut = path.indexOf('/', cut + 1)) {
    const prefix = cut === -1 ? path : path.slice(0, cut);
    if (isOwnRoot(volumeId ? scopePathFor(prefix, volumeId) : prefix, context)) return true;
    if (cut === -1) return false;
  }
}

/**
 * Why `scopePath` (a path of the primary volume, or a volume-prefixed one) is
 * off by default, judged on this one folder name alone; undefined when it is
 * not. `isDefaultExcludedFolder` below looks at a whole path.
 */
export function defaultExclusionForFolder(
  scopePath: string,
  context: DefaultExclusionContext,
): DefaultExclusionReason | undefined {
  const { volumeId, path } = splitScopePath(scopePath);
  const name = path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1);
  const lower = name.toLowerCase();
  if (lower === '') return undefined;
  // Olympus's own folders, wherever its environment and install put them.
  if (isOwnRoot(scopePathFor(path, volumeId), context)) return 'olympus_data';
  if (TRASH_SEGMENTS.has(lower)) return 'trash';
  if (VCS_SEGMENTS.has(lower)) return 'version_control';
  if (DEPENDENCY_SEGMENTS.has(lower)) return 'dependencies';
  if (CACHE_SEGMENTS.has(lower)) return 'cache';
  if (lower.endsWith('.app')) return 'app_bundle';
  if (BUILD_SEGMENTS.has(lower)) return 'build_output';
  if (volumeId) return undefined;
  const platform = context.platform ?? process.platform;
  // macOS volumes ignore case: `~/library` is `~/Library`.
  const fold = (value: string): string => foldScopePath(value, context);
  const here = fold(path);
  const at = (suffix: string): string => fold(`${context.home}${suffix}`);
  if (platform === 'darwin' && here === at('/Library')) return 'system_library';
  if (platform !== 'darwin' && here === at('/.local/share/Trash')) return 'trash';
  if (here === at('/.cache')) return 'cache';
  // Olympus's own stores, as an install whose environment has changed left them:
  // reading them back would index the index.
  if (here === at('/.olympus') || here === at('/.openclaw') || here === at('/.local/share/openclaw')) return 'olympus_data';
  if (here === at('/Dropbox') || here.startsWith(at('/Dropbox ('))) return 'synced_by_another_source';
  const parentHere = scopeParentPath(path);
  if (SYNCED_FOLDER_NAMES.has(lower) && parentHere !== undefined && fold(parentHere) === at('')) return 'synced_by_another_source';
  if (platform === 'darwin' && parentHere !== undefined && fold(parentHere) === at('/Library/CloudStorage')) {
    return 'synced_by_another_source';
  }
  if ((context.syncedRoots ?? []).some((root) => fold(root) === here)) return 'synced_by_another_source';
  return undefined;
}

/**
 * The deepest ancestor-or-self folder of `scopePath` that is off by default,
 * with its reason. Undefined when none is.
 */
export function deepestDefaultExclusion(
  scopePath: string,
  context: DefaultExclusionContext,
): { path: string; reason: DefaultExclusionReason } | undefined {
  const { volumeId, path } = splitScopePath(scopePath);
  const parts = path.split('/').filter(Boolean);
  let found: { path: string; reason: DefaultExclusionReason } | undefined;
  for (let length = 1; length <= parts.length; length += 1) {
    const prefix = `/${parts.slice(0, length).join('/')}`;
    const key = scopePathFor(prefix, volumeId);
    const reason = defaultExclusionForFolder(key, context);
    if (reason) found = { path: key, reason };
  }
  return found;
}

/** The normalized keys of the primary volume are just paths; used by tests and the picker. */
export function isVolumeKey(volumeId: string): boolean {
  return VOLUME_ID_PATTERN.test(volumeId);
}

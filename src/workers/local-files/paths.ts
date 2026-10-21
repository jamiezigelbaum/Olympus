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
import { homedir } from 'node:os';

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
  platform?: NodeJS.Platform;
}

export function defaultExclusionContext(
  env: Record<string, string | undefined> = process.env,
): DefaultExclusionContext {
  return { home: homedir(), syncedRoots: configuredSyncedRoots(env), platform: process.platform };
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
  if (TRASH_SEGMENTS.has(lower)) return 'trash';
  if (VCS_SEGMENTS.has(lower)) return 'version_control';
  if (DEPENDENCY_SEGMENTS.has(lower)) return 'dependencies';
  if (CACHE_SEGMENTS.has(lower)) return 'cache';
  if (lower.endsWith('.app')) return 'app_bundle';
  if (BUILD_SEGMENTS.has(lower)) return 'build_output';
  if (volumeId) return undefined;
  const home = context.home;
  const platform = context.platform ?? process.platform;
  if (platform === 'darwin' && path === `${home}/Library`) return 'system_library';
  if (platform !== 'darwin' && path === `${home}/.local/share/Trash`) return 'trash';
  if (path === `${home}/.cache`) return 'cache';
  if (path === `${home}/Dropbox` || path.startsWith(`${home}/Dropbox (`)) return 'synced_by_another_source';
  if (SYNCED_FOLDER_NAMES.has(lower) && scopeParentPath(path) === home) return 'synced_by_another_source';
  if (platform === 'darwin' && scopeParentPath(path) === `${home}/Library/CloudStorage`) {
    return 'synced_by_another_source';
  }
  if ((context.syncedRoots ?? []).includes(path)) return 'synced_by_another_source';
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

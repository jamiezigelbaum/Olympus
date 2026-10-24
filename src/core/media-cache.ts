// The media cache: prepared copies of files whose content is searched as
// media, not only as text (docs/design/photo-embeddings.md). Today that is a
// photo reduced to a JPEG of at most 1,024 pixels on its long side, which the
// built-in model's image encoder reads when it embeds the photo's chunk.
//
// Content-addressed by the SHA-256 of the prepared bytes, owner-only (0700
// directory, 0600 files), under the Olympus data directory. Several stores may
// point a chunk at the same file (a tier move copies the chunk), so each holder
// of a file keeps a marker beside it, and the file is removed only when the
// last marker goes. An extraction holds a STAGING marker from the moment it
// writes the file until its result is stored (or refused), so a twin photo
// being deleted meanwhile cannot take the file away. A file nothing holds is
// swept after a day.
//
// A marker is named by a digest of its holder's name and carries the name
// itself, so the sweep can tell a store that is gone (its database file
// removed) from one that still holds the file. Markers from before names were
// recorded are empty: a store re-asserts its holds when it is opened, which
// labels them and drops any marker an earlier build named by a path that was
// not the store's real path. An empty marker is otherwise kept: the sweep
// cannot tell whose it is, so it never assumes it is stale.
//
// Every path this module reads, marks or deletes must be one it could have
// written: a file named `<sha256>.jpg` directly inside a directory named
// `media-cache` or `olympus-media`. The check is structural, not against the
// caller's own configured directory, so a drain or a CLI started with a
// different environment agrees with the worker that wrote the row. A path
// from a database row is checked before it is touched.

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { syncDirectorySync } from './atomic-file.ts';
import { olympusDataDir } from './remote-access.ts';
import { SIPS_PATH } from '../workers/file-extraction/extractors/image-preparers.ts';
import { readyStillImageFormats } from './still-image-readiness.ts';

export const MEDIA_CACHE_DIR_ENV = 'OLYMPUS_MEDIA_CACHE_DIR';
/** The tool still images are prepared with on a Mac; it ships with macOS only. */
export { SIPS_PATH };
/** A file nothing holds is removed once it is older than this. */
export const MEDIA_CACHE_ORPHAN_AGE_MS = 24 * 60 * 60_000;

/** A prepared media file and the digest it is stored under. */
export interface MediaCacheFile {
  path: string;
  sha256: string;
  mimeType: string;
  /** The extraction's own hold on the file; released once its result is stored or refused. */
  stagingHolder: string;
}

/**
 * Whether this machine can prepare at least one still-image format for media
 * search. A capability, not a source or an operating system: the tool that
 * prepares pictures is whichever one this machine has, and each format is
 * proven by preparing a real picture of it (`still-image-readiness.ts`).
 * Every lane that asks "can pictures be read here" gets the same answer from
 * the same per-format probe; a caller that cares which formats asks for them.
 */
export function stillImagePreparationAvailable(): boolean {
  return readyStillImageFormats().size > 0;
}

/**
 * `<olympus data dir>/media-cache`, or a dedicated `olympus-media`
 * subdirectory of `OLYMPUS_MEDIA_CACHE_DIR`: the owner-only permissions are
 * set on a directory Olympus owns, never on one the owner named.
 */
export function mediaCacheDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env[MEDIA_CACHE_DIR_ENV]?.trim();
  if (configured && !isAbsolute(configured)) throw new TypeError(`${MEDIA_CACHE_DIR_ENV} must be an absolute path.`);
  return configured ? join(configured, 'olympus-media') : join(olympusDataDir(env), 'media-cache');
}

const EXTENSIONS: Readonly<Record<string, string>> = { 'image/jpeg': '.jpg' };

function isSha256(value: string): boolean {
  if (value.length !== 64) return false;
  for (const character of value) {
    if (!'0123456789abcdef'.includes(character)) return false;
  }
  return true;
}

const MEDIA_CACHE_DIR_NAMES: ReadonlySet<string> = new Set(['media-cache', 'olympus-media']);

/**
 * Whether `path` is a cache file for `sha256`: absolute and normalized, named
 * `<sha256>.jpg`, directly inside a `media-cache` or `olympus-media`
 * directory, and (when it exists) a regular file, not a link. Rows can be
 * copied between stores, so a path is never trusted because a database holds
 * it. With `dir`, it must also sit in exactly that directory.
 */
export function isMediaCachePath(path: string, sha256: string, dir?: string): boolean {
  if (!isAbsolute(path) || !isSha256(sha256) || resolve(path) !== path) return false;
  if (basename(path) !== `${sha256}.jpg` || !MEDIA_CACHE_DIR_NAMES.has(basename(dirname(path)))) return false;
  if (dir !== undefined && dirname(path) !== resolve(dir)) return false;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return false;
  } catch {
    // Absent is fine: a caller checks existence itself.
  }
  return true;
}

/**
 * The name a holder (a store's database path) is recorded under: its real
 * path, so a store opened through a link or a relative path is the same
 * holder.
 */
export function mediaHolderName(holder: string): string {
  if (holder.startsWith('staging:') || holder.startsWith('memory:')) return holder;
  try {
    return realpathSync(holder);
  } catch {
    return resolve(holder);
  }
}

/**
 * A path's real path whether or not the file is there: the real path of the
 * nearest folder above it that exists, then the rest of the path. The same
 * before and after the folders it will sit in are made.
 */
export function nearRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Fall through: it is not there.
  }
  const rest: string[] = [];
  let near = resolve(path);
  for (;;) {
    rest.unshift(basename(near));
    const up = dirname(near);
    if (up === near) return resolve(path);
    near = up;
    try {
      return join(realpathSync(near), ...rest);
    } catch {
      // Keep climbing to a folder that is there.
    }
  }
}

/**
 * The name a store's marker carries when the store is not (or not yet) where
 * it will be. Same as `mediaHolderName` for a store that is there.
 */
function mediaHolderNameNear(holder: string): string {
  return holder.startsWith('staging:') || holder.startsWith('memory:') ? holder : nearRealPath(holder);
}

/**
 * The marker names (digests) the cache holds for a store: under its real path
 * and under its path as spelled, which is how the first build of picture search
 * named it. Taken before a store moves; `rekeyMediaCacheHolder` finds the
 * markers by them.
 */
export function mediaHolderDigests(holder: string): string[] {
  return [...new Set([holderDigest(mediaHolderNameNear(holder)), holderDigest(holder)])];
}

/** Thrown by `addMediaCacheHolder` when `stop` says to leave off; what was done stays done. */
export class MediaCacheRekeyStopped extends Error {
  constructor(readonly handed: number) {
    super('The media cache hand-over was stopped before it finished.');
    this.name = 'MediaCacheRekeyStopped';
  }
}

export interface MediaCacheRekeyOptions {
  /**
   * Asked every few pictures: true leaves off (`addMediaCacheHolder` throws
   * `MediaCacheRekeyStopped`; `dropMediaCacheHolder` simply returns). Both are
   * safe to cut short at that point, and a later call goes on.
   */
  stop?: () => boolean;
  /** Makes a path durable: a marker file, then its folder. Replaces the real `fsync`, for tests. */
  sync?: (path: string) => void;
}

/** How often the pictures of a big cache are interrupted by a question about time: every this many. */
const STOP_CHECK_EVERY = 64;

/** Makes a marker exist with `name` in it and be on disk: the file's bytes, then the folder entry that names it. */
function ensureMarkerDurable(marker: string, name: string, sync: ((path: string) => void) | undefined): void {
  // A marker with these bytes may be a stopped run's, not on disk yet: it is synced either way (cheap when it is).
  const present = readMarker(marker) === name;
  const descriptor = openSync(marker, present ? 'r' : 'w', 0o600);
  try {
    if (!present) writeSync(descriptor, name);
    if (sync) sync(marker);
    else fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (sync) sync(dirname(marker));
  else syncDirectorySync(dirname(marker));
}

/**
 * The first half of handing a store's pictures to a new path: for every cache
 * file one of `fromDigests` holds, a marker under the new path's name is written
 * and made durable (the file and its folder are fsynced), the old marker left
 * where it is. Nothing is without a holder at any point, whichever way the
 * machine stops, and it can be repeated or cut short (`options.stop`) at will,
 * so it is done BEFORE the store moves, while the old holder is still real.
 * Returns how many pictures it covered.
 */
export function addMediaCacheHolder(
  dir: string,
  fromDigests: readonly string[],
  toHolder: string,
  options: MediaCacheRekeyOptions = {},
): number {
  const entries = cacheRefsFolders(dir);
  const name = mediaHolderNameNear(toHolder);
  const target = holderDigest(name);
  let covered = 0;
  entries.forEach((entry, index) => {
    if (index % STOP_CHECK_EVERY === 0 && options.stop?.()) throw new MediaCacheRekeyStopped(covered);
    const refs = join(dir, entry);
    if (!fromDigests.some((digest) => digest !== target && existsSync(join(refs, digest)))) return;
    ensureMarkerDurable(join(refs, target), name, options.sync);
    covered += 1;
  });
  return covered;
}

/**
 * The second half, after the store has moved: the old markers of every picture
 * that now has the new path's marker are removed. Not durable on purpose: an
 * old marker that comes back after a crash names a store that is gone, and the
 * sweep removes it. Cut short by `options.stop` (the rest are swept later).
 * Returns how many markers it removed.
 */
export function dropMediaCacheHolder(
  dir: string,
  fromDigests: readonly string[],
  toHolder: string,
  options: Pick<MediaCacheRekeyOptions, 'stop'> = {},
): number {
  const entries = cacheRefsFolders(dir);
  const target = holderDigest(mediaHolderNameNear(toHolder));
  let handed = 0;
  for (const [index, entry] of entries.entries()) {
    if (index % STOP_CHECK_EVERY === 0 && options.stop?.()) break;
    const refs = join(dir, entry);
    if (!existsSync(join(refs, target))) continue;
    for (const digest of fromDigests) {
      if (digest === target || !existsSync(join(refs, digest))) continue;
      rmSync(join(refs, digest), { force: true });
      handed += 1;
    }
  }
  return handed;
}

/**
 * Hands the markers of a store that is moving to its new path, both halves one
 * after the other (the boot migration does them on either side of the move; see
 * docs/design/source-storage.md, "Migration of existing installs"). Without it
 * the sweep would read the old path as a store that is gone and drop its
 * pictures. Idempotent. Returns how many markers were handed over.
 */
export function rekeyMediaCacheHolder(
  dir: string,
  fromDigests: readonly string[],
  toHolder: string,
  options: MediaCacheRekeyOptions = {},
): number {
  addMediaCacheHolder(dir, fromDigests, toHolder, options);
  return dropMediaCacheHolder(dir, fromDigests, toHolder, options);
}

/** The `.refs` folders of a cache, or none when it is not there. */
function cacheRefsFolders(dir: string): string[] {
  try {
    return readdirSync(dir).filter((entry) => entry.endsWith('.jpg.refs'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Stores `bytes` under their digest and returns where, with a staging hold on
 * the file taken in the same step. Writing the same bytes twice reuses the
 * file; a partial write never takes the final name.
 */
export function writeMediaCacheFile(dir: string, bytes: Uint8Array, mimeType: string): MediaCacheFile {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const path = join(dir, `${sha256}${EXTENSIONS[mimeType] ?? '.bin'}`);
  ensureOwnerOnlyDir(dir);
  const stagingHolder = `staging:${randomUUID()}`;
  // The hold first: a release racing this write then finds a holder and
  // leaves the file alone.
  addMarker(path, stagingHolder);
  if (!existsSync(path)) {
    const temporary = join(dir, `.${sha256}.${randomUUID()}.tmp`);
    writeFileSync(temporary, bytes, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  }
  return { path, sha256, mimeType, stagingHolder };
}

/** Records that `holder` (one store) references the cache file for `sha256`. */
export function retainMediaCacheFile(path: string, sha256: string, holder: string, dir?: string): boolean {
  if (!isMediaCachePath(path, sha256, dir)) return false;
  try {
    addMarker(path, holder);
    return true;
  } catch {
    // Best effort: a missing marker only means the file may be kept longer.
    return false;
  }
}

/**
 * Drops `holder`'s reference to the cache file for `sha256`, and removes the
 * file when no holder references it any more. Returns whether it was removed.
 * A path outside the cache, or not named for its digest, is never touched.
 */
export function releaseMediaCacheFile(path: string, sha256: string, holder: string, dir?: string): boolean {
  if (!isMediaCachePath(path, sha256, dir)) return false;
  try {
    const refs = refsDir(path);
    rmSync(join(refs, holderName(holder)), { force: true });
    // The same holder's marker as an earlier build named it.
    const legacy = legacyHolderName(holder);
    if (legacy) rmSync(join(refs, legacy), { force: true });
    const remaining = existsSync(refs) ? readdirSync(refs) : [];
    if (remaining.length > 0) return false;
    if (existsSync(refs)) rmdirSync(refs);
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes what nothing holds: stale staging holds (an extraction that died
 * between writing a file and storing its result), markers of stores that are
 * gone, cache files with no holder older than `maxAgeMs`, and abandoned
 * partial writes. Returns how many files were removed. Best effort.
 */
export function sweepMediaCache(
  dir: string,
  options: { maxAgeMs?: number; now?: number } = {},
): number {
  const maxAgeMs = options.maxAgeMs ?? MEDIA_CACHE_ORPHAN_AGE_MS;
  const now = options.now ?? Date.now();
  const old = (path: string) => {
    try {
      return now - statSync(path).mtimeMs > maxAgeMs;
    } catch {
      return false;
    }
  };
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const path = join(dir, name);
    try {
      if (name.startsWith('.') && name.endsWith('.tmp')) {
        if (old(path)) rmSync(path, { force: true });
        continue;
      }
      if (!name.endsWith('.jpg') || !isSha256(name.slice(0, -4))) continue;
      const refs = refsDir(path);
      if (existsSync(refs)) {
        for (const marker of readdirSync(refs)) {
          const markerPath = join(refs, marker);
          if (marker.startsWith('staging-') ? old(markerPath) : holderGone(markerPath, marker)) {
            rmSync(markerPath, { force: true });
          }
        }
        if (readdirSync(refs).length > 0) continue;
        rmdirSync(refs);
      }
      if (old(path)) {
        rmSync(path, { force: true });
        removed += 1;
      }
    } catch {
      // Next file.
    }
  }
  return removed;
}

function addMarker(path: string, holder: string): void {
  const refs = refsDir(path);
  ensureOwnerOnlyDir(refs);
  const marker = join(refs, holderName(holder));
  const name = mediaHolderName(holder);
  if (readMarker(marker) !== name) writeFileSync(marker, name, { mode: 0o600 });
  // Holding under the current name replaces the same holder's marker as an
  // earlier build named it, which nothing would release.
  const legacy = legacyHolderName(holder);
  if (legacy) rmSync(join(refs, legacy), { force: true });
}

function readMarker(marker: string): string | undefined {
  try {
    return readFileSync(marker, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Whether the store a marker names is gone: the marker carries the store's
 * real path (and is named for it), no file is there, and the directory it
 * lived in is. A store that exists, by whatever link or relocated path it is
 * opened, keeps its marker; so does one whose directory is missing (a volume
 * not mounted now), an in-memory store, and an empty marker from before names
 * were recorded, whose holder cannot be told.
 */
function holderGone(marker: string, markerName: string): boolean {
  const name = readMarker(marker);
  if (!name || !isAbsolute(name) || holderDigest(name) !== markerName) return false;
  return !existsSync(name) && existsSync(dirname(name));
}

function refsDir(path: string): string {
  return join(dirname(path), `${basename(path)}.refs`);
}

function holderDigest(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 32);
}

function holderName(holder: string): string {
  const digest = holderDigest(mediaHolderName(holder));
  return holder.startsWith('staging:') ? `staging-${digest}` : digest;
}

/**
 * The marker name the first build of picture search gave a store: a digest of
 * its path as spelled, not its real path. Undefined where the two agree.
 */
function legacyHolderName(holder: string): string | undefined {
  if (holder.startsWith('staging:') || holder.startsWith('memory:')) return undefined;
  const legacy = holderDigest(holder);
  return legacy === holderName(holder) ? undefined : legacy;
}

function ensureOwnerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

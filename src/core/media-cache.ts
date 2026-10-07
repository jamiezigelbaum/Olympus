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
// Every path this module reads, marks or deletes must be one it could have
// written: inside the cache directory and named `<sha256>.jpg`. A path from a
// database row is checked before it is touched.

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { olympusDataDir } from './remote-access.ts';

export const MEDIA_CACHE_DIR_ENV = 'OLYMPUS_MEDIA_CACHE_DIR';
/** The tool still images are prepared with; it ships with macOS only. */
export const SIPS_PATH = '/usr/bin/sips';
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
 * Whether this machine can prepare still images for media search. Mac first:
 * the preparation tool ships with macOS. A capability, not a source: every
 * lane that reads pictures asks the same question.
 */
export function stillImagePreparationAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && existsSync(SIPS_PATH);
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

/**
 * Whether `path` is the cache file for `sha256`: inside `dir`, named
 * `<sha256>.jpg`, nothing else. Rows can be copied between stores, so a path
 * is never trusted because a database holds it.
 */
export function isMediaCachePath(path: string, sha256: string, dir: string = mediaCacheDir()): boolean {
  if (!isAbsolute(path) || !isSha256(sha256)) return false;
  return resolve(path) === join(resolve(dir), `${sha256}.jpg`);
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
 * between writing a file and storing its result), cache files with no holder
 * older than `maxAgeMs`, and abandoned partial writes. Returns how many files
 * were removed. Best effort.
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
          if (marker.startsWith('staging-') && old(join(refs, marker))) rmSync(join(refs, marker), { force: true });
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
  writeFileSync(join(refs, holderName(holder)), '', { mode: 0o600 });
}

function refsDir(path: string): string {
  return join(dirname(path), `${basename(path)}.refs`);
}

function holderName(holder: string): string {
  const digest = createHash('sha256').update(holder).digest('hex').slice(0, 32);
  return holder.startsWith('staging:') ? `staging-${digest}` : digest;
}

function ensureOwnerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

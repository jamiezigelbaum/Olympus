// The media cache: prepared copies of files whose content is searched as
// media, not only as text (docs/design/photo-embeddings.md). Today that is a
// photo reduced to a JPEG of at most 1,024 pixels on its long side, which the
// built-in model's image encoder reads when it embeds the photo's chunk.
//
// Content-addressed by the SHA-256 of the prepared bytes, owner-only (0700
// directory, 0600 files), under the Olympus data directory. Several stores may
// point a chunk at the same file (a tier move copies the chunk), so each store
// that references a file holds a marker beside it, and the file is removed
// only when the last marker goes.

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { olympusDataDir } from './remote-access.ts';

export const MEDIA_CACHE_DIR_ENV = 'OLYMPUS_MEDIA_CACHE_DIR';

/** A prepared media file and the digest it is stored under. */
export interface MediaCacheFile {
  path: string;
  sha256: string;
  mimeType: string;
}

/** `<olympus data dir>/media-cache`, or `OLYMPUS_MEDIA_CACHE_DIR`. */
export function mediaCacheDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env[MEDIA_CACHE_DIR_ENV]?.trim();
  const dir = configured || join(olympusDataDir(env), 'media-cache');
  if (!isAbsolute(dir)) throw new TypeError(`${MEDIA_CACHE_DIR_ENV} must be an absolute path.`);
  return dir;
}

const EXTENSIONS: Readonly<Record<string, string>> = { 'image/jpeg': '.jpg' };

/**
 * Stores `bytes` under their digest and returns where. Writing the same bytes
 * twice is a no-op; a partial write never takes the final name.
 */
export function writeMediaCacheFile(dir: string, bytes: Uint8Array, mimeType: string): MediaCacheFile {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const path = join(dir, `${sha256}${EXTENSIONS[mimeType] ?? '.bin'}`);
  ensureOwnerOnlyDir(dir);
  if (!existsSync(path)) {
    const temporary = join(dir, `.${sha256}.${randomUUID()}.tmp`);
    writeFileSync(temporary, bytes, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  }
  return { path, sha256, mimeType };
}

/** Records that `holder` (one store) references the file at `path`. */
export function retainMediaCacheFile(path: string, holder: string): void {
  try {
    const refs = refsDir(path);
    ensureOwnerOnlyDir(refs);
    writeFileSync(join(refs, holderName(holder)), '', { mode: 0o600 });
  } catch {
    // Best effort: a missing marker only means the file may be kept longer.
  }
}

/**
 * Drops `holder`'s reference to the file at `path`, and removes the file when
 * no holder references it any more. Returns whether the file was removed.
 */
export function releaseMediaCacheFile(path: string, holder: string): boolean {
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

function refsDir(path: string): string {
  return join(dirname(path), `${basename(path)}.refs`);
}

function holderName(holder: string): string {
  return createHash('sha256').update(holder).digest('hex').slice(0, 32);
}

function ensureOwnerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

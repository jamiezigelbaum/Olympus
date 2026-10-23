/**
 * The delete fence: a durable record of Delete indexed data that has started
 * and not finished.
 *
 * Once a delete has removed or changed anything, the stores it was removing are
 * half gone. Nothing may reopen them: a service that did would index into, or
 * read from, a partial store. The fence names those stores (paths of the
 * source's delete targets) and lives beside the store lock, in the account
 * folder no delete removes (core/store-custody.ts). The store-open boundary
 * (core/store-open.ts) checks it on every open, so the engine keeps running, the
 * other sources keep working, and only the fenced source's stores stay shut
 * until a later apply finishes the delete and clears the entry.
 *
 * Unreadable fence file: fail closed (every store open is fenced) rather than
 * guess which stores are half deleted.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { ensureStoreCustodyDirectory, storeCustodyDirectory } from './store-custody.ts';

export interface FenceEntry {
  source_id: string;
  /** Delete targets (lexical and canonical) the fence keeps closed. */
  paths: string[];
  /** External SQLite primaries proven Olympus stores when the delete was approved, so a retry can finish their sidecars. */
  verified_primaries: string[];
  /** Why the last attempt did not finish (a reason code, never a path). */
  reason?: string;
  since: string;
}

interface FenceFile {
  version: 1;
  entries: FenceEntry[];
}

const FILE_NAME = 'delete-fence.json';
const SIDECARS = ['-wal', '-shm', '-journal'];

export function deleteFencePath(homeDir?: string): string {
  return join(storeCustodyDirectory(homeDir), FILE_NAME);
}

export function readDeleteFence(homeDir?: string): { entries: FenceEntry[]; unreadable: boolean } {
  const path = deleteFencePath(homeDir);
  if (!existsSync(path)) return { entries: [], unreadable: false };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<FenceFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return { entries: [], unreadable: true };
    return {
      entries: parsed.entries.filter((entry): entry is FenceEntry => !!entry
        && typeof entry.source_id === 'string' && Array.isArray(entry.paths)),
      unreadable: false,
    };
  } catch {
    return { entries: [], unreadable: true };
  }
}

function write(homeDir: string | undefined, entries: FenceEntry[]): void {
  ensureStoreCustodyDirectory(homeDir);
  const path = deleteFencePath(homeDir);
  if (entries.length === 0) {
    writePrivateFileAtomicSync(path, `${JSON.stringify({ version: 1, entries: [] } satisfies FenceFile)}\n`);
    return;
  }
  writePrivateFileAtomicSync(path, `${JSON.stringify({ version: 1, entries } satisfies FenceFile, null, 2)}\n`);
}

/** Add or replace the entry for a source. Durable before it returns. */
export function setDeleteFenceEntry(entry: FenceEntry, homeDir?: string): void {
  const { entries } = readDeleteFence(homeDir);
  const earlier = entries.find((existing) => existing.source_id === entry.source_id);
  // A retry never narrows what an earlier attempt fenced.
  const merged: FenceEntry = earlier ? {
    ...entry,
    paths: [...new Set([...earlier.paths, ...entry.paths])].sort(),
    verified_primaries: [...new Set([...earlier.verified_primaries, ...entry.verified_primaries])].sort(),
    since: earlier.since,
  } : entry;
  write(homeDir, [...entries.filter((existing) => existing.source_id !== entry.source_id), merged]);
}

export function clearDeleteFenceEntry(sourceId: string, homeDir?: string): void {
  const read = readDeleteFence(homeDir);
  if (read.unreadable) return;
  if (!read.entries.some((entry) => entry.source_id === sourceId)) return;
  write(homeDir, read.entries.filter((entry) => entry.source_id !== sourceId));
}

export function setAllDeleteFenceReasons(reason: string, homeDir?: string): void {
  const read = readDeleteFence(homeDir);
  if (read.unreadable || read.entries.length === 0) return;
  write(homeDir, read.entries.map((entry) => ({ ...entry, reason })));
}

export function setDeleteFenceReason(sourceId: string, reason: string, homeDir?: string): void {
  const read = readDeleteFence(homeDir);
  if (read.unreadable) return;
  write(homeDir, read.entries.map((entry) => entry.source_id === sourceId ? { ...entry, reason } : entry));
}

/** Nearest existing ancestor's real path plus the not-yet-existing remainder. */
function canonical(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.push(basename(existing));
      existing = parent;
    }
  }
}

/** Both spellings of a path, for a fence entry. */
export function fencePathSpellings(paths: readonly string[]): string[] {
  return [...new Set(paths.flatMap((path) => [resolve(path), canonical(path)]))].sort();
}

function covers(fenced: string, candidate: string): boolean {
  if (candidate === fenced || candidate.startsWith(`${fenced}${sep}`)) return true;
  return SIDECARS.some((suffix) => candidate === `${fenced}${suffix}`);
}

let bypassDepth = 0;

/** The deleter, holding exclusive custody, opens fenced stores to finish them. */
export function withDeleteFenceBypass<T>(run: () => T): T {
  bypassDepth += 1;
  try { return run(); } finally { bypassDepth -= 1; }
}

/** Is `path` one of the stores a started delete keeps closed? */
export function isStorePathFenced(path: string, homeDir?: string): boolean {
  if (bypassDepth > 0) return false;
  const fencePath = deleteFencePath(homeDir);
  if (!existsSync(fencePath)) return false;
  const read = readDeleteFence(homeDir);
  if (read.unreadable) return true;
  if (read.entries.length === 0) return false;
  const candidates = [resolve(path), canonical(path)];
  return read.entries.some((entry) => entry.paths.some((fenced) => candidates.some((candidate) => covers(fenced, candidate))));
}

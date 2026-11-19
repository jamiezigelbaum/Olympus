// On Linux, mapping SQLite files lets reads use the page cache in place. On
// a 2.9 GiB synthetic store this cut read calls from 6.9 M to 1.7 M. Mapped
// pages are shared across connections, but each mapping counts toward RSS
// and file-cache pressure can still push anonymous memory to swap.
//
// Linux defaults to SQLite's mmap ceiling per connection. 'off' leaves
// mapping disabled. 'bounded' divides a machine-sized budget among the
// engine's reserved database paths, with a page-aligned limit shared by all
// connections to a file. Paths outside the reservation use ordinary reads.
import { createRequire } from 'node:module';
import { totalmem } from 'node:os';
import { resolve } from 'node:path';

const MIB = 1024 * 1024;
const runtimeRequire = createRequire(import.meta.url);

// SQLite's compiled ceiling in Bun (SQLITE_MAX_MMAP_SIZE).
export const SQLITE_MMAP_BYTES = 0x7fff0000;

export interface SqliteMmapPolicy {
  mode: 'on' | 'off' | 'bounded';
  reason: string;
  perFileBytes: number;
  budgetBytes: number;
  files: number;
}

export function sqliteMmapPolicy(
  value: string | undefined,
  platform: NodeJS.Platform,
  memoryBytes: number,
  files: number,
  pageBytes: number,
): SqliteMmapPolicy {
  if (platform !== 'linux' || value === 'off') {
    return { mode: 'off', reason: value === 'off' ? 'disabled by environment' : 'Linux only', perFileBytes: 0, budgetBytes: 0, files };
  }
  if (value !== 'bounded') {
    return { mode: 'on', reason: value === 'on' ? 'enabled by environment' : 'Linux default', perFileBytes: SQLITE_MMAP_BYTES, budgetBytes: 0, files };
  }
  const budgetBytes = Math.floor(Math.min(memoryBytes / 8, 4 * 1024 * MIB));
  const alignedBytes = files && pageBytes
    ? Math.floor(Math.min(budgetBytes / files, SQLITE_MMAP_BYTES) / pageBytes) * pageBytes
    : 0;
  const perFileBytes = alignedBytes >= 16 * MIB ? alignedBytes : 0;
  const reason = perFileBytes ? 'machine budget' : !files ? 'no files reserved'
    : !pageBytes ? 'page size unavailable' : 'below 16 MiB per file';
  return { mode: 'bounded', reason, perFileBytes, budgetBytes, files };
}

function linuxPageBytes(): number {
  try {
    const { dlopen, FFIType } = runtimeRequire('bun:ffi') as typeof import('bun:ffi');
    const libc = dlopen('libc.so.6', { getpagesize: { args: [], returns: FFIType.i32 } });
    try {
      return Number(libc.symbols.getpagesize());
    } finally {
      libc.close();
    }
  } catch {
    // The boot log reports why bounded mapping is disabled.
    return 0;
  }
}

let bounded: { paths: Set<string>; perFileBytes: number } | undefined;

export function configureSqliteMmap(paths: Iterable<string>, value = process.env.OLYMPUS_SQLITE_MMAP): SqliteMmapPolicy {
  const reserved = new Set(Array.from(paths, path => path === ':memory:' ? path : resolve(path)));
  reserved.delete(':memory:');
  const useBudget = process.platform === 'linux' && value === 'bounded';
  const policy = sqliteMmapPolicy(value, process.platform, useBudget ? totalmem() : 0, reserved.size, useBudget ? linuxPageBytes() : 0);
  bounded = policy.mode === 'bounded' ? { paths: reserved, perFileBytes: policy.perFileBytes } : undefined;
  return policy;
}

export function logSqliteMmapPolicy(role: string, policy: SqliteMmapPolicy): void {
  console.log(`[olympus] engine ${role} SQLite file map ${policy.mode} (${policy.reason}; per_file_mb=${Math.floor(policy.perFileBytes / MIB)} budget_mb=${Math.floor(policy.budgetBytes / MIB)} files=${policy.files})`);
}

export function sqliteMmapBytes(dbPath: string): number {
  const value = process.env.OLYMPUS_SQLITE_MMAP;
  if (process.platform !== 'linux' || value === 'off') return 0;
  if (value !== 'bounded') return SQLITE_MMAP_BYTES;
  return dbPath !== ':memory:' && bounded?.paths.has(resolve(dbPath)) ? bounded.perFileBytes : 0;
}

// Apply the same limit to the main connection and the readers it spawns.
export function applySqliteMmap(db: { exec(sql: string): unknown }, dbPath: string): void {
  const bytes = sqliteMmapBytes(dbPath);
  if (!bytes) return;
  try { db.exec(`PRAGMA mmap_size = ${bytes}`); } catch { /* an in-memory or closed connection */ }
}

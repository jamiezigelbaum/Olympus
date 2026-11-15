// Memory-mapped reads for the engine's SQLite files (loop-stall step-back, 15
// Nov 2026). Sparta's background read 265.6 GB through read() in ten minutes
// against 4.74 GB from disk: nearly every read was a copy out of the page
// cache through SQLite's 2 MiB page cache, one syscall a page. With the file
// mapped, SQLite reads those pages in place. Measured on a 2.9 GB synthetic
// store (recount, estimates and 40,000 reads by key, twice): read calls 6.9 M
// to 1.7 M, wall time 12.8 s to 10.1 s, longest statement 2.7 s to 1.8 s. A
// larger cache_size made the same work slower (17.3 s), so it is left as is.
//
// The mapped pages are the files' own page cache, shared and dropped under
// pressure like any cached file; they add no anonymous memory and never go
// to swap. They do count in a process's total RSS, so the engine's RSS
// restart reads anonymous RSS instead (rss-restart.ts). Linux only: elsewhere
// RSS cannot tell the two apart. OLYMPUS_SQLITE_MMAP=off turns it off.

/** SQLite's compiled ceiling in Bun (SQLITE_MAX_MMAP_SIZE 0x7fff0000): a larger file is mapped up to here. */
export const SQLITE_MMAP_BYTES = 0x7fff0000;

export function sqliteMmapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === 'linux' && env.OLYMPUS_SQLITE_MMAP !== 'off';
}

/** Map the connection's main file for reads, where enabled. Never throws. */
export function applySqliteMmap(db: { exec(sql: string): unknown }, env: NodeJS.ProcessEnv = process.env): void {
  if (!sqliteMmapEnabled(env)) return;
  try { db.exec(`PRAGMA mmap_size = ${SQLITE_MMAP_BYTES}`); } catch { /* an in-memory or closed connection */ }
}

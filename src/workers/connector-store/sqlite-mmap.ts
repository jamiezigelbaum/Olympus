// History of memory-mapped reads for the engine's SQLite files.
//
// 15 Nov 2026, on everywhere (loop-stall step-back): the background read
// 265.6 GB through read() in ten minutes against 4.74 GB from disk, a copy
// out of the page cache through SQLite's 2 MiB cache, one syscall a page. On
// a 2.9 GB synthetic store mapping cut read calls 6.9 M to 1.7 M, wall time
// 12.8 s to 10.1 s and the longest statement 2.7 s to 1.8 s. A larger
// cache_size made the same work slower (17.3 s), so it is left as is.
//
// 18 Nov 2026, off for the background only: with the map on, the background
// took 42,000 to 80,000 major faults per run on a 600,000-item fixture under
// an 8 GB cap, against 426 to 771 with it off. The front's worst beat in the
// two valid pairs fell from 4.9 s and 4.0 s to 0.8 s and 1.3 s (front still
// mapped), and items per second rose (12.2 to 17.5, 2.0 to 13.2). On a live
// install the front waited 81 s on page faults at boot while the background's
// mapped file RSS grew to 17 GB. Page faults under memory pressure cost more
// than the read() copies. The front kept the map: its numbers were measured
// with it on.
//
// 19 Nov 2026, off everywhere: on a 14-store, 1.15 million-item, 9.7 GB
// benchmark under a 4.8 GB memory cap, gathering evidence for an Ask took
// 24 to 26.5 s with the map and 2.8 to 5.8 s without it (one took 15.5 s).
// The front incurred 107,000 to 138,000 major faults per Ask with the map
// and at most 5,300 without it. On the 600,000-item fixture, scope swap
// fell from 141 MiB with the map to 18 MiB without it, with zero front
// swap. Switching the map off costs about twice the read() volume
// (52 to 65 GB versus 25 to 27 GB). Under memory pressure, a page fault
// on a mapped file costs more than the read() copy.
//
// Mapped pages are the files' own page cache; they add no anonymous memory
// and never go to swap, but they count in total RSS, so the memory restart
// reads anonymous RSS (rss-restart.ts). OLYMPUS_SQLITE_MMAP=on enables the
// map in any process on Linux. OLYMPUS_SQLITE_MMAP=off explicitly disables it.

/** SQLite's compiled ceiling in Bun (SQLITE_MAX_MMAP_SIZE 0x7fff0000): a larger file is mapped up to here. */
export const SQLITE_MMAP_BYTES = 0x7fff0000;

export function sqliteMmapPolicy(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; reason: string } {
  const setting = env.OLYMPUS_SQLITE_MMAP;
  if (setting === 'off') return { enabled: false, reason: 'OLYMPUS_SQLITE_MMAP=off' };
  if (process.platform !== 'linux') return { enabled: false, reason: 'Linux only' };
  if (setting === 'on') return { enabled: true, reason: 'OLYMPUS_SQLITE_MMAP=on' };
  return { enabled: false, reason: 'default' };
}

export function sqliteMmapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return sqliteMmapPolicy(env).enabled;
}

// Fill in the parent's decision at worker start. Keeping the inline source a
// plain string lets the Node plugin bundle drop the unused bun:sqlite code.
export function sqliteMmapWorkerSource(source: string): string {
  const pragma = sqliteMmapEnabled() ? `
    try { db.exec('PRAGMA mmap_size = ${SQLITE_MMAP_BYTES}'); }
    catch { console.warn('[olympus] SQLite worker could not enable the file map.'); }
  ` : '';
  return source.replace('/*olympus-mmap-pragma*/', pragma);
}

/** Map the connection's main file for reads, where enabled. Never throws. */
export function applySqliteMmap(db: { exec(sql: string): unknown }, env: NodeJS.ProcessEnv = process.env): void {
  if (!sqliteMmapEnabled(env)) return;
  try { db.exec(`PRAGMA mmap_size = ${SQLITE_MMAP_BYTES}`); } catch { /* an in-memory or closed connection */ }
}

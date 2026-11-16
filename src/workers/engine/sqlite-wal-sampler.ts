// What the background's SQLite files are doing while the loop stalls on
// single keyed writes (lane 6 gate, 16 Nov 2026: 1 to 3.5 s writes by key in
// unrelated stores). One receipt has to tell a disk wait from a lock wait from
// a checkpoint: each file's journal settings once, then its WAL size and its
// longest-open read snapshot, logged when either is large. A snapshot held
// open keeps every checkpoint from moving past it, so the WAL grows and some
// later commit on the loop pays for the whole checkpoint.

import { statSync } from 'node:fs';
import { oldestOffThreadSnapshot } from '../connector-store/off-thread-reads.ts';

export interface SqliteJournalSettings { journal_mode: string; synchronous: number; wal_autocheckpoint: number }

export interface SampledSqliteFile {
  /** A short name for the log: a corpus id or a file kind, never a path. */
  label: string;
  dbPath: string;
  settings?: () => SqliteJournalSettings | undefined;
}

/** WAL size (bytes) at or above which a sample is logged. */
export const SQLITE_WAL_NOTABLE_BYTES = 32 * 1024 * 1024;
/** Snapshot age at or above which a sample is logged. */
export const SQLITE_SNAPSHOT_NOTABLE_MS = 2_000;
export const SQLITE_WAL_SAMPLE_MS = 5_000;

export function sampleSqliteFiles(
  files: readonly SampledSqliteFile[],
  seen: Set<string>,
  log: (line: string) => void,
): void {
  for (const file of files) {
    if (!seen.has(file.dbPath)) {
      seen.add(file.dbPath);
      let settings: SqliteJournalSettings | undefined;
      try { settings = file.settings?.(); } catch { settings = undefined; }
      if (settings) {
        log(`[olympus] sqlite settings: ${file.label} journal_mode=${settings.journal_mode} synchronous=${settings.synchronous} wal_autocheckpoint=${settings.wal_autocheckpoint}`);
      }
    }
    let walBytes = 0;
    try { walBytes = statSync(`${file.dbPath}-wal`).size; } catch { walBytes = 0; }
    const snapshot = oldestOffThreadSnapshot(file.dbPath);
    if (walBytes < SQLITE_WAL_NOTABLE_BYTES && (snapshot?.ageMs ?? 0) < SQLITE_SNAPSHOT_NOTABLE_MS) continue;
    log(`[olympus] sqlite wal: ${file.label} wal_bytes=${walBytes} oldest_read_ms=${Math.round(snapshot?.ageMs ?? 0)}${snapshot ? ` oldest_read_lane=${snapshot.lane}` : ''}`);
  }
}

/** Samples every `intervalMs` until stopped. */
export function startSqliteWalSampler(
  files: () => readonly SampledSqliteFile[],
  options: { intervalMs?: number; log?: (line: string) => void } = {},
): { stop(): void } {
  const seen = new Set<string>();
  const log = options.log ?? ((line: string) => console.warn(line));
  const timer = setInterval(() => {
    try { sampleSqliteFiles(files(), seen, log); } catch { /* a sample never stops the engine */ }
  }, options.intervalMs ?? SQLITE_WAL_SAMPLE_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

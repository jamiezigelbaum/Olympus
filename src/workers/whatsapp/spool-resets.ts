// How many times the WhatsApp spool was found broken: one counter, kept for
// good beside the spool in `spool-reset.sqlite`. Unlike the index this is not
// a cache: a reset lost is a message never read.
//
// - Any detected breach of the spool contract (spool-index.ts: a file
//   replaced, cut, or rewritten under a cursor) and any rebuild of the index
//   (what it knew of the files is gone, so a breach could have been missed)
//   counts one reset. The count is written, durably, before the index forgets
//   anything, so a failure in between counts it still.
// - Every cursor a listing hands out carries the count it was handed out at.
//   A cursor carrying another count, or none, reads the whole spool again from
//   its start: intake is idempotent by identity and version, so that is safe,
//   and a breach is rare enough for it to be cheap.
// - Nothing is owed or settled per reader: a reader is caught up exactly when
//   its cursor carries the current count.
// - It fails closed: a listing that cannot open or write it fails before the
//   index forgets anything, never reads on without it.

import { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

export const WHATSAPP_SPOOL_RESET_FILE = 'spool-reset.sqlite';

export class WhatsAppSpoolResets {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  /** Opens the counter beside the spool; throws when it cannot (a listing never reads on without it). */
  static open(spoolDir: string): WhatsAppSpoolResets {
    const path = join(spoolDir, WHATSAPP_SPOOL_RESET_FILE);
    let db: Database | undefined;
    try {
      db = new Database(path, { create: true });
      chmodSync(path, 0o600);
      db.exec(`
        PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      `);
      return new WhatsAppSpoolResets(db);
    } catch (error) {
      try { db?.close(); } catch { /* not open */ }
      throw new Error(`The WhatsApp spool's reset counter cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }

  /** The current count: what a cursor handed out now carries. */
  current(): number {
    return Number(this.read('resets') ?? 0);
  }

  /** One more reset; returns the new count. */
  bump(): number {
    return this.db.transaction(() => {
      const next = this.current() + 1;
      this.write('resets', String(next));
      return next;
    })();
  }

  /**
   * The index in use is the build `build` (spool-index.ts, `build`): a build
   * other than the last one seen (the index was deleted or rebuilt since)
   * counts one reset. Returns the current count.
   */
  noteIndexBuild(build: string): number {
    return this.db.transaction(() => {
      const seen = this.read('index_build');
      let count = this.current();
      if (seen !== build) {
        // The first build ever seen resets nothing a cursor could carry: no cursor was handed out before it.
        if (seen !== undefined) count += 1;
        this.write('resets', String(count));
        this.write('index_build', build);
      }
      return count;
    })();
  }

  private read(key: string): string | undefined {
    const row = this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null;
    return row?.value;
  }

  private write(key: string, value: string): void {
    this.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}

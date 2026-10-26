// What each reader of the WhatsApp spool still owes: a read again of a file
// that broke the spool contract (spool-index.ts), kept for good beside the
// spool in `spool-obligations.sqlite`. Unlike the index this is not a cache:
// an obligation lost is a message never read.
//
// - Per consumer. Every reader with its own cursor (the product pull, sender
//   repair, any other) owes its own read again, and only its own cursor coming
//   back settles it: one reader finishing never erases another's.
// - Written first. A replay is owed before the index forgets what it held of
//   the file, so a pass that fails in between owes it still, and the next
//   reconciliation finds the file again and owes it again (the same file and
//   the newer epoch kept).
// - Epochs belong to an index generation (a random id each time the index is
//   built). A cursor of another generation was handed out before the index
//   last forgot everything, so it never settles anything and its file is read
//   again from the start.

import { Database } from 'bun:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const WHATSAPP_SPOOL_OBLIGATIONS_FILE = 'spool-obligations.sqlite';

export interface SpoolReplayObligation {
  file: string;
  generation: string;
  epoch: number;
}

export class WhatsAppSpoolObligations {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static open(spoolDir: string): WhatsAppSpoolObligations | undefined {
    if (!existsSync(spoolDir)) return undefined;
    const path = join(spoolDir, WHATSAPP_SPOOL_OBLIGATIONS_FILE);
    try {
      const db = new Database(path, { create: true });
      chmodSync(path, 0o600);
      db.exec(`
        PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS consumers (name TEXT PRIMARY KEY) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS obligations (
          consumer TEXT PRIMARY KEY, file TEXT NOT NULL, generation TEXT NOT NULL, epoch INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS epochs (generation TEXT PRIMARY KEY, last INTEGER NOT NULL) WITHOUT ROWID;
      `);
      return new WhatsAppSpoolObligations(db);
    } catch {
      return undefined;
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }

  /** A reader with its own cursor; every replay owed from now on is owed to it too. */
  register(consumer: string): void {
    this.db.query('INSERT OR IGNORE INTO consumers (name) VALUES (?)').run(consumer);
  }

  /** Every known reader owes a read of `file` (or of an earlier file it already owes) from its start. */
  oweEveryone(file: string, generation: string): number {
    return this.db.transaction(() => {
      const row = this.db.query('SELECT last FROM epochs WHERE generation = ?').get(generation) as { last: number } | null;
      const epoch = (row?.last ?? 0) + 1;
      this.db.query('INSERT INTO epochs (generation, last) VALUES (?, ?) ON CONFLICT (generation) DO UPDATE SET last = excluded.last')
        .run(generation, epoch);
      const consumers = this.db.query('SELECT name FROM consumers').all() as Array<{ name: string }>;
      for (const { name } of consumers) {
        const owed = this.owed(name);
        const earliest = owed !== undefined && owed.file < file ? owed.file : file;
        this.db.query(`
          INSERT INTO obligations (consumer, file, generation, epoch) VALUES (?, ?, ?, ?)
          ON CONFLICT (consumer) DO UPDATE SET file = excluded.file, generation = excluded.generation, epoch = excluded.epoch
        `).run(name, earliest, generation, epoch);
      }
      return epoch;
    })();
  }

  owed(consumer: string): SpoolReplayObligation | undefined {
    const row = this.db.query('SELECT file, generation, epoch FROM obligations WHERE consumer = ?').get(consumer) as
      { file: string; generation: string; epoch: number } | null;
    return row ?? undefined;
  }

  /** The consumer's cursor came back carrying `epoch` of `generation`: what it owed up to then is read. */
  settle(consumer: string, generation: string, epoch: number): void {
    const owed = this.owed(consumer);
    if (owed !== undefined && owed.generation === generation && epoch >= owed.epoch) {
      this.db.query('DELETE FROM obligations WHERE consumer = ?').run(consumer);
    }
  }

  /** The newest epoch of a generation: what a cursor handed out now carries. */
  currentEpoch(generation: string): number {
    const row = this.db.query('SELECT last FROM epochs WHERE generation = ?').get(generation) as { last: number } | null;
    return row?.last ?? 0;
  }
}

// What WhatsApp's two inputs agreed on, kept for good beside the spool
// (`export-matches.sqlite`): the ids an imported export gave the messages
// live capture did not hold yet, by their match key and occurrence, and the
// live messages found later to be one of them (an alias: the live message is
// that item, under the export's id). Unlike the spool index this is not a
// cache: without it a message the bridge delivers after an import would be
// stored twice. Digests and ids only, never a name or a text. It goes with the
// account's data.

import { Database } from 'bun:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TimePrecision } from './match-keys.ts';
import { normalizeWhatsAppJid } from './reaction-index.ts';

export const WHATSAPP_MATCH_LEDGER_FILE = 'export-matches.sqlite';

export class WhatsAppMatchLedger {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static open(spoolDir: string): WhatsAppMatchLedger | undefined {
    if (!existsSync(spoolDir)) return undefined;
    const path = join(spoolDir, WHATSAPP_MATCH_LEDGER_FILE);
    try {
      const db = new Database(path, { create: true });
      chmodSync(path, 0o600);
      db.exec(`
        PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS export_ids (
          precision TEXT NOT NULL, key TEXT NOT NULL, ordinal INTEGER NOT NULL, wx_id TEXT NOT NULL, chat_jid TEXT NOT NULL,
          PRIMARY KEY (precision, key, ordinal)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS aliases (
          chat TEXT NOT NULL, live_id TEXT NOT NULL, wx_id TEXT NOT NULL, chat_jid TEXT NOT NULL,
          PRIMARY KEY (chat, live_id)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS aliases_by_wx ON aliases (wx_id);
      `);
      return new WhatsAppMatchLedger(db);
    } catch {
      return undefined;
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }

  /** An export message live did not hold, under its own id. The first id given a key and occurrence is the one kept. */
  recordExport(precision: TimePrecision, key: string, ordinal: number, wxId: string, chatJid: string): void {
    this.db.query('INSERT OR IGNORE INTO export_ids (precision, key, ordinal, wx_id, chat_jid) VALUES (?, ?, ?, ?, ?)')
      .run(precision, key, ordinal, wxId, chatJid);
  }

  exportAt(precision: TimePrecision, key: string, ordinal: number): string | undefined {
    const row = this.db.query('SELECT wx_id FROM export_ids WHERE precision = ? AND key = ? AND ordinal = ?').get(precision, key, ordinal) as { wx_id: string } | null;
    return row?.wx_id;
  }

  /** A live message is the imported item `wxId`: it is stored under that id. */
  alias(chatJid: string, liveId: string, wxId: string): void {
    this.db.query('INSERT OR IGNORE INTO aliases (chat, live_id, wx_id, chat_jid) VALUES (?, ?, ?, ?)')
      .run(normalizeWhatsAppJid(chatJid), liveId, wxId, chatJid);
  }

  aliasOf(chatJid: string, liveId: string): string | undefined {
    const row = this.db.query('SELECT wx_id FROM aliases WHERE chat = ? AND live_id = ?').get(normalizeWhatsAppJid(chatJid), liveId) as { wx_id: string } | null;
    return row?.wx_id;
  }

  /** Whether an imported id was taken by a live message already. */
  claimed(wxId: string): boolean {
    return this.db.query('SELECT 1 FROM aliases WHERE wx_id = ? LIMIT 1').get(wxId) !== null;
  }

  /** The live message an imported id stands for, when one was found. */
  liveOf(wxId: string): { chatJid: string; liveId: string } | undefined {
    const row = this.db.query('SELECT chat_jid, live_id FROM aliases WHERE wx_id = ? LIMIT 1').get(wxId) as { chat_jid: string; live_id: string } | null;
    return row ? { chatJid: row.chat_jid, liveId: row.live_id } : undefined;
  }
}

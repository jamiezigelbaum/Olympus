// A small persistent index of the WhatsApp capture spool: where each message's
// newest line is, and each actor's current reaction to each message.
//
// Reaction lines are facts about other messages, so attaching them used to
// mean reading the whole spool twice whenever a page carried one, and keeping
// every target and actor in memory. The index is built as the listing reads,
// within the listing's own byte budget, so a page's reactions are aggregated
// from a few rows and the reacted-to message is read from its one line. Memory
// stays bounded whatever the spool's lifetime; the rows live on disk beside
// the spool, in `spool-index.sqlite`, and hold ids, positions and reactions,
// never a message's text.
//
// - Positions are `(file, byte offset)`. The bridge only appends, and clearing
//   Secrets rewrites a line in place at its own length, so a position names
//   the same line for as long as its file is there.
// - The index has a high-water mark: everything before it was indexed. Lines
//   at or before the mark are not indexed again, so a replay never moves a
//   reaction backwards, and an index started on an existing spool catches up
//   from the spool's start, a budget at a time, before a page is aggregated.
// - The spool contract (connector-store/spool-file-identity.ts): a spool file
//   is append-only for every writer but Olympus's own clearing of Secrets,
//   which refreshes this index's record of the file in the same step
//   (`refreshFile`). Each file's record keeps where indexing reached in it
//   and the digest of the 4 KiB that end there; a listing reads that window
//   again before it trusts the file, so a file cut and written again, even to
//   the same length or longer, is indexed again from its start.
// - Every indexed file is known by its identity (device, inode and birth time
//   where the platform has one). Each listing reconciles the index with the
//   files that are there before it trusts a position or an aggregate: rows of
//   a file that is gone are dropped, and a file whose identity changed (a
//   replacement, even one of the same length) has its rows dropped and is
//   indexed again from its start. Content is not fingerprinted: clearing
//   Secrets rewrites a line in place, which would read as a replacement.
// - A file found replaced by cursor recovery is treated the same way.
// - The index is a cache of the spool: deleting it costs one catch-up pass.

import { Database } from 'bun:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spoolBoundaryDigest, spoolBoundaryHolds, spoolFileIdentity } from '../connector-store/spool-file-identity.ts';
import type { LiveMatchKeys, TimePrecision } from './match-keys.ts';
import type { WhatsAppReactionEntry } from './reaction-index.ts';
import { normalizeWhatsAppJid } from './reaction-index.ts';

export const WHATSAPP_SPOOL_INDEX_FILE = 'spool-index.sqlite';
const SCHEMA = 5;

export interface SpoolPlace {
  file: string;
  offset: number;
}

export function comparePlaces(a: SpoolPlace, b: SpoolPlace): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.offset - b.offset;
}

/** One live message, as much as matching needs of it. */
export interface IndexedLiveMessage {
  id: string;
  chatJid: string;
  fromMe: boolean;
  timestamp: string;
  mediaType?: string;
  /** The bridge saved its media: the live item already holds that media's content. */
  mediaSaved: boolean;
}

export interface IndexedMessage {
  chatJid: string;
  file: string;
  offset: number;
}

export class WhatsAppSpoolIndex {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  /** Opens (creating) the index beside the spool; undefined when the folder cannot hold it. */
  static open(spoolDir: string): WhatsAppSpoolIndex | undefined {
    if (!existsSync(spoolDir)) return undefined;
    const path = join(spoolDir, WHATSAPP_SPOOL_INDEX_FILE);
    let db: Database;
    try {
      db = new Database(path, { create: true });
      chmodSync(path, 0o600);
      db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version !== SCHEMA) {
        // A cache: an index of another shape is rebuilt from the spool.
        db.exec(`
          DROP TABLE IF EXISTS messages;
          DROP TABLE IF EXISTS reactions;
          DROP TABLE IF EXISTS meta;
          DROP TABLE IF EXISTS files;
          DROP TABLE IF EXISTS live_keys;
          DROP TABLE IF EXISTS chat_names;
          CREATE TABLE live_keys (
            chat TEXT NOT NULL, id TEXT NOT NULL, chat_jid TEXT NOT NULL, from_me INTEGER NOT NULL, time_ms INTEGER NOT NULL,
            media_type TEXT, media_saved INTEGER NOT NULL,
            exact_m TEXT NOT NULL, exact_s TEXT NOT NULL, loose_m TEXT NOT NULL, loose_s TEXT NOT NULL,
            unsent_m TEXT NOT NULL, unsent_s TEXT NOT NULL,
            file TEXT NOT NULL, offset INTEGER NOT NULL,
            PRIMARY KEY (chat, id)
          ) WITHOUT ROWID;
          CREATE INDEX live_keys_exact_m ON live_keys (exact_m, file, offset);
          CREATE INDEX live_keys_exact_s ON live_keys (exact_s, file, offset);
          CREATE INDEX live_keys_loose_m ON live_keys (loose_m);
          CREATE INDEX live_keys_loose_s ON live_keys (loose_s);
          CREATE INDEX live_keys_unsent_m ON live_keys (unsent_m);
          CREATE INDEX live_keys_unsent_s ON live_keys (unsent_s);
          CREATE INDEX live_keys_chat_time ON live_keys (chat, time_ms);
          CREATE INDEX live_keys_file ON live_keys (file);
          CREATE TABLE chat_names (name TEXT NOT NULL, chat TEXT NOT NULL, chat_jid TEXT NOT NULL, PRIMARY KEY (name, chat)) WITHOUT ROWID;
          CREATE TABLE files (name TEXT PRIMARY KEY, identity TEXT NOT NULL, indexed_to INTEGER NOT NULL, boundary TEXT NOT NULL) WITHOUT ROWID;
          CREATE TABLE messages (
            chat TEXT NOT NULL, id TEXT NOT NULL, chat_jid TEXT NOT NULL, file TEXT NOT NULL, offset INTEGER NOT NULL,
            PRIMARY KEY (chat, id)
          ) WITHOUT ROWID;
          CREATE INDEX messages_by_id ON messages (id, file, offset);
          CREATE INDEX messages_by_file ON messages (file);
          CREATE TABLE reactions (
            target TEXT NOT NULL, actor TEXT NOT NULL, file TEXT NOT NULL, offset INTEGER NOT NULL, entry TEXT NOT NULL,
            PRIMARY KEY (target, actor)
          ) WITHOUT ROWID;
          CREATE INDEX reactions_by_file ON reactions (file);
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
          PRAGMA user_version = ${SCHEMA};
        `);
      }
    } catch {
      return undefined;
    }
    return new WhatsAppSpoolIndex(db);
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }

  /** Everything before this place is indexed. */
  highWater(): SpoolPlace | undefined {
    const row = this.db.query("SELECT value FROM meta WHERE key = 'high_water'").get() as { value: string } | null;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.value) as SpoolPlace;
      return typeof parsed.file === 'string' && Number.isSafeInteger(parsed.offset) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether the line at this place is indexed already. */
  covers(place: SpoolPlace): boolean {
    const mark = this.highWater();
    return mark !== undefined && comparePlaces(place, mark) < 0;
  }

  advance(to: SpoolPlace): void {
    const mark = this.highWater();
    if (mark !== undefined && comparePlaces(to, mark) <= 0) return;
    this.db.query("INSERT INTO meta (key, value) VALUES ('high_water', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(to));
  }

  /**
   * Brings the index in line with the files that are there (name to
   * identity): a file that is gone loses its rows; one whose identity changed
   * loses them and is indexed again from its start.
   */
  reconcile(spoolDir: string): string[] {
    const known = this.db.query('SELECT name, identity, indexed_to, boundary FROM files').all() as
      Array<{ name: string; identity: string; indexed_to: number; boundary: string }>;
    const replaced: string[] = [];
    for (const { name, identity, indexed_to: indexedTo, boundary } of known) {
      const path = join(spoolDir, name);
      const now = spoolFileIdentity(path);
      // The same file, holding the same bytes up to where indexing reached: it was only appended to.
      if (now !== undefined && now.identity === identity && now.size >= indexedTo && spoolBoundaryHolds(path, indexedTo, boundary)) continue;
      this.forgetFile(name);
      if (now !== undefined) replaced.push(name);
    }
    // The files that are there but no longer the ones indexed: a listing reads them again from their start.
    return replaced.sort();
  }

  /** Where indexing reached in a file, with the file's identity and the digest that ends there. */
  noteFile(spoolDir: string, name: string, indexedTo: number): void {
    const path = join(spoolDir, name);
    const identity = spoolFileIdentity(path);
    const boundary = spoolBoundaryDigest(path, indexedTo);
    if (!identity || boundary === undefined) return;
    this.db.query(`
      INSERT INTO files (name, identity, indexed_to, boundary) VALUES (?, ?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET identity = excluded.identity, indexed_to = excluded.indexed_to, boundary = excluded.boundary
      WHERE excluded.indexed_to >= files.indexed_to
    `).run(name, identity.identity, indexedTo, boundary);
  }

  /**
   * Clearing a Secret rewrote lines of a file in place, at their own length:
   * the file's record (its identity, the digest at where indexing reached)
   * is taken again, so the rewrite never reads as a break of the contract.
   */
  refreshFile(spoolDir: string, name: string): void {
    const row = this.db.query('SELECT indexed_to FROM files WHERE name = ?').get(name) as { indexed_to: number } | null;
    if (!row) return;
    const path = join(spoolDir, name);
    const identity = spoolFileIdentity(path);
    const boundary = spoolBoundaryDigest(path, row.indexed_to);
    if (!identity || boundary === undefined) {
      this.forgetFile(name);
      return;
    }
    this.db.query('UPDATE files SET identity = ?, boundary = ? WHERE name = ?').run(identity.identity, boundary, name);
  }

  /** The files the index holds a record of. */
  fileNames(): string[] {
    return (this.db.query('SELECT name FROM files ORDER BY name').all() as Array<{ name: string }>).map((row) => row.name);
  }

  /** A file was replaced or is gone: what was indexed of it is dropped, and it is indexed again from its start. */
  forgetFile(file: string): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM messages WHERE file = ?').run(file);
      this.db.query('DELETE FROM reactions WHERE file = ?').run(file);
      this.db.query('DELETE FROM live_keys WHERE file = ?').run(file);
      this.db.query('DELETE FROM files WHERE name = ?').run(file);
      const mark = this.highWater();
      if (mark !== undefined && mark.file >= file) {
        this.db.query("INSERT INTO meta (key, value) VALUES ('high_water', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
          .run(JSON.stringify({ file, offset: 0 }));
      }
    })();
  }

  /** A message line: the newest line of a message is the one kept. */
  noteMessage(chatJid: string, id: string, place: SpoolPlace): void {
    this.db.query(`
      INSERT INTO messages (chat, id, chat_jid, file, offset) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (chat, id) DO UPDATE SET chat_jid = excluded.chat_jid, file = excluded.file, offset = excluded.offset
      WHERE excluded.file > messages.file OR (excluded.file = messages.file AND excluded.offset > messages.offset)
    `).run(normalizeWhatsAppJid(chatJid), id, chatJid, place.file, place.offset);
  }

  /** A reaction line: each actor's last word on a target is the one kept. */
  noteReaction(targetId: string, entry: WhatsAppReactionEntry, place: SpoolPlace): void {
    this.db.query(`
      INSERT INTO reactions (target, actor, file, offset, entry) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (target, actor) DO UPDATE SET file = excluded.file, offset = excluded.offset, entry = excluded.entry
      WHERE excluded.file > reactions.file OR (excluded.file = reactions.file AND excluded.offset > reactions.offset)
    `).run(targetId, entry.actorKey, place.file, place.offset, JSON.stringify(entry));
  }

  /**
   * A message's match keys (match-keys.ts: digests, no text), the newest
   * line of a message being the one kept, and the name of its chat.
   */
  noteMatchKeys(input: {
    chatJid: string;
    id: string;
    fromMe: boolean;
    mediaType?: string;
    mediaSaved: boolean;
    keys: LiveMatchKeys;
    chatNameKey?: string;
  }, place: SpoolPlace): void {
    const chat = normalizeWhatsAppJid(input.chatJid);
    this.db.query(`
      INSERT INTO live_keys (chat, id, chat_jid, from_me, time_ms, media_type, media_saved,
        exact_m, exact_s, loose_m, loose_s, unsent_m, unsent_s, file, offset)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (chat, id) DO UPDATE SET chat_jid = excluded.chat_jid, from_me = excluded.from_me, time_ms = excluded.time_ms,
        media_type = excluded.media_type, media_saved = excluded.media_saved,
        exact_m = excluded.exact_m, exact_s = excluded.exact_s, loose_m = excluded.loose_m, loose_s = excluded.loose_s,
        unsent_m = excluded.unsent_m, unsent_s = excluded.unsent_s, file = excluded.file, offset = excluded.offset
      WHERE excluded.file > live_keys.file OR (excluded.file = live_keys.file AND excluded.offset > live_keys.offset)
    `).run(chat, input.id, input.chatJid, input.fromMe ? 1 : 0, input.keys.timeMs, input.mediaType ?? null, input.mediaSaved ? 1 : 0,
      input.keys.exactMinute, input.keys.exactSecond, input.keys.looseMinute, input.keys.looseSecond,
      input.keys.unsentMinute, input.keys.unsentSecond, place.file, place.offset);
    if (input.chatNameKey) {
      this.db.query('INSERT OR IGNORE INTO chat_names (name, chat, chat_jid) VALUES (?, ?, ?)').run(input.chatNameKey, chat, input.chatJid);
    }
  }

  /** The `ordinal`-th live message (from 0, in spool order) with this exact key, at this precision. */
  liveWithKey(precision: TimePrecision, key: string, ordinal: number): IndexedLiveMessage | undefined {
    const column = precision === 'second' ? 'exact_s' : 'exact_m';
    const row = this.db.query(`
      SELECT id, chat_jid, from_me, time_ms, media_type, media_saved FROM live_keys WHERE ${column} = ?
      ORDER BY file, offset LIMIT 1 OFFSET ?
    `).get(key, ordinal) as { id: string; chat_jid: string; from_me: number; time_ms: number; media_type: string | null; media_saved: number } | null;
    return row ? {
      id: row.id,
      chatJid: row.chat_jid,
      fromMe: row.from_me === 1,
      timestamp: new Date(row.time_ms).toISOString(),
      ...(row.media_type !== null ? { mediaType: row.media_type } : {}),
      mediaSaved: row.media_saved === 1,
    } : undefined;
  }

  /** How many live messages with this exact key come before a place in the spool: a live message's rank among its key's. */
  rankOf(precision: TimePrecision, key: string, place: SpoolPlace): number {
    const column = precision === 'second' ? 'exact_s' : 'exact_m';
    return (this.db.query(`
      SELECT COUNT(*) AS n FROM live_keys WHERE ${column} = ? AND (file < ? OR (file = ? AND offset < ?))
    `).get(key, place.file, place.file, place.offset) as { n: number }).n;
  }

  hasLooseKey(precision: TimePrecision, key: string): boolean {
    const column = precision === 'second' ? 'loose_s' : 'loose_m';
    return this.db.query(`SELECT 1 FROM live_keys WHERE ${column} = ? LIMIT 1`).get(key) !== null;
  }

  /** Whether the owner sent a live message with this key without a sender. */
  ownerSentUnsent(precision: TimePrecision, key: string): boolean {
    const column = precision === 'second' ? 'unsent_s' : 'unsent_m';
    return this.db.query(`SELECT 1 FROM live_keys WHERE ${column} = ? AND from_me = 1 LIMIT 1`).get(key) !== null;
  }

  /** The live chats by this name. */
  chatsNamed(name: string): string[] {
    return (this.db.query('SELECT chat_jid FROM chat_names WHERE name = ?').all(name) as Array<{ chat_jid: string }>).map((row) => row.chat_jid);
  }

  /** Whether live holds any message of this chat between two instants. */
  liveBetween(chatJid: string, fromMs: number, toMs: number): boolean {
    return this.db.query('SELECT 1 FROM live_keys WHERE chat = ? AND time_ms BETWEEN ? AND ? LIMIT 1')
      .get(normalizeWhatsAppJid(chatJid), fromMs, toMs) !== null;
  }

  /** The earliest and latest live message times, when live holds any. */
  liveWindow(): { fromMs: number; toMs: number } | undefined {
    const row = this.db.query('SELECT MIN(time_ms) AS a, MAX(time_ms) AS b FROM live_keys').get() as { a: number | null; b: number | null };
    return row.a === null || row.b === null ? undefined : { fromMs: row.a, toMs: row.b };
  }

  /** Every actor's current reaction to a target, in spool order. */
  reactionsFor(targetId: string): WhatsAppReactionEntry[] {
    const rows = this.db.query('SELECT entry FROM reactions WHERE target = ? ORDER BY file, offset').all(targetId) as Array<{ entry: string }>;
    return rows.map((row) => JSON.parse(row.entry) as WhatsAppReactionEntry);
  }

  /** The newest line of the message with this id, in any chat (ids are unique only per chat; the caller checks the chat). */
  newestMessage(id: string, chatJid?: string): IndexedMessage | undefined {
    const row = (chatJid === undefined
      ? this.db.query('SELECT chat_jid, file, offset FROM messages WHERE id = ? ORDER BY file DESC, offset DESC LIMIT 1').get(id)
      : this.db.query('SELECT chat_jid, file, offset FROM messages WHERE chat = ? AND id = ?').get(normalizeWhatsAppJid(chatJid), id)) as
      { chat_jid: string; file: string; offset: number } | null;
    return row ? { chatJid: row.chat_jid, file: row.file, offset: row.offset } : undefined;
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }
}

// Contract 1 (SourceConnector) adapter for Apple Messages — reads the macOS
// Messages database (chat.db) at a configurable path, read-only, via
// bun:sqlite.
//
// THIN by design: this file adapts the well-known chat.db schema (message,
// chat, handle, chat_message_join) onto the frozen contract in
// src/core/contracts.ts. No storage, no extraction, no answer logic lives
// here — everything downstream is shared.
//
// Two chat.db quirks this connector owns:
//
// - message.date is Apple-epoch (Mac absolute time: seconds since
//   2001-01-01T00:00:00Z) and ships in two encodings depending on the macOS
//   version that wrote the row: whole seconds (pre-High Sierra) or
//   nanoseconds. Any value above 1e12 is nanoseconds — the seconds encoding
//   does not reach 1e12 until the year ~33,679, while the nanosecond encoding
//   passed it 17 minutes into 2001.
//
// - message.text is null for many modern messages; the body then lives in
//   message.attributedBody, a typedstream-archived NSAttributedString. We do
//   NOT ship a full typedstream decoder. decodeAppleAttributedBodyText below
//   is the known best-effort extraction used by most chat.db readers: scan the
//   blob for the literal `NSString` class name, find the inline-string marker
//   byte (0x2B, '+') that follows, decode the typedstream length prefix, and
//   read that many bytes as UTF-8. Anything unexpected degrades the message to
//   metadata_only instead of failing the sync.
//
// classify() is unconditional: personal messages are S4/secure_local, period.
// No content scan may upgrade-or-downgrade its way around that.

import { Database } from 'bun:sqlite';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import { buildSourceSensitivity, type SourceSensitivity } from '../../core/source-index/types.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';

const CONNECTOR_ID = 'apple_messages';
const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 2_000;
const MESSAGE_MIME_TYPE = 'text/plain';
const APPLE_EPOCH_UNIX_SECONDS = 978_307_200; // 2001-01-01T00:00:00Z
const APPLE_NANOSECOND_DATE_THRESHOLD = 1_000_000_000_000; // see header comment
const SECONDS_PER_DAY = 86_400;

export interface AppleMessagesSourceConnectorOptions {
  chatDbPath: string;
  account: string;
  sinceDays?: number;
}

interface AppleMessageRow {
  rowid: number;
  guid: string;
  text: string | null;
  attributed_body: Uint8Array | null;
  date: number | bigint | null;
  is_from_me: number | null;
  service: string | null;
  sender_handle: string | null;
  chat_identifier: string | null;
}

// One row per message even when chat_message_join holds several chats for the
// same message: the joined subquery collapses to a deterministic (MIN) chat.
const MESSAGE_SELECT = `
  SELECT
    message.ROWID AS rowid,
    message.guid AS guid,
    message.text AS text,
    message.attributedBody AS attributed_body,
    message.date AS date,
    message.is_from_me AS is_from_me,
    message.service AS service,
    handle.id AS sender_handle,
    chat_for_message.chat_identifier AS chat_identifier
  FROM message
  LEFT JOIN handle ON handle.ROWID = message.handle_id
  LEFT JOIN (
    SELECT chat_message_join.message_id AS message_id, MIN(chat.chat_identifier) AS chat_identifier
    FROM chat_message_join
    JOIN chat ON chat.ROWID = chat_message_join.chat_id
    GROUP BY chat_message_join.message_id
  ) AS chat_for_message ON chat_for_message.message_id = message.ROWID
`;

const APPLE_DATE_AS_SECONDS_SQL =
  `(CASE WHEN message.date > ${APPLE_NANOSECOND_DATE_THRESHOLD} THEN message.date / 1000000000.0 ELSE message.date END)`;

const LIST_PAGE_SQL = `${MESSAGE_SELECT}
  WHERE message.ROWID > ?
    AND (? IS NULL OR message.date IS NULL OR ${APPLE_DATE_AS_SECONDS_SQL} >= ?)
  ORDER BY message.ROWID ASC
  LIMIT ?
`;

const FETCH_BY_GUID_SQL = `${MESSAGE_SELECT}
  WHERE message.guid = ?
  LIMIT 1
`;

export function createAppleMessagesSourceConnector(
  options: AppleMessagesSourceConnectorOptions,
): SourceConnector {
  const chatDbPath = requireNonEmpty(options.chatDbPath, 'Apple Messages source connector chatDbPath');
  const account = requireNonEmpty(options.account, 'Apple Messages source connector account');
  const sinceDays = normalizeSinceDays(options.sinceDays);

  let cachedDb: Database | undefined;

  const ensureDatabase = (): Database => {
    if (cachedDb) return cachedDb;
    let db: Database;
    try {
      db = new Database(chatDbPath, { readonly: true });
    } catch (error) {
      throw unreadableChatDbError(chatDbPath, error);
    }
    try {
      // Messages.app owns this database and checkpoints it while we read, so a
      // connection with the bun:sqlite default timeout of 0 fails instantly
      // instead of waiting out an ordinary write lock.
      db.exec('PRAGMA busy_timeout = 10000;');
      // A non-sqlite file opens lazily and only fails on first read; probe now
      // so authenticate() (and the first list) gets the clear error.
      db.query('SELECT 1 FROM sqlite_master LIMIT 1').get();
    } catch (error) {
      closeSqliteStore(db);
      throw unreadableChatDbError(chatDbPath, error);
    }
    cachedDb = db;
    return db;
  };

  return {
    id: CONNECTOR_ID,
    family: 'chat',

    async authenticate(): Promise<void> {
      const db = ensureDatabase();
      const messageTable = db
        .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'message' LIMIT 1")
        .get();
      if (!messageTable) {
        throw new Error(
          `Apple Messages chat database at ${chatDbPath} is readable sqlite but has no message table; `
          + 'point chatDbPath at a Messages chat.db.',
        );
      }
    },

    listItems(listOptions?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      const limit = normalizePageLimit(listOptions?.limit);
      const initialAfterRowid = parseRowidCursor(listOptions?.cursor);
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        const db = ensureDatabase();
        const cutoff = sinceDays === undefined
          ? null
          : Math.floor(Date.now() / 1000) - sinceDays * SECONDS_PER_DAY - APPLE_EPOCH_UNIX_SECONDS;
        let afterRowid = initialAfterRowid;
        let hasMore = true;
        while (hasMore) {
          // Fetch one row past the page to learn whether more remain without a
          // trailing empty page.
          const rows = db
            .query(LIST_PAGE_SQL)
            .all(afterRowid, cutoff, cutoff, limit + 1) as AppleMessageRow[];
          hasMore = rows.length > limit;
          const pageRows = hasMore ? rows.slice(0, limit) : rows;
          const fetchedAt = nowIso();
          const lastRow = pageRows[pageRows.length - 1];
          if (lastRow) afterRowid = lastRow.rowid;
          yield {
            items: pageRows.map((row) => rawItemFromMessageRow(row, account, fetchedAt)),
            ...(lastRow ? { nextCursor: String(lastRow.rowid) } : {}),
            done: !hasMore,
          };
        }
      })();
    },

    async fetchItem(localItemId: string): Promise<RawItem> {
      const guid = providerItemIdFromLocalItemId(localItemId, account);
      const db = ensureDatabase();
      const row = db.query(FETCH_BY_GUID_SQL).get(guid) as AppleMessageRow | null;
      if (!row) {
        throw new Error(`Apple Messages message ${guid} was not found in ${chatDbPath}.`);
      }
      return rawItemFromMessageRow(row, account, nowIso());
    },

    classify(): SourceSensitivity {
      // ALWAYS S4/secure_local: personal messages never leave the local trust
      // domain, regardless of what any individual message contains.
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}

function rawItemFromMessageRow(row: AppleMessageRow, account: string, fetchedAt: string): RawItem {
  const text = messageBodyText(row);
  const sentAt = appleMessageDateToIso(row.date);
  const sender = row.is_from_me === 1 ? 'me' : row.sender_handle ?? 'unknown';
  return {
    identity: {
      family: 'chat',
      provider: CONNECTOR_ID,
      accountScope: account,
      providerItemId: row.guid,
      ...(row.chat_identifier ? { providerConversationId: row.chat_identifier } : {}),
      localItemId: `${account}:${row.guid}`,
    },
    mimeType: MESSAGE_MIME_TYPE,
    content: text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text },
    metadata: Object.freeze({
      sender,
      ...(row.chat_identifier ? { chat_identifier: row.chat_identifier } : {}),
      ...(sentAt ? { sent_at: sentAt } : {}),
      ...(row.service ? { service: row.service } : {}),
    }),
    fetchedAt,
  };
}

function messageBodyText(row: AppleMessageRow): string | undefined {
  if (row.text !== null && row.text.trim() !== '') return row.text;
  if (row.attributed_body instanceof Uint8Array) {
    return decodeAppleAttributedBodyText(row.attributed_body);
  }
  return undefined;
}

// Best-effort typedstream extraction (documented in the file header): find the
// `NSString` class name, locate the inline-string marker 0x2B within the next
// few bytes, decode the typedstream length prefix (one byte < 0x80, or
// 0x81 + uint16le / 0x82 + uint32le), then read that many UTF-8 bytes. Returns
// undefined — never throws — when the blob does not match; the caller degrades
// the message to metadata_only (attachments are deferred).
export function decodeAppleAttributedBodyText(blob: Uint8Array): string | undefined {
  const marker = new TextEncoder().encode('NSString');
  const markerIndex = indexOfBytes(blob, marker);
  if (markerIndex < 0) return undefined;
  let offset = markerIndex + marker.length;
  const scanLimit = Math.min(blob.length, offset + 16);
  while (offset < scanLimit && blob[offset] !== 0x2b) offset += 1;
  if (offset >= scanLimit) return undefined;
  const length = readTypedstreamLength(blob, offset + 1);
  if (!length) return undefined;
  const end = length.nextOffset + length.value;
  if (end > blob.length) return undefined;
  const text = new TextDecoder('utf-8', { fatal: false })
    .decode(blob.subarray(length.nextOffset, end));
  return text.trim() === '' ? undefined : text;
}

function readTypedstreamLength(
  blob: Uint8Array,
  offset: number,
): { value: number; nextOffset: number } | undefined {
  const first = blob[offset];
  if (first === undefined) return undefined;
  if (first < 0x80) return { value: first, nextOffset: offset + 1 };
  if (first === 0x81) {
    const low = blob[offset + 1];
    const high = blob[offset + 2];
    if (low === undefined || high === undefined) return undefined;
    return { value: low | (high << 8), nextOffset: offset + 3 };
  }
  if (first === 0x82) {
    const b0 = blob[offset + 1];
    const b1 = blob[offset + 2];
    const b2 = blob[offset + 3];
    const b3 = blob[offset + 4];
    if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) return undefined;
    return { value: b0 | (b1 << 8) | (b2 << 16) | (b3 * 0x1000000), nextOffset: offset + 5 };
  }
  return undefined;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function appleMessageDateToIso(value: number | bigint | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const seconds = numeric > APPLE_NANOSECOND_DATE_THRESHOLD ? numeric / 1_000_000_000 : numeric;
  return new Date(Math.round((seconds + APPLE_EPOCH_UNIX_SECONDS) * 1000)).toISOString();
}

function unreadableChatDbError(chatDbPath: string, cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Apple Messages chat database at ${chatDbPath} is missing or unreadable (${reason}). `
    + 'If this is the live macOS Messages database (~/Library/Messages/chat.db), grant Full Disk Access '
    + 'to the running process in System Settings > Privacy & Security > Full Disk Access, '
    + 'or point chatDbPath at a readable copy of chat.db.',
  );
}

function providerItemIdFromLocalItemId(localItemId: string, account: string): string {
  const prefix = `${account}:`;
  if (!localItemId.startsWith(prefix) || localItemId.length <= prefix.length) {
    throw new Error(`Apple Messages local item ids look like ${prefix}<message guid>.`);
  }
  return localItemId.slice(prefix.length);
}

function parseRowidCursor(cursor: string | undefined): number {
  const trimmed = cursor?.trim();
  if (!trimmed) return 0;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== trimmed) {
    throw new Error(`Apple Messages list cursors are message ROWID watermarks; got ${JSON.stringify(cursor)}.`);
  }
  return value;
}

function normalizePageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(1, Math.floor(value)), MAX_PAGE_LIMIT);
}

function normalizeSinceDays(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Apple Messages source connector sinceDays must be a positive number of days.');
  }
  return value;
}

function requireNonEmpty(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function nowIso(): string {
  return new Date().toISOString();
}

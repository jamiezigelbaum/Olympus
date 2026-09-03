// Gated maintenance command for WhatsApp connector-store identity repair.
//
// Default mode is dry-run. Pass --apply to update an existing connector store
// from a local whatsmeow session.db contact/LID map. This never contacts
// WhatsApp and never replays spool/export data.

import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';

interface Args {
  db: string;
  sessionDb: string;
  apply: boolean;
}

interface ContactAlias {
  displayName: string;
  aliases: string[];
}

interface AliasIndex {
  byJid: Map<string, ContactAlias>;
  byDisplayName: Map<string, ContactAlias>;
}

interface ItemCandidate {
  item_pk: number;
  provider_conversation_id: string | null;
  title: string | null;
  search_text: string | null;
}

export interface WhatsAppIdentityBackfillSummary {
  kind: 'whatsapp_identity_backfill';
  dry_run: boolean;
  items_scanned: number;
  items_matched: number;
  items_updated: number;
  lid_conversations_matched: number;
  export_name_aliases_matched: number;
  fts_rows_rebuilt: number;
  unmatched_lid_conversations: number;
  policy: {
    local_only: true;
    network_used: false;
    raw_message_text_exposed: false;
    direct_db_mutation: boolean;
  };
  matched_item_hashes: string[];
}

export function buildWhatsAppContactAliasIndex(sessionDb: Database): AliasIndex {
  const contacts = sessionDb.query(`
    SELECT their_jid, first_name, full_name, push_name, business_name, redacted_phone
    FROM whatsmeow_contacts
  `).all() as Array<{
    their_jid: string;
    first_name: string | null;
    full_name: string | null;
    push_name: string | null;
    business_name: string | null;
    redacted_phone: string | null;
  }>;
  const mappings = sessionDb.query('SELECT lid, pn FROM whatsmeow_lid_map').all() as Array<{
    lid: string;
    pn: string;
  }>;

  const lidByPn = new Map(mappings.map((row) => [row.pn, row.lid]));
  const aliasesByName = new Map<string, Set<string>>();
  const displayByName = new Map<string, string>();

  for (const contact of contacts) {
    const displayName = firstNonEmpty(contact.full_name, contact.push_name, contact.business_name, contact.first_name);
    if (!displayName) continue;
    const key = normalizeIdentityKey(displayName);
    displayByName.set(key, displayName);
    const aliases = aliasesByName.get(key) ?? new Set<string>();
    aliases.add(displayName);
    for (const jid of contactJidAliases(contact.their_jid)) aliases.add(jid);
    const user = jidUser(contact.their_jid);
    if (user) {
      aliases.add(user);
      const lid = lidByPn.get(user);
      if (lid) {
        aliases.add(lid);
        aliases.add(`${lid}@lid`);
      }
    }
    aliasesByName.set(key, aliases);
  }

  const byJid = new Map<string, ContactAlias>();
  const byDisplayName = new Map<string, ContactAlias>();
  for (const [key, aliases] of aliasesByName.entries()) {
    const displayName = displayByName.get(key);
    if (!displayName) continue;
    const alias = { displayName, aliases: Array.from(aliases).sort() };
    byDisplayName.set(key, alias);
    for (const value of aliases) {
      const normalized = normalizeJidAlias(value);
      if (normalized) byJid.set(normalized, alias);
    }
  }
  return { byJid, byDisplayName };
}

export function backfillWhatsAppConnectorStoreIdentities(input: {
  connectorStoreDb: Database;
  sessionDb: Database;
  apply: boolean;
}): WhatsAppIdentityBackfillSummary {
  const aliases = buildWhatsAppContactAliasIndex(input.sessionDb);
  const items = input.connectorStoreDb.query(`
    SELECT item_pk, provider_conversation_id, title, search_text
    FROM items
    WHERE provider = 'whatsapp'
      AND family = 'chat'
      AND tombstoned = 0
  `).all() as ItemCandidate[];

  let itemsMatched = 0;
  let itemsUpdated = 0;
  let lidConversationsMatched = 0;
  let exportNameAliasesMatched = 0;
  let ftsRowsRebuilt = 0;
  let unmatchedLidConversations = 0;
  const matchedHashes: string[] = [];

  const update = input.connectorStoreDb.query(`
    UPDATE items
    SET title = ?, search_text = ?, indexed_at = ?
    WHERE item_pk = ?
  `);

  const runUpdates = input.connectorStoreDb.transaction(() => {
    for (const item of items) {
      const match = aliasForConversation(item.provider_conversation_id, aliases);
      if (!match) {
        if (item.provider_conversation_id?.endsWith('@lid')) unmatchedLidConversations += 1;
        continue;
      }
      itemsMatched += 1;
      if (item.provider_conversation_id?.endsWith('@lid')) lidConversationsMatched += 1;
      if (isExportConversationName(item.provider_conversation_id)) exportNameAliasesMatched += 1;
      matchedHashes.push(hashItemPk(item.item_pk));

      const nextTitle = titleForMatchedConversation(item, match);
      const nextSearchText = searchTextForMatchedConversation(item, match, nextTitle);
      if (item.title === nextTitle && item.search_text === nextSearchText) continue;
      itemsUpdated += 1;
      if (!input.apply) continue;
      update.run(nextTitle, nextSearchText, new Date().toISOString(), item.item_pk);
      ftsRowsRebuilt += rebuildFtsForItem(input.connectorStoreDb, item.item_pk, nextTitle, nextSearchText);
    }
  });

  runUpdates();

  return {
    kind: 'whatsapp_identity_backfill',
    dry_run: !input.apply,
    items_scanned: items.length,
    items_matched: itemsMatched,
    items_updated: itemsUpdated,
    lid_conversations_matched: lidConversationsMatched,
    export_name_aliases_matched: exportNameAliasesMatched,
    fts_rows_rebuilt: ftsRowsRebuilt,
    unmatched_lid_conversations: unmatchedLidConversations,
    policy: {
      local_only: true,
      network_used: false,
      raw_message_text_exposed: false,
      direct_db_mutation: input.apply,
    },
    matched_item_hashes: matchedHashes.slice(0, 25),
  };
}

function aliasForConversation(conversationId: string | null, aliases: AliasIndex): ContactAlias | undefined {
  if (!conversationId) return undefined;
  const jidAlias = normalizeJidAlias(conversationId);
  if (jidAlias) return aliases.byJid.get(jidAlias);
  return aliases.byDisplayName.get(normalizeIdentityKey(conversationId));
}

function titleForMatchedConversation(item: ItemCandidate, alias: ContactAlias): string {
  if (item.provider_conversation_id?.endsWith('@lid') || item.provider_conversation_id?.endsWith('@s.whatsapp.net')) {
    return alias.displayName;
  }
  return item.title?.trim() || item.provider_conversation_id?.trim() || alias.displayName;
}

function searchTextForMatchedConversation(item: ItemCandidate, alias: ContactAlias, title: string): string {
  const parts = [
    title,
    alias.displayName,
    item.provider_conversation_id ?? undefined,
    ...alias.aliases,
  ];
  return uniqueNonEmpty(parts).join('\n');
}

// Mirrors LocalConnectorStore.refreshFtsForItem: the fts5 table is contentless
// as far as ownership goes, so connector_store_fts_rows is the only record of
// which rowid belongs to which item. Deleting by item_pk and inserting without
// updating the map leaves the map pointing at freed rowids and the new rows
// unowned — row COUNTS still match, so the store's reopen validation passes
// and the damage only surfaces on the next refresh, as an un-openable store.
function rebuildFtsForItem(db: Database, itemPk: number, title: string, searchText: string): number {
  deleteFtsForItem(db, itemPk);
  const chunks = db.query('SELECT chunk_pk, bounded_text FROM chunks WHERE item_pk = ? ORDER BY chunk_index')
    .all(itemPk) as Array<{ chunk_pk: number; bounded_text: string }>;
  if (chunks.length === 0) {
    insertFtsRow(db, title, connectorStoreFtsText(searchText, ''), itemPk, null);
    return 1;
  }
  for (const chunk of chunks) {
    insertFtsRow(db, title, connectorStoreFtsText(searchText, chunk.bounded_text), itemPk, chunk.chunk_pk);
  }
  return chunks.length;
}

function deleteFtsForItem(db: Database, itemPk: number): void {
  const rows = db.query('SELECT fts_rowid FROM connector_store_fts_rows WHERE item_pk = ? ORDER BY fts_rowid')
    .all(itemPk) as Array<{ fts_rowid: number }>;
  const removeFts = db.query('DELETE FROM connector_store_fts WHERE rowid = ?');
  for (const row of rows) removeFts.run(row.fts_rowid);
  db.query('DELETE FROM connector_store_fts_rows WHERE item_pk = ?').run(itemPk);
}

function insertFtsRow(db: Database, title: string, text: string, itemPk: number, chunkPk: number | null): void {
  const inserted = db.query('INSERT INTO connector_store_fts (title, bounded_text, item_pk, chunk_pk) VALUES (?, ?, ?, ?)')
    .run(title, text, itemPk, chunkPk);
  db.query('INSERT INTO connector_store_fts_rows (fts_rowid, item_pk, chunk_pk) VALUES (?, ?, ?)')
    .run(Number(inserted.lastInsertRowid), itemPk, chunkPk);
}

function connectorStoreFtsText(searchText: string, boundedText: string): string {
  return [searchText.trim(), boundedText].filter((part) => part.trim() !== '').join('\n');
}

function isExportConversationName(conversationId: string | null): boolean {
  return Boolean(conversationId && !normalizeJidAlias(conversationId));
}

function contactJidAliases(jid: string): string[] {
  const normalized = normalizeJidAlias(jid);
  if (!normalized) return [];
  const user = jidUser(normalized);
  return user ? [normalized, user] : [normalized];
}

function normalizeJidAlias(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (/^\d+@(?:s\.whatsapp\.net|lid)$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return trimmed;
  return undefined;
}

function jidUser(jid: string): string | undefined {
  const trimmed = jid.trim().toLowerCase();
  const separator = trimmed.indexOf('@');
  const user = separator >= 0 ? trimmed.slice(0, separator) : trimmed;
  return /^\d+$/.test(user) ? user : undefined;
}

function normalizeIdentityKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function hashItemPk(itemPk: number): string {
  return createHash('sha256').update(String(itemPk)).digest('hex').slice(0, 16);
}

function parseArgs(argv: readonly string[]): Args {
  let db: string | undefined;
  let sessionDb: string | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = (): string => {
      const next = argv[index + 1];
      if (!next) throw new Error(`${flag} requires a value.`);
      index += 1;
      return next;
    };
    if (flag === '--db') db = value();
    else if (flag === '--session-db') sessionDb = value();
    else if (flag === '--apply') apply = true;
    else {
      throw new Error('Usage: bun scripts/whatsapp-identity-backfill.ts --db <connector-store.db> --session-db <session.db> [--apply]');
    }
  }
  if (!db || !sessionDb) {
    throw new Error('Usage: bun scripts/whatsapp-identity-backfill.ts --db <connector-store.db> --session-db <session.db> [--apply]');
  }
  return { db, sessionDb, apply };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const connectorStoreDb = new Database(args.db);
    const sessionDb = new Database(args.sessionDb, { readonly: true });
    // This backfill writes the same connector store the live-drain unit is
    // writing, so without a timeout its first contended UPDATE fails instantly
    // with SQLITE_BUSY and leaves the run part-applied.
    connectorStoreDb.exec('PRAGMA busy_timeout = 10000;');
    sessionDb.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON;');
    try {
      const summary = backfillWhatsAppConnectorStoreIdentities({ connectorStoreDb, sessionDb, apply: args.apply });
      console.log(JSON.stringify(summary, null, 2));
    } finally {
      connectorStoreDb.close();
      sessionDb.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

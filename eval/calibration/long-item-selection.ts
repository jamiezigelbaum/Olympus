// Store walk, full identity matching and deterministic windows shared by long-item proofs.
import { constants, Database } from 'bun:sqlite';
import { lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { TIER_LEDGER_FILE_SUFFIX } from '../../src/workers/classification/tier-ledger-path.ts';
import type { TierLedgerIdentity } from '../../src/workers/classification/tier-ledger.ts';
import { SNIFFER_EXCERPT_MAX_CHARS } from '../../src/workers/classification/tier-classifier.ts';
import { rng, shuffle } from './sample-random.ts';
export const WINDOW = SNIFFER_EXCERPT_MAX_CHARS;
const SKIP_DIRS = new Set(['models', 'backup-staging', 'engine-run', 'node_modules', 'tier-migration']);

/** Opens a database file read-only and immutable, so a copy is never locked or written. */
export function openImmutable(path: string): Database {
  return new Database(`file:${encodeURI(path)}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
}

const hasTable = (db: Database, name: string) => Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const columns = (db: Database, table: string) => new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));

/** Every tier ledger under the root. */
function ledgers(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name)); continue; }
      if (entry.isFile() && entry.name.endsWith(TIER_LEDGER_FILE_SUFFIX)) found.push(join(dir, entry.name));
    }
  };
  walk(root);
  return found.sort();
}

/**
 * The stores a ledger may tier: every connector store in the ledger's folder
 * (`.sqlite` or `.db`; layouts name a set's tiers differently, and messaging
 * stores are `.db`). Items are matched by their full identity, provider
 * included, so a store of another source in the same folder never matches.
 */
export function storesFor(ledgerPath: string): string[] {
  const dir = dirname(ledgerPath);
  return readdirSync(dir)
    .filter((file) => lstatSync(join(dir, file)).isFile() && /\.(sqlite|db)$/.test(file) && !/\.(tier-ledger|tier-sniffer|secret-locations)\.sqlite$/.test(file))
    .map((file) => join(dir, file))
    .sort();
}

interface Store {
  db: Database;
  /** item key -> { pk, chars } */
  items: Map<string, { pk: number; chars: number }>;
  /** provider + item id only: shows an identity mismatch (scope or conversation) in the diagnostics. */
  byId: Set<string>;
  byScopeId: Set<string>;
  row: ReturnType<Database['query']>;
  chunks: ReturnType<Database['query']>;
}

const keyOf = (provider: string, scope: string, conversation: string, id: string) => JSON.stringify([provider, scope, conversation, id]);

const openStores = new Map<string, Store | null>();
const storeErrors = new Map<string, string>();
export function store(path: string): Store | null {
  if (openStores.has(path)) return openStores.get(path)!;
  let opened: Store | null = null;
  try {
    const db = openImmutable(path);
    if (hasTable(db, 'items') && hasTable(db, 'chunks')) {
      // The ledger keys an item by its raw provider conversation id (tier-ledger.ts), while
      // older stores key it by the normalized one. Index both, so either matches.
      const itemColumns = columns(db, 'items');
      const raw = itemColumns.has('provider_conversation_id') ? 'i.provider_conversation_id' : "''";
      const normalized = itemColumns.has('normalized_conversation') ? 'i.normalized_conversation' : "''";
      const items = new Map<string, { pk: number; chars: number }>();
      const byId = new Set<string>();
      const byScopeId = new Set<string>();
      const rows = db.query(`SELECT i.item_pk AS pk, i.provider, i.account_scope, ${raw} AS raw, ${normalized} AS normalized, i.provider_item_id,
          COALESCE((SELECT SUM(LENGTH(c.bounded_text)) + COUNT(*) - 1 FROM chunks c WHERE c.item_pk = i.item_pk), 0) AS chars
        FROM items i WHERE i.tombstoned = 0`).all() as Array<{ pk: number; provider: string; account_scope: string; raw: string | null; normalized: string | null; provider_item_id: string; chars: number }>;
      for (const row of rows) {
        byId.add(JSON.stringify([row.provider, row.provider_item_id]));
        byScopeId.add(JSON.stringify([row.provider, row.account_scope, row.provider_item_id]));
        for (const conversation of new Set([row.raw ?? '', row.normalized ?? ''])) {
          const key = keyOf(row.provider, row.account_scope, conversation, row.provider_item_id);
          const prior = items.get(key);
          if (!prior || row.chars > prior.chars) items.set(key, { pk: row.pk, chars: row.chars });
        }
      }
      opened = {
        db,
        items,
        byId,
        byScopeId,
        row: db.query('SELECT * FROM items WHERE item_pk = ?'),
        chunks: db.query('SELECT bounded_text, content_hash FROM chunks WHERE item_pk = ? ORDER BY chunk_index'),
      };
    } else {
      db.close();
    }
  } catch (error) {
    storeErrors.set(path, error instanceof Error ? error.message.slice(0, 120) : 'unreadable');
    opened = null;
  }
  openStores.set(path, opened);
  return opened;
}

export interface LongItem { store: Store; pk: number; provider: string; chars: number; ledgerPath: string; storePath: string; identity: TierLedgerIdentity }

export interface FamilyCount {
  personal: number;
  personalNotRead: number;
  longerThanJudgeReads: number;
  charsBeyond: number;
  noStoredText: number;
  lengths: number[];
  longLengths: number[];
}


interface LedgerDiagnostic {
  ledger: string;
  stores: Record<string, number | string>;
  personal: number;
  noItem: number;
  idMatchOnly: number;
  /** Of those, also the same account scope: the conversation key differs. */
  scopeAndIdMatch: number;
  zeroText: number;
}

export function count(root: string): { families: Record<string, FamilyCount>; long: LongItem[]; ledgers: number; stores: number; diagnostics: LedgerDiagnostic[] } {
  const diagnostics: LedgerDiagnostic[] = [];
  const rel = (path: string) => path.slice(root.replace(/\/+$/, '').length + 1);
  const families: Record<string, FamilyCount> = {};
  const long: LongItem[] = [];
  const found = ledgers(root);
  const usedStores = new Set<string>();
  for (const ledgerPath of found) {
    const ledger = openImmutable(ledgerPath);
    try {
      if (!hasTable(ledger, 'tier_items')) continue;
      const hasConversation = columns(ledger, 'tier_items').has('conversation_key');
      const all = storesFor(ledgerPath).map((path) => ({ path, opened: store(path) }));
      const candidates = all.filter((entry) => entry.opened !== null);
      const diagnostic: LedgerDiagnostic = {
        ledger: rel(ledgerPath),
        stores: Object.fromEntries(all.map((entry) => [basename(entry.path), entry.opened ? entry.opened.items.size : (storeErrors.get(entry.path) ?? 'no items/chunks tables')])),
        personal: 0,
        noItem: 0,
        idMatchOnly: 0,
        scopeAndIdMatch: 0,
        zeroText: 0,
      };
      diagnostics.push(diagnostic);
      const rows = ledger.query(`SELECT provider, account_scope, ${hasConversation ? 'conversation_key' : "''"} AS conversation_key, provider_item_id, content_read
        FROM tier_items WHERE content_tier = 'private' AND state != 'moving'`).all() as Array<{ provider: string; account_scope: string; conversation_key: string; provider_item_id: string; content_read: number }>;
      for (const row of rows) {
        const family = (families[row.provider] ??= { personal: 0, personalNotRead: 0, longerThanJudgeReads: 0, charsBeyond: 0, noStoredText: 0, lengths: [], longLengths: [] });
        family.personal += 1;
        diagnostic.personal += 1;
        if (row.content_read !== 1) family.personalNotRead += 1;
        const key = keyOf(row.provider, row.account_scope, row.conversation_key, row.provider_item_id);
        let best: { store: Store; path: string; pk: number; chars: number } | undefined;
        for (const candidate of candidates) {
          const hit = candidate.opened!.items.get(key);
          if (hit && (!best || hit.chars > best.chars)) best = { store: candidate.opened!, path: candidate.path, pk: hit.pk, chars: hit.chars };
        }
        if (!best) {
          diagnostic.noItem += 1;
          const id = JSON.stringify([row.provider, row.provider_item_id]);
          if (candidates.some((candidate) => candidate.opened!.byId.has(id))) diagnostic.idMatchOnly += 1;
          const scoped = JSON.stringify([row.provider, row.account_scope, row.provider_item_id]);
          if (candidates.some((candidate) => candidate.opened!.byScopeId.has(scoped))) diagnostic.scopeAndIdMatch += 1;
        } else if (best.chars === 0) diagnostic.zeroText += 1;
        if (!best || best.chars === 0) { family.noStoredText += 1; continue; }
        usedStores.add(best.path);
        family.lengths.push(best.chars);
        if (best.chars > WINDOW) {
          family.longerThanJudgeReads += 1;
          family.charsBeyond += best.chars - WINDOW;
          family.longLengths.push(best.chars);
          if (row.content_read === 1) long.push({ store: best.store, pk: best.pk, provider: row.provider, chars: best.chars, ledgerPath, storePath: best.path, identity: { provider: row.provider, accountScope: row.account_scope, providerItemId: row.provider_item_id, ...(row.conversation_key ? { providerConversationId: row.conversation_key } : {}) } });
        }
      }
    } finally {
      ledger.close();
    }
  }
  return { families, long, ledgers: found.length, stores: usedStores.size, diagnostics };
}

export function closeStores(): void {
  for (const opened of openStores.values()) opened?.db.close();
  openStores.clear();
  storeErrors.clear();
}

export function pickLongItems<T>(long: readonly T[], size = 200, seed = 1): T[] {
  return shuffle([...long], rng(seed)).slice(0, size);
}

/** Offsets use the same newline-joined stored text as long-items, including straddling windows. */
export function unseenWindows(parts: readonly { bounded_text: string; content_hash: string }[], max = 25) {
  let offset = 0;
  const spans = parts.map(part => {
    const start = offset;
    offset += part.bounded_text.length + 1;
    return { start, end: offset - 1, hash: part.content_hash };
  });
  const text = parts.map(part => part.bounded_text).join('\n');
  const windows: Array<{ text: string; chunkHashes: string[] }> = [];
  for (let at = WINDOW; at < text.length && windows.length < max; at += WINDOW) {
    windows.push({ text: text.slice(at, at + WINDOW), chunkHashes: [...new Set(spans.filter(span => span.start < at + WINDOW && span.end > at).map(span => span.hash))] });
  }
  return windows;
}

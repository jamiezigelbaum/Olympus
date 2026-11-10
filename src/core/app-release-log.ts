/**
 * What AI apps received (#1061): one row per request an AI app or agent made,
 * with the items Olympus released to answer it, by name. Worker private
 * state, kept like the waiting private questions beside it: SQLite in the
 * owner-only data directory (0700), the file 0600, secure_delete and DELETE
 * journaling so a Clear leaves no WAL history.
 *
 * Holds questions, source labels and titles, tiers at release, and the
 * identifiers that find an item again on this computer. Never item text.
 * Served only through the local dashboard's control route
 * (workers/apps-received.ts); never exported, never in telemetry or a support
 * bundle; removed by Delete all; a source's rows go with the source.
 *
 * Retention is the owner's choice: 7, 30 (default) or 90 days, or 0 (don't
 * keep), which also clears what is kept.
 *
 * An item that becomes Secret keeps its location only here too
 * (docs/TRUST_MODEL.md): the Secrets disposition
 * (workers/connector-store/secrets-disposition.ts) clears its recorded titles
 * and locators and leaves a marker, so a receipt written later (built before
 * the change) records it without them. The marker is retired when the item
 * leaves Secrets, so a later release is named again.
 */
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { AppRequestRecord, ReleasedItem, ReleasedTier } from './app-release-capture.ts';
import { SHARED_DATA_FILES } from './olympus-layout.ts';
import { resolveRemoteConnectionsDbPath } from './remote-connections.ts';
import { assertSqliteSchemaCanOpen, runSqliteMigrations, type SqliteMigration } from './sqlite-migrations.ts';
import { closeSqliteStore } from './sqlite-store.ts';

export const APP_RELEASE_LOG_STORE_ID = 'app-release-log';
export const APP_RELEASE_LOG_SCHEMA_VERSION = 2;
export const APP_RELEASE_RETENTION_DAYS = [7, 30, 90, 0] as const;
export type AppReleaseRetentionDays = (typeof APP_RELEASE_RETENTION_DAYS)[number];
export const APP_RELEASE_DEFAULT_RETENTION_DAYS: AppReleaseRetentionDays = 30;
const MAX_ITEMS_PER_REQUEST = 48;
const LIST_LIMIT = 200;
const DAY_MS = 24 * 60 * 60_000;
const RETENTION_KEY = 'retention_days';

/** Beside the remote connections, like the waiting private questions. */
export function appReleaseLogDbPath(remoteConnectionsDbPath: string): string {
  return join(dirname(remoteConnectionsDbPath), SHARED_DATA_FILES['app-release-log']);
}

const openLogPaths = new Map<string, number>();

/**
 * The default log path plus every log this process holds open: the Secrets
 * disposition clears an item in each.
 */
export function appReleaseLogDbPaths(env: Record<string, string | undefined> = process.env): string[] {
  return [...new Set([appReleaseLogDbPath(resolveRemoteConnectionsDbPath(env)), ...openLogPaths.keys()])];
}

/**
 * An item as the log knows it. No account scope is recorded, so every
 * account's copy of the provider item matches, and a row or marker without a
 * conversation matches any: a Secret clears too much rather than too little.
 */
export interface AppReleaseSecretItem {
  provider: string;
  providerItemId: string;
  /** Only that conversation's item; absent, the provider item in any conversation. */
  providerConversationId?: string;
}

export interface AppReleaseLogItem {
  position: number;
  source: string;
  title?: string;
  tier: ReleasedTier;
  /** The owner made this item Private from the list. */
  madePrivate: boolean;
}

export interface AppReleaseLogEntry {
  id: string;
  at: number;
  connection: { name: string; kind: 'app' | 'agent' };
  question: string;
  heldBack: number;
  answeredPrivately: boolean;
  withheld: boolean;
  items: AppReleaseLogItem[];
}

export interface AppReleaseLogStore {
  record(record: AppRequestRecord): string | undefined;
  list(): AppReleaseLogEntry[];
  retentionDays(): AppReleaseRetentionDays;
  setRetentionDays(days: AppReleaseRetentionDays): void;
  /** Every request removed; the count removed. */
  clear(): number;
  /** The identifiers of one released item, for the per-item correction. */
  item(requestId: string, position: number): (ReleasedItem & { madePrivate: boolean }) | undefined;
  markMadePrivate(requestId: string, position: number): void;
  /** The waiting private question a request left was answered on this computer; how many rows it marked. */
  markAnsweredPrivately(privateQuestionId: string): number;
  /** Removes (or, dry, counts) the items of these corpora. */
  forgetCorpora(corpusIds: readonly string[], dryRun: boolean): number;
  /**
   * The item became Secret: its recorded titles and locators are cleared and
   * a marker keeps a later receipt from writing them back. `proceed`, checked
   * inside the write, skips it (0) when false. The rows cleared.
   */
  forgetSecretItem(item: AppReleaseSecretItem, options?: { proceed?: () => boolean }): number;
  /**
   * The item left Secrets: its marker goes, so a later release is recorded
   * with its title. `stillSecret`, checked inside the write, keeps it.
   */
  retireSecretItem(item: Omit<AppReleaseSecretItem, 'providerConversationId'>, options?: { stillSecret?: () => boolean }): void;
  close(): void;
}

export function isAppReleaseRetentionDays(value: unknown): value is AppReleaseRetentionDays {
  return typeof value === 'number' && (APP_RELEASE_RETENTION_DAYS as readonly number[]).includes(value);
}

export function openAppReleaseLog(dbPath: string, options: { now?: () => number } = {}): AppReleaseLogStore {
  const now = options.now ?? Date.now;
  hardenPrivatePath(dbPath);
  const db = new Database(dbPath, { create: true });
  try {
    chmodSync(dbPath, 0o600);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;');
    db.transaction(() => {
      assertSqliteSchemaCanOpen(db, APP_RELEASE_LOG_STORE_ID, APP_RELEASE_LOG_SCHEMA_VERSION);
      runSqliteMigrations(db, APP_RELEASE_LOG_STORE_ID, migrations());
    }).immediate();
  } catch (error) {
    closeSqliteStore(db);
    throw error;
  }
  openLogPaths.set(dbPath, (openLogPaths.get(dbPath) ?? 0) + 1);
  let registered = true;

  const retentionDays = (): AppReleaseRetentionDays => {
    const row = db.query('SELECT value FROM app_release_meta WHERE key = ?').get(RETENTION_KEY) as { value: string } | null;
    const days = row ? Number(row.value) : APP_RELEASE_DEFAULT_RETENTION_DAYS;
    return isAppReleaseRetentionDays(days) ? days : APP_RELEASE_DEFAULT_RETENTION_DAYS;
  };
  const clear = (): number => db.transaction(() => {
    db.query('DELETE FROM app_release_items').run();
    return db.query('DELETE FROM app_release_requests').run().changes;
  })();
  const expire = (): void => {
    const days = retentionDays();
    if (days === 0) {
      clear();
      return;
    }
    const before = now() - days * DAY_MS;
    db.transaction(() => {
      db.query('DELETE FROM app_release_items WHERE request_id IN (SELECT id FROM app_release_requests WHERE at < ?)').run(before);
      db.query('DELETE FROM app_release_requests WHERE at < ?').run(before);
    })();
  };

  return {
    record(record) {
      if (retentionDays() === 0) return undefined;
      const id = `apr_${randomBytes(12).toString('base64url')}`;
      db.transaction(() => {
        db.query(`INSERT INTO app_release_requests (id, at, connection_id, connection_name, connection_kind, question, held_back, answered_privately, withheld, private_question_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, record.at, record.connection.id ?? null, record.connection.name.slice(0, 80), record.connection.kind,
          record.question.slice(0, 2_000), Math.max(0, Math.floor(record.heldBack)), record.answeredPrivately ? 1 : 0, record.withheld ? 1 : 0,
          record.privateQuestionId ?? null,
        );
        const insert = db.query(`INSERT INTO app_release_items (request_id, position, source, title, tier, corpus_id, provider, provider_item_id, provider_conversation_id, locator)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        // Read in this write: a receipt built before its item became Secret keeps no name.
        const secret = db.query(`SELECT 1 FROM app_release_secret_items
          WHERE provider = ? AND provider_item_id = ? AND (provider_conversation_id = '' OR ? = '' OR provider_conversation_id = ?) LIMIT 1`);
        record.items.slice(0, MAX_ITEMS_PER_REQUEST).forEach((item, position) => {
          const named = !(item.provider && item.providerItemId && secret.get(item.provider, item.providerItemId, item.providerConversationId ?? '', item.providerConversationId ?? ''));
          insert.run(id, position, item.source, named ? item.title ?? null : null, item.tier, item.corpusId ?? null, item.provider ?? null,
            item.providerItemId ?? null, item.providerConversationId ?? null, named ? item.locator ?? null : null);
        });
      })();
      expire();
      return id;
    },
    list() {
      expire();
      const requests = db.query(`SELECT id, at, connection_name, connection_kind, question, held_back, answered_privately, withheld
        FROM app_release_requests ORDER BY at DESC, rowid DESC LIMIT ?`).all(LIST_LIMIT) as Array<{
        id: string; at: number; connection_name: string; connection_kind: string; question: string;
        held_back: number; answered_privately: number; withheld: number;
      }>;
      const items = db.query('SELECT position, source, title, tier, made_private FROM app_release_items WHERE request_id = ? ORDER BY position');
      return requests.map((row) => ({
        id: row.id,
        at: row.at,
        connection: { name: row.connection_name, kind: row.connection_kind === 'agent' ? 'agent' as const : 'app' as const },
        question: row.question,
        heldBack: row.held_back,
        answeredPrivately: row.answered_privately === 1,
        withheld: row.withheld === 1,
        items: (items.all(row.id) as Array<{ position: number; source: string; title: string | null; tier: string; made_private: number }>).map((item) => ({
          position: item.position,
          source: item.source,
          ...(item.title ? { title: item.title } : {}),
          tier: item.tier === 'public' || item.tier === 'personal' ? item.tier : 'private' as const,
          madePrivate: item.made_private === 1,
        })),
      }));
    },
    retentionDays,
    setRetentionDays(days) {
      if (!isAppReleaseRetentionDays(days)) throw new TypeError('Retention must be 7, 30, 90 or 0 days.');
      db.query('INSERT INTO app_release_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(RETENTION_KEY, String(days));
      expire();
    },
    clear,
    item(requestId, position) {
      const row = db.query(`SELECT source, title, tier, corpus_id, provider, provider_item_id, provider_conversation_id, locator, made_private
        FROM app_release_items WHERE request_id = ? AND position = ?`).get(requestId, position) as {
        source: string; title: string | null; tier: string; corpus_id: string | null; provider: string | null;
        provider_item_id: string | null; provider_conversation_id: string | null; locator: string | null; made_private: number;
      } | null;
      if (!row) return undefined;
      return {
        source: row.source,
        ...(row.title ? { title: row.title } : {}),
        tier: row.tier === 'public' || row.tier === 'personal' ? row.tier : 'private',
        ...(row.corpus_id ? { corpusId: row.corpus_id } : {}),
        ...(row.provider ? { provider: row.provider } : {}),
        ...(row.provider_item_id ? { providerItemId: row.provider_item_id } : {}),
        ...(row.provider_conversation_id ? { providerConversationId: row.provider_conversation_id } : {}),
        ...(row.locator ? { locator: row.locator } : {}),
        madePrivate: row.made_private === 1,
      };
    },
    markMadePrivate(requestId, position) {
      db.query('UPDATE app_release_items SET made_private = 1 WHERE request_id = ? AND position = ?').run(requestId, position);
    },
    markAnsweredPrivately(privateQuestionId) {
      return db.query('UPDATE app_release_requests SET answered_privately = 1 WHERE private_question_id = ? AND answered_privately = 0').run(privateQuestionId).changes;
    },
    forgetCorpora(corpusIds, dryRun) {
      if (corpusIds.length === 0) return 0;
      const marks = corpusIds.map(() => '?').join(', ');
      if (dryRun) return (db.query(`SELECT COUNT(*) AS n FROM app_release_items WHERE corpus_id IN (${marks})`).get(...corpusIds) as { n: number }).n;
      return db.query(`DELETE FROM app_release_items WHERE corpus_id IN (${marks})`).run(...corpusIds).changes;
    },
    forgetSecretItem(item, options = {}) {
      const conversation = item.providerConversationId ?? '';
      return db.transaction(() => {
        if (options.proceed && !options.proceed()) return 0;
        db.query(`INSERT OR IGNORE INTO app_release_secret_items (provider, provider_item_id, provider_conversation_id, redacted_at)
          VALUES (?, ?, ?, ?)`).run(item.provider, item.providerItemId, conversation, now());
        return db.query(`UPDATE app_release_items SET title = NULL, locator = NULL
          WHERE provider = ? AND provider_item_id = ? AND (? = '' OR provider_conversation_id IS NULL OR provider_conversation_id = ?)
            AND (title IS NOT NULL OR locator IS NOT NULL)`).run(item.provider, item.providerItemId, conversation, conversation).changes;
      }).immediate();
    },
    retireSecretItem(item, options = {}) {
      db.transaction(() => {
        if (options.stillSecret?.()) return;
        db.query('DELETE FROM app_release_secret_items WHERE provider = ? AND provider_item_id = ?').run(item.provider, item.providerItemId);
      }).immediate();
    },
    close() {
      if (registered) {
        registered = false;
        const count = (openLogPaths.get(dbPath) ?? 1) - 1;
        if (count > 0) openLogPaths.set(dbPath, count);
        else openLogPaths.delete(dbPath);
      }
      closeSqliteStore(db);
    },
  };
}

/**
 * Forgets the rows of a deleted source's corpora (core/source-forget-registry.ts).
 * A request left with no item keeps its question and counts; its titles go.
 */
export function forgetAppReleaseItems(dbPath: string, selector: { corpusIds: readonly string[] }, options: { dryRun?: boolean } = {}): number {
  if (!existsSync(dbPath) || selector.corpusIds.length === 0) return 0;
  const store = openAppReleaseLog(dbPath);
  try {
    return store.forgetCorpora(selector.corpusIds, options.dryRun === true);
  } finally {
    store.close();
  }
}

/**
 * Forgets a Secret item's names in one log (workers/connector-store/secrets-disposition.ts).
 * A log that does not exist is not created: it holds no name. The rows cleared.
 */
export function forgetSecretAppReleaseItem(dbPath: string, item: AppReleaseSecretItem, options: { proceed?: () => boolean } = {}): number {
  if (!existsSync(dbPath)) return 0;
  const store = openAppReleaseLog(dbPath);
  try {
    return store.forgetSecretItem(item, options);
  } finally {
    store.close();
  }
}

/** Retires a Secret item's marker in one log once the item left Secrets. */
export function retireSecretAppReleaseItem(
  dbPath: string,
  item: Omit<AppReleaseSecretItem, 'providerConversationId'>,
  options: { stillSecret?: () => boolean } = {},
): void {
  if (!existsSync(dbPath)) return;
  const store = openAppReleaseLog(dbPath);
  try {
    store.retireSecretItem(item, options);
  } finally {
    store.close();
  }
}

function migrations(): SqliteMigration[] {
  return [{
    version: 1,
    name: 'app_release_log',
    up(db) {
      db.exec(`
        CREATE TABLE app_release_requests (
          id TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          connection_id TEXT,
          connection_name TEXT NOT NULL,
          connection_kind TEXT NOT NULL,
          question TEXT NOT NULL,
          held_back INTEGER NOT NULL DEFAULT 0,
          answered_privately INTEGER NOT NULL DEFAULT 0,
          withheld INTEGER NOT NULL DEFAULT 0,
          private_question_id TEXT
        );
        CREATE INDEX app_release_requests_private_question ON app_release_requests (private_question_id);
        CREATE INDEX app_release_requests_at ON app_release_requests (at);
        CREATE TABLE app_release_items (
          request_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          source TEXT NOT NULL,
          title TEXT,
          tier TEXT NOT NULL,
          corpus_id TEXT,
          provider TEXT,
          provider_item_id TEXT,
          provider_conversation_id TEXT,
          locator TEXT,
          made_private INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (request_id, position)
        );
        CREATE INDEX app_release_items_corpus ON app_release_items (corpus_id);
        CREATE TABLE app_release_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
    },
  }, {
    version: 2,
    name: 'app_release_secret_items',
    up(db) {
      db.exec(`
        CREATE TABLE app_release_secret_items (
          provider TEXT NOT NULL,
          provider_item_id TEXT NOT NULL,
          provider_conversation_id TEXT NOT NULL DEFAULT '',
          redacted_at INTEGER NOT NULL,
          PRIMARY KEY (provider, provider_item_id, provider_conversation_id)
        );
        CREATE INDEX app_release_items_provider_item ON app_release_items (provider, provider_item_id);
      `);
    },
  }];
}

function hardenPrivatePath(dbPath: string): void {
  if (!isAbsolute(dbPath)) throw new TypeError('The AI apps log path must be absolute.');
  const leafDir = dirname(dbPath);
  if (new Set(['/', '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', homedir()]).has(leafDir)) {
    throw new Error('The AI apps log must live inside a dedicated private directory.');
  }
  mkdirSync(leafDir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(leafDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('The AI apps log must live in a real private directory.');
  chmodSync(leafDir, 0o700);
  if (existsSync(dbPath)) {
    const fileStat = lstatSync(dbPath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error('The AI apps log must be a regular file, not a symlink.');
  }
}

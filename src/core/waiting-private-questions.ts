/**
 * Waiting private questions: a question whose Private part no panel showed
 * waits here, on this computer, until the person answers it in Olympus or a
 * panel acknowledges it. Design docs/design/background-agents.md, section A.
 *
 * What a record holds: the question (at most 2 KB), the stable connection id
 * and surface that asked, when, the detail level, the request's retrieval
 * selectors (bounded; a request whose selectors do not fit is not recorded,
 * so a replay never silently widens the search), a generation, its state
 * (`waiting`: Private items matched; `unchecked`: the local match probe could
 * not tell, "couldn't check yet") and whether the person has seen it. Never
 * evidence, answers, match counts, job ids or citation tokens.
 *
 * Bounds: deduplicated by connection, selectors and normalized question (a
 * duplicate refreshes the time, keeps the fuller detail level and bumps the
 * generation); 20 per connection, 50 in all and 256 KB in all, the oldest
 * dropped with a persisted "older questions were removed" marker; 7 days.
 * Dismiss deletes; the same question asked again comes back.
 *
 * Revocation: revoking a connection deletes its records and bumps that
 * connection's revocation generation in one transaction. A recording carries
 * the generation it read when its request began (`ticket`) and is refused,
 * inside its own write transaction, when the generation has moved, so an
 * insert in flight across a revocation never lands.
 *
 * Acknowledgment: a sealed panel answer carries a capability bound to a
 * record's id, generation and connection (private-answer-jobs.ts); the record
 * is deleted only when all three still match (one atomic DELETE), so an older
 * answer never clears a newer duplicate. A lost acknowledgment leaves the
 * question waiting.
 *
 * Storage: one SQLite file beside the remote-connections database, in the
 * same owner-only (0700) data directory, the file itself 0600, with
 * secure_delete on, like the other private stores. It is never indexed (no
 * connector reads Olympus's own data directory), carries no telemetry (no log
 * line here holds a question), is left out of data exports (named as skipped,
 * data-lifecycle.ts) and is deleted with the connections on `delete --all`.
 * It is served only through this module's functions; no HTTP route reads it.
 *
 * Plain functions over a factory, not a class: this module is reachable from
 * the bundled CLI, and class-field initializers balloon the committed dist/.
 */
import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { assertSqliteSchemaCanOpen, runSqliteMigrations, type SqliteMigration } from './sqlite-migrations.ts';
import { closeSqliteStore } from './sqlite-store.ts';

export const WAITING_PRIVATE_QUESTIONS_STORE_ID = 'waiting-private-questions';
export const WAITING_PRIVATE_QUESTIONS_SCHEMA_VERSION = 1;
export const WAITING_PRIVATE_QUESTIONS_FILE_NAME = 'waiting-private-questions.sqlite';

export const WAITING_QUESTION_LIMITS = Object.freeze({
  /** UTF-8 bytes of the question. */
  questionBytes: 2_048,
  /** UTF-8 bytes of the serialized retrieval selectors (selected items can be long). */
  selectorBytes: 4_096,
  perConnection: 20,
  total: 50,
  /** Every record's question and selectors together, plus a fixed allowance per record. */
  totalBytes: 256 * 1024,
  ttlMs: 7 * 24 * 60 * 60_000,
});
/** The fixed per-record allowance in the byte total (ids, times, enums). */
const RECORD_OVERHEAD_BYTES = 160;
const STORE_BUSY_TIMEOUT_MS = 5_000;
const OLDER_REMOVED_KEY = 'older_removed_at';

/** `waiting`: Private items matched. `unchecked`: the local probe could not tell yet. */
export type WaitingQuestionState = 'waiting' | 'unchecked';
/** Which surface asked: the ChatGPT surface (one bit) or another remote agent (summary rule). */
export type WaitingQuestionSurface = 'chatgpt' | 'remote';
export type WaitingQuestionDetail = 'summary' | 'full';

/**
 * A request's retrieval selectors, as a source_answer request names them
 * (source-index/answer-types.ts SourceIndexAnswerRequest). Replaying a
 * question uses exactly these, never a wider search.
 */
export interface WaitingQuestionSelectors {
  query?: string;
  account?: string;
  corpus_ids?: string[];
  approved_scope_key?: string;
  chat_scope?: string;
  conversation_id?: string;
  sender_id?: string;
  sender_label?: string;
  authored_after?: string;
  authored_before?: string;
  selected_items?: Array<Record<string, string>>;
}

const SELECTOR_TEXT_FIELDS = [
  'query', 'account', 'approved_scope_key', 'chat_scope', 'conversation_id',
  'sender_id', 'sender_label', 'authored_after', 'authored_before',
] as const;
/** The fields of a selected item that are kept (answer-types.ts SourceAnswerSelectedItem). */
const SELECTED_ITEM_FIELDS = [
  'corpus_id', 'family', 'provider', 'account_scope', 'provider_item_id', 'local_item_id',
  'provider_thread_id', 'provider_conversation_id', 'provider_file_id', 'source_version',
  'title', 'conversation_label', 'author_label', 'uri', 'authored_at', 'updated_at',
] as const;

export interface WaitingQuestion {
  id: string;
  connectionId: string;
  surface: WaitingQuestionSurface;
  question: string;
  detail: WaitingQuestionDetail;
  selectors: WaitingQuestionSelectors;
  state: WaitingQuestionState;
  seen: boolean;
  generation: number;
  /** ISO time of the latest ask. */
  askedAt: string;
}

/** The revocation generation a request read when it began; a recording is refused if it has moved. */
export interface WaitingQuestionTicket {
  readonly connectionId: string;
  readonly revocation: number;
}

/** One record at one generation: what an acknowledgment or a re-check names. */
export interface WaitingQuestionRef {
  readonly id: string;
  readonly generation: number;
  readonly connectionId: string;
}

export interface WaitingQuestionInput {
  question: string;
  surface: WaitingQuestionSurface;
  state: WaitingQuestionState;
  detail?: WaitingQuestionDetail;
  /** Already normalized (normalizeWaitingSelectors); absent or empty is "no selectors". */
  selectors?: WaitingQuestionSelectors;
}

export interface WaitingQuestionStore {
  readonly dbPath: string;
  /** Reads the connection's revocation generation; call it when the request begins. */
  ticket(connectionId: string): WaitingQuestionTicket;
  /**
   * Records (or refreshes) a waiting question. Undefined when it is refused:
   * the connection was revoked since the ticket, the question or selectors do
   * not fit their bounds, or the input is malformed.
   */
  record(ticket: WaitingQuestionTicket, input: WaitingQuestionInput): WaitingQuestionRef | undefined;
  /** Newest first, expired records dropped; `olderRemoved` while the marker stands. */
  list(): { questions: WaitingQuestion[]; olderRemoved: boolean };
  get(id: string): WaitingQuestion | undefined;
  dismiss(id: string): boolean;
  /** Deletes every record and the "older questions were removed" marker. */
  dismissAll(): number;
  markSeen(ids: readonly string[]): number;
  /** Deletes the record only if its id, generation and connection all still match. */
  acknowledge(ref: WaitingQuestionRef): boolean;
  /** A re-check's verdict for an `unchecked` record at this generation: `waiting`, or deleted (no match). */
  settleUnchecked(ref: WaitingQuestionRef, verdict: 'match' | 'no_match'): boolean;
  /** Records still `unchecked`, oldest first. */
  unchecked(): WaitingQuestion[];
  /** Deletes the connection's records and bumps its revocation generation, in one transaction. */
  revokeConnection(connectionId: string): number;
  /** Revokes (as above) every connection with records that `isActive` does not vouch for. */
  reconcileConnections(isActive: (connectionId: string) => boolean): number;
  close(): void;
}

interface QuestionRow {
  id: string;
  dedupe_key: string;
  connection_id: string;
  surface: string;
  question: string;
  detail: string;
  selectors: string;
  state: string;
  seen: number;
  generation: number;
  asked_at: number;
}

/** Where the store lives: beside the remote-connections database, in its private directory. */
export function waitingPrivateQuestionsDbPath(remoteConnectionsDbPath: string): string {
  return join(dirname(remoteConnectionsDbPath), WAITING_PRIVATE_QUESTIONS_FILE_NAME);
}

/** The question as the dedupe key reads it: case, width forms and spacing aside. */
export function normalizeWaitingQuestion(question: string): string {
  return question.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/**
 * The retrieval selectors of a source_answer request, field by field: every
 * other field (the question, analyst choice, tier flags, limits, timeouts) is
 * dropped. Undefined when a selector is malformed (a non-string where a
 * string belongs), so the caller records nothing rather than a wider search.
 */
export function normalizeWaitingSelectors(raw: Readonly<Record<string, unknown>>): WaitingQuestionSelectors | undefined {
  const out: WaitingQuestionSelectors = {};
  for (const field of SELECTOR_TEXT_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed) out[field] = trimmed;
  }
  const corpora: string[] = [];
  if (raw.corpus_id !== undefined) {
    if (typeof raw.corpus_id !== 'string') return undefined;
    if (raw.corpus_id.trim()) corpora.push(raw.corpus_id.trim());
  }
  if (raw.corpus_ids !== undefined) {
    if (!Array.isArray(raw.corpus_ids) || raw.corpus_ids.some((id) => typeof id !== 'string')) return undefined;
    for (const id of raw.corpus_ids as string[]) if (id.trim()) corpora.push(id.trim());
  }
  if (corpora.length > 0) out.corpus_ids = [...new Set(corpora)].sort();
  if (raw.selected_items !== undefined) {
    if (!Array.isArray(raw.selected_items)) return undefined;
    const items: Array<Record<string, string>> = [];
    for (const entry of raw.selected_items) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
      const item: Record<string, string> = {};
      for (const field of SELECTED_ITEM_FIELDS) {
        const value = (entry as Record<string, unknown>)[field];
        if (value === undefined) continue;
        if (typeof value !== 'string') return undefined;
        item[field] = value;
      }
      items.push(item);
    }
    if (items.length > 0) out.selected_items = items;
  }
  return out;
}

/** Selectors serialized with sorted keys, so the same selectors always dedupe together. */
function canonicalSelectors(selectors: WaitingQuestionSelectors | undefined): string {
  return JSON.stringify(sortKeys(selectors ?? {}));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function openWaitingPrivateQuestionStore(
  dbPath: string,
  options: { now?: () => number } = {},
): WaitingQuestionStore {
  const now = options.now ?? Date.now;
  hardenPrivatePath(dbPath);
  const db = new Database(dbPath, { create: true });
  try {
    chmodSync(dbPath, 0o600);
    db.exec(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS}; PRAGMA secure_delete = ON; PRAGMA journal_mode = WAL;`);
    assertSqliteSchemaCanOpen(db, WAITING_PRIVATE_QUESTIONS_STORE_ID, WAITING_PRIVATE_QUESTIONS_SCHEMA_VERSION);
    runSqliteMigrations(db, WAITING_PRIVATE_QUESTIONS_STORE_ID, migrations());
  } catch (error) {
    closeSqliteStore(db);
    throw error;
  }

  const revocationOf = (connectionId: string): number => {
    const row = db.query('SELECT generation FROM connection_revocations WHERE connection_id = ?').get(connectionId) as { generation: number } | null;
    return row?.generation ?? 0;
  };

  const expire = (at: number): void => {
    db.query('DELETE FROM waiting_questions WHERE asked_at <= ?').run(at - WAITING_QUESTION_LIMITS.ttlMs);
    const marker = db.query('SELECT value FROM waiting_meta WHERE key = ?').get(OLDER_REMOVED_KEY) as { value: string } | null;
    if (marker && Number(marker.value) <= at - WAITING_QUESTION_LIMITS.ttlMs) {
      db.query('DELETE FROM waiting_meta WHERE key = ?').run(OLDER_REMOVED_KEY);
    }
  };

  const markOlderRemoved = (at: number): void => {
    db.query('INSERT INTO waiting_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(OLDER_REMOVED_KEY, String(at));
  };

  /** Drops the oldest records beyond the per-connection, total and byte bounds. */
  const enforceBounds = (connectionId: string, at: number): void => {
    let removed = 0;
    const perConnection = db.query('SELECT id FROM waiting_questions WHERE connection_id = ? ORDER BY asked_at DESC, rowid DESC').all(connectionId) as Array<{ id: string }>;
    for (const row of perConnection.slice(WAITING_QUESTION_LIMITS.perConnection)) {
      removed += db.query('DELETE FROM waiting_questions WHERE id = ?').run(row.id).changes;
    }
    const all = db.query(`
      SELECT id, LENGTH(CAST(question AS BLOB)) + LENGTH(CAST(selectors AS BLOB)) AS bytes
      FROM waiting_questions ORDER BY asked_at DESC, rowid DESC
    `).all() as Array<{ id: string; bytes: number }>;
    let total = 0;
    all.forEach((row, index) => {
      total += row.bytes + RECORD_OVERHEAD_BYTES;
      if (index >= WAITING_QUESTION_LIMITS.total || total > WAITING_QUESTION_LIMITS.totalBytes) {
        removed += db.query('DELETE FROM waiting_questions WHERE id = ?').run(row.id).changes;
      }
    });
    if (removed > 0) markOlderRemoved(at);
  };

  const revokeInTransaction = (connectionId: string): number => {
    const removed = db.query('DELETE FROM waiting_questions WHERE connection_id = ?').run(connectionId).changes;
    db.query(`
      INSERT INTO connection_revocations (connection_id, generation) VALUES (?, 1)
      ON CONFLICT(connection_id) DO UPDATE SET generation = generation + 1
    `).run(connectionId);
    return removed;
  };

  return {
    dbPath,

    ticket(connectionId: string): WaitingQuestionTicket {
      return { connectionId, revocation: revocationOf(connectionId) };
    },

    record(ticket: WaitingQuestionTicket, input: WaitingQuestionInput): WaitingQuestionRef | undefined {
      const question = typeof input.question === 'string' ? input.question.trim() : '';
      if (!question || utf8Length(question) > WAITING_QUESTION_LIMITS.questionBytes) return undefined;
      if (typeof ticket.connectionId !== 'string' || !ticket.connectionId) return undefined;
      if (input.surface !== 'chatgpt' && input.surface !== 'remote') return undefined;
      if (input.state !== 'waiting' && input.state !== 'unchecked') return undefined;
      const selectors = canonicalSelectors(input.selectors);
      if (utf8Length(selectors) > WAITING_QUESTION_LIMITS.selectorBytes) return undefined;
      const detail: WaitingQuestionDetail = input.detail === 'full' ? 'full' : 'summary';
      const dedupeKey = createHash('sha256')
        .update(JSON.stringify([ticket.connectionId, selectors, normalizeWaitingQuestion(question)]))
        .digest('hex');
      const at = now();
      return db.transaction((): WaitingQuestionRef | undefined => {
        // A revocation since the request began: refused, inside the same
        // write lock the revocation takes, so it cannot interleave.
        if (revocationOf(ticket.connectionId) !== ticket.revocation) return undefined;
        expire(at);
        const existing = db.query('SELECT * FROM waiting_questions WHERE dedupe_key = ?').get(dedupeKey) as QuestionRow | null;
        let ref: WaitingQuestionRef;
        if (existing) {
          const generation = existing.generation + 1;
          db.query(`
            UPDATE waiting_questions
            SET question = ?, detail = ?, state = ?, seen = 0, generation = ?, asked_at = ?
            WHERE id = ?
          `).run(
            question,
            existing.detail === 'full' || detail === 'full' ? 'full' : 'summary',
            existing.state === 'waiting' || input.state === 'waiting' ? 'waiting' : 'unchecked',
            generation,
            at,
            existing.id,
          );
          ref = { id: existing.id, generation, connectionId: ticket.connectionId };
        } else {
          const id = randomBytes(16).toString('base64url');
          db.query(`
            INSERT INTO waiting_questions
              (id, dedupe_key, connection_id, surface, question, detail, selectors, state, seen, generation, asked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)
          `).run(id, dedupeKey, ticket.connectionId, input.surface, question, detail, selectors, input.state, at);
          ref = { id, generation: 1, connectionId: ticket.connectionId };
        }
        enforceBounds(ticket.connectionId, at);
        // The bounds may have dropped this very record (a single oversized total cannot, but stay exact).
        return db.query('SELECT 1 FROM waiting_questions WHERE id = ?').get(ref.id) ? ref : undefined;
      }).immediate();
    },

    list() {
      const at = now();
      return db.transaction(() => {
        expire(at);
        const rows = db.query('SELECT * FROM waiting_questions ORDER BY asked_at DESC, rowid DESC').all() as QuestionRow[];
        const marker = db.query('SELECT value FROM waiting_meta WHERE key = ?').get(OLDER_REMOVED_KEY);
        return { questions: rows.map(toQuestion), olderRemoved: marker !== null };
      }).immediate();
    },

    get(id: string): WaitingQuestion | undefined {
      if (typeof id !== 'string') return undefined;
      const row = db.query('SELECT * FROM waiting_questions WHERE id = ? AND asked_at > ?').get(id, now() - WAITING_QUESTION_LIMITS.ttlMs) as QuestionRow | null;
      return row ? toQuestion(row) : undefined;
    },

    dismiss(id: string): boolean {
      if (typeof id !== 'string') return false;
      return db.query('DELETE FROM waiting_questions WHERE id = ?').run(id).changes > 0;
    },

    dismissAll(): number {
      return db.transaction(() => {
        const removed = db.query('DELETE FROM waiting_questions').run().changes;
        db.query('DELETE FROM waiting_meta WHERE key = ?').run(OLDER_REMOVED_KEY);
        return removed;
      }).immediate();
    },

    markSeen(ids: readonly string[]): number {
      let changed = 0;
      db.transaction(() => {
        for (const id of ids) {
          if (typeof id === 'string') changed += db.query('UPDATE waiting_questions SET seen = 1 WHERE id = ? AND seen = 0').run(id).changes;
        }
      }).immediate();
      return changed;
    },

    acknowledge(ref: WaitingQuestionRef): boolean {
      // One statement: the compare and the delete cannot be separated.
      return db.query('DELETE FROM waiting_questions WHERE id = ? AND generation = ? AND connection_id = ?')
        .run(ref.id, ref.generation, ref.connectionId).changes > 0;
    },

    settleUnchecked(ref: WaitingQuestionRef, verdict: 'match' | 'no_match'): boolean {
      const where = "id = ? AND generation = ? AND connection_id = ? AND state = 'unchecked'";
      return verdict === 'match'
        ? db.query(`UPDATE waiting_questions SET state = 'waiting' WHERE ${where}`).run(ref.id, ref.generation, ref.connectionId).changes > 0
        : db.query(`DELETE FROM waiting_questions WHERE ${where}`).run(ref.id, ref.generation, ref.connectionId).changes > 0;
    },

    unchecked(): WaitingQuestion[] {
      const rows = db.query("SELECT * FROM waiting_questions WHERE state = 'unchecked' AND asked_at > ? ORDER BY asked_at ASC, rowid ASC")
        .all(now() - WAITING_QUESTION_LIMITS.ttlMs) as QuestionRow[];
      return rows.map(toQuestion);
    },

    revokeConnection(connectionId: string): number {
      if (typeof connectionId !== 'string' || !connectionId) return 0;
      return db.transaction(() => revokeInTransaction(connectionId)).immediate();
    },

    reconcileConnections(isActive: (connectionId: string) => boolean): number {
      const ids = (db.query('SELECT DISTINCT connection_id FROM waiting_questions').all() as Array<{ connection_id: string }>)
        .map((row) => row.connection_id)
        .filter((id) => !isActive(id));
      if (ids.length === 0) return 0;
      return db.transaction(() => ids.reduce((sum, id) => sum + revokeInTransaction(id), 0)).immediate();
    },

    close(): void {
      closeSqliteStore(db);
    },
  };
}

/**
 * Deletes a revoked connection's waiting questions and bumps its revocation
 * generation, opening the store beside the connections database. Called by
 * the connection store's revoke, in whichever process revokes (the worker's
 * Agents page or the CLI). Best effort for the caller: a failure here never
 * undoes or fails the revocation itself; the worker also reconciles the
 * store against the live connection list before it serves it.
 */
export function revokeWaitingPrivateQuestions(remoteConnectionsDbPath: string, connectionId: string): void {
  const store = openWaitingPrivateQuestionStore(waitingPrivateQuestionsDbPath(remoteConnectionsDbPath));
  try {
    store.revokeConnection(connectionId);
  } finally {
    store.close();
  }
}

function toQuestion(row: QuestionRow): WaitingQuestion {
  let selectors: WaitingQuestionSelectors = {};
  try {
    const parsed = JSON.parse(row.selectors) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) selectors = parsed as WaitingQuestionSelectors;
  } catch {
    selectors = {};
  }
  return {
    id: row.id,
    connectionId: row.connection_id,
    surface: row.surface === 'chatgpt' ? 'chatgpt' : 'remote',
    question: row.question,
    detail: row.detail === 'full' ? 'full' : 'summary',
    selectors,
    state: row.state === 'waiting' ? 'waiting' : 'unchecked',
    seen: row.seen === 1,
    generation: row.generation,
    askedAt: new Date(row.asked_at).toISOString(),
  };
}

function migrations(): SqliteMigration[] {
  return [{
    version: 1,
    name: 'create_waiting_private_questions',
    up(db) {
      db.exec(`
        CREATE TABLE waiting_questions (
          id TEXT PRIMARY KEY,
          dedupe_key TEXT NOT NULL UNIQUE,
          connection_id TEXT NOT NULL,
          surface TEXT NOT NULL CHECK(surface IN ('chatgpt', 'remote')),
          question TEXT NOT NULL,
          detail TEXT NOT NULL CHECK(detail IN ('summary', 'full')),
          selectors TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('waiting', 'unchecked')),
          seen INTEGER NOT NULL DEFAULT 0,
          generation INTEGER NOT NULL,
          asked_at INTEGER NOT NULL
        );
        CREATE INDEX waiting_questions_connection ON waiting_questions (connection_id, asked_at);
        CREATE TABLE connection_revocations (
          connection_id TEXT PRIMARY KEY,
          generation INTEGER NOT NULL
        );
        CREATE TABLE waiting_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  }];
}

function hardenPrivatePath(dbPath: string): void {
  if (!isAbsolute(dbPath)) throw new TypeError('The waiting private questions database path must be absolute.');
  const leafDir = dirname(dbPath);
  if (new Set(['/', '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', homedir()]).has(leafDir)) {
    throw new Error('The waiting private questions database must live inside a dedicated private directory.');
  }
  mkdirSync(leafDir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(leafDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error('The waiting private questions database must live in a real private directory.');
  }
  chmodSync(leafDir, 0o700);
  if (existsSync(dbPath)) {
    const fileStat = lstatSync(dbPath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error('The waiting private questions database must be a regular file, not a symlink.');
    }
  }
}

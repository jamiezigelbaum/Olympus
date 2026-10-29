/**
 * Private answers inbox, worker private state (owner decision 2026-10-14).
 * Questions retain their exact bounded selectors; v4 also retains anonymous
 * replies with the exact sent text and an explicit path. A v2 migration adds local
 * answer text, citation locators, content-free source identities, answered-at
 * and read/unread. Unanswered rows keep the original 20/connection, 50 total,
 * 256 KB and seven-day bounds. Answered rows stay until deletion, including
 * while re-answering after eligibility changes, subject to 50 rows / 1 MiB per
 * connection and 500 rows / 16 MiB global storage safety limits; each answer is at most 128 KiB.
 *
 * Every completion/retry/invalidation compares id, generation and connection.
 * Revocation deletes that connection's rows and bumps its recording ticket;
 * stale work cannot restore deleted/reasked rows. The panel's sealed ack
 * deletes only the generation it rendered. Local reading marks read; it does
 * not delete. Source deletion removes dependent answers and all pending
 * questions (whose dependencies are not known yet).
 *
 * SQLite lives beside remote connections, directory 0700/file 0600, with
 * secure_delete and DELETE journaling so deletion leaves no WAL history.
 * No connector indexes worker state. Excluded from telemetry, support
 * bundles, export and shared dashboard JSON; served only through the local
 * control route. delete --all removes the database and sidecars.
 * Plain factory closures: class-field initializers inflate native dist.
 */
import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { assertSqliteSchemaCanOpen, runSqliteMigrations, type SqliteMigration } from './sqlite-migrations.ts';
import { closeSqliteStore } from './sqlite-store.ts';
import { SHARED_DATA_FILES } from './olympus-layout.ts';

export const WAITING_PRIVATE_QUESTIONS_STORE_ID = 'waiting-private-questions';
export const WAITING_PRIVATE_QUESTIONS_SCHEMA_VERSION = 5;

export const WAITING_QUESTION_LIMITS = Object.freeze({
  /** UTF-8 bytes of the question. */
  questionBytes: 2_048,
  /** Existing on-computer box: up to 2,000 characters, including multibyte text. */
  localQuestionBytes: 8 * 1024,
  /** UTF-8 bytes of the serialized retrieval selectors (selected items can be long). */
  selectorBytes: 4_096,
  // No count, byte or rate limit on how many questions are asked or kept (owner ruling, 2026-10-29):
  // the inbox holds them all. Only each item's own size is bounded.
  answerBytes: 128 * 1024,
  ttlMs: 7 * 24 * 60 * 60_000,
  /** A re-ask within this of the answer is the same ask (an app retrying); after it, the question is answered afresh. */
  reanswerAfterMs: 10 * 60_000,
});
const STORE_BUSY_TIMEOUT_MS = 5_000;
/** The revoking process's cleanup waits at most this long for the lock; the worker retries it. */
const REVOKE_BUSY_TIMEOUT_MS = 1_000;
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
  /**
   * The effective retrieval mode: the request's own, or hybrid (the answer
   * handler's default) when it named none. Always set on a normalized record,
   * so the probe, the dedupe key and every retry search the same way.
   */
  retrieval_mode?: 'keyword' | 'hybrid';
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

/** Answer text and citation locators only; evidence identities contain no source text. */
export interface StoredPrivateAnswer {
  status: 'answered' | 'not_found' | 'withdrawn';
  reason?: string;
  answer?: string;
  citations: Array<{ title?: string; source?: string; date?: string; url?: string; localPath?: string }>;
  sentItems?: Array<{ title?: string; source?: string; date?: string }>;
  unanswered: string[];
  leftOut: string[];
  read: readonly Readonly<Record<string, unknown>>[];
}

export const CHATGPT_INBOX_GRACE_MS = 30_000;

export interface WaitingQuestion {
  path?: 'private' | 'anonymous' | 'venice';
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
  result?: StoredPrivateAnswer;
  /** Metadata listings omit bodies but retain their presence. */
  hasResult?: boolean;
  answeredAt?: string;
  attempts: number;
  nextAttemptAt: number;
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
  /** Explicit local asks retain each reply; agent Private matches keep their dedupe. */
  retainEachAsk?: boolean;
  path?: 'private' | 'anonymous' | 'venice';
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
  list(options?: { includeResults?: boolean }): { questions: WaitingQuestion[]; olderRemoved: boolean };
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
  /** Generation fences every completion, retry and invalidation against delete/revoke/re-ask. */
  subscribe(listener: () => void): () => void;
  markRead(ref: WaitingQuestionRef): boolean;
  saveAnswer(ref: WaitingQuestionRef, result: StoredPrivateAnswer, sent?: string): boolean;
  retry(ref: WaitingQuestionRef): boolean;
  invalidate(ref: WaitingQuestionRef): boolean;
  /**
   * Source deletion also clears pending questions, whose dependencies are not
   * yet known; `answeredOnly` keeps them and takes only answers.
   */
  deleteForCorpora(corpusIds: readonly string[], knownCorpusIds?: readonly string[], options?: { answeredOnly?: boolean }): number;
  /**
   * One account scope's items going (an imported archive being removed):
   * only the answers that positively read one of them, from one of these
   * corpora with a source item of this provider and scope, are deleted.
   * Questions still waiting read nothing yet and stay, as does an answer
   * whose evidence cannot be placed: each answer's sources are checked
   * again before it is saved or shown, so one that read a removed item is
   * withdrawn then.
   */
  deleteForAccountScope(input: { provider: string; accountScope: string; corpusIds: readonly string[] }): number;
  close(): void;
}

interface QuestionRow {
  answer_path: string;
  destination: string | null;
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
  result: string | null;
  has_result?: number;
  answered_at: number | null;
  attempts: number;
  next_attempt_at: number;
}

/** Where the store lives: beside the remote-connections database, in its private directory. */
export function waitingPrivateQuestionsDbPath(remoteConnectionsDbPath: string): string {
  return join(dirname(remoteConnectionsDbPath), SHARED_DATA_FILES['waiting-private-questions']);
}

/** The question as the dedupe key reads it: case, width forms and spacing aside. */
export function normalizeWaitingQuestion(question: string): string {
  return question.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/**
 * The retrieval selectors of a source_answer request, field by field: every
 * other field (the question, analyst choice, tier flags, limits, timeouts) is
 * dropped. The retrieval mode is kept as the answer resolves it (hybrid when
 * absent). Undefined when a selector is malformed (a non-string where a
 * string belongs, an unknown retrieval mode), so the caller records nothing
 * rather than a different search.
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
  const mode = raw.retrieval_mode ?? 'hybrid';
  if (mode !== 'keyword' && mode !== 'hybrid') return undefined;
  out.retrieval_mode = mode;
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

export interface WaitingQuestionStoreOptions {
  now?: () => number;
  busyTimeoutMs?: number;
  /**
   * Whether a connection is active now (the connection store's word). A
   * recording for a connection it does not vouch for, or when it throws, is
   * refused, and that connection's records are removed.
   */
  isActive?: (connectionId: string) => boolean;
}

export function openWaitingPrivateQuestionStore(
  dbPath: string,
  options: WaitingQuestionStoreOptions = {},
): WaitingQuestionStore {
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  const notify = () => queueMicrotask(() => { for (const listener of listeners) listener(); });
  hardenPrivatePath(dbPath);
  const db = new Database(dbPath, { create: true });
  try {
    chmodSync(dbPath, 0o600);
    const busyTimeoutMs = Math.max(0, Math.floor(options.busyTimeoutMs ?? STORE_BUSY_TIMEOUT_MS));
    // A file left in WAL mode (by a build before 2026-10-12) leaves it here,
    // which needs the only connection; until then the store stays unopened.
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE;`);
    const mode = (db.query('PRAGMA journal_mode').get() as { journal_mode?: string } | null)?.journal_mode;
    if (mode !== 'delete') throw new Error('The waiting private questions store could not use its rollback journal yet.');
    // Under one write lock: two processes opening a new file at once (the
    // worker and the CLI) cannot both see version 0 and both migrate.
    db.transaction(() => {
      assertSqliteSchemaCanOpen(db, WAITING_PRIVATE_QUESTIONS_STORE_ID, WAITING_PRIVATE_QUESTIONS_SCHEMA_VERSION);
      runSqliteMigrations(db, WAITING_PRIVATE_QUESTIONS_STORE_ID, migrations());
    }).immediate();
  } catch (error) {
    closeSqliteStore(db);
    throw error;
  }

  const revocationOf = (connectionId: string): number => {
    const row = db.query('SELECT generation FROM connection_revocations WHERE connection_id = ?').get(connectionId) as { generation: number } | null;
    return row?.generation ?? 0;
  };

  const expire = (at: number): void => {
    db.query('DELETE FROM waiting_questions WHERE answered_at IS NULL AND asked_at <= ?').run(at - WAITING_QUESTION_LIMITS.ttlMs);

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
      if (!question || utf8Length(question) > (input.retainEachAsk ? WAITING_QUESTION_LIMITS.localQuestionBytes : WAITING_QUESTION_LIMITS.questionBytes)) return undefined;
      if (typeof ticket.connectionId !== 'string' || !ticket.connectionId) return undefined;
      if (input.surface !== 'chatgpt' && input.surface !== 'remote') return undefined;
      if (input.state !== 'waiting' && input.state !== 'unchecked') return undefined;
      const selectors = canonicalSelectors(input.selectors);
      if (utf8Length(selectors) > WAITING_QUESTION_LIMITS.selectorBytes) return undefined;
      const detail: WaitingQuestionDetail = input.detail === 'full' ? 'full' : 'summary';
      const dedupeKey = createHash('sha256')
        .update(JSON.stringify([ticket.connectionId, ...(input.path === 'anonymous' || input.retainEachAsk ? [input.path ?? 'private', randomBytes(16).toString('hex')] : []), selectors, normalizeWaitingQuestion(question)]))
        .digest('hex');
      const at = now();
      // The connection store's word now: a revocation whose own cleanup here
      // failed still refuses the recording, and the cleanup is done instead.
      let active = false;
      try {
        active = options.isActive ? options.isActive(ticket.connectionId) === true : true;
      } catch {
        return undefined;
      }
      if (!active) {
        db.transaction(() => revokeInTransaction(ticket.connectionId)).immediate();
        return undefined;
      }
      return db.transaction((): WaitingQuestionRef | undefined => {
        // A revocation since the request began: refused, inside the same
        // write lock the revocation takes, so it cannot interleave.
        if (revocationOf(ticket.connectionId) !== ticket.revocation) return undefined;
        expire(at);
        const existing = db.query('SELECT * FROM waiting_questions WHERE dedupe_key = ?').get(dedupeKey) as QuestionRow | null;
        let ref: WaitingQuestionRef;
        if (existing?.result && JSON.parse(existing.result).status === 'answered'
          && at - (existing.answered_at ?? at) < WAITING_QUESTION_LIMITS.reanswerAfterMs) {
          // Eligibility is checked at every read/open. An app retrying the
          // same ask keeps its answer. A later re-ask is answered afresh: a
          // retained answer from before a new build, new mail or a policy
          // change was handed back as current (live canary, 2026-10-29).
          db.query('UPDATE waiting_questions SET asked_at = ? WHERE id = ?').run(at, existing.id);
          return { id: existing.id, generation: existing.generation, connectionId: ticket.connectionId };
        }
        if (existing) {
          const generation = existing.generation + 1;
          db.query(`
            UPDATE waiting_questions
            SET question = ?, detail = ?, state = ?, seen = 0, generation = ?, asked_at = ?, result = NULL, answered_at = NULL, attempts = 0, next_attempt_at = 0
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
              (id, dedupe_key, connection_id, surface, question, detail, selectors, state, seen, generation, asked_at, answer_path, destination)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)
          `).run(id, dedupeKey, ticket.connectionId, input.surface, question, detail, selectors, input.state, at, input.path === 'anonymous' ? 'anonymous' : 'private', input.path === 'venice' ? 'venice' : null);
          ref = { id, generation: 1, connectionId: ticket.connectionId };
        }
        notify();
        return ref;
      }).immediate();
    },

    list(options) {
      // A normal poll takes no write lock. Erase expired private text only
      // when there is actually something to remove; omit bodies on tick/list.
      const at = now();
      if (db.query('SELECT 1 FROM waiting_questions WHERE answered_at IS NULL AND asked_at <= ? LIMIT 1')
        .get(at - WAITING_QUESTION_LIMITS.ttlMs)) expire(at);
      const columns = options?.includeResults === false
        ? 'id, connection_id, surface, answer_path, destination, question, detail, selectors, state, seen, generation, asked_at, answered_at, attempts, next_attempt_at, NULL AS result, result IS NOT NULL AS has_result'
        : '*';
      const rows = db.query(`SELECT ${columns} FROM waiting_questions WHERE answered_at IS NOT NULL OR asked_at > ? ORDER BY asked_at DESC, rowid DESC`)
        .all(now() - WAITING_QUESTION_LIMITS.ttlMs) as QuestionRow[];
      const marker = db.query('SELECT value FROM waiting_meta WHERE key = ?').get(OLDER_REMOVED_KEY);
      return { questions: rows.map(toQuestion), olderRemoved: marker !== null };
    },

    get(id: string): WaitingQuestion | undefined {
      if (typeof id !== 'string') return undefined;
      const row = db.query('SELECT * FROM waiting_questions WHERE id = ? AND (answered_at IS NOT NULL OR asked_at > ?)').get(id, now() - WAITING_QUESTION_LIMITS.ttlMs) as QuestionRow | null;
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
      notify();
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

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    markRead(ref) {
      return db.query('UPDATE waiting_questions SET seen = 1 WHERE id = ? AND generation = ? AND connection_id = ? AND result IS NOT NULL')
        .run(ref.id, ref.generation, ref.connectionId).changes > 0;
    },

    saveAnswer(ref, result, sent) {
      const serialized = JSON.stringify(result);
      if (utf8Length(serialized) + utf8Length(sent ?? '') > WAITING_QUESTION_LIMITS.answerBytes) return false;
      if (sent !== undefined && options.isActive) {
        try { if (!options.isActive(ref.connectionId)) return false; } catch { return false; }
      }
      return db.transaction(() => {
        const changed = db.query('UPDATE waiting_questions SET result = ?, answered_at = ?, question = COALESCE(?, question), seen = 0, attempts = 0, next_attempt_at = 0 WHERE id = ? AND generation = ? AND connection_id = ?')
          .run(serialized, now(), sent ?? null, ref.id, ref.generation, ref.connectionId).changes > 0;
        return changed;
      }).immediate();
    },

    retry(ref) {
      const row = db.query('SELECT attempts FROM waiting_questions WHERE id = ? AND generation = ? AND connection_id = ? AND result IS NULL').get(ref.id, ref.generation, ref.connectionId) as { attempts: number } | null;
      if (!row) return false;
      const delay = Math.min(30 * 60_000, 5_000 * 2 ** Math.min(row.attempts, 9));
      return db.query('UPDATE waiting_questions SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ? AND generation = ? AND connection_id = ? AND result IS NULL')
        .run(now() + delay, ref.id, ref.generation, ref.connectionId).changes > 0;
    },

    invalidate(ref) {
      return db.transaction(() => {
        // Withdraw answer text and locators, retaining the owner's disclosure record.
        const row = db.query('SELECT destination, result FROM waiting_questions WHERE id = ? AND generation = ? AND connection_id = ?').get(ref.id, ref.generation, ref.connectionId) as { destination: string; result: string | null } | null;
        const old = row?.result ? JSON.parse(row.result) as StoredPrivateAnswer : undefined;
        const disclosure = row?.destination === 'venice' && old?.sentItems
          ? JSON.stringify({ status: 'withdrawn', reason: 'Sent to Venice, but the sources changed. The answer was withdrawn.', sentItems: old.sentItems, citations: [], read: [], unanswered: [], leftOut: [] }) : null;
        return db.query('UPDATE waiting_questions SET result = ?, seen = 0, generation = generation + 1, attempts = 0, next_attempt_at = 0 WHERE id = ? AND generation = ? AND connection_id = ?')
          .run(disclosure, ref.id, ref.generation, ref.connectionId).changes > 0;
      }).immediate();
    },

    deleteForCorpora(corpusIds, knownCorpusIds, options = {}) {
      const ids = new Set(corpusIds);
      const known = knownCorpusIds ? new Set(knownCorpusIds) : undefined;
      return db.transaction(() => {
        const rows = db.query('SELECT * FROM waiting_questions').all() as QuestionRow[];
        let removed = 0;
        for (const row of rows) {
          if (questionTakenWithCorpora(row, ids, known, options.answeredOnly === true)) {
            removed += db.query('DELETE FROM waiting_questions WHERE id = ?').run(row.id).changes;
          }
        }
        return removed;
      }).immediate();
    },

    deleteForAccountScope(input) {
      const ids = new Set(input.corpusIds);
      const readsScope = (item: Readonly<Record<string, unknown>>): boolean => {
        if (typeof item.corpusId !== 'string' || !ids.has(item.corpusId)) return false;
        const source = (item.provenance as { sourceItem?: Record<string, unknown> } | undefined)?.sourceItem;
        return source?.provider === input.provider && source?.accountScope === input.accountScope;
      };
      return db.transaction(() => {
        const rows = db.query('SELECT * FROM waiting_questions WHERE result IS NOT NULL').all() as QuestionRow[];
        let removed = 0;
        for (const row of rows) {
          const result = toQuestion(row).result;
          if (result?.read.some(readsScope)) {
            removed += db.query('DELETE FROM waiting_questions WHERE id = ?').run(row.id).changes;
          }
        }
        return removed;
      }).immediate();
    },

    close(): void {
      closeSqliteStore(db);
    },
  };
}

/**
 * Whether deleting a source's corpora takes this record: a question still
 * waiting (nothing says yet what it will read), unless only answers are taken,
 * an answer that read one of the corpora, or one that read something no corpus
 * in `known` accounts for.
 */
function questionTakenWithCorpora(
  row: QuestionRow,
  ids: ReadonlySet<string>,
  known: ReadonlySet<string> | undefined,
  answeredOnly = false,
): boolean {
  const result = toQuestion(row).result;
  if (!result) return !answeredOnly;
  return result.read.some(item => typeof item.corpusId !== 'string' || ids.has(item.corpusId) || (known !== undefined && !known.has(item.corpusId)));
}

/**
 * One source's forget step: `deleteForCorpora` on the store beside the
 * remote-connections database, or on a dry run the count it would delete,
 * from a read-only connection (opening the store would migrate it and drop
 * expired records). A missing file has nothing to forget. `answeredOnly` is
 * the worker's repeat before its restart: a question asked since the delete,
 * still waiting, may be about another source and is answered after the
 * restart; only answers, which may have read the deleted stores, go.
 */
export function forgetWaitingPrivateQuestions(
  dbPath: string,
  input: { corpusIds: readonly string[]; knownCorpusIds?: readonly string[] | undefined },
  options: { dryRun?: boolean; answeredOnly?: boolean } = {},
): number {
  if (!existsSync(dbPath)) return 0;
  const answeredOnly = options.answeredOnly === true;
  if (options.dryRun !== true) {
    const store = openWaitingPrivateQuestionStore(dbPath);
    try {
      return store.deleteForCorpora(input.corpusIds, input.knownCorpusIds, { answeredOnly });
    } finally {
      store.close();
    }
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS};`);
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'waiting_questions'").get()) return 0;
    const ids = new Set(input.corpusIds);
    const known = input.knownCorpusIds ? new Set(input.knownCorpusIds) : undefined;
    const rows = db.query('SELECT * FROM waiting_questions').all() as QuestionRow[];
    return rows.filter((row) => questionTakenWithCorpora(row, ids, known, answeredOnly)).length;
  } finally {
    closeSqliteStore(db);
  }
}

/**
 * Deletes a revoked connection's waiting questions and bumps its revocation
 * generation, opening the store beside the connections database. Called by
 * the connection store's revoke, in whichever process revokes (the worker's
 * Agents page or the CLI). Best effort for the caller: a failure here never
 * undoes or fails the revocation itself, and the lock wait is short
 * (REVOKE_BUSY_TIMEOUT_MS): the store refuses recordings for connections the
 * connection store no longer vouches for, and the worker reconciles against
 * the live connection list on open and on every re-check pass.
 */
export function revokeWaitingPrivateQuestions(
  remoteConnectionsDbPath: string,
  connectionId: string,
  options: { busyTimeoutMs?: number } = {},
): void {
  const store = openWaitingPrivateQuestionStore(waitingPrivateQuestionsDbPath(remoteConnectionsDbPath), {
    busyTimeoutMs: options.busyTimeoutMs ?? REVOKE_BUSY_TIMEOUT_MS,
  });
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
    path: row.destination === 'venice' ? 'venice' : row.answer_path === 'anonymous' ? 'anonymous' : 'private',
    connectionId: row.connection_id,
    surface: row.surface === 'chatgpt' ? 'chatgpt' : 'remote',
    question: row.question,
    detail: row.detail === 'full' ? 'full' : 'summary',
    selectors,
    state: row.state === 'waiting' ? 'waiting' : 'unchecked',
    seen: row.seen === 1,
    generation: row.generation,
    askedAt: new Date(row.asked_at).toISOString(),
    ...(row.has_result !== undefined ? { hasResult: row.has_result === 1 } : {}),
    ...(row.result ? { result: JSON.parse(row.result) as StoredPrivateAnswer } : {}),
    ...(row.answered_at !== null ? { answeredAt: new Date(row.answered_at).toISOString() } : {}),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
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
  }, {
    version: 2,
    name: 'private_answers_inbox',
    up(db) {
      db.exec(`ALTER TABLE waiting_questions ADD COLUMN result TEXT;
        ALTER TABLE waiting_questions ADD COLUMN answered_at INTEGER;
        ALTER TABLE waiting_questions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE waiting_questions ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;`);
    },
  }, {
    version: 3,
    name: 'private_answer_auto_budgets',
    up(db) {
      db.exec('CREATE TABLE auto_answer_budgets (connection_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, attempts INTEGER NOT NULL)');
    },
  }, {
    version: 4,
    name: 'anonymous_answers_inbox',
    up(db) { db.exec("ALTER TABLE waiting_questions ADD COLUMN answer_path TEXT NOT NULL DEFAULT 'private' CHECK(answer_path IN ('private', 'anonymous'))"); },
  }, {
    version: 5,
    name: 'ask_destination',
    up(db) { db.exec("ALTER TABLE waiting_questions ADD COLUMN destination TEXT CHECK(destination IS NULL OR destination = 'venice')"); },
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

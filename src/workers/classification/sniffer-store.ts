// The privacy-safe sniffer's local state (design section 2.2): a verdict cache
// and a queue of unanswered questions, one SQLite file per connector store
// (`<store>.tier-sniffer.sqlite`, tier-ledger-path.ts), owner-only (0600).
//
// - The VERDICT CACHE is keyed by (material hash, model id, prompt version,
//   map revision), so an unchanged item is never re-asked, and a new model, a
//   new prompt or a new owner map asks again. It holds the verdict only:
//   tier, category, confidence. Never the material.
// - The QUESTION QUEUE holds, per item and pass, the material the model may
//   read (names, or a short excerpt) until the background pass answers it,
//   then deletes it. That material is what the store already keeps for the
//   item; it lives beside the store and is deleted with it.

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runSqliteMigrations, type SqliteMigration } from '../../core/sqlite-migrations.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import { assertWritableStoreOpenAllowed } from '../../core/store-write-guard.ts';
import { iterateRows } from '../../core/sqlite-rows.ts';
import { HELD_UNTIL_JUDGED_PRIORITY, NEW_ARRIVAL_PRIORITY, type TierSnifferSubject } from './tier-classifier.ts';
import { TIER_SNIFFER_SQLITE_STORE_ID } from './tier-ledger-path.ts';

export const TIER_SNIFFER_SCHEMA_VERSION = 8;

export interface ChunkWindowKey {
  subject: TierSnifferSubject;
  contentHash: string;
  modelId: string;
  promptVersion: string;
  /** Also binds the stored names and classifier input, not just the chunk. */
  materialHash: string;
  windowIndex: number;
}

export type SnifferPass = 'metadata' | 'content';
export type SnifferTier = 'personal' | 'private';

export interface SnifferVerdictKey {
  materialHash: string;
  modelId: string;
  promptVersion: string;
  mapRevision: string;
}

export interface StoredSnifferVerdict {
  tier: SnifferTier;
  category: string;
  confidence: number;
  /** True when this verdict is the fail-safe Private recorded after repeated failures. */
  failSafe: boolean;
  decidedAt: string;
  contentHash?: string;
  modelSubject?: string;
}

export interface TrainingSnifferVerdict {
  tier: SnifferTier;
  decidedAt: string;
  ambiguous: boolean;
  /** Present only when every latest answer is bound to the same final content. */
  contentHash?: string;
}

export interface SnifferQuestion {
  provider: string;
  accountScope: string;
  providerItemId: string;
  /** Present when the item belongs to a conversation: part of its ledger identity. */
  providerConversationId?: string;
  pass: SnifferPass;
  materialHash: string;
  contentHash?: string;
  mapRevision: string;
  material: string;
  flags: string[];
  attempts: number;
  queuedAt: string;
  priority: number;
  conversationOrder?: -1 | 0 | 1;
  /** Stable insertion order for items queued in the same millisecond. */
  sequence: number;
}

export function snifferMaterialHash(pass: SnifferPass, material: string): string {
  return createHash('sha256').update(`${pass}\n${material}`).digest('hex');
}

/** Non-content identity of the item whose model answer is awaiting final settlement. */
export function snifferSubjectKey(subject: TierSnifferSubject): string {
  return createHash('sha256').update(JSON.stringify([subject.provider, subject.accountScope, subject.providerConversationId ?? '', subject.providerItemId])).digest('hex');
}

export function contentVerdictReusable(verdict: StoredSnifferVerdict, contentHash: string, subject?: TierSnifferSubject): boolean {
  return !verdict.failSafe && (verdict.contentHash === contentHash
    || (subject !== undefined && verdict.modelSubject === snifferSubjectKey(subject)));
}

export class TierSnifferStore {
  readonly dbPath: string;
  private readonly db: Database;
  private readonly now: () => Date;
  private readonly readOnly: boolean;
  // Keep construction inside the constructor so Bun can drop this SQLite class
  // from the Node-loaded plugin bundle when only its pure helpers are used.
  private readonly trainingReads: Map<string, Map<string, TrainingSnifferVerdict>>;

  constructor(options: { dbPath: string; now?: () => Date; readOnly?: boolean }) {
    this.trainingReads = new Map();
    this.dbPath = options.dbPath;
    this.now = options.now ?? (() => new Date());
    if (options.readOnly === true) {
      // A reader (the status backlog): never creates, migrates or writes.
      this.db = new Database(this.dbPath, { readonly: true, create: false });
      this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON;');
      this.readOnly = true;
      return;
    }
    this.readOnly = false;
    assertWritableStoreOpenAllowed('sniffer store', this.dbPath);
    const onDisk = this.dbPath !== ':memory:';
    if (onDisk) mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    const previousUmask = onDisk ? process.umask(0o077) : undefined;
    let db: Database | undefined;
    try {
      db = new Database(this.dbPath, { create: true });
      db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;');
      runSqliteMigrations(db, TIER_SNIFFER_SQLITE_STORE_ID, snifferMigrations());
      if (onDisk) restrictFiles(this.dbPath);
    } catch (error) {
      if (db) closeSqliteStore(db);
      throw error;
    } finally {
      if (previousUmask !== undefined) process.umask(previousUmask);
    }
    this.db = db;
  }

  close(): void {
    try {
      closeSqliteStore(this.db, this.readOnly ? { checkpoint: false } : undefined);
    } finally {
      if (this.dbPath !== ':memory:' && !this.readOnly) restrictFiles(this.dbPath);
    }
  }

  chunkWindowVerdict(key: ChunkWindowKey): 'private' | 'secure' | 'secrets' | undefined {
    return (this.db.query(`SELECT tier FROM chunk_window_verdicts WHERE subject_key = ? AND content_hash = ?
      AND model_id = ? AND prompt_version = ? AND material_hash = ? AND window_index = ?`)
      .get(snifferSubjectKey(key.subject), key.contentHash, key.modelId, key.promptVersion, key.materialHash, key.windowIndex) as { tier: 'private' | 'secure' | 'secrets' } | null)?.tier;
  }

  recordChunkWindow(key: ChunkWindowKey, tier: 'private' | 'secure' | 'secrets'): void {
    this.db.query(`INSERT OR REPLACE INTO chunk_window_verdicts
      (subject_key, content_hash, model_id, prompt_version, material_hash, window_index, tier)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(snifferSubjectKey(key.subject), key.contentHash, key.modelId, key.promptVersion, key.materialHash, key.windowIndex, tier);
  }

  getVerdict(key: SnifferVerdictKey): StoredSnifferVerdict | undefined {
    const row = this.db.query(`
      SELECT tier, category, confidence, fail_safe, decided_at, content_hash, model_subject FROM sniffer_verdicts
      WHERE material_hash = ? AND model_id = ? AND prompt_version = ? AND map_revision = ?
    `).get(key.materialHash, key.modelId, key.promptVersion, key.mapRevision) as {
      tier: SnifferTier;
      category: string;
      confidence: number;
      fail_safe: number;
      decided_at: string;
      content_hash: string | null;
      model_subject: string | null;
    } | null;
    if (!row) return undefined;
    return {
      tier: row.tier,
      category: row.category,
      confidence: row.confidence,
      failSafe: row.fail_safe === 1,
      decidedAt: row.decided_at,
      ...(row.content_hash ? { contentHash: row.content_hash } : {}),
      ...(row.model_subject ? { modelSubject: row.model_subject } : {}),
    };
  }

  putVerdict(key: SnifferVerdictKey, verdict: Omit<StoredSnifferVerdict, 'decidedAt'>, subject?: TierSnifferSubject): void {
    this.db.query(`
      INSERT INTO sniffer_verdicts (material_hash, model_id, prompt_version, map_revision, tier, category, confidence, fail_safe, decided_at, model_subject)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (material_hash, model_id, prompt_version, map_revision) DO UPDATE SET
        tier = excluded.tier, category = excluded.category, confidence = excluded.confidence,
        fail_safe = excluded.fail_safe, decided_at = excluded.decided_at, content_hash = NULL, model_subject = excluded.model_subject
    `).run(
      key.materialHash,
      key.modelId,
      key.promptVersion,
      key.mapRevision,
      verdict.tier,
      verdict.category,
      verdict.confidence,
      verdict.failSafe ? 1 : 0,
      this.now().toISOString(),
      subject ? snifferSubjectKey(subject) : null,
    );
  }

  /** Forget one cached verdict, so its question is asked again (a second round, judge-second-round.ts). */
  deleteVerdict(key: SnifferVerdictKey): void {
    this.db.query('DELETE FROM sniffer_verdicts WHERE material_hash = ? AND model_id = ? AND prompt_version = ? AND map_revision = ?')
      .run(key.materialHash, key.modelId, key.promptVersion, key.mapRevision);
  }

  /** Only a model answer applied to a final item may answer another item's content. */
  markFinalModelContent(key: SnifferVerdictKey, contentHash: string): void {
    this.db.query(`UPDATE sniffer_verdicts SET content_hash = ?
      WHERE material_hash = ? AND model_id = ? AND prompt_version = ? AND map_revision = ? AND fail_safe = 0`)
      .run(contentHash, key.materialHash, key.modelId, key.promptVersion, key.mapRevision);
  }

  // Private can only raise across names. Personal requires the complete same
  // input (including names); missing identity never authorizes a lowering.
  getFinalModelContentVerdict(key: Omit<SnifferVerdictKey, 'materialHash'> & { contentHash: string; materialHash?: string }): StoredSnifferVerdict | undefined {
    const row = this.db.query(`SELECT material_hash FROM sniffer_verdicts
      WHERE content_hash = ? AND model_id = ? AND prompt_version = ? AND map_revision = ? AND fail_safe = 0
        AND (tier = 'private' OR material_hash = ?)
      ORDER BY CASE tier WHEN 'private' THEN 1 ELSE 0 END DESC, decided_at DESC LIMIT 1`)
      .get(key.contentHash, key.modelId, key.promptVersion, key.mapRevision, key.materialHash ?? null) as { material_hash: string } | null;
    return row ? this.getVerdict({ ...key, materialHash: row.material_hash }) : undefined;
  }

  /** A real, final model label on this subject's complete own text; never a rule or fail-safe. */
  judgedContentLabel(subject: TierSnifferSubject, modelId: string, contentHash: string): SnifferTier | undefined {
    const row = this.db.query(`SELECT tier FROM sniffer_verdicts
      WHERE model_subject = ? AND model_id = ? AND content_hash = ? AND fail_safe = 0
      ORDER BY decided_at DESC LIMIT 1`).get(snifferSubjectKey(subject), modelId, contentHash) as { tier: SnifferTier } | null;
    return row?.tier;
  }

  /** Latest real answer on this subject and model, independent of content_hash.
   * Old offline snapshots lack the lookup index: scan once per model, never once per item.
   * Equal-time conflicting answers cannot prove a label. Content binding survives
   * only when every latest answer carries the same final-content hash. Later answers
   * are returned too:
   * the caller must reject them rather than select an older, convenient answer.
   */
  trainingVerdict(subject: TierSnifferSubject, modelId: string): TrainingSnifferVerdict | undefined {
    const key = snifferSubjectKey(subject);
    if (this.readOnly) {
      let labels = this.trainingReads.get(modelId);
      if (!labels) {
        labels = new Map();
        const rows = iterateRows<{ model_subject: string; tier: SnifferTier; decided_at: string; content_hash: string | null }>(this.db,
          `SELECT model_subject, tier, decided_at, content_hash FROM sniffer_verdicts
          WHERE model_id = ? AND fail_safe = 0 AND model_subject IS NOT NULL`, modelId);
        for (const row of rows) {
          const prior = labels.get(row.model_subject);
          if (!prior || row.decided_at > prior.decidedAt) labels.set(row.model_subject,
            { tier: row.tier, decidedAt: row.decided_at, ambiguous: false,
              ...(row.content_hash ? { contentHash: row.content_hash } : {}) });
          else if (row.decided_at === prior.decidedAt) {
            if (row.tier !== prior.tier) prior.ambiguous = true;
            if (row.content_hash !== prior.contentHash) delete prior.contentHash;
          }
        }
        this.trainingReads.set(modelId, labels);
      }
      return labels.get(key);
    }
    const row = this.db.query(`SELECT MIN(tier) AS tier, decided_at, COUNT(DISTINCT tier) AS tiers,
        CASE WHEN COUNT(content_hash) = COUNT(*) AND COUNT(DISTINCT content_hash) = 1
          THEN MIN(content_hash) END AS content_hash
      FROM sniffer_verdicts WHERE model_subject = ? AND model_id = ? AND fail_safe = 0
      GROUP BY decided_at ORDER BY decided_at DESC LIMIT 1`).get(key, modelId) as {
        tier: SnifferTier; decided_at: string; tiers: number; content_hash: string | null;
      } | null;
    return row ? { tier: row.tier, decidedAt: row.decided_at, ambiguous: row.tiers !== 1,
      ...(row.content_hash ? { contentHash: row.content_hash } : {}) } : undefined;
  }

  /** Fence sliced training against verdict writes on this or another connection. */
  changeMarker(): string {
    const own = this.db.query('SELECT total_changes() AS changes').get() as { changes: number };
    const external = this.db.query('PRAGMA data_version').get() as { data_version: number };
    return `${external.data_version}:${own.changes}`;
  }

  /**
   * Queue (or refresh) the question for one item and pass. A changed material
   * replaces the old one and resets the attempt count; an identical one keeps
   * its place and attempts. `stillAsk` is checked under this write's lock: the
   * Secrets disposition deletes an item's questions only after the item is
   * Secrets in the ledger, so a check that still finds it askable here runs
   * before that deletion, and a later one finds it Secrets and queues nothing.
   */
  enqueue(question: {
    subject: TierSnifferSubject;
    pass: SnifferPass;
    material: string;
    /** Full classification input digest, including text outside the excerpt. */
    materialHash?: string;
    contentHash?: string;
    mapRevision: string;
    flags: readonly string[];
    priority?: number;
    conversationOrder?: -1 | 0 | 1;
    stillAsk?: () => boolean;
  }): boolean {
    const materialHash = question.materialHash ?? snifferMaterialHash(question.pass, question.material);
    // From the held-until-judged floor (an imported archive, behind all live
    // work) to 100; anything else is the ordinary 0.
    const priority = Number.isFinite(question.priority)
      ? Math.max(HELD_UNTIL_JUDGED_PRIORITY, Math.min(100, Math.floor(question.priority!)))
      : 0;
    // A caller with no size hint (a re-judge of a stored item) keeps the
    // order an earlier enqueue gave the question; a new one starts at 0.
    const hinted = question.conversationOrder !== undefined;
    const hint = question.conversationOrder === 1 ? 1 : question.conversationOrder === -1 ? -1 : 0;
    return this.db.transaction(() => {
      if (question.stillAsk && !question.stillAsk()) return false;
      const before = this.db.query(`
        SELECT priority, conversation_order FROM sniffer_questions
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND pass = ?
      `).get(...subjectParams(question.subject), question.pass) as { priority: number; conversation_order: number } | null;
      const conversationOrder = hinted ? hint : before?.conversation_order ?? 0;
      this.db.query(`
      INSERT INTO sniffer_questions (
        provider, account_scope, conversation_key, provider_item_id, pass, material_hash, map_revision, material, flags_json, attempts, queued_at, priority, content_hash, conversation_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT (provider, account_scope, conversation_key, provider_item_id, pass) DO UPDATE SET
        held_sniffer_id = CASE WHEN sniffer_questions.material_hash = excluded.material_hash
          AND sniffer_questions.map_revision = excluded.map_revision AND sniffer_questions.flags_json = excluded.flags_json
          THEN sniffer_questions.held_sniffer_id ELSE NULL END,
        attempts = CASE WHEN sniffer_questions.material_hash = excluded.material_hash
          AND sniffer_questions.map_revision = excluded.map_revision
          THEN sniffer_questions.attempts ELSE 0 END,
        content_hash = excluded.content_hash,
        material_hash = excluded.material_hash,
        map_revision = excluded.map_revision,
        material = excluded.material,
        -- A new arrival stays one when a sweep or re-judge asks about it again.
        priority = CASE WHEN sniffer_questions.priority >= ${NEW_ARRIVAL_PRIORITY}
          THEN MAX(sniffer_questions.priority, excluded.priority) ELSE excluded.priority END,
        conversation_order = excluded.conversation_order,
        flags_json = excluded.flags_json
    `).run(
      ...subjectParams(question.subject),
      question.pass,
      materialHash,
      question.mapRevision,
      question.material,
      JSON.stringify([...question.flags]),
      this.now().toISOString(),
      priority,
      question.contentHash ?? null,
      conversationOrder,
    );
      // Recent order is priority, conversation size, then queue time, which an update keeps.
      if ((!before && (priority > 0 || conversationOrder > 0))
        || (before && (priority > before.priority || conversationOrder !== before.conversation_order))) {
        // A blocked scan may have moved below this new/promoted question.
        // Revisit the recent window next tick, atomically with enqueue; keep
        // the oldest cursors so priority arrivals cannot erase aging progress.
        // An unchanged re-enqueue (every sync) must not rewind the scan.
        this.db.query('DELETE FROM sniffer_scan WHERE scan_key IN (?, ?)')
          .run('all:recent', `${question.pass}:recent`);
      }
      return true;
    }).immediate();
  }

  questionFor(subject: TierSnifferSubject, pass: SnifferPass): SnifferQuestion | undefined {
    const row = this.db.query(`
      SELECT * FROM sniffer_questions
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND pass = ?
    `).get(...subjectParams(subject), pass) as QuestionRow | null;
    return row ? questionFromRow(row) : undefined;
  }

  /** Recent/high priority work plus the oldest eligible question. Blocked
   * backlogs are scanned in bounded, durable slices rather than every tick. */
  listQuestions(options: { pass?: SnifferPass; limit?: number; eligible?: (question: SnifferQuestion) => boolean } = {}): SnifferQuestion[] {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 5_000));
    const scanLimit = Math.max(64, limit);
    const accepted = new Map<number, boolean>();
    const eligible = (question: SnifferQuestion): boolean => {
      if (!accepted.has(question.sequence)) accepted.set(question.sequence, options.eligible?.(question) ?? true);
      return accepted.get(question.sequence)!;
    };
    const read = (oldest: boolean, count: number): SnifferQuestion[] => {
      const key = `${options.pass ?? 'all'}:${oldest ? 'oldest' : 'recent'}`;
      let cursor = options.eligible && !this.readOnly ? this.db.query(
        'SELECT conversation_order, priority, queued_at, question_pk, candidate_pk FROM sniffer_scan WHERE scan_key = ?',
      ).get(key) as QuestionCursor | null : null;
      if (oldest && cursor?.candidate_pk != null) {
        const pinned = this.db.query('SELECT * FROM sniffer_questions WHERE question_pk = ?')
          .get(cursor.candidate_pk) as QuestionRow | null;
        if (pinned) {
          const question = questionFromRow(pinned);
          if (eligible(question)) return [question];
        }
        // Consumed, stale, or blocked: restart to find the next oldest eligible.
        cursor = null;
        this.db.query('DELETE FROM sniffer_scan WHERE scan_key = ?').run(key);
      }
      const filters: string[] = [];
      const params: Array<string | number> = [];
      if (options.pass) { filters.push('pass = ?'); params.push(options.pass); }
      if (cursor) {
        filters.push(oldest ? '(queued_at, question_pk) > (?, ?)'
          : '(priority, conversation_order, queued_at, question_pk) < (?, ?, ?, ?)');
        if (!oldest) params.push(cursor.priority, cursor.conversation_order);
        params.push(cursor.queued_at, cursor.question_pk);
      }
      const rows = this.db.query(`SELECT * FROM sniffer_questions
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY ${oldest ? 'queued_at, question_pk' : 'priority DESC, conversation_order DESC, queued_at DESC, question_pk DESC'} LIMIT ?`)
        .all(...params, scanLimit) as QuestionRow[];
      const found: SnifferQuestion[] = [];
      for (const row of rows) {
        const question = questionFromRow(row);
        if (eligible(question)) found.push(question);
        if (found.length === count) break;
      }
      if (options.eligible && !this.readOnly) {
        // Until eligible work is found, advance past blocked rows even when
        // the store is reopened each tick. Reset on a hit/end so new arrivals
        // keep recent priority and newly unblocked old work is revisited.
        const last = rows.at(-1);
        if (oldest && found[0]) {
          // Discovery may precede the reserved fifth dispatch. Keep this
          // candidate across passes/restarts until it is consumed or blocked.
          const candidate = found[0];
          this.db.query(`INSERT OR REPLACE INTO sniffer_scan
            (scan_key, conversation_order, priority, queued_at, question_pk, candidate_pk) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(key, candidate.conversationOrder ?? 0, candidate.priority, candidate.queuedAt, candidate.sequence, candidate.sequence);
        } else if (found.length === 0 && rows.length === scanLimit && last) {
          this.db.query(`INSERT OR REPLACE INTO sniffer_scan
            (scan_key, conversation_order, priority, queued_at, question_pk) VALUES (?, ?, ?, ?, ?)`)
            .run(key, last.conversation_order, last.priority, last.queued_at, last.question_pk);
        } else this.db.query('DELETE FROM sniffer_scan WHERE scan_key = ?').run(key);
      }
      return found;
    };
    const questions = read(false, limit);
    const oldest = read(true, 1)[0];
    if (oldest && !questions.some(question => question.sequence === oldest.sequence)) questions.push(oldest);
    return questions;
  }

  dispatchCount(): number {
    const used = (this.db.query('SELECT dispatches FROM sniffer_schedule WHERE id = 1').get() as { dispatches: number }).dispatches;
    return used;
  }

  recordDispatch(): void {
    this.db.exec('UPDATE sniffer_schedule SET dispatches = dispatches + 1 WHERE id = 1');
  }

  clockMs(): number { return this.now().getTime(); }

  deleteQuestion(subject: TierSnifferSubject, pass: SnifferPass, materialHash?: string): boolean {
    return this.db.query(`
      DELETE FROM sniffer_questions
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND pass = ?
        AND (? IS NULL OR material_hash = ?)
    `).run(...subjectParams(subject), pass, materialHash ?? null, materialHash ?? null).changes > 0;
  }

  /**
   * Drop every queued question for one item, both passes, with the material
   * they hold. An item that becomes Secrets is never asked about again, and
   * its names or excerpt do not wait here for the resolver's next pass.
   */
  deleteItemQuestions(subject: TierSnifferSubject): number {
    return this.db.query(`
      DELETE FROM sniffer_questions
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).run(...subjectParams(subject)).changes;
  }

  /**
   * Drop every queued question for one account scope's items (an imported
   * archive being removed), with the material they hold. Verdicts are keyed
   * by material, not by item, and stay as the shared cache; a scan position
   * past a deleted question is a position like any other (`listQuestions`).
   */
  deleteAccountScopeQuestions(provider: string, accountScope: string): number {
    return this.db.query('DELETE FROM sniffer_questions WHERE provider = ? AND account_scope = ?')
      .run(provider, accountScope).changes;
  }

  /**
   * Re-ask a question under the item's current map revision: the queued
   * material (names or excerpt) is still the item's, only the map it is
   * judged under changed. Attempts start over.
   */
  rekey(subject: TierSnifferSubject, pass: SnifferPass, mapRevision: string): void {
    this.db.query(`
      UPDATE sniffer_questions SET map_revision = ?, attempts = 0, held_sniffer_id = NULL
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND pass = ?
    `).run(mapRevision, ...subjectParams(subject), pass);
  }

  /** Count one failed attempt; returns the new attempt count. */
  recordAttemptFailure(subject: TierSnifferSubject, pass: SnifferPass): number {
    this.db.query(`
      UPDATE sniffer_questions SET attempts = attempts + 1
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND pass = ?
    `).run(...subjectParams(subject), pass);
    return this.questionFor(subject, pass)?.attempts ?? 0;
  }

  /** An answered lowering stays queued so disabling the rollout hold replays it. */
  markHeldLowering(question: SnifferQuestion, snifferId: string): void {
    this.db.query(`UPDATE sniffer_questions SET held_sniffer_id = ?
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND pass = ?
        AND material_hash = ? AND map_revision = ?`)
      .run(snifferId, ...subjectParams(question), question.pass, question.materialHash, question.mapRevision);
  }

  /** Backpressure covers unanswered work under this classifier, not held answers. */
  questionWorkCounts(snifferId: string): { unanswered: number; heldLowering: number } {
    return this.db.query(`SELECT
      COUNT(CASE WHEN held_sniffer_id IS NULL OR held_sniffer_id != ? THEN 1 END) AS unanswered,
      COUNT(CASE WHEN held_sniffer_id = ? THEN 1 END) AS heldLowering
      FROM sniffer_questions`).get(snifferId, snifferId) as { unanswered: number; heldLowering: number };
  }

  /** Training's growth watermark; do not scan/group the question queue for it. */
  verdictCount(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM sniffer_verdicts').get() as { n: number }).n;
  }

  /** Content-free counts for status surfaces and the CLI. */
  counts(): { questions: number; items: number; byPass: Record<SnifferPass, number>; verdicts: number } {
    const byPass: Record<SnifferPass, number> = { metadata: 0, content: 0 };
    let questions = 0;
    for (const row of this.db.query('SELECT pass, COUNT(*) AS n FROM sniffer_questions GROUP BY pass').all() as Array<{ pass: SnifferPass; n: number }>) {
      byPass[row.pass] = row.n;
      questions += row.n;
    }
    const verdicts = (this.db.query('SELECT COUNT(*) AS n FROM sniffer_verdicts').get() as { n: number }).n;
    const items = (this.db.query(`
      SELECT COUNT(*) AS n FROM (
        SELECT DISTINCT provider, account_scope, conversation_key, provider_item_id FROM sniffer_questions
      )
    `).get() as { n: number }).n;
    return { questions, items, byPass, verdicts };
  }
}

type QuestionCursor = Pick<QuestionRow, 'conversation_order' | 'priority' | 'queued_at' | 'question_pk'> & { candidate_pk: number | null };

interface QuestionRow {
  question_pk: number;
  conversation_order: -1 | 0 | 1;
  priority: number;
  provider: string;
  account_scope: string;
  conversation_key: string;
  provider_item_id: string;
  pass: SnifferPass;
  material_hash: string;
  content_hash?: string | null;
  map_revision: string;
  material: string;
  flags_json: string;
  attempts: number;
  queued_at: string;
}

function questionFromRow(row: QuestionRow): SnifferQuestion {
  return {
    provider: row.provider,
    accountScope: row.account_scope,
    providerItemId: row.provider_item_id,
    ...(row.conversation_key ? { providerConversationId: row.conversation_key } : {}),
    pass: row.pass,
    materialHash: row.material_hash,
    ...(row.content_hash ? { contentHash: row.content_hash } : {}),
    mapRevision: row.map_revision,
    material: row.material,
    flags: JSON.parse(row.flags_json) as string[],
    attempts: row.attempts,
    queuedAt: row.queued_at,
    priority: row.priority ?? 0,
    conversationOrder: row.conversation_order ?? 0,
    sequence: row.question_pk,
  };
}

/** The ledger's identity columns: a conversation is part of an item's identity ('' when none). */
function subjectParams(subject: TierSnifferSubject): [string, string, string, string] {
  return [subject.provider, subject.accountScope, subject.providerConversationId ?? '', subject.providerItemId];
}

function restrictFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}

function snifferMigrations(): SqliteMigration[] {
  return [
    {
      version: 1,
      name: 'create_tier_sniffer',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS sniffer_verdicts (
            material_hash TEXT NOT NULL,
            model_id TEXT NOT NULL,
            prompt_version TEXT NOT NULL,
            map_revision TEXT NOT NULL,
            tier TEXT NOT NULL CHECK (tier IN ('personal', 'private')),
            category TEXT NOT NULL,
            confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
            fail_safe INTEGER NOT NULL DEFAULT 0 CHECK (fail_safe IN (0, 1)),
            decided_at TEXT NOT NULL,
            PRIMARY KEY (material_hash, model_id, prompt_version, map_revision)
          );
          CREATE TABLE IF NOT EXISTS sniffer_questions (
            question_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            conversation_key TEXT NOT NULL DEFAULT '',
            provider_item_id TEXT NOT NULL,
            pass TEXT NOT NULL CHECK (pass IN ('metadata', 'content')),
            material_hash TEXT NOT NULL,
            map_revision TEXT NOT NULL,
            material TEXT NOT NULL,
            flags_json TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            queued_at TEXT NOT NULL,
            UNIQUE (provider, account_scope, conversation_key, provider_item_id, pass)
          );
        `);
      },
    },
    {
      version: 2,
      name: 'priority_and_aging',
      up(db) {
        db.exec(`ALTER TABLE sniffer_questions ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
          CREATE INDEX sniffer_recent ON sniffer_questions(priority DESC, queued_at DESC, question_pk DESC);
          CREATE TABLE sniffer_schedule (id INTEGER PRIMARY KEY, dispatches INTEGER NOT NULL);
          INSERT INTO sniffer_schedule (id, dispatches) VALUES (1, 0);`);
      },
    },
    {
      version: 3,
      name: 'bounded_queue_scans',
      up(db) {
        db.exec(`CREATE INDEX sniffer_oldest ON sniffer_questions(queued_at, question_pk);
          CREATE INDEX sniffer_pass_recent ON sniffer_questions(pass, priority DESC, queued_at DESC, question_pk DESC);
          CREATE INDEX sniffer_pass_oldest ON sniffer_questions(pass, queued_at, question_pk);
          CREATE TABLE sniffer_scan (
            scan_key TEXT PRIMARY KEY, priority INTEGER NOT NULL,
            queued_at TEXT NOT NULL, question_pk INTEGER NOT NULL, candidate_pk INTEGER
          );`);
      },
    },
    {
      version: 4,
      name: 'held_lowering_answers',
      up(db) {
        db.exec('ALTER TABLE sniffer_questions ADD COLUMN held_sniffer_id TEXT;');
      },
    },
    {
      version: 5,
      name: 'final_model_content_reuse',
      up(db) {
        db.exec(`ALTER TABLE sniffer_questions ADD COLUMN content_hash TEXT;
          ALTER TABLE sniffer_verdicts ADD COLUMN content_hash TEXT;
          ALTER TABLE sniffer_verdicts ADD COLUMN model_subject TEXT;
          CREATE INDEX sniffer_final_content ON sniffer_verdicts(content_hash, model_id, prompt_version, map_revision)
            WHERE fail_safe = 0 AND content_hash IS NOT NULL;`);
      },
    },
    {
      version: 6,
      name: 'conversation_queue_order',
      up(db) {
        db.exec(`ALTER TABLE sniffer_questions ADD COLUMN conversation_order INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE sniffer_scan ADD COLUMN conversation_order INTEGER NOT NULL DEFAULT 0;
          DROP INDEX sniffer_recent;
          DROP INDEX sniffer_pass_recent;
          CREATE INDEX sniffer_recent ON sniffer_questions(priority DESC, conversation_order DESC, queued_at DESC, question_pk DESC);
          CREATE INDEX sniffer_pass_recent ON sniffer_questions(pass, priority DESC, conversation_order DESC, queued_at DESC, question_pk DESC);
          DELETE FROM sniffer_scan WHERE scan_key LIKE '%:recent';`);
      },
    },
    {
      version: 7,
      name: 'subject_training_verdict_lookup',
      up(db) {
        db.exec(`CREATE INDEX sniffer_training_subject ON sniffer_verdicts(model_subject, model_id, decided_at DESC)
          WHERE fail_safe = 0 AND model_subject IS NOT NULL;`);
      },
    },
    {
      version: 8,
      name: 'chunk_window_verdicts',
      up(db) {
        db.exec(`CREATE TABLE chunk_window_verdicts (
          subject_key TEXT NOT NULL, content_hash TEXT NOT NULL,
          model_id TEXT NOT NULL, prompt_version TEXT NOT NULL,
          material_hash TEXT NOT NULL, window_index INTEGER NOT NULL,
          tier TEXT NOT NULL CHECK (tier IN ('private', 'secure', 'secrets')),
          PRIMARY KEY (subject_key, content_hash, model_id, prompt_version, material_hash, window_index)
        );`);
      },
    },
  ];
}

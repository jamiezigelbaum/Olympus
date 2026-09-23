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
import type { TierSnifferSubject } from './tier-classifier.ts';
import { TIER_SNIFFER_SQLITE_STORE_ID } from './tier-ledger-path.ts';

export const TIER_SNIFFER_SCHEMA_VERSION = 1;

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
}

export interface SnifferQuestion {
  provider: string;
  accountScope: string;
  providerItemId: string;
  /** Present when the item belongs to a conversation: part of its ledger identity. */
  providerConversationId?: string;
  pass: SnifferPass;
  materialHash: string;
  mapRevision: string;
  material: string;
  flags: string[];
  attempts: number;
  queuedAt: string;
  /** Asked about on its own, never batched with other items. */
  solo: boolean;
}

export function snifferMaterialHash(pass: SnifferPass, material: string): string {
  return createHash('sha256').update(`${pass}\n${material}`).digest('hex');
}

export class TierSnifferStore {
  readonly dbPath: string;
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(options: { dbPath: string; now?: () => Date }) {
    this.dbPath = options.dbPath;
    this.now = options.now ?? (() => new Date());
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
      closeSqliteStore(this.db);
    } finally {
      if (this.dbPath !== ':memory:') restrictFiles(this.dbPath);
    }
  }

  getVerdict(key: SnifferVerdictKey): StoredSnifferVerdict | undefined {
    const row = this.db.query(`
      SELECT tier, category, confidence, fail_safe, decided_at FROM sniffer_verdicts
      WHERE material_hash = ? AND model_id = ? AND prompt_version = ? AND map_revision = ?
    `).get(key.materialHash, key.modelId, key.promptVersion, key.mapRevision) as {
      tier: SnifferTier;
      category: string;
      confidence: number;
      fail_safe: number;
      decided_at: string;
    } | null;
    if (!row) return undefined;
    return {
      tier: row.tier,
      category: row.category,
      confidence: row.confidence,
      failSafe: row.fail_safe === 1,
      decidedAt: row.decided_at,
    };
  }

  putVerdict(key: SnifferVerdictKey, verdict: Omit<StoredSnifferVerdict, 'decidedAt'>): void {
    this.db.query(`
      INSERT INTO sniffer_verdicts (material_hash, model_id, prompt_version, map_revision, tier, category, confidence, fail_safe, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (material_hash, model_id, prompt_version, map_revision) DO UPDATE SET
        tier = excluded.tier, category = excluded.category, confidence = excluded.confidence,
        fail_safe = excluded.fail_safe, decided_at = excluded.decided_at
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
    );
  }

  /**
   * Queue (or refresh) the question for one item and pass. A changed material
   * replaces the old one and resets the attempt count; an identical one keeps
   * its place and attempts.
   */
  enqueue(question: {
    subject: TierSnifferSubject;
    pass: SnifferPass;
    material: string;
    mapRevision: string;
    flags: readonly string[];
    /** Ask about this material on its own (possibly third-party text). */
    solo?: boolean;
  }): void {
    const materialHash = snifferMaterialHash(question.pass, question.material);
    this.db.query(`
      INSERT INTO sniffer_questions (
        provider, account_scope, conversation_key, provider_item_id, pass, material_hash, map_revision, material, flags_json, attempts, queued_at, solo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT (provider, account_scope, conversation_key, provider_item_id, pass) DO UPDATE SET
        attempts = CASE WHEN sniffer_questions.material_hash = excluded.material_hash
          AND sniffer_questions.map_revision = excluded.map_revision
          THEN sniffer_questions.attempts ELSE 0 END,
        material_hash = excluded.material_hash,
        map_revision = excluded.map_revision,
        material = excluded.material,
        flags_json = excluded.flags_json,
        solo = excluded.solo
    `).run(
      ...subjectParams(question.subject),
      question.pass,
      materialHash,
      question.mapRevision,
      question.material,
      JSON.stringify([...question.flags]),
      this.now().toISOString(),
      question.solo === true ? 1 : 0,
    );
  }

  questionFor(subject: TierSnifferSubject, pass: SnifferPass): SnifferQuestion | undefined {
    const row = this.db.query(`
      SELECT * FROM sniffer_questions
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND pass = ?
    `).get(...subjectParams(subject), pass) as QuestionRow | null;
    return row ? questionFromRow(row) : undefined;
  }

  /** Oldest questions first; the background pass reads these in bounded pages. */
  listQuestions(options: { pass?: SnifferPass; limit?: number } = {}): SnifferQuestion[] {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 5_000));
    const rows = options.pass
      ? this.db.query('SELECT * FROM sniffer_questions WHERE pass = ? ORDER BY question_pk LIMIT ?').all(options.pass, limit)
      : this.db.query('SELECT * FROM sniffer_questions ORDER BY question_pk LIMIT ?').all(limit);
    return (rows as QuestionRow[]).map(questionFromRow);
  }

  deleteQuestion(subject: TierSnifferSubject, pass: SnifferPass): boolean {
    return this.db.query(`
      DELETE FROM sniffer_questions
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND pass = ?
    `).run(...subjectParams(subject), pass).changes > 0;
  }

  /** Count one failed attempt; returns the new attempt count. */
  recordAttemptFailure(subject: TierSnifferSubject, pass: SnifferPass): number {
    this.db.query(`
      UPDATE sniffer_questions SET attempts = attempts + 1
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND pass = ?
    `).run(...subjectParams(subject), pass);
    return this.questionFor(subject, pass)?.attempts ?? 0;
  }

  /** Content-free counts for status surfaces and the CLI. */
  counts(): { questions: number; byPass: Record<SnifferPass, number>; verdicts: number } {
    const byPass: Record<SnifferPass, number> = { metadata: 0, content: 0 };
    let questions = 0;
    for (const row of this.db.query('SELECT pass, COUNT(*) AS n FROM sniffer_questions GROUP BY pass').all() as Array<{ pass: SnifferPass; n: number }>) {
      byPass[row.pass] = row.n;
      questions += row.n;
    }
    const verdicts = (this.db.query('SELECT COUNT(*) AS n FROM sniffer_verdicts').get() as { n: number }).n;
    return { questions, byPass, verdicts };
  }
}

interface QuestionRow {
  provider: string;
  account_scope: string;
  conversation_key: string;
  provider_item_id: string;
  pass: SnifferPass;
  material_hash: string;
  map_revision: string;
  material: string;
  flags_json: string;
  attempts: number;
  queued_at: string;
  solo: number;
}

function questionFromRow(row: QuestionRow): SnifferQuestion {
  return {
    provider: row.provider,
    accountScope: row.account_scope,
    providerItemId: row.provider_item_id,
    ...(row.conversation_key ? { providerConversationId: row.conversation_key } : {}),
    pass: row.pass,
    materialHash: row.material_hash,
    mapRevision: row.map_revision,
    material: row.material,
    flags: JSON.parse(row.flags_json) as string[],
    attempts: row.attempts,
    queuedAt: row.queued_at,
    solo: row.solo === 1,
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
      version: TIER_SNIFFER_SCHEMA_VERSION,
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
            solo INTEGER NOT NULL DEFAULT 1 CHECK (solo IN (0, 1)),
            UNIQUE (provider, account_scope, conversation_key, provider_item_id, pass)
          );
        `);
      },
    },
  ];
}

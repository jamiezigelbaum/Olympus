// The tier ledger (design docs/design/per-item-four-tier-classification.md,
// section 3.3): one local SQLite record per item identity of its two current
// tiers, why they were chosen, and which generation is live.
//
// In phase P1a the ledger RECORDS decisions and nothing reads it for
// retrieval. Phase P1b makes it the visibility switch across tier stores: a
// move writes the destination copy, then `flip` makes it current in one write.
// The API those phases need is here now so the row shape is fixed once.
//
// Custody: identity columns (provider, account scope, provider item id), tier
// keys, content-free reason codes and version ids. Never a title, path,
// sender, text or excerpt. The file is created owner-only (0600).

import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SourceItemIdentity, SourceTrustDomain, SourceTrustTier } from '../../core/source-index/types.ts';
import { runSqliteMigrations, type SqliteMigration } from '../../core/sqlite-migrations.ts';
import {
  TIER_KEYS,
  type ItemTierOverride,
  type TierDecidedBy,
  type TierDecision,
  type TierKey,
} from './tier-classifier.ts';

export const TIER_LEDGER_SQLITE_STORE_ID = 'olympus_tier_ledger';
export const TIER_LEDGER_SCHEMA_VERSION = 1;
export const TIER_LEDGER_FILE_NAME = 'tier-ledger.sqlite';

export type TierLedgerState = 'pending' | 'current' | 'moving';

export type TierLedgerIdentity = Pick<SourceItemIdentity, 'provider' | 'accountScope' | 'providerItemId'>
  & Partial<Pick<SourceItemIdentity, 'family'>>;

export interface TierLedgerStoredPlacement {
  trustDomain: SourceTrustDomain;
  trustTier: SourceTrustTier;
}

export interface TierLedgerRecord {
  provider: string;
  accountScope: string;
  providerItemId: string;
  family: string;
  metadataTier: TierKey;
  contentTier: TierKey;
  generation: number;
  decidedBy: string;
  reasons: string[];
  engineVersion: string;
  mapRevision: string;
  modelId: string | null;
  previousMetadataTier: TierKey | null;
  previousContentTier: TierKey | null;
  state: TierLedgerState;
  /** While `moving`: the tiers the in-flight move will make current. */
  targetMetadataTier: TierKey | null;
  targetContentTier: TierKey | null;
  /**
   * Where the item's copy actually sits today. In P1a storage placement is
   * unchanged, so this can differ from the decided content tier; that
   * difference is exactly the work list phase P1b moves.
   */
  storedTrustDomain: SourceTrustDomain | null;
  storedTrustTier: SourceTrustTier | null;
  decidedAt: string;
}

export type TierLedgerRecordOutcome = 'inserted' | 'updated' | 'unchanged' | 'held_moving';

export interface TierLedgerOptions {
  dbPath: string;
  now?: () => Date;
}

export class TierLedgerGenerationConflictError extends Error {
  constructor(message = 'Tier ledger generation changed; re-read the row before flipping.') {
    super(message);
    this.name = 'TierLedgerGenerationConflictError';
  }
}

/**
 * Where a store's ledger lives when none is configured: beside the store's own
 * database, so every default store under the shared Olympus data directory
 * shares one ledger, and a test's temporary store keeps its ledger in its own
 * temporary directory. `:memory:` stores get an in-memory ledger.
 */
export function tierLedgerPathForStore(storeDbPath: string): string {
  if (storeDbPath === ':memory:') return ':memory:';
  return join(dirname(storeDbPath), TIER_LEDGER_FILE_NAME);
}

export class TierLedger {
  readonly dbPath: string;
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(options: TierLedgerOptions) {
    this.dbPath = options.dbPath;
    this.now = options.now ?? (() => new Date());
    const fresh = this.dbPath !== ':memory:' && !existsSync(this.dbPath);
    if (this.dbPath !== ':memory:') mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    try {
      this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;');
      runSqliteMigrations(this.db, TIER_LEDGER_SQLITE_STORE_ID, tierLedgerMigrations());
      if (fresh) chmodSync(this.dbPath, 0o600);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Record the classifier's decision for an item.
   *
   * - A new item is inserted at generation 1.
   * - An unchanged decision writes nothing.
   * - A changed decision with the same tiers updates reasons/state in place.
   * - A changed TIER bumps the generation and keeps the previous tiers.
   * - A row mid-move is left alone: the move owns it until `flip`.
   */
  recordDecision(
    identity: TierLedgerIdentity,
    decision: TierDecision,
    stored?: TierLedgerStoredPlacement,
  ): { outcome: TierLedgerRecordOutcome; record: TierLedgerRecord } {
    const decidedAt = this.now().toISOString();
    const reasonsJson = JSON.stringify(decision.reasons);
    let outcome: TierLedgerRecordOutcome = 'unchanged';
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing) {
        this.db.query(`
          INSERT INTO tier_items (
            provider, account_scope, provider_item_id, family,
            metadata_tier, content_tier, generation, decided_by, reasons_json,
            engine_version, map_revision, model_id,
            previous_metadata_tier, previous_content_tier, state,
            target_metadata_tier, target_content_tier,
            stored_trust_domain, stored_trust_tier, decided_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, ?)
        `).run(
          identity.provider,
          identity.accountScope,
          identity.providerItemId,
          identity.family ?? 'unknown',
          decision.metadataTier,
          decision.contentTier,
          decision.decidedBy,
          reasonsJson,
          decision.engineVersion,
          decision.mapRevision,
          decision.state,
          stored?.trustDomain ?? null,
          stored?.trustTier ?? null,
          decidedAt,
        );
        this.appendHistory(identity, 1, decision.metadataTier, decision.contentTier, decision.decidedBy, reasonsJson, decision.state, decidedAt);
        outcome = 'inserted';
        return;
      }
      if (existing.state === 'moving') {
        outcome = 'held_moving';
        return;
      }
      const tiersChanged = existing.metadataTier !== decision.metadataTier
        || existing.contentTier !== decision.contentTier;
      const detailChanged = JSON.stringify(existing.reasons) !== reasonsJson
        || existing.decidedBy !== decision.decidedBy
        || existing.state !== decision.state
        || existing.engineVersion !== decision.engineVersion
        || existing.mapRevision !== decision.mapRevision
        || (stored !== undefined
          && (existing.storedTrustDomain !== stored.trustDomain || existing.storedTrustTier !== stored.trustTier));
      if (!tiersChanged && !detailChanged) return;
      const generation = tiersChanged ? existing.generation + 1 : existing.generation;
      this.db.query(`
        UPDATE tier_items SET
          metadata_tier = ?, content_tier = ?, generation = ?, decided_by = ?, reasons_json = ?,
          engine_version = ?, map_revision = ?,
          previous_metadata_tier = ?, previous_content_tier = ?, state = ?,
          stored_trust_domain = COALESCE(?, stored_trust_domain),
          stored_trust_tier = COALESCE(?, stored_trust_tier),
          decided_at = ?
        WHERE provider = ? AND account_scope = ? AND provider_item_id = ?
      `).run(
        decision.metadataTier,
        decision.contentTier,
        generation,
        decision.decidedBy,
        reasonsJson,
        decision.engineVersion,
        decision.mapRevision,
        tiersChanged ? existing.metadataTier : existing.previousMetadataTier,
        tiersChanged ? existing.contentTier : existing.previousContentTier,
        decision.state,
        stored?.trustDomain ?? null,
        stored?.trustTier ?? null,
        decidedAt,
        identity.provider,
        identity.accountScope,
        identity.providerItemId,
      );
      this.appendHistory(identity, generation, decision.metadataTier, decision.contentTier, decision.decidedBy, reasonsJson, decision.state, decidedAt);
      outcome = 'updated';
    })();
    return { outcome, record: this.getCurrent(identity)! };
  }

  getCurrent(identity: TierLedgerIdentity): TierLedgerRecord | undefined {
    return this.readRow(identity);
  }

  /**
   * Mark an item as mid-move toward new tiers. Compare-and-swap on the
   * generation, so a move planned from a stale read is refused.
   */
  beginMove(
    identity: TierLedgerIdentity,
    target: { metadataTier: TierKey; contentTier: TierKey },
    expectedGeneration: number,
  ): TierLedgerRecord {
    assertTier(target.metadataTier);
    assertTier(target.contentTier);
    const result = this.db.query(`
      UPDATE tier_items SET state = 'moving', target_metadata_tier = ?, target_content_tier = ?
      WHERE provider = ? AND account_scope = ? AND provider_item_id = ? AND generation = ?
        AND state != 'moving'
    `).run(target.metadataTier, target.contentTier, identity.provider, identity.accountScope, identity.providerItemId, expectedGeneration);
    if (result.changes !== 1) throw new TierLedgerGenerationConflictError();
    return this.getCurrent(identity)!;
  }

  /**
   * The visibility switch: make new tiers current in one write. The previous
   * tiers are kept, so a rollback is another flip back to them. Without an
   * explicit target, a row that is `moving` flips to its planned target.
   */
  flip(
    identity: TierLedgerIdentity,
    options: {
      expectedGeneration: number;
      metadataTier?: TierKey;
      contentTier?: TierKey;
      decidedBy?: TierDecidedBy | 'rollback';
      reasons?: readonly string[];
      stored?: TierLedgerStoredPlacement;
    },
  ): TierLedgerRecord {
    const decidedAt = this.now().toISOString();
    let flipped: TierLedgerRecord | undefined;
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing || existing.generation !== options.expectedGeneration) {
        throw new TierLedgerGenerationConflictError();
      }
      const metadataTier = options.metadataTier ?? existing.targetMetadataTier;
      const contentTier = options.contentTier ?? existing.targetContentTier;
      if (!metadataTier || !contentTier) {
        throw new Error('Tier ledger flip needs target tiers or a row that is mid-move.');
      }
      assertTier(metadataTier);
      assertTier(contentTier);
      const generation = existing.generation + 1;
      const reasonsJson = JSON.stringify(options.reasons ?? existing.reasons);
      const decidedBy = options.decidedBy ?? existing.decidedBy;
      this.db.query(`
        UPDATE tier_items SET
          metadata_tier = ?, content_tier = ?, generation = ?, decided_by = ?, reasons_json = ?,
          previous_metadata_tier = ?, previous_content_tier = ?, state = 'current',
          target_metadata_tier = NULL, target_content_tier = NULL,
          stored_trust_domain = COALESCE(?, stored_trust_domain),
          stored_trust_tier = COALESCE(?, stored_trust_tier),
          decided_at = ?
        WHERE provider = ? AND account_scope = ? AND provider_item_id = ? AND generation = ?
      `).run(
        metadataTier,
        contentTier,
        generation,
        decidedBy,
        reasonsJson,
        existing.metadataTier,
        existing.contentTier,
        options.stored?.trustDomain ?? null,
        options.stored?.trustTier ?? null,
        decidedAt,
        identity.provider,
        identity.accountScope,
        identity.providerItemId,
        options.expectedGeneration,
      );
      this.appendHistory(identity, generation, metadataTier, contentTier, decidedBy, reasonsJson, 'current', decidedAt);
      flipped = this.readRow(identity);
    })();
    return flipped!;
  }

  /** Items waiting on an unanswered sniffer question, oldest first. */
  listPending(options: { limit?: number; after?: TierLedgerIdentity } = {}): TierLedgerRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 5_000));
    const rows = options.after
      ? this.db.query(`
          SELECT * FROM tier_items
          WHERE state = 'pending'
            AND (provider, account_scope, provider_item_id) > (?, ?, ?)
          ORDER BY provider, account_scope, provider_item_id
          LIMIT ?
        `).all(options.after.provider, options.after.accountScope, options.after.providerItemId, limit)
      : this.db.query(`
          SELECT * FROM tier_items WHERE state = 'pending'
          ORDER BY provider, account_scope, provider_item_id
          LIMIT ?
        `).all(limit);
    return (rows as TierItemRow[]).map(recordFromRow);
  }

  /** Content-free counts for status surfaces. */
  counts(): { items: number; byState: Record<TierLedgerState, number>; byContentTier: Record<TierKey, number> } {
    const byState: Record<TierLedgerState, number> = { pending: 0, current: 0, moving: 0 };
    const byContentTier: Record<TierKey, number> = { public: 0, private: 0, secure: 0, secrets: 0 };
    let items = 0;
    for (const row of this.db.query('SELECT state, content_tier, COUNT(*) AS n FROM tier_items GROUP BY state, content_tier').all() as Array<{ state: TierLedgerState; content_tier: TierKey; n: number }>) {
      items += row.n;
      byState[row.state] += row.n;
      byContentTier[row.content_tier] += row.n;
    }
    return { items, byState, byContentTier };
  }

  /** How many decisions this item has had, newest last. */
  history(identity: TierLedgerIdentity): Array<{ generation: number; metadataTier: TierKey; contentTier: TierKey; decidedBy: string; state: TierLedgerState; decidedAt: string }> {
    return (this.db.query(`
      SELECT generation, metadata_tier, content_tier, decided_by, state, decided_at
      FROM tier_history
      WHERE provider = ? AND account_scope = ? AND provider_item_id = ?
      ORDER BY history_pk
    `).all(identity.provider, identity.accountScope, identity.providerItemId) as Array<{
      generation: number;
      metadata_tier: TierKey;
      content_tier: TierKey;
      decided_by: string;
      state: TierLedgerState;
      decided_at: string;
    }>).map((row) => ({
      generation: row.generation,
      metadataTier: row.metadata_tier,
      contentTier: row.content_tier,
      decidedBy: row.decided_by,
      state: row.state,
      decidedAt: row.decided_at,
    }));
  }

  setOverride(identity: TierLedgerIdentity, override: ItemTierOverride): void {
    if (override.kind === 'tier') assertTier(override.tier);
    this.db.query(`
      INSERT INTO tier_overrides (provider, account_scope, provider_item_id, override_json, set_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (provider, account_scope, provider_item_id)
      DO UPDATE SET override_json = excluded.override_json, set_at = excluded.set_at
    `).run(identity.provider, identity.accountScope, identity.providerItemId, JSON.stringify(override), this.now().toISOString());
  }

  getOverride(identity: TierLedgerIdentity): ItemTierOverride | undefined {
    const row = this.db.query(`
      SELECT override_json FROM tier_overrides
      WHERE provider = ? AND account_scope = ? AND provider_item_id = ?
    `).get(identity.provider, identity.accountScope, identity.providerItemId) as { override_json: string } | null;
    if (!row) return undefined;
    const parsed = JSON.parse(row.override_json) as ItemTierOverride;
    if (parsed.kind === 'tier' && TIER_KEYS.includes(parsed.tier)) return parsed;
    if (parsed.kind === 'not_secret') return parsed;
    return undefined;
  }

  clearOverride(identity: TierLedgerIdentity): boolean {
    return this.db.query(`
      DELETE FROM tier_overrides WHERE provider = ? AND account_scope = ? AND provider_item_id = ?
    `).run(identity.provider, identity.accountScope, identity.providerItemId).changes > 0;
  }

  private readRow(identity: TierLedgerIdentity): TierLedgerRecord | undefined {
    const row = this.db.query(`
      SELECT * FROM tier_items WHERE provider = ? AND account_scope = ? AND provider_item_id = ?
    `).get(identity.provider, identity.accountScope, identity.providerItemId) as TierItemRow | null;
    return row ? recordFromRow(row) : undefined;
  }

  private appendHistory(
    identity: TierLedgerIdentity,
    generation: number,
    metadataTier: TierKey,
    contentTier: TierKey,
    decidedBy: string,
    reasonsJson: string,
    state: TierLedgerState,
    decidedAt: string,
  ): void {
    this.db.query(`
      INSERT INTO tier_history (
        provider, account_scope, provider_item_id, generation,
        metadata_tier, content_tier, decided_by, reasons_json, state, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(identity.provider, identity.accountScope, identity.providerItemId, generation, metadataTier, contentTier, decidedBy, reasonsJson, state, decidedAt);
  }
}

interface TierItemRow {
  provider: string;
  account_scope: string;
  provider_item_id: string;
  family: string;
  metadata_tier: TierKey;
  content_tier: TierKey;
  generation: number;
  decided_by: string;
  reasons_json: string;
  engine_version: string;
  map_revision: string;
  model_id: string | null;
  previous_metadata_tier: TierKey | null;
  previous_content_tier: TierKey | null;
  state: TierLedgerState;
  target_metadata_tier: TierKey | null;
  target_content_tier: TierKey | null;
  stored_trust_domain: SourceTrustDomain | null;
  stored_trust_tier: SourceTrustTier | null;
  decided_at: string;
}

function recordFromRow(row: TierItemRow): TierLedgerRecord {
  return {
    provider: row.provider,
    accountScope: row.account_scope,
    providerItemId: row.provider_item_id,
    family: row.family,
    metadataTier: row.metadata_tier,
    contentTier: row.content_tier,
    generation: row.generation,
    decidedBy: row.decided_by,
    reasons: JSON.parse(row.reasons_json) as string[],
    engineVersion: row.engine_version,
    mapRevision: row.map_revision,
    modelId: row.model_id,
    previousMetadataTier: row.previous_metadata_tier,
    previousContentTier: row.previous_content_tier,
    state: row.state,
    targetMetadataTier: row.target_metadata_tier,
    targetContentTier: row.target_content_tier,
    storedTrustDomain: row.stored_trust_domain,
    storedTrustTier: row.stored_trust_tier,
    decidedAt: row.decided_at,
  };
}

function assertTier(tier: string): asserts tier is TierKey {
  if (!(TIER_KEYS as readonly string[]).includes(tier)) {
    throw new Error(`Unknown tier key "${tier}".`);
  }
}

const TIER_CHECK = `IN ('public', 'private', 'secure', 'secrets')`;

function tierLedgerMigrations(): SqliteMigration[] {
  return [
    {
      version: TIER_LEDGER_SCHEMA_VERSION,
      name: 'create_tier_ledger',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS tier_items (
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            provider_item_id TEXT NOT NULL,
            family TEXT NOT NULL,
            metadata_tier TEXT NOT NULL CHECK (metadata_tier ${TIER_CHECK}),
            content_tier TEXT NOT NULL CHECK (content_tier ${TIER_CHECK}),
            generation INTEGER NOT NULL CHECK (generation >= 1),
            decided_by TEXT NOT NULL,
            reasons_json TEXT NOT NULL,
            engine_version TEXT NOT NULL,
            map_revision TEXT NOT NULL,
            model_id TEXT,
            previous_metadata_tier TEXT CHECK (previous_metadata_tier IS NULL OR previous_metadata_tier ${TIER_CHECK}),
            previous_content_tier TEXT CHECK (previous_content_tier IS NULL OR previous_content_tier ${TIER_CHECK}),
            state TEXT NOT NULL CHECK (state IN ('pending', 'current', 'moving')),
            target_metadata_tier TEXT CHECK (target_metadata_tier IS NULL OR target_metadata_tier ${TIER_CHECK}),
            target_content_tier TEXT CHECK (target_content_tier IS NULL OR target_content_tier ${TIER_CHECK}),
            stored_trust_domain TEXT,
            stored_trust_tier TEXT,
            decided_at TEXT NOT NULL,
            PRIMARY KEY (provider, account_scope, provider_item_id)
          );
          CREATE INDEX IF NOT EXISTS tier_items_state ON tier_items (state, provider, account_scope, provider_item_id);
          CREATE TABLE IF NOT EXISTS tier_history (
            history_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            provider_item_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            metadata_tier TEXT NOT NULL,
            content_tier TEXT NOT NULL,
            decided_by TEXT NOT NULL,
            reasons_json TEXT NOT NULL,
            state TEXT NOT NULL,
            decided_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS tier_history_item ON tier_history (provider, account_scope, provider_item_id, history_pk);
          CREATE TABLE IF NOT EXISTS tier_overrides (
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            provider_item_id TEXT NOT NULL,
            override_json TEXT NOT NULL,
            set_at TEXT NOT NULL,
            PRIMARY KEY (provider, account_scope, provider_item_id)
          );
        `);
      },
    },
  ];
}

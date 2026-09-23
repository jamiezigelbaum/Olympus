// The tier ledger (design docs/design/per-item-four-tier-classification.md,
// section 3.3): one local SQLite record per item identity of its two current
// tiers, why they were chosen, and which generation is live.
//
// Phase P1a RECORDS decisions. Phase P1b (schema 2) makes the ledger the
// visibility switch across tier stores:
//
// - `tier_copies` lists, per ROUTED item, every store copy the item has and
//   its state: `current` (searchable for the layers it holds), `staged` (a
//   move's destination while it is being written: never searched) or
//   `superseded` (kept, never searched, served, counted or exported).
// - A move writes the destination copy as `staged`, then `completeMove`
//   makes it current and supersedes the source in ONE transaction. Rollback is
//   the same flip back.
// - Items the P1b router never placed ("legacy" items: everything stored
//   before P1b) have no copy rows. They stay exactly where they are and remain
//   visible exactly as before; only P3's migration may change that.
//
// Custody: identity columns (provider, account scope, provider item id), tier
// keys, content-free reason codes and version ids. Never a title, path,
// sender, text or excerpt. The file is created owner-only (0600).

import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SourceItemIdentity, SourceTrustDomain, SourceTrustTier } from '../../core/source-index/types.ts';
import { runSqliteMigrations, type SqliteMigration } from '../../core/sqlite-migrations.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import {
  TIER_KEYS,
  maxTier,
  type ContentTierDecision,
  type ItemTierOverride,
  type TierDecidedBy,
  type TierDecision,
  type TierKey,
} from './tier-classifier.ts';
import { TIER_LEDGER_SQLITE_STORE_ID, tierLedgerPathForStore } from './tier-ledger-path.ts';

export { TIER_LEDGER_SQLITE_STORE_ID, tierLedgerPathForStore };
export const TIER_LEDGER_SCHEMA_VERSION = 2;

export type TierLedgerState = 'pending' | 'current' | 'moving';

/**
 * An item's ledger identity. The conversation is part of it: chat providers
 * reuse message ids across chats, so provider + account + item id alone would
 * make two different messages one ledger row. Absent means "no conversation"
 * (''), exactly as the connector store normalizes it.
 */
export type TierLedgerIdentity = Pick<SourceItemIdentity, 'provider' | 'accountScope' | 'providerItemId'>
  & Partial<Pick<SourceItemIdentity, 'family' | 'providerConversationId'>>;

/** The stored conversation key: the store's own normalization. */
export function tierLedgerConversationKey(identity: Pick<TierLedgerIdentity, 'providerConversationId'>): string {
  return identity.providerConversationId ?? '';
}

function idParams(identity: TierLedgerIdentity): [string, string, string, string] {
  return [identity.provider, identity.accountScope, tierLedgerConversationKey(identity), identity.providerItemId];
}

export interface TierLedgerStoredPlacement {
  trustDomain: SourceTrustDomain;
  trustTier: SourceTrustTier;
}

export interface TierLedgerRecord {
  provider: string;
  accountScope: string;
  /** The conversation the item belongs to; '' when it has none. */
  conversationKey: string;
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
  /** Whether the content tier was decided from the item's text (or by an owner override). */
  contentRead: boolean;
  metadataPending: boolean;
  contentPending: boolean;
  metadataForced: boolean;
  metadataFlagged: boolean;
  decidedAt: string;
  /** True once the P1b router placed the item (it then has copy rows). */
  routed: boolean;
}

export type TierLedgerRecordOutcome = 'inserted' | 'updated' | 'unchanged' | 'held_moving';

/** Which layer(s) of an item a store copy is searchable for. */
export type TierCopyLayers = 'metadata' | 'content' | 'both';
export type TierCopyState = 'current' | 'staged' | 'superseded';
export type TierSearchLayer = 'metadata' | 'content';

export interface TierCopy {
  corpusId: string;
  trustDomain: SourceTrustDomain;
  layers: TierCopyLayers;
  state: TierCopyState;
  /** Held back from embedding while the item's tier is not final (pending). */
  embedHold: boolean;
  /** The tier generation that made this copy current (or staged it). */
  generation: number;
  /** The generation whose flip superseded this copy; null unless superseded. */
  supersededByGeneration: number | null;
  /**
   * Set when the last flip kept this copy but changed which layers it serves
   * (e.g. `both` -> `metadata` on a split raise), so a rollback can restore it.
   */
  previousLayers: TierCopyLayers | null;
  updatedAt: string;
}

export interface TierCopyPlan {
  corpusId: string;
  trustDomain: SourceTrustDomain;
  layers: TierCopyLayers;
}

/**
 * Where the P1b router puts a routed item: one copy per store, at most two
 * stores (the metadata tier's and the content tier's), or none for Secrets.
 */
export interface TierPlacementPlan {
  copies: readonly TierCopyPlan[];
  embedHold: boolean;
  stored?: TierLedgerStoredPlacement;
}

export type TierRoutedOutcome =
  /** First placement of a new item. */
  | 'inserted'
  /** Same stores; decision details updated in place. */
  | 'updated'
  | 'unchanged'
  /**
   * The new decision needs different stores. The item is queued `moving` with
   * the new tiers as its target; on a RAISE every current copy is superseded
   * first (hide first), otherwise the current copies stay current. The copy
   * itself is the move primitive's job, never the sync's.
   */
  | 'queued_move'
  /** Already mid-move: the move owns the row. */
  | 'held_moving'
  /**
   * Secrets: every copy is superseded (hidden) at once; the caller tombstones
   * the store copies and then removes the rows.
   */
  | 'secrets';

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

export class TierLedger {
  readonly dbPath: string;
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(options: TierLedgerOptions) {
    this.dbPath = options.dbPath;
    this.now = options.now ?? (() => new Date());
    const onDisk = this.dbPath !== ':memory:';
    if (onDisk) {
      mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
      // Owner-only from the first byte, with an explicit file mode rather than
      // a process-wide umask (which would race every other file this process
      // creates meanwhile). SQLite gives its -wal/-shm sidecars the database
      // file's permissions; the chmod below repairs any file left readable by
      // an older build or a crash.
      if (!existsSync(this.dbPath)) closeSync(openSync(this.dbPath, 'a', 0o600));
      restrictLedgerFiles(this.dbPath);
    }
    let db: Database | undefined;
    try {
      db = new Database(this.dbPath, { create: true });
      db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;');
      runSqliteMigrations(db, TIER_LEDGER_SQLITE_STORE_ID, tierLedgerMigrations());
      if (onDisk) restrictLedgerFiles(this.dbPath);
    } catch (error) {
      if (db) closeSqliteStore(db);
      throw error;
    }
    this.db = db;
  }

  close(): void {
    try {
      // Checkpointed close, like every Olympus store: the ledger is safe to
      // hand to another process the moment this returns.
      closeSqliteStore(this.db);
    } finally {
      if (this.dbPath !== ':memory:') restrictLedgerFiles(this.dbPath);
    }
  }

  /**
   * Record the classifier's decision for an item.
   *
   * - A new item is inserted at generation 1.
   * - An unchanged decision writes nothing.
   * - A changed decision with the same tiers updates reasons/state in place.
   * - A changed TIER bumps the generation and keeps the previous tiers.
   * - A row mid-move is left alone: the move owns it until `flip`.
   * - A decision made WITHOUT reading the text never replaces or lowers a
   *   content tier: over a content tier decided from text it keeps that tier
   *   (raised to the new metadata tier if the names now demand more), and over
   *   an unread one it only ever raises.
   */
  recordDecision(
    identity: TierLedgerIdentity,
    decision: TierDecision,
    stored?: TierLedgerStoredPlacement,
  ): { outcome: TierLedgerRecordOutcome; record: TierLedgerRecord } {
    let outcome: TierLedgerRecordOutcome = 'unchanged';
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (existing?.state === 'moving') {
        outcome = 'held_moving';
        return;
      }
      outcome = this.writeRow(identity, effectiveRow(existing, decision), stored, existing);
    })();
    return { outcome, record: this.getCurrent(identity)! };
  }

  /**
   * Record a content decision made when an item's text was finally read (the
   * shared extraction factory). Only the content half changes; the metadata
   * decision recorded at listing stays. Returns undefined when no metadata
   * decision exists yet: there is nothing to start pass 2 from.
   */
  recordContentDecision(
    identity: TierLedgerIdentity,
    content: ContentTierDecision,
    stored?: TierLedgerStoredPlacement,
  ): { outcome: TierLedgerRecordOutcome; record: TierLedgerRecord } | undefined {
    let outcome: TierLedgerRecordOutcome | undefined;
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing) return;
      if (existing.state === 'moving') {
        outcome = 'held_moving';
        return;
      }
      if (existing.decidedBy === 'override') {
        outcome = 'unchanged';
        return;
      }
      const metadataReasons = existing.reasons.filter((reason) => !reason.startsWith('content:'));
      const contentTier = maxTier(content.contentTier, existing.metadataTier);
      const next: EffectiveRow = {
        metadataTier: existing.metadataTier,
        contentTier,
        decidedBy: content.decidedBy,
        reasons: [...metadataReasons, ...content.reasons],
        engineVersion: content.engineVersion,
        mapRevision: content.mapRevision,
        contentRead: true,
        metadataPending: existing.metadataPending,
        contentPending: content.contentPending,
        metadataForced: existing.metadataForced,
        metadataFlagged: existing.metadataFlagged,
      };
      outcome = this.writeRow(identity, next, stored, existing);
    })();
    return outcome === undefined ? undefined : { outcome, record: this.getCurrent(identity)! };
  }

  private writeRow(
    identity: TierLedgerIdentity,
    next: EffectiveRow,
    stored: TierLedgerStoredPlacement | undefined,
    existing: TierLedgerRecord | undefined,
  ): TierLedgerRecordOutcome {
    // A routed item's stored placement is its copy rows, owned by the router;
    // a legacy-path observation of it must not relabel them.
    if (existing?.routed) stored = undefined;
    const decidedAt = this.now().toISOString();
    const reasonsJson = JSON.stringify(next.reasons);
    const state: TierLedgerState = next.metadataPending || next.contentPending ? 'pending' : 'current';
    const flags = [
      next.contentRead ? 1 : 0,
      next.metadataPending ? 1 : 0,
      next.contentPending ? 1 : 0,
      next.metadataForced ? 1 : 0,
      next.metadataFlagged ? 1 : 0,
    ];
    if (!existing) {
      this.db.query(`
        INSERT INTO tier_items (
          provider, account_scope, conversation_key, provider_item_id, family,
          metadata_tier, content_tier, generation, decided_by, reasons_json,
          engine_version, map_revision, model_id,
          previous_metadata_tier, previous_content_tier, state,
          target_metadata_tier, target_content_tier,
          stored_trust_domain, stored_trust_tier,
          content_read, metadata_pending, content_pending, metadata_forced, metadata_flagged,
          decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ...idParams(identity),
        identity.family ?? 'unknown',
        next.metadataTier,
        next.contentTier,
        next.decidedBy,
        reasonsJson,
        next.engineVersion,
        next.mapRevision,
        state,
        stored?.trustDomain ?? null,
        stored?.trustTier ?? null,
        ...flags,
        decidedAt,
      );
      this.appendHistory(identity, 1, next.metadataTier, next.contentTier, next.decidedBy, reasonsJson, state, decidedAt);
      return 'inserted';
    }
    const tiersChanged = existing.metadataTier !== next.metadataTier
      || existing.contentTier !== next.contentTier;
    const detailChanged = JSON.stringify(existing.reasons) !== reasonsJson
      || existing.decidedBy !== next.decidedBy
      || existing.state !== state
      || existing.engineVersion !== next.engineVersion
      || existing.mapRevision !== next.mapRevision
      || existing.contentRead !== next.contentRead
      || existing.metadataPending !== next.metadataPending
      || existing.contentPending !== next.contentPending
      || existing.metadataForced !== next.metadataForced
      || existing.metadataFlagged !== next.metadataFlagged
      || (stored !== undefined
        && (existing.storedTrustDomain !== stored.trustDomain || existing.storedTrustTier !== stored.trustTier));
    if (!tiersChanged && !detailChanged) return 'unchanged';
    const generation = tiersChanged ? existing.generation + 1 : existing.generation;
    this.db.query(`
      UPDATE tier_items SET
        metadata_tier = ?, content_tier = ?, generation = ?, decided_by = ?, reasons_json = ?,
        engine_version = ?, map_revision = ?,
        previous_metadata_tier = ?, previous_content_tier = ?, state = ?,
        stored_trust_domain = COALESCE(?, stored_trust_domain),
        stored_trust_tier = COALESCE(?, stored_trust_tier),
        content_read = ?, metadata_pending = ?, content_pending = ?, metadata_forced = ?, metadata_flagged = ?,
        decided_at = ?
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).run(
      next.metadataTier,
      next.contentTier,
      generation,
      next.decidedBy,
      reasonsJson,
      next.engineVersion,
      next.mapRevision,
      tiersChanged ? existing.metadataTier : existing.previousMetadataTier,
      tiersChanged ? existing.contentTier : existing.previousContentTier,
      state,
      stored?.trustDomain ?? null,
      stored?.trustTier ?? null,
      ...flags,
      decidedAt,
      ...idParams(identity),
    );
    this.appendHistory(identity, generation, next.metadataTier, next.contentTier, next.decidedBy, reasonsJson, state, decidedAt);
    return 'updated';
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
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND generation = ?
        AND state != 'moving'
    `).run(target.metadataTier, target.contentTier, ...idParams(identity), expectedGeneration);
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
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND generation = ?
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
        ...idParams(identity),
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
            AND (provider, account_scope, provider_item_id, conversation_key) > (?, ?, ?, ?)
          ORDER BY provider, account_scope, provider_item_id, conversation_key
          LIMIT ?
        `).all(options.after.provider, options.after.accountScope, options.after.providerItemId, tierLedgerConversationKey(options.after), limit)
      : this.db.query(`
          SELECT * FROM tier_items WHERE state = 'pending'
          ORDER BY provider, account_scope, provider_item_id, conversation_key
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
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      ORDER BY history_pk
    `).all(...idParams(identity)) as Array<{
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
      INSERT INTO tier_overrides (provider, account_scope, conversation_key, provider_item_id, override_json, set_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider, account_scope, conversation_key, provider_item_id)
      DO UPDATE SET override_json = excluded.override_json, set_at = excluded.set_at
    `).run(...idParams(identity), JSON.stringify(override), this.now().toISOString());
  }

  getOverride(identity: TierLedgerIdentity): ItemTierOverride | undefined {
    const row = this.db.query(`
      SELECT override_json FROM tier_overrides
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).get(...idParams(identity)) as { override_json: string } | null;
    if (!row) return undefined;
    const parsed = JSON.parse(row.override_json) as ItemTierOverride;
    if (parsed.kind === 'tier' && TIER_KEYS.includes(parsed.tier)) return parsed;
    if (parsed.kind === 'not_secret') return parsed;
    return undefined;
  }

  clearOverride(identity: TierLedgerIdentity): boolean {
    return this.db.query(`
      DELETE FROM tier_overrides WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).run(...idParams(identity)).changes > 0;
  }

  // ---- P1b: routed placement and store copies --------------------------------

  /**
   * This ledger file's identity, minted once when it was created (schema 2).
   * A store that received routed copies records it (the tier-set binding),
   * so a reader that finds a different ledger — or none — at that path knows
   * the visibility authority was lost and fails closed.
   */
  ledgerId(): string {
    const row = this.db.query(`SELECT value FROM tier_ledger_meta WHERE key = 'ledger_id'`).get() as { value: string } | null;
    if (!row) throw new Error('Tier ledger has no identity.');
    return row.value;
  }

  isRouted(identity: TierLedgerIdentity): boolean {
    return this.readRow(identity)?.routed === true;
  }

  copies(identity: TierLedgerIdentity): TierCopy[] {
    return (this.db.query(`
      SELECT * FROM tier_copies
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      ORDER BY corpus_id
    `).all(...idParams(identity)) as TierCopyRow[]).map(copyFromRow);
  }

  /**
   * Copy rows for many items read in ONE transaction, so every hit a query
   * gathered is judged against the same ledger snapshot. That single snapshot
   * is what makes "never searchable in two tiers at once" hold across a
   * fan-out: a flip is one write, so a snapshot sees either the source copy
   * current or the destination copy current, never both. Keyed by
   * `tierLedgerIdentityKey`. Items with no rows are absent from the map.
   */
  copiesForMany(identities: readonly TierLedgerIdentity[]): Map<string, TierCopy[]> {
    const result = new Map<string, TierCopy[]>();
    if (identities.length === 0) return result;
    const unique = new Map<string, TierLedgerIdentity>();
    for (const identity of identities) unique.set(tierLedgerIdentityKey(identity), identity);
    const list = [...unique.values()];
    this.db.transaction(() => {
      for (let offset = 0; offset < list.length; offset += 200) {
        const batch = list.slice(offset, offset + 200);
        const rows = this.db.query(`
          SELECT * FROM tier_copies
          WHERE (provider, account_scope, conversation_key, provider_item_id) IN (VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')})
          ORDER BY corpus_id
        `).all(...batch.flatMap((identity) => [...idParams(identity)])) as TierCopyRow[];
        for (const row of rows) {
          const key = tierLedgerIdentityKey(identityFromRow(row));
          const existing = result.get(key);
          if (existing) existing.push(copyFromRow(row));
          else result.set(key, [copyFromRow(row)]);
        }
      }
    })();
    return result;
  }

  /**
   * Record the router's placement of an item, in one transaction with its
   * decision. See `TierRoutedOutcome` for what each outcome means. Returns the
   * copies the item had BEFORE this call, so a caller that must tombstone them
   * (Secrets) knows where they are.
   */
  recordRoutedPlacement(
    identity: TierLedgerIdentity,
    decision: TierDecision,
    plan: TierPlacementPlan,
    options: {
      /**
       * The caller verified that no store holds an active copy any more (a
       * lane removed it on its own, e.g. a trust eviction). Nothing is visible
       * anywhere, so the new placement replaces the stale rows outright: it is
       * a fresh placement, not a move.
       */
      staleCopiesGone?: boolean;
      /**
       * A lane whose text arrives later may hold a STAGED copy from a landing
       * that has not completed (`stageLandingCopy`). While the item's text has
       * not landed, that copy is the landing's, not a move's: it does not turn
       * an unchanged placement into a queued move.
       */
      stagedLandingAllowed?: boolean;
    } = {},
  ): { outcome: TierRoutedOutcome; record: TierLedgerRecord; previousCopies: TierCopy[]; raise: boolean } {
    const decidedAt = this.now().toISOString();
    const reasonsJson = JSON.stringify(decision.reasons);
    for (const copy of plan.copies) assertCopyPlan(copy);
    if (new Set(plan.copies.map((copy) => copy.corpusId)).size !== plan.copies.length) {
      throw new Error('A tier placement plan names each store at most once.');
    }
    let outcome: TierRoutedOutcome = 'unchanged';
    let raise = false;
    let previousCopies: TierCopy[] = [];
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      previousCopies = this.copies(identity);
      const secrets = decision.contentTier === 'secrets';
      if (!existing) {
        this.db.query(`
          INSERT INTO tier_items (
            provider, account_scope, conversation_key, provider_item_id, family,
            metadata_tier, content_tier, generation, decided_by, reasons_json,
            engine_version, map_revision, model_id,
            previous_metadata_tier, previous_content_tier, state,
            target_metadata_tier, target_content_tier,
            stored_trust_domain, stored_trust_tier,
            content_read, metadata_pending, content_pending, metadata_forced, metadata_flagged,
            decided_at, routed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          ...idParams(identity),
          identity.family ?? 'unknown',
          decision.metadataTier,
          decision.contentTier,
          decision.decidedBy,
          reasonsJson,
          decision.engineVersion,
          decision.mapRevision,
          decision.state,
          plan.stored?.trustDomain ?? null,
          plan.stored?.trustTier ?? null,
          ...decisionFlags(decision),
          decidedAt,
        );
        this.appendHistory(identity, 1, decision.metadataTier, decision.contentTier, decision.decidedBy, reasonsJson, decision.state, decidedAt);
        if (!secrets) this.insertCopies(identity, plan, 'current', 1, decidedAt);
        outcome = secrets ? 'secrets' : 'inserted';
        return;
      }
      if (existing.state === 'moving' && secrets && existing.routed) {
        // Secrets outrank a move in flight: every copy — current, staged or
        // superseded — is hidden now, the move is abandoned, and the caller
        // tombstones them all (the one mandatory deletion).
        const generation = existing.generation + 1;
        this.db.query(`
          UPDATE tier_copies SET copy_state = 'superseded', superseded_by_generation = ?, updated_at = ?
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
        `).run(generation, decidedAt, ...idParams(identity));
        this.flipTiers(identity, existing, {
          metadataTier: decision.metadataTier,
          contentTier: decision.contentTier,
          generation,
          decidedBy: decision.decidedBy,
          reasons: decision.reasons,
          decidedAt,
        });
        outcome = 'secrets';
        return;
      }
      if (existing.state === 'moving') {
        outcome = 'held_moving';
        return;
      }
      const tiersChanged = existing.metadataTier !== decision.metadataTier
        || existing.contentTier !== decision.contentTier;
      const current = previousCopies.filter((copy) => copy.state === 'current');
      const staged = previousCopies.some((copy) => copy.state === 'staged')
        && !(options.stagedLandingAllowed === true && !existing.contentRead);
      const firstPlacement = !existing.routed || options.staleCopiesGone === true;
      if (secrets || firstPlacement || (samePlan(current, plan.copies) && !staged)) {
        const generation = tiersChanged ? existing.generation + 1 : existing.generation;
        const detailChanged = tiersChanged
          || firstPlacement
          || JSON.stringify(existing.reasons) !== reasonsJson
          || existing.decidedBy !== decision.decidedBy
          || existing.state !== decision.state
          || existing.engineVersion !== decision.engineVersion
          || existing.mapRevision !== decision.mapRevision;
        if (detailChanged) {
          this.db.query(`
            UPDATE tier_items SET
              metadata_tier = ?, content_tier = ?, generation = ?, decided_by = ?, reasons_json = ?,
              engine_version = ?, map_revision = ?,
              previous_metadata_tier = ?, previous_content_tier = ?, state = ?,
              stored_trust_domain = COALESCE(?, stored_trust_domain),
              stored_trust_tier = COALESCE(?, stored_trust_tier),
              content_read = ?, metadata_pending = ?, content_pending = ?, metadata_forced = ?, metadata_flagged = ?,
              decided_at = ?, routed = 1
            WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
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
            plan.stored?.trustDomain ?? null,
            plan.stored?.trustTier ?? null,
            ...decisionFlags(decision),
            decidedAt,
            ...idParams(identity),
          );
          this.appendHistory(identity, generation, decision.metadataTier, decision.contentTier, decision.decidedBy, reasonsJson, decision.state, decidedAt);
        }
        if (secrets) {
          // Hidden now; the caller tombstones every store copy, then calls
          // removeCopies. Deleting the rows first would make the still-active
          // store rows read as legacy (visible) in between.
          this.supersedeCurrentCopies(identity, generation, decidedAt);
          outcome = 'secrets';
          return;
        }
        if (firstPlacement) {
          this.deleteCopies(identity);
          this.insertCopies(identity, plan, 'current', generation, decidedAt);
          outcome = 'inserted';
          return;
        }
        const holdChanged = current.some((copy) => copy.embedHold !== plan.embedHold);
        if (holdChanged) {
          this.db.query(`
            UPDATE tier_copies SET embed_hold = ?, updated_at = ?
            WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND copy_state = 'current'
          `).run(plan.embedHold ? 1 : 0, decidedAt, ...idParams(identity));
        }
        outcome = detailChanged || holdChanged ? 'updated' : 'unchanged';
        return;
      }

      // The decision needs different stores: queue a move, never perform it.
      raise = placementIsRaise(current, plan.copies);
      this.db.query(`
        UPDATE tier_items SET state = 'moving', target_metadata_tier = ?, target_content_tier = ?,
          decided_by = ?, reasons_json = ?, engine_version = ?, map_revision = ?, decided_at = ?
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      `).run(
        decision.metadataTier,
        decision.contentTier,
        decision.decidedBy,
        reasonsJson,
        decision.engineVersion,
        decision.mapRevision,
        decidedAt,
        ...idParams(identity),
      );
      this.appendHistory(identity, existing.generation, decision.metadataTier, decision.contentTier, decision.decidedBy, reasonsJson, 'moving', decidedAt);
      if (raise) this.supersedeCurrentCopies(identity, existing.generation + 1, decidedAt);
      outcome = 'queued_move';
    })();
    return { outcome, record: this.getCurrent(identity)!, previousCopies, raise };
  }

  /**
   * Before the first landing writes the content tier's row into a store that
   * holds no copy of the item yet, name that copy STAGED: a staged copy is
   * never searched, served, counted or embedded, so the row is hidden from
   * the moment it exists until `landExtractedContent` makes it current.
   * Nothing is staged over a current copy.
   */
  stageLandingCopy(
    identity: TierLedgerIdentity,
    copy: TierCopyPlan,
    options: { expectedGeneration: number; embedHold?: boolean },
  ): void {
    assertCopyPlan(copy);
    const now = this.now().toISOString();
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing || existing.generation !== options.expectedGeneration || existing.state === 'moving') {
        throw new TierLedgerGenerationConflictError();
      }
      if (!existing.routed || existing.contentRead) {
        throw new Error('Only a routed item whose text has not landed stages a landing copy.');
      }
      const rows = this.copies(identity).filter((row) => row.corpusId === copy.corpusId);
      if (rows.some((row) => row.state === 'current')) return;
      this.db.query(`
        DELETE FROM tier_copies
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND corpus_id = ?
      `).run(...idParams(identity), copy.corpusId);
      this.insertCopies(identity, { copies: [copy], embedHold: options.embedHold === true }, 'staged', existing.generation, now);
    })();
  }

  /**
   * The FIRST landing of a routed item's text, in a lane whose text arrives
   * after listing (the shared extraction factory). Until now the item had
   * only its metadata copy (or a whole Private copy while its names were
   * pending), so no store served its content: placing the content copy is a
   * first placement, not a move. In ONE transaction, compare-and-swap on the
   * generation:
   *
   * - the content half of the decision is recorded (text read, tier, reasons);
   * - every current copy keeps its store; the plan may widen a copy's layers
   *   (`metadata` -> `both`) or add the content tier's copy in another store,
   *   written by the caller BEFORE this call (and hidden until it: no copy row
   *   served it).
   *
   * Refused once text has landed (a re-judgment of landed content is a move:
   * `recordRoutedPlacement` queues it), mid-move, or when the plan would drop
   * or re-home a copy that serves the names.
   */
  landExtractedContent(
    identity: TierLedgerIdentity,
    decision: TierDecision,
    plan: TierPlacementPlan,
    options: { expectedGeneration: number },
  ): TierLedgerRecord {
    for (const copy of plan.copies) assertCopyPlan(copy);
    if (!decision.contentRead) throw new Error('Landing extracted content needs a decision made from that text.');
    if (plan.copies.length === 0) throw new Error('Landing extracted content needs at least one copy.');
    const now = this.now().toISOString();
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing || existing.generation !== options.expectedGeneration || existing.state === 'moving') {
        throw new TierLedgerGenerationConflictError();
      }
      if (!existing.routed) throw new Error('Only a routed item lands content through the tier set.');
      if (existing.contentRead) {
        throw new Error('This item\'s text already landed; a new content decision is a re-judgment, not a first landing.');
      }
      const current = this.copies(identity).filter((copy) => copy.state === 'current');
      for (const copy of current) {
        const planned = plan.copies.find((candidate) => candidate.corpusId === copy.corpusId);
        const servesNames = copy.layers === 'metadata' || copy.layers === 'both';
        if (!planned || (servesNames && planned.layers === 'content')) {
          throw new Error('Landing extracted content never moves or drops the copy that serves the names.');
        }
      }
      const tiersChanged = existing.metadataTier !== decision.metadataTier || existing.contentTier !== decision.contentTier;
      const generation = tiersChanged ? existing.generation + 1 : existing.generation;
      const reasonsJson = JSON.stringify(decision.reasons);
      this.db.query(`
        UPDATE tier_items SET
          metadata_tier = ?, content_tier = ?, generation = ?, decided_by = ?, reasons_json = ?,
          engine_version = ?, map_revision = ?,
          previous_metadata_tier = ?, previous_content_tier = ?, state = ?,
          stored_trust_domain = COALESCE(?, stored_trust_domain),
          stored_trust_tier = COALESCE(?, stored_trust_tier),
          content_read = ?, metadata_pending = ?, content_pending = ?, metadata_forced = ?, metadata_flagged = ?,
          decided_at = ?
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
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
        plan.stored?.trustDomain ?? null,
        plan.stored?.trustTier ?? null,
        ...decisionFlags(decision),
        now,
        ...idParams(identity),
      );
      this.appendHistory(identity, generation, decision.metadataTier, decision.contentTier, decision.decidedBy, reasonsJson, decision.state, now);
      for (const planned of plan.copies) {
        const row = current.find((copy) => copy.corpusId === planned.corpusId);
        if (row) {
          this.db.query(`
            UPDATE tier_copies SET layers = ?, embed_hold = ?, generation = ?, updated_at = ?
            WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND corpus_id = ?
          `).run(planned.layers, plan.embedHold ? 1 : 0, generation, now, ...idParams(identity), planned.corpusId);
          continue;
        }
        // A stale (superseded or staged) row for that store is replaced: the
        // caller just wrote the store's row for this landing.
        this.db.query(`
          DELETE FROM tier_copies
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND corpus_id = ?
        `).run(...idParams(identity), planned.corpusId);
        this.insertCopies(identity, { copies: [planned], embedHold: plan.embedHold }, 'current', generation, now);
      }
    })();
    return this.getCurrent(identity)!;
  }

  /**
   * Record where an item that predates P1b already lives, WITHOUT touching any
   * store. The move primitive works on copy rows, so P3's migration adopts a
   * legacy item's existing placement first. P1b never calls this on its own.
   */
  adoptLegacyPlacement(identity: TierLedgerIdentity, copies: readonly TierCopyPlan[]): TierLedgerRecord {
    for (const copy of copies) assertCopyPlan(copy);
    const now = this.now().toISOString();
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing) throw new Error('Adopting a placement needs a recorded decision first.');
      if (existing.routed) throw new Error('This item is already routed.');
      this.db.query(`
        UPDATE tier_items SET routed = 1
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      `).run(...idParams(identity));
      this.deleteCopies(identity);
      this.insertCopies(identity, { copies, embedHold: false }, 'current', existing.generation, now);
    })();
    return this.getCurrent(identity)!;
  }

  /**
   * Move step 1: mark the item mid-move and stage the destination copies,
   * which are never searched.
   *
   * `destination` is the item's full placement after the move. A store the
   * item already has a source copy in is NOT staged: the flip re-layers that
   * copy in place (the move writes whatever data it lacks first). Every other
   * destination is staged. The source copies stay current, except on a RAISE
   * (`hideSource`), where they are superseded first so the item is briefly
   * unsearchable instead of briefly visible in the lower tier.
   */
  stageMove(
    identity: TierLedgerIdentity,
    options: {
      expectedGeneration: number;
      target: { metadataTier: TierKey; contentTier: TierKey };
      destination: readonly TierCopyPlan[];
      hideSource: boolean;
      embedHold?: boolean;
    },
  ): TierLedgerRecord {
    assertTier(options.target.metadataTier);
    assertTier(options.target.contentTier);
    if (options.destination.length === 0) throw new Error('A move needs at least one destination copy.');
    for (const copy of options.destination) assertCopyPlan(copy);
    const now = this.now().toISOString();
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing || existing.generation !== options.expectedGeneration) {
        throw new TierLedgerGenerationConflictError();
      }
      if (!existing.routed) throw new Error('A move needs copy rows; adopt the legacy placement first.');
      if (existing.state === 'moving'
        && (existing.targetMetadataTier !== options.target.metadataTier
          || existing.targetContentTier !== options.target.contentTier)) {
        throw new TierLedgerGenerationConflictError('The item is already moving toward different tiers.');
      }
      const nextGeneration = existing.generation + 1;
      const sources = this.moveSources(identity, nextGeneration);
      this.db.query(`
        UPDATE tier_items SET state = 'moving', target_metadata_tier = ?, target_content_tier = ?
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      `).run(options.target.metadataTier, options.target.contentTier, ...idParams(identity));
      if (options.hideSource) this.supersedeCurrentCopies(identity, nextGeneration, now);
      const staged = options.destination.filter((copy) => !sources.some((source) => source.corpusId === copy.corpusId));
      for (const destination of staged) {
        // A stale superseded copy in the destination store is replaced: the
        // move rewrites that store's row, so the old row stops being "kept".
        this.db.query(`
          DELETE FROM tier_copies
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND corpus_id = ?
        `).run(...idParams(identity), destination.corpusId);
      }
      this.insertCopies(identity, { copies: staged, embedHold: options.embedHold === true }, 'staged', nextGeneration, now);
    })();
    return this.getCurrent(identity)!;
  }

  /**
   * The copies a move starts from: current ones, plus the ones a hide-first
   * raise superseded for this very move.
   */
  private moveSources(identity: TierLedgerIdentity, moveGeneration: number): TierCopy[] {
    return this.copies(identity).filter((copy) => copy.state === 'current'
      || (copy.state === 'superseded' && copy.supersededByGeneration === moveGeneration));
  }

  /**
   * Move step 2, the flip: in ONE write every copy in `destination` becomes
   * current with its planned layers, every other source copy becomes
   * superseded, and the target tiers become the item's tiers.
   * Compare-and-swap on the generation.
   */
  completeMove(
    identity: TierLedgerIdentity,
    options: {
      expectedGeneration: number;
      destination: readonly TierCopyPlan[];
      decidedBy?: TierDecidedBy | 'move';
      reasons?: readonly string[];
    },
  ): TierLedgerRecord {
    for (const copy of options.destination) assertCopyPlan(copy);
    const now = this.now().toISOString();
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing || existing.generation !== options.expectedGeneration || existing.state !== 'moving'
        || existing.targetMetadataTier === null || existing.targetContentTier === null) {
        throw new TierLedgerGenerationConflictError();
      }
      const generation = existing.generation + 1;
      const copies = this.copies(identity);
      const sources = this.moveSources(identity, generation);
      for (const planned of options.destination) {
        const row = copies.find((copy) => copy.corpusId === planned.corpusId);
        if (!row) throw new Error('A move completes only once every destination copy is staged or kept.');
        if (row.state === 'staged') {
          this.db.query(`
            UPDATE tier_copies SET copy_state = 'current', layers = ?, generation = ?,
              superseded_by_generation = NULL, previous_layers = NULL, updated_at = ?
            WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND corpus_id = ?
          `).run(planned.layers, generation, now, ...idParams(identity), planned.corpusId);
        } else if (sources.some((source) => source.corpusId === planned.corpusId)) {
          this.db.query(`
            UPDATE tier_copies SET copy_state = 'current', layers = ?, generation = ?,
              superseded_by_generation = NULL, previous_layers = ?, updated_at = ?
            WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND corpus_id = ?
          `).run(planned.layers, generation, row.layers, now, ...idParams(identity), planned.corpusId);
        } else {
          throw new Error('A move destination must be staged or be one of the item\'s source copies.');
        }
      }
      for (const source of sources) {
        if (options.destination.some((planned) => planned.corpusId === source.corpusId)) continue;
        this.db.query(`
          UPDATE tier_copies SET copy_state = 'superseded', superseded_by_generation = ?, previous_layers = NULL, updated_at = ?
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND corpus_id = ?
        `).run(generation, now, ...idParams(identity), source.corpusId);
      }
      this.flipTiers(identity, existing, {
        metadataTier: existing.targetMetadataTier,
        contentTier: existing.targetContentTier,
        generation,
        decidedBy: options.decidedBy ?? 'move',
        reasons: options.reasons ?? existing.reasons,
        decidedAt: now,
      });
    })();
    return this.getCurrent(identity)!;
  }

  /**
   * Rollback is a ledger flip: the copies the last flip superseded become
   * current again, re-layered copies get their old layers back, and the copies
   * the flip made current become superseded. No store is written and nothing
   * is re-embedded.
   */
  rollbackMove(identity: TierLedgerIdentity, options: { expectedGeneration: number }): TierLedgerRecord {
    const now = this.now().toISOString();
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing || existing.generation !== options.expectedGeneration || existing.state !== 'current'
        || existing.previousMetadataTier === null || existing.previousContentTier === null) {
        throw new TierLedgerGenerationConflictError();
      }
      const flipGeneration = existing.generation;
      const copies = this.copies(identity);
      const restore = copies.filter((copy) => copy.state === 'superseded' && copy.supersededByGeneration === flipGeneration);
      const relayered = copies.filter((copy) => copy.state === 'current' && copy.generation === flipGeneration && copy.previousLayers !== null);
      if (restore.length === 0 && relayered.length === 0) {
        throw new Error('Nothing to roll back to: the last flip superseded or re-layered no copy.');
      }
      const generation = flipGeneration + 1;
      for (const copy of copies) {
        if (copy.state !== 'current' || copy.generation !== flipGeneration) continue;
        if (copy.previousLayers !== null) {
          this.db.query(`
            UPDATE tier_copies SET layers = ?, previous_layers = NULL, generation = ?, updated_at = ?
            WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND corpus_id = ?
          `).run(copy.previousLayers, generation, now, ...idParams(identity), copy.corpusId);
        } else {
          this.db.query(`
            UPDATE tier_copies SET copy_state = 'superseded', superseded_by_generation = ?, updated_at = ?
            WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND corpus_id = ?
          `).run(generation, now, ...idParams(identity), copy.corpusId);
        }
      }
      for (const copy of restore) {
        this.db.query(`
          UPDATE tier_copies SET copy_state = 'current', generation = ?, superseded_by_generation = NULL, updated_at = ?
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND corpus_id = ?
        `).run(generation, now, ...idParams(identity), copy.corpusId);
      }
      this.flipTiers(identity, existing, {
        metadataTier: existing.previousMetadataTier,
        contentTier: existing.previousContentTier,
        generation,
        decidedBy: 'rollback',
        reasons: existing.reasons,
        decidedAt: now,
      });
    })();
    return this.getCurrent(identity)!;
  }

  /**
   * A move to Secrets: hide every copy at once and make Secrets the item's
   * tiers. The caller then tombstones each store copy (vectors deleted, the
   * one mandatory deletion) and calls `removeCopies`.
   */
  flipToSecrets(
    identity: TierLedgerIdentity,
    options: { expectedGeneration: number; reasons?: readonly string[] },
  ): { record: TierLedgerRecord; copies: TierCopy[] } {
    const now = this.now().toISOString();
    let copies: TierCopy[] = [];
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing || existing.generation !== options.expectedGeneration) {
        throw new TierLedgerGenerationConflictError();
      }
      if (!existing.routed) throw new Error('A move needs copy rows; adopt the legacy placement first.');
      copies = this.copies(identity);
      const generation = existing.generation + 1;
      this.supersedeCurrentCopies(identity, generation, now);
      this.flipTiers(identity, existing, {
        metadataTier: 'secrets',
        contentTier: 'secrets',
        generation,
        decidedBy: 'secret_detector',
        reasons: options.reasons ?? existing.reasons,
        decidedAt: now,
      });
    })();
    return { record: this.getCurrent(identity)!, copies };
  }

  /**
   * Forget every copy row of an item: its provider deleted it, or it became
   * Secrets. The caller tombstones the store rows first; the item stays
   * `routed`, so a later reappearance is routed again rather than treated as
   * pre-P1b data.
   */
  removeCopies(identity: TierLedgerIdentity): TierCopy[] {
    let removed: TierCopy[] = [];
    this.db.transaction(() => {
      removed = this.copies(identity);
      this.deleteCopies(identity);
    })();
    return removed;
  }

  /**
   * Whether any routed item has a copy (in any state) in this store. False
   * means every row in the store is legacy, so readers can skip the filter.
   */
  corpusHasCopies(corpusId: string): boolean {
    return this.db.query('SELECT 1 FROM tier_copies WHERE corpus_id = ? LIMIT 1').get(corpusId) !== null;
  }

  /**
   * Every item with a copy in this store in the given state. Paged by key
   * internally, with no ceiling: a filter that silently stopped at N items
   * would let the N+1st superseded copy be searched and counted.
   */
  corpusCopyIdentities(
    corpusId: string,
    filter: 'superseded' | 'staged' | 'held' | 'metadata_layer',
  ): TierLedgerIdentity[] {
    const where = filter === 'held'
      ? `copy_state = 'current' AND embed_hold = 1`
      : filter === 'metadata_layer'
        ? `copy_state = 'current' AND layers = 'metadata'`
        : `copy_state = '${filter === 'superseded' ? 'superseded' : 'staged'}'`;
    const page = this.db.query(`
      SELECT provider, account_scope, conversation_key, provider_item_id FROM tier_copies
      WHERE corpus_id = ? AND ${where}
        AND (provider, account_scope, conversation_key, provider_item_id) > (?, ?, ?, ?)
      ORDER BY provider, account_scope, conversation_key, provider_item_id
      LIMIT 5000
    `);
    const identities: TierLedgerIdentity[] = [];
    let after: [string, string, string, string] = ['', '', '', ''];
    for (;;) {
      const rows = page.all(corpusId, ...after) as TierIdentityRow[];
      for (const row of rows) identities.push(identityFromRow(row));
      if (rows.length < 5000) break;
      const last = rows[rows.length - 1]!;
      after = [last.provider, last.account_scope, last.conversation_key, last.provider_item_id];
    }
    return identities;
  }

  /** Content-free per-store counts for status surfaces. */
  corpusCopyCounts(corpusId: string): { current: number; superseded: number; staged: number; held: number; moving: number } {
    const row = this.db.query(`
      SELECT
        SUM(CASE WHEN c.copy_state = 'current' THEN 1 ELSE 0 END) AS current,
        SUM(CASE WHEN c.copy_state = 'superseded' THEN 1 ELSE 0 END) AS superseded,
        SUM(CASE WHEN c.copy_state = 'staged' THEN 1 ELSE 0 END) AS staged,
        SUM(CASE WHEN c.copy_state = 'current' AND c.embed_hold = 1 THEN 1 ELSE 0 END) AS held,
        SUM(CASE WHEN t.state = 'moving' THEN 1 ELSE 0 END) AS moving
      FROM tier_copies c
      JOIN tier_items t
        ON t.provider = c.provider AND t.account_scope = c.account_scope
          AND t.conversation_key = c.conversation_key AND t.provider_item_id = c.provider_item_id
      WHERE c.corpus_id = ?
    `).get(corpusId) as Record<string, number | null>;
    return {
      current: row['current'] ?? 0,
      superseded: row['superseded'] ?? 0,
      staged: row['staged'] ?? 0,
      held: row['held'] ?? 0,
      moving: row['moving'] ?? 0,
    };
  }

  /**
   * A tiered store set's resume point, written only after EVERY leg of a run
   * committed. A leg's own sync-run row can be ahead of its siblings when a
   * run dies between legs; this row never is.
   */
  commitSetCursor(setId: string, connectorId: string, cursor: string | null): void {
    this.db.query(`
      INSERT INTO tier_set_cursors (set_id, connector_id, cursor, committed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (set_id, connector_id)
      DO UPDATE SET cursor = excluded.cursor, committed_at = excluded.committed_at
    `).run(setId, connectorId, cursor, this.now().toISOString());
  }

  setCursor(setId: string, connectorId: string): { cursor: string | null; committedAt: string } | undefined {
    const row = this.db.query(`
      SELECT cursor, committed_at FROM tier_set_cursors WHERE set_id = ? AND connector_id = ?
    `).get(setId, connectorId) as { cursor: string | null; committed_at: string } | null;
    return row ? { cursor: row.cursor, committedAt: row.committed_at } : undefined;
  }

  private insertCopies(
    identity: TierLedgerIdentity,
    plan: Pick<TierPlacementPlan, 'copies' | 'embedHold'>,
    state: TierCopyState,
    generation: number,
    now: string,
  ): void {
    const insert = this.db.query(`
      INSERT INTO tier_copies (
        provider, account_scope, conversation_key, provider_item_id, corpus_id, trust_domain,
        layers, copy_state, embed_hold, generation, superseded_by_generation, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `);
    for (const copy of plan.copies) {
      insert.run(
        ...idParams(identity),
        copy.corpusId,
        copy.trustDomain,
        copy.layers,
        state,
        plan.embedHold ? 1 : 0,
        generation,
        now,
      );
    }
  }

  private deleteCopies(identity: TierLedgerIdentity): void {
    this.db.query(`
      DELETE FROM tier_copies WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).run(...idParams(identity));
  }

  private supersedeCurrentCopies(identity: TierLedgerIdentity, byGeneration: number, now: string): void {
    this.db.query(`
      UPDATE tier_copies SET copy_state = 'superseded', superseded_by_generation = ?, updated_at = ?
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND copy_state = 'current'
    `).run(byGeneration, now, ...idParams(identity));
  }

  private flipTiers(
    identity: TierLedgerIdentity,
    existing: TierLedgerRecord,
    next: {
      metadataTier: TierKey;
      contentTier: TierKey;
      generation: number;
      decidedBy: string;
      reasons: readonly string[];
      decidedAt: string;
    },
  ): void {
    const reasonsJson = JSON.stringify(next.reasons);
    this.db.query(`
      UPDATE tier_items SET
        metadata_tier = ?, content_tier = ?, generation = ?, decided_by = ?, reasons_json = ?,
        previous_metadata_tier = ?, previous_content_tier = ?, state = 'current',
        target_metadata_tier = NULL, target_content_tier = NULL, decided_at = ?
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).run(
      next.metadataTier,
      next.contentTier,
      next.generation,
      next.decidedBy,
      reasonsJson,
      existing.metadataTier,
      existing.contentTier,
      next.decidedAt,
      ...idParams(identity),
    );
    this.appendHistory(identity, next.generation, next.metadataTier, next.contentTier, next.decidedBy, reasonsJson, 'current', next.decidedAt);
  }

  private readRow(identity: TierLedgerIdentity): TierLedgerRecord | undefined {
    const row = this.db.query(`
      SELECT * FROM tier_items WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).get(...idParams(identity)) as TierItemRow | null;
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
        provider, account_scope, conversation_key, provider_item_id, generation,
        metadata_tier, content_tier, decided_by, reasons_json, state, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...idParams(identity), generation, metadataTier, contentTier, decidedBy, reasonsJson, state, decidedAt);
  }
}

interface TierItemRow {
  provider: string;
  account_scope: string;
  conversation_key: string;
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
  content_read: number;
  metadata_pending: number;
  content_pending: number;
  metadata_forced: number;
  metadata_flagged: number;
  decided_at: string;
  routed: number;
}

interface TierCopyRow {
  provider: string;
  account_scope: string;
  conversation_key: string;
  provider_item_id: string;
  corpus_id: string;
  trust_domain: SourceTrustDomain;
  layers: TierCopyLayers;
  copy_state: TierCopyState;
  embed_hold: number;
  generation: number;
  superseded_by_generation: number | null;
  previous_layers: TierCopyLayers | null;
  updated_at: string;
}

interface TierIdentityRow {
  provider: string;
  account_scope: string;
  conversation_key: string;
  provider_item_id: string;
}

function identityFromRow(row: TierIdentityRow): TierLedgerIdentity {
  return {
    provider: row.provider,
    accountScope: row.account_scope,
    providerItemId: row.provider_item_id,
    ...(row.conversation_key ? { providerConversationId: row.conversation_key } : {}),
  };
}

function copyFromRow(row: TierCopyRow): TierCopy {
  return {
    corpusId: row.corpus_id,
    trustDomain: row.trust_domain,
    layers: row.layers,
    state: row.copy_state,
    embedHold: row.embed_hold === 1,
    generation: row.generation,
    supersededByGeneration: row.superseded_by_generation,
    previousLayers: row.previous_layers,
    updatedAt: row.updated_at,
  };
}

/** Stable map key for an item identity in ledger lookups. */
export function tierLedgerIdentityKey(identity: TierLedgerIdentity): string {
  return `${identity.provider}\u0000${identity.accountScope}\u0000${tierLedgerConversationKey(identity)}\u0000${identity.providerItemId}`;
}

const TRUST_DOMAIN_RANK: Readonly<Record<SourceTrustDomain, number>> = {
  public_safe: 0,
  internal: 1,
  secure_local: 2,
};

export function trustDomainRank(domain: SourceTrustDomain): number {
  return TRUST_DOMAIN_RANK[domain] ?? Number.MAX_SAFE_INTEGER;
}

/** Which store copy serves a layer, or undefined when none does. */
export function copyServingLayer<T extends Pick<TierCopy, 'layers'>>(
  copies: readonly T[],
  layer: TierSearchLayer,
): T | undefined {
  return copies.find((copy) => copy.layers === 'both' || copy.layers === layer);
}

function samePlan(current: readonly TierCopy[], planned: readonly TierCopyPlan[]): boolean {
  if (current.length !== planned.length) return false;
  return planned.every((plan) => current.some((copy) => copy.corpusId === plan.corpusId
    && copy.trustDomain === plan.trustDomain
    && copy.layers === plan.layers));
}

/**
 * A placement change is a RAISE when either layer ends in a more private
 * store than the one serving it now. A layer with no current copy is not a
 * raise on its own: it has nothing visible to hide.
 */
export function placementIsRaise(
  current: readonly Pick<TierCopy, 'trustDomain' | 'layers'>[],
  planned: readonly Pick<TierCopyPlan, 'trustDomain' | 'layers'>[],
): boolean {
  for (const layer of ['metadata', 'content'] as const) {
    const from = copyServingLayer(current, layer);
    const to = copyServingLayer(planned, layer);
    if (from && to && trustDomainRank(to.trustDomain) > trustDomainRank(from.trustDomain)) return true;
    if (from && !to) return true;
  }
  return false;
}

function assertCopyPlan(copy: TierCopyPlan): void {
  if (!copy.corpusId?.trim()) throw new Error('A tier copy names its store.');
  if (!(copy.trustDomain in TRUST_DOMAIN_RANK)) throw new Error(`Unknown trust domain "${copy.trustDomain}".`);
  if (copy.layers !== 'metadata' && copy.layers !== 'content' && copy.layers !== 'both') {
    throw new Error(`Unknown copy layers "${String(copy.layers)}".`);
  }
}

function recordFromRow(row: TierItemRow): TierLedgerRecord {
  return {
    provider: row.provider,
    accountScope: row.account_scope,
    conversationKey: row.conversation_key,
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
    contentRead: row.content_read === 1,
    metadataPending: row.metadata_pending === 1,
    contentPending: row.content_pending === 1,
    metadataForced: row.metadata_forced === 1,
    metadataFlagged: row.metadata_flagged === 1,
    decidedAt: row.decided_at,
    routed: row.routed === 1,
  };
}

interface EffectiveRow {
  metadataTier: TierKey;
  contentTier: TierKey;
  decidedBy: string;
  reasons: string[];
  engineVersion: string;
  mapRevision: string;
  contentRead: boolean;
  metadataPending: boolean;
  contentPending: boolean;
  metadataForced: boolean;
  metadataFlagged: boolean;
}

/**
 * Merge a fresh classifier decision with the stored row. A decision that did
 * not read the text says nothing about the content, so it can raise the
 * content tier (content is at least the metadata tier) but never replace or
 * lower one.
 */
function effectiveRow(existing: TierLedgerRecord | undefined, decision: TierDecision): EffectiveRow {
  const fresh: EffectiveRow = {
    metadataTier: decision.metadataTier,
    contentTier: decision.contentTier,
    decidedBy: decision.decidedBy,
    reasons: decision.reasons,
    engineVersion: decision.engineVersion,
    mapRevision: decision.mapRevision,
    contentRead: decision.contentRead,
    metadataPending: decision.metadataPending,
    contentPending: decision.contentPending,
    metadataForced: decision.metadataForced,
    metadataFlagged: decision.metadataFlagged,
  };
  if (!existing || decision.contentRead) return fresh;
  if (existing.contentRead) {
    const metadataReasons = decision.reasons.filter((reason) => !reason.startsWith('content:'));
    const contentReasons = existing.reasons.filter((reason) => reason.startsWith('content:'));
    return {
      ...fresh,
      contentTier: maxTier(existing.contentTier, decision.metadataTier),
      decidedBy: existing.decidedBy,
      reasons: [...metadataReasons, ...contentReasons],
      contentRead: true,
      contentPending: existing.contentPending,
    };
  }
  return { ...fresh, contentTier: maxTier(existing.contentTier, decision.contentTier) };
}

function decisionFlags(decision: TierDecision): [number, number, number, number, number] {
  return [
    decision.contentRead ? 1 : 0,
    decision.metadataPending ? 1 : 0,
    decision.contentPending ? 1 : 0,
    decision.metadataForced ? 1 : 0,
    decision.metadataFlagged ? 1 : 0,
  ];
}

/** Owner-only permissions on the ledger and its SQLite sidecars. */
function restrictLedgerFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
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
      version: 1,
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
            content_read INTEGER NOT NULL DEFAULT 0 CHECK (content_read IN (0, 1)),
            metadata_pending INTEGER NOT NULL DEFAULT 0 CHECK (metadata_pending IN (0, 1)),
            content_pending INTEGER NOT NULL DEFAULT 0 CHECK (content_pending IN (0, 1)),
            metadata_forced INTEGER NOT NULL DEFAULT 0 CHECK (metadata_forced IN (0, 1)),
            metadata_flagged INTEGER NOT NULL DEFAULT 0 CHECK (metadata_flagged IN (0, 1)),
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
    {
      // P1b: per-store copies (the visibility switch), the routed flag, and
      // tiered-store-set resume points. Additive only: every P1a row keeps
      // routed = 0 and gains no copy rows, which is exactly "legacy item,
      // visible where it already is".
      version: TIER_LEDGER_SCHEMA_VERSION,
      name: 'tier_copies_and_set_cursors',
      up(db) {
        // The conversation joins the identity: chat providers reuse message
        // ids across chats. The three P1a tables are rebuilt with a
        // conversation_key in their keys; every P1a row is kept, with ''
        // (P1a never recorded a conversation). Nothing else about a row
        // changes, so every P1a row stays a legacy row.
        db.exec(`
          ALTER TABLE tier_items RENAME TO tier_items_v1;
          ALTER TABLE tier_history RENAME TO tier_history_v1;
          ALTER TABLE tier_overrides RENAME TO tier_overrides_v1;
          DROP INDEX IF EXISTS tier_items_state;
          DROP INDEX IF EXISTS tier_history_item;
          CREATE TABLE tier_items (
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            conversation_key TEXT NOT NULL DEFAULT '',
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
            content_read INTEGER NOT NULL DEFAULT 0 CHECK (content_read IN (0, 1)),
            metadata_pending INTEGER NOT NULL DEFAULT 0 CHECK (metadata_pending IN (0, 1)),
            content_pending INTEGER NOT NULL DEFAULT 0 CHECK (content_pending IN (0, 1)),
            metadata_forced INTEGER NOT NULL DEFAULT 0 CHECK (metadata_forced IN (0, 1)),
            metadata_flagged INTEGER NOT NULL DEFAULT 0 CHECK (metadata_flagged IN (0, 1)),
            decided_at TEXT NOT NULL,
            routed INTEGER NOT NULL DEFAULT 0 CHECK (routed IN (0, 1)),
            PRIMARY KEY (provider, account_scope, conversation_key, provider_item_id)
          );
          INSERT INTO tier_items (
            provider, account_scope, conversation_key, provider_item_id, family,
            metadata_tier, content_tier, generation, decided_by, reasons_json,
            engine_version, map_revision, model_id,
            previous_metadata_tier, previous_content_tier, state,
            target_metadata_tier, target_content_tier,
            stored_trust_domain, stored_trust_tier,
            content_read, metadata_pending, content_pending, metadata_forced, metadata_flagged,
            decided_at, routed
          )
          SELECT
            provider, account_scope, '', provider_item_id, family,
            metadata_tier, content_tier, generation, decided_by, reasons_json,
            engine_version, map_revision, model_id,
            previous_metadata_tier, previous_content_tier, state,
            target_metadata_tier, target_content_tier,
            stored_trust_domain, stored_trust_tier,
            content_read, metadata_pending, content_pending, metadata_forced, metadata_flagged,
            decided_at, 0
          FROM tier_items_v1;
          DROP TABLE tier_items_v1;
          CREATE INDEX tier_items_state ON tier_items (state, provider, account_scope, provider_item_id, conversation_key);
          CREATE TABLE tier_history (
            history_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            conversation_key TEXT NOT NULL DEFAULT '',
            provider_item_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            metadata_tier TEXT NOT NULL,
            content_tier TEXT NOT NULL,
            decided_by TEXT NOT NULL,
            reasons_json TEXT NOT NULL,
            state TEXT NOT NULL,
            decided_at TEXT NOT NULL
          );
          INSERT INTO tier_history (
            history_pk, provider, account_scope, conversation_key, provider_item_id, generation,
            metadata_tier, content_tier, decided_by, reasons_json, state, decided_at
          )
          SELECT history_pk, provider, account_scope, '', provider_item_id, generation,
            metadata_tier, content_tier, decided_by, reasons_json, state, decided_at
          FROM tier_history_v1;
          DROP TABLE tier_history_v1;
          CREATE INDEX tier_history_item ON tier_history (provider, account_scope, conversation_key, provider_item_id, history_pk);
          CREATE TABLE tier_overrides (
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            conversation_key TEXT NOT NULL DEFAULT '',
            provider_item_id TEXT NOT NULL,
            override_json TEXT NOT NULL,
            set_at TEXT NOT NULL,
            PRIMARY KEY (provider, account_scope, conversation_key, provider_item_id)
          );
          INSERT INTO tier_overrides (provider, account_scope, conversation_key, provider_item_id, override_json, set_at)
          SELECT provider, account_scope, '', provider_item_id, override_json, set_at FROM tier_overrides_v1;
          DROP TABLE tier_overrides_v1;
          CREATE TABLE IF NOT EXISTS tier_ledger_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          INSERT OR IGNORE INTO tier_ledger_meta (key, value) VALUES ('ledger_id', lower(hex(randomblob(16))));
          CREATE TABLE IF NOT EXISTS tier_copies (
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            conversation_key TEXT NOT NULL DEFAULT '',
            provider_item_id TEXT NOT NULL,
            corpus_id TEXT NOT NULL,
            trust_domain TEXT NOT NULL CHECK (trust_domain IN ('public_safe', 'internal', 'secure_local')),
            layers TEXT NOT NULL CHECK (layers IN ('metadata', 'content', 'both')),
            copy_state TEXT NOT NULL CHECK (copy_state IN ('current', 'staged', 'superseded')),
            embed_hold INTEGER NOT NULL DEFAULT 0 CHECK (embed_hold IN (0, 1)),
            generation INTEGER NOT NULL CHECK (generation >= 1),
            superseded_by_generation INTEGER,
            previous_layers TEXT CHECK (previous_layers IS NULL OR previous_layers IN ('metadata', 'content', 'both')),
            updated_at TEXT NOT NULL,
            PRIMARY KEY (provider, account_scope, conversation_key, provider_item_id, corpus_id)
          );
          CREATE INDEX IF NOT EXISTS tier_copies_corpus ON tier_copies (corpus_id, copy_state, embed_hold);
          CREATE TABLE IF NOT EXISTS tier_set_cursors (
            set_id TEXT NOT NULL,
            connector_id TEXT NOT NULL,
            cursor TEXT,
            committed_at TEXT NOT NULL,
            PRIMARY KEY (set_id, connector_id)
          );
        `);
      },
    },
  ];
}

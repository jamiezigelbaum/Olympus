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
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SourceItemIdentity, SourceTrustDomain, SourceTrustTier } from '../../core/source-index/types.ts';
import { readSqliteSchemaVersion, runSqliteMigrations, type SqliteMigration } from '../../core/sqlite-migrations.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import {
  TIER_KEYS,
  contentJudgeVerdictReason,
  maxTier,
  tierRank,
  type ContentTierDecision,
  type ItemTierOverride,
  type TierDecidedBy,
  type TierDecision,
  type TierKey,
} from './tier-classifier.ts';
import { TIER_LEDGER_SQLITE_STORE_ID, tierLedgerPathForStore } from './tier-ledger-path.ts';

export { TIER_LEDGER_SQLITE_STORE_ID, tierLedgerPathForStore };
export const TIER_LEDGER_SCHEMA_VERSION = 12;

/** A scrub's start: the revision it took and the item's generation then. */
export interface SecretScrubMark {
  revision: number;
  generation: number | null;
}

export type TierLedgerState = 'pending' | 'current' | 'moving';

/**
 * An item's ledger identity. The conversation is part of it: chat providers
 * reuse message ids across chats, so provider + account + item id alone would
 * make two different messages one ledger row. Absent means "no conversation"
 * (''), exactly as the connector store normalizes it.
 */
/**
 * Whether a reason records content held fail-safe Private without a verdict on
 * its text: a question lost from the queue (`missing_question`), or text never
 * read, so no question could exist yet (`unread`). Either way the item is owed
 * a verdict once its text is read.
 */
export function isFailSafeMissingContentQuestion(reason: string): boolean {
  return reason.startsWith('content:sniffer:')
    && (reason.endsWith(':fail_safe:missing_question') || reason.endsWith(':fail_safe:unread'));
}

/** The meta key set once every unread fail-safe row carries the `unread` label (#847). */
export const TIER_LEDGER_UNREAD_RELABEL_DONE = 'fail_safe_unread_relabel_v1';

export type TierLedgerIdentity = Pick<SourceItemIdentity, 'provider' | 'accountScope' | 'providerItemId'>
  & Partial<Pick<SourceItemIdentity, 'family' | 'providerConversationId'>>;

/** The stored conversation key: the store's own normalization. */
export function tierLedgerConversationKey(identity: Pick<TierLedgerIdentity, 'providerConversationId'>): string {
  return identity.providerConversationId ?? '';
}

export type TierWriteIntentKind = 'content' | 'names' | 'advance' | 'deletion' | 'secret';

/**
 * What an item's legs are about to receive. `advance` (a version move over rows that hold the item), `deletion` and
 * `secret` are finished from the intent alone: the next pass does it before anything reads the item. `content` (a
 * body) and `names` (an item written by its names) are owed until their own record is read again, since the body
 * and the names are not kept here.
 */
export interface TierWriteIntent {
  identity: TierLedgerIdentity & { localItemId?: string };
  version?: string;
  kind: TierWriteIntentKind;
  /** A Secret no store holds a row for: its location row is written by the store's own pass, so the intent stays owed. */
  location?: boolean;
  /**
   * The version of the record whose body this `content` write carries, when it is older than `version` (a names-only
   * record of a newer version took an older record's body): that record, replayed, is what finishes the write.
   */
  bodyVersion?: string;
  /** The item's family: what a location row written from the intent alone needs. */
  itemFamily?: string;
  connectorId: string;
}

interface TierWriteIntentRow {
  provider: string;
  account_scope: string;
  conversation_key: string;
  provider_item_id: string;
  local_item_id: string;
  source_version: string | null;
  kind: TierWriteIntentKind;
  location: number;
  connector_id: string;
  body_version: string | null;
  item_family: string | null;
}

function writeIntentFromRow(row: TierWriteIntentRow): TierWriteIntent {
  return {
    identity: {
      provider: row.provider,
      accountScope: row.account_scope,
      providerItemId: row.provider_item_id,
      ...(row.conversation_key !== '' ? { providerConversationId: row.conversation_key } : {}),
      ...(row.local_item_id !== '' ? { localItemId: row.local_item_id } : {}),
    } as TierLedgerIdentity & { localItemId?: string },
    ...(row.source_version !== null ? { version: row.source_version } : {}),
    kind: row.kind,
    ...(row.location === 1 ? { location: true as const } : {}),
    ...(row.body_version !== null ? { bodyVersion: row.body_version } : {}),
    ...(row.item_family !== null ? { itemFamily: row.item_family } : {}),
    connectorId: row.connector_id,
  };
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
  /**
   * The generation whose flip superseded this copy. Null on other states
   * and on an abandoned destination: hidden, but never a rollback source.
   */
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

/**
 * What a background pass read before it acts on an owner override: the
 * item's generation and the override itself. The write re-reads both inside
 * its own transaction and refuses (TierLedgerGenerationConflictError) when
 * either changed, so an override replaced or cleared by another process in
 * between never authorizes anything.
 */
export interface TierOwnerOverrideGuard {
  generation: number;
  override: ItemTierOverride | undefined;
}

/** What `queueOwnerRaise` did: hid copies and queued, only retargeted a move in flight, or nothing. */
export type TierOwnerRaiseOutcome = 'hidden' | 'retargeted' | 'none';

/**
 * What `settleRevokedOwnerMove` did with a move an owner override queued that
 * the override no longer asks for: cancelled it (it hid nothing, the item
 * stays where it is), replanned it from its hidden sources (they stay hidden
 * until the replanned move lands), or nothing (no such move).
 */
type TierRevokedOwnerMoveOutcome = 'cancelled' | 'replanned' | 'none';

/** What the queued-move write records of a decision (`queueMoveRow`). */
type QueuedMoveDecision = Pick<
  TierDecision,
  'metadataTier' | 'contentTier' | 'reasons' | 'engineVersion' | 'mapRevision'
  | 'contentRead' | 'metadataPending' | 'contentPending' | 'metadataForced' | 'metadataFlagged'
> & { decidedBy: string };

/** The decision an owner override took a row over from (`owner_prior_json`). */
type OwnerPriorDecision = Omit<QueuedMoveDecision, 'metadataTier' | 'contentTier'>;

export interface TierLedgerOptions {
  dbPath: string;
  /** Inspection only: no migrations, repairs, permissions or checkpoint on close. */
  readOnly?: boolean;
  now?: () => Date;
}

/** Ledger rows one `rejudgeCandidatePage` call reads at most. */
export const DEFAULT_REJUDGE_SCAN_ROWS = 2_000;

/**
 * A re-judge that found no serving text to read (`markRejudgeUnavailable`)
 * tries the row again after this wait, doubling per miss up to the maximum.
 * A newer decision of the row (a landing that stores its text again) makes
 * it a candidate at once.
 */
export const REJUDGE_UNAVAILABLE_RETRY_MS = 60 * 60 * 1000;
export const REJUDGE_UNAVAILABLE_MAX_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * An open re-judge question (`openRejudgeQuestion`): the decision the
 * sniffer's answer completes. The item stays where it is until then.
 */
export interface TierRejudgeQuestion {
  /** The re-judge's decision, its content question open (`contentPending`). */
  decision: TierDecision;
  /** A raise the answer needs is queued without hiding (moves wait for the owner-approved migration). */
  keepVisible: boolean;
}

interface StoredRejudgeQuestion extends TierRejudgeQuestion {
  /**
   * The row's decision when asked (generation, time, reasons, decider): any
   * newer decision changes one of them and makes the question stale.
   */
  generation: number;
  decidedAt: string;
  reasonsJson: string;
  decidedBy: string;
}

/**
 * The SQL that narrows `state = 'moving'` rows of `tier_items` to raises or
 * lowerings (empty for both). Shared with read-only counts that open the
 * ledger file themselves (classification/sniffer-service.ts).
 */
export function tierMovingDirectionClause(direction?: 'raise' | 'lower'): string {
  if (!direction) return '';
  // A hide-first move also wins if it was retargeted at the same tiers.
  const rank = (column: string) => `(CASE ${column} WHEN 'secrets' THEN 3 WHEN 'secure' THEN 2 WHEN 'private' THEN 1 ELSE 0 END)`;
  const raising = `(${rank('target_metadata_tier')} > ${rank('metadata_tier')}
    OR ${rank('target_content_tier')} > ${rank('content_tier')}
    OR EXISTS (SELECT 1 FROM tier_copies c WHERE c.provider = tier_items.provider
      AND c.account_scope = tier_items.account_scope AND c.provider_item_id = tier_items.provider_item_id
      AND c.conversation_key = tier_items.conversation_key AND c.copy_state = 'superseded'
      AND c.superseded_by_generation = tier_items.generation + 1))`;
  return `AND ${direction === 'lower' ? 'NOT' : ''} ${raising}`;
}

export class TierLedgerGenerationConflictError extends Error {
  constructor(message = 'Tier ledger generation changed; re-read the row before flipping.') {
    super(message);
    this.name = 'TierLedgerGenerationConflictError';
  }
}

/**
 * A raise hid its source copies so the item is never served below its newest
 * decision: abandoning that move would serve them again, so the ledger refuses.
 */
export class TierLedgerRaiseAbandonRefusedError extends Error {
  constructor(message = 'A raise is never abandoned: its hidden copies stay hidden until the move completes.') {
    super(message);
    this.name = 'TierLedgerRaiseAbandonRefusedError';
  }
}

/** A rollback never re-exposes a Secret: the ledger refuses to flip a Secrets row back. */
/** Verified raises cannot restore a lower copy whose content was removed. */
export class TierLedgerPurgedRollbackRefusedError extends Error {
  constructor() {
    super('already Private; its lower copy was removed');
    this.name = 'TierLedgerPurgedRollbackRefusedError';
  }
}

export class TierLedgerSecretsRollbackRefusedError extends Error {
  constructor(message = 'A Secrets row is never rolled back: its copies stay hidden until an approved purge.') {
    super(message);
    this.name = 'TierLedgerSecretsRollbackRefusedError';
  }
}

export class TierLedger {
  readonly dbPath: string;
  private readonly db: Database;
  private readonly readOnly: boolean;
  private metaChanges = 0;
  private readonly now: () => Date;

  constructor(options: TierLedgerOptions) {
    this.dbPath = options.dbPath;
    this.readOnly = options.readOnly === true;
    this.now = options.now ?? (() => new Date());
    const onDisk = this.dbPath !== ':memory:';
    if (onDisk && !this.readOnly) {
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
      db = new Database(this.dbPath, this.readOnly ? { readonly: true, create: false } : { create: true });
      if (this.readOnly) {
        db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON;');
        this.db = db;
        return;
      }
      db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;');
      runSqliteMigrations(db, TIER_LEDGER_SQLITE_STORE_ID, tierLedgerMigrations());
      settleStaleEmbedHolds(db, this.now().toISOString());
      if (onDisk) restrictLedgerFiles(this.dbPath);
    } catch (error) {
      if (db) closeSqliteStore(db, { checkpoint: !this.readOnly });
      throw error;
    }
    this.db = db;
  }

  /** Whether this file is at this build's schema (a read-only open never migrates it). */
  hasCurrentSchema(): boolean {
    return readSqliteSchemaVersion(this.db, TIER_LEDGER_SQLITE_STORE_ID) === TIER_LEDGER_SCHEMA_VERSION;
  }

  close(): void {
    try {
      // Checkpointed close, like every Olympus store: the ledger is safe to
      // hand to another process the moment this returns.
      closeSqliteStore(this.db, { checkpoint: !this.readOnly });
    } finally {
      if (!this.readOnly && this.dbPath !== ':memory:') restrictLedgerFiles(this.dbPath);
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
      if (existing.decidedBy === 'override' || this.getOverride(identity)?.kind === 'tier') {
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

  /**
   * Apply a privacy-safe sniffer verdict that arrived after the item was
   * recorded (the background pass, sniffer-resolver.ts). Only the question it
   * answers changes: a metadata verdict can only raise the metadata tier (and
   * with it the content floor), a content verdict can only raise the content
   * tier. The open-question reasons are replaced by the verdict's reason code,
   * and the model id is recorded. An override, a row mid-move, or a question
   * that is no longer open is left alone.
   *
   * A ROUTED item (P1b) never has its placement rewritten here: the settled
   * decision goes through `recordRoutedPlacement` with the plan the item's
   * tiered store set computes (`placementFor`), so a verdict that needs other
   * stores queues a move (hidden first on a raise) and one that keeps the
   * item where it is releases its embedding hold. Without a planner a routed
   * item is left pending (`needs_placement`): the question stays open.
   */
  applySnifferVerdict(
    identity: TierLedgerIdentity,
    verdict: {
      pass: 'metadata' | 'content';
      tier: 'private' | 'secure';
      reason: string;
      modelId: string;
      /** The map revision the question was asked under; a different current one makes the verdict stale. */
      mapRevision?: string;
    },
    options: { placementFor?: (decision: TierDecision) => TierPlacementPlan; questionStillCurrent?: () => boolean } = {},
  ): { outcome: SnifferVerdictOutcome; record: TierLedgerRecord } | undefined {
    assertTier(verdict.tier);
    let outcome: SnifferVerdictOutcome | undefined;
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing) return;
      // Checked under the ledger write lock: a newer queued version cannot
      // be settled by an answer to superseded material.
      if (options.questionStillCurrent && !options.questionStillCurrent()) {
        outcome = 'stale_question';
        return;
      }
      const question = this.rejudgeQuestion(identity);
      if (question) {
        outcome = this.answerRejudgeQuestion(identity, question, verdict, options);
        return;
      }
      if (existing.state === 'moving') {
        outcome = 'held_moving';
        return;
      }
      if (existing.decidedBy === 'override' || this.getOverride(identity)?.kind === 'tier') {
        outcome = 'unchanged';
        return;
      }
      if (verdict.mapRevision !== undefined && verdict.mapRevision !== existing.mapRevision) {
        // Asked under another map: the owner's categories may have changed
        // what this item is. The next sync asks again under the current map.
        outcome = 'stale_map';
        return;
      }
      const metadataReasons = existing.reasons.filter((reason) => !reason.startsWith('content:'));
      const contentReasons = existing.reasons.filter((reason) => reason.startsWith('content:'));
      let next: EffectiveRow;
      if (verdict.pass === 'metadata') {
        if (!existing.metadataPending) {
          outcome = 'unchanged';
          return;
        }
        const metadataTier = maxTier(existing.metadataTier, verdict.tier);
        const contentTier = maxTier(existing.contentTier, metadataTier);
        // Names judged Private settle an open excerpt question: the classifier
        // never asks the sniffer about content that is already Private.
        const settlesContent = existing.contentRead && existing.contentPending && contentTier === 'secure';
        next = {
          ...rowOf(existing),
          metadataTier,
          contentTier,
          decidedBy: contentTier !== existing.contentTier ? 'sniffer' : existing.decidedBy,
          reasons: [
            ...settleStoredNamesMark(metadataReasons.filter((reason) => !isOpenSnifferReason(reason, 'metadata')), existing.metadataTier, metadataTier),
            verdict.reason,
            ...(settlesContent ? contentReasons.filter((reason) => !isOpenSnifferReason(reason, 'content')) : contentReasons),
          ],
          metadataPending: false,
          ...(settlesContent ? { contentPending: false } : {}),
        };
      } else {
        if (!existing.contentPending || !existing.contentRead) {
          outcome = 'unchanged';
          return;
        }
        const contentTier = maxTier(existing.contentTier, verdict.tier);
        next = {
          ...rowOf(existing),
          contentTier,
          decidedBy: contentTier !== existing.contentTier ? 'sniffer' : existing.decidedBy,
          reasons: [
            ...metadataReasons,
            ...contentReasons.filter((reason) => !isOpenSnifferReason(reason, 'content') && !reason.startsWith('content:judge_verdict:')),
            verdict.reason,
            ...contentVerdictReceipts(contentReasons, verdict.reason, verdict.tier),
          ],
          contentPending: false,
        };
      }
      if (existing.routed) {
        if (!options.placementFor) {
          outcome = 'needs_placement';
          return;
        }
        const decision = decisionOfRow(next);
        outcome = this.recordRoutedPlacement(identity, decision, options.placementFor(decision)).outcome;
      } else {
        outcome = this.writeRow(identity, next, undefined, existing);
      }
      this.db.query(`
        UPDATE tier_items SET model_id = ?
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      `).run(verdict.modelId, ...idParams(identity));
    })();
    return outcome === undefined ? undefined : { outcome, record: this.getCurrent(identity)! };
  }

  /** A pre-filter may only finish an open Personal content question, under the ledger lock. */
  clearEmbeddingQuestion(identity: TierLedgerIdentity, options: {
    reason: string; receiptKey: string; receipt: string; modelId: string;
    questionStillCurrent: () => boolean; placementFor?: (decision: TierDecision) => TierPlacementPlan;
  }): boolean {
    return this.db.transaction(() => {
      const row = this.readRow(identity);
      if (!row || row.state !== 'pending' || row.metadataPending || !row.contentPending || !row.contentRead
        || row.metadataTier !== 'private' || row.contentTier !== 'private' || row.metadataForced
        || row.decidedBy === 'override' || row.decidedBy === 'owner_rule' || this.getOverride(identity)
        || row.reasons.some(reason => reason.startsWith('metadata:owner_rule:'))
        || this.rejudgeQuestion(identity) || !options.questionStillCurrent()) return false;
      // Receipt and decision share a transaction. The queue question remains until a good audit window.
      this.writeMeta(options.receiptKey, options.receipt);
      const result = this.applySnifferVerdict(identity, {
        pass: 'content', tier: 'private', reason: options.reason, modelId: options.modelId, mapRevision: row.mapRevision,
      }, { questionStillCurrent: options.questionStillCurrent, ...(options.placementFor ? { placementFor: options.placementFor } : {}) });
      if (!result || ['unchanged', 'needs_placement', 'stale_question', 'stale_map', 'held_moving'].includes(result.outcome)) {
        this.writeMeta(options.receiptKey, '');
        return false;
      }
      return true;
    })();
  }

  /** Withdraw only this pre-filter's decision. Fence a lowering in flight and hide before re-queueing. */
  revokeEmbeddingClearance(identity: TierLedgerIdentity, reason: string, original: TierDecision,
    placementFor?: (decision: TierDecision) => TierPlacementPlan): boolean {
    return this.db.transaction(() => {
      const row = this.readRow(identity);
      if (!row || !row.reasons.includes(reason) || row.decidedBy === 'override' || row.decidedBy === 'owner_rule'
        || this.getOverride(identity) || row.contentTier !== original.contentTier || row.metadataTier !== original.metadataTier
        || row.metadataPending || row.contentPending || row.metadataForced
        || row.reasons.some(code => code.startsWith('metadata:owner_rule:'))
        || original.reasons.filter(code => code.startsWith('content:sha256:') || code.startsWith('content:names:')).some(code => !row.reasons.includes(code))) return true;
      if (!row.routed) { this.writeRow(identity, rowOf({ ...row, ...original }), undefined, row); return true; }
      if (!placementFor) return false;
      if (row.state === 'moving') {
        const now = this.now().toISOString();
        const staleFlip = row.generation + 1;
        this.db.query(`UPDATE tier_copies SET superseded_by_generation = ?, updated_at = ?
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
          AND copy_state = 'superseded' AND superseded_by_generation = ?`)
          .run(staleFlip + 1, now, ...idParams(identity), staleFlip);
        this.db.query(`UPDATE tier_copies SET copy_state = 'superseded', superseded_by_generation = ?, updated_at = ?
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND copy_state = 'staged'`)
          .run(staleFlip, now, ...idParams(identity));
        this.db.query(`UPDATE tier_items SET generation = ?
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?`)
          .run(staleFlip, ...idParams(identity));
        this.queueMoveRow(identity, { ...row, generation: staleFlip }, original, { hide: true, decidedAt: now });
      } else {
        this.recordRoutedPlacement(identity, original, placementFor(original));
      }
      return true;
    })();
  }

  /**
   * A re-judge question answered: the decision it kept is completed with the
   * verdict and recorded like any routed decision. The item was visible all
   * along, so only a Private verdict raises it (hidden first, unless the
   * question said to keep it visible for the owner-approved migration); a
   * Personal verdict on a Personal item changes nothing but its reasons.
   */
  private answerRejudgeQuestion(
    identity: TierLedgerIdentity,
    question: TierRejudgeQuestion,
    verdict: { pass: 'metadata' | 'content'; tier: 'private' | 'secure'; reason: string; modelId: string; mapRevision?: string },
    options: { placementFor?: (decision: TierDecision) => TierPlacementPlan },
  ): SnifferVerdictOutcome {
    const base = question.decision;
    if (this.getOverride(identity)?.kind === 'tier') {
      // The owner decided the item after the question was asked: the answer
      // no longer decides anything (a re-judge never lowers past the owner).
      this.db.query(`
        UPDATE tier_items SET rejudge_json = NULL
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      `).run(...idParams(identity));
      return 'unchanged';
    }
    if (verdict.mapRevision !== undefined && verdict.mapRevision !== base.mapRevision) return 'stale_map';
    if (!options.placementFor) return 'needs_placement';
    if (!(verdict.pass === 'metadata' ? base.metadataPending : base.contentPending)) return 'unchanged';
    const metadataTier = verdict.pass === 'metadata' ? maxTier(base.metadataTier, verdict.tier) : base.metadataTier;
    const contentTier = maxTier(base.contentTier, verdict.tier);
    const metadataPending = verdict.pass === 'metadata' ? false : base.metadataPending;
    const kept = base.reasons.filter(reason => !isOpenSnifferReason(reason, verdict.pass)
      && !(verdict.pass === 'content' && reason.startsWith('content:judge_verdict:'))
      && !(metadataTier === 'secure' && isOpenSnifferReason(reason, 'content')));
    const contentPending = verdict.pass === 'content' || metadataTier === 'secure' ? false : base.contentPending;
    const decision: TierDecision = {
      ...base,
      metadataTier,
      contentTier,
      decidedBy: 'sniffer',
      reasons: [...(verdict.pass === 'metadata' ? settleStoredNamesMark(kept, base.metadataTier, metadataTier) : kept), verdict.reason,
        ...(verdict.pass === 'content' ? contentVerdictReceipts(kept, verdict.reason, verdict.tier) : [])],
      metadataPending,
      contentPending,
      state: metadataPending || contentPending ? 'pending' : 'current',
    };
    if (decision.state === 'pending') {
      // Keep the previous placement until both questions are settled. A
      // Personal names answer alone must never release the held body.
      this.db.query(`UPDATE tier_items SET rejudge_json = json_set(rejudge_json, '$.decision', json(?))
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?`)
        .run(JSON.stringify(decision), ...idParams(identity));
      return 'updated';
    }
    // A rollout hold leaves the settled row, copies and open question intact.
    // The cached answer is retried automatically when the setting is off.
    if (holdSnifferLowering(this.getCurrent(identity)!, decision)) return 'held_lowering';
    this.db.query(`
      UPDATE tier_items SET rejudge_json = NULL
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).run(...idParams(identity));
    const outcome = this.recordRoutedPlacement(
      identity,
      decision,
      options.placementFor(decision),
      question.keepVisible ? { queueWithoutHiding: true } : {},
    ).outcome;
    this.db.query(`
      UPDATE tier_items SET model_id = ?
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).run(verdict.modelId, ...idParams(identity));
    return outcome;
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
    this.db.query(`
      UPDATE tier_items SET state = 'moving', target_metadata_tier = ?, target_content_tier = ?, move_attempts = 0
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND generation = ?
        AND state != 'moving'
    `).run(target.metadataTier, target.contentTier, ...idParams(identity), expectedGeneration);
    // Bun's run().changes includes trigger writes; CAS counts only the row matched.
    if ((this.db.query('SELECT changes() AS n').get() as { n: number }).n !== 1) throw new TierLedgerGenerationConflictError();
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

  /** Counts only queued work; never materializes item content or a bounded page. */
  countMoving(direction?: 'raise' | 'lower'): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM tier_items WHERE state = 'moving'
      ${this.movingDirectionClause(direction)}`).get() as { n: number }).n;
  }

  private movingDirectionClause(direction?: 'raise' | 'lower'): string {
    return tierMovingDirectionClause(direction);
  }


  /**
   * Items with a queued move (state `moving`): the fewest failed attempts
   * first (`recordMoveFailure`), then the oldest decision. A move that keeps
   * failing goes to the back of the queue, so it never holds the head of a
   * bounded page while moves behind it could land.
   */
  listMoving(options: { limit?: number; direction?: 'raise' | 'lower' } = {}): TierLedgerRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 5_000));
    const rows = this.db.query(`
      SELECT * FROM tier_items INDEXED BY tier_items_move_order WHERE state = 'moving'
      ${this.movingDirectionClause(options.direction)}
      ORDER BY move_attempts, decided_at, provider, account_scope, provider_item_id, conversation_key
      LIMIT ?
    `).all(limit);
    return (rows as TierItemRow[]).map(recordFromRow);
  }

  /**
   * Count one failed attempt of an item's queued move (still `moving` at the
   * expected generation); the count resets whenever a new move is queued.
   * Returns the new count, or 0 when the row is no longer that move.
   */
  recordMoveFailure(identity: TierLedgerIdentity, options: { expectedGeneration: number }): number {
    this.db.query(`
      UPDATE tier_items SET move_attempts = move_attempts + 1
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
        AND generation = ? AND state = 'moving'
    `).run(...idParams(identity), options.expectedGeneration);
    return this.moveAttempts(identity);
  }

  /** Failed attempts of the item's queued move (0 when none, or no move is queued). */
  moveAttempts(identity: TierLedgerIdentity): number {
    const row = this.db.query(`
      SELECT move_attempts FROM tier_items
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND state = 'moving'
    `).get(...idParams(identity)) as { move_attempts: number } | null;
    return row?.move_attempts ?? 0;
  }

  /**
   * Routed items whose content decision a newer classifier should make again
   * (tier-rejudge.ts): text read, settled (`current`), not Secrets, no owner
   * override, no force rule, no owner rule on the names, and decided by the
   * automatic content steps (default, detectors, sniffer, or a move that
   * carried one of those out). Of those, the ones decided under another
   * classifier version, and, when a sniffer is configured, the ones whose
   * text is below Private without that sniffer's own content verdict, or
   * whose verdict used other owner words or another judge model. Built-in
   * prompt wording alone does not invalidate a settled decision (owner,
   * 2026-11-07). An item whose names matched an owner map category is
   * re-judged on a classifier change only: the category may have settled it.
   * A row a re-judge
   * already settled under this classifier and sniffer (`markRejudged`), or
   * whose re-judge question is still open (`openRejudgeQuestion`), is not a
   * candidate again.
   *
   * Bounded: one call reads at most `scanLimit` rows of the ledger, in key
   * order after `after`, and returns at most `limit` candidates from them.
   * `next` is where the following call continues; absent once the ledger was
   * read to its end.
   */
  rejudgeCandidatePage(options: {
    engineVersion: string;
    /** The configured sniffer's id; absent: only the classifier version counts. */
    snifferId?: string;
    after?: TierLedgerIdentity;
    limit?: number;
    /** Ledger rows read per call (default DEFAULT_REJUDGE_SCAN_ROWS). */
    scanLimit?: number;
  }): { records: TierLedgerRecord[]; causes: TierRejudgeCause[]; builtinPromptSkipped: number; next?: TierLedgerIdentity } {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 5_000));
    const scanLimit = Math.max(limit, Math.min(options.scanLimit ?? DEFAULT_REJUDGE_SCAN_ROWS, 50_000));
    const snifferMarker = options.snifferId ? `"content:sniffer:${options.snifferId}:` : null;
    const metadataMarker = options.snifferId ? `"metadata:sniffer:${options.snifferId}:` : null;
    const key = rejudgeKey(options.engineVersion, options.snifferId);
    const after = options.after
      ? [options.after.provider, options.after.accountScope, tierLedgerConversationKey(options.after), options.after.providerItemId]
      : null;
    const nowIso = this.now().toISOString();
    const rows = this.db.query(`
      WITH win AS (
        SELECT * FROM tier_items
        WHERE (? IS NULL OR (provider, account_scope, conversation_key, provider_item_id) > (?, ?, ?, ?))
        ORDER BY provider, account_scope, conversation_key, provider_item_id
        LIMIT ?
      )
      SELECT i.*, CASE WHEN
          i.routed = 1 AND i.content_read = 1
          AND i.metadata_forced = 0 AND i.content_tier != 'secrets'
          AND i.decided_by IN ('default', 'sensitive_detector', 'sniffer', 'move', 'source_prior', 'content_rule')
          -- A held row's stamp names the exact decision it re-read, so it
          -- never outlives that decision (rejudgeKeyForHeld). So does a row
          -- resting on a retired prior: a prior replayed after a completed
          -- re-judge is a new decision and invalidates the old stamp, while a
          -- re-read that changed nothing (no text) stays settled (markRejudged).
          -- A stamp may be followed by an unavailable-text marker after
          -- char(1) (markRejudgeUnavailable): the stamp before it still counts.
          -- (instr, not substr: SQLite's string functions stop at the NUL.)
          AND NOT (i.rejudged_key IS NOT NULL AND (i.rejudged_key = i.expected_stamp
            OR instr(i.rejudged_key, i.expected_stamp || char(1)) = 1))
          -- Settled by a verdict under this classifier and sniffer (markJudged):
          -- not re-asked while its decision stays settled under this
          -- classifier. A later decision that left it owed a verdict (fail-safe,
          -- a retired source prior) is a candidate again, stamp or not.
          AND NOT ((COALESCE(i.rejudged_key, '') = i.judged_stamp OR instr(COALESCE(i.rejudged_key, ''), i.judged_stamp || char(1)) = 1)
            AND i.state != 'pending' AND i.engine_version = ?
            AND instr(i.reasons_json, ':fail_safe:') = 0 AND instr(i.reasons_json, '"metadata:prior:source_') = 0)
          AND (i.state = 'current'
            -- Held for its text question alone: re-read once per classifier
            -- and sniffer, so a question lost from the sniffer's queue (a
            -- move that landed the item held, a verdict recorded under an
            -- older prompt) is asked again instead of holding it forever.
            OR (i.state = 'pending' AND i.content_pending = 1 AND i.metadata_pending = 0))
          AND NOT (i.rejudge_json IS NOT NULL
            AND json_extract(i.rejudge_json, '$.generation') = i.generation
            AND json_extract(i.rejudge_json, '$.decidedAt') = i.decided_at
            AND json_extract(i.rejudge_json, '$.reasonsJson') = i.reasons_json
            AND json_extract(i.rejudge_json, '$.decidedBy') = i.decided_by)
          AND instr(i.reasons_json, '"override:') = 0
          AND instr(i.reasons_json, '"metadata:owner_rule:') = 0
          AND NOT EXISTS (
            SELECT 1 FROM tier_overrides o
            WHERE o.provider = i.provider AND o.account_scope = i.account_scope
              AND o.conversation_key = i.conversation_key AND o.provider_item_id = i.provider_item_id
          )
          -- A rule needs an actual identity change, never an absent model marker.
          AND (i.decided_by != 'content_rule' OR i.engine_version != ?
            OR (instr(i.reasons_json, '"content:rule_sniffer:') > 0
              AND ? IS NOT NULL AND instr(i.reasons_json, ?) = 0))
          AND (
            i.state = 'pending'
            -- Rests on a retired whole-source prior (RETIRED_SOURCE_PRIOR_REASON):
            -- wrong under the owner ruling of 2026-10-28, so judged again now.
            OR instr(i.reasons_json, '"metadata:prior:source_') > 0
            -- Content settled fail-safe because its question was missing from
            -- the queue, not because anything judged it (an enqueue lost while
            -- the private model was off: about 2,400 messages on 2026-11-04):
            -- its text is stored, so it is asked again (#606).
            OR (instr(i.reasons_json, ':fail_safe:missing_question"') > 0
              AND EXISTS (SELECT 1 FROM json_each(i.reasons_json) r
                WHERE r.value GLOB 'content:sniffer:*:fail_safe:missing_question'))
            OR (i.decided_by = 'content_rule' AND ? IS NOT NULL
              AND instr(i.reasons_json, ?) = 0)
            OR i.engine_version != ?
            OR (? IS NOT NULL AND instr(i.reasons_json, '"metadata:sniffer:') > 0 AND instr(i.reasons_json, ?) = 0)
            OR (? IS NOT NULL AND instr(i.reasons_json, ?) = 0
              AND instr(i.reasons_json, '"metadata:sensitivity_map:') = 0
              AND (i.content_tier IN ('public', 'private') OR instr(i.reasons_json, '"content:sniffer:') > 0))
          )
        THEN 1 ELSE 0 END AS rejudge_candidate,
        -- Which rule made it a candidate (content-free, for the pass's log line).
        CASE
          WHEN i.state = 'pending' THEN 'held'
          WHEN instr(i.reasons_json, '"metadata:prior:source_') > 0 THEN 'retired_prior'
          WHEN instr(i.reasons_json, ':fail_safe:missing_question"') > 0 THEN 'missing_question'
          WHEN i.engine_version != ? THEN 'classifier'
          WHEN ? IS NOT NULL AND instr(i.reasons_json, '"metadata:sniffer:') > 0 AND instr(i.reasons_json, ?) = 0 THEN 'names_prompt'
          ELSE 'content_prompt'
        END AS rejudge_cause
      FROM (SELECT *, CASE WHEN state = 'pending'
            THEN ? || char(0) || 'held' || char(0) || generation || char(0) || decided_at
            WHEN instr(reasons_json, '"metadata:prior:source_') > 0
            THEN ? || char(0) || 'prior' || char(0) || generation || char(0) || decided_at
            ELSE ? END AS expected_stamp, ? || char(0) || 'judged' AS judged_stamp FROM win) i
      ORDER BY i.provider, i.account_scope, i.conversation_key, i.provider_item_id
    `).all(
      after ? 1 : null,
      ...(after ?? [null, null, null, null]),
      scanLimit,
      options.engineVersion,
      options.engineVersion,
      options.snifferId ?? null,
      JSON.stringify(`content:rule_sniffer:${options.snifferId}`),
      options.snifferId ?? null,
      JSON.stringify(`content:rule_sniffer:${options.snifferId}`),
      options.engineVersion,
      metadataMarker,
      metadataMarker ?? '',
      snifferMarker,
      snifferMarker ?? '',
      options.engineVersion,
      metadataMarker,
      metadataMarker ?? '',
      key,
      key,
      key,
      key,
    ) as Array<TierItemRow & { rejudge_candidate: number; rejudge_cause: TierRejudgeCause }>;
    const records: TierLedgerRecord[] = [];
    const causes: TierRejudgeCause[] = [];
    let builtinPromptSkipped = 0;
    let last: TierItemRow | undefined;
    for (const row of rows) {
      last = row;
      if (row.rejudge_candidate !== 1) continue;
      // Its serving text could not be read under this classifier and sniffer
      // at this decision (#1002): tried again once the backoff ends, or at
      // once after a newer decision. It was never stamped settled.
      if (rejudgeUnavailableUntil(row, key) > nowIso) continue;
      const cause = settledSnifferRejudgeCause(row, row.rejudge_cause, options.snifferId);
      if (cause === 'builtin_prompt_skipped') {
        builtinPromptSkipped += 1;
        continue;
      }
      records.push(recordFromRow(row));
      causes.push(cause);
      if (records.length >= limit) break;
    }
    const more = records.length >= limit || rows.length >= scanLimit;
    return {
      records,
      causes,
      builtinPromptSkipped,
      ...(more && last ? { next: identityOfRow(last) } : {}),
    };
  }

  /**
   * The second round's candidates (judge-second-round.ts, #891): settled rows
   * the local judge itself held Private on their text. Never a Secret, an
   * item the local judge cleared, a fail-safe or record hold, a rule, an
   * owner override, names held Private, or a row with a re-judge open.
   * Bounded exactly like `rejudgeCandidatePage`.
   */
  secondRoundCandidatePage(options: { after?: TierLedgerIdentity; limit?: number; scanLimit?: number } = {}): { records: TierLedgerRecord[]; next?: TierLedgerIdentity } {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 5_000));
    const scanLimit = Math.max(limit, Math.min(options.scanLimit ?? DEFAULT_REJUDGE_SCAN_ROWS, 50_000));
    const after = options.after
      ? [options.after.provider, options.after.accountScope, tierLedgerConversationKey(options.after), options.after.providerItemId]
      : null;
    const rows = this.db.query(`
      WITH win AS (
        SELECT * FROM tier_items
        WHERE (? IS NULL OR (provider, account_scope, conversation_key, provider_item_id) > (?, ?, ?, ?))
        ORDER BY provider, account_scope, conversation_key, provider_item_id
        LIMIT ?
      )
      SELECT i.*, CASE WHEN
          i.routed = 1 AND i.content_read = 1 AND i.state = 'current' AND i.metadata_forced = 0
          AND i.content_tier = 'secure' AND i.metadata_tier IN ('public', 'private') AND i.decided_by IN ('sniffer', 'move')
          -- The local judge's own Private verdict on this text (a move only carries it out).
          AND instr(i.reasons_json, '"content:sniffer:local:') > 0 AND instr(i.reasons_json, '"content:judge_verdict:secure:') > 0
          AND instr(i.reasons_json, ':fail_safe:') = 0 AND instr(i.reasons_json, ':record_held:') = 0
          AND instr(i.reasons_json, ':injection:') = 0
          AND instr(i.reasons_json, '"override:') = 0 AND instr(i.reasons_json, '"metadata:owner_rule:') = 0
          AND NOT (i.rejudge_json IS NOT NULL AND json_extract(i.rejudge_json, '$.generation') = i.generation)
          AND NOT EXISTS (
            SELECT 1 FROM tier_overrides o
            WHERE o.provider = i.provider AND o.account_scope = i.account_scope
              AND o.conversation_key = i.conversation_key AND o.provider_item_id = i.provider_item_id
          )
        THEN 1 ELSE 0 END AS second_round
      FROM win i
      ORDER BY i.provider, i.account_scope, i.conversation_key, i.provider_item_id
    `).all(after ? 1 : null, ...(after ?? [null, null, null, null]), scanLimit) as Array<TierItemRow & { second_round: number }>;
    const records: TierLedgerRecord[] = [];
    let last: TierItemRow | undefined;
    for (const row of rows) {
      last = row;
      if (row.second_round !== 1) continue;
      records.push(recordFromRow(row));
      if (records.length >= limit) break;
    }
    const more = records.length >= limit || rows.length >= scanLimit;
    return { records, ...(more && last ? { next: identityOfRow(last) } : {}) };
  }

  /** The candidates of `rejudgeCandidatePage` over the whole ledger (status and tests), at most `limit`. */
  listRejudgeCandidates(options: { engineVersion: string; snifferId?: string; limit?: number }): TierLedgerRecord[] {
    const records: TierLedgerRecord[] = [];
    const limit = Math.max(1, Math.min(options.limit ?? 100, 5_000));
    let after: TierLedgerIdentity | undefined;
    do {
      const page = this.rejudgeCandidatePage({ ...options, limit: limit - records.length, ...(after ? { after } : {}) });
      records.push(...page.records);
      after = page.next;
    } while (after && records.length < limit);
    return records;
  }

  /**
   * Stamp that a re-judge settled the row under this classifier and sniffer
   * with no question left open (no change, nothing to re-read, or a decision
   * recorded), so it is not re-read on every tick. Nothing else changes.
   */
  markRejudged(identity: TierLedgerIdentity, key: { engineVersion: string; snifferId?: string }): void {
    this.db.query(`
      UPDATE tier_items SET rejudged_key = CASE WHEN instr(reasons_json, '"metadata:prior:source_') > 0
        THEN ?1 || char(0) || 'prior' || char(0) || generation || char(0) || decided_at ELSE ?1 END
      WHERE provider = ?2 AND account_scope = ?3 AND conversation_key = ?4 AND provider_item_id = ?5
    `).run(rejudgeKey(key.engineVersion, key.snifferId), ...idParams(identity));
  }

  /**
   * A re-judge found no serving text to read (#1002): the decision stands but
   * the re-judge did not happen, so the row is NOT stamped settled. It keeps
   * whatever settlement stamp it had and gets an unavailable marker for this
   * classifier, sniffer and decision, so a bounded pass does not re-read it
   * every tick: it is a candidate again when the backoff (the ledger's clock;
   * doubling per miss, REJUDGE_UNAVAILABLE_MAX_RETRY_MS at most) ends, or at
   * once after a newer decision of the row.
   */
  markRejudgeUnavailable(record: TierLedgerRecord, key: { engineVersion: string; snifferId?: string }): void {
    const id = [record.provider, record.accountScope, record.conversationKey, record.providerItemId] as const;
    const row = this.db.query(`
      SELECT rejudged_key FROM tier_items
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND generation = ? AND decided_at = ?
    `).get(...id, record.generation, record.decidedAt) as { rejudged_key: string | null } | null;
    if (!row) return;
    const stampKey = rejudgeKey(key.engineVersion, key.snifferId);
    const split = splitRejudgeStamp(row.rejudged_key);
    const previous = split.unavailable?.split('\u0001');
    const misses = previous && previous[0] === stampKey && previous[1] === String(record.generation) && previous[2] === record.decidedAt
      ? (Number(previous[4]) || 0) + 1 : 0;
    const wait = Math.min(REJUDGE_UNAVAILABLE_RETRY_MS * 2 ** Math.min(misses, 16), REJUDGE_UNAVAILABLE_MAX_RETRY_MS);
    const retryAt = new Date(this.now().getTime() + wait).toISOString();
    this.db.query(`
      UPDATE tier_items SET rejudged_key = ?
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND generation = ? AND decided_at = ?
    `).run(
      [split.settled ?? '', stampKey, String(record.generation), record.decidedAt, retryAt, String(misses)].join('\u0001'),
      ...id,
      record.generation,
      record.decidedAt,
    );
  }

  /**
   * Stamp that a sniffer verdict just settled the row under this classifier
   * and sniffer (#954): an item judged a moment ago is not a re-judge
   * candidate for the same inputs, whatever another pass did to its reasons
   * since. Only a settled row decided under this very classifier version is
   * stamped; one still waiting on a question, or held fail-safe without a
   * verdict, or resting on a retired whole-source prior, stays a candidate.
   * The stamp counts only while the row's decision is under this classifier
   * and not pending: a new classifier or sniffer, or a later decision under
   * another version, makes it a candidate again.
   */
  markJudged(identity: TierLedgerIdentity, key: { engineVersion: string; snifferId: string }): void {
    this.db.query(`
      UPDATE tier_items SET rejudged_key = ? || char(0) || 'judged'
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
        AND state != 'pending' AND metadata_pending = 0 AND content_pending = 0
        AND engine_version = ? AND decided_by != 'override'
        AND instr(reasons_json, '"metadata:prior:source_') = 0
        AND instr(reasons_json, ':fail_safe:') = 0
    `).run(rejudgeKey(key.engineVersion, key.snifferId), ...idParams(identity), key.engineVersion);
  }

  /**
   * Stamp that a re-judge re-read a row held for its text question and queued
   * that question again. The stamp names the row's exact decision (generation
   * and time), so the row is read once per decision, classifier and sniffer,
   * and is a candidate again the moment any of them changes.
   */
  markHeldRejudged(record: TierLedgerRecord, key: { engineVersion: string; snifferId?: string }): void {
    this.db.query(`
      UPDATE tier_items SET rejudged_key = ? || char(0) || 'held' || char(0) || generation || char(0) || decided_at
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
        AND state = 'pending' AND generation = ? AND decided_at = ?
    `).run(
      rejudgeKey(key.engineVersion, key.snifferId),
      record.provider,
      record.accountScope,
      record.conversationKey,
      record.providerItemId,
      record.generation,
      record.decidedAt,
    );
  }

  /**
   * A re-judge asked the sniffer about an item that was visible under its
   * previous decision: the item stays EXACTLY where it is (tiers, copies,
   * embedding) and the question is recorded beside the row with the
   * decision its answer completes. `applySnifferVerdict` settles it; any
   * newer decision of the row (a sync, a landing, an override) makes it stale.
   * Refused (false) unless the row is `current` at the expected generation.
   */
  openRejudgeQuestion(
    identity: TierLedgerIdentity,
    options: {
      expectedGeneration: number;
      decision: TierDecision;
      /** Queue a raise the answer needs without hiding (moves wait for the owner-approved migration). */
      keepVisible: boolean;
    },
  ): boolean {
    let opened = false;
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing || existing.generation !== options.expectedGeneration || existing.state !== 'current'
        || existing.decidedBy === 'override') return;
      const question: StoredRejudgeQuestion = {
        generation: existing.generation,
        decidedAt: existing.decidedAt,
        reasonsJson: JSON.stringify(existing.reasons),
        decidedBy: existing.decidedBy,
        decision: options.decision,
        keepVisible: options.keepVisible,
      };
      // Not stamped `rejudged_key`: while the question is open the row is no
      // candidate anyway, and once a newer decision makes it stale the row
      // must be a candidate again.
      opened = this.db.query(`
        UPDATE tier_items SET rejudge_json = ?
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND generation = ?
      `).run(
        JSON.stringify(question),
        ...idParams(identity),
        existing.generation,
      ).changes === 1;
    })();
    return opened;
  }

  /**
   * The item's open re-judge question, or undefined when none is open or the
   * row was decided again since it was asked (the newer decision stands).
   */
  rejudgeQuestion(identity: TierLedgerIdentity): TierRejudgeQuestion | undefined {
    const row = this.db.query(`
      SELECT * FROM tier_items
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).get(...idParams(identity)) as (TierItemRow & { rejudge_json: string | null }) | null;
    return row ? openRejudgeQuestionOf(row) : undefined;
  }

  /**
   * The owner asked to check one chat's or one source's privacy again
   * (`olympus tier recheck`, #638): a durable, content-free request beside
   * the ledger, which the re-judge pass works through (tier-rejudge.ts).
   * It never sets a tier: each item in the scope is judged again on its own.
   * Asking again for the same scope starts it over. Returns how many routed
   * items the scope holds now (0: nothing is requested).
   */
  requestRecheck(scope: TierRecheckScope): { items: number } {
    const items = (this.db.query(`
      SELECT COUNT(*) AS n FROM tier_items
      WHERE routed = 1 AND (?1 IS NULL OR provider = ?1) AND (?2 IS NULL OR account_scope = ?2) AND (?3 IS NULL OR conversation_key = ?3)
    `).get(scope.provider ?? null, scope.accountScope ?? null, scope.conversationKey ?? null) as { n: number }).n;
    if (items > 0) this.writeMeta(recheckRequestKey(scope), JSON.stringify({ scope }));
    return { items };
  }

  /** The open re-check requests, oldest scope key first. */
  recheckRequests(): TierRecheckRequest[] {
    const requests: TierRecheckRequest[] = [];
    for (const entry of this.metaEntries(TIER_RECHECK_META_PREFIX)) {
      try {
        const parsed = JSON.parse(entry.value) as { scope?: TierRecheckScope; after?: TierLedgerIdentity };
        if (!parsed.scope) continue;
        requests.push({ key: entry.key, scope: parsed.scope, ...(parsed.after ? { after: parsed.after } : {}) });
      } catch {
        // A damaged request is dropped below, not retried forever.
        this.deleteMeta(entry.key);
      }
    }
    return requests;
  }

  /** Routed items of a re-check's scope in key order after `after`; `next` is absent once the scope is read to its end. */
  recheckScopePage(scope: TierRecheckScope, options: { after?: TierLedgerIdentity; limit: number }): { records: TierLedgerRecord[]; next?: TierLedgerIdentity } {
    const limit = Math.max(1, Math.min(options.limit, 5_000));
    const after = options.after
      ? [options.after.provider, options.after.accountScope, tierLedgerConversationKey(options.after), options.after.providerItemId]
      : null;
    const rows = this.db.query(`
      SELECT * FROM tier_items
      WHERE routed = 1 AND (?1 IS NULL OR provider = ?1) AND (?2 IS NULL OR account_scope = ?2) AND (?3 IS NULL OR conversation_key = ?3)
        AND (?4 IS NULL OR (provider, account_scope, conversation_key, provider_item_id) > (?5, ?6, ?7, ?8))
      ORDER BY provider, account_scope, conversation_key, provider_item_id
      LIMIT ?9
    `).all(
      scope.provider ?? null, scope.accountScope ?? null, scope.conversationKey ?? null,
      after ? 1 : null, ...(after ?? [null, null, null, null]), limit,
    ) as TierItemRow[];
    const records = rows.map(recordFromRow);
    const last = rows.at(-1);
    return { records, ...(rows.length >= limit && last ? { next: identityOfRow(last) } : {}) };
  }

  /** Where a re-check request continues from, or (no `after`) that it is done. */
  advanceRecheck(request: TierRecheckRequest, after: TierLedgerIdentity | undefined): void {
    // A request made again meanwhile starts over: it is not moved on, nor dropped, by the older pass.
    const stored = this.readMeta(request.key);
    if (stored === undefined || stored !== JSON.stringify({ scope: request.scope, ...(request.after ? { after: request.after } : {}) })) return;
    if (after) this.writeMeta(request.key, JSON.stringify({ scope: request.scope, after }));
    else this.deleteMeta(request.key);
  }

  /**
   * Routed items held ONLY because their text has not been read (no open
   * names question, content unread): pending on it, or settled fail-safe
   * Private for the content question it could not have yet. In key order
   * after `after`: the rows a names-only settle pass checks
   * (tier-names-only-settle.ts).
   */
  listAwaitingText(options: { limit?: number; after?: TierLedgerIdentity } = {}): TierLedgerRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 5_000));
    const after = options.after
      ? [options.after.provider, options.after.accountScope, tierLedgerConversationKey(options.after), options.after.providerItemId]
      : null;
    const rows = this.db.query(`
      SELECT * FROM tier_items
      WHERE routed = 1 AND content_read = 0 AND metadata_pending = 0
        AND ((state = 'pending' AND content_pending = 1)
          OR (state = 'current' AND EXISTS (SELECT 1 FROM json_each(reasons_json) r
            WHERE r.value GLOB 'content:sniffer:*:fail_safe:missing_question'
              OR r.value GLOB 'content:sniffer:*:fail_safe:unread')))
        AND (? IS NULL OR (provider, account_scope, conversation_key, provider_item_id) > (?, ?, ?, ?))
      ORDER BY provider, account_scope, conversation_key, provider_item_id
      LIMIT ?
    `).all(after ? 1 : null, ...(after ?? [null, null, null, null]), limit);
    return (rows as TierItemRow[]).map(recordFromRow);
  }

  /**
   * listAwaitingText over a bounded window: at most `examine` rows in key
   * order after `after` are looked at, matching or not, and the result says
   * where the next call resumes. Unbounded, a call with few matching rows
   * walked the whole ledger to fill its page (Sparta, 2007d67, 2026-11-05: a
   * 10 s freeze on one names-only settle pass).
   */
  listAwaitingTextWindow(options: { limit?: number; after?: TierLedgerIdentity; examine?: number } = {}): {
    records: TierLedgerRecord[];
    /** Where the next call resumes; undefined once the end of the ledger is reached. */
    resumeAfter?: TierLedgerIdentity;
  } {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 5_000));
    const examine = Math.max(limit, options.examine ?? 20_000);
    const after = options.after
      ? [options.after.provider, options.after.accountScope, tierLedgerConversationKey(options.after), options.after.providerItemId]
      : undefined;
    const keyAfter = after ? 'WHERE (provider, account_scope, conversation_key, provider_item_id) > (?, ?, ?, ?)' : '';
    const rows = this.db.query(`
      SELECT * FROM (
        SELECT * FROM tier_items ${keyAfter}
        ORDER BY provider, account_scope, conversation_key, provider_item_id
        LIMIT ?
      )
      WHERE routed = 1 AND content_read = 0 AND metadata_pending = 0
        AND ((state = 'pending' AND content_pending = 1)
          OR (state = 'current' AND EXISTS (SELECT 1 FROM json_each(reasons_json) r
            WHERE r.value GLOB 'content:sniffer:*:fail_safe:missing_question'
              OR r.value GLOB 'content:sniffer:*:fail_safe:unread')))
      ORDER BY provider, account_scope, conversation_key, provider_item_id
      LIMIT ?
    `).all(...(after ?? []), examine, limit) as TierItemRow[];
    const records = rows.map(recordFromRow);
    const identityOfRow = (row: { provider: string; account_scope: string; conversation_key: string; provider_item_id: string }): TierLedgerIdentity => ({
      provider: row.provider, accountScope: row.account_scope, providerItemId: row.provider_item_id,
      ...(row.conversation_key ? { providerConversationId: row.conversation_key } : {}),
    });
    if (rows.length >= limit) return { records, resumeAfter: identityOfRow(rows[rows.length - 1]!) };
    const windowEnd = this.db.query(`
      SELECT provider, account_scope, conversation_key, provider_item_id FROM tier_items ${keyAfter}
      ORDER BY provider, account_scope, conversation_key, provider_item_id
      LIMIT 1 OFFSET ?
    `).get(...(after ?? []), examine - 1) as { provider: string; account_scope: string; conversation_key: string; provider_item_id: string } | null;
    return windowEnd ? { records, resumeAfter: identityOfRow(windowEnd) } : { records };
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

  /**
   * Repair a pending decision whose question was never persisted or was lost.
   * Missing material is uncertainty, so only a Private raise is permitted.
   * Unread content stays unread: a later extraction may still land normally.
   */
  settleMissingQuestions(
    record: TierLedgerRecord,
    options: {
      missingMetadata: boolean;
      missingContent: boolean;
      snifferId: string;
      stillMissing: () => boolean;
      placementFor?: (decision: TierDecision) => TierPlacementPlan;
    },
  ): boolean {
    const identity: TierLedgerIdentity = { provider: record.provider, accountScope: record.accountScope,
      providerItemId: record.providerItemId, ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}) };
    return this.db.transaction(() => {
      const current = this.getCurrent(identity);
      if (!current || current.state !== 'pending' || JSON.stringify(current) !== JSON.stringify(record)
        || current.decidedBy === 'override' || this.getOverride(identity)?.kind === 'tier' || !options.stillMissing()) return false;
      if (current.routed && !options.placementFor) return false;
      const next = rowOf(current);
      if (options.missingMetadata && next.metadataPending) {
        next.metadataTier = maxTier(next.metadataTier, 'secure');
        next.metadataPending = false;
        next.reasons = [...next.reasons.filter(reason => !isOpenSnifferReason(reason, 'metadata')),
          `metadata:sniffer:${options.snifferId}:fail_safe:missing_question`];
      }
      if (options.missingContent && (next.contentPending || !next.metadataPending)) {
        next.contentTier = maxTier(next.contentTier, 'secure');
        next.contentPending = false;
        // Unread text was never a question that went missing: say what it is,
        // so the counts do not read as lost questions (#847).
        next.reasons = [...next.reasons.filter(reason => !isOpenSnifferReason(reason, 'content')),
          `content:sniffer:${options.snifferId}:fail_safe:${next.contentRead ? 'missing_question' : 'unread'}`];
      }
      next.contentTier = maxTier(next.contentTier, next.metadataTier);
      next.decidedBy = 'sniffer';
      const decision = decisionOfRow(next);
      if (current.routed) {
        this.recordRoutedPlacement(identity, decision, options.placementFor!(decision), {
          guard: { generation: current.generation, override: this.getOverride(identity) }, stagedLandingAllowed: true,
        });
      } else this.writeRow(identity, next, undefined, current);
      return true;
    })();
  }

  /**
   * One page of the once-only relabel (#847): rows settled fail-safe before
   * the `unread` label existed, with their text still unread, get it in place
   * of `missing_question`. Only the label changes: tiers, copies and the
   * generation stay as they are. Returns how many rows changed; 0 means done.
   */
  relabelUnreadFailSafe(limit = 2_000): number {
    return this.db.query(`
      UPDATE tier_items SET reasons_json = (
        SELECT json_group_array(CASE WHEN r.value GLOB 'content:sniffer:*:fail_safe:missing_question'
          THEN substr(r.value, 1, length(r.value) - length('missing_question')) || 'unread' ELSE r.value END)
        FROM json_each(tier_items.reasons_json) r)
      WHERE rowid IN (
        SELECT rowid FROM tier_items
        WHERE content_read = 0 AND instr(reasons_json, ':fail_safe:missing_question"') > 0
          AND EXISTS (SELECT 1 FROM json_each(reasons_json) r WHERE r.value GLOB 'content:sniffer:*:fail_safe:missing_question')
        LIMIT ?)
    `).run(Math.max(1, Math.min(limit, 10_000))).changes;
  }

  /** Retire only an unchanged pending row after every relevant store confirmed absence. */
  retireAbsentPending(record: TierLedgerRecord): boolean {
    const identity: TierLedgerIdentity = { provider: record.provider, accountScope: record.accountScope,
      providerItemId: record.providerItemId, ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}) };
    return this.db.transaction(() => {
      const current = this.getCurrent(identity);
      if (!current || current.state !== 'pending' || JSON.stringify(current) !== JSON.stringify(record)
        || this.getOverride(identity)?.kind === 'tier') return false;
      this.deleteCopies(identity);
      this.db.query(`DELETE FROM tier_items
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?`).run(...idParams(identity));
      return true;
    })();
  }

  /**
   * Forget a queued raise whose item no store holds any more (#913). A raise
   * hides its source copies and is never abandoned, so once every store has
   * dropped the item (deleted at the source, or tombstoned) the move could
   * only fail with "no current copy" on every pass. Nothing is served or
   * hidden for it, so the row and its copy rows go, exactly as
   * `retireAbsentPending` does for an unjudged item; if the item comes back
   * it is routed and judged afresh. The caller has checked that no store
   * holds an active copy. Refused for another generation, a row no longer
   * mid-move, or one the owner pinned with a tier override.
   */
  retireAbsentMove(identity: TierLedgerIdentity, options: { expectedGeneration: number }): boolean {
    return this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing || existing.state !== 'moving' || existing.generation !== options.expectedGeneration
        || this.getOverride(identity)?.kind === 'tier') return false;
      this.deleteCopies(identity);
      this.writeMeta(`tier-move-verified:${tierLedgerIdentityKey(identity)}`, '');
      this.db.query(`DELETE FROM tier_items
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?`).run(...idParams(identity));
      return true;
    })();
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

  /**
   * Save the owner's per-item override. In the same write, a move an earlier
   * override queued that this one no longer asks for is cancelled or
   * replanned (`settleRevokedOwnerMove`).
   */
  setOverride(identity: TierLedgerIdentity, override: ItemTierOverride): void {
    if (override.kind === 'tier') assertTier(override.tier);
    this.db.transaction(() => {
      this.db.query(`
        INSERT INTO tier_overrides (provider, account_scope, conversation_key, provider_item_id, override_json, set_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (provider, account_scope, conversation_key, provider_item_id)
        DO UPDATE SET override_json = excluded.override_json, set_at = excluded.set_at
      `).run(...idParams(identity), JSON.stringify(override), this.now().toISOString());
      this.settleRevokedOwnerMove(identity);
    })();
  }

  /**
   * What a classification pass reads before judging an item, in one read
   * snapshot: the owner's override, and whether the item is Secrets already
   * (the sniffer fence, connector-store/tier-placement.ts, keys off it).
   */
  classificationRead(identity: TierLedgerIdentity): { override: ItemTierOverride | undefined; secret: boolean; scrubRevision: number } {
    return this.db.transaction(() => ({
      override: this.getOverride(identity),
      secret: this.itemIsSecret(identity),
      scrubRevision: this.secretScrubRevision(identity),
    }))();
  }

  /**
   * Secrets items whose latest scrub at their current generation has not
   * completed (see `markSecretSideStoresCleared`) and that owe no
   * written-down debt (`secretSideStoreDebts` has those), a bounded page.
   * A scrub begun later than a completed one (a name queued again) leaves
   * the item here until it too completes. `holdsCopies`: its Secrets
   * settlement has not finished (see `retrySecretSideStoreDebts`).
   */
  unsettledSecretSideStores(limit = 100): Array<TierLedgerIdentity & { holdsCopies: boolean }> {
    const rows = this.db.query(`
      SELECT i.provider, i.account_scope, i.conversation_key, i.provider_item_id,
        EXISTS (
          SELECT 1 FROM tier_copies c
          WHERE c.provider = i.provider AND c.account_scope = i.account_scope
            AND c.conversation_key = i.conversation_key AND c.provider_item_id = i.provider_item_id
        ) AS holds_copies
      FROM tier_items i
      LEFT JOIN secret_side_store_scrubs s
        ON s.provider = i.provider AND s.account_scope = i.account_scope
        AND s.conversation_key = i.conversation_key AND s.provider_item_id = i.provider_item_id
      WHERE (i.metadata_tier = 'secrets' OR i.content_tier = 'secrets')
        AND (s.cleared_generation IS NOT i.generation OR s.cleared_revision IS NOT s.revision)
        AND NOT EXISTS (
          SELECT 1 FROM secret_side_store_debt d
          WHERE d.provider = i.provider AND d.account_scope = i.account_scope
            AND d.conversation_key = i.conversation_key AND d.provider_item_id = i.provider_item_id
        )
      -- Unordered pages could keep returning the same skipped items.
      ORDER BY RANDOM()
      LIMIT ?
    `).all(Math.max(1, Math.min(limit, 1_000))) as Array<{
      provider: string;
      account_scope: string;
      conversation_key: string;
      provider_item_id: string;
      holds_copies: number;
    }>;
    return rows.map((row) => ({
      provider: row.provider,
      accountScope: row.account_scope,
      providerItemId: row.provider_item_id,
      ...(row.conversation_key ? { providerConversationId: row.conversation_key } : {}),
      holdsCopies: row.holds_copies === 1,
    }));
  }

  /**
   * The scrub begun at `mark` (`noteSecretScrub`) completed: recorded only if
   * no later scrub began and the item's generation has not moved since.
   */
  markSecretSideStoresCleared(identity: TierLedgerIdentity, mark: SecretScrubMark): void {
    this.db.query(`
      UPDATE secret_side_store_scrubs SET cleared_generation = ?, cleared_revision = revision
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
        AND revision = ?
        AND ? IS (SELECT generation FROM tier_items
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?)
    `).run(mark.generation, ...idParams(identity), mark.revision, mark.generation, ...idParams(identity));
  }

  /** Note the extraction job ledgers this process has open (see `knownJobLedgerPaths`). */
  noteJobLedgerPaths(paths: readonly string[]): void {
    const now = this.now().toISOString();
    this.db.transaction(() => {
      const upsert = this.db.query(`
        INSERT INTO known_job_ledgers (path, seen_at) VALUES (?, ?)
        ON CONFLICT (path) DO UPDATE SET seen_at = excluded.seen_at
      `);
      for (const path of paths) upsert.run(path, now);
    })();
  }

  /** Every extraction job ledger a worker noted here, so a Secret is cleared in each. */
  knownJobLedgerPaths(): string[] {
    return (this.db.query('SELECT path FROM known_job_ledgers ORDER BY path').all() as Array<{ path: string }>).map((row) => row.path);
  }

  /** Note that a Secret's side stores are about to be cleared (see `classificationRead`). */
  noteSecretScrub(identity: TierLedgerIdentity): SecretScrubMark {
    return this.db.transaction(() => {
      this.db.query(`
        INSERT INTO secret_side_store_scrubs (provider, account_scope, conversation_key, provider_item_id, revision)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT (provider, account_scope, conversation_key, provider_item_id) DO UPDATE SET revision = revision + 1
      `).run(...idParams(identity));
      const generation = this.db.query(`
        SELECT generation FROM tier_items
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      `).get(...idParams(identity)) as { generation: number } | null;
      return { revision: this.secretScrubRevision(identity), generation: generation?.generation ?? null };
    })();
  }

  private secretScrubRevision(identity: TierLedgerIdentity): number {
    const row = this.db.query(`
      SELECT revision FROM secret_side_store_scrubs
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).get(...idParams(identity)) as { revision: number } | null;
    return row?.revision ?? 0;
  }

  /** Whether the item is Secrets here: decided, moving there, or set so by the owner. */
  itemIsSecret(identity: TierLedgerIdentity): boolean {
    const override = this.getOverride(identity);
    if (override?.kind === 'tier' && override.tier === 'secrets') return true;
    const record = this.getCurrent(identity);
    if (!record) return false;
    return [record.metadataTier, record.contentTier, record.targetMetadataTier, record.targetContentTier].includes('secrets');
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

  /**
   * Per-item overrides of one provider still keyed without a conversation:
   * written before the ledger keyed items by conversation (schema 1). For a
   * chat source, where message ids repeat across conversations, such a row
   * matches no message any more. Content-free: identities only.
   */
  conversationlessOverrides(provider: string): TierLedgerIdentity[] {
    return (this.db.query(`
      SELECT provider, account_scope, provider_item_id FROM tier_overrides
      WHERE provider = ? AND conversation_key = ''
      ORDER BY account_scope, provider_item_id
    `).all(provider) as Array<{ provider: string; account_scope: string; provider_item_id: string }>)
      .map((row) => ({ provider: row.provider, accountScope: row.account_scope, providerItemId: row.provider_item_id }));
  }

  /**
   * Re-home a chat source's conversation-less overrides (see above) under the
   * conversation their message belongs to, when that is derivable: the
   * lane's stores hold the message in exactly ONE conversation. An override
   * already set under that conversation wins and the old row is dropped. Every
   * other row is kept as it is (it applies to nothing) and returned as
   * ORPHANED, so an explain surface can show it instead of losing it silently.
   */
  rehomeConversationlessOverrides(options: {
    provider: string;
    conversationsFor: (identity: TierLedgerIdentity) => readonly string[];
  }): { rehomed: number; orphaned: TierLedgerIdentity[] } {
    const orphaned: TierLedgerIdentity[] = [];
    let rehomed = 0;
    for (const identity of this.conversationlessOverrides(options.provider)) {
      const conversations = [...new Set(options.conversationsFor(identity).filter((key) => key.trim().length > 0))];
      if (conversations.length !== 1) {
        orphaned.push(identity);
        continue;
      }
      this.db.transaction(() => {
        this.db.query(`
          INSERT INTO tier_overrides (provider, account_scope, conversation_key, provider_item_id, override_json, set_at)
          SELECT provider, account_scope, ?, provider_item_id, override_json, set_at FROM tier_overrides
          WHERE provider = ? AND account_scope = ? AND conversation_key = '' AND provider_item_id = ?
          ON CONFLICT (provider, account_scope, conversation_key, provider_item_id) DO NOTHING
        `).run(conversations[0]!, identity.provider, identity.accountScope, identity.providerItemId);
        this.db.query(`
          DELETE FROM tier_overrides
          WHERE provider = ? AND account_scope = ? AND conversation_key = '' AND provider_item_id = ?
        `).run(identity.provider, identity.accountScope, identity.providerItemId);
      })();
      rehomed += 1;
    }
    return { rehomed, orphaned };
  }

  /**
   * Every per-item override in this ledger, canonically ordered, as one
   * content-free string (identities and override kinds). A tier migration
   * plan binds to its digest: an override set after planning makes the plan
   * stale, because the owner's decision changed what the plan should say.
   */
  overridesCanonical(): string {
    const rows = this.db.query(`
      SELECT provider, account_scope, conversation_key, provider_item_id, override_json FROM tier_overrides
      ORDER BY provider, account_scope, conversation_key, provider_item_id
    `).all() as Array<Record<string, string>>;
    return rows.map((row) => [row.provider, row.account_scope, row.conversation_key, row.provider_item_id, row.override_json]
      .join('\u0000')).join('\n');
  }

  /**
   * Remove the owner's per-item override. In the same write, a move it
   * queued is cancelled or replanned (`settleRevokedOwnerMove`): it no longer
   * has the owner's authority to land, and left as it is every retry would be
   * refused while its hidden sources keep the item out of search.
   */
  clearOverride(identity: TierLedgerIdentity): boolean {
    let cleared = false;
    this.db.transaction(() => {
      cleared = this.db.query(`
        DELETE FROM tier_overrides WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      `).run(...idParams(identity)).changes > 0;
      this.settleRevokedOwnerMove(identity);
    })();
    return cleared;
  }

  /**
   * Settle a move an owner override queued (the row is `moving`, decided by
   * `override`) whose target that override no longer asks for: it was
   * cleared or replaced. `completeMove` refuses to land such a move when it
   * lowers any layer, and `abandonMove` refuses one that hid its sources, so
   * left alone the item would stay mid-move, out of search, for good. In ONE
   * write, and never lowering any layer without the owner's current word:
   *
   * - A verified raise with no lowering layer keeps its receipt and completes
   *   from the destination, including after the lower source was stripped.
   * - The move hid nothing: it is cancelled. The item stays where it is, at
   *   its recorded tiers; the move's staged copies are kept hidden.
   * - The move hid its sources (some layer rises): it is replanned from those
   *   sources toward, per layer, the more private of the recorded tier and
   *   the move's target. That lands no layer below either, so it needs no
   *   owner authority; the sources stay hidden until it lands. A verified
   *   move uses its destinations as sources, since the old copies may be empty.
   *
   * Replanning/cancellation bumps the generation, so the revoked move's own
   * `stageMove`/`completeMove` (compare-and-swap on the generation) can never
   * land, and the row goes back to the decision the override took it over
   * from (decider, reasons, open questions, whether its text was read), so
   * the replanned move is placed by current policy (a lane floor yields to
   * the owner only) and an item waiting for its text keeps waiting for it. A move toward Secrets, or
   * one the current override still asks for, is left alone.
   *
   * Runs inside the caller's transaction: the write that clears or replaces
   * the override.
   */
  private settleRevokedOwnerMove(identity: TierLedgerIdentity): TierRevokedOwnerMoveOutcome {
    const existing = this.readRow(identity);
    if (!existing || !existing.routed || existing.state !== 'moving' || existing.decidedBy !== 'override') return 'none';
    const targetMetadata = existing.targetMetadataTier;
    const targetContent = existing.targetContentTier;
    if (targetMetadata === null || targetContent === null || targetMetadata === 'secrets' || targetContent === 'secrets') return 'none';
    if (overrideAuthorizes(this.getOverride(identity), targetMetadata, targetContent)) return 'none';
    const rawReceipt = this.readMeta(`tier-move-verified:${tierLedgerIdentityKey(identity)}`);
    const receipt = rawReceipt ? JSON.parse(rawReceipt) as {
      generation: number; raise: boolean;
      target: { metadataTier: TierKey; contentTier: TierKey };
      placement: TierCopyPlan[];
    } : undefined;
    const verified = receipt?.generation === existing.generation && receipt.raise
      && receipt.target.metadataTier === targetMetadata && receipt.target.contentTier === targetContent;
    const override = this.getOverride(identity);
    if (verified && tierRank(targetMetadata) >= tierRank(existing.metadataTier)
      && tierRank(targetContent) >= tierRank(existing.contentTier)
      && (override?.kind !== 'tier' || (tierRank(targetMetadata) >= tierRank(override.tier)
        && tierRank(targetContent) >= tierRank(override.tier)))) {
      // Revoking a safe raise cannot undo a verified copy or its destructive
      // purge. Keep its receipt and staged destination so resume can finish it.
      return 'none';
    }
    const decidedAt = this.now().toISOString();
    const prior = this.decisionBeforeOverride(identity, existing);
    const staleFlip = existing.generation + 1;
    const copies = this.copies(identity);
    const hidden = copies.some((copy) => copy.state === 'superseded' && copy.supersededByGeneration === staleFlip);
    if (!hidden) {
      // The revoked move's destinations: kept, hidden. It may already have
      // written the item's text into a less private store; a kept copy row
      // keeps that store row hidden from its lane and counted for an approved
      // purge. Tagged with the old generation, so a rollback at the new one
      // never restores them and no later move takes them as a source.
      this.db.query(`
        UPDATE tier_copies SET copy_state = 'superseded', superseded_by_generation = ?, updated_at = ?
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND copy_state = 'staged'
      `).run(existing.generation, decidedAt, ...idParams(identity));
      const state: TierLedgerState = prior.metadataPending || prior.contentPending ? 'pending' : 'current';
      const reasonsJson = JSON.stringify(prior.reasons);
      this.db.query(`
        UPDATE tier_items SET state = ?, target_metadata_tier = NULL, target_content_tier = NULL,
          generation = ?, decided_by = ?, reasons_json = ?, engine_version = ?, map_revision = ?, decided_at = ?,
          content_read = ?, metadata_pending = ?, content_pending = ?, metadata_forced = ?, metadata_flagged = ?,
          move_attempts = 0, owner_prior_json = NULL
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      `).run(
        state, staleFlip, prior.decidedBy, reasonsJson, prior.engineVersion, prior.mapRevision, decidedAt,
        ...decisionFlags(prior), ...idParams(identity),
      );
      this.appendHistory(identity, staleFlip, existing.metadataTier, existing.contentTier, prior.decidedBy, reasonsJson, state, decidedAt);
      return 'cancelled';
    }
    // The revoked move flips at generation + 1; the replanned one at + 2.
    const nextFlip = existing.generation + 2;
    // The copies the revoked move hid stay hidden, as the replanned move's sources.
    this.db.query(`
      UPDATE tier_copies SET superseded_by_generation = ?, updated_at = ?
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
        AND copy_state = 'superseded' AND superseded_by_generation = ?
    `).run(nextFlip, decidedAt, ...idParams(identity), staleFlip);
    // The revoked move's destinations: kept, hidden, never a source.
    this.db.query(`
      UPDATE tier_copies SET copy_state = 'superseded', superseded_by_generation = ?, updated_at = ?
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND copy_state = 'staged'
    `).run(staleFlip, decidedAt, ...idParams(identity));
    this.db.query(`
      UPDATE tier_items SET generation = ?
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).run(staleFlip, ...idParams(identity));
    if (verified) {
      // A revoked mixed move must not lower a layer. Replan from its verified
      // destinations: its old lower sources may already have been stripped.
      for (const copy of receipt!.placement) {
        this.db.query(`
          UPDATE tier_copies SET copy_state = 'superseded', layers = ?, superseded_by_generation = ?, updated_at = ?
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND corpus_id = ?
        `).run(copy.layers, nextFlip, decidedAt, ...idParams(identity), copy.corpusId);
      }
      for (const copy of copies.filter(copy => !receipt!.placement.some(dest => dest.corpusId === copy.corpusId))) {
        this.db.query(`
          UPDATE tier_copies SET superseded_by_generation = ?
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND corpus_id = ?
        `).run(staleFlip, ...idParams(identity), copy.corpusId);
      }
    }
    this.writeMeta(`tier-move-verified:${tierLedgerIdentityKey(identity)}`, '');
    this.queueMoveRow(identity, { ...existing, generation: staleFlip }, {
      ...prior,
      metadataTier: maxTier(existing.metadataTier, targetMetadata),
      contentTier: maxTier(existing.contentTier, targetContent),
    }, { hide: false, decidedAt });
    // The queued-move write never forgets text once read; the override only
    // counted as reading it, so the prior decision's word on that stands.
    this.db.query(`
      UPDATE tier_items SET content_read = ?, owner_prior_json = NULL
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).run(prior.contentRead ? 1 : 0, ...idParams(identity));
    return 'replanned';
  }

  /**
   * The decision an owner override took the item over from: saved when the
   * override queued its move (`owner_prior_json`). Not saved (a row queued
   * before schema 5): the newest non-override decider and reasons in the
   * item's history, with the row's own flags.
   */
  private decisionBeforeOverride(identity: TierLedgerIdentity, existing: TierLedgerRecord): OwnerPriorDecision {
    const saved = this.db.query(`
      SELECT owner_prior_json FROM tier_items
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).get(...idParams(identity)) as { owner_prior_json: string | null } | null;
    const parsed = saved?.owner_prior_json ? ownerPriorOf(saved.owner_prior_json) : undefined;
    if (parsed) return parsed;
    const fallback: OwnerPriorDecision = {
      decidedBy: 'move',
      reasons: existing.reasons.filter((reason) => !reason.startsWith('override:')),
      engineVersion: existing.engineVersion,
      mapRevision: existing.mapRevision,
      contentRead: existing.contentRead,
      metadataPending: existing.metadataPending,
      contentPending: existing.contentPending,
      metadataForced: existing.metadataForced,
      metadataFlagged: existing.metadataFlagged,
    };
    const row = this.db.query(`
      SELECT decided_by, reasons_json FROM tier_history
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND decided_by <> 'override'
      ORDER BY history_pk DESC LIMIT 1
    `).get(...idParams(identity)) as { decided_by: string; reasons_json: string } | null;
    if (row) {
      try {
        const reasons = JSON.parse(row.reasons_json) as unknown;
        if (Array.isArray(reasons) && reasons.every((reason) => typeof reason === 'string')) {
          return { ...fallback, decidedBy: row.decided_by, reasons };
        }
      } catch {
        // Unreadable history: fall through.
      }
    }
    return fallback;
  }

  // ---- P1b: routed placement and store copies --------------------------------

  /**
   * This ledger file's identity, minted once when it was created (schema 2).
   * A store that received routed copies records it (the tier-set binding),
   * so a reader that finds a different ledger — or none — where it looks
   * knows the visibility authority was lost and fails closed.
   */
  ledgerId(): string {
    const row = this.db.query(`SELECT value FROM tier_ledger_meta WHERE key = 'ledger_id'`).get() as { value: string } | null;
    if (!row) throw new Error('Tier ledger has no identity.');
    return row.value;
  }

  /**
   * The identity of the ledger file at a path, read without opening it as a
   * ledger: nothing is created, migrated or written to the ledger itself.
   * Undefined when the file is not there, is no ledger yet (no identity
   * minted), is busy or cannot be read. A store bound to a set checks a
   * candidate with this before it opens anything
   * (classification/tier-set-binding.ts).
   *
   * The file is opened read-only first: a read-only connection never
   * checkpoints or writes the main file, and it reads what a crash left in
   * the -wal. SQLite may still create the -shm beside it. macOS's SQLite
   * refuses a read-only connection to a WAL database that has no -wal file
   * (how a ledger looks after a clean close and a rename); only then is it
   * opened read-write with the connection set to query-only. That second open
   * happens only when no -wal holds frames and no -journal is waiting, so
   * there is nothing to checkpoint or roll back and the main file stays as it
   * was; empty -wal and -shm files may appear beside it. A busy file is not
   * tried a second way: an exclusive holder costs one `busyTimeoutMs`, not two.
   */
  static readLedgerId(dbPath: string, options: { busyTimeoutMs?: number } = {}): string | undefined {
    if (dbPath === ':memory:' || !existsSync(dbPath)) return undefined;
    const busyTimeoutMs = Math.max(0, Math.trunc(options.busyTimeoutMs ?? 10_000));
    for (const mode of [{ readonly: true, create: false }, { readwrite: true, create: false }] as const) {
      if ('readwrite' in mode && hasUnmergedWrites(dbPath)) return undefined;
      let db: Database | undefined;
      try {
        db = new Database(dbPath, mode);
        db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA query_only = ON;`);
        const row = db.query(`SELECT value FROM tier_ledger_meta WHERE key = 'ledger_id'`).get() as { value?: unknown } | null;
        return typeof row?.value === 'string' && row.value !== '' ? row.value : undefined;
      } catch (error) {
        if (isSqliteBusy(error)) return undefined;
        // Try the next way of opening it.
      } finally {
        if (db) closeSqliteStore(db, { checkpoint: false });
      }
    }
    return undefined;
  }

  /**
   * Runs `work` while every other writer of this ledger is held off: a check
   * of a decision and a write that depends on it, with no decision landing
   * between them. Another connection waits for the hold, as for any write
   * (its busy timeout); this connection's own writes inside `work` nest in it.
   * What `work` wrote stays written whether it returns or throws, as it would
   * without the hold. Keep `work` short: every other writer waits for it.
   */
  async holdingWrites<T>(work: () => Promise<T>): Promise<T> {
    if (this.db.inTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      return await work();
    } finally {
      this.db.exec('COMMIT');
    }
  }

  /** A small named value kept beside the ledger (a background pass's resume point); never item content. */
  readMeta(key: string): string | undefined {
    if (key === 'ledger_id') return undefined;
    const row = this.db.query('SELECT value FROM tier_ledger_meta WHERE key = ?').get(key) as { value: string } | null;
    return row?.value;
  }

  writeMeta(key: string, value: string): void {
    if (key === 'ledger_id') throw new Error('The ledger identity is never rewritten.');
    this.metaChanges += this.db.query(`
      INSERT INTO tier_ledger_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value).changes;
  }

  deleteMeta(key: string): void {
    if (key === 'ledger_id') throw new Error('The ledger identity is never deleted.');
    this.metaChanges += this.db.query('DELETE FROM tier_ledger_meta WHERE key = ?').run(key).changes;
  }

  /** Atomic publication of related content-free background receipts. */
  writeMetaBatch(entries: readonly (readonly [string, string])[]): void {
    this.db.transaction(() => { for (const [key, value] of entries) this.writeMeta(key, value); })();
  }

  /** A withdrawal on another connection cannot be followed by stale scan references. */
  writeEmbeddingTrainingScan(value: string, revision: string): boolean {
    return this.db.transaction(() => {
      if ((this.readMeta('embedding-prefilter:training-revision') ?? '0') !== revision) return false;
      this.writeMeta('embedding-prefilter:training-scan-v1', value);
      return true;
    }).immediate();
  }

  /** Small durable work receipts, without exporting any store content. */
  metaEntries(prefix: string, options: { after?: string; limit?: number } = {}): Array<{ key: string; value: string }> {
    return this.db.query(`SELECT key, value FROM tier_ledger_meta INDEXED BY tier_ledger_pending_meta
      WHERE key >= ? AND key < ? AND key > ? AND value <> '' ORDER BY key LIMIT ?`)
      .all(prefix, `${prefix}\uffff`, options.after ?? '', options.limit ?? -1) as Array<{ key: string; value: string }>;
  }

  /** Hold the ledger write lock across a synchronous cross-store cleanup.
   * The generation check and deletions cannot race a new routing decision.
   */
  withGenerationFence<T>(identity: TierLedgerIdentity, generation: number, work: () => T): T {
    return this.db.transaction(() => {
      // Acquire the SQLite writer lock before reading the authority.
      this.db.query("UPDATE tier_ledger_meta SET value = value WHERE key = 'ledger_id'").run();
      if (this.getCurrent(identity)?.generation !== generation) throw new TierLedgerGenerationConflictError();
      return work();
    })();
  }

  /** Lowering batches commit their store copies before publishing receipts. */
  withMoveBatch<T>(work: () => T, committed?: (ms: number) => void): T {
    let bodyMs = 0;
    const started = performance.now();
    const result = this.db.transaction(() => {
      const bodyStarted = performance.now();
      try { return work(); } finally { bodyMs = performance.now() - bodyStarted; }
    }).immediate();
    committed?.(performance.now() - started - bodyMs);
    return result;
  }

  /**
   * Routed rows in key order after `after`, at most `limit`: a bounded page
   * for background passes that read every routed item (owner-rule sweeps).
   */
  listRouted(options: { after?: TierLedgerIdentity; limit?: number } = {}): TierLedgerRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 50_000));
    const after = options.after
      ? [options.after.provider, options.after.accountScope, tierLedgerConversationKey(options.after), options.after.providerItemId]
      : null;
    const rows = this.db.query(`
      SELECT * FROM tier_items
      WHERE routed = 1
        AND (? IS NULL OR (provider, account_scope, conversation_key, provider_item_id) > (?, ?, ?, ?))
      ORDER BY provider, account_scope, conversation_key, provider_item_id
      LIMIT ?
    `).all(after ? 1 : null, ...(after ?? [null, null, null, null]), limit);
    return (rows as TierItemRow[]).map(recordFromRow);
  }

  /** Bound actual rows examined, even when almost none are routed/eligible. */
  listItemWindow(options: { after?: TierLedgerIdentity; limit: number }): TierLedgerRecord[] {
    const after = options.after
      ? [options.after.provider, options.after.accountScope, tierLedgerConversationKey(options.after), options.after.providerItemId]
      : [];
    const rows = this.db.query(`SELECT * FROM tier_items
      ${after.length ? 'WHERE (provider, account_scope, conversation_key, provider_item_id) > (?, ?, ?, ?)' : ''}
      ORDER BY provider, account_scope, conversation_key, provider_item_id LIMIT ?`)
      .all(...after, Math.max(1, Math.min(options.limit, 500))) as TierItemRow[];
    return rows.map(recordFromRow);
  }

  /** Historical repair candidates only: indexed copy/identity/content probes. */
  listLowerContentLeftovers(options: {
    stores: Array<{ corpusId: string; dbPath: string; trustDomain: SourceTrustDomain }>;
    after?: TierLedgerIdentity;
    limit: number;
  }): TierLedgerRecord[] {
    const attached: string[] = [];
    try {
      const queries: string[] = [];
      const params: string[] = [];
      for (const store of options.stores) {
        const alias = `purge_lower_${attached.length}`;
        this.db.query(`ATTACH DATABASE ? AS ${alias}`).run(store.dbPath);
        attached.push(alias);
        const higher = store.trustDomain === 'public_safe' ? "('internal', 'secure_local')" : "('secure_local')";
        const metadataAllowed = store.trustDomain === 'public_safe' ? "('public_safe')" : "('public_safe', 'internal')";
        queries.push(`SELECT l.provider, l.account_scope, l.conversation_key, l.provider_item_id
          FROM tier_copies l INDEXED BY tier_copies_corpus
          JOIN ${alias}.items s ON s.provider = l.provider AND s.account_scope = l.account_scope
            AND s.normalized_conversation = l.conversation_key AND s.provider_item_id = l.provider_item_id
          WHERE l.corpus_id = ? AND s.tombstoned = 0
            AND EXISTS (SELECT 1 FROM tier_copies h
              WHERE h.provider = l.provider AND h.account_scope = l.account_scope
                AND h.conversation_key = l.conversation_key AND h.provider_item_id = l.provider_item_id
                AND h.copy_state = 'current' AND h.layers IN ('content', 'both') AND h.trust_domain IN ${higher})
            AND (EXISTS (SELECT 1 FROM ${alias}.chunks c WHERE c.item_pk = s.item_pk)
              OR EXISTS (SELECT 1 FROM ${alias}.chunk_embeddings e WHERE e.item_pk = s.item_pk)
              OR EXISTS (SELECT 1 FROM ${alias}.item_text_versions v WHERE v.item_pk = s.item_pk)
              OR ((s.title IS NOT NULL OR s.locator_uri IS NOT NULL OR s.search_text IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM tier_copies m
                  WHERE m.provider = l.provider AND m.account_scope = l.account_scope
                    AND m.conversation_key = l.conversation_key AND m.provider_item_id = l.provider_item_id
                    AND m.copy_state = 'current' AND m.layers IN ('metadata', 'both')
                    AND m.trust_domain IN ${metadataAllowed})))`);
        params.push(store.corpusId);
      }
      if (!queries.length) return [];
      const after = options.after ? idParams(options.after) : ['', '', '', ''];
      const rows = this.db.query(`SELECT i.* FROM (${queries.join(' UNION ')}) candidates
        JOIN tier_items i USING (provider, account_scope, conversation_key, provider_item_id)
        WHERE i.routed = 1 AND i.state <> 'moving'
          AND i.metadata_tier <> 'secrets' AND i.content_tier <> 'secrets'
          AND (i.provider, i.account_scope, i.conversation_key, i.provider_item_id) > (?, ?, ?, ?)
        ORDER BY i.provider, i.account_scope, i.conversation_key, i.provider_item_id LIMIT ?`)
        .all(...params, ...after, options.limit) as TierItemRow[];
      return rows.map(recordFromRow);
    } finally {
      for (const alias of attached.reverse()) this.db.exec(`DETACH DATABASE ${alias}`);
    }
  }

  /**
   * Every item judged Secrets in either layer, in key order, with whether its
   * names were judged Secrets too: what a lane that keeps a raw copy outside
   * the stores (a capture spool) must clear, and how much of it. Identities
   * only, never content; the list is small by nature.
   */
  secretsIdentities(): Array<{ identity: TierLedgerIdentity; names: boolean }> {
    const rows = this.db.query(`
      SELECT provider, account_scope, conversation_key, provider_item_id, metadata_tier FROM tier_items
      WHERE metadata_tier = 'secrets' OR content_tier = 'secrets'
      ORDER BY provider, account_scope, conversation_key, provider_item_id
    `).all() as Array<{
      provider: string;
      account_scope: string;
      conversation_key: string;
      provider_item_id: string;
      metadata_tier: string;
    }>;
    return rows.map((row) => ({
      identity: {
        provider: row.provider,
        accountScope: row.account_scope,
        providerItemId: row.provider_item_id,
        ...(row.conversation_key ? { providerConversationId: row.conversation_key } : {}),
      },
      names: row.metadata_tier === 'secrets',
    }));
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
        // An item whose deletion or Secret is under way (an intent not yet cleared) is hidden at once: a read in
        // the same snapshot sees every copy as superseded, whichever legs have been written so far.
        const pending = this.db.query(`
          SELECT provider, account_scope, conversation_key, provider_item_id FROM tier_write_intents
          WHERE kind IN ('deletion', 'secret')
            AND (provider, account_scope, conversation_key, provider_item_id) IN (VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')})
        `).all(...batch.flatMap((identity) => [...idParams(identity)])) as Array<{ provider: string; account_scope: string; conversation_key: string; provider_item_id: string }>;
        for (const row of pending) {
          const hidden = result.get(tierLedgerIdentityKey(identityFromRow(row as never)));
          if (hidden) for (const copy of hidden) if (copy.state !== 'superseded') copy.state = 'superseded';
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
      /**
       * Queue a RAISE without hiding the current copies first: the item stays
       * visible where it is until the move runs (the move primitive hides its
       * source first itself). Only for a decision nobody acts on at once: a
       * background re-judge on an install whose moves wait for the
       * owner-approved migration (it becomes that migration's proposal).
       */
      queueWithoutHiding?: boolean;
      /** An owner-override pass's read, re-checked in this transaction (see TierOwnerOverrideGuard). */
      guard?: TierOwnerOverrideGuard;
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
      if (options.guard) this.assertOverrideGuard(identity, existing, options.guard);
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
      // Recover only an impossible move with no copies at all. A staged,
      // hidden or superseded copy still belongs to its move and must never
      // be replaced by an ordinary sync.
      const emptyMove = existing.state === 'moving' && options.staleCopiesGone === true && previousCopies.length === 0;
      if (existing.state === 'moving' && !emptyMove) {
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
        const generation = tiersChanged || emptyMove ? existing.generation + 1 : existing.generation;
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
              target_metadata_tier = NULL, target_content_tier = NULL, move_attempts = 0,
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
      // The decision's open questions travel with it: a move to a placement
      // that HOLDS the item for an unanswered sniffer question must land it
      // held and pending (`moveTieredItem` places by these flags, and the flip
      // keeps the row pending), never at its tiers' resting placement. Text
      // once read is never forgotten.
      raise = placementIsRaise(current, plan.copies);
      this.queueMoveRow(identity, existing, decision, { hide: raise && options.queueWithoutHiding !== true, decidedAt });
      outcome = 'queued_move';
    })();
    return { outcome, record: this.getCurrent(identity)!, previousCopies, raise };
  }

  /**
   * An owner per-item override that RAISES a routed item, applied at once by
   * `olympus tier set` (a process that does not hold the item's tiered store
   * set) and by the set's override pass; an owner RULE that newly matches an
   * item mid-move (tier-rules-sweep.ts) is raised the same way. In ONE write:
   *
   * - Not moving: when any layer is served from a store less private than
   *   `trustDomain` (the override tier's store), every current copy is hidden
   *   and the move to the decision's tiers is queued, exactly as
   *   `recordRoutedPlacement` queues a raise ('hidden').
   * - Mid-move toward tiers less private than the owner's (a queued or
   *   in-flight lower): that move is invalidated. The generation is bumped,
   *   so its `stageMove`/`completeMove` (compare-and-swap on the generation)
   *   can never publish; its staged destination copies are kept hidden; the
   *   copies an earlier raise hid stay the sources of the new move; and any
   *   current copy below `trustDomain` is hidden ('hidden'). The move is
   *   retargeted to the decision's tiers ('retargeted' when nothing needed
   *   hiding). A move toward Secrets, or toward tiers at least as private as
   *   the owner's, is left alone.
   *
   * 'none': nothing written. The set plans and runs the move (tier-move.ts).
   */
  queueOwnerRaise(
    identity: TierLedgerIdentity,
    decision: TierDecision,
    trustDomain: SourceTrustDomain,
    options: { guard?: TierOwnerOverrideGuard } = {},
  ): TierOwnerRaiseOutcome {
    if (decision.decidedBy !== 'override' && decision.decidedBy !== 'owner_rule') throw new Error('Only an owner override or owner rule is queued this way.');
    if (!(trustDomain in TRUST_DOMAIN_RANK)) throw new Error(`Unknown trust domain "${trustDomain}".`);
    let result: TierOwnerRaiseOutcome = 'none';
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (options.guard) this.assertOverrideGuard(identity, existing, options.guard);
      if (!existing || !existing.routed) return;
      const decidedAt = this.now().toISOString();
      const unsafe = this.copies(identity)
        .some((copy) => copy.state === 'current' && trustDomainRank(copy.trustDomain) < trustDomainRank(trustDomain));
      if (existing.state !== 'moving') {
        if (!unsafe) return;
        this.queueMoveRow(identity, existing, decision, { hide: true, decidedAt });
        result = 'hidden';
        return;
      }
      const targetMetadata = existing.targetMetadataTier;
      const targetContent = existing.targetContentTier;
      if (targetMetadata === null || targetContent === null) return;
      if (targetMetadata === 'secrets' || targetContent === 'secrets'
        || (tierRank(targetMetadata) >= tierRank(decision.metadataTier) && tierRank(targetContent) >= tierRank(decision.contentTier))) {
        // The move in flight lands at least as private as the owner asks, but
        // it may have been queued without hiding (a re-home, a re-judge on an
        // install whose moves wait for the migration): its copies below the
        // owner's tier are hidden now, as the move's own sources.
        if (!unsafe) return;
        this.supersedeCurrentCopies(identity, existing.generation + 1, decidedAt);
        result = 'hidden';
        return;
      }
      // The in-flight move flips at generation + 1; the retargeted one at + 2.
      const staleFlip = existing.generation + 1;
      const nextFlip = existing.generation + 2;
      // Copies an earlier raise hid for the old move stay sources of the new one.
      this.db.query(`
        UPDATE tier_copies SET superseded_by_generation = ?, updated_at = ?
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
          AND copy_state = 'superseded' AND superseded_by_generation = ?
      `).run(nextFlip, decidedAt, ...idParams(identity), staleFlip);
      // The old move's destinations: kept, hidden, never a source.
      this.db.query(`
        UPDATE tier_copies SET copy_state = 'superseded', superseded_by_generation = ?, updated_at = ?
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND copy_state = 'staged'
      `).run(staleFlip, decidedAt, ...idParams(identity));
      this.db.query(`
        UPDATE tier_items SET generation = ?
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      `).run(staleFlip, ...idParams(identity));
      this.queueMoveRow(identity, { ...existing, generation: staleFlip }, decision, { hide: unsafe, decidedAt });
      result = unsafe ? 'hidden' : 'retargeted';
    })();
    return result;
  }

  /** Refuse a background write whose owner-override read is stale (see TierOwnerOverrideGuard). */
  private assertOverrideGuard(
    identity: TierLedgerIdentity,
    existing: TierLedgerRecord | undefined,
    guard: TierOwnerOverrideGuard,
  ): void {
    if (!existing || existing.generation !== guard.generation) throw new TierLedgerGenerationConflictError();
    const current = this.getOverride(identity);
    if (JSON.stringify(current ?? null) !== JSON.stringify(guard.override ?? null)) {
      throw new TierLedgerGenerationConflictError('The owner override changed; re-read it before acting.');
    }
  }

  /**
   * Of the given items, the keys of ROUTED items with no copy row at all (a
   * Secret whose copies were settled, or one the provider deleted). Such an
   * item is never legacy: a visibility check must hide it, not pass it.
   */
  routedWithoutCopies(identities: readonly TierLedgerIdentity[]): Set<string> {
    const result = new Set<string>();
    if (identities.length === 0) return result;
    const unique = new Map<string, TierLedgerIdentity>();
    for (const identity of identities) unique.set(tierLedgerIdentityKey(identity), identity);
    const list = [...unique.values()];
    this.db.transaction(() => {
      for (let offset = 0; offset < list.length; offset += 200) {
        const batch = list.slice(offset, offset + 200);
        const rows = this.db.query(`
          SELECT i.provider, i.account_scope, i.conversation_key, i.provider_item_id FROM tier_items i
          WHERE i.routed = 1
            AND (i.provider, i.account_scope, i.conversation_key, i.provider_item_id) IN (VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')})
            AND NOT EXISTS (
              SELECT 1 FROM tier_copies c
              WHERE c.provider = i.provider AND c.account_scope = i.account_scope
                AND c.conversation_key = i.conversation_key AND c.provider_item_id = i.provider_item_id
            )
        `).all(...batch.flatMap((identity) => [...idParams(identity)])) as Array<Pick<TierItemRow, 'provider' | 'account_scope' | 'conversation_key' | 'provider_item_id'>>;
        for (const row of rows) result.add(tierLedgerIdentityKey(identityOfRow(row)));
      }
    })();
    return result;
  }

  /**
   * Each item's row and copies, read in ONE transaction so every item is
   * judged against one ledger snapshot: one batched query for the rows and
   * one for the copies (per 200 items). Keyed by `tierLedgerIdentityKey`;
   * an item with no row is absent from the map (never classified).
   */
  itemStatesForMany(
    identities: readonly TierLedgerIdentity[],
  ): Map<string, { record: TierLedgerRecord; copies: TierCopy[] }> {
    const result = new Map<string, { record: TierLedgerRecord; copies: TierCopy[] }>();
    if (identities.length === 0) return result;
    const unique = new Map<string, TierLedgerIdentity>();
    for (const identity of identities) unique.set(tierLedgerIdentityKey(identity), identity);
    const list = [...unique.values()];
    this.db.transaction(() => {
      for (let offset = 0; offset < list.length; offset += 200) {
        const batch = list.slice(offset, offset + 200);
        const values = batch.map(() => '(?, ?, ?, ?)').join(', ');
        const params = batch.flatMap((identity) => [...idParams(identity)]);
        const rows = this.db.query(`
          SELECT * FROM tier_items
          WHERE (provider, account_scope, conversation_key, provider_item_id) IN (VALUES ${values})
        `).all(...params) as TierItemRow[];
        for (const row of rows) {
          result.set(tierLedgerIdentityKey(identityOfRow(row)), { record: recordFromRow(row), copies: [] });
        }
        const copies = this.db.query(`
          SELECT * FROM tier_copies
          WHERE (provider, account_scope, conversation_key, provider_item_id) IN (VALUES ${values})
          ORDER BY corpus_id
        `).all(...params) as TierCopyRow[];
        for (const row of copies) result.get(tierLedgerIdentityKey(identityFromRow(row)))?.copies.push(copyFromRow(row));
      }
    })();
    return result;
  }

  /**
   * Routed items that carry a per-item owner override, with it, in key order.
   * Overrides are set by hand, one item at a time, so the list is small; the
   * override pass (tier-override-settle.ts) reads it whole. The read starts
   * from the overrides (CROSS JOIN fixes the order): started from tier_items
   * it walked every item on each sniffer tick, an eighth of Sparta's sampled
   * freezes (14b9be8, 2026-11-05).
   */
  listRoutedOverrides(): Array<{ record: TierLedgerRecord; override: ItemTierOverride }> {
    const rows = this.db.query(`
      SELECT i.*, o.override_json AS override_json FROM tier_overrides o
      CROSS JOIN tier_items i
        ON i.provider = o.provider AND i.account_scope = o.account_scope
        AND i.conversation_key = o.conversation_key AND i.provider_item_id = o.provider_item_id
      WHERE i.routed = 1
      ORDER BY o.provider, o.account_scope, o.conversation_key, o.provider_item_id
    `).all() as Array<TierItemRow & { override_json: string }>;
    const result: Array<{ record: TierLedgerRecord; override: ItemTierOverride }> = [];
    for (const row of rows) {
      let parsed: ItemTierOverride;
      try {
        parsed = JSON.parse(row.override_json) as ItemTierOverride;
      } catch {
        continue;
      }
      if (parsed.kind === 'tier' && !TIER_KEYS.includes(parsed.tier)) continue;
      if (parsed.kind !== 'tier' && parsed.kind !== 'not_secret') continue;
      result.push({ record: recordFromRow(row), override: parsed });
    }
    return result;
  }

  /**
   * The most recently decided items, newest first (the dashboard's "recently
   * sorted" list, tier-owner-items.ts). Content-free: ledger rows only.
   */
  recentDecisions(limit = 25): TierLedgerRecord[] {
    const rows = this.db.query(`
      SELECT * FROM tier_items ORDER BY decided_at DESC, provider, account_scope, conversation_key, provider_item_id LIMIT ?
    `).all(Math.max(1, Math.min(limit, 200))) as TierItemRow[];
    return rows.map(recordFromRow);
  }

  /**
   * Routed items still resting on an owner override that has since been
   * cleared (the owner's "undo"): settled at the override's tiers, decided by
   * `override`, with no override row left. The set's override pass puts each
   * back to the decision the override took it over from
   * (`settledDecisionBeforeOverride`).
   */
  listClearedOverrideRows(limit = 100, after?: Pick<TierLedgerRecord, 'provider' | 'accountScope' | 'conversationKey' | 'providerItemId'>): TierLedgerRecord[] {
    // `after` pages past rows a pass could not restore, so they never block the rest.
    const rows = this.db.query(`
      SELECT i.* FROM tier_items i
      WHERE i.routed = 1 AND i.state = 'current' AND i.decided_by = 'override'
        AND (? IS NULL OR (i.provider, i.account_scope, i.conversation_key, i.provider_item_id) > (?, ?, ?, ?))
        AND NOT EXISTS (
          SELECT 1 FROM tier_overrides o
          WHERE o.provider = i.provider AND o.account_scope = i.account_scope
            AND o.conversation_key = i.conversation_key AND o.provider_item_id = i.provider_item_id
        )
      ORDER BY i.provider, i.account_scope, i.conversation_key, i.provider_item_id
      LIMIT ?
    `).all(
      after ? 1 : null,
      after?.provider ?? null, after?.accountScope ?? null, after?.conversationKey ?? null, after?.providerItemId ?? null,
      Math.max(1, Math.min(limit, 1_000)),
    ) as TierItemRow[];
    return rows.map(recordFromRow);
  }

  /**
   * The newest settled decision in the item's history that no owner override
   * made: what the judge (or the item's other automatic steps) decided before
   * the owner changed it. Undefined when the owner set the item before any
   * such decision was recorded.
   */
  settledDecisionBeforeOverride(identity: TierLedgerIdentity): { metadataTier: TierKey; contentTier: TierKey; decidedBy: string; reasons: string[] } | undefined {
    const row = this.db.query(`
      SELECT metadata_tier, content_tier, decided_by, reasons_json FROM tier_history
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
        AND state = 'current' AND decided_by != 'override' AND instr(reasons_json, '"override:') = 0
      ORDER BY history_pk DESC
      LIMIT 1
    `).get(...idParams(identity)) as { metadata_tier: TierKey; content_tier: TierKey; decided_by: string; reasons_json: string } | null;
    if (!row || !TIER_KEYS.includes(row.metadata_tier) || !TIER_KEYS.includes(row.content_tier)) return undefined;
    let reasons: string[];
    try {
      const parsed = JSON.parse(row.reasons_json) as unknown;
      reasons = Array.isArray(parsed) ? parsed.filter((reason): reason is string => typeof reason === 'string') : [];
    } catch {
      reasons = [];
    }
    return { metadataTier: row.metadata_tier, contentTier: row.content_tier, decidedBy: row.decided_by, reasons };
  }

  /**
   * The queued-move write: the item goes `moving` with the decision's tiers
   * as its target and the decision's flags; with `hide`, every current copy
   * is superseded first (a raise hides before anything moves). The copy
   * itself is the move primitive's job. Runs inside the caller's transaction.
   */
  private queueMoveRow(
    identity: TierLedgerIdentity,
    existing: TierLedgerRecord,
    decision: QueuedMoveDecision,
    options: { hide: boolean; decidedAt: string },
  ): void {
    const reasonsJson = JSON.stringify(decision.reasons);
    this.db.query(`
      UPDATE tier_items SET state = 'moving', target_metadata_tier = ?, target_content_tier = ?,
        decided_by = ?, reasons_json = ?, engine_version = ?, map_revision = ?, decided_at = ?,
        content_read = MAX(content_read, ?), metadata_pending = ?, content_pending = ?,
        metadata_forced = ?, metadata_flagged = ?, move_attempts = 0
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).run(
      decision.metadataTier,
      decision.contentTier,
      decision.decidedBy,
      reasonsJson,
      decision.engineVersion,
      decision.mapRevision,
      options.decidedAt,
      ...decisionFlags(decision),
      ...idParams(identity),
    );
    if (decision.decidedBy === 'override' && existing.decidedBy !== 'override') {
      // The decision the owner takes the row over from, for a revoked move.
      const prior: OwnerPriorDecision = {
        decidedBy: existing.decidedBy,
        reasons: existing.reasons,
        engineVersion: existing.engineVersion,
        mapRevision: existing.mapRevision,
        contentRead: existing.contentRead,
        metadataPending: existing.metadataPending,
        contentPending: existing.contentPending,
        metadataForced: existing.metadataForced,
        metadataFlagged: existing.metadataFlagged,
      };
      this.db.query(`
        UPDATE tier_items SET owner_prior_json = ?
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      `).run(JSON.stringify(prior), ...idParams(identity));
    }
    this.appendHistory(identity, existing.generation, decision.metadataTier, decision.contentTier, decision.decidedBy, reasonsJson, 'moving', options.decidedAt);
    if (options.hide) this.supersedeCurrentCopies(identity, existing.generation + 1, options.decidedAt);
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
  adoptLegacyPlacement(
    identity: TierLedgerIdentity,
    copies: readonly TierCopyPlan[],
    options: {
      /**
       * An item stored before the ledger recorded anything has no row. The
       * migration records its placement as it stands (these tiers, decided by
       * `legacy_placement`), so a rollback flips back to exactly where it was.
       */
      whenMissing?: { family: string; metadataTier: TierKey; contentTier: TierKey };
    } = {},
  ): TierLedgerRecord {
    for (const copy of copies) assertCopyPlan(copy);
    const now = this.now().toISOString();
    this.db.transaction(() => {
      let existing = this.readRow(identity);
      if (!existing && options.whenMissing) {
        const missing = options.whenMissing;
        assertTier(missing.metadataTier);
        assertTier(missing.contentTier);
        const reasonsJson = JSON.stringify(['legacy_placement']);
        this.db.query(`
          INSERT INTO tier_items (
            provider, account_scope, conversation_key, provider_item_id, family,
            metadata_tier, content_tier, generation, decided_by, reasons_json,
            engine_version, map_revision, state, content_read, decided_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'legacy_placement', ?, 'legacy', 'none', 'current', 0, ?)
        `).run(...idParams(identity), missing.family, missing.metadataTier, missing.contentTier, reasonsJson, now);
        this.appendHistory(identity, 1, missing.metadataTier, missing.contentTier, 'legacy_placement', reasonsJson, 'current', now);
        existing = this.readRow(identity);
      }
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
        UPDATE tier_items SET state = 'moving', target_metadata_tier = ?, target_content_tier = ?,
          move_attempts = CASE WHEN state = 'moving' THEN move_attempts ELSE 0 END
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
      /**
       * The decision the move carries out (the migration's), recorded in the
       * same write: whether its text was read, open questions, and the
       * classifier versions. Omitted: the row's flags stay as they were.
       */
      decision?: Pick<
        TierDecision,
        'contentRead' | 'metadataPending' | 'contentPending' | 'metadataForced' | 'metadataFlagged' | 'engineVersion' | 'mapRevision'
      >;
      /**
       * The placement's embedding hold, applied to every copy the flip makes
       * current. A source copy re-layered in place otherwise keeps the hold
       * an earlier pending decision put on it, and a decided item stays
       * "awaiting classification" and unembedded forever.
       */
      embedHold?: boolean;
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
      // The owner's current word bounds every flip, whoever queued the move:
      // - no layer lands below a current tier override (a re-judge or rule
      //   queued before the owner raised the item never publishes it lower);
      // - a move an override queued that LOWERS any layer (judged per layer:
      //   hidden sources only prove some layer rises) lands only while that
      //   override still asks for exactly these tiers.
      const override = this.getOverride(identity);
      const targetMetadataTier = existing.targetMetadataTier;
      const targetContentTier = existing.targetContentTier;
      if (override?.kind === 'tier'
        && (tierRank(targetMetadataTier) < tierRank(override.tier) || tierRank(targetContentTier) < tierRank(override.tier))
        && !overrideAuthorizes(override, targetMetadataTier, targetContentTier)) {
        throw new TierLedgerGenerationConflictError('The owner has since set this item more private; the move may not land below it.');
      }
      const lowersLayer = tierRank(targetMetadataTier) < tierRank(existing.metadataTier)
        || tierRank(targetContentTier) < tierRank(existing.contentTier);
      if (existing.decidedBy === 'override' && lowersLayer && !overrideAuthorizes(override, targetMetadataTier, targetContentTier)) {
        throw new TierLedgerGenerationConflictError('The owner override behind this move changed; re-read it before landing.');
      }
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
      if (options.embedHold !== undefined) {
        this.db.query(`
          UPDATE tier_copies SET embed_hold = ?
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND copy_state = 'current'
        `).run(options.embedHold ? 1 : 0, ...idParams(identity));
      }
      this.flipTiers(identity, existing, {
        metadataTier: existing.targetMetadataTier,
        contentTier: existing.targetContentTier,
        generation,
        decidedBy: options.decidedBy ?? 'move',
        reasons: options.reasons ?? existing.reasons,
        decidedAt: now,
        // The queued decision's open questions (recorded with the move) keep
        // the item pending after the flip.
        state: existing.metadataPending || existing.contentPending ? 'pending' : 'current',
      });
      if (options.decision) {
        const decision = options.decision;
        const pending = decision.metadataPending || decision.contentPending;
        this.db.query(`
          UPDATE tier_items SET
            content_read = ?, metadata_pending = ?, content_pending = ?, metadata_forced = ?, metadata_flagged = ?,
            engine_version = ?, map_revision = ?, state = ?
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
        `).run(
          decision.contentRead ? 1 : 0,
          decision.metadataPending ? 1 : 0,
          decision.contentPending ? 1 : 0,
          decision.metadataForced ? 1 : 0,
          decision.metadataFlagged ? 1 : 0,
          decision.engineVersion,
          decision.mapRevision,
          pending ? 'pending' : 'current',
          ...idParams(identity),
        );
      }
    })();
    return this.getCurrent(identity)!;
  }

  /**
   * Rollback is a ledger flip: the copies the last flip superseded become
   * current again, re-layered copies get their old layers back, and the copies
   * the flip made current become superseded. No store is written and nothing
   * is re-embedded. A Secrets row is refused whatever the caller checked
   * (defense in depth): rolling it back would make the Secret visible again.
   */
  rollbackMove(identity: TierLedgerIdentity, options: { expectedGeneration: number }): TierLedgerRecord {
    const now = this.now().toISOString();
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (this.readMeta(`tier-content-purged:${tierLedgerIdentityKey(identity)}`) === String(options.expectedGeneration)) {
        throw new TierLedgerPurgedRollbackRefusedError();
      }
      if (existing && (existing.contentTier === 'secrets' || existing.metadataTier === 'secrets')) {
        throw new TierLedgerSecretsRollbackRefusedError();
      }
      // A flip that carried an open question (pending) is rolled back too; only
      // a row mid-move is refused.
      if (!existing || existing.generation !== options.expectedGeneration || existing.state === 'moving'
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
   * Give up a move that never flipped (queued, or interrupted between stage
   * and flip) and leave the item exactly where it was: its current copies
   * serve as before, any copy the move staged stays hidden as an abandoned
   * destination (superseded with no flip generation, replaceable by a later
   * authorized move), and the row leaves `moving` at its unchanged tiers.
   * Its newest decision's flags stay recorded. No store is written.
   *
   * Refused unless the row is mid-move at the expected generation, for a move
   * toward Secrets, and for a raise that hid its source copies (abandoning it
   * would serve the item below its newest decision).
   */
  abandonMove(identity: TierLedgerIdentity, options: { expectedGeneration: number }): TierLedgerRecord {
    const now = this.now().toISOString();
    this.db.transaction(() => {
      const existing = this.readRow(identity);
      if (!existing || existing.generation !== options.expectedGeneration || existing.state !== 'moving') {
        throw new TierLedgerGenerationConflictError();
      }
      if (existing.targetContentTier === 'secrets' || existing.targetMetadataTier === 'secrets'
        || existing.contentTier === 'secrets' || existing.metadataTier === 'secrets') {
        throw new TierLedgerSecretsRollbackRefusedError();
      }
      const moveGeneration = existing.generation + 1;
      const copies = this.copies(identity);
      if (copies.some((copy) => copy.state === 'superseded' && copy.supersededByGeneration === moveGeneration)) {
        throw new TierLedgerRaiseAbandonRefusedError();
      }
      // A destination may already hold committed rows. Keep its visibility
      // marker even when the source still has a current copy: removing the
      // last marker in that corpus would serve the abandoned rows as legacy.
      this.db.query(`
        UPDATE tier_copies SET copy_state = 'superseded', superseded_by_generation = NULL, updated_at = ?
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND copy_state = 'staged'
      `).run(now, ...idParams(identity));
      this.writeMeta(`tier-move-verified:${tierLedgerIdentityKey(identity)}`, '');
      const state: TierLedgerState = existing.metadataPending || existing.contentPending ? 'pending' : 'current';
      this.db.query(`
        UPDATE tier_items SET state = ?, target_metadata_tier = NULL, target_content_tier = NULL
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND generation = ?
      `).run(state, ...idParams(identity), existing.generation);
      this.appendHistory(
        identity,
        existing.generation,
        existing.metadataTier,
        existing.contentTier,
        'rollback',
        JSON.stringify(existing.reasons),
        state,
        now,
      );
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
  /**
   * A Secret's side stores still hold its names: remember to clear them (see
   * `secretSideStoreDebts`), with the extraction job ledgers that were not
   * cleared, so a retry after a restart still reaches them.
   */
  recordSecretSideStoreDebt(
    identity: TierLedgerIdentity & { localItemId?: string },
    jobLedgerPaths: readonly string[] = [],
    options: { onlyIfOwed?: boolean } = {},
  ): void {
    this.db.transaction(() => {
      const existing = this.db.query(`
        SELECT job_ledger_paths_json FROM secret_side_store_debt
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      `).get(...idParams(identity)) as { job_ledger_paths_json: string } | null;
      // A retry whose debt was cancelled meanwhile (the item left Secrets).
      if (options.onlyIfOwed && !existing) return;
      const paths = [...new Set([...(existing ? JSON.parse(existing.job_ledger_paths_json) as string[] : []), ...jobLedgerPaths])].sort();
      this.db.query(`
        INSERT INTO secret_side_store_debt (provider, account_scope, conversation_key, provider_item_id, local_item_id, job_ledger_paths_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (provider, account_scope, conversation_key, provider_item_id) DO UPDATE SET
          local_item_id = CASE WHEN excluded.local_item_id <> '' THEN excluded.local_item_id ELSE secret_side_store_debt.local_item_id END,
          job_ledger_paths_json = excluded.job_ledger_paths_json,
          recorded_at = excluded.recorded_at
      `).run(...idParams(identity), identity.localItemId ?? '', JSON.stringify(paths), this.now().toISOString());
    })();
  }

  /** Secrets whose side stores are still to be cleared, oldest first. */
  secretSideStoreDebts(limit = 100): Array<TierLedgerIdentity & { localItemId?: string; jobLedgerPaths: string[] }> {
    const rows = this.db.query(`
      SELECT provider, account_scope, conversation_key, provider_item_id, local_item_id, job_ledger_paths_json
      FROM secret_side_store_debt ORDER BY recorded_at LIMIT ?
    `).all(Math.max(1, Math.min(limit, 1_000))) as Array<{
      provider: string;
      account_scope: string;
      conversation_key: string;
      provider_item_id: string;
      local_item_id: string;
      job_ledger_paths_json: string;
    }>;
    return rows.map((row) => ({
      provider: row.provider,
      accountScope: row.account_scope,
      providerItemId: row.provider_item_id,
      ...(row.conversation_key ? { providerConversationId: row.conversation_key } : {}),
      ...(row.local_item_id ? { localItemId: row.local_item_id } : {}),
      jobLedgerPaths: JSON.parse(row.job_ledger_paths_json) as string[],
    }));
  }

  /** Whether a Secret's side-store clearing is still owed. */
  hasSecretSideStoreDebt(identity: TierLedgerIdentity): boolean {
    return this.db.query(`
      SELECT 1 FROM secret_side_store_debt
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).get(...idParams(identity)) !== null;
  }

  /** The extraction job ledgers a Secret is still owed in (empty when it owes none). */
  secretSideStoreDebtJobLedgerPaths(identity: TierLedgerIdentity): string[] {
    const row = this.db.query(`
      SELECT job_ledger_paths_json FROM secret_side_store_debt
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).get(...idParams(identity)) as { job_ledger_paths_json: string } | null;
    return row ? JSON.parse(row.job_ledger_paths_json) as string[] : [];
  }

  /**
   * Settle a Secret's side-store debt, unless it owes a job ledger outside
   * `clearedJobLedgerPaths` (one another process recorded meanwhile).
   */
  clearSecretSideStoreDebt(identity: TierLedgerIdentity, clearedJobLedgerPaths?: readonly string[]): void {
    this.db.transaction(() => {
      if (clearedJobLedgerPaths) {
        const cleared = new Set(clearedJobLedgerPaths);
        if (this.secretSideStoreDebtJobLedgerPaths(identity).some((path) => !cleared.has(path))) return;
      }
      this.db.query(`
        DELETE FROM secret_side_store_debt
        WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
      `).run(...idParams(identity));
    }).immediate();
  }

  /**
   * Items that left Secrets whose extraction redaction markers are still to
   * be retired (recorded by the ledger's own triggers, see the migration),
   * oldest first; or only `identity`'s.
   */
  secretRedactionRetirements(options: { identity?: TierLedgerIdentity; limit?: number } = {}): Array<TierLedgerIdentity & { id: number; jobLedgerPaths: string[] }> {
    const rows = (options.identity
      ? this.db.query(`
          SELECT id, provider, account_scope, conversation_key, provider_item_id, job_ledger_paths_json
          FROM secret_redaction_retirement
          WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
        `).all(...idParams(options.identity))
      : this.db.query(`
          SELECT id, provider, account_scope, conversation_key, provider_item_id, job_ledger_paths_json
          FROM secret_redaction_retirement ORDER BY id LIMIT ?
        `).all(Math.max(1, Math.min(options.limit ?? 100, 1_000)))) as Array<{
      id: number;
      provider: string;
      account_scope: string;
      conversation_key: string;
      provider_item_id: string;
      job_ledger_paths_json: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      accountScope: row.account_scope,
      providerItemId: row.provider_item_id,
      ...(row.conversation_key ? { providerConversationId: row.conversation_key } : {}),
      jobLedgerPaths: JSON.parse(row.job_ledger_paths_json) as string[],
    }));
  }

  /**
   * Forget one retirement, carried out or no longer due. Keyed by its id, so
   * a newer one (the item became Secrets and left again meanwhile) stays.
   */
  settleSecretRedactionRetirement(id: number): void {
    this.db.query('DELETE FROM secret_redaction_retirement WHERE id = ?').run(id);
  }

  /**
   * Whether any item with this provider item id is Secrets here (in any
   * conversation: the extraction job ledger keys an item without one), by
   * its decision, a move toward Secrets, or the owner's override.
   */
  providerItemIsSecret(item: { provider: string; accountScope: string; providerItemId: string }): boolean {
    const keys = [item.provider, item.accountScope, item.providerItemId];
    return this.db.transaction(() => {
      const decided = this.db.query(`
        SELECT 1 FROM tier_items
        WHERE provider = ? AND account_scope = ? AND provider_item_id = ?
          AND 'secrets' IN (metadata_tier, content_tier, COALESCE(target_metadata_tier, ''), COALESCE(target_content_tier, ''))
        LIMIT 1
      `).get(...keys) !== null;
      if (decided) return true;
      const overrides = this.db.query(`
        SELECT override_json FROM tier_overrides WHERE provider = ? AND account_scope = ? AND provider_item_id = ?
      `).all(...keys) as Array<{ override_json: string }>;
      return overrides.some((row) => {
        const override = JSON.parse(row.override_json) as ItemTierOverride;
        return override.kind === 'tier' && override.tier === 'secrets';
      });
    })();
  }

  /**
   * The write an item's legs are about to receive (`TierWriteIntent`). One row per item: a newer write replaces
   * the older one, and the row is cleared only after every leg has been written. `withWriteIntent` records it in
   * the same transaction as the ledger change it belongs to; reads hide an item with a deletion or Secret intent at once.
   */
  withWriteIntent<T>(
    intent: TierWriteIntent,
    run: () => T,
    settle?: (result: T) => Partial<Pick<TierWriteIntent, 'kind' | 'location'>> | undefined,
  ): T {
    return this.db.transaction(() => {
      this.putWriteIntent(intent);
      const result = run();
      const final = settle?.(result);
      if (final) this.putWriteIntent({ ...intent, ...final });
      return result;
    })();
  }

  putWriteIntent(intent: TierWriteIntent): void {
    this.db.query(`
      INSERT OR REPLACE INTO tier_write_intents (
        provider, account_scope, conversation_key, provider_item_id, local_item_id, source_version, kind, location, connector_id, written_at, body_version, item_family
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...idParams(intent.identity), intent.identity.localItemId ?? '', intent.version ?? null, intent.kind,
      intent.location === true ? 1 : 0, intent.connectorId, this.now().toISOString(), intent.bodyVersion ?? null, intent.itemFamily ?? null,
    );
  }

  writeIntent(identity: TierLedgerIdentity): TierWriteIntent | undefined {
    const row = this.db.query(`
      SELECT * FROM tier_write_intents
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).get(...idParams(identity)) as TierWriteIntentRow | null;
    return row ? writeIntentFromRow(row) : undefined;
  }

  /**
   * The tombstone row kept for a deletion of an item no store ever held is marked here, so a newer record routes
   * the item afresh; a tombstone of an item a lane held stays the lane's.
   */
  markUnseenDeletion(identity: TierLedgerIdentity): void {
    this.db.query('INSERT OR IGNORE INTO tier_unseen_deletions (provider, account_scope, conversation_key, provider_item_id) VALUES (?, ?, ?, ?)')
      .run(...idParams(identity));
  }

  isUnseenDeletion(identity: TierLedgerIdentity): boolean {
    return this.db.query('SELECT 1 FROM tier_unseen_deletions WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?')
      .get(...idParams(identity)) !== null;
  }

  /** Every write not yet cleared, oldest first. */
  writeIntents(): TierWriteIntent[] {
    return (this.db.query('SELECT * FROM tier_write_intents ORDER BY written_at, provider_item_id').all() as TierWriteIntentRow[]).map(writeIntentFromRow);
  }

  /** Clear an item's write after every leg has it. Only the intent that was written is cleared: a newer one stays. */
  clearWriteIntent(identity: TierLedgerIdentity, written?: { version?: string; kind: TierWriteIntentKind }): void {
    this.db.query(`
      DELETE FROM tier_write_intents
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
        ${written ? 'AND kind = ? AND COALESCE(source_version, \'\') = ?' : ''}
    `).run(...idParams(identity), ...(written ? [written.kind, written.version ?? ''] : []));
  }

  removeCopies(identity: TierLedgerIdentity): TierCopy[] {
    let removed: TierCopy[] = [];
    this.db.transaction(() => {
      removed = this.copies(identity);
      this.deleteCopies(identity);
    })();
    return removed;
  }

  /**
   * Forget ONE superseded copy row, after the caller tombstoned that store's
   * copy (the owner-approved purge, design section 4.6 M6). A current or
   * staged copy is never removed here. Returns whether a row was removed.
   */
  removeSupersededCopy(identity: TierLedgerIdentity, corpusId: string): boolean {
    return this.db.query(`
      DELETE FROM tier_copies
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
        AND corpus_id = ? AND copy_state = 'superseded'
    `).run(...idParams(identity), corpusId).changes > 0;
  }

  // ---- P3: migration proposals (design section 4.6) ---------------------------

  /**
   * Record a plan's proposals, replacing any earlier rows for the same plan
   * id in one transaction (a re-plan with unchanged data writes the same rows).
   * Proposals are never current: nothing here touches tier_items or copies.
   */
  replaceMigrationProposals(planId: string, proposals: readonly TierMigrationProposalInput[]): void {
    const now = this.now().toISOString();
    this.db.transaction(() => {
      this.db.query('DELETE FROM tier_migration_proposals WHERE plan_id = ?').run(planId);
      const insert = this.db.query(`
        INSERT INTO tier_migration_proposals (
          plan_id, provider, account_scope, conversation_key, provider_item_id, family,
          from_corpus_id, from_trust_domain, kind, metadata_tier, content_tier, decision_json,
          chunks, estimated_chunks_to_embed, estimated_tokens, item_fingerprint, expected_generation, batch_keys_json,
          status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
      `);
      for (const proposal of proposals) {
        assertTier(proposal.metadataTier);
        assertTier(proposal.contentTier);
        insert.run(
          planId,
          ...idParams(proposal.identity),
          proposal.family,
          proposal.fromCorpusId,
          proposal.fromTrustDomain,
          proposal.kind,
          proposal.metadataTier,
          proposal.contentTier,
          JSON.stringify(proposal.decision),
          proposal.chunks,
          proposal.estimatedChunksToEmbed,
          proposal.estimatedTokens,
          proposal.itemFingerprint,
          proposal.expectedGeneration ?? null,
          JSON.stringify(proposal.batchKeys),
          now,
        );
      }
    })();
  }

  /** Remove a plan's proposals (a superseded plan that never ran). */
  deleteMigrationProposals(planId: string): number {
    return this.db.query('DELETE FROM tier_migration_proposals WHERE plan_id = ?').run(planId).changes;
  }

  migrationProposals(
    planId: string,
    filter: { status?: TierMigrationProposalStatus; batchId?: string } = {},
  ): TierMigrationProposal[] {
    const clauses = ['plan_id = ?'];
    const params: string[] = [planId];
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.batchId) {
      clauses.push('batch_id = ?');
      params.push(filter.batchId);
    }
    return (this.db.query(`
      SELECT * FROM tier_migration_proposals WHERE ${clauses.join(' AND ')}
      ORDER BY provider, account_scope, conversation_key, provider_item_id
    `).all(...params) as TierMigrationProposalRow[]).map(proposalFromRow);
  }

  /** Content-free counts of one plan's proposals by status. */
  migrationProposalCounts(planId: string): Record<TierMigrationProposalStatus, number> {
    const counts: Record<TierMigrationProposalStatus, number> = { proposed: 0, moved: 0, rolled_back: 0, skipped: 0, purged: 0 };
    for (const row of this.db.query(`
      SELECT status, COUNT(*) AS n FROM tier_migration_proposals WHERE plan_id = ? GROUP BY status
    `).all(planId) as Array<{ status: TierMigrationProposalStatus; n: number }>) {
      counts[row.status] = row.n;
    }
    return counts;
  }

  markMigrationProposal(
    planId: string,
    identity: TierLedgerIdentity,
    update: {
      status: TierMigrationProposalStatus;
      batchId?: string;
      movedGeneration?: number;
      outcome?: Record<string, unknown>;
    },
  ): void {
    this.db.query(`
      UPDATE tier_migration_proposals SET
        status = ?, batch_id = COALESCE(?, batch_id), moved_generation = COALESCE(?, moved_generation),
        outcome_json = COALESCE(?, outcome_json), updated_at = ?
      WHERE plan_id = ? AND provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).run(
      update.status,
      update.batchId ?? null,
      update.movedGeneration ?? null,
      update.outcome ? JSON.stringify(update.outcome) : null,
      this.now().toISOString(),
      planId,
      ...idParams(identity),
    );
  }

  /**
   * Whether any routed item has a copy (in any state) in this store. False
   * means every row in the store is legacy, so readers can skip the filter.
   */
  corpusHasCopies(corpusId: string): boolean {
    return this.db.query('SELECT 1 FROM tier_copies WHERE corpus_id = ? LIMIT 1').get(corpusId) !== null;
  }

  /**
   * Changes whenever this ledger's database changes, from this connection or
   * another: lets a reader reuse what it derived from the ledger until then.
   */
  changeMarker(ignoreOwnMetaWrites = false): string {
    const row = this.db.query('SELECT total_changes() AS changes').get() as { changes: number };
    const version = this.db.query('PRAGMA data_version').get() as { data_version: number };
    // Background checkpoints cannot invalidate a sliced training validation.
    // External commits still invalidate it; withdrawals are also revision-fenced.
    return `${version.data_version}:${row.changes - (ignoreOwnMetaWrites ? this.metaChanges : 0)}`;
  }

  /**
   * A bounded, transactional change feed for derived visibility. Every writer
   * (including other connections) records the identity in the write's own
   * transaction. A reader that fell behind retention must rebuild; it may
   * never treat a gap as evidence that its old visible set is current.
   */
  visibilityChangesSince(after?: number): { cursor: number; identities?: TierLedgerIdentity[] } {
    return this.db.transaction(() => {
      const bounds = this.db.query('SELECT (SELECT MIN(seq) FROM tier_visibility_changes) AS first, (SELECT MAX(seq) FROM tier_visibility_changes) AS last')
        .get() as { first: number | null; last: number | null };
      const cursor = bounds.last ?? 0;
      if (after === undefined || after > cursor || (bounds.first !== null && after < bounds.first - 1)) return { cursor };
      const rows = this.db.query(`SELECT DISTINCT provider, account_scope, conversation_key, provider_item_id
        FROM tier_visibility_changes WHERE seq > ?`).all(after) as TierIdentityRow[];
      return { cursor, identities: rows.map(identityFromRow) };
    })();
  }

  /** All copy flags in one indexed walk, or just the changed identities. */
  *corpusVisibilityPages(corpusId: string, identities?: readonly TierLedgerIdentity[]): Generator<TierCorpusVisibility[]> {
    const flags = `c.provider, c.account_scope, c.conversation_key, c.provider_item_id,
      c.copy_state <> 'current' OR EXISTS (SELECT 1 FROM tier_write_intents w
        WHERE w.provider = c.provider AND w.account_scope = c.account_scope
          AND w.conversation_key = c.conversation_key AND w.provider_item_id = c.provider_item_id
          AND w.kind IN ('secret', 'deletion')) AS hidden,
      c.copy_state = 'current' AND c.embed_hold = 1 AS held,
      c.copy_state = 'current' AND c.embed_hold = 1 AND c.trust_domain = 'secure_local'
        AND c.layers IN ('content', 'both') AND EXISTS (
          SELECT 1 FROM tier_items t WHERE t.provider = c.provider AND t.account_scope = c.account_scope
            AND t.conversation_key = c.conversation_key AND t.provider_item_id = c.provider_item_id
            AND t.state = 'pending' AND t.content_read = 1 AND (t.metadata_pending = 1 OR t.content_pending = 1)
            AND t.metadata_tier <> 'secrets' AND t.content_tier <> 'secrets'
            AND COALESCE(t.target_metadata_tier, '') <> 'secrets' AND COALESCE(t.target_content_tier, '') <> 'secrets'
        ) AND NOT EXISTS (
          SELECT 1 FROM tier_overrides o WHERE o.provider = c.provider AND o.account_scope = c.account_scope
            AND o.conversation_key = c.conversation_key AND o.provider_item_id = c.provider_item_id
            AND json_extract(o.override_json, '$.kind') = 'tier' AND json_extract(o.override_json, '$.tier') = 'secrets'
        ) AS held_for_judgment,
      c.copy_state = 'current' AND c.layers = 'metadata' AS metadata_layer,
      c.copy_state = 'current' AND c.layers = 'metadata' AND NOT EXISTS (
        SELECT 1 FROM tier_copies other WHERE other.provider = c.provider AND other.account_scope = c.account_scope
          AND other.conversation_key = c.conversation_key AND other.provider_item_id = c.provider_item_id
          AND other.corpus_id <> c.corpus_id AND other.copy_state = 'current' AND other.layers IN ('content', 'both')
      ) AS metadata_unread,
      EXISTS (SELECT 1 FROM tier_items t WHERE t.provider = c.provider AND t.account_scope = c.account_scope
        AND t.conversation_key = c.conversation_key AND t.provider_item_id = c.provider_item_id AND t.state = 'moving') AS moving`;
    const convert = (rows: Array<TierIdentityRow & { hidden: number; held: number; held_for_judgment: number; metadata_layer: number; metadata_unread: number; moving: number }>) =>
      rows.map(row => ({ ...identityFromRow(row), hidden: !!row.hidden, held: !!row.held, heldForJudgment: !!row.held_for_judgment,
        metadataLayer: !!row.metadata_layer, metadataLayerContentUnread: !!row.metadata_unread, moving: !!row.moving }));
    if (identities) {
      for (let offset = 0; offset < identities.length; offset += 200) {
        const batch = identities.slice(offset, offset + 200);
        // Identities drive the primary-key probes; a corpus index must never
        // tempt the planner to walk the held corpus for one changed item.
        const rows = this.db.query(`SELECT ${flags} FROM json_each(?) j CROSS JOIN tier_copies c
          WHERE c.provider = json_extract(j.value, '$[0]') AND c.account_scope = json_extract(j.value, '$[1]')
            AND c.conversation_key = json_extract(j.value, '$[2]') AND c.provider_item_id = json_extract(j.value, '$[3]')
            AND c.corpus_id = ?`)
          .all(JSON.stringify(batch.map(identity => [...idParams(identity)])), corpusId) as Parameters<typeof convert>[0];
        yield convert(rows);
      }
      return;
    }
    const query = this.db.query(`SELECT c.rowid AS row_id, ${flags} FROM tier_copies c
      INDEXED BY tier_copies_visibility_walk WHERE c.corpus_id = ? AND c.rowid > ? ORDER BY c.rowid LIMIT 500`);
    for (let after = 0; ;) {
      const rows = query.all(corpusId, after) as Array<Parameters<typeof convert>[0][number] & { row_id: number }>;
      if (rows.length === 0) return;
      yield convert(rows);
      after = rows.at(-1)!.row_id;
      if (rows.length < 500) return;
    }
  }

  /**
   * Every item with a copy in this store in the given state, with no ceiling:
   * a filter that silently stopped at N items would let the N+1st superseded
   * copy be searched and counted.
   */
  corpusCopyIdentities(
    corpusId: string,
    filter: TierCorpusCopyFilter,
  ): TierLedgerIdentity[] {
    // One read, in key order. It used to page by key 5,000 at a time, which
    // gained nothing (every identity is returned in one array anyway) and,
    // because the corpus index does not hold the key order, re-sorted the
    // corpus's whole match set once per page.
    const rows = this.db.query(`
      SELECT provider, account_scope, conversation_key, provider_item_id FROM tier_copies
      WHERE corpus_id = ? AND ${corpusCopyWhere(filter)}
      ORDER BY provider, account_scope, conversation_key, provider_item_id
    `).all(corpusId) as TierIdentityRow[];
    return rows.map(identityFromRow);
  }

  /**
   * The same identities as corpusCopyIdentities, a page at a time in rowid
   * order with a yield between pages, for a caller that gives the thread back
   * between pages (#858: one read of a 645k staged backlog held the worker for
   * seconds). Not in key order. A copy whose row changes during the walk may be
   * seen as of before or after the change, as with a copy changed after a
   * single read.
   */
  *corpusCopyIdentitiesSteps(
    corpusId: string,
    filter: TierCorpusCopyFilter,
    pageSize = 5_000,
  ): Generator<void, TierLedgerIdentity[]> {
    const query = this.db.query(`
      SELECT rowid AS row_id, embed_hold, provider, account_scope, conversation_key, provider_item_id FROM tier_copies
      WHERE corpus_id = ? AND (embed_hold, rowid) > (?, ?) AND ${corpusCopyWhere(filter)}
      ORDER BY embed_hold, rowid LIMIT ?
    `);
    // Every filter fixes one copy_state, so (embed_hold, rowid) is the order
    // of tier_copies_corpus (corpus_id, copy_state, embed_hold) and each page
    // seeks into that index instead of rescanning and sorting the backlog.
    const out: TierLedgerIdentity[] = [];
    for (let hold = -1, after = 0; ;) {
      const rows = query.all(corpusId, hold, after, pageSize) as Array<TierIdentityRow & { row_id: number; embed_hold: number }>;
      for (const row of rows) out.push(identityFromRow(row));
      if (rows.length < pageSize) return out;
      const last = rows[rows.length - 1]!;
      hold = last.embed_hold;
      after = last.row_id;
      yield;
    }
  }

  /**
   * Content-free per-store counts for status surfaces. Each count reads only
   * the index that answers it: one join of the whole corpus against
   * tier_items was a fifth of Sparta's sampled freezes (2026-11-05). Current,
   * staged and held copies come from tier_copies_corpus alone, because a copy
   * in those states always has its item row (an item is deleted only with its
   * copies, or after an account removal superseded them). Superseded copies
   * can outlive their item during an account removal, so they still check
   * for it; moving items come from tier_items_state.
   */
  corpusCopyCounts(corpusId: string): { current: number; superseded: number; staged: number; held: number; moving: number } {
    const rows = this.db.query(`
      SELECT copy_state, embed_hold, COUNT(*) AS n FROM tier_copies
      WHERE corpus_id = ? AND copy_state IN ('current', 'staged')
      GROUP BY copy_state, embed_hold
    `).all(corpusId) as Array<{ copy_state: string; embed_hold: number; n: number }>;
    let current = 0, staged = 0, held = 0;
    for (const row of rows) {
      if (row.copy_state === 'current') {
        current += row.n;
        if (row.embed_hold === 1) held += row.n;
      } else staged += row.n;
    }
    const superseded = (this.db.query(`
      SELECT COUNT(*) AS n FROM tier_copies c
      WHERE c.corpus_id = ? AND c.copy_state = 'superseded' AND EXISTS (
        SELECT 1 FROM tier_items t
        WHERE t.provider = c.provider AND t.account_scope = c.account_scope
          AND t.conversation_key = c.conversation_key AND t.provider_item_id = c.provider_item_id)
    `).get(corpusId) as { n: number }).n;
    const moving = (this.db.query(`
      SELECT COUNT(*) AS n FROM tier_items t
      JOIN tier_copies c
        ON c.provider = t.provider AND c.account_scope = t.account_scope
          AND c.conversation_key = t.conversation_key AND c.provider_item_id = t.provider_item_id
          AND c.corpus_id = ?
      WHERE t.state = 'moving'
    `).get(corpusId) as { n: number }).n;
    return { current, superseded, staged, held, moving };
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

  /** Forgets a tiered set's resume point for one connector (a removed import). */
  deleteSetCursor(setId: string, connectorId: string): boolean {
    return this.db.query('DELETE FROM tier_set_cursors WHERE set_id = ? AND connector_id = ?')
      .run(setId, connectorId).changes > 0;
  }

  /** How many items one account scope has here, and how many of them still wait for a judgment. */
  accountScopeCounts(provider: string, accountScope: string): { items: number; awaitingJudgment: number } {
    const row = this.db.query(`
      SELECT COUNT(*) AS items,
        COALESCE(SUM(CASE WHEN state = 'pending' OR metadata_pending = 1 OR content_pending = 1 THEN 1 ELSE 0 END), 0) AS awaiting
      FROM tier_items WHERE provider = ? AND account_scope = ?
    `).get(provider, accountScope) as { items: number; awaiting: number };
    return { items: row.items, awaitingJudgment: row.awaiting };
  }

  /**
   * The first step of removing one account scope's items (an imported
   * archive: its id is the account scope). In one transaction, every copy
   * is superseded, so no store serves any of the items from here on, and
   * every decision, override, history row, migration proposal and Secret
   * side-store note is deleted, so no later pass (a move, a re-judge, a
   * migration, a settle) acts on them. The superseded copies stay as the
   * mark that hides the stores' rows until those are purged; then
   * `deleteAccountScopeCopies` removes them. The visibility feed records
   * deletions too, so readers can retire cached copy membership.
   */
  withdrawAccountScope(provider: string, accountScope: string): { items: number; copies: number } {
    return this.db.transaction(() => {
      const now = this.now().toISOString();
      this.writeMeta('embedding-prefilter:training-revision', randomUUID());
      // Partial training contains source-owned references, never retained after withdrawal.
      this.deleteMeta('embedding-prefilter:training-scan-v1');
      for (const kind of ['check:', 'clear:']) {
        const prefix = `embedding-prefilter:${kind}${provider}\0${accountScope}\0`;
        this.db.query('DELETE FROM tier_ledger_meta WHERE key >= ? AND key < ?').run(prefix, `${prefix}\uffff`);
      }
      this.db.query(`
        UPDATE tier_copies
        SET copy_state = 'superseded',
          superseded_by_generation = COALESCE(superseded_by_generation, generation + 1),
          updated_at = ?
        WHERE provider = ? AND account_scope = ? AND copy_state <> 'superseded'
      `).run(now, provider, accountScope);
      const copies = (this.db.query('SELECT changes() AS n').get() as { n: number }).n;
      this.db.query('DELETE FROM tier_items WHERE provider = ? AND account_scope = ?').run(provider, accountScope);
      const items = (this.db.query('SELECT changes() AS n').get() as { n: number }).n;
      for (const table of [
        'tier_history',
        'tier_overrides',
        'tier_migration_proposals',
        'secret_side_store_debt',
        'secret_side_store_scrubs',
        'secret_redaction_retirement',
      ]) {
        this.db.query(`DELETE FROM ${table} WHERE provider = ? AND account_scope = ?`).run(provider, accountScope);
      }
      return { items, copies };
    })();
  }

  /** The last step of removing one account scope: its copy rows, once its stores hold none of its rows. */
  deleteAccountScopeCopies(provider: string, accountScope: string): number {
    this.db.query('DELETE FROM tier_copies WHERE provider = ? AND account_scope = ?').run(provider, accountScope);
    return (this.db.query('SELECT changes() AS n').get() as { n: number }).n;
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
      /** The row's state after the flip (default `current`). */
      state?: TierLedgerState;
    },
  ): void {
    const reasonsJson = JSON.stringify(next.reasons);
    const state = next.state ?? 'current';
    this.db.query(`
      UPDATE tier_items SET
        metadata_tier = ?, content_tier = ?, generation = ?, decided_by = ?, reasons_json = ?,
        previous_metadata_tier = ?, previous_content_tier = ?, state = ?,
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
      state,
      next.decidedAt,
      ...idParams(identity),
    );
    this.appendHistory(identity, next.generation, next.metadataTier, next.contentTier, next.decidedBy, reasonsJson, state, next.decidedAt);
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

export type TierMigrationProposalStatus = 'proposed' | 'moved' | 'rolled_back' | 'skipped' | 'purged';

/** One item's PROPOSED tiers in a migration plan. Content-free: identities, tiers, codes, hashes, counts. */
export interface TierMigrationProposalInput {
  identity: TierLedgerIdentity;
  family: string;
  /** The store that serves the item today. */
  fromCorpusId: string;
  fromTrustDomain: SourceTrustDomain;
  /** `legacy`: stored before routing. `queued_move`: a routed item a sync queued to move. */
  kind: 'legacy' | 'queued_move';
  metadataTier: TierKey;
  contentTier: TierKey;
  /** The classifier's decision (tiers, reason codes, flags, versions). */
  decision: TierDecision;
  /** Chunks the item holds today. */
  chunks: number;
  /** Chunks a destination store would embed with its own model (estimate: vectors that can be copied are not counted). */
  estimatedChunksToEmbed: number;
  /** Tokens of those chunks (estimate: characters / 4). */
  estimatedTokens: number;
  /** Hash of the stored content the decision was made from; a change makes the plan stale. */
  itemFingerprint: string;
  /** For a queued move: the ledger generation it was planned against. */
  expectedGeneration?: number;
  /** Hashed batch selectors (source, folder prefixes, labels, sender, chat). */
  batchKeys: readonly string[];
}

export interface TierMigrationProposal extends TierMigrationProposalInput {
  planId: string;
  status: TierMigrationProposalStatus;
  batchId: string | null;
  movedGeneration: number | null;
  outcome: Record<string, unknown> | null;
  updatedAt: string;
}

interface TierMigrationProposalRow {
  plan_id: string;
  provider: string;
  account_scope: string;
  conversation_key: string;
  provider_item_id: string;
  family: string;
  from_corpus_id: string;
  from_trust_domain: SourceTrustDomain;
  kind: 'legacy' | 'queued_move';
  metadata_tier: TierKey;
  content_tier: TierKey;
  decision_json: string;
  chunks: number;
  estimated_chunks_to_embed: number;
  estimated_tokens: number;
  item_fingerprint: string;
  expected_generation: number | null;
  batch_keys_json: string;
  status: TierMigrationProposalStatus;
  batch_id: string | null;
  moved_generation: number | null;
  outcome_json: string | null;
  updated_at: string;
}

/** SQLITE_BUSY (5) and SQLITE_LOCKED (6), as bun:sqlite reports them. */
function isSqliteBusy(error: unknown): boolean {
  const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || errno === 5 || errno === 6;
}

/**
 * Whether committed writes sit outside the main file: a -wal that holds
 * frames, or a -journal waiting to be rolled back. Opening such a file
 * read-write and closing it would merge them into the main file.
 */
function hasUnmergedWrites(dbPath: string): boolean {
  try {
    if (statSync(`${dbPath}-wal`).size > 0) return true;
  } catch {
    // No -wal.
  }
  return existsSync(`${dbPath}-journal`);
}

function proposalFromRow(row: TierMigrationProposalRow): TierMigrationProposal {
  return {
    planId: row.plan_id,
    identity: identityFromRow(row),
    family: row.family,
    fromCorpusId: row.from_corpus_id,
    fromTrustDomain: row.from_trust_domain,
    kind: row.kind,
    metadataTier: row.metadata_tier,
    contentTier: row.content_tier,
    decision: JSON.parse(row.decision_json) as TierDecision,
    chunks: row.chunks,
    estimatedChunksToEmbed: row.estimated_chunks_to_embed,
    estimatedTokens: row.estimated_tokens,
    itemFingerprint: row.item_fingerprint,
    ...(row.expected_generation !== null ? { expectedGeneration: row.expected_generation } : {}),
    batchKeys: JSON.parse(row.batch_keys_json) as string[],
    status: row.status,
    batchId: row.batch_id,
    movedGeneration: row.moved_generation,
    outcome: row.outcome_json ? JSON.parse(row.outcome_json) as Record<string, unknown> : null,
    updatedAt: row.updated_at,
  };
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
  rejudged_key: string | null;
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

export interface TierCorpusVisibility extends TierLedgerIdentity {
  hidden: boolean;
  held: boolean;
  /** A read content copy held solely for a pending per-item judgment; visibility is still held. */
  heldForJudgment: boolean;
  metadataLayer: boolean;
  metadataLayerContentUnread: boolean;
  moving: boolean;
}

export type TierCorpusCopyFilter = 'superseded' | 'staged' | 'held' | 'metadata_layer' | 'metadata_layer_content_unread' | 'metadata_layer_settled_unreadable'
  | 'metadata_layer_settled_unreadable_not_secret';

/** The tier_copies condition for one corpus-copy filter (corpusCopyIdentities and its paged form). */
function corpusCopyWhere(filter: TierCorpusCopyFilter): string {
  // `metadata_layer_content_unread`: a names copy here whose text no current
  // copy anywhere holds yet. That item is still waiting to be read (the
  // extraction view's candidate rule), not kept as names only.
  const where = filter === 'held'
    ? `copy_state = 'current' AND embed_hold = 1`
    : filter === 'metadata_layer'
      ? `copy_state = 'current' AND layers = 'metadata'`
      : filter === 'metadata_layer_settled_unreadable' || filter === 'metadata_layer_settled_unreadable_not_secret'
        ? `copy_state = 'current' AND layers = 'metadata'${filter === 'metadata_layer_settled_unreadable_not_secret' ? `
          AND NOT EXISTS (SELECT 1 FROM tier_overrides o
            WHERE o.provider = tier_copies.provider AND o.account_scope = tier_copies.account_scope
              AND o.conversation_key = tier_copies.conversation_key AND o.provider_item_id = tier_copies.provider_item_id
              AND json_extract(o.override_json, '$.kind') = 'tier' AND json_extract(o.override_json, '$.tier') = 'secrets')` : ''}
          AND EXISTS (SELECT 1 FROM tier_items t
            WHERE t.provider = tier_copies.provider AND t.account_scope = tier_copies.account_scope
              AND t.conversation_key = tier_copies.conversation_key AND t.provider_item_id = tier_copies.provider_item_id
              AND t.state = 'current' AND t.content_read = 0
              AND t.metadata_tier <> 'secrets' AND t.content_tier <> 'secrets'
              AND EXISTS (SELECT 1 FROM json_each(t.reasons_json) r
                WHERE r.value GLOB 'content:sniffer:*:fail_safe:missing_question'
                  OR r.value GLOB 'content:sniffer:*:fail_safe:unread'))
          AND NOT EXISTS (SELECT 1 FROM tier_copies other
            WHERE other.provider = tier_copies.provider AND other.account_scope = tier_copies.account_scope
              AND other.conversation_key = tier_copies.conversation_key AND other.provider_item_id = tier_copies.provider_item_id
              AND other.copy_state = 'current' AND other.layers IN ('content', 'both'))`
      : filter === 'metadata_layer_content_unread'
        ? `copy_state = 'current' AND layers = 'metadata'
          AND NOT EXISTS (
            SELECT 1 FROM tier_copies other
            WHERE other.provider = tier_copies.provider AND other.account_scope = tier_copies.account_scope
              AND other.conversation_key = tier_copies.conversation_key
              AND other.provider_item_id = tier_copies.provider_item_id
              AND other.corpus_id <> tier_copies.corpus_id
              AND other.copy_state = 'current' AND other.layers IN ('content', 'both')
          )`
        : `copy_state = '${filter === 'superseded' ? 'superseded' : 'staged'}'`;
  return where;
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

function rejudgeKey(engineVersion: string, snifferId: string | undefined): string {
  return `${engineVersion}\u0000${snifferId ?? ''}`;
}

/** When an unavailable-text marker for this key and the row's decision lets it be read again ('' when none applies). */
function rejudgeUnavailableUntil(row: Pick<TierItemRow, 'rejudged_key' | 'generation' | 'decided_at'>, key: string): string {
  const mark = splitRejudgeStamp(row.rejudged_key).unavailable?.split('\u0001');
  return mark && mark[0] === key && mark[1] === String(row.generation) && mark[2] === row.decided_at ? mark[3] ?? '' : '';
}

/** A rejudged_key's settlement stamp, and the unavailable-text marker after char(1) if any (markRejudgeUnavailable). */
function splitRejudgeStamp(value: string | null): { settled?: string; unavailable?: string } {
  if (!value) return {};
  const at = value.indexOf('\u0001');
  if (at < 0) return { settled: value };
  return { ...(at > 0 ? { settled: value.slice(0, at) } : {}), unavailable: value.slice(at + 1) };
}

function identityOfRow(row: Pick<TierItemRow, 'provider' | 'account_scope' | 'conversation_key' | 'provider_item_id'>): TierLedgerIdentity {
  return {
    provider: row.provider,
    accountScope: row.account_scope,
    providerItemId: row.provider_item_id,
    ...(row.conversation_key ? { providerConversationId: row.conversation_key } : {}),
  };
}

/** A row's re-judge question, only while it is still open on the row exactly as it was asked. */
function openRejudgeQuestionOf(row: TierItemRow & { rejudge_json?: string | null }): TierRejudgeQuestion | undefined {
  if (!row.rejudge_json || row.state !== 'current' || row.decided_by === 'override') return undefined;
  let stored: StoredRejudgeQuestion;
  try {
    stored = JSON.parse(row.rejudge_json) as StoredRejudgeQuestion;
  } catch {
    return undefined;
  }
  if (stored.generation !== row.generation || stored.decidedAt !== row.decided_at
    || stored.reasonsJson !== row.reasons_json || stored.decidedBy !== row.decided_by || !stored.decision) return undefined;
  return { decision: stored.decision, keepVisible: stored.keepVisible === true };
}

/** The ordered identity fields shared by ledger keys and persisted re-check identities. */
export const TIER_LEDGER_IDENTITY_FIELDS = ['provider', 'accountScope', 'providerConversationId', 'providerItemId'] as const satisfies readonly (keyof TierLedgerIdentity)[];

/** Stable map key for an item identity in ledger lookups. */
export function tierLedgerIdentityKey(identity: TierLedgerIdentity): string {
  return TIER_LEDGER_IDENTITY_FIELDS.map(field => identity[field] ?? '').join('\u0000');
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

function ownerPriorOf(json: string): OwnerPriorDecision | undefined {
  try {
    const value = JSON.parse(json) as Partial<Record<keyof OwnerPriorDecision, unknown>>;
    const flags = ['contentRead', 'metadataPending', 'contentPending', 'metadataForced', 'metadataFlagged'] as const;
    if (typeof value.decidedBy !== 'string' || typeof value.engineVersion !== 'string' || typeof value.mapRevision !== 'string'
      || !Array.isArray(value.reasons) || !value.reasons.every((reason) => typeof reason === 'string')
      || flags.some((flag) => typeof value[flag] !== 'boolean')) {
      return undefined;
    }
    return value as OwnerPriorDecision;
  } catch {
    return undefined;
  }
}

/** Whether a per-item override still asks for these tiers (Public lifts to Personal on an install without Public). */
function overrideAuthorizes(override: ItemTierOverride | undefined, metadataTier: TierKey, contentTier: TierKey): boolean {
  if (override?.kind !== 'tier') return false;
  const allowed = (tier: TierKey) => tier === override.tier || (override.tier === 'public' && tier === 'private');
  return allowed(metadataTier) && allowed(contentTier);
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

/** What applying a sniffer verdict did: a P1a row update, a P1b routed outcome, or nothing yet. */
/** The rule that made a row a re-judge candidate (`rejudgeCandidatePage`). */
export type TierRejudgeCause = 'held' | 'retired_prior' | 'missing_question' | 'classifier' | 'owner_words' | 'judge_model' | 'names_prompt' | 'content_prompt';

/** The ID format emitted by snifferId/snifferPromptVersions, not arbitrary custom sniffer IDs. */
function snifferInputs(id: string | undefined): { lane: string; owner: string; model: string } | undefined {
  const match = id?.match(/^([^:]+):p-[a-f0-9]{12}(\.o[a-f0-9]{8})?\.m([a-f0-9]{16})$/);
  return match ? { lane: match[1]!, owner: match[2] ?? '', model: match[3]! } : undefined;
}

/** Refine only prompt candidates, within the same bounded scan and before spending its candidate budget. */
function settledSnifferRejudgeCause(row: TierItemRow, cause: TierRejudgeCause, id: string | undefined): TierRejudgeCause | 'builtin_prompt_skipped' {
  if (cause !== 'names_prompt' && cause !== 'content_prompt') return cause;
  const current = snifferInputs(id);
  if (!current) return cause;
  const reasons = JSON.parse(row.reasons_json) as string[];
  const previous: Array<string | undefined> = [];
  const stamp = splitRejudgeStamp(row.rejudged_key).settled?.split('\u0000');
  // Match the existing stamp semantics: a completed re-read, or a model
  // settlement still free of fail-safe reasons, can cover older names too.
  if (stamp?.[0] === row.engine_version && (stamp.length === 2
    || (stamp.length === 3 && stamp[2] === 'judged' && !reasons.some(reason => reason.includes(':fail_safe:'))))) {
    previous.push(stamp[1]);
  } else {
    const addMismatch = (prefix: string, required: boolean, exact = false) => {
      const found = reasons.filter(reason => reason.startsWith(prefix));
      if (!required || found.some(reason => exact ? reason === `${prefix}${id}` : reason.startsWith(`${prefix}${id}:`))) return;
      if (!found.length) previous.push(undefined); // Never judged: still owed a verdict.
      for (const reason of found) {
        const rest = reason.slice(prefix.length);
        // Lane and prompt/model identity end before the verdict's reason code.
        previous.push(rest.match(/^([^:]+:p-[a-f0-9]{12}(?:\.o[a-f0-9]{8})?\.m[a-f0-9]{16})(?::|$)/)?.[1]);
      }
    };
    addMismatch('metadata:sniffer:', reasons.some(reason => reason.startsWith('metadata:sniffer:')));
    if (row.decided_by === 'content_rule') addMismatch('content:rule_sniffer:', true, true);
    else addMismatch('content:sniffer:', !reasons.some(reason => reason.startsWith('metadata:sensitivity_map:'))
      && (row.content_tier === 'public' || row.content_tier === 'private' || reasons.some(reason => reason.startsWith('content:sniffer:'))));
  }
  const inputs = previous.map(snifferInputs);
  if (inputs.some(input => input && input.owner !== current.owner)) return 'owner_words';
  if (inputs.some(input => input && (input.lane !== current.lane || input.model !== current.model))) return 'judge_model';
  // Missing/legacy identities retain their original cause and eligibility.
  if (!inputs.length || inputs.some(input => !input)) return cause;
  return 'builtin_prompt_skipped';
}

export type SnifferVerdictOutcome = 'held_lowering' | 'stale_question' | TierLedgerRecordOutcome | TierRoutedOutcome | 'needs_placement' | 'stale_map';

/** Source-neutral rollout switch; first judgments and raises still settle. */
export function holdSnifferLowering(
  current: Pick<TierLedgerRecord, 'metadataTier' | 'contentTier' | 'state'>,
  next: Pick<TierDecision, 'metadataTier' | 'contentTier'>,
): boolean {
  return process.env.OLYMPUS_TIER_SNIFFER_HOLD_LOWERING === '1'
    && current.state === 'current' && current.contentTier === 'secure' && next.contentTier !== 'secrets'
    && (next.contentTier === 'private' || (current.metadataTier === 'secure' && next.metadataTier === 'private'));
}

/** A settled row as the classifier decision the P1b router takes. */
function decisionOfRow(row: EffectiveRow): TierDecision {
  const pending = row.metadataPending || row.contentPending;
  return {
    metadataTier: row.metadataTier,
    contentTier: row.contentTier,
    decidedBy: row.decidedBy as TierDecidedBy,
    reasons: row.reasons,
    state: pending ? 'pending' : 'current',
    contentRead: row.contentRead,
    metadataPending: row.metadataPending,
    contentPending: row.contentPending,
    metadataForced: row.metadataForced,
    metadataFlagged: row.metadataFlagged,
    engineVersion: row.engineVersion,
    mapRevision: row.mapRevision,
    snifferId: 'sniffer',
  };
}

function rowOf(record: TierLedgerRecord): EffectiveRow {
  return {
    metadataTier: record.metadataTier,
    contentTier: record.contentTier,
    decidedBy: record.decidedBy,
    reasons: record.reasons,
    engineVersion: record.engineVersion,
    mapRevision: record.mapRevision,
    contentRead: record.contentRead,
    metadataPending: record.metadataPending,
    contentPending: record.contentPending,
    metadataForced: record.metadataForced,
    metadataFlagged: record.metadataFlagged,
  };
}

/**
 * An embedding hold belongs only to an item with an open question (state
 * pending, or a pending flag): placementFor holds a copy for nothing else.
 * Before completeMove applied the placement's hold, a move flip kept the hold
 * an earlier pending decision had put on a re-layered source copy, so a
 * decided item stayed held, unembedded and counted as "awaiting privacy
 * classification" with nothing left to decide it. This settles such copies at
 * open: idempotent, and it touches only decided items' current copies (the
 * hold is cleared where the decision already placed the copy).
 */
function settleStaleEmbedHolds(db: Database, now: string): number {
  db.query(`
    UPDATE tier_copies SET embed_hold = 0, updated_at = ?
    WHERE embed_hold = 1 AND copy_state = 'current'
      AND EXISTS (
        SELECT 1 FROM tier_items t
        WHERE t.provider = tier_copies.provider AND t.account_scope = tier_copies.account_scope
          AND t.conversation_key = tier_copies.conversation_key AND t.provider_item_id = tier_copies.provider_item_id
          AND t.state = 'current' AND t.metadata_pending = 0 AND t.content_pending = 0
      )
  `).run(now);
  return (db.query('SELECT changes() AS n').get() as { n: number }).n;
}

/** One chat (`conversationKey`) or one source (`provider`, optionally one account) the owner asked to re-check. */
export interface TierRecheckScope {
  provider?: string;
  accountScope?: string;
  conversationKey?: string;
}

export interface TierRecheckRequest {
  key: string;
  scope: TierRecheckScope;
  after?: TierLedgerIdentity;
}

const TIER_RECHECK_META_PREFIX = 'recheck:';

function recheckRequestKey(scope: TierRecheckScope): string {
  return `${TIER_RECHECK_META_PREFIX}${JSON.stringify([scope.provider ?? null, scope.accountScope ?? null, scope.conversationKey ?? null])}`;
}

/** The reasons that say a question is still open: the flags, the borderline families and `sniffer:<id>:undecided`. */
/** Names a re-judge judged from the stored names alone and raised: a later re-judge may lower them (tier-rejudge.ts). */
export const STORED_NAMES_REASON = 'metadata:names_from_store';
/** The same question still open: its answer is marked only if it raises the names it was asked about. */
export const STORED_NAMES_ASKED_REASON = 'metadata:names_from_store:asked';

/** Settles an open stored-names question's mark once its answer is in (Codex on #635: queued answers lost it). */
function settleStoredNamesMark(reasons: readonly string[], askedTier: TierKey, answeredTier: TierKey): string[] {
  if (!reasons.includes(STORED_NAMES_ASKED_REASON)) return [...reasons];
  const rest = reasons.filter((reason) => reason !== STORED_NAMES_ASKED_REASON);
  return answeredTier !== askedTier ? [...rest, STORED_NAMES_REASON] : rest;
}

function contentVerdictReceipts(reasons: readonly string[], reason: string, tier: TierKey): string[] {
  const digests = reasons.filter(value => /^content:sha256:[0-9a-f]{64}$/.test(value));
  return digests.length === 1 ? [contentJudgeVerdictReason(reason, tier, digests[0]!)] : [];
}

function isOpenSnifferReason(reason: string, pass: 'metadata' | 'content'): boolean {
  if (pass === 'metadata') {
    return reason.startsWith('metadata:possibly_private:')
      || (reason.startsWith('metadata:sniffer:') && reason.endsWith(':undecided'));
  }
  return reason.startsWith('content:sniffer:') && reason.endsWith(':undecided');
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

function decisionFlags(
  decision: Pick<TierDecision, 'contentRead' | 'metadataPending' | 'contentPending' | 'metadataForced' | 'metadataFlagged'>,
): [number, number, number, number, number] {
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
      version: 2,
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
    {
      // P3: the migration's PROPOSED tiers (design section 4.6, M0). A
      // proposal never changes an item's current tiers or its copies; only an
      // approved run (tier-migration.ts) acts on it. Additive only.
      version: 3,
      name: 'tier_migration_proposals',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS tier_migration_proposals (
            plan_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            conversation_key TEXT NOT NULL DEFAULT '',
            provider_item_id TEXT NOT NULL,
            family TEXT NOT NULL,
            from_corpus_id TEXT NOT NULL,
            from_trust_domain TEXT NOT NULL CHECK (from_trust_domain IN ('public_safe', 'internal', 'secure_local')),
            kind TEXT NOT NULL CHECK (kind IN ('legacy', 'queued_move')),
            metadata_tier TEXT NOT NULL CHECK (metadata_tier ${TIER_CHECK}),
            content_tier TEXT NOT NULL CHECK (content_tier ${TIER_CHECK}),
            decision_json TEXT NOT NULL,
            chunks INTEGER NOT NULL DEFAULT 0,
            estimated_chunks_to_embed INTEGER NOT NULL DEFAULT 0,
            estimated_tokens INTEGER NOT NULL DEFAULT 0,
            item_fingerprint TEXT NOT NULL,
            expected_generation INTEGER,
            batch_keys_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('proposed', 'moved', 'rolled_back', 'skipped', 'purged')),
            batch_id TEXT,
            moved_generation INTEGER,
            outcome_json TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (plan_id, provider, account_scope, conversation_key, provider_item_id)
          );
          CREATE INDEX IF NOT EXISTS tier_migration_proposals_status
            ON tier_migration_proposals (plan_id, status, batch_id);
        `);
      },
    },
    {
      // Background re-judging and automatic moves (review fixes 2026-10-02).
      // Additive only: every existing row reads as "never re-judged, no
      // open re-judge question, no failed move attempt".
      // - move_attempts: failed attempts of the row's queued move, so a move
      //   that keeps failing goes to the back of the queue (listMoving).
      // - rejudged_key: the classifier and sniffer a re-judge last settled the
      //   row under, so a row the re-judge left as it was is not re-read on
      //   every tick (rejudgeCandidatePage).
      // - rejudge_json: an open re-judge question. The item stays exactly
      //   where it is (it was visible under its previous decision) until the
      //   sniffer answers; the decision the answer completes is kept here.
      version: 4,
      name: 'tier_rejudge_and_move_attempts',
      up(db) {
        db.exec(`
          ALTER TABLE tier_items ADD COLUMN move_attempts INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE tier_items ADD COLUMN rejudged_key TEXT;
          ALTER TABLE tier_items ADD COLUMN rejudge_json TEXT;
        `);
      },
    },
    {
      // owner_prior_json: the decision an owner override took the row over
      // from (decider, reasons, classifier versions, open questions), saved
      // when the override queues a move. A move the owner then revokes is
      // cancelled or replanned under it (`settleRevokedOwnerMove`), so an
      // item that was waiting for its text keeps waiting for it.
      version: 5,
      name: 'tier_owner_prior_decision',
      up(db) {
        db.exec('ALTER TABLE tier_items ADD COLUMN owner_prior_json TEXT;');
      },
    },
    {
      // Secrets whose side stores (sniffer questions, extraction job names)
      // could not be cleared when they became Secrets: retried every tier
      // tick until they are, whether or not the item is listed again.
      version: 6,
      name: 'secret_side_store_debt',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS secret_side_store_debt (
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            conversation_key TEXT NOT NULL DEFAULT '',
            provider_item_id TEXT NOT NULL,
            local_item_id TEXT NOT NULL DEFAULT '',
            job_ledger_paths_json TEXT NOT NULL DEFAULT '[]',
            recorded_at TEXT NOT NULL,
            PRIMARY KEY (provider, account_scope, conversation_key, provider_item_id)
          );
        `);
      },
    },
    {
      // Bumped before every side-store clearing of a Secret, so a
      // classification pass can tell one happened since it read the item.
      version: 7,
      name: 'secret_side_store_scrubs',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS secret_side_store_scrubs (
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            conversation_key TEXT NOT NULL DEFAULT '',
            provider_item_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            PRIMARY KEY (provider, account_scope, conversation_key, provider_item_id)
          );
        `);
      },
    },
    {
      // The extraction job ledgers the worker has open, noted each tier tick,
      // so another process (the tier set command) clears them too; and which
      // generation of a Secrets item last had its side stores cleared, so
      // every tick finds a Secret whose clearing never finished (whatever
      // made it Secrets, debt written down or not).
      version: 8,
      name: 'secret_side_stores_settled',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS known_job_ledgers (
            path TEXT PRIMARY KEY,
            seen_at TEXT NOT NULL
          );
          ALTER TABLE secret_side_store_scrubs ADD COLUMN cleared_generation INTEGER;
          ALTER TABLE secret_side_store_scrubs ADD COLUMN cleared_revision INTEGER;
          CREATE INDEX IF NOT EXISTS tier_items_secrets
            ON tier_items (provider, account_scope, conversation_key, provider_item_id)
            WHERE metadata_tier = 'secrets' OR content_tier = 'secrets';
        `);
      },
    },
    {
      // An item that leaves Secrets: its extraction jobs' redaction markers
      // are retired (secrets-disposition.ts `retireSecretRedactions`), and
      // any side-store clearing still owed for it is cancelled, so the retry
      // never writes a marker back. Triggers, so every write that changes an
      // item's tiers (a listing, an override, a move landing, a legacy
      // decision, another process) is caught in its own transaction. Becoming
      // Secrets again cancels a retirement not yet carried out.
      version: 9,
      name: 'secret_redaction_retirement',
      up(db) {
        const item = `provider = NEW.provider AND account_scope = NEW.account_scope
          AND conversation_key = NEW.conversation_key AND provider_item_id = NEW.provider_item_id`;
        const secretsIn = (row: 'OLD' | 'NEW') => `'secrets' IN (${row}.metadata_tier, ${row}.content_tier,
          COALESCE(${row}.target_metadata_tier, ''), COALESCE(${row}.target_content_tier, ''))`;
        db.exec(`
          CREATE TABLE IF NOT EXISTS secret_redaction_retirement (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            conversation_key TEXT NOT NULL DEFAULT '',
            provider_item_id TEXT NOT NULL,
            job_ledger_paths_json TEXT NOT NULL DEFAULT '[]',
            recorded_at TEXT NOT NULL,
            UNIQUE (provider, account_scope, conversation_key, provider_item_id)
          );
          CREATE TRIGGER IF NOT EXISTS tier_items_left_secrets
          AFTER UPDATE OF metadata_tier, content_tier, target_metadata_tier, target_content_tier ON tier_items
          WHEN ${secretsIn('OLD')} AND NOT ${secretsIn('NEW')}
          BEGIN
            INSERT OR REPLACE INTO secret_redaction_retirement (
              provider, account_scope, conversation_key, provider_item_id, job_ledger_paths_json, recorded_at
            ) VALUES (
              NEW.provider, NEW.account_scope, NEW.conversation_key, NEW.provider_item_id,
              COALESCE((SELECT job_ledger_paths_json FROM secret_side_store_debt WHERE ${item}), '[]'),
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            );
            DELETE FROM secret_side_store_debt WHERE ${item};
          END;
          CREATE TRIGGER IF NOT EXISTS tier_items_entered_secrets
          AFTER UPDATE OF metadata_tier, content_tier, target_metadata_tier, target_content_tier ON tier_items
          WHEN ${secretsIn('NEW')}
          BEGIN
            DELETE FROM secret_redaction_retirement WHERE ${item};
          END;
          CREATE TRIGGER IF NOT EXISTS tier_items_inserted_secrets
          AFTER INSERT ON tier_items
          WHEN ${secretsIn('NEW')}
          BEGIN
            DELETE FROM secret_redaction_retirement WHERE ${item};
          END;
        `);
      },
    },
    {
      // The write an item's legs are about to receive, kept until every leg has it: a crash between the legs
      // leaves this row, and the next pass finishes the write from it before anything else reads the item.
      version: 10,
      name: 'tier_write_intents',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS tier_write_intents (
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            conversation_key TEXT NOT NULL DEFAULT '',
            provider_item_id TEXT NOT NULL,
            local_item_id TEXT NOT NULL DEFAULT '',
            source_version TEXT,
            kind TEXT NOT NULL CHECK (kind IN ('content', 'names', 'advance', 'deletion', 'secret')),
            location INTEGER NOT NULL DEFAULT 0,
            connector_id TEXT NOT NULL DEFAULT '',
            written_at TEXT NOT NULL,
            body_version TEXT,
            item_family TEXT,
            PRIMARY KEY (provider, account_scope, conversation_key, provider_item_id)
          );
          CREATE TABLE IF NOT EXISTS tier_unseen_deletions (
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            conversation_key TEXT NOT NULL DEFAULT '',
            provider_item_id TEXT NOT NULL,
            PRIMARY KEY (provider, account_scope, conversation_key, provider_item_id)
          );
        `);
      },
    },
    {
      version: 11,
      name: 'incremental_copy_visibility',
      up(db) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS tier_items_move_order ON tier_items
            (move_attempts, decided_at, provider, account_scope, provider_item_id, conversation_key)
            WHERE state = 'moving';
          CREATE INDEX IF NOT EXISTS tier_copies_visibility_walk ON tier_copies (corpus_id);
          CREATE TABLE IF NOT EXISTS tier_visibility_changes (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL, account_scope TEXT NOT NULL,
            conversation_key TEXT NOT NULL, provider_item_id TEXT NOT NULL
          );
        `);
        const note = (row: 'NEW' | 'OLD') => `
          INSERT INTO tier_visibility_changes (provider, account_scope, conversation_key, provider_item_id)
          VALUES (${row}.provider, ${row}.account_scope, ${row}.conversation_key, ${row}.provider_item_id);
          DELETE FROM tier_visibility_changes WHERE seq <= (SELECT MAX(seq) - 8192 FROM tier_visibility_changes);`;
        for (const table of ['tier_copies', 'tier_items', 'tier_write_intents']) {
          // State changes affect moving counts; reasons, verdict history, queue
          // cursors and other metadata cannot invalidate copy visibility.
          const columns = table === 'tier_copies' ? 'copy_state, embed_hold, layers, corpus_id'
            : table === 'tier_items' ? 'state' : 'kind';
          db.exec(`
            CREATE TRIGGER IF NOT EXISTS ${table}_visibility_insert AFTER INSERT ON ${table} BEGIN ${note('NEW')} END;
            CREATE TRIGGER IF NOT EXISTS ${table}_visibility_delete AFTER DELETE ON ${table} BEGIN ${note('OLD')} END;
            CREATE TRIGGER IF NOT EXISTS ${table}_visibility_update AFTER UPDATE OF ${columns}, provider, account_scope, conversation_key, provider_item_id ON ${table}
              BEGIN ${note('OLD')} ${note('NEW')} END;
          `);
        }
      },
    },
    {
      version: TIER_LEDGER_SCHEMA_VERSION,
      name: 'pending_move_metadata',
      up(db) {
        // Completed obligations remain recorded as empty acknowledgements.
        // Never rescan that growing history to find the few pending notes.
        db.exec(`CREATE INDEX IF NOT EXISTS tier_ledger_pending_meta ON tier_ledger_meta (key) WHERE value <> '';`);
      },
    },
  ];
}

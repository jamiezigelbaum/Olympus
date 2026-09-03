// The shared connector ingest spine: ONE generic local store that turns any
// Contract 1 SourceConnector into a searchable, analyst-served corpus with
// zero new storage code.
//
// This module is deliberately capability-shaped (docs/CONTRACTS.md): it knows
// nothing about Dropbox, Gmail, or any other source. It consumes the frozen
// SourceConnector surface (authenticate / listItems / fetchItem / classify)
// and the normalized RawItem metadata conventions the connectors already emit
// (name/title, locatorUri/pathDisplay/url, deleted, contentHash, authored /
// modified timestamps, sender identity, reactions). Adding a new source means
// writing a thin connector — never another local index.
//
// Trust posture:
// - ONE database per corpus, and trust domains are NEVER mixed in one store.
//   A first observation classified into a different domain is rejected; a row
//   this store previously accepted is tombstoned immediately when its current
//   classification moves domains. Either way it cannot remain readable here.
// - The storage profile is built and asserted via the shared policy builder:
//   secure_local stores must be local_private / sqlite / fts5.
// - The routed search lane is a membrane: hits carry identity + provenance
//   with a citation title only — no chunk text, no snippet, and no generic
//   locator column copy. An optional declared projector may lazily read and
//   map a final eligible hit after retrieval; that read rechecks current-row
//   identity, tombstone state, and the request's locator-path scope. Otherwise
//   locators remain in the local content-provider lane and reach Castor only
//   via the gated answer.

import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import type {
  LocalContentBlock,
  LocalContentProvider,
  LocalContentRequest,
} from '../../core/evidence-pack.ts';
import { OperationError } from '../../core/operation-error.ts';
import {
  assertSqliteSchemaCanOpen,
  currentStoreMigrations,
  readSqliteSchemaVersion,
  runSqliteMigrations,
} from '../../core/sqlite-migrations.ts';
import type { SensitivityMap } from '../../core/sensitivity-map.ts';
import { classifyItemTier, type ClassifyItemTierInput } from '../classification/engine.ts';
import {
  createSourceExclusionMatcherFromPrefixes,
  sourceExclusionOutcomeIsUnevaluable,
  type SourceExclusionDecision,
  type SourceExclusionMatcher,
  type SourceIngestionRuleMode,
} from '../../core/source-ingestion-exclusions.ts';
import {
  SOURCE_INDEX_FTS5_TOKENIZER,
  runBoundedFtsTokenizerMigration,
  sourceIndexFtsGroupQuery,
  sourceIndexFtsQuery,
  sourceIndexFtsTermGroups,
  type SourceIndexFtsMigrationSpec,
} from '../../core/source-index/fts.ts';
import {
  fuseRankedCandidateLanes,
  reciprocalRank,
  type FusedRankedCandidate,
} from '../../core/source-index/retrieval.ts';
import {
  normalizeSourceReactions,
  parseStoredSourceReactions,
  renderSourceReactionLine,
  serializeSourceReactions,
  type SourceReaction,
} from '../../core/source-index/reactions.ts';
import {
  defineSourceIndexCorpus,
  type SourceIndexActivationMode,
  type SourceIndexCorpusDefinition,
} from '../../core/source-index/corpus.ts';
import {
  cosineSimilarity,
  decodeEmbedding,
  encodeEmbedding,
  type SourceEmbeddingBackend,
  type SourceEmbeddingProvider,
} from '../source-index/embeddings.ts';
import type {
  SourceIndexCorpusSearchAdapter,
  SourceIndexCorpusSearchRequest,
  SourceIndexCorpusSearchResponse,
  SourceIndexSearchHit,
} from '../../core/source-index/router.ts';
import {
  buildSourceIndexStorageProfile,
  buildSourceSensitivity,
  SOURCE_TRUST_TIERS,
  type RetrievalLaneAudit,
  type SourceFamily,
  type SourceIndexProvenance,
  type SourceIndexStorageProfile,
  type SourceItemIdentity,
  type SourceSensitivity,
  type SourceTrustDomain,
  type SourceTrustTier,
} from '../../core/source-index/types.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import type { ConnectorStoreResultProjector } from './filter-capabilities.ts';

// Exported because the extraction factory's store sink must compute a
// representation expectation that matches what this module will store. A
// second copy of the recipe would drift silently, and the failure mode of that
// drift is an item whose stored representation reads as current against text
// that has changed. One definition, two callers.
export const DEFAULT_MAX_CHUNK_CHARS = 4_000;
const MAX_MAX_CHUNK_CHARS = 32_000;
const MAX_SEARCH_RESULTS = 50;
// Titles are compact, user-assigned metadata. A small source-neutral boost
// keeps an exact title match inside the bounded keyword lane when longer body
// text also matches, without changing the query or candidate budget.
const CONNECTOR_STORE_FTS_TITLE_WEIGHT = 1.5;
// Same semantic-lane posture as the Dropbox/email indexes: bounded embed
// batches, an exact cosine scan over the local sqlite store, and a floor that
// keeps unrelated vectors out of fusion.
const EMBEDDING_BATCH_SIZE = 32;
const MAX_SELECTED_EMBED_ITEM_IDS = 25_000;
const MAX_CONVERSATION_TITLE_LOOKUP_ROWS = 100;
const MIN_VECTOR_SCORE = 0.18;
const READ_RESULT_PROJECTION_LOCATOR_URI = Symbol('connector-store-result-projection-locator-uri');
// Below this bar, semantic similarity is treated as no evidence. Calibrated
// against the live corpus (gemini-embedding-2, 2026-07-25: off-domain
// questions peak at 0.61 best-cosine; true positives and paraphrases start
// at 0.66) and may be re-pinned as the corpus grows.
export const DEFAULT_SEMANTIC_RELEVANCE_BAR = 0.62;
const VECTOR_BACKEND = 'exact_scan';
const SQLITE_STORE_ID = 'connector-store';
const CONNECTOR_STORE_SQLITE_SCHEMA_VERSION = 11;
const MAX_CONSECUTIVE_CONTENT_FETCH_FAILURES = 3;
const CONNECTOR_SYNC_COOPERATIVE_YIELD_ITEMS = 32;

export function connectorStoreMigrations() {
  return [
    ...currentStoreMigrations(),
    {
      version: 3,
      name: 'connector_store_item_search_text',
      up(db: Database) {
        addColumnIfMissing(db, 'items', 'search_text', 'TEXT');
        db.query(`
          UPDATE items
          SET search_text = COALESCE(search_text, title)
          WHERE search_text IS NULL
        `).run();
        db.query('DELETE FROM connector_store_fts').run();
        db.query(CONNECTOR_STORE_FTS_MIGRATION.rebuildSql).run();
      },
    },
    {
      version: 2,
      name: 'connector_store_fts_porter_unicode61_tokenizer',
      up(db: Database) {
        runBoundedFtsTokenizerMigration(db, CONNECTOR_STORE_FTS_MIGRATION);
      },
    },
    {
      version: 4,
      name: 'connector_store_durable_item_owners',
      up(db: Database) {
        addColumnIfMissing(db, 'sync_runs', 'audit_receipt_sha256', 'TEXT');
        createItemOwnersTable(db);
        // Existing databases predate durable ownership. Preserve their latest
        // observed connector provenance as an owner so a later reconciliation
        // never has to infer ownership from the mutable items.sync_run_id.
        db.query(`
          INSERT OR IGNORE INTO item_owners (
            item_pk, connector_id, ownership_kind, first_seen_sync_run_id,
            last_seen_sync_run_id, first_seen_at, last_seen_at
          )
          SELECT
            i.item_pk,
            r.connector_id,
            'observed',
            i.sync_run_id,
            i.sync_run_id,
            COALESCE(r.started_at, i.indexed_at),
            COALESCE(r.completed_at, i.indexed_at)
          FROM items i
          JOIN sync_runs r ON r.sync_run_id = i.sync_run_id
        `).run();
      },
    },
    {
      version: 5,
      name: 'connector_store_conversation_scoped_item_identity',
      up(db: Database) {
        migrateConversationScopedItemIdentity(db);
      },
    },
    {
      version: 6,
      name: 'connector_store_indexed_fts_row_ownership',
      up(db: Database) {
        createConnectorStoreFtsRowsTable(db);
        db.query(`
          INSERT INTO connector_store_fts_rows (fts_rowid, item_pk, chunk_pk)
          SELECT rowid, CAST(item_pk AS INTEGER), CAST(chunk_pk AS INTEGER)
          FROM connector_store_fts
        `).run();
      },
    },
    {
      version: 7,
      name: 'connector_store_message_sender_identity',
      up(db: Database) {
        addColumnIfMissing(db, 'items', 'sender_id', 'TEXT');
        addColumnIfMissing(db, 'items', 'sender_label', 'TEXT');
        addColumnIfMissing(
          db,
          'items',
          'sender_is_owner',
          'INTEGER CHECK(sender_is_owner IS NULL OR sender_is_owner IN (0, 1))',
        );
        createConnectorStoreSenderIndexes(db);
      },
    },
    {
      version: 8,
      name: 'connector_store_embedding_model_provenance',
      up(db: Database) {
        createConnectorStoreEmbeddingModelsTable(db);
      },
    },
    {
      version: 9,
      name: 'connector_store_item_reactions',
      up(db: Database) {
        // Bounded, in-place, and inert: existing rows keep a NULL aggregate,
        // which renders no reaction line, so an upgraded store behaves exactly
        // as it did until a connector actually supplies reactions.
        addColumnIfMissing(db, 'items', 'reactions_json', 'TEXT');
      },
    },
    {
      version: 10,
      name: 'connector_store_item_write_claims',
      up(db: Database) {
        createConnectorStoreItemWriteClaimsTable(db);
      },
    },
    {
      version: CONNECTOR_STORE_SQLITE_SCHEMA_VERSION,
      name: 'connector_store_locator_identity_index',
      up(db: Database) {
        // Deliberately does NOT backfill existing items. The live Dropbox
        // store is multi-gigabyte, and building a whole-store index while the
        // worker opens would turn a schema upgrade into an unbounded boot
        // outage. New/changed rows are maintained by triggers immediately;
        // existing rows move through the bounded, resumable method below.
        createConnectorStoreLocatorIdentityIndex(db);
      },
    },
  ];
}

export const CONNECTOR_STORE_FTS_MIGRATION: SourceIndexFtsMigrationSpec = {
  tableName: 'connector_store_fts',
  createTableSql: `
    CREATE VIRTUAL TABLE IF NOT EXISTS connector_store_fts USING fts5(
      title,
      bounded_text,
      item_pk UNINDEXED,
      chunk_pk UNINDEXED,
      ${SOURCE_INDEX_FTS5_TOKENIZER}
    );
  `,
  indexedRowCountSql: 'SELECT COUNT(*) AS count FROM connector_store_fts',
  rebuildSql: `
    INSERT INTO connector_store_fts (title, bounded_text, item_pk, chunk_pk)
    SELECT
      COALESCE(i.title, ''),
      TRIM(COALESCE(i.search_text, '') || CHAR(10) || COALESCE(c.bounded_text, '')),
      i.item_pk,
      c.chunk_pk
    FROM items i
    LEFT JOIN chunks c
      ON c.item_pk = i.item_pk
    WHERE i.tombstoned = 0
    ORDER BY i.item_pk, c.chunk_index;
  `,
};

export interface LocalConnectorStoreOptions {
  dbPath: string;
  corpusId: string;
  family: SourceFamily;
  trustDomain: SourceTrustDomain;
  /** Opens an existing store without migrations, WAL changes, or writes. */
  readOnly?: boolean;
  /** Clock for owner observations compared with provider snapshot cutoffs. */
  now?: () => Date;
  /**
   * The user's folder-exclusion gate for this store.
   *
   * Store-level rather than per-call on purpose. Every write into this store
   * funnels through one private upsert, and that upsert REFUSES an excluded
   * item outright — so a future caller cannot admit excluded material by
   * reaching a write path that forgot to pass an option. The two callers that
   * enumerate many items check first and count the refusals, so the throw is
   * reserved for a genuine gate bypass rather than ordinary operation.
   */
  exclusions?: SourceExclusionMatcher;
}

export interface ConnectorStoreLocatorIdentityIndexStatus {
  state: 'ready' | 'backfill_required';
  cursorItemPk: number;
  indexedItems: number;
}

export interface ConnectorStoreLocatorIdentityBackfillSummary {
  state: 'ready' | 'backfill_required';
  scannedItems: number;
  indexedItems: number;
  cursorItemPk: number;
}

/**
 * A purge receipt. Counts, plus the user's own configured prefixes as row
 * keys — configuration, not item content. No item path, name, or text.
 */
export interface ConnectorStorePurgeSummary {
  kind: 'connector_store_exclusion_purge';
  corpus_id: string;
  dry_run: boolean;
  counts: {
    items_scanned: number;
    items_matched: number;
    items_removed: number;
    items_would_remove: number;
    items_unevaluable_kept: number;
    chunks_removed: number;
    chunks_would_remove: number;
    embeddings_removed: number;
    embeddings_would_remove: number;
  };
  by_prefix: ConnectorStoreExclusionCounts['by_prefix'];
}

/**
 * A metadata-only strip receipt. Same counts-only shape as the purge, with the
 * verbs deliberately different: an item is STRIPPED here, never removed, and a
 * reader comparing two receipts must not have to check which operation ran to
 * know whether rows survived.
 */
export interface ConnectorStoreMetadataOnlyStripSummary {
  kind: 'connector_store_metadata_only_strip';
  corpus_id: string;
  dry_run: boolean;
  counts: {
    items_scanned: number;
    items_matched: number;
    items_stripped: number;
    items_would_strip: number;
    items_unevaluable_kept: number;
    chunks_removed: number;
    chunks_would_remove: number;
    embeddings_removed: number;
    embeddings_would_remove: number;
  };
  by_prefix: ConnectorStoreExclusionCounts['by_prefix'];
}

function emptyMetadataOnlyStripSummary(
  corpusId: string,
  dryRun: boolean,
  matcher: SourceExclusionMatcher,
): ConnectorStoreMetadataOnlyStripSummary {
  return {
    kind: 'connector_store_metadata_only_strip',
    corpus_id: corpusId,
    dry_run: dryRun,
    counts: {
      items_scanned: 0,
      items_matched: 0,
      items_stripped: 0,
      items_would_strip: 0,
      items_unevaluable_kept: 0,
      chunks_removed: 0,
      chunks_would_remove: 0,
      embeddings_removed: 0,
      embeddings_would_remove: 0,
    },
    by_prefix: exclusionCounts(createExclusionTally(matcher, 'metadata_only')).by_prefix,
  };
}

function emptyPurgeSummary(
  corpusId: string,
  dryRun: boolean,
  matcher: SourceExclusionMatcher,
): ConnectorStorePurgeSummary {
  return {
    kind: 'connector_store_exclusion_purge',
    corpus_id: corpusId,
    dry_run: dryRun,
    counts: {
      items_scanned: 0,
      items_matched: 0,
      items_removed: 0,
      items_would_remove: 0,
      items_unevaluable_kept: 0,
      chunks_removed: 0,
      chunks_would_remove: 0,
      embeddings_removed: 0,
      embeddings_would_remove: 0,
    },
    by_prefix: exclusionCounts(createExclusionTally(matcher)).by_prefix,
  };
}

function* batched<T>(values: readonly T[], size: number): Generator<T[]> {
  for (let index = 0; index < values.length; index += size) {
    yield values.slice(index, index + size);
  }
}

interface ExclusionTally {
  total: number;
  unevaluable: number;
  byPrefix: Map<string, { ruleId: string; prefix: string; reason: string; items: number }>;
}

/**
 * Seed the tally with every configured prefix at zero, so a preview reports
 * "this folder accounts for 0 items" rather than omitting the row. A missing
 * row and a zero row mean different things to someone deciding whether their
 * exclusion is spelled correctly.
 *
 * `mode` scopes the seeded rows to one disposition. A purge preview that
 * listed metadata-only rules at zero would be telling the owner those rules
 * are purge rules that matched nothing, which is the opposite of true — they
 * are rules a purge must never act on.
 */
function createExclusionTally(
  matcher: SourceExclusionMatcher,
  mode: SourceIngestionRuleMode = 'exclude',
): ExclusionTally {
  const byPrefix = new Map<string, { ruleId: string; prefix: string; reason: string; items: number }>();
  for (const entry of matcher.criteria) {
    if (entry.mode !== mode) continue;
    byPrefix.set(`${entry.ruleId}:${entry.prefix}`, {
      ruleId: entry.ruleId,
      prefix: entry.prefix,
      reason: entry.reason,
      items: 0,
    });
  }
  return { total: 0, unevaluable: 0, byPrefix };
}

function tallyExclusion(tally: ExclusionTally, decision: SourceExclusionDecision): void {
  tally.total += 1;
  if (sourceExclusionOutcomeIsUnevaluable(decision.outcome)) {
    tally.unevaluable += 1;
    return;
  }
  if (decision.ruleId === undefined || decision.prefix === undefined) return;
  const key = `${decision.ruleId}:${decision.prefix}`;
  const row = tally.byPrefix.get(key);
  if (row) row.items += 1;
}

function exclusionCounts(tally: ExclusionTally): ConnectorStoreExclusionCounts {
  return {
    items_excluded: tally.total,
    items_excluded_unevaluable: tally.unevaluable,
    by_prefix: [...tally.byPrefix.values()].map((row) => ({
      rule_id: row.ruleId,
      prefix: row.prefix,
      reason: row.reason,
      items: row.items,
    })),
  };
}

/**
 * Raised when an excluded item reaches a store write. Ordinary enumeration
 * never produces this: it means a write path skipped the gate.
 */
export class ConnectorStoreExclusionViolationError extends Error {
  readonly ruleId: string | undefined;
  constructor(ruleId: string | undefined) {
    super('Connector store refused an item excluded by configuration.');
    this.name = 'ConnectorStoreExclusionViolationError';
    this.ruleId = ruleId;
  }
}

/**
 * Raised when CONTENT is written for an item the owner marked metadata-only.
 *
 * The structural half of the third disposition, and the reason it is a
 * disposition rather than a flag some caller remembers to check. Every chunk
 * this store ever writes passes through one private funnel, and that funnel
 * refuses here — so a metadata-only item cannot acquire text by way of a future
 * lane, a restore, an extraction sink, or a re-sync that forgot. The item row
 * itself is untouched: metadata-only means unread, not unindexed.
 *
 * Enumerating callers check the disposition first and count it, so reaching
 * this error means a write path skipped the gate, which is a defect rather than
 * an item-level condition.
 */
export class ConnectorStoreMetadataOnlyViolationError extends Error {
  readonly ruleId: string | undefined;
  constructor(ruleId: string | undefined) {
    super('Connector store refused content for an item configured as metadata-only.');
    this.name = 'ConnectorStoreMetadataOnlyViolationError';
    this.ruleId = ruleId;
  }
}

/**
 * A path-only deletion may not fall back to a whole-store locator scan while
 * the bounded locator index is still being populated. Refusing here keeps the
 * worker responsive and preserves the active item until the maintenance pass
 * can prove an unambiguous identity.
 */
export class ConnectorStoreLocatorIdentityIndexNotReadyError extends Error {
  constructor() {
    super('Connector store locator identity index requires bounded backfill before path-only deletions can run.');
    this.name = 'ConnectorStoreLocatorIdentityIndexNotReadyError';
  }
}

/**
 * Counts of what a pass kept out, keyed by the user's own rule id and
 * configured prefix. Content-free: no item path, name, or text.
 */
export interface ConnectorStoreExclusionCounts {
  items_excluded: number;
  items_excluded_unevaluable: number;
  by_prefix: readonly {
    rule_id: string;
    prefix: string;
    reason: string;
    items: number;
  }[];
}

export interface ConnectorStoreSyncOptions {
  cursor?: string;
  maxItems?: number;
  fetchContent?: boolean;
  /**
   * Index content already carried by a listing, but do not fetch or erase a
   * representation when that listing is metadata-only. This is the ownership
   * mode for connectors whose binary bodies are handled by the shared
   * extraction factory: metadata sync observes the item; extraction owns the
   * derived text.
   */
  deferMetadataOnlyContent?: boolean;
  maxChunkChars?: number;
  classification?: ConnectorStoreClassificationOptions;
  reconcileFullSnapshot?: boolean;
  reconcileFullSnapshotScope?: ConnectorStoreFullSnapshotScope | readonly ConnectorStoreFullSnapshotScope[];
  /** Durable owner semantics independent of the item's latest sync run. */
  ownershipKind?: ConnectorStoreOwnershipKind;
  /** Whether absence from this traversal is authoritative evidence of deletion. */
  reconcileAbsenceAuthority?: ConnectorStoreAbsenceAuthority;
  /**
   * A source-proven provider/account snapshot owns current membership across
   * connector owners. Requires a complete scope and observation cutoff.
   */
  reconcileCurrentMembershipAuthority?: ConnectorStoreCurrentMembershipAuthority;
  /** Snapshot cutoff; observations after it are never removed by a retry. */
  reconcileSnapshotObservedAt?: string;
  /** Provider traversal completion; the observation cutoff cannot be later. */
  reconcileSnapshotCompletedAt?: string;
  /** Required proof binding when current membership is limited to a provider window. */
  reconcileWindowBoundarySha256?: string;
  /** Exact local IDs proven removed inside a verified provider window. */
  reconcileWindowRemovedLocalItemIds?: readonly string[];
  /** Optional content-free receipt for a source-owned normalization/mapping step. */
  auditReceiptSha256?: string;
  /**
   * What this traversal's ownership writes prove about provider membership.
   * A by-id replay (content repair) fetches one known item and proves nothing
   * about listing, so it must pass 'local_write' or the removal fences read
   * its re-stamp as fresh provider evidence.
   */
  ownerObservation?: ConnectorStoreOwnerObservation;
}

export type ConnectorStoreOwnershipKind = 'observed' | 'preservation';

/**
 * Whether an ownership write carries evidence that the provider still lists
 * the item. `provider_listing` is a connector traversal that returned it;
 * `local_write` is everything else — a representation restore, a tombstone —
 * which touches the row without proving anything about the provider.
 */
type ConnectorStoreOwnerObservation = 'provider_listing' | 'local_write';
export type ConnectorStoreAbsenceAuthority = 'complete_snapshot' | 'partial_window';
export type ConnectorStoreCurrentMembershipAuthority =
  | 'connector_owned'
  | 'provider_account_snapshot'
  | 'provider_window_snapshot';

export type ConnectorStoreCoverageGap =
  | {
    kind: 'absence_not_authoritative';
    absenceAuthority: 'partial_window';
    reason: 'provider_coverage_window_partial';
  }
  /**
   * Items the owner's configuration admitted WITHOUT their content.
   *
   * A real, chosen omission, and it has to be said out loud: without this row a
   * metadata-only folder is indistinguishable from a lane whose extraction
   * stalled. Both show items with no chunks; only one of them is correct, and
   * an operator cannot tell which by looking at a coverage percentage.
   *
   * Counts and the owner's own rule id, nothing else. The rule id is
   * configuration; an item path would be content.
   */
  | {
    kind: 'metadata_only_by_rule';
    ruleId: string;
    items: number;
  };

export interface ConnectorStoreClassificationOptions {
  baselineTrustTier?: SourceTrustTier;
  baselineTrustDomain?: SourceTrustDomain;
  sensitivityMap?: SensitivityMap;
}

export interface ConnectorStoreFullSnapshotScope {
  provider: string;
  accountScope: string;
}

// Castor-safe sync summary: counts and gap descriptions only. Gap strings
// reference items by a content-free id hash — never raw text, names, or paths.
export interface ConnectorStoreSyncSummary {
  syncRunId: string;
  corpusId: string;
  connectorId: string;
  status: 'completed';
  itemsSeen: number;
  itemsIndexed: number;
  /**
   * Of `itemsIndexed`, how many upserts actually changed the stored row.
   *
   * `itemsIndexed` counts writes, so a lane re-indexing byte-identical rows
   * reports healthy progress while making none — the shape that hid a Readwise
   * restart loop behind rising counts for hours. This is the honest half, and
   * the scheduler degrades a lane that reports it as zero for long enough.
   *
   * Deliberately NOT a sync_runs column: the store stays at schema v9 and the
   * durable streak lives in the scheduler's existing counts, which already
   * survive a restart.
   */
  itemsChanged: number;
  itemsTombstoned: number;
  /** Tombstones caused specifically by absence reconciliation, not explicit delete events. */
  absenceItemsTombstoned?: number;
  /**
   * Tombstones applied from an explicit, overlap-proven provider-window removal
   * list. Reported apart from `itemsTombstoned` because that total also carries
   * classification tombstones (an S5 secret discovered on fetch), so a proof
   * that subtracted one from the other would fire on a clean run.
   */
  windowRemovedItemsTombstoned?: number;
  /**
   * Window removals this pass proved but did NOT apply because an owner was
   * observed at or after the snapshot cutoff.
   *
   * Reported as ids rather than a count because the caller cannot recompute
   * them: a window removal is derived from the overlap between two snapshots,
   * and once the next snapshot is promoted the item is absent from BOTH sides,
   * so the transition that produced it never recurs. A caller that keeps these
   * can re-present them against a later, stronger cutoff; a caller that drops
   * them has silently decided the item stays for ever.
   *
   * Preservation-owned refusals are deliberately NOT here. That refusal is a
   * standing decision about authority, not a timing accident, and it does not
   * become applicable by waiting.
   */
  windowRemovalsDeferredLocalItemIds?: readonly string[];
  /** Tombstones applied because the connector reported the item deleted. */
  deletedEventItemsTombstoned?: number;
  /** Tombstones applied because the item classified S5, at listing or on fetch. */
  secretsTierItemsTombstoned?: number;
  /**
   * Previously active rows removed because their current classification now
   * belongs to another trust domain. Distinct from a first-observation reject:
   * this count proves the stale readable copy was actively removed.
   */
  itemsDemoted?: number;
  itemsRejected: number;
  /**
   * Items the user's exclusion list kept out on this pass. Reported rather
   * than folded into `itemsRejected` so "excluded by configuration" stays a
   * visible, distinct fact — an omission the user chose, not a failure.
   */
  itemsExcluded: number;
  exclusions: ConnectorStoreExclusionCounts;
  /**
   * Items the owner's configuration admitted with metadata and no content.
   *
   * Counted separately from BOTH `itemsIndexed` and `itemsExcluded`, because it
   * is neither: these items are in `itemsIndexed` (they were written) and are
   * deliberately absent from `chunksIndexed`. Folding them into either number
   * would make the honest gap invisible in exactly the receipt an operator
   * reads to decide whether extraction is working.
   */
  itemsMetadataOnly: number;
  metadataOnly: ConnectorStoreExclusionCounts;
  chunksIndexed: number;
  cursor?: string;
  /**
   * Whether the connector's listing ran out rather than being cut short: it
   * yielded a page marked `done` and this run consumed the whole of it.
   *
   * The only honest source for "did this pass cover the window". A receipt that
   * infers completion from `cursor` instead is wrong on exactly the lane that
   * matters most: a reconcile clears the checkpoint by policy (see the
   * reconcile arms below), so an absent cursor there means "no resume point was
   * kept", never "the traversal finished" — and a reconcile stopped by the
   * connector's own ceiling would report a full pass over 1.4% of a mailbox.
   */
  traversalComplete: boolean;
  gaps: string[];
  coverageGaps?: ConnectorStoreCoverageGap[];
  policy: {
    rawSourceExposed: false;
    sourceTextReturned: false;
    trustDomain: SourceTrustDomain;
    storage: 'local_sqlite';
  };
}

export interface ConnectorStoreSyncRun {
  syncRunId: string;
  corpusId: string;
  connectorId: string;
  status: 'running' | 'completed' | 'failed';
  cursor?: string;
  itemsSeen: number;
  itemsIndexed: number;
  startedAt: string;
  completedAt?: string;
}

export interface ConnectorStoreStatus {
  corpusId: string;
  family: SourceFamily;
  trustDomain: SourceTrustDomain;
  counts: {
    items: number;
    tombstonedItems: number;
    chunks: number;
    embeddedChunks: number;
    syncRuns: number;
    /**
     * Live items that hold at least one chunk: the store's own per-ITEM
     * readiness fact, and the only honest numerator for an answer-ready ratio.
     *
     * `chunks` cannot stand in for it. One PDF yields many chunks, so
     * `min(items, chunks)` reaches the item count as soon as the average item
     * has produced a single chunk — which is how a corpus of 100k files with
     * 20k of them extracted reported itself fully answer-ready.
     */
    itemsWithText: number;
  };
  /**
   * Embedding parity PER MODEL: for each model that holds any vector here,
   * the chunks whose vector is current (hash parity) and the live items whose
   * EVERY chunk carries such a vector. The reader picks the serving model's
   * row; a model that is not serving is not "embedded" for answering purposes,
   * whatever parity its stale vectors still hold (owner ruling, 2026-08-24).
   * `embeddedChunks` in `counts` stays model-agnostic for callers that predate
   * this; the per-item count exists only here, so it can never be read
   * without a model.
   */
  embeddingByModel: Array<{ modelId: string; embeddedChunks: number; itemsEmbedded: number }>;
  lastSyncRun?: ConnectorStoreSyncRun;
}

export interface ConnectorStoreQualificationFingerprint {
  schemaVersion: number;
  storeSha256: string;
}

/**
 * Read-only logical fingerprint used by qualification/activation receipts.
 *
 * A raw SQLite-file hash is not sufficient while WAL mode is active. This
 * digest reads the committed logical view, includes stable identities and
 * representation hashes (never source text or embedding vectors), and
 * therefore binds a receipt to the exact mounted store without exposing it.
 */
export function connectorStoreQualificationFingerprint(
  dbPath: string,
): ConnectorStoreQualificationFingerprint {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    // busy_timeout leads, matching the store's own read-only open below. This
    // digest reads a live store the sync loop may be checkpointing, so without
    // a timeout the fingerprint fails instantly on contention rather than
    // waiting for the writer it is reading behind.
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON;');
    const schemaVersion = readSqliteSchemaVersion(db, SQLITE_STORE_ID);
    assertSqliteSchemaCanOpen(db, SQLITE_STORE_ID, CONNECTOR_STORE_SQLITE_SCHEMA_VERSION);
    const digest = createHash('sha256');
    digest.update(JSON.stringify({ storeId: SQLITE_STORE_ID, schemaVersion }));
    for (const query of [
      `SELECT
        item_pk, family, provider, account_scope, normalized_conversation,
        provider_item_id, local_item_id, source_version, trust_tier,
        content_hash, tombstoned, sender_id, sender_label, sender_is_owner
       FROM items ORDER BY item_pk`,
      `SELECT
        chunk_pk, item_pk, chunk_index, content_hash, embedding_input_hash
       FROM chunks ORDER BY chunk_pk`,
      `SELECT
        item_pk, chunk_pk, model_id, content_hash
       FROM chunk_embeddings ORDER BY item_pk, chunk_pk, model_id`,
      `SELECT
        item_pk, connector_id, ownership_kind, first_seen_sync_run_id,
        last_seen_sync_run_id
       FROM item_owners ORDER BY item_pk, connector_id`,
    ]) {
      digest.update('\n');
      digest.update(JSON.stringify(db.query(query).all()));
    }
    return { schemaVersion, storeSha256: digest.digest('hex') };
  } finally {
    closeSqliteStore(db);
  }
}

export interface ConnectorStoreEmbedOptions {
  provider: SourceEmbeddingProvider;
  modelId?: string;
  limit?: number;
  /** Optional item selection for latency-sensitive incremental ingest. */
  localItemIds?: readonly string[];
  /** Durable idempotency key for a maintenance page's embedding phase. */
  journalId?: string;
  /** Monotonic owner generation used to fence a superseded maintenance run. */
  journalLeaseGeneration?: number;
  /**
   * Atomically removes the selected chunks' current rows for this model when
   * creating a new journal. Used when a full provider fingerprint changes but
   * the replacement provider intentionally keeps the same model id.
   */
  invalidateCurrentModelEmbeddings?: boolean;
}

// Castor-safe embed summary: counts and provider identity only — no chunk
// text, no titles, no locators.
export interface ConnectorStoreEmbedSummary {
  corpusId: string;
  modelId: string;
  embeddingProvider: string;
  embeddingBackend: SourceEmbeddingBackend;
  embeddingDimension: number;
  embeddingEpoch: string;
  chunksSeen: number;
  chunksEmbedded: number;
  chunksSkipped: number;
  policy: {
    rawSourceExposed: false;
    sourceTextReturned: false;
    trustDomain: SourceTrustDomain;
    storage: 'local_sqlite';
  };
}


export interface ConnectorStoreSyncAndEmbedOptions {
  store: LocalConnectorStore;
  connector: SourceConnector;
  embeddingProvider: SourceEmbeddingProvider;
  sync?: ConnectorStoreSyncOptions;
}

export interface ConnectorStoreSyncAndEmbedSummary {
  sync: ConnectorStoreSyncSummary;
  embed: ConnectorStoreEmbedSummary;
}

/**
 * Which chunk of the item a lane matched, and where inside it.
 *
 * Offsets, never text: this rides on the membrane-safe search row, so it has to
 * be as safe as the identity beside it. What makes the item-level coordinates
 * derivable at schema v9 without a new column is the store's own chunking
 * recipe — `chunkText` cuts the trimmed item text into contiguous,
 * non-overlapping slices in chunk_index order, so concatenating the chunks
 * reproduces that text exactly and the prefix lengths ARE the offsets.
 */
export interface ConnectorStoreChunkMatch {
  // The store's local chunk rowid. Local and re-sync-unstable by nature, like
  // every other local id on this row; (chunkIndex, contentHash) beside it are
  // the durable way to re-find the same chunk after a re-ingest.
  chunkId: string;
  chunkIndex: number;
  contentHash: string;
  charStart: number;
  charEnd: number;
  itemCharStart: number;
  itemCharEnd: number;
  chunkChars: number;
  lane: 'keyword' | 'semantic';
}

// Internal search row: identity + citation-safe metadata only. The bounded
// chunk text never leaves the store through this surface.
export interface ConnectorStoreSearchRow {
  sourceItem: SourceItemIdentity;
  title?: string;
  conversationLabel?: string;
  senderId?: string;
  authorLabel?: string;
  senderIsOwner?: boolean;
  authoredAt?: string;
  updatedAt?: string;
  syncRunId: string;
  trustTier: SourceTrustTier;
  rank: number;
  /** Offset-level match locator. Absent when no lane could pin one down. */
  chunk?: ConnectorStoreChunkMatch;
}

export interface ConnectorStoreScoredSearchRow extends ConnectorStoreSearchRow {
  bestCosine: number;
}

export interface ConnectorStoreCurrentEmbeddingRow {
  itemPk: number;
  /** The chunk this vector was computed from — the unit a cosine actually scores. */
  chunkPk: number;
  localItemId: string;
  embedding: unknown;
}

const CONNECTOR_STORE_VECTOR_SCAN_PAGE_SIZE = 256;

interface ConnectorStoreCurrentEmbeddingRowsOptions {
  modelId: string;
  accountScope?: string;
  filters?: ConnectorStoreSearchFilters;
}

const CONNECTOR_STORE_CURRENT_EMBEDDING_JOINS_AND_FILTER = `
  FROM chunk_embeddings emb
  JOIN chunks c ON c.chunk_pk = emb.chunk_pk
  JOIN items i ON i.item_pk = emb.item_pk
  WHERE i.tombstoned = 0
    AND emb.content_hash = c.embedding_input_hash
`;

/**
 * Builds the shared eligibility query. `ordered` exists because the two callers
 * want different things from the same rows: the calibration probe hands them
 * back and so needs a stable order, while the vector lane folds them into a
 * best-score-per-item Map where order cannot be observed. Sorting rows that
 * each carry a 10 KB blob forces SQLite to build a temp B-tree over the whole
 * payload, so the lane asks for them unordered.
 *
 * Both forms share this one builder so the eligibility and scoping predicates
 * can only ever be written once.
 */
function connectorStoreCurrentEmbeddingRowsQuery(
  options: ConnectorStoreCurrentEmbeddingRowsOptions,
  ordered: boolean,
): { sql: string; params: string[] } {
  const modelId = requireNonEmpty(options.modelId, 'Connector store embedding model id');
  const accountScope = normalizeOptionalAccountScope(options.accountScope);
  const selectedFilters = connectorStoreFilterSql(options.filters);
  return {
    sql: `
      SELECT emb.item_pk, emb.chunk_pk, i.local_item_id, emb.embedding
      ${CONNECTOR_STORE_CURRENT_EMBEDDING_JOINS_AND_FILTER}
        AND emb.model_id = ?
        ${accountScope ? 'AND i.account_scope = ?' : ''}
        ${selectedFilters.sql}
      ${ordered ? 'ORDER BY emb.item_pk ASC, emb.chunk_pk ASC' : ''}
    `,
    params: [
      modelId,
      ...(accountScope ? [accountScope] : []),
      ...selectedFilters.params,
    ],
  };
}

/**
 * Streaming form of the eligibility query, for the vector lane.
 *
 * Account scope and every ConnectorStoreSearchFilters predicate stay inside
 * this single SQL statement, so SQLite applies them before a row is ever
 * produced — the lane cannot see a row it is not entitled to and then discard
 * it. That pre-filter placement is a trust boundary, not a performance detail.
 *
 * Streaming matters for the same reason: `.all()` materialised every eligible
 * vector at once, so a 170k-row corpus held ~1.7 GB of blobs live before the
 * first score was computed. Iterating keeps one row alive at a time.
 */
export function* connectorStoreCurrentEmbeddingRowsIterator(
  db: Database,
  options: ConnectorStoreCurrentEmbeddingRowsOptions,
): Generator<ConnectorStoreCurrentEmbeddingRow> {
  const { sql, params } = connectorStoreCurrentEmbeddingRowsQuery(options, false);
  const rows = db.query(sql).iterate(...params) as Iterable<{
    item_pk: number;
    chunk_pk: number;
    local_item_id: string;
    embedding: unknown;
  }>;
  for (const row of rows) {
    yield {
      itemPk: row.item_pk,
      chunkPk: row.chunk_pk,
      localItemId: row.local_item_id,
      embedding: row.embedding,
    };
  }
}

/**
 * Keyset-paged form used by interactive exact-vector retrieval.
 *
 * A page bounds both the synchronous SQLite call and resident vector bytes.
 * Ordering by the embedding primary-key prefix makes progress monotonic; a
 * caller can yield between pages so route deadlines and unrelated lanes keep
 * making progress without ever materialising the full corpus.
 */
function connectorStoreCurrentEmbeddingRowsPage(
  db: Database,
  options: ConnectorStoreCurrentEmbeddingRowsOptions,
  afterChunkPk: number,
  limit = CONNECTOR_STORE_VECTOR_SCAN_PAGE_SIZE,
): ConnectorStoreCurrentEmbeddingRow[] {
  const modelId = requireNonEmpty(options.modelId, 'Connector store embedding model id');
  const accountScope = normalizeOptionalAccountScope(options.accountScope);
  const selectedFilters = connectorStoreFilterSql(options.filters);
  const pageLimit = Math.max(1, Math.floor(limit));
  const rows = db.query(`
    SELECT emb.item_pk, emb.chunk_pk, i.local_item_id, emb.embedding
    ${CONNECTOR_STORE_CURRENT_EMBEDDING_JOINS_AND_FILTER}
      AND emb.model_id = ?
      AND emb.chunk_pk > ?
      ${accountScope ? 'AND i.account_scope = ?' : ''}
      ${selectedFilters.sql}
    ORDER BY emb.chunk_pk ASC
    LIMIT ?
  `).all(
    modelId,
    afterChunkPk,
    ...(accountScope ? [accountScope] : []),
    ...selectedFilters.params,
    pageLimit,
  ) as Array<{
    item_pk: number;
    chunk_pk: number;
    local_item_id: string;
    embedding: unknown;
  }>;
  return rows.map((row) => ({
    itemPk: row.item_pk,
    chunkPk: row.chunk_pk,
    localItemId: row.local_item_id,
    embedding: row.embedding,
  }));
}

/**
 * Shared eligibility query for the connector-store vector lane and its
 * read-only calibration probe. Returns vectors plus identifiers only.
 */
export function connectorStoreCurrentEmbeddingRows(
  db: Database,
  options: ConnectorStoreCurrentEmbeddingRowsOptions,
): ConnectorStoreCurrentEmbeddingRow[] {
  const { sql, params } = connectorStoreCurrentEmbeddingRowsQuery(options, true);
  const rows = db.query(sql).all(...params) as Array<{
    item_pk: number;
    chunk_pk: number;
    local_item_id: string;
    embedding: unknown;
  }>;
  return rows.map((row) => ({
    itemPk: row.item_pk,
    chunkPk: row.chunk_pk,
    localItemId: row.local_item_id,
    embedding: row.embedding,
  }));
}

/**
 * Selects the most recently written current model for an account. Stale and
 * tombstoned embeddings are excluded by the same eligibility fragment used
 * by vectorSearchItemsWithScores.
 */
export function connectorStoreCurrentEmbeddingModelId(
  db: Database,
  accountScope: string,
): string | undefined {
  const selectedAccount = normalizeOptionalAccountScope(accountScope);
  if (!selectedAccount) {
    throw new Error('Connector store account scope is required.');
  }
  const row = db.query(`
    SELECT
      emb.model_id,
      COUNT(*) AS current_chunks,
      MAX(emb.embedded_at) AS latest_embedding_at
    ${CONNECTOR_STORE_CURRENT_EMBEDDING_JOINS_AND_FILTER}
      AND i.account_scope = ?
    GROUP BY emb.model_id
    ORDER BY latest_embedding_at DESC, current_chunks DESC, emb.model_id ASC
    LIMIT 1
  `).get(selectedAccount) as { model_id: string } | null;
  return row?.model_id;
}

export interface ConnectorStoreLocalContent {
  trustTier: SourceTrustTier;
  chunks: readonly string[];
  truncated: boolean;
  locatorUri?: string;
  /**
   * Chunk rows the store holds for this item, measured BEFORE the evidence
   * budget trims them. Zero means the spine never got text for the item, which
   * is a different and far more useful statement than "the budget left no
   * room" — only the first one is an extraction gap.
   */
  storedChunks: number;
  /** The item's stored media type: the spine's only durable extraction signal. */
  mimeType: string;
}

export interface ConnectorStoreItemPresence {
  active: boolean;
  sourceVersion?: string;
  contentHash?: string;
}

export interface ConnectorStoreActiveLocatorItem {
  identity: SourceItemIdentity;
  trustTier: SourceTrustTier;
  locatorUri: string;
}

/**
 * The stored metadata an enriching re-emit has to carry forward.
 *
 * `upsertItem` assigns every one of these columns from the emitted RawItem
 * unconditionally — `title = excluded.title`, and so on for the locator, the
 * media type, both timestamps and the source version. That is correct for a
 * connector re-emitting its own full item, and destructive for a caller that
 * holds only extracted text plus an identity: a synthetic item built from the
 * text alone silently blanks everything the metadata sync wrote, leaving
 * citations with no title and no locator and temporal ordering with no
 * authored_at.
 *
 * Reading this first and folding it into the synthetic item is what makes such
 * a re-emit an enrichment rather than a replacement.
 *
 * Not included: the derived `search_text`. It is rebuilt from the title (and,
 * for families that have them, the reaction line) on every upsert, so handing
 * it back as an explicit `searchText` would fold a reaction line that is
 * already inside it in a second time.
 */
export interface ConnectorStoreItemMetadataSnapshot {
  sourceVersion?: string;
  contentHash?: string;
  mimeType?: string;
  name?: string;
  locatorUri?: string;
  authoredAt?: string;
  updatedAt?: string;
}

/**
 * One item the extraction factory may be asked to read bytes for.
 *
 * This carries exactly what the `items` row carries and nothing more. There is
 * no `size_bytes` column, so a caller that needs a byte size gets it from the
 * provider, not from here; likewise the corpus id and the lane's scope key are
 * the calling source's to supply, because the store does not model either.
 * Inventing a column to round the shape out would put a value in the database
 * that nothing maintains.
 */
export interface ConnectorStoreExtractionCandidate {
  identity: SourceItemIdentity;
  trustTier: SourceTrustTier;
  /**
   * Chunk rows the store already holds for this item. Zero is the signal that
   * no text ever reached the spine for it, which is what `withoutChunksOnly`
   * selects on.
   */
  storedChunks: number;
  mimeType?: string;
  name?: string;
  locatorUri?: string;
  contentHash?: string;
}

export interface ConnectorStoreExtractionCandidateOptions {
  limit: number;
  /** The previous page's `nextCursor`: the last `item_pk` examined, as a string. */
  cursor?: string;
  /**
   * Media types to admit. An entry is either an exact type or a trailing
   * wildcard of the form `type/*`; anything else is refused rather than
   * silently matching nothing. Omitted means every media type.
   */
  mimeTypes?: readonly string[];
  accountScope?: string;
  withoutChunksOnly?: boolean;
}

export interface ConnectorStoreExtractionCandidatePage {
  candidates: readonly ConnectorStoreExtractionCandidate[];
  nextCursor?: string;
  done: boolean;
  /**
   * Rows this page passed over because the owner's configuration says they are
   * never read. Present only when non-zero, so a lane's ordinary page carries
   * no field at all and a page that DID skip cannot be mistaken for one that
   * simply ran out of rows.
   */
  skippedByDisposition?: number;
}

export interface ConnectorStoreItemRepresentationExpectation {
  sourceItem: SourceItemIdentity;
  sourceVersion?: string;
  contentHash: string;
  chunkContentHashes: readonly string[];
  requiredSearchTokens?: readonly string[];
  embeddingModelId?: string;
}

export interface ConnectorStoreItemRepresentationCoverage {
  chunksIndexed: number;
  chunksEmbeddingCurrent: number;
  complete: boolean;
}

export interface ConnectorStoreRepresentationRestoreItem {
  item: RawItem;
  expectation: ConnectorStoreItemRepresentationExpectation;
}

/**
 * A monotonic grant for one write, minted by whatever hands the work out.
 *
 * The store does not know or care what a scope means — an extractor kind, a
 * repair pass, anything a producer keeps its own generations under. It only
 * orders grants: within one authority, a write may not land on top of a newer
 * one for the same item and scope.
 */
export interface ConnectorStoreItemWriteClaim {
  /** Which family of writes this grant orders. Data, chosen by the caller. */
  scope: string;
  /** The sequence space `ordinal` counts in. */
  authority: string;
  /** Strictly increasing within `authority`. */
  ordinal: number;
  /** Who holds the grant, for forensics. Never a capability. */
  holder: string;
  /**
   * Opaque marker for THIS generation of the holder, so two grants of the same
   * job are distinguishable in the ledger. A digest, never the producer's own
   * lease capability: a token that could be replayed must not be copied into a
   * second database.
   */
  generation: string;
}

export interface ConnectorStoreRepresentationRestoreOptions {
  items: readonly ConnectorStoreRepresentationRestoreItem[];
  syncConnectorId: string;
  ownerConnectorId: string;
  ownershipKind: ConnectorStoreOwnershipKind;
  classify: (item: RawItem) => SourceSensitivity;
  skipOwner?: {
    connectorId: string;
    ownershipKind: ConnectorStoreOwnershipKind;
  };
  /**
   * The grant this restore is being performed under, recorded and compared
   * INSIDE the write transaction. Optional: a caller with no queue behind it
   * has no generations to order, and passing nothing leaves the ledger and the
   * write exactly as they were.
   */
  writeClaim?: ConnectorStoreItemWriteClaim;
  maxChunkChars?: number;
  /**
   * Keep existing newline-delimited search facets while merging metadata
   * recovered with the representation. Useful when a targeted provider
   * content lookup cannot repeat collection/folder metadata owned by the
   * listing connector.
   */
  preserveStoredSearchText?: boolean;
  /**
   * Trust existing owned facet lines only after the caller has mechanically
   * verified the owning migration completed. Without this authority every
   * reserved-prefix line is preserved as escaped literal text.
   */
  preserveStoredSearchTextOwnedFacets?: boolean;
}

export interface ConnectorStoreRepresentationRestoreSummary {
  syncRunId: string;
  counts: {
    itemsSeen: number;
    itemsRestored: number;
    itemsUnchanged: number;
    itemsSkippedByOwner: number;
    /** Kept out by the user's exclusion list rather than restored. */
    itemsExcluded: number;
    /**
     * Admitted, but configured metadata-only, so there was no content for a
     * restore to attach. Distinct from `itemsExcluded` because the item rows
     * are present and correct — only the extraction was refused.
     */
    itemsMetadataOnly: number;
    /**
     * Targeted rows that are tombstoned. A restore attaches content to an item
     * the store already holds; re-admitting a removed one would resurrect it,
     * so the row is counted and skipped rather than written. Counted, not
     * thrown: a runner handing this store an extraction of a row that was
     * removed while the job queued is behaving correctly.
     */
    itemsSkippedTombstoned: number;
    /**
     * Refused by the write-claim ledger: this store has already accepted a
     * NEWER grant for the same item and scope, so the caller is a superseded
     * generation whose text would replace the current holder's. Counted rather
     * than thrown for the same reason as the two skips above — a producer
     * whose work was reassigned mid-flight is behaving correctly, and the
     * refusal is the fence doing its job.
     */
    itemsSkippedStaleClaim: number;
    chunksAwaitingEmbedding: number;
  };
  restoredProviderItemIds: string[];
  skippedProviderItemIds: string[];
}

export interface ConnectorStoreRelinquishOptions {
  /** The identities another corpus has proven a stronger claim to. */
  identities: readonly SourceItemIdentity[];
  /**
   * Run lineage for the relinquish itself. It MUST NOT be a traversal
   * connector's id: a completed run under that id would hand the traversal
   * this run's empty cursor the next time it resumes.
   */
  syncConnectorId: string;
  /** Ownership lineage — whose copy is being given up. */
  ownerConnectorId: string;
  ownershipKind: ConnectorStoreOwnershipKind;
  /**
   * Tier the tombstone records. Defaults to this store's conservative tier;
   * a caller giving up a copy to a stricter corpus should pass that corpus's
   * tier so the removed row is not labelled looser than the content was.
   */
  trustTier?: SourceTrustTier;
}

export interface ConnectorStoreRelinquishSummary {
  /** Present only when something was actually given up. */
  syncRunId?: string;
  counts: {
    identitiesConsidered: number;
    itemsRelinquished: number;
  };
  /** The local item ids this store gave up, sorted. */
  relinquishedLocalItemIds: string[];
}

export interface ConnectorStoreActiveIdentityPage {
  identities: SourceItemIdentity[];
  /** The last item primary key this page reached; pass back as `afterItemPk`. */
  cursorItemPk: number;
  /** True when no active row exists past this page. */
  exhausted: boolean;
}

export interface ConnectorStoreTrustReconciliationOptions {
  /** The store whose active identities override this store's copies. */
  stricter: LocalConnectorStore;
  /**
   * Durable cursor lineage for the sweep itself, in THIS store's run history.
   * It must be distinct from every traversal connector id (a completed run
   * under a traversal id would hand that lane this sweep's cursor) and from
   * the relinquish lineage (whose rows carry no cursor and would erase this
   * sweep's resume position).
   */
  reconcileConnectorId: string;
  /** Run lineage for the relinquish rows the sweep writes. */
  evictionSyncConnectorId: string;
  /** Ownership lineage — whose copies are being given up. */
  ownerConnectorId: string;
  ownershipKind: ConnectorStoreOwnershipKind;
  /** Tier the eviction tombstones record; see {@link ConnectorStoreRelinquishOptions}. */
  trustTier?: SourceTrustTier;
  /** Stricter-store identities per window. Defaults to 1,000; max 10,000. */
  maxItems?: number;
  /** Windows one call may advance. Defaults to 4; max 100,000. */
  maxWindows?: number;
}

export interface ConnectorStoreTrustReconciliationSummary {
  state: 'ready' | 'in_progress';
  identitiesScanned: number;
  itemsRelinquished: number;
  /** The stricter store's item primary key the durable cursor now stands at. */
  cursorItemPk: number;
  /** The local item ids this store gave up across this call's windows, sorted. */
  relinquishedLocalItemIds: string[];
}

export interface ConnectorStoreTrustReconciliationStatus {
  state: 'ready' | 'in_progress';
  cursorItemPk: number;
}

export interface ConnectorStoreCurrentItemRepresentationCoverage {
  chunksIndexed: number;
  chunksEmbeddingCurrent: number;
  representationComplete: boolean;
  embeddingsComplete: boolean;
}

export interface ConnectorStoreCorpusIntegrityOptions {
  /** The model whose embedding currency should be checked for every active chunk. */
  embeddingModelId: string;
  /** Maximum opaque local ids returned per deficiency category. Defaults to 20; maximum 100. */
  sampleLimit?: number;
}

export interface ConnectorStoreCorpusIntegrityReport {
  corpusId: string;
  embeddingModelId: string;
  counts: {
    itemsWithFtsDeficiency: number;
    chunksWithoutCurrentEmbeddings: number;
    itemsWithChunkHashDisagreement: number;
  };
  samples: {
    ftsDeficientLocalItemIds: string[];
    missingEmbeddingLocalItemIds: string[];
    chunkHashDisagreementLocalItemIds: string[];
  };
  policy: {
    countsOnly: true;
    rawSourceExposed: false;
    sourceTextReturned: false;
    trustDomain: SourceTrustDomain;
    storage: 'local_sqlite';
  };
}

export interface ConnectorStoreSearchFilters {
  /** Exact stored provider identity; internal principal boundary, not a request field. */
  provider?: string;
  /**
   * Rooted locator path matched case-insensitively at a segment boundary.
   * Exact path and descendants match; string-prefix siblings do not.
   */
  locatorPathScope?: string;
  conversationId?: string;
  senderId?: string;
  senderLabel?: string;
  authoredAfter?: string;
  authoredBefore?: string;
  /**
   * Exact newline-delimited search-context facets required on the item.
   *
   * Connectors already normalize aliases and identity aliases into
   * `items.search_text`, one value per line. Keeping this predicate generic
   * lets source-facing parameters (collections, labels, folders) constrain
   * every retrieval lane without adding a source-specific table or branch.
   */
  searchTextExactLines?: readonly string[];
}

export interface ConnectorStoreSenderAggregationOptions {
  accountScope: string;
  conversationId: string;
  provider?: string;
  maxSenders?: number;
}

export interface ConnectorStoreSenderAggregation {
  population: 'indexed_active_items';
  ranking: 'exact' | 'approximate';
  senders: Array<{
    senderId: string;
    displayLabel: string;
    messageCount: number;
    authoredAtFirst?: string;
    authoredAtLast?: string;
  }>;
  coverage: {
    providerTraversal: 'not_asserted';
    senderAttribution: 'complete' | 'partial';
    dateCoverage: 'complete' | 'partial';
    indexedItems: number;
    attributedItems: number;
    unattributedItems: number;
    itemsWithoutAuthoredAt: number;
    distinctSenders: number;
    omittedSenders: number;
    authoredAtFirst?: string;
    authoredAtLast?: string;
  };
  policy: {
    readOnly: true;
    rawSourceExposed: false;
    sourceTextReturned: false;
  };
}

export interface ConnectorStoreSenderMetadata {
  senderId?: string;
  senderLabel?: string;
  senderIsOwner?: boolean;
}

export interface ConnectorStoreSenderRepairRecord extends ConnectorStoreSenderMetadata {
  sourceItem: SourceItemIdentity;
}

export interface ConnectorStoreSenderRepairOptions {
  records: readonly ConnectorStoreSenderRepairRecord[];
  cursor?: string;
  maxItems?: number;
}

export interface ConnectorStoreSenderRepairSummary {
  counts: {
    itemsScanned: number;
    itemsRepaired: number;
    itemsUnchanged: number;
    itemsMissing: number;
  };
  inputDigestSha256: string;
  outputDigestSha256: string;
  cursor?: string;
}

export interface ConnectorStoreConnectorSenderRepairSummary {
  status: 'completed';
  converged: boolean;
  counts: ConnectorStoreSenderRepairSummary['counts'];
  inputDigestSha256: string;
  outputDigestSha256: string;
  resumeCursor?: string;
}

export interface ConnectorStoreSearchTextRepairOptions {
  provider: string;
  cursor?: string;
  maxItems?: number;
  batchSize?: number;
  supplementalSearchText?: (identity: SourceItemIdentity) => readonly string[];
}

export interface ConnectorStoreSearchTextRepairSummary {
  counts: {
    itemsScanned: number;
    itemsRepaired: number;
    itemsUnchanged: number;
    itemsWithoutChunks: number;
    ftsRowsRefreshed: number;
    /**
     * Chunks whose embedding input actually moved with the repaired text, and
     * which the embed drain must therefore revisit. This is the size of the
     * re-embed the repair just booked; a repair that changes no embedding
     * input reports zero and costs nothing.
     */
    chunkEmbeddingInputsInvalidated: number;
  };
  inputDigestSha256: string;
  outputDigestSha256: string;
  cursor?: string;
}

export interface ConnectorStoreOwnedSearchFacetRefreshRecord {
  sourceItem: SourceItemIdentity;
  namespacePrefix: string;
  literalEscapePrefix: string;
  exactLines: readonly string[];
}

export interface ConnectorStoreOwnedSearchFacetRefreshSummary {
  counts: {
    itemsScanned: number;
    itemsRefreshed: number;
    itemsUnchanged: number;
    itemsMissing: number;
    ftsRowsRefreshed: number;
    chunkEmbeddingInputsInvalidated: number;
  };
  matchedLocalItemIds: string[];
  refreshedLocalItemIds: string[];
}

interface ItemRow {
  item_pk: number;
  provider: string;
  family: string;
  account_scope: string;
  provider_item_id: string;
  provider_thread_id: string | null;
  provider_conversation_id: string | null;
  provider_file_id: string | null;
  provider_event_id: string | null;
  local_item_id: string;
  source_version: string | null;
  title: string | null;
  sender_id: string | null;
  sender_label: string | null;
  sender_is_owner: number | null;
  mime_type: string;
  authored_at: string | null;
  updated_at: string | null;
  search_text?: string | null;
  trust_tier: string;
  sync_run_id: string;
  rank: number;
  /** Only the FTS lane selects one; the recency and vector lanes leave it null. */
  chunk_pk?: number | null;
}

interface SyncRunRow {
  sync_run_id: string;
  corpus_id: string;
  connector_id: string;
  status: 'running' | 'completed' | 'failed';
  cursor: string | null;
  items_seen: number;
  items_indexed: number;
  started_at: string;
  completed_at: string | null;
}

export class LocalConnectorStore {
  readonly dbPath: string;
  readonly corpusId: string;
  readonly family: SourceFamily;
  readonly trustDomain: SourceTrustDomain;
  readonly storageProfile: SourceIndexStorageProfile;
  private db: Database;
  private readonly now: () => Date;
  /**
   * Completion latch for trust reconciliation lineages, keyed by connector id
   * holding the final cursor. A completed sweep is immutable — nothing ever
   * un-completes it — so once this instance has read (or written) the marker,
   * every later check is answered from memory. Without this, the sync path's
   * unconditional per-pull check would pay an unindexed scan of the
   * ever-growing run-history table forever. Lazily created: a class-field
   * initializer here defeats the bundler's tree-shaking of this module and
   * drags the whole store into bundles that never construct it.
   */
  private trustReconciliationReadyCursors: Map<string, number> | undefined;
  /**
   * The user's folder-exclusion gate. Read-only after construction: nothing
   * may relax it for one call, because "relax for this call" is how an
   * exclusion becomes advisory.
   */
  readonly exclusions: SourceExclusionMatcher;
  // A read-only open cannot migrate, so it can legitimately be pointed at a
  // store that predates the reactions column (a writer on the new build has
  // not opened it yet). Such a store has no reactions, and saying so is
  // cheaper and more honest than refusing to serve it.
  private reactionsColumnPresent = false;

  constructor(options: LocalConnectorStoreOptions) {
    this.corpusId = requireNonEmpty(options.corpusId, 'Connector store corpus id');
    this.dbPath = requireNonEmpty(options.dbPath, 'Connector store db path');
    this.family = options.family;
    this.trustDomain = options.trustDomain;
    this.now = options.now ?? (() => new Date());
    this.exclusions = options.exclusions ?? createSourceExclusionMatcherFromPrefixes([]);
    // Build the storage profile via the shared policy builder, then assert the
    // invariant this store depends on rather than trusting defaults: a
    // secure_local corpus must stay local_private on sqlite+fts5.
    this.storageProfile = buildSourceIndexStorageProfile({ trustDomain: options.trustDomain });
    assertConnectorStoreStorageProfile(this.storageProfile);

    if (options.readOnly === true && this.dbPath === ':memory:') {
      throw new Error('Connector store read-only mode requires an existing database path.');
    }
    if (options.readOnly === true) {
      const stat = lstatSync(this.dbPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Connector store read-only mode requires a regular non-symlink database file.');
      }
    } else if (this.dbPath !== ':memory:') {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    this.db = new Database(this.dbPath, options.readOnly === true
      ? { readonly: true, create: false, strict: true }
      : { create: true });
    try {
      this.db.exec(options.readOnly === true
        ? 'PRAGMA busy_timeout = 10000; PRAGMA query_only = ON; PRAGMA foreign_keys = ON;'
        : 'PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
      assertSqliteSchemaCanOpen(this.db, SQLITE_STORE_ID, CONNECTOR_STORE_SQLITE_SCHEMA_VERSION);
      validateCurrentConnectorStoreSchemaBeforeMigration(this.db);
      if (options.readOnly === true) {
        const version = readSqliteSchemaVersion(this.db, SQLITE_STORE_ID);
        // Read-only opens cannot migrate, so they accept every schema from the
        // v7 filter columns forward. Anything newer than this build already
        // failed assertSqliteSchemaCanOpen above.
        if (version < 7) {
          throw new Error('Connector store read-only mode requires the v7 filter schema or newer.');
        }
      } else {
        refuseUnversionedConnectorStoreSchema(this.db);
        this.migrate();
        runSqliteMigrations(this.db, SQLITE_STORE_ID, connectorStoreMigrations());
        validateConnectorStoreSchema(this.db);
      }
      this.reactionsColumnPresent = tableColumns(this.db, 'items', false).includes('reactions_json');
    } catch (error) {
      closeSqliteStore(this.db);
      throw error;
    }
  }

  close(): void {
    closeSqliteStore(this.db);
  }

  [READ_RESULT_PROJECTION_LOCATOR_URI](
    identity: SourceItemIdentity,
    locatorPathScope?: string,
  ): string | undefined {
    // Projection is deliberately lazy, so retrieval and release can observe
    // different current-row state. Reapply the exact retrieval scope here:
    // stable identity permits an in-scope move to release its current path,
    // while a move outside the request's approved scope fails closed.
    const scopePredicate = connectorStoreFilterSql(
      locatorPathScope ? { locatorPathScope } : undefined,
    );
    const rows = this.db.query(`
      SELECT locator_uri
      FROM items i
      WHERE i.family = ?
        AND i.provider = ?
        AND i.account_scope = ?
        AND i.normalized_conversation = ?
        AND i.provider_item_id = ?
        AND i.local_item_id = ?
        AND i.tombstoned = 0
        ${scopePredicate.sql}
      LIMIT 2
    `).all(
      identity.family,
      identity.provider,
      identity.accountScope,
      normalizeConversationId(identity.providerConversationId),
      identity.providerItemId,
      identity.localItemId,
      ...scopePredicate.params,
    ) as Array<{ locator_uri: string | null }>;
    return rows.length === 1 ? rows[0]!.locator_uri ?? undefined : undefined;
  }

  /**
   * Reads a bounded set of live conversation-title candidates without
   * scanning `items`. Interpretation and ranking belong to the declared
   * chat-family codec; this shared store read only applies its FTS5 index,
   * tombstone exclusion, exact provider/account narrowing, and a hard row cap.
   */
  conversationTitleCandidates(
    lookupTerms: readonly string[],
    accountScope?: string,
    provider?: string,
  ): {
    candidates: Array<{ conversationId: string; title: string }>;
    truncated: boolean;
  } {
    const titleQuery = connectorStoreTitleFtsQuery(lookupTerms);
    if (!titleQuery) return { candidates: [], truncated: false };
    const selectedAccount = normalizeOptionalAccountScope(accountScope);
    const selectedProvider = normalizeBoundedFilterString(provider, 'provider');
    const rows = this.db.query(`
      SELECT DISTINCT i.provider_conversation_id, i.title
      FROM connector_store_fts
      JOIN items i ON i.item_pk = connector_store_fts.item_pk
      WHERE connector_store_fts MATCH ?
        AND i.tombstoned = 0
        AND i.provider_conversation_id IS NOT NULL
        AND i.provider_conversation_id <> ''
        AND i.title IS NOT NULL
        AND i.title <> ''
        ${selectedAccount ? 'AND i.account_scope = ?' : ''}
        ${selectedProvider ? 'AND i.provider = ?' : ''}
      LIMIT ?
    `).all(
      titleQuery,
      ...(selectedAccount ? [selectedAccount] : []),
      ...(selectedProvider ? [selectedProvider] : []),
      MAX_CONVERSATION_TITLE_LOOKUP_ROWS + 1,
    ) as Array<{ provider_conversation_id: string; title: string }>;
    return {
      candidates: rows.slice(0, MAX_CONVERSATION_TITLE_LOOKUP_ROWS).map((row) => ({
        conversationId: row.provider_conversation_id,
        title: row.title,
      })),
      truncated: rows.length > MAX_CONVERSATION_TITLE_LOOKUP_ROWS,
    };
  }

  /**
   * Counts active indexed chat items by stable sender identity. This is a
   * source-neutral metadata capability: it never reads chunks or source text,
   * and it states its population precisely instead of claiming provider-wide
   * completeness the local store cannot prove.
   */
  senderAggregation(options: ConnectorStoreSenderAggregationOptions): ConnectorStoreSenderAggregation {
    if (this.family !== 'chat') {
      throw new Error('Connector store sender aggregation is available only for chat-family stores.');
    }
    const accountScope = normalizeOptionalAccountScope(options.accountScope)!;
    const conversationId = normalizeBoundedFilterString(options.conversationId, 'conversation id');
    if (!conversationId) throw new Error('Connector store sender aggregation requires a conversation id.');
    const provider = normalizeBoundedFilterString(options.provider, 'provider');
    const maxSenders = options.maxSenders ?? 10;
    if (!Number.isInteger(maxSenders) || maxSenders < 1 || maxSenders > 100) {
      throw new Error('Connector store sender aggregation maxSenders must be an integer from 1 to 100.');
    }
    const providerClause = provider ? 'AND i.provider = ?' : '';
    const scopeParams = [accountScope, conversationId, ...(provider ? [provider] : [])];
    const summary = this.db.query(`
      SELECT
        COUNT(*) AS indexed_items,
        SUM(CASE WHEN i.sender_id IS NULL OR TRIM(i.sender_id) = '' THEN 1 ELSE 0 END) AS unattributed_items,
        SUM(CASE WHEN i.authored_at IS NULL OR TRIM(i.authored_at) = '' THEN 1 ELSE 0 END) AS items_without_authored_at,
        COUNT(DISTINCT CASE WHEN i.sender_id IS NOT NULL AND TRIM(i.sender_id) <> '' THEN i.sender_id END) AS distinct_senders,
        MIN(i.authored_at) AS authored_at_first,
        MAX(i.authored_at) AS authored_at_last
      FROM items i
      WHERE i.tombstoned = 0
        AND i.account_scope = ?
        AND i.provider_conversation_id = ?
        ${providerClause}
    `).get(...scopeParams) as {
      indexed_items: number;
      unattributed_items: number | null;
      items_without_authored_at: number | null;
      distinct_senders: number;
      authored_at_first: string | null;
      authored_at_last: string | null;
    };
    const rows = this.db.query(`
      WITH scoped AS (
        SELECT i.item_pk, i.sender_id, i.sender_label, i.authored_at
        FROM items i
        WHERE i.tombstoned = 0
          AND i.account_scope = ?
          AND i.provider_conversation_id = ?
          ${providerClause}
          AND i.sender_id IS NOT NULL
          AND TRIM(i.sender_id) <> ''
      ), ranked_labels AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY sender_id
          ORDER BY
            CASE WHEN sender_label IS NOT NULL AND TRIM(sender_label) <> '' THEN 0 ELSE 1 END,
            CASE WHEN authored_at IS NULL THEN 1 ELSE 0 END,
            authored_at DESC,
            item_pk DESC
        ) AS label_rank
        FROM scoped
      )
      SELECT
        sender_id,
        MAX(CASE WHEN label_rank = 1 THEN sender_label END) AS sender_label,
        COUNT(*) AS message_count,
        MIN(authored_at) AS authored_at_first,
        MAX(authored_at) AS authored_at_last
      FROM ranked_labels
      GROUP BY sender_id
      ORDER BY message_count DESC, sender_id ASC
      LIMIT ?
    `).all(...scopeParams, maxSenders) as Array<{
      sender_id: string;
      sender_label: string | null;
      message_count: number;
      authored_at_first: string | null;
      authored_at_last: string | null;
    }>;
    const unattributedItems = summary.unattributed_items ?? 0;
    const itemsWithoutAuthoredAt = summary.items_without_authored_at ?? 0;
    return {
      population: 'indexed_active_items',
      ranking: unattributedItems === 0 ? 'exact' : 'approximate',
      senders: rows.map((row) => ({
        senderId: row.sender_id,
        displayLabel: safeSenderDisplayLabel(row.sender_label),
        messageCount: row.message_count,
        ...(row.authored_at_first ? { authoredAtFirst: row.authored_at_first } : {}),
        ...(row.authored_at_last ? { authoredAtLast: row.authored_at_last } : {}),
      })),
      coverage: {
        providerTraversal: 'not_asserted',
        senderAttribution: unattributedItems === 0 ? 'complete' : 'partial',
        dateCoverage: itemsWithoutAuthoredAt === 0 ? 'complete' : 'partial',
        indexedItems: summary.indexed_items,
        attributedItems: summary.indexed_items - unattributedItems,
        unattributedItems,
        itemsWithoutAuthoredAt,
        distinctSenders: summary.distinct_senders,
        omittedSenders: Math.max(0, summary.distinct_senders - rows.length),
        ...(summary.authored_at_first ? { authoredAtFirst: summary.authored_at_first } : {}),
        ...(summary.authored_at_last ? { authoredAtLast: summary.authored_at_last } : {}),
      },
      policy: {
        readOnly: true,
        rawSourceExposed: false,
        sourceTextReturned: false,
      },
    };
  }

  itemPresence(identity: SourceItemIdentity): ConnectorStoreItemPresence {
    const row = this.db.query(`
      SELECT source_version, content_hash, tombstoned
      FROM items
      WHERE provider = ? AND account_scope = ?
        AND normalized_conversation = ? AND provider_item_id = ?
      LIMIT 1
    `).get(
      identity.provider,
      identity.accountScope,
      normalizeConversationId(identity.providerConversationId),
      identity.providerItemId,
    ) as { source_version: string | null; content_hash: string | null; tombstoned: number } | null;
    if (!row || row.tombstoned === 1) return { active: false };
    return {
      active: true,
      ...(row.source_version ? { sourceVersion: row.source_version } : {}),
      ...(row.content_hash ? { contentHash: row.content_hash } : {}),
    };
  }

  locatorIdentityIndexStatus(): ConnectorStoreLocatorIdentityIndexStatus {
    const state = this.locatorIdentityIndexState();
    const indexed = this.db.query(`
      SELECT COUNT(*) AS count FROM item_locator_identities
    `).get() as { count: number };
    return {
      state: state.completed ? 'ready' : 'backfill_required',
      cursorItemPk: state.cursorItemPk,
      indexedItems: Number(indexed.count),
    };
  }

  /**
   * The durable cursor/completion pair alone. Separate from the public status
   * projection because that projection COUNTs the whole indexed table: fine for
   * an operator receipt, ruinous for a per-deletion gate or a convergence loop
   * that would otherwise pay one whole-index scan per bounded window.
   */
  private locatorIdentityIndexState(): { cursorItemPk: number; completed: boolean } {
    const state = this.db.query(`
      SELECT cursor_item_pk, completed
      FROM locator_identity_index_state
      WHERE singleton = 1
    `).get() as { cursor_item_pk: number; completed: number } | null;
    if (!state) throw new Error('Connector store locator identity index state is missing.');
    return { cursorItemPk: state.cursor_item_pk, completed: state.completed === 1 };
  }

  /**
   * Populate the source-neutral locator identity index in bounded item-pk
   * windows. The migration only creates the empty indexed projection and its
   * triggers; this explicit pass is what keeps a multi-gigabyte store upgrade
   * out of worker boot. Each call is one short transaction and is restartable.
   */
  backfillLocatorIdentityIndex(
    options: { maxItems?: number } = {},
  ): ConnectorStoreLocatorIdentityBackfillSummary {
    const maxItems = normalizeLocatorIdentityBackfillItems(options.maxItems);
    const before = this.locatorIdentityIndexStatus();
    if (before.state === 'ready') {
      return {
        state: 'ready',
        scannedItems: 0,
        indexedItems: before.indexedItems,
        cursorItemPk: before.cursorItemPk,
      };
    }
    const scannedItems = this.advanceLocatorIdentityIndexWindow(before.cursorItemPk, maxItems);
    const after = this.locatorIdentityIndexStatus();
    return {
      state: after.state,
      scannedItems,
      indexedItems: after.indexedItems,
      cursorItemPk: after.cursorItemPk,
    };
  }

  /**
   * Converge the locator identity index from inside a long-running pass.
   *
   * The migration seeds an upgraded store gated and empty on purpose, but
   * nothing in the product ever ran the bounded backfill, so the operator
   * script was the only way out of that state. This walks the same bounded
   * windows and yields between them, which keeps the shared event loop
   * responsive while the store heals itself. Every window either advances the
   * durable item-primary-key cursor or marks the projection complete, so the
   * walk terminates; `maxWindows` bounds one call's work, and the durable
   * cursor lets the next call continue where it stopped.
   */
  async ensureLocatorIdentityIndexReady(
    options: { maxItems?: number; maxWindows?: number } = {},
  ): Promise<ConnectorStoreLocatorIdentityBackfillSummary> {
    const maxItems = normalizeLocatorIdentityBackfillItems(options.maxItems);
    const maxWindows = normalizeLocatorIdentityConvergenceWindows(options.maxWindows);
    let state = this.locatorIdentityIndexState();
    let scannedItems = 0;
    for (let window = 0; !state.completed && window < maxWindows; window += 1) {
      if (window > 0) await yieldConnectorSyncTurn();
      scannedItems += this.advanceLocatorIdentityIndexWindow(state.cursorItemPk, maxItems);
      state = this.locatorIdentityIndexState();
    }
    const after = this.locatorIdentityIndexStatus();
    return {
      state: after.state,
      scannedItems,
      indexedItems: after.indexedItems,
      cursorItemPk: after.cursorItemPk,
    };
  }

  /**
   * One bounded item-primary-key window, returning only the rows it scanned.
   * Counting the indexed projection is left to the caller so a convergence
   * loop does not pay a whole-index COUNT per window.
   */
  private advanceLocatorIdentityIndexWindow(cursorItemPk: number, maxItems: number): number {
    const rows = this.db.query(`
      SELECT item_pk
      FROM items
      WHERE item_pk > ?
      ORDER BY item_pk
      LIMIT ?
    `).all(cursorItemPk, maxItems) as Array<{ item_pk: number }>;
    if (rows.length === 0) {
      this.db.query(`
        UPDATE locator_identity_index_state
        SET completed = 1
        WHERE singleton = 1
      `).run();
      return 0;
    }
    const lastItemPk = rows.at(-1)!.item_pk;
    const complete = this.db.query(`
      SELECT NOT EXISTS(
        SELECT 1 FROM items WHERE item_pk > ? LIMIT 1
      ) AS complete
    `).get(lastItemPk) as { complete: number };
    this.db.transaction(() => {
      // The triggers already keep concurrent writes correct. Replacing this
      // bounded pk window makes a replay idempotent and also removes any stale
      // projection a previously interrupted maintenance build left behind.
      this.db.query(`
        DELETE FROM item_locator_identities
        WHERE item_pk > ? AND item_pk <= ?
      `).run(cursorItemPk, lastItemPk);
      this.db.query(`
        INSERT INTO item_locator_identities (
          item_pk, provider, account_scope, normalized_conversation,
          normalized_locator
        )
        SELECT
          item_pk, provider, account_scope, normalized_conversation,
          LOWER(locator_uri)
        FROM items
        WHERE item_pk > ? AND item_pk <= ?
          AND tombstoned = 0
          AND locator_uri IS NOT NULL
      `).run(cursorItemPk, lastItemPk);
      this.db.query(`
        UPDATE locator_identity_index_state
        SET cursor_item_pk = ?, completed = ?
        WHERE singleton = 1
      `).run(lastItemPk, Number(complete.complete === 1));
    })();
    return rows.length;
  }

  /**
   * Resolve one active item by its provider locator.
   *
   * Some providers publish deletion events with the old path but without the
   * stable item id used by their create/update events. The source connector
   * may use this narrow, source-neutral lookup to recover that identity before
   * emitting the tombstone. Ambiguity fails closed: deleting the wrong item is
   * worse than retaining one row and reporting the provider event as a gap.
   */
  activeIdentityForLocator(input: {
    provider: string;
    accountScope: string;
    locatorUri: string;
  }): SourceItemIdentity | undefined {
    // This runs once for every path-only deletion. Do not call the public
    // status projection here: its indexed-row COUNT is useful to operators,
    // but would turn the hot lookup back into one whole-index scan per event.
    if (!this.locatorIdentityIndexState().completed) {
      throw new ConnectorStoreLocatorIdentityIndexNotReadyError();
    }
    const rows = this.db.query(`
      SELECT
        i.provider_item_id, i.provider_file_id, i.local_item_id,
        i.source_version
      FROM item_locator_identities locator
      JOIN items i ON i.item_pk = locator.item_pk
      WHERE locator.provider = ?
        AND locator.account_scope = ?
        AND locator.normalized_conversation = ''
        AND locator.normalized_locator = LOWER(?)
        AND i.tombstoned = 0
      LIMIT 2
    `).all(
      input.provider,
      input.accountScope,
      input.locatorUri,
    ) as Array<{
      provider_item_id: string;
      provider_file_id: string | null;
      local_item_id: string;
      source_version: string | null;
    }>;
    if (rows.length !== 1) return undefined;
    const row = rows[0]!;
    return {
      family: this.family,
      provider: input.provider,
      accountScope: input.accountScope,
      providerItemId: row.provider_item_id,
      ...(row.provider_file_id ? { providerFileId: row.provider_file_id } : {}),
      localItemId: row.local_item_id,
      ...(row.source_version ? { sourceVersion: row.source_version } : {}),
    };
  }

  /**
   * The listing-path variant of {@link activeIdentityForLocator}: an index that
   * has not finished its bounded backfill answers "no unambiguous match"
   * instead of throwing. A provider deletion event is one item, and a listing
   * pass that dies on it is far worse than one preserved row — the failed run
   * keeps no cursor, so the next pass replays the same deletion from the same
   * provider page and the source stalls forever. The unresolved deletion is
   * still counted and reported by the sync spine, and
   * {@link ensureLocatorIdentityIndexReady} converges the index so a later pass
   * applies it.
   */
  activeIdentityForLocatorIfIndexed(input: {
    provider: string;
    accountScope: string;
    locatorUri: string;
  }): SourceItemIdentity | undefined {
    if (!this.locatorIdentityIndexState().completed) return undefined;
    return this.activeIdentityForLocator(input);
  }

  activeItemForLocator(input: {
    provider: string;
    accountScope: string;
    locatorUri: string;
  }): ConnectorStoreActiveLocatorItem | undefined {
    const identity = this.activeIdentityForLocator(input);
    if (!identity) return undefined;
    const row = this.db.query(`
      SELECT trust_tier, locator_uri
      FROM items
      WHERE provider = ?
        AND account_scope = ?
        AND local_item_id = ?
        AND tombstoned = 0
      LIMIT 1
    `).get(input.provider, input.accountScope, identity.localItemId) as {
      trust_tier: string;
      locator_uri: string | null;
    } | null;
    if (!row?.locator_uri) return undefined;
    return {
      identity,
      trustTier: trustTierFromRow(row.trust_tier),
      locatorUri: row.locator_uri,
    };
  }

  /**
   * Resolve the complete active identity behind the extraction factory's
   * durable join key. Conversation-scoped chat items need this because the
   * generic extraction ref deliberately carries no family-specific address.
   * Ambiguity fails closed.
   */
  activeIdentityForLocalItemId(input: {
    provider: string;
    accountScope: string;
    providerItemId: string;
    localItemId: string;
  }): SourceItemIdentity | undefined {
    const rows = this.db.query(`
      SELECT family, provider_item_id, provider_thread_id,
             provider_conversation_id, provider_file_id, provider_event_id,
             local_item_id, source_version
      FROM items
      WHERE provider = ?
        AND account_scope = ?
        AND provider_item_id = ?
        AND local_item_id = ?
        AND tombstoned = 0
      LIMIT 2
    `).all(
      input.provider,
      input.accountScope,
      input.providerItemId,
      input.localItemId,
    ) as Array<{
      family: SourceItemIdentity['family'];
      provider_item_id: string;
      provider_thread_id: string | null;
      provider_conversation_id: string | null;
      provider_file_id: string | null;
      provider_event_id: string | null;
      local_item_id: string;
      source_version: string | null;
    }>;
    if (rows.length !== 1) return undefined;
    const row = rows[0]!;
    return {
      family: row.family,
      provider: input.provider,
      accountScope: input.accountScope,
      providerItemId: row.provider_item_id,
      ...(row.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {}),
      ...(row.provider_conversation_id ? { providerConversationId: row.provider_conversation_id } : {}),
      ...(row.provider_file_id ? { providerFileId: row.provider_file_id } : {}),
      ...(row.provider_event_id ? { providerEventId: row.provider_event_id } : {}),
      localItemId: row.local_item_id,
      ...(row.source_version ? { sourceVersion: row.source_version } : {}),
    };
  }

  /**
   * The live row's preservable metadata, or undefined when the identity has no
   * active row. See ConnectorStoreItemMetadataSnapshot for why a caller that
   * re-emits an item it did not fully construct has to read this first.
   */
  itemMetadataSnapshot(identity: SourceItemIdentity): ConnectorStoreItemMetadataSnapshot | undefined {
    const row = this.db.query(`
      SELECT source_version, content_hash, mime_type, title, locator_uri,
             authored_at, updated_at, tombstoned
      FROM items
      WHERE provider = ? AND account_scope = ?
        AND normalized_conversation = ? AND provider_item_id = ?
      LIMIT 1
    `).get(
      identity.provider,
      identity.accountScope,
      normalizeConversationId(identity.providerConversationId),
      identity.providerItemId,
    ) as {
      source_version: string | null;
      content_hash: string | null;
      mime_type: string | null;
      title: string | null;
      locator_uri: string | null;
      authored_at: string | null;
      updated_at: string | null;
      tombstoned: number;
    } | null;
    if (!row || row.tombstoned === 1) return undefined;
    return {
      ...(row.source_version ? { sourceVersion: row.source_version } : {}),
      ...(row.content_hash ? { contentHash: row.content_hash } : {}),
      ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      ...(row.title ? { name: row.title } : {}),
      ...(row.locator_uri ? { locatorUri: row.locator_uri } : {}),
      ...(row.authored_at ? { authoredAt: row.authored_at } : {}),
      ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
    };
  }

  /**
   * Bounded, cursored enumeration of non-tombstoned items an extraction lane
   * may want bytes for. Read-only, no schema change: everything here comes off
   * columns the sync already writes.
   *
   * Ordering is by `item_pk` and the cursor is the last row EXAMINED rather
   * than the last row returned, which matters once a media-type filter is in
   * play: a page can skip over many rows to find its matches, and resuming
   * from the last match would re-scan every one of them on the next call.
   */
  extractionCandidates(
    options: ConnectorStoreExtractionCandidateOptions,
  ): ConnectorStoreExtractionCandidatePage {
    const limit = normalizeExtractionCandidateLimit(options.limit);
    const matchesMimeType = buildMimeTypeMatcher(options.mimeTypes);
    const accountScope = normalizeOptionalAccountScope(options.accountScope);
    let lastExaminedPk = normalizeExtractionCandidateCursor(options.cursor);

    // With no media-type filter every scanned row is a match, so one query of
    // exactly `limit` rows is enough. With a filter the scan has to be able to
    // run past non-matching rows, hence a wider window.
    const scanBatch = matchesMimeType ? Math.max(limit, 256) : limit;
    const query = this.db.query(`
      SELECT
        i.item_pk, i.family, i.provider, i.account_scope, i.provider_item_id,
        i.provider_thread_id, i.provider_conversation_id, i.provider_file_id,
        i.provider_event_id, i.local_item_id, i.source_version, i.title,
        i.mime_type, i.locator_uri, i.content_hash, i.trust_tier,
        (SELECT COUNT(*) FROM chunks c WHERE c.item_pk = i.item_pk) AS stored_chunks
      FROM items i
      WHERE i.tombstoned = 0
        AND i.item_pk > ?
        AND (? IS NULL OR i.account_scope = ?)
        AND (? = 0 OR NOT EXISTS (SELECT 1 FROM chunks c WHERE c.item_pk = i.item_pk))
      ORDER BY i.item_pk
      LIMIT ?
    `);

    const candidates: ConnectorStoreExtractionCandidate[] = [];
    let skippedByDisposition = 0;
    let exhausted = false;
    while (candidates.length < limit) {
      const rows = query.all(
        lastExaminedPk,
        accountScope ?? null,
        accountScope ?? null,
        options.withoutChunksOnly === true ? 1 : 0,
        scanBatch,
      ) as ConnectorStoreExtractionCandidateRow[];
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      for (const row of rows) {
        lastExaminedPk = row.item_pk;
        if (matchesMimeType && !matchesMimeType(row.mime_type)) continue;
        // A candidate is a proposal to SPEND: a download, an extractor, often a
        // VLM call. An item the owner's configuration says must never be read
        // is not a candidate, and the cheapest place to say so is before the
        // job exists rather than at the sink after the money is gone.
        //
        // Only a MATCHED decision filters. An unevaluable one is left alone on
        // purpose: at this seam the conservative direction would be a new,
        // silent skip of items no rule actually names, and the store already
        // reports unevaluable rows as debt for the owner to settle deliberately.
        const decision = this.exclusions.evaluatePath(row.locator_uri);
        if (decision.disposition !== 'admit' && !sourceExclusionOutcomeIsUnevaluable(decision.outcome)) {
          skippedByDisposition += 1;
          continue;
        }
        candidates.push(extractionCandidateFromRow(row));
        if (candidates.length === limit) break;
      }
      if (candidates.length === limit) break;
      if (rows.length < scanBatch) {
        exhausted = true;
        break;
      }
    }

    return {
      candidates,
      done: exhausted,
      ...(skippedByDisposition > 0 ? { skippedByDisposition } : {}),
      ...(exhausted ? {} : { nextCursor: String(lastExaminedPk) }),
    };
  }

  itemOwnerPresent(
    identity: SourceItemIdentity,
    connectorIdValue: string,
    ownershipKind: ConnectorStoreOwnershipKind,
  ): boolean {
    const connectorId = requireNonEmpty(connectorIdValue, 'Connector owner id');
    const row = this.db.query(`
      SELECT 1 AS present
      FROM items i
      JOIN item_owners owner ON owner.item_pk = i.item_pk
      WHERE i.provider = ? AND i.account_scope = ?
        AND i.normalized_conversation = ? AND i.provider_item_id = ?
        AND i.tombstoned = 0
        AND owner.connector_id = ? AND owner.ownership_kind = ?
      LIMIT 1
    `).get(
      identity.provider,
      identity.accountScope,
      normalizeConversationId(identity.providerConversationId),
      identity.providerItemId,
      connectorId,
      ownershipKind,
    ) as { present: number } | null;
    return row?.present === 1;
  }

  verifyItemRepresentation(
    expectation: ConnectorStoreItemRepresentationExpectation,
  ): boolean {
    return this.itemRepresentationCoverage(expectation).complete;
  }

  itemRepresentationCoverage(
    expectation: ConnectorStoreItemRepresentationExpectation,
  ): ConnectorStoreItemRepresentationCoverage {
    const identity = expectation.sourceItem;
    const item = this.db.query(`
      SELECT item_pk, source_version, content_hash, search_text, tombstoned
      FROM items
      WHERE provider = ? AND account_scope = ?
        AND normalized_conversation = ? AND provider_item_id = ?
      LIMIT 1
    `).get(
      identity.provider,
      identity.accountScope,
      normalizeConversationId(identity.providerConversationId),
      identity.providerItemId,
    ) as {
      item_pk: number;
      source_version: string | null;
      content_hash: string | null;
      search_text: string | null;
      tombstoned: number;
    } | null;
    if (!item
      || item.tombstoned === 1
      || item.content_hash !== expectation.contentHash
      || (
        expectation.sourceVersion !== undefined
        && item.source_version !== expectation.sourceVersion
      )) {
      return { chunksIndexed: 0, chunksEmbeddingCurrent: 0, complete: false };
    }
    const chunks = this.db.query(`
      SELECT c.chunk_index, c.content_hash,
        CASE WHEN ? IS NULL THEN 1 ELSE EXISTS (
          SELECT 1 FROM chunk_embeddings embedding
          WHERE embedding.chunk_pk = c.chunk_pk
            AND embedding.model_id = ?
            AND embedding.content_hash = c.embedding_input_hash
        ) END AS embedding_current
      FROM chunks c
      WHERE c.item_pk = ?
      ORDER BY c.chunk_index
    `).all(
      expectation.embeddingModelId ?? null,
      expectation.embeddingModelId ?? null,
      item.item_pk,
    ) as Array<{
      chunk_index: number;
      content_hash: string;
      embedding_current: number;
    }>;
    const exactChunks = chunks.filter((chunk) => (
      chunk.chunk_index >= 0
      && chunk.chunk_index < expectation.chunkContentHashes.length
      && chunk.content_hash === expectation.chunkContentHashes[chunk.chunk_index]
    ));
    const chunksIndexed = exactChunks.length;
    const chunksEmbeddingCurrent = exactChunks.filter(
      (chunk) => chunk.embedding_current === 1,
    ).length;
    const expectedFtsRows = Math.max(1, chunks.length);
    const ftsRows = (this.db.query(`
      SELECT COUNT(*) AS count
      FROM connector_store_fts_rows
      WHERE item_pk = ?
    `).get(item.item_pk) as { count: number }).count;
    const searchText = item.search_text ?? '';
    const searchTokensPresent = (expectation.requiredSearchTokens ?? []).every((token) => (
      typeof token === 'string'
      && token.length > 0
      && token.length <= 8_192
      && searchText.includes(token)
    ));
    const embeddingsComplete = expectation.embeddingModelId === undefined
      || chunksEmbeddingCurrent === expectation.chunkContentHashes.length;
    return {
      chunksIndexed,
      chunksEmbeddingCurrent,
      complete:
        chunks.length === expectation.chunkContentHashes.length
        && chunksIndexed === expectation.chunkContentHashes.length
        && embeddingsComplete
        && ftsRows === expectedFtsRows
        && searchTokensPresent,
    };
  }

  currentItemRepresentationCoverage(
    identity: SourceItemIdentity,
    embeddingModelId?: string,
  ): ConnectorStoreCurrentItemRepresentationCoverage {
    const item = this.db.query(`
      SELECT item_pk, source_version, content_hash, tombstoned
      FROM items
      WHERE provider = ? AND account_scope = ?
        AND normalized_conversation = ? AND provider_item_id = ?
      LIMIT 1
    `).get(
      identity.provider,
      identity.accountScope,
      normalizeConversationId(identity.providerConversationId),
      identity.providerItemId,
    ) as {
      item_pk: number;
      source_version: string | null;
      content_hash: string | null;
      tombstoned: number;
    } | null;
    if (!item || item.tombstoned === 1 || !item.content_hash) {
      return {
        chunksIndexed: 0,
        chunksEmbeddingCurrent: 0,
        representationComplete: false,
        embeddingsComplete: false,
      };
    }
    const chunkRows = this.db.query(`
      SELECT content_hash, bounded_text
      FROM chunks
      WHERE item_pk = ?
      ORDER BY chunk_index
    `).all(item.item_pk) as Array<{ content_hash: string; bounded_text: string }>;
    // Self-consistency must be grounded in actual chunk text, not row-to-row
    // echoes: each chunk hash is recomputed from its own bounded_text (the
    // store's write-time convention, hashString). A zero-chunk item is
    // incoherent here — every canonical replay item carries at least one
    // text chunk. The item-level hash covers connector-side fields (title,
    // url, folders) that are not reconstructable offline; recomputing it
    // needs a connector-provided derivation (registered follow-up).
    if (chunkRows.length === 0) {
      return {
        chunksIndexed: 0,
        chunksEmbeddingCurrent: 0,
        representationComplete: false,
        embeddingsComplete: false,
      };
    }
    const chunkTextCoherent = chunkRows.every((chunk) =>
      createHash('sha256').update(chunk.bounded_text).digest('hex') === chunk.content_hash);
    if (!chunkTextCoherent) {
      return {
        chunksIndexed: 0,
        chunksEmbeddingCurrent: 0,
        representationComplete: false,
        embeddingsComplete: false,
      };
    }
    const chunkContentHashes = chunkRows.map((chunk) => chunk.content_hash);
    const expectation = {
      sourceItem: identity,
      ...(item.source_version ? { sourceVersion: item.source_version } : {}),
      contentHash: item.content_hash,
      chunkContentHashes,
    };
    const representation = this.itemRepresentationCoverage(expectation);
    const withEmbeddings = embeddingModelId
      ? this.itemRepresentationCoverage({ ...expectation, embeddingModelId })
      : representation;
    return {
      chunksIndexed: representation.chunksIndexed,
      chunksEmbeddingCurrent: withEmbeddings.chunksEmbeddingCurrent,
      representationComplete: representation.complete,
      embeddingsComplete: withEmbeddings.complete,
    };
  }

  /**
   * Set-wise corpus integrity audit: active chunks must hash to their stored
   * content hashes, each active item must own exactly max(1, chunk count) FTS
   * mappings that resolve to real virtual-table rows, each live chunk must be
   * the target of one of those mappings, and the selected model must carry an
   * embedding whose currency hash matches each chunk input.
   *
   * The LEFT JOIN streams at least one row per active item, including items
   * with zero chunks, so a six-figure corpus is never materialized in memory.
   * Only counts and a bounded sample of opaque local ids leave this method;
   * titles, paths, chunk text, and vectors do not.
   */
  verifyCorpusIntegrity(
    options: ConnectorStoreCorpusIntegrityOptions,
  ): ConnectorStoreCorpusIntegrityReport {
    const embeddingModelId = requireNonEmpty(
      options.embeddingModelId,
      'Connector store integrity embedding model id',
    );
    const sampleLimit = normalizeIntegritySampleLimit(options.sampleLimit);
    const counts = {
      itemsWithFtsDeficiency: 0,
      chunksWithoutCurrentEmbeddings: 0,
      itemsWithChunkHashDisagreement: 0,
    };
    const samples = {
      ftsDeficientLocalItemIds: [] as string[],
      missingEmbeddingLocalItemIds: [] as string[],
      chunkHashDisagreementLocalItemIds: [] as string[],
    };
    const rows = this.db.query(`
      WITH fts_counts AS (
        SELECT owned.item_pk, COUNT(*) AS fts_rows
        FROM connector_store_fts_rows owned
        JOIN connector_store_fts fts ON fts.rowid = owned.fts_rowid
        GROUP BY owned.item_pk
      )
      SELECT
        i.item_pk,
        i.local_item_id,
        c.chunk_pk,
        c.bounded_text,
        c.content_hash,
        COALESCE(fts_counts.fts_rows, 0) AS fts_rows,
        CASE WHEN c.chunk_pk IS NULL THEN 1 ELSE EXISTS (
          SELECT 1
          FROM connector_store_fts_rows owned
          JOIN connector_store_fts fts ON fts.rowid = owned.fts_rowid
          WHERE owned.item_pk = i.item_pk AND owned.chunk_pk = c.chunk_pk
        ) END AS chunk_fts_mapped,
        CASE WHEN c.chunk_pk IS NULL THEN 1 ELSE EXISTS (
          SELECT 1
          FROM chunk_embeddings embedding
          WHERE embedding.chunk_pk = c.chunk_pk
            AND embedding.model_id = ?
            AND embedding.content_hash = c.embedding_input_hash
        ) END AS embedding_current
      FROM items i
      LEFT JOIN chunks c ON c.item_pk = i.item_pk
      LEFT JOIN fts_counts ON fts_counts.item_pk = i.item_pk
      WHERE i.tombstoned = 0
      ORDER BY i.item_pk, c.chunk_index
    `).iterate(embeddingModelId) as Iterable<{
      item_pk: number;
      local_item_id: string;
      chunk_pk: number | null;
      bounded_text: string | null;
      content_hash: string | null;
      fts_rows: number;
      chunk_fts_mapped: number;
      embedding_current: number;
    }>;

    let currentItemPk: number | undefined;
    let currentLocalItemId = '';
    let currentFtsRows = 0;
    let currentChunkCount = 0;
    let currentChunkUnmapped = false;
    let currentMissingEmbedding = false;
    let currentHashDisagreement = false;
    const finishItem = (): void => {
      if (currentItemPk === undefined) return;
      // Both conditions are load-bearing and neither implies the other.
      // Count equality catches missing and surplus rows; the per-chunk
      // mapping catches a crash window in which chunks were replaced (new
      // chunk_pks, same cardinality) but refreshFtsForItem never ran, so
      // every FTS row exists yet dangles at deleted chunks and search
      // serves the pre-edit text. The mapping EXISTS above correlates on
      // item_pk as well as chunk_pk on purpose: chunk_pk has no index of
      // its own, so without the item correlation the planner scans the
      // FTS mapping per chunk row and the audit goes quadratic at
      // six-figure corpus scale. Dangling mappings share the item, so the
      // narrowed probe still detects the crash window — and additionally
      // flags a mapping that points at another item's chunk.
      if (currentChunkUnmapped || currentFtsRows !== Math.max(1, currentChunkCount)) {
        counts.itemsWithFtsDeficiency += 1;
        if (samples.ftsDeficientLocalItemIds.length < sampleLimit) {
          samples.ftsDeficientLocalItemIds.push(currentLocalItemId);
        }
      }
      if (
        currentMissingEmbedding
        && samples.missingEmbeddingLocalItemIds.length < sampleLimit
      ) {
        samples.missingEmbeddingLocalItemIds.push(currentLocalItemId);
      }
      if (currentHashDisagreement) {
        counts.itemsWithChunkHashDisagreement += 1;
        if (samples.chunkHashDisagreementLocalItemIds.length < sampleLimit) {
          samples.chunkHashDisagreementLocalItemIds.push(currentLocalItemId);
        }
      }
    };

    for (const row of rows) {
      if (currentItemPk !== row.item_pk) {
        finishItem();
        currentItemPk = row.item_pk;
        currentLocalItemId = row.local_item_id;
        currentFtsRows = row.fts_rows;
        currentChunkCount = 0;
        currentChunkUnmapped = false;
        currentMissingEmbedding = false;
        currentHashDisagreement = false;
      }
      if (row.chunk_pk === null) continue;
      currentChunkCount += 1;
      if (row.chunk_fts_mapped !== 1) {
        currentChunkUnmapped = true;
      }
      if (row.embedding_current !== 1) {
        counts.chunksWithoutCurrentEmbeddings += 1;
        currentMissingEmbedding = true;
      }
      if (row.bounded_text === null || hashString(row.bounded_text) !== row.content_hash) {
        currentHashDisagreement = true;
      }
    }
    finishItem();

    return {
      corpusId: this.corpusId,
      embeddingModelId,
      counts,
      samples,
      policy: {
        countsOnly: true,
        rawSourceExposed: false,
        sourceTextReturned: false,
        trustDomain: this.trustDomain,
        storage: 'local_sqlite',
      },
    };
  }

  restoreItemRepresentations(
    options: ConnectorStoreRepresentationRestoreOptions,
  ): ConnectorStoreRepresentationRestoreSummary {
    const syncConnectorId = requireNonEmpty(
      options.syncConnectorId,
      'Representation restore sync connector id',
    );
    const ownerConnectorId = requireNonEmpty(
      options.ownerConnectorId,
      'Representation restore owner connector id',
    );
    const maxChunkChars = normalizeMaxChunkChars(options.maxChunkChars);
    const seenIdentities = new Set<string>();
    for (const record of options.items) {
      const item = record.item;
      if (item.identity.family !== this.family) {
        throw new Error('Representation restore item family does not match the connector store.');
      }
      if (!sameSourceItemIdentity(item.identity, record.expectation.sourceItem)) {
        throw new Error('Representation restore expectation identity does not match its item.');
      }
      const key = sourceItemIdentityKey(item.identity);
      if (seenIdentities.has(key)) {
        throw new Error('Representation restore contains a duplicate item identity.');
      }
      seenIdentities.add(key);
    }

    return this.db.transaction(() => {
      const syncRunId = `connector-representation-restore-${randomUUID()}`;
      const startedAt = this.now().toISOString();
      this.db.query(`
        INSERT INTO sync_runs (
          sync_run_id, corpus_id, connector_id, status, cursor,
          items_seen, items_indexed, started_at, completed_at
        ) VALUES (?, ?, ?, 'running', NULL, ?, 0, ?, NULL)
      `).run(
        syncRunId,
        this.corpusId,
        syncConnectorId,
        options.items.length,
        startedAt,
      );

      let itemsRestored = 0;
      let itemsUnchanged = 0;
      let itemsSkippedByOwner = 0;
      let itemsExcluded = 0;
      let itemsMetadataOnly = 0;
      let itemsSkippedTombstoned = 0;
      let itemsSkippedStaleClaim = 0;
      let chunksAwaitingEmbedding = 0;
      const writeClaim = options.writeClaim
        ? normalizeConnectorStoreItemWriteClaim(options.writeClaim)
        : undefined;
      const restoredProviderItemIds: string[] = [];
      const skippedProviderItemIds: string[] = [];

      for (const record of options.items) {
        const item = record.item;
        // Restore re-admits an item's chunks after extraction, so it is a
        // second front door. It is closed the same way and before the identity
        // lookup: an excluded item is counted and skipped rather than raising
        // the "targeted store item is missing" error the gate would otherwise
        // produce, which would read as corruption instead of policy.
        const disposition = this.exclusions.evaluateMetadata(item.metadata);
        if (disposition.excluded) {
          itemsExcluded += 1;
          skippedProviderItemIds.push(item.identity.providerItemId);
          continue;
        }
        // Restore's entire job is to attach content, so for a metadata-only
        // item there is nothing it may legitimately do. Counted and skipped
        // rather than left to hit the chunk-write refusal: an extraction runner
        // handing this store a batch is behaving correctly, and a thrown error
        // would turn ordinary policy into a lane failure.
        if (disposition.disposition === 'metadata_only') {
          itemsMetadataOnly += 1;
          skippedProviderItemIds.push(item.identity.providerItemId);
          continue;
        }
        const existing = this.db.query(`
          SELECT
            COUNT(*) AS matching_provider_id_rows,
            SUM(CASE WHEN normalized_conversation = ? THEN 1 ELSE 0 END) AS exact_identity_rows,
            MIN(CASE WHEN normalized_conversation = ? THEN item_pk END) AS item_pk,
            MIN(CASE WHEN normalized_conversation = ? THEN tombstoned END) AS tombstoned
          FROM items
          WHERE provider = ? AND account_scope = ? AND provider_item_id = ?
        `).get(
          normalizeConversationId(item.identity.providerConversationId),
          normalizeConversationId(item.identity.providerConversationId),
          normalizeConversationId(item.identity.providerConversationId),
          item.identity.provider,
          item.identity.accountScope,
          item.identity.providerItemId,
        ) as {
          matching_provider_id_rows: number;
          exact_identity_rows: number;
          item_pk: number | null;
          tombstoned: number | null;
        };
        if (existing.matching_provider_id_rows > 1) {
          throw new Error(
            'Representation restore refused because a targeted identity matches multiple store rows.',
          );
        }
        if (existing.exact_identity_rows !== 1 || existing.item_pk === null) {
          throw new Error('Representation restore refused because a targeted store item is missing.');
        }
        // upsertItem clears `tombstoned` unconditionally, so writing here would
        // undo a removal — including one a reconcile proved. The row stays
        // removed and the caller is told, in the same counted-skip shape the
        // owner and metadata-only refusals already use.
        if (existing.tombstoned === 1) {
          itemsSkippedTombstoned += 1;
          skippedProviderItemIds.push(item.identity.providerItemId);
          continue;
        }

        if (options.skipOwner) {
          const skipOwner = this.db.query(`
            SELECT 1 AS present
            FROM item_owners
            WHERE item_pk = ? AND connector_id = ? AND ownership_kind = ?
            LIMIT 1
          `).get(
            existing.item_pk,
            options.skipOwner.connectorId,
            options.skipOwner.ownershipKind,
          ) as { present: number } | null;
          if (skipOwner?.present === 1) {
            itemsSkippedByOwner += 1;
            skippedProviderItemIds.push(item.identity.providerItemId);
            continue;
          }
        }

        // The generation fence, and it is inside this transaction on purpose.
        // The caller's own "do I still hold this work?" probe reads another
        // database, so it can only ever report the past; this comparison
        // commits or rolls back with the content it guards, which is what
        // makes a superseded write impossible rather than merely unlikely.
        //
        // Checked BEFORE the coverage short-circuit so a stale generation is
        // refused whatever it happens to be carrying.
        if (writeClaim && !this.acceptItemWriteClaim(existing.item_pk, writeClaim)) {
          itemsSkippedStaleClaim += 1;
          skippedProviderItemIds.push(item.identity.providerItemId);
          continue;
        }

        if (this.itemRepresentationCoverage(record.expectation).complete) {
          itemsUnchanged += 1;
          continue;
        }

        const sensitivity = options.classify(item);
        if (sensitivity.trustDomain !== this.trustDomain || sensitivity.trustTier === 'S5') {
          throw new Error('Representation restore item classification is not eligible for this store.');
        }
        const upsert = this.upsertItemWithOwner(
          item,
          sensitivity,
          ownerConnectorId,
          options.ownershipKind,
          syncRunId,
          // A restore re-attaches text to a row that is already here. It is
          // not a provider listing, so it must not advance the observation
          // clock the removal fences read.
          'local_write',
          options.preserveStoredSearchText === true,
          options.preserveStoredSearchTextOwnedFacets === true,
        );
        this.indexKnownItemContent(item, upsert.itemPk, maxChunkChars);
        this.refreshFtsForItem(upsert.itemPk);
        chunksAwaitingEmbedding += (this.db.query(`
          SELECT COUNT(*) AS count
          FROM chunks c
          WHERE c.item_pk = ?
            AND NOT EXISTS (
              SELECT 1
              FROM chunk_embeddings embedding
              WHERE embedding.chunk_pk = c.chunk_pk
                AND embedding.content_hash = c.embedding_input_hash
            )
        `).get(upsert.itemPk) as { count: number }).count;
        itemsRestored += 1;
        restoredProviderItemIds.push(item.identity.providerItemId);
      }

      const completedAt = this.now().toISOString();
      this.db.query(`
        UPDATE sync_runs
        SET status = 'completed', items_indexed = ?, completed_at = ?
        WHERE sync_run_id = ?
      `).run(itemsRestored, completedAt, syncRunId);

      return {
        syncRunId,
        counts: {
          itemsSeen: options.items.length,
          itemsRestored,
          itemsUnchanged,
          itemsSkippedByOwner,
          itemsExcluded,
          itemsMetadataOnly,
          itemsSkippedTombstoned,
          itemsSkippedStaleClaim,
          chunksAwaitingEmbedding,
        },
        restoredProviderItemIds: restoredProviderItemIds.sort(),
        skippedProviderItemIds: skippedProviderItemIds.sort(),
      };
    })();
  }

  /**
   * Give up this store's copy of items another corpus has a stronger claim to.
   *
   * Trust-separated corpora read the same append-only capture, so one identity
   * can be admitted here and only later be reclassified into a stricter corpus.
   * A scan window cannot repair that: by the time the stricter record is
   * written, the copy already admitted here is behind every cursor, and no
   * single window ever holds both readings. The boundary that CAN decide it is
   * this one — the identity is either in this store or it is not — so the
   * caller resolves against the stores and calls this to make the looser one
   * let go.
   *
   * Tombstoned, not deleted, for the reason every removal here is: a later
   * replay of the looser record must not resurrect the content. Only ACTIVE
   * rows are touched, so a repeat call is a no-op that honestly reports zero,
   * and an identity this store never held costs one indexed lookup and nothing
   * else. Chunks, their cascaded vectors, and the FTS row go with the
   * tombstone — text left searchable behind a removed row is the exact failure
   * this exists to prevent.
   *
   * Source-neutral by construction: it names no provider and asks nothing of
   * the identities beyond their coordinates.
   */
  relinquishItems(options: ConnectorStoreRelinquishOptions): ConnectorStoreRelinquishSummary {
    const syncConnectorId = requireNonEmpty(options.syncConnectorId, 'Relinquish sync connector id');
    const ownerConnectorId = requireNonEmpty(options.ownerConnectorId, 'Relinquish owner connector id');
    return this.db.transaction(() => {
      const considered = new Set<string>();
      const doomed: Array<{ itemPk: number; localItemId: string }> = [];
      const findActive = this.db.query(`
        SELECT item_pk FROM items
        WHERE provider = ? AND account_scope = ?
          AND normalized_conversation = ? AND provider_item_id = ?
          AND tombstoned = 0
      `);
      for (const identity of options.identities) {
        const key = sourceItemIdentityKey(identity);
        if (considered.has(key)) continue;
        considered.add(key);
        const row = findActive.get(
          identity.provider,
          identity.accountScope,
          normalizeConversationId(identity.providerConversationId),
          identity.providerItemId,
        ) as { item_pk: number } | null;
        if (row) doomed.push({ itemPk: row.item_pk, localItemId: identity.localItemId });
      }
      if (doomed.length === 0) {
        return {
          counts: { identitiesConsidered: considered.size, itemsRelinquished: 0 },
          relinquishedLocalItemIds: [],
        };
      }

      // The run row exists only when something is actually given up: an
      // unconditional one would grow `sync_runs` on every idle pass and make a
      // no-op look like work in the store's own status projection.
      const now = this.now().toISOString();
      const syncRunId = `connector-relinquish-${randomUUID()}`;
      this.db.query(`
        INSERT INTO sync_runs (
          sync_run_id, corpus_id, connector_id, status, cursor,
          items_seen, items_indexed, started_at, completed_at
        ) VALUES (?, ?, ?, 'completed', NULL, ?, 0, ?, ?)
      `).run(syncRunId, this.corpusId, syncConnectorId, considered.size, now, now);

      const trustTier = options.trustTier ?? conservativeTierForDomain(this.trustDomain);
      const tombstone = this.db.query(`
        UPDATE items
        SET tombstoned = 1, deleted_at = ?, indexed_at = ?, trust_tier = ?, sync_run_id = ?
        WHERE item_pk = ?
      `);
      const dropChunks = this.db.query('DELETE FROM chunks WHERE item_pk = ?');
      for (const target of doomed) {
        tombstone.run(now, now, trustTier, syncRunId, target.itemPk);
        dropChunks.run(target.itemPk);
        this.deleteFtsForItem(target.itemPk);
        // `local_write`: giving up a claim proves nothing about whether the
        // provider still lists the item, so it must not advance the removal
        // fences' freshness stamp.
        this.rememberItemOwner(
          target.itemPk,
          ownerConnectorId,
          options.ownershipKind,
          syncRunId,
          now,
          'local_write',
        );
      }
      return {
        syncRunId,
        counts: { identitiesConsidered: considered.size, itemsRelinquished: doomed.length },
        relinquishedLocalItemIds: doomed.map((target) => target.localItemId).sort(),
      };
    })();
  }

  /**
   * One bounded page of this store's ACTIVE identities in item-primary-key
   * order. Item primary keys are append-only and survive tombstoning, so the
   * returned cursor stays a stable resume position for another process even
   * while this store keeps syncing. Identity coordinates only — no title,
   * locator, or text.
   */
  activeItemIdentities(
    options: { afterItemPk?: number; maxItems?: number } = {},
  ): ConnectorStoreActiveIdentityPage {
    const afterItemPk = options.afterItemPk ?? 0;
    if (!Number.isSafeInteger(afterItemPk) || afterItemPk < 0) {
      throw new Error('Connector store identity page afterItemPk must be a non-negative integer.');
    }
    const maxItems = normalizeLocatorIdentityBackfillItems(options.maxItems);
    const rows = this.db.query(`
      SELECT item_pk, family, provider, account_scope, provider_item_id,
             provider_thread_id, provider_conversation_id, provider_file_id,
             provider_event_id, local_item_id, source_version
      FROM items
      WHERE item_pk > ? AND tombstoned = 0
      ORDER BY item_pk
      LIMIT ?
    `).all(afterItemPk, maxItems) as Array<{
      item_pk: number;
      family: SourceItemIdentity['family'];
      provider: string;
      account_scope: string;
      provider_item_id: string;
      provider_thread_id: string | null;
      provider_conversation_id: string | null;
      provider_file_id: string | null;
      provider_event_id: string | null;
      local_item_id: string;
      source_version: string | null;
    }>;
    return {
      identities: rows.map((row) => ({
        family: row.family,
        provider: row.provider,
        accountScope: row.account_scope,
        providerItemId: row.provider_item_id,
        ...(row.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {}),
        ...(row.provider_conversation_id ? { providerConversationId: row.provider_conversation_id } : {}),
        ...(row.provider_file_id ? { providerFileId: row.provider_file_id } : {}),
        ...(row.provider_event_id ? { providerEventId: row.provider_event_id } : {}),
        localItemId: row.local_item_id,
        ...(row.source_version ? { sourceVersion: row.source_version } : {}),
      })),
      cursorItemPk: rows.at(-1)?.item_pk ?? afterItemPk,
      // Fewer rows than asked for means no active row remains past them.
      exhausted: rows.length < maxItems,
    };
  }

  /**
   * One-time reconciliation against a stricter store: every identity the
   * stricter store actively holds is relinquished here.
   *
   * {@link relinquishItems} enforces the one-lane invariant from the moment it
   * ships, but it heals nothing that predates it: an identity indexed in both
   * stores before then has both records behind both cursors, so no future
   * window ever surfaces the disagreement. The remaining evidence is the
   * stores themselves, and this sweep is that comparison — walked in bounded
   * windows over the stricter store's identity pages, mirroring the locator
   * identity backfill.
   *
   * The durable position is a completed run row in THIS store under
   * `reconcileConnectorId`, holding the stricter store's item-pk cursor and,
   * once the walk exhausts, a completion marker. A completed sweep costs one
   * bounded probe of the small run-history table per call and writes nothing,
   * which is what lets a sync path call this unconditionally. Identities the
   * stricter store admits AFTER the marker is written are the running
   * invariant's problem, not this sweep's — that is what makes it one-time.
   *
   * Each window relinquishes before it records its cursor, and both sides of
   * that pairing are idempotent, so a crash between them costs one repeated
   * no-op window. The two stores are separate databases: no cross-database
   * transaction is available, and none is needed.
   */
  reconcileAgainstStricterStore(
    options: ConnectorStoreTrustReconciliationOptions,
  ): ConnectorStoreTrustReconciliationSummary {
    if (options.stricter === this) {
      throw new Error('Connector store trust reconciliation requires two distinct stores.');
    }
    // Two handles on one database pass the object-identity check and would
    // enumerate this store's own rows as "the stricter store's claims" —
    // tombstoning everything. Device+inode comparison also catches hard links
    // and symlinked ancestor directories, which path equality does not.
    if (this.dbPath !== ':memory:' && options.stricter.dbPath !== ':memory:') {
      const looserFile = statSync(this.dbPath);
      const stricterFile = statSync(options.stricter.dbPath);
      if (looserFile.dev === stricterFile.dev && looserFile.ino === stricterFile.ino) {
        throw new Error('Connector store trust reconciliation refuses one database as both stores.');
      }
    }
    const reconcileConnectorId = requireNonEmpty(
      options.reconcileConnectorId,
      'Trust reconciliation connector id',
    );
    const maxItems = normalizeLocatorIdentityBackfillItems(options.maxItems);
    const maxWindows = normalizeTrustReconciliationWindows(options.maxWindows);
    let position = this.trustReconciliationPosition(reconcileConnectorId);
    const relinquishedLocalItemIds: string[] = [];
    let identitiesScanned = 0;
    let itemsRelinquished = 0;
    for (let window = 0; !position.complete && window < maxWindows; window += 1) {
      const page = options.stricter.activeItemIdentities({
        afterItemPk: position.cursorItemPk,
        maxItems,
      });
      if (page.identities.length > 0) {
        const relinquish = this.relinquishItems({
          identities: page.identities,
          syncConnectorId: options.evictionSyncConnectorId,
          ownerConnectorId: options.ownerConnectorId,
          ownershipKind: options.ownershipKind,
          ...(options.trustTier ? { trustTier: options.trustTier } : {}),
        });
        itemsRelinquished += relinquish.counts.itemsRelinquished;
        relinquishedLocalItemIds.push(...relinquish.relinquishedLocalItemIds);
      }
      identitiesScanned += page.identities.length;
      position = { cursorItemPk: page.cursorItemPk, complete: page.exhausted };
      this.recordTrustReconciliationPosition(
        reconcileConnectorId,
        position.cursorItemPk,
        page.identities.length,
        position.complete,
      );
    }
    return {
      state: position.complete ? 'ready' : 'in_progress',
      identitiesScanned,
      itemsRelinquished,
      cursorItemPk: position.cursorItemPk,
      relinquishedLocalItemIds: relinquishedLocalItemIds.sort(),
    };
  }

  /** The sweep's durable position, for operator receipts. Read-only. */
  trustReconciliationStatus(reconcileConnectorId: string): ConnectorStoreTrustReconciliationStatus {
    const position = this.trustReconciliationPosition(reconcileConnectorId);
    return {
      state: position.complete ? 'ready' : 'in_progress',
      cursorItemPk: position.cursorItemPk,
    };
  }

  private trustReconciliationPosition(
    reconcileConnectorId: string,
  ): { cursorItemPk: number; complete: boolean } {
    const latched = this.trustReconciliationReadyCursors?.get(reconcileConnectorId);
    if (latched !== undefined) return { cursorItemPk: latched, complete: true };
    // Insertion order, not started_at: the sweep's rows are the only writers
    // under this lineage, so rowid IS true recency, and a wall-clock rollback
    // between windows must not leave a future-dated position row permanently
    // shadowing every newer cursor and the completion marker.
    const row = this.db.query(`
      SELECT cursor FROM sync_runs
      WHERE connector_id = ? AND status = 'completed'
      ORDER BY rowid DESC
      LIMIT 1
    `).get(reconcileConnectorId) as { cursor: string | null } | null;
    const cursor = row?.cursor;
    const match = cursor ? TRUST_RECONCILIATION_CURSOR_PATTERN.exec(cursor) : null;
    // An absent or unparseable cursor restarts the sweep from the beginning:
    // every window is idempotent, while trusting a foreign cursor could leave
    // a duplicated stretch permanently unswept.
    if (!match) return { cursorItemPk: 0, complete: false };
    const position = { cursorItemPk: Number(match[2]), complete: match[1] !== undefined };
    if (position.complete) {
      (this.trustReconciliationReadyCursors ??= new Map()).set(reconcileConnectorId, position.cursorItemPk);
    }
    return position;
  }

  private recordTrustReconciliationPosition(
    reconcileConnectorId: string,
    cursorItemPk: number,
    identitiesScanned: number,
    complete: boolean,
  ): void {
    const now = this.now().toISOString();
    this.db.query(`
      INSERT INTO sync_runs (
        sync_run_id, corpus_id, connector_id, status, cursor,
        items_seen, items_indexed, started_at, completed_at
      ) VALUES (?, ?, ?, 'completed', ?, ?, 0, ?, ?)
    `).run(
      `trust-reconcile-${randomUUID()}`,
      this.corpusId,
      reconcileConnectorId,
      `${complete ? 'complete:' : ''}stricter-item-pk:${cursorItemPk}`,
      identitiesScanned,
      now,
      now,
    );
    if (complete) (this.trustReconciliationReadyCursors ??= new Map()).set(reconcileConnectorId, cursorItemPk);
  }

  /**
   * Take the item's write-claim row if this grant is newer than the one there,
   * and answer whether the caller may proceed.
   *
   * Two grants are only ordered within one authority. A row written under a
   * different authority is not evidence about this one — it is another queue,
   * or the same queue rebuilt — so it is taken over rather than obeyed.
   * Refusing it instead would turn "somebody recreated the producer's database"
   * into a corpus that silently accepts no writes at all.
   *
   * Called only from inside a write transaction; the read and the stamp are
   * one step with the content they guard.
   */
  private acceptItemWriteClaim(
    itemPk: number,
    claim: ConnectorStoreItemWriteClaim,
  ): boolean {
    const existing = this.db.query(`
      SELECT claim_authority, claim_ordinal
      FROM item_write_claims
      WHERE item_pk = ? AND claim_scope = ?
    `).get(itemPk, claim.scope) as
      | { claim_authority: string; claim_ordinal: number }
      | null;
    if (existing
      && existing.claim_authority === claim.authority
      && claim.ordinal <= existing.claim_ordinal) {
      return false;
    }
    this.db.query(`
      INSERT INTO item_write_claims (
        item_pk, claim_scope, claim_authority, claim_ordinal, claim_holder,
        claim_generation, accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_pk, claim_scope) DO UPDATE SET
        claim_authority = excluded.claim_authority,
        claim_ordinal = excluded.claim_ordinal,
        claim_holder = excluded.claim_holder,
        claim_generation = excluded.claim_generation,
        accepted_at = excluded.accepted_at
    `).run(
      itemPk,
      claim.scope,
      claim.authority,
      claim.ordinal,
      claim.holder,
      claim.generation,
      this.now().toISOString(),
    );
    return true;
  }

  /**
   * Remove everything already stored under the user's excluded folders, or —
   * with `dryRun` — report exactly what such a run would remove.
   *
   * The preview and the deletion walk the SAME rows through the SAME matcher
   * in one transaction, so the preview cannot describe a different set than
   * the purge acts on.
   *
   * Fail-closed points the other way here, deliberately. At ingestion, an
   * unevaluable path is EXCLUDED: the cost is one missing file. At purge, an
   * unevaluable path is KEPT and reported: deleting a row this gate cannot
   * read is destroying data on a guess. The ingestion gate makes such rows
   * impossible going forward, so the count is a finite backlog the user
   * decides about, not a standing hole. `purgeUnevaluable` is how they decide.
   *
   * Chunks and embeddings go with the item rather than separately: both cascade
   * from `items` on delete, and the FTS row is removed in the same statement,
   * so there is no window in which an item is gone but its text is still
   * searchable.
   */
  purgeExcludedItems(options: {
    dryRun: boolean;
    purgeUnevaluable?: boolean;
  }): ConnectorStorePurgeSummary {
    if (!this.exclusions.active) {
      return emptyPurgeSummary(this.corpusId, options.dryRun, this.exclusions);
    }
    return this.db.transaction(() => {
      const rows = this.db.query(`
        SELECT i.item_pk AS item_pk, i.locator_uri AS locator_uri
        FROM items i
      `).all() as Array<{ item_pk: number; locator_uri: string | null }>;

      const tally = createExclusionTally(this.exclusions);
      const doomed: number[] = [];
      let itemsUnevaluableKept = 0;
      for (const row of rows) {
        const decision = this.exclusions.evaluatePath(row.locator_uri);
        if (!decision.excluded) continue;
        tallyExclusion(tally, decision);
        if (sourceExclusionOutcomeIsUnevaluable(decision.outcome) && options.purgeUnevaluable !== true) {
          itemsUnevaluableKept += 1;
          continue;
        }
        doomed.push(row.item_pk);
      }

      const chunks = this.countRowsForItems('chunks', doomed);
      const embeddings = this.countRowsForItems('chunk_embeddings', doomed);
      if (!options.dryRun) {
        // FTS first, per item, through the store's own removal helper: the FTS
        // rows carry no foreign key, so deleting the parent first would strand
        // searchable text behind a row that no longer exists.
        for (const itemPk of doomed) this.deleteFtsForItem(itemPk);
        for (const batch of batched(doomed, 400)) {
          const placeholders = batch.map(() => '?').join(', ');
          this.db.query(`DELETE FROM chunk_embeddings WHERE item_pk IN (${placeholders})`).run(...batch);
          this.db.query(`DELETE FROM chunks WHERE item_pk IN (${placeholders})`).run(...batch);
          this.db.query(`DELETE FROM item_owners WHERE item_pk IN (${placeholders})`).run(...batch);
          this.db.query(`DELETE FROM items WHERE item_pk IN (${placeholders})`).run(...batch);
        }
      }

      return {
        kind: 'connector_store_exclusion_purge' as const,
        corpus_id: this.corpusId,
        dry_run: options.dryRun,
        counts: {
          items_scanned: rows.length,
          items_matched: tally.total,
          items_removed: options.dryRun ? 0 : doomed.length,
          items_would_remove: doomed.length,
          items_unevaluable_kept: itemsUnevaluableKept,
          chunks_removed: options.dryRun ? 0 : chunks,
          chunks_would_remove: chunks,
          embeddings_removed: options.dryRun ? 0 : embeddings,
          embeddings_would_remove: embeddings,
        },
        by_prefix: exclusionCounts(tally).by_prefix,
      };
    })();
  }

  /**
   * Strip the CONTENT of everything the owner marked metadata-only, keeping
   * every item row — or, with `dryRun`, report exactly what such a run would
   * remove.
   *
   * The sibling of `purgeExcludedItems`, and deliberately a separate operation
   * rather than a flag on it. The two destroy different things: a purge removes
   * the item and everything hanging off it, a strip removes the chunks and
   * vectors and leaves the item findable by title, path and date. Collapsing
   * them into one call with a parameter would put "delete the row" and "keep
   * the row" one typo apart.
   *
   * Same direction-per-operation discipline as the purge, for the same reason:
   * at ingestion an unanswerable item is treated by the rule, here it is KEPT
   * INTACT and reported. Removing an item's text because the gate could not
   * read its path is destroying data on a guess.
   *
   * The FTS row is rebuilt rather than deleted: the item stays searchable by
   * its metadata, which is the entire point of the disposition. Deleting the
   * row instead would silently convert metadata-only into invisible.
   */
  stripMetadataOnlyRepresentations(options: {
    dryRun: boolean;
    stripUnevaluable?: boolean;
  }): ConnectorStoreMetadataOnlyStripSummary {
    if (!this.exclusions.active) {
      return emptyMetadataOnlyStripSummary(this.corpusId, options.dryRun, this.exclusions);
    }
    return this.db.transaction(() => {
      const rows = this.db.query(`
        SELECT i.item_pk AS item_pk, i.locator_uri AS locator_uri
        FROM items i
        WHERE EXISTS (SELECT 1 FROM chunks c WHERE c.item_pk = i.item_pk)
      `).all() as Array<{ item_pk: number; locator_uri: string | null }>;

      const tally = createExclusionTally(this.exclusions, 'metadata_only');
      const doomed: number[] = [];
      let itemsUnevaluableKept = 0;
      for (const row of rows) {
        const decision = this.exclusions.evaluatePath(row.locator_uri);
        if (decision.disposition !== 'metadata_only') continue;
        tallyExclusion(tally, decision);
        if (sourceExclusionOutcomeIsUnevaluable(decision.outcome) && options.stripUnevaluable !== true) {
          itemsUnevaluableKept += 1;
          continue;
        }
        doomed.push(row.item_pk);
      }

      const chunks = this.countRowsForItems('chunks', doomed);
      const embeddings = this.countRowsForItems('chunk_embeddings', doomed);
      if (!options.dryRun) {
        for (const batch of batched(doomed, 400)) {
          const placeholders = batch.map(() => '?').join(', ');
          this.db.query(`DELETE FROM chunk_embeddings WHERE item_pk IN (${placeholders})`).run(...batch);
          this.db.query(`DELETE FROM chunks WHERE item_pk IN (${placeholders})`).run(...batch);
        }
        // AFTER the chunks are gone, so the rebuilt row carries the item's
        // metadata and none of its former text. Doing this per item rather
        // than in bulk keeps it on the store's own FTS ownership helper, which
        // is what tracks the standalone FTS table's rowids.
        for (const itemPk of doomed) this.refreshFtsForItem(itemPk);
      }

      return {
        kind: 'connector_store_metadata_only_strip' as const,
        corpus_id: this.corpusId,
        dry_run: options.dryRun,
        counts: {
          items_scanned: rows.length,
          items_matched: tally.total,
          items_stripped: options.dryRun ? 0 : doomed.length,
          items_would_strip: doomed.length,
          items_unevaluable_kept: itemsUnevaluableKept,
          chunks_removed: options.dryRun ? 0 : chunks,
          chunks_would_remove: chunks,
          embeddings_removed: options.dryRun ? 0 : embeddings,
          embeddings_would_remove: embeddings,
        },
        by_prefix: exclusionCounts(tally).by_prefix,
      };
    })();
  }

  /**
   * The rule that makes one stored row metadata-only, or undefined.
   *
   * Undefined covers three different situations on purpose — no rule, an
   * exclusion, or a locator the gate cannot read — because every one of them
   * means the same thing to the only caller: this row's missing text is not
   * explained by a metadata-only rule, so do not claim it is.
   */
  metadataOnlyRuleForLocator(locatorUri: string | undefined): string | undefined {
    if (!this.exclusions.active) return undefined;
    const decision = this.exclusions.evaluatePath(locatorUri);
    return decision.disposition === 'metadata_only' ? decision.ruleId : undefined;
  }

  /**
   * How many stored items still carry content that a metadata-only rule says
   * they should not. Zero once a strip has run; non-zero is outstanding strip
   * debt, which the ledger reports rather than hides.
   */
  metadataOnlyContentPresent(): { items: number; unevaluable: number } {
    return this.exclusionDebtPresent().metadataOnlyContent;
  }

  /**
   * How many items currently sitting in this store fall under an excluded
   * folder. Zero once a purge has run; non-zero is outstanding purge debt the
   * ledger reports rather than hides.
   */
  excludedItemsPresent(): { items: number; unevaluable: number } {
    return this.exclusionDebtPresent().excluded;
  }

  /**
   * Both debts, from one walk of the store.
   *
   * Every caller wants the pair — the ledger's "excluded by configuration"
   * section reports purge debt and strip debt side by side — and the gate hands
   * back BOTH answers for a row in a single decision, because an item is
   * excluded or metadata-only, never both. Asking twice therefore scanned the
   * whole table twice and evaluated every locator twice for two halves of one
   * answer: 380ms per source per dashboard render on a 262k-item store, the
   * page's largest remaining per-render cost once the readiness ladder came off
   * the interactive path.
   *
   * Streamed rather than materialised, for the same reason `itemLocatorCensus`
   * is: a file corpus is six figures of rows and each locator is needed once.
   */
  exclusionDebtPresent(): {
    excluded: { items: number; unevaluable: number };
    metadataOnlyContent: { items: number; unevaluable: number };
  } {
    const empty = { excluded: { items: 0, unevaluable: 0 }, metadataOnlyContent: { items: 0, unevaluable: 0 } };
    if (!this.exclusions.active) return empty;
    const excluded = { items: 0, unevaluable: 0 };
    const metadataOnlyContent = { items: 0, unevaluable: 0 };
    for (const row of this.itemLocatorCensus()) {
      const decision = this.exclusions.evaluatePath(row.locator);
      const unevaluable = sourceExclusionOutcomeIsUnevaluable(decision.outcome);
      if (decision.excluded) {
        excluded.items += 1;
        if (unevaluable) excluded.unevaluable += 1;
        continue;
      }
      // Strip debt is content that a metadata-only rule says should not be
      // there, so a row holding no content is not debt no matter what rule
      // covers it.
      if (decision.disposition !== 'metadata_only' || !row.hasContent) continue;
      metadataOnlyContent.items += 1;
      if (unevaluable) metadataOnlyContent.unevaluable += 1;
    }
    return { excluded, metadataOnlyContent };
  }

  /**
   * Every stored item's locator, with whether it still holds content.
   *
   * The one read the folder-disposition picker needs, and deliberately the
   * SAME two facts the purge and the strip work from: the locator they
   * evaluate, and whether chunks exist. A picker that derived its tree from a
   * different column — a title, a metadata path — would show counts a
   * `--dry-run` preview could not reproduce, and the owner would be deciding
   * what to delete from numbers nothing else in the system agrees with.
   *
   * Streamed rather than materialised: a file corpus is six figures of rows and
   * the caller only needs each locator once, to fold into a tree.
   */
  *itemLocatorCensus(): Generator<{ locator: string | null; hasContent: boolean }> {
    const rows = this.db.query(`
      SELECT
        i.locator_uri AS locator_uri,
        EXISTS (SELECT 1 FROM chunks c WHERE c.item_pk = i.item_pk) AS has_content
      FROM items i
    `).iterate() as Iterable<{ locator_uri: string | null; has_content: number }>;
    for (const row of rows) {
      yield { locator: row.locator_uri, hasContent: row.has_content === 1 };
    }
  }

  private countRowsForItems(table: 'chunks' | 'chunk_embeddings', itemPks: readonly number[]): number {
    let total = 0;
    for (const batch of batched(itemPks, 400)) {
      const placeholders = batch.map(() => '?').join(', ');
      total += (this.db.query(
        `SELECT COUNT(*) AS count FROM ${table} WHERE item_pk IN (${placeholders})`,
      ).get(...batch) as { count: number }).count;
    }
    return total;
  }

  repairSenderMetadata(
    options: ConnectorStoreSenderRepairOptions,
  ): ConnectorStoreSenderRepairSummary {
    const startOffset = normalizeSenderRepairCursor(options.cursor, options.records.length);
    const maxItems = normalizeMaxItems(options.maxItems);
    const endOffset = Math.min(
      options.records.length,
      startOffset + (maxItems ?? options.records.length),
    );
    const records = options.records.slice(startOffset, endOffset);
    const counts = {
      itemsScanned: 0,
      itemsRepaired: 0,
      itemsUnchanged: 0,
      itemsMissing: 0,
    };
    const inputDigest = createHash('sha256');
    const outputDigest = createHash('sha256');
    const select = this.db.query(`
      SELECT item_pk, sender_id, sender_label, sender_is_owner
      FROM items
      WHERE provider = ? AND account_scope = ?
        AND normalized_conversation = ? AND provider_item_id = ?
        AND tombstoned = 0
      LIMIT 1
    `);
    const update = this.db.query(`
      UPDATE items
      SET sender_id = ?, sender_label = ?, sender_is_owner = ?
      WHERE item_pk = ?
    `);

    this.db.transaction(() => {
      for (const record of records) {
        const sender = normalizeSenderMetadata(record);
        const identity = record.sourceItem;
        const digestIdentity = [
          identity.provider,
          identity.accountScope,
          identity.providerConversationId ?? '',
          identity.providerItemId,
        ].join('\0');
        inputDigest.update(JSON.stringify({
          identity: digestIdentity,
          sender_id: sender.senderId ?? null,
          sender_label: sender.senderLabel ?? null,
          sender_is_owner: sender.senderIsOwner ?? null,
        }));
        counts.itemsScanned += 1;
        const row = select.get(
          identity.provider,
          identity.accountScope,
          normalizeConversationId(identity.providerConversationId),
          identity.providerItemId,
        ) as {
          item_pk: number;
          sender_id: string | null;
          sender_label: string | null;
          sender_is_owner: number | null;
        } | null;
        if (!row) {
          counts.itemsMissing += 1;
          outputDigest.update(JSON.stringify({ identity: digestIdentity, status: 'missing' }));
          continue;
        }
        // Repair records are partial by design: a frozen source may know the
        // sender identity but not whether that sender is the owner. Never
        // erase a value already learned from a richer live connector.
        const senderId = sender.senderId ?? row.sender_id;
        const senderLabel = sender.senderLabel ?? row.sender_label;
        const senderIsOwner = sender.senderIsOwner === undefined
          ? row.sender_is_owner
          : Number(sender.senderIsOwner);
        if (
          row.sender_id === senderId
          && row.sender_label === senderLabel
          && row.sender_is_owner === senderIsOwner
        ) {
          counts.itemsUnchanged += 1;
          outputDigest.update(JSON.stringify({ identity: digestIdentity, status: 'unchanged' }));
          continue;
        }
        update.run(
          senderId,
          senderLabel,
          senderIsOwner,
          row.item_pk,
        );
        counts.itemsRepaired += 1;
        outputDigest.update(JSON.stringify({ identity: digestIdentity, status: 'repaired' }));
      }
    })();

    return {
      counts,
      inputDigestSha256: inputDigest.digest('hex'),
      outputDigestSha256: outputDigest.digest('hex'),
      ...(endOffset < options.records.length ? { cursor: String(endOffset) } : {}),
    };
  }

  repairSearchTextFromChunks(
    options: ConnectorStoreSearchTextRepairOptions,
  ): ConnectorStoreSearchTextRepairSummary {
    const provider = requireNonEmpty(options.provider, 'Connector store search-text repair provider');
    const startAfter = normalizeRepairCursor(options.cursor);
    const maxItems = normalizeMaxItems(options.maxItems);
    const batchSize = normalizeRepairBatchSize(options.batchSize);
    const counts = {
      itemsScanned: 0,
      itemsRepaired: 0,
      itemsUnchanged: 0,
      itemsWithoutChunks: 0,
      ftsRowsRefreshed: 0,
      chunkEmbeddingInputsInvalidated: 0,
    };
    const inputDigest = createHash('sha256');
    const outputDigest = createHash('sha256');
    let lastItemPk = startAfter;
    let hasMore = false;

    while (maxItems === undefined || counts.itemsScanned < maxItems) {
      const remaining = maxItems === undefined
        ? batchSize
        : Math.min(batchSize, maxItems - counts.itemsScanned);
      const rows = this.db.query(`
        SELECT
          i.item_pk,
          i.search_text,
          i.family,
          i.account_scope,
          i.provider_item_id,
          i.provider_thread_id,
          i.provider_conversation_id,
          i.provider_file_id,
          i.provider_event_id,
          i.local_item_id,
          i.source_version,
          i.reactions_json,
          -- The rest of the embedding seasoning. search_text is only one line
          -- of the embedding input; the others are needed to recompute the
          -- whole input hash once the repair has rewritten that line.
          i.title,
          i.mime_type,
          i.authored_at,
          i.updated_at,
          (
            SELECT GROUP_CONCAT(ordered.bounded_text, '')
            FROM (
              SELECT c.bounded_text
              FROM chunks c
              WHERE c.item_pk = i.item_pk
              ORDER BY c.chunk_index
            ) ordered
          ) AS derived_search_text
        FROM items i
        WHERE i.provider = ? AND i.tombstoned = 0 AND i.item_pk > ?
        ORDER BY i.item_pk
        LIMIT ?
      `).all(provider, lastItemPk, remaining + 1) as Array<{
        item_pk: number;
        search_text: string | null;
        family: SourceItemIdentity['family'];
        account_scope: string;
        provider_item_id: string;
        provider_thread_id: string | null;
        provider_conversation_id: string | null;
        provider_file_id: string | null;
        provider_event_id: string | null;
        local_item_id: string;
        source_version: string | null;
        reactions_json: string | null;
        title: string | null;
        mime_type: string | null;
        authored_at: string | null;
        updated_at: string | null;
        derived_search_text: string | null;
      }>;
      hasMore = rows.length > remaining;
      const batch = rows.slice(0, remaining);
      if (batch.length === 0) break;

      this.db.transaction(() => {
        const update = this.db.query('UPDATE items SET search_text = ? WHERE item_pk = ?');
        for (const row of batch) {
          const identity: SourceItemIdentity = {
            family: row.family,
            provider,
            accountScope: row.account_scope,
            providerItemId: row.provider_item_id,
            localItemId: row.local_item_id,
            ...(row.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {}),
            ...(row.provider_conversation_id ? { providerConversationId: row.provider_conversation_id } : {}),
            ...(row.provider_file_id ? { providerFileId: row.provider_file_id } : {}),
            ...(row.provider_event_id ? { providerEventId: row.provider_event_id } : {}),
            ...(row.source_version ? { sourceVersion: row.source_version } : {}),
          };
          const repaired = combineSearchText([
            row.derived_search_text,
            ...(options.supplementalSearchText?.(identity) ?? []),
          ]);
          // The stored reaction aggregate is re-rendered here too: this repair
          // rebuilds search_text from scratch, so omitting the line would
          // silently drop reactions out of FTS on the next maintenance pass.
          // It rides on top of the repaired text rather than qualifying for
          // repair on its own, so which items this pass touches is unchanged.
          const derived = repaired === null
            ? null
            : combineSearchText([
              repaired,
              renderSourceReactionLine(parseStoredSourceReactions(row.reactions_json)),
            ]);
          inputDigest.update(
            `${row.item_pk}:${hashString(row.search_text ?? '')}:${hashString(derived ?? '')}\n`,
          );
          counts.itemsScanned += 1;
          lastItemPk = row.item_pk;
          if (derived === null) {
            counts.itemsWithoutChunks += 1;
            outputDigest.update(`${row.item_pk}:${hashString(row.search_text ?? '')}\n`);
            continue;
          }
          if (row.search_text === derived) {
            counts.itemsUnchanged += 1;
            outputDigest.update(`${row.item_pk}:${hashString(derived)}\n`);
            continue;
          }
          update.run(derived, row.item_pk);
          counts.itemsRepaired += 1;
          counts.chunkEmbeddingInputsInvalidated += this.reseasonItemEmbeddingInputs(row.item_pk, {
            title: row.title,
            search_text: derived,
            mime_type: row.mime_type,
            authored_at: row.authored_at,
            updated_at: row.updated_at,
          });
          counts.ftsRowsRefreshed += this.refreshFtsForItem(row.item_pk);
          outputDigest.update(`${row.item_pk}:${hashString(derived)}\n`);
        }
      })();
      if (!hasMore) break;
    }

    return {
      counts,
      inputDigestSha256: inputDigest.digest('hex'),
      outputDigestSha256: outputDigest.digest('hex'),
      ...(hasMore ? { cursor: String(lastItemPk) } : {}),
    };
  }

  /**
   * Replaces one connector-owned namespace inside search_text without touching
   * content, trust, ownership, placement, or any other metadata. This is the
   * representation-refresh seam for facets whose source truth still lives in
   * a connector/archive rather than in the schema-v9 store.
   */
  refreshOwnedSearchTextFacets(
    records: readonly ConnectorStoreOwnedSearchFacetRefreshRecord[],
    options: { journalId?: string; journalLeaseGeneration?: number } = {},
  ): ConnectorStoreOwnedSearchFacetRefreshSummary {
    if (!Array.isArray(records) || records.length > 100_000) {
      throw new TypeError('Connector store facet refresh accepts at most 100,000 records.');
    }
    const counts = {
      itemsScanned: 0,
      itemsRefreshed: 0,
      itemsUnchanged: 0,
      itemsMissing: 0,
      ftsRowsRefreshed: 0,
      chunkEmbeddingInputsInvalidated: 0,
    };
    const matchedLocalItemIds: string[] = [];
    const refreshedLocalItemIds: string[] = [];
    const seen = new Set<string>();
    const journalId = normalizeMaintenanceJournalId(options.journalId);
    const journalLeaseGeneration = normalizeMaintenanceJournalLeaseGeneration(
      journalId,
      options.journalLeaseGeneration,
    );

    this.db.transaction(() => {
      const priorJournal = journalId
        ? this.db.query(`
            SELECT status, cursor, audit_receipt_sha256
            FROM sync_runs
            WHERE sync_run_id = ? AND connector_id = ?
          `).get(journalId, 'connector_store_owned_search_facet_refresh') as {
            status: string;
            cursor: string | null;
            audit_receipt_sha256: string | null;
          } | null
        : null;
      if (priorJournal && priorJournal.status !== 'completed') {
        throw new Error('Connector store facet-refresh journal is not terminal.');
      }
      if (priorJournal
        && priorJournal.audit_receipt_sha256 !== hashString(priorJournal.cursor ?? '')) {
        throw new Error('Connector store facet-refresh journal CAS state is corrupt.');
      }
      const prior = priorJournal
        ? parseFacetRefreshJournal(priorJournal.cursor)
        : undefined;
      if (prior && journalLeaseGeneration! < prior.leaseGeneration) {
        throw new Error('Connector store facet-refresh journal lease generation was superseded.');
      }
      const priorCounts = prior?.counts;
      const select = this.db.query(`
        SELECT item_pk, local_item_id, search_text, title, mime_type,
          authored_at, updated_at
        FROM items
        WHERE provider = ? AND account_scope = ?
          AND normalized_conversation = ? AND provider_item_id = ?
          AND tombstoned = 0
        LIMIT 1
      `);
      const update = this.db.query('UPDATE items SET search_text = ? WHERE item_pk = ?');
      for (const record of records) {
        const prefix = normalizeFacetNamespacePrefix(record.namespacePrefix);
        const literalEscapePrefix = normalizeFacetLiteralEscapePrefix(
          record.literalEscapePrefix,
          prefix,
        );
        const exactLines = normalizeOwnedFacetLines(record.exactLines, prefix);
        const identity = record.sourceItem;
        const identityKey = [
          identity.provider,
          identity.accountScope,
          normalizeConversationId(identity.providerConversationId),
          identity.providerItemId,
          prefix,
        ].join('\0');
        if (seen.has(identityKey)) {
          throw new Error('Connector store facet refresh contains a duplicate item namespace.');
        }
        seen.add(identityKey);
        counts.itemsScanned += 1;
        const row = select.get(
          identity.provider,
          identity.accountScope,
          normalizeConversationId(identity.providerConversationId),
          identity.providerItemId,
        ) as {
          item_pk: number;
          local_item_id: string;
          search_text: string | null;
          title: string | null;
          mime_type: string | null;
          authored_at: string | null;
          updated_at: string | null;
        } | null;
        if (!row) {
          counts.itemsMissing += 1;
          continue;
        }
        matchedLocalItemIds.push(row.local_item_id);
        if (priorCounts) continue;
        const exactLineSet = new Set(exactLines);
        const preserved = (row.search_text ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .flatMap((line) => {
            if (!line.startsWith(prefix)) return [line];
            // Authoritative encoder output is reinstalled below. Every other
            // historical line in the reserved namespace is ordinary literal
            // text from before escaping existed and must survive as escaped.
            return exactLineSet.has(line) ? [] : [`${literalEscapePrefix}${line}`];
          });
        // Owned facet values are case-sensitive. Do not pass these through the
        // ordinary alias merger, whose case-insensitive dedupe is intentional
        // for human-readable aliases but would collapse distinct facet keys.
        const refreshedLines = [...new Set([...preserved, ...exactLines])];
        const refreshed = refreshedLines.length > 0 ? refreshedLines.join('\n') : null;
        if (row.search_text === refreshed) {
          counts.itemsUnchanged += 1;
          continue;
        }
        update.run(refreshed, row.item_pk);
        counts.chunkEmbeddingInputsInvalidated += this.reseasonItemEmbeddingInputs(row.item_pk, {
          title: row.title,
          search_text: refreshed,
          mime_type: row.mime_type,
          authored_at: row.authored_at,
          updated_at: row.updated_at,
        });
        counts.ftsRowsRefreshed += this.refreshFtsForItem(row.item_pk);
        counts.itemsRefreshed += 1;
        refreshedLocalItemIds.push(row.local_item_id);
      }
      if (priorCounts) {
        if (priorCounts.itemsScanned !== records.length
          || priorCounts.itemsMissing !== counts.itemsMissing) {
          throw new Error('Connector store facet-refresh journal input changed.');
        }
        Object.assign(counts, priorCounts);
        return;
      }
      if (journalId) {
        const completedAt = this.now().toISOString();
        const cursor = JSON.stringify({
          kind: 'connector_store_owned_search_facet_refresh_v2',
          leaseGeneration: journalLeaseGeneration,
          counts,
        });
        this.db.query(`
          INSERT INTO sync_runs (
            sync_run_id, corpus_id, connector_id, status, cursor,
            items_seen, items_indexed, started_at, completed_at,
            audit_receipt_sha256
          ) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)
        `).run(
          journalId,
          this.corpusId,
          'connector_store_owned_search_facet_refresh',
          cursor,
          counts.itemsScanned,
          counts.itemsRefreshed,
          completedAt,
          completedAt,
          hashString(cursor),
        );
      }
    })();

    return { counts, matchedLocalItemIds, refreshedLocalItemIds };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_runs (
        sync_run_id TEXT PRIMARY KEY,
        corpus_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        status TEXT NOT NULL,
        cursor TEXT,
        items_seen INTEGER NOT NULL DEFAULT 0,
        items_indexed INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        audit_receipt_sha256 TEXT
      );
    `);
    createConversationScopedItemsTable(this.db, 'items', true);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_items_local_item_id ON items(local_item_id);
      CREATE TABLE IF NOT EXISTS chunks (
        chunk_pk INTEGER PRIMARY KEY,
        item_pk INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        bounded_text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding_input_hash TEXT,
        indexed_at TEXT NOT NULL,
        UNIQUE(item_pk, chunk_index),
        FOREIGN KEY(item_pk) REFERENCES items(item_pk) ON DELETE CASCADE
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS connector_store_fts USING fts5(
        title,
        bounded_text,
        item_pk UNINDEXED,
        chunk_pk UNINDEXED,
        ${SOURCE_INDEX_FTS5_TOKENIZER}
      );
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_pk INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        item_pk INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        embedding BLOB NOT NULL,
        embedded_at TEXT NOT NULL,
        PRIMARY KEY (chunk_pk, model_id),
        FOREIGN KEY(chunk_pk) REFERENCES chunks(chunk_pk) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_connector_store_chunk_embeddings_item
        ON chunk_embeddings(item_pk, model_id);
      -- Model-leading: "does model X hold any vector here" is asked on every
      -- dashboard poll by the availability probe, and a model that has just
      -- been switched to holds none, which without this index is a full scan
      -- of the previous model's vectors on each poll.
      CREATE INDEX IF NOT EXISTS idx_connector_store_chunk_embeddings_model
        ON chunk_embeddings(model_id);
    `);
    createItemOwnersTable(this.db);
    addColumnIfMissing(this.db, 'sync_runs', 'audit_receipt_sha256', 'TEXT');
    addColumnIfMissing(this.db, 'items', 'search_text', 'TEXT');
    addColumnIfMissing(this.db, 'chunks', 'embedding_input_hash', 'TEXT');
    this.db.query(`
      UPDATE chunks SET embedding_input_hash = content_hash
      WHERE embedding_input_hash IS NULL
    `).run();
  }

  // --- Sync -----------------------------------------------------------------

  async syncFromConnector(
    connector: SourceConnector,
    options?: ConnectorStoreSyncOptions,
  ): Promise<ConnectorStoreSyncSummary> {
    if (connector.family !== this.family) {
      throw new Error(
        `Connector store ${this.corpusId} is declared for family "${this.family}" `
        + `but connector "${connector.id}" reports family "${connector.family}".`,
      );
    }
    const maxItems = normalizeMaxItems(options?.maxItems);
    const maxChunkChars = normalizeMaxChunkChars(options?.maxChunkChars);
    const fetchContent = options?.fetchContent === true;
    const deferMetadataOnlyContent = options?.deferMetadataOnlyContent === true;
    const classification = normalizeClassificationOptions(options?.classification);
    const ownershipKind = options?.ownershipKind ?? 'observed';
    const reconcileAbsenceAuthority = options?.reconcileAbsenceAuthority ?? 'complete_snapshot';
    const reconcileCurrentMembershipAuthority = options?.reconcileCurrentMembershipAuthority ?? 'connector_owned';
    const reconcileSnapshotObservedAt = normalizeOptionalSnapshotTimestamp(
      options?.reconcileSnapshotObservedAt,
    );
    const reconcileSnapshotCompletedAt = normalizeOptionalSnapshotTimestamp(
      options?.reconcileSnapshotCompletedAt,
    );
    const reconcileWindowBoundarySha256 = normalizeOptionalSha256(
      options?.reconcileWindowBoundarySha256,
      'Connector window-boundary receipt',
    );
    const reconcileWindowRemovedLocalItemIds = normalizeWindowRemovedLocalItemIds(
      options?.reconcileWindowRemovedLocalItemIds,
    );
    const auditReceiptSha256 = normalizeOptionalSha256(options?.auditReceiptSha256, 'Connector sync audit receipt');

    const configuredFullSnapshotScopes = normalizeFullSnapshotScopes(options?.reconcileFullSnapshotScope);
    assertCurrentMembershipAuthority({
      reconcileFullSnapshot: options?.reconcileFullSnapshot === true,
      absenceAuthority: reconcileAbsenceAuthority,
      currentMembershipAuthority: reconcileCurrentMembershipAuthority,
      scopes: configuredFullSnapshotScopes,
      snapshotObservedAt: reconcileSnapshotObservedAt,
      snapshotCompletedAt: reconcileSnapshotCompletedAt,
      windowBoundarySha256: reconcileWindowBoundarySha256,
      windowRemovedLocalItemIds: reconcileWindowRemovedLocalItemIds,
    });

    await connector.authenticate();

    const syncRunId = `connector-sync-${randomUUID()}`;
    const startedAt = nowIso();
    this.db.query(`
      INSERT INTO sync_runs (
        sync_run_id, corpus_id, connector_id, status, cursor, items_seen,
        items_indexed, started_at, audit_receipt_sha256
      ) VALUES (?, ?, ?, 'running', ?, 0, 0, ?, ?)
    `).run(syncRunId, this.corpusId, connector.id, options?.cursor ?? null, startedAt, auditReceiptSha256 ?? null);

    let itemsSeen = 0;
    let itemsIndexed = 0;
    let itemsChanged = 0;
    let itemsTombstoned = 0;
    let absenceItemsTombstoned = 0;
    let windowRemovedItemsTombstoned = 0;
    let windowRemovalsDeferredLocalItemIds: readonly string[] = [];
    let deletedEventItemsTombstoned = 0;
    let secretsTierItemsTombstoned = 0;
    let itemsDemoted = 0;
    let itemsRejected = 0;
    let chunksIndexed = 0;
    const exclusionTally = createExclusionTally(this.exclusions, 'exclude');
    const metadataOnlyTally = createExclusionTally(this.exclusions, 'metadata_only');
    let checkpoint = options?.cursor;
    let sawDonePage = false;
    let consecutiveContentFetchFailures = 0;
    const gaps: string[] = [];
    const coverageGaps: ConnectorStoreCoverageGap[] = [];
    const fullSnapshotScopes = new Map<string, ConnectorStoreFullSnapshotScope>();
    for (const scope of configuredFullSnapshotScopes) {
      rememberFullSnapshotScope(fullSnapshotScopes, scope);
    }
    const configuredProviderAccountScopes = new Set(
      configuredFullSnapshotScopes.map((scope) => fullSnapshotScopeKey(scope)),
    );

    try {
      // A store upgraded into the locator identity projection arrives gated and
      // empty, because that backfill deliberately does not run at worker boot.
      // Converge it here, before the first item is read, so a path-only
      // deletion carried by this very pass can resolve its stable identity.
      // The cheap state read keeps a converged store at zero extra cost.
      if (!this.locatorIdentityIndexState().completed) {
        const converged = await this.ensureLocatorIdentityIndexReady();
        if (converged.state !== 'ready') {
          gaps.push(
            'locator_identity_index_backfill_incomplete: the shared locator identity projection is '
            + 'still converging, so path-only provider deletions were preserved rather than applied.',
          );
        }
      }
      const listOptions: SourceConnectorListOptions = {
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        ...(maxItems !== undefined ? { limit: maxItems } : {}),
      };
      for await (const page of connector.listItems(listOptions)) {
        // The contract has no arm for it, so this can only be reached from a
        // connector that crossed a type boundary. It stays because the
        // consequence is silent and permanent: the spine keeps a done page's
        // cursor as the checkpoint, so a done-and-truncated page discards the
        // resume point for data it never read.
        assertPageNotTruncatedAndDone(page, connector.id);
        let pageFullyConsumed = true;
        for (const item of page.items) {
          if (maxItems !== undefined && itemsSeen >= maxItems) {
            pageFullyConsumed = false;
            break;
          }
          itemsSeen += 1;
          // SQLite's item work is synchronous. Yield between bounded groups so
          // a large metadata page cannot starve the Bun HTTP server that owns
          // this same event loop. Put the yield before item handling so every
          // disposition — excluded, deleted, rejected, or indexed — shares the
          // same fairness bound.
          if (
            itemsSeen > 1
            && (itemsSeen - 1) % CONNECTOR_SYNC_COOPERATIVE_YIELD_ITEMS === 0
          ) {
            await yieldConnectorSyncTurn();
          }

          // FIRST, before content is fetched, before classification, before
          // any scope or allowlist is consulted. Enforcing here is what makes
          // the saving real rather than cosmetic: an excluded item costs one
          // string comparison and never becomes a download, a chunk, a vector,
          // or an extraction candidate.
          const exclusion = this.exclusions.evaluateMetadata(item.metadata);
          if (exclusion.excluded) {
            tallyExclusion(exclusionTally, exclusion);
            continue;
          }
          // The third disposition. The item IS admitted from here on — it takes
          // the ordinary classification, tombstone and upsert path, so its
          // title, path and timestamps are indexed exactly like any other
          // item's. What it never does is acquire content: the pre-fetch below
          // is skipped, `indexItemContent` is not called, and the store's own
          // chunk-write refusal makes any later attempt a defect rather than a
          // quiet re-read.
          const metadataOnly = exclusion.disposition === 'metadata_only';
          if (metadataOnly) tallyExclusion(metadataOnlyTally, exclusion);

          let itemForStorage = item;
          let contentFetchFailed = false;
          if (
            !metadataOnly
            && !deferMetadataOnlyContent
            && classification
            && fetchContent
            && item.content.kind === 'metadata_only'
          ) {
            try {
              itemForStorage = await connector.fetchItem(item.identity.localItemId);
              consecutiveContentFetchFailures = 0;
            } catch {
              contentFetchFailed = true;
              consecutiveContentFetchFailures += 1;
              gaps.push(contentFetchFailedGap(item));
              assertContentFetchFailureBudget(consecutiveContentFetchFailures);
            }
          }

          // Default contract behavior still uses connector.classify(). When a
          // shared classification policy is supplied, the spine applies it
          // locally over metadata plus any pre-fetched text before storing or
          // embedding content. That keeps Google-style per-item routing out of
          // source-specific downstream code.
          const sensitivity = classifyConnectorStoreItem(connector, itemForStorage, classification);
          if (sensitivity.trustDomain !== this.trustDomain) {
            // Cross-tier deletion requires classification evidence at least as
            // complete as the copy this store accepted. A failed fetch, an
            // owner-authored metadata-only rule, a shared classifier handed
            // only a listing stub, or a provider that answered 200 with an
            // empty body can reject this observation but cannot prove that
            // the stored body moved domains. The last case matters because it
            // throws nothing: it passes the fetch-failure checks while the
            // classification it feeds was computed from strictly less input
            // than the body this store accepted and chunked.
            const stored = this.activeStoredCopy(itemForStorage);
            // In connector-classify mode the connector is the classification
            // authority and does not derive its verdict from the fetched
            // body, so only the shared-classifier mode demands one: there the
            // verdict is computed from exactly the text handed over, and a
            // stub or empty body means it was computed from strictly less
            // than the accepted copy.
            const demotionInputHasAcceptedFidelity = !contentFetchFailed
              && !metadataOnly
              && (classification === undefined
                || (itemForStorage.content.kind !== 'metadata_only'
                  && (stored === undefined || stored.chunkCount === 0 || rawItemHasBody(itemForStorage))));
            if (demotionInputHasAcceptedFidelity && this.tombstoneItem(
              itemForStorage,
              connector.id,
              ownershipKind,
              syncRunId,
              // The tombstone records the more sensitive of the two readings.
              // In the demoting direction they agree; in the reverse
              // direction a stored S4 body must not be relabeled with the S3
              // the new classification computed.
              maxTrustTier(stored?.trustTier, sensitivity.trustTier),
              true,
            )) {
              itemsDemoted += 1;
              itemsTombstoned += 1;
              gaps.push(trustDomainMismatchGap(
                itemForStorage,
                sensitivity.trustDomain,
                this.trustDomain,
                'stored copy demoted and tombstoned',
              ));
            } else if (stored !== undefined) {
              // The receipt must let an operator tell a refusal that left a
              // readable cross-domain copy in place apart from a first
              // observation that never had anything to remove.
              itemsRejected += 1;
              gaps.push(trustDomainMismatchGap(
                itemForStorage,
                sensitivity.trustDomain,
                this.trustDomain,
                'demotion refused on degraded input; stale stored copy retained',
              ));
            } else {
              // A first observation still has nothing to remove from this
              // store. It remains an ordinary fail-closed rejection.
              itemsRejected += 1;
              gaps.push(trustDomainMismatchGap(itemForStorage, sensitivity.trustDomain, this.trustDomain));
            }
            continue;
          }
          if (
            reconcileCurrentMembershipAuthority === 'provider_account_snapshot'
            || reconcileCurrentMembershipAuthority === 'provider_window_snapshot'
          ) {
            if (!configuredProviderAccountScopes.has(fullSnapshotScopeKey(itemForStorage.identity))) {
              throw new Error(
                'Provider/account current-membership reconciliation received an item outside its explicit scope.',
              );
            }
          } else {
            rememberFullSnapshotScope(fullSnapshotScopes, itemForStorage.identity);
          }

          if (itemForStorage.metadata['deleted'] === true) {
            const identityWasResolved = itemForStorage.metadata['deletedIdentityResolved'] !== false;
            if (this.tombstoneItem(
              itemForStorage,
              connector.id,
              ownershipKind,
              syncRunId,
              undefined,
              !identityWasResolved,
            )) {
              itemsTombstoned += 1;
              deletedEventItemsTombstoned += 1;
            } else {
              itemsRejected += 1;
              gaps.push('deleted_event_target_missing: provider deletion did not match an active stored item.');
            }
            continue;
          }

          if (sensitivity.trustTier === 'S5') {
            this.tombstoneItem(itemForStorage, connector.id, ownershipKind, syncRunId, 'S5');
            itemsTombstoned += 1;
            secretsTierItemsTombstoned += 1;
            gaps.push(secretsTierExcludedGap(itemForStorage));
            continue;
          }

          // The identity rewrite and its connector ownership are one durable
          // fact. Committing them separately leaves a crash window where a
          // rewritten item is visible without the owner that observed it.
          // Existing owners belong to other connectors and remain untouched.
          const upsert = this.upsertItemWithOwner(
            itemForStorage,
            sensitivity,
            connector.id,
            ownershipKind,
            syncRunId,
            options?.ownerObservation ?? 'provider_listing',
            deferMetadataOnlyContent && itemForStorage.content.kind === 'metadata_only',
            false,
            deferMetadataOnlyContent && itemForStorage.content.kind === 'metadata_only',
          );
          itemsIndexed += 1;
          let itemChanged = upsert.contentChanged;

          let ftsContentChanged = false;
          if (
            fetchContent
            && !contentFetchFailed
            && !metadataOnly
            && (!deferMetadataOnlyContent || itemForStorage.content.kind !== 'metadata_only')
          ) {
            const indexed = await this.indexItemContent(
              connector,
              itemForStorage,
              upsert.itemPk,
              maxChunkChars,
              gaps,
              () => {
                consecutiveContentFetchFailures += 1;
                assertContentFetchFailureBudget(consecutiveContentFetchFailures);
              },
              () => {
                consecutiveContentFetchFailures = 0;
              },
            );
            if (indexed.secretsTierExcluded) {
              // Same disposition as the listing-time S5 rule at the top of the
              // loop: the row is tombstoned rather than kept as an indexed
              // item, so it is counted there and not here.
              this.tombstoneItem(itemForStorage, connector.id, ownershipKind, syncRunId, 'S5');
              itemsIndexed -= 1;
              itemsTombstoned += 1;
              secretsTierItemsTombstoned += 1;
              gaps.push(secretsTierExcludedGap(itemForStorage));
              continue;
            }
            chunksIndexed += indexed.chunksIndexed;
            ftsContentChanged = indexed.ftsContentChanged;
          }
          // Body text can change under an unchanged metadata hash, so the
          // chunk-level verdict counts too.
          if (ftsContentChanged) itemChanged = true;
          if (itemChanged) itemsChanged += 1;
        }

        // A checkpoint is only durable once the whole page is in the store.
        // Stopping mid-page keeps the previous checkpoint so a resume replays
        // the partial page instead of silently skipping its tail.
        if (!pageFullyConsumed) {
          // Reachable only from a connector that handed back more than the
          // limit it was given: the contract's answer to a budget running out
          // mid-page is `truncated` with a cursor that resumes inside it.
          // Keeping the checkpoint stays right — the tail was never read — but
          // every later bounded pass then re-reads the same prefix and never
          // reaches the rest, so the stall is named instead of being reported
          // as one more clean completed run with an unmoved cursor.
          gaps.push(pageAbandonedGap(connector.id));
        } else if (page.done) {
          // High-water-mark connectors (live chat spools) put the resume
          // point on the DONE page; token-paginated connectors leave it
          // unset. Take it as-is: clearing unconditionally broke live-drain
          // resume (whatsapp spool cursors) on 2026-07-06.
          checkpoint = page.nextCursor;
          sawDonePage = true;
        } else if (page.nextCursor) {
          checkpoint = page.nextCursor;
        }
        if (!pageFullyConsumed || page.done) break;
        if (maxItems !== undefined && itemsSeen >= maxItems) break;
      }

      if (options?.reconcileFullSnapshot === true) {
        const canReconcile = options?.cursor === undefined && maxItems === undefined && sawDonePage;
        if (reconcileAbsenceAuthority === 'partial_window') {
          coverageGaps.push({
            kind: 'absence_not_authoritative',
            absenceAuthority: 'partial_window',
            reason: 'provider_coverage_window_partial',
          });
          gaps.push('coverage_gap: absence_not_authoritative; provider coverage window is partial, so omitted items were preserved.');
          // A reconcile is an un-cursored pass from the start of the listing,
          // bounded only by the connector's own ceiling. Whatever position it
          // stopped at is BEHIND the incremental lane's, so persisting it as
          // this run's cursor hands the lane a resume point that walks it
          // backwards — the shape that capped a Drive corpus at roughly one
          // ceiling per reconcile interval. Every other arm below already
          // clears it; this one skipped the clear because it returns early.
          checkpoint = undefined;
        } else if (canReconcile) {
          const scopes = Array.from(fullSnapshotScopes.values());
          if (scopes.length === 0) {
            gaps.push('full_snapshot_reconcile_skipped: no provider/account scope was observed or provided.');
          } else if (reconcileCurrentMembershipAuthority === 'provider_window_snapshot') {
            // A moving provider window proves current membership only for the
            // IDs returned inside that window. Missing older rows are UNKNOWN:
            // no account-wide absence candidate may be tombstoned.
            const windowRemovals = this.tombstoneWindowRemovedItems(
              connector.id,
              ownershipKind,
              syncRunId,
              scopes,
              reconcileWindowRemovedLocalItemIds,
              reconcileSnapshotObservedAt,
            );
            itemsTombstoned += windowRemovals.tombstoned;
            windowRemovedItemsTombstoned = windowRemovals.tombstoned;
            windowRemovalsDeferredLocalItemIds = windowRemovals.deferredLocalItemIds;
            if (windowRemovals.preservationOwnedPreserved > 0) {
              gaps.push(
                'coverage_gap: window_removal_preservation_owned_preserved; '
                + `${windowRemovals.preservationOwnedPreserved} item(s) proven absent from the provider `
                + 'window were kept because an archive preservation owner holds the only copy.',
              );
            }
            if (windowRemovals.newerObservationPreserved > 0) {
              gaps.push(
                'coverage_gap: window_removal_newer_observation_preserved; '
                + `${windowRemovals.newerObservationPreserved} item(s) proven absent from the provider `
                + 'window were kept because an owner observed them at or after the snapshot cutoff.',
              );
            }
            checkpoint = undefined;
          } else {
            absenceItemsTombstoned = this.tombstoneItemsMissingFromFullSnapshot(
              connector.id,
              syncRunId,
              scopes,
              reconcileCurrentMembershipAuthority,
              reconcileSnapshotObservedAt,
            );
            itemsTombstoned += absenceItemsTombstoned;
            checkpoint = undefined;
          }
        } else {
          gaps.push('full_snapshot_reconcile_skipped: sync was cursored, bounded, or did not reach a done page.');
        }
      }
    } catch (error) {
      this.db.query(`
        UPDATE sync_runs
        SET status = 'failed', cursor = ?, items_seen = ?, items_indexed = ?, completed_at = ?, error = ?
        WHERE sync_run_id = ?
      `).run(checkpoint ?? null, itemsSeen, itemsIndexed, nowIso(), errorMessage(error), syncRunId);
      throw error;
    }

    this.db.query(`
      UPDATE sync_runs
      SET status = 'completed', cursor = ?, items_seen = ?, items_indexed = ?, completed_at = ?
      WHERE sync_run_id = ?
    `).run(checkpoint ?? null, itemsSeen, itemsIndexed, nowIso(), syncRunId);

    // ONE gap per rule, at the end, rather than one per item. A per-item gap
    // would put tens of thousands of lines into a receipt whose whole purpose
    // is to be read, and the fact worth reporting is the same either way: this
    // rule accounted for this many items with no content.
    for (const row of metadataOnlyTally.byPrefix.values()) {
      if (row.items === 0) continue;
      coverageGaps.push({ kind: 'metadata_only_by_rule', ruleId: row.ruleId, items: row.items });
      gaps.push(
        `coverage_gap: metadata_only_by_rule; rule ${row.ruleId} admitted ${row.items} item(s) `
        + 'with metadata only; their content is never read, by configuration.',
      );
    }
    if (metadataOnlyTally.unevaluable > 0) {
      // Items a metadata-only rule could not be answered for. They were treated
      // as metadata-only, which is the softer-but-still-applied direction, and
      // an operator who sees this knows a criterion went unanswered rather than
      // matching nothing.
      gaps.push(
        `coverage_gap: metadata_only_by_rule; ${metadataOnlyTally.unevaluable} item(s) could not be `
        + 'evaluated against a metadata-only rule and were admitted without content.',
      );
    }

    return {
      syncRunId,
      corpusId: this.corpusId,
      connectorId: connector.id,
      status: 'completed',
      itemsSeen,
      itemsIndexed,
      itemsChanged,
      itemsTombstoned,
      absenceItemsTombstoned,
      windowRemovedItemsTombstoned,
      windowRemovalsDeferredLocalItemIds,
      deletedEventItemsTombstoned,
      secretsTierItemsTombstoned,
      itemsDemoted,
      itemsRejected,
      itemsExcluded: exclusionTally.total,
      exclusions: exclusionCounts(exclusionTally),
      itemsMetadataOnly: metadataOnlyTally.total,
      metadataOnly: exclusionCounts(metadataOnlyTally),
      chunksIndexed,
      ...(checkpoint ? { cursor: checkpoint } : {}),
      // Deliberately NOT derived from `checkpoint`: the reconcile arms above
      // clear it as a matter of policy, so reading completion off the cursor
      // turns every truncated reconcile into a claimed full traversal.
      traversalComplete: sawDonePage,
      gaps,
      coverageGaps,
      policy: {
        rawSourceExposed: false,
        sourceTextReturned: false,
        trustDomain: this.trustDomain,
        storage: 'local_sqlite',
      },
    };
  }

  private upsertItem(
    item: RawItem,
    sensitivity: SourceSensitivity,
    syncRunId: string,
    preserveStoredSearchText = false,
    preserveStoredSearchTextOwnedFacets = false,
    preserveStoredContentHash = false,
  ): { itemPk: number; ftsMetadataChanged: boolean; contentChanged: boolean } {
    // The structural half of "exclusion beats inclusion". Every write into
    // this store reaches this line, and there is no option, scope, or
    // allowlist consulted after it that can put an excluded item back. A
    // caller that enumerates items is expected to have checked and counted
    // already; reaching here means a write path skipped the gate, which is a
    // defect rather than an item-level condition.
    const exclusion = this.exclusions.evaluateMetadata(item.metadata);
    if (exclusion.excluded) throw new ConnectorStoreExclusionViolationError(exclusion.ruleId);

    const identity = item.identity;
    const meta = item.metadata;
    const title = itemTitle(item);
    const sender = senderMetadataFromRawItem(item);
    const locatorUri =
      metadataString(meta, 'locatorUri') ?? metadataString(meta, 'pathDisplay') ?? metadataString(meta, 'url');
    // sentAt is the chat-family idiom (WhatsApp live, message connectors);
    // without it every chat item lands with NULL authored_at, citations
    // carry no time, and temporal evidence ordering has nothing to sort on
    // (2026-07-05 "did I just get..." acceptance miss).
    const authoredAt = metadataString(meta, 'authoredAt')
      ?? metadataString(meta, 'sentAt')
      ?? metadataString(meta, 'clientModifiedAt');
    const updatedAt = metadataString(meta, 'updatedAt') ?? metadataString(meta, 'serverModifiedAt');
    const emittedContentHash =
      metadataString(meta, 'contentHash')
      ?? (item.content.kind === 'text' ? hashString(item.content.text) : undefined);
    const now = nowIso();
    // Validated before the write, so an unbounded or malformed aggregate is
    // refused with a typed error instead of landing in the column.
    const suppliedReactions = normalizeSourceReactions(meta['reactions']);
    const existing = this.db.query(`
      SELECT item_pk, title, search_text, reactions_json, tombstoned, content_hash
      FROM items
      WHERE provider = ? AND account_scope = ?
        AND normalized_conversation = ? AND provider_item_id = ?
    `).get(
      identity.provider,
      identity.accountScope,
      normalizeConversationId(identity.providerConversationId),
      identity.providerItemId,
    ) as {
      item_pk: number;
      title: string | null;
      search_text: string | null;
      reactions_json: string | null;
      tombstoned: number;
      content_hash: string | null;
    } | null;
    const contentHash = preserveStoredContentHash && emittedContentHash === undefined
      ? existing?.content_hash ?? undefined
      : emittedContentHash;

    // An emit that says nothing about reactions leaves the stored aggregate
    // alone: connectors that know nothing about reactions (and re-emit paths
    // like representation restore) must not be able to erase them. Removal is
    // said explicitly, with an empty array.
    const reactions = suppliedReactions ?? parseStoredSourceReactions(existing?.reactions_json);
    const reactionsJson = serializeSourceReactions(reactions);
    const emittedSearchText = itemSearchText(item, title, renderSourceReactionLine(reactions));
    const searchText = preserveStoredSearchText
      ? mergeSearchTextLines(
          existing?.search_text,
          emittedSearchText,
          storedSearchTextLiteralEscapes(item.metadata),
          preserveStoredSearchTextOwnedFacets,
        )
      : emittedSearchText;

    const applied = this.db.query(`
      INSERT INTO items (
        provider, family, account_scope, provider_item_id, provider_thread_id, provider_conversation_id,
        provider_file_id, provider_event_id, local_item_id, source_version, title, search_text,
        reactions_json, sender_id, sender_label, sender_is_owner, locator_uri, mime_type,
        authored_at, updated_at,
        fetched_at, indexed_at, content_hash, trust_tier, tombstoned, deleted_at, sync_run_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
      ON CONFLICT(provider, account_scope, normalized_conversation, provider_item_id) DO UPDATE SET
        provider_thread_id = excluded.provider_thread_id,
        provider_conversation_id = excluded.provider_conversation_id,
        provider_file_id = excluded.provider_file_id,
        provider_event_id = excluded.provider_event_id,
        local_item_id = excluded.local_item_id,
        source_version = excluded.source_version,
        title = excluded.title,
        search_text = excluded.search_text,
        reactions_json = excluded.reactions_json,
        sender_id = excluded.sender_id,
        sender_label = excluded.sender_label,
        sender_is_owner = excluded.sender_is_owner,
        locator_uri = excluded.locator_uri,
        mime_type = excluded.mime_type,
        authored_at = excluded.authored_at,
        updated_at = excluded.updated_at,
        fetched_at = excluded.fetched_at,
        indexed_at = excluded.indexed_at,
        content_hash = excluded.content_hash,
        trust_tier = excluded.trust_tier,
        tombstoned = 0,
        deleted_at = NULL,
        sync_run_id = excluded.sync_run_id
    `).run(
      identity.provider,
      identity.family,
      identity.accountScope,
      identity.providerItemId,
      identity.providerThreadId ?? null,
      identity.providerConversationId ?? null,
      identity.providerFileId ?? null,
      identity.providerEventId ?? null,
      identity.localItemId,
      identity.sourceVersion ?? null,
      title ?? null,
      searchText ?? null,
      reactionsJson,
      sender.senderId ?? null,
      sender.senderLabel ?? null,
      sender.senderIsOwner === undefined ? null : Number(sender.senderIsOwner),
      locatorUri ?? null,
      item.mimeType,
      authoredAt ?? null,
      updatedAt ?? null,
      item.fetchedAt,
      now,
      contentHash ?? null,
      sensitivity.trustTier,
      syncRunId,
    );
    const itemPk = existing?.item_pk ?? Number(applied.lastInsertRowid);
    const ftsMetadataChanged = existing === null
      || existing.tombstoned === 1
      || existing.title !== (title ?? null)
      || existing.search_text !== (searchText ?? null);
    return {
      itemPk,
      ftsMetadataChanged,
      // Did this upsert change anything, or did it rewrite the row it already
      // had? Every health signal the store publishes counts writes, so a lane
      // re-indexing byte-identical rows forever reads as healthy progress —
      // which is how a Readwise restart loop ran for hours behind rising
      // `items_indexed`. Content hash is the primary test; the searchable
      // representation is included because a metadata-only item carries no
      // hash on either side and would otherwise always look unchanged.
      contentChanged: ftsMetadataChanged
        || existing.content_hash !== (contentHash ?? null),
    };
  }

  private upsertItemWithOwner(
    item: RawItem,
    sensitivity: SourceSensitivity,
    connectorId: string,
    ownershipKind: ConnectorStoreOwnershipKind,
    syncRunId: string,
    observation: ConnectorStoreOwnerObservation,
    preserveStoredSearchText = false,
    preserveStoredSearchTextOwnedFacets = false,
    preserveStoredContentHash = false,
  ): { itemPk: number; ftsMetadataChanged: boolean; contentChanged: boolean } {
    return this.db.transaction(() => {
      const upsert = this.upsertItem(
        item,
        sensitivity,
        syncRunId,
        preserveStoredSearchText,
        preserveStoredSearchTextOwnedFacets,
        preserveStoredContentHash,
      );
      // Ownership time is the actual application observation, not sync-run
      // start. A provider call can be slow; stamping the earlier start time
      // would let a concurrent snapshot incorrectly remove a newly seen item.
      this.rememberItemOwner(
        upsert.itemPk,
        connectorId,
        ownershipKind,
        syncRunId,
        this.now().toISOString(),
        observation,
      );
      // The keyword index for a metadata move belongs to the SAME commit as
      // the metadata. Split across two transactions, a crash in between left
      // the old title and search text in FTS for ever: replay finds the stored
      // metadata already equal to the incoming metadata, so `ftsMetadataChanged`
      // is false, and unchanged chunks mean the content path refreshes nothing
      // either. A later chunk replacement rebuilds these rows again, which is
      // cheap next to a permanently stale keyword index.
      if (upsert.ftsMetadataChanged) this.refreshFtsForItem(upsert.itemPk);
      return upsert;
    })();
  }

  private tombstoneWindowRemovedItems(
    connectorId: string,
    ownershipKind: ConnectorStoreOwnershipKind,
    syncRunId: string,
    scopes: readonly ConnectorStoreFullSnapshotScope[],
    localItemIds: readonly string[],
    snapshotObservedAt: string | undefined,
  ): {
    tombstoned: number;
    preservationOwnedPreserved: number;
    newerObservationPreserved: number;
    deferredLocalItemIds: string[];
  } {
    return this.db.transaction(() => {
      let count = 0;
      let preserved = 0;
      const deferred: string[] = [];
      const now = nowIso();
      for (const localItemId of localItemIds) {
        for (const scope of scopes) {
          const row = this.db.query(`
            SELECT
              i.item_pk AS item_pk,
              EXISTS (
                SELECT 1 FROM item_owners preservation
                WHERE preservation.item_pk = i.item_pk
                  AND preservation.ownership_kind = 'preservation'
              ) AS preservation_owned,
              EXISTS (
                SELECT 1 FROM item_owners newer_owner
                WHERE newer_owner.item_pk = i.item_pk
                  AND newer_owner.last_seen_at >= ?
              ) AS observed_after_snapshot
            FROM items i
            WHERE i.provider = ? AND i.account_scope = ?
              AND i.local_item_id = ? AND i.tombstoned = 0
          `).get(
            snapshotObservedAt ?? '',
            scope.provider,
            scope.accountScope,
            localItemId,
          ) as {
            item_pk: number;
            preservation_owned: number;
            observed_after_snapshot: number;
          } | null;
          if (!row) continue;
          // A proven in-window removal is not authority over an
          // archive-preserved copy. The provider's window drops an
          // un-bookmarked post, an author-deleted post and a post gone
          // protected identically, and in the last two the preserved copy is
          // the only one left — which is why the account-snapshot branch
          // refuses the same absence. The weaker authority may not destroy
          // what the stronger one is forbidden to touch.
          if (row.preservation_owned === 1) {
            preserved += 1;
            break;
          }
          // The snapshot proves absence as of ITS observation cutoff and
          // nothing later. An owner that saw this item at or after the cutoff
          // is newer evidence than the removal, so applying the removal now
          // would let a slow or retried reconcile delete a re-observed item —
          // the same race the account-snapshot branch already refuses.
          // Reported back by id, not merely counted. This is the ONE removal
          // transition the derivation can ever produce for this item, so a
          // caller that forgets it here has decided the item is permanent: the
          // next promotion drops the item from both the prior and the current
          // snapshot and the prior-present/current-absent overlap never names
          // it again.
          if (row.observed_after_snapshot === 1) {
            deferred.push(localItemId);
            break;
          }
          this.db.query(`
            UPDATE items
            SET tombstoned = 1, deleted_at = ?, indexed_at = ?, sync_run_id = ?
            WHERE item_pk = ?
          `).run(now, now, syncRunId, row.item_pk);
          this.db.query('DELETE FROM chunks WHERE item_pk = ?').run(row.item_pk);
          this.deleteFtsForItem(row.item_pk);
          this.rememberItemOwner(
            row.item_pk,
            connectorId,
            ownershipKind,
            syncRunId,
            now,
            'local_write',
          );
          count += 1;
          break;
        }
      }
      return {
        tombstoned: count,
        preservationOwnedPreserved: preserved,
        newerObservationPreserved: deferred.length,
        deferredLocalItemIds: deferred,
      };
    })();
  }

  private tombstoneItemsMissingFromFullSnapshot(
    connectorId: string,
    syncRunId: string,
    scopes: readonly ConnectorStoreFullSnapshotScope[],
    currentMembershipAuthority: ConnectorStoreCurrentMembershipAuthority,
    snapshotObservedAt: string | undefined,
  ): number {
    return this.db.transaction(() => {
      const now = nowIso();
      let count = 0;
      for (const scope of scopes) {
      const rows = currentMembershipAuthority === 'provider_account_snapshot'
        ? this.db.query(`
            SELECT DISTINCT i.item_pk
            FROM items i
            WHERE i.tombstoned = 0
              AND i.provider = ?
              AND i.account_scope = ?
              AND NOT EXISTS (
                SELECT 1 FROM item_owners current_owner
                WHERE current_owner.item_pk = i.item_pk
                  AND current_owner.last_seen_sync_run_id = ?
              )
              AND NOT EXISTS (
                SELECT 1 FROM item_owners newer_owner
                WHERE newer_owner.item_pk = i.item_pk
                  AND newer_owner.last_seen_at >= ?
              )
              AND NOT EXISTS (
                SELECT 1 FROM item_owners preservation
                WHERE preservation.item_pk = i.item_pk
                  AND preservation.ownership_kind = 'preservation'
              )
          `).all(
            scope.provider,
            scope.accountScope,
            syncRunId,
            snapshotObservedAt ?? '',
          ) as Array<{ item_pk: number }>
        : this.db.query(`
            SELECT DISTINCT i.item_pk
            FROM items i
            JOIN item_owners owner
              ON owner.item_pk = i.item_pk
              AND owner.connector_id = ?
            WHERE i.tombstoned = 0
              AND owner.last_seen_sync_run_id <> ?
              AND i.provider = ?
              AND i.account_scope = ?
              AND NOT EXISTS (
                SELECT 1 FROM item_owners preservation
                WHERE preservation.item_pk = i.item_pk
                  AND preservation.ownership_kind = 'preservation'
              )
          `).all(connectorId, syncRunId, scope.provider, scope.accountScope) as Array<{ item_pk: number }>;

        for (const row of rows) {
          this.db.query(`
            UPDATE items SET tombstoned = 1, deleted_at = ?, indexed_at = ?, sync_run_id = ? WHERE item_pk = ?
          `).run(now, now, syncRunId, row.item_pk);
          this.db.query('DELETE FROM chunks WHERE item_pk = ?').run(row.item_pk);
          this.deleteFtsForItem(row.item_pk);
        }
        count += rows.length;
      }
      return count;
    })();
  }

  // The active row this store holds for an incoming item's identity, with
  // just the facts cross-tier demotion needs: what tier the store recorded
  // and whether the accepted copy carried a body (chunks). Counts only —
  // no text leaves this method.
  private activeStoredCopy(
    item: RawItem,
  ): { trustTier: SourceTrustTier; chunkCount: number } | undefined {
    const identity = item.identity;
    const row = this.db.query(
      `SELECT i.trust_tier AS trust_tier,
              (SELECT COUNT(*) FROM chunks c WHERE c.item_pk = i.item_pk) AS chunk_count
       FROM items i
       WHERE i.provider = ? AND i.account_scope = ? AND i.normalized_conversation = ?
         AND i.provider_item_id = ? AND i.tombstoned = 0`,
    ).get(
      identity.provider,
      identity.accountScope,
      normalizeConversationId(identity.providerConversationId),
      identity.providerItemId,
    ) as { trust_tier: string; chunk_count: number } | null;
    if (!row) return undefined;
    return { trustTier: row.trust_tier as SourceTrustTier, chunkCount: row.chunk_count };
  }

  private tombstoneItem(
    item: RawItem,
    connectorId: string,
    ownershipKind: ConnectorStoreOwnershipKind,
    syncRunId: string,
    trustTier?: SourceTrustTier,
    activeOnly = false,
  ): boolean {
    return this.db.transaction(() => {
      const identity = item.identity;
      const now = nowIso();
      const tombstoneTrustTier = trustTier ?? conservativeTierForDomain(this.trustDomain);
      const existing = this.db.query(
        `SELECT item_pk, tombstoned FROM items
         WHERE provider = ? AND account_scope = ? AND normalized_conversation = ? AND provider_item_id = ?`,
      ).get(
        identity.provider,
        identity.accountScope,
        normalizeConversationId(identity.providerConversationId),
        identity.providerItemId,
      ) as { item_pk: number; tombstoned: number } | null;

      if (existing && (!activeOnly || existing.tombstoned === 0)) {
        this.db.query(`
          UPDATE items SET tombstoned = 1, deleted_at = ?, indexed_at = ?, trust_tier = ?, sync_run_id = ? WHERE item_pk = ?
        `).run(now, now, tombstoneTrustTier, syncRunId, existing.item_pk);
        this.db.query('DELETE FROM chunks WHERE item_pk = ?').run(existing.item_pk);
        this.deleteFtsForItem(existing.item_pk);
        this.rememberItemOwner(existing.item_pk, connectorId, ownershipKind, syncRunId, now, 'local_write');
        return true;
      }
      if (activeOnly) return false;

      // A tombstone for an item this store never saw still gets a row so a
      // later upsert of the same provider item id does not resurrect deleted
      // content without preserving its ownership history.
      this.db.query(`
        INSERT INTO items (
          provider, family, account_scope, provider_item_id, provider_conversation_id,
          local_item_id, mime_type, fetched_at, indexed_at, trust_tier,
          tombstoned, deleted_at, sync_run_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        identity.provider,
        identity.family,
        identity.accountScope,
        identity.providerItemId,
        identity.providerConversationId ?? null,
        identity.localItemId,
        item.mimeType,
        item.fetchedAt,
        now,
        tombstoneTrustTier,
        now,
        syncRunId,
      );
      const inserted = this.db.query(
        `SELECT item_pk FROM items
         WHERE provider = ? AND account_scope = ? AND normalized_conversation = ? AND provider_item_id = ?`,
      ).get(
        identity.provider,
        identity.accountScope,
        normalizeConversationId(identity.providerConversationId),
        identity.providerItemId,
      ) as { item_pk: number };
      this.rememberItemOwner(inserted.item_pk, connectorId, ownershipKind, syncRunId, now, 'local_write');
      return true;
    })();
  }

  /**
   * `last_seen_at` is the ONE column the window/account removal fences read as
   * "newer evidence than this snapshot's absence proof", so only a write that
   * genuinely re-observed the item at the provider may advance it.
   *
   * A representation restore — the extraction factory, X content recovery, the
   * archive restore — re-attaches text to an item that is already in the store
   * and says nothing about whether the provider still lists it. Advancing the
   * timestamp there let a recovery pass permanently shield posts the owner had
   * un-bookmarked: the removal was skipped as outranked, and snapshot
   * promotion then consumed the only transition that could emit it again.
   *
   * The residue is narrow and named: a non-observing write that CREATES an
   * owner row still stamps the row's own timestamps, because there is no
   * earlier observation to carry forward. Archive restores create
   * `preservation` rows, which the stronger preservation branch of the fence
   * refuses to remove anyway.
   */
  private rememberItemOwner(
    itemPk: number,
    connectorId: string,
    ownershipKind: ConnectorStoreOwnershipKind,
    syncRunId: string,
    observedAt: string,
    observation: ConnectorStoreOwnerObservation,
  ): void {
    this.db.query(`
      INSERT INTO item_owners (
        item_pk, connector_id, ownership_kind, first_seen_sync_run_id,
        last_seen_sync_run_id, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_pk, connector_id) DO UPDATE SET
        ownership_kind = CASE
          WHEN item_owners.ownership_kind = 'preservation' THEN 'preservation'
          ELSE excluded.ownership_kind
        END,
        last_seen_sync_run_id = excluded.last_seen_sync_run_id,
        last_seen_at = CASE
          WHEN ? = 1 THEN excluded.last_seen_at
          ELSE item_owners.last_seen_at
        END
    `).run(
      itemPk,
      requireNonEmpty(connectorId, 'Connector owner id'),
      ownershipKind,
      syncRunId,
      syncRunId,
      observedAt,
      observedAt,
      observation === 'provider_listing' ? 1 : 0,
    );
  }

  // Stores bounded chunk text for one item when it is text-able: the listed
  // item already carries text, or fetchItem returns text (or utf8-decodable
  // text bytes). Returns the number of chunks indexed; failures and
  // non-text-able content become gaps, never raised raw.
  private async indexItemContent(
    connector: SourceConnector,
    item: RawItem,
    itemPk: number,
    maxChunkChars: number,
    gaps: string[],
    onContentFetchFailure?: () => void,
    onContentFetchSuccess?: () => void,
  ): Promise<{ chunksIndexed: number; ftsContentChanged: boolean; secretsTierExcluded: boolean }> {
    let text = textFromRawItem(item);
    if (text === undefined && item.content.kind === 'metadata_only') {
      let fetched: RawItem;
      try {
        fetched = await connector.fetchItem(item.identity.localItemId);
        onContentFetchSuccess?.();
      } catch {
        gaps.push(contentFetchFailedGap(item));
        onContentFetchFailure?.();
        return { chunksIndexed: 0, ftsContentChanged: false, secretsTierExcluded: false };
      }
      // Fetched content gets its own classification: bytes can reveal more
      // than the listing did. A mismatched trust domain rejects the CONTENT
      // (fail closed) while the metadata row, which classified clean, stays.
      const fetchedSensitivity = connector.classify(fetched);
      if (fetchedSensitivity.trustDomain !== this.trustDomain) {
        gaps.push(trustDomainMismatchGap(fetched, fetchedSensitivity.trustDomain, this.trustDomain, 'content skipped'));
        return { chunksIndexed: 0, ftsContentChanged: false, secretsTierExcluded: false };
      }
      // The listing-time S5 rule governs whatever the fetch reveals — which is
      // the whole reason the body is re-classified here. Falling through would
      // chunk the secret, index it for keyword search and hand it to the
      // embedding provider, against a tier that is hard-denied everywhere
      // downstream. The caller tombstones and records the same gap the
      // listing-time rule does.
      if (fetchedSensitivity.trustTier === 'S5') {
        return { chunksIndexed: 0, ftsContentChanged: false, secretsTierExcluded: true };
      }
      this.db.query('UPDATE items SET trust_tier = ? WHERE item_pk = ?').run(fetchedSensitivity.trustTier, itemPk);
      text = textFromRawItem(fetched);
    }
    return { ...this.indexItemText(item, itemPk, maxChunkChars, text), secretsTierExcluded: false };
  }

  private indexKnownItemContent(
    item: RawItem,
    itemPk: number,
    maxChunkChars: number,
  ): { chunksIndexed: number; ftsContentChanged: boolean } {
    return this.indexItemText(item, itemPk, maxChunkChars, textFromRawItem(item));
  }

  // Citation-safe item metadata that seasons an embedding input, read from the
  // store so it is byte-identical to what embeddingSourceRows later hands the
  // provider. The RawItem-derived values are a fallback for a row that does
  // not exist yet; every current caller upserts the item first.
  private itemEmbeddingSeasoning(itemPk: number, item: RawItem): ConnectorStoreEmbeddingSeasoning {
    const row = this.db.query(`
      SELECT title, search_text, mime_type, authored_at, updated_at
      FROM items WHERE item_pk = ?
    `).get(itemPk) as ConnectorStoreEmbeddingSeasoning | null;
    if (row) return row;
    const title = itemTitle(item) ?? null;
    return {
      title,
      search_text: itemSearchText(item, title ?? undefined) ?? null,
      mime_type: item.mimeType,
      authored_at: metadataString(item.metadata, 'authoredAt')
        ?? metadataString(item.metadata, 'sentAt')
        ?? metadataString(item.metadata, 'clientModifiedAt')
        ?? null,
      updated_at: metadataString(item.metadata, 'updatedAt')
        ?? metadataString(item.metadata, 'serverModifiedAt')
        ?? null,
    };
  }

  private indexItemText(
    item: RawItem,
    itemPk: number,
    maxChunkChars: number,
    text: string | undefined,
  ): { chunksIndexed: number; ftsContentChanged: boolean } {
    // The single funnel every chunk this store writes passes through, which is
    // why the metadata-only refusal lives here rather than at each caller. A
    // gate that has to be remembered is a gate that is eventually forgotten,
    // and forgetting it means an owner's private folder quietly acquiring
    // full-text search a year after they asked for titles only.
    const disposition = this.exclusions.evaluateMetadata(item.metadata);
    if (disposition.disposition === 'metadata_only') {
      throw new ConnectorStoreMetadataOnlyViolationError(disposition.ruleId);
    }
    if (text === undefined || text.trim() === '') {
      // Reaching this branch means the listing/fetch itself succeeded and the
      // current source record authoritatively has no searchable text. Fetch
      // failures return above and deliberately preserve prior chunks.
      this.db.transaction(() => {
        this.db.query('DELETE FROM chunks WHERE item_pk = ?').run(itemPk);
        this.refreshFtsForItem(itemPk);
      })();
      return { chunksIndexed: 0, ftsContentChanged: true };
    }

    // The currency hash is derived from the STORED item row, which the upsert
    // has already written, because that is the exact row the embed lane later
    // seasons its embedding text with. Deriving it from the RawItem instead
    // would disagree whenever the stored row carries something the emit did
    // not repeat — a reaction aggregate preserved across a reaction-free emit.
    const seasoning = this.itemEmbeddingSeasoning(itemPk, item);
    const chunks = chunkText(text, maxChunkChars);
    const desired = chunks.map((chunk, index) => ({
      index,
      text: chunk,
      hash: hashString(chunk),
      embeddingHash: hashString(buildConnectorStoreEmbeddingText({ ...seasoning, bounded_text: chunk })),
    }));
    const existing = this.db.query(`
      SELECT chunk_index, bounded_text, content_hash, embedding_input_hash
      FROM chunks WHERE item_pk = ? ORDER BY chunk_index
    `).all(itemPk) as Array<{
      chunk_index: number;
      bounded_text: string;
      content_hash: string;
      embedding_input_hash: string | null;
    }>;
    const contentUnchanged = existing.length === desired.length && desired.every((chunk, index) => {
      const current = existing[index];
      return current?.chunk_index === chunk.index
        && current.bounded_text === chunk.text
        && current.content_hash === chunk.hash;
    });
    if (contentUnchanged) {
      const update = this.db.query(`
        UPDATE chunks SET embedding_input_hash = ?
        WHERE item_pk = ? AND chunk_index = ? AND embedding_input_hash <> ?
      `);
      this.db.transaction(() => {
        for (const chunk of desired) {
          update.run(chunk.embeddingHash, itemPk, chunk.index, chunk.embeddingHash);
        }
      })();
      return { chunksIndexed: 0, ftsContentChanged: false };
    }

    // The FTS rebuild belongs to the same commit as the chunk replacement.
    // Split across two transactions, a crash in between left the keyword index
    // holding the pre-edit text mapped to chunk_pks this DELETE had removed —
    // a state no later pass repairs, because the next sync sees the content as
    // unchanged and reports no FTS work to do.
    this.db.transaction(() => {
      this.db.query('DELETE FROM chunks WHERE item_pk = ?').run(itemPk);
      const now = nowIso();
      const insert = this.db.query(`
        INSERT INTO chunks (
          item_pk, chunk_index, bounded_text, content_hash,
          embedding_input_hash, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const chunk of desired) {
        insert.run(itemPk, chunk.index, chunk.text, chunk.hash, chunk.embeddingHash, now);
      }
      this.refreshFtsForItem(itemPk);
    })();
    return { chunksIndexed: chunks.length, ftsContentChanged: true };
  }

  /**
   * Recomputes `chunks.embedding_input_hash` for one item whose embedding
   * seasoning has changed, and reports how many chunks that actually moved.
   *
   * `items.search_text` is the `Context:` line of the embedding input, so any
   * write to it changes what that input string would be for every chunk of the
   * item. A repair that rewrote the text and left the stored hashes alone left
   * those chunks satisfying the currency rule
   * (`embedding.content_hash == chunk.embedding_input_hash`) against vectors
   * computed over a different string, so the drain treated them as fresh and
   * never revisited them.
   *
   * Recomputing the true hash — rather than clearing it — invalidates exactly
   * the chunks whose input really moved. An item whose repaired text happens to
   * produce the same embedding input keeps its vectors and books no re-embed,
   * which matters because re-embedding is the expensive half of the repair.
   *
   * The vectors themselves are left in place: they are the still-answerable
   * previous result until `embedChunks` overwrites them, and deleting them
   * would strand vector search for the item for the whole interval between the
   * repair and the next drain.
   */
  private reseasonItemEmbeddingInputs(
    itemPk: number,
    seasoning: ConnectorStoreEmbeddingSeasoning,
  ): number {
    const chunks = this.db.query(`
      SELECT chunk_index, bounded_text, embedding_input_hash
      FROM chunks WHERE item_pk = ? ORDER BY chunk_index
    `).all(itemPk) as Array<{
      chunk_index: number;
      bounded_text: string;
      embedding_input_hash: string | null;
    }>;
    const update = this.db.query(
      'UPDATE chunks SET embedding_input_hash = ? WHERE item_pk = ? AND chunk_index = ?',
    );
    let invalidated = 0;
    for (const chunk of chunks) {
      const embeddingHash = hashString(
        buildConnectorStoreEmbeddingText({ ...seasoning, bounded_text: chunk.bounded_text }),
      );
      if (chunk.embedding_input_hash === embeddingHash) continue;
      update.run(embeddingHash, itemPk, chunk.chunk_index);
      invalidated += 1;
    }
    return invalidated;
  }

  private deleteFtsForItem(itemPk: number): number {
    const rows = this.db.query(`
      SELECT fts_rowid
      FROM connector_store_fts_rows
      WHERE item_pk = ?
      ORDER BY fts_rowid
    `).all(itemPk) as Array<{ fts_rowid: number }>;
    const removeFts = this.db.query('DELETE FROM connector_store_fts WHERE rowid = ?');
    for (const row of rows) removeFts.run(row.fts_rowid);
    this.db.query('DELETE FROM connector_store_fts_rows WHERE item_pk = ?').run(itemPk);
    return rows.length;
  }

  private insertFtsRow(title: string, text: string, itemPk: number, chunkPk: number | null): void {
    const inserted = this.db.query(
      'INSERT INTO connector_store_fts (title, bounded_text, item_pk, chunk_pk) VALUES (?, ?, ?, ?)',
    ).run(title, text, itemPk, chunkPk);
    this.db.query(`
      INSERT INTO connector_store_fts_rows (fts_rowid, item_pk, chunk_pk)
      VALUES (?, ?, ?)
    `).run(Number(inserted.lastInsertRowid), itemPk, chunkPk);
  }

  private refreshFtsForItem(itemPk: number): number {
    return this.db.transaction(() => {
      this.deleteFtsForItem(itemPk);
      const item = this.db.query('SELECT title, search_text FROM items WHERE item_pk = ? AND tombstoned = 0').get(itemPk) as
        | { title: string | null; search_text: string | null }
        | null;
      if (!item) return 0;
      const title = item.title ?? '';
      const searchText = item.search_text ?? '';
      const chunks = this.db.query(
        'SELECT chunk_pk, bounded_text FROM chunks WHERE item_pk = ? ORDER BY chunk_index',
      ).all(itemPk) as Array<{ chunk_pk: number; bounded_text: string }>;
      if (chunks.length === 0) {
        this.insertFtsRow(title, connectorStoreFtsText(searchText, ''), itemPk, null);
        return 1;
      }
      for (const chunk of chunks) {
        this.insertFtsRow(
          title,
          connectorStoreFtsText(searchText, chunk.bounded_text),
          itemPk,
          chunk.chunk_pk,
        );
      }
      return chunks.length;
    })();
  }

  // --- Embeddings ---------------------------------------------------------------

  // Embeds un-embedded chunks via the injected provider (the same
  // SourceEmbeddingProvider seam the Dropbox/email lanes use). Keyed
  // (chunk, model_id) with a content_hash guard: re-running with unchanged
  // content embeds nothing. secure_local stores ONLY accept a LOCAL provider
  // (cloud embedding is never eligible for secure_local chunks).
  async embedChunks(options: ConnectorStoreEmbedOptions): Promise<ConnectorStoreEmbedSummary> {
    const provider = options.provider;
    if (options.modelId && options.modelId !== provider.modelId) {
      throw new Error(
        `Connector store ${this.corpusId} embedding provider is ${provider.modelId}, `
        + `not requested model ${options.modelId}.`,
      );
    }
    assertConnectorStoreEmbeddingProvider(this.trustDomain, provider);
    const limit = normalizeEmbedLimit(options.limit);
    const journalId = normalizeMaintenanceJournalId(options.journalId);
    const journalLeaseGeneration = normalizeMaintenanceJournalLeaseGeneration(
      journalId,
      options.journalLeaseGeneration,
    );
    const invalidateCurrentModelEmbeddings =
      options.invalidateCurrentModelEmbeddings === true;
    if (invalidateCurrentModelEmbeddings && !journalId) {
      throw new TypeError(
        'Connector store embedding invalidation requires a durable journal id.',
      );
    }
    if (invalidateCurrentModelEmbeddings && limit !== undefined) {
      throw new TypeError(
        'Connector store embedding invalidation cannot use a partial embed limit.',
      );
    }
    const priorJournal = journalId
      ? this.db.query(`
          SELECT status, cursor, audit_receipt_sha256
          FROM sync_runs
          WHERE sync_run_id = ? AND connector_id = ?
        `).get(journalId, 'connector_store_embedding_maintenance') as {
          status: string;
          cursor: string | null;
          audit_receipt_sha256: string | null;
        } | null
      : null;
    if (priorJournal && priorJournal.status !== 'running' && priorJournal.status !== 'completed') {
      throw new Error('Connector store embedding journal has an invalid status.');
    }
    const priorCounts = priorJournal
      ? parseEmbeddingMaintenanceJournal(priorJournal.cursor)
      : undefined;
    if (priorJournal
      && priorJournal.audit_receipt_sha256 !== hashString(priorJournal.cursor ?? '')) {
      throw new Error('Connector store embedding journal CAS state is corrupt.');
    }
    if (priorCounts
      && priorCounts.leaseGeneration !== journalLeaseGeneration
      && journalLeaseGeneration! <= priorCounts.leaseGeneration) {
      throw new Error('Connector store embedding journal lease generation was superseded.');
    }
    // Same value-identity comparison the write authority uses: configHash is
    // deliberately not compared, so an endpoint retarget mid-journal resumes
    // the journal instead of poisoning it for ever.
    if (priorCounts && (
      priorCounts.modelId !== provider.modelId
      || priorCounts.embeddingProvider !== provider.provider
      || priorCounts.embeddingBackend !== provider.backend
      || priorCounts.embeddingDimension !== provider.dimension
      || priorCounts.embeddingEpoch !== provider.epochId
    )) {
      throw new Error('Connector store embedding journal provider changed.');
    }
    const rows = this.embeddingSourceRows(options.localItemIds);
    const selectionSha256 = connectorStoreEmbeddingSelectionSha256(options.localItemIds);
    const inputSha256 = connectorStoreEmbeddingInputSha256(rows);
    if (priorCounts && (
      priorCounts.chunksSeen !== rows.length
      || priorCounts.selectionSha256 !== selectionSha256
      || priorCounts.inputSha256 !== inputSha256
      || priorCounts.invalidateCurrentModelEmbeddings
        !== invalidateCurrentModelEmbeddings
    )) {
      throw new Error('Connector store embedding journal input changed.');
    }
    // Both no-prior-journal branches below bind with mode 'rebind', and a
    // rebind that supersedes an existing authority deletes every stored
    // vector for the model BEFORE this provider has embedded anything. Prove
    // the provider can actually produce a vector of the declared width first,
    // so a retarget to a dead or wrong endpoint fails with the corpus intact
    // instead of empty. Advisory, not a fence: bind re-decides inside its
    // transaction, so a raced authority change at worst skips one probe.
    if (!(priorJournal && priorCounts)
      && this.embeddingRebindWouldInvalidateCurrency(provider)) {
      await assertEmbeddingProviderCanEmbed(provider);
    }
    let activeJournalSha256 = priorJournal?.audit_receipt_sha256 ?? undefined;
    let providerEpoch!: number;
    if (priorJournal && priorCounts) {
      this.db.transaction(() => {
        providerEpoch = priorCounts.providerEpoch
          ?? this.bindEmbeddingWriteAuthority(provider, {
            mode: 'match',
            invalidateOnCreate: false,
          });
        this.assertEmbeddingWriteAuthority(provider, providerEpoch);
        const mustBindLegacyJournal = priorCounts.providerEpoch === undefined;
        const mustClaimRunningJournal = priorJournal.status === 'running'
          && priorCounts.leaseGeneration !== journalLeaseGeneration;
        if (!mustBindLegacyJournal && !mustClaimRunningJournal) return;
        const claimedCursor = embeddingMaintenanceJournal(
          provider,
          selectionSha256,
          inputSha256,
          rows.length,
          priorCounts.chunksEmbedded,
          priorJournal.status === 'running'
            ? journalLeaseGeneration!
            : priorCounts.leaseGeneration,
          providerEpoch,
          invalidateCurrentModelEmbeddings,
        );
        const claimedSha256 = hashString(claimedCursor);
        const claimed = this.db.query(`
          UPDATE sync_runs
          SET cursor = ?, audit_receipt_sha256 = ?
          WHERE sync_run_id = ? AND connector_id = ? AND status = ?
            AND audit_receipt_sha256 = ?
        `).run(
          claimedCursor,
          claimedSha256,
          journalId!,
          'connector_store_embedding_maintenance',
          priorJournal.status,
          activeJournalSha256!,
        );
        if (claimed.changes !== 1) {
          throw new Error('Connector store embedding journal lease generation was superseded.');
        }
        activeJournalSha256 = claimedSha256;
      })();
    } else if (journalId) {
      const startedAt = this.now().toISOString();
      this.db.transaction(() => {
        providerEpoch = this.bindEmbeddingWriteAuthority(provider, {
          mode: 'rebind',
          invalidateOnCreate: invalidateCurrentModelEmbeddings,
        });
        const cursor = embeddingMaintenanceJournal(
          provider,
          selectionSha256,
          inputSha256,
          rows.length,
          0,
          journalLeaseGeneration!,
          providerEpoch,
          invalidateCurrentModelEmbeddings,
        );
        const journalSha256 = hashString(cursor);
        activeJournalSha256 = journalSha256;
        this.db.query(`
          INSERT INTO sync_runs (
            sync_run_id, corpus_id, connector_id, status, cursor,
            items_seen, items_indexed, started_at, completed_at,
            audit_receipt_sha256
          ) VALUES (?, ?, ?, 'running', ?, ?, 0, ?, NULL, ?)
        `).run(
          journalId,
          this.corpusId,
          'connector_store_embedding_maintenance',
          cursor,
          rows.length,
          startedAt,
          journalSha256,
        );
      })();
    } else {
      providerEpoch = this.db.transaction(() => this.bindEmbeddingWriteAuthority(
        provider,
        { mode: 'rebind', invalidateOnCreate: false },
      ))();
    }
    if (priorJournal?.status === 'completed' && priorCounts) {
      return connectorStoreEmbedSummary(
        this.corpusId,
        this.trustDomain,
        provider,
        priorCounts.chunksSeen,
        priorCounts.chunksEmbedded,
        priorCounts.chunksSeen - priorCounts.chunksEmbedded,
      );
    }
    const pending: typeof rows = [];
    let skipped = 0;
    for (const row of rows) {
      if (limit !== undefined && pending.length >= limit) break;
      const existing = this.db.query(
        'SELECT content_hash FROM chunk_embeddings WHERE chunk_pk = ? AND model_id = ?',
      ).get(row.chunk_pk, provider.modelId) as { content_hash: string } | null;
      if (existing?.content_hash === row.content_hash) {
        skipped += 1;
        continue;
      }
      pending.push(row);
    }

    let embedded = priorCounts?.chunksEmbedded ?? 0;
    // Chunks a concurrent writer removed or re-chunked while their vectors
    // were in flight. They were seen and not embedded, so they are reported as
    // skipped rather than silently dropped out of the counts.
    let staleSkipped = 0;
    for (let offset = 0; offset < pending.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = pending.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const vectors = await provider.embed(batch.map((row) => ({
        ...(row.title ? { title: row.title } : {}),
        text: buildConnectorStoreEmbeddingText(row),
      })), { taskType: 'RETRIEVAL_DOCUMENT' });
      if (vectors.length !== batch.length) {
        throw new Error('Connector store embedding provider returned the wrong number of vectors.');
      }
      const now = nowIso();
      let nextJournalSha256: string | undefined;
      let written = 0;
      this.db.transaction(() => {
        this.assertEmbeddingWriteAuthority(provider, providerEpoch);
        for (let index = 0; index < batch.length; index += 1) {
          const row = batch[index]!;
          const vector = vectors[index];
          if (!vector) throw new Error('Connector store embedding provider returned no vector for a chunk.');
          // The chunk keys were snapshotted before the provider round trip, so
          // a concurrent lane (a tombstone, a re-chunk on changed content) can
          // have deleted them while the batch was in flight. An unguarded
          // INSERT then trips the chunk_embeddings -> chunks foreign key and
          // aborts the whole pass; worse, a freed rowid that SQLite reassigned
          // takes the vector of the OLD text. Writing only where the captured
          // chunk still exists with the same embedding input turns both into a
          // counted skip. Mirrors the Dropbox lane's guarded write.
          const write = this.db.query(`
            INSERT INTO chunk_embeddings (chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at)
            SELECT ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1
              FROM chunks c
              JOIN items i ON i.item_pk = c.item_pk
              WHERE c.chunk_pk = ?
                AND c.item_pk = ?
                AND c.embedding_input_hash = ?
                AND i.tombstoned = 0
            )
            ON CONFLICT(chunk_pk, model_id) DO UPDATE SET
              item_pk = excluded.item_pk,
              content_hash = excluded.content_hash,
              embedding = excluded.embedding,
              embedded_at = excluded.embedded_at
          `).run(
            row.chunk_pk,
            provider.modelId,
            row.item_pk,
            row.content_hash,
            encodeEmbedding(vector, provider.dimension),
            now,
            row.chunk_pk,
            row.item_pk,
            row.content_hash,
          );
          if (write.changes > 0) written += 1;
        }
        if (journalId) {
          const cumulative = embedded + written;
          const cursor = embeddingMaintenanceJournal(
            provider,
            selectionSha256,
            inputSha256,
            rows.length,
            cumulative,
            journalLeaseGeneration!,
            providerEpoch,
            invalidateCurrentModelEmbeddings,
          );
          nextJournalSha256 = hashString(cursor);
          const updated = this.db.query(`
            UPDATE sync_runs
            SET cursor = ?, items_indexed = ?, audit_receipt_sha256 = ?
            WHERE sync_run_id = ? AND connector_id = ? AND status = 'running'
              AND audit_receipt_sha256 = ?
          `).run(
            cursor,
            cumulative,
            nextJournalSha256,
            journalId,
            'connector_store_embedding_maintenance',
            activeJournalSha256!,
          );
          if (updated.changes !== 1) {
            throw new Error('Connector store embedding journal lease generation was superseded.');
          }
        }
        this.recordEmbeddingModel({
          modelId: provider.modelId,
          provider: provider.provider,
          dimension: provider.dimension,
          backend: provider.backend,
          epochId: provider.epochId,
          configHash: provider.configHash,
        }, now);
      })();
      if (nextJournalSha256) activeJournalSha256 = nextJournalSha256;
      embedded += written;
      staleSkipped += batch.length - written;
    }
    skipped += staleSkipped;
    if (journalId) {
      const completedAt = this.now().toISOString();
      const cursor = embeddingMaintenanceJournal(
        provider,
        selectionSha256,
        inputSha256,
        rows.length,
        embedded,
        journalLeaseGeneration!,
        providerEpoch,
        invalidateCurrentModelEmbeddings,
      );
      const completedSha256 = hashString(cursor);
      this.db.transaction(() => {
        this.assertEmbeddingWriteAuthority(provider, providerEpoch);
        const completed = this.db.query(`
          UPDATE sync_runs
          SET status = 'completed', cursor = ?, items_indexed = ?,
            completed_at = ?, audit_receipt_sha256 = ?
          WHERE sync_run_id = ? AND connector_id = ? AND status = 'running'
            AND audit_receipt_sha256 = ?
        `).run(
          cursor,
          embedded,
          completedAt,
          completedSha256,
          journalId,
          'connector_store_embedding_maintenance',
          activeJournalSha256!,
        );
        if (completed.changes !== 1) {
          throw new Error('Connector store embedding journal lease generation was superseded.');
        }
      })();
      skipped = rows.length - embedded;
    }
    this.clearEmbeddingCurrencyRebuildDebt(provider, providerEpoch);
    return connectorStoreEmbedSummary(
      this.corpusId,
      this.trustDomain,
      provider,
      rows.length,
      embedded,
      skipped,
    );
  }


  /**
   * Binds a writer to the model-global provider epoch. This method is called
   * only from a surrounding transaction. Account/page generations never enter
   * this row: an epoch is minted only for the first identity or when the full
   * provider identity changes. Rebinding clears all model currency atomically.
   */
  private bindEmbeddingWriteAuthority(
    provider: ConnectorStoreEmbeddingAuthorityIdentity,
    options: {
      mode: 'rebind' | 'match';
      invalidateOnCreate: boolean;
    },
  ): number {
    // Bind runs before the provider call, so a lazily discovered dimension is
    // not authoritative yet. Refuse before any currency invalidation or row
    // mutation; connectorStoreEmbeddingWriteAuthority repeats this guard so
    // no future writer can serialize an invalid dimension by bypassing bind.
    assertConnectorStoreEmbeddingAuthorityProviderDimension(provider);
    const authorityId = connectorStoreEmbeddingWriteAuthorityId(provider.modelId);
    const existing = this.db.query(`
      SELECT status, cursor, audit_receipt_sha256
      FROM sync_runs
      WHERE sync_run_id = ? AND connector_id = ?
    `).get(
      authorityId,
      'connector_store_embedding_write_authority',
    ) as {
      status: string;
      cursor: string | null;
      audit_receipt_sha256: string | null;
    } | null;
    if (!existing) {
      if (options.mode === 'match') {
        throw new Error('Connector store embedding write authority is missing.');
      }
      const priorCurrency = this.db.query(`
        SELECT
          EXISTS(SELECT 1 FROM chunk_embeddings WHERE model_id = ?) AS vectors,
          EXISTS(SELECT 1 FROM embedding_models WHERE model_id = ?) AS provenance
      `).get(provider.modelId, provider.modelId) as { vectors: number; provenance: number };
      const hasPriorCurrency = priorCurrency.vectors === 1 || priorCurrency.provenance === 1;

      // Pre-authority stores cannot prove the complete identity that wrote
      // their durable vectors: embedding_models does not carry configHash.
      // Conservatively clear that unprovable currency before epoch 1 is
      // inserted. bindEmbeddingWriteAuthority is transaction-only, so the
      // clear and authority mint commit or roll back together. Once the row
      // exists this branch is unreachable, which makes the migration one-shot.
      const invalidated = hasPriorCurrency || options.invalidateOnCreate;
      if (invalidated) {
        this.invalidateEmbeddingModelCurrency(provider.modelId);
      }
      const providerEpoch = 1;
      const cursor = connectorStoreEmbeddingWriteAuthority(provider, providerEpoch, invalidated);
      const startedAt = this.now().toISOString();
      this.db.query(`
        INSERT INTO sync_runs (
          sync_run_id, corpus_id, connector_id, status, cursor,
          items_seen, items_indexed, started_at, completed_at,
          audit_receipt_sha256
        ) VALUES (?, ?, ?, 'running', ?, 0, 0, ?, NULL, ?)
      `).run(
        authorityId,
        this.corpusId,
        'connector_store_embedding_write_authority',
        cursor,
        startedAt,
        hashString(cursor),
      );
      return providerEpoch;
    }
    if (existing.status !== 'running'
      || existing.audit_receipt_sha256 !== hashString(existing.cursor ?? '')) {
      throw new Error('Connector store embedding write authority is corrupt.');
    }
    let current: ConnectorStoreEmbeddingWriteAuthorityRecord;
    try {
      current = parseConnectorStoreEmbeddingWriteAuthority(existing.cursor);
    } catch (error) {
      // A verified receipt proves this is a complete, untampered row from an
      // older authority format/validation era. Only rebind may retire it;
      // match keeps the existing fail-closed parse behavior. The authorityId
      // lookup and CAS both remain model-scoped.
      if (options.mode !== 'rebind') throw error;
      const recoveredEpoch = recoverConnectorStoreEmbeddingWriteAuthorityEpoch(
        existing.cursor,
        provider.modelId,
      );
      const providerEpoch = recoveredEpoch === undefined ? 1 : recoveredEpoch + 1;
      if (!Number.isSafeInteger(providerEpoch) || providerEpoch > Number.MAX_SAFE_INTEGER) {
        throw new Error('Connector store embedding write authority epoch is exhausted.');
      }
      const cursor = connectorStoreEmbeddingWriteAuthority(provider, providerEpoch, true);
      const rebound = this.db.query(`
        UPDATE sync_runs
        SET cursor = ?, audit_receipt_sha256 = ?
        WHERE sync_run_id = ? AND connector_id = ? AND status = 'running'
          AND audit_receipt_sha256 = ?
      `).run(
        cursor,
        hashString(cursor),
        authorityId,
        'connector_store_embedding_write_authority',
        existing.audit_receipt_sha256,
      );
      if (rebound.changes !== 1) {
        throw new Error('Connector store embedding write authority was superseded.');
      }
      this.invalidateEmbeddingModelCurrency(provider.modelId);
      return providerEpoch;
    }
    if (current.modelId !== provider.modelId) {
      throw new Error('Connector store embedding write authority model is corrupt.');
    }
    const providerMatches = connectorStoreEmbeddingWriteAuthorityMatches(current, provider);
    if (!providerMatches && options.mode !== 'rebind') {
      throw new Error('Connector store embedding write authority was superseded.');
    }
    const providerEpoch = current.kind === 'v1'
      ? (providerMatches ? 1 : 2)
      : providerMatches ? current.providerEpoch : current.providerEpoch + 1;
    if (!Number.isSafeInteger(providerEpoch) || providerEpoch > Number.MAX_SAFE_INTEGER) {
      throw new Error('Connector store embedding write authority epoch is exhausted.');
    }
    if (current.kind === 'v2' && providerMatches) return providerEpoch;

    // A v1 row upgraded under a matching provider invalidates nothing, so it
    // carries whatever debt the row already recorded (none, in v1's format).
    const cursor = connectorStoreEmbeddingWriteAuthority(
      provider,
      providerEpoch,
      !providerMatches || current.currencyRebuildPending,
    );
    const rebound = this.db.query(`
      UPDATE sync_runs
      SET cursor = ?, audit_receipt_sha256 = ?
      WHERE sync_run_id = ? AND connector_id = ? AND status = 'running'
        AND audit_receipt_sha256 = ?
    `).run(
      cursor,
      hashString(cursor),
      authorityId,
      'connector_store_embedding_write_authority',
      existing.audit_receipt_sha256,
    );
    if (rebound.changes !== 1) {
      throw new Error('Connector store embedding write authority was superseded.');
    }
    if (!providerMatches) this.invalidateEmbeddingModelCurrency(provider.modelId);
    return providerEpoch;
  }

  /**
   * Commit-time half of the write fence. It runs inside the SAME SQLite
   * transaction as each vector batch and provenance upsert. A provider call
   * may be in flight while a new provider epoch rebinds authority; this check
   * makes the old batch roll back before any stale vector becomes visible.
   */
  private assertEmbeddingWriteAuthority(
    provider: ConnectorStoreEmbeddingAuthorityIdentity,
    providerEpoch: number,
  ): void {
    const authority = this.db.query(`
      SELECT status, cursor, audit_receipt_sha256
      FROM sync_runs
      WHERE sync_run_id = ? AND connector_id = ?
    `).get(
      connectorStoreEmbeddingWriteAuthorityId(provider.modelId),
      'connector_store_embedding_write_authority',
    ) as {
      status: string;
      cursor: string | null;
      audit_receipt_sha256: string | null;
    } | null;
    if (!authority) throw new Error('Connector store embedding write authority is missing.');
    if (authority.status !== 'running'
      || authority.audit_receipt_sha256 !== hashString(authority.cursor ?? '')) {
      throw new Error('Connector store embedding write authority is corrupt.');
    }
    const current = parseConnectorStoreEmbeddingWriteAuthority(authority.cursor);
    if (current.kind !== 'v2'
      || !connectorStoreEmbeddingWriteAuthorityMatches(current, provider)
      || current.providerEpoch !== providerEpoch) {
      throw new Error('Connector store embedding write authority was superseded.');
    }
  }

  private invalidateEmbeddingModelCurrency(modelId: string): void {
    this.db.query('DELETE FROM chunk_embeddings WHERE model_id = ?').run(modelId);
    this.db.query('DELETE FROM embedding_models WHERE model_id = ?').run(modelId);
  }

  /**
   * Read-only preview of the one bind('rebind') outcome that destroys data:
   * superseding an EXISTING authority row, which clears the model's currency
   * corpus-wide. Mirrors bindEmbeddingWriteAuthority's decisions without
   * mutating anything. The first-mint migration clear (row missing, prior
   * currency present) is deliberately not previewed — it is the sanctioned
   * one-shot upgrade path and its call counts are pinned by tests.
   */
  private embeddingRebindWouldInvalidateCurrency(
    provider: ConnectorStoreEmbeddingAuthorityIdentity,
  ): boolean {
    const existing = this.db.query(`
      SELECT status, cursor, audit_receipt_sha256
      FROM sync_runs
      WHERE sync_run_id = ? AND connector_id = ?
    `).get(
      connectorStoreEmbeddingWriteAuthorityId(provider.modelId),
      'connector_store_embedding_write_authority',
    ) as {
      status: string;
      cursor: string | null;
      audit_receipt_sha256: string | null;
    } | null;
    if (!existing) return false;
    if (existing.status !== 'running'
      || existing.audit_receipt_sha256 !== hashString(existing.cursor ?? '')) {
      return false; // bind throws before touching currency
    }
    let current: ConnectorStoreEmbeddingWriteAuthorityRecord;
    try {
      current = parseConnectorStoreEmbeddingWriteAuthority(existing.cursor);
    } catch {
      return true; // legacy-format recovery rebind clears currency
    }
    if (current.modelId !== provider.modelId) return false; // bind throws
    return !connectorStoreEmbeddingWriteAuthorityMatches(current, provider);
  }

  /**
   * Retires the corpus-wide currency debt a rebind recorded, on EVIDENCE that
   * the corpus is current rather than on the shape of the call that arrived.
   *
   * Gating it on "no selection, no limit" made the debt unpayable in practice:
   * `syncAndEmbedFromConnector` always passes `localItemIds` (an empty array
   * when nothing was selected), so every scheduler-driven lane re-embedded the
   * corpus page by page and left the flag standing forever, with the vector
   * lane switched off on a fully embedded store. The probe below asks the same
   * question `hasEmbeddings` asks — is any live chunk still without a current
   * vector for this model — so the last page of a page-by-page rebuild is what
   * pays the debt, whatever its call shape.
   */
  private clearEmbeddingCurrencyRebuildDebt(
    provider: ConnectorStoreEmbeddingAuthorityIdentity,
    providerEpoch: number,
  ): void {
    this.db.transaction(() => {
      const authorityId = connectorStoreEmbeddingWriteAuthorityId(provider.modelId);
      const existing = this.db.query(`
        SELECT cursor, audit_receipt_sha256
        FROM sync_runs
        WHERE sync_run_id = ? AND connector_id = ?
      `).get(
        authorityId,
        'connector_store_embedding_write_authority',
      ) as { cursor: string | null; audit_receipt_sha256: string | null } | null;
      if (!existing) return;
      if (!parseConnectorStoreEmbeddingWriteAuthority(existing.cursor).currencyRebuildPending) return;
      if (this.embeddingModelCurrencyIncomplete(provider.modelId)) return;
      this.assertEmbeddingWriteAuthority(provider, providerEpoch);
      const cursor = connectorStoreEmbeddingWriteAuthority(provider, providerEpoch);
      const cleared = this.db.query(`
        UPDATE sync_runs
        SET cursor = ?, audit_receipt_sha256 = ?
        WHERE sync_run_id = ? AND connector_id = ? AND status = 'running'
          AND audit_receipt_sha256 = ?
      `).run(
        cursor,
        hashString(cursor),
        authorityId,
        'connector_store_embedding_write_authority',
        existing.audit_receipt_sha256,
      );
      if (cleared.changes !== 1) {
        throw new Error('Connector store embedding write authority was superseded.');
      }
    })();
  }

  /**
   * True while any live chunk still lacks a current vector for the model. The
   * filter is `embeddingSourceRows`' (live items only) and the currency rule is
   * `hasEmbeddings`' (`embedding.content_hash == chunk.embedding_input_hash`),
   * so "complete" here means exactly what "servable" means there. One indexed
   * existence query, stopped at the first outstanding chunk.
   */
  private embeddingModelCurrencyIncomplete(modelId: string): boolean {
    const row = this.db.query(`
      SELECT 1 AS pending
      FROM chunks c
      JOIN items i ON i.item_pk = c.item_pk
      LEFT JOIN chunk_embeddings emb
        ON emb.chunk_pk = c.chunk_pk AND emb.model_id = ?
      WHERE i.tombstoned = 0
        AND (emb.chunk_pk IS NULL OR emb.content_hash <> c.embedding_input_hash)
      LIMIT 1
    `).get(modelId) as { pending: number } | null;
    return row !== null;
  }

  private embeddingCurrencyRebuildPending(modelId: string): boolean {
    const row = this.db.query(`
      SELECT cursor FROM sync_runs
      WHERE sync_run_id = ? AND connector_id = ?
    `).get(
      connectorStoreEmbeddingWriteAuthorityId(modelId),
      'connector_store_embedding_write_authority',
    ) as { cursor: string | null } | null;
    if (!row) return false;
    try {
      return parseConnectorStoreEmbeddingWriteAuthority(row.cursor).currencyRebuildPending;
    } catch {
      // Refusing an unreadable authority row belongs to the write path. A read
      // probe treats it as no recorded debt rather than inventing one.
      return false;
    }
  }

  // One writer for the embedding_models provenance row. The normal embed lane
  // records the exact provider identity whose vectors it installed.
  private recordEmbeddingModel(
    model: ConnectorStoreEmbeddingAuthorityIdentity,
    recordedAt: string,
  ): void {
    this.db.query(`
      INSERT INTO embedding_models (
        model_id, provider, dimension, embedding_backend, embedding_epoch,
        cloud_embedding_eligible, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model_id) DO UPDATE SET
        provider = excluded.provider,
        dimension = excluded.dimension,
        embedding_backend = excluded.embedding_backend,
        embedding_epoch = excluded.embedding_epoch,
        cloud_embedding_eligible = excluded.cloud_embedding_eligible
    `).run(
      model.modelId,
      model.provider,
      model.dimension,
      model.backend,
      model.epochId,
      Number(this.trustDomain !== 'secure_local' && model.backend === 'cloud'),
      recordedAt,
    );
  }

  // True when the store has at least one CURRENT embedding for the model:
  // stale vectors (content_hash no longer matching the live chunk) never
  // activate the vector lane.
  hasEmbeddings(modelId: string): boolean {
    // A rebind deletes this model's vectors across the WHOLE corpus while the
    // call that triggered it re-embeds only its own selection. Until a
    // corpus-wide pass has rebuilt them, one fresh vector is not evidence that
    // the lane can serve the corpus — so the lane stays off and callers fall
    // back to keyword instead of silently fusing a fraction of it.
    if (this.embeddingCurrencyRebuildPending(modelId)) return false;
    // The question is "is there at least one", so the query stops at the first
    // row. It used to be an unbounded COUNT(*) over the whole three-table join,
    // which walked every current embedding in the corpus to answer a boolean —
    // and the retrieval adapter asks it twice per query (once in the adapter
    // body, once in hybridAvailability), so on Telegram that was two full
    // 170k-row joins before any searching started.
    const row = this.db.query(`
      SELECT 1 AS present
      FROM chunk_embeddings emb
      JOIN chunks c ON c.chunk_pk = emb.chunk_pk
      JOIN items i ON i.item_pk = emb.item_pk
      WHERE emb.model_id = ?
        AND i.tombstoned = 0
        AND emb.content_hash = c.embedding_input_hash
      LIMIT 1
    `).get(modelId) as { present: number } | null;
    return row !== null;
  }

  // Vector lane: embed the query via the provider, cosine over the stored
  // vectors (exact scan, like the Dropbox lane), best chunk score per item,
  // floor at MIN_VECTOR_SCORE. Returns the same membrane-safe rows as the
  // keyword lane — identity + citation metadata only.
  async vectorSearchItems(
    query: string,
    provider: SourceEmbeddingProvider,
    maxResults: number,
    accountScope?: string,
    filters?: ConnectorStoreSearchFilters,
    deadlineAtMs?: number,
  ): Promise<ConnectorStoreSearchRow[]> {
    const scoredRows = await this.vectorSearchItemsWithScores(
      query,
      provider,
      maxResults,
      accountScope,
      filters,
      deadlineAtMs,
    );
    return scoredRows.map(({ bestCosine: _bestCosine, ...row }) => row);
  }

  // Score-carrying sibling used by hybrid retrieval and numeric-only
  // calibration. The legacy vectorSearchItems surface above intentionally
  // strips the additive score so existing callers retain the same row shape.
  async vectorSearchItemsWithScores(
    query: string,
    provider: SourceEmbeddingProvider,
    maxResults: number,
    accountScope?: string,
    filters?: ConnectorStoreSearchFilters,
    deadlineAtMs?: number,
  ): Promise<ConnectorStoreScoredSearchRow[]> {
    const lane = await this.vectorSearchLane(query, provider, maxResults, accountScope, filters, deadlineAtMs);
    return lane.rows;
  }

  /**
   * The vector lane with its refusal reason attached, so hybrid retrieval can
   * report an empty semantic lane honestly instead of as "no candidates".
   *
   * The read side needs its own authority fence. `hasEmbeddings` is keyed on
   * the model id alone, and a query spends hundreds of milliseconds inside
   * `provider.embed` — long enough for a writer to rebind the SAME model id to
   * a different provider, config hash, epoch or dimension, delete every vector
   * and rebuild the corpus in the new space. The stored vectors are then
   * selected by model id and scored against a query vector from the old space,
   * which produces silently meaningless rankings rather than an error. So the
   * full authority identity is captured before the await and re-checked after
   * it, and any move retires the lane to keyword for that query.
   *
   * The re-check and the scan then run inside ONE read transaction. They are
   * two statements on a connection another process writes, so on their own the
   * re-check could pass and a rebind commit before the first vector was read —
   * the same cross-space scoring, moved into a smaller window rather than
   * removed. A deferred transaction pins both to one snapshot, so the rows the
   * scan walks are the rows the authority check approved.
   */
  async vectorSearchLane(
    query: string,
    provider: SourceEmbeddingProvider,
    maxResults: number,
    accountScope?: string,
    filters?: ConnectorStoreSearchFilters,
    deadlineAtMs?: number,
  ): Promise<{ rows: ConnectorStoreScoredSearchRow[]; skippedReason?: string }> {
    assertConnectorStoreEmbeddingProvider(this.trustDomain, provider);
    const trimmed = query.trim();
    if (!trimmed) return { rows: [] };
    const before = this.embeddingReadAuthority(provider);
    if (before.skippedReason) return { rows: [], skippedReason: before.skippedReason };
    const [queryVector] = await provider.embed([{ text: trimmed }], { taskType: 'RETRIEVAL_QUERY' });
    // A provider that answered with nothing is a refusal like any other, and it
    // says so: an unexplained zero-candidate lane is indistinguishable from a
    // corpus that genuinely held no semantic match.
    if (!queryVector) return { rows: [], skippedReason: 'embedding_query_vector_missing' };
    // A query vector that is not the declared width cannot be compared with
    // anything this store holds. cosineSimilarity silently scores over the
    // shorter of the two, so an unchecked mismatch is a ranking nobody can
    // tell apart from a real one.
    if (queryVector.length !== provider.dimension) {
      return { rows: [], skippedReason: 'embedding_query_dimension_mismatch' };
    }
    return this.scoreVectorLaneSnapshot({
      provider,
      queryVector,
      beforeToken: before.token,
      maxResults,
      ...(accountScope !== undefined ? { accountScope } : {}),
      ...(filters ? { filters } : {}),
      ...(deadlineAtMs !== undefined ? { deadlineAtMs } : {}),
    });
  }

  /**
   * The snapshot half of the vector lane. A dedicated read connection keeps
   * one SQLite snapshot across cooperative page yields, so timers can run
   * without letting a concurrent embedding rebind mix vector spaces.
   */
  private async scoreVectorLaneSnapshot(input: {
    provider: SourceEmbeddingProvider;
    queryVector: readonly number[];
    beforeToken: string;
    maxResults: number;
    accountScope?: string;
    filters?: ConnectorStoreSearchFilters;
    deadlineAtMs?: number;
  }): Promise<{ rows: ConnectorStoreScoredSearchRow[]; skippedReason?: string }> {
    const { provider, queryVector, maxResults, accountScope, filters, deadlineAtMs } = input;
    if (connectorStoreVectorDeadlineExpired(deadlineAtMs)) {
      return { rows: [], skippedReason: 'vector_scan_deadline_exceeded' };
    }
    const limit = Math.max(1, Math.min(Math.floor(maxResults), MAX_SEARCH_RESULTS));
    const selectedAccount = normalizeOptionalAccountScope(accountScope);
    const scanDb = this.dbPath === ':memory:'
      ? this.db
      : new Database(this.dbPath, { readonly: true, create: false, strict: true });
    const ownsScanDb = scanDb !== this.db;
    const bestByItem = new Map<number, { bestCosine: number; bestChunkPk: number; localItemId: string }>();
    let dimensionMismatches = 0;
    let afterChunkPk = 0;

    try {
      if (ownsScanDb) {
        scanDb.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON; PRAGMA foreign_keys = ON;');
      }
      // A dedicated read connection lets this snapshot remain open while the
      // scan yields to timers. The production store is file-backed; :memory:
      // is retained only for isolated tests, where this connection cannot be
      // reopened and no concurrent writer exists.
      scanDb.exec('BEGIN DEFERRED TRANSACTION;');
      const after = this.embeddingReadAuthority(provider, scanDb);
      if (after.skippedReason) return { rows: [], skippedReason: after.skippedReason };
      if (after.token !== input.beforeToken) {
        return { rows: [], skippedReason: 'embedding_authority_changed_during_query' };
      }

      while (true) {
        if (connectorStoreVectorDeadlineExpired(deadlineAtMs)) {
          return { rows: [], skippedReason: 'vector_scan_deadline_exceeded' };
        }
        const page = connectorStoreCurrentEmbeddingRowsPage(scanDb, {
          modelId: provider.modelId,
          ...(selectedAccount ? { accountScope: selectedAccount } : {}),
          ...(filters ? { filters } : {}),
        }, afterChunkPk);
        if (page.length === 0) break;

        // The winning CHUNK is kept, not just its score. A cosine is a
        // chunk-level measurement, so the chunk that produced the item's best
        // score is the only defensible semantic citation target.
        for (const [index, row] of page.entries()) {
          if ((index & 31) === 0 && connectorStoreVectorDeadlineExpired(deadlineAtMs)) {
            return { rows: [], skippedReason: 'vector_scan_deadline_exceeded' };
          }
          const documentVector = decodeEmbedding(row.embedding);
          if (documentVector.length !== queryVector.length) {
            dimensionMismatches += 1;
            continue;
          }
          const score = cosineSimilarity(queryVector, documentVector);
          const existing = bestByItem.get(row.itemPk);
          if (existing === undefined || score > existing.bestCosine) {
            bestByItem.set(row.itemPk, {
              bestCosine: score,
              bestChunkPk: row.chunkPk,
              localItemId: row.localItemId,
            });
          }
        }
        afterChunkPk = page.at(-1)!.chunkPk;
        if (page.length < CONNECTOR_STORE_VECTOR_SCAN_PAGE_SIZE) break;
        await yieldConnectorStoreVectorScan();
      }
    } finally {
      try {
        scanDb.exec('ROLLBACK;');
      } catch {
        // A read snapshot that never opened or was already closed has no state
        // to recover. The original retrieval error, if any, remains primary.
      }
      if (ownsScanDb) closeSqliteStore(scanDb);
    }

    // Ties break on item_pk, explicitly.
    //
    // This sort is stable, so the previous code inherited its tie order from
    // Map insertion order, which came from the scan's ORDER BY item_pk. The
    // scan no longer sorts (see connectorStoreCurrentEmbeddingRowsIterator), so
    // that implicit order is gone — and exactly-equal cosines are not rare in a
    // real corpus, where duplicated and forwarded content is normal. Naming the
    // tiebreak here keeps the ranking identical to the ordered scan's and, more
    // importantly, makes it independent of whatever plan SQLite chooses.
    const rankedItems = Array.from(bestByItem.entries())
      .filter(([, candidate]) => candidate.bestCosine >= MIN_VECTOR_SCORE)
      .sort((left, right) => right[1].bestCosine - left[1].bestCosine || left[0] - right[0])
      .slice(0, limit);
    const searchRows = this.searchRowsByItemPks(
      rankedItems.map(([itemPk]) => itemPk),
      selectedAccount,
      filters,
    );
    const winnersByLocalItemId = new Map(
      rankedItems.map(([, candidate]) => [candidate.localItemId, candidate]),
    );
    const laneRows = searchRows.flatMap((row) => {
      const winner = winnersByLocalItemId.get(row.sourceItem.localItemId);
      if (winner === undefined) return [];
      const chunk = this.chunkMatchForChunkPk(winner.bestChunkPk, 'semantic');
      return [{ ...row, ...(chunk ? { chunk } : {}), bestCosine: winner.bestCosine }];
    });
    return {
      rows: laneRows,
      ...(laneRows.length === 0 && dimensionMismatches > 0
        ? { skippedReason: 'embedding_stored_dimension_mismatch' }
        : {}),
    };
  }

  /**
   * The read half of the embedding write fence: the authority row's receipt
   * digest, which covers the whole value identity (provider, backend,
   * dimension, epoch — configHash is recorded but carries no authority), the
   * provider epoch and the currency debt flag. Two reads of the same token
   * prove nothing rebound in between.
   *
   * A store with no authority row at all predates the fence. Its vectors are
   * gated by `hasEmbeddings` as before; refusing them here would switch the
   * vector lane off for every corpus that has not yet re-embedded.
   */
  private embeddingReadAuthority(
    provider: ConnectorStoreEmbeddingAuthorityIdentity,
    db: Database = this.db,
  ): { token: string; skippedReason?: string } {
    const row = db.query(`
      SELECT status, cursor, audit_receipt_sha256
      FROM sync_runs
      WHERE sync_run_id = ? AND connector_id = ?
    `).get(
      connectorStoreEmbeddingWriteAuthorityId(provider.modelId),
      'connector_store_embedding_write_authority',
    ) as { status: string; cursor: string | null; audit_receipt_sha256: string | null } | null;
    if (!row) return { token: 'no_embedding_write_authority' };
    if (row.status !== 'running' || row.audit_receipt_sha256 !== hashString(row.cursor ?? '')) {
      return { token: 'corrupt', skippedReason: 'embedding_authority_corrupt' };
    }
    let record: ConnectorStoreEmbeddingWriteAuthorityRecord;
    try {
      record = parseConnectorStoreEmbeddingWriteAuthority(row.cursor);
    } catch {
      return { token: 'unreadable', skippedReason: 'embedding_authority_unreadable' };
    }
    const token = row.audit_receipt_sha256 ?? '';
    if (!connectorStoreEmbeddingWriteAuthorityMatches(record, provider)) {
      return { token, skippedReason: 'embedding_authority_provider_mismatch' };
    }
    if (record.currencyRebuildPending) {
      return { token, skippedReason: 'embedding_currency_rebuild_pending' };
    }
    return { token };
  }

  // Embeddable chunk rows: every live (non-tombstoned) chunk plus the
  // citation-safe item metadata that seasons the embedding text.
  private embeddingSourceRows(localItemIds?: readonly string[]): Array<{
    chunk_pk: number;
    item_pk: number;
    content_hash: string;
    bounded_text: string;
    title: string | null;
    search_text: string | null;
    mime_type: string | null;
    authored_at: string | null;
    updated_at: string | null;
  }> {
    const selectedLocalItemIds = normalizeEmbedLocalItemIds(localItemIds);
    if (selectedLocalItemIds && selectedLocalItemIds.length === 0) return [];
    const itemFilter = selectedLocalItemIds
      ? ` AND i.local_item_id IN (${selectedLocalItemIds.map(() => '?').join(', ')})`
      : '';
    return this.db.query(`
      SELECT
        c.chunk_pk,
        c.item_pk,
        c.embedding_input_hash AS content_hash,
        c.bounded_text,
        i.title,
        i.search_text,
        i.mime_type,
        i.authored_at,
        i.updated_at
      FROM chunks c
      JOIN items i ON i.item_pk = c.item_pk
      WHERE i.tombstoned = 0
        ${itemFilter}
      ORDER BY c.chunk_pk ASC
    `).all(...(selectedLocalItemIds ?? [])) as Array<{
      chunk_pk: number;
      item_pk: number;
      content_hash: string;
      bounded_text: string;
      title: string | null;
      search_text: string | null;
      mime_type: string | null;
      authored_at: string | null;
      updated_at: string | null;
    }>;
  }

  // Hydrates membrane-safe search rows for ranked item pks, preserving order.
  private searchRowsByItemPks(
    itemPks: number[],
    accountScope?: string,
    filters?: ConnectorStoreSearchFilters,
  ): ConnectorStoreSearchRow[] {
    if (itemPks.length === 0) return [];
    const placeholders = itemPks.map(() => '?').join(', ');
    const selectedAccount = normalizeOptionalAccountScope(accountScope);
    const selectedFilters = connectorStoreFilterSql(filters);
    const rows = this.db.query(`
      SELECT
        i.item_pk, i.provider, i.family, i.account_scope, i.provider_item_id, i.provider_thread_id,
        i.provider_conversation_id, i.provider_file_id, i.provider_event_id, i.local_item_id,
        i.source_version, i.title, i.sender_id, i.sender_label, i.sender_is_owner,
        i.mime_type, i.authored_at, i.updated_at,
        i.trust_tier, i.sync_run_id,
        0 AS rank
      FROM items i
      WHERE i.item_pk IN (${placeholders})
        AND i.tombstoned = 0
        ${selectedAccount ? 'AND i.account_scope = ?' : ''}
        ${selectedFilters.sql}
    `).all(
      ...itemPks,
      ...(selectedAccount ? [selectedAccount] : []),
      ...selectedFilters.params,
    ) as ItemRow[];
    const byPk = new Map(rows.map((row) => [row.item_pk, row]));
    return itemPks.flatMap((itemPk) => {
      const row = byPk.get(itemPk);
      return row ? [searchRowFromItemRow(row)] : [];
    });
  }

  // --- Read surfaces ----------------------------------------------------------

  // Keyword search over the FTS lane. Returns identity + citation-safe
  // metadata only; bounded text and locators never cross this surface.
  searchItems(
    query: string,
    maxResults: number,
    accountScope?: string,
    filters?: ConnectorStoreSearchFilters,
    ftsOptions: { prefix?: boolean } = {},
  ): ConnectorStoreSearchRow[] {
    const selectedFilters = connectorStoreFilterSql(filters);
    const terms = toFtsQuery(query, ftsOptions);
    if (!terms) return [];
    const limit = Math.max(1, Math.min(Math.floor(maxResults), MAX_SEARCH_RESULTS));
    const groups = sourceIndexFtsTermGroups(query);
    const minimumSignal = groups.length >= 2;
    const fetchLimit = minimumSignal ? Math.min(limit * 3, MAX_SEARCH_RESULTS) : limit;
    const selectedAccount = normalizeOptionalAccountScope(accountScope);
    const rows = this.db.query(`
      SELECT
        i.item_pk, i.provider, i.family, i.account_scope, i.provider_item_id, i.provider_thread_id,
        i.provider_conversation_id, i.provider_file_id, i.provider_event_id, i.local_item_id,
        i.source_version, i.title, i.sender_id, i.sender_label, i.sender_is_owner,
        i.mime_type, i.authored_at, i.updated_at,
        i.trust_tier, i.sync_run_id,
        -- Bare column beside a single MIN(): SQLite takes it from the very row
        -- that produced the minimum, so this is the BEST-RANKING chunk for the
        -- item rather than an arbitrary one. That is exactly the chunk the
        -- citation should point at.
        connector_store_fts.chunk_pk AS chunk_pk,
        MIN(connector_store_fts.rank) AS rank
      FROM connector_store_fts
      JOIN items i ON i.item_pk = connector_store_fts.item_pk
      WHERE connector_store_fts MATCH ?
        AND connector_store_fts.rank MATCH 'bm25(${CONNECTOR_STORE_FTS_TITLE_WEIGHT}, 1.0)'
        AND i.tombstoned = 0
        ${selectedAccount ? 'AND i.account_scope = ?' : ''}
        ${selectedFilters.sql}
      GROUP BY i.item_pk
      ORDER BY rank ASC, COALESCE(i.updated_at, i.authored_at, i.indexed_at) DESC
      LIMIT ?
    `).all(
      terms,
      ...(selectedAccount ? [selectedAccount] : []),
      ...selectedFilters.params,
      fetchLimit,
    ) as ItemRow[];
    // Minimum signal: for a multi-concept query, a candidate matching a
    // single concept is lexical noise, not evidence (live incident
    // 2026-07-25: a bookmark was cited for a four-concept question on the
    // strength of the lone word "schedule"). Distinct concept groups —
    // raw token plus synonyms — must match at least twice.
    let selected = rows;
    if (minimumSignal && rows.length > 0) {
      const pks = rows.map((row) => row.item_pk);
      const placeholders = pks.map(() => '?').join(', ');
      const matchedGroups = new Map<number, number>();
      for (const group of groups) {
        const hits = this.db.query(`
          SELECT DISTINCT item_pk FROM connector_store_fts
          WHERE connector_store_fts MATCH ? AND item_pk IN (${placeholders})
        `).all(sourceIndexFtsGroupQuery(group), ...pks) as Array<{ item_pk: number }>;
        for (const hit of hits) {
          matchedGroups.set(hit.item_pk, (matchedGroups.get(hit.item_pk) ?? 0) + 1);
        }
      }
      selected = rows.filter((row) => (matchedGroups.get(row.item_pk) ?? 0) >= 2);
    }
    const spanTerms = queryTermsForSpan(query);
    return selected.slice(0, limit).map((row) => {
      const base = searchRowFromItemRow(row);
      const chunk = row.chunk_pk === null || row.chunk_pk === undefined
        ? undefined
        : this.chunkMatchForChunkPk(row.chunk_pk, 'keyword', spanTerms);
      return chunk ? { ...base, chunk } : base;
    });
  }

  /**
   * Resolve one matched chunk into an offsets-only locator.
   *
   * `charStart`/`charEnd` are UTF-16 offsets inside this chunk's bounded text.
   * The item-level pair is the same span shifted by the total length of every
   * chunk before it, summed in JS rather than via SQL `LENGTH()` on purpose:
   * SQLite counts code points and JavaScript counts UTF-16 units, and an item
   * containing a single astral character (an emoji in a chat message — routine,
   * not exotic) would make the two disagree. One coordinate system, chosen to
   * be the one every consumer of these numbers is already written in.
   *
   * Cost: one indexed row plus that item's preceding chunk text, per candidate
   * a lane returns. Bounded by MAX_SEARCH_RESULTS, and the same text the
   * evidence-pack hydration path reads for every surviving hit moments later —
   * so the added work is a fraction of a lane that is already dominated by the
   * vector scan.
   *
   * `queryTerms` narrows the span for the keyword lane. A semantic lane passes
   * none: its signal is a whole-chunk cosine, and inventing a tighter span from
   * it would be a claim the score cannot support.
   */
  private chunkMatchForChunkPk(
    chunkPk: number,
    lane: 'keyword' | 'semantic',
    queryTerms?: readonly string[],
  ): ConnectorStoreChunkMatch | undefined {
    const row = this.db.query(
      'SELECT item_pk, chunk_index, content_hash, bounded_text FROM chunks WHERE chunk_pk = ?',
    ).get(chunkPk) as
      | { item_pk: number; chunk_index: number; content_hash: string; bounded_text: string }
      | null;
    if (!row) return undefined;

    const priorRows = this.db.query(
      'SELECT bounded_text FROM chunks WHERE item_pk = ? AND chunk_index < ? ORDER BY chunk_index',
    ).all(row.item_pk, row.chunk_index) as Array<{ bounded_text: string }>;
    const itemOffset = priorRows.reduce((sum, prior) => sum + prior.bounded_text.length, 0);

    const chunkChars = row.bounded_text.length;
    const { charStart, charEnd } = queryTerms?.length
      ? firstTermSpan(row.bounded_text, queryTerms)
      : { charStart: 0, charEnd: chunkChars };
    return {
      chunkId: String(chunkPk),
      chunkIndex: row.chunk_index,
      contentHash: row.content_hash,
      charStart,
      charEnd,
      itemCharStart: itemOffset + charStart,
      itemCharEnd: itemOffset + charEnd,
      chunkChars,
      lane,
    };
  }

  // Recency lane: newest live items regardless of query match, same
  // membrane-safe rows as the keyword lane. Chat questions are
  // disproportionately about "just now", and a fresh item can lose a pure
  // relevance ranking (or lack embeddings entirely) minutes after arrival.
  // Chunk-less items (media awaiting transcription, empty texts) are skipped:
  // a pinned candidate with no extractable content wastes an evidence slot on
  // an extraction gap (observed live 2026-07-05).
  recentItems(
    maxResults: number,
    accountScope?: string,
    filters?: ConnectorStoreSearchFilters,
  ): ConnectorStoreSearchRow[] {
    const limit = Math.max(1, Math.min(Math.floor(maxResults), MAX_SEARCH_RESULTS));
    const selectedAccount = normalizeOptionalAccountScope(accountScope);
    const selectedFilters = connectorStoreFilterSql(filters);
    const rows = this.db.query(`
      SELECT
        i.item_pk, i.provider, i.family, i.account_scope, i.provider_item_id, i.provider_thread_id,
        i.provider_conversation_id, i.provider_file_id, i.provider_event_id, i.local_item_id,
        i.source_version, i.title, i.sender_id, i.sender_label, i.sender_is_owner,
        i.mime_type, i.authored_at, i.updated_at,
        i.trust_tier, i.sync_run_id,
        0 AS rank
      FROM items i
      WHERE i.tombstoned = 0
        ${selectedAccount ? 'AND i.account_scope = ?' : ''}
        ${selectedFilters.sql}
        AND EXISTS (SELECT 1 FROM chunks c WHERE c.item_pk = i.item_pk)
      ORDER BY COALESCE(i.authored_at, i.updated_at, i.indexed_at) DESC, i.item_pk DESC
      LIMIT ?
    `).all(
      ...(selectedAccount ? [selectedAccount] : []),
      ...selectedFilters.params,
      limit,
    ) as ItemRow[];
    return rows.map((row) => searchRowFromItemRow(row));
  }

  // Local content lane for the evidence-pack provider: bounded chunks, the
  // stored trust tier, and the locator uri. Tombstoned/unknown items yield
  // undefined so the pack records an honest extraction gap.
  localContent(localItemId: string, maxChars?: number): ConnectorStoreLocalContent | undefined {
    const row = this.db.query(`
      SELECT item_pk, trust_tier, locator_uri, mime_type,
        ${this.reactionsColumnPresent ? 'reactions_json' : 'NULL AS reactions_json'}
      FROM items WHERE local_item_id = ? AND tombstoned = 0
    `).get(localItemId) as {
      item_pk: number;
      trust_tier: string;
      locator_uri: string | null;
      mime_type: string;
      reactions_json: string | null;
    } | null;
    if (!row) return undefined;
    const chunkRows = this.db.query(
      'SELECT bounded_text FROM chunks WHERE item_pk = ? ORDER BY chunk_index',
    ).all(row.item_pk) as Array<{ bounded_text: string }>;
    const { chunks, truncated } = budgetChunks(chunkRows.map((chunk) => chunk.bounded_text), maxChars);
    // Item-level context seam: the reaction line is prepended as its own
    // leading block rather than written into a chunk. Chunks stay a faithful
    // copy of the source text (a reaction never rewrites what was said), and
    // the Analyst still reads the reaction beside the message it confirms, so
    // a released citation can carry "confirmed by 👍 ×2". It rides ahead of
    // the char budget deliberately: it is bounded and it is the only part of
    // the evidence a truncation must never silently drop.
    const reactionLine = renderSourceReactionLine(parseStoredSourceReactions(row.reactions_json));
    return {
      trustTier: trustTierFromRow(row.trust_tier),
      chunks: reactionLine ? [reactionLine, ...chunks] : chunks,
      truncated,
      storedChunks: chunkRows.length,
      mimeType: row.mime_type,
      ...(row.locator_uri ? { locatorUri: row.locator_uri } : {}),
    };
  }

  // The stored reaction aggregate for one item. Content-tier data, like the
  // message text it is attached to: fine in search and evidence, never in a
  // counts-only receipt, a lane audit, or a log line.
  itemReactions(localItemId: string): readonly SourceReaction[] {
    if (!this.reactionsColumnPresent) return [];
    const row = this.db.query(
      'SELECT reactions_json FROM items WHERE local_item_id = ? AND tombstoned = 0',
    ).get(localItemId) as { reactions_json: string | null } | null;
    return parseStoredSourceReactions(row?.reactions_json);
  }

  status(): ConnectorStoreStatus {
    const counts = this.db.query(`
      SELECT
        (SELECT COUNT(*) FROM items WHERE tombstoned = 0) AS items,
        (SELECT COUNT(*) FROM items WHERE tombstoned = 1) AS tombstoned_items,
        (SELECT COUNT(*) FROM chunks) AS chunks,
        (SELECT COUNT(*)
          FROM chunk_embeddings emb
          JOIN chunks c ON c.chunk_pk = emb.chunk_pk
          JOIN items i ON i.item_pk = emb.item_pk
          WHERE i.tombstoned = 0 AND emb.content_hash = c.embedding_input_hash
        ) AS embedded_chunks,
        (SELECT COUNT(*) FROM sync_runs
          WHERE connector_id <> 'connector_store_embedding_write_authority'
        ) AS sync_runs,
        -- EXISTS rather than COUNT(DISTINCT ...) so the per-item probe stops at
        -- the first chunk row instead of walking every chunk of every item.
        (SELECT COUNT(*) FROM items i
          WHERE i.tombstoned = 0
            AND EXISTS (SELECT 1 FROM chunks c WHERE c.item_pk = i.item_pk)
        ) AS items_with_text
    `).get() as {
      items: number;
      tombstoned_items: number;
      chunks: number;
      embedded_chunks: number;
      sync_runs: number;
      items_with_text: number;
    };
    // Parity per model. The inner probe is a primary-key lookup on
    // (chunk_pk, model_id), so it stays an indexed point read per chunk.
    const byModel = this.db.query(`
      SELECT
        m.model_id AS model_id,
        (SELECT COUNT(*)
          FROM chunk_embeddings emb
          JOIN chunks c ON c.chunk_pk = emb.chunk_pk
          JOIN items i ON i.item_pk = emb.item_pk
          WHERE i.tombstoned = 0 AND emb.model_id = m.model_id AND emb.content_hash = c.embedding_input_hash
        ) AS embedded_chunks,
        (SELECT COUNT(*) FROM items i
          WHERE i.tombstoned = 0
            AND EXISTS (SELECT 1 FROM chunks c WHERE c.item_pk = i.item_pk)
            AND NOT EXISTS (
              SELECT 1 FROM chunks c
              WHERE c.item_pk = i.item_pk
                AND NOT EXISTS (
                  SELECT 1 FROM chunk_embeddings emb
                  WHERE emb.chunk_pk = c.chunk_pk
                    AND emb.model_id = m.model_id
                    AND emb.content_hash = c.embedding_input_hash
                )
            )
        ) AS items_embedded
      FROM (SELECT DISTINCT model_id FROM chunk_embeddings) m
      ORDER BY m.model_id
    `).all() as Array<{ model_id: string; embedded_chunks: number; items_embedded: number }>;
    // "Last" means most-recently-inserted. started_at has only millisecond
    // resolution, so two runs in the same tick tie on it; sync_run_id is a
    // random UUID, so tie-breaking on it picks a run at random (an
    // order-dependent flake in status().lastSyncRun). rowid is monotonic with
    // insertion, so it breaks the tie by true recency.
    const last = this.db.query(
      `SELECT * FROM sync_runs
       WHERE connector_id <> 'connector_store_embedding_write_authority'
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ).get() as SyncRunRow | null;
    return {
      corpusId: this.corpusId,
      family: this.family,
      trustDomain: this.trustDomain,
      counts: {
        items: counts.items,
        tombstonedItems: counts.tombstoned_items,
        chunks: counts.chunks,
        embeddedChunks: counts.embedded_chunks,
        syncRuns: counts.sync_runs,
        itemsWithText: counts.items_with_text,
      },
      embeddingByModel: byModel.map((row) => ({
        modelId: row.model_id,
        embeddedChunks: row.embedded_chunks,
        itemsEmbedded: row.items_embedded,
      })),
      ...(last ? { lastSyncRun: syncRunFromRow(last) } : {}),
    };
  }

  syncRun(syncRunId: string): ConnectorStoreSyncRun | undefined {
    const row = this.db.query('SELECT * FROM sync_runs WHERE sync_run_id = ?').get(syncRunId) as SyncRunRow | null;
    return row ? syncRunFromRow(row) : undefined;
  }

  /**
   * The newest COMPLETED run of ONE connector: the only row in `sync_runs`
   * that is a valid place to resume a traversal from.
   *
   * `status().lastSyncRun` is deliberately unscoped — it answers "what did this
   * store do most recently", an observability question. Resuming from it was a
   * cross-lane rewind, for two independent reasons:
   *
   * - Connectors share stores. Gmail and Drive both write the internal store,
   *   and the extraction factory writes rows into the Dropbox store. The newest
   *   row is routinely a different lane's, and a foreign cursor is either
   *   rejected (a silent full restart) or, worse, structurally valid.
   * - `cursor` holds where a run ENDED only once it has ended. The insert seeds
   *   it with the run's STARTING cursor, so a row still `running` — or one left
   *   behind by a killed process — hands back the position that run began at.
   *   Resuming from that walks the traversal backwards and looks like a normal
   *   resume while doing it.
   *
   * Both filters are load-bearing; neither is a tightening of the other.
   */
  lastCompletedSyncRun(connectorId: string): ConnectorStoreSyncRun | undefined {
    const row = this.db.query(`
      SELECT * FROM sync_runs
      WHERE connector_id = ? AND status = 'completed'
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1
    `).get(connectorId) as SyncRunRow | null;
    return row ? syncRunFromRow(row) : undefined;
  }

  /**
   * The newest run for a connector that reached a TERMINAL state — completed
   * or failed — and therefore holds where it actually got to.
   *
   * A failed run's `cursor` is written by the failure path itself, so it is the
   * furthest durable position the lane reached before it stopped. That position
   * was unreachable: `lastCompletedSyncRun` is the only accessor, so a lane
   * whose run threw had its progress preserved on disk and invisible to the
   * code that needed it, and resumed from its floor instead.
   *
   * `running` rows stay excluded for the reason they always were: the insert
   * seeds `cursor` with the run's STARTING position, so a row still running —
   * or one a killed process left behind — hands back a point the traversal has
   * already passed.
   *
   * Only a lane whose cursor is a position in a LOCAL keyset should prefer this
   * over the completed-run accessor. A provider page token from a failed run is
   * as likely to be the reason it failed.
   */
  lastTerminalSyncRun(connectorId: string): ConnectorStoreSyncRun | undefined {
    const row = this.db.query(`
      SELECT * FROM sync_runs
      WHERE connector_id = ? AND status IN ('completed', 'failed')
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1
    `).get(connectorId) as SyncRunRow | null;
    return row ? syncRunFromRow(row) : undefined;
  }
}

export function verifyConnectorStoreCorpusIntegrity(
  store: LocalConnectorStore,
  options: ConnectorStoreCorpusIntegrityOptions,
): ConnectorStoreCorpusIntegrityReport {
  return store.verifyCorpusIntegrity(options);
}

/**
 * Generic latency-sensitive connector runner. It observes normalized item ids
 * while the shared store consumes Contract 1, then embeds only that bounded
 * selection. The store intentionally refuses more than 25,000 selected ids in
 * one call to bound SQLite parameters. Throwing that typed refusal after sync
 * would strand later committed ids behind an already-durable cursor, so this
 * runner batches the selection and does not report completion until every
 * batch embeds successfully. No source family branches live here.
 */
export async function syncAndEmbedFromConnector(
  options: ConnectorStoreSyncAndEmbedOptions,
): Promise<ConnectorStoreSyncAndEmbedSummary> {
  const localItemIds = new Set<string>();
  const connector: SourceConnector = {
    id: options.connector.id,
    family: options.connector.family,
    authenticate: () => options.connector.authenticate(),
    listItems(listOptions) {
      const pages = options.connector.listItems(listOptions);
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        for await (const page of pages) {
          for (const item of page.items) localItemIds.add(item.identity.localItemId);
          yield page;
        }
      })();
    },
    fetchItem: (localItemId) => options.connector.fetchItem(localItemId),
    classify: (item) => options.connector.classify(item),
  };
  const sync = await options.store.syncFromConnector(connector, options.sync);
  const selectedIds = [...localItemIds];
  const selectedBatches = selectedIds.length === 0
    ? [[]]
    : [...batched(selectedIds, MAX_SELECTED_EMBED_ITEM_IDS)];
  let embed: ConnectorStoreEmbedSummary | undefined;
  for (const localItemIdBatch of selectedBatches) {
    const batch = await options.store.embedChunks({
      provider: options.embeddingProvider,
      localItemIds: localItemIdBatch,
    });
    embed = embed
      ? {
        ...embed,
        chunksSeen: embed.chunksSeen + batch.chunksSeen,
        chunksEmbedded: embed.chunksEmbedded + batch.chunksEmbedded,
        chunksSkipped: embed.chunksSkipped + batch.chunksSkipped,
      }
      : batch;
  }
  if (!embed) {
    throw new Error('Connector store sync-and-embed produced no embed batches.');
  }
  return { sync, embed };
}

/**
 * Replays a connector's normalized metadata through the shared sender repair
 * primitive without reading or rewriting source content.
 */
export async function repairConnectorStoreSendersFromConnector(options: {
  store: LocalConnectorStore;
  connector: SourceConnector;
  cursor?: string;
  maxItems?: number;
}): Promise<ConnectorStoreConnectorSenderRepairSummary> {
  const maxItems = normalizeMaxItems(options.maxItems);
  const records: ConnectorStoreSenderRepairRecord[] = [];
  let resumeCursor = options.cursor;
  let converged = false;
  await options.connector.authenticate();
  for await (const page of options.connector.listItems({
    ...(options.cursor ? { cursor: options.cursor } : {}),
    limit: Math.min(maxItems ?? 500, 500),
  })) {
    for (const item of page.items) {
      if (maxItems !== undefined && records.length >= maxItems) break;
      records.push({
        sourceItem: item.identity,
        ...senderMetadataFromRawItem(item),
      });
    }
    resumeCursor = page.nextCursor ?? resumeCursor;
    if (page.done) {
      converged = true;
      break;
    }
    // A connector cursor advances past the whole yielded page. Stop only at a
    // page boundary so a bounded repair never truncates a page and skips the
    // unprocessed tail when the returned cursor is resumed.
    if (maxItems !== undefined) break;
  }
  const repair = options.store.repairSenderMetadata({ records });
  return {
    status: 'completed',
    converged,
    counts: repair.counts,
    inputDigestSha256: repair.inputDigestSha256,
    outputDigestSha256: repair.outputDigestSha256,
    ...(!converged && resumeCursor ? { resumeCursor } : {}),
  };
}

// --- Corpus definition --------------------------------------------------------

export interface ConnectorCorpusOptions {
  corpusId: string;
  family: SourceFamily;
  trustDomain: SourceTrustDomain;
  activationMode?: SourceIndexActivationMode;
}

export function defineConnectorCorpus(options: ConnectorCorpusOptions): SourceIndexCorpusDefinition {
  return defineSourceIndexCorpus({
    corpusId: options.corpusId,
    family: options.family,
    trustDomain: options.trustDomain,
    activationMode: options.activationMode ?? 'lexical_only',
    description: 'Shared connector-store corpus: generic local index over a Contract 1 SourceConnector.',
  });
}

// --- Routed search adapter ------------------------------------------------------

export interface ConnectorStoreCorpusAdapterOptions {
  store: LocalConnectorStore;
  embeddingProvider?: SourceEmbeddingProvider;
  retrievalMode?: 'keyword' | 'hybrid';
  /** Absolute cosine floor for hybrid vector-lane rows; sub-bar semantic similarity is not evidence. */
  semanticRelevanceBar?: number;
  /** Optional principal account boundary applied to every retrieval lane. */
  accountScope?: string;
  /** Message/store metadata filters applied in SQL in every retrieval lane. */
  filters?: ConnectorStoreSearchFilters;
  /** Optional declared projection applied only to final eligible hits. */
  resultProjector?: ConnectorStoreResultProjector;
}

// Membrane-safe routed search: hits carry identity + provenance with a
// citation title only. No chunk text, snippet, or generic locator column copy.
// A declared optional result projector may lazily map only final eligible
// hits; without one, locators remain confined to the local content lane.
//
// Retrieval mode mirrors the Dropbox lane: when the adapter holds an
// embedding provider AND the store has current embeddings for its model, the
// keyword FTS lane and the cosine vector lane run together and fuse via RRF.
// Otherwise the keyword lane serves alone (with an honest skip reason when a
// provider was configured but could not run). secure_local stores never run
// the vector lane with a non-local provider — fail closed to keyword.
export function createConnectorStoreCorpusAdapter(
  options: ConnectorStoreCorpusAdapterOptions,
): SourceIndexCorpusSearchAdapter {
  const { store, embeddingProvider } = options;
  const filters = normalizeConnectorStoreSearchFilters(options.filters);
  const semanticRelevanceBar = normalizeSemanticRelevanceBar(options.semanticRelevanceBar);
  const adapter: SourceIndexCorpusSearchAdapter = (
    request: SourceIndexCorpusSearchRequest,
  ): SourceIndexCorpusSearchResponse | Promise<SourceIndexCorpusSearchResponse> => {
    assertConnectorStoreCorpusRequest(store, request);
    const startedAt = Date.now();

    let semanticSkippedReason: string | undefined;
    const useHybrid = options.retrievalMode ?? (embeddingProvider ? 'hybrid' : 'keyword');
    if (embeddingProvider && useHybrid === 'hybrid') {
      if (store.trustDomain === 'secure_local' && embeddingProvider.backend !== 'local') {
        semanticSkippedReason = 'secure_local_embedding_provider_not_local';
      } else if (!store.hasEmbeddings(embeddingProvider.modelId)) {
        semanticSkippedReason = 'no_embedding_artifacts';
      }
    }

    if (!embeddingProvider || useHybrid !== 'hybrid' || semanticSkippedReason) {
      const rows = store.searchItems(request.query, request.maxResults, options.accountScope, filters);
      const recencyRows = chatRecencyLaneRows(store, options.accountScope, filters);
      if (recencyRows.length === 0) {
        const hits = rows.map((row) => connectorStoreHitFromRow(
          store,
          row,
          -row.rank,
          options.resultProjector,
          filters?.locatorPathScope,
        ));
        return {
          hits,
          latencyMs: Date.now() - startedAt,
          laneAudits: [{
            ...connectorStoreKeywordLaneAudit(store.corpusId, rows.length, hits.length),
            ...(semanticSkippedReason
              ? { skippedReason: semanticSkippedReason, modelId: embeddingProvider!.modelId }
              : {}),
          }],
          rawExposed: false,
        };
      }
      const fused = fuseRankedCandidateLanes({
        lanes: [
          { name: 'keyword', items: rows },
          { name: 'recency', items: recencyRows },
        ],
        getId: (row) => row.sourceItem.localItemId,
        limit: Math.max(1, Math.min(Math.floor(request.maxResults), MAX_SEARCH_RESULTS)),
        tieBreaker: compareConnectorStoreSearchCandidates,
      });
      const hits = withPinnedNewestChatHits({
        store,
        recencyRows,
        hits: fused.map((candidate) => connectorStoreHitFromRow(
          store,
          candidate.item,
          candidate.score,
          options.resultProjector,
          filters?.locatorPathScope,
        )),
        limit: request.maxResults,
        ...(options.resultProjector ? { resultProjector: options.resultProjector } : {}),
        ...(filters?.locatorPathScope ? { locatorPathScope: filters.locatorPathScope } : {}),
      });
      return {
        hits,
        latencyMs: Date.now() - startedAt,
        laneAudits: [
          {
            ...connectorStoreKeywordLaneAudit(store.corpusId, rows.length, rows.length),
            ...(semanticSkippedReason
              ? { skippedReason: semanticSkippedReason, modelId: embeddingProvider!.modelId }
              : {}),
          },
          connectorStoreRecencyLaneAudit(store.corpusId, recencyRows.length),
        ],
        rawExposed: false,
      };
    }

    return hybridConnectorStoreSearch(
      store,
      embeddingProvider,
      request,
      startedAt,
      options.accountScope,
      filters,
      semanticRelevanceBar,
      options.resultProjector,
    );
  };
  adapter.hybridAvailability = () => {
    if (!embeddingProvider) {
      return { servable: false, reason: 'embedding_provider_unavailable' };
    }
    if (store.trustDomain === 'secure_local' && embeddingProvider.backend !== 'local') {
      return {
        servable: false,
        reason: 'embedding_provider_not_allowed',
        modelId: embeddingProvider.modelId,
        embeddingEpoch: embeddingProvider.epochId,
        backend: embeddingProvider.backend,
      };
    }
    const servable = store.hasEmbeddings(embeddingProvider.modelId);
    return {
      servable,
      ...(!servable ? { reason: 'no_current_embedding_artifacts' as const } : {}),
      modelId: embeddingProvider.modelId,
      embeddingEpoch: embeddingProvider.epochId,
      backend: embeddingProvider.backend,
    };
  };
  return adapter;
}

// Chat-family stores get a recency candidate lane: the newest few messages
// always compete in fusion, so "did I just get..." questions can surface an
// item that arrived seconds ago — before embeddings exist for it and even
// when dozens of older items outrank it lexically. Family-scoped
// (capability-not-source): any chat connector store gets it, none of the
// document/note families pay for it.
const CHAT_RECENCY_LANE_LIMIT = 8;
// RRF alone cannot guarantee the newest message survives the final cut: when
// the query matches many items, older recent+matching candidates are
// dual-lane and outscore a single-lane fresh arrival. The newest messages
// get pinned slots instead (2026-07-05 "Test 15" probe).
const CHAT_RECENCY_PIN_COUNT = 2;

function chatRecencyLaneRows(
  store: LocalConnectorStore,
  accountScope?: string,
  filters?: ConnectorStoreSearchFilters,
): ConnectorStoreSearchRow[] {
  if (store.family !== 'chat') return [];
  // Full lane depth regardless of maxResults: the lane feeds FUSION, not the
  // final cut. Capping it at maxResults=3 dropped a message that was only 4
  // items deep minutes after it arrived (2026-07-05 probe).
  return store.recentItems(CHAT_RECENCY_LANE_LIMIT, accountScope, filters);
}

function connectorStoreHitFromRow(
  store: LocalConnectorStore,
  row: ConnectorStoreSearchRow,
  score: number,
  resultProjector?: ConnectorStoreResultProjector,
  locatorPathScope?: string,
): SourceIndexSearchHit {
  let locatorRead = false;
  let locatorUri: string | undefined;
  const projection = resultProjector?.project({
    sourceItem: row.sourceItem,
    readLocatorUri() {
      if (!locatorRead) {
        locatorUri = store[READ_RESULT_PROJECTION_LOCATOR_URI](row.sourceItem, locatorPathScope);
        locatorRead = true;
      }
      return locatorUri;
    },
  });
  return {
    ...(projection ?? {}),
    sourceItem: row.sourceItem,
    provenance: provenanceFromSearchRow(store.corpusId, row),
    candidateId: `${store.corpusId}:${row.sourceItem.localItemId}`,
    score,
    rawExposed: false,
  };
}

// Guarantee the newest chat messages a place in the final cut: evict the
// lowest-scoring hits if needed. Pinned hits append at the tail (they earned
// no relevance rank); temporal evidence ordering re-sorts when the question
// asks about recency.
function withPinnedNewestChatHits(input: {
  store: LocalConnectorStore;
  recencyRows: readonly ConnectorStoreSearchRow[];
  hits: SourceIndexSearchHit[];
  limit: number;
  resultProjector?: ConnectorStoreResultProjector;
  locatorPathScope?: string;
}): SourceIndexSearchHit[] {
  const limit = Math.max(1, Math.min(Math.floor(input.limit), MAX_SEARCH_RESULTS));
  const pinCount = Math.min(CHAT_RECENCY_PIN_COUNT, limit, input.recencyRows.length);
  if (pinCount === 0) return input.hits;
  const result = [...input.hits];
  const present = new Set(result.map((hit) => hit.sourceItem.localItemId));
  for (let index = 0; index < pinCount; index += 1) {
    const row = input.recencyRows[index]!;
    if (present.has(row.sourceItem.localItemId)) continue;
    while (result.length >= limit) result.pop();
    result.push(connectorStoreHitFromRow(
      input.store,
      row,
      reciprocalRank(index + 1),
      input.resultProjector,
      input.locatorPathScope,
    ));
    present.add(row.sourceItem.localItemId);
  }
  return result;
}

function connectorStoreRecencyLaneAudit(corpusId: string, candidateCount: number): RetrievalLaneAudit {
  return {
    laneName: `${corpusId}:connector_store_recency`,
    laneType: 'metadata',
    candidateCount,
    returnedCount: candidateCount,
    backend: 'sqlite',
    localOnly: true,
    rawExposed: false,
  };
}

async function hybridConnectorStoreSearch(
  store: LocalConnectorStore,
  provider: SourceEmbeddingProvider,
  request: SourceIndexCorpusSearchRequest,
  startedAt: number,
  accountScope?: string,
  filters?: ConnectorStoreSearchFilters,
  semanticRelevanceBar?: number,
  resultProjector?: ConnectorStoreResultProjector,
): Promise<SourceIndexCorpusSearchResponse> {
  const maxResults = Math.max(1, Math.min(Math.floor(request.maxResults), MAX_SEARCH_RESULTS));
  // Over-fetch each lane (the same posture as the Dropbox hybrid lane) so
  // fusion sees candidates beyond the final cut.
  const laneLimit = Math.min(maxResults * 6, MAX_SEARCH_RESULTS);
  const keywordRows = store.searchItems(request.query, laneLimit, accountScope, filters, { prefix: false });
  const vectorLane = await store.vectorSearchLane(
    request.query,
    provider,
    laneLimit,
    accountScope,
    filters,
    request.deadlineAtMs,
  );
  const scoredVectorRows = vectorLane.rows;
  // The bar applies to the vector lane unconditionally: sub-bar semantic
  // similarity is not evidence, whatever the keyword lane returned. Keyword
  // hits stand on their own lexical merit (live calibration 2026-07-25:
  // common-token FTS saturation gives off-domain questions nonzero keyword
  // rows, so a keyword-empty arming condition never fires on exactly the
  // questions the bar exists for).
  const gateArmed = semanticRelevanceBar !== undefined;
  const vectorRows = gateArmed
    ? scoredVectorRows.filter((row) => row.bestCosine >= semanticRelevanceBar)
    : scoredVectorRows;
  const suppressedBelowBar = scoredVectorRows.length - vectorRows.length;
  const bestCosine = scoredVectorRows.length > 0
    ? roundCosine(Math.max(...scoredVectorRows.map((row) => row.bestCosine)))
    : undefined;
  const recencyRows = chatRecencyLaneRows(store, accountScope, filters);

  const fused = fuseRankedCandidateLanes({
    lanes: [
      { name: 'keyword', items: keywordRows },
      { name: 'vector', items: vectorRows },
      ...(recencyRows.length > 0 ? [{ name: 'recency', items: recencyRows }] : []),
    ],
    getId: (row) => row.sourceItem.localItemId,
    limit: maxResults,
    tieBreaker: compareConnectorStoreSearchCandidates,
  });
  const hits = withPinnedNewestChatHits({
    store,
    recencyRows,
    hits: fused.map((candidate) => connectorStoreHitFromRow(
      store,
      candidate.item,
      candidate.score,
      resultProjector,
      filters?.locatorPathScope,
    )),
    limit: maxResults,
    ...(resultProjector ? { resultProjector } : {}),
    ...(filters?.locatorPathScope ? { locatorPathScope: filters.locatorPathScope } : {}),
  });

  return {
    hits,
    latencyMs: Date.now() - startedAt,
    // Per-lane candidate counts: keyword, vector, and the fused cut — the
    // same audit fields the Dropbox retrieval audit records
    // (keyword_candidates / vector_candidates / fused_candidates).
    laneAudits: [
      connectorStoreKeywordLaneAudit(store.corpusId, keywordRows.length, keywordRows.length),
      {
        laneName: `${store.corpusId}:connector_store_vector`,
        laneType: 'semantic',
        candidateCount: scoredVectorRows.length,
        returnedCount: vectorRows.length,
        ...(bestCosine !== undefined ? { bestCosine } : {}),
        ...(suppressedBelowBar > 0 ? { suppressedBelowBar } : {}),
        // The lane's own refusal outranks the relevance bar: a fence that
        // retired the lane is a different fact from a lane that ran and found
        // nothing above the bar, and the audit must not report the second when
        // the first happened.
        ...(vectorLane.skippedReason !== undefined
          ? { skippedReason: vectorLane.skippedReason }
          : gateArmed && scoredVectorRows.length > 0 && vectorRows.length === 0
            ? { skippedReason: 'semantic_below_relevance_bar' }
            : {}),
        modelId: provider.modelId,
        backend: VECTOR_BACKEND,
        localOnly: true,
        rawExposed: false,
      },
      ...(recencyRows.length > 0
        ? [connectorStoreRecencyLaneAudit(store.corpusId, recencyRows.length)]
        : []),
      {
        laneName: `${store.corpusId}:hybrid`,
        laneType: 'hybrid',
        candidateCount: fused.length,
        returnedCount: hits.length,
        modelId: provider.modelId,
        backend: VECTOR_BACKEND,
        localOnly: true,
        rawExposed: false,
      },
    ],
    rawExposed: false,
  };
}

function roundCosine(value: number): number {
  return Number(value.toFixed(4));
}

function connectorStoreVectorDeadlineExpired(deadlineAtMs: number | undefined): boolean {
  return deadlineAtMs !== undefined && Number.isFinite(deadlineAtMs) && Date.now() >= deadlineAtMs;
}

function yieldConnectorStoreVectorScan(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function normalizeSemanticRelevanceBar(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error('Connector store semantic relevance bar must be a finite number greater than 0 and less than 1.');
  }
  return value;
}

// RRF tie-breaker, mirroring the Dropbox fusion: better keyword rank first,
// then better vector rank, then recency.
function compareConnectorStoreSearchCandidates(
  left: FusedRankedCandidate<ConnectorStoreSearchRow>,
  right: FusedRankedCandidate<ConnectorStoreSearchRow>,
): number {
  const leftKeyword = left.laneRanks.get('keyword') ?? Number.POSITIVE_INFINITY;
  const rightKeyword = right.laneRanks.get('keyword') ?? Number.POSITIVE_INFINITY;
  if (leftKeyword !== rightKeyword) return leftKeyword - rightKeyword;
  const leftVector = left.laneRanks.get('vector') ?? Number.POSITIVE_INFINITY;
  const rightVector = right.laneRanks.get('vector') ?? Number.POSITIVE_INFINITY;
  if (leftVector !== rightVector) return leftVector - rightVector;
  const leftDate = left.item.updatedAt ?? left.item.authoredAt ?? '';
  const rightDate = right.item.updatedAt ?? right.item.authoredAt ?? '';
  return rightDate.localeCompare(leftDate);
}

function assertConnectorStoreCorpusRequest(store: LocalConnectorStore, request: SourceIndexCorpusSearchRequest): void {
  if (request.corpus.corpusId !== store.corpusId) {
    throw new Error(`Connector store adapter for ${store.corpusId} cannot serve corpus ${request.corpus.corpusId}.`);
  }
  if (request.corpus.trustDomain !== store.trustDomain || request.corpus.family !== store.family) {
    throw new Error(
      `Connector store adapter for ${store.corpusId} requires the ${store.trustDomain} ${store.family} corpus.`,
    );
  }
}

function provenanceFromSearchRow(corpusId: string, row: ConnectorStoreSearchRow): SourceIndexProvenance {
  return {
    sourceItem: row.sourceItem,
    // The frozen provenance shape has carried an optional `chunk` since the
    // contracts were written and no lane ever filled it, which is why citations
    // stopped at the item. Filling it here is what makes offset-level citation
    // possible downstream without a parallel format.
    ...(row.chunk
      ? {
          chunk: {
            sourceItem: row.sourceItem,
            chunkId: row.chunk.chunkId,
            chunkIndex: row.chunk.chunkIndex,
            contentHash: row.chunk.contentHash,
            span: {
              charStart: row.chunk.charStart,
              charEnd: row.chunk.charEnd,
              itemCharStart: row.chunk.itemCharStart,
              itemCharEnd: row.chunk.itemCharEnd,
              chunkChars: row.chunk.chunkChars,
              lane: row.chunk.lane,
            },
          },
        }
      : {}),
    localIds: {
      corpus_id: corpusId,
      local_item_id: row.sourceItem.localItemId,
    },
    syncRunId: row.syncRunId,
    citation: {
      ...(row.title ? { title: row.title } : {}),
      sourceLabel: row.sourceItem.provider,
      ...(row.conversationLabel ? { conversationLabel: row.conversationLabel } : {}),
      ...(row.authorLabel ? { authorLabel: row.authorLabel } : {}),
      ...(row.authoredAt ? { authoredAt: row.authoredAt } : {}),
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    },
  };
}

function connectorStoreKeywordLaneAudit(
  corpusId: string,
  candidateCount: number,
  returnedCount: number,
): RetrievalLaneAudit {
  return {
    laneName: `${corpusId}:connector_store_fts`,
    laneType: 'keyword',
    candidateCount,
    returnedCount,
    backend: 'sqlite_fts5',
    localOnly: true,
    rawExposed: false,
  };
}

// --- Local content provider ----------------------------------------------------

export interface ConnectorStoreContentProviderOptions {
  store: LocalConnectorStore;
}

// LocalContentProvider over the store: bounded chunks, the item's stored
// sensitivity, and the stored locator uri. Local by construction — every read
// goes to the store's sqlite file; nothing here touches the network.
export function createConnectorStoreContentProvider(
  options: ConnectorStoreContentProviderOptions,
): LocalContentProvider {
  const { store } = options;
  return {
    async fetchLocalContent(request: LocalContentRequest): Promise<LocalContentBlock | undefined> {
      if (request.trustDomain !== store.trustDomain) {
        throw new Error(
          `Connector store content provider for ${store.corpusId} (${store.trustDomain}) `
          + `refused a ${request.trustDomain} content request.`,
        );
      }
      const localItemId = request.provenance.sourceItem.localItemId.trim();
      if (!localItemId) return undefined;
      const content = store.localContent(localItemId, request.maxChars);
      if (!content) return undefined;
      // An item with no chunks has two very different explanations and the
      // Analyst acts differently on each: "extraction is pending" invites a
      // retry and reads as a stalled lane, while "the owner indexes this
      // item's metadata only" is a settled, correct end state. Asking the gate
      // is what tells them apart; without it every metadata-only item in the
      // owner's 64k would report a stall forever.
      const metadataOnlyRuleId = content.storedChunks === 0
        ? store.metadataOnlyRuleForLocator(content.locatorUri)
        : undefined;
      const coverageGaps = connectorStoreCoverageGaps(content, metadataOnlyRuleId);
      return {
        sensitivity: buildSourceSensitivity({ trustTier: content.trustTier, trustDomain: store.trustDomain }),
        chunks: content.chunks,
        ...(content.truncated ? { truncated: true } : {}),
        ...(coverageGaps.length > 0 ? { coverageGaps } : {}),
        ...(content.locatorUri ? { locatorUri: content.locatorUri } : {}),
      };
    },
  };
}

/**
 * Honest coverage statements for one stored item, derived only from what the
 * spine actually persists: how many chunk rows the item has and the media type
 * recorded on it. No connector, no source family and no schema column beyond v9
 * is consulted, so every store gets the same honesty for free.
 *
 * The distinction that matters: an item with zero chunk rows was ingested and
 * yielded no text. Silence there reads to the Analyst as "nothing relevant was
 * found", when the truth is "the file is in the index and its contents were
 * never extracted". Naming the media type is what turns that into an
 * actionable statement rather than a shrug.
 */
export function connectorStoreCoverageGaps(
  content: Pick<ConnectorStoreLocalContent, 'storedChunks' | 'truncated' | 'mimeType'>,
  /**
   * The owner's rule id, when their configuration is why this item has no
   * text. Supplied by the caller because only the caller holds the gate; the
   * media-type sentences below are all this function can derive on its own.
   */
  metadataOnlyRuleId?: string,
): readonly string[] {
  const gaps: string[] = [];
  if (content.storedChunks === 0) {
    gaps.push(metadataOnlyRuleId === undefined
      ? storedWithoutTextGap(content.mimeType)
      : `the owner's configuration (rule ${metadataOnlyRuleId}) indexes this item's metadata only; `
        + 'its contents are never read.');
  }
  if (content.truncated) gaps.push('stored text was truncated to fit the evidence budget.');
  return gaps;
}

// Media-type families, not source families: every one of these is an IANA type
// or prefix that any connector can emit, so this stays source-agnostic.
function storedWithoutTextGap(mimeType: string): string {
  const mime = mimeType.trim().toLowerCase();
  if (mime === 'inode/directory') {
    return 'the item is a container entry and carries no text of its own.';
  }
  if (mime === 'application/pdf') {
    return 'the PDF is stored without extracted text; it may be scanned or image-only, or extraction is still pending.';
  }
  if (mime.startsWith('image/')) {
    return 'the image is stored without extracted text and needs optical or vision extraction.';
  }
  if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    return 'the recording is stored without a transcript.';
  }
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) {
    return 'the table-like document is stored without extracted text; table extraction is incomplete or pending.';
  }
  return 'the item is stored without extracted text yet.';
}

// --- Helpers -------------------------------------------------------------------

function assertConnectorStoreStorageProfile(profile: SourceIndexStorageProfile): void {
  if (profile.trustDomain !== 'secure_local') return;
  if (
    profile.placement !== 'local_private'
    || profile.storageEngine !== 'sqlite'
    || profile.lexicalBackend !== 'sqlite_fts5'
  ) {
    throw new Error('Connector store secure_local profile must be local_private/sqlite/fts5.');
  }
}

interface NormalizedConnectorStoreClassification {
  baselineTrustTier: SourceTrustTier;
  baselineTrustDomain: SourceTrustDomain;
  sensitivityMap?: SensitivityMap;
}

function normalizeClassificationOptions(
  options: ConnectorStoreClassificationOptions | undefined,
): NormalizedConnectorStoreClassification | undefined {
  if (!options) return undefined;
  return {
    baselineTrustTier: options.baselineTrustTier ?? 'S3',
    baselineTrustDomain: options.baselineTrustDomain ?? 'internal',
    ...(options.sensitivityMap ? { sensitivityMap: options.sensitivityMap } : {}),
  };
}

function classifyConnectorStoreItem(
  connector: SourceConnector,
  item: RawItem,
  classification: NormalizedConnectorStoreClassification | undefined,
): SourceSensitivity {
  if (!classification) return connector.classify(item);

  // The SHARED per-item engine, not just the sensitivity map.
  //
  // This policy used to run the map alone and then fall straight to its
  // baseline. Every connector-store lane configures an `internal` baseline, so
  // the engine's conservative detectors — credentials, financial, health,
  // identity — never ran on a store lane at all: a bank statement classified
  // as ordinary internal mail and became cloud-embedding eligible, and a
  // message carrying key material was stored instead of being tombstoned by
  // the S5 rule in the sync loop. The connectors still ship a detector-backed
  // classify() for exactly this decision; supplying a policy silently replaced
  // it with the weaker half.
  //
  // The engine consults the map itself, and in its own order: a credential
  // finding outranks a map category (fail closed), which is the one behaviour
  // this changes for a map that was already configured.
  const classified = classifyItemTier(classificationInputFromRawItem(item), {
    ...(classification.sensitivityMap ? { sensitivityMap: classification.sensitivityMap } : {}),
  });
  if (classified.decidedBy === 'sensitivity_map') {
    return buildSourceSensitivity({
      trustTier: classified.tier,
      trustDomain: classified.trustDomain,
    });
  }
  // Raise-only above the lane's baseline. The engine's own floor is
  // secure_local for everything it cannot positively call clean, and adopting
  // that floor here would move the entire pending majority of every lane into
  // the secure band — a different decision, and not this one's to make. The
  // baseline stays the resting place; only a POSITIVE sensitive verdict moves
  // an item off it.
  if (
    classified.decidedBy === 'sensitive_detector'
    && trustTierRank(classified.tier) > trustTierRank(classification.baselineTrustTier)
  ) {
    return buildSourceSensitivity({
      trustTier: classified.tier,
      trustDomain: classified.trustDomain,
    });
  }

  return buildSourceSensitivity({
    trustTier: classification.baselineTrustTier,
    trustDomain: classification.baselineTrustDomain,
    cloudEmbeddingEligible: classification.baselineTrustDomain === 'internal',
  });
}

/** Ordinal position in the declared tier ladder; `S4+` sorts above `S4`. */
function trustTierRank(tier: SourceTrustTier): number {
  return SOURCE_TRUST_TIERS.indexOf(tier);
}

function classificationInputFromRawItem(item: RawItem): ClassifyItemTierInput {
  const subject = metadataString(item.metadata, 'subject');
  const sender = metadataString(item.metadata, 'sender') ?? metadataString(item.metadata, 'from');
  const text = textFromRawItem(item);
  const title = itemTitle(item) ?? subject;
  // Labels are a first-class classification signal for mail-shaped families
  // and invisible to path/keyword matching, so they travel with the input
  // rather than being folded into the text haystack.
  const labels = metadataStringArray(item.metadata, 'labels');
  // The item's own name is part of its path, so it belongs in the haystack the
  // sensitivity map's path patterns are tested against — JOINED, not chosen
  // between. Picking the first available signal meant a source that publishes a
  // locator URL but no folder path (any provider whose paths are built from
  // opaque folder ids) had its filename invisible to path matching, so a file
  // called `password-manager-export.csv` classified as ordinary. Matching is
  // substring containment and this classifier only ever RAISES a tier, so a
  // longer haystack can tighten a decision and can never loosen one.
  const path = [
    metadataString(item.metadata, 'pathDisplay')
      ?? metadataString(item.metadata, 'locatorUri')
      ?? metadataString(item.metadata, 'url'),
    title,
  ].filter((part): part is string => Boolean(part)).join('\n');
  return {
    ...(subject ? { subject } : {}),
    ...(title ? { title } : {}),
    ...(sender ? { sender } : {}),
    ...(path ? { path } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    // Required by the engine. A metadata-only item genuinely has no body, and
    // an empty haystack must classify from its metadata rather than throw.
    text: text ?? '',
  };
}

function metadataStringArray(metadata: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean);
}

function itemTitle(item: RawItem): string | undefined {
  return metadataString(item.metadata, 'name')
    ?? metadataString(item.metadata, 'title')
    ?? (item.identity.family === 'chat' ? metadataString(item.metadata, 'chat') : undefined);
}

// The item's private search context: citation-safe metadata that seasons FTS
// and the embedding input without becoming chunk text. The reaction line rides
// here rather than in a chunk, so reacting to an old message refreshes the
// item's representation while its stored message chunks stay untouched.
function itemSearchText(
  item: RawItem,
  title: string | undefined,
  reactionLine?: string,
): string | undefined {
  const explicit = metadataString(item.metadata, 'searchText');
  // Empty or whitespace-only connector metadata is absence, so the canonical
  // title/alias fallback remains part of search and embedding input. The old
  // exact-empty exception existed only to reproduce an external legacy-vector
  // recipe during Slice 2 convergence; retaining it would let a connector
  // silently strip useful search context from normal product writes.
  const parts = explicit
    ? [explicit, reactionLine]
    : [
      title,
      ...(item.identity.family === 'chat'
        ? [
          metadataString(item.metadata, 'chat'),
          metadataString(item.metadata, 'sender'),
          metadataString(item.metadata, 'from'),
        ]
        : []),
      // Email carries its retrieval signal in the envelope, not only the
      // subject. The legacy email index embedded Subject/From/To/Date; without
      // this branch the shared recipe silently dropped the sender and
      // recipients, so "mail from <person>" queries would have degraded below
      // the legacy baseline the flip is measured against. Caught 2026-07-29,
      // minutes before the first full Gmail embed run baked the omission into
      // 100k chunk hashes.
      ...(item.identity.family === 'email'
        ? [
          metadataString(item.metadata, 'from'),
          metadataString(item.metadata, 'to'),
        ]
        : []),
      ...metadataStringList(item.metadata, 'identityAliases'),
      ...metadataStringList(item.metadata, 'aliases'),
      reactionLine,
    ];
  const seen = new Set<string>();
  const unique = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return unique.length > 0 ? unique.join('\n') : undefined;
}

function mergeSearchTextLines(
  stored: string | null | undefined,
  emitted: string | undefined,
  literalEscapes: readonly StoredSearchTextLiteralEscape[],
  preserveOwnedFacets: boolean,
): string | undefined {
  const seen = new Set<string>();
  const rawStoredLines = (stored?.split('\n') ?? []).map((value) => value.trim());
  const storedLines = rawStoredLines.map((line) => {
    const escape = literalEscapes.find((candidate) => line.startsWith(candidate.reservedPrefix));
    return escape && !preserveOwnedFacets
      ? `${escape.literalEscapePrefix}${line}`
      : line;
  });
  const unique = [...storedLines, ...(emitted?.split('\n') ?? [])]
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return unique.length > 0 ? unique.join('\n') : undefined;
}

function normalizeMaintenanceJournalId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9:_-]{15,199}$/.test(normalized)) {
    throw new TypeError('Connector store maintenance journal id is invalid.');
  }
  return normalized;
}

function normalizeMaintenanceJournalLeaseGeneration(
  journalId: string | undefined,
  value: number | undefined,
): number | undefined {
  if (!journalId) {
    if (value !== undefined) {
      throw new TypeError('Connector store journal lease generation requires a journal id.');
    }
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError('Connector store maintenance journal lease generation is invalid.');
  }
  return value;
}

function parseFacetRefreshJournal(
  value: string | null,
): {
  leaseGeneration: number;
  counts: ConnectorStoreOwnedSearchFacetRefreshSummary['counts'];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '');
  } catch {
    throw new Error('Connector store facet-refresh journal is corrupt.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Connector store facet-refresh journal is corrupt.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.kind !== 'connector_store_owned_search_facet_refresh_v2'
    || !Number.isSafeInteger(record.leaseGeneration)
    || (record.leaseGeneration as number) < 1
    || !record.counts
    || typeof record.counts !== 'object'
    || Array.isArray(record.counts)) {
    throw new Error('Connector store facet-refresh journal is corrupt.');
  }
  const counts = record.counts as Record<string, unknown>;
  const read = (key: string): number => {
    const count = counts[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error('Connector store facet-refresh journal is corrupt.');
    }
    return count as number;
  };
  return {
    leaseGeneration: record.leaseGeneration as number,
    counts: {
      itemsScanned: read('itemsScanned'),
      itemsRefreshed: read('itemsRefreshed'),
      itemsUnchanged: read('itemsUnchanged'),
      itemsMissing: read('itemsMissing'),
      ftsRowsRefreshed: read('ftsRowsRefreshed'),
      chunkEmbeddingInputsInvalidated: read('chunkEmbeddingInputsInvalidated'),
    },
  };
}

function embeddingMaintenanceJournal(
  provider: SourceEmbeddingProvider,
  selectionSha256: string,
  inputSha256: string,
  chunksSeen: number,
  chunksEmbedded: number,
  leaseGeneration: number,
  providerEpoch: number,
  invalidateCurrentModelEmbeddings: boolean,
): string {
  return JSON.stringify({
    kind: 'connector_store_embedding_maintenance_v2',
    modelId: provider.modelId,
    embeddingProvider: provider.provider,
    embeddingBackend: provider.backend,
    embeddingDimension: provider.dimension,
    embeddingEpoch: provider.epochId,
    embeddingConfigHash: provider.configHash,
    leaseGeneration,
    providerEpoch,
    invalidateCurrentModelEmbeddings,
    selectionSha256,
    inputSha256,
    chunksSeen,
    chunksEmbedded,
  });
}

function parseEmbeddingMaintenanceJournal(value: string | null): {
  modelId: string;
  embeddingProvider: string;
  embeddingBackend: SourceEmbeddingBackend;
  embeddingDimension: number;
  embeddingEpoch: string;
  embeddingConfigHash: string;
  leaseGeneration: number;
  providerEpoch: number | undefined;
  invalidateCurrentModelEmbeddings: boolean;
  selectionSha256: string;
  inputSha256: string;
  chunksSeen: number;
  chunksEmbedded: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '');
  } catch {
    throw new Error('Connector store embedding journal is corrupt.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Connector store embedding journal is corrupt.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.kind !== 'connector_store_embedding_maintenance_v2'
    || typeof record.modelId !== 'string'
    || !record.modelId
    || typeof record.embeddingProvider !== 'string'
    || !record.embeddingProvider
    || (record.embeddingBackend !== 'local' && record.embeddingBackend !== 'cloud')
    || !Number.isSafeInteger(record.embeddingDimension)
    || (record.embeddingDimension as number) < 1
    || typeof record.embeddingEpoch !== 'string'
    || !record.embeddingEpoch
    || typeof record.embeddingConfigHash !== 'string'
    || !record.embeddingConfigHash
    || !Number.isSafeInteger(record.leaseGeneration)
    || (record.leaseGeneration as number) < 1
    || (record.providerEpoch !== undefined
      && (!Number.isSafeInteger(record.providerEpoch)
        || (record.providerEpoch as number) < 1))
    || (record.invalidateCurrentModelEmbeddings !== undefined
      && typeof record.invalidateCurrentModelEmbeddings !== 'boolean')
    || typeof record.selectionSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.selectionSha256)
    || typeof record.inputSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.inputSha256)
    || !Number.isSafeInteger(record.chunksSeen)
    || (record.chunksSeen as number) < 0
    || !Number.isSafeInteger(record.chunksEmbedded)
    || (record.chunksEmbedded as number) < 0
    || (record.chunksEmbedded as number) > (record.chunksSeen as number)) {
    throw new Error('Connector store embedding journal is corrupt.');
  }
  return {
    modelId: record.modelId,
    embeddingProvider: record.embeddingProvider,
    embeddingBackend: record.embeddingBackend,
    embeddingDimension: record.embeddingDimension as number,
    embeddingEpoch: record.embeddingEpoch,
    embeddingConfigHash: record.embeddingConfigHash,
    leaseGeneration: record.leaseGeneration as number,
    providerEpoch: record.providerEpoch as number | undefined,
    invalidateCurrentModelEmbeddings:
      record.invalidateCurrentModelEmbeddings === true,
    selectionSha256: record.selectionSha256,
    inputSha256: record.inputSha256,
    chunksSeen: record.chunksSeen as number,
    chunksEmbedded: record.chunksEmbedded as number,
  };
}

type ConnectorStoreEmbeddingAuthorityIdentity = Pick<
  SourceEmbeddingProvider,
  'modelId' | 'provider' | 'backend' | 'dimension' | 'epochId' | 'configHash'
>;

type ConnectorStoreEmbeddingWriteAuthorityRecord = {
  kind: 'v1' | 'v2';
  modelId: string;
  embeddingProvider: string;
  embeddingBackend: SourceEmbeddingBackend;
  embeddingDimension: number;
  embeddingEpoch: string;
  embeddingConfigHash: string;
  providerEpoch: number;
  /**
   * Set when a rebind cleared this model's currency across the whole corpus.
   * The invalidation is corpus-wide but the repair is whatever the triggering
   * call re-embeds, so the flag records the outstanding debt and stands until
   * an un-selected, un-limited pass under the same epoch has paid it.
   */
  currencyRebuildPending: boolean;
};

function connectorStoreEmbeddingWriteAuthorityId(modelId: string): string {
  return `connector-store-embedding-write-authority:${hashString(modelId)}`;
}

function connectorStoreEmbeddingWriteAuthority(
  provider: ConnectorStoreEmbeddingAuthorityIdentity,
  providerEpoch: number,
  currencyRebuildPending = false,
): string {
  assertConnectorStoreEmbeddingAuthorityProviderDimension(provider);
  return JSON.stringify({
    kind: 'connector_store_embedding_write_authority_v2',
    modelId: provider.modelId,
    embeddingProvider: provider.provider,
    embeddingBackend: provider.backend,
    embeddingDimension: provider.dimension,
    embeddingEpoch: provider.epochId,
    embeddingConfigHash: provider.configHash,
    providerEpoch,
    // Written only when set, so an authority row that never carried currency
    // debt serializes byte-identically to the pre-flag format.
    ...(currencyRebuildPending ? { currencyRebuildPending: true } : {}),
  });
}

function assertConnectorStoreEmbeddingAuthorityProviderDimension(
  provider: ConnectorStoreEmbeddingAuthorityIdentity,
): void {
  if (Number.isSafeInteger(provider.dimension) && provider.dimension >= 1) return;
  throw new OperationError(
    'source_index_error',
    `Connector store embedding provider ${provider.provider} model ${provider.modelId} `
    + `reported invalid authority dimension ${String(provider.dimension)}.`,
    'Configure a positive safe-integer embedding output dimension before minting or rebinding authority.',
  );
}

function recoverConnectorStoreEmbeddingWriteAuthorityEpoch(
  value: string | null,
  modelId: string,
): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '');
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.modelId !== modelId) return undefined;
  if (record.kind === 'connector_store_embedding_write_authority_v1') return 1;
  if (record.kind !== 'connector_store_embedding_write_authority_v2'
    || !Number.isSafeInteger(record.providerEpoch)
    || (record.providerEpoch as number) < 1) {
    return undefined;
  }
  return record.providerEpoch as number;
}

function parseConnectorStoreEmbeddingWriteAuthority(
  value: string | null,
): ConnectorStoreEmbeddingWriteAuthorityRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '');
  } catch {
    throw new Error('Connector store embedding write authority is corrupt.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Connector store embedding write authority is corrupt.');
  }
  const record = parsed as Record<string, unknown>;
  const isV1 = record.kind === 'connector_store_embedding_write_authority_v1';
  const isV2 = record.kind === 'connector_store_embedding_write_authority_v2';
  if ((!isV1 && !isV2)
    || typeof record.modelId !== 'string'
    || !record.modelId
    || typeof record.embeddingProvider !== 'string'
    || !record.embeddingProvider
    || (record.embeddingBackend !== 'local' && record.embeddingBackend !== 'cloud')
    || !Number.isSafeInteger(record.embeddingDimension)
    || (record.embeddingDimension as number) < 1
    || typeof record.embeddingEpoch !== 'string'
    || !record.embeddingEpoch
    || typeof record.embeddingConfigHash !== 'string'
    || !record.embeddingConfigHash
    || (isV1 && (!Number.isSafeInteger(record.leaseGeneration)
      || (record.leaseGeneration as number) < 1))
    || (isV2 && (!Number.isSafeInteger(record.providerEpoch)
      || (record.providerEpoch as number) < 1))
    || (record.currencyRebuildPending !== undefined
      && typeof record.currencyRebuildPending !== 'boolean')) {
    throw new Error('Connector store embedding write authority is corrupt.');
  }
  return {
    kind: isV1 ? 'v1' : 'v2',
    modelId: record.modelId,
    embeddingProvider: record.embeddingProvider,
    embeddingBackend: record.embeddingBackend,
    embeddingDimension: record.embeddingDimension as number,
    embeddingEpoch: record.embeddingEpoch,
    embeddingConfigHash: record.embeddingConfigHash,
    providerEpoch: isV1 ? 1 : record.providerEpoch as number,
    currencyRebuildPending: record.currencyRebuildPending === true,
  };
}

/**
 * Authority identity is exactly the set of facts that determine vector
 * VALUES: provider kind, model, backend, dimension, epoch. configHash is
 * deliberately absent — providers fold transport location (baseUrl) into it,
 * so matching on it turns a pure endpoint retarget into a full-corpus rebind
 * that deletes every stored vector for the model (the private host, 2026-08-20: a
 * loopback port move wiped five secure-local stores' vectors). The hash is
 * still recorded in the row as provenance of the config that minted the
 * epoch; it just carries no invalidation authority.
 */
function connectorStoreEmbeddingWriteAuthorityMatches(
  authority: ConnectorStoreEmbeddingWriteAuthorityRecord,
  provider: ConnectorStoreEmbeddingAuthorityIdentity,
): boolean {
  return authority.modelId === provider.modelId
    && authority.embeddingProvider === provider.provider
    && authority.embeddingBackend === provider.backend
    && authority.embeddingDimension === provider.dimension
    && authority.embeddingEpoch === provider.epochId;
}

function connectorStoreEmbeddingSelectionSha256(
  localItemIds: readonly string[] | undefined,
): string {
  const normalized = normalizeEmbedLocalItemIds(localItemIds);
  return hashString(JSON.stringify(normalized ? [...normalized].sort() : null));
}

function connectorStoreEmbeddingInputSha256(
  rows: readonly { chunk_pk: number; content_hash: string }[],
): string {
  const digest = createHash('sha256');
  for (const row of rows) digest.update(`${row.chunk_pk}\0${row.content_hash}\n`);
  return digest.digest('hex');
}

function connectorStoreEmbedSummary(
  corpusId: string,
  trustDomain: SourceTrustDomain,
  provider: SourceEmbeddingProvider,
  chunksSeen: number,
  chunksEmbedded: number,
  chunksSkipped: number,
): ConnectorStoreEmbedSummary {
  return {
    corpusId,
    modelId: provider.modelId,
    embeddingProvider: provider.provider,
    embeddingBackend: provider.backend,
    embeddingDimension: provider.dimension,
    embeddingEpoch: provider.epochId,
    chunksSeen,
    chunksEmbedded,
    chunksSkipped,
    policy: {
      rawSourceExposed: false,
      sourceTextReturned: false,
      trustDomain,
      storage: 'local_sqlite',
    },
  };
}

interface StoredSearchTextLiteralEscape {
  reservedPrefix: string;
  literalEscapePrefix: string;
  encodedValue?: 'base64url-utf8';
  decodedValueLineRequired?: boolean;
}

function storedSearchTextLiteralEscapes(
  metadata: Readonly<Record<string, unknown>>,
): StoredSearchTextLiteralEscape[] {
  const value = metadata['searchTextLiteralEscapes'];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new TypeError('Connector store search-text literal escapes must be a bounded array.');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Connector store search-text literal escape must be an object.');
    }
    const record = entry as Record<string, unknown>;
    const reservedPrefix = normalizeFacetNamespacePrefix(record.reservedPrefix as string);
    if (record.encodedValue !== undefined && record.encodedValue !== 'base64url-utf8') {
      throw new TypeError('Connector store search-text literal escape encoding is unsupported.');
    }
    if (record.decodedValueLineRequired !== undefined
      && record.decodedValueLineRequired !== true) {
      throw new TypeError('Connector store search-text literal escape decoded-line rule is invalid.');
    }
    return {
      reservedPrefix,
      literalEscapePrefix: normalizeFacetLiteralEscapePrefix(
        record.literalEscapePrefix as string,
        reservedPrefix,
      ),
      ...(record.encodedValue === 'base64url-utf8'
        ? { encodedValue: 'base64url-utf8' as const }
        : {}),
      ...(record.decodedValueLineRequired === true
        ? { decodedValueLineRequired: true }
        : {}),
    };
  });
}

function connectorStoreFtsText(searchText: string, boundedText: string): string {
  return [searchText.trim(), boundedText].filter((part) => part.trim() !== '').join('\n');
}

function combineSearchText(parts: readonly (string | null | undefined)[]): string | null {
  const seen = new Set<string>();
  const values = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .filter((part) => {
      const normalized = part.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  return values.length > 0 ? values.join('\n') : null;
}

function textFromRawItem(item: RawItem): string | undefined {
  if (item.content.kind === 'text') return item.content.text;
  if (item.content.kind === 'bytes') return decodeTextBytes(item.content.bytes, item.content.mimeType);
  return undefined;
}

function decodeTextBytes(bytes: Uint8Array, mimeType: string): string | undefined {
  if (isTextualMimeType(mimeType)) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}

function isTextualMimeType(mimeType: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized.startsWith('text/')
    || normalized === 'application/json'
    || normalized === 'application/xml'
    || normalized.endsWith('+json')
    || normalized.endsWith('+xml');
}

// Exported alongside hashString and DEFAULT_MAX_CHUNK_CHARS: together they are
// the store's chunking recipe, and any caller that must predict what this
// module stores has to run the same code rather than a copy of it. Note the
// trim: chunks come from the trimmed text while a text item's content_hash is
// taken over the untrimmed string, so a caller must feed one identical string
// to the item content, the content hash and this function.
export function chunkText(text: string, maxChunkChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < trimmed.length; offset += maxChunkChars) {
    chunks.push(trimmed.slice(offset, offset + maxChunkChars));
  }
  return chunks;
}

/**
 * The tightest honest span a keyword match can claim inside one chunk: the
 * first place a query term literally occurs.
 *
 * Deliberately narrow. FTS5 matches through a porter stemmer, so a chunk can
 * legitimately match a query whose literal terms appear nowhere in it
 * ("running" matching "run", a title-only hit). Rather than guess, that case
 * falls back to the whole chunk — a true statement ("the support is somewhere
 * in this chunk") instead of a precise false one.
 */
function firstTermSpan(
  text: string,
  terms: readonly string[],
): { charStart: number; charEnd: number } {
  const haystack = text.toLowerCase();
  let bestStart = -1;
  let bestEnd = -1;
  for (const term of terms) {
    const index = haystack.indexOf(term);
    if (index === -1) continue;
    if (bestStart === -1 || index < bestStart) {
      bestStart = index;
      bestEnd = index + term.length;
    }
  }
  if (bestStart === -1) return { charStart: 0, charEnd: text.length };
  return { charStart: bestStart, charEnd: bestEnd };
}

/**
 * Literal lowercase terms from the query, for span narrowing only.
 *
 * Never used to select or rank anything — the FTS lane already decided which
 * chunks match. This just asks "where in the winning chunk does the user's
 * wording actually appear", so it can afford to be a plain split rather than
 * the tokenizer's own analysis.
 */
function queryTermsForSpan(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= 2) seen.add(raw);
  }
  return [...seen];
}

function budgetChunks(
  chunks: readonly string[],
  maxChars: number | undefined,
): { chunks: readonly string[]; truncated: boolean } {
  if (maxChars === undefined || maxChars <= 0) return { chunks: [...chunks], truncated: false };
  const bounded: string[] = [];
  let remaining = maxChars;
  for (const chunk of chunks) {
    if (remaining <= 0) return { chunks: bounded, truncated: true };
    if (chunk.length <= remaining) {
      bounded.push(chunk);
      remaining -= chunk.length;
      continue;
    }
    bounded.push(chunk.slice(0, remaining));
    return { chunks: bounded, truncated: true };
  }
  return { chunks: bounded, truncated: false };
}

// The trust rule, mechanically: secure_local chunks are ONLY embeddable by
// the LOCAL provider (cloudEmbeddingEligible is false for secure_local) — the
// same assertion the Dropbox and email embedding lanes make.
function assertConnectorStoreEmbeddingProvider(
  trustDomain: SourceTrustDomain,
  provider: SourceEmbeddingProvider,
): void {
  assertConnectorStoreEmbeddingBackend(trustDomain, provider.backend);
  // A provider that has not been told its width cannot take part in an
  // authority-fenced lane at all: the fence compares the stored dimension
  // against this one BEFORE the first embed, so a provider that discovers its
  // width from a response it has not made yet fails that comparison on the
  // read side and would bind a zero-width authority on the write side. Both
  // are self-perpetuating, and neither says anything on the way past — so the
  // boundary refuses it by name instead.
  if (!Number.isSafeInteger(provider.dimension) || provider.dimension < 1) {
    throw new Error(
      'Connector store embedding provider must declare its dimension before use '
      + '(a provider that discovers its width from its first response cannot be fenced).',
    );
  }
}

// Backend half of the trust rule used by the normal computed-vector lane.
function assertConnectorStoreEmbeddingBackend(
  trustDomain: SourceTrustDomain,
  backend: SourceEmbeddingBackend,
): void {
  if (trustDomain === 'secure_local' && backend !== 'local') {
    throw new Error(
      'Connector store secure_local embeddings must use a local/private embedding provider '
      + '(secure_local chunks are never cloud-embedding eligible).',
    );
  }
}


/**
 * One tiny round trip proving the provider is alive and answers with the
 * declared width, run before a currency-destroying rebind commits.
 */
async function assertEmbeddingProviderCanEmbed(
  provider: SourceEmbeddingProvider,
): Promise<void> {
  assertConnectorStoreEmbeddingAuthorityProviderDimension(provider);
  const vectors = await provider.embed(
    [{ text: 'olympus connector store embedding rebind probe' }],
    { taskType: 'RETRIEVAL_DOCUMENT' },
  );
  const vector = vectors.length === 1 ? vectors[0] : undefined;
  if (!vector || !usableEmbeddingVector(vector, provider.dimension)) {
    throw new OperationError(
      'source_index_error',
      `Connector store embedding rebind for model ${provider.modelId} refused: `
      + `the probe returned ${vector ? `a ${vector.length}-wide vector` : `${vectors.length} vectors`} `
      + `where one ${provider.dimension}-dimension vector was required.`,
      'Fix the embedding endpoint before rebinding; the stored vectors were left untouched.',
    );
  }
}

function usableEmbeddingVector(vector: readonly number[], dimension: number): boolean {
  return vector.length === dimension
    && vector.every((value) => typeof value === 'number' && Number.isFinite(value));
}

interface ConnectorStoreEmbeddingSeasoning {
  title: string | null;
  search_text: string | null;
  mime_type: string | null;
  authored_at: string | null;
  updated_at: string | null;
}

// Embedding text mirrors the Dropbox lane: citation-safe metadata header plus
// the bounded chunk text.
function buildConnectorStoreEmbeddingText(row: {
  title: string | null;
  search_text?: string | null;
  mime_type: string | null;
  authored_at: string | null;
  updated_at: string | null;
  bounded_text: string;
}): string {
  return [
    row.title ? `Title: ${row.title}` : undefined,
    row.search_text ? `Context: ${row.search_text}` : undefined,
    row.mime_type ? `MIME type: ${row.mime_type}` : undefined,
    row.updated_at ?? row.authored_at ? `Modified: ${row.updated_at ?? row.authored_at}` : undefined,
    row.bounded_text,
  ].filter((part): part is string => Boolean(part)).join('\n');
}

function sameSourceItemIdentity(
  left: SourceItemIdentity,
  right: SourceItemIdentity,
): boolean {
  return sourceItemIdentityKey(left) === sourceItemIdentityKey(right);
}

function sourceItemIdentityKey(identity: SourceItemIdentity): string {
  return JSON.stringify([
    identity.family,
    identity.provider,
    identity.accountScope,
    normalizeConversationId(identity.providerConversationId),
    identity.providerItemId,
  ]);
}

function normalizeEmbedLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Connector store embed limit must be a positive integer when provided.');
  }
  return value;
}

function normalizeIntegritySampleLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new Error('Connector store integrity sample limit must be an integer from 0 to 100.');
  }
  return value;
}

function normalizeEmbedLocalItemIds(value: readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const selected = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (selected.length > MAX_SELECTED_EMBED_ITEM_IDS) {
    throw new Error('Connector store selected-item embed is limited to 25,000 local item ids per call.');
  }
  return selected;
}

function normalizeFullSnapshotScopes(
  value: ConnectorStoreSyncOptions['reconcileFullSnapshotScope'],
): ConnectorStoreFullSnapshotScope[] {
  if (value === undefined) return [];
  const scopes = Array.isArray(value) ? value : [value];
  return scopes.map((scope) => {
    const provider = scope.provider.trim();
    const accountScope = scope.accountScope.trim();
    if (!provider || !accountScope) {
      throw new Error('Full-snapshot reconciliation scope must include non-empty provider and accountScope.');
    }
    return { provider, accountScope };
  });
}

function assertCurrentMembershipAuthority(input: {
  reconcileFullSnapshot: boolean;
  absenceAuthority: ConnectorStoreAbsenceAuthority;
  currentMembershipAuthority: ConnectorStoreCurrentMembershipAuthority;
  scopes: readonly ConnectorStoreFullSnapshotScope[];
  snapshotObservedAt: string | undefined;
  snapshotCompletedAt: string | undefined;
  windowBoundarySha256: string | undefined;
  windowRemovedLocalItemIds: readonly string[];
}): void {
  if (input.currentMembershipAuthority !== 'provider_window_snapshot'
    && input.windowRemovedLocalItemIds.length > 0) {
    throw new Error('Explicit window removals require provider-window current-membership authority.');
  }
  if (input.currentMembershipAuthority === 'connector_owned') return;
  if (!input.reconcileFullSnapshot
    || input.absenceAuthority !== 'complete_snapshot'
    || input.scopes.length === 0
    || !input.snapshotObservedAt
    || !input.snapshotCompletedAt
    || (
      input.currentMembershipAuthority === 'provider_window_snapshot'
      && !input.windowBoundarySha256
    )
    || Date.parse(input.snapshotObservedAt) > Date.parse(input.snapshotCompletedAt)) {
    throw new Error(
      'Provider/account current-membership reconciliation requires an explicit complete snapshot scope.',
    );
  }
}

function normalizeWindowRemovedLocalItemIds(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  const normalized = [...new Set(value.map((item) => item.trim()))].filter(Boolean);
  if (normalized.length > 25_000 || normalized.some((item) => item.length > 4_096)) {
    throw new Error('Connector window removals exceed their bounded local-item identity set.');
  }
  return normalized;
}

function normalizeOptionalSnapshotTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error('Provider/account snapshot observation cutoff must be a valid timestamp.');
  }
  return new Date(timestamp).toISOString();
}

function normalizeOptionalAccountScope(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const accountScope = value.trim();
  if (!accountScope) throw new Error('Connector store account scope must be non-empty when provided.');
  return accountScope;
}

interface NormalizedConnectorStoreSearchFilters {
  provider?: string;
  locatorPathScope?: string;
  conversationId?: string;
  senderId?: string;
  senderLabel?: string;
  authoredAfter?: string;
  authoredBefore?: string;
  searchTextExactLines?: readonly string[];
}

export function normalizeConnectorStoreSearchFilters(
  value: ConnectorStoreSearchFilters | undefined,
): NormalizedConnectorStoreSearchFilters | undefined {
  if (value === undefined) return undefined;
  const provider = normalizeBoundedFilterString(value.provider, 'provider');
  const locatorPathScope = normalizeConnectorStoreLocatorPathScope(value.locatorPathScope);
  const conversationId = normalizeBoundedFilterString(value.conversationId, 'conversation id');
  const senderId = normalizeBoundedFilterString(value.senderId, 'sender id');
  const senderLabel = normalizeBoundedFilterString(value.senderLabel, 'sender label');
  if (senderId && senderLabel) {
    throw new Error('Connector store search accepts senderId or senderLabel, not both.');
  }
  const authoredAfter = normalizeFilterTimestamp(value.authoredAfter, 'authoredAfter');
  const authoredBefore = normalizeFilterTimestamp(value.authoredBefore, 'authoredBefore');
  if (authoredAfter && authoredBefore && Date.parse(authoredAfter) > Date.parse(authoredBefore)) {
    throw new Error('Connector store authoredAfter must not be later than authoredBefore.');
  }
  const searchTextExactLines = normalizeBoundedFilterStrings(
    value.searchTextExactLines,
    'exact search-context line',
  );
  const normalized = {
    ...(provider ? { provider } : {}),
    ...(locatorPathScope ? { locatorPathScope } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderLabel ? { senderLabel } : {}),
    ...(authoredAfter ? { authoredAfter } : {}),
    ...(authoredBefore ? { authoredBefore } : {}),
    ...(searchTextExactLines.length > 0 ? { searchTextExactLines } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function connectorStoreFilterSql(filters: ConnectorStoreSearchFilters | undefined): {
  sql: string;
  params: Array<string>;
} {
  const normalized = normalizeConnectorStoreSearchFilters(filters);
  if (!normalized) return { sql: '', params: [] };
  const clauses: string[] = [];
  const params: string[] = [];
  if (normalized.provider) {
    clauses.push('AND i.provider = ?');
    params.push(normalized.provider);
  }
  if (normalized.locatorPathScope) {
    const locatorPath = normalized.locatorPathScope;
    clauses.push("AND i.locator_uri IS NOT NULL");
    if (locatorPath === '/') {
      clauses.push("AND LOWER(i.locator_uri) LIKE '/%' ESCAPE '\\'");
    } else {
      clauses.push("AND (LOWER(i.locator_uri) = LOWER(?) OR LOWER(i.locator_uri) LIKE LOWER(?) ESCAPE '\\')");
      params.push(locatorPath, `${escapeSqlLike(locatorPath)}/%`);
    }
  }
  if (normalized.conversationId) {
    clauses.push('AND i.provider_conversation_id = ?');
    params.push(normalized.conversationId);
  }
  if (normalized.senderId) {
    clauses.push('AND i.sender_id = ?');
    params.push(normalized.senderId);
  }
  if (normalized.senderLabel) {
    clauses.push("AND LOWER(i.sender_label) LIKE ? ESCAPE '\\'");
    params.push(`%${escapeSqlLike(normalized.senderLabel.toLowerCase())}%`);
  }
  if (normalized.authoredAfter) {
    clauses.push('AND julianday(i.authored_at) >= julianday(?)');
    params.push(normalized.authoredAfter);
  }
  if (normalized.authoredBefore) {
    clauses.push('AND julianday(i.authored_at) <= julianday(?)');
    params.push(normalized.authoredBefore);
  }
  for (const line of normalized.searchTextExactLines ?? []) {
    clauses.push(
      'AND INSTR(CHAR(10) || COALESCE(i.search_text, \'\') || CHAR(10), CHAR(10) || ? || CHAR(10)) > 0',
    );
    params.push(line);
  }
  return { sql: clauses.join('\n'), params };
}

function normalizeBoundedFilterStrings(
  values: readonly string[] | undefined,
  label: string,
): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 20) {
    throw new Error(`Connector store ${label} filters must be an array of at most 20 strings.`);
  }
  return [...new Set(values.map((value) => normalizeBoundedFilterString(value, label)!))];
}

function normalizeConnectorStoreLocatorPathScope(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 4_096
    || value !== value.trim()
    || !value.startsWith('/')
    || /[\u0000-\u001f\u007f\u2028\u2029]/.test(value)
  ) {
    throw new Error(
      'Connector store locator path scope must be a rooted non-empty safe string of at most 4,096 characters.',
    );
  }
  return value;
}

function normalizeBoundedFilterString(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Connector store ${label} filter must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 1_000 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Connector store ${label} filter must be a non-empty safe string of at most 1,000 characters.`);
  }
  return normalized;
}

function normalizeFacetNamespacePrefix(value: string): string {
  const normalized = normalizeBoundedFilterString(value, 'facet namespace prefix');
  if (!normalized || !normalized.endsWith(':')) {
    throw new Error('Connector store facet namespace prefix must be a non-empty safe prefix ending in a colon.');
  }
  return normalized;
}

function normalizeFacetLiteralEscapePrefix(value: string, namespacePrefix: string): string {
  const normalized = normalizeFacetNamespacePrefix(value);
  if (normalized === namespacePrefix || normalized.startsWith(namespacePrefix)) {
    throw new Error('Connector store facet literal escape prefix must be outside its owned namespace.');
  }
  return normalized;
}

function normalizeOwnedFacetLines(values: readonly string[], prefix: string): string[] {
  const lines = normalizeBoundedFilterStrings(values, 'owned facet line');
  if (lines.some((line) => !line.startsWith(prefix))) {
    throw new Error('Connector store owned facet lines must begin with their namespace prefix.');
  }
  return lines;
}

function normalizeFilterTimestamp(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)
    || !Number.isFinite(Date.parse(normalized))
  ) {
    throw new Error(`Connector store ${label} filter must be an ISO timestamp with a timezone.`);
  }
  return new Date(normalized).toISOString();
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function safeSenderDisplayLabel(value: string | null): string {
  const normalized = (value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return normalized || 'Unknown sender';
}

function rememberFullSnapshotScope(
  scopes: Map<string, ConnectorStoreFullSnapshotScope>,
  scope: ConnectorStoreFullSnapshotScope,
): void {
  scopes.set(`${scope.provider}\0${scope.accountScope}`, {
    provider: scope.provider,
    accountScope: scope.accountScope,
  });
}

function fullSnapshotScopeKey(scope: ConnectorStoreFullSnapshotScope): string {
  return `${scope.provider}\0${scope.accountScope}`;
}

function searchRowFromItemRow(row: ItemRow): ConnectorStoreSearchRow {
  return {
    sourceItem: sourceItemFromRow(row),
    ...(row.title ? { title: row.title } : {}),
    ...(row.family === 'chat' && row.title ? { conversationLabel: row.title } : {}),
    ...(row.sender_id ? { senderId: row.sender_id } : {}),
    ...(row.sender_label ? { authorLabel: row.sender_label } : {}),
    ...(row.sender_is_owner !== null ? { senderIsOwner: row.sender_is_owner === 1 } : {}),
    ...(row.authored_at ? { authoredAt: row.authored_at } : {}),
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
    syncRunId: row.sync_run_id,
    trustTier: trustTierFromRow(row.trust_tier),
    rank: row.rank,
  };
}

function sourceItemFromRow(row: ItemRow): SourceItemIdentity {
  return {
    family: row.family as SourceFamily,
    provider: row.provider,
    accountScope: row.account_scope,
    providerItemId: row.provider_item_id,
    ...(row.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {}),
    ...(row.provider_conversation_id ? { providerConversationId: row.provider_conversation_id } : {}),
    ...(row.provider_file_id ? { providerFileId: row.provider_file_id } : {}),
    ...(row.provider_event_id ? { providerEventId: row.provider_event_id } : {}),
    localItemId: row.local_item_id,
    ...(row.source_version ? { sourceVersion: row.source_version } : {}),
  };
}

function syncRunFromRow(row: SyncRunRow): ConnectorStoreSyncRun {
  return {
    syncRunId: row.sync_run_id,
    corpusId: row.corpus_id,
    connectorId: row.connector_id,
    status: row.status,
    ...(row.cursor ? { cursor: row.cursor } : {}),
    itemsSeen: row.items_seen,
    itemsIndexed: row.items_indexed,
    startedAt: row.started_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function trustTierFromRow(value: string): SourceTrustTier {
  const tier = SOURCE_TRUST_TIERS.find((candidate) => candidate === value);
  if (!tier) throw new Error(`Connector store row carries an unknown trust tier "${value}".`);
  return tier;
}

function conservativeTierForDomain(trustDomain: SourceTrustDomain): SourceTrustTier {
  if (trustDomain === 'public_safe') return 'S0';
  if (trustDomain === 'internal') return 'S3';
  return 'S4';
}

// SOURCE_TRUST_TIERS is ordered least- to most-sensitive, so index order is
// tier order. An unrecognized stored value indexes to -1 and loses, which
// falls back to the freshly classified tier.
function maxTrustTier(a: SourceTrustTier | undefined, b: SourceTrustTier): SourceTrustTier {
  if (a === undefined) return b;
  return SOURCE_TRUST_TIERS.indexOf(a) >= SOURCE_TRUST_TIERS.indexOf(b) ? a : b;
}

function rawItemHasBody(item: RawItem): boolean {
  if (item.content.kind === 'text') return item.content.text.trim().length > 0;
  if (item.content.kind === 'bytes') {
    if (item.content.bytes.byteLength === 0) return false;
    // A provider answering 200 with just a newline arrives as non-empty
    // bytes; decoded and trimmed it is the same blank input as empty text.
    // Genuine binary bodies survive the trim: replacement characters and
    // binary bytes are not whitespace.
    return new TextDecoder().decode(item.content.bytes).trim().length > 0;
  }
  return false;
}

function trustDomainMismatchGap(
  item: RawItem,
  itemDomain: SourceTrustDomain,
  storeDomain: SourceTrustDomain,
  detail = 'item skipped',
): string {
  return (
    `trust_domain_mismatch:${itemIdHash(item)}: connector classified trust domain "${itemDomain}" `
    + `but this store only accepts "${storeDomain}"; ${detail} (fail closed).`
  );
}

function secretsTierExcludedGap(item: RawItem): string {
  return `secrets_tier_excluded:${itemIdHash(item)}: item classified S5; content excluded from indexing.`;
}

function pageAbandonedGap(connectorId: string): string {
  return (
    `connector_page_abandoned: connector ${connectorId} returned a page larger than the requested limit; `
    + 'the run stopped mid-page and kept its previous checkpoint, so this pass made no forward progress.'
  );
}

function contentFetchFailedGap(item: RawItem): string {
  return `content_fetch_failed:${itemIdHash(item)}:error_kind=connector_fetch_failed: connector fetchItem failed; item indexed without content.`;
}

/**
 * A page cut short of what the provider returned is not a completed traversal.
 * Claiming both is how a partial page cleared a checkpoint that covered items
 * nobody had read.
 */
function assertPageNotTruncatedAndDone(page: SourceConnectorListPage, connectorId: string): void {
  if (page.done && (page as { truncated?: boolean }).truncated === true) {
    throw new Error(
      `connector_page_invariant: connector ${connectorId} reported a page as both truncated and done.`,
    );
  }
}

function assertContentFetchFailureBudget(consecutiveFailures: number): void {
  if (consecutiveFailures < MAX_CONSECUTIVE_CONTENT_FETCH_FAILURES) return;
  throw new Error(
    `connector_fetch_failed: ${consecutiveFailures} consecutive connector fetchItem failures; failing sync run instead of committing a content-less batch.`,
  );
}

// Gap strings reference items by a content-free hash: Castor-safe summaries
// must not leak raw names or paths.
function itemIdHash(item: RawItem): string {
  return hashString(item.identity.localItemId).slice(0, 16);
}

function metadataString(metadata: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = metadata[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function metadataStringList(metadata: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = metadata[key];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (typeof entry === 'string' && entry.trim() ? [entry.trim()] : []));
  }
  const single = metadataString(metadata, key);
  return single ? [single] : [];
}

function metadataBoolean(metadata: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = metadata[key];
  return typeof value === 'boolean' ? value : undefined;
}

function senderMetadataFromRawItem(item: RawItem): ConnectorStoreSenderMetadata {
  const senderId =
    metadataString(item.metadata, 'senderId')
    ?? metadataString(item.metadata, 'sender_id');
  const senderLabel =
    metadataString(item.metadata, 'senderLabel')
    ?? metadataString(item.metadata, 'senderDisplayName')
    ?? metadataString(item.metadata, 'sender')
    ?? metadataString(item.metadata, 'from');
  const senderIsOwner =
    metadataBoolean(item.metadata, 'senderIsOwner')
    ?? metadataBoolean(item.metadata, 'fromMe');
  return normalizeSenderMetadata({
    ...(senderId ? { senderId } : {}),
    ...(senderLabel ? { senderLabel } : {}),
    ...(senderIsOwner !== undefined ? { senderIsOwner } : {}),
  });
}

function normalizeSenderMetadata(
  value: ConnectorStoreSenderMetadata,
): ConnectorStoreSenderMetadata {
  const senderId = value.senderId?.trim();
  const senderLabel = value.senderLabel?.trim();
  if (senderId !== undefined && (!senderId || senderId.length > 1_000)) {
    throw new Error('Connector store sender id must be a non-empty string of at most 1,000 characters.');
  }
  if (senderLabel !== undefined && (!senderLabel || senderLabel.length > 1_000)) {
    throw new Error('Connector store sender label must be a non-empty string of at most 1,000 characters.');
  }
  if (value.senderIsOwner !== undefined && typeof value.senderIsOwner !== 'boolean') {
    throw new Error('Connector store sender owner flag must be boolean when provided.');
  }
  return {
    ...(senderId ? { senderId } : {}),
    ...(senderLabel ? { senderLabel } : {}),
    ...(value.senderIsOwner !== undefined ? { senderIsOwner: value.senderIsOwner } : {}),
  };
}

function normalizeConversationId(value: string | undefined): string {
  return value ?? '';
}

function createConversationScopedItemsTable(
  db: Database,
  tableName: 'items' | 'items_v5',
  ifNotExists = false,
): void {
  db.exec(`
    CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (
      item_pk INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      family TEXT NOT NULL,
      account_scope TEXT NOT NULL,
      provider_item_id TEXT NOT NULL,
      provider_thread_id TEXT,
      provider_conversation_id TEXT,
      normalized_conversation TEXT GENERATED ALWAYS AS (
        COALESCE(provider_conversation_id, '')
      ) STORED NOT NULL,
      provider_file_id TEXT,
      provider_event_id TEXT,
      local_item_id TEXT NOT NULL,
      source_version TEXT,
      title TEXT,
      search_text TEXT,
      locator_uri TEXT,
      mime_type TEXT NOT NULL,
      authored_at TEXT,
      updated_at TEXT,
      fetched_at TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      content_hash TEXT,
      trust_tier TEXT NOT NULL,
      tombstoned INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      sync_run_id TEXT NOT NULL,
      UNIQUE(provider, account_scope, normalized_conversation, provider_item_id),
      FOREIGN KEY(sync_run_id) REFERENCES sync_runs(sync_run_id)
    );
  `);
}

function migrateConversationScopedItemIdentity(db: Database): void {
  if (tableColumns(db, 'items', true).includes('normalized_conversation')) return;

  // Rebuilding the parent table is required because SQLite cannot drop the
  // old table-level UNIQUE(provider, account_scope, provider_item_id)
  // constraint. Copy the dependent rows inside the migration transaction,
  // preserve every primary key, leave the standalone FTS table untouched,
  // then restore the dependent tables against the replacement parent.
  db.exec(`
    CREATE TEMP TABLE connector_store_v5_chunks_copy AS SELECT * FROM chunks;
    CREATE TEMP TABLE connector_store_v5_embeddings_copy AS SELECT * FROM chunk_embeddings;
    CREATE TEMP TABLE connector_store_v5_owners_copy AS SELECT * FROM item_owners;
  `);
  createConversationScopedItemsTable(db, 'items_v5');
  db.exec(`
    INSERT INTO items_v5 (
      item_pk, provider, family, account_scope, provider_item_id,
      provider_thread_id, provider_conversation_id, provider_file_id,
      provider_event_id, local_item_id, source_version, title, search_text,
      locator_uri, mime_type, authored_at, updated_at, fetched_at, indexed_at,
      content_hash, trust_tier, tombstoned, deleted_at, sync_run_id
    )
    SELECT
      item_pk, provider, family, account_scope, provider_item_id,
      provider_thread_id, provider_conversation_id, provider_file_id,
      provider_event_id, local_item_id, source_version, title, search_text,
      locator_uri, mime_type, authored_at, updated_at, fetched_at, indexed_at,
      content_hash, trust_tier, tombstoned, deleted_at, sync_run_id
    FROM items;

    DROP TABLE item_owners;
    DROP TABLE chunk_embeddings;
    DROP TABLE chunks;
    DROP TABLE items;
    ALTER TABLE items_v5 RENAME TO items;
    CREATE INDEX idx_items_local_item_id ON items(local_item_id);

    CREATE TABLE chunks (
      chunk_pk INTEGER PRIMARY KEY,
      item_pk INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      bounded_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding_input_hash TEXT,
      indexed_at TEXT NOT NULL,
      UNIQUE(item_pk, chunk_index),
      FOREIGN KEY(item_pk) REFERENCES items(item_pk) ON DELETE CASCADE
    );
    INSERT INTO chunks (
      chunk_pk, item_pk, chunk_index, bounded_text, content_hash,
      embedding_input_hash, indexed_at
    )
    SELECT
      chunk_pk, item_pk, chunk_index, bounded_text, content_hash,
      embedding_input_hash, indexed_at
    FROM connector_store_v5_chunks_copy;

    CREATE TABLE chunk_embeddings (
      chunk_pk INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      item_pk INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (chunk_pk, model_id),
      FOREIGN KEY(chunk_pk) REFERENCES chunks(chunk_pk) ON DELETE CASCADE
    );
    INSERT INTO chunk_embeddings (
      chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at
    )
    SELECT chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at
    FROM connector_store_v5_embeddings_copy;
    CREATE INDEX idx_connector_store_chunk_embeddings_item
      ON chunk_embeddings(item_pk, model_id);
    CREATE INDEX IF NOT EXISTS idx_connector_store_chunk_embeddings_model
      ON chunk_embeddings(model_id);
  `);
  createItemOwnersTable(db);
  db.exec(`
    INSERT INTO item_owners (
      item_pk, connector_id, ownership_kind, first_seen_sync_run_id,
      last_seen_sync_run_id, first_seen_at, last_seen_at
    )
    SELECT
      item_pk, connector_id, ownership_kind, first_seen_sync_run_id,
      last_seen_sync_run_id, first_seen_at, last_seen_at
    FROM connector_store_v5_owners_copy;
    DROP TABLE connector_store_v5_chunks_copy;
    DROP TABLE connector_store_v5_embeddings_copy;
    DROP TABLE connector_store_v5_owners_copy;
  `);
}

const CONNECTOR_STORE_OWNED_SCHEMA_OBJECTS = [
  'sync_runs',
  'items',
  'idx_items_local_item_id',
  'chunks',
  'connector_store_fts',
  'chunk_embeddings',
  'embedding_models',
  'idx_connector_store_chunk_embeddings_item',
  'item_owners',
  'idx_connector_store_item_owners_connector',
  'item_write_claims',
  'connector_store_fts_rows',
  'idx_connector_store_fts_rows_item',
  'idx_connector_store_items_sender_id',
  'idx_connector_store_items_sender_label',
  'idx_connector_store_items_sender_owner',
  'item_locator_identities',
  'idx_connector_store_locator_identity',
  'locator_identity_index_state',
  'connector_store_locator_identity_insert',
  'connector_store_locator_identity_update',
] as const;

const CONNECTOR_STORE_REQUIRED_COLUMNS = {
  sync_runs: [
    'sync_run_id', 'corpus_id', 'connector_id', 'status', 'cursor',
    'items_seen', 'items_indexed', 'started_at', 'completed_at', 'error',
    'audit_receipt_sha256',
  ],
  chunks: [
    'chunk_pk', 'item_pk', 'chunk_index', 'bounded_text', 'content_hash',
    'embedding_input_hash', 'indexed_at',
  ],
  connector_store_fts: ['title', 'bounded_text', 'item_pk', 'chunk_pk'],
  chunk_embeddings: [
    'chunk_pk', 'model_id', 'item_pk', 'content_hash', 'embedding', 'embedded_at',
  ],
  item_owners: [
    'item_pk', 'connector_id', 'ownership_kind', 'first_seen_sync_run_id',
    'last_seen_sync_run_id', 'first_seen_at', 'last_seen_at',
  ],
} as const;

const CONNECTOR_STORE_EMBEDDING_MODEL_COLUMNS = [
  'model_id',
  'provider',
  'dimension',
  'embedding_backend',
  'embedding_epoch',
  'cloud_embedding_eligible',
  'created_at',
] as const;

const CONNECTOR_STORE_V4_ITEM_COLUMNS = [
  'item_pk', 'provider', 'family', 'account_scope', 'provider_item_id',
  'provider_thread_id', 'provider_conversation_id', 'provider_file_id',
  'provider_event_id', 'local_item_id', 'source_version', 'title', 'search_text',
  'locator_uri', 'mime_type', 'authored_at', 'updated_at', 'fetched_at',
  'indexed_at', 'content_hash', 'trust_tier', 'tombstoned', 'deleted_at',
  'sync_run_id',
] as const;

const CONNECTOR_STORE_V5_ITEM_COLUMNS = [
  ...CONNECTOR_STORE_V4_ITEM_COLUMNS.slice(0, 7),
  'normalized_conversation',
  ...CONNECTOR_STORE_V4_ITEM_COLUMNS.slice(7),
] as const;

const CONNECTOR_STORE_V7_ITEM_COLUMNS = [
  ...CONNECTOR_STORE_V5_ITEM_COLUMNS.slice(0, 14),
  'sender_id',
  'sender_label',
  'sender_is_owner',
  ...CONNECTOR_STORE_V5_ITEM_COLUMNS.slice(14),
] as const;

const CONNECTOR_STORE_V9_ITEM_COLUMNS = [
  ...CONNECTOR_STORE_V7_ITEM_COLUMNS,
  'reactions_json',
] as const;

const CONNECTOR_STORE_ITEM_WRITE_CLAIM_COLUMNS = [
  'item_pk', 'claim_scope', 'claim_authority', 'claim_ordinal', 'claim_holder',
  'claim_generation', 'accepted_at',
] as const;

function refuseUnversionedConnectorStoreSchema(db: Database): void {
  if (readSqliteSchemaVersion(db, SQLITE_STORE_ID) !== 0) return;
  const placeholders = CONNECTOR_STORE_OWNED_SCHEMA_OBJECTS.map(() => '?').join(', ');
  const rows = db.query(`
    SELECT name FROM sqlite_master WHERE name IN (${placeholders}) ORDER BY name
  `).all(...CONNECTOR_STORE_OWNED_SCHEMA_OBJECTS) as Array<{ name: string }>;
  if (rows.length > 0) {
    throw new Error(
      `Connector store database has unversioned/colliding owned schema objects: ${rows.map((row) => row.name).join(', ')}.`,
    );
  }
}

function validateCurrentConnectorStoreSchemaBeforeMigration(db: Database): void {
  const version = readSqliteSchemaVersion(db, SQLITE_STORE_ID);
  if (version === 4) validateConnectorStoreSchemaShape(db, CONNECTOR_STORE_V4_ITEM_COLUMNS, false, 'v4');
  if (version === 5) {
    validateConnectorStoreSchemaShape(db, CONNECTOR_STORE_V5_ITEM_COLUMNS, true, 'v5');
  }
  if (version === 6) validateConnectorStoreV6Schema(db);
  if (version === 7) validateConnectorStoreV7Schema(db);
  if (version === 8) validateConnectorStoreV8Schema(db);
  if (version === 9) validateConnectorStoreV9Schema(db);
  if (version === 10) validateConnectorStoreV10Schema(db);
  if (version === CONNECTOR_STORE_SQLITE_SCHEMA_VERSION) validateConnectorStoreSchema(db);
}

function validateConnectorStoreV6Schema(db: Database): void {
  validateConnectorStoreSchemaShape(db, CONNECTOR_STORE_V5_ITEM_COLUMNS, true, 'v6');
  validateConnectorStoreFtsOwnership(db, 'v6');
}

function validateConnectorStoreSchema(db: Database): void {
  validateConnectorStoreV10Schema(db);
  assertExactTableColumns(
    db,
    'item_locator_identities',
    ['item_pk', 'provider', 'account_scope', 'normalized_conversation', 'normalized_locator'],
    false,
    'v11',
  );
  assertExactTableColumns(
    db,
    'locator_identity_index_state',
    ['singleton', 'cursor_item_pk', 'completed'],
    false,
    'v11',
  );
  assertIndexColumns(
    db,
    'idx_connector_store_locator_identity',
    ['provider', 'account_scope', 'normalized_conversation', 'normalized_locator', 'item_pk'],
    'v11',
  );
  assertTriggerExists(db, 'connector_store_locator_identity_insert', 'v11');
  assertTriggerExists(db, 'connector_store_locator_identity_update', 'v11');
  const stateRows = Number((db.query(`
    SELECT COUNT(*) AS count FROM locator_identity_index_state WHERE singleton = 1
  `).get() as { count: number }).count);
  if (stateRows !== 1) throw new Error('Connector store locator identity index state is missing for v11.');
}

function validateConnectorStoreV10Schema(db: Database): void {
  validateConnectorStoreV9Schema(db, 'v10');
  assertExactTableColumns(
    db,
    'item_write_claims',
    CONNECTOR_STORE_ITEM_WRITE_CLAIM_COLUMNS,
    false,
    'v10',
  );
}

function validateConnectorStoreV9Schema(db: Database, versionLabel = 'v9'): void {
  validateConnectorStoreItemSchema(db, CONNECTOR_STORE_V9_ITEM_COLUMNS, versionLabel);
  assertExactTableColumns(
    db,
    'embedding_models',
    CONNECTOR_STORE_EMBEDDING_MODEL_COLUMNS,
    false,
    versionLabel,
  );
}

function validateConnectorStoreV8Schema(db: Database): void {
  validateConnectorStoreV7Schema(db);
  assertExactTableColumns(
    db,
    'embedding_models',
    CONNECTOR_STORE_EMBEDDING_MODEL_COLUMNS,
    false,
    'v8',
  );
}

function validateConnectorStoreV7Schema(db: Database): void {
  validateConnectorStoreItemSchema(db, CONNECTOR_STORE_V7_ITEM_COLUMNS, 'v7');
}

function validateConnectorStoreItemSchema(
  db: Database,
  itemColumns: readonly string[],
  versionLabel: string,
): void {
  validateConnectorStoreSchemaShape(db, itemColumns, true, versionLabel);
  validateConnectorStoreFtsOwnership(db, versionLabel);
  assertIndexColumns(db, 'idx_connector_store_items_sender_id', ['sender_id'], versionLabel);
  assertIndexColumns(db, 'idx_connector_store_items_sender_label', ['sender_label'], versionLabel);
  assertIndexColumns(
    db,
    'idx_connector_store_items_sender_owner',
    ['sender_is_owner', 'sender_id'],
    versionLabel,
  );
}

function validateConnectorStoreFtsOwnership(db: Database, versionLabel: string): void {
  assertExactTableColumns(
    db,
    'connector_store_fts_rows',
    ['fts_rowid', 'item_pk', 'chunk_pk'],
    false,
    versionLabel,
  );
  assertIndexColumns(db, 'idx_connector_store_fts_rows_item', ['item_pk'], versionLabel);
  const ftsRows = Number((db.query('SELECT COUNT(*) AS count FROM connector_store_fts').get() as { count: number }).count);
  const mappedRows = Number((db.query('SELECT COUNT(*) AS count FROM connector_store_fts_rows').get() as { count: number }).count);
  if (ftsRows !== mappedRows) {
    throw new Error('Connector store schema FTS row ownership map is incomplete.');
  }
  const foreignKeyErrors = db.query('PRAGMA foreign_key_check').all();
  if (foreignKeyErrors.length > 0) {
    throw new Error('Connector store schema has broken foreign-key references after migration.');
  }
}

function validateConnectorStoreSchemaShape(
  db: Database,
  itemColumns: readonly string[],
  conversationScoped: boolean,
  versionLabel: string,
): void {
  assertExactTableColumns(db, 'items', itemColumns, true, versionLabel);
  for (const [table, columns] of Object.entries(CONNECTOR_STORE_REQUIRED_COLUMNS)) {
    assertExactTableColumns(db, table, columns, false, versionLabel);
  }
  assertIndexColumns(db, 'idx_items_local_item_id', ['local_item_id'], versionLabel);
  assertIndexColumns(
    db,
    'idx_connector_store_chunk_embeddings_item',
    ['item_pk', 'model_id'],
    versionLabel,
  );
  assertIndexColumns(
    db,
    'idx_connector_store_item_owners_connector',
    ['connector_id', 'ownership_kind', 'last_seen_sync_run_id'],
    versionLabel,
  );
  const expectedIdentity = conversationScoped
    ? ['provider', 'account_scope', 'normalized_conversation', 'provider_item_id']
    : ['provider', 'account_scope', 'provider_item_id'];
  const uniqueIndexes = (db.query('PRAGMA index_list(items)').all() as Array<{ name: string; unique: number }>)
    .filter((row) => row.unique === 1)
    .map((row) => indexColumns(db, row.name));
  if (uniqueIndexes.length !== 1 || !sameStrings(uniqueIndexes[0] ?? [], expectedIdentity)) {
    throw new Error(`Connector store schema items does not have the required ${versionLabel} identity key.`);
  }
  if (conversationScoped) {
    const normalized = (db.query('PRAGMA table_xinfo(items)').all() as Array<{
      name: string;
      notnull: number;
      hidden: number;
    }>).find((column) => column.name === 'normalized_conversation');
    if (normalized?.notnull !== 1 || normalized.hidden !== 3) {
      throw new Error('Connector store schema normalized_conversation must be a non-null stored generated column.');
    }
  }
}

function assertExactTableColumns(
  db: Database,
  table: string,
  expected: readonly string[],
  includeGenerated: boolean,
  versionLabel: string,
): void {
  const actual = tableColumns(db, table, includeGenerated);
  if (!sameStringSet(actual, expected)) {
    throw new Error(`Connector store schema table ${table} does not have the required ${versionLabel} columns.`);
  }
}

function assertIndexColumns(
  db: Database,
  indexName: string,
  expected: readonly string[],
  versionLabel: string,
): void {
  const actual = indexColumns(db, indexName);
  if (!sameStrings(actual, expected)) {
    throw new Error(`Connector store schema index ${indexName} does not have the required ${versionLabel} columns.`);
  }
}

function assertTriggerExists(db: Database, triggerName: string, versionLabel: string): void {
  const row = db.query(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'trigger' AND name = ?
  `).get(triggerName) as { present: number } | null;
  if (!row) throw new Error(`Connector store schema trigger ${triggerName} is missing for ${versionLabel}.`);
}

function tableColumns(db: Database, table: string, includeGenerated: boolean): string[] {
  const pragma = includeGenerated ? 'table_xinfo' : 'table_info';
  return (db.query(`PRAGMA ${pragma}(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function indexColumns(db: Database, indexName: string): string[] {
  return (db.query(`PRAGMA index_info(${indexName})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function createItemOwnersTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS item_owners (
      item_pk INTEGER NOT NULL,
      connector_id TEXT NOT NULL,
      ownership_kind TEXT NOT NULL CHECK(ownership_kind IN ('observed', 'preservation')),
      first_seen_sync_run_id TEXT NOT NULL,
      last_seen_sync_run_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY(item_pk, connector_id),
      FOREIGN KEY(item_pk) REFERENCES items(item_pk) ON DELETE CASCADE,
      FOREIGN KEY(first_seen_sync_run_id) REFERENCES sync_runs(sync_run_id),
      FOREIGN KEY(last_seen_sync_run_id) REFERENCES sync_runs(sync_run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_connector_store_item_owners_connector
      ON item_owners(connector_id, ownership_kind, last_seen_sync_run_id);
  `);
}

/**
 * The corpus-side generation ledger: the newest write grant this store has
 * accepted for one item under one claim scope.
 *
 * It exists because a producer's "do I still hold this work?" check reads a
 * DIFFERENT database. No transaction spans the two, so the answer is stale the
 * moment it is given, and a superseded producer that was told "yes" a
 * millisecond too early would otherwise overwrite the current holder's content
 * here — with the queue reporting the other producer as the winner. Recording
 * the accepted grant inside the write's own transaction turns that race into a
 * comparison this store can make on its own.
 *
 * `claim_authority` is carried because ordinals only order within the sequence
 * that minted them. A grant from a different authority — another queue, or the
 * same queue rebuilt — is not comparable and takes the row over rather than
 * being refused, so recreating a producer's database cannot permanently wedge
 * every write into this corpus.
 *
 * Rows are keyed by item_pk and cascade with the item, so a purge takes the
 * ledger with it. A pk reused after a delete is harmless: ordinals within one
 * authority only ever increase, so a later grant is always newer than anything
 * an earlier item left behind.
 */
function createConnectorStoreItemWriteClaimsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS item_write_claims (
      item_pk INTEGER NOT NULL,
      claim_scope TEXT NOT NULL,
      claim_authority TEXT NOT NULL,
      claim_ordinal INTEGER NOT NULL,
      claim_holder TEXT NOT NULL,
      claim_generation TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      PRIMARY KEY(item_pk, claim_scope),
      FOREIGN KEY(item_pk) REFERENCES items(item_pk) ON DELETE CASCADE
    );
  `);
}

function createConnectorStoreFtsRowsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_store_fts_rows (
      fts_rowid INTEGER PRIMARY KEY,
      item_pk INTEGER NOT NULL,
      chunk_pk INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_connector_store_fts_rows_item
      ON connector_store_fts_rows(item_pk);
  `);
}

function createConnectorStoreSenderIndexes(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_connector_store_items_sender_id
      ON items(sender_id);
    CREATE INDEX IF NOT EXISTS idx_connector_store_items_sender_label
      ON items(sender_label);
    CREATE INDEX IF NOT EXISTS idx_connector_store_items_sender_owner
      ON items(sender_is_owner, sender_id);
  `);
}

function createConnectorStoreEmbeddingModelsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_models (
      model_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding_backend TEXT NOT NULL CHECK(embedding_backend IN ('local', 'cloud')),
      embedding_epoch TEXT NOT NULL,
      cloud_embedding_eligible INTEGER NOT NULL
        CHECK(cloud_embedding_eligible IN (0, 1)),
      created_at TEXT NOT NULL
    );
  `);
}

function createConnectorStoreLocatorIdentityIndex(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS item_locator_identities (
      item_pk INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      account_scope TEXT NOT NULL,
      normalized_conversation TEXT NOT NULL,
      normalized_locator TEXT NOT NULL,
      FOREIGN KEY(item_pk) REFERENCES items(item_pk) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_connector_store_locator_identity
      ON item_locator_identities(
        provider,
        account_scope,
        normalized_conversation,
        normalized_locator,
        item_pk
      );
    CREATE TABLE IF NOT EXISTS locator_identity_index_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      cursor_item_pk INTEGER NOT NULL,
      completed INTEGER NOT NULL CHECK(completed IN (0, 1))
    );
    INSERT OR IGNORE INTO locator_identity_index_state (
      singleton, cursor_item_pk, completed
    )
    SELECT
      1,
      0,
      CASE WHEN EXISTS(
        SELECT 1 FROM items
        WHERE tombstoned = 0 AND locator_uri IS NOT NULL
        LIMIT 1
      ) THEN 0 ELSE 1 END;

    CREATE TRIGGER IF NOT EXISTS connector_store_locator_identity_insert
    AFTER INSERT ON items
    WHEN NEW.tombstoned = 0 AND NEW.locator_uri IS NOT NULL
    BEGIN
      INSERT INTO item_locator_identities (
        item_pk, provider, account_scope, normalized_conversation,
        normalized_locator
      ) VALUES (
        NEW.item_pk,
        NEW.provider,
        NEW.account_scope,
        NEW.normalized_conversation,
        LOWER(NEW.locator_uri)
      )
      ON CONFLICT(item_pk) DO UPDATE SET
        provider = excluded.provider,
        account_scope = excluded.account_scope,
        normalized_conversation = excluded.normalized_conversation,
        normalized_locator = excluded.normalized_locator;
    END;

    CREATE TRIGGER IF NOT EXISTS connector_store_locator_identity_update
    AFTER UPDATE OF
      provider,
      account_scope,
      provider_conversation_id,
      locator_uri,
      tombstoned
    ON items
    BEGIN
      DELETE FROM item_locator_identities WHERE item_pk = NEW.item_pk;
      INSERT INTO item_locator_identities (
        item_pk, provider, account_scope, normalized_conversation,
        normalized_locator
      )
      SELECT
        NEW.item_pk,
        NEW.provider,
        NEW.account_scope,
        NEW.normalized_conversation,
        LOWER(NEW.locator_uri)
      WHERE NEW.tombstoned = 0 AND NEW.locator_uri IS NOT NULL;
    END;
  `);
}

function toFtsQuery(query: string, options: { prefix?: boolean } = {}): string {
  return sourceIndexFtsQuery(query, options);
}

function connectorStoreTitleFtsQuery(terms: readonly string[]): string {
  // These are already normalized by the legacy chat-title matcher. Building
  // the quoted literal-prefix query here keeps its stopword vocabulary as the
  // single authority instead of sending the terms through the broader shared
  // FTS query normalizer a second time. The 24-term cap retains the shared
  // FTS lane's bounded-query contract.
  const normalizedTerms = [
    ...new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean)),
  ].slice(0, 24);
  if (normalizedTerms.length === 0) return '';
  const query = normalizedTerms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(' OR ');
  return `title : (${query})`;
}

function normalizeMaxItems(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Connector store sync maxItems must be a positive integer when provided.');
  }
  return value;
}

function normalizeLocatorIdentityBackfillItems(value: number | undefined): number {
  if (value === undefined) return 1_000;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error('Connector store locator identity backfill maxItems must be between 1 and 10,000.');
  }
  return value;
}

// The default keeps a sweep window inside one sync pull's budget; the durable
// cursor carries a larger stricter store across pulls instead of holding one
// pull open for the whole walk.
function normalizeTrustReconciliationWindows(value: number | undefined): number {
  if (value === undefined) return 4;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new Error('Connector store trust reconciliation maxWindows must be between 1 and 100,000.');
  }
  return value;
}

const TRUST_RECONCILIATION_CURSOR_PATTERN = /^(complete:)?stricter-item-pk:(\d{1,15})$/;

// One pass converges up to ten million items at the default window. A store
// larger than that resumes from the durable cursor on the next pass instead of
// holding one sync open indefinitely.
function normalizeLocatorIdentityConvergenceWindows(value: number | undefined): number {
  if (value === undefined) return 10_000;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new Error('Connector store locator identity convergence maxWindows must be between 1 and 100,000.');
  }
  return value;
}

function yieldConnectorSyncTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function normalizeRepairCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Connector store search-text repair cursor is invalid.');
  }
  return parsed;
}

function normalizeSenderRepairCursor(value: string | undefined, recordCount: number): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > recordCount) {
    throw new Error('Connector store sender repair cursor is invalid.');
  }
  return parsed;
}

function normalizeRepairBatchSize(value: number | undefined): number {
  if (value === undefined) return 1_000;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error('Connector store search-text repair batch size must be between 1 and 10,000.');
  }
  return value;
}

interface ConnectorStoreExtractionCandidateRow {
  item_pk: number;
  family: SourceItemIdentity['family'];
  provider: string;
  account_scope: string;
  provider_item_id: string;
  provider_thread_id: string | null;
  provider_conversation_id: string | null;
  provider_file_id: string | null;
  provider_event_id: string | null;
  local_item_id: string;
  source_version: string | null;
  title: string | null;
  mime_type: string | null;
  locator_uri: string | null;
  content_hash: string | null;
  trust_tier: SourceTrustTier;
  stored_chunks: number;
}

function extractionCandidateFromRow(
  row: ConnectorStoreExtractionCandidateRow,
): ConnectorStoreExtractionCandidate {
  return {
    identity: {
      family: row.family,
      provider: row.provider,
      accountScope: row.account_scope,
      providerItemId: row.provider_item_id,
      localItemId: row.local_item_id,
      ...(row.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {}),
      ...(row.provider_conversation_id ? { providerConversationId: row.provider_conversation_id } : {}),
      ...(row.provider_file_id ? { providerFileId: row.provider_file_id } : {}),
      ...(row.provider_event_id ? { providerEventId: row.provider_event_id } : {}),
      ...(row.source_version ? { sourceVersion: row.source_version } : {}),
    },
    trustTier: row.trust_tier,
    storedChunks: row.stored_chunks,
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(row.title ? { name: row.title } : {}),
    ...(row.locator_uri ? { locatorUri: row.locator_uri } : {}),
    ...(row.content_hash ? { contentHash: row.content_hash } : {}),
  };
}

function normalizeExtractionCandidateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) {
    throw new Error('Connector store extraction candidate limit must be between 1 and 5,000.');
  }
  return value;
}

function normalizeExtractionCandidateCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  const cursor = Number(value.trim());
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error('Connector store extraction candidate cursor must be a non-negative integer.');
  }
  return cursor;
}

/**
 * Builds the media-type predicate, or undefined when no filter was asked for.
 *
 * Two forms and only two: an exact type, or a trailing `type/*` wildcard. The
 * wildcard exists because a caller asking for images cannot enumerate every
 * subtype a provider might report, and an unlisted subtype would be skipped
 * with no signal that anything was missed. Any other use of `*` is refused
 * here rather than quietly matching nothing.
 */
function buildMimeTypeMatcher(
  mimeTypes: readonly string[] | undefined,
): ((value: string | null) => boolean) | undefined {
  if (mimeTypes === undefined) return undefined;
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of mimeTypes) {
    const normalized = normalizeMimeType(entry);
    if (!normalized) {
      throw new Error('Connector store extraction candidate media types must be non-empty.');
    }
    if (!normalized.includes('*')) {
      exact.add(normalized);
      continue;
    }
    if (!normalized.endsWith('/*') || normalized.indexOf('*') !== normalized.length - 1) {
      throw new Error(
        'Connector store extraction candidate media-type wildcards must be of the form "type/*".',
      );
    }
    prefixes.push(normalized.slice(0, -1));
  }
  if (exact.size === 0 && prefixes.length === 0) {
    throw new Error('Connector store extraction candidate media types must not be empty.');
  }
  return (value: string | null): boolean => {
    const normalized = normalizeMimeType(value ?? '');
    if (!normalized) return false;
    if (exact.has(normalized)) return true;
    return prefixes.some((prefix) => normalized.startsWith(prefix));
  };
}

// A media type without its parameters, lowercased: `text/plain; charset=utf-8`
// and `Text/Plain` are the same type, and every comparison in this module wants
// them to compare equal.
function normalizeMimeType(value: string): string {
  return value.split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Every field of a write claim is load-bearing, so none of them may be blank
 * and the ordinal must be a real position in a sequence. A claim that arrives
 * malformed is a producer defect, and letting it through would write a ledger
 * row that orders nothing.
 */
function normalizeConnectorStoreItemWriteClaim(
  claim: ConnectorStoreItemWriteClaim,
): ConnectorStoreItemWriteClaim {
  if (!Number.isSafeInteger(claim.ordinal) || claim.ordinal < 1) {
    throw new Error('Connector store item write claim ordinal must be a positive integer.');
  }
  return {
    scope: requireNonEmpty(claim.scope, 'Connector store item write claim scope'),
    authority: requireNonEmpty(claim.authority, 'Connector store item write claim authority'),
    ordinal: claim.ordinal,
    holder: requireNonEmpty(claim.holder, 'Connector store item write claim holder'),
    generation: requireNonEmpty(claim.generation, 'Connector store item write claim generation'),
  };
}

function normalizeMaxChunkChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CHUNK_CHARS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Connector store sync maxChunkChars must be a positive integer when provided.');
  }
  return Math.min(value, MAX_MAX_CHUNK_CHARS);
}

function normalizeOptionalSha256(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a SHA-256 hex digest when provided.`);
  }
  return normalized;
}

function requireNonEmpty(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

// The store's digest, exported for the same reason as chunkText: a caller that
// must predict a stored content_hash or chunk content_hash runs this, never a
// reimplementation of it.
export function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

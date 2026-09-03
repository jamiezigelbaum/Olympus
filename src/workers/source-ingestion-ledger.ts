import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { ContentExtractionThroughputSignal } from '../core/ingestion-throughput.ts';
import { defaultConfig, type OlympusConfig } from '../core/config.ts';
import {
  canonicalSourceCorpusId,
  createSourceCorpusRegistry,
  type SourceCorpusRegistry,
} from '../core/source-corpus-registry.ts';
import {
  createSourceExclusionMatcher,
  loadSourceIngestionExclusions,
  type SourceExclusionMatcher,
} from '../core/source-ingestion-exclusions.ts';
import type { SourceSchedulerStatus } from './source-scheduler.ts';
import { defaultSourceDashboardHistoryDbPath } from './source-dashboard.ts';
import {
  answerReadyEligibleFromCounts,
  answerReadyEligibleItems,
  metadataOnlyByPolicyFromCounts,
  notReadByPolicyFromCounts,
} from './dashboard/answer-ready-coverage.ts';
import {
  createSourceIndexStatusHandler,
  type SourceIndexLastRefresh,
  type SourceIndexStatusCorpus,
  type SourceIndexStatusResult,
} from './source-index/status.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  googleDriveIngestionExclusionMatcher,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
  defaultGmailConnectorStoreDbPath,
  defaultGmailSecureConnectorStoreDbPath,
  defaultGoogleDriveConnectorStoreDbPath,
  defaultGoogleDriveSecureConnectorStoreDbPath,
} from './google-connectors/index.ts';
import {
  LocalConnectorStore,
} from './connector-store/index.ts';
import { defaultReadwiseConnectorStoreDbPath } from './readwise/index.ts';
import { defaultXBookmarksConnectorStoreDbPath } from './x-bookmarks/index.ts';
import {
  DROPBOX_FILES_CORPUS_ID,
  createDropboxConnectorStore,
  defaultDropboxConnectorStoreDbPath,
  dropboxIngestionExclusionMatcher,
} from './dropbox-files/index.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  defaultInternalTelegramConnectorStoreDbPath,
  defaultProtectedTelegramConnectorStoreDbPath,
} from './telegram-messages/index.ts';
import { closeSqliteStore } from '../core/sqlite-store.ts';

export interface SourceIngestionLedgerSnapshot {
  kind: 'source_ingestion_ledger';
  generated_at: string;
  rows: SourceIngestionLedgerRow[];
  unassigned_corpora: SourceIngestionUnassignedCorpora;
  // Optional only so snapshots parsed from an older worker response, and the
  // fixtures that predate this section, still satisfy the type. Every snapshot
  // this module builds carries it.
  excluded_by_configuration?: SourceIngestionExcludedByConfiguration;
  attention: string[];
  unreadable_content?: SourceIngestionUnreadableContent[];
  policy: {
    read_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    castor_safe: boolean;
  };
}

/**
 * Corpora the status result reports that no ledger row owns. They are the
 * owner's data sitting in the local store, so they are listed here by id and
 * counted rather than dropped.
 *
 * This section exists because the row-assignment step used to substring-scan
 * corpus ids for a provider token and `continue` past everything it could not
 * map — so a corpus with no token in its id vanished from ingestion health
 * without a word. Mirrors the dashboard's `unassigned_corpora`.
 */
export interface SourceIngestionUnassignedCorpora {
  corpus_count: number;
  items: number;
  content_indexed: number;
  entries: SourceIngestionUnassignedCorpus[];
}

export interface SourceIngestionUnassignedCorpus {
  corpus_id: string;
  trust_domain: string;
  // The source-corpus registry's own `sourceId` for this corpus when it has
  // one. Present-but-unclaimed means the registry knows the corpus and no
  // ledger row declares that source id; absent means the registry does not
  // carry the corpus at all.
  registry_source_id?: string;
  configured: boolean;
  items: number;
  content_indexed: number;
}

/**
 * Folders the owner's own configuration keeps out of ingestion, and the items
 * still stored under them.
 *
 * Deliberately a sibling of `unassigned_corpora` rather than a variant of it,
 * because the two say opposite things. Unassigned means "indexed, counted in
 * the totals, just not on a row". Excluded means "the owner chose that this is
 * never ingested" — an omission from the totals that is correct.
 *
 * `rules`/`prefixes`/`entries` describe the configuration itself and are
 * reported even when nothing matches: an exclusion list that failed to reach
 * this process looks exactly like one that matched nothing unless the compiled
 * rules are printed.
 *
 * `items_present` is the other half, and it is PURGE DEBT, not a match count:
 * items indexed before the exclusion existed that still sit in a store under an
 * excluded folder. They are still counted in the rows above until a purge
 * removes them, and this number reads 0 once one has run.
 */
export interface SourceIngestionExcludedByConfiguration {
  rules: number;
  prefixes: number;
  /**
   * Of `rules`/`prefixes`, those the owner marked metadata-only: indexed, never
   * read. Counted separately rather than mixed in, because the two answer
   * different questions and an owner reading "8 excluded folders" when six of
   * them are still fully searchable by title has been told something false.
   */
  metadata_only_rules: number;
  metadata_only_prefixes: number;
  /**
   * Items still carrying CONTENT that a metadata-only rule says they should
   * not: chunks and vectors written before the rule existed. Strip debt, the
   * metadata-only sibling of `items_present`, and it reads 0 once the strip has
   * run. The item rows themselves are correct and are never counted here.
   */
  items_metadata_only_content_present: number;
  items_present: number;
  // Of `items_present`, those whose stored path this gate cannot evaluate. The
  // purge keeps them by default, so they are the part of the debt that needs a
  // decision rather than a run.
  items_unevaluable: number;
  /**
   * Blanket rules (ones naming no source) that at least one source can enforce
   * nothing of — a Drive-shaped source handed a path prefix, say. Present only
   * when non-empty, because "no such rules" is the ordinary case and an
   * always-present empty array trains a reader to skip the field.
   *
   * A rule that NAMED such a source never reaches here: that is refused when
   * the gate is built.
   */
  unenforceable_rule_ids?: string[];
  entries: SourceIngestionExcludedFolder[];
  /**
   * The same section again, split by the source whose gate produced it.
   *
   * Present only when at least one caller declared which source its gate
   * belongs to: a caller that supplies no attribution gets the global section
   * alone rather than a list of anonymous rows. The counts here are NOT
   * deduplicated against each other — one rule naming two sources is one rule
   * in the global block above and appears under both sources here, because
   * "which of my rules apply to Dropbox" is the question this answers.
   */
  by_source?: SourceIngestionExcludedBySource[];
}

/**
 * One source's slice of the exclusion section.
 *
 * `corpus_ids` is the join key for readers, not `source_id`: the exclusion
 * source id ('dropbox.personal'), the ledger row id ('dropbox') and the
 * dashboard card id ('dropbox.files') are three different id spaces, and
 * corpus ids are the only ones that match across all of them.
 */
export interface SourceIngestionExcludedBySource {
  source_id?: string;
  corpus_ids: string[];
  rules: number;
  prefixes: number;
  metadata_only_rules: number;
  metadata_only_prefixes: number;
  items_metadata_only_content_present: number;
  items_present: number;
  items_unevaluable: number;
  unenforceable_rule_ids?: string[];
  entries: SourceIngestionExcludedFolder[];
}

/**
 * One excluded folder. `prefix` is the owner's own configured path, not any
 * item's path, which is why it is the single path-shaped value this
 * counts-only ledger carries.
 */
export interface SourceIngestionExcludedFolder {
  rule_id: string;
  prefix: string;
  /** Which disposition this row describes: `exclude` or `metadata_only`. */
  mode: string;
  /**
   * How the rule named its items: `path_prefix`, `folder_id`, or `media`.
   *
   * Carried so this section can say "folders" only when every row IS a folder.
   * A media criterion is not a folder, and a heading that called it one would
   * be the section quietly misdescribing the owner's own configuration.
   */
  kind: string;
  reason: string;
}

export interface SourceIngestionLedgerRow {
  source_id: string;
  label: string;
  primary_corpus_id: string;
  corpus_ids: string[];
  family: string;
  trust_domains: string[];
  configured: boolean;
  items: number;
  content_indexed: number;
  metadata_only: number;
  failed: number;
  coverage_percent: number;
  stuck: {
    queued: number;
    active: number;
    held_paused: number;
    broken: number;
  };
  ingestion_health: SourceIngestionHealth;
  freshness_hours?: number;
  last_sync_at?: string;
  attention: string[];
  failure_breakdown?: SourceIngestionFailureBreakdown[];
}

export interface SourceIngestionFailureBreakdown {
  status: string;
  extractor_kind: string;
  error_class?: string;
  count: number;
  oldest_created_at?: string;
  newest_updated_at?: string;
}

export interface SourceIngestionHealth {
  coverage_percent: number;
  /**
   * Indexed items this source is never asked to read, and which
   * `coverage_percent` therefore leaves out of its denominator (owner ruling,
   * 2026-08-21 — see dashboard/answer-ready-coverage.ts).
   *
   * Absent, not zero, for a source whose corpora report no such count: absent
   * means the exclusion never applied and the percentage is the same number it
   * always was. Carried inside ingestion_health so it rides the existing
   * `ingestion_health_json` blob rather than needing a new ledger column.
   */
  not_read_by_policy_items?: number;
  /** Exact items selected as Metadata only; unlike row.metadata_only, this is not an extraction backlog. */
  metadata_only_by_policy_items?: number;
  /**
   * The corpus's own eligible denominator, summed across the corpora that
   * publish one. Absent when none did, in which case `coverage_percent` is
   * `items` minus `not_read_by_policy_items` exactly as before.
   */
  answer_ready_eligible_items?: number;
  stuck_work: {
    queued: number;
    failed_retryable: number;
    failed_terminal: number;
    oldest_age_hours?: number;
    oldest_item_at?: string;
    by_class: SourceIngestionStuckWorkClass[];
  };
  drain: {
    state: 'enabled' | 'disabled' | 'held' | 'unknown';
    unit?: string;
    hold_marker?: string;
    last_activity_at?: string;
    last_activity_hours?: number;
    hint?: string;
  };
  content_extraction_throughput?: ContentExtractionThroughputSignal;
}

export interface SourceIngestionStuckWorkClass {
  status: string;
  extractor_kind: string;
  error_class?: string;
  count: number;
  oldest_age_hours?: number;
}

export interface SourceIngestionUnreadableContent {
  source_id: string;
  name: string;
  path_display?: string;
  status: string;
  extractor_kind: string;
  error_class?: string;
  updated_at: string;
}

export interface SourceIngestionLedgerBuildOptions {
  schedulerStatus?: SourceSchedulerStatus;
  // Authority on which ledger row owns which corpus. Defaults to the shipped
  // registry so every caller gets the same answer; pass the operator's
  // configured registry when one exists.
  sourceCorpusRegistry?: SourceCorpusRegistry;
  dropboxFailureBreakdown?: SourceIngestionFailureBreakdown[];
  unreadableContent?: Array<Omit<SourceIngestionUnreadableContent, 'source_id'>>;
  // The owner's folder exclusions, one entry per source gate. Optional and
  // empty by default so every existing caller keeps compiling; an empty list
  // yields an all-zero section rather than an absent one.
  exclusions?: readonly SourceIngestionLedgerExclusionSource[];
  now?: Date;
  safeForCastor?: boolean;
}

/**
 * One source's exclusion gate, plus what is still stored behind it.
 *
 * The matcher is supplied already source-scoped: this module does not decide
 * which rules apply to which source, the wiring layer does. `present` is
 * omitted when no store is mounted for that source — the rules are still
 * reported, because "configured but nothing to measure" and "not configured"
 * are different answers.
 */
export interface SourceIngestionLedgerExclusionSource {
  matcher: SourceExclusionMatcher;
  present?: { items: number; unevaluable: number };
  /** Stored items still carrying content a metadata-only rule refuses. */
  metadataOnlyContentPresent?: { items: number; unevaluable: number };
  /**
   * Which source this gate belongs to, for the per-source split. Optional
   * because the global section never needed it; a caller that supplies neither
   * this nor `corpusIds` gets no `by_source` row rather than an unattributed
   * one.
   */
  sourceId?: string;
  /**
   * The corpora this gate covers. The join key readers use, since the source id
   * spaces do not line up across the ledger, the picker and the dashboard.
   */
  corpusIds?: readonly string[];
}

export interface CollectLocalSourceIngestionLedgerOptions {
  env?: Record<string, string | undefined>;
  config?: OlympusConfig;
  now?: Date;
  dashboardDbPath?: string;
}

type MutableLedgerRow = Omit<SourceIngestionLedgerRow, 'corpus_ids' | 'trust_domains' | 'attention'> & {
  corpus_ids: Set<string>;
  trust_domains: Set<string>;
  attention: string[];
  coverage_percent: number;
  ingestion_health: SourceIngestionHealth;
};

interface LedgerSourceDefinition {
  label: string;
  primaryCorpusId: string;
  family: string;
  // Every source-corpus-registry `sourceId` whose corpora are counted into this
  // row. Declared, not sniffed: assignment used to substring-scan corpus ids
  // for a provider token and skip whatever carried none, which silently dropped
  // the path-scoped internal band of the owner's own Dropbox out of ingestion
  // health. The ledger keys rows by its own short source id, which is NOT the
  // registry source id — WhatsApp is `whatsapp` here and
  // `whatsapp.personal.messages` there — so the mapping has to be written down
  // rather than inferred.
  corpusSourceIds: readonly string[];
}

const SOURCE_DEFINITIONS: Record<string, LedgerSourceDefinition> = {
  email: {
    label: 'Email',
    primaryCorpusId: 'secure_local.email.private',
    family: 'email',
    corpusSourceIds: ['gmail.email'],
  },
  google_drive: {
    label: 'Google Drive',
    primaryCorpusId: 'internal.drive.docs',
    family: 'file',
    corpusSourceIds: ['google_drive.docs'],
  },
  telegram: {
    label: 'Telegram',
    primaryCorpusId: 'internal.telegram.messages',
    family: 'chat',
    corpusSourceIds: ['telegram.messages'],
  },
  readwise: {
    label: 'Readwise',
    primaryCorpusId: 'internal.readwise.library',
    family: 'readwise',
    corpusSourceIds: ['readwise.library'],
  },
  x: {
    label: 'X bookmarks',
    primaryCorpusId: 'internal.x.bookmarks',
    family: 'x',
    corpusSourceIds: ['x.bookmarks'],
  },
  dropbox: {
    label: 'Dropbox',
    primaryCorpusId: 'secure_local.dropbox.files',
    family: 'file',
    // Covers the path-scoped internal governance band, which the registry also
    // files under `dropbox.files` and whose corpus id carries no `dropbox`
    // token — so id-sniffing dropped it while the registry finds it.
    corpusSourceIds: ['dropbox.files'],
  },
  whatsapp: {
    label: 'WhatsApp',
    primaryCorpusId: 'secure_local.whatsapp.messages',
    family: 'chat',
    corpusSourceIds: ['whatsapp.personal.messages'],
  },
};

export function buildSourceIngestionLedgerSnapshot(
  status: SourceIndexStatusResult,
  options: SourceIngestionLedgerBuildOptions = {},
): SourceIngestionLedgerSnapshot {
  const now = options.now ?? new Date(status.generated_at);
  const assign = ledgerSourceAssignment(options.sourceCorpusRegistry);
  const rows = new Map<string, MutableLedgerRow>();
  const unassigned = new Map<string, SourceIngestionUnassignedCorpus>();
  const nestedBands = nestedBandCorpusIds(status.corpora, assign);
  for (const corpus of status.corpora) {
    const sourceId = assign.ledgerSourceIdForCorpus(corpus.corpus_id);
    if (!sourceId) {
      // No row owns this corpus. It is still the owner's data, so it is listed
      // and counted here instead of being dropped on the floor.
      unassigned.set(corpus.corpus_id, unassignedCorpusEntry(corpus, assign));
      continue;
    }
    const row = rows.get(sourceId) ?? emptyRow(sourceId);
    rows.set(sourceId, row);
    applyCorpus(row, corpus, now, nestedBands.has(corpus.corpus_id));
  }

  applyScheduler(rows, unassigned, assign, options.schedulerStatus, now);
  applyDropboxBreakdown(rows, options.dropboxFailureBreakdown, now);

  const ordered = Object.keys(SOURCE_DEFINITIONS).map((sourceId) =>
    finalizeRow(rows.get(sourceId) ?? emptyRow(sourceId), now)
  );
  const unassignedCorpora = summarizeUnassigned(Array.from(unassigned.values()));
  const excludedByConfiguration = summarizeExcludedByConfiguration(options.exclusions ?? []);
  const attention = [
    ...ordered.flatMap((row) => row.attention.map((item) => `${row.label}: ${item}`)),
    ...unassignedAttention(unassignedCorpora),
    ...excludedByConfigurationAttention(excludedByConfiguration),
  ];
  const unreadable = options.safeForCastor
    ? undefined
    : options.unreadableContent?.map((item) => ({
      source_id: 'dropbox',
      name: item.name,
      ...(item.path_display ? { path_display: item.path_display } : {}),
      status: item.status,
      extractor_kind: item.extractor_kind,
      ...(item.error_class ? { error_class: item.error_class } : {}),
      updated_at: item.updated_at,
    }));

  return {
    kind: 'source_ingestion_ledger',
    generated_at: (Number.isNaN(now.getTime()) ? new Date() : now).toISOString(),
    rows: ordered,
    unassigned_corpora: unassignedCorpora,
    excluded_by_configuration: excludedByConfiguration,
    attention,
    ...(unreadable && unreadable.length > 0 ? { unreadable_content: unreadable } : {}),
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      castor_safe: options.safeForCastor === true,
    },
  };
}

// Retention for source_dashboard_samples, which this class and
// SqliteSourceDashboardHistory both append to in one shared file. These bounds
// must stay equal to the dashboard writer's: the scheduler's afterTick hook
// writes here every tick on a headless install where nobody ever opens the
// dashboard, so this is normally the only writer that runs at all.
const SAMPLE_RETENTION_MS = 24 * 60 * 60_000;
const MAX_SAMPLES_PER_CORPUS = 720;

export class SqliteSourceIngestionLedgerStore {
  private readonly db: Database;

  constructor(dbPath = defaultSourceDashboardHistoryDbPath()) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA busy_timeout = 10000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_dashboard_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        corpus_id TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        indexed_items INTEGER NOT NULL,
        content_ready_items INTEGER NOT NULL,
        queue_waiting INTEGER NOT NULL,
        queue_active INTEGER NOT NULL,
        queue_attention INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS source_dashboard_samples_corpus_time_idx
        ON source_dashboard_samples (corpus_id, sampled_at);
      CREATE TABLE IF NOT EXISTS source_ingestion_ledger (
        source_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        primary_corpus_id TEXT NOT NULL,
        corpus_ids_json TEXT NOT NULL,
        family TEXT NOT NULL,
        trust_domains_json TEXT NOT NULL,
        configured INTEGER NOT NULL,
        items INTEGER NOT NULL,
        content_indexed INTEGER NOT NULL,
        metadata_only INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        coverage_percent REAL NOT NULL DEFAULT 0,
        stuck_queued INTEGER NOT NULL,
        stuck_active INTEGER NOT NULL,
        held_paused INTEGER NOT NULL,
        broken INTEGER NOT NULL,
        ingestion_health_json TEXT NOT NULL DEFAULT '{}',
        freshness_hours REAL,
        last_sync_at TEXT,
        attention_json TEXT NOT NULL,
        failure_breakdown_json TEXT NOT NULL,
        refreshed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_ingestion_unreadable_content (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        name TEXT NOT NULL,
        path_display TEXT,
        status TEXT NOT NULL,
        extractor_kind TEXT NOT NULL,
        error_class TEXT,
        updated_at TEXT NOT NULL,
        refreshed_at TEXT NOT NULL
      );
    `);
    ensureColumn(this.db, 'source_ingestion_ledger', 'coverage_percent', 'REAL NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'source_ingestion_ledger', 'ingestion_health_json', "TEXT NOT NULL DEFAULT '{}'");
  }

  record(snapshot: SourceIngestionLedgerSnapshot): void {
    const upsert = this.db.query(`
      INSERT INTO source_ingestion_ledger (
        source_id, label, primary_corpus_id, corpus_ids_json, family,
        trust_domains_json, configured, items, content_indexed, metadata_only,
        failed, coverage_percent, stuck_queued, stuck_active, held_paused, broken,
        ingestion_health_json, freshness_hours, last_sync_at, attention_json,
        failure_breakdown_json, refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        label = excluded.label,
        primary_corpus_id = excluded.primary_corpus_id,
        corpus_ids_json = excluded.corpus_ids_json,
        family = excluded.family,
        trust_domains_json = excluded.trust_domains_json,
        configured = excluded.configured,
        items = excluded.items,
        content_indexed = excluded.content_indexed,
        metadata_only = excluded.metadata_only,
        failed = excluded.failed,
        coverage_percent = excluded.coverage_percent,
        stuck_queued = excluded.stuck_queued,
        stuck_active = excluded.stuck_active,
        held_paused = excluded.held_paused,
        broken = excluded.broken,
        ingestion_health_json = excluded.ingestion_health_json,
        freshness_hours = excluded.freshness_hours,
        last_sync_at = excluded.last_sync_at,
        attention_json = excluded.attention_json,
        failure_breakdown_json = excluded.failure_breakdown_json,
        refreshed_at = excluded.refreshed_at
    `);
    const sample = this.db.query(`
      INSERT INTO source_dashboard_samples (
        source_id, corpus_id, sampled_at, indexed_items, content_ready_items,
        queue_waiting, queue_active, queue_attention
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const expireSamplesBefore = this.db.query(
      'DELETE FROM source_dashboard_samples WHERE sampled_at < ?',
    );
    const trimCorpusSamples = this.db.query(`
      DELETE FROM source_dashboard_samples
      WHERE corpus_id = ?
        AND id NOT IN (
          SELECT id FROM source_dashboard_samples
          WHERE corpus_id = ?
          ORDER BY sampled_at DESC, id DESC
          LIMIT ?
        )
    `);
    const insertUnreadable = this.db.query(`
      INSERT INTO source_ingestion_unreadable_content (
        source_id, name, path_display, status, extractor_kind, error_class,
        updated_at, refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const row of snapshot.rows) {
        upsert.run(
          row.source_id,
          row.label,
          row.primary_corpus_id,
          JSON.stringify(row.corpus_ids),
          row.family,
          JSON.stringify(row.trust_domains),
          row.configured ? 1 : 0,
          row.items,
          row.content_indexed,
          row.metadata_only,
          row.failed,
          row.coverage_percent,
          row.stuck.queued,
          row.stuck.active,
          row.stuck.held_paused,
          row.stuck.broken,
          JSON.stringify(row.ingestion_health),
          row.freshness_hours ?? null,
          row.last_sync_at ?? null,
          JSON.stringify(row.attention),
          JSON.stringify(row.failure_breakdown ?? []),
          snapshot.generated_at,
        );
        sample.run(
          row.source_id,
          row.primary_corpus_id,
          snapshot.generated_at,
          row.items,
          row.content_indexed,
          row.stuck.queued,
          row.stuck.active,
          row.failed + row.stuck.broken,
        );
      }
      const generatedAt = Date.parse(snapshot.generated_at);
      if (Number.isFinite(generatedAt)) {
        expireSamplesBefore.run(new Date(generatedAt - SAMPLE_RETENTION_MS).toISOString());
      }
      for (const corpusId of new Set(snapshot.rows.map((row) => row.primary_corpus_id))) {
        trimCorpusSamples.run(corpusId, corpusId, MAX_SAMPLES_PER_CORPUS);
      }
      this.db.query('DELETE FROM source_ingestion_unreadable_content').run();
      for (const item of snapshot.unreadable_content ?? []) {
        insertUnreadable.run(
          item.source_id,
          item.name,
          item.path_display ?? null,
          item.status,
          item.extractor_kind,
          item.error_class ?? null,
          item.updated_at,
          snapshot.generated_at,
        );
      }
    })();
  }

  close(): void {
    closeSqliteStore(this.db);
  }
}

export async function collectLocalSourceIngestionLedger(
  options: CollectLocalSourceIngestionLedgerOptions = {},
): Promise<SourceIngestionLedgerSnapshot> {
  const env = options.env ?? process.env;
  const config = options.config ?? defaultConfig();
  const handles: Array<{ close(): void }> = [];
  const connectorStores: LocalConnectorStore[] = [];
  // A connector-store definition carries a corpus, a family and a trust
  // domain, but no source key — so the only exclusion rules that can honestly
  // be applied to it are the ones the owner declared for EVERY source. Naming
  // a source here to widen the match would apply one source's rules to
  // another's store. A parse failure is NOT caught: a broken exclusion list
  // must be loud, not read as "nothing is excluded".
  const sharedExclusions = createSourceExclusionMatcher(loadSourceIngestionExclusions({ env }));
  // Drive's corpora DO have a source key, so they get their own source-scoped
  // gate rather than the every-source one. Measuring them with the shared
  // matcher would have reported zero excluded items no matter what the owner
  // configured for Drive, which is the same silent no-op this WO removed from
  // the ingestion path — a truthful gate upstream and a lying count downstream
  // is not an improvement.
  const driveExclusions = googleDriveIngestionExclusionMatcher(env);
  const driveCorpusIds = new Set<string>([
    GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
    GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
  ]);
  const exclusionSources: SourceIngestionLedgerExclusionSource[] = [];
  for (const store of localConnectorStores(env)) {
    if (!existsSync(store.dbPath)) continue;
    // A folder exclusion is a claim about file storage. Message and bookmark
    // families have no folders, so every one of their items would evaluate as
    // "path unevaluable" and be reported as purge debt — tens of thousands of
    // rows the owner can do nothing about, drowning the real count. Gating on
    // the family keeps the section meaningful rather than merely loud.
    const gated = store.family === 'file';
    const matcher = driveCorpusIds.has(store.corpusId) ? driveExclusions : sharedExclusions;
    const handle = store.corpusId === DROPBOX_FILES_CORPUS_ID
      ? createDropboxConnectorStore(env, { readOnly: true })
      : new LocalConnectorStore({ ...store, ...(gated ? { exclusions: matcher } : {}) });
    handles.push(handle);
    connectorStores.push(handle);
    if (gated) {
      const debt = handle.exclusionDebtPresent();
      exclusionSources.push({
        matcher: handle.exclusions,
        present: debt.excluded,
        metadataOnlyContentPresent: debt.metadataOnlyContent,
        ...(store.corpusId === DROPBOX_FILES_CORPUS_ID
          ? { sourceId: 'dropbox.personal', corpusIds: [DROPBOX_FILES_CORPUS_ID] }
          : driveCorpusIds.has(store.corpusId)
            ? { sourceId: 'google_drive.docs', corpusIds: [store.corpusId] }
            : {}),
      });
    }
  }
  // Dropbox is the one source with a source-scoped gate today. Its rules are
  // reported whether or not a store is mounted, because "configured, nothing
  // mounted to measure" and "not configured" are different answers and only
  // one of them means the owner should check their config.
  exclusionSources.push({ matcher: dropboxIngestionExclusionMatcher(env) });
  // Same reasoning for Drive: "configured, nothing mounted to measure" and "not
  // configured" are different answers, and only one of them means the owner
  // should go and look at their config.
  exclusionSources.push({ matcher: driveExclusions });
  const sourceCorpusRegistry = createSourceCorpusRegistry(config.sourceIndex.corpusRegistry);

  try {
    const status = await createSourceIndexStatusHandler({
      corpusDefinitions: sourceCorpusRegistry.definitions('status'),
      connectorStores,
    }).status({ include_items: false });
    const snapshot = buildSourceIngestionLedgerSnapshot(status, {
      sourceCorpusRegistry,
      exclusions: exclusionSources,
      ...(options.now ? { now: options.now } : {}),
    });
    const store = new SqliteSourceIngestionLedgerStore(options.dashboardDbPath);
    try {
      store.record(snapshot);
    } finally {
      store.close();
    }
    return snapshot;
  } finally {
    for (const handle of handles.reverse()) handle.close();
  }
}

export function formatSourceIngestionLedger(snapshot: SourceIngestionLedgerSnapshot): string {
  const lines = [
    `Olympus ingestion status (${snapshot.generated_at})`,
    '',
    'Corpus            Items  Content-indexed  Metadata-only  Failed  Stuck  Freshness',
    '----------------  -----  ---------------  -------------  ------  -----  ---------',
  ];
  for (const row of snapshot.rows) {
    lines.push([
      pad(row.label, 16),
      pad(formatNumber(row.items), 5),
      pad(formatNumber(row.content_indexed), 15),
      pad(formatNumber(row.metadata_only), 13),
      pad(formatNumber(row.failed), 6),
      pad(formatNumber(row.stuck.queued + row.stuck.active + row.stuck.broken), 5),
      freshnessLabel(row),
    ].join('  '));
  }
  // Guarded because this also formats snapshots parsed from a worker response,
  // which may have been produced before the section existed.
  const unassigned = snapshot.unassigned_corpora as SourceIngestionUnassignedCorpora | undefined;
  if (unassigned && unassigned.corpus_count > 0) {
    lines.push(
      '',
      `Indexed, but on no source row above (${unassigned.corpus_count} ${unassigned.corpus_count === 1 ? 'corpus' : 'corpora'}, `
      + `${formatNumber(unassigned.items)} items, ${formatNumber(unassigned.content_indexed)} content-indexed):`,
    );
    for (const entry of unassigned.entries) {
      lines.push(`- ${entry.corpus_id}  ${formatNumber(entry.items)} items  ${formatNumber(entry.content_indexed)} content-indexed`);
    }
  }
  // Same guard, same reason: a snapshot parsed from a worker response may
  // predate this section.
  const excluded = snapshot.excluded_by_configuration;
  if (excluded && (excluded.prefixes > 0 || excluded.items_present > 0)) {
    // Two blocks, because the two dispositions are not variants of one thing.
    // Printing a metadata-only rule under "never ingested" would tell the owner
    // their titles are gone when they are the whole point of the rule.
    const metadataOnlyRows = excluded.entries.filter((entry) => entry.mode === 'metadata_only');
    const excludeRows = excluded.entries.filter((entry) => entry.mode !== 'metadata_only');
    const excludeRuleCount = new Set(excludeRows.map((entry) => entry.rule_id)).size;
    lines.push(
      '',
      `Excluded by configuration — never ingested (${excludeRuleCount} ${excludeRuleCount === 1 ? 'rule' : 'rules'}, `
      + `${excludeRows.length} ${criterionNoun(excludeRows, excludeRows.length)}):`,
    );
    for (const entry of excludeRows) {
      lines.push(`- ${entry.rule_id}  ${entry.prefix}  ${entry.reason}`);
    }
    if (metadataOnlyRows.length > 0) {
      const metadataOnlyRuleCount = excluded.metadata_only_rules ?? 0;
      lines.push(
        '',
        `Metadata-only by configuration — indexed, content never read (${metadataOnlyRuleCount} `
        + `${metadataOnlyRuleCount === 1 ? 'rule' : 'rules'}, ${metadataOnlyRows.length} `
        + `${criterionNoun(metadataOnlyRows, metadataOnlyRows.length)}):`,
      );
      for (const entry of metadataOnlyRows) {
        lines.push(`- ${entry.rule_id}  ${entry.prefix}  ${entry.reason}`);
      }
      lines.push((excluded.items_metadata_only_content_present ?? 0) > 0
        ? `${formatNumber(excluded.items_metadata_only_content_present ?? 0)} item(s) indexed before these `
          + 'folders became metadata-only still carry content — strip pending; the item rows stay.'
        : 'No stored item under these folders carries content — nothing left to strip.');
    }
    // A bare `0 items` here reads as "nothing is excluded", which is the
    // opposite of what the block above says. Both states are stated in words.
    lines.push(excluded.items_present > 0
      ? `${formatNumber(excluded.items_present)} item(s) indexed before these folders were excluded are still stored `
        + `under them and still counted above — purge pending`
        + `${excluded.items_unevaluable > 0
          ? ` (${formatNumber(excluded.items_unevaluable)} with a path the gate cannot read, kept until you decide)`
          : ''}.`
      : 'No stored items fall under these folders — nothing left to purge.');
  }
  if (snapshot.attention.length > 0) {
    lines.push('', 'Attention:');
    for (const item of snapshot.attention) lines.push(`- ${item}`);
  }
  if ((snapshot.unreadable_content?.length ?? 0) > 0) {
    lines.push('', 'Unreadable content:');
    for (const item of snapshot.unreadable_content ?? []) {
      lines.push(`- ${item.name} (${item.status}, ${item.extractor_kind}${item.error_class ? `, ${item.error_class}` : ''})`);
    }
  }
  return lines.join('\n');
}

function emptyRow(sourceId: string): MutableLedgerRow {
  const definition = SOURCE_DEFINITIONS[sourceId] ?? {
    label: sourceId,
    primaryCorpusId: sourceId,
    family: 'unknown',
  };
  return {
    source_id: sourceId,
    label: definition.label,
    primary_corpus_id: definition.primaryCorpusId,
    corpus_ids: new Set(),
    family: definition.family,
    trust_domains: new Set(),
    configured: false,
    items: 0,
    content_indexed: 0,
    metadata_only: 0,
    failed: 0,
    coverage_percent: 0,
    stuck: { queued: 0, active: 0, held_paused: 0, broken: 0 },
    ingestion_health: {
      coverage_percent: 0,
      stuck_work: {
        queued: 0,
        failed_retryable: 0,
        failed_terminal: 0,
        by_class: [],
      },
      drain: { state: 'unknown' },
    },
    attention: [],
  };
}

function nestedBandCorpusIds(
  _corpora: readonly SourceIndexStatusCorpus[],
  _assign: LedgerSourceAssignment,
): Set<string> {
  return new Set();
}

function applyCorpus(
  row: MutableLedgerRow,
  corpus: SourceIndexStatusCorpus,
  now: Date,
  countsNestedInSuperset = false,
): void {
  row.corpus_ids.add(corpus.corpus_id);
  row.trust_domains.add(corpus.trust_domain);
  row.configured = row.configured || corpus.configured;
  const counts = (corpus as { counts?: Record<string, number | undefined> }).counts ?? {};
  const metrics = countsNestedInSuperset
    ? undefined
    : corpusMetrics(counts);
  if (metrics) {
    row.items += metrics.items;
    row.content_indexed += metrics.contentIndexed;
    row.metadata_only += metrics.metadataOnly;
    if (metrics.notReadByPolicy !== undefined) {
      // Only a corpus that reported the count contributes one, so a row whose
      // corpora all stay silent keeps the key absent and its ratio untouched.
      row.ingestion_health.not_read_by_policy_items =
        (row.ingestion_health.not_read_by_policy_items ?? 0) + metrics.notReadByPolicy;
    }
    if (metrics.metadataOnlyByPolicy !== undefined) {
      row.ingestion_health.metadata_only_by_policy_items =
        (row.ingestion_health.metadata_only_by_policy_items ?? 0) + metrics.metadataOnlyByPolicy;
    }
    // Same rule, same reason: only a corpus that published its own denominator
    // contributes one.
    if (metrics.eligibleItems !== undefined) {
      row.ingestion_health.answer_ready_eligible_items =
        (row.ingestion_health.answer_ready_eligible_items ?? 0) + metrics.eligibleItems;
    }
    row.failed += metrics.failed;
    row.stuck.queued += metrics.queued;
    row.stuck.active += metrics.active;
    row.stuck.broken += metrics.broken;
  }
  const refresh = (corpus as { last_refresh?: SourceIndexLastRefresh }).last_refresh;
  const lastSyncAt = refresh?.completed_at ?? refresh?.started_at;
  if (lastSyncAt && (!row.last_sync_at || Date.parse(lastSyncAt) > Date.parse(row.last_sync_at))) {
    row.last_sync_at = lastSyncAt;
    const freshness = freshnessHours(lastSyncAt, now);
    if (freshness !== undefined) row.freshness_hours = freshness;
  }
  if (!corpus.configured) row.attention.push(`${corpus.corpus_id} not initialized`);
  const throughput = (corpus as { content_extraction_throughput?: ContentExtractionThroughputSignal })
    .content_extraction_throughput;
  if (throughput) {
    row.ingestion_health.content_extraction_throughput = mergeContentExtractionThroughput(
      row.ingestion_health.content_extraction_throughput,
      throughput,
    );
  }
}

function mergeContentExtractionThroughput(
  current: ContentExtractionThroughputSignal | undefined,
  incoming: ContentExtractionThroughputSignal,
): ContentExtractionThroughputSignal {
  if (!current) return incoming;
  const currentActionable = number(current.actionable_queued) + number(current.actionable_retryable_due);
  const incomingActionable = number(incoming.actionable_queued) + number(incoming.actionable_retryable_due);
  const active = [
    ...(currentActionable > 0 ? [current] : []),
    ...(incomingActionable > 0 ? [incoming] : []),
  ];
  const oldestActionableAt = active.length > 0
    && active.every((signal) => validTimestamp(signal.oldest_actionable_at))
    ? earliestValidTimestamp(active.map((signal) => signal.oldest_actionable_at))
    : undefined;
  // Preserve each corpus's paired stall clock before taking the source-level
  // lower bound. Selecting the action and progress minima independently can
  // combine two old timestamps that belonged to different, healthy corpora.
  const effectiveClocks = active.map(effectiveThroughputClock);
  const newestTerminalProgressAt = active.length > 0
    && effectiveClocks.every((value): value is string => value !== undefined)
    ? earliestValidTimestamp(effectiveClocks)
    : undefined;
  return {
    actionable_queued: number(current.actionable_queued) + number(incoming.actionable_queued),
    actionable_retryable_due:
      number(current.actionable_retryable_due) + number(incoming.actionable_retryable_due),
    ...(oldestActionableAt ? { oldest_actionable_at: oldestActionableAt } : {}),
    ...(newestTerminalProgressAt ? { newest_terminal_progress_at: newestTerminalProgressAt } : {}),
  };
}

function earliestValidTimestamp(values: readonly (string | undefined)[]): string | undefined {
  return values
    .filter((value): value is string => validTimestamp(value))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

function validTimestamp(value: string | undefined): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function effectiveThroughputClock(signal: ContentExtractionThroughputSignal): string | undefined {
  const clocks = [signal.oldest_actionable_at, signal.newest_terminal_progress_at]
    .filter((value): value is string => validTimestamp(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return clocks[0];
}

function corpusMetrics(counts: Record<string, number | undefined>): {
  items: number;
  contentIndexed: number;
  metadataOnly: number;
  failed: number;
  queued: number;
  active: number;
  broken: number;
  /** Undefined when this corpus reports no policy-deferred count at all. */
  notReadByPolicy: number | undefined;
  /** Undefined when this corpus reports no policy-disposition vocabulary. */
  metadataOnlyByPolicy: number | undefined;
  /** Undefined when this corpus publishes no eligible denominator of its own. */
  eligibleItems: number | undefined;
} {
  // Read the same way for every corpus, from the same key list the dashboard
  // uses, so a second store growing these verdicts needs no edit here.
  const defined = definedCounts(counts);
  const notReadByPolicy = notReadByPolicyFromCounts(defined);
  const metadataOnlyByPolicy = metadataOnlyByPolicyFromCounts(defined);
  const eligibleItems = answerReadyEligibleFromCounts(defined);
  const items = number(counts.indexed_items ?? counts.messages ?? counts.files ?? counts.items);
  // Per-item readiness keys ONLY, and no chunk fallback behind them.
  //
  // There used to be a `corpusId.includes('dropbox.files')` branch here, and
  // both halves of it fell back to a chunk count when the per-item key was
  // missing. That is not a readiness count: an item yields many chunks, so
  // min(items, chunks) reaches the item count while most of the corpus is still
  // unextracted, and the row's coverage_percent — which the dashboard prefers
  // over its own card arithmetic — read 100% for a corpus a fifth of the way
  // through. A corpus that publishes no per-item count is unknown, and unknown
  // is 0 here: understating asks someone to look at the source, overstating
  // tells them it is finished.
  //
  // Dropping the branch also drops the last source-specific fork in this
  // reader. The extraction-job keys below are absent for a corpus with no
  // extraction lane, which reads as zero exactly as the branch's other half
  // hard-coded.
  const contentIndexed = Math.min(items, number(
    counts.files_with_text ?? counts.items_with_text ?? counts.qa_pass,
  ));
  const failed = number(counts.extraction_jobs_failed_actionable ?? counts.extraction_jobs_failed);
  return {
    items,
    contentIndexed,
    metadataOnly: Math.max(0, items - contentIndexed),
    failed,
    queued: number(counts.extraction_jobs_queued_actionable ?? counts.extraction_jobs_queued),
    active: number(
      counts.extraction_jobs_leased_current_actionable
        ?? counts.extraction_jobs_leased_current
        ?? counts.extraction_jobs_leased,
    ),
    broken: failed,
    notReadByPolicy,
    metadataOnlyByPolicy,
    eligibleItems,
  };
}

/** The same counts with the undefined entries dropped, for the shared reader. */
function definedCounts(counts: Record<string, number | undefined>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
  }
  return output;
}

function applyScheduler(
  rows: Map<string, MutableLedgerRow>,
  unassigned: Map<string, SourceIngestionUnassignedCorpus>,
  assign: LedgerSourceAssignment,
  status: SourceSchedulerStatus | undefined,
  now: Date,
): void {
  if (!status) return;
  for (const source of status.sources) {
    // Corpus first, then the scheduler's own source id against the same
    // declared table. The previous fallback took the first dotted segment of
    // the scheduler source id, which produced keys no row is filed under
    // (`gmail.email` -> `gmail`), so the scheduler's freshness and drain
    // signal for that source was accumulated into a row nothing ever read.
    const sourceId = assign.ledgerSourceIdForCorpus(source.corpus_id)
      ?? assign.ledgerSourceIdForRegistrySourceId(source.source_id);
    if (!sourceId) {
      if (!unassigned.has(source.corpus_id)) {
        const registrySourceId = assign.registrySourceIdForCorpus(source.corpus_id);
        unassigned.set(source.corpus_id, {
          corpus_id: source.corpus_id,
          trust_domain: 'unknown',
          ...(registrySourceId ? { registry_source_id: registrySourceId } : {}),
          configured: true,
          items: 0,
          content_indexed: 0,
        });
      }
      continue;
    }
    const row = rows.get(sourceId) ?? emptyRow(sourceId);
    rows.set(sourceId, row);
    if (!status.enabled || !status.running) {
      row.stuck.held_paused += 1;
      row.attention.push('scheduler paused');
      row.ingestion_health.drain = {
        state: status.enabled ? 'disabled' : 'held',
        unit: 'olympus-source-scheduler',
        hint: 'Run olympus worker status and restart the source scheduler drain.',
      };
    } else if (row.ingestion_health.drain.state === 'unknown') {
      row.ingestion_health.drain = {
        state: 'enabled',
        unit: 'olympus-source-scheduler',
      };
    }
    if (source.stale_sync_anomaly) {
      row.attention.push(`stale sync: ${Math.round(source.freshness_hours ?? source.freshness_threshold_hours)}h since last refresh`);
    }
    if (source.freshness_hours !== undefined) row.freshness_hours = source.freshness_hours;
    for (const task of source.tasks) {
      if (task.running) row.stuck.active += 1;
      const activityAt = latestIso(task.last_success_at, task.last_attempt_at);
      if (activityAt) applyDrainActivity(row, activityAt, now);
      if (task.consecutive_failures > 0) {
        row.stuck.broken += task.consecutive_failures;
        row.attention.push(`${task.id} failing${task.last_error_kind ? `: ${task.last_error_kind}` : ''}`);
      }
      if (task.next_run_at && Date.parse(task.next_run_at) < now.getTime() && !task.running) {
        row.stuck.queued += 1;
      }
    }
  }
}

function applyDropboxBreakdown(
  rows: Map<string, MutableLedgerRow>,
  breakdown: SourceIngestionFailureBreakdown[] | undefined,
  now: Date,
): void {
  if (!breakdown || breakdown.length === 0) return;
  const row = rows.get('dropbox') ?? emptyRow('dropbox');
  rows.set('dropbox', row);
  row.failure_breakdown = breakdown.map((item) => ({
    status: item.status,
    extractor_kind: item.extractor_kind,
    ...(item.error_class ? { error_class: item.error_class } : {}),
    count: item.count,
    ...(item.oldest_created_at ? { oldest_created_at: item.oldest_created_at } : {}),
    ...(item.newest_updated_at ? { newest_updated_at: item.newest_updated_at } : {}),
  }));
  for (const item of breakdown) {
    if (item.newest_updated_at) applyDrainActivity(row, item.newest_updated_at, now);
  }
  const held = breakdown
    .filter((item) => item.status === 'queued' && item.extractor_kind.includes('vlm'))
    .reduce((sum, item) => sum + item.count, 0);
  if (held > 0) {
    row.stuck.held_paused += held;
    row.attention.push(`${held} VLM extraction job(s) queued/paused`);
    row.ingestion_health.drain = {
      ...row.ingestion_health.drain,
      state: 'held',
      unit: 'olympus-source-processing-supervisor-vlm-pdf.timer',
      hold_marker: '~/.local/state/olympus/source-supervisor-holds/vlm-pdf.hold',
      hint: 'Start or unhold olympus-source-processing-supervisor-vlm-pdf.timer so queued VLM extraction jobs drain.',
    };
  }
  const failed = breakdown
    .filter((item) => item.status === 'failed_retryable' || item.status === 'failed_terminal')
    .reduce((sum, item) => sum + item.count, 0);
  if (failed > 0) row.attention.push(`${failed} unreadable extraction job(s) need attention`);
}

function finalizeRow(row: MutableLedgerRow, now: Date): SourceIngestionLedgerRow {
  // The denominator is what this source is meant to READ, not everything it
  // stores: `items` still reports the raw indexed count next to it.
  const coverage = coveragePercent(
    answerReadyEligibleItems(
      row.items,
      row.ingestion_health.not_read_by_policy_items,
      row.ingestion_health.answer_ready_eligible_items,
    ),
    row.content_indexed,
  );
  row.coverage_percent = coverage;
  const stuckWork = stuckWorkHealth(row.failure_breakdown ?? [], row.ingestion_health.stuck_work, now);
  const throughput = row.ingestion_health.content_extraction_throughput;
  const actionableStuckWork = throughput
    ? withActionableThroughput(stuckWork, throughput, now)
    : stuckWork;
  row.ingestion_health = {
    ...row.ingestion_health,
    coverage_percent: coverage,
    stuck_work: actionableStuckWork,
  };
  return {
    ...row,
    corpus_ids: Array.from(row.corpus_ids),
    trust_domains: Array.from(row.trust_domains),
    metadata_only: Math.max(0, row.metadata_only),
    attention: dedupe(row.attention),
    ...(row.failure_breakdown ? { failure_breakdown: row.failure_breakdown } : {}),
  };
}

function withActionableThroughput(
  stuck: SourceIngestionHealth['stuck_work'],
  throughput: ContentExtractionThroughputSignal,
  now: Date,
): SourceIngestionHealth['stuck_work'] {
  const queued = number(throughput.actionable_queued);
  const failedRetryable = number(throughput.actionable_retryable_due);
  const actionable = queued + failedRetryable;
  const oldestItemAt = actionable > 0 ? throughput.oldest_actionable_at : undefined;
  const oldestAge = oldestItemAt ? ageHours(oldestItemAt, now) : undefined;
  return {
    queued,
    failed_retryable: failedRetryable,
    failed_terminal: stuck.failed_terminal,
    ...(oldestItemAt ? { oldest_item_at: oldestItemAt } : {}),
    ...(oldestAge !== undefined ? { oldest_age_hours: oldestAge } : {}),
    by_class: stuck.by_class,
  };
}

function stuckWorkHealth(
  breakdown: SourceIngestionFailureBreakdown[],
  existing: SourceIngestionHealth['stuck_work'],
  now: Date,
): SourceIngestionHealth['stuck_work'] {
  if (breakdown.length === 0) return existing;
  const stuck = breakdown.filter((item) =>
    item.status === 'queued'
    || item.status === 'failed_retryable'
    || item.status === 'failed_terminal'
  );
  const byClass = stuck.map((item) => {
    const oldestAge = item.oldest_created_at ? ageHours(item.oldest_created_at, now) : undefined;
    return {
      status: item.status,
      extractor_kind: item.extractor_kind,
      ...(item.error_class ? { error_class: item.error_class } : {}),
      count: item.count,
      ...(oldestAge !== undefined ? { oldest_age_hours: oldestAge } : {}),
    };
  });
  const oldestItemAt = oldestIso(stuck.map((item) => item.oldest_created_at));
  const oldestAge = oldestItemAt ? ageHours(oldestItemAt, now) : undefined;
  return {
    queued: sumByStatus(stuck, 'queued'),
    failed_retryable: sumByStatus(stuck, 'failed_retryable'),
    failed_terminal: sumByStatus(stuck, 'failed_terminal'),
    ...(oldestItemAt ? { oldest_item_at: oldestItemAt } : {}),
    ...(oldestAge !== undefined ? { oldest_age_hours: oldestAge } : {}),
    by_class: byClass,
  };
}

interface LedgerSourceAssignment {
  /** The source-corpus registry's own `sourceId` for a corpus, if it has one. */
  registrySourceIdForCorpus(corpusId: string): string | undefined;
  /** The ledger row that owns a corpus, or undefined when no row declares it. */
  ledgerSourceIdForCorpus(corpusId: string): string | undefined;
  /** The ledger row that owns a registry source id, or undefined. */
  ledgerSourceIdForRegistrySourceId(registrySourceId: string): string | undefined;
}

/**
 * Row assignment, resolved through the source-corpus registry rather than
 * guessed from the text of the corpus id.
 *
 * This replaced a function that returned a row key only when the corpus id
 * happened to contain a hardcoded provider token, and `undefined` otherwise —
 * and the caller skipped every `undefined`. A corpus whose id names its
 * subject instead of its provider — the path-scoped internal governance band,
 * which is Dropbox-backed — was therefore missing from the row it belongs to,
 * and missing from the snapshot entirely, with nothing anywhere saying so.
 */
function ledgerSourceAssignment(registry: SourceCorpusRegistry | undefined): LedgerSourceAssignment {
  const registrySourceIdByCorpusId = new Map(
    (registry ?? createSourceCorpusRegistry()).list().map((corpus) => [corpus.corpusId, corpus.sourceId]),
  );
  const ledgerSourceIdByRegistrySourceId = new Map<string, string>();
  for (const [ledgerSourceId, definition] of Object.entries(SOURCE_DEFINITIONS)) {
    for (const registrySourceId of definition.corpusSourceIds) {
      ledgerSourceIdByRegistrySourceId.set(registrySourceId, ledgerSourceId);
    }
  }
  const registrySourceIdForCorpus = (corpusId: string): string | undefined =>
    registrySourceIdByCorpusId.get(canonicalSourceCorpusId(corpusId));
  const ledgerSourceIdForRegistrySourceId = (registrySourceId: string): string | undefined =>
    ledgerSourceIdByRegistrySourceId.get(registrySourceId);
  return {
    registrySourceIdForCorpus,
    ledgerSourceIdForRegistrySourceId,
    ledgerSourceIdForCorpus(corpusId) {
      const registrySourceId = registrySourceIdForCorpus(corpusId);
      return registrySourceId === undefined ? undefined : ledgerSourceIdForRegistrySourceId(registrySourceId);
    },
  };
}

function unassignedCorpusEntry(
  corpus: SourceIndexStatusCorpus,
  assign: LedgerSourceAssignment,
): SourceIngestionUnassignedCorpus {
  const counts = (corpus as { counts?: Record<string, number | undefined> }).counts ?? {};
  const metrics = corpusMetrics(counts);
  const registrySourceId = assign.registrySourceIdForCorpus(corpus.corpus_id);
  return {
    corpus_id: corpus.corpus_id,
    trust_domain: corpus.trust_domain,
    ...(registrySourceId ? { registry_source_id: registrySourceId } : {}),
    configured: corpus.configured,
    items: metrics.items,
    content_indexed: metrics.contentIndexed,
  };
}

function summarizeUnassigned(entries: SourceIngestionUnassignedCorpus[]): SourceIngestionUnassignedCorpora {
  return {
    corpus_count: entries.length,
    items: entries.reduce((sum, entry) => sum + entry.items, 0),
    content_indexed: entries.reduce((sum, entry) => sum + entry.content_indexed, 0),
    entries,
  };
}

function summarizeExcludedByConfiguration(
  sources: readonly SourceIngestionLedgerExclusionSource[],
): SourceIngestionExcludedByConfiguration {
  // Keyed by rule id AND prefix. The same rule compiles into a gate for every
  // source it names, so counting each compiled copy would tell the owner they
  // excluded four folders when they wrote one.
  const folders = new Map<string, SourceIngestionExcludedFolder>();
  const unenforceable = new Set<string>();
  let itemsPresent = 0;
  let itemsUnevaluable = 0;
  let metadataOnlyContentPresent = 0;
  for (const source of sources) {
    for (const entry of source.matcher.criteria) {
      folders.set(`${entry.ruleId}\n${entry.prefix}`, {
        rule_id: entry.ruleId,
        prefix: entry.prefix,
        mode: entry.mode,
        kind: entry.kind,
        reason: entry.reason,
      });
    }
    // A blanket rule that some source cannot enforce anything of. It is not an
    // error and it does not stop the lane, but it IS a folder the owner
    // believes is excluded somewhere it is not, so it is named here rather than
    // left to be discovered as a corpus that filled up anyway.
    for (const ruleId of source.matcher.unenforceableRuleIds) unenforceable.add(ruleId);
    itemsPresent += number(source.present?.items);
    itemsUnevaluable += number(source.present?.unevaluable);
    metadataOnlyContentPresent += number(source.metadataOnlyContentPresent?.items);
  }
  const entries = Array.from(folders.values());
  const metadataOnlyEntries = entries.filter((entry) => entry.mode === 'metadata_only');
  // Only sources that said who they are. A row keyed by nothing cannot be
  // matched to a card, so it would be a count with no owner on the page.
  const attributed = sources.filter((source) => source.sourceId !== undefined || (source.corpusIds?.length ?? 0) > 0);
  const bySource = attributed.map(excludedSourceSummary);
  return {
    rules: new Set(entries.map((entry) => entry.rule_id)).size,
    prefixes: entries.length,
    metadata_only_rules: new Set(metadataOnlyEntries.map((entry) => entry.rule_id)).size,
    metadata_only_prefixes: metadataOnlyEntries.length,
    items_metadata_only_content_present: metadataOnlyContentPresent,
    ...(unenforceable.size > 0 ? { unenforceable_rule_ids: [...unenforceable].sort() } : {}),
    items_present: itemsPresent,
    items_unevaluable: itemsUnevaluable,
    entries,
    ...(bySource.length > 0 ? { by_source: bySource } : {}),
  };
}

/** One source's own gate, summarized the same way the global block is. */
function excludedSourceSummary(source: SourceIngestionLedgerExclusionSource): SourceIngestionExcludedBySource {
  const folders = new Map<string, SourceIngestionExcludedFolder>();
  for (const entry of source.matcher.criteria) {
    folders.set(`${entry.ruleId}\n${entry.prefix}`, {
      rule_id: entry.ruleId,
      prefix: entry.prefix,
      mode: entry.mode,
      kind: entry.kind,
      reason: entry.reason,
    });
  }
  const entries = Array.from(folders.values());
  const metadataOnlyEntries = entries.filter((entry) => entry.mode === 'metadata_only');
  const unenforceable = [...new Set(source.matcher.unenforceableRuleIds)].sort();
  return {
    ...(source.sourceId !== undefined ? { source_id: source.sourceId } : {}),
    corpus_ids: [...(source.corpusIds ?? [])],
    rules: new Set(entries.map((entry) => entry.rule_id)).size,
    prefixes: entries.length,
    metadata_only_rules: new Set(metadataOnlyEntries.map((entry) => entry.rule_id)).size,
    metadata_only_prefixes: metadataOnlyEntries.length,
    items_metadata_only_content_present: number(source.metadataOnlyContentPresent?.items),
    items_present: number(source.present?.items),
    items_unevaluable: number(source.present?.unevaluable),
    ...(unenforceable.length > 0 ? { unenforceable_rule_ids: unenforceable } : {}),
    entries,
  };
}

function excludedByConfigurationAttention(
  excluded: SourceIngestionExcludedByConfiguration,
): string[] {
  // Text surfaces read `attention` and not the structured section, so anything
  // that asks the owner to act has to announce itself here too.
  const lines: string[] = [];
  if (excluded.unenforceable_rule_ids?.length) {
    // Not purge debt: a rule that is doing nothing at all for some source.
    // Louder than the structured field alone, because the failure it describes
    // is a folder the owner thinks is excluded and is not.
    lines.push(
      `Excluded by configuration: rule(s) ${excluded.unenforceable_rule_ids.join(', ')} name no source and `
      + 'cannot be enforced by at least one connector; scope them with `sources`, or add `folder_ids` for '
      + 'connectors that identify folders by id rather than by path',
    );
  }
  if (excluded.items_present > 0) {
    lines.push(
      `Excluded by configuration: ${formatNumber(excluded.items_present)} stored item(s) still sit under `
      + `${excluded.prefixes} excluded folder(s) and are still counted above; run the exclusion purge`,
    );
  }
  if (excluded.items_metadata_only_content_present > 0) {
    // A different debt from the one above and it is settled by a different
    // command, so it gets its own line rather than being folded in. These item
    // rows are CORRECT and must survive; only their content is owed.
    lines.push(
      `Metadata-only by configuration: ${formatNumber(excluded.items_metadata_only_content_present)} stored `
      + 'item(s) still carry content their rule refuses; run the metadata-only strip (the item rows stay)',
    );
  }
  return lines;
}

/**
 * "folders" only when every row really is a folder. A media criterion is not a
 * folder, and a heading that counted it as one would misdescribe the owner's
 * configuration back to them in the one place they go to check it.
 */
function criterionNoun(rows: readonly SourceIngestionExcludedFolder[], count: number): string {
  if (rows.some((row) => row.kind === 'media')) return count === 1 ? 'rule criterion' : 'rule criteria';
  return count === 1 ? 'folder' : 'folders';
}

function unassignedAttention(unassigned: SourceIngestionUnassignedCorpora): string[] {
  // Text surfaces (the CLI table, the digest) read `attention` and not the
  // structured section, so the drop has to announce itself there too.
  return unassigned.entries.map((entry) =>
    `Unassigned corpora: ${entry.corpus_id} has no ingestion source row (${entry.items} item(s))`
  );
}

function localConnectorStores(env: Record<string, string | undefined>): Array<ConstructorParameters<typeof LocalConnectorStore>[0]> {
  return mergeConnectorStoreDefinitions([
    ...connectorStoresFromEnv(env.OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON),
    {
      corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
      dbPath: defaultGmailConnectorStoreDbPath(env),
      family: 'email',
      trustDomain: 'internal',
    },
    {
      corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID,
      dbPath: defaultGmailSecureConnectorStoreDbPath(env),
      family: 'email',
      trustDomain: 'secure_local',
    },
    {
      corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
      dbPath: defaultGoogleDriveConnectorStoreDbPath(env),
      family: 'file',
      trustDomain: 'internal',
    },
    {
      corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
      dbPath: defaultGoogleDriveSecureConnectorStoreDbPath(env),
      family: 'file',
      trustDomain: 'secure_local',
    },
    {
      corpusId: DROPBOX_FILES_CORPUS_ID,
      dbPath: defaultDropboxConnectorStoreDbPath(env),
      family: 'file',
      trustDomain: 'secure_local',
    },
    {
      corpusId: 'internal.readwise.library',
      dbPath: defaultReadwiseConnectorStoreDbPath(env),
      family: 'readwise',
      trustDomain: 'internal',
    },
    {
      corpusId: 'internal.x.bookmarks',
      dbPath: defaultXBookmarksConnectorStoreDbPath(env),
      family: 'x',
      trustDomain: 'internal',
    },
    {
      corpusId: 'secure_local.whatsapp.messages',
      dbPath: whatsappConnectorStoreDbPath(env),
      family: 'chat',
      trustDomain: 'secure_local',
    },
    {
      corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
      dbPath: defaultInternalTelegramConnectorStoreDbPath(env),
      family: 'chat',
      trustDomain: 'internal',
    },
    {
      corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
      dbPath: defaultProtectedTelegramConnectorStoreDbPath(env),
      family: 'chat',
      trustDomain: 'secure_local',
    },
  ]);
}

function connectorStoresFromEnv(raw: string | undefined): Array<ConstructorParameters<typeof LocalConnectorStore>[0]> {
  const value = raw?.trim();
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON must be valid JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON must be a JSON array.');
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Each connector store entry must be an object.');
    }
    const record = entry as Record<string, unknown>;
    const dbPath = typeof record.dbPath === 'string' ? record.dbPath.trim() : '';
    const corpusId = typeof record.corpusId === 'string' ? record.corpusId.trim() : '';
    const family = typeof record.family === 'string' ? record.family.trim() : '';
    const trustDomain = typeof record.trustDomain === 'string' ? record.trustDomain.trim() : '';
    if (!dbPath || !corpusId || !family || !trustDomain) {
      throw new Error('Connector store entries require dbPath, corpusId, family, trustDomain.');
    }
    return {
      dbPath,
      corpusId,
      family: family as ConstructorParameters<typeof LocalConnectorStore>[0]['family'],
      trustDomain: trustDomain as ConstructorParameters<typeof LocalConnectorStore>[0]['trustDomain'],
    };
  });
}

function mergeConnectorStoreDefinitions(
  stores: readonly ConstructorParameters<typeof LocalConnectorStore>[0][],
): Array<ConstructorParameters<typeof LocalConnectorStore>[0]> {
  const byCorpusId = new Map<string, ConstructorParameters<typeof LocalConnectorStore>[0]>();
  for (const store of stores) {
    if (!byCorpusId.has(store.corpusId)) byCorpusId.set(store.corpusId, store);
  }
  return Array.from(byCorpusId.values());
}

function whatsappConnectorStoreDbPath(env: Record<string, string | undefined>): string {
  return env.OLYMPUS_SOURCE_INDEX_WHATSAPP_CONNECTOR_STORE_DB_PATH?.trim()
    || env.OLYMPUS_WHATSAPP_CONNECTOR_STORE_DB_PATH?.trim()
    || env.OLYMPUS_WHATSAPP_LIVE_DRAIN_DB_PATH?.trim()
    || join(env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'olympus', 'whatsapp-live', 'connector-store.db');
}

function number(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Content-indexed share of the items passed in, which callers supply already
 * narrowed to what this source is meant to read.
 *
 * An empty set answers 100 — nothing was left unread — and that covers both an
 * unpopulated source and one whose every item is policy-deferred. Neither
 * claims anything is answerable; the row carries `items` and
 * `not_read_by_policy_items` beside the percentage so the reader sees which.
 */
function coveragePercent(items: number, contentIndexed: number): number {
  if (items <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((contentIndexed / items) * 1000) / 10));
}

function freshnessHours(value: string, now: Date): number | undefined {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || Number.isNaN(now.getTime())) return undefined;
  return Math.max(0, Math.round(((now.getTime() - time) / 3_600_000) * 10) / 10);
}

function ageHours(value: string, now: Date): number | undefined {
  return freshnessHours(value, now);
}

function oldestIso(values: Array<string | undefined>): string | undefined {
  const times = values
    .map((value) => value ? { value, time: Date.parse(value) } : undefined)
    .filter((value): value is { value: string; time: number } => !!value && Number.isFinite(value.time))
    .sort((left, right) => left.time - right.time);
  return times[0]?.value;
}

function latestIso(...values: Array<string | undefined>): string | undefined {
  const times = values
    .map((value) => value ? { value, time: Date.parse(value) } : undefined)
    .filter((value): value is { value: string; time: number } => !!value && Number.isFinite(value.time))
    .sort((left, right) => right.time - left.time);
  return times[0]?.value;
}

function applyDrainActivity(row: MutableLedgerRow, value: string, now: Date): void {
  const latest = latestIso(row.ingestion_health.drain.last_activity_at, value);
  if (!latest) return;
  const lastActivityHours = ageHours(latest, now);
  row.ingestion_health.drain = {
    ...row.ingestion_health.drain,
    last_activity_at: latest,
    ...(lastActivityHours !== undefined ? { last_activity_hours: lastActivityHours } : {}),
  };
}

function sumByStatus(rows: SourceIngestionFailureBreakdown[], status: string): number {
  return rows
    .filter((row) => row.status === status)
    .reduce((sum, row) => sum + row.count, 0);
}

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function pad(value: string, length: number): string {
  return value.length >= length ? value : `${value}${' '.repeat(length - value.length)}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function freshnessLabel(row: SourceIngestionLedgerRow): string {
  if (!row.configured) return 'not initialized';
  if (row.freshness_hours === undefined) return 'unknown';
  if (row.freshness_hours < 24) return `${row.freshness_hours}h`;
  return `${Math.round(row.freshness_hours / 24)}d`;
}

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { currentStoreMigrations, runSqliteMigrations } from '../core/sqlite-migrations.ts';
import {
  assessContentExtractionThroughput,
  type ContentExtractionThroughputAssessment,
} from '../core/ingestion-throughput.ts';
import {
  canonicalSourceCorpusId,
  createSourceCorpusRegistry,
  type SourceCorpusRegistry,
} from '../core/source-corpus-registry.ts';
import type { SensitivityMap } from '../core/sensitivity-map.ts';
import type {
  SovereigntyEngine,
  SovereigntyModelProfile,
  SovereigntyProfileProvider,
} from '../core/sovereignty.ts';
import type { ConnectedHandleRegistry, ConnectedCredentialHandle } from './credential-broker/connected-handles.ts';
import { OPERATOR_PAUSED_SCHEDULER_MARKERS } from './dashboard/scheduler-markers.ts';
import {
  ITEMS_WITH_TEXT_COUNT_KEY,
  answerReadyEligibleFromCounts,
  answerReadyEligibleItems,
  answerReadyPercent,
  notReadByPolicyFromCounts,
} from './dashboard/answer-ready-coverage.ts';
// Words only. vocabulary.ts imports nothing from this module at runtime — its
// view-model imports are all `import type` — so the page's one wording source
// is reachable from the builder without a cycle.
import {
  DASHBOARD_NONE_READ_BY_POLICY,
} from './dashboard/vocabulary.ts';
// The phase model's own test for a finished pass, so the sample history and
// the bars can never disagree about what "settled" means. Same no-cycle rule:
// phases.ts imports this module for types only.
import { dashboardHasSettledPass } from './dashboard/phases.ts';
import {
  credentialHealthDegradations,
  credentialHealthReportIsStale,
  type CredentialHealthReport,
  type CredentialHealthResult,
} from './credential-health.ts';
import type { SourceIndexLastRefresh, SourceIndexStatusCorpus, SourceIndexStatusResult } from './source-index/status.ts';
import { ITEMS_EMBEDDED_COUNT_KEY } from './source-index/status.ts';
import type { SourceSchedulerSourceStatus, SourceSchedulerStatus } from './source-scheduler.ts';
import type { WorkerCredentialDegradation } from './credential-degradation.ts';
import type {
  SourceIngestionExcludedByConfiguration,
  SourceIngestionExcludedBySource,
  SourceIngestionLedgerRow,
  SourceIngestionLedgerSnapshot,
} from './source-ingestion-ledger.ts';
import { closeSqliteStore } from '../core/sqlite-store.ts';
import {
  renderPublicSourceCapabilityForDashboard,
  type PublicSourceDashboardCapability,
  type V04PublicSourceId,
} from '../core/public-source-capabilities.ts';

export type DashboardConnectSource = 'google' | 'gmail' | 'google-drive' | 'dropbox' | 'x' | 'venice' | 'readwise';
export type DashboardApiKeySource = 'venice' | 'readwise';
export type DashboardOAuthSource = Exclude<DashboardConnectSource, DashboardApiKeySource>;
export type DashboardSourceConnectKind = 'oauth' | 'api_token' | 'pairing' | 'local';
export type DashboardConnectionState =
  | 'not_connected'
  | 'needs_setup'
  | 'awaiting_consent'
  | 'reauth_required'
  | 'connected'
  | 'waiting_for_first_sync'
  | 'syncing'
  | 'synced';

export type DashboardConnectFieldName = 'client_id' | 'client_secret' | 'api_key';

export interface DashboardConnectField {
  name: DashboardConnectFieldName;
  label: string;
  required: boolean;
  secret: boolean;
}

/**
 * The numbered walkthrough for registering this dashboard's callback URI on the
 * owner's OWN provider app.
 *
 * Every bring-your-own client has to do this, and the card is where they are
 * standing when they find out — so the steps live here rather than behind an
 * agent prompt they have to copy somewhere else (owner ruling, 2026-09-03).
 * Every field is fixed text plus this dashboard's own origin: no provider
 * response, no path on disk, no secret.
 */
export interface DashboardCallbackRegistration {
  /**
   * False when nothing has to be registered from this origin — a Google
   * loopback dashboard, where the callback is accepted as-is. The card then
   * says so and shows no steps.
   */
  required: boolean;
  /** The one sentence shown instead of the steps when `required` is false. */
  skip_note?: string;
  /** Step 1: the exact console page, as a link. */
  console: { label: string; url: string };
  /** Step 2: the app to create or pick, and what it must have on it. */
  app_requirements: string;
  /** Step 3: the setting's exact name in that console. */
  setting_label: string;
  /** Step 3: the exact value. Identical to `redirect_uri_to_register`. */
  redirect_uri: string;
  /** Step 4: what to bring back to this card. */
  finish: string;
}

export interface DashboardSetupStep {
  text: string;
  link?: {
    label: string;
    url: string;
  };
}

export interface DashboardSetupInstructions {
  plain_intro: string;
  agent_prompt: string;
  provider_console_url: string;
  google_cloud_project_id?: string;
  diy_summary: string;
  diy_steps: DashboardSetupStep[];
  secret_shown_once: boolean;
  fields: DashboardConnectField[];
}

export interface SourceDashboardViewModel {
  kind: 'source_dashboard';
  generated_at: string;
  degraded_credentials?: WorkerCredentialDegradation[];
  summary: {
    configured_sources: number;
    connected_sources: number;
    answer_ready_sources: number;
    needs_attention_sources: number;
    total_indexed_items: number;
    total_content_ready_items: number;
  };
  onboarding: {
    steps: DashboardOnboardingStep[];
    ask_first_question: {
      enabled: boolean;
      label: 'Ask your first question';
      suggestion: string;
    };
  };
  google_pilot?: {
    mode: 'shared_pilot' | 'advanced_byo_required';
    verification: 'unverified';
    warning: string;
    advanced_byo_supported: true;
  };
  answer_lanes: DashboardAnswerLaneCard[];
  where_your_data_lives: DashboardTrustDomainCard[];
  unassigned_corpora: DashboardUnassignedCorpora;
  excluded_by_configuration: DashboardExcludedByConfiguration;
  /**
   * The owner's own secure categories, read off the sensitivity map.
   *
   * OMITTED ENTIRELY when no map is configured or the configured one does not
   * parse. Absent means "nothing to say", never "no categories": a page that
   * rendered an empty category list for an unreadable file would be asserting
   * the owner protects nothing.
   */
  sensitivity?: DashboardSensitivity;
  /**
   * What each tier permits, hardcoded from the enforcement code rather than
   * measured. Always emitted; optional in the type only because hand-written
   * view fixtures predate it.
   */
  sensitivity_tiers?: DashboardSensitivityTiers;
  folder_picker: DashboardFolderPicker;
  sources: DashboardSourceCard[];
  history: {
    sample_count: number;
    eta_available: boolean;
  };
  // `first_run` says no source is connected yet. Derived here rather than
  // left to each reader because `configured_sources` is the card roster, not
  // a connection count, and reading it as one shows a full page of sources on
  // a fresh install.
  //
  // Both are optional in the type and always emitted by
  // buildSourceDashboardViewModel; hand-written view fixtures predate them.
  first_run?: boolean;
  background_work?: DashboardBackgroundWork;
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    file_names_returned: false;
    file_paths_returned: false;
    host_names_returned: false;
  };
}

/**
 * Work the owner did not ask for and cannot see finishing: chunks waiting to
 * be embedded, and content-extraction jobs parked on the VLM extractor.
 *
 * Every member is optional and absent means unknown, never zero. The embedding
 * counts arrive only from corpora whose status carries `embedding_parity`, and
 * the VLM count only from an ingestion ledger that carries a failure
 * breakdown; a page that renders `0` for a source that never reported is
 * asserting the queue is empty.
 */
export interface DashboardBackgroundWork {
  embedding_backlog?: DashboardEmbeddingBacklog;
  embedding_lane_state?: 'enabled' | 'embedding_lane_disabled';
  vlm_extraction_queued?: number;
}

/** Chunk-level embedding parity. `chunks` is always > 0, so it is a safe denominator. */
export interface DashboardPhaseMovement {
  /** ISO time the metadata-sync counter (indexed items) was last seen lower than now. */
  metadata_sync_at?: string;
  /** ISO time the extraction counter (items with text) was last seen lower than now. */
  extraction_at?: string;
  /** ISO time the embedding counter (files embedded on the current model) was last seen lower than now. */
  embedding_at?: string;
  /**
   * What the extraction counter was worth at the last moment extraction was
   * COMPLETE on a settled pass — the size of the corpus the batch in flight
   * arrived on top of (owner decision, 2026-09-02).
   *
   * It is the only thing that makes "7 of 12 new files" sayable: subtract it
   * from the phase's own two numbers and both halves are the current pass.
   * Absent means no such moment has been observed — a corpus still on its
   * first crawl, a ledger written before the baseline existed, or a counter
   * that has since fallen below its baseline — and the phase then falls back
   * to stating what is left without a share.
   */
  extraction_settled_value?: number;
  /** The same baseline for the embedding counter. Recorded only while extraction is also complete. */
  embedding_settled_value?: number;
  /**
   * The first time this dashboard ever recorded a sample for this corpus, and
   * never rewritten afterwards.
   *
   * The only durable clock a source with no broker handle has. Telegram and
   * WhatsApp pair as sessions and own no credential grant, so their card
   * carries no `connected_at`; without this, "has never run" had no age and a
   * dead pairing could read "waiting for the first sync" indefinitely.
   */
  first_seen_at?: string;
}

export interface DashboardEmbeddingBacklog {
  chunks: number;
  embedded_chunks: number;
  missing_chunks: number;
  refresh_needed: boolean;
}

/**
 * The most recent refresh the source index recorded for this card. One run,
 * not a series: no run history exists anywhere upstream of this page.
 */
export interface DashboardSourceRun {
  status: string;
  started_at?: string;
  completed_at?: string;
  duration_seconds?: number;
  items_seen: number;
  items_indexed: number;
}

/**
 * The scheduler's view of this card's tasks. `last_error_kind` is a
 * classification token such as `provider_rate_limited`, never provider text —
 * no error message reaches this page.
 */
export interface DashboardSourceSchedule {
  running: boolean;
  /** Summed across this card's tasks, the way the ingestion ledger counts broken work. */
  consecutive_failures: number;
  last_success_at?: string;
  last_attempt_at?: string;
  next_run_at?: string;
  last_error_kind?: string;
  degraded_reason?: string;
}

export interface DashboardOnboardingStep {
  id:
    | 'security_preset' | 'dependencies' | 'credential_or_pairing' | 'scope' | 'initial_sync' | 'source_health' | 'cited_answer_readiness'
    // Read-fixture compatibility only. The builder emits the seven ids above.
    | 'connect_sources' | 'first_sync' | 'choose_folders' | 'where_data_lives' | 'ask_first_question';
  label: string;
  state: 'complete' | 'active' | 'pending';
  next_action?: string;
}

/**
 * The way into the folder-disposition picker, which is a SEPARATE page.
 *
 * Separate because this page's own header promises no file names and no paths,
 * and a folder picker is made of folder names. So this block carries no path
 * of its own — only whether the picker is configured and where it lives — and
 * the picker is opened by an authorized fetch rather than a link, because its
 * route deliberately does not accept the read-only dash_ URL token.
 */
export interface DashboardFolderPicker {
  available: boolean;
  label: string;
  path: '/dashboard/dispositions';
  /** How many rules the owner has written today, from the ingestion ledger. */
  rules: number;
}

export interface DashboardTrustDomainCard {
  trust_domain: string;
  label: string;
  source_count: number;
  indexed_items: number;
  content_ready_items: number;
  model_lanes: string[];
  // 'explicit_order' means the operator owns the try-this-first order and the
  // list may be read as a fallback chain. 'health_latency' means the pool
  // members are equals and dispatch picks from recent health/latency, so no
  // ordering may be asserted. Mirrors SovereigntyAnalystRoutePlan.selection.
  model_lane_selection: 'explicit_order' | 'health_latency';
}

/**
 * Corpora the source index reports that no card on this page owns. They are
 * still the owner's data sitting in the local store, so they are counted in
 * the summary tiles and in "Where your data lives", and listed here by id.
 * Dropping them silently is what this section exists to prevent.
 */
export interface DashboardUnassignedCorpora {
  corpus_count: number;
  indexed_items: number;
  content_ready_items: number;
  entries: DashboardUnassignedCorpus[];
}

export interface DashboardUnassignedCorpus {
  corpus_id: string;
  trust_domain: string;
  label: string;
  indexed_items: number;
  content_ready_items: number;
}

/**
 * Folders the owner's configuration keeps out of ingestion, read off the
 * ingestion ledger.
 *
 * The mirror image of the section above it. `unassigned_corpora` exists to say
 * "these items ARE in the counts"; this one exists to say the excluded folders
 * are never ingested, so their contents are deliberately absent — the one kind
 * of omission that is correct. `items_present` is the exception that keeps the
 * page honest: items indexed before the rule existed, still stored and still
 * counted, until a purge runs.
 *
 * No prefix field, on purpose — see renderExcludedByConfiguration. The whole
 * view model is serialized into the page, so a path in this type is a path on
 * the page.
 */
export interface DashboardExcludedByConfiguration {
  rules: number;
  prefixes: number;
  items_present: number;
  items_unevaluable: number;
  entries: DashboardExcludedRule[];
  /**
   * Of `rules`/`prefixes`, the ones the owner marked metadata-only: indexed,
   * never read. Separate from the excluded counts because "8 folders excluded"
   * when six of them are still searchable by title is a false statement.
   *
   * Optional in the type and always emitted by the builder; hand-written view
   * fixtures predate them.
   */
  metadata_only_rules?: number;
  metadata_only_prefixes?: number;
  /**
   * Strip debt: stored items still carrying content a metadata-only rule
   * refuses. The metadata-only sibling of `items_present`, settled by a
   * different command, and the item rows themselves are correct.
   */
  items_metadata_only_content_present?: number;
  /**
   * Blanket rules at least one source can enforce nothing of — a folder the
   * owner believes is excluded somewhere it is not. Present only when
   * non-empty, so an always-present empty array does not train readers to skip
   * the field.
   */
  unenforceable_rule_ids?: string[];
  /**
   * The same section split by the source whose gate produced it, so a source
   * detail page can show that source's scope.
   *
   * Present only when the ledger carried attribution. Match these to a card by
   * CORPUS ID, never by `source_id`: the exclusion ids ('dropbox.personal'),
   * the ledger row ids ('dropbox') and the card ids ('dropbox.files') are three
   * different id spaces. A corpus that matches no card belongs to no card and
   * stays in the global section.
   */
  by_source?: DashboardExcludedSource[];
}

export interface DashboardExcludedRule {
  rule_id: string;
  prefixes: number;
  /**
   * `exclude` / `metadata_only`, deduplicated. A rule can carry both when its
   * criteria differ, so this is a list rather than one value.
   */
  modes?: readonly string[];
  /** `path_prefix` / `folder_id` / `media`. A media criterion is not a folder. */
  kinds?: readonly string[];
}

/** One source's slice of the exclusion section. Same fields, same meanings. */
export interface DashboardExcludedSource {
  corpus_ids: readonly string[];
  source_id?: string;
  rules: number;
  prefixes: number;
  metadata_only_prefixes: number;
  items_present: number;
  items_unevaluable: number;
  items_metadata_only_content_present: number;
  unenforceable_rule_ids?: readonly string[];
  entries: readonly DashboardExcludedRule[];
}

/**
 * The owner's secure categories, as configured.
 *
 * `editable` is false and stays false until a write route exists: no route in
 * this worker writes the sensitivity map, so a page offering an add or remove
 * control would offer a button that cannot work.
 *
 * The categories' MATCH TERMS never cross this boundary — only how many there
 * are. Keywords, sender patterns and path patterns are the owner's real email
 * addresses and folder paths, `notes` is free text that routinely contains
 * them, and this view model is reachable with the weak `dash_` query token
 * while its own policy block declares no paths and no file names are returned.
 */
export interface DashboardSensitivity {
  /** Always true where this block exists at all; absent is how "not configured" is said. */
  configured: boolean;
  /** Always false: no route in this worker writes the sensitivity map. */
  editable: boolean;
  categories: DashboardSensitivityCategory[];
}

export interface DashboardSensitivityCategory {
  id: string;
  label: string;
  /** The owner's own examples, joined. Always at least one — the parser requires it. */
  interpretation: string;
  /** Only ever `secure` or `secrets`: the map is raise-only and refuses the rest. */
  target_tier_name: string;
  target_trust_tier: string;
  target_trust_domain: string;
  /** How many keywords, sender patterns and path patterns match this category. A count, never the terms. */
  match_terms: number;
}

/**
 * What each tier PERMITS, taken from the code that enforces it.
 *
 * These are ceilings, not availability. A `venice: true` says the policy allows
 * Venice for that tier, not that a Venice profile is configured or reachable —
 * `answer_lanes` stays the only statement about whether a lane is connected.
 */
export interface DashboardSensitivityTiers {
  policy_basis: 'enforced';
  tiers: DashboardSensitivityTier[];
}

export interface DashboardSensitivityTier {
  name: string;
  tier_label: string;
  meaning: string;
  local: boolean;
  venice: boolean;
  frontier: boolean;
}

export interface DashboardAnswerLaneCard {
  lane_id: string;
  source_id: string;
  label: string;
  role: string;
  connection: {
    state: 'validated' | 'missing';
    label: string;
    action: DashboardSourceAction;
    handles: string[];
  };
}

export interface DashboardDisconnectAction {
  source_id: V04PublicSourceId;
  label: string;
  confirmation: string;
  provider_revocation_url: string;
}

/**
 * Disconnect's twin for a source paired as a session rather than granted
 * through the credential broker.
 *
 * Telegram and WhatsApp own no broker credential, so the Disconnect control —
 * which is attached off the handle registry — never appeared on their rows and
 * a reader who wanted to end the pairing had nothing to press (owner decision,
 * 2026-09-02). Unpair removes this computer's pairing session and stops the
 * lane. It is local-only: the device stays linked at the provider until the
 * reader removes it there, which is what `provider_unlink_url` names.
 */
/**
 * One source's unpair outcome, as the caller that performed it recorded it.
 *
 * Deliberately carries NO filesystem paths. This view model is served to the
 * read-only `dash_` token through /dashboard.json, and that surface promises no
 * file paths; the absolute paths of a half-removed session belong only in the
 * CSRF-authorized POST response the person who pressed the button is reading.
 * Whether cleanup is outstanding is all the card needs to say.
 */
export interface DashboardUnpairedSourceState {
  source_id: string;
  /**
   * `unpair_state_unreadable` is not a claim that the source is unpaired; it is
   * the honest "cannot tell". The durable record failing to parse used to read
   * as an empty record — indistinguishable from "nothing was ever unpaired" —
   * which handed the card back to its sync evidence after a restart.
   */
  state: 'unpaired' | 'unpair_incomplete' | 'unpair_state_unreadable';
}

export interface DashboardUnpairAction {
  source_id: V04PublicSourceId;
  label: string;
  confirmation: string;
  provider_unlink_url: string;
  /** What the provider calls that screen, e.g. "WhatsApp linked devices". */
  provider_unlink_label: string;
}

export interface DashboardSourceCard {
  corpus_id: string;
  source_id: string;
  label: string;
  provider: string;
  family: string;
  trust_domain: string;
  /** Shared seven-source capability metadata; always emitted by the builder. */
  capabilities?: PublicSourceDashboardCapability;
  setup?: DashboardSourceSetupStatus;
  configured: boolean;
  freshness: {
    label: string;
    hours?: number;
    threshold_hours?: number;
    stale: boolean;
  };
  coverage: {
    indexed_items: number;
    content_ready_items: number;
    embedded_items: number;
    /**
     * Items whose every chunk is embedded on the current model — the embedding
     * bar's numerator, in the same unit extraction counts in (owner ruling,
     * 2026-09-01: embedding is measured in files, never chunks, so the bar can
     * never run ahead of extraction). Absent when the store publishes no
     * per-item parity count; the bar then says the share is not measured.
     */
    embedded_files?: number;
    needs_review_items: number;
    /**
     * Indexed items the system is never asked to read — media, books and shelf
     * items on the deferred-by-policy verdict, plus privacy-fenced content —
     * which `ingestion_health.coverage_percent` leaves out of its denominator
     * (owner ruling, 2026-08-21; the arithmetic lives in
     * dashboard/answer-ready-coverage.ts).
     *
     * Absent rather than zero for a corpus that reports no such count, so a
     * source the rule never touched publishes exactly the keys it always did.
     * Never operator work: it is stated so a 100% cannot quietly stand for a
     * corpus most of which was never read, not to ask anyone for anything.
     */
    not_read_by_policy_items?: number;
    /**
     * The corpus's OWN count of the items it is asked to make answerable, when
     * it publishes one, used verbatim as `coverage_percent`'s denominator.
     *
     * Present only where `indexed_items` and the readiness counts come from
     * different populations — a connector store reports what it has drained
     * while the family's extraction evidence still scores everything upstream
     * of it — so `indexed_items - not_read_by_policy_items` would be a
     * subtraction across two different totals. Absent everywhere else, and the
     * subtraction remains the answer.
     */
    answer_ready_eligible_items?: number;
  };
  /** File populations the user deliberately added to Olympus. Excluded files are omitted. */
  ingestion_selection?: {
    metadata_only_files: number;
    full_ingestion_files: number;
  };
  /** The only ingestion phase currently proven to be doing work. */
  active_ingestion_phase?: 'metadata_sync' | 'extraction' | 'embedding';
  /**
   * `coverage.needs_review_items` split into the reasons it was summed from.
   *
   * `total` is that same number, never a recount, so the card and this section
   * can never disagree. `reasons` carries only the non-zero ones, and is EMPTY
   * when the total cannot be attributed — see needsReview(). There is no item
   * list and nothing to open: the only item-level review data in the system
   * carries file names and paths, and no route lists review items.
   *
   * Optional in the type and always emitted by the builder; hand-written view
   * fixtures predate it.
   */
  needs_review?: DashboardNeedsReview;
  ingestion_health: {
    coverage_percent: number;
    stuck_count: number;
    oldest_stuck_age_hours?: number;
    last_drain_activity_hours?: number;
    drain_state: 'enabled' | 'disabled' | 'held' | 'unknown';
    drain_unit?: string;
    label: string;
  };
  tier_composition: Array<{
    trust_domain: string;
    label: string;
    indexed_items: number;
    content_ready_items: number;
  }>;
  queue_health: {
    label: string;
    waiting: number;
    active: number;
    /** Items needing attention. Never a retry counter — see retrying_tasks. */
    needs_attention: number;
    /** Scheduler tasks currently in a retry loop, not how many times they retried. */
    retrying_tasks?: number;
  };
  answer_readiness: {
    state: 'ready' | 'syncing' | 'needs_attention' | 'empty' | 'disconnected';
    label: string;
  };
  connection: {
    state: DashboardConnectionState;
    label: string;
    action: DashboardSourceAction;
    handles: string[];
    /**
     * When the credential this card connects through was granted, from the
     * handle registry. The clock a phase needs to tell "connected a minute ago
     * and the first sync has not started" from "connected and never syncing":
     * without it a source that has never run reads as stalled the instant it is
     * connected. Absent for a family that owns no broker handle (the paired
     * chat sources) and for a card that is not connected at all.
     */
    connected_at?: string;
    /** Present only for a locally connected broker-backed v0.4 source. */
    disconnect?: DashboardDisconnectAction;
    /** Present only for a paired-session source that currently reads paired. */
    unpair?: DashboardUnpairAction;
    missing_config_key?: string;
    pending?: {
      started_at: string;
      expires_at: string;
      expires_in_minutes: number;
    };
    /**
     * What the provider said when it refused the last consent attempt.
     *
     * Bounded text only: an allowlisted OAuth code plus this page's own
     * sentence and the dashboard's own callback URI. No provider prose ever
     * reaches it, and it carries no path and no secret.
     */
    provider_refusal?: {
      code: string;
      /**
       * NOT named `message`: the email-policy guard forbids that key anywhere
       * in a served view model, and this page is served through it.
       */
      reason: string;
    };
  };
  progress?: {
    indexed_items_per_hour: number;
    eta_minutes?: number;
  };
  /**
   * When each phase's own counter last rose, from the dashboard's sample
   * history. What the page needs to say "working" or "stalled" about one row
   * rather than the whole source: a phase whose count has risen recently is
   * moving whatever the others are doing. Absent means the history holds no
   * rise for that counter inside its retention window, or no history exists.
   */
  movement?: DashboardPhaseMovement;
  last_run?: DashboardSourceRun;
  /** Absolute last sync, from the ingestion ledger. `freshness` carries only relative prose. */
  last_sync_at?: string;
  schedule?: DashboardSourceSchedule;
  embedding_backlog?: DashboardEmbeddingBacklog;
  /**
   * False when no corpus on this card is served from embeddings (keyword-only
   * activation), so the embedding row can say the stage does not apply
   * instead of counting toward a total it will never reach. Absent when no
   * corpus published parity at all.
   */
  embedding_required?: boolean;
  /**
   * Present only when a corpus of this card explicitly reports the embedding
   * lane disabled. Absent means unknown — a parity gap alone never implies the
   * lane was paused.
   */
  embedding_lane_state?: 'embedding_lane_disabled';
  /** Queued VLM extraction jobs for this source. Absent means unreported, not empty. */
  vlm_extraction_queued?: number;
  /** Reasons the ingestion ledger already wrote for this source, verbatim. */
  attention_reasons?: string[];
  /**
   * The metadata-sync phase's own folder-walk evidence, when the corpus
   * publishes it (`metadata_sync_folders_*`).
   *
   * The sync bar needs a denominator in the walk's OWN unit, and folders are
   * that unit for a source whose provider is walked as a tree. Absent means the
   * corpus reports no walk at all, which is what makes the sync bar fall back
   * to counting discovered items instead of faking a folder ratio.
   */
  metadata_sync?: DashboardMetadataSync;
  /**
   * True when the provider hands over item text, so no separate extraction pass
   * reads it — declared on the source definition, never sniffed from the id.
   *
   * It is a DISPLAY declaration and nothing more: the extraction bar is dropped
   * for such a source only while its own counts agree that nothing is waiting to
   * be read. A source declared pre-extracted whose read count falls behind its
   * in-scope count still shows the bar, because the numbers outrank the
   * declaration and hidden work is the one outcome this must not produce.
   */
  content_arrives_extracted?: boolean;
  /**
   * False when this worker cannot run Sync now for this source, so nothing on
   * the page offers the control or advises pressing it.
   *
   * Absent means the caller declared nothing, which keeps the control offered:
   * a hand-written fixture and an older payload must not lose a button.
   */
  sync_now_available?: boolean;
}

export interface DashboardSourceSetupStatus {
  stage: 'dependency_check' | 'credential_or_pairing' | 'scope' | 'initial_sync' | 'source_health' | 'cited_answer_readiness';
  condition: 'usable' | 'degraded' | 'blocked';
  next_action: string;
  dependencies: Array<{
    id: string;
    label: string;
    status: 'ready' | 'check_required';
    next_action: string;
  }>;
}

/**
 * One walk of a provider's folder tree, as the metadata-sync phase measures it.
 *
 * `folders_total` is the walk's own denominator and `folders_visited` its
 * numerator, so a re-walk restates both rather than inheriting a settled
 * corpus's history. A total of 0 with a walk in flight is the honest "not known
 * yet" the indeterminate bar exists for — never a 0/0 rendered as complete.
 */
export interface DashboardMetadataSync {
  folders_total: number;
  folders_visited: number;
  folders_pending: number;
  /** Folders the walk could not read and has stopped retrying. */
  folders_failed: number;
  /** Folders the provider itself refuses to hand over. */
  folders_blocked: number;
}

export interface DashboardNeedsReview {
  total: number;
  /**
   * The two halves of `total`, so the section header can say which part is
   * anyone's homework. They sum to `total` exactly when the breakdown is
   * attributable, and are both 0 when it is not — the same condition that
   * empties `reasons`, because a split nothing measured is the defect this
   * whole section exists to avoid.
   */
  automatic_total: number;
  operator_total: number;
  /** Non-zero reasons only, in the order this module declares them. */
  reasons: readonly DashboardNeedsReviewReason[];
}

export interface DashboardNeedsReviewReason {
  key: string;
  label: string;
  count: number;
  who_acts: DashboardNeedsReviewActor;
  /** Plain-language clause for the chip: what happens next about these. */
  actor_note: string;
}

export type DashboardSourceAction =
  | {
    kind: 'oauth';
    source: DashboardOAuthSource;
    label: 'Connect' | 'Reauthenticate';
    /**
     * True when this source connects through Olympus's own registered OAuth
     * app: the card offers one Connect button and no fields, and the
     * bring-your-own walkthrough below moves into a disclosure. The publisher
     * client id itself is NOT carried here — the card never needs it, and the
     * fewer public identifiers on the read-only surface the better.
     */
    publisher_client?: true;
    known_client_id?: string;
    /**
     * The exact callback URI this dashboard sends the provider, for the owner
     * to register on their own app. Public information — the dashboard's own
     * origin plus a fixed path — and the one fact whose absence made every
     * provider refuse the owner's reauthorization (live, 2026-09-03).
     */
    redirect_uri_to_register?: string;
    /** One provider-specific line about where that URI goes, or that it need not. */
    redirect_uri_guidance?: string;
    /** The numbered walkthrough the card renders above its fields. */
    callback_registration?: DashboardCallbackRegistration;
    /**
     * Present so the row can open the same setup sheet a never-registered
     * source gets: the redirect URI, and the Client ID prefilled and EDITABLE.
     * A wrong client id used to be unchangeable from the page — the only
     * control was a button that started the identical failing attempt again.
     */
    instructions?: DashboardSetupInstructions;
    /**
     * True while an attempt for this source is still pending. The sheet then
     * also offers Cancel, because a new Connect replaces the pending attempt
     * and there was otherwise no way to abandon one before its expiry.
     */
    pending_attempt?: true;
  }
  | {
    kind: 'needs_setup';
    source: DashboardOAuthSource;
    client_secret_required: boolean;
    redirect_uri_to_register?: string;
    redirect_uri_guidance?: string;
    callback_registration?: DashboardCallbackRegistration;
    instructions: DashboardSetupInstructions;
    // The verb, not the deficit: this row is an option the owner may take, and
    // the app-key reality it involves lives in the blurb rather than in the
    // button. Owner ruling, 2026-08-18 review.
    label: 'Set up';
  }
  | {
    kind: 'api_key';
    source: DashboardApiKeySource;
    label: 'Connect' | 'Reauthenticate';
    instructions: DashboardSetupInstructions;
  }
  | {
    kind: 'guided_session';
    source: 'telegram' | 'whatsapp';
    // Three words, not two: a chat source has no readable session surface, so
    // a card connected on sync evidence alone must not claim the session is
    // ready. See guidedSessionLabel.
    label: 'Pairing required' | 'Session ready' | 'Session state not surfaced';
    instructions: string[];
  }
  | {
    kind: 'none';
  };

/**
 * Copyable, code-free handoff for the two pairing flows the dashboard cannot
 * execute itself. The prompt names only supported Olympus actions and never
 * asks the user to edit files, configuration, or source code.
 */
export function dashboardGuidedSessionAgentPrompt(source: 'telegram' | 'whatsapp'): string {
  if (source === 'telegram') {
    return 'Connect Telegram to Olympus using the supported pairing flow. Tell me when the local pairing prompt needs my phone number, login code, or two-factor password so I can enter it there myself. Never ask me to paste a login code or password into this conversation, and never repeat one back. Then help me choose the chats Olympus may read and start the initial sync. Do not ask me to edit files, configuration, or code.';
  }
  return 'Connect WhatsApp to Olympus using the supported QR pairing flow. Show me when to scan the QR code from WhatsApp Linked devices, confirm the connection, and start the initial sync. Do not ask me to edit files, configuration, or code.';
}

export interface SourceDashboardHistory {
  record(samples: SourceDashboardHistorySample[]): void;
  progressFor(sample: SourceDashboardHistorySample, now: Date): DashboardSourceCard['progress'];
  /** Per-phase last-rise times for this sample's corpus; optional so older fakes keep compiling. */
  movementFor?(sample: SourceDashboardHistorySample, now: Date): DashboardPhaseMovement | undefined;
  sampleCount(): number;
}

export interface SourceDashboardHistorySample {
  source_id: string;
  corpus_id: string;
  sampled_at: string;
  indexed_items: number;
  content_ready_items: number;
  /** Files embedded on the current model; absent when the store does not measure it. */
  embedded_files?: number;
  queue_waiting: number;
  queue_active: number;
  queue_attention: number;
  /**
   * Items this card is asked to make answerable — the one denominator the
   * extraction and embedding phases divide by, already carrying the card's own
   * policy exits. Absent where the card can defend no denominator, and the
   * ledger then records no baseline rather than guessing one.
   */
  in_scope_items?: number;
  /**
   * Whether this card had finished at least one full pass when the sample was
   * taken. A phase reaching parity mid-crawl is not a settled corpus, so the
   * baseline that separates "the first crawl is nearly done" from "a settled
   * corpus has 12 new files" may only be written when this is true.
   */
  settled_pass?: boolean;
}

export interface SourceDashboardBuildOptions {
  sourceIndexStatus: SourceIndexStatusResult;
  ingestionLedger?: SourceIngestionLedgerSnapshot;
  schedulerStatus?: SourceSchedulerStatus;
  sovereigntyEngine: SovereigntyEngine;
  history?: SourceDashboardHistory;
  // Authority on which dashboard card owns which corpus. Defaults to the
  // shipped registry so every caller gets the same answer; pass the operator's
  // configured registry when one exists.
  sourceCorpusRegistry?: SourceCorpusRegistry;
  connectedHandleRegistry?: ConnectedHandleRegistry;
  /**
   * Whether `connectedHandleRegistry` is an empty stand-in for a registry the
   * caller could not read, rather than a registry that is genuinely empty.
   *
   * The two look identical here and mean opposite things to a reader: one says
   * "nothing is connected", the other says "I could not tell". Declared by the
   * caller that owns the file read, so a card can say which one it is instead
   * of reporting an unreadable file as a disconnected source.
   */
  connectedHandleRegistryUnreadable?: boolean;
  /**
   * Paired-session sources this worker has itself unpaired, and whether the
   * removal finished.
   *
   * A chat card derives connectedness from its own sync evidence, because
   * neither chat source owns a broker handle to read (see
   * sessionConnectionEvidence). That inference is right until the pairing is
   * removed here: the indexed history and its timestamps do not change, so the
   * card would keep reading connected over a session that no longer exists.
   * This is the explicit local fact that outranks the inference, declared by
   * the caller that performed the removal.
   *
   * `unpair_incomplete` carries the artifacts still on disk. Only the owner can
   * finish that job, so the card names them rather than reporting the plain
   * unpaired state over a session file that is still there.
   */
  unpairedSources?: readonly DashboardUnpairedSourceState[];
  credentialHealth?: CredentialHealthReport;
  oauthClientIds?: Partial<Record<DashboardOAuthSource | 'google', string>>;
  oauthClientSecretAvailability?: Partial<Record<DashboardOAuthSource | 'google', boolean>>;
  googleCloudProjectId?: string;
  googlePilotClientConfigured?: boolean;
  /**
   * The OAuth sources this install connects through Olympus's OWN registered
   * app, so their card needs no client id and no provider walkthrough. Names
   * sources only: no client id, no relay URL, no state — this rides on the
   * read-only surface with everything else here.
   */
  publisherOAuthSources?: readonly DashboardOAuthSource[];
  oauthRedirectBaseUrl?: string;
  apiKeyAvailability?: Partial<Record<DashboardApiKeySource, boolean>>;
  pendingConnects?: DashboardPendingConnect[];
  now?: Date;
  contentExtractionStallThresholdHours?: number;
  /**
   * Whether this worker serves the folder-disposition picker. Declared by the
   * caller that wires it, so the page offers a button that leads somewhere
   * rather than one that 501s.
   */
  ingestionDispositionsAvailable?: boolean;
  /**
   * Whether this worker can actually run Sync now for a given source.
   *
   * Declared by the caller that owns the dispatch chain, for the same reason
   * `ingestionDispositionsAvailable` is: the view model cannot see whether a
   * scheduler lane or a host sync hook exists, and a card that advertises the
   * control anyway sends the reader to a 501 (owner, 2026-09-04: "Private
   * source worker does not support Sync now for google-drive"). Absent means
   * unknown, and unknown keeps today's behaviour of offering the control.
   */
  syncNowAvailable?: (source: DashboardConnectSource) => boolean;
  /**
   * The owner's sensitivity map, already loaded and parsed by the caller.
   *
   * Read-only and optional: this page never opens a file of its own, so the map
   * arrives the same way the ledger snapshot does. Absent means no map is
   * configured or the configured one did not parse, and the `sensitivity`
   * section is then omitted rather than emitted empty.
   */
  sensitivityMap?: SensitivityMap;
}

export interface DashboardPendingConnect {
  source: DashboardOAuthSource;
  started_at: string;
  expires_at: string;
  /**
   * Set when the provider's own callback came back carrying `error=`.
   *
   * The attempt is KEPT rather than deleted so the card can say what the
   * provider refused instead of sitting in "connecting" until the record
   * expires. It still expires exactly as before.
   */
  error?: DashboardPendingConnectError;
}

export interface DashboardPendingConnectError {
  /** An allowlisted OAuth error code. Never raw provider text. */
  code: string;
  /** When the refusal reached the callback route. */
  at: string;
}

const DASHBOARD_SQLITE_STORE_ID = 'source-dashboard';

// Shortest interval a throughput rate may be derived from.
const MIN_PROGRESS_WINDOW_MS = 5 * 60_000;

// Retention for source_dashboard_samples. One row per source definition is
// written on every view-model build, and the browser rebuilds the view every
// 5 seconds for as long as the page is open, so without these bounds the table
// grows forever and the COUNT(*) in sampleCount gets slower with it. The cap
// holds an hour of history at the 5s poll rate, well over the window
// progressFor needs.
const SAMPLE_RETENTION_MS = 24 * 60 * 60_000;
const MAX_SAMPLES_PER_CORPUS = 720;

export interface DashboardSupportedSourceDefinition {
  source_id: string;
  primary_corpus_id: string;
  // Every source-corpus-registry `sourceId` whose corpora belong on this card.
  // Declared, not sniffed: matching used to substring-scan corpus ids for a
  // provider token, which silently dropped every corpus that carried no token
  // — including the path-scoped governance band of the owner's own Dropbox,
  // which is cloud-answerable. Usually one entry equal to source_id; more when
  // the registry and this page disagree, which the corpus-claim test pins.
  corpus_source_ids: readonly string[];
  // Key this card's row is filed under in the ingestion ledger. The ledger
  // keys rows by its own short source id, which is NOT always the provider —
  // WhatsApp is `whatsapp` there and `whatsapp_personal` here.
  ingestion_ledger_source_id: string;
  label: string;
  provider: string;
  family: string;
  trust_domain: string;
  connect_kind: DashboardSourceConnectKind;
  answer_capable_without_sync?: boolean;
  /**
   * True when this provider hands over the item's text with the item, so the
   * extraction phase has no separate pass to run.
   *
   * Declared per capability, not per source name: a chat transcript, a bookmark
   * and a highlight all arrive AS text, while a file and a mail attachment are
   * bytes something has to read. The renderer branches on this one flag and on
   * the card's own counts — never on the provider — and the counts win, so a
   * declaration that turns out to be wrong shows the bar rather than hiding it.
   */
  content_arrives_extracted?: boolean;
  connect_action:
    | { kind: 'oauth'; source: DashboardOAuthSource }
    | { kind: 'api_key'; source: DashboardApiKeySource }
    | { kind: 'guided_session'; source: 'telegram' | 'whatsapp'; instructions: string[] };
}

/**
 * The per-corpus count keys `coverage.needs_review_items` is summed from, each
 * with the id and the plain-language name this page publishes for it.
 *
 * One list, read by both the total and the breakdown, so the two cannot drift:
 * a key added here lands in both at once, and a key added to only one of them
 * would have produced a breakdown that does not add up to its own total.
 *
 * EVERY KEY HERE MUST BE A VERDICT A DOCUMENT LANDS ON, never a roll-up of
 * other keys in this list. `qa_visible_gaps` used to head it, and that was a
 * double count: the store DERIVES it by summing five verdicts
 * (metadata_only_gap + raster_ocr_vlm_escalation + low_confidence_retry_local +
 * low_confidence_candidate_for_venice + failed_needs_operator), two of which
 * are also listed here in their own right. Five metadata-only documents
 * therefore reported as ten needing review, printed under two labels at once —
 * and the breakdown-adds-up-to-the-total check could not catch it, because the
 * total IS this sum, so both were wrong together. The five components are
 * listed individually below; the total is unchanged in meaning and simply
 * counts each document once.
 *
 * `count_key` is the internal name and stays internal. The published `key` is a
 * separate, jargon-free id, because the payload is checked against the store's
 * own vocabulary — a `qa_`-prefixed key crossing into it is the same leak as a
 * scheduler word crossing into a label. Renaming a count key upstream therefore
 * changes only the left column here, and the page's ids hold still.
 */
/**
 * Whose work a review reason actually is.
 *
 * Owner question, 2026-08-24, reading "NEEDS REVIEW — 3,913" over six chips:
 * "how is a user supposed to clear this up?" The honest answer was that they
 * mostly are not — around 94% of that number is machine queue depth — but the
 * page had no way to say so, so 3,913 read as 3,913 items of homework.
 *
 * The rule is borrowed verbatim from the background page's disposition
 * vocabulary, which already settled this argument: automation may be claimed
 * ONLY where a lane demonstrably owns the verdict. "We don't know" and "it will
 * fix itself" are not the same sentence, so anything mixed or unowned is
 * `needs_you`.
 */
export type DashboardNeedsReviewActor = 'automatic' | 'needs_you';

/**
 * Every reason, and who acts on it — each classification read out of the lane
 * that consumes the verdict, not out of the verdict's name.
 *
 * Verified 2026-08-24 against the ladder in dropbox-files/extraction-readiness.ts,
 * the verdict-driven planner (`enqueueQaContentExtractionJobs`, reachable only
 * when a caller passes `qa_verdicts`), the in-process scheduler's three Dropbox
 * tasks, and the two supervisor sweeps that are actually configured with
 * verdicts. Two things that verification changed:
 *
 * - `pages_not_extracted` is NOT automatic. A part-read document is `indexed`,
 *   so the default planner skips it (a job exists at these bytes) and neither
 *   janitor mode nor the requalify pass matches it. No configured sweep names
 *   the verdict. It sits there until someone re-runs it by hand.
 * - `extraction_failed` is not cleanly operator-only either, but it cannot be
 *   called automatic: the local text sweep retries it ONCE, and the candidate
 *   query then skips any row that already has a job at these bytes whatever its
 *   status — so a second failure is permanent until a person intervenes. Mixed
 *   resolves to `needs_you` by the rule above, never to a soothing claim.
 *
 * `actor_note` is the chip's own plain-language clause. It says what happens
 * next, never a lane name, a unit name or a verdict: the reader is being told
 * whether to act, not how the plumbing is arranged.
 */
export const DASHBOARD_NEEDS_REVIEW_REASONS: ReadonlyArray<{
  count_key: string;
  key: string;
  label: string;
  who_acts: DashboardNeedsReviewActor;
  actor_note: string;
}> = [
  {
    count_key: 'qa_stale_revision',
    key: 'text_out_of_date',
    label: 'Text is from an older version',
    who_acts: 'automatic',
    actor_note: 'read again on the next pass over the file',
  },
  {
    count_key: 'qa_metadata_only_gap',
    key: 'metadata_only',
    label: 'Metadata only',
    who_acts: 'automatic',
    actor_note: 'queued for the text sweep',
  },
  {
    count_key: 'qa_partial_pages_gap',
    key: 'pages_not_extracted',
    label: 'Some pages not extracted',
    who_acts: 'needs_you',
    actor_note: 'nothing re-reads a part-read file on its own',
  },
  {
    count_key: 'qa_raster_ocr_vlm_escalation',
    key: 'scanned_needs_better_reader',
    label: 'Scanned pages need a better reader',
    who_acts: 'automatic',
    actor_note: 'passed to the local vision reader',
  },
  {
    count_key: 'qa_low_confidence_retry_local',
    key: 'text_looks_unreliable',
    label: 'Extracted text looks unreliable',
    who_acts: 'automatic',
    actor_note: 'the local text sweep re-reads these',
  },
  {
    count_key: 'qa_low_confidence_candidate_for_venice',
    key: 'image_only_no_text',
    label: 'Image-only, no text read yet',
    who_acts: 'needs_you',
    actor_note: 'no reader is switched on for these yet',
  },
  {
    count_key: 'qa_failed_needs_operator',
    key: 'extraction_failed',
    label: 'Extraction failed',
    who_acts: 'needs_you',
    actor_note: 'retried once already, so these wait for you',
  },
  {
    count_key: 'extraction_jobs_failed_actionable',
    key: 'extraction_jobs_failed',
    label: 'Extraction jobs failed',
    who_acts: 'needs_you',
    actor_note: 'some retry themselves, the rest wait for you',
  },
  {
    count_key: 'metadata_sync_folders_failed',
    key: 'folders_failed_to_sync',
    label: 'Folders failed to sync',
    who_acts: 'needs_you',
    actor_note: 'retried a few times, then left for you',
  },
  {
    count_key: 'metadata_sync_folders_blocked',
    key: 'folders_blocked',
    label: 'Folders blocked',
    who_acts: 'needs_you',
    actor_note: 'Dropbox is refusing these folders',
  },
];

/**
 * What each tier permits, read out of the code that enforces it rather than
 * copied from a design. Every cell below was checked against a specific
 * enforcement site:
 *
 * - S5 refuses everything, local included: `assertModelTrustTierAllowed`
 *   (core/source-model-policy.ts) denies S5 on the model, embedding AND release
 *   paths whatever the provider is, and the connector stores write a tombstone
 *   instead of storing the item. The meaning line says the CONTENT is never
 *   stored, which is true; a row recording the refusal is.
 * - S4 / secure_local admits local profiles and Venice only:
 *   `profileAllowedForDomain` in core/sovereignty.ts admits
 *   local-openai-compatible and venice encrypted_cloud members for that domain,
 *   and `validateRetrievalPolicy` refuses cloud query and non-local embedding
 *   trust for it.
 * - S1-S3 / internal and S0 / public_safe permit every lane: their policy trust
 *   is encrypted_cloud and standard_cloud, which every profile trust clears.
 *
 * A `true` is a PERMISSION, never a claim that the lane exists. Venice for
 * secure_local is only configured when a venice-private profile is present, so
 * a reader wanting "is Venice connected" has to read `answer_lanes`.
 */
export const DASHBOARD_SENSITIVITY_TIERS: DashboardSensitivityTiers = {
  policy_basis: 'enforced',
  tiers: [
    {
      name: 'Secrets',
      tier_label: 'S5',
      meaning: 'Refused before storage — content never stored and never reaches any model',
      local: false,
      venice: false,
      frontier: false,
    },
    {
      name: 'Secure',
      tier_label: 'S4',
      meaning: 'Kept in your secure store — local models and Venice only, never frontier cloud',
      local: true,
      venice: true,
      frontier: false,
    },
    {
      name: 'Private',
      tier_label: 'S1–S3',
      meaning: 'Everyday mail, files, and notes',
      local: true,
      venice: true,
      frontier: true,
    },
    {
      name: 'Public',
      tier_label: 'S0',
      meaning: 'Freely shareable material',
      local: true,
      venice: true,
      frontier: true,
    },
  ],
};

export const DASHBOARD_SUPPORTED_SOURCES: DashboardSupportedSourceDefinition[] = [
  {
    source_id: 'gmail.email',
    primary_corpus_id: 'internal.email',
    corpus_source_ids: ['gmail.email'],
    ingestion_ledger_source_id: 'email',
    label: 'Gmail',
    provider: 'gmail',
    family: 'email',
    trust_domain: 'secure_local',
    connect_kind: 'oauth',
    connect_action: { kind: 'oauth', source: 'gmail' },
  },
  {
    source_id: 'google_drive.docs',
    primary_corpus_id: 'internal.drive.docs',
    corpus_source_ids: ['google_drive.docs'],
    ingestion_ledger_source_id: 'google_drive',
    label: 'Google Drive',
    provider: 'google_drive',
    family: 'file',
    trust_domain: 'internal',
    connect_kind: 'oauth',
    connect_action: { kind: 'oauth', source: 'google-drive' },
  },
  {
    source_id: 'dropbox.files',
    primary_corpus_id: 'secure_local.dropbox.files',
    corpus_source_ids: ['dropbox.files'],
    ingestion_ledger_source_id: 'dropbox',
    label: 'Dropbox',
    provider: 'dropbox',
    family: 'file',
    trust_domain: 'secure_local',
    connect_kind: 'oauth',
    connect_action: { kind: 'oauth', source: 'dropbox' },
  },
  {
    source_id: 'x.bookmarks',
    primary_corpus_id: 'internal.x.bookmarks',
    corpus_source_ids: ['x.bookmarks'],
    ingestion_ledger_source_id: 'x',
    label: 'X bookmarks',
    provider: 'x',
    family: 'x',
    trust_domain: 'internal',
    connect_kind: 'oauth',
    // A bookmark arrives as its post text.
    content_arrives_extracted: true,
    connect_action: { kind: 'oauth', source: 'x' },
  },
  {
    source_id: 'telegram.messages',
    primary_corpus_id: 'internal.telegram.messages',
    corpus_source_ids: ['telegram.messages'],
    ingestion_ledger_source_id: 'telegram',
    label: 'Telegram',
    provider: 'telegram',
    family: 'chat',
    trust_domain: 'internal',
    connect_kind: 'pairing',
    // A message arrives as its own text.
    content_arrives_extracted: true,
    connect_action: {
      kind: 'guided_session',
      source: 'telegram',
      instructions: [
        'Telegram pairs with a phone-number login on this computer.',
        'Ask your agent to start Telegram pairing; this card updates once the login completes.',
      ],
    },
  },
  {
    source_id: 'whatsapp.personal.messages',
    primary_corpus_id: 'secure_local.whatsapp.messages',
    corpus_source_ids: ['whatsapp.personal.messages'],
    ingestion_ledger_source_id: 'whatsapp',
    label: 'WhatsApp',
    provider: 'whatsapp_personal',
    family: 'chat',
    trust_domain: 'secure_local',
    connect_kind: 'pairing',
    // A message arrives as its own text; voice notes are transcribed by their
    // own lane, which reports through the same read count this flag defers to.
    content_arrives_extracted: true,
    connect_action: {
      kind: 'guided_session',
      source: 'whatsapp',
      instructions: [
        'WhatsApp pairs by scanning a QR code from your phone (WhatsApp, then Linked devices).',
        'Ask your agent to start WhatsApp pairing; this card updates once the scan completes.',
      ],
    },
  },
  {
    source_id: 'readwise.library',
    primary_corpus_id: 'internal.readwise.library',
    corpus_source_ids: ['readwise.library'],
    ingestion_ledger_source_id: 'readwise',
    label: 'Readwise',
    provider: 'readwise',
    family: 'readwise',
    trust_domain: 'internal',
    connect_kind: 'api_token',
    // A highlight arrives as the text the reader already selected.
    content_arrives_extracted: true,
    connect_action: { kind: 'api_key', source: 'readwise' },
  },
];

const VENICE_ANSWER_LANE: DashboardSupportedSourceDefinition = {
  source_id: 'venice.api',
  primary_corpus_id: 'venice.api',
  // An answer lane, not a corpus: it owns no registry corpus and no ledger row.
  corpus_source_ids: [],
  ingestion_ledger_source_id: 'venice.api',
  label: 'Venice',
  provider: 'venice',
  family: 'model',
  trust_domain: 'secure_local',
  connect_kind: 'api_token',
  answer_capable_without_sync: true,
  connect_action: { kind: 'api_key', source: 'venice' },
};

export function defaultSourceDashboardHistoryDbPath(env: Record<string, string | undefined> = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'source-dashboard.sqlite');
}

/**
 * True when this counter's phase has nothing left to do on a corpus that has
 * finished a pass — the one moment a delta baseline may be taken.
 *
 * Both halves matter. Parity mid-crawl is just a crawl that has caught up with
 * itself, and a baseline taken there would call the remaining 26,000 files of
 * a first ingestion a "batch". And parity is measured against the SAME in-scope
 * population the phase bars divide by, so the baseline and the denominator it
 * will be subtracted from can never come from two different totals.
 *
 * `indexed_items` is deliberately never at parity: metadata sync divides by its
 * own discovered count or by the folder walk, both of which restate themselves
 * on every pass, so that phase has no delta to scope and needs no baseline.
 */
function phaseAtParity(sample: SourceDashboardHistorySample, counter: string, value: number): boolean {
  if (sample.settled_pass !== true) return false;
  const inScope = sample.in_scope_items;
  if (inScope === undefined || !Number.isFinite(inScope) || inScope <= 0) return false;
  if (counter === 'content_ready_items') return value >= inScope;
  // Embedding is complete only where extraction is: the bar clamps its
  // numerator to what has been read, so a store that has run ahead of
  // extraction is not at parity however many files it reports.
  if (counter === 'embedded_files') return value >= inScope && sample.content_ready_items >= inScope;
  return false;
}

export class SqliteSourceDashboardHistory implements SourceDashboardHistory {
  private readonly db: Database;

  constructor(dbPath = defaultSourceDashboardHistoryDbPath()) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA busy_timeout = 10000;');
    runSqliteMigrations(this.db, DASHBOARD_SQLITE_STORE_ID, currentStoreMigrations());
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
      CREATE TABLE IF NOT EXISTS source_dashboard_movement (
        corpus_id TEXT NOT NULL,
        counter TEXT NOT NULL,
        last_value INTEGER NOT NULL,
        rose_at TEXT,
        seen_at TEXT,
        first_seen_at TEXT,
        settled_value INTEGER,
        settled_at TEXT,
        PRIMARY KEY (corpus_id, counter)
      );
    `);
    // Added 2026-09-01 for the per-file embedding bar. CREATE TABLE IF NOT
    // EXISTS leaves an existing table alone, so the column is added in place;
    // NULL on old rows means "not measured then", which the movement query
    // treats as no evidence rather than as zero.
    const columns = this.db.query('PRAGMA table_info(source_dashboard_samples)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'embedded_files')) {
      try {
        this.db.exec('ALTER TABLE source_dashboard_samples ADD COLUMN embedded_files INTEGER');
      } catch (error) {
        // Two connections opening at once can both see the column absent;
        // the second ALTER fails with "duplicate column", which is success.
        if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
    // The movement ledger's first cut had no seen_at, and its second none of
    // the settled baseline. Same in-place rule for all three: CREATE TABLE IF
    // NOT EXISTS leaves an existing table alone, so a store written before a
    // column existed has to gain it here or every write against it fails.
    // NULL on an old row means "never observed", which both readers already
    // treat as no evidence rather than as zero.
    const movementColumns = this.db.query('PRAGMA table_info(source_dashboard_movement)').all() as Array<{ name: string }>;
    const addMovementColumn = (name: string, type: string): void => {
      if (movementColumns.some((column) => column.name === name)) return;
      try {
        this.db.exec(`ALTER TABLE source_dashboard_movement ADD COLUMN ${name} ${type}`);
      } catch (error) {
        if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    };
    addMovementColumn('seen_at', 'TEXT');
    addMovementColumn('first_seen_at', 'TEXT');
    addMovementColumn('settled_value', 'INTEGER');
    addMovementColumn('settled_at', 'TEXT');
    this.db.run(
      'UPDATE source_dashboard_movement SET seen_at = COALESCE(rose_at, ?) WHERE seen_at IS NULL',
      [new Date().toISOString()],
    );
    // A row written before this column existed has been observed at least once
    // already, so the oldest moment it can honestly claim is the oldest one it
    // still holds. Backfilled once; `first_seen_at` is never written again.
    this.db.run(
      'UPDATE source_dashboard_movement SET first_seen_at = COALESCE(rose_at, seen_at, ?) WHERE first_seen_at IS NULL',
      [new Date().toISOString()],
    );
  }

  record(samples: SourceDashboardHistorySample[]): void {
    if (samples.length === 0) return;
    const insert = this.db.query(`
      INSERT INTO source_dashboard_samples (
        source_id,
        corpus_id,
        sampled_at,
        indexed_items,
        content_ready_items,
        queue_waiting,
        queue_active,
        queue_attention,
        embedded_files
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const expireBefore = this.db.query(
      'DELETE FROM source_dashboard_samples WHERE sampled_at < ?',
    );
    const trimCorpus = this.db.query(`
      DELETE FROM source_dashboard_samples
      WHERE corpus_id = ?
        AND id NOT IN (
          SELECT id FROM source_dashboard_samples
          WHERE corpus_id = ?
          ORDER BY sampled_at DESC, id DESC
          LIMIT ?
        )
    `);
    this.db.transaction(() => {
      for (const sample of samples) {
        insert.run(
          sample.source_id,
          sample.corpus_id,
          sample.sampled_at,
          sample.indexed_items,
          sample.content_ready_items,
          sample.queue_waiting,
          sample.queue_active,
          sample.queue_attention,
          sample.embedded_files ?? null,
        );
        this.noteMovement(sample);
      }
      const newest = samples
        .map((sample) => Date.parse(sample.sampled_at))
        .filter((value) => Number.isFinite(value))
        .reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
      if (Number.isFinite(newest)) {
        const cutoff = new Date(newest - SAMPLE_RETENTION_MS).toISOString();
        expireBefore.run(cutoff);
        // A corpus nobody has reported on for the retention window is retired;
        // its ledger rows go with it, so a corpus id that comes back later
        // starts from a first observation instead of inheriting an old rise.
        this.db.run('DELETE FROM source_dashboard_movement WHERE seen_at < ?', [cutoff]);
      }
      for (const corpusId of new Set(samples.map((sample) => sample.corpus_id))) {
        trimCorpus.run(corpusId, corpusId, MAX_SAMPLES_PER_CORPUS);
      }
    })();
  }

  progressFor(sample: SourceDashboardHistorySample, now: Date): DashboardSourceCard['progress'] {
    const currentAt = now.getTime();
    const sampledAt = Date.parse(sample.sampled_at);
    const latestComparable = Math.min(currentAt, Number.isFinite(sampledAt) ? sampledAt : currentAt);
    // Compare against a sample at least MIN_PROGRESS_WINDOW_MS old. The browser
    // polls every 5s and each poll records a sample, so the immediately
    // preceding row is normally 5 seconds old; a single item over 5 seconds
    // extrapolates to 720 items/hour and the estimate swings by orders of
    // magnitude between polls on an unchanged backlog.
    const windowCutoff = new Date(latestComparable - MIN_PROGRESS_WINDOW_MS).toISOString();
    const row = this.db.query(`
      SELECT sampled_at, indexed_items
      FROM source_dashboard_samples
      WHERE corpus_id = ? AND sampled_at <= ?
      ORDER BY sampled_at DESC
      LIMIT 1
    `).get(sample.corpus_id, windowCutoff) as { sampled_at?: string; indexed_items?: number } | null;
    if (!row?.sampled_at || typeof row.indexed_items !== 'number') return undefined;
    const previousAt = Date.parse(row.sampled_at);
    if (!Number.isFinite(previousAt) || currentAt <= previousAt) return undefined;
    const deltaItems = sample.indexed_items - row.indexed_items;
    if (deltaItems <= 0) return undefined;
    const hours = (currentAt - previousAt) / 3_600_000;
    if (hours <= 0) return undefined;
    const rate = round1(deltaItems / hours);
    // round1 truncates to one decimal, so any rate below 0.05 items/hour lands
    // on exactly 0 and the ETA divides by it. Report no progress rather than a
    // zero rate and an infinite estimate.
    if (rate <= 0) return undefined;
    const remaining = sample.queue_waiting + sample.queue_active;
    const etaMinutes = Math.max(1, Math.ceil((remaining / rate) * 60));
    return {
      indexed_items_per_hour: rate,
      ...(remaining > 0 && Number.isFinite(etaMinutes) ? { eta_minutes: etaMinutes } : {}),
    };
  }

  /**
   * When each phase's counter last rose: the newest retained sample in which
   * the counter was LOWER than it is now. The rise happened after that moment,
   * so "moved 40s ago" is a lower bound on recency and never overstates it. A
   * counter never seen lower inside the retention window yields nothing, which
   * the page reads as "no movement in the last day", not as "moved at start".
   */
  /**
   * When each phase's counter last ROSE, from a tiny per-counter ledger this
   * class keeps beside the samples.
   *
   * Not derived from the sample series: that series is capped per corpus and
   * trimmed by request volume, so four open pages polling could erase a rise
   * from fifty minutes ago and call a moving lane stalled; and a NULL sample
   * (a store that had not measured yet) sat between two values and got
   * reported as the movement time. The ledger records, per counter, the last
   * value seen and the moment a strictly higher value was first observed; a
   * NULL never touches it, and a counter that drops (re-index) keeps its last
   * rise rather than inventing one.
   */
  movementFor(sample: SourceDashboardHistorySample, _now: Date): DashboardPhaseMovement | undefined {
    const rows = this.db.query(`
      SELECT counter, rose_at, first_seen_at, settled_value FROM source_dashboard_movement WHERE corpus_id = ?
    `).all(sample.corpus_id) as Array<{
      counter: string;
      rose_at: string | null;
      first_seen_at: string | null;
      settled_value: number | null;
    }>;
    const at = (counter: string): string | undefined => {
      const value = rows.find((row) => row.counter === counter)?.rose_at;
      return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
    };
    const settled = (counter: string): number | undefined => {
      const value = rows.find((row) => row.counter === counter)?.settled_value;
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    };
    const metadataSyncAt = at('indexed_items');
    const extractionAt = at('content_ready_items');
    const embeddingAt = at('embedded_files');
    const extractionSettled = settled('content_ready_items');
    const embeddingSettled = settled('embedded_files');
    // The oldest first-observation across this corpus's counters: the earliest
    // moment the dashboard can prove it was looking at this source at all.
    const firstSeenTimes = rows
      .map((row) => row.first_seen_at)
      .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
      .map((value) => Date.parse(value));
    const firstSeenAt = firstSeenTimes.length > 0
      ? new Date(Math.min(...firstSeenTimes)).toISOString()
      : undefined;
    const movement: DashboardPhaseMovement = {
      ...(firstSeenAt === undefined ? {} : { first_seen_at: firstSeenAt }),
      ...(metadataSyncAt === undefined ? {} : { metadata_sync_at: metadataSyncAt }),
      ...(extractionAt === undefined ? {} : { extraction_at: extractionAt }),
      ...(embeddingAt === undefined ? {} : { embedding_at: embeddingAt }),
      ...(extractionSettled === undefined ? {} : { extraction_settled_value: extractionSettled }),
      ...(embeddingSettled === undefined ? {} : { embedding_settled_value: embeddingSettled }),
    };
    // A baseline with no rise beside it is still evidence — a corpus that
    // settled and has not moved since is exactly that shape — so the emptiness
    // test covers every field rather than the three times.
    return Object.keys(movement).length > 0 ? movement : undefined;
  }

  /** Advance the per-counter rise and baseline ledger for one sample. Runs inside record()'s transaction. */
  private noteMovement(sample: SourceDashboardHistorySample): void {
    const counters: Array<[string, number | undefined]> = [
      ['indexed_items', sample.indexed_items],
      ['content_ready_items', sample.content_ready_items],
      ['embedded_files', sample.embedded_files],
    ];
    for (const [counter, value] of counters) {
      if (value === undefined || !Number.isFinite(value)) continue;
      const parity = phaseAtParity(sample, counter, value);
      if (parity) {
        // The phase is complete on a settled pass, so THIS is the corpus any
        // later batch will be measured against. Rewritten on every such
        // sample, which keeps the baseline at the LAST moment of parity rather
        // than the first — two batches in a row each get their own
        // denominator instead of being summed into one.
        this.db.run(`
          INSERT INTO source_dashboard_movement (
            corpus_id, counter, last_value, rose_at, seen_at, first_seen_at, settled_value, settled_at
          )
          VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
          ON CONFLICT (corpus_id, counter) DO UPDATE SET
            last_value = excluded.last_value,
            rose_at = CASE WHEN excluded.last_value > source_dashboard_movement.last_value
              THEN excluded.seen_at ELSE source_dashboard_movement.rose_at END,
            seen_at = excluded.seen_at,
            settled_value = excluded.settled_value,
            settled_at = excluded.settled_at
        `, [sample.corpus_id, counter, value, sample.sampled_at, sample.sampled_at, value, sample.sampled_at]);
        continue;
      }
      const row = this.db.query(`
        SELECT last_value, settled_value FROM source_dashboard_movement WHERE corpus_id = ? AND counter = ?
      `).get(sample.corpus_id, counter) as { last_value: number; settled_value: number | null } | null;
      if (!row) {
        // First observation: the value is known, the rise is not, and a corpus
        // whose history starts here has settled nothing to measure against.
        this.db.run(
          `INSERT INTO source_dashboard_movement (corpus_id, counter, last_value, rose_at, seen_at, first_seen_at)
           VALUES (?, ?, ?, NULL, ?, ?)`,
          [sample.corpus_id, counter, value, sample.sampled_at, sample.sampled_at],
        );
        continue;
      }
      // A counter below its own baseline is being rebuilt, not extended: the
      // climb back is a re-index and calling its remainder a batch would
      // report a whole corpus as a handful of new files. The baseline goes,
      // and the phase reverts to describing the corpus until parity returns.
      const keepsBaseline = row.settled_value === null || value >= row.settled_value;
      const rose = value > row.last_value;
      this.db.run(`
        UPDATE source_dashboard_movement
        SET last_value = ?, seen_at = ?${rose ? ', rose_at = ?' : ''}${keepsBaseline ? '' : ', settled_value = NULL, settled_at = NULL'}
        WHERE corpus_id = ? AND counter = ?
      `, rose
        ? [value, sample.sampled_at, sample.sampled_at, sample.corpus_id, counter]
        : [value, sample.sampled_at, sample.corpus_id, counter]);
    }
  }

  sampleCount(): number {
    const row = this.db.query('SELECT COUNT(*) AS count FROM source_dashboard_samples').get() as { count?: number } | null;
    return typeof row?.count === 'number' ? row.count : 0;
  }

  close(): void {
    closeSqliteStore(this.db);
  }
}

export function buildSourceDashboardViewModel(options: SourceDashboardBuildOptions): SourceDashboardViewModel {
  const now = options.now ?? new Date();
  const degradedCredentials = [
    ...(options.sourceIndexStatus.degraded_credentials ?? []),
    ...credentialHealthDegradations(options.credentialHealth, now),
  ];
  // A report the probe stopped refreshing describes a world that may already
  // have been repaired, so it stops driving card state. The staleness itself is
  // reported above, in the degraded-credentials list.
  const credentialHealth = options.credentialHealth
    && !credentialHealthReportIsStale(options.credentialHealth, now)
    ? options.credentialHealth
    : undefined;
  const schedulerByCorpus = new Map(
    options.schedulerStatus?.sources.map((source) => [source.corpus_id, source]) ?? [],
  );
  const schedulerBySource = new Map(
    options.schedulerStatus?.sources.map((source) => [source.source_id, source]) ?? [],
  );
  const ingestionBySource = new Map(
    options.ingestionLedger?.rows.map((row) => [row.source_id, row]) ?? [],
  );
  const sourceIdByCorpusId = registryCorpusSourceIds(options.sourceCorpusRegistry);
  const unpairedSources = new Map<string, DashboardUnpairedSourceState>(
    (options.unpairedSources ?? []).map((state) => [state.source_id, state]),
  );
  const claimedCorpusIds = new Set<string>();
  const cards = DASHBOARD_SUPPORTED_SOURCES.map((definition) => {
    const corpora = options.sourceIndexStatus.corpora
      .filter((corpus) => corpusMatchesDefinition(corpus, definition, sourceIdByCorpusId));
    for (const corpus of corpora) claimedCorpusIds.add(corpus.corpus_id);
    const card = sourceCardFromDefinition(
      definition,
      corpora,
      schedulerByCorpus,
      schedulerBySource,
      options.connectedHandleRegistry,
      credentialHealth,
      options.oauthClientIds ?? {},
      options.oauthClientSecretAvailability ?? {},
      options.googleCloudProjectId,
      options.googlePilotClientConfigured === true,
      options.publisherOAuthSources ?? [],
      options.oauthRedirectBaseUrl,
      options.apiKeyAvailability ?? {},
      options.pendingConnects ?? [],
      now,
      ingestionRowForDefinition(definition, ingestionBySource),
      options.contentExtractionStallThresholdHours,
      options.connectedHandleRegistryUnreadable === true,
      unpairedSources.get(definition.source_id),
    );
    // Stamped after the card is built rather than threaded through it: this is
    // a fact about the worker's dispatch chain, not about the source.
    const syncSource = definition.connect_action.kind === 'oauth' || definition.connect_action.kind === 'api_key'
      ? definition.connect_action.source
      : undefined;
    if (options.syncNowAvailable === undefined || syncSource === undefined) return card;
    const withSyncAnswer = { ...card, sync_now_available: options.syncNowAvailable(syncSource) };
    // The readiness ladder's initial-sync advice names Sync now, so it is
    // rebuilt once the card knows whether this worker can run it.
    withSyncAnswer.setup = dashboardSourceSetupStatus(withSyncAnswer);
    return withSyncAnswer;
  });
  // Anything no card claimed is still the owner's data in the local store. It
  // is surfaced and counted rather than dropped: a corpus vanishing from this
  // page is the failure mode this section exists to make impossible.
  const unassignedCorpora = unassignedCorporaFrom(
    options.sourceIndexStatus.corpora.filter((corpus) => !claimedCorpusIds.has(corpus.corpus_id)),
    schedulerByCorpus,
    now,
  );
  const samples = cards.map((card): SourceDashboardHistorySample => ({
    source_id: card.source_id,
    corpus_id: card.corpus_id,
    sampled_at: now.toISOString(),
    indexed_items: card.coverage.indexed_items,
    content_ready_items: card.coverage.content_ready_items,
    ...(card.coverage.embedded_files === undefined ? {} : { embedded_files: card.coverage.embedded_files }),
    queue_waiting: card.queue_health.waiting,
    queue_active: card.queue_health.active,
    queue_attention: card.queue_health.needs_attention,
    // The two facts the ledger needs to recognise a completed phase, taken
    // from the same helpers the bars themselves use so the baseline it records
    // is denominated in exactly what the bars will subtract it from.
    in_scope_items: answerReadyEligibleItems(
      card.coverage.indexed_items,
      card.coverage.not_read_by_policy_items,
      card.coverage.answer_ready_eligible_items,
    ),
    settled_pass: dashboardHasSettledPass(card),
  }));
  options.history?.record(samples);
  const cardsWithProgress = cards.map((card, index) => {
    const progress = options.history?.progressFor(samples[index]!, now);
    const movement = options.history?.movementFor?.(samples[index]!, now);
    return {
      ...card,
      ...(progress ? { progress } : {}),
      ...(movement ? { movement } : {}),
    };
  });
  const summary = summarize(cardsWithProgress, unassignedCorpora);
  const trustCards = trustDomainCards(cardsWithProgress, unassignedCorpora, options.sovereigntyEngine);
  const excludedByConfiguration = excludedByConfigurationFrom(
    options.ingestionLedger?.excluded_by_configuration,
  );
  const sensitivity = sensitivityFrom(options.sensitivityMap);
  const folderPicker: DashboardFolderPicker = {
    available: options.ingestionDispositionsAvailable === true,
    label: 'Choose what gets ingested',
    path: '/dashboard/dispositions',
    rules: excludedByConfiguration.rules,
  };
  const answerLanes = [
    answerLaneFromDefinition(
      VENICE_ANSWER_LANE,
      options.connectedHandleRegistry,
      credentialHealth,
      options.apiKeyAvailability ?? {},
    ),
  ];

  return {
    kind: 'source_dashboard',
    generated_at: now.toISOString(),
    ...(degradedCredentials.length
      ? { degraded_credentials: degradedCredentials }
      : {}),
    summary,
    onboarding: onboarding(summary, cardsWithProgress, folderPicker),
    google_pilot: googlePilotStatus(options.googlePilotClientConfigured === true),
    answer_lanes: answerLanes,
    where_your_data_lives: trustCards,
    unassigned_corpora: unassignedCorpora,
    // From the ledger snapshot the caller already passes in. This page never
    // opens a store of its own, so the exclusion facts arrive the same way the
    // per-source ingestion health does.
    excluded_by_configuration: excludedByConfiguration,
    // Omitted, not emptied, when no map is configured — which is the ordinary
    // state on a fresh install.
    ...(sensitivity ? { sensitivity } : {}),
    sensitivity_tiers: DASHBOARD_SENSITIVITY_TIERS,
    folder_picker: folderPicker,
    sources: cardsWithProgress,
    history: {
      sample_count: options.history?.sampleCount() ?? 0,
      eta_available: cardsWithProgress.some((card) => card.progress?.eta_minutes !== undefined),
    },
    first_run: summary.connected_sources === 0,
    background_work: backgroundWorkFrom(options.sourceIndexStatus, options.ingestionLedger),
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      file_names_returned: false,
      file_paths_returned: false,
      host_names_returned: false,
    },
  };
}


function answerLaneFromDefinition(
  definition: DashboardSupportedSourceDefinition,
  registry: ConnectedHandleRegistry | undefined,
  credentialHealth: CredentialHealthReport | undefined,
  apiKeyAvailability: Partial<Record<DashboardApiKeySource, boolean>>,
): DashboardAnswerLaneCard {
  const handles = handlesForDefinition(definition, registry);
  const activeHandles = handles.filter((handle) => backendStatus(handle) !== 'reauth_required');
  const probeUnavailable = credentialHealthForDefinition(definition, credentialHealth)
    .some((result) => result.status === 'reauth_required'
      || result.status === 'missing'
      || result.status === 'degraded');
  const connected = !probeUnavailable && (apiKeyAvailability.venice === true || activeHandles.length > 0);
  const action = sourceAction(definition, connected, false, false, {}, {}, undefined, false, [], undefined);
  return {
    lane_id: 'venice-secure-answers',
    source_id: definition.source_id,
    label: definition.label,
    role: 'Approved encrypted-cloud lane for secure answers.',
    connection: {
      state: connected ? 'validated' : 'missing',
      label: connected ? 'key present + validated' : 'missing',
      action,
      handles: handles.map((handle) => handle.handle).sort((a, b) => a.localeCompare(b)),
    },
  };
}

function sourceCardFromDefinition(
  definition: DashboardSupportedSourceDefinition,
  corpora: SourceIndexStatusCorpus[],
  schedulerByCorpus: Map<string, SourceSchedulerSourceStatus>,
  schedulerBySource: Map<string, SourceSchedulerSourceStatus>,
  registry: ConnectedHandleRegistry | undefined,
  credentialHealth: CredentialHealthReport | undefined,
  oauthClientIds: Partial<Record<DashboardOAuthSource | 'google', string>>,
  oauthClientSecretAvailability: Partial<Record<DashboardOAuthSource | 'google', boolean>>,
  googleCloudProjectId: string | undefined,
  googlePilotClientConfigured: boolean,
  publisherOAuthSources: readonly DashboardOAuthSource[],
  oauthRedirectBaseUrl: string | undefined,
  apiKeyAvailability: Partial<Record<DashboardApiKeySource, boolean>>,
  pendingConnects: DashboardPendingConnect[],
  now: Date,
  ingestionLedgerRow: SourceIngestionLedgerRow | undefined,
  contentExtractionStallThresholdHours: number | undefined,
  registryUnreadable: boolean,
  unpaired: DashboardUnpairedSourceState | undefined,
): DashboardSourceCard {
  const corpusCards = withoutCustodialDoubleCount(
    corpora.map((corpus) => sourceCardFromCorpus(corpus, schedulerByCorpus.get(corpus.corpus_id), undefined, now)),
    corpora,
  );
  const schedulers = [
    ...corpora.map((corpus) => schedulerByCorpus.get(corpus.corpus_id)).filter((value): value is SourceSchedulerSourceStatus => !!value),
    ...(schedulerBySource.get(definition.source_id) ? [schedulerBySource.get(definition.source_id)!] : []),
  ];
  const coverage = aggregateCoverage(corpusCards);
  const metadataSync = aggregateMetadataSync(corpusCards);
  const baseQueue = aggregateQueueHealth(corpusCards, schedulers);
  const throughput = ingestionLedgerRow?.ingestion_health.content_extraction_throughput
    ? assessContentExtractionThroughput(ingestionLedgerRow.ingestion_health.content_extraction_throughput, {
      now,
      ...(contentExtractionStallThresholdHours !== undefined
        ? { thresholdHours: contentExtractionStallThresholdHours }
        : {}),
    })
    : undefined;
  const queue = throughput?.state === 'stalled'
    ? { ...baseQueue, label: 'Needs attention' as const, needs_attention: baseQueue.needs_attention + 1 }
    : baseQueue;
  const freshness = aggregateFreshness(corpusCards, schedulers, corpora, definition, now);
  const embeddingLaneDisabled = corpora.some((corpus) => corpus.embedding_lane?.state === 'embedding_lane_disabled');
  const schedule = scheduleFromSchedulers(schedulers);
  // A provider refusing requests is a credential problem the broker has not
  // latched yet: the connection may read connected while every scheduled sync
  // 401s. The card must still carry the real reconnect control, or the detail
  // page's check says "reconnect the credential" over a page with no control
  // (R61 finding 3).
  //
  // Unless Olympus is the one holding the lane. A budget guard parks a source
  // carrying whatever error kind it last recorded on the way in, so a stale
  // `api_request_guard` sat under `daily_cost_guard` live on 2026-08-19 and
  // re-armed Reauthenticate on a lane whose credential had just been replaced. The
  // pause is the fresher, more specific fact, and it outranks the error kind —
  // never the reverse, or the card and the detail page's paused sentence
  // describe two different lanes.
  const operatorPaused = schedule?.degraded_reason !== undefined
    && OPERATOR_PAUSED_SCHEDULER_MARKERS.has(schedule.degraded_reason);
  const providerRefusing = !operatorPaused
    && (schedule?.degraded_reason === 'api_request_guard'
      || (schedule !== undefined && schedule.consecutive_failures > 0 && schedule.last_error_kind === 'api_request_guard'));
  const baseConnection = connectionFromDefinition(
    definition,
    registry,
    credentialHealth,
    coverage,
    queue,
    freshness,
    corpora.some(corpusSyncRunning),
    oauthClientIds,
    oauthClientSecretAvailability,
    googleCloudProjectId,
    googlePilotClientConfigured,
    publisherOAuthSources,
    oauthRedirectBaseUrl,
    apiKeyAvailability,
    pendingConnects,
    providerRefusing,
    now,
    registryUnreadable,
    unpaired,
  );
  // Two custody controls, never both on one row. A paired session gets Unpair,
  // which removes the session this computer holds and is the only act that
  // actually ends the pairing; Disconnect is the broker-grant act and has
  // nothing to remove for these two sources even on the rare build where they
  // do carry a legacy handle.
  const pairedSession = definition.connect_action.kind === 'guided_session';
  const unpairable = pairedSession && unpaired === undefined
    && (baseConnection.handles.length > 0 || baseConnection.state !== 'not_connected');
  const connection = {
    ...baseConnection,
    ...(!pairedSession && baseConnection.handles.length > 0
      ? { disconnect: dashboardDisconnectAction(definition.source_id as V04PublicSourceId, definition.label) }
      : {}),
    ...(unpairable
      ? { unpair: dashboardUnpairAction(definition.source_id as V04PublicSourceId, definition.label) }
      : {}),
  };
  const configured = connection.state === 'connected'
    || connection.state === 'waiting_for_first_sync'
    || connection.state === 'syncing'
    || connection.state === 'synced';
  const answerReadiness = connection.state === 'reauth_required'
    ? { state: 'needs_attention' as const, label: 'Reauthenticate this source' }
    : embeddingLaneDisabled
      ? { state: 'needs_attention' as const, label: 'Embedding lane needs attention' }
      : throughput?.state === 'stalled'
        ? { state: 'needs_attention' as const, label: 'Content extraction is stalled' }
        : definition.answer_capable_without_sync && configured
          ? { state: 'ready' as const, label: 'Ready for questions' }
          // Same `operatorPaused` the connect control is suppressed by, so the
          // header, the control and the detail sentence read one pause.
          : answerReadinessFrom(configured, coverage, queue, freshness, operatorPaused);
  const ingestionHealth = dashboardIngestionHealth(ingestionLedgerRow, coverage, queue, throughput);
  const lastRun = lastRunFromCorpora(corpora);
  const embeddingBacklog = embeddingBacklogFromCorpora(corpora);
  const embeddingRequired = embeddingRequiredFromCorpora(corpora);
  const vlmQueued = vlmExtractionQueued(ingestionLedgerRow);
  const card: DashboardSourceCard = {
    corpus_id: definition.primary_corpus_id,
    source_id: definition.source_id,
    label: definition.label,
    provider: definition.provider,
    family: definition.family,
    trust_domain: definition.trust_domain,
    capabilities: renderPublicSourceCapabilityForDashboard(definition.source_id as V04PublicSourceId),
    configured,
    freshness,
    coverage,
    ...(ingestionLedgerRow
      && ingestionLedgerRow.ingestion_health.metadata_only_by_policy_items !== undefined
      && ingestionLedgerRow.ingestion_health.not_read_by_policy_items !== undefined
      ? {
          ingestion_selection: {
            metadata_only_files: Math.max(0, ingestionLedgerRow.ingestion_health.metadata_only_by_policy_items),
            full_ingestion_files: Math.max(
              0,
              ingestionLedgerRow.items
                - ingestionLedgerRow.ingestion_health.not_read_by_policy_items,
            ),
          },
        }
      : {}),
    // Summed from the same corpus cards `coverage` was, so the total here is
    // that field and not a second reading of it.
    needs_review: needsReviewFromReasonCounts(coverage.needs_review_items, needsReviewCounts(corpusCards)),
    ingestion_health: ingestionHealth,
    tier_composition: aggregateTierComposition(corpusCards, definition, coverage),
    queue_health: queue,
    answer_readiness: answerReadiness,
    connection,
    ...(lastRun ? { last_run: lastRun } : {}),
    ...(ingestionLedgerRow?.last_sync_at ? { last_sync_at: ingestionLedgerRow.last_sync_at } : {}),
    ...(schedule ? { schedule } : {}),
    ...(embeddingBacklog ? { embedding_backlog: embeddingBacklog } : {}),
    ...(embeddingRequired === undefined ? {} : { embedding_required: embeddingRequired }),
    ...(embeddingLaneDisabled ? { embedding_lane_state: 'embedding_lane_disabled' as const } : {}),
    ...(vlmQueued !== undefined ? { vlm_extraction_queued: vlmQueued } : {}),
    ...(ingestionLedgerRow?.attention.length ? { attention_reasons: [...ingestionLedgerRow.attention] } : {}),
    ...(metadataSync ? { metadata_sync: metadataSync } : {}),
    ...(definition.content_arrives_extracted === true ? { content_arrives_extracted: true } : {}),
  };
  card.setup = dashboardSourceSetupStatus(card);
  return card;
}

function googlePilotStatus(configured: boolean): NonNullable<SourceDashboardViewModel['google_pilot']> {
  return {
    mode: configured ? 'shared_pilot' : 'advanced_byo_required',
    verification: 'unverified',
    warning: configured
      ? 'The shared Google pilot client is published but unverified. Google may show an unverified-app warning during this 3–5-user pilot.'
      : 'The shared Google pilot client is not provisioned in this install. Use the advanced bring-your-own Google app flow.',
    advanced_byo_supported: true,
  };
}

function dashboardSourceSetupStatus(card: DashboardSourceCard): DashboardSourceSetupStatus {
  const connection = card.connection;
  const synced = card.coverage.indexed_items > 0 || card.last_sync_at !== undefined;
  const dependenciesReady = synced;
  const dependencies = (card.capabilities?.dependencies ?? []).map((dependency) => ({
    id: dependency.id,
    label: dependency.label,
    status: dependenciesReady ? 'ready' as const : 'check_required' as const,
    next_action: dependenciesReady
      ? 'No action needed; a completed source read proves this dependency path.'
      : `Run Olympus doctor and repair ${dependency.label} before relying on the first sync.`,
  }));
  if (connection.state === 'not_connected' || connection.state === 'needs_setup') {
    const action = connection.action;
    const pairing = action.kind === 'guided_session';
    return {
      stage: pairing ? 'credential_or_pairing' : dependenciesReady ? 'credential_or_pairing' : 'dependency_check',
      condition: 'blocked',
      next_action: pairing
        ? (action.kind === 'guided_session' ? action.instructions.join(' ') : `Finish pairing ${card.label}.`)
        : action.kind === 'needs_setup'
          ? `Open Set up for ${card.label}, register the provider app, then start authorization.`
          : `Connect one ${card.label} account from this page.`,
      dependencies,
    };
  }
  if (connection.state === 'awaiting_consent') {
    return {
      stage: 'credential_or_pairing',
      condition: 'blocked',
      next_action: `Approve the requested ${card.label} access in the provider tab before this attempt expires.`,
      dependencies,
    };
  }
  if (connection.state === 'reauth_required') {
    return {
      stage: 'credential_or_pairing',
      condition: 'blocked',
      next_action: `Reauthenticate ${card.label} from this page, then run the initial sync again.`,
      dependencies,
    };
  }
  if (!synced || connection.state === 'waiting_for_first_sync' || connection.state === 'syncing') {
    return {
      stage: 'initial_sync',
      condition: connection.state === 'syncing' ? 'usable' : 'blocked',
      next_action: connection.state === 'syncing'
        ? 'Keep the worker running while the first sync and extraction queues finish.'
        // Naming a control this worker cannot run sends the reader to a 501.
        : card.sync_now_available === false
          ? `Keep the worker running; this worker has no Sync now for ${card.label}, so it syncs on its own schedule.`
          : `Start Sync now for ${card.label}; a service restart is not required.`,
      dependencies,
    };
  }
  if (card.answer_readiness.state === 'needs_attention' || card.freshness.stale) {
    return {
      stage: 'source_health',
      condition: 'degraded',
      next_action: connection.action.kind === 'oauth' || connection.action.kind === 'api_key'
        ? `${connection.action.label} ${card.label}, then run Sync now.`
        : `Run Olympus doctor, repair the reported ${card.label} dependency or queue, then run Sync now.`,
      dependencies,
    };
  }
  if (card.answer_readiness.state !== 'ready' || card.coverage.content_ready_items === 0) {
    return {
      stage: 'source_health',
      condition: 'degraded',
      next_action: `Keep the worker running until ${card.label} finishes extraction; review the named coverage gaps if progress stops.`,
      dependencies,
    };
  }
  return {
    stage: 'cited_answer_readiness',
    condition: 'usable',
    next_action: `Ask a question and confirm the answer cites ${card.label} evidence and states any remaining gaps.`,
    dependencies,
  };
}

function dashboardDisconnectAction(sourceId: V04PublicSourceId, label: string): DashboardDisconnectAction {
  const google = sourceId === 'gmail.email' || sourceId === 'google_drive.docs';
  const providerRevocationUrl: Record<V04PublicSourceId, string> = {
    'gmail.email': 'https://myaccount.google.com/connections',
    'google_drive.docs': 'https://myaccount.google.com/connections',
    'dropbox.files': 'https://www.dropbox.com/account/connected_apps',
    'x.bookmarks': 'https://x.com/settings/connected_apps',
    'telegram.messages': 'https://my.telegram.org/auth',
    'whatsapp.personal.messages': 'https://faq.whatsapp.com/378279804439436',
    'readwise.library': 'https://readwise.io/access_token',
  };
  const sharedGoogleImpact = google
    ? ' If Gmail and Drive share this Google grant, both stop reading.'
    : '';
  return {
    source_id: sourceId,
    label: `Disconnect ${label}`,
    confirmation: `Stop new ${label} reads and remove the selected local credential/account grant.${sharedGoogleImpact} Indexed data and developer-app registration stay. Olympus does not revoke provider-side access.`,
    provider_revocation_url: providerRevocationUrl[sourceId],
  };
}

/**
 * The confirmation a paired-session Unpair shows before it acts.
 *
 * It states the three facts a reader cannot check from the button: the act is
 * local (the provider-side device stays linked, and where to unlink it), the
 * messages already indexed are untouched, and the capture service on this
 * computer is a separate process this worker cannot stop — so a bridge or
 * reader left running can pair itself back. Owner decision, 2026-09-02.
 */
function dashboardUnpairAction(sourceId: V04PublicSourceId, label: string): DashboardUnpairAction {
  const telegram = sourceId === 'telegram.messages';
  const providerSurface = telegram
    ? { url: 'https://my.telegram.org/auth', label: 'Telegram active sessions' }
    : { url: 'https://faq.whatsapp.com/378279804439436', label: 'WhatsApp linked devices' };
  const capture = telegram
    ? 'Stop the Telegram capture service first if it is running, or it can log in again.'
    : 'Stop the WhatsApp bridge first if it is running, or it can pair again.';
  return {
    source_id: sourceId,
    label: `Unpair ${label}`,
    confirmation: `Stop new ${label} reads and delete this computer's ${label} pairing session.`
      + ` Messages already indexed stay, and so does everything already captured.`
      + ` This is local only: Olympus does not remove the linked device at ${label} — do that in ${providerSurface.label}.`
      + ` ${capture}`,
    provider_unlink_url: providerSurface.url,
    provider_unlink_label: providerSurface.label,
  };
}

/**
 * The newest refresh across this card's corpora.
 *
 * `sync_run_id` and `source_scope` are deliberately dropped: the scope key is
 * the one field on a refresh the scheduler's own policy says is never exposed.
 */
function lastRunFromCorpora(corpora: SourceIndexStatusCorpus[]): DashboardSourceRun | undefined {
  const refreshes = corpora
    .map((corpus) => corpus.last_refresh)
    .filter((refresh): refresh is SourceIndexLastRefresh => refresh !== undefined);
  if (refreshes.length === 0) return undefined;
  const newest = refreshes.reduce((best, refresh) =>
    runOrderKey(refresh) > runOrderKey(best) ? refresh : best);
  const startedAt = Date.parse(newest.started_at ?? '');
  const completedAt = Date.parse(newest.completed_at ?? '');
  const durationSeconds = Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
    ? Math.round((completedAt - startedAt) / 1000)
    : undefined;
  return {
    status: newest.status,
    ...(newest.started_at ? { started_at: newest.started_at } : {}),
    ...(newest.completed_at ? { completed_at: newest.completed_at } : {}),
    ...(durationSeconds !== undefined ? { duration_seconds: durationSeconds } : {}),
    items_seen: newest.items_seen,
    items_indexed: newest.items_indexed,
  };
}

function runOrderKey(refresh: SourceIndexLastRefresh): number {
  const completedAt = Date.parse(refresh.completed_at ?? '');
  if (Number.isFinite(completedAt)) return completedAt;
  const startedAt = Date.parse(refresh.started_at ?? '');
  return Number.isFinite(startedAt) ? startedAt : Number.NEGATIVE_INFINITY;
}

function scheduleFromSchedulers(
  schedulers: SourceSchedulerSourceStatus[],
): DashboardSourceSchedule | undefined {
  // The same status arrives twice when a definition matches both by corpus and
  // by source id, which would double every failure count on the card.
  const tasks = [...new Set(schedulers)].flatMap((scheduler) => scheduler.tasks);
  if (tasks.length === 0) return undefined;
  const failing = tasks
    .filter((task) => task.consecutive_failures > 0)
    .sort((left, right) => (Date.parse(right.last_attempt_at ?? '') || 0) - (Date.parse(left.last_attempt_at ?? '') || 0));
  const lastErrorKind = failing.find((task) => task.last_error_kind)?.last_error_kind;
  const degradedReason = tasks.find((task) => task.degraded_reason)?.degraded_reason;
  const lastSuccessAt = latestIsoTimestamp(tasks.map((task) => task.last_success_at));
  const lastAttemptAt = latestIsoTimestamp(tasks.map((task) => task.last_attempt_at));
  const nextRunAt = earliestIsoTimestamp(tasks.map((task) => task.next_run_at));
  return {
    running: tasks.some((task) => task.running),
    consecutive_failures: tasks.reduce((sum, task) => sum + task.consecutive_failures, 0),
    ...(lastSuccessAt ? { last_success_at: lastSuccessAt } : {}),
    ...(lastAttemptAt ? { last_attempt_at: lastAttemptAt } : {}),
    ...(nextRunAt ? { next_run_at: nextRunAt } : {}),
    ...(lastErrorKind ? { last_error_kind: lastErrorKind } : {}),
    ...(degradedReason ? { degraded_reason: degradedReason } : {}),
  };
}

function latestIsoTimestamp(values: Array<string | undefined>): string | undefined {
  return orderedIsoTimestamps(values).at(-1);
}

function earliestIsoTimestamp(values: Array<string | undefined>): string | undefined {
  return orderedIsoTimestamps(values)[0];
}

function orderedIsoTimestamps(values: Array<string | undefined>): string[] {
  return values
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
}

function embeddingBacklogFromCorpora(
  corpora: SourceIndexStatusCorpus[],
): DashboardEmbeddingBacklog | undefined {
  const parities = corpora
    .map((corpus) => corpus.embedding_parity)
    .filter((parity): parity is NonNullable<SourceIndexStatusCorpus['embedding_parity']> => parity !== undefined);
  if (parities.length === 0) return undefined;
  const chunks = parities.reduce((sum, parity) => sum + parity.chunks, 0);
  // Zero chunks is not a backlog of zero, it is nothing to embed yet, and a
  // page dividing by it would render a wedge with no meaning.
  if (chunks <= 0) return undefined;
  return {
    chunks,
    embedded_chunks: parities.reduce((sum, parity) => sum + parity.embedded_chunks, 0),
    missing_chunks: parities.reduce((sum, parity) => sum + parity.missing_chunks, 0),
    refresh_needed: parities.some((parity) => parity.refresh_needed),
  };
}

/**
 * Whether any corpus on this card is served from embeddings at all. False is a
 * real answer — a keyword-only source has no embedding stage and the page says
 * so (owner ruling, 2026-09-01) — and absent means no corpus published parity.
 */
function embeddingRequiredFromCorpora(corpora: SourceIndexStatusCorpus[]): boolean | undefined {
  const parities = corpora
    .map((corpus) => corpus.embedding_parity)
    .filter((parity): parity is NonNullable<SourceIndexStatusCorpus['embedding_parity']> => parity !== undefined);
  if (parities.length === 0) return undefined;
  return parities.some((parity) => parity.required);
}

/** Queued jobs on a VLM extractor, counted the way the ledger counts them for its hold marker. */
function vlmExtractionQueued(row: SourceIngestionLedgerRow | undefined): number | undefined {
  if (!row?.failure_breakdown) return undefined;
  return row.failure_breakdown
    .filter((entry) => entry.status === 'queued' && entry.extractor_kind.includes('vlm'))
    .reduce((sum, entry) => sum + entry.count, 0);
}

function backgroundWorkFrom(
  status: SourceIndexStatusResult,
  ledger: SourceIngestionLedgerSnapshot | undefined,
): DashboardBackgroundWork {
  const embeddingBacklog = embeddingBacklogFromCorpora(status.corpora);
  const laneState = status.embedding_lane?.state
    ?? (status.corpora.some((corpus) => corpus.embedding_lane?.state === 'embedding_lane_disabled')
      ? 'embedding_lane_disabled' as const
      : undefined);
  const vlmQueued = ledger?.rows
    .map((row) => vlmExtractionQueued(row))
    .filter((value): value is number => value !== undefined);
  return {
    ...(embeddingBacklog ? { embedding_backlog: embeddingBacklog } : {}),
    ...(laneState ? { embedding_lane_state: laneState } : {}),
    ...(vlmQueued?.length ? { vlm_extraction_queued: vlmQueued.reduce((sum, value) => sum + value, 0) } : {}),
  };
}

function withoutCustodialDoubleCount(
  cards: DashboardSourceCard[],
  _corpora: SourceIndexStatusCorpus[],
): DashboardSourceCard[] {
  return cards;
}

function corpusMatchesDefinition(
  corpus: SourceIndexStatusCorpus,
  definition: DashboardSupportedSourceDefinition,
  sourceIdByCorpusId: Map<string, string>,
): boolean {
  if (corpus.corpus_id === definition.primary_corpus_id) return true;
  const registrySourceId = registrySourceIdForCorpus(corpus.corpus_id, sourceIdByCorpusId);
  return registrySourceId !== undefined && definition.corpus_source_ids.includes(registrySourceId);
}

function ingestionRowForDefinition(
  definition: DashboardSupportedSourceDefinition,
  rows: Map<string, SourceIngestionLedgerRow>,
): SourceIngestionLedgerRow | undefined {
  return rows.get(definition.ingestion_ledger_source_id);
}

function dashboardIngestionHealth(
  row: SourceIngestionLedgerRow | undefined,
  coverage: DashboardSourceCard['coverage'],
  queue: DashboardSourceCard['queue_health'],
  throughput?: ContentExtractionThroughputAssessment,
): DashboardSourceCard['ingestion_health'] {
  // Zero indexed items means nothing is known about coverage, not that
  // coverage is complete. Both this fallback and the ledger's own
  // coveragePercent answer 100 for an empty source, which asserts a full
  // corpus on exactly the card whose true answer is "none, and it is broken".
  const notReadByPolicy = row?.ingestion_health.not_read_by_policy_items
    ?? coverage.not_read_by_policy_items;
  const eligibleItems = row?.ingestion_health.answer_ready_eligible_items
    ?? coverage.answer_ready_eligible_items;
  if (!row) {
    const covered = coverage.indexed_items > 0;
    const coveragePercent = answerReadyPercent({
      indexedItems: coverage.indexed_items,
      contentReadyItems: coverage.content_ready_items,
      ...(notReadByPolicy !== undefined ? { notReadByPolicyItems: notReadByPolicy } : {}),
      ...(eligibleItems !== undefined ? { eligibleItems } : {}),
    });
    const stuck = queue.waiting + queue.needs_attention;
    const coverageText = coverageSentence(
      covered,
      coveragePercent,
      answerReadyEligibleItems(coverage.indexed_items, notReadByPolicy, eligibleItems),
    );
    const parts = [coverageText];
    parts.push(...(stuck > 0 ? [`${stuck} stuck`, 'drain state unknown'] : ['no stuck work']));
    return {
      coverage_percent: coveragePercent,
      stuck_count: stuck,
      drain_state: stuck > 0 ? 'unknown' : 'enabled',
      label: parts.join('; '),
    };
  }
  const stuck = row.ingestion_health.stuck_work.queued + row.ingestion_health.stuck_work.failed_retryable;
  const drain = row.ingestion_health.drain;
  const parts = [
    coverageSentence(
      row.items > 0,
      row.coverage_percent,
      answerReadyEligibleItems(row.items, notReadByPolicy, eligibleItems),
    ),
    stuck > 0 ? `${stuck} stuck` : 'no stuck work',
  ];
  if (row.ingestion_health.stuck_work.oldest_age_hours !== undefined) {
    parts.push(`oldest ${formatHours(row.ingestion_health.stuck_work.oldest_age_hours)}`);
  }
  if (drain.last_activity_hours !== undefined) {
    parts.push(`last drain ${formatHours(drain.last_activity_hours)} ago`);
  } else if (stuck > 0 && drain.state === 'unknown') {
    parts.push('drain state unknown');
  }
  if (throughput?.state === 'stalled') {
    parts.push(`content extraction stalled for ${formatHours(throughput.hours_without_terminal_progress ?? 0)}`);
  } else if (throughput?.state === 'warning') {
    parts.push(`content extraction slowing (${formatHours(throughput.hours_without_terminal_progress ?? 0)} without progress)`);
  }
  return {
    coverage_percent: row.items > 0 ? row.coverage_percent : 0,
    stuck_count: stuck,
    ...(row.ingestion_health.stuck_work.oldest_age_hours !== undefined
      ? { oldest_stuck_age_hours: row.ingestion_health.stuck_work.oldest_age_hours }
      : {}),
    ...(drain.last_activity_hours !== undefined ? { last_drain_activity_hours: drain.last_activity_hours } : {}),
    drain_state: drain.state,
    ...(drain.unit ? { drain_unit: drain.unit } : {}),
    label: parts.join('; '),
  };
}

/**
 * The coverage half of the health label.
 *
 * A source with items but nothing the policy lets it read gets words instead
 * of the number: its ratio is 100 because nothing was left unread, and
 * "100% covered" over a corpus with no readable file reads as the opposite of
 * what happened.
 */
function coverageSentence(covered: boolean, percent: number, eligibleItems: number): string {
  if (!covered) return 'Nothing ingested yet';
  if (eligibleItems <= 0) return capitalize(DASHBOARD_NONE_READ_BY_POLICY);
  return `${percent}% covered`;
}

/*
 * The "not read by policy" clause used to be appended here, right after
 * "88% covered". Owner ruling, 2026-08-23/24: the exclusion count must not sit
 * beside the percentage anywhere, and this label is read in the detail page's
 * foot and as a failing check's cause — both places a percentage is standing
 * next to it. The count now has exactly one home, the foot's own footnote line
 * in pages/detail.ts, which is also why it must not be repeated here: the foot
 * prints this label too, and the reader would have been told twice.
 *
 * coverageSentence still says it in words, with no number, when the policy
 * leaves nothing eligible at all — that is a fact about the corpus rather than
 * a count competing with the ratio.
 */
function capitalize(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function aggregateCoverage(cards: DashboardSourceCard[]): DashboardSourceCard['coverage'] {
  // Summed only across the corpora that report one, and left absent when none
  // do — the same absent-means-untouched rule the per-corpus reader follows.
  const notReadByPolicy = cards.reduce<number | undefined>((sum, card) => {
    const value = card.coverage.not_read_by_policy_items;
    return value === undefined ? sum : (sum ?? 0) + value;
  }, undefined);
  // Same absent-means-untouched rule. Summing only the corpora that publish an
  // eligible count means the aggregate denominator is the sum of exactly those
  // corpora's own denominators, never a mix of one corpus's eligible items and
  // another's indexed total.
  const eligibleItems = cards.reduce<number | undefined>((sum, card) => {
    const value = card.coverage.answer_ready_eligible_items;
    return value === undefined ? sum : (sum ?? 0) + value;
  }, undefined);
  // The per-file embedding count is present on the card only when EVERY
  // corpus holding items measures it. A partial sum over the card's whole
  // in-scope population would print an exact percentage the unmeasured
  // corpus was never counted toward.
  const measuring = cards.filter((card) => card.coverage.embedded_files !== undefined);
  const dataBearing = cards.filter((card) => card.coverage.indexed_items > 0);
  const embeddedFiles = measuring.length > 0 && dataBearing.every((card) => card.coverage.embedded_files !== undefined)
    ? measuring.reduce((sum, card) => sum + (card.coverage.embedded_files ?? 0), 0)
    : undefined;
  return cards.reduce((sum, card) => ({
    ...sum,
    indexed_items: sum.indexed_items + card.coverage.indexed_items,
    content_ready_items: sum.content_ready_items + card.coverage.content_ready_items,
    embedded_items: sum.embedded_items + card.coverage.embedded_items,
    needs_review_items: sum.needs_review_items + card.coverage.needs_review_items,
  }), {
    indexed_items: 0,
    content_ready_items: 0,
    embedded_items: 0,
    ...(embeddedFiles !== undefined ? { embedded_files: embeddedFiles } : {}),
    needs_review_items: 0,
    ...(notReadByPolicy !== undefined ? { not_read_by_policy_items: notReadByPolicy } : {}),
    ...(eligibleItems !== undefined ? { answer_ready_eligible_items: eligibleItems } : {}),
  });
}

function aggregateQueueHealth(
  cards: DashboardSourceCard[],
  _schedulers: SourceSchedulerSourceStatus[],
): DashboardSourceCard['queue_health'] {
  const waiting = cards.reduce((sum, card) => sum + card.queue_health.waiting, 0);
  const active = cards.reduce((sum, card) => sum + card.queue_health.active, 0);
  const needsAttention = cards.reduce((sum, card) => sum + card.queue_health.needs_attention, 0);
  const retryingTasks = cards.reduce((sum, card) => sum + (card.queue_health.retrying_tasks ?? 0), 0);
  const label = needsAttention > 0 || retryingTasks > 0
    ? 'Needs attention'
    : active > 0
      ? 'Working now'
      : waiting > 0
        ? 'Waiting to catch up'
        : 'Caught up';
  return { label, waiting, active, needs_attention: needsAttention, ...(retryingTasks > 0 ? { retrying_tasks: retryingTasks } : {}) };
}

function aggregateFreshness(
  cards: DashboardSourceCard[],
  schedulers: SourceSchedulerSourceStatus[],
  corpora: SourceIndexStatusCorpus[],
  definition: DashboardSupportedSourceDefinition,
  now: Date,
): DashboardSourceCard['freshness'] {
  const stale = cards.some((card) => card.freshness.stale) || schedulers.some((scheduler) => scheduler.stale_sync_anomaly);
  const schedulerHours = schedulers
    .map((scheduler) => scheduler.freshness_hours)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (schedulerHours.length > 0) {
    const hours = Math.min(...schedulerHours);
    const threshold = schedulers
      .map((scheduler) => scheduler.freshness_threshold_hours)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))[0];
    // freshness_hours is a raw float with a floor of 0, so interpolating it
    // produced "Last checked 0 hours ago" and "1 hours ago" directly under a
    // connection label phrasing the same timestamp in words.
    const checked = `Last checked ${relativeDurationFromHours(hours)}`;
    return {
      label: stale ? `${checked}; refresh is late` : checked,
      hours,
      ...(threshold !== undefined ? { threshold_hours: threshold } : {}),
      stale,
    };
  }
  const completedAt = latestCompletedAt(corpora);
  if (completedAt) {
    return { label: `Last checked ${relativeTime(completedAt, now)}`, stale };
  }
  // "answers questions directly, nothing to sync" is the answer-lane line, and
  // only a definition that can answer without syncing may claim it. Keying it
  // on connect_action.kind === 'api_key' hit Readwise — the only other api_key
  // source — and suppressed the counts on a card holding 250 documents.
  if (definition.answer_capable_without_sync) {
    return { label: 'Answer lane: answers questions directly, nothing to sync', stale };
  }
  // Items exist, so a sync did run; only its timestamp is missing.
  if (cards.some((card) => card.coverage.indexed_items > 0)) {
    return { label: 'Last check time not recorded', stale };
  }
  return { label: 'Waiting for first check', stale };
}

function aggregateTierComposition(
  cards: DashboardSourceCard[],
  definition: DashboardSupportedSourceDefinition,
  coverage: DashboardSourceCard['coverage'],
): DashboardSourceCard['tier_composition'] {
  if (cards.length === 0) {
    return [{
      trust_domain: definition.trust_domain,
      label: trustDomainLabel(definition.trust_domain),
      indexed_items: coverage.indexed_items,
      content_ready_items: coverage.content_ready_items,
    }];
  }
  const byTrust = new Map<string, { indexed_items: number; content_ready_items: number }>();
  for (const card of cards) {
    const existing = byTrust.get(card.trust_domain) ?? { indexed_items: 0, content_ready_items: 0 };
    existing.indexed_items += card.coverage.indexed_items;
    existing.content_ready_items += card.coverage.content_ready_items;
    byTrust.set(card.trust_domain, existing);
  }
  return [...byTrust.entries()].map(([trustDomain, counts]) => ({
    trust_domain: trustDomain,
    label: trustDomainLabel(trustDomain),
    indexed_items: counts.indexed_items,
    content_ready_items: counts.content_ready_items,
  }));
}

/**
 * The card's connection block, plus the one fact the state machine below has no
 * state for: what the provider said when it refused the last attempt.
 *
 * A refused attempt is kept on the pending record instead of being deleted, so
 * this is where it stops being "connecting" and becomes something the owner can
 * act on. The refusal rides beside the state rather than replacing it: the
 * source is not connected, and WHY the last try failed is a separate fact.
 */
function connectionFromDefinition(
  definition: DashboardSupportedSourceDefinition,
  registry: ConnectedHandleRegistry | undefined,
  credentialHealth: CredentialHealthReport | undefined,
  coverage: DashboardSourceCard['coverage'],
  queue: DashboardSourceCard['queue_health'],
  freshness: DashboardSourceCard['freshness'],
  syncRunning: boolean,
  oauthClientIds: Partial<Record<DashboardOAuthSource | 'google', string>>,
  oauthClientSecretAvailability: Partial<Record<DashboardOAuthSource | 'google', boolean>>,
  googleCloudProjectId: string | undefined,
  googlePilotClientConfigured: boolean,
  publisherOAuthSources: readonly DashboardOAuthSource[],
  oauthRedirectBaseUrl: string | undefined,
  apiKeyAvailability: Partial<Record<DashboardApiKeySource, boolean>>,
  pendingConnects: DashboardPendingConnect[],
  providerRefusing: boolean,
  now: Date,
  registryUnreadable: boolean,
  unpaired: DashboardUnpairedSourceState | undefined,
): DashboardSourceCard['connection'] {
  const pending = pendingForDefinition(definition, pendingConnects, now);
  const connection = connectionStateFromDefinition(
    definition,
    registry,
    credentialHealth,
    coverage,
    queue,
    freshness,
    syncRunning,
    oauthClientIds,
    oauthClientSecretAvailability,
    googleCloudProjectId,
    googlePilotClientConfigured,
    publisherOAuthSources,
    oauthRedirectBaseUrl,
    apiKeyAvailability,
    pending,
    providerRefusing,
    now,
    registryUnreadable,
    unpaired,
  );
  if (!pending?.error) return connection;
  const registration = definition.connect_action.kind === 'oauth'
    ? oauthCallbackRegistration(
      definition.connect_action.source,
      oauthRedirectBaseUrl,
      googleCloudProjectId,
      googlePilotClientConfigured,
    )
    : undefined;
  return {
    ...connection,
    provider_refusal: {
      code: pending.error.code,
      reason: providerRefusalReason(
        pending.error,
        registration?.redirect_uri,
        registration?.required === true ? registration.setting_label : undefined,
      ),
    },
  };
}

function connectionStateFromDefinition(
  definition: DashboardSupportedSourceDefinition,
  registry: ConnectedHandleRegistry | undefined,
  credentialHealth: CredentialHealthReport | undefined,
  coverage: DashboardSourceCard['coverage'],
  queue: DashboardSourceCard['queue_health'],
  freshness: DashboardSourceCard['freshness'],
  syncRunning: boolean,
  oauthClientIds: Partial<Record<DashboardOAuthSource | 'google', string>>,
  oauthClientSecretAvailability: Partial<Record<DashboardOAuthSource | 'google', boolean>>,
  googleCloudProjectId: string | undefined,
  googlePilotClientConfigured: boolean,
  publisherOAuthSources: readonly DashboardOAuthSource[],
  oauthRedirectBaseUrl: string | undefined,
  apiKeyAvailability: Partial<Record<DashboardApiKeySource, boolean>>,
  pending: DashboardPendingConnect | undefined,
  providerRefusing: boolean,
  now: Date,
  registryUnreadable: boolean,
  unpaired: DashboardUnpairedSourceState | undefined,
): DashboardSourceCard['connection'] {
  const handles = handlesForDefinition(definition, registry);
  const probeResults = credentialHealthForDefinition(definition, credentialHealth);
  const probeNeedsRepair = probeResults.some((result) =>
    (result.status === 'reauth_required' || result.status === 'missing')
    && !probeEvidencePredatesReconnect(result, handles, now));
  const reauthRequired = probeNeedsRepair
    || handles.some((handle) => backendStatus(handle) === 'reauth_required');
  const activeHandles = handles.filter((handle) => backendStatus(handle) !== 'reauth_required');
  // A source family with no broker-backed credential owns no registry handle to
  // count, so `activeHandles.length > 0` answered false for both chat sources on
  // every build: Telegram's mtproto login and WhatsApp's paired bridge live
  // outside the credential broker entirely. That false answer reached the live
  // page as "not connected — Pairing required" over a card holding 185k items
  // synced an hour ago, and — through the indexed-items exception in
  // vocabulary.ts — dropped both healthy chat cards into Needs you. A family
  // with no broker credential derives connection from its own sync evidence
  // instead. Owner ruling, 2026-08-19.
  const sessionEvidence = definition.connect_action.kind === 'guided_session'
    ? sessionConnectionEvidence(coverage, freshness)
    : undefined;
  const connected = definition.connect_action.kind === 'api_key'
    ? apiKeyAvailability[definition.connect_action.source] === true || activeHandles.length > 0
    : sessionEvidence !== undefined
      ? sessionEvidence !== 'none' || activeHandles.length > 0
      : activeHandles.length > 0;
  const handleIds = handles.map((handle) => handle.handle).sort((a, b) => a.localeCompare(b));
  // The most recent active grant: a reconnect restarts the first-sync clock,
  // and an older sibling handle must not hold it back. A timestamp that does
  // not parse, or that is in the future, is no evidence of anything and is
  // dropped rather than trusted -- the same rule the reconnect-vs-probe
  // comparison above already applies to this field.
  const connectedAtMs = activeHandles
    .map((handle) => Date.parse(handle.connectedAt))
    .filter((value) => Number.isFinite(value) && value <= now.getTime());
  const connectedAt = connectedAtMs.length > 0
    ? { connected_at: new Date(Math.max(...connectedAtMs)).toISOString() }
    : {};
  if (unpaired !== undefined) {
    // The one connection fact on this card that is known rather than inferred.
    // An Unpair changes nothing the session evidence above reads — the items
    // and their timestamps are exactly what they were — so leaving that
    // inference in charge would keep the card reading connected over a pairing
    // session this worker has just deleted. The action is the ordinary pairing
    // handoff, which is also the repair.
    //
    // An unfinished removal says so. The owner is the only one who can delete a
    // file this worker could not, and a plain "unpaired" over a session file
    // still on disk is the same false completion in a quieter voice — but the
    // paths themselves stay out of this label, because this model is served to
    // the read-only token that is promised none.
    // Same shape the unreadable handle registry already uses: the state stays
    // inside the vocabulary and the label says what is actually known. The file
    // is NOT named here — this model is served to the read-only token, which is
    // promised no paths; the control-session refusal names it instead.
    const label = unpaired.state === 'unpair_state_unreadable'
      ? 'unpair state unreadable'
      : unpaired.state === 'unpair_incomplete'
        ? 'Unpair incomplete — manual cleanup required'
        : 'unpaired';
    return {
      state: 'not_connected',
      label,
      action: sourceAction(definition, false, false, false, oauthClientIds, oauthClientSecretAvailability, googleCloudProjectId, googlePilotClientConfigured, publisherOAuthSources, oauthRedirectBaseUrl, 'none', pending),
      handles: handleIds,
    };
  }
  const action = sourceAction(definition, connected, reauthRequired, providerRefusing, oauthClientIds, oauthClientSecretAvailability, googleCloudProjectId, googlePilotClientConfigured, publisherOAuthSources, oauthRedirectBaseUrl, sessionEvidence, pending);
  // A refused attempt is no longer a handshake in flight. Leaving it in
  // awaiting_consent kept the row reading "connecting" for the rest of the
  // ten-minute record over a flow the provider had already rejected (owner,
  // 2026-09-03), so the card falls through to its real connection state and
  // carries the refusal beside it.
  if (pending && !pending.error && !connected) {
    // The consent attempt expires, and the browser window carrying it may
    // already be gone. Keeping the connect action here is what lets the owner
    // start over; the card used to carry action kind 'none' and render no
    // control at all, with the expiry computed and then dropped.
    return {
      state: 'awaiting_consent',
      label: 'awaiting browser consent',
      action,
      handles: handleIds,
      pending: {
        started_at: pending.started_at,
        expires_at: pending.expires_at,
        expires_in_minutes: Math.max(0, Math.ceil((Date.parse(pending.expires_at) - now.getTime()) / 60_000)),
      },
    };
  }
  if (reauthRequired) {
    return { state: 'reauth_required', label: 'reauth required', action, handles: handleIds };
  }
  // "not connected" is a claim about the handle registry, so it is exactly the
  // claim a caller that could not read that registry has no basis for. The
  // state stays inside the vocabulary — the card keeps the Connect control,
  // which is also the repair path — while the label says what is actually
  // known. Silently reporting an unreadable file as a disconnected source
  // would send an owner to reconnect a source that never left.
  const notConnectedLabel = registryUnreadable ? 'connection state unreadable' : 'not connected';
  if (!connected && !reauthRequired && action.kind === 'needs_setup') {
    // "needs one-time setup" was a status that read as a demand for a source
    // nobody had asked for. The state is the same one every unconnected source
    // is in; what this one additionally requires is an app key, and that fact
    // is the setup row's blurb, off the instructions. Owner ruling, 2026-08-18.
    return {
      state: 'needs_setup',
      label: notConnectedLabel,
      action,
      handles: handleIds,
    };
  }
  if (!connected && !reauthRequired) return { state: 'not_connected', label: notConnectedLabel, action, handles: handleIds };
  if (queue.active > 0 || queue.waiting > 0 || syncRunning) {
    return { state: 'syncing', label: 'syncing', action, handles: handleIds, ...connectedAt };
  }
  // A past sync proves a session existed; nothing readable here proves it still
  // does. Saying so is the honest middle between the false pairing alarm and a
  // confident "synced" over a timestamp outside this source's own window.
  if (sessionEvidence === 'unconfirmed') {
    return { state: 'connected', label: 'connected · live session not checked', action, handles: handleIds, ...connectedAt };
  }
  if (definition.answer_capable_without_sync) {
    return { state: 'connected', label: 'connected', action, handles: handleIds, ...connectedAt };
  }
  if (coverage.indexed_items === 0 && coverage.content_ready_items === 0) {
    return {
      state: 'waiting_for_first_sync',
      label: 'connected, waiting for first sync',
      action,
      handles: handleIds,
      ...connectedAt,
    };
  }
  const syncedAt = syncedRelativeLabel(freshness);
  return { state: 'synced', label: syncedAt ? `synced ${syncedAt}` : 'synced', action, handles: handleIds, ...connectedAt };
}

/**
 * What a source with no broker-backed credential can prove about its own
 * session, from fields this page already reads.
 *
 * There is no readable session surface for either chat source: the credential
 * health report probes Google, Readwise, Venice and X only, and the connected-
 * handle registry holds no entry for an mtproto login or a paired bridge. So
 * 'unconfirmed' is the honest ceiling for a card whose last sync sits outside
 * its own cadence window — the sync happened, and nothing here can say whether
 * the session behind it is still alive. Only a source with no sync evidence at
 * all reads as unpaired, which is the one state where pairing is the true ask.
 */
type DashboardSessionEvidence = 'in_cadence' | 'unconfirmed' | 'none';

function sessionConnectionEvidence(
  coverage: DashboardSourceCard['coverage'],
  freshness: DashboardSourceCard['freshness'],
): DashboardSessionEvidence {
  // A run merely in flight is deliberately NOT evidence: a run is marked
  // running before its authentication has succeeded, so counting it would
  // claim a session on the exact race this model exists to avoid (R61
  // finding 2). Only a completed sync proves anything, and an in-flight run
  // reaches the card as activity, never as connection.
  const hours = freshness.hours;
  const threshold = freshness.threshold_hours;
  const dated = typeof hours === 'number' && Number.isFinite(hours) && hours >= 0;
  // The cadence window is the source's own freshness threshold, and BOTH ends
  // must be real numbers: a missing or unbounded threshold proves nothing, so
  // it cannot promote a 42-day-old sync to a live session. `stale` is the
  // scheduler's separate anomaly verdict over the same timestamp, and either
  // one saying the check is late is enough to stop claiming a live session.
  const bounded = typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0;
  const inCadence = dated && bounded && !freshness.stale && (hours as number) <= threshold;
  if (inCadence) return 'in_cadence';
  // Items exist, so a sync ran at some point; only its recency is unprovable.
  if (dated || coverage.indexed_items > 0 || coverage.content_ready_items > 0) return 'unconfirmed';
  return 'none';
}

function sourceAction(
  definition: DashboardSupportedSourceDefinition,
  connected: boolean,
  reauthRequired: boolean,
  providerRefusing: boolean,
  oauthClientIds: Partial<Record<DashboardOAuthSource | 'google', string>>,
  oauthClientSecretAvailability: Partial<Record<DashboardOAuthSource | 'google', boolean>>,
  googleCloudProjectId: string | undefined,
  googlePilotClientConfigured: boolean,
  publisherOAuthSources: readonly DashboardOAuthSource[],
  oauthRedirectBaseUrl: string | undefined,
  sessionEvidence?: DashboardSessionEvidence,
  pending?: DashboardPendingConnect,
): DashboardSourceAction {
  // A refusing provider earns Reauthenticate even while the broker still reads the
  // handle as connected: the refusals are the fresher evidence.
  const label: 'Connect' | 'Reauthenticate' = reauthRequired || providerRefusing ? 'Reauthenticate' : 'Connect';
  if (definition.connect_action.kind === 'oauth') {
    if (connected && !reauthRequired && !providerRefusing) return { kind: 'none' };
    const knownClientId = oauthClientIdForSource(definition.connect_action.source, oauthClientIds);
    // X joined the secret-required set 2026-08-19: its app is a confidential
    // client and the token exchange authenticates with HTTP Basic. A Reauthenticate
    // offered without a stored secret would start a flow whose exchange is
    // doomed, so a missing secret routes to Set up instead.
    const clientSecretRequired = definition.connect_action.source === 'x';
    const hasClientSecret = !clientSecretRequired || oauthClientSecretAvailableForSource(definition.connect_action.source, oauthClientSecretAvailability);
    const redirectUriToRegister = oauthRedirectUriToRegister(definition.connect_action.source, oauthRedirectBaseUrl);
    const redirectUriGuidance = oauthRedirectUriGuidance(definition.connect_action.source, oauthRedirectBaseUrl);
    const callbackRegistration = oauthCallbackRegistration(
      definition.connect_action.source,
      oauthRedirectBaseUrl,
      googleCloudProjectId,
      googlePilotClientConfigured,
    );
    const redirectFields = {
      ...(redirectUriToRegister ? { redirect_uri_to_register: redirectUriToRegister } : {}),
      ...(redirectUriGuidance ? { redirect_uri_guidance: redirectUriGuidance } : {}),
      ...(callbackRegistration ? { callback_registration: callbackRegistration } : {}),
    };
    // Publisher mode outranks both branches below. There is no app key to
    // register, so "needs setup" is untrue, and no client id to correct, so a
    // prefilled field would be an invitation to break a working flow. The
    // bring-your-own path is not removed — it moves into the sheet's own
    // disclosure, carrying the identical walkthrough these fields feed.
    if (publisherOAuthSources.includes(definition.connect_action.source)) {
      return {
        kind: 'oauth',
        source: definition.connect_action.source,
        label,
        publisher_client: true as const,
        ...redirectFields,
        instructions: oauthSetupInstructions(definition.connect_action.source, googleCloudProjectId, oauthRedirectBaseUrl),
        ...(pending ? { pending_attempt: true as const } : {}),
      };
    }
    if (!knownClientId || !hasClientSecret) {
      return {
        kind: 'needs_setup',
        source: definition.connect_action.source,
        label: 'Set up',
        client_secret_required: clientSecretRequired,
        instructions: oauthSetupInstructions(definition.connect_action.source, googleCloudProjectId, oauthRedirectBaseUrl),
        ...redirectFields,
      };
    }
    // A registered client id no longer means there is nothing left to say. The
    // dashboard derives its callback from the origin it is reached on, so a
    // source whose key is on file can still be refused by every provider for a
    // redirect URI that was never registered — which is exactly what happened
    // to all four of the owner's sources the first time the page was served
    // over https (live, 2026-09-03). The instructions ride along so the row's
    // button opens a sheet that shows that URI and lets the client id be
    // changed, rather than starting the identical failing attempt again.
    return {
      kind: 'oauth',
      source: definition.connect_action.source,
      label,
      ...(knownClientId ? { known_client_id: knownClientId } : {}),
      ...redirectFields,
      instructions: oauthSetupInstructions(definition.connect_action.source, googleCloudProjectId, oauthRedirectBaseUrl),
      ...(pending ? { pending_attempt: true as const } : {}),
    };
  }
  if (definition.connect_action.kind === 'api_key') {
    if (connected && !reauthRequired && !providerRefusing) return { kind: 'none' };
    return {
      kind: 'api_key',
      source: definition.connect_action.source,
      label,
      instructions: apiKeySetupInstructions(definition.connect_action.source),
    };
  }
  return {
    kind: 'guided_session',
    source: definition.connect_action.source,
    label: guidedSessionLabel(connected, reauthRequired, sessionEvidence),
    instructions: definition.connect_action.instructions,
  };
}

/**
 * The pairing action's own word. 'Session ready' is only said where a sync
 * inside the cadence window backs it; a card connected on older evidence says
 * what it actually knows instead, and 'Pairing required' is left for the source
 * with no sync evidence at all.
 */
function guidedSessionLabel(
  connected: boolean,
  reauthRequired: boolean,
  sessionEvidence: DashboardSessionEvidence | undefined,
): 'Pairing required' | 'Session ready' | 'Session state not surfaced' {
  if (!connected || reauthRequired) return 'Pairing required';
  return sessionEvidence === 'unconfirmed' ? 'Session state not surfaced' : 'Session ready';
}

function oauthSetupInstructions(
  source: DashboardOAuthSource,
  googleCloudProjectId?: string,
  redirectBaseUrl?: string,
): DashboardSetupInstructions {
  const clientIdField: DashboardConnectField = {
    name: 'client_id',
    label: 'Client ID',
    required: true,
    secret: false,
  };
  const clientSecretField: DashboardConnectField = {
    name: 'client_secret',
    label: 'Client secret',
    required: true,
    secret: true,
  };
  if (isGoogleOAuthSource(source)) {
    const sourceLabel = source === 'google-drive' ? 'Google Drive' : source === 'google' ? 'Google' : 'Gmail';
    const sourceObject = source === 'google-drive' ? 'your Google Drive' : source === 'google' ? 'your Google data' : 'your Gmail';
    // Which client type the owner must create is decided by the origin this
    // dashboard is served on, not by an assumption. A Desktop app client can
    // only ever call back to loopback; the moment the page is reached over
    // https — behind `tailscale serve`, say — the same instructions send the
    // owner to build a client Google will refuse (live, 2026-09-03).
    const web = googleOAuthClientType(redirectBaseUrl) === 'web';
    const clientTypeName = web ? 'Web application' : 'Desktop app';
    const redirectClause = web
      ? `adding the redirect URI shown on the Olympus dashboard's ${sourceLabel} card to that client's Authorized redirect URIs`
      : 'confirming that Google accepts the loopback callback this dashboard uses without registering a redirect URI';
    return {
      // Factual only. "You stay in control" was reassurance and is gone; the
      // Google sentence stays because it states a checkable fact about the
      // consent screen. Owner ruling, 2026-08-18.
      plain_intro: `To read ${sourceObject} with the advanced BYO path, Olympus needs a Google ${clientTypeName} Client ID you create in your own Google account.${web ? ' Register the redirect URI shown on this card on that client.' : ''} PKCE protects the exchange, so there is no client secret to paste. Google shows you exactly what Olympus can see.`,
      agent_prompt: `Help me connect ${sourceLabel} to Olympus with my own Google client. Walk me through creating an OAuth client of type ${clientTypeName} in my Google Cloud project (console.cloud.google.com, APIs & Services, Credentials), enabling the ${sourceLabel} API, and ${redirectClause}. Then give me the Client ID so I can paste it into the Client ID field on that card and press Connect. PKCE protects the exchange, so no client secret is needed. Do not ask me to edit files, configuration, or code.`,
      provider_console_url: googleConsoleUrl('https://console.cloud.google.com/auth/clients', googleCloudProjectId),
      ...(googleCloudProjectId ? { google_cloud_project_id: googleCloudProjectId } : {}),
      diy_summary: 'Or set it up yourself (about 5 minutes)',
      diy_steps: [
        { text: 'Sign in to Google Cloud.', link: { label: 'Open Google OAuth clients', url: googleConsoleUrl('https://console.cloud.google.com/auth/clients', googleCloudProjectId) } },
        { text: 'Create or choose a project named Olympus.' },
        { text: 'Set the consent screen to External, then publish it to production. Testing mode stops working after 7 days.' },
        web
          ? { text: 'Create an OAuth client ID, choose Web application, and add the redirect URI shown on this card to its Authorized redirect URIs. A Desktop app client cannot register an https redirect URI.' }
          : { text: 'Create an OAuth client ID and choose Desktop app. Google accepts this dashboard\'s loopback callback with nothing to register.' },
        { text: 'Enable the Gmail API for this project. Sync returns 403 errors until the Gmail and Drive APIs are enabled.', link: { label: 'Open Gmail API', url: googleConsoleUrl('https://console.cloud.google.com/apis/library/gmail.googleapis.com', googleCloudProjectId) } },
        { text: 'Enable the Google Drive API for the same project.', link: { label: 'Open Google Drive API', url: googleConsoleUrl('https://console.cloud.google.com/apis/library/drive.googleapis.com', googleCloudProjectId) } },
        { text: 'Copy the Client ID shown in the popup. Olympus uses PKCE and does not need the client secret.' },
      ],
      secret_shown_once: false,
      fields: [clientIdField],
    };
  }
  if (source === 'dropbox') {
    return {
      plain_intro: 'To read your Dropbox files, Olympus needs your Dropbox App key (Dropbox\'s name for the OAuth client id), shown on the app\'s Settings tab in your Dropbox developer account. Dropbox uses PKCE here, so there is no app secret to paste.',
      agent_prompt: 'Help me connect Dropbox to Olympus. Walk me through creating a Dropbox app at https://www.dropbox.com/developers/apps (Scoped access, the folder access I want, named Olympus) or reusing my existing Olympus app, enabling the files.metadata.read and files.content.read permissions, and adding the redirect URI shown on the Olympus dashboard\'s Dropbox card under the app\'s OAuth 2 redirect URIs. Then give me the App key so I can paste it into the Client ID field on that card and press Connect. Dropbox uses PKCE, so no app secret is needed. Do not ask me to edit files, configuration, or code.',
      provider_console_url: 'https://www.dropbox.com/developers/apps',
      diy_summary: 'Or set it up yourself (about 5 minutes)',
      diy_steps: [
        { text: 'Sign in to Dropbox Developers.', link: { label: 'Open Dropbox apps', url: 'https://www.dropbox.com/developers/apps' } },
        { text: 'Create an app named Olympus, or choose the existing Olympus app.' },
        { text: 'Choose the access level you want Olympus to read.' },
        { text: 'Register the exact redirect URI shown on this card.' },
        { text: 'Copy the app key into the Client ID field. Dropbox uses PKCE here, so there is no client secret to paste.' },
      ],
      secret_shown_once: false,
      // Dropbox calls the client id the "App key"; the field says so, because a
      // reader holding an App key in their password manager did not know it
      // was the Client ID being asked for (owner, 2026-09-01).
      fields: [{ ...clientIdField, label: 'App key (Client ID)' }],
    };
  }
  return {
    plain_intro: 'To read your X bookmarks, Olympus needs an X app Client ID and Client secret you create once in your X developer account. X bookmark reads now require paid API access, so connect only after you accept X\'s costs.',
    agent_prompt: 'Help me connect X bookmarks to Olympus. Walk me through creating an app at https://console.x.com, opening the app\'s Settings (Authentication settings: App permissions Read, Type of App Web App, Automated App or Bot), adding the redirect URI shown on the Olympus dashboard\'s X bookmarks card under Callback URI / Redirect URL, saving, and finding the OAuth 2.0 Client ID and Client secret under Keys & Tokens so I can paste them into that card and press Connect. Remind me that reading bookmarks needs paid X API access before I start. Do not ask me to edit files, configuration, or code.',
    provider_console_url: 'https://console.x.com',
    diy_summary: 'Or set it up yourself (about 5 minutes)',
    diy_steps: [
      { text: 'Sign in to the X Developer Portal.', link: { label: 'Open X developer console', url: 'https://console.x.com' } },
      { text: 'Create or choose a project and app named Olympus.' },
      // The old step here said to use a public PKCE client with no secret.
      // The live app is a confidential client, and X's token endpoint demands
      // HTTP Basic from one — a secretless flow dies at the exchange with 401.
      { text: 'Open the app\'s Settings. Under Type of App choose Web App, Automated App or Bot (a Confidential client); under App permissions, Read is enough.' },
      { text: 'Under Callback URI / Redirect URL press Add another, paste the exact redirect URI shown on this card, and press Save Changes.' },
      { text: 'Back on Keys & Tokens, copy the OAuth 2.0 Client ID and Client secret into the fields below. X shows the secret once; Regenerate it if you no longer have it.' },
    ],
    secret_shown_once: true,
    fields: [clientIdField, clientSecretField],
  };
}

function apiKeySetupInstructions(source: DashboardApiKeySource): DashboardSetupInstructions {
  const tokenField: DashboardConnectField = {
    name: 'api_key',
    label: 'Token',
    required: true,
    secret: true,
  };
  if (source === 'readwise') {
    return {
      plain_intro: 'To import your Readwise library, Olympus needs a Readwise access token. Readwise shows the token on its access-token page; paste it into the field on this row.',
      agent_prompt: 'Help me connect Readwise to Olympus. Tell me where to find my Readwise access token (https://readwise.io/access_token) and to paste it into the field on the Olympus dashboard\'s Readwise row, then press Connect. Do not ask me to edit files, configuration, or code.',
      provider_console_url: 'https://readwise.io/access_token',
      diy_summary: 'Or get the token yourself (about 1 minute)',
      diy_steps: [
        { text: 'Sign in to Readwise.', link: { label: 'Open Readwise access token', url: 'https://readwise.io/access_token' } },
        { text: 'Copy the access token shown on the page.' },
        { text: 'Paste the token into the dashboard field below and click Connect.' },
      ],
      secret_shown_once: false,
      fields: [tokenField],
    };
  }
  return {
    plain_intro: 'To use Venice for approved private model lanes, Olympus needs a Venice API key. Venice issues the key in your account settings; paste it into the field on this row.',
    agent_prompt: 'Set up Venice for Olympus and walk me through it step by step.',
    provider_console_url: 'https://venice.ai',
    diy_summary: 'Or get the API key yourself (about 2 minutes)',
    diy_steps: [
      { text: 'Sign in to Venice.', link: { label: 'Open Venice', url: 'https://venice.ai' } },
      { text: 'Open your API key or developer settings.' },
      { text: 'Create or copy an API key, then paste it into the dashboard field below and click Connect.' },
    ],
    secret_shown_once: false,
    fields: [tokenField],
  };
}

function pendingForDefinition(
  definition: DashboardSupportedSourceDefinition,
  pendingConnects: DashboardPendingConnect[],
  now: Date,
): DashboardPendingConnect | undefined {
  if (definition.connect_action.kind !== 'oauth') return undefined;
  const matches = pendingConnects
    .filter((pending) => pending.source === definition.connect_action.source)
    .filter((pending) => {
      const expiresAt = Date.parse(pending.expires_at);
      return Number.isFinite(expiresAt) && expiresAt > now.getTime();
    })
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  return matches[0];
}

function isGoogleOAuthSource(source: DashboardOAuthSource | 'google'): boolean {
  return source === 'google' || source === 'gmail' || source === 'google-drive';
}

function googleConsoleUrl(baseUrl: string, projectId: string | undefined): string {
  if (!projectId) return baseUrl;
  return `${baseUrl}?project=${encodeURIComponent(projectId)}`;
}

function oauthClientIdForSource(
  source: DashboardOAuthSource,
  oauthClientIds: Partial<Record<DashboardOAuthSource | 'google', string>>,
): string | undefined {
  if (!isGoogleOAuthSource(source)) return oauthClientIds[source];
  return oauthClientIds[source]
    ?? oauthClientIds.google
    ?? oauthClientIds.gmail
    ?? oauthClientIds['google-drive'];
}

function oauthClientSecretAvailableForSource(
  source: DashboardOAuthSource,
  availability: Partial<Record<DashboardOAuthSource | 'google', boolean>>,
): boolean {
  if (!isGoogleOAuthSource(source)) return availability[source] === true;
  return availability[source] === true
    || availability.google === true
    || availability.gmail === true
    || availability['google-drive'] === true;
}

/**
 * The exact callback URI this dashboard will hand the provider.
 *
 * EVERY OAuth source gets one, Gmail and Google Drive included. They were
 * excluded here while the shipped Google instructions assumed a Desktop-app
 * client, whose loopback callback needs no registration — but the same
 * dashboard reached over https derives an https callback, and a Desktop-app
 * client cannot register one at all. The owner's live reauthorization failed on
 * exactly that for Google, Dropbox and X (2026-09-03).
 *
 * The path segment is the source value the connect action emits, which is what
 * the start route builds `/oauth/callback/<source>` from: `gmail` and
 * `google-drive` for the two Google cards, never the shared `google` key.
 *
 * This is the dashboard's own public origin plus a fixed path. It carries no
 * token, no path on disk and no secret, so it is safe on the read-only surface;
 * it is rendered only where the connect controls are.
 */
function oauthRedirectUriToRegister(source: DashboardOAuthSource, baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  return `${baseUrl.replace(/\/+$/, '')}/oauth/callback/${encodeURIComponent(source)}`;
}

/**
 * The one line telling the owner where that URI goes in this provider's own
 * console — or, for a Google loopback install, that it goes nowhere.
 */
function oauthRedirectUriGuidance(source: DashboardOAuthSource, baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  if (isGoogleOAuthSource(source)) {
    return googleOAuthClientType(baseUrl) === 'desktop'
      ? 'Desktop app client: Google accepts this loopback callback with no redirect URI to register.'
      : 'Web application client: add this exact URI to the client\'s Authorized redirect URIs. A Desktop app client cannot register an https redirect URI.';
  }
  if (source === 'dropbox') return 'Add this exact URI under OAuth 2 → Redirect URIs in the Dropbox app console.';
  return 'Add this exact URI under Settings → Callback URI / Redirect URL on the app\'s page in the X developer portal.';
}

/**
 * Which type of Google OAuth client this install actually needs.
 *
 * Google accepts a loopback http redirect only from a Desktop app client, and
 * accepts an https redirect only from a Web application client. The dashboard's
 * own origin decides which one the owner has to create, so the instructions
 * must follow it rather than assuming the local case. An unparseable or absent
 * base URL keeps the local default, which is the shipped install.
 */
function googleOAuthClientType(baseUrl: string | undefined): 'desktop' | 'web' {
  if (!baseUrl) return 'desktop';
  try {
    const parsed = new URL(baseUrl);
    const loopback = parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '[::1]';
    return parsed.protocol === 'http:' && loopback ? 'desktop' : 'web';
  } catch {
    return 'desktop';
  }
}

/**
 * The numbered walkthrough for one provider, built from the origin this
 * dashboard is actually served on.
 *
 * The console URL, the app requirements, the setting's exact name and what to
 * bring back are fixed text per provider; the only variable is this
 * dashboard's own callback URI and, for Google, which client type this origin
 * needs. Nothing here is derived from a provider response.
 */
function oauthCallbackRegistration(
  source: DashboardOAuthSource,
  baseUrl: string | undefined,
  googleCloudProjectId: string | undefined,
  googlePilotClientConfigured: boolean,
): DashboardCallbackRegistration | undefined {
  const redirectUri = oauthRedirectUriToRegister(source, baseUrl);
  if (redirectUri === undefined) return undefined;
  if (isGoogleOAuthSource(source)) {
    const apiName = source === 'google-drive'
      ? 'Google Drive'
      : source === 'google' ? 'Gmail and Google Drive' : 'Gmail';
    const desktop = googleOAuthClientType(baseUrl) === 'desktop';
    return {
      // A loopback callback is accepted without registration — by the packaged
      // pilot client, and by a Desktop app client the owner made themselves.
      // Sending them to a console screen to register something Google already
      // accepts is four steps of busywork on the ordinary local install.
      required: !desktop,
      ...(desktop
        ? {
          skip_note: googlePilotClientConfigured
            ? 'No registration needed on this machine. The packaged Google client already accepts this loopback callback.'
            : 'No registration needed on this machine. Google accepts this loopback callback from a Desktop app client.',
        }
        : {}),
      console: {
        label: 'Open Google Cloud credentials',
        url: googleConsoleUrl('https://console.cloud.google.com/apis/credentials', googleCloudProjectId),
      },
      app_requirements: desktop
        ? `Create or pick an OAuth client ID of type Desktop app, and enable the ${apiName} API for the same project.`
        : `Press Create credentials and choose OAuth client ID (on the Google Auth Platform Clients page the button is Create client). Set Application type to Web application: a Desktop app client cannot register an https redirect URI and shows no redirect URI section, so make a new Web client rather than reusing one. Separately, enable the ${apiName} API for the same project under APIs & Services → Library.`,
      setting_label: 'Authorized redirect URIs',
      redirect_uri: redirectUri,
      finish: desktop
        ? 'Copy the Client ID back into the field below and press Connect. PKCE protects the exchange, so there is no client secret to paste.'
        : 'Add it with + Add URI, press Create, then copy the Client ID from the confirmation dialog into the field below and press Connect. PKCE protects the exchange, so there is no client secret to paste.',
    };
  }
  if (source === 'dropbox') {
    return {
      required: true,
      console: { label: 'Open the Dropbox App Console', url: 'https://www.dropbox.com/developers/apps' },
      app_requirements: 'Create or pick a Scoped access app named Olympus, and give it the files.metadata.read and files.content.read permissions.',
      setting_label: 'OAuth 2 → Redirect URIs',
      redirect_uri: redirectUri,
      finish: 'Copy the App key back into the field below and press Connect. Dropbox uses PKCE here, so there is no app secret to paste.',
    };
  }
  return {
    required: true,
    console: { label: 'Open the X developer portal', url: 'https://console.x.com' },
    app_requirements: 'Create or pick an app, then press Settings on the app\'s page. Under App permissions choose Read, and under Type of App choose Web App, Automated App or Bot (a Confidential client). Reading bookmarks needs paid X API access.',
    setting_label: 'Callback URI / Redirect URL',
    redirect_uri: redirectUri,
    finish: 'Press Add another, paste it, and press Save Changes. Then press Back to Keys and, under Keys & Tokens, copy the OAuth 2.0 Client ID and Client secret into the fields below and press Connect. X shows the secret only once; press Regenerate if you no longer have it.',
  };
}

/**
 * The bounded sentence a card prints after a provider refused the attempt.
 *
 * The code is already allowlisted where it is recorded; everything else here
 * is this module's own text plus the dashboard's own callback URI.
 */
function providerRefusalReason(
  error: DashboardPendingConnectError,
  redirectUri: string | undefined,
  settingLabel: string | undefined,
): string {
  // The refusal names the same setting the walkthrough on the card names, so
  // the sentence and the steps under it cannot send the owner to two places.
  if (redirectUri && settingLabel) {
    return `Provider refused the callback (${error.code}): register ${redirectUri} at ${settingLabel}, then Connect again`;
  }
  const refusal = `Provider refused: ${error.code}`;
  return redirectUri
    ? `${refusal} — register ${redirectUri} with the provider, then try again`
    : `${refusal} — check the redirect URI registered on the provider app, then try again`;
}

function handlesForDefinition(
  definition: DashboardSupportedSourceDefinition,
  registry: ConnectedHandleRegistry | undefined,
): ConnectedCredentialHandle[] {
  if (!registry) return [];
  return registry.handles.filter((handle) => handle.provider === definition.provider);
}

function credentialHealthForDefinition(
  definition: DashboardSupportedSourceDefinition,
  report: CredentialHealthReport | undefined,
): CredentialHealthReport['results'] {
  if (!report) return [];
  return report.results.filter((result) =>
    result.source_ids.includes(definition.source_id) || result.provider === definition.provider);
}

/**
 * Whether a probe result is talking about a credential that no longer exists.
 *
 * The health report is written once a night. A one-click reconnect during the
 * day replaces the registry handle outright — new refresh token, new
 * `connectedAt`, no `backendState` — but nothing rewrites last night's report.
 * So a `reauth_required` result checked at 23:20 kept the Dropbox card
 * demanding a reconnect for the whole of the next day, over a credential the
 * owner had already reconnected at 09:38 and synced with (owner, 2026-09-04).
 * A probe whose evidence predates the connection it names proves nothing about
 * that connection, so it stops counting as a repair demand. It is disregarded,
 * not contradicted: the next nightly probe re-decides on fresh evidence.
 *
 * Handle-for-handle, because the report names the handle it probed and a
 * provider-wide match would let one reconnected account silence a sibling
 * account's real failure. A result carrying no handle falls back to the
 * definition's handles — the same set it was selected by.
 *
 * Both timestamps must parse. An unparseable one is no evidence of anything,
 * and today's behaviour (the probe counts) is the safe answer there.
 *
 * A `connectedAt` in the FUTURE is disregarded rather than trusted. This rule
 * silences a repair demand, so the timestamp that silences it is the one an
 * attacker or a broken clock would want to move: a handle dated 2099 would
 * outrank every probe this dashboard will ever read, permanently. The registry
 * is owner-owned local state, not hostile input, but a fact that cannot be true
 * is not evidence, and the same worker already refuses a control-session cookie
 * dated ahead of its own clock. Clamping to `now` would be the wrong repair —
 * it would make the impossible timestamp read as "connected this instant",
 * which is exactly the suppression being refused.
 */
function probeEvidencePredatesReconnect(
  result: CredentialHealthResult,
  handles: readonly ConnectedCredentialHandle[],
  now: Date,
): boolean {
  const checkedAt = Date.parse(result.checked_at);
  if (!Number.isFinite(checkedAt)) return false;
  const named = result.handle
    ? handles.filter((handle) => handle.handle === result.handle)
    : handles;
  return named.some((handle) => {
    const connectedAt = Date.parse(handle.connectedAt);
    if (!Number.isFinite(connectedAt) || connectedAt > now.getTime()) return false;
    return connectedAt > checkedAt;
  });
}

function backendStatus(handle: ConnectedCredentialHandle): string | undefined {
  return typeof handle.backendState?.status === 'string' ? handle.backendState.status : undefined;
}

function corpusSyncRunning(corpus: SourceIndexStatusCorpus): boolean {
  return recordProperty(corpus, 'last_refresh', 'status') === 'running'
    || recordProperty(corpus, 'last_sync', 'status') === 'running';
}

function latestCompletedAt(corpora: SourceIndexStatusCorpus[]): Date | undefined {
  const times = corpora
    .map((corpus) => {
      const completedAt = recordProperty(corpus, 'last_refresh', 'completed_at') ?? recordProperty(corpus, 'last_sync', 'completed_at');
      const time = completedAt ? Date.parse(completedAt) : Number.NaN;
      return Number.isFinite(time) ? time : undefined;
    })
    .filter((value): value is number => value !== undefined);
  if (times.length === 0) return undefined;
  return new Date(Math.max(...times));
}

// Undefined when nothing dates the last sync. The previous fallback was
// relativeTime(now, now), which by construction returns 'just now', so the
// absence of a timestamp was rendered as a confident "synced just now" over a
// detail line reading "Waiting for first check".
function syncedRelativeLabel(freshness: DashboardSourceCard['freshness']): string | undefined {
  if (typeof freshness.hours === 'number' && Number.isFinite(freshness.hours)) {
    return relativeDurationFromHours(freshness.hours);
  }
  const match = freshness.label.match(/^Last checked (.+?)(?:; refresh is late)?$/);
  return match?.[1];
}

function relativeTime(date: Date, now: Date): string {
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  return relativeDurationFromHours(minutes / 60);
}

function relativeDurationFromHours(hours: number): string {
  if (hours < 1) return 'less than 1 hour ago';
  if (hours < 24) {
    const rounded = Math.round(hours);
    return `${rounded} hour${rounded === 1 ? '' : 's'} ago`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function formatHours(hours: number): string {
  if (hours < 24) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

function recordProperty(value: object, key: string, nestedKey: string): string | undefined {
  const outer = (value as Record<string, unknown>)[key];
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) return undefined;
  const nested = (outer as Record<string, unknown>)[nestedKey];
  return typeof nested === 'string' ? nested : undefined;
}

function sourceCardFromCorpus(
  corpus: SourceIndexStatusCorpus,
  scheduler: SourceSchedulerSourceStatus | undefined,
  _history: SourceDashboardHistory | undefined,
  _now: Date,
): DashboardSourceCard {
  const counts = numericCounts(corpus);
  const provider = stringProperty(corpus, 'provider') ?? providerFromCorpusId(corpus.corpus_id);
  const sourceId = scheduler?.source_id ?? corpus.corpus_id;
  const queue = queueHealth(counts, scheduler);
  const coverage = coverageFromCounts(counts);
  const metadataSync = metadataSyncFromCounts(counts);
  const freshness = freshnessFrom(corpus, scheduler);
  const answerReadiness = answerReadinessFrom(
    corpus.configured,
    coverage,
    queue,
    freshness,
    operatorPausedTasks(scheduler),
  );
  return {
    corpus_id: corpus.corpus_id,
    source_id: sourceId,
    label: sourceLabel(provider, corpus.family, corpus.trust_domain),
    provider,
    family: corpus.family,
    trust_domain: corpus.trust_domain,
    configured: corpus.configured,
    freshness,
    coverage,
    needs_review: needsReviewFromCounts(coverage.needs_review_items, counts),
    ingestion_health: {
      coverage_percent: answerReadyPercent({
        indexedItems: coverage.indexed_items,
        contentReadyItems: coverage.content_ready_items,
        ...(coverage.not_read_by_policy_items !== undefined
          ? { notReadByPolicyItems: coverage.not_read_by_policy_items }
          : {}),
        ...(coverage.answer_ready_eligible_items !== undefined
          ? { eligibleItems: coverage.answer_ready_eligible_items }
          : {}),
      }),
      stuck_count: queue.waiting + queue.needs_attention,
      drain_state: 'unknown',
      label: 'Ingestion health unknown',
    },
    tier_composition: [{
      trust_domain: corpus.trust_domain,
      label: trustDomainLabel(corpus.trust_domain),
      indexed_items: coverage.indexed_items,
      content_ready_items: coverage.content_ready_items,
    }],
    queue_health: queue,
    answer_readiness: answerReadiness,
    connection: {
      state: corpus.configured ? 'waiting_for_first_sync' : 'not_connected',
      label: corpus.configured ? 'connected, waiting for first sync' : 'not connected',
      action: { kind: 'none' },
      handles: [],
    },
    ...(metadataSync ? { metadata_sync: metadataSync } : {}),
  };
}

/**
 * Whether this corpus's own scheduler reports a lane Olympus parked itself.
 *
 * The definition-level card reads the same marker off its merged schedule;
 * this is the single-corpus reading of it, so a corpus card and the card that
 * aggregates it cannot disagree about who stopped the lane.
 */
function operatorPausedTasks(scheduler: SourceSchedulerSourceStatus | undefined): boolean {
  return (scheduler?.tasks ?? []).some((task) =>
    task.degraded_reason !== undefined && OPERATOR_PAUSED_SCHEDULER_MARKERS.has(task.degraded_reason));
}

function numericCounts(corpus: SourceIndexStatusCorpus): Record<string, number> {
  const raw = 'counts' in corpus ? corpus.counts : undefined;
  if (!raw) return {};
  const output: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) output[key] = Math.max(0, Math.trunc(value));
  }
  return output;
}

function coverageFromCounts(counts: Record<string, number>): DashboardSourceCard['coverage'] {
  const indexedItems = firstCount(counts, ['indexed_items', 'files', 'reader_documents']) + firstCount(counts, ['folders'], 0);
  // Items-with-text is the "ready" unit, and the ONLY unit: a chunk count is
  // not a per-item readiness count and may not be substituted for one. One PDF
  // yields many chunks, so min(items, chunks) reaches the item count as soon as
  // the average item has produced a single chunk — 100k Dropbox files with 20k
  // of them extracted read as 100% answer-ready, which is the 2026-08-21
  // saturation. Summing per-tier chunks was wrong in the other direction too:
  // it counted an item and its own chunks twice (readwise: 250 items -> "500
  // ready").
  //
  // So a corpus that publishes no per-item ready count is UNKNOWN, and unknown
  // resolves to 0 rather than to the most optimistic bound the chunk count
  // permits. Understating asks someone to look; overstating tells them to stop
  // looking, and the one headline percentage means fully-working over the files
  // Olympus is supposed to handle.
  //
  // qa_pass is the ladder's per-item ready verdict, the same count the ingestion
  // ledger prefers, so the card and the health line agree.
  const contentReadyItems = firstCount(
    counts,
    ['files_with_text', ITEMS_WITH_TEXT_COUNT_KEY, 'qa_pass'],
    0,
  );
  const embeddedItems = firstCount(counts, ['embedded_chunks'], 0);
  // Per-item parity, published by the connector store as `items_embedded`
  // (see ITEMS_EMBEDDED_COUNT_KEY in source-index/status.ts). Absent stays
  // absent: a missing count is "not measured", never zero.
  const embeddedFiles = counts[ITEMS_EMBEDDED_COUNT_KEY];
  const needsReviewItems = sumCounts(counts, DASHBOARD_NEEDS_REVIEW_REASONS.map((reason) => reason.count_key));
  const notReadByPolicy = notReadByPolicyFromCounts(counts);
  const eligibleItems = answerReadyEligibleFromCounts(counts);
  return {
    indexed_items: indexedItems,
    content_ready_items: contentReadyItems,
    embedded_items: embeddedItems,
    ...(embeddedFiles !== undefined ? { embedded_files: embeddedFiles } : {}),
    needs_review_items: needsReviewItems,
    ...(notReadByPolicy !== undefined ? { not_read_by_policy_items: notReadByPolicy } : {}),
    ...(eligibleItems !== undefined ? { answer_ready_eligible_items: eligibleItems } : {}),
  };
}

/**
 * The folder walk behind the metadata-sync bar, or undefined when this corpus
 * publishes none of it.
 *
 * Presence is decided by the two keys that carry the walk's own denominator and
 * numerator: a corpus reporting only failures has no walk to draw. The failed
 * count merges the three ways a folder stops being retried, because the bar
 * needs one "will not complete" number and the split is a Checks-level detail.
 */
function metadataSyncFromCounts(counts: Record<string, number>): DashboardMetadataSync | undefined {
  const hasWalk = counts.metadata_sync_folders_total !== undefined
    || counts.metadata_sync_folders_visited !== undefined;
  if (!hasWalk) return undefined;
  return {
    folders_total: firstCount(counts, ['metadata_sync_folders_total'], 0),
    folders_visited: firstCount(counts, ['metadata_sync_folders_visited'], 0),
    folders_pending: firstCount(counts, ['metadata_sync_folders_pending'], 0),
    folders_failed: sumCounts(counts, [
      'metadata_sync_folders_retryable_failed',
      'metadata_sync_folders_exhausted_retry',
      'metadata_sync_folders_failed',
    ]),
    folders_blocked: firstCount(counts, ['metadata_sync_folders_blocked'], 0),
  };
}

/** Summed across the corpora that report a walk; absent when none does. */
function aggregateMetadataSync(cards: DashboardSourceCard[]): DashboardMetadataSync | undefined {
  return cards.reduce<DashboardMetadataSync | undefined>((sum, card) => {
    const walk = card.metadata_sync;
    if (!walk) return sum;
    if (!sum) return { ...walk };
    return {
      folders_total: sum.folders_total + walk.folders_total,
      folders_visited: sum.folders_visited + walk.folders_visited,
      folders_pending: sum.folders_pending + walk.folders_pending,
      folders_failed: sum.folders_failed + walk.folders_failed,
      folders_blocked: sum.folders_blocked + walk.folders_blocked,
    };
  }, undefined);
}

function queueHealth(
  counts: Record<string, number>,
  scheduler: SourceSchedulerSourceStatus | undefined,
): DashboardSourceCard['queue_health'] {
  const taskCounts = schedulerTaskCounts(scheduler);
  const mergedCounts = { ...counts, ...taskCounts };
  const liveWaiting = liveQueueCount(
    counts,
    ['extraction_jobs_queued_actionable', 'extraction_jobs_queued'],
    ['jobs_enqueued', 'jobs_queued'],
  );
  const waiting = (liveWaiting >= 0 ? liveWaiting : sumCounts(taskCounts, ['jobs_enqueued', 'jobs_queued']))
    + sumCounts(counts, [
      'metadata_sync_folders_pending',
      'qa_pending',
    ]);
  const liveActive = liveQueueCount(
    counts,
    ['extraction_jobs_leased_current_actionable', 'extraction_jobs_leased_current', 'extraction_jobs_leased'],
    ['jobs_leased'],
  );
  const activeFromCounts = liveActive >= 0 ? liveActive : sumCounts(taskCounts, ['jobs_leased']);
  const active = activeFromCounts + (scheduler?.tasks.filter((task) => task.running).length ?? 0);
  // consecutive_failures counts how many times one task retried, not how many
  // items are affected. It is uncapped and persisted, so summing it into an
  // item count made the displayed severity a function of elapsed time: one task
  // retrying for a day read as hundreds of broken items next to "0 found". The
  // signal is kept as a count of tasks, which is a real quantity.
  const retryingTasks = scheduler?.tasks.filter((task) => task.consecutive_failures > 0).length ?? 0;
  const extractionFailures = firstCount(mergedCounts, [
    'extraction_jobs_failed_actionable',
    'extraction_jobs_failed',
  ]);
  // `qa_blocked_policy` is deliberately absent. A privacy-fenced file is the
  // fence working exactly as configured — there is no retry, no reconnect and
  // no operator decision behind it, and the ~60 fenced entries on the live
  // Dropbox would otherwise pin that card to Needs attention forever with
  // nothing to press. It is the same ruling that took those files out of the
  // answer-ready denominator (2026-08-21): a file the system deliberately does
  // not read cannot be counted as unread work in one place and as
  // deliberately-not-read in another, which is precisely the header-versus-
  // detail contradiction the 2026-08-19 honesty rulings exist to stop.
  //
  // Absent from the ladder is not absent from the page: the count still prints
  // through coverage.not_read_by_policy_items — POLICY_NOT_READ_COUNT_KEYS
  // carries this key — so the card states the fenced files in plain language
  // instead of alarming about them.
  //
  // `metadata_sync_folders_blocked` stays: a folder Dropbox refuses to hand
  // over is a sync that did not happen, not a fence the owner asked for.
  const needsAttention = extractionFailures + sumCounts(mergedCounts, [
    'metadata_sync_folders_retryable_failed',
    'metadata_sync_folders_exhausted_retry',
    'metadata_sync_folders_blocked',
    'metadata_sync_folders_failed',
    'qa_failed_needs_operator',
  ]);
  const label = needsAttention > 0 || retryingTasks > 0
    ? 'Needs attention'
    : active > 0
      ? 'Working now'
      : waiting > 0
        ? 'Waiting to catch up'
        : 'Caught up';
  return { label, waiting, active, needs_attention: needsAttention, ...(retryingTasks > 0 ? { retrying_tasks: retryingTasks } : {}) };
}

// The store's own queue depth, or -1 when the corpus reports none. The
// scheduler's last_result carries the same key names, but those are the LAST
// RUN's deltas and those jobs are already inside the store's gauge: adding both
// counted the same work twice, and last_result persists between runs, so a
// drained source stayed "syncing" forever. Scheduler counts are a fallback for
// corpora that report no queue depth, never an addition to one.
function liveQueueCount(counts: Record<string, number>, gaugeKeys: string[], jobKeys: string[]): number {
  const gauge = firstCount(counts, gaugeKeys, -1);
  const jobs = jobKeys.some((key) => counts[key] !== undefined) ? sumCounts(counts, jobKeys) : -1;
  if (gauge < 0 && jobs < 0) return -1;
  return Math.max(gauge, 0) + Math.max(jobs, 0);
}

function schedulerTaskCounts(scheduler: SourceSchedulerSourceStatus | undefined): Record<string, number> {
  const output: Record<string, number> = {};
  for (const task of scheduler?.tasks ?? []) {
    const counts = task.last_result?.counts;
    if (!counts) continue;
    for (const [key, value] of Object.entries(counts)) {
      if (typeof value === 'number' && Number.isFinite(value)) output[key] = (output[key] ?? 0) + Math.max(0, Math.trunc(value));
    }
  }
  return output;
}

function freshnessFrom(
  corpus: SourceIndexStatusCorpus,
  scheduler: SourceSchedulerSourceStatus | undefined,
): DashboardSourceCard['freshness'] {
  const hours = scheduler?.freshness_hours;
  const threshold = scheduler?.freshness_threshold_hours;
  const stale = scheduler?.stale_sync_anomaly === true;
  if (hours !== undefined) {
    const checked = `Last checked ${relativeDurationFromHours(hours)}`;
    return {
      label: stale ? `${checked}; refresh is late` : checked,
      hours,
      ...(threshold !== undefined ? { threshold_hours: threshold } : {}),
      stale,
    };
  }
  const completedAt = corpus.last_refresh?.completed_at;
  if (completedAt) {
    return { label: 'Recently checked', stale: false };
  }
  return { label: corpus.configured ? 'Waiting for first check' : 'Not connected yet', stale: false };
}

/**
 * How much staleness one operator pause can account for, beyond the source's
 * own freshness deadline.
 *
 * The daily guards clear at the 00:00 UTC rollover and a provider rate limit
 * clears sooner, so a park explains at most one missed day of checks. A lane
 * still stale after that has been parked across rollovers without recovering,
 * which the park no longer explains, and the card says so again.
 */
const OPERATOR_PARK_EXPLAINS_STALENESS_HOURS = 24;

/**
 * True when the pause accounts for how late this refresh is.
 *
 * An unmeasurable staleness — flagged with no hours behind it — counts as
 * explained: there is no evidence of "far beyond", and the pause is the one
 * fact about the lane that is current.
 */
function parkExplainsStaleness(freshness: DashboardSourceCard['freshness']): boolean {
  const hours = freshness.hours;
  if (typeof hours !== 'number' || !Number.isFinite(hours)) return true;
  const threshold = freshness.threshold_hours;
  const deadline = typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : 0;
  return hours <= deadline + OPERATOR_PARK_EXPLAINS_STALENESS_HOURS;
}

/**
 * The card's readiness word, with the operator pause taken into account.
 *
 * `operatorPaused` means Olympus parked this lane itself — a daily budget or a
 * provider rate limit, the OPERATOR_PAUSED_SCHEDULER_MARKERS set. Nothing is
 * waiting on the reader then, and the index still answers questions from what
 * it already holds, so a parked lane with ready content must not shout "Needs
 * attention before answers" over a detail page that says nothing is waiting on
 * you (live defect, 2026-08-21; the 2026-08-19 honesty fix reached the connect
 * control and the detail sentence but not this ladder).
 *
 * Two causes the park absorbs, and one it does not:
 * - Retrying tasks are absorbed. A parked lane's failure count is history — the
 *   guard stopped it carrying whatever error it last recorded on the way in —
 *   and detail.ts refuses to translate that same stale kind for exactly this
 *   reason. Re-arming on it would restore the contradiction from the other end.
 * - Staleness is absorbed only as far as a pause can reach; see
 *   parkExplainsStaleness.
 * - Items needing attention are NOT absorbed. Failed extraction jobs and
 *   blocked folders are real work that outlives the rollover, so a parked lane
 *   with genuine failures still reads needs_attention.
 */
function answerReadinessFrom(
  configured: boolean,
  coverage: DashboardSourceCard['coverage'],
  queue: DashboardSourceCard['queue_health'],
  freshness: DashboardSourceCard['freshness'],
  operatorPaused = false,
): DashboardSourceCard['answer_readiness'] {
  if (!configured) return { state: 'disconnected', label: 'Connect this source' };
  const staleUnexplained = freshness.stale && !(operatorPaused && parkExplainsStaleness(freshness));
  const retryingUnexplained = !operatorPaused && (queue.retrying_tasks ?? 0) > 0;
  if (staleUnexplained || queue.needs_attention > 0 || retryingUnexplained) {
    return { state: 'needs_attention', label: 'Needs attention before answers' };
  }
  if (coverage.content_ready_items > 0 || coverage.embedded_items > 0) {
    return operatorPaused
      ? { state: 'ready', label: 'Ready for questions; sync paused' }
      : { state: 'ready', label: 'Ready for questions' };
  }
  if (queue.waiting > 0 || queue.active > 0) return { state: 'syncing', label: 'Syncing now' };
  if (coverage.indexed_items > 0) return { state: 'syncing', label: 'Preparing answer-ready text' };
  return { state: 'empty', label: 'Waiting for the first sync' };
}

function unassignedCorporaFrom(
  corpora: SourceIndexStatusCorpus[],
  schedulerByCorpus: Map<string, SourceSchedulerSourceStatus>,
  now: Date,
): DashboardUnassignedCorpora {
  const entries = corpora.map((corpus): DashboardUnassignedCorpus => {
    const card = sourceCardFromCorpus(corpus, schedulerByCorpus.get(corpus.corpus_id), undefined, now);
    return {
      corpus_id: corpus.corpus_id,
      trust_domain: corpus.trust_domain,
      label: card.label,
      indexed_items: card.coverage.indexed_items,
      content_ready_items: card.coverage.content_ready_items,
    };
  });
  return {
    corpus_count: entries.length,
    indexed_items: entries.reduce((sum, entry) => sum + entry.indexed_items, 0),
    content_ready_items: entries.reduce((sum, entry) => sum + entry.content_ready_items, 0),
    entries,
  };
}

/**
 * Fold the ledger's excluded-folder section into the page's counts-and-rule-ids
 * shape. The ledger reports one entry per configured folder; this page reports
 * one entry per rule with how many folders sit under it, which keeps the rule
 * id the owner recognizes without carrying a path.
 */
function excludedByConfigurationFrom(
  excluded: SourceIngestionExcludedByConfiguration | undefined,
): DashboardExcludedByConfiguration {
  return {
    rules: excluded?.rules ?? 0,
    prefixes: excluded?.prefixes ?? 0,
    items_present: excluded?.items_present ?? 0,
    items_unevaluable: excluded?.items_unevaluable ?? 0,
    entries: excludedRulesFrom(excluded?.entries),
    metadata_only_rules: excluded?.metadata_only_rules ?? 0,
    metadata_only_prefixes: excluded?.metadata_only_prefixes ?? 0,
    items_metadata_only_content_present: excluded?.items_metadata_only_content_present ?? 0,
    ...(excluded?.unenforceable_rule_ids?.length
      ? { unenforceable_rule_ids: [...excluded.unenforceable_rule_ids] }
      : {}),
    ...(excluded?.by_source
      ? { by_source: excluded.by_source.map(excludedSourceFrom) }
      : {}),
  };
}

/**
 * Fold the ledger's one-row-per-folder list into one row per rule.
 *
 * `prefix`, `folderName` and `reason` are dropped here and nowhere carried
 * onward: prefixes and folder names are the owner's real paths, `reason` is
 * free text that routinely repeats them, and this view model declares
 * `file_paths_returned: false` while being reachable with the weak `dash_`
 * query token. The bearer-gated picker at /dashboard/dispositions stays the one
 * place a path appears.
 */
function excludedRulesFrom(
  entries: SourceIngestionExcludedByConfiguration['entries'] | undefined,
): DashboardExcludedRule[] {
  const byRule = new Map<string, { prefixes: number; modes: Set<string>; kinds: Set<string> }>();
  for (const entry of entries ?? []) {
    const existing = byRule.get(entry.rule_id) ?? { prefixes: 0, modes: new Set<string>(), kinds: new Set<string>() };
    existing.prefixes += 1;
    if (entry.mode) existing.modes.add(entry.mode);
    if (entry.kind) existing.kinds.add(entry.kind);
    byRule.set(entry.rule_id, existing);
  }
  return Array.from(byRule, ([rule_id, rule]) => ({
    rule_id,
    prefixes: rule.prefixes,
    modes: [...rule.modes].sort(),
    kinds: [...rule.kinds].sort(),
  }));
}

function excludedSourceFrom(
  source: SourceIngestionExcludedBySource,
): DashboardExcludedSource {
  return {
    corpus_ids: [...source.corpus_ids],
    ...(source.source_id !== undefined ? { source_id: source.source_id } : {}),
    rules: source.rules,
    prefixes: source.prefixes,
    metadata_only_prefixes: source.metadata_only_prefixes,
    items_present: source.items_present,
    items_unevaluable: source.items_unevaluable,
    items_metadata_only_content_present: source.items_metadata_only_content_present,
    ...(source.unenforceable_rule_ids?.length
      ? { unenforceable_rule_ids: [...source.unenforceable_rule_ids] }
      : {}),
    entries: excludedRulesFrom(source.entries),
  };
}

/**
 * The owner's secure categories, minus everything that would leak.
 *
 * `interpretation` is the owner's own `examples` list joined — authored by them,
 * capped at 12 by the parser and never empty. The match terms are counted and
 * not carried, and `notes` is dropped outright: both hold real sender addresses
 * and folder paths.
 */
function sensitivityFrom(map: SensitivityMap | undefined): DashboardSensitivity | undefined {
  if (!map) return undefined;
  return {
    configured: true,
    editable: false,
    categories: map.categories.map((category) => ({
      id: category.id,
      label: category.label,
      interpretation: category.examples.join(', '),
      target_tier_name: category.targetTierName,
      target_trust_tier: category.targetTrustTier,
      target_trust_domain: category.targetTrustDomain,
      match_terms: category.match.keywords.length
        + category.match.senderPatterns.length
        + category.match.pathPatterns.length,
    })),
  };
}

/**
 * The needs-review total with the reasons it was summed from.
 *
 * `total` is handed in rather than recomputed: it is `coverage.needs_review_items`
 * itself, so the breakdown can never contradict the number beside it. When the
 * reasons do not add up to that total the reasons are dropped and the total
 * stands alone — that happens where a custodial superset's counts are reduced by
 * its band corpora, and a breakdown that had been scaled to fit would be a
 * number nothing measured.
 */
function needsReview(
  total: number,
  read: (reason: (typeof DASHBOARD_NEEDS_REVIEW_REASONS)[number]) => number,
): DashboardNeedsReview {
  const reasons = DASHBOARD_NEEDS_REVIEW_REASONS
    .map((reason) => ({
      key: reason.key,
      label: reason.label,
      count: read(reason),
      who_acts: reason.who_acts,
      actor_note: reason.actor_note,
    }))
    .filter((reason) => reason.count > 0);
  const attributed = reasons.reduce((sum, reason) => sum + reason.count, 0);
  // An unattributable total gets no split for the same reason it gets no
  // reasons: the halves would be a number nothing measured, and "194 need you"
  // is exactly the kind of claim that must never be estimated.
  if (attributed !== total) return { total, automatic_total: 0, operator_total: 0, reasons: [] };
  return { total, ...needsReviewSplit(reasons), reasons };
}

/** The two halves, summed from the reasons themselves so they cannot drift. */
function needsReviewSplit(
  reasons: readonly DashboardNeedsReviewReason[],
): { automatic_total: number; operator_total: number } {
  let automatic = 0;
  let operator = 0;
  for (const reason of reasons) {
    if (reason.who_acts === 'automatic') automatic += reason.count;
    else operator += reason.count;
  }
  return { automatic_total: automatic, operator_total: operator };
}

/** From a corpus's own count bag, which is keyed by the internal count names. */
function needsReviewFromCounts(total: number, counts: Record<string, number>): DashboardNeedsReview {
  return needsReview(total, (reason) => counts[reason.count_key] ?? 0);
}

/** From an already-published breakdown, which is keyed by this page's own ids. */
function needsReviewFromReasonCounts(total: number, counts: Record<string, number>): DashboardNeedsReview {
  return needsReview(total, (reason) => counts[reason.key] ?? 0);
}

/** Sum cards' needs-review reasons back into a bag keyed by published reason id. */
function needsReviewCounts(cards: DashboardSourceCard[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const card of cards) {
    for (const reason of card.needs_review?.reasons ?? []) {
      counts[reason.key] = (counts[reason.key] ?? 0) + reason.count;
    }
  }
  return counts;
}

function summarize(
  cards: DashboardSourceCard[],
  unassigned: DashboardUnassignedCorpora,
): SourceDashboardViewModel['summary'] {
  return {
    configured_sources: cards.length,
    connected_sources: cards.filter((card) => card.configured).length,
    answer_ready_sources: cards.filter((card) => card.answer_readiness.state === 'ready').length,
    needs_attention_sources: cards.filter((card) => card.answer_readiness.state === 'needs_attention').length,
    // Items found counts everything indexed, including corpora no card owns.
    total_indexed_items: cards.reduce((sum, card) => sum + card.coverage.indexed_items, 0)
      + unassigned.indexed_items,
    total_content_ready_items: cards.reduce((sum, card) => sum + card.coverage.content_ready_items, 0)
      + unassigned.content_ready_items,
  };
}

function onboarding(
  summary: SourceDashboardViewModel['summary'],
  sourceCards: DashboardSourceCard[],
  folderPicker: DashboardFolderPicker,
): SourceDashboardViewModel['onboarding'] {
  const connected = summary.connected_sources > 0;
  // Tie the first sync to a source that is actually connected. The index-wide
  // total also counts corpora belonging to sources that were never connected,
  // which used to tick this step green above an unfinished step 1.
  const firstSync = sourceCards.some((card) => card.configured && card.coverage.indexed_items > 0);
  const answerReady = sourceCards.some((card) =>
    card.answer_readiness.state === 'ready' && card.coverage.content_ready_items > 0
  );
  // trustDomainCards always returns the same three cards, so their count says
  // nothing. The step is done once a trust domain actually holds items.
  const configuredCards = sourceCards.filter((card) => card.configured);
  const dependenciesProven = configuredCards.some((card) => card.setup?.dependencies.every((dependency) => dependency.status === 'ready'));
  const fileScopeNeeded = configuredCards.some((card) => card.family === 'file');
  const scopeReady = folderPicker.rules > 0 || (connected && !fileScopeNeeded);
  const sourceHealthy = sourceCards.some((card) => card.setup?.condition === 'usable' && card.setup.stage !== 'initial_sync');
  // Each entry carries only its own evidence — `complete` means "this stage
  // cleared", nothing more. withActiveStep turns that evidence into the ladder
  // the page renders; deriving a rendered state per stage here is what made the
  // rows non-monotonic.
  const cleared = (stageCleared: boolean) => stageCleared ? 'complete' as const : 'pending' as const;
  return {
    steps: withActiveStep([
      { id: 'security_preset', label: 'Security preset', state: 'complete', next_action: 'Change the preset only through supported Olympus configuration.' },
      { id: 'dependencies', label: 'Dependency check', state: cleared(dependenciesProven), next_action: 'Choose a source below, run Olympus doctor, and repair only that source’s declared dependency.' },
      { id: 'credential_or_pairing', label: 'Credential or pairing', state: cleared(connected), next_action: 'Connect one account or finish the local pairing instructions below.' },
      { id: 'scope', label: 'Scope', state: cleared(scopeReady), next_action: folderPicker.available ? 'Open scope rules to author and preview what Olympus may read.' : 'Confirm the contextual provider scope shown on the source card.' },
      { id: 'initial_sync', label: 'Initial sync', state: cleared(firstSync), next_action: initialSyncAdvice(configuredCards) },
      { id: 'source_health', label: 'Usable, degraded, or blocked', state: cleared(sourceHealthy), next_action: 'Follow the source card’s named next action until coverage and gaps are truthful.' },
      { id: 'cited_answer_readiness', label: 'Cited-answer readiness', state: cleared(answerReady), next_action: 'Ask a question and verify claim-level citations plus any stated gaps.' },
    ]),
    ask_first_question: {
      enabled: answerReady,
      label: 'Ask your first question',
      suggestion: answerReady
        ? 'Your assistant can now answer a question using the ready sources.'
        : 'This unlocks as soon as one connected source has answer-ready text.',
    },
  };
}

/**
 * What the initial-sync step tells the reader to do.
 *
 * Sync now is only advice where some connected source can actually run it. On a
 * worker with no scheduler and no host hook, every press answers 501, and the
 * ladder was sending the reader at a button that could only refuse.
 */
function initialSyncAdvice(configuredCards: readonly DashboardSourceCard[]): string {
  const answered = configuredCards.filter((card) => card.sync_now_available !== undefined);
  const anySyncable = answered.length === 0
    || answered.some((card) => card.sync_now_available === true);
  return anySyncable
    ? 'Start Sync now and keep the worker running; do not restart for setup changes.'
    : 'Keep the worker running; this worker has no Sync now, so connected sources sync on their own schedule.';
}

/**
 * Walkthrough invariant: the rendered states are monotonic — completed stages,
 * then exactly one `active` stage, then pending ones. The list can never render
 * as inert rows with nothing highlighted, and never as a greyed `pending` row
 * sitting above a stage that is already done.
 *
 * The input carries evidence only: `complete` means that stage cleared. Reading
 * the ladder downward is what makes the states truthful — a first sync cannot
 * land through an unmet dependency, an unconnected account, or a scope that
 * permits nothing, so evidence for a later stage is evidence for the earlier
 * ones. Rendering each stage from its own boolean instead showed "Dependency
 * check" as pending (its proof only arrives with the first sync) between an
 * already-complete "Credential or pairing" and a complete "Initial sync", and
 * left that stage unable to become active once anything was connected.
 *
 * The last stage never reads `complete`: asking the first question stays the
 * standing next action, which is what keeps one row highlighted at the end.
 */
export function withActiveStep(steps: DashboardOnboardingStep[]): DashboardOnboardingStep[] {
  const lastCleared = steps.reduce((last, step, index) => step.state === 'complete' ? index : last, -1);
  const frontier = Math.min(lastCleared + 1, steps.length - 1);
  return steps.map((step, index) => ({
    ...step,
    state: index < frontier ? 'complete' : index === frontier ? 'active' : 'pending',
  }));
}

function trustDomainCards(
  sourceCards: DashboardSourceCard[],
  unassigned: DashboardUnassignedCorpora,
  sovereigntyEngine: SovereigntyEngine,
): DashboardTrustDomainCard[] {
  // The three product tiers always render, in this order, even at zero. Any
  // other trust domain reaching this page still gets a card appended, so the
  // tier totals can never sum to less than "Items found".
  const extraDomains = [...sourceCards.flatMap((card) => card.tier_composition.map((tier) => tier.trust_domain)),
    ...unassigned.entries.map((entry) => entry.trust_domain)]
    .filter((trustDomain) => !DASHBOARD_TRUST_DOMAINS.includes(trustDomain));
  return [...DASHBOARD_TRUST_DOMAINS, ...new Set(extraDomains)].map((trustDomain) => {
    // Count per corpus tier, not per source: one source (Gmail) legitimately
    // spans tiers once items classify individually.
    const tiers = sourceCards.flatMap((card) => card.tier_composition.filter((tier) => tier.trust_domain === trustDomain));
    const unassignedInTier = unassigned.entries.filter((entry) => entry.trust_domain === trustDomain);
    const sourcesWithTier = sourceCards.filter((card) =>
      card.tier_composition.some((tier) => tier.trust_domain === trustDomain && (tier.indexed_items > 0 || tier.content_ready_items > 0)));
    const lanes = modelLaneLabels(sovereigntyEngine, trustDomain);
    return {
      trust_domain: trustDomain,
      label: trustDomainLabel(trustDomain),
      source_count: sourcesWithTier.length
        + unassignedInTier.filter((entry) => entry.indexed_items > 0 || entry.content_ready_items > 0).length,
      indexed_items: tiers.reduce((sum, tier) => sum + tier.indexed_items, 0)
        + unassignedInTier.reduce((sum, entry) => sum + entry.indexed_items, 0),
      content_ready_items: tiers.reduce((sum, tier) => sum + tier.content_ready_items, 0)
        + unassignedInTier.reduce((sum, entry) => sum + entry.content_ready_items, 0),
      model_lanes: lanes.labels,
      model_lane_selection: lanes.selection,
    };
  });
}

const DASHBOARD_TRUST_DOMAINS = ['secure_local', 'internal', 'public_safe'];

/**
 * The lanes that can answer this tier, and whether their order means anything.
 *
 * The real dispatch order is `pool.explicitOrder ?? pool.members`, and when a
 * pool carries no explicit order its members are equals — dispatch picks from
 * recent health and latency (`selection: 'health_latency'` in the worker's
 * route plan). Reading `.members` and printing it as a "then" chain asserted a
 * try-this-first order that does not exist, which on the Secure card claimed
 * the on-device model always answers before the encrypted-cloud one.
 */
function modelLaneLabels(sovereigntyEngine: SovereigntyEngine, trustDomain: string): {
  labels: string[];
  selection: DashboardTrustDomainCard['model_lane_selection'];
} {
  const route = sovereigntyEngine.config.routes[trustDomain as 'secure_local' | 'internal' | 'public_safe'];
  if (!route || route.mode === 'disabled') return { labels: ['Not answerable yet'], selection: 'explicit_order' };
  const pool = sovereigntyEngine.resolveAnalystPool({
    trustDomain: trustDomain as 'secure_local' | 'internal' | 'public_safe',
  });
  const dispatchOrder = pool.explicitOrder ?? pool.members;
  return {
    labels: dispatchOrder.map(({ profile }) => (profile ? modelLaneLabel(profile) : 'Configured model lane')),
    selection: pool.explicitOrder ? 'explicit_order' : 'health_latency',
  };
}

function modelLaneLabel(profile: SovereigntyModelProfile): string {
  const trust = profile.trust === 'local'
    ? 'Local'
    : profile.trust === 'encrypted_cloud'
      ? 'Private cloud'
      : 'Cloud';
  return `${trust} · ${providerLabel(profile.provider)}`;
}

function providerLabel(provider: SovereigntyProfileProvider): string {
  switch (provider) {
    case 'local-openai-compatible':
      return 'This computer';
    case 'openclaw-infer':
      return 'OpenClaw subscription';
    case 'venice':
      return 'Venice';
    case 'google-gemini':
      return 'Gemini';
    case 'anthropic':
      return 'Anthropic';
    case 'openai-compatible':
      return 'OpenAI-compatible';
  }
}

/**
 * corpus id -> the source-corpus registry's own `sourceId` for it.
 *
 * This replaced a function that guessed the source id by scanning the corpus
 * id for provider substrings and, failing that, returned the bare provider
 * name — which can never equal a dotted definition `source_id`, so every
 * corpus without a hardcoded token fell off the page in silence.
 */
function registryCorpusSourceIds(registry: SourceCorpusRegistry | undefined): Map<string, string> {
  const corpora = (registry ?? createSourceCorpusRegistry()).list();
  return new Map(corpora.map((corpus) => [corpus.corpusId, corpus.sourceId]));
}

function registrySourceIdForCorpus(
  corpusId: string,
  sourceIdByCorpusId: Map<string, string>,
): string | undefined {
  return sourceIdByCorpusId.get(canonicalSourceCorpusId(corpusId));
}

function providerFromCorpusId(corpusId: string): string {
  const parts = corpusId.split('.');
  if (parts[0] === 'secure_local' || parts[0] === 'internal' || parts[0] === 'public_safe') return parts[1] ?? 'source';
  return parts[0] ?? 'source';
}

function sourceLabel(provider: string, family: string, trustDomain: string): string {
  const providerText: Record<string, string> = {
    gmail: 'Gmail',
    dropbox: 'Dropbox',
    google_drive: 'Google Drive',
    telegram: 'Telegram',
    readwise: 'Readwise',
    x: 'X bookmarks',
  };
  const base = providerText[provider] ?? titleCase(provider.replace(/[_-]/g, ' '));
  return `${base} · ${trustDomainLabel(trustDomain)} ${familyLabel(family)}`;
}

function familyLabel(family: string): string {
  switch (family) {
    case 'email':
      return 'mail';
    case 'file':
      return 'files';
    case 'chat':
      return 'messages';
    case 'readwise':
      return 'library';
    case 'x':
      return 'posts';
    default:
      return 'source';
  }
}

function trustDomainLabel(trustDomain: string): string {
  switch (trustDomain) {
    case 'secure_local':
      return 'Secure';
    case 'internal':
      return 'Private';
    case 'public_safe':
      return 'Public';
    default:
      return titleCase(trustDomain.replace(/[_-]/g, ' '));
  }
}

function firstCount(counts: Record<string, number>, keys: string[], fallback = 0): number {
  for (const key of keys) {
    if (counts[key] !== undefined) return counts[key]!;
  }
  return fallback;
}

function sumCounts(counts: Record<string, number>, keys: string[]): number {
  return keys.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
}

function stringProperty(value: object, key: string): string | undefined {
  const record = value as Record<string, unknown>;
  return typeof record[key] === 'string' ? record[key] : undefined;
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

import { isSourceIndexReadSurfaceEnabled, type OlympusConfig } from './config.ts';
import { assertNoRawEmailFields } from './email-policy.ts';
import { fetchWithTimeout, isAbortError } from './http-timeout.ts';
import { OperationError, type OperationErrorCode } from './operation-error.ts';
import { canonicalSourceCorpusId, createSourceCorpusRegistry } from './source-corpus-registry.ts';
import type { SourceTrustDomain } from './source-index/types.ts';
import {
  sourceWatchAuthenticatedRouteHeaders,
  type SourceWatchAuthenticatedRoute,
  type SourceWatchMode,
} from './source-watch.ts';
import { withWorkerAuthHeader, workerAuthTokenFromConfig } from './worker-auth.ts';

export type EmailFetch = (url: string, init: RequestInit) => Promise<Response>;
type TelegramMessagesTrustDomain = Extract<SourceTrustDomain, 'internal' | 'secure_local'>;

export interface EmailTransport {
  requestJson(url: string, init: RequestInit): Promise<unknown>;
}

const MAX_EMAIL_WORKER_ERROR_MESSAGE_LENGTH = 512;
const MAX_EMAIL_WORKER_ERROR_BODY_LENGTH = 8 * 1024;
const PASSTHROUGH_EMAIL_WORKER_ERROR_CODES: ReadonlyMap<string, OperationErrorCode> = new Map([
  ['unsupported_filter', 'unsupported_filter'],
  ['invalid_request', 'invalid_request'],
  ['source_index_policy_violation', 'source_index_policy_violation'],
]);

export interface EmailPingResult {
  reachable: boolean;
  configured: boolean;
  base_url: string;
  connector?: string;
  latency_ms?: number;
  raw_email_exposed: false;
  detail?: string;
}

export interface EmailAnswerOptions {
  question: string;
  account?: string;
  after?: string;
  before?: string;
  from?: string;
  to?: string;
  maxMessages?: number;
}

export interface EmailSearchOptions {
  question?: string;
  query?: string;
  account?: string;
  after?: string;
  before?: string;
  from?: string;
  to?: string;
  maxMessages?: number;
  includeSanitizedText?: boolean;
}

export interface EmailIndexSyncOptions {
  account?: string;
  newerThanDays?: number;
  maxMessages?: number;
  query?: string;
}

export interface EmailIndexEmbedOptions {
  account?: string;
  modelId?: string;
  force?: boolean;
}

export interface EmailIndexSearchOptions {
  query: string;
  retrievalMode?: 'keyword' | 'hybrid';
  account?: string;
  after?: string;
  before?: string;
  from?: string;
  to?: string;
  label?: string;
  maxMessages?: number;
}

export type SourceIndexAnswerCorpusId = string;
export type SourceIndexStatusCorpusId = string;
export type SourceIndexSyncCorpusId = string;
export type SourceIndexSearchCorpusId = string;
export type SourceIndexSearchAttachmentType = 'image' | 'video' | 'audio' | 'file' | 'link' | 'other';

export interface SourceIndexAnswerOptions {
  question: string;
  query?: string;
  account?: string;
  corpusId?: SourceIndexAnswerCorpusId;
  corpusIds?: string[];
  approvedScopeKey?: string;
  chatScope?: string;
  conversationId?: string;
  senderId?: string;
  senderLabel?: string;
  authoredAfter?: string;
  authoredBefore?: string;
  selectedItems?: SourceAnswerSelectedItemOption[];
  retrievalMode?: 'keyword' | 'hybrid';
  analystProvider?: 'default' | 'local' | 'venice' | 'cloud';
  analystModel?: string;
  maxResults?: number;
  includeSecureLocal?: boolean;
  includeSecureLocalContent?: boolean;
  includeInternal?: boolean;
  includeInternalContent?: boolean;
  internalContentMaxBytes?: number;
  timeoutMs?: number;
}

export interface SourceAnswerSelectedItemOption {
  corpus_id: string;
  family: string;
  provider: string;
  account_scope: string;
  provider_item_id: string;
  local_item_id: string;
  provider_thread_id?: string;
  provider_conversation_id?: string;
  provider_file_id?: string;
  source_version?: string;
  title?: string;
  conversation_label?: string;
  author_label?: string;
  uri?: string;
  authored_at?: string;
  updated_at?: string;
}

export interface SourceIndexStatusOptions {
  account?: string;
  corpusId?: SourceIndexStatusCorpusId;
  approvedScopeKey?: string;
  chatScope?: string;
  conversationId?: string;
  includeSenderAggregation?: boolean;
  maxSenders?: number;
  includePathPrefixes?: string[];
  excludePathPrefixes?: string[];
  extractorKind?: string;
  extractorVersion?: string;
  mimeTypes?: string[];
  mimeTypePrefixes?: string[];
  fileExtensions?: string[];
  requiredArtifactKind?: string;
  requiredArtifactWarning?: string;
  qaVerdicts?: string[];
  sourceExtractorKinds?: string[];
  sourceJobStatuses?: string[];
  includeReadinessLedger?: boolean;
  includeIngestionLedger?: boolean;
  includeItems?: boolean;
  maxItems?: number;
  query?: string;
}

export interface SourceIndexSyncOptions {
  corpusId: SourceIndexSyncCorpusId;
  mode?: 'head' | 'reconcile' | 'folder_facet_refresh' | 'window_diagnostic' | 'preservation-reattest';
  account?: string;
  approvedScopeKey?: string;
  folderPath?: string;
  folderId?: string;
  recursive?: boolean;
  maxEntries?: number;
  maxPages?: number;
  chatScope?: string;
  trustDomain?: TelegramMessagesTrustDomain;
  maxMessages?: number;
  providerCursor?: string;
  syncDirection?: 'forward' | 'backfill';
  coverageStart?: string;
  coverageEnd?: string;
}

export interface XBookmarksContentRecoveryOptions {
  execute?: boolean;
  limit?: number;
}

export interface SourceExportItemOption {
  path: string;
  destSubfolder?: string;
}

export interface SourceExportOptions {
  destinationRoot: string;
  items: SourceExportItemOption[];
  account?: string;
  dryRun?: boolean;
}

export interface SourceWatchCreateOptions {
  route: SourceWatchAuthenticatedRoute;
  corpusId: string;
  queryText: string;
  mode: SourceWatchMode;
  expiresAt?: string;
  maxDeliveryAttempts?: number;
}

export interface SourceWatchesOptions {
  route: SourceWatchAuthenticatedRoute;
  limit?: number;
  cursor?: string;
}

export interface SourceWatchCancelOptions {
  route: SourceWatchAuthenticatedRoute;
  watchId: string;
  reason?: string;
}

export interface SourceWatchResult {
  kind: 'source_watch';
  watch: Record<string, unknown>;
  policy: {
    raw_source_exposed: false;
    source_text_returned: false;
    message_bodies_returned: false;
    evidence_pointers_only: true;
  };
}

export interface SourceWatchesResult {
  kind: 'source_watches';
  watches: Record<string, unknown>[];
  next_cursor?: string;
  policy: SourceWatchResult['policy'];
}

export interface SourceTranscribeOptions {
  approvedScopeKey: string;
  mode?: 'enqueue' | 'status';
  items?: string[];
  includePathPrefixes?: string[];
  limit?: number;
  account?: string;
}

export interface SourceMediaIngestOptions {
  approvedScopeKey: string;
  items?: string[];
  includePathPrefixes?: string[];
  limit?: number;
  maxBytesPerFile?: number;
  account?: string;
}

export interface SourceIndexSearchOptions {
  query: string;
  corpusId: SourceIndexSearchCorpusId;
  retrievalMode?: 'keyword' | 'hybrid';
  account?: string;
  folderId?: string;
  folderName?: string;
  approvedScopeKey?: string;
  chatScope?: string;
  trustDomain?: string;
  conversationId?: string;
  senderId?: string;
  senderLabel?: string;
  authoredAfter?: string;
  authoredBefore?: string;
  participantId?: string;
  after?: string;
  before?: string;
  includeDeleted?: boolean;
  attachmentType?: SourceIndexSearchAttachmentType;
  maxResults?: number;
  includeLocators?: boolean;
}

export interface SourceIndexPromotionCandidatesOptions {
  corpusId?: string;
  account?: string;
  approvedScopeKey: string;
  maxResults?: number;
}

export type SourceIndexPromotionCanonicalType =
  | 'project'
  | 'project_work_item'
  | 'area'
  | 'person'
  | 'organization'
  | 'resource'
  | 'topic'
  | 'fact'
  | 'secure_companion'
  | 'resource_wiki_page';
export type SourceIndexPromotionTargetSurface =
  | 'review_queue'
  | 'source_index'
  | 'secure_companion'
  | 'obsidian'
  | 'resource_wiki';
export type SourceIndexPromotionReasonCode =
  | 'manual_review'
  | 'high_signal'
  | 'recurring_reference'
  | 'project_material'
  | 'decision_evidence'
  | 'resource_candidate';
export type SourceIndexPromotionDecision = 'approved' | 'rejected' | 'deferred' | 'needs_changes';
export type SourceIndexPromotionProposalStatus = 'proposed' | SourceIndexPromotionDecision;

export interface SourceIndexPromotionProposalOptions {
  account?: string;
  approvedScopeKey: string;
  classificationIds: string[];
  canonicalType: SourceIndexPromotionCanonicalType;
  targetSurface: SourceIndexPromotionTargetSurface;
  reasonCode: SourceIndexPromotionReasonCode;
  proposedBy?: string;
}

export interface SourceIndexPromotionDecisionOptions {
  proposalId: string;
  decision: SourceIndexPromotionDecision;
  decidedBy?: string;
  reasonCode?: SourceIndexPromotionReasonCode;
}

export interface SourceIndexPromotionProposalsOptions {
  account?: string;
  approvedScopeKey?: string;
  status?: SourceIndexPromotionProposalStatus;
  maxResults?: number;
}

export interface SourceIndexPromotionProposalDetailOptions {
  proposalId: string;
}

export interface SourceIndexAnswerResult {
  answer: string;
  evidence: unknown[];
  audit: {
    searched_corpora: string[];
    skipped_corpora: unknown[];
    lane_audits: unknown[];
    self_heal?: {
      attempted: boolean;
      corpus_id?: string;
      entry_id_hash?: string;
      provider_file_id_hash?: string;
      prior_state?: {
        extraction_status?: string;
        extraction_completeness?: string;
      };
      action?: 'forced_reextract';
      outcome: 'healed' | 'in_progress' | 'failed' | 'skipped';
      retry_after_ms?: number;
      reason?: string;
    };
    answer_synthesis?: {
      analyst_backend?: 'local' | 'venice' | 'cloud';
      requested_analyst_provider?: 'default' | 'local' | 'venice' | 'cloud';
      requested_analyst_model?: string;
      analyst_fallback?: {
        from: 'venice' | 'cloud';
        to: 'local';
        reason: 'timeout' | 'error' | 'escalation' | 'unavailable';
      };
      private_context_used?: boolean;
      secure_local_items_consulted?: number;
      internal_items_consulted?: number;
      raw_source_exposed: false;
    };
    latency_ms: number;
    phase_timings?: SourceIndexAnswerPhaseTimings;
    raw_source_exposed: false;
  };
  policy: {
    raw_source_exposed: false;
    source_packets_exposed: false;
    internal_content_exposed: boolean;
    secure_local_content_exposed: boolean;
    castor_safe_bridge: true;
  };
  internal_context?: unknown;
  opsec?: {
    structured_evidence: unknown[];
    release_decision: unknown;
    raw_source_exposed: false;
  };
}

export interface SourceIndexAnswerPhaseTimings {
  lane_setup_ms: number;
  bulk_gate_ms: number;
  evidence_pack_ms?: number;
  self_heal_ms?: number;
  analyst_ms?: number;
  release_gate_ms?: number;
  total_ms: number;
}

export interface SourceIndexStatusResult {
  kind: 'source_index_status';
  generated_at: string;
  corpora: unknown[];
  ingestion_ledger?: unknown;
  sender_aggregation?: unknown;
  policy: {
    read_only: true;
    raw_source_exposed: false;
    source_packets_exposed: false;
    source_text_returned: false;
    secure_local_item_metadata_exposed: false;
    castor_visible: true;
  };
}

export interface SourceIndexSearchResult {
  kind: 'source_index_search';
  corpus_id: SourceIndexSearchCorpusId;
  retrieval_source: 'local_index';
  hits: unknown[];
  audit: {
    request_id: string;
    retrieval_source: 'local_index';
    queries_attempted: number;
    retrieval_mode?: 'keyword' | 'hybrid';
    requested_retrieval_mode?: 'keyword' | 'hybrid';
    keyword_candidates?: number;
    vector_candidates?: number;
    fused_candidates?: number;
    semantic_skipped_reason?: string;
    embedding_model_id?: string;
    embedding_epoch?: string;
    vector_backend?: string;
    metadata_hits: number;
    items_returned: number;
    latency_ms: number;
    raw_source_exposed: false;
    source_text_returned: boolean;
    locators_requested?: boolean;
  };
  policy: {
    raw_source_exposed: false;
    source_text_returned: boolean;
    source_packets_exposed: false;
    local_only: boolean;
    trust_domain: SourceTrustDomain;
    locators_exposed?: boolean;
    locator_release?: 'explicit_request';
  };
}

export interface SourceIndexPromotionCandidatesResult {
  kind: 'dropbox_content_promotion_candidates';
  corpus_id: 'secure_local.dropbox.files';
  provider: 'dropbox';
  account: string;
  scope_key_hash: string;
  candidates: unknown[];
  policy: {
    raw_source_exposed: false;
    source_text_returned: false;
    local_only: true;
    trust_domain: 'secure_local';
    promotion_write_performed: false;
  };
}

export interface SourceIndexPromotionProposalResult {
  kind: 'dropbox_content_promotion_proposal';
  corpus_id: 'secure_local.dropbox.files';
  provider: 'dropbox';
  account: string;
  scope_key_hash: string;
  proposal_id: string;
  proposal_revision_id: string;
  status: 'proposed';
  canonical_type: SourceIndexPromotionCanonicalType;
  target_surface: SourceIndexPromotionTargetSurface;
  reason_code: SourceIndexPromotionReasonCode;
  evidence_count: number;
  trust_domain: 'secure_local';
  trust_tiers: string[];
  policy_decisions: string[];
  policy: {
    raw_source_exposed: false;
    source_text_returned: false;
    local_only: true;
    trust_domain: 'secure_local';
    resource_write_performed: false;
    proposal_only: true;
  };
}

export interface SourceIndexPromotionDecisionResult {
  kind: 'dropbox_content_promotion_decision';
  corpus_id: 'secure_local.dropbox.files';
  provider: 'dropbox';
  proposal_id: string;
  decision_id: string;
  decision: SourceIndexPromotionDecision;
  status: SourceIndexPromotionDecision;
  evidence_count: number;
  policy: {
    raw_source_exposed: false;
    source_text_returned: false;
    local_only: true;
    trust_domain: 'secure_local';
    resource_write_performed: false;
    execution_performed: false;
  };
}

export interface SourceIndexPromotionProposalSummary {
  proposal_id: string;
  proposal_revision_id: string;
  account: string;
  scope_key_hash: string;
  canonical_type: SourceIndexPromotionCanonicalType;
  target_surface: SourceIndexPromotionTargetSurface;
  reason_code: SourceIndexPromotionReasonCode;
  status: SourceIndexPromotionProposalStatus;
  evidence_count: number;
  decision_count: number;
  resource_write_performed: false;
  created_at: string;
  updated_at: string;
}

export interface SourceIndexPromotionProposalsResult {
  kind: 'dropbox_content_promotion_proposals';
  corpus_id: 'secure_local.dropbox.files';
  provider: 'dropbox';
  proposals: SourceIndexPromotionProposalSummary[];
  policy: {
    raw_source_exposed: false;
    source_text_returned: false;
    local_only: true;
    trust_domain: 'secure_local';
    resource_write_performed: false;
  };
}

export interface SourceIndexPromotionProposalEvidenceSummary {
  classification_id: string;
  evidence_ordinal: number;
  target_kind: string;
  source_content_hash: string;
  provider_file_id_hash: string;
  revision_hash?: string;
  content_hash?: string;
  structural_ref_hash?: string;
  trust_tier: string;
  trust_domain: 'secure_local';
  policy_decision: string;
  review_status_at_proposal: string;
  finding_count: number;
}

export interface SourceIndexPromotionDecisionSummary {
  decision_id: string;
  decision: SourceIndexPromotionDecision;
  reason_code?: SourceIndexPromotionReasonCode;
  decided_at: string;
  resource_write_performed: false;
  execution_performed: false;
}

export interface SourceIndexPromotionProposalDetailResult {
  kind: 'dropbox_content_promotion_proposal_detail';
  corpus_id: 'secure_local.dropbox.files';
  provider: 'dropbox';
  proposal: SourceIndexPromotionProposalSummary;
  evidence: SourceIndexPromotionProposalEvidenceSummary[];
  decisions: SourceIndexPromotionDecisionSummary[];
  policy: SourceIndexPromotionProposalsResult['policy'];
}

export interface EmailSourcePacketItem {
  item_id?: string;
  thread_id?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  sanitized_text?: string;
  provenance: {
    source?: 'gmail';
    provider?: 'gmail';
    account?: string;
    message_id?: string;
    thread_id?: string;
    local_message_id?: string;
    chunk_ids?: string[];
    sync_run_id?: string;
    checkpoint_id?: string;
    source_version?: string;
  };
}

export interface EmailIndexSyncResult {
  sync_run_id: string;
  status: 'completed';
  provider: 'gmail';
  account: string;
  source_scope: string;
  items_seen: number;
  items_indexed: number;
  threads_indexed: number;
  checkpoint_recorded: boolean;
  store_path: string;
  gaps: string[];
  policy: {
    raw_email_exposed: false;
    local_only: true;
  };
}

export interface EmailIndexEmbedResult {
  semantic_run_id: string;
  status: 'completed';
  provider: 'gmail';
  account?: string;
  model_id: string;
  embedding_provider: string;
  embedding_dimension: number;
  embedding_epoch: string;
  vector_backend: 'exact_scan';
  chunks_seen: number;
  chunks_embedded: number;
  chunks_skipped: number;
  chunks_excluded_secure?: number;
  store_path: string;
  policy: {
    raw_email_exposed: false;
    local_only: true;
    cloud_embedding_eligible: false;
    derived_private_data: true;
  };
}

export interface EmailSourcePacketResult {
  packet: {
    kind: 'email_source_packet';
    packet_id: string;
    source: 'gmail';
    account?: string;
    items: EmailSourcePacketItem[];
  };
  audit: {
    request_id: string;
    queries_attempted: number;
    metadata_hits: number;
    items_returned: number;
    sanitized_reads_attempted: number;
    sanitized_reads_succeeded: number;
    truncated: boolean;
    local_packet: true;
    raw_email_exposed: false;
    retrieval_source?: 'local_index';
    retrieval_mode?: 'keyword' | 'hybrid';
    requested_retrieval_mode?: 'keyword' | 'hybrid';
    keyword_candidates?: number;
    vector_candidates?: number;
    fused_candidates?: number;
    semantic_skipped_reason?: string;
    embedding_model_id?: string;
    vector_backend?: 'exact_scan';
    latency_ms?: number;
    threads_returned?: number;
  };
  policy: {
    raw_email_exposed: false;
    local_only: true;
    requires_local_session: true;
  };
}

export interface EmailSafeAudit {
  request_id: string;
  queries_attempted: number;
  metadata_hits: number;
  evidence_count: number;
  reasoner_ms: number;
  fallback_used: boolean;
  planner_used?: boolean;
  planner_fallback_used?: boolean;
  planned_search_count?: number;
  planner_failure_reason?: EmailPlannerFailureReason;
  retrieval_searches_attempted?: number;
  retrieval_search_summaries?: EmailRetrievalSearchSummary[];
}

export type EmailPlannerFailureReason = 'timeout' | 'http_error' | 'invalid_json' | 'invalid_plan' | 'empty_plan' | 'error';

export interface EmailRetrievalSearchSummary {
  source: 'baseline' | 'planner';
  index: number;
  hits: number;
  new_candidates_after_dedupe: number;
  capped: boolean;
}

export interface EmailAnswerResult {
  answer: string;
  evidence?: unknown;
  audit?: EmailSafeAudit;
  policy: {
    raw_email_exposed: false;
    reasoning_lane: 'delphi_local';
  };
}

export class EmailClient {
  private config: OlympusConfig;
  private transport: EmailTransport;

  constructor(
    config: OlympusConfig,
    transport: EmailTransport = createEmailTransport(config),
  ) {
    this.config = config;
    this.transport = transport;
  }

  async ping(): Promise<EmailPingResult> {
    if (!this.config.email.enabled) {
      return {
        reachable: false,
        configured: false,
        base_url: this.config.email.baseUrl,
        raw_email_exposed: false,
        detail: 'Email lane is disabled. Configure a private email source worker before use.',
      };
    }

    const startedAt = performance.now();
    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/health`, {
      method: 'GET',
    });
    const data = asRecord(response);

    const connector = typeof data.connector === 'string' ? data.connector : undefined;
    const configured = typeof data.configured === 'boolean' ? data.configured : true;
    const detail = typeof data.detail === 'string' ? data.detail : undefined;
    return {
      reachable: true,
      configured,
      base_url: this.config.email.baseUrl,
      latency_ms: Math.round(performance.now() - startedAt),
      raw_email_exposed: false,
      ...(connector !== undefined ? { connector } : {}),
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  async answer(options: EmailAnswerOptions): Promise<EmailAnswerResult> {
    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Email lane is disabled.',
        'Configure a private email source worker that owns OAuth and message fetch, then uses an approved local/private model lane for reasoning.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: options.question,
        ...(options.account ? { account: options.account } : {}),
        ...(options.after ? { after: options.after } : {}),
        ...(options.before ? { before: options.before } : {}),
        ...(options.from ? { from: options.from } : {}),
        ...(options.to ? { to: options.to } : {}),
        ...(options.maxMessages !== undefined ? { max_messages: options.maxMessages } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);

    if (typeof data.answer !== 'string' || data.answer.length === 0) {
      throw new OperationError('email_error', 'Email answer response did not include a non-empty answer.');
    }

    return {
      answer: data.answer,
      ...(data.evidence !== undefined ? { evidence: data.evidence } : {}),
      ...(data.audit !== undefined ? { audit: parseEmailAudit(data.audit) } : {}),
      policy: {
        raw_email_exposed: false,
        reasoning_lane: 'delphi_local',
      },
    };
  }

  async search(options: EmailSearchOptions): Promise<EmailSourcePacketResult> {
    if (!this.config.email.localPacketsDevEnabled) {
      throw new OperationError(
        'email_local_session_required',
        'Email source packets require an approved local/private session.',
        'OpenClaw native tools do not currently provide trustworthy active model/provider metadata to Olympus. Keep source packets disabled unless using the explicit local development proof gate.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Email lane is disabled.',
        'Configure a private email source worker before using local-only email source packets.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(options.question ? { question: options.question } : {}),
        ...(options.query ? { query: options.query } : {}),
        ...(options.account ? { account: options.account } : {}),
        ...(options.after ? { after: options.after } : {}),
        ...(options.before ? { before: options.before } : {}),
        ...(options.from ? { from: options.from } : {}),
        ...(options.to ? { to: options.to } : {}),
        ...(options.maxMessages !== undefined ? { max_messages: options.maxMessages } : {}),
        ...(options.includeSanitizedText !== undefined ? { include_sanitized_text: options.includeSanitizedText } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    return parseEmailSourcePacketResult(data);
  }

  async indexSync(options: EmailIndexSyncOptions): Promise<EmailIndexSyncResult> {
    if (!this.config.email.indexAdminDevEnabled) {
      throw new OperationError(
        'email_index_admin_required',
        'Email index sync requires the explicit developer/admin proof gate.',
        'Set OLYMPUS_ENABLE_EMAIL_INDEX_ADMIN_FOR_DEV=true only for a bounded local proof run.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Email lane is disabled.',
        'Configure a private email source worker before syncing the local email index.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/index/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(options.account ? { account: options.account } : {}),
        ...(options.newerThanDays !== undefined ? { newer_than_days: options.newerThanDays } : {}),
        ...(options.maxMessages !== undefined ? { max_messages: options.maxMessages } : {}),
        ...(options.query ? { query: options.query } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    return data as unknown as EmailIndexSyncResult;
  }

  async indexEmbed(options: EmailIndexEmbedOptions): Promise<EmailIndexEmbedResult> {
    if (!this.config.email.indexAdminDevEnabled) {
      throw new OperationError(
        'email_index_admin_required',
        'Email index embedding requires the explicit developer/admin proof gate.',
        'Set OLYMPUS_ENABLE_EMAIL_INDEX_ADMIN_FOR_DEV=true only for a bounded local proof run.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Email lane is disabled.',
        'Configure a private email source worker before embedding the local email index.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/index/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(options.account ? { account: options.account } : {}),
        ...(options.modelId ? { model_id: options.modelId } : {}),
        ...(options.force !== undefined ? { force: options.force } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    return data as unknown as EmailIndexEmbedResult;
  }

  async indexSearch(options: EmailIndexSearchOptions): Promise<EmailSourcePacketResult> {
    if (!this.config.email.localPacketsDevEnabled) {
      throw new OperationError(
        'email_local_session_required',
        'Email index source packets require an approved local/private session.',
        'Keep local email index packets disabled unless the active caller is an approved Olympus local model session.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Email lane is disabled.',
        'Configure a private email source worker before searching the local email index.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/index/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: options.query,
        ...(options.retrievalMode ? { retrieval_mode: options.retrievalMode } : {}),
        ...(options.account ? { account: options.account } : {}),
        ...(options.after ? { after: options.after } : {}),
        ...(options.before ? { before: options.before } : {}),
        ...(options.from ? { from: options.from } : {}),
        ...(options.to ? { to: options.to } : {}),
        ...(options.label ? { label: options.label } : {}),
        ...(options.maxMessages !== undefined ? { max_messages: options.maxMessages } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    return parseEmailSourcePacketResult(data);
  }

  async sourceAnswer(options: SourceIndexAnswerOptions): Promise<SourceIndexAnswerResult> {
    if (!isSourceIndexReadSurfaceEnabled(this.config)) {
      throw new OperationError(
        'source_index_not_enabled',
        'Source index answers are disabled.',
        'Enable sourceIndex.enabled for the product read surface, or sourceIndex.answerDevEnabled for a legacy proof runtime.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before using routed source answers.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: options.question,
        ...(options.query ? { query: options.query } : {}),
        ...(options.account ? { account: options.account } : {}),
        ...(options.corpusId ? { corpus_id: options.corpusId } : {}),
        ...(options.corpusIds ? { corpus_ids: options.corpusIds } : {}),
        ...(options.approvedScopeKey ? { approved_scope_key: options.approvedScopeKey } : {}),
        ...(options.chatScope ? { chat_scope: options.chatScope } : {}),
        ...(options.conversationId ? { conversation_id: options.conversationId } : {}),
        ...(options.senderId ? { sender_id: options.senderId } : {}),
        ...(options.senderLabel ? { sender_label: options.senderLabel } : {}),
        ...(options.authoredAfter ? { authored_after: options.authoredAfter } : {}),
        ...(options.authoredBefore ? { authored_before: options.authoredBefore } : {}),
        ...(options.selectedItems ? { selected_items: options.selectedItems } : {}),
        ...(options.retrievalMode ? { retrieval_mode: options.retrievalMode } : {}),
        ...(options.analystProvider ? { analyst_provider: options.analystProvider } : {}),
        ...(options.analystModel ? { analyst_model: options.analystModel } : {}),
        ...(options.maxResults !== undefined ? { max_results: options.maxResults } : {}),
        ...(options.includeSecureLocal !== undefined ? { include_secure_local: options.includeSecureLocal } : {}),
        ...(options.includeSecureLocalContent !== undefined ? { include_secure_local_content: options.includeSecureLocalContent } : {}),
        ...(options.includeInternal !== undefined ? { include_internal: options.includeInternal } : {}),
        ...(options.includeInternalContent !== undefined ? { include_internal_content: options.includeInternalContent } : {}),
        ...(options.internalContentMaxBytes !== undefined ? { internal_content_max_bytes: options.internalContentMaxBytes } : {}),
        ...(options.timeoutMs !== undefined ? { timeout_ms: options.timeoutMs } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    assertNoSourceIndexOperationalLeakFields(data);
    return parseSourceIndexAnswerResult(data);
  }

  async sourceIndexStatus(options: SourceIndexStatusOptions = {}): Promise<SourceIndexStatusResult> {
    if (!isSourceIndexReadSurfaceEnabled(this.config)) {
      throw new OperationError(
        'source_index_not_enabled',
        'Source index status is disabled.',
        'Enable sourceIndex.enabled for the product read surface, or sourceIndex.answerDevEnabled for a legacy proof runtime.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before using source-index status.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/index/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(options.account ? { account: options.account } : {}),
        ...(options.corpusId ? { corpus_id: options.corpusId } : {}),
        ...(options.approvedScopeKey ? { approved_scope_key: options.approvedScopeKey } : {}),
        ...(options.chatScope ? { chat_scope: options.chatScope } : {}),
        ...(options.conversationId ? { conversation_id: options.conversationId } : {}),
        ...(options.includeSenderAggregation !== undefined
          ? { include_sender_aggregation: options.includeSenderAggregation }
          : {}),
        ...(options.maxSenders !== undefined ? { max_senders: options.maxSenders } : {}),
        ...(options.includePathPrefixes ? { include_path_prefixes: options.includePathPrefixes } : {}),
        ...(options.excludePathPrefixes ? { exclude_path_prefixes: options.excludePathPrefixes } : {}),
        ...(options.extractorKind ? { extractor_kind: options.extractorKind } : {}),
        ...(options.extractorVersion ? { extractor_version: options.extractorVersion } : {}),
        ...(options.mimeTypes ? { mime_types: options.mimeTypes } : {}),
        ...(options.mimeTypePrefixes ? { mime_type_prefixes: options.mimeTypePrefixes } : {}),
        ...(options.fileExtensions ? { file_extensions: options.fileExtensions } : {}),
        ...(options.requiredArtifactKind ? { required_artifact_kind: options.requiredArtifactKind } : {}),
        ...(options.requiredArtifactWarning ? { required_artifact_warning: options.requiredArtifactWarning } : {}),
        ...(options.qaVerdicts ? { qa_verdicts: options.qaVerdicts } : {}),
        ...(options.sourceExtractorKinds ? { source_extractor_kinds: options.sourceExtractorKinds } : {}),
        ...(options.sourceJobStatuses ? { source_job_statuses: options.sourceJobStatuses } : {}),
        ...(options.includeReadinessLedger !== undefined ? { include_readiness_ledger: options.includeReadinessLedger } : {}),
        ...(options.includeIngestionLedger !== undefined ? { include_ingestion_ledger: options.includeIngestionLedger } : {}),
        ...(options.includeItems !== undefined ? { include_items: options.includeItems } : {}),
        ...(options.maxItems !== undefined ? { max_items: options.maxItems } : {}),
        ...(options.query ? { query: options.query } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    assertNoSourceIndexOperationalLeakFields(data);
    return parseSourceIndexStatusResult(data);
  }

  async sourceIndexSync(options: SourceIndexSyncOptions): Promise<unknown> {
    if (!this.config.email.indexAdminDevEnabled) {
      throw new OperationError(
        'source_index_admin_required',
        'Source-index sync requires the explicit developer/admin proof gate.',
        'Set OLYMPUS_ENABLE_EMAIL_INDEX_ADMIN_FOR_DEV=true only for a bounded source-index proof run.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before using source-index sync.',
      );
    }

    const corpusId = canonicalSourceCorpusId(options.corpusId);
    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/index/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        corpus_id: corpusId,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.account ? { account: options.account } : {}),
        ...(options.approvedScopeKey ? { approved_scope_key: options.approvedScopeKey } : {}),
        ...(options.folderPath ? { folder_path: options.folderPath } : {}),
        ...(options.folderId ? { folder_id: options.folderId } : {}),
        ...(options.recursive !== undefined ? { recursive: options.recursive } : {}),
        ...(options.maxEntries !== undefined ? { max_entries: options.maxEntries } : {}),
        ...(options.maxPages !== undefined ? { max_pages: options.maxPages } : {}),
        ...(options.chatScope ? { chat_scope: options.chatScope } : {}),
        ...(options.trustDomain ? { trust_domain: options.trustDomain } : {}),
        ...(options.maxMessages !== undefined ? { max_messages: options.maxMessages } : {}),
        ...(options.providerCursor ? { provider_cursor: options.providerCursor } : {}),
        ...(options.syncDirection ? { sync_direction: options.syncDirection } : {}),
        ...(options.coverageStart ? { coverage_start: options.coverageStart } : {}),
        ...(options.coverageEnd ? { coverage_end: options.coverageEnd } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    assertNoSourceIndexOperationalLeakFields(data);
    return data;
  }

  async xBookmarksContentRecovery(
    options: XBookmarksContentRecoveryOptions = {},
  ): Promise<Record<string, unknown>> {
    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before recovering X bookmark content.',
      );
    }

    const response = await this.transport.requestJson(
      `${this.config.email.baseUrl}/source/index/x-bookmarks/content/recover`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(options.execute !== undefined ? { execute: options.execute } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        }),
      },
    );
    const data = asRecord(response);
    assertNoRawEmailFields(data);
    return data;
  }

  async sourceIndexSearch(options: SourceIndexSearchOptions): Promise<SourceIndexSearchResult> {
    if (!isSourceIndexReadSurfaceEnabled(this.config)) {
      throw new OperationError(
        'source_index_not_enabled',
        'Source-index search is disabled.',
        'Enable sourceIndex.enabled for the product read surface, or sourceIndex.answerDevEnabled for a legacy proof runtime.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before using source-index search.',
      );
    }

    const corpusId = canonicalSourceCorpusId(options.corpusId);
    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/index/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: options.query,
        corpus_id: corpusId,
        ...(options.retrievalMode ? { retrieval_mode: options.retrievalMode } : {}),
        ...(options.account ? { account: options.account } : {}),
        ...(options.folderId ? { folder_id: options.folderId } : {}),
        ...(options.folderName ? { folder_name: options.folderName } : {}),
        ...(options.approvedScopeKey ? { approved_scope_key: options.approvedScopeKey } : {}),
        ...(options.chatScope ? { chat_scope: options.chatScope } : {}),
        ...(options.trustDomain ? { trust_domain: options.trustDomain } : {}),
        ...(options.conversationId ? { conversation_id: options.conversationId } : {}),
        ...(options.senderId ? { sender_id: options.senderId } : {}),
        ...(options.senderLabel ? { sender_label: options.senderLabel } : {}),
        ...(options.authoredAfter ? { authored_after: options.authoredAfter } : {}),
        ...(options.authoredBefore ? { authored_before: options.authoredBefore } : {}),
        ...(options.participantId ? { participant_id: options.participantId } : {}),
        ...(options.after ? { after: options.after } : {}),
        ...(options.before ? { before: options.before } : {}),
        ...(options.includeDeleted !== undefined ? { include_deleted: options.includeDeleted } : {}),
        ...(options.attachmentType ? { attachment_type: options.attachmentType } : {}),
        ...(options.maxResults !== undefined ? { max_results: options.maxResults } : {}),
        ...(options.includeLocators !== undefined ? { include_locators: options.includeLocators } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    assertNoSourceIndexOperationalLeakFields(data);
    return parseSourceIndexSearchResult(data, {
      config: this.config,
      requestedCorpusId: corpusId,
      includeLocators: options.includeLocators === true,
    });
  }

  async sourceExport(options: SourceExportOptions): Promise<unknown> {
    if (!this.config.sourceIndex.answerDevEnabled) {
      throw new OperationError(
        'source_index_answer_dev_required',
        'Source export requires the explicit source-index proof gate.',
        'Enable sourceIndex.answerDevEnabled only for bounded calling-assistant-safe source-index proof tools.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before using source export.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destination_root: options.destinationRoot,
        items: options.items.map((item) => ({
          path: item.path,
          ...(item.destSubfolder ? { dest_subfolder: item.destSubfolder } : {}),
        })),
        ...(options.account ? { account: options.account } : {}),
        ...(options.dryRun !== undefined ? { dry_run: options.dryRun } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    assertNoSourceIndexOperationalLeakFields(data);
    return data;
  }

  async sourceTranscribe(options: SourceTranscribeOptions): Promise<unknown> {
    if (!this.config.sourceIndex.answerDevEnabled) {
      throw new OperationError(
        'source_index_answer_dev_required',
        'Source transcription requires the explicit source-index proof gate.',
        'Enable sourceIndex.answerDevEnabled only for bounded calling-assistant-safe source-index proof tools.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before using source transcription.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/index/dropbox/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approved_scope_key: options.approvedScopeKey,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.items ? { items: options.items } : {}),
        ...(options.includePathPrefixes ? { include_path_prefixes: options.includePathPrefixes } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.account ? { account: options.account } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    assertNoSourceIndexOperationalLeakFields(data);
    return data;
  }

  async sourceMediaIngest(options: SourceMediaIngestOptions): Promise<unknown> {
    if (!this.config.sourceIndex.answerDevEnabled) {
      throw new OperationError(
        'source_index_answer_dev_required',
        'On-demand media ingestion requires the explicit source-index proof gate.',
        'Enable sourceIndex.answerDevEnabled only for bounded calling-assistant-safe source-index proof tools.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before using on-demand media ingestion.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/index/dropbox/content/on-demand-media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approved_scope_key: options.approvedScopeKey,
        ...(options.items ? { items: options.items } : {}),
        ...(options.includePathPrefixes ? { include_path_prefixes: options.includePathPrefixes } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.maxBytesPerFile !== undefined ? { max_bytes_per_file: options.maxBytesPerFile } : {}),
        ...(options.account ? { account: options.account } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    assertNoSourceIndexOperationalLeakFields(data);
    return data;
  }

  async sourceIndexPromotionCandidates(
    options: SourceIndexPromotionCandidatesOptions,
  ): Promise<SourceIndexPromotionCandidatesResult> {
    if (!this.config.sourceIndex.answerDevEnabled) {
      throw new OperationError(
        'source_index_answer_dev_required',
        'Source-index promotion candidates require the explicit source-index proof gate.',
        'Enable sourceIndex.answerDevEnabled only for bounded calling-assistant-safe source-index proof tools.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before using source-index promotion candidates.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/index/dropbox/content/promotion-candidates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(options.corpusId ? { corpus_id: options.corpusId } : {}),
        ...(options.account ? { account: options.account } : {}),
        approved_scope_key: options.approvedScopeKey,
        ...(options.maxResults !== undefined ? { max_results: options.maxResults } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    assertNoSourceIndexOperationalLeakFields(data);
    return parseSourceIndexPromotionCandidatesResult(data);
  }

  async sourceIndexPromotionProposal(
    options: SourceIndexPromotionProposalOptions,
  ): Promise<SourceIndexPromotionProposalResult> {
    if (!this.config.sourceIndex.answerDevEnabled) {
      throw new OperationError(
        'source_index_answer_dev_required',
        'Source-index promotion proposals require the explicit source-index proof gate.',
        'Enable sourceIndex.answerDevEnabled only for bounded calling-assistant-safe source-index proof tools.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before using source-index promotion proposals.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/index/dropbox/content/promotion-proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(options.account ? { account: options.account } : {}),
        approved_scope_key: options.approvedScopeKey,
        classification_ids: options.classificationIds,
        canonical_type: options.canonicalType,
        target_surface: options.targetSurface,
        reason_code: options.reasonCode,
        ...(options.proposedBy ? { proposed_by: options.proposedBy } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    assertNoSourceIndexOperationalLeakFields(data);
    return parseSourceIndexPromotionProposalResult(data);
  }

  async sourceIndexPromotionProposals(
    options: SourceIndexPromotionProposalsOptions = {},
  ): Promise<SourceIndexPromotionProposalsResult> {
    if (!this.config.sourceIndex.answerDevEnabled) {
      throw new OperationError(
        'source_index_answer_dev_required',
        'Source-index promotion proposal listing requires the explicit source-index proof gate.',
        'Enable sourceIndex.answerDevEnabled only for bounded calling-assistant-safe source-index proof tools.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before using source-index promotion proposal listing.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/index/dropbox/content/promotion-proposals/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(options.account ? { account: options.account } : {}),
        ...(options.approvedScopeKey ? { approved_scope_key: options.approvedScopeKey } : {}),
        ...(options.status ? { status: options.status } : {}),
        ...(options.maxResults !== undefined ? { max_results: options.maxResults } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    assertNoSourceIndexOperationalLeakFields(data);
    return parseSourceIndexPromotionProposalsResult(data);
  }

  async sourceIndexPromotionProposalDetail(
    options: SourceIndexPromotionProposalDetailOptions,
  ): Promise<SourceIndexPromotionProposalDetailResult> {
    if (!this.config.sourceIndex.answerDevEnabled) {
      throw new OperationError(
        'source_index_answer_dev_required',
        'Source-index promotion proposal details require the explicit source-index proof gate.',
        'Enable sourceIndex.answerDevEnabled only for bounded calling-assistant-safe source-index proof tools.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before using source-index promotion proposal details.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/index/dropbox/content/promotion-proposals/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposal_id: options.proposalId,
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    assertNoSourceIndexOperationalLeakFields(data);
    return parseSourceIndexPromotionProposalDetailResult(data);
  }

  async sourceIndexPromotionDecision(
    options: SourceIndexPromotionDecisionOptions,
  ): Promise<SourceIndexPromotionDecisionResult> {
    if (!this.config.sourceIndex.answerDevEnabled) {
      throw new OperationError(
        'source_index_answer_dev_required',
        'Source-index promotion decisions require the explicit source-index proof gate.',
        'Enable sourceIndex.answerDevEnabled only for bounded calling-assistant-safe source-index proof tools.',
      );
    }

    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before using source-index promotion decisions.',
      );
    }

    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/index/dropbox/content/promotion-decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposal_id: options.proposalId,
        decision: options.decision,
        ...(options.decidedBy ? { decided_by: options.decidedBy } : {}),
        ...(options.reasonCode ? { reason_code: options.reasonCode } : {}),
      }),
    });

    const data = asRecord(response);
    assertNoRawEmailFields(data);
    assertNoSourceIndexOperationalLeakFields(data);
    return parseSourceIndexPromotionDecisionResult(data);
  }

  async sourceWatchCreate(options: SourceWatchCreateOptions): Promise<SourceWatchResult> {
    this.requireSourceWatchSurface();
    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/watch/create`, {
      method: 'POST',
      headers: withSourceWatchHeaders(options.route),
      body: JSON.stringify({
        corpus_id: options.corpusId,
        query_text: options.queryText,
        mode: options.mode,
        ...(options.expiresAt ? { expires_at: options.expiresAt } : {}),
        ...(options.maxDeliveryAttempts !== undefined
          ? { max_delivery_attempts: options.maxDeliveryAttempts }
          : {}),
      }),
    });
    return parseSourceWatchResult(response, 'source_watch');
  }

  async sourceWatches(options: SourceWatchesOptions): Promise<SourceWatchesResult> {
    this.requireSourceWatchSurface();
    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/watches`, {
      method: 'POST',
      headers: withSourceWatchHeaders(options.route),
      body: JSON.stringify({
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
      }),
    });
    return parseSourceWatchResult(response, 'source_watches');
  }

  async sourceWatchCancel(options: SourceWatchCancelOptions): Promise<SourceWatchResult> {
    this.requireSourceWatchSurface();
    const response = await this.transport.requestJson(`${this.config.email.baseUrl}/source/watch/cancel`, {
      method: 'POST',
      headers: withSourceWatchHeaders(options.route),
      body: JSON.stringify({
        watch_id: options.watchId,
        ...(options.reason ? { reason: options.reason } : {}),
      }),
    });
    return parseSourceWatchResult(response, 'source_watch');
  }

  private requireSourceWatchSurface(): void {
    if (!isSourceIndexReadSurfaceEnabled(this.config)) {
      throw new OperationError(
        'source_index_not_enabled',
        'Source watches are disabled.',
        'Enable sourceIndex.enabled before creating or managing durable watches.',
      );
    }
    if (!this.config.email.enabled) {
      throw new OperationError(
        'email_not_configured',
        'Private source worker is disabled.',
        'Enable the Gateway-side private source worker before managing durable watches.',
      );
    }
  }
}

export function createEmailTransport(config: OlympusConfig): EmailTransport {
  return new DirectHttpEmailTransport(fetch, workerAuthTokenFromConfig(config), config.email.requestTimeoutSeconds * 1000);
}

export class DirectHttpEmailTransport implements EmailTransport {
  private fetchImpl: EmailFetch;
  private authToken: string | undefined;
  private timeoutMs: number;

  constructor(fetchImpl: EmailFetch = fetch, authToken?: string, timeoutMs = 0) {
    this.fetchImpl = fetchImpl;
    this.authToken = authToken;
    this.timeoutMs = timeoutMs;
  }

  async requestJson(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchWithTimeout(this.fetchImpl, url, withWorkerAuthHeader(init, this.authToken), this.timeoutMs);
    } catch (error) {
      if (isAbortError(error)) {
        throw new OperationError(
          'email_unreachable',
          `Private email lane timed out at ${url} after ${this.timeoutMs}ms.`,
          'The private source worker did not answer within the configured request budget; check worker health before retrying.',
        );
      }
      throw new OperationError(
        'email_unreachable',
        `Private email lane is unreachable at ${url}.`,
        error instanceof Error ? error.message : 'Check that the Gateway-side private email source worker is running.',
      );
    }

    if (!response.ok) {
      const body = await safeText(response);
      const workerError = isAllowlistedEmailWorkerErrorResponse(response.status, url)
        ? parseAllowlistedEmailWorkerError(body)
        : undefined;
      if (workerError) {
        throw new OperationError(workerError.code, workerError.message);
      }
      throw new OperationError(
        'email_error',
        `Private email lane returned HTTP ${response.status}.`,
        body || 'Check the Gateway-side private email source worker logs.',
      );
    }

    return response.json();
  }
}

function parseAllowlistedEmailWorkerError(body: string): {
  code: OperationErrorCode;
  message: string;
} | undefined {
  if (body.length > MAX_EMAIL_WORKER_ERROR_BODY_LENGTH) return undefined;
  try {
    if (!hasUniqueJsonObjectMembers(body)) return undefined;
    const parsed = JSON.parse(body) as unknown;
    const envelope = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
    const error = envelope?.error && typeof envelope.error === 'object' && !Array.isArray(envelope.error)
      ? envelope.error as Record<string, unknown>
      : undefined;
    const code = typeof error?.code === 'string'
      ? PASSTHROUGH_EMAIL_WORKER_ERROR_CODES.get(error.code)
      : undefined;
    const message = boundedEmailWorkerErrorMessage(error?.message);
    return code && message ? { code, message } : undefined;
  } catch {
    return undefined;
  }
}

function boundedEmailWorkerErrorMessage(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || value.length > MAX_EMAIL_WORKER_ERROR_MESSAGE_LENGTH
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
    || value.trim().length === 0
  ) return undefined;
  return value;
}

function isSourceIndexSearchRoute(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/source/index/search');
  } catch {
    return false;
  }
}

function isAllowlistedEmailWorkerErrorResponse(status: number, url: string): boolean {
  if (status === 400) return isSourceIndexSearchRoute(url);
  if (status !== 403) return false;
  try {
    return new URL(url).pathname.endsWith('/source/answer');
  } catch {
    return false;
  }
}

function hasUniqueJsonObjectMembers(input: string): boolean {
  let offset = 0;

  function skipWhitespace(): void {
    while (offset < input.length && /[\u0009\u000a\u000d\u0020]/u.test(input[offset]!)) {
      offset += 1;
    }
  }

  function parseString(): string | undefined {
    if (input[offset] !== '"') return undefined;
    const start = offset;
    offset += 1;
    while (offset < input.length) {
      const character = input[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(input.slice(start, offset)) as string;
        } catch {
          return undefined;
        }
      }
      if (character === '\\') {
        offset += 2;
      } else {
        offset += 1;
      }
    }
    return undefined;
  }

  function parseValue(depth: number): boolean {
    if (depth > 64) return false;
    skipWhitespace();
    if (input[offset] === '{') return parseObject(depth + 1);
    if (input[offset] === '[') return parseArray(depth + 1);
    if (input[offset] === '"') return parseString() !== undefined;
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(input.slice(offset));
    if (!primitive) return false;
    offset += primitive[0].length;
    return true;
  }

  function parseObject(depth: number): boolean {
    offset += 1;
    skipWhitespace();
    const members = new Set<string>();
    if (input[offset] === '}') {
      offset += 1;
      return true;
    }
    while (offset < input.length) {
      skipWhitespace();
      const member = parseString();
      if (member === undefined || members.has(member)) return false;
      members.add(member);
      skipWhitespace();
      if (input[offset] !== ':') return false;
      offset += 1;
      if (!parseValue(depth)) return false;
      skipWhitespace();
      if (input[offset] === '}') {
        offset += 1;
        return true;
      }
      if (input[offset] !== ',') return false;
      offset += 1;
    }
    return false;
  }

  function parseArray(depth: number): boolean {
    offset += 1;
    skipWhitespace();
    if (input[offset] === ']') {
      offset += 1;
      return true;
    }
    while (offset < input.length) {
      if (!parseValue(depth)) return false;
      skipWhitespace();
      if (input[offset] === ']') {
        offset += 1;
        return true;
      }
      if (input[offset] !== ',') return false;
      offset += 1;
    }
    return false;
  }

  try {
    if (!parseValue(0)) return false;
    skipWhitespace();
    return offset === input.length;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('email_error', 'Private email lane response was not a JSON object.');
  }
  return value as Record<string, unknown>;
}

function parseEmailAudit(value: unknown): EmailSafeAudit {
  const audit = asRecord(value);
  const parsed: EmailSafeAudit = {
    request_id: requiredString(audit.request_id, 'audit.request_id'),
    queries_attempted: requiredNumber(audit.queries_attempted, 'audit.queries_attempted'),
    metadata_hits: requiredNumber(audit.metadata_hits, 'audit.metadata_hits'),
    evidence_count: requiredNumber(audit.evidence_count, 'audit.evidence_count'),
    reasoner_ms: requiredNumber(audit.reasoner_ms, 'audit.reasoner_ms'),
    fallback_used: requiredBoolean(audit.fallback_used, 'audit.fallback_used'),
  };
  if (audit.planner_used !== undefined) {
    parsed.planner_used = requiredBoolean(audit.planner_used, 'audit.planner_used');
  }
  if (audit.planner_fallback_used !== undefined) {
    parsed.planner_fallback_used = requiredBoolean(audit.planner_fallback_used, 'audit.planner_fallback_used');
  }
  if (audit.planned_search_count !== undefined) {
    parsed.planned_search_count = requiredNumber(audit.planned_search_count, 'audit.planned_search_count');
  }
  if (audit.planner_failure_reason !== undefined) {
    parsed.planner_failure_reason = requiredPlannerFailureReason(audit.planner_failure_reason);
  }
  if (audit.retrieval_searches_attempted !== undefined) {
    parsed.retrieval_searches_attempted = requiredNumber(
      audit.retrieval_searches_attempted,
      'audit.retrieval_searches_attempted',
    );
  }
  if (audit.retrieval_search_summaries !== undefined) {
    parsed.retrieval_search_summaries = parseRetrievalSearchSummaries(audit.retrieval_search_summaries);
  }
  return parsed;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OperationError('email_error', `${name} must be a non-empty string.`);
  }
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OperationError('email_error', `${name} must be a finite number.`);
  }
  return value;
}

function requiredNonNegativeNumber(value: unknown, name: string): number {
  const number = requiredNumber(value, name);
  if (number < 0) {
    throw new OperationError('email_error', `${name} must be non-negative.`);
  }
  return number;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new OperationError('email_error', `${name} must be a boolean.`);
  }
  return value;
}

function requiredPlannerFailureReason(value: unknown): EmailPlannerFailureReason {
  if (
    value === 'timeout'
    || value === 'http_error'
    || value === 'invalid_json'
    || value === 'invalid_plan'
    || value === 'empty_plan'
    || value === 'error'
  ) {
    return value;
  }
  throw new OperationError('email_error', 'audit.planner_failure_reason must be a known safe planner failure reason.');
}

function parseRetrievalSearchSummaries(value: unknown): EmailRetrievalSearchSummary[] {
  if (!Array.isArray(value)) {
    throw new OperationError('email_error', 'audit.retrieval_search_summaries must be an array.');
  }

  return value.map((item, index) => {
    const summary = asRecord(item);
    const source = summary.source;
    if (source !== 'baseline' && source !== 'planner') {
      throw new OperationError('email_error', `audit.retrieval_search_summaries.${index}.source must be safe.`);
    }
    return {
      source,
      index: requiredNumber(summary.index, `audit.retrieval_search_summaries.${index}.index`),
      hits: requiredNumber(summary.hits, `audit.retrieval_search_summaries.${index}.hits`),
      new_candidates_after_dedupe: requiredNumber(
        summary.new_candidates_after_dedupe,
        `audit.retrieval_search_summaries.${index}.new_candidates_after_dedupe`,
      ),
      capped: requiredBoolean(summary.capped, `audit.retrieval_search_summaries.${index}.capped`),
    };
  });
}

function parseEmailSourcePacketResult(value: Record<string, unknown>): EmailSourcePacketResult {
  const packet = asRecord(value.packet);
  const audit = asRecord(value.audit);
  const policy = asRecord(value.policy);
  if (packet.kind !== 'email_source_packet') {
    throw new OperationError('email_error', 'email_search response packet.kind must be email_source_packet.');
  }
  if (packet.source !== 'gmail') {
    throw new OperationError('email_error', 'email_search response packet.source must be gmail.');
  }
  if (!Array.isArray(packet.items)) {
    throw new OperationError('email_error', 'email_search response packet.items must be an array.');
  }
  if (policy.raw_email_exposed !== false || policy.local_only !== true || policy.requires_local_session !== true) {
    throw new OperationError('email_error', 'email_search response policy must be local-only and raw-email-safe.');
  }
  if (audit.local_packet !== true || audit.raw_email_exposed !== false) {
    throw new OperationError('email_error', 'email_search response audit must be local packet and raw-email-safe.');
  }

  return {
    packet: {
      kind: 'email_source_packet',
      packet_id: requiredString(packet.packet_id, 'packet.packet_id'),
      source: 'gmail',
      ...(typeof packet.account === 'string' ? { account: packet.account } : {}),
      items: packet.items.map(parseEmailSourcePacketItem),
    },
    audit: {
      request_id: requiredString(audit.request_id, 'audit.request_id'),
      queries_attempted: requiredNumber(audit.queries_attempted, 'audit.queries_attempted'),
      metadata_hits: requiredNumber(audit.metadata_hits, 'audit.metadata_hits'),
      items_returned: requiredNumber(audit.items_returned, 'audit.items_returned'),
      sanitized_reads_attempted: requiredNumber(audit.sanitized_reads_attempted, 'audit.sanitized_reads_attempted'),
      sanitized_reads_succeeded: requiredNumber(audit.sanitized_reads_succeeded, 'audit.sanitized_reads_succeeded'),
      truncated: requiredBoolean(audit.truncated, 'audit.truncated'),
      local_packet: true,
      raw_email_exposed: false,
      ...(audit.retrieval_source === 'local_index' ? { retrieval_source: 'local_index' as const } : {}),
      ...(audit.retrieval_mode === 'keyword' || audit.retrieval_mode === 'hybrid'
        ? { retrieval_mode: audit.retrieval_mode }
        : {}),
      ...(audit.requested_retrieval_mode === 'keyword' || audit.requested_retrieval_mode === 'hybrid'
        ? { requested_retrieval_mode: audit.requested_retrieval_mode }
        : {}),
      ...(typeof audit.keyword_candidates === 'number' ? { keyword_candidates: audit.keyword_candidates } : {}),
      ...(typeof audit.vector_candidates === 'number' ? { vector_candidates: audit.vector_candidates } : {}),
      ...(typeof audit.fused_candidates === 'number' ? { fused_candidates: audit.fused_candidates } : {}),
      ...(typeof audit.semantic_skipped_reason === 'string'
        ? { semantic_skipped_reason: audit.semantic_skipped_reason }
        : {}),
      ...(typeof audit.embedding_model_id === 'string' ? { embedding_model_id: audit.embedding_model_id } : {}),
      ...(audit.vector_backend === 'exact_scan' ? { vector_backend: 'exact_scan' as const } : {}),
      ...(typeof audit.latency_ms === 'number' ? { latency_ms: audit.latency_ms } : {}),
      ...(typeof audit.threads_returned === 'number' ? { threads_returned: audit.threads_returned } : {}),
    },
    policy: {
      raw_email_exposed: false,
      local_only: true,
      requires_local_session: true,
    },
  };
}

function parseEmailSourcePacketItem(value: unknown): EmailSourcePacketItem {
  const item = asRecord(value);
  const provenance = asRecord(item.provenance);
  if (provenance.source !== 'gmail' && provenance.provider !== 'gmail') {
    throw new OperationError('email_error', 'packet item provenance provider/source must be gmail.');
  }
  return {
    ...(typeof item.item_id === 'string' ? { item_id: item.item_id } : {}),
    ...(typeof item.thread_id === 'string' ? { thread_id: item.thread_id } : {}),
    ...(typeof item.subject === 'string' ? { subject: item.subject } : {}),
    ...(typeof item.from === 'string' ? { from: item.from } : {}),
    ...(typeof item.to === 'string' ? { to: item.to } : {}),
    ...(typeof item.date === 'string' ? { date: item.date } : {}),
    ...(typeof item.sanitized_text === 'string' ? { sanitized_text: item.sanitized_text } : {}),
    provenance: {
      ...(provenance.source === 'gmail' ? { source: 'gmail' as const } : {}),
      ...(provenance.provider === 'gmail' ? { provider: 'gmail' as const } : {}),
      ...(typeof provenance.account === 'string' ? { account: provenance.account } : {}),
      ...(typeof provenance.message_id === 'string' ? { message_id: provenance.message_id } : {}),
      ...(typeof provenance.thread_id === 'string' ? { thread_id: provenance.thread_id } : {}),
      ...(typeof provenance.local_message_id === 'string' ? { local_message_id: provenance.local_message_id } : {}),
      ...(Array.isArray(provenance.chunk_ids) ? { chunk_ids: provenance.chunk_ids.filter((id): id is string => typeof id === 'string') } : {}),
      ...(typeof provenance.sync_run_id === 'string' ? { sync_run_id: provenance.sync_run_id } : {}),
      ...(typeof provenance.checkpoint_id === 'string' ? { checkpoint_id: provenance.checkpoint_id } : {}),
      ...(typeof provenance.source_version === 'string' ? { source_version: provenance.source_version } : {}),
    },
  };
}

function parseSourceIndexAnswerResult(value: Record<string, unknown>): SourceIndexAnswerResult {
  const answer = requiredString(value.answer, 'answer');
  if (!Array.isArray(value.evidence)) {
    throw new OperationError('email_error', 'source answer evidence must be an array.');
  }
  const audit = asRecord(value.audit);
  const policy = asRecord(value.policy);
  if (audit.raw_source_exposed !== false) {
    throw new OperationError('email_error', 'source answer audit must be raw-source-safe.');
  }
  if (
    policy.raw_source_exposed !== false
    || policy.source_packets_exposed !== false
    || typeof policy.secure_local_content_exposed !== 'boolean'
    || policy.castor_safe_bridge !== true
  ) {
    throw new OperationError('email_error', 'source answer policy must describe a calling-assistant-safe bridge.');
  }
  if (!Array.isArray(audit.searched_corpora) || !Array.isArray(audit.skipped_corpora) || !Array.isArray(audit.lane_audits)) {
    throw new OperationError('email_error', 'source answer audit must include corpus and lane arrays.');
  }
  const answerSynthesis = audit.answer_synthesis === undefined
    ? undefined
    : parseSourceAnswerSynthesisAudit(audit.answer_synthesis);
  const selfHeal = audit.self_heal === undefined
    ? undefined
    : parseSourceAnswerSelfHealAudit(audit.self_heal);
  return {
    answer,
    evidence: value.evidence,
    audit: {
      searched_corpora: audit.searched_corpora.filter((corpus): corpus is string => typeof corpus === 'string'),
      skipped_corpora: audit.skipped_corpora,
      lane_audits: audit.lane_audits,
      ...(selfHeal ? { self_heal: selfHeal } : {}),
      ...(answerSynthesis ? { answer_synthesis: answerSynthesis } : {}),
      latency_ms: requiredNumber(audit.latency_ms, 'audit.latency_ms'),
      ...(audit.phase_timings !== undefined ? { phase_timings: parseSourceAnswerPhaseTimings(audit.phase_timings) } : {}),
      raw_source_exposed: false,
    },
    policy: {
      raw_source_exposed: false,
      source_packets_exposed: false,
      internal_content_exposed: policy.internal_content_exposed === true,
      secure_local_content_exposed: policy.secure_local_content_exposed,
      castor_safe_bridge: true,
    },
    ...(value.internal_context !== undefined ? { internal_context: value.internal_context } : {}),
    ...(value.opsec !== undefined ? { opsec: parseSourceAnswerOpsec(value.opsec) } : {}),
  };
}

function parseSourceAnswerSelfHealAudit(
  value: unknown,
): NonNullable<SourceIndexAnswerResult['audit']['self_heal']> | undefined {
  const audit = asRecord(value);
  const outcome = audit.outcome;
  if (outcome !== 'healed' && outcome !== 'in_progress' && outcome !== 'failed' && outcome !== 'skipped') {
    return undefined;
  }
  const action = audit.action;
  if (action !== undefined && action !== 'forced_reextract') {
    return undefined;
  }
  const parsed: NonNullable<SourceIndexAnswerResult['audit']['self_heal']> = {
    attempted: audit.attempted === true,
    outcome,
  };
  if (typeof audit.corpus_id === 'string') parsed.corpus_id = audit.corpus_id;
  if (typeof audit.entry_id_hash === 'string') parsed.entry_id_hash = audit.entry_id_hash;
  if (typeof audit.provider_file_id_hash === 'string') parsed.provider_file_id_hash = audit.provider_file_id_hash;
  if (action === 'forced_reextract') parsed.action = action;
  if (typeof audit.retry_after_ms === 'number' && Number.isFinite(audit.retry_after_ms)) {
    parsed.retry_after_ms = Math.max(0, Math.floor(audit.retry_after_ms));
  }
  if (typeof audit.reason === 'string') parsed.reason = audit.reason;
  if (audit.prior_state !== undefined) {
    const prior = asRecord(audit.prior_state);
    parsed.prior_state = {
      ...(typeof prior.extraction_status === 'string' ? { extraction_status: prior.extraction_status } : {}),
      ...(typeof prior.extraction_completeness === 'string' ? { extraction_completeness: prior.extraction_completeness } : {}),
    };
  }
  return parsed;
}

function parseSourceAnswerPhaseTimings(value: unknown): SourceIndexAnswerPhaseTimings {
  const timings = asRecord(value);
  const parsed: SourceIndexAnswerPhaseTimings = {
    lane_setup_ms: requiredNonNegativeNumber(timings.lane_setup_ms, 'audit.phase_timings.lane_setup_ms'),
    bulk_gate_ms: requiredNonNegativeNumber(timings.bulk_gate_ms, 'audit.phase_timings.bulk_gate_ms'),
    total_ms: requiredNonNegativeNumber(timings.total_ms, 'audit.phase_timings.total_ms'),
  };
  if (timings.evidence_pack_ms !== undefined) {
    parsed.evidence_pack_ms = requiredNonNegativeNumber(
      timings.evidence_pack_ms,
      'audit.phase_timings.evidence_pack_ms',
    );
  }
  if (timings.self_heal_ms !== undefined) {
    parsed.self_heal_ms = requiredNonNegativeNumber(timings.self_heal_ms, 'audit.phase_timings.self_heal_ms');
  }
  if (timings.analyst_ms !== undefined) {
    parsed.analyst_ms = requiredNonNegativeNumber(timings.analyst_ms, 'audit.phase_timings.analyst_ms');
  }
  if (timings.release_gate_ms !== undefined) {
    parsed.release_gate_ms = requiredNonNegativeNumber(
      timings.release_gate_ms,
      'audit.phase_timings.release_gate_ms',
    );
  }
  return parsed;
}

function parseSourceAnswerSynthesisAudit(value: unknown): NonNullable<SourceIndexAnswerResult['audit']['answer_synthesis']> {
  const audit = asRecord(value);
  if (audit.raw_source_exposed !== false) {
    throw new OperationError('email_error', 'source answer synthesis audit must be raw-source-safe.');
  }
  const analystBackend =
    audit.analyst_backend === 'local' || audit.analyst_backend === 'venice' || audit.analyst_backend === 'cloud'
      ? audit.analyst_backend
      : undefined;
  const requestedProvider =
    audit.requested_analyst_provider === 'default'
    || audit.requested_analyst_provider === 'local'
    || audit.requested_analyst_provider === 'venice'
    || audit.requested_analyst_provider === 'cloud'
      ? audit.requested_analyst_provider
      : undefined;
  const analystFallback = audit.analyst_fallback === undefined
    ? undefined
    : parseSourceAnswerAnalystFallback(audit.analyst_fallback);
  return {
    ...(analystBackend ? { analyst_backend: analystBackend } : {}),
    ...(requestedProvider ? { requested_analyst_provider: requestedProvider } : {}),
    ...(typeof audit.requested_analyst_model === 'string' ? { requested_analyst_model: audit.requested_analyst_model } : {}),
    ...(analystFallback ? { analyst_fallback: analystFallback } : {}),
    ...(typeof audit.private_context_used === 'boolean' ? { private_context_used: audit.private_context_used } : {}),
    ...(typeof audit.secure_local_items_consulted === 'number' ? { secure_local_items_consulted: audit.secure_local_items_consulted } : {}),
    ...(typeof audit.internal_items_consulted === 'number' ? { internal_items_consulted: audit.internal_items_consulted } : {}),
    raw_source_exposed: false,
  };
}

function parseSourceAnswerAnalystFallback(
  value: unknown,
): NonNullable<NonNullable<SourceIndexAnswerResult['audit']['answer_synthesis']>['analyst_fallback']> {
  const fallback = asRecord(value);
  const from = fallback.from === 'venice' || fallback.from === 'cloud' ? fallback.from : undefined;
  const reason =
    fallback.reason === 'timeout'
    || fallback.reason === 'escalation'
    || fallback.reason === 'unavailable'
    || isSanitizedAnalystFallbackReason(fallback.reason)
      ? fallback.reason
      : undefined;
  if (!from || fallback.to !== 'local' || !reason) {
    throw new OperationError('email_error', 'source answer analyst fallback audit is invalid.');
  }
  return {
    from,
    to: 'local',
    reason,
    ...(fallback.elapsed_ms !== undefined
      ? { elapsed_ms: requiredNonNegativeNumber(fallback.elapsed_ms, 'audit.answer_synthesis.analyst_fallback.elapsed_ms') }
      : {}),
    ...(fallback.timeout_ms !== undefined
      ? { timeout_ms: requiredNonNegativeNumber(fallback.timeout_ms, 'audit.answer_synthesis.analyst_fallback.timeout_ms') }
      : {}),
  };
}

function isSanitizedAnalystFallbackReason(value: unknown): value is NonNullable<NonNullable<SourceIndexAnswerResult['audit']['answer_synthesis']>['analyst_fallback']>['reason'] {
  return typeof value === 'string' && /^(venice|cloud)_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value);
}

function parseSourceIndexStatusResult(value: Record<string, unknown>): SourceIndexStatusResult {
  if (value.kind !== 'source_index_status') {
    throw new OperationError('email_error', 'source index status result must have kind=source_index_status.');
  }
  const policy = asRecord(value.policy);
  if (
    policy.read_only !== true
    || policy.raw_source_exposed !== false
    || policy.source_packets_exposed !== false
    || policy.source_text_returned !== false
    || policy.secure_local_item_metadata_exposed !== false
    || policy.castor_visible !== true
  ) {
    throw new OperationError('email_error', 'source index status policy must describe a read-only calling-assistant-visible result.');
  }
  if (typeof value.generated_at !== 'string') {
    throw new OperationError('email_error', 'source index status must include generated_at.');
  }
  if (!Array.isArray(value.corpora)) {
    throw new OperationError('email_error', 'source index status corpora must be an array.');
  }
  return {
    kind: 'source_index_status',
    generated_at: value.generated_at,
    corpora: value.corpora,
    ...(value.ingestion_ledger !== undefined ? { ingestion_ledger: value.ingestion_ledger } : {}),
    ...(value.sender_aggregation !== undefined ? { sender_aggregation: value.sender_aggregation } : {}),
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
}

function parseSourceIndexSearchResult(value: Record<string, unknown>, context: {
  config: OlympusConfig;
  requestedCorpusId: string;
  includeLocators: boolean;
}): SourceIndexSearchResult {
  if (value.kind !== 'source_index_search') {
    throw new OperationError('email_error', 'source index search result must have kind=source_index_search.');
  }
  if (typeof value.corpus_id !== 'string') {
    throw new OperationError('email_error', 'source index search returned an unsupported corpus.');
  }
  const corpusId = value.corpus_id;
  if (corpusId !== context.requestedCorpusId) {
    throw new OperationError('email_error', 'source index search returned a different corpus than requested.');
  }
  const corpus = createSourceCorpusRegistry(context.config.sourceIndex.corpusRegistry).list('search')
    .find((entry) => entry.corpusId === corpusId);
  if (!corpus) {
    throw new OperationError('email_error', 'source index search returned an unsupported corpus.');
  }
  if (!Array.isArray(value.hits)) {
    throw new OperationError('email_error', 'source index search hits must be an array.');
  }
  const audit = asRecord(value.audit);
  const policy = asRecord(value.policy);
  const sourceTextReturned = audit.source_text_returned === true || policy.source_text_returned === true;
  const sourceTextAllowed =
    sourceTextReturned === false
    || (
      corpusId === 'internal.x.bookmarks'
      && policy.trust_domain === 'internal'
      && audit.raw_source_exposed === false
      && policy.raw_source_exposed === false
    );
  if (
    audit.raw_source_exposed !== false
    || policy.raw_source_exposed !== false
    || (audit.source_text_returned !== false && audit.source_text_returned !== true)
    || (policy.source_text_returned !== false && policy.source_text_returned !== true)
    || !sourceTextAllowed
    || policy.source_packets_exposed !== false
    || typeof policy.local_only !== 'boolean'
    || (corpus.trustDomain === 'secure_local' && policy.local_only !== true)
    || policy.trust_domain !== corpus.trustDomain
  ) {
    throw new OperationError('email_error', 'source index search policy must describe a local safe result.');
  }
  const retrievalMode = optionalRetrievalMode(audit.retrieval_mode);
  const requestedRetrievalMode = optionalRetrievalMode(audit.requested_retrieval_mode);
  const locatorsExposed = policy.locators_exposed === true;
  const locatorPolicyPresent = Object.prototype.hasOwnProperty.call(policy, 'locators_exposed')
    || Object.prototype.hasOwnProperty.call(policy, 'locator_release');
  const containsLocators = containsLocatorPayload(value.hits);
  const locatorReleaseDeclared = corpus.family === 'file' && corpus.provider === 'dropbox';
  if (
    (context.includeLocators || locatorPolicyPresent || containsLocators)
    && !locatorReleaseDeclared
  ) {
    throw new OperationError('email_error', 'source index locator release is not declared for the selected corpus.');
  }
  if (locatorsExposed && policy.locator_release !== 'explicit_request') {
    throw new OperationError('email_error', 'source index locator policy must require explicit request release.');
  }
  if (locatorsExposed && (!context.includeLocators || audit.locators_requested !== true)) {
    throw new OperationError('email_error', 'source index locator release requires include_locators=true.');
  }
  if (containsLocators && !locatorsExposed) {
    throw new OperationError('email_error', 'source index search returned locator fields without locator release policy.');
  }
  if (!locatorsExposed && locatorPolicyPresent) {
    throw new OperationError('email_error', 'source index locator policy must only be present for an actual release.');
  }
  if (audit.locators_requested === true && !context.includeLocators) {
    throw new OperationError('email_error', 'source index locator request audit does not match the original request.');
  }
  if (context.includeLocators && audit.locators_requested !== true) {
    throw new OperationError('email_error', 'source index locator request audit must report include_locators=true intent.');
  }
  if (
    !context.includeLocators
    && Object.prototype.hasOwnProperty.call(audit, 'locators_requested')
  ) {
    throw new OperationError('email_error', 'source index locator request audit must be absent without locator intent.');
  }
  if (locatorsExposed && validateDropboxLocatorPayloads(value.hits) === 0) {
    throw new OperationError('email_error', 'source index locator policy requires at least one released locator.');
  }
  return {
    kind: 'source_index_search',
    corpus_id: corpusId,
    retrieval_source: 'local_index',
    hits: value.hits,
    audit: {
      request_id: requiredString(audit.request_id, 'audit.request_id'),
      retrieval_source: 'local_index',
      queries_attempted: requiredNumber(audit.queries_attempted, 'audit.queries_attempted'),
      ...(retrievalMode !== undefined ? { retrieval_mode: retrievalMode } : {}),
      ...(requestedRetrievalMode !== undefined ? { requested_retrieval_mode: requestedRetrievalMode } : {}),
      ...(typeof audit.keyword_candidates === 'number' ? { keyword_candidates: audit.keyword_candidates } : {}),
      ...(typeof audit.vector_candidates === 'number' ? { vector_candidates: audit.vector_candidates } : {}),
      ...(typeof audit.fused_candidates === 'number' ? { fused_candidates: audit.fused_candidates } : {}),
      ...(typeof audit.semantic_skipped_reason === 'string' ? { semantic_skipped_reason: audit.semantic_skipped_reason } : {}),
      ...(typeof audit.embedding_model_id === 'string' ? { embedding_model_id: audit.embedding_model_id } : {}),
      ...(typeof audit.embedding_epoch === 'string' ? { embedding_epoch: audit.embedding_epoch } : {}),
      ...(typeof audit.vector_backend === 'string' ? { vector_backend: audit.vector_backend } : {}),
      metadata_hits: requiredNumber(audit.metadata_hits, 'audit.metadata_hits'),
      items_returned: requiredNumber(audit.items_returned, 'audit.items_returned'),
      latency_ms: requiredNumber(audit.latency_ms, 'audit.latency_ms'),
      raw_source_exposed: false,
      source_text_returned: sourceTextReturned,
      ...(typeof audit.locators_requested === 'boolean' ? { locators_requested: audit.locators_requested } : {}),
    },
    policy: {
      raw_source_exposed: false,
      source_text_returned: sourceTextReturned,
      source_packets_exposed: false,
      local_only: policy.local_only,
      trust_domain: corpus.trustDomain,
      ...(locatorsExposed ? { locators_exposed: true, locator_release: 'explicit_request' as const } : {}),
    },
  };
}

function withSourceWatchHeaders(route: SourceWatchAuthenticatedRoute): Headers {
  const headers = sourceWatchAuthenticatedRouteHeaders(route);
  headers.set('Content-Type', 'application/json');
  return headers;
}

function parseSourceWatchResult(value: unknown, kind: 'source_watch'): SourceWatchResult;
function parseSourceWatchResult(value: unknown, kind: 'source_watches'): SourceWatchesResult;
function parseSourceWatchResult(
  value: unknown,
  kind: 'source_watch' | 'source_watches',
): SourceWatchResult | SourceWatchesResult {
  const record = asRecord(value);
  assertNoRawEmailFields(record);
  assertNoSourceIndexOperationalLeakFields(record);
  if (record.kind !== kind) {
    throw new OperationError('email_error', `Source watch result must have kind=${kind}.`);
  }
  const policy = asRecord(record.policy);
  if (
    policy.raw_source_exposed !== false
    || policy.source_text_returned !== false
    || policy.message_bodies_returned !== false
    || policy.evidence_pointers_only !== true
  ) {
    throw new OperationError('email_error', 'Source watch result must be content-free and evidence-pointer-only.');
  }
  const safePolicy: SourceWatchResult['policy'] = {
    raw_source_exposed: false,
    source_text_returned: false,
    message_bodies_returned: false,
    evidence_pointers_only: true,
  };
  if (kind === 'source_watch') {
    return {
      kind,
      watch: asRecord(record.watch),
      policy: safePolicy,
    };
  }
  if (!Array.isArray(record.watches)) {
    throw new OperationError('email_error', 'Source watch list must include watches.');
  }
  return {
    kind,
    watches: record.watches.map(asRecord),
    ...(typeof record.next_cursor === 'string' ? { next_cursor: record.next_cursor } : {}),
    policy: safePolicy,
  };
}

function parseSourceIndexPromotionCandidatesResult(value: Record<string, unknown>): SourceIndexPromotionCandidatesResult {
  if (value.kind !== 'dropbox_content_promotion_candidates') {
    throw new OperationError('email_error', 'source index promotion candidates result must have kind=dropbox_content_promotion_candidates.');
  }
  if (value.corpus_id !== 'secure_local.dropbox.files' || value.provider !== 'dropbox') {
    throw new OperationError('email_error', 'source index promotion candidates returned an unsupported corpus.');
  }
  if (!Array.isArray(value.candidates)) {
    throw new OperationError('email_error', 'source index promotion candidates must include a candidates array.');
  }
  const policy = asRecord(value.policy);
  if (
    policy.raw_source_exposed !== false
    || policy.source_text_returned !== false
    || policy.local_only !== true
    || policy.trust_domain !== 'secure_local'
    || policy.promotion_write_performed !== false
  ) {
    throw new OperationError('email_error', 'source index promotion candidates policy must describe read-only secure-local review metadata.');
  }
  return {
    kind: 'dropbox_content_promotion_candidates',
    corpus_id: 'secure_local.dropbox.files',
    provider: 'dropbox',
    account: requiredString(value.account, 'account'),
    scope_key_hash: requiredString(value.scope_key_hash, 'scope_key_hash'),
    candidates: value.candidates,
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      local_only: true,
      trust_domain: 'secure_local',
      promotion_write_performed: false,
    },
  };
}

function parseSourceIndexPromotionProposalResult(value: Record<string, unknown>): SourceIndexPromotionProposalResult {
  if (value.kind !== 'dropbox_content_promotion_proposal') {
    throw new OperationError('email_error', 'source index promotion proposal result must have kind=dropbox_content_promotion_proposal.');
  }
  if (value.corpus_id !== 'secure_local.dropbox.files' || value.provider !== 'dropbox') {
    throw new OperationError('email_error', 'source index promotion proposal returned an unsupported corpus.');
  }
  const policy = asRecord(value.policy);
  if (
    policy.raw_source_exposed !== false
    || policy.source_text_returned !== false
    || policy.local_only !== true
    || policy.trust_domain !== 'secure_local'
    || policy.resource_write_performed !== false
    || policy.proposal_only !== true
  ) {
    throw new OperationError('email_error', 'source index promotion proposal policy must describe a local proposal-only write.');
  }
  return {
    kind: 'dropbox_content_promotion_proposal',
    corpus_id: 'secure_local.dropbox.files',
    provider: 'dropbox',
    account: requiredString(value.account, 'account'),
    scope_key_hash: requiredString(value.scope_key_hash, 'scope_key_hash'),
    proposal_id: requiredString(value.proposal_id, 'proposal_id'),
    proposal_revision_id: requiredString(value.proposal_revision_id, 'proposal_revision_id'),
    status: 'proposed',
    canonical_type: requiredString(value.canonical_type, 'canonical_type') as SourceIndexPromotionCanonicalType,
    target_surface: requiredString(value.target_surface, 'target_surface') as SourceIndexPromotionTargetSurface,
    reason_code: requiredString(value.reason_code, 'reason_code') as SourceIndexPromotionReasonCode,
    evidence_count: requiredNumber(value.evidence_count, 'evidence_count'),
    trust_domain: 'secure_local',
    trust_tiers: Array.isArray(value.trust_tiers) ? value.trust_tiers.map(String) : [],
    policy_decisions: Array.isArray(value.policy_decisions) ? value.policy_decisions.map(String) : [],
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      local_only: true,
      trust_domain: 'secure_local',
      resource_write_performed: false,
      proposal_only: true,
    },
  };
}

function parseSourceIndexPromotionProposalsResult(value: Record<string, unknown>): SourceIndexPromotionProposalsResult {
  if (value.kind !== 'dropbox_content_promotion_proposals') {
    throw new OperationError('email_error', 'source index promotion proposals result must have kind=dropbox_content_promotion_proposals.');
  }
  if (value.corpus_id !== 'secure_local.dropbox.files' || value.provider !== 'dropbox') {
    throw new OperationError('email_error', 'source index promotion proposals returned an unsupported corpus.');
  }
  if (!Array.isArray(value.proposals)) {
    throw new OperationError('email_error', 'source index promotion proposals must include a proposals array.');
  }
  const policy = asRecord(value.policy);
  if (
    policy.raw_source_exposed !== false
    || policy.source_text_returned !== false
    || policy.local_only !== true
    || policy.trust_domain !== 'secure_local'
    || policy.resource_write_performed !== false
  ) {
    throw new OperationError('email_error', 'source index promotion proposals policy must describe read-only secure-local review metadata.');
  }
  return {
    kind: 'dropbox_content_promotion_proposals',
    corpus_id: 'secure_local.dropbox.files',
    provider: 'dropbox',
    proposals: value.proposals.map((proposal) => parseSourceIndexPromotionProposalSummary(asRecord(proposal))),
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      local_only: true,
      trust_domain: 'secure_local',
      resource_write_performed: false,
    },
  };
}

function parseSourceIndexPromotionProposalDetailResult(value: Record<string, unknown>): SourceIndexPromotionProposalDetailResult {
  if (value.kind !== 'dropbox_content_promotion_proposal_detail') {
    throw new OperationError('email_error', 'source index promotion proposal detail result must have kind=dropbox_content_promotion_proposal_detail.');
  }
  if (value.corpus_id !== 'secure_local.dropbox.files' || value.provider !== 'dropbox') {
    throw new OperationError('email_error', 'source index promotion proposal detail returned an unsupported corpus.');
  }
  if (!Array.isArray(value.evidence) || !Array.isArray(value.decisions)) {
    throw new OperationError('email_error', 'source index promotion proposal detail must include evidence and decisions arrays.');
  }
  const policy = asRecord(value.policy);
  if (
    policy.raw_source_exposed !== false
    || policy.source_text_returned !== false
    || policy.local_only !== true
    || policy.trust_domain !== 'secure_local'
    || policy.resource_write_performed !== false
  ) {
    throw new OperationError('email_error', 'source index promotion proposal detail policy must describe read-only secure-local review metadata.');
  }
  return {
    kind: 'dropbox_content_promotion_proposal_detail',
    corpus_id: 'secure_local.dropbox.files',
    provider: 'dropbox',
    proposal: parseSourceIndexPromotionProposalSummary(asRecord(value.proposal)),
    evidence: value.evidence.map((item) => {
      const record = asRecord(item);
      return {
        classification_id: requiredString(record.classification_id, 'classification_id'),
        evidence_ordinal: requiredNumber(record.evidence_ordinal, 'evidence_ordinal'),
        target_kind: requiredString(record.target_kind, 'target_kind'),
        source_content_hash: requiredString(record.source_content_hash, 'source_content_hash'),
        provider_file_id_hash: requiredString(record.provider_file_id_hash, 'provider_file_id_hash'),
        ...(record.revision_hash !== undefined ? { revision_hash: requiredString(record.revision_hash, 'revision_hash') } : {}),
        ...(record.content_hash !== undefined ? { content_hash: requiredString(record.content_hash, 'content_hash') } : {}),
        ...(record.structural_ref_hash !== undefined ? { structural_ref_hash: requiredString(record.structural_ref_hash, 'structural_ref_hash') } : {}),
        trust_tier: requiredString(record.trust_tier, 'trust_tier'),
        trust_domain: 'secure_local',
        policy_decision: requiredString(record.policy_decision, 'policy_decision'),
        review_status_at_proposal: requiredString(record.review_status_at_proposal, 'review_status_at_proposal'),
        finding_count: requiredNumber(record.finding_count, 'finding_count'),
      };
    }),
    decisions: value.decisions.map((item) => {
      const record = asRecord(item);
      if (record.resource_write_performed !== false || record.execution_performed !== false) {
        throw new OperationError('email_error', 'source index promotion decisions must not report external writes or executions.');
      }
      return {
        decision_id: requiredString(record.decision_id, 'decision_id'),
        decision: requiredString(record.decision, 'decision') as SourceIndexPromotionDecision,
        ...(record.reason_code !== undefined ? { reason_code: requiredString(record.reason_code, 'reason_code') as SourceIndexPromotionReasonCode } : {}),
        decided_at: requiredString(record.decided_at, 'decided_at'),
        resource_write_performed: false,
        execution_performed: false,
      };
    }),
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      local_only: true,
      trust_domain: 'secure_local',
      resource_write_performed: false,
    },
  };
}

function parseSourceIndexPromotionProposalSummary(record: Record<string, unknown>): SourceIndexPromotionProposalSummary {
  if (record.resource_write_performed !== false) {
    throw new OperationError('email_error', 'source index promotion proposal summaries must not report external resource writes.');
  }
  return {
    proposal_id: requiredString(record.proposal_id, 'proposal_id'),
    proposal_revision_id: requiredString(record.proposal_revision_id, 'proposal_revision_id'),
    account: requiredString(record.account, 'account'),
    scope_key_hash: requiredString(record.scope_key_hash, 'scope_key_hash'),
    canonical_type: requiredString(record.canonical_type, 'canonical_type') as SourceIndexPromotionCanonicalType,
    target_surface: requiredString(record.target_surface, 'target_surface') as SourceIndexPromotionTargetSurface,
    reason_code: requiredString(record.reason_code, 'reason_code') as SourceIndexPromotionReasonCode,
    status: requiredString(record.status, 'status') as SourceIndexPromotionProposalStatus,
    evidence_count: requiredNumber(record.evidence_count, 'evidence_count'),
    decision_count: requiredNumber(record.decision_count, 'decision_count'),
    resource_write_performed: false,
    created_at: requiredString(record.created_at, 'created_at'),
    updated_at: requiredString(record.updated_at, 'updated_at'),
  };
}

function parseSourceIndexPromotionDecisionResult(value: Record<string, unknown>): SourceIndexPromotionDecisionResult {
  if (value.kind !== 'dropbox_content_promotion_decision') {
    throw new OperationError('email_error', 'source index promotion decision result must have kind=dropbox_content_promotion_decision.');
  }
  if (value.corpus_id !== 'secure_local.dropbox.files' || value.provider !== 'dropbox') {
    throw new OperationError('email_error', 'source index promotion decision returned an unsupported corpus.');
  }
  const policy = asRecord(value.policy);
  if (
    policy.raw_source_exposed !== false
    || policy.source_text_returned !== false
    || policy.local_only !== true
    || policy.trust_domain !== 'secure_local'
    || policy.resource_write_performed !== false
    || policy.execution_performed !== false
  ) {
    throw new OperationError('email_error', 'source index promotion decision policy must describe a local review-ledger write only.');
  }
  const decision = requiredString(value.decision, 'decision') as SourceIndexPromotionDecision;
  return {
    kind: 'dropbox_content_promotion_decision',
    corpus_id: 'secure_local.dropbox.files',
    provider: 'dropbox',
    proposal_id: requiredString(value.proposal_id, 'proposal_id'),
    decision_id: requiredString(value.decision_id, 'decision_id'),
    decision,
    status: decision,
    evidence_count: requiredNumber(value.evidence_count, 'evidence_count'),
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      local_only: true,
      trust_domain: 'secure_local',
      resource_write_performed: false,
      execution_performed: false,
    },
  };
}

function optionalRetrievalMode(value: unknown): 'keyword' | 'hybrid' | undefined {
  return value === 'keyword' || value === 'hybrid' ? value : undefined;
}

function containsLocatorPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsLocatorPayload);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
    SOURCE_INDEX_LOCATOR_KEYS.has(key) || containsLocatorPayload(child)
  ));
}

function validateDropboxLocatorPayloads(hits: readonly unknown[]): number {
  let count = 0;
  for (const hit of hits) {
    if (!hit || typeof hit !== 'object' || Array.isArray(hit)) {
      throw new OperationError('email_error', 'source index locator release requires object-shaped hits.');
    }
    const record = hit as Record<string, unknown>;
    const { locator, ...withoutLocator } = record;
    if (containsLocatorPayload(withoutLocator)) {
      throw new OperationError('email_error', 'source index locator fields must appear only in hit.locator.');
    }
    if (!Object.prototype.hasOwnProperty.call(record, 'locator')) continue;
    const sourceItem = record.sourceItem;
    if (!sourceItem || typeof sourceItem !== 'object' || Array.isArray(sourceItem)) {
      throw new OperationError('email_error', 'source index locator release requires a source item identity.');
    }
    const sourceIdentity = sourceItem as Record<string, unknown>;
    if (sourceIdentity.family !== 'file' || sourceIdentity.provider !== 'dropbox') {
      throw new OperationError('email_error', 'source index locator release is only valid for Dropbox file hits.');
    }
    validateDropboxLocatorShape(locator);
    count += 1;
  }
  return count;
}

function validateDropboxLocatorShape(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('email_error', 'source index Dropbox locator must be an object.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const allowedKeys = new Set<string>([...DROPBOX_LOCATOR_REQUIRED_KEYS, ...DROPBOX_LOCATOR_OPTIONAL_KEYS]);
  if (keys.some((key) => !allowedKeys.has(key))) {
    throw new OperationError('email_error', 'source index Dropbox locator contains an unsupported field.');
  }
  for (const key of DROPBOX_LOCATOR_REQUIRED_KEYS) {
    if (typeof record[key] !== 'string' || record[key].length === 0) {
      throw new OperationError('email_error', `source index Dropbox locator requires string field ${key}.`);
    }
  }
  for (const key of DROPBOX_LOCATOR_OPTIONAL_KEYS) {
    if (
      Object.prototype.hasOwnProperty.call(record, key)
      && (typeof record[key] !== 'string' || record[key].length === 0)
    ) {
      throw new OperationError('email_error', `source index Dropbox locator field ${key} must be a non-empty string.`);
    }
  }
  const displayPath = record.display_path as string;
  const parentDisplayPath = record.parent_display_path as string;
  if (
    displayPath !== displayPath.trim()
    || !displayPath.startsWith('/')
    || displayPath === '/'
    || parentDisplayPath !== parentDisplayPath.trim()
    || !parentDisplayPath.startsWith('/')
  ) {
    throw new OperationError('email_error', 'source index Dropbox locator paths must be rooted normalized strings.');
  }
  if (
    !isDropboxHomeUrl(record.dropbox_web_url as string)
    || !isDropboxHomeUrl(record.parent_dropbox_web_url as string)
  ) {
    throw new OperationError('email_error', 'source index Dropbox locator web URLs must use the Dropbox home HTTPS origin.');
  }
  for (const key of DROPBOX_LOCATOR_OPTIONAL_KEYS) {
    if (typeof record[key] === 'string' && !isFileUrl(record[key])) {
      throw new OperationError('email_error', `source index Dropbox locator field ${key} must use the file URL scheme.`);
    }
  }
}

function isDropboxHomeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'www.dropbox.com'
      && url.username === ''
      && url.password === ''
      && url.port === ''
      && url.search === ''
      && url.hash === ''
      && (url.pathname === '/home' || url.pathname.startsWith('/home/'));
  } catch {
    return false;
  }
}

function isFileUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'file:';
  } catch {
    return false;
  }
}

const SOURCE_INDEX_LOCATOR_KEYS = new Set([
  'locator',
  'display_path',
  'parent_display_path',
  'dropbox_web_url',
  'parent_dropbox_web_url',
  'finder_url',
  'parent_finder_url',
  'locator_uri',
]);

const DROPBOX_LOCATOR_REQUIRED_KEYS = [
  'display_path',
  'parent_display_path',
  'dropbox_web_url',
  'parent_dropbox_web_url',
] as const;

const DROPBOX_LOCATOR_OPTIONAL_KEYS = [
  'finder_url',
  'parent_finder_url',
] as const;

const FORBIDDEN_SOURCE_INDEX_OPERATIONAL_KEYS = new Set([
  'access_token',
  'approved_scope_key',
  'authorization',
  'bounded_text',
  'chat_scope',
  'cursor',
  'folder_path',
  'path_display',
  'path_lower',
  'provider_cursor',
  'session_path',
  'token',
]);

function assertNoSourceIndexOperationalLeakFields(value: unknown): void {
  assertNoSourceIndexOperationalLeakFieldsAtPath(value, []);
}

function assertNoSourceIndexOperationalLeakFieldsAtPath(value: unknown, path: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSourceIndexOperationalLeakFieldsAtPath(item, [...path, String(index)]));
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SOURCE_INDEX_OPERATIONAL_KEYS.has(key)) {
      const location = [...path, key].join('.');
      throw new OperationError(
        'email_policy_violation',
        `Private source worker response included forbidden operational field "${location}".`,
        'Return safe hashes, counts, provenance labels, and local index identifiers instead of raw paths, scopes, cursors, sessions, or credentials.',
      );
    }
    assertNoSourceIndexOperationalLeakFieldsAtPath(child, [...path, key]);
  }
}

function parseSourceAnswerOpsec(value: unknown): NonNullable<SourceIndexAnswerResult['opsec']> {
  const opsec = asRecord(value);
  if (opsec.raw_source_exposed !== false) {
    throw new OperationError('email_error', 'source answer OPSEC audit must be raw-source-safe.');
  }
  if (!Array.isArray(opsec.structured_evidence)) {
    throw new OperationError('email_error', 'source answer OPSEC audit must include structured evidence.');
  }
  const releaseDecision = asRecord(opsec.release_decision);
  if (typeof releaseDecision.decision !== 'string' || !Array.isArray(releaseDecision.reasons)) {
    throw new OperationError('email_error', 'source answer OPSEC audit must include a release decision.');
  }
  return {
    structured_evidence: opsec.structured_evidence,
    release_decision: releaseDecision,
    raw_source_exposed: false,
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

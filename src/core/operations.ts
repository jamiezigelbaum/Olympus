import { DelphiClient } from './delphi.ts';
import { runDoctor } from './doctor.ts';
import { EmailClient, type SourceAnswerSelectedItemOption, type SourceExportItemOption } from './email.ts';
import type { FileDeliveryClient } from './file-delivery.ts';
import type { CastorWorkspaceClient } from './castor-workspace.ts';
import type { DomainExpertClient, DomainExpertTool } from './domain-expert-client.ts';
import { defaultConfig, type OlympusConfig } from './config.ts';
import {
  ANNAS_ARCHIVE_FORMATS,
  DOMAIN_AGENT_ACTIONS,
  DOMAIN_DOC_ACTIONS,
  DOMAIN_SOURCE_ACTIONS,
  DOMAIN_SOURCE_KINDS,
  RAG_CORPUS_ACTIONS,
} from './domain-expert.ts';
import { resolveLane, resolveModelProfile } from './config.ts';
import { OperationError } from './operation-error.ts';
import { selectedItemContentFieldPath } from './source-index/selected-item-safety.ts';
import {
  createPublicSourceCorpusRegistry,
  createSourceCorpusRegistry,
  type SourceCorpusCapability,
} from './source-corpus-registry.ts';
import { normalizeVeniceAnalystModelId } from './venice-models.ts';
import { V0_4_PUBLIC_NATIVE_TOOLS } from './public-surface.ts';
import type { SourceWatchAuthenticatedRoute, SourceWatchMode } from './source-watch.ts';
import type { HireBrokerClient } from '../workers/hire-broker/client.ts';
import { PUBLIC_RUNTIME_BUILD } from './build-flavor.ts';

const SOURCE_INDEX_PROMOTION_CANDIDATE_CORPUS_IDS = ['secure_local.dropbox.files'] as const;
const SOURCE_INDEX_PROMOTION_CANONICAL_TYPES = ['project', 'project_work_item', 'area', 'person', 'organization', 'resource', 'topic', 'fact', 'secure_companion', 'resource_wiki_page'] as const;
const SOURCE_INDEX_PROMOTION_TARGET_SURFACES = ['review_queue', 'source_index', 'secure_companion', 'obsidian', 'resource_wiki'] as const;
const SOURCE_INDEX_PROMOTION_REASON_CODES = ['manual_review', 'high_signal', 'recurring_reference', 'project_material', 'decision_evidence', 'resource_candidate'] as const;
const SOURCE_INDEX_PROMOTION_DECISIONS = ['approved', 'rejected', 'deferred', 'needs_changes'] as const;
const SOURCE_INDEX_PROMOTION_PROPOSAL_STATUSES = ['proposed', ...SOURCE_INDEX_PROMOTION_DECISIONS] as const;

type SourceIndexAnswerCorpusId = string;
type SourceIndexStatusCorpusId = string;
type SourceIndexSyncCorpusId = string;
type SourceIndexSearchCorpusId = string;
type SourceIndexPromotionCandidateCorpusId = string;
type SourceIndexPromotionCanonicalType = typeof SOURCE_INDEX_PROMOTION_CANONICAL_TYPES[number];
type SourceIndexPromotionTargetSurface = typeof SOURCE_INDEX_PROMOTION_TARGET_SURFACES[number];
type SourceIndexPromotionReasonCode = typeof SOURCE_INDEX_PROMOTION_REASON_CODES[number];
type SourceIndexPromotionDecision = typeof SOURCE_INDEX_PROMOTION_DECISIONS[number];
type SourceIndexPromotionProposalStatus = typeof SOURCE_INDEX_PROMOTION_PROPOSAL_STATUSES[number];

export type ParamType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface ParamDef {
  type: ParamType;
  required?: boolean;
  description?: string;
  enum?: string[];
}

export interface OperationContext {
  config: OlympusConfig;
  delphi: DelphiClient;
  email: EmailClient;
  fileDelivery?: FileDeliveryClient;
  castorWorkspace?: CastorWorkspaceClient;
  domainExpert?: DomainExpertClient;
  /** Trusted OpenClaw tool-factory context; never sourced from tool params. */
  sourceWatchRoute?: SourceWatchAuthenticatedRoute;
  hireBroker?: HireBrokerClient;
  /** Trusted OpenClaw caller context; the model-supplied confirmation flag is insufficient alone. */
  hireBrokerAuthority?: { senderIsOwner: boolean };
}

export interface Operation {
  name: string;
  description: string;
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  mutating: boolean;
  availability?: (config: OlympusConfig) => boolean;
  nativeExposure?: 'always' | 'sourceIndexEnabledOnly' | 'sourceIndexAnswerDevOnly' | 'localEmailPacketsDevOnly' | 'emailIndexAdminDevOnly' | 'fileDeliveryEnabledOnly' | 'castorWorkspaceEnabledOnly' | 'hireBrokerEnabledOnly';
  /**
   * The operation needs the trusted owner + delivery route that only an
   * authenticated OpenClaw session mints, so the native tool factory is the
   * only surface it can succeed on.
   *
   * A second dimension rather than another `nativeExposure` value, because it
   * answers a different question: `nativeExposure` says whether this install
   * has the product turned on, this says which surface can supply the context.
   * Advertising these on MCP or the CLI published tools that could only ever
   * refuse, since neither surface has anywhere to get the route from.
   */
  requiresOpenClawSessionRoute?: true;
  cliHints: {
    name: string;
    positional?: string[];
    stdin?: string;
  };
}

export { OperationError };

export interface OperationSurfaceOptions {
  config?: OlympusConfig;
}

const ARGUS_PROFILE_ENUM = [
  'default_chat',
  'source_answer',
  'classification_fast',
  'embedding_secure_local',
  'vlm_document',
  'vlm_fast',
  'vlm_qwen36_27b',
  'vlm_qwen36_35b',
];

const SOURCE_INDEX_SEARCH_PARAMS = {
  query: { type: 'string', required: true, description: 'Keyword query for local safe source-index search.' },
  corpus_id: { type: 'string', required: true, description: 'Source-index corpus to search.' },
  retrieval_mode: { type: 'string', enum: ['keyword', 'hybrid'], description: 'Retrieval mode. Dropbox defaults to hybrid when embeddings exist; keyword is exact/FTS.' },
  account: { type: 'string', description: 'Optional source account. Dropbox: omit or use personal; never a credential handle (dropbox.personal) or invented alias.' },
  folder_id: { type: 'string', description: 'Optional X bookmark folder id filter.' },
  folder_name: { type: 'string', description: 'Optional X bookmark folder name filter.' },
  approved_scope_key: { type: 'string', description: 'Optional approved scope key (e.g. dropbox.personal:/2 Areas); not an account name.' },
  chat_scope: { type: 'string', description: 'Optional chat scope: account:chat:<id> or a conversation title (e.g. "ClawRyderz").' },
  trust_domain: { type: 'string', description: 'Optional trust-domain check; must equal the corpus trust domain.' },
  conversation_id: { type: 'string', description: 'Optional exact conversation id from a prior result; never inferred from text.' },
  sender_id: { type: 'string', description: 'Optional exact sender id. Mutually exclusive with sender_label.' },
  sender_label: { type: 'string', description: 'Optional case-insensitive sender label. Mutually exclusive with sender_id.' },
  authored_after: { type: 'string', description: 'Optional inclusive ISO lower bound on authored time.' },
  authored_before: { type: 'string', description: 'Optional inclusive ISO upper bound on authored time.' },
  participant_id: { type: 'string', description: 'Optional Telegram participant filter.' },
  after: { type: 'string', description: 'Alias of authored_after.' },
  before: { type: 'string', description: 'Alias of authored_before.' },
  include_deleted: { type: 'boolean', description: 'Whether Telegram search may include tombstoned messages.' },
  attachment_type: { type: 'string', enum: ['image', 'video', 'audio', 'file', 'link', 'other'], description: 'Optional Telegram attachment type filter.' },
  max_results: { type: 'number', description: 'Max hits; worker-capped.' },
  include_locators: { type: 'boolean', description: 'Dropbox files only: return path/Dropbox-link metadata (and Finder links when configured). Folder locators are not supported. Never source text or bytes.' },
} satisfies Record<string, ParamDef>;

const SOURCE_ANSWER_PARAMS = {
  question: { type: 'string', required: true, description: 'Question or search intent to route across approved source corpora.' },
  query: { type: 'string', description: 'Optional concise search query. Defaults to question.' },
  account: { type: 'string', description: 'Optional source account. Dropbox: omit or use personal; never a credential handle (dropbox.personal) or invented alias.' },
  corpus_id: { type: 'string', description: 'Optional single corpus to search. Defaults to all approved configured corpora.' },
  corpus_ids: { type: 'array', description: 'Optional set of corpora for one compound question, instead of all-corpus fanout or repeated calls.' },
  approved_scope_key: { type: 'string', description: 'Optional Dropbox scope filter (e.g. dropbox.personal:/2 Areas) to narrow secure-local searches; not an account name.' },
  chat_scope: { type: 'string', description: 'Optional Telegram chat scope; pass the group title (e.g. "ClawRyderz").' },
  conversation_id: { type: 'string', description: 'Optional exact conversation id from a prior result; never inferred from text.' },
  sender_id: { type: 'string', description: 'Optional exact sender id. Mutually exclusive with sender_label.' },
  sender_label: { type: 'string', description: 'Optional case-insensitive sender label. Mutually exclusive with sender_id.' },
  authored_after: { type: 'string', description: 'Optional inclusive ISO lower bound on authored time.' },
  authored_before: { type: 'string', description: 'Optional inclusive ISO upper bound on authored time.' },
  selected_items: { type: 'array', description: 'Optional selected evidence from a prior source_index_search; prefer hit.selected_item. Never source text.' },
  retrieval_mode: { type: 'string', enum: ['keyword', 'hybrid'], description: 'Optional retrieval override. Omit for the shared hybrid path; set keyword only for an explicit lexical-only request.' },
  analyst_provider: { type: 'string', enum: ['default', 'local', 'venice', 'cloud'], description: 'Optional analyst constraint. Leave default; set local or venice only when {{ownerName}} explicitly asks. Presets: local-first = local then Venice; private-cloud-only = Venice only.' },
  analyst_model: { type: 'string', description: 'Optional Venice model id for an explicit Venice request. e2ee-* ids are refused; defaults kimi-k3 (strong), inkling (normal).' },
  max_results: { type: 'number', description: 'Max results; worker-capped.' },
  include_secure_local: { type: 'boolean', description: 'Whether to search secure-local corpora. Defaults false unless the request targets secure-local material or scope.' },
  include_secure_local_content: { type: 'boolean', description: 'Whether secure-local answers may return OPSEC-scanned derivative content. Defaults true.' },
  include_internal: { type: 'boolean', description: 'Whether the bridge may search internal corpora. Defaults true.' },
  include_internal_content: { type: 'boolean', description: 'Whether internal corpora may return context passages for {{assistantName}} summarization. Defaults true.' },
  internal_content_max_bytes: { type: 'number', description: 'Max internal context bytes; worker-capped.' },
  timeoutMs: { type: 'number', description: 'OpenClaw dynamic-tool watchdog budget in ms; use 600000 over slow local corpora.' },
} satisfies Record<string, ParamDef>;

export const operations: Operation[] = [
  {
    name: 'argus_ping',
    description: 'Check whether the configured Argus local model profile is reachable.',
    params: {
      profile: { type: 'string', enum: ARGUS_PROFILE_ENUM, description: 'Argus model profile to check. Defaults to configured default profile.' },
      lane: { type: 'string', enum: ['fast', 'deep'], description: 'Legacy Argus lane alias. Omit for the one-endpoint model-pool path.' },
    },
    mutating: false,
    cliHints: { name: 'argus ping' },
    handler: async (ctx, params) => {
      if (params.lane !== undefined) {
        const lane = resolveLane(ctx.config, params.lane);
        return ctx.delphi.ping(lane);
      }
      const profile = resolveModelProfile(ctx.config, params.profile);
      return ctx.delphi.pingProfile(profile);
    },
  },
  {
    name: 'argus_list_models',
    description: 'List models served by an Argus profile, including each entry\'s live backing model (metadata.backendModel) — use this to name the actual model currently answering.',
    params: {
      profile: { type: 'string', enum: ARGUS_PROFILE_ENUM, description: 'Argus model profile to inspect. Defaults to configured default profile.' },
      lane: { type: 'string', enum: ['fast', 'deep'], description: 'Legacy Argus lane alias. Omit for the one-endpoint model-pool path.' },
    },
    mutating: false,
    cliHints: { name: 'argus list' },
    handler: async (ctx, params) => {
      if (params.lane !== undefined) {
        const lane = resolveLane(ctx.config, params.lane);
        const models = await ctx.delphi.listModels(lane);
        return { lane, models };
      }
      const profile = resolveModelProfile(ctx.config, params.profile);
      const models = await ctx.delphi.listModelsForProfile(profile);
      const backing = models
        .map((model) => model.metadata?.backendModel)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
      return { profile, models, ...(backing.length > 0 ? { backing_models: backing } : {}) };
    },
  },
  {
    name: 'argus_complete',
    description: 'Send a prompt to a configured local model lane and return the completion.',
    params: {
      prompt: { type: 'string', required: true, description: 'User prompt to send to Argus.' },
      profile: { type: 'string', enum: ARGUS_PROFILE_ENUM, description: 'Argus model profile. Defaults to default_chat; Olympus source answers use source_answer.' },
      lane: { type: 'string', enum: ['fast', 'deep'], description: 'Legacy Argus lane alias. Omit for the one-endpoint model-pool path.' },
      model: { type: 'string', description: 'Optional served-model override.' },
      system: { type: 'string', description: 'Optional system prompt.' },
      temperature: { type: 'number', description: 'Sampling temperature. Defaults to 0.2.' },
      max_tokens: { type: 'number', description: 'Maximum output tokens. Defaults to 2048.' },
    },
    mutating: false,
    cliHints: { name: 'argus complete', positional: ['prompt'], stdin: 'prompt' },
    handler: async (ctx, params) => {
      const prompt = asString(params.prompt, 'prompt');
      const lane = params.lane !== undefined ? resolveLane(ctx.config, params.lane) : undefined;
      const profile = lane === undefined ? resolveModelProfile(ctx.config, params.profile) : undefined;
      const model = optionalString(params.model);
      const system = optionalString(params.system);
      const temperature = optionalNumber(params.temperature, 'temperature');
      const maxTokens = optionalNumber(params.max_tokens, 'max_tokens');
      const completeOptions = {
        prompt,
        ...(lane !== undefined ? { lane } : {}),
        ...(profile !== undefined ? { profile } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(system !== undefined ? { system } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      };
      return ctx.delphi.complete(completeOptions);
    },
  },
  {
    name: 'email_ping',
    description: 'Check whether the private email source worker is configured and reachable.',
    params: {},
    mutating: false,
    cliHints: { name: 'email ping' },
    handler: async (ctx) => ctx.email.ping(),
  },
  {
    name: 'email_answer',
    description: 'Ask the configured local/private model lane a bounded question about email without returning raw messages.',
    params: {
      question: { type: 'string', required: true, description: 'Bounded question to answer over email inside the private lane.' },
      account: { type: 'string', description: 'Optional Google account or mailbox label to scope the request.' },
      after: { type: 'string', description: 'Optional lower date/time bound.' },
      before: { type: 'string', description: 'Optional upper date/time bound.' },
      from: { type: 'string', description: 'Optional sender constraint.' },
      to: { type: 'string', description: 'Optional recipient constraint.' },
      max_messages: { type: 'number', description: 'Optional maximum messages the private lane may inspect.' },
    },
    mutating: false,
    cliHints: { name: 'email answer', positional: ['question'], stdin: 'question' },
    handler: async (ctx, params) => {
      const question = asString(params.question, 'question');
      const account = optionalString(params.account);
      const after = optionalString(params.after);
      const before = optionalString(params.before);
      const from = optionalString(params.from);
      const to = optionalString(params.to);
      const maxMessages = optionalNumber(params.max_messages, 'max_messages');
      return ctx.email.answer({
        question,
        ...(account !== undefined ? { account } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(maxMessages !== undefined ? { maxMessages } : {}),
      });
    },
  },
  {
    name: 'source_answer',
    description: [
      'Ask the routed source index for a bounded calling-assistant-safe answer with provenance.',
      'This bridge may search approved source lanes and can return relevant OPSEC-scanned internal passages, limited only by the per-call context budget.',
      'It never returns source packets, vectors, OAuth material, or raw secure-local file content; secure-local answers release only as OPSEC-scanned bounded derivatives.',
      'For Dropbox documents with incomplete local extraction, audit.self_heal reports whether Olympus forced a local re-ingest inline or left one queued for retry.',
      'The returned answer field is already the calling-assistant-safe answer; when it answers the user, pass it through with citations/coverage notes instead of re-reasoning over the audit.',
    ].join(' '),
    params: SOURCE_ANSWER_PARAMS,
    mutating: false,
    nativeExposure: 'sourceIndexEnabledOnly',
    cliHints: { name: 'source answer', positional: ['question'], stdin: 'question' },
    handler: async (ctx, params) => {
      assertNoUndeclaredParams(SOURCE_ANSWER_PARAMS, params, 'Source answer');
      const question = asString(params.question, 'question');
      const query = optionalString(params.query);
      const corpusId = optionalSourceIndexAnswerCorpusId(params.corpus_id, ctx.config);
      const corpusIds = params.corpus_ids !== undefined ? sourceAnswerCorpusIds(params.corpus_ids, ctx.config) : undefined;
      const account = optionalSourceAccount(params.account, corpusId);
      const approvedScopeKey = optionalString(params.approved_scope_key);
      const chatScope = optionalString(params.chat_scope);
      const conversationId = optionalString(params.conversation_id);
      const senderId = optionalString(params.sender_id);
      const senderLabel = optionalString(params.sender_label);
      const authoredAfter = optionalString(params.authored_after);
      const authoredBefore = optionalString(params.authored_before);
      const selectedItems = optionalSourceAnswerSelectedItems(params.selected_items, corpusId);
      const retrievalMode = optionalRetrievalMode(params.retrieval_mode);
      const analystProvider = optionalSourceAnswerAnalystProvider(params.analyst_provider);
      const analystModel = optionalAnalystModel(params.analyst_model, 'analyst_model', analystProvider);
      const maxResults = optionalNumber(params.max_results, 'max_results');
      const includeSecureLocal = optionalBoolean(params.include_secure_local, 'include_secure_local');
      const includeSecureLocalContent = optionalBoolean(params.include_secure_local_content, 'include_secure_local_content');
      const includeInternal = optionalBoolean(params.include_internal, 'include_internal');
      const includeInternalContent = optionalBoolean(params.include_internal_content, 'include_internal_content');
      const internalContentMaxBytes = optionalNumber(params.internal_content_max_bytes, 'internal_content_max_bytes');
      const timeoutMs = optionalNumber(params.timeoutMs, 'timeoutMs');
      return ctx.email.sourceAnswer({
        question,
        ...(query !== undefined ? { query } : {}),
        ...(account !== undefined ? { account } : {}),
        ...(corpusId !== undefined ? { corpusId } : {}),
        ...(corpusIds !== undefined ? { corpusIds } : {}),
        ...(approvedScopeKey !== undefined ? { approvedScopeKey } : {}),
        ...(chatScope !== undefined ? { chatScope } : {}),
        ...(conversationId !== undefined ? { conversationId } : {}),
        ...(senderId !== undefined ? { senderId } : {}),
        ...(senderLabel !== undefined ? { senderLabel } : {}),
        ...(authoredAfter !== undefined ? { authoredAfter } : {}),
        ...(authoredBefore !== undefined ? { authoredBefore } : {}),
        ...(selectedItems !== undefined ? { selectedItems } : {}),
        ...(retrievalMode !== undefined ? { retrievalMode } : {}),
        ...(analystProvider !== undefined ? { analystProvider } : {}),
        ...(analystModel !== undefined ? { analystModel } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
        ...(includeSecureLocal !== undefined ? { includeSecureLocal } : {}),
        ...(includeSecureLocalContent !== undefined ? { includeSecureLocalContent } : {}),
        ...(includeInternal !== undefined ? { includeInternal } : {}),
        ...(includeInternalContent !== undefined ? { includeInternalContent } : {}),
        ...(internalContentMaxBytes !== undefined ? { internalContentMaxBytes } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    },
  },
  {
    name: 'source_index_status',
    description: [
      'Inspect source-index corpus status, refresh metadata, and aggregate counts.',
      'This is read-only observability, not a source read path: it never returns secure-local item metadata, source text, source packets, vectors, or OAuth material.',
      'Legacy item/extraction filter fields are refused on the connector-store status surface rather than silently returning whole-corpus counts; use source_index_search for filtered retrieval.',
    ].join(' '),
    params: {
      account: { type: 'string', description: 'Optional source account identity. For Dropbox, omit for broad status or use personal; do not pass credential handles such as dropbox.personal or invented aliases such as dropbox.primary.' },
      corpus_id: { type: 'string', description: 'Optional corpus to inspect. Defaults to all configured source-index corpora.' },
      approved_scope_key: { type: 'string', description: 'Optional Dropbox approved scope filter, for example dropbox.personal:/2 Areas. This is not an account name. Output returns only a scope hash.' },
      chat_scope: { type: 'string', description: 'Optional Telegram approved chat scope filter. For named Telegram groups, pass the group title/name such as "ClawRyderz"; output returns only a scope hash for structured scopes.' },
      conversation_id: { type: 'string', description: 'Exact provider conversation id. Required with include_sender_aggregation.' },
      include_sender_aggregation: { type: 'boolean', description: 'Return read-only top-sender counts for one non-secure-local chat. Requires corpus_id, account, and conversation_id.' },
      max_senders: { type: 'number', description: 'Maximum ranked senders to return when aggregation is requested. Defaults 10; maximum 100.' },
      extractor_kind: { type: 'string', description: 'Optional Dropbox extraction lane filter, for example local_ocr_tesseract or venice_grok43_document.' },
      extractor_version: { type: 'string', description: 'Optional Dropbox extraction version filter for lane-specific status.' },
      qa_verdicts: { type: 'string', description: 'Optional comma-separated Dropbox QA verdict filters, for example qa_metadata_only_gap.' },
      mime_types: { type: 'string', description: 'Optional comma-separated MIME type filters for Dropbox lane-specific status.' },
      required_artifact_kind: { type: 'string', description: 'Optional artifact kind required for Dropbox lane-specific status.' },
      required_artifact_warning: { type: 'string', description: 'Optional artifact warning required for Dropbox lane-specific status, for example ocr_required.' },
      source_extractor_kinds: { type: 'string', description: 'Optional comma-separated source extractor kinds for Dropbox retry/escalation lane status.' },
      source_job_statuses: { type: 'string', description: 'Optional comma-separated source job statuses for Dropbox retry/escalation lane status.' },
      include_readiness_ledger: { type: 'boolean', description: 'Whether to compute the expensive Dropbox readiness ledger and QA gap breakdown. Defaults false for cheap status polling.' },
      include_ingestion_ledger: { type: 'boolean', description: 'Whether to include the normalized cross-source ingestion ledger: items, content-indexed, metadata-only, failures, stuck/paused state, and freshness by source.' },
      include_items: { type: 'boolean', description: 'Whether to include safe item metadata for listable corpora. Defaults true.' },
      max_items: { type: 'number', description: 'Maximum safe item metadata rows to return. Capped by the private source worker.' },
      query: { type: 'string', description: 'Optional title filter for listable corpus item metadata.' },
    },
    mutating: false,
    nativeExposure: 'sourceIndexEnabledOnly',
    cliHints: { name: 'source index status' },
    handler: async (ctx, params) => {
      const corpusId = optionalSourceIndexStatusCorpusId(params.corpus_id, ctx.config);
      const account = optionalSourceAccount(params.account, corpusId);
      const approvedScopeKey = optionalString(params.approved_scope_key);
      const chatScope = optionalString(params.chat_scope);
      const conversationId = optionalString(params.conversation_id);
      const includeSenderAggregation = optionalBoolean(params.include_sender_aggregation, 'include_sender_aggregation');
      const maxSenders = optionalNumber(params.max_senders, 'max_senders');
      const extractorKind = optionalString(params.extractor_kind);
      const extractorVersion = optionalString(params.extractor_version);
      const qaVerdicts = params.qa_verdicts !== undefined ? asStringList(params.qa_verdicts, 'qa_verdicts') : undefined;
      const mimeTypes = params.mime_types !== undefined ? asStringList(params.mime_types, 'mime_types') : undefined;
      const requiredArtifactKind = optionalString(params.required_artifact_kind);
      const requiredArtifactWarning = optionalString(params.required_artifact_warning);
      const sourceExtractorKinds = params.source_extractor_kinds !== undefined
        ? asStringList(params.source_extractor_kinds, 'source_extractor_kinds')
        : undefined;
      const sourceJobStatuses = params.source_job_statuses !== undefined
        ? asStringList(params.source_job_statuses, 'source_job_statuses')
        : undefined;
      const includeReadinessLedger = optionalBoolean(params.include_readiness_ledger, 'include_readiness_ledger');
      const includeIngestionLedger = optionalBoolean(params.include_ingestion_ledger, 'include_ingestion_ledger');
      const includeItems = optionalBoolean(params.include_items, 'include_items');
      const maxItems = optionalNumber(params.max_items, 'max_items');
      const query = optionalString(params.query);
      return ctx.email.sourceIndexStatus({
        ...(account !== undefined ? { account } : {}),
        ...(corpusId !== undefined ? { corpusId } : {}),
        ...(approvedScopeKey !== undefined ? { approvedScopeKey } : {}),
        ...(chatScope !== undefined ? { chatScope } : {}),
        ...(conversationId !== undefined ? { conversationId } : {}),
        ...(includeSenderAggregation !== undefined ? { includeSenderAggregation } : {}),
        ...(maxSenders !== undefined ? { maxSenders } : {}),
        ...(extractorKind !== undefined ? { extractorKind } : {}),
        ...(extractorVersion !== undefined ? { extractorVersion } : {}),
        ...(qaVerdicts !== undefined ? { qaVerdicts } : {}),
        ...(mimeTypes !== undefined ? { mimeTypes } : {}),
        ...(requiredArtifactKind !== undefined ? { requiredArtifactKind } : {}),
        ...(requiredArtifactWarning !== undefined ? { requiredArtifactWarning } : {}),
        ...(sourceExtractorKinds !== undefined ? { sourceExtractorKinds } : {}),
        ...(sourceJobStatuses !== undefined ? { sourceJobStatuses } : {}),
        ...(includeReadinessLedger !== undefined ? { includeReadinessLedger } : {}),
        ...(includeIngestionLedger !== undefined ? { includeIngestionLedger } : {}),
        ...(includeItems !== undefined ? { includeItems } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
        ...(query !== undefined ? { query } : {}),
      });
    },
  },
  ...(PUBLIC_RUNTIME_BUILD ? [] : [{
    name: 'source_index_sync',
    description: [
      'Run a deliberate bounded source-index sync through the private source worker.',
      'Dropbox sync requires an approved folder/root scope; Telegram sync requires an approved chat scope.',
      'X bookmarks supports a lightweight head check, complete reconciliation, a bounded content-free window diagnostic, folder-facet representation refresh, or read-only preservation re-attestation through mode.',
      'This does not browse raw files or perform provider writes.',
    ].join(' '),
    params: {
      corpus_id: { type: 'string', required: true, description: 'Source-index corpus to sync.' },
      mode: { type: 'string', enum: ['head', 'reconcile', 'window_diagnostic', 'folder_facet_refresh', 'preservation-reattest'], description: 'X bookmarks only: run the bounded incremental head check, complete daily reconciliation, the four-probe content-free window diagnostic, folder-facet representation refresh, or post-reconcile read-only preservation re-attestation.' },
      account: { type: 'string', description: 'Optional source account identity. For Dropbox, omit unless deliberately narrowing to personal; do not pass credential handles such as dropbox.personal or aliases such as dropbox.primary.' },
      approved_scope_key: { type: 'string', description: 'Dropbox approved folder/root scope key, for example dropbox.personal:/Approved.' },
      folder_path: { type: 'string', description: 'Approved Dropbox folder path for metadata sync.' },
      folder_id: { type: 'string', description: 'Approved Dropbox folder id for metadata sync.' },
      recursive: { type: 'boolean', description: 'Whether Dropbox metadata sync should recurse. Defaults true in the private worker.' },
      max_entries: { type: 'number', description: 'Maximum Dropbox metadata entries to observe; capped by the private worker.' },
      max_pages: { type: 'number', description: 'Maximum Dropbox metadata pages to read; capped by the private worker.' },
      chat_scope: { type: 'string', description: 'Telegram approved chat scope for bounded read sync.' },
      trust_domain: { type: 'string', enum: ['internal', 'secure_local'], description: 'Optional Telegram chat classification for the sync batch. Ordinary approved chats default internal; protected chats must use secure_local.' },
      max_messages: { type: 'number', description: 'Maximum Telegram messages to read; capped by the private worker.' },
      provider_cursor: { type: 'string', description: 'Opaque provider cursor for continuation. The worker stores/returns only safe cursor hashes.' },
      sync_direction: { type: 'string', enum: ['forward', 'backfill'], description: 'Telegram sync direction. Defaults to forward freshness; use backfill only for explicit historical drain work.' },
      coverage_start: { type: 'string', description: 'Optional Telegram coverage start timestamp for currentness tracking.' },
      coverage_end: { type: 'string', description: 'Optional Telegram coverage end timestamp for currentness tracking.' },
    },
    mutating: true,
    nativeExposure: 'emailIndexAdminDevOnly',
    cliHints: { name: 'source index sync' },
    handler: async (ctx, params) => {
      const corpusId = asSourceIndexSyncCorpusId(params.corpus_id, ctx.config);
      const mode = optionalXBookmarksSyncMode(params.mode, corpusId);
      const account = optionalSourceAccount(params.account, corpusId);
      const approvedScopeKey = optionalString(params.approved_scope_key);
      const folderPath = optionalString(params.folder_path);
      const folderId = optionalString(params.folder_id);
      const recursive = optionalBoolean(params.recursive, 'recursive');
      const maxEntries = optionalNumber(params.max_entries, 'max_entries');
      const maxPages = optionalNumber(params.max_pages, 'max_pages');
      const chatScope = optionalString(params.chat_scope);
      const trustDomain = optionalTelegramTrustDomain(params.trust_domain);
      const maxMessages = optionalNumber(params.max_messages, 'max_messages');
      const providerCursor = optionalString(params.provider_cursor);
      const syncDirection = optionalTelegramSyncDirection(params.sync_direction);
      const coverageStart = optionalString(params.coverage_start);
      const coverageEnd = optionalString(params.coverage_end);
      return ctx.email.sourceIndexSync({
        corpusId,
        ...(mode !== undefined ? { mode } : {}),
        ...(account !== undefined ? { account } : {}),
        ...(approvedScopeKey !== undefined ? { approvedScopeKey } : {}),
        ...(folderPath !== undefined ? { folderPath } : {}),
        ...(folderId !== undefined ? { folderId } : {}),
        ...(recursive !== undefined ? { recursive } : {}),
        ...(maxEntries !== undefined ? { maxEntries } : {}),
        ...(maxPages !== undefined ? { maxPages } : {}),
        ...(chatScope !== undefined ? { chatScope } : {}),
        ...(trustDomain !== undefined ? { trustDomain } : {}),
        ...(maxMessages !== undefined ? { maxMessages } : {}),
        ...(providerCursor !== undefined ? { providerCursor } : {}),
        ...(syncDirection !== undefined ? { syncDirection } : {}),
        ...(coverageStart !== undefined ? { coverageStart } : {}),
        ...(coverageEnd !== undefined ? { coverageEnd } : {}),
      });
    },
  }] satisfies Operation[]),
  {
    name: 'source_index_search',
    description: [
      'Search a calling-assistant-safe source-index surface without returning source packets, scopes, tokens, provider cursors, or secure-local raw content.',
      'X bookmarks are internal/S1; connector-store search does not currently return direct X URLs. Dropbox stays secure-local except for its declared locator release, and protected Telegram stays secure-local.',
      'Each hit includes selected_item when it can be safely passed back to source_answer.selected_items for item-pinned evidence hydration.',
      'Dropbox file locators are opt-in only: set include_locators=true when the user explicitly asks for file paths, Finder links, or Dropbox links. Folder locators are not supported.',
    ].join(' '),
    params: SOURCE_INDEX_SEARCH_PARAMS,
    mutating: false,
    nativeExposure: 'sourceIndexEnabledOnly',
    cliHints: { name: 'source index search', positional: ['query'], stdin: 'query' },
    handler: async (ctx, params) => {
      assertNoUndeclaredSourceIndexSearchParams(params);
      const query = asString(params.query, 'query');
      const corpusId = asSourceIndexSearchCorpusId(params.corpus_id, ctx.config);
      const retrievalMode = optionalRetrievalMode(params.retrieval_mode);
      const account = optionalSourceAccount(
        optionalNarrowingString(params.account, 'account'),
        corpusId,
      );
      const folderId = optionalNarrowingString(params.folder_id, 'folder_id');
      const folderName = optionalNarrowingString(params.folder_name, 'folder_name');
      const approvedScopeKey = optionalExactNarrowingString(
        params.approved_scope_key,
        'approved_scope_key',
      );
      const chatScope = optionalNarrowingString(params.chat_scope, 'chat_scope');
      const trustDomain = optionalTrustDomainConsistency(
        params.trust_domain,
        corpusId,
        ctx.config,
      );
      const conversationId = optionalNarrowingString(params.conversation_id, 'conversation_id');
      const senderId = optionalNarrowingString(params.sender_id, 'sender_id');
      const senderLabel = optionalNarrowingString(params.sender_label, 'sender_label');
      const authoredAfter = optionalNarrowingString(params.authored_after, 'authored_after');
      const authoredBefore = optionalNarrowingString(params.authored_before, 'authored_before');
      const participantId = optionalNarrowingString(params.participant_id, 'participant_id');
      const after = optionalNarrowingString(params.after, 'after');
      const before = optionalNarrowingString(params.before, 'before');
      const includeDeleted = optionalBoolean(params.include_deleted, 'include_deleted');
      const attachmentType = optionalAttachmentType(params.attachment_type);
      const maxResults = optionalNumber(params.max_results, 'max_results');
      const includeLocators = optionalBoolean(params.include_locators, 'include_locators');
      return ctx.email.sourceIndexSearch({
        query,
        corpusId,
        ...(retrievalMode !== undefined ? { retrievalMode } : {}),
        ...(account !== undefined ? { account } : {}),
        ...(folderId !== undefined ? { folderId } : {}),
        ...(folderName !== undefined ? { folderName } : {}),
        ...(approvedScopeKey !== undefined ? { approvedScopeKey } : {}),
        ...(chatScope !== undefined ? { chatScope } : {}),
        ...(trustDomain !== undefined ? { trustDomain } : {}),
        ...(conversationId !== undefined ? { conversationId } : {}),
        ...(senderId !== undefined ? { senderId } : {}),
        ...(senderLabel !== undefined ? { senderLabel } : {}),
        ...(authoredAfter !== undefined ? { authoredAfter } : {}),
        ...(authoredBefore !== undefined ? { authoredBefore } : {}),
        ...(participantId !== undefined ? { participantId } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(includeDeleted !== undefined ? { includeDeleted } : {}),
        ...(attachmentType !== undefined ? { attachmentType } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
        ...(includeLocators !== undefined ? { includeLocators } : {}),
      });
    },
  },
  ...(PUBLIC_RUNTIME_BUILD ? [] : [{
    name: 'source_export',
    description: [
      'Materialize already-cited Dropbox source items into a user-owned Dropbox destination folder via a verified server-side provider copy.',
      'Pass locators (paths) exactly as returned in source citations plus a destination root; the private worker verifies each path against the local Dropbox index and copies inside the user\'s own Dropbox, so file bytes never leave Dropbox and content never enters any model context.',
      'Destinations are restricted to the approved export allowlist, S5-classified items are always skipped, existing destination files are skipped rather than overwritten, and the result returns path-level statuses and counts only.',
    ].join(' '),
    params: {
      destination_root: { type: 'string', required: true, description: 'Destination Dropbox folder path, for example /Olympus Exports/Otter Transcripts. Must fall under an allowed export root.' },
      items: { type: 'string', required: true, description: 'JSON array of export items. Each item is a source Dropbox path string or an object like {"path":"/2 Areas/Otter/Standup.txt","dest_subfolder":"Standups"}. Paths must be locators already returned by source citations.' },
      account: { type: 'string', description: 'Optional source account identity. Omit or use personal; do not pass credential handles such as dropbox.personal.' },
      dry_run: { type: 'boolean', description: 'Validate the destination and per-item statuses without performing any copy.' },
    },
    mutating: true,
    nativeExposure: 'sourceIndexAnswerDevOnly',
    cliHints: { name: 'source export', positional: ['destination_root'] },
    handler: async (ctx, params) => {
      const destinationRoot = asString(params.destination_root, 'destination_root');
      const items = asSourceExportItems(params.items);
      const account = optionalSourceAccount(params.account, 'secure_local.dropbox.files');
      const dryRun = optionalBoolean(params.dry_run, 'dry_run');
      return ctx.email.sourceExport({
        destinationRoot,
        items,
        ...(account !== undefined ? { account } : {}),
        ...(dryRun !== undefined ? { dryRun } : {}),
      });
    },
  },
  {
    name: 'source_transcribe',
    description: [
      'Queue indexed Dropbox audio files (voice memos, brainstorms, meeting recordings) for LOCAL transcription so their transcripts become searchable through the normal source pipeline.',
      'Pass items with explicit Dropbox path locators to transcribe exactly those files, or omit items to let the planner queue untranscribed audio under the approved scope; mode=status returns calling-assistant-safe job counts without queueing anything.',
      'Transcription runs on local infrastructure only via a separate drain worker — no audio bytes or transcript text are returned here, and curated exclude fences always apply. The result carries counts and path-level statuses only.',
    ].join(' '),
    params: {
      approved_scope_key: { type: 'string', required: true, description: 'Dropbox approved folder/root scope key, for example dropbox.personal:/2 Areas. The worker stores and returns only a scope hash.' },
      items: { type: 'string', description: 'Optional JSON array or comma-separated list of Dropbox audio file paths (locators as returned by source search/citations). When given, exactly those paths are queued.' },
      include_path_prefixes: { type: 'string', description: 'Optional comma-separated path prefixes to narrow the planner to one subtree, for example /2 Areas/Brainstorms.' },
      limit: { type: 'number', description: 'Maximum audio files the planner may queue in this call. Capped by the private source worker.' },
      mode: { type: 'string', enum: ['enqueue', 'status'], description: 'enqueue (default) queues transcription jobs; status returns calling-assistant-safe transcription job counts without mutating anything.' },
      account: { type: 'string', description: 'Optional source account identity. Omit or use personal; do not pass credential handles such as dropbox.personal.' },
    },
    mutating: true,
    nativeExposure: 'sourceIndexAnswerDevOnly',
    cliHints: { name: 'source transcribe' },
    handler: async (ctx, params) => {
      const approvedScopeKey = asString(params.approved_scope_key, 'approved_scope_key');
      const mode = optionalSourceTranscribeMode(params.mode);
      const items = params.items !== undefined ? asSourceTranscribeItems(params.items) : undefined;
      const includePathPrefixes = params.include_path_prefixes !== undefined
        ? asStringList(params.include_path_prefixes, 'include_path_prefixes')
        : undefined;
      const limit = optionalNumber(params.limit, 'limit');
      const account = optionalSourceAccount(params.account, 'secure_local.dropbox.files');
      return ctx.email.sourceTranscribe({
        approvedScopeKey,
        ...(mode !== undefined ? { mode } : {}),
        ...(items !== undefined ? { items } : {}),
        ...(includePathPrefixes !== undefined ? { includePathPrefixes } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(account !== undefined ? { account } : {}),
      });
    },
  },
  {
    name: 'source_media_ingest',
    description: [
      'Queue explicitly requested Dropbox photos or image folders for local VLM extraction.',
      'This is the deliberate on-demand media lane: ordinary broad Dropbox photos/videos stay metadata-only by default, while passed items or include_path_prefixes queue image-like files for local processing.',
      'No file bytes or extracted text are returned here; the result returns calling-assistant-safe counts plus path-level statuses for explicit items.',
    ].join(' '),
    params: {
      approved_scope_key: { type: 'string', required: true, description: 'Dropbox approved folder/root scope key, for example dropbox.personal:/2 Areas. The worker stores and returns only a scope hash.' },
      items: { type: 'string', description: 'Optional JSON array or comma-separated list of Dropbox image file paths. When given, exactly those paths are queued.' },
      include_path_prefixes: { type: 'string', description: 'Optional comma-separated Dropbox folder/path prefixes; image-like files under those prefixes are queued.' },
      limit: { type: 'number', description: 'Maximum image files the planner may queue in this call. Capped by the private source worker.' },
      max_bytes_per_file: { type: 'number', description: 'Optional per-file byte cap for local VLM extraction.' },
      account: { type: 'string', description: 'Optional source account identity. Omit or use personal; do not pass credential handles such as dropbox.personal.' },
    },
    mutating: true,
    nativeExposure: 'sourceIndexAnswerDevOnly',
    cliHints: { name: 'source media ingest' },
    handler: async (ctx, params) => {
      const approvedScopeKey = asString(params.approved_scope_key, 'approved_scope_key');
      const items = params.items !== undefined ? asSourceMediaIngestItems(params.items) : undefined;
      const includePathPrefixes = params.include_path_prefixes !== undefined
        ? asStringList(params.include_path_prefixes, 'include_path_prefixes')
        : undefined;
      if ((items?.length ?? 0) === 0 && (includePathPrefixes?.length ?? 0) === 0) {
        throw new OperationError('invalid_params', 'source_media_ingest requires items or include_path_prefixes.');
      }
      const limit = optionalNumber(params.limit, 'limit');
      const maxBytesPerFile = optionalNumber(params.max_bytes_per_file, 'max_bytes_per_file');
      const account = optionalSourceAccount(params.account, 'secure_local.dropbox.files');
      return ctx.email.sourceMediaIngest({
        approvedScopeKey,
        ...(items !== undefined ? { items } : {}),
        ...(includePathPrefixes !== undefined ? { includePathPrefixes } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(maxBytesPerFile !== undefined ? { maxBytesPerFile } : {}),
        ...(account !== undefined ? { account } : {}),
      });
    },
  },
  {
    name: 'source_index_promotion_candidates',
    description: [
      'List safe Dropbox evidence candidates for promotion/review without writing to Obsidian or Resource Wiki.',
      'This returns hashed provenance and review metadata only: no file paths, raw text, source packets, scope keys, vectors, or credentials.',
    ].join(' '),
    params: {
      corpus_id: { type: 'string', enum: [...SOURCE_INDEX_PROMOTION_CANDIDATE_CORPUS_IDS], description: 'Promotion-candidate corpus. Currently only secure_local.dropbox.files.' },
      account: { type: 'string', description: 'Optional account scope.' },
      approved_scope_key: { type: 'string', required: true, description: 'Dropbox approved folder/root scope key. The worker returns only a scope hash.' },
      max_results: { type: 'number', description: 'Maximum safe candidate rows to return. Capped by the private source worker.' },
    },
    mutating: false,
    nativeExposure: 'sourceIndexAnswerDevOnly',
    cliHints: { name: 'source index promotion candidates' },
    handler: async (ctx, params) => {
      const corpusId = optionalSourceIndexPromotionCandidateCorpusId(params.corpus_id, ctx.config);
      const account = optionalSourceAccount(params.account, corpusId);
      const approvedScopeKey = asString(params.approved_scope_key, 'approved_scope_key');
      const maxResults = optionalNumber(params.max_results, 'max_results');
      return ctx.email.sourceIndexPromotionCandidates({
        ...(corpusId !== undefined ? { corpusId } : {}),
        ...(account !== undefined ? { account } : {}),
        approvedScopeKey,
        ...(maxResults !== undefined ? { maxResults } : {}),
      });
    },
  },
  {
    name: 'source_index_promotion_propose',
    description: [
      'Create a local Dropbox promotion proposal from safe candidate handles without exposing source text or writing Resource Wiki/Obsidian.',
      'This records append-only review intent over hashed evidence provenance only.',
    ].join(' '),
    params: {
      account: { type: 'string', description: 'Optional account scope.' },
      approved_scope_key: { type: 'string', required: true, description: 'Dropbox approved folder/root scope key. The worker stores and returns only a scope hash.' },
      classification_ids: { type: 'string', required: true, description: 'Comma-separated or JSON-array candidate classification handles returned by source_index_promotion_candidates.' },
      canonical_type: { type: 'string', required: true, enum: [...SOURCE_INDEX_PROMOTION_CANONICAL_TYPES], description: 'Typed destination shape for the proposed durable knowledge.' },
      target_surface: { type: 'string', required: true, enum: [...SOURCE_INDEX_PROMOTION_TARGET_SURFACES], description: 'Intended review/write surface. This operation records intent only and performs no surface write.' },
      reason_code: { type: 'string', required: true, enum: [...SOURCE_INDEX_PROMOTION_REASON_CODES], description: 'Typed reason this evidence is being proposed.' },
      proposed_by: { type: 'string', description: 'Optional reviewer/agent label, stored only as a hash.' },
    },
    mutating: true,
    nativeExposure: 'sourceIndexAnswerDevOnly',
    cliHints: { name: 'source index promotion propose' },
    handler: async (ctx, params) => {
      const account = optionalSourceAccount(params.account, 'secure_local.dropbox.files');
      const approvedScopeKey = asString(params.approved_scope_key, 'approved_scope_key');
      const classificationIds = asStringList(params.classification_ids, 'classification_ids');
      const canonicalType = asPromotionCanonicalType(params.canonical_type);
      const targetSurface = asPromotionTargetSurface(params.target_surface);
      const reasonCode = asPromotionReasonCode(params.reason_code);
      const proposedBy = optionalString(params.proposed_by);
      return ctx.email.sourceIndexPromotionProposal({
        ...(account !== undefined ? { account } : {}),
        approvedScopeKey,
        classificationIds,
        canonicalType,
        targetSurface,
        reasonCode,
        ...(proposedBy !== undefined ? { proposedBy } : {}),
      });
    },
  },
  {
    name: 'source_index_promotion_proposals',
    description: [
      'List local Dropbox promotion proposals for review without exposing source text or writing Resource Wiki/Obsidian.',
      'This returns proposal metadata and hashed scope only.',
    ].join(' '),
    params: {
      account: { type: 'string', description: 'Optional account scope.' },
      approved_scope_key: { type: 'string', description: 'Optional Dropbox approved folder/root scope key. The worker returns only a scope hash.' },
      status: { type: 'string', enum: [...SOURCE_INDEX_PROMOTION_PROPOSAL_STATUSES], description: 'Optional proposal status filter.' },
      max_results: { type: 'number', description: 'Maximum safe proposal rows to return. Capped by the private source worker.' },
    },
    mutating: false,
    nativeExposure: 'sourceIndexAnswerDevOnly',
    cliHints: { name: 'source index promotion proposals' },
    handler: async (ctx, params) => {
      const account = optionalSourceAccount(params.account, 'secure_local.dropbox.files');
      const approvedScopeKey = optionalString(params.approved_scope_key);
      const status = optionalPromotionProposalStatus(params.status);
      const maxResults = optionalNumber(params.max_results, 'max_results');
      return ctx.email.sourceIndexPromotionProposals({
        ...(account !== undefined ? { account } : {}),
        ...(approvedScopeKey !== undefined ? { approvedScopeKey } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
      });
    },
  },
  {
    name: 'source_index_promotion_proposal',
    description: [
      'Read one local Dropbox promotion proposal detail without exposing source text or writing Resource Wiki/Obsidian.',
      'This returns hashed evidence metadata and local review decisions only.',
    ].join(' '),
    params: {
      proposal_id: { type: 'string', required: true, description: 'Promotion proposal id returned by source_index_promotion_propose or source_index_promotion_proposals.' },
    },
    mutating: false,
    nativeExposure: 'sourceIndexAnswerDevOnly',
    cliHints: { name: 'source index promotion proposal' },
    handler: async (ctx, params) => {
      const proposalId = asString(params.proposal_id, 'proposal_id');
      return ctx.email.sourceIndexPromotionProposalDetail({
        proposalId,
      });
    },
  },
  {
    name: 'source_index_promotion_decide',
    description: [
      'Record a local review decision on a Dropbox promotion proposal without executing any Resource Wiki, Obsidian, or Dropbox write.',
      'This is a review-ledger mutation only.',
    ].join(' '),
    params: {
      proposal_id: { type: 'string', required: true, description: 'Promotion proposal id returned by source_index_promotion_propose.' },
      decision: { type: 'string', required: true, enum: [...SOURCE_INDEX_PROMOTION_DECISIONS], description: 'Review decision to record.' },
      decided_by: { type: 'string', description: 'Optional reviewer/agent label, stored only as a hash.' },
      reason_code: { type: 'string', enum: [...SOURCE_INDEX_PROMOTION_REASON_CODES], description: 'Optional typed reason for the decision.' },
    },
    mutating: true,
    nativeExposure: 'sourceIndexAnswerDevOnly',
    cliHints: { name: 'source index promotion decide' },
    handler: async (ctx, params) => {
      const proposalId = asString(params.proposal_id, 'proposal_id');
      const decision = asPromotionDecision(params.decision);
      const decidedBy = optionalString(params.decided_by);
      const reasonCode = optionalPromotionReasonCode(params.reason_code);
      return ctx.email.sourceIndexPromotionDecision({
        proposalId,
        decision,
        ...(decidedBy !== undefined ? { decidedBy } : {}),
        ...(reasonCode !== undefined ? { reasonCode } : {}),
      });
    },
  }] satisfies Operation[]),
  {
    name: 'source_watch_create',
    description: [
      'Create a durable one-shot or standing watch over any registered source corpus.',
      'The authenticated OpenClaw session supplies owner and outbound route authority; tool parameters cannot override either.',
    ].join(' '),
    params: {
      corpus_id: { type: 'string', required: true, description: 'Registered source corpus to watch.' },
      query: { type: 'string', required: true, description: 'Saved retrieval query evaluated against newly observed indexed items.' },
      mode: { type: 'string', enum: ['one_shot', 'continuous'], description: 'one_shot completes after its first match; continuous remains active. Defaults to one_shot.' },
      expires_at: { type: 'string', description: 'Optional ISO timestamp that stops future matching but never cancels already committed delivery.' },
      max_delivery_attempts: { type: 'number', description: 'Bounded retry attempt ceiling. Defaults to the durable store policy.' },
    },
    mutating: true,
    nativeExposure: 'sourceIndexEnabledOnly',
    requiresOpenClawSessionRoute: true,
    cliHints: { name: 'source watch create' },
    handler: async (ctx, params) => {
      const expiresAt = optionalString(params.expires_at);
      const maxDeliveryAttempts = optionalNumber(params.max_delivery_attempts, 'max_delivery_attempts');
      return ctx.email.sourceWatchCreate({
        route: requireSourceWatchRoute(ctx),
        corpusId: asSourceIndexSearchCorpusId(params.corpus_id, ctx.config),
        queryText: asString(params.query, 'query'),
        mode: optionalSourceWatchMode(params.mode) ?? 'one_shot',
        ...(expiresAt ? { expiresAt } : {}),
        ...(maxDeliveryAttempts !== undefined ? { maxDeliveryAttempts } : {}),
      });
    },
  },
  {
    name: 'source_watches',
    description: 'List the authenticated owner\'s durable watches and lifecycle status without returning source content.',
    params: {
      limit: { type: 'number', description: 'Maximum watches to return, capped by the private worker.' },
      cursor: { type: 'string', description: 'Opaque pagination cursor returned by a previous source_watches call.' },
    },
    mutating: false,
    nativeExposure: 'sourceIndexEnabledOnly',
    requiresOpenClawSessionRoute: true,
    cliHints: { name: 'source watches' },
    handler: async (ctx, params) => {
      const limit = optionalNumber(params.limit, 'limit');
      const cursor = optionalString(params.cursor);
      return ctx.email.sourceWatches({
        route: requireSourceWatchRoute(ctx),
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
      });
    },
  },
  {
    name: 'source_watch_cancel',
    description: 'Cancel one authenticated-owner watch, stop future matching, and invalidate any in-flight delivery lease.',
    params: {
      watch_id: { type: 'string', required: true, description: 'Watch id returned by source_watch_create or source_watches.' },
      reason: { type: 'string', description: 'Optional safe categorical cancellation reason.' },
    },
    mutating: true,
    nativeExposure: 'sourceIndexEnabledOnly',
    requiresOpenClawSessionRoute: true,
    cliHints: { name: 'source watch cancel' },
    handler: async (ctx, params) => {
      const reason = optionalString(params.reason);
      return ctx.email.sourceWatchCancel({
        route: requireSourceWatchRoute(ctx),
        watchId: asString(params.watch_id, 'watch_id'),
        ...(reason ? { reason } : {}),
      });
    },
  },
  ...(PUBLIC_RUNTIME_BUILD ? [] : [{
    name: 'xanthos_file_deliver',
    description: [
      'Deliver a UTF-8 or base64 file to an approved Xanthos logical root through the bounded file-delivery worker.',
      'This tool accepts only logical root IDs and relative paths, uses no shell, exposes no absolute host paths, denies overwrites by default, and returns an audit reference.',
    ].join(' '),
    params: {
      root_id: { type: 'string', required: true, description: 'Approved logical destination root, for example olympus_smoke or growth_fleur.' },
      relative_path: { type: 'string', required: true, description: 'Relative file path below the approved root. Absolute paths and traversal are denied.' },
      content: { type: 'string', required: true, description: 'File content as UTF-8 text or base64 bytes.' },
      content_encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Content encoding. Defaults to utf8.' },
      write_mode: { type: 'string', required: true, enum: ['dry_run', 'create_new', 'overwrite_with_approval'], description: 'dry_run validates only; create_new refuses existing files; overwrite requires explicit approval.' },
      trust_domain: { type: 'string', required: true, enum: ['public_safe', 'internal', 'secure_local'], description: 'Trust domain of the content being delivered.' },
      source_provenance: { type: 'string', description: 'Optional safe provenance for generated content.' },
      idempotency_key: { type: 'string', required: true, description: 'Stable key for safe retries of the same delivery request.' },
      approval_id: { type: 'string', description: 'Explicit approval reference required for overwrite_with_approval.' },
      actor_id: { type: 'string', description: 'Optional caller or agent identity for audit.' },
      session_id: { type: 'string', description: 'Optional session identity for audit.' },
      model_provider: { type: 'string', description: 'Optional model/provider identity for audit.' },
      model_id: { type: 'string', description: 'Optional model identity for audit.' },
    },
    mutating: true,
    nativeExposure: 'fileDeliveryEnabledOnly',
    cliHints: { name: 'xanthos file deliver' },
    handler: async (ctx, params) => {
      if (!ctx.fileDelivery) {
        throw new OperationError(
          'file_delivery_not_configured',
          'File delivery client is not configured in this Olympus runtime.',
        );
      }
      const rootId = asString(params.root_id, 'root_id');
      const relativePath = asString(params.relative_path, 'relative_path');
      const content = asString(params.content, 'content');
      const contentEncoding = optionalFileContentEncoding(params.content_encoding);
      const writeMode = asFileDeliveryWriteMode(params.write_mode);
      const trustDomain = asFileDeliveryTrustDomain(params.trust_domain);
      const sourceProvenance = optionalString(params.source_provenance);
      const idempotencyKey = asString(params.idempotency_key, 'idempotency_key');
      const approvalId = optionalString(params.approval_id);
      const actorId = optionalString(params.actor_id);
      const sessionId = optionalString(params.session_id);
      const modelProvider = optionalString(params.model_provider);
      const modelId = optionalString(params.model_id);
      return ctx.fileDelivery.deliver({
        rootId,
        relativePath,
        content,
        ...(contentEncoding !== undefined ? { contentEncoding } : {}),
        writeMode,
        trustDomain,
        ...(sourceProvenance !== undefined ? { sourceProvenance } : {}),
        idempotencyKey,
        ...(approvalId !== undefined ? { approvalId } : {}),
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(modelProvider !== undefined ? { modelProvider } : {}),
        ...(modelId !== undefined ? { modelId } : {}),
      });
    },
  },
  {
    name: 'castor_workspace',
    description: [
      'Use {{ownerName}} delegated assistant workfiles through a bounded Xanthos worker.',
      'Anything inside the approved assistant workfiles root is intentionally delegated to {{assistantName}} for read, write, delete, and export through implemented destination actions without extra S4 approval gating.',
      'Finder/macOS aliases inside the workspace may be read, listed, and exported; alias targets are not writable or deletable through this tool.',
      'Use only logical root IDs and relative paths; the tool exposes no absolute host paths and does not grant shell access.',
    ].join(' '),
    params: {
      action: { type: 'string', required: true, enum: ['health', 'list', 'read', 'write', 'delete', 'export_gcs'], description: 'Workspace action.' },
      root_id: { type: 'string', description: 'Approved workspace root id. Use castor_workspace for the configured delegated workfiles root.' },
      relative_path: { type: 'string', description: 'Relative path inside the workspace root. Empty path means the root.' },
      content: { type: 'string', description: 'UTF-8 or base64 content for write.' },
      content_encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Content encoding for write. Defaults to utf8.' },
      destination_uri: { type: 'string', description: 'Allowlisted gs:// destination for export_gcs.' },
      recursive: { type: 'boolean', description: 'Required for deleting directories; export_gcs is always recursive for directories.' },
      dry_run: { type: 'boolean', description: 'For export_gcs, defaults true. Set false to perform the upload after inspecting a dry-run.' },
      include_media: { type: 'boolean', description: 'For directory export_gcs, include media extensions in addition to md/txt/pdf/html. Defaults false.' },
      idempotency_key: { type: 'string', description: 'Optional stable key for audit/retry correlation.' },
      actor_id: { type: 'string', description: 'Optional caller identity for audit.' },
      session_id: { type: 'string', description: 'Optional session identity for audit.' },
    },
    mutating: true,
    nativeExposure: 'castorWorkspaceEnabledOnly',
    cliHints: { name: 'castor workspace' },
    handler: async (ctx, params) => {
      if (!ctx.castorWorkspace) {
        throw new OperationError(
          'castor_workspace_not_configured',
          'Delegated workspace client is not configured in this Olympus runtime.',
        );
      }
      const action = asCastorWorkspaceAction(params.action);
      const rootId = optionalString(params.root_id);
      const relativePath = typeof params.relative_path === 'string' ? params.relative_path : undefined;
      const content = typeof params.content === 'string' ? params.content : undefined;
      const contentEncoding = optionalFileContentEncoding(params.content_encoding);
      const destinationUri = optionalString(params.destination_uri);
      const recursive = optionalBoolean(params.recursive, 'recursive');
      const dryRun = optionalBoolean(params.dry_run, 'dry_run');
      const includeMedia = optionalBoolean(params.include_media, 'include_media');
      const idempotencyKey = optionalString(params.idempotency_key);
      const actorId = optionalString(params.actor_id);
      const sessionId = optionalString(params.session_id);
      return ctx.castorWorkspace.run({
        action,
        ...(rootId !== undefined ? { rootId } : {}),
        ...(relativePath !== undefined ? { relativePath } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(contentEncoding !== undefined ? { contentEncoding } : {}),
        ...(destinationUri !== undefined ? { destinationUri } : {}),
        ...(recursive !== undefined ? { recursive } : {}),
        ...(dryRun !== undefined ? { dryRun } : {}),
        ...(includeMedia !== undefined ? { includeMedia } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
    },
  },
  {
    name: 'domain_agent',
    description: [
      'Create or inspect a reusable domain expert agent workspace, persona, library, and corpus setup through the configured domain-expert backend.',
      'Use this when the owner asks to create a governance, dating, trading, or other domain-specific researcher.',
      'dry_run=true asks the runtime worker for a non-mutating scaffold.',
    ].join(' '),
    params: {
      action: { type: 'string', required: true, enum: [...DOMAIN_AGENT_ACTIONS], description: 'Domain-agent lifecycle action.' },
      domain_id: { type: 'string', description: 'Stable domain id. Defaults to governance.' },
      display_name: { type: 'string', description: 'Optional human name for the domain researcher.' },
      dry_run: { type: 'boolean', description: 'Defaults true. Live execution is blocked until the runtime backend is configured.' },
    },
    mutating: true,
    availability: domainExpertToolsAvailable,
    cliHints: { name: 'domain agent' },
    handler: async (ctx, params) => runDomainExpert(ctx, 'domain_agent', params),
  },
  {
    name: 'domain_ask',
    description: [
      'Return a grounded domain-expert answer over a domain library using Gemini Enterprise RAG Engine Cross-Corpus Retrieval.',
      'This is the public/internal domain-expert lane, separate from the frozen secure-local source_answer pipeline.',
      'This tool is available only while its live retrieval backend is enabled.',
    ].join(' '),
    params: {
      domain_id: { type: 'string', description: 'Domain id. Defaults to governance.' },
      question: { type: 'string', required: true, description: 'Question for the domain expert to answer from its curated library.' },
      corpus_id: { type: 'string', description: 'Optional single Vertex RAG corpus id or manifest display name. Defaults to all corpora in the domain manifest.' },
      corpora: { type: 'array', description: 'Optional corpus ids or manifest display names. Defaults to all corpora in the domain manifest.' },
      max_results: { type: 'number', description: 'Optional retrieval result target. Defaults to 12.' },
    },
    mutating: false,
    availability: domainExpertToolsAvailable,
    cliHints: { name: 'domain ask', positional: ['question'], stdin: 'question' },
    handler: async (ctx, params) => runDomainExpert(ctx, 'domain_ask', params),
  },
  {
    name: 'domain_source',
    description: [
      'Manage source intake for a domain expert library from files, Google Docs, PDFs, books, blog posts, or web links.',
      'Worker-backed list/status are read-only registry reads; remove appends an audit tombstone; add keeps the existing intake record path.',
      'The source record is domain-agnostic and flows into classification, dedupe, staging, Gemini Enterprise import, and source-registry updates.',
      'dry_run=true asks the configured runtime worker for a non-mutating intake plan.',
    ].join(' '),
    params: {
      action: { type: 'string', required: true, enum: [...DOMAIN_SOURCE_ACTIONS], description: 'Source lifecycle action.' },
      domain_id: { type: 'string', description: 'Domain id. Defaults to governance.' },
      source_id: { type: 'string', description: 'Required for status/remove; optional stable id for add.' },
      kind: { type: 'string', enum: [...DOMAIN_SOURCE_KINDS], description: 'Source kind.' },
      title: { type: 'string', description: 'Optional source title.' },
      author: { type: 'string', description: 'Optional source author.' },
      url: { type: 'string', description: 'Canonical URL or provider locator for link intake.' },
      relative_path: { type: 'string', description: 'Path inside the domain workspace or delegated alias for folder intake.' },
      corpus_id: { type: 'string', description: 'Optional target corpus id.' },
      trust_posture: { type: 'string', description: 'Optional trust/source-review posture.' },
      copyright_posture: { type: 'string', description: 'Explicit source copyright/import posture when known.' },
      include_history: { type: 'boolean', description: 'For list, include every registry record per source instead of only current records.' },
      include_removed: { type: 'boolean', description: 'For list, include sources whose latest record is a removed tombstone.' },
      dry_run: { type: 'boolean', description: 'Defaults true. Live intake is blocked until the runtime backend is configured.' },
    },
    mutating: true,
    availability: domainExpertToolsAvailable,
    cliHints: { name: 'domain source' },
    handler: async (ctx, params) => runDomainExpert(ctx, 'domain_source', params),
  },
  {
    name: 'rag_corpus',
    description: [
      'Plan Gemini Enterprise RAG Engine corpus create, import, stage_import, web_import, notion_import, status, or refresh actions for a domain expert.',
      'The operation enforces the domain manifest GCS allowlist and keeps Olympus as the control plane.',
      'Live corpus mutations run in the OpenClaw runtime with credentials resolved through SecretRef; dry_run=true returns an operator-reviewable plan.',
    ].join(' '),
    params: {
      action: { type: 'string', required: true, enum: [...RAG_CORPUS_ACTIONS], description: 'Corpus lifecycle action.' },
      domain_id: { type: 'string', description: 'Domain id. Defaults to governance.' },
      corpus_id: { type: 'string', description: 'Target corpus id. Defaults to a domain manifest corpus.' },
      rag_file_name: { type: 'string', description: 'For delete_file, full Vertex ragFiles resource name under the resolved corpus.' },
      page_token: { type: 'string', description: 'For list_files, Vertex pageToken passthrough.' },
      source_id: { type: 'string', description: 'Optional source registry id to import or inspect.' },
      gcs_uri: { type: 'string', description: 'Optional staged gs:// URI. Must be under the domain allowlist.' },
      drive_file_id: { type: 'string', description: 'Optional Google Drive file id for future direct import paths.' },
      workspace_relative_path: { type: 'string', description: 'For stage_import, path inside the domain workspace root to recursively stage.' },
      batch_id: { type: 'string', description: 'Optional deterministic staging batch id. Generated by the worker when omitted.' },
      urls: { type: 'array', description: 'For web_import, HTTPS URLs to fetch and derive into importable documents; for notion_import, Notion URLs to import through the official API. 1 to 200 entries.' },
      page_ids: { type: 'array', description: 'For notion_import, raw Notion page ids to import.' },
      database_ids: { type: 'array', description: 'For notion_import, raw Notion database ids to query and import.' },
      include_media: { type: 'boolean', description: 'For stage_import or web_import, include media files. Audio/video media is staged raw and transcribed to markdown when live. Defaults false.' },
      transcript_mode: { type: 'string', enum: ['auto', 'captions', 'asr'], description: 'For web_import YouTube URLs: auto uses captions then ASR, captions never falls through to ASR, asr skips caption tiers. Defaults auto.' },
      dry_run: { type: 'boolean', description: 'Defaults true. Live corpus mutation is blocked until the runtime backend is configured.' },
    },
    mutating: true,
    availability: domainExpertToolsAvailable,
    cliHints: { name: 'rag corpus' },
    handler: async (ctx, params) => runDomainExpert(ctx, 'rag_corpus', params),
  },
  {
    name: 'domain_doc',
    description: [
      'Plan Google Docs collaboration for a domain expert service account: read, comment, visually marked insert/replace, accept, or reject.',
      'Google Docs API suggestion-mode creation is not treated as available; the supported review path is comments plus approved direct edits in a visible domain-agent style.',
      'Phase 0 is dry-run only and records the service-account, approval, and visual review contract.',
    ].join(' '),
    params: {
      action: { type: 'string', required: true, enum: [...DOMAIN_DOC_ACTIONS], description: 'Google Docs collaboration action.' },
      domain_id: { type: 'string', description: 'Domain id. Defaults to governance.' },
      document_id: { type: 'string', required: true, description: 'Google Docs document id.' },
      text: { type: 'string', description: 'Text for visual_insert or visual_replace.' },
      comment: { type: 'string', description: 'Comment text or edit rationale.' },
      range_start: { type: 'number', description: 'Optional Docs structural index/range start for edit actions.' },
      range_end: { type: 'number', description: 'Optional Docs structural index/range end for visual_replace.' },
      approval_id: { type: 'string', description: 'Explicit approval reference required for live direct edits.' },
      edit_batch_id: { type: 'string', description: 'Stable id for later accept/reject cleanup.' },
      dry_run: { type: 'boolean', description: 'Defaults true. Live Docs mutation is blocked until the runtime backend is configured.' },
    },
    mutating: true,
    availability: domainExpertToolsAvailable,
    cliHints: { name: 'domain doc' },
    handler: async (ctx, params) => runDomainExpert(ctx, 'domain_doc', params),
  },
  {
    name: 'annas_archive_search',
    description: [
      'Search Anna Archive through the Castor runtime secret and return ranked candidate book/file metadata for approval.',
      'The API key is never exposed to the agent; this tool is available only while the runtime worker is enabled.',
    ].join(' '),
    params: {
      domain_id: { type: 'string', description: 'Domain id. Defaults to governance.' },
      query: { type: 'string', description: 'Search query.' },
      topic: { type: 'string', description: 'Optional topic for top-N book discovery, such as evolutionary biology.' },
      title: { type: 'string', description: 'Optional title search.' },
      author: { type: 'string', description: 'Optional author search.' },
      language: { type: 'string', description: 'Optional preferred language filter or ranking hint.' },
      max_results: { type: 'number', description: 'Maximum candidate metadata results. Defaults to 10.' },
      top_n: { type: 'number', description: 'Number of top candidates to rank and present for approval. Defaults to max_results.' },
      format_preference: { type: 'string', enum: ['auto', 'text_rag', 'layout'], description: 'Prefer EPUB/text for text-first RAG, PDF for layout-heavy books, or auto.' },
    },
    mutating: false,
    availability: domainExpertToolsAvailable,
    cliHints: { name: 'annas archive search' },
    handler: async (ctx, params) => runDomainExpert(ctx, 'annas_archive_search', params),
  },
  {
    name: 'annas_archive_import',
    description: [
      "Plan or run an approved Anna Archive PDF/EPUB/etc. download into the owner\'s Xanthos books folder.",
      'Requires explicit copyright posture and approval for live execution; RAG ingest is optional and requires an explicit corpus_id.',
    ].join(' '),
    params: {
      domain_id: { type: 'string', description: 'Domain id. Defaults to governance.' },
      annas_archive_id: { type: 'string', description: 'Anna Archive item id or md5-like locator.' },
      url: { type: 'string', description: 'Optional Anna Archive URL locator.' },
      format: { type: 'string', enum: [...ANNAS_ARCHIVE_FORMATS], description: 'Desired or observed file format.' },
      corpus_id: { type: 'string', description: 'Optional explicit target domain corpus id for RAG ingest.' },
      title: { type: 'string', description: 'Candidate title, used for deterministic folder naming and audit.' },
      author: { type: 'string', description: 'Candidate author, used for deterministic folder naming and audit.' },
      year: { type: 'string', description: 'Candidate publication year, used for deterministic folder naming and audit.' },
      topic: { type: 'string', description: 'Topic folder under the Xanthos books root.' },
      language: { type: 'string', description: 'Candidate language metadata.' },
      file_name: { type: 'string', description: 'Optional original filename from the candidate metadata.' },
      md5: { type: 'string', description: 'Optional stable Anna/hash locator for duplicate detection.' },
      file_size_bytes: { type: 'number', description: 'Optional expected file size from candidate metadata.' },
      ingest: { type: 'boolean', description: 'Also attempt RAG ingest after saving. Requires explicit corpus_id or returns needs_corpus_decision.' },
      copyright_posture: { type: 'string', required: true, description: 'Explicit copyright/import posture for this item.' },
      approval_id: { type: 'string', description: 'Explicit approval reference required for live download/import.' },
      dry_run: { type: 'boolean', description: 'Defaults true. Live download is blocked until approval_id is provided.' },
    },
    mutating: true,
    availability: domainExpertToolsAvailable,
    cliHints: { name: 'annas archive import' },
    handler: async (ctx, params) => runDomainExpert(ctx, 'annas_archive_import', params),
  },
  {
    name: 'email_search',
    description: [
      'Search private email and return a sanitized local-only source packet for approved local/private sessions.',
      'Use query for Gmail search syntax when possible. Answer from returned packet items and cite safe provenance by subject/from/date/message_id.',
      'Do not request raw Gmail payloads.',
    ].join(' '),
    params: {
      question: { type: 'string', description: 'Optional natural-language question for audit/context. It is not converted into required Gmail terms.' },
      query: { type: 'string', description: 'Optional Gmail query string chosen by the local model or user.' },
      account: { type: 'string', description: 'Optional Google account or mailbox label to scope the request.' },
      after: { type: 'string', description: 'Optional lower date/time bound.' },
      before: { type: 'string', description: 'Optional upper date/time bound.' },
      from: { type: 'string', description: 'Optional sender constraint.' },
      to: { type: 'string', description: 'Optional recipient constraint.' },
      max_messages: { type: 'number', description: 'Optional maximum messages to retrieve; capped by the private worker.' },
      include_sanitized_text: { type: 'boolean', description: 'Whether to include sanitized message text. Defaults true for the local packet path.' },
    },
    mutating: false,
    nativeExposure: 'localEmailPacketsDevOnly',
    cliHints: { name: 'email search', positional: ['query'], stdin: 'query' },
    handler: async (ctx, params) => {
      const question = optionalString(params.question);
      const query = optionalString(params.query);
      const account = optionalSourceAccount(params.account, 'secure_local.dropbox.files');
      const after = optionalString(params.after);
      const before = optionalString(params.before);
      const from = optionalString(params.from);
      const to = optionalString(params.to);
      const maxMessages = optionalNumber(params.max_messages, 'max_messages');
      const includeSanitizedText = optionalBoolean(params.include_sanitized_text, 'include_sanitized_text');
      return ctx.email.search({
        ...(question !== undefined ? { question } : {}),
        ...(query !== undefined ? { query } : {}),
        ...(account !== undefined ? { account } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(maxMessages !== undefined ? { maxMessages } : {}),
        ...(includeSanitizedText !== undefined ? { includeSanitizedText } : {}),
      });
    },
  },
  {
    name: 'email_index_sync',
    description: 'Explicitly seed or rescan the bounded local Gmail source index without returning private content.',
    params: {
      account: { type: 'string', description: 'Optional Google account to scope the bounded seed.' },
      newer_than_days: { type: 'number', description: 'Bounded recency window. Defaults to 14 days.' },
      max_messages: { type: 'number', description: 'Maximum Gmail messages to index; capped by the private worker.' },
      query: { type: 'string', description: 'Optional Gmail query for a bounded proof seed.' },
    },
    mutating: true,
    nativeExposure: 'emailIndexAdminDevOnly',
    cliHints: { name: 'email index sync' },
    handler: async (ctx, params) => {
      const account = optionalSourceAccount(params.account, 'secure_local.dropbox.files');
      const newerThanDays = optionalNumber(params.newer_than_days, 'newer_than_days');
      const maxMessages = optionalNumber(params.max_messages, 'max_messages');
      const query = optionalString(params.query);
      return ctx.email.indexSync({
        ...(account !== undefined ? { account } : {}),
        ...(newerThanDays !== undefined ? { newerThanDays } : {}),
        ...(maxMessages !== undefined ? { maxMessages } : {}),
        ...(query !== undefined ? { query } : {}),
      });
    },
  },
  {
    name: 'email_index_embed',
    description: 'Explicitly build local/private embedding artifacts for the bounded Gmail source index without returning private content or vectors.',
    params: {
      account: { type: 'string', description: 'Optional account filter for the embedding build.' },
      model_id: { type: 'string', description: 'Optional local embedding model ID to require from the configured worker provider.' },
      force: { type: 'boolean', description: 'Rebuild embeddings even when chunk content hashes are unchanged.' },
    },
    mutating: true,
    nativeExposure: 'emailIndexAdminDevOnly',
    cliHints: { name: 'email index embed' },
    handler: async (ctx, params) => {
      const account = optionalString(params.account);
      const modelId = optionalString(params.model_id);
      const force = optionalBoolean(params.force, 'force');
      return ctx.email.indexEmbed({
        ...(account !== undefined ? { account } : {}),
        ...(modelId !== undefined ? { modelId } : {}),
        ...(force !== undefined ? { force } : {}),
      });
    },
  },
  {
    name: 'email_index_search',
    description: [
      'Search the local private email source index and return an Argus-only sanitized source packet with row and provider provenance.',
      'Use retrieval_mode=hybrid for conceptual aliases when local/private semantic artifacts are available; keyword remains the default exact/FTS path.',
    ].join(' '),
    params: {
      query: { type: 'string', required: true, description: 'Keyword/FTS query for the local email index.' },
      retrieval_mode: { type: 'string', enum: ['keyword', 'hybrid'], description: 'Retrieval mode. Defaults to keyword unless hybrid is explicitly requested and semantic artifacts/config are available.' },
      account: { type: 'string', description: 'Optional account filter.' },
      after: { type: 'string', description: 'Optional lower date/time bound.' },
      before: { type: 'string', description: 'Optional upper date/time bound.' },
      from: { type: 'string', description: 'Optional sender filter.' },
      to: { type: 'string', description: 'Optional recipient filter.' },
      label: { type: 'string', description: 'Optional Gmail label filter.' },
      max_messages: { type: 'number', description: 'Maximum packet items to return; capped by the private worker.' },
    },
    mutating: false,
    nativeExposure: 'localEmailPacketsDevOnly',
    cliHints: { name: 'email index search', positional: ['query'], stdin: 'query' },
    handler: async (ctx, params) => {
      const query = asString(params.query, 'query');
      const retrievalMode = optionalRetrievalMode(params.retrieval_mode);
      const account = optionalString(params.account);
      const after = optionalString(params.after);
      const before = optionalString(params.before);
      const from = optionalString(params.from);
      const to = optionalString(params.to);
      const label = optionalString(params.label);
      const maxMessages = optionalNumber(params.max_messages, 'max_messages');
      return ctx.email.indexSearch({
        query,
        ...(retrievalMode !== undefined ? { retrievalMode } : {}),
        ...(account !== undefined ? { account } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(maxMessages !== undefined ? { maxMessages } : {}),
      });
    },
  },
  {
    name: 'expert_hire',
    description: 'Hire a pinned external consultant through the contained Hire Broker. New or drifted counterparties require trusted owner confirmation; all briefs pass the Release Gate before any payment or dispatch.',
    params: {
      listing: { type: 'object', required: true, description: 'Counterparty listing with name, HTTPS endpoint, and optional erc8004 identity claim.' },
      brief: { type: 'string', required: true, description: 'Self-contained shape-only brief. Never include S4+ content, identifiers, secrets, URLs, or filesystem paths.' },
      budget: { type: 'object', required: true, description: 'Maximum payment object with positive amount and currency.' },
      owner_confirmed: { type: 'boolean', description: 'Set only after the owner explicitly approves the exact new or drifted counterparty prompt.' },
    },
    mutating: true,
    nativeExposure: 'hireBrokerEnabledOnly',
    cliHints: { name: 'expert hire' },
    handler: async (ctx, params) => {
      if (!ctx.hireBroker) {
        throw new OperationError('config_error', 'Hire Broker is not configured.');
      }
      const ownerConfirmed = params.owner_confirmed === true;
      return ctx.hireBroker.hire({
        listing: params.listing,
        brief: asString(params.brief, 'brief'),
        budget: params.budget,
        ...(ownerConfirmed ? { ownerConfirmed: true } : {}),
        ...(ownerConfirmed && ctx.hireBrokerAuthority?.senderIsOwner === true
          ? { ownerAuthorized: true }
          : {}),
      });
    },
  },
  {
    name: 'expert_report',
    description: 'Read a consultant result through the hostile-input membrane. Returns only a bounded summary, instruction flags, provenance, and spend; raw report text is never exposed by this tool.',
    params: {
      handle: { type: 'string', required: true, description: 'Opaque Hire Broker handle returned by expert_hire.' },
    },
    mutating: false,
    nativeExposure: 'hireBrokerEnabledOnly',
    cliHints: { name: 'expert report', positional: ['handle'] },
    handler: async (ctx, params) => {
      if (!ctx.hireBroker) {
        throw new OperationError('config_error', 'Hire Broker is not configured.');
      }
      return ctx.hireBroker.report(asString(params.handle, 'handle'));
    },
  }] satisfies Operation[]),
  {
    // Agent-facing tool name only. The CLI command stays `olympus doctor`
    // through cliHints below; `doctor` is far too generic a name to publish
    // into a host tool namespace shared with every other plugin.
    name: 'olympus_doctor',
    description: [
      'Run a read-only health walk across the Argus local model lanes, the private email worker, and the source index, reporting what is broken in plain language.',
      'This touches no secrets and reads no credentials: output contains statuses and counts only, never tokens, source text, or packets.',
    ].join(' '),
    params: {},
    mutating: false,
    nativeExposure: 'always',
    cliHints: { name: 'doctor' },
    handler: async (ctx) => runDoctor({ config: ctx.config, delphi: ctx.delphi, env: process.env }),
  },
];

function optionalSourceIndexAnswerCorpusId(value: unknown, config: OlympusConfig): SourceIndexAnswerCorpusId | undefined {
  const corpusId = optionalString(value);
  if (corpusId === undefined) return undefined;
  return publicSourceCorpusRegistry(config).require(corpusId, 'answer');
}

function sourceAnswerCorpusIds(value: unknown, config: OlympusConfig): string[] {
  const corpusIds = asStringList(value, 'corpus_ids');
  const registry = publicSourceCorpusRegistry(config);
  for (const corpusId of corpusIds) {
    registry.require(corpusId, 'answer', 'corpus_ids');
  }
  return [...new Set(corpusIds)];
}

function optionalSourceIndexStatusCorpusId(value: unknown, config: OlympusConfig): SourceIndexStatusCorpusId | undefined {
  const corpusId = optionalString(value);
  if (corpusId === undefined) return undefined;
  return publicSourceCorpusRegistry(config).require(corpusId, 'status');
}

function asSourceIndexSyncCorpusId(value: unknown, config: OlympusConfig): SourceIndexSyncCorpusId {
  const corpusId = asString(value, 'corpus_id');
  return sourceCorpusRegistry(config).require(corpusId, 'sync');
}

function asSourceIndexSearchCorpusId(value: unknown, config: OlympusConfig): SourceIndexSearchCorpusId {
  const corpusId = asString(value, 'corpus_id');
  return publicSourceCorpusRegistry(config).require(corpusId, 'search');
}

function optionalSourceIndexPromotionCandidateCorpusId(value: unknown, config: OlympusConfig): SourceIndexPromotionCandidateCorpusId | undefined {
  const corpusId = optionalString(value);
  if (corpusId === undefined) return undefined;
  return sourceCorpusRegistry(config).require(corpusId, 'promotion_candidates');
}

function optionalSourceWatchMode(value: unknown): SourceWatchMode | undefined {
  const mode = optionalString(value);
  if (mode === undefined || mode === 'one_shot' || mode === 'continuous') return mode;
  throw new OperationError('invalid_params', 'mode must be one_shot or continuous.');
}

function requireSourceWatchRoute(ctx: OperationContext): SourceWatchAuthenticatedRoute {
  if (!ctx.sourceWatchRoute) {
    throw new OperationError(
      'source_index_policy_violation',
      'Durable watch management requires an authenticated OpenClaw owner and delivery route.',
      'Create and manage watches from an owner-authenticated OpenClaw channel session.',
    );
  }
  return ctx.sourceWatchRoute;
}

function asPromotionCanonicalType(value: unknown): SourceIndexPromotionCanonicalType {
  const canonicalType = asString(value, 'canonical_type');
  if (includesString(SOURCE_INDEX_PROMOTION_CANONICAL_TYPES, canonicalType)) return canonicalType;
  throw new OperationError('invalid_params', 'canonical_type is not supported.');
}

function asPromotionTargetSurface(value: unknown): SourceIndexPromotionTargetSurface {
  const targetSurface = asString(value, 'target_surface');
  if (includesString(SOURCE_INDEX_PROMOTION_TARGET_SURFACES, targetSurface)) return targetSurface;
  throw new OperationError('invalid_params', 'target_surface is not supported.');
}

function asPromotionReasonCode(value: unknown): SourceIndexPromotionReasonCode {
  const reasonCode = asString(value, 'reason_code');
  if (includesString(SOURCE_INDEX_PROMOTION_REASON_CODES, reasonCode)) return reasonCode;
  throw new OperationError('invalid_params', 'reason_code is not supported.');
}

function optionalPromotionReasonCode(value: unknown): SourceIndexPromotionReasonCode | undefined {
  const reasonCode = optionalString(value);
  if (reasonCode === undefined) return undefined;
  if (includesString(SOURCE_INDEX_PROMOTION_REASON_CODES, reasonCode)) return reasonCode;
  throw new OperationError('invalid_params', 'reason_code is not supported.');
}

function optionalPromotionProposalStatus(value: unknown): SourceIndexPromotionProposalStatus | undefined {
  const status = optionalString(value);
  if (status === undefined) return undefined;
  if (includesString(SOURCE_INDEX_PROMOTION_PROPOSAL_STATUSES, status)) return status;
  throw new OperationError('invalid_params', 'status is not supported.');
}

function asPromotionDecision(value: unknown): SourceIndexPromotionDecision {
  const decision = asString(value, 'decision');
  if (includesString(SOURCE_INDEX_PROMOTION_DECISIONS, decision)) return decision;
  throw new OperationError('invalid_params', 'decision is not supported.');
}

function includesString<T extends readonly string[]>(values: T, value: string): value is T[number] {
  return (values as readonly string[]).includes(value);
}

function optionalSourceTranscribeMode(value: unknown): 'enqueue' | 'status' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'enqueue' || value === 'status') return value;
  throw new OperationError('invalid_params', 'mode must be enqueue or status.');
}

function asSourceTranscribeItems(value: unknown): string[] {
  const entries = sourceExportItemEntries(value);
  const items = entries.map((entry, index) => {
    if (typeof entry === 'string' && entry.trim()) return entry.trim();
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const path = optionalString((entry as Record<string, unknown>).path);
      if (path) return path;
    }
    throw new OperationError('invalid_params', `items.${index} must be a Dropbox audio file path string.`);
  });
  if (items.length === 0) {
    throw new OperationError('invalid_params', 'items must include at least one Dropbox audio file path.');
  }
  return items;
}

function asSourceMediaIngestItems(value: unknown): string[] {
  const entries = sourceExportItemEntries(value);
  const items = entries.map((entry, index) => {
    if (typeof entry === 'string' && entry.trim()) return entry.trim();
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const path = optionalString((entry as Record<string, unknown>).path);
      if (path) return path;
    }
    throw new OperationError('invalid_params', `items.${index} must be a Dropbox image file path string.`);
  });
  if (items.length === 0) {
    throw new OperationError('invalid_params', 'items must include at least one Dropbox image file path.');
  }
  return items;
}

function asSourceExportItems(value: unknown): SourceExportItemOption[] {
  const entries = sourceExportItemEntries(value);
  const items = entries.map((entry, index) => sourceExportItemFromEntry(entry, index));
  if (items.length === 0) {
    throw new OperationError('invalid_params', 'items must include at least one export item.');
  }
  return items;
}

function sourceExportItemEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim();
    if (text.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new OperationError('invalid_params', 'items must be valid JSON when passed as a JSON array string.');
      }
      if (!Array.isArray(parsed)) {
        throw new OperationError('invalid_params', 'items must be a JSON array of export items.');
      }
      return parsed;
    }
    return text.split(',').map((item) => item.trim()).filter(Boolean);
  }
  throw new OperationError('invalid_params', 'items must be a JSON array of export items or a comma-separated list of source paths.');
}

function sourceExportItemFromEntry(entry: unknown, index: number): SourceExportItemOption {
  if (typeof entry === 'string' && entry.trim()) {
    return { path: entry.trim() };
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    const path = optionalString(record.path);
    if (!path) {
      throw new OperationError('invalid_params', `items.${index}.path must be a non-empty string.`);
    }
    const destSubfolder = optionalString(record.dest_subfolder);
    return {
      path,
      ...(destSubfolder !== undefined ? { destSubfolder } : {}),
    };
  }
  throw new OperationError('invalid_params', `items.${index} must be a source path string or an object with a path.`);
}

export function findOperationByCliName(cliName: string): Operation | undefined {
  return operations.find((operation) => operation.cliHints.name === cliName);
}

export function findOperationByName(name: string): Operation | undefined {
  return operations.find((operation) => operation.name === name);
}

export function operationDescription(operation: Operation, options: OperationSurfaceOptions = {}): string {
  return renderIdentityTemplate(operation.description, options.config);
}

export function operationToolSchema(
  operation: Operation,
  options: OperationSurfaceOptions = {},
): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(operation.params).map(([name, param]) => [
        name,
        {
          type: param.type,
          description: param.description ? renderIdentityTemplate(param.description, options.config) : undefined,
          ...parameterEnum(operation, name, param, options),
        },
      ]),
    ),
    required: Object.entries(operation.params)
      .filter(([, param]) => param.required)
      .map(([name]) => name),
  };
}

function assertNoUndeclaredSourceIndexSearchParams(params: Record<string, unknown>): void {
  assertNoUndeclaredParams(SOURCE_INDEX_SEARCH_PARAMS, params, 'Source-index search');
}

/**
 * No surface rejects extra keys — the emitted tool schema carries no
 * `additionalProperties: false`, and the CLI admits any `--flag` — so a
 * narrowing parameter an operation does not declare is otherwise read by
 * nobody and reported to nobody. The names that collide here are the ones a
 * sibling tool already taught the caller, so the drop lands as a confidently
 * out-of-scope answer.
 */
function assertNoUndeclaredParams(
  declared: Record<string, ParamDef>,
  params: Record<string, unknown>,
  label: string,
): void {
  const undeclaredFields = Object.keys(params)
    .filter((field) => !Object.prototype.hasOwnProperty.call(declared, field))
    .sort();
  if (undeclaredFields.length === 0) return;
  throw new OperationError(
    'invalid_request',
    `${label} request contains undeclared ${undeclaredFields.length === 1 ? 'property' : 'properties'}: ${undeclaredFields.map((field) => `"${field}"`).join(', ')}. Remove ${undeclaredFields.length === 1 ? 'it' : 'them'} and retry.`,
  );
}

function parameterEnum(
  operation: Operation,
  paramName: string,
  param: ParamDef,
  options: OperationSurfaceOptions,
): { enum?: string[] } {
  const config = options.config ?? defaultConfig();
  const capability = sourceCorpusCapabilityForParameter(operation.name, paramName);
  if (capability) {
    const publicOperation = (V0_4_PUBLIC_NATIVE_TOOLS as readonly string[]).includes(operation.name);
    const registry = publicOperation ? publicSourceCorpusRegistry(config) : sourceCorpusRegistry(config);
    return { enum: registry.ids(capability) };
  }
  return param.enum ? { enum: param.enum } : {};
}

function sourceCorpusCapabilityForParameter(operationName: string, paramName: string): SourceCorpusCapability | undefined {
  if (paramName !== 'corpus_id') return undefined;
  if (operationName === 'source_answer') return 'answer';
  if (operationName === 'source_index_status') return 'status';
  if (operationName === 'source_index_sync') return 'sync';
  if (operationName === 'source_index_search') return 'search';
  if (operationName === 'source_watch_create') return 'search';
  if (operationName === 'source_index_promotion_candidates') return 'promotion_candidates';
  return undefined;
}

function sourceCorpusRegistry(config: OlympusConfig) {
  return createSourceCorpusRegistry(config.sourceIndex.corpusRegistry);
}

function publicSourceCorpusRegistry(config: OlympusConfig) {
  return createPublicSourceCorpusRegistry(config.sourceIndex.corpusRegistry);
}

function renderIdentityTemplate(value: string, config?: OlympusConfig): string {
  const identity = config?.identity ?? { ownerName: 'the owner', assistantName: 'the calling assistant' };
  return value
    .replace(/\{\{ownerName\}\}/g, identity.ownerName)
    .replace(/\{\{assistantName\}\}/g, identity.assistantName);
}

async function runDomainExpert(
  ctx: OperationContext,
  tool: DomainExpertTool,
  rawParams: Record<string, unknown>,
): Promise<unknown> {
  if (ctx.domainExpert && ctx.config.domainExpert.enabled && ctx.config.domainExpert.liveToolsEnabled) {
    return ctx.domainExpert.run(tool, rawParams);
  }
  throw new OperationError(
    'domain_expert_not_configured',
    `${tool} is unavailable because the live domain-expert backend is not enabled in this Olympus runtime.`,
    'Enable both domainExpert.enabled and domainExpert.liveToolsEnabled after configuring the runtime worker.',
  );
}

function domainExpertToolsAvailable(config: OlympusConfig): boolean {
  return config.domainExpert.enabled
    && config.domainExpert.liveToolsEnabled;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OperationError('invalid_params', `${name} must be a non-empty string.`);
  }
  return value;
}

function asStringList(value: unknown, name: string): string[] {
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (typeof item !== 'string' && typeof item !== 'number') {
        throw new OperationError('invalid_params', `${name}.${index} must be a string or number.`);
      }
      return String(item).trim();
    }).filter(Boolean);
  }
  throw new OperationError('invalid_params', `${name} must be a comma-separated string or array.`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNarrowingString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OperationError('invalid_params', `${name} must be a non-empty string when provided.`);
  }
  return value.trim();
}

function optionalExactNarrowingString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OperationError('invalid_params', `${name} must be a non-empty string when provided.`);
  }
  return value;
}

function optionalTrustDomainConsistency(
  value: unknown,
  corpusId: SourceIndexSearchCorpusId,
  config: OlympusConfig,
): string | undefined {
  if (value === undefined) return undefined;
  const selectedCorpus = sourceCorpusRegistry(config)
    .list('search')
    .find((corpus) => corpus.corpusId === corpusId);
  if (!selectedCorpus) {
    throw new OperationError('invalid_request', 'The selected corpus trust domain is unavailable.');
  }
  if (typeof value !== 'string' || value !== selectedCorpus.trustDomain) {
    throw new OperationError(
      'invalid_request',
      'trust_domain does not exactly match the selected corpus trust domain.',
    );
  }
  return value;
}

function optionalSourceAccount(
  value: unknown,
  corpusId?: SourceIndexAnswerCorpusId | SourceIndexStatusCorpusId | SourceIndexSyncCorpusId | SourceIndexSearchCorpusId | SourceIndexPromotionCandidateCorpusId,
): string | undefined {
  const account = optionalString(value);
  if (account === undefined) return undefined;
  if (account.startsWith('dropbox.') && (corpusId === undefined || corpusId === 'secure_local.dropbox.files')) {
    throw new OperationError(
      'invalid_params',
      'Dropbox source account must be omitted or set to personal. Use approved_scope_key for Dropbox folder scopes such as dropbox.personal:/2 Areas; do not use dropbox.primary or credential handles as account.',
    );
  }
  return account;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new OperationError('invalid_params', `${name} must be a number.`);
  }
  return number;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new OperationError('invalid_params', `${name} must be true or false.`);
}

function optionalRetrievalMode(value: unknown): 'keyword' | 'hybrid' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'keyword' || value === 'hybrid') return value;
  throw new OperationError('invalid_params', 'retrieval_mode must be keyword or hybrid.');
}

function optionalSourceAnswerAnalystProvider(value: unknown): 'default' | 'local' | 'venice' | 'cloud' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'default' || value === 'local' || value === 'venice' || value === 'cloud') return value;
  throw new OperationError('invalid_params', 'analyst_provider must be default, local, venice, or cloud.');
}

function optionalSourceAnswerSelectedItems(
  value: unknown,
  fallbackCorpusId?: SourceAnswerSelectedItemOption['corpus_id'],
): SourceAnswerSelectedItemOption[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Array.isArray(value)) {
    throw new OperationError('invalid_params', 'selected_items must be an array.');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new OperationError('invalid_params', `selected_items.${index} must be an object.`);
    }
    const initialRecord = item as Record<string, unknown>;
    const forbiddenPath = selectedItemContentFieldPath(initialRecord);
    if (forbiddenPath) {
      throw new OperationError('invalid_params', `selected_items.${index} must not include source content field ${forbiddenPath}.`);
    }
    const record = selectedItemRecord(initialRecord, fallbackCorpusId);
    return {
      corpus_id: requiredSelectedItemString(record.corpus_id, `selected_items.${index}.corpus_id`),
      family: requiredSelectedItemString(record.family, `selected_items.${index}.family`),
      provider: requiredSelectedItemString(record.provider, `selected_items.${index}.provider`),
      account_scope: requiredSelectedItemString(record.account_scope, `selected_items.${index}.account_scope`),
      provider_item_id: requiredSelectedItemString(record.provider_item_id, `selected_items.${index}.provider_item_id`),
      local_item_id: requiredSelectedItemString(record.local_item_id, `selected_items.${index}.local_item_id`),
      ...optionalSelectedItemString(record.provider_thread_id, 'provider_thread_id'),
      ...optionalSelectedItemString(record.provider_conversation_id, 'provider_conversation_id'),
      ...optionalSelectedItemString(record.provider_file_id, 'provider_file_id'),
      ...optionalSelectedItemString(record.source_version, 'source_version'),
      ...optionalSelectedItemString(record.conversation_label, 'conversation_label'),
      ...optionalSelectedItemString(record.author_label, 'author_label'),
      ...optionalSelectedItemString(record.authored_at, 'authored_at'),
    };
  });
}

function selectedItemRecord(record: Record<string, unknown>, fallbackCorpusId?: string): Record<string, unknown> {
  const selectedItem = record.selected_item;
  if (selectedItem && typeof selectedItem === 'object' && !Array.isArray(selectedItem)) {
    return selectedItem as Record<string, unknown>;
  }
  const sourceItem = record.sourceItem;
  if (sourceItem && typeof sourceItem === 'object' && !Array.isArray(sourceItem)) {
    const source = sourceItem as Record<string, unknown>;
    return {
      corpus_id: record.corpus_id ?? fallbackCorpusId,
      family: source.family,
      provider: source.provider,
      account_scope: source.accountScope,
      provider_item_id: source.providerItemId,
      local_item_id: source.localItemId,
      provider_thread_id: source.providerThreadId,
      provider_conversation_id: source.providerConversationId,
      provider_file_id: source.providerFileId,
      source_version: source.sourceVersion,
    };
  }
  return {
    ...record,
    account_scope: record.account_scope ?? record.accountScope,
    provider_item_id: record.provider_item_id ?? record.providerItemId,
    local_item_id: record.local_item_id ?? record.localItemId,
    provider_thread_id: record.provider_thread_id ?? record.providerThreadId,
    provider_conversation_id: record.provider_conversation_id ?? record.providerConversationId,
    provider_file_id: record.provider_file_id ?? record.providerFileId,
    source_version: record.source_version ?? record.sourceVersion,
  };
}

function requiredSelectedItemString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
    throw new OperationError('invalid_params', `${name} must be a non-empty safe identifier string.`);
  }
  return value.trim();
}

function optionalSelectedItemString(value: unknown, key: keyof SourceAnswerSelectedItemOption): Partial<SourceAnswerSelectedItemOption> {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string' || value.length > 1_000) {
    throw new OperationError('invalid_params', `selected_items.${key} must be a safe string.`);
  }
  return { [key]: value.trim() };
}

function optionalAnalystModel(
  value: unknown,
  name: string,
  analystProvider?: 'default' | 'local' | 'venice' | 'cloud',
): string | undefined {
  const model = optionalString(value)?.trim();
  if (model === undefined) return undefined;
  const normalized = analystProvider === 'venice' || analystProvider === undefined
    ? normalizeVeniceAnalystModelId(model)
    : model;
  if (normalized.length > 160 || !/^[A-Za-z0-9._:/@+-]+$/.test(normalized)) {
    throw new OperationError('invalid_params', `${name} must be a provider model id using safe identifier characters.`);
  }
  return normalized;
}

function optionalTelegramTrustDomain(value: unknown): 'internal' | 'secure_local' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'internal' || value === 'secure_local') return value;
  throw new OperationError('invalid_params', 'trust_domain must be internal or secure_local.');
}

function optionalTelegramSyncDirection(value: unknown): 'forward' | 'backfill' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'forward' || value === 'backfill') return value;
  throw new OperationError('invalid_params', 'sync_direction must be forward or backfill.');
}

function optionalXBookmarksSyncMode(
  value: unknown,
  corpusId: SourceIndexSyncCorpusId,
): 'head' | 'reconcile' | 'folder_facet_refresh' | 'window_diagnostic' | 'preservation-reattest' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (corpusId !== 'internal.x.bookmarks') {
    throw new OperationError('invalid_params', 'mode is supported only for internal.x.bookmarks source-index sync.');
  }
  if (value === 'head' || value === 'reconcile'
    || value === 'folder_facet_refresh'
    || value === 'window_diagnostic' || value === 'preservation-reattest') return value;
  throw new OperationError(
    'invalid_params',
    'mode must be head, reconcile, window_diagnostic, folder_facet_refresh, or preservation-reattest for X bookmarks source-index sync.',
  );
}

function asFileDeliveryWriteMode(value: unknown): 'dry_run' | 'create_new' | 'overwrite_with_approval' {
  const writeMode = asString(value, 'write_mode');
  if (writeMode === 'dry_run' || writeMode === 'create_new' || writeMode === 'overwrite_with_approval') {
    return writeMode;
  }
  throw new OperationError('invalid_params', 'write_mode must be dry_run, create_new, or overwrite_with_approval.');
}

function asFileDeliveryTrustDomain(value: unknown): 'public_safe' | 'internal' | 'secure_local' {
  const trustDomain = asString(value, 'trust_domain');
  if (trustDomain === 'public_safe' || trustDomain === 'internal' || trustDomain === 'secure_local') {
    return trustDomain;
  }
  throw new OperationError('invalid_params', 'trust_domain must be public_safe, internal, or secure_local.');
}

function optionalFileContentEncoding(value: unknown): 'utf8' | 'base64' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'utf8' || value === 'base64') return value;
  throw new OperationError('invalid_params', 'content_encoding must be utf8 or base64.');
}

function asCastorWorkspaceAction(value: unknown): 'health' | 'list' | 'read' | 'write' | 'delete' | 'export_gcs' {
  if (
    value === 'health'
    || value === 'list'
    || value === 'read'
    || value === 'write'
    || value === 'delete'
    || value === 'export_gcs'
  ) {
    return value;
  }
  throw new OperationError('invalid_params', 'action must be health, list, read, write, delete, or export_gcs.');
}

function optionalAttachmentType(value: unknown): 'image' | 'video' | 'audio' | 'file' | 'link' | 'other' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    value === 'image'
    || value === 'video'
    || value === 'audio'
    || value === 'file'
    || value === 'link'
    || value === 'other'
  ) return value;
  throw new OperationError('invalid_params', 'attachment_type must be image, video, audio, file, link, or other.');
}

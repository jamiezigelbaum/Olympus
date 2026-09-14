import { DelphiClient } from './delphi.ts';
import { runDoctor } from './doctor.ts';
import { EmailClient, type SourceAnswerSelectedItemOption } from './email.ts';
import { defaultConfig, type OlympusConfig } from './config.ts';
import { resolveLane, resolveModelProfile } from './config.ts';
import { OperationError } from './operation-error.ts';
import { selectedItemContentFieldPath } from './source-index/selected-item-safety.ts';
import {
  createPublicSourceCorpusRegistry,
  type SourceCorpusCapability,
} from './source-corpus-registry.ts';
import { normalizeVeniceAnalystModelId } from './venice-models.ts';
import type { SourceWatchAuthenticatedRoute, SourceWatchMode } from './source-watch.ts';

type SourceIndexAnswerCorpusId = string;
type SourceIndexStatusCorpusId = string;
type SourceIndexSearchCorpusId = string;

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
  /** Trusted OpenClaw tool-factory context; never sourced from tool params. */
  sourceWatchRoute?: SourceWatchAuthenticatedRoute;
}

export interface Operation {
  name: string;
  description: string;
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  mutating: boolean;
  availability?: (config: OlympusConfig) => boolean;
  nativeExposure?: 'always' | 'sourceIndexEnabledOnly';
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


function asSourceIndexSearchCorpusId(value: unknown, config: OlympusConfig): SourceIndexSearchCorpusId {
  const corpusId = asString(value, 'corpus_id');
  return publicSourceCorpusRegistry(config).require(corpusId, 'search');
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
    return { enum: publicSourceCorpusRegistry(config).ids(capability) };
  }
  return param.enum ? { enum: param.enum } : {};
}

function sourceCorpusCapabilityForParameter(operationName: string, paramName: string): SourceCorpusCapability | undefined {
  if (paramName !== 'corpus_id') return undefined;
  if (operationName === 'source_answer') return 'answer';
  if (operationName === 'source_index_status') return 'status';
  if (operationName === 'source_index_search') return 'search';
  if (operationName === 'source_watch_create') return 'search';
  return undefined;
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
  const selectedCorpus = publicSourceCorpusRegistry(config)
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
  corpusId?: SourceIndexAnswerCorpusId | SourceIndexStatusCorpusId | SourceIndexSearchCorpusId,
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

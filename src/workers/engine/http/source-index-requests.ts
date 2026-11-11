import type { SourceTrustDomain } from '../../../core/source-index/types.ts';
import type { OperationCallerWire } from '../../../core/operation-caller.ts';
import { selectedItemContentFieldPath } from '../../../core/source-index/selected-item-safety.ts';
import { normalizeVeniceAnalystModelId } from '../../../core/venice-models.ts';
import type { SourceIndexAnswerRequest, SourceAnswerSelectedItem } from '../../source-index/answer-types.ts';
import type { SourceIndexStatusRequest } from '../../source-index/status.ts';
import { READWISE_LIBRARY_CORPUS_ID } from '../../readwise/index.ts';
import { X_BOOKMARKS_CORPUS_ID } from '../../x-bookmarks/index.ts';
import { DROPBOX_FILES_CORPUS_ID } from '../../dropbox-files/index.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
} from '../../telegram-messages/index.ts';
import { normalizeConnectorStoreSearchFilters, LocalConnectorStore } from '../../connector-store/index.ts';
import {
  parseObjectBody,
  asOptionalString,
  asOptionalBoolean,
  parseRequestCaller,
  asOptionalStringArray,
  asOptionalNumber,
  recordFromSearchParams,
  canonicalRequestCorpusId,
} from './request-fields.ts';
import { EmailSourceWorkerError } from './worker-responses.ts';

/** The `/consult/ask` body: the question and the conversation's choices, shapes only. */
export interface ConsultAskWireRequest {
  question: string;
  level?: 'strict' | 'standard';
  cleanup?: 'as_written' | 'light_cleanup' | 'custom';
  remember?: boolean;
  model?: string;
  /** The calling agent, validated like source_answer's; its provider chooses the model setting. */
  caller?: OperationCallerWire;
}

export async function parseConsultAskRequest(request: Request): Promise<ConsultAskWireRequest> {
  const record = await parseObjectBody(request);
  if (typeof record.question !== 'string' || record.question.trim().length === 0) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'question must be a non-empty string.');
  }
  const level = asOptionalString(record.level);
  if (level !== undefined && level !== 'strict' && level !== 'standard') {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'level must be "strict" or "standard".');
  }
  const cleanup = asOptionalString(record.cleanup);
  if (cleanup !== undefined && cleanup !== 'as_written' && cleanup !== 'light_cleanup' && cleanup !== 'custom') {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'cleanup must be "as_written", "light_cleanup" or "custom".');
  }
  const remember = asOptionalBoolean(record.remember);
  const model = asOptionalString(record.model);
  const caller = parseRequestCaller(record, request);
  return {
    question: record.question,
    ...(level !== undefined ? { level } : {}),
    ...(cleanup !== undefined ? { cleanup } : {}),
    ...(remember !== undefined ? { remember } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(caller ? { caller } : {}),
  };
}

export async function parseSourceIndexAnswerRequest(request: Request): Promise<SourceIndexAnswerRequest> {
  const record = await parseObjectBody(request);
  if (typeof record.question !== 'string' || record.question.trim().length === 0) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'question must be a non-empty string.');
  }
  const query = asOptionalString(record.query);
  const account = asOptionalString(record.account);
  const corpusId = asOptionalString(record.corpus_id);
  const corpusIds = asOptionalStringArray(record.corpus_ids, 'corpus_ids');
  // Corpora are dynamic (connector-store corpora are declared via env), so the
  // parser only checks the id shape; the router fails closed on unknown ids
  // (not_requested / no_adapter skips), which is the real gate.
  if (corpusId !== undefined && !/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/i.test(corpusId)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'corpus_id must be a dotted corpus identifier when provided.');
  }
  if (corpusIds !== undefined) {
    for (const [index, id] of corpusIds.entries()) {
      if (!/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/i.test(id)) {
        throw new EmailSourceWorkerError(400, 'invalid_request', `corpus_ids.${index} must be a dotted corpus identifier.`);
      }
    }
  }
  const approvedScopeKey = asOptionalString(record.approved_scope_key);
  const chatScope = asOptionalString(record.chat_scope)
    ?? asOptionalString(record.chat_title)
    ?? asOptionalString(record.chat_title_hint);
  const conversationId = asOptionalString(record.conversation_id);
  const senderId = asOptionalString(record.sender_id);
  const senderLabel = asOptionalString(record.sender_label);
  const authoredAfter = asOptionalString(record.authored_after);
  const authoredBefore = asOptionalString(record.authored_before);
  try {
    normalizeConnectorStoreSearchFilters({
      ...(conversationId ? { conversationId } : {}),
      ...(senderId ? { senderId } : {}),
      ...(senderLabel ? { senderLabel } : {}),
      ...(authoredAfter ? { authoredAfter } : {}),
      ...(authoredBefore ? { authoredBefore } : {}),
    });
  } catch (error) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      error instanceof Error ? error.message : 'Connector-store metadata filters are invalid.',
    );
  }
  const selectedItems = asOptionalSourceAnswerSelectedItems(record.selected_items);
  const retrievalMode = asOptionalRetrievalMode(record.retrieval_mode);
  const analystProvider = asOptionalSourceAnswerAnalystProvider(record.analyst_provider);
  const analystModel = asOptionalAnalystModel(record.analyst_model, analystProvider);
  const maxResults = asOptionalNumber(record.max_results);
  const includeSecureLocal = asOptionalBoolean(record.include_secure_local);
  const includeSecureLocalContent = asOptionalBoolean(record.include_secure_local_content);
  const includeInternal = asOptionalBoolean(record.include_internal);
  const includeInternalContent = asOptionalBoolean(record.include_internal_content);
  const internalContentMaxBytes = asOptionalNumber(record.internal_content_max_bytes);
  const timeoutMs = asOptionalNumber(record.timeout_ms ?? record.timeoutMs);
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'timeout_ms must be a positive number when provided.');
  }
  const caller = parseRequestCaller(record, request);
  return {
    question: record.question,
    ...(query !== undefined ? { query } : {}),
    ...(account !== undefined ? { account } : {}),
    ...(corpusId !== undefined ? { corpus_id: corpusId } : {}),
    ...(corpusIds !== undefined ? { corpus_ids: corpusIds } : {}),
    ...(approvedScopeKey !== undefined ? { approved_scope_key: approvedScopeKey } : {}),
    ...(chatScope !== undefined ? { chat_scope: chatScope } : {}),
    ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
    ...(senderId !== undefined ? { sender_id: senderId } : {}),
    ...(senderLabel !== undefined ? { sender_label: senderLabel } : {}),
    ...(authoredAfter !== undefined ? { authored_after: authoredAfter } : {}),
    ...(authoredBefore !== undefined ? { authored_before: authoredBefore } : {}),
    ...(selectedItems !== undefined ? { selected_items: selectedItems } : {}),
    ...(retrievalMode !== undefined ? { retrieval_mode: retrievalMode } : {}),
    ...(analystProvider !== undefined ? { analyst_provider: analystProvider } : {}),
    ...(analystModel !== undefined ? { analyst_model: analystModel } : {}),
    ...(maxResults !== undefined ? { max_results: maxResults } : {}),
    ...(includeSecureLocal !== undefined ? { include_secure_local: includeSecureLocal } : {}),
    ...(includeSecureLocalContent !== undefined ? { include_secure_local_content: includeSecureLocalContent } : {}),
    ...(includeInternal !== undefined ? { include_internal: includeInternal } : {}),
    ...(includeInternalContent !== undefined ? { include_internal_content: includeInternalContent } : {}),
    ...(internalContentMaxBytes !== undefined ? { internal_content_max_bytes: internalContentMaxBytes } : {}),
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    ...(caller ? { caller } : {}),
  };
}

export async function parseSourceIndexStatusRequest(
  request: Request,
  connectorStores: readonly LocalConnectorStore[] = [],
): Promise<SourceIndexStatusRequest> {
  const record = request.method === 'GET'
    ? recordFromSearchParams(new URL(request.url).searchParams)
    : await parseObjectBody(request);
  // Resolved before validation so a documented alias is measured against the
  // allow-list as its canonical id. GET and POST share this parser, so both
  // variants are covered. The layer below (source-index/status.ts) canonicalises
  // too; this is what lets a request reach it.
  const corpusId = canonicalRequestCorpusId(record);
  const allowedCorpusIds = sourceIndexStatusCorpusIds(connectorStores);
  if (corpusId !== undefined && !allowedCorpusIds.includes(corpusId)) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      `corpus_id must be one of: ${allowedCorpusIds.join(', ')} when provided (a documented input alias of one of those ids is also accepted).`,
    );
  }
  const account = asOptionalString(record.account);
  const approvedScopeKey = asOptionalString(record.approved_scope_key);
  const chatScope = asOptionalString(record.chat_scope)
    ?? asOptionalString(record.chat_title)
    ?? asOptionalString(record.chat_title_hint);
  const conversationId = asOptionalString(record.conversation_id);
  const includeSenderAggregation = asOptionalBoolean(record.include_sender_aggregation);
  const maxSenders = asOptionalNumber(record.max_senders);
  if (maxSenders !== undefined && (!Number.isInteger(maxSenders) || maxSenders < 1 || maxSenders > 100)) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'max_senders must be an integer from 1 to 100 when provided.',
    );
  }
  if (includeSenderAggregation === true && (!corpusId || !account || !conversationId)) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'include_sender_aggregation requires corpus_id, account, and conversation_id.',
    );
  }
  const includePrefixes = asOptionalStringArray(record.include_path_prefixes, 'include_path_prefixes');
  const excludePrefixes = asOptionalStringArray(record.exclude_path_prefixes, 'exclude_path_prefixes');
  const extractorKind = asOptionalString(record.extractor_kind);
  const extractorVersion = asOptionalString(record.extractor_version);
  const mimeTypes = asOptionalStringArray(record.mime_types, 'mime_types');
  const mimeTypePrefixes = asOptionalStringArray(record.mime_type_prefixes, 'mime_type_prefixes');
  const fileExtensions = asOptionalStringArray(record.file_extensions, 'file_extensions');
  const requiredArtifactKind = asOptionalString(record.required_artifact_kind);
  const requiredArtifactWarning = asOptionalString(record.required_artifact_warning);
  const qaVerdicts = asOptionalStringArray(record.qa_verdicts, 'qa_verdicts');
  const sourceExtractorKinds = asOptionalStringArray(record.source_extractor_kinds, 'source_extractor_kinds');
  const sourceJobStatuses = asOptionalStringArray(record.source_job_statuses, 'source_job_statuses');
  const includeReadinessLedger = asOptionalBoolean(record.include_readiness_ledger);
  const includeIngestionLedger = asOptionalBoolean(record.include_ingestion_ledger);
  const includeItems = asOptionalBoolean(record.include_items);
  const maxItems = asOptionalNumber(record.max_items);
  const query = asOptionalString(record.query);
  const result: SourceIndexStatusRequest = {};
  if (account !== undefined) result.account = account;
  if (approvedScopeKey !== undefined) result.approved_scope_key = approvedScopeKey;
  if (chatScope !== undefined) result.chat_scope = chatScope;
  if (conversationId !== undefined) result.conversation_id = conversationId;
  if (includeSenderAggregation !== undefined) result.include_sender_aggregation = includeSenderAggregation;
  if (maxSenders !== undefined) result.max_senders = maxSenders;
  if (includePrefixes !== undefined) result.include_path_prefixes = includePrefixes;
  if (excludePrefixes !== undefined) result.exclude_path_prefixes = excludePrefixes;
  if (extractorKind !== undefined) result.extractor_kind = extractorKind;
  if (extractorVersion !== undefined) result.extractor_version = extractorVersion;
  if (mimeTypes !== undefined) result.mime_types = mimeTypes;
  if (mimeTypePrefixes !== undefined) result.mime_type_prefixes = mimeTypePrefixes;
  if (fileExtensions !== undefined) result.file_extensions = fileExtensions;
  if (requiredArtifactKind !== undefined) result.required_artifact_kind = requiredArtifactKind;
  if (requiredArtifactWarning !== undefined) result.required_artifact_warning = requiredArtifactWarning;
  if (qaVerdicts !== undefined) result.qa_verdicts = qaVerdicts;
  if (sourceExtractorKinds !== undefined) result.source_extractor_kinds = sourceExtractorKinds;
  if (sourceJobStatuses !== undefined) result.source_job_statuses = sourceJobStatuses;
  if (corpusId !== undefined) result.corpus_id = corpusId;
  if (includeReadinessLedger !== undefined) result.include_readiness_ledger = includeReadinessLedger;
  if (includeIngestionLedger !== undefined) result.include_ingestion_ledger = includeIngestionLedger;
  if (includeItems !== undefined) result.include_items = includeItems;
  if (maxItems !== undefined) result.max_items = maxItems;
  if (query !== undefined) result.query = query;
  return result;
}

export function sourceIndexSearchCorpusIds(connectorStores: readonly LocalConnectorStore[]): string[] {
  return [
    DROPBOX_FILES_CORPUS_ID,
    X_BOOKMARKS_CORPUS_ID,
    INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
    ...connectorStores.map((store) => store.corpusId),
  ];
}

function sourceIndexStatusCorpusIds(connectorStores: readonly LocalConnectorStore[]): string[] {
  return [
    'secure_local.email.private',
    'internal.email',
    'internal.drive.docs',
    'secure_local.drive.docs',
    INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    READWISE_LIBRARY_CORPUS_ID,
    X_BOOKMARKS_CORPUS_ID,
    DROPBOX_FILES_CORPUS_ID,
    PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
    ...connectorStores.map((store) => store.corpusId),
  ];
}

function asOptionalSourceAnswerSelectedItems(value: unknown): SourceAnswerSelectedItem[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'selected_items must be an array.');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new EmailSourceWorkerError(400, 'invalid_request', `selected_items.${index} must be an object.`);
    }
    const initialRecord = item as Record<string, unknown>;
    const forbiddenPath = selectedItemContentFieldPath(initialRecord);
    if (forbiddenPath) {
      throw new EmailSourceWorkerError(400, 'invalid_request', `selected_items.${index} must not include source content field ${forbiddenPath}.`);
    }
    const selectedItem = initialRecord.selected_item;
    const record = selectedItem && typeof selectedItem === 'object' && !Array.isArray(selectedItem)
      ? selectedItem as Record<string, unknown>
      : initialRecord;
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

export function addSelectedItemToSearchHit<T extends { sourceItem: {
  family: string;
  provider: string;
  accountScope: string;
  providerItemId: string;
  localItemId: string;
  providerThreadId?: string;
  providerConversationId?: string;
  providerFileId?: string;
  sourceVersion?: string;
}; provenance?: { citation?: {
  title?: string;
  conversationLabel?: string;
  authorLabel?: string;
  uri?: string;
  authoredAt?: string;
  updatedAt?: string;
} } }>(corpusId: string, hit: T): T & { selected_item: SourceAnswerSelectedItem } {
  const citation = hit.provenance?.citation;
  return {
    ...hit,
    selected_item: {
      corpus_id: corpusId,
      family: hit.sourceItem.family,
      provider: hit.sourceItem.provider,
      account_scope: hit.sourceItem.accountScope,
      provider_item_id: hit.sourceItem.providerItemId,
      local_item_id: hit.sourceItem.localItemId,
      ...(hit.sourceItem.providerThreadId ? { provider_thread_id: hit.sourceItem.providerThreadId } : {}),
      ...(hit.sourceItem.providerConversationId ? { provider_conversation_id: hit.sourceItem.providerConversationId } : {}),
      ...(hit.sourceItem.providerFileId ? { provider_file_id: hit.sourceItem.providerFileId } : {}),
      ...(hit.sourceItem.sourceVersion ? { source_version: hit.sourceItem.sourceVersion } : {}),
      ...(citation?.title ? { title: citation.title } : {}),
      ...(citation?.conversationLabel ? { conversation_label: citation.conversationLabel } : {}),
      ...(citation?.authorLabel ? { author_label: citation.authorLabel } : {}),
      ...(citation?.uri ? { uri: citation.uri } : {}),
      ...(citation?.authoredAt ? { authored_at: citation.authoredAt } : {}),
      ...(citation?.updatedAt ? { updated_at: citation.updatedAt } : {}),
    },
  };
}

function requiredSelectedItemString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `${name} must be a non-empty safe identifier string.`);
  }
  return value.trim();
}

function optionalSelectedItemString(value: unknown, key: keyof SourceAnswerSelectedItem): Partial<SourceAnswerSelectedItem> {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string' || value.length > 1_000) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `selected_items.${key} must be a safe string.`);
  }
  return { [key]: value.trim() };
}

export function asOptionalRetrievalMode(value: unknown): 'keyword' | 'hybrid' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'keyword' || value === 'hybrid') return value;
  throw new EmailSourceWorkerError(400, 'invalid_request', 'retrieval_mode must be keyword or hybrid.');
}

function asOptionalSourceAnswerAnalystProvider(value: unknown): 'default' | 'local' | 'venice' | 'cloud' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'default' || value === 'local' || value === 'venice' || value === 'cloud') return value;
  throw new EmailSourceWorkerError(400, 'invalid_request', 'analyst_provider must be default, local, venice, or cloud.');
}

function asOptionalAnalystModel(
  value: unknown,
  analystProvider?: 'default' | 'local' | 'venice' | 'cloud',
): string | undefined {
  const model = asOptionalString(value)?.trim();
  if (model === undefined) return undefined;
  const normalized = analystProvider === 'venice' || analystProvider === undefined
    ? normalizeVeniceAnalystModelId(model)
    : model;
  if (normalized.length > 160 || !/^[A-Za-z0-9._:/@+-]+$/.test(normalized)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'analyst_model must be a provider model id using safe identifier characters.');
  }
  return normalized;
}

export function mostPrivateTrustDomain(domains: readonly SourceTrustDomain[]): SourceTrustDomain {
  if (domains.includes('secure_local')) return 'secure_local';
  if (domains.includes('internal')) return 'internal';
  return 'public_safe';
}

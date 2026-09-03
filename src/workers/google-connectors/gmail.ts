import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import {
  sourceInvocationProvenance,
  type SourceInvocationProvenance,
} from '../../core/invocation-provenance.ts';
import type { SensitivityMap } from '../../core/sensitivity-map.ts';
import type { SourceSensitivity } from '../../core/source-index/types.ts';
import {
  createEnvCredentialBroker,
  requireBearerTokenCredentialSession,
  type CredentialBroker,
  type CredentialBrokerFetch,
} from '../credential-broker/index.ts';
import type { ConnectorStoreClassificationOptions } from '../connector-store/index.ts';
import {
  classifyEmailIngestSkip,
  parseEmailIngestFilterOptionsFromEnv,
  type EmailIngestFilterOptions,
} from '../email-source/ingest-filter.ts';
import {
  accountFromGoogleHandle,
  classifyGoogleItemRaiseOnly,
  loadGoogleSensitivityMap,
  metadataString,
  metadataStringArray,
  type GoogleItemClassifier,
} from './classification.ts';
import {
  GoogleDailyRequestBudget,
  GoogleRequestBudgetError,
  type GoogleRequestBudgetStatus,
} from './request-budget.ts';

export const GMAIL_INTERNAL_CONNECTOR_CORPUS_ID = 'internal.email';
export const GMAIL_SECURE_CONNECTOR_CORPUS_ID = 'secure_local.email.private';
export const GMAIL_CONNECTOR_CORPUS_ID = GMAIL_INTERNAL_CONNECTOR_CORPUS_ID;
export const GMAIL_PROVIDER = 'gmail';
export const DEFAULT_GMAIL_SYNC_MAX_MESSAGES = 200;
export const GMAIL_DAILY_REQUEST_BUDGET_ENV =
  'OLYMPUS_SOURCE_INDEX_GMAIL_DAILY_API_REQUEST_BUDGET';
export const GMAIL_DAILY_REQUEST_BUDGET_STATE_PATH_ENV =
  'OLYMPUS_SOURCE_INDEX_GMAIL_DAILY_API_REQUEST_BUDGET_STATE_PATH';
// Gmail costs one list request per 100-id page plus one get per message, so a
// day's budget is spent overwhelmingly on gets. 5,000/day is the host default:
// wide enough for the head to keep up, narrow enough that a runaway loop parks
// instead of burning the project's whole provider quota.
export const DEFAULT_GMAIL_DAILY_REQUEST_BUDGET = 5_000;
const DEFAULT_GMAIL_PAGE_SIZE = 100;
const MAX_GMAIL_SYNC_MESSAGES = 1_000;
const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com/gmail/v1';
const GMAIL_CURSOR_PREFIX = 'gm1:';
const MAX_GMAIL_CURSOR_LENGTH = 4_096;
const DEFAULT_GMAIL_MAX_RETRIES = 3;
const MAX_GMAIL_RETRY_DELAY_MS = 30_000;

export interface GoogleGmailSourceConnectorOptions {
  credentialBroker?: CredentialBroker;
  credentialHandle?: string;
  account?: string;
  fetch?: CredentialBrokerFetch;
  apiBaseUrl?: string;
  maxMessages?: number;
  query?: string;
  sensitivityMap?: SensitivityMap;
  classifier?: GoogleItemClassifier;
  apiClient?: GmailApiClient;
  /**
   * The runtime's single day counter. Optional only so owner-facing one-shot
   * surfaces and tests can build a connector without one; the runtime
   * construction seam always supplies it, so one process can never quietly run
   * two independent counters against the same Gmail quota.
   */
  requestBudget?: GoogleDailyRequestBudget;
  /**
   * Who initiated the run this connector serves. Operator runs are exempt from
   * the daily request budget (owner ruling 2026-08-19); anything but the exact
   * literal 'operator' fails closed to 'scheduled'. Per connector, never per
   * handler: a connector is built for one run, so the exemption cannot outlive
   * the run that earned it.
   */
  provenance?: SourceInvocationProvenance;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
  ingestFilterOptions?: EmailIngestFilterOptions;
}

/**
 * Opaque, validated resume point for one bounded Gmail traversal.
 *
 * `watermarkMs` is the internalDate lower bound the traversal runs under and
 * never moves while it is in flight — advancing it mid-traversal would skip
 * every message the remaining pages still owe. `highWaterMs` accumulates the
 * newest internalDate seen and is promoted to the next traversal's watermark
 * only on a page that actually completed the traversal. `pageToken` is present
 * exactly when the run stopped mid-traversal, which is also how a reader tells
 * "resume this slice" from "start the next incremental pass".
 */
interface GmailCursor {
  watermarkMs?: number;
  highWaterMs?: number;
  pageToken?: string;
}

export interface GmailSourceConnectorTraversalStatus {
  /** Provider requests this traversal spent: one list per page, one get per id. */
  providerRequests: number;
  /** Messages served from the in-run cache instead of a second messages.get. */
  fetchItemCacheHits: number;
  /** Filename-bearing MIME parts declared by Gmail. */
  attachmentsDeclared: number;
  /** Sum of provider-declared attachment sizes; no attachment bytes are fetched. */
  attachmentBytesDeclared: number;
  /** Declared attachments deliberately left as an honest extraction gap. */
  attachmentsNotIngested: number;
  itemsSkippedOtp: number;
  itemsSkippedCategory: number;
}

export interface GmailApiClient {
  listMessages(request: GmailListMessagesRequest): Promise<GmailListMessagesResponse>;
  getMessage(id: string): Promise<GmailMessage>;
}

export interface GmailListMessagesRequest {
  maxResults: number;
  pageToken?: string;
  query?: string;
}

export interface GmailListMessagesResponse {
  messages: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePart[];
}

export class GoogleGmailSourceConnector implements SourceConnector {
  readonly id = GMAIL_PROVIDER;
  readonly family = 'email' as const;
  private readonly credentialBroker: CredentialBroker;
  private readonly credentialHandle: string;
  private readonly account: string;
  private readonly fetchImpl: CredentialBrokerFetch;
  private readonly apiBaseUrl: string;
  private readonly defaultMaxMessages: number;
  private readonly query: string | undefined;
  private readonly sensitivityMap: SensitivityMap | undefined;
  private readonly classifier: GoogleItemClassifier | undefined;
  private readonly requestBudget: GoogleDailyRequestBudget | undefined;
  private readonly provenance: SourceInvocationProvenance;
  private readonly maxRetries: number | undefined;
  private readonly sleepImpl: ((ms: number) => Promise<void>) | undefined;
  private readonly injectedClient: GmailApiClient | undefined;
  private client: GmailApiClient | undefined;
  private providerRequests = 0;
  private fetchItemCacheHits = 0;
  private attachmentsDeclared = 0;
  private attachmentBytesDeclared = 0;
  private attachmentsNotIngested = 0;
  private itemsSkippedOtp = 0;
  private itemsSkippedCategory = 0;
  private readonly ingestFilterOptions: EmailIngestFilterOptions;
  private readonly itemsByLocalId = new Map<string, RawItem>();

  constructor(options: GoogleGmailSourceConnectorOptions = {}) {
    const env = options.env ?? process.env;
    this.fetchImpl = options.fetch ?? fetch;
    this.credentialBroker = options.credentialBroker ?? createEnvCredentialBroker({
      env,
      fetch: this.fetchImpl,
    });
    this.credentialHandle = options.credentialHandle?.trim()
      || env.OLYMPUS_SOURCE_INDEX_GMAIL_CREDENTIAL_HANDLE?.trim()
      || 'gmail.personal';
    this.account = options.account?.trim() || accountFromGoogleHandle(this.credentialHandle);
    this.apiBaseUrl = options.apiBaseUrl?.replace(/\/+$/, '') || GMAIL_API_BASE_URL;
    this.defaultMaxMessages = normalizeGmailMaxMessages(options.maxMessages);
    this.query = options.query?.trim() || env.OLYMPUS_SOURCE_INDEX_GMAIL_QUERY?.trim() || undefined;
    this.sensitivityMap = options.sensitivityMap ?? loadGoogleSensitivityMap(env);
    this.classifier = options.classifier;
    this.requestBudget = options.requestBudget;
    this.provenance = sourceInvocationProvenance(options.provenance);
    this.maxRetries = options.maxRetries;
    this.sleepImpl = options.sleep;
    this.injectedClient = options.apiClient;
    this.ingestFilterOptions = options.ingestFilterOptions ?? parseEmailIngestFilterOptionsFromEnv(env);
  }

  async authenticate(): Promise<void> {
    await this.clientForRequest();
  }

  async *listItems(options: SourceConnectorListOptions = {}): AsyncIterable<SourceConnectorListPage> {
    const client = await this.clientForRequest();
    let remaining = normalizeGmailMaxMessages(options.limit ?? this.defaultMaxMessages);
    const resume = decodeGmailCursor(options.cursor);
    const watermarkMs = resume.watermarkMs;
    const query = this.queryForWatermark(watermarkMs);
    let highWaterMs = resume.highWaterMs;
    let pageToken = resume.pageToken;
    const requestedPageTokens = new Set<string>();
    while (remaining > 0) {
      if (pageToken) assertNewProviderPage(requestedPageTokens, pageToken);
      this.providerRequests += 1;
      const page = await client.listMessages({
        maxResults: Math.min(DEFAULT_GMAIL_PAGE_SIZE, remaining),
        ...(pageToken ? { pageToken } : {}),
        ...(query ? { query } : {}),
      });
      const listed = page.messages.filter((message) => message.id);
      const items: RawItem[] = [];
      let messagesExamined = 0;
      for (const message of listed) {
        if (messagesExamined >= remaining) break;
        messagesExamined += 1;
        this.providerRequests += 1;
        const item = rawItemFromGmailMessage(await client.getMessage(message.id), this.account);
        this.attachmentsDeclared += metadataCount(item.metadata, 'attachmentCount');
        this.attachmentBytesDeclared += metadataCount(item.metadata, 'attachmentBytesDeclared');
        this.attachmentsNotIngested += metadataCount(item.metadata, 'attachmentsNotIngested');
        const internalDateMs = internalDateNumber(item.metadata);
        if (internalDateMs !== undefined && (highWaterMs === undefined || internalDateMs > highWaterMs)) {
          highWaterMs = internalDateMs;
        }
        const subject = metadataString(item.metadata, 'subject') ?? metadataString(item.metadata, 'title');
        const from = metadataString(item.metadata, 'from');
        const body = item.content.kind === 'text' ? item.content.text : metadataString(item.metadata, 'snippet');
        const skip = classifyEmailIngestSkip({
          ...(subject !== undefined ? { subject } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(body !== undefined ? { body } : {}),
          labels: metadataStringArray(item.metadata, 'labels'),
        }, this.ingestFilterOptions);
        if (skip) {
          if (skip === 'otp') this.itemsSkippedOtp += 1;
          else this.itemsSkippedCategory += 1;
          continue;
        }
        // Populated on the way past so fetchItem is a cache read. The shipped
        // connector re-fetched every metadata_only item, doubling messages.get
        // inside a bounded slice.
        this.itemsByLocalId.set(item.identity.localItemId, item);
        items.push(item);
      }
      remaining -= messagesExamined;
      pageToken = page.nextPageToken;
      // The traversal is complete only when the provider has no further page
      // AND the bound did not truncate this one. The shipped connector called
      // every bounded slice done, which told the spine that a partial window
      // was a full traversal.
      const pageTruncated = messagesExamined < listed.length;
      const done = !pageToken && !pageTruncated;
      const promoted = highWaterMs ?? watermarkMs;
      const nextCursor = done
        // A completed traversal hands forward only the promoted watermark, so
        // the next run asks Gmail for new mail instead of for the mailbox.
        ? encodeGmailCursor(promoted !== undefined ? { watermarkMs: promoted } : {})
        : encodeGmailCursor({
          ...(watermarkMs !== undefined ? { watermarkMs } : {}),
          ...(highWaterMs !== undefined ? { highWaterMs } : {}),
          ...(pageToken ? { pageToken } : {}),
        });
      yield {
        items,
        ...(nextCursor ? { nextCursor } : {}),
        done,
      };
      if (done || !pageToken || items.length === 0) break;
    }
  }

  /**
   * In-run cache, never a second provider round trip. Listing already fetched
   * the full message for every id it emitted, so asking Gmail again is pure
   * duplicate quota — and the spine calls fetchItem for every item that listed
   * as metadata_only.
   */
  async fetchItem(localItemId: string): Promise<RawItem> {
    const item = this.itemsByLocalId.get(localItemId)
      ?? this.itemsByLocalId.get(`${this.account}:${localItemId}`);
    if (!item) {
      throw new Error(
        `Gmail connector cannot fetch unknown item ${hashString(localItemId).slice(0, 16)}.`,
      );
    }
    this.fetchItemCacheHits += 1;
    return item;
  }

  traversalStatus(): GmailSourceConnectorTraversalStatus {
    return {
      providerRequests: this.providerRequests,
      fetchItemCacheHits: this.fetchItemCacheHits,
      attachmentsDeclared: this.attachmentsDeclared,
      attachmentBytesDeclared: this.attachmentBytesDeclared,
      attachmentsNotIngested: this.attachmentsNotIngested,
      itemsSkippedOtp: this.itemsSkippedOtp,
      itemsSkippedCategory: this.itemsSkippedCategory,
    };
  }

  requestBudgetStatus(): GoogleRequestBudgetStatus | undefined {
    return this.requestBudget?.status();
  }

  classify(item: RawItem): SourceSensitivity {
    const subject = metadataString(item.metadata, 'subject') ?? metadataString(item.metadata, 'title');
    const sender = metadataString(item.metadata, 'from');
    return classifyGoogleItemRaiseOnly({
      labels: metadataStringArray(item.metadata, 'labels'),
      text: item.content.kind === 'text' ? item.content.text : metadataString(item.metadata, 'snippet') ?? '',
      ...(subject ? { subject } : {}),
      ...(sender ? { sender } : {}),
    }, {
      defaultTrustTier: 'S3',
      defaultTrustDomain: 'internal',
      ...(this.sensitivityMap ? { sensitivityMap: this.sensitivityMap } : {}),
      ...(this.classifier ? { classifier: this.classifier } : {}),
    });
  }

  private async clientForRequest(): Promise<GmailApiClient> {
    if (this.client) return this.client;
    if (this.injectedClient) {
      // An injected client owns no retry transport, so each method invocation
      // is exactly one provider attempt and the wrapper remains exact.
      this.client = this.requestBudget
        ? budgetedGmailApiClient(this.injectedClient, this.requestBudget, this.provenance)
        : this.injectedClient;
      return this.client;
    }
    // The REST transport owns the retry loop, so it also owns accounting.
    this.client = await this.restClient();
    return this.client;
  }

  private async restClient(): Promise<GmailApiClient> {
    const session = requireBearerTokenCredentialSession(await this.credentialBroker.issueSession({
      handle: this.credentialHandle,
      provider: GMAIL_PROVIDER,
      capability: 'gmail.email.sync',
      trustDomain: 'secure_local',
    }), this.credentialHandle);
    return new RestGmailApiClient({
      token: session.token,
      fetch: this.fetchImpl,
      baseUrl: this.apiBaseUrl,
      ...(this.requestBudget ? { requestBudget: this.requestBudget } : {}),
      provenance: this.provenance,
      ...(this.maxRetries !== undefined ? { maxRetries: this.maxRetries } : {}),
      ...(this.sleepImpl ? { sleep: this.sleepImpl } : {}),
    });
  }

  /**
   * The provider bound for this traversal. Gmail's `after:` operator takes
   * whole epoch seconds, so the watermark is floored — a boundary message may
   * be re-listed on the next pass, which the spine absorbs as an idempotent
   * upsert. Losing it would not be absorbable, so the rounding goes this way
   * deliberately.
   */
  private queryForWatermark(watermarkMs: number | undefined): string | undefined {
    if (watermarkMs === undefined) return this.query;
    const after = `after:${Math.floor(watermarkMs / 1_000)}`;
    return this.query ? `${after} (${this.query})` : after;
  }
}

export function gmailConnectorStoreClassification(
  sensitivityMap: SensitivityMap | undefined,
): ConnectorStoreClassificationOptions {
  return {
    baselineTrustTier: 'S3',
    baselineTrustDomain: 'internal',
    ...(sensitivityMap ? { sensitivityMap } : {}),
  };
}

/**
 * Cheap local validation of a resume cursor. A checkpoint carried across days
 * or store generations must be provable before it is spent on provider I/O; an
 * unparseable one falls back to a fresh traversal instead of failing a run.
 * It is also how the pull handler tells a head checkpoint from the legacy
 * replay's: both lanes write the same store column.
 */
export function isGmailConnectorCursor(value: string | undefined): boolean {
  if (!value) return false;
  try {
    decodeGmailCursor(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the cursor is a mid-traversal resume point rather than a completed
 * traversal's watermark. The spine stores both in the same column, so this is
 * how a receipt tells "the slice has more to fetch" from "this pass finished".
 */
export function gmailCursorIsMidTraversal(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return decodeGmailCursor(value).pageToken !== undefined;
  } catch {
    return false;
  }
}

export function createGmailDailyRequestBudget(options: {
  env?: Record<string, string | undefined>;
  statePath?: string;
  now?: () => Date;
} = {}): GoogleDailyRequestBudget {
  const env = options.env ?? process.env;
  return new GoogleDailyRequestBudget({
    provider: 'Gmail',
    dailyRequestBudget: gmailDailyRequestBudgetFromEnv(env),
    statePath: options.statePath?.trim() || defaultGmailRequestBudgetStatePath(env),
    ...(options.now ? { now: options.now } : {}),
  });
}

export function gmailDailyRequestBudgetFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env[GMAIL_DAILY_REQUEST_BUDGET_ENV];
  const parsed = value?.trim() ? Number(value) : DEFAULT_GMAIL_DAILY_REQUEST_BUDGET;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${GMAIL_DAILY_REQUEST_BUDGET_ENV} must be a positive integer.`);
  }
  return parsed;
}

export function defaultGmailRequestBudgetStatePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env[GMAIL_DAILY_REQUEST_BUDGET_STATE_PATH_ENV]?.trim();
  if (configured) return configured;
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'gmail-daily-request-budget.json');
}

function budgetedGmailApiClient(
  inner: GmailApiClient,
  budget: GoogleDailyRequestBudget,
  // Bound at wrap time, from the connector that owns one run. A budget shared
  // by the whole process cannot hold this: it would leak one run's exemption
  // into whatever ran next.
  provenance: SourceInvocationProvenance,
): GmailApiClient {
  return {
    listMessages(request) {
      budget.reserve(provenance);
      return inner.listMessages(request);
    },
    getMessage(id) {
      budget.reserve(provenance);
      return inner.getMessage(id);
    },
  };
}

function encodeGmailCursor(cursor: GmailCursor): string | undefined {
  if (cursor.watermarkMs === undefined && cursor.highWaterMs === undefined && !cursor.pageToken) {
    return undefined;
  }
  return `${GMAIL_CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
}

function decodeGmailCursor(value: string | undefined): GmailCursor {
  if (!value) return {};
  if (value.length > MAX_GMAIL_CURSOR_LENGTH || !value.startsWith(GMAIL_CURSOR_PREFIX)) {
    throw new TypeError('Gmail connector cursor is invalid.');
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(GMAIL_CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    ) as { watermarkMs?: unknown; highWaterMs?: unknown; pageToken?: unknown };
    const watermarkMs = decodeCursorEpochMs(parsed.watermarkMs);
    const highWaterMs = decodeCursorEpochMs(parsed.highWaterMs);
    if (
      parsed.pageToken !== undefined
      && (
        typeof parsed.pageToken !== 'string'
        || !parsed.pageToken.trim()
        || parsed.pageToken.length > MAX_GMAIL_CURSOR_LENGTH
      )
    ) {
      throw new Error('invalid');
    }
    return {
      ...(watermarkMs !== undefined ? { watermarkMs } : {}),
      ...(highWaterMs !== undefined ? { highWaterMs } : {}),
      ...(typeof parsed.pageToken === 'string' ? { pageToken: parsed.pageToken.trim() } : {}),
    };
  } catch {
    throw new TypeError('Gmail connector cursor is invalid.');
  }
}

function decodeCursorEpochMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid');
  }
  return value;
}

function assertNewProviderPage(seen: Set<string>, pageToken: string): void {
  if (seen.has(pageToken)) throw new Error('Gmail connector pagination cursor repeated.');
  seen.add(pageToken);
}

function internalDateNumber(metadata: Readonly<Record<string, unknown>>): number | undefined {
  const value = metadata['internalDate'];
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function defaultGmailConnectorStoreDbPath(env: Record<string, string | undefined> = process.env): string {
  if (env.OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_DB_PATH?.trim()) {
    return env.OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_DB_PATH.trim();
  }
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'gmail-connector-store.sqlite');
}

export function defaultGmailSecureConnectorStoreDbPath(env: Record<string, string | undefined> = process.env): string {
  if (env.OLYMPUS_SOURCE_INDEX_GMAIL_SECURE_CONNECTOR_STORE_DB_PATH?.trim()) {
    return env.OLYMPUS_SOURCE_INDEX_GMAIL_SECURE_CONNECTOR_STORE_DB_PATH.trim();
  }
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'gmail-secure-connector-store.sqlite');
}

class RestGmailApiClient implements GmailApiClient {
  private readonly token: string;
  private readonly fetchImpl: CredentialBrokerFetch;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly requestBudget: GoogleDailyRequestBudget | undefined;
  private readonly provenance: SourceInvocationProvenance;

  constructor(options: {
    token: string;
    fetch: CredentialBrokerFetch;
    baseUrl: string;
    requestBudget?: GoogleDailyRequestBudget;
    provenance?: SourceInvocationProvenance;
    maxRetries?: number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.token = options.token;
    this.fetchImpl = options.fetch;
    this.baseUrl = options.baseUrl;
    this.requestBudget = options.requestBudget;
    this.provenance = sourceInvocationProvenance(options.provenance);
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_GMAIL_MAX_RETRIES));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async listMessages(request: GmailListMessagesRequest): Promise<GmailListMessagesResponse> {
    const params = new URLSearchParams({
      maxResults: String(request.maxResults),
      includeSpamTrash: 'false',
    });
    if (request.pageToken) params.set('pageToken', request.pageToken);
    if (request.query) params.set('q', request.query);
    const json = await this.getJson(`users/me/messages?${params.toString()}`);
    const record = asRecord(json, 'Gmail messages list response');
    return {
      messages: Array.isArray(record.messages)
        ? record.messages.map((item) => asRecord(item, 'Gmail message list item')).map((item) => ({
            id: stringValue(item.id),
            threadId: stringValue(item.threadId),
          })).filter((item) => item.id)
        : [],
      ...optionalStringProp(record, 'nextPageToken'),
    };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    const params = new URLSearchParams({ format: 'full' });
    const json = await this.getJson(`users/me/messages/${encodeURIComponent(id)}?${params.toString()}`);
    return json as GmailMessage;
  }

  /**
   * Retries the statuses Gmail uses to say "slow down" or "try again",
   * honoring Retry-After. Without this the first rate limit surfaced as a task
   * failure and the scheduler fail-looped the lane at its error backoff — the
   * exact shape the Readwise T3 guard was written to stop.
   */
  private async getJson(path: string): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      // The retry loop is the request boundary. Reserving here makes one
      // ledger increment correspond to one real provider request. Gmail's own
      // 429 is handled below and binds every provenance: the budget exemption
      // waives Olympus's line, never the provider's.
      this.requestBudget?.reserve(this.provenance);
      const response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
      });
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) as unknown : {};
      if (isRetryableGmailStatus(response.status) && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(gmailRetryDelayMs(response, attempt));
        continue;
      }
      throw new Error(`Gmail API request failed (${response.status}): ${safeProviderDetail(text)}`);
    }
  }
}

function isRetryableGmailStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function gmailRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_GMAIL_RETRY_DELAY_MS);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.max(0, Math.min(dateMs - Date.now(), MAX_GMAIL_RETRY_DELAY_MS));
    }
  }
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 5_000);
}

function rawItemFromGmailMessage(message: GmailMessage, account: string): RawItem {
  const headers = headersFromPart(message.payload);
  const subject = headers.get('subject') ?? '(no subject)';
  const from = headers.get('from') ?? '';
  const date = parsedDate(headers.get('date')) ?? internalDateIso(message.internalDate);
  const text = extractMessageText(message);
  const attachments = gmailAttachmentInventory(message.payload);
  const fetchedAt = new Date().toISOString();
  return {
    identity: {
      family: 'email',
      provider: 'gmail',
      accountScope: account,
      providerItemId: message.id,
      ...(message.threadId ? { providerThreadId: message.threadId } : {}),
      localItemId: `${account}:${message.id}`,
      ...(message.historyId ? { sourceVersion: message.historyId } : {}),
    },
    mimeType: 'message/rfc822',
    content: text.trim() ? { kind: 'text', text } : { kind: 'metadata_only' },
    metadata: Object.freeze({
      title: subject,
      subject,
      from,
      ...(date ? { authoredAt: date } : {}),
      // Carried verbatim: it is the traversal's incremental watermark, and
      // Gmail's `after:` operator speaks the same clock.
      ...(message.internalDate ? { internalDate: message.internalDate } : {}),
      ...(message.historyId ? { historyId: message.historyId } : {}),
      ...(message.snippet ? { snippet: message.snippet } : {}),
      labels: message.labelIds ?? [],
      attachmentCount: attachments.count,
      attachmentBytesDeclared: attachments.bytes,
      // This is an explicit product boundary, not a claim that an empty text
      // body means the message was fully covered.
      attachmentsNotIngested: attachments.count,
      locatorUri: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.id)}`,
      contentHash: hashString(`${message.historyId ?? ''}:${text}`),
    }),
    fetchedAt,
  };
}

function gmailAttachmentInventory(part: GmailMessagePart | undefined): { count: number; bytes: number } {
  if (!part) return { count: 0, bytes: 0 };
  const filenameBearing = Boolean(part.filename?.trim());
  let count = filenameBearing ? 1 : 0;
  let bytes = filenameBearing && Number.isSafeInteger(part.body?.size) && (part.body?.size ?? 0) >= 0
    ? part.body!.size!
    : 0;
  for (const child of part.parts ?? []) {
    const nested = gmailAttachmentInventory(child);
    count += nested.count;
    bytes += nested.bytes;
  }
  return { count, bytes };
}

function metadataCount(metadata: Readonly<Record<string, unknown>>, key: string): number {
  const value = metadata[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function extractMessageText(message: GmailMessage): string {
  const plain: string[] = [];
  const html: string[] = [];
  collectPartText(message.payload, plain, html);
  const selected = plain.length > 0 ? plain.join('\n\n') : html.map(stripHtml).join('\n\n');
  return [headersSummary(message.payload), message.snippet, selected]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

function collectPartText(part: GmailMessagePart | undefined, plain: string[], html: string[]): void {
  if (!part) return;
  // A filename-bearing MIME part is an attachment even when Gmail inlines its
  // bytes in `body.data`. Do not accidentally index a small text attachment
  // while receipts truthfully say attachment bytes are not ingested.
  //
  // The attachment is the WHOLE subtree, not just this node: a forwarded
  // message/rfc822 carries its own text/plain and text/html children. Descending
  // into them pushed the attachment's plain text into the message's own lane,
  // and extraction prefers plain over html — so the indexed text became the
  // attachment while the real body was dropped. This is the same subtree
  // gmailAttachmentInventory counts as one not-ingested attachment.
  if (part.filename?.trim()) return;
  const decoded = part.body?.data ? decodeBase64Url(part.body.data) : undefined;
  if (decoded && part.mimeType === 'text/plain') plain.push(decoded);
  if (decoded && part.mimeType === 'text/html') html.push(decoded);
  for (const child of part.parts ?? []) collectPartText(child, plain, html);
}

function headersFromPart(part: GmailMessagePart | undefined): Map<string, string> {
  const headers = new Map<string, string>();
  for (const header of part?.headers ?? []) {
    const name = header.name?.trim().toLowerCase();
    const value = header.value?.trim();
    if (name && value) headers.set(name, value);
  }
  return headers;
}

function headersSummary(part: GmailMessagePart | undefined): string {
  const headers = headersFromPart(part);
  return [
    headers.get('subject') ? `Subject: ${headers.get('subject')}` : undefined,
    headers.get('from') ? `From: ${headers.get('from')}` : undefined,
    headers.get('to') ? `To: ${headers.get('to')}` : undefined,
    headers.get('date') ? `Date: ${headers.get('date')}` : undefined,
  ].filter(Boolean).join('\n');
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsedDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function internalDateIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Number.parseInt(value, 10);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function normalizeGmailMaxMessages(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_GMAIL_SYNC_MAX_MESSAGES;
  return Math.max(1, Math.min(Math.floor(value), MAX_GMAIL_SYNC_MESSAGES));
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalStringProp(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = stringValue(record[key]).trim();
  return value ? { [key]: value } : {};
}

function safeProviderDetail(value: string): string {
  return value.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').slice(0, 500);
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

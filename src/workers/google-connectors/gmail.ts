import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  RawItem,
  SourceClassificationSignals,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import {
  sourceInvocationProvenance,
  type SourceInvocationProvenance,
} from '../../core/invocation-provenance.ts';
import type { SensitivityMap } from '../../core/sensitivity-map.ts';
import { gmailAfterBound, gmailBeforeBound } from '../../core/mail-source-scope.ts';
import { MAX_FROM_HEADER_CHARS, senderMatchesRule } from '../../core/sender-rules.ts';
import type { OwnerTierRule } from '../classification/tier-classifier.ts';
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
  metadataString,
  metadataStringArray,
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
/** List pages one run may walk: pages of already-held mail spend no gets. */
const MAX_GMAIL_LIST_PAGES_PER_RUN = 50;
/**
 * How far behind a scoped traversal's own start the next incremental bound
 * sits. Mail that arrives while a traversal is paging lands at the head the
 * traversal already passed; a day of margin re-lists it (idempotently) rather
 * than skipping it.
 */
const TRAVERSAL_START_MARGIN_MS = 86_400_000;
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
  /**
   * The owner-approved mail scope this traversal is bound to. Absent means the
   * legacy unscoped traversal (tests and one-shot tooling); the runtime lane
   * never constructs a connector without one.
   */
  scope?: GmailConnectorScope;
  /** Clock for traversal start and watermark caps (tests). */
  now?: () => number;
}

/**
 * An approved mail scope, compiled (src/core/mail-source-scope.ts). The
 * connector only ANDs it with the operator's hidden query override and splits
 * the first traversal at the full-content cutoff.
 */
export interface GmailConnectorScope {
  /** Every filter except the date bound; Gmail search syntax. */
  baseQuery?: string;
  /** Mail older than this is indexed metadata-only (no body, no snippet). */
  contentAfterMs?: number;
  /** Category label ids the scope skips, for the post-fetch ingest filter. */
  skippedCategoryLabelIds?: readonly string[];
  /** Label ids the scope skips; re-checked on every fetched message. */
  skippedLabelIds?: readonly string[];
  /** Skip-list senders; re-checked on every fetched message (domain rules cover subdomains). */
  skipSenders?: readonly string[];
  /**
   * The owner's "always Private" senders as owner tier rules (sender kind,
   * tier Private, force). The lane places matching mail only in the
   * secure_local store (private embeddings) and records the rule as the
   * ledger reason.
   */
  ownerTierRules?: readonly OwnerTierRule[];
  /**
   * Whether Olympus already holds this message (in either Gmail store). Held
   * mail is never re-observed under a scope; see listItems.
   */
  storedItem?: (providerItemId: string) => GmailStoredItem | undefined;
}

export interface GmailStoredItem {
  /** True when a stored copy has chunks (a body), false for a metadata-only row. */
  hasContent: boolean;
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
  /**
   * Present while a scoped first traversal walks the mail older than the
   * full-content cutoff. `highWaterMs` then carries the content leg's newest
   * internalDate, promoted to the watermark when this leg completes.
   */
  phase?: 'metadata';
  /**
   * Scoped traversals only: when this traversal began (the connector's clock).
   * A completed scoped traversal has examined every message received before
   * it began, so the next incremental bound may move up to here even when
   * every message was already held and none was fetched. It never comes from
   * a message's own Date header, which the sender controls.
   */
  startedMs?: number;
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
  /** Listed messages Olympus already holds, left untouched under a scope (no get spent). */
  itemsSkippedStored: number;
}

export interface GmailApiClient {
  listMessages(request: GmailListMessagesRequest): Promise<GmailListMessagesResponse>;
  /** `metadata` returns headers and labels only; the body never leaves Gmail. */
  getMessage(id: string, options?: GmailGetMessageOptions): Promise<GmailMessage>;
  /** Scope-picker tooling only; the traversal never lists labels. */
  listLabels?(): Promise<GmailLabel[]>;
  getLabel?(id: string): Promise<GmailLabel>;
}

export interface GmailGetMessageOptions {
  format?: 'full' | 'metadata';
  /** With `metadata`: restrict the returned headers. */
  metadataHeaders?: readonly string[];
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: 'system' | 'user';
  messagesTotal?: number;
}

export interface GmailListMessagesRequest {
  maxResults: number;
  pageToken?: string;
  query?: string;
}

export interface GmailListMessagesResponse {
  messages: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
  /** Gmail's own rough count of matching messages. An estimate, never a total. */
  resultSizeEstimate?: number;
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
  private readonly scope: GmailConnectorScope | undefined;
  private readonly now: () => number;
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
  private itemsSkippedStored = 0;
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
    this.requestBudget = options.requestBudget;
    this.provenance = sourceInvocationProvenance(options.provenance);
    this.maxRetries = options.maxRetries;
    this.sleepImpl = options.sleep;
    this.injectedClient = options.apiClient;
    this.scope = options.scope;
    this.now = options.now ?? (() => Date.now());
    const ingestFilterOptions = options.ingestFilterOptions ?? parseEmailIngestFilterOptionsFromEnv(env);
    // The approved scope says which categories are skipped. An explicit
    // operator setting still wins; otherwise the scope replaces the built-in
    // Promotions default, so a category the owner chose to include is read.
    this.ingestFilterOptions = this.scope && ingestFilterOptions.skipCategories === undefined
      ? { ...ingestFilterOptions, skipCategories: [...(this.scope.skippedCategoryLabelIds ?? [])] }
      : ingestFilterOptions;
    // Skipped labels are enforced by id after the fetch too, whatever the
    // category setting: a rename or an odd character in a label name cannot
    // make the query miss what the owner skipped.
    if (this.scope?.skippedLabelIds?.length) {
      this.ingestFilterOptions = {
        ...this.ingestFilterOptions,
        skipCategories: [
          ...(this.ingestFilterOptions.skipCategories ?? ['CATEGORY_PROMOTIONS']),
          ...this.scope.skippedLabelIds,
        ],
      };
    }
  }

  async authenticate(): Promise<void> {
    await this.clientForRequest();
  }

  async *listItems(options: SourceConnectorListOptions = {}): AsyncIterable<SourceConnectorListPage> {
    const client = await this.clientForRequest();
    let remaining = normalizeGmailMaxMessages(options.limit ?? this.defaultMaxMessages);
    const resume = decodeGmailCursor(options.cursor);
    const cutoffMs = this.scope?.contentAfterMs;
    // The metadata leg exists only under a scope with a cutoff; a phase marker
    // arriving without one is a stale cursor and restarts the content leg.
    const metadataLeg = resume.phase === 'metadata' && cutoffMs !== undefined;
    const staleLeg = resume.phase === 'metadata' && !metadataLeg;
    const watermarkMs = metadataLeg || staleLeg ? undefined : resume.watermarkMs;
    const query = metadataLeg ? this.metadataLegQuery(cutoffMs) : this.queryForWatermark(watermarkMs);
    // A scoped first traversal is two legs: full content after the cutoff,
    // then metadata-only before it. Incremental passes read only new mail.
    const splitsAtCutoff = !metadataLeg && cutoffMs !== undefined && watermarkMs === undefined;
    let highWaterMs = staleLeg ? undefined : resume.highWaterMs;
    const nowMs = this.now();
    // Carried from the first page of a scoped traversal to its last; a fresh
    // or stale start takes the clock now.
    const startedMs = this.scope
      ? (!staleLeg && resume.startedMs !== undefined && (resume.pageToken || metadataLeg) ? resume.startedMs : nowMs)
      : undefined;
    let pageToken = staleLeg ? undefined : resume.pageToken;
    const requestedPageTokens = new Set<string>();
    let listPages = 0;
    while (remaining > 0 && listPages < MAX_GMAIL_LIST_PAGES_PER_RUN) {
      if (pageToken) assertNewProviderPage(requestedPageTokens, pageToken);
      this.providerRequests += 1;
      listPages += 1;
      const page = await client.listMessages({
        maxResults: Math.min(DEFAULT_GMAIL_PAGE_SIZE, remaining),
        ...(pageToken ? { pageToken } : {}),
        ...(query ? { query } : {}),
      });
      const listed = page.messages.filter((message) => message.id);
      const items: RawItem[] = [];
      let messagesExamined = 0;
      let messagesFetched = 0;
      for (const message of listed) {
        if (messagesFetched >= remaining) break;
        messagesExamined += 1;
        // Mail Olympus already holds is never observed again under a scope.
        // Gmail messages are immutable, so a re-read could only replace a
        // stored body with a body-less metadata row (the window moved) or
        // re-classify an item whose vectors already exist; either would throw
        // away existing chunks and embeddings. The one exception is mail
        // stored metadata-only that the content leg may now store in full.
        const stored = this.scope?.storedItem?.(message.id);
        if (stored && (metadataLeg || stored.hasContent)) {
          // Held mail never moves the high-water mark: its stored date is the
          // sender's Date header, which can say anything (a spam dated 2036
          // would park every later query past all real mail). The traversal's
          // own start bounds the next pass instead; see `startedMs`.
          this.itemsSkippedStored += 1;
          continue;
        }
        messagesFetched += 1;
        this.providerRequests += 1;
        const fetched = await client.getMessage(
          message.id,
          metadataLeg ? { format: 'metadata', metadataHeaders: GMAIL_METADATA_HEADERS } : undefined,
        );
        const fetchedDateMs = internalDateNumber({ internalDate: fetched.internalDate });
        const beforeCutoff = cutoffMs !== undefined && fetchedDateMs !== undefined && fetchedDateMs < cutoffMs;
        // The content leg owns everything at or after the cutoff. Gmail's date
        // operators are second-granular, so a boundary message the metadata
        // leg also lists is left to the leg that stores its body.
        if (metadataLeg && !beforeCutoff) continue;
        // Older than the window but already stored in some form: leave it be.
        if (beforeCutoff && stored) {
          this.itemsSkippedStored += 1;
          continue;
        }
        const item = rawItemFromGmailMessage(fetched, this.account, { metadataOnly: metadataLeg || beforeCutoff });
        this.attachmentsDeclared += metadataCount(item.metadata, 'attachmentCount');
        this.attachmentBytesDeclared += metadataCount(item.metadata, 'attachmentBytesDeclared');
        this.attachmentsNotIngested += metadataCount(item.metadata, 'attachmentsNotIngested');
        const internalDateMs = internalDateNumber(item.metadata);
        // The metadata leg walks older mail; only the content leg moves the
        // high-water mark the next incremental pass starts from.
        if (!metadataLeg && internalDateMs !== undefined && (highWaterMs === undefined || internalDateMs > highWaterMs)) {
          // Gmail's receipt time, capped at the clock: a future internalDate
          // must not push the next bound past mail that has yet to arrive.
          highWaterMs = Math.min(internalDateMs, nowMs);
        }
        const subject = metadataString(item.metadata, 'subject') ?? metadataString(item.metadata, 'title');
        const from = metadataString(item.metadata, 'from');
        if (this.scope?.skipSenders?.some((rule) => senderMatchesRule(from, rule))) {
          this.itemsSkippedCategory += 1;
          continue;
        }
        const body = item.content.kind === 'text' ? item.content.text : metadataString(item.metadata, 'snippet');
        // Metadata-only items carry no body and no snippet, so the OTP filter
        // judges them by subject alone. Skipped labels are checked here by id
        // as well as in the query, so a renamed label cannot slip past.
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
      remaining -= messagesFetched;
      pageToken = page.nextPageToken;
      // The traversal is complete only when the provider has no further page
      // AND the bound did not truncate this one. The shipped connector called
      // every bounded slice done, which told the spine that a partial window
      // was a full traversal.
      const pageTruncated = messagesExamined < listed.length;
      const legDone = !pageToken && !pageTruncated;
      // The content leg finishing hands over to the metadata leg instead of
      // ending the traversal; the watermark waits until both legs are read.
      const enterMetadataLeg = legDone && splitsAtCutoff;
      const done = legDone && !enterMetadataLeg;
      // A scoped mailbox with nothing new since the cutoff still completes
      // with a watermark (the cutoff), so the next pass asks only for new
      // mail instead of re-listing the whole older mailbox forever.
      const promoted = promotedWatermark({
        highWaterMs,
        watermarkMs,
        ...(this.scope && startedMs !== undefined ? { floorMs: startedMs - TRAVERSAL_START_MARGIN_MS } : {}),
        ...(cutoffMs !== undefined ? { cutoffMs } : {}),
        nowMs,
      });
      const nextCursor = done
        // A completed traversal hands forward only the promoted watermark, so
        // the next run asks Gmail for new mail instead of for the mailbox.
        ? encodeGmailCursor(promoted !== undefined ? { watermarkMs: promoted } : {})
        : enterMetadataLeg
          ? encodeGmailCursor({
            phase: 'metadata',
            ...(highWaterMs !== undefined ? { highWaterMs } : {}),
            ...(startedMs !== undefined ? { startedMs } : {}),
          })
          : encodeGmailCursor({
            ...(watermarkMs !== undefined ? { watermarkMs } : {}),
            ...(highWaterMs !== undefined ? { highWaterMs } : {}),
            ...(pageToken ? { pageToken } : {}),
            ...(metadataLeg ? { phase: 'metadata' as const } : {}),
            ...(startedMs !== undefined ? { startedMs } : {}),
          });
      yield {
        items,
        ...(nextCursor ? { nextCursor } : {}),
        done,
      };
      // A page of already-stored mail spends no gets, so the walk continues
      // to the next page (bounded by the list-page cap) instead of ending the
      // run on an empty page.
      if (done || !pageToken || (items.length === 0 && messagesFetched > 0) || pageTruncated) break;
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
      itemsSkippedStored: this.itemsSkippedStored,
    };
  }

  requestBudgetStatus(): GoogleRequestBudgetStatus | undefined {
    return this.requestBudget?.status();
  }

  /**
   * The budgeted, retrying client, for owner-initiated tooling such as the
   * mail scope picker. Every request it makes is counted like a traversal's.
   */
  async apiClientForTooling(): Promise<GmailApiClient> {
    return this.clientForRequest();
  }

  /**
   * Mail facts only: subject as the title, the sender, and the provider's
   * labels. Gmail publishes no folder path and no sharing state, so neither is
   * claimed; the shared tier classifier decides the tier.
   */
  classificationSignals(item: RawItem): SourceClassificationSignals {
    const subject = metadataString(item.metadata, 'subject') ?? metadataString(item.metadata, 'title');
    const sender = metadataString(item.metadata, 'from');
    const labels = metadataStringArray(item.metadata, 'labels');
    return {
      ...(subject ? { title: subject } : {}),
      ...(sender ? { sender } : {}),
      ...(labels.length > 0 ? { labels } : {}),
    };
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
    if (this.scope) {
      // The same bound the picker's estimate uses (core/mail-source-scope).
      return this.scopedQuery(gmailAfterBound({ contentAfterMs: this.scope.contentAfterMs, watermarkMs }));
    }
    if (watermarkMs === undefined) return this.query;
    const after = `after:${Math.floor(watermarkMs / 1_000)}`;
    return this.query ? `${after} (${this.query})` : after;
  }

  private metadataLegQuery(cutoffMs: number): string | undefined {
    return this.scopedQuery(gmailBeforeBound(cutoffMs));
  }

  /**
   * The approved scope's filters ANDed with the operator's hidden
   * OLYMPUS_SOURCE_INDEX_GMAIL_QUERY override. Gmail ANDs space-separated
   * terms; the override is parenthesised so an OR inside it cannot escape
   * across the picker's terms.
   */
  private scopedQuery(bound: string | undefined): string | undefined {
    const parts = [bound, this.scope?.baseQuery, this.query ? `(${this.query})` : undefined]
      .filter((part): part is string => Boolean(part?.trim()));
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
}

export function gmailConnectorStoreClassification(
  sensitivityMap: SensitivityMap | undefined,
  ownerRules: readonly OwnerTierRule[] = [],
): ConnectorStoreClassificationOptions {
  return {
    baselineTrustTier: 'S3',
    baselineTrustDomain: 'internal',
    ...(sensitivityMap ? { sensitivityMap } : {}),
    // Owner rules that raise (the mail scope's "always Private" senders) place
    // matching mail in the secure_local store only: private embeddings.
    ...(ownerRules.length > 0 ? { ownerRules: [...ownerRules] } : {}),
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
    const cursor = decodeGmailCursor(value);
    return cursor.pageToken !== undefined || cursor.phase === 'metadata';
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
    getMessage(id, options) {
      budget.reserve(provenance);
      return inner.getMessage(id, options);
    },
    ...(inner.listLabels
      ? {
        listLabels() {
          budget.reserve(provenance);
          return inner.listLabels!();
        },
      }
      : {}),
    ...(inner.getLabel
      ? {
        getLabel(id: string) {
          budget.reserve(provenance);
          return inner.getLabel!(id);
        },
      }
      : {}),
  };
}

/**
 * The watermark a completed traversal hands forward: the newest fetched
 * internalDate, never behind the previous watermark, a scoped traversal's own
 * start (less a margin) or the scope's cutoff, and never ahead of the clock.
 */
export function promotedWatermark(input: {
  highWaterMs?: number | undefined;
  watermarkMs?: number | undefined;
  floorMs?: number | undefined;
  cutoffMs?: number | undefined;
  nowMs: number;
}): number | undefined {
  const candidates = [
    input.highWaterMs,
    input.watermarkMs,
    input.floorMs,
    input.cutoffMs !== undefined ? input.cutoffMs - 1_000 : undefined,
  ].filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (candidates.length === 0) return undefined;
  return Math.max(0, Math.min(Math.max(...candidates), input.nowMs));
}

function encodeGmailCursor(cursor: GmailCursor): string | undefined {
  if (cursor.watermarkMs === undefined && cursor.highWaterMs === undefined && !cursor.pageToken && !cursor.phase) {
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
    ) as { watermarkMs?: unknown; highWaterMs?: unknown; pageToken?: unknown; phase?: unknown; startedMs?: unknown };
    const watermarkMs = decodeCursorEpochMs(parsed.watermarkMs);
    const highWaterMs = decodeCursorEpochMs(parsed.highWaterMs);
    const startedMs = decodeCursorEpochMs(parsed.startedMs);
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
    if (parsed.phase !== undefined && parsed.phase !== 'metadata') throw new Error('invalid');
    return {
      ...(watermarkMs !== undefined ? { watermarkMs } : {}),
      ...(highWaterMs !== undefined ? { highWaterMs } : {}),
      ...(typeof parsed.pageToken === 'string' ? { pageToken: parsed.pageToken.trim() } : {}),
      ...(parsed.phase === 'metadata' ? { phase: 'metadata' as const } : {}),
      ...(startedMs !== undefined ? { startedMs } : {}),
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
      ...(typeof record.resultSizeEstimate === 'number' && Number.isFinite(record.resultSizeEstimate)
        ? { resultSizeEstimate: Math.max(0, Math.floor(record.resultSizeEstimate)) }
        : {}),
    };
  }

  async getMessage(id: string, options: GmailGetMessageOptions = {}): Promise<GmailMessage> {
    const params = new URLSearchParams({ format: options.format ?? 'full' });
    if (options.format === 'metadata') {
      for (const header of options.metadataHeaders ?? []) params.append('metadataHeaders', header);
    }
    const json = await this.getJson(`users/me/messages/${encodeURIComponent(id)}?${params.toString()}`);
    return json as GmailMessage;
  }

  async listLabels(): Promise<GmailLabel[]> {
    const record = asRecord(await this.getJson('users/me/labels'), 'Gmail labels list response');
    return Array.isArray(record.labels)
      ? record.labels.map((item) => gmailLabelFromJson(asRecord(item, 'Gmail label'))).filter((label) => label.id)
      : [];
  }

  async getLabel(id: string): Promise<GmailLabel> {
    return gmailLabelFromJson(asRecord(
      await this.getJson(`users/me/labels/${encodeURIComponent(id)}`),
      'Gmail label',
    ));
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

const GMAIL_METADATA_HEADERS = ['Subject', 'From', 'To', 'Date'] as const;

function gmailLabelFromJson(record: Record<string, unknown>): GmailLabel {
  const type = record.type === 'system' || record.type === 'user' ? record.type : undefined;
  return {
    id: stringValue(record.id),
    name: stringValue(record.name),
    ...(type ? { type } : {}),
    ...(typeof record.messagesTotal === 'number' && Number.isFinite(record.messagesTotal)
      ? { messagesTotal: Math.max(0, Math.floor(record.messagesTotal)) }
      : {}),
  };
}

function rawItemFromGmailMessage(
  message: GmailMessage,
  account: string,
  options: { metadataOnly?: boolean } = {},
): RawItem {
  const headers = headersFromPart(message.payload);
  const subject = headers.get('subject') ?? '(no subject)';
  // Sender-controlled and uncapped from Gmail: stored at most 4 KB, the same
  // bound every sender-rule parse applies.
  const from = (headers.get('from') ?? '').slice(0, MAX_FROM_HEADER_CHARS);
  const date = parsedDate(headers.get('date')) ?? internalDateIso(message.internalDate);
  // Mail older than the approved window: subject, sender, date and labels
  // only. No body and no snippet (the snippet is body text), so the item stays
  // findable by name and can be upgraded to full content later.
  const metadataOnly = options.metadataOnly === true;
  const text = metadataOnly ? '' : extractMessageText(message);
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
    content: !metadataOnly && text.trim() ? { kind: 'text', text } : { kind: 'metadata_only' },
    metadata: Object.freeze({
      title: subject,
      subject,
      from,
      ...(date ? { authoredAt: date } : {}),
      // Carried verbatim: it is the traversal's incremental watermark, and
      // Gmail's `after:` operator speaks the same clock.
      ...(message.internalDate ? { internalDate: message.internalDate } : {}),
      ...(message.historyId ? { historyId: message.historyId } : {}),
      ...(message.snippet && !metadataOnly ? { snippet: message.snippet } : {}),
      // Marks mail read by name only under the approved window, so a later
      // upgrade can find exactly these items.
      ...(metadataOnly ? { mailScopeContent: 'metadata_only' } : {}),
      labels: message.labelIds ?? [],
      attachmentCount: attachments.count,
      attachmentBytesDeclared: attachments.bytes,
      // This is an explicit product boundary, not a claim that an empty text
      // body means the message was fully covered.
      attachmentsNotIngested: attachments.count,
      locatorUri: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.id)}`,
      contentHash: hashString(`${message.historyId ?? ''}:${metadataOnly ? 'metadata_only' : text}`),
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

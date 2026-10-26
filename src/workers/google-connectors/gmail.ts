import { sharedDataPath } from '../../core/olympus-layout.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  RawItem,
  SourceClassificationSignals,
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import {
  sourceInvocationProvenance,
  type SourceInvocationProvenance,
} from '../../core/invocation-provenance.ts';
import { gmailAfterBound, gmailBeforeBound } from '../../core/mail-source-scope.ts';
import { senderMatchesRule } from '../../core/sender-rules.ts';
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
  gmailClassificationSignals,
  gmailMailItems,
  gmailMessageItem,
  type GmailMailAttachment,
  type GmailMailBuild,
  type GmailMailRecord,
} from './gmail-mail-record.ts';
import type { GmailRequestCounter } from './gmail-import-allowance.ts';
import {
  GoogleDailyRequestBudget,
  GoogleRequestBudgetError,
  type GoogleRequestBudgetStatus,
} from './request-budget.ts';

export const GMAIL_SOURCE_ID = 'gmail.email';
export const GMAIL_INTERNAL_CONNECTOR_CORPUS_ID = 'internal.email';
export const GMAIL_SECURE_CONNECTOR_CORPUS_ID = 'secure_local.email.private';
/** The lane's Public store (P1b per-tier stores), created when its first message is routed there. */
export const GMAIL_PUBLIC_CONNECTOR_CORPUS_ID = 'public_safe.email';
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
  requestBudget?: GmailRequestCounter;
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
  /** How mail is built into items (gmail-mail-record.ts): attachments as children of their message. */
  build?: GmailMailBuild;
}

/** Metadata reads for retained Private scope confirmation per connector pass. */
export const GMAIL_PRIVATE_SCOPE_CONFIRMATION_MAX_ITEMS = 32;

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
  /** A metadata-only scope confirmation for an already-stored Private body; never a body re-read. */
  storedItemObserved?: (item: RawItem) => void;
  /** One resumable scope-confirmation walk: no new items or bodies are fetched. */
  confirmationOnly?: boolean;
}

export interface GmailStoredItem {
  /** True when a stored copy has chunks (a body), false for a metadata-only row. */
  hasContent: boolean;
  needsScopeObservation?: boolean;
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
  /**
   * A pass stopped inside one message's attachments (more of them than the
   * pass's item budget): the next pass lists the rest, from the `from`-th,
   * before it reads the page again.
   */
  childOf?: { id: string; from: number };
  /**
   * The last message of `pageToken`'s page a pass handled (a page the item
   * budget cut short): the next pass resumes after that message, found by its
   * id in the page as it is listed then, whether or not the store would skip
   * it. Never a position: a message removed meanwhile would shift the rest of
   * the page under it. When the message is no longer listed, the page is read
   * from its start again (what is stored is skipped or written again
   * unchanged).
   */
  after?: string;
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
  /** One attachment's bytes (base64url), by the part's attachment id. */
  getAttachment?(messageId: string, attachmentId: string): Promise<{ data: string; size?: number }>;
  /** The mailbox the token reads: its address. */
  getProfile?(): Promise<{ emailAddress: string }>;
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
  /** Only messages carrying every one of these label ids (exact Gmail ids). */
  labelIds?: readonly string[];
  /** Also list Spam and Trash, which Gmail's listing leaves out unless asked. */
  includeSpamTrash?: boolean;
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
  partId?: string;
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
  private readonly requestBudget: GmailRequestCounter | undefined;
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
  private readonly build: GmailMailBuild;
  /** The messages this run read whole, so an attachment of one is read without asking for it again. */
  private readonly messagesById = new Map<string, GmailMessage>();

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
    this.build = options.build ?? {};
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
    let scopeConfirmationsFetched = 0;
    let remaining = normalizeGmailMaxMessages(options.limit ?? this.defaultMaxMessages);
    const resume = decodeGmailCursor(options.cursor);
    const cutoffMs = this.scope?.contentAfterMs;
    // The metadata leg exists only under a scope with a cutoff; a phase marker
    // arriving without one is a stale cursor and restarts the content leg.
    let metadataLeg = !this.scope?.confirmationOnly && resume.phase === 'metadata' && cutoffMs !== undefined;
    const staleLeg = resume.phase === 'metadata' && !metadataLeg;
    const watermarkMs = metadataLeg || staleLeg ? undefined : resume.watermarkMs;
    let query = metadataLeg && cutoffMs !== undefined ? this.metadataLegQuery(cutoffMs) : this.queryForWatermark(watermarkMs);
    // A scoped first traversal is two legs: full content after the cutoff,
    // then metadata-only before it. Incremental passes read only new mail.
    const splitsAtCutoff = !this.scope?.confirmationOnly && !metadataLeg && cutoffMs !== undefined && watermarkMs === undefined;
    let highWaterMs = staleLeg ? undefined : resume.highWaterMs;
    const nowMs = this.now();
    // Carried from the first page of a scoped traversal to its last; a fresh
    // or stale start takes the clock now.
    const startedMs = this.scope
      ? (!staleLeg && resume.startedMs !== undefined && (resume.pageToken || metadataLeg) ? resume.startedMs : nowMs)
      : undefined;
    let pageToken = staleLeg ? undefined : resume.pageToken;
    // The listing's limit bounds the ITEMS it yields (the store stops at it), and a message is its own item
    // and its attachments: a message's items go on one page, or wait for the next pass.
    let itemRoom = remaining;
    // The last message of the first page a cut-short pass already handled.
    let pageAfter = staleLeg ? undefined : resume.after;
    if (resume.childOf && !staleLeg) {
      // The last pass stopped inside a message's attachments (more than one pass may hold): the rest first.
      const rest = await this.attachmentsFrom(client, resume.childOf, itemRoom);
      this.providerRequests += 1;
      remaining -= 1;
      itemRoom -= rest.items.length;
      const cursorFields = {
        ...(watermarkMs !== undefined ? { watermarkMs } : {}),
        ...(highWaterMs !== undefined ? { highWaterMs } : {}),
        ...(pageToken ? { pageToken } : {}),
        ...(metadataLeg ? { phase: 'metadata' as const } : {}),
        ...(startedMs !== undefined ? { startedMs } : {}),
        ...(pageAfter ? { after: pageAfter } : {}),
      };
      if (rest.next !== undefined) {
        const nextCursor = encodeGmailCursor({ ...cursorFields, childOf: { id: resume.childOf.id, from: rest.next } });
        yield { items: rest.items, ...(nextCursor ? { nextCursor } : {}), done: false, truncated: true };
        return;
      }
      const nextCursor = encodeGmailCursor(cursorFields);
      yield { items: rest.items, ...(nextCursor ? { nextCursor } : {}), done: false };
      if (remaining <= 0 || itemRoom <= 0) return;
    }
    const requestedPageTokens = new Set<string>();
    let listPages = 0;
    while (remaining > 0 && itemRoom > 0 && listPages < MAX_GMAIL_LIST_PAGES_PER_RUN) {
      if (pageToken) assertNewProviderPage(requestedPageTokens, pageToken);
      this.providerRequests += 1;
      listPages += 1;
      const page = await client.listMessages({
        maxResults: Math.min(DEFAULT_GMAIL_PAGE_SIZE, remaining),
        ...(pageToken ? { pageToken } : {}),
        ...(query ? { query } : {}),
      });
      const listed = page.messages.filter((message) => message.id);
      const resumedAt = pageAfter ? listed.findIndex((message) => message.id === pageAfter) : -1;
      const baseSkip = resumedAt + 1;
      // The messages this pass handled on this page, in order: the cursor resumes after the last of them.
      const examinedIds: string[] = resumedAt >= 0 ? [pageAfter!] : [];
      pageAfter = undefined;
      const items: RawItem[] = [];
      let messagesExamined = 0;
      let messagesFetched = 0;
      /** Set when a message's attachments did not fit this pass: where the next one resumes inside it. */
      let childOf: { id: string; from: number } | undefined;
      for (const message of listed.slice(baseSkip)) {
        if (messagesFetched >= remaining || items.length >= itemRoom) break;
        messagesExamined += 1;
        examinedIds.push(message.id);
        // Mail Olympus already holds is never observed again under a scope.
        // Gmail messages are immutable, so a re-read could only replace a
        // stored body with a body-less metadata row (the window moved) or
        // re-classify an item whose vectors already exist; either would throw
        // away existing chunks and embeddings. The one exception is mail
        // stored metadata-only that the content leg may now store in full.
        const stored = this.scope?.storedItem?.(message.id);
        if (this.scope?.confirmationOnly && (!stored || !stored.hasContent)) continue;
        if (stored && (metadataLeg || stored.hasContent)) {
          if (!metadataLeg && stored.needsScopeObservation && this.scope?.storedItemObserved
            && scopeConfirmationsFetched < GMAIL_PRIVATE_SCOPE_CONFIRMATION_MAX_ITEMS) {
            // Only unconfirmed Private copies need this request, once per
            // approval. It consumes the same bounded message/request budget.
            scopeConfirmationsFetched += 1;
            messagesFetched += 1;
            this.providerRequests += 1;
            const metadata = await client.getMessage(message.id, { format: 'metadata', metadataHeaders: GMAIL_METADATA_HEADERS });
            const received = internalDateNumber({ internalDate: metadata.internalDate });
            const item = gmailMessageItem(gmailMailRecordFromMessage(metadata, { metadataOnly: true }), this.account);
            const subject = metadataString(item.metadata, 'subject');
            const from = metadataString(item.metadata, 'from');
            const skipped = this.scope.skipSenders?.some(rule => senderMatchesRule(from, rule))
              || classifyEmailIngestSkip({ ...(subject ? { subject } : {}), ...(from ? { from } : {}), labels: metadataStringArray(item.metadata, 'labels') }, this.ingestFilterOptions);
            if (!skipped && (cutoffMs === undefined || (received !== undefined && received >= cutoffMs))) this.scope.storedItemObserved(item);
          }
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
        const record = gmailMailRecordFromMessage(fetched, { metadataOnly: metadataLeg || beforeCutoff });
        const [item, ...children] = gmailMailItems(record, this.account, this.build) as [RawItem, ...RawItem[]];
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
        // A message and its attachments go out together. One that does not fit beside what this page holds
        // waits for the next pass (it is not stored, so it is listed again); one that does not fit even alone
        // goes with the attachments that fit, and the next pass resumes inside it.
        if (items.length + 1 + children.length > itemRoom && items.length > 0) {
          messagesExamined -= 1;
          examinedIds.pop();
          break;
        }
        const unit = [item, ...children].slice(0, Math.max(1, itemRoom - items.length));
        if (unit.length < 1 + children.length) childOf = { id: record.id, from: unit.length - 1 };
        // Populated on the way past so fetchItem is a cache read. The shipped
        // connector re-fetched every metadata_only item, doubling messages.get
        // inside a bounded slice.
        for (const entry of unit) this.itemsByLocalId.set(entry.identity.localItemId, entry);
        this.messagesById.set(fetched.id, fetched);
        items.push(...unit);
        if (childOf) break;
      }
      remaining -= messagesFetched;
      itemRoom -= items.length;
      if (childOf) {
        // Stopped inside a message: the next pass lists the rest of its attachments, then reads the same
        // provider page again after the messages this pass handled.
        const nextCursor = encodeGmailCursor({
          ...(watermarkMs !== undefined ? { watermarkMs } : {}),
          ...(highWaterMs !== undefined ? { highWaterMs } : {}),
          ...(pageToken ? { pageToken } : {}),
          ...(metadataLeg ? { phase: 'metadata' as const } : {}),
          ...(startedMs !== undefined ? { startedMs } : {}),
          childOf,
          // The split message counts as handled: once its attachments are listed, the page goes on after it.
          after: childOf.id,
        });
        yield { items, ...(nextCursor ? { nextCursor } : {}), done: false, truncated: true };
        return;
      }
      // The traversal is complete only when the provider has no further page
      // AND the bound did not truncate this one. The shipped connector called
      // every bounded slice done, which told the spine that a partial window
      // was a full traversal.
      const handled = baseSkip + messagesExamined;
      const pageTruncated = handled < listed.length;
      // A page the item budget cut short is read again from its own token, after the messages this pass handled
      // (`after`), never from the next page's, which would pass over the ones it did not reach.
      if (!pageTruncated) pageToken = page.nextPageToken;
      const legDone = !pageToken && !pageTruncated;
      // The content leg finishing hands over to the metadata leg instead of
      // ending the traversal; the watermark waits until both legs are read.
      const enterMetadataLeg = legDone && splitsAtCutoff && !metadataLeg;
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
            ...(pageTruncated && examinedIds.length > 0 ? { after: examinedIds.at(-1)! } : {}),
          });
      yield {
        items,
        ...(nextCursor ? { nextCursor } : {}),
        done,
      };
      // Empty pages can be entirely held or filtered mail, not the end of
      // the provider walk. Both date legs share this run's get and page
      // budgets; stopping at their hand-off stranded un-cursored reconciles
      // on the content leg forever. If the budget expires here, nextCursor
      // still resumes at the metadata leg on the next pull.
      if (done || pageTruncated) break;
      if (enterMetadataLeg) {
        metadataLeg = true;
        query = this.metadataLegQuery(cutoffMs);
        // Gmail page tokens belong to one query, so the other leg gets its
        // own token history while the shared page budget remains in force.
        requestedPageTokens.clear();
      } else if (!pageToken) break;
    }
  }
  /**
   * In-run cache, never a second provider round trip. Listing already fetched
   * the full message for every id it emitted, so asking Gmail again is pure
   * duplicate quota — and the spine calls fetchItem for every item that listed
   * as metadata_only.
   */
  async fetchItem(localItemId: string, options?: SourceConnectorFetchOptions): Promise<RawItem> {
    if (options?.deferredBytes) return this.fetchAttachment(localItemId, options.deferredBytes.locator);
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

  /**
   * One attachment's bytes (a child item, 2.1.0), from the locator its row
   * keeps: the message is read once (the listing's copy when this run listed
   * it), and the part's bytes are inline or asked for by the part's
   * attachment id. Every request is the traversal's, under the same budget.
   */
  private async fetchAttachment(localItemId: string, locator: string): Promise<RawItem> {
    const where = parseGmailPartLocator(locator);
    if (!where) throw new Error('This Gmail attachment cannot be found from what Olympus kept.');
    const client = await this.clientForRequest();
    let message = this.messagesById.get(where.messageId);
    if (!message) {
      this.providerRequests += 1;
      message = await client.getMessage(where.messageId);
      this.messagesById.set(where.messageId, message);
    }
    const part = gmailPartAt(message.payload, where.partId);
    const record = gmailMailRecordFromMessage(message);
    const child = gmailMailItems(record, this.account, { children: true }).find((item) => item.identity.localItemId === localItemId
      || item.identity.localItemId === `${this.account}:${localItemId}`);
    if (!part || !child) throw new Error('This Gmail attachment is no longer in its message.');
    let data = part.body?.data;
    if (!data && part.body?.attachmentId) {
      if (!client.getAttachment) throw new Error('This Gmail client cannot read attachments.');
      this.providerRequests += 1;
      data = (await client.getAttachment(where.messageId, part.body.attachmentId)).data;
    }
    if (data === undefined) throw new Error('Gmail returned no bytes for this attachment.');
    const bytes = new Uint8Array(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    return { ...child, content: { kind: 'bytes', mimeType: child.mimeType, bytes } };
  }

  /** The attachments of one message from the `from`-th on, as many as `room` holds, and where the rest start. */
  private async attachmentsFrom(
    client: GmailApiClient,
    at: { id: string; from: number },
    room: number,
  ): Promise<{ items: RawItem[]; next?: number }> {
    const message = await client.getMessage(at.id);
    this.messagesById.set(at.id, message);
    const [, ...children] = gmailMailItems(gmailMailRecordFromMessage(message), this.account, this.build);
    const items = children.slice(at.from, at.from + Math.max(1, room));
    for (const item of items) this.itemsByLocalId.set(item.identity.localItemId, item);
    const next = at.from + items.length;
    return { items, ...(next < children.length ? { next } : {}) };
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
    return gmailClassificationSignals(item);
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

/** Gmail no longer accepts a saved page token (it expired, or never was this query's). */
export class GmailPageTokenRejectedError extends Error {
  constructor() {
    super('Gmail rejected the saved page token.');
    this.name = 'GmailPageTokenRejectedError';
  }
}

/** Gmail's largest list page. */
const GMAIL_LABEL_PAGE_SIZE = 500;

/**
 * Which of the mailbox's messages carry a label, a page at a time, for the
 * owner-rule sweep of mail already stored (see tier-rules-sweep.ts): Gmail
 * never lists a held message again, so the labels of stored mail are asked of
 * Gmail by label, not read back. The label is matched against Gmail's label
 * ids without regard to case, exactly as the tier classifier compares them,
 * and the listing includes Spam and Trash (stored mail may have been moved
 * there). A label Gmail does not have carries no messages. Not narrowed by the
 * mail scope: stored mail the scope no longer covers is still stored.
 */
export function gmailLabelledMessageSource(getClient: () => Promise<GmailApiClient>): {
  listLabelled(label: string, page: { pageToken?: string }): Promise<{ ids: string[]; nextPageToken?: string }>;
} {
  let known: readonly GmailLabel[] | undefined;
  return {
    async listLabelled(label, page) {
      const client = await getClient();
      let labelId = label.trim();
      if (client.listLabels) {
        known ??= await client.listLabels();
        const wanted = labelId.toLowerCase();
        const match = known.find((candidate) => candidate.id === labelId)
          ?? known.find((candidate) => candidate.id.trim().toLowerCase() === wanted);
        if (!match) return { ids: [] };
        labelId = match.id;
      }
      let response: GmailListMessagesResponse;
      try {
        response = await client.listMessages({
          maxResults: GMAIL_LABEL_PAGE_SIZE,
          labelIds: [labelId],
          includeSpamTrash: true,
          ...(page.pageToken ? { pageToken: page.pageToken } : {}),
        });
      } catch (error) {
        if (page.pageToken && error instanceof Error && /Gmail API request failed \((?:400|404)\)/.test(error.message)) {
          throw new GmailPageTokenRejectedError();
        }
        throw error;
      }
      return {
        ids: response.messages.map((message) => message.id).filter((id) => id),
        ...(response.nextPageToken ? { nextPageToken: response.nextPageToken } : {}),
      };
    },
  };
}

export function gmailConnectorStoreClassification(
  ownerRules: readonly OwnerTierRule[] = [],
): ConnectorStoreClassificationOptions {
  return {
    baselineTrustTier: 'S3',
    baselineTrustDomain: 'internal',
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
  return sharedDataPath('gmail-request-budget', env);
}

function budgetedGmailApiClient(
  inner: GmailApiClient,
  budget: GmailRequestCounter,
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
    ...(inner.getProfile
      ? {
        getProfile() {
          budget.reserve(provenance);
          return inner.getProfile!();
        },
      }
      : {}),
    ...(inner.getAttachment
      ? {
        getAttachment(messageId: string, attachmentId: string) {
          budget.reserve(provenance);
          return inner.getAttachment!(messageId, attachmentId);
        },
      }
      : {}),
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
  if (cursor.watermarkMs === undefined && cursor.highWaterMs === undefined && !cursor.pageToken && !cursor.phase && !cursor.childOf && !cursor.after) {
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
    ) as { watermarkMs?: unknown; highWaterMs?: unknown; pageToken?: unknown; phase?: unknown; startedMs?: unknown; childOf?: unknown; after?: unknown };
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
    const childOf = decodeChildOf(parsed.childOf);
    if (parsed.after !== undefined && (typeof parsed.after !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.after))) {
      throw new Error('invalid');
    }
    return {
      ...(watermarkMs !== undefined ? { watermarkMs } : {}),
      ...(highWaterMs !== undefined ? { highWaterMs } : {}),
      ...(typeof parsed.pageToken === 'string' ? { pageToken: parsed.pageToken.trim() } : {}),
      ...(parsed.phase === 'metadata' ? { phase: 'metadata' as const } : {}),
      ...(startedMs !== undefined ? { startedMs } : {}),
      ...(childOf ? { childOf } : {}),
      ...(typeof parsed.after === 'string' ? { after: parsed.after } : {}),
    };
  } catch {
    throw new TypeError('Gmail connector cursor is invalid.');
  }
}

function decodeChildOf(value: unknown): { id: string; from: number } | undefined {
  if (value === undefined) return undefined;
  const record = value as { id?: unknown; from?: unknown } | null;
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.id)
    || typeof record.from !== 'number' || !Number.isSafeInteger(record.from) || record.from < 0) {
    throw new Error('invalid');
  }
  return { id: record.id, from: record.from };
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

class RestGmailApiClient implements GmailApiClient {
  private readonly token: string;
  private readonly fetchImpl: CredentialBrokerFetch;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly requestBudget: GmailRequestCounter | undefined;
  private readonly provenance: SourceInvocationProvenance;

  constructor(options: {
    token: string;
    fetch: CredentialBrokerFetch;
    baseUrl: string;
    requestBudget?: GmailRequestCounter;
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
      includeSpamTrash: request.includeSpamTrash === true ? 'true' : 'false',
    });
    if (request.pageToken) params.set('pageToken', request.pageToken);
    if (request.query) params.set('q', request.query);
    for (const labelId of request.labelIds ?? []) params.append('labelIds', labelId);
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

  async getProfile(): Promise<{ emailAddress: string }> {
    const record = asRecord(await this.getJson('users/me/profile'), 'Gmail profile');
    return { emailAddress: stringValue(record.emailAddress) };
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<{ data: string; size?: number }> {
    const record = asRecord(await this.getJson(
      `users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    ), 'Gmail attachment');
    return {
      data: stringValue(record.data),
      ...(typeof record.size === 'number' && Number.isSafeInteger(record.size) ? { size: record.size } : {}),
    };
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

// Message-ID too: an imported mbox of this account is matched to stored mail by it
// (docs/design/archive-live-one-dataset.md, section 4).
const GMAIL_METADATA_HEADERS = ['Subject', 'From', 'To', 'Date', 'Message-ID'] as const;

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

/**
 * A Gmail API message as the connector's one record shape, a parsed mail
 * (gmail-mail-record.ts): the live input's half of reading mail. An imported
 * mbox of the account yields the same record, and both are built into items by
 * `gmailMailItems`.
 */
export function gmailMailRecordFromMessage(
  message: GmailMessage,
  options: { metadataOnly?: boolean } = {},
): GmailMailRecord {
  const headers = headersFromPart(message.payload);
  const metadataOnly = options.metadataOnly === true;
  const plain: string[] = [];
  const html: string[] = [];
  if (!metadataOnly) collectPartText(message.payload, plain, html);
  const messageId = bareMessageId(headers.get('message-id'));
  return {
    id: message.id,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.historyId ? { historyId: message.historyId, sourceVersion: message.historyId } : {}),
    ...(message.internalDate ? { internalDate: message.internalDate } : {}),
    labelIds: message.labelIds ?? [],
    headers: {
      ...(headers.get('subject') ? { subject: headers.get('subject')! } : {}),
      ...(headers.get('from') ? { from: headers.get('from')! } : {}),
      ...(headers.get('to') ? { to: headers.get('to')! } : {}),
      ...(headers.get('date') ? { date: headers.get('date')! } : {}),
      ...(messageId ? { messageId } : {}),
    },
    ...(message.snippet && !metadataOnly ? { snippet: message.snippet } : {}),
    body: plain.length > 0 ? plain.join('\n\n') : html.map(stripHtml).join('\n\n'),
    metadataOnly,
    attachments: gmailAttachments(message.id, message.payload, false),
  };
}

/** The Message-ID header without its angle brackets. */
export function bareMessageId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const inner = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1).trim() : trimmed;
  return inner || undefined;
}

/** The locator of one MIME part of a Gmail message: what a later read of its bytes needs. */
const GMAIL_PART_LOCATOR_PREFIX = 'gmail-part1:';

/** The prefix every live Gmail part locator starts with. */
export function gmailPartLocatorPrefix(): string {
  return GMAIL_PART_LOCATOR_PREFIX;
}

export function gmailPartLocator(messageId: string, partId: string): string {
  return `${GMAIL_PART_LOCATOR_PREFIX}${messageId}:${partId}`;
}

function parseGmailPartLocator(locator: string): { messageId: string; partId: string } | undefined {
  if (!locator.startsWith(GMAIL_PART_LOCATOR_PREFIX)) return undefined;
  const rest = locator.slice(GMAIL_PART_LOCATOR_PREFIX.length);
  const split = rest.indexOf(':');
  if (split <= 0) return undefined;
  const messageId = rest.slice(0, split);
  const partId = rest.slice(split + 1);
  return /^[A-Za-z0-9_-]{1,128}$/.test(messageId) && /^[0-9.]{0,64}$/.test(partId) ? { messageId, partId } : undefined;
}

/**
 * Every MIME part with a file name, in tree order. A part inside another one
 * with a file name (a file in a forwarded message) is named but `nested`: it is
 * read with the part that holds it, never as a child of its own.
 */
function gmailAttachments(messageId: string, part: GmailMessagePart | undefined, inside: boolean): GmailMailAttachment[] {
  if (!part) return [];
  const filename = part.filename?.trim();
  const size = filename && Number.isSafeInteger(part.body?.size) && (part.body?.size ?? 0) >= 0
    ? part.body!.size!
    : undefined;
  const partId = part.partId?.trim() ?? '';
  const found: GmailMailAttachment[] = filename
    ? [{
      partId,
      filename,
      ...(part.mimeType?.trim() ? { mimeType: part.mimeType.trim() } : {}),
      ...(size !== undefined ? { size } : {}),
      // A part Gmail gave no id cannot be found again.
      ...(part.partId !== undefined ? { locator: gmailPartLocator(messageId, partId) } : {}),
      ...(inside ? { nested: true } : {}),
    }]
    : [];
  for (const child of part.parts ?? []) found.push(...gmailAttachments(messageId, child, inside || Boolean(filename)));
  return found;
}

/** The part a part path names, in a message's tree. */
function gmailPartAt(part: GmailMessagePart | undefined, partId: string): GmailMessagePart | undefined {
  if (!part) return undefined;
  if ((part.partId?.trim() ?? '') === partId) return part;
  for (const child of part.parts ?? []) {
    const found = gmailPartAt(child, partId);
    if (found) return found;
  }
  return undefined;
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

function metadataCount(metadata: Readonly<Record<string, unknown>>, key: string): number {
  const value = metadata[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
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
import { buildSourceSensitivity, type SourceSensitivity } from '../../core/source-index/types.ts';
import {
  createEnvCredentialBroker,
  requireBearerTokenCredentialSession,
  type CredentialBroker,
} from '../credential-broker/index.ts';
import { LocalConnectorStore } from '../connector-store/index.ts';
import {
  ReadwiseApiClient,
  type ReadwiseApiClientOptions,
  type ReadwiseExportBook,
  type ReadwiseReaderDocument,
} from './api.ts';
import { READWISE_LIBRARY_CORPUS_ID } from './corpus-adapter.ts';

export const READWISE_CONNECTOR_ID = 'readwise_live';
export const READWISE_PROVIDER = 'readwise';
export const READWISE_DAILY_REQUEST_BUDGET_ENV =
  'OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET';
export const READWISE_DAILY_REQUEST_BUDGET_STATE_PATH_ENV =
  'OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET_STATE_PATH';
export const DEFAULT_READWISE_DAILY_REQUEST_BUDGET = 1_000;
export const DEFAULT_READWISE_CONNECTOR_PAGE_SIZE = 100;

const MAX_CURSOR_LENGTH = 4_096;
const MAX_CURSOR_ITEM_OFFSET = 1_000_000;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_ACCOUNT_LENGTH = 256;
const READWISE_REQUEST_BUDGET_STATE_VERSION = 1;

export interface ReadwiseRequestBudgetStatus {
  utcDay: string;
  requests: number;
  dailyRequestBudget: number;
}

export interface ReadwiseDailyRequestBudgetOptions {
  dailyRequestBudget: number;
  /**
   * Readwise-owned durable counter file. Omitting it keeps the day counter
   * process-local; the runtime always supplies one so a restart cannot hand
   * the provider a fresh budget mid-day. Deliberately NOT the connector-store
   * sqlite: that file participates in qualification fingerprints.
   */
  statePath?: string;
  now?: () => Date;
}

export class ReadwiseRequestBudgetError extends Error {
  readonly retryAt: string;

  constructor(retryAt: string) {
    super('Readwise request deferred by daily_api_request_guard.');
    this.name = 'ReadwiseRequestBudgetError';
    this.retryAt = retryAt;
  }
}

export class ReadwiseDailyRequestBudget {
  private utcDay = '';
  private requests = 0;
  private readonly dailyRequestBudget: number;
  private readonly statePath: string | undefined;
  private readonly now: () => Date;

  constructor(options: ReadwiseDailyRequestBudgetOptions) {
    this.dailyRequestBudget = positiveInteger(
      options.dailyRequestBudget,
      'Readwise daily API request budget',
    );
    this.now = options.now ?? (() => new Date());
    const statePath = options.statePath?.trim();
    if (statePath) {
      this.statePath = statePath;
      const restored = this.restoreState(statePath);
      if (restored) {
        this.utcDay = restored.utcDay;
        this.requests = restored.requests;
      }
    }
  }

  /**
   * A counter that cannot be proved is treated as a fully spent day: the same
   * fail-closed protection as a trusted spent counter, but it clears at the UTC
   * rollover instead of throwing out of the constructor and crash-looping the
   * worker until a human deletes the file.
   */
  private restoreState(statePath: string): { utcDay: string; requests: number } | undefined {
    try {
      return readReadwiseRequestBudgetState(statePath);
    } catch {
      return {
        utcDay: validDate(this.now()).toISOString().slice(0, 10),
        requests: this.dailyRequestBudget,
      };
    }
  }

  /**
   * Counts one provider request against the day, refusing a ROUTINE request
   * that would cross the daily line.
   *
   * The daily budget is Olympus's own constraint on routine work, so an
   * operator run is exempt from the refusal (owner ruling 2026-08-19) — but
   * never from the count. An operator request increments and persists past the
   * line, so the next scheduled run is guarded against what the operator
   * actually spent, and Readwise's own refusals still bind both provenances.
   */
  reserve(provenance?: SourceInvocationProvenance): void {
    const routine = sourceInvocationProvenance(provenance) === 'scheduled';
    const now = validDate(this.now());
    const utcDay = now.toISOString().slice(0, 10);
    if (utcDay !== this.utcDay) {
      this.utcDay = utcDay;
      this.requests = 0;
    }
    if (routine && this.requests >= this.dailyRequestBudget) {
      throw new ReadwiseRequestBudgetError(nextUtcDay(now));
    }
    // Count first, then persist. A failed write is a loud host problem, and the
    // in-memory counter it leaves behind is the conservative one.
    this.requests += 1;
    if (this.statePath) {
      writeReadwiseRequestBudgetState(this.statePath, {
        utcDay: this.utcDay,
        requests: this.requests,
      });
    }
  }

  status(): ReadwiseRequestBudgetStatus {
    const now = validDate(this.now());
    const utcDay = now.toISOString().slice(0, 10);
    return {
      utcDay,
      requests: utcDay === this.utcDay ? this.requests : 0,
      dailyRequestBudget: this.dailyRequestBudget,
    };
  }
}

/**
 * The single runtime construction seam for the guard. Both the connector and
 * the connector-store sync handler REQUIRE an injected budget so one process
 * can never quietly run two independent day counters.
 */
export function createReadwiseDailyRequestBudget(options: {
  env?: Record<string, string | undefined>;
  statePath?: string;
  now?: () => Date;
} = {}): ReadwiseDailyRequestBudget {
  const env = options.env ?? process.env;
  return new ReadwiseDailyRequestBudget({
    dailyRequestBudget: readwiseDailyRequestBudgetFromEnv(env),
    statePath: options.statePath?.trim() || defaultReadwiseRequestBudgetStatePath(env),
    ...(options.now ? { now: options.now } : {}),
  });
}

export function defaultReadwiseRequestBudgetStatePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env[READWISE_DAILY_REQUEST_BUDGET_STATE_PATH_ENV]?.trim();
  if (configured) return configured;
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'readwise-daily-request-budget.json');
}

interface ReadwiseRequestBudgetStateFile {
  version?: unknown;
  utcDay?: unknown;
  requests?: unknown;
}

function readReadwiseRequestBudgetState(
  statePath: string,
): { utcDay: string; requests: number } | undefined {
  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: ReadwiseRequestBudgetStateFile;
  try {
    parsed = JSON.parse(raw) as ReadwiseRequestBudgetStateFile;
  } catch {
    throw new TypeError('Readwise daily API request budget state is invalid.');
  }
  // Refuse anything unprovable instead of silently reissuing a day of provider
  // budget that may already be spent. The caller decides how to recover.
  if (
    parsed.version !== READWISE_REQUEST_BUDGET_STATE_VERSION
    || typeof parsed.utcDay !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.utcDay)
    || !Number.isSafeInteger(parsed.requests)
    || (parsed.requests as number) < 0
  ) {
    throw new TypeError('Readwise daily API request budget state is invalid.');
  }
  return { utcDay: parsed.utcDay, requests: parsed.requests as number };
}

function writeReadwiseRequestBudgetState(
  statePath: string,
  state: { utcDay: string; requests: number },
): void {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(
    statePath,
    `${JSON.stringify({ version: READWISE_REQUEST_BUDGET_STATE_VERSION, ...state })}\n`,
  );
}

export interface ReadwiseSourceConnector extends SourceConnector {
  requestBudgetStatus(): ReadwiseRequestBudgetStatus;
}

export interface ReadwiseSourceConnectorOptions {
  account?: string;
  credentialBroker?: CredentialBroker;
  credentialHandle?: string;
  fetch?: ReadwiseApiClientOptions['fetch'];
  apiV2BaseUrl?: string;
  readerApiV3BaseUrl?: string;
  timeoutMs?: number;
  pageSize?: number;
  /** Required: the one runtime day counter, never a per-connector fallback. */
  requestBudget: ReadwiseDailyRequestBudget;
  /**
   * Who initiated the run this connector serves. Operator runs are exempt from
   * the daily request budget (owner ruling 2026-08-19); anything but the exact
   * literal 'operator' fails closed to 'scheduled'. Per connector, never per
   * handler: a connector is built for one run, so the exemption cannot outlive
   * the run that earned it — the day counter itself is shared by the process
   * and could never hold this safely.
   */
  provenance?: SourceInvocationProvenance;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

/**
 * Readwise resume point.
 *
 * `pageCursor` is the provider's own pagination token for the phase. The
 * export endpoint hands back a bare JSON array (`api.ts` `exportBooks`), so on
 * that phase there is frequently no provider token at all and one page expands
 * into many highlight items — far more than a bounded run may consume.
 *
 * `itemOffset` is therefore ours, not the provider's: the number of items of
 * THIS page already stored. A run that stops mid-page resumes by re-requesting
 * the same page and dropping that many items. It is exact because the item
 * list is a pure function of the page payload — flatten the books in order,
 * then dedupe on (conversation, provider item id) — so the same payload always
 * yields the same sequence. It is safe when the payload is NOT the same:
 * re-reading an item is idempotent, and the daily un-cursored reconcile is the
 * completeness authority, so a shifted page costs a repeat, never a silent gap.
 *
 * `updatedAfter` is the sweep watermark. It is written only onto the DONE page
 * of a completed sweep, so it can never advance past unread data, and the next
 * sweep asks the provider for changes instead of re-walking the whole library.
 * `sweepMaxUpdatedAt` accumulates the candidate across the runs of one sweep.
 */
interface ReadwiseCursor {
  phase: 'reader' | 'export';
  pageCursor?: string;
  itemOffset?: number;
  updatedAfter?: string;
  sweepMaxUpdatedAt?: string;
}

export function createReadwiseSourceConnector(
  options: ReadwiseSourceConnectorOptions,
): ReadwiseSourceConnector {
  const env = options.env ?? process.env;
  const account = requireAccount(options.account?.trim() || 'personal');
  const credentialHandle = options.credentialHandle?.trim()
    || env.OLYMPUS_SOURCE_INDEX_READWISE_CREDENTIAL_HANDLE?.trim()
    || 'readwise.personal';
  const broker = options.credentialBroker ?? createEnvCredentialBroker({ env });
  const pageSize = boundedPageSize(options.pageSize);
  const now = options.now ?? (() => new Date());
  const requestBudget = options.requestBudget;
  const provenance = sourceInvocationProvenance(options.provenance);
  const byLocalId = new Map<string, RawItem>();
  let client: ReadwiseApiClient | undefined;

  const connector: ReadwiseSourceConnector = {
    id: READWISE_CONNECTOR_ID,
    family: 'readwise',

    async authenticate(): Promise<void> {
      if (client) return;
      const session = requireBearerTokenCredentialSession(await broker.issueSession({
        handle: credentialHandle,
        provider: 'readwise',
        capability: 'readwise.sync',
        trustDomain: 'internal',
        purpose: 'Synchronize Readwise documents and highlights into the shared connector store.',
      }), credentialHandle);
      const guardedFetch: NonNullable<ReadwiseApiClientOptions['fetch']> = async (url, init) => {
        // One reserve per real provider request. The provenance is this
        // connector's, fixed for the run; Readwise's own refusals arrive from
        // the fetch below and bind regardless of it.
        requestBudget.reserve(provenance);
        return (options.fetch ?? fetch)(url, init);
      };
      client = new ReadwiseApiClient({
        token: session.token,
        fetch: guardedFetch,
        ...(options.apiV2BaseUrl ? { apiV2BaseUrl: options.apiV2BaseUrl } : {}),
        ...(options.readerApiV3BaseUrl ? { readerApiV3BaseUrl: options.readerApiV3BaseUrl } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
    },

    async *listItems(
      listOptions: SourceConnectorListOptions = {},
    ): AsyncIterable<SourceConnectorListPage> {
      await connector.authenticate();
      const limit = normalizeOptionalLimit(listOptions.limit);
      let remaining = limit ?? Number.POSITIVE_INFINITY;
      let state = decodeCursor(listOptions.cursor);
      const requestedProviderPages = new Set<string>();
      // Fixed for the whole run: the watermark this sweep is reading against.
      // It only changes between sweeps, never inside one.
      const updatedAfter = state.updatedAfter;
      let sweepMaxUpdatedAt = state.sweepMaxUpdatedAt;
      const carried = (): Pick<ReadwiseCursor, 'updatedAfter' | 'sweepMaxUpdatedAt'> => ({
        ...(updatedAfter ? { updatedAfter } : {}),
        ...(sweepMaxUpdatedAt ? { sweepMaxUpdatedAt } : {}),
      });

      while (state.phase === 'reader' && remaining > 0) {
        assertNewProviderPage(requestedProviderPages, state);
        const pageCursor = state.pageCursor;
        const offset = state.itemOffset ?? 0;
        const page = await client!.listReaderDocuments({
          ...(pageCursor ? { pageCursor } : {}),
          ...(updatedAfter ? { updatedAfter } : {}),
          limit: Math.min(pageSize, remaining),
          withHtmlContent: true,
          withRawSourceUrl: true,
        });
        const fetchedAt = validDate(now()).toISOString();
        const available = dedupeItems(page.results.flatMap((document) => {
          const item = rawItemFromReaderDocument(document, account, fetchedAt);
          return item ? [item] : [];
        })).slice(offset);
        const items = available.slice(0, remaining);
        for (const item of items) byLocalId.set(item.identity.localItemId, item);
        remaining -= items.length;
        sweepMaxUpdatedAt = advanceWatermark(sweepMaxUpdatedAt, items);

        if (items.length < available.length) {
          // The budget ran out inside this page. Stay on it.
          state = {
            phase: 'reader',
            ...(pageCursor ? { pageCursor } : {}),
            itemOffset: offset + items.length,
            ...carried(),
          };
          yield { items, nextCursor: encodeCursor(state), done: false, truncated: true };
          return;
        }
        state = page.nextPageCursor
          ? { phase: 'reader', pageCursor: page.nextPageCursor, ...carried() }
          : { phase: 'export', ...carried() };
        yield { items, nextCursor: encodeCursor(state), done: false };
        if (remaining <= 0) return;
      }

      while (state.phase === 'export' && remaining > 0) {
        assertNewProviderPage(requestedProviderPages, state);
        const pageCursor = state.pageCursor;
        const offset = state.itemOffset ?? 0;
        const page = await client!.exportBooks({
          ...(pageCursor ? { pageCursor } : {}),
          ...(updatedAfter ? { updatedAfter } : {}),
        });
        const fetchedAt = validDate(now()).toISOString();
        const available = dedupeItems(page.results.flatMap((book) =>
          rawItemsFromExportBook(book, account, fetchedAt)
        )).slice(offset);
        const items = available.slice(0, remaining);
        for (const item of items) byLocalId.set(item.identity.localItemId, item);
        remaining -= items.length;
        sweepMaxUpdatedAt = advanceWatermark(sweepMaxUpdatedAt, items);

        if (items.length < available.length) {
          // The defect this connector was rebuilt around: one export page can
          // hold thousands of highlights, so a bounded run routinely stops
          // inside it. Reporting `done` here told the spine the page was fully
          // consumed, which cleared the checkpoint and restarted every later
          // pull at reader page 1. A cut page is never done.
          state = {
            phase: 'export',
            ...(pageCursor ? { pageCursor } : {}),
            itemOffset: offset + items.length,
            ...carried(),
          };
          yield { items, nextCursor: encodeCursor(state), done: false, truncated: true };
          return;
        }
        if (page.nextPageCursor) {
          state = { phase: 'export', pageCursor: page.nextPageCursor, ...carried() };
          yield { items, nextCursor: encodeCursor(state), done: false };
          if (remaining <= 0) return;
          continue;
        }
        // The sweep is complete. Publish the watermark on the done page: the
        // spine keeps a done page's cursor precisely so a high-water-mark
        // connector can hand the next sweep its starting point.
        const nextSweep = sweepMaxUpdatedAt ?? updatedAfter;
        yield {
          items,
          ...(nextSweep ? { nextCursor: encodeCursor({ phase: 'reader', updatedAfter: nextSweep }) } : {}),
          done: true,
        };
        return;
      }
    },

    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = byLocalId.get(localItemId);
      if (!item) throw new Error('Readwise connector cannot fetch an unknown item.');
      return item;
    },

    classify(_item: RawItem): SourceSensitivity {
      return buildSourceSensitivity({ trustTier: 'S1', trustDomain: 'internal' });
    },

    requestBudgetStatus: () => requestBudget.status(),
  };
  return connector;
}

export function createReadwiseConnectorStore(
  dbPath = defaultReadwiseConnectorStoreDbPath(),
): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath,
    corpusId: READWISE_LIBRARY_CORPUS_ID,
    family: 'readwise',
    trustDomain: 'internal',
  });
}

export function defaultReadwiseConnectorStoreDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.OLYMPUS_SOURCE_INDEX_READWISE_CONNECTOR_STORE_DB_PATH?.trim();
  if (configured) return configured;
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'readwise-connector-store.sqlite');
}

export function readwiseDailyRequestBudgetFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env[READWISE_DAILY_REQUEST_BUDGET_ENV];
  const parsed = value?.trim() ? Number(value) : DEFAULT_READWISE_DAILY_REQUEST_BUDGET;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${READWISE_DAILY_REQUEST_BUDGET_ENV} must be a positive integer.`);
  }
  return parsed;
}

function rawItemFromReaderDocument(
  document: ReadwiseReaderDocument,
  account: string,
  fetchedAt: string,
): RawItem | undefined {
  const providerItemId = optionalId(document.id);
  if (!providerItemId) return undefined;
  const documentId = providerItemId;
  const title = optionalString(document.title) ?? `Readwise document ${providerItemId}`;
  const author = optionalString(document.author);
  const tags = tagNames(document.tags);
  const sourceUrl = optionalString(document.source_url) ?? optionalString(document.url);
  const readwiseUrl = optionalString(document.readwise_url);
  const locatorUri = sourceUrl ?? readwiseUrl;
  const authoredAt = optionalString(document.created_at);
  const updatedAt = optionalString(document.updated_at);
  const text = joinText([
    optionalString(document.summary),
    optionalString(document.notes) ?? optionalString(document.document_note),
    optionalString(document.html_content),
  ]);
  return rawItem({
    account,
    providerItemId,
    documentId,
    itemKind: 'document',
    title,
    tags,
    ...(author ? { author } : {}),
    ...(locatorUri ? { locatorUri } : {}),
    ...(authoredAt ? { authoredAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    text,
    fetchedAt,
    metadata: {
      ...(optionalString(document.category) ? { category: optionalString(document.category) } : {}),
      ...(optionalString(document.location) ? { location: optionalString(document.location) } : {}),
    },
  });
}

function rawItemsFromExportBook(
  book: ReadwiseExportBook,
  account: string,
  fetchedAt: string,
): RawItem[] {
  const bookId = optionalId(book.user_book_id) ?? optionalId(book.id);
  const title = optionalString(book.title) ?? optionalString(book.readable_title) ?? 'Readwise highlight';
  const author = optionalString(book.author);
  const sourceUrl = optionalString(book.source_url);
  const readwiseUrl = optionalString(book.readwise_url);
  const locatorUri = sourceUrl ?? readwiseUrl;
  const bookTags = tagNames(book.book_tags).concat(tagNames(book.tags));
  const highlights = Array.isArray(book.highlights) ? book.highlights : [];
  return highlights.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const highlight = value as Record<string, unknown>;
    const providerItemId = optionalId(highlight.id);
    if (!providerItemId) return [];
    const highlightedAt = optionalString(highlight.highlighted_at);
    const updatedAt = optionalString(highlight.updated_at) ?? highlightedAt;
    const tags = dedupeStrings([...bookTags, ...tagNames(highlight.tags)]);
    const text = joinText([
      optionalString(highlight.text),
      optionalString(highlight.note),
    ]);
    return [rawItem({
      account,
      providerItemId,
      documentId: bookId ?? providerItemId,
      itemKind: 'highlight',
      title,
      tags,
      ...(author ? { author } : {}),
      ...(locatorUri ? { locatorUri } : {}),
      ...(highlightedAt ? { authoredAt: highlightedAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      text,
      fetchedAt,
      metadata: {
        ...(optionalString(book.category) ? { category: optionalString(book.category) } : {}),
      },
    })];
  });
}

function rawItem(input: {
  account: string;
  providerItemId: string;
  documentId: string;
  itemKind: 'document' | 'highlight';
  title: string;
  author?: string;
  tags: string[];
  locatorUri?: string;
  authoredAt?: string;
  updatedAt?: string;
  text: string;
  fetchedAt: string;
  metadata: Record<string, unknown>;
}): RawItem {
  const documentScope = `document:${input.documentId}`;
  const localItemId =
    `${input.account}:${input.itemKind}:${input.providerItemId}`;
  return {
    identity: {
      family: 'readwise',
      provider: READWISE_PROVIDER,
      accountScope: input.account,
      providerItemId: input.providerItemId,
      providerThreadId: documentScope,
      providerConversationId: documentScope,
      localItemId,
      ...(input.updatedAt ? { sourceVersion: input.updatedAt } : {}),
    },
    mimeType: 'text/plain; charset=utf-8',
    content: input.text
      ? { kind: 'text', text: input.text }
      : { kind: 'metadata_only' },
    metadata: Object.freeze({
      title: input.title,
      aliases: dedupeStrings([
        'Readwise',
        input.itemKind === 'highlight' ? 'Readwise highlight' : 'Readwise Reader',
        ...(input.author ? [input.author] : []),
        ...input.tags,
      ]),
      itemKind: input.itemKind,
      documentId: input.documentId,
      ...(input.author ? { author: input.author } : {}),
      ...(input.tags.length > 0 ? { tags: input.tags } : {}),
      ...(input.locatorUri ? { locatorUri: input.locatorUri, url: input.locatorUri } : {}),
      ...(input.authoredAt ? { authoredAt: input.authoredAt } : {}),
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
      ...input.metadata,
      contentHash: createHash('sha256').update(JSON.stringify({
        text: input.text,
        title: input.title,
        author: input.author,
        tags: input.tags,
        locatorUri: input.locatorUri,
        documentScope,
      })).digest('hex'),
    }),
    fetchedAt: input.fetchedAt,
  };
}

/**
 * Cheap local validation of a resume cursor. A checkpoint carried across days
 * or store generations must be provable before it is spent on provider I/O;
 * an unparseable one falls back to a fresh traversal instead of failing a run.
 */
export function isReadwiseConnectorCursor(value: string | undefined): boolean {
  if (!value) return false;
  try {
    decodeCursor(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a checkpoint sits BETWEEN sweeps rather than inside one.
 *
 * A completed sweep still leaves a checkpoint behind: the done page publishes
 * the next sweep's watermark, which is why "checkpoint is absent" cannot mean
 * "traversal complete" on this lane. Only a reader-phase cursor carrying
 * neither a provider page cursor nor an item offset is a sweep boundary —
 * the reader-to-export transition cursor carries neither either, so the phase
 * term is load-bearing rather than redundant.
 *
 * Fails closed: a cursor that cannot be decoded proves nothing, so it is not a
 * boundary and no receipt built on this may claim a complete traversal.
 */
export function readwiseCursorIsSweepBoundary(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const cursor = decodeCursor(value);
    return cursor.phase === 'reader'
      && cursor.pageCursor === undefined
      && cursor.itemOffset === undefined;
  } catch {
    return false;
  }
}

function encodeCursor(cursor: ReadwiseCursor): string {
  return `rw1:${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
}

function decodeCursor(value: string | undefined): ReadwiseCursor {
  if (!value) return { phase: 'reader' };
  if (value.length > MAX_CURSOR_LENGTH || !value.startsWith('rw1:')) {
    throw new TypeError('Readwise connector cursor is invalid.');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(4), 'base64url').toString('utf8')) as {
      phase?: unknown;
      pageCursor?: unknown;
      itemOffset?: unknown;
      updatedAfter?: unknown;
      sweepMaxUpdatedAt?: unknown;
    };
    if (
      (parsed.phase !== 'reader' && parsed.phase !== 'export')
      || (parsed.pageCursor !== undefined && (
        typeof parsed.pageCursor !== 'string'
        || !parsed.pageCursor.trim()
        || parsed.pageCursor.length > MAX_CURSOR_LENGTH
      ))
      // A bad offset is worse than no offset: it would skip real items
      // silently. Refuse it and let the caller fall back to a fresh traversal.
      || (parsed.itemOffset !== undefined && (
        !Number.isSafeInteger(parsed.itemOffset)
        || (parsed.itemOffset as number) < 0
        || (parsed.itemOffset as number) > MAX_CURSOR_ITEM_OFFSET
      ))
      || !isOptionalTimestamp(parsed.updatedAfter)
      || !isOptionalTimestamp(parsed.sweepMaxUpdatedAt)
    ) {
      throw new Error('invalid');
    }
    return {
      phase: parsed.phase,
      ...(typeof parsed.pageCursor === 'string'
        ? { pageCursor: parsed.pageCursor.trim() }
        : {}),
      ...(typeof parsed.itemOffset === 'number' && parsed.itemOffset > 0
        ? { itemOffset: parsed.itemOffset }
        : {}),
      ...(typeof parsed.updatedAfter === 'string' ? { updatedAfter: parsed.updatedAfter } : {}),
      ...(typeof parsed.sweepMaxUpdatedAt === 'string'
        ? { sweepMaxUpdatedAt: parsed.sweepMaxUpdatedAt }
        : {}),
    };
  } catch {
    throw new TypeError('Readwise connector cursor is invalid.');
  }
}

function isOptionalTimestamp(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === 'string'
    && value.length <= MAX_TIMESTAMP_LENGTH
    && Number.isFinite(Date.parse(value));
}

/**
 * Highest provider `updatedAt` observed so far in this sweep. Compared as
 * instants, carried as the provider's own string so the value handed back to
 * the provider is one it issued rather than one we reformatted.
 */
function advanceWatermark(current: string | undefined, items: readonly RawItem[]): string | undefined {
  let best = current;
  let bestMs = current ? Date.parse(current) : Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const candidate = item.metadata['updatedAt'];
    if (typeof candidate !== 'string' || candidate.length > MAX_TIMESTAMP_LENGTH) continue;
    const candidateMs = Date.parse(candidate);
    if (!Number.isFinite(candidateMs) || candidateMs <= bestMs) continue;
    best = candidate;
    bestMs = candidateMs;
  }
  return best;
}

function assertNewProviderPage(seen: Set<string>, cursor: ReadwiseCursor): void {
  const key = `${cursor.phase}:${cursor.pageCursor ?? ''}`;
  if (seen.has(key)) throw new Error('Readwise connector pagination cursor repeated.');
  seen.add(key);
}

function dedupeItems(items: RawItem[]): RawItem[] {
  return [...new Map(items.map((item) => [
    `${item.identity.providerConversationId ?? ''}\0${item.identity.providerItemId}`,
    item,
  ])).values()];
}

function optionalId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return optionalString(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function tagNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return dedupeStrings(value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    return [
      optionalString(record.name)
        ?? optionalString(record.tag)
        ?? optionalString(record.label)
        ?? '',
    ];
  }));
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function joinText(values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).join('\n\n').trim();
}

function boundedPageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_READWISE_CONNECTOR_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new TypeError('Readwise connector page size must be an integer from 1 to 100.');
  }
  return value;
}

function normalizeOptionalLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return positiveInteger(value, 'Readwise connector list limit');
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function requireAccount(value: string): string {
  if (!value || value.length > MAX_ACCOUNT_LENGTH) {
    throw new TypeError('Readwise account must be bounded and non-empty.');
  }
  return value;
}

function validDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new TypeError('Readwise connector timestamp must be valid.');
  return value;
}

function nextUtcDay(date: Date): string {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  )).toISOString();
}

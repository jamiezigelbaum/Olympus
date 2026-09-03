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
import {
  createSourceExclusionMatcher,
  loadSourceIngestionExclusions,
  type SourceExclusionMatcher,
} from '../../core/source-ingestion-exclusions.ts';
import type { SourceSensitivity } from '../../core/source-index/types.ts';
import {
  createEnvCredentialBroker,
  requireBearerTokenCredentialSession,
  type CredentialBroker,
  type CredentialBrokerFetch,
} from '../credential-broker/index.ts';
import type { ConnectorStoreClassificationOptions } from '../connector-store/index.ts';
import {
  accountFromGoogleHandle,
  classifyGoogleItemRaiseOnly,
  loadGoogleSensitivityMap,
  metadataString,
  type GoogleItemClassifier,
} from './classification.ts';
import {
  GoogleDailyRequestBudget,
  GoogleRequestBudgetError,
  type GoogleRequestBudgetStatus,
} from './request-budget.ts';

export const GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID = 'internal.drive.docs';
export const GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID = 'secure_local.drive.docs';
export const GOOGLE_DRIVE_PROVIDER = 'google_drive';
export const DEFAULT_GOOGLE_DRIVE_SYNC_MAX_FILES = 200;
export const DEFAULT_GOOGLE_DRIVE_CONTENT_MAX_FILES = 50;
export const GOOGLE_DRIVE_DAILY_REQUEST_BUDGET_ENV =
  'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_DAILY_API_REQUEST_BUDGET';
export const GOOGLE_DRIVE_DAILY_REQUEST_BUDGET_STATE_PATH_ENV =
  'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_DAILY_API_REQUEST_BUDGET_STATE_PATH';
export const DEFAULT_GOOGLE_DRIVE_DAILY_REQUEST_BUDGET = 3_000;
const DEFAULT_GOOGLE_DRIVE_PAGE_SIZE = 100;
const DEFAULT_GOOGLE_DRIVE_MAX_TEXT_BYTES = 128_000;
const MAX_GOOGLE_DRIVE_SYNC_FILES = 1_000;
const GOOGLE_DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DOC_MIME_TYPE = 'application/vnd.google-apps.document';
const GOOGLE_DRIVE_CURSOR_PREFIX = 'gd1:';
const MAX_GOOGLE_DRIVE_CURSOR_LENGTH = 4_096;
const DEFAULT_GOOGLE_DRIVE_MAX_RETRIES = 3;
const MAX_GOOGLE_DRIVE_RETRY_DELAY_MS = 30_000;

export interface GoogleDriveSourceConnectorOptions {
  credentialBroker?: CredentialBroker;
  credentialHandle?: string;
  account?: string;
  fetch?: CredentialBrokerFetch;
  apiBaseUrl?: string;
  maxFiles?: number;
  maxContentFiles?: number;
  maxTextBytes?: number;
  query?: string;
  sensitivityMap?: SensitivityMap;
  classifier?: GoogleItemClassifier;
  apiClient?: GoogleDriveApiClient;
  /**
   * The runtime's single day counter. Optional only so the owner-facing
   * one-shot surfaces and tests can build a connector without one; the runtime
   * construction seam always supplies it, so one process can never quietly run
   * two independent counters against the same provider quota.
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
  /**
   * The owner's folder-exclusion gate for this source.
   *
   * The connector needs it for two reasons the store gate cannot serve. It
   * decides whether to spend provider requests resolving ancestry at all — a
   * traversal with no identity rules must not pay for a walk nobody will read.
   * And it lets an excluded file skip its CONTENT read, which is the expensive
   * half: the store gate refuses the item either way, but only the connector
   * can refuse it before the download.
   */
  exclusions?: SourceExclusionMatcher;
}

/**
 * Opaque, validated resume point for one bounded Drive traversal.
 *
 * `watermark` is the `modifiedTime` lower bound the traversal is running under
 * and never moves while it is in flight — advancing it mid-traversal would skip
 * every file the remaining pages still owe. `highWater` accumulates the newest
 * `modifiedTime` seen so far and is promoted to the next traversal's watermark
 * only on a page that actually completed the traversal. `pageToken` is present
 * exactly when the run stopped mid-traversal, which is also how a reader tells
 * "resume this slice" from "start the next incremental pass".
 *
 * `deferredFloor` is the earliest `modifiedTime` whose content this traversal
 * owes but could not read. It rides the cursor because deferrals accumulate
 * across the many bounded pulls that precede the one completing page, and the
 * promotion has to stay below it.
 */
interface GoogleDriveCursor {
  watermark?: string;
  highWater?: string;
  pageToken?: string;
  deferredFloor?: string;
}

/**
 * Raw bytes for one Drive file, exactly as the provider served them.
 *
 * `sizeBytes` is the length actually read, never a declared header value: the
 * consumer of this is an extractor, and a length that disagrees with the
 * buffer is worse than no length at all.
 */
export interface GoogleDriveFileBytes {
  bytes: Uint8Array;
  mimeType?: string;
  sizeBytes: number;
}

export interface GoogleDriveApiClient {
  listFiles(request: GoogleDriveListFilesRequest): Promise<GoogleDriveListFilesResponse>;
  exportGoogleDocText(fileId: string, maxBytes: number): Promise<string>;
  downloadTextFile(fileId: string, maxBytes: number): Promise<string>;
  /**
   * Byte-exact download for the file-extraction lane.
   *
   * Separate from `downloadTextFile` because that method decodes through
   * `Response.text()` and then slices by characters. Both steps corrupt a PDF
   * or an image: the decode replaces every invalid UTF-8 sequence, and the
   * slice cuts at a character boundary that has no relationship to a byte
   * ceiling. This method decodes nothing and measures in bytes.
   *
   * `maxBytes` is a refusal, not a truncation. Half a PDF is not a smaller
   * PDF, and an extractor handed one would report a corrupt file rather than
   * an oversized one.
   */
  downloadFileBytes(fileId: string, maxBytes?: number): Promise<GoogleDriveFileBytes>;
  /**
   * One folder's own id, name and parents — the single step of an ancestry
   * walk.
   *
   * Optional on the interface, required in practice by anything that resolves
   * ancestry. Optional because a client that cannot answer it must produce an
   * UNRESOLVED ancestry rather than a partial one, and "the method is missing"
   * is simply the first way resolution fails. It is never a reason to admit an
   * item.
   */
  getFolder?(folderId: string): Promise<GoogleDriveFolder>;
}

/**
 * One folder as the ancestry walk needs it. `parents` absent means the walk
 * reached a root — a Drive root or a shared drive — and stops.
 */
export interface GoogleDriveFolder {
  id: string;
  name?: string;
  parents?: string[];
}

/**
 * A Drive file whose bytes exceed the caller's ceiling.
 */
export class GoogleDriveContentTooLargeError extends Error {
  constructor() {
    super('Google Drive file exceeds the configured byte ceiling.');
    this.name = 'GoogleDriveContentTooLargeError';
  }
}

/**
 * A Drive API request that failed with a status. Carrying the status lets a
 * caller classify the failure without parsing the message, which is the only
 * way to keep provider text out of anything durable.
 */
export class GoogleDriveApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GoogleDriveApiError';
    this.status = status;
  }
}

export interface GoogleDriveListFilesRequest {
  pageSize: number;
  pageToken?: string;
  query?: string;
}

export interface GoogleDriveListFilesResponse {
  files: GoogleDriveFile[];
  nextPageToken?: string;
}

export interface GoogleDriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
  version?: string;
  driveId?: string;
  parents?: string[];
  owners?: Array<{ emailAddress?: string }>;
  webViewLink?: string;
  size?: string;
  md5Checksum?: string;
}

/**
 * One listed file, and whether this run still owes its text.
 *
 * Deferred means the content read did not happen or did not settle — the cap
 * skipped it, or the provider refused it in a way that a later run can retry.
 * It is NOT set for a file there was never text to read, or for an excluded
 * one; those are answers, and treating them as owed would pin the watermark.
 */
interface GoogleDriveListedFile {
  item: RawItem;
  contentDeferred: boolean;
}

interface GoogleDriveContentRead {
  text?: string;
  deferred?: boolean;
}

export interface GoogleDriveSourceConnectorTraversalStatus {
  /** Content reads this run spent against the per-run cap. */
  contentReads: number;
  contentReadCap: number;
  /**
   * Content reads that failed after retry. `tryReadText` degrades a failed read
   * to metadata_only, which used to be completely silent — a 429 storm looked
   * identical to a directory of unindexable file types.
   */
  contentReadFailures: number;
}

export class GoogleDriveSourceConnector implements SourceConnector {
  readonly id = GOOGLE_DRIVE_PROVIDER;
  readonly family = 'file' as const;
  private readonly credentialBroker: CredentialBroker;
  private readonly credentialHandle: string;
  private readonly account: string;
  private readonly fetchImpl: CredentialBrokerFetch;
  private readonly apiBaseUrl: string;
  private readonly defaultMaxFiles: number;
  private readonly maxContentFiles: number;
  private readonly maxTextBytes: number;
  private readonly query: string | undefined;
  private readonly sensitivityMap: SensitivityMap | undefined;
  private readonly classifier: GoogleItemClassifier | undefined;
  private readonly requestBudget: GoogleDailyRequestBudget | undefined;
  private readonly provenance: SourceInvocationProvenance;
  private readonly maxRetries: number | undefined;
  private readonly sleepImpl: ((ms: number) => Promise<void>) | undefined;
  private readonly injectedClient: GoogleDriveApiClient | undefined;
  private client: GoogleDriveApiClient | undefined;
  private contentReads = 0;
  private contentReadFailures = 0;
  private readonly itemsByLocalId = new Map<string, RawItem>();
  private readonly exclusions: SourceExclusionMatcher | undefined;
  private ancestry: GoogleDriveFolderAncestry | undefined;

  constructor(options: GoogleDriveSourceConnectorOptions = {}) {
    const env = options.env ?? process.env;
    this.fetchImpl = options.fetch ?? fetch;
    this.credentialBroker = options.credentialBroker ?? createEnvCredentialBroker({
      env,
      fetch: this.fetchImpl,
    });
    this.credentialHandle = options.credentialHandle?.trim()
      || env.OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CREDENTIAL_HANDLE?.trim()
      || 'google_drive.personal';
    this.account = options.account?.trim() || accountFromGoogleHandle(this.credentialHandle);
    this.apiBaseUrl = options.apiBaseUrl?.replace(/\/+$/, '') || GOOGLE_DRIVE_API_BASE_URL;
    this.defaultMaxFiles = normalizeDriveMaxFiles(options.maxFiles);
    this.maxContentFiles = normalizeDriveMaxFiles(options.maxContentFiles ?? DEFAULT_GOOGLE_DRIVE_CONTENT_MAX_FILES);
    this.maxTextBytes = normalizeMaxTextBytes(options.maxTextBytes);
    this.query = options.query?.trim() || env.OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_QUERY?.trim() || undefined;
    this.sensitivityMap = options.sensitivityMap ?? loadGoogleSensitivityMap(env);
    this.classifier = options.classifier;
    this.requestBudget = options.requestBudget;
    this.provenance = sourceInvocationProvenance(options.provenance);
    this.maxRetries = options.maxRetries;
    this.sleepImpl = options.sleep;
    this.injectedClient = options.apiClient;
    this.exclusions = options.exclusions;
  }

  async authenticate(): Promise<void> {
    await this.clientForRequest();
  }

  async *listItems(options: SourceConnectorListOptions = {}): AsyncIterable<SourceConnectorListPage> {
    const client = await this.clientForRequest();
    let remaining = normalizeDriveMaxFiles(options.limit ?? this.defaultMaxFiles);
    const resume = decodeDriveCursor(options.cursor);
    const watermark = resume.watermark;
    const query = this.queryForWatermark(watermark);
    let highWater = resume.highWater;
    let deferredFloor = resume.deferredFloor;
    let pageToken = resume.pageToken;
    const requestedPageTokens = new Set<string>();
    while (remaining > 0) {
      // The content cap bounds the traversal instead of downgrading files
      // inside a page. A page longer than the remaining content budget emitted
      // its tail as metadata_only AND raised the watermark past it, so nothing
      // ever listed those files again. Stopping on a page boundary keeps the
      // provider page token as an honest resume point, and the next bounded
      // pull builds a fresh connector with a fresh cap.
      const contentBudget = this.maxContentFiles - this.contentReads;
      if (contentBudget <= 0) break;
      if (pageToken) assertNewProviderPage(requestedPageTokens, pageToken);
      const page = await client.listFiles({
        pageSize: Math.min(DEFAULT_GOOGLE_DRIVE_PAGE_SIZE, remaining, contentBudget),
        ...(pageToken ? { pageToken } : {}),
        query,
      });
      const files = page.files.filter((file) => file.id);
      const items: RawItem[] = [];
      for (const file of files) {
        if (items.length >= remaining) break;
        const read = await this.rawItemFromDriveFile(file);
        this.itemsByLocalId.set(read.item.identity.localItemId, read.item);
        items.push(read.item);
        if (file.modifiedTime) {
          if (!highWater || file.modifiedTime.localeCompare(highWater) > 0) {
            highWater = file.modifiedTime;
          }
          if (read.contentDeferred && (!deferredFloor || file.modifiedTime.localeCompare(deferredFloor) < 0)) {
            deferredFloor = file.modifiedTime;
          }
        }
      }
      remaining -= items.length;
      pageToken = page.nextPageToken;
      // The traversal is complete only when the provider has no further page
      // AND the bound did not truncate this one. The shipped connector called
      // every bounded slice done, which told the spine that a partial window
      // was a full traversal.
      const pageTruncated = items.length < files.length;
      const done = !pageToken && !pageTruncated;
      const promoted = promotedDriveWatermark(highWater ?? watermark, deferredFloor, watermark);
      const nextCursor = done
        // A completed traversal hands forward only the promoted watermark, so
        // the next run asks the provider for changes instead of for the world.
        ? encodeDriveCursor(promoted ? { watermark: promoted } : {})
        : encodeDriveCursor({
          ...(watermark ? { watermark } : {}),
          ...(highWater ? { highWater } : {}),
          ...(deferredFloor ? { deferredFloor } : {}),
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
   * In-run cache, never a second provider round trip. Listing already decided
   * whether each file was within the content cap; deciding again here is what
   * made the cap decorative, because the spine calls fetchItem for every item
   * that listed as metadata_only.
   */
  async fetchItem(localItemId: string): Promise<RawItem> {
    const item = this.itemsByLocalId.get(localItemId);
    if (!item) {
      throw new Error(
        `Google Drive connector cannot fetch unknown item ${hashString(localItemId).slice(0, 16)}.`,
      );
    }
    return item;
  }

  /**
   * The provider client, for read-only owner tooling that has to ask Drive a
   * question the traversal does not model — resolving a folder name to its id,
   * for instance.
   *
   * Exposed rather than duplicated so such a tool inherits this connector's
   * credential handle, retry policy and daily request budget. A second client
   * built beside this one would be a second uncounted quota consumer, which is
   * the failure `budgetedDriveApiClient` exists to prevent.
   */
  apiClientForTooling(): Promise<GoogleDriveApiClient> {
    return this.clientForRequest();
  }

  traversalStatus(): GoogleDriveSourceConnectorTraversalStatus {
    return {
      contentReads: this.contentReads,
      contentReadCap: this.maxContentFiles,
      contentReadFailures: this.contentReadFailures,
    };
  }

  requestBudgetStatus(): GoogleRequestBudgetStatus | undefined {
    return this.requestBudget?.status();
  }

  classify(item: RawItem): SourceSensitivity {
    const title = metadataString(item.metadata, 'title') ?? metadataString(item.metadata, 'name');
    // Drive publishes no folder path, so the file's own name is the only
    // path-shaped signal it has. The sensitivity map's path patterns are
    // filename-shaped in practice — `password-manager-export` — and this
    // classifier is RAISE-ONLY, so feeding it the name can tighten a tier and
    // can never loosen one. Before this, the connector fed it a synthetic
    // `parentFolderId/Title` string; the name is the honest half of that, and
    // the folder-id half was never a classification signal to begin with.
    const path = metadataString(item.metadata, 'pathDisplay') ?? title;
    return classifyGoogleItemRaiseOnly({
      text: item.content.kind === 'text' ? item.content.text : '',
      ...(title ? { title } : {}),
      ...(path ? { path } : {}),
    }, {
      defaultTrustTier: 'S3',
      defaultTrustDomain: 'internal',
      ...(this.sensitivityMap ? { sensitivityMap: this.sensitivityMap } : {}),
      ...(this.classifier ? { classifier: this.classifier } : {}),
    });
  }

  private async rawItemFromDriveFile(file: GoogleDriveFile): Promise<GoogleDriveListedFile> {
    const title = file.name ?? file.id;
    // Ancestry BEFORE content. An excluded file must cost a folder walk and
    // nothing else: no export, no download, no chunk, no vector. Resolving
    // after the read would make the gate cosmetic — the material would already
    // have been pulled across the wire by the time anything refused it.
    const folderAncestorIds = await this.resolveFolderAncestry(file);
    const metadata = Object.freeze({
      title,
      name: title,
      mimeType: file.mimeType ?? 'application/octet-stream',
      ...(file.webViewLink ? { locatorUri: file.webViewLink, url: file.webViewLink } : {}),
      // Numeric so the media exclusion rules can judge it; Drive's API sends
      // size as a string. Absent or unparseable stays absent - the gate treats
      // sizeless items as unevaluable for media rules rather than guessing.
      ...(file.size !== undefined && Number.isFinite(Number(file.size)) ? { sizeBytes: Number(file.size) } : {}),
      ...(file.createdTime ? { authoredAt: file.createdTime } : {}),
      ...(file.modifiedTime ? { updatedAt: file.modifiedTime, serverModifiedAt: file.modifiedTime } : {}),
      ...(file.driveId ? { driveId: file.driveId } : {}),
      // `parents` stays: it is the provider's own immediate-parent list and
      // other consumers read it. What is GONE is the synthetic
      // `parentId/Title` pathDisplay this connector used to publish. That
      // string looked like a path to the exclusion gate and was not one — it
      // is built from opaque ids, so no prefix a human could write would ever
      // match it, and the gate returned "admitted" every time. A source with
      // no path must present NO path, so the gate reaches its unevaluable
      // branch and fails closed instead of quietly passing everything.
      ...(file.parents ? { parents: file.parents } : {}),
      // Present means resolved, absent means the walk failed. The exclusion
      // gate reads exactly that distinction.
      ...(folderAncestorIds ? { folderAncestorIds } : {}),
      ...(file.owners?.[0]?.emailAddress ? { ownerEmail: file.owners[0].emailAddress } : {}),
    });
    const excluded = this.exclusions?.evaluateMetadata(metadata).excluded === true;
    // An excluded file is a settled answer; a file the cap skipped is owed work.
    const read = excluded || this.contentReads >= this.maxContentFiles
      ? { deferred: !excluded }
      : await this.tryReadText(file);
    const text = read.text;
    if (text !== undefined) this.contentReads += 1;
    return {
      contentDeferred: read.deferred === true,
      item: {
        identity: {
          family: 'file',
          provider: GOOGLE_DRIVE_PROVIDER,
          accountScope: this.account,
          providerItemId: file.id,
          providerFileId: file.id,
          localItemId: `${this.account}:${file.id}`,
          ...(file.version ? { sourceVersion: file.version } : {}),
        },
        mimeType: file.mimeType ?? 'application/octet-stream',
        content: text?.trim() ? { kind: 'text', text } : { kind: 'metadata_only' },
        metadata: Object.freeze({
          ...metadata,
          ...(file.md5Checksum ? { contentHash: file.md5Checksum } : { contentHash: hashString(`${file.version ?? ''}:${text ?? title}`) }),
        }),
        fetchedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Resolve this file's folder ancestry, or undefined when it cannot be.
   *
   * Skipped entirely when no identity rule is configured: a traversal with only
   * path rules, or none, must not spend provider requests on a walk whose
   * answer nobody reads. Skipping is safe precisely because it is conditioned
   * on the gate having nothing to ask — not on the answer being convenient.
   */
  private async resolveFolderAncestry(file: GoogleDriveFile): Promise<string[] | undefined> {
    if (this.exclusions?.identityActive !== true) return undefined;
    const client = await this.clientForRequest();
    this.ancestry ??= new GoogleDriveFolderAncestry(client);
    return this.ancestry.resolve(file);
  }

  /**
   * A failed read degrades the file to metadata_only, which is the honest
   * outcome for an unsupported or oversized file. It must never swallow the
   * daily guard: a parked budget has to reach the scheduler as a deferral, not
   * disappear into a corpus of silently empty documents.
   */
  private async tryReadText(file: GoogleDriveFile): Promise<GoogleDriveContentRead> {
    const client = await this.clientForRequest();
    try {
      if (file.mimeType === GOOGLE_DOC_MIME_TYPE) {
        return { text: await client.exportGoogleDocText(file.id, this.maxTextBytes) };
      }
      if (isDownloadableTextMime(file.mimeType, file.name) && withinTextByteCap(file.size, this.maxTextBytes)) {
        return { text: await client.downloadTextFile(file.id, this.maxTextBytes) };
      }
    } catch (error) {
      if (error instanceof GoogleRequestBudgetError) throw error;
      this.contentReadFailures += 1;
      // A rate-limited or server-side refusal is owed work: the file has text,
      // this run just could not get it, so the watermark must not move past it.
      // Every other refusal (403, 404, an export the API will never serve) is a
      // settled answer, and deferring on those would stall the lane forever.
      return { deferred: isRetryableDriveContentError(error) };
    }
    // Nothing to read: an unsupported mime or an oversized file is not owed.
    return {};
  }

  private async clientForRequest(): Promise<GoogleDriveApiClient> {
    if (this.client) return this.client;
    if (this.injectedClient) {
      // An injected client owns no retry transport, so each method invocation
      // is exactly one provider attempt and the wrapper remains exact.
      this.client = this.requestBudget
        ? budgetedDriveApiClient(this.injectedClient, this.requestBudget, this.provenance)
        : this.injectedClient;
      return this.client;
    }
    // The REST transport owns the retry loop, so it also owns accounting.
    this.client = await this.restClient();
    return this.client;
  }

  private async restClient(): Promise<GoogleDriveApiClient> {
    const session = requireBearerTokenCredentialSession(await this.credentialBroker.issueSession({
      handle: this.credentialHandle,
      provider: GOOGLE_DRIVE_PROVIDER,
      capability: 'google_drive.docs.sync',
      trustDomain: 'internal',
    }), this.credentialHandle);
    return new RestGoogleDriveApiClient({
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
   * The provider bound for this traversal. The watermark is inlined into the
   * Drive query language, so it is re-serialized from a parsed Date at decode
   * time and can never carry a quote out of a stored cursor.
   */
  private queryForWatermark(watermark: string | undefined): string {
    const base = this.query ?? 'trashed = false';
    return watermark ? `modifiedTime > '${watermark}' and (${base})` : base;
  }
}

export function googleDriveConnectorStoreClassification(
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
 */
export function isGoogleDriveConnectorCursor(value: string | undefined): boolean {
  if (!value) return false;
  try {
    decodeDriveCursor(value);
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
export function googleDriveCursorIsMidTraversal(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return decodeDriveCursor(value).pageToken !== undefined;
  } catch {
    return false;
  }
}

export function createGoogleDriveDailyRequestBudget(options: {
  env?: Record<string, string | undefined>;
  statePath?: string;
  now?: () => Date;
} = {}): GoogleDailyRequestBudget {
  const env = options.env ?? process.env;
  return new GoogleDailyRequestBudget({
    provider: 'Google Drive',
    dailyRequestBudget: googleDriveDailyRequestBudgetFromEnv(env),
    statePath: options.statePath?.trim() || defaultGoogleDriveRequestBudgetStatePath(env),
    ...(options.now ? { now: options.now } : {}),
  });
}

export function googleDriveDailyRequestBudgetFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env[GOOGLE_DRIVE_DAILY_REQUEST_BUDGET_ENV];
  const parsed = value?.trim() ? Number(value) : DEFAULT_GOOGLE_DRIVE_DAILY_REQUEST_BUDGET;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${GOOGLE_DRIVE_DAILY_REQUEST_BUDGET_ENV} must be a positive integer.`);
  }
  return parsed;
}

export function defaultGoogleDriveRequestBudgetStatePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env[GOOGLE_DRIVE_DAILY_REQUEST_BUDGET_STATE_PATH_ENV]?.trim();
  if (configured) return configured;
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'google-drive-daily-request-budget.json');
}

/**
 * A REST Drive client over an injected fetch.
 *
 * Exported so the transport can be exercised directly. The file-extraction
 * lane depends on properties that live only here — that a download is not
 * decoded as text, and that its byte ceiling is measured in bytes — and a test
 * that reached this code only through the connector could not observe either.
 */
export function createRestGoogleDriveApiClient(options: {
  token: string;
  fetch: CredentialBrokerFetch;
  baseUrl?: string;
  requestBudget?: GoogleDailyRequestBudget;
  /** Omitted is 'scheduled': a caller that does not state operator does not get one. */
  provenance?: SourceInvocationProvenance;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}): GoogleDriveApiClient {
  return new RestGoogleDriveApiClient({
    token: options.token,
    fetch: options.fetch,
    baseUrl: options.baseUrl ?? GOOGLE_DRIVE_API_BASE_URL,
    ...(options.requestBudget ? { requestBudget: options.requestBudget } : {}),
    provenance: sourceInvocationProvenance(options.provenance),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
}

/**
 * Wrap a client so every provider request reserves against the day counter.
 *
 * Exported for the same reason: a method this wrapper does not know about is a
 * silent under-count of the daily budget, and that is only provable from
 * outside.
 */
export function budgetedDriveApiClient(
  inner: GoogleDriveApiClient,
  budget: GoogleDailyRequestBudget,
  // Bound at wrap time, from the connector that owns one run. A budget shared
  // by the whole process cannot hold this: it would leak one run's exemption
  // into whatever ran next. Omitted is 'scheduled'.
  provenance?: SourceInvocationProvenance,
): GoogleDriveApiClient {
  const runProvenance = sourceInvocationProvenance(provenance);
  return {
    listFiles(request) {
      budget.reserve(runProvenance);
      return inner.listFiles(request);
    },
    exportGoogleDocText(fileId, maxBytes) {
      budget.reserve(runProvenance);
      return inner.exportGoogleDocText(fileId, maxBytes);
    },
    downloadTextFile(fileId, maxBytes) {
      budget.reserve(runProvenance);
      return inner.downloadTextFile(fileId, maxBytes);
    },
    downloadFileBytes(fileId, maxBytes) {
      budget.reserve(runProvenance);
      return inner.downloadFileBytes(fileId, maxBytes);
    },
    // Spread rather than declared, so a client without the method stays without
    // it. Declaring it unconditionally would make every client claim it can
    // resolve ancestry and turn a missing capability into a runtime failure
    // instead of the fail-closed exclusion it is meant to be.
    ...(inner.getFolder
      ? {
        getFolder(folderId: string) {
          budget.reserve(runProvenance);
          return inner.getFolder!(folderId);
        },
      }
      : {}),
  };
}

/**
 * The maximum number of folders one file's ancestry walk may look up.
 *
 * A ceiling rather than a trust: Drive parenthood is a DAG, not a tree, and a
 * pathological or adversarial graph could otherwise spend the day's whole
 * request budget on one file. Hitting the ceiling is treated as UNRESOLVED, so
 * the ceiling can only ever cost an inclusion, never cause one.
 */
const GOOGLE_DRIVE_MAX_ANCESTRY_LOOKUPS = 64;

/**
 * Resolves a Drive file's full folder ancestry: every folder it is reachable
 * through, at any depth, as provider ids.
 *
 * Ids, not names, because a Drive folder keeps its id across a rename and a
 * move. An exclusion written against a name would stop matching the moment the
 * owner tidied their Drive, and an exclusion that stops matching admits the
 * material it was written to keep out — silently. That is the failure this
 * whole primitive exists to prevent, so the stable handle is the one used.
 *
 * MULTI-PARENT: Drive files can historically sit under several parents at once,
 * so the walk unions ALL of them. Reachability through an excluded folder is
 * sufficient to exclude, even when another parent is perfectly ordinary. The
 * alternative — requiring every path to be excluded — would let one extra
 * parent anywhere in the graph re-admit the file, which is an override channel
 * by another name.
 *
 * The cache lives for the traversal, so a folder is fetched once no matter how
 * many files sit under it. That is what keeps ancestry affordable against the
 * daily request budget.
 */
export class GoogleDriveFolderAncestry {
  private readonly client: GoogleDriveApiClient;
  private readonly parentsByFolderId = new Map<string, string[] | undefined>();
  private lookups = 0;
  private failures = 0;

  constructor(client: GoogleDriveApiClient) {
    this.client = client;
  }

  /** Ancestry walks that ended unresolved this run. Reported, never swallowed. */
  get unresolvedCount(): number {
    return this.failures;
  }

  /**
   * The ancestor folder ids of one file, or undefined when the walk could not
   * be completed.
   *
   * Undefined is the ONLY failure signal, and callers turn it into an
   * exclusion. A partial list is never returned: a walk that stopped early
   * looks exactly like a clean file whose ancestry happens not to contain the
   * excluded folder, and that is precisely the silent admission being designed
   * out.
   *
   * An EMPTY array is a resolved answer, not a failure. A file the provider
   * reports with no parents at all — the shared-with-me case — genuinely sits
   * under none of the owner's folders. The provider answered; the answer was
   * "none". That is not ambiguity, in the same way that configuring no
   * exclusions is not ambiguity.
   */
  async resolve(file: { parents?: string[] }): Promise<string[] | undefined> {
    const seen = new Set<string>();
    const queue = [...(file.parents ?? [])];
    let budget = GOOGLE_DRIVE_MAX_ANCESTRY_LOOKUPS;
    while (queue.length > 0) {
      const folderId = queue.shift()!;
      if (!folderId || seen.has(folderId)) continue;
      seen.add(folderId);
      if (budget <= 0) {
        this.failures += 1;
        return undefined;
      }
      budget -= 1;
      const parents = await this.parentsOf(folderId);
      if (parents === FOLDER_LOOKUP_FAILED) {
        this.failures += 1;
        return undefined;
      }
      queue.push(...parents);
    }
    return [...seen];
  }

  private async parentsOf(folderId: string): Promise<string[] | typeof FOLDER_LOOKUP_FAILED> {
    if (this.parentsByFolderId.has(folderId)) {
      const cached = this.parentsByFolderId.get(folderId);
      return cached ?? FOLDER_LOOKUP_FAILED;
    }
    if (!this.client.getFolder) {
      // Cached as a failure so a client that cannot walk does not re-attempt
      // once per file. The exclusion outcome is identical either way.
      this.parentsByFolderId.set(folderId, undefined);
      return FOLDER_LOOKUP_FAILED;
    }
    this.lookups += 1;
    try {
      const folder = await this.client.getFolder(folderId);
      const parents = folder.parents ?? [];
      this.parentsByFolderId.set(folderId, parents);
      return parents;
    } catch {
      // Every failure is the same failure here: a 404 for a deleted parent, a
      // 403 for a folder shared without its ancestors, a timeout. None of them
      // is evidence that the file is outside an excluded folder, so none of
      // them may produce an ancestry.
      this.parentsByFolderId.set(folderId, undefined);
      return FOLDER_LOOKUP_FAILED;
    }
  }
}

const FOLDER_LOOKUP_FAILED = Symbol('google-drive-folder-lookup-failed');

function encodeDriveCursor(cursor: GoogleDriveCursor): string | undefined {
  if (!cursor.watermark && !cursor.highWater && !cursor.pageToken && !cursor.deferredFloor) {
    return undefined;
  }
  return `${GOOGLE_DRIVE_CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
}

/**
 * The watermark a completed traversal is allowed to promote.
 *
 * Promotion is what makes the next pass incremental, and it is also what makes
 * a skipped file unreachable: the query is `modifiedTime > watermark` and no
 * repair lane re-reads Drive content. So a traversal that still owes a file's
 * text stops one millisecond short of it, and never moves backwards past the
 * watermark it ran under.
 *
 * The deferral buys exactly one retry cycle, not standing credit. A refusal
 * that recurs on every run — a Doc whose export keeps 500ing, a quota that
 * 429s the first content read of each pass — would otherwise be a fixed point:
 * the clamp re-lists the same file, it refuses again, and the same clamp comes
 * back, so the lane spends its whole content budget re-reading indexed files
 * and never advances. Arriving at a watermark that already equals this floor
 * is the proof that the previous completed traversal clamped here and the
 * retry was spent, so the file is left indexed as metadata_only (and counted
 * in `contentReadFailures`) and the lane moves on.
 */
function promotedDriveWatermark(
  candidate: string | undefined,
  deferredFloor: string | undefined,
  watermark: string | undefined,
): string | undefined {
  if (!candidate || !deferredFloor) return candidate;
  const floor = new Date(Date.parse(deferredFloor) - 1).toISOString();
  if (watermark === floor) return candidate;
  const clamped = floor.localeCompare(candidate) < 0 ? floor : candidate;
  return watermark && clamped.localeCompare(watermark) < 0 ? watermark : clamped;
}

function isRetryableDriveContentError(error: unknown): boolean {
  return error instanceof GoogleDriveApiError && (error.status === 429 || error.status >= 500);
}

function decodeDriveCursor(value: string | undefined): GoogleDriveCursor {
  if (!value) return {};
  if (value.length > MAX_GOOGLE_DRIVE_CURSOR_LENGTH || !value.startsWith(GOOGLE_DRIVE_CURSOR_PREFIX)) {
    throw new TypeError('Google Drive connector cursor is invalid.');
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(GOOGLE_DRIVE_CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    ) as { watermark?: unknown; highWater?: unknown; pageToken?: unknown; deferredFloor?: unknown };
    const watermark = decodeCursorTimestamp(parsed.watermark);
    const highWater = decodeCursorTimestamp(parsed.highWater);
    const deferredFloor = decodeCursorTimestamp(parsed.deferredFloor);
    if (
      parsed.pageToken !== undefined
      && (
        typeof parsed.pageToken !== 'string'
        || !parsed.pageToken.trim()
        || parsed.pageToken.length > MAX_GOOGLE_DRIVE_CURSOR_LENGTH
      )
    ) {
      throw new Error('invalid');
    }
    return {
      ...(watermark ? { watermark } : {}),
      ...(highWater ? { highWater } : {}),
      ...(deferredFloor ? { deferredFloor } : {}),
      ...(typeof parsed.pageToken === 'string' ? { pageToken: parsed.pageToken.trim() } : {}),
    };
  } catch {
    throw new TypeError('Google Drive connector cursor is invalid.');
  }
}

function decodeCursorTimestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('invalid');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('invalid');
  return new Date(parsed).toISOString();
}

function assertNewProviderPage(seen: Set<string>, pageToken: string): void {
  if (seen.has(pageToken)) throw new Error('Google Drive connector pagination cursor repeated.');
  seen.add(pageToken);
}

/**
 * The source key this connector's exclusion rules are written against. Same
 * shape as the Dropbox key, so an owner names a source once and uses that name
 * everywhere.
 */
export const GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE = 'google_drive.personal';

/**
 * What a Drive exclusion can be expressed as.
 *
 * Folder identity only, and the omission of `path_prefix` is the whole point of
 * this WO. Drive does not publish a folder path: a file carries opaque parent
 * ids, and the connector's old synthetic `parentId/Title` string was a path in
 * shape only. A prefix rule written against real folder names — which is what
 * a person writes — could never match it, so the gate answered "admitted" for
 * every Drive item and did so in complete silence.
 *
 * Declaring the capability converts that silence into a refusal. A rule that
 * NAMES this source and offers only prefixes is rejected when the matcher is
 * built, before a single file is read, with a message saying what to write
 * instead. A blanket rule that named no source is not rejected — see
 * createSourceExclusionMatcher — but its prefixes still cannot match a Drive
 * item, so those items come out unevaluable and are excluded and counted.
 * Neither route can end in a quiet admission.
 */
export const GOOGLE_DRIVE_ENFORCEABLE_EXCLUSION_CRITERIA = ['folder_id', 'media'] as const;

/**
 * The folder-exclusion gate for Drive, built from the owner's own config.
 *
 * A parse failure is NOT caught. An owner whose exclusion list cannot be read
 * must not get a store that silently ingests everything; refusing to open is
 * the fail-closed answer, and it is loud.
 */
export function googleDriveIngestionExclusionMatcher(
  env: Record<string, string | undefined> = process.env,
): SourceExclusionMatcher {
  return createSourceExclusionMatcher(
    loadSourceIngestionExclusions({ env }),
    GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE,
    { enforceable: GOOGLE_DRIVE_ENFORCEABLE_EXCLUSION_CRITERIA },
  );
}

export function defaultGoogleDriveConnectorStoreDbPath(env: Record<string, string | undefined> = process.env): string {
  if (env.OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CONNECTOR_STORE_DB_PATH?.trim()) {
    return env.OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CONNECTOR_STORE_DB_PATH.trim();
  }
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'google-drive-connector-store.sqlite');
}

export function defaultGoogleDriveSecureConnectorStoreDbPath(env: Record<string, string | undefined> = process.env): string {
  if (env.OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_SECURE_CONNECTOR_STORE_DB_PATH?.trim()) {
    return env.OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_SECURE_CONNECTOR_STORE_DB_PATH.trim();
  }
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'google-drive-secure-connector-store.sqlite');
}

class RestGoogleDriveApiClient implements GoogleDriveApiClient {
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
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_GOOGLE_DRIVE_MAX_RETRIES));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async listFiles(request: GoogleDriveListFilesRequest): Promise<GoogleDriveListFilesResponse> {
    const params = new URLSearchParams({
      pageSize: String(request.pageSize),
      fields: 'nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,version,driveId,parents,owners(emailAddress),webViewLink,size,md5Checksum)',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
      q: request.query ?? 'trashed = false',
    });
    if (request.pageToken) params.set('pageToken', request.pageToken);
    const json = await this.getJson(`files?${params.toString()}`);
    const record = asRecord(json, 'Google Drive files list response');
    return {
      files: Array.isArray(record.files)
        ? record.files.map((item) => normalizeDriveFile(asRecord(item, 'Google Drive file'))).filter((file) => file.id)
        : [],
      ...optionalStringProp(record, 'nextPageToken'),
    };
  }

  async getFolder(folderId: string): Promise<GoogleDriveFolder> {
    const params = new URLSearchParams({ fields: 'id,name,parents', supportsAllDrives: 'true' });
    const json = await this.getJson(`files/${encodeURIComponent(folderId)}?${params.toString()}`);
    const record = asRecord(json, 'Google Drive folder');
    const id = typeof record.id === 'string' ? record.id : folderId;
    return {
      id,
      ...optionalStringProp(record, 'name'),
      ...(Array.isArray(record.parents)
        ? { parents: record.parents.filter((entry): entry is string => typeof entry === 'string') }
        : {}),
    };
  }

  async exportGoogleDocText(fileId: string, maxBytes: number): Promise<string> {
    const params = new URLSearchParams({ mimeType: 'text/plain' });
    return this.getText(`files/${encodeURIComponent(fileId)}/export?${params.toString()}`, maxBytes);
  }

  async downloadTextFile(fileId: string, maxBytes: number): Promise<string> {
    return this.getText(`files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, maxBytes);
  }

  async downloadFileBytes(fileId: string, maxBytes?: number): Promise<GoogleDriveFileBytes> {
    const response = await this.send(
      `files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
      'application/octet-stream',
      'Google Drive content request',
    );
    // The declared length first, so an oversized file is refused before its
    // body is pulled across the wire, and the read length second, because a
    // provider may declare nothing or declare wrongly.
    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (maxBytes !== undefined && Number.isSafeInteger(declared) && declared > maxBytes) {
      throw new GoogleDriveContentTooLargeError();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
      throw new GoogleDriveContentTooLargeError();
    }
    const mimeType = response.headers.get('content-type') ?? undefined;
    return {
      bytes,
      ...(mimeType ? { mimeType } : {}),
      sizeBytes: bytes.byteLength,
    };
  }

  private async getJson(path: string): Promise<unknown> {
    const text = await this.get(path, 'application/json', 'Google Drive API request');
    return text ? JSON.parse(text) as unknown : {};
  }

  private async getText(path: string, maxBytes: number): Promise<string> {
    const text = await this.get(path, 'text/plain,application/octet-stream', 'Google Drive content request');
    return text.slice(0, maxBytes);
  }

  /**
   * Retries the statuses Drive uses to say "slow down" or "try again", honoring
   * Retry-After. Without this the first rate limit surfaced as a task failure
   * and the scheduler fail-looped the lane at its error backoff — the exact
   * shape the Readwise T3 guard was written to stop.
   */
  private async get(path: string, accept: string, context: string): Promise<string> {
    return (await this.send(path, accept, context)).text();
  }

  /**
   * The request, its retries, and nothing about the body.
   *
   * Split out of `get` so the byte lane shares one retry policy with the text
   * lane instead of growing a second, quietly divergent copy. The successful
   * response is returned unread: only the caller knows whether these bytes are
   * text.
   */
  private async send(path: string, accept: string, context: string): Promise<Response> {
    let attempt = 0;
    while (true) {
      // The retry loop is the request boundary. Reserving here makes one
      // ledger increment correspond to one real provider request. Drive's own
      // 429 is handled below and binds every provenance: the budget exemption
      // waives Olympus's line, never the provider's.
      this.requestBudget?.reserve(this.provenance);
      const response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.token}`,
        },
      });
      if (response.ok) return response;
      // Drained on every failed attempt, retried or not, so a discarded
      // response never holds its connection open.
      const detail = await response.text().catch(() => '');
      if (isRetryableDriveStatus(response.status) && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(driveRetryDelayMs(response, attempt));
        continue;
      }
      throw new GoogleDriveApiError(
        `${context} failed (${response.status}): ${safeProviderDetail(detail)}`,
        response.status,
      );
    }
  }
}

function isRetryableDriveStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function driveRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_GOOGLE_DRIVE_RETRY_DELAY_MS);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.max(0, Math.min(dateMs - Date.now(), MAX_GOOGLE_DRIVE_RETRY_DELAY_MS));
    }
  }
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 5_000);
}

function normalizeDriveFile(record: Record<string, unknown>): GoogleDriveFile {
  return {
    id: stringValue(record.id),
    ...optionalStringProp(record, 'name'),
    ...optionalStringProp(record, 'mimeType'),
    ...optionalStringProp(record, 'createdTime'),
    ...optionalStringProp(record, 'modifiedTime'),
    ...optionalStringProp(record, 'version'),
    ...optionalStringProp(record, 'driveId'),
    ...optionalStringProp(record, 'webViewLink'),
    ...optionalStringProp(record, 'size'),
    ...optionalStringProp(record, 'md5Checksum'),
    ...(Array.isArray(record.parents) ? { parents: record.parents.map(stringValue).filter(Boolean) } : {}),
    ...(Array.isArray(record.owners)
      ? { owners: record.owners.map((owner) => asRecord(owner, 'Google Drive owner')).map((owner) => optionalStringProp(owner, 'emailAddress')) }
      : {}),
  };
}

function isDownloadableTextMime(mimeType: string | undefined, name: string | undefined): boolean {
  const mime = mimeType?.toLowerCase() ?? '';
  if (mime.startsWith('text/')) return true;
  if (['application/json', 'application/xml', 'application/csv', 'text/csv'].includes(mime)) return true;
  const lower = name?.toLowerCase() ?? '';
  return ['.md', '.txt', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml'].some((suffix) => lower.endsWith(suffix));
}

function withinTextByteCap(size: string | undefined, maxBytes: number): boolean {
  if (!size) return true;
  const parsed = Number.parseInt(size, 10);
  return Number.isFinite(parsed) && parsed <= maxBytes;
}

function normalizeDriveMaxFiles(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_GOOGLE_DRIVE_SYNC_MAX_FILES;
  return Math.max(1, Math.min(Math.floor(value), MAX_GOOGLE_DRIVE_SYNC_FILES));
}

function normalizeMaxTextBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_GOOGLE_DRIVE_MAX_TEXT_BYTES;
  return Math.max(1_000, Math.min(Math.floor(value), 512_000));
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

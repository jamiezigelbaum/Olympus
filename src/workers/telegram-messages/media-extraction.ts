/**
 * Reading Telegram's media children (docs/design/archive-live-one-dataset.md,
 * section 5; child-items.md, "Reading later"): one extraction roster entry
 * over the Telegram stores, whose one reader takes a child's bytes from
 * wherever its locator says they are, whichever input listed it:
 *
 * - `telegram-live-media:v1:<path>`: a photo or file the capture helper kept
 *   beside its spool, read only from under the spool's media folder;
 * - `archive-input-media:v1:<archive>:...`: a file a Telegram Desktop export
 *   carries, from the import's own approved folder (archive-import/input-media.ts),
 *   only while that import serves it.
 *
 * A readable photo or file brings its text through the shared extraction
 * runner, held, judged and stored like any other file, each child on its own.
 * A child named only (the helper kept no file) has no locator and is never a
 * read.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawItem, SourceConnectorFetchOptions, SourceConnectorListPage } from '../../core/contracts.ts';
import { FileExtractionSourceError } from '../../core/file-extraction-source.ts';
import { copyArchiveInputMediaToFile, parseArchiveInputMedia, readArchiveInputMedia, type ArchiveInputMediaDeps } from '../archive-import/input-media.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import type { FileExtractionRuntime } from '../email-source/file-extraction-runtime.ts';
import { createChildExtractionRuntime } from '../email-source/child-extraction-runtime.ts';
import type { BoundedFetchConnector, FileFetchConnector } from '../file-extraction/connector-source.ts';
import { discardExtractionSpoolFile, extractionSpoolFileName, makeExtractionSpoolOwnerDir } from '../file-extraction/spool.ts';
import type { ExtractorRegistryConfig } from '../file-extraction/types.ts';
import { TELEGRAM_LIVE_MEDIA_LOCATOR_PREFIX, telegramLiveMediaPath } from './media-child.ts';

/** The roster's key for Telegram's media (its corpora are the Telegram stores). */
export const TELEGRAM_MEDIA_EXTRACTION_PROVIDER = 'telegram.media';
export const TELEGRAM_MEDIA_EXTRACTION_SCOPE_KEY = 'telegram.media:extraction';
export const TELEGRAM_MEDIA_EXTRACTION_PLAN_LIMIT = 200;
export const TELEGRAM_MEDIA_EXTRACTION_BATCH_SIZE = 10;

/** The extraction lanes of Telegram's media: one per store, keyed by the rows' own provider (jobs are). */
export function telegramMediaLanes(corpusIds: readonly string[], accountScope: string): Array<{ corpusId: string; provider: string; accountScope: string; approvedScopeKey: string }> {
  return corpusIds.map((corpusId) => ({ corpusId, provider: 'telegram', accountScope, approvedScopeKey: TELEGRAM_MEDIA_EXTRACTION_SCOPE_KEY }));
}

/**
 * The one reader of Telegram's media children, by the locator the child's row
 * keeps. `imports` is undefined while the engine has no archive imports: an
 * export's file then waits (it is asked again later).
 */
export function telegramMediaConnector(input: {
  account: string;
  spoolDir: string;
  imports: () => ArchiveInputMediaDeps | undefined;
}): BoundedFetchConnector & FileFetchConnector {
  const item = (localItemId: string, bytes?: Uint8Array): RawItem => {
    // The adapter reads only the content; the row's own type stands for the bytes' (connector-source.ts).
    const providerItemId = localItemId.startsWith(`${input.account}:`) ? localItemId.slice(input.account.length + 1) : localItemId;
    const mimeType = 'application/octet-stream';
    return {
      identity: { family: 'chat', provider: 'telegram', accountScope: input.account, providerItemId, localItemId },
      mimeType,
      content: bytes ? { kind: 'bytes', mimeType, bytes } : { kind: 'metadata_only' },
      metadata: {},
      fetchedAt: new Date().toISOString(),
    };
  };
  const locatorOf = (options: { deferredBytes?: { locator: string } }): string => {
    const locator = options.deferredBytes?.locator;
    // Only children are read here; a message is read with its listing.
    if (!locator) throw new FileExtractionSourceError('source_content_unavailable');
    return locator;
  };
  const archive = (): ArchiveInputMediaDeps => {
    const deps = input.imports();
    if (!deps) throw new FileExtractionSourceError('source_unavailable');
    return deps;
  };
  // A kept file, checked against the bound before it is read. Gone (a Secret's file is removed at the next pull,
  // and a locator outside the media folder names nothing) is not found.
  const keptFile = (locator: string, maxBytes: number | undefined): string => {
    const path = telegramLiveMediaPath(input.spoolDir, locator);
    if (!path) throw new FileExtractionSourceError('source_item_not_found');
    let size: number;
    try {
      size = lstatSync(path).size;
    } catch {
      throw new FileExtractionSourceError('source_item_not_found');
    }
    if (maxBytes !== undefined && size > maxBytes) throw new FileExtractionSourceError('source_too_large');
    return path;
  };
  const read = async (localItemId: string, options: { maxBytes?: number; deferredBytes?: { locator: string } }): Promise<RawItem> => {
    const locator = locatorOf(options);
    const bound = options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {};
    if (parseArchiveInputMedia(locator)) return item(localItemId, readArchiveInputMedia(locator, archive(), bound));
    if (!locator.startsWith(TELEGRAM_LIVE_MEDIA_LOCATOR_PREFIX)) throw new FileExtractionSourceError('source_content_unavailable');
    const path = keptFile(locator, options.maxBytes);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new FileExtractionSourceError('source_item_not_found');
    }
    // A file that grew past the bound since it was checked is still too large.
    if (options.maxBytes !== undefined && bytes.byteLength > options.maxBytes) throw new FileExtractionSourceError('source_too_large');
    return item(localItemId, new Uint8Array(bytes));
  };
  return {
    id: TELEGRAM_MEDIA_EXTRACTION_PROVIDER,
    family: 'chat',
    async authenticate(): Promise<void> {},
    // Extraction never lists: the inputs did.
    async *listItems(): AsyncIterable<SourceConnectorListPage> {},
    fetchItem: (localItemId: string, options?: SourceConnectorFetchOptions) => read(localItemId, options?.deferredBytes ? { deferredBytes: options.deferredBytes } : {}),
    fetchItemWithin: (localItemId, options) => read(localItemId, options),
    // A file reader (a long video's transcription) gets a kept file as it is, and an export's file streamed to a
    // scratch file, a range at a time: neither is held whole in memory.
    async fetchItemToFile(localItemId, options) {
      const locator = locatorOf(options);
      if (parseArchiveInputMedia(locator)) {
        const deps = archive();
        const served = (): boolean => options.stillServed?.() ?? true;
        if (!served()) throw new FileExtractionSourceError('source_item_not_found');
        makeExtractionSpoolOwnerDir(options.spoolDir, options.spoolAnchor);
        const path = join(options.spoolDir, extractionSpoolFileName());
        copyArchiveInputMediaToFile(locator, deps, options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}, path);
        if (!served()) {
          discardExtractionSpoolFile(path, options.spoolDir);
          throw new FileExtractionSourceError('source_item_not_found');
        }
        return { item: item(localItemId), path, spooled: true };
      }
      if (!locator.startsWith(TELEGRAM_LIVE_MEDIA_LOCATOR_PREFIX)) throw new FileExtractionSourceError('source_content_unavailable');
      return { item: item(localItemId), path: keptFile(locator, options.maxBytes), spooled: false };
    },
    classificationSignals: () => ({}),
  };
}

/**
 * Telegram's media extraction runtime: the shared child extraction runtime over
 * the Telegram stores, with this module's one reader and the Telegram tier set.
 */
export function createTelegramMediaExtractionRuntime(input: {
  stores: readonly LocalConnectorStore[];
  set: TieredStoreSet;
  account: string;
  spoolDir: string;
  imports: () => ArchiveInputMediaDeps | undefined;
  extractors?: ExtractorRegistryConfig;
  env?: Record<string, string | undefined>;
  jobsDbPath?: string;
  warn?: (message: string) => void;
}): FileExtractionRuntime | undefined {
  const connector = telegramMediaConnector({ account: input.account, spoolDir: input.spoolDir, imports: input.imports });
  return createChildExtractionRuntime({
    provider: TELEGRAM_MEDIA_EXTRACTION_PROVIDER,
    scopeKey: TELEGRAM_MEDIA_EXTRACTION_SCOPE_KEY,
    corpusIds: input.stores.map((store) => store.corpusId),
    stores: input.stores,
    set: input.set,
    accountScope: () => input.account,
    connector: (accountScope) => (accountScope === input.account ? connector : undefined),
    ...(input.extractors ? { extractors: input.extractors } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.jobsDbPath ? { jobsDbPath: input.jobsDbPath } : {}),
    ...(input.warn ? { warn: input.warn } : {}),
  });
}

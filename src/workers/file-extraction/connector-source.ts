/**
 * One generic `FileExtractionSource` over any connector's `fetchItem`.
 *
 * A source whose bytes come from its own connector (a file on this computer,
 * for example) needs no extraction source of its own: candidates come from the
 * corpus's store like every other lane, and the bytes come from the
 * connector's `fetchItem`. The connector keeps every source-shaped concern
 * (where the bytes are, how a read is kept inside its approved folders, what a
 * placeholder is); this adapter only turns a `RawItem` into the factory's
 * `FetchedBytes` and a refusal into the factory's bounded error vocabulary.
 *
 * Nothing here names a source family.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { extractionSpoolFileName, extractionSpoolOwnerDir, pruneExtractionSpoolOwner } from './spool.ts';
import type { RawItem, SourceConnector } from '../../core/contracts.ts';
import {
  FileExtractionSourceError,
  isFileExtractionSourceError,
  splitScopedLocalItemId,
  type ExtractionCandidateReader,
  type ExtractionCandidateReaderOptions,
  type ExtractionCandidateRow,
} from '../../core/file-extraction-source.ts';
import type {
  ExtractionCandidateListOptions,
  ExtractionCandidatePage,
  ExtractionFetchFileOptions,
  ExtractionFetchOptions,
  ExtractionItemRef,
  FetchedBytes,
  FetchedFile,
  FileExtractionSource,
} from './types.ts';

/**
 * A connector that can refuse to read a file larger than the caller's byte
 * ceiling before reading it. Optional: without it the adapter checks the size
 * after the read.
 */
export interface BoundedFetchConnector extends SourceConnector {
  /**
   * A read that takes at most `maxBytes` plus one byte of the item, so a size the
   * source stated wrongly cannot overrun memory and the caller can still tell
   * "over the limit" from "exactly the limit". For a child item, `deferredBytes`
   * is the persisted locator the store kept.
   */
  fetchItemWithin(
    localItemId: string,
    options: { maxBytes?: number; expectedVersion?: string; deferredBytes?: { locator: string } },
  ): Promise<RawItem>;
}

function isBoundedFetchConnector(connector: SourceConnector): connector is BoundedFetchConnector {
  return typeof (connector as Partial<BoundedFetchConnector>).fetchItemWithin === 'function';
}

/**
 * A connector that can hand a file reader the item as a file: the path of the
 * original when it is a plain file under an approved folder (no copy), or a
 * private file it streams the bytes to, in bounded chunks, inside `spoolDir`
 * (a member of an archive, a part of a message). `spooled` says which, so only
 * a file the connector wrote is ever removed.
 */
export interface FileFetchConnector extends SourceConnector {
  fetchItemToFile(
    localItemId: string,
    options: {
      maxBytes?: number;
      expectedVersion?: string;
      deferredBytes?: { locator: string };
      spoolDir: string;
    },
  ): Promise<{ item: RawItem; path: string; spooled: boolean }>;
}

function isFileFetchConnector(connector: SourceConnector): connector is FileFetchConnector {
  return typeof (connector as Partial<FileFetchConnector>).fetchItemToFile === 'function';
}

/**
 * One item read within a byte ceiling: the connector's bounded read when it
 * has one, else its plain read (the bytes are then in memory already, and a
 * result over the ceiling is refused as too large). The one place a bounded
 * read is chosen, for this adapter and for a connector that opens its source
 * per read and delegates.
 */
export async function readItemWithin(
  connector: SourceConnector,
  localItemId: string,
  options: { maxBytes?: number; expectedVersion?: string; deferredBytes?: { locator: string } },
): Promise<RawItem> {
  const deferred = options.deferredBytes ? { deferredBytes: options.deferredBytes } : {};
  if (isBoundedFetchConnector(connector)) {
    return connector.fetchItemWithin(localItemId, {
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      ...(options.expectedVersion ? { expectedVersion: options.expectedVersion } : {}),
      ...deferred,
    });
  }
  return connector.fetchItem(localItemId, options.deferredBytes ? deferred : undefined);
}

/**
 * An item handed to a file reader as a file: the connector's own hand-over
 * when it has one, else its bytes written to a private file inside `spoolDir`.
 */
export async function readItemToFile(
  connector: SourceConnector,
  localItemId: string,
  options: { maxBytes?: number; expectedVersion?: string; deferredBytes?: { locator: string }; spoolDir: string },
): Promise<{ item: RawItem; path: string; spooled: boolean }> {
  if (isFileFetchConnector(connector)) return connector.fetchItemToFile(localItemId, options);
  const item = await readItemWithin(connector, localItemId, options);
  const content = item.content;
  if (content.kind === 'metadata_only') throw refusalFor(item);
  const bytes = content.kind === 'bytes' ? content.bytes : new TextEncoder().encode(content.text);
  if (options.maxBytes !== undefined && bytes.byteLength > options.maxBytes) {
    throw new FileExtractionSourceError('source_too_large');
  }
  const path = join(options.spoolDir, extractionSpoolFileName());
  // The folder is the owner's own and is removed when it empties; a removal that
  // lands between the make and the write is made again.
  for (let attempt = 0; ; attempt += 1) {
    try {
      mkdirSync(options.spoolDir, { recursive: true, mode: 0o700 });
      writeFileSync(path, bytes, { mode: 0o600 });
      break;
    } catch (error) {
      if (attempt >= 3 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { item, path, spooled: true };
}

/**
 * What the store kept for reading a child's bytes later. Read fresh on every
 * fetch: a job row keeps only the item's identity, so a restart, a replaced
 * source version or a removed archive is always seen as it is now.
 *
 * `undefined`: this item is not a child, so it is read like any other item.
 */
export type DeferredBytesAnswer =
  | { locator: string; sizeBytes?: number }
  | { refusal: 'source_version_gone' | 'source_content_unavailable' | 'source_item_not_found' }
  | undefined;

/**
 * A store's account of a child's deferred bytes (`none`: not a child), as the
 * answer a fetch acts on. Written structurally so this module names no store.
 */
export type DeferredBytesStoreState =
  | { state: 'none' | 'gone' | 'unavailable' | 'version_changed' }
  | { state: 'ready'; locator: string; sizeBytes?: number };

export function deferredBytesAnswerFor(stored: DeferredBytesStoreState): DeferredBytesAnswer {
  switch (stored.state) {
    case 'none': return undefined;
    case 'gone': return { refusal: 'source_item_not_found' };
    case 'unavailable': return { refusal: 'source_content_unavailable' };
    case 'version_changed': return { refusal: 'source_version_gone' };
    case 'ready': return { locator: stored.locator, ...(stored.sizeBytes !== undefined ? { sizeBytes: stored.sizeBytes } : {}) };
  }
}

/**
 * One lane of the source: the key the factory scopes jobs by, and which
 * candidate rows belong to it. A lane with no `matches` takes every row.
 */
export interface ConnectorSourceLane {
  approvedScopeKey: string;
  matches?(row: ExtractionCandidateRow): boolean;
}

export interface ConnectorFileExtractionSourceOptions {
  id: string;
  corpusId: string;
  /**
   * The provider a ref is stamped with when its row names none. A row's own
   * provider always wins: one corpus can hold several formats' items (an
   * archive family's stores), each read by its own connector.
   */
  provider: string;
  /**
   * The connector, or a way to find the one for an account scope (each
   * imported archive has its own). `undefined` means the account is gone: its
   * items are settled as not found and nothing is read.
   */
  connector: SourceConnector | ((accountScope: string) => SourceConnector | undefined);
  /**
   * For a source whose items can be children; see `DeferredBytesAnswer`.
   */
  deferredBytes?: (ref: ExtractionItemRef) => DeferredBytesAnswer;
  candidates: ExtractionCandidateReader;
  lanes: readonly ConnectorSourceLane[];
  mimeTypes?: readonly string[];
}

/**
 * What a connector's `metadata_only` answer to a fetch says about why there
 * are no bytes. The metadata keys are the vocabulary a connector uses for it.
 */
function refusalFor(item: RawItem): FileExtractionSourceError {
  if (item.metadata['contentTooLarge'] === true) return new FileExtractionSourceError('source_too_large');
  if (item.metadata['scopeContentDenied'] === true) return new FileExtractionSourceError('source_permission_denied');
  return new FileExtractionSourceError('source_content_unavailable');
}

export function createConnectorFileExtractionSource(
  options: ConnectorFileExtractionSourceOptions,
): FileExtractionSource {
  const { lanes } = options;
  const connectorFor = (accountScope: string): SourceConnector | undefined =>
    typeof options.connector === 'function' ? options.connector(accountScope) : options.connector;
  const requireText = (value: string, label: string): string => {
    const text = value?.trim();
    if (!text) throw new Error(`${label} is required.`);
    return text;
  };
  const id = requireText(options.id, 'Connector extraction source id');
  const corpusId = requireText(options.corpusId, 'Connector extraction source corpus id');
  const provider = requireText(options.provider, 'Connector extraction source provider');

  const laneFor = (row: ExtractionCandidateRow): ConnectorSourceLane | undefined =>
    lanes.find((lane) => lane.matches === undefined || lane.matches(row));

  const refFromRow = (row: ExtractionCandidateRow, lane: ConnectorSourceLane): ExtractionItemRef | undefined => {
    const split = splitScopedLocalItemId(row.localItemId);
    const accountScope = row.accountScope ?? split?.accountScope;
    const providerItemId = row.providerItemId ?? split?.providerItemId;
    if (!accountScope || !providerItemId) return undefined;
    const name = row.name ?? row.title;
    return {
      corpusId,
      provider: row.provider ?? provider,
      accountScope,
      approvedScopeKey: lane.approvedScopeKey,
      providerItemId,
      localItemId: row.localItemId,
      ...(row.sourceVersion ? { sourceVersion: row.sourceVersion } : {}),
      ...(row.contentHash ? { contentHash: row.contentHash } : {}),
      ...(name ? { name } : {}),
      ...(row.mimeType ? { mimeType: row.mimeType } : {}),
      ...(row.sizeBytes !== undefined ? { sizeBytes: row.sizeBytes } : {}),
    };
  };

  return {
    id,
    corpusId,
    provider,

    async listCandidates(listOptions: ExtractionCandidateListOptions): Promise<ExtractionCandidatePage> {
      const wanted = listOptions.approvedScopeKeys;
      const active = wanted ? lanes.filter((lane) => wanted.includes(lane.approvedScopeKey)) : lanes;
      if (active.length === 0) return { candidates: [], done: true };
      const readerOptions: ExtractionCandidateReaderOptions = {
        limit: listOptions.limit,
        withoutChunksOnly: true,
        // An edited item is read again: its current version reaches the
        // source in the row and the job is keyed by it.
        includeStaleChunks: true,
      };
      if (listOptions.cursor !== undefined) readerOptions.cursor = listOptions.cursor;
      const mimeTypes = listOptions.mimeTypes ?? options.mimeTypes;
      if (mimeTypes) readerOptions.mimeTypes = mimeTypes;
      const page = await options.candidates.extractionCandidates(readerOptions);
      const candidates: ExtractionItemRef[] = [];
      for (const row of page.candidates) {
        const lane = laneFor(row);
        if (!lane || !active.includes(lane)) continue;
        const ref = refFromRow(row, lane);
        if (ref) candidates.push(ref);
      }
      return {
        candidates,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        done: page.done,
      };
    },

    async fetch(ref: ExtractionItemRef, fetchOptions: ExtractionFetchOptions): Promise<FetchedBytes> {
      const item = await readItem(ref, fetchOptions);
      const content = item.content;
      if (content.kind === 'metadata_only') throw refusalFor(item);
      const bytes = content.kind === 'bytes' ? content.bytes : new TextEncoder().encode(content.text);
      const mimeType = content.kind === 'bytes' ? content.mimeType : item.mimeType;
      if (fetchOptions.maxBytes !== undefined && bytes.byteLength > fetchOptions.maxBytes) {
        throw new FileExtractionSourceError('source_too_large');
      }
      return { bytes, ...(mimeType ? { mimeType } : {}), sizeBytes: bytes.byteLength };
    },

    async fetchFile(ref: ExtractionItemRef, fileOptions: ExtractionFetchFileOptions): Promise<FetchedFile> {
      const { connector, deferred } = resolve_(ref, fileOptions.maxBytes);
      // The scratch file is written under its owner, so removing the owner's account scope or
      // source removes it, and a start can tell it is an orphan.
      const owner = { corpusId, accountScope: ref.accountScope };
      const spoolDir = extractionSpoolOwnerDir(fileOptions.spoolDir, owner);
      let handed: { item: RawItem; path: string; spooled: boolean };
      try {
        handed = await readItemToFile(connector, ref.localItemId, {
          ...(fileOptions.maxBytes !== undefined ? { maxBytes: fileOptions.maxBytes } : {}),
          ...(ref.sourceVersion ? { expectedVersion: ref.sourceVersion } : {}),
          ...(deferred ? { deferredBytes: { locator: deferred.locator } } : {}),
          spoolDir,
        });
      } catch (error) {
        throw asSourceError(error);
      }
      const content = handed.item.content;
      const mimeType = content.kind === 'bytes' ? content.mimeType : handed.item.mimeType;
      return {
        path: handed.path,
        ...(mimeType ? { mimeType } : {}),
        ...(deferred?.sizeBytes !== undefined ? { sizeBytes: deferred.sizeBytes } : {}),
        dispose: fileHandOver(handed.path, handed.spooled, spoolDir, () => pruneExtractionSpoolOwner(fileOptions.spoolDir, owner)).dispose,
      };
    },
  };

  /**
   * The connector for this ref's account and, for a child, the locator the store keeps now.
   */
  function resolve_(ref: ExtractionItemRef, maxBytes: number | undefined): {
    connector: SourceConnector;
    deferred?: { locator: string; sizeBytes?: number };
  } {
    const connector = connectorFor(ref.accountScope);
    if (!connector) throw new FileExtractionSourceError('source_item_not_found');
    const answer = options.deferredBytes?.(ref);
    if (answer && 'refusal' in answer) throw new FileExtractionSourceError(answer.refusal);
    // A size the source stated that is already over the bound is never read.
    const stated = answer?.sizeBytes ?? ref.sizeBytes;
    if (maxBytes !== undefined && stated !== undefined && stated > maxBytes) {
      throw new FileExtractionSourceError('source_too_large');
    }
    return { connector, ...(answer ? { deferred: answer } : {}) };
  }

  async function readItem(
    ref: ExtractionItemRef,
    fetchOptions: { maxBytes?: number },
  ): Promise<RawItem> {
    const { connector, deferred } = resolve_(ref, fetchOptions.maxBytes);
    try {
      return await readItemWithin(connector, ref.localItemId, {
        ...(fetchOptions.maxBytes !== undefined ? { maxBytes: fetchOptions.maxBytes } : {}),
        ...(ref.sourceVersion ? { expectedVersion: ref.sourceVersion } : {}),
        ...(deferred ? { deferredBytes: { locator: deferred.locator } } : {}),
      });
    } catch (error) {
      throw asSourceError(error);
    }
  }
}

function asSourceError(error: unknown): FileExtractionSourceError {
  return isFileExtractionSourceError(error) ? error : new FileExtractionSourceError('source_unavailable');
}

/**
 * Removes a file only when the connector wrote it, and only inside the spool
 * folder: a path to an original under an approved folder is never touched.
 */
function fileHandOver(path: string, spooled: boolean, spoolDir: string, tidy: () => void): { dispose(): Promise<void> } {
  return {
    async dispose() {
      if (!spooled) return;
      const root = resolve(spoolDir) + sep;
      const target = resolve(path);
      if (!target.startsWith(root) || basename(target) === '') return;
      rmSync(target, { force: true });
      // The owner's folders go when they are empty, so a finished read leaves nothing in the spool.
      tidy();
    },
  };
}

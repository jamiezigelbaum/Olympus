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
  ExtractionFetchOptions,
  ExtractionItemRef,
  FetchedBytes,
  FileExtractionSource,
} from './types.ts';

/**
 * A connector that can refuse to read a file larger than the caller's byte
 * ceiling before reading it. Optional: without it the adapter checks the size
 * after the read.
 */
export interface BoundedFetchConnector extends SourceConnector {
  fetchItemWithin(
    localItemId: string,
    options: { maxBytes?: number; expectedVersion?: string },
  ): Promise<RawItem>;
}

function isBoundedFetchConnector(connector: SourceConnector): connector is BoundedFetchConnector {
  return typeof (connector as Partial<BoundedFetchConnector>).fetchItemWithin === 'function';
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
  provider: string;
  connector: SourceConnector;
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
  const { connector, lanes } = options;
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
      provider,
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
      let item: RawItem;
      try {
        item = isBoundedFetchConnector(connector)
          ? await connector.fetchItemWithin(ref.localItemId, {
              ...(fetchOptions.maxBytes !== undefined ? { maxBytes: fetchOptions.maxBytes } : {}),
              ...(ref.sourceVersion ? { expectedVersion: ref.sourceVersion } : {}),
            })
          : await connector.fetchItem(ref.localItemId);
      } catch (error) {
        if (isFileExtractionSourceError(error)) throw error;
        throw new FileExtractionSourceError('source_unavailable');
      }
      const content = item.content;
      if (content.kind === 'metadata_only') throw refusalFor(item);
      const bytes = content.kind === 'bytes' ? content.bytes : new TextEncoder().encode(content.text);
      const mimeType = content.kind === 'bytes' ? content.mimeType : item.mimeType;
      if (fetchOptions.maxBytes !== undefined && bytes.byteLength > fetchOptions.maxBytes) {
        throw new FileExtractionSourceError('source_too_large');
      }
      return { bytes, ...(mimeType ? { mimeType } : {}), sizeBytes: bytes.byteLength };
    },
  };
}

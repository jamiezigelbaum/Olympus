/**
 * The Google Drive implementation of `FileExtractionSource`.
 *
 * This module has no local file resolver, and that absence is the deliverable.
 * There is no mounted Drive to read from, so this source enumerates candidates
 * and downloads bytes and does nothing else — no root configuration, no path
 * mapping, no traversal containment, no content-hash gate over a local file.
 * The Dropbox source needs all of those; the factory that consumes both needs
 * none of them. That is what makes "source-neutral" a property of the code
 * rather than a claim in a design document: the resolver seam is genuinely
 * optional, and the factory is not a Dropbox feature with a coat of paint.
 *
 * The population this picks up already exists. Drive's connector accepts only
 * text-shaped media for inline reading, so PDFs and images have always landed
 * `metadata_only`. That was a gap when nothing could extract them. It is now
 * simply the queue.
 */

import {
  FileExtractionSourceError,
  splitScopedLocalItemId,
  type ExtractionCandidateReader,
  type ExtractionCandidateReaderOptions,
  type ExtractionCandidateRow,
} from '../../core/file-extraction-source.ts';
import {
  GoogleDriveApiError,
  GoogleDriveContentTooLargeError,
  type GoogleDriveFileBytes,
} from './drive.ts';
import { GoogleRequestBudgetError } from './request-budget.ts';
import type {
  ExtractionCandidateListOptions,
  ExtractionCandidatePage,
  ExtractionFetchOptions,
  ExtractionItemRef,
  FetchedBytes,
  FileExtractionSource,
} from '../file-extraction/types.ts';

/**
 * The media the extractor registry can do something with. Drive serves plenty
 * it cannot; enumerating those would queue work that can only be skipped.
 */
export const GOOGLE_DRIVE_EXTRACTION_MIME_TYPES: readonly string[] = Object.freeze([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/tiff',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/**
 * The one provider call this source makes. Narrow on purpose: this source has
 * no business listing files, and a port that could would invite it to.
 */
export interface GoogleDriveFileBytesClient {
  downloadFileBytes(fileId: string, maxBytes?: number): Promise<GoogleDriveFileBytes>;
}

export interface GoogleDriveExtractionSourceOptions {
  id: string;
  /**
   * Both Drive corpora exist and neither is privileged, so the corpus is a
   * constructor argument rather than a constant in this file.
   */
  corpusId: string;
  provider: string;
  approvedScopeKey: string;
  candidates: ExtractionCandidateReader;
  client: GoogleDriveFileBytesClient;
  mimeTypes?: readonly string[];
  maxBytes?: number;
}

export class GoogleDriveExtractionSource implements FileExtractionSource {
  readonly id: string;
  readonly corpusId: string;
  readonly provider: string;

  private readonly approvedScopeKey: string;
  private readonly candidates: ExtractionCandidateReader;
  private readonly client: GoogleDriveFileBytesClient;
  private readonly mimeTypes: readonly string[];
  private readonly maxBytes: number | undefined;

  constructor(options: GoogleDriveExtractionSourceOptions) {
    this.id = requireNonEmpty(options.id, 'Google Drive extraction source id');
    this.corpusId = requireNonEmpty(options.corpusId, 'Google Drive extraction source corpus id');
    this.provider = requireNonEmpty(options.provider, 'Google Drive extraction source provider');
    this.approvedScopeKey = requireNonEmpty(options.approvedScopeKey, 'Google Drive approved scope key');
    this.candidates = options.candidates;
    this.client = options.client;
    this.mimeTypes = options.mimeTypes ?? GOOGLE_DRIVE_EXTRACTION_MIME_TYPES;
    this.maxBytes = options.maxBytes;
  }

  async listCandidates(options: ExtractionCandidateListOptions): Promise<ExtractionCandidatePage> {
    if (options.approvedScopeKeys && !options.approvedScopeKeys.includes(this.approvedScopeKey)) {
      return { candidates: [], done: true };
    }
    const readerOptions: ExtractionCandidateReaderOptions = {
      limit: options.limit,
      withoutChunksOnly: true,
      mimeTypes: options.mimeTypes ?? this.mimeTypes,
    };
    if (options.cursor !== undefined) readerOptions.cursor = options.cursor;

    const page = await this.candidates.extractionCandidates(readerOptions);
    const candidates: ExtractionItemRef[] = [];
    for (const row of page.candidates) {
      const ref = this.refFromRow(row);
      if (ref) candidates.push(ref);
    }
    return {
      candidates,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      done: page.done,
    };
  }

  async fetch(ref: ExtractionItemRef, options: ExtractionFetchOptions): Promise<FetchedBytes> {
    const fileId = ref.providerItemId || splitScopedLocalItemId(ref.localItemId)?.providerItemId;
    if (!fileId) throw new FileExtractionSourceError('source_item_not_found');
    const maxBytes = options.maxBytes ?? this.maxBytes;
    try {
      const result = await this.client.downloadFileBytes(fileId, maxBytes);
      return {
        bytes: result.bytes,
        ...(result.mimeType ? { mimeType: result.mimeType } : {}),
        sizeBytes: result.sizeBytes,
      };
    } catch (error) {
      throw driveFetchFailure(error);
    }
  }

  private refFromRow(row: ExtractionCandidateRow): ExtractionItemRef | undefined {
    const split = splitScopedLocalItemId(row.localItemId);
    const accountScope = row.accountScope ?? split?.accountScope;
    const providerItemId = row.providerItemId ?? split?.providerItemId;
    if (!accountScope || !providerItemId) return undefined;
    const name = row.name ?? row.title;
    return {
      corpusId: this.corpusId,
      provider: this.provider,
      accountScope,
      approvedScopeKey: this.approvedScopeKey,
      providerItemId,
      localItemId: row.localItemId,
      ...(row.sourceVersion ? { sourceVersion: row.sourceVersion } : {}),
      ...(row.contentHash ? { contentHash: row.contentHash } : {}),
      ...(name ? { name } : {}),
      ...(row.mimeType ? { mimeType: row.mimeType } : {}),
      ...(row.sizeBytes !== undefined ? { sizeBytes: row.sizeBytes } : {}),
    };
  }
}

/**
 * Map a provider failure onto the bounded vocabulary, keeping none of its text.
 *
 * The daily request budget is deliberately retryable: a parked budget is a
 * statement about the day, not about the file, and settling those items
 * terminally would strand them until someone requeued them by hand.
 */
function driveFetchFailure(error: unknown): FileExtractionSourceError {
  if (error instanceof GoogleDriveContentTooLargeError) {
    return new FileExtractionSourceError('source_too_large');
  }
  if (error instanceof GoogleRequestBudgetError) {
    return new FileExtractionSourceError('source_budget_exhausted');
  }
  if (error instanceof GoogleDriveApiError) {
    const options = { detailForHash: `${error.status}` };
    if (error.status === 401) return new FileExtractionSourceError('source_auth_expired', options);
    if (error.status === 403) return new FileExtractionSourceError('source_permission_denied', options);
    if (error.status === 404) return new FileExtractionSourceError('source_item_not_found', options);
    if (error.status === 429) return new FileExtractionSourceError('source_rate_limited', options);
    if (error.status >= 500) return new FileExtractionSourceError('source_unavailable', options);
    return new FileExtractionSourceError('source_request_rejected', options);
  }
  // The request never produced a status, so it never reached Drive. Spelled as
  // the job store spells it, so its network requeue path applies.
  return new FileExtractionSourceError('network_unreachable');
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

/**
 * Family-neutral support for implementing `FileExtractionSource`.
 *
 * The seam itself lives in the extraction factory's `types.ts`. This module
 * holds the two things every implementation of that seam needs and no
 * implementation should own privately:
 *
 *   1. `FileExtractionSourceError` — how a source reports an item it cannot
 *      read. `fetch()` returns `Promise<FetchedBytes>` and has no third
 *      outcome, so the only way to surface an unreadable item is to reject.
 *      An untyped rejection would force the runner to parse provider prose,
 *      which is both a privacy defect and unactionable; a typed rejection
 *      carrying a bounded categorical kind is the whole convention.
 *   2. `ExtractionCandidateReader` — the narrow structural port a source reads
 *      candidates through, so a source can be built and tested against the
 *      minimum shape it consumes rather than against a concrete store class.
 *
 * Nothing here names a connector family, and nothing here may: this module is
 * enrolled in the architecture guard's source-agnostic file list. Everything
 * family-shaped belongs in the family's own source module, which is exactly
 * where the guard does not reach.
 */

import { createHash } from 'node:crypto';
import type { ExtractionTerminalStatus } from '../workers/file-extraction/types.ts';

/**
 * Every reason a source may fail to produce bytes.
 *
 * Bounded and categorical on purpose. These values are written to the job
 * store's `error_kind` column, which validates against a lowercase
 * `[a-z0-9._:-]` token; free-form provider text, filenames and paths are
 * privacy defects there, not debugging aids.
 *
 * The split that matters to the runner is terminal versus retryable, and it is
 * a property of the kind rather than of the call site — see
 * `FILE_EXTRACTION_SOURCE_ERROR_SETTLEMENTS`.
 *
 * `network_unreachable` and `network_socket_closed` are spelled exactly as the
 * job store spells them. That store treats those two kinds as describing the
 * transport rather than the item, and lets a job that died on one be requeued
 * past its one-terminal-requeue-ever guard. A source that invented its own
 * synonym would silently opt every transport blip out of that recovery path.
 */
export type FileExtractionSourceErrorKind =
  | 'source_item_not_found'
  | 'source_permission_denied'
  | 'source_version_gone'
  | 'source_content_unavailable'
  | 'source_request_rejected'
  | 'source_too_large'
  | 'source_rate_limited'
  | 'source_unavailable'
  | 'source_auth_expired'
  | 'source_budget_exhausted'
  | 'network_unreachable'
  | 'network_socket_closed';

/**
 * The terminal statuses a fetch failure may settle a job as.
 *
 * Derived from the factory's own status union rather than restated, so a
 * change to that union is a compile error here instead of a silent divergence
 * between what a source reports and what the job row can hold.
 */
export type FileExtractionSourceSettlement = Extract<
  ExtractionTerminalStatus,
  'failed_retryable' | 'failed_terminal' | 'skipped_too_large' | 'skipped_unsupported'
>;

/**
 * How each kind settles, as data.
 *
 * The runner reads this table instead of re-deriving the terminal/retryable
 * split from a status code it never saw. Three of these are not failures at
 * all: an item the provider will not serve bytes for, and an item larger than
 * the byte ceiling, are decided outcomes that must not burn a retry budget or
 * count toward any consecutive-failure circuit breaker.
 */
export const FILE_EXTRACTION_SOURCE_ERROR_SETTLEMENTS: Readonly<
  Record<FileExtractionSourceErrorKind, FileExtractionSourceSettlement>
> = Object.freeze({
  source_item_not_found: 'failed_terminal',
  source_permission_denied: 'failed_terminal',
  source_version_gone: 'failed_terminal',
  source_content_unavailable: 'skipped_unsupported',
  // The provider refused the request itself rather than the item. Retrying an
  // identical request cannot help, so it settles terminally and stays visible
  // as a failure instead of being filed as a skip.
  source_request_rejected: 'failed_terminal',
  source_too_large: 'skipped_too_large',
  source_rate_limited: 'failed_retryable',
  source_unavailable: 'failed_retryable',
  source_auth_expired: 'failed_retryable',
  source_budget_exhausted: 'failed_retryable',
  network_unreachable: 'failed_retryable',
  network_socket_closed: 'failed_retryable',
});

export interface FileExtractionSourceErrorOptions {
  /**
   * Content-free fingerprint grouping identical provider failures. Supply the
   * provider's own failure detail and it is hashed here; the detail itself is
   * never retained on the error, so it cannot leak into a log line or a job
   * row by way of `message`.
   */
  detailForHash?: string;
}

const ERROR_HASH_CHARS = 32;

/**
 * An item this source cannot turn into bytes.
 *
 * `message` is the kind and nothing else. That is deliberate: this error
 * travels up through a runner that logs, and a provider's own message routinely
 * contains the path or filename that the job store is forbidden to hold.
 */
export class FileExtractionSourceError extends Error {
  readonly errorKind: FileExtractionSourceErrorKind;
  readonly settleAs: FileExtractionSourceSettlement;
  readonly retryable: boolean;
  readonly errorHash?: string;

  constructor(errorKind: FileExtractionSourceErrorKind, options: FileExtractionSourceErrorOptions = {}) {
    super(errorKind);
    this.name = 'FileExtractionSourceError';
    this.errorKind = errorKind;
    this.settleAs = FILE_EXTRACTION_SOURCE_ERROR_SETTLEMENTS[errorKind];
    this.retryable = this.settleAs === 'failed_retryable';
    const errorHash = options.detailForHash === undefined
      ? undefined
      : createHash('sha256').update(options.detailForHash).digest('hex').slice(0, ERROR_HASH_CHARS);
    if (errorHash) this.errorHash = errorHash;
  }
}

/**
 * Structural predicate, so a consumer can recognize this outcome without an
 * `instanceof` against a class it had to import, and without being defeated by
 * two copies of the module in one process.
 */
export function isFileExtractionSourceError(value: unknown): value is FileExtractionSourceError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FileExtractionSourceError>;
  return typeof candidate.errorKind === 'string'
    && typeof candidate.settleAs === 'string'
    && typeof candidate.retryable === 'boolean'
    && Object.hasOwn(FILE_EXTRACTION_SOURCE_ERROR_SETTLEMENTS, candidate.errorKind);
}

/**
 * One candidate row, as a source consumes it.
 *
 * The minimum a source needs to build an `ExtractionItemRef`, and no more. It
 * is declared here rather than imported from a store class so that a source is
 * testable against a literal and satisfied structurally by whatever the store
 * ends up returning.
 *
 * `localItemId` is the only required field because it is the only one the
 * store guarantees: it is the factory's join key and a NOT NULL column.
 * Account scope and provider item id are recovered from it when the row does
 * not carry them separately.
 */
export interface ExtractionCandidateRow {
  localItemId: string;
  providerItemId?: string;
  accountScope?: string;
  provider?: string;
  mimeType?: string;
  locatorUri?: string;
  sourceVersion?: string;
  contentHash?: string;
  name?: string;
  title?: string;
  sizeBytes?: number;
}

export interface ExtractionCandidateReaderOptions {
  limit: number;
  cursor?: string;
  mimeTypes?: readonly string[];
  accountScope?: string;
  withoutChunksOnly?: boolean;
}

export interface ExtractionCandidateReaderPage {
  candidates: readonly ExtractionCandidateRow[];
  nextCursor?: string;
  done: boolean;
}

/**
 * What a source reads candidates through.
 *
 * The return type admits a synchronous page so a synchronous sqlite read
 * satisfies it directly, with no wrapper at the wiring site.
 */
export interface ExtractionCandidateReader {
  extractionCandidates(
    options: ExtractionCandidateReaderOptions,
  ): ExtractionCandidateReaderPage | Promise<ExtractionCandidateReaderPage>;
}

/**
 * Split a `${accountScope}:${providerItemId}` local item id.
 *
 * Both file families compose their local item id this way, so the rule is a
 * shared convention rather than a family detail. Split on the FIRST separator:
 * account scopes contain dots and provider item ids contain almost anything,
 * including further separators.
 *
 * Returns undefined for a malformed id rather than throwing. A malformed id is
 * a data defect in one row, and the caller decides whether that means "skip
 * this candidate" or "this item is terminally unreadable" — it is never a
 * reason to abort a page.
 */
export function splitScopedLocalItemId(
  localItemId: string,
): { accountScope: string; providerItemId: string } | undefined {
  const separator = localItemId.indexOf(':');
  if (separator <= 0 || separator === localItemId.length - 1) return undefined;
  return {
    accountScope: localItemId.slice(0, separator),
    providerItemId: localItemId.slice(separator + 1),
  };
}

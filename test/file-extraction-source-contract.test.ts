// The shared half of the extraction-source seam: the bounded error vocabulary
// every family reports through, and the local-item-id convention both file
// families compose their join key with.
//
// The point of these tests is that the vocabulary is usable by the job store
// without translation. A kind that fails SAFE_TOKEN would be rejected at the
// moment a real corpus produced it, which is the worst possible time to find
// out.

import { describe, expect, test } from 'bun:test';
import {
  FILE_EXTRACTION_SOURCE_ERROR_SETTLEMENTS,
  FileExtractionSourceError,
  isFileExtractionSourceError,
  splitScopedLocalItemId,
  type FileExtractionSourceErrorKind,
} from '../src/core/file-extraction-source.ts';
import type { ExtractionTerminalStatus } from '../src/workers/file-extraction/types.ts';

// Verbatim from src/workers/file-extraction/job-store.ts. Copied rather than
// exported so this test fails if the store's validators tighten under it.
const SAFE_TOKEN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SAFE_HASH = /^[a-f0-9]{16,128}$/;

const ALL_KINDS = Object.keys(FILE_EXTRACTION_SOURCE_ERROR_SETTLEMENTS) as FileExtractionSourceErrorKind[];

describe('file extraction source error vocabulary', () => {
  test('every error kind is a token the job store will accept', () => {
    expect(ALL_KINDS.length).toBeGreaterThan(0);
    expect(ALL_KINDS.filter((kind) => !SAFE_TOKEN.test(kind))).toEqual([]);
  });

  test('every settlement is a status the job row can hold', () => {
    const terminalStatuses: ReadonlySet<ExtractionTerminalStatus> = new Set([
      'indexed',
      'metadata_only',
      'skipped_unsupported',
      'skipped_too_large',
      'blocked_policy',
      'failed_retryable',
      'failed_terminal',
    ]);
    for (const kind of ALL_KINDS) {
      const settlement: ExtractionTerminalStatus = FILE_EXTRACTION_SOURCE_ERROR_SETTLEMENTS[kind];
      expect(terminalStatuses.has(settlement)).toBe(true);
    }
  });

  test('the terminal/retryable split is a property of the kind, not the call site', () => {
    const retryable = ALL_KINDS.filter((kind) => new FileExtractionSourceError(kind).retryable);
    expect(retryable.sort()).toEqual([
      'network_socket_closed',
      'network_unreachable',
      'source_auth_expired',
      'source_budget_exhausted',
      'source_rate_limited',
      'source_unavailable',
    ]);
  });

  test('the two transport kinds are spelled the way the job store spells them', () => {
    // The store lets a job that died on one of these be requeued past its
    // one-terminal-requeue-ever guard. A synonym would silently opt every
    // transport blip out of that recovery path.
    expect(ALL_KINDS).toContain('network_unreachable');
    expect(ALL_KINDS).toContain('network_socket_closed');
  });

  test('the error message carries the kind and nothing else', () => {
    const error = new FileExtractionSourceError('source_item_not_found', {
      detailForHash: 'path/not_found/... /Personal/Taxes/2019 return.pdf',
    });
    expect(error.message).toBe('source_item_not_found');
    expect(error.message).not.toContain('Taxes');
    expect(JSON.stringify(error.errorHash)).not.toContain('Taxes');
    expect(error.cause).toBeUndefined();
  });

  test('an error hash is a token the job store will accept', () => {
    const error = new FileExtractionSourceError('source_unavailable', { detailForHash: '503:overloaded' });
    expect(error.errorHash).toBeDefined();
    expect(SAFE_HASH.test(error.errorHash!)).toBe(true);
  });

  test('identical failures fingerprint identically and different ones do not', () => {
    const first = new FileExtractionSourceError('source_unavailable', { detailForHash: '503:overloaded' });
    const second = new FileExtractionSourceError('source_unavailable', { detailForHash: '503:overloaded' });
    const other = new FileExtractionSourceError('source_unavailable', { detailForHash: '500:boom' });
    expect(first.errorHash).toBe(second.errorHash!);
    expect(first.errorHash).not.toBe(other.errorHash!);
  });

  test('no hash is produced when no detail was offered', () => {
    expect(new FileExtractionSourceError('network_unreachable').errorHash).toBeUndefined();
  });

  test('the structural predicate recognizes the error without instanceof', () => {
    const error = new FileExtractionSourceError('source_too_large');
    expect(isFileExtractionSourceError(error)).toBe(true);
    expect(isFileExtractionSourceError({
      errorKind: 'source_too_large',
      settleAs: 'skipped_too_large',
      retryable: false,
    })).toBe(true);
    expect(isFileExtractionSourceError(new Error('boom'))).toBe(false);
    expect(isFileExtractionSourceError({ errorKind: 'invented_kind', settleAs: 'x', retryable: false })).toBe(false);
    expect(isFileExtractionSourceError(undefined)).toBe(false);
  });

  test('too large and unsupported settle as decisions, not as failures', () => {
    expect(new FileExtractionSourceError('source_too_large').settleAs).toBe('skipped_too_large');
    expect(new FileExtractionSourceError('source_content_unavailable').settleAs).toBe('skipped_unsupported');
    expect(new FileExtractionSourceError('source_too_large').retryable).toBe(false);
  });
});

describe('scoped local item ids', () => {
  test('splits on the first separator so an account scope may contain dots', () => {
    expect(splitScopedLocalItemId('dropbox.personal:id:AbC-123')).toEqual({
      accountScope: 'dropbox.personal',
      providerItemId: 'id:AbC-123',
    });
  });

  test('a provider item id may contain further separators', () => {
    expect(splitScopedLocalItemId('work:a:b:c')).toEqual({ accountScope: 'work', providerItemId: 'a:b:c' });
  });

  test('a malformed id yields undefined rather than throwing', () => {
    expect(splitScopedLocalItemId('nocolon')).toBeUndefined();
    expect(splitScopedLocalItemId(':leading')).toBeUndefined();
    expect(splitScopedLocalItemId('trailing:')).toBeUndefined();
    expect(splitScopedLocalItemId('')).toBeUndefined();
  });
});

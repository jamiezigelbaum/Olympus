import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseDomainLibraryRegistryJsonl } from '../src/core/domain-library-registry.ts';

function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'domain-library-registry-'));
  mkdirSync(join(root, 'castor-solon', 'sources', 'web-imports', 'batch-1'), { recursive: true });
  return root;
}

function writeDerivative(root: string, relativePath: string, text: string): string {
  const absolutePath = join(root, relativePath);
  writeFileSync(absolutePath, text);
  return sha256(text);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('domain library registry parser', () => {
  test('admits only approved internal/public-safe S0-S3 records with matching derivative hashes', () => {
    const root = fixtureWorkspace();
    const approvedPath = 'castor-solon/sources/web-imports/batch-1/approved.md';
    const approvedHash = writeDerivative(root, approvedPath, 'approved library derivative');
    const stalePath = 'castor-solon/sources/web-imports/batch-1/stale.md';
    writeDerivative(root, stalePath, 'changed derivative');
    const unclassifiedPath = 'castor-solon/sources/web-imports/batch-1/unclassified.md';
    writeDerivative(root, unclassifiedPath, 'unclassified derivative');
    const s4Path = 'castor-solon/sources/web-imports/batch-1/s4.md';
    const s4Hash = writeDerivative(root, s4Path, 'private derivative');
    const safePath = 'castor-solon/sources/web-imports/batch-1/public.md';
    const safeHash = writeDerivative(root, safePath, 'public derivative');

    const result = parseDomainLibraryRegistryJsonl([
      JSON.stringify({
        source_id: 'solon-live-approved',
        domain_id: 'governance',
        kind: 'web_import',
        title: 'Approved note',
        source_url: 'https://example.test/approved',
        workspace_relative_path: approvedPath,
        batch_id: 'batch-1',
        trust_domain: 'internal',
        tier: 'S3',
        classification_status: 'approved',
        content_hash: approvedHash,
      }),
      JSON.stringify({
        source_id: 'solon-stale',
        workspace_relative_path: stalePath,
        trust_domain: 'internal',
        tier: 'S2',
        classification_status: 'approved',
        content_hash: sha256('old derivative'),
      }),
      JSON.stringify({
        source_id: 'solon-unclassified',
        workspace_relative_path: unclassifiedPath,
      }),
      JSON.stringify({
        source_id: 'solon-s4',
        workspace_relative_path: s4Path,
        trust_domain: 'internal',
        tier: 'S4',
        classification_status: 'approved',
        content_hash: s4Hash,
      }),
      JSON.stringify({
        source_id: 'solon-public-safe',
        workspace_relative_path: safePath,
        trust_domain: 'public_safe',
        sensitivity: 'S0',
        classification_status: 'approved',
        content_hash: safeHash,
      }),
    ].join('\n'), { workspaceRoot: root });

    expect(result.records.map((record) => record.sourceId)).toEqual([
      'solon-live-approved',
      'solon-public-safe',
    ]);
    expect(result.records[0]).toMatchObject({
      sourceId: 'solon-live-approved',
      domainId: 'governance',
      kind: 'web_import',
      title: 'Approved note',
      sourceUrl: 'https://example.test/approved',
      derivativeWorkspaceRelativePath: approvedPath,
      trustDomain: 'internal',
      tier: 'S3',
      classificationStatus: 'approved',
      batchId: 'batch-1',
    });
    expect(result.stats).toMatchObject({
      lines: 5,
      parsedRecords: 5,
      eligibleRecords: 2,
      excludedRecords: 3,
      missingVerdict: 1,
      invalidVerdict: 1,
      staleContentHash: 1,
    });
  });

  test('skips malformed JSONL and fails closed for blocked, missing, and escaping derivatives', () => {
    const root = fixtureWorkspace();
    const blockedPath = 'castor-solon/sources/web-imports/batch-1/blocked.md';
    const blockedHash = writeDerivative(root, blockedPath, 'blocked derivative');
    const result = parseDomainLibraryRegistryJsonl([
      '{broken json',
      JSON.stringify({
        source_id: 'blocked',
        workspace_relative_path: blockedPath,
        trust_domain: 'internal',
        tier: 'S1',
        classification_status: 'blocked',
        content_hash: blockedHash,
      }),
      JSON.stringify({
        source_id: 'missing',
        workspace_relative_path: 'castor-solon/sources/web-imports/batch-1/missing.md',
        trust_domain: 'internal',
        tier: 'S1',
        classification_status: 'approved',
        content_hash: sha256('missing'),
      }),
      JSON.stringify({
        source_id: 'escape',
        workspace_relative_path: '../outside.md',
        trust_domain: 'internal',
        tier: 'S1',
        classification_status: 'approved',
        content_hash: sha256('escape'),
      }),
    ].join('\n'), { workspaceRoot: root });

    expect(result.records).toEqual([]);
    expect(result.stats).toMatchObject({
      lines: 4,
      malformedLines: 1,
      parsedRecords: 3,
      eligibleRecords: 0,
      excludedRecords: 3,
      blockedRecords: 1,
      missingDerivative: 1,
      unsafeDerivativePath: 1,
    });
  });

  test('reports per-item skip diagnostics without hiding later valid lines', () => {
    const root = fixtureWorkspace();
    const stalePath = 'castor-solon/sources/web-imports/batch-1/stale-diagnostic.md';
    writeDerivative(root, stalePath, 'new derivative');
    const unreadablePath = 'castor-solon/sources/web-imports/batch-1/unreadable-diagnostic.md';
    const unreadableHash = writeDerivative(root, unreadablePath, 'unreadable derivative');
    const laterPath = 'castor-solon/sources/web-imports/batch-1/later-valid.md';
    const laterHash = writeDerivative(root, laterPath, 'later valid derivative');
    const assertUnreadable = typeof process.getuid !== 'function' || process.getuid() !== 0;

    if (assertUnreadable) chmodSync(join(root, unreadablePath), 0o000);
    try {
      const lines = [
        '{not json',
        JSON.stringify({
          source_id: 'missing-diagnostic',
          workspace_relative_path: 'castor-solon/sources/web-imports/batch-1/missing-diagnostic.md',
          trust_domain: 'internal',
          tier: 'S1',
          classification_status: 'approved',
          content_hash: sha256('missing'),
        }),
        JSON.stringify({
          source_id: 'stale-diagnostic',
          workspace_relative_path: stalePath,
          trust_domain: 'internal',
          tier: 'S1',
          classification_status: 'approved',
          content_hash: sha256('old derivative'),
        }),
        ...(assertUnreadable ? [JSON.stringify({
          source_id: 'unreadable-diagnostic',
          workspace_relative_path: unreadablePath,
          trust_domain: 'internal',
          tier: 'S1',
          classification_status: 'approved',
          content_hash: unreadableHash,
        })] : []),
        JSON.stringify({
          source_id: 'later-valid',
          workspace_relative_path: laterPath,
          trust_domain: 'internal',
          tier: 'S1',
          classification_status: 'approved',
          content_hash: laterHash,
        }),
      ];
      const result = parseDomainLibraryRegistryJsonl(lines.join('\n'), { workspaceRoot: root });

      expect(result.records.map((record) => record.sourceId)).toEqual(['later-valid']);
      expect(result.skippedEntries).toEqual([
        {
          lineNumber: 1,
          reason: 'malformed_line',
        },
        {
          lineNumber: 2,
          sourceId: 'missing-diagnostic',
          derivativeWorkspaceRelativePath: 'castor-solon/sources/web-imports/batch-1/missing-diagnostic.md',
          reason: 'missing_derivative',
          fsErrorCode: 'ENOENT',
        },
        {
          lineNumber: 3,
          sourceId: 'stale-diagnostic',
          derivativeWorkspaceRelativePath: stalePath,
          reason: 'stale_content_hash',
        },
        ...(assertUnreadable ? [{
          lineNumber: 4,
          sourceId: 'unreadable-diagnostic',
          derivativeWorkspaceRelativePath: unreadablePath,
          reason: 'fs_error' as const,
          fsErrorCode: 'EACCES' as const,
        }] : []),
      ]);
      expect(result.skippedEntriesTruncated).toBe(false);
      expect(result.stats).toMatchObject({
        lines: assertUnreadable ? 5 : 4,
        malformedLines: 1,
        parsedRecords: assertUnreadable ? 4 : 3,
        eligibleRecords: 1,
        staleContentHash: 1,
        missingDerivative: assertUnreadable ? 2 : 1,
      });
    } finally {
      if (assertUnreadable) chmodSync(join(root, unreadablePath), 0o600);
    }
  });
});

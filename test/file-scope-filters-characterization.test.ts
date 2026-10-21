import { describe, expect, test } from 'bun:test';
import {
  fileSourceScopeContentFilters,
  fileSourceScopeMetadataFilters,
} from '../src/workers/source-scope-runtime.ts';
import type { FileSourceScopeApprovalSnapshot } from '../src/core/source-scope-approval.ts';

// Characterization of Dropbox and Drive scope-to-filter mapping. These literals
// were written against the pre-registry code and must not change with it.
function approval(
  sourceId: 'dropbox.files' | 'google_drive.docs',
  selections: Array<{ key: string; state: 'ingest' | 'metadata_only' | 'exclude' }>,
  wholeAccount = false,
): FileSourceScopeApprovalSnapshot {
  return {
    sourceId,
    status: 'approved',
    accountGeneration: 'g'.repeat(64),
    revision: 'rev-1',
    selections,
    wholeAccount,
  };
}
const base = (provider: string) => ({
  provider,
  sourceScopeGeneration: 'g'.repeat(64),
  sourceScopeRevision: 'rev-1',
});
const mixed = [
  { key: '/a', state: 'ingest' as const },
  { key: '/b', state: 'metadata_only' as const },
  { key: '/c', state: 'exclude' as const },
];

describe('file scope filter characterization', () => {
  test('Dropbox content filters', () => {
    expect(fileSourceScopeContentFilters(approval('dropbox.files', mixed))).toEqual({
      allowed: true,
      filters: { ...base('dropbox'), locatorPathScopes: ['/a'], locatorPathExcludedScopes: ['/b', '/c'] },
    });
    expect(fileSourceScopeContentFilters(approval('dropbox.files', [{ key: '/a', state: 'ingest' }]))).toEqual({
      allowed: true,
      filters: { ...base('dropbox'), locatorPathScopes: ['/a'] },
    });
    expect(fileSourceScopeContentFilters(approval('dropbox.files', mixed, true))).toEqual({
      allowed: true,
      filters: { ...base('dropbox'), locatorPathExcludedScopes: ['/b', '/c'] },
    });
    expect(fileSourceScopeContentFilters(approval('dropbox.files', [], true))).toEqual({
      allowed: true,
      filters: base('dropbox'),
    });
    expect(fileSourceScopeContentFilters(approval('dropbox.files', [{ key: '/b', state: 'metadata_only' }])))
      .toEqual({ allowed: false });
  });

  test('Drive content filters', () => {
    expect(fileSourceScopeContentFilters(approval('google_drive.docs', mixed))).toEqual({
      allowed: true,
      filters: { ...base('google_drive'), sourceScopeFolderAnyKeys: ['/a'], sourceScopeFolderNoneKeys: ['/b', '/c'] },
    });
    expect(fileSourceScopeContentFilters(approval('google_drive.docs', mixed, true))).toEqual({
      allowed: true,
      filters: { ...base('google_drive'), sourceScopeFolderNoneKeys: ['/b', '/c'] },
    });
    expect(fileSourceScopeContentFilters(approval('google_drive.docs', [], true))).toEqual({
      allowed: true,
      filters: base('google_drive'),
    });
    expect(fileSourceScopeContentFilters(approval('google_drive.docs', []))).toEqual({ allowed: false });
  });

  test('Dropbox metadata filters', () => {
    expect(fileSourceScopeMetadataFilters(approval('dropbox.files', mixed))).toEqual({
      allowed: true,
      filters: {
        ...base('dropbox'),
        locatorPathExcludedScopes: ['/c'],
        metadataOnlyLocatorPathScopes: ['/b'],
        locatorPathScopes: ['/a', '/b'],
      },
    });
    expect(fileSourceScopeMetadataFilters(approval('dropbox.files', mixed, true))).toEqual({
      allowed: true,
      filters: { ...base('dropbox'), locatorPathExcludedScopes: ['/c'], metadataOnlyLocatorPathScopes: ['/b'] },
    });
    expect(fileSourceScopeMetadataFilters(approval('dropbox.files', [{ key: '/c', state: 'exclude' }])))
      .toEqual({ allowed: false });
  });

  test('Drive metadata filters', () => {
    expect(fileSourceScopeMetadataFilters(approval('google_drive.docs', mixed))).toEqual({
      allowed: true,
      filters: {
        ...base('google_drive'),
        sourceScopeFolderNoneKeys: ['/c'],
        metadataOnlySourceScopeFolderKeys: ['/b'],
        sourceScopeFolderAnyKeys: ['/a', '/b'],
      },
    });
    expect(fileSourceScopeMetadataFilters(approval('google_drive.docs', mixed, true))).toEqual({
      allowed: true,
      filters: { ...base('google_drive'), sourceScopeFolderNoneKeys: ['/c'], metadataOnlySourceScopeFolderKeys: ['/b'] },
    });
  });
});

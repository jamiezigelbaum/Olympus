import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { DOMAIN_LIBRARY_CORPUS_ID, runDomainLibrarySync } from '../scripts/domain-library-sync.ts';
import { buildEvidencePack } from '../src/core/evidence-pack.ts';
import { operationToolSchema, operations } from '../src/core/operations.ts';
import { createSourceCorpusRegistry, defaultSourceCorpusRegistryConfig } from '../src/core/source-corpus-registry.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';

const REGISTRY_PATH = 'castor-solon/references/source-registry.jsonl';

function workspaceFixture(): { root: string; registryPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'domain-library-sync-'));
  mkdirSync(join(root, 'castor-solon', 'references'), { recursive: true });
  mkdirSync(join(root, 'castor-solon', 'sources', 'web-imports', 'batch-1'), { recursive: true });
  return { root, registryPath: join(root, REGISTRY_PATH) };
}

function writeDerivative(root: string, relativePath: string, text: string): string {
  writeFileSync(join(root, relativePath), text);
  return createHash('sha256').update(text).digest('hex');
}

describe('domain-library-sync script runner', () => {
  test('syncs only approved registry derivatives into the answer/search connector-store loop', async () => {
    const { root, registryPath } = workspaceFixture();
    const dbPath = join(root, 'connector-store.db');
    const approvedPath = 'castor-solon/sources/web-imports/batch-1/approved.md';
    const approvedHash = writeDerivative(root, approvedPath, 'approved derivative about governance');
    const s4Path = 'castor-solon/sources/web-imports/batch-1/private.md';
    const s4Hash = writeDerivative(root, s4Path, 'private derivative');
    writeFileSync(registryPath, [
      JSON.stringify({
        source_id: 'approved',
        domain_id: 'governance',
        workspace_relative_path: approvedPath,
        trust_domain: 'internal',
        tier: 'S3',
        classification_status: 'approved',
        content_hash: approvedHash,
      }),
      JSON.stringify({
        source_id: 'private',
        domain_id: 'governance',
        workspace_relative_path: s4Path,
        trust_domain: 'internal',
        tier: 'S4',
        classification_status: 'approved',
        content_hash: s4Hash,
      }),
      JSON.stringify({
        source_id: 'current-web-import-record-shape',
        domain_id: 'governance',
        kind: 'web_import',
        workspace_relative_path: 'castor-solon/sources/web-imports/batch-1',
        ingest_status: 'import_requested',
      }),
    ].join('\n'));

    const result = await runDomainLibrarySync({
      workspaceRoot: root,
      registryRelativePath: REGISTRY_PATH,
      dbPath,
    });

    expect(result.summary).toMatchObject({
      corpusId: DOMAIN_LIBRARY_CORPUS_ID,
      connectorId: 'domain-library',
      itemsSeen: 1,
      itemsIndexed: 1,
      chunksIndexed: 1,
      itemsRejected: 0,
      policy: {
        rawSourceExposed: false,
        sourceTextReturned: false,
        trustDomain: 'internal',
        storage: 'local_sqlite',
      },
    });
    expect(result.registry.stats).toMatchObject({
      parsedRecords: 3,
      eligibleRecords: 1,
      excludedRecords: 2,
      missingVerdict: 1,
      invalidVerdict: 1,
    });

    const store = new LocalConnectorStore({
      dbPath,
      corpusId: DOMAIN_LIBRARY_CORPUS_ID,
      family: 'file',
      trustDomain: 'internal',
    });
    try {
      expect(store.status().counts.items).toBe(1);
      expect(store.searchItems('governance', 10).map((row) => row.sourceItem.providerItemId)).toEqual(['approved']);

      // Retired from the default roster on 2026-07-28. The sync still fills the
      // store, but nothing reads it until an operator registers the corpus
      // through sourceIndex.corpusRegistry — asserted here so the gap between
      // "syncs" and "answerable" cannot go unnoticed again.
      const sourceRegistry = createSourceCorpusRegistry(defaultSourceCorpusRegistryConfig());
      expect(sourceRegistry.ids('answer')).not.toContain(DOMAIN_LIBRARY_CORPUS_ID);
      expect(sourceRegistry.ids('search')).not.toContain(DOMAIN_LIBRARY_CORPUS_ID);
      expect(operationToolSchema(operations.find((operation) => operation.name === 'source_answer')!)).toMatchObject({
        properties: {
          corpus_id: { enum: expect.not.arrayContaining([DOMAIN_LIBRARY_CORPUS_ID]) },
        },
      });
      expect(operationToolSchema(operations.find((operation) => operation.name === 'source_index_search')!)).toMatchObject({
        properties: {
          corpus_id: { enum: expect.not.arrayContaining([DOMAIN_LIBRARY_CORPUS_ID]) },
        },
      });

      const corpus = defineConnectorCorpus({ corpusId: DOMAIN_LIBRARY_CORPUS_ID, family: 'file', trustDomain: 'internal' });
      const pack = await buildEvidencePack({
        question: 'What is in the governance derivative?',
        maxResults: 5,
        searchContext: { allowedTrustDomains: ['internal'] },
        registry: buildSourceIndexCorpusRegistry([corpus]),
        adapters: { [DOMAIN_LIBRARY_CORPUS_ID]: createConnectorStoreCorpusAdapter({ store }) },
        contentProviders: { [DOMAIN_LIBRARY_CORPUS_ID]: createConnectorStoreContentProvider({ store }) },
      });
      expect(pack.candidates).toHaveLength(1);
      expect(pack.candidates[0]?.chunks.join(' ')).toContain('approved derivative about governance');
      expect(pack.candidates[0]?.trustDomain).toBe('internal');
      expect(pack.coverage.searchedCorpora).toEqual([DOMAIN_LIBRARY_CORPUS_ID]);
    } finally {
      store.close();
    }
  });

  test('tombstones derivatives that owner review removes from the eligible registry snapshot', async () => {
    const { root, registryPath } = workspaceFixture();
    const dbPath = join(root, 'connector-store.db');
    const approvedPath = 'castor-solon/sources/web-imports/batch-1/approved.md';
    const approvedHash = writeDerivative(root, approvedPath, 'approved derivative about governance');

    writeFileSync(registryPath, JSON.stringify({
      source_id: 'approved',
      domain_id: 'governance',
      workspace_relative_path: approvedPath,
      trust_domain: 'internal',
      tier: 'S3',
      classification_status: 'approved',
      content_hash: approvedHash,
    }));

    const first = await runDomainLibrarySync({
      workspaceRoot: root,
      registryRelativePath: REGISTRY_PATH,
      dbPath,
    });
    expect(first.summary.itemsIndexed).toBe(1);

    let store = new LocalConnectorStore({
      dbPath,
      corpusId: DOMAIN_LIBRARY_CORPUS_ID,
      family: 'file',
      trustDomain: 'internal',
    });
    try {
      expect(store.searchItems('governance', 10).map((row) => row.sourceItem.providerItemId)).toEqual(['approved']);
      expect(store.localContent('solon:governance:approved')?.chunks.join(' ')).toContain('approved derivative');
    } finally {
      store.close();
    }

    writeFileSync(registryPath, JSON.stringify({
      source_id: 'approved',
      domain_id: 'governance',
      workspace_relative_path: approvedPath,
      trust_domain: 'internal',
      tier: 'S3',
      classification_status: 'blocked',
      content_hash: approvedHash,
    }));

    const second = await runDomainLibrarySync({
      workspaceRoot: root,
      registryRelativePath: REGISTRY_PATH,
      dbPath,
    });
    expect(second.summary.itemsSeen).toBe(0);
    expect(second.summary.itemsTombstoned).toBe(1);
    expect(second.registry.stats).toMatchObject({
      blockedRecords: 1,
      eligibleRecords: 0,
      excludedRecords: 1,
    });

    store = new LocalConnectorStore({
      dbPath,
      corpusId: DOMAIN_LIBRARY_CORPUS_ID,
      family: 'file',
      trustDomain: 'internal',
    });
    try {
      expect(store.status().counts.items).toBe(0);
      expect(store.status().counts.tombstonedItems).toBe(1);
      expect(store.searchItems('governance', 10)).toEqual([]);
      expect(store.localContent('solon:governance:approved')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test('does not reconcile a malformed registry snapshot as owner removals', async () => {
    const { root, registryPath } = workspaceFixture();
    const dbPath = join(root, 'connector-store.db');
    const approvedPath = 'castor-solon/sources/web-imports/batch-1/approved.md';
    const approvedHash = writeDerivative(root, approvedPath, 'approved derivative about governance');
    const retainedPath = 'castor-solon/sources/web-imports/batch-1/retained.md';
    const retainedHash = writeDerivative(root, retainedPath, 'retained derivative should stay searchable');

    const approvedRecord = {
      source_id: 'approved',
      domain_id: 'governance',
      workspace_relative_path: approvedPath,
      trust_domain: 'internal',
      tier: 'S3',
      classification_status: 'approved',
      content_hash: approvedHash,
    };
    const retainedRecord = {
      source_id: 'retained',
      domain_id: 'governance',
      workspace_relative_path: retainedPath,
      trust_domain: 'internal',
      tier: 'S3',
      classification_status: 'approved',
      content_hash: retainedHash,
    };
    writeFileSync(registryPath, [
      JSON.stringify(approvedRecord),
      JSON.stringify(retainedRecord),
    ].join('\n'));

    const first = await runDomainLibrarySync({
      workspaceRoot: root,
      registryRelativePath: REGISTRY_PATH,
      dbPath,
    });
    expect(first.summary.itemsIndexed).toBe(2);

    writeFileSync(registryPath, [
      JSON.stringify(approvedRecord),
      '{"source_id":"retained",',
    ].join('\n'));

    await expect(runDomainLibrarySync({
      workspaceRoot: root,
      registryRelativePath: REGISTRY_PATH,
      dbPath,
    })).rejects.toThrow('malformed JSONL');

    const store = new LocalConnectorStore({
      dbPath,
      corpusId: DOMAIN_LIBRARY_CORPUS_ID,
      family: 'file',
      trustDomain: 'internal',
    });
    try {
      expect(store.status().counts.items).toBe(2);
      expect(store.status().counts.tombstonedItems).toBe(0);
      expect(store.searchItems('retained', 10).map((row) => row.sourceItem.providerItemId)).toEqual(['retained']);
      expect(store.localContent('solon:governance:retained')?.chunks.join(' ')).toContain('retained derivative');
    } finally {
      store.close();
    }
  });

  test('returns registry skip diagnostics with sync output', async () => {
    const { root, registryPath } = workspaceFixture();
    const dbPath = join(root, 'connector-store.db');
    const approvedPath = 'castor-solon/sources/web-imports/batch-1/approved.md';
    const approvedHash = writeDerivative(root, approvedPath, 'approved derivative about governance');

    writeFileSync(registryPath, [
      JSON.stringify({
        source_id: 'missing',
        domain_id: 'governance',
        workspace_relative_path: 'castor-solon/sources/web-imports/batch-1/missing.md',
        trust_domain: 'internal',
        tier: 'S3',
        classification_status: 'approved',
        content_hash: createHash('sha256').update('missing').digest('hex'),
      }),
      JSON.stringify({
        source_id: 'approved',
        domain_id: 'governance',
        workspace_relative_path: approvedPath,
        trust_domain: 'internal',
        tier: 'S3',
        classification_status: 'approved',
        content_hash: approvedHash,
      }),
    ].join('\n'));

    const result = await runDomainLibrarySync({
      workspaceRoot: root,
      registryRelativePath: REGISTRY_PATH,
      dbPath,
    });

    expect(result.summary.itemsIndexed).toBe(1);
    expect(result.registry.skippedEntries).toEqual([{
      lineNumber: 1,
      sourceId: 'missing',
      derivativeWorkspaceRelativePath: 'castor-solon/sources/web-imports/batch-1/missing.md',
      reason: 'missing_derivative',
      fsErrorCode: 'ENOENT',
    }]);
    expect(result.registry.skippedEntriesTruncated).toBe(false);
  });

  // pageLimit 5 with 11 items crosses two page boundaries; the revoked item
  // sits on the first page so reconciliation must restart from page one.
  test('full-snapshot reconciliation starts at the first page after a paginated sync', async () => {
    const { root, registryPath } = workspaceFixture();
    const dbPath = join(root, 'connector-store.db');
    const records: Array<Record<string, string>> = [];

    for (let index = 0; index < 11; index += 1) {
      const sourceId = `approved-${String(index).padStart(3, '0')}`;
      const derivativePath = `castor-solon/sources/web-imports/batch-1/${sourceId}.md`;
      const marker = index === 0 ? 'revokedfirstpagetoken' : `governance derivative ${sourceId}`;
      const contentHash = writeDerivative(root, derivativePath, marker);
      records.push({
        source_id: sourceId,
        domain_id: 'governance',
        workspace_relative_path: derivativePath,
        trust_domain: 'internal',
        tier: 'S3',
        classification_status: 'approved',
        content_hash: contentHash,
      });
    }

    writeFileSync(registryPath, records.map((record) => JSON.stringify(record)).join('\n'));
    const first = await runDomainLibrarySync({
      workspaceRoot: root,
      registryRelativePath: REGISTRY_PATH,
      dbPath,
      pageLimit: 5,
    });
    expect(first.summary.itemsSeen).toBe(11);
    expect(first.summary.cursor).toBeUndefined();
    expect(first.summary.gaps).not.toContain('full_snapshot_reconcile_skipped: sync was cursored, bounded, or did not reach a done page.');

    const blockedRecords = records.map((record) => ({ ...record }));
    blockedRecords[0]!.classification_status = 'blocked';
    writeFileSync(registryPath, blockedRecords.map((record) => JSON.stringify(record)).join('\n'));

    const second = await runDomainLibrarySync({
      workspaceRoot: root,
      registryRelativePath: REGISTRY_PATH,
      dbPath,
      pageLimit: 5,
    });
    expect(second.summary.itemsSeen).toBe(10);
    expect(second.summary.itemsTombstoned).toBe(1);
    expect(second.summary.cursor).toBeUndefined();
    expect(second.summary.gaps).not.toContain('full_snapshot_reconcile_skipped: sync was cursored, bounded, or did not reach a done page.');
    expect(second.registry.stats).toMatchObject({
      parsedRecords: 11,
      blockedRecords: 1,
      eligibleRecords: 10,
      excludedRecords: 1,
    });

    const store = new LocalConnectorStore({
      dbPath,
      corpusId: DOMAIN_LIBRARY_CORPUS_ID,
      family: 'file',
      trustDomain: 'internal',
    });
    try {
      expect(store.status().counts.items).toBe(10);
      expect(store.status().counts.tombstonedItems).toBe(1);
      expect(store.status().lastSyncRun?.cursor).toBeUndefined();
      expect(store.searchItems('revokedfirstpagetoken', 10)).toEqual([]);
      expect(store.localContent('solon:governance:approved-000')).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

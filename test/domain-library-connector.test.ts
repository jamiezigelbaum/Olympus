import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { createDomainLibrarySourceConnector } from '../src/workers/domain-library/index.ts';

const REGISTRY_PATH = 'castor-solon/references/source-registry.jsonl';

function workspaceFixture(): { root: string; registryPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'domain-library-connector-'));
  mkdirSync(join(root, 'castor-solon', 'references'), { recursive: true });
  mkdirSync(join(root, 'castor-solon', 'sources', 'web-imports', 'batch-1'), { recursive: true });
  return { root, registryPath: join(root, REGISTRY_PATH) };
}

function writeDerivative(root: string, relativePath: string, text: string): string {
  writeFileSync(join(root, relativePath), text);
  return createHash('sha256').update(text).digest('hex');
}

async function drain(pages: AsyncIterable<SourceConnectorListPage>): Promise<SourceConnectorListPage[]> {
  const collected: SourceConnectorListPage[] = [];
  for await (const page of pages) collected.push(page);
  return collected;
}

async function drainItems(connector: SourceConnector, options?: { cursor?: string; limit?: number }): Promise<RawItem[]> {
  return (await drain(connector.listItems(options))).flatMap((page) => [...page.items]);
}

describe('DomainLibrarySourceConnector', () => {
  test('lists only eligible registry derivatives with provenance metadata', async () => {
    const { root, registryPath } = workspaceFixture();
    const approvedPath = 'castor-solon/sources/web-imports/batch-1/approved.md';
    const approvedHash = writeDerivative(root, approvedPath, 'approved library derivative');
    const unclassifiedPath = 'castor-solon/sources/web-imports/batch-1/unclassified.md';
    writeDerivative(root, unclassifiedPath, 'unclassified derivative');
    const s4Path = 'castor-solon/sources/web-imports/batch-1/private.md';
    const s4Hash = writeDerivative(root, s4Path, 'private derivative');
    const removedPath = 'castor-solon/sources/web-imports/batch-1/removed.md';
    const removedHash = writeDerivative(root, removedPath, 'removed derivative');
    writeFileSync(registryPath, [
      JSON.stringify({
        source_id: 'solon-approved',
        domain_id: 'governance',
        kind: 'web_import',
        title: 'Approved library note',
        source_url: 'https://example.test/source',
        workspace_relative_path: approvedPath,
        batch_id: 'batch-1',
        transcript_source: 'captions',
        trust_domain: 'internal',
        tier: 'S3',
        classification_status: 'approved',
        content_hash: approvedHash,
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
        source_id: 'solon-removed',
        workspace_relative_path: removedPath,
        trust_domain: 'internal',
        tier: 'S2',
        classification_status: 'approved',
        content_hash: removedHash,
        ingest_status: 'removed',
        removed: true,
      }),
    ].join('\n'));

    const connector = createDomainLibrarySourceConnector({
      workspaceRoot: root,
      registryRelativePath: REGISTRY_PATH,
      account: 'solon',
    });
    await connector.authenticate();

    const items = await drainItems(connector);
    expect(items).toHaveLength(1);
    expect(items[0]?.identity).toEqual({
      family: 'file',
      provider: 'domain_library',
      accountScope: 'solon',
      providerItemId: 'solon-approved',
      providerFileId: 'solon-approved',
      localItemId: 'solon:governance:solon-approved',
      sourceVersion: approvedHash,
    });
    expect(items[0]?.content).toEqual({ kind: 'metadata_only' });
    expect(items[0]?.metadata).toMatchObject({
      title: 'Approved library note',
      name: 'Approved library note',
      locatorUri: 'https://example.test/source',
      pathDisplay: approvedPath,
      sourceUrl: 'https://example.test/source',
      importBatchId: 'batch-1',
      transcriptSource: 'captions',
      registryTrustDomain: 'internal',
      registryTier: 'S3',
      classificationStatus: 'approved',
      targetTrustDomain: 'internal',
    });

    const fetched = await connector.fetchItem('solon:governance:solon-approved');
    expect(fetched.content).toEqual({ kind: 'text', text: 'approved library derivative' });
    const sensitivity = connector.classify(fetched);
    expect(sensitivity).toMatchObject({
      trustDomain: 'internal',
      trustTier: 'S3',
      localOnly: false,
      cloudEmbeddingEligible: true,
    });
  });

  test('paginates eligible records with integer cursors and rejects invalid cursors', async () => {
    const { root, registryPath } = workspaceFixture();
    const records = ['one', 'two', 'three'].map((id) => {
      const path = `castor-solon/sources/web-imports/batch-1/${id}.md`;
      const hash = writeDerivative(root, path, `derivative ${id}`);
      return JSON.stringify({
        source_id: id,
        domain_id: 'governance',
        workspace_relative_path: path,
        trust_domain: 'internal',
        tier: 'S2',
        classification_status: 'approved',
        content_hash: hash,
      });
    });
    writeFileSync(registryPath, records.join('\n'));
    const connector = createDomainLibrarySourceConnector({ workspaceRoot: root, registryRelativePath: REGISTRY_PATH });

    const pages = await drain(connector.listItems({ limit: 2 }));
    expect(pages[0]?.items.map((item) => item.identity.providerItemId)).toEqual(['one', 'two']);
    expect(pages[0]?.nextCursor).toBe('2');
    expect(pages[0]?.done).toBe(false);
    expect(pages[1]?.items.map((item) => item.identity.providerItemId)).toEqual(['three']);
    expect(pages[1]?.done).toBe(true);

    const resumed = await drainItems(connector, { cursor: '2' });
    expect(resumed.map((item) => item.identity.providerItemId)).toEqual(['three']);
    await expect(drainItems(connector, { cursor: '2.5' })).rejects.toThrow('cursor');
  });
});

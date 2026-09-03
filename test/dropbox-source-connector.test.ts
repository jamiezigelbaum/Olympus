// Contract 1 (SourceConnector) conformance tests for the Dropbox connector.
// Everything runs against fakes: a counting credential broker, a paging
// metadata client, and a bounded download client. The final test is the
// thinness guard — the connector must not reach into storage or the legacy
// index/extraction modules (storage stays in the shared spine).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import {
  StaticCredentialBroker,
  type CredentialBroker,
  type CredentialSessionRequest,
} from '../src/workers/credential-broker/index.ts';
import {
  DropboxContentTooLargeError,
  createDropboxSourceConnector,
  type DropboxContentDownloadClient,
  type DropboxContentDownloadRequest,
  type DropboxMetadataClient,
  type DropboxMetadataContinueRequest,
  type DropboxMetadataListRequest,
  type DropboxMetadataPage,
} from '../src/workers/dropbox-files/index.ts';
import { SOURCE_CHECKPOINT_MAX_LENGTH } from '../src/workers/source-checkpoint.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';

const ACCOUNT = 'personal';
const HANDLE = 'dropbox.personal';

function countingBroker(): { broker: CredentialBroker; issued: () => number } {
  const inner = new StaticCredentialBroker([{
    handle: HANDLE,
    provider: 'dropbox',
    allowedCapabilities: ['dropbox.files.sync'],
    token: 'fake-dropbox-token',
    scopes: ['files.metadata.read', 'files.content.read'],
    trustDomain: 'secure_local',
    accountRole: 'personal',
  }]);
  let count = 0;
  return {
    broker: {
      issueSession: async (request: CredentialSessionRequest) => {
        count += 1;
        return inner.issueSession(request);
      },
    },
    issued: () => count,
  };
}

function fakeMetadataClient(calls: string[]): DropboxMetadataClient {
  const pageOne: DropboxMetadataPage = {
    entries: [
      {
        tag: 'file',
        id: 'id:file-receipt',
        name: 'Portugal Receipt.pdf',
        pathDisplay: '/Approved/Portugal Receipt.pdf',
        pathLower: '/approved/portugal receipt.pdf',
        rev: 'rev-11',
        contentHash: 'hash-receipt',
        size: 2_048,
        clientModified: '2026-06-01T10:00:00Z',
        serverModified: '2026-06-02T10:00:00Z',
      },
      {
        tag: 'folder',
        id: 'id:folder-taxes',
        name: 'Taxes',
        pathDisplay: '/Approved/Taxes',
      },
    ],
    cursor: 'cursor-page-1',
    hasMore: true,
  };
  const pageTwo: DropboxMetadataPage = {
    entries: [
      {
        tag: 'deleted',
        name: 'Old Draft.txt',
        pathDisplay: '/Approved/Old Draft.txt',
        pathLower: '/approved/old draft.txt',
      },
      {
        tag: 'file',
        id: 'id:file-notes',
        name: 'notes.md',
        pathDisplay: '/Approved/notes.md',
        rev: 'rev-3',
      },
    ],
    cursor: 'cursor-page-2',
    hasMore: false,
  };
  return {
    supportsNativeRecursive: true,
    async listFolder(request: DropboxMetadataListRequest): Promise<DropboxMetadataPage> {
      calls.push(`list:${request.path}:${request.recursive}:${request.limit}:${request.includeDeleted === true}`);
      return pageOne;
    },
    async listFolderContinue(request: DropboxMetadataContinueRequest): Promise<DropboxMetadataPage> {
      calls.push(`continue:${request.cursor}:${request.limit}`);
      return pageTwo;
    },
  };
}

function fakeDownloadClient(downloads: DropboxContentDownloadRequest[]): DropboxContentDownloadClient {
  return {
    async download(request: DropboxContentDownloadRequest) {
      downloads.push(request);
      const cap = request.max_bytes_per_file;
      if (request.job.provider_file_id === 'id:file-huge') throw new DropboxContentTooLargeError();
      const bytes = new TextEncoder().encode('hello dropbox bytes');
      if (cap !== undefined && bytes.byteLength > cap) throw new DropboxContentTooLargeError();
      return { bytes, mime_type: 'text/plain; charset=utf-8', size_bytes: bytes.byteLength };
    },
  };
}

function connectorWithFakes(overrides: {
  broker?: CredentialBroker;
  metadataClient?: DropboxMetadataClient;
  downloadClient?: DropboxContentDownloadClient;
  maxFetchBytes?: number;
  onPageDigestRestart?: () => void;
} = {}): SourceConnector {
  return createDropboxSourceConnector({
    account: ACCOUNT,
    approvedScopeKey: 'dropbox.personal:/Approved',
    broker: overrides.broker ?? countingBroker().broker,
    metadataClient: overrides.metadataClient ?? fakeMetadataClient([]),
    downloadClient: overrides.downloadClient ?? fakeDownloadClient([]),
    ...(overrides.maxFetchBytes !== undefined ? { maxFetchBytes: overrides.maxFetchBytes } : {}),
    ...(overrides.onPageDigestRestart ? { onPageDigestRestart: overrides.onPageDigestRestart } : {}),
  });
}

async function drain(pages: AsyncIterable<SourceConnectorListPage>): Promise<SourceConnectorListPage[]> {
  const collected: SourceConnectorListPage[] = [];
  for await (const page of pages) collected.push(page);
  return collected;
}

function requiredCheckpoint(page: SourceConnectorListPage | undefined): string {
  const checkpoint = page?.nextCursor;
  if (!checkpoint) throw new Error('expected a continuation checkpoint');
  return checkpoint;
}

describe('Dropbox SourceConnector (Contract 1)', () => {
  test('exposes the frozen contract identity', () => {
    const connector = connectorWithFakes();
    expect(connector.id).toBe('dropbox');
    expect(connector.family).toBe('file');
  });

  test('authenticate issues one broker session and caches it', async () => {
    const { broker, issued } = countingBroker();
    const connector = connectorWithFakes({ broker });

    await connector.authenticate();
    await connector.authenticate();
    await connector.fetchItem('personal:id:file-receipt');

    expect(issued()).toBe(1);
  });

  test('authenticate surfaces missing credentials clearly', async () => {
    const broker = new StaticCredentialBroker([{
      handle: HANDLE,
      provider: 'dropbox',
      allowedCapabilities: ['dropbox.files.sync'],
      trustDomain: 'secure_local',
    }]);
    const connector = connectorWithFakes({ broker });

    await expect(connector.authenticate()).rejects.toThrow(/credential_missing.*dropbox\.personal/);
  });

  test('listItems paginates with cursors and maps entries to contract RawItems', async () => {
    const calls: string[] = [];
    const connector = connectorWithFakes({ metadataClient: fakeMetadataClient(calls) });

    const pages = await drain(connector.listItems({ limit: 50 }));

    expect(calls).toEqual([
      'list:/Approved:true:50:true',
      'continue:cursor-page-1:50',
    ]);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.nextCursor).toBe('cursor-page-1');
    expect(pages[0]?.done).toBe(false);
    expect(pages[1]?.nextCursor).toBe('cursor-page-2');
    expect(pages[1]?.done).toBe(true);

    const file = pages[0]?.items[0] as RawItem;
    expect(file.identity).toEqual({
      family: 'file',
      provider: 'dropbox',
      accountScope: ACCOUNT,
      providerItemId: 'id:file-receipt',
      providerFileId: 'id:file-receipt',
      localItemId: 'personal:id:file-receipt',
      sourceVersion: 'rev-11',
    });
    expect(file.mimeType).toBe('application/pdf');
    expect(file.content).toEqual({ kind: 'metadata_only' });
    expect(file.metadata).toEqual({
      entryKind: 'file',
      deleted: false,
      name: 'Portugal Receipt.pdf',
      mimeType: 'application/pdf',
      pathDisplay: '/Approved/Portugal Receipt.pdf',
      // The provider's own casefold of the path, carried deliberately. Dropbox
      // paths are case-insensitive, so a folder exclusion compared against the
      // display path alone can miss on casing — and a miss there admits exactly
      // the material the owner asked to keep out.
      pathLower: '/approved/portugal receipt.pdf',
      sizeBytes: 2_048,
      clientModifiedAt: '2026-06-01T10:00:00Z',
      serverModifiedAt: '2026-06-02T10:00:00Z',
      contentHash: 'hash-receipt',
    });

    const folder = pages[0]?.items[1] as RawItem;
    expect(folder.identity.providerItemId).toBe('id:folder-taxes');
    expect(folder.identity.providerFileId).toBeUndefined();
    expect(folder.content).toEqual({ kind: 'metadata_only' });
    expect(folder.metadata.entryKind).toBe('folder');

    const markdown = pages[1]?.items[1] as RawItem;
    expect(markdown.mimeType).toBe('text/plain');
    expect(markdown.identity.sourceVersion).toBe('rev-3');
  });

  test('listItems resumes from a provided cursor', async () => {
    const calls: string[] = [];
    const connector = connectorWithFakes({ metadataClient: fakeMetadataClient(calls) });

    const pages = await drain(connector.listItems({ cursor: 'cursor-page-1', limit: 25 }));

    expect(calls).toEqual(['continue:cursor-page-1:25']);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.done).toBe(true);
  });

  test('resumes inside an oversized continuation page without exposing page contents in the cursor', async () => {
    const calls: string[] = [];
    const continuationPage: DropboxMetadataPage = {
      entries: [
        { tag: 'file', id: 'id:tail-1', name: 'Private One.txt', pathDisplay: '/Approved/Private One.txt' },
        { tag: 'file', id: 'id:tail-2', name: 'Private Two.txt', pathDisplay: '/Approved/Private Two.txt' },
        { tag: 'file', id: 'id:tail-3', name: 'Private Three.txt', pathDisplay: '/Approved/Private Three.txt' },
      ],
      cursor: 'cursor-finished',
      hasMore: false,
    };
    const connector = connectorWithFakes({
      metadataClient: {
        supportsNativeRecursive: true,
        async listFolder(): Promise<DropboxMetadataPage> {
          calls.push('list');
          return {
            entries: [{ tag: 'file', id: 'id:head', name: 'Head.txt', pathDisplay: '/Approved/Head.txt' }],
            cursor: 'cursor-tail-page',
            hasMore: true,
          };
        },
        async listFolderContinue(request): Promise<DropboxMetadataPage> {
          calls.push(`continue:${request.cursor}`);
          return continuationPage;
        },
      },
    });

    const first = await drain(connector.listItems({ limit: 2 }));
    expect(first).toHaveLength(2);
    expect(first[1]?.items.map((item) => item.identity.providerItemId)).toEqual(['id:tail-1']);
    expect(first[1]?.truncated).toBe(true);
    const checkpoint = first[1]?.nextCursor;
    expect(checkpoint).toStartWith('dbxp1:');
    expect(checkpoint).not.toContain('Private');
    expect(checkpoint).not.toContain('/Approved');

    const resumed = await drain(connector.listItems({ cursor: checkpoint!, limit: 2 }));
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.items.map((item) => item.identity.providerItemId))
      .toEqual(['id:tail-2', 'id:tail-3']);
    expect(resumed[0]?.done).toBe(true);
    expect(calls).toEqual(['list', 'continue:cursor-tail-page', 'continue:cursor-tail-page']);
  });

  test('persists and resumes a digest-bound cursor above the historical scheduler limit', async () => {
    const providerCursor = `cursor-${'p'.repeat(4_096)}`;
    const continuationPage: DropboxMetadataPage = {
      entries: [
        { tag: 'file', id: 'id:tail-1', name: 'One.txt', pathDisplay: '/Approved/One.txt' },
        { tag: 'file', id: 'id:tail-2', name: 'Two.txt', pathDisplay: '/Approved/Two.txt' },
        { tag: 'file', id: 'id:tail-3', name: 'Three.txt', pathDisplay: '/Approved/Three.txt' },
      ],
      cursor: 'cursor-finished',
      hasMore: false,
    };
    let continuationCalls = 0;
    const connector = connectorWithFakes({
      metadataClient: {
        supportsNativeRecursive: true,
        async listFolder(): Promise<DropboxMetadataPage> {
          return {
            entries: [{ tag: 'file', id: 'id:head', name: 'Head.txt', pathDisplay: '/Approved/Head.txt' }],
            cursor: providerCursor,
            hasMore: true,
          };
        },
        async listFolderContinue(request): Promise<DropboxMetadataPage> {
          expect(request.cursor).toBe(providerCursor);
          continuationCalls += 1;
          return continuationPage;
        },
      },
    });

    const first = await drain(connector.listItems({ limit: 2 }));
    const checkpoint = first[1]?.nextCursor;
    expect(checkpoint).toStartWith('dbxp1:');
    if (!checkpoint) throw new Error('expected a digest-bound continuation checkpoint');
    expect(checkpoint.length).toBeGreaterThan(4_096);
    expect(checkpoint.length).toBeLessThanOrEqual(SOURCE_CHECKPOINT_MAX_LENGTH);

    const stateStore = new LocalSourceSchedulerStateStore(':memory:');
    try {
      const persisted = stateStore.recordSuccess({
        sourceId: 'dropbox.files',
        corpusId: 'secure_local.dropbox.files',
        taskId: 'dropbox.files_store_pull.fixture',
        completedAt: '2026-08-27T22:33:53.618Z',
        resultStatus: 'progress',
        checkpoint,
      });
      expect(persisted.checkpoint).toBe(checkpoint);
      if (!persisted.checkpoint) throw new Error('expected the scheduler to persist the checkpoint');

      const resumed = await drain(connector.listItems({ cursor: persisted.checkpoint, limit: 2 }));
      expect(resumed).toHaveLength(1);
      expect(resumed[0]?.items.map((item) => item.identity.providerItemId))
        .toEqual(['id:tail-2', 'id:tail-3']);
      expect(resumed[0]?.done).toBe(true);
      expect(continuationCalls).toBe(2);
    } finally {
      stateStore.close();
    }
  });

  test('restarts a changed provider page at zero and preserves its unread tail', async () => {
    let page: DropboxMetadataPage = {
      entries: [
        { tag: 'file', id: 'id:old-a', name: 'Old A.txt', pathDisplay: '/Approved/Old A.txt' },
        { tag: 'file', id: 'id:old-b', name: 'Old B.txt', pathDisplay: '/Approved/Old B.txt' },
        { tag: 'file', id: 'id:old-c', name: 'Old C.txt', pathDisplay: '/Approved/Old C.txt' },
      ],
      cursor: 'cursor-finished',
      hasMore: false,
    };
    let digestRestarts = 0;
    const connector = connectorWithFakes({
      onPageDigestRestart: () => {
        digestRestarts += 1;
      },
      metadataClient: {
        supportsNativeRecursive: true,
        async listFolder(): Promise<DropboxMetadataPage> {
          return page;
        },
        async listFolderContinue(): Promise<DropboxMetadataPage> {
          throw new Error('unexpected continuation');
        },
      },
    });

    const first = await drain(connector.listItems({ limit: 1 }));
    const checkpoint = requiredCheckpoint(first[0]);
    expect(checkpoint).toStartWith('dbxp1:');
    page = {
      entries: [
        { tag: 'file', id: 'id:new-prefix', name: 'New Prefix.txt', pathDisplay: '/Approved/New Prefix.txt' },
        { tag: 'file', id: 'id:old-c', name: 'Old C.txt', pathDisplay: '/Approved/Old C.txt' },
        { tag: 'file', id: 'id:old-a', name: 'Old A.txt', pathDisplay: '/Approved/Old A.txt' },
        { tag: 'file', id: 'id:new-tail', name: 'New Tail.txt', pathDisplay: '/Approved/New Tail.txt' },
      ],
      cursor: 'cursor-finished',
      hasMore: false,
    };

    const changed = await drain(connector.listItems({ cursor: checkpoint!, limit: 2 }));
    expect(changed).toHaveLength(1);
    expect(changed[0]?.items.map((item) => item.identity.providerItemId))
      .toEqual(['id:new-prefix', 'id:old-c']);
    expect(changed[0]?.truncated).toBe(true);
    const freshCheckpoint = requiredCheckpoint(changed[0]);
    expect(freshCheckpoint).toStartWith('dbxp1:');
    expect(freshCheckpoint?.length).toBeLessThanOrEqual(SOURCE_CHECKPOINT_MAX_LENGTH);
    expect(freshCheckpoint).not.toContain('New Prefix');
    expect(freshCheckpoint).not.toContain('/Approved');
    expect(digestRestarts).toBe(1);

    const stateStore = new LocalSourceSchedulerStateStore(':memory:');
    try {
      const persisted = stateStore.recordSuccess({
        sourceId: 'dropbox.files',
        corpusId: 'secure_local.dropbox.files',
        taskId: 'dropbox.files_store_pull.changed-page',
        completedAt: '2026-08-28T00:00:00.000Z',
        resultStatus: 'progress',
        checkpoint: freshCheckpoint,
      });
      const persistedCheckpoint = persisted.checkpoint;
      if (!persistedCheckpoint) throw new Error('expected the scheduler to persist the changed-page checkpoint');
      const tail = await drain(connector.listItems({ cursor: persistedCheckpoint, limit: 2 }));
      expect(tail[0]?.items.map((item) => item.identity.providerItemId))
        .toEqual(['id:old-a', 'id:new-tail']);
      expect(tail[0]?.done).toBe(true);
      expect(digestRestarts).toBe(1);
    } finally {
      stateStore.close();
    }
  });

  test('keeps repeated provider-page churn bounded without applying a stale offset', async () => {
    const pages: DropboxMetadataPage[] = [
      {
        entries: [
          { tag: 'file', id: 'id:a', name: 'A.txt', pathDisplay: '/Approved/A.txt' },
          { tag: 'file', id: 'id:b', name: 'B.txt', pathDisplay: '/Approved/B.txt' },
        ],
        hasMore: false,
      },
      {
        entries: [
          { tag: 'file', id: 'id:new-1', name: 'New 1.txt', pathDisplay: '/Approved/New 1.txt' },
          { tag: 'file', id: 'id:a', name: 'A.txt', pathDisplay: '/Approved/A.txt' },
          { tag: 'file', id: 'id:b', name: 'B.txt', pathDisplay: '/Approved/B.txt' },
        ],
        hasMore: false,
      },
      {
        entries: [
          { tag: 'file', id: 'id:new-2', name: 'New 2.txt', pathDisplay: '/Approved/New 2.txt' },
          { tag: 'file', id: 'id:new-1', name: 'New 1.txt', pathDisplay: '/Approved/New 1.txt' },
          { tag: 'file', id: 'id:a', name: 'A.txt', pathDisplay: '/Approved/A.txt' },
          { tag: 'file', id: 'id:b', name: 'B.txt', pathDisplay: '/Approved/B.txt' },
        ],
        hasMore: false,
      },
    ];
    let call = 0;
    let digestRestarts = 0;
    const connector = connectorWithFakes({
      onPageDigestRestart: () => {
        digestRestarts += 1;
      },
      metadataClient: {
        supportsNativeRecursive: true,
        async listFolder(): Promise<DropboxMetadataPage> {
          return pages[Math.min(call++, pages.length - 1)]!;
        },
        async listFolderContinue(): Promise<DropboxMetadataPage> {
          throw new Error('unexpected continuation');
        },
      },
    });

    const first = await drain(connector.listItems({ limit: 1 }));
    const second = await drain(connector.listItems({ cursor: requiredCheckpoint(first[0]), limit: 1 }));
    const third = await drain(connector.listItems({ cursor: requiredCheckpoint(second[0]), limit: 1 }));
    const stable = await drain(connector.listItems({ cursor: requiredCheckpoint(third[0]), limit: 1 }));

    expect(first[0]?.items[0]?.identity.providerItemId).toBe('id:a');
    expect(second[0]?.items[0]?.identity.providerItemId).toBe('id:new-1');
    expect(third[0]?.items[0]?.identity.providerItemId).toBe('id:new-2');
    expect(stable[0]?.items[0]?.identity.providerItemId).toBe('id:new-1');
    expect([first, second, third, stable].every((result) => result[0]?.items.length === 1)).toBe(true);
    expect(digestRestarts).toBe(2);
    expect(call).toBe(4);
  });

  test('deleted entries are surfaced as tombstones, not skipped', async () => {
    const connector = connectorWithFakes({ metadataClient: fakeMetadataClient([]) });

    const pages = await drain(connector.listItems());
    const tombstone = pages[1]?.items[0] as RawItem;

    expect(tombstone.metadata.deleted).toBe(true);
    expect(tombstone.metadata.entryKind).toBe('deleted');
    expect(tombstone.content).toEqual({ kind: 'metadata_only' });
    expect(tombstone.identity.providerItemId.startsWith('deleted:')).toBe(true);
    expect(tombstone.identity.localItemId).toBe(`personal:${tombstone.identity.providerItemId}`);
  });

  test('fetchItem returns bounded bytes with mimeType', async () => {
    const downloads: DropboxContentDownloadRequest[] = [];
    const connector = connectorWithFakes({ downloadClient: fakeDownloadClient(downloads), maxFetchBytes: 1_024 });

    const item = await connector.fetchItem('personal:id:file-receipt');

    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.job.provider_file_id).toBe('id:file-receipt');
    expect(downloads[0]?.max_bytes_per_file).toBe(1_024);
    expect(item.identity.localItemId).toBe('personal:id:file-receipt');
    expect(item.identity.providerItemId).toBe('id:file-receipt');
    expect(item.mimeType).toBe('text/plain; charset=utf-8');
    expect(item.content.kind).toBe('bytes');
    if (item.content.kind !== 'bytes') throw new Error('expected bytes content');
    expect(new TextDecoder().decode(item.content.bytes)).toBe('hello dropbox bytes');
    expect(item.metadata.sizeBytes).toBe(19);
  });

  test('fetchItem falls back to metadata_only when content exceeds the byte cap', async () => {
    const downloads: DropboxContentDownloadRequest[] = [];
    const connector = connectorWithFakes({ downloadClient: fakeDownloadClient(downloads), maxFetchBytes: 8 });

    const huge = await connector.fetchItem('personal:id:file-huge');
    const capped = await connector.fetchItem('personal:id:file-receipt');

    expect(huge.content).toEqual({ kind: 'metadata_only' });
    expect(huge.metadata.contentTooLarge).toBe(true);
    expect(huge.metadata.maxFetchBytes).toBe(8);
    expect(capped.content).toEqual({ kind: 'metadata_only' });
  });

  test('fetchItem rejects local item ids outside the connector account', async () => {
    const connector = connectorWithFakes();
    await expect(connector.fetchItem('work:id:file-receipt')).rejects.toThrow(/personal:<provider item id>/);
  });

  test('classify defaults to the conservative S4/secure_local floor', async () => {
    const connector = connectorWithFakes();
    const pages = await drain(connector.listItems());
    const sensitivity = connector.classify(pages[0]?.items[0] as RawItem);

    expect(sensitivity).toEqual({
      trustTier: 'S4',
      trustDomain: 'secure_local',
      localOnly: true,
      cloudEmbeddingEligible: false,
    });
  });

  test('classify upgrades secret-bearing text to S5 and never downgrades', async () => {
    const connector = connectorWithFakes();
    const item = await connector.fetchItem('personal:id:file-receipt');
    const secretItem: RawItem = {
      ...item,
      content: {
        kind: 'bytes',
        mimeType: 'text/plain',
        bytes: new TextEncoder().encode('aws key AKIAABCDEFGHIJKLMNOP found in export'),
      },
    };

    const sensitivity = connector.classify(secretItem);

    expect(sensitivity.trustTier).toBe('S5');
    expect(sensitivity.trustDomain).toBe('secure_local');
    expect(sensitivity.localOnly).toBe(true);
    expect(sensitivity.cloudEmbeddingEligible).toBe(false);

    const benign = connector.classify(item);
    expect(benign.trustTier).toBe('S4');
    expect(benign.trustDomain).toBe('secure_local');
  });

  test('connector stays thin: no storage imports from local-index', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'src', 'workers', 'dropbox-files', 'connector.ts'),
      'utf8',
    );
    const importLines = source.split('\n').filter((line) => /^\s*(import|export)\b.*from\s+'/.test(line) || /from\s+'[^']+';\s*$/.test(line));
    expect(importLines.some((line) => line.includes('local-index'))).toBe(false);
    expect(source.includes('LocalDropboxFilesIndex')).toBe(false);
  });
});

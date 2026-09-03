import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { SourceItemIdentity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  DROPBOX_FILES_CORPUS_ID,
  DROPBOX_PROVIDER_STORE_RECEIPT_KIND,
  createDropboxProviderStoreSyncHandler,
  dropboxConnectorIdForScope,
  type DropboxFileMetadataEntry,
  type DropboxMetadataClient,
  type DropboxMetadataPage,
} from '../src/workers/dropbox-files/index.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const APPROVED_SCOPE = 'dropbox.personal:/Olympus Approved/JOB_SECRET_PATH';
const RAW_FOLDER_PATH = '/Olympus Approved/JOB_SECRET_PATH';
const BROKER_TOKEN = 'broker-dropbox-job-token-secret';

describe('Dropbox canonical provider-to-store pull', () => {
  test('performs the bounded pull immediately and returns a counts-only receipt', async () => {
    await withStore(async (store) => {
      const handler = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: dropboxBroker(),
        metadataClient: singlePageClient([
          fileEntry('id:file-alpha', 'Alpha Notes.txt'),
          fileEntry('id:file-beta', 'Beta Notes.txt'),
        ]),
      });

      const result = await handler.pull({
        approved_scope_key: APPROVED_SCOPE,
        max_items: 100,
      });
      const serialized = JSON.stringify(result);

      expect(result.receipt).toMatchObject({
        kind: DROPBOX_PROVIDER_STORE_RECEIPT_KIND,
        status: 'progress',
        counts: {
          items_seen: 2,
          items_changed: 2,
          traversal_complete: 1,
          resumed_from_checkpoint: 0,
        },
        policy: {
          counts_only: true,
          raw_source_exposed: false,
          source_text_returned: false,
          provider_cursor_exposed: false,
          native_recursive_only: true,
          content_extraction: 'shared_factory',
        },
      });
      expect(result.receipt.receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(store.itemPresence(identity('id:file-alpha'))).toEqual({
        active: true,
        sourceVersion: 'rev-id:file-alpha',
        contentHash: 'hash-id:file-alpha',
      });
      expect(handler.lastStoreRunCompletedAt()).toBeDefined();
      expect(serialized).not.toContain(BROKER_TOKEN);
      expect(serialized).not.toContain(RAW_FOLDER_PATH);
      expect(serialized).not.toContain(APPROVED_SCOPE);
    });
  });

  test('resumes the durable scope-specific checkpoint and reports an unchanged replay as idle', async () => {
    await withStore(async (store) => {
      const calls: string[] = [];
      const entry = fileEntry('id:stable', 'Stable.txt');
      const client: DropboxMetadataClient = {
        supportsNativeRecursive: true,
        async listFolder(request): Promise<DropboxMetadataPage> {
          calls.push('list:' + request.path);
          return { entries: [entry], cursor: 'cursor-1', hasMore: false };
        },
        async listFolderContinue(request): Promise<DropboxMetadataPage> {
          calls.push('continue:' + request.cursor);
          return { entries: [entry], cursor: 'cursor-2', hasMore: false };
        },
      };
      const handler = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: dropboxBroker(),
        metadataClient: client,
      });

      const first = await handler.pull({ approved_scope_key: APPROVED_SCOPE });
      const second = await handler.pull({ approved_scope_key: APPROVED_SCOPE });

      expect(first.receipt.status).toBe('progress');
      expect(second.receipt).toMatchObject({
        status: 'idle',
        counts: {
          items_seen: 1,
          items_changed: 0,
          resumed_from_checkpoint: 1,
          traversal_complete: 1,
        },
      });
      expect(calls).toEqual([
        'list:' + RAW_FOLDER_PATH,
        'continue:cursor-1',
      ]);
      expect(store.lastCompletedSyncRun(handler.connectorIdForScope(APPROVED_SCOPE))?.cursor)
        .toBe('cursor-2');
    });
  });

  test('keeps independently approved roots on distinct opaque connector ids and checkpoints', async () => {
    await withStore(async (store) => {
      const client: DropboxMetadataClient = {
        supportsNativeRecursive: true,
        async listFolder(request): Promise<DropboxMetadataPage> {
          return { entries: [], cursor: 'cursor:' + request.path, hasMore: false };
        },
        async listFolderContinue(): Promise<DropboxMetadataPage> {
          throw new Error('unexpected continuation');
        },
      };
      const handler = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: dropboxBroker(),
        metadataClient: client,
      });
      const scopeA = 'dropbox.personal:/Approved A';
      const scopeB = 'dropbox.personal:/Approved B';

      await handler.pull({ approved_scope_key: scopeA });
      await handler.pull({ approved_scope_key: scopeB });

      const idA = dropboxConnectorIdForScope('personal', scopeA);
      const idB = dropboxConnectorIdForScope('personal', scopeB);
      expect(idA).not.toBe(idB);
      expect(idA).not.toContain('Approved');
      expect(store.lastCompletedSyncRun(idA)?.cursor).toBe('cursor:/Approved A');
      expect(store.lastCompletedSyncRun(idB)?.cursor).toBe('cursor:/Approved B');
    });
  });

  test('fails closed for a non-native recursive client, unsafe embedding backend, and invalid bounds', async () => {
    await withStore(async (store) => {
      expect(() => createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        embeddingProvider: remoteEmbeddingProvider(),
      })).toThrow('local/private embedding provider');

      const handler = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: dropboxBroker(),
        metadataClient: {
          supportsNativeRecursive: false,
          async listFolder(): Promise<DropboxMetadataPage> {
            return { entries: [], hasMore: false };
          },
          async listFolderContinue(): Promise<DropboxMetadataPage> {
            return { entries: [], hasMore: false };
          },
        },
      });
      await expect(handler.pull({ approved_scope_key: APPROVED_SCOPE }))
        .rejects.toThrow('requires native recursive listing');
      await expect(handler.pull({ approved_scope_key: APPROVED_SCOPE, max_items: 0 }))
        .rejects.toThrow('positive integer');
      expect(store.status().counts.items).toBe(0);
    });
  });
});

async function withStore(
  run: (store: LocalConnectorStore) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-dropbox-provider-store-pull-'));
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'dropbox.sqlite'),
    corpusId: DROPBOX_FILES_CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
  try {
    await run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function singlePageClient(entries: DropboxFileMetadataEntry[]): DropboxMetadataClient {
  return {
    supportsNativeRecursive: true,
    async listFolder(): Promise<DropboxMetadataPage> {
      return { entries, cursor: 'cursor-complete', hasMore: false };
    },
    async listFolderContinue(): Promise<DropboxMetadataPage> {
      throw new Error('unexpected continuation');
    },
  };
}

function fileEntry(id: string, name: string): DropboxFileMetadataEntry {
  return {
    tag: 'file',
    id,
    name,
    pathDisplay: RAW_FOLDER_PATH + '/' + name,
    pathLower: (RAW_FOLDER_PATH + '/' + name).toLowerCase(),
    rev: 'rev-' + id,
    contentHash: 'hash-' + id,
    size: 128,
    mimeType: 'text/plain',
  };
}

function identity(providerItemId: string): SourceItemIdentity {
  return {
    family: 'file',
    provider: 'dropbox',
    accountScope: 'personal',
    providerItemId,
    providerFileId: providerItemId,
    localItemId: 'personal:' + providerItemId,
  };
}

function dropboxBroker(): StaticCredentialBroker {
  return new StaticCredentialBroker([{
    handle: 'dropbox.personal',
    provider: 'dropbox',
    allowedCapabilities: ['dropbox.files.sync'],
    token: BROKER_TOKEN,
    scopes: ['files.metadata.read', 'files.content.read', 'sharing.read'],
    trustDomain: 'secure_local',
    accountRole: 'personal',
  }]);
}

function remoteEmbeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'unsafe-test',
    modelId: 'unsafe-remote-model',
    dimension: 2,
    configHash: 'unsafe-test-config',
    epochId: 'unsafe-test-epoch',
    backend: 'cloud',
    async embed(inputs) {
      return inputs.map(() => [1, 0]);
    },
  };
}

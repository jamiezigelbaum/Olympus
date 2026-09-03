import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  DROPBOX_FILES_CORPUS_ID,
  createDropboxProviderStoreSyncHandler,
  dropboxConnectorIdForScope,
  type DropboxMetadataClient,
  type DropboxMetadataPage,
} from '../src/workers/dropbox-files/index.ts';

const ACTIVE_SCOPE = 'dropbox.personal:/Active';
const RETIRED_SCOPE = 'dropbox.personal:/Retired';

describe('Dropbox canonical last-completed-run marker', () => {
  test('a retired scope cannot speak for the independently identified active lane', async () => {
    await withStore(async (store) => {
      const handler = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: broker(),
        metadataClient: pathCursorClient(),
      });

      await handler.pull({ approved_scope_key: RETIRED_SCOPE });
      const retiredId = dropboxConnectorIdForScope('personal', RETIRED_SCOPE);
      const activeId = dropboxConnectorIdForScope('personal', ACTIVE_SCOPE);

      expect(store.lastCompletedSyncRun(retiredId)?.cursor).toBe('cursor:/Retired');
      expect(store.lastCompletedSyncRun(activeId)).toBeUndefined();

      await handler.pull({ approved_scope_key: ACTIVE_SCOPE });
      expect(store.lastCompletedSyncRun(activeId)?.cursor).toBe('cursor:/Active');
      expect(store.lastCompletedSyncRun(retiredId)?.cursor).toBe('cursor:/Retired');
    });
  });

  test('a failed continuation never replaces the last completed resume checkpoint', async () => {
    await withStore(async (store) => {
      const calls: string[] = [];
      let failContinuation = false;
      const client: DropboxMetadataClient = {
        supportsNativeRecursive: true,
        async listFolder(): Promise<DropboxMetadataPage> {
          calls.push('list');
          return { entries: [], cursor: 'cursor-1', hasMore: false };
        },
        async listFolderContinue(request): Promise<DropboxMetadataPage> {
          calls.push('continue:' + request.cursor);
          if (failContinuation) throw new Error('synthetic provider outage');
          return { entries: [], cursor: 'cursor-2', hasMore: false };
        },
      };
      const handler = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: broker(),
        metadataClient: client,
      });
      const connectorId = handler.connectorIdForScope(ACTIVE_SCOPE);

      await handler.pull({ approved_scope_key: ACTIVE_SCOPE });
      expect(store.lastCompletedSyncRun(connectorId)?.cursor).toBe('cursor-1');

      failContinuation = true;
      await expect(handler.pull({ approved_scope_key: ACTIVE_SCOPE }))
        .rejects.toThrow('synthetic provider outage');
      expect(store.status().lastSyncRun?.status).toBe('failed');
      expect(store.lastCompletedSyncRun(connectorId)?.cursor).toBe('cursor-1');

      failContinuation = false;
      await handler.pull({ approved_scope_key: ACTIVE_SCOPE });
      expect(calls).toEqual(['list', 'continue:cursor-1', 'continue:cursor-1']);
      expect(store.lastCompletedSyncRun(connectorId)?.cursor).toBe('cursor-2');
    });
  });

  test('an empty store truthfully reports no completed run or completion timestamp', async () => {
    await withStore(async (store) => {
      const handler = createDropboxProviderStoreSyncHandler({
        store,
        account: 'personal',
        broker: broker(),
        metadataClient: pathCursorClient(),
      });

      expect(handler.lastStoreRunCompletedAt()).toBeUndefined();
      expect(store.lastCompletedSyncRun(handler.connectorIdForScope(ACTIVE_SCOPE))).toBeUndefined();
    });
  });
});

async function withStore(
  run: (store: LocalConnectorStore) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-dropbox-last-run-'));
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

function pathCursorClient(): DropboxMetadataClient {
  return {
    supportsNativeRecursive: true,
    async listFolder(request): Promise<DropboxMetadataPage> {
      return { entries: [], cursor: 'cursor:' + request.path, hasMore: false };
    },
    async listFolderContinue(): Promise<DropboxMetadataPage> {
      throw new Error('unexpected continuation');
    },
  };
}

function broker(): StaticCredentialBroker {
  return new StaticCredentialBroker([{
    handle: 'dropbox.personal',
    provider: 'dropbox',
    allowedCapabilities: ['dropbox.files.sync'],
    token: 'last-run-marker-token',
    scopes: ['files.metadata.read'],
    trustDomain: 'secure_local',
    accountRole: 'personal',
  }]);
}

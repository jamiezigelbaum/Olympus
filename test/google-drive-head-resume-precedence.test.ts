import { afterEach, describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
  createGoogleDriveConnectorStoreSyncHandler,
  type GoogleDriveConnectorStoreSyncHandler,
} from '../src/workers/google-connectors/index.ts';
import type {
  GoogleDriveApiClient,
  GoogleDriveFile,
  GoogleDriveListFilesRequest,
} from '../src/workers/google-connectors/drive.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const openStores: LocalConnectorStore[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
});

describe('Google Drive head resume precedence', () => {
  test('the scheduler envelope outranks the internal store cursor', async () => {
    const lane = driveLane(driveFiles(5), 2);

    const first = await lane.handler.pull({ max_items: 2 });
    const envelope = first.checkpoint ?? undefined;
    expect(envelope).toBeDefined();
    expect(first.receipt.counts.items_seen).toBe(2);

    // A whole pull completed, so both the envelope and the internal store row
    // moved to the next slice.
    const second = await lane.handler.pull({ max_items: 2, ...(envelope ? { checkpoint: envelope } : {}) });
    expect(second.receipt.counts.items_seen).toBe(2);
    expect(second.receipt.counts.resumed_from_checkpoint).toBe(1);

    // The failure shape: the internal leg committed its advanced cursor and the
    // secure leg (or the embed after it) threw, so the scheduler kept the older
    // envelope. Resuming from the store row would step past that window for
    // good; the envelope is the only position a complete pull ever wrote.
    const third = await lane.handler.pull({ max_items: 2, ...(envelope ? { checkpoint: envelope } : {}) });
    expect(third.receipt.counts.items_seen).toBe(2);
    expect(third.receipt.counts.resumed_from_checkpoint).toBe(1);
  });

  test('the internal store cursor still resumes a pull with no envelope', async () => {
    const lane = driveLane(driveFiles(5), 2);

    const first = await lane.handler.pull({ max_items: 2 });
    expect(first.receipt.counts.resumed_from_checkpoint).toBe(0);
    expect(first.receipt.counts.items_seen).toBe(2);

    // Wiped scheduler state: the store row is the only position left, and it
    // remains the fallback rather than restarting the traversal.
    const second = await lane.handler.pull({ max_items: 2 });
    expect(second.receipt.counts.resumed_from_checkpoint).toBe(1);
    expect(second.receipt.counts.items_seen).toBe(2);
  });
});

function driveLane(files: GoogleDriveFile[], maxFiles: number): {
  handler: GoogleDriveConnectorStoreSyncHandler;
  internalStore: LocalConnectorStore;
} {
  const internalStore = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
    family: 'file',
    trustDomain: 'internal',
  });
  const secureStore = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
  openStores.push(internalStore, secureStore);
  const provider = localEmbeddingProvider();
  return {
    internalStore,
    handler: createGoogleDriveConnectorStoreSyncHandler({
      internalStore,
      secureStore,
      account: 'personal',
      apiClient: fakeDriveClient(files),
      maxFiles,
      maxContentFiles: 50,
      internalEmbeddingProvider: provider,
      secureEmbeddingProvider: provider,
      env: {},
    }),
  };
}

function fakeDriveClient(files: GoogleDriveFile[]): GoogleDriveApiClient {
  return {
    async listFiles(request: GoogleDriveListFilesRequest) {
      const query = request.query ?? '';
      const after = /modifiedTime > '([^']+)'/.exec(query)?.[1];
      const eligible = files.filter((file) => !after || (file.modifiedTime ?? '').localeCompare(after) > 0);
      const offset = request.pageToken ? Number(request.pageToken) : 0;
      const slice = eligible.slice(offset, offset + request.pageSize);
      const nextOffset = offset + slice.length;
      return {
        files: slice,
        ...(nextOffset < eligible.length ? { nextPageToken: String(nextOffset) } : {}),
      };
    },
    async exportGoogleDocText(fileId: string) {
      return `Apollo roadmap notes for ${fileId}.`;
    },
    async downloadTextFile(fileId: string) {
      return `Apollo roadmap notes for ${fileId}.`;
    },
    async downloadFileBytes(fileId: string) {
      const bytes = new TextEncoder().encode(`Apollo roadmap notes for ${fileId}.`);
      return { bytes, sizeBytes: bytes.byteLength };
    },
  };
}

function driveFiles(count: number): GoogleDriveFile[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `file-${index + 1}`,
    name: `apollo-${index + 1}.txt`,
    mimeType: 'text/plain',
    modifiedTime: `2026-07-0${index + 1}T00:00:00.000Z`,
    version: String(index + 1),
    size: '48',
    webViewLink: `https://drive.google.com/file/d/file-${index + 1}/view`,
  }));
}

function localEmbeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'local-drive-test',
    backend: 'local',
    modelId: 'local-drive-test-model',
    dimension: 2,
    configHash: 'local-drive-test-config',
    epochId: 'local-drive-test:2026-08-18',
    async embed(inputs) {
      return inputs.map(() => [1, 0]);
    },
  };
}

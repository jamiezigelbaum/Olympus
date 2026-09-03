import { afterEach, describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
  createGoogleDriveConnectorStoreSyncHandler,
  type GoogleDriveApiClient,
  type GoogleDriveConnectorStoreSyncHandler,
} from '../src/workers/google-connectors/index.ts';
import type {
  GoogleDriveFile,
  GoogleDriveListFilesRequest,
} from '../src/workers/google-connectors/drive.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const openStores: LocalConnectorStore[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
});

/**
 * The per-run content cap BOUNDS the Drive traversal — a page is never longer
 * than the remaining content budget, and the loop stops on a page boundary once
 * that budget is spent. That makes the cap the reconcile's real coverage bound,
 * not just its download bound, so a reconcile carrying the incremental lane's
 * small cap covers a fraction of its window while reporting a snapshot pass.
 */
describe('Google Drive reconcile coverage against the content budget', () => {
  test('a reconcile traverses its whole window instead of stopping at the incremental cap', async () => {
    const client = fakeDriveClient(driveFiles(120));
    const lane = driveLane({ client });

    const outcome = await lane.handler.reconcile();

    // 120 > the 50 the incremental lane carries: with the reconcile inheriting
    // that cap, the traversal stopped at 50 files and the receipt still
    // reported a snapshot pass over a corpus it had seen 42% of.
    expect(outcome.receipt.counts.items_seen).toBe(120);
    expect(outcome.receipt.counts.content_reads).toBe(120);
    // The property, rather than the number: the reconcile's content budget must
    // not be what ends its traversal short of its file budget.
    expect(outcome.receipt.counts.content_read_cap)
      .toBeGreaterThanOrEqual(outcome.receipt.counts.items_seen);
    expect(outcome.receipt.counts.internal_items_indexed).toBe(120);
    expect(lane.internalStore.status().counts.items).toBe(120);
    // Still the weakest honest authority: wider coverage is not deletion proof.
    expect(outcome.receipt.counts.absence_authoritative).toBe(0);
    expect(outcome.receipt.counts.internal_items_tombstoned).toBe(0);
    // The listing ran out inside both budgets, so the pass really was complete.
    expect(outcome.receipt.counts.traversal_complete).toBe(1);
  });

  test('a reconcile stopped by its content budget reports an incomplete traversal', async () => {
    // Past the reconcile's own cap the traversal stops on a page boundary with
    // a live page token, and the partial_window arm then clears the checkpoint
    // by policy. Deriving completion from that cleared checkpoint made every
    // truncated reconcile claim a full traversal, which poisons every coverage
    // audit built on these receipts.
    const client = fakeDriveClient(driveFiles(600));
    const lane = driveLane({ client });

    const outcome = await lane.handler.reconcile();

    expect(outcome.receipt.counts.items_seen).toBe(500);
    expect(outcome.receipt.counts.content_reads)
      .toBe(outcome.receipt.counts.content_read_cap);
    expect(outcome.receipt.counts.traversal_complete).toBe(0);
    // The checkpoint policy is untouched: a reconcile still hands back nothing.
    expect(outcome.checkpoint).toBeNull();
  });

  test('the incremental pull keeps its own content cap', async () => {
    const client = fakeDriveClient(driveFiles(120));
    const lane = driveLane({ client });

    const outcome = await lane.handler.pull({ max_items: 200 });

    // The reconcile's wider budget is the reconcile's alone. The head lane runs
    // every half hour against the same day counter, so widening it there would
    // spend the day's provider quota rather than extend a once-daily pass.
    expect(outcome.receipt.counts.content_read_cap).toBe(50);
    expect(outcome.receipt.counts.items_seen).toBe(50);
    expect(outcome.receipt.counts.traversal_complete).toBe(0);
  });
});

function driveLane(input: { client: CountingDriveApiClient }): {
  handler: GoogleDriveConnectorStoreSyncHandler;
  internalStore: LocalConnectorStore;
  secureStore: LocalConnectorStore;
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
    secureStore,
    handler: createGoogleDriveConnectorStoreSyncHandler({
      internalStore,
      secureStore,
      account: 'personal',
      apiClient: input.client,
      // The production shape: the host configures neither bound, so the head
      // lane runs on the connector defaults and the reconcile on its own.
      internalEmbeddingProvider: provider,
      secureEmbeddingProvider: provider,
      env: {},
    }),
  };
}

type CountingDriveApiClient = GoogleDriveApiClient & {
  files: GoogleDriveFile[];
  listCalls: number;
  contentCalls: string[];
};

/** Page-token pagination over an in-memory corpus, filtered by modifiedTime. */
function fakeDriveClient(files: GoogleDriveFile[]): CountingDriveApiClient {
  return {
    files,
    listCalls: 0,
    contentCalls: [],
    async listFiles(request: GoogleDriveListFilesRequest) {
      this.listCalls += 1;
      const after = /modifiedTime > '([^']+)'/.exec(request.query ?? '')?.[1];
      const eligible = this.files.filter((file) =>
        !after || (file.modifiedTime ?? '').localeCompare(after) > 0);
      const offset = request.pageToken ? Number(request.pageToken) : 0;
      const slice = eligible.slice(offset, offset + request.pageSize);
      const nextOffset = offset + slice.length;
      return {
        files: slice,
        ...(nextOffset < eligible.length ? { nextPageToken: String(nextOffset) } : {}),
      };
    },
    async exportGoogleDocText(fileId: string) {
      this.contentCalls.push(fileId);
      return `Apollo roadmap notes for ${fileId}.`;
    },
    async downloadTextFile(fileId: string) {
      this.contentCalls.push(fileId);
      return `Apollo roadmap notes for ${fileId}.`;
    },
    async downloadFileBytes(fileId: string) {
      this.contentCalls.push(fileId);
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
    // Distinct and monotonic: the connector promotes the high-water
    // modifiedTime, so a repeated value would make the next pass's window
    // depend on page order rather than on what was read.
    modifiedTime: new Date(Date.UTC(2026, 6, 1) + (index + 1) * 60_000).toISOString(),
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
    epochId: 'local-drive-test:2026-07-27',
    async embed(inputs) {
      return inputs.map(() => [1, 0]);
    },
  };
}

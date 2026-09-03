import { describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type {
  SourceEmbeddingInput,
  SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';
import {
  LocalXBookmarksApiUsageStore,
  XBookmarksLiveSyncError,
  createXBookmarksConnectorStoreSyncHandler,
  defaultXBookmarksLiveSyncConfig,
  type XBookmarkPost,
  type XBookmarksLiveSyncConfig,
} from '../src/workers/x-bookmarks/index.ts';

const ACCOUNT = 'personal';
const ATTEMPTED_AT = new Date('2026-08-18T10:00:00.000Z');

describe('X reconciliation truncation-ladder exhaustion', () => {
  test('refuses with a retry hint so the degraded reason survives the receipt', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const requested: number[] = [];
    const config = testConfig();
    try {
      const handler = createXBookmarksConnectorStoreSyncHandler({
        store,
        usageStore: usage,
        embeddingProvider: fakeEmbeddingProvider(),
        sourceClient: {
          // Every rung returns a terminal page within two of the requested
          // size: the provider truncation signature the ladder exists to catch.
          async fetchBookmarks(request = {}) {
            const size = request.maxResults ?? 80;
            requested.push(size);
            const posts = Array.from({ length: size - 1 }, (_, index) =>
              bookmark(`truncated-${size}-${index}`));
            return { posts: request.headOnly ? posts.map((post) => ({ id: post.id })) : posts };
          },
          async fetchBookmarkFolders() { return { folders: [] }; },
          async fetchBookmarksInFolder() { throw new Error('no folders'); },
        },
        account: ACCOUNT,
        userId: 'provider-user-exhaustion',
        config,
        now: () => ATTEMPTED_AT,
      });
      let caught: unknown;
      try {
        await handler.reconcile({ attempted_at: ATTEMPTED_AT.toISOString() });
      } catch (error) {
        caught = error;
      }
      expect(requested).toEqual([80, 50, 20]);
      expect(caught).toBeInstanceOf(XBookmarksLiveSyncError);
      const error = caught as XBookmarksLiveSyncError;
      expect(error.errorKind).toBe('reconcile_incomplete');
      expect(error.degradedReason).toBe('x_reconcile_truncation_suspected');
      expect(error.warnings).toContain('x_reconcile_truncation_suspected_no_authority');
      expect(error.retryAt).toBe(
        new Date(ATTEMPTED_AT.getTime() + config.degradedIntervalMs).toISOString(),
      );
    } finally {
      usage.close();
      store.close();
    }
  }, 20_000);
});

function bookmark(id: string, text = `marker-${id}`): XBookmarkPost {
  return {
    id,
    text,
    createdAt: '2026-08-18T09:00:00.000Z',
    url: `https://x.com/i/web/status/${id}`,
  };
}

function testConfig(
  overrides: Partial<XBookmarksLiveSyncConfig> = {},
): XBookmarksLiveSyncConfig {
  return {
    ...defaultXBookmarksLiveSyncConfig({}),
    dailyApiRequestBudget: 10_000,
    dailyResourceReadBudget: 100_000,
    dailyEstimatedSpendMicrousd: 100_000_000,
    headApiRequestReserve: 0,
    headResourceReadReserve: 0,
    headEstimatedSpendReserveMicrousd: 0,
    rateLimitLowWatermark: 0,
    ...overrides,
  };
}

function xStore(): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'internal.x.bookmarks',
    family: 'x',
    trustDomain: 'internal',
  });
}

function fakeEmbeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'test',
    modelId: 'x-truncation-test',
    dimension: 3,
    configHash: 'x-truncation-test-config',
    epochId: 'x-truncation-test-epoch',
    backend: 'cloud',
    async embed(inputs: SourceEmbeddingInput[]) {
      return inputs.map(() => [1, 0, 0]);
    },
  };
}

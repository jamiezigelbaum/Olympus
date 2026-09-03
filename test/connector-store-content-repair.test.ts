import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import {
  buildSourceSensitivity,
  type SourceTrustDomain,
} from '../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
} from '../src/workers/connector-store/index.ts';
import {
  repairConnectorStoreContent,
  type ConnectorStoreContentRepairReceipt,
} from '../src/workers/connector-store/content-repair.ts';
import type {
  SourceEmbeddingInput,
  SourceEmbeddingProvider,
  SourceEmbeddingTaskType,
} from '../src/workers/source-index/embeddings.ts';

const ACCOUNT = 'personal';
const CORPUS_ID = 'internal.fake.mail';

class BudgetRefusal extends Error {}

interface ProviderReply {
  text?: string;
  error?: Error;
  trustDomain?: SourceTrustDomain;
}

interface Fixture {
  dir: string;
  store: LocalConnectorStore;
  statePath: string;
  connector: SourceConnector;
  fetched: string[];
  providerRequests: () => number;
  close(): void;
}

function item(
  id: string,
  content: RawItem['content'] = { kind: 'metadata_only' },
): RawItem {
  return {
    identity: {
      family: 'email',
      provider: 'fake_mail',
      accountScope: ACCOUNT,
      providerItemId: id,
      providerThreadId: `thread-${id}`,
      localItemId: `${ACCOUNT}:${id}`,
      sourceVersion: 'v1',
    },
    mimeType: 'message/rfc822',
    content,
    metadata: Object.freeze({
      title: `Fixture ${id}`,
      authoredAt: '2026-07-29T08:00:00.000Z',
    }),
    fetchedAt: '2026-07-29T09:00:00.000Z',
  };
}

function connectorFor(
  ids: readonly string[],
  replies: Readonly<Record<string, ProviderReply>>,
  fetched: string[],
  requestCounter: { value: number },
): SourceConnector {
  return {
    id: 'fake_mail_live',
    family: 'email',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: ids.map((id) => item(id)), done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const id = localItemId.slice(localItemId.indexOf(':') + 1);
      fetched.push(id);
      const reply = replies[id] ?? {};
      if (reply.error instanceof BudgetRefusal) throw reply.error;
      requestCounter.value += 1;
      if (reply.error) throw reply.error;
      return item(
        id,
        reply.text === undefined
          ? { kind: 'metadata_only' }
          : { kind: 'text', text: reply.text },
      );
    },
    classify(raw): ReturnType<typeof buildSourceSensitivity> {
      const reply = replies[raw.identity.providerItemId];
      const trustDomain = reply?.trustDomain ?? 'internal';
      return buildSourceSensitivity({
        trustTier: trustDomain === 'secure_local' ? 'S4' : 'S3',
        trustDomain,
        cloudEmbeddingEligible: trustDomain === 'internal',
      });
    },
  };
}

async function fixture(
  ids: readonly string[],
  replies: Readonly<Record<string, ProviderReply>>,
  trustDomain: SourceTrustDomain = 'internal',
): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-content-repair-'));
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'store.sqlite'),
    corpusId: trustDomain === 'internal' ? CORPUS_ID : 'secure_local.fake.mail',
    family: 'email',
    trustDomain,
  });
  const fetched: string[] = [];
  const requestCounter = { value: 0 };
  const connector = connectorFor(ids, replies, fetched, requestCounter);
  await store.syncFromConnector({
    ...connector,
    classify: () => buildSourceSensitivity({
      trustTier: trustDomain === 'secure_local' ? 'S4' : 'S3',
      trustDomain,
      cloudEmbeddingEligible: trustDomain === 'internal',
    }),
  }, { fetchContent: false });
  return {
    dir,
    store,
    statePath: join(dir, 'repair-state.sqlite'),
    connector,
    fetched,
    providerRequests: () => requestCounter.value,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function embeddingProvider(backend: 'cloud' | 'local' = 'cloud'): SourceEmbeddingProvider {
  return {
    provider: 'fixture-embedding',
    modelId: 'fixture-v1',
    dimension: 3,
    configHash: 'fixture-config',
    epochId: 'fixture-epoch',
    backend,
    async embed(
      inputs: SourceEmbeddingInput[],
      _options: { taskType: SourceEmbeddingTaskType },
    ): Promise<number[][]> {
      return inputs.map((input, index) => [
        input.text.length + 1,
        index + 1,
        1,
      ]);
    },
  };
}

async function repair(
  value: Fixture,
  options: {
    limit?: number;
    dryRun?: boolean;
    embeddingBackend?: 'cloud' | 'local';
  } = {},
): Promise<ConnectorStoreContentRepairReceipt> {
  return repairConnectorStoreContent({
    store: value.store,
    connector: value.connector,
    statePath: value.statePath,
    limit: options.limit ?? 25,
    dryRun: options.dryRun ?? false,
    embeddingProvider: embeddingProvider(options.embeddingBackend),
    providerRequestCount: value.providerRequests,
    isBudgetRefusal: (error) => error instanceof BudgetRefusal,
  });
}

describe('generic connector-store content repair', () => {
  test('provider text takes the ordinary ingest path through chunks, FTS, and embeddings', async () => {
    const value = await fixture(['alpha'], {
      alpha: { text: 'harbour logistics repair proof' },
    });
    try {
      expect(value.store.status().counts).toMatchObject({ chunks: 0, embeddedChunks: 0 });

      const receipt = await repair(value);

      expect(receipt.counts).toEqual({
        selected: 1,
        repaired: 1,
        still_bodyless: 0,
        unavailable: 0,
        provider_requests_spent: 1,
        remaining: 0,
      });
      expect(receipt.stop_reason).toBe('completed');
      expect(value.store.status().counts).toMatchObject({ chunks: 1, embeddedChunks: 1 });
      expect(value.store.searchItems('harbour', 10)[0]?.sourceItem.providerItemId).toBe('alpha');
    } finally {
      value.close();
    }
  });

  test('an honest provider body-less result settles the item and a repeat skips it', async () => {
    const value = await fixture(['invite'], { invite: {} });
    try {
      const first = await repair(value);
      const second = await repair(value);

      expect(first.counts).toMatchObject({
        selected: 1,
        repaired: 0,
        still_bodyless: 1,
        unavailable: 0,
        provider_requests_spent: 1,
      });
      expect(second.counts).toEqual({
        selected: 0,
        repaired: 0,
        still_bodyless: 0,
        unavailable: 0,
        provider_requests_spent: 0,
        remaining: 0,
      });
      expect(value.fetched).toEqual(['invite']);
    } finally {
      value.close();
    }
  });

  test('a provider error becomes unavailable without poisoning later items', async () => {
    const value = await fixture(['gone', 'healthy'], {
      gone: { error: new Error('provider item gone') },
      healthy: { text: 'later provider item still repairs' },
    });
    try {
      const receipt = await repair(value);

      expect(receipt.counts).toMatchObject({
        selected: 2,
        repaired: 1,
        still_bodyless: 0,
        unavailable: 1,
        provider_requests_spent: 2,
        remaining: 0,
      });
      expect(receipt.stop_reason).toBe('completed');
      expect(value.store.searchItems('later', 10)[0]?.sourceItem.providerItemId).toBe('healthy');
      expect((await repair(value)).counts.selected).toBe(0);
    } finally {
      value.close();
    }
  });

  test('a daily-budget refusal stops cleanly and leaves the unattempted selection resumable', async () => {
    const value = await fixture(['first', 'budget', 'later'], {
      first: { text: 'first repaired item' },
      budget: { error: new BudgetRefusal('daily budget exhausted') },
      later: { text: 'must not be fetched yet' },
    });
    try {
      const receipt = await repair(value);

      expect(receipt.stop_reason).toBe('budget_refused');
      expect(receipt.counts).toEqual({
        selected: 3,
        repaired: 1,
        still_bodyless: 0,
        unavailable: 0,
        provider_requests_spent: 1,
        remaining: 2,
      });
      expect(value.fetched).toEqual(['first', 'budget']);
    } finally {
      value.close();
    }
  });

  test('dry run is the default and fetches, embeds, and settles nothing', async () => {
    const value = await fixture(['dry'], { dry: { text: 'not fetched' } });
    try {
      const receipt = await repairConnectorStoreContent({
        store: value.store,
        connector: value.connector,
        statePath: value.statePath,
        limit: 25,
        embeddingProvider: embeddingProvider(),
        providerRequestCount: value.providerRequests,
        isBudgetRefusal: (error) => error instanceof BudgetRefusal,
      });

      expect(receipt.dry_run).toBe(true);
      expect(receipt.counts).toEqual({
        selected: 1,
        repaired: 0,
        still_bodyless: 0,
        unavailable: 0,
        provider_requests_spent: 0,
        remaining: 1,
      });
      expect(value.fetched).toEqual([]);
      expect(value.store.status().counts).toMatchObject({ chunks: 0, embeddedChunks: 0 });

      const applied = await repair(value);
      expect(applied.counts.repaired).toBe(1);
    } finally {
      value.close();
    }
  });

  test('refreshed classification routes content only into the matching trust-domain store', async () => {
    const replies = {
      private: {
        text: 'private reclassified body',
        trustDomain: 'secure_local' as const,
      },
    };
    const internal = await fixture(['private'], replies, 'internal');
    const secure = await fixture(['private'], replies, 'secure_local');
    try {
      const wrongDomain = await repair(internal);
      const rightDomain = await repair(secure, { embeddingBackend: 'local' });

      expect(wrongDomain.counts).toMatchObject({ repaired: 0, unavailable: 1 });
      expect(internal.store.status().counts).toMatchObject({ chunks: 0, embeddedChunks: 0 });
      expect(internal.store.searchItems('reclassified', 10)).toEqual([]);

      expect(rightDomain.counts).toMatchObject({ repaired: 1, unavailable: 0 });
      expect(secure.store.status().counts).toMatchObject({ chunks: 1, embeddedChunks: 1 });
      expect(secure.store.searchItems('reclassified', 10)[0]?.sourceItem.providerItemId)
        .toBe('private');
    } finally {
      internal.close();
      secure.close();
    }
  });

  test('the caller limit bounds deterministic repair and later runs resume unsettled items', async () => {
    const value = await fixture(['first', 'second', 'third'], {
      first: { text: 'one' },
      second: { text: 'two' },
      third: { text: 'three' },
    });
    try {
      expect((await repair(value, { limit: 1 })).counts.selected).toBe(1);
      expect((await repair(value, { limit: 1 })).counts.selected).toBe(1);
      expect((await repair(value, { limit: 1 })).counts.selected).toBe(1);
      expect((await repair(value, { limit: 1 })).counts.selected).toBe(0);
      expect(value.fetched).toEqual(['first', 'second', 'third']);
    } finally {
      value.close();
    }
  });

  test('durable terminal state contains only item hashes and categorical outcomes', async () => {
    const rawProviderId = 'source-id-must-not-persist';
    const value = await fixture([rawProviderId], { [rawProviderId]: {} });
    try {
      await repair(value);

      const db = new Database(value.statePath, { readonly: true, strict: true });
      try {
        expect(db.query(
          'SELECT item_key_sha256, terminal_state FROM content_repair_settlements',
        ).all()).toEqual([
          {
            item_key_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            terminal_state: 'still_bodyless',
          },
        ]);
      } finally {
        db.close();
      }
      expect(readFileSync(value.statePath).includes(Buffer.from(rawProviderId))).toBe(false);
    } finally {
      value.close();
    }
  });
});

/**
 * 2026-09-24 beta.4 install: the first `source_answer` failed with "Private
 * email lane returned HTTP 500" wrapping "Gemini source embedding endpoint
 * returned HTTP 503" (advice: check the API key), and an identical retry three
 * seconds later succeeded. A transient provider status is now retried inside
 * the provider, and a query-time outage that outlives the retries retires the
 * vector lane to keyword (reported as a skipped semantic lane) instead of
 * failing the answer.
 */
import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  GeminiSourceEmbeddingProvider,
  OpenAICompatibleSourceEmbeddingProvider,
  TransientSourceEmbeddingError,
  type SourceEmbeddingInput,
  type SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';

function scriptedFetch(statuses: number[]): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    const status = statuses[Math.min(calls, statuses.length - 1)]!;
    calls += 1;
    if (status !== 200) return new Response('{"error":{"message":"unavailable"}}', { status });
    return new Response(JSON.stringify({ embeddings: [{ values: [0.1, 0.2, 0.3] }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function gemini(fetchImpl: typeof fetch): GeminiSourceEmbeddingProvider {
  return new GeminiSourceEmbeddingProvider({ apiKey: 'test-key', fetchImpl, timeoutMs: 10_000 });
}

describe('transient embedding outages', () => {
  test('a single 503 on a query embedding is retried and succeeds', async () => {
    const { fetchImpl, calls } = scriptedFetch([503, 200]);
    const vectors = await gemini(fetchImpl).embed([{ text: 'question' }], { taskType: 'RETRIEVAL_QUERY' });
    expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
    expect(calls()).toBe(2);
  });

  test('a persistent outage says it is transient and does not blame the key', async () => {
    const { fetchImpl, calls } = scriptedFetch([503]);
    const error = await gemini(fetchImpl).embed([{ text: 'question' }], { taskType: 'RETRIEVAL_QUERY' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransientSourceEmbeddingError);
    expect((error as TransientSourceEmbeddingError).message)
      .toBe('Gemini source embedding endpoint is temporarily unavailable (HTTP 503 after 3 attempts).');
    expect((error as TransientSourceEmbeddingError).suggestion).not.toContain('API key');
    expect(calls()).toBe(3);
  });

  test('a configuration refusal is not retried and keeps its operator advice', async () => {
    const { fetchImpl, calls } = scriptedFetch([403]);
    const error = await gemini(fetchImpl).embed([{ text: 'question' }], { taskType: 'RETRIEVAL_QUERY' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OperationError);
    expect(error).not.toBeInstanceOf(TransientSourceEmbeddingError);
    expect((error as OperationError).message).toBe('Gemini source embedding endpoint returned HTTP 403.');
    expect(calls()).toBe(1);
  });

  test('the OpenAI-compatible provider retries a transient status too', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return new Response('busy', { status: 429 });
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleSourceEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:9/v1', model: 'local-embed', fetchImpl, timeoutMs: 10_000,
    });
    expect(await provider.embed([{ text: 'question' }], { taskType: 'RETRIEVAL_QUERY' })).toEqual([[1, 0]]);
    expect(calls).toBe(2);
  });
});

const ACCOUNT = 'personal';

function item(): RawItem {
  return {
    identity: {
      family: 'file', provider: 'fixture', accountScope: ACCOUNT,
      providerItemId: 'one', localItemId: `${ACCOUNT}:one`, sourceVersion: 'v1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: 'retrospective roadmap decision' },
    metadata: Object.freeze({ name: 'one.txt' }),
    fetchedAt: '2026-09-01T00:00:00.000Z',
  };
}

function connector(): SourceConnector {
  return {
    id: 'fixture', family: 'file', async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* () { yield { items: [item()], done: true }; })();
    },
    async fetchItem() { return item(); },
    classificationSignals() { return {}; },
  };
}

function provider(queryFailure?: Error): SourceEmbeddingProvider {
  return {
    provider: 'fixture', modelId: 'transient-model', dimension: 3, configHash: 'one',
    epochId: 'epoch:one', backend: 'local',
    async embed(inputs: SourceEmbeddingInput[], options?: { taskType?: string }) {
      if (options?.taskType === 'RETRIEVAL_QUERY' && queryFailure) throw queryFailure;
      return inputs.map(() => [1, 0, 0]);
    },
  };
}

async function store(): Promise<LocalConnectorStore> {
  const result = new LocalConnectorStore({
    dbPath: ':memory:', corpusId: 'secure_local.fixture.files', family: 'file', trustDomain: 'secure_local',
  });
  await result.syncFromConnector(connector(), { fetchContent: true });
  await result.embedChunks({ provider: provider() });
  return result;
}

describe('query-time vector lane under a provider outage', () => {
  test('retires to keyword with a named reason instead of failing the answer', async () => {
    const fixture = await store();
    const lane = await fixture.vectorSearchLane(
      'retrospective',
      provider(new TransientSourceEmbeddingError('Gemini', 503, 3)),
      5,
    );
    expect(lane).toEqual({ rows: [], skippedReason: 'embedding_query_unavailable' });
  });

  test('a configuration error still fails loudly', async () => {
    const fixture = await store();
    await expect(fixture.vectorSearchLane(
      'retrospective',
      provider(new OperationError('source_index_error', 'Gemini source embedding endpoint returned HTTP 403.')),
      5,
    )).rejects.toThrow('returned HTTP 403');
  });
});

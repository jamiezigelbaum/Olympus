/**
 * 2026-09-24 beta.4 install: the first `source_answer` failed with "Private
 * email lane returned HTTP 500" wrapping "Gemini source embedding endpoint
 * returned HTTP 503" (advice: check the API key), and an identical retry three
 * seconds later succeeded. Transient provider statuses and network failures
 * are now retried inside the provider, and a query-time outage that outlives
 * the retries (or the budget) retires the vector lane to keyword, reported as
 * a skipped semantic lane naming the cause, instead of failing the answer.
 */
import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { routeSourceIndexSearch, type SourceIndexRouterAdapterMap } from '../src/core/source-index/router.ts';
import {
  LocalConnectorStore,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import {
  GeminiSourceEmbeddingProvider,
  OpenAICompatibleSourceEmbeddingProvider,
  TransientSourceEmbeddingError,
  retryAfterMs,
  type SourceEmbeddingInput,
  type SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';

type Step = number | Error | { status: number; retryAfter: string };

/** A fetch that plays `steps` in order (the last repeats) and records body cancellation. */
function scriptedFetch(steps: Step[]) {
  let calls = 0;
  let cancelledBodies = 0;
  const fetchImpl = (async () => {
    const step = steps[Math.min(calls, steps.length - 1)]!;
    calls += 1;
    if (step instanceof Error) throw step;
    const status = typeof step === 'number' ? step : step.status;
    if (status === 200) {
      return new Response(JSON.stringify({ embeddings: [{ values: [0.1, 0.2, 0.3] }] }), { status: 200 });
    }
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"error":{"message":"unavailable"}}')); },
      cancel() { cancelledBodies += 1; },
    });
    const headers = typeof step === 'number' ? undefined : { 'retry-after': step.retryAfter };
    return new Response(body, { status, ...(headers ? { headers } : {}) });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls, cancelledBodies: () => cancelledBodies };
}

function gemini(fetchImpl: typeof fetch, timeoutMs = 10_000): GeminiSourceEmbeddingProvider {
  return new GeminiSourceEmbeddingProvider({ apiKey: 'test-key', fetchImpl, timeoutMs });
}

async function embedError(provider: SourceEmbeddingProvider): Promise<unknown> {
  return provider.embed([{ text: 'question' }], { taskType: 'RETRIEVAL_QUERY' }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

describe('transient embedding outages', () => {
  test('a single 503 on a query embedding is retried and succeeds', async () => {
    const { fetchImpl, calls } = scriptedFetch([503, 200]);
    const vectors = await gemini(fetchImpl).embed([{ text: 'question' }], { taskType: 'RETRIEVAL_QUERY' });
    expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
    expect(calls()).toBe(2);
  });

  test('502 and 504 are retried like 503', async () => {
    for (const status of [502, 504]) {
      const { fetchImpl, calls } = scriptedFetch([status, 200]);
      expect(await gemini(fetchImpl).embed([{ text: 'q' }], { taskType: 'RETRIEVAL_QUERY' })).toEqual([[0.1, 0.2, 0.3]]);
      expect(calls()).toBe(2);
    }
  });

  test('a persistent outage says it is transient, keeps its status, and cancels every body', async () => {
    const { fetchImpl, calls, cancelledBodies } = scriptedFetch([503]);
    const error = await embedError(gemini(fetchImpl));
    expect(error).toBeInstanceOf(TransientSourceEmbeddingError);
    expect((error as TransientSourceEmbeddingError).reason).toBe(503);
    expect((error as TransientSourceEmbeddingError).message)
      .toBe('Gemini source embedding endpoint is temporarily unavailable (HTTP 503 after 3 attempts).');
    expect((error as TransientSourceEmbeddingError).suggestion).not.toContain('API key');
    expect(calls()).toBe(3);
    expect(cancelledBodies()).toBe(3);
  });

  test('a persistent 429 names rate limit or quota and does not promise a quick retry', async () => {
    const { fetchImpl } = scriptedFetch([429]);
    const error = await embedError(gemini(fetchImpl)) as TransientSourceEmbeddingError;
    expect(error.reason).toBe(429);
    expect(error.message).toContain('rate limit or quota');
    expect(error.suggestion).toContain('quota');
    expect(error.suggestion).not.toContain('few seconds');
  });

  test('a Retry-After that fits the budget replaces the backoff', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 429, retryAfter: '0' }, 200]);
    expect(await gemini(fetchImpl).embed([{ text: 'q' }], { taskType: 'RETRIEVAL_QUERY' })).toEqual([[0.1, 0.2, 0.3]]);
    expect(calls()).toBe(2);
  });

  test('a Retry-After past the budget stops at once instead of retrying early', async () => {
    const { fetchImpl, calls, cancelledBodies } = scriptedFetch([{ status: 429, retryAfter: '120' }, 200]);
    const startedAt = Date.now();
    const error = await embedError(gemini(fetchImpl, 5_000)) as TransientSourceEmbeddingError;
    expect(error).toBeInstanceOf(TransientSourceEmbeddingError);
    expect(error.reason).toBe(429);
    expect(calls()).toBe(1);
    expect(cancelledBodies()).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test('Retry-After reads delta-seconds and HTTP dates', () => {
    const now = Date.parse('2026-09-24T10:00:00Z');
    expect(retryAfterMs(new Response(null, { headers: { 'retry-after': '3' } }), now)).toBe(3_000);
    expect(retryAfterMs(new Response(null, { headers: { 'retry-after': 'Thu, 24 Sep 2026 10:00:07 GMT' } }), now)).toBe(7_000);
    expect(retryAfterMs(new Response(null, { headers: { 'retry-after': 'soon' } }), now)).toBeUndefined();
    expect(retryAfterMs(new Response(null), now)).toBeUndefined();
  });

  test('a network failure (connection reset, DNS) is retried, then reported as transient', async () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const recovered = scriptedFetch([reset, 200]);
    expect(await gemini(recovered.fetchImpl).embed([{ text: 'q' }], { taskType: 'RETRIEVAL_QUERY' })).toEqual([[0.1, 0.2, 0.3]]);
    expect(recovered.calls()).toBe(2);

    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com'), { code: 'ENOTFOUND' });
    const down = scriptedFetch([dns]);
    const error = await embedError(gemini(down.fetchImpl)) as TransientSourceEmbeddingError;
    expect(error).toBeInstanceOf(TransientSourceEmbeddingError);
    expect(error.reason).toBe('network');
    expect(down.calls()).toBe(3);
  });

  test('a backoff that would outlive the budget is not waited out', async () => {
    const { fetchImpl, calls } = scriptedFetch([503]);
    const startedAt = Date.now();
    // 600ms budget: the first backoff (250ms) fits, the second (1s) does not
    // fit what remains, so the provider stops with the 503 instead of sleeping
    // into the abort.
    const error = await embedError(gemini(fetchImpl, 600)) as TransientSourceEmbeddingError;
    expect(error).toBeInstanceOf(TransientSourceEmbeddingError);
    expect(calls()).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(1_000);

  });

  test('the budget aborting a retried request is a transient timeout', async () => {
    let abortedCalls = 0;
    const hanging = (async (_url: unknown, init?: RequestInit) => {
      abortedCalls += 1;
      if (abortedCalls === 1) return new Response('busy', { status: 503, headers: { 'retry-after': '0' } });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    const timedOut = await embedError(gemini(hanging, 300)) as TransientSourceEmbeddingError;
    expect(timedOut).toBeInstanceOf(TransientSourceEmbeddingError);
    expect(timedOut.reason).toBe('timeout');
    expect(timedOut.message).toContain('300ms budget');
  });

  test('a configuration refusal is not retried and keeps its operator advice', async () => {
    const { fetchImpl, calls } = scriptedFetch([403]);
    const error = await embedError(gemini(fetchImpl));
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

  test('the OpenAI-compatible provider running out of retries reports the status', async () => {
    const { fetchImpl, calls, cancelledBodies } = scriptedFetch([503]);
    const provider = new OpenAICompatibleSourceEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:9/v1', model: 'local-embed', fetchImpl, timeoutMs: 10_000,
    });
    const error = await embedError(provider) as TransientSourceEmbeddingError;
    expect(error).toBeInstanceOf(TransientSourceEmbeddingError);
    expect(error.reason).toBe(503);
    expect(error.message).toBe('local-openai-compatible source embedding endpoint is temporarily unavailable (HTTP 503 after 3 attempts).');
    expect(calls()).toBe(3);
    expect(cancelledBodies()).toBe(3);
  });
});

const ACCOUNT = 'personal';
const CORPUS = 'internal.fixture.files';

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

async function store(corpusId = 'secure_local.fixture.files'): Promise<LocalConnectorStore> {
  const trustDomain = corpusId.startsWith('internal.') ? 'internal' : 'secure_local';
  const result = new LocalConnectorStore({ dbPath: ':memory:', corpusId, family: 'file', trustDomain });
  await result.syncFromConnector(connector(), { fetchContent: true });
  await result.embedChunks({ provider: provider() });
  return result;
}

describe('query-time vector lane under a provider outage', () => {
  test('retires to keyword with the cause in the reason instead of failing the answer', async () => {
    const fixture = await store();
    for (const reason of [503, 429, 'network', 'timeout'] as const) {
      const lane = await fixture.vectorSearchLane(
        'retrospective',
        provider(new TransientSourceEmbeddingError('Gemini', reason, 3, 30_000)),
        5,
      );
      expect(lane).toEqual({ rows: [], skippedReason: `embedding_query_unavailable:${reason}` });
    }
  });

  test('a configuration error still fails loudly', async () => {
    const fixture = await store();
    await expect(fixture.vectorSearchLane(
      'retrospective',
      provider(new OperationError('source_index_error', 'Gemini source embedding endpoint returned HTTP 403.')),
      5,
    )).rejects.toThrow('returned HTTP 403');
  });

  test('the router answers from keyword and reports the skipped semantic lane', async () => {
    const fixture = await store(CORPUS);
    const result = await routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([defineConnectorCorpus({
        corpusId: CORPUS, family: 'file', trustDomain: 'internal', activationMode: 'hybrid_primary',
      })]),
      adapters: {
        [CORPUS]: createConnectorStoreCorpusAdapter({
          store: fixture,
          embeddingProvider: provider(new TransientSourceEmbeddingError('Gemini', 503, 3, 30_000)),
        }),
      } as SourceIndexRouterAdapterMap,
      request: { query: 'retrospective', maxResults: 3, context: { allowedTrustDomains: ['internal'] } },
      laneTimeoutMs: 0,
    });
    expect(result.hits.map((hit) => hit.sourceItem.localItemId)).toEqual([`${ACCOUNT}:one`]);
    expect(result.degradations).toContainEqual({
      laneName: `${CORPUS}:semantic`,
      laneType: 'semantic',
      reason: 'semantic_lane_skipped',
      detail: 'embedding_query_unavailable:503',
      occurrences: 1,
    });
    fixture.close();
  });
});

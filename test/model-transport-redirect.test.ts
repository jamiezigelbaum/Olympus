// Every transport that carries source content or a model credential refuses a
// redirect: the 30x answer is never followed, the redirect target never sees a
// request, and the failure carries none of the request body, the API key, or
// the Location target. Real loopback servers and the platform fetch, so the
// proof covers `redirect: 'error'` itself rather than a test double's reading
// of it.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createAnthropicAnalystModel } from '../src/core/analyst-anthropic.ts';
import { createBuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { createOpenAICompatibleAnalystModel } from '../src/core/analyst-openai.ts';
import { connectApiKeySource, connectGeminiApiKey, connectPublicApiKeySource } from '../src/core/connect.ts';
import { DirectHttpDelphiTransport } from '../src/core/delphi.ts';
import {
  ModelEndpointRedirectError,
  fetchModelEndpoint,
  isModelEndpointRedirectError,
} from '../src/core/model-transport.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { fetchVeniceCreditStatus } from '../src/core/provider-credit-status.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import { runCredentialHealthProbe } from '../src/workers/credential-health.ts';
import { OpenAICompatibleVlmClient } from '../src/workers/file-extraction/extractors/openai-compatible-client.ts';
import { VeniceVlmClient } from '../src/workers/file-extraction/extractors/venice-client.ts';
import {
  GeminiSourceEmbeddingProvider,
  OpenAICompatibleSourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import { createLlamaServerHandle } from '../src/workers/source-index/built-in-reasoning/server.ts';

const EVIDENCE = 'PRIVATE-EVIDENCE-MARKER-4c1d';
const API_KEY = 'model-credential-marker-9e2b';
const LEAK_QUERY = 'leaked_query_marker';

type Server = ReturnType<typeof Bun.serve>;
let target: Server;
let redirector: Server;
const targetHits: string[] = [];
const redirectorHits: string[] = [];
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'olympus-model-redirect-'));
  target = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      targetHits.push(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
      return Response.json({ data: [], choices: [{ message: { content: 'followed' } }] });
    },
  });
  redirector = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      redirectorHits.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response('moved', {
        status: 307,
        headers: { location: `http://127.0.0.1:${target.port}/collect?${LEAK_QUERY}=1` },
      });
    },
  });
});

afterAll(() => {
  target.stop(true);
  redirector.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  targetHits.length = 0;
  redirectorHits.length = 0;
});

function redirectBase(path = '/v1'): string {
  return `http://127.0.0.1:${redirector.port}${path}`;
}

/** Points a fixed-host transport (Venice, the credential probes) at the redirector. */
function rewriteTo(base: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    return fetch(`${base}${url.pathname}${url.search}`, init);
  }) as unknown as typeof fetch;
}

function expectNotFollowed(): void {
  expect(redirectorHits.length).toBeGreaterThan(0);
  expect(targetHits).toEqual([]);
}

function expectContentFree(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  const err = error as Error & { suggestion?: unknown; hint?: unknown; cause?: unknown };
  const surface = [
    String(err),
    err.message,
    String(err.suggestion ?? ''),
    String(err.hint ?? ''),
    String(err.cause ?? ''),
    JSON.stringify(err),
  ].join('\n');
  for (const marker of [EVIDENCE, API_KEY, LEAK_QUERY, '/collect', String(target.port)]) {
    expect(surface).not.toContain(marker);
  }
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the transport to refuse the redirect');
}

describe('fetchModelEndpoint', () => {
  test('the platform fetch refuses the redirect with a typed, content-free error', async () => {
    const error = await caught(() => fetchModelEndpoint(fetch, `${redirectBase()}/chat?probe=${LEAK_QUERY}`, {
      method: 'POST',
      body: EVIDENCE,
    }));
    expect(isModelEndpointRedirectError(error)).toBe(true);
    expectNotFollowed();
    expectContentFree(error);
  });

  test('a transport that ignores the redirect mode still never yields the 30x', async () => {
    let cancelled = false;
    const ignoring = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 302,
      headers: { location: `http://127.0.0.1:${target.port}/collect?${LEAK_QUERY}=1` },
    });
    const error = await caught(() => fetchModelEndpoint(ignoring, 'http://127.0.0.1:1/v1/x', { method: 'POST', body: EVIDENCE }));
    expect(error).toBeInstanceOf(ModelEndpointRedirectError);
    expect((error as ModelEndpointRedirectError).status).toBe(302);
    expect(cancelled).toBe(true);
    expectContentFree(error);
  });

  // Every 3xx, not only the five fetch would follow: a 300 (or any other
  // 3xx) carries a body the caller would otherwise read into its error.
  const ALL_3XX = Array.from({ length: 100 }, (_, index) => 300 + index);
  test.each(ALL_3XX)('an injected %i response is refused before any caller reads its body', async (status) => {
    let cancelled = false;
    const respond = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`${EVIDENCE} ${API_KEY}`)); },
      cancel() { cancelled = true; },
    }), { status, headers: { location: `http://127.0.0.1:${target.port}/collect?${LEAK_QUERY}=1` } });
    const error = await caught(() => fetchModelEndpoint(respond, 'http://127.0.0.1:1/v1/x', { method: 'POST', body: EVIDENCE }));
    expect(error).toBeInstanceOf(ModelEndpointRedirectError);
    expect((error as ModelEndpointRedirectError).status).toBe(status);
    expect(cancelled).toBe(true);
    expectContentFree(error);
  });

  test('an opaque-redirect response is refused', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, ok: false, redirected: false, body: null } as unknown as Response;
    const error = await caught(() => fetchModelEndpoint(async () => opaque, 'http://127.0.0.1:1/v1/x', { method: 'POST', body: EVIDENCE }));
    expect(error).toBeInstanceOf(ModelEndpointRedirectError);
    expectContentFree(error);
  });

  test('a 300 whose body echoes the request never reaches the analyst error', async () => {
    const echo = (async (_url: string, init?: RequestInit) => new Response(`${String(init?.body)} ${API_KEY}`, { status: 300 })) as unknown as typeof fetch;
    const model = createOpenAICompatibleAnalystModel({ apiKey: API_KEY, baseUrl: 'http://127.0.0.1:1/v1', serviceTier: false, fetchImpl: echo });
    const error = await caught(() => model.complete({ system: 'answer', prompt: EVIDENCE, localOnly: false }));
    expect(error).toBeInstanceOf(OperationError);
    expect((error as Error).message).toContain('redirect');
    expectContentFree(error);
  });

  test('a stalled body cancel does not hold the refusal', async () => {
    const stalled = { status: 302, ok: false, redirected: false, type: 'basic', body: { cancel: () => new Promise(() => {}) } } as unknown as Response;
    const outcome = await Promise.race([
      caught(() => fetchModelEndpoint(async () => stalled, 'http://127.0.0.1:1/v1/x', { method: 'POST' })),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 500)),
    ]);
    expect(outcome).toBeInstanceOf(ModelEndpointRedirectError);
  });

  test('a rejected body cancel still surfaces the typed refusal', async () => {
    const rejecting = { status: 307, ok: false, redirected: false, type: 'basic', body: { cancel: () => Promise.reject(new Error(`cancel failed ${API_KEY}`)) } } as unknown as Response;
    const error = await caught(() => fetchModelEndpoint(async () => rejecting, 'http://127.0.0.1:1/v1/x', { method: 'POST' }));
    expect(error).toBeInstanceOf(ModelEndpointRedirectError);
    expectContentFree(error);
  });

  test('every request goes out with redirect: error', async () => {
    let seen: RequestInit | undefined;
    await fetchModelEndpoint(async (_url, init) => {
      seen = init;
      return new Response('{}');
    }, 'http://127.0.0.1:1/v1/x', { method: 'GET', redirect: 'follow' });
    expect(seen?.redirect).toBe('error');
  });
});

describe('analyst chat transports', () => {
  test('OpenAI-compatible analyst (also the Venice analyst transport)', async () => {
    const model = createOpenAICompatibleAnalystModel({ apiKey: API_KEY, baseUrl: redirectBase(), serviceTier: false });
    const error = await caught(() => model.complete({ system: 'answer', prompt: EVIDENCE, localOnly: false }));
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('source_index_error');
    expect((error as Error).message).toContain('redirect');
    expectNotFollowed();
    expectContentFree(error);
  });

  test('Anthropic analyst', async () => {
    const model = createAnthropicAnalystModel({ apiKey: API_KEY, baseUrl: redirectBase('') });
    const error = await caught(() => model.complete({ system: 'answer', prompt: EVIDENCE, localOnly: false }));
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('source_index_error');
    expectNotFollowed();
    expectContentFree(error);
  });

  test('Delphi transport (local analyst profiles and the local sniffer lane) does not retry a redirect', async () => {
    const transport = new DirectHttpDelphiTransport(fetch, 5_000);
    const error = await caught(() => transport.requestJson(`${redirectBase()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: EVIDENCE }] }),
    }, 'fast'));
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('argus_unreachable');
    expect(redirectorHits).toHaveLength(1);
    expectNotFollowed();
    expectContentFree(error);
  });
});

describe('built-in private model transports', () => {
  test('built-in analyst chat (Private answers, the ChatGPT private panel, the built-in sniffer)', async () => {
    const model = createBuiltInAnalystModel({
      env: { OLYMPUS_BUILT_IN_REASONING_DIR: join(scratch, 'built-in-reasoning') },
      model: QWEN35_4B,
      install: async () => ({ modelPath: '/m.gguf', serverPath: '/llama-server', gpu: true }),
      createServer: () => ({
        async ensureRunning() {
          return { baseUrl: redirectBase(''), token: API_KEY };
        },
        touch() {},
        async stop() {},
        pid: 4242,
      }),
      waitForInstall: true,
    });
    const error = await caught(() => model.complete({ system: 'answer', prompt: EVIDENCE, localOnly: true }));
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('argus_unreachable');
    expect((error as Error).message).toContain('redirect');
    expect(redirectorHits).toHaveLength(1);
    expectNotFollowed();
    expectContentFree(error);
  });

  test('built-in model server identity check never follows a redirect with its token', async () => {
    // A stand-in llama-server that is healthy but redirects /v1/models.
    const script = join(scratch, 'redirecting-llama-server');
    writeFileSync(script, `#!/usr/bin/env bun
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const server = Bun.serve({ hostname: '127.0.0.1', port, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return new Response('{}');
  return new Response('moved', { status: 307, headers: { location: 'http://127.0.0.1:${target.port}/collect?${LEAK_QUERY}=1' } });
} });
process.on('SIGTERM', () => { server.stop(true); process.exit(0); });
`);
    chmodSync(script, 0o755);
    const handle = createLlamaServerHandle({
      serverPath: script,
      modelPath: '/m.gguf',
      contextTokens: 1,
      gpu: false,
      threads: 1,
      idleShutdownSeconds: 0,
      startupTimeoutMs: 15_000,
    });
    try {
      const error = await caught(() => handle.ensureRunning());
      expect((error as Error).message).toContain('taken by another process');
      expect(targetHits).toEqual([]);
      expectContentFree(error);
    } finally {
      await handle.stop();
    }
  }, 30_000);
});

describe('embedding transports', () => {
  test('local OpenAI-compatible embeddings refuse once, without retrying', async () => {
    const provider = new OpenAICompatibleSourceEmbeddingProvider({
      baseUrl: redirectBase(),
      model: 'local-embed',
      apiKeyProvider: () => API_KEY,
    });
    const error = await caught(() => provider.embed([{ text: EVIDENCE }], { taskType: 'RETRIEVAL_DOCUMENT' }));
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('source_index_error');
    expect(redirectorHits).toHaveLength(1);
    expectNotFollowed();
    expectContentFree(error);
  });

  test('Gemini embeddings', async () => {
    const provider = new GeminiSourceEmbeddingProvider({ apiKey: API_KEY, baseUrl: redirectBase() });
    const error = await caught(() => provider.embed([{ text: EVIDENCE }], { taskType: 'RETRIEVAL_DOCUMENT' }));
    expect(error).toBeInstanceOf(OperationError);
    expect(redirectorHits).toHaveLength(1);
    expectNotFollowed();
    expectContentFree(error);
  });
});

describe('vision extraction transports', () => {
  const image = { bytes: new TextEncoder().encode(EVIDENCE), mimeType: 'image/png', prompt: EVIDENCE, maxOutputChars: 100 };

  test('local VLM describe and probe', async () => {
    const client = new OpenAICompatibleVlmClient({ baseUrl: redirectBase(), model: 'local-vision', apiKey: API_KEY });
    const described = await caught(() => client.describe(image));
    expect(isModelEndpointRedirectError(described)).toBe(true);
    expectContentFree(described);
    const probed = await caught(() => client.probe({ timeoutMs: 5_000 }));
    expectContentFree(probed);
    expectNotFollowed();
  });

  test('Venice VLM describe', async () => {
    const client = new VeniceVlmClient({
      apiKey: API_KEY,
      model: 'kimi-k3',
      fetchImpl: rewriteTo(redirectBase('')),
      catalog: {
        cachePath: join(scratch, 'venice-catalog.json'),
        fetchImpl: async () => Response.json({ data: [{ id: 'kimi-k3', model_spec: { privacy: 'private' } }] }),
      },
    });
    const error = await caught(() => client.describe(image));
    expect(isModelEndpointRedirectError(error)).toBe(true);
    expectNotFollowed();
    expectContentFree(error);
  });
});

describe('credential-bearing catalog and account checks', () => {
  test('Venice billing status', async () => {
    const report = await fetchVeniceCreditStatus({ env: { VENICE_API_KEY: API_KEY }, baseUrl: redirectBase() });
    expect(report.status).toBe('unavailable');
    expectNotFollowed();
    expect(JSON.stringify(report)).not.toContain(API_KEY);
    expect(JSON.stringify(report)).not.toContain(LEAK_QUERY);
  });

  test('Gemini key validation on connect', async () => {
    const error = await caught(() => connectGeminiApiKey({
      apiKey: API_KEY,
      envPath: join(scratch, 'missing-worker.env'),
      geminiModelsUrl: `${redirectBase()}/models`,
    }));
    expectNotFollowed();
    expectContentFree(error);
  });

  test('Venice key validation on connect', async () => {
    const stored: string[] = [];
    const store = { set: async (key: string) => { stored.push(key); } } as unknown as SecretStore;
    const error = await caught(() => connectPublicApiKeySource({
      source: 'venice',
      apiKey: API_KEY,
      secretStore: store,
      registryPath: join(scratch, 'handles.json'),
      veniceModelsUrl: `${redirectBase()}/models`,
    }));
    expect(stored).toEqual([]);
    expectNotFollowed();
    expectContentFree(error);
  });

  test('Venice key validation on the repository connect path', async () => {
    const stored: string[] = [];
    const store = { set: async (key: string) => { stored.push(key); } } as unknown as SecretStore;
    const error = await caught(() => connectApiKeySource({
      source: 'venice',
      apiKey: API_KEY,
      secretStore: store,
      registryPath: join(scratch, 'handles-repo.json'),
      veniceModelsUrl: `${redirectBase()}/models`,
    }));
    expect(stored).toEqual([]);
    expectNotFollowed();
    expectContentFree(error);
  });

  test('daily Venice key health probe', async () => {
    const result = await runCredentialHealthProbe({
      env: {
        OLYMPUS_CREDENTIAL_HEALTH_SECRET_READ_VENICE: 'cached',
        OLYMPUS_CREDENTIAL_HEALTH_VENICE_API_KEY: API_KEY,
      },
      registryPath: join(scratch, 'no-handles.json'),
      brokerStatePath: join(scratch, 'broker-state.json'),
      reportPath: join(scratch, 'credential-health.json'),
      fetchImpl: rewriteTo(redirectBase('')),
    });
    const venice = result.report.results.find((item) => item.handle === 'venice.api-key');
    expect(venice?.status).toBe('degraded');
    expectNotFollowed();
    expect(JSON.stringify(result.report)).not.toContain(API_KEY);
  });
});

import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuiltInSourceEmbeddingProvider } from '../src/workers/source-index/built-in-embedding/provider.ts';
import { EMBEDDINGGEMMA_2, LITERT_RUNTIME_PACK } from '../src/workers/source-index/built-in-embedding/manifest.ts';
import { RemoteLiteRtEmbedder } from '../src/workers/source-index/built-in-embedding/remote-litert-runtime.ts';
import { mediaCacheDir } from '../src/core/media-cache.ts';
import type { LiteRtEmbedItem } from '../src/workers/source-index/built-in-embedding/litert-runtime.ts';

const identity = {
  modelId: EMBEDDINGGEMMA_2.modelId, weightsSha256: EMBEDDINGGEMMA_2.model.sha256,
  runtime: `litert-lm-${LITERT_RUNTIME_PACK.version}`, dimension: 768,
  maxTokens: EMBEDDINGGEMMA_2.maxTokens, overflow: 'chunk-and-average' as const,
};
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const document = { taskType: 'RETRIEVAL_DOCUMENT' as const };
const query = { taskType: 'RETRIEVAL_QUERY' as const };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-embedding-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  cleanup.push(() => warn.mockRestore());
  let clock = 100_000;
  const state = {
    handshake: { ...identity, device: 'gpu', vision: false } as Record<string, unknown>,
    response: {} as Record<string, unknown>, status: 200, hang: false,
    requests: [] as Array<{ path: string; auth: string | null; texts: string[] | undefined }>,
    wait: undefined as Promise<void> | undefined,
  };
  const serveOptions = { hostname: '127.0.0.1', port: 0, async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    const texts = request.method === 'POST' ? (await request.json() as { texts: string[] }).texts : undefined;
    state.requests.push({ path, auth: request.headers.get('authorization'), texts });
    if (state.hang) await new Promise((resolve) => setTimeout(resolve, 150));
    if (state.status !== 200) return Response.json({ error: 'secret-input-from-server' }, { status: state.status });
    if (path === '/v1/handshake') return Response.json(state.handshake);
    await state.wait;
    const bytes = Buffer.alloc(texts!.length * 768 * 4);
    for (let row = 0; row < texts!.length; row++) bytes.writeFloatLE(1, row * 768 * 4);
    return Response.json({ vectors: bytes.toString('base64'), dimension: 768,
      weightsSha256: identity.weightsSha256, runtime: identity.runtime, ...state.response });
  } };
  let server = Bun.serve(serveOptions);
  const port = server.port!;
  cleanup.push(() => { server.stop(true); });
  const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: dir, OLYMPUS_MEDIA_CACHE_DIR: dir,
    OLYMPUS_BUILT_IN_EMBEDDING_REMOTE_URL: server.url.href };
  const local: LiteRtEmbedItem[][] = [];
  function provider(extraEnv: Record<string, string> = env, requestTimeoutMs = 40) {
    return new BuiltInSourceEmbeddingProvider({ env: extraEnv, now: () => clock, remoteRequestTimeoutMs: requestTimeoutMs,
      install: async () => ({ modelPath: join(dir, 'model'), libraryPath: join(dir, 'library'), runtimeDir: dir }),
      liteRt: async () => ({ device: 'cpu', vision: true, release: async () => {}, embed: async (items) => {
        local.push([...items]);
        return items.map(() => Float32Array.from({ length: 768 }, (_, i) => i === 1 ? 1 : 0));
      } }),
    });
  }
  return { state, env, dir, local, warn, provider, advance: () => { clock += 60_000; },
    stop: () => { server.stop(true); }, restart: () => { server = Bun.serve({ ...serveOptions, port }); } };
}

for (const field of Object.keys(identity)) {
  test(`refuses handshake mismatch: ${field}`, async () => {
    const f = fixture();
    f.state.handshake[field] = 'wrong';
    const p = f.provider();
    expect((await p.embed([{ text: 'private text' }], document))[0]![1]).toBe(1);
    expect(f.state.requests.map((r) => r.path)).toEqual(['/v1/handshake']);
    expect(p.status().remoteDocuments).toBe(false);
  });
}

for (const field of ['weightsSha256', 'runtime', 'dimension', 'vectors']) {
  test(`refuses a mid-run swap or malformed vectors: ${field}`, async () => {
    const f = fixture(); const p = f.provider();
    expect((await p.embed([{ text: 'first' }], document))[0]![0]).toBe(1);
    f.state.response[field] = 'wrong';
    const vectors = await p.embed([{ text: 'second' }, { text: 'third' }], document);
    expect(vectors.map((v) => v[1])).toEqual([1, 1]);
    expect(f.local).toHaveLength(1);
    expect(p.status().remoteDocuments).toBe(false);
    f.state.response = {}; f.advance();
    await p.embed([{ text: 'recovered' }], document);
    expect(f.state.requests.filter((r) => r.path === '/v1/handshake')).toHaveLength(2);
  });
}

for (const failure of ['down', '5xx', 'timeout', '401', '400']) {
  test(`falls back on ${failure}, cools down, re-handshakes and recovers`, async () => {
    const f = fixture(); const p = f.provider();
    await p.embed([{ text: 'healthy' }], document);
    if (failure === 'down') f.stop();
    const target = p;
    f.state.status = failure === '5xx' ? 503 : failure === '401' ? 401 : failure === '400' ? 400 : 200;
    f.state.hang = failure === 'timeout';
    expect((await target.embed([{ text: 'private text' }], document))[0]![1]).toBe(1);
    const requests = f.state.requests.length;
    const warnings = f.warn.mock.calls.length;
    await target.embed([{ text: 'still local' }], document);
    expect(f.state.requests.length).toBe(requests);
    expect(f.warn.mock.calls.length).toBe(warnings);
    f.state.status = 200; f.state.hang = false; f.advance();
    if (failure === 'down') f.restart();
    expect((await target.embed([{ text: 'recovered' }], document))[0]![0]).toBe(1);
    expect(f.state.requests.filter((r) => r.path === '/v1/handshake')).toHaveLength(2);
  });
}

test('identity is unchanged; query remains local while a remote document is blocked', async () => {
  const f = fixture(); const p = f.provider(f.env, 2_000);
  const plain = f.provider({ ...f.env, OLYMPUS_BUILT_IN_EMBEDDING_REMOTE_URL: '' });
  for (const field of ['configHash', 'epochId', 'provider', 'modelId', 'backend'] as const) expect(p[field]).toBe(plain[field]);
  expect(p.configHash).toBe('7e20c65a7450e853a7b4d8bbaf47c77541d0e41c41d63fd7a1abbd05c0b6243b');
  await p.prepare();
  let unblock!: () => void;
  f.state.wait = new Promise<void>((resolve) => { unblock = resolve; });
  const pending = p.embed([{ text: 'document' }], document);
  while (!f.state.requests.some((r) => r.path === '/v1/embed')) await new Promise((resolve) => setTimeout(resolve, 1));
  try {
    const result = await Promise.race([
      p.embed([{ text: 'question' }], query),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('query waited behind remote')), 100)),
    ]);
    expect(result[0]![1]).toBe(1);
    expect(f.local).toHaveLength(1);
    expect(f.state.requests.filter((r) => r.path === '/v1/embed')).toHaveLength(1);
  } finally { unblock(); await pending; }
  expect(plain.status().remoteDocuments).toBeUndefined();
  for (const field of ['configHash', 'epochId', 'provider', 'modelId', 'backend'] as const) expect(p[field]).toBe(plain[field]);
  await plain.embed([{ text: 'local document' }], document);
  expect(f.local).toHaveLength(2);
});

test('a picture batch stays local; text-only batches are framed and bounded to eight', async () => {
  const f = fixture(); const p = f.provider();
  const sha = 'a'.repeat(64);
  await p.embed([{ text: 'picture', image: { path: join(mediaCacheDir(f.env), `${sha}.jpg`), sha256: sha, mimeType: 'image/jpeg' } }, { text: 'same batch' }], document);
  expect(f.state.requests).toHaveLength(0);
  expect(typeof f.local[0]![0]).toBe('object');
  await p.embed(Array.from({ length: 11 }, () => ({ text: 'hello' })), document);
  const batches = f.state.requests.filter((r) => r.texts).map((r) => r.texts!);
  expect(batches.map((b) => b.length)).toEqual([8, 3]);
  expect(batches[0]![0]).toBe('title: none | text: hello');
});

test('URL policy rejects non-loopback HTTP and accepts HTTPS and loopback', () => {
  for (const url of ['http://example.com', 'http://192.168.1.2', 'ftp://localhost', 'https://user:pass@example.com']) {
    expect(() => new RemoteLiteRtEmbedder({ url, identity })).toThrow();
  }
  for (const url of ['https://example.com', 'http://localhost', 'http://127.0.0.1', 'http://[::1]']) {
    expect(() => new RemoteLiteRtEmbedder({ url, identity })).not.toThrow();
  }
});

test('bearer token is sent on both endpoints; logs contain no token, text or error body', async () => {
  const f = fixture(); const tokenFile = join(f.dir, 'token');
  writeFileSync(tokenFile, 'synthetic-token\n');
  const p = f.provider({ ...f.env, OLYMPUS_BUILT_IN_EMBEDDING_REMOTE_TOKEN_FILE: tokenFile });
  await p.embed([{ text: 'sensitive-input' }], document);
  expect(f.state.requests.map((r) => r.auth)).toEqual(['Bearer synthetic-token', 'Bearer synthetic-token']);
  f.state.status = 503;
  await p.embed([{ text: 'sensitive-input' }], document);
  expect(JSON.stringify(f.warn.mock.calls)).not.toMatch(/synthetic-token|sensitive-input|secret-input-from-server/);
});

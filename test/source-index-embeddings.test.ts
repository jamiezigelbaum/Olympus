import { describe, expect, test } from 'bun:test';
import {
  GeminiSourceEmbeddingProvider,
  DeterministicSourceEmbeddingProvider,
  OpenAICompatibleSourceEmbeddingProvider,
  cosineSimilarity,
} from '../src/workers/source-index/embeddings.ts';

function mediaFetchFromFetchImpl(fetchImpl: typeof fetch) {
  return (url: URL, options: { signal: AbortSignal; validatedAddresses: readonly string[] }) => fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1',
      'User-Agent': 'Mozilla/5.0 (compatible; OlympusSourceIndex/0.1)',
    },
    redirect: 'manual',
    signal: options.signal,
  });
}

describe('source-index embedding providers', () => {
  test('calls Gemini batch embeddings with retrieval metadata and no stored API key', async () => {
    const calls: Array<{ url: string; apiKey: string; body: unknown }> = [];
    const mediaCalls: Array<{
      url: string;
      method: string | undefined;
      accept: string;
      userAgent: string;
      hasSignal: boolean;
      redirect: RequestRedirect | undefined;
    }> = [];
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === 'https://media.example/image.png') {
        const headers = new Headers(init?.headers);
        mediaCalls.push({
          url: String(url),
          method: init?.method,
          accept: headers.get('accept') ?? '',
          userAgent: headers.get('user-agent') ?? '',
          hasSignal: init?.signal instanceof AbortSignal,
          redirect: init?.redirect,
        });
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'Content-Type': 'image/png', 'Content-Length': '4' },
        });
      }
      calls.push({
        url: String(url),
        apiKey: new Headers(init?.headers).get('x-goog-api-key') ?? '',
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({
        embeddings: [
          { values: [1, 0, 0] },
          { values: [0, 1, 0] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const provider = new GeminiSourceEmbeddingProvider({
      apiKey: 'gemini-secret',
      model: 'gemini-embedding-2',
      outputDimensionality: 3,
      epochId: 'cloud:google-gemini:gemini-embedding-2:test',
      fetchImpl: fakeFetch,
      mediaFetchImpl: mediaFetchFromFetchImpl(fakeFetch),
      maxMediaPerInput: 1,
      lookupIpAddresses: async () => ['93.184.216.34'],
    });

    const vectors = await provider.embed([
      { title: 'PARA spine', text: 'Second brain notes.', media: [{ url: 'https://media.example/image.png' }] },
      { text: 'Climate policy.' },
    ], { taskType: 'RETRIEVAL_DOCUMENT' });

    expect(vectors).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(provider.dimension).toBe(3);
    expect(provider.configHash).not.toContain('gemini-secret');
    expect(mediaCalls).toEqual([{
      url: 'https://media.example/image.png',
      method: 'GET',
      accept: 'image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1',
      userAgent: 'Mozilla/5.0 (compatible; OlympusSourceIndex/0.1)',
      hasSignal: true,
      redirect: 'manual',
    }]);
    expect(calls).toEqual([{
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents',
      apiKey: 'gemini-secret',
      body: {
        requests: [
          {
            model: 'models/gemini-embedding-2',
            content: {
              parts: [
                { text: 'Second brain notes.' },
                { inlineData: { mimeType: 'image/png', data: 'iVBORw==' } },
              ],
            },
            taskType: 'RETRIEVAL_DOCUMENT',
            title: 'PARA spine',
            outputDimensionality: 3,
          },
          {
            model: 'models/gemini-embedding-2',
            content: { parts: [{ text: 'Climate policy.' }] },
            taskType: 'RETRIEVAL_DOCUMENT',
            outputDimensionality: 3,
          },
        ],
      },
    }]);
  });

  test('skips slow media fetches instead of blocking Gemini embeddings', async () => {
    let mediaAborted = false;
    let requestBody: unknown;
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === 'https://media.example/slow.png') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            mediaAborted = true;
            reject(new Error('media fetch aborted'));
          });
        });
      }
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        embeddings: [
          { values: [1, 0, 0] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const provider = new GeminiSourceEmbeddingProvider({
      apiKey: 'gemini-secret',
      model: 'gemini-embedding-2',
      outputDimensionality: 3,
      mediaFetchTimeoutMs: 100,
      fetchImpl: fakeFetch,
      mediaFetchImpl: mediaFetchFromFetchImpl(fakeFetch),
      maxMediaPerInput: 1,
      lookupIpAddresses: async () => ['93.184.216.34'],
    });

    const vectors = await provider.embed([
      { text: 'Visual article.', media: [{ url: 'https://media.example/slow.png' }] },
    ], { taskType: 'RETRIEVAL_DOCUMENT' });

    expect(vectors).toEqual([[1, 0, 0]]);
    expect(provider.lastMediaPartsSkipped).toBe(1);
    expect(provider.mediaPartsSkipped).toBe(1);
    expect(mediaAborted).toBe(true);
    expect(requestBody).toMatchObject({
      requests: [{
        content: { parts: [{ text: 'Visual article.' }] },
      }],
    });
  });

  test('skips Gemini media that resolves or redirects to private networks', async () => {
    const mediaFetches: string[] = [];
    let requestBody: unknown;
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://redirect.example/image.png') {
        mediaFetches.push(href);
        return new Response('', {
          status: 302,
          headers: { Location: 'https://127.0.0.1/private.png' },
        });
      }
      if (href.includes('/image.png')) {
        throw new Error(`unexpected private media fetch: ${href}`);
      }
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        embeddings: [
          { values: [1, 0, 0] },
          { values: [0, 1, 0] },
          { values: [0, 0, 1] },
          { values: [1, 1, 0] },
          { values: [1, 0, 1] },
          { values: [0, 1, 1] },
          { values: [1, 1, 1] },
          { values: [2, 0, 0] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const provider = new GeminiSourceEmbeddingProvider({
      apiKey: 'gemini-secret',
      model: 'gemini-embedding-2',
      outputDimensionality: 3,
      fetchImpl: fakeFetch,
      mediaFetchImpl: mediaFetchFromFetchImpl(fakeFetch),
      maxMediaPerInput: 1,
      lookupIpAddresses: async (hostname) => {
        if (hostname === 'media.example') return ['127.0.0.1'];
        if (hostname === 'mapped.example') return ['0:0:0:0:0:ffff:7f00:1'];
        if (hostname === 'mapped-private.example') return ['0:0:0:0:0:ffff:c0a8:1'];
        if (hostname === 'redirect.example') return ['93.184.216.34'];
        return ['93.184.216.34'];
      },
    });

    const vectors = await provider.embed([
      { text: 'Private DNS image.', media: [{ url: 'https://media.example/image.png' }] },
      { text: 'Private redirect image.', media: [{ url: 'https://redirect.example/image.png' }] },
      { text: 'Private IPv6 image.', media: [{ url: 'https://[fc00::1]/image.png' }] },
      { text: 'Mapped IPv6 loopback image.', media: [{ url: 'https://[::ffff:127.0.0.1]/image.png' }] },
      { text: 'Expanded mapped IPv6 loopback image.', media: [{ url: 'https://[0:0:0:0:0:ffff:7f00:1]/image.png' }] },
      { text: 'Compressed mapped IPv6 private image.', media: [{ url: 'https://[::ffff:c0a8:101]/image.png' }] },
      { text: 'Expanded mapped IPv6 DNS loopback image.', media: [{ url: 'https://mapped.example/image.png' }] },
      { text: 'Expanded mapped IPv6 DNS private image.', media: [{ url: 'https://mapped-private.example/image.png' }] },
    ], { taskType: 'RETRIEVAL_DOCUMENT' });

    expect(vectors).toHaveLength(8);
    expect(provider.mediaPartsSkipped).toBe(8);
    expect(mediaFetches).toEqual(['https://redirect.example/image.png']);
    expect(requestBody).toMatchObject({
      requests: [
        { content: { parts: [{ text: 'Private DNS image.' }] } },
        { content: { parts: [{ text: 'Private redirect image.' }] } },
        { content: { parts: [{ text: 'Private IPv6 image.' }] } },
        { content: { parts: [{ text: 'Mapped IPv6 loopback image.' }] } },
        { content: { parts: [{ text: 'Expanded mapped IPv6 loopback image.' }] } },
        { content: { parts: [{ text: 'Compressed mapped IPv6 private image.' }] } },
        { content: { parts: [{ text: 'Expanded mapped IPv6 DNS loopback image.' }] } },
        { content: { parts: [{ text: 'Expanded mapped IPv6 DNS private image.' }] } },
      ],
    });
    expect(JSON.stringify(requestBody)).not.toContain('inlineData');
  });

  test('does not reuse generic Gemini API fetch for media downloads', async () => {
    const fetchedUrls: string[] = [];
    let requestBody: unknown;
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      fetchedUrls.push(href);
      if (href === 'https://media.example/image.png') {
        throw new Error('generic fetch must not be used for media downloads');
      }
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        embeddings: [
          { values: [1, 0, 0] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const provider = new GeminiSourceEmbeddingProvider({
      apiKey: 'gemini-secret',
      model: 'gemini-embedding-2',
      outputDimensionality: 3,
      fetchImpl: fakeFetch,
      maxMediaPerInput: 1,
      lookupIpAddresses: async () => ['127.0.0.1'],
    });

    const vectors = await provider.embed([
      { text: 'Private media is skipped.', media: [{ url: 'https://media.example/image.png' }] },
    ], { taskType: 'RETRIEVAL_DOCUMENT' });

    expect(vectors).toEqual([[1, 0, 0]]);
    expect(fetchedUrls).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents',
    ]);
    expect(requestBody).toMatchObject({
      requests: [{
        content: { parts: [{ text: 'Private media is skipped.' }] },
      }],
    });
    expect(JSON.stringify(requestBody)).not.toContain('inlineData');
  });

  test('cancels oversized Gemini media bodies without content-length', async () => {
    let mediaCanceled = false;
    let requestBody: unknown;
    const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        embeddings: [
          { values: [1, 0, 0] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const provider = new GeminiSourceEmbeddingProvider({
      apiKey: 'gemini-secret',
      model: 'gemini-embedding-2',
      outputDimensionality: 3,
      fetchImpl: fakeFetch,
      mediaFetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
        },
        cancel() {
          mediaCanceled = true;
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
      maxMediaPerInput: 1,
      maxMediaBytes: 4,
      lookupIpAddresses: async () => ['93.184.216.34'],
    });

    const vectors = await provider.embed([
      { text: 'Oversized media is skipped.', media: [{ url: 'https://media.example/huge.png' }] },
    ], { taskType: 'RETRIEVAL_DOCUMENT' });

    expect(vectors).toEqual([[1, 0, 0]]);
    expect(mediaCanceled).toBe(true);
    expect(requestBody).toMatchObject({
      requests: [{
        content: { parts: [{ text: 'Oversized media is skipped.' }] },
      }],
    });
    expect(JSON.stringify(requestBody)).not.toContain('inlineData');
  });

  test('passes prevalidated public addresses to the Gemini media fetch transport', async () => {
    const mediaFetches: Array<{ url: string; validatedAddresses: string[] }> = [];
    let requestBody: unknown;
    const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        embeddings: [
          { values: [1, 0, 0] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const provider = new GeminiSourceEmbeddingProvider({
      apiKey: 'gemini-secret',
      model: 'gemini-embedding-2',
      outputDimensionality: 3,
      fetchImpl: fakeFetch,
      mediaFetchImpl: async (url, options) => {
        mediaFetches.push({
          url: url.toString(),
          validatedAddresses: [...options.validatedAddresses],
        });
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'Content-Type': 'image/png', 'Content-Length': '4' },
        });
      },
      maxMediaPerInput: 1,
      lookupIpAddresses: async (hostname) => {
        if (hostname === 'rebind.example') return ['93.184.216.34'];
        return ['127.0.0.1'];
      },
    });

    const vectors = await provider.embed([
      { text: 'Pinned image.', media: [{ url: 'https://rebind.example/image.png' }] },
    ], { taskType: 'RETRIEVAL_DOCUMENT' });

    expect(vectors).toEqual([[1, 0, 0]]);
    expect(mediaFetches).toEqual([{
      url: 'https://rebind.example/image.png',
      validatedAddresses: ['93.184.216.34'],
    }]);
    expect(requestBody).toMatchObject({
      requests: [{
        content: {
          parts: [
            { text: 'Pinned image.' },
            { inlineData: { mimeType: 'image/png', data: 'iVBORw==' } },
          ],
        },
      }],
    });
  });

  test('calls local OpenAI-compatible source embeddings without accepting cloud URLs', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({
        data: [
          { embedding: [1, 0, 0] },
          { embedding: [0, 1, 0] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const provider = new OpenAICompatibleSourceEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:8000/v1/',
      model: 'delphi-local-embedding',
      dimension: 3,
      fetchImpl: fakeFetch,
    });

    const vectors = await provider.embed([
      { title: 'Dropbox note', text: 'Secure local source text.' },
      { text: 'Another source text.' },
    ], { taskType: 'RETRIEVAL_DOCUMENT' });

    expect(provider.backend).toBe('local');
    expect(provider.configHash).not.toContain('127.0.0.1');
    expect(vectors).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:8000/v1/embeddings',
      body: {
        model: 'delphi-local-embedding',
        input: [
          'Title: Dropbox note\nSecure local source text.',
          'Another source text.',
        ],
      },
    }]);
    expect(() => new OpenAICompatibleSourceEmbeddingProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'not-local',
    })).toThrow('loopback endpoint');
  });

  test('deterministic provider keeps semantically related source concepts close for tests', async () => {
    const provider = new DeterministicSourceEmbeddingProvider({
      conceptGroups: [[
        'personal knowledge management',
        'knowledge',
        'management',
        'second brain',
        'para',
        'folders',
        'projects',
        'resources',
      ]],
    });
    const [query] = await provider.embed([{ text: 'personal knowledge management' }], { taskType: 'RETRIEVAL_QUERY' });
    const [document] = await provider.embed([{ text: 'Second brain PARA folders organize projects and resources.' }], { taskType: 'RETRIEVAL_DOCUMENT' });
    const [unrelated] = await provider.embed([{ text: 'Carbon markets and regional politics.' }], { taskType: 'RETRIEVAL_DOCUMENT' });

    expect(query).toBeDefined();
    expect(document).toBeDefined();
    expect(unrelated).toBeDefined();
    expect(cosineSimilarity(query!, document!)).toBeGreaterThan(cosineSimilarity(query!, unrelated!));
  });
});

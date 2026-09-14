import { describe, expect, test } from 'bun:test';
import {
  ModelSetupService,
  requiredModelProfiles,
  type ModelCredentialState,
} from '../src/core/model-setup.ts';
import {
  loadSovereigntyPreset,
  type SovereigntyConfig,
  type SovereigntyModelProfile,
  type SovereigntyTrustDomainPolicy,
} from '../src/core/sovereignty.ts';

const localChat: SovereigntyModelProfile = {
  provider: 'local-openai-compatible', trust: 'local', model: 'chat-local',
  baseUrl: 'http://127.0.0.1:28090/v1', purpose: 'analyst',
};
const localEmbedding: SovereigntyModelProfile = {
  provider: 'local-openai-compatible', trust: 'local', model: 'secure-local-qwen3-embed',
  baseUrl: 'http://localhost:28090/v1', purpose: 'embedding',
};
const gemini: SovereigntyModelProfile = {
  provider: 'google-gemini', trust: 'standard_cloud', model: 'gemini-embedding-2',
  secretRef: 'env:TOP_SECRET_GEMINI_VALUE', purpose: 'embedding',
};
const venice: SovereigntyModelProfile = {
  provider: 'venice', trust: 'encrypted_cloud', model: 'private-chat',
  secretRef: 'store:TOP_SECRET_VENICE_VALUE', purpose: 'analyst',
};

test('an additional configured provider with a missing credential cannot unlock sources', () => {
  const service = new ModelSetupService({
    config: baseConfig({ modelProfiles: { custom: { provider: 'openai-compatible', trust: 'standard_cloud', model: 'custom', secretRef: 'env:CUSTOM_KEY' } }, routes: { public_safe: { analyst: ['custom'] } } }),
    credentialState: () => 'missing',
  });
  expect(service.getStatus().ready).toBe(false);
  expect(service.getStatus().attention).toContain('agent-assisted setup');
});

describe('requiredModelProfiles', () => {
  test('selects only active route members and active retrieval profiles', () => {
    const config = baseConfig({
      modelProfiles: {
        local: localChat,
        gemini,
        venice,
        'disabled-venice': { ...venice, model: 'unused-disabled' },
        'stored-local': { ...localChat, model: 'unused-stored' },
        'lexical-embedding': { ...localEmbedding, model: 'unused-lexical' },
      },
      routes: {
        public_safe: { pool: { members: ['local', 'local'] } },
        internal: { mode: 'disabled', pool: { members: ['disabled-venice'] } },
        secure_local: { analyst: ['venice'] },
      },
      retrieval: { trustDomains: {
        public_safe: policy('gemini', 'hybrid_shadow'),
        internal: policy('lexical-embedding', 'lexical_only'),
        secure_local: policy(null, 'metadata_only'),
      } },
    });

    expect(requiredModelProfiles(config).map(({ id }) => id)).toEqual(['local', 'venice', 'gemini']);
  });
});

describe('ModelSetupService status', () => {
  test('gates readiness on required cards and does no inference during status reads', () => {
    let requests = 0;
    const states: Record<string, ModelCredentialState> = {
      gemini: 'ready', venice: 'applying', local: 'ready',
    };
    const service = new ModelSetupService({
      config: configuredModelSet(),
      credentialState: (id) => states[id] ?? 'missing',
      fetch: asFetch(async () => { requests += 1; return json({}); }),
      now: () => new Date('2026-09-14T12:00:00.000Z'),
    });

    expect(service.getStatus()).toEqual({
      ready: false,
      checked_at: '2026-09-14T12:00:00.000Z',
      cards: [
        expect.objectContaining({ id: 'gemini', required: true, state: 'ready' }),
        expect.objectContaining({ id: 'venice', required: true, state: 'applying' }),
        expect.objectContaining({ id: 'local', required: true, state: 'not_configured' }),
      ],
    });
    expect(requests).toBe(0);
  });

  test('does not demand Venice or local models when the active policy uses neither', () => {
    const config = baseConfig({
      modelProfiles: { gemini, venice, local: localChat },
      routes: { public_safe: { pool: { members: [] } } },
      retrieval: { trustDomains: { public_safe: policy('gemini', 'hybrid_primary') } },
    });
    const service = new ModelSetupService({ config, credentialState: () => 'ready' });

    expect(service.getStatus().cards.map(({ id }) => id)).toEqual(['gemini']);
    expect(service.getStatus().ready).toBe(true);
  });

  test.each([
    { preset: 'local-only' as const, cards: ['gemini', 'local'] },
    { preset: 'no-sensitive' as const, cards: ['gemini'] },
    { preset: 'local-first' as const, cards: ['gemini', 'venice', 'local'] },
    { preset: 'private-cloud-only' as const, cards: ['gemini', 'venice'] },
  ])('$preset requires only its active provider cards', ({ preset, cards }) => {
    const service = new ModelSetupService({
      config: loadSovereigntyPreset(preset), credentialState: () => 'ready',
    });

    expect(service.getStatus().cards.map(({ id }) => id)).toEqual([...cards]);
  });
});

describe('ModelSetupService local checks', () => {
  test('verifies listed model IDs, chat completion, embeddings, and registered dimension', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/models')) {
        const model = url.includes('localhost') ? localEmbedding.model : localChat.model;
        return json({ data: [{ id: model }] });
      }
      if (url.endsWith('/chat/completions')) {
        return json({ choices: [{ message: { content: 'ready' } }] });
      }
      return json({ data: [{ embedding: new Array(2560).fill(0.25) }] });
    }) as typeof fetch;
    const service = new ModelSetupService({
      config: configuredModelSet(), credentialState: () => 'ready', fetch: fetchImpl,
    });

    const result = await service.checkLocalModels();

    expect(result.cards.find(({ id }) => id === 'local')?.state).toBe('ready');
    expect(result.ready).toBe(true);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      '/v1/models', '/v1/chat/completions', '/v1/models', '/v1/embeddings',
    ]);
    expect(requests.every(({ init }) => init?.redirect === 'error')).toBe(true);
    const chat = JSON.parse(String(requests[1]?.init?.body));
    expect(chat.max_tokens).toBe(8);
    expect(chat.messages).toEqual([{ role: 'user', content: 'Reply with one word: ready.' }]);
  });

  test('uses the existing local credential only for the configured loopback checks', async () => {
    const secret = 'synthetic-local-model-key';
    const service = new ModelSetupService({
      config: localConfig({ ...localChat, secretRef: 'store:local.model.key' }),
      credentialState: () => 'ready', localApiKey: () => secret,
      fetch: asFetch(async (input, init) => {
        expect(new URL(String(input)).hostname).toBe('127.0.0.1');
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${secret}`);
        return String(input).endsWith('/models') ? json({ data: [{ id: 'chat-local' }] })
          : json({ choices: [{ message: { content: 'ready' } }] });
      }),
    });
    const checked = await service.checkLocalModels();
    expect(checked.ready).toBe(true);
    expect(JSON.stringify(checked)).not.toContain(secret);
  });

  test('refuses a model ID mismatch before inference', async () => {
    const paths: string[] = [];
    const service = new ModelSetupService({
      config: localConfig(localChat), credentialState: () => 'ready',
      fetch: (async (input) => {
        paths.push(new URL(String(input)).pathname);
        return json({ data: [{ id: 'different-model' }] });
      }) as typeof fetch,
    });

    const result = await service.checkLocalModels();

    expect(paths).toEqual(['/v1/models']);
    expect(result.cards[0]?.state).toBe('needs_attention');
  });

  test('requires a nonempty chat completion', async () => {
    const service = new ModelSetupService({
      config: localConfig(localChat), credentialState: () => 'ready',
      fetch: (async (input) => String(input).endsWith('/models')
        ? json({ data: [{ id: localChat.model }] })
        : json({ choices: [{ message: { content: '   ' } }] })) as typeof fetch,
    });

    expect((await service.checkLocalModels()).cards[0]?.state).toBe('needs_attention');
  });

  test('prefers the effective runtime dimension over the registered default', async () => {
    const requestedProfiles: string[] = [];
    const service = new ModelSetupService({
      config: localEmbeddingConfig(),
      credentialState: () => 'ready',
      expectedEmbeddingDimension: (profileId) => {
        requestedProfiles.push(profileId);
        return 3;
      },
      fetch: (async (input) => String(input).endsWith('/models')
        ? json({ data: [{ id: localEmbedding.model }] })
        : json({ data: [{ embedding: new Array(2560).fill(0.25) }] })) as typeof fetch,
    });

    expect((await service.checkLocalModels()).cards[0]?.state).toBe('needs_attention');
    expect(requestedProfiles).toEqual(['embedding']);
  });

  test.each([undefined, 0, -1])('refuses unavailable runtime dimension %s before HTTP', async (dimension) => {
    let requests = 0;
    const service = new ModelSetupService({
      config: localEmbeddingConfig(),
      credentialState: () => 'ready',
      expectedEmbeddingDimension: () => dimension,
      fetch: asFetch(async () => { requests += 1; return json({}); }),
    });

    expect((await service.checkLocalModels()).cards[0]?.state).toBe('needs_attention');
    expect(requests).toBe(0);
  });

  test.each([
    { name: 'empty', vector: [] },
    { name: 'non-finite', vector: [1, Number.NaN] },
    { name: 'wrong registered dimension', vector: [1, 2, 3] },
  ])('rejects $name embedding responses', async ({ vector }) => {
    const service = new ModelSetupService({
      config: localEmbeddingConfig(), credentialState: () => 'ready',
      fetch: (async (input) => String(input).endsWith('/models')
        ? json({ data: [{ id: localEmbedding.model }] })
        : json({ data: [{ embedding: vector }] })) as typeof fetch,
    });

    expect((await service.checkLocalModels()).cards[0]?.state).toBe('needs_attention');
  });

  test.each([
    'http://user:password@127.0.0.1:28090/v1',
    'http://127.0.0.1:28090/v1?token=secret',
    'http://127.0.0.1:28090/v1?',
    'http://127.0.0.1:28090/v1#secret',
    'http://127.0.0.1:28090/v1#',
    'http://192.168.1.10:28090/v1',
    'https://models.example.com/v1',
  ])('refuses unsafe endpoint %s before any network request', async (baseUrl) => {
    let requests = 0;
    const service = new ModelSetupService({
      config: localConfig({ ...localChat, baseUrl }), credentialState: () => 'ready',
      fetch: asFetch(async () => { requests += 1; return json({}); }),
    });

    expect((await service.checkLocalModels()).cards[0]?.state).toBe('needs_attention');
    expect(requests).toBe(0);
  });

  test('refuses redirects and never follows them', async () => {
    let requests = 0;
    const service = new ModelSetupService({
      config: localConfig(localChat), credentialState: () => 'ready',
      fetch: (async (_input, init) => {
        requests += 1;
        expect(init?.redirect).toBe('error');
        return new Response('', { status: 302, headers: { Location: 'https://example.com/models' } });
      }) as typeof fetch,
    });

    expect((await service.checkLocalModels()).cards[0]?.state).toBe('needs_attention');
    expect(requests).toBe(1);
  });

  test('bounds response bodies', async () => {
    const service = new ModelSetupService({
      config: localConfig(localChat), credentialState: () => 'ready',
      fetch: asFetch(async () => new Response('x'.repeat(70 * 1024), { status: 200 })),
    });

    expect((await service.checkLocalModels()).cards[0]?.state).toBe('needs_attention');
  });

  test.each(['missing', 'applying'] as const)('does not probe while a local credential is %s', async (state) => {
    let requests = 0;
    const service = new ModelSetupService({
      config: localConfig({ ...localChat, secretRef: 'store:LOCAL_SECRET' }),
      credentialState: () => state,
      fetch: asFetch(async () => { requests += 1; return json({}); }),
    });

    const result = await service.checkLocalModels();
    expect(result.cards[0]?.state).toBe(state === 'missing' ? 'not_configured' : 'applying');
    expect(requests).toBe(0);
  });

  test('coalesces concurrent explicit checks', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    const service = new ModelSetupService({
      config: localConfig(localChat), credentialState: () => 'ready',
      fetch: (async (input) => {
        requests += 1;
        if (String(input).endsWith('/models')) {
          await gate;
          return json({ data: [{ id: localChat.model }] });
        }
        return json({ choices: [{ message: { content: 'ready' } }] });
      }) as typeof fetch,
    });

    const first = service.checkLocalModels();
    const second = service.checkLocalModels();
    expect(first).toBe(second);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.cards[0]?.state).toBe('ready');
    expect(b.cards[0]?.state).toBe('ready');
    expect(requests).toBe(2);
  });

  test('never probes cloud profiles or exposes refs, errors, provider bodies, or model output', async () => {
    let requests = 0;
    const config = baseConfig({
      modelProfiles: { gemini, venice },
      routes: { secure_local: { pool: { members: ['venice'] } } },
      retrieval: { trustDomains: { public_safe: policy('gemini', 'hybrid_shadow') } },
    });
    const service = new ModelSetupService({
      config, credentialState: () => 'ready',
      fetch: asFetch(async () => {
        requests += 1;
        throw new Error('TOP_SECRET_ERROR');
      }),
    });

    const view = await service.checkLocalModels();
    expect(requests).toBe(0);
    const output = JSON.stringify(view);
    for (const forbidden of ['TOP_SECRET', 'private-chat', 'gemini-embedding-2', 'TOP_SECRET_ERROR']) {
      expect(output).not.toContain(forbidden);
    }
  });
});

function configuredModelSet(): SovereigntyConfig {
  return baseConfig({
    modelProfiles: { local: localChat, embedding: localEmbedding, gemini, venice },
    routes: {
      public_safe: { pool: { members: ['local'] } },
      secure_local: { pool: { members: ['venice'] } },
    },
    retrieval: { trustDomains: {
      public_safe: policy('gemini', 'hybrid_shadow'),
      secure_local: policy('embedding', 'hybrid_primary'),
    } },
  });
}

function localConfig(profile: SovereigntyModelProfile): SovereigntyConfig {
  return baseConfig({
    modelProfiles: { local: profile },
    routes: { public_safe: { pool: { members: ['local'] } } },
  });
}

function localEmbeddingConfig(): SovereigntyConfig {
  return baseConfig({
    modelProfiles: { embedding: localEmbedding },
    retrieval: { trustDomains: { public_safe: policy('embedding', 'hybrid_primary') } },
  });
}

function baseConfig(overrides: Partial<SovereigntyConfig> = {}): SovereigntyConfig {
  return {
    schemaVersion: 1,
    modelProfiles: overrides.modelProfiles ?? {},
    routes: overrides.routes ?? {},
    retrieval: overrides.retrieval ?? { trustDomains: {} },
  };
}

function policy(
  embeddingProfile: string | null,
  activationMode: NonNullable<SovereigntyTrustDomainPolicy['activationMode']>,
): SovereigntyTrustDomainPolicy {
  return {
    minimumExecutionTrust: 'local',
    allowedEmbeddingTrust: ['local', 'standard_cloud', 'encrypted_cloud'],
    embeddingProfile,
    allowCloudQuery: true,
    activationMode,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function asFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return implementation as unknown as typeof fetch;
}

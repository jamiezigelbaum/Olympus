import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createAnalyst } from '../src/core/analyst.ts';
import { createVeniceAnalystModel } from '../src/core/analyst-venice.ts';
import type { EvidencePack } from '../src/core/contracts.ts';
import type { OpenAIAnalystFetch } from '../src/core/analyst-openai.ts';
import {
  defaultVeniceModelCatalogCachePath,
  type VeniceModelCatalogFetch,
} from '../src/core/venice-model-catalog.ts';
import {
  VeniceModelPolicyDeniedError,
  isVenicePrivacyCategoryApprovedForSecureLocal,
  veniceAnalystModelAliasTargets,
  venicePrivacyCategoryForModel,
  type VenicePrivacyCategory,
} from '../src/core/venice-models.ts';

const HOUR_MS = 60 * 60 * 1_000;
const NOW_MS = Date.parse('2026-07-21T12:00:00.000Z');

describe('Venice secure-local privacy category gate', () => {
  test('allows a new Private model from Venice catalog even when it is absent from the pinned snapshot', async () => {
    await withCatalogCache(async (cachePath) => {
      const catalogCalls: Array<{ url: string; init: RequestInit }> = [];
      const chatCalls: string[] = [];
      const modelId = 'venice-new-private-model';
      expect(venicePrivacyCategoryForModel(modelId)).toBeUndefined();

      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: modelId,
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          now: () => NOW_MS,
          fetchImpl: async (url, init) => {
            catalogCalls.push({ url, init });
            return catalogResponse({ [modelId]: 'private' });
          },
        },
      }));

      const result = await analyst.analyze(evidencePack('secure_local', 'S4'), { localOnly: true });

      expect(result.answer).toBe('category gate passed');
      expect(catalogCalls).toHaveLength(1);
      expect(catalogCalls[0]!.url).toBe('https://api.venice.ai/api/v1/models?type=text');
      expect(catalogCalls[0]!.init.method).toBe('GET');
      expect(catalogCalls[0]!.init.body).toBeUndefined();
      expect(chatCalls).toEqual(['https://api.venice.ai/api/v1/chat/completions']);
      expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toMatchObject({
        schema_version: 1,
        fetched_at: '2026-07-21T12:00:00.000Z',
        models: { [modelId]: 'private' },
      });
    });
  });

  test('allows a new Private model whose live catalog id carries uppercase characters', async () => {
    await withCatalogCache(async (cachePath) => {
      const chatCalls: string[] = [];
      // Venice keys its live catalog verbatim while alias normalization
      // lowercases unrecognized ids; the lookup must tolerate the case
      // difference instead of refusing the model as unknown.
      const catalogId = 'Venice-NewPrivate-2026';
      expect(venicePrivacyCategoryForModel(catalogId)).toBeUndefined();

      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: catalogId,
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          now: () => NOW_MS,
          fetchImpl: async () => catalogResponse({ [catalogId]: 'private' }),
        },
      }));

      const result = await analyst.analyze(evidencePack('secure_local', 'S4'), { localOnly: true });

      expect(result.answer).toBe('category gate passed');
      expect(chatCalls).toEqual(['https://api.venice.ai/api/v1/chat/completions']);
    });
  });

  test('refuses an anonymized category from the live catalog before chat dispatch', async () => {
    await withCatalogCache(async (cachePath) => {
      const catalogCalls: string[] = [];
      const chatCalls: string[] = [];
      const modelId = 'qwen3-6-27b';
      expect(venicePrivacyCategoryForModel(modelId)).toBe('private');
      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: modelId,
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          now: () => NOW_MS,
          fetchImpl: catalogFetch(catalogCalls, { [modelId]: 'anonymized' }),
        },
      }));

      const refusal = analyst.analyze(evidencePack('secure_local', 'S4'), { localOnly: true });

      await expect(refusal).rejects.toBeInstanceOf(VeniceModelPolicyDeniedError);
      await expect(refusal).rejects.toMatchObject({
        code: 'source_index_policy_violation',
        privacyCategory: 'anonymized',
        modelId,
      });
      expect(catalogCalls).toHaveLength(1);
      expect(chatCalls).toEqual([]);
    });
  });

  test('requires live confirmation before a fresh cache upgrades a pinned anonymized model', async () => {
    await withCatalogCache(async (cachePath) => {
      const modelId = 'claude-opus-4-7-fast';
      expect(venicePrivacyCategoryForModel(modelId)).toBe('anonymized');
      writeCatalogCache(cachePath, NOW_MS - HOUR_MS, {
        [modelId]: 'private',
        'existing-private-model': 'private',
      });
      const catalogCalls: string[] = [];
      const chatCalls: string[] = [];
      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: modelId,
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          now: () => NOW_MS,
          fetchImpl: catalogFetch(catalogCalls, { [modelId]: 'anonymized' }),
        },
      }));

      await expect(
        analyst.analyze(evidencePack('secure_local', 'S4'), { localOnly: true }),
      ).rejects.toMatchObject({
        code: 'source_index_policy_violation',
        privacyCategory: 'anonymized',
        modelId,
      });
      expect(catalogCalls).toHaveLength(1);
      expect(chatCalls).toEqual([]);
    });
  });

  test('requires live confirmation before a case-variant cache id upgrades a pinned anonymized model', async () => {
    await withCatalogCache(async (cachePath) => {
      const modelId = 'Claude-Opus-4-7-Fast';
      writeCatalogCache(cachePath, NOW_MS - HOUR_MS, {
        [modelId]: 'private',
        'existing-private-model': 'private',
      });
      const catalogCalls: string[] = [];
      const chatCalls: string[] = [];
      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: modelId,
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          now: () => NOW_MS,
          fetchImpl: catalogFetch(catalogCalls, { 'claude-opus-4-7-fast': 'anonymized' }),
        },
      }));

      await expect(
        analyst.analyze(evidencePack('secure_local', 'S4'), { localOnly: true }),
      ).rejects.toMatchObject({
        code: 'source_index_policy_violation',
        privacyCategory: 'anonymized',
      });
      expect(catalogCalls).toHaveLength(1);
      expect(chatCalls).toEqual([]);
    });
  });

  test('accepts a pinned-anonymized id immediately when the live catalog upgrades it to Private', async () => {
    await withCatalogCache(async (cachePath) => {
      const modelId = 'claude-opus-4-7-fast';
      writeCatalogCache(cachePath, NOW_MS - HOUR_MS, {
        [modelId]: 'private',
        'existing-private-model': 'private',
      });
      const catalogCalls: string[] = [];
      const chatCalls: string[] = [];
      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: modelId,
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          now: () => NOW_MS,
          fetchImpl: catalogFetch(catalogCalls, { [modelId]: 'private' }),
        },
      }));

      const result = await analyst.analyze(
        evidencePack('secure_local', 'S4'),
        { localOnly: true },
      );

      expect(result.answer).toBe('category gate passed');
      expect(catalogCalls).toHaveLength(1);
      expect(chatCalls).toHaveLength(1);
    });
  });

  test('cannot suppress the secure-local category gate with localOnly false', async () => {
    await withCatalogCache(async (cachePath) => {
      const modelId = 'claude-opus-4-7-fast';
      const catalogCalls: string[] = [];
      const chatCalls: string[] = [];
      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: modelId,
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          now: () => NOW_MS,
          fetchImpl: catalogFetch(catalogCalls, { [modelId]: 'anonymized' }),
        },
      }));

      await expect(
        analyst.analyze(evidencePack('secure_local', 'S4'), { localOnly: false }),
      ).rejects.toBeInstanceOf(VeniceModelPolicyDeniedError);
      expect(catalogCalls).toHaveLength(1);
      expect(chatCalls).toEqual([]);
    });
  });

  test('allows every category at the Private floor or above from the catalog', async () => {
    const approved: ReadonlyArray<[string, Exclude<VenicePrivacyCategory, 'anonymized'>]> = [
      ['catalog-private-model', 'private'],
      ['catalog-tee-model', 'tee'],
      ['catalog-e2ee-model', 'e2ee'],
    ];
    for (const [modelId, category] of approved) {
      await withCatalogCache(async (cachePath) => {
        writeCatalogCache(cachePath, NOW_MS - HOUR_MS, { [modelId]: category });
        const chatCalls: string[] = [];
        const analyst = createAnalyst(createVeniceAnalystModel({
          apiKey: 'venice-test',
          model: modelId,
          fetchImpl: successfulChatFetch(chatCalls),
          catalog: {
            cachePath,
            now: () => NOW_MS,
            fetchImpl: async () => {
              throw new Error('fresh approved cache must not refresh');
            },
          },
        }));

        const result = await analyst.analyze(evidencePack('secure_local', 'S4'), { localOnly: true });

        expect(result.answer).toBe('category gate passed');
        expect(chatCalls).toHaveLength(1);
      });
    }
  });

  test('refuses a model absent after one refresh of a fresh cached catalog', async () => {
    await withCatalogCache(async (cachePath) => {
      writeCatalogCache(cachePath, NOW_MS - HOUR_MS, { 'existing-private-model': 'private' });
      const catalogCalls: string[] = [];
      const chatCalls: string[] = [];
      const modelId = 'future-unlisted-model';
      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: modelId,
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          now: () => NOW_MS,
          fetchImpl: catalogFetch(catalogCalls, { 'existing-private-model': 'private' }),
        },
      }));

      await expect(
        analyst.analyze(evidencePack('secure_local', 'S4'), { localOnly: true }),
      ).rejects.toMatchObject({
        code: 'source_index_policy_violation',
        privacyCategory: 'unknown',
        modelId,
      });
      expect(catalogCalls).toHaveLength(1);
      expect(chatCalls).toEqual([]);
    });
  });

  test('uses a warm fresh cache without depending on the unreachable catalog', async () => {
    await withCatalogCache(async (cachePath) => {
      const modelId = 'warm-cache-private-model';
      writeCatalogCache(cachePath, NOW_MS - HOUR_MS, { [modelId]: 'private' });
      const catalogCalls: string[] = [];
      const chatCalls: string[] = [];
      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: modelId,
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          now: () => NOW_MS,
          fetchImpl: unreachableCatalogFetch(catalogCalls),
        },
      }));

      const result = await analyst.analyze(evidencePack('secure_local', 'S4'), { localOnly: true });

      expect(result.answer).toBe('category gate passed');
      expect(catalogCalls).toEqual([]);
      expect(chatCalls).toHaveLength(1);
    });
  });

  test('falls back to the pinned snapshot when the catalog is unreachable and cache is stale', async () => {
    await withCatalogCache(async (cachePath) => {
      const modelId = 'qwen3-6-27b';
      // The stale cache deliberately conflicts with the pinned snapshot. It
      // must not remain authoritative after its 24-hour TTL expires.
      writeCatalogCache(cachePath, NOW_MS - (25 * HOUR_MS), { [modelId]: 'anonymized' });
      const catalogCalls: string[] = [];
      const chatCalls: string[] = [];
      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: modelId,
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          now: () => NOW_MS,
          fetchImpl: unreachableCatalogFetch(catalogCalls),
        },
      }));

      const result = await analyst.analyze(evidencePack('secure_local', 'S4'), { localOnly: true });

      expect(result.answer).toBe('category gate passed');
      expect(venicePrivacyCategoryForModel(modelId)).toBe('private');
      expect(catalogCalls).toHaveLength(1);
      expect(chatCalls).toHaveLength(1);
    });
  });

  test('refuses when the catalog is unreachable, cache is stale, and the snapshot has no model', async () => {
    await withCatalogCache(async (cachePath) => {
      const modelId = 'stale-cache-only-private-model';
      writeCatalogCache(cachePath, NOW_MS - (25 * HOUR_MS), { [modelId]: 'private' });
      const catalogCalls: string[] = [];
      const chatCalls: string[] = [];
      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: modelId,
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          now: () => NOW_MS,
          fetchImpl: unreachableCatalogFetch(catalogCalls),
        },
      }));

      await expect(
        analyst.analyze(evidencePack('secure_local', 'S4'), { localOnly: true }),
      ).rejects.toMatchObject({
        code: 'source_index_policy_violation',
        privacyCategory: 'unknown',
        modelId,
      });
      expect(catalogCalls).toHaveLength(1);
      expect(chatCalls).toEqual([]);
    });
  });

  test('rate-limits refresh-on-miss across repeated unknown-model calls', async () => {
    await withCatalogCache(async (cachePath) => {
      writeCatalogCache(cachePath, NOW_MS - HOUR_MS, { 'existing-private-model': 'private' });
      const catalogCalls: string[] = [];
      const chatCalls: string[] = [];
      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: 'repeated-unknown-model',
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          now: () => NOW_MS,
          refreshMinIntervalMs: 5 * 60 * 1_000,
          fetchImpl: catalogFetch(catalogCalls, { 'existing-private-model': 'private' }),
        },
      }));

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          analyst.analyze(evidencePack('secure_local', 'S4'), { localOnly: true }),
        ).rejects.toBeInstanceOf(VeniceModelPolicyDeniedError);
      }
      expect(catalogCalls).toHaveLength(1);
      expect(chatCalls).toEqual([]);
    });
  });

  test('shares a refreshed durable cache across adapters without a second miss refresh', async () => {
    await withCatalogCache(async (cachePath) => {
      writeCatalogCache(cachePath, NOW_MS - HOUR_MS, { 'existing-private-model': 'private' });
      const catalogCalls: string[] = [];
      const firstChatCalls: string[] = [];
      const secondChatCalls: string[] = [];
      const catalog: Record<string, VenicePrivacyCategory> = {
        'first-new-private-model': 'private',
        'second-new-private-model': 'private',
      };
      const catalogOptions = {
        cachePath,
        now: () => NOW_MS,
        refreshMinIntervalMs: 5 * 60 * 1_000,
        fetchImpl: catalogFetch(catalogCalls, catalog),
      };
      // Both adapters intentionally load the old cache before either dispatch.
      const first = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: 'first-new-private-model',
        fetchImpl: successfulChatFetch(firstChatCalls),
        catalog: catalogOptions,
      }));
      const second = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: 'second-new-private-model',
        fetchImpl: successfulChatFetch(secondChatCalls),
        catalog: catalogOptions,
      }));

      await first.analyze(evidencePack('secure_local', 'S4'), { localOnly: true });
      await second.analyze(evidencePack('secure_local', 'S4'), { localOnly: true });

      expect(catalogCalls).toHaveLength(1);
      expect(firstChatCalls).toHaveLength(1);
      expect(secondChatCalls).toHaveLength(1);
    });
  });

  test('bounds an unreachable catalog fetch with an abort signal', async () => {
    await withCatalogCache(async (cachePath) => {
      const modelId = 'qwen3-6-27b';
      let aborted = false;
      const catalogFetchImpl: VeniceModelCatalogFetch = async (_url, init) => new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
      const chatCalls: string[] = [];
      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: modelId,
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          timeoutMs: 5,
          fetchImpl: catalogFetchImpl,
        },
      }));

      const result = await analyst.analyze(evidencePack('secure_local', 'S4'), { localOnly: true });

      expect(result.answer).toBe('category gate passed');
      expect(aborted).toBe(true);
      expect(chatCalls).toHaveLength(1);
    });
  });

  test('keeps S0-S3 packs unrestricted without consulting the catalog', async () => {
    await withCatalogCache(async (cachePath) => {
      const catalogCalls: string[] = [];
      const chatCalls: string[] = [];
      const analyst = createAnalyst(createVeniceAnalystModel({
        apiKey: 'venice-test',
        model: 'future-unlisted-model',
        fetchImpl: successfulChatFetch(chatCalls),
        catalog: {
          cachePath,
          fetchImpl: unreachableCatalogFetch(catalogCalls),
        },
      }));

      const result = await analyst.analyze(evidencePack('internal', 'S3'), { localOnly: false });

      expect(result.answer).toBe('category gate passed');
      expect(catalogCalls).toEqual([]);
      expect(chatCalls).toHaveLength(1);
    });
  });

  test('keeps every alias target covered by the approved offline snapshot', () => {
    const targets = veniceAnalystModelAliasTargets();
    expect(targets.length).toBeGreaterThan(0);
    for (const model of targets) {
      const category = venicePrivacyCategoryForModel(model);
      expect(category, `missing Venice privacy metadata for alias target ${model}`).toBeDefined();
      expect(
        isVenicePrivacyCategoryApprovedForSecureLocal(category!),
        `alias target ${model} resolves below the Private floor`,
      ).toBe(true);
    }
  });

  test('uses a portable XDG cache path with a home-directory fallback', () => {
    expect(defaultVeniceModelCatalogCachePath(
      { XDG_CACHE_HOME: '/var/cache/test-user' },
      '/home/test-user',
    )).toBe('/var/cache/test-user/olympus/venice-model-catalog-v1.json');
    expect(defaultVeniceModelCatalogCachePath({}, '/home/test-user'))
      .toBe('/home/test-user/.cache/olympus/venice-model-catalog-v1.json');
  });
});

function evidencePack(
  trustDomain: 'internal' | 'secure_local',
  trustTier: 'S3' | 'S4',
): EvidencePack {
  return {
    question: 'What does the evidence support?',
    candidates: [{
      provenance: {
        sourceItem: {
          family: 'file',
          provider: 'fixture',
          accountScope: 'test',
          providerItemId: 'item-1',
          localItemId: 'test:item-1',
        },
        citation: { title: 'Category gate fixture' },
      },
      trustTier,
      trustDomain,
      chunks: ['The category gate fixture is supported.'],
    }],
    coverage: {
      searchedCorpora: [`${trustDomain}.test`],
      skippedCorpora: [],
      extractionGaps: [],
    },
    builtAt: '2026-07-21T00:00:00.000Z',
  };
}

function successfulChatFetch(calls: string[]): OpenAIAnalystFetch {
  return async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({
      model: 'venice-test-model',
      choices: [{
        message: {
          content: JSON.stringify({
            answer: 'category gate passed',
            citations: [{ evidence: 1, claim: 'The fixture supports the answer.' }],
            unanswered: [],
            sufficient: true,
          }),
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

function catalogFetch(
  calls: string[],
  models: Record<string, VenicePrivacyCategory>,
): VeniceModelCatalogFetch {
  return async (url) => {
    calls.push(url);
    return catalogResponse(models);
  };
}

function unreachableCatalogFetch(calls: string[]): VeniceModelCatalogFetch {
  return async (url) => {
    calls.push(url);
    throw new Error('catalog unavailable');
  };
}

function catalogResponse(models: Record<string, VenicePrivacyCategory>): Response {
  return new Response(JSON.stringify({
    object: 'list',
    type: 'text',
    data: Object.entries(models).map(([id, privacy]) => ({
      id,
      object: 'model',
      owned_by: 'venice.ai',
      type: 'text',
      model_spec: { privacy },
    })),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function writeCatalogCache(
  cachePath: string,
  fetchedAtMs: number,
  models: Record<string, VenicePrivacyCategory>,
): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify({
    schema_version: 1,
    fetched_at: new Date(fetchedAtMs).toISOString(),
    models,
  }, null, 2)}\n`);
}

async function withCatalogCache(run: (cachePath: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'olympus-venice-catalog-'));
  try {
    await run(join(root, 'cache', 'venice-model-catalog-v1.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

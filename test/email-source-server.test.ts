import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import {
  createCloudSourceIndexEmbeddingProviderFromEnv,
  createSourceIndexEmbeddingProviderFromEnv,
  createSourceIndexEmbeddingProviderFromSovereignty,
  parseConnectorStoreMountsFromEnv,
  parseOptionalTimeoutSeconds,
  parseOptionalTimeoutSecondsOrNone,
  resolveEmailSourceBindHostFromEnv,
  sourceIndexLaneDecision,
} from '../src/workers/email-source/server.ts';

describe('canonical source-worker server configuration', () => {
  test('keeps the worker on loopback by default and honors the canonical host key', () => {
    expect(resolveEmailSourceBindHostFromEnv({})).toBe('127.0.0.1');
    expect(resolveEmailSourceBindHostFromEnv({
      OLYMPUS_EMAIL_SOURCE_HOST: '127.0.0.2',
    })).toBe('127.0.0.2');
  });

  test('builds one local embedding provider with the canonical identity', () => {
    const provider = createSourceIndexEmbeddingProviderFromEnv({
      OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER: 'local-openai-compatible',
      OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL: 'http://127.0.0.1:28090/v1',
      OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL: 'secure-local-qwen3-embed',
      OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY: '2560',
    });

    expect(provider).toMatchObject({
      provider: 'local-openai-compatible',
      modelId: 'secure-local-qwen3-embed',
      backend: 'local',
      dimension: 2560,
      epochId: 'local:openai-compatible:secure-local-qwen3-embed:2560',
    });
  });

  test('registered local defaults give the env and preset factories the existing identity', () => {
    const env = {
      OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER: 'local-openai-compatible',
      OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL: 'http://127.0.0.1:28090/v1',
      OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL: 'secure-local-qwen3-embed',
    };
    const inferred = createSourceIndexEmbeddingProviderFromEnv(env);
    const explicit = createSourceIndexEmbeddingProviderFromEnv({
      ...env, OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY: '2560',
    });
    expect(inferred?.configHash).toBe(explicit?.configHash);
    const preset = createSourceIndexEmbeddingProviderFromSovereignty(
      createSovereigntyEngine(loadSovereigntyPreset('local-only')), 'secure_local', {},
    );
    for (const provider of [inferred, preset]) {
      expect(provider).toMatchObject({
        provider: 'local-openai-compatible', modelId: 'secure-local-qwen3-embed',
        backend: 'local', dimension: 2560,
        epochId: 'local:openai-compatible:secure-local-qwen3-embed:2560',
      });
    }
  });

  test('Gemini factories infer the registered dimension without changing explicit-provider identity', () => {
    const env = {
      GEMINI_API_KEY: 'fixture-key',
      OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER: 'google-gemini',
    };
    const inferred = createSourceIndexEmbeddingProviderFromEnv(env);
    const explicit = createSourceIndexEmbeddingProviderFromEnv({
      ...env, OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY: '3072',
    });
    expect(inferred?.configHash).toBe(explicit?.configHash);
    for (const provider of [inferred, createCloudSourceIndexEmbeddingProviderFromEnv(env)]) {
      expect(provider).toMatchObject({
        provider: 'google-gemini', modelId: 'gemini-embedding-2', backend: 'cloud',
        dimension: 3072, epochId: 'cloud:google-gemini:gemini-embedding-2:provider-reported',
      });
    }
  });

  test('explicit dimensions and per-lane precedence still override registered defaults', () => {
    const env = {
      OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY: 'fixture-key',
      OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_OUTPUT_DIMENSIONALITY: '768',
      OLYMPUS_TEST_EMBEDDING_OUTPUT_DIMENSIONALITY: '1536',
    };
    expect(createCloudSourceIndexEmbeddingProviderFromEnv(env)?.dimension).toBe(768);
    expect(createCloudSourceIndexEmbeddingProviderFromEnv(env, 'OLYMPUS_TEST')?.dimension).toBe(1536);
    expect(createSourceIndexEmbeddingProviderFromSovereignty(
      createSovereigntyEngine(loadSovereigntyPreset('no-sensitive')), 'internal', env,
    )?.dimension).toBe(768);
    expect(createSourceIndexEmbeddingProviderFromSovereignty(
      createSovereigntyEngine(loadSovereigntyPreset('local-only')), 'secure_local',
      { OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY: '1024' },
    )).toMatchObject({ dimension: 1024, epochId: 'local:openai-compatible:secure-local-qwen3-embed:1024' });
  });

  test.each(['invalid', '0', '-1', '1.5', 'Infinity', '9007199254740992'])(
    'an explicit malformed dimension refuses instead of taking the default: %s', (dimension) => {
      expect(() => createCloudSourceIndexEmbeddingProviderFromEnv({
        GEMINI_API_KEY: 'fixture-key',
        OLYMPUS_TEST_EMBEDDING_OUTPUT_DIMENSIONALITY: dimension,
        OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_OUTPUT_DIMENSIONALITY: '3072',
      }, 'OLYMPUS_TEST')).toThrow('OLYMPUS_TEST_EMBEDDING_OUTPUT_DIMENSIONALITY');
    },
  );

  test.each(['', ' '])('blank dimensions retain existing lower-key precedence: %s', (dimension) => {
    expect(createCloudSourceIndexEmbeddingProviderFromEnv({
      GEMINI_API_KEY: 'fixture-key',
      OLYMPUS_TEST_EMBEDDING_OUTPUT_DIMENSIONALITY: dimension,
      OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_OUTPUT_DIMENSIONALITY: '768',
    }, 'OLYMPUS_TEST')?.dimension).toBe(768);
    expect(() => createCloudSourceIndexEmbeddingProviderFromEnv({
      GEMINI_API_KEY: 'fixture-key',
      OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_OUTPUT_DIMENSIONALITY: dimension,
    })).toThrow('positive safe-integer dimension');
  });

  test('an unknown model still needs its own explicit dimension', () => {
    const env = { GEMINI_API_KEY: 'fixture-key', OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_MODEL: 'unknown-embedding-model' };
    expect(() => createCloudSourceIndexEmbeddingProviderFromEnv(env)).toThrow('positive safe-integer dimension');
    expect(createCloudSourceIndexEmbeddingProviderFromEnv({
      ...env, OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_OUTPUT_DIMENSIONALITY: '512',
    })).toMatchObject({ modelId: 'unknown-embedding-model', dimension: 512 });
  });

  test('defaulted dimensions preserve the cloud epoch boundary', () => {
    const localEpoch = 'local:openai-compatible:secure-local-qwen3-embed:2560';
    expect(() => createCloudSourceIndexEmbeddingProviderFromEnv({
      GEMINI_API_KEY: 'fixture-key', OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH: localEpoch,
    })).toThrow('cannot label cloud provider');
    expect(createSourceIndexEmbeddingProviderFromSovereignty(
      createSovereigntyEngine(loadSovereigntyPreset('no-sensitive')), 'internal',
      { OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY: 'fixture-key', OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH: localEpoch },
    )?.epochId).toBe('cloud:google-gemini:gemini-embedding-2:provider-reported');
  });

  test('fails closed for incomplete embedding configuration', () => {
    expect(() => createSourceIndexEmbeddingProviderFromEnv({
      OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER: 'local-openai-compatible',
      OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL: 'secure-local-qwen3-embed',
    })).toThrow('OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL');

    expect(() => parseOptionalTimeoutSeconds('0', 'TIMEOUT')).toThrow('TIMEOUT');
    expect(parseOptionalTimeoutSecondsOrNone('none', 'TIMEOUT')).toBe(0);
  });

  test('mounts only valid declared connector stores and reports invalid entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-server-mounts-'));
    const failures: string[] = [];
    const raw = JSON.stringify([
      {
        dbPath: join(root, 'gmail.sqlite'),
        corpusId: 'internal.gmail.email',
        family: 'email',
        trustDomain: 'internal',
        principalProvider: 'gmail',
        principalAccountScope: 'personal',
      },
      {
        dbPath: 'relative.sqlite',
        corpusId: 'internal.invalid',
        family: 'email',
        trustDomain: 'internal',
      },
    ]);

    const mounts = parseConnectorStoreMountsFromEnv(raw, {
      reportFailure: (message) => failures.push(message),
    });
    try {
      expect(mounts).toHaveLength(1);
      expect(mounts[0]?.store).toMatchObject({
        corpusId: 'internal.gmail.email',
        family: 'email',
        trustDomain: 'internal',
      });
      expect(mounts[0]?.principal).toEqual({
        provider: 'gmail',
        accountScope: 'personal',
      });
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('internal.invalid');
    } finally {
      for (const mount of mounts) mount.store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('makes lane enablement explicit while retaining connected-handle fallback', () => {
    expect(sourceIndexLaneDecision({}, 'OLYMPUS_TEST_LANE_ENABLED', false)).toEqual({
      enabled: false,
      envName: 'OLYMPUS_TEST_LANE_ENABLED',
      decidedBy: 'no connected handle',
    });
    expect(sourceIndexLaneDecision({}, 'OLYMPUS_TEST_LANE_ENABLED', true)).toEqual({
      enabled: true,
      envName: 'OLYMPUS_TEST_LANE_ENABLED',
      decidedBy: 'connected handle fallback',
    });
    expect(sourceIndexLaneDecision({
      OLYMPUS_TEST_LANE_ENABLED: 'false',
    }, 'OLYMPUS_TEST_LANE_ENABLED', true)).toEqual({
      enabled: false,
      envName: 'OLYMPUS_TEST_LANE_ENABLED',
      decidedBy: 'OLYMPUS_TEST_LANE_ENABLED',
    });
  });
});

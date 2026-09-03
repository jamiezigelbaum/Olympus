import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  createSourceIndexEmbeddingProviderFromEnv,
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

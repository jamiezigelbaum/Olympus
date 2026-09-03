// An owner-supplied analyst_provider hint is a preference, not a policy.
// Requesting a lane the domain's approved pool does not contain must not fail
// the whole question when a MORE trusted approved lane is available; it must
// still fail closed when honouring it would mean a downgrade.

import { describe, expect, test } from 'bun:test';
import {
  createSovereigntyEngine,
  type SovereigntyConfig,
} from '../src/core/sovereignty.ts';

function config(overrides: Partial<SovereigntyConfig> = {}): SovereigntyConfig {
  return {
    schemaVersion: 1,
    modelProfiles: {
      local: {
        provider: 'local-openai-compatible',
        trust: 'local',
        baseUrl: 'http://127.0.0.1:8000/v1',
        model: 'local-model',
        purpose: 'analyst',
      },
      cloud: {
        provider: 'openclaw-infer',
        trust: 'standard_cloud',
        model: 'openai/gpt-5.5',
        purpose: 'analyst',
      },
      venice: {
        provider: 'venice',
        trust: 'encrypted_cloud',
        model: 'kimi-k3',
        secretRef: 'env:VENICE_API_KEY',
        purpose: 'analyst',
      },
      ...(overrides.modelProfiles ?? {}),
    },
    routes: overrides.routes ?? {
      secure_local: { pool: { members: ['local', 'venice'] } },
      internal: { analyst: ['cloud', 'local'] },
      public_safe: { analyst: ['cloud', 'local'] },
    },
    retrieval: overrides.retrieval ?? {
      trustDomains: {
        secure_local: {
          minimumExecutionTrust: 'local',
          allowedEmbeddingTrust: ['local'],
          embeddingProfile: null,
          allowCloudQuery: false,
        },
        internal: {
          minimumExecutionTrust: 'standard_cloud',
          allowedEmbeddingTrust: ['local', 'standard_cloud'],
          embeddingProfile: null,
          allowCloudQuery: true,
        },
        public_safe: {
          minimumExecutionTrust: 'standard_cloud',
          allowedEmbeddingTrust: ['local', 'standard_cloud'],
          embeddingProfile: null,
          allowCloudQuery: true,
        },
      },
    },
  };
}

describe('sovereignty requested analyst provider', () => {
  test('a venice request on a domain without a venice lane runs on the more trusted member', () => {
    const engine = createSovereigntyEngine(config());

    const pool = engine.resolveAnalystPool({ trustDomain: 'internal', requestedProvider: 'venice' });

    // Never the standard-cloud member: substituting downward is the downgrade
    // the config_error exists to prevent.
    expect(pool.members.map((member) => member.id)).toEqual(['local']);
  });

  test('a cloud request on a local-only domain runs local instead of failing the question', () => {
    const engine = createSovereigntyEngine(config({
      routes: {
        secure_local: { pool: { members: ['local'] } },
        internal: { analyst: ['local'] },
        public_safe: { analyst: ['local'] },
      },
    }));

    expect(engine.resolveAnalystRoute({ trustDomain: 'internal', requestedProvider: 'cloud' })
      .map((member) => member.id)).toEqual(['local']);
  });

  test('a local request still fails closed when only less trusted lanes are approved', () => {
    const engine = createSovereigntyEngine(config({
      routes: {
        secure_local: { pool: { members: ['venice'] } },
        internal: { analyst: ['venice'] },
        public_safe: { analyst: ['cloud'] },
      },
    }));

    expect(() => engine.resolveAnalystPool({
      trustDomain: 'secure_local',
      requestedProvider: 'local',
    })).toThrow(expect.objectContaining({
      code: 'config_error',
      message: expect.stringContaining('has no approved local profile'),
    }));
  });

  test('an exact match still wins over any substitution', () => {
    const engine = createSovereigntyEngine(config());

    expect(engine.resolveAnalystPool({ trustDomain: 'secure_local', requestedProvider: 'venice' })
      .members.map((member) => member.id)).toEqual(['venice']);
    expect(engine.resolveAnalystPool({ trustDomain: 'internal', requestedProvider: 'cloud' })
      .members.map((member) => member.id)).toEqual(['cloud']);
  });

  test('a local analyst profile without a baseUrl is rejected at validation', () => {
    expect(() => createSovereigntyEngine(config({
      modelProfiles: {
        local: {
          provider: 'local-openai-compatible',
          trust: 'local',
          model: 'local-model',
          purpose: 'analyst',
        },
      },
    }))).toThrow(expect.objectContaining({
      code: 'config_error',
      message: expect.stringContaining('requires a loopback baseUrl'),
    }));
  });
});

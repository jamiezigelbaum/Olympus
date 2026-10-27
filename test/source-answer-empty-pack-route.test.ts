// A source_answer whose pack holds nothing answers "no matching evidence"; it
// never fails on a missing analyst route.
//
// Every shipped preset has no Public tier, so there is no public_safe route.
// The worker used to send a pack with no Personal candidate to public_safe,
// which made an ordinary miss (or a question whose only matches were Private
// under no-sensitive, where Private is not searched) a config_error. These
// tests drive the packaged presets through the worker's real route selection.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { Analyst } from '../src/core/contracts.ts';
import { createAnalyst } from '../src/core/analyst.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import type { SourceIndexRouterAdapterMap } from '../src/core/source-index/router.ts';
import { buildSourceSensitivity, type SourceTrustDomain } from '../src/core/source-index/types.ts';
import { createSovereigntyEngine, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import {
  analystRouteTrustDomain,
  secureLocalAnalystRouteStatus,
  sovereigntyAnalystRoutePlan,
} from '../src/workers/email-source/server.ts';
import {
  createAnalystSourceIndexAnswerHandler,
  type SovereigntyAnalystRouteStep,
} from '../src/workers/source-index/analyst-answer.ts';

const INTERNAL = 'internal.dropbox.files';
const SECURE = 'secure_local.dropbox.files';

type Preset = 'no-sensitive' | 'local-only' | 'local-first' | 'private-cloud-only';

function presetConfig(preset: Preset): SovereigntyConfig {
  return JSON.parse(readFileSync(
    join(import.meta.dir, '..', 'config', 'sovereignty', 'presets', `${preset}.json`),
    'utf8',
  )) as SovereigntyConfig;
}

function answerWorld(preset: Preset, matches: { internal: number; secure: number }) {
  const engine = createSovereigntyEngine(presetConfig(preset));
  const modelCalls: string[] = [];
  const analysts = new Map<string, SovereigntyAnalystRouteStep>();
  for (const [id, profile] of Object.entries(engine.config.modelProfiles)) {
    if (profile.purpose !== 'analyst') continue;
    // The real Analyst around a model that records any call: an empty pack
    // must never reach it.
    const analyst: Analyst = createAnalyst({
      async complete() {
        modelCalls.push(id);
        throw new Error('the model must not be called for an empty pack');
      },
    } as never);
    analysts.set(id, { profile: { id, profile }, backend: profile.trust === 'local' ? 'local' : 'cloud', analyst });
  }
  const registry = buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({ corpusId: INTERNAL, family: 'file', trustDomain: 'internal' }),
    defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
  ]);
  const adapter = (count: number, prefix: string) => () => ({
    hits: Array.from({ length: count }, (_, index) => {
      const sourceItem = {
        family: 'file' as const,
        provider: 'dropbox',
        accountScope: 'personal',
        providerItemId: `${prefix}${index}`,
        localItemId: `personal:${prefix}${index}`,
      };
      return { sourceItem, provenance: { sourceItem, citation: { title: `${prefix}${index}.pdf` } }, score: 1, rawExposed: false as const };
    }),
    latencyMs: 1,
    rawExposed: false as const,
  });
  const provider = (trustDomain: SourceTrustDomain) => ({
    async fetchLocalContent() {
      return {
        sensitivity: buildSourceSensitivity({ trustTier: trustDomain === 'secure_local' ? 'S4' : 'S2', trustDomain }),
        chunks: ['text'],
      };
    },
  });
  const handler = createAnalystSourceIndexAnswerHandler({
    analyst: createAnalyst({ async complete() { throw new Error('unused'); } } as never),
    lanes: () => ({
      registry,
      adapters: { [INTERNAL]: adapter(matches.internal, 'n'), [SECURE]: adapter(matches.secure, 's') } as SourceIndexRouterAdapterMap,
      contentProviders: { [INTERNAL]: provider('internal'), [SECURE]: provider('secure_local') } as never,
    }),
    sovereigntyAnalystRoute: ({ pack, localOnly, requestedProvider }) => {
      const trustDomain = analystRouteTrustDomain(pack, localOnly);
      return sovereigntyAnalystRoutePlan({
        trustDomain,
        pool: engine.resolveAnalystPool({ trustDomain, requestedProvider }),
        analysts,
      });
    },
    secureLocalAnalystRoute: ({ requestedProvider }) => secureLocalAnalystRouteStatus({ engine, analysts, requestedProvider }),
  });
  return { handler, modelCalls };
}

describe('source_answer with an empty pack', () => {
  for (const preset of ['no-sensitive', 'local-only', 'local-first', 'private-cloud-only'] as const) {
    test(`${preset}: no matches answers "no matching evidence" without a model call`, async () => {
      const world = answerWorld(preset, { internal: 0, secure: 0 });
      const result = await world.handler.answer({ question: 'What does my lease say about the deposit?' });
      expect(result.answer).toContain('no matching evidence');
      expect(world.modelCalls).toEqual([]);
    });
  }

  test('no-sensitive: matches that are all Private (not searched here) answer the same way', async () => {
    const world = answerWorld('no-sensitive', { internal: 0, secure: 2 });
    const result = await world.handler.answer({ question: 'What does my lease say about the deposit?' });
    expect(result.audit.searched_corpora).not.toContain(SECURE);
    expect(result.audit.skipped_corpora).toContainEqual({
      corpus_id: SECURE,
      trust_domain: 'secure_local',
      reason: 'no_private_analyst_route',
    });
    expect(result.answer).toContain('Private sources were not searched');
    expect(world.modelCalls).toEqual([]);
  });
});

describe('analystRouteTrustDomain', () => {
  const candidate = (trustDomain: SourceTrustDomain) => ({ trustDomain, trustTier: 'S2' as const });
  test('an empty pack takes the Personal route, never the retired Public one', () => {
    expect(analystRouteTrustDomain({ candidates: [] }, false)).toBe('internal');
  });
  test('Public only when the pack holds Public candidates and no Personal one', () => {
    expect(analystRouteTrustDomain({ candidates: [candidate('public_safe')] }, false)).toBe('public_safe');
    expect(analystRouteTrustDomain({ candidates: [candidate('public_safe'), candidate('internal')] }, false)).toBe('internal');
  });
  test('Private stays Private', () => {
    expect(analystRouteTrustDomain({ candidates: [candidate('internal')] }, true)).toBe('secure_local');
  });
});

// The handler bounds every analyst leg it dispatches — except, before this,
// the ordinary-cloud one. `local-first` routes internal/public_safe questions
// to cloud-openclaw-infer FIRST, so the unbounded leg was the one on the live
// path: the handler could not interrupt it, no abort context reached the
// client, and the trace reported the leg as budget_ms 0 while a transport
// default was silently in force.

import { expect, test } from 'bun:test';
import type { Analyst, AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import { currentAnalystAbortSignal } from '../src/core/analyst.ts';
import type { LocalContentProviderMap } from '../src/core/evidence-pack.ts';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';
import type {
  SourceIndexCorpusSearchAdapter,
  SourceIndexRouterAdapterMap,
} from '../src/core/source-index/router.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { createAnalystSourceIndexAnswerHandler } from '../src/workers/source-index/analyst-answer.ts';

const CORPUS = 'internal.fake.docs';
const ACCOUNT = 'personal';

test('a sovereignty cloud leg is bounded and falls back to local', async () => {
  const local = scriptedAnalyst('LOCAL answer.');
  const handler = createAnalystSourceIndexAnswerHandler({
    analyst: local.analyst,
    lanes: () => lanesFixture(),
    cloudAnalystTimeoutMs: 25,
    sovereigntyAnalystRoute: () => [
      cloudStep(slowAnalyst('CLOUD answer.', 400)),
      localStep(local.analyst),
    ],
  });

  const result = await handler.answer({ question: 'what did the retro decide?' });

  expect(result.answer).toContain('LOCAL answer.');
  expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
  expect(result.audit.answer_synthesis.analyst_fallback).toMatchObject({
    from: 'cloud',
    to: 'local',
    reason: 'timeout',
  });
});

test('a bounded cloud leg gives the client an abort signal to honour', async () => {
  let signalSeen: boolean | undefined;
  const local = scriptedAnalyst('LOCAL answer.');
  const handler = createAnalystSourceIndexAnswerHandler({
    analyst: local.analyst,
    lanes: () => lanesFixture(),
    cloudAnalystTimeoutMs: 5_000,
    sovereigntyAnalystRoute: () => [
      cloudStep({
        async analyze(pack: EvidencePack): Promise<AnalystResult> {
          signalSeen = currentAnalystAbortSignal() !== undefined;
          return {
            answer: 'CLOUD answer.',
            citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'claim' }],
            unanswered: [],
          };
        },
      }),
      localStep(local.analyst),
    ],
  });

  const result = await handler.answer({ question: 'what did the retro decide?' });

  expect(signalSeen).toBe(true);
  expect(result.audit.answer_synthesis.analyst_backend).toBe('cloud');
});

function cloudStep(analyst: Analyst) {
  return {
    profile: {
      id: 'cloud-openclaw-infer',
      profile: {
        provider: 'openclaw-infer' as const,
        trust: 'standard_cloud' as const,
        model: 'gpt-5.5',
        purpose: 'analyst' as const,
      },
    },
    backend: 'cloud' as const,
    analyst,
  };
}

function localStep(analyst: Analyst) {
  return {
    profile: {
      id: 'local-source-answer',
      profile: {
        provider: 'local-openai-compatible' as const,
        trust: 'local' as const,
        model: 'local-model',
        purpose: 'analyst' as const,
      },
    },
    backend: 'local' as const,
    analyst,
  };
}

function slowAnalyst(answer: string, delayMs: number): Analyst {
  return {
    async analyze(pack: EvidencePack): Promise<AnalystResult> {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        answer,
        citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'claim' }],
        unanswered: [],
      };
    },
  };
}

function scriptedAnalyst(answer: string): { analyst: Analyst; calls: number } {
  const state = { analyst: undefined as unknown as Analyst, calls: 0 };
  state.analyst = {
    async analyze(pack: EvidencePack): Promise<AnalystResult> {
      state.calls += 1;
      return {
        answer,
        citations: pack.candidates.length > 0
          ? [{ provenance: pack.candidates[0]!.provenance, claim: 'claim' }]
          : [],
        unanswered: [],
      };
    },
  };
  return state;
}

function identityFor(id: string) {
  return {
    family: 'file' as const,
    provider: 'fake',
    accountScope: ACCOUNT,
    providerItemId: id,
    providerFileId: id,
    localItemId: `${ACCOUNT}:${id}`,
  };
}

function lanesFixture() {
  const adapter: SourceIndexCorpusSearchAdapter = (request) => ({
    hits: ['doc-1'].slice(0, request.maxResults).map((id) => ({
      sourceItem: identityFor(id),
      provenance: { sourceItem: identityFor(id), citation: { title: `${id}.md` } },
      score: 1,
      rawExposed: false as const,
    })),
    latencyMs: 1,
    rawExposed: false as const,
  });
  return {
    registry: buildSourceIndexCorpusRegistry([
      defineSourceIndexCorpus({ corpusId: CORPUS, family: 'file', trustDomain: 'internal' }),
    ]),
    adapters: { [CORPUS]: adapter } as SourceIndexRouterAdapterMap,
    contentProviders: {
      [CORPUS]: {
        async fetchLocalContent() {
          return {
            sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
            chunks: ['bounded evidence text'],
          };
        },
      },
    } as LocalContentProviderMap,
  };
}

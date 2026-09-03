// Cloud analyst routing + THE HARD MEMBRANE.
//
// The handler routes INTERNAL/PUBLIC-tier packs to the frontier cloud analyst
// and keeps any pack containing a secure_local candidate away from ordinary
// cloud. Secure-local packs use local Argus by default, may use explicitly
// approved Venice, and refuse an explicit standard-cloud constraint. These tests prove, with scripted local
// and provider analysts plus a call spy:
//   (a) a pure-internal pack uses the CLOUD analyst;
//   (b) a pack with ONE secure_local candidate uses the LOCAL analyst and the
//       cloud analyst is NEVER called (the membrane — zero cloud calls);
//   (c) a cloud failure falls back to local and the answer is still returned;
//   (d) the analyst_backend audit indicator reflects which lane served.
//
// Fixtures mirror test/analyst-source-answer.test.ts (lanesFixture).

import { describe, expect, test } from 'bun:test';
import { OperationError } from '../src/core/operation-error.ts';
import type { Analyst, AnalystOptions, AnalystResult, EvidencePack } from '../src/core/contracts.ts';
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

const INTERNAL = 'internal.notes.docs';
const SECURE = 'secure_local.dropbox.files';
const INTERNAL_SECRET = 'INTERNAL-RAW-CHUNK-TEXT cholesterol LDL 100 mg/dL';
const SECURE_SECRET = 'SECURE-RAW-CHUNK-TEXT total testosterone 612 ng/dL';

function adapterReturning(ids: string[]): SourceIndexCorpusSearchAdapter {
  return () => ({
    hits: ids.map((id, index) => ({
      sourceItem: { family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: id, providerFileId: id, localItemId: id },
      provenance: {
        sourceItem: { family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: id, providerFileId: id, localItemId: id },
        citation: { title: `${id}.pdf`, uri: `/files/${id}.pdf` },
      },
      score: 1 - index * 0.1,
      rawExposed: false as const,
    })),
    latencyMs: 1,
    laneAudits: [{
      laneName: `${ids[0]}-keyword`,
      laneType: 'keyword' as const,
      candidateCount: ids.length,
      returnedCount: ids.length,
      localOnly: true,
      rawExposed: false,
    }],
    rawExposed: false as const,
  });
}

function lanesFixture(input: { internal?: string[]; secure?: string[] }) {
  const registry = buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({ corpusId: INTERNAL, family: 'file', trustDomain: 'internal' }),
    defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
  ]);
  const adapters: Record<string, SourceIndexCorpusSearchAdapter> = {};
  if (input.internal) adapters[INTERNAL] = adapterReturning(input.internal);
  if (input.secure) adapters[SECURE] = adapterReturning(input.secure);
  const contentProviders = {
    [INTERNAL]: {
      async fetchLocalContent() {
        return {
          sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
          chunks: [INTERNAL_SECRET],
        };
      },
    },
    [SECURE]: {
      async fetchLocalContent() {
        return {
          sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
          chunks: [SECURE_SECRET],
        };
      },
    },
  };
  return {
    registry,
    adapters: adapters as SourceIndexRouterAdapterMap,
    contentProviders: contentProviders as LocalContentProviderMap,
  };
}

interface ScriptedCall {
  pack: EvidencePack;
  options: AnalystOptions;
}

// A labeled scripted analyst whose answer text identifies the lane, plus a call
// spy so tests can assert exactly which analyst was (and was not) invoked.
function scriptedAnalyst(
  label: string,
  respond: (pack: EvidencePack) => AnalystResult,
): { analyst: Analyst; calls: ScriptedCall[]; label: string } {
  const calls: ScriptedCall[] = [];
  return {
    label,
    calls,
    analyst: {
      async analyze(pack, options) {
        calls.push({ pack, options });
        return respond(pack);
      },
    },
  };
}

function citingFirstCandidate(answer: string, claim: string) {
  return (pack: EvidencePack): AnalystResult => ({
    answer,
    citations: pack.candidates.length > 0
      ? [{ provenance: pack.candidates[0]!.provenance, claim }]
      : [],
    unanswered: [],
  });
}

function throwingAnalyst(label: string, error: Error = new Error('cloud lane is down')): { analyst: Analyst; calls: ScriptedCall[]; label: string } {
  const calls: ScriptedCall[] = [];
  return {
    label,
    calls,
    analyst: {
      async analyze(pack, options) {
        calls.push({ pack, options });
        throw error;
      },
    },
  };
}

describe('cloud analyst routing', () => {
  test('(a) a pure-internal pack uses the CLOUD analyst', async () => {
    const local = scriptedAnalyst('local', citingFirstCandidate('LOCAL answer.', 'local claim'));
    const cloud = scriptedAnalyst('cloud', citingFirstCandidate('CLOUD answer.', 'cloud claim'));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      cloudAnalyst: cloud.analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'] }),
    });

    const result = await handler.answer({ question: 'What do my notes say?' });

    expect(cloud.calls).toHaveLength(1);
    expect(local.calls).toHaveLength(0);
    expect(cloud.calls[0]!.options.localOnly).toBe(false);
    expect(result.answer).toContain('CLOUD answer');
    expect(result.audit.answer_synthesis.analyst_backend).toBe('cloud');
  });

  test('(b) THE MEMBRANE: one secure_local candidate -> LOCAL analyst, cloud NEVER called', async () => {
    const local = scriptedAnalyst('local', citingFirstCandidate('LOCAL answer.', 'local claim'));
    const cloud = scriptedAnalyst('cloud', citingFirstCandidate('CLOUD answer.', 'cloud claim'));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      cloudAnalyst: cloud.analyst,
      // Pack carries BOTH an internal and a secure_local candidate: the presence
      // of ANY secure_local candidate forces the whole pack local.
      lanes: () => lanesFixture({ internal: ['doc-1'], secure: ['lab-1'] }),
    });

    const result = await handler.answer({
      question: 'Latest testosterone?',
      include_secure_local_content: true,
    });

    // The membrane assertion: the cloud analyst received ZERO calls.
    expect(cloud.calls).toHaveLength(0);
    expect(local.calls).toHaveLength(1);
    expect(local.calls[0]!.options.localOnly).toBe(true);
    expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
    // And no raw secure chunk text ever crossed into the result.
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('default secure_local packs use LOCAL even when Venice is available for explicit escalation', async () => {
    const local = scriptedAnalyst('local', citingFirstCandidate('LOCAL answer.', 'local claim'));
    const venice = scriptedAnalyst('venice', citingFirstCandidate('VENICE S4 answer.', 'venice claim'));
    const cloud = scriptedAnalyst('cloud', citingFirstCandidate('CLOUD answer.', 'cloud claim'));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      cloudAnalyst: cloud.analyst,
      veniceAnalyst: () => venice.analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({
      question: 'Latest testosterone?',
      include_secure_local_content: true,
    });

    expect(local.calls).toHaveLength(1);
    expect(local.calls[0]!.options.localOnly).toBe(true);
    expect(venice.calls).toHaveLength(0);
    expect(cloud.calls).toHaveLength(0);
    expect(result.answer).toContain('LOCAL answer');
    expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('an explicit Venice request can serve internal packs instead of the default cloud analyst', async () => {
    const local = scriptedAnalyst('local', citingFirstCandidate('LOCAL answer.', 'local claim'));
    const venice = scriptedAnalyst('venice', citingFirstCandidate('VENICE internal answer.', 'venice claim'));
    const cloud = scriptedAnalyst('cloud', citingFirstCandidate('CLOUD answer.', 'cloud claim'));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      cloudAnalyst: cloud.analyst,
      veniceAnalyst: () => venice.analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'] }),
    });

    const result = await handler.answer({
      question: 'What do my notes say?',
      analyst_provider: 'venice',
      analyst_model: 'venice-custom-model',
    });

    expect(venice.calls).toHaveLength(1);
    expect(cloud.calls).toHaveLength(0);
    expect(local.calls).toHaveLength(0);
    expect(result.answer).toContain('VENICE internal answer');
    expect(result.audit.answer_synthesis.analyst_backend).toBe('venice');
    expect(result.audit.answer_synthesis.requested_analyst_provider).toBe('venice');
    expect(result.audit.answer_synthesis.requested_analyst_model).toBe('venice-custom-model');
  });

  test('providing an analyst model without a provider implies Venice', async () => {
    const local = scriptedAnalyst('local', citingFirstCandidate('LOCAL answer.', 'local claim'));
    const venice = scriptedAnalyst('venice', citingFirstCandidate('VENICE model answer.', 'venice claim'));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      veniceAnalyst: () => venice.analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'] }),
    });

    const result = await handler.answer({
      question: 'What do my notes say?',
      analyst_model: 'zai-org-glm-5-1',
    });

    expect(venice.calls).toHaveLength(1);
    expect(local.calls).toHaveLength(0);
    expect(result.audit.answer_synthesis.analyst_backend).toBe('venice');
    expect(result.audit.answer_synthesis.requested_analyst_provider).toBe('venice');
    expect(result.audit.answer_synthesis.requested_analyst_model).toBe('zai-org-glm-5-1');
  });

  test('explicit Venice over secure_local dispatches Venice and falls back local on failure', async () => {
    // OWNER DECISION (2026-07-02): venice is the approved private cloud for
    // secure_local. A failing venice attempt falls back to local Argus;
    // ordinary cloud is never dispatched for secure packs.
    const local = scriptedAnalyst('local', citingFirstCandidate('LOCAL S4 fallback.', 'local claim'));
    const venice = throwingAnalyst('venice');
    const cloud = scriptedAnalyst('cloud', citingFirstCandidate('CLOUD answer.', 'cloud claim'));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      cloudAnalyst: cloud.analyst,
      veniceAnalyst: () => venice.analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    const result = await handler.answer({
      question: 'Latest testosterone?',
      analyst_provider: 'venice',
      include_secure_local_content: true,
    });

    expect(venice.calls).toHaveLength(1);
    expect(local.calls).toHaveLength(1);
    expect(cloud.calls).toHaveLength(0);
    expect(result.answer).toContain('LOCAL S4 fallback');
    expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
    expect(result.audit.answer_synthesis.analyst_fallback).toMatchObject({
      from: 'venice',
      to: 'local',
    });
  });

  test('(c) a cloud HTTP failure falls back to LOCAL with a sanitized status label', async () => {
    const local = scriptedAnalyst('local', citingFirstCandidate('LOCAL fallback answer.', 'local claim'));
    const cloud = throwingAnalyst(
      'cloud',
      new OperationError('source_index_error', 'Cloud analyst (gpt-5.5) returned HTTP 429.'),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      cloudAnalyst: cloud.analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'] }),
    });

    const result = await handler.answer({ question: 'What do my notes say?' });

    // Cloud was attempted (and threw); local served the answer.
    expect(cloud.calls).toHaveLength(1);
    expect(local.calls).toHaveLength(1);
    expect(result.answer).toContain('LOCAL fallback answer');
    expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
    expect(result.audit.answer_synthesis.analyst_fallback).toMatchObject({
      from: 'cloud',
      to: 'local',
      reason: 'cloud_http_429',
    });
    expect(result.audit.answer_synthesis.analyst_fallback?.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  test('provider empty-content failures propagate a sanitized fallback label', async () => {
    const local = scriptedAnalyst('local', citingFirstCandidate('LOCAL S4 fallback.', 'local claim'));
    const venice = throwingAnalyst(
      'venice',
      new OperationError(
        'source_index_error',
        'Venice analyst (e2ee-glm-5-2-p) completion budget exhausted during reasoning (finish_reason=length); response did not include final message content.',
      ),
    );
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      veniceAnalyst: () => venice.analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'] }),
    });

    const result = await handler.answer({
      question: 'Use Venice to analyze my internal notes.',
      analyst_provider: 'venice',
    });

    expect(venice.calls).toHaveLength(1);
    expect(local.calls).toHaveLength(1);
    expect(result.audit.answer_synthesis.analyst_fallback).toMatchObject({
      from: 'venice',
      to: 'local',
      reason: 'venice_empty_content',
    });
    expect(JSON.stringify(result.audit.answer_synthesis.analyst_fallback)).not.toContain('finish_reason');
    expect(JSON.stringify(result.audit.answer_synthesis.analyst_fallback)).not.toContain('e2ee-glm');
  });

  test('explicit ordinary cloud request for secure-local evidence is refused without fallback', async () => {
    const local = scriptedAnalyst('local', citingFirstCandidate('LOCAL secure answer.', 'local secure claim'));
    const cloud = scriptedAnalyst('cloud', citingFirstCandidate('CLOUD answer.', 'cloud claim'));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      cloudAnalyst: cloud.analyst,
      lanes: () => lanesFixture({ secure: ['lab-1'] }),
    });

    let refusal: unknown;
    try {
      await handler.answer({
        question: 'What does the S4 file say?',
        analyst_provider: 'cloud',
        include_secure_local_content: true,
      });
    } catch (error) {
      refusal = error;
    }

    expect(cloud.calls).toHaveLength(0);
    expect(local.calls).toHaveLength(0);
    expect(refusal).toBeInstanceOf(OperationError);
    expect(refusal).toMatchObject({
      code: 'source_index_policy_violation',
    });
    expect((refusal as OperationError).toJSON()).toEqual({
      error: 'source_index_policy_violation',
      message: 'The explicitly requested standard-cloud analyst is not eligible for secure-local evidence.',
      suggestion: 'Use the default secure route, local, or an approved Venice analyst for secure-local evidence.',
    });
  });

  test('(d) without a cloud analyst configured, behavior is local-only (unchanged)', async () => {
    const local = scriptedAnalyst('local', citingFirstCandidate('LOCAL answer.', 'local claim'));
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'] }),
    });

    const result = await handler.answer({ question: 'What do my notes say?' });

    expect(local.calls).toHaveLength(1);
    expect(result.answer).toContain('LOCAL answer');
    expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
  });
});

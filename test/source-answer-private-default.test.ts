// Private material is searched by default when policy approves Argus for it.
//
// source_answer used to leave secure_local out unless the caller opted in, so
// an ordinary question never saw private material at all. Now a request that
// does not decide include_secure_local searches secure_local whenever the
// active sovereignty policy approves a private analyst route (Venice Private
// or a local model, per preset), and that evidence is answered only through
// that route. These tests drive the real packaged presets through the same
// route resolution the worker uses.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { Analyst, AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import type { LocalContentProviderMap } from '../src/core/evidence-pack.ts';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';
import type { SourceIndexRouterAdapterMap } from '../src/core/source-index/router.ts';
import { buildSourceSensitivity, type SourceTrustDomain } from '../src/core/source-index/types.ts';
import { createSovereigntyEngine, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import {
  secureLocalAnalystRouteStatus,
  sovereigntyAnalystRoutePlan,
} from '../src/workers/email-source/server.ts';
import {
  createAnalystSourceIndexAnswerHandler,
  type SovereigntyAnalystRouteStep,
} from '../src/workers/source-index/analyst-answer.ts';
import type { AnalystBackend } from '../src/workers/source-index/answer-types.ts';

const INTERNAL = 'internal.notes.docs';
const SECURE = 'secure_local.dropbox.files';
const SECURE_RAW = 'SECURE-RAW-CHUNK-TEXT LDL 92 mg/dL on 2026-08-01';
const INTERNAL_RAW = 'Reading group notes mention the LDL question.';

type Preset = 'private-cloud-only' | 'local-only' | 'local-first' | 'no-sensitive';

describe('source_answer searches private material by default through Argus', () => {
  test('private-cloud-only: secure_local is searched and answered only by Venice Private; the caller gets a derived answer', async () => {
    const world = answerWorld('private-cloud-only');
    const result = await world.handler.answer({ question: 'What was my LDL?' });

    expect(result.audit.searched_corpora).toContain(SECURE);
    expect(result.audit.answer_synthesis.secure_local_items_consulted).toBeGreaterThan(0);
    expect(result.audit.answer_synthesis.analyst_backend).toBe('venice');
    expect(world.calls['venice-private']).toHaveLength(1);
    expect(world.calls['venice-private']![0]!.candidates.some((c) => c.trustDomain === 'secure_local')).toBe(true);
    // The standard-cloud analyst never sees a pack with secure evidence.
    expect(world.calls['cloud-openclaw-infer']).toHaveLength(0);
    expect(result.opsec.release_decision.decision).toBe('allow');
    expect(result.policy.raw_source_exposed).toBe(false);
    expect(result.policy.source_packets_exposed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
    expect(result.answer).toContain('92 mg/dL');
  });

  test('local presets answer default secure evidence on the local model', async () => {
    for (const preset of ['local-only', 'local-first'] as const) {
      const world = answerWorld(preset);
      const result = await world.handler.answer({ question: 'What was my LDL?' });
      expect({ preset, searched: result.audit.searched_corpora.includes(SECURE) }).toEqual({ preset, searched: true });
      expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
      expect(world.calls['local-source-answer']).toHaveLength(1);
      expect(world.calls['cloud-openclaw-infer']).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
    }
  });

  test('no-sensitive: secure_local stays out and the coverage notes say why', async () => {
    const world = answerWorld('no-sensitive');
    const result = await world.handler.answer({ question: 'What was my LDL?' });

    expect(result.audit.searched_corpora).not.toContain(SECURE);
    expect(result.audit.skipped_corpora).toContainEqual({
      corpus_id: SECURE,
      trust_domain: 'secure_local',
      reason: 'no_private_analyst_route',
    });
    expect(result.audit.answer_synthesis.secure_local_items_consulted).toBe(0);
    expect(result.audit.answer_synthesis.analyst_backend).toBe('cloud');
    expect(world.calls['cloud-openclaw-infer']![0]!.coverage.skippedCorpora)
      .toContainEqual({ corpusId: SECURE, reason: 'no_private_analyst_route' });
    expect(result.answer).toContain(
      `Private sources were not searched (${SECURE}): the active sovereignty policy approves no private analyst`,
    );
  });

  test('a private route whose credential did not resolve is not an approved route', async () => {
    const world = answerWorld('private-cloud-only', { omitProfiles: ['venice-private'] });
    const result = await world.handler.answer({ question: 'What was my LDL?' });
    expect(result.audit.searched_corpora).not.toContain(SECURE);
    expect(result.audit.skipped_corpora.find((skip) => skip.corpus_id === SECURE)?.reason)
      .toBe('no_private_analyst_route');
  });

  test('include_secure_local: false still opts out, with no private-route note', async () => {
    const world = answerWorld('private-cloud-only');
    const result = await world.handler.answer({ question: 'What was my LDL?', include_secure_local: false });
    expect(result.audit.searched_corpora).not.toContain(SECURE);
    expect(result.audit.skipped_corpora.find((skip) => skip.corpus_id === SECURE)?.reason)
      .toBe('trust_domain_not_allowed');
    expect(result.audit.answer_synthesis.analyst_backend).toBe('cloud');
    expect(world.calls['venice-private']).toHaveLength(0);
    expect(result.answer).not.toContain('Private sources were not searched');
  });

  test('an explicit standard-cloud analyst request leaves secure_local out instead of failing', async () => {
    const world = answerWorld('private-cloud-only');
    const result = await world.handler.answer({ question: 'What was my LDL?', analyst_provider: 'cloud' });
    expect(result.audit.searched_corpora).not.toContain(SECURE);
    expect(result.audit.skipped_corpora.find((skip) => skip.corpus_id === SECURE)?.reason)
      .toBe('no_private_analyst_route');
    expect(result.audit.answer_synthesis.analyst_backend).toBe('cloud');
    expect(world.calls['venice-private']).toHaveLength(0);
  });

  test('the bulk release approval gate is unchanged for an explicit private request', async () => {
    const world = answerWorld('private-cloud-only');
    const result = await world.handler.answer({
      question: 'Export all of my lab records with the full text.',
      include_secure_local: true,
    });
    expect(result.opsec.release_decision.decision).toBe('needs_approval');
    expect(result.opsec.release_decision.required_approval).toBe('s4_release');
    expect(result.opsec.release_decision.reasons).toContain('bulk_secure_local_release_requires_approval');
    expect(Object.values(world.calls).every((calls) => calls.length === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });

  test('a bulk-shaped request that did not opt in answers without private material instead of tripping the gate', async () => {
    const world = answerWorld('private-cloud-only');
    const result = await world.handler.answer({ question: 'Export all of my lab records with the full text.' });
    expect(result.opsec.release_decision.reasons).not.toContain('bulk_secure_local_release_requires_approval');
    expect(result.audit.searched_corpora).not.toContain(SECURE);
    expect(result.audit.skipped_corpora.find((skip) => skip.corpus_id === SECURE)?.reason)
      .toBe('bulk_secure_local_release_requires_approval');
    expect(world.calls['venice-private']).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
  });
});

describe('a private analyst outage never costs an ordinary answer', () => {
  const failing = (): Analyst => ({
    async analyze() {
      throw new Error('upstream 503');
    },
  });

  test('default-included private evidence falls back to the ordinary route without it, call after call', async () => {
    const world = answerWorld('private-cloud-only', { analystOverrides: { 'venice-private': failing() } });
    // Enough calls to open the member's breaker: later calls meet an empty
    // route instead of a failing leg, and must fall back the same way.
    for (let call = 1; call <= 5; call += 1) {
      const result = await world.handler.answer({ question: 'What was my LDL?' });
      expect({ call, backend: result.audit.answer_synthesis.analyst_backend }).toEqual({ call, backend: 'cloud' });
      expect(result.audit.skipped_corpora.find((skip) => skip.corpus_id === SECURE)?.reason)
        .toBe('private_analyst_unavailable');
      expect(result.audit.answer_synthesis.secure_local_items_consulted).toBe(0);
      expect(result.answer).toContain('the private analyst is unavailable right now');
      expect(JSON.stringify(result)).not.toContain('SECURE-RAW-CHUNK-TEXT');
    }
    // The ordinary analyst never saw a secure candidate.
    expect(world.calls['cloud-openclaw-infer']!.every((pack) => (
      pack.candidates.every((candidate) => candidate.trustDomain !== 'secure_local')
    ))).toBe(true);
  });

  test('an explicit private request keeps the hard failure', async () => {
    const world = answerWorld('private-cloud-only', { analystOverrides: { 'venice-private': failing() } });
    await expect(world.handler.answer({ question: 'What was my LDL?', include_secure_local: true }))
      .rejects.toThrow('Sovereignty analyst fallback chain exhausted');
    expect(world.calls['cloud-openclaw-infer']).toHaveLength(0);
  });

  test('a slow but working private leg returns the private answer, and later explicit requests still work', async () => {
    const calls: EvidencePack[] = [];
    const inner = recordingAnalyst(calls);
    const slow: Analyst = {
      async analyze(pack, analyzeOptions) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return inner.analyze(pack, analyzeOptions);
      },
    };
    const world = answerWorld('local-only', { analystOverrides: { 'local-source-answer': slow } });
    for (let call = 1; call <= 3; call += 1) {
      const result = await world.handler.answer({ question: 'What was my LDL?' });
      expect({ call, backend: result.audit.answer_synthesis.analyst_backend }).toEqual({ call, backend: 'local' });
      expect(result.audit.answer_synthesis.secure_local_items_consulted).toBeGreaterThan(0);
    }
    const explicit = await world.handler.answer({ question: 'What was my LDL?', include_secure_local: true });
    expect(explicit.audit.answer_synthesis.analyst_backend).toBe('local');
    expect(explicit.answer).toContain('92 mg/dL');
  });

  test('a private leg that fails under its configured budget falls back for default requests', async () => {
    const hung: Analyst = { analyze: () => new Promise(() => {}) };
    const world = answerWorld('local-only', {
      analystOverrides: { 'local-source-answer': hung },
      // The operator's own last-leg budget, not a default-path cap.
      secureAnalystPoolLastLegTimeoutMs: 50,
    });
    const result = await world.handler.answer({ question: 'What was my LDL?' });
    expect(result.audit.answer_synthesis.analyst_backend).toBe('cloud');
    expect(result.audit.skipped_corpora.find((skip) => skip.corpus_id === SECURE)?.reason)
      .toBe('private_analyst_unavailable');
    // The first build's skips survive the rebuild.
    expect(result.audit.skipped_corpora.filter((skip) => skip.corpus_id === SECURE)).toHaveLength(1);
  });

  test('a caller-side cancellation never opens the private breaker', async () => {
    let cancellations = 3;
    const calls: EvidencePack[] = [];
    const inner = recordingAnalyst(calls);
    const cancelling: Analyst = {
      async analyze(pack, analyzeOptions) {
        if (cancellations > 0) {
          cancellations -= 1;
          const error = new Error('caller went away');
          error.name = 'AbortError';
          throw error;
        }
        return inner.analyze(pack, analyzeOptions);
      },
    };
    const world = answerWorld('private-cloud-only', { analystOverrides: { 'venice-private': cancelling } });
    for (let call = 1; call <= 3; call += 1) {
      await expect(world.handler.answer({ question: 'What was my LDL?', include_secure_local: true }))
        .rejects.toThrow('caller went away');
    }
    // Three cancellations exceed the breaker threshold (2); had they counted,
    // this explicit request would meet an empty route.
    const result = await world.handler.answer({ question: 'What was my LDL?', include_secure_local: true });
    expect(result.audit.answer_synthesis.analyst_backend).toBe('venice');
  });

  test('a gated e2ee analyst model excludes default private evidence instead of throwing', async () => {
    const world = answerWorld('private-cloud-only');
    // The secure gate no longer throws; what remains is this preset's own
    // ordinary-route answer to a Venice request (no Venice member for
    // internal), which is unchanged by this default.
    const outcome = await world.handler.answer({ question: 'What was my LDL?', analyst_model: 'e2ee-glm-5-2-p' })
      .then(() => undefined, (error: unknown) => error);
    expect(outcome).not.toMatchObject({ code: 'source_index_policy_violation' });
    expect(world.calls['venice-private']).toHaveLength(0);
    // The same model on an explicit private request is still refused outright.
    await expect(world.handler.answer({
      question: 'What was my LDL?',
      analyst_model: 'e2ee-glm-5-2-p',
      include_secure_local: true,
    })).rejects.toMatchObject({ code: 'source_index_policy_violation' });
  });
});

describe('released citation labels are secret-scanned', () => {
  test('a secret-like secure title is withheld from the released evidence', async () => {
    const world = answerWorld('private-cloud-only', { secureTitle: 'Bank login password: hunter2hunter2 statement' });
    const result = await world.handler.answer({ question: 'What was my LDL?' });
    const secure = result.evidence.find((item) => item.corpus_id === SECURE);
    expect(secure).toBeDefined();
    expect(secure!.title).toBeUndefined();
    expect(secure!.provider_item_id).toBe('lab-1');
    expect(JSON.stringify(result)).not.toContain('hunter2hunter2');
  });

  test('an ordinary secure title is still released', async () => {
    const world = answerWorld('private-cloud-only');
    const result = await world.handler.answer({ question: 'What was my LDL?' });
    expect(result.evidence.find((item) => item.corpus_id === SECURE)?.title).toBe('lab-1.pdf');
  });
});

// --- Fixtures -------------------------------------------------------------------

function presetConfig(preset: Preset): SovereigntyConfig {
  return JSON.parse(readFileSync(
    join(import.meta.dir, '..', 'config', 'sovereignty', 'presets', `${preset}.json`),
    'utf8',
  )) as SovereigntyConfig;
}

function answerWorld(preset: Preset, options: {
  omitProfiles?: readonly string[];
  analystOverrides?: Readonly<Record<string, Analyst>>;
  secureTitle?: string;
  secureAnalystPoolLastLegTimeoutMs?: number;
} = {}) {
  const engine = createSovereigntyEngine(presetConfig(preset));
  const calls: Record<string, EvidencePack[]> = {};
  const analysts = new Map<string, SovereigntyAnalystRouteStep>();
  for (const [id, profile] of Object.entries(engine.config.modelProfiles)) {
    if (profile.purpose !== 'analyst' || options.omitProfiles?.includes(id)) continue;
    calls[id] = [];
    analysts.set(id, {
      profile: { id, profile },
      backend: backendFor(profile.provider, profile.trust),
      analyst: options.analystOverrides?.[id] ?? recordingAnalyst(calls[id]!),
    });
  }
  const fallbackLocal = recordingAnalyst([]);
  const handler = createAnalystSourceIndexAnswerHandler({
    analyst: fallbackLocal,
    lanes: () => lanes(options.secureTitle),
    ...(options.secureAnalystPoolLastLegTimeoutMs !== undefined
      ? { secureAnalystPool: { lastLegTimeoutMs: options.secureAnalystPoolLastLegTimeoutMs } }
      : {}),
    sovereigntyAnalystRoute: ({ pack, localOnly, requestedProvider }) => {
      const trustDomain: SourceTrustDomain = localOnly || pack.candidates.some((c) => c.trustDomain === 'secure_local')
        ? 'secure_local'
        : 'internal';
      return sovereigntyAnalystRoutePlan({
        trustDomain,
        pool: engine.resolveAnalystPool({ trustDomain, requestedProvider }),
        analysts,
      });
    },
    secureLocalAnalystRoute: ({ requestedProvider }) => secureLocalAnalystRouteStatus({
      engine,
      analysts,
      requestedProvider,
    }),
  });
  return { handler, calls };
}

function backendFor(provider: string, trust: string): AnalystBackend {
  if (provider === 'venice') return 'venice';
  if (trust === 'local') return 'local';
  return 'cloud';
}

// Cites the first candidate with a bounded derivative, never the raw chunk.
function recordingAnalyst(calls: EvidencePack[]): Analyst {
  return {
    async analyze(pack): Promise<AnalystResult> {
      calls.push(pack);
      const secure = pack.candidates.findIndex((candidate) => candidate.trustDomain === 'secure_local');
      const cited = pack.candidates[secure >= 0 ? secure : 0];
      return {
        answer: secure >= 0 ? 'Your LDL was 92 mg/dL.' : 'Your notes mention an LDL question.',
        citations: cited ? [{ provenance: cited.provenance, claim: secure >= 0 ? 'LDL was 92 mg/dL' : 'LDL question' }] : [],
        unanswered: [],
      };
    },
  };
}

function lanes(secureTitle?: string) {
  const registry = buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({ corpusId: INTERNAL, family: 'note', trustDomain: 'internal' }),
    defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
  ]);
  const adapter = (id: string, title = `${id}.pdf`) => () => ({
    hits: [{
      sourceItem: {
        family: 'file' as const,
        provider: 'fixture',
        accountScope: 'personal',
        providerItemId: id,
        localItemId: `personal:${id}`,
      },
      provenance: {
        sourceItem: {
          family: 'file' as const,
          provider: 'fixture',
          accountScope: 'personal',
          providerItemId: id,
          localItemId: `personal:${id}`,
        },
        citation: { title },
      },
      score: 1,
      rawExposed: false as const,
    }],
    latencyMs: 1,
    rawExposed: false as const,
  });
  const provider = (trustDomain: SourceTrustDomain, text: string) => ({
    async fetchLocalContent() {
      return {
        sensitivity: buildSourceSensitivity({ trustTier: trustDomain === 'secure_local' ? 'S4' : 'S2', trustDomain }),
        chunks: [text],
      };
    },
  });
  return {
    registry,
    adapters: {
      [INTERNAL]: adapter('note-1'),
      [SECURE]: adapter('lab-1', secureTitle),
    } as SourceIndexRouterAdapterMap,
    contentProviders: {
      [INTERNAL]: provider('internal', INTERNAL_RAW),
      [SECURE]: provider('secure_local', SECURE_RAW),
    } as LocalContentProviderMap,
  };
}

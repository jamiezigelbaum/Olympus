// The held-out eval for the one-pipeline spine (contract 2.2.0,
// docs/design/archive-live-one-dataset.md, "Proof"): a question whose answer
// needs items from BOTH of a source's inputs (one the live reader brought, one
// an imported archive did) is answered from both, each cited, and none of it
// is templated. The pack is built from the real archive import, tier set,
// ledger and answer lanes (a fixture source standing in for every real one);
// only the model is scripted, and it answers from the evidence in its prompt
// alone.
//
// This is the fixture proof of the machinery. The release gate on real data
// is `bun run eval:real` against the owner-private dataset, which this file
// does not replace and which stays pending the owner's decision.

import { afterEach, describe, expect, test } from 'bun:test';
import { createAnalyst, type AnalystModel } from '../src/core/analyst.ts';
import type { EvidencePack } from '../src/core/contracts.ts';
import { buildEvidencePackDetailed, type EvidencePackBuildDetail } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import type { TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { createParentLabelResolver } from '../src/workers/connector-store/parent-label.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { createSourceAnswerLanes } from '../src/workers/email-source/source-answer-lanes.ts';
import { releaseAnalystAnswer } from '../src/workers/source-index/analyst-answer.ts';
import { runEval } from '../eval/run.ts';
import type { EvalDataset } from '../eval/types.ts';
import { onePipelineHarness, type FxRecord, type OnePipelineHarness } from './support/one-pipeline-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const TERM_TEXT = 'The Elm Street flat lease term is thirty-seven months.';
const ROOM_TEXT = 'The Elm Street flat lease covers room twelve.';
const ANSWER_TEXT = 'The lease runs for thirty-seven months and covers room twelve.';

/** The privacy-safe model has judged every item ordinary: nothing is held back from the answer. */
const judgedOrdinary: TierSniffer = { id: 'scripted', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) };

const rec = (id: string, version: number, subject: string, body: string): FxRecord => ({ id, version, subject, body });

/**
 * A model that has only its prompt: it cites the evidence whose text states each fact it needs,
 * and says what it could not find when one is missing.
 */
function promptOnlyModel(prompts: string[]): AnalystModel {
  const FACTS = ['thirty-seven months', 'room twelve'];
  return {
    async complete(request) {
      prompts.push(request.prompt);
      const found = new Map<string, number>();
      let current: number | undefined;
      for (const line of request.prompt.split('\n')) {
        const heading = /^\[(\d+)\] /u.exec(line);
        if (heading) current = Number(heading[1]);
        if (current === undefined) continue;
        for (const fact of FACTS) if (line.includes(fact) && !found.has(fact)) found.set(fact, current);
      }
      const missing = FACTS.filter((fact) => !found.has(fact));
      return {
        text: JSON.stringify(missing.length === 0
          ? {
            answer: ANSWER_TEXT,
            citations: FACTS.map((fact) => ({ evidence: found.get(fact)!, claim: fact })),
            unanswered: [],
            sufficient: true,
          }
          : { answer: 'The sources searched do not say it all.', citations: [], unanswered: missing.map((fact) => `No source states ${fact}.`), sufficient: false }),
        modelId: 'scripted',
      };
    },
  };
}

/** The source's two inputs: the lease term from an old export, the room from what live read since. */
async function world(options: { sniffer?: TierSniffer } = {}) {
  const h = onePipelineHarness(cleanups, { ...(options.sniffer ? { sniffer: options.sniffer } : {}) });
  h.connectLive('export-account');
  h.live.records = [rec('room', 1, 'Elm Street flat lease', ROOM_TEXT)];
  await h.pullLive();
  const id = await h.startImport('lease.mbox', [rec('term', 1, 'Elm Street flat lease', TERM_TEXT)]);
  await h.importAll(id);
  return { h, lanes: answerLanes(h) };
}

function answerLanes(h: OnePipelineHarness) {
  const stores = () => h.set.openStores();
  const corpora = () => new Set(stores().map((store) => store.corpusId));
  return createSourceAnswerLanes({
    stores,
    registry: () => buildSourceIndexCorpusRegistry(stores().map((store) =>
      defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }))),
    embeddingProvider: () => undefined,
    localEmbedding: () => undefined,
    readScope: () => ({ allowed: true, contentAllowed: true }),
    answerScope: () => ({ kind: 'search' }),
    accountScope: () => undefined,
    visibilityGate: createTierVisibilityGate(() => [{ ledger: h.set.ledger, corpusIds: corpora() }]),
    parentLabels: createParentLabelResolver({
      stores,
      scopes: () => [{ ledger: h.set.ledger, corpusIds: corpora() }],
    }),
  });
}

async function evaluate(dataset: EvalDataset, lanes: ReturnType<typeof createSourceAnswerLanes>, prompts: string[]) {
  const details = new WeakMap<EvidencePack, EvidencePackBuildDetail>();
  const report = await runEval(dataset, {
    async buildPack(question) {
      const active = lanes({ question: question.question });
      const detail = await buildEvidencePackDetailed({
        question: question.question,
        maxResults: 8,
        searchContext: { allowedTrustDomains: ['public_safe', 'internal', 'secure_local'] },
        registry: active.registry,
        adapters: active.adapters,
        contentProviders: active.contentProviders,
        ...(active.visibilityGate ? { visibilityGate: active.visibilityGate } : {}),
        ...(active.parentLabels ? { parentLabels: active.parentLabels } : {}),
      });
      details.set(detail.pack, detail);
      return detail.pack;
    },
    analyst: createAnalyst(promptOnlyModel(prompts)),
    releaseFor(pack, result) {
      const detail = details.get(pack);
      if (!detail) return undefined;
      const release = releaseAnalystAnswer({ detail, result, releaseSecureContent: false });
      const released = release.decision.decision === 'allow' || release.decision.decision === 'redact';
      return { result: { ...result, answer: release.answer, citations: released ? result.citations : [] }, audit: release.opsec };
    },
    gradeContextFor(pack) {
      const detail = details.get(pack);
      return detail ? { candidateCorpusIds: detail.candidateCorpusIds } : undefined;
    },
  });
  return { report, details };
}

describe('a question whose answer needs both of a source\'s inputs', () => {
  test('is answered from the live item and the archive\'s, each cited, as one dataset', async () => {
    const { h, lanes } = await world({ sniffer: judgedOrdinary });
    const prompts: string[] = [];
    const corpusId = h.stores.internal.corpusId;
    const dataset: EvalDataset = {
      version: 'one-pipeline-fixture',
      description: 'half the answer is in what live read, half in an imported archive',
      questions: [{
        id: 'lease-term-and-room',
        shape: 'cross_source_synthesis',
        question: 'Tell me about the Elm Street flat lease.',
        expectedAnswerContains: ['thirty-seven months', 'room twelve'],
        expectedEvidence: [
          { corpusId, providerItemId: 'term', hint: 'the lease term, from the imported archive' },
          { corpusId, providerItemId: 'room', hint: 'the room, from what the live reader read' },
        ],
      }],
    };
    const { report } = await evaluate(dataset, lanes, prompts);
    
    expect(report.grades[0]!.detail).toEqual([]);
    expect(report).toMatchObject({ total: 1, passed: 1, failed: 0 });
    // Neither input alone had it: both items reached the one prompt.
    expect(prompts[0]).toContain('thirty-seven months');
    expect(prompts[0]).toContain('room twelve');
    expect(h.duplicates()).toEqual([]);
  });

  test('before the private model has judged the archive\'s item, its text is held out of what is released', async () => {
    const { lanes } = await world();
    const prompts: string[] = [];
    const question = 'Tell me about the Elm Street flat lease.';
    const active = lanes({ question });
    const detail = await buildEvidencePackDetailed({
      question,
      maxResults: 8,
      searchContext: { allowedTrustDomains: ['public_safe', 'internal', 'secure_local'] },
      registry: active.registry,
      adapters: active.adapters,
      contentProviders: active.contentProviders,
      ...(active.visibilityGate ? { visibilityGate: active.visibilityGate } : {}),
      ...(active.parentLabels ? { parentLabels: active.parentLabels } : {}),
    });
    const result = await createAnalyst(promptOnlyModel(prompts)).analyze(detail.pack, { localOnly: false });
    const release = releaseAnalystAnswer({ detail, result, releaseSecureContent: false });
    // The held item is Private evidence in the pack; the live item is Personal.
    const domains = detail.pack.candidates.map((candidate) => candidate.trustDomain);
    expect(domains).toContain('secure_local');
    expect(domains).toContain('internal');
    // What is released says nothing of the held item's text.
    expect(release.answer).not.toContain('thirty-seven months');
    expect(result.citations.length > 0 ? release.decision.decision : 'withhold').not.toBe('allow');
  });

  test('a question no input answers is not given an answer', async () => {
    const { lanes } = await world({ sniffer: judgedOrdinary });
    const dataset: EvalDataset = {
      version: 'one-pipeline-fixture',
      description: 'coverage negative',
      questions: [{
        id: 'no-such-thing',
        shape: 'coverage_negative',
        question: 'What does the warranty for the dishwasher say?',
        mustReportGap: true,
      }],
    };
    const { report } = await evaluate(dataset, lanes, []);
    expect(report).toMatchObject({ passed: 1, failed: 0 });
  });
});

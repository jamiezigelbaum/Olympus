// The held-out eval for child items (docs/design/child-items.md, "Proof"): a
// question whose answer exists ONLY inside an attachment is answered from the
// child, the citation names the item it came inside, and none of it is
// templated. The pack is built from the real archive import, tier set, ledger
// and extraction runtime (the fixture connector standing in for every format)
// through the real lanes, evidence pack, Analyst and release; only the model is
// scripted, and it answers from the evidence in its prompt alone.
//
// This is the fixture proof of the machinery. The release gate on real data
// is `bun run eval:real` against the owner-private dataset, which this file
// does not replace.

import { afterEach, describe, expect, test } from 'bun:test';
import { archiveCorpusId, getArchiveFormat } from '../src/core/archive-formats.ts';
import { createAnalyst, type AnalystModel } from '../src/core/analyst.ts';
import type { EvidencePack } from '../src/core/contracts.ts';
import type { EvidencePackBuildDetail } from '../src/core/evidence-pack.ts';
import { buildEvidencePackDetailed } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { archiveLaneStores } from '../src/workers/archive-import/lane.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import type { TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { createParentLabelResolver } from '../src/workers/connector-store/parent-label.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { createSourceAnswerLanes } from '../src/workers/email-source/source-answer-lanes.ts';
import { releaseAnalystAnswer } from '../src/workers/source-index/analyst-answer.ts';
import { runEval } from '../eval/run.ts';
import type { EvalDataset } from '../eval/types.ts';
import { childProviderItemId, fixtureLocalItemId, type FixtureParentSpec } from './helpers/child-items-fixture.ts';
import { childItemsArchiveHarness, FIXTURE_ARCHIVE_FORMAT } from './support/child-items-archive-harness.ts';
import { childItemsExtraction } from './support/child-items-extraction-harness.ts';

const format = getArchiveFormat(FIXTURE_ARCHIVE_FORMAT)!;
const INTERNAL = archiveCorpusId('internal', format.family);
const CHILD = childProviderItemId('m1', 'p1');
const LEASE_TEXT = 'The lease term is thirty-seven months.';
const ANSWER_TEXT = 'The lease runs for thirty-seven months.';

const cleanups: Array<() => void> = [];
afterEach(() => {
  registerInstalledTierClassification(undefined);
  while (cleanups.length) cleanups.pop()!();
});

/** Every item is judged ordinary: the child's text sits with Personal content. */
function everythingPersonal(): void {
  const sniffer: TierSniffer = { id: 'scripted', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) };
  registerInstalledTierClassification({ forLedger: () => ({ sniffer }) });
}

function mailbox(): FixtureParentSpec[] {
  return [
    {
      id: 'm1', subject: 'Flat', sender: 'Alice', sentAt: '2024-03-03T10:00:00.000Z', body: 'Please find the lease attached.',
      children: [{ key: 'p1', name: 'lease.txt', mimeType: 'text/plain', text: LEASE_TEXT }],
    },
    {
      id: 'm2', subject: 'Trip', sender: 'Cy', sentAt: '2024-03-05T10:00:00.000Z', body: 'Tickets are attached.',
      children: [{ key: 'p1', name: 'tickets.txt', mimeType: 'text/plain', text: 'Gate twelve.' }],
    },
  ];
}

/** A model that has only its prompt: it cites the evidence whose text answers, and says so when none does. */
function promptOnlyModel(prompts: string[]): AnalystModel {
  return {
    async complete(request) {
      prompts.push(request.prompt);
      let current: number | undefined;
      let number: number | undefined;
      for (const line of request.prompt.split('\n')) {
        const heading = /^\[(\d+)\] /u.exec(line);
        if (heading) current = Number(heading[1]);
        if (current !== undefined && line.includes('thirty-seven months')) {
          number = current;
          break;
        }
      }
      return {
        text: JSON.stringify(number === undefined
          ? { answer: 'The sources searched do not say.', citations: [], unanswered: ['No source states it.'], sufficient: false }
          : { answer: ANSWER_TEXT, citations: [{ evidence: number, claim: 'thirty-seven months' }], unanswered: [], sufficient: true }),
        modelId: 'scripted',
      };
    },
  };
}

async function world(options: { parentNamesPrivate?: boolean } = {}) {
  everythingPersonal();
  const specs = mailbox();
  const h = childItemsArchiveHarness(cleanups);
  const archiveId = h.start();
  await h.importAll(archiveId, specs);
  const ext = childItemsExtraction(h, cleanups, { parents: specs });
  await ext.drive(archiveId);
  const lane = h.runtime.lane(format.family);
  if (options.parentNamesPrivate) {
    await moveTieredItem({
      set: lane.set,
      identity: { family: format.family, provider: format.provider, accountScope: archiveId, providerItemId: 'm1', localItemId: fixtureLocalItemId(archiveId, 'm1') },
      target: { metadataTier: 'secure', contentTier: 'secure' },
    });
  }
  const corpora = new Set(lane.set.openStores().map((store) => store.corpusId));
  const lanes = createSourceAnswerLanes({
    stores: () => archiveLaneStores(lane),
    registry: () => buildSourceIndexCorpusRegistry(archiveLaneStores(lane).map((store) =>
      defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }))),
    embeddingProvider: () => undefined,
    localEmbedding: () => undefined,
    readScope: () => ({ allowed: true, contentAllowed: true }),
    answerScope: () => ({ kind: 'search' }),
    accountScope: () => undefined,
    visibilityGate: createTierVisibilityGate(() => [{ ledger: lane.ledger, corpusIds: corpora }]),
    parentLabels: createParentLabelResolver({
      stores: () => archiveLaneStores(lane),
      scopes: () => [{ ledger: lane.ledger, corpusIds: corpora }],
    }),
  });
  return { archiveId, lanes };
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

describe('a question whose answer exists only inside an attachment', () => {
  test('is answered from the child, and the citation names the item it came inside', async () => {
    const { lanes } = await world();
    const prompts: string[] = [];
    const dataset: EvalDataset = {
      version: 'child-items-fixture',
      description: 'the answer lives only in an attachment',
      questions: [{
        id: 'lease-term',
        shape: 'value_lookup',
        question: 'What is the lease term?',
        expectedAnswerContains: ['thirty-seven months'],
        expectedEvidence: [{ corpusId: INTERNAL, providerItemId: CHILD, parentLabel: "'Flat' from Alice", hint: 'the lease attached to the message about the flat' }],
      }],
    };
    const { report } = await evaluate(dataset, lanes, prompts);

    expect(report.grades[0]!.detail).toEqual([]);
    expect(report).toMatchObject({ total: 1, passed: 1, failed: 0 });
    // The parent's body never says the term, so the answer came from the child.
    expect(prompts[0]).toContain("'Flat' from Alice, 3 March 2024");
    expect(prompts[0]).toContain('thirty-seven months');
  });

  test('a citation that does not name its parent fails an expectation that does', async () => {
    const { lanes } = await world();
    const dataset: EvalDataset = {
      version: 'child-items-fixture',
      description: 'the label is graded, not assumed',
      questions: [{
        id: 'wrong-parent',
        shape: 'value_lookup',
        question: 'What is the lease term?',
        expectedAnswerContains: ['thirty-seven months'],
        expectedEvidence: [{ corpusId: INTERNAL, providerItemId: CHILD, parentLabel: 'Taxes', hint: 'a different parent' }],
      }],
    };
    const { report } = await evaluate(dataset, lanes, []);
    expect(report).toMatchObject({ passed: 0, failed: 1 });
    expect(report.grades[0]!.evidenceCited).toBe(false);
  });

  test('with the parent\'s names Private, the answer is the same and the parent\'s subject reaches no prompt', async () => {
    const { lanes } = await world({ parentNamesPrivate: true });
    const prompts: string[] = [];
    const dataset: EvalDataset = {
      version: 'child-items-fixture',
      description: 'a Personal child under Private names',
      questions: [{
        id: 'lease-term-private-names',
        shape: 'value_lookup',
        question: 'What is the lease term?',
        expectedAnswerContains: ['thirty-seven months'],
        expectedEvidence: [{ corpusId: INTERNAL, providerItemId: CHILD, hint: 'the lease attachment, cited without its parent' }],
      }],
    };
    const { report } = await evaluate(dataset, lanes, prompts);
    expect(report).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(prompts.join('\n')).toContain('thirty-seven months');
    expect(prompts.join('\n')).not.toContain('Flat');
    expect(prompts.join('\n')).not.toContain('Alice');
  });

  test('an honest "not found" stays honest: a question no attachment answers is not given one', async () => {
    const { lanes } = await world();
    const dataset: EvalDataset = {
      version: 'child-items-fixture',
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

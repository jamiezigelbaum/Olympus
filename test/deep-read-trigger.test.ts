import { WITHHELD_ANSWERS } from '../src/core/opsec.ts';
import { expect, test } from 'bun:test';
import type { Analyst, AnalystResult, RawItem, SourceConnector } from '../src/core/contracts.ts';
import { buildEvidencePackDetailed } from '../src/core/evidence-pack.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { LocalConnectorStore, createConnectorStoreContentProvider, createConnectorStoreCorpusAdapter } from '../src/workers/connector-store/index.ts';
import { createDeepReadJobs, DeepReadRefused } from '../src/workers/engine/runtime/deep-read-jobs.ts';
import { triggerDeepRead } from '../src/workers/source-index/deep-read-trigger.ts';
import { createAnalystSourceIndexAnswerHandler } from '../src/workers/source-index/analyst-answer.ts';
import { runPassageEval } from '../eval/run-passages.ts';

const corpusId = 'internal.fixture.files';
const question = 'What is the project conclusion?';
const conclusion = 'The project conclusion is to plant an orchard.';
const missing: AnalystResult = { answer: 'I could not find the conclusion.', citations: [], unanswered: ['conclusion'] };

async function fixture(long: boolean) {
  const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId, family: 'file', trustDomain: 'internal' });
  const items: RawItem[] = ['first', 'second'].map(id => ({
    identity: { family: 'file', provider: 'fixture', accountScope: 'me', providerItemId: id, localItemId: id },
    mimeType: 'text/plain', content: { kind: 'text', text: `${long ? 'Project background. '.repeat(1500) : ''}${conclusion}` },
    metadata: { name: `${id}.txt` }, fetchedAt: '2026-11-17T00:00:00Z',
  }));
  const connector: SourceConnector = {
    id: 'fixture', family: 'file', async authenticate() {},
    async *listItems() { yield { items, done: true }; },
    async fetchItem(id) { return items.find(item => item.identity.localItemId === id)!; },
    classificationSignals: () => ({}),
  };
  await store.syncFromConnector(connector, { fetchContent: true, placement: () => buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' }) });
  const lanes = {
    registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId, family: 'file', trustDomain: 'internal' })]),
    adapters: { [corpusId]: createConnectorStoreCorpusAdapter({ store, retrievalMode: 'keyword' }) },
    contentProviders: { [corpusId]: createConnectorStoreContentProvider({ store }) },
  };
  const detail = await buildEvidencePackDetailed({ question, maxResults: 12, maxCharsPerCandidate: 100,
    searchContext: { allowedTrustDomains: ['internal'] }, ...lanes });
  const packs: string[] = [];
  const analyst: Analyst = { async analyze(pack) {
    packs.push(pack.candidates.flatMap(c => c.chunks).join('\n'));
    return { answer: conclusion, citations: pack.candidates.map(c => ({ provenance: c.provenance, claim: conclusion })), unanswered: [] };
  } };
  const jobs = createDeepReadJobs({ stores: () => [store], lanes: () => lanes, inbox: () => undefined,
    model: async () => ({ analyst, promptBytes: 13_500, modelId: 'fixture' }) });
  return { store, lanes, detail, jobs, packs };
}

test('an unanswered long fixture item starts exactly one whole-item job and reads the answer past the cut', async () => {
  const f = await fixture(true);
  try {
    expect(f.detail.truncatedCandidateIndexes?.length).toBeGreaterThan(0);
    expect(f.detail.pack.candidates[0]!.chunks.join('')).not.toContain(conclusion);
    const result = await triggerDeepRead(f.detail, missing, f.jobs);
    expect(result.job).toBeDefined();
    expect(f.jobs.status()).toHaveLength(1);
    expect(f.jobs.status()[0]!.items).toBe(1);
    const answer = await f.jobs.wait(result.job!.id);
    expect(answer?.answer).toBe(conclusion);
    expect(f.packs.some(text => text.includes(conclusion))).toBe(true);
    const selected = f.detail.pack.candidates[0]!.provenance.sourceItem.localItemId;
    expect(answer?.citations.every(c => c.provenance.sourceItem.localItemId === selected)).toBe(true);
  } finally { f.store.close(); }
});

test('a short item read whole does not start a job', async () => {
  const f = await fixture(false);
  try {
    expect(f.detail.truncatedCandidateIndexes).toEqual([]);
    expect(await triggerDeepRead(f.detail, missing, f.jobs)).toEqual({});
    expect(f.jobs.status()).toHaveLength(0);
  } finally { f.store.close(); }
});

test('an answered question does not start a job even with cut head seats', async () => {
  const f = await fixture(true);
  try {
    expect(await triggerDeepRead(f.detail, { answer: conclusion, citations: [{ provenance: f.detail.pack.candidates[0]!.provenance, claim: conclusion }], unanswered: [] }, f.jobs)).toEqual({});
    expect(f.jobs.status()).toHaveLength(0);
  } finally { f.store.close(); }
});

test('only reserved head seats qualify, and a refusal names the file and offers the existing tool', async () => {
  const f = await fixture(true);
  try {
    expect(await triggerDeepRead({ ...f.detail, truncatedCandidateIndexes: [3] }, missing, f.jobs)).toEqual({});
    const result = await triggerDeepRead(f.detail, missing, { start: async () => { throw new DeepReadRefused('model_unavailable', 'Your private model is unavailable.'); } });
    expect(result.refused).toBe('model_unavailable');
    expect(result.notice).toContain(f.detail.pack.candidates[0]!.provenance.citation!.title!);
    expect(result.notice).toContain('source_deep_read');
  } finally { f.store.close(); }
});

test('Ask returns the ordinary answer with its background handle and notice', async () => {
  const f = await fixture(true);
  try {
    const result = await createAnalystSourceIndexAnswerHandler({ analyst: { analyze: async () => missing }, lanes: () => f.lanes,
      maxCharsPerCandidate: 100, deepRead: () => f.jobs,
    }).answer({ question, retrieval_mode: 'keyword' });
    expect(result.answer).toStartWith(WITHHELD_ANSWERS.private);
    expect(result.answer).toContain('the answer follows in Private answers');
    expect(JSON.stringify(result)).not.toContain('first.txt');
    expect(JSON.stringify(result)).not.toContain('second.txt');
    expect(result.deep_read).toBeDefined();
    expect(f.jobs.status()).toHaveLength(1);
    await f.jobs.wait(result.deep_read!.id);
  } finally { f.store.close(); }
});

test('eval waits for the same jobs, judges the deep answer and keeps text out of the receipt', async () => {
  const f = await fixture(true);
  try {
    const item = f.detail.pack.candidates[0]!.provenance.sourceItem;
    const receipt = await runPassageEval({ dataset: { version: '2', description: 'fixture', questions: [{
      id: 'p001', question, split: 'open', shape: 'value_lookup', expectedEvidence: [{ corpusId, providerItemId: item.providerItemId, quote: conclusion, hint: '' }],
    }] }, maxResults: 12, storeCounts: [], gitSha: 'fixture', buildPack: async () => f.detail,
      answer: async () => missing, deepReadJobs: f.jobs, judgeAnswer: async (_q, _expected, answer) => answer === conclusion ? 'correct' : 'wrong',
    });
    expect(receipt.summary.deepReadStarted).toBe(1);
    expect(receipt.questions![0]!.deepRead).toMatchObject({ triggered: true, refused: null, correctByMeaning: true, citesExpected: true });
    expect(receipt.questions![0]!.deepRead!.sectionsDone).toBe(receipt.questions![0]!.deepRead!.sectionsTotal);
    expect(JSON.stringify(receipt)).not.toContain(conclusion);
    expect(JSON.stringify(receipt)).not.toContain(question);
    expect(receipt.questions![0]!.answer!.citations).toBe(0);
  } finally { f.store.close(); }
});

test('remote and ChatGPT answers carry only deep-read ids and counts, never the local notice title', async () => {
  const { remoteOperationOutput } = await import('../src/core/remote-result.ts');
  const { answerToolResult } = await import('../src/workers/chatgpt/response-builder.ts');
  const notice = 'Reading all of "private unread title" for this question: 0 of 4 sections; the answer follows in Private answers.';
  const raw = { answer: `Ordinary answer.\n\n${notice}`, evidence: [], deep_read_notice: notice,
    deep_read: { id: 'dr_fixture', sectionsTotal: 4, title: 'private unread title', question },
  };
  for (const output of [remoteOperationOutput('source_answer', raw), answerToolResult(raw).structuredContent, answerToolResult({ ...raw, audit: { answer_synthesis: { private_context_used: true } } }).structuredContent]) {
    expect(output!.deep_read).toEqual({ id: 'dr_fixture', sectionsTotal: 4 });
    expect(JSON.stringify(output)).not.toContain('private unread title');
    expect(JSON.stringify(output)).not.toContain(question);
    expect(output!.answer).toContain('the answer follows in Private answers');
  }
});

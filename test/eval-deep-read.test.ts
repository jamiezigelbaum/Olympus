import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Analyst } from '../src/core/contracts.ts';
import { fixtureConnector, openTierFixture, JUDGED_PERSONAL_SNIFFER } from './helpers/tier-fixtures.ts';
import { openEvalDataRoot } from '../eval/data-root.ts';
import { buildEvalPack, createEvalSourceLanes } from '../eval/retrieval.ts';
import type { DraftModel } from '../eval/local-model.ts';
import { assertPrivateOutput, draftDeepReadQuestions, type DeepReadDataset } from '../eval/draft-deep-read-questions.ts';
import { runDeepReadEval, type DeepReadReceipt } from '../eval/run-deep-read.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Every message and passage carries words of its own, so a quote picks out one piece.
// Letters only (the grading rule counts words of three or more letters), all the same length.
const word = (k: number) => `q${Array.from({ length: 4 }, (_, d) => String.fromCharCode(97 + Math.floor(k / 26 ** d) % 26)).join('')}`;
const words = (n: number, count: number) => Array.from({ length: count }, (_, i) => word(n * 200 + i)).join(' ');
const MESSAGES = 40;
const PARAGRAPHS = 30;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'eval-deep-read-')); dirs.push(root);
  const world = openTierFixture(root, { embed: false });
  try {
    await world.set.sync(fixtureConnector(() => [
      ...Array.from({ length: MESSAGES }, (_, i) => ({ id: `m${i}`, name: 'Synthetic chat', conversation: 'c1', text: `Message ${i}. ${words(i, 14)}.` })),
      { id: 'doc', name: 'Synthetic report', text: Array.from({ length: PARAGRAPHS }, (_, p) => `Paragraph ${p}. ${words(1000 + p, 120)}.`).join('\n\n') },
    ]), { fetchContent: true, tierClassification: { sniffer: JUDGED_PERSONAL_SNIFFER } });
  } finally { world.close(); }
  return root;
}

/** Drafts a question naming nothing, and quotes the item's first ten words after its label. */
const fakeDraft: DraftModel = {
  async complete(prompt) {
    if (prompt.startsWith('QUESTION CHECK')) return { answers: true, specific: true };
    const item = prompt.slice(prompt.indexOf('ITEM:\n') + 6);
    const quote = item.split(/\s+/).filter(word => /^q[a-z]{4}\.?$/.test(word)).slice(0, 10).join(' ');
    return { question: 'Which synthetic entry is this?', quote };
  },
};

/** Cites every evidence piece holding one of the dataset's quotes; the final call states the notes. */
function fakeAnalyst(quotes: readonly string[]): Analyst & { calls: number } {
  const state = { calls: 0 };
  return Object.assign(state, {
    async analyze(pack: Parameters<Analyst['analyze']>[0]) {
      state.calls++;
      const hits = pack.candidates.filter(c => quotes.some(quote => c.chunks.join(' ').includes(quote.split(' ').slice(2, 6).join(' '))));
      return { answer: hits.map(c => c.chunks.join(' ')).join(' ') || 'Nothing found.', citations: hits.map(c => ({ provenance: c.provenance, claim: c.chunks.join(' ').slice(0, 400) })), unanswered: [] };
    },
  });
}

test('drafts back-half targets in long conversations and documents, then scores baseline and deep read without a model server', async () => {
  const root = await fixture();
  const opened = openEvalDataRoot({ dataRoot: root });
  try {
    const lanes = createEvalSourceLanes({ ...opened });
    const input = { opened, lanes: () => lanes(''), model: fakeDraft, seed: 'fixture', conversations: 1, documents: 1,
      minMessages: 30, minChunks: 4, minWords: 10, conversationFamilies: ['file'], documentFamilies: ['file'] };
    const drafted = await draftDeepReadQuestions(input);
    expect(drafted.counts).toMatchObject({ kept: 2, conversations: { eligible: 1, kept: 1 }, documents: { eligible: 1, kept: 1 }, requestsFailed: 0 });
    expect(await draftDeepReadQuestions(input)).toEqual(drafted);
    const [conversation, document] = drafted.dataset.questions;
    expect(conversation).toMatchObject({ kind: 'conversation', set: { whole: 'conversation', provider_conversation_id: 'c1' }, setItems: MESSAGES });
    expect(document).toMatchObject({ kind: 'item', set: { whole: 'item', provider_item_id: 'doc' } });
    for (const q of drafted.dataset.questions) expect(q.target.index / q.target.of).toBeGreaterThan(0.5);
    // Counts carry no text.
    const printed = JSON.stringify(drafted.counts);
    for (const q of drafted.dataset.questions) { expect(printed).not.toContain(q.quote.split(' ')[0]!); expect(printed).not.toContain('synthetic'); }

    const analyst = fakeAnalyst(drafted.dataset.questions.map(q => q.quote));
    const partials: DeepReadReceipt[] = [];
    const receipt = await runDeepReadEval({
      dataset: drafted.dataset, stores: opened.stores, lanes: () => lanes(''), analyst,
      deepPromptBytes: 6_000, deepPromptBytesSource: 'option',
      baseline: {
        maxResults: 5, promptBytes: 6_000,
        buildPack: q => buildEvalPack({ question: q.question, lanes, maxResults: 5, maxCharsPerCandidate: 3_000 }),
        answer: (_q, pack) => analyst.analyze(pack, { localOnly: true }),
      },
      judgeAnswer: async () => 'correct',
      storeCounts: opened.storeCounts, gitSha: 'fixture', onRow: partial => partials.push(partial),
    });
    expect(partials).toHaveLength(2);
    expect(receipt.rows.map(row => row.id)).toEqual(['d001', 'd002']);
    for (const row of receipt.rows) {
      expect(row.deep).toMatchObject({ outcome: 'answered', found: true, read: true, readItem: true, cited: true, right: true, meaning: 'correct', targetPieces: 1, failedSections: 0 });
      expect(row.deep.sections).toBeGreaterThan(1);
      expect(row.deep.secondsPerSection).not.toBeNull();
      expect(row.baseline!.outcome).toBe('answered');
    }
    expect(receipt.rows[0]!.deep).toMatchObject({ items: MESSAGES, unreadable: 0 });
    expect(receipt.summary.overall.deep).toMatchObject({ rows: 2, found: 2, read: 2, right: 2, correctByMeaning: 2 });
    const pairs = receipt.summary.overall.paired!;
    expect(pairs.right.wins + pairs.right.losses + pairs.right.ties).toBe(2);
    expect(Object.keys(receipt.summary.byKind).sort()).toEqual(['conversation', 'item']);
    const written = JSON.stringify(receipt);
    for (const q of drafted.dataset.questions) {
      expect(written).not.toContain(q.question);
      for (const word of q.quote.split(' ')) expect(written).not.toContain(word.replace(/\.$/, ''));
    }
    expect(written).not.toContain('Synthetic');
  } finally { opened.close(); }
}, 60_000);

test('a set the deep read cannot list is a failed row with a code, not a crash', async () => {
  const root = await fixture();
  const opened = openEvalDataRoot({ dataRoot: root });
  try {
    const lanes = createEvalSourceLanes({ ...opened });
    const dataset: DeepReadDataset = { version: 'deep-read-1', description: '', seed: 's', questions: [{
      id: 'd001', kind: 'item', question: 'Which entry?', quote: 'one two three four five six', notes: 'natural',
      set: { corpus_id: 'nowhere.fixture', provider: 'fixture', account_scope: 'personal', local_item_id: 'x', provider_item_id: 'x', whole: 'item' },
      expected: [{ corpus_id: 'nowhere.fixture', provider_item_id: 'x', local_item_id: 'x' }], target: { index: 0, of: 1 }, setItems: 1, setPassages: 1,
    }] };
    const receipt = await runDeepReadEval({ dataset, stores: opened.stores, lanes: () => lanes(''), analyst: fakeAnalyst([]),
      deepPromptBytes: 6_000, deepPromptBytesSource: 'option', storeCounts: opened.storeCounts, gitSha: 'fixture' });
    expect(receipt.rows[0]!.deep).toMatchObject({ outcome: 'failed', code: 'DEEP_READ_NOT_FOUND', found: false });
    expect(receipt.rows[0]!.baseline).toBeUndefined();
  } finally { opened.close(); }
});

test('the drafted set is written under eval/private only', () => {
  expect(() => assertPrivateOutput(join(tmpdir(), 'questions.json'))).toThrow('eval/private');
  expect(() => assertPrivateOutput(resolve(import.meta.dir, '../eval/private/deep-read-questions.json'))).not.toThrow();
});

test('CLI runs both arms against a local fake model and prints counts only', async () => {
  const root = await fixture();
  const opened = openEvalDataRoot({ dataRoot: root });
  let dataset: DeepReadDataset;
  try {
    const lanes = createEvalSourceLanes({ ...opened });
    dataset = (await draftDeepReadQuestions({ opened, lanes: () => lanes(''), model: fakeDraft, seed: 'fixture', conversations: 1, documents: 1,
      minMessages: 30, minChunks: 4, minWords: 10, conversationFamilies: ['file'], documentFamilies: ['file'] })).dataset;
  } finally { opened.close(); }
  const work = mkdtempSync(join(tmpdir(), 'eval-deep-read-cli-')); dirs.push(work);
  mkdirSync(work, { recursive: true });
  const datasetPath = join(work, 'questions.json'); const output = join(work, 'receipt.json');
  writeFileSync(datasetPath, JSON.stringify(dataset));
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'synthetic-answer' }] });
    if (request.method !== 'POST') return new Response('not found', { status: 404 });
    const body = await request.json() as { model: string };
    return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({ answer: 'A synthetic note.', citations: [{ evidence: 1, claim: 'A synthetic note.' }], unanswered: [], sufficient: true }) } }] });
  } });
  try {
    const child = Bun.spawn([process.execPath, 'eval/run-deep-read.ts', '--data-root', root, datasetPath, '--output', output, '--deep-prompt-bytes', '6000', '--prompt-bytes', '6000'], {
      env: { ...process.env, OLYMPUS_ARGUS_SOURCE_ANSWER_BASE_URL: `http://127.0.0.1:${server.port}/v1`, OLYMPUS_ARGUS_SOURCE_ANSWER_MODEL: 'synthetic-answer',
        OLYMPUS_SOURCE_INDEX_ANALYST_LANE: '', OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE: '', OLYMPUS_SOURCE_RERANKER: 'off' }, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toContain('question 2/2: deep_read');
    expect(code).toBe(0);
    const receipt = JSON.parse(readFileSync(output, 'utf8')) as DeepReadReceipt;
    expect(receipt).toMatchObject({ deepPromptBytes: 6000, deepPromptBytesSource: 'option', baselinePromptBytes: 6000 });
    expect(receipt.rows).toHaveLength(2);
    for (const row of receipt.rows) { expect(row.deep.outcome).toBe('answered'); expect(row.deep.sections).toBeGreaterThan(1); expect(row.baseline!.outcome).toBe('answered'); }
    for (const q of dataset.questions) { expect(stdout).not.toContain(q.question); expect(stdout).not.toContain(q.quote); expect(stderr).not.toContain(q.quote); }
  } finally { server.stop(true); }
}, 60_000);

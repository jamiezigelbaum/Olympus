import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { fixtureConnector } from './helpers/tier-fixtures.ts';
import { runPanelEval } from '../eval/run-panel.ts';
import { validatePassageDataset, type EvalDataset } from '../eval/types.ts';

// All text and identities in this test are invented, with no owner data.
const corpusId = 'secure_local.fixture.file';
const quotes = [
  'Synthetic kestrel invoice alpha totals forty seven dollars this month',
  'Synthetic kestrel invoice beta totals fifty three dollars this month',
];
const dataset: EvalDataset = { version: '1', description: 'Synthetic panel acceptance', questions: [{
  id: 'q1', shape: 'cross_source_synthesis', question: 'What are both synthetic kestrel invoice totals?',
  expectedEvidence: quotes.map((quote, index) => ({ corpusId, providerItemId: `f${index + 1}`, quote, hint: 'Synthetic' })),
  neededFiles: [1, 2, 2].map(index => ({ corpusId, providerItemId: `f${index}` })),
}] };

test('panel CLI reads both needed files, judges its answer and prints only receipt data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'panel-eval-'));
  let calls = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/props') return Response.json({ default_generation_settings: { n_ctx: 32768 } });
    if (path === '/v1/models') return Response.json({ data: [{ id: 'synthetic-model' }] });
    if (path !== '/v1/chat/completions') return new Response('', { status: 404 });
    const body = await request.json() as { messages: { content: string }[] };
    const prompt = body.messages.at(-1)!.content;
    calls++;
    const reply = prompt.startsWith('ANSWER CHECK:') ? { verdict: 'correct' } : {
      answer: 'Alpha totals forty seven dollars and beta totals fifty three dollars.',
      citations: [{ evidence: 1, claim: 'forty seven dollars' }, { evidence: 2, claim: 'fifty three dollars' }],
      unanswered: [], sufficient: true,
    };
    return Response.json({ model: 'synthetic-model', choices: [{ message: { content: JSON.stringify(reply) } }] });
  } });
  try {
    const store = new LocalConnectorStore({ dbPath: join(root, 'fixture.sqlite'), corpusId, family: 'file', trustDomain: 'secure_local', tierLedger: null });
    try { await store.syncFromConnector(fixtureConnector(() => quotes.map((text, index) => ({ id: `f${index + 1}`, name: `Synthetic ${index + 1}`, text, legacyDomain: 'secure_local' }))), { fetchContent: true }); }
    finally { store.close(); }
    const datasetPath = join(root, 'dataset.json');
    writeFileSync(datasetPath, JSON.stringify(dataset));
    const baseUrl = `http://127.0.0.1:${server.port}/v1`;
    const child = Bun.spawn([process.execPath, 'eval/run-panel.ts', '--data-root', root, '--allow-no-fd-check', '--model-base-url', baseUrl, '--model', 'synthetic-model', '--limits', 'window', datasetPath], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    const receipt = JSON.parse(stdout);
    expect(receipt).toMatchObject({ questions: 1, stores: 1, skippedStores: 0, windowTokens: 32768, maxItems: 9, maxPromptBytes: 27000,
      foundDoc: 1, foundParagraph: 1, answeredCorrectly: 1, neededFiles: 2, neededFilesRead: 2 });
    expect(receipt.rows[0]).toMatchObject({ id: 'q1', filesRead: 2, judgeUnknown: 0 });
    expect(calls).toBe(2);
    for (const text of [...quotes, dataset.questions[0]!.question, root, 'forty seven dollars', 'Synthetic 1']) expect(stdout + stderr).not.toContain(text);
    console.log(JSON.stringify({ acceptance: 1, questions: receipt.questions, foundDoc: receipt.foundDoc, foundParagraph: receipt.foundParagraph,
      answeredCorrectly: receipt.answeredCorrectly, neededFiles: receipt.neededFiles, neededFilesRead: receipt.neededFilesRead }));
    const today = await runPanelEval({ isolation: { dataRoot: root, allowNoFdCheck: true }, dataset, modelBaseUrl: baseUrl, model: 'synthetic-model', limits: 'today', split: 'sealed' });
    expect(today).toMatchObject({ questions: 0, maxItems: 4, maxPromptBytes: 11000 });
    expect(today).not.toHaveProperty('rows');
    const empty = await runPanelEval({ isolation: { dataRoot: root, allowNoFdCheck: true },
      dataset: { ...dataset, questions: [{ id: 'q2', shape: 'coverage_negative', question: 'zzzxxyyqq' }] },
      modelBaseUrl: baseUrl, model: 'synthetic-model', limits: 'today' });
    expect(empty).toMatchObject({ questions: 1, foundDoc: 0, foundParagraph: 0, noEvidence: 1, answeredCorrectly: 0, judgeUnknown: 1 });
    expect(empty.rows![0]).toMatchObject({ filesRead: 0, neededFilesRead: 0 });
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test('needed files remain optional and malformed lists fail closed', () => {
  const question = dataset.questions[0]!;
  const { neededFiles, ...legacy } = question;
  expect(() => validatePassageDataset({ ...dataset, questions: [legacy] })).not.toThrow();
  for (const bad of [null, {}, [{ corpusId }], [{ corpusId: '', providerItemId: 'f1' }]]) {
    expect(() => validatePassageDataset({ ...dataset, questions: [{ ...question, neededFiles: bad }] })).toThrow();
  }
});

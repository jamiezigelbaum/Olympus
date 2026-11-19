import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureConnector, openTierFixture, JUDGED_PERSONAL_SNIFFER, CORPORA } from './helpers/tier-fixtures.ts';
import type { PassageReceipt } from '../eval/run-passages.ts';

const quote = 'The cafe amber violet silver cedar';
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'passage-answer-cli-'));
  const world = openTierFixture(root, { embed: false });
  try {
    await world.set.sync(fixtureConnector(() => [{ id: 'one', name: 'Synthetic', text: `${quote}. ${'synthetic filler '.repeat(1000)}` }]),
      { fetchContent: true, tierClassification: { sniffer: JUDGED_PERSONAL_SNIFFER } });
  } finally { world.close(); }
  const dataset = join(root, 'questions.json');
  writeFileSync(dataset, JSON.stringify({ version: '2', description: 'Synthetic', questions: [
    { id: 'one', shape: 'value_lookup', question: 'What cafe amber violet silver cedar?', expectedEvidence: [{ corpusId: CORPORA.internal, providerItemId: 'one', quote, hint: '' }] },
  ] }));
  return { root, dataset, output: join(root, 'receipt.json') };
}
async function run(input: Awaited<ReturnType<typeof fixture>>, baseUrl: string, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, 'eval/run-passages.ts', '--data-root', input.root, input.dataset, '--output', input.output, ...args], {
    env: { ...process.env, OLYMPUS_ARGUS_SOURCE_ANSWER_BASE_URL: baseUrl, OLYMPUS_ARGUS_SOURCE_ANSWER_MODEL: 'synthetic-answer',
      OLYMPUS_SOURCE_INDEX_ANALYST_LANE: '', OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE: '', OLYMPUS_EVAL_ANALYST_PROVIDER: 'local',
      OLYMPUS_SOURCE_RERANKER: 'off', ...env }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test('CLI --answer uses the local source_answer profile, compact prompt and the requested budget', async () => {
  const input = await fixture();
  const prompts: string[] = [];
  const models: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'synthetic-answer' }] });
    const body = await request.json() as { model: string; messages: { content: string }[] };
    models.push(body.model);
    prompts.push(body.messages.map(message => message.content).join('\n\n'));
    return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({
      answer: 'cafe amber violet silver', citations: [{ evidence: 1, claim: 'cafe amber violet silver' }], unanswered: [], sufficient: true,
    }) } }] });
  } });
  try {
    const result = await run(input, `http://127.0.0.1:${server.port}/v1`, ['--answer', '--prompt-bytes', '5000']);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('load_analyst');
    expect(result.stderr).toContain('question 1/1: answer');
    expect(models.length).toBeGreaterThan(0);
    expect(models.every(model => model === 'synthetic-answer')).toBe(true);
    expect(prompts[0]).toContain('Each evidence item starts with its number');
    expect(new TextEncoder().encode(prompts[0]).length).toBeLessThanOrEqual(5000);
    const receipt = JSON.parse(readFileSync(input.output, 'utf8')) as PassageReceipt;
    expect(receipt.questions![0]!.answer).toMatchObject({ outcome: 'answered', cited: true, coverage: 0.8, right: true });
    expect(receipt.summary.byLength['4+_chunks']!.answer!.right).toBe(1);
    expect(result.stdout).not.toContain(quote);
  } finally { server.stop(true); rmSync(input.root, { recursive: true, force: true }); }
}, 30_000);

test('CLI --answer fails with a content-free failure line and code when the local model is unavailable', async () => {
  const input = await fixture();
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('Synthetic private error sentinel', { status: 503 }) });
  try {
    const result = await run(input, `http://127.0.0.1:${server.port}/v1`, ['--answer']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Passage eval failed at load_analyst: Error (LOCAL_MODEL_UNAVAILABLE); no content is logged.');
    expect(result.stderr).not.toContain('Synthetic private error sentinel');
    expect(existsSync(input.output)).toBe(false);
    // Retrieval alone must not try to contact that model.
    const retrieval = await run(input, `http://127.0.0.1:${server.port}/v1`, []);
    expect(retrieval.code).toBe(0);
    expect(retrieval.stderr).not.toContain('load_analyst');
  } finally { server.stop(true); rmSync(input.root, { recursive: true, force: true }); }
}, 30_000);

test('CLI --answer refuses a nonlocal analyst provider', async () => {
  const input = await fixture();
  try {
    const result = await run(input, 'http://127.0.0.1:1/v1', ['--answer', '--analyst-provider', 'venice']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('(LOCAL_MODEL_REQUIRED)');
    expect(existsSync(input.output)).toBe(false);
  } finally { rmSync(input.root, { recursive: true, force: true }); }
}, 30_000);

test('CLI --deep-read-trigger runs the shared whole-item job and records only counts', async () => {
  const input = await fixture();
  let calls = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/props') return Response.json({ n_ctx: 8192 });
    if (path.endsWith('/models')) return Response.json({ data: [{ id: 'synthetic-answer', max_model_len: 8192 }] });
    const body = await request.json() as { model: string };
    const ordinary = calls++ === 0;
    return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({
      answer: ordinary ? 'Not found.' : quote,
      citations: ordinary ? [] : [{ evidence: 1, claim: quote }], unanswered: [], sufficient: true,
    }) } }] });
  } });
  try {
    const result = await run(input, `http://127.0.0.1:${server.port}/v1`, ['--deep-read-trigger', '--prompt-bytes', '5000', '--max-chars-per-candidate', '100']);
    expect(result.code).toBe(0);
    const receipt = JSON.parse(readFileSync(input.output, 'utf8')) as PassageReceipt;
    expect(receipt.summary.deepReadStarted).toBe(1);
    const deep = receipt.questions![0]!.deepRead!;
    expect(deep).toMatchObject({ triggered: true, refused: null, citesExpected: true, correctByMeaning: null });
    expect(deep.sectionsTotal).toBeGreaterThan(0);
    expect(deep.sectionsDone).toBe(deep.sectionsTotal);
    expect(calls).toBeGreaterThan(1);
    expect(JSON.stringify(receipt)).not.toContain(quote);
    expect(result.stdout).not.toContain(quote);
    expect(result.stdout).not.toContain('What cafe');
  } finally { server.stop(true); rmSync(input.root, { recursive: true, force: true }); }
}, 30_000);

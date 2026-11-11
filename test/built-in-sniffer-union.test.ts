import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createBuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { runBuiltInUnionFixture } from './helpers/built-in-union.ts';
import { QWEN35_2B, QWEN35_4B, QWEN35_9B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import { createDecisionSnifferModel } from '../src/workers/classification/sniffer-decision.ts';
import { completeSnifferQuestion } from '../src/workers/classification/sniffer-resolver.ts';
import { initialSnifferMode, snifferLaneOffersDecision, type SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { snifferTierKey, snifferDecisionBar } from '../src/workers/classification/sniffer.ts';

const cleanup: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
let sequence = 0;
function fake(options: { chance?: number; tier?: string; confidence?: number; failure?: 'mass' | 'error' | 'timeout'; sharedToken?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-union-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const prefix = `/fixture-${++sequence}`;
  const events: Array<{ path: string; body: any }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(request.headers.get('authorization')).toBe('Bearer fixture-token');
    const path = new URL(request.url).pathname.slice(prefix.length);
    if (path === '/props') return Response.json({});
    const body = await request.json() as any;
    events.push({ path, body });
    if (path === '/v1/chat/completions') return Response.json({ choices: [{ message: { content: JSON.stringify({ verdicts: [
      { i: 1, tier: options.tier ?? 'personal', category: 'ordinary', confidence: options.confidence ?? 0.95, ownRecord: false, privateKind: 'none' },
    ] }) } }] });
    if (path === '/apply-template') return Response.json({ prompt: body.messages.map((m: { role: string; content: string }) => `<${m.role}>${m.content}</${m.role}>`).join('') + '<assistant>' });
    if (path === '/tokenize') return Response.json({ tokens: [{ piece: options.sharedToken ? 'p' : body.content }] });
    if (path === '/completion') {
      expect(body.id_slot).toBe(0);
      if (body.n_predict === 0) return Response.json({});
      if (options.failure === 'error') return new Response('sensitive echoed material', { status: 500 });
      if (options.failure === 'timeout') return new Promise<Response>(() => {});
      const chance = options.chance ?? 0.6;
      return Response.json({ completion_probabilities: [{ top_logprobs: options.failure === 'mass' ? [] : [
        { token: options.sharedToken ? 'rivate' : 'private', logprob: Math.log(chance) },
        { token: options.sharedToken ? 'ersonal' : 'personal', logprob: Math.log(1 - chance) },
      ] }] });
    }
    return new Response('', { status: 404 });
  } });
  cleanup.push(() => server.stop(true));
  const endpoint = `http://127.0.0.1:${server.port}${prefix}`;
  return { dir, endpoint, events };
}

async function run(f: ReturnType<typeof fake>, worker: boolean, timeoutMs = 1_000) {
  const options = { dir: f.dir, endpoint: f.endpoint, timeoutMs };
  if (!worker) return runBuiltInUnionFixture(options);
  const path = join(f.dir, 'judge-worker.ts');
  writeFileSync(path, `import { parentPort, workerData } from 'node:worker_threads';
import { createBuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { runBuiltInUnionFixture } from ${JSON.stringify(join(import.meta.dir, 'helpers/built-in-union.ts'))};
parentPort.postMessage(await runBuiltInUnionFixture(workerData)); parentPort.close();`);
  const thread = new Worker(path, { workerData: options });
  cleanup.push(() => thread.terminate());
  return await new Promise<Awaited<ReturnType<typeof runBuiltInUnionFixture>>>((resolve, reject) => {
    thread.once('message', resolve); thread.once('error', reject);
    thread.once('exit', code => { if (code !== 0) reject(new Error(`judge worker exited ${code}`)); });
  });
}

for (const worker of [false, true]) {
  for (const chance of [0.6, 0.4, 0.5]) test(`built-in full Personal + decision ${chance}; worker=${worker}`, async () => {
    const f = fake({ chance, sharedToken: true });
    const result = await run(f, worker);
    const tier = chance >= 0.5 ? 'secure' : 'private';
    expect(result.row?.contentTier).toBe(tier);
    expect(result.reread).toMatchObject({ verdict: 'decided', tier });
    expect(result.cached?.failSafe).toBe(false);
    expect(f.events.filter(e => e.path === '/v1/chat/completions')).toHaveLength(1);
    expect(f.events.filter(e => e.path === '/completion')).toHaveLength(1);
    const decision = f.events.find(e => e.path === '/completion')!.body;
    expect(decision).toMatchObject({ n_predict: 1, n_probs: 40, id_slot: 0, temperature: 0 });
    expect(decision.prompt).toContain('Bring apples');
    if (chance >= 0.5) expect(result.row?.reasons.some(r => r.endsWith(`union:decision:${chance.toFixed(2)}`))).toBe(true);
  });

  for (const [tier, confidence] of [['private', 0.95], ['personal', 0.89]] as const) test(`full holds ${tier} ${confidence}, no native call; worker=${worker}`, async () => {
    const f = fake({ tier, confidence });
    const result = await run(f, worker);
    expect(result.row?.contentTier).toBe('secure');
    expect(f.events.map(e => e.path)).toEqual(['/v1/chat/completions']);
  });

  for (const failure of ['mass', 'error', 'timeout'] as const) test(`decision ${failure} fails safe through persistence; worker=${worker}`, async () => {
    const f = fake({ failure });
    const result = await run(f, worker, failure === 'timeout' ? 100 : 1_000);
    expect(result.row?.contentTier).toBe('secure');
    expect(result.cached).toMatchObject({ tier: 'private', failSafe: true, category: 'union_decision' });
    expect(result.reread).toMatchObject({ tier: 'secure', code: 'union:decision:failed' });
    expect(result.report.failSafePrivate).toBe(1);
    expect(f.events.filter(e => e.path === '/completion' && e.body.n_predict === 1)).toHaveLength(1);
  });
}

for (const spec of [QWEN35_2B, QWEN35_9B]) test(`${spec.displayName} is unaffected`, async () => {
  const f = fake();
  expect((await runBuiltInUnionFixture({ ...f, spec })).row?.contentTier).toBe('private');
  expect(f.events.map(e => e.path)).toEqual(['/v1/chat/completions']);
});

test('configured 4B retains native 0.15 bar; built-in keeps full primary even if decision requested', async () => {
  const f = fake({ chance: 0.4 });
  const lane: SnifferLane = { kind: 'local', profileId: 'fixture', modelId: QWEN35_4B.modelId,
    profile: { provider: 'local-openai-compatible', trust: 'local', model: QWEN35_4B.modelId, baseUrl: f.endpoint, snifferMode: 'decision' } };
  const model = createDecisionSnifferModel(lane, { complete: async () => { throw new Error('no full call'); } }, { apiKey: 'fixture-token' });
  await model.prepareSniffer?.();
  const result = await completeSnifferQuestion(model, { pass: 'content', material: 'Picnic plans' });
  expect(snifferDecisionBar(lane)).toBe(0.15);
  expect(snifferTierKey(result.decisionVerdict!, snifferDecisionBar(lane))).toBe('secure');
  const builtIn: SnifferLane = { ...lane, profileId: 'built_in', profile: { ...lane.profile, provider: 'built-in', purpose: 'classification', model: QWEN35_4B.modelId } };
  expect(initialSnifferMode(builtIn.profile)).toBe('full');
  expect(snifferLaneOffersDecision(builtIn)).toBe(true);
});

test('native union uses the authenticated server started by the production lifecycle worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-union-lifecycle-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'llama-server');
  const events = join(dir, 'events.jsonl');
  writeFileSync(script, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (value('--parallel') !== '1') process.exit(1);
const token = (await Bun.file(value('--api-key-file')).text()).trim();
Bun.serve({ hostname: '127.0.0.1', port: Number(value('--port')), async fetch(request) {
 const path = new URL(request.url).pathname;
 if (path === '/health') return Response.json({});
 if (request.headers.get('authorization') !== 'Bearer ' + token) return new Response('', { status: 401 });
 if (path === '/v1/models') return Response.json({ data: [{ id: process.env.LLAMA_ARG_ALIAS }] });
 const body = await request.json();
 appendFileSync(${JSON.stringify(events)}, JSON.stringify({ path, n_predict: body.n_predict, id_slot: body.id_slot }) + '\\n');
 if (path === '/v1/chat/completions') return Response.json({ choices: [{ message: { content: JSON.stringify({ verdicts: [{ i: 1, tier: 'personal', confidence: 0.9, category: 'ordinary', ownRecord: false, privateKind: 'none' }] }) } }] });
 if (path === '/apply-template') return Response.json({ prompt: body.messages.map(m => '<' + m.role + '>' + m.content + '</' + m.role + '>').join('') });
 if (path === '/tokenize') return Response.json({ tokens: [{ piece: body.content }] });
 if (path === '/completion') return Response.json({ completion_probabilities: [{ top_logprobs: [{ token: 'private', logprob: Math.log(0.6) }, { token: 'personal', logprob: Math.log(0.4) }] }] });
 return new Response('', { status: 404 });
} });
`);
  chmodSync(script, 0o755);
  const model = createBuiltInAnalystModel({ model: QWEN35_4B, env: { OLYMPUS_BUILT_IN_REASONING_DIR: dir },
    install: async () => ({ modelPath: join(dir, 'synthetic.gguf'), serverPath: script, gpu: false }),
    idleShutdownSeconds: 0,
  });
  cleanup.push(() => model.stop());
  await model.prepare();
  const answer = await completeSnifferQuestion(model, { pass: 'content', material: 'Bring apples to the picnic.' });
  expect(answer.decisionVerdict).toMatchObject({ tier: 'private', category: 'union_decision', failSafe: false });
  const calls = readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls.filter(call => call.path === '/v1/chat/completions')).toHaveLength(1);
  expect(calls.filter(call => call.path === '/completion')).toEqual([{ path: '/completion', n_predict: 1, id_slot: 0 }]);
});

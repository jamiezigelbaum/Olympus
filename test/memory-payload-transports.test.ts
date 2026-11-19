import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalystModel } from '../src/core/analyst.ts';
import { createBuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { createVeniceAnalystModel } from '../src/core/analyst-venice.ts';
import { defaultConfig } from '../src/core/config.ts';
import { memoryPayloadCounts } from '../src/core/memory-counters.ts';
import { WorkerBootSecretResolver } from '../src/workers/credential-degradation.ts';
import { createTierSnifferModel } from '../src/workers/engine/runtime/judging-models.ts';
import { createPrivacyQuestionEngine } from '../src/workers/classification/privacy-questions.ts';
import { secondRoundJudge } from '../src/workers/classification/judge-second-round.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { completeSnifferQuestion, prepareSnifferModel } from '../src/workers/classification/sniffer-resolver.ts';
import { createTinfoilJudgeModel } from '../src/workers/classification/sniffer-tinfoil.ts';
import { createMemoryDiagnostic } from '../src/workers/engine-split/memory.ts';
import { startLiteRtEmbedder } from '../src/workers/source-index/built-in-embedding/litert-runtime.ts';
import { modelWorkerMemoryPayloads } from '../src/workers/source-index/built-in-reasoning/off-thread.ts';
import { QWEN35_2B, QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';

const verdicts = (tier: 'personal' | 'private') => JSON.stringify({
  verdicts: [{ i: 1, tier, category: 'ordinary', confidence: 0.9, ownRecord: false, privateKind: 'none' }],
});
const question = { pass: 'content', material: 'Synthetic fixture text with café.' } as const;
const diagnosticMemory = { rss: 1024, anon: 1024 };

// The real completion consumes the body only after the test releases it.
function heldEndpoint(shouldHold: (path: string, body: Record<string, unknown>) => boolean, fullTier: 'personal' | 'private' = 'personal') {
  const arrived = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET') {
      return Response.json({ data: [{ id: 'fixture-model' }], model_path: 'fixture.gguf' });
    }
    const json = await request.text();
    const body = JSON.parse(json) as Record<string, unknown>;
    if (shouldHold(path, body)) {
      arrived.resolve(Buffer.byteLength(json));
      await release.promise;
    }
    if (path.endsWith('/apply-template')) {
      const messages = body.messages as Array<{ role: string; content: string }>;
      return Response.json({ prompt: messages.map(message => `<${message.role}>${message.content}`).join('') + '<assistant>' });
    }
    if (path.endsWith('/tokenize')) return Response.json({ tokens: [{ piece: body.content }] });
    if (path.endsWith('/completion')) return Response.json({ tokens_cached: 100, completion_probabilities: [{
      top_logprobs: [{ token: 'personal', logprob: Math.log(0.8) }, { token: 'private', logprob: Math.log(0.2) }],
    }] });
    if (path.endsWith('/decisions')) return Response.json({ answers: [{ type: 'choice', name: 'tier',
      probabilities: [{ value: 'Personal', probability: 0.8 }, { value: 'Private', probability: 0.2 }],
    }] });
    return Response.json({ choices: [{ message: { content: verdicts(fullTier) } }] });
  } });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return { arrived: arrived.promise, release: () => release.resolve(), baseUrl,
    stop: () => server.stop(true),
    fetch: ((url: string, init: RequestInit) => fetch(baseUrl + new URL(url, baseUrl).pathname, init)) as typeof fetch,
  };
}

function localJudge(baseUrl: string, snifferMode?: 'full' | 'decision') {
  const lane: SnifferLane = { kind: 'local', profileId: 'fixture', modelId: 'fixture-model', profile: {
    provider: 'local-openai-compatible', trust: 'local', model: 'fixture-model', baseUrl: baseUrl + '/v1',
    ...(snifferMode && { snifferMode }),
  } };
  const model = createTierSnifferModel({ lane, olympusConfig: defaultConfig(), env: {}, bootSecretResolver: new WorkerBootSecretResolver() })!;
  return { lane, model };
}

async function assertJudgeHeld(endpoint: ReturnType<typeof heldEndpoint>, run: () => Promise<unknown>) {
  const result = run();
  try {
    // If the model fails before reaching the held endpoint, fail with that error.
    const bodyBytes = await Promise.race([endpoint.arrived, result.then(() => { throw new Error('Judge finished before the held request.'); })]);
    expect(bodyBytes).toBeGreaterThan(0);
    expect(memoryPayloadCounts().judge_payloads).toBe(1);
    expect(memoryPayloadCounts().judge_payload_bytes).toBeGreaterThanOrEqual(bodyBytes);
    const memory = createMemoryDiagnostic({ role: 'background', log: () => {} });
    memory.sample(diagnosticMemory);
    const line = memory.write(diagnosticMemory);
    for (const prefix of ['', 'peak_', 'floor_']) {
      expect(line).toContain(` ${prefix}judge_payloads=1 `);
      expect(line).toContain(` ${prefix}judge_payload_bytes=${memoryPayloadCounts().judge_payload_bytes}`);
    }
  } finally {
    endpoint.release();
    await result.catch(() => undefined);
    endpoint.stop();
  }
  await result;
  expect(memoryPayloadCounts()).toMatchObject({ judge_payloads: 0, judge_payload_bytes: 0 });
}

test('configured OpenAI-compatible full judge holds its request in the process memory line', async () => {
  const endpoint = heldEndpoint(path => path.endsWith('/chat/completions'));
  const { model } = localJudge(endpoint.baseUrl, 'full');
  await assertJudgeHeld(endpoint, () => completeSnifferQuestion(model, question));
});

test('configured native decision judge holds its request in the process memory line', async () => {
  const endpoint = heldEndpoint((path, body) => path.endsWith('/completion') && body.n_predict === 1);
  const { model } = localJudge(endpoint.baseUrl, 'decision');
  await assertJudgeHeld(endpoint, async () => {
    const completion = await completeSnifferQuestion(model, question);
    expect(completion.decisionVerdict).toMatchObject({ tier: 'personal' });
  });
});

test('native auto capability requests before verdict dispatch have their own scope', async () => {
  const endpoint = heldEndpoint(path => path.endsWith('/apply-template'));
  const { model } = localJudge(endpoint.baseUrl + '/probe', undefined);
  await assertJudgeHeld(endpoint, () => prepareSnifferModel({ model }));
});

for (const spec of [QWEN35_2B, QWEN35_4B]) {
  test(`built-in ${spec.modelId} judge holds the request in the process memory line`, async () => {
    const union = spec === QWEN35_4B;
    const endpoint = heldEndpoint((path, body) => union
      ? path.endsWith('/completion') && body.n_predict === 1 : path.endsWith('/chat/completions'));
    const dir = mkdtempSync(join(tmpdir(), 'olympus-judge-memory-'));
    const model = createBuiltInAnalystModel({
      model: spec, totalMemoryBytes: 32 * 1024 ** 3, env: { OLYMPUS_BUILT_IN_REASONING_DIR: dir }, waitForInstall: true,
      install: async () => ({ modelPath: '/fixture.gguf', serverPath: '/fixture', gpu: false }),
      createServer: () => ({
        pid: 1, ensureRunning: async () => ({ baseUrl: endpoint.baseUrl, token: 'fixture' }), touch() {}, async stop() {},
      }),
    });
    try {
      await assertJudgeHeld(endpoint, async () => {
        const completion = await completeSnifferQuestion(model, question);
        if (union) expect(completion.decisionMetrics).toBeDefined();
      });
    } finally { await model.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const secondRound of [false, true]) {
  test(`Venice ${secondRound ? 'second round' : 'primary'} judge holds the request in the process memory line`, async () => {
    const endpoint = heldEndpoint(path => path.endsWith('/chat/completions'));
    const dir = mkdtempSync(join(tmpdir(), 'olympus-judge-memory-'));
    const modelId = 'deepseek-v4-flash-0731';
    const venice = createVeniceAnalystModel({ apiKey: 'fixture', model: modelId, thinking: 'disabled', fetchImpl: endpoint.fetch,
      catalog: { cachePath: join(dir, 'catalog.json'),
        fetchImpl: async () => Response.json({ data: [{ id: modelId, model_spec: { privacy: 'private' } }] }),
      },
    });
    const localEndpoint = secondRound ? heldEndpoint(() => false, 'private') : undefined;
    const model: AnalystModel = localEndpoint ? secondRoundJudge(localJudge(localEndpoint.baseUrl, 'full').model, venice) : venice;
    try { await assertJudgeHeld(endpoint, () => completeSnifferQuestion(model, question)); }
    finally { localEndpoint?.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('Tinfoil Decision holds the request at the attested fetch boundary', async () => {
  const endpoint = heldEndpoint(path => path.endsWith('/decisions'));
  const dir = mkdtempSync(join(tmpdir(), 'olympus-judge-memory-'));
  const model = createTinfoilJudgeModel({ apiKey: 'fixture', env: { HOME: dir, XDG_DATA_HOME: dir },
    clientFactory: () => ({ ready: async () => {}, fetch: endpoint.fetch }),
  });
  try {
    await assertJudgeHeld(endpoint, async () => {
      expect((await completeSnifferQuestion(model, question)).decisionVerdict).toMatchObject({ tier: 'personal' });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('privacy setup uses the judge scope even though it bypasses the verdict dispatcher', async () => {
  const endpoint = heldEndpoint(path => path.endsWith('/chat/completions'));
  const runtime = localJudge(endpoint.baseUrl, 'full');
  const engine = createPrivacyQuestionEngine({ runtime: async () => ({ ...runtime, approved: true }) });
  await assertJudgeHeld(endpoint, () => engine.questions('Synthetic privacy description'));
});

test('LiteRT pipe requests in the model worker reach the owning process memory line while held', async () => {
  const endpoint = heldEndpoint(() => true);
  const dir = mkdtempSync(join(tmpdir(), 'olympus-embed-memory-'));
  const helperPath = join(dir, 'helper.js');
  writeFileSync(helperPath, `
    const { model } = JSON.parse(process.argv[2]);
    console.log(JSON.stringify({ ready: true, device: 'cpu' }));
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('line', async line => {
      await fetch(model, { method: 'POST', body: line });
      const { id } = JSON.parse(line);
      console.log(JSON.stringify({ id, dimension: 2, vectors: Buffer.from(new Float32Array([1, 2]).buffer).toString('base64') }));
    });
  `);
  let helper: Awaited<ReturnType<typeof startLiteRtEmbedder>> | undefined;
  let running: Promise<Float32Array[]> | undefined;
  try {
    helper = await startLiteRtEmbedder({ model: endpoint.baseUrl, library: '', cacheDir: dir, threads: 1,
      maxInputTokens: 16, device: 'cpu', helperPath, bunPath: process.execPath });
    running = helper.embed(['synthetic café']);
    const bytes = await Promise.race([endpoint.arrived, running.then(() => { throw new Error('Helper finished before the held request.'); })]);
    expect(memoryPayloadCounts().embed_payloads).toBe(0);
    const memory = createMemoryDiagnostic({ role: 'front', workerPayloads: modelWorkerMemoryPayloads, log: () => {} });
    memory.sample(diagnosticMemory);
    expect(memory.write(diagnosticMemory)).toContain(` embed_payloads=1 embed_payload_bytes=${bytes} `);
    endpoint.release();
    expect((await running)[0]).toEqual(new Float32Array([1, 2]));
    expect(memoryPayloadCounts(modelWorkerMemoryPayloads())).toMatchObject({ embed_payloads: 0, embed_payload_bytes: 0 });
  } finally {
    endpoint.release();
    try { await running; } finally { await helper?.release(); endpoint.stop(); rmSync(dir, { recursive: true, force: true }); }
  }
});

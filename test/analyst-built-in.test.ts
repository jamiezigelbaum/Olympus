/**
 * The built-in private reasoning model (owner decision 2026-10-01): a small
 * local LLM that answers Private questions from Private evidence with zero
 * setup. These tests use a stub install, a stub or fake llama-server and a
 * stub download server. `OLYMPUS_BUILT_IN_ANALYST_REAL_TEST=1` additionally
 * runs the real model end to end (downloads ~2.7 GB once into
 * OLYMPUS_BUILT_IN_REASONING_DIR, or the default data directory).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  answerPrivately,
  builtInAnalystEnabled,
  builtInPrivateModelStatus,
  createBuiltInAnalystModel,
  echoesEvidenceScaffolding,
  PRIVATE_ANSWER_NOT_FOUND,
  privateEvidencePack,
  withBuiltInFallback,
  type BuiltInAnalystModel,
} from '../src/core/analyst-built-in.ts';
import type { Analyst, AnalystResult } from '../src/core/contracts.ts';
import { OperationError } from '../src/core/operation-error.ts';
import {
  BuiltInReasoningInstallError,
  installBuiltInReasoning,
  readBuiltInReasoningStatus,
} from '../src/workers/source-index/built-in-reasoning/install.ts';
import {
  pickBuiltInReasoningModel,
  QWEN35_2B,
  QWEN35_4B,
  QWEN35_9B,
  type BuiltInReasoningModelSpec,
  type LlamaServerRuntimeSpec,
} from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import {
  builtInReasoningThreads,
  createLlamaServerHandle,
  llamaServerArguments,
  type LlamaServerHandle,
  type LlamaServerLaunch,
} from '../src/workers/source-index/built-in-reasoning/server.ts';
import { applyBuiltInPrivateAnalyst } from '../src/workers/email-source/server.ts';

const GIB = 1024 ** 3;
const temporaryDirectories: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-built-in-reasoning-test-'));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('model choice', () => {
  test('16 GB and up gets the standard model, 8 GB the small one, less gets none', () => {
    expect(pickBuiltInReasoningModel(24 * GIB)?.modelId).toBe(QWEN35_4B.modelId);
    expect(pickBuiltInReasoningModel(16 * GIB)?.modelId).toBe(QWEN35_4B.modelId);
    expect(pickBuiltInReasoningModel(8 * GIB)?.modelId).toBe(QWEN35_2B.modelId);
    expect(pickBuiltInReasoningModel(4 * GIB)).toBeUndefined();
  });

  test('the large model is an explicit upgrade that still needs 16 GB', () => {
    expect(pickBuiltInReasoningModel(64 * GIB)?.sizeClass).toBe('standard');
    expect(pickBuiltInReasoningModel(24 * GIB, 'large')?.modelId).toBe(QWEN35_9B.modelId);
    expect(pickBuiltInReasoningModel(8 * GIB, 'large')).toBeUndefined();
    expect(pickBuiltInReasoningModel(24 * GIB, QWEN35_2B.modelId)?.modelId).toBe(QWEN35_2B.modelId);
    expect(pickBuiltInReasoningModel(24 * GIB, 'no-such-model')).toBeUndefined();
  });

  test('every pinned model is Apache-2.0 and pinned to a commit and a digest', () => {
    for (const model of [QWEN35_2B, QWEN35_4B, QWEN35_9B]) {
      expect(model.license).toBe('Apache-2.0');
      expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(model.file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.file.url).toContain(`/resolve/${model.revision}/`);
    }
  });

  test('on by default on Apple silicon only; the env switch wins', () => {
    expect(builtInAnalystEnabled({}, 'darwin-arm64')).toBe(true);
    expect(builtInAnalystEnabled({}, 'linux-x64')).toBe(false);
    expect(builtInAnalystEnabled({ OLYMPUS_BUILT_IN_ANALYST: 'on' }, 'linux-x64')).toBe(true);
    expect(builtInAnalystEnabled({ OLYMPUS_BUILT_IN_ANALYST: 'off' }, 'darwin-arm64')).toBe(false);
    expect(builtInAnalystEnabled({ OLYMPUS_BUILT_IN_ANALYST: 'on' }, 'win32-x64')).toBe(false);
  });
});

describe('llama-server launch', () => {
  const launch: LlamaServerLaunch = {
    serverPath: '/opt/llama/llama-server',
    modelPath: '/models/m.gguf',
    contextTokens: 12_288,
    gpu: true,
    threads: 4,
    idleShutdownSeconds: 600,
    startupTimeoutMs: 1_000,
  };

  test('binds loopback, reads its token from a file, caps threads and priority', () => {
    const args = llamaServerArguments(launch, 40123, '/tmp/x/token');
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value('--host')).toBe('127.0.0.1');
    expect(value('--port')).toBe('40123');
    expect(value('--api-key-file')).toBe('/tmp/x/token');
    expect(args).not.toContain('--api-key');
    expect(value('--threads')).toBe('4');
    expect(value('--prio')).toBe('-1');
    expect(value('--parallel')).toBe('1');
    expect(value('--n-gpu-layers')).toBe('999');
    expect(args).toContain('--no-webui');
    const cpuArgs = llamaServerArguments({ ...launch, gpu: false }, 1, 't');
    expect(cpuArgs[cpuArgs.indexOf('--n-gpu-layers') + 1]).toBe('0');
  });

  test('threads are half the cores, between one and four', () => {
    expect(builtInReasoningThreads(8)).toBe(4);
    expect(builtInReasoningThreads(16)).toBe(4);
    expect(builtInReasoningThreads(4)).toBe(2);
    expect(builtInReasoningThreads(1)).toBe(1);
  });

  test('a fake server process starts, authenticates, and exits when idle', async () => {
    const dir = tempDir();
    const script = join(dir, 'llama-server');
    // A stand-in llama-server: serves /health and an authenticated chat route.
    writeFileSync(script, `#!/usr/bin/env bun
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
if (at('--host') !== '127.0.0.1') process.exit(3);
const token = (await Bun.file(at('--api-key-file')).text()).trim();
Bun.serve({ hostname: '127.0.0.1', port: Number(at('--port')), fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return new Response('{}');
  if (request.headers.get('authorization') !== 'Bearer ' + token) return new Response('no', { status: 401 });
  return Response.json({ choices: [{ message: { content: '{"answer":"ok","citations":[],"unanswered":[],"sufficient":true}' } }] });
} });
`);
    chmodSync(script, 0o755);
    const handle = createLlamaServerHandle({ ...launch, serverPath: script, gpu: false, idleShutdownSeconds: 1, startupTimeoutMs: 15_000 });
    try {
      const endpoint = await handle.ensureRunning();
      expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const denied = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, { method: 'POST' });
      expect(denied.status).toBe(401);
      const allowed = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}` },
      });
      expect(allowed.status).toBe(200);
      const pid = handle.pid;
      expect(pid).toBeNumber();
      handle.touch();
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      expect(handle.pid).toBeUndefined();
    } finally {
      await handle.stop();
    }
  }, 30_000);
});

interface FakeServer extends LlamaServerHandle {
  starts: number;
}

function fakeServer(): FakeServer {
  const server: FakeServer = {
    starts: 0,
    async ensureRunning() {
      server.starts += 1;
      return { baseUrl: 'http://127.0.0.1:1', token: 'secret-token' };
    },
    touch() {},
    async stop() {},
    pid: 4242,
  };
  return server;
}

function fakeChat(content: string | ((body: Record<string, unknown>) => string)) {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(input), headers: new Headers(init?.headers), body });
    const text = typeof content === 'function' ? content(body) : content;
    return Response.json({ choices: [{ message: { content: text } }] });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function stubModel(
  content: string | ((body: Record<string, unknown>) => string),
  overrides: Partial<Parameters<typeof createBuiltInAnalystModel>[0]> = {},
): { model: BuiltInAnalystModel; requests: ReturnType<typeof fakeChat>['requests']; server: FakeServer } {
  const chat = fakeChat(content);
  const server = fakeServer();
  const env = { OLYMPUS_BUILT_IN_REASONING_DIR: tempDir() };
  const model = createBuiltInAnalystModel({
    env,
    model: QWEN35_4B,
    install: async () => ({ modelPath: '/m.gguf', serverPath: '/llama-server', gpu: true }),
    createServer: () => server,
    fetchImpl: chat.fetchImpl,
    waitForInstall: true,
    ...overrides,
  });
  return { model, requests: chat.requests, server };
}

describe('built-in AnalystModel', () => {
  test('sends the generic analyst prompt to the loopback server as one JSON object request', async () => {
    const { model, requests } = stubModel('{"answer":"x"}');
    const completion = await model.complete({ system: 'SYS', prompt: 'PROMPT', localOnly: true, maxOutputChars: 1_600 });
    expect(completion).toEqual({ text: '{"answer":"x"}', modelId: `built_in/${QWEN35_4B.modelId}` });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe('http://127.0.0.1:1/v1/chat/completions');
    expect(request!.headers.get('authorization')).toBe('Bearer secret-token');
    expect(request!.body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'PROMPT' },
    ]);
    expect(request!.body.temperature).toBe(0);
    expect(request!.body.max_tokens).toBe(800);
    expect(request!.body.response_format).toEqual({ type: 'json_object' });
  });

  test('before the first download finishes, the answer pool gets a fast local-unavailable error', async () => {
    let release: (() => void) | undefined;
    let installs = 0;
    const { model } = stubModel('{}', {
      waitForInstall: false,
      install: () => {
        installs += 1;
        return new Promise((resolve) => {
          release = () => resolve({ modelPath: '/m.gguf', serverPath: '/s', gpu: true });
        });
      },
    });
    const failure = await model.complete({ system: 's', prompt: 'p', localOnly: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OperationError);
    expect((failure as OperationError).code).toBe('argus_unreachable');
    expect((failure as OperationError).message).toContain('still downloading');
    await model.complete({ system: 's', prompt: 'p', localOnly: true }).catch(() => undefined);
    expect(installs).toBe(1);
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(model.complete({ system: 's', prompt: 'p', localOnly: true })).resolves.toMatchObject({ text: '{}' });
  });

  test('the dashboard status names the model and reads the install state without downloading', () => {
    const env = { OLYMPUS_BUILT_IN_REASONING_DIR: tempDir(), OLYMPUS_BUILT_IN_ANALYST: 'on' };
    const status = builtInPrivateModelStatus(env, 24 * GIB);
    expect(status).toMatchObject({ state: 'not_started', modelId: QWEN35_4B.modelId, displayName: 'Qwen3.5 4B', downloadBytes: QWEN35_4B.file.bytes });
    expect(builtInPrivateModelStatus(env, 2 * GIB)).toMatchObject({ enabled: false, state: 'not_started' });
  });

  test('a machine without enough memory gets no built-in model', () => {
    expect(() => createBuiltInAnalystModel({ totalMemoryBytes: 2 * GIB })).toThrow(/enough memory/);
  });
});

describe('answerPrivately', () => {
  const evidence = [
    { id: 'bank', title: 'September statement', text: 'Overdraft fee of $25.00 charged on 19 September.', locator: 'mail/009' },
    { id: 'tax', title: 'Tax notes', text: 'Estimated amount owed: $1,240.' },
  ];

  test('answers from the evidence with citations mapped back to the caller ids', async () => {
    const { model, requests } = stubModel(JSON.stringify({
      answer: 'The overdraft fee was $25.00 [1].',
      citations: [{ evidence: 1, claim: 'Overdraft fee of $25.00.' }],
      unanswered: [],
      sufficient: true,
    }));
    const answer = await answerPrivately('What was the overdraft fee?', evidence, { model });
    expect(answer.answer).toContain('The overdraft fee was $25.00');
    expect(answer.citations).toEqual([
      { id: 'bank', title: 'September statement', locator: 'mail/009', claim: 'Overdraft fee of $25.00.' },
    ]);
    expect(answer.unanswered).toEqual([]);
    expect(answer.modelId).toBe(`built_in/${QWEN35_4B.modelId}`);
    const prompt = String((requests[0]!.body.messages as Array<{ content: string }>)[1]!.content);
    expect(prompt).toContain('Question: What was the overdraft fee?');
    expect(prompt).toContain('secure_local/S4');
  });

  test('an ungrounded answer reports the gap and is never escalated', async () => {
    const { model } = stubModel(JSON.stringify({
      answer: 'Nothing in these items says.',
      citations: [],
      unanswered: ['blood pressure reading'],
      sufficient: false,
    }));
    const answer = await answerPrivately('What was my blood pressure?', evidence, { model });
    expect(answer.citations).toEqual([]);
    expect(answer.unanswered.length).toBeGreaterThan(0);
    expect(Object.keys(answer)).not.toContain('escalation');
    expect(answer.answer).not.toContain('escalation');
  });

  test('no evidence means no model call', async () => {
    const { model, requests } = stubModel('{}');
    const answer = await answerPrivately('Anything?', [], { model });
    expect(requests).toHaveLength(0);
    expect(answer.citations).toEqual([]);
    expect(answer.unanswered.length).toBeGreaterThan(0);
  });

  test('an answer that echoes the evidence blocks\' formatting is reported as not answered', async () => {
    // The live failure: a small model reproduced the evidence block for its answer.
    const echo = 'The files contain IntroductiontotheIntegralApproach.pdf [2020-02-05T13:56:40Z] trust: secure_local/S4 '
      + 'local_private_provenance: {"title":"IntroductiontotheIntegralApproach.pdf","source_label":"dropbox"} source_data: ["x"]';
    const { model } = stubModel(JSON.stringify({
      answer: echo,
      citations: [{ evidence: 1, claim: 'The statement lists a fee.' }],
      unanswered: ['citation_metadata: {"author":"x"}', 'the tax due date'],
      sufficient: true,
    }));
    const answer = await answerPrivately('What do I have about integral theory?', evidence, { model });
    expect(answer.answer).toBe(PRIVATE_ANSWER_NOT_FOUND);
    expect(answer.citations).toEqual([]);
    expect(answer.unanswered).toEqual(['the tax due date']);
  });

  test('the scaffolding check reads output shape only', () => {
    for (const echoed of [
      'trust: secure_local / S4',
      'Local_Private_Provenance: {}',
      'source_data : ["a"]',
      '{"title":"a","source_label":"dropbox"}',
      'Coverage — searched: private-answer',
    ]) expect(echoesEvidenceScaffolding(echoed)).toBe(true);
    for (const plain of [
      'The overdraft fee was $25.00, charged on 19 September.',
      'Integral theory maps experience into four quadrants: interior and exterior, individual and collective.',
      'I trust: the source says nothing about this.',
    ]) expect(echoesEvidenceScaffolding(plain)).toBe(false);
  });

  test('the prompt is fitted to the byte budget, keeping every item with a share of its passages', async () => {
    const { model, requests } = stubModel(JSON.stringify({ answer: 'Nothing here.', citations: [], unanswered: ['x'], sufficient: false }));
    const long = Array.from({ length: 8 }, (_, index) => ({
      id: `doc-${index}`,
      title: `Document ${index}`,
      text: `MARKER_${index} ${'lorem ipsum dolor sit amet '.repeat(400)}`,
    }));
    await answerPrivately('What do these say?', long, { model, maxPromptBytes: 16_000 });
    const body = requests[0]!.body.messages as Array<{ content: string }>;
    const bytes = new TextEncoder().encode(`${body[0]!.content}\n\n${body[1]!.content}`).length;
    expect(bytes).toBeLessThanOrEqual(16_000);
    for (let index = 0; index < 8; index += 1) expect(body[1]!.content).toContain(`MARKER_${index}`);
  });

  test('every evidence item is Private and local-only', () => {
    const pack = privateEvidencePack('q', evidence);
    expect(pack.candidates.every((candidate) => candidate.trustDomain === 'secure_local' && candidate.trustTier === 'S4')).toBe(true);
  });
});

describe('Private lane fallback', () => {
  const pack = privateEvidencePack('q', [{ id: 'a', text: 'x' }]);
  const answer = (label: string): AnalystResult => ({ answer: label, citations: [], unanswered: [] });
  const failing = (error: Error): Analyst => ({ analyze: async () => { throw error; } });
  const fixed = (label: string): Analyst => ({ analyze: async () => answer(label) });

  test('the built-in model answers only when the local model service is not running', async () => {
    const down = new OperationError('argus_unreachable', 'Argus fast lane is unreachable at http://127.0.0.1:28090/v1/chat/completions.');
    expect((await withBuiltInFallback(failing(down), fixed('built-in')).analyze(pack, { localOnly: true })).answer).toBe('built-in');
    expect((await withBuiltInFallback(fixed('argus'), fixed('built-in')).analyze(pack, { localOnly: true })).answer).toBe('argus');
    const slow = new OperationError('argus_unreachable', 'Argus fast lane timed out at http://x after 1000ms.');
    await expect(withBuiltInFallback(failing(slow), fixed('built-in')).analyze(pack, { localOnly: true })).rejects.toBe(slow);
    const refused = new OperationError('source_index_policy_violation', 'no');
    await expect(withBuiltInFallback(failing(refused), fixed('built-in')).analyze(pack, { localOnly: true })).rejects.toBe(refused);
  });

  test('wired into local secure-pool members only when no Venice member is configured', async () => {
    const down = failing(new OperationError('argus_unreachable', 'Argus lane is unreachable at http://127.0.0.1:28090.'));
    const entry = (id: string, backend: 'local' | 'venice' | 'cloud', analyst: Analyst) => [id, {
      profile: { id, profile: { provider: 'local-openai-compatible' as const, trust: 'local' as const, model: 'm', baseUrl: 'http://127.0.0.1:1/v1' } },
      backend,
      analyst,
    }] as const;

    const localOnly = new Map([entry('local-source-answer', 'local', down), entry('cloud', 'cloud', fixed('cloud'))]);
    expect(applyBuiltInPrivateAnalyst(localOnly, new Set(['local-source-answer']), fixed('built-in'))).toBe(true);
    expect((await localOnly.get('local-source-answer')!.analyst.analyze(pack, { localOnly: true })).answer).toBe('built-in');
    expect((await localOnly.get('cloud')!.analyst.analyze(pack, { localOnly: false })).answer).toBe('cloud');

    const withVenice = new Map([entry('local-source-answer', 'local', down), entry('venice-private', 'venice', fixed('venice'))]);
    expect(applyBuiltInPrivateAnalyst(withVenice, new Set(['local-source-answer', 'venice-private']), fixed('built-in'))).toBe(false);
    await expect(withVenice.get('local-source-answer')!.analyst.analyze(pack, { localOnly: true })).rejects.toThrow('unreachable');

    expect(applyBuiltInPrivateAnalyst(localOnly, new Set(['local-source-answer']), undefined)).toBe(false);
  });
});

describe('installer', () => {
  const runtimeBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const modelBytes = new Uint8Array(Array.from({ length: 4_096 }, (_, index) => index % 251));

  function specs(overrides: { modelSha?: string } = {}): { model: BuiltInReasoningModelSpec; runtime: LlamaServerRuntimeSpec } {
    return {
      model: {
        ...QWEN35_4B,
        modelId: 'test-model',
        file: { name: 'test.gguf', url: 'https://models.test/test.gguf', bytes: modelBytes.length, sha256: overrides.modelSha ?? sha256(modelBytes) },
      },
      runtime: {
        release: 'b0',
        license: 'MIT',
        archives: [{ platform: 'darwin-arm64', name: 'llama.tar.gz', url: 'https://runtime.test/llama.tar.gz', bytes: runtimeBytes.length, sha256: sha256(runtimeBytes), gpu: true }],
      },
    };
  }

  function server(options: { failModelAfter?: number } = {}) {
    const requests: Array<{ url: string; range: string | null }> = [];
    let modelRequests = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const range = new Headers(init?.headers).get('range');
      requests.push({ url, range });
      if (url.endsWith('llama.tar.gz')) return new Response(runtimeBytes);
      modelRequests += 1;
      const start = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      const body = modelBytes.slice(start);
      if (options.failModelAfter !== undefined && modelRequests === 1) {
        const cut = body.slice(0, options.failModelAfter);
        let sent = false;
        return new Response(new ReadableStream({
          pull(controller) {
            if (sent) {
              controller.error(new Error('connection reset'));
              return;
            }
            sent = true;
            controller.enqueue(cut);
          },
        }));
      }
      return new Response(body, { status: range ? 206 : 200 });
    }) as typeof fetch;
    return { fetchImpl, requests };
  }

  const extractArchive = (_archive: string, target: string) => {
    mkdirSync(join(target, 'llama-b0'), { recursive: true });
    writeFileSync(join(target, 'llama-b0', 'llama-server'), '#!/bin/sh\n', { mode: 0o755 });
  };

  test('downloads, verifies and installs once, reporting progress to the status file', async () => {
    const dir = tempDir();
    const env = { OLYMPUS_BUILT_IN_REASONING_DIR: dir };
    const { model, runtime } = specs();
    const { fetchImpl, requests } = server();
    const installed = await installBuiltInReasoning({ model, runtime, env, platform: 'darwin-arm64', fetchImpl, extractArchive });
    expect(readFileSync(installed.modelPath)).toEqual(Buffer.from(modelBytes));
    expect(installed.serverPath).toBe(join(dir, 'llama.cpp-b0-darwin-arm64', 'llama-b0', 'llama-server'));
    expect(installed.gpu).toBe(true);
    // A finished install says so: "verifying" left behind read as not ready forever.
    expect(readBuiltInReasoningStatus(model, env)).toMatchObject({ modelId: 'test-model', state: 'ready', percent: 100 });
    await installBuiltInReasoning({ model, runtime, env, platform: 'darwin-arm64', fetchImpl, extractArchive });
    expect(requests).toHaveLength(2);
  });

  test('a model that does not match its pinned digest is removed, never installed', async () => {
    const dir = tempDir();
    const env = { OLYMPUS_BUILT_IN_REASONING_DIR: dir };
    const { model, runtime } = specs({ modelSha: '0'.repeat(64) });
    const { fetchImpl } = server();
    const failure = await installBuiltInReasoning({ model, runtime, env, platform: 'darwin-arm64', fetchImpl, extractArchive })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BuiltInReasoningInstallError);
    expect((failure as BuiltInReasoningInstallError).reason).toBe('checksum_mismatch');
    expect(existsSync(join(dir, 'test-model', 'test.gguf'))).toBe(false);
    expect(existsSync(join(dir, 'test-model', 'test.gguf.partial'))).toBe(false);
    expect(readBuiltInReasoningStatus(model, env)).toMatchObject({ state: 'failed', failure: { reason: 'checksum_mismatch' } });
  });

  test('an interrupted model download resumes from where it stopped', async () => {
    const dir = tempDir();
    const env = { OLYMPUS_BUILT_IN_REASONING_DIR: dir };
    const { model, runtime } = specs();
    const { fetchImpl, requests } = server({ failModelAfter: 1_000 });
    await expect(installBuiltInReasoning({ model, runtime, env, platform: 'darwin-arm64', fetchImpl, extractArchive }))
      .rejects.toThrow('interrupted');
    const installed = await installBuiltInReasoning({ model, runtime, env, platform: 'darwin-arm64', fetchImpl, extractArchive });
    expect(readFileSync(installed.modelPath)).toEqual(Buffer.from(modelBytes));
    expect(requests.at(-1)!.range).toBe('bytes=1000-');
  });

  test('a stale "verifying" status over files already on disk is re-checked and ends ready, with real byte progress', async () => {
    const dir = tempDir();
    const env = { OLYMPUS_BUILT_IN_REASONING_DIR: dir };
    const { model, runtime } = specs();
    // A models directory copied from another install while it was mid-verify.
    await installBuiltInReasoning({ model, runtime, env, platform: 'darwin-arm64', fetchImpl: server().fetchImpl, extractArchive, log: () => undefined });
    writeFileSync(join(dir, 'status.json'), JSON.stringify({
      state: 'verifying', modelId: 'test-model', percent: 99, label: 'Checking the built-in private model',
      bytesDone: 0, bytesTotal: 0, updatedAt: '2026-10-01T15:47:39.072Z',
    }));
    expect(readBuiltInReasoningStatus(model, env).state).toBe('verifying');
    const { fetchImpl, requests } = server();
    const seen: Array<{ state: string; bytesDone: number; bytesTotal: number }> = [];
    const lines: string[] = [];
    await installBuiltInReasoning({
      model, runtime, env, platform: 'darwin-arm64', fetchImpl, extractArchive,
      onProgress: (status) => seen.push({ state: status.state, bytesDone: status.bytesDone, bytesTotal: status.bytesTotal }),
      log: (line) => lines.push(line),
    });
    // Nothing downloads; the install is re-checked and the status ends terminal.
    expect(requests).toHaveLength(0);
    expect(readBuiltInReasoningStatus(model, env)).toMatchObject({ state: 'ready', percent: 100 });
    expect(lines.some((line) => line.includes('stage=verify') && line.includes('done'))).toBe(true);
    expect(seen.at(-1)!.state).toBe('ready');
  });

  test('verifying reports bytes read against the file size', async () => {
    const dir = tempDir();
    const env = { OLYMPUS_BUILT_IN_REASONING_DIR: dir };
    // A digest no other test verifies, so this process has not memoised it.
    const bytes = new Uint8Array(Array.from({ length: 8_192 }, (_, index) => (index * 7) % 253));
    const { runtime } = specs();
    const model: BuiltInReasoningModelSpec = {
      ...QWEN35_4B,
      modelId: 'verify-model',
      file: { name: 'verify.gguf', url: 'https://models.test/verify.gguf', bytes: bytes.length, sha256: sha256(bytes) },
    };
    const fetchImpl = (async (input: RequestInfo | URL) => new Response(String(input).endsWith('llama.tar.gz') ? runtimeBytes : bytes)) as typeof fetch;
    const seen: Array<{ state: string; bytesDone: number; bytesTotal: number }> = [];
    await installBuiltInReasoning({
      model, runtime, env, platform: 'darwin-arm64', fetchImpl, extractArchive, log: () => undefined,
      onProgress: (status) => seen.push({ state: status.state, bytesDone: status.bytesDone, bytesTotal: status.bytesTotal }),
    });
    const verifying = seen.filter((entry) => entry.state === 'verifying' && entry.bytesTotal === bytes.length);
    expect(verifying.length).toBeGreaterThan(0);
    expect(verifying.at(-1)!.bytesDone).toBe(bytes.length);
    expect(seen.at(-1)!.state).toBe('ready');
  });

  test('a download that stops sending fails within the stall limit, and the retry resumes', async () => {
    const dir = tempDir();
    const env = { OLYMPUS_BUILT_IN_REASONING_DIR: dir };
    const { model, runtime } = specs();
    let first = true;
    const requests: Array<string | null> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('llama.tar.gz')) return new Response(runtimeBytes);
      const range = new Headers(init?.headers).get('range');
      requests.push(range);
      if (first) {
        first = false;
        // 1,000 bytes, then silence: the connection never closes.
        let sent = false;
        return new Response(new ReadableStream({
          pull(controller) {
            if (sent) return new Promise<void>(() => undefined);
            sent = true;
            controller.enqueue(modelBytes.slice(0, 1_000));
          },
        }));
      }
      const start = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      return new Response(modelBytes.slice(start), { status: range ? 206 : 200 });
    }) as typeof fetch;
    const lines: string[] = [];
    const options = { model, runtime, env, platform: 'darwin-arm64', fetchImpl, extractArchive, downloadStallMs: 50, log: (line: string) => lines.push(line) };
    const failure = await installBuiltInReasoning(options).catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason: 'download_failed' });
    expect(readBuiltInReasoningStatus(model, env)).toMatchObject({ state: 'failed', failure: { reason: 'download_failed' } });
    expect(lines.some((line) => line.includes('stage=download failed reason=download_failed'))).toBe(true);
    const installed = await installBuiltInReasoning(options);
    expect(readFileSync(installed.modelPath)).toEqual(Buffer.from(modelBytes));
    expect(requests.at(-1)).toBe('bytes=1000-');
    expect(readBuiltInReasoningStatus(model, env).state).toBe('ready');
  });

  test('an unsupported platform fails with a reason the dashboard can show', async () => {
    const { model, runtime } = specs();
    const env = { OLYMPUS_BUILT_IN_REASONING_DIR: tempDir() };
    await expect(installBuiltInReasoning({ model, runtime, env, platform: 'win32-x64', fetchImpl: server().fetchImpl }))
      .rejects.toMatchObject({ reason: 'unsupported_platform' });
  });
});

const realTest = process.env.OLYMPUS_BUILT_IN_ANALYST_REAL_TEST === '1' ? test : test.skip;

describe('real model (opt-in)', () => {
  realTest('the real built-in model answers a Private question with a citation', async () => {
    const model = createBuiltInAnalystModel({ waitForInstall: true, idleShutdownSeconds: 0 });
    try {
      const answer = await answerPrivately('How much was the overdraft fee?', [
        { id: 'bank', title: 'September statement', text: 'Your current account went overdrawn by $212.40 on 19 September; an overdraft fee of $25.00 was charged.' },
        { id: 'dentist', title: 'Dentist', text: 'Check-up confirmed for 21 October at 9:30.' },
      ], { model });
      expect(answer.answer).toContain('25');
      expect(answer.citations.map((citation) => citation.id)).toContain('bank');
      expect(answer.modelId).toStartWith('built_in/');
    } finally {
      await model.stop();
    }
  }, 30 * 60_000);
});

describe('install failure codes', () => {
  test('only fixed codes, never the message', async () => {
    const { modelInstallFailedReason } = await import('../src/core/model-install-failure.ts');
    expect(modelInstallFailedReason({ reason: 'download_failed', message: 'x' })).toBe('network');
    expect(modelInstallFailedReason({ reason: 'checksum_mismatch' })).toBe('checksum');
    expect(modelInstallFailedReason({ reason: 'disk_write_failed', message: 'ENOSPC: no space left on device, write' })).toBe('disk_full');
    expect(modelInstallFailedReason({ reason: 'disk_write_failed', message: 'EACCES /Users/me' })).toBe('unknown');
    expect(modelInstallFailedReason({ reason: 'runtime_load_failed' })).toBe('unknown');
    expect(modelInstallFailedReason(undefined)).toBe('unknown');
  });
});

describe('answer speed: bounded output, optional audit, stage timings', () => {
  const evidence = [
    { id: 'lab', title: 'Lab results', text: 'Hemoglobin 13.9 g/dL, collected 12 June 2026.' },
    { id: 'note', title: 'Clinic note', text: 'Follow-up booked for July.' },
  ];
  const reply = JSON.stringify({ answer: 'Hemoglobin was 13.9 g/dL [1].', citations: [{ evidence: 1, claim: 'Hemoglobin 13.9 g/dL.' }], unanswered: [], sufficient: true });

  test("llama-server's timings come back as usage, and a response schema becomes a json_schema grammar", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const { model } = stubModel('', {
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          choices: [{ message: { content: '{"answer":"x"}' } }],
          timings: { prompt_n: 3_900, prompt_ms: 17_582.4, predicted_n: 197, predicted_ms: 21_339.9 },
        });
      }) as typeof fetch,
    });
    const schema = { type: 'object', properties: { answer: { type: 'string', maxLength: 10 } } };
    const completion = await model.complete({ system: 's', prompt: 'p', localOnly: true, maxOutputChars: 1_000, responseSchema: schema });
    expect(completion.usage).toEqual({ promptTokens: 3_900, promptMs: 17_582, outputTokens: 197, outputMs: 21_340 });
    expect(requests[0]!.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'reply', schema } });
  });

  test('every answerPrivately call carries a bounded schema; audit off is one call; each call reports its stage and cost, never content', async () => {
    const { model, requests } = stubModel(reply);
    const calls: Array<Record<string, unknown>> = [];
    const answer = await answerPrivately('What did my June blood work show?', evidence, {
      model,
      audit: false,
      maxAnswerChars: 1_000,
      onModelCall: (call) => calls.push({ ...call }),
    });
    expect(answer.answer).toContain('13.9 g/dL');
    expect(requests).toHaveLength(1);
    const format = requests[0]!.body.response_format as { type: string; json_schema: { schema: { properties: { answer: { maxLength: number } } } } };
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.schema.properties.answer.maxLength).toBeLessThanOrEqual(1_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ stage: 'main', ok: true });
    expect(typeof calls[0]!.ms).toBe('number');
    expect(calls[0]!.promptBytes).toBeGreaterThan(0);
    expect(JSON.stringify(calls)).not.toMatch(/Hemoglobin|June|13\.9/);
  });

  test('with the audit on (the default) the second call reports as the audit stage', async () => {
    const { model, requests } = stubModel(reply);
    const stages: string[] = [];
    await answerPrivately('What did my June blood work show?', evidence, { model, onModelCall: (call) => stages.push(call.stage) });
    expect(requests).toHaveLength(2);
    expect(stages).toEqual(['main', 'audit']);
  });
});

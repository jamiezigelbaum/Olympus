// The engine split runs one built-in model server per computer, in the
// background. The front's completions travel over the background's command
// socket (switch-on Mac check, 2026-11-12: a second server in the front made
// a private answer miss its deadline). This test runs both ends in-process.
import { AsyncResource } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, spyOn, test } from 'bun:test';
import type { AnalystModelRequest } from '../src/core/analyst.ts';
import { answerPrivately, BUILT_IN_ANALYST_NAME, createBuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { fetchStreamingModel, noteModelProgress, withModelProgress } from '../src/core/model-stream.ts';
import { createUnixSocketFetch } from '../src/core/worker-transport.ts';
import { createEngineCommandHandler, EngineCommandLedger, parseEngineCommandEnvelope } from '../src/workers/engine-split/commands.ts';
import { startEngineControlPlane } from '../src/workers/engine-split/control-plane.ts';
import { completeModelInBackground, createEngineFront } from '../src/workers/engine-split/runtime.ts';
import { LocalModelPreempted, createLocalModelActivity, currentLocalInferencePriority, runBackgroundInference, runClassificationInference, runWithLocalInferenceCaller } from '../src/workers/answer-activity.ts';
import { createBuiltInPrivateAnswerModel } from '../src/workers/chatgpt/private-answer-model.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';

const TOKEN = 'engine-split-model-token';

function background(modelComplete?: (request: AnalystModelRequest) => Promise<{ text: string; modelId: string }>) {
  const ledger = new EngineCommandLedger({ instanceId: 'background-1', handlers: {} });
  const handler = createEngineCommandHandler({ authToken: TOKEN, ledger, ready: () => true, ...(modelComplete ? { modelComplete } : {}) });
  // A socket carries no async context: the background answers from its own.
  const socket = new AsyncResource('engine-background-socket');
  return ((input: RequestInfo | URL, init?: RequestInit) => socket.runInAsyncScope(() => handler(new Request(input, init)))) as typeof fetch;
}

test('a front completion runs on the background model with the same request and comes back whole', async () => {
  const seen: AnalystModelRequest[] = [];
  const fetchBackground = background(async (request) => {
    seen.push(request);
    return { text: 'answer', modelId: 'qwen', usage: { promptTokens: 3 } } as { text: string; modelId: string };
  });
  const completion = await completeModelInBackground(fetchBackground, TOKEN, {
    system: 'sys', prompt: 'evidence', localOnly: true, maxOutputChars: 900, responseSchema: { type: 'object' },
  });
  expect(completion).toEqual({ text: 'answer', modelId: 'qwen', usage: { promptTokens: 3 } } as typeof completion);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ system: 'sys', prompt: 'evidence', localOnly: true, maxOutputChars: 900, responseSchema: { type: 'object' } });
  expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
});

test('the next front Ask sees a completed start and its subsequent exit before any status publication', async () => {
  const servingPid = 1234;
  let alive = true;
  const front = createEngineFront({ env: process.env, socketPath: 'fixture.sock', authToken: TOKEN,
    processAlive: pid => alive && pid === servingPid,
    fetch: background(async () => ({ text: 'ok', modelId: 'fixture', built_in_serving_pid: servingPid })),
  });
  try {
    expect(front.servingModelPid()).toBeUndefined();
    expect(await front.completeModel({ system: 's', prompt: 'p', localOnly: true })).toEqual({ text: 'ok', modelId: 'fixture' });
    expect(front.servingModelPid()).toBe(servingPid);
    alive = false;
    expect(front.servingModelPid()).toBeUndefined();
  } finally {
    front.stop();
  }
});

test('the model\'s typed refusal reaches the front as the same error it raises in one process', async () => {
  const fetchBackground = background(async () => {
    throw new OperationError('argus_unreachable', 'The built-in private model is still downloading (40%).', 'nothing needs to be done');
  });
  const failure = await completeModelInBackground(fetchBackground, TOKEN, { system: 's', prompt: 'p', localOnly: true }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(OperationError);
  expect((failure as OperationError).code).toBe('argus_unreachable');
  expect((failure as OperationError).message).toContain('still downloading');
});

test('without a model, a wrong token or a malformed request the background runs nothing', async () => {
  const none = await completeModelInBackground(background(), TOKEN, { system: 's', prompt: 'p', localOnly: true }).catch((error: unknown) => error);
  expect(none).toBeInstanceOf(OperationError);
  let calls = 0;
  const fetchBackground = background(async () => { calls += 1; return { text: '', modelId: 'm' }; });
  const wrongToken = await completeModelInBackground(fetchBackground, 'not-the-token', { system: 's', prompt: 'p', localOnly: true }).catch((error: unknown) => error);
  expect(wrongToken).toBeInstanceOf(OperationError);
  const malformed = await fetchBackground('http://olympus-background/engine/model/complete', {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ system: 's', prompt: 1, localOnly: true }),
  });
  expect(malformed.status).toBe(400);
  expect(calls).toBe(0);
});

test('model_prepare is a command the background accepts', () => {
  expect(parseEngineCommandEnvelope({ id: 'a'.repeat(32), command: { kind: 'model_prepare' } }).command).toEqual({ kind: 'model_prepare' });
});

// Switch-on Mac check, 2026-11-12 (run 43193951592): the front's queued private
// answers reached the background as the owner's calls, so the judge never took
// its fair turn and four items stayed held for 15 minutes.
test('a front call keeps its priority in the background: background answers stay background', async () => {
  const seen: string[] = [];
  const fetchBackground = background(async () => {
    seen.push(currentLocalInferencePriority());
    return { text: 'ok', modelId: 'm' };
  });
  const request = { system: 's', prompt: 'p', localOnly: true };
  await completeModelInBackground(fetchBackground, TOKEN, request);
  await runBackgroundInference(() => completeModelInBackground(fetchBackground, TOKEN, request));
  await runClassificationInference(() => completeModelInBackground(fetchBackground, TOKEN, request));
  expect(seen).toEqual(['owner', 'background', 'maintenance']);
  const unknown = await fetchBackground('http://olympus-background/engine/model/complete', {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ ...request, priority: 'urgent' }),
  });
  expect(unknown.status).toBe(400);
  expect(seen).toHaveLength(3);
});

// 1.5 test-mac canary, 24 Nov 2026: over the split, the background's model
// bytes never reached the front, so a private answer still being written was
// stopped at its idle deadline. The front's clocks now see the background's
// progress while the completion runs.
test('model progress in the background reaches the front while the completion runs', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchBackground = background(async () => {
    noteModelProgress('qwen');
    await gate;
    return { text: 'done', modelId: 'qwen' };
  });
  const seen: string[] = [];
  const completion = withModelProgress((model) => {
    seen.push(model);
    release();
  }, () => completeModelInBackground(fetchBackground, TOKEN, { system: 's', prompt: 'p', localOnly: true }));
  expect(await completion).toEqual({ text: 'done', modelId: 'qwen' });
  expect(seen).toEqual(['qwen']);
});

// The production background serves the command socket from its control
// thread, and the model runs on the loop: progress crosses that thread
// boundary by message (PR #1672 review).
test('model progress crosses the control thread to the front', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-split-progress-'));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const plane = startEngineControlPlane({
    socketPath: join(dir, 'engine.sock'),
    authToken: TOKEN,
    instanceId: 'background-progress',
    ledger: new EngineCommandLedger({ instanceId: 'background-progress', handlers: {} }),
    modelComplete: async () => {
      noteModelProgress('qwen');
      await gate;
      return { text: 'done', modelId: 'qwen' };
    },
    onLost: () => {},
    log: () => {},
  });
  expect(plane).toBeDefined();
  try {
    plane!.setReady(true);
    const seen: string[] = [];
    const completion = await withModelProgress((model) => {
      seen.push(model);
      release();
    }, () => completeModelInBackground(createUnixSocketFetch(join(dir, 'engine.sock')), TOKEN, { system: 's', prompt: 'p', localOnly: true }));
    expect(completion).toEqual({ text: 'done', modelId: 'qwen' });
    expect(seen).toEqual(['qwen']);
  } finally {
    plane!.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each main and audit call logs all split timings and queue occupants without content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-split-trace-'));
  const socketPath = join(dir, 'engine.sock');
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const activity = createLocalModelActivity({ singleSlotResources: [BUILT_IN_ANALYST_NAME] });
  const answer = 'Hemoglobin was 13.9 g/dL';
  const reply = JSON.stringify({ answer: `${answer} [1].`, citations: [{ evidence: 1, claim: answer }], unanswered: [], sufficient: true });
  const fakeLlama = async () => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
  const model = activity.track(BUILT_IN_ANALYST_NAME, {
    async complete(request: AnalystModelRequest) {
      if (request.prompt === 'held') {
        held.resolve();
        request.signal!.addEventListener('abort', () => release.resolve(), { once: true });
        await release.promise;
        request.signal!.throwIfAborted();
      }
      const response = await fetchStreamingModel(fakeLlama, 'http://llama/v1/chat/completions', { signal: request.signal ?? null }, 'qwen');
      const parsed = await response.json() as { choices: Array<{ message: { content: string } }> };
      return { text: parsed.choices[0]!.message.content, modelId: 'private-model-name' };
    },
  });
  const plane = startEngineControlPlane({
    socketPath, authToken: TOKEN, instanceId: 'background-trace',
    ledger: new EngineCommandLedger({ instanceId: 'background-trace', handlers: {} }),
    modelComplete: model.complete, onLost: () => {}, log: () => {},
  });
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(plane).toBeDefined();
    plane!.setReady(true);
    const fetchBackground = createUnixSocketFetch(socketPath);
    const complete = (request: AnalystModelRequest) => completeModelInBackground(fetchBackground, TOKEN, request);
    const occupying = runBackgroundInference(() => runWithLocalInferenceCaller('keyword_translation', () =>
      complete({ system: 'private fixture system', prompt: 'held', localOnly: true }),
    )).then(() => undefined, (error: unknown) => error);
    await held.promise;
    const front = createLocalModelActivity().track(BUILT_IN_ANALYST_NAME, {
      ...createBuiltInAnalystModel({ model: QWEN35_4B }), complete,
    }, { serialize: false });
    const panel = createBuiltInPrivateAnswerModel({
      model: front, answer: answerPrivately, available: () => true,
      eligible: async items => items.map(() => true), limits: { audit: true },
    });
    await panel.answerPrivately('What did my June blood work show?', [
      { title: 'Private lab results', trust_domain: 'secure_local', provider_item_id: 'private-item-id', chunks: ['Hemoglobin 13.9 g/dL, collected 12 June 2026.'] },
      { title: 'Private clinic note', trust_domain: 'secure_local', chunks: ['Follow-up booked for July.'] },
    ], undefined, { modelCall: () => {} });
    expect(await occupying).toBeInstanceOf(LocalModelPreempted);

    const prefix = '[private-model-call] ';
    const lines = log.mock.calls.map(args => String(args[0])).filter(line => line.startsWith(prefix));
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toMatch(/Hemoglobin|blood work|Private lab results|private-item-id|private fixture system|private-model-name|Follow-up|citation/i);
    const traces = lines.map(line => JSON.parse(line.slice(prefix.length)));
    expect(traces.map(trace => trace.stage)).toEqual(['main', 'audit']);
    expect(traces[0].call_id).not.toBe(traces[1].call_id);
    expect(traces[0].queued_behind).toEqual([{ priority: 'background', caller: 'keyword_translation' }]);
    expect(traces[1].queued_behind).toEqual([]);
    const phases = ['main_start', 'guards_done', 'forward_sent', 'bg_socket_received', 'bg_received',
      'queue_enter', 'queue_admit', 'http_sent', 'first_sse', 'last_sse', 'bg_result_posted', 'front_result', 'main_end'];
    for (const trace of traces) {
      expect(trace.call_id).toMatch(/^[a-f0-9-]{36}$/);
      expect(trace.ok).toBe(true);
      expect(trace.main_start).toBe(0);
      expect(trace.bg_loop_lag_max_ms).toBeGreaterThanOrEqual(0);
      expect(Object.keys(trace).sort()).toEqual([...phases, 'call_id', 'stage', 'ok', 'queued_behind', 'bg_loop_lag_max_ms'].sort());
      let previous = 0;
      for (const phase of phases) {
        expect(Number.isInteger(trace[phase])).toBe(true);
        expect(trace[phase]).toBeGreaterThanOrEqual(previous);
        previous = trace[phase];
      }
    }
  } finally {
    release.resolve();
    log.mockRestore();
    plane?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ending a front search aborts its active model request on the background loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-split-search-abort-'));
  const socketPath = join(dir, 'engine.sock');
  const backgroundStopped = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const plane = startEngineControlPlane({
    socketPath, authToken: TOKEN, instanceId: 'background-cancel',
    ledger: new EngineCommandLedger({ instanceId: 'background-cancel', handlers: {} }),
    async modelComplete(request) {
      request.signal!.addEventListener('abort', () => backgroundStopped.resolve(), { once: true });
      noteModelProgress('fixture');
      await finish.promise;
      return { text: 'done', modelId: 'fixture' };
    },
    onLost: () => {}, log: () => {},
  });
  const controller = new AbortController();
  try {
    expect(plane).toBeDefined();
    plane!.setReady(true);
    const pending = withModelProgress(() => controller.abort(), () => completeModelInBackground(createUnixSocketFetch(socketPath), TOKEN, {
      system: 's', prompt: 'p', localOnly: true, signal: controller.signal,
    })).then(() => 'finished', (error: Error) => error.name);
    await backgroundStopped.promise;
    expect(await pending).toBe('AbortError');
  } finally {
    finish.resolve();
    plane?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  { engine: 'combined', priority: 'maintenance' },
  { engine: 'combined', priority: 'background' },
  { engine: 'split', priority: 'maintenance' },
  { engine: 'split', priority: 'background' },
] as const)('the $engine engine gives the owner the built-in slot held by $priority', async ({ engine, priority }) => {
  const activity = createLocalModelActivity({ singleSlotResources: ['built_in'] });
  const heldStarted = Promise.withResolvers<AbortSignal>();
  const releaseHeld = Promise.withResolvers<void>();
  const ownerQueued = Promise.withResolvers<void>();
  const starts: string[] = [];
  const model = activity.track('built_in', {
    async complete(request: AnalystModelRequest) {
      starts.push(request.prompt);
      if (request.prompt === 'held') {
        heldStarted.resolve(request.signal!);
        await releaseHeld.promise;
        request.signal?.throwIfAborted();
      }
      return { text: request.prompt, modelId: 'fixture' };
    },
  }, { concurrency: 4 });
  const completeOwner = (request: AnalystModelRequest) => {
    const completion = model.complete(request);
    ownerQueued.resolve();
    return completion;
  };
  const dir = engine === 'split' ? mkdtempSync(join(tmpdir(), 'olympus-split-slot-')) : undefined;
  const socketPath = dir && join(dir, 'engine.sock');
  const plane = socketPath ? startEngineControlPlane({
    socketPath,
    authToken: TOKEN,
    instanceId: 'background-slot',
    ledger: new EngineCommandLedger({ instanceId: 'background-slot', handlers: {} }),
    modelComplete: completeOwner,
    onLost: () => {},
    log: () => {},
  }) : undefined;
  const request = (prompt: string) => ({ system: 's', prompt, localOnly: true });
  const calls: Promise<unknown>[] = [];
  try {
    if (socketPath) {
      expect(plane).toBeDefined();
      plane!.setReady(true);
    }
    const runHeld = priority === 'maintenance' ? runClassificationInference : runBackgroundInference;
    // No sniffer preempt callback. Protected sniffer calls may decline it,
    // and other background calls never have one.
    const held = runHeld(() => model.complete({ ...request('held'), signal: new AbortController().signal }))
      .then(() => 'finished', (error: Error) => error.name);
    calls.push(held);
    const heldSignal = await heldStarted.promise;
    calls.push(runClassificationInference(() => model.complete(request('next maintenance'))));
    const owner = socketPath
      ? completeModelInBackground(createUnixSocketFetch(socketPath), TOKEN, request('owner'))
      : completeOwner(request('owner'));
    calls.push(owner);
    await ownerQueued.promise;
    expect(heldSignal.aborted).toBe(true);
    expect(starts).toEqual(['held']);

    releaseHeld.resolve();
    expect(await held).toBe('AbortError');
    expect(await owner).toEqual({ text: 'owner', modelId: 'fixture' });
    await Promise.all(calls);
    expect(starts).toEqual(['held', 'owner', 'next maintenance']);
  } finally {
    releaseHeld.resolve();
    await Promise.allSettled(calls);
    plane?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

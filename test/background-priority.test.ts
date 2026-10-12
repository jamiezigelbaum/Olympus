// Priority at the shared answer boundary (docs/design/background-agents.md,
// section E): the owner's own answers come first, a background connection
// (a remote agent that is not ChatGPT) runs at most one answer at a time, the
// rest wait in a small fair queue, past it a call is refused as busy with a
// retry-after, and nothing starves. Expected orders and bodies are written
// out here, not derived from the registry.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { defaultConfig } from '../src/core/config.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import { REMOTE_ERROR_SCHEMA, remoteErrorOutput } from '../src/core/remote-result.ts';
import {
  isSourceAnswerPending,
  SourceAnswerJobRegistry,
  type SourceAnswerInteractiveWork,
  type SourceAnswerJobLimits,
  type SourceAnswerJobScope,
  type SourceAnswerPending,
  type SourceAnswerPriorityOptions,
} from '../src/core/source-answer-jobs.ts';
import { createAnswerActivity } from '../src/workers/answer-activity.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { createInProcessOperationContext, createRemoteMcpHandler, withRemoteMcpRoute } from '../src/workers/remote-mcp.ts';
import { createRemoteOpenApiHandler, withRemoteOpenApiRoutes } from '../src/workers/remote-openapi.ts';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The owner's own work in flight, driven by the test. */
function interactiveWork(): SourceAnswerInteractiveWork & { start(): void; stop(): void } {
  let count = 0;
  const listeners = new Set<() => void>();
  return {
    busy: () => count > 0,
    onIdle(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      count += 1;
    },
    stop() {
      count -= 1;
      if (count === 0) for (const listener of listeners) listener();
    },
  };
}

/** Work that records when it starts and finishes only when released. */
function heldWork(log: string[]) {
  const releases = new Map<string, (value: string) => void>();
  return {
    work: (label: string) => () => {
      log.push(`start ${label}`);
      return new Promise<string>((resolve) => releases.set(label, resolve));
    },
    finish(label: string) {
      const release = releases.get(label);
      if (!release) throw new Error(`${label} has not started`);
      release(`answer ${label}`);
    },
  };
}

const BACKGROUND = (owner: string) => owner.startsWith('remote:agent');

function registry(
  interactive: SourceAnswerInteractiveWork | undefined,
  limits: Partial<SourceAnswerJobLimits> = {},
  priority: Partial<SourceAnswerPriorityOptions> = {},
) {
  return new SourceAnswerJobRegistry({
    limits: { handoffMs: 5_000, resultWaitMs: 0, maxRunningGlobal: 3, maxRunningPerOwner: 3, ...limits },
    priority: { isBackground: BACKGROUND, ...(interactive ? { interactive } : {}), ...priority },
  });
}

function scope(jobs: SourceAnswerJobRegistry, owner: string, clientSignal?: AbortSignal): SourceAnswerJobScope {
  return { registry: jobs, owner, ...(clientSignal ? { clientSignal } : {}) };
}

const settle = () => Bun.sleep(5);

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(5);
  }
}

describe('the owner first', () => {
  test('a background answer waits while the owner\'s own work is in flight; the owner\'s ChatGPT is never queued', async () => {
    const owner = interactiveWork();
    const jobs = registry(owner);
    const log: string[] = [];
    const held = heldWork(log);
    owner.start();
    const background = jobs.run(scope(jobs, 'remote:agent-a'), held.work('agent-a'));
    await settle();
    expect(log).toEqual([]);
    expect(jobs.queued()).toBe(1);
    // The owner's ChatGPT (not a background connection) starts at once.
    const chatgpt = jobs.run(scope(jobs, 'remote:chatgpt'), held.work('chatgpt'));
    await settle();
    expect(log).toEqual(['start chatgpt']);
    held.finish('chatgpt');
    expect(await chatgpt).toBe('answer chatgpt');
    owner.stop();
    await settle();
    expect(log).toEqual(['start chatgpt', 'start agent-a']);
    held.finish('agent-a');
    // The answer is the work's own, unchanged.
    expect(await background).toBe('answer agent-a');
    expect(jobs.queued()).toBe(0);
    expect(jobs.stats().running).toBe(0);
  });

  test('background answers leave the owner a running slot', async () => {
    const jobs = registry(interactiveWork(), { maxRunningGlobal: 2 });
    const log: string[] = [];
    const held = heldWork(log);
    const a = jobs.run(scope(jobs, 'remote:agent-a'), held.work('agent-a'));
    const b = jobs.run(scope(jobs, 'remote:agent-b'), held.work('agent-b'));
    const chatgpt = jobs.run(scope(jobs, 'remote:chatgpt'), held.work('chatgpt'));
    await settle();
    expect([...log].sort()).toEqual(['start agent-a', 'start chatgpt']);
    held.finish('agent-a');
    await settle();
    expect(log.at(-1)).toBe('start agent-b');
    expect(log).toHaveLength(3);
    held.finish('agent-b');
    held.finish('chatgpt');
    expect(await Promise.all([a, b, chatgpt])).toEqual(['answer agent-a', 'answer agent-b', 'answer chatgpt']);
  });
});

describe('one running answer per background connection, queued fairly', () => {
  test('a connection\'s second question waits for its first, even with room to run it', async () => {
    const jobs = registry(interactiveWork(), { maxRunningGlobal: 3 });
    const log: string[] = [];
    const held = heldWork(log);
    const calls = [
      jobs.run(scope(jobs, 'remote:agent-a'), held.work('a1')),
      jobs.run(scope(jobs, 'remote:agent-a'), held.work('a2')),
      jobs.run(scope(jobs, 'remote:agent-b'), held.work('b1')),
    ];
    await settle();
    expect(log).toEqual(['start a1', 'start b1']);
    held.finish('b1');
    await settle();
    expect(log).toEqual(['start a1', 'start b1']);
    held.finish('a1');
    await settle();
    expect(log).toEqual(['start a1', 'start b1', 'start a2']);
    held.finish('a2');
    expect(await Promise.all(calls)).toEqual(['answer a1', 'answer a2', 'answer b1']);
  });

  test('waiting connections take turns: one that just started an answer goes behind those already waiting', async () => {
    const owner = interactiveWork();
    const jobs = registry(owner, { maxRunningGlobal: 2 }, { maxQueuedPerOwner: 3 });
    const log: string[] = [];
    const held = heldWork(log);
    owner.start();
    const calls = [
      jobs.run(scope(jobs, 'remote:agent-a'), held.work('a1')),
      jobs.run(scope(jobs, 'remote:agent-a'), held.work('a2')),
      jobs.run(scope(jobs, 'remote:agent-a'), held.work('a3')),
      jobs.run(scope(jobs, 'remote:agent-b'), held.work('b1')),
    ];
    await settle();
    expect(log).toEqual([]);
    owner.stop();
    await settle();
    expect(log).toEqual(['start a1']);
    for (const [done, next] of [['a1', 'b1'], ['b1', 'a2'], ['a2', 'a3']] as const) {
      held.finish(done);
      await settle();
      expect(log.at(-1)).toBe(`start ${next}`);
    }
    held.finish('a3');
    expect(await Promise.all(calls)).toEqual(['answer a1', 'answer a2', 'answer a3', 'answer b1']);
  });

  test('past the queue\'s bound a call is refused as busy, with a retry-after the schema accepts', async () => {
    const jobs = registry(interactiveWork(), {}, { maxQueuedPerOwner: 2, maxQueuedTotal: 3 });
    const log: string[] = [];
    const held = heldWork(log);
    const running = jobs.run(scope(jobs, 'remote:agent-a'), held.work('a1'));
    const queued = [jobs.run(scope(jobs, 'remote:agent-a'), held.work('a2')), jobs.run(scope(jobs, 'remote:agent-a'), held.work('a3'))];
    let refusal: unknown;
    await jobs.run(scope(jobs, 'remote:agent-a'), held.work('a4')).catch((error: unknown) => { refusal = error; });
    expect(refusal).toMatchObject({ code: 'source_answer_busy' });
    const body = remoteErrorOutput(refusal);
    expect(body).toEqual({
      error: 'source_answer_busy',
      message: 'Olympus is already answering as many questions as it can at once. Wait for the answers in progress (call source_answer_result with their job ids), then ask again.',
      retry_after_seconds: 30,
    });
    const validate = new Ajv2020({ strict: false }).compile(REMOTE_ERROR_SCHEMA);
    expect(validate(body)).toBe(true);
    // The bound across connections: B's first starts (there is room), B's second waits, C's is refused.
    const b = jobs.run(scope(jobs, 'remote:agent-b'), held.work('b1'));
    await settle();
    expect(log).toEqual(['start a1', 'start b1']);
    const b2 = jobs.run(scope(jobs, 'remote:agent-b'), held.work('b2'));
    await expect(jobs.run(scope(jobs, 'remote:agent-c'), held.work('c1'))).rejects.toMatchObject({ code: 'source_answer_busy' });
    for (const label of ['a1', 'b1']) held.finish(label);
    await settle();
    for (const label of ['a2', 'b2']) held.finish(label);
    await settle();
    held.finish('a3');
    expect(await Promise.all([running, ...queued, b, b2])).toEqual(['answer a1', 'answer a2', 'answer a3', 'answer b1', 'answer b2']);
  });
});

describe('no starvation, no stranded waiter', () => {
  test('a background answer held back by owner work that never pauses starts after the longest wait', async () => {
    const owner = interactiveWork();
    const jobs = registry(owner, {}, { maxWaitMs: 60 });
    const log: string[] = [];
    const held = heldWork(log);
    owner.start();
    const background = jobs.run(scope(jobs, 'remote:agent-a'), held.work('a1'));
    await Bun.sleep(20);
    expect(log).toEqual([]);
    await Bun.sleep(80);
    expect(log).toEqual(['start a1']);
    held.finish('a1');
    expect(await background).toBe('answer a1');
    owner.stop();
  });

  test('a queued call hands off like a slow answer and is collected later', async () => {
    const owner = interactiveWork();
    const jobs = registry(owner, { handoffMs: 30 });
    const log: string[] = [];
    const held = heldWork(log);
    owner.start();
    const pending = await jobs.run(scope(jobs, 'remote:agent-a'), held.work('a1')) as SourceAnswerPending;
    expect(isSourceAnswerPending(pending)).toBe(true);
    expect(log).toEqual([]);
    owner.stop();
    await settle();
    held.finish('a1');
    await settle();
    expect(await jobs.result('remote:agent-a', pending.job_id)).toBe('answer a1');
  });

  test('a client that goes away before its turn leaves the queue; a revoked connection\'s waiters are dropped', async () => {
    const owner = interactiveWork();
    const jobs = registry(owner);
    const log: string[] = [];
    const held = heldWork(log);
    owner.start();
    const client = new AbortController();
    const leaving = jobs.run(scope(jobs, 'remote:agent-a', client.signal), held.work('a1'));
    const revoked = jobs.run(scope(jobs, 'remote:agent-b'), held.work('b1'));
    await settle();
    expect(jobs.queued()).toBe(2);
    client.abort();
    await expect(leaving).rejects.toMatchObject({ name: 'AbortError' });
    jobs.dropOwner('remote:agent-b');
    await expect(revoked).rejects.toMatchObject({ name: 'AbortError' });
    expect(jobs.queued()).toBe(0);
    owner.stop();
    await settle();
    expect(log).toEqual([]);
    expect(jobs.stats().running).toBe(0);
  });
});

describe('review fixes', () => {
  test('a queued call whose connection was revoked never starts: checked at its turn', async () => {
    const owner = interactiveWork();
    const revoked = new Set<string>();
    const jobs = new SourceAnswerJobRegistry({
      limits: { handoffMs: 5_000, resultWaitMs: 0, maxRunningGlobal: 3, maxRunningPerOwner: 3 },
      isOwnerRevoked: (key) => revoked.has(key),
      priority: { isBackground: BACKGROUND, interactive: owner },
    });
    const log: string[] = [];
    const held = heldWork(log);
    owner.start();
    const first = jobs.run(scope(jobs, 'remote:agent-a'), held.work('a1'));
    const second = jobs.run(scope(jobs, 'remote:agent-a'), held.work('a2'));
    const other = jobs.run(scope(jobs, 'remote:agent-b'), held.work('b1'));
    await settle();
    const outcomes = Promise.allSettled([first, second]);
    revoked.add('remote:agent-a');
    owner.stop();
    const settled = await outcomes;
    expect(settled.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    for (const outcome of settled) expect((outcome as PromiseRejectedResult).reason).toMatchObject({ name: 'AbortError' });
    await settle();
    // The revoked connection's whole queue went at once; the other connection's call took the turn.
    expect(log).toEqual(['start b1']);
    held.finish('b1');
    expect(await other).toBe('answer b1');
  });

  test('a sweep drops a revoked connection\'s queued calls before hand-off', async () => {
    const owner = interactiveWork();
    const revoked = new Set<string>();
    const jobs = new SourceAnswerJobRegistry({
      limits: { handoffMs: 5_000, resultWaitMs: 0 },
      isOwnerRevoked: (key) => revoked.has(key),
      priority: { isBackground: BACKGROUND, interactive: owner },
    });
    const log: string[] = [];
    owner.start();
    const queued = jobs.run(scope(jobs, 'remote:agent-a'), heldWork(log).work('a1'));
    await settle();
    expect(jobs.queued()).toBe(1);
    revoked.add('remote:agent-a');
    jobs.sweep();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(jobs.queued()).toBe(0);
    owner.stop();
    await settle();
    expect(log).toEqual([]);
  });

  for (const maxRunningGlobal of [1, 2]) {
    test(`an owner slot freed after the owner's activity went idle still wakes the queue (capacity ${maxRunningGlobal})`, async () => {
      const owner = interactiveWork();
      const jobs = registry(owner, { maxRunningGlobal });
      const log: string[] = [];
      const held = heldWork(log);
      owner.start();
      const chatgpt = jobs.run(scope(jobs, 'remote:chatgpt'), held.work('chatgpt'));
      const extra = maxRunningGlobal === 2 ? jobs.run(scope(jobs, 'remote:chatgpt'), held.work('chatgpt-2')) : undefined;
      const background = jobs.run(scope(jobs, 'remote:agent-a'), held.work('a1'));
      await settle();
      expect(jobs.queued()).toBe(1);
      // The owner's activity ends before the registry frees the owner's slots.
      owner.stop();
      await settle();
      held.finish('chatgpt');
      await chatgpt;
      if (extra) {
        held.finish('chatgpt-2');
        await extra;
      }
      await settle();
      expect(log.at(-1)).toBe('start a1');
      held.finish('a1');
      expect(await background).toBe('answer a1');
    });
  }

  test('at capacity one, the owner\'s ChatGPT waits its turn ahead of the next background answer instead of being refused', async () => {
    const jobs = registry(interactiveWork(), { maxRunningGlobal: 1, maxRunningPerOwner: 1 });
    const log: string[] = [];
    const held = heldWork(log);
    const a = jobs.run(scope(jobs, 'remote:agent-a'), held.work('a1'));
    await settle();
    const b = jobs.run(scope(jobs, 'remote:agent-b'), held.work('b1'));
    const chatgpt = jobs.run(scope(jobs, 'remote:chatgpt'), held.work('chatgpt'));
    await settle();
    expect(log).toEqual(['start a1']);
    held.finish('a1');
    await settle();
    expect(log).toEqual(['start a1', 'start chatgpt']);
    held.finish('chatgpt');
    await settle();
    expect(log).toEqual(['start a1', 'start chatgpt', 'start b1']);
    held.finish('b1');
    expect(await Promise.all([a, chatgpt, b])).toEqual(['answer a1', 'answer chatgpt', 'answer b1']);
  });
});

describe('review fixes, round two', () => {
  test('a full background queue never refuses the owner: its waiting allowance is its own', async () => {
    const jobs = registry(interactiveWork(), { maxRunningGlobal: 1, maxRunningPerOwner: 1 });
    const log: string[] = [];
    const held = heldWork(log);
    const calls = [jobs.run(scope(jobs, 'remote:agent-a'), held.work('a1'))];
    await settle();
    for (const agent of ['b', 'c', 'd', 'e']) {
      for (const n of [1, 2]) calls.push(jobs.run(scope(jobs, `remote:agent-${agent}`), held.work(`${agent}${n}`)));
    }
    await settle();
    expect(jobs.queued()).toBe(8);
    // The background queue is full: another background call is refused...
    await expect(jobs.run(scope(jobs, 'remote:agent-f'), held.work('f1'))).rejects.toMatchObject({ code: 'source_answer_busy' });
    // ...but the owner's ChatGPT waits, and goes next.
    const chatgpt = jobs.run(scope(jobs, 'remote:chatgpt'), held.work('chatgpt'));
    await settle();
    held.finish('a1');
    await settle();
    expect(log).toEqual(['start a1', 'start chatgpt']);
    held.finish('chatgpt');
    expect(await chatgpt).toBe('answer chatgpt');
    // Drain the rest.
    for (const label of ['b1', 'c1', 'd1', 'e1', 'b2', 'c2', 'd2', 'e2']) {
      await until(() => log.includes(`start ${label}`));
      held.finish(label);
    }
    await Promise.all(calls);
  });

  test('an overdue background call gets one turn between owner turns, however busy the owner keeps the queue', async () => {
    const jobs = registry(interactiveWork(), { maxRunningGlobal: 1, maxRunningPerOwner: 1 }, { maxWaitMs: 40 });
    const log: string[] = [];
    const held = heldWork(log);
    const a1 = jobs.run(scope(jobs, 'remote:agent-a'), held.work('a1'));
    await settle();
    const owners = [1, 2, 3].map((n) => jobs.run(scope(jobs, `remote:chatgpt-${n}`), held.work(`c${n}`)));
    const b1 = jobs.run(scope(jobs, 'remote:agent-b'), held.work('b1'));
    await Bun.sleep(60);
    held.finish('a1');
    await settle();
    expect(log).toEqual(['start a1', 'start c1']);
    // The owner's queue is replenished while it is served.
    owners.push(jobs.run(scope(jobs, 'remote:chatgpt-4'), held.work('c4')));
    held.finish('c1');
    await settle();
    expect(log.at(-1)).toBe('start b1');
    held.finish('b1');
    await settle();
    expect(log.at(-1)).toBe('start c2');
    for (const label of ['c2', 'c3', 'c4']) {
      await until(() => log.includes(`start ${label}`));
      held.finish(label);
    }
    expect(await Promise.all([a1, b1, ...owners])).toEqual(['answer a1', 'answer b1', 'answer c1', 'answer c2', 'answer c3', 'answer c4']);
  });
});

describe('answer activity kinds', () => {
  test('background leases are busy for the sniffer but not owner work; idle is said once the owner\'s last ends', async () => {
    let preempts = 0;
    const activity = createAnswerActivity(() => { preempts += 1; });
    let idles = 0;
    activity.onInteractiveIdle(() => { idles += 1; });
    const background = activity.begin('background');
    expect(activity.busy).toBe(true);
    expect(activity.interactiveInFlight).toBe(0);
    expect(preempts).toBe(1);
    const owner = activity.begin();
    const ownerToo = activity.begin('owner');
    expect(activity.interactiveInFlight).toBe(2);
    owner();
    await Bun.sleep(1);
    expect(idles).toBe(0);
    ownerToo();
    await Bun.sleep(1);
    expect(idles).toBe(1);
    background();
    await Bun.sleep(1);
    expect(idles).toBe(1);
    expect(activity.busy).toBe(false);
  });
});

describe('over HTTP', () => {
  function serve(jobs: SourceAnswerJobRegistry, store: RemoteConnectionStore, answer: () => Promise<unknown>) {
    const worker = createEmailSourceWorker({ sourceAnswer: { answer: answer as never }, sourceAnswerLatencyLog: { record() {} } });
    const remote = {
      connections: () => store,
      makeOperationContext: (caller: Parameters<typeof createInProcessOperationContext>[0]['caller'], signal: AbortSignal) =>
        createInProcessOperationContext({ config: defaultConfig(), sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller, signal, sourceAnswerJobs: jobs }),
    };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: withRemoteOpenApiRoutes(
        createRemoteOpenApiHandler(remote),
        withRemoteMcpRoute(createRemoteMcpHandler(remote), withWorkerBearerAuth(worker.fetch, { authToken: 'worker-token-for-priority-tests-0123456789' })),
      ),
    });
    cleanups.push(() => server.stop(true));
    return `http://127.0.0.1:${server.port}`;
  }

  test('a busy refusal carries Retry-After on the OpenAPI and MCP surfaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-priority-'));
    const store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
    cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const agent = store.create('Agent');
    const jobs = new SourceAnswerJobRegistry({
      limits: { handoffMs: 5_000, resultWaitMs: 0 },
      priority: { isBackground: () => true, maxQueuedPerOwner: 0, maxQueuedTotal: 0 },
    });
    let finish!: () => void;
    const base = serve(jobs, store, () => new Promise((resolve) => { finish = () => resolve({ answer: 'x' }); }));
    const call = (body: Record<string, unknown>) => fetch(`${base}/api/v1/tools/source_answer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const first = call({ question: 'first' });
    const deadline = Date.now() + 5_000;
    while (jobs.stats().running === 0) {
      if (Date.now() > deadline) throw new Error('first answer did not start');
      await Bun.sleep(5);
    }
    const busy = await call({ question: 'second' });
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('30');
    expect(await busy.json()).toMatchObject({ error: 'source_answer_busy', retry_after_seconds: 30 });

    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'source_answer', arguments: { question: 'third' } } }),
    });
    expect(mcp.status).toBe(200);
    expect(mcp.headers.get('retry-after')).toBe('30');
    const result = (await mcp.json() as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: 'source_answer_busy', retry_after_seconds: 30 });

    // A result with no retry-after gets no header.
    const list = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(list.headers.get('retry-after')).toBeNull();
    await list.text();
    finish();
    await (await first).text();
  });
});

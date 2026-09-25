// Slow source_answer hand-off (v0.5 hosted agents): a call that is not done by
// the threshold returns a connection-bound job id, the work keeps running, and
// source_answer_result returns the same released answer.
//
// The remote surfaces are assembled the way the worker assembles them (see
// test/remote-mcp.test.ts), over a real worker whose analyst is a fake that
// finishes only when a test releases it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultConfig } from '../src/core/config.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { findOperationByName, type OperationContext } from '../src/core/operations.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import {
  isSourceAnswerPending,
  SOURCE_ANSWER_HANDOFF_DEFAULT_MS,
  SOURCE_ANSWER_HANDOFF_MAX_MS,
  SourceAnswerJobRegistry,
  sourceAnswerJobLimitsFromEnv,
  sourceAnswerJobOwner,
  type SourceAnswerJobLimits,
  type SourceAnswerPending,
} from '../src/core/source-answer-jobs.ts';
import { handleMcpCallTool } from '../src/mcp/server.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import {
  createInProcessOperationContext,
  createRemoteMcpHandler,
  withRemoteMcpRoute,
} from '../src/workers/remote-mcp.ts';
import { createRemoteOpenApiHandler, withRemoteOpenApiRoutes } from '../src/workers/remote-openapi.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';

const WORKER_TOKEN = 'worker-bearer-token-for-answer-job-tests-0123456789';
const FAST: Partial<SourceAnswerJobLimits> = { handoffMs: 80, resultWaitMs: 40 };

function answerFixture(text = 'released answer'): SourceIndexAnswerResult {
  return {
    answer: text,
    evidence: [],
    audit: {
      searched_corpora: ['internal.email'],
      skipped_corpora: [],
      lane_audits: [],
      answer_synthesis: {
        analyst_backend: 'local',
        private_context_used: false,
        secure_local_items_consulted: 0,
        internal_items_consulted: 0,
        raw_source_exposed: false,
      },
      latency_ms: 5,
      raw_source_exposed: false,
    },
    policy: {
      raw_source_exposed: false,
      source_packets_exposed: false,
      internal_content_exposed: false,
      secure_local_content_exposed: false,
      castor_safe_bridge: true,
    },
    opsec: {
      structured_evidence: [],
      release_decision: { decision: 'allow', reasons: ['release_gate_passed'] },
      raw_source_exposed: false,
    },
  } as unknown as SourceIndexAnswerResult;
}

/** A fake analyst: fast by default; `hold()` makes the next answers wait for `release()`. */
function fakeAnalyst() {
  let gate: { promise: Promise<void>; resolve: () => void } | undefined;
  const analyst = {
    calls: 0,
    hold() {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      gate = { promise, resolve };
    },
    release() {
      gate?.resolve();
      gate = undefined;
    },
    async answer() {
      analyst.calls += 1;
      const waiting = gate?.promise;
      if (waiting) await waiting;
      return answerFixture();
    },
  };
  return analyst;
}

let dir: string;
let store: RemoteConnectionStore;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let analyst: ReturnType<typeof fakeAnalyst>;
let jobs: SourceAnswerJobRegistry;

function startServer(limits: Partial<SourceAnswerJobLimits> = FAST): void {
  jobs = new SourceAnswerJobRegistry({ limits });
  const worker = createEmailSourceWorker({
    sourceAnswer: { answer: () => analyst.answer() },
    sourceAnswerLatencyLog: { record() {} },
  });
  const remote = {
    connections: () => store,
    makeOperationContext: (caller: Parameters<typeof createInProcessOperationContext>[0]['caller'], signal: AbortSignal) =>
      createInProcessOperationContext({
        config: defaultConfig(),
        sourceIndexReadEnabled: true,
        workerFetch: worker.fetch,
        caller,
        signal,
        sourceAnswerJobs: jobs,
      }),
  };
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: withRemoteOpenApiRoutes(
      createRemoteOpenApiHandler(remote),
      withRemoteMcpRoute(createRemoteMcpHandler(remote), withWorkerBearerAuth(worker.fetch, { authToken: WORKER_TOKEN })),
    ),
  });
  base = `http://127.0.0.1:${server.port}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-answer-jobs-'));
  store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
  analyst = fakeAnalyst();
  startServer();
});

afterEach(() => {
  analyst.release();
  server.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function connectClient(token: string): Promise<Client> {
  const client = new Client({ name: 'answer-jobs-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
  return client;
}

async function mcpCall(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value: unknown; text: string }> {
  const client = await connectClient(token);
  try {
    // Operation errors come back as JSON-RPC errors; report them as isError.
    const result = await client.callTool({ name, arguments: args }).catch((error: unknown) => ({
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    }));
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    let value: unknown;
    try { value = JSON.parse(text); } catch { value = undefined; }
    return { isError: result.isError === true, value, text };
  } finally {
    await client.close();
  }
}

async function restCall(token: string, name: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/v1/tools/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('source_answer hand-off over remote MCP', () => {
  test('a fast answer stays a single call and leaves no job behind', async () => {
    const { token } = store.create('Claude');
    const result = await mcpCall(token, 'source_answer', { question: 'what did the lawyer say?' });
    expect(result.isError).toBe(false);
    expect((result.value as { answer: string }).answer).toBe('released answer');
    expect(isSourceAnswerPending(result.value)).toBe(false);
    expect(jobs.stats()).toEqual({ running: 0, jobs: 0 });
  });

  test('a slow answer hands off, keeps running, and the result call returns the same released answer', async () => {
    const { token } = store.create('Claude');
    const direct = await mcpCall(token, 'source_answer', { question: 'q' });

    analyst.hold();
    const first = await mcpCall(token, 'source_answer', { question: 'q' });
    expect(first.isError).toBe(false);
    const pending = first.value as SourceAnswerPending;
    expect(pending.status).toBe('working');
    expect(pending.next_tool).toBe('source_answer_result');
    expect(pending.job_id).toMatch(/^saj_[A-Za-z0-9_-]{43}$/);
    expect(pending.elapsed_ms).toBeGreaterThanOrEqual(FAST.handoffMs! - 5);
    expect(pending.message).toContain('source_answer_result');

    // The client that asked has gone; the work has not.
    const stillWorking = await mcpCall(token, 'source_answer_result', { job_id: pending.job_id });
    expect(stillWorking.value).toMatchObject({ status: 'working', job_id: pending.job_id });

    analyst.release();
    const done = await mcpCall(token, 'source_answer_result', { job_id: pending.job_id });
    expect(done.isError).toBe(false);
    // Released-content parity: byte-identical to the one-call answer.
    expect(done.text).toBe(direct.text);
    expect(analyst.calls).toBe(2);
  });

  test('another connection cannot read a job, and cannot tell it exists', async () => {
    const owner = store.create('Claude');
    const other = store.create('Grok');
    analyst.hold();
    const first = await mcpCall(owner.token, 'source_answer', { question: 'q' });
    const jobId = (first.value as SourceAnswerPending).job_id;
    analyst.release();
    await Bun.sleep(10);

    const foreign = await mcpCall(other.token, 'source_answer_result', { job_id: jobId });
    const unknown = await mcpCall(other.token, 'source_answer_result', { job_id: `saj_${'A'.repeat(43)}` });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('No Olympus answer with that job_id');
    expect(foreign.text).toBe(unknown.text);
    expect(foreign.text).not.toContain('released answer');

    const mine = await mcpCall(owner.token, 'source_answer_result', { job_id: jobId });
    expect((mine.value as { answer: string }).answer).toBe('released answer');
  });
});

describe('source_answer hand-off over OpenAPI', () => {
  test('fast is one call; slow hands off; the result path returns the answer; foreign reads are 404', async () => {
    const owner = store.create('Muse');
    const other = store.create('Other');
    const direct = await restCall(owner.token, 'source_answer', { question: 'q' });
    expect(direct.status).toBe(200);
    expect(direct.body.answer).toBe('released answer');

    analyst.hold();
    const first = await restCall(owner.token, 'source_answer', { question: 'q' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'working', next_tool: 'source_answer_result' });
    const jobId = first.body.job_id as string;

    const waiting = await restCall(owner.token, 'source_answer_result', { job_id: jobId });
    expect(waiting.status).toBe(200);
    expect(waiting.body).toMatchObject({ status: 'working', job_id: jobId });

    analyst.release();
    const done = await restCall(owner.token, 'source_answer_result', { job_id: jobId });
    expect(done.status).toBe(200);
    expect(done.body).toEqual(direct.body);

    const foreign = await restCall(other.token, 'source_answer_result', { job_id: jobId });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('source_answer_job_not_found');

    const undeclared = await restCall(owner.token, 'source_answer_result', { job_id: jobId, owner: 'x' });
    expect(undeclared.status).toBe(400);
  });

  test('the per-connection cap refuses a new question with 429 while earlier ones run', async () => {
    server.stop(true);
    startServer({ ...FAST, maxRunningPerOwner: 1 });
    const owner = store.create('Muse');
    const other = store.create('Other');
    analyst.hold();
    const first = await restCall(owner.token, 'source_answer', { question: 'q' });
    expect(first.body.status).toBe('working');
    const busy = await restCall(owner.token, 'source_answer', { question: 'q2' });
    expect(busy.status).toBe(429);
    expect(busy.body.error).toBe('source_answer_busy');
    // Another connection has its own allowance.
    const otherFirst = await restCall(other.token, 'source_answer', { question: 'q' });
    expect(otherFirst.body.status).toBe('working');
    analyst.release();
    const done = await restCall(owner.token, 'source_answer_result', { job_id: first.body.job_id as string });
    expect(done.body.answer).toBe('released answer');
    const again = await restCall(owner.token, 'source_answer', { question: 'q3' });
    expect(again.status).toBe(200);
    expect(again.body.answer).toBe('released answer');
  });

  test('the spec lists the result path and says when to call it', async () => {
    const spec = await (await fetch(`${base}/openapi.json`)).json() as {
      info: { description: string };
      paths: Record<string, { post: { responses: Record<string, unknown> } }>;
    };
    expect(Object.keys(spec.paths)).toContain('/api/v1/tools/source_answer_result');
    expect(spec.info.description).toContain('source_answer_result');
    expect(spec.paths['/api/v1/tools/source_answer_result']!.post.responses['429']).toBeDefined();
  });
});

describe('client aborts and job deadlines', () => {
  function inProcess(options: {
    registry: SourceAnswerJobRegistry;
    clientSignal: AbortSignal;
    seen: Request[];
    respond?: (request: Request) => Promise<Response>;
  }): OperationContext {
    return createInProcessOperationContext({
      config: defaultConfig(),
      sourceIndexReadEnabled: true,
      caller: { surface: 'remote', connectionId: 'conn-a', displayName: 'Claude' },
      signal: options.clientSignal,
      sourceAnswerJobs: options.registry,
      workerFetch: (request) => {
        options.seen.push(request);
        return options.respond?.(request) ?? new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
        });
      },
    });
  }

  const sourceAnswer = findOperationByName('source_answer')!;
  const sourceAnswerResult = findOperationByName('source_answer_result')!;

  test('a client disconnect before the threshold still aborts the worker request, and leaves no job', async () => {
    const registry = new SourceAnswerJobRegistry({ limits: { handoffMs: 5_000 } });
    const client = new AbortController();
    const seen: Request[] = [];
    const pending = sourceAnswer.handler(inProcess({ registry, clientSignal: client.signal, seen }), { question: 'q' });
    await Bun.sleep(5);
    expect(seen).toHaveLength(1);
    client.abort();
    await expect(pending).rejects.toThrow();
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(registry.stats()).toEqual({ running: 0, jobs: 0 });
  });

  test('after hand-off a disconnect no longer aborts; the job deadline does', async () => {
    const registry = new SourceAnswerJobRegistry({ limits: { handoffMs: 20, resultWaitMs: 200, deadlineMs: 150 } });
    const client = new AbortController();
    const seen: Request[] = [];
    const ctx = inProcess({ registry, clientSignal: client.signal, seen });
    const first = await sourceAnswer.handler(ctx, { question: 'q' }) as SourceAnswerPending;
    expect(first.status).toBe('working');
    client.abort();
    await Bun.sleep(20);
    expect(seen[0]!.signal.aborted).toBe(false);

    // A fresh request context for the result call, as a new HTTP request has.
    const later = inProcess({ registry, clientSignal: new AbortController().signal, seen: [] });
    await Bun.sleep(150);
    expect(seen[0]!.signal.aborted).toBe(true);
    const error = await sourceAnswerResult.handler(later, { job_id: first.job_id }).catch((e: unknown) => e);
    // The same error the call itself would have raised on a lane timeout.
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('email_unreachable');
  });

  test('a job that fails rethrows the error the direct call raises (the release refusal included)', async () => {
    const registry = new SourceAnswerJobRegistry({ limits: { handoffMs: 20, resultWaitMs: 500 } });
    const refusal = () => new Response(JSON.stringify({ error: 'source_index_policy_violation', message: 'Refused by the release gate.' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
    const fastCtx = inProcess({ registry, clientSignal: new AbortController().signal, seen: [], respond: async () => refusal() });
    const directError = await sourceAnswer.handler(fastCtx, { question: 'q' }).catch((e: unknown) => e) as OperationError;

    const slowCtx = inProcess({
      registry,
      clientSignal: new AbortController().signal,
      seen: [],
      respond: async () => { await Bun.sleep(60); return refusal(); },
    });
    const pending = await sourceAnswer.handler(slowCtx, { question: 'q' }) as SourceAnswerPending;
    expect(pending.status).toBe('working');
    const jobError = await sourceAnswerResult.handler(slowCtx, { job_id: pending.job_id }).catch((e: unknown) => e) as OperationError;
    expect(jobError).toBeInstanceOf(OperationError);
    expect(jobError.code).toBe(directError.code);
    expect(jobError.message).toBe(directError.message);
  });
});

describe('SourceAnswerJobRegistry', () => {
  const scope = (registry: SourceAnswerJobRegistry, owner = 'remote:a') => ({ registry, owner });

  test('results expire after the TTL', async () => {
    let now = 1_000_000;
    const registry = new SourceAnswerJobRegistry({ limits: { handoffMs: 10, resultWaitMs: 0, ttlMs: 60_000 }, now: () => now });
    let finish!: (value: string) => void;
    const pending = await registry.run(scope(registry), () => new Promise<string>((resolve) => { finish = resolve; })) as SourceAnswerPending;
    finish('answer');
    await Bun.sleep(1);
    expect(await registry.result('remote:a', pending.job_id)).toBe('answer');
    now += 59_999;
    expect(await registry.result('remote:a', pending.job_id)).toBe('answer');
    now += 1;
    await expect(registry.result('remote:a', pending.job_id)).rejects.toMatchObject({ code: 'source_answer_job_not_found' });
    expect(registry.stats().jobs).toBe(0);
  });

  test('the global cap bounds running answers across connections', async () => {
    const registry = new SourceAnswerJobRegistry({ limits: { handoffMs: 10, maxRunningPerOwner: 5, maxRunningGlobal: 2 } });
    const finishers: Array<() => void> = [];
    const work = () => new Promise<string>((resolve) => { finishers.push(() => resolve('done')); });
    expect(isSourceAnswerPending(await registry.run(scope(registry, 'remote:a'), work))).toBe(true);
    expect(isSourceAnswerPending(await registry.run(scope(registry, 'remote:b'), work))).toBe(true);
    await expect(registry.run(scope(registry, 'remote:c'), work)).rejects.toMatchObject({ code: 'source_answer_busy' });
    for (const finish of finishers) finish();
    await Bun.sleep(1);
    expect(registry.stats().running).toBe(0);
    expect(await registry.run(scope(registry, 'remote:c'), async () => 'fast')).toBe('fast');
  });

  test('retained finished jobs per owner are bounded, oldest first', async () => {
    const registry = new SourceAnswerJobRegistry({ limits: { handoffMs: 5, resultWaitMs: 0, maxRetainedPerOwner: 2 } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const pending = await registry.run(scope(registry), () => Bun.sleep(15).then(() => `a${i}`)) as SourceAnswerPending;
      ids.push(pending.job_id);
      await Bun.sleep(20);
    }
    await expect(registry.result('remote:a', ids[0])).rejects.toMatchObject({ code: 'source_answer_job_not_found' });
    expect(await registry.result('remote:a', ids[1])).toBe('a1');
    expect(await registry.result('remote:a', ids[2])).toBe('a2');
  });

  test('job ids are 256-bit and unique', async () => {
    const registry = new SourceAnswerJobRegistry({ limits: { handoffMs: 1, maxRunningPerOwner: 100, maxRunningGlobal: 100, maxRetainedPerOwner: 100 } });
    const ids = new Set<string>();
    const never = () => new Promise<never>(() => undefined);
    for (let i = 0; i < 20; i += 1) ids.add(((await registry.run(scope(registry), never)) as SourceAnswerPending).job_id);
    expect(ids.size).toBe(20);
    for (const id of ids) expect(Buffer.from(id.slice(4), 'base64url')).toHaveLength(32);
  });

  test('binding keys: a remote caller is its connection, stdio MCP its process, others never hand off', () => {
    expect(sourceAnswerJobOwner({ surface: 'remote', connectionId: 'c1' })).toBe('remote:c1');
    expect(sourceAnswerJobOwner({ surface: 'remote' })).toBeUndefined();
    expect(sourceAnswerJobOwner({ surface: 'mcp', displayName: 'claude-code' })).toBe('mcp:stdio');
    expect(sourceAnswerJobOwner({ surface: 'native' })).toBeUndefined();
    expect(sourceAnswerJobOwner({ surface: 'cli' })).toBeUndefined();
    expect(sourceAnswerJobOwner(undefined)).toBeUndefined();
  });

  test('the threshold is configurable and stays below the 240 s hosted limit', () => {
    expect(sourceAnswerJobLimitsFromEnv({})).toEqual({ handoffMs: SOURCE_ANSWER_HANDOFF_DEFAULT_MS, resultWaitMs: 60_000 });
    expect(sourceAnswerJobLimitsFromEnv({ OLYMPUS_SOURCE_ANSWER_HANDOFF_MS: '120000' }).handoffMs).toBe(120_000);
    expect(sourceAnswerJobLimitsFromEnv({ OLYMPUS_SOURCE_ANSWER_HANDOFF_MS: '999999' }).handoffMs).toBe(SOURCE_ANSWER_HANDOFF_MAX_MS);
    expect(SOURCE_ANSWER_HANDOFF_MAX_MS).toBeLessThan(240_000);
    expect(sourceAnswerJobLimitsFromEnv({ OLYMPUS_SOURCE_ANSWER_HANDOFF_MS: '5000' }).resultWaitMs).toBe(5_000);
    expect(sourceAnswerJobLimitsFromEnv({ OLYMPUS_SOURCE_ANSWER_HANDOFF_MS: 'nope' }).handoffMs).toBe(SOURCE_ANSWER_HANDOFF_DEFAULT_MS);
  });
});

describe('stdio MCP and surfaces without a registry', () => {
  function stdioContext(registry?: SourceAnswerJobRegistry, respond?: () => Promise<Response>): OperationContext {
    const ctx = createInProcessOperationContext({
      config: defaultConfig(),
      sourceIndexReadEnabled: true,
      caller: { surface: 'mcp', displayName: 'codex' },
      workerFetch: async () => (respond ? respond() : Response.json(answerFixture())),
    });
    return registry ? { ...ctx, sourceAnswerJobs: { registry, owner: sourceAnswerJobOwner(ctx.caller)! } } : ctx;
  }

  test('stdio MCP hands a slow answer off and collects it', async () => {
    const registry = new SourceAnswerJobRegistry({ limits: { handoffMs: 20, resultWaitMs: 500 } });
    const ctx = stdioContext(registry, async () => { await Bun.sleep(60); return Response.json(answerFixture('slow')); });
    const first = await handleMcpCallTool({ params: { name: 'source_answer', arguments: { question: 'q' } } }, () => ctx);
    const pending = JSON.parse(first.content[0]!.text) as SourceAnswerPending;
    expect(pending.status).toBe('working');
    const done = await handleMcpCallTool({ params: { name: 'source_answer_result', arguments: { job_id: pending.job_id } } }, () => ctx);
    expect(JSON.parse(done.content[0]!.text).answer).toBe('slow');
  });

  test('without a registry source_answer waits as before and source_answer_result finds nothing', async () => {
    const ctx = stdioContext(undefined, async () => { await Bun.sleep(30); return Response.json(answerFixture('waited')); });
    const result = await findOperationByName('source_answer')!.handler(ctx, { question: 'q' }) as { answer: string };
    expect(result.answer).toBe('waited');
    await expect(findOperationByName('source_answer_result')!.handler(ctx, { job_id: `saj_${'A'.repeat(43)}` }))
      .rejects.toMatchObject({ code: 'source_answer_job_not_found' });
  });
});

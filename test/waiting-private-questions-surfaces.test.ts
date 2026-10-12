// Waiting private questions on each surface (design
// docs/design/background-agents.md, section A): recorded at the match on the
// ChatGPT surface (never for a question typed into the private question
// panel), answered at claim time, cleared only by the panel's seen
// acknowledgment at the same generation; and, for summary-rule remote agents,
// typed Private-part outcomes, a metadata-only local probe and one fixed
// sentence on a match.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { defaultConfig } from '../src/core/config.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import { createRemotePrivateParts, remotePrivateOutcome, type PrivateMatchVerdict } from '../src/core/remote-private-part.ts';
import { REMOTE_OUTPUT_SCHEMAS, REMOTE_PRIVATE_NOTE, remoteOperationOutput } from '../src/core/remote-result.ts';
import { SourceAnswerJobRegistry } from '../src/core/source-answer-jobs.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { openWaitingPrivateQuestionStore, type WaitingQuestionStore } from '../src/core/waiting-private-questions.ts';
import { callChatGptTool, OPEN_PRIVATE_QUESTION_TOOL, SEARCH_TOOL, SOURCE_ANSWER_RESULT_TOOL, SOURCE_ANSWER_TOOL, type ChatGptSurfaceOptions } from '../src/workers/chatgpt/mcp-surface.ts';
import { PRIVATE_ANSWER_META_KEY, type PrivateAnswerModel } from '../src/workers/chatgpt/private-answer-contract.ts';
import { generatePanelKeyPair, openPrivateAnswer, type SealedPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PrivateAnswerJobs, createPrivateAnswerHandler } from '../src/workers/chatgpt/private-answer-jobs.ts';
import {
  LocalConnectorStore,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { createInProcessOperationContext, createRemoteMcpHandler } from '../src/workers/remote-mcp.ts';
import { createRemoteOpenApiHandler, withRemoteOpenApiRoutes } from '../src/workers/remote-openapi.ts';
import { probePrivateMatch, type AnalystAnswerLanes } from '../src/workers/source-index/analyst-answer.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';

const INSTALL = 'a'.repeat(32);
const PANEL_ORIGIN = 'https://olympus.web-sandbox.oaiusercontent.com';
const EVIDENCE = [{ title: 'Lease.pdf', trust_domain: 'secure_local' }];
const ALL_ELIGIBLE = async (items: readonly unknown[]) => items.map(() => true);
const CONFIG = { ...defaultConfig(), sourceIndex: { ...defaultConfig().sourceIndex, enabled: true } };

let dir: string;
let store: WaitingQuestionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-waiting-surfaces-'));
  store = openWaitingPrivateQuestionStore(join(dir, 'state', 'waiting-private-questions.sqlite'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function readyModel(): PrivateAnswerModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    status: () => ({ state: 'ready' }),
    answerPrivately: async (question) => {
      calls.push(question);
      return { answer: 'The lease ends in May.', citations: [] };
    },
  };
}

function answerResult(audit: Record<string, unknown> = {}): SourceIndexAnswerResult {
  return {
    answer: 'The released evidence does not answer this.',
    evidence: [],
    audit: { searched_corpora: [], skipped_corpora: [], lane_audits: [], latency_ms: 1, raw_source_exposed: false, ...audit },
    policy: { raw_source_exposed: false, source_packets_exposed: false, internal_content_exposed: false, secure_local_content_exposed: false, castor_safe_bridge: true },
  } as unknown as SourceIndexAnswerResult;
}

const POLICY_SKIP = { skipped_corpora: [{ corpus_id: 'secure_local.fixture.files', trust_domain: 'secure_local', reason: 'no_private_analyst_route' }] };
const UNAVAILABLE_SKIP = { skipped_corpora: [{ corpus_id: 'secure_local.fixture.files', trust_domain: 'secure_local', reason: 'private_analyst_unavailable' }] };
const DELIVERED = { answer_synthesis: { private_context_used: true, secure_local_items_consulted: 2, raw_source_exposed: false } };

// ---------------------------------------------------------------------------
// ChatGPT surface

describe('ChatGPT: recorded at the match, never from the private question panel', () => {
  function surface(jobs: PrivateAnswerJobs, probeCount = 2, answer: () => Promise<SourceIndexAnswerResult> = async () => answerResult()) {
    const worker = createEmailSourceWorker({ sourceAnswer: { answer } });
    const registry = new SourceAnswerJobRegistry({ limits: { handoffMs: 20, resultWaitMs: 0 } });
    const ctx = (connectionId = 'conn-chatgpt'): OperationContext => createInProcessOperationContext({
      config: CONFIG,
      sourceIndexReadEnabled: true,
      workerFetch: worker.fetch,
      caller: { surface: 'remote', connectionId, displayName: 'ChatGPT' },
      sourceAnswerJobs: registry,
    });
    const options: ChatGptSurfaceOptions = {
      dashboardView: async () => ({}) as never,
      evidenceSearch: async () => ({ evidence: [], coverage: {} }),
      privateMatchProbe: async () => ({ count: probeCount, evidence: EVIDENCE }),
      privateAnswers: jobs,
      waitingQuestions: () => store,
    };
    return { ctx, options };
  }

  const jobsFor = (model = readyModel()) => new PrivateAnswerJobs({
    eligible: ALL_ELIGIBLE,
    model: () => model,
    installId: () => INSTALL,
    log: () => {},
    audit: () => {},
    claimHoldMs: 0,
    acknowledge: (ref) => { store.acknowledge(ref); },
  });

  test('olympus_search with a Private match records the question for its connection; no match records nothing', async () => {
    const { ctx, options } = surface(jobsFor());
    await callChatGptTool(SEARCH_TOOL.name, { question: 'When does the lease end?', detail: 'full' }, ctx(), options);
    const { questions } = store.list();
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ connectionId: 'conn-chatgpt', surface: 'chatgpt', state: 'waiting', question: 'When does the lease end?', detail: 'full', selectors: {} });

    const none = surface(jobsFor(), 0);
    await callChatGptTool(SEARCH_TOOL.name, { question: 'Nothing private here' }, none.ctx(), none.options);
    expect(store.list().questions).toHaveLength(1);
  });

  test('source_answer records at the match, answered at once or handed off; the collector records nothing more', async () => {
    const immediate = surface(jobsFor());
    await callChatGptTool(SOURCE_ANSWER_TOOL.name, { question: 'When does the lease end?' }, immediate.ctx(), immediate.options);
    expect(store.list().questions.map((question) => question.question)).toEqual(['When does the lease end?']);

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const handed = surface(jobsFor(), 2, async () => { await held; return answerResult(); });
    const working = await callChatGptTool(SOURCE_ANSWER_TOOL.name, { question: 'Who signed the lease?' }, handed.ctx(), handed.options);
    const jobId = (working.structuredContent as { job_id?: string }).job_id!;
    expect((working.structuredContent as { status?: string }).status).toBe('working');
    // Recorded at the match, before any collector comes back (one may never come).
    expect(store.list().questions.map((question) => question.question).sort()).toEqual(['When does the lease end?', 'Who signed the lease?']);
    release();
    await Bun.sleep(50);
    const answered = await callChatGptTool(SOURCE_ANSWER_RESULT_TOOL.name, { job_id: jobId }, handed.ctx(), handed.options);
    expect((answered._meta as Record<string, Record<string, unknown>>)[PRIVATE_ANSWER_META_KEY]).toMatchObject({ state: 'ready' });
    expect(store.list().questions).toHaveLength(2);
  });

  test('open_private_question never records (the question never passes through this surface)', async () => {
    const { ctx, options } = surface(jobsFor());
    await callChatGptTool(OPEN_PRIVATE_QUESTION_TOOL.name, {}, ctx(), options);
    expect(store.list().questions).toEqual([]);
  });

  test('a store that throws never fails the tool', async () => {
    const { ctx, options } = surface(jobsFor());
    const broken: ChatGptSurfaceOptions = { ...options, waitingQuestions: () => { throw new Error('disk gone'); } };
    const result = await callChatGptTool(SEARCH_TOOL.name, { question: 'When does the lease end?' }, ctx(), broken);
    expect(result.isError === true).toBe(false);
    expect((result._meta as Record<string, Record<string, unknown>>)[PRIVATE_ANSWER_META_KEY]).toMatchObject({ state: 'ready' });
  });

  test('no synthesis until a panel claims; the rendered answer\'s ack clears the record at its generation, once', async () => {
    const model = readyModel();
    const jobs = jobsFor(model);
    const handler = createPrivateAnswerHandler({ jobs, isRelayed: (request) => request.headers.has('x-olympus-relay') });
    const post = (jobId: string, body: unknown) => handler(new Request(`http://127.0.0.1:8010/private/${jobId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PANEL_ORIGIN, 'x-olympus-relay': 's' },
      body: JSON.stringify(body),
    }));
    const { ctx, options } = surface(jobs);
    const search = async (question: string) => {
      const result = await callChatGptTool(SEARCH_TOOL.name, { question }, ctx(), options);
      return String((result._meta as Record<string, Record<string, unknown>>)[PRIVATE_ANSWER_META_KEY]!.jobId);
    };
    const collect = async (jobId: string, publicKey: string, privateKey: CryptoKey) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const response = await post(jobId, { v: 1, publicKey });
        if (response.status === 200) {
          const sealed = await response.json() as SealedPrivateAnswer;
          return JSON.parse(await openPrivateAnswer(jobId, privateKey, sealed)) as { ack: string };
        }
        await Bun.sleep(25);
      }
      throw new Error('no answer');
    };

    const first = await search('When does the lease end?');
    await Bun.sleep(30);
    // Claim-time synthesis: a job no panel claims never runs the model.
    expect(model.calls).toEqual([]);
    const panel = await generatePanelKeyPair();
    const opened = await collect(first, panel.publicKey, panel.privateKey);
    expect(model.calls).toHaveLength(1);
    expect(opened.ack).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Rendered but not yet acknowledged (or the ack was lost): still waiting.
    expect(store.list().questions).toHaveLength(1);

    // Another key, or a token from no job, is refused and clears nothing.
    expect((await post(first, { v: 1, publicKey: (await generatePanelKeyPair()).publicKey, ack: opened.ack })).status).toBe(410);
    expect((await post(first, { v: 1, publicKey: panel.publicKey, ack: 'A'.repeat(43) })).status).toBe(410);
    expect((await post(first, { v: 1, publicKey: panel.publicKey, ack: 'short' })).status).toBe(400);
    expect(store.list().questions).toHaveLength(1);

    const acked = await post(first, { v: 1, publicKey: panel.publicKey, ack: opened.ack });
    expect(acked.status).toBe(200);
    expect(await acked.json()).toEqual({ status: 'acknowledged' });
    expect(store.list().questions).toEqual([]);
    // Single use: a replay is refused.
    expect((await post(first, { v: 1, publicKey: panel.publicKey, ack: opened.ack })).status).toBe(410);

    // A newer duplicate (the same question asked again) is not cleared by the older answer's ack.
    const older = await search('Who signed the lease?');
    const olderPanel = await generatePanelKeyPair();
    const olderAnswer = await collect(older, olderPanel.publicKey, olderPanel.privateKey);
    const newer = await search('who signed  the LEASE?');
    expect(store.list().questions).toHaveLength(1);
    expect((await post(older, { v: 1, publicKey: olderPanel.publicKey, ack: olderAnswer.ack })).status).toBe(200);
    expect(store.list().questions).toHaveLength(1);

    // Another job's ack is refused on this job, and clears nothing.
    const newerPanel = await generatePanelKeyPair();
    const newerAnswer = await collect(newer, newerPanel.publicKey, newerPanel.privateKey);
    expect((await post(newer, { v: 1, publicKey: newerPanel.publicKey, ack: olderAnswer.ack })).status).toBe(410);
    expect(store.list().questions).toHaveLength(1);
    expect((await post(newer, { v: 1, publicKey: newerPanel.publicKey, ack: newerAnswer.ack })).status).toBe(200);
    expect(store.list().questions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Summary-rule remote agents

describe('remote: the Private part\'s typed outcome', () => {
  test('delivered, excluded by policy, route unavailable, or none', () => {
    expect(remotePrivateOutcome(answerResult(DELIVERED))).toBe('delivered');
    expect(remotePrivateOutcome(answerResult(POLICY_SKIP))).toBe('excluded_by_policy');
    expect(remotePrivateOutcome(answerResult({ skipped_corpora: [{ corpus_id: 'x', trust_domain: 'secure_local', reason: 'bulk_secure_local_release_requires_approval' }] }))).toBe('excluded_by_policy');
    expect(remotePrivateOutcome(answerResult(UNAVAILABLE_SKIP))).toBe('route_unavailable');
    expect(remotePrivateOutcome(answerResult())).toBe('none');
    expect(remotePrivateOutcome({ status: 'working', job_id: 'saj_x' })).toBe('none');
    expect(remotePrivateOutcome(undefined)).toBe('none');
  });
});

describe('remote: probe states and records', () => {
  function parts(verdict: PrivateMatchVerdict | 'hang' | 'throw', calls: Array<Record<string, unknown>> = []) {
    return createRemotePrivateParts({
      probe: async (request) => {
        calls.push(request);
        if (verdict === 'throw') throw new Error('probe failed');
        if (verdict === 'hang') return new Promise<PrivateMatchVerdict>(() => {});
        return verdict;
      },
      store: () => store,
      probeTimeoutMs: 30,
    });
  }
  const ARGS = { question: 'When does the lease end?', corpus_ids: ['secure_local.fixture.files'], account: 'personal', include_secure_local: true, analyst_model: 'm' };

  test('match: recorded as waiting with its selectors, and the fixed sentence; no_match: nothing', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const call = parts('match', calls).forConnection('conn-a').start('source_answer', ARGS)!;
    expect(await call.settle(answerResult(POLICY_SKIP))).toBe(true);
    // The probe searched with the request's own selectors and question only.
    expect(calls).toEqual([{ question: 'When does the lease end?', corpus_ids: ['secure_local.fixture.files'], account: 'personal' }]);
    expect(store.list().questions).toEqual([expect.objectContaining({
      connectionId: 'conn-a', surface: 'remote', state: 'waiting', question: 'When does the lease end?',
      selectors: { corpus_ids: ['secure_local.fixture.files'], account: 'personal' },
    })]);

    expect(await parts('no_match').forConnection('conn-b').start('source_answer', ARGS)!.settle(answerResult(UNAVAILABLE_SKIP))).toBe(false);
    expect(store.list().questions).toHaveLength(1);
  });

  test('unknown (timeout or error): recorded as couldn\'t check yet, never reported as a match', async () => {
    expect(await parts('hang').forConnection('conn-a').start('source_answer', ARGS)!.settle(answerResult(UNAVAILABLE_SKIP))).toBe(false);
    expect(await parts('throw').forConnection('conn-b').start('source_answer', ARGS)!.settle(answerResult(POLICY_SKIP))).toBe(false);
    expect(store.list().questions.map((question) => [question.connectionId, question.state]).sort()).toEqual([['conn-a', 'unchecked'], ['conn-b', 'unchecked']]);
  });

  test('delivered or none: no probe, no record', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const hook = parts('match', calls).forConnection('conn-a');
    expect(await hook.start('source_answer', ARGS)!.settle(answerResult(DELIVERED))).toBe(false);
    expect(await hook.start('source_answer', ARGS)!.settle(answerResult())).toBe(false);
    expect(calls).toEqual([]);
    expect(store.list().questions).toEqual([]);
    expect(hook.start('source_index_status', {})).toBeUndefined();
    expect(hook.start('ask_anonymously', { question: 'q' })).toBeUndefined();
  });

  test('selectors that cannot be stored exactly: not recorded, not probed', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const hook = parts('match', calls).forConnection('conn-a');
    expect(await hook.start('source_answer', { ...ARGS, account: 42 })!.settle(answerResult(POLICY_SKIP))).toBe(false);
    expect(await hook.start('source_answer', { ...ARGS, selected_items: [{ corpus_id: 'x', local_item_id: 'y'.repeat(5_000) }] })!.settle(answerResult(POLICY_SKIP))).toBe(false);
    // The over-bound selectors were probed but the store refused them: nothing recorded, and no sentence.
    expect(store.list().questions).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('a revocation during the call refuses its record', async () => {
    const call = parts('match').forConnection('conn-a').start('source_answer', ARGS)!;
    store.revokeConnection('conn-a');
    // Refused, so the agent is not told the answer can be seen on the computer.
    expect(await call.settle(answerResult(POLICY_SKIP))).toBe(false);
    expect(store.list().questions).toEqual([]);
  });

  test('a handed-off answer settles when its own connection collects it, once', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const remote = parts('match', calls);
    const handed = remote.forConnection('conn-a').start('source_answer', ARGS)!;
    expect(await handed.settle({ status: 'working', job_id: 'saj_job' })).toBe(false);
    expect(store.list().questions).toEqual([]);
    // Another connection naming the job, or a still-working collect: nothing.
    expect(await remote.forConnection('conn-b').start('source_answer_result', { job_id: 'saj_job' })!.settle(answerResult(POLICY_SKIP))).toBe(false);
    expect(await remote.forConnection('conn-a').start('source_answer_result', { job_id: 'saj_job' })!.settle({ status: 'working', job_id: 'saj_job' })).toBe(false);
    expect(calls).toEqual([]);
    expect(await remote.forConnection('conn-a').start('source_answer_result', { job_id: 'saj_job' })!.settle(answerResult(POLICY_SKIP))).toBe(true);
    expect(await remote.forConnection('conn-a').start('source_answer_result', { job_id: 'saj_job' })!.settle(answerResult(POLICY_SKIP))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(store.list().questions).toHaveLength(1);
  });

  test('couldn\'t-check-yet records are re-probed locally: a match waits, no match is cleared, unknown stays', async () => {
    let verdicts: Array<PrivateMatchVerdict | 'hang'> = ['hang', 'hang', 'hang', 'hang'];
    const remote = createRemotePrivateParts({
      probe: async () => {
        const next = verdicts.shift() ?? 'hang';
        return next === 'hang' ? new Promise<PrivateMatchVerdict>(() => {}) : next;
      },
      store: () => store,
      probeTimeoutMs: 20,
    });
    await remote.forConnection('conn-a').start('source_answer', ARGS)!.settle(answerResult(POLICY_SKIP));
    await remote.forConnection('conn-b').start('source_answer', ARGS)!.settle(answerResult(POLICY_SKIP));
    expect(store.unchecked()).toHaveLength(2);
    expect(await remote.retryUnchecked()).toEqual({ matched: 0, cleared: 0, still: 2 });
    verdicts = ['match', 'no_match'];
    expect(await remote.retryUnchecked()).toEqual({ matched: 1, cleared: 1, still: 0 });
    expect(store.unchecked()).toEqual([]);
    expect(store.list().questions.map((question) => question.state)).toEqual(['waiting']);
  });
});

describe('remote: the fixed sentence in slice 2\'s closed schema', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addFormat('date', /^\d{4}-\d{2}-\d{2}$/);
  const valid = (operation: keyof typeof REMOTE_OUTPUT_SCHEMAS, output: unknown) => ajv.compile(REMOTE_OUTPUT_SCHEMAS[operation])(output);

  test('only on a match; any other text in that field fails the schema', () => {
    const plain = remoteOperationOutput('source_answer', answerResult(POLICY_SKIP));
    expect(plain).not.toHaveProperty('private_note');
    const noted = remoteOperationOutput('source_answer', answerResult(POLICY_SKIP), { privateMayAnswer: true });
    expect(noted.private_note).toBe(REMOTE_PRIVATE_NOTE);
    expect(REMOTE_PRIVATE_NOTE).toBe('Private items may answer this; the person can see that answer in Olympus on their computer.');
    for (const operation of ['source_answer', 'source_answer_result'] as const) {
      expect(valid(operation, plain)).toBe(true);
      expect(valid(operation, noted)).toBe(true);
      expect(valid(operation, { ...noted, private_note: 'Private items: Lease.pdf' })).toBe(false);
    }
    // A withheld answer carries its own fixed sentence only.
    const withheld = remoteOperationOutput('source_answer', { ...answerResult(POLICY_SKIP), answer: 'api_key=ABCDEFGHIJKLMNOPQRSTUV' }, { privateMayAnswer: true });
    expect(withheld).toMatchObject({ status: 'withheld' });
    expect(withheld).not.toHaveProperty('private_note');
  });
});

describe('remote: over /mcp and the REST surface', () => {
  let connections: RemoteConnectionStore;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let audit: Record<string, unknown>;
  let probes: number;

  beforeEach(() => {
    connections = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
    audit = POLICY_SKIP;
    probes = 0;
    const worker = createEmailSourceWorker({ sourceAnswer: { answer: async () => answerResult(audit) } });
    const remotePrivateParts = createRemotePrivateParts({
      probe: async () => { probes += 1; return 'match'; },
      store: () => store,
    });
    const remote = {
      connections: () => connections,
      makeOperationContext: (caller: Parameters<typeof createInProcessOperationContext>[0]['caller'], signal: AbortSignal) => ({
        ...createInProcessOperationContext({ config: CONFIG, sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller, signal }),
        ...(caller.connectionId ? { remotePrivatePart: remotePrivateParts.forConnection(caller.connectionId) } : {}),
      }),
    };
    const mcp = createRemoteMcpHandler(remote);
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: withRemoteOpenApiRoutes(createRemoteOpenApiHandler({ ...remote, publicBaseUrl: () => undefined }), mcp) });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server.stop(true);
    connections.close();
  });

  test('a fallback answer with a Private match carries the sentence on both surfaces and waits on the computer', async () => {
    const { token } = connections.create('Claude');
    const client = new Client({ name: 'waiting-remote-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as unknown as Parameters<Client['connect']>[0]);
    try {
      const result = await client.callTool({ name: 'source_answer', arguments: { question: 'When does the lease end?' } }) as { content: Array<{ text: string }> };
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ kind: 'source_answer', status: 'answered', private_note: REMOTE_PRIVATE_NOTE });
    } finally {
      await client.close();
    }
    const rest = await fetch(`${base}/api/v1/tools/source_answer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Who signed the lease?' }),
    });
    expect(rest.status).toBe(200);
    expect(await rest.json()).toMatchObject({ status: 'answered', private_note: REMOTE_PRIVATE_NOTE });
    expect(store.list().questions.map((question) => [question.surface, question.question]).sort()).toEqual([
      ['remote', 'When does the lease end?'],
      ['remote', 'Who signed the lease?'],
    ]);

    // A summary that drew on Private evidence: no probe, no sentence, no record.
    audit = DELIVERED;
    const delivered = await fetch(`${base}/api/v1/tools/source_answer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What is in the will?' }),
    });
    const deliveredBody = await delivered.json();
    expect(deliveredBody).toMatchObject({ kind: 'source_answer', status: 'answered' });
    expect(deliveredBody).not.toHaveProperty('private_note');
    expect(probes).toBe(2);
    expect(store.list().questions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The metadata-only probe

describe('probePrivateMatch: metadata only, the request\'s own selectors', () => {
  const CORPUS_ID = 'secure_local.fixture.files';

  async function withConnectorStore(run: (lanes: (request: unknown) => AnalystAnswerLanes, contentReads: () => number) => Promise<void>): Promise<void> {
    const connectorStore = new LocalConnectorStore({ dbPath: join(dir, 'files.sqlite'), corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    let reads = 0;
    try {
      await connectorStore.syncFromConnector(fixtureConnector(), { fetchContent: true });
      const lanes = () => ({
        registry: buildSourceIndexCorpusRegistry([defineConnectorCorpus({ corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' })]),
        adapters: { [CORPUS_ID]: createConnectorStoreCorpusAdapter({ store: connectorStore, retrievalMode: 'keyword' }) },
        // Present so a read would be counted; the probe must never use it.
        contentProviders: { [CORPUS_ID]: { fetchLocalContent: async () => { reads += 1; return { chunks: ['lease text'] }; } } },
      }) as unknown as AnalystAnswerLanes;
      await run(lanes, () => reads);
    } finally {
      connectorStore.close();
    }
  }

  test('match, no_match, a corpus the request did not name, and unknown on failure or timeout', async () => {
    await withConnectorStore(async (lanes, contentReads) => {
      expect(await probePrivateMatch({ lanes, request: { question: 'apartment lease renewal' }, timeoutMs: 5_000 })).toBe('match');
      expect(await probePrivateMatch({ lanes, request: { question: 'zebra quantum saxophone' }, timeoutMs: 5_000 })).toBe('no_match');
      expect(await probePrivateMatch({ lanes, request: { question: 'apartment lease renewal', corpus_ids: ['secure_local.other.files'] }, timeoutMs: 5_000 })).toBe('no_match');
      expect(contentReads()).toBe(0);
      expect(await probePrivateMatch({ lanes: () => { throw new Error('lanes down'); }, request: { question: 'apartment lease renewal' }, timeoutMs: 5_000 })).toBe('unknown');
      const slow = () => ({ ...lanes({}), adapters: { [CORPUS_ID]: () => new Promise(() => {}) } }) as unknown as AnalystAnswerLanes;
      expect(await probePrivateMatch({ lanes: slow, request: { question: 'apartment lease renewal' }, timeoutMs: 30 })).toBe('unknown');
    });
  });
});

function fixtureConnector(): SourceConnector {
  const rawItems = [{ id: 'lease', name: 'Apartment lease renewal.pdf', text: 'The apartment lease renewal runs to May 2027.' }].map((item): RawItem => ({
    identity: {
      family: 'file',
      provider: 'fixture_files',
      accountScope: 'personal',
      providerItemId: item.id,
      providerFileId: item.id,
      localItemId: `personal:${item.id}`,
      sourceVersion: `${item.id}:v1`,
    },
    mimeType: 'application/pdf',
    content: { kind: 'text', text: item.text },
    metadata: Object.freeze({ name: item.name, locatorUri: `/home/${item.name}`, pathDisplay: `/home/${item.name}`, updatedAt: '2026-07-01T10:00:00.000Z' }),
    fetchedAt: '2026-07-01T10:00:00.000Z',
  }));
  const byId = new Map(rawItems.map((item) => [item.identity.localItemId, item]));
  return {
    id: 'fixture-waiting-probe',
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: rawItems, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = byId.get(localItemId);
      if (!item) throw new Error(`missing fixture ${localItemId}`);
      return item;
    },
    classificationSignals() {
      return {};
    },
  } as unknown as SourceConnector;
}

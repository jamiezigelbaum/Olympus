// The private answer panel, engine side: sealing, one-time jobs, the
// `/private/<id>` endpoint, and the boundary that keeps the private answer
// (and any key) out of everything ChatGPT receives as tool output.
// The relay side (routing, CORS, offline) is in connect-relay/test/relay-e2e.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mintCredential } from '../connect-relay/shared/tokens.ts';
import { RelayClient, type RelayClientStatus } from '../connect-relay/client/relay-client.ts';
import { loadOrCreateIdentity } from '../connect-relay/client/identity.ts';
import { base64url } from '../connect-relay/shared/protocol.ts';
import { MemoryInstallRegistry } from '../connect-relay/server/registry.ts';
import { startRelay } from '../connect-relay/server/relay.ts';
import { defaultConfig } from '../src/core/config.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import {
  PRIVATE_ANSWER_META_KEY,
  type PrivateAnswerModel,
} from '../src/workers/chatgpt/private-answer-contract.ts';
import {
  fromBase64Url,
  generatePanelKeyPair,
  importPanelPublicKey,
  openPrivateAnswer,
  sealPrivateAnswer,
  toBase64Url,
  type SealedPrivateAnswer,
} from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PrivateAnswerJobs, createPrivateAnswerHandler } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { PRIVATE_ANSWER_RESOURCE_VERSIONED_URI, privateAnswerResourceMeta } from '../src/workers/chatgpt/private-answer-resource.ts';
import {
  copyPrivateMatch,
  PRIVATE_MATCH_NOTE,
  PRIVATE_MATCH_PANEL_NOTE,
  PRIVATE_MATCH_PANEL_SETUP_NOTE,
  privateMatchNote,
} from '../src/workers/chatgpt/response-builder.ts';
import { CHATGPT_TOOLS } from '../src/workers/chatgpt/mcp-surface.ts';
import { DASHBOARD_CHATGPT_VOCABULARY } from '../src/workers/dashboard/vocabulary.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { createInProcessOperationContext, createRemoteMcpHandler } from '../src/workers/remote-mcp.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';

const INSTALL = 'a'.repeat(32);
const OTHER_INSTALL = 'b'.repeat(32);
const PANEL_ORIGIN = 'https://olympus.web-sandbox.oaiusercontent.com';
const SECRET_ANSWER = 'SENTINEL_PRIVATE_ANSWER_7f3a: the lease ends in May.';
const SECRET_CITATION = 'SENTINEL_PRIVATE_CITATION_7f3a';
const SENTINEL_PATTERN = /SENTINEL_[A-Z_]+_7f3a/;
const EVIDENCE = [{ title: 'SENTINEL_PRIVATE_EVIDENCE_7f3a', trust_domain: 'secure_local' }];

function readyModel(overrides: Partial<PrivateAnswerModel> = {}): PrivateAnswerModel & { calls: Array<{ question: string; evidence: unknown }> } {
  const calls: Array<{ question: string; evidence: unknown }> = [];
  return {
    calls,
    status: () => ({ state: 'ready' }),
    answerPrivately: async (question, evidence) => {
      calls.push({ question, evidence });
      return { answer: SECRET_ANSWER, citations: [{ title: SECRET_CITATION, source: 'Gmail', date: '2026-04-01' }] };
    },
    ...overrides,
  };
}

function makeJobs(model: PrivateAnswerModel, clock = { now: 1_000_000 }, extra: Partial<ConstructorParameters<typeof PrivateAnswerJobs>[0]> = {}) {
  return new PrivateAnswerJobs({ model: () => model, installId: () => INSTALL, now: () => clock.now, log: () => {}, ...extra });
}

/**
 * Model-visible (text, structuredContent): exactly the one fixed Private note
 * (owner decision 2026-10-02: the model learns that a private match exists,
 * one bit), once in the text and once in the notes. Never the job id, the
 * count, the state, a title or any content.
 */
function expectOnlyPrivateNoteVisible(
  result: Record<string, unknown>,
  meta: Record<string, unknown>,
  note: string = PRIVATE_MATCH_PANEL_NOTE,
): void {
  const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
  expect(text.split(note).length - 1).toBe(1);
  expect(((result.structuredContent as { notes?: string[] }).notes ?? []).filter((entry) => entry === note)).toHaveLength(1);
  const visible = JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
  expect(visible).not.toContain(String(meta.jobId));
  expect(visible).not.toMatch(/privateMatch|panelState|"count"|olympus\/privateAnswer/);
  // With the note taken out, nothing else says Private items exist.
  const rest = visible.split(note).join('');
  expect(rest).not.toMatch(/private item|Private item|marked Private|private answer panel/);
  expect(rest).not.toContain(DASHBOARD_CHATGPT_VOCABULARY.privateMatches);
  expect(result.structuredContent as Record<string, unknown>).not.toHaveProperty('privateMatch');
}

async function settled(jobs: PrivateAnswerJobs): Promise<void> {
  // Analyses (refresh, model, sealing) run on a promise chain; let it drain.
  await Bun.sleep(50);
  void jobs;
}

describe('sealing', () => {
  test('ECDH P-256 + HKDF(job id) + AES-GCM round trip', async () => {
    const panel = await generatePanelKeyPair();
    const imported = await importPanelPublicKey(panel.publicKey);
    expect(imported).toBeDefined();
    const jobId = mintCredential('private', INSTALL);
    const sealed = await sealPrivateAnswer(jobId, imported!.key, 'hello private world');
    expect(JSON.stringify(sealed)).not.toContain('hello');
    expect(fromBase64Url(sealed.macPublicKey)!.byteLength).toBe(65);
    expect(fromBase64Url(sealed.iv)!.byteLength).toBe(12);
    expect(await openPrivateAnswer(jobId, panel.privateKey, sealed)).toBe('hello private world');
  });

  test('a different job id, a different panel key, or a changed byte does not open', async () => {
    const panel = await generatePanelKeyPair();
    const other = await generatePanelKeyPair();
    const jobId = mintCredential('private', INSTALL);
    const sealed = await sealPrivateAnswer(jobId, (await importPanelPublicKey(panel.publicKey))!.key, 'x');
    await expect(openPrivateAnswer(mintCredential('private', INSTALL), panel.privateKey, sealed)).rejects.toThrow();
    await expect(openPrivateAnswer(jobId, other.privateKey, sealed)).rejects.toThrow();
    const bytes = fromBase64Url(sealed.ciphertext)!;
    bytes[0] = bytes[0]! ^ 1;
    await expect(openPrivateAnswer(jobId, panel.privateKey, { ...sealed, ciphertext: toBase64Url(bytes) })).rejects.toThrow();
  });

  test('a public key that is not a P-256 point is refused', async () => {
    expect(await importPanelPublicKey('not a key')).toBeUndefined();
    expect(await importPanelPublicKey(toBase64Url(new Uint8Array(65)))).toBeUndefined();
    const point = new Uint8Array(65);
    point[0] = 4;
    point[1] = 1;
    expect(await importPanelPublicKey(toBase64Url(point))).toBeUndefined();
  });

  // The panel page's copy of this algorithm is driven end to end, against
  // sealPrivateAnswer, in test/chatgpt-private-answer-ui.test.ts.
});

describe('one-time jobs', () => {
  test('claim, poll, collect; replays of the same key get the same sealed bytes, any other key 409', async () => {
    const model = readyModel();
    const jobs = makeJobs(model);
    const begun = jobs.begin({ question: 'When does the lease end?', count: 3, evidence: EVIDENCE });
    expect(begun).toMatchObject({ count: 3, panelState: 'ready' });
    expect(begun.jobId).toMatch(new RegExp(`^oly2p\\.${INSTALL}\\.`));
    // The analysis starts at search time, before any claim.
    await settled(jobs);
    expect(model.calls).toEqual([{ question: 'When does the lease end?', evidence: EVIDENCE }]);
    const panel = await generatePanelKeyPair();
    const first = await jobs.claim(begun.jobId!, panel.publicKey);
    expect(first).toMatchObject({ status: 202, body: { status: 'pending' }, retryAfterSeconds: 2 });
    await settled(jobs);
    const ready = await jobs.claim(begun.jobId!, panel.publicKey);
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
    expect(JSON.stringify(ready.body)).not.toMatch(SENTINEL_PATTERN);
    const opened = JSON.parse(await openPrivateAnswer(begun.jobId!, panel.privateKey, ready.body as unknown as SealedPrivateAnswer));
    expect(opened).toEqual({ v: 1, answer: SECRET_ANSWER, citations: [{ title: SECRET_CITATION, source: 'Gmail', date: '2026-04-01' }] });
    // A replay of the panel's request (by anyone who saw it) cannot consume
    // the answer: same key, same sealed bytes, useless without the panel's
    // private key. Any other key: 409, and a local audit line.
    expect(await jobs.claim(begun.jobId!, panel.publicKey)).toEqual(ready);
    expect(await jobs.claim(begun.jobId!, panel.publicKey)).toEqual(ready);
    expect(await jobs.claim(begun.jobId!, (await generatePanelKeyPair()).publicKey)).toMatchObject({ status: 409, body: { status: 'claimed' } });
    expect(model.calls).toHaveLength(1);
    expect(jobs.size).toBe(1);
  });

  test('a second key is audited locally, without content', async () => {
    const events: string[] = [];
    const jobs = makeJobs(readyModel(), { now: 0 }, { audit: (event) => events.push(event) });
    const { jobId } = jobs.begin({ question: SECRET_ANSWER, count: 1, evidence: EVIDENCE });
    await jobs.claim(jobId!, (await generatePanelKeyPair()).publicKey);
    await jobs.claim(jobId!, (await generatePanelKeyPair()).publicKey);
    expect(events).toEqual(['claimed_by_other_key']);
  });

  test('a model that never resolves and ignores abort is cut off by the hard deadline; the next job runs', async () => {
    const events: string[] = [];
    let resets = 0;
    let calls = 0;
    const model = readyModel({
      answerPrivately: (question) => {
        calls += 1;
        if (question === 'stuck') return new Promise(() => {});
        return Promise.resolve({ answer: 'second answer', citations: [] });
      },
      reset: () => { resets += 1; },
    });
    // Claim-time analyses only: this is the path a claim takes without a usable precompute.
    const jobs = makeJobs(model, { now: 0 }, { analysisTimeoutMs: 50, audit: (event) => events.push(event), precompute: false });
    const stuck = jobs.begin({ question: 'stuck', count: 1, evidence: EVIDENCE }).jobId!;
    const next = jobs.begin({ question: 'next', count: 1, evidence: EVIDENCE }).jobId!;
    const panel = await generatePanelKeyPair();
    expect((await jobs.claim(stuck, panel.publicKey)).status).toBe(202);
    await Bun.sleep(120);
    expect(await jobs.claim(stuck, panel.publicKey)).toEqual({ status: 200, body: { status: 'failed' } });
    // The deadline runs from the claim; a job claimed after the stuck one failed runs at once.
    expect((await jobs.claim(next, panel.publicKey)).status).toBe(202);
    await settled(jobs);
    const ready = await jobs.claim(next, panel.publicKey);
    expect(ready.body.status).toBe('ready');
    expect(JSON.parse(await openPrivateAnswer(next, panel.privateKey, ready.body as unknown as SealedPrivateAnswer)).answer).toBe('second answer');
    expect(calls).toBe(2);
    expect(resets).toBe(1);
    expect(events).toEqual(['analysis_deadline']);
  });

  test('evidence is re-read at claim time; an item re-tiered to Secret since the search is dropped', async () => {
    const model = readyModel();
    const jobs = makeJobs(model);
    const searchTime = [
      { item: 'lease', trust_domain: 'secure_local' },
      { item: 'password', trust_domain: 'secure_local' },
    ];
    // Between search and claim the owner's classifier raised `password` to Secrets.
    const claimTime = [
      { item: 'lease', trust_domain: 'secure_local' },
      { item: 'password', trust_domain: 'secure_local', trust_tier: 'secrets' },
      { item: 'note', trust_domain: 'internal' },
    ];
    let refreshed = 0;
    const { jobId } = jobs.begin({
      question: 'q',
      count: 2,
      evidence: searchTime,
      refresh: async () => { refreshed += 1; return claimTime; },
    });
    expect(refreshed).toBe(0);
    await settled(jobs);
    // The search-time precompute read both items.
    expect(model.calls[0]!.evidence).toEqual(searchTime);
    const panel0 = await generatePanelKeyPair();
    await jobs.claim(jobId!, panel0.publicKey);
    await settled(jobs);
    expect(refreshed).toBe(1);
    // It read an item that is Secret now: discarded, and answered again from the current evidence.
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.evidence).toEqual([{ item: 'lease', trust_domain: 'secure_local' }]);
    expect((await jobs.claim(jobId!, panel0.publicKey)).body.status).toBe('ready');
    model.calls.length = 0;

    // Everything gone from the Private tier by claim time: no answer at all.
    const empty = makeJobs(model, { now: 1_000_000 }, { precompute: false });
    const second = empty.begin({ question: 'q', count: 1, evidence: searchTime, refresh: async () => [{ item: 'password', trust_tier: 'secret' }] });
    const panel = await generatePanelKeyPair();
    await empty.claim(second.jobId!, panel.publicKey);
    await settled(empty);
    expect(await empty.claim(second.jobId!, panel.publicKey)).toEqual({ status: 200, body: { status: 'failed' } });
    expect(model.calls).toHaveLength(0);
  });

  test('the first key wins; a second key gets 409 claimed', async () => {
    const jobs = makeJobs(readyModel());
    const { jobId } = jobs.begin({ question: 'q', count: 1, evidence: EVIDENCE });
    const owner = await generatePanelKeyPair();
    const intruder = await generatePanelKeyPair();
    expect((await jobs.claim(jobId!, owner.publicKey)).status).toBe(202);
    expect(await jobs.claim(jobId!, intruder.publicKey)).toMatchObject({ status: 409, body: { status: 'claimed' } });
    await settled(jobs);
    expect(await jobs.claim(jobId!, intruder.publicKey)).toMatchObject({ status: 409 });
    expect((await jobs.claim(jobId!, owner.publicKey)).status).toBe(200);
  });

  test('a job expires ten minutes after it was created, claimed or not', async () => {
    const clock = { now: 1_000_000 };
    const jobs = makeJobs(readyModel(), clock);
    const unclaimed = jobs.begin({ question: 'q', count: 1, evidence: EVIDENCE }).jobId!;
    const claimed = jobs.begin({ question: 'q', count: 1, evidence: EVIDENCE }).jobId!;
    const panel = await generatePanelKeyPair();
    await jobs.claim(claimed, panel.publicKey);
    await settled(jobs);
    clock.now += 10 * 60_000;
    expect(await jobs.claim(unclaimed, panel.publicKey)).toMatchObject({ status: 410 });
    expect(await jobs.claim(claimed, panel.publicKey)).toMatchObject({ status: 410 });
    expect(jobs.size).toBe(0);
  });

  test('a job id for another install, or an unknown id, is gone', async () => {
    let installId = INSTALL;
    const jobs = new PrivateAnswerJobs({ model: () => readyModel(), installId: () => installId });
    const panel = await generatePanelKeyPair();
    expect(await jobs.claim(mintCredential('private', OTHER_INSTALL), panel.publicKey)).toMatchObject({ status: 410 });
    expect(await jobs.claim(mintCredential('private', INSTALL), panel.publicKey)).toMatchObject({ status: 410 });
    const { jobId } = jobs.begin({ question: 'q', count: 1, evidence: EVIDENCE });
    // The engine was re-linked as another install: its old ids no longer answer.
    installId = OTHER_INSTALL;
    expect(await jobs.claim(jobId!, panel.publicKey)).toMatchObject({ status: 410 });
  });

  test('a failed analysis reports failed, idempotently', async () => {
    const jobs = makeJobs(readyModel({ answerPrivately: async () => { throw new Error(SECRET_ANSWER); } }));
    const { jobId } = jobs.begin({ question: 'q', count: 1, evidence: EVIDENCE });
    const panel = await generatePanelKeyPair();
    await jobs.claim(jobId!, panel.publicKey);
    await settled(jobs);
    const failed = await jobs.claim(jobId!, panel.publicKey);
    expect(failed).toEqual({ status: 200, body: { status: 'failed' } });
    expect(await jobs.claim(jobId!, panel.publicKey)).toEqual(failed);
  });

  test('no model, a downloading model, or no relay install: counts only, no job', () => {
    expect(makeJobs(readyModel({ status: () => ({ state: 'no_model' }) })).begin({ question: 'q', count: 2, evidence: EVIDENCE }))
      .toEqual({ count: 2, panelState: 'no_model' });
    expect(makeJobs(readyModel({ status: () => ({ state: 'model_downloading', percent: 41.6 }) })).begin({ question: 'q', count: 99, evidence: EVIDENCE }))
      .toEqual({ count: 50, panelState: 'model_downloading', percent: 42 });
    const unlinked = new PrivateAnswerJobs({ model: () => readyModel(), installId: () => undefined });
    expect(unlinked.begin({ question: 'q', count: 1, evidence: EVIDENCE })).toEqual({ count: 1, panelState: 'no_model' });
    expect(unlinked.size).toBe(0);
  });

  test('claims of live jobs are rate limited; pending polls by the claiming key are rate limited per job but never destroy it', async () => {
    const limited = makeJobs(readyModel(), { now: 0 }, { claimRate: { capacity: 2, refillPerSecond: 0 } });
    const panel = await generatePanelKeyPair();
    const live = limited.begin({ question: 'q', count: 1, evidence: EVIDENCE }).jobId!;
    await limited.claim(live, panel.publicKey);
    await limited.claim(live, panel.publicKey);
    expect(await limited.claim(live, panel.publicKey)).toMatchObject({ status: 429, body: { status: 'rate_limited' } });

    // A replay of the claiming key hammering a pending job: 429s, never a deletion.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const clock = { now: 0 };
    const polled = makeJobs(readyModel({
      answerPrivately: async () => { await gate; return { answer: 'survived', citations: [] }; },
    }), clock, { pollRate: { capacity: 3, refillPerSecond: 1 } });
    const { jobId } = polled.begin({ question: 'q', count: 1, evidence: EVIDENCE });
    for (let i = 0; i < 3; i += 1) expect((await polled.claim(jobId!, panel.publicKey)).status).toBe(202);
    for (let i = 0; i < 50; i += 1) {
      expect(await polled.claim(jobId!, panel.publicKey)).toEqual({ status: 429, body: { status: 'rate_limited' }, retryAfterSeconds: 2 });
    }
    expect(polled.size).toBe(1);
    clock.now += 1_000;
    expect((await polled.claim(jobId!, panel.publicKey)).status).toBe(202);
    release();
    await settled(polled);
    const ready = await polled.claim(jobId!, panel.publicKey);
    expect(ready.status).toBe(200);
    expect(JSON.parse(await openPrivateAnswer(jobId!, panel.privateKey, ready.body as unknown as SealedPrivateAnswer)).answer).toBe('survived');
    // Expiry alone ends it.
    clock.now += 10 * 60_000;
    expect((await polled.claim(jobId!, panel.publicKey)).status).toBe(410);
  });

  test('made-up job ids spend no claim tokens: after 100 junk claims a real claim still succeeds', async () => {
    const jobs = makeJobs(readyModel(), { now: 0 }, { claimRate: { capacity: 2, refillPerSecond: 0 } });
    const panel = await generatePanelKeyPair();
    for (let i = 0; i < 100; i += 1) {
      expect(await jobs.claim(mintCredential('private', INSTALL), panel.publicKey)).toEqual({ status: 410, body: { status: 'gone' } });
    }
    const { jobId } = jobs.begin({ question: 'q', count: 1, evidence: EVIDENCE });
    expect((await jobs.claim(jobId!, panel.publicKey)).status).toBe(202);
    await settled(jobs);
    const ready = await jobs.claim(jobId!, panel.publicKey);
    expect(ready.body.status).toBe('ready');
  });

  test('after a deadline the next analysis waits for the model reset, so two inferences never overlap', async () => {
    const events: string[] = [];
    let finishReset!: () => void;
    const model = readyModel({
      answerPrivately: (question) => {
        events.push(`start:${question}`);
        return question === 'stuck' ? new Promise(() => {}) : Promise.resolve({ answer: 'next answer', citations: [] });
      },
      reset: () => {
        events.push('reset:start');
        return new Promise<void>((resolve) => { finishReset = () => { events.push('reset:done'); resolve(); }; });
      },
    });
    const jobs = makeJobs(model, { now: 0 }, { analysisTimeoutMs: 20, resetTimeoutMs: 60_000, audit: () => {}, precompute: false });
    const stuck = jobs.begin({ question: 'stuck', count: 1, evidence: EVIDENCE }).jobId!;
    const next = jobs.begin({ question: 'next', count: 1, evidence: EVIDENCE }).jobId!;
    const panel = await generatePanelKeyPair();
    await jobs.claim(stuck, panel.publicKey);
    await Bun.sleep(80);
    // The stuck job failed and its reset is running: the next one, claimed now, has not started.
    expect(await jobs.claim(stuck, panel.publicKey)).toEqual({ status: 200, body: { status: 'failed' } });
    expect((await jobs.claim(next, panel.publicKey)).status).toBe(202);
    await Bun.sleep(10);
    expect(events).toEqual(['start:stuck', 'reset:start']);
    expect((await jobs.claim(next, panel.publicKey)).status).toBe(202);
    finishReset();
    await settled(jobs);
    expect(events).toEqual(['start:stuck', 'reset:start', 'reset:done', 'start:next']);
    expect((await jobs.claim(next, panel.publicKey)).body.status).toBe('ready');
  });

  test('a reset that never resolves holds the next analysis only until the reset timeout', async () => {
    let resets = 0;
    const model = readyModel({
      answerPrivately: (question) => (question === 'stuck'
        ? new Promise(() => {})
        : Promise.resolve({ answer: 'next answer', citations: [] })),
      reset: () => { resets += 1; return new Promise<void>(() => {}); },
    });
    const jobs = makeJobs(model, { now: 0 }, { analysisTimeoutMs: 100, resetTimeoutMs: 60, audit: () => {}, precompute: false });
    const stuck = jobs.begin({ question: 'stuck', count: 1, evidence: EVIDENCE }).jobId!;
    const next = jobs.begin({ question: 'next', count: 1, evidence: EVIDENCE }).jobId!;
    const panel = await generatePanelKeyPair();
    await jobs.claim(stuck, panel.publicKey);
    await Bun.sleep(110);
    // Claimed while the hung reset holds the slot: it runs once the reset times out.
    await jobs.claim(next, panel.publicKey);
    await Bun.sleep(100);
    expect(await jobs.claim(stuck, panel.publicKey)).toEqual({ status: 200, body: { status: 'failed' } });
    const ready = await jobs.claim(next, panel.publicKey);
    expect(ready.body.status).toBe('ready');
    expect(JSON.parse(await openPrivateAnswer(next, panel.privateKey, ready.body as unknown as SealedPrivateAnswer)).answer).toBe('next answer');
    expect(resets).toBe(1);
  });

  test('a refresh that finishes after the deadline never starts inference', async () => {
    let inferences = 0;
    const model = readyModel({
      answerPrivately: async () => { inferences += 1; return { answer: 'too late', citations: [] }; },
    });
    const jobs = makeJobs(model, { now: 0 }, { analysisTimeoutMs: 20, audit: () => {}, precompute: false });
    const { jobId } = jobs.begin({
      question: 'q',
      count: 1,
      evidence: EVIDENCE,
      // Ignores its signal and returns well after the deadline.
      refresh: () => new Promise((resolve) => setTimeout(() => resolve(EVIDENCE), 80)),
    });
    const panel = await generatePanelKeyPair();
    await jobs.claim(jobId!, panel.publicKey);
    await Bun.sleep(150);
    expect(inferences).toBe(0);
    expect(await jobs.claim(jobId!, panel.publicKey)).toEqual({ status: 200, body: { status: 'failed' } });
  });
});

describe('the /private/<id> endpoint', () => {
  const relayed = (request: Request) => request.headers.has('x-olympus-relay');
  const post = (handler: (request: Request) => Promise<Response>, jobId: string, body: unknown, headers: Record<string, string> = {}) =>
    handler(new Request(`http://127.0.0.1:8010/private/${jobId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PANEL_ORIGIN, 'x-olympus-relay': 's', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }));

  test('serves relayed POSTs from a ChatGPT widget origin only, with a tiny body', async () => {
    const jobs = makeJobs(readyModel());
    const handler = createPrivateAnswerHandler({ jobs, isRelayed: relayed });
    const { jobId } = jobs.begin({ question: 'q', count: 1, evidence: EVIDENCE });
    const panel = await generatePanelKeyPair();
    const good = { v: 1, publicKey: panel.publicKey };

    const pending = await post(handler, jobId!, good, { 'x-olympus-relay': '' });
    expect(pending.status).toBe(202);
    expect(pending.headers.get('retry-after')).toBe('2');
    expect(pending.headers.get('cache-control')).toBe('no-store');
    const direct = await handler(new Request(`http://127.0.0.1:8010/private/${jobId}`, { method: 'POST', headers: { origin: PANEL_ORIGIN }, body: JSON.stringify(good) }));
    expect(direct.status).toBe(404);
    expect((await post(handler, jobId!, good, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(handler, jobId!, good, { origin: 'https://a.b.web-sandbox.oaiusercontent.com' })).status).toBe(403);
    expect((await post(handler, jobId!, good, { origin: 'codex-sandbox://a.b.web-sandbox.oaiusercontent.com' })).status).toBe(403);
    expect((await post(handler, jobId!, good, { origin: 'codex-sandbox://evil.example' })).status).toBe(403);
    expect((await post(handler, jobId!, good, { origin: 'codex-sandbox://mcp-app-c0947ce45162d135a5b3225923aaa6fed60ae881dfeb3cf6.web-sandbox.oaiusercontent.com', 'x-olympus-relay': '' })).status).toBe(202);
    expect((await post(handler, jobId!, 'x'.repeat(600))).status).toBe(413);
    expect((await post(handler, jobId!, '{not json')).status).toBe(400);
    expect((await post(handler, jobId!, { v: 2, publicKey: panel.publicKey })).status).toBe(400);
    expect((await post(handler, jobId!, { v: 1, publicKey: 'AAAA' })).status).toBe(400);
    expect((await handler(new Request(`http://127.0.0.1:8010/private/${jobId}?x=1`, { method: 'POST', headers: { origin: PANEL_ORIGIN, 'x-olympus-relay': 's' } }))).status).toBe(404);
    expect((await handler(new Request(`http://127.0.0.1:8010/private/${jobId}`, { headers: { origin: PANEL_ORIGIN, 'x-olympus-relay': 's' } }))).status).toBe(405);

    await settled(jobs);
    const ready = await post(handler, jobId!, good);
    expect(ready.status).toBe(200);
    const text = await ready.text();
    expect(text).not.toMatch(SENTINEL_PATTERN);
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(['ciphertext', 'iv', 'macPublicKey', 'status', 'v']);
    expect(JSON.parse(await openPrivateAnswer(jobId!, panel.privateKey, body)).answer).toBe(SECRET_ANSWER);
    const replay = await post(handler, jobId!, good);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(text);
  });
});

describe('the response builder', () => {
  test('copies exactly the allowlisted panel fields', () => {
    const jobId = mintCredential('private', INSTALL);
    const smuggled = { count: 3, panelState: 'ready', jobId, key: 'k', fetchToken: 't', answer: SECRET_ANSWER } as never;
    expect(copyPrivateMatch(smuggled)).toEqual({ v: 1, count: 3, state: 'ready', jobId });
    expect(copyPrivateMatch({ count: 3, panelState: 'ready', jobId: mintCredential('access', INSTALL) })).toEqual({ v: 1, count: 3, state: 'no_model' });
    expect(copyPrivateMatch({ count: 3, panelState: 'no_model', jobId })).toEqual({ v: 1, count: 3, state: 'no_model' });
    expect(copyPrivateMatch({ count: 500, panelState: 'model_downloading', percent: 12.4 })).toEqual({ v: 1, count: 50, state: 'model_downloading', percent: 12 });
    expect(copyPrivateMatch({ count: 0, panelState: 'ready', jobId })).toBeUndefined();
  });

  test('the model-visible Private note is one fixed bit: no count, no title, no content', () => {
    const jobId = mintCredential('private', INSTALL);
    expect(privateMatchNote({ count: 7, panelState: 'ready', jobId })).toBe(PRIVATE_MATCH_PANEL_NOTE);
    expect(privateMatchNote({ count: 7, panelState: 'no_model' })).toBe(PRIVATE_MATCH_PANEL_SETUP_NOTE);
    expect(privateMatchNote({ count: 7, panelState: 'model_downloading', percent: 40 })).toBe(PRIVATE_MATCH_PANEL_SETUP_NOTE);
    // No panel came back in time, but released coverage saw content tiered Private.
    expect(privateMatchNote(undefined, 3)).toBe(PRIVATE_MATCH_NOTE);
    expect(privateMatchNote(undefined, 0)).toBeUndefined();
    expect(privateMatchNote({ count: 0, panelState: 'ready', jobId })).toBeUndefined();
    for (const note of [PRIVATE_MATCH_PANEL_NOTE, PRIVATE_MATCH_PANEL_SETUP_NOTE, PRIVATE_MATCH_NOTE]) {
      // The same text whatever the count: nothing to probe holdings with.
      expect(note).not.toMatch(/\d/);
      expect(note).not.toContain(SECRET_ANSWER);
      expect(note.toLowerCase()).toContain("don't suggest changing folder settings");
    }
  });

  test('the resource declares the relay as its one connect domain', () => {
    expect(privateAnswerResourceMeta()).toMatchObject({ ui: { csp: { connectDomains: ['https://mcp.olympusplugin.ai'], resourceDomains: [] } } });
    const answerTools = CHATGPT_TOOLS.filter((tool) => tool.name === 'source_answer' || tool.name === 'source_answer_result');
    for (const tool of answerTools) expect(tool._meta).toEqual({ ui: { resourceUri: PRIVATE_ANSWER_RESOURCE_VERSIONED_URI }, 'openai/outputTemplate': PRIVATE_ANSWER_RESOURCE_VERSIONED_URI });
  });
});

describe('sentinel: over the real MCP surface', () => {
  let dir: string;
  let store: RemoteConnectionStore;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let jobs: PrivateAnswerJobs;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'olympus-private-answer-'));
    store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
    jobs = makeJobs(readyModel());
    const worker = createEmailSourceWorker({
      sourceAnswer: {
        async answer() {
          return {
            answer: 'The released evidence does not answer this.',
            evidence: [],
            audit: { searched_corpora: [], skipped_corpora: [], lane_audits: [], latency_ms: 1, raw_source_exposed: false },
            policy: { raw_source_exposed: false, source_packets_exposed: false, internal_content_exposed: false, secure_local_content_exposed: false, castor_safe_bridge: true },
          } as unknown as SourceIndexAnswerResult;
        },
      },
    });
    const config = { ...defaultConfig(), sourceIndex: { ...defaultConfig().sourceIndex, enabled: true } };
    const handler = createRemoteMcpHandler({
      connections: () => store,
      makeOperationContext: (caller, signal) => createInProcessOperationContext({ config, sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller, signal }),
      chatgpt: {
        servesRequest: () => true,
        privateAnswers: jobs,
        async privateMatchProbe() { return { count: 2, evidence: EVIDENCE }; },
        async dashboardView() { throw new Error('unused'); },
      },
    });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('the private answer reaches only the panel, sealed; tool text and structuredContent say nothing about a private match', async () => {
    const { token } = store.create('ChatGPT');
    const client = new Client({ name: 'private-answer-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as unknown as Parameters<Client['connect']>[0]);
    let result: Record<string, unknown>;
    let resource: unknown;
    try {
      result = await client.callTool({ name: 'source_answer', arguments: { question: 'When does the lease end?' } }) as Record<string, unknown>;
      resource = await client.readResource({ uri: PRIVATE_ANSWER_RESOURCE_VERSIONED_URI });
    } finally {
      await client.close();
    }
    const meta = (result._meta as Record<string, unknown>)[PRIVATE_ANSWER_META_KEY] as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(['count', 'jobId', 'state', 'v']);
    expect(meta).toMatchObject({ v: 1, count: 2, state: 'ready' });
    // The model-visible channels carry the one fixed Private note and never
    // the job id, the count, the state, a title or any content.
    expectOnlyPrivateNoteVisible(result, meta);
    expect(JSON.stringify(resource)).toContain('Show private answer');

    // The panel collects it directly (as through the relay).
    const panel = await generatePanelKeyPair();
    const handler = createPrivateAnswerHandler({ jobs, isRelayed: () => true });
    const collect = () => handler(new Request(`http://127.0.0.1/private/${meta.jobId}`, {
      method: 'POST',
      headers: { origin: PANEL_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, publicKey: panel.publicKey }),
    }));
    const wire: string[] = [];
    let response = await collect();
    wire.push(await response.text());
    await settled(jobs);
    response = await collect();
    const sealedText = await response.text();
    wire.push(sealedText);

    // Everything ChatGPT received, and everything on the wire: no private text, no panel key.
    const toChatGpt = JSON.stringify(result);
    expect(toChatGpt.match(SENTINEL_PATTERN)?.[0]).toBeUndefined();
    expect(wire.join('\n').match(SENTINEL_PATTERN)?.[0]).toBeUndefined();
    expect(toChatGpt).not.toContain(panel.publicKey);
    const sealed = JSON.parse(sealedText) as SealedPrivateAnswer;
    expect(toChatGpt).not.toContain(sealed.macPublicKey);
    expect(JSON.parse(await openPrivateAnswer(String(meta.jobId), panel.privateKey, sealed)).answer).toBe(SECRET_ANSWER);
  });
});

describe('end to end through a real relay', () => {
  test('the panel claims, polls and decrypts through the relay; the relay carries only ciphertext', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-private-e2e-'));
    const relayLog: string[] = [];
    const relay = await startRelay({
      publicHost: 'mcp.olympus.test',
      registry: new MemoryInstallRegistry(),
      listen: { host: '127.0.0.1', port: 0 },
      log: (event, fields) => relayLog.push(JSON.stringify({ event, ...fields })),
    });
    const identity = loadOrCreateIdentity(dir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = readyModel({
      answerPrivately: async () => {
        await gate;
        return { answer: SECRET_ANSWER, citations: [] };
      },
    });
    const jobs = new PrivateAnswerJobs({ model: () => model, installId: () => identity.installId });
    const handler = createPrivateAnswerHandler({ jobs, isRelayed: (request) => request.headers.has('x-olympus-relay') });
    const engine = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
    const statuses: RelayClientStatus[] = [];
    const client = new RelayClient({
      relayHost: 'mcp.olympus.test',
      relayUrl: `ws://127.0.0.1:${relay.port}/v2/connect`,
      identity,
      target: `http://127.0.0.1:${engine.port}`,
      relaySecret: base64url(crypto.getRandomValues(new Uint8Array(32))),
      heartbeatMs: 500,
      backoff: { minMs: 50, maxMs: 200 },
      onStatus: (status) => statuses.push(status),
    });
    client.start();
    try {
      const deadline = Date.now() + 5_000;
      while (statuses.at(-1)?.state !== 'online') {
        if (Date.now() > deadline) throw new Error('install never came online');
        await Bun.sleep(10);
      }
      const { jobId } = jobs.begin({ question: 'When does the lease end?', count: 1, evidence: EVIDENCE });
      const panel = await generatePanelKeyPair();
      const collect = () => fetch(`${relay.url}/private/${jobId}`, {
        method: 'POST',
        headers: { origin: PANEL_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, publicKey: panel.publicKey }),
      });
      const pending = await collect();
      expect(pending.status).toBe(202);
      expect(pending.headers.get('retry-after')).toBe('2');
      expect(pending.headers.get('access-control-allow-origin')).toBe(PANEL_ORIGIN);
      expect(await pending.json()).toEqual({ status: 'pending' });
      release();
      await settled(jobs);
      const ready = await collect();
      expect(ready.status).toBe(200);
      const text = await ready.text();
      expect(text).not.toMatch(SENTINEL_PATTERN);
      expect(JSON.parse(await openPrivateAnswer(jobId!, panel.privateKey, JSON.parse(text))).answer).toBe(SECRET_ANSWER);
      const replay = await collect();
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(text);
      const logs = relayLog.join('\n');
      expect(logs).not.toContain(jobId!);
      expect(logs).not.toContain(identity.installId);
    } finally {
      client.stop();
      engine.stop(true);
      await relay.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

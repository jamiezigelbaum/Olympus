// The private question lane without ChatGPT or zkAPI: the panel seals a
// question to the engine's job key, the engine runs the ask lane and seals
// the outcome back, the panel opens it; and the shared relay route that lets
// `/private/<job>/ask` through with a larger body.

import { describe, expect, test } from 'bun:test';
import type { ConsultAskResult } from '../src/core/consult-ask.ts';
import {
  generateEngineKeyPair,
  generatePanelKeyPair,
  importPanelPublicKey,
  openPrivateAnswer,
  openPrivateQuestion,
  sealPrivateQuestion,
} from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PrivateAnswerJobs, createPrivateAnswerHandler } from '../src/workers/chatgpt/private-answer-jobs.ts';
import type { PrivateAnswerModel } from '../src/workers/chatgpt/private-answer-contract.ts';
import { PRIVATE_QUESTION_MAX_CHARS, type PrivateQuestionMetaV1, type PrivateQuestionResultV1 } from '../src/workers/chatgpt/private-question-contract.ts';
import { PrivateQuestionJobs, resultOf } from '../src/workers/chatgpt/private-question-jobs.ts';
import {
  PRIVATE_ANSWER_MAX_REQUEST_BYTES,
  PRIVATE_QUESTION_MAX_REQUEST_BYTES,
  privateAnswerMaxRequestBytes,
  privateAnswerRoute,
} from '../connect-relay/shared/private-answer.ts';

const INSTALL = 'a'.repeat(32);
/** A private answer model that is never asked: these tests exercise the question jobs only. */
const NO_MODEL: PrivateAnswerModel = { status: () => ({ state: 'ready' }), answerPrivately: async () => ({ answer: '', citations: [] }) };
const PANEL_ORIGIN = 'https://olympus.web-sandbox.oaiusercontent.com';
const ANSWERED: ConsultAskResult = {
  ok: true, sent: 'What options does a tenant usually have?', reply: 'Negotiate, or move.', route: 'zkapi', networkIdentity: 'hidden',
  level: 'strict', rewritten: true, remembered: false, model: 'anthropic/claude-sonnet-5.5',
};

interface Harness {
  jobs: PrivateQuestionJobs;
  clock: { now: number };
  asked: Array<{ question: string; level: string; cleanup?: string }>;
  /** Resolves the running ask with the given outcome. */
  answer: (outcome: ConsultAskResult | Error) => void;
  aborted: () => boolean;
}

function harness(extra: Partial<ConstructorParameters<typeof PrivateQuestionJobs>[0]> = {}, auto?: ConsultAskResult): Harness {
  const clock = { now: 1_000_000 };
  const asked: Harness['asked'] = [];
  let resolve: ((outcome: ConsultAskResult) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  let signal: AbortSignal | undefined;
  const jobs = new PrivateQuestionJobs({
    installId: () => INSTALL,
    ask: (input) => {
      asked.push({ question: input.question, level: input.level, ...(input.cleanup ? { cleanup: input.cleanup } : {}) });
      signal = input.signal;
      if (auto) return Promise.resolve(auto);
      return new Promise<ConsultAskResult>((res, rej) => { resolve = res; reject = rej; });
    },
    choice: () => ({ level: 'strict', cleanup: 'as_written', customInstruction: false }),
    now: () => clock.now,
    ...extra,
  });
  return {
    jobs,
    clock,
    asked,
    answer: (outcome) => (outcome instanceof Error ? reject!(outcome) : resolve!(outcome)),
    aborted: () => signal?.aborted === true,
  };
}

/** The panel's side: a key pair and the sealed question for a job. */
async function panelAsk(meta: PrivateQuestionMetaV1, plaintext: unknown) {
  const panel = await generatePanelKeyPair();
  const engineKey = (await importPanelPublicKey(meta.askKey))!.key;
  const sealed = await sealPrivateQuestion(meta.jobId, panel.privateKey, engineKey, JSON.stringify(plaintext));
  return { panel, body: { v: 1, publicKey: panel.publicKey, ...sealed } };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

async function opened(jobs: PrivateQuestionJobs, jobId: string, panel: { privateKey: CryptoKey; publicKey: string }): Promise<PrivateQuestionResultV1> {
  const response = await jobs.collect(jobId, panel.publicKey);
  expect(response.status).toBe(200);
  const body = response.body as Record<string, unknown>;
  expect(body.status).toBe('ready');
  const text = await openPrivateAnswer(jobId, panel.privateKey, body as never);
  return JSON.parse(text.replace(/\s+$/, ''));
}

describe('the crypto: a question sealed to the engine key, opened with the engine private key', () => {
  test('round trip, bound to the job id and the panel key', async () => {
    const engine = await generateEngineKeyPair();
    const panel = await generatePanelKeyPair();
    const engineKey = (await importPanelPublicKey(engine.publicKey))!.key;
    const panelKey = (await importPanelPublicKey(panel.publicKey))!.key;
    const jobId = `oly2p.${INSTALL}.${'B'.repeat(43)}`;
    const sealed = await sealPrivateQuestion(jobId, panel.privateKey, engineKey, '{"v":1,"question":"hello"}');
    expect(await openPrivateQuestion(jobId, engine.privateKey, panelKey, sealed)).toBe('{"v":1,"question":"hello"}');
    // Another job id or another panel key cannot open it.
    await expect(openPrivateQuestion(`oly2p.${INSTALL}.${'C'.repeat(43)}`, engine.privateKey, panelKey, sealed)).rejects.toThrow();
    const other = await generatePanelKeyPair();
    await expect(openPrivateQuestion(jobId, engine.privateKey, (await importPanelPublicKey(other.publicKey))!.key, sealed)).rejects.toThrow();
    await expect(openPrivateQuestion(jobId, engine.privateKey, panelKey, { iv: sealed.iv, ciphertext: 'AAAA' })).rejects.toThrow();
  });
});

describe('the jobs: begin → ask → collect', () => {
  test('a sealed question runs the ask lane and the outcome comes back sealed to the asking key only', async () => {
    const h = harness();
    const meta = (await h.jobs.begin())!;
    expect(meta).toMatchObject({ v: 1, level: 'strict', cleanup: 'as_written', customInstruction: false, maxChars: PRIVATE_QUESTION_MAX_CHARS });
    expect(meta.jobId).toMatch(new RegExp(`^oly2p\\.${INSTALL}\\.[A-Za-z0-9_-]{43}$`));
    expect(meta.askKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(h.jobs.has(meta.jobId)).toBe(true);

    // Before any ask: a collection is pending.
    const early = await generatePanelKeyPair();
    expect((await h.jobs.collect(meta.jobId, early.publicKey)).status).toBe(202);

    const { panel, body } = await panelAsk(meta, { v: 1, question: '  My landlord wants 40% more rent. Options?  ', level: 'strict' });
    const accepted = await h.jobs.ask(meta.jobId, body);
    expect(accepted.status).toBe(202);
    expect(h.asked).toEqual([{ question: 'My landlord wants 40% more rent. Options?', level: 'strict' }]);

    // Working: pending for the asking key; another key is refused; a repeat ask from the same key does not ask twice.
    expect((await h.jobs.collect(meta.jobId, panel.publicKey)).status).toBe(202);
    expect((await h.jobs.collect(meta.jobId, early.publicKey)).status).toBe(409);
    expect((await h.jobs.ask(meta.jobId, body)).status).toBe(202);
    const other = await panelAsk(meta, { v: 1, question: 'another', level: 'strict' });
    expect((await h.jobs.ask(meta.jobId, other.body)).status).toBe(409);
    expect(h.asked).toHaveLength(1);

    h.answer(ANSWERED);
    await settle();
    const result = await opened(h.jobs, meta.jobId, panel);
    expect(result).toEqual({
      v: 1, state: 'answered', answer: 'Negotiate, or move.', model: 'anthropic/claude-sonnet-5.5', level: 'strict',
      rewritten: true, sent: 'What options does a tenant usually have?', route: 'zkapi', networkIdentity: 'hidden',
    });
    // Again for the same key (a re-mount); never for another.
    expect((await h.jobs.collect(meta.jobId, panel.publicKey)).status).toBe(200);
    expect((await h.jobs.collect(meta.jobId, other.panel.publicKey)).status).toBe(409);
  });

  test('Ask another: a new job for the key that asked, once the outcome is in; never for another key or a job still running', async () => {
    const h = harness();
    const meta = (await h.jobs.begin())!;
    const { panel, body } = await panelAsk(meta, { v: 1, question: 'q', level: 'strict' });
    // Nothing asked yet: no key has claimed the job.
    expect((await h.jobs.another(meta.jobId, panel.publicKey)).status).toBe(409);
    expect((await h.jobs.ask(meta.jobId, body)).status).toBe(202);
    expect(await h.jobs.another(meta.jobId, panel.publicKey)).toEqual({ status: 409, body: { status: 'pending' } });
    h.answer(ANSWERED);
    await settle();
    const other = await generatePanelKeyPair();
    expect(await h.jobs.another(meta.jobId, other.publicKey)).toEqual({ status: 409, body: { status: 'claimed' } });
    expect((await h.jobs.another(meta.jobId, 'junk')).status).toBe(400);
    const opened = await h.jobs.another(meta.jobId, panel.publicKey);
    expect(opened.status).toBe(200);
    const next = (opened.body as unknown as { meta: PrivateQuestionMetaV1 }).meta;
    expect(opened.body).toMatchObject({ status: 'opened', v: 1 });
    expect(next).toMatchObject({ v: 1, level: 'strict', cleanup: 'as_written', customInstruction: false, maxChars: PRIVATE_QUESTION_MAX_CHARS });
    expect(next.jobId).not.toBe(meta.jobId);
    expect(next.askKey).not.toBe(meta.askKey);
    expect(h.jobs.has(next.jobId)).toBe(true);
    // The old job still answers its panel; the new one takes a question of its own.
    expect((await h.jobs.collect(meta.jobId, panel.publicKey)).status).toBe(200);
    const second = await panelAsk(next, { v: 1, question: 'q2', level: 'standard' });
    expect((await h.jobs.ask(next.jobId, second.body)).status).toBe(202);
    expect(h.asked).toEqual([{ question: 'q', level: 'strict' }, { question: 'q2', level: 'standard' }]);
    expect((await h.jobs.another(`oly2p.${INSTALL}.${'z'.repeat(43)}`, panel.publicKey)).status).toBe(410);
    const none = new PrivateQuestionJobs({ installId: () => undefined, ask: () => Promise.resolve(ANSWERED), choice: () => ({ level: 'strict', cleanup: 'as_written', customInstruction: false }) });
    expect((await none.another(meta.jobId, panel.publicKey)).status).toBe(410);
  });

  test('a refusal from the ask lane, and a thrown ask, come back sealed in the user\'s words', async () => {
    const h = harness();
    const meta = (await h.jobs.begin())!;
    const { panel, body } = await panelAsk(meta, { v: 1, question: 'q', level: 'standard', cleanup: 'light_cleanup' });
    expect((await h.jobs.ask(meta.jobId, body)).status).toBe(202);
    expect(h.asked).toEqual([{ question: 'q', level: 'standard', cleanup: 'light_cleanup' }]);
    h.answer({ ok: false, code: 'spend_cap_reached', message: 'Today\'s spending limit is reached.' });
    await settle();
    expect(await opened(h.jobs, meta.jobId, panel)).toEqual({ v: 1, state: 'refused', code: 'spend_cap_reached', message: 'Today\'s spending limit is reached.' });

    const h2 = harness();
    const meta2 = (await h2.jobs.begin())!;
    const second = await panelAsk(meta2, { v: 1, question: 'q', level: 'strict' });
    expect((await h2.jobs.ask(meta2.jobId, second.body)).status).toBe(202);
    h2.answer(new Error('boom'));
    await settle();
    expect(await opened(h2.jobs, meta2.jobId, second.panel)).toMatchObject({ v: 1, state: 'refused', code: 'internal_error' });
  });

  test('bad asks are refused before the lane runs: wrong key, undecipherable, malformed plaintext, too long, unknown job', async () => {
    const h = harness();
    const meta = (await h.jobs.begin())!;
    expect((await h.jobs.ask(meta.jobId, { v: 1, publicKey: 'nope', iv: 'x', ciphertext: 'y' })).status).toBe(400);
    const stray = await generatePanelKeyPair();
    expect((await h.jobs.ask(meta.jobId, { v: 1, publicKey: stray.publicKey, iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).status).toBe(400);
    for (const plaintext of [
      { v: 2, question: 'q', level: 'strict' },
      { v: 1, question: '', level: 'strict' },
      { v: 1, question: 'q', level: 'open' },
      { v: 1, question: 'q', level: 'standard', cleanup: 'other' },
      { v: 1, question: 'x'.repeat(PRIVATE_QUESTION_MAX_CHARS + 1), level: 'strict' },
      { v: 1, question: 'a\u0000b', level: 'strict' },
      ['q'],
    ]) {
      const { body } = await panelAsk(meta, plaintext);
      expect((await h.jobs.ask(meta.jobId, body)).status, JSON.stringify(plaintext).slice(0, 60)).toBe(400);
    }
    expect(h.asked).toHaveLength(0);
    // A refused ask leaves the job open for a good one from any key.
    const good = await panelAsk(meta, { v: 1, question: 'q', level: 'strict' });
    expect((await h.jobs.ask(meta.jobId, good.body)).status).toBe(202);
    const unknown = `oly2p.${INSTALL}.${'Z'.repeat(43)}`;
    expect((await h.jobs.ask(unknown, good.body)).status).toBe(410);
    expect((await h.jobs.collect(unknown, good.panel.publicKey)).status).toBe(410);
    expect(h.jobs.has(unknown)).toBe(false);
  });

  test('expiry aborts a running ask; no install id means no job; the registry is bounded', async () => {
    const h = harness({ ttlMs: 1_000 });
    const meta = (await h.jobs.begin())!;
    const { panel, body } = await panelAsk(meta, { v: 1, question: 'q', level: 'strict' });
    expect((await h.jobs.ask(meta.jobId, body)).status).toBe(202);
    expect(h.aborted()).toBe(false);
    h.clock.now += 1_000;
    h.jobs.sweep();
    expect(h.aborted()).toBe(true);
    expect(h.jobs.has(meta.jobId)).toBe(false);
    expect((await h.jobs.collect(meta.jobId, panel.publicKey)).status).toBe(410);
    // An outcome that lands after expiry is dropped, never sealed to a stale job.
    h.answer(ANSWERED);
    await settle();
    expect((await h.jobs.collect(meta.jobId, panel.publicKey)).status).toBe(410);

    const none = new PrivateQuestionJobs({ installId: () => undefined, ask: () => Promise.resolve(ANSWERED), choice: () => ({ level: 'strict', cleanup: 'as_written', customInstruction: false }) });
    expect(await none.begin()).toBeUndefined();

    const bounded = harness({ maxJobs: 2 });
    const first = (await bounded.jobs.begin())!;
    await bounded.jobs.begin();
    await bounded.jobs.begin();
    expect(bounded.jobs.has(first.jobId)).toBe(false);

    // A job whose ask is running is never evicted: the oldest idle job goes instead, and the running one still answers.
    const busy = harness({ maxJobs: 2 });
    const running = (await busy.jobs.begin())!;
    const idle = (await busy.jobs.begin())!;
    const runningPanel = await panelAsk(running, { v: 1, question: 'Which?', level: 'strict' });
    expect((await busy.jobs.ask(running.jobId, runningPanel.body)).status).toBe(202);
    const third = (await busy.jobs.begin())!;
    expect(busy.jobs.has(running.jobId)).toBe(true);
    expect(busy.jobs.has(idle.jobId)).toBe(false);
    expect(busy.jobs.has(third.jobId)).toBe(true);
    busy.answer(ANSWERED);
    await settle();
    expect((await busy.jobs.collect(running.jobId, runningPanel.panel.publicKey)).status).toBe(200);
  });

  test('collection is rate limited per job', async () => {
    const h = harness();
    const meta = (await h.jobs.begin())!;
    const panel = await generatePanelKeyPair();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await h.jobs.collect(meta.jobId, panel.publicKey)).status);
    expect(statuses.filter((status) => status === 202)).toHaveLength(12);
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);
    h.clock.now += 2_000;
    expect((await h.jobs.collect(meta.jobId, panel.publicKey)).status).toBe(202);
  });

  test('the panel\'s default choice follows the composition root\'s, checked, with a fallback', async () => {
    const custom = harness({ choice: () => ({ level: 'standard', cleanup: 'custom', customInstruction: true }) });
    expect(await custom.jobs.begin()).toMatchObject({ level: 'standard', cleanup: 'custom', customInstruction: true });
    // custom without a saved instruction is not offered; junk falls back field by field.
    const noInstruction = harness({ choice: () => ({ level: 'standard', cleanup: 'custom', customInstruction: false }) });
    expect(await noInstruction.jobs.begin()).toMatchObject({ level: 'standard', cleanup: 'custom', customInstruction: false });
    const junk = harness({ choice: () => ({ level: 'open', cleanup: 'other', customInstruction: 'yes' } as never) });
    expect(await junk.jobs.begin()).toMatchObject({ level: 'standard', cleanup: 'as_written', customInstruction: false });
    const broken = harness({ choice: () => { throw new Error('unreadable'); } });
    // Unreadable settings: the defaults (Standard, lightly cleaned up), never a throw.
    expect(await broken.jobs.begin()).toMatchObject({ level: 'standard', cleanup: 'light_cleanup', customInstruction: false });
  });

  test('resultOf maps the ask lane\'s outcome field by field', () => {
    const { model: _model, ...unnamed } = ANSWERED as Extract<ConsultAskResult, { ok: true }>;
    expect(resultOf({ ...unnamed, rewritten: false, cleanup: 'as_written', level: 'standard' })).toEqual({
      v: 1, state: 'answered', answer: 'Negotiate, or move.', level: 'standard', cleanup: 'as_written', rewritten: false, route: 'zkapi', networkIdentity: 'hidden',
    });
    expect(resultOf({ ok: false, code: 'needs_choice', message: 'm', options: {} as never })).toEqual({ v: 1, state: 'refused', code: 'needs_choice', message: 'm' });
    // A send that failed after the question left carries the transport's outcome and what left.
    expect(resultOf({ ok: false, code: 'session_spent', message: 'm', sent: 'What left?', outcome: 'sent_failed' })).toEqual({ v: 1, state: 'refused', code: 'session_spent', message: 'm', outcome: 'sent_failed', sent: 'What left?' });
  });
});

describe('the HTTP handler: /ask and the collection of a question job', () => {
  const relayed = (request: Request) => request.headers.has('x-olympus-relay');
  const post = (handler: (request: Request) => Promise<Response>, path: string, body: unknown, headers: Record<string, string> = {}) =>
    handler(new Request(`http://127.0.0.1:8010${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PANEL_ORIGIN, 'x-olympus-relay': 's', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }));

  test('routes /ask and the collection to the question jobs, with the private answer checks in front', async () => {
    const h = harness({}, ANSWERED);
    const answers = new PrivateAnswerJobs({ eligible: async (items) => items.map(() => true), model: () => NO_MODEL, installId: () => INSTALL, log: () => {} });
    const handler = createPrivateAnswerHandler({ jobs: answers, questions: h.jobs, isRelayed: relayed });
    const meta = (await h.jobs.begin())!;
    const { panel, body } = await panelAsk(meta, { v: 1, question: 'q', level: 'strict' });

    // Not relayed, a foreign origin, junk, too big: refused before the jobs see it.
    expect((await handler(new Request(`http://127.0.0.1:8010/private/${meta.jobId}/ask`, { method: 'POST', headers: { origin: PANEL_ORIGIN }, body: JSON.stringify(body) }))).status).toBe(404);
    expect((await post(handler, `/private/${meta.jobId}/ask`, body, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(handler, `/private/${meta.jobId}/ask`, '{nope')).status).toBe(400);
    expect((await post(handler, `/private/${meta.jobId}/ask`, { ...body, pad: 'x'.repeat(PRIVATE_QUESTION_MAX_REQUEST_BYTES) })).status).toBe(413);
    expect((await post(handler, `/private/${meta.jobId}/ask?x=1`, body)).status).toBe(404);
    expect(h.asked).toHaveLength(0);

    const accepted = await post(handler, `/private/${meta.jobId}/ask`, body);
    expect(accepted.status).toBe(202);
    await settle();
    const ready = await post(handler, `/private/${meta.jobId}`, { v: 1, publicKey: panel.publicKey, cap: 2 });
    expect(ready.status).toBe(200);
    const sealed = await ready.json();
    // Ask another: routed to the question jobs too; a new job for the asking key.
    const another = await post(handler, `/private/${meta.jobId}/another`, { v: 1, publicKey: panel.publicKey });
    expect(another.status).toBe(200);
    const next = (await another.json()) as { status: string; meta: PrivateQuestionMetaV1 };
    expect(next.status).toBe('opened');
    expect(h.jobs.has(next.meta.jobId)).toBe(true);
    expect((await post(handler, `/private/${meta.jobId}/another`, { v: 1, publicKey: panel.publicKey, pad: 'x'.repeat(600) })).status).toBe(413);
    expect(sealed.status).toBe('ready');
    expect(JSON.parse((await openPrivateAnswer(meta.jobId, panel.privateKey, sealed)).replace(/\s+$/, ''))).toMatchObject({ state: 'answered', answer: 'Negotiate, or move.' });
    // A question job has no sources to open.
    expect((await post(handler, `/private/${meta.jobId}/open`, { v: 1, open: 'x'.repeat(43) })).status).toBe(410);
    // The response never carries the plaintext.
    expect(JSON.stringify(sealed)).not.toContain('Negotiate');
  });

  test('without question jobs, /ask is gone and a private answer collection is untouched', async () => {
    const answers = new PrivateAnswerJobs({ eligible: async (items) => items.map(() => true), model: () => NO_MODEL, installId: () => INSTALL, log: () => {} });
    const handler = createPrivateAnswerHandler({ jobs: answers, isRelayed: relayed });
    const jobId = `oly2p.${INSTALL}.${'B'.repeat(43)}`;
    const panel = await generatePanelKeyPair();
    expect((await post(handler, `/private/${jobId}/ask`, { v: 1, publicKey: panel.publicKey, iv: 'x', ciphertext: 'y' })).status).toBe(410);
    expect((await post(handler, `/private/${jobId}`, { v: 1, publicKey: panel.publicKey })).status).toBe(410);
  });
});

describe('the shared relay route', () => {
  test('parses collect, open and ask, and caps each body', () => {
    const jobId = `oly2p.${INSTALL}.${'B'.repeat(43)}`;
    expect(privateAnswerRoute(`/private/${jobId}`)).toEqual({ jobId, action: 'collect' });
    expect(privateAnswerRoute(`/private/${jobId}/open`)).toEqual({ jobId, action: 'open' });
    expect(privateAnswerRoute(`/private/${jobId}/ask`)).toEqual({ jobId, action: 'ask' });
    expect(privateAnswerRoute(`/private/${jobId}/another`)).toEqual({ jobId, action: 'another' });
    for (const path of [`/private/${jobId}/asks`, `/private/${jobId}/ask/`, `/private/${jobId}/ask/x`, `/private/${jobId}/open/ask`, '/private//ask']) {
      expect(privateAnswerRoute(path), path).toBeUndefined();
    }
    expect(privateAnswerMaxRequestBytes('ask')).toBe(PRIVATE_QUESTION_MAX_REQUEST_BYTES);
    expect(privateAnswerMaxRequestBytes('collect')).toBe(PRIVATE_ANSWER_MAX_REQUEST_BYTES);
    expect(privateAnswerMaxRequestBytes('open')).toBe(PRIVATE_ANSWER_MAX_REQUEST_BYTES);
    expect(PRIVATE_QUESTION_MAX_REQUEST_BYTES).toBeGreaterThan(PRIVATE_ANSWER_MAX_REQUEST_BYTES);
  });
});

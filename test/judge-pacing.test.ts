import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenAICompatibleAnalystModel, type OpenAIAnalystFetch } from '../src/core/analyst-openai.ts';
import { createVeniceAnalystModel } from '../src/core/analyst-venice.ts';
import { JudgeRateLimitPacer, JUDGE_PROMPT_CACHE_KEY, JUDGE_RATE_LIMIT_RETRIES } from '../src/workers/classification/judge-pacing.ts';
import { JudgeCloudStopped, JudgeSpending, withJudgeSpendingStop } from '../src/workers/classification/judge-spending.ts';
import { tierSnifferServiceEnv } from '../src/workers/classification/sniffer-service.ts';
import { SNIFFER_MAX_CONCURRENT_CLOUD_CALLS } from '../src/workers/classification/sniffer-resolver.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));

const request = { system: 'synthetic instructions', prompt: 'synthetic item', localOnly: true, maxOutputChars: 310 } as const;
const ok = (headers: Record<string, string> = {}) => Response.json({ choices: [{ message: { content: '{"verdicts":[]}' } }] }, { headers });

function judge(pacer: JudgeRateLimitPacer, fetchImpl: OpenAIAnalystFetch) {
  return pacer.model(createOpenAICompatibleAnalystModel({ apiKey: 'synthetic-key', model: 'qwen3-6-35b-a3b',
    reasoningEffort: 'low', reasoningHeadroomTokens: 0, maxTokensField: 'max_completion_tokens', admitsLocalOnly: true,
    fetchImpl: pacer.fetch(fetchImpl) }));
}

test('calls wait while the reported request window is spent, then resume at its reset', async () => {
  const clock = createTestClock();
  const pacer = new JudgeRateLimitPacer(clock);
  const reset = String(clock.now() + 60_000);
  let sent = 0;
  const model = judge(pacer, async () => {
    sent += 1;
    return ok({ 'x-ratelimit-remaining-requests': String(Math.max(0, 2 - sent)), 'x-ratelimit-reset-requests': reset });
  });
  await model.complete(request);
  await model.complete(request);
  expect(sent).toBe(2);
  const third = model.complete(request);
  await flushMicrotasks();
  expect(sent).toBe(2);
  await clock.advance(59_999);
  expect(sent).toBe(2);
  await clock.advance(1);
  await third;
  expect(sent).toBe(3);
});

test('a stale reply arriving late does not forget calls sent after a newer report', async () => {
  const clock = createTestClock();
  const pacer = new JudgeRateLimitPacer(clock);
  const reset = String(clock.now() + 60_000);
  const replies: Array<(remaining: number) => void> = [];
  const model = judge(pacer, () => new Promise<Response>(resolve => {
    replies.push(remaining => resolve(ok({ 'x-ratelimit-remaining-requests': String(remaining), 'x-ratelimit-reset-requests': reset })));
  }));
  const a = model.complete(request);
  const b = model.complete(request);
  await flushMicrotasks();
  expect(replies.length).toBe(2);
  // B's reply comes first: one call left in the window.
  replies[1]!(1);
  await b;
  const c = model.complete(request);
  await flushMicrotasks();
  expect(replies.length).toBe(3);
  // The window is now spent by C. A's older reply (5 left) must not reopen it.
  replies[0]!(5);
  await a;
  const d = model.complete(request);
  await flushMicrotasks();
  expect(replies.length).toBe(3);
  replies[2]!(0);
  await c;
  await flushMicrotasks();
  expect(replies.length).toBe(3);
  await clock.advance(60_000);
  await flushMicrotasks();
  expect(replies.length).toBe(4);
  replies[3]!(10);
  await d;
});

test('a late reply from an earlier call can still lower the allowance', async () => {
  const clock = createTestClock();
  const pacer = new JudgeRateLimitPacer(clock);
  const reset = String(clock.now() + 60_000);
  const replies: Array<(remaining: number) => void> = [];
  const model = judge(pacer, () => new Promise<Response>(resolve => {
    replies.push(remaining => resolve(ok({ 'x-ratelimit-remaining-requests': String(remaining), 'x-ratelimit-reset-requests': reset })));
  }));
  const a = model.complete(request);
  const b = model.complete(request);
  await flushMicrotasks();
  // B was admitted first and saw 1 left; A was admitted last and saw none.
  replies[1]!(1);
  await b;
  replies[0]!(0);
  await a;
  const c = model.complete(request);
  await flushMicrotasks();
  expect(replies.length).toBe(2);
  await clock.advance(60_000);
  await flushMicrotasks();
  expect(replies.length).toBe(3);
  replies[2]!(10);
  await c;
});

test('a 429 waits for the reset and retries the same item instead of failing it', async () => {
  const clock = createTestClock();
  const pacer = new JudgeRateLimitPacer(clock);
  let sent = 0;
  const model = judge(pacer, async () => {
    sent += 1;
    if (sent === 1) return new Response('', { status: 429, headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': String(clock.now() + 20_000) } });
    return ok();
  });
  const call = model.complete(request);
  await flushMicrotasks();
  expect(sent).toBe(1);
  await clock.advance(20_000);
  const completion = await call;
  expect(sent).toBe(2);
  expect(completion.text).toBe('{"verdicts":[]}');
});

test('a 429 without a reset backs off and gives up after the retry limit', async () => {
  const clock = createTestClock();
  const pacer = new JudgeRateLimitPacer(clock);
  let sent = 0;
  const model = judge(pacer, async () => { sent += 1; return new Response('', { status: 429 }); });
  let failed: unknown;
  const call = model.complete(request).catch(error => { failed = error; });
  while (failed === undefined && await clock.advanceToNext()) await flushMicrotasks();
  await call;
  expect(sent).toBe(JUDGE_RATE_LIMIT_RETRIES + 1);
  expect(failed).toBeInstanceOf(Error);
  expect(failed).not.toBeInstanceOf(JudgeCloudStopped);
});

test('other failures are not retried', async () => {
  const pacer = new JudgeRateLimitPacer(createTestClock());
  let sent = 0;
  const model = judge(pacer, async () => { sent += 1; return new Response('', { status: 503 }); });
  await expect(model.complete(request)).rejects.toBeInstanceOf(Error);
  expect(sent).toBe(1);
});

test('a 402 still pauses judging through the spending stop, with no retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-pacing-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const budget = new JudgeSpending(join(dir, 'budget.json')); budget.choose('venice', 20);
  const pacer = new JudgeRateLimitPacer(createTestClock());
  let sent = 0;
  const model = withJudgeSpendingStop(judge(pacer, budget.fetch(async () => { sent += 1; return new Response('', { status: 402 }); })), () => budget.status());
  await expect(model.complete(request)).rejects.toBeInstanceOf(JudgeCloudStopped);
  expect(sent).toBe(1);
  expect(budget.status().stop).toBe('payment');
});

test('a rate-limited call releases its spending reservation and the retry is reserved once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-pacing-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const budget = new JudgeSpending(join(dir, 'budget.json')); budget.choose('venice', 20);
  const clock = createTestClock();
  const pacer = new JudgeRateLimitPacer(clock);
  let sent = 0;
  const model = judge(pacer, budget.fetch(async () => {
    sent += 1;
    if (sent === 1) return new Response('', { status: 429, headers: { 'x-ratelimit-reset-requests': String(clock.now() + 1_000) } });
    return Response.json({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1_000, completion_tokens: 10 } });
  }));
  const call = model.complete(request);
  await flushMicrotasks();
  await clock.advance(1_000);
  await call;
  // Exactly one call's usage: 1,000 * $0.10/M + 10 * $1.00/M.
  expect(budget.status().spentDollars).toBeCloseTo(0.00011, 8);
});

test('Venice judge requests carry a content-free prompt cache key', async () => {
  let body: Record<string, unknown> = {};
  const model = createVeniceAnalystModel({ apiKey: 'synthetic-key', promptCacheKey: JUDGE_PROMPT_CACHE_KEY,
    fetchImpl: async (_url, init) => { body = JSON.parse(String(init.body)) as Record<string, unknown>; return ok(); } });
  await model.complete({ system: 'synthetic', prompt: 'synthetic', localOnly: false });
  expect(body.prompt_cache_key).toBe(JUDGE_PROMPT_CACHE_KEY);
  expect(JUDGE_PROMPT_CACHE_KEY).toMatch(/^olympus-judge-[0-9a-f]{16}$/);
});

test('the concurrency setting may exceed the local cap for a cloud judge', () => {
  expect(tierSnifferServiceEnv({ OLYMPUS_TIER_SNIFFER_CONCURRENT_CALLS: '24' }).concurrentCalls).toBe(24);
  expect(tierSnifferServiceEnv({ OLYMPUS_TIER_SNIFFER_CONCURRENT_CALLS: '999' }).concurrentCalls).toBe(SNIFFER_MAX_CONCURRENT_CLOUD_CALLS);
});

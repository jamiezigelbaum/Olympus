// The private answer panel's speed and liveness (2026-10-01 live incident:
// the panel sat on "Preparing the answer on your Mac…" past its two-minute
// wait while the built-in model ran a long answer plus an audit pass).
//
// 1. Every claimed job is ready or failed within its deadline, counted from
//    the claim: a hung model, a hung refresh, a job queued behind a hung one,
//    or a job dropped while queued all settle, and the deadline sits inside
//    the panel's own wait.
// 2. The sniffer yields to the answer: a claim preempts its in-flight call,
//    it asks nothing while the answer runs, and it resumes after.
// 3. Each settled job logs one line of stage timings with no content.
// 4. The panel reads a bounded slice of work: the most relevant items, a
//    tight prompt, a short answer, no audit pass.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { AnalystModel } from '../src/core/analyst.ts';
import type { AnswerPrivatelyOptions } from '../src/core/analyst-built-in.ts';
import { createAnswerActivity } from '../src/workers/answer-activity.ts';
import type { PrivateAnswerModel } from '../src/workers/chatgpt/private-answer-contract.ts';
import { generatePanelKeyPair } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PRIVATE_ANSWER_ANALYSIS_TIMEOUT_MS, PrivateAnswerJobs } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { createBuiltInPrivateAnswerModel, PANEL_ANSWER_LIMITS } from '../src/workers/chatgpt/private-answer-model.ts';
import { CHATGPT_PRIVATE_ANSWER_POLL_CAP_MS } from '../src/workers/dashboard/chatgpt/private-answer.ts';
import { appendClassificationLedgerEntry } from '../src/workers/classification-ledger.ts';
import {
  clearInstalledTierClassification,
  InstalledTierClassification,
} from '../src/workers/classification/installed-tier-classification.ts';
import { CachedTierSniffer, SNIFFER_PROMPT_VERSION } from '../src/workers/classification/sniffer.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';

const INSTALL = 'c'.repeat(32);
const QUESTION = 'SENTINEL_QUESTION_91c2 what did my blood work show';
const EVIDENCE = [{ title: 'SENTINEL_EVIDENCE_91c2', trust_domain: 'secure_local', chunks: ['SENTINEL_PASSAGE_91c2'] }];
const CONTENT = /SENTINEL_[A-Z_]+_91c2|blood work/;

const cleanups: Array<() => void> = [];
afterEach(() => {
  clearInstalledTierClassification();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function model(answer: PrivateAnswerModel['answerPrivately'], extra: Partial<PrivateAnswerModel> = {}): PrivateAnswerModel {
  return { status: () => ({ state: 'ready' }), answerPrivately: answer, ...extra };
}

function harness(answer: PrivateAnswerModel['answerPrivately'], options: { timeoutMs?: number; extra?: Partial<PrivateAnswerModel> } = {}) {
  const lines: string[] = [];
  const events: string[] = [];
  const activity = { begins: 0, ends: 0, begin() { this.begins += 1; }, end() { this.ends += 1; } };
  const jobs = new PrivateAnswerJobs({
    model: () => model(answer, options.extra),
    installId: () => INSTALL,
    analysisTimeoutMs: options.timeoutMs ?? 60,
    resetTimeoutMs: 20,
    audit: (event) => events.push(event),
    activity,
    log: (line) => lines.push(line),
  });
  return { jobs, lines, events, activity };
}

describe('1. every claimed job settles within its deadline', () => {
  test('the deadline sits inside the panel wait, so the panel sees ready or failed, never "taking longer"', () => {
    expect(PRIVATE_ANSWER_ANALYSIS_TIMEOUT_MS).toBeLessThan(CHATGPT_PRIVATE_ANSWER_POLL_CAP_MS - 5_000);
  });

  test('a model that hangs and ignores abort: failed at the deadline, the activity ends once, the model is reset', async () => {
    let resets = 0;
    const { jobs, lines, activity, events } = harness(() => new Promise(() => {}), { extra: { reset: () => { resets += 1; } } });
    const jobId = jobs.begin({ question: QUESTION, count: 1, evidence: EVIDENCE }).jobId!;
    const panel = await generatePanelKeyPair();
    expect((await jobs.claim(jobId, panel.publicKey)).status).toBe(202);
    expect(activity.begins).toBe(1);
    await Bun.sleep(100);
    expect(await jobs.claim(jobId, panel.publicKey)).toEqual({ status: 200, body: { status: 'failed' } });
    expect(activity).toMatchObject({ begins: 1, ends: 1 });
    expect(resets).toBe(1);
    expect(events).toEqual(['analysis_deadline']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[private-answer\] outcome=failed reason=deadline /);
  });

  test('a job queued behind a hung one fails by its own deadline, counted from its claim', async () => {
    const { jobs, activity } = harness(() => new Promise(() => {}), { timeoutMs: 60 });
    const first = jobs.begin({ question: 'one', count: 1, evidence: EVIDENCE }).jobId!;
    const second = jobs.begin({ question: 'two', count: 1, evidence: EVIDENCE }).jobId!;
    const panel = await generatePanelKeyPair();
    await jobs.claim(first, panel.publicKey);
    await jobs.claim(second, panel.publicKey);
    await Bun.sleep(100);
    expect((await jobs.claim(first, panel.publicKey)).body.status).toBe('failed');
    expect((await jobs.claim(second, panel.publicKey)).body.status).toBe('failed');
    expect(activity).toMatchObject({ begins: 2, ends: 2 });
  });

  test('an evidence refresh that hangs and ignores abort: failed at the deadline, inference never starts', async () => {
    let inferences = 0;
    const { jobs, lines } = harness(async () => { inferences += 1; return { answer: 'x', citations: [] }; });
    const jobId = jobs.begin({ question: QUESTION, count: 1, evidence: EVIDENCE, refresh: () => new Promise(() => {}) }).jobId!;
    const panel = await generatePanelKeyPair();
    await jobs.claim(jobId, panel.publicKey);
    await Bun.sleep(100);
    expect((await jobs.claim(jobId, panel.publicKey)).body.status).toBe('failed');
    expect(inferences).toBe(0);
    expect(lines[0]).toContain('reason=deadline');
  });

  test('a job dropped while it waits in the queue settles at once and ends its activity', async () => {
    const clock = { now: 0 };
    const activity = { begins: 0, ends: 0, begin() { this.begins += 1; }, end() { this.ends += 1; } };
    const jobs = new PrivateAnswerJobs({
      model: () => model(() => new Promise(() => {})),
      installId: () => INSTALL,
      now: () => clock.now,
      ttlMs: 1_000,
      analysisTimeoutMs: 10_000,
      audit: () => {},
      activity,
      log: () => {},
    });
    const first = jobs.begin({ question: 'one', count: 1, evidence: EVIDENCE }).jobId!;
    clock.now = 500;
    const second = jobs.begin({ question: 'two', count: 1, evidence: EVIDENCE }).jobId!;
    const panel = await generatePanelKeyPair();
    await jobs.claim(first, panel.publicKey);
    await jobs.claim(second, panel.publicKey);
    clock.now = 2_000;
    jobs.sweep();
    await Bun.sleep(10);
    expect(activity).toMatchObject({ begins: 2, ends: 2 });
  });

  test('a ready answer logs its stage timings once, with no content', async () => {
    const { jobs, lines, activity } = harness(async (_question, _evidence, _signal, observe) => {
      observe?.evidence?.({ items: 1, unreadable: 0, bytes: 21 });
      observe?.modelCall?.({ stage: 'main', ms: 12, promptBytes: 3_000, ok: true, promptTokens: 900, promptMs: 4, outputTokens: 40, outputMs: 8 });
      return { answer: 'SENTINEL_ANSWER_91c2', citations: [{ title: 'SENTINEL_EVIDENCE_91c2' }] };
    });
    const jobId = jobs.begin({ question: QUESTION, count: 1, evidence: EVIDENCE }).jobId!;
    const panel = await generatePanelKeyPair();
    await jobs.claim(jobId, panel.publicKey);
    await Bun.sleep(30);
    expect((await jobs.claim(jobId, panel.publicKey)).body.status).toBe('ready');
    expect(activity).toMatchObject({ begins: 1, ends: 1 });
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toMatch(/^\[private-answer\] outcome=sealed queued_ms=\d+ matched=1 items=1 unreadable=0 evidence_bytes=21 model_ms=\d+ main_ms=12 main_prompt_bytes=3000 main_prompt_tokens=900 main_prefill_ms=4 main_output_tokens=40 main_generate_ms=8 total_ms=\d+$/);
    expect(line).not.toMatch(CONTENT);
    expect(line).not.toContain(jobId);
  });
});

describe('2. the sniffer yields to a private answer', () => {
  const LANE: SnifferLane = {
    kind: 'local',
    modelId: 'fixture-local-sniffer',
    profileId: 'local-sniffer',
    profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-local-sniffer' },
  };
  const subject = (n: number) => ({ provider: 'fixture', accountScope: 'personal', providerItemId: `item-${n}` });

  test('a claim preempts the in-flight sniffer call, the sniffer asks nothing while the answer runs, and resumes after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-private-answer-timing-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ledgerPath = join(dir, 'store.tier-ledger.sqlite');
    const ledger = new TierLedger({ dbPath: ledgerPath });
    cleanups.push(() => ledger.close());
    const installed = new InstalledTierClassification({ env: {}, lane: LANE });
    cleanups.push(() => installed.close());
    const store = installed.snifferStoreForLedger(ledgerPath);
    for (let n = 0; n < 3; n += 1) {
      ledger.recordDecision(subject(n), classifyItemTiers({ signals: { title: `bank ${n}` }, subject: subject(n) }, { sniffer: new CachedTierSniffer(store, LANE) }));
    }
    const classificationLedgerPath = join(dir, 'classification-ledger.jsonl');
    await appendClassificationLedgerEntry(classificationLedgerPath, {
      recorded_at: new Date().toISOString(),
      kind: 'classifier_model_decision',
      what: 'approved',
      model_id: LANE.modelId,
      prompt_version: SNIFFER_PROMPT_VERSION,
      lane: LANE.kind,
      profile_id: LANE.profileId,
      approved_by: 'owner',
      status: 'complete',
    });

    // One local model shared by the sniffer and the answer, one request at a time.
    const log: string[] = [];
    let sniffStarted!: () => void;
    const sniffing = new Promise<void>((resolve) => { sniffStarted = resolve; });
    let sniffCalls = 0;
    const sniffer: AnalystModel = {
      complete(request) {
        sniffCalls += 1;
        log.push('sniff:start');
        sniffStarted();
        return new Promise((_, reject) => request.signal?.addEventListener('abort', () => {
          log.push('sniff:aborted');
          reject(new Error('aborted'));
        }, { once: true }));
      },
    };
    let service: TierSnifferService | undefined;
    const activity = createAnswerActivity(() => service?.preempt());
    service = new TierSnifferService({
      installed,
      lane: LANE,
      model: sniffer,
      stores: () => [{ dbPath: join(dir, 'store.sqlite') }],
      classificationLedgerPath,
      shouldYield: () => activity.busy,
      answersInFlight: () => activity.busy,
    });
    cleanups.push(() => service?.stop());

    let finishAnswer!: () => void;
    const jobs = new PrivateAnswerJobs({
      model: () => model(() => {
        log.push('answer:start');
        return new Promise((resolve) => { finishAnswer = () => { log.push('answer:done'); resolve({ answer: 'ok', citations: [] }); }; });
      }),
      installId: () => INSTALL,
      activity,
      log: () => {},
    });

    const pass = service.runOnce();
    await sniffing;
    const jobId = jobs.begin({ question: 'q', count: 1, evidence: EVIDENCE }).jobId!;
    const panel = await generatePanelKeyPair();
    await jobs.claim(jobId, panel.publicKey);
    expect(await pass).toMatchObject({ state: 'ran', report: { stoppedBy: 'preempted', failedCalls: 0 } });
    await Bun.sleep(10);
    expect(log).toEqual(['sniff:start', 'sniff:aborted', 'answer:start']);
    expect(activity.busy).toBe(true);

    // A sniffer tick while the answer runs asks the model nothing.
    const callsBefore = sniffCalls;
    await service.runOnce();
    expect(sniffCalls).toBe(callsBefore);

    finishAnswer();
    await Bun.sleep(20);
    expect((await jobs.claim(jobId, panel.publicKey)).body.status).toBe('ready');
    expect(activity.busy).toBe(false);

    // Once the answer is done the sniffer resumes.
    const resumed = service.runOnce();
    await Bun.sleep(20);
    expect(sniffCalls).toBeGreaterThan(callsBefore);
    service.preempt();
    await resumed;
  });
});

describe('4. the panel reads a bounded slice of work', () => {
  test('the most relevant readable items, clipped passages, a tight prompt, a short answer and no audit', async () => {
    const seen: { count?: number; longest?: number; options?: AnswerPrivatelyOptions } = {};
    const panelModel = createBuiltInPrivateAnswerModel({
      model: { stop: async () => {} } as never,
      available: () => true,
      answer: async (_question, items, options) => {
        seen.count = items.length;
        seen.longest = Math.max(...items.map((item) => item.text.length));
        seen.options = options;
        return { answer: 'ok', citations: [], unanswered: [], modelId: 'built_in/test' };
      },
    });
    const hits = Array.from({ length: 12 }, (_, n) => ({ title: `item ${n}`, chunks: ['x'.repeat(5_000)], trust_domain: 'secure_local' }));
    const stats: Array<{ items: number; unreadable: number; bytes: number }> = [];
    await panelModel.answerPrivately('q', [{ title: 'no text', trust_domain: 'secure_local' }, ...hits], undefined, { evidence: (s) => stats.push(s) });
    expect(seen.count).toBe(PANEL_ANSWER_LIMITS.maxItems);
    expect(seen.longest).toBeLessThanOrEqual(PANEL_ANSWER_LIMITS.maxPassageChars);
    expect(seen.options).toMatchObject({
      maxPromptBytes: PANEL_ANSWER_LIMITS.maxPromptBytes,
      maxAnswerChars: PANEL_ANSWER_LIMITS.maxAnswerChars,
      audit: false,
    });
    expect(stats).toEqual([{ items: PANEL_ANSWER_LIMITS.maxItems, unreadable: 1, bytes: PANEL_ANSWER_LIMITS.maxItems * PANEL_ANSWER_LIMITS.maxPassageChars }]);
  });
});

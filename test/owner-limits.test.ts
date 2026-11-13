import { limitStopReference } from '../src/core/limit-stops.ts';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ownerLimits, limitRunOnceSource } from '../src/core/owner-limits.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { ownerLimitSettingsPath, readJudgeCallOverride, saveJudgeCallOverride, withOwnerLimitStore } from '../src/core/owner-limit-state.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';
import { buildBalanceReport, reconcileProviderPauseFile, startVeniceCreditRecovery } from '../src/core/provider-credit-status.ts';
import { ownerLimitStopHooks } from '../src/core/owner-limit-state.ts';
import { SnifferCallBudget, runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { CachedTierSniffer } from '../src/workers/classification/sniffer.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { copyDashboardViewModel, limitsToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { callChatGptTool, listChatGptTools } from '../src/workers/chatgpt/mcp-surface.ts';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { DelphiClient } from '../src/core/delphi.ts';
import { findOperationByName } from '../src/core/operations.ts';
import { listMcpTools } from '../src/mcp/tools.ts';
import { APPROVED_TOOLS } from '../connect-relay/server/directory/approved.ts';
import type { SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { GoogleDailyRequestBudget, GoogleRequestBudgetError } from '../src/workers/google-connectors/request-budget.ts';
import { ReadwiseDailyRequestBudget, ReadwiseRequestBudgetError } from '../src/workers/readwise/connector.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';

const clock = () => createTestClock(Date.parse('2026-11-12T23:59:59.000Z'));
const roots: string[] = [];
function scratch() { const root = mkdtempSync(join(tmpdir(), 'olympus-owner-limits-')); roots.push(root); return root; }
beforeEach(() => {
  rmSync(ownerLimitSettingsPath(), { force: true });
  withOwnerLimitStore(store => {
    for (const state of store.list()) store.recordSuccess({ sourceId: state.sourceId, corpusId: state.corpusId, taskId: state.taskId,
      completedAt: '2026-11-12T00:00:00Z', resultStatus: 'idle' });
    for (const stop of store.openLimitStops(new Date(0))) store.clearLimitStop(stop.id, stop.subject);
  });
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const stops = (now: Date) => withOwnerLimitStore(store => store.openLimitStops(now));
const lane: SnifferLane = { kind: 'local', modelId: 'fixture', profileId: 'fixture', profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' } };

/** The plugin's EmailClient reaches a real worker route, which runs the shared handler beside the store. */
function context() {
  const config = { ...defaultConfig(), email: { ...defaultConfig().email, enabled: true, baseUrl: 'http://worker.test/v1' } };
  const worker = createEmailSourceWorker({ ownerLimits: params => ownerLimits(params) });
  const email = new EmailClient(config, { requestJson: async (url, init) => {
    const response = await worker.fetch(new Request(url, init));
    if (!response.ok) throw new Error(`worker answered ${response.status}`);
    return response.json();
  } });
  return { config, email, delphi: new DelphiClient(config) };
}
function emptyView(): SourceDashboardViewModel {
  return { kind: 'source_dashboard', sources: [], generated_at: '2026-11-12T23:59:59Z', summary: {},
    onboarding: { steps: [], ask_first_question: { enabled: false, label: '', suggestion: '' } }, answer_lanes: [],
    where_your_data_lives: [], unassigned_corpora: { corpus_count: 0, entries: [] },
    excluded_by_configuration: { entries: [] }, folder_picker: { available: false }, history: {}, policy: {} } as unknown as SourceDashboardViewModel;
}

test('a stopped sniffer pass reports amounts; one Raise clears it and the same budget judges on its next pass', async () => {
  const time = clock();
  const budget = new SnifferCallBudget({ maxCallsPerDay: 0, now: time.date });
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const sniffer = new TierSnifferStore({ dbPath: ':memory:' });
  const subject = { provider: 'fixture', accountScope: 'personal', providerItemId: 'one' };
  ledger.recordDecision(subject, classifyItemTiers({ subject, signals: { title: 'Tax return' }, text: 'Financial notes for Thursday.' }, { sniffer: new CachedTierSniffer(sniffer, lane) }));
  let calls = 0;
  const model = { async complete(request: { prompt: string }) {
    calls++;
    const items = request.prompt.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    return { modelId: lane.modelId, text: JSON.stringify({ verdicts: items.map(item => ({ i: item.i, tier: 'private', category: 'financial', confidence: 0.99 })) }) };
  } };
  try {
    const run = () => runSnifferPass({ targets: [{ ledger, sniffer }], lane, budget, model });
    expect((await run()).stoppedBy).toBe('daily_budget');
    expect(calls).toBe(0);
    expect(stops(time.date())).toEqual([{ id: 'judge.daily_calls', subject: 'judge', since: time.date().toISOString(), limit: 0, used: 0, resumesAt: '2026-11-13T00:00:00.000Z' }]);
    const listed = await ownerLimits({}, { now: time.date });
    expect(listed.stops?.[0]).toMatchObject({ label: expect.any(String), kind: 'calls', scope: 'judge', unit: 'calls', continue: 'raise', limit: 0, used: 0 });
    await ownerLimits({ action: 'continue', id: 'judge.daily_calls', to: 10 }, { now: time.date });
    expect(stops(time.date())).toEqual([]);
    expect((await run()).calls).toBeGreaterThan(0);
    expect(calls).toBeGreaterThan(0);
    expect(stops(time.date())).toEqual([]);
  } finally { sniffer.close(); ledger.close(); }
}, 30_000);

test('one-day and permanent raises follow the UTC boundary and preserve the daily counter across restart', async () => {
  const time = clock();
  const statePath = join(scratch(), 'budget.json');
  const budget = new SnifferCallBudget({ maxCallsPerDay: 1, now: time.date, statePath });
  expect(budget.tryConsume()).toBe(true);
  expect(budget.tryConsume()).toBe(false);
  await ownerLimits({ action: 'continue', id: 'judge.daily_calls', to: 3 }, { now: time.date });
  expect(budget.tryConsume()).toBe(true);
  const restored = new SnifferCallBudget({ maxCallsPerDay: 1, now: time.date, statePath });
  expect(restored.usedToday()).toBe(2);
  expect(restored.tryConsume()).toBe(true);
  expect(restored.tryConsume()).toBe(false);
  await time.advance(1_000);
  expect(readJudgeCallOverride(time.date())).toBeUndefined();
  expect(restored.usedToday()).toBe(0);
  expect(restored.tryConsume()).toBe(true);
  expect(restored.tryConsume()).toBe(false);
  await ownerLimits({ action: 'continue', id: 'judge.daily_calls', to: 4, keep: true }, { now: time.date });
  expect(restored.tryConsume()).toBe(true);
  await time.advance(24 * 60 * 60_000);
  expect(readJudgeCallOverride(time.date())).toBe(4);
  for (let i = 0; i < 4; i++) expect(restored.tryConsume()).toBe(true);
  expect(restored.tryConsume()).toBe(false);
  await ownerLimits({ action: 'continue', id: 'judge.daily_calls', to: 6 }, { now: time.date });
  await time.advance(24 * 60 * 60_000);
  expect(readJudgeCallOverride(time.date())).toBe(4);
});

test('a temporary override wins over the environment cap including decision-mode calls', () => {
  const time = clock();
  const budget = new SnifferCallBudget({ maxCallsPerDay: 0, now: time.date });
  saveJudgeCallOverride(2, false, time.date());
  expect(budget.tryConsume(true)).toBe(true);
  expect(budget.tryConsume(true)).toBe(true);
  expect(budget.tryConsume(true)).toBe(false);
});

test('Venice marker -> stop -> owner refill proves billing canConsume and clears without restarting', async () => {
  const time = clock(); const path = join(scratch(), 'venice.json');
  reconcileProviderPauseFile(path, buildBalanceReport(time.date(), { canConsume: false, balances: { usd: 100 } }), ownerLimitStopHooks);
  expect(stops(time.date())).toHaveLength(1);
  let canConsume = false; let wakes = 0;
  const credit = { env: { VENICE_API_KEY: 'never-print-this-key' }, fetchImpl: async (url: string) => {
    expect(url.startsWith('https://api.venice.ai/api/v1/billing/')).toBe(true);
    return Response.json(url.includes('/balance') ? { canConsume, balances: { usd: 100 } } : { data: [] });
  } };
  const run = () => ownerLimits({ action: 'continue', id: 'venice.credit' }, { now: time.date, credit, wake: () => wakes++ });
  expect((await run()).ok).toBe(false);
  expect(existsSync(path)).toBe(true);
  canConsume = true;
  const result = await run();
  expect(result.ok).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(stops(time.date())).toEqual([]);
  expect(wakes).toBe(1);
  expect(JSON.stringify(result)).not.toContain('never-print-this-key');
}, 30_000);

test('bounded automatic Venice re-check resumes an external refill, and shutdown fences late probes', async () => {
  const time = clock(); const path = join(scratch(), 'venice.json');
  reconcileProviderPauseFile(path, buildBalanceReport(time.date(), { canConsume: false }), ownerLimitStopHooks);
  let canConsume = false; let probes = 0; let wakes = 0;
  const stop = startVeniceCreditRecovery({ paths: () => [path], stops: ownerLimitStopHooks, onResume: () => wakes++,
    probe: async () => { probes++; return buildBalanceReport(time.date(), { canConsume }); },
    schedule: (run, ms) => time.setTimeout(run, ms) as unknown as ReturnType<typeof setTimeout>,
    cancel: timer => time.clearTimeout(timer as unknown as ReturnType<typeof time.setTimeout>),
  });
  await flushMicrotasks();
  expect(probes).toBe(1);
  canConsume = true;
  await time.advance(15 * 60_000 - 1);
  expect(existsSync(path)).toBe(true);
  await time.advance(1);
  expect(existsSync(path)).toBe(false);
  expect(stops(time.date())).toEqual([]);
  expect(wakes).toBe(1);
  stop(); expect(time.pendingTimers()).toBe(0);

  let finish!: (report: ReturnType<typeof buildBalanceReport>) => void;
  const stopLate = startVeniceCreditRecovery({ paths: () => [path], probe: () => new Promise(resolve => { finish = resolve; }) });
  stopLate(); finish(buildBalanceReport(time.date(), { canConsume: false }));
  await flushMicrotasks();
  expect(existsSync(path)).toBe(false);
});

test('run_once selects the exact subject, keeps costs tracked, and refuses ambiguous or irrelevant options', async () => {
  const time = clock(); const store = new LocalSourceSchedulerStateStore();
  try { for (const taskId of ['head', 'reconcile']) store.recordSuccess({ sourceId: 'x.bookmarks', corpusId: 'internal.x', taskId, resultStatus: 'idle', completedAt: time.date().toISOString(), degradedReason: 'daily_cost_guard', counts: { limit_stop_limit: 2_000_000, limit_stop_used: 2_100_000 } }); }
  finally { store.close(); }
  await expect(ownerLimits({ action: 'continue', id: 'x.daily_cost' }, { now: time.date })).rejects.toThrow('More than one');
  const subject = stops(time.date())[0]!.subject;
  let selected: string | undefined;
  const result = await ownerLimits({ action: 'continue', id: 'x.daily_cost', subject }, { now: time.date, runOnce: async value => { selected = value; return { status: 'checking' }; } });
  expect(selected).toBe(subject); expect(result.ok).toBe(true);
  // Until the source's operator pass actually runs, the stop and truthful amounts stay visible.
  expect(stops(time.date())[0]).toMatchObject({ limit: 2, used: 2.1 });
  await expect(ownerLimits({ action: 'continue', id: 'x.daily_cost', subject, keep: true }, { now: time.date })).rejects.toThrow('only to Raise');
});

test('Home Raise and Refill buttons call the shared operation; local tools list it and the reviewer list does not', async () => {
  const time = clock();
  new SnifferCallBudget({ maxCallsPerDay: 0, now: time.date }).tryConsume();
  const path = join(scratch(), 'venice.json');
  reconcileProviderPauseFile(path, buildBalanceReport(time.date(), { canConsume: false }), ownerLimitStopHooks);
  const model = copyDashboardViewModel(buildChatGptDashboardViewModel(emptyView(), { now: time.date(), limitStops: stops(time.date()) }));
  const raise = model.waits!.find(row => row.fix?.args?.id === 'judge.daily_calls')!;
  const refill = model.waits!.find(row => row.fix?.args?.id === 'venice.credit')!;
  expect(raise.fix).toMatchObject({ label: 'Raise to 1 call', tool: 'olympus_limits', args: { action: 'continue', id: 'judge.daily_calls', subject: limitStopReference({ id: 'judge.daily_calls', subject: 'judge' }), to: 1 } });
  expect(refill.fix).toMatchObject({ label: 'Refill — re-check', tool: 'olympus_limits', args: { action: 'continue', id: 'venice.credit', subject: limitStopReference({ id: 'venice.credit', subject: path }) } });
  expect(raise).toMatchObject({ limit: 0, used: 0, unit: 'calls' });
  expect(JSON.stringify(model)).not.toContain(path);
  const listing = limitsToolResult(await ownerLimits({}, { now: time.date }));
  expect(JSON.stringify(listing)).not.toContain(path);
  expect(JSON.stringify(listing)).toContain(limitStopReference({ id: 'venice.credit', subject: path }));
  const ctx = context();
  expect(listMcpTools(defaultConfig()).some(tool => tool.name === 'olympus_limits')).toBe(true);
  expect(listChatGptTools(ctx).some(tool => tool.name === 'olympus_limits')).toBe(true);
  expect(APPROVED_TOOLS.some(tool => tool.name === 'olympus_limits')).toBe(false);
  // Surface dispatch, then the same shared handler as CLI/MCP. Use a live date for the operation's own clock.
  withOwnerLimitStore(store => store.reportLimitStop({ ...stops(time.date())[0]!, resumesAt: '2099-01-01T00:00:00Z' }));
  const result = await callChatGptTool('olympus_limits', raise.fix!.args!, ctx, { dashboardView: async () => emptyView() });
  expect(result.isError).not.toBe(true);
  expect(readJudgeCallOverride(new Date())).toBe(1);
  expect(stops(time.date()).filter(stop => stop.id === 'judge.daily_calls')).toEqual([]);
});

test('CLI lists units, waiting work, times and actions, then continues by id with --to and --keep', async () => {
  const now = new Date();
  new SnifferCallBudget({ maxCallsPerDay: 0, now: () => now }).tryConsume();
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, 'src/cli.ts', 'limits', ...args], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).toBe(''); expect(code).toBe(0); return JSON.parse(out);
  };
  const listed = await run([]);
  expect(listed.stops[0]).toMatchObject({ id: 'judge.daily_calls', subject: 'judge', label: expect.any(String), since: now.toISOString(), unit: 'calls', limit: 0, used: 0, continue: 'raise', resumesAt: expect.any(String) });
  const result = await run(['continue', 'judge.daily_calls', '--subject', 'judge', '--to', '42', '--keep']);
  expect(result).toMatchObject({ ok: true, to: 42, keep: true, unit: 'calls' });
  expect((await run([])).stops).toEqual([]);
  expect(readJudgeCallOverride(new Date(now.getTime() + 24 * 60 * 60_000))).toBe(42);
  expect(findOperationByName('olympus_limits')!.cliHints.name).toBe('limits');
}, 30_000);

test('the plugin reaches limits through the worker, and run_once names the operator sync source', async () => {
  let requested: string | undefined; let body: unknown;
  const client = new EmailClient({ ...defaultConfig(), email: { ...defaultConfig().email, enabled: true, baseUrl: 'http://worker.test/v1' } }, { requestJson: async (url, init) => { requested = url; body = JSON.parse(String(init.body)); return { stops: [] }; } });
  await client.ownerLimits({ action: 'list' });
  expect(requested).toBe('http://worker.test/v1/limits');
  expect(body).toEqual({ action: 'list' });
  expect(limitRunOnceSource(JSON.stringify(['gmail.email', 'internal.gmail', 'pull']))).toBe('gmail');
  expect(() => limitRunOnceSource(JSON.stringify(['local.files', 'internal.files', 'pull']))).toThrow('no run-once action');
});

test('a marker the Node plugin wrote alone is reported as a stop by the engine marker check', () => {
  const time = clock(); const path = join(scratch(), 'venice.json');
  reconcileProviderPauseFile(path, buildBalanceReport(time.date(), { canConsume: false }));
  expect(stops(time.date())).toEqual([]);
  const stop = startVeniceCreditRecovery({ paths: () => [], markers: () => [path], stops: ownerLimitStopHooks, markerCheckMs: 60_000,
    schedule: (run, ms) => time.setTimeout(run, ms) as unknown as ReturnType<typeof setTimeout>,
    cancel: timer => time.clearTimeout(timer as unknown as ReturnType<typeof time.setTimeout>),
  });
  expect(stops(time.date()).map(open => [open.id, open.subject])).toEqual([['venice.credit', path]]);
  stop(); expect(time.pendingTimers()).toBe(0);
});


test('provider guards pass the amounts already available, leaving the durable Google used count unknown', () => {
  const time = clock();
  const readwise = new ReadwiseDailyRequestBudget({ dailyRequestBudget: 1, now: time.date });
  readwise.reserve();
  try { readwise.reserve(); throw new Error('must stop'); }
  catch (error) { expect(error).toBeInstanceOf(ReadwiseRequestBudgetError); expect((error as ReadwiseRequestBudgetError).amounts).toEqual({ limit: 1, used: 1 }); }
  for (const durable of [false, true]) {
    const google = new GoogleDailyRequestBudget({ provider: 'Gmail', dailyRequestBudget: 1, now: time.date,
      ...(durable ? { statePath: join(scratch(), 'google.sqlite') } : {}) });
    google.reserve();
    try { google.reserve(); throw new Error('must stop'); }
    catch (error) {
      expect(error).toBeInstanceOf(GoogleRequestBudgetError);
      expect((error as GoogleRequestBudgetError).amounts).toEqual(durable ? { limit: 1 } : { limit: 1, used: 1 });
    }
  }
});

test('request stop amounts retain their units through marker persistence and reopening', () => {
  const time = clock();
  const store = new LocalSourceSchedulerStateStore();
  try { store.recordSuccess({ sourceId: 'gmail.email', corpusId: 'internal.gmail', taskId: 'pull', completedAt: time.date().toISOString(), resultStatus: 'idle',
    degradedReason: 'gmail_daily_api_request_guard', counts: { limit_stop_limit: 100, limit_stop_used: 100 } }); }
  finally { store.close(); }
  expect(stops(time.date())).toMatchObject([{ id: 'gmail.daily_requests', limit: 100, used: 100 }]);
});

test('a refused, restarting or unconfirmed continue reaches the CLI and Home in its own words without claiming more than is known', async () => {
  const config = { ...defaultConfig(), email: { ...defaultConfig().email, enabled: true, baseUrl: 'http://worker.test/v1' } };
  const answering = (status: number, error: { code: string; message: string }) => {
    const email = new EmailClient(config, new DirectHttpEmailTransport(async () => Response.json({ error, policy: { raw_email_exposed: false } }, { status })));
    return { config, email, delphi: new DelphiClient(config) };
  };
  const refused = answering(400, { code: 'invalid_params', message: '--to must be a whole number greater than the current limit and used calls.' });
  await expect(refused.email.ownerLimits({ action: 'continue', id: 'judge.daily_calls', to: 0 })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('--to must be') });
  // A restart (even one that replaced an applied answer), a timeout or a failure: never claim the stop is still open.
  for (const [status, code, message] of [[503, 'worker_restarting', 'Olympus is restarting; try again in a moment.'], [503, 'engine_background_unavailable', 'The background engine is not answering.'], [502, 'engine_background_failed', 'The background could not run this.']] as const) {
    const ctx = answering(status, { code, message });
    await expect(ctx.email.ownerLimits({ action: 'continue', id: 'judge.daily_calls', to: 5 })).rejects.toMatchObject({ message, suggestion: expect.stringContaining('may still go through') });
    const home = await callChatGptTool('olympus_limits', { action: 'continue', id: 'venice.credit' }, ctx, { dashboardView: async () => emptyView() });
    expect(home.isError).toBe(true);
    expect(home.structuredContent).toMatchObject({ error: 'limit_unconfirmed' });
    expect(JSON.stringify(home.content)).toContain('may still go through');
    expect(JSON.stringify(home.content)).not.toContain('still open');
  }
});

test('zkAPI request/spend refusals list exact amounts and independent one-day and permanent raises resume reservations', async () => {
  const time = clock();
  const path = join(scratch(), 'zkapi.json');
  const { reserveZkapiRequest } = await import('../src/core/consult-transport-zkapi.ts');
  const { readOwnerLimitOverride } = await import('../src/core/owner-limit-state.ts');
  const reserve = () => reserveZkapiRequest(path, { requestCap: 0, spendCapMicroUsd: 1_000_000 }, time.date(), undefined, 2_000_000);
  expect(reserve()).toEqual({ reserved: false, reason: 'daily_cap_reached' });
  expect((await ownerLimits({}, { now: time.date })).stops).toMatchObject([{ id: 'zkapi.daily_requests', label: expect.any(String), unit: 'requests', limit: 0, used: 0, waiting: { runs: 1 }, resumesAt: '2026-11-13T00:00:00.000Z' }]);
  const since = stops(time.date())[0]!.since;
  reserve();
  expect(stops(time.date())[0]!.since).toBe(since);
  await ownerLimits({ action: 'continue', id: 'zkapi.daily_requests', to: 2, keep: true }, { now: time.date });
  expect(reserve()).toEqual({ reserved: false, reason: 'spend_cap_reached' });
  expect(stops(time.date())[0]).toMatchObject({ id: 'zkapi.daily_spend', limit: 1, used: 0, toContinue: { raiseTo: 2 } });
  await expect(ownerLimits({ action: 'continue', id: 'zkapi.daily_spend', to: 1.5 }, { now: time.date })).rejects.toThrow('next step');
  await ownerLimits({ action: 'continue', id: 'zkapi.daily_spend', to: 3 }, { now: time.date });
  expect(reserve()).toEqual({ reserved: true });
  expect(stops(time.date())).toEqual([]);
  saveJudgeCallOverride(10, true, time.date());
  expect(readOwnerLimitOverride('zkapi.dailyRequests', time.date())).toBe(2);
  expect(readOwnerLimitOverride('zkapi.dailySpend', time.date())).toBe(3);
  await time.advance(1_000);
  expect(readOwnerLimitOverride('zkapi.dailySpend', time.date())).toBeUndefined();
  expect(readOwnerLimitOverride('zkapi.dailyRequests', time.date())).toBe(2);
});

test('judge cap Raise and payment Refill preserve usage and resume the same transport with no probe', async () => {
  const { JudgeSpending, JudgeCloudStopped } = await import('../src/workers/classification/judge-spending.ts');
  const path = join(scratch(), 'judge.json');
  const budget = new JudgeSpending(path);
  budget.choose('venice', 0);
  let calls = 0, payment = false;
  const send = budget.fetch(async () => { calls++; return payment ? new Response('', { status: 402 }) : Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }); });
  const init = { method: 'POST', body: JSON.stringify({ model: 'qwen3-6-35b-a3b', messages: [], max_completion_tokens: 10 }) };
  await expect(send('https://fixture.invalid', init)).rejects.toBeInstanceOf(JudgeCloudStopped);
  expect(calls).toBe(0);
  expect((await ownerLimits({})).stops).toMatchObject([{ id: 'judge.spend_cap', unit: 'usd', limit: 0, used: 0 }]);
  await ownerLimits({ action: 'continue', id: 'judge.spend_cap', to: 1 });
  await send('https://fixture.invalid', init);
  const spent = budget.status().spentDollars;
  payment = true;
  await expect(send('https://fixture.invalid', init)).rejects.toBeInstanceOf(JudgeCloudStopped);
  expect(budget.status().spentDollars).toBe(spent);
  expect((await ownerLimits({})).stops).toMatchObject([{ id: 'judge.payment', unit: 'usd', continue: 'refill', used: spent }]);
  await ownerLimits({ action: 'continue', id: 'judge.payment' });
  expect(calls).toBe(2);
  await expect(send('https://fixture.invalid', init)).rejects.toBeInstanceOf(JudgeCloudStopped);
  expect(stops(new Date()).find(stop => stop.id === 'judge.payment')).toBeDefined();
  await ownerLimits({ action: 'continue', id: 'judge.payment' });
  payment = false;
  await send('https://fixture.invalid', init);
  expect(calls).toBe(4);
  expect(budget.status().spentDollars).toBeGreaterThan(spent);
  expect(stops(new Date())).toEqual([]);
});

test('Gmail import waits offer Raise or run_once, update the existing counter and retain usage', async () => {
  const { gmailImportAllowance, gmailImportBudget, GMAIL_IMPORT_MIN_DAILY_BUDGET, GMAIL_IMPORT_LIMIT_SUBJECT, withGmailImportRunOnce } = await import('../src/workers/google-connectors/gmail-import-allowance.ts');
  const { createGmailDailyRequestBudget } = await import('../src/workers/google-connectors/gmail.ts');
  const time = clock();
  const counter = createGmailDailyRequestBudget({ env: { OLYMPUS_SOURCE_INDEX_GMAIL_DAILY_API_REQUEST_BUDGET: '1' }, statePath: join(scratch(), 'gmail.sqlite'), now: time.date });
  const allowance = gmailImportAllowance({ usage: () => counter.status(), now: time.date });
  const gate = gmailImportBudget(counter, allowance);
  expect(allowance.check(14)).toBe('gmail_budget_too_small');
  allowance.reportWait?.('gmail_budget_too_small');
  const listed = await ownerLimits({}, { now: time.date });
  expect(listed.stops).toMatchObject([{ id: 'gmail.import_allowance', label: expect.any(String), unit: 'requests', limit: 1, used: 0, continue: 'raise' }]);
  const copied = JSON.parse((limitsToolResult(listed).content[0] as { text: string }).text);
  expect(copied.stops[0]).toMatchObject({ continue: 'raise', reason: 'gmail_budget_too_small' });
  await ownerLimits({ action: 'continue', id: 'gmail.import_allowance', to: GMAIL_IMPORT_MIN_DAILY_BUDGET }, { now: time.date });
  expect(counter.status().dailyRequestBudget).toBe(GMAIL_IMPORT_MIN_DAILY_BUDGET);
  for (let i = 0; i < GMAIL_IMPORT_MIN_DAILY_BUDGET / 2; i++) gate.reserve();
  expect(allowance.check(1)).toBe('gmail_import_allowance_spent');
  allowance.reportWait?.('gmail_import_allowance_spent');
  expect(stops(time.date())[0]).toMatchObject({ id: 'gmail.import_allowance', continue: 'run_once', limit: 16, used: 16, resumesAt: '2026-11-13T00:00:00.000Z' });
  await ownerLimits({ action: 'continue', id: 'gmail.import_allowance' }, { now: time.date, runOnce: async subject => {
    expect(subject).toBe(GMAIL_IMPORT_LIMIT_SUBJECT);
    await withGmailImportRunOnce(async () => { for (let i = 0; i < 20; i++) gate.reserve(); });
    return { status: 'completed' };
  } });
  expect(counter.status().requests).toBe(36);
  expect(stops(time.date())).toEqual([]);
  expect(allowance.check(1)).toBe('gmail_requests_spent');
  allowance.reportWait?.('gmail_requests_spent');
  expect(stops(time.date())[0]).toMatchObject({ reason: 'gmail_requests_spent', continue: 'run_once', limit: 32, used: 36 });
});

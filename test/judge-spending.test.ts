import { DASHBOARD_UNLOCK_HEADER } from '../src/core/dashboard-launch.ts';
import { runTierClassifier } from '../src/workers/classification/tier-cli.ts';
import { ownerLocalMint, ownerUnlockKey } from './helpers/owner-local-mint.ts';
import { adoptExistingCloudApproval, carryCloudJudgeApproval, createJudgeSetup } from '../src/workers/classification/judge-setup.ts';
import { approveClassifier, readClassificationLedger, isClassifierApproved, revokeClassifier } from '../src/workers/classification-ledger.ts';
import { snifferPromptVersions } from '../src/workers/classification/sniffer.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { createOpenAICompatibleAnalystModel } from '../src/core/analyst-openai.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_VENICE_JUDGE_MODEL, JUDGE_PRICES, JudgeSpending, JudgeCloudStopped, judgeArchiveEstimate, readJudgeSpending, withJudgeSpendingStop } from '../src/workers/classification/judge-spending.ts';
import { resolveJudgeChoiceRuntime, resolveTierSnifferRuntime } from '../src/workers/classification/built-in-sniffer.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { renderJudgeChoice } from '../src/workers/dashboard/pages/local.ts';
import { buildDashboardPreviewView } from '../scripts/dashboard-preview.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { CachedTierSniffer } from '../src/workers/classification/sniffer.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'judge-cap-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'budget.json');
  const budget = new JudgeSpending(path);
  return { path, budget };
}
const request = { method: 'POST', body: JSON.stringify({ model: 'qwen3-6-35b-a3b', messages: [{ role: 'user', content: 'ordinary synthetic text' }], max_completion_tokens: 256 }) };
const response = () => Response.json({ choices: [{ message: { content: 'synthetic answer' } }] });

test('cloud is off until explicit opt-in, regardless of a size recommendation', async () => {
  const { budget } = fixture(); let calls = 0;
  expect(judgeArchiveEstimate(1_250_000, 'qwen3-6-35b-a3b').recommended).toBe('venice');
  const send = budget.fetch(async () => { calls++; return response(); });
  await expect(send('https://api.venice.ai/api/v1/chat/completions', request)).rejects.toBeInstanceOf(JudgeCloudStopped);
  expect(calls).toBe(0); expect(budget.status().spentDollars).toBe(0);
});

test('reservations stop at the cap, serialize concurrent calls, and survive restart', async () => {
  const { path, budget } = fixture(); let calls = 0;
  // The output limit alone costs $0.000256: this cap fits one call, never two.
  budget.choose('venice', 0.0005);
  const send = budget.fetch(async () => { calls++; await Promise.resolve(); return response(); });
  await Promise.allSettled([send('https://api.venice.ai/api/v1/chat/completions', request), send('https://api.venice.ai/api/v1/chat/completions', request)]);
  expect(calls).toBe(1); expect(budget.status().stop).toBe('cap');
  const restarted = new JudgeSpending(path);
  expect(restarted.status()).toEqual(budget.status());
  await expect(restarted.fetch(async () => { calls++; return response(); })('https://api.venice.ai/api/v1/chat/completions', request)).rejects.toBeInstanceOf(JudgeCloudStopped);
  expect(calls).toBe(1); expect(readJudgeSpending(path).spentDollars).toBeLessThanOrEqual(0.0005);
  // Raising the total cap preserves historical spend.
  const spent = budget.status().spentDollars; budget.choose('venice', 1); expect(budget.status().spentDollars).toBe(spent);
});

test('a crash or uncertain transport retains its debit; provider usage releases excess reservation', async () => {
  const { budget } = fixture(); budget.choose('venice', 1);
  await expect(budget.fetch(async () => { throw new Error('transport lost'); })('https://api.venice.ai/api/v1/chat/completions', request)).rejects.toThrow('transport lost');
  const unknown = budget.status().spentDollars; expect(unknown).toBeGreaterThan(0);
  await budget.fetch(async () => Response.json({ usage: { prompt_tokens: 100, completion_tokens: 20 } }))('https://api.venice.ai/api/v1/chat/completions', request);
  expect(Math.round(budget.status().spentDollars * 1e6)).toBe(Math.round(unknown * 1e6) + 30);
});

test('402 is a durable terminal payment stop with an account repair route', async () => {
  const { path, budget } = fixture(); budget.choose('venice', 20); let calls = 0; let stops = 0;
  const send = budget.fetch(async () => { calls++; return new Response('', { status: 402 }); }, () => { stops++; });
  await expect(send('https://api.venice.ai/api/v1/chat/completions', request)).rejects.toBeInstanceOf(JudgeCloudStopped);
  await expect(send('https://api.venice.ai/api/v1/chat/completions', request)).rejects.toBeInstanceOf(JudgeCloudStopped);
  expect(calls).toBe(1); expect(stops).toBeGreaterThan(0); expect(readJudgeSpending(path).stop).toBe('payment');
  const html = renderJudgeChoice(buildDashboardPreviewView('ready'), { controlSessionCsrfToken: 'synthetic', judgeSetup: { ...budget.status(), cloudModel: 'qwen3-6-35b-a3b', cloudAvailable: true } });
  expect(html).toContain('HTTP 402'); expect(html).toContain('https://venice.ai/settings/api');
  expect(html).toContain('end-to-end encrypted option is not available yet');
  expect(html).toContain('including items it marks Private');
});

test('size recommendation uses the measured short-item rate and the strict 14-night threshold', () => {
  const threshold = 67 * 60 * 8 * 14;
  expect(judgeArchiveEstimate(threshold, 'qwen3-6-35b-a3b').recommended).toBe('local');
  expect(judgeArchiveEstimate(threshold + 1, 'qwen3-6-35b-a3b').recommended).toBe('venice');
  expect(judgeArchiveEstimate(1_000, 'qwen3-6-35b-a3b').cloudDollars).toBeCloseTo(0.16);
});

test('choice uses the existing policy lane and falls back to local after a cloud stop', () => {
  const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
  const input = { engine };
  const local = resolveJudgeChoiceRuntime(input, { choice: 'local', stop: null, remainingDollars: 20 });
  const cloud = resolveJudgeChoiceRuntime(input, { choice: 'venice', stop: null, remainingDollars: 20 });
  expect(local.source !== 'off' && local.lane.kind).toBe('local');
  expect(cloud.source !== 'off' && cloud.lane.kind).toBe('venice');
  expect(resolveJudgeChoiceRuntime(input, { choice: 'venice', stop: 'cap', remainingDollars: 0 })).toEqual(local);
  expect(resolveJudgeChoiceRuntime(input, { choice: 'venice', stop: 'payment', remainingDollars: 20 })).toEqual(local);
  const noCloud = resolveJudgeChoiceRuntime({ engine: createSovereigntyEngine(loadSovereigntyPreset('local-only')) }, { choice: 'venice', stop: null, remainingDollars: 20 });
  expect(noCloud.source).toBe('off');
});

test('a cap stop never fails, settles or lowers a queued Private item', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-private-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new TierLedger({ dbPath: join(dir, 'tier.sqlite') }); cleanup.push(() => ledger.close());
  const store = new TierSnifferStore({ dbPath: join(dir, 'sniffer.sqlite') }); cleanup.push(() => store.close());
  const lane: SnifferLane = { kind: 'venice', profileId: 'synthetic', modelId: 'kimi-k3', profile: { provider: 'venice', trust: 'encrypted_cloud', model: 'kimi-k3' } };
  const subject = { provider: 'synthetic', accountScope: 'personal', providerItemId: 'one' };
  const decision = classifyItemTiers({ signals: { title: 'My medical records', labels: ['SSN 123-45-6789'] }, subject }, { sniffer: new CachedTierSniffer(store, lane) });
  ledger.recordDecision(subject, decision);
  const before = ledger.getCurrent(subject);
  const questions = store.listQuestions({ limit: 100 }); expect(questions.length).toBeGreaterThan(0);
  const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane, model: { complete: async () => { throw new JudgeCloudStopped('cap'); } } });
  expect(report.stoppedBy).toBe('cloud_stopped'); expect(report.failedCalls).toBe(0); expect(report.failSafePrivate).toBe(0); expect(report.verdictsApplied).toBe(0);
  expect(ledger.getCurrent(subject)).toEqual(before); expect(store.listQuestions({ limit: 100 })).toEqual(questions);
});

test('the real cloud adapter preserves a payment stop rather than treating it as an item failure', async () => {
  const { budget } = fixture(); budget.choose('venice', 20);
  let calls = 0;
  const model = withJudgeSpendingStop(createOpenAICompatibleAnalystModel({ apiKey: 'synthetic-key', model: 'qwen3-6-35b-a3b',
    reasoningEffort: 'low', reasoningHeadroomTokens: 0, maxTokensField: 'max_completion_tokens', admitsLocalOnly: true,
    fetchImpl: budget.fetch(async () => { calls++; return new Response('', { status: 402 }); }),
  }), () => budget.status());
  await expect(model.complete({ system: 'synthetic instructions', prompt: 'synthetic item', localOnly: true, maxOutputChars: 310 })).rejects.toBeInstanceOf(JudgeCloudStopped);
  expect(calls).toBe(1); expect(budget.status().stop).toBe('payment');
});

test('judge approval POST requires local controls and CSRF; a bearer cannot opt in', async () => {
  const { path } = fixture(); let saves = 0;
  const worker = createEmailSourceWorker({ sourceDashboard: {
    sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('local-first')), registryPath: path + '-handles.json',
    judgeSetup: { status: () => ({ choice: 'local', capDollars: 0, spentDollars: 0, remainingDollars: 0, stop: null, cloudAvailable: true, cloudModel: 'kimi-k3' }),
      save: async (choice, cap) => { expect(choice).toBe('venice'); expect(cap).toBe(20); saves++; return { ok: true, status_message: 'Saved' }; } },
  } }); cleanup.push(() => worker.close());
  const fetcher = withWorkerBearerAuth(worker.fetch, { authToken: 'synthetic-bearer' });
  const origin = 'http://127.0.0.1:17777';
  const post = (headers: Record<string, string>, body: unknown = { choice: 'venice', cap_dollars: 20 }) => fetcher(new Request(origin + '/dashboard/models/judge', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
  }));
  expect((await post({})).status).toBe(401);
  expect((await post({ Authorization: 'Bearer synthetic-bearer' })).status).toBe(403);
  const mint = await ownerLocalMint(fetcher, origin, 'synthetic-bearer'); expect(mint.status).toBe(200);
  const cookie = mint.headers.get('Set-Cookie')!.split(';')[0]!;
  const csrf = (await mint.json() as { csrf_token: string }).csrf_token;
  expect((await post({ Cookie: cookie, 'X-Olympus-CSRF': 'wrong' })).status).toBe(403);
  const headers = { Cookie: cookie, 'X-Olympus-CSRF': csrf };
  const saved = await post(headers); expect(saved.status).toBe(200); expect(saves).toBe(1);
  expect((await post(headers, { choice: 'venice', cap_dollars: -1 })).status).toBe(400); expect(saves).toBe(1);
});


test('the actual setup backend opts out even with no local judge and no reload support', async () => {
  const { budget, path } = fixture(); budget.choose('venice', 20);
  const cloud = resolveJudgeChoiceRuntime({ engine: createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only')) }, { choice: 'venice', stop: null, remainingDollars: 20 });
  const backend = createJudgeSetup({ spending: budget, cloud, local: () => ({ source: 'off', reason: 'no_private_lane' }),
    ledgerPath: path + '.ledger', promptVersion: () => snifferPromptVersions().approval, credentialReady: () => false, requestReload: () => false });
  const result = await backend.save('local', 10);
  expect(result.status_message).toContain('Cloud judging is off'); expect(budget.status().choice).toBe('local');
  let calls = 0;
  await expect(budget.fetch(async () => { calls++; return response(); })('https://api.venice.ai/api/v1/chat/completions', request)).rejects.toBeInstanceOf(JudgeCloudStopped);
  expect(calls).toBe(0);
});

test('the actual setup backend records exact consent before opt-in and can lower an active cap without reload support', async () => {
  const { budget, path } = fixture();
  const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
  const cloud = resolveJudgeChoiceRuntime({ engine }, { choice: 'venice', stop: null, remainingDollars: 20 });
  expect(cloud.source).not.toBe('off');
  const promptVersion = snifferPromptVersions().approval;
  const backend = createJudgeSetup({ spending: budget, cloud, local: () => resolveJudgeChoiceRuntime({ engine }, { choice: 'local', stop: null, remainingDollars: 0 }),
    ledgerPath: path + '.ledger', promptVersion: () => promptVersion, credentialReady: () => true, requestReload: () => false });
  await backend.save('venice', 20);
  const lane = cloud.source === 'off' ? null : cloud.lane;
  expect(isClassifierApproved((await readClassificationLedger(path + '.ledger')).entries,
    { lane: lane!.kind, profileId: lane!.profileId, modelId: lane!.modelId, promptVersion })).toBe(true);
  expect(budget.status().choice).toBe('venice');
  const fallback = resolveJudgeChoiceRuntime({ engine }, { choice: 'local', stop: null, remainingDollars: 0 });
  if (fallback.source !== 'off') expect(isClassifierApproved((await readClassificationLedger(path + '.ledger')).entries,
    { lane: fallback.lane.kind, profileId: fallback.lane.profileId, modelId: fallback.lane.modelId, promptVersion })).toBe(true);
  await backend.save('venice', 0); expect(budget.status().capDollars).toBe(0);
  let calls = 0;
  await expect(budget.fetch(async () => { calls++; return response(); })('https://api.venice.ai/api/v1/chat/completions', request)).rejects.toBeInstanceOf(JudgeCloudStopped);
  expect(calls).toBe(0);
});

test('definite rejected requests release reservations; ambiguous failures retain them', async () => {
  const { budget } = fixture(); budget.choose('venice', 1);
  for (const status of [400, 401, 403, 429]) {
    await budget.fetch(async () => new Response('', { status }))('https://api.venice.ai/api/v1/chat/completions', request);
    expect(budget.status().spentDollars).toBe(0);
  }
  await budget.fetch(async () => new Response('', { status: 503 }))('https://api.venice.ai/api/v1/chat/completions', request);
  expect(budget.status().spentDollars).toBeGreaterThan(0);
});

test('reported usage above the allowance is recorded and stops further cloud calls', async () => {
  const { budget } = fixture(); budget.choose('venice', 0.001);
  await budget.fetch(async () => Response.json({ usage: { prompt_tokens: 100_000, completion_tokens: 256 } }))('https://api.venice.ai/api/v1/chat/completions', request);
  expect(budget.status().spentDollars).toBeCloseTo(0.010256, 6); expect(budget.status().stop).toBe('cap');
  let calls = 0;
  await expect(budget.fetch(async () => { calls++; return response(); })('https://api.venice.ai/api/v1/chat/completions', request)).rejects.toBeInstanceOf(JudgeCloudStopped);
  expect(calls).toBe(0);
});

test('a corrupt spending record disables cloud without resetting it or preventing local selection', async () => {
  const { budget, path } = fixture(); budget.choose('venice', 20); writeFileSync(path, '{broken');
  expect(budget.status().stop).toBe('storage');
  const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
  const runtime = resolveJudgeChoiceRuntime({ engine }, budget.status());
  expect(runtime.source !== 'off' && runtime.lane.kind).toBe('local');
  expect(() => budget.choose('venice', 20)).toThrow('saved judge budget'); expect(readFileSync(path, 'utf8')).toBe('{broken');
  const html = renderJudgeChoice(buildDashboardPreviewView('ready'), { controlSessionCsrfToken: 'synthetic', judgeSetup: { ...budget.status(), cloudModel: 'kimi-k3', cloudAvailable: true } });
  expect(html).toContain('Spending amounts are unavailable'); expect(html).not.toContain('Spent or reserved: $0');
});

test('a terminal cloud stop leaves the real service waiting without a continuation loop', async () => {
  const { path } = fixture(); const storePath = path + '.items'; const ledgerPath = tierLedgerPathForStore(storePath);
  const lane: SnifferLane = { kind: 'venice', profileId: 'synthetic', modelId: 'kimi-k3', profile: { provider: 'venice', trust: 'encrypted_cloud', model: 'kimi-k3' } };
  const ledger = new TierLedger({ dbPath: ledgerPath }); cleanup.push(() => ledger.close());
  const installed = new InstalledTierClassification({ env: {}, lane }); cleanup.push(() => installed.close());
  const queue = installed.snifferStoreForLedger(ledgerPath);
  const subject = { provider: 'synthetic', accountScope: 'personal', providerItemId: 'one' };
  ledger.recordDecision(subject, classifyItemTiers({ signals: { title: 'My medical records', labels: ['SSN 123-45-6789'] }, subject }, { sniffer: new CachedTierSniffer(queue, lane) }));
  await approveClassifier(path + '.ledger', lane, snifferPromptVersions().approval, 'Synthetic fixture approval');
  let calls = 0; let asked!: () => void; const done = new Promise<void>(resolve => { asked = resolve; });
  const service = new TierSnifferService({ installed, lane, model: { complete: async () => { calls++; asked(); throw new JudgeCloudStopped('cap'); } },
    stores: () => [{ dbPath: storePath, tierSetBinding: () => ({ ledgerPath }) }], classificationLedgerPath: path + '.ledger', intervalMs: 5 });
  cleanup.push(() => service.stop()); service.start();
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('Service did not reach the stop')), 1000))]);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(calls).toBe(1); expect(service.status().waiting?.reason).toBe('cloud_stopped');
  expect(service.status().waiting?.label).toContain('Keys');
});

test('cloud judging spends its calls on newest items before an aged backlog', async () => {
  let now = new Date('2026-01-01T00:00:00Z');
  const ledger = new TierLedger({ dbPath: ':memory:' }); cleanup.push(() => ledger.close());
  const queue = new TierSnifferStore({ dbPath: ':memory:', now: () => now }); cleanup.push(() => queue.close());
  const lane: SnifferLane = { kind: 'venice', profileId: 'synthetic', modelId: 'kimi-k3', profile: { provider: 'venice', trust: 'encrypted_cloud', model: 'kimi-k3' } };
  const add = (n: number, title: string) => {
    const subject = { provider: 'synthetic', accountScope: 'personal', providerItemId: String(n) };
    ledger.recordDecision(subject, classifyItemTiers({ signals: { title, labels: ['SSN 123-45-6789'] }, subject }, { sniffer: new CachedTierSniffer(queue, lane) }));
  };
  add(0, 'oldest health file'); now = new Date('2026-01-01T02:00:00Z');
  for (let n = 1; n <= 6; n++) add(n, `recent health file ${n}`);
  const prompts: string[] = [];
  await runSnifferPass({ targets: [{ ledger, sniffer: queue }], lane, maxCallsPerPass: 5, model: { complete: async request => {
    prompts.push(request.prompt); return { text: JSON.stringify({ verdicts: [{ i: 1, tier: 'private', category: 'health', confidence: 1, ownRecord: true, privateKind: 'health' }] }), modelId: 'kimi-k3' };
  } } });
  expect(prompts.length).toBe(5); expect(prompts.every(prompt => !prompt.includes('oldest health file'))).toBe(true);
});

test('saving the choice already shown still says it saved, and Local needs no spending limit (#950)', async () => {
  const { Window } = await import('happy-dom');
  const { mountDashboardController } = await import('../src/control-ui/browser-controller.ts');
  const browser = new Window({ url: 'http://localhost/dashboard?keys' });
  const keys = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS', 'HTMLDialogElement'] as const;
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: browser[key] });
  let dispose = () => {};
  try {
    // An existing Venice approval with no limit yet: the limit field is empty.
    const html = renderJudgeChoice(buildDashboardPreviewView('ready'), { controlSessionCsrfToken: 'synthetic', judgeSetup: { choice: 'local', capDollars: 0, spentDollars: 0, remainingDollars: 0, stop: null, uncapped: true, cloudModel: 'kimi-k3', cloudAvailable: true } });
    const root = document.createElement('div'); root.innerHTML = html; document.body.append(root);
    expect(root.querySelector<HTMLInputElement>('input[name="cap_dollars"]')!.value).toBe('');
    expect(root.querySelector<HTMLInputElement>('input[name="cap_dollars"]')!.required).toBe(false);
    const calls: unknown[] = [];
    let redraws = 0;
    // The server answers with the same page: nothing else on it shows the save happened.
    const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, pollIntervalMs: -1, returnUrl: 'http://localhost/dashboard?keys', navigate() {},
      refresh: async () => ({ status: 200, title: 'Keys', body: html, controller: 'dashboard', can_write: true, signature: `redraw-${++redraws}`, poll_interval_ms: -1 }),
      transport: { control: async params => { calls.push(params); return { status: 200, body: { ok: true, status_message: 'Cloud judging is off. Olympus is applying local judging.' } }; } },
    }); dispose = () => controller.dispose();
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await browser.happyDOM.waitUntilComplete();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toEqual([{ action: 'save_judge', choice: 'local', cap_dollars: 0 }]);
    expect(redraws).toBeGreaterThan(0);
    const pageLine = () => Array.from(root.querySelectorAll('[data-action-message]')).find(node => !node.closest('dialog'))!;
    expect(pageLine().textContent).toBe('Cloud judging is off. Olympus is applying local judging.');
    // Venice with no limit is explained inside its still-open confirmation and sends nothing.
    root.querySelector<HTMLInputElement>('input[value="venice"]')!.click();
    const confirm = root.querySelector<HTMLDialogElement>('dialog[data-judge-dialog="venice"]')!;
    expect(confirm.open).toBe(true);
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await browser.happyDOM.waitUntilComplete();
    expect(calls.length).toBe(1);
    expect(confirm.open).toBe(true);
    expect(confirm.querySelector('[data-action-message]')!.textContent).toBe('Enter a total cloud spending limit in dollars to use Venice.');
    // With a limit the choice is accepted, and only then does the confirmation close.
    // The one limit field sits under the choices (box 4 of the approved mock), not inside the confirmation.
    expect(confirm.querySelector('input[name="cap_dollars"]')).toBeNull();
    root.querySelector<HTMLInputElement>('input[name="cap_dollars"]')!.value = '15';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await browser.happyDOM.waitUntilComplete();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls.at(-1)).toEqual({ action: 'save_judge', choice: 'venice', cap_dollars: 15 });
    expect(root.querySelector('dialog[open]')).toBeNull();
  } finally {
    dispose(); browser.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
  }
});

test('the choice form defaults to local even for a large archive and submits only an explicit choice', async () => {
  const { Window } = await import('happy-dom');
  const { mountDashboardController } = await import('../src/control-ui/browser-controller.ts');
  const browser = new Window({ url: 'http://localhost/dashboard?keys' });
  const keys = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS'] as const;
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: browser[key] });
  let dispose = () => {};
  try {
    const view = buildDashboardPreviewView('ready'); view.sources.forEach((source, i) => { source.coverage.stored_items = i === 0 ? 1_250_000 : 0; });
    const html = renderJudgeChoice(view, { controlSessionCsrfToken: 'synthetic', judgeSetup: { choice: 'local', capDollars: 20, spentDollars: 0, remainingDollars: 20, stop: null, cloudModel: 'kimi-k3', cloudAvailable: true } });
    const root = document.createElement('div'); root.innerHTML = html; document.body.append(root);
    const calls: unknown[] = [];
    const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, pollIntervalMs: -1, returnUrl: 'http://localhost/dashboard?keys', navigate() {},
      refresh: async () => ({ status: 200, title: 'Keys', body: html, controller: 'dashboard', can_write: true, signature: html, poll_interval_ms: -1 }),
      transport: { control: async params => { calls.push(params); return { status: 200, body: { ok: true, status_message: 'Saved' } }; } },
    }); dispose = () => controller.dispose();
    expect(root.textContent).toContain('Recommended: Venice'); expect(root.querySelector<HTMLInputElement>('input[value="local"]')!.checked).toBe(true);
    expect(root.querySelector<HTMLInputElement>('input[value="venice"]')!.checked).toBe(false); expect(calls).toEqual([]);
    root.querySelector<HTMLInputElement>('input[value="venice"]')!.click();
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await browser.happyDOM.waitUntilComplete();
    // A limit left over on a Local record is not the owner's Venice limit: the field starts at the estimate plus 25%.
    expect(calls).toEqual([{ action: 'save_judge', choice: 'venice', cap_dollars: 7032 }]);
  } finally {
    dispose(); browser.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
  }
});


test('an active cap can be lowered even when the provider key is no longer ready', async () => {
  const { budget, path } = fixture(); budget.choose('venice', 20);
  const cloud = resolveJudgeChoiceRuntime({ engine: createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only')) }, { choice: 'venice', stop: null, remainingDollars: 20 });
  const backend = createJudgeSetup({ spending: budget, cloud, local: () => ({ source: 'off', reason: 'no_private_lane' }),
    ledgerPath: path + '.ledger', promptVersion: () => snifferPromptVersions().approval, credentialReady: () => false, requestReload: () => false });
  await expect(backend.save('venice', 10)).rejects.toThrow('API key'); expect(budget.status().capDollars).toBe(10);
});


test('local approval still works with a corrupt record and restoring it cannot restore withdrawn cloud consent', async () => {
  const { budget, path } = fixture(); const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
  const cloud = resolveJudgeChoiceRuntime({ engine }, { choice: 'venice', stop: null, remainingDollars: 20 });
  const local = resolveJudgeChoiceRuntime({ engine }, { choice: 'local', stop: null, remainingDollars: 0 });
  const promptVersion = snifferPromptVersions().approval;
  const backend = createJudgeSetup({ spending: budget, cloud, local: () => local,
    ledgerPath: path + '.ledger', promptVersion: () => promptVersion, credentialReady: () => true, requestReload: () => false });
  await backend.save('venice', 20); const savedBudget = readFileSync(path, 'utf8'); writeFileSync(path, '{broken');
  expect((await backend.save('local', 20)).ok).toBe(true); expect(readFileSync(path, 'utf8')).toBe('{broken');
  const entries = (await readClassificationLedger(path + '.ledger')).entries;
  if (local.source !== 'off') expect(isClassifierApproved(entries, { lane: local.lane.kind, profileId: local.lane.profileId, modelId: local.lane.modelId, promptVersion })).toBe(true);
  writeFileSync(path, savedBudget);
  if (cloud.source !== 'off') expect(isClassifierApproved(entries, { lane: cloud.lane.kind, profileId: cloud.lane.profileId, modelId: cloud.lane.modelId, promptVersion })).toBe(false);
});

test('Venice-only setup can record a no before visiting Keys and reports the pending screen choice honestly', async () => {
  const { path } = fixture(); const policy = path + '.policy';
  writeFileSync(policy, JSON.stringify(loadSovereigntyPreset('private-cloud-only')));
  const env = { NODE_ENV: 'test', OLYMPUS_SOVEREIGNTY_CONFIG_PATH: policy, OLYMPUS_CLASSIFICATION_LEDGER_PATH: path + '.ledger' };
  expect(await runTierClassifier(['status'], { env })).toMatchObject({ lane: null, decision: 'not_asked', next_step: expect.stringContaining('Keys') });
  await runTierClassifier(['decline', '--why', 'Owner chose local/off'], { env });
  expect(await runTierClassifier(['status'], { env })).toMatchObject({ lane: null, decision: 'declined', approved: false });
  await expect(runTierClassifier(['approve', '--why', 'Synthetic'], { env })).rejects.toThrow('Keys');
});

/** An install whose only classification lane is Venice, as before limits existed. */
function veniceActive() {
  const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
  const isVenice = (profile: { provider: string }) => profile.provider === 'venice';
  const input = { engine: {
    config: { ...engine.config, modelProfiles: Object.fromEntries(Object.entries(engine.config.modelProfiles).filter(([, profile]) => profile.purpose !== 'classification' || isVenice(profile))) },
    resolveAnalystPool: (...args: Parameters<typeof engine.resolveAnalystPool>) => {
      const pool = engine.resolveAnalystPool(...args);
      const accepts = (member: { profile: { provider: string } }) => isVenice(member.profile);
      return { ...pool, members: pool.members.filter(accepts), ...(pool.explicitOrder ? { explicitOrder: pool.explicitOrder.filter(accepts) } : {}) };
    },
  } };
  const cloud = resolveTierSnifferRuntime(input);
  if (cloud.source === 'off' || cloud.lane.kind !== 'venice') throw new Error('expected Venice to be the active lane');
  return { input, cloud };
}

test('an upgrade keeps an exact Venice approval judging with no cap until the owner sets one', async () => {
  const { budget, path } = fixture();
  const { input, cloud } = veniceActive();
  const promptVersion = snifferPromptVersions().approval;
  const ledger = path + '.ledger';

  // No approval: a new install stays local and nothing is written.
  await adoptExistingCloudApproval(budget, input, ledger, promptVersion);
  expect(budget.hasRecord()).toBe(false);
  expect(budget.status().choice).toBe('local');

  await approveClassifier(ledger, cloud.lane, promptVersion, 'approved before limits existed');
  await adoptExistingCloudApproval(budget, input, ledger, promptVersion);
  expect(budget.status()).toMatchObject({ choice: 'venice', uncapped: true, stop: null });
  const running = resolveJudgeChoiceRuntime(input, budget.status());
  expect(running.source !== 'off' && running.lane.kind).toBe('venice');

  // Calls pass with no cap and no listed price; a 402 stays as it was before.
  let sent = 0;
  const judged = budget.fetch(async () => { sent++; return new Response('', { status: 402 }); });
  const unlisted = { ...request, body: JSON.stringify({ model: 'some-unlisted-model', messages: [], max_completion_tokens: 8 }) };
  expect((await judged('https://venice.test', unlisted)).status).toBe(402);
  expect(sent).toBe(1);
  expect(budget.status().stop).toBeNull();

  // The note shows once and survives a restart as already shown.
  expect(budget.takeUpgradeNote()).toBe(true);
  expect(new JudgeSpending(path).takeUpgradeNote()).toBe(false);

  // Setting a limit ends the upgrade state and the cap applies from then on.
  budget.choose('venice', 0);
  expect(budget.status().uncapped).toBeUndefined();
  await expect(budget.fetch(async () => response())('https://venice.test', request)).rejects.toBeInstanceOf(JudgeCloudStopped);
});

test('a saved choice is never overridden by an old approval, and a declined model is not adopted', async () => {
  const { budget, path } = fixture();
  const { input, cloud } = veniceActive();
  const promptVersion = snifferPromptVersions().approval;
  const ledger = path + '.ledger';
  await approveClassifier(ledger, cloud.lane, promptVersion, 'approved');
  budget.choose('local', 0);
  await adoptExistingCloudApproval(budget, input, ledger, promptVersion);
  expect(budget.status().choice).toBe('local');

  const other = fixture();
  await approveClassifier(other.path + '.ledger', cloud.lane, promptVersion, 'approved');
  await revokeClassifier(other.path + '.ledger', cloud.lane, promptVersion, 'changed my mind');
  await adoptExistingCloudApproval(other.budget, input, other.path + '.ledger', promptVersion);
  expect(other.budget.hasRecord()).toBe(false);
});

test('the screen shows the upgrade note once and asks for a limit instead of showing $0', () => {
  const view = buildDashboardPreviewView('ready');
  const judgeSetup = { choice: 'venice' as const, capDollars: 0, spentDollars: 0, remainingDollars: 0, stop: null, uncapped: true, cloudModel: 'qwen3-6-35b-a3b', cloudAvailable: true };
  const first = renderJudgeChoice(view, { judgeSetup: { ...judgeSetup, upgradeNote: true } });
  expect(first).toContain('You can now set a spending limit');
  expect(first).toContain('No spending limit is set');
  // Empty, not $0. Saving Venice with it empty is refused on the page; Local saves without one (#950).
  expect(first).toContain('step="0.01" value=""');
  expect(renderJudgeChoice(view, { judgeSetup })).not.toContain('You can now set a spending limit');
});

test('an old Venice approval on an install judging locally now stays local', async () => {
  const { budget, path } = fixture();
  const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
  const active = resolveTierSnifferRuntime({ engine });
  expect(active.source !== 'off' && active.lane.kind).toBe('local');
  const cloud = resolveJudgeChoiceRuntime({ engine }, { choice: 'venice', stop: null, remainingDollars: 20 });
  if (cloud.source === 'off') throw new Error('expected a cloud lane');
  const promptVersion = snifferPromptVersions().approval;
  await approveClassifier(path + '.ledger', cloud.lane, promptVersion, 'approved earlier, then moved to a local judge');
  await adoptExistingCloudApproval(budget, { engine }, path + '.ledger', promptVersion);
  expect(budget.hasRecord()).toBe(false);
  expect(budget.status().choice).toBe('local');
  const selected = resolveJudgeChoiceRuntime({ engine }, budget.status());
  expect(selected.source !== 'off' && selected.lane.kind).toBe('local');
});

test('the Keys page renders through the real setup object and shows the upgrade note once', async () => {
  const { budget, path } = fixture();
  budget.adoptExistingApproval();
  const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
  const judgeSetup = createJudgeSetup({ spending: budget, cloud: resolveJudgeChoiceRuntime({ engine }, { choice: 'venice', stop: null, remainingDollars: 20 }),
    local: () => resolveJudgeChoiceRuntime({ engine }, { choice: 'local', stop: null, remainingDollars: 0 }),
    ledgerPath: path + '.ledger', promptVersion: () => snifferPromptVersions().approval, credentialReady: () => true, requestReload: () => false });
  const worker = createEmailSourceWorker({
    sourceIndexStatus: { status: async () => ({ kind: 'source_index_status', generated_at: '2026-11-06T00:00:00.000Z', corpora: [],
      policy: { read_only: true, raw_source_exposed: false, source_text_returned: false, secure_local_item_metadata_exposed: false, castor_visible: true } }) as never },
    sourceDashboard: { sovereigntyEngine: engine, registryPath: path + '-handles.json', judgeSetup },
  });
  cleanup.push(() => worker.close());
  const fetcher = withWorkerBearerAuth(worker.fetch, { authToken: 'synthetic-bearer' });
  const origin = 'http://127.0.0.1:17777';
  const cookie = (await ownerLocalMint(fetcher, origin, 'synthetic-bearer')).headers.get('Set-Cookie')!.split(';')[0]!;
  const keys = async () => {
    const page = new Request(origin + '/dashboard?keys', { headers: { [DASHBOARD_UNLOCK_HEADER]: await ownerUnlockKey(fetcher, origin, 'synthetic-bearer'), Cookie: cookie } });
    recordRequestPeer(page, '127.0.0.1');
    const reply = await fetcher(page);
    expect(reply.status).toBe(200);
    return reply.text();
  };
  const first = await keys();
  expect(first).toContain('Sorting your archive by privacy');
  expect(first).toContain('You can now set a spending limit');
  const second = await keys();
  expect(second).toContain('Sorting your archive by privacy');
  expect(second).not.toContain('You can now set a spending limit');
});

test('Venice judges with its own default model, not the Private-answer model; a declared judge profile wins (#1252)', () => {
  const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
  const answerMember = (engine.resolveAnalystPool({ trustDomain: 'secure_local' }).members).find(m => m.profile.provider === 'venice')!;
  const cloud = resolveJudgeChoiceRuntime({ engine }, { choice: 'venice', stop: null, remainingDollars: 1 });
  expect(cloud.source !== 'off' && cloud.lane.kind).toBe('venice');
  if (cloud.source === 'off') return;
  expect(cloud.lane.modelId).toBe(DEFAULT_VENICE_JUDGE_MODEL);
  expect(cloud.lane.profileId).toBe(answerMember.id);
  expect(JUDGE_PRICES[DEFAULT_VENICE_JUDGE_MODEL]).toBeDefined();
  // Answers keep the owner's chosen model.
  expect(engine.resolveAnalystPool({ trustDomain: 'secure_local' }).members.find(m => m.id === answerMember.id)!.profile.model).toBe(answerMember.profile.model);
  // A local choice is untouched.
  const local = resolveJudgeChoiceRuntime({ engine }, { choice: 'local', stop: null, remainingDollars: 0 });
  expect(local.source !== 'off' && local.lane.kind).toBe('local');

  const config = structuredClone(loadSovereigntyPreset('local-first'));
  config.modelProfiles['my-judge'] = { ...config.modelProfiles[answerMember.id]!, model: 'qwen3-6-35b-a3b', purpose: 'classification' } as never;
  const declared = resolveJudgeChoiceRuntime({ engine: createSovereigntyEngine(config) }, { choice: 'venice', stop: null, remainingDollars: 1 });
  expect(declared.source !== 'off' && declared.lane.modelId).toBe('qwen3-6-35b-a3b');
  expect(declared.source !== 'off' && declared.lane.profileId).toBe('my-judge');
});

test('an owner\'s Venice opt-in carries to the new default judge, but never past a revocation or a local choice (#1252)', async () => {
  const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
  const cloud = resolveJudgeChoiceRuntime({ engine }, { choice: 'venice', stop: null, remainingDollars: 1 });
  if (cloud.source === 'off') throw new Error('expected a Venice lane');
  const promptVersion = snifferPromptVersions().approval;
  const key = { lane: cloud.lane.kind, profileId: cloud.lane.profileId, modelId: cloud.lane.modelId, promptVersion };
  const old = { kind: 'venice', profileId: cloud.lane.profileId, modelId: 'kimi-k3' };

  // Opted in on the judge card under the old judge model and an older prompt: carried.
  const a = fixture(); a.budget.choose('venice', 5);
  await approveClassifier(a.path + '.ledger', old, 'p-older', 'Owner opted in.');
  expect(await carryCloudJudgeApproval(a.budget, cloud, a.path + '.ledger', promptVersion)).toBe(true);
  expect(isClassifierApproved((await readClassificationLedger(a.path + '.ledger')).entries, key)).toBe(true);
  expect(await carryCloudJudgeApproval(a.budget, cloud, a.path + '.ledger', promptVersion)).toBe(false);

  // The owner's newest word is a revocation: not carried.
  const b = fixture(); b.budget.choose('venice', 5);
  await approveClassifier(b.path + '.ledger', old, promptVersion, 'Owner opted in.');
  await revokeClassifier(b.path + '.ledger', old, promptVersion, 'Owner chose local.');
  expect(await carryCloudJudgeApproval(b.budget, cloud, b.path + '.ledger', promptVersion)).toBe(false);

  // A local choice, or no choice record at all: not carried.
  const c = fixture(); c.budget.choose('local', 5);
  await approveClassifier(c.path + '.ledger', old, promptVersion, 'Owner opted in.');
  expect(await carryCloudJudgeApproval(c.budget, cloud, c.path + '.ledger', promptVersion)).toBe(false);
  const d = fixture();
  await approveClassifier(d.path + '.ledger', old, promptVersion, 'Owner opted in.');
  expect(await carryCloudJudgeApproval(d.budget, cloud, d.path + '.ledger', promptVersion)).toBe(false);

  // Another profile's approval does not carry.
  const e = fixture(); e.budget.choose('venice', 5);
  await approveClassifier(e.path + '.ledger', { ...old, profileId: 'someone-else' }, promptVersion, 'Owner opted in.');
  expect(await carryCloudJudgeApproval(e.budget, cloud, e.path + '.ledger', promptVersion)).toBe(false);
});

test('the default Venice judge is in the offline privacy snapshot, so a catalog outage still lets it judge (#1252)', async () => {
  const { venicePrivacyCategoryForModel, isVenicePrivacyCategoryApprovedForSecureLocal } = await import('../src/core/venice-models.ts');
  const category = venicePrivacyCategoryForModel(DEFAULT_VENICE_JUDGE_MODEL);
  expect(category).toBeDefined();
  expect(isVenicePrivacyCategoryApprovedForSecureLocal(category!)).toBe(true);
});

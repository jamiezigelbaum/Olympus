import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.ts';
import { ownerLimits } from '../src/core/owner-limits.ts';
import { withOwnerLimitStore } from '../src/core/owner-limit-state.ts';
import { createProviderRateLimitReporter, providerRetryTime, type RateLimitedProvider } from '../src/core/provider-rate-limits.ts';
import { ReadwiseApiClient } from '../src/workers/readwise/api.ts';
import { XApiClient } from '../src/workers/x-bookmarks/api.ts';
import { createXBookmarksApiSourceConnector } from '../src/workers/x-bookmarks/api-connector.ts';
import { LocalXBookmarksApiUsageStore, defaultXBookmarksLiveSyncConfig } from '../src/workers/x-bookmarks/live-control.ts';
import { createEvernoteRuntime } from '../src/workers/evernote/runtime.ts';
import { startEvernoteSignIn } from '../src/workers/evernote/live-sync.ts';
import { McpCallPacer } from '../src/core/mcp-source/pacer.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import type { SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { copyDashboardViewModel } from '../src/workers/chatgpt/response-builder.ts';
import { FakeEvernoteServer } from './support/evernote-mcp-fake.ts';
import { createTestClock } from './helpers/test-clock.ts';

const scratch: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), 'olympus-provider-waits-')); scratch.push(dir); return dir; }
beforeEach(() => {
  for (const provider of ['x', 'evernote', 'readwise'] as const) createProviderRateLimitReporter(provider).success();
});
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function view(): SourceDashboardViewModel {
  return { kind: 'source_dashboard', sources: [], generated_at: '2026-11-13T00:00:00Z', summary: {},
    onboarding: { steps: [], ask_first_question: { enabled: false, label: '', suggestion: '' } }, answer_lanes: [],
    where_your_data_lives: [], unassigned_corpora: { corpus_count: 0, entries: [] },
    excluded_by_configuration: { entries: [] }, folder_picker: { available: false }, history: {}, policy: {} } as unknown as SourceDashboardViewModel;
}
const sourceIds = { x: 'x.bookmarks', evernote: 'evernote.notes', readwise: 'readwise.library' };
async function shown(provider: RateLimitedProvider, now: Date, resumesAt: string, amounts: { limit: number | null; used: number | null }) {
  const id = `${provider}.rate_limit`;
  const listed = (await ownerLimits({}, { now: () => now })).stops!.filter(stop => stop.id === id);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ id, subject: sourceIds[provider], kind: 'requests', scope: 'source', continue: 'none', resumesAt, ...amounts });
  expect(listed[0]).not.toHaveProperty('pacing');
  const home = copyDashboardViewModel(buildChatGptDashboardViewModel(view(), { now, limitStops: listed }));
  const waits = home.waits!.filter(wait => wait.limitLabel === listed[0]!.label);
  expect(waits).toHaveLength(1);
  expect(waits[0]).toMatchObject({ resumesAt, ...amounts });
  expect(waits[0]).not.toHaveProperty('fix');
  const name = provider === 'x' ? 'X' : provider === 'evernote' ? 'Evernote' : 'Readwise';
  await expect(ownerLimits({ action: 'continue', id }, { now: () => now })).rejects.toThrow(`${name} sets this wait; it resumes at ${resumesAt} on its own.`);
  return listed[0]!;
}
async function absent(provider: RateLimitedProvider, now: Date) {
  expect((await ownerLimits({}, { now: () => now })).stops!.filter(stop => stop.id === `${provider}.rate_limit`)).toEqual([]);
}

for (const seconds of [120, 60, 30]) {
  test(`X ${seconds}s provider reset reports only a long stop, then success clears it`, async () => {
    const time = createTestClock(Date.parse('2026-11-13T12:00:00Z'));
    const reset = new Date(time.now() + seconds * 1_000).toISOString();
    let limited = true;
    const client = new XApiClient({ token: 'SECRET_TOKEN', userId: 'PRIVATE_ACCOUNT', fetch: async () => limited
      ? new Response('', { status: 429, headers: { 'x-rate-limit-limit': '100', 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(Date.parse(reset) / 1_000) } })
      : Response.json({ data: [] }) });
    const usage = new LocalXBookmarksApiUsageStore(join(temp(), 'usage.sqlite'));
    const run = () => createXBookmarksApiSourceConnector({ mode: 'incremental', account: 'PRIVATE_ACCOUNT', sourceClient: client,
      attemptedAt: time.date(), now: time.date, usageStore: usage, config: defaultXBookmarksLiveSyncConfig({}) }).probe();
    try {
      await expect(run()).rejects.toThrow();
      if (seconds > 60) {
        const stop = await shown('x', time.date(), reset, { limit: 100, used: 100 });
        await time.advance(1_000);
        await expect(run()).rejects.toThrow();
        expect((await shown('x', time.date(), reset, { limit: 100, used: 100 })).since).toBe(stop.since);
        expect(JSON.stringify(stop)).not.toMatch(/SECRET_TOKEN|PRIVATE_ACCOUNT/);
      } else await absent('x', time.date());
      await time.advance(seconds * 1_000);
      await absent('x', time.date());
      limited = false;
      await run();
      await absent('x', time.date());
      // A new wait after expiry gets its own start, including on the same handler/store.
      const resumed = withOwnerLimitStore(store => store.openLimitStops(new Date(0)));
      expect(resumed.some(stop => stop.id === 'x.rate_limit')).toBe(false);
    } finally { usage.close(); }
  });

  test(`Readwise ${seconds}s Retry-After reports only a long stop, then the next request clears it`, async () => {
    const time = createTestClock(Date.parse('2026-11-13T13:00:00Z'));
    const reset = new Date(time.now() + seconds * 1_000).toISOString();
    let limited = true;
    const client = new ReadwiseApiClient({ token: 'SECRET_TOKEN', now: time.date, fetch: async () => limited
      ? new Response('', { status: 429, headers: { 'retry-after': String(seconds) } })
      : Response.json({ results: [] }) });
    await expect(client.exportBooks()).rejects.toMatchObject({ status: 429, resumesAt: reset });
    if (seconds > 60) {
      const first = await shown('readwise', time.date(), reset, { limit: null, used: null });
      await expect(client.exportBooks()).rejects.toThrow();
      expect((await shown('readwise', time.date(), reset, { limit: null, used: null })).since).toBe(first.since);
    } else await absent('readwise', time.date());
    limited = false;
    await client.exportBooks();
    await absent('readwise', time.date());
  });

  test(`Evernote ${seconds}s HTTP retry survives the live pass and clears on the next successful request`, async () => {
    const time = createTestClock(Date.parse('2026-11-13T14:00:00Z'));
    const reset = new Date(time.now() + seconds * 1_000).toISOString();
    const fake = new FakeEvernoteServer({ auth: true }).start();
    if (seconds === 120) {
      const notebook = fake.addNotebook('Fixture notebook');
      fake.addNote({ title: 'Fixture note', created: Date.UTC(2024, 0, 1), notebookId: notebook.id, body: '<en-note>River survey</en-note>' });
    }
    const dir = temp();
    const secrets = new Map<string, string>();
    const secretStore: SecretStore = { label: 'memory', get: async key => secrets.get(key), getSync: key => secrets.get(key),
      set: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); }, list: async () => [...secrets.keys()] };
    try {
      const registryPath = join(dir, 'handles.json');
      const signIn = await startEvernoteSignIn({ serverUrl: fake.url, authorizationHosts: ['127.0.0.1'],
        redirectUri: 'http://127.0.0.1:9/oauth/callback/evernote', state: 'fixture', secretStore, registryPath });
      const handle = await signIn.complete('good-code');
      let limited = true;
      const runtime = createEvernoteRuntime({ env: { HOME: dir, XDG_DATA_HOME: join(dir, 'xdg'), OPENCLAW_STATE_DIR: join(dir, 'openclaw') },
        secretStore: () => secretStore, registryPath, serverUrl: fake.url, now: time.date,
        pacer: new McpCallPacer({ minIntervalMs: 0, now: time.now, sleep: time.sleep }),
        fetch: async (url, init) => {
          const tool = typeof init?.body === 'string' ? JSON.parse(init.body)?.params?.name : undefined;
          const refuse = limited && new URL(String(url)).pathname === '/mcp' && (seconds !== 120 || tool === 'get_note');
          return refuse ? new Response('', { status: 429, headers: { 'retry-after': String(seconds) } }) : fetch(url, init);
        } });
      const sync = runtime.liveSync(handle);
      if (seconds === 120) {
        const source = runtime.schedulerSource({ config: defaultConfig(), handle, notebookGate: () => () => 'ingest',
          assertNotebookChoiceCurrent: () => {}, scope: { accountGeneration: 'fixture', scopeRevision: 'fixture' } });
        const result = await source.tasks[0]!.run();
        expect(result.counts).toMatchObject({ pass_complete: 0, notes_not_read: 1 });
        expect(result.retryAt).toMatchObject({ at: reset, degradedReason: 'evernote.rate_limit' });
      } else await expect(sync.pass()).rejects.toThrow();
      expect(sync.status()?.last_error).toMatchObject({ kind: 'rate_limited', resumesAt: reset });
      if (seconds > 60) await shown('evernote', time.date(), reset, { limit: null, used: null });
      else await absent('evernote', time.date());
      limited = false;
      await sync.pass();
      await absent('evernote', time.date());
    } finally { fake.stop(); }
  });
}

test('HTTP date Retry-After and expiry keep absolute times and start a fresh wait', async () => {
  const time = createTestClock(Date.parse('2026-11-13T15:00:00Z'));
  const reset = providerRetryTime('Fri, 13 Nov 2026 15:02:00 GMT', time.date(), 900_000);
  expect(reset).toBe('2026-11-13T15:02:00.000Z');
  for (const invalid of [undefined, '', '-1', '1e300', 'invalid']) {
    expect(providerRetryTime(invalid, time.date(), 900_000)).toBe('2026-11-13T15:15:00.000Z');
  }
  const reporter = createProviderRateLimitReporter('readwise');
  reporter.report(reset, time.date());
  await time.advance(120_000);
  reporter.resume(time.date());
  expect(withOwnerLimitStore(store => store.openLimitStops(new Date(0))).some(stop => stop.id === 'readwise.rate_limit')).toBe(false);
  const next = new Date(time.now() + 120_000).toISOString();
  reporter.report(next, time.date());
  expect((await shown('readwise', time.date(), next, { limit: null, used: null })).since).toBe(time.date().toISOString());
});

for (const provider of ['x', 'evernote', 'readwise'] as const) {
  test(`${provider} records a repeated wait once and preserves its start`, async () => {
    const { installLimitStopHooks } = await import('../src/core/limit-stops.ts');
    const { ownerLimitStopHooks } = await import('../src/core/owner-limit-state.ts');
    const time = createTestClock(Date.parse('2026-11-13T16:00:00Z'));
    const reporter = createProviderRateLimitReporter(provider);
    const reset = new Date(time.now() + 120_000).toISOString();
    let records = 0;
    installLimitStopHooks({ ...ownerLimitStopHooks, record(stop) { records++; ownerLimitStopHooks.record(stop); } });
    try {
      reporter.report(reset, time.date());
      await time.advance(1_000);
      reporter.report(reset, time.date());
      expect(records).toBe(1);
      expect((await shown(provider, time.date(), reset, { limit: null, used: null })).since).toBe('2026-11-13T16:00:00.000Z');
      reporter.success();
      await absent(provider, time.date());
    } finally { installLimitStopHooks(ownerLimitStopHooks); }
  });
}

test('X measures the remaining wait when the response arrives', async () => {
  const time = createTestClock(Date.parse('2026-11-13T17:00:00Z'));
  const reset = time.now() + 90_000;
  const client = new XApiClient({ token: 'fixture', userId: 'fixture', fetch: async () => {
    await time.advance(60_000);
    return new Response('', { status: 429, headers: { 'x-rate-limit-reset': String(reset / 1_000) } });
  } });
  const usage = new LocalXBookmarksApiUsageStore(join(temp(), 'usage.sqlite'));
  try {
    const connector = createXBookmarksApiSourceConnector({ mode: 'incremental', account: 'fixture', sourceClient: client,
      attemptedAt: time.date(), now: time.date, usageStore: usage, config: defaultXBookmarksLiveSyncConfig({}) });
    await expect(connector.probe()).rejects.toThrow();
    await absent('x', time.date());
  } finally { usage.close(); }
});

test('Readwise without a usable Retry-After keeps a silent pacing retry', async () => {
  const time = createTestClock(Date.parse('2026-11-13T18:00:00Z'));
  for (const retryAfter of [undefined, 'invalid', '-1', '1e300']) {
    const client = new ReadwiseApiClient({ token: 'fixture', now: time.date, fetch: async () =>
      new Response('', { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } }) });
    await expect(client.exportBooks()).rejects.toMatchObject({ status: 429, resumesAt: '2026-11-13T18:01:00.000Z' });
    await absent('readwise', time.date());
  }
});

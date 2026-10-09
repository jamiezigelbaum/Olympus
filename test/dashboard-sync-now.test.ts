/**
 * Sync now in ChatGPT and on the computer (owner, 2026-10-09): one route that
 * starts the sync and answers at once (checking / busy / too soon), at most
 * one run per source a minute, never holding the dashboard's grant lock
 * across the sync; the result reaches both surfaces as `last_manual_sync` on
 * the next read. The ⋯ menu carries Sync now on every connected source that
 * can sync, and a late or unresponsive source gets it as its button.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { upsertConnectedHandle, type ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  DASHBOARD_MANUAL_SYNC_MIN_INTERVAL_MS,
  DASHBOARD_MANUAL_SYNC_SHOWN_MS,
  buildSourceDashboardViewModel,
  dashboardLiveManualSync,
  type DashboardManualSync,
  type DashboardSourceCard,
  type SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import { dashboardManualSyncLine } from '../src/workers/dashboard/vocabulary.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { copyDashboardViewModel } from '../src/workers/chatgpt/response-builder.ts';
import { createChatGptSetupBackend } from '../src/workers/chatgpt/setup-backend.ts';
import { createChatGptHandoffs } from '../src/workers/chatgpt/handoff.ts';
import { callSetupTool } from '../src/workers/chatgpt/setup-tools.ts';
import { SYNC_SOURCE_TOOL_NAME, type DashboardFix } from '../src/workers/chatgpt/dashboard-contract.ts';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const SYNC_DROPBOX: DashboardFix = { label: 'Sync now', tool: 'olympus_sync_source', args: { source_id: 'dropbox.files' } };

/* ------------------------------------------------------------------ */
/* View model: the ⋯ menu and the promotion                           */
/* ------------------------------------------------------------------ */

describe('the ⋯ menu and the row button', () => {
  test('a connected source that can sync has Sync now first in its ⋯ menu', () => {
    const dropbox = chatgptDropbox(viewWith({ sync_now_available: true }));
    expect(dropbox.status).toBe('Fresh');
    expect(dropbox.menu?.[0]).toEqual(SYNC_DROPBOX);
    expect(dropbox.menu?.map((fix) => fix.label)).toEqual(['Sync now', 'Disconnect']);
    expect(dropbox.primary).toBeUndefined();
  });

  test('no Sync now where this worker has no lane, or before the source is connected', () => {
    expect(chatgptDropbox(viewWith({ sync_now_available: false })).menu?.map((fix) => fix.label)).toEqual(['Disconnect']);
    expect(chatgptDropbox(viewWith({})).menu?.map((fix) => fix.label)).toEqual(['Disconnect']);
    const off = chatgptDropbox(viewWith({
      sync_now_available: true,
      connection: { state: 'not_connected', label: 'not connected', action: { kind: 'oauth', source: 'dropbox' } as DashboardSourceCard['connection']['action'], handles: [] },
      coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0, needs_review_items: 0 },
    }));
    expect(off.status).toBe('Off');
    expect(off.menu).toBeUndefined();
  });

  test('a signed-out source offers Reconnect, never Sync now', () => {
    const signedOut = chatgptDropbox(viewWith({
      sync_now_available: true,
      connection: { state: 'reauth_required', label: 'reauth required', action: { kind: 'oauth', source: 'dropbox' } as DashboardSourceCard['connection']['action'], handles: ['dropbox.personal'] },
    }));
    expect(signedOut.primary?.label).toBe('Reconnect');
    expect(JSON.stringify(signedOut)).not.toContain('olympus_sync_source');
  });

  test('a source that is not responding gets Sync now as its button, replacing Check again', () => {
    const view = viewWith({
      sync_now_available: true,
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 1, failing_tasks: 1 },
      schedule: { running: false, consecutive_failures: 4 } as NonNullable<DashboardSourceCard['schedule']>,
    });
    const v1 = buildChatGptDashboardViewModel(view, { now: NOW });
    const dropbox = v1.sources.find((source) => source.id === 'dropbox.files')!;
    expect(['Needs you', 'Failing']).toContain(dropbox.status);
    expect(dropbox.primary).toEqual(SYNC_DROPBOX);
    const item = v1.needsYou.find((entry) => entry.id === 'source:dropbox.files')!;
    expect(item.fix).toEqual(SYNC_DROPBOX);
    expect(JSON.stringify(v1)).not.toContain('Check again');
    // The menu still lists it (the panel drops the copy of the row's fix).
    expect(dropbox.menu?.[0]).toEqual(SYNC_DROPBOX);
    // Without a lane the old fix stands: there is nothing to sync with.
    const noLane = buildChatGptDashboardViewModel(viewWith({ ...view.sources.find((card) => card.source_id === 'dropbox.files')!, sync_now_available: false }), { now: NOW });
    expect(noLane.needsYou.find((entry) => entry.id === 'source:dropbox.files')!.fix.label).toBe('Check again');
  });

  test('the fix passes the response builder with its one argument, and nothing else', () => {
    const copy = copyDashboardViewModel(buildChatGptDashboardViewModel(viewWith({ sync_now_available: true }), { now: NOW }));
    expect(copy.sources.find((source) => source.id === 'dropbox.files')!.menu?.[0]).toEqual(SYNC_DROPBOX);
    const forged = copyDashboardViewModel({
      ...copy,
      sources: [{ ...copy.sources[0]!, menu: [{ label: 'Sync now', tool: 'olympus_sync_source', args: { source_id: 'telegram.messages', reason: 'scheduled' } }] }],
    });
    expect(forged.sources[0]!.menu).toEqual([{ label: 'Sync now', tool: 'olympus_sync_source', args: {} }]);
  });
});

/* ------------------------------------------------------------------ */
/* View model: checking, then the result line                          */
/* ------------------------------------------------------------------ */

describe('checking, then what it found', () => {
  test('a press still running reads "Checking Dropbox…" and stays while it runs', () => {
    const checking: DashboardManualSync = { at: NOW.toISOString(), outcome: 'checking' };
    const view = viewWith({ sync_now_available: true }, { 'dropbox.files': checking });
    const card = view.sources.find((source) => source.source_id === 'dropbox.files')!;
    expect(card.last_manual_sync).toEqual(checking);
    expect(dashboardManualSyncLine(card, NOW)).toBe('Checking Dropbox…');
    const dropbox = chatgptDropbox(view);
    expect(dropbox.lastManualSync).toEqual({ at: NOW.toISOString(), outcome: 'checking' });
    expect(dropbox.detail).toBe('Checking Dropbox…');
    expect(copyDashboardViewModel(buildChatGptDashboardViewModel(view, { now: NOW })).sources
      .find((source) => source.id === 'dropbox.files')!.lastManualSync?.outcome).toBe('checking');
    // A long sync is still checking past the ten minutes a result is shown,
    // and a scheduled sync finishing meanwhile does not end it.
    const later = new Date(NOW.getTime() + DASHBOARD_MANUAL_SYNC_SHOWN_MS + 60_000);
    expect(dashboardLiveManualSync(checking, later.toISOString(), later)).toEqual(checking);
  });

  test('the result leads the row on ChatGPT in the engine\'s words, the same line the computer prints', () => {
    for (const [sync, line] of [
      [{ at: NOW.toISOString(), outcome: 'checked', new_items: 0 }, 'Checked just now — no new files'],
      [{ at: NOW.toISOString(), outcome: 'checked', new_items: 12 }, 'Checked just now — 12 new files, reading them now'],
      [{ at: NOW.toISOString(), outcome: 'failed' }, 'Couldn\'t check Dropbox just now — Olympus will try again on its own'],
    ] as Array<[DashboardManualSync, string]>) {
      const view = viewWith({ sync_now_available: true }, { 'dropbox.files': sync });
      const card = view.sources.find((source) => source.source_id === 'dropbox.files')!;
      expect(dashboardManualSyncLine(card, NOW)).toBe(line);
      const dropbox = chatgptDropbox(view);
      expect(dropbox.detail?.startsWith(line)).toBe(true);
      // Counts and a closed outcome only.
      expect(Object.keys(dropbox.lastManualSync!).sort()).toEqual(sync.new_items === undefined ? ['at', 'outcome'] : ['at', 'newItems', 'outcome']);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The route: start, then poll                                         */
/* ------------------------------------------------------------------ */

describe('/dashboard/sync-now starts the sync and answers at once', () => {
  test('answers checking before the sync ends, frees the grant lock, and the card carries the result after', async () => {
    const fixture = readwiseWorker();
    try {
      const response = await withinMs(fixture.worker.fetch(jsonRequest('/dashboard/sync-now', { source: 'readwise' })), 2_000);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ ok: true, source: 'readwise', status: 'checking', status_message: 'Checking Readwise…' });
      expect(body.last_manual_sync).toMatchObject({ outcome: 'checking' });
      await fixture.entered.promise;
      expect(fixture.runs).toBe(1);

      // The lock is free while the sync runs: another grant mutation answers now.
      const other = await withinMs(fixture.worker.fetch(jsonRequest('/dashboard/sync-now', { source: 'x' })), 2_000);
      expect(other.status).toBe(501);

      // While it runs: busy, and the card says checking.
      const busy = await (await fixture.worker.fetch(jsonRequest('/dashboard/sync-now', { source: 'readwise' }))).json();
      expect(busy).toMatchObject({ ok: true, status: 'busy', status_message: 'Already checking Readwise' });
      expect(fixture.runs).toBe(1);
      expect((await readwiseCard(fixture)).last_manual_sync).toMatchObject({ outcome: 'checking' });

      fixture.release({ status: 'idle', counts: { items_seen: 40, items_changed: 3 } });
      await settle(fixture);
      expect((await readwiseCard(fixture)).last_manual_sync).toMatchObject({ outcome: 'checked', new_items: 3 });

      // Within the minute: too soon, and nothing new starts.
      const soon = await (await fixture.worker.fetch(jsonRequest('/dashboard/sync-now', { source: 'readwise' }))).json();
      expect(soon).toMatchObject({ ok: true, status: 'too_soon', status_message: 'Readwise was checked a moment ago — try again in a minute' });
      expect(soon.last_manual_sync).toBeUndefined();
      expect(fixture.runs).toBe(1);
      expect(DASHBOARD_MANUAL_SYNC_MIN_INTERVAL_MS).toBe(60_000);
    } finally {
      fixture.cleanup();
    }
  });

  test('a provider failure reads one plain line on the card, never the provider\'s words', async () => {
    const fixture = readwiseWorker();
    try {
      const response = await fixture.worker.fetch(jsonRequest('/dashboard/sync-now', { source: 'readwise' }));
      expect((await response.json()).status).toBe('checking');
      await fixture.entered.promise;
      fixture.fail(new Error('upstream 503: <html>provider maintenance page for jamie@example.test</html>'));
      await settle(fixture);
      const card = await readwiseCard(fixture);
      expect(card.last_manual_sync).toMatchObject({ outcome: 'failed' });
      expect(dashboardManualSyncLine(card, new Date())).toBe('Couldn\'t check Readwise just now — Olympus will try again on its own');
      expect(JSON.stringify(card)).not.toContain('example.test');
    } finally {
      fixture.cleanup();
    }
  });

  test('Disconnect is refused while a Sync now runs, and custody is kept for the retry', async () => {
    const fixture = readwiseWorker();
    try {
      await fixture.worker.fetch(jsonRequest('/dashboard/sync-now', { source: 'readwise' }));
      await fixture.entered.promise;
      const refused = await fixture.worker.fetch(jsonRequest('/dashboard/disconnect', { source_id: 'readwise.library', acknowledge: true }));
      expect(refused.status).toBe(409);
      expect((await refused.json()).error.code).toBe('disconnect_source_busy');
      fixture.release({ status: 'idle' });
      await settle(fixture);
      const done = await fixture.worker.fetch(jsonRequest('/dashboard/disconnect', { source_id: 'readwise.library', acknowledge: true }));
      expect(done.status).toBe(200);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('olympus_sync_source through the engine\'s own route', () => {
  test('the tool answers while the sync is still running, and the next dashboard read carries the result', async () => {
    const fixture = readwiseWorker();
    try {
      const backend = createChatGptSetupBackend({
        workerFetch: fixture.worker.fetch,
        handoffs: createChatGptHandoffs(),
        publicUrls: () => undefined,
        sovereignty: { config: loadSovereigntyPreset('no-sensitive'), source: 'inline' },
        credentialPresent: () => false,
        requestReload: () => false,
      });
      const result = await withinMs(callSetupTool(SYNC_SOURCE_TOOL_NAME, { source_id: 'readwise.library' }, backend), 2_000);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ status: 'checking', source_id: 'readwise.library' });
      await fixture.entered.promise;
      const again = await callSetupTool(SYNC_SOURCE_TOOL_NAME, { source_id: 'readwise.library' }, backend);
      expect(again.structuredContent).toEqual({ status: 'busy', source_id: 'readwise.library' });

      fixture.release({ status: 'idle', counts: { items_changed: 0 } });
      await settle(fixture);
      const soon = await callSetupTool(SYNC_SOURCE_TOOL_NAME, { source_id: 'readwise.library' }, backend);
      expect(soon.structuredContent).toEqual({ status: 'too_soon', source_id: 'readwise.library' });
      expect(fixture.runs).toBe(1);

      // A source this worker cannot sync is one fixed sentence, never the route's words.
      await expect(callSetupTool(SYNC_SOURCE_TOOL_NAME, { source_id: 'x.bookmarks' }, backend))
        .rejects.toMatchObject({ code: 'sync_unavailable' });
    } finally {
      fixture.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function chatgptDropbox(view: SourceDashboardViewModel) {
  return buildChatGptDashboardViewModel(view, { now: NOW }).sources.find((source) => source.id === 'dropbox.files')!;
}

function viewWith(overrides: Partial<DashboardSourceCard>, manualSyncs?: Record<string, DashboardManualSync>): SourceDashboardViewModel {
  const base = buildSourceDashboardViewModel({
    sourceIndexStatus: dropboxStatus(),
    sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
    connectedHandleRegistry: dropboxHandleRegistry(),
    ...(manualSyncs ? { manualSyncs } : {}),
    now: NOW,
  });
  return {
    ...base,
    sources: base.sources.map((card) => (card.source_id === 'dropbox.files' ? { ...card, ...overrides } : card)),
  };
}

function dropboxStatus(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: NOW.toISOString(),
    corpora: [{
      corpus_id: 'secure_local.dropbox.files',
      family: 'file',
      trust_domain: 'secure_local',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'local_only',
      configured: true,
      provider: 'dropbox',
      read_authority: 'legacy_index',
      counts: {
        accounts: 1,
        files: 254,
        folders: 0,
        items_with_text: 254,
        qa_eligible_items: 254,
        extraction_jobs_queued: 0,
        extraction_jobs_queued_actionable: 0,
        extraction_jobs_leased_current: 0,
        extraction_jobs_leased_current_actionable: 0,
        extraction_jobs_failed: 0,
        extraction_jobs_failed_actionable: 0,
      },
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'secure_local_item_metadata_not_exposed_to_castor',
    } as unknown as SourceIndexStatusResult['corpora'][number]],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  } as SourceIndexStatusResult;
}

function dropboxHandleRegistry(): ConnectedHandleRegistry {
  return {
    version: 1,
    handles: [{
      handle: 'dropbox.personal',
      provider: 'dropbox',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: ['files.metadata.read'],
      connectedAt: '2026-10-09T10:00:00.000Z',
    }],
  };
}

interface ReadwiseFixture {
  worker: ReturnType<typeof createEmailSourceWorker>;
  entered: { promise: Promise<void> };
  runs: number;
  release(result: unknown): void;
  fail(error: Error): void;
  cleanup(): void;
}

/** A worker whose Readwise sync waits until the test releases it. */
function readwiseWorker(): ReadwiseFixture {
  const root = mkdtempSync(join(tmpdir(), 'olympus-sync-now-'));
  const registryPath = join(root, 'handles.json');
  upsertConnectedHandle({
    handle: 'readwise.personal',
    provider: 'readwise',
    accountRole: 'personal',
    trustDomain: 'internal',
    allowedCapabilities: ['readwise.sync'],
    scopes: ['readwise.export:read', 'readwise.reader:read'],
    tokenSecretRefs: ['store:readwise.personal.token'],
    connectedAt: '2026-10-09T10:00:00.000Z',
  }, registryPath);
  let enter!: () => void;
  const entered = { promise: new Promise<void>((resolve) => { enter = resolve; }) };
  let settleRun: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  const fixture: ReadwiseFixture = {
    worker: undefined as unknown as ReadwiseFixture['worker'],
    entered,
    runs: 0,
    release: (result) => settleRun?.resolve(result),
    fail: (error) => settleRun?.reject(error),
    cleanup: () => {
      settleRun?.resolve({ status: 'idle' });
      fixture.worker.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  fixture.worker = createEmailSourceWorker({
    sourceIndexStatus: { status: async () => ({ ...dropboxStatus(), corpora: [] }) },
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      registryPath,
      secretStore: {
        label: 'memory',
        get: async () => 'token',
        getSync: () => 'token',
        set: async () => undefined,
        delete: async () => undefined,
        list: async () => [],
      },
      // The host hook serves Readwise only, as the product's serves Dropbox only.
      triggerSourceSyncSources: ['readwise'],
      triggerSourceSync: () => {
        fixture.runs++;
        enter();
        return new Promise((resolve, reject) => { settleRun = { resolve, reject }; });
      },
    },
  });
  return fixture;
}

async function readwiseCard(fixture: ReadwiseFixture): Promise<DashboardSourceCard> {
  const response = await fixture.worker.fetch(new Request('http://worker.test/dashboard.json'));
  expect(response.status).toBe(200);
  const view = await response.json() as SourceDashboardViewModel;
  return view.sources.find((source) => source.source_id === 'readwise.library')!;
}

/** Until the card no longer says checking: the run's own completion, not a timer. */
async function settle(fixture: ReadwiseFixture): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await readwiseCard(fixture)).last_manual_sync?.outcome !== 'checking') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the Sync now run never finished');
}

function withinMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms: the route held the request`)), ms)),
  ]);
}

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

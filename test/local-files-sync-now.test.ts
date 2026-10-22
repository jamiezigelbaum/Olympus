/**
 * Sync now for Files on this computer. The dashboard row has the same control
 * as Dropbox: the ⋯ menu entry, "Checking …" while it runs, a kept result
 * line, and a route that starts one scheduler pass and answers at once. The
 * source rides the shared machinery (the scheduler's operator run, the card's
 * manual-sync record, the file-scope registry's "this computer" flag), so
 * these tests check the wiring and the guards, not a second implementation.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { connectThisComputerSource, disconnectThisComputerSource } from '../src/core/this-computer.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { dashboardManualSyncLine } from '../src/workers/dashboard/vocabulary.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { copyDashboardViewModel } from '../src/workers/chatgpt/response-builder.ts';
import { createChatGptHandoffs } from '../src/workers/chatgpt/handoff.ts';
import { createChatGptSetupBackend } from '../src/workers/chatgpt/setup-backend.ts';
import { SYNC_SOURCE_TOOL, callSetupTool } from '../src/workers/chatgpt/setup-tools.ts';
import { SYNC_SOURCE_TOOL_NAME, type DashboardFix } from '../src/workers/chatgpt/dashboard-contract.ts';
import {
  SourceScheduler,
  type SourceSchedulerSource,
  type SourceSchedulerTaskRunResult,
} from '../src/workers/source-scheduler.ts';
import type { DashboardManualSync, DashboardSourceCard, SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { buildDashboardPreviewView, DASHBOARD_PREVIEW_NOW } from '../scripts/dashboard-preview.ts';

const NOW = DASHBOARD_PREVIEW_NOW;
const SYNC_LOCAL: DashboardFix = { label: 'Sync now', tool: 'olympus_sync_source', args: { source_id: 'local.files' } };

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/* ------------------------------------------------------------------ */
/* The row                                                              */
/* ------------------------------------------------------------------ */

function localView(state: string, overrides: Partial<DashboardSourceCard> = {}, manual?: DashboardManualSync): SourceDashboardViewModel {
  const base = buildDashboardPreviewView(state);
  return {
    ...base,
    sources: base.sources.map((card) => card.source_id === 'local.files'
      ? { ...card, ...overrides, ...(manual ? { last_manual_sync: manual } : {}) }
      : card),
  };
}

function localRow(view: SourceDashboardViewModel) {
  return buildChatGptDashboardViewModel(view, { now: NOW }).sources.find((source) => source.id === 'local.files')!;
}

describe('the Files on this computer row', () => {
  test('a connected source with folders chosen has Sync now first in its ⋯ menu, like Dropbox', () => {
    const row = localRow(localView('local-files-reading', { sync_now_available: true }));
    expect(row.menu?.[0]).toEqual(SYNC_LOCAL);
    expect(row.menu?.map((fix) => fix.label)).toEqual(['Sync now', 'Choose folders']);
  });

  test('no Sync now where the worker has no lane, before folders are chosen, or when not connected', () => {
    expect(localRow(localView('local-files-reading', { sync_now_available: false })).menu?.map((fix) => fix.label))
      .toEqual(['Choose folders']);
    expect(JSON.stringify(localRow(localView('local-files-connected', { sync_now_available: true }))))
      .not.toContain('olympus_sync_source');
    expect(localRow(localView('local-files-off', { sync_now_available: true })).menu).toBeUndefined();
  });

  test('the fix passes the response builder with its one argument; a forged source is dropped', () => {
    const copy = copyDashboardViewModel(buildChatGptDashboardViewModel(
      localView('local-files-reading', { sync_now_available: true }), { now: NOW }));
    expect(copy.sources.find((source) => source.id === 'local.files')!.menu?.[0]).toEqual(SYNC_LOCAL);
    const forged = copyDashboardViewModel({
      ...copy,
      sources: [{ ...copy.sources[0]!, menu: [{ label: 'Sync now', tool: 'olympus_sync_source', args: { source_id: 'local.files.evil' } }] }],
    });
    expect(forged.sources[0]!.menu).toEqual([{ label: 'Sync now', tool: 'olympus_sync_source', args: {} }]);
  });

  test('the tool schema lets the panel name this source', () => {
    const allowed = (SYNC_SOURCE_TOOL.inputSchema.properties as { source_id: { enum: string[] } }).source_id.enum;
    expect(allowed).toContain('local.files');
  });

  test('Checking, then the kept result line, in the shared words', () => {
    const checking: DashboardManualSync = { at: NOW.toISOString(), outcome: 'checking' };
    const view = localView('local-files-reading', { sync_now_available: true }, checking);
    const card = view.sources.find((source) => source.source_id === 'local.files')!;
    expect(dashboardManualSyncLine(card, NOW)).toBe('Checking Files on this computer…');
    expect(localRow(view).lastManualSync).toEqual({ at: NOW.toISOString(), outcome: 'checking' });

    for (const [sync, line] of [
      [{ at: NOW.toISOString(), outcome: 'checked', new_items: 0 }, 'Checked just now — no new files'],
      [{ at: NOW.toISOString(), outcome: 'checked', new_items: 12 }, 'Checked just now — 12 new files, reading them now'],
    ] as Array<[DashboardManualSync, string]>) {
      const done = localView('local-files-reading', { sync_now_available: true }, sync);
      const doneCard = done.sources.find((source) => source.source_id === 'local.files')!;
      expect(dashboardManualSyncLine(doneCard, NOW)).toBe(line);
      expect(localRow(done).detail?.startsWith(line)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The route, over a real scheduler                                     */
/* ------------------------------------------------------------------ */

interface Fixture {
  worker: ReturnType<typeof createEmailSourceWorker>;
  registryPath: string;
  scheduler: SourceScheduler;
  /** Resolves when the sync task has started its Nth pass. */
  started(): number;
  passes(): number;
  release(result?: SourceSchedulerTaskRunResult): void;
  operatorRuns: Array<string | undefined>;
}

function fixture(options: { approved?: boolean; connected?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'olympus-local-sync-now-'));
  const registryPath = join(root, 'handles.json');
  if (options.connected !== false) connectThisComputerSource(registryPath, 'local.files');
  let passes = 0;
  let release: ((result: SourceSchedulerTaskRunResult) => void) | undefined;
  const source: SourceSchedulerSource = {
    sourceId: 'local.files',
    corpusId: 'secure_local.local.files',
    cadence: 'continuous',
    intervalMs: 30 * 60_000,
    freshnessThresholdHours: 26,
    tasks: [{
      id: 'local.files_store_pull.test',
      kind: 'sync',
      writer: true,
      run: async (context) => {
        passes += 1;
        operatorRuns.push(context?.provenance);
        return new Promise<SourceSchedulerTaskRunResult>((resolve) => { release = resolve; });
      },
    }],
  };
  const operatorRuns: Array<string | undefined> = [];
  // Not started: only an explicit press runs it, as between scheduled ticks.
  const scheduler = new SourceScheduler({ enabled: true, tickMs: 60_000, errorBackoffMs: 60_000, maxTransientRetries: 1, sources: [source] });
  const worker = createEmailSourceWorker({
    sourceScheduler: scheduler,
    sourceIndexStatus: { status: async () => ({ kind: 'source_index_status', generated_at: NOW.toISOString(), corpora: [], policy: {} } as never) },
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      registryPath,
      registryAdoptionIntervalMs: 0,
      fileSourceScopes: {
        summaries: () => [{
          source_id: 'local.files',
          status: options.approved === false ? 'scope_pending' : 'approved',
          connected: true,
          whole_account_selected: false,
          selections: options.approved === false ? [] : [{ key: '/Users/test/notes', state: 'ingest' }],
        }] as never,
        browse: async () => { throw new Error('unused'); },
        approveAndStart: async () => { throw new Error('unused'); },
      },
    },
  });
  cleanups.push(() => {
    release?.({ status: 'idle' });
    worker.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    worker,
    registryPath,
    scheduler,
    started: () => passes,
    passes: () => passes,
    release: (result = { status: 'idle', counts: { items_changed: 0 } }) => release?.(result),
    operatorRuns,
  };
}

function post(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function card(f: Fixture): Promise<DashboardSourceCard> {
  const response = await f.worker.fetch(new Request('http://worker.test/dashboard.json'));
  expect(response.status).toBe(200);
  return ((await response.json()) as SourceDashboardViewModel).sources.find((source) => source.source_id === 'local.files')!;
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never held');
}

describe('/dashboard/sync-now for Files on this computer', () => {
  test('the card offers Sync now only while connected with a lane in this worker', async () => {
    expect((await card(fixture())).sync_now_available).toBe(true);
    // Disconnected in the this-computer record: nothing to check.
    const gone = fixture();
    expect(disconnectThisComputerSource(gone.registryPath, 'local.files')).toBe(true);
    expect((await card(gone)).sync_now_available).toBe(false);
  });

  test('starts one operator pass, answers checking at once, then busy, then the kept result, then too soon', async () => {
    const f = fixture();
    const response = await f.worker.fetch(post('/dashboard/sync-now', { source: 'local.files' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, source: 'local.files', status: 'checking', status_message: 'Checking Files on this computer…',
    });
    await until(() => f.passes() === 1);
    expect(f.operatorRuns).toEqual(['operator']);
    expect((await card(f)).last_manual_sync).toMatchObject({ outcome: 'checking' });

    // A second press while the pass runs starts nothing.
    const busy = await (await f.worker.fetch(post('/dashboard/sync-now', { source: 'local.files' }))).json();
    expect(busy).toMatchObject({ status: 'busy', status_message: 'Already checking Files on this computer' });
    expect(f.passes()).toBe(1);

    f.release({ status: 'idle', counts: { items_changed: 4 } });
    await until(async () => (await card(f)).last_manual_sync?.outcome === 'checked');
    expect((await card(f)).last_manual_sync).toMatchObject({ outcome: 'checked', new_items: 4 });

    const soon = await (await f.worker.fetch(post('/dashboard/sync-now', { source: 'local.files' }))).json();
    expect(soon).toMatchObject({ status: 'too_soon' });
    expect(f.passes()).toBe(1);
  });

  test('a press while the scheduler is already running the source starts no second pass', async () => {
    const f = fixture();
    // A pass the scheduler began on its own (a push wake or a tick).
    const scheduled = f.scheduler.runSource('local.files');
    await until(() => f.passes() === 1);
    const response = await f.worker.fetch(post('/dashboard/sync-now', { source: 'local.files' }));
    expect(response.status).toBe(200);
    // It did not start a second pass while the first held the source.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.passes()).toBe(1);
    f.release();
    await scheduled;
    await until(async () => (await card(f)).last_manual_sync?.outcome !== 'checking');
    expect(f.passes()).toBe(1);
  });

  test('refuses before reading anything when not connected or no folder is approved', async () => {
    const disconnected = fixture({ connected: false });
    const refused = await disconnected.worker.fetch(post('/dashboard/sync-now', { source: 'local.files' }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe('source_disconnected');
    expect(disconnected.passes()).toBe(0);

    const pending = fixture({ approved: false });
    const notApproved = await pending.worker.fetch(post('/dashboard/sync-now', { source: 'local.files' }));
    expect(notApproved.status).toBeGreaterThanOrEqual(400);
    expect(pending.passes()).toBe(0);
  });

  test('a source on this computer that is not declared is not accepted', async () => {
    const f = fixture();
    const response = await f.worker.fetch(post('/dashboard/sync-now', { source: 'photos.library' }));
    expect(response.status).toBe(400);
    expect(f.passes()).toBe(0);
  });
});

describe('olympus_sync_source for Files on this computer', () => {
  test('the panel tool starts the pass through the engine route and answers at once', async () => {
    const f = fixture();
    const backend = createChatGptSetupBackend({
      workerFetch: f.worker.fetch,
      handoffs: createChatGptHandoffs(),
      publicUrls: () => undefined,
      sovereignty: { config: loadSovereigntyPreset('no-sensitive'), source: 'inline' },
      credentialPresent: () => false,
      requestReload: () => false,
    });
    const result = await callSetupTool(SYNC_SOURCE_TOOL_NAME, { source_id: 'local.files' }, backend);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: 'checking', source_id: 'local.files' });
    expect(JSON.stringify(result.content)).toContain('Checking Files on this computer…');
    await until(() => f.passes() === 1);
    const again = await callSetupTool(SYNC_SOURCE_TOOL_NAME, { source_id: 'local.files' }, backend);
    expect(again.structuredContent).toEqual({ status: 'busy', source_id: 'local.files' });
    expect(f.passes()).toBe(1);
  });
});

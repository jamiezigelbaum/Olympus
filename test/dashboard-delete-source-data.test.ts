import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { connectThisComputerSource } from '../src/core/this-computer.ts';
import { lifecycleDataRoot, lifecycleSourceSpecs } from '../src/data-lifecycle.ts';
import type { ModelKeyReloadRequest } from '../src/core/model-key-reload.ts';
import { defaultSourceDashboardHistoryDbPath } from '../src/workers/source-dashboard.ts';
import {
  MINE,
  OTHER,
  SEEDED_FILES,
  layoutUnder,
  seedAllFiles,
  treeDigest,
  writeBackAfterDelete,
} from './helpers/forget-seeds.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { writeConnectedHandleRegistry, type ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';

/** Delete indexed data: the engine route behind olympus_delete_source_data. */
describe('dashboard Delete indexed data route', () => {
  function fixture(options: { connected?: boolean; canRestart?: boolean; busy?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-delete-data-'));
    const homeDir = join(root, 'home');
    const registryPath = join(root, 'handles.json');
    const registry: ConnectedHandleRegistry = options.connected === true
      ? {
          version: 1,
          handles: [{
            handle: 'dropbox.personal',
            provider: 'dropbox',
            accountRole: 'personal',
            trustDomain: 'secure_local',
            allowedCapabilities: ['dropbox.files.sync'],
            scopes: ['files.content.read'],
            connectedAt: '2026-08-30T00:00:00.000Z',
          }],
        }
      : { version: 1, handles: [] };
    writeConnectedHandleRegistry(registry, registryPath);
    const context = { homeDir, env: {} };
    const store = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'dropbox.files')!.connectorStorePaths!(context)[0]!;
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, 'indexed');
    const restarts = { asked: 0, requested: 0 };
    const worker = createEmailSourceWorker({
      ...(options.busy === true
        ? {
            sourceScheduler: {
              status: () => ({ enabled: true, running: true, sources: [] }),
              hasExecutingTask: () => true,
              updateSources: () => undefined,
            } as never,
          }
        : {}),
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        registryPath,
        registryAdoptionIntervalMs: 0,
        dataLifecyclePathContext: context,
        ...(options.canRestart === false
          ? {}
          : {
              workerRestart: {
                canRestart: () => { restarts.asked += 1; return true; },
                request: () => { restarts.requested += 1; return true; },
              },
            }),
      },
    });
    return { root, registryPath, store, restarts, worker };
  }
  const post = (worker: { fetch(request: Request): Promise<Response> }, body: Record<string, unknown>) =>
    worker.fetch(new Request('http://worker.test/dashboard/delete-source-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

  test('deletes a disconnected source\'s indexed data, then asks the worker to reopen its stores', async () => {
    const f = fixture();
    try {
      const response = await post(f.worker, { source_id: 'dropbox.files', acknowledge: true });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        source_id: 'dropbox.files',
        worker_restarting: true,
        policy: { indexed_data_deleted: true, source_files_untouched: true },
      });
      expect(existsSync(f.store)).toBe(false);
      expect(f.restarts.requested).toBe(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('refuses while the source is still connected: custody is Disconnect first', async () => {
    const f = fixture({ connected: true });
    try {
      const response = await post(f.worker, { source_id: 'dropbox.files', acknowledge: true });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'delete_source_connected' } });
      expect(existsSync(f.store)).toBe(true);
      expect(f.restarts.requested).toBe(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('refuses a source on this computer while it is connected', async () => {
    const f = fixture();
    try {
      connectThisComputerSource(f.registryPath, 'local.files');
      const response = await post(f.worker, { source_id: 'local.files', acknowledge: true });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'delete_source_connected' } });
      expect(f.restarts.requested).toBe(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('refuses without the owner\'s confirmation', async () => {
    const f = fixture();
    try {
      const response = await post(f.worker, { source_id: 'dropbox.files' });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'delete_confirmation_required' } });
      expect(existsSync(f.store)).toBe(true);
      expect(f.restarts.requested).toBe(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('refuses while a read for the source runs', async () => {
    const f = fixture({ busy: true });
    try {
      const response = await post(f.worker, { source_id: 'dropbox.files', acknowledge: true });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'delete_source_busy' } });
      expect(existsSync(f.store)).toBe(true);
      expect(f.restarts.requested).toBe(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('refuses before deleting anything when the worker cannot be restarted to reopen its stores', async () => {
    const f = fixture({ canRestart: false });
    try {
      const response = await post(f.worker, { source_id: 'dropbox.files', acknowledge: true });
      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'delete_reopen_unavailable' } });
      expect(existsSync(f.store)).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('rejects a source that is not a declared source', async () => {
    const f = fixture();
    try {
      const response = await post(f.worker, { source_id: 'made.up', acknowledge: true });
      expect(response.status).toBe(400);
      expect(existsSync(f.store)).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

/**
 * The forget registry in the worker's Delete (core/source-forget-registry.ts):
 * the source's rows leave the shared files, and the worker repeats that just
 * before the restart, because it keeps writing while it winds down.
 */
describe('dashboard Delete indexed data route: the shared files', () => {
  function fixture(options: { connected?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-delete-forget-'));
    // The worker's registry sits somewhere the environment would never name:
    // the config files beside it are the ones to forget.
    const layout = { ...layoutUnder(root), handleRegistryPath: join(root, 'elsewhere', 'handles.json') };
    const homeDir = join(root, 'home');
    writeConnectedHandleRegistry(options.connected === true
      ? {
          version: 1,
          handles: [{
            handle: 'dropbox.personal', provider: 'dropbox', accountRole: 'personal', trustDomain: 'secure_local',
            allowedCapabilities: ['dropbox.files.sync'], scopes: ['files.content.read'], connectedAt: '2026-08-30T00:00:00.000Z',
          }],
        }
      : { version: 1, handles: [] }, layout.handleRegistryPath);
    const context = { homeDir, env: {} };
    const store = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'dropbox.files')!.connectorStorePaths!(context)[0]!;
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, 'indexed');
    seedAllFiles(layout);
    const reloads: Array<ModelKeyReloadRequest | undefined> = [];
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        registryPath: layout.handleRegistryPath,
        registryAdoptionIntervalMs: 0,
        dataLifecyclePathContext: context,
        workerRestart: { canRestart: () => true, request: (reload) => { reloads.push(reload); return true; } },
      },
    });
    const del = (body: Record<string, unknown>) => worker.fetch(new Request('http://worker.test/dashboard/delete-source-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { root, layout, context, store, reloads, worker, del };
  }
  const files = SEEDED_FILES.filter((file) => file.stepId !== 'mail-source-scopes' && file.stepId !== 'this-computer');

  test('forgets the source in every shared file, the config files beside the worker\'s own registry included', async () => {
    const f = fixture();
    try {
      const response = await f.del({ source_id: 'dropbox.files', acknowledge: true });
      expect(response.status).toBe(200);
      expect(existsSync(f.store)).toBe(false);
      for (const file of files) {
        expect(file.left(f.layout, MINE), file.stepId).toBe(0);
        expect(file.left(f.layout, OTHER), file.stepId).toBeGreaterThan(0);
      }
      expect(existsSync(join(f.root, 'elsewhere', 'file-source-scopes.json'))).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('a poll that wrote the source back while the worker wound down is forgotten again before the exit', async () => {
    const f = fixture();
    try {
      const response = await f.del({ source_id: 'dropbox.files', acknowledge: true });
      expect(response.status).toBe(200);
      expect(f.reloads).toHaveLength(1);
      const reload = f.reloads[0]!;
      expect(reload.beforeExit).toBeFunction();

      // Between the delete and the exit: a dashboard poll records the counts
      // it read through stores that were still open, and an answer lands.
      writeBackAfterDelete(f.layout, MINE);
      writeBackAfterDelete(f.layout, OTHER);
      const dashboard = SEEDED_FILES.find((file) => file.stepId === 'source-dashboard')!;
      const waiting = SEEDED_FILES.find((file) => file.stepId === 'waiting-private-questions')!;
      expect(dashboard.left(f.layout, MINE)).toBeGreaterThan(0);
      expect(waiting.left(f.layout, MINE)).toBeGreaterThan(0);
      const otherBefore = { dashboard: dashboard.left(f.layout, OTHER), waiting: waiting.left(f.layout, OTHER) };

      await reload.beforeExit!();

      expect(dashboard.left(f.layout, MINE)).toBe(0);
      expect(waiting.left(f.layout, MINE)).toBe(0);
      expect({ dashboard: dashboard.left(f.layout, OTHER), waiting: waiting.left(f.layout, OTHER) }).toEqual(otherBefore);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('a repeat that cannot run does not keep the worker from restarting', async () => {
    const f = fixture();
    try {
      await f.del({ source_id: 'dropbox.files', acknowledge: true });
      writeFileSync(defaultSourceDashboardHistoryDbPath(f.layout.env), 'this is not a sqlite file '.repeat(200));

      const logged: unknown[][] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => { logged.push(args); };
      try {
        await expect(Promise.resolve(f.reloads[0]!.beforeExit!())).resolves.toBeUndefined();
      } finally {
        console.error = original;
      }
      expect(String(logged[0]?.[0])).toContain('dropbox.files');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('a delete that failed on a step restarts the worker without a repeat, and removes no bytes', async () => {
    const f = fixture();
    try {
      writeFileSync(defaultSourceDashboardHistoryDbPath(f.layout.env), 'this is not a sqlite file '.repeat(200));

      const response = await f.del({ source_id: 'dropbox.files', acknowledge: true });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'delete_failed' } });
      expect(existsSync(f.store)).toBe(true);
      expect(f.reloads).toEqual([undefined]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('a refused delete forgets nothing and asks for no restart', async () => {
    const f = fixture({ connected: true });
    try {
      const seeded = treeDigest(join(f.root, 'home'));

      const response = await f.del({ source_id: 'dropbox.files', acknowledge: true });

      expect(response.status).toBe(409);
      expect(treeDigest(join(f.root, 'home'))).toEqual(seeded);
      expect(f.reloads).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('the CLI\'s dry run through the worker reports what would be forgotten and changes nothing', async () => {
    const f = fixture();
    try {
      const seeded = treeDigest(f.root);

      const response = await f.worker.fetch(new Request('http://worker.test/v1/cli/data-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: 'dropbox.files', dry_run: true, data_root: lifecycleDataRoot(f.context) }),
      }));

      expect(response.status).toBe(200);
      const result = await response.json() as { dryRun: boolean; forgotten: string[]; worker_restarting: boolean };
      expect(result).toMatchObject({ dryRun: true, worker_restarting: false });
      expect(result.forgotten).toHaveLength(files.length);
      expect(treeDigest(f.root)).toEqual(seeded);
      expect(f.reloads).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

/**
 * Paired-session sources (Telegram, WhatsApp): no broker handle, so "disconnected"
 * means a CLEAN Unpair, and the capture child stays confirmed stopped.
 */
describe('dashboard Delete indexed data route: paired-session sources', () => {
  type Unpaired = 'clean' | 'incomplete' | 'none' | 'unreadable';
  function fixture(options: { unpaired?: Unpaired; sessionOnDisk?: boolean; stopThrows?: boolean; handle?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-delete-session-'));
    const homeDir = join(root, 'home');
    const registryPath = join(root, 'handles.json');
    writeConnectedHandleRegistry({
      version: 1,
      handles: options.handle === true
        ? [{
            handle: 'telegram.personal', provider: 'telegram', accountRole: 'personal', trustDomain: 'secure_local',
            allowedCapabilities: ['telegram.messages.sync'], scopes: [], connectedAt: '2026-08-30T00:00:00.000Z',
          }]
        : [],
    }, registryPath);
    const context = { homeDir, env: {} };
    const specs = lifecycleSourceSpecs();
    const tg = specs.find((entry) => entry.sourceId === 'telegram.messages')!;
    const wa = specs.find((entry) => entry.sourceId === 'whatsapp.personal.messages')!;
    const files = {
      tgStore: tg.connectorStorePaths!(context)[0]!,
      tgSpool: tg.rawStatePaths!(context)[0]!,
      tgSession: tg.pairingSessionPaths!(context)[0]!,
      waStore: wa.connectorStorePaths!(context)[0]!,
      waSpool: wa.rawStatePaths!(context)[0]!,
      waMedia: wa.rawStatePaths!(context).find((path) => path.endsWith('media'))!,
      waSession: wa.pairingSessionPaths!(context)[0]!,
    };
    for (const path of [files.tgStore, files.waStore]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'indexed'); }
    for (const dir of [files.tgSpool, files.waSpool, files.waMedia]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'x.jsonl'), 'raw'); }
    if (options.sessionOnDisk === true) {
      for (const path of [files.tgSession, files.waSession]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'session'); }
    }
    const state = options.unpaired ?? 'clean';
    if (state === 'unreadable') writeFileSync(`${registryPath}.unpaired`, '{not json');
    else if (state !== 'none') {
      const record = (source_id: string) => state === 'clean'
        ? { source_id, state: 'unpaired' }
        : { source_id, state: 'unpair_incomplete', failed_steps: ['stored_reference'] };
      writeFileSync(`${registryPath}.unpaired`, JSON.stringify({
        version: 1,
        sources: [record('telegram.messages'), record('whatsapp.personal.messages')],
      }), { mode: 0o600 });
    }
    const restarts = { requested: 0 };
    const stops: string[] = [];
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        registryPath,
        registryAdoptionIntervalMs: 0,
        dataLifecyclePathContext: context,
        workerRestart: { canRestart: () => true, request: () => { restarts.requested += 1; return true; } },
        stopMessagingCapture: async (source: 'telegram' | 'whatsapp') => {
          stops.push(source);
          if (options.stopThrows === true) throw new Error('did not exit');
        },
      },
    });
    return { root, files, restarts, stops, worker };
  }
  const post = (worker: { fetch(request: Request): Promise<Response> }, body: Record<string, unknown>) =>
    worker.fetch(new Request('http://worker.test/dashboard/delete-source-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

  test('after a clean Unpair, Telegram\'s stores and its raw capture copy go', async () => {
    const f = fixture();
    try {
      const response = await post(f.worker, { source_id: 'telegram.messages', acknowledge: true });
      expect(response.status).toBe(200);
      expect(existsSync(f.files.tgStore)).toBe(false);
      // Olympus's raw copy of the messages goes with the index.
      expect(existsSync(f.files.tgSpool)).toBe(false);
      // WhatsApp is a different source: untouched.
      expect(existsSync(f.files.waStore)).toBe(true);
      expect(f.stops).toEqual(['telegram']);
      expect(f.restarts.requested).toBe(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('after a clean Unpair, WhatsApp\'s store, spool and media go, and nothing else', async () => {
    const f = fixture();
    try {
      const response = await post(f.worker, { source_id: 'whatsapp.personal.messages', acknowledge: true });
      expect(response.status).toBe(200);
      expect(existsSync(f.files.waStore)).toBe(false);
      expect(existsSync(f.files.waSpool)).toBe(false);
      expect(existsSync(f.files.waMedia)).toBe(false);
      expect(existsSync(f.files.tgStore)).toBe(true);
      expect(existsSync(f.files.tgSpool)).toBe(true);
      expect(f.stops).toEqual(['whatsapp']);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test.each([
    ['never unpaired (still paired, no record)', { unpaired: 'none' as const }, 'delete_source_paired'],
    ['the unpair is incomplete', { unpaired: 'incomplete' as const }, 'delete_unavailable'],
    ['the unpair record is unreadable', { unpaired: 'unreadable' as const }, 'delete_unavailable'],
    ['the session file is still on disk', { sessionOnDisk: true }, 'delete_source_paired'],
    ['capture has not confirmed it stopped', { stopThrows: true }, 'delete_unavailable'],
  ] as const)('refuses and deletes nothing when %s', async (_name, options, code) => {
    const f = fixture(options as never);
    try {
      for (const source_id of ['telegram.messages', 'whatsapp.personal.messages']) {
        const response = await post(f.worker, { source_id, acknowledge: true });
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ error: { code } });
      }
      for (const path of [f.files.tgStore, f.files.tgSpool, f.files.waStore, f.files.waSpool, f.files.waMedia]) {
        expect(existsSync(path)).toBe(true);
      }
      expect(f.restarts.requested).toBe(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('refuses Telegram while its pairing handle is still registered, even with a clean-looking record', async () => {
    const f = fixture({ handle: true });
    try {
      const response = await post(f.worker, { source_id: 'telegram.messages', acknowledge: true });
      expect(response.status).toBe(409);
      // A session source ends with Unpair: the refusal says so, not Disconnect.
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'delete_source_paired', message: expect.stringContaining('Unpair') } });
      expect(existsSync(f.files.tgStore)).toBe(true);
      expect(f.restarts.requested).toBe(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

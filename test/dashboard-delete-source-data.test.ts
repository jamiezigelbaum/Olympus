import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { connectThisComputerSource } from '../src/core/this-computer.ts';
import { lifecycleSourceSpecs } from '../src/data-lifecycle.ts';
import { DASHBOARD_SUPPORTED_SOURCES } from '../src/workers/source-dashboard.ts';
import { scrubCard } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { applyPendingSourceDeletes, readSourceDeleteIntents } from '../src/pending-source-deletes.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { writeConnectedHandleRegistry, type ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';

/** Delete indexed data: the engine route behind olympus_delete_source_data. */
describe('dashboard Delete indexed data route', () => {
  function fixture(options: { connected?: boolean; canRestart?: boolean; busy?: boolean; onRestart?: (registryPath: string) => unknown; envOverride?: (home: string) => Record<string, string> } = {}) {
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
    const context = { homeDir, env: options.envOverride?.(homeDir) ?? {} };
    const store = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'dropbox.files')!.connectorStorePaths!(context)[0]!;
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, 'indexed');
    const restarts = { asked: 0, requested: 0 };
    const restartSaw: unknown[] = [];
    const worker = createEmailSourceWorker({
      sourceIndexStatus: {
        async status() {
          return {
            kind: 'source_index_status', generated_at: '2026-10-23T00:00:00.000Z', corpora: [],
            policy: { read_only: true, raw_source_exposed: false, source_packets_exposed: false, source_text_returned: false, secure_local_item_metadata_exposed: false, castor_visible: true },
          } as never;
        },
      },
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
                request: () => { restarts.requested += 1; if (options.onRestart) restartSaw.push(options.onRestart(registryPath)); return true; },
              },
            }),
      },
    });
    return { root, homeDir, context, registryPath, store, restarts, restartSaw, worker };
  }
  const post = (worker: { fetch(request: Request): Promise<Response> }, body: Record<string, unknown>) =>
    worker.fetch(new Request('http://worker.test/dashboard/delete-source-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

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

  test('records the delete durably, then asks for the restart, and deletes nothing itself', async () => {
    const f = fixture();
    try {
      const order: string[] = [];
      const response = await post(f.worker, { source_id: 'dropbox.files', acknowledge: true });
      void order;
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        ok: true, source_id: 'dropbox.files', state: 'deleting', worker_restarting: true,
        policy: { indexed_data_deleted: false, deletion_applies_on_restart: true, source_files_untouched: true },
      });
      // Nothing is unlinked under the running engine; the intent is on disk.
      expect(existsSync(f.store)).toBe(true);
      const { intents } = readSourceDeleteIntents(f.registryPath);
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ source_id: 'dropbox.files', state: 'pending' });
      expect(intents[0]!.targets).toContain(f.store);
      expect(f.restarts.requested).toBe(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('the intent is already durable when the restart is requested', async () => {
    const f = fixture({ onRestart: (registryPath) => readSourceDeleteIntents(registryPath).intents.length });
    try {
      await post(f.worker, { source_id: 'dropbox.files', acknowledge: true });
      expect(f.restartSaw).toEqual([1]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('the restart applies the intent: stores gone, intent removed, nothing else touched', async () => {
    const f = fixture();
    try {
      await post(f.worker, { source_id: 'dropbox.files', acknowledge: true });
      const applied = await applyPendingSourceDeletes({ registryPath: f.registryPath, context: f.context });
      expect(applied).toEqual({ applied: ['dropbox.files'], refused: [] });
      expect(existsSync(f.store)).toBe(false);
      expect(readSourceDeleteIntents(f.registryPath).intents).toEqual([]);
      // Idempotent: a second start has nothing to do.
      expect(await applyPendingSourceDeletes({ registryPath: f.registryPath, context: f.context })).toEqual({ applied: [], refused: [] });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('the dashboard shows Deleting until the restarted engine has applied it', async () => {
    const f = fixture();
    try {
      await post(f.worker, { source_id: 'dropbox.files', acknowledge: true });
      const label = async () => {
        const view = await (await f.worker.fetch(new Request('http://worker.test/dashboard.json'))).json() as { sources: Array<{ source_id: string; connection: { label: string } }> };
        return view.sources.find((source) => source.source_id === 'dropbox.files')?.connection.label;
      };
      expect(await label()).toBe('Deleting indexed data…');
      await applyPendingSourceDeletes({ registryPath: f.registryPath, context: f.context });
      expect(await label()).not.toBe('Deleting indexed data…');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('both delete states survive the ChatGPT sanitization as explicit fields with a closed reason', async () => {
    const f = fixture();
    try {
      await post(f.worker, { source_id: 'dropbox.files', acknowledge: true });
      const card = async () => {
        const view = await (await f.worker.fetch(new Request('http://worker.test/dashboard.json'))).json() as { sources: Array<{ source_id: string }> };
        return view.sources.find((source) => source.source_id === 'dropbox.files')!;
      };
      const definition = DASHBOARD_SUPPORTED_SOURCES.find((entry) => entry.source_id === 'dropbox.files')!;
      const pending = scrubCard(definition, await card() as never);
      expect(pending.delete_state).toEqual({ state: 'pending' });
      expect(pending.connection.label).toBe('Deleting indexed data…');
      // The re-check refuses (holders still running): the explanation and the retry survive.
      const holder = Bun.spawn([process.execPath, join(import.meta.dir, 'support', 'custody-holder.ts'), 'lib', f.store], { stdout: 'pipe', env: { PATH: process.env.PATH!, HOME: f.context.homeDir } });
      await holder.stdout.getReader().read();
      try {
        await applyPendingSourceDeletes({ registryPath: f.registryPath, context: f.context });
      } finally {
        holder.kill('SIGKILL');
        await holder.exited;
      }
      const refused = scrubCard(definition, await card() as never);
      expect(refused.delete_state).toEqual({ state: 'refused', reason: 'holders_running' });
      expect(refused.connection.label).toContain("Delete didn't run");
      // A reason outside the closed set is dropped, never passed through.
      expect(scrubCard(definition, { ...(await card()), delete_state: { state: 'refused', reason: '/home/me/secret' } } as never).delete_state).toEqual({ state: 'refused' });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('a config.json relocated onto a store path is refused when asking, with nothing recorded', async () => {
    const f = fixture({ envOverride: (home) => ({ OLYMPUS_EMAIL_INDEX_DB_PATH: join(home, '.olympus', 'config.json') })});
    try {
      mkdirSync(join(f.homeDir, '.olympus'), { recursive: true });
      writeFileSync(join(f.homeDir, '.olympus', 'config.json'), '{"keep":true}');
      const response = await post(f.worker, { source_id: 'gmail.email', acknowledge: true });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'delete_refused' } });
      expect(existsSync(join(f.homeDir, '.olympus', 'config.json'))).toBe(true);
      expect(readSourceDeleteIntents(f.registryPath).intents).toEqual([]);
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
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'delete_reopen_unavailable', message: expect.stringContaining('olympus data delete') } });
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
    return { root, files, restarts, stops, worker, registryPath, context };
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
      expect(response.status).toBe(202);
      expect(existsSync(f.files.tgStore)).toBe(true);
      await applyPendingSourceDeletes({ registryPath: f.registryPath, context: f.context });
      expect(existsSync(f.files.tgStore)).toBe(false);
      // Olympus's raw copy of the messages goes with the index.
      expect(existsSync(f.files.tgSpool)).toBe(false);
      // WhatsApp is a different source: untouched.
      expect(existsSync(f.files.waStore)).toBe(true);
      expect(f.restarts.requested).toBe(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('after a clean Unpair, WhatsApp\'s store, spool and media go, and nothing else', async () => {
    const f = fixture();
    try {
      const response = await post(f.worker, { source_id: 'whatsapp.personal.messages', acknowledge: true });
      expect(response.status).toBe(202);
      await applyPendingSourceDeletes({ registryPath: f.registryPath, context: f.context });
      expect(existsSync(f.files.waStore)).toBe(false);
      expect(existsSync(f.files.waSpool)).toBe(false);
      expect(existsSync(f.files.waMedia)).toBe(false);
      expect(existsSync(f.files.tgStore)).toBe(true);
      expect(existsSync(f.files.tgSpool)).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test.each([
    ['never unpaired (still paired, no record)', { unpaired: 'none' as const }, 'delete_source_paired'],
    ['the unpair is incomplete', { unpaired: 'incomplete' as const }, 'delete_unavailable'],
    ['the unpair record is unreadable', { unpaired: 'unreadable' as const }, 'delete_unavailable'],
    ['the session file is still on disk', { sessionOnDisk: true }, 'delete_source_paired'],
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

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { connectThisComputerSource } from '../src/core/this-computer.ts';
import { lifecycleSourceSpecs } from '../src/data-lifecycle.ts';
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

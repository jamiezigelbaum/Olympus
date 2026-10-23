/**
 * Delete indexed data is applied on restart, before anything opens: the intent
 * is durable, the engine host applies it before it starts a single service,
 * a crash part-way resumes, and a re-check that now refuses deletes nothing and
 * leaves a visible error state.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startEngineHost } from '../src/core/engine-host.ts';
import { engineChildrenPath } from '../src/core/engine-children.ts';
import { defaultEngineConfig, enginePaths } from '../src/core/engine-service.ts';
import { setNativeProcessChildObserver } from '../src/core/native-process-service.ts';
import { lifecycleSourceSpecs } from '../src/data-lifecycle.ts';
import {
  applyPendingSourceDeletes,
  pendingSourceDeletesPath,
  readSourceDeleteIntents,
  recordSourceDeleteIntent,
  sourceDeleteStates,
} from '../src/pending-source-deletes.ts';
import { writeConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';

const roots: string[] = [];
afterEach(() => {
  setNativeProcessChildObserver(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lab(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'olympus-pending-deletes-'));
  roots.push(root);
  const home = join(root, 'home');
  const registryPath = join(root, 'cfg', 'handles.json');
  mkdirSync(dirname(registryPath), { recursive: true });
  writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
  const context = { env: { HOME: home, ...env } };
  const spec = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'dropbox.files')!;
  const store = spec.connectorStorePaths!(context)[0]!;
  mkdirSync(dirname(store), { recursive: true });
  writeFileSync(store, 'indexed');
  writeFileSync(`${store}-wal`, 'wal');
  return { root, home, registryPath, context, store };
}

describe('deletion intents', () => {
  test('are written atomically under the registry directory and name source, corpora and the exact targets', () => {
    const l = lab();
    const intent = recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    expect(existsSync(pendingSourceDeletesPath(l.registryPath))).toBe(true);
    expect(intent).toMatchObject({ source_id: 'dropbox.files', state: 'pending' });
    expect(intent.corpora).toContain('secure_local.dropbox.files');
    expect(intent.targets).toContain(l.store);
    expect(readSourceDeleteIntents(l.registryPath).intents).toEqual([intent]);
    // Recording deletes nothing.
    expect(existsSync(l.store)).toBe(true);
  });

  test('a crash part-way resumes on the next start, and a repeat is harmless', () => {
    const l = lab();
    const recorded = recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    // The previous start died after removing the store but before the sidecar and the intent.
    rmSync(l.store);
    expect(applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context })).toEqual({ applied: ['dropbox.files'], refused: [] });
    expect(existsSync(`${l.store}-wal`)).toBe(false);
    expect(readSourceDeleteIntents(l.registryPath).intents).toEqual([]);
    // Died after everything was deleted but before the intent was removed.
    writeFileSync(pendingSourceDeletesPath(l.registryPath), JSON.stringify({
      version: 1,
      intents: [recorded],
    }));
    expect(applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context }).applied).toEqual(['dropbox.files']);
    expect(readSourceDeleteIntents(l.registryPath).intents).toEqual([]);
  });

  test('a re-check that now refuses deletes nothing and leaves a visible error state, retried by asking again', () => {
    const l = lab();
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    // The settings changed between asking and restarting: the targets are no longer what was approved.
    const moved = join(dirname(l.store), 'other-dropbox.sqlite');
    writeFileSync(moved, 'other');
    const changed = { env: { ...l.context.env, OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: moved } };
    const result = applyPendingSourceDeletes({ registryPath: l.registryPath, context: changed });
    expect(result).toEqual({ applied: [], refused: [{ sourceId: 'dropbox.files', reason: 'settings_changed' }] });
    expect(existsSync(l.store)).toBe(true);
    expect(existsSync(moved)).toBe(true);
    expect(sourceDeleteStates(l.registryPath)).toEqual({ 'dropbox.files': { state: 'refused', reason: 'settings_changed' } });
    // The refused record is not re-run on every start, and shows no path.
    expect(applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context })).toEqual({ applied: [], refused: [] });
    expect(JSON.stringify(sourceDeleteStates(l.registryPath))).not.toContain(l.root);
    // Asking again replaces it, and applies.
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    expect(sourceDeleteStates(l.registryPath)).toEqual({ 'dropbox.files': { state: 'pending' } });
    expect(applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context }).applied).toEqual(['dropbox.files']);
    expect(existsSync(l.store)).toBe(false);
  });

  test('a source reconnected before the restart is not deleted', () => {
    const l = lab();
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    writeConnectedHandleRegistry({
      version: 1,
      handles: [{
        handle: 'dropbox.personal', provider: 'dropbox', accountRole: 'personal', trustDomain: 'secure_local',
        allowedCapabilities: ['dropbox.files.sync'], scopes: ['files.content.read'], connectedAt: '2026-08-30T00:00:00.000Z',
      }],
    }, l.registryPath);
    expect(applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context }).refused).toEqual([{ sourceId: 'dropbox.files', reason: 'not_disconnected' }]);
    expect(existsSync(l.store)).toBe(true);
  });
});

describe('engine host start', () => {
  function hostLab() {
    const l = lab();
    mkdirSync(join(l.home, '.olympus'), { recursive: true });
    writeFileSync(enginePaths(l.home).configPath, JSON.stringify(defaultEngineConfig()));
    return l;
  }

  test('applies pending deletes after stale children are stopped and before any service starts', async () => {
    const l = hostLab();
    // Same registry directory the host resolves from its environment.
    const env = { HOME: l.home, OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: l.registryPath };
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: { env } });
    const childrenPath = engineChildrenPath({ HOME: l.home });
    mkdirSync(dirname(childrenPath), { recursive: true });
    writeFileSync(childrenPath, JSON.stringify({ schema: 'olympus.engine.children.v1', host_pid: 1, children: [{ service: 'olympus-source-embedding-drain', pgid: 5151 }] }));
    const order: string[] = [];
    const handle = await startEngineHost({
      moduleUrl: 'file:///x/dist/cli.js',
      env,
      homeDir: l.home,
      platform: 'darwin',
      services: () => ['olympus-source-embedding-drain', 'olympus-worker'].map((id) => ({
        id, reload: { configPrefixes: [] },
        async start() { order.push(`start ${id}: store ${existsSync(l.store) ? 'present' : 'gone'}`); },
        async stop() {},
      })),
      reap: {
        listProcesses: () => [],
        kill: () => { order.push('kill'); },
        sleep: () => undefined,
        selfPid: 1,
      },
      log: () => undefined,
      exit: () => { throw new Error('must not exit'); },
      installSignalHandlers: false,
    });
    // Every service sees the store already gone; none started before the delete.
    expect(order.filter((line) => line.startsWith('start'))).toEqual([
      'start olympus-source-embedding-drain: store gone',
      'start olympus-worker: store gone',
    ]);
    expect(readSourceDeleteIntents(l.registryPath).intents).toEqual([]);
    await handle!.stop();
  });

  test('a worker asking for a restart (SIGUSR2) stops every service and exits non-zero for the supervisor', async () => {
    const l = hostLab();
    const stops: string[] = [];
    const codes: number[] = [];
    const before = { term: process.listeners('SIGTERM'), int: process.listeners('SIGINT') };
    const handle = await startEngineHost({
      moduleUrl: 'file:///x/dist/cli.js',
      env: { HOME: l.home },
      homeDir: l.home,
      platform: 'darwin',
      services: () => [{ id: 'olympus-worker', reload: { configPrefixes: [] }, async start() {}, async stop() { stops.push('worker'); } }],
      reap: { listProcesses: () => [], kill: () => undefined, sleep: () => undefined, selfPid: 1 },
      log: () => undefined,
      exit: (code) => { codes.push(code); },
    });
    process.emit('SIGUSR2' as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stops).toEqual(['worker']);
    expect(codes).toEqual([75]);
    for (const [name, list] of [['SIGTERM', before.term], ['SIGINT', before.int]] as const) {
      for (const listener of process.listeners(name)) if (!list.includes(listener)) process.removeListener(name, listener as never);
    }
    void handle;
  });
});

describe('which installs may delete while running', () => {
  test('only the engine host restarts the embedding drain with the worker, so every other supervisor is refused', async () => {
    const { restartCoversEmbeddingDrain } = await import('../src/core/model-key-reload.ts');
    // Standalone engine host: worker and drain are one supervised unit.
    expect(restartCoversEmbeddingDrain({ nativeServiceSupervised: true }, { OLYMPUS_ENGINE_HOST: '1' })).toBe(true);
    // OpenClaw Gateway: the drain is a separately registered service.
    expect(restartCoversEmbeddingDrain({ nativeServiceSupervised: true }, {})).toBe(false);
    // Generated worker LaunchAgent/systemd unit: the drain is its own unit.
    expect(restartCoversEmbeddingDrain({}, { OLYMPUS_MANAGED_WORKER: '1' })).toBe(false);
    // A hand-started worker, even one that inherited the engine marker.
    expect(restartCoversEmbeddingDrain({}, { OLYMPUS_ENGINE_HOST: '1' })).toBe(false);
    expect(restartCoversEmbeddingDrain({}, {})).toBe(false);
  });
});

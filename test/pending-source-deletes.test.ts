/**
 * Delete indexed data is applied on restart, before anything opens: the intent
 * is durable, the engine host applies it before it starts a single service,
 * a crash part-way resumes, and a re-check that now refuses deletes nothing and
 * leaves a visible error state.
 */
import { Database } from 'bun:sqlite';
import { currentStoreMigrations, runSqliteMigrations } from '../src/core/sqlite-migrations.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { ensureStoreCustodyDirectory } from '../src/core/store-custody.ts';
import { openStoreDatabase } from '../src/core/store-open.ts';
import { deleteFencePath, isStorePathFenced, readDeleteFence } from '../src/core/delete-fence.ts';
import { releaseHeldStoreCustodyForTests, storeCustodyDirectory } from '../src/core/store-custody.ts';
import { effectiveWorkerEnvironment } from '../src/core/worker-effective-env.ts';
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
  sourceDeleteCustodyInput,
  sourceDeleteStates,
} from '../src/pending-source-deletes.ts';
import { changedBinding, deleteOlympusDataWithCustody, planSourceDelete } from '../src/data-lifecycle.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { withConnectedHandleGrantCustody, readConnectedHandleGrantEpoch } from '../src/workers/credential-broker/connected-handles.ts';
import { writeConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';

const roots: string[] = [];
afterEach(() => {
  setNativeProcessChildObserver(undefined);
  releaseHeldStoreCustodyForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Refuse to write anything that is not inside the fixture's own temp root. */
function mustBeInside(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`fixture path ${path} resolves outside ${root}; refusing to write`);
  return path;
}

function createMarkedSqliteStore(path: string): void {
  const db = new Database(path);
  try { runSqliteMigrations(db, 'connector-store', currentStoreMigrations()); } finally { db.close(); }
}

function lab(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'olympus-pending-deletes-'));
  roots.push(root);
  const home = join(root, 'home');
  const registryPath = join(root, 'cfg', 'handles.json');
  mkdirSync(dirname(registryPath), { recursive: true });
  writeConnectedHandleRegistry({ version: 1, handles: [] }, registryPath);
  const context = { homeDir: home, env: { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), ...env } };
  const spec = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'dropbox.files')!;
  const store = mustBeInside(root, spec.connectorStorePaths!(context)[0]!);
  mustBeInside(root, registryPath);
  mkdirSync(dirname(store), { recursive: true });
  writeFileSync(store, 'indexed');
  writeFileSync(`${store}-wal`, 'wal');
  return { root, home, registryPath, context, store };
}

describe('deletion intents', () => {
  test('are written atomically under the registry directory and name source, corpora and the exact targets', async () => {
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

  test('a crash part-way resumes on the next start, and a repeat is harmless', async () => {
    const l = lab();
    const recorded = recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    // The previous start died after removing the store but before the sidecar and the intent.
    rmSync(l.store);
    expect(await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context })).toEqual({ applied: ['dropbox.files'], incomplete: [], refused: [] });
    expect(existsSync(`${l.store}-wal`)).toBe(false);
    expect(readSourceDeleteIntents(l.registryPath).intents).toEqual([]);
    // Died after everything was deleted but before the intent was removed.
    writeFileSync(pendingSourceDeletesPath(l.registryPath), JSON.stringify({
      version: 1,
      intents: [recorded],
    }));
    expect((await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context })).applied).toEqual(['dropbox.files']);
    expect(readSourceDeleteIntents(l.registryPath).intents).toEqual([]);
  });

  test('a re-check that now refuses deletes nothing and leaves a visible error state, retried by asking again', async () => {
    const l = lab();
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    // The settings changed between asking and restarting: the targets are no longer what was approved.
    const moved = join(dirname(l.store), 'other-dropbox.sqlite');
    createMarkedSqliteStore(moved);
    const changed = { env: { ...l.context.env, OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: moved } };
    const result = await applyPendingSourceDeletes({ registryPath: l.registryPath, context: changed });
    expect(result).toEqual({ applied: [], incomplete: [], refused: [{ sourceId: 'dropbox.files', reason: 'settings_changed' }] });
    expect(existsSync(l.store)).toBe(true);
    expect(existsSync(moved)).toBe(true);
    expect(sourceDeleteStates(l.registryPath)).toEqual({ 'dropbox.files': { state: 'refused', reason: 'settings_changed' } });
    // The refused record is not re-run on every start, and shows no path.
    expect(await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context })).toEqual({ applied: [], incomplete: [], refused: [] });
    expect(JSON.stringify(sourceDeleteStates(l.registryPath))).not.toContain(l.root);
    // Asking again replaces it, and applies.
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    expect(sourceDeleteStates(l.registryPath)).toEqual({ 'dropbox.files': { state: 'pending' } });
    expect((await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context })).applied).toEqual(['dropbox.files']);
    expect(existsSync(l.store)).toBe(false);
  });

  test('a source reconnected before the restart is not deleted', async () => {
    const l = lab();
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    writeConnectedHandleRegistry({
      version: 1,
      handles: [{
        handle: 'dropbox.personal', provider: 'dropbox', accountRole: 'personal', trustDomain: 'secure_local',
        allowedCapabilities: ['dropbox.files.sync'], scopes: ['files.content.read'], connectedAt: '2026-08-30T00:00:00.000Z',
      }],
    }, l.registryPath);
    expect((await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context })).refused).toEqual([{ sourceId: 'dropbox.files', reason: 'not_disconnected' }]);
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
    const env = { HOME: l.home, XDG_DATA_HOME: join(l.home, '.local', 'share'), OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: l.registryPath };
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
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
  test('only a worker the engine host launched may delete; an inherited engine marker proves nothing', async () => {
    const { restartCoversEmbeddingDrain } = await import('../src/core/model-key-reload.ts');
    // Standalone engine host: the launcher stamps the supervisor identity.
    expect(restartCoversEmbeddingDrain({ nativeServiceSupervised: true }, { OLYMPUS_WORKER_SUPERVISOR: 'engine' })).toBe(true);
    // OpenClaw Gateway: its worker is stamped 'gateway', and the drain is a separately registered service.
    expect(restartCoversEmbeddingDrain({ nativeServiceSupervised: true }, { OLYMPUS_WORKER_SUPERVISOR: 'gateway' })).toBe(false);
    // A Gateway worker that inherited OLYMPUS_ENGINE_HOST=1 is still a Gateway worker.
    expect(restartCoversEmbeddingDrain({ nativeServiceSupervised: true }, { OLYMPUS_ENGINE_HOST: '1', OLYMPUS_WORKER_SUPERVISOR: 'gateway' })).toBe(false);
    expect(restartCoversEmbeddingDrain({ nativeServiceSupervised: true }, { OLYMPUS_ENGINE_HOST: '1' })).toBe(false);
    // Generated worker LaunchAgent/systemd unit, and hand-started workers (even with a stray marker).
    expect(restartCoversEmbeddingDrain({}, { OLYMPUS_MANAGED_WORKER: '1' })).toBe(false);
    expect(restartCoversEmbeddingDrain({}, { OLYMPUS_WORKER_SUPERVISOR: 'engine', OLYMPUS_ENGINE_HOST: '1' })).toBe(false);
    expect(restartCoversEmbeddingDrain({}, {})).toBe(false);
  });
});

function hostConfig(l: ReturnType<typeof lab>) {
  mkdirSync(join(l.home, '.olympus'), { recursive: true });
  writeFileSync(enginePaths(l.home).configPath, JSON.stringify(defaultEngineConfig()));
}

async function startHostWith(l: ReturnType<typeof lab>, extra: { children?: unknown; env?: Record<string, string>; psFails?: boolean }) {
  const env = { HOME: l.home, XDG_DATA_HOME: join(l.home, '.local', 'share'), OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: l.registryPath, ...(extra.env ?? {}) };
  if (extra.children) {
    const childrenPath = engineChildrenPath({ HOME: l.home });
    mkdirSync(dirname(childrenPath), { recursive: true });
    writeFileSync(childrenPath, JSON.stringify(extra.children));
  }
  hostConfig(l);
  const order: string[] = [];
  const handle = await startEngineHost({
    moduleUrl: 'file:///x/dist/cli.js',
    env,
    homeDir: l.home,
    platform: 'darwin',
    services: () => [{ id: 'olympus-worker', reload: { configPrefixes: [] }, async start() { order.push(`start: store ${existsSync(l.store) ? 'present' : 'gone'}`); }, async stop() {} }],
    reap: { listProcesses: () => (extra.psFails ? undefined : []), kill: () => undefined, sleep: () => undefined, selfPid: 1 },
    log: () => undefined,
    exit: () => { throw new Error('must not exit'); },
    installSignalHandlers: false,
  });
  return { order, handle };
}

const HOLDER = join(import.meta.dir, 'support', 'custody-holder.ts');
async function holdCustody(home: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [HOLDER, 'lib', ''], { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: process.env.PATH, HOME: home } });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', () => resolve());
    child.on('exit', (code) => reject(new Error(`holder exited ${code}`)));
  });
  return child;
}

describe('apply only when the stores are not held open', () => {
  test('a live holder refuses every pending delete and deletes nothing; once it is killed the retry deletes', async () => {
    const l = lab();
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    const holder = await holdCustody(l.home);
    try {
      const { order, handle } = await startHostWith(l, {});
      expect(order).toEqual(['start: store present']);
      expect(existsSync(l.store)).toBe(true);
      expect(sourceDeleteStates(l.registryPath)).toEqual({ 'dropbox.files': { state: 'refused', reason: 'holders_running' } });
      await handle!.stop();
    } finally {
      holder.kill('SIGKILL');
      await new Promise((resolve) => holder.on('exit', resolve));
    }
    // Asking again is the retry; with the holder gone the kernel lock is free.
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    const result = await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context });
    expect(result.applied).toEqual(['dropbox.files']);
    expect(existsSync(l.store)).toBe(false);
  }, 60_000);
});

describe('the host applies with the worker\'s effective environment', () => {
  test('a registry override that lives only in worker.env is the registry the host reads', async () => {
    const l = lab();
    const elsewhere = join(l.root, 'elsewhere', 'handles.json');
    mkdirSync(dirname(elsewhere), { recursive: true });
    writeConnectedHandleRegistry({ version: 1, handles: [] }, elsewhere);
    const ctx = { homeDir: l.home, env: { ...l.context.env, OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: elsewhere } };
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: elsewhere, context: ctx });
    // The override is in worker.env only, not in the host's own environment.
    const workerEnv = join(l.home, '.config', 'olympus', 'worker.env');
    mkdirSync(dirname(workerEnv), { recursive: true, mode: 0o700 });
    writeFileSync(workerEnv, `OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH=${elsewhere}\n`, { mode: 0o600 });
    const env = { HOME: l.home, XDG_DATA_HOME: join(l.home, '.local', 'share') };
    hostConfig(l);
    const handle = await startEngineHost({
      moduleUrl: 'file:///x/dist/cli.js', env, homeDir: l.home, platform: 'darwin',
      services: () => [],
      reap: { listProcesses: () => [], kill: () => undefined, sleep: () => undefined, selfPid: 1 },
      log: () => undefined, exit: () => { throw new Error('must not exit'); }, installSignalHandlers: false,
    });
    expect(existsSync(l.store)).toBe(false);
    expect(readSourceDeleteIntents(elsewhere).intents).toEqual([]);
    await handle!.stop();
  });
});

describe('the engine configuration\'s service credentials are part of the effective environment', () => {
  test('a registry override set only in worker.service.credentials is the registry the host reads', async () => {
    const l = lab();
    const elsewhere = join(l.root, 'elsewhere2', 'handles.json');
    mkdirSync(dirname(elsewhere), { recursive: true });
    writeConnectedHandleRegistry({ version: 1, handles: [] }, elsewhere);
    const ctx = { homeDir: l.home, env: { ...l.context.env, OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: elsewhere } };
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: elsewhere, context: ctx });
    mkdirSync(join(l.home, '.olympus'), { recursive: true });
    const config = defaultEngineConfig() as { worker: { service: Record<string, unknown> } };
    config.worker.service.credentials = { OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: elsewhere };
    writeFileSync(enginePaths(l.home).configPath, JSON.stringify(config));
    const handle = await startEngineHost({
      moduleUrl: 'file:///x/dist/cli.js',
      env: { HOME: l.home, XDG_DATA_HOME: join(l.home, '.local', 'share') },
      homeDir: l.home, platform: 'darwin',
      services: () => [],
      reap: { listProcesses: () => [], kill: () => undefined, sleep: () => undefined, selfPid: 1 },
      log: () => undefined, exit: () => { throw new Error('must not exit'); }, installSignalHandlers: false,
    });
    expect(existsSync(l.store)).toBe(false);
    expect(readSourceDeleteIntents(elsewhere).intents).toEqual([]);
    await handle!.stop();
  });

  test('effectiveWorkerEnvironment returns the same override for the CLI', () => {
    const l = lab();
    mkdirSync(join(l.home, '.olympus'), { recursive: true });
    const config = defaultEngineConfig() as { worker: { service: Record<string, unknown> } };
    config.worker.service.credentials = { OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: '/x/registry.json' };
    writeFileSync(enginePaths(l.home).configPath, JSON.stringify(config));
    const env = effectiveWorkerEnvironment({ env: { HOME: l.home }, homeDir: l.home, platform: 'darwin' });
    expect(env.OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH).toBe('/x/registry.json');
  });
});

describe('an intent is bound to where its targets really are', () => {
  test('a symlinked root retargeted between asking and restarting deletes nothing at the new place', async () => {
    const l = lab();
    const dataDir = dirname(l.store);
    const first = join(l.root, 'real-one');
    const second = join(l.root, 'real-two');
    renameSync(dataDir, first);
    mkdirSync(second, { recursive: true });
    symlinkSync(first, dataDir);
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    // Same names, another place: the link now leads to a folder that holds a store of its own.
    rmSync(dataDir);
    writeFileSync(join(second, basename(l.store)), 'someone else');
    symlinkSync(second, dataDir);
    const result = await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context });
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([{ sourceId: 'dropbox.files', reason: 'settings_changed' }]);
    expect(readFileSync(join(second, basename(l.store)), 'utf8')).toBe('someone else');
    expect(existsSync(join(first, basename(l.store)))).toBe(true);
  }, 10_000);

  test('a directory swapped for another at the same name is refused by its identity', async () => {
    const l = lab();
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    const dataDir = dirname(l.store);
    renameSync(dataDir, `${dataDir}-old`);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(l.store, 'replacement');
    const result = await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context });
    expect(result.refused).toEqual([{ sourceId: 'dropbox.files', reason: 'settings_changed' }]);
    expect(readFileSync(l.store, 'utf8')).toBe('replacement');
  }, 10_000);
});

describe('a delete that has begun is retried, never abandoned', () => {
  test('an unlink that fails part-way keeps durable retry state, and the next run finishes it', async () => {
    const l = lab();
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    const dataDir = dirname(l.store);
    chmodSync(dataDir, 0o500);
    let first;
    try {
      first = await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context });
    } finally {
      chmodSync(dataDir, 0o700);
    }
    expect(first.incomplete).toEqual(['dropbox.files']);
    expect(first.refused).toEqual([]);
    expect(readSourceDeleteIntents(l.registryPath).intents.map((entry) => entry.state)).toEqual(['applying']);
    expect(existsSync(l.store)).toBe(true);
    const second = await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context });
    expect(second.applied).toEqual(['dropbox.files']);
    expect(existsSync(l.store)).toBe(false);
    expect(readSourceDeleteIntents(l.registryPath).intents).toEqual([]);
  }, 10_000);

  test('the engine still starts while a started delete is unfinished, the stores stay fenced, and the next start finishes it', async () => {
    const l = lab();
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    const dataDir = dirname(l.store);
    hostConfig(l);
    const started: string[] = [];
    const exits: number[] = [];
    const hostOptions = () => ({
      moduleUrl: 'file:///x/dist/cli.js',
      env: { HOME: l.home, XDG_DATA_HOME: join(l.home, '.local', 'share'), OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: l.registryPath },
      homeDir: l.home, platform: 'darwin' as const,
      services: () => [{ id: 'olympus-worker', reload: { configPrefixes: [] }, async start() { started.push('worker'); }, async stop() {} }],
      reap: { listProcesses: () => [], kill: () => undefined, sleep: () => undefined, selfPid: 1 },
      log: () => undefined,
      exit: (code: number) => { exits.push(code); },
      installSignalHandlers: false,
    });
    chmodSync(dataDir, 0o500);
    let handle;
    try {
      handle = await startEngineHost(hostOptions());
    } finally {
      chmodSync(dataDir, 0o700);
    }
    // No crash loop: the engine is up and every service started.
    expect(started).toEqual(['worker']);
    expect(exits).toEqual([]);
    expect(readSourceDeleteIntents(l.registryPath).intents.map((entry) => entry.state)).toEqual(['applying']);
    expect(isStorePathFenced(l.store, l.home)).toBe(true);
    expect(sourceDeleteStates(l.registryPath, l.home)).toEqual({ 'dropbox.files': { state: 'unfinished', reason: 'failed' } });
    await handle!.stop();
    // The next start finishes it and lifts the fence.
    started.length = 0;
    const again = await startEngineHost(hostOptions());
    expect(started).toEqual(['worker']);
    expect(existsSync(l.store)).toBe(false);
    expect(isStorePathFenced(l.store, l.home)).toBe(false);
    expect(sourceDeleteStates(l.registryPath, l.home)).toEqual({});
    await again!.stop();
  }, 10_000 * 3);
});

/** Make the dropbox delete begin, then fail on every unlink (a read-only folder). */
async function beginThenFail(l: ReturnType<typeof lab>) {
  recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
  const dataDir = dirname(l.store);
  chmodSync(dataDir, 0o500);
  try {
    return await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context });
  } finally {
    chmodSync(dataDir, 0o700);
  }
}

describe('a started delete that cannot finish fences its source, not the engine', () => {
  test('a persistent unlink failure leaves the source fenced and the other sources and stores working', async () => {
    const l = lab();
    const otherStore = join(l.root, 'elsewhere', 'other.sqlite');
    mkdirSync(dirname(otherStore), { recursive: true });
    writeFileSync(otherStore, 'other source');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = attempt === 0 ? await beginThenFail(l) : await beginThenFail(l);
      expect(result).toEqual({ applied: [], incomplete: ['dropbox.files'], refused: [] });
      expect(isStorePathFenced(l.store, l.home)).toBe(true);
      expect(isStorePathFenced(`${l.store}-wal`, l.home)).toBe(true);
      expect(isStorePathFenced(otherStore, l.home)).toBe(false);
      expect(sourceDeleteStates(l.registryPath, l.home)['dropbox.files']).toEqual({ state: 'unfinished', reason: 'failed' });
    }
    expect(readFileSync(otherStore, 'utf8')).toBe('other source');
    // It finishes when the unlink works again.
    expect((await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context })).applied).toEqual(['dropbox.files']);
    expect(isStorePathFenced(l.store, l.home)).toBe(false);
  }, 10_000);

  test('a delete refused after it started (settings changed since) stays unfinished and fenced, never a plain refusal', async () => {
    const l = lab();
    await beginThenFail(l);
    const moved = join(dirname(l.store), 'other-dropbox.sqlite');
    createMarkedSqliteStore(moved);
    const changed = { homeDir: l.home, env: { ...l.context.env, OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: moved } };
    const result = await applyPendingSourceDeletes({ registryPath: l.registryPath, context: changed });
    expect(result).toEqual({ applied: [], incomplete: ['dropbox.files'], refused: [] });
    expect(readSourceDeleteIntents(l.registryPath).intents.map((entry) => [entry.state, entry.reason])).toEqual([['applying', 'settings_changed']]);
    expect(isStorePathFenced(l.store, l.home)).toBe(true);
    expect(existsSync(moved)).toBe(true);
    expect(sourceDeleteStates(l.registryPath, l.home)['dropbox.files']).toEqual({ state: 'unfinished', reason: 'settings_changed' });
    // Try again with the settings as they are: re-records and finishes.
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    expect((await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context })).applied).toEqual(['dropbox.files']);
    expect(isStorePathFenced(l.store, l.home)).toBe(false);
  }, 10_000);

  test('an unreadable intent file deletes nothing, keeps the fence closed with a reason, and Try again heals it', async () => {
    const l = lab();
    await beginThenFail(l);
    writeFileSync(pendingSourceDeletesPath(l.registryPath), '{ not json');
    const result = await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context });
    expect(result).toEqual({ applied: [], incomplete: ['dropbox.files'], refused: [] });
    expect(existsSync(l.store)).toBe(true);
    expect(isStorePathFenced(l.store, l.home)).toBe(true);
    // A lost record never hides a half-deleted source.
    expect(sourceDeleteStates(l.registryPath, l.home)).toEqual({ 'dropbox.files': { state: 'unfinished', reason: 'record_unreadable' } });
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    expect((await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context })).applied).toEqual(['dropbox.files']);
    expect(existsSync(l.store)).toBe(false);
    expect(isStorePathFenced(l.store, l.home)).toBe(false);
  }, 10_000);

  test('a preparation failure before the delete starts is a plain refusal: nothing deleted, nothing fenced', async () => {
    const l = lab();
    // Looks like SQLite, reads as garbage: the picture-reference read fails.
    writeFileSync(l.store, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 0xff)]));
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    const result = await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context });
    expect(result).toEqual({ applied: [], incomplete: [], refused: [{ sourceId: 'dropbox.files', reason: 'failed' }] });
    expect(existsSync(l.store)).toBe(true);
    expect(existsSync(`${l.store}-wal`)).toBe(true);
    expect(isStorePathFenced(l.store, l.home)).toBe(false);
    expect(readDeleteFence(l.home).entries).toEqual([]);
    expect(sourceDeleteStates(l.registryPath, l.home)).toEqual({ 'dropbox.files': { state: 'refused', reason: 'failed' } });
  }, 10_000);

  test('the store-open boundary hands a fenced store back as an empty placeholder, never the partial file', async () => {
    const l = lab();
    rmSync(l.store); rmSync(`${l.store}-wal`);
    createMarkedSqliteStore(l.store);
    const before = new Database(l.store);
    before.exec('CREATE TABLE IF NOT EXISTS t (x)'); before.exec('INSERT INTO t VALUES (1)'); before.close();
    await beginThenFail(l);
    const savedHome = process.env.HOME;
    process.env.HOME = l.home;
    try {
      const errors = console.error; console.error = () => undefined;
      try {
        const fenced = openStoreDatabase(l.store);
        expect(fenced.query("SELECT name FROM sqlite_master WHERE name = 't'").all()).toEqual([]);
        fenced.close();
      } finally { console.error = errors; }
      const other = join(l.root, 'free.sqlite');
      const free = openStoreDatabase(other);
      free.exec('CREATE TABLE t (x)'); free.close();
      expect(existsSync(other)).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
    // The partial file itself was not touched by the placeholder.
    const check = new Database(l.store, { readonly: true });
    expect(check.query("SELECT x FROM t").all()).toEqual([{ x: 1 }]);
    check.close();
  }, 10_000);

  test('an unreadable fence file fails closed for every store', () => {
    const l = lab();
    mkdirSync(storeCustodyDirectory(l.home), { recursive: true, mode: 0o700 });
    writeFileSync(deleteFencePath(l.home), 'garbage');
    expect(isStorePathFenced(l.store, l.home)).toBe(true);
    expect(isStorePathFenced(join(l.root, 'anything.sqlite'), l.home)).toBe(true);
  });
});

describe('grant custody and connection generation', () => {
  test('a connection change in progress stops the apply and deletes nothing', async () => {
    const l = lab();
    recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    const result = await withConnectedHandleGrantCustody(l.registryPath, {}, async () =>
      await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context }));
    expect(result.applied).toEqual([]);
    expect(existsSync(l.store)).toBe(true);
    expect(sourceDeleteStates(l.registryPath)['dropbox.files']).toEqual({ state: 'refused', reason: 'failed' });
  }, 60_000);

  test('the intent is bound to the grant generation: a Disconnect or Connect since it was judged refuses it', async () => {
    const l = lab();
    const intent = recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    expect(intent.grant_epoch).toBe(readConnectedHandleGrantEpoch(l.registryPath));
    await withConnectedHandleGrantCustody(l.registryPath, { advanceEpoch: true }, () => undefined);
    const result = await applyPendingSourceDeletes({ registryPath: l.registryPath, context: l.context });
    expect(result.refused).toEqual([{ sourceId: 'dropbox.files', reason: 'connection_changed' }]);
    expect(existsSync(l.store)).toBe(true);
  });
});

describe('an external SQLite family finishes after its primary is gone', () => {
  test('a crash after the primary was removed still removes the sidecars', async () => {
    const l = lab();
    const external = join(l.root, 'external', 'dropbox-elsewhere.sqlite');
    mkdirSync(dirname(external), { recursive: true });
    createMarkedSqliteStore(external);
    writeFileSync(`${external}-wal`, 'wal');
    writeFileSync(`${external}-shm`, 'shm');
    const ctx = { homeDir: l.home, env: { ...l.context.env, OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: external } };
    const intent = recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: ctx });
    expect(intent.verified_primaries).toContain(external);
    // The previous start removed the primary, then died.
    rmSync(external);
    const result = await applyPendingSourceDeletes({ registryPath: l.registryPath, context: ctx });
    expect(result).toEqual({ applied: ['dropbox.files'], incomplete: [], refused: [] });
    expect(existsSync(`${external}-wal`)).toBe(false);
    expect(existsSync(`${external}-shm`)).toBe(false);
  });

  test('without the recorded ownership a lone sidecar is still refused', async () => {
    const l = lab();
    const stray = join(l.root, 'external', 'stray.sqlite');
    mkdirSync(dirname(stray), { recursive: true });
    writeFileSync(`${stray}-wal`, 'not ours');
    const ctx = { homeDir: l.home, env: { ...l.context.env, OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: stray } };
    expect(() => recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: ctx })).toThrow();
    expect(existsSync(`${stray}-wal`)).toBe(true);
  });
});

describe('the store lock cannot be reached through a delete target', () => {
  test('a target that is a link to the lock file, or lives in a link to the lock folder, is refused', () => {
    const l = lab();
    const directory = ensureStoreCustodyDirectory(l.home);
    const lock = join(directory, 'store-lifecycle.lock.db');
    writeFileSync(lock, '');
    const viaFile = join(l.root, 'file-link.sqlite');
    symlinkSync(lock, viaFile);
    const viaFolder = join(l.root, 'folder-link');
    symlinkSync(directory, viaFolder);
    for (const configured of [viaFile, join(viaFolder, 'store-lifecycle.lock.db'), viaFolder]) {
      const env = { ...l.context.env, OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH: configured };
      expect(() => recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: { homeDir: l.home, env } })).toThrow();
    }
    expect(existsSync(lock)).toBe(true);
  });
});

describe('every removal re-checks the approved places', () => {
  test('bindings record the device as well as the inode', async () => {
    const l = lab();
    const intent = recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    expect(intent.bindings?.length).toBeGreaterThan(0);
    for (const binding of intent.bindings!) {
      expect(typeof binding.anchor_dev).toBe('number');
      expect(binding.anchor_dev).toBeGreaterThanOrEqual(0);
    }
    // A device that is not the one recorded refuses, though the names and inode match.
    const forged = intent.bindings!.map((binding) => ({ ...binding, anchor_dev: binding.anchor_dev! + 1 }));
    const plan = planSourceDelete({ sourceId: 'dropbox.files', ...l.context, registryPath: l.registryPath });
    expect(changedBinding(forged, plan.bindings)).toBeDefined();
    expect(changedBinding(intent.bindings!, plan.bindings)).toBeUndefined();
  });

  test('a folder swapped after the delete began stops the next removal, and the source stays fenced', () => {
    const l = lab();
    const intent = recordSourceDeleteIntent({ sourceId: 'dropbox.files', registryPath: l.registryPath, context: l.context });
    const dataDir = dirname(l.store);
    expect(() => deleteOlympusDataWithCustody({
      ...sourceDeleteCustodyInput('dropbox.files', l.registryPath),
      ...l.context,
      registryPath: l.registryPath,
      sourceId: 'dropbox.files',
      verifiedPrimaries: intent.verified_primaries ?? [],
      expectedBindings: intent.bindings!,
      // Runs after the last pre-mutation check, as the delete begins.
      onBegin: () => {
        renameSync(dataDir, join(l.root, 'swapped-away'));
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(l.store, 'someone else');
      },
    })).toThrow(/not where it was/);
    expect(readFileSync(l.store, 'utf8')).toBe('someone else');
    expect(isStorePathFenced(l.store, l.home)).toBe(true);
  });
});

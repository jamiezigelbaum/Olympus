// The engine split booted for real (docs/design/engine-split.md, part 3): the
// worker's own entry run twice, as the background and as the front, on a
// fresh home. The front does not serve until the background is ready, takes
// no data-owner lock, and serves with its write guard on; the background
// serves no HTTP, only its command socket. Spawning tests carry an explicit
// timeout (test/spawn-timeout-guard.test.ts).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connectThisComputerSource } from '../src/core/this-computer.ts';
import { resolvedStorePath } from '../src/core/source-placement.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { FileSourceScopeAuthority } from '../src/workers/source-scope-runtime.ts';
import { FIXTURE_PLACEMENT, fixtureConnector } from './helpers/tier-fixtures.ts';
import { ENGINE_BACKGROUND_ORIGIN } from '../src/core/engine-split.ts';
import { createUnixSocketFetch, createWorkerFetch } from '../src/core/worker-transport.ts';
import { readEngineStatusSnapshot } from '../src/workers/engine-split/snapshot.ts';
import { engineStatusSnapshotPath } from '../src/workers/engine-split/runtime.ts';
import { waitFor } from './helpers/test-clock.ts';

const SERVER = join(import.meta.dir, '..', 'src', 'workers', 'engine', 'server.ts');
const REPO = join(import.meta.dir, '..');
const TOKEN = 'engine-split-boot-token';

const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill('SIGKILL'); await child.exited; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function spawnWorker(env: Record<string, string>, role: 'background' | 'front'): { output: () => string } {
  const child = Bun.spawn([process.execPath, SERVER], {
    env: { PATH: process.env.PATH ?? '', ...env, OLYMPUS_WORKER_ENGINE_ROLE: role },
    cwd: REPO, stdout: 'pipe', stderr: 'pipe',
  });
  children.push(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream as ReadableStream<Uint8Array>) output += decoder.decode(chunk);
    })();
  }
  return { output: () => output };
}

describe('the engine split boots as two processes', () => {
  test('the front waits for the background, then serves; the background serves only its socket', async () => {
    // Short paths: a unix socket path has a length limit.
    const home = mkdtempSync(join('/tmp', 'oes-'));
    roots.push(home);
    mkdirSync(join(home, 'run'), { mode: 0o700 });
    const port = (() => { const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); const value = server.port; server.stop(true); return value; })();
    const env = {
      HOME: home,
      XDG_DATA_HOME: join(home, 'd'),
      XDG_STATE_HOME: join(home, 's'),
      XDG_CONFIG_HOME: join(home, 'c'),
      XDG_RUNTIME_DIR: join(home, 'run'),
      OLYMPUS_EMAIL_SOURCE_PORT: String(port),
      OLYMPUS_WORKER_SCHEDULER_ENABLED: 'false',
      OLYMPUS_WORKER_AUTH_TOKEN: TOKEN,
      OLYMPUS_ENGINE_BACKGROUND_SOCKET: join(home, 'run', 'olympus', 'background.sock'),
      NODE_ENV: 'test',
    };
    const front = spawnWorker(env, 'front');
    // Without a background the front opens nothing and does not listen.
    expect(front.output()).not.toContain('worker listening');
    const background = spawnWorker(env, 'background');
    await waitFor(() => background.output().includes('engine background ready'), { timeoutMs: 60_000 });
    expect(background.output()).not.toContain('worker listening');
    await waitFor(() => front.output().includes('worker listening'), { timeoutMs: 60_000 });
    expect(front.output()).not.toContain('FrontStoreWriteError');

    const workerFetch = createWorkerFetch({ platform: 'linux', env });
    const health = await workerFetch(`http://127.0.0.1:${port}/v1/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(health.status).toBe(200);
    // The front reports its background, so an upgrade or rollback never calls a crash-looping background healthy (#1563 review).
    expect(await health.json()).toMatchObject({ reachable: true, engine_background: 'ready' });
    // Source watches are the background's: a create is answered by its route, not refused.
    const watch = await workerFetch(`http://127.0.0.1:${port}/v1/source/watch/create`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{}' });
    expect(watch.status).not.toBe(503);
    const answered = JSON.stringify(await watch.json());
    expect(answered).not.toContain('not_available_in_split_mode');
    expect(answered).not.toContain('engine_background_');
    // A forwarded one passes the front's authorization first, then the background's route answers it.
    const unauthorized = await workerFetch(`http://127.0.0.1:${port}/v1/cli/tier`, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);
    await unauthorized.body?.cancel();
    const forwarded = await workerFetch(`http://127.0.0.1:${port}/v1/cli/tier`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{}' });
    expect(forwarded.status).toBe(409);
    expect(JSON.stringify(await forwarded.json())).toContain('did not say which Olympus data');

    const backgroundFetch = createUnixSocketFetch(env.OLYMPUS_ENGINE_BACKGROUND_SOCKET);
    const posted = await backgroundFetch(`${ENGINE_BACKGROUND_ORIGIN}/engine/commands`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ id: 'boot-test-0001', command: { kind: 'reload', target: 'sources' } }),
    });
    expect(posted.status).toBe(202);
    await posted.body?.cancel();
    const result = await backgroundFetch(`${ENGINE_BACKGROUND_ORIGIN}/engine/commands/boot-test-0001?wait=5000`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(await result.json()).toMatchObject({ state: 'done', result: { reloaded: 'sources' } });

    const snapshot = await waitFor(() => readEngineStatusSnapshot(engineStatusSnapshotPath(env)));
    expect(snapshot.snapshot.judge).toBeDefined();

    // With the background gone the front still answers, and says so.
    const backgroundChild = children[1]!;
    backgroundChild.kill('SIGKILL');
    await backgroundChild.exited;
    const alone = await workerFetch(`http://127.0.0.1:${port}/v1/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(alone.status).toBe(200);
    expect(await alone.json()).toMatchObject({ engine_background: 'unreachable' });
  }, 120_000);

  test('with a connected source, the front reads its stores read-only and serves them', async () => {
    const home = mkdtempSync(join('/tmp', 'oes-'));
    roots.push(home);
    mkdirSync(join(home, 'run'), { mode: 0o700 });
    const port = (() => { const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); const value = server.port; server.stop(true); return value; })();
    const registryPath = join(home, 'c', 'olympus', 'handles.json');
    const env = {
      HOME: home,
      XDG_DATA_HOME: join(home, 'd'),
      XDG_STATE_HOME: join(home, 's'),
      XDG_CONFIG_HOME: join(home, 'c'),
      XDG_RUNTIME_DIR: join(home, 'run'),
      OLYMPUS_EMAIL_SOURCE_PORT: String(port),
      OLYMPUS_WORKER_SCHEDULER_ENABLED: 'false',
      OLYMPUS_WORKER_AUTH_TOKEN: TOKEN,
      OLYMPUS_ENGINE_BACKGROUND_SOCKET: join(home, 'run', 'olympus', 'background.sock'),
      OLYMPUS_SOURCE_INDEX_LOCAL_FILES_CONNECTOR_STORE_ENABLED: 'true',
      OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: registryPath,
      NODE_ENV: 'test',
    };
    // Local files, connected with a folder approved, and its store already holding an item.
    connectThisComputerSource(registryPath, 'local.files');
    const folder = join(home, 'notes');
    mkdirSync(folder);
    writeFileSync(join(folder, 'orchard.txt'), 'The orchard lab note.');
    const authority = new FileSourceScopeAuthority({ registryPath });
    const pending = authority.snapshot('local.files');
    authority.approve({ sourceId: 'local.files', accountGeneration: pending.accountGeneration!, expectedRevision: pending.revision, selections: [{ key: folder, state: 'ingest' }], wholeAccount: false, explicitWholeAccountConfirmation: false });
    const storePath = resolvedStorePath('local.files', 'secure_local', env);
    mkdirSync(dirname(storePath), { recursive: true });
    const seeded = new LocalConnectorStore({ dbPath: storePath, corpusId: 'secure_local.local.files', family: 'file', trustDomain: 'secure_local' });
    await seeded.syncFromConnector(fixtureConnector(() => [{ id: 'orchard', name: 'orchard-lab.txt', text: 'The orchard lab note.', legacyDomain: 'secure_local' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    seeded.close();

    const background = spawnWorker(env, 'background');
    await waitFor(() => background.output().includes('engine background ready'), { timeoutMs: 60_000 });
    const front = spawnWorker(env, 'front');
    await waitFor(() => front.output().includes('worker listening') || /FrontStoreWriteError|error/i.test(front.output()), { timeoutMs: 60_000 });
    expect(front.output()).not.toContain('FrontStoreWriteError');
    expect(front.output()).toContain('worker listening');

    const workerFetch = createWorkerFetch({ platform: 'linux', env });
    const status = await workerFetch(`http://127.0.0.1:${port}/v1/source/index/status`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    const body = JSON.stringify(await status.json());
    expect(status.status, body).toBe(200);
    expect(body).toContain('secure_local.local.files');
    expect(front.output()).not.toContain('FrontStoreWriteError');
  }, 180_000);
});

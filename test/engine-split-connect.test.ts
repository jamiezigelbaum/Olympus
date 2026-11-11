// The engine split with a source connected after boot (docs/design/engine-split.md, part 3): the front mounts the
// source's lane before the background has created its stores. A store that does not exist yet is not an error in the
// front: it reads as empty until the background creates it, and the front never creates it. Spawning tests carry an
// explicit timeout (test/spawn-timeout-guard.test.ts).
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWorkerFetch } from '../src/core/worker-transport.ts';
import { resolvedStorePath } from '../src/core/source-placement.ts';
import { Database } from 'bun:sqlite';
import { LocalConnectorStore, connectorStoreReadableNow } from '../src/workers/connector-store/local-index.ts';
import { waitFor } from './helpers/test-clock.ts';

const SERVER = join(import.meta.dir, '..', 'src', 'workers', 'email-source', 'server.ts');
const REPO = join(import.meta.dir, '..');
const TOKEN = 'engine-split-connect-token';

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

describe('the engine split with a source connected after boot', () => {
  test('the front mounts a connected source whose stores the background has not created yet', async () => {
    const home = mkdtempSync(join('/tmp', 'oec-'));
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
      OLYMPUS_WORKER_SCHEDULER_ENABLED: 'true',
      OLYMPUS_WORKER_AUTH_TOKEN: TOKEN,
      OLYMPUS_ENGINE_BACKGROUND_SOCKET: join(home, 'run', 'olympus', 'background.sock'),
      OLYMPUS_SOURCE_INDEX_READWISE_CONNECTOR_STORE_ENABLED: 'true',
      OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: registryPath,
      // An embedding provider mounts the Readwise lane; nothing here embeds, so nothing listens on it.
      OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER: 'local-openai-compatible',
      OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1',
      OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL: 'test-embed',
      OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY: '8',
      NODE_ENV: 'test',
    };
    const background = spawnWorker(env, 'background');
    await waitFor(() => background.output().includes('engine background ready'), { timeoutMs: 60_000 });
    const front = spawnWorker(env, 'front');
    await waitFor(() => front.output().includes('worker listening'), { timeoutMs: 60_000 });

    // Readwise is connected now, after both started; nothing has synced, so no store exists.
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({ version: 1, handles: [{
      handle: 'readwise.personal', provider: 'readwise', accountRole: 'personal', trustDomain: 'internal',
      allowedCapabilities: ['readwise.sync'], scopes: ['readwise.export:read', 'readwise.reader:read'],
      tokenSecretRefs: ['store:readwise.personal.token'], connectedAt: '2026-11-10T10:00:00.000Z',
    }] }));
    const internal = resolvedStorePath('readwise.library', 'internal', env);
    expect(existsSync(internal)).toBe(false);

    const workerFetch = createWorkerFetch({ platform: 'linux', env });
    const dashboard = await workerFetch(`http://127.0.0.1:${port}/dashboard.json`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await dashboard.text();
    expect(dashboard.status, body.slice(0, 300)).toBe(200);
    const readwise = (JSON.parse(body).sources as Array<Record<string, any>>).find((source) => source.provider === 'readwise');
    expect(readwise?.configured).toBe(true);
    expect(readwise?.connection?.state).toBe('waiting_for_first_sync');
    expect(front.output()).not.toContain('ENOENT');
    expect(front.output()).not.toContain('scheduler refresh after a registry change failed');

    // The front told the background at once (no wait for its 30 s adoption tick); the background created the stores,
    // and the front mounted them read-only as soon as they existed.
    await waitFor(() => existsSync(internal), { timeoutMs: 20_000, intervalMs: 100 });
    const mounted = await waitFor(async () => {
      const status = await workerFetch(`http://127.0.0.1:${port}/v1/source/index/status`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{}',
      });
      const text = await status.text();
      return status.status === 200 && text.includes('internal.readwise.library') ? text : undefined;
    }, { timeoutMs: 20_000, intervalMs: 250 });
    expect(mounted).toContain('internal.readwise.library');
    expect(mounted).not.toContain('secure_local.readwise.library');

    // Later the background creates the lane's Private store (its first Private item). The front reads it from then on:
    // without it the dashboard counted no Private item and no located Secret (release check run 42920172756).
    const secure = resolvedStorePath('readwise.library', 'secure_local', env);
    expect(existsSync(secure)).toBe(false);
    const written = new LocalConnectorStore({ dbPath: secure, corpusId: 'secure_local.readwise.library', family: 'readwise', trustDomain: 'secure_local' });
    written.close();
    const withSecure = await waitFor(async () => {
      const status = await workerFetch(`http://127.0.0.1:${port}/v1/source/index/status`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{}',
      });
      const text = await status.text();
      return status.status === 200 && text.includes('secure_local.readwise.library') ? text : undefined;
    }, { timeoutMs: 20_000, intervalMs: 250 });
    expect(withSecure).toContain('secure_local.readwise.library');
    expect(front.output()).not.toContain('FrontStoreWriteError');
    expect(front.output()).not.toContain('ENOENT');
  }, 180_000);
});

describe('a store the front may mount', () => {
  // The background creates a store's file before it writes its schema: until then a read-only open throws, so the front
  // waits instead of mounting it (the dashboard answered 500 while it threw).
  test('is readable only once its writer has recorded a schema', () => {
    const root = mkdtempSync(join('/tmp', 'oec-'));
    roots.push(root);
    const path = join(root, 'store.sqlite');
    expect(connectorStoreReadableNow(path)).toBe(false);
    writeFileSync(path, '');
    expect(connectorStoreReadableNow(path)).toBe(false);
    rmSync(path);
    const bare = new Database(path, { create: true });
    bare.exec('CREATE TABLE items (id TEXT)');
    bare.close();
    expect(connectorStoreReadableNow(path)).toBe(false);
    rmSync(path);
    new LocalConnectorStore({ dbPath: path, corpusId: 'internal.test', family: 'readwise', trustDomain: 'internal' }).close();
    expect(connectorStoreReadableNow(path)).toBe(true);
    expect(() => new LocalConnectorStore({ dbPath: path, corpusId: 'internal.test', family: 'readwise', trustDomain: 'internal', readOnly: true }).close()).not.toThrow();
  });
});

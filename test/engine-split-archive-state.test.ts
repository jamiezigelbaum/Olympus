// Regressions for #1324: stores and archive files written after a split front
// boots must be visible there, and the background must leave its uploads alone.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWorkerFetch, createUnixSocketFetch } from '../src/core/worker-transport.ts';
import { createArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { archiveStateSiblingPath, sharedDataPath } from '../src/core/olympus-layout.ts';
import { defaultArchiveImportStatePath } from '../src/workers/archive-import/state.ts';
import { pullArchiveImport } from '../src/workers/archive-import/sync.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { createWhatsAppConnectorStore, createWhatsAppTierLane, WHATSAPP_LIVE_CORPUS_ID, WHATSAPP_PERSONAL_SOURCE_ID } from '../src/workers/whatsapp/index.ts';
import { EngineCommandClient } from '../src/workers/engine-split/client.ts';
import { ArchiveImportRequestStore, archiveImportRequestsPath } from '../src/workers/archive-import/requests.ts';
import { workerSetupEnvPath } from '../src/core/worker-auth.ts';
import { engineStatusSnapshotPath } from '../src/workers/engine-split/runtime.ts';
import { readEngineStatusSnapshot, writeEngineStatusSnapshot } from '../src/workers/engine-split/snapshot.ts';
import { COMPUTER_META_KEY, type ComputerDashboardMeta } from '../src/workers/chatgpt/dashboard-contract.ts';
import { FIXTURE_PLACEMENT, fixtureConnector } from './helpers/tier-fixtures.ts';
import { ownerLocalMint } from './helpers/owner-local-mint.ts';
import { waitFor } from './helpers/test-clock.ts';

const TOKEN = 'split-archive-state-test';
const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const close: Array<() => void> = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill('SIGKILL'); await child.exited; }
  while (close.length) close.pop()!();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function split(options: { observeFilesystem?: boolean; preload?: string } = {}) {
  const home = mkdtempSync('/tmp/oas-');
  roots.push(home);
  mkdirSync(join(home, 'run'), { mode: 0o700 });
  const env = {
    PATH: process.env.PATH ?? '', HOME: home,
    XDG_DATA_HOME: join(home, 'd'), XDG_STATE_HOME: join(home, 's'),
    XDG_CONFIG_HOME: join(home, 'c'), XDG_RUNTIME_DIR: join(home, 'run'),
    OLYMPUS_WORKER_SCHEDULER_ENABLED: 'false', OLYMPUS_WORKER_AUTH_TOKEN: TOKEN,
    OLYMPUS_ENGINE_BACKGROUND_SOCKET: join(home, 'run', 'olympus', 'background.sock'),
    NODE_ENV: 'test',
  };
  const observer = options.observeFilesystem ? join(home, 'observe-fs.ts') : undefined;
  if (observer) {
    const setupEnv = workerSetupEnvPath({ env });
    mkdirSync(dirname(setupEnv), { recursive: true, mode: 0o700 });
    writeFileSync(setupEnv, 'OLYMPUS_SERVER_MODE=on\n', { mode: 0o600 });
    const desktop = JSON.stringify(join(import.meta.dir, '../src/core/linux-desktop-opener.ts'));
    const sqlTrace = JSON.stringify(join(import.meta.dir, '../src/workers/connector-store/main-thread-sql-trace.ts'));
    writeFileSync(observer, `
      import { mock, spyOn } from 'bun:test';
      import * as sync from 'node:fs';
      import * as asyncFs from 'node:fs/promises';
      import * as desktop from ${desktop};
      import * as sqlTrace from ${sqlTrace};
      import { isMainThread } from 'node:worker_threads';
      if (isMainThread) {
        const desktopExports = { ...desktop };
        mock.module(${desktop}, () => ({
          ...desktopExports, linuxGraphicalSessionReadinessAsync: async () => ({ ready: true }),
        }));
        const trace = { ...sqlTrace };
        mock.module(${sqlTrace}, () => ({
          ...trace,
          startSlowMainThreadSqlLog(threshold, log) {
            trace.startSlowMainThreadSqlLog(threshold, log);
            log('fixture slow SQL', { sample: 1 });
            log('fixture slow SQL', { sample: 2 });
          },
        }));
        const filenames = new Set([
          'engine-background-status.json', 'boot-progress.json', 'source-status-snapshot.json',
          'worker.env', 'reranker-status.json', 'vision.json', 'front.sql-sites.json',
          'cpu.jsonl', 'slow.jsonl',
        ]);
        function note(api, path) {
          if (typeof path !== 'string') return;
          const name = path.split('/').pop();
          if (path === '/proc/self/status') console.log('fs ' + api + ' proc-status');
          else if (name === 'status.json' && path.includes('/built-in-embedding/')) console.log('fs ' + api + ' embedding-status');
          else if (filenames.has(name)) console.log('fs ' + api + ' ' + name);
        }
        for (const api of ['readFileSync', 'statSync', 'lstatSync', 'existsSync', 'openSync', 'appendFileSync', 'writeFileSync']) {
          const original = sync[api];
          spyOn(sync, api).mockImplementation((...args) => {
            note(api, args[0]);
            return original(...args);
          });
        }
        for (const api of ['readFile', 'stat', 'open', 'appendFile', 'writeFile']) {
          const original = asyncFs[api];
          spyOn(asyncFs, api).mockImplementation(async (...args) => {
            if (api === 'readFile' || api === 'stat' || api === 'open') note(api, args[0]);
            const result = await original(...args);
            if (api === 'appendFile' || api === 'writeFile') note(api, args[0]);
            return result;
          });
        }
        // Let the long diagnostic intervals turn several times during the
        // three regular memory intervals. Keep every other timer untouched.
        const setTimer = globalThis.setInterval;
        globalThis.setInterval = (callback, ms, ...args) => {
          const caller = new Error().stack?.split('\\n')[2] ?? '';
          const cpuSamples = ms === 30000 && caller.includes('control-path-headroom.ts');
          const sqlSites = ms === 10000 && caller.includes('engine/server.ts') && String(callback).includes('sqlSites.sites()');
          return setTimer(callback, cpuSamples || sqlSites ? 2000 : ms, ...args);
        };
      }
    `);
  }
  const preloadPath = join(home, 'preload.mjs');
  if (options.preload) writeFileSync(preloadPath, options.preload);
  const spawn = (role: 'front' | 'background') => {
    const instrument = role === 'front' && observer;
    const preloads = role === 'front' ? [...(instrument ? ['--preload', instrument] : []), ...(options.preload ? ['--preload', preloadPath] : [])] : [];
    const child = Bun.spawn([process.execPath, ...preloads, join(import.meta.dir, '../src/workers/engine/server.ts')], {
      env: { ...env, OLYMPUS_WORKER_ENGINE_ROLE: role, ...(instrument ? {
        OLYMPUS_CPU_SAMPLE_LOG: join(home, 'cpu.jsonl'),
        OLYMPUS_MAIN_THREAD_SQL_LOG: join(home, 'slow.jsonl'),
        OLYMPUS_MAIN_THREAD_SQL_SITES: home,
        OLYMPUS_UPDATE_CHECK: 'off',
        OLYMPUS_SOURCE_RERANKER: 'built-in',
      } : {}) }, stdout: 'pipe', stderr: 'pipe',
    });
    children.push(child);
    let output = '';
    for (const stream of [child.stdout, child.stderr]) void (async () => {
      for await (const chunk of stream) output += new TextDecoder().decode(chunk);
    })();
    return { child, output: () => output };
  };
  const background = spawn('background');
  await waitFor(() => background.output().includes('engine background ready') || background.child.exitCode !== null, { timeoutMs: 60_000 }).catch((error) => { throw new Error(background.output(), { cause: error }); });
  expect(background.output()).toContain('engine background ready');
  const front = spawn('front');
  await waitFor(() => front.output().includes('worker listening') || front.child.exitCode !== null, { timeoutMs: 60_000 }).catch((error) => { throw new Error(front.output(), { cause: error }); });
  expect(front.output()).toContain('worker listening');
  const workerFetch = createWorkerFetch({ platform: 'linux', env });
  const origin = 'http://127.0.0.1:8010';
  const fetcher = (request: Request) => workerFetch(request);
  const read = async (path: string) => {
    const response = await workerFetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  };
  const computer = async (): Promise<ComputerDashboardMeta> => (await read('/dashboard?panel-read'))._meta[COMPUTER_META_KEY];
  return { home, env, background, front, workerFetch, origin, fetcher, read, computer };
}

test('an unchanged timed mount recheck uses no synchronous filesystem calls', async () => {
  const f = await split({ preload: `
    import * as fs from 'node:fs';
    import { mock } from 'bun:test';
    import { AsyncLocalStorage } from 'node:async_hooks';
    const scope = new AsyncLocalStorage();
    const calls = [];
    const wrapped = {};
    const spy = (name, original) => (...args) => {
      if (scope.getStore()) calls.push(name);
      return original(...args);
    };
    for (const name of ['lstatSync', 'statSync', 'existsSync', 'readFileSync', 'readdirSync', 'realpathSync']) {
      wrapped[name] = spy(name, fs[name]);
    }
    wrapped.realpathSync.native = spy('realpathSync', fs.realpathSync.native);
    mock.module('node:fs', () => ({ ...fs, ...wrapped, default: { ...fs.default, ...wrapped } }));
    scope.run(true, () => fs.existsSync('/'));
    if (calls.pop() !== 'existsSync') throw new Error('Filesystem spy did not intercept named imports');
    const interval = globalThis.setInterval;
    globalThis.setInterval = (callback, ms, ...args) => interval(
      callback.name === 'recheckFrontMounts'
        ? () => scope.run(true, async () => {
            await callback();
            console.log('mount tick fs calls: ' + JSON.stringify(calls));
          })
        : callback,
      ms,
      ...args,
    );
  ` });
  await waitFor(() => (f.front.output().match(/mount tick fs calls:/g)?.length ?? 0) >= 2, { timeoutMs: 10_000 });
  for (const tick of f.front.output().match(/mount tick fs calls: .*$/gm) ?? []) {
    expect(tick).toBe('mount tick fs calls: []');
  }
}, 120_000);

async function writeWhatsAppStore(env: Record<string, string>, word: string, keepOpen = false) {
  const store = createWhatsAppConnectorStore(env);
  const lane = createWhatsAppTierLane({ store, env });
  const closeStore = () => { store.close(); lane.ledger.close(); };
  close.push(closeStore);
  const fixture = fixtureConnector(() => [{ id: word, name: `${word}.txt`, text: `${word} harbour log`, legacyDomain: 'secure_local' }]);
  const item = await fixture.fetchItem(`personal:${word}`);
  item.identity = { ...item.identity, family: 'chat', provider: 'whatsapp', providerConversationId: 'synthetic-chat' };
  await store.syncFromConnector({ ...fixture, family: 'chat', async *listItems() { yield { items: [item], done: true }; }, fetchItem: async () => item }, { fetchContent: true, placement: FIXTURE_PLACEMENT });
  if (!keepOpen) close.pop()!();
}

async function searchWhatsApp(f: Awaited<ReturnType<typeof split>>, word: string) {
  const response = await f.workerFetch(`${f.origin}/v1/source/index/search`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: word, corpus_id: WHATSAPP_LIVE_CORPUS_ID, retrieval_mode: 'keyword', max_results: 5 }),
  });
  const body = await response.json() as { hits?: Array<{ sourceItem: { providerItemId: string } }> };
  return response.ok && body.hits?.some((hit) => hit.sourceItem.providerItemId === word) ? body : undefined;
}

test('a source absent at boot is mounted and searchable without a handle change', async () => {
  const f = await split();
  await writeWhatsAppStore(f.env, 'orchard');
  expect(await waitFor(() => searchWhatsApp(f, 'orchard'), { timeoutMs: 20_000 })).toBeDefined();
  expect(f.front.output()).not.toContain('FrontStoreWriteError');
}, 180_000);

test('a failed source mount is reported and retried after five minutes without a file change', async () => {
  const f = await split({ preload: `
    import { readFileSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    import { AsyncLocalStorage } from 'node:async_hooks';
    import { mock } from 'bun:test';
    import * as whatsapp from ${JSON.stringify(import.meta.resolve('../src/workers/whatsapp/index.ts'))};
    import * as probe from ${JSON.stringify(import.meta.resolve('../src/workers/engine/runtime/front-mount-changes.ts'))};
    const time = new AsyncLocalStorage();
    const realNow = Date.now;
    const start = realNow();
    const control = join(process.env.HOME, 'mount-clock');
    const openStore = whatsapp.createWhatsAppConnectorStore;
    const createProbe = probe.createFrontMountChanges;
    Date.now = () => time.getStore() ?? realNow();
    mock.module(${JSON.stringify(import.meta.resolve('../src/workers/whatsapp/index.ts'))}, () => ({
      ...whatsapp,
      createWhatsAppConnectorStore: (...args) => {
        if (time.getStore() === start) throw new Error('Store temporarily busy.');
        return openStore(...args);
      },
    }));
    mock.module(${JSON.stringify(import.meta.resolve('../src/workers/engine/runtime/front-mount-changes.ts'))}, () => ({
      createFrontMountChanges: () => {
        const read = createProbe();
        return async (...args) => {
          const changed = await read(...args);
          if (time.getStore() !== undefined) console.log('source signature changed: ' + changed.has(whatsapp.WHATSAPP_PERSONAL_SOURCE_ID));
          return changed;
        };
      },
    }));
    const interval = globalThis.setInterval;
    let last;
    globalThis.setInterval = (callback, ms, ...args) => interval(
      callback.name === 'recheckFrontMounts'
        ? async () => {
            if (!existsSync(control)) return;
            const elapsed = Number(readFileSync(control, 'utf8'));
            if (elapsed === last) return;
            last = elapsed;
            await time.run(start + elapsed, callback);
            console.log('mount tick completed: ' + elapsed);
          }
        : callback,
      ms,
      ...args,
    );
  ` });
  expect((await f.read('/v1/health')).mount_problems).toBeUndefined();
  await writeWhatsAppStore(f.env, 'orchard', true);
  const tick = async (elapsed: number) => {
    const control = join(f.home, 'mount-clock');
    writeFileSync(control + '.tmp', String(elapsed));
    renameSync(control + '.tmp', control);
    await waitFor(() => f.front.output().includes(`mount tick completed: ${elapsed}\n`), { timeoutMs: 10_000 });
  };
  await tick(0);
  expect((await f.read('/v1/health')).mount_problems).toEqual({ [WHATSAPP_PERSONAL_SOURCE_ID]: 'Store temporarily busy.' });
  expect(await searchWhatsApp(f, 'orchard')).toBeUndefined();

  await tick(299_999);
  expect(f.front.output().match(/source signature changed: .*$/gm)).toEqual([
    'source signature changed: true', 'source signature changed: false',
  ]);
  expect((await f.read('/v1/health')).mount_problems?.[WHATSAPP_PERSONAL_SOURCE_ID]).toBe('Store temporarily busy.');
  await tick(300_000);
  expect(await searchWhatsApp(f, 'orchard')).toBeDefined();
  expect((await f.read('/v1/health')).mount_problems).toBeUndefined();
}, 120_000);

test('snapshot collection and archive resume leave a front upload intact between chunks', async () => {
  const f = await split();
  const minted = await ownerLocalMint(f.fetcher, f.origin, TOKEN);
  expect(minted.status).toBe(200);
  const headers = {
    Origin: f.origin, Cookie: minted.headers.get('Set-Cookie')!.split(';')[0]!,
    'X-Olympus-CSRF': (await minted.json() as { csrf_token: string }).csrf_token,
  };
  const started = await f.workerFetch(`${f.origin}/dashboard/archive-import/upload-start`, { method: 'POST', headers, body: '{}' });
  expect(started.status).toBe(200);
  const { upload_id: id } = await started.json() as { upload_id: string };
  const dir = join(archiveStateSiblingPath(defaultArchiveImportStatePath(f.env), 'archive-staging'), id);
  const send = async (offset: number, final: boolean, text: string) => f.workerFetch(`${f.origin}/dashboard/archive-import/upload-file`, {
    method: 'POST', headers: { ...headers, 'X-Olympus-Upload-Id': id, 'X-Olympus-Upload-Path': 'Takeout.mbox', 'X-Olympus-Upload-Offset': String(offset), 'X-Olympus-Upload-Final': final ? '1' : '0' }, body: text,
  });
  expect((await send(0, false, 'abc')).status).toBe(200);
  const before = readEngineStatusSnapshot(engineStatusSnapshotPath(f.env))!.snapshot.written_at;
  await waitFor(() => readEngineStatusSnapshot(engineStatusSnapshotPath(f.env))?.snapshot.written_at !== before, { timeoutMs: 10_000 });
  expect(existsSync(dir)).toBe(true);
  expect((await send(3, true, 'def')).status).toBe(200);
  const client = new EngineCommandClient({ fetch: createUnixSocketFetch(f.env.OLYMPUS_ENGINE_BACKGROUND_SOCKET), authToken: TOKEN });
  expect((await client.send({ kind: 'archive_changed' })).state).toBe('done');
  expect(existsSync(dir)).toBe(true);
  const snapshot = readEngineStatusSnapshot(engineStatusSnapshotPath(f.env))!;
  expect(snapshot.snapshot).not.toHaveProperty('archive');
}, 120_000);

test('the front reads changed archive state, requests and ledger counts while a fresh snapshot stays fixed', async () => {
  const f = await split();
  // Stop the publisher, retaining a fresh snapshot with the former archive
  // payload. A current old-engine snapshot must never mask direct reads.
  f.background.child.kill('SIGKILL');
  await f.background.child.exited;
  const snapshotPath = engineStatusSnapshotPath(f.env);
  const snapshot = readEngineStatusSnapshot(snapshotPath)!.snapshot;
  writeEngineStatusSnapshot(snapshotPath, { ...snapshot, written_at: new Date().toISOString(), archive: { view: { archives: [], requests: [], privateModel: 'off' }, cards: [], sources: [], source_imports: [] } } as typeof snapshot);
  const fixed = readEngineStatusSnapshot(snapshotPath)!.snapshot.written_at;
  expect((await f.computer()).archives!.archives).toHaveLength(0);
  const runtime = createArchiveImportRuntime({ env: f.env });
  close.push(() => {
    for (const lane of runtime.existingLanes()) { for (const store of lane.set.openStores()) store.close(); lane.ledger.close(); }
  });
  const file = join(f.home, 'Takeout.mbox');
  writeFileSync(file, 'From sam@example.invalid Mon Jan 5 10:00:00 2015\nFrom: Sam <sam@example.invalid>\nTo: Alex <alex@example.invalid>\nSubject: Lighthouse rota\nMessage-ID: <one@example.invalid>\n\nThe lighthouse keeper rota.\n\n');
  const started = runtime.start(file);
  expect(started.kind).toBe('started');
  if (started.kind !== 'started') throw new Error(started.kind);
  const id = started.archive.archive_id;
  const requests = new ArchiveImportRequestStore({ path: archiveImportRequestsPath(runtime.state.path) });
  const request = requests.addPending(join(f.home, 'another.mbox'))!;
  expect((await f.computer()).archives!.requests[0]).toMatchObject({ id: request.request_id });
  requests.remove(request.request_id);
  expect((await f.computer()).archives!.requests).toHaveLength(0);
  expect((await f.computer()).archives!.archives[0]).toMatchObject({ id, status: 'importing' });
  const lane = runtime.lane('email');
  await pullArchiveImport({ state: runtime.state, lane, archiveId: id });
  const counted = (judged: number) => waitFor(async () => {
    const entry = (await f.computer()).archives!.archives[0];
    return entry?.items === 1 && entry.judged === judged ? entry : undefined;
  });
  expect(await counted(0)).toMatchObject({ id, status: 'imported', items: 1, judged: 0, held: 1 });
  const record = lane.ledger.listPending()[0]!;
  lane.ledger.recordDecision({ provider: record.provider, accountScope: record.accountScope, providerItemId: record.providerItemId }, { metadataTier: 'secure', contentTier: 'secure', decidedBy: 'sniffer', reasons: ['content:judged'], state: 'current', contentRead: true, metadataPending: false, contentPending: false, metadataForced: false, metadataFlagged: false, engineVersion: 'fixture', mapRevision: 'fixture', snifferId: 'fixture' });
  expect(await counted(1)).toMatchObject({ items: 1, judged: 1, held: 0 });
  expect(readEngineStatusSnapshot(snapshotPath)!.snapshot.written_at).toBe(fixed);
}, 120_000);

test('the idle front uses no synchronous filesystem calls on the moved timer paths', async () => {
  const f = await split({ observeFilesystem: true });
  const start = f.front.output().length;
  const idleLog = () => f.front.output().slice(start);
  const count = (line: string, log = idleLog()) => log.split('\n').filter(entry => entry === line).length;
  // No HTTP requests during this window. Require proof each timer fired,
  // including the desktop probe against a synthetic ready session.
  const timers = [
    'fs open engine-background-status.json', 'fs readFile proc-status', 'fs open worker.env',
    'fs writeFile front.sql-sites.json', 'fs appendFile cpu.jsonl',
  ];
  await waitFor(() => timers.every(line => count(line) >= 3), { timeoutMs: 25_000 }).catch((error) => {
    const calls = idleLog().split('\n').filter(line => line.startsWith('fs '));
    throw new Error(JSON.stringify(Object.fromEntries([...new Set([...timers, ...calls])].map(line => [line, count(line)]))), { cause: error });
  });
  expect(idleLog()).not.toMatch(/^fs \w+Sync /m);

  expect(count('fs appendFile slow.jsonl', f.front.output())).toBeGreaterThanOrEqual(2);
  expect(f.front.output()).not.toMatch(/^fs appendFileSync slow\.jsonl$/m);
  const slow = readFileSync(join(f.home, 'slow.jsonl'), 'utf8').trimEnd().split('\n');
  expect(slow.slice(0, 2).map(line => JSON.parse(line).sample)).toEqual([1, 2]);

  const requestStart = f.front.output().length;
  expect(await f.read('/v1/health')).toMatchObject({ engine_background: 'ready' });
  await f.computer();
  const requestLog = () => f.front.output().slice(requestStart);
  await waitFor(() => requestLog().includes('fs readFile boot-progress.json')
    && requestLog().includes('fs stat source-status-snapshot.json')
    && requestLog().includes('fs readFile reranker-status.json')
    && requestLog().includes('fs readFile embedding-status'));
  const progressPath = sharedDataPath('boot-progress', f.env);
  const boot = JSON.parse(readFileSync(progressPath, 'utf8'));
  writeFileSync(progressPath, JSON.stringify({ ...boot, pid: 2_147_483_647 }));
  expect(await f.read('/v1/health')).toMatchObject({ engine_background: 'unreachable' });
  writeFileSync(progressPath, '{');
  expect(await f.read('/v1/health')).toMatchObject({ engine_background: 'unreachable' });
  expect(requestLog()).not.toMatch(/^fs \w+Sync /m);
}, 90_000);

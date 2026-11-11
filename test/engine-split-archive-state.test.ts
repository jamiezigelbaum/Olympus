// Regressions for #1324: stores and archive files written after a split front
// boots must be visible there, and the background must leave its uploads alone.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkerFetch, createUnixSocketFetch } from '../src/core/worker-transport.ts';
import { createArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { archiveStateSiblingPath } from '../src/core/olympus-layout.ts';
import { defaultArchiveImportStatePath } from '../src/workers/archive-import/state.ts';
import { pullArchiveImport } from '../src/workers/archive-import/sync.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { createWhatsAppConnectorStore, createWhatsAppTierLane, WHATSAPP_LIVE_CORPUS_ID } from '../src/workers/whatsapp/index.ts';
import { EngineCommandClient } from '../src/workers/engine-split/client.ts';
import { ArchiveImportRequestStore, archiveImportRequestsPath } from '../src/workers/archive-import/requests.ts';
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

async function split() {
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
  const spawn = (role: 'front' | 'background') => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/workers/email-source/server.ts')], {
      env: { ...env, OLYMPUS_WORKER_ENGINE_ROLE: role }, stdout: 'pipe', stderr: 'pipe',
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

test('a source absent at boot is mounted and searchable without a handle change', async () => {
  const f = await split();
  const writeStore = async (word: string) => {
    const store = createWhatsAppConnectorStore(f.env);
    const lane = createWhatsAppTierLane({ store, env: f.env });
    const fixture = fixtureConnector(() => [{ id: word, name: `${word}.txt`, text: `${word} harbour log`, legacyDomain: 'secure_local' }]);
    const item = await fixture.fetchItem(`personal:${word}`);
    item.identity = { ...item.identity, family: 'chat', provider: 'whatsapp', providerConversationId: 'synthetic-chat' };
    await store.syncFromConnector({ ...fixture, family: 'chat', async *listItems() { yield { items: [item], done: true }; }, fetchItem: async () => item }, { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const path = store.dbPath;
    store.close();
    lane.ledger.close();
    return path;
  };
  const search = async (word: string) => {
    const response = await f.workerFetch(`${f.origin}/v1/source/index/search`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: word, corpus_id: WHATSAPP_LIVE_CORPUS_ID, retrieval_mode: 'keyword', max_results: 5 }),
    });
    const body = await response.json() as { hits?: Array<{ sourceItem: { providerItemId: string } }> };
    return response.ok && body.hits?.some((hit) => hit.sourceItem.providerItemId === word) ? body : undefined;
  };
  await writeStore('orchard');
  expect(await waitFor(() => search('orchard'), { timeoutMs: 20_000 })).toBeDefined();
  expect(f.front.output()).not.toContain('FrontStoreWriteError');
}, 180_000);

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

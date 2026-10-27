// The source storage system end to end, the way an install meets it
// (docs/design/source-storage.md): a real worker on isolated homes, with the
// boot migration on by default.
//
// (a) A fresh install: every source's account lands in its folder, and
//     nothing is made at a legacy place.
// (b) An install a pre-folder build left (stores of every source, Telegram's
//     session, gateway state and spool, WhatsApp's bridge state, local files'
//     watch snapshots, X's reconcile state, imported archives): the worker's
//     boot pass moves every account into its folder, the worker listens,
//     status and search read the moved stores, and a per-source Delete
//     removes exactly that account's folder and its rows in the shared files.
//
// Spawning tests carry an explicit timeout (test/spawn-timeout-guard.test.ts).

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  FOLDER_LAYOUT_SOURCES,
  accountFolder,
  accountFolderEntry,
  accountRawPath,
  accountStoreNames,
  legacyAccountFiles,
  legacyAccountPaths,
  olympusDataRoot,
  sharedDataPath,
  type AccountRawName,
} from '../src/core/olympus-layout.ts';
import { resolvedStorePath } from '../src/core/source-placement.ts';
import { readSourceRegistry } from '../src/core/source-registry.ts';
import { createWorkerFetch } from '../src/core/worker-transport.ts';
import { deleteOlympusData } from '../src/data-lifecycle.ts';
import { archiveConnectorStoreDbPath } from '../src/workers/archive-import/store.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, snapshotStore, type FixtureSpec } from './helpers/tier-fixtures.ts';
import { MINE, OTHER, SEEDED_FOR_MINE, seedAllFiles, seedTierLedgerBeside, type ForgetLayout } from './helpers/forget-seeds.ts';

const SERVER = join(import.meta.dir, '..', 'src', 'workers', 'email-source', 'server.ts');
const REPO = join(import.meta.dir, '..');
const TOKEN = 'e2e-worker-token-0123456789abcdef0123456789abcdef';

const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Env = Record<string, string>;

function freshHome(): Env {
  const home = mkdtempSync(join(tmpdir(), 'olympus-storage-e2e-'));
  roots.push(home);
  mkdirSync(join(home, 'run'), { mode: 0o700 });
  return {
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_RUNTIME_DIR: join(home, 'run'),
  };
}

interface Booted {
  port: number;
  output: () => string;
  errors: () => string;
  exitCode: () => number | null;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/** The real worker on `env`, up once it listens (or once it says why it will not). */
async function boot(env: Env): Promise<Booted> {
  for (const name of readdirSync(env.XDG_RUNTIME_DIR!)) rmSync(join(env.XDG_RUNTIME_DIR!, name), { recursive: true, force: true });
  const port = await freePort();
  const child = Bun.spawn([process.execPath, SERVER], {
    env: { PATH: process.env.PATH ?? '', ...env, OLYMPUS_EMAIL_SOURCE_PORT: String(port), OLYMPUS_WORKER_AUTH_TOKEN: TOKEN },
    cwd: REPO,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(child);
  let output = '';
  let errors = '';
  const collect = (stream: ReadableStream<Uint8Array>, add: (text: string) => void): void => {
    void (async () => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        add(decoder.decode(value));
      }
    })();
  };
  collect(child.stdout as ReadableStream<Uint8Array>, (text) => { output += text; });
  collect(child.stderr as ReadableStream<Uint8Array>, (text) => { errors += text; });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !output.includes('worker listening') && child.exitCode === null) await Bun.sleep(100);
  await Bun.sleep(500);
  return {
    port,
    output: () => output,
    errors: () => errors,
    exitCode: () => child.exitCode,
    stop: async () => {
      child.kill('SIGTERM');
      const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
      if (!exited) {
        child.kill('SIGKILL');
        await child.exited;
      }
    },
  };
}

/** A POST to the running worker, over its owner socket on Linux. */
async function ask(env: Env, worker: Booted, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const fetchWorker = createWorkerFetch({ env });
  const response = await fetchWorker(`http://127.0.0.1:${worker.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, unknown> };
}

const listening = (worker: Booted): string =>
  `the worker did not listen (exit ${worker.exitCode()}): ${worker.errors().slice(-3000)}\n${worker.output().slice(-2000)}`;

/** Every file under `root`, relative to it, but SQLite's -wal and -shm (a reader makes and folds them). */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (!/-(?:wal|shm)$/.test(entry.name)) out.push(rel);
    }
  };
  if (existsSync(root)) walk(root, '');
  return out.sort();
}

/** Whether any of a source's legacy places holds anything. */
function legacyLeft(sourceId: string, env: Env): string[] {
  const { stores, raw } = legacyAccountPaths(sourceId, env, ['email']);
  return [...stores, ...stores.map((store) => tierLedgerPathForStore(store)), ...raw].filter((path) => existsSync(path));
}

const SPECS: FixtureSpec[] = [
  { id: 'plan', name: 'orchard-plan.txt', text: 'Orchard pruning plan for the apple trees this winter.' },
  { id: 'lab', name: 'orchard-lab.txt', text: 'Orchard lab panel notes kept in the private store.', legacyDomain: 'secure_local' },
];

/** A store with content, as the connector wrote it, at `path`. */
async function writeStore(path: string, corpusId: string, family: 'file' | 'email' | 'readwise' | 'x', trustDomain: 'internal' | 'secure_local'): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const store = new LocalConnectorStore({ dbPath: path, corpusId, family, trustDomain });
  try {
    await store.syncFromConnector({ ...fixtureConnector(() => SPECS), family }, { fetchContent: true, placement: FIXTURE_PLACEMENT });
  } finally {
    store.close();
  }
}

function sqlite(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
  db.query('INSERT INTO t VALUES (?)').run(path);
  db.close();
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The legacy place of one of a source's files, as `legacyAccountFiles` names it. */
function legacyOf(sourceId: string, env: Env, name: string, families: string[] = []): string {
  const file = legacyAccountFiles(sourceId, env, families).find((candidate) => candidate.name === name);
  if (!file) throw new Error(`${sourceId} has no legacy file ${name}`);
  return file.legacy;
}

/** Every source as a pre-folder build left it. Returns the stores that hold searchable content. */
async function seedPreFolderInstall(env: Env): Promise<Record<string, string>> {
  const stores: Record<string, string> = {
    'dropbox.files': legacyOf('dropbox.files', env, 'secure_local'),
    'dropbox.files/internal': legacyOf('dropbox.files', env, 'internal'),
    'gmail.email': legacyOf('gmail.email', env, 'internal'),
    'google_drive.docs': legacyOf('google_drive.docs', env, 'internal'),
    'local.files': legacyOf('local.files', env, 'secure_local'),
    'readwise.library': legacyOf('readwise.library', env, 'internal'),
    'x.bookmarks': legacyOf('x.bookmarks', env, 'internal'),
  };
  await writeStore(stores['dropbox.files']!, 'secure_local.dropbox.files', 'file', 'secure_local');
  await writeStore(stores['dropbox.files/internal']!, 'internal.dropbox.files', 'file', 'internal');
  await writeStore(stores['gmail.email']!, 'internal.email', 'email', 'internal');
  await writeStore(stores['google_drive.docs']!, 'internal.drive.docs', 'file', 'internal');
  await writeStore(stores['local.files']!, 'secure_local.local.files', 'file', 'secure_local');
  await writeStore(stores['readwise.library']!, 'internal.readwise.library', 'readwise', 'internal');
  await writeStore(stores['x.bookmarks']!, 'internal.x.bookmarks', 'x', 'internal');
  // Raw state outside the stores.
  put(join(legacyOf('local.files', env, 'watch'), 'snapshot.json'), '{"roots":[]}');
  sqlite(legacyOf('x.bookmarks', env, 'x-reconcile.sqlite'));
  // An imported archive: its record and its family's store.
  put(legacyOf('archive.imports', env, 'archive-imports.json', ['email']), '{"version":1,"archives":[]}\n');
  await writeStore(legacyOf('archive.imports', env, 'email.secure_local', ['email']), 'secure_local.archive.email', 'email', 'secure_local');
  // Telegram: stores, login, gateway state, spool (no grant: a session at the default place).
  sqlite(legacyOf('telegram.messages', env, 'internal'));
  sqlite(legacyOf('telegram.messages', env, 'secure_local'));
  for (const file of legacyAccountFiles('telegram.messages', env)) {
    if (file.area !== 'raw' || existsSync(file.legacy)) continue;
    if (file.rawKind === 'dir') put(join(file.legacy, 'state.json'), '{"cursor":7}');
    else if (file.rawKind === 'db') sqlite(file.legacy);
    else put(file.legacy, 'telegram');
  }
  // WhatsApp: the bridge's state folder (session, spool, media) with its stores in it.
  sqlite(legacyOf('whatsapp.personal.messages', env, 'secure_local'));
  sqlite(legacyOf('whatsapp.personal.messages', env, 'internal'));
  for (const file of legacyAccountFiles('whatsapp.personal.messages', env)) {
    if (file.area !== 'raw') continue;
    if (file.rawKind === 'dir') {
      sqlite(join(file.legacy, 'session.db'));
      put(join(file.legacy, 'spool', '2026-10-24.jsonl'), '{"id":"M1"}\n');
      put(join(file.legacy, 'media', 'audio', 'voice.ogg'), 'OggS');
    }
  }
  return stores;
}

describe('source storage, end to end on this host', () => {
  test('a fresh install: every source lands in its folder and nothing is made at a legacy place', async () => {
    const env = freshHome();
    const worker = await boot(env);
    try {
      expect(worker.output(), listening(worker)).toContain('worker listening');
      const status = await ask(env, worker, '/v1/source/index/status', {});
      expect(status.status, JSON.stringify(status.json).slice(0, 500)).toBe(200);
    } finally {
      await worker.stop();
    }
    for (const sourceId of FOLDER_LAYOUT_SOURCES) {
      expect(legacyLeft(sourceId, env), sourceId).toEqual([]);
      const names = sourceId === 'archive.imports' ? ['email.secure_local'] : accountStoreNames(sourceId);
      for (const name of names) {
        const path = sourceId === 'archive.imports' ? archiveConnectorStoreDbPath('secure_local', 'email', env) : resolvedStorePath(sourceId, name, env);
        expect(path, `${sourceId} ${name}`).toBe(join(accountFolder({ source_id: sourceId, slot: '1' }, env), 'stores', `${name}.sqlite`));
      }
    }
    // Whatever the worker made in the data folder sits in an account folder or is a shared file.
    const made = filesUnder(olympusDataRoot(env)).filter((path) => /connector-store|\.tier-ledger/.test(path));
    expect(made.filter((path) => !path.startsWith('sources/')), made.join('\n')).toEqual([]);
    for (const account of readSourceRegistry(env).accounts) expect(account.layout, account.source_id).toBe('folder');
  }, 180_000);

  test('a pre-folder install: the boot moves every account, the worker serves the moved stores, and Delete takes exactly one folder and its rows', async () => {
    const env = freshHome();
    const stores = await seedPreFolderInstall(env);
    const items = Object.fromEntries(Object.entries(stores).map(([key, path]) => [key, snapshotStore(path).items.length]));
    const layout: ForgetLayout = { env, handleRegistryPath: join(env.XDG_CONFIG_HOME!, 'olympus', 'handles.json') };
    seedAllFiles(layout);
    // The deleted source's Secrets redaction claims name its tier ledger by id, as the seeds give it.
    seedTierLedgerBeside(stores['dropbox.files']!, MINE);
    // Olympus keeps its settings folder owner-only and its parent not group-writable (the secret store refuses
    // anything else); the seeds' writers make them with the process's umask.
    chmodSync(env.XDG_CONFIG_HOME!, 0o755);
    chmodSync(join(env.XDG_CONFIG_HOME!, 'olympus'), 0o700);
    const shared = Object.fromEntries(SEEDED_FOR_MINE.map((file) => [file.stepId, { mine: file.left(layout, MINE), other: file.left(layout, OTHER) }]));

    const telegram = { source_id: 'telegram.messages', slot: '1', layout: 'folder' } as const;
    const telegramTargets = legacyAccountFiles('telegram.messages', env)
      .filter((file) => file.area === 'raw')
      .map((file) => (file.folderPath ? accountFolderEntry(telegram, file.folderPath, env) : accountRawPath(telegram, file.name as AccountRawName, env)));
    expect(telegramTargets.length).toBeGreaterThan(2);
    const first = await boot(env);
    try {
      const output = first.output();
      expect(output, listening(first)).toContain('worker listening');
      for (const sourceId of FOLDER_LAYOUT_SOURCES) {
        expect(output, `${sourceId}\n${output.slice(0, 4000)}`).toContain(`[storage] ${sourceId} moved into its account folder.`);
      }
      const status = await ask(env, first, '/v1/source/index/status', {});
      expect(status.status, JSON.stringify(status.json).slice(0, 500)).toBe(200);
      const search = await ask(env, first, '/v1/source/index/search', { query: 'orchard pruning plan', corpus_id: 'internal.email' });
      expect(search.status, JSON.stringify(search.json).slice(0, 800)).toBe(200);
      expect(JSON.stringify(search.json)).toContain('orchard');
    } finally {
      await first.stop();
    }

    // The raw state arrived in each folder, not only left its old place.
    const arrived = (sourceId: string, rel: string): string => join(accountFolder({ source_id: sourceId, slot: '1' }, env), rel);
    for (const [sourceId, rel] of [
      ['local.files', 'raw/watch/snapshot.json'],
      ['x.bookmarks', 'raw/x-reconcile.sqlite'],
      ['archive.imports', 'raw/archive-imports.json'],
      ['archive.imports', 'stores/email.secure_local.sqlite'],
      ['telegram.messages', 'stores/internal.sqlite'],
      ['telegram.messages', 'stores/secure_local.sqlite'],
      ['whatsapp.personal.messages', 'stores/secure_local.sqlite'],
      ['whatsapp.personal.messages', 'stores/internal.sqlite'],
      ['whatsapp.personal.messages', 'raw/whatsapp/session.db'],
      ['whatsapp.personal.messages', 'raw/whatsapp/spool/2026-10-24.jsonl'],
      ['whatsapp.personal.messages', 'raw/whatsapp/media/audio/voice.ogg'],
    ] as const) expect(existsSync(arrived(sourceId, rel)), `${sourceId} ${rel}`).toBe(true);
    // Every Telegram raw file the legacy layout names is in the folder under the name the layout gives it.
    for (const to of telegramTargets) expect(existsSync(to), to).toBe(true);
    expect(readFileSync(arrived('whatsapp.personal.messages', 'raw/whatsapp/spool/2026-10-24.jsonl'), 'utf8')).toBe('{"id":"M1"}\n');

    // Every account in its folder; nothing left at a legacy place.
    for (const sourceId of FOLDER_LAYOUT_SOURCES) {
      expect(legacyLeft(sourceId, env), sourceId).toEqual([]);
      expect(lstatSync(accountFolder({ source_id: sourceId, slot: '1' }, env)).isDirectory(), sourceId).toBe(true);
    }
    for (const [key, count] of Object.entries(items)) {
      const [sourceId, tier] = key.includes('/') ? key.split('/') : [key, undefined];
      const name = tier ?? (['dropbox.files', 'local.files'].includes(sourceId!) ? 'secure_local' : 'internal');
      expect(snapshotStore(resolvedStorePath(sourceId!, name, env)).items.length, key).toBe(count);
    }
    const registry = readSourceRegistry(env);
    for (const sourceId of FOLDER_LAYOUT_SOURCES) {
      expect(registry.accounts.find((account) => account.source_id === sourceId), sourceId).toMatchObject({ layout: 'folder', state: 'active' });
    }

    // Delete one source (the worker stopped: the CLI's path), then the next boot removes it.
    const before = Object.fromEntries(FOLDER_LAYOUT_SOURCES.map((sourceId) => [sourceId, filesUnder(accountFolder({ source_id: sourceId, slot: '1' }, env))]));
    const mineFolder = accountFolder({ source_id: MINE.source_id, slot: '1' }, env);
    const mineStore = resolvedStorePath(MINE.source_id, 'secure_local', env);
    const mineInode = lstatSync(mineStore).ino;
    deleteOlympusData({ sourceId: MINE.source_id, homeDir: env.HOME!, env });
    // With no worker running, the delete takes the folder at once.
    expect(existsSync(mineFolder)).toBe(false);
    const second = await boot(env);
    try {
      expect(second.output(), listening(second)).toContain('worker listening');
    } finally {
      await second.stop();
    }
    // The next worker may mount the source's lane again: that is a new, empty account, never the deleted files.
    if (existsSync(mineStore)) {
      expect(lstatSync(mineStore).ino).not.toBe(mineInode);
      expect(snapshotStore(mineStore).items.length).toBe(0);
    }
    for (const sourceId of FOLDER_LAYOUT_SOURCES.filter((id) => id !== MINE.source_id)) {
      expect(filesUnder(accountFolder({ source_id: sourceId, slot: '1' }, env)), sourceId).toEqual(expect.arrayContaining(before[sourceId]!));
    }
    for (const file of SEEDED_FOR_MINE) {
      expect(file.left(layout, MINE), `${file.stepId}: the deleted source's rows`).toBe(0);
      expect(file.left(layout, OTHER), `${file.stepId}: another source's rows`).toBe(shared[file.stepId]!.other);
    }
    expect(shared[SEEDED_FOR_MINE[0]!.stepId]!.mine).toBeGreaterThan(0);
    expect(existsSync(sharedDataPath('registry', env))).toBe(true);
    const entry = JSON.parse(readFileSync(sharedDataPath('registry', env), 'utf8')).accounts
      .find((account: { source_id: string; migration?: unknown }) => account.source_id === MINE.source_id);
    // Gone, or a new account the next worker recorded: never the moved one.
    expect(entry?.migration).toBeUndefined();
  }, 300_000);
});

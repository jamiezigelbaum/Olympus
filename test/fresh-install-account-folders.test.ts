// A fresh install puts its accounts in folders from the start (docs/design/
// source-storage.md, delivery step 4a): the worker boots on an empty home, and
// every source it connects (here with fakes) writes only under
// `sources/<source_id>/1/`. Disconnected sources create no stores. Spawning
// tests carry an explicit timeout (test/spawn-timeout-guard.test.ts).

import { resolvedStorePath } from '../src/core/source-placement.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { archiveImportFamilies } from '../src/core/archive-formats.ts';
import { accountFolder, olympusDataRoot } from '../src/core/olympus-layout.ts';
import { readSourceRegistry, sourceRegistryPath } from '../src/core/source-registry.ts';
import { __sourceStorageTestHooks, enableSourceRegistryAdoption, openConnectorStore } from '../src/core/source-storage.ts';
import { defaultArchiveImportStatePath, ArchiveImportStateStore } from '../src/workers/archive-import/state.ts';
import { createArchiveConnectorStore } from '../src/workers/archive-import/store.ts';
import { upsertConnectedHandle, type ConnectedCredentialHandle } from '../src/workers/credential-broker/connected-handles.ts';
import { connectThisComputerSource } from '../src/core/this-computer.ts';
import { FileSourceScopeAuthority } from '../src/workers/source-scope-runtime.ts';
import {
  createRefreshableReadwiseConnectorStoreRuntime,
  createXBookmarksConnectorStoreRuntime,
} from '../src/workers/email-source/server.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { defaultXBookmarksApiUsageDbPath } from '../src/workers/x-bookmarks/live-control.ts';
import { LocalXBookmarksApiUsageStore } from '../src/workers/x-bookmarks/index.ts';
import { readwiseTestTierSet, xBookmarksTestTierSet } from './helpers/lane-tier-sets.ts';

const SERVER = join(import.meta.dir, '..', 'src', 'workers', 'email-source', 'server.ts');
const REPO = join(import.meta.dir, '..');

const roots: string[] = [];
afterEach(() => {
  __sourceStorageTestHooks.disableAdoption();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshHome(): { home: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), 'olympus-fresh-folders-'));
  roots.push(home);
  // On Linux the worker listens on a Unix socket under the user session's runtime
  // directory and exits at once when that directory is missing or not private.
  mkdirSync(join(home, 'run'), { mode: 0o700 });
  return {
    home,
    env: {
      HOME: home,
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_RUNTIME_DIR: join(home, 'run'),
    },
  };
}

function everyPath(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? [path, ...everyPath(path)] : [path];
  });
}

/** SQLite's own `-wal`/`-shm` and lock files are not the question. */
const significant = (paths: string[]): string[] => paths.filter((path) => !/-(wal|shm)$/.test(path));

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

const BOOT_SOURCES = ['gmail.email', 'google_drive.docs', 'dropbox.files', 'local.files', 'telegram.messages', 'whatsapp.personal.messages'];

/** Listen before asserting storage: an absent account registry is the correct disconnected state. */
async function bootAndStop(env: Record<string, string>): Promise<void> {
  const port = await freePort();
  const child = Bun.spawn([process.execPath, SERVER], {
    env: { PATH: process.env.PATH ?? '', ...env, OLYMPUS_EMAIL_SOURCE_PORT: String(port), OLYMPUS_WORKER_SCHEDULER_ENABLED: 'false' },
    cwd: REPO,
    stdout: 'pipe',
    stderr: 'pipe',
  });
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
  collect(child.stdout, (text) => { output += text; });
  collect(child.stderr, (text) => { errors += text; });
  try {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && !output.includes('worker listening') && child.exitCode === null) await Bun.sleep(100);
    expect(output, `the worker did not listen (exit ${child.exitCode}): ${errors.slice(0, 2000)}`).toContain('worker listening');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
}

describe('a fresh install: the worker boots', () => {
  test('disconnected sources create no stores or account registry at boot', async () => {
    const { home, env } = freshHome();
    await bootAndStop(env);
    expect(existsSync(sourceRegistryPath(env))).toBe(false);
    expect(readSourceRegistry(env).accounts).toEqual([]);
    expect(everyPath(join(olympusDataRoot(env), 'sources'))).toEqual([]);
    for (const sourceId of BOOT_SOURCES) {
      const folder = accountFolder({ source_id: sourceId, slot: '1' }, env);
      expect(existsSync(folder), sourceId).toBe(false);
      for (const domain of ['internal', 'secure_local'] as const) {
        const path = resolvedStorePath(sourceId, domain, env);
        expect(path, sourceId).toBe(join(folder, 'stores', `${domain}.sqlite`));
        expect(existsSync(path), sourceId).toBe(false);
      }
    }
    expect(existsSync(join(home, '.local', 'share', 'olympus', 'whatsapp-live'))).toBe(false);
    expect(existsSync(join(home, '.local', 'share', 'olympus', 'telegram'))).toBe(false);
  }, 90_000);

  test('connected Gmail, Drive, Dropbox, local files, Telegram and WhatsApp land in their folders', async () => {
    const { home, env } = freshHome();
    const registryPath = sourceRegistryPath(env);
    const handleRegistryPath = join(home, '.config', 'olympus', 'handles.json');
    const fixtureHandles: ConnectedCredentialHandle[] = [
      { handle: 'gmail.personal', provider: 'gmail', allowedCapabilities: ['gmail.email.sync'], scopes: ['gmail.readonly'], connectedAt: '2026-10-31T00:00:00Z' },
      { handle: 'google_drive.personal', provider: 'google_drive', allowedCapabilities: ['google_drive.docs.sync'], scopes: ['drive.readonly'], connectedAt: '2026-10-31T00:00:00Z' },
      { handle: 'dropbox.personal', provider: 'dropbox', allowedCapabilities: ['dropbox.files.sync'], scopes: ['files.metadata.read', 'files.content.read'], connectedAt: '2026-10-31T00:00:00Z' },
      { handle: 'telegram.personal', provider: 'telegram', allowedCapabilities: ['telegram.messages.sync'], scopes: ['messages.read'], connectedAt: '2026-10-31T00:00:00Z' },
      { handle: 'whatsapp.personal', provider: 'whatsapp_personal', allowedCapabilities: ['whatsapp.personal.messages.sync'], scopes: ['messages.read'], connectedAt: '2026-10-31T00:00:00Z' },
    ];
    for (const handle of fixtureHandles) upsertConnectedHandle(handle, handleRegistryPath);
    connectThisComputerSource(handleRegistryPath, 'local.files');
    const folder = join(home, 'selected-notes');
    mkdirSync(folder);
    const authority = new FileSourceScopeAuthority({ registryPath: handleRegistryPath });
    const pending = authority.snapshot('local.files');
    authority.approve({
      sourceId: 'local.files', accountGeneration: pending.accountGeneration!, expectedRevision: pending.revision,
      selections: [{ key: folder, state: 'metadata_only' }], wholeAccount: false, explicitWholeAccountConfirmation: false,
    });
    await bootAndStop(env);
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as { schema: number; accounts: Array<{ source_id: string; layout: string; state: string }> };
    // The first folder account made it schema 2.
    expect(registry.schema).toBe(2);
    expect(Object.fromEntries(registry.accounts.map((account) => [account.source_id, `${account.state}:${account.layout}`]))).toEqual({
      'gmail.email': 'active:folder',
      'google_drive.docs': 'active:folder',
      'dropbox.files': 'active:folder',
      'local.files': 'active:folder',
      'telegram.messages': 'active:folder',
      'whatsapp.personal.messages': 'active:folder',
    });

    const dataRoot = olympusDataRoot(env);
    for (const sourceId of BOOT_SOURCES) {
      const stores = join(dataRoot, 'sources', sourceId, '1', 'stores');
      expect(significant(readdirSync(stores)).some((name) => /^secure_local\.sqlite$/.test(name)), sourceId).toBe(true);
    }
    // Nothing of those six, and nothing of the others yet, at the legacy paths of the data folder.
    const topLevel = readdirSync(dataRoot);
    expect(topLevel.filter((name) => /^(gmail|google-drive|dropbox-files|local-files|readwise|x-bookmarks|archive|telegram)[a-z-]*connector-store/.test(name))).toEqual([]);
    expect(topLevel).not.toContain('local-files-watch');
    // Under sources/ only the six accounts, only under slot 1, only stores.
    expect(readdirSync(join(dataRoot, 'sources')).sort()).toEqual(['dropbox.files', 'gmail.email', 'google_drive.docs', 'local.files', 'telegram.messages', 'whatsapp.personal.messages']);
    for (const path of significant(everyPath(join(dataRoot, 'sources')))) {
      const rel = relative(join(dataRoot, 'sources'), path).split('/');
      if (rel.length > 1) expect(rel[1], path).toBe('1');
      if (rel.length > 2) expect(rel[2], path).toBe('stores');
    }
    // Messaging has no files at its old places: no WhatsApp state folder, no capture folders.
    expect(existsSync(join(home, '.local', 'share', 'olympus', 'whatsapp-live'))).toBe(false);
    expect(existsSync(join(home, '.local', 'share', 'olympus', 'telegram'))).toBe(false);
    expect(statSync(join(dataRoot, 'sources', 'telegram.messages', '1', 'stores', 'internal.sqlite')).isFile()).toBe(true);
    expect(statSync(join(dataRoot, 'sources', 'whatsapp.personal.messages', '1', 'stores', 'secure_local.sqlite')).isFile()).toBe(true);
  }, 90_000);
});

describe('a fresh install: Readwise, X and an imported archive connect (with fakes)', () => {
  test('write only under their folders, keep the shared files shared, and record folder accounts', () => {
    const { env } = freshHome();
    enableSourceRegistryAdoption();
    const embeddingProvider: SourceEmbeddingProvider = {
      provider: 'test',
      modelId: 'test-embedding',
      dimension: 2,
      configHash: 'test-config',
      epochId: 'test-epoch',
      backend: 'cloud',
      async embed(inputs) { return inputs.map(() => [1, 0]); },
    };
    const xHandle: ConnectedCredentialHandle = {
      handle: 'x.bookmarks.personal',
      provider: 'x',
      accountRole: 'personal',
      providerAccountId: '42',
      allowedCapabilities: ['x.bookmarks.sync'],
      scopes: ['bookmark.read'],
      connectedAt: '2026-07-18T00:00:00.000Z',
    };

    const readwise = createRefreshableReadwiseConnectorStoreRuntime({ tierSetFor: (store) => readwiseTestTierSet(store, { embeddingProvider, env }), enabled: true, embeddingProvider, env });
    expect(readwise).toBeDefined();
    openConnectorStore({ sourceId: 'readwise.library' }, {
      dbPath: resolvedStorePath('readwise.library', 'secure_local', env),
      corpusId: 'secure_local.readwise.library',
      family: 'readwise',
      trustDomain: 'secure_local',
    }, env).close();
    // The X runtime builds its reconcile state beside the usage ledger it is given, as the worker does.
    const usage = new LocalXBookmarksApiUsageStore(defaultXBookmarksApiUsageDbPath(env));
    const x = createXBookmarksConnectorStoreRuntime({ tierSetFor: (store) => xBookmarksTestTierSet(store, { embeddingProvider, env }), enabled: true, handle: xHandle, embeddingProvider, usageStore: usage, env });
    expect(x).toBeDefined();
    const family = archiveImportFamilies()[0]!;
    createArchiveConnectorStore('secure_local', family, env).close();
    mkdirSync(join(env.HOME!, 'archive-root'), { recursive: true });
    new ArchiveImportStateStore({ path: defaultArchiveImportStatePath(env) }).create({
      format: family,
      provider: family,
      family,
      label: 'Fixture archive',
      root_path: join(env.HOME!, 'archive-root'),
      root_identity: { dev: '1', ino: '1' },
      chosen_rel_path: 'archive.zip',
      files: [],
      manifest_sha256: '0'.repeat(64),
    });
    readwise!.store.close();
    x!.store.close();
    usage.close();

    const registry = readSourceRegistry(env);
    expect(registry.schema).toBe(2);
    expect(registry.accounts.map((account) => [account.source_id, account.layout])).toEqual([
      ['readwise.library', 'folder'],
      ['x.bookmarks', 'folder'],
      ['archive.imports', 'folder'],
    ]);

    const dataRoot = olympusDataRoot(env);
    const top = readdirSync(dataRoot).filter((name) => !/-(wal|shm)$/.test(name) && !name.startsWith('registry.json')).sort();
    // The shared X quota ledger stays where it is, beside the account folders.
    expect(top).toEqual(['sources', 'x-bookmarks-api-usage.sqlite']);
    expect(significant(everyPath(join(dataRoot, 'sources', 'readwise.library', '1'))).map((path) => relative(dataRoot, path))).toEqual(
      expect.arrayContaining(['sources/readwise.library/1/stores', 'sources/readwise.library/1/stores/internal.sqlite', 'sources/readwise.library/1/stores/secure_local.sqlite']),
    );
    expect(existsSync(join(accountFolder({ source_id: 'x.bookmarks', slot: '1' }, env), 'stores', 'internal.sqlite'))).toBe(true);
    // X's reconcile state is in the account's raw/, no longer beside the usage ledger.
    expect(existsSync(join(accountFolder({ source_id: 'x.bookmarks', slot: '1' }, env), 'raw', 'x-reconcile.sqlite'))).toBe(true);
    expect(top.some((name) => name.endsWith('.reconcile'))).toBe(false);
    // The archive's stores are `<family>.<tier>.sqlite` and its state is under raw/.
    const archiveFolder = accountFolder({ source_id: 'archive.imports', slot: '1' }, env);
    expect(existsSync(join(archiveFolder, 'stores', `${family}.secure_local.sqlite`))).toBe(true);
    expect(existsSync(join(archiveFolder, 'raw', 'archive-imports.json'))).toBe(true);
    expect(sourceRegistryPath(env).startsWith(dataRoot)).toBe(true);
  });
});

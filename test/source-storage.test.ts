// The storage service (docs/design/source-storage.md, "Storage service"): an
// account being deleted, or deleted, is never opened; adoption records an
// account on its first writable open in the worker, and nowhere else.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  SourceRegistryError,
  readSourceRegistry,
  sourceRegistryPath,
  updateSourceRegistry,
  type SourceRegistryAccountState,
} from '../src/core/source-registry.ts';
import {
  SourceStorageUnavailableError,
  __sourceStorageTestHooks,
  enableSourceRegistryAdoption,
  isSourceAccountOpenable,
  openConnectorStore,
  openSecretLocations,
  openTierLedger,
  openTierSniffer,
  sourceAccountUnavailableReason,
  storageAccountForCorpus,
  storeFileOwnerLookup,
} from '../src/core/source-storage.ts';
import type { LocalConnectorStoreOptions } from '../src/workers/connector-store/local-index.ts';
import {
  parseConnectorStoreMountsFromEnv,
  sourceIndexLaneAccountDecision,
  type SourceIndexLaneDecision,
} from '../src/workers/email-source/server.ts';

let dir: string;
let env: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-source-storage-'));
  env = { HOME: dir, XDG_DATA_HOME: join(dir, 'data') };
});

afterEach(() => {
  __sourceStorageTestHooks.disableAdoption();
  rmSync(dir, { recursive: true, force: true });
});

function storeOptions(name: string, corpusId: string, extra: Partial<LocalConnectorStoreOptions> = {}): LocalConnectorStoreOptions {
  return { dbPath: join(dir, `${name}.sqlite`), corpusId, family: 'file', trustDomain: 'secure_local', ...extra };
}

function markAccount(sourceId: string, state: SourceRegistryAccountState, corpusIds: string[] = []): void {
  updateSourceRegistry(env, (registry) => {
    registry.accounts.push({ source_id: sourceId, slot: '1', state, layout: 'legacy', corpus_ids: corpusIds, created_at: new Date().toISOString() });
  });
}

describe('storage service: the open gate', () => {
  test.each(['deleting', 'deleted'] as const)('an account whose data is %s is never opened', (state) => {
    markAccount('dropbox.files', state, ['secure_local.dropbox.files']);
    const options = storeOptions('dropbox', 'secure_local.dropbox.files');
    let thrown: unknown;
    try {
      openConnectorStore({ sourceId: 'dropbox.files' }, options, env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SourceStorageUnavailableError);
    const unavailable = thrown as SourceStorageUnavailableError;
    expect(unavailable.code).toBe('source_storage_unavailable');
    expect(unavailable.state).toBe(state);
    expect(unavailable.message).toContain('dropbox.files is not available');
    expect(unavailable.message).toContain(state === 'deleting' ? 'being deleted' : 'was deleted');
    // No stand-in store: nothing was created.
    expect(existsSync(options.dbPath)).toBe(false);
    expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env)).toBe(false);
    // The read-only open is refused the same way.
    expect(() => openConnectorStore({ sourceId: 'dropbox.files' }, { ...options, readOnly: true }, env)).toThrow(SourceStorageUnavailableError);
  });

  test('an active account opens, and so does one with no entry', () => {
    markAccount('dropbox.files', 'active', ['secure_local.dropbox.files']);
    const active = openConnectorStore({ sourceId: 'dropbox.files' }, storeOptions('dropbox', 'secure_local.dropbox.files'), env);
    const unlisted = openConnectorStore({ sourceId: 'gmail.email' }, storeOptions('gmail', 'internal.email', { family: 'email', trustDomain: 'internal' }), env);
    try {
      expect(active.corpusId).toBe('secure_local.dropbox.files');
      expect(unlisted.corpusId).toBe('internal.email');
      expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env)).toBe(true);
      expect(isSourceAccountOpenable({ sourceId: 'gmail.email' }, env)).toBe(true);
    } finally {
      active.close();
      unlisted.close();
    }
  });

  test('the gate is per account: another slot, or another source, still opens', () => {
    markAccount('dropbox.files', 'deleting');
    expect(isSourceAccountOpenable({ sourceId: 'dropbox.files', slot: '2' }, env)).toBe(true);
    expect(isSourceAccountOpenable({ sourceId: 'local.files' }, env)).toBe(true);
    expect(sourceAccountUnavailableReason({ sourceId: 'dropbox.files' }, env)).toBe('its data is being deleted');
  });

  test('an unreadable registry opens nothing', () => {
    const path = sourceRegistryPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json');
    expect(() => openConnectorStore({ sourceId: 'dropbox.files' }, storeOptions('dropbox', 'secure_local.dropbox.files'), env))
      .toThrow(SourceRegistryError);
    expect(isSourceAccountOpenable({ sourceId: 'dropbox.files' }, env)).toBe(false);
    expect(sourceAccountUnavailableReason({ sourceId: 'dropbox.files' }, env)).toContain(path);
  });

  test('the sidecar openers refuse too, and open an active account', () => {
    const ledgerPath = join(dir, 'dropbox.tier-ledger.sqlite');
    const locationsPath = join(dir, 'dropbox.secret-locations.sqlite');
    const snifferPath = join(dir, 'dropbox.tier-sniffer.sqlite');
    markAccount('dropbox.files', 'deleting');
    expect(() => openTierLedger({ sourceId: 'dropbox.files' }, { dbPath: ledgerPath }, env)).toThrow(SourceStorageUnavailableError);
    expect(() => openSecretLocations({ sourceId: 'dropbox.files' }, { dbPath: locationsPath }, env)).toThrow(SourceStorageUnavailableError);
    expect(() => openTierSniffer({ sourceId: 'dropbox.files' }, { dbPath: snifferPath }, env)).toThrow(SourceStorageUnavailableError);
    expect([ledgerPath, locationsPath, snifferPath].filter((path) => existsSync(path))).toEqual([]);

    const ledger = openTierLedger({ sourceId: 'local.files' }, { dbPath: ledgerPath }, env);
    const locations = openSecretLocations({ sourceId: 'local.files' }, { dbPath: locationsPath }, env);
    const sniffer = openTierSniffer({ sourceId: 'local.files' }, { dbPath: snifferPath }, env);
    ledger.close();
    locations.close();
    sniffer.close();
    expect([ledgerPath, locationsPath, snifferPath].every((path) => existsSync(path))).toBe(true);
  });
});

describe('storage service: adoption', () => {
  test('with adoption off (CLI, scripts, tests), an open writes nothing', () => {
    const store = openConnectorStore({ sourceId: 'dropbox.files' }, storeOptions('dropbox', 'secure_local.dropbox.files'), env);
    store.close();
    expect(existsSync(sourceRegistryPath(env))).toBe(false);
  });

  test('a writable open records the account, and a second corpus extends it', () => {
    enableSourceRegistryAdoption();
    const before = Date.now();
    const secure = openConnectorStore({ sourceId: 'dropbox.files' }, storeOptions('dropbox', 'secure_local.dropbox.files'), env);
    secure.close();
    const first = readSourceRegistry(env).accounts;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      source_id: 'dropbox.files',
      slot: '1',
      state: 'active',
      layout: 'legacy',
      corpus_ids: ['secure_local.dropbox.files'],
    });
    expect(Date.parse(first[0]!.created_at)).toBeGreaterThanOrEqual(before - 1000);

    const internal = openConnectorStore(
      { sourceId: 'dropbox.files' },
      storeOptions('dropbox-internal', 'internal.dropbox.files', { trustDomain: 'internal' }),
      env,
    );
    internal.close();
    // The same corpus again changes nothing.
    openConnectorStore({ sourceId: 'dropbox.files' }, storeOptions('dropbox', 'secure_local.dropbox.files'), env).close();
    const accounts = readSourceRegistry(env).accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.corpus_ids).toEqual(['secure_local.dropbox.files', 'internal.dropbox.files']);
    expect(accounts[0]!.created_at).toBe(first[0]!.created_at);
  });

  test('a read-only open never adopts', () => {
    const options = storeOptions('dropbox', 'secure_local.dropbox.files');
    openConnectorStore({ sourceId: 'dropbox.files' }, options, env).close();
    enableSourceRegistryAdoption();
    openConnectorStore({ sourceId: 'dropbox.files' }, { ...options, readOnly: true }, env).close();
    expect(existsSync(sourceRegistryPath(env))).toBe(false);
  });

  test('the sidecar openers record nothing while adoption is off', () => {
    openTierLedger({ sourceId: 'dropbox.files' }, { dbPath: join(dir, 'ledger.sqlite') }, env).close();
    expect(existsSync(sourceRegistryPath(env))).toBe(false);
  });

  test('a sidecar opened before any store records the account with no corpus, and the store joins that entry', () => {
    enableSourceRegistryAdoption();
    const ledgerPath = join(dir, 'ledger.sqlite');
    openTierLedger({ sourceId: 'dropbox.files' }, { dbPath: ledgerPath }, env).close();
    const [placed] = readSourceRegistry(env).accounts;
    expect(placed).toMatchObject({ source_id: 'dropbox.files', slot: '1', state: 'active', layout: 'legacy', corpus_ids: [] });

    openConnectorStore({ sourceId: 'dropbox.files' }, storeOptions('dropbox', 'secure_local.dropbox.files'), env).close();
    const accounts = readSourceRegistry(env).accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ layout: 'legacy', corpus_ids: ['secure_local.dropbox.files'], created_at: placed!.created_at });
  });

  test('an in-memory sidecar records nothing', () => {
    enableSourceRegistryAdoption();
    openTierLedger({ sourceId: 'dropbox.files' }, { dbPath: ':memory:' }, env).close();
    expect(existsSync(sourceRegistryPath(env))).toBe(false);
  });
});

describe('storage service: an account named only by its corpus', () => {
  test('is the registered source, else the corpus id without its trust domain', () => {
    expect(storageAccountForCorpus({ corpusId: 'internal.email', trustDomain: 'internal' }))
      .toEqual({ sourceId: 'gmail.email' });
    expect(storageAccountForCorpus(
      { corpusId: 'secure_local.archive.chat', trustDomain: 'secure_local' },
      [{ corpusId: 'secure_local.archive.chat', sourceId: 'archive.imports' }],
    )).toEqual({ sourceId: 'archive.imports' });
    // An imported archive's corpus is archive.imports for any family, registered or not.
    expect(storageAccountForCorpus({ corpusId: 'secure_local.archive.chat', trustDomain: 'secure_local' }))
      .toEqual({ sourceId: 'archive.imports' });
    expect(storageAccountForCorpus({ corpusId: 'public_safe.archive.email', trustDomain: 'public_safe' }))
      .toEqual({ sourceId: 'archive.imports' });
    // Reflect and Roam mount by JSON with no registered corpus: the ids the data lifecycle names them by.
    expect(storageAccountForCorpus({ corpusId: 'secure_local.reflect.notes', trustDomain: 'secure_local' }))
      .toEqual({ sourceId: 'reflect.notes' });
    expect(storageAccountForCorpus({ corpusId: 'roam', trustDomain: 'internal' })).toEqual({ sourceId: 'roam' });
  });
});

describe('worker mount decisions', () => {
  const lane = (envName: string): SourceIndexLaneDecision => ({ enabled: true, envName, decidedBy: envName });

  test('an account that may not be opened is not mounted; another source mounts as usual', () => {
    markAccount('dropbox.files', 'deleting');
    const lines: string[] = [];
    const dropbox = sourceIndexLaneAccountDecision(lane('DROPBOX'), { sourceId: 'dropbox.files' }, env, (line) => lines.push(line));
    const gmail = sourceIndexLaneAccountDecision(lane('GMAIL'), { sourceId: 'gmail.email' }, env, (line) => lines.push(line));
    expect(dropbox).toEqual({ enabled: false, envName: 'DROPBOX', decidedBy: 'the source registry' });
    expect(gmail).toEqual(lane('GMAIL'));
    expect(lines).toEqual(['[storage] dropbox.files is not mounted: its data is being deleted.']);
  });

  test('a lane already switched off stays off and says nothing', () => {
    markAccount('dropbox.files', 'deleted');
    const lines: string[] = [];
    const off = { enabled: false, envName: 'DROPBOX', decidedBy: 'DROPBOX' };
    expect(sourceIndexLaneAccountDecision(off, { sourceId: 'dropbox.files' }, env, (line) => lines.push(line))).toEqual(off);
    expect(lines).toEqual([]);
  });

  test('a JSON mount of an account that may not be opened is skipped; the others mount', () => {
    const previous = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
    process.env.HOME = env.HOME;
    process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
    const failures: string[] = [];
    let mounts: ReturnType<typeof parseConnectorStoreMountsFromEnv> = [];
    try {
      markAccount('reflect.notes', 'deleting');
      mounts = parseConnectorStoreMountsFromEnv(JSON.stringify([
        { dbPath: join(dir, 'reflect-notes.sqlite'), corpusId: 'secure_local.reflect.notes', family: 'note', trustDomain: 'secure_local' },
        { dbPath: join(dir, 'roam-notes.sqlite'), corpusId: 'secure_local.roam.notes', family: 'note', trustDomain: 'secure_local' },
      ]), { reportFailure: (message) => failures.push(message) });
      expect(mounts.map((mount) => mount.store.corpusId)).toEqual(['secure_local.roam.notes']);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('secure_local.reflect.notes skipped: reflect.notes is not available: its data is being deleted.');
      expect(existsSync(join(dir, 'reflect-notes.sqlite'))).toBe(false);
    } finally {
      for (const mount of mounts) mount.store.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('a JSON mount over a withheld source\'s file, under another corpus id, opens under that source and is refused', () => {
    const dropboxSecure = join(dir, 'dropbox-files-connector-store.sqlite');
    markAccount('dropbox.files', 'deleting', ['secure_local.dropbox.files']);
    const previous = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
    process.env.HOME = env.HOME;
    process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
    try {
      const failures: string[] = [];
      const mounts = parseConnectorStoreMountsFromEnv(JSON.stringify([
        { dbPath: dropboxSecure, corpusId: 'secure_local.reflect.notes', family: 'note', trustDomain: 'secure_local' },
      ]), {
        reportFailure: (message) => failures.push(message),
        storeOwner: storeFileOwnerLookup([[dropboxSecure, 'dropbox.files']]),
      });
      expect(mounts).toEqual([]);
      expect(failures[0]).toContain('dropbox.files is not available: its data is being deleted.');
      expect(existsSync(dropboxSecure)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  test('a JSON mount over a withheld source\'s file under another spelling of its path is refused too', () => {
    const dropboxSecure = join(dir, 'dropbox-files-connector-store.sqlite');
    writeFileSync(dropboxSecure, '');
    symlinkSync(dropboxSecure, join(dir, 'alias.sqlite'));
    linkSync(dropboxSecure, join(dir, 'hard-link.sqlite'));
    markAccount('dropbox.files', 'deleting', ['secure_local.dropbox.files']);
    const previous = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
    process.env.HOME = env.HOME;
    process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
    try {
      const failures: string[] = [];
      const mounts = parseConnectorStoreMountsFromEnv(JSON.stringify([
        join(dir, '.', 'dropbox-files-connector-store.sqlite'),
        join(dir, 'alias.sqlite'),
        join(dir, 'hard-link.sqlite'),
      ].map((dbPath) => ({ dbPath, corpusId: 'secure_local.reflect.notes', family: 'note', trustDomain: 'secure_local' }))), {
        reportFailure: (message) => failures.push(message),
        storeOwner: storeFileOwnerLookup([[dropboxSecure, 'dropbox.files']]),
      });
      expect(mounts).toEqual([]);
      expect(failures).toHaveLength(3);
      for (const failure of failures) expect(failure).toContain('dropbox.files is not available: its data is being deleted.');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

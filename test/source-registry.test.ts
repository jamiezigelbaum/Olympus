// The account registry (docs/design/source-storage.md, "Registry"): a missing
// file is empty, anything unreadable fails closed, and every write goes
// through the file lease and lands whole.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileLeaseBusyError, withFileLeaseSync } from '../src/core/file-lease.ts';
import {
  SourceRegistryError,
  findRegistryAccount,
  readSourceRegistry,
  sourceAccountMovePending,
  sourceRegistryPath,
  sourceStorageNotices,
  updateSourceRegistry,
  type SourceRegistryAccount,
  type SourceRegistryMigration,
} from '../src/core/source-registry.ts';
import * as registryAtStep4b from './fixtures/source-registry-4b.ts';

let dir: string;
let env: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-source-registry-'));
  env = { HOME: dir, XDG_DATA_HOME: join(dir, 'data') };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function account(sourceId: string, corpusIds: string[]): SourceRegistryAccount {
  return { source_id: sourceId, slot: '1', state: 'active', layout: 'legacy', corpus_ids: corpusIds, created_at: '2026-10-24T00:00:00.000Z' };
}

function writeRaw(text: string): string {
  const path = sourceRegistryPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe('source registry', () => {
  test('lives in the data root', () => {
    expect(sourceRegistryPath(env)).toBe(join(dir, 'data', 'openclaw', 'olympus', 'registry.json'));
  });

  test('a missing file reads as an empty registry', () => {
    expect(readSourceRegistry(env)).toEqual({ schema: 1, accounts: [] });
  });

  test.each([
    ['not JSON', '{"schema": 1, "accounts": ['],
    ['an unknown schema', JSON.stringify({ schema: 4, accounts: [] })],
    ['no account list', JSON.stringify({ schema: 1 })],
    ['an unknown state', JSON.stringify({ schema: 1, accounts: [{ ...account('dropbox.files', []), state: 'gone' }] })],
    ['an account without a slot', JSON.stringify({ schema: 1, accounts: [{ ...account('dropbox.files', []), slot: '' }] })],
    ['one account listed twice', JSON.stringify({ schema: 1, accounts: [account('dropbox.files', []), account('dropbox.files', [])] })],
  ])('%s fails closed, naming the path', (_label, text) => {
    const path = writeRaw(text);
    let thrown: unknown;
    try {
      readSourceRegistry(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SourceRegistryError);
    expect((thrown as Error).message).toContain(path);
  });

  test('a registry in a folder that cannot be searched is unreadable, not empty', () => {
    if (process.getuid?.() === 0) return; // root searches any folder
    writeRaw(JSON.stringify({ schema: 1, accounts: [account('dropbox.files', ['secure_local.dropbox.files'])] }));
    const folder = dirname(sourceRegistryPath(env));
    chmodSync(folder, 0o000);
    try {
      let thrown: unknown;
      try {
        readSourceRegistry(env);
      } catch (error) {
        thrown = error;
      }
      // On Linux the data-root resolver's own look into the folder refuses
      // first; either way the read fails, naming the folder, and is never empty.
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(folder);
      if (process.platform !== 'linux') expect(thrown).toBeInstanceOf(SourceRegistryError);
    } finally {
      chmodSync(folder, 0o700);
    }
  });

  test('an update cannot overwrite an unreadable registry', () => {
    writeRaw('not json');
    expect(() => updateSourceRegistry(env, (registry) => {
      registry.accounts.push(account('dropbox.files', ['secure_local.dropbox.files']));
    })).toThrow(SourceRegistryError);
    expect(() => readSourceRegistry(env)).toThrow(SourceRegistryError);
  });

  test('an update round-trips, written whole and private under the lease', () => {
    const path = sourceRegistryPath(env);
    const written = updateSourceRegistry(env, (registry) => {
      // The lease is held while the callback runs: another writer is turned away.
      expect(() => withFileLeaseSync(path, () => undefined, { acquireTimeoutMs: 50 })).toThrow(FileLeaseBusyError);
      registry.accounts.push(account('dropbox.files', ['secure_local.dropbox.files']));
    });
    expect(written.accounts).toHaveLength(1);
    const read = readSourceRegistry(env);
    expect(read).toEqual({ schema: 1, accounts: [account('dropbox.files', ['secure_local.dropbox.files'])] });
    expect(findRegistryAccount(read, 'dropbox.files', '1')?.corpus_ids).toEqual(['secure_local.dropbox.files']);
    expect(findRegistryAccount(read, 'dropbox.files', '2')).toBeUndefined();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // No temp file is left beside it; only the registry and its lease lock.
    expect(readdirSync(dirname(path)).filter((name) => !name.startsWith('registry.json.lock'))).toEqual(['registry.json']);
  });

  test('the schema follows the layouts: 1 until an account lives in a folder, then 2', () => {
    const path = sourceRegistryPath(env);
    const schemaOnDisk = (): unknown => JSON.parse(readFileSync(path, 'utf8')).schema;
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push(account('dropbox.files', ['secure_local.dropbox.files']));
    });
    expect(schemaOnDisk()).toBe(1);
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push({ ...account('gmail.email', ['internal.email']), layout: 'folder' });
    });
    expect(schemaOnDisk()).toBe(2);
    expect(readSourceRegistry(env).schema).toBe(2);
    // Later writes keep it, whichever account they touch.
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push(account('readwise.library', []));
    });
    expect(schemaOnDisk()).toBe(2);
    // A schema-2 file with no folder account reads fine (and is written back as 1).
    writeRaw(JSON.stringify({ schema: 2, accounts: [account('dropbox.files', [])] }));
    expect(readSourceRegistry(env).accounts).toHaveLength(1);
    updateSourceRegistry(env, () => undefined);
    expect(schemaOnDisk()).toBe(1);
  });

  test('a mutation that throws writes nothing', () => {
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push(account('gmail.email', ['internal.email']));
    });
    expect(() => updateSourceRegistry(env, (registry) => {
      registry.accounts.push(account('dropbox.files', []));
      throw new Error('stop');
    })).toThrow('stop');
    expect(readSourceRegistry(env).accounts.map((entry) => entry.source_id)).toEqual(['gmail.email']);
  });

  test('a mutation that would write a malformed registry is refused', () => {
    expect(() => updateSourceRegistry(env, (registry) => {
      registry.accounts.push({ ...account('dropbox.files', []), state: 'gone' as SourceRegistryAccount['state'] });
    })).toThrow(SourceRegistryError);
    expect(readSourceRegistry(env).accounts).toEqual([]);
  });

  test('two writers in turn keep both entries', () => {
    // Each writer holds the lease for its whole read-modify-write, so the
    // second reads what the first wrote.
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push(account('dropbox.files', ['secure_local.dropbox.files']));
    });
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push(account('gmail.email', ['internal.email']));
    });
    expect(readSourceRegistry(env).accounts.map((entry) => entry.source_id)).toEqual(['dropbox.files', 'gmail.email']);
  });
});

// The boot migration's record on an entry (delivery step 4c).
describe('source registry: the migration record', () => {
  const move = (extra: Record<string, unknown> = {}) => ({
    role: 'store', from: 'dropbox-files-connector-store.sqlite', to: 'sources/dropbox.files/1/stores/secure_local.sqlite',
    kind: 'file', db: true, dev: '66306', ino: '1234', size: 4096, ...extra,
  });
  const record = (state: SourceRegistryMigration['state'], extra: Record<string, unknown> = {}) => ({
    state, at: '2026-10-24T12:00:00.000Z', ...extra,
  });
  const withRecord = (migration: unknown, extra: Partial<SourceRegistryAccount> = {}): string => JSON.stringify({
    schema: 3,
    accounts: [{ ...account('dropbox.files', ['secure_local.dropbox.files']), ...extra, migration }],
  });
  const schemaOnDisk = (): unknown => JSON.parse(readFileSync(sourceRegistryPath(env), 'utf8')).schema;
  const pendingPlan = record('moving', { moves: [move()] });

  test('the schema is 3 for as long as a move is pending, then 2 if any account is a folder, else 1', () => {
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push(account('dropbox.files', []), { ...account('gmail.email', []), layout: 'folder' });
    });
    expect(schemaOnDisk()).toBe(2);
    updateSourceRegistry(env, (registry) => {
      findRegistryAccount(registry, 'dropbox.files', '1')!.migration = pendingPlan as SourceRegistryMigration;
    });
    expect(schemaOnDisk()).toBe(3);
    expect(readSourceRegistry(env).schema).toBe(3);
    // Another account's write keeps it.
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push(account('readwise.library', []));
    });
    expect(schemaOnDisk()).toBe(3);
    // Reverting is pending too.
    updateSourceRegistry(env, (registry) => {
      findRegistryAccount(registry, 'dropbox.files', '1')!.migration = { ...pendingPlan, state: 'reverting' } as SourceRegistryMigration;
    });
    expect(schemaOnDisk()).toBe(3);
    // The plan's end: back to what the layouts say.
    updateSourceRegistry(env, (registry) => {
      const entry = findRegistryAccount(registry, 'dropbox.files', '1')!;
      entry.layout = 'folder';
      entry.migration = record('done') as SourceRegistryMigration;
    });
    expect(schemaOnDisk()).toBe(2);
    updateSourceRegistry(env, (registry) => {
      registry.accounts = registry.accounts.filter((entry) => entry.layout === 'legacy');
    });
    expect(schemaOnDisk()).toBe(1);
  });

  test('which states are pending', () => {
    for (const state of ['moving', 'reverting'] as const) expect(sourceAccountMovePending({ migration: record(state, { moves: [] }) as SourceRegistryMigration })).toBe(true);
    for (const state of ['done', 'skipped', 'failed'] as const) expect(sourceAccountMovePending({ migration: record(state) as SourceRegistryMigration })).toBe(false);
    expect(sourceAccountMovePending({})).toBe(false);
  });

  test.each([
    ['a done record', record('done')],
    ['a skipped record with its reason', record('skipped', { reason: 'other_device', detail: 'A file is on another device.' })],
    ['a failed record that kept how each database was', record('failed', { reason: 'verify_failed', detail: 'x', checked: [{ file: 'sources/a/1/stores/s.sqlite', result: 'ok' }, { file: 'b', result: 'not_checked' }] })],
    ['a plan with its moves', pendingPlan],
    ['a folder move', record('moving', { moves: [move({ role: 'raw', kind: 'dir', db: undefined, size: 0 })] })],
  ])('%s reads', (_label, migration) => {
    writeRaw(withRecord(migration));
    expect(readSourceRegistry(env).accounts[0]!.migration).toEqual(JSON.parse(JSON.stringify(migration)));
  });

  test.each([
    ['a state nobody wrote', record('paused' as never)],
    ['no time', { state: 'done' }],
    ['a plan without its moves (the account would be closed for nothing)', record('moving')],
    ['a reverting plan without its moves', record('reverting')],
    ['moves that are not a list', record('moving', { moves: 'all of them' })],
    ['a move with no destination', record('moving', { moves: [move({ to: '' })] })],
    ['a move with an unknown role', record('moving', { moves: [move({ role: 'journal' })] })],
    ['a move that is neither file nor folder', record('moving', { moves: [move({ kind: 'link' })] })],
    ['a move with a size that is not a whole number', record('moving', { moves: [move({ size: -1 })] })],
    ['a move with a device that is a number (identities are kept as text)', record('moving', { moves: [move({ dev: 66306 })] })],
    ['a check with an unknown result', record('failed', { checked: [{ file: 'a', result: 'maybe' }] })],
  ])('%s fails closed, like any malformed entry', (_label, migration) => {
    const path = writeRaw(withRecord(migration));
    expect(() => readSourceRegistry(env)).toThrow(SourceRegistryError);
    expect(() => updateSourceRegistry(env, () => undefined)).toThrow(SourceRegistryError);
    expect(readFileSync(path, 'utf8')).toBe(withRecord(migration));
  });

  test('what the owner is told: a failed move, a pending one, a place that cannot be read, files in two places, and nothing else', () => {
    const entries: Array<[string, SourceRegistryAccount['state'], unknown]> = [
      ['dropbox.files', 'active', record('failed', { reason: 'verify_failed' })],
      ['gmail.email', 'active', pendingPlan],
      ['google_drive.docs', 'active', record('skipped', { reason: 'unreadable' })],
      ['local.files', 'active', record('skipped', { reason: 'destination_exists' })],
      // Explained already, or not the owner's to act on.
      ['readwise.library', 'active', record('skipped', { reason: 'pinned' })],
      ['x.bookmarks', 'active', record('skipped', { reason: 'other_device' })],
      ['archive.imports', 'active', record('done')],
      // An account being deleted has no row.
      ['telegram.messages', 'deleting', record('failed')],
    ];
    writeRaw(JSON.stringify({
      schema: 3,
      accounts: entries.map(([sourceId, state, migration]) => ({ ...account(sourceId, []), state, migration })),
    }));
    expect(sourceStorageNotices(env)).toEqual([
      { source_id: 'dropbox.files', kind: 'moved_back' },
      { source_id: 'gmail.email', kind: 'stuck' },
      { source_id: 'google_drive.docs', kind: 'unreadable' },
      { source_id: 'local.files', kind: 'in_the_way' },
    ]);
  });

  test('an unreadable registry tells the owner nothing from here (the boot says so in the log)', () => {
    writeRaw('{ not json');
    expect(sourceStorageNotices(env)).toEqual([]);
  });

  describe('a build from before the plan (delivery steps 4a and 4b), read from its own source', () => {
    test('refuses a registry with a move pending: it would open empty stores beside the folder that holds half of them', () => {
      const path = writeRaw(withRecord(pendingPlan));
      expect(() => registryAtStep4b.readSourceRegistry(env)).toThrow(registryAtStep4b.SourceRegistryError);
      expect(() => registryAtStep4b.updateSourceRegistry(env, () => undefined)).toThrow(registryAtStep4b.SourceRegistryError);
      expect(readFileSync(path, 'utf8')).toBe(withRecord(pendingPlan));
    });

    test('reads the registry once the move is done, keeps the record when it writes, and never mistakes it for a plan', () => {
      for (const [layout, migration] of [['folder', record('done')], ['legacy', record('failed', { reason: 'verify_failed', detail: 'x' })], ['legacy', record('skipped', { reason: 'pinned', detail: 'y' })]] as const) {
        writeRaw(JSON.stringify({ schema: layout === 'folder' ? 2 : 1, accounts: [{ ...account('dropbox.files', []), layout, migration }] }));
        expect(registryAtStep4b.readSourceRegistry(env).accounts[0]!.layout).toBe(layout);
        registryAtStep4b.updateSourceRegistry(env, () => undefined);
        expect(JSON.parse(readFileSync(sourceRegistryPath(env), 'utf8')).accounts[0].migration).toEqual(migration);
        expect(readSourceRegistry(env).accounts[0]!.migration).toEqual(migration);
      }
    });
  });
});

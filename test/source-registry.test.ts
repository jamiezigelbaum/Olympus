// The account registry (docs/design/source-storage.md, "Registry"): a missing
// file is empty, anything unreadable fails closed, and every write goes
// through the file lease and lands whole.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileLeaseBusyError, withFileLeaseSync } from '../src/core/file-lease.ts';
import {
  SourceRegistryError,
  findRegistryAccount,
  readSourceRegistry,
  sourceRegistryPath,
  updateSourceRegistry,
  type SourceRegistryAccount,
} from '../src/core/source-registry.ts';

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
    ['an unknown schema', JSON.stringify({ schema: 2, accounts: [] })],
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

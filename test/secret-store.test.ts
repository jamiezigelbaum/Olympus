import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  createDefaultSecretStore,
  EncryptedFileSecretStore,
  LinuxLibsecretSecretStore,
  MacOSKeychainSecretStore,
  type CommandRunner,
} from '../src/core/secret-store.ts';

describe('Olympus secret store', () => {
  test('encrypted-file fallback roundtrips secrets without plaintext on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-secret-store-test-'));
    const encryptedFilePath = join(dir, 'secrets.enc');
    const keyFilePath = join(dir, 'secrets.key');
    try {
      const store = new EncryptedFileSecretStore({ encryptedFilePath, keyFilePath });

      await store.set('dropbox.personal.refresh_token', 'refresh-token-fixture');

      expect(await store.get('dropbox.personal.refresh_token')).toBe('refresh-token-fixture');
      expect(await store.list()).toEqual(['dropbox.personal.refresh_token']);
      expect(readFileSync(encryptedFilePath, 'utf8')).not.toContain('refresh-token-fixture');

      await store.delete('dropbox.personal.refresh_token');
      expect(await store.get('dropbox.personal.refresh_token')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('encrypted-file writes replace the store whole so a torn write cannot destroy every secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-secret-store-atomic-'));
    const encryptedFilePath = join(dir, 'secrets.enc');
    const keyFilePath = join(dir, 'secrets.key');
    try {
      const store = new EncryptedFileSecretStore({ encryptedFilePath, keyFilePath });
      await store.set('x.personal.oauth.refresh_token', 'refresh-token-generation-1');
      const heldBeforeRotation = openSync(encryptedFilePath, 'r');
      const bytesBeforeRotation = readFileSync(encryptedFilePath, 'utf8');

      await store.set('x.personal.oauth.refresh_token', 'refresh-token-generation-2');

      // The whole file is one authenticated blob keyed to secrets.key, so any
      // truncation makes every secret in it undecryptable and nothing backs it
      // up. A descriptor opened before the write still sees the complete old
      // bytes, which an in-place truncate-and-rewrite could not offer.
      const size = fstatSync(heldBeforeRotation).size;
      const buffer = Buffer.alloc(size);
      readSync(heldBeforeRotation, buffer, 0, size, 0);
      closeSync(heldBeforeRotation);
      expect(buffer.toString('utf8')).toBe(bytesBeforeRotation);
      expect(statSync(encryptedFilePath).mode & 0o777).toBe(0o600);
      expect(statSync(keyFilePath).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
      expect(await store.get('x.personal.oauth.refresh_token')).toBe('refresh-token-generation-2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('auto backend uses encrypted-file on macOS to avoid Keychain argv writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-secret-store-auto-test-'));
    const encryptedFilePath = join(dir, 'secrets.enc');
    const keyFilePath = join(dir, 'secrets.key');
    const calls: string[][] = [];
    const runner: CommandRunner = (_command, args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const store = createDefaultSecretStore({
        env: {},
        paths: { encryptedFilePath, keyFilePath },
        platform: 'darwin',
        runner,
      });

      expect(store.label).toBe('encrypted-file');
      await store.set('x.personal.refresh_token', 'x-refresh-token-fixture');

      expect(await store.get('x.personal.refresh_token')).toBe('x-refresh-token-fixture');
      expect(calls).toEqual([]);
      expect(readFileSync(encryptedFilePath, 'utf8')).not.toContain('x-refresh-token-fixture');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('macOS Keychain backend reads and deletes through the security CLI contract with a mock runner', async () => {
    const values = new Map<string, string>();
    const runner: CommandRunner = (_command, args) => {
      const key = args[args.indexOf('-a') + 1] ?? '';
      if (args[0] === 'find-generic-password') {
        const value = values.get(key);
        return value ? { status: 0, stdout: `${value}\n`, stderr: '' } : { status: 44, stdout: '', stderr: '' };
      }
      if (args[0] === 'delete-generic-password') {
        values.delete(key);
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    };
    values.set('x.personal.refresh_token', 'x-refresh-token-fixture');
    const store = new MacOSKeychainSecretStore({ runner });

    expect(await store.get('x.personal.refresh_token')).toBe('x-refresh-token-fixture');
    await store.delete('x.personal.refresh_token');
    expect(await store.get('x.personal.refresh_token')).toBeUndefined();
  });

  test('macOS Keychain backend refuses writes instead of exposing secrets in argv', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = (_command, args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    };
    const store = new MacOSKeychainSecretStore({ runner });

    await expect(store.set('x.personal.refresh_token', 'x-refresh-token-fixture')).rejects.toThrow(
      'macOS Keychain writes are disabled',
    );
    expect(JSON.stringify(calls)).not.toContain('x-refresh-token-fixture');
  });

  test('libsecret backend roundtrips through secret-tool with a mock runner', async () => {
    const values = new Map<string, string>();
    const runner: CommandRunner = (_command, args, input) => {
      const key = args[args.indexOf('key') + 1] ?? '';
      if (args[0] === 'store') {
        values.set(key, input ?? '');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'lookup') {
        const value = values.get(key);
        return value ? { status: 0, stdout: `${value}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
      }
      if (args[0] === 'clear') {
        values.delete(key);
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    };
    const store = new LinuxLibsecretSecretStore({ runner });

    await store.set('readwise.personal.token', 'readwise-token-fixture');

    expect(await store.get('readwise.personal.token')).toBe('readwise-token-fixture');
    await store.delete('readwise.personal.token');
    expect(await store.get('readwise.personal.token')).toBeUndefined();
  });

  test.skipIf(process.env.OLYMPUS_LIVE_KEYCHAIN_TEST !== '1')(
    'live macOS Keychain backend write is disabled',
    async () => {
      const key = `olympus.live-test.${Date.now()}`;
      const store = new MacOSKeychainSecretStore();
      await expect(store.set(key, 'live-keychain-token-fixture')).rejects.toThrow(
        'macOS Keychain writes are disabled',
      );
    },
  );
});

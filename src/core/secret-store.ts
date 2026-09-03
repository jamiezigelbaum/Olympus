import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { withFileLeaseSync } from './file-lease.ts';

export interface SecretStore {
  readonly label: string;
  get(key: string): Promise<string | undefined>;
  getSync?(key: string): string | undefined;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], input?: string) => CommandResult;

export interface SecretStorePaths {
  encryptedFilePath?: string;
  keyFilePath?: string;
}

const DEFAULT_SERVICE = 'olympus';
const STORE_VERSION = 1;

export function defaultOlympusConfigDir(): string {
  return join(homedir(), '.config', 'olympus');
}

export function defaultEncryptedSecretsPath(): string {
  return join(defaultOlympusConfigDir(), 'secrets.enc');
}

export function defaultEncryptedSecretsKeyPath(): string {
  return join(defaultOlympusConfigDir(), 'secrets.key');
}

export function normalizeSecretRef(ref: string): { kind: 'env' | 'store'; key: string } | undefined {
  const trimmed = ref.trim();
  if (trimmed.startsWith('env:')) {
    const key = trimmed.slice('env:'.length).trim();
    return key ? { kind: 'env', key } : undefined;
  }
  if (trimmed.startsWith('store:')) {
    const key = trimmed.slice('store:'.length).trim();
    return isSafeSecretKey(key) ? { kind: 'store', key } : undefined;
  }
  return undefined;
}

export function isSafeSecretKey(key: string): boolean {
  return /^[a-zA-Z0-9._:-]{1,160}$/.test(key);
}

export function createDefaultSecretStore(options: {
  env?: Record<string, string | undefined>;
  paths?: SecretStorePaths;
  runner?: CommandRunner;
  platform?: ReturnType<typeof platform>;
} = {}): SecretStore {
  const env = options.env ?? process.env;
  const backend = env.OLYMPUS_SECRET_STORE_BACKEND?.trim() || 'auto';
  const runner = options.runner ?? runCommand;
  if (backend === 'file') return createFileSecretStore({ env, ...(options.paths ? { paths: options.paths } : {}) });
  if (backend === 'keychain') return new MacOSKeychainSecretStore({ runner });
  if (backend === 'libsecret') return new LinuxLibsecretSecretStore({ runner });
  if (backend === '1password') return new OnePasswordSecretStore({ env, runner });
  if (backend !== 'auto') throw new Error('Unsupported Olympus secret store backend.');

  const currentPlatform = options.platform ?? platform();
  if (currentPlatform === 'darwin') return createFileSecretStore({ env, ...(options.paths ? { paths: options.paths } : {}) });
  if (currentPlatform === 'linux' && commandExists('secret-tool', runner)) {
    return new LinuxLibsecretSecretStore({ runner });
  }
  return createFileSecretStore({ env, ...(options.paths ? { paths: options.paths } : {}) });
}

export function createFileSecretStore(options: {
  env?: Record<string, string | undefined>;
  paths?: SecretStorePaths;
} = {}): SecretStore {
  return new EncryptedFileSecretStore({
    encryptedFilePath: options.paths?.encryptedFilePath ?? defaultEncryptedSecretsPath(),
    keyFilePath: options.paths?.keyFilePath ?? defaultEncryptedSecretsKeyPath(),
    ...(options.env?.OLYMPUS_SECRET_STORE_PASSPHRASE
      ? { passphrase: options.env.OLYMPUS_SECRET_STORE_PASSPHRASE }
      : {}),
  });
}

export class EncryptedFileSecretStore implements SecretStore {
  readonly label = 'encrypted-file';
  private readonly encryptedFilePath: string;
  private readonly keyFilePath: string;
  private readonly passphrase: string | undefined;

  constructor(options: { encryptedFilePath: string; keyFilePath: string; passphrase?: string }) {
    if (!options.encryptedFilePath.trim()) throw new Error('Secret store path must be non-empty.');
    if (!options.keyFilePath.trim()) throw new Error('Secret store key path must be non-empty.');
    this.encryptedFilePath = options.encryptedFilePath;
    this.keyFilePath = options.keyFilePath;
    this.passphrase = options.passphrase?.trim() || undefined;
  }

  async get(key: string): Promise<string | undefined> {
    return this.getSync(key);
  }

  getSync(key: string): string | undefined {
    assertSafeKey(key);
    const store = this.readStore();
    return store.secrets[key];
  }

  async set(key: string, value: string): Promise<void> {
    assertSafeKey(key);
    if (!value) throw new Error('Secret value must be non-empty.');
    withFileLeaseSync(this.encryptedFilePath, (lease) => {
      const store = this.readStore();
      store.secrets[key] = value;
      lease.commit(() => this.writeStore(store));
    });
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    withFileLeaseSync(this.encryptedFilePath, (lease) => {
      const store = this.readStore();
      delete store.secrets[key];
      lease.commit(() => this.writeStore(store));
    });
  }

  async list(): Promise<string[]> {
    return Object.keys(this.readStore().secrets).sort();
  }

  private readStore(): FileSecretStorePayload {
    if (!existsSync(this.encryptedFilePath)) return { version: STORE_VERSION, secrets: {} };
    const encrypted = JSON.parse(readFileSync(this.encryptedFilePath, 'utf8')) as EncryptedFilePayload;
    if (encrypted.version !== STORE_VERSION || encrypted.algorithm !== 'aes-256-gcm') {
      throw new Error('Olympus secret store format is unsupported.');
    }
    const key = this.keyForPayload(encrypted);
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(encrypted.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
      const clear = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      const parsed = JSON.parse(clear) as FileSecretStorePayload;
      if (parsed.version !== STORE_VERSION || !parsed.secrets || typeof parsed.secrets !== 'object') {
        throw new Error('Olympus secret store payload is invalid.');
      }
      return { version: STORE_VERSION, secrets: { ...parsed.secrets } };
    } finally {
      key.fill(0);
    }
  }

  private writeStore(store: FileSecretStorePayload): void {
    const payload: FileSecretStorePayload = {
      version: STORE_VERSION,
      secrets: Object.fromEntries(Object.entries(store.secrets).sort(([a], [b]) => a.localeCompare(b))),
    };
    const salt = this.passphrase ? randomBytes(16) : undefined;
    const key = this.keyForSalt(salt);
    const iv = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(payload), 'utf8'),
        cipher.final(),
      ]);
      const encrypted: EncryptedFilePayload = {
        version: STORE_VERSION,
        algorithm: 'aes-256-gcm',
        kdf: this.passphrase ? 'scrypt' : 'local-random-key',
        ...(salt ? { salt: salt.toString('base64') } : {}),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
      mkdirSync(dirname(this.encryptedFilePath), { recursive: true });
      // One authenticated blob holds every secret, and it fails to decrypt whole
      // if a single byte is missing -- so a write torn by a restart does not lose
      // one key, it loses the store, and nothing backs this file up.
      writePrivateFileAtomicSync(this.encryptedFilePath, JSON.stringify(encrypted, null, 2));
    } finally {
      key.fill(0);
    }
  }

  private keyForPayload(payload: EncryptedFilePayload): Buffer {
    if (payload.kdf === 'scrypt') {
      if (!this.passphrase) throw new Error('Olympus secret store passphrase is required.');
      if (!payload.salt) throw new Error('Olympus secret store salt is missing.');
      return scryptSync(this.passphrase, Buffer.from(payload.salt, 'base64'), 32);
    }
    return this.localRandomKey();
  }

  private keyForSalt(salt: Buffer | undefined): Buffer {
    if (this.passphrase) {
      if (!salt) throw new Error('Olympus secret store salt is required.');
      return scryptSync(this.passphrase, salt, 32);
    }
    return this.localRandomKey();
  }

  private localRandomKey(): Buffer {
    mkdirSync(dirname(this.keyFilePath), { recursive: true });
    if (!existsSync(this.keyFilePath)) {
      // Lose this and the ciphertext written under it is undecryptable, so it is
      // flushed before anything can encrypt against it.
      writePrivateFileAtomicSync(this.keyFilePath, randomBytes(32).toString('base64'));
    }
    const key = Buffer.from(readFileSync(this.keyFilePath, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error('Olympus secret store key is invalid.');
    return key;
  }
}

export class MacOSKeychainSecretStore implements SecretStore {
  readonly label = 'macos-keychain';
  private readonly runner: CommandRunner;

  constructor(options: { runner?: CommandRunner } = {}) {
    this.runner = options.runner ?? runCommand;
  }

  async get(key: string): Promise<string | undefined> {
    return this.getSync(key);
  }

  getSync(key: string): string | undefined {
    assertSafeKey(key);
    const result = this.runner('security', ['find-generic-password', '-a', key, '-s', DEFAULT_SERVICE, '-w']);
    if (result.status !== 0) return undefined;
    return result.stdout.trim() || undefined;
  }

  async set(key: string, value: string): Promise<void> {
    assertSafeKey(key);
    if (!value) throw new Error('Secret value must be non-empty.');
    throw new Error('macOS Keychain writes are disabled because the security CLI exposes secret values in process arguments. Use OLYMPUS_SECRET_STORE_BACKEND=file or pre-provision the keychain item.');
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    this.runner('security', ['delete-generic-password', '-a', key, '-s', DEFAULT_SERVICE]);
  }

  async list(): Promise<string[]> {
    return [];
  }
}

export class LinuxLibsecretSecretStore implements SecretStore {
  readonly label = 'libsecret';
  private readonly runner: CommandRunner;

  constructor(options: { runner?: CommandRunner } = {}) {
    this.runner = options.runner ?? runCommand;
  }

  async get(key: string): Promise<string | undefined> {
    return this.getSync(key);
  }

  getSync(key: string): string | undefined {
    assertSafeKey(key);
    const result = this.runner('secret-tool', ['lookup', 'application', DEFAULT_SERVICE, 'key', key]);
    if (result.status !== 0) return undefined;
    return result.stdout.trim() || undefined;
  }

  async set(key: string, value: string): Promise<void> {
    assertSafeKey(key);
    if (!value) throw new Error('Secret value must be non-empty.');
    const result = this.runner('secret-tool', [
      'store',
      '--label',
      `Olympus ${key}`,
      'application',
      DEFAULT_SERVICE,
      'key',
      key,
    ], value);
    if (result.status !== 0) throw new Error('libsecret secret write failed.');
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    this.runner('secret-tool', ['clear', 'application', DEFAULT_SERVICE, 'key', key]);
  }

  async list(): Promise<string[]> {
    return [];
  }
}

export class OnePasswordSecretStore implements SecretStore {
  readonly label = '1password';
  private readonly env: Record<string, string | undefined>;
  private readonly runner: CommandRunner;

  constructor(options: { env?: Record<string, string | undefined>; runner?: CommandRunner } = {}) {
    this.env = options.env ?? process.env;
    this.runner = options.runner ?? runCommand;
  }

  async get(key: string): Promise<string | undefined> {
    return this.getSync(key);
  }

  getSync(key: string): string | undefined {
    assertSafeKey(key);
    const ref = this.env[`OLYMPUS_SECRET_REF_${envKeyFromSecretKey(key)}`]?.trim();
    if (!ref) return undefined;
    const brokerRead = this.env.OLYMPUS_OP_BROKER_READ_BIN?.trim() || 'op-cached-read';
    const result = this.runner(brokerRead, [ref]);
    if (result.status !== 0) throw new Error('1Password broker secret read failed.');
    return result.stdout.trim() || undefined;
  }

  async set(): Promise<void> {
    throw new Error('1Password backend is read-only; create the item in 1Password and map it with OLYMPUS_SECRET_REF_<KEY>.');
  }

  async delete(): Promise<void> {
    throw new Error('1Password backend is read-only from Olympus.');
  }

  async list(): Promise<string[]> {
    return Object.keys(this.env)
      .filter((name) => name.startsWith('OLYMPUS_SECRET_REF_'))
      .map((name) => name.slice('OLYMPUS_SECRET_REF_'.length).toLowerCase().replaceAll('__', ':').replaceAll('_', '.'))
      .sort();
  }
}

export async function resolveSecretRefValue(
  secretRef: string | undefined,
  options: {
    env?: Record<string, string | undefined>;
    secretStore?: SecretStore;
  } = {},
): Promise<string | undefined> {
  if (!secretRef) return undefined;
  const parsed = normalizeSecretRef(secretRef);
  if (!parsed) return undefined;
  if (parsed.kind === 'env') return (options.env ?? process.env)[parsed.key]?.trim() || undefined;
  const store = options.secretStore ?? createDefaultSecretStore({
    ...(options.env ? { env: options.env } : {}),
  });
  return store.get(parsed.key);
}

export function resolveSecretRefValueSync(
  secretRef: string | undefined,
  options: {
    env?: Record<string, string | undefined>;
    secretStore?: SecretStore;
  } = {},
): string | undefined {
  if (!secretRef) return undefined;
  const parsed = normalizeSecretRef(secretRef);
  if (!parsed) return undefined;
  if (parsed.kind === 'env') return (options.env ?? process.env)[parsed.key]?.trim() || undefined;
  const store = options.secretStore ?? createDefaultSecretStore({
    ...(options.env ? { env: options.env } : {}),
  });
  if (!store.getSync) throw new Error('Configured Olympus secret store does not support synchronous reads.');
  return store.getSync(parsed.key);
}

function assertSafeKey(key: string): void {
  if (!isSafeSecretKey(key)) throw new Error('Secret key must contain only safe label characters.');
}

function envKeyFromSecretKey(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function commandExists(command: string, runner: CommandRunner): boolean {
  return runner(command, ['--version']).status === 0;
}

function runCommand(command: string, args: string[], input?: string): CommandResult {
  const result = spawnSync(command, args, {
    input,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

interface FileSecretStorePayload {
  version: 1;
  secrets: Record<string, string>;
}

interface EncryptedFilePayload {
  version: 1;
  algorithm: 'aes-256-gcm';
  kdf: 'local-random-key' | 'scrypt';
  salt?: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

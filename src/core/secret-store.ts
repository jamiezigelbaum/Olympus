import { LINUX_SECRET_SERVICE_HELPER } from './linux-secret-service.ts';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { assertLinuxSecretPath, readSecretFile, resolveLinuxSecretPaths, selectLinuxSecretBackend, SecretStoreError, secretStoreFailure } from './linux-secret-backend.ts';
export { SecretStoreError } from './linux-secret-backend.ts';
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
  errorCode?: string;
}

export type CommandRunner = (command: string, args: string[], input?: string) => CommandResult;

export interface SecretStorePaths {
  encryptedFilePath?: string;
  keyFilePath?: string;
  backendFilePath?: string;
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
  const currentPlatform = options.platform ?? platform();
  if (currentPlatform === 'linux') {
    const paths = resolveLinuxSecretPaths(env, options.paths);
    const selected = selectLinuxSecretBackend(paths, backend);
    if (selected === 'libsecret') return new LinuxLibsecretSecretStore({ ...(options.runner ? { runner: options.runner } : {}) });
    return new LinuxFileSecretStore({ ...paths, ...(env.OLYMPUS_SECRET_STORE_PASSPHRASE ? { passphrase: env.OLYMPUS_SECRET_STORE_PASSPHRASE } : {}), strictLinux: true });
  }
  if (backend === 'file') return createFileSecretStore({ env, ...(options.paths ? { paths: options.paths } : {}) });
  if (backend === 'keychain') return new MacOSKeychainSecretStore({ runner });
  if (backend === 'libsecret') return new LinuxLibsecretSecretStore({ runner });
  if (backend !== 'auto') throw new Error('Unsupported Olympus secret store backend.');

  if (currentPlatform === 'darwin') return createFileSecretStore({ env, ...(options.paths ? { paths: options.paths } : {}) });
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
  private readonly strictLinux: boolean;

  constructor(options: { encryptedFilePath: string; keyFilePath: string; passphrase?: string; strictLinux?: boolean }) {
    if (!options.encryptedFilePath.trim()) throw new Error('Secret store path must be non-empty.');
    if (!options.keyFilePath.trim()) throw new Error('Secret store key path must be non-empty.');
    this.encryptedFilePath = options.encryptedFilePath;
    this.keyFilePath = options.keyFilePath;
    this.passphrase = options.passphrase?.trim() || undefined;
    this.strictLinux = options.strictLinux ?? false;
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
    if (this.strictLinux) { assertLinuxSecretPath(this.encryptedFilePath); assertLinuxSecretPath(this.keyFilePath); }
    const text = this.strictLinux ? readSecretFile(this.encryptedFilePath)
      : (existsSync(this.encryptedFilePath) ? readFileSync(this.encryptedFilePath, 'utf8') : undefined);
    if (text === undefined) return { version: STORE_VERSION, secrets: {} };
    let encrypted: EncryptedFilePayload;
    if (this.strictLinux) {
      try { encrypted = JSON.parse(text); } catch { throw new SecretStoreError('corrupt', 'ciphertext is invalid.'); }
      if (!encrypted || !['local-random-key', 'scrypt'].includes(encrypted.kdf)) throw new SecretStoreError('corrupt', 'unsupported key derivation.');
    } else { encrypted = JSON.parse(text) as EncryptedFilePayload; }
    if (encrypted.version !== STORE_VERSION || encrypted.algorithm !== 'aes-256-gcm') {
      if (this.strictLinux) throw new SecretStoreError('corrupt', 'format is unsupported.');
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
    } catch (error) {
      if (this.strictLinux) throw new SecretStoreError('corrupt', 'ciphertext could not be authenticated or decoded.');
      throw error;
    } finally {
      key.fill(0);
    }
  }

  private writeStore(store: FileSecretStorePayload): void {
    if (this.strictLinux) { assertLinuxSecretPath(this.encryptedFilePath); assertLinuxSecretPath(this.keyFilePath); }
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
      mkdirSync(dirname(this.encryptedFilePath), { recursive: true, mode: 0o700 });
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
      if (!this.passphrase) {
        if (this.strictLinux) throw new SecretStoreError('locked', 'passphrase unlock is required.');
        throw new Error('Olympus secret store passphrase is required.');
      }
      if (!payload.salt) {
        if (this.strictLinux) throw new SecretStoreError('corrupt', 'salt is missing.');
        throw new Error('Olympus secret store salt is missing.');
      }
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
    if (this.strictLinux && readSecretFile(this.keyFilePath) === undefined && readSecretFile(this.encryptedFilePath) !== undefined) {
      throw new SecretStoreError('corrupt', 'wrapping key is lost; restore the original key. No replacement was generated.');
    }
    mkdirSync(dirname(this.keyFilePath), { recursive: true, mode: 0o700 });
    if (!existsSync(this.keyFilePath)) {
      // Lose this and the ciphertext written under it is undecryptable, so it is
      // flushed before anything can encrypt against it.
      writePrivateFileAtomicSync(this.keyFilePath, randomBytes(32).toString('base64'));
    }
    const key = Buffer.from(readFileSync(this.keyFilePath, 'utf8').trim(), 'base64');
    if (key.length !== 32) {
      if (this.strictLinux) throw new SecretStoreError('corrupt', 'wrapping key is invalid.');
      throw new Error('Olympus secret store key is invalid.');
    }
    return key;
  }
}

class LinuxFileSecretStore extends EncryptedFileSecretStore {
  constructor(private readonly linuxOptions: { encryptedFilePath: string; keyFilePath: string; passphrase?: string; strictLinux: true }) { super(linuxOptions); }
  private checkPaths(): void {
    assertLinuxSecretPath(this.linuxOptions.encryptedFilePath);
    assertLinuxSecretPath(this.linuxOptions.keyFilePath);
  }
  override getSync(key: string): string | undefined {
    try { this.checkPaths(); return super.getSync(key); } catch (error) { throw secretStoreFailure(error); }
  }
  override async set(key: string, value: string): Promise<void> {
    try { this.checkPaths(); await super.set(key, value); } catch (error) { throw secretStoreFailure(error); }
  }
  override async delete(key: string): Promise<void> {
    try { this.checkPaths(); await super.delete(key); } catch (error) { throw secretStoreFailure(error); }
  }
  override async list(): Promise<string[]> {
    try { this.checkPaths(); return await super.list(); } catch (error) { throw secretStoreFailure(error); }
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

const SECRET_SERVICE_PATH = '/org/freedesktop/secrets';
const SECRET_INTERFACE = 'org.freedesktop.Secret';

export class LinuxLibsecretSecretStore implements SecretStore {
  readonly label = 'libsecret';
  private readonly runner: CommandRunner;

  constructor(options: { runner?: CommandRunner } = {}) {
    this.runner = options.runner ?? runLinuxSecretCommand;
  }

  private command(command: string, args: string[], input?: string): string {
    let result: CommandResult;
    try { result = this.runner(command, args, input); } catch (error) { throw secretStoreFailure(error); }
    if (result.status !== 0 || result.errorCode) {
      // Provider text is classified, never returned (it may contain a secret).
      const detail = result.stderr;
      if (result.errorCode === 'ETIMEDOUT' || /TimedOut|NoReply|timed out|^timeout$/i.test(detail)) throw new SecretStoreError('timeout', 'libsecret call exceeded five seconds.');
      if (result.errorCode === 'EACCES' || result.errorCode === 'EPERM' || /AccessDenied|PermissionDenied|permission denied|not permitted|^permission$/i.test(detail)) throw new SecretStoreError('permission', 'libsecret access denied.');
      if (/IsLocked|is locked|^locked$/i.test(detail)) throw new SecretStoreError('locked', 'libsecret is locked; unlock it explicitly.');
      if (detail === 'corrupt') throw new SecretStoreError('corrupt', 'invalid libsecret data.');
      throw new SecretStoreError('unavailable', 'libsecret call failed; no alternate backend was used.');
    }
    return result.stdout;
  }

  private access(action: 'lookup' | 'store' | 'clear', collection: string, key: string, value?: string): string {
    return this.command('/usr/bin/python3', ['-c', LINUX_SECRET_SERVICE_HELPER], JSON.stringify({ action, collection, key, value }));
  }

  private bus(request: { path: string; interface: string; method: string; signature: string; args: unknown[] }, signature: string): unknown[] {
    const text = this.command('/usr/bin/python3', ['-c', LINUX_SECRET_SERVICE_HELPER], JSON.stringify({ action: 'bus', ...request }));
    try {
      const parsed = JSON.parse(text);
      if (parsed.type !== signature || !Array.isArray(parsed.data)) throw new Error();
      return parsed.data;
    } catch { throw new SecretStoreError('unavailable', 'invalid Secret Service reply.'); }
  }

  private unlocked(path: string, kind: 'Collection' | 'Item'): void {
    const data = this.bus({ path, interface: 'org.freedesktop.DBus.Properties', method: 'Get', signature: '(ss)', args: [`${SECRET_INTERFACE}.${kind}`, 'Locked'] }, 'b');
    if (data.length !== 1 || typeof data[0] !== 'boolean') throw new SecretStoreError('unavailable', 'invalid Locked property.');
    if (data[0]) throw new SecretStoreError('locked', 'libsecret is locked; unlock it explicitly.');
  }

  private accessibleItems(key?: string): { collection: string; items: string[] } {
    const alias = this.bus({ path: SECRET_SERVICE_PATH, interface: `${SECRET_INTERFACE}.Service`, method: 'ReadAlias', signature: '(s)', args: ['default'] }, 'o');
    const collection = alias[0];
    if (alias.length !== 1 || !isSecretObjectPath(collection) || collection === '/') throw new SecretStoreError('unavailable', 'default collection is unavailable.');
    this.unlocked(collection, 'Collection');
    const data = this.bus({ path: SECRET_SERVICE_PATH, interface: `${SECRET_INTERFACE}.Service`, method: 'SearchItems', signature: '(a{ss})', args: [{ application: DEFAULT_SERVICE, ...(key ? { key } : {}) }] }, 'aoao');
    if (data.length !== 2 || !Array.isArray(data[0]) || !Array.isArray(data[1]) || ![...data[0], ...data[1]].every(isSecretObjectPath)) throw new SecretStoreError('unavailable', 'invalid search reply.');
    if (data[1].length) throw new SecretStoreError('locked', 'matching libsecret items are locked.');
    for (const item of data[0]) this.unlocked(item, 'Item');
    return { collection, items: data[0] as string[] };
  }

  async get(key: string): Promise<string | undefined> { return this.getSync(key); }

  getSync(key: string): string | undefined {
    assertSafeKey(key);
    const { collection, items } = this.accessibleItems(key);
    // Only an authoritative, successful empty SearchItems result means absent.
    if (!items.length) return undefined;
    if (items.length !== 1) throw new SecretStoreError('corrupt', 'multiple matching libsecret items.');
    const value = this.access('lookup', collection, key);
    if (!value) throw new SecretStoreError('corrupt', 'libsecret returned an empty value for an existing item.');
    return value;
  }

  async set(key: string, value: string): Promise<void> {
    assertSafeKey(key);
    if (!value) throw new Error('Secret value must be non-empty.');
    const { collection, items } = this.accessibleItems(key);
    if (items.some((item) => !item.startsWith(`${collection}/`)) || items.length > 1) throw new SecretStoreError('configuration', 'matching item is outside the selected collection or ambiguous; no migration is supported.');
    this.access('store', collection, key, value);
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const { collection, items } = this.accessibleItems(key);
    if (!items.length) return;
    this.access('clear', collection, key);
    if (this.accessibleItems(key).items.length) throw new SecretStoreError('unavailable', 'libsecret deletion was not confirmed.');
  }

  async list(): Promise<string[]> {
    const { items } = this.accessibleItems();
    const keys = items.map((item) => {
      const data = this.bus({ path: item, interface: 'org.freedesktop.DBus.Properties', method: 'Get', signature: '(ss)', args: [`${SECRET_INTERFACE}.Item`, 'Attributes'] }, 'a{ss}');
      const attrs = data[0] as Record<string, unknown> | undefined;
      if (data.length !== 1 || !attrs || typeof attrs.key !== 'string' || !isSafeSecretKey(attrs.key)) throw new SecretStoreError('corrupt', 'invalid libsecret item attributes.');
      return attrs.key;
    });
    return [...new Set(keys)].sort();
  }

  /** Explicit readiness probe, never a claim of unattended unlock after reboot. */
  async probe(): Promise<void> {
    const key = `probe.${randomBytes(16).toString('hex')}`;
    const value = randomBytes(32).toString('base64');
    try {
      await this.set(key, value);
      if (await this.get(key) !== value) throw new SecretStoreError('corrupt', 'libsecret probe roundtrip failed.');
    } finally {
      try { await this.delete(key); }
      catch { throw new SecretStoreError('cleanup', 'libsecret probe cleanup failed; a disposable probe item may remain.'); }
    }
  }
}

function isSecretObjectPath(value: unknown): value is string {
  return typeof value === 'string' && /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/.test(value);
}

/** Kill, rather than wait for a SIGTERM-ignoring helper. No shell or value argv. */
export function runLinuxSecretCommand(command: string, args: string[], input?: string): CommandResult {
  const result = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5_000, killSignal: 'SIGKILL', env: { ...process.env, LC_ALL: 'C' } });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', ...(result.error ? { errorCode: (result.error as NodeJS.ErrnoException).code ?? 'UNKNOWN' } : {}) };
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

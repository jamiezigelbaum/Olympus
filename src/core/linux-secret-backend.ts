import { lstatSync, readFileSync } from 'node:fs';
import { resolveLinuxEngineLayout } from './linux-engine-layout.ts';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ensurePrivateRootDirectorySync, writePrivateFileAtomicSync } from './atomic-file.ts';
import { withFileLeaseSync } from './file-lease.ts';

export type SecretStoreFailure = 'locked' | 'unavailable' | 'permission' | 'timeout' | 'corrupt' | 'configuration' | 'cleanup';

/** Safe to render in doctor: never includes provider output, keys or values. */
export class SecretStoreError extends Error {
  constructor(readonly code: SecretStoreFailure, message: string) {
    super(`Olympus secret store ${code}: ${message}`);
    this.name = 'SecretStoreError';
  }
}

export function secretStoreFailure(error: unknown): SecretStoreError {
  if (error instanceof SecretStoreError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return new SecretStoreError('permission', 'access denied.');
  if (code === 'ETIMEDOUT' || code === 'file_lease_busy') return new SecretStoreError('timeout', 'operation did not finish.');
  return new SecretStoreError('unavailable', 'operation failed; no alternate backend was used.');
}

export interface LinuxSecretPaths {
  encryptedFilePath: string;
  keyFilePath: string;
  backendFilePath: string;
}

/** Explicit paths support isolated stores; production defaults use the install receipt. */
export function resolveLinuxSecretPaths(
  env: Record<string, string | undefined>,
  paths: Partial<LinuxSecretPaths> = {},
): LinuxSecretPaths {
  let layout;
  try { layout = resolveLinuxEngineLayout(env); }
  catch { throw new SecretStoreError('configuration', 'Cannot resolve the installed Linux layout; XDG roots must be absolute and the install receipt valid.'); }
  const encryptedFilePath = paths.encryptedFilePath ?? layout.secretsPath;
  const result = {
    encryptedFilePath,
    keyFilePath: paths.keyFilePath ?? join(dirname(encryptedFilePath), 'secrets.key'),
    backendFilePath: paths.backendFilePath ?? join(dirname(encryptedFilePath), 'secret-backend.json'),
  };
  for (const path of Object.values(result)) {
    if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new SecretStoreError('configuration', 'secret paths must be absolute.');
  }
  if (new Set(Object.values(result).map((path) => resolve(path))).size !== 3) {
    throw new SecretStoreError('configuration', 'secret paths must be distinct.');
  }
  return { encryptedFilePath: resolve(result.encryptedFilePath), keyFilePath: resolve(result.keyFilePath), backendFilePath: resolve(result.backendFilePath) };
}

/** ENOENT alone means absent. existsSync would conceal permission failures. */
export function readSecretFile(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw secretStoreFailure(error);
  }
}

/** Do not chmod shared parents; refuse unsafe paths before creating anything. */
export function assertLinuxSecretPath(path: string): void {
  let current = resolve(path);
  let leaf = true;
  let privateParent = false;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (leaf ? !stat.isFile() : !stat.isDirectory())) {
        throw new SecretStoreError('permission', 'managed paths must be real files and directories.');
      }
      const uid = process.getuid?.();
      if ((leaf || privateParent) && (stat.uid !== uid || (stat.mode & 0o077) !== 0)) {
        throw new SecretStoreError('permission', 'secret files and their directory must be owner-only.');
      }
      // Root-owned sticky /tmp is usable for isolated tests, never for the
      // private directory itself. Other writable ancestors permit replacement.
      const trustedSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
      if (!leaf && ((!trustedSticky && (stat.mode & 0o022) !== 0) || (stat.uid !== 0 && stat.uid !== uid))) {
        throw new SecretStoreError('permission', 'unsafe managed ancestor.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw secretStoreFailure(error);
    }
    const parent = dirname(current);
    if (parent === current) break;
    privateParent = leaf;
    leaf = false;
    current = parent;
  }
}

/** Synchronous: selection is durable before a credential consumer is returned. */
export function selectLinuxSecretBackend(
  paths: LinuxSecretPaths,
  requested: string,
): 'file' | 'libsecret' {
  try {
    if (!['auto', 'file', 'libsecret'].includes(requested)) throw new SecretStoreError('configuration', 'unsupported Linux backend.');
    for (const path of Object.values(paths)) assertLinuxSecretPath(path);
    ensurePrivateRootDirectorySync(dirname(paths.backendFilePath));
    return withFileLeaseSync(paths.backendFilePath, (lease) => {
      for (const path of Object.values(paths)) assertLinuxSecretPath(path);
      const text = readSecretFile(paths.backendFilePath);
      if (text !== undefined) {
        let selected: { version?: unknown; backend?: unknown };
        try { selected = JSON.parse(text); }
        catch { throw new SecretStoreError('corrupt', 'backend selection is invalid; restore it before starting.'); }
        if (!selected || selected.version !== 1 || !['file', 'libsecret'].includes(selected.backend as string)) {
          throw new SecretStoreError('corrupt', 'backend selection is invalid; restore it before starting.');
        }
        if (requested !== 'auto' && requested !== selected.backend) throw new SecretStoreError('configuration', 'ambient backend conflicts with the durable selection; no migration is supported.');
        return selected.backend as 'file' | 'libsecret';
      }
      if (readSecretFile(paths.encryptedFilePath) !== undefined || readSecretFile(paths.keyFilePath) !== undefined) {
        throw new SecretStoreError('configuration', `Existing secret data at ${paths.encryptedFilePath} or ${paths.keyFilePath} has no selection. Restore the selection or choose a fresh empty layout; no migration is supported.`);
      }
      const backend = requested === 'libsecret' ? 'libsecret' : 'file';
      lease.commit(() => writePrivateFileAtomicSync(paths.backendFilePath, JSON.stringify({ version: 1, backend }) + '\n'));
      return backend;
    });
  } catch (error) { throw secretStoreFailure(error); }
}

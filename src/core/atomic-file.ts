import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Replace a private file's contents so that a crash can only ever leave the old
 * contents or the new ones, never a truncated blend of the two.
 *
 * Written for files that hold the only copy of a credential. A rotating refresh
 * token is invalidated by the provider the instant it is spent, and an encrypted
 * secret store is a single authenticated blob that fails to decrypt if even one
 * byte is missing -- so a half-written file there is not a glitch to retry but a
 * credential lost until a human reauthorizes. Hence the flush before the rename,
 * and the directory flush after it: the rename is atomic for any reader either
 * way, but without the flushes a machine crash can still reorder it away.
 *
 * The temp file is created exclusively and carries the private mode from birth,
 * so the secret is never briefly world-readable.
 */
export async function writePrivateFileAtomic(path: string, text: string): Promise<void> {
  const temp = temporaryPathFor(path);
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(text, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(dirname(path));
}

/** The synchronous twin, for callers already committed to sync file access. */
export function writePrivateFileAtomicSync(path: string, text: string): void {
  const temp = temporaryPathFor(path);
  try {
    const descriptor = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(descriptor, text, { encoding: 'utf8' });
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The write already failed; a leftover temp file is not worth masking it.
    }
    throw error;
  }
  syncDirectorySync(dirname(path));
}

/** Remove one file and durably publish its absence to the containing directory. */
export function removeFileDurablySync(path: string): boolean {
  try {
    rmSync(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
  syncDirectorySync(dirname(path));
  return true;
}

/**
 * Create a private directory tree beneath an existing trusted root.
 *
 * Every new directory is published by fsyncing its parent before the next
 * descendant is created. Existing components must be real directories rather
 * than symlinks, so a managed path cannot escape its declared custody root.
 */
export function ensurePrivateDirectoryTreeSync(root: string, target: string): void {
  const normalizedRoot = resolveTrustedRoot(root);
  const normalizedTarget = resolveWithinRoot(normalizedRoot, target);
  assertDirectoryComponent(normalizedRoot);
  const suffix = relative(normalizedRoot, normalizedTarget);
  if (!suffix) return;
  let current = normalizedRoot;
  for (const component of suffix.split(sep)) {
    current = resolve(current, component);
    if (existsSync(current)) {
      assertDirectoryComponent(current);
      continue;
    }
    mkdirSync(current, { mode: 0o700 });
    syncDirectorySync(dirname(current));
    syncDirectorySync(current);
  }
}

/** Create a missing custody root from its nearest existing real ancestor. */
export function ensurePrivateRootDirectorySync(root: string): void {
  const normalizedRoot = resolveTrustedRoot(root);
  if (existsSync(normalizedRoot)) {
    assertDirectoryComponent(normalizedRoot, 'managed custody root');
    return;
  }
  let ancestor = dirname(normalizedRoot);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  assertDirectoryComponent(ancestor, 'managed custody root ancestor');
  ensurePrivateDirectoryTreeSync(ancestor, normalizedRoot);
}

/** Refuse any existing symlink/non-directory in a managed path's parent chain. */
export function assertManagedPathParentsSync(root: string, path: string, label: string): void {
  const normalizedRoot = resolveTrustedRoot(root);
  const normalizedPath = resolveWithinRoot(normalizedRoot, path);
  assertDirectoryComponent(normalizedRoot, label);
  const parent = dirname(normalizedPath);
  const suffix = relative(normalizedRoot, parent);
  if (!suffix) return;
  let current = normalizedRoot;
  for (const component of suffix.split(sep)) {
    current = resolve(current, component);
    if (!existsSync(current)) return;
    assertDirectoryComponent(current, label);
  }
}

function temporaryPathFor(path: string): string {
  return `${path}.${randomUUID()}.tmp`;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    try {
      await directory.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySyncError(error)) throw error;
    }
  } finally {
    await directory.close();
  }
}

export function syncDirectorySync(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    try {
      fsyncSync(descriptor);
    } catch (error) {
      if (!isUnsupportedDirectorySyncError(error)) throw error;
    }
  } finally {
    closeSync(descriptor);
  }
}

function resolveTrustedRoot(root: string): string {
  if (!isAbsolute(root) || /[\0\r\n]/.test(root)) {
    throw new Error(`Managed path root must be absolute: ${root}`);
  }
  return resolve(root);
}

function resolveWithinRoot(root: string, path: string): string {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) {
    throw new Error(`Managed path must be absolute: ${path}`);
  }
  const normalized = resolve(path);
  const suffix = relative(root, normalized);
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error(`Managed path escapes its custody root: ${path}`);
  }
  return normalized;
}

function assertDirectoryComponent(path: string, label = 'managed path'): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error(`Could not inspect ${label} directory component: ${path}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Refusing non-directory or symlink ${label} component: ${path}`);
  }
}

/**
 * Some documented platform/filesystem combinations cannot fsync a directory
 * descriptor. Those three shapes mean "unsupported"; I/O and permission
 * failures are durability failures and must reach the caller.
 */
export function isUnsupportedDirectorySyncError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === 'EINVAL' || error.code === 'EBADF' || error.code === 'ENOTSUP';
}

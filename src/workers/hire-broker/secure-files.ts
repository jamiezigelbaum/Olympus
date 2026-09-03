import { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { writePrivateFileAtomic } from '../../core/atomic-file.ts';
import { HireBrokerError } from './types.ts';

export async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function readPrivateFile(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new HireBrokerError('state_write_failed', 'Hire Broker state path is not a private regular file.', 503);
    }
    if ((info.mode & 0o077) !== 0) {
      throw new HireBrokerError('state_write_failed', 'Hire Broker state permissions are not private.', 503);
    }
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The jobs file this publishes carries the settlement latch a repeated report()
 * poll reads back, so the flushes are load-bearing: a rename is atomic for a
 * concurrent reader and says nothing about a power loss, and the loader treats
 * a zero-length jobs file as unrepairable corruption.
 */
export async function atomicWritePrivate(path: string, content: string): Promise<void> {
  await secureDirectory(dirname(path));
  try {
    await writePrivateFileAtomic(path, content);
  } catch (error) {
    if (error instanceof HireBrokerError) throw error;
    throw new HireBrokerError('state_write_failed', 'Hire Broker could not persist private state.', 503);
  }
}

export async function appendPrivateDurable(path: string, content: string): Promise<void> {
  await secureDirectory(dirname(path));
  try {
    const file = await open(path, 'a', 0o600);
    try {
      await file.chmod(0o600);
      await file.write(content);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch {
    throw new HireBrokerError('state_write_failed', 'Hire Broker could not append its security ledger.', 503);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

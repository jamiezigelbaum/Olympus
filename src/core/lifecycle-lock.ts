import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensurePrivateDirectoryTreeSync,
  removeFileDurablySync,
  syncDirectorySync,
  writePrivateFileAtomicSync,
} from './atomic-file.ts';
import {
  parseProcessInstanceIdentity,
  processInstanceIdentity,
  recordedProcessOwnerIsAlive,
  withFileLeaseSync,
  type ProcessInstanceIdentity,
} from './file-lease.ts';
import { OperationError } from './operation-error.ts';

export interface LifecycleMutationLock {
  release(): void;
}

interface LifecycleMutationOwnerV1 {
  schema_version: 1;
  pid: number;
  process_instance: ProcessInstanceIdentity;
  nonce: string;
  action: string;
  started_at: string;
}

export function acquireLifecycleMutationLock(
  homeDir: string,
  action: string,
  now: () => Date = () => new Date(),
): LifecycleMutationLock {
  const dir = join(homeDir, '.local', 'state', 'olympus', 'lifecycle');
  const lockPath = join(dir, 'mutation-v1.lock');
  ensurePrivateDirectoryTreeSync(homeDir, dir);
  const ownerProcessInstance = processInstanceIdentity(process.pid);
  if (!ownerProcessInstance) {
    throw new OperationError(
      'config_error',
      'Could not establish process-instance identity for exclusive Olympus lifecycle custody.',
      'Retry from a normal macOS or Linux user session where process identity can be inspected.',
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner: LifecycleMutationOwnerV1 = {
      schema_version: 1,
      pid: process.pid,
      process_instance: ownerProcessInstance,
      nonce: randomUUID(),
      action,
      started_at: now().toISOString(),
    };
    const candidate = join(dir, `mutation-owner-${owner.nonce}.tmp`);
    writePrivateFileAtomicSync(candidate, `${JSON.stringify(owner, null, 2)}\n`);
    try {
      linkSync(candidate, lockPath);
      syncDirectorySync(dir);
      removeFileDurablySync(candidate);
      return {
        release: () => releaseLifecycleMutationLock(lockPath, owner.nonce),
      };
    } catch (error) {
      if (existsSync(candidate)) removeFileDurablySync(candidate);
      if (!isAlreadyExists(error)) throw error;
      let activeOwner: LifecycleMutationOwnerV1 | undefined;
      withFileLeaseSync(join(dir, 'mutation-v1-recovery'), () => {
        const current = readLifecycleMutationOwner(lockPath);
        if (recordedProcessOwnerIsAlive(current.pid, current.process_instance)) {
          activeOwner = current;
          return;
        }
        removeFileDurablySync(lockPath);
        const staleCandidate = join(dir, `mutation-owner-${current.nonce}.tmp`);
        if (existsSync(staleCandidate)) removeFileDurablySync(staleCandidate);
      }, {
        acquireTimeoutMs: 1_000,
        pollIntervalMs: 10,
        staleAfterMs: 60_000,
        heartbeatIntervalMs: 20_000,
      });
      if (activeOwner) {
        throw new OperationError(
          'config_error',
          `Another Olympus worker lifecycle mutation is active (${activeOwner.action}, pid ${activeOwner.pid}).`,
          'Wait for that command to finish, then retry.',
        );
      }
    }
  }
  throw new OperationError('config_error', 'Could not acquire exclusive Olympus lifecycle mutation custody.');
}

function releaseLifecycleMutationLock(lockPath: string, nonce: string): void {
  const owner = readLifecycleMutationOwner(lockPath);
  if (owner.nonce !== nonce || owner.pid !== process.pid) {
    throw new OperationError(
      'config_error',
      'Olympus lifecycle mutation custody changed before release; refusing to remove another owner lock.',
    );
  }
  removeFileDurablySync(lockPath);
}

function readLifecycleMutationOwner(path: string): LifecycleMutationOwnerV1 {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('not a regular lock file');
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LifecycleMutationOwnerV1>;
    const processInstance = parseProcessInstanceIdentity(value.process_instance);
    if (
      value.schema_version !== 1
      || !Number.isSafeInteger(value.pid)
      || (value.pid ?? 0) <= 0
      || !processInstance
      || typeof value.nonce !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(value.nonce)
      || typeof value.action !== 'string'
      || !value.action
      || typeof value.started_at !== 'string'
      || !Number.isFinite(Date.parse(value.started_at))
    ) {
      throw new Error('invalid lock owner shape');
    }
    return { ...value, process_instance: processInstance } as LifecycleMutationOwnerV1;
  } catch (error) {
    throw new OperationError(
      'config_error',
      'The Olympus lifecycle mutation lock is unreadable; refusing to guess ownership.',
      error instanceof Error ? error.message : undefined,
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}

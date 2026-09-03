import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  __fileLeaseIdentityTestHooks,
  withFileLease,
  withFileLeaseSync,
  type FileLease,
} from '../src/core/file-lease.ts';
import { EncryptedFileSecretStore } from '../src/core/secret-store.ts';
import { JsonCredentialOAuth2StateStore } from '../src/workers/credential-broker/index.ts';
import { readConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';

interface CapturedChild {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

describe('credential cross-process fencing', () => {
  test('malformed boot IDs are omitted before process-instance comparison', () => {
    const fixtures = [
      {
        platform: 'linux' as const,
        malformedBootId: 'definitely-not-a-valid-boot-id',
        validBootId: '12345678-1234-1234-1234-123456789abc',
        mechanism: 'linux_procfs_start_ticks' as const,
        startTime: '12345',
      },
      {
        platform: 'darwin' as const,
        malformedBootId: 'definitely-not-a-valid-boot-id',
        validBootId: 'A2345678-1234-1234-1234-123456789ABC',
        mechanism: 'darwin_libproc' as const,
        startTime: '1720000000123456',
      },
    ];

    for (const fixture of fixtures) {
      const recorded = __fileLeaseIdentityTestHooks.parse({
        platform: fixture.platform,
        bootId: fixture.malformedBootId,
        mechanism: fixture.mechanism,
        startTime: fixture.startTime,
      });
      const current = __fileLeaseIdentityTestHooks.parse({
        platform: fixture.platform,
        bootId: fixture.validBootId,
        mechanism: fixture.mechanism,
        startTime: fixture.startTime,
      });

      expect(
        recorded && current
          ? __fileLeaseIdentityTestHooks.compare(recorded, current)
          : 'identity_missing',
      ).toBe('same');
      expect(recorded).toEqual({
        platform: fixture.platform,
        mechanism: fixture.mechanism,
        startTime: fixture.startTime,
      });
      expect(current?.bootId).toBe(fixture.validBootId);
    }
  });

  test('legacy Darwin boottime IDs are omitted so a calendar step cannot evict a live owner', () => {
    const recorded = __fileLeaseIdentityTestHooks.parse({
      platform: 'darwin',
      bootId: '1720000000.123456',
      mechanism: 'darwin_libproc',
      startTime: '1720000000123456',
    });
    const current = __fileLeaseIdentityTestHooks.parse({
      platform: 'darwin',
      bootId: 'A2345678-1234-1234-1234-123456789ABC',
      mechanism: 'darwin_libproc',
      startTime: '1720000000123456',
    });

    expect(recorded).toEqual({
      platform: 'darwin',
      mechanism: 'darwin_libproc',
      startTime: '1720000000123456',
    });
    expect(
      recorded && current
        ? __fileLeaseIdentityTestHooks.compare(recorded, current)
        : 'identity_missing',
    ).toBe('same');
  });

  test('Linux boot UUIDs compare canonically regardless of hex case', () => {
    const recorded = __fileLeaseIdentityTestHooks.parse({
      platform: 'linux',
      bootId: '12345678-ABCD-ABCD-ABCD-123456789ABC',
      mechanism: 'linux_procfs_start_ticks',
      startTime: '12345',
    });
    const current = __fileLeaseIdentityTestHooks.parse({
      platform: 'linux',
      bootId: '12345678-abcd-abcd-abcd-123456789abc',
      mechanism: 'linux_procfs_start_ticks',
      startTime: '12345',
    });

    expect(recorded?.bootId).toBe('12345678-abcd-abcd-abcd-123456789abc');
    expect(
      recorded && current
        ? __fileLeaseIdentityTestHooks.compare(recorded, current)
        : 'identity_missing',
    ).toBe('same');
  });

  test('two valid unequal boot IDs remain definitively different', () => {
    const fixtures = [
      {
        platform: 'linux' as const,
        firstBootId: '12345678-1234-1234-1234-123456789abc',
        secondBootId: 'abcdefab-cdef-abcd-efab-cdefabcdefab',
        mechanism: 'linux_procfs_start_ticks' as const,
        startTime: '12345',
      },
      {
        platform: 'darwin' as const,
        firstBootId: 'A2345678-1234-1234-1234-123456789ABC',
        secondBootId: 'B2345678-1234-1234-1234-123456789ABC',
        mechanism: 'darwin_libproc' as const,
        startTime: '1720000000123456',
      },
    ];

    for (const fixture of fixtures) {
      const first = __fileLeaseIdentityTestHooks.parse({
        platform: fixture.platform,
        bootId: fixture.firstBootId,
        mechanism: fixture.mechanism,
        startTime: fixture.startTime,
      });
      const second = __fileLeaseIdentityTestHooks.parse({
        platform: fixture.platform,
        bootId: fixture.secondBootId,
        mechanism: fixture.mechanism,
        startTime: fixture.startTime,
      });

      expect(
        first && second
          ? __fileLeaseIdentityTestHooks.compare(first, second)
          : 'identity_missing',
      ).toBe('different');
    }
  });

  test('a malformed recorded boot ID cannot evict a live owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-malformed-boot-id-'));
    const targetPath = join(dir, 'credential-state.json');
    const enteredPath = join(dir, 'owner-entered-commit');
    const releasePath = join(dir, 'release-owner');
    const lockPath = `${targetPath}.lock`;
    const guardPath = `${lockPath}.commit`;
    try {
      const owner = spawnBlockedCommitOwner({ targetPath, enteredPath, releasePath });
      await waitForFile(enteredPath);

      for (const path of [lockPath, guardPath]) {
        const record = JSON.parse(readFileSync(path, 'utf8')) as {
          processInstance: { bootId?: string };
        };
        record.processInstance.bootId = 'definitely-not-a-valid-boot-id';
        writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
      }
      await Bun.sleep(100);

      const contenderOutcome = await withTestFileLease(targetPath, async (lease) => {
        await lease.commit(async () => {
          appendFileSync(targetPath, 'contender_committed\n', { mode: 0o600 });
        });
      }).then(() => 'committed', errorCode);

      writeFileSync(releasePath, 'release\n', { mode: 0o600 });
      const ownerResult = await collectChild(owner);
      const commits = readFileSync(targetPath, 'utf8').trim().split('\n');

      expect(ownerResult.exitCode, ownerResult.stderr).toBe(0);
      expect(JSON.parse(ownerResult.stdout)).toEqual({ status: 'owner_committed' });
      expect(contenderOutcome).toBe('file_lease_busy');
      expect(commits).toEqual(['owner_committed']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('a live ps-fallback owner remains fenced when a native contender inspects it', async () => {
    if (process.platform !== 'darwin') return;
    const dir = mkdtempSync(join(tmpdir(), 'olympus-mixed-darwin-identity-'));
    const targetPath = join(dir, 'credential-state.json');
    const enteredPath = join(dir, 'owner-entered-commit');
    const releasePath = join(dir, 'release-owner');
    const lockPath = `${targetPath}.lock`;
    const guardPath = `${lockPath}.commit`;
    try {
      const owner = spawnBlockedCommitOwner({ targetPath, enteredPath, releasePath });
      await waitForFile(enteredPath);

      for (const path of [lockPath, guardPath]) {
        const record = JSON.parse(readFileSync(path, 'utf8')) as {
          processInstance: {
            platform: 'darwin';
            bootId?: string;
            startTime: string;
          };
        };
        const nativeSeconds = record.processInstance.startTime.includes('.')
          ? record.processInstance.startTime.split('.')[0]
          : (BigInt(record.processInstance.startTime) / 1_000_000n).toString();
        if (!nativeSeconds || !/^\d+$/.test(nativeSeconds)) {
          throw new Error(`Expected native Darwin epoch start time, got ${record.processInstance.startTime}`);
        }
        record.processInstance = {
          ...record.processInstance,
          mechanism: 'darwin_ps_lstart',
          // ps lstart is whole-second precision; the canonical unit is epoch
          // microseconds, so the lower six digits are necessarily zero.
          startTime: `${nativeSeconds}000000`,
        } as typeof record.processInstance;
        writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
      }
      await Bun.sleep(100);

      const contenderOutcome = await withTestFileLease(targetPath, async (lease) => {
        await lease.commit(async () => {
          appendFileSync(targetPath, 'contender_committed\n', { mode: 0o600 });
        });
      }).then(() => 'committed', errorCode);

      writeFileSync(releasePath, 'release\n', { mode: 0o600 });
      const ownerResult = await collectChild(owner);
      const commits = readFileSync(targetPath, 'utf8').trim().split('\n');

      expect(ownerResult.exitCode, ownerResult.stderr).toBe(0);
      expect(JSON.parse(ownerResult.stdout)).toEqual({ status: 'owner_committed' });
      expect(commits).toEqual(['owner_committed']);
      expect(contenderOutcome).toBe('file_lease_busy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('a live owner remains fenced when mixed Darwin mechanisms disagree by one second', async () => {
    if (process.platform !== 'darwin') return;
    const dir = mkdtempSync(join(tmpdir(), 'olympus-unequal-mixed-darwin-identity-'));
    const targetPath = join(dir, 'credential-state.json');
    const enteredPath = join(dir, 'owner-entered-commit');
    const releasePath = join(dir, 'release-owner');
    const lockPath = `${targetPath}.lock`;
    const guardPath = `${lockPath}.commit`;
    try {
      const owner = spawnBlockedCommitOwner({ targetPath, enteredPath, releasePath });
      await waitForFile(enteredPath);

      for (const path of [lockPath, guardPath]) {
        const record = JSON.parse(readFileSync(path, 'utf8')) as {
          processInstance: {
            platform: 'darwin';
            bootId?: string;
            startTime: string;
          };
        };
        const nativeSeconds = BigInt(record.processInstance.startTime) / 1_000_000n;
        record.processInstance = {
          ...record.processInstance,
          mechanism: 'darwin_ps_lstart',
          startTime: ((nativeSeconds + 1n) * 1_000_000n).toString(),
        } as typeof record.processInstance;
        writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
      }
      await Bun.sleep(100);

      const contenderOutcome = await withTestFileLease(targetPath, async (lease) => {
        await lease.commit(async () => {
          appendFileSync(targetPath, 'contender_committed\n', { mode: 0o600 });
        });
      }).then(() => 'committed', errorCode);

      writeFileSync(releasePath, 'release\n', { mode: 0o600 });
      const ownerResult = await collectChild(owner);
      const commits = readFileSync(targetPath, 'utf8').trim().split('\n');

      expect(ownerResult.exitCode, ownerResult.stderr).toBe(0);
      expect(JSON.parse(ownerResult.stdout)).toEqual({ status: 'owner_committed' });
      expect(commits).toEqual(['owner_committed']);
      expect(contenderOutcome).toBe('file_lease_busy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('an unpadded legacy-native microsecond suffix keeps its live owner fenced', async () => {
    if (process.platform !== 'darwin') return;
    const dir = mkdtempSync(join(tmpdir(), 'olympus-unpadded-darwin-identity-'));
    try {
      const {
        targetPath,
        enteredPath,
        releasePath,
        lockPath,
        guardPath,
        owner,
        seconds,
        microseconds,
      } = await spawnBlockedOwnerWithShortMicrosecondSuffix(dir);

      for (const path of [lockPath, guardPath]) {
        const record = JSON.parse(readFileSync(path, 'utf8')) as {
          processInstance: {
            platform: 'darwin';
            bootId?: string;
            mechanism?: string;
            startTime: string;
          };
        };
        record.processInstance = {
          platform: 'darwin',
          ...(record.processInstance.bootId ? { bootId: record.processInstance.bootId } : {}),
          startTime: `${seconds}.${microseconds}`,
        };
        writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
      }
      await Bun.sleep(100);

      const contenderOutcome = await withTestFileLease(targetPath, async (lease) => {
        await lease.commit(async () => {
          appendFileSync(targetPath, 'contender_committed\n', { mode: 0o600 });
        });
      }).then(() => 'committed', errorCode);

      writeFileSync(releasePath, 'release\n', { mode: 0o600 });
      const ownerResult = await collectChild(owner);
      const commits = readFileSync(targetPath, 'utf8').trim().split('\n');

      expect(enteredPath).toEndWith('owner-entered-commit');
      expect(microseconds.length).toBeLessThan(6);
      expect(ownerResult.exitCode, ownerResult.stderr).toBe(0);
      expect(JSON.parse(ownerResult.stdout)).toEqual({ status: 'owner_committed' });
      expect(commits).toEqual(['owner_committed']);
      expect(contenderOutcome).toBe('file_lease_busy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a stale commit guard from a reused PID instance recovers without leaving either fence behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-reused-pid-guard-'));
    const targetPath = join(dir, 'credential-state.json');
    const lockPath = `${targetPath}.lock`;
    const guardPath = `${lockPath}.commit`;
    const orphanedAt = new Date(Date.now() - 60 * 60_000);
    const reusedPidInstance = reusedProcessInstance('orphaned-boot-instance');
    try {
      writeFileSync(lockPath, JSON.stringify({
        version: 1,
        token: 'orphaned-main-lease',
        pid: process.pid,
        acquiredAt: orphanedAt.toISOString(),
        processInstance: reusedPidInstance,
      }), { mode: 0o600 });
      writeFileSync(guardPath, JSON.stringify({
        version: 1,
        token: 'orphaned-commit-guard',
        pid: process.pid,
        acquiredAt: orphanedAt.toISOString(),
        processInstance: reusedPidInstance,
      }), { mode: 0o600 });
      utimesSync(lockPath, orphanedAt, orphanedAt);
      utimesSync(guardPath, orphanedAt, orphanedAt);

      let outcome = 'not_attempted';
      try {
        await withTestFileLease(targetPath, async (lease) => {
          await lease.commit(async () => {
            writeFileSync(targetPath, 'recovered\n', { mode: 0o600 });
          });
        });
        outcome = 'committed';
      } catch (error) {
        outcome = errorCode(error);
      }

      expect(outcome).toBe('committed');
      expect(readFileSync(targetPath, 'utf8')).toBe('recovered\n');
      expect(existsSync(guardPath)).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failed commit releases both the commit guard and its main lease', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-failed-commit-cleanup-'));
    const targetPath = join(dir, 'credential-state.json');
    try {
      await expect(withTestFileLease(targetPath, async (lease) => {
        await lease.commit(async () => {
          throw new Error('deliberate commit failure');
        });
      })).rejects.toThrow('deliberate commit failure');
      expect(existsSync(`${targetPath}.lock.commit`)).toBe(false);
      expect(existsSync(`${targetPath}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the synchronous fence also recovers a stale guard from a reused PID instance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-reused-pid-sync-guard-'));
    const targetPath = join(dir, 'credential-state.json');
    const lockPath = `${targetPath}.lock`;
    const guardPath = `${lockPath}.commit`;
    const orphanedAt = new Date(Date.now() - 60 * 60_000);
    const record = {
      version: 1,
      pid: process.pid,
      acquiredAt: orphanedAt.toISOString(),
      processInstance: {
        ...reusedProcessInstance('orphaned-sync-boot-instance'),
      },
    };
    try {
      writeFileSync(lockPath, JSON.stringify({ ...record, token: 'orphaned-sync-main' }), { mode: 0o600 });
      writeFileSync(guardPath, JSON.stringify({ ...record, token: 'orphaned-sync-guard' }), { mode: 0o600 });
      utimesSync(lockPath, orphanedAt, orphanedAt);
      utimesSync(guardPath, orphanedAt, orphanedAt);

      withFileLeaseSync(targetPath, (lease) => lease.commit(() => {
        writeFileSync(targetPath, 'sync recovered\n', { mode: 0o600 });
      }), {
        acquireTimeoutMs: 1_000,
        pollIntervalMs: 5,
        staleAfterMs: 50,
        heartbeatIntervalMs: 10_000,
      });

      expect(readFileSync(targetPath, 'utf8')).toBe('sync recovered\n');
      expect(existsSync(guardPath)).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a live PID without obtainable recorded instance identity remains fenced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-unknown-instance-guard-'));
    const targetPath = join(dir, 'credential-state.json');
    const lockPath = `${targetPath}.lock`;
    const guardPath = `${lockPath}.commit`;
    const orphanedAt = new Date(Date.now() - 60 * 60_000);
    const legacyRecord = {
      version: 1,
      pid: process.pid,
      acquiredAt: orphanedAt.toISOString(),
    };
    try {
      writeFileSync(lockPath, JSON.stringify({
        ...legacyRecord,
        token: 'unknown-instance-main-lease',
      }), { mode: 0o600 });
      writeFileSync(guardPath, JSON.stringify({
        ...legacyRecord,
        token: 'unknown-instance-commit-guard',
      }), { mode: 0o600 });
      utimesSync(lockPath, orphanedAt, orphanedAt);
      utimesSync(guardPath, orphanedAt, orphanedAt);

      const error = await withTestFileLease(targetPath, async () => undefined)
        .catch((reason: unknown) => reason);

      expect(errorCode(error)).toBe('file_lease_busy');
      expect(existsSync(guardPath)).toBe(true);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('overlapping stale takeovers permit exactly one crash-consistency write and type-refuse the loser', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-stale-takeover-fence-'));
    const targetPath = join(dir, 'credential-state.json');
    const firstEnteredPath = join(dir, 'first-entered');
    const secondClaimedPath = join(dir, 'second-claimed');
    const releaseFirstPath = join(dir, 'release-first');
    try {
      const first = spawnStaleTakeoverContender({
        targetPath,
        enteredPath: firstEnteredPath,
        releasePath: releaseFirstPath,
        value: 'first',
      });
      await waitForFile(firstEnteredPath);

      // The first owner is deliberately slow and its heartbeat is longer than
      // staleAfterMs. The second real process must complete a stale takeover
      // while the first callback is still suspended.
      await Bun.sleep(100);
      const second = spawnStaleTakeoverContender({
        targetPath,
        enteredPath: secondClaimedPath,
        value: 'second',
      });
      await waitForFile(secondClaimedPath);
      const secondResult = await collectChild(second);

      writeFileSync(releaseFirstPath, 'release\n', { mode: 0o600 });
      const firstResult = await collectChild(first);
      const outcomes = [JSON.parse(firstResult.stdout), JSON.parse(secondResult.stdout)] as Array<{
        status: 'written' | 'refused';
        value: string;
        code?: string;
      }>;

      expect(firstResult.exitCode, firstResult.stderr).toBe(0);
      expect(secondResult.exitCode, secondResult.stderr).toBe(0);
      expect(outcomes.filter((outcome) => outcome.status === 'written')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'refused')).toEqual([{
        status: 'refused',
        value: 'first',
        code: 'file_lease_lost',
      }]);
      expect(readFileSync(targetPath, 'utf8')).toBe('second\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('two real processes never overlap one handle from load through provider exchange and durable save', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-handle-fence-'));
    const statePath = join(dir, 'credential-state.json');
    const encryptedFilePath = join(dir, 'secrets.enc');
    const keyFilePath = join(dir, 'secrets.key');
    const firstEntered = join(dir, 'first-provider-entered');
    const secondEntered = join(dir, 'second-provider-entered');
    const releaseFirst = join(dir, 'release-first');
    try {
      await new EncryptedFileSecretStore({ encryptedFilePath, keyFilePath })
        .set('x.refresh', 'refresh-token-generation-1');
      await new JsonCredentialOAuth2StateStore(statePath).save('x.bookmarks.personal', {
        status: 'available',
      });

      const first = spawnRefreshContender({
        statePath,
        encryptedFilePath,
        keyFilePath,
        enteredPath: firstEntered,
        releasePath: releaseFirst,
        accessToken: 'access-token-generation-2',
        refreshToken: 'refresh-token-generation-2',
        cacheNamespace: 'cross-process-first',
      });
      await waitForFile(firstEntered);

      const second = spawnRefreshContender({
        statePath,
        encryptedFilePath,
        keyFilePath,
        enteredPath: secondEntered,
        accessToken: 'access-token-generation-3',
        refreshToken: 'refresh-token-generation-3',
        cacheNamespace: 'cross-process-second',
      });
      await Bun.sleep(150);
      expect(existsSync(secondEntered)).toBe(false);

      writeFileSync(releaseFirst, 'release\n', { mode: 0o600 });
      const [firstResult, secondResult] = await Promise.all([
        collectChild(first),
        collectChild(second),
      ]);
      expect(firstResult.exitCode, firstResult.stderr).toBe(0);
      expect(secondResult.exitCode, secondResult.stderr).toBe(0);
      expect(JSON.parse(firstResult.stdout)).toEqual({ token: 'access-token-generation-2' });
      expect(JSON.parse(secondResult.stdout)).toEqual({ token: 'access-token-generation-3' });
      expect((await new JsonCredentialOAuth2StateStore(statePath).load('x.bookmarks.personal'))?.refreshToken)
        .toBe('refresh-token-generation-3');
      expect(await new EncryptedFileSecretStore({ encryptedFilePath, keyFilePath }).get('x.refresh'))
        .toBe('refresh-token-generation-3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('four real processes preserve every state, encrypted-secret, and registry update', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-credential-file-fence-'));
    const statePath = join(dir, 'credential-state.json');
    const encryptedFilePath = join(dir, 'secrets.enc');
    const keyFilePath = join(dir, 'secrets.key');
    const registryPath = join(dir, 'handles.json');
    const goPath = join(dir, 'go');
    const readyPaths = [0, 1, 2, 3].map((index) => join(dir, `ready-${index}`));
    try {
      const children = readyPaths.map((readyPath, processIndex) => Bun.spawn([
        process.execPath,
        '--eval',
        fileMutationContenderScript({
          processIndex,
          readyPath,
          goPath,
          statePath,
          encryptedFilePath,
          keyFilePath,
          registryPath,
        }),
      ], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      }));
      await Promise.all(readyPaths.map(waitForFile));
      writeFileSync(goPath, 'go\n', { mode: 0o600 });

      const results = await Promise.all(children.map(collectChild));
      for (const result of results) expect(result.exitCode, result.stderr).toBe(0);

      const expectedIds = [0, 1, 2, 3]
        .flatMap((processIndex) => [0, 1, 2, 3, 4].map((itemIndex) => `${processIndex}-${itemIndex}`));
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
        handles: Record<string, { refreshToken?: string }>;
      };
      expect(Object.keys(state.handles).sort()).toEqual(expectedIds.map((id) => `handle.${id}`).sort());

      const secrets = new EncryptedFileSecretStore({ encryptedFilePath, keyFilePath });
      expect(await secrets.list()).toEqual(expectedIds.map((id) => `secret.${id}`).sort());
      for (const id of expectedIds) expect(await secrets.get(`secret.${id}`)).toBe(`value-${id}`);

      expect(readConnectedHandleRegistry(registryPath).handles.map((handle) => handle.handle).sort())
        .toEqual(expectedIds.map((id) => `connected.${id}`).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

async function withTestFileLease<T>(
  targetPath: string,
  callback: (lease: FileLease) => Promise<T>,
): Promise<T> {
  return withFileLease(targetPath, callback, {
    acquireTimeoutMs: 1_000,
    pollIntervalMs: 5,
    staleAfterMs: 50,
    heartbeatIntervalMs: 10_000,
  });
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return 'unknown_error';
  return typeof error.code === 'string' ? error.code : 'unknown_error';
}

function reusedProcessInstance(bootId: string) {
  return process.platform === 'linux'
    ? {
      platform: 'linux' as const,
      bootId,
      mechanism: 'linux_procfs_start_ticks' as const,
      startTime: '1',
    }
    : {
      platform: 'darwin' as const,
      bootId,
      mechanism: 'darwin_libproc' as const,
      startTime: '1',
    };
}

function spawnRefreshContender(options: {
  statePath: string;
  encryptedFilePath: string;
  keyFilePath: string;
  enteredPath: string;
  releasePath?: string;
  accessToken: string;
  refreshToken: string;
  cacheNamespace: string;
}): CapturedChild {
  return Bun.spawn([process.execPath, '--eval', refreshContenderScript(options)], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  }) as unknown as CapturedChild;
}

function spawnStaleTakeoverContender(options: {
  targetPath: string;
  enteredPath: string;
  releasePath?: string;
  value: string;
}): CapturedChild {
  return Bun.spawn([process.execPath, '--eval', staleTakeoverContenderScript(options)], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  }) as unknown as CapturedChild;
}

function spawnBlockedCommitOwner(options: {
  targetPath: string;
  enteredPath: string;
  releasePath: string;
}): CapturedChild {
  return Bun.spawn([process.execPath, '--eval', `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { withFileLease } from './src/core/file-lease.ts';

await withFileLease(
  ${JSON.stringify(options.targetPath)},
  async (lease) => {
    await lease.commit(async () => {
      writeFileSync(${JSON.stringify(options.enteredPath)}, 'entered\\n', { mode: 0o600 });
      while (!existsSync(${JSON.stringify(options.releasePath)})) await Bun.sleep(5);
      appendFileSync(${JSON.stringify(options.targetPath)}, 'owner_committed\\n', { mode: 0o600 });
    });
  },
  {
    acquireTimeoutMs: 2_000,
    pollIntervalMs: 5,
    staleAfterMs: 50,
    heartbeatIntervalMs: 10_000,
  },
);
process.stdout.write(JSON.stringify({ status: 'owner_committed' }));
`], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  }) as unknown as CapturedChild;
}

async function spawnBlockedOwnerWithShortMicrosecondSuffix(rootDir: string): Promise<{
  targetPath: string;
  enteredPath: string;
  releasePath: string;
  lockPath: string;
  guardPath: string;
  owner: CapturedChild;
  seconds: string;
  microseconds: string;
}> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const attemptDir = join(rootDir, `attempt-${attempt}`);
    const targetPath = join(attemptDir, 'credential-state.json');
    const enteredPath = join(attemptDir, 'owner-entered-commit');
    const releasePath = join(attemptDir, 'release-owner');
    const lockPath = `${targetPath}.lock`;
    const guardPath = `${lockPath}.commit`;
    const owner = spawnBlockedCommitOwner({ targetPath, enteredPath, releasePath });
    await waitForFile(enteredPath);
    const record = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      processInstance: {
        mechanism: string;
        startTime: string;
      };
    };
    const canonicalStart = BigInt(record.processInstance.startTime);
    const microseconds = (canonicalStart % 1_000_000n).toString();
    if (record.processInstance.mechanism === 'darwin_libproc' && microseconds.length < 6) {
      return {
        targetPath,
        enteredPath,
        releasePath,
        lockPath,
        guardPath,
        owner,
        seconds: (canonicalStart / 1_000_000n).toString(),
        microseconds,
      };
    }
    writeFileSync(releasePath, 'release\n', { mode: 0o600 });
    const ownerResult = await collectChild(owner);
    if (ownerResult.exitCode !== 0) {
      throw new Error(`Owner probe failed: ${ownerResult.stderr}`);
    }
    rmSync(attemptDir, { recursive: true, force: true });
  }
  throw new Error('Could not start a Darwin owner in the first 100ms of a second.');
}

function staleTakeoverContenderScript(options: {
  targetPath: string;
  enteredPath: string;
  releasePath?: string;
  value: string;
}): string {
  return `
import { existsSync, writeFileSync } from 'node:fs';
import { withFileLease } from './src/core/file-lease.ts';

try {
  await withFileLease(
    ${JSON.stringify(options.targetPath)},
    async (lease) => {
      writeFileSync(${JSON.stringify(options.enteredPath)}, 'entered\\n', { mode: 0o600 });
      ${options.releasePath
        ? `while (!existsSync(${JSON.stringify(options.releasePath)})) await Bun.sleep(5);`
        : ''}
      await lease.commit(async () => {
        writeFileSync(${JSON.stringify(options.targetPath)}, ${JSON.stringify(`${options.value}\n`)}, { mode: 0o600 });
      });
    },
    {
      acquireTimeoutMs: 2_000,
      pollIntervalMs: 5,
      staleAfterMs: 50,
      heartbeatIntervalMs: 10_000,
    },
  );
  process.stdout.write(JSON.stringify({ status: 'written', value: ${JSON.stringify(options.value)} }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 'refused',
    value: ${JSON.stringify(options.value)},
    code: error?.code,
  }));
}
`;
}

function refreshContenderScript(options: {
  statePath: string;
  encryptedFilePath: string;
  keyFilePath: string;
  enteredPath: string;
  releasePath?: string;
  accessToken: string;
  refreshToken: string;
  cacheNamespace: string;
}): string {
  return `
import { existsSync, writeFileSync } from 'node:fs';
import {
  JsonCredentialOAuth2StateStore,
  createEnvCredentialBroker,
} from './src/workers/credential-broker/index.ts';
import { EncryptedFileSecretStore } from './src/core/secret-store.ts';

const broker = createEnvCredentialBroker({
  env: {
    OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_ID: 'client-id',
    OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_SECRET: 'client-secret',
  },
  handles: [{
    handle: 'x.bookmarks.personal',
    provider: 'x',
    allowedCapabilities: ['x.bookmarks.sync'],
    tokenEnvNames: [],
    scopes: ['tweet.read', 'bookmark.read', 'offline.access'],
    trustDomain: 'internal',
    oauth2Refresh: {
      tokenUrl: 'https://api.x.test/token',
      clientIdEnvNames: ['OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_ID'],
      clientSecretEnvNames: ['OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_SECRET'],
      refreshTokenEnvNames: [],
      refreshTokenSecretRef: 'store:x.refresh',
      scopes: ['tweet.read', 'bookmark.read', 'offline.access'],
    },
  }],
  loadDefaultHandleRegistry: false,
  secretStore: new EncryptedFileSecretStore({
    encryptedFilePath: ${JSON.stringify(options.encryptedFilePath)},
    keyFilePath: ${JSON.stringify(options.keyFilePath)},
  }),
  oauth2StateStore: new JsonCredentialOAuth2StateStore(${JSON.stringify(options.statePath)}),
  oauth2CacheNamespace: ${JSON.stringify(options.cacheNamespace)},
  oauth2LeaseOptions: { acquireTimeoutMs: 5_000, pollIntervalMs: 10, staleAfterMs: 1_000 },
  fetch: async () => {
    writeFileSync(${JSON.stringify(options.enteredPath)}, 'entered\\n', { mode: 0o600 });
    ${options.releasePath
      ? `while (!existsSync(${JSON.stringify(options.releasePath)})) await Bun.sleep(10);`
      : ''}
    return new Response(JSON.stringify({
      access_token: ${JSON.stringify(options.accessToken)},
      refresh_token: ${JSON.stringify(options.refreshToken)},
      expires_in: 7200,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
});
const session = await broker.issueSession({
  handle: 'x.bookmarks.personal',
  provider: 'x',
  capability: 'x.bookmarks.sync',
  trustDomain: 'internal',
});
process.stdout.write(JSON.stringify({ token: session.token }));
`;
}

function fileMutationContenderScript(options: {
  processIndex: number;
  readyPath: string;
  goPath: string;
  statePath: string;
  encryptedFilePath: string;
  keyFilePath: string;
  registryPath: string;
}): string {
  return `
import { existsSync, writeFileSync } from 'node:fs';
import { EncryptedFileSecretStore } from './src/core/secret-store.ts';
import { JsonCredentialOAuth2StateStore } from './src/workers/credential-broker/index.ts';
import { upsertConnectedHandle } from './src/workers/credential-broker/connected-handles.ts';

const processIndex = ${options.processIndex};
const secrets = new EncryptedFileSecretStore({
  encryptedFilePath: ${JSON.stringify(options.encryptedFilePath)},
  keyFilePath: ${JSON.stringify(options.keyFilePath)},
});
const states = new JsonCredentialOAuth2StateStore(${JSON.stringify(options.statePath)});
writeFileSync(${JSON.stringify(options.readyPath)}, 'ready\\n', { mode: 0o600 });
while (!existsSync(${JSON.stringify(options.goPath)})) await Bun.sleep(5);
for (let itemIndex = 0; itemIndex < 5; itemIndex += 1) {
  const id = processIndex + '-' + itemIndex;
  await secrets.set('secret.' + id, 'value-' + id);
  await states.save('handle.' + id, {
    refreshToken: 'refresh-' + id,
    status: 'available',
  });
  upsertConnectedHandle({
    handle: 'connected.' + id,
    provider: 'x',
    allowedCapabilities: ['x.bookmarks.sync'],
    scopes: ['tweet.read'],
    tokenSecretRefs: ['store:secret.' + id],
    connectedAt: '2026-07-30T12:00:00.000Z',
  }, ${JSON.stringify(options.registryPath)});
}
process.stdout.write('ok');
`;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
    await Bun.sleep(10);
  }
}

async function collectChild(child: CapturedChild): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

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

  test('a failed commit releases the lease', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-failed-commit-cleanup-'));
    const targetPath = join(dir, 'credential-state.json');
    try {
      await expect(withTestFileLease(targetPath, async (lease) => {
        await lease.commit(async () => {
          throw new Error('deliberate commit failure');
        });
      })).rejects.toThrow('deliberate commit failure');
      await expect(withTestFileLease(targetPath, async () => 'reacquired')).resolves.toBe('reacquired');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MessagingCaptureSupervisor,
  saveMessagingCaptureGrant,
  type CaptureChild,
} from '../src/core/messaging-capture.ts';
import {
  TELEGRAM_API_HASH_SECRET_KEY,
  TELEGRAM_API_ID_SECRET_KEY,
  type MessagingPairingConnectedResult,
} from '../src/core/messaging-pairing.ts';
import type { SecretStore } from '../src/core/secret-store.ts';

function secretStore(values: Record<string, string>): SecretStore {
  const stored = new Map(Object.entries(values));
  return {
    label: 'memory',
    get: async (key) => stored.get(key),
    set: async (key, value) => { stored.set(key, value); },
    delete: async (key) => { stored.delete(key); },
    list: async () => [...stored.keys()],
  };
}

function telegramPairing(sessionPath: string): MessagingPairingConnectedResult {
  return {
    ok: true,
    source: 'telegram',
    handles: ['telegram.personal'],
    secretRefs: [],
    status: 'connected',
    sessionPath,
    accountProof: 'telegram:fixture',
    chats: [{ chatScope: 'telegram.personal:chat:101', kind: 'dm', title: 'Ada' }],
    captureStarted: false,
    registered: true,
    producer: {
      source: 'telegram',
      executable: '/fixture/python3',
      args: ['/fixture/telegram-telethon-reader.py', '--gateway'],
      env: {
        OLYMPUS_TELEGRAM_SESSION_PATH: sessionPath,
        OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES: 'telegram.personal:chat:101',
      },
      secretEnvironment: [
        { env: 'OLYMPUS_TELEGRAM_API_ID', secretKey: TELEGRAM_API_ID_SECRET_KEY },
        { env: 'OLYMPUS_TELEGRAM_API_HASH', secretKey: TELEGRAM_API_HASH_SECRET_KEY },
      ],
      captureStarted: false,
    },
  };
}

describe('messaging capture supervisor', () => {
  test('starts only from stored scope plus an available handle, then stops on handle revocation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-messaging-capture-'));
    const registryPath = join(root, 'handles.json');
    const grantPath = join(root, 'messaging-capture.json');
    const sessionPath = join(root, 'telegram.personal');
    writeFileSync(`${sessionPath}.session`, 'fixture');
    writeRegistry(registryPath, true);
    saveMessagingCaptureGrant({ path: grantPath, pairing: telegramPairing(sessionPath) });
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    let killed = false;
    let spawnedEnv: Record<string, string> | undefined;
    const child: CaptureChild = {
      exited,
      kill: () => { killed = true; resolveExit(0); },
    };
    const supervisor = new MessagingCaptureSupervisor({
      source: 'telegram',
      registryPath,
      grantPath,
      baseEnv: {},
      packageRoot: '/fixture',
      pythonExecutable: '/fixture/python3',
      secretStore: secretStore({
        [TELEGRAM_API_ID_SECRET_KEY]: '12345',
        [TELEGRAM_API_HASH_SECRET_KEY]: 'fixture-secret',
      }),
      spawn: (input) => {
        spawnedEnv = input.env;
        expect(input.args).toEqual(['/fixture/scripts/telegram-telethon-reader.py', '--gateway']);
        return child;
      },
    });

    expect(await supervisor.reconcile()).toEqual({ source: 'telegram', state: 'running' });
    expect(spawnedEnv?.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES).toBe('telegram.personal:chat:101');
    expect(spawnedEnv?.OLYMPUS_TELEGRAM_API_HASH).toBe('fixture-secret');

    writeRegistry(registryPath, false);
    expect(await supervisor.reconcile()).toEqual({
      source: 'telegram', state: 'stopped', reason: 'handle_unavailable',
    });
    expect(killed).toBe(true);
  });

  test('does not start when a required secret is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-messaging-capture-'));
    const registryPath = join(root, 'handles.json');
    const grantPath = join(root, 'messaging-capture.json');
    const sessionPath = join(root, 'telegram.personal');
    writeFileSync(`${sessionPath}.session`, 'fixture');
    writeRegistry(registryPath, true);
    saveMessagingCaptureGrant({ path: grantPath, pairing: telegramPairing(sessionPath) });
    let spawned = false;
    const supervisor = new MessagingCaptureSupervisor({
      source: 'telegram',
      registryPath,
      grantPath,
      baseEnv: {},
      packageRoot: '/fixture',
      pythonExecutable: '/fixture/python3',
      secretStore: secretStore({ [TELEGRAM_API_ID_SECRET_KEY]: '12345' }),
      spawn: () => {
        spawned = true;
        throw new Error('must not spawn');
      },
    });
    expect(await supervisor.reconcile()).toEqual({
      source: 'telegram', state: 'blocked', reason: 'secret_missing',
    });
    expect(spawned).toBe(false);
  });

  test('rejects a writable capture grant before executing its launch contract', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-messaging-capture-grant-'));
    const registryPath = join(root, 'handles.json');
    const grantPath = join(root, 'messaging-capture.json');
    const sessionPath = join(root, 'telegram.personal');
    writeFileSync(`${sessionPath}.session`, 'fixture');
    writeRegistry(registryPath, true);
    saveMessagingCaptureGrant({ path: grantPath, pairing: telegramPairing(sessionPath) });
    chmodSync(grantPath, 0o666);
    let spawned = false;
    const supervisor = new MessagingCaptureSupervisor({
      source: 'telegram', registryPath, grantPath, stopTimeoutMs: 2,
      spawn: () => { spawned = true; throw new Error('must not spawn'); },
    });
    expect(await supervisor.reconcile()).toEqual({ state: 'blocked', reason: 'grant_invalid' });
    expect(spawned).toBe(false);
  });

  test('waits for confirmed exit after escalating an ignored SIGTERM to SIGKILL', async () => {
    let resolveExit!: (code: number) => void;
    const signals: NodeJS.Signals[] = [];
    const child: CaptureChild = {
      exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
      kill: (signal = 'SIGTERM') => {
        signals.push(signal);
        if (signal === 'SIGKILL') resolveExit(137);
      },
    };
    const supervisor = runningSupervisorFixture(child, 2);
    expect(await supervisor.reconcile()).toEqual({ source: 'telegram', state: 'running' });
    await expect(supervisor.stop()).resolves.toBeUndefined();
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('rejects and retains custody when exit is not observed after SIGKILL', async () => {
    const signals: NodeJS.Signals[] = [];
    const child: CaptureChild = {
      exited: new Promise<number>(() => {}),
      kill: (signal = 'SIGTERM') => { signals.push(signal); },
    };
    const supervisor = runningSupervisorFixture(child, 2);
    expect(await supervisor.reconcile()).toEqual({ source: 'telegram', state: 'running' });
    await expect(supervisor.stop()).rejects.toThrow(/custody is retained/);
    // A second stop reaches the same child, proving the failed stop did not
    // discard its handle and falsely release session custody.
    await expect(supervisor.stop()).rejects.toThrow(/custody is retained/);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL']);
  });
});

function runningSupervisorFixture(child: CaptureChild, stopTimeoutMs: number): MessagingCaptureSupervisor {
  const root = mkdtempSync(join(tmpdir(), 'olympus-messaging-capture-stop-'));
  const registryPath = join(root, 'handles.json');
  const grantPath = join(root, 'messaging-capture.json');
  const sessionPath = join(root, 'telegram.personal');
  writeFileSync(`${sessionPath}.session`, 'fixture');
  writeRegistry(registryPath, true);
  saveMessagingCaptureGrant({ path: grantPath, pairing: telegramPairing(sessionPath) });
  return new MessagingCaptureSupervisor({
    source: 'telegram',
    registryPath,
    grantPath,
    baseEnv: {},
    packageRoot: '/fixture',
    pythonExecutable: '/fixture/python3',
    stopTimeoutMs,
    secretStore: secretStore({
      [TELEGRAM_API_ID_SECRET_KEY]: '12345',
      [TELEGRAM_API_HASH_SECRET_KEY]: 'fixture-secret',
    }),
    spawn: () => child,
  });
}

function writeRegistry(path: string, available: boolean): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    version: 1,
    handles: available ? [{
      handle: 'telegram.personal',
      provider: 'telegram',
      sessionKind: 'mtproto_session',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      allowedCapabilities: ['telegram.messages.sync'],
      scopes: [],
      tokenSecretRefs: [],
      backendState: { kind: 'mtproto_session', status: 'available' },
      connectedAt: '2026-09-14T00:00:00.000Z',
    }] : [],
  }));
}

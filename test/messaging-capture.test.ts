import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MESSAGING_CAPTURE_REPEATED_EXITS,
  MessagingCaptureSupervisor,
  defaultMessagingCaptureGrantPath,
  effectiveMessagingCaptureStatus,
  readMessagingCaptureGrantFacts,
  readMessagingCaptureScope,
  saveMessagingCaptureGrant,
  type CaptureChild,
  type MessagingCaptureStatus,
  type SpawnCapture,
} from '../src/core/messaging-capture.ts';
import {
  TELEGRAM_API_HASH_SECRET_KEY,
  TELEGRAM_API_ID_SECRET_KEY,
  type MessagingPairingConnectedResult,
} from '../src/core/messaging-pairing.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import {
  createWorkerMessagingCaptureOwnership,
  reconcileWorkerCaptures,
  workerCaptureRuntime,
} from '../src/workers/email-source/server.ts';

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
  for (const state of ['unpair_in_progress', 'unpaired', 'unpair_incomplete', 'unreadable']) {
    test(`does not resume a retained session when the durable latch is ${state}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'olympus-capture-unpaired-'));
      const registryPath = join(root, 'handles.json');
      const grantPath = join(root, 'grant.json');
      const sessionPath = join(root, 'telegram');
      writeRegistry(registryPath, true);
      writeFileSync(`${sessionPath}.session`, 'fixture');
      saveMessagingCaptureGrant({ path: grantPath, pairing: telegramPairing(sessionPath) });
      writeFileSync(`${registryPath}.unpaired`, state === 'unreadable' ? '{broken' : JSON.stringify({
        version: 1, sources: [{ source_id: 'telegram.messages', state }],
      }));
      let spawned = false;
      const supervisor = new MessagingCaptureSupervisor({
        source: 'telegram', registryPath, grantPath,
        secretStore: secretStore({ [TELEGRAM_API_ID_SECRET_KEY]: '12345', [TELEGRAM_API_HASH_SECRET_KEY]: 'fixture' }),
        spawn: () => { spawned = true; throw new Error('must not spawn'); },
      });
      expect(await supervisor.reconcile()).toEqual({ source: 'telegram', state: 'stopped', reason: 'handle_unavailable' });
      expect(spawned).toBe(false);
    });
  }

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

  test('a Telegram whose private Python is gone gets it installed again, and one that cannot be never starts', async () => {
    // test-omarchy 2026-10-29: with the environment removed, capture started a Python without Telethon that exited at once.
    const root = mkdtempSync(join(tmpdir(), 'olympus-messaging-capture-python-'));
    const registryPath = join(root, 'handles.json');
    const grantPath = join(root, 'messaging-capture.json');
    const sessionPath = join(root, 'telegram.personal');
    writeFileSync(`${sessionPath}.session`, 'fixture');
    writeRegistry(registryPath, true);
    saveMessagingCaptureGrant({ path: grantPath, pairing: telegramPairing(sessionPath) });
    const venvDir = join(root, 'xdg', 'olympus', 'telegram-python');
    let installs = 0;
    let installWorks = false;
    const spawned: string[] = [];
    const supervisor = new MessagingCaptureSupervisor({
      source: 'telegram', registryPath, grantPath, packageRoot: '/fixture',
      baseEnv: { XDG_CACHE_HOME: join(root, 'xdg') },
      secretStore: secretStore({ [TELEGRAM_API_ID_SECRET_KEY]: '12345', [TELEGRAM_API_HASH_SECRET_KEY]: 'fixture' }),
      pythonHasTelethon: async () => false,
      provisionTelegramPython: async (input) => {
        installs += 1;
        expect(input.venvDir).toBe(venvDir);
        if (!installWorks) return false;
        mkdirSync(join(input.venvDir, 'bin'), { recursive: true });
        writeFileSync(join(input.venvDir, 'bin', 'python'), '');
        return true;
      },
      spawn: (input) => { spawned.push(input.executable); return { exited: new Promise<number>(() => {}), kill: () => {} }; },
    });
    await expect(supervisor.reconcile()).rejects.toThrow(/could not install Telethon/);
    expect(spawned).toEqual([]);
    installWorks = true;
    expect(await supervisor.reconcile()).toEqual({ source: 'telegram', state: 'running' });
    expect(spawned).toEqual([join(venvDir, 'bin', 'python')]);
    expect(installs).toBe(2);
  });

  test('a stop while Telegram\'s Python is being installed keeps that reconcile from starting a helper', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-messaging-capture-stop-'));
    const registryPath = join(root, 'handles.json');
    const grantPath = join(root, 'messaging-capture.json');
    const sessionPath = join(root, 'telegram.personal');
    writeFileSync(`${sessionPath}.session`, 'fixture');
    writeRegistry(registryPath, true);
    saveMessagingCaptureGrant({ path: grantPath, pairing: telegramPairing(sessionPath) });
    let finishInstall!: () => void;
    let installStarted!: () => void;
    const started = new Promise<void>((resolve) => { installStarted = resolve; });
    let spawned = false;
    const supervisor = new MessagingCaptureSupervisor({
      source: 'telegram', registryPath, grantPath, packageRoot: '/fixture',
      baseEnv: { XDG_CACHE_HOME: join(root, 'xdg') },
      secretStore: secretStore({ [TELEGRAM_API_ID_SECRET_KEY]: '12345', [TELEGRAM_API_HASH_SECRET_KEY]: 'fixture' }),
      pythonHasTelethon: async () => false,
      provisionTelegramPython: (input) => new Promise<boolean>((resolve) => {
        installStarted();
        finishInstall = () => {
          mkdirSync(join(input.venvDir, 'bin'), { recursive: true });
          writeFileSync(join(input.venvDir, 'bin', 'python'), '');
          resolve(true);
        };
      }),
      spawn: () => { spawned = true; return { exited: new Promise<number>(() => {}), kill: () => {} }; },
    });
    const reconciling = supervisor.reconcile();
    await started;
    await supervisor.stop();
    finishInstall();
    expect((await reconciling).state).toBe('stopped');
    expect(spawned).toBe(false);
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

describe('worker and native capture ownership', () => {
  test('retains the grant and session without constructing a second supervisor when native capture owns the source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-native-capture-owner-'));
    const registryPath = join(root, 'handles.json');
    const sessionPath = join(root, 'telegram.personal');
    const grantPath = defaultMessagingCaptureGrantPath('telegram', registryPath);
    writeRegistry(registryPath, true);
    writeFileSync(`${sessionPath}.session`, 'fixture');
    saveMessagingCaptureGrant({ path: grantPath, pairing: telegramPairing(sessionPath) });
    let supervisorConstructed = false;
    let grantRevoked = false;
    const ownership = createWorkerMessagingCaptureOwnership({
      env: {
        OLYMPUS_NATIVE_TELEGRAM_CAPTURE_OWNER: 'true',
        OLYMPUS_NATIVE_WHATSAPP_CAPTURE_OWNER: 'true',
      },
      registryPath,
      packageRoot: '/fixture',
      createSupervisor: () => {
        supervisorConstructed = true;
        throw new Error('must not construct a worker capture supervisor');
      },
      revokeGrant: () => { grantRevoked = true; },
    });

    expect(ownership.captures).toEqual({});
    expect(supervisorConstructed).toBe(false);
    await expect(ownership.stopForUnpair('telegram')).rejects.toThrow(
      'Disable worker.telegramCapture.enabled, wait for the native capture service to stop, then retry Unpair.',
    );
    expect(grantRevoked).toBe(false);
    expect(existsSync(grantPath)).toBe(true);
    expect(existsSync(`${sessionPath}.session`)).toBe(true);
  });
});

function whatsappPairing(allowedJids: string): MessagingPairingConnectedResult {
  return {
    ...telegramPairing('/fixture/whatsapp'),
    source: 'whatsapp',
    handles: ['whatsapp.personal_local'],
    producer: {
      source: 'whatsapp',
      executable: '/fixture/olympus-whatsapp-bridge',
      args: ['--capture-approved'],
      env: { OLYMPUS_WHATSAPP_STATE_DIR: '/fixture/whatsapp', OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS: allowedJids },
      secretEnvironment: [],
      captureStarted: false,
    },
  } as unknown as MessagingPairingConnectedResult;
}

describe('approved capture scope, as a count', () => {
  const grants = () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-capture-scope-'));
    return { root, registryPath: join(root, 'handles.json') };
  };

  test('says how many chats were approved, never which', () => {
    const { registryPath } = grants();
    const path = defaultMessagingCaptureGrantPath('telegram', registryPath);
    saveMessagingCaptureGrant({ path, pairing: telegramPairing('/fixture/telegram') });
    expect(readMessagingCaptureScope('telegram', path)).toEqual({ kind: 'chats', count: 1 });
    const several = telegramPairing('/fixture/telegram');
    several.producer.env.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES = 'telegram.personal:chat:101, telegram.personal:chat:102,telegram.personal:chat:101';
    saveMessagingCaptureGrant({ path, pairing: several });
    expect(readMessagingCaptureScope('telegram', path)).toEqual({ kind: 'chats', count: 2 });
  });

  test('Telegram whole-account scope is explicit and malformed mixed wildcard grants have no scope', () => {
    const { registryPath } = grants();
    const path = defaultMessagingCaptureGrantPath('telegram', registryPath);
    const pairing = telegramPairing('/fixture/telegram');
    pairing.producer.env.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES = '*';
    saveMessagingCaptureGrant({ path, pairing });
    expect(readMessagingCaptureScope('telegram', path)).toEqual({ kind: 'whole_account' });
    pairing.producer.env.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES = '*,telegram.personal:chat:101';
    saveMessagingCaptureGrant({ path, pairing });
    expect(readMessagingCaptureScope('telegram', path)).toBeUndefined();
  });

  test('a WhatsApp grant of * is the whole linked account; exact chats are a count', () => {
    const { registryPath } = grants();
    const path = defaultMessagingCaptureGrantPath('whatsapp', registryPath);
    saveMessagingCaptureGrant({ path, pairing: whatsappPairing('*') });
    expect(readMessagingCaptureScope('whatsapp', path)).toEqual({ kind: 'whole_account' });
    saveMessagingCaptureGrant({ path, pairing: whatsappPairing('111@s.whatsapp.net,222@g.us') });
    expect(readMessagingCaptureScope('whatsapp', path)).toEqual({ kind: 'chats', count: 2 });
  });

  test('no scope when there is no readable grant, when it names another source, or when it approves nothing', () => {
    const { root, registryPath } = grants();
    const path = defaultMessagingCaptureGrantPath('telegram', registryPath);
    expect(readMessagingCaptureScope('telegram', path)).toBeUndefined();
    saveMessagingCaptureGrant({ path, pairing: telegramPairing('/fixture/telegram') });
    expect(readMessagingCaptureScope('whatsapp', path)).toBeUndefined();
    const empty = telegramPairing('/fixture/telegram');
    empty.producer.env.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES = ' , ';
    saveMessagingCaptureGrant({ path, pairing: empty });
    expect(readMessagingCaptureScope('telegram', path)).toBeUndefined();
    // A writable grant is refused here exactly as the supervisor refuses it.
    saveMessagingCaptureGrant({ path, pairing: telegramPairing('/fixture/telegram') });
    chmodSync(path, 0o666);
    expect(readMessagingCaptureScope('telegram', path)).toBeUndefined();
    expect(existsSync(root)).toBe(true);
  });
});

const PAIRED = new Date('2026-10-20T10:00:00.000Z');

describe('the worker reports capture to the dashboard', () => {
  test('supervisor state, scope and pairing time by source id, only for sources this worker runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-capture-runtime-'));
    const registryPath = join(root, 'handles.json');
    saveMessagingCaptureGrant({ path: defaultMessagingCaptureGrantPath('telegram', registryPath), pairing: telegramPairing('/fixture/telegram'), now: PAIRED });
    saveMessagingCaptureGrant({ path: defaultMessagingCaptureGrantPath('whatsapp', registryPath), pairing: whatsappPairing('*'), now: PAIRED });
    expect(workerCaptureRuntime({
      sources: ['telegram', 'whatsapp'],
      statuses: {
        telegram: { source: 'telegram', state: 'blocked', reason: 'session_missing' },
        whatsapp: { source: 'whatsapp', state: 'running' },
      },
      registryPath,
    })).toEqual({
      'telegram.messages': { supervisor: { state: 'blocked', reason: 'session_missing' }, scope: { kind: 'chats', count: 1 }, paired_at: PAIRED.toISOString() },
      'whatsapp.personal.messages': { supervisor: { state: 'running' }, scope: { kind: 'whole_account' }, paired_at: PAIRED.toISOString() },
    });
    // The native service owns Telegram capture here: this worker says nothing of it.
    expect(Object.keys(workerCaptureRuntime({
      sources: ['whatsapp'],
      statuses: { telegram: { source: 'telegram', state: 'running' }, whatsapp: { source: 'whatsapp', state: 'running' } },
      registryPath,
    }))).toEqual(['whatsapp.personal.messages']);
  });

  test('before the first reconcile and without a grant there is nothing to report', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-capture-runtime-empty-'));
    expect(workerCaptureRuntime({ sources: ['telegram', 'whatsapp'], statuses: {}, registryPath: join(root, 'handles.json') })).toEqual({});
  });

  test('a supervisor that stopped for a reason that is no fault still reports its state', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-capture-runtime-stopped-'));
    expect(workerCaptureRuntime({
      sources: ['telegram'],
      statuses: { telegram: { state: 'stopped', reason: 'grant_missing' } },
      registryPath: join(root, 'handles.json'),
    })).toEqual({ 'telegram.messages': { supervisor: { state: 'stopped', reason: 'grant_missing' } } });
  });
});

/** A helper process the test ends by hand, as if it had died on its own. */
function mortalChild(): { child: CaptureChild; die: (code?: number) => void; signals: NodeJS.Signals[] } {
  let end!: (code: number) => void;
  const signals: NodeJS.Signals[] = [];
  const exited = new Promise<number>((resolve) => { end = resolve; });
  return {
    child: { exited, kill: (signal = 'SIGTERM') => { signals.push(signal); end(0); } },
    die: (code = 1) => end(code),
    signals,
  };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('a helper that exits on its own is not reported as running', () => {
  test('a helper that died is not alive and is counted as an exit of its own', async () => {
    const helper = mortalChild();
    const supervisor = captureSupervisorFixture({ spawn: () => helper.child });
    expect(await supervisor.reconcile()).toEqual({ source: 'telegram', state: 'running' });
    expect(supervisor.liveness()).toEqual({ alive: true, unexpectedExits: 0 });
    helper.die(1);
    await settle();
    expect(supervisor.liveness()).toEqual({ alive: false, unexpectedExits: 1 });
  });

  test('stopping the helper ourselves is not an exit of its own', async () => {
    const helper = mortalChild();
    const supervisor = captureSupervisorFixture({ spawn: () => helper.child });
    await supervisor.reconcile();
    await supervisor.stop();
    await settle();
    expect(helper.signals).toEqual(['SIGTERM']);
    expect(supervisor.liveness()).toEqual({ alive: false, unexpectedExits: 0 });
  });

  test('a helper that keeps dying is reported helper_exited over a last reconcile that still says running', async () => {
    let clock = 1_000_000;
    const helpers: Array<ReturnType<typeof mortalChild>> = [];
    const supervisor = captureSupervisorFixture({
      now: () => clock,
      spawn: () => { const helper = mortalChild(); helpers.push(helper); return helper.child; },
    });
    let lastReconcile: MessagingCaptureStatus | undefined;
    for (let round = 1; round <= MESSAGING_CAPTURE_REPEATED_EXITS; round += 1) {
      lastReconcile = await supervisor.reconcile();
      expect(effectiveMessagingCaptureStatus({ status: lastReconcile, liveness: supervisor.liveness() }))
        .toEqual({ source: 'telegram', state: 'running' });
      helpers.at(-1)!.die(1);
      await settle();
      clock += 10_000;
      const effective = effectiveMessagingCaptureStatus({ status: lastReconcile, liveness: supervisor.liveness() });
      // Between exits nothing is running, but the next check starts it again: restarting, not an alarm.
      if (round < MESSAGING_CAPTURE_REPEATED_EXITS) expect(effective).toEqual({ source: 'telegram', state: 'stopped', reason: 'restarting' });
      else expect(effective).toEqual({ source: 'telegram', state: 'blocked', reason: 'helper_exited' });
    }
    // The reconcile itself kept saying running: that is the stale report this corrects.
    expect(lastReconcile).toEqual({ source: 'telegram', state: 'running' });
  });

  test('a helper that stays up for a minute is forgiven its earlier exits, and old exits age out', async () => {
    let clock = 5_000_000;
    const helpers: Array<ReturnType<typeof mortalChild>> = [];
    const supervisor = captureSupervisorFixture({
      now: () => clock,
      spawn: () => { const helper = mortalChild(); helpers.push(helper); return helper.child; },
    });
    for (let round = 0; round < 3; round += 1) {
      await supervisor.reconcile();
      helpers.at(-1)!.die(1);
      await settle();
    }
    expect(supervisor.liveness().unexpectedExits).toBe(3);
    // Ten minutes later the exits no longer count.
    clock += 10 * 60_000 + 1;
    expect(supervisor.liveness().unexpectedExits).toBe(0);
    // And a run that lasts a minute clears exits still inside the window.
    for (let round = 0; round < 3; round += 1) {
      await supervisor.reconcile();
      helpers.at(-1)!.die(1);
      await settle();
    }
    await supervisor.reconcile();
    clock += 30_000;
    expect(supervisor.liveness()).toEqual({ alive: true, unexpectedExits: 3 });
    clock += 31_000;
    expect(supervisor.liveness()).toEqual({ alive: true, unexpectedExits: 0 });
  });

  test('a run of a minute forgives earlier exits even when nobody reads liveness() while it runs', async () => {
    let clock = 9_000_000;
    const helpers: Array<ReturnType<typeof mortalChild>> = [];
    const supervisor = captureSupervisorFixture({
      now: () => clock,
      spawn: () => { const helper = mortalChild(); helpers.push(helper); return helper.child; },
    });
    // Two quick failures, then a run of ninety seconds that ends on its own. No liveness() call in between.
    for (let round = 0; round < 2; round += 1) {
      await supervisor.reconcile();
      clock += 5_000;
      helpers.at(-1)!.die(1);
      await settle();
    }
    await supervisor.reconcile();
    clock += 90_000;
    helpers.at(-1)!.die(1);
    await settle();
    // Only the last exit counts: the long run cleared the two before it, so this is not "keeps exiting".
    expect(supervisor.liveness()).toEqual({ alive: false, unexpectedExits: 1 });
    expect(effectiveMessagingCaptureStatus({ status: { source: 'telegram', state: 'running' }, liveness: supervisor.liveness() }))
      .toEqual({ source: 'telegram', state: 'stopped', reason: 'restarting' });
  });

  test('a helper that is not alive reads restarting until it is started again; repeated exits outrank that', () => {
    const running: MessagingCaptureStatus = { source: 'whatsapp', state: 'running' };
    expect(effectiveMessagingCaptureStatus({ status: running, liveness: { alive: false, unexpectedExits: 1 } }))
      .toEqual({ source: 'whatsapp', state: 'stopped', reason: 'restarting' });
    expect(effectiveMessagingCaptureStatus({ status: running, liveness: { alive: false, unexpectedExits: 3 } }))
      .toEqual({ source: 'whatsapp', state: 'blocked', reason: 'helper_exited' });
    // Only a status that claims running is corrected.
    const blocked: MessagingCaptureStatus = { source: 'whatsapp', state: 'blocked', reason: 'session_missing' };
    expect(effectiveMessagingCaptureStatus({ status: blocked, liveness: { alive: false, unexpectedExits: 0 } })).toEqual(blocked);
  });

  test('fewer than three exits, or a failed reconcile with nothing to correct, change nothing', () => {
    const running: MessagingCaptureStatus = { source: 'whatsapp', state: 'running' };
    expect(effectiveMessagingCaptureStatus({ status: running, liveness: { alive: true, unexpectedExits: 2 } })).toEqual(running);
    expect(effectiveMessagingCaptureStatus({ status: undefined, liveness: { alive: false, unexpectedExits: 9 } })).toBeUndefined();
    const stopped: MessagingCaptureStatus = { state: 'stopped', reason: 'handle_unavailable' };
    expect(effectiveMessagingCaptureStatus({ status: stopped, liveness: { alive: false, unexpectedExits: 9 } })).toEqual(stopped);
  });
});

describe('a capture helper that cannot be started is reported, not hidden by the last good status', () => {
  const stubSupervisor = (reconcile: () => Promise<MessagingCaptureStatus>) => ({ reconcile, stop: async () => {} });

  test('a reconcile that throws is recorded per source and clears when a later one succeeds', async () => {
    const statuses: Partial<Record<'telegram' | 'whatsapp', MessagingCaptureStatus>> = {};
    const failures: Partial<Record<'telegram' | 'whatsapp', true>> = {};
    let telegramThrows = false;
    const warnings: string[] = [];
    const captures = {
      telegram: stubSupervisor(async () => {
        if (telegramThrows) throw new Error('Python 3 is required for Telegram.');
        return { source: 'telegram' as const, state: 'running' as const };
      }),
      whatsapp: stubSupervisor(async () => ({ source: 'whatsapp' as const, state: 'running' as const })),
    };
    await reconcileWorkerCaptures({ captures, statuses, failures, warn: (message) => warnings.push(message) });
    expect(statuses).toEqual({ telegram: { source: 'telegram', state: 'running' }, whatsapp: { source: 'whatsapp', state: 'running' } });
    expect(failures).toEqual({});

    telegramThrows = true;
    await reconcileWorkerCaptures({ captures, statuses, failures, warn: (message) => warnings.push(message) });
    // WhatsApp is still reconciled; Telegram's failure is recorded and its old status is left to be corrected.
    expect(failures).toEqual({ telegram: true });
    expect(statuses.whatsapp).toEqual({ source: 'whatsapp', state: 'running' });
    expect(warnings).toEqual(['An Olympus messaging capture process needs attention. Check pairing and its approved scope.']);
    expect(warnings.join(' ')).not.toContain('Python');

    telegramThrows = false;
    await reconcileWorkerCaptures({ captures, statuses, failures, warn: (message) => warnings.push(message) });
    expect(failures).toEqual({});
  });

  test('the dashboard says start_failed over a previous running status, and when nothing ever reported', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-capture-start-failed-'));
    const registryPath = join(root, 'handles.json');
    saveMessagingCaptureGrant({ path: defaultMessagingCaptureGrantPath('telegram', registryPath), pairing: telegramPairing('/fixture/telegram'), now: PAIRED });
    expect(workerCaptureRuntime({
      sources: ['telegram'],
      statuses: { telegram: { source: 'telegram', state: 'running' } },
      failures: { telegram: true },
      registryPath,
    })['telegram.messages']?.supervisor).toEqual({ state: 'blocked', reason: 'start_failed' });
    // The very first reconcile threw: there is no status at all, and the failure is still a fact.
    expect(workerCaptureRuntime({ sources: ['telegram'], statuses: {}, failures: { telegram: true }, registryPath })['telegram.messages']?.supervisor)
      .toEqual({ state: 'blocked', reason: 'start_failed' });
  });

  test('the dashboard says restarting, not running, for a helper that exited and has not been started again', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-capture-restarting-'));
    expect(workerCaptureRuntime({
      sources: ['whatsapp'],
      statuses: { whatsapp: { source: 'whatsapp', state: 'running' } },
      liveness: { whatsapp: { alive: false, unexpectedExits: 1 } },
      registryPath: join(root, 'handles.json'),
    })['whatsapp.personal.messages']?.supervisor).toEqual({ state: 'stopped', reason: 'restarting' });
  });

  test('the dashboard says helper_exited for a helper that keeps exiting, from live liveness', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-capture-exited-'));
    const registryPath = join(root, 'handles.json');
    const input = {
      sources: ['whatsapp' as const],
      statuses: { whatsapp: { source: 'whatsapp' as const, state: 'running' as const } },
      registryPath,
    };
    expect(workerCaptureRuntime({ ...input, liveness: { whatsapp: { alive: false, unexpectedExits: 3 } } })['whatsapp.personal.messages']?.supervisor)
      .toEqual({ state: 'blocked', reason: 'helper_exited' });
    expect(workerCaptureRuntime({ ...input, liveness: { whatsapp: { alive: true, unexpectedExits: 2 } } })['whatsapp.personal.messages']?.supervisor)
      .toEqual({ state: 'running' });
  });
});

describe('a grant that parses but is not shaped as written never breaks the dashboard', () => {
  const grantWith = (source: 'telegram' | 'whatsapp', edit: (grant: Record<string, any>) => void) => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-capture-malformed-'));
    const registryPath = join(root, 'handles.json');
    const path = defaultMessagingCaptureGrantPath(source, registryPath);
    saveMessagingCaptureGrant({
      path,
      pairing: source === 'telegram' ? telegramPairing('/fixture/telegram') : whatsappPairing('111@s.whatsapp.net'),
      now: PAIRED,
    });
    const grant = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    edit(grant);
    writeFileSync(path, JSON.stringify(grant));
    chmodSync(path, 0o600);
    return { path, registryPath };
  };
  const damage: Record<string, (grant: Record<string, any>) => void> = {
    'no environment at all': (grant) => { delete grant.producer.env; },
    'an environment that is a list': (grant) => { grant.producer.env = ['OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES']; },
    'an environment that is text': (grant) => { grant.producer.env = 'scopes'; },
    'a scope that is a number': (grant) => {
      grant.producer.env.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES = 5;
      grant.producer.env.OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS = 5;
    },
    'a scope that is a list': (grant) => {
      grant.producer.env.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES = ['a', 'b'];
      grant.producer.env.OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS = ['a', 'b'];
    },
  };

  for (const [name, edit] of Object.entries(damage)) {
    for (const source of ['telegram', 'whatsapp'] as const) {
      test(`${source}: ${name} gives no scope instead of throwing`, () => {
        const { path } = grantWith(source, edit);
        expect(() => readMessagingCaptureScope(source, path)).not.toThrow();
        expect(readMessagingCaptureScope(source, path)).toBeUndefined();
        expect(readMessagingCaptureGrantFacts(source, path)).toEqual({ pairedAt: PAIRED.toISOString() });
      });
    }

    test(`the worker's capture report survives ${name} and still carries the supervisor state`, () => {
      const { registryPath } = grantWith('telegram', edit);
      const runtime = workerCaptureRuntime({
        sources: ['telegram'],
        statuses: { telegram: { source: 'telegram', state: 'running' } },
        registryPath,
      });
      expect(runtime['telegram.messages']).toEqual({ supervisor: { state: 'running' }, paired_at: PAIRED.toISOString() });
    });
  }

  test('a grant time that is not a time is no pairing time, and a damaged source does not hide the other', () => {
    const bad = grantWith('telegram', (grant) => { grant.grantedAt = 'yesterday'; delete grant.producer.env; });
    expect(readMessagingCaptureGrantFacts('telegram', bad.path)).toEqual({});
    const root = mkdtempSync(join(tmpdir(), 'olympus-capture-two-sources-'));
    const registryPath = join(root, 'handles.json');
    saveMessagingCaptureGrant({ path: defaultMessagingCaptureGrantPath('whatsapp', registryPath), pairing: whatsappPairing('*'), now: PAIRED });
    writeFileSync(defaultMessagingCaptureGrantPath('telegram', registryPath), '{"version":1,"source":"telegram","handle":"h","sessionPath":"/x","producer":{"source":"telegram","secretEnvironment":[]},"grantedAt":7}');
    chmodSync(defaultMessagingCaptureGrantPath('telegram', registryPath), 0o600);
    const runtime = workerCaptureRuntime({
      sources: ['telegram', 'whatsapp'],
      statuses: { telegram: { source: 'telegram', state: 'running' } },
      registryPath,
    });
    expect(runtime['whatsapp.personal.messages']).toEqual({ scope: { kind: 'whole_account' }, paired_at: PAIRED.toISOString() });
    expect(runtime['telegram.messages']).toEqual({ supervisor: { state: 'running' } });
  });

  test('the pairing time is the grant\'s own, and a fresh pairing replaces it', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-capture-paired-at-'));
    const path = defaultMessagingCaptureGrantPath('telegram', join(root, 'handles.json'));
    saveMessagingCaptureGrant({ path, pairing: telegramPairing('/fixture/telegram'), now: PAIRED });
    expect(readMessagingCaptureGrantFacts('telegram', path).pairedAt).toBe('2026-10-20T10:00:00.000Z');
    saveMessagingCaptureGrant({ path, pairing: telegramPairing('/fixture/telegram'), now: new Date('2026-10-24T09:00:00.000Z') });
    expect(readMessagingCaptureGrantFacts('telegram', path).pairedAt).toBe('2026-10-24T09:00:00.000Z');
  });
});

function runningSupervisorFixture(child: CaptureChild, stopTimeoutMs: number): MessagingCaptureSupervisor {
  return captureSupervisorFixture({ spawn: () => child, stopTimeoutMs });
}

function captureSupervisorFixture(input: { spawn: SpawnCapture; stopTimeoutMs?: number; now?: () => number }): MessagingCaptureSupervisor {
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
    stopTimeoutMs: input.stopTimeoutMs ?? 2,
    ...(input.now ? { now: input.now } : {}),
    secretStore: secretStore({
      [TELEGRAM_API_ID_SECRET_KEY]: '12345',
      [TELEGRAM_API_HASH_SECRET_KEY]: 'fixture-secret',
    }),
    spawn: input.spawn,
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

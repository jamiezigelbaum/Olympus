// Telegram and WhatsApp accounts in their account folders (docs/design/source-storage.md,
// delivery step 4b): a fresh install pairs and captures only under sources/<id>/1/; a legacy
// account keeps exactly the paths and child environment it had; Unpair and Delete agree with
// the worker and the capture children about every path, for both layouts. The legacy
// resolution itself is pinned by test/messaging-layout-golden.test.ts.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { holdDataOwnerLock, type HeldDataOwnerLock } from '../src/core/data-owner-lock.ts';
import {
  MessagingCaptureSupervisor,
  defaultMessagingCaptureGrantPath,
  saveMessagingCaptureGrant,
  type CaptureChild,
} from '../src/core/messaging-capture.ts';
import { openConnectorStore, __sourceStorageTestHooks, enableSourceRegistryAdoption } from '../src/core/source-storage.ts';
import { defaultInternalTelegramConnectorStoreDbPath } from '../src/workers/telegram-messages/corpus-adapter.ts';
import {
  TELEGRAM_API_HASH_SECRET_KEY,
  TELEGRAM_API_ID_SECRET_KEY,
  pairMessagingSource,
  type PairingCommandResult,
} from '../src/core/messaging-pairing.ts';
import { accountFolder, olympusDataRoot } from '../src/core/olympus-layout.ts';
import {
  planPairingSessionRemoval,
  removePlannedPairingSessionFile,
  telegramPairingSessionPaths,
  telegramSessionBasePath,
  whatsappPairingSessionPaths,
  whatsappStateDir,
} from '../src/core/pairing-session-paths.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import { decideAccountLayout, placedAccount } from '../src/core/source-placement.ts';
import { readSourceRegistry, sourceRegistryPath, updateSourceRegistry } from '../src/core/source-registry.ts';
import { SourceStorageUnavailableError, placeOwnedAccount, replaceEmptyLegacyAccounts } from '../src/core/source-storage.ts';
import { settlePairingPlacement } from '../src/core/pairing-placement.ts';
import { pairingAccountForCli, pairingPlacementForCli } from '../src/workers/cli-operations.ts';
import { deleteOlympusData } from '../src/data-lifecycle.ts';
import { replaceEmptyAccountsAtBoot } from '../src/workers/email-source/server.ts';
import { defaultWhatsAppMediaRoots, whatsAppLiveSyncScriptPaths } from '../src/workers/whatsapp/store-sync.ts';
import { pinMessagingLegacy } from './fixtures/legacy-messaging-registry.ts';

type Env = Record<string, string>;

const TELEGRAM = 'telegram.messages';
const WHATSAPP = 'whatsapp.personal.messages';

const dirs: string[] = [];
const held: HeldDataOwnerLock[] = [];
afterEach(() => {
  for (const lock of held.splice(0)) lock.release();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fresh(options: { relocated?: boolean } = {}): { dir: string; home: string; env: Env } {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-messaging-folders-'));
  dirs.push(dir);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return {
    dir,
    home,
    env: {
      HOME: home,
      XDG_DATA_HOME: options.relocated ? join(dir, 'xdg-data') : join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
    },
  };
}

function put(path: string, text = 'x'): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function everyFile(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? everyFile(path) : [path];
  });
}

const folderOf = (sourceId: string, env: Env): string => accountFolder({ source_id: sourceId, slot: '1' }, env);
const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}${sep}`);

function memorySecretStore(values: Record<string, string> = {}): SecretStore & { values: Map<string, string> } {
  const stored = new Map(Object.entries(values));
  return {
    label: 'memory',
    values: stored,
    get: async (key) => stored.get(key),
    set: async (key, value) => { stored.set(key, value); },
    delete: async (key) => { stored.delete(key); },
    list: async () => [...stored.keys()],
  };
}

function packageFixture(dir: string): string {
  const root = join(dir, 'package');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'cache', 'olympus', 'bin'), { recursive: true });
  mkdirSync(join(root, 'tools', 'whatsapp-bridge'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'telegram-pair.py'), '# fixture\n');
  writeFileSync(join(root, 'scripts', 'telegram-telethon-reader.py'), '# fixture\n');
  writeFileSync(join(root, 'cache', 'olympus', 'bin', 'olympus-whatsapp-bridge'), '#!/bin/sh\n');
  chmodSync(join(root, 'cache', 'olympus', 'bin', 'olympus-whatsapp-bridge'), 0o700);
  for (const name of ['main.go', 'go.mod', 'go.sum']) writeFileSync(join(root, 'tools', 'whatsapp-bridge', name), name);
  return root;
}

function telegramReady(sessionPath: string | undefined): PairingCommandResult {
  return {
    exitCode: 0,
    stderr: '',
    stdoutLines: [JSON.stringify({
      event: 'ready',
      status: 'ready',
      session_path: sessionPath,
      proof: { authorized: true, account_ref: 'abcdef0123456789', session_persisted: true, credentials_transferred: true },
      dialogs: [{ chat_scope: 'telegram.personal:chat:101', kind: 'dm', title: 'Ada' }],
      capture_started: false,
    })],
    privatePayload: '{"api_id":12345,"api_hash":"fixture-hash"}',
  };
}

function whatsappReady(): PairingCommandResult {
  return {
    exitCode: 0,
    stderr: '',
    stdoutLines: [JSON.stringify({ event: 'ready', status: 'ready', proof: { authenticated: true, device_persisted: true }, capture_started: false })],
  };
}

/** The handle registry the supervisor reads, outside the data and home folders. */
function writeHandles(path: string, source: 'telegram' | 'whatsapp'): void {
  mkdirSync(dirname(path), { recursive: true });
  const handle = source === 'telegram'
    ? { handle: 'telegram.personal', provider: 'telegram', sessionKind: 'mtproto_session', accountRole: 'personal', allowedCapabilities: ['telegram.messages.sync'], backendState: { kind: 'mtproto_session', status: 'available' } }
    : { handle: 'whatsapp.personal_local', provider: 'whatsapp_personal', sessionKind: 'local_app_database', accountRole: 'personal_local', allowedCapabilities: ['whatsapp.personal.messages.sync'], backendState: { kind: 'local_app_database', status: 'available' } };
  const existing = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { handles: unknown[] }).handles : [];
  writeFileSync(path, JSON.stringify({
    version: 1,
    handles: [...existing, { ...handle, trustDomain: 'secure_local', scopes: [], tokenSecretRefs: [], connectedAt: '2026-09-14T00:00:00.000Z' }],
  }));
}

const fakeChild = (): CaptureChild => ({ exited: new Promise<number>(() => {}), kill: () => {} });

interface Paired {
  grantPath: string;
  registryPath: string;
  pkg: string;
  result: Awaited<ReturnType<typeof pairMessagingSource>> & { status: 'connected' };
}

async function pairTelegram(
  f: { dir: string; home: string; env: Env },
  runCommandSession: (path: string | undefined) => void = () => {},
  extra: Partial<Parameters<typeof pairMessagingSource>[0]> = {},
): Promise<Paired> {
  const pkg = packageFixture(f.dir);
  const result = await pairMessagingSource({
    source: 'telegram',
    packageRoot: pkg,
    homeDir: f.home,
    env: f.env,
    pythonExecutable: '/usr/bin/python3',
    secretStore: memorySecretStore(),
    captureScopeApproval: { source: 'telegram', explicitApproval: true, chatScopes: ['telegram.personal:chat:101'] },
    runCommand: async (request) => {
      runCommandSession(request.env.OLYMPUS_TELEGRAM_SESSION_PATH);
      return telegramReady(request.env.OLYMPUS_TELEGRAM_SESSION_PATH);
    },
    registerSession: async () => ({ ok: true, source: 'telegram', handles: ['telegram.personal'], secretRefs: [] }),
    ...extra,
  });
  if (result.status !== 'connected') throw new Error('expected connected result');
  const registryPath = join(f.dir, 'config', 'handles.json');
  writeHandles(registryPath, 'telegram');
  const grantPath = defaultMessagingCaptureGrantPath('telegram', registryPath);
  saveMessagingCaptureGrant({ path: grantPath, pairing: result });
  return { grantPath, registryPath, pkg, result: result as Paired['result'] };
}

async function pairWhatsApp(f: { dir: string; home: string; env: Env }, onStateDir: (path: string | undefined) => void = () => {}): Promise<Paired> {
  const pkg = packageFixture(f.dir);
  const result = await pairMessagingSource({
    source: 'whatsapp',
    packageRoot: pkg,
    whatsappBridgePath: join(pkg, 'cache', 'olympus', 'bin', 'olympus-whatsapp-bridge'),
    homeDir: f.home,
    env: f.env,
    whatsappQrMode: 'artifact',
    captureScopeApproval: { source: 'whatsapp', explicitApproval: true, chatJids: ['chat-1@s.whatsapp.net'] },
    runCommand: async (request) => {
      onStateDir(request.env.OLYMPUS_WHATSAPP_STATE_DIR);
      return whatsappReady();
    },
    registerSession: async () => ({ ok: true, source: 'whatsapp', handles: ['whatsapp.personal_local'], secretRefs: [] }),
  });
  if (result.status !== 'connected') throw new Error('expected connected result');
  const registryPath = join(f.dir, 'config', 'handles.json');
  writeHandles(registryPath, 'whatsapp');
  const grantPath = defaultMessagingCaptureGrantPath('whatsapp', registryPath);
  saveMessagingCaptureGrant({ path: grantPath, pairing: result });
  return { grantPath, registryPath, pkg, result: result as Paired['result'] };
}

function telegramSupervisor(f: { env: Env }, paired: Paired, spawn: (env: Record<string, string>) => CaptureChild): MessagingCaptureSupervisor {
  return new MessagingCaptureSupervisor({
    source: 'telegram',
    registryPath: paired.registryPath,
    grantPath: paired.grantPath,
    baseEnv: f.env,
    packageRoot: paired.pkg,
    pythonExecutable: '/fixture/python3',
    secretStore: memorySecretStore({ [TELEGRAM_API_ID_SECRET_KEY]: '12345', [TELEGRAM_API_HASH_SECRET_KEY]: 'fixture-secret' }),
    spawn: (input) => spawn(input.env),
  });
}

function whatsappSupervisor(f: { env: Env }, paired: Paired, spawn: (env: Record<string, string>) => CaptureChild): MessagingCaptureSupervisor {
  return new MessagingCaptureSupervisor({
    source: 'whatsapp',
    registryPath: paired.registryPath,
    grantPath: paired.grantPath,
    baseEnv: f.env,
    packageRoot: paired.pkg,
    whatsappBridgePath: join(paired.pkg, 'cache', 'olympus', 'bin', 'olympus-whatsapp-bridge'),
    spawn: (input) => spawn(input.env),
  });
}

/** Every file Olympus made under the data root, except the registry and its lock files. */
function dataFiles(env: Env): string[] {
  return everyFile(olympusDataRoot(env)).filter((path) => !/(^|\/)(registry\.json[^/]*|data-owner\.lock)$/.test(path));
}

describe('a fresh install pairs and captures only inside the account folder', () => {
  test('Telegram: the pairing helper, the grant and the capture child agree on every path', async () => {
    const f = fresh();
    const folder = folderOf(TELEGRAM, f.env);
    const base = join(folder, 'session', 'telegram');
    const paired = await pairTelegram(f, (path) => {
      // The helper writes the login where it is told to.
      expect(path).toBe(base);
      expect(statSync(dirname(base)).mode & 0o777).toBe(0o700);
      writeFileSync(`${base}.session`, 'login');
    });
    expect(paired.result.sessionLayout).toBe('folder');
    expect(paired.result.sessionPath).toBe(base);
    expect(paired.result.producer.env.OLYMPUS_TELEGRAM_SESSION_PATH).toBeUndefined();
    // The registry records the account before the first file.
    expect(readSourceRegistry(f.env).accounts.map((a) => [a.source_id, a.layout])).toEqual([[TELEGRAM, 'folder']]);
    // A folder account's grant stores no path.
    expect(JSON.parse(readFileSync(paired.grantPath, 'utf8')).sessionPath).toBeUndefined();

    let childEnv: Record<string, string> | undefined;
    const supervisor = telegramSupervisor(f, paired, (env) => {
      childEnv = env;
      return fakeChild();
    });
    expect(await supervisor.reconcile()).toEqual({ source: 'telegram', state: 'running' });
    expect(childEnv).toMatchObject({
      OLYMPUS_TELEGRAM_SESSION_PATH: base,
      OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: join(folder, 'raw', 'telegram-gateway'),
      OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: join(folder, 'raw', 'telegram-spool'),
    });
    // Nothing else can place a Telegram file.
    for (const name of ['OLYMPUS_TELEGRAM_SPOOL_DRAIN_SPOOL_DIR', 'OLYMPUS_TELEGRAM_GATEWAY_BACKFILL_REQUESTS_PATH']) {
      expect(childEnv![name]).toBeUndefined();
    }
    for (const dir of [join(folder, 'raw', 'telegram-gateway'), join(folder, 'raw', 'telegram-spool'), dirname(base)]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }

    // What the reader writes, at the paths it was handed.
    put(join(childEnv!.OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR!, '0001.jsonl'));
    put(join(childEnv!.OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR!, 'state.json'));
    writeFileSync(`${childEnv!.OLYMPUS_TELEGRAM_SESSION_PATH}.session-journal`, 'journal');
    const outside = dataFiles(f.env).filter((path) => !inside(path, folder));
    expect(outside).toEqual([]);
    // And nothing at the paths that were always there.
    expect(existsSync(join(f.home, '.local', 'share', 'olympus', 'telegram'))).toBe(false);
    expect(existsSync(join(f.home, '.local', 'share', 'olympus', 'telegram-capture'))).toBe(false);
    expect(existsSync(join(f.home, '.local', 'state', 'olympus', 'telegram-capture-gateway'))).toBe(false);
  });

  test('Telegram: nothing in the grant or the environment moves a folder account out of its folder', async () => {
    const f = fresh();
    const folder = folderOf(TELEGRAM, f.env);
    const paired = await pairTelegram(f, (path) => writeFileSync(`${path}.session`, 'login'));
    // A grant from an older pairing, or a hand edit, that names other places.
    const grant = JSON.parse(readFileSync(paired.grantPath, 'utf8'));
    grant.producer.env.OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR = '/elsewhere/state';
    grant.producer.env.OLYMPUS_TELEGRAM_SESSION_PATH = '/elsewhere/session';
    writeFileSync(paired.grantPath, JSON.stringify(grant));
    let childEnv: Record<string, string> | undefined;
    const supervisor = telegramSupervisor({ env: { ...f.env, OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: '/elsewhere/spool' } }, paired, (env) => {
      childEnv = env;
      return fakeChild();
    });
    expect(await supervisor.reconcile()).toEqual({ source: 'telegram', state: 'running' });
    expect(childEnv).toMatchObject({
      OLYMPUS_TELEGRAM_SESSION_PATH: join(folder, 'session', 'telegram'),
      OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: join(folder, 'raw', 'telegram-gateway'),
      OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: join(folder, 'raw', 'telegram-spool'),
    });
  });

  test('WhatsApp: the bridge pairs into raw/whatsapp and every capture file stays in it', async () => {
    const f = fresh();
    const folder = folderOf(WHATSAPP, f.env);
    const stateDir = join(folder, 'raw', 'whatsapp');
    const paired = await pairWhatsApp(f, (path) => {
      expect(path).toBe(stateDir);
      expect(statSync(stateDir).mode & 0o777).toBe(0o700);
      writeFileSync(join(stateDir, 'session.db'), 'device');
    });
    expect(paired.result.sessionLayout).toBe('folder');
    expect(paired.result.sessionPath).toBe(stateDir);
    expect(paired.result.producer.env.OLYMPUS_WHATSAPP_STATE_DIR).toBeUndefined();
    expect(JSON.parse(readFileSync(paired.grantPath, 'utf8')).sessionPath).toBeUndefined();

    let childEnv: Record<string, string> | undefined;
    const supervisor = whatsappSupervisor(f, paired, (env) => {
      childEnv = env;
      return fakeChild();
    });
    expect(await supervisor.reconcile()).toEqual({ source: 'whatsapp', state: 'running' });
    expect(childEnv!.OLYMPUS_WHATSAPP_STATE_DIR).toBe(stateDir);
    expect(childEnv!.OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS).toBe('chat-1@s.whatsapp.net');
    // The bridge derives the rest from the one folder.
    const state = childEnv!.OLYMPUS_WHATSAPP_STATE_DIR!;
    put(join(state, 'spool', '2026-10-24.jsonl'));
    put(join(state, 'media', 'audio', 'voice.ogg'));
    put(join(state, 'qr.png'));
    expect(dataFiles(f.env).filter((path) => !inside(path, folder))).toEqual([]);
    expect(existsSync(join(f.home, '.local', 'share', 'olympus', 'whatsapp-live'))).toBe(false);
  });

  test('a real child process is handed the same paths and makes its files there', async () => {
    const f = fresh();
    const telegramPaired = await pairTelegram(f, (path) => writeFileSync(`${path}.session`, 'login'));
    const whatsappPaired = await pairWhatsApp(f, (path) => writeFileSync(join(path!, 'session.db'), 'device'));
    const seen = join(f.dir, 'seen');
    mkdirSync(seen, { recursive: true });
    // The reader and the bridge, as shell: write down the path environment, make files where the paths say, wait to be stopped.
    writeFileSync(join(telegramPaired.pkg, 'scripts', 'telegram-telethon-reader.py'), [
      'printf "%s\\n" "$OLYMPUS_TELEGRAM_SESSION_PATH" "$OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR" "$OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR" > "$SEEN/telegram"',
      'echo message > "$OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR/0001.jsonl"',
      'echo state > "$OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR/state.json"',
      'exec sleep 60',
      '',
    ].join('\n'));
    writeFileSync(join(whatsappPaired.pkg, 'cache', 'olympus', 'bin', 'olympus-whatsapp-bridge'), [
      '#!/bin/sh',
      'printf "%s\\n" "$OLYMPUS_WHATSAPP_STATE_DIR" > "$SEEN/whatsapp"',
      'mkdir -p "$OLYMPUS_WHATSAPP_STATE_DIR/spool" "$OLYMPUS_WHATSAPP_STATE_DIR/media/audio"',
      'echo message > "$OLYMPUS_WHATSAPP_STATE_DIR/spool/0001.jsonl"',
      'exec sleep 60',
      '',
    ].join('\n'));
    const baseEnv = { ...f.env, SEEN: seen, PATH: process.env.PATH ?? '' };
    const telegram = new MessagingCaptureSupervisor({
      source: 'telegram', registryPath: telegramPaired.registryPath, grantPath: telegramPaired.grantPath, baseEnv,
      packageRoot: telegramPaired.pkg, pythonExecutable: '/bin/sh',
      secretStore: memorySecretStore({ [TELEGRAM_API_ID_SECRET_KEY]: '12345', [TELEGRAM_API_HASH_SECRET_KEY]: 'fixture-secret' }),
    });
    const whatsapp = new MessagingCaptureSupervisor({
      source: 'whatsapp', registryPath: whatsappPaired.registryPath, grantPath: whatsappPaired.grantPath, baseEnv,
      packageRoot: whatsappPaired.pkg, whatsappBridgePath: join(whatsappPaired.pkg, 'cache', 'olympus', 'bin', 'olympus-whatsapp-bridge'),
    });
    try {
      expect(await telegram.reconcile()).toEqual({ source: 'telegram', state: 'running' });
      expect(await whatsapp.reconcile()).toEqual({ source: 'whatsapp', state: 'running' });
      const deadline = Date.now() + 10_000;
      const folderT = folderOf(TELEGRAM, f.env);
      const folderW = folderOf(WHATSAPP, f.env);
      while (Date.now() < deadline && !(existsSync(join(folderT, 'raw', 'telegram-spool', '0001.jsonl')) && existsSync(join(folderW, 'raw', 'whatsapp', 'spool', '0001.jsonl')))) await Bun.sleep(25);
      expect(readFileSync(join(seen, 'telegram'), 'utf8').trim().split('\n')).toEqual([
        join(folderT, 'session', 'telegram'),
        join(folderT, 'raw', 'telegram-gateway'),
        join(folderT, 'raw', 'telegram-spool'),
      ]);
      expect(readFileSync(join(seen, 'whatsapp'), 'utf8').trim()).toBe(join(folderW, 'raw', 'whatsapp'));
      expect(existsSync(join(folderT, 'raw', 'telegram-gateway', 'state.json'))).toBe(true);
      expect(dataFiles(f.env).filter((path) => !inside(path, folderT) && !inside(path, folderW))).toEqual([]);
    } finally {
      await telegram.stop();
      await whatsapp.stop();
    }
  }, 30_000);

  test('both accounts side by side keep to their own folders', async () => {
    const f = fresh();
    await pairTelegram(f, (path) => writeFileSync(`${path}.session`, 'login'));
    await pairWhatsApp(f, (path) => writeFileSync(join(path!, 'session.db'), 'device'));
    const telegram = folderOf(TELEGRAM, f.env);
    const whatsapp = folderOf(WHATSAPP, f.env);
    for (const path of dataFiles(f.env)) expect(inside(path, telegram) || inside(path, whatsapp), path).toBe(true);
    expect(readSourceRegistry(f.env).schema).toBe(2);
  });
});

describe('a legacy account keeps exactly the paths and the child environment it had', () => {
  test('Telegram: the grant holds the resolver\'s path, the child gets the grant\'s environment, and a second reconcile does not restart it', async () => {
    const f = fresh();
    // The install has its Telegram files at the old place.
    put(join(f.home, '.local', 'share', 'olympus', 'telegram-capture', 'spool', '0001.jsonl'));
    const legacyBase = join(f.home, '.local', 'share', 'olympus', 'telegram', 'telegram.personal');
    const paired = await pairTelegram(f, (path) => {
      expect(path).toBe(legacyBase);
      // The helper makes the folder it writes into, as it always did.
      put(`${path}.session`, 'login');
    });
    expect(paired.result.sessionLayout).toBe('legacy');
    expect(readSourceRegistry(f.env).accounts.map((a) => [a.source_id, a.layout])).toEqual([[TELEGRAM, 'legacy']]);
    // Pairing and the resolver every other process uses agree.
    expect(telegramSessionBasePath({ env: f.env, homeDir: f.home })).toBe(legacyBase);
    const grant = JSON.parse(readFileSync(paired.grantPath, 'utf8'));
    expect(grant.sessionPath).toBe(legacyBase);
    expect(grant.producer.env.OLYMPUS_TELEGRAM_SESSION_PATH).toBe(legacyBase);

    const spawned: Array<Record<string, string>> = [];
    const supervisor = telegramSupervisor(f, paired, (env) => {
      spawned.push(env);
      return fakeChild();
    });
    expect(await supervisor.reconcile()).toEqual({ source: 'telegram', state: 'running' });
    expect(await supervisor.reconcile()).toEqual({ source: 'telegram', state: 'running' });
    expect(spawned).toHaveLength(1);
    // The environment is the base plus the grant's, as it always was.
    const expected: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...f.env, ...grant.producer.env })) {
      if (value !== undefined) expected[key] = value as string;
    }
    for (const mapping of grant.producer.secretEnvironment as Array<{ env: string }>) expected[mapping.env] = spawned[0]![mapping.env]!;
    expect(spawned[0]).toEqual(expected);
    // No folder was made for it.
    expect(existsSync(join(olympusDataRoot(f.env), 'sources', TELEGRAM))).toBe(false);

    // A restarted worker (a new supervisor over the same grant) hands the child the same environment.
    const restarted: Array<Record<string, string>> = [];
    await telegramSupervisor(f, paired, (env) => {
      restarted.push(env);
      return fakeChild();
    }).reconcile();
    expect(restarted).toEqual(spawned);
  });

  test('WhatsApp: the grant\'s state folder is the resolver\'s, and the child gets it', async () => {
    const f = fresh();
    put(join(f.home, '.local', 'share', 'olympus', 'whatsapp-live', 'connector-store.db'));
    const legacyState = join(f.home, '.local', 'share', 'olympus', 'whatsapp-live');
    const paired = await pairWhatsApp(f, (path) => {
      expect(path).toBe(legacyState);
      writeFileSync(join(path!, 'session.db'), 'device');
    });
    expect(paired.result.sessionLayout).toBe('legacy');
    expect(whatsappStateDir({ env: f.env, homeDir: f.home })).toBe(legacyState);
    const grant = JSON.parse(readFileSync(paired.grantPath, 'utf8'));
    expect(grant.sessionPath).toBe(legacyState);
    expect(grant.producer.env.OLYMPUS_WHATSAPP_STATE_DIR).toBe(legacyState);
    let childEnv: Record<string, string> | undefined;
    expect(await whatsappSupervisor(f, paired, (env) => {
      childEnv = env;
      return fakeChild();
    }).reconcile()).toEqual({ source: 'whatsapp', state: 'running' });
    expect(childEnv!.OLYMPUS_WHATSAPP_STATE_DIR).toBe(legacyState);
  });

  test('a grant that names its session path stays legacy where nothing recorded the account', async () => {
    const f = fresh();
    const paired = await pairTelegram(f, (path) => writeFileSync(`${path}.session`, 'login'));
    // This pairing was a folder's; make the grant an older install's instead, with no registry entry at all.
    const legacyBase = join(f.dir, 'old-place', 'telegram.personal');
    put(`${legacyBase}.session`);
    const grant = JSON.parse(readFileSync(paired.grantPath, 'utf8'));
    grant.sessionPath = legacyBase;
    grant.producer.env.OLYMPUS_TELEGRAM_SESSION_PATH = legacyBase;
    writeFileSync(paired.grantPath, JSON.stringify(grant));
    rmSync(sourceRegistryPath(f.env), { force: true });
    let childEnv: Record<string, string> | undefined;
    expect(await telegramSupervisor(f, paired, (env) => {
      childEnv = env;
      return fakeChild();
    }).reconcile()).toEqual({ source: 'telegram', state: 'running' });
    expect(childEnv!.OLYMPUS_TELEGRAM_SESSION_PATH).toBe(legacyBase);
  });
});

describe('Unpair accepts the real data folder and stays strict', () => {
  const configs: Array<{ name: string; relocated: boolean; platform?: string; extra?: Env }> = [
    { name: 'the default folder under the home', relocated: false },
    { name: 'an XDG data home outside the home', relocated: true },
    { name: 'a standalone Linux receipt under an XDG data home', relocated: true, platform: 'linux', extra: { OLYMPUS_STANDALONE: '1' } },
  ];

  function withPlatform<T>(platform: string | undefined, run: () => T): T {
    if (!platform) return run();
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      return run();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  }

  test.each(configs)('removes a folder account\'s session under $name, and refuses a path outside every root', (config) => {
    const f = fresh({ relocated: config.relocated });
    const env = { ...f.env, ...config.extra };
    withPlatform(config.platform, () => {
      const context = { homeDir: f.home, env };
      const telegram = telegramPairingSessionPaths(context);
      const whatsapp = whatsappPairingSessionPaths(context);
      expect(telegram[0]).toBe(join(folderOf(TELEGRAM, env), 'session', 'telegram.session'));
      expect(whatsapp[0]).toBe(join(folderOf(WHATSAPP, env), 'raw', 'whatsapp', 'session.db'));
      for (const path of [...telegram, ...whatsapp]) put(path);
      const spool = put(join(folderOf(WHATSAPP, env), 'raw', 'whatsapp', 'spool', '0001.jsonl'));

      for (const paths of [telegram, whatsapp]) {
        const planned = planPairingSessionRemoval(paths, context);
        expect(planned.ok).toBe(true);
        if (!planned.ok) continue;
        expect(planned.plan.targets.map((target) => target.path)).toEqual(paths.filter((path) => existsSync(path)));
        for (const target of planned.plan.targets) expect(removePlannedPairingSessionFile(target)).toBe('removed');
      }
      for (const path of [...telegram, ...whatsapp]) expect(existsSync(path)).toBe(false);
      expect(existsSync(spool)).toBe(true);

      // Strict: outside every root, the root itself, and a folder (not a session file).
      const outside = put(join(f.dir, 'elsewhere', 'session.db'));
      expect(planPairingSessionRemoval([outside], context)).toMatchObject({ ok: false, refusal: { reason: 'outside_root' } });
      expect(planPairingSessionRemoval([olympusDataRoot(env)], context)).toMatchObject({ ok: false, refusal: { reason: 'outside_root' } });
      expect(planPairingSessionRemoval([join(olympusDataRoot(env), 'sources')], context)).toMatchObject({ ok: false, refusal: { reason: 'not_a_regular_file' } });
      expect(existsSync(outside)).toBe(true);
    });
  });

  test('a folder account whose session folder is a link out of the data folder is refused, and nothing is removed', () => {
    const f = fresh({ relocated: true });
    const context = { homeDir: f.home, env: f.env };
    const external = join(f.dir, 'external');
    const precious = put(join(external, 'telegram.session'), 'not ours');
    const folder = folderOf(TELEGRAM, f.env);
    mkdirSync(folder, { recursive: true });
    symlinkSync(external, join(folder, 'session'));
    const planned = planPairingSessionRemoval(telegramPairingSessionPaths(context), context);
    expect(planned).toMatchObject({ ok: false, refusal: { reason: 'symlink_component' } });
    expect(existsSync(precious)).toBe(true);
  });

  test('a path in a stranger\'s folder next to the data folder is refused', () => {
    const f = fresh({ relocated: true });
    const context = { homeDir: f.home, env: f.env };
    const stranger = put(join(dirname(olympusDataRoot(f.env)), 'not-olympus', 'telegram.session'));
    expect(planPairingSessionRemoval([stranger], context)).toMatchObject({ ok: false, refusal: { reason: 'outside_root' } });
  });
});

describe('Delete of a folder messaging account', () => {
  test('WhatsApp: takes the folder with its store, spool, media and session, and nothing beside it', () => {
    const f = fresh();
    placeOwnedAccount({ sourceId: WHATSAPP }, f.env);
    placeOwnedAccount({ sourceId: 'x.bookmarks' }, f.env);
    const folder = folderOf(WHATSAPP, f.env);
    const state = join(folder, 'raw', 'whatsapp');
    const db = new Database(put(join(folder, 'stores', 'secure_local.sqlite'), ''), { create: true });
    db.exec('CREATE TABLE kept (value TEXT)');
    db.close();
    put(join(state, 'spool', '0001.jsonl'), 'message text');
    put(join(state, 'media', 'audio', 'voice.ogg'));
    put(join(state, 'session.db'), 'device keys');
    put(join(state, 'qr.png'));
    const other = put(join(folderOf('x.bookmarks', f.env), 'raw', 'keep.txt'));
    const shared = put(join(olympusDataRoot(f.env), 'shared.txt'));

    const preview = deleteOlympusData({ sourceId: 'whatsapp.messages', homeDir: f.home, env: f.env, dryRun: true });
    expect(preview.removed).toContain(folder);
    expect(existsSync(folder)).toBe(true);

    const result = deleteOlympusData({ sourceId: 'whatsapp.messages', homeDir: f.home, env: f.env });
    expect(result.removed).toContain(folder);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(shared)).toBe(true);
  });

  test('Telegram: takes the folder with its spool, gateway state and session', () => {
    const f = fresh({ relocated: true });
    placeOwnedAccount({ sourceId: TELEGRAM }, f.env);
    const folder = folderOf(TELEGRAM, f.env);
    put(join(folder, 'raw', 'telegram-spool', '0001.jsonl'), 'message text');
    put(join(folder, 'raw', 'telegram-gateway', 'state.json'));
    put(join(folder, 'session', 'telegram.session'), 'login');
    put(join(folder, 'session', 'telegram.session-journal'), 'journal');
    const result = deleteOlympusData({ sourceId: 'telegram.messages', homeDir: f.home, env: f.env });
    expect(result.removed).toContain(folder);
    expect(existsSync(folder)).toBe(false);
  });

  test('a relocated Linux receipt root takes its raw state through the same fence', () => {
    const f = fresh({ relocated: true });
    const env = { ...f.env, OLYMPUS_STANDALONE: '1' };
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      placeOwnedAccount({ sourceId: WHATSAPP }, env);
      const state = join(folderOf(WHATSAPP, env), 'raw', 'whatsapp');
      put(join(state, 'spool', '0001.jsonl'));
      put(join(state, 'session.db'));
      deleteOlympusData({ sourceId: 'whatsapp.messages', homeDir: f.home, env });
      expect(existsSync(folderOf(WHATSAPP, env))).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  test('a legacy account\'s Delete takes the same files it always did', () => {
    const f = fresh();
    pinMessagingLegacy(f.env);
    const state = join(f.home, '.local', 'share', 'olympus', 'whatsapp-live');
    put(join(state, 'spool', '0001.jsonl'));
    put(join(state, 'session.db'));
    put(join(state, 'media', 'audio', 'voice.ogg'));
    const store = put(join(state, 'connector-store.db'), '');
    const result = deleteOlympusData({ sourceId: 'whatsapp.messages', homeDir: f.home, env: f.env });
    expect(result.removed).toEqual(expect.arrayContaining([join(state, 'spool'), join(state, 'session.db'), join(state, 'media'), store]));
    expect(existsSync(join(state, 'spool'))).toBe(false);
    expect(existsSync(join(state, 'session.db'))).toBe(false);
  });

  test('a legacy account whose raw state an override points into another account\'s folder protects that folder, and is refused itself', () => {
    const f = fresh();
    placeOwnedAccount({ sourceId: 'readwise.library' }, f.env);
    pinMessagingLegacy({ ...f.env });
    // pinMessagingLegacy replaced the registry: put the folder account back beside the legacy ones.
    updateSourceRegistry(f.env, (registry) => {
      registry.schema = 2;
      registry.accounts.push({ source_id: 'readwise.library', slot: '1', state: 'active', layout: 'folder', corpus_ids: [], created_at: '2026-10-01T00:00:00.000Z' });
    });
    const readwise = folderOf('readwise.library', f.env);
    const spool = join(readwise, 'raw', 'tg-spool');
    put(join(spool, '0001.jsonl'));
    const env = { ...f.env, OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: spool };
    expect(() => deleteOlympusData({ sourceId: 'readwise.library', homeDir: f.home, env })).toThrow('overlaps another source');
    expect(() => deleteOlympusData({ sourceId: 'telegram.messages', homeDir: f.home, env })).toThrow('overlaps another source');
    expect(existsSync(join(spool, '0001.jsonl'))).toBe(true);
  });

  test('a retained grant path inside another account\'s folder protects that folder', async () => {
    const f = fresh();
    placeOwnedAccount({ sourceId: 'readwise.library' }, f.env);
    const readwise = folderOf('readwise.library', f.env);
    const session = put(join(readwise, 'raw', 'tg', 'telegram.personal.session'), 'login');
    const registryPath = join(f.dir, 'config', 'handles.json');
    writeHandles(registryPath, 'telegram');
    const grantPath = defaultMessagingCaptureGrantPath('telegram', registryPath);
    saveMessagingCaptureGrant({
      path: grantPath,
      pairing: {
        ok: true, source: 'telegram', handles: ['telegram.personal'], secretRefs: [], status: 'connected',
        sessionPath: join(readwise, 'raw', 'tg', 'telegram.personal'), accountProof: 'telegram:fixture', chats: [], captureStarted: false, registered: true,
        producer: { source: 'telegram', executable: '/fixture/python3', args: [], env: {}, secretEnvironment: [], captureStarted: false },
      } as never,
    });
    const env = { ...f.env, OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: registryPath };
    expect(() => deleteOlympusData({ sourceId: 'readwise.library', homeDir: f.home, env })).toThrow('overlaps another source');
    expect(existsSync(session)).toBe(true);
  });

  test('a grant that cannot be read refuses another source\'s Delete: where its session lives cannot be shown', () => {
    const f = fresh();
    placeOwnedAccount({ sourceId: 'readwise.library' }, f.env);
    const readwise = folderOf('readwise.library', f.env);
    const session = put(join(readwise, 'raw', 'tg', 'telegram.personal.session'), 'login');
    const { env, grantPath } = writeGrant(f, 'telegram', join(readwise, 'raw', 'tg', 'telegram.personal'));
    const deleteEnv = { ...env, HOME: f.home };
    // Readable, the grant protects the session (the test above). Unreadable, nothing can be shown, so nothing is removed.
    writeFileSync(grantPath, '{not json');
    expect(() => deleteOlympusData({ sourceId: 'readwise.library', homeDir: f.home, env: deleteEnv })).toThrow('capture grant');
    expect(existsSync(session)).toBe(true);
    expect(existsSync(readwise)).toBe(true);
    // Its own grant being unreadable is not another account's concern.
    expect(() => deleteOlympusData({ sourceId: 'telegram.messages', homeDir: f.home, env: deleteEnv })).not.toThrow('capture grant');
  });
});

describe('an empty legacy account is placed in a folder at worker boot, and nothing else is', () => {
  function legacyEntry(env: Env, sourceId: string, extra: { corpus_ids?: string[]; state?: 'active' | 'deleting' } = {}): void {
    updateSourceRegistry(env, (registry) => {
      registry.accounts.push({
        source_id: sourceId,
        slot: '1',
        state: extra.state ?? 'active',
        layout: 'legacy',
        corpus_ids: extra.corpus_ids ?? [],
        created_at: '2026-10-01T00:00:00.000Z',
      });
    });
  }
  const layouts = (env: Env): Record<string, string> =>
    Object.fromEntries(readSourceRegistry(env).accounts.map((a) => [a.source_id, `${a.state}:${a.layout}`]));

  test('an empty legacy entry is re-placed, for messaging and for every other folder-layout source', () => {
    const f = fresh();
    for (const sourceId of [TELEGRAM, WHATSAPP, 'readwise.library', 'x.bookmarks']) legacyEntry(f.env, sourceId);
    expect(replaceEmptyLegacyAccounts(f.env).sort()).toEqual(['readwise.library', TELEGRAM, 'x.bookmarks', WHATSAPP].sort());
    expect(layouts(f.env)).toEqual({
      [TELEGRAM]: 'active:folder',
      [WHATSAPP]: 'active:folder',
      'readwise.library': 'active:folder',
      'x.bookmarks': 'active:folder',
    });
    expect(readSourceRegistry(f.env).schema).toBe(2);
    expect(placedAccount(TELEGRAM, f.env).layout).toBe('folder');
    // Nothing moved or was made.
    expect(existsSync(join(olympusDataRoot(f.env), 'sources'))).toBe(false);
  });

  test('a file at any legacy location keeps the account legacy', () => {
    for (const [sourceId, file] of [
      [TELEGRAM, (home: string) => join(home, '.local', 'share', 'olympus', 'telegram', 'telegram.personal.session')],
      [TELEGRAM, (home: string) => join(home, '.local', 'state', 'olympus', 'telegram-capture-gateway', 'x')],
      [WHATSAPP, (home: string) => join(home, '.local', 'share', 'olympus', 'whatsapp-live', 'session.db')],
      [WHATSAPP, (home: string) => join(home, '.local', 'share', 'olympus', 'whatsapp-live', 'spool', 'x.jsonl')],
    ] as const) {
      const f = fresh();
      legacyEntry(f.env, sourceId);
      put(file(f.home));
      expect(replaceEmptyLegacyAccounts(f.env)).toEqual([]);
      expect(layouts(f.env)[sourceId]).toBe('active:legacy');
    }
  });

  test('an override, a mount or the native-capture flag keeps it legacy; so does one that lists a corpus, is paired, or is not active', () => {
    const pins: Array<[string, Env]> = [
      [TELEGRAM, { OLYMPUS_TELEGRAM_SESSION_PATH: '/elsewhere/telegram.session' }],
      [TELEGRAM, { OLYMPUS_TELEGRAM_SPOOL_DRAIN_CURSOR_PATH: '/elsewhere/cursor.json' }],
      [TELEGRAM, { OLYMPUS_TELEGRAM_GATEWAY_BACKFILL_REQUESTS_PATH: '/elsewhere/backfill.json' }],
      [TELEGRAM, { OLYMPUS_NATIVE_TELEGRAM_CAPTURE_OWNER: 'true' }],
      [WHATSAPP, { OLYMPUS_WHATSAPP_STATE_DIR: '/elsewhere/whatsapp' }],
      [WHATSAPP, { OLYMPUS_WHATSAPP_TRANSCRIBE_MEDIA_DIR: '/elsewhere/media' }],
      [WHATSAPP, { OLYMPUS_SOURCE_INDEX_WHATSAPP_CONNECTOR_STORE_DB_PATH: '/elsewhere/wa.db' }],
      [WHATSAPP, { OLYMPUS_NATIVE_WHATSAPP_CAPTURE_OWNER: '1' }],
      [TELEGRAM, { OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: JSON.stringify([{ corpusId: 'internal.telegram.messages', trustDomain: 'internal', dbPath: '/elsewhere/t.sqlite' }]) }],
      [TELEGRAM, { OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: '{not json' }],
    ];
    for (const [sourceId, pin] of pins) {
      const f = fresh();
      legacyEntry(f.env, sourceId);
      expect(replaceEmptyLegacyAccounts({ ...f.env, ...pin }), JSON.stringify(pin)).toEqual([]);
      expect(layouts(f.env)[sourceId], JSON.stringify(pin)).toBe('active:legacy');
    }

    const listed = fresh();
    legacyEntry(listed.env, TELEGRAM, { corpus_ids: ['internal.telegram.messages'] });
    expect(replaceEmptyLegacyAccounts(listed.env)).toEqual([]);

    const paired = fresh();
    legacyEntry(paired.env, WHATSAPP);
    expect(replaceEmptyLegacyAccounts(writeGrant(paired, 'whatsapp', join(paired.dir, 'old', 'whatsapp-live')).env)).toEqual([]);
    expect(layouts(paired.env)[WHATSAPP]).toBe('active:legacy');

    const deleting = fresh();
    legacyEntry(deleting.env, TELEGRAM, { state: 'deleting' });
    expect(replaceEmptyLegacyAccounts(deleting.env)).toEqual([]);
    expect(layouts(deleting.env)[TELEGRAM]).toBe('deleting:legacy');
  });

  test('a folder entry, and an account with no entry, are left alone', () => {
    const f = fresh();
    placeOwnedAccount({ sourceId: TELEGRAM }, f.env);
    expect(replaceEmptyLegacyAccounts(f.env)).toEqual([]);
    expect(Object.keys(layouts(f.env))).toEqual([TELEGRAM]);
  });

  test('the worker boot step honors a grant and never throws', () => {
    const f = fresh();
    legacyEntry(f.env, TELEGRAM);
    legacyEntry(f.env, WHATSAPP);
    // WhatsApp has a capture grant (it was paired), Telegram has none.
    const registryPath = join(f.dir, 'config', 'handles.json');
    put(defaultMessagingCaptureGrantPath('whatsapp', registryPath), '{}');
    const env = { ...f.env, OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: registryPath };
    expect(replaceEmptyAccountsAtBoot(env)).toEqual([TELEGRAM]);
    expect(layouts(f.env)).toEqual({ [TELEGRAM]: 'active:folder', [WHATSAPP]: 'active:legacy' });

    // An unreadable registry is the storage service's to refuse; the boot step only warns.
    writeFileSync(sourceRegistryPath(f.env), '{broken');
    expect(replaceEmptyAccountsAtBoot(env)).toEqual([]);
  });
});

describe('pairing records the account before it picks a path', () => {
  const TOKEN = 'fixture-worker-token';
  const asWorker = (env: Env): Env => ({ ...env, OLYMPUS_WORKER_AUTH_TOKEN: TOKEN });
  /** A running worker, answering as the worker does: its own environment decides. */
  function runningWorker(workerEnv: Env, asked: string[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/health')) return new Response('{}');
      const operation = url.slice(url.indexOf('/cli/') + '/cli/'.length);
      asked.push(operation);
      const body = JSON.parse(String(init?.body));
      return Response.json(operation === 'pairing-account' ? pairingAccountForCli(body, workerEnv) : pairingPlacementForCli(body, workerEnv));
    }) as typeof fetch;
  }
  const accounts = (env: Env): Array<[string, string]> => readSourceRegistry(env).accounts.map((a) => [a.source_id, a.layout]);

  test('no entry: recorded from the placement decision; an existing entry is followed', async () => {
    const fresher = fresh();
    expect(await settlePairingPlacement({ sourceId: TELEGRAM }, fresher.env)).toBe('folder');
    expect(accounts(fresher.env)).toEqual([[TELEGRAM, 'folder']]);

    const legacy = fresh();
    pinMessagingLegacy(legacy.env);
    expect(await settlePairingPlacement({ sourceId: WHATSAPP }, legacy.env)).toBe('legacy');
    expect(placedAccount(WHATSAPP, legacy.env).layout).toBe('legacy');
  });

  test('the pins: existing files, an override and native ownership record legacy', async () => {
    const files = fresh();
    put(join(files.home, '.local', 'share', 'olympus', 'telegram', 'telegram.personal.session'));
    expect(await settlePairingPlacement({ sourceId: TELEGRAM }, files.env)).toBe('legacy');

    const override = fresh();
    expect(await settlePairingPlacement({ sourceId: WHATSAPP }, { ...override.env, OLYMPUS_WHATSAPP_STATE_DIR: '/elsewhere' })).toBe('legacy');

    const native = fresh();
    expect(await settlePairingPlacement({ sourceId: TELEGRAM }, { ...native.env, OLYMPUS_NATIVE_TELEGRAM_CAPTURE_OWNER: 'true' })).toBe('legacy');
    expect(accounts(native.env)).toEqual([[TELEGRAM, 'legacy']]);
  });

  test('an account being deleted cannot be paired', async () => {
    const f = fresh();
    updateSourceRegistry(f.env, (registry) => {
      registry.accounts.push({ source_id: TELEGRAM, slot: '1', state: 'deleting', layout: 'folder', corpus_ids: [], created_at: '2026-10-01T00:00:00.000Z' });
    });
    await expect(settlePairingPlacement({ sourceId: TELEGRAM }, f.env)).rejects.toBeInstanceOf(SourceStorageUnavailableError);
  });

  test('while a worker owns the data it decides, from its own environment, and the pairing uses its folder', async () => {
    const f = fresh();
    held.push(holdDataOwnerLock(f.env)); // the worker, booted but not yet recorded
    const asked: string[] = [];
    const sessions: Array<string | undefined> = [];
    const paired = await pairTelegram(f, (path) => sessions.push(path), { env: asWorker(f.env), workerFetch: runningWorker(f.env, asked) });
    // The worker places the account, then records the Telegram account the pairing proved (storage step 4e).
    expect(asked).toEqual(['pairing-placement', 'pairing-account']);
    expect(readSourceRegistry(f.env).accounts[0]?.provider_account_hash).toMatch(/^telegram:[0-9a-f]{16}$/);
    expect(paired.result.sessionLayout).toBe('folder');
    expect(sessions).toEqual([`${telegramSessionBasePath({ env: f.env, homeDir: f.home })}`]);
    expect(inside(sessions[0]!, folderOf(TELEGRAM, f.env))).toBe(true);
    // What the worker recorded is what the pairing used, so a later boot finds nothing to change.
    expect(accounts(f.env)).toEqual([[TELEGRAM, 'folder']]);
    expect(replaceEmptyLegacyAccounts(f.env)).toEqual([]);
  });

  test('a worker whose environment pins the account keeps it legacy, whatever the CLI\'s environment says', async () => {
    const f = fresh();
    held.push(holdDataOwnerLock(f.env));
    const workerEnv = { ...f.env, OLYMPUS_NATIVE_WHATSAPP_CAPTURE_OWNER: 'true' };
    expect(await settlePairingPlacement({ sourceId: WHATSAPP }, asWorker(f.env), { fetchImpl: runningWorker(workerEnv) })).toBe('legacy');
    expect(accounts(f.env)).toEqual([[WHATSAPP, 'legacy']]);
  });

  test('a worker that does not answer makes the pairing refuse before anything is made or run', async () => {
    const f = fresh();
    held.push(holdDataOwnerLock(f.env));
    let helperRan = false;
    await expect(pairTelegram(f, () => { helperRan = true; }, {
      env: asWorker(f.env),
      workerFetch: (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch,
    })).rejects.toThrow('Olympus');
    expect(helperRan).toBe(false);
    expect(existsSync(sourceRegistryPath(f.env))).toBe(false);
    expect(existsSync(join(f.home, '.local', 'share', 'olympus', 'telegram'))).toBe(false);
  });

  test('an entry that exists is followed without asking the worker', async () => {
    const f = fresh();
    placeOwnedAccount({ sourceId: TELEGRAM }, f.env);
    held.push(holdDataOwnerLock(f.env));
    const asked: string[] = [];
    expect(await settlePairingPlacement({ sourceId: TELEGRAM }, asWorker(f.env), { fetchImpl: runningWorker(f.env, asked) })).toBe('folder');
    expect(asked).toEqual([]);
  });

  test('a pairing that took the legacy paths cannot be re-placed into a folder under it', async () => {
    const f = fresh();
    pinMessagingLegacy(f.env); // an empty legacy entry: exactly what boot re-placement would move
    const boot: string[][] = [];
    const paired = await pairTelegram(f, (path) => {
      // The worker restarts while the helper waits for the login code, before any grant exists.
      boot.push(replaceEmptyAccountsAtBoot(f.env));
      put(`${path}.session`, 'login');
    });
    // Only WhatsApp, which nothing is pairing, is placed in its folder.
    expect(boot).toEqual([[WHATSAPP]]);
    expect(paired.result.sessionLayout).toBe('legacy');
    expect(accounts(f.env)).toEqual([[TELEGRAM, 'legacy'], [WHATSAPP, 'folder']]);
    const grant = JSON.parse(readFileSync(paired.grantPath, 'utf8'));
    expect(grant.sessionPath).toBe(telegramSessionBasePath({ env: f.env, homeDir: f.home }));
  });

  test('a re-placement that ran between the answer and the claim is followed, and the claim given back', async () => {
    const f = fresh();
    held.push(holdDataOwnerLock(f.env));
    const workerEnv = { ...f.env, OLYMPUS_NATIVE_TELEGRAM_CAPTURE_OWNER: 'true' };
    const answering = runningWorker(workerEnv);
    const restartedWorker = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await answering(input, init);
      // The worker answered legacy; then it restarted, without the flag, and re-placed the empty entry.
      if (String(input).includes('/cli/')) replaceEmptyLegacyAccounts(f.env);
      return response;
    }) as typeof fetch;
    expect(await settlePairingPlacement({ sourceId: TELEGRAM }, asWorker(f.env), { fetchImpl: restartedWorker })).toBe('folder');
    expect(accounts(f.env)).toEqual([[TELEGRAM, 'folder']]);
    expect(existsSync(join(f.home, '.local', 'share', 'olympus', 'telegram'))).toBe(false);
  });
});

/** A legacy account's capture grant, at the handle registry an environment names: it records the path the session was paired at. */
function writeGrant(
  f: { dir: string; env: Env },
  source: 'telegram' | 'whatsapp',
  sessionPath: string | undefined,
): { env: Env; grantPath: string; registryPath: string } {
  const registryPath = join(f.dir, 'config', 'handles.json');
  writeHandles(registryPath, source);
  const grantPath = defaultMessagingCaptureGrantPath(source, registryPath);
  saveMessagingCaptureGrant({
    path: grantPath,
    pairing: {
      ok: true, source, handles: [source === 'telegram' ? 'telegram.personal' : 'whatsapp.personal_local'], secretRefs: [], status: 'connected',
      sessionPath: sessionPath ?? join(f.dir, 'unused'), ...(sessionPath === undefined ? { sessionLayout: 'folder' } : {}),
      accountProof: `${source}:fixture`, chats: [], captureStarted: false, registered: true,
      producer: { source, executable: '/fixture/python3', args: [], env: {}, secretEnvironment: [], captureStarted: false },
    } as never,
  });
  return { env: { ...f.env, OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: registryPath }, grantPath, registryPath };
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('a capture grant pins its account to the paths it was paired at', () => {
  test('a grant that names its session path keeps the account legacy when a store opens first, and the capture child then finds its session', async () => {
    const f = fresh();
    const paired = await pairTelegram(f, (path) => writeFileSync(`${path}.session`, 'login'));
    // An older install's pairing: the grant names a place of its own, and the registry has no entry yet.
    const legacyBase = join(f.dir, 'old-place', 'telegram.personal');
    put(`${legacyBase}.session`);
    const grant = JSON.parse(readFileSync(paired.grantPath, 'utf8'));
    grant.sessionPath = legacyBase;
    grant.producer.env.OLYMPUS_TELEGRAM_SESSION_PATH = legacyBase;
    writeFileSync(paired.grantPath, JSON.stringify(grant));
    rmSync(sourceRegistryPath(f.env), { force: true });
    const env = { ...f.env, OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: paired.registryPath };

    // Store mounting runs at worker boot, before the capture supervisor reconciles.
    enableSourceRegistryAdoption();
    try {
      openConnectorStore({ sourceId: TELEGRAM }, {
        dbPath: defaultInternalTelegramConnectorStoreDbPath(env),
        corpusId: 'internal.telegram.messages',
        family: 'chat',
        trustDomain: 'internal',
      }, env).close();
    } finally {
      __sourceStorageTestHooks.disableAdoption();
    }
    expect(readSourceRegistry(env).accounts.map((a) => [a.source_id, a.layout])).toEqual([[TELEGRAM, 'legacy']]);

    let childEnv: Record<string, string> | undefined;
    expect(await telegramSupervisor({ env }, paired, (spawned) => {
      childEnv = spawned;
      return fakeChild();
    }).reconcile()).toEqual({ source: 'telegram', state: 'running' });
    expect(childEnv!.OLYMPUS_TELEGRAM_SESSION_PATH).toBe(legacyBase);
  });

  test('a grant that cannot be read, or sits where it cannot be looked for, pins legacy; no grant, and a grant with no path, pin nothing', () => {
    const none = fresh();
    expect(decideAccountLayout(TELEGRAM, { ...none.env, OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: join(none.dir, 'config', 'handles.json') }).layout).toBe('folder');

    const folderGrant = fresh();
    expect(decideAccountLayout(TELEGRAM, writeGrant(folderGrant, 'telegram', undefined).env).layout).toBe('folder');

    const named = fresh();
    expect(decideAccountLayout(TELEGRAM, writeGrant(named, 'telegram', join(named.dir, 'old', 'telegram.personal')).env)).toMatchObject({
      layout: 'legacy',
      why: expect.stringContaining('capture grant'),
    });

    const broken = fresh();
    const brokenGrant = writeGrant(broken, 'telegram', undefined);
    writeFileSync(brokenGrant.grantPath, '{not json');
    expect(decideAccountLayout(TELEGRAM, brokenGrant.env)).toMatchObject({ layout: 'legacy', why: expect.stringContaining('capture grant') });

    const loose = fresh();
    const looseGrant = writeGrant(loose, 'whatsapp', undefined);
    chmodSync(looseGrant.grantPath, 0o666);
    expect(decideAccountLayout(WHATSAPP, looseGrant.env).layout).toBe('legacy');

    const other = fresh();
    const otherGrant = writeGrant(other, 'telegram', undefined);
    const wrongSource = JSON.parse(readFileSync(otherGrant.grantPath, 'utf8'));
    writeFileSync(otherGrant.grantPath, JSON.stringify({ ...wrongSource, source: 'whatsapp', producer: { ...wrongSource.producer, source: 'whatsapp' } }));
    expect(decideAccountLayout(TELEGRAM, otherGrant.env).layout).toBe('legacy');

    // A path through something that is not a folder cannot hold a grant: confirmed absent.
    const blocked = fresh();
    put(join(blocked.dir, 'config'), 'a file where the folder should be');
    expect(decideAccountLayout(TELEGRAM, { ...blocked.env, OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: join(blocked.dir, 'config', 'handles.json') }).layout).toBe('folder');
  });

  test.skipIf(isRoot)('a grant place that cannot be searched is not taken for no grant', () => {
    const f = fresh();
    const { env, grantPath } = writeGrant(f, 'telegram', undefined);
    const folder = dirname(grantPath);
    chmodSync(folder, 0o000);
    try {
      expect(decideAccountLayout(TELEGRAM, env)).toMatchObject({ layout: 'legacy', why: expect.stringContaining('capture grant') });
    } finally {
      chmodSync(folder, 0o700);
    }
  });

  test('boot re-placement leaves an account alone whose grant names a path or cannot be read', () => {
    const legacyEntry = (env: Env, sourceId: string): void => {
      updateSourceRegistry(env, (registry) => {
        registry.accounts.push({ source_id: sourceId, slot: '1', state: 'active', layout: 'legacy', corpus_ids: [], created_at: '2026-10-01T00:00:00.000Z' });
      });
    };
    const control = fresh();
    legacyEntry(control.env, TELEGRAM);
    expect(replaceEmptyLegacyAccounts({ ...control.env, OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: join(control.dir, 'config', 'handles.json') })).toEqual([TELEGRAM]);

    const named = fresh();
    legacyEntry(named.env, TELEGRAM);
    expect(replaceEmptyLegacyAccounts(writeGrant(named, 'telegram', join(named.dir, 'old', 'telegram.personal')).env)).toEqual([]);

    const broken = fresh();
    legacyEntry(broken.env, WHATSAPP);
    const brokenGrant = writeGrant(broken, 'whatsapp', undefined);
    writeFileSync(brokenGrant.grantPath, '{not json');
    expect(replaceEmptyLegacyAccounts(brokenGrant.env)).toEqual([]);
    expect(readSourceRegistry(broken.env).accounts.map((a) => [a.source_id, a.layout])).toEqual([[WHATSAPP, 'legacy']]);
  });

  test.skipIf(isRoot)('the boot step does not take an inaccessible grant for an absent one', () => {
    const f = fresh();
    updateSourceRegistry(f.env, (registry) => {
      registry.accounts.push({ source_id: TELEGRAM, slot: '1', state: 'active', layout: 'legacy', corpus_ids: [], created_at: '2026-10-01T00:00:00.000Z' });
    });
    const { env, grantPath } = writeGrant(f, 'telegram', join(f.dir, 'old', 'telegram.personal'));
    const folder = dirname(grantPath);
    chmodSync(folder, 0o000);
    try {
      expect(replaceEmptyAccountsAtBoot(env)).toEqual([]);
    } finally {
      chmodSync(folder, 0o700);
    }
    expect(readSourceRegistry(f.env).accounts.map((a) => [a.source_id, a.layout])).toEqual([[TELEGRAM, 'legacy']]);
  });
});

describe('the WhatsApp live-sync script', () => {
  test('a legacy account keeps the script\'s own paths: it ignored a relocated data folder and every override but the state folder\'s', () => {
    const f = fresh({ relocated: true });
    pinMessagingLegacy(f.env);
    const old = join(f.home, '.local', 'share', 'olympus', 'whatsapp-live');
    const env = {
      ...f.env,
      OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_DIR: join(f.dir, 'elsewhere', 'spool'),
      OLYMPUS_WHATSAPP_CONNECTOR_STORE_DB_PATH: join(f.dir, 'elsewhere', 'store.db'),
      OLYMPUS_SOURCE_INDEX_WHATSAPP_CONNECTOR_STORE_DB_PATH: join(f.dir, 'elsewhere', 'index.db'),
    };
    expect(whatsAppLiveSyncScriptPaths(env, f.home)).toEqual({ spoolDir: join(old, 'spool'), dbPath: join(old, 'connector-store.db') });
    // The state folder override it always honored.
    const state = join(f.dir, 'bridge-state');
    expect(whatsAppLiveSyncScriptPaths({ ...env, OLYMPUS_WHATSAPP_STATE_DIR: ` ${state} ` }, f.home))
      .toEqual({ spoolDir: join(state, 'spool'), dbPath: join(state, 'connector-store.db') });
  });

  test('a folder account uses the folder: the worker\'s paths', () => {
    const f = fresh({ relocated: true });
    placeOwnedAccount({ sourceId: WHATSAPP }, f.env);
    const folder = folderOf(WHATSAPP, f.env);
    expect(whatsAppLiveSyncScriptPaths(f.env, f.home)).toEqual({
      spoolDir: join(folder, 'raw', 'whatsapp', 'spool'),
      dbPath: join(folder, 'stores', 'secure_local.sqlite'),
    });
  });
});

describe('WhatsApp media', () => {
  test('a folder account\'s media folder is the allowed media root; a legacy account\'s is the audio folder it always was', () => {
    const folder = fresh();
    expect(defaultWhatsAppMediaRoots(folder.env)).toEqual([join(folderOf(WHATSAPP, folder.env), 'raw', 'whatsapp', 'media')]);

    const legacy = fresh();
    pinMessagingLegacy(legacy.env);
    expect(defaultWhatsAppMediaRoots(legacy.env)).toEqual([join(legacy.home, '.local', 'share', 'olympus', 'whatsapp-live', 'media', 'audio')]);
    expect(relative(legacy.home, defaultWhatsAppMediaRoots(legacy.env)[0]!)).toContain('whatsapp-live');
  });
});

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
import { SourceStorageUnavailableError, recordPairingPlacement, replaceEmptyLegacyAccounts } from '../src/core/source-storage.ts';
import { deleteOlympusData } from '../src/data-lifecycle.ts';
import { replaceEmptyAccountsAtBoot } from '../src/workers/email-source/server.ts';
import { defaultWhatsAppMediaRoots } from '../src/workers/whatsapp/store-sync.ts';
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

async function pairTelegram(f: { dir: string; home: string; env: Env }, runCommandSession: (path: string | undefined) => void = () => {}): Promise<Paired> {
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
    recordPairingPlacement({ sourceId: WHATSAPP }, f.env);
    recordPairingPlacement({ sourceId: 'x.bookmarks' }, f.env);
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
    recordPairingPlacement({ sourceId: TELEGRAM }, f.env);
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
      recordPairingPlacement({ sourceId: WHATSAPP }, env);
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
    recordPairingPlacement({ sourceId: 'readwise.library' }, f.env);
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
    recordPairingPlacement({ sourceId: 'readwise.library' }, f.env);
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
    expect(replaceEmptyLegacyAccounts(paired.env, { isPaired: (sourceId) => sourceId === WHATSAPP })).toEqual([]);
    expect(layouts(paired.env)[WHATSAPP]).toBe('active:legacy');

    const deleting = fresh();
    legacyEntry(deleting.env, TELEGRAM, { state: 'deleting' });
    expect(replaceEmptyLegacyAccounts(deleting.env)).toEqual([]);
    expect(layouts(deleting.env)[TELEGRAM]).toBe('deleting:legacy');
  });

  test('a folder entry, and an account with no entry, are left alone', () => {
    const f = fresh();
    recordPairingPlacement({ sourceId: TELEGRAM }, f.env);
    expect(replaceEmptyLegacyAccounts(f.env)).toEqual([]);
    expect(Object.keys(layouts(f.env))).toEqual([TELEGRAM]);
  });

  test('the worker boot step is paired-aware and never throws', () => {
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
  test('no entry: recorded from the placement decision; an existing entry is followed', () => {
    const fresher = fresh();
    expect(recordPairingPlacement({ sourceId: TELEGRAM }, fresher.env)).toBe('folder');
    expect(readSourceRegistry(fresher.env).accounts.map((a) => [a.source_id, a.layout])).toEqual([[TELEGRAM, 'folder']]);

    const legacy = fresh();
    pinMessagingLegacy(legacy.env);
    expect(recordPairingPlacement({ sourceId: WHATSAPP }, legacy.env)).toBe('legacy');
    // Following the entry means no files are needed to keep it legacy.
    expect(decideAccountLayout(WHATSAPP, legacy.env).layout).toBe('folder');
    expect(placedAccount(WHATSAPP, legacy.env).layout).toBe('legacy');
  });

  test('the pins: existing files, an override and native ownership record legacy', () => {
    const files = fresh();
    put(join(files.home, '.local', 'share', 'olympus', 'telegram', 'telegram.personal.session'));
    expect(recordPairingPlacement({ sourceId: TELEGRAM }, files.env)).toBe('legacy');

    const override = fresh();
    expect(recordPairingPlacement({ sourceId: WHATSAPP }, { ...override.env, OLYMPUS_WHATSAPP_STATE_DIR: '/elsewhere' })).toBe('legacy');

    const native = fresh();
    expect(recordPairingPlacement({ sourceId: TELEGRAM }, { ...native.env, OLYMPUS_NATIVE_TELEGRAM_CAPTURE_OWNER: 'true' })).toBe('legacy');
    expect(readSourceRegistry(native.env).accounts.map((a) => [a.source_id, a.layout])).toEqual([[TELEGRAM, 'legacy']]);
  });

  test('while another process owns the data nothing is recorded and the pairing keeps the old paths', () => {
    const f = fresh();
    held.push(holdDataOwnerLock(f.env));
    expect(recordPairingPlacement({ sourceId: TELEGRAM }, f.env)).toBe('legacy');
    expect(existsSync(sourceRegistryPath(f.env))).toBe(false);
  });

  test('an account being deleted cannot be paired', () => {
    const f = fresh();
    updateSourceRegistry(f.env, (registry) => {
      registry.accounts.push({ source_id: TELEGRAM, slot: '1', state: 'deleting', layout: 'folder', corpus_ids: [], created_at: '2026-10-01T00:00:00.000Z' });
    });
    expect(() => recordPairingPlacement({ sourceId: TELEGRAM }, f.env)).toThrow(SourceStorageUnavailableError);
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

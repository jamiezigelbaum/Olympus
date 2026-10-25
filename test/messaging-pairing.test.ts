import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pairMessagingSource,
  TELEGRAM_API_HASH_SECRET_KEY,
  TELEGRAM_API_ID_SECRET_KEY,
  type PairingCommandRequest,
  type PairingCommandResult,
} from '../src/core/messaging-pairing.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import { readSourceRegistry, updateSourceRegistry } from '../src/core/source-registry.ts';
import { connectGuidedSession } from '../src/core/connect.ts';

function memorySecretStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    label: 'memory',
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
    list: async () => [...values.keys()],
  };
}

function packageFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-messaging-pairing-'));
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

function telegramReady(sessionPath?: string): PairingCommandResult {
  return {
    exitCode: 0,
    stderr: '',
    stdoutLines: [JSON.stringify({
      event: 'ready',
      status: 'ready',
      session_path: sessionPath,
      proof: {
        authorized: true,
        account_ref: 'abcdef0123456789',
        session_persisted: true,
        credentials_transferred: true,
      },
      dialogs: [
        { chat_scope: 'telegram.personal:chat:101', kind: 'dm', title: 'Ada' },
        { chat_scope: 'telegram.personal:chat:-202', kind: 'group', title: 'Builders' },
      ],
      capture_started: false,
    })],
    privatePayload: '{"api_id":12345,"api_hash":"fixture-hash"}',
  };
}

function whatsappReady(qrPath: string): PairingCommandResult {
  return {
    exitCode: 0,
    stderr: '',
    stdoutLines: [
      JSON.stringify({ event: 'qr', qr_png_path: qrPath }),
      JSON.stringify({
        event: 'ready',
        status: 'ready',
        proof: { authenticated: true, device_persisted: true },
        capture_started: false,
      }),
    ],
  };
}

describe('packaged messaging pairing', () => {
  test('Telegram authorization alone lists metadata but neither registers nor starts capture', async () => {
    const root = packageFixture();
    const secrets = memorySecretStore();
    let command: PairingCommandRequest | undefined;
    let registered = false;
    const result = await pairMessagingSource({
      source: 'telegram',
      packageRoot: root,
      homeDir: join(root, 'home'),
      env: {},
      pythonExecutable: '/usr/bin/python3',
      secretStore: secrets,
      runCommand: async (request) => {
        command = request;
        return telegramReady(command.env.OLYMPUS_TELEGRAM_SESSION_PATH);
      },
      registerSession: async () => {
        registered = true;
        throw new Error('must not register');
      },
    });

    expect(result.status).toBe('scope_selection_required');
    expect(result.registered).toBe(false);
    expect(result.captureStarted).toBe(false);
    expect(result.chats).toEqual([
      { chatScope: 'telegram.personal:chat:101', kind: 'dm', title: 'Ada' },
      { chatScope: 'telegram.personal:chat:-202', kind: 'group', title: 'Builders' },
    ]);
    expect(registered).toBe(false);
    expect(command?.args).toEqual([join(root, 'scripts', 'telegram-pair.py')]);
    expect(command?.args.join(' ')).not.toMatch(/api_hash|phone|password|login.code/i);
    expect(command?.env.OLYMPUS_TELEGRAM_API_ID).toBeUndefined();
    expect(command?.env.OLYMPUS_TELEGRAM_API_HASH).toBeUndefined();
    expect(secrets.values.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain('fixture-hash');
  });

  test('Telegram publishes ready only after an exact listed-chat approval', async () => {
    const root = packageFixture();
    const secrets = memorySecretStore();
    let registration: Record<string, unknown> | undefined;
    const result = await pairMessagingSource({
      source: 'telegram',
      packageRoot: root,
      homeDir: join(root, 'home'),
      env: {},
      pythonExecutable: '/usr/bin/python3',
      secretStore: secrets,
      captureScopeApproval: {
        source: 'telegram',
        explicitApproval: true,
        chatScopes: ['telegram.personal:chat:101'],
      },
      runCommand: async (request) => telegramReady(request.env.OLYMPUS_TELEGRAM_SESSION_PATH),
      registerSession: async (input) => {
        registration = input as unknown as Record<string, unknown>;
        return { ok: true, source: 'telegram', handles: ['telegram.personal'], secretRefs: [] };
      },
    });

    expect(result.status).toBe('connected');
    if (result.status !== 'connected') throw new Error('expected connected result');
    expect(result.registered).toBe(true);
    expect(registration?.sessionReady).toBe(true);
    expect(result.producer.captureStarted).toBe(false);
    // A fresh install pairs into its account folder; the capture command carries no path (its spawner sets them).
    expect(result.sessionLayout).toBe('folder');
    expect(result.sessionPath).toBe(join(root, 'home', '.local/share/openclaw/olympus/sources/telegram.messages/1/session/telegram'));
    expect(result.producer.env.OLYMPUS_TELEGRAM_SESSION_PATH).toBeUndefined();
    expect(result.producer.env.OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES).toBe(result.producer.env.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES);
    expect(result.producer.env.OLYMPUS_SOURCE_INDEX_TELEGRAM_PROTECTED_CHAT_SCOPES).toBe(result.producer.env.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES);
    expect(result.producer.env.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES)
      .toBe('telegram.personal:chat:101');
    expect(result.producer.secretEnvironment).toEqual([
      { env: 'OLYMPUS_TELEGRAM_API_ID', secretKey: TELEGRAM_API_ID_SECRET_KEY },
      { env: 'OLYMPUS_TELEGRAM_API_HASH', secretKey: TELEGRAM_API_HASH_SECRET_KEY },
    ]);
    expect(secrets.values.get(TELEGRAM_API_HASH_SECRET_KEY)).toBe('fixture-hash');
    expect(JSON.stringify(result)).not.toContain('fixture-hash');
  });

  test('Telegram on an install that already has its files keeps the legacy session path in the capture command', async () => {
    const root = packageFixture();
    mkdirSync(join(root, 'home', '.local/share/olympus/telegram-capture/spool'), { recursive: true });
    const result = await pairMessagingSource({
      source: 'telegram',
      packageRoot: root,
      homeDir: join(root, 'home'),
      env: {},
      pythonExecutable: '/usr/bin/python3',
      secretStore: memorySecretStore(),
      captureScopeApproval: { source: 'telegram', explicitApproval: true, chatScopes: ['telegram.personal:chat:101'] },
      runCommand: async (request) => telegramReady(request.env.OLYMPUS_TELEGRAM_SESSION_PATH),
      registerSession: async () => ({ ok: true, source: 'telegram', handles: ['telegram.personal'], secretRefs: [] }),
    });
    if (result.status !== 'connected') throw new Error('expected connected result');
    const legacyBase = join(root, 'home', '.local/share/olympus/telegram/telegram.personal');
    expect(result.sessionLayout).toBe('legacy');
    expect(result.sessionPath).toBe(legacyBase);
    expect(result.producer.env.OLYMPUS_TELEGRAM_SESSION_PATH).toBe(legacyBase);
  });

  test('Telegram refuses an unlisted chat before publishing the handle', async () => {
    const root = packageFixture();
    let registered = false;
    await expect(pairMessagingSource({
      source: 'telegram',
      packageRoot: root,
      homeDir: join(root, 'home'),
      env: {},
      pythonExecutable: '/usr/bin/python3',
      secretStore: memorySecretStore(),
      captureScopeApproval: {
        source: 'telegram',
        explicitApproval: true,
        chatScopes: ['telegram.personal:chat:999'],
      },
      runCommand: async (request) => telegramReady(request.env.OLYMPUS_TELEGRAM_SESSION_PATH),
      registerSession: async () => {
        registered = true;
        throw new Error('must not register');
      },
    })).rejects.toThrow(/not in the verified account listing/);
    expect(registered).toBe(false);
  });

  test('an incomplete Telegram proof cannot become available', async () => {
    const root = packageFixture();
    let registered = false;
    await expect(pairMessagingSource({
      source: 'telegram',
      packageRoot: root,
      homeDir: join(root, 'home'),
      env: {},
      pythonExecutable: '/usr/bin/python3',
      secretStore: memorySecretStore(),
      captureScopeApproval: {
        source: 'telegram',
        explicitApproval: true,
        chatScopes: ['telegram.personal:chat:101'],
      },
      runCommand: async () => ({
        exitCode: 0,
        stderr: '',
        stdoutLines: [JSON.stringify({
          event: 'ready', status: 'ready', proof: { authorized: true }, capture_started: false,
        })],
      }),
      registerSession: async () => {
        registered = true;
        throw new Error('must not register');
      },
    })).rejects.toThrow(/readiness proof was incomplete/);
    expect(registered).toBe(false);
  });

  test('WhatsApp on a fresh install pairs into its account folder: the bridge is handed the folder and the capture command carries no path', async () => {
    const root = packageFixture();
    const stateDir = join(root, 'home', '.local/share/openclaw/olympus/sources/whatsapp.personal.messages/1/raw/whatsapp');
    const qrPath = join(stateDir, 'qr.png');
    const seenQr: string[] = [];
    let command: PairingCommandRequest | undefined;
    const result = await pairMessagingSource({
      source: 'whatsapp',
      packageRoot: root,
      whatsappBridgePath: join(root, 'cache', 'olympus', 'bin', 'olympus-whatsapp-bridge'),
      homeDir: join(root, 'home'),
      env: {},
      whatsappQrMode: 'artifact',
      captureScopeApproval: {
        source: 'whatsapp',
        explicitApproval: true,
        chatJids: ['chat-1@s.whatsapp.net'],
      },
      onWhatsAppQr: async (path) => { seenQr.push(path); },
      runCommand: async (request) => {
        command = request;
        for (const line of whatsappReady(qrPath).stdoutLines) await request.onStdoutLine?.(line);
        return whatsappReady(qrPath);
      },
      registerSession: async () => ({
        ok: true, source: 'whatsapp', handles: ['whatsapp.personal_local'], secretRefs: [],
      }),
    });

    expect(command?.args).toEqual(['--pair-only']);
    expect(command?.env.OLYMPUS_WHATSAPP_STATE_DIR).toBe(stateDir);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(command?.env.OLYMPUS_WHATSAPP_QR_STDOUT).toBe('false');
    expect(command?.env.OLYMPUS_WHATSAPP_PAIR_TTY_QR).toBe('false');
    expect(seenQr).toEqual([qrPath]);
    expect(result.status).toBe('connected');
    if (result.status !== 'connected') throw new Error('expected connected result');
    expect(result.qrPngPath).toBe(qrPath);
    expect(result.sessionLayout).toBe('folder');
    expect(result.sessionPath).toBe(stateDir);
    expect(result.producer).toEqual({
      source: 'whatsapp',
      executable: join(root, 'cache', 'olympus', 'bin', 'olympus-whatsapp-bridge'),
      args: ['--capture-approved'],
      env: {
        OLYMPUS_WHATSAPP_QR_STDOUT: 'false',
        OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS: 'chat-1@s.whatsapp.net',
      },
      secretEnvironment: [],
      captureStarted: false,
    });
  });

  test('WhatsApp on an install that already has its files keeps the legacy state folder, and reports the private PNG and returns an approved capture command without starting it', async () => {
    const root = packageFixture();
    const qrPath = join(root, 'home', '.local/share/olympus/whatsapp-live/qr.png');
    // Files at the legacy location are what keep an account there.
    mkdirSync(join(root, 'home', '.local/share/olympus/whatsapp-live'), { recursive: true });
    writeFileSync(join(root, 'home', '.local/share/olympus/whatsapp-live/connector-store.db'), '');
    const seenQr: string[] = [];
    let command: PairingCommandRequest | undefined;
    const result = await pairMessagingSource({
      source: 'whatsapp',
      packageRoot: root,
      whatsappBridgePath: join(root, 'cache', 'olympus', 'bin', 'olympus-whatsapp-bridge'),
      homeDir: join(root, 'home'),
      env: {},
      whatsappQrMode: 'artifact',
      captureScopeApproval: {
        source: 'whatsapp',
        explicitApproval: true,
        chatJids: ['chat-1@s.whatsapp.net'],
      },
      onWhatsAppQr: async (path) => { seenQr.push(path); },
      runCommand: async (request) => {
        command = request;
        for (const line of whatsappReady(qrPath).stdoutLines) await request.onStdoutLine?.(line);
        return whatsappReady(qrPath);
      },
      registerSession: async () => ({
        ok: true, source: 'whatsapp', handles: ['whatsapp.personal_local'], secretRefs: [],
      }),
    });

    expect(command?.args).toEqual(['--pair-only']);
    expect(command?.env.OLYMPUS_WHATSAPP_QR_STDOUT).toBe('false');
    expect(command?.env.OLYMPUS_WHATSAPP_PAIR_TTY_QR).toBe('false');
    expect(seenQr).toEqual([qrPath]);
    expect(result.status).toBe('connected');
    if (result.status !== 'connected') throw new Error('expected connected result');
    expect(result.qrPngPath).toBe(qrPath);
    expect(result.sessionLayout).toBe('legacy');
    expect(result.producer).toEqual({
      source: 'whatsapp',
      executable: join(root, 'cache', 'olympus', 'bin', 'olympus-whatsapp-bridge'),
      args: ['--capture-approved'],
      env: {
        OLYMPUS_WHATSAPP_STATE_DIR: join(root, 'home', '.local/share/olympus/whatsapp-live'),
        OLYMPUS_WHATSAPP_QR_STDOUT: 'false',
        OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS: 'chat-1@s.whatsapp.net',
      },
      secretEnvironment: [],
      captureStarted: false,
    });
  });

  test('a configured missing WhatsApp bridge is refused', async () => {
    const root = packageFixture();
    const missing = join(root, 'not-built');
    await expect(pairMessagingSource({
      source: 'whatsapp',
      packageRoot: root,
      homeDir: join(root, 'home'),
      env: {},
      whatsappBridgePath: missing,
      runCommand: async () => whatsappReady('/private/qr.png'),
    })).rejects.toThrow(/configured WhatsApp pairing bridge does not exist/);
  });

  for (const code of ['unsupported_passkey_verification', 'client_outdated', 'unexpected_link_state']) {
    test(`reports ${code} without publishing a connected handle or exposing provider text`, async () => {
      const root = packageFixture();
      let registered = false;
      let errorText = '';
      try {
        await pairMessagingSource({
          source: 'whatsapp', packageRoot: root,
      homeDir: join(root, 'home'),
      env: {},
          whatsappBridgePath: join(root, 'cache', 'olympus', 'bin', 'olympus-whatsapp-bridge'),
          runCommand: async () => ({ exitCode: 1, stdoutLines: [], stderr: `private fixture payload\n{"error":"${code}"}` }),
          registerSession: async () => { registered = true; throw new Error('must not register'); },
        });
      } catch (error) { errorText = (error as Error).message; }
      expect(errorText).not.toBe('');
      expect(errorText).not.toContain('private fixture payload');
      expect(errorText).not.toContain('/bin/olympus-whatsapp-bridge');
      expect(registered).toBe(false);
    });
  }

  test('builds pinned WhatsApp sources into a versioned owner cache when toolchains exist', async () => {
    const root = packageFixture();
    let builtPath = '';
    const result = await pairMessagingSource({
      source: 'whatsapp',
      packageRoot: root,
      homeDir: join(root, 'home'),
      env: { XDG_CACHE_HOME: join(root, 'fresh-cache') },
      which: (command) => command === 'go' || command === 'cc' ? `/fixture/${command}` : null,
      buildWhatsAppBridge: async ({ outputPath }) => {
        builtPath = outputPath;
        writeFileSync(outputPath, '#!/bin/sh\n');
        return true;
      },
      runCommand: async () => whatsappReady('/private/qr.png'),
    });
    expect(builtPath).toMatch(/fresh-cache\/olympus\/bin\/olympus-whatsapp-bridge-[0-9a-f]{16}$/);
    expect(result.status).toBe('scope_selection_required');
  });

  test('missing Telethon maps to a fixed command and does not echo helper stderr', async () => {
    const root = packageFixture();
    await expect(pairMessagingSource({
      source: 'telegram',
      packageRoot: root,
      homeDir: join(root, 'home'),
      env: {},
      pythonExecutable: '/usr/bin/python3',
      secretStore: memorySecretStore(),
      runCommand: async () => ({
        exitCode: 2,
        stdoutLines: [],
        stderr: '{"error":"telethon_not_installed"}\nprivate provider detail',
      }),
    })).rejects.toThrow('python3 -m venv ~/.cache/olympus/telegram-python');
  });
});

describe('a Telegram history keeps its account (storage step 4e)', () => {
  const PROVED = 'telegram:abcdef0123456789';
  const folderSession = (root: string) => join(root, 'home', '.local/share/openclaw/olympus/sources/telegram.messages/1/session/telegram');
  const registryEnv = (root: string) => ({ HOME: join(root, 'home') });
  const history = (root: string, providerAccountHash?: string) => updateSourceRegistry(registryEnv(root), (registry) => {
    registry.accounts.push({
      source_id: 'telegram.messages',
      slot: '1',
      state: 'active',
      layout: 'folder',
      corpus_ids: ['secure_local.telegram.messages'],
      ...(providerAccountHash ? { provider_account_hash: providerAccountHash } : {}),
      created_at: '2026-10-25T00:00:00.000Z',
    });
  });
  const pair = (
    root: string,
    secrets: SecretStore,
    onRegister: (input: Record<string, unknown>) => void,
    pairedAt: string[],
    during: (base: string) => void = () => undefined,
  ) => pairMessagingSource({
    source: 'telegram',
    packageRoot: root,
    homeDir: join(root, 'home'),
    env: {},
    pythonExecutable: '/usr/bin/python3',
    secretStore: secrets,
    captureScopeApproval: { source: 'telegram', explicitApproval: true, chatScopes: ['telegram.personal:chat:101'] },
    runCommand: async (request) => {
      // The helper writes the login where it is told.
      const base = request.env.OLYMPUS_TELEGRAM_SESSION_PATH!;
      pairedAt.push(base);
      mkdirSync(join(base, '..'), { recursive: true });
      during(base);
      if (!existsSync(`${base}.session`)) writeFileSync(`${base}.session`, 'login');
      return telegramReady(base);
    },
    registerSession: async (input) => {
      onRegister(input as unknown as Record<string, unknown>);
      return { ok: true, source: 'telegram', handles: ['telegram.personal'], secretRefs: [] };
    },
  });
  const isAside = (root: string, base: string | undefined) => base !== undefined
    && base.startsWith(`${folderSession(root)}.pairing-${process.pid}-`) && /-[0-9a-f]{8}$/.test(base);
  const sessionFolder = (root: string) => readdirSync(join(folderSession(root), '..')).sort();
  const hashOf = (root: string) => readSourceRegistry(registryEnv(root)).accounts
    .find((account) => account.source_id === 'telegram.messages')?.provider_account_hash;

  test('a first pairing records the account it proved', async () => {
    const root = packageFixture();
    const pairedAt: string[] = [];
    const result = await pair(root, memorySecretStore(), () => undefined, pairedAt);
    expect(result.status).toBe('connected');
    expect(pairedAt).toEqual([folderSession(root)]);
    expect(hashOf(root)).toBe(PROVED);
  });

  test('another account\'s login is refused before anything is registered, and the login it made is removed', async () => {
    const root = packageFixture();
    history(root, 'telegram:0000000000000000');
    const secrets = memorySecretStore();
    let registered = false;
    const pairedAt: string[] = [];
    await expect(pair(root, secrets, () => { registered = true; }, pairedAt))
      .rejects.toThrow('not the one whose messages Olympus already holds');
    // Made aside, and gone again.
    expect(pairedAt).toHaveLength(1);
    expect(isAside(root, pairedAt[0])).toBe(true);
    expect(sessionFolder(root)).toEqual([]);
    expect(registered).toBe(false);
    expect(secrets.values.size).toBe(0);
    expect(hashOf(root)).toBe('telegram:0000000000000000');
  });

  test('the account\'s own login, made aside, becomes the account\'s login', async () => {
    const root = packageFixture();
    history(root, PROVED);
    let registration: Record<string, unknown> | undefined;
    const pairedAt: string[] = [];
    const result = await pair(root, memorySecretStore(), (input) => { registration = input; }, pairedAt);
    expect(result.status).toBe('connected');
    expect(isAside(root, pairedAt[0])).toBe(true);
    expect(sessionFolder(root)).toEqual(['telegram.session']);
    expect(registration?.sessionPath).toBe(folderSession(root));
    expect(registration?.provedAccount).toBe(PROVED);
  });

  const sqliteLogin = (path: string, marker: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    const db = new Database(path);
    db.run('CREATE TABLE sessions (marker TEXT)');
    db.run('INSERT INTO sessions VALUES (?)', [marker]);
    db.close();
  };
  const markerOf = (path: string) => {
    const db = new Database(path, { readonly: true });
    try {
      return (db.query('SELECT marker FROM sessions').get() as { marker: string }).marker;
    } finally {
      db.close();
    }
  };

  test('a login already there, signed into another account by a refused pairing, is left exactly as it was (PR #530 review)', async () => {
    const root = packageFixture();
    history(root, 'telegram:0000000000000000');
    // A login a failed pairing left, never signed in: the helper would sign it in.
    sqliteLogin(`${folderSession(root)}.session`, 'not signed in');
    const before = readFileSync(`${folderSession(root)}.session`);
    const pairedAt: string[] = [];
    await expect(pair(root, memorySecretStore(), () => undefined, pairedAt, (base) => {
      // The helper signs the copy in as another account.
      const db = new Database(`${base}.session`);
      db.run('UPDATE sessions SET marker = ?', ['signed in as the other account']);
      db.close();
    })).rejects.toThrow('delete that history first');
    expect(isAside(root, pairedAt[0])).toBe(true);
    expect(readFileSync(`${folderSession(root)}.session`)).toEqual(before);
    expect(sessionFolder(root)).toEqual(['telegram.session']);
  });

  test('the account\'s valid login is used again from a copy, and the copy becomes the login', async () => {
    const root = packageFixture();
    history(root, PROVED);
    sqliteLogin(`${folderSession(root)}.session`, 'signed in');
    const seen: string[] = [];
    const result = await pair(root, memorySecretStore(), () => undefined, [], (base) => { seen.push(markerOf(`${base}.session`)); });
    expect(result.status).toBe('connected');
    expect(seen).toEqual(['signed in']);
    expect(markerOf(`${folderSession(root)}.session`)).toBe('signed in');
    expect(sessionFolder(root)).toEqual(['telegram.session']);
  });

  test('a login another pairing put in place meanwhile is never replaced', async () => {
    const root = packageFixture();
    history(root, PROVED);
    await expect(pair(root, memorySecretStore(), () => undefined, [], () => {
      writeFileSync(`${folderSession(root)}.session`, 'the other pairing\'s login');
    })).rejects.toThrow('Another Telegram pairing changed the login');
    expect(readFileSync(`${folderSession(root)}.session`, 'utf8')).toBe('the other pairing\'s login');
    expect(sessionFolder(root)).toEqual(['telegram.session']);
  });

  test('a pairing that fails after signing in leaves no login aside, and one a killed pairing left is removed', async () => {
    const root = packageFixture();
    history(root, PROVED);
    mkdirSync(join(folderSession(root), '..'), { recursive: true });
    // A killed pairing's login: no process has that pid.
    writeFileSync(`${folderSession(root)}.pairing-999999999-0123abcd.session`, 'left');
    await expect(pairMessagingSource({
      source: 'telegram',
      packageRoot: root,
      homeDir: join(root, 'home'),
      env: {},
      pythonExecutable: '/usr/bin/python3',
      secretStore: memorySecretStore(),
      runCommand: async (request) => {
        writeFileSync(`${request.env.OLYMPUS_TELEGRAM_SESSION_PATH}.session`, 'signed in');
        return { exitCode: 1, stdoutLines: [], stderr: '{"error":"dialogs_failed"}' };
      },
    })).rejects.toThrow('pairing failed safely');
    expect(sessionFolder(root)).toEqual([]);
  });

  test('a session given by its path is refused over a history that names its account', async () => {
    const root = packageFixture();
    history(root, PROVED);
    await expect(connectGuidedSession({
      source: 'telegram',
      sessionPath: join(root, 'elsewhere', 'telegram'),
      registryPath: join(root, 'handles.json'),
      secretStore: memorySecretStore(),
      sessionReady: true,
      historyEnv: registryEnv(root),
    })).rejects.toThrow('cannot show which account it is');
    expect(existsSync(join(root, 'handles.json'))).toBe(false);
  });

  test('a history that names no account takes the pairing\'s', async () => {
    const root = packageFixture();
    history(root);
    const pairedAt: string[] = [];
    expect((await pair(root, memorySecretStore(), () => undefined, pairedAt)).status).toBe('connected');
    expect(pairedAt).toEqual([folderSession(root)]);
    expect(hashOf(root)).toBe(PROVED);
  });
});

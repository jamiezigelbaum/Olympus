import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

  test('Telegram refuses an unlisted chat before publishing the handle', async () => {
    const root = packageFixture();
    let registered = false;
    await expect(pairMessagingSource({
      source: 'telegram',
      packageRoot: root,
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

  test('WhatsApp reports the private PNG and returns an approved capture command without starting it', async () => {
    const root = packageFixture();
    const qrPath = join(root, 'home', '.local/share/olympus/whatsapp-live/qr.png');
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
      whatsappBridgePath: missing,
      runCommand: async () => whatsappReady('/private/qr.png'),
    })).rejects.toThrow(/configured WhatsApp pairing bridge does not exist/);
  });

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

import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { withFileLease } from '../../core/file-lease.ts';
import { defaultMessagingCaptureGrantPath, saveMessagingCaptureGrant } from '../../core/messaging-capture.ts';
import { readCaptureGrantFile } from '../../core/messaging-capture-grant-file.ts';
import { pairMessagingSource, TELEGRAM_API_HASH_SECRET_KEY, TELEGRAM_API_ID_SECRET_KEY, whatsappBridgePathForPackage } from '../../core/messaging-pairing.ts';
import { telegramPythonExecutable } from '../../core/messaging-runtime.ts';
import { olympusPackageRoot } from '../../core/package-root.ts';
import { telegramSessionBasePath, whatsappStateDir } from '../../core/pairing-session-paths.ts';
import type { SecretStore } from '../../core/secret-store.ts';
import { createDashboardMessagingPairing, type MessagingSource, type PairingChat } from './dashboard-messaging.ts';
import { runDashboardPairingCommand } from './dashboard-messaging-runner.ts';

type Operation = 'start' | 'status' | 'respond' | 'cancel' | 'chats' | 'scope';

function sourceOf(value: unknown): MessagingSource {
  if (value !== 'telegram' && value !== 'whatsapp') throw new Error('Invalid messaging source.');
  return value;
}

function validScope(source: MessagingSource, scope: string): boolean {
  return source === 'telegram'
    ? /^telegram\.personal:chat:[A-Za-z0-9_-]+$/.test(scope)
    : /^whatsapp\.personal:chat:[A-Za-z0-9._:-]{1,192}@[A-Za-z0-9.-]{1,63}$/.test(scope);
}

function readQr(path: string): string {
  if (basename(path) !== 'qr.png') throw new Error('Invalid QR artifact.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Invalid QR artifact.');
    const bytes = readFileSync(fd);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid QR artifact.');
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } finally { closeSync(fd); }
}

async function listHelper(command: string, args: string[], env: Record<string, string | undefined>, input?: string): Promise<unknown> {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const stdin = child.stdin;
  const stdout = child.stdout;
  if (!stdin || !stdout) throw new Error('Chat listing pipes unavailable.');
  stdin.on('error', () => {});
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const exit = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  try {
    stdin.end(input);
    input = undefined;
    let output = '';
    for await (const chunk of stdout) {
      output += Buffer.from(chunk).toString('utf8');
      if (output.length > 16 * 1024 * 1024) throw new Error('Chat listing is too large.');
    }
    if (await exit !== 0) throw new Error('Chat listing failed.');
    return JSON.parse(output);
  } catch (error) {
    child.kill('SIGKILL');
    await exit.catch(() => 1);
    throw error;
  } finally { clearTimeout(timeout); stdin.destroy(); }
}

export function createDashboardMessagingService(options: {
  registryPath?: string;
  secretStore: SecretStore;
  withMessagingCapturePaused<T>(source: MessagingSource, operation: () => Promise<T>): Promise<T>;
  withGrantMutation<T>(operation: () => Promise<T>): Promise<T>;
  listCommand?: typeof listHelper;
}) {
  const packageRoot = olympusPackageRoot();
  const available = new Map<MessagingSource, { fingerprint: string; chats: PairingChat[] }>();
  const selecting = new Set<MessagingSource>();
  const grantFor = (source: MessagingSource) => {
    const path = defaultMessagingCaptureGrantPath(source, options.registryPath);
    const read = readCaptureGrantFile(path);
    if (read.kind !== 'valid' || read.grant.source !== source) throw new Error('No valid capture grant.');
    return { path, grant: read.grant, fingerprint: JSON.stringify(read.grant) };
  };
  const manager = createDashboardMessagingPairing({
    pair: (source, hooks) => options.withMessagingCapturePaused(source, async () => {
      const result = await pairMessagingSource({
        source, packageRoot, secretStore: options.secretStore,
        ...(options.registryPath ? { registryPath: options.registryPath } : {}),
        signal: hooks.signal, whatsappQrMode: 'artifact',
        captureScopeApproval: { source, explicitApproval: true, wholeAccount: true },
        runCommand: (request) => runDashboardPairingCommand(request, hooks),
        onWhatsAppQr: (path) => hooks.qr(readQr(path)),
      });
      if (!result.registered) throw new Error('Pairing did not finish.');
      return result;
    }),
    publish: (source, result) => options.withGrantMutation(async () => {
      saveMessagingCaptureGrant({ path: defaultMessagingCaptureGrantPath(source, options.registryPath), pairing: result });
      available.delete(source);
    }),
  });
  const list = async (source: MessagingSource) => {
    const current = grantFor(source);
    const listing = await options.withMessagingCapturePaused(source, async () => {
      if (source === 'telegram') {
        const apiId = await options.secretStore.get(TELEGRAM_API_ID_SECRET_KEY);
        const apiHash = await options.secretStore.get(TELEGRAM_API_HASH_SECRET_KEY);
        const python = telegramPythonExecutable();
        if (!python || !apiId || !apiHash || !/^\d+$/.test(apiId)) throw new Error('Telegram credentials unavailable.');
        const session = current.grant.sessionPath ?? telegramSessionBasePath({ env: process.env });
        return withFileLease(`${session}.pairing`, () => (options.listCommand ?? listHelper)(python, [join(packageRoot, 'scripts', 'telegram-pair.py')], {
          ...process.env, OLYMPUS_TELEGRAM_LIST_CHATS: '1', OLYMPUS_TELEGRAM_SESSION_PATH: session,
        }, `${JSON.stringify({ api_id: Number(apiId), api_hash: apiHash })}\n`), { acquireTimeoutMs: 1 });
      }
      return (options.listCommand ?? listHelper)(whatsappBridgePathForPackage(packageRoot, { env: process.env }), ['--list-chats'], {
        ...process.env, OLYMPUS_WHATSAPP_STATE_DIR: current.grant.sessionPath ?? whatsappStateDir({ env: process.env }),
      });
    });
    if (!listing || typeof listing !== 'object' || !Array.isArray((listing as { dialogs?: unknown }).dialogs)) throw new Error('Invalid chat listing.');
    const chats: PairingChat[] = [];
    for (const raw of (listing as { dialogs: unknown[] }).dialogs) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      if (typeof row.chat_scope !== 'string' || typeof row.title !== 'string' || typeof row.kind !== 'string') continue;
      if (validScope(source, row.chat_scope)) chats.push({ chatScope: row.chat_scope, title: row.title, kind: row.kind });
    }
    const key = source === 'telegram' ? 'OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES' : 'OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS';
    const rawScope = current.grant.producer.env[key] ?? '';
    const selected = rawScope === '*' ? [] : rawScope.split(',').filter(Boolean).map((v) => source === 'whatsapp' ? `whatsapp.personal:chat:${v}` : v);
    if (!rawScope || selected.some((scope) => !validScope(source, scope))) throw new Error('Invalid capture grant scope.');
    for (const scope of selected) if (!chats.some((chat) => chat.chatScope === scope)) chats.push({ chatScope: scope, title: scope, kind: 'chat' });
    available.set(source, { fingerprint: current.fingerprint, chats });
    return { ok: true, state: 'paired', chats, wholeAccount: rawScope === '*', chatScopes: selected, ...(source === 'whatsapp' ? { coverage: 'contacts_and_joined_groups' } : {}) };
  };
  return {
    async handle(operation: Operation, record: Record<string, unknown>) {
      const source = sourceOf(record.source);
      if (operation === 'start') {
        if (selecting.has(source)) throw new Error('Finish choosing chats first.');
        return manager.start(source);
      }
      if (operation === 'status') return manager.status(source);
      if (operation === 'cancel') return manager.cancel(source);
      if (operation === 'respond') {
        if (typeof record.field !== 'string' || typeof record.value !== 'string') throw new Error('Invalid response.');
        const value = record.value;
        delete record.value;
        return manager.respond(source, record.field, value);
      }
      const pairingState = manager.status(source).state;
      if (pairingState === 'starting' || pairingState === 'waiting') throw new Error('Finish or cancel pairing first.');
      if (operation !== 'chats' && operation !== 'scope') throw new Error('Unknown operation.');
      if (selecting.has(source)) throw new Error('Chat selection is already running.');
      selecting.add(source);
      try {
      if (operation === 'chats') return await list(source);
      const whole = record.wholeAccount === true;
      if (!Array.isArray(record.chatScopes) || !record.chatScopes.every((value) => typeof value === 'string')) throw new Error('Invalid scope.');
      const selected = [...new Set(record.chatScopes as string[])];
      if (whole ? selected.length > 0 : selected.length === 0) throw new Error('Choose all chats or at least one chat.');
      return await options.withGrantMutation(() => options.withMessagingCapturePaused(source, async () => {
        const current = grantFor(source);
        const snapshot = available.get(source);
        if (!snapshot || snapshot.fingerprint !== current.fingerprint || selected.some((scope) => !snapshot.chats.some((chat) => chat.chatScope === scope))) throw new Error('Chat list changed.');
        const value = whole ? '*' : selected.map((scope) => source === 'whatsapp' ? scope.slice('whatsapp.personal:chat:'.length) : scope).join(',');
        const env = { ...current.grant.producer.env };
        if (source === 'telegram') {
          env.OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES = value;
          env.OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES = value;
        } else env.OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS = value;
        writePrivateFileAtomicSync(current.path, `${JSON.stringify({ ...current.grant, producer: { ...current.grant.producer, env } }, null, 2)}\n`);
        available.delete(source);
        return { ok: true, state: 'paired' };
      }));
      } finally { selecting.delete(source); }
    },
    cancelAndWait: (source: MessagingSource) => manager.cancelAndWait(source),
    close: () => manager.close(),
  };
}

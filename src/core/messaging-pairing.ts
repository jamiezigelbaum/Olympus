import { ensurePrivateRootDirectorySync, ensurePrivateDirectoryTreeSync } from './atomic-file.ts';
import { telegramPythonExecutable, TELEGRAM_DEPENDENCY_HINT } from './messaging-runtime.ts';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createDefaultSecretStore, type SecretStore } from './secret-store.ts';
import { connectGuidedSession, type ConnectResult } from './connect.ts';
import { telegramSessionBasePath, whatsappStateDir } from './pairing-session-paths.ts';

export type MessagingPairingSource = 'telegram' | 'whatsapp';
export const TELEGRAM_API_ID_SECRET_KEY = 'telegram.personal.app.api_id';
export const TELEGRAM_API_HASH_SECRET_KEY = 'telegram.personal.app.api_hash';

export interface MessagingChatMetadata {
  chatScope: string;
  kind: 'dm' | 'bot' | 'group' | 'channel';
  title: string;
}

export type MessagingCaptureScopeApproval =
  | {
    source: 'telegram';
    explicitApproval: true;
    chatScopes: readonly string[];
  }
  | {
    source: 'whatsapp';
    explicitApproval: true;
    /** `true` means every chat in the linked account. */
    wholeAccount?: boolean;
    /** Exact WhatsApp chat JIDs chosen in the private pairing UI. */
    chatJids?: readonly string[];
  };

export interface MessagingProducerLaunch {
  source: MessagingPairingSource;
  executable: string;
  args: string[];
  env: Record<string, string>;
  secretEnvironment: Array<{ env: string; secretKey: string }>;
  captureStarted: false;
}

export interface MessagingPairingPendingResult {
  ok: true;
  source: MessagingPairingSource;
  status: 'scope_selection_required';
  sessionPath: string;
  accountProof: string;
  chats: MessagingChatMetadata[];
  qrPngPath?: string;
  captureStarted: false;
  registered: false;
}

export interface MessagingPairingConnectedResult extends ConnectResult {
  status: 'connected';
  sessionPath: string;
  accountProof: string;
  chats: MessagingChatMetadata[];
  qrPngPath?: string;
  captureStarted: false;
  registered: true;
  producer: MessagingProducerLaunch;
}

export type MessagingPairingResult = MessagingPairingPendingResult | MessagingPairingConnectedResult;

export interface PairingCommandRequest {
  executable: string;
  args: string[];
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void | Promise<void>;
}

export interface PairingCommandResult {
  exitCode: number;
  stdoutLines: string[];
  stderr: string;
  /** Dedicated fd3 payload; never copied into receipts, logs, or results. */
  privatePayload?: string;
}

export interface PairMessagingSourceOptions {
  source: MessagingPairingSource;
  accountRole?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  packageRoot?: string;
  pythonExecutable?: string;
  telegramHelperPath?: string;
  whatsappBridgePath?: string;
  registryPath?: string;
  secretStore?: SecretStore;
  captureScopeApproval?: MessagingCaptureScopeApproval;
  requestCaptureScope?: (input: {
    source: MessagingPairingSource;
    accountProof: string;
    chats: readonly MessagingChatMetadata[];
  }) => Promise<MessagingCaptureScopeApproval | undefined>;
  onWhatsAppQr?: (pngPath: string) => void | Promise<void>;
  whatsappQrMode?: 'terminal' | 'artifact';
  signal?: AbortSignal;
  runCommand?: (request: PairingCommandRequest) => Promise<PairingCommandResult>;
  registerSession?: MessagingSessionRegistrar;
  which?: (command: string) => string | null;
  buildWhatsAppBridge?: (input: { go: string; sourceDir: string; outputPath: string }) => Promise<boolean>;
}

export type MessagingSessionRegistrar = (
  options: Parameters<typeof connectGuidedSession>[0] & { additionalTokenSecretRefs?: readonly string[] },
) => Promise<ConnectResult>;

interface PairingReceipt {
  event: 'ready';
  status: 'ready';
  session_path?: string;
  proof: Record<string, unknown>;
  dialogs?: unknown[];
  capture_started: false;
}

/**
 * Pair one messaging provider without starting its capture producer.
 *
 * The provider helper supplies the authorization proof. Only after an explicit
 * account/chat approval does this function publish an `available` connected
 * handle and return the exact producer launch contract. Without that approval
 * it returns the metadata needed by the private CLI and leaves the registry
 * untouched, so pairing cannot silently become ingestion.
 */
export async function pairMessagingSource(options: PairMessagingSourceOptions): Promise<MessagingPairingResult> {
  const env = { ...process.env, ...(options.env ?? {}) };
  const packageRoot = resolve(options.packageRoot ?? join(import.meta.dir, '..', '..'));
  const runner = options.runCommand ?? runPairingCommand;
  const secretStore = options.secretStore ?? createDefaultSecretStore();
  const pathContext = {
    env,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  };
  const sessionPath = options.source === 'telegram'
    ? telegramSessionBasePath(pathContext)
    : whatsappStateDir(pathContext);

  const helper = await resolveHelper(options, packageRoot);
  const stdoutEvents: Record<string, unknown>[] = [];
  let qrPngPath: string | undefined;
  const commandEnv: Record<string, string | undefined> = {
    ...env,
    ...(options.source === 'telegram'
      ? { OLYMPUS_TELEGRAM_SESSION_PATH: sessionPath }
      : {
        OLYMPUS_WHATSAPP_STATE_DIR: sessionPath,
        OLYMPUS_WHATSAPP_QR_STDOUT: 'false',
        OLYMPUS_WHATSAPP_PAIR_TTY_QR: options.whatsappQrMode === 'artifact' ? 'false' : 'true',
      }),
  };
  const command = options.source === 'telegram'
    ? [helper, options.telegramHelperPath ?? join(packageRoot, 'scripts', 'telegram-pair.py')]
    : [helper, '--pair-only'];

  const result = await runner({
    executable: command[0]!,
    args: command.slice(1),
    env: commandEnv,
    ...(options.signal ? { signal: options.signal } : {}),
    onStdoutLine: async (line) => {
      const event = safeJsonObject(line);
      if (!event) return;
      stdoutEvents.push(event);
      if (options.source === 'whatsapp' && event.event === 'qr' && typeof event.qr_png_path === 'string') {
        qrPngPath = event.qr_png_path;
        await options.onWhatsAppQr?.(qrPngPath);
      }
    },
  });
  // Injected runners may return completed output without invoking the streaming
  // callback. Consume those lines too, deduplicating by object serialization.
  for (const line of result.stdoutLines) {
    const event = safeJsonObject(line);
    if (!event) continue;
    if (!stdoutEvents.some((candidate) => JSON.stringify(candidate) === JSON.stringify(event))) {
      stdoutEvents.push(event);
    }
    if (options.source === 'whatsapp' && event.event === 'qr' && typeof event.qr_png_path === 'string') {
      qrPngPath = event.qr_png_path;
    }
  }
  if (result.exitCode !== 0) {
    throw pairingFailure(options.source, safeErrorCode(result.stderr), packageRoot);
  }

  const receipt = parseReadyReceipt(stdoutEvents, options.source);
  if (options.source === 'telegram' && (
    typeof receipt.session_path !== 'string' || resolve(receipt.session_path) !== resolve(sessionPath)
  )) {
    throw new Error('Telegram pairing proved a different session path than the one Olympus requested.');
  }
  const chats = options.source === 'telegram' ? parseTelegramDialogs(receipt.dialogs) : [];
  const accountProof = proofForReceipt(options.source, receipt);
  const approval = options.captureScopeApproval ?? await options.requestCaptureScope?.({
    source: options.source,
    accountProof,
    chats,
  });
  if (!approval) {
    return {
      ok: true,
      source: options.source,
      status: 'scope_selection_required',
      sessionPath,
      accountProof,
      chats,
      ...(qrPngPath ? { qrPngPath } : {}),
      captureStarted: false,
      registered: false,
    };
  }

  const producer = producerLaunch(options.source, approval, helper, packageRoot, sessionPath, chats);
  const rollbackCredentials = options.source === 'telegram'
    ? await persistTelegramCredentials(secretStore, result.privatePayload)
    : async () => {};
  const register = options.registerSession ?? connectGuidedSession;
  let connected: ConnectResult;
  try {
    connected = await register({
      source: options.source,
      sessionPath,
      ...(options.accountRole ? { accountRole: options.accountRole } : {}),
      ...(options.registryPath ? { registryPath: options.registryPath } : {}),
      secretStore,
      sessionReady: true,
      ...(options.source === 'telegram' ? {
        additionalTokenSecretRefs: [
          `store:${TELEGRAM_API_ID_SECRET_KEY}`,
          `store:${TELEGRAM_API_HASH_SECRET_KEY}`,
        ],
      } : {}),
    });
  } catch (error) {
    await rollbackCredentials();
    throw error;
  }
  return {
    ...connected,
    status: 'connected',
    sessionPath,
    accountProof,
    chats,
    ...(qrPngPath ? { qrPngPath } : {}),
    captureStarted: false,
    registered: true,
    producer,
  };
}

async function resolveHelper(options: PairMessagingSourceOptions, packageRoot: string): Promise<string> {
  if (options.source === 'telegram') {
    const script = options.telegramHelperPath ?? join(packageRoot, 'scripts', 'telegram-pair.py');
    if (!existsSync(script)) throw new Error('The packaged Telegram pairing helper is missing. Reinstall Olympus and retry.');
    const python = telegramPythonExecutable(options);
    if (!python) {
      throw new Error(`Python 3 is required for Telegram pairing. ${TELEGRAM_DEPENDENCY_HINT}`);
    }
    return python;
  }
  if (options.whatsappBridgePath) {
    if (!existsSync(options.whatsappBridgePath)) throw new Error('The configured WhatsApp pairing bridge does not exist.');
    return options.whatsappBridgePath;
  }
  const sourceDir = join(packageRoot, 'tools', 'whatsapp-bridge');
  const output = whatsappBridgePathForPackage(packageRoot, options);
  const cacheHome = options.env?.XDG_CACHE_HOME ?? join(options.homeDir ?? options.env?.HOME ?? homedir(), '.cache');
  ensurePrivateRootDirectorySync(cacheHome);
  ensurePrivateDirectoryTreeSync(cacheHome, dirname(output));
  for (const directory of [cacheHome, join(cacheHome, 'olympus'), dirname(output)]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0) {
      throw new Error('The Olympus bridge cache must be owned by this user and not writable by other users.');
    }
  }
  if (existsSync(output)) {
    const stat = lstatSync(output);
    if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0 || (stat.mode & 0o100) === 0) {
      throw new Error('The cached WhatsApp bridge is not a trusted owner-controlled executable.');
    }
    return output;
  }
  const which = options.which ?? ((command: string) => Bun.which(command));
  const go = which('go');
  const compiler = which('cc') ?? which('clang') ?? which('gcc');
  if (!go || !compiler) {
    throw new Error('WhatsApp pairing requires Go and a C compiler. Install Go plus cc/clang/gcc, then re-run olympus connect whatsapp --pair; Olympus will build the pinned bridge automatically.');
  }
  mkdirSync(join(output, '..'), { recursive: true, mode: 0o700 });
  const built = await (options.buildWhatsAppBridge ?? buildWhatsAppBridge)({ go, sourceDir, outputPath: output });
  if (!built || !existsSync(output)) {
    throw new Error('The pinned WhatsApp bridge could not be built. Verify Go and the C compiler, then re-run olympus connect whatsapp --pair.');
  }
  chmodSync(output, 0o700);
  return output;
}

export function whatsappBridgePathForPackage(
  packageRoot: string,
  context: { homeDir?: string; env?: Record<string, string | undefined> } = {},
): string {
  const home = context.homeDir ?? context.env?.HOME ?? homedir();
  const cacheHome = context.env?.XDG_CACHE_HOME ?? join(home, '.cache');
  const fingerprint = whatsappBridgeFingerprint(join(packageRoot, 'tools', 'whatsapp-bridge'));
  return join(cacheHome, 'olympus', 'bin', `olympus-whatsapp-bridge-${fingerprint}`);
}

function whatsappBridgeFingerprint(sourceDir: string): string {
  const hash = createHash('sha256');
  for (const name of ['main.go', 'go.mod', 'go.sum']) {
    const path = join(sourceDir, name);
    if (!existsSync(path)) throw new Error(`The packaged WhatsApp bridge source is incomplete: missing ${name}.`);
    hash.update(name).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

async function buildWhatsAppBridge(input: { go: string; sourceDir: string; outputPath: string }): Promise<boolean> {
  const temporary = `${input.outputPath}.tmp.${process.pid}`;
  rmSync(temporary, { force: true });
  const child = Bun.spawn([input.go, 'build', '-trimpath', '-o', temporary, '.'], {
    cwd: input.sourceDir,
    env: { ...process.env, CGO_ENABLED: '1' },
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    child.exited,
    new Promise<'timeout'>((resolve) => { timeout = setTimeout(() => resolve('timeout'), 2 * 60 * 1000); }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (result === 'timeout') {
    child.kill('SIGTERM');
    if (!await observeBunExit(child.exited, 2_000)) {
      child.kill('SIGKILL');
      if (!await observeBunExit(child.exited, 2_000)) {
        throw new Error('WhatsApp bridge build did not exit after SIGKILL; build custody is retained.');
      }
    }
    rmSync(temporary, { force: true });
    return false;
  }
  if (result !== 0 || !existsSync(temporary)) {
    rmSync(temporary, { force: true });
    return false;
  }
  chmodSync(temporary, 0o700);
  renameSync(temporary, input.outputPath);
  return true;
}

async function observeBunExit(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const observed = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  if (timeout) clearTimeout(timeout);
  return observed;
}

function producerLaunch(
  source: MessagingPairingSource,
  approval: MessagingCaptureScopeApproval,
  helperExecutable: string,
  packageRoot: string,
  sessionPath: string,
  chats: readonly MessagingChatMetadata[],
): MessagingProducerLaunch {
  if (approval.source !== source || approval.explicitApproval !== true) {
    throw new Error('Capture scope approval must name the paired source and be explicit.');
  }
  if (source === 'telegram') {
    const scopes = uniqueNonEmpty(approval.source === 'telegram' ? approval.chatScopes : []);
    if (scopes.length === 0) throw new Error('Choose at least one Telegram chat before capture can start.');
    const listed = new Set(chats.map((chat) => chat.chatScope));
    if (scopes.some((scope) => !listed.has(scope))) {
      throw new Error('Telegram capture approval contains a chat that was not in the verified account listing.');
    }
    return {
      source,
      executable: helperExecutable,
      args: [join(packageRoot, 'scripts', 'telegram-telethon-reader.py'), '--gateway'],
      env: {
        OLYMPUS_TELEGRAM_SESSION_PATH: sessionPath,
        OLYMPUS_SOURCE_INDEX_TELEGRAM_ACCOUNT: 'telegram.personal',
        OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES: scopes.join(','),
        OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES: scopes.join(','),
        OLYMPUS_SOURCE_INDEX_TELEGRAM_PROTECTED_CHAT_SCOPES: scopes.join(','),
        OLYMPUS_TELEGRAM_PROTECTED_CHAT_SCOPES: scopes.join(','),
        OLYMPUS_SOURCE_INDEX_TELEGRAM_CHAT_CLASSIFICATIONS_JSON: '[]',
        OLYMPUS_TELEGRAM_CHAT_CLASSIFICATIONS_JSON: '[]',
      },
      secretEnvironment: [
        { env: 'OLYMPUS_TELEGRAM_API_ID', secretKey: TELEGRAM_API_ID_SECRET_KEY },
        { env: 'OLYMPUS_TELEGRAM_API_HASH', secretKey: TELEGRAM_API_HASH_SECRET_KEY },
      ],
      captureStarted: false,
    };
  }
  const chatJids = uniqueNonEmpty(approval.source === 'whatsapp' ? approval.chatJids ?? [] : []);
  const wholeAccount = approval.source === 'whatsapp' && approval.wholeAccount === true;
  if (wholeAccount === (chatJids.length > 0)) {
    throw new Error('Approve either the whole linked WhatsApp account or at least one exact chat, but not both.');
  }
  if (chatJids.some((jid) => !/^[A-Za-z0-9._:-]{1,192}@[A-Za-z0-9.-]{1,63}$/.test(jid))) {
    throw new Error('WhatsApp capture approval contains an invalid chat identifier.');
  }
  return {
    source,
    executable: helperExecutable,
    args: ['--capture-approved'],
    env: {
      OLYMPUS_WHATSAPP_STATE_DIR: sessionPath,
      OLYMPUS_WHATSAPP_QR_STDOUT: 'false',
      OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS: wholeAccount ? '*' : chatJids.join(','),
    },
    secretEnvironment: [],
    captureStarted: false,
  };
}

function parseReadyReceipt(events: readonly Record<string, unknown>[], source: MessagingPairingSource): PairingReceipt {
  const event = [...events].reverse().find((candidate) => candidate.event === 'ready');
  if (!event || event.status !== 'ready' || event.capture_started !== false || !isRecord(event.proof)) {
    throw new Error(`${sourceLabel(source)} pairing did not return a verified ready receipt.`);
  }
  const proof = event.proof;
  const proved = source === 'telegram'
    ? proof.authorized === true
      && proof.session_persisted === true
      && proof.credentials_transferred === true
      && typeof proof.account_ref === 'string'
    : proof.authenticated === true && proof.device_persisted === true;
  if (!proved) throw new Error(`${sourceLabel(source)} pairing readiness proof was incomplete.`);
  return event as unknown as PairingReceipt;
}

function parseTelegramDialogs(value: unknown): MessagingChatMetadata[] {
  if (!Array.isArray(value)) return [];
  const chats: MessagingChatMetadata[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.chat_scope !== 'string' || !item.chat_scope.startsWith('telegram.personal:chat:')) continue;
    if (!['dm', 'bot', 'group', 'channel'].includes(String(item.kind))) continue;
    chats.push({
      chatScope: item.chat_scope,
      kind: item.kind as MessagingChatMetadata['kind'],
      title: typeof item.title === 'string' ? item.title : '',
    });
  }
  return chats;
}

function proofForReceipt(source: MessagingPairingSource, receipt: PairingReceipt): string {
  return source === 'telegram'
    ? `telegram:${String(receipt.proof.account_ref)}`
    : 'whatsapp:authenticated-linked-device';
}

function pairingFailure(source: MessagingPairingSource, code: string | undefined, packageRoot: string): Error {
  if (code === 'pairing_cancelled') return new Error(`${sourceLabel(source)} pairing was cancelled before readiness was proved.`);
  if (code === 'pairing_timeout') return new Error(`${sourceLabel(source)} pairing timed out before readiness was proved. Re-run pairing to continue.`);
  if (source === 'telegram' && code === 'telethon_not_installed') {
    return new Error(`Telethon is required for Telegram pairing. ${TELEGRAM_DEPENDENCY_HINT}`);
  }
  if (source === 'telegram' && code === 'controlling_terminal_required') {
    return new Error('Telegram pairing needs the private controlling terminal so credentials and login codes never enter argv, logs, or chat.');
  }
  const helper = source === 'telegram'
    ? join(packageRoot, 'scripts', 'telegram-pair.py')
    : join(packageRoot, 'bin', 'olympus-whatsapp-bridge');
  return new Error(`${sourceLabel(source)} pairing failed safely (${code ?? 'helper_failed'}). Retry with the packaged helper: ${helper}`);
}

function safeErrorCode(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/).reverse()) {
    const parsed = safeJsonObject(line);
    if (parsed && typeof parsed.error === 'string' && /^[a-z0-9_]+$/.test(parsed.error)) return parsed.error;
    const match = /olympus-whatsapp-bridge:\s*([a-z0-9_]+)\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

function safeJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sourceLabel(source: MessagingPairingSource): string {
  return source === 'telegram' ? 'Telegram' : 'WhatsApp';
}

async function runPairingCommand(request: PairingCommandRequest): Promise<PairingCommandResult> {
  const child = spawnChild(request.executable, request.args, {
    env: request.env,
    stdio: ['inherit', 'pipe', 'pipe', 'pipe'],
  });
  const stdoutLines: string[] = [];
  let forcedError: 'pairing_timeout' | 'pairing_cancelled' | undefined;
  const timeout = setTimeout(() => {
    forcedError = 'pairing_timeout';
    child.kill('SIGTERM');
  }, 10 * 60 * 1000);
  const cancel = () => {
    forcedError = 'pairing_cancelled';
    child.kill('SIGTERM');
  };
  if (request.signal?.aborted) cancel();
  else request.signal?.addEventListener('abort', cancel, { once: true });
  if (!child.stdout || !child.stderr || !child.stdio[3]) throw new Error('Pairing helper pipes were not created.');
  const stdoutTask = readNodeLines(child.stdout, async (line) => {
    stdoutLines.push(line);
    await request.onStdoutLine?.(line);
  });
  const stderrTask = readBoundedNodeStream(child.stderr, 16 * 1024);
  const privateTask = readBoundedNodeStream(child.stdio[3] as NodeJS.ReadableStream, 4 * 1024);
  const exitTask = new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveExit(code ?? 1));
  });
  const [exitCode, stderr, privatePayload] = await Promise.all([exitTask, stderrTask, privateTask, stdoutTask])
    .then(([code, errorText, privateText]) => [code, errorText, privateText] as const);
  clearTimeout(timeout);
  request.signal?.removeEventListener('abort', cancel);
  return {
    exitCode: forcedError ? 2 : exitCode,
    stdoutLines,
    stderr: forcedError ? JSON.stringify({ error: forcedError }) : stderr,
    ...(privatePayload ? { privatePayload } : {}),
  };
}

async function readNodeLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void | Promise<void>,
): Promise<void> {
  let buffered = '';
  for await (const chunk of stream) {
    buffered += Buffer.from(chunk).toString('utf8');
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) await onLine(line);
  }
  if (buffered) await onLine(buffered);
}

async function readBoundedNodeStream(stream: NodeJS.ReadableStream, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error('Pairing helper output exceeded its private bound.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function persistTelegramCredentials(
  secretStore: SecretStore,
  payload: string | undefined,
): Promise<() => Promise<void>> {
  const parsed = payload ? safeJsonObject(payload) : undefined;
  const apiId = parsed?.api_id;
  const apiHash = parsed?.api_hash;
  if (!Number.isInteger(apiId) || Number(apiId) <= 0 || typeof apiHash !== 'string' || !apiHash) {
    throw new Error('Telegram pairing did not transfer its app credentials through the private channel.');
  }
  const priorId = await secretStore.get(TELEGRAM_API_ID_SECRET_KEY);
  const priorHash = await secretStore.get(TELEGRAM_API_HASH_SECRET_KEY);
  try {
    await secretStore.set(TELEGRAM_API_ID_SECRET_KEY, String(apiId));
    await secretStore.set(TELEGRAM_API_HASH_SECRET_KEY, apiHash);
  } catch (error) {
    if (priorId === undefined) await secretStore.delete(TELEGRAM_API_ID_SECRET_KEY);
    else await secretStore.set(TELEGRAM_API_ID_SECRET_KEY, priorId);
    if (priorHash === undefined) await secretStore.delete(TELEGRAM_API_HASH_SECRET_KEY);
    else await secretStore.set(TELEGRAM_API_HASH_SECRET_KEY, priorHash);
    throw error;
  }
  return async () => {
    if (priorId === undefined) await secretStore.delete(TELEGRAM_API_ID_SECRET_KEY);
    else await secretStore.set(TELEGRAM_API_ID_SECRET_KEY, priorId);
    if (priorHash === undefined) await secretStore.delete(TELEGRAM_API_HASH_SECRET_KEY);
    else await secretStore.set(TELEGRAM_API_HASH_SECRET_KEY, priorHash);
  };
}

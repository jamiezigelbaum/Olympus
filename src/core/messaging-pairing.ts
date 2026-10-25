import { ensurePrivateRootDirectorySync, ensurePrivateDirectoryTreeSync } from './atomic-file.ts';
import { telegramPythonExecutable, TELEGRAM_DEPENDENCY_HINT } from './messaging-runtime.ts';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultSecretStore, type SecretStore } from './secret-store.ts';
import { connectGuidedSession, type ConnectResult } from './connect.ts';
import { FileLeaseBusyError, withFileLease } from './file-lease.ts';
import { closeSqliteStore } from './sqlite-store.ts';
import { TELEGRAM_SOURCE_ID, WHATSAPP_SOURCE_ID, type LayoutAccountLayout } from './olympus-layout.ts';
import { pairingLayoutEnv, telegramSessionBasePath, telegramStagedLogins, telegramStagedSessionBase, whatsappStateDir } from './pairing-session-paths.ts';
import { recordPairingAccount, settlePairingPlacement } from './pairing-placement.ts';
import { assertTelegramHistoryAccount, telegramHistoryAccount, telegramHistoryAccountError } from './provider-account-history.ts';

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
  /** Where the account's files live; `legacy` when absent. A `folder` account's spawner sets its paths from the folder, so neither the producer env nor the grant carries them. */
  sessionLayout?: LayoutAccountLayout;
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
  /** Test seam: replaces the transport to the running worker, which decides a new account's layout while it owns the data. */
  workerFetch?: typeof fetch;
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
  const packageRoot = resolve(options.packageRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const runner = options.runCommand ?? runPairingCommand;
  const secretStore = options.secretStore ?? createDefaultSecretStore();
  const account = { sourceId: options.source === 'telegram' ? TELEGRAM_SOURCE_ID : WHATSAPP_SOURCE_ID };
  const registryEnv = pairingLayoutEnv({ env, ...(options.homeDir ? { homeDir: options.homeDir } : {}) });
  const workerTransport = options.workerFetch ? { fetchImpl: options.workerFetch } : {};
  // The account is placed before a path is picked: pairing creates its first file.
  const layout = await settlePairingPlacement(account, registryEnv, workerTransport);
  const pathContext = {
    env,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    layout,
  };
  const sessionPath = options.source === 'telegram'
    ? telegramSessionBasePath(pathContext)
    : whatsappStateDir(pathContext);
  // Private from the account folder down; the helpers only make the last folder so.
  if (layout === 'folder') {
    mkdirSync(options.source === 'telegram' ? dirname(sessionPath) : sessionPath, { recursive: true, mode: 0o700 });
  }

  // One Telegram pairing at a time on a login: two at once would sign in on
  // one login, or each put its own in its place (PR #530 review). The kernel
  // drops the lock the moment its holder dies.
  const pairing = async (): Promise<MessagingPairingResult> => {
    // A Telegram history that names its account (docs/design/source-storage.md,
    // "One account, live and imported") takes a login from that account only. The
    // pairing then signs in on a copy of the account's login made for it alone,
    // which takes the login's name only once it proves the account: another
    // account's login, or a half-made one, is never where capture reads it, and
    // the login that was there stays as it was until then.
    const historyAccount = options.source === 'telegram' ? telegramHistoryAccount(registryEnv) : undefined;
    const sessionExisted = options.source === 'telegram' && existsSync(`${sessionPath}.session`);
    // Before any login is copied: a helper that is not there stops the pairing with nothing made.
    const helper = await resolveHelper(options, packageRoot);
    const aside = historyAccount !== undefined ? prepareLoginAside(sessionPath) : undefined;
    const pairingPath = aside?.base ?? sessionPath;
    const stdoutEvents: Record<string, unknown>[] = [];
    let qrPngPath: string | undefined;
    // The helper is handed the path whichever the layout: it is the one that writes the session.
    const commandEnv: Record<string, string | undefined> = {
      ...env,
      ...(options.source === 'telegram'
        ? { OLYMPUS_TELEGRAM_SESSION_PATH: pairingPath }
        : {
          OLYMPUS_WHATSAPP_STATE_DIR: sessionPath,
          OLYMPUS_WHATSAPP_QR_STDOUT: 'false',
          OLYMPUS_WHATSAPP_PAIR_TTY_QR: options.whatsappQrMode === 'artifact' ? 'false' : 'true',
        }),
    };
    const command = options.source === 'telegram'
      ? [helper, options.telegramHelperPath ?? join(packageRoot, 'scripts', 'telegram-pair.py')]
      : [helper, '--pair-only'];

    let result: PairingCommandResult;
    let receipt: PairingReceipt;
    try {
    result = await runner({
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
      throw pairingFailure(options.source, safeErrorCode(result.stderr));
    }

    receipt = parseReadyReceipt(stdoutEvents, options.source);
    if (options.source === 'telegram' && (
      typeof receipt.session_path !== 'string' || resolve(receipt.session_path) !== resolve(pairingPath)
    )) {
      throw new Error('Telegram pairing proved a different session path than the one Olympus requested.');
    }
    if (historyAccount !== undefined) assertTelegramHistoryAccount(proofForReceipt(options.source, receipt), registryEnv);
    if (aside) keepLoginAside(aside, sessionPath);
    } catch (error) {
      // Whatever stopped it, the login made aside is no one's.
      if (aside) removeTelegramLogin(aside.base);
      throw error;
    }
    const chats = options.source === 'telegram' ? parseTelegramDialogs(receipt.dialogs) : [];
    const accountProof = proofForReceipt(options.source, receipt);
    // What a later refusal removes: a login this pairing made, never one that was there before it.
    const madeSession = sessionExisted ? undefined : sessionPath;
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

    if (options.source === 'telegram') {
      // Decided under the entry's lease by whoever owns the data, so an account it
      // was given since the read above decides. Not recorded (no worker answered)
      // costs only the import that follows an owner's confirmation.
      const recorded = historyAccount === accountProof
        ? 'same'
        : await recordPairingAccount(account, accountProof, registryEnv, workerTransport).catch(() => undefined);
      if (recorded === 'different' || recorded === 'unproven') {
        if (madeSession) removeTelegramLogin(madeSession);
        throw telegramHistoryAccountError('different');
      }
    }
    const producer = producerLaunch(options.source, approval, helper, packageRoot, sessionPath, chats, layout);
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
          provedAccount: accountProof,
          historyEnv: registryEnv,
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
      sessionLayout: layout,
      accountProof,
      chats,
      ...(qrPngPath ? { qrPngPath } : {}),
      captureStarted: false,
      registered: true,
      producer,
    };
  };
  if (options.source !== 'telegram') return pairing();
  const lock = `${sessionPath}.pairing`;
  try {
    // One try: a pairing waits on its owner at the terminal, for minutes.
    return await withFileLease(lock, pairing, { acquireTimeoutMs: 1 });
  } catch (error) {
    if (error instanceof FileLeaseBusyError && error.targetPath === lock) {
      throw new Error('Another Telegram pairing is running on this computer. Finish or cancel it, then re-run olympus connect telegram --pair in your private terminal.');
    }
    throw error;
  }
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
  layout: LayoutAccountLayout,
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
        // A folder account's spawner sets its paths from its folder (core/olympus-layout.ts, folderCaptureEnv).
        ...(layout === 'folder' ? {} : { OLYMPUS_TELEGRAM_SESSION_PATH: sessionPath }),
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
      ...(layout === 'folder' ? {} : { OLYMPUS_WHATSAPP_STATE_DIR: sessionPath }),
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

interface LoginAside {
  /** The session base this pairing signs in on. */
  base: string;
  /** The account's login as it was when the pairing began (`dev:ino`), or undefined when there was none. */
  admitted: string | undefined;
}

function prepareLoginAside(base: string): LoginAside {
  // Logins left aside by pairings that were killed are no one's.
  for (const left of telegramStagedLogins(base)) {
    if (left.pid !== process.pid && !processAlive(left.pid)) rmSync(left.path, { force: true });
  }
  const aside = telegramStagedSessionBase(base, { pid: process.pid, tag: randomBytes(4).toString('hex') });
  const admitted = loginIdentity(`${base}.session`);
  if (admitted !== undefined) copyLogin(`${base}.session`, `${aside}.session`);
  return { base: aside, admitted };
}

/**
 * A consistent copy of the account's login, whatever a reader holding it is
 * doing, so a valid login is used again without a new sign-in. Not copied (it is
 * being written, or is not a login): the pairing signs in afresh.
 */
function copyLogin(from: string, to: string): void {
  let db: Database | undefined;
  try {
    db = new Database(from, { readonly: true });
    db.run('PRAGMA busy_timeout = 5000');
    db.run('VACUUM INTO ?', [to]);
    chmodSync(to, 0o600);
  } catch {
    rmSync(to, { force: true });
  } finally {
    if (db) closeSqliteStore(db);
  }
}

/**
 * The login made aside proved the account: it becomes the account's login.
 * With none there yet, by name, and never over one that appeared meanwhile.
 * Over one there, by writing the aside's tables into it in one SQLite
 * transaction, never by replacing the file: a capture reader holding it open
 * keeps a consistent database, and its journal stays its own (PR #530 review).
 */
function keepLoginAside(aside: LoginAside, base: string): void {
  const from = `${aside.base}.session`;
  const to = `${base}.session`;
  if (existsSync(`${from}-journal`)) {
    throw new Error('Telegram pairing did not finish writing its login. Re-run olympus connect telegram --pair in your private terminal.');
  }
  if (loginIdentity(to) !== aside.admitted) throw loginChangedMeanwhile();
  if (aside.admitted === undefined) {
    try {
      linkSync(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw loginChangedMeanwhile();
      throw error;
    }
    rmSync(from, { force: true });
    return;
  }
  if (writeLoginInto(from, to)) {
    rmSync(from, { force: true });
    return;
  }
  // What is there is no login (not a database with Telegram's session table), so nothing reads it.
  rmSync(`${to}-journal`, { force: true });
  renameSync(from, to);
}

function loginChangedMeanwhile(): Error {
  return new Error('Another Telegram pairing changed the login while this one ran, so this one was not kept. Re-run olympus connect telegram --pair in your private terminal.');
}

/**
 * Write the login at `from` into the one at `to`, every table in one
 * transaction (tables `to` has that `from` lacks are emptied: they belong to
 * the login replaced). False, writing nothing, when `to` is not a Telegram
 * login: not a SQLite database, or one with no `sessions` table.
 */
function writeLoginInto(from: string, to: string): boolean {
  const db = new Database(to);
  try {
    db.run('PRAGMA busy_timeout = 5000');
    let tables: string[];
    try {
      tables = (db.query("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
        .map((row) => row.name);
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_NOTADB') return false;
      throw error;
    }
    if (!tables.includes('sessions')) return false;
    db.run('ATTACH DATABASE ? AS pairing', [from]);
    try {
      const made = db.query("SELECT name, sql FROM pairing.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string; sql: string }>;
      db.run('BEGIN IMMEDIATE');
      try {
        for (const name of tables) db.run(`DELETE FROM main."${name.replaceAll('"', '""')}"`);
        for (const table of made) {
          const name = table.name.replaceAll('"', '""');
          if (!tables.includes(table.name)) db.run(table.sql);
          db.run(`INSERT INTO main."${name}" SELECT * FROM pairing."${name}"`);
        }
        db.run('COMMIT');
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
    } finally {
      db.run('DETACH DATABASE pairing');
    }
    return true;
  } finally {
    closeSqliteStore(db);
  }
}

function loginIdentity(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removeTelegramLogin(base: string): void {
  for (const suffix of ['.session', '.session-journal']) rmSync(`${base}${suffix}`, { force: true });
}

function pairingFailure(source: MessagingPairingSource, code: string | undefined): Error {
  if (source === 'whatsapp' && code?.startsWith('unsupported_')) {
    return new Error(`WhatsApp requested a linking step this bridge does not support (${code}). No account was connected or capture started. Ask your agent to check compatibility before another scan.`);
  }
  if (source === 'whatsapp' && code === 'client_outdated') {
    return new Error('WhatsApp rejected this bridge as outdated. No account was connected. Ask your agent to update the supported bridge before another scan.');
  }
  if (source === 'whatsapp' && code === 'scan_requires_linked_devices') {
    return new Error('Scan the current QR through WhatsApp Settings > Linked devices > Link a device, then wait for linking to finish.');
  }
  if (code === 'pairing_cancelled') return new Error(`${sourceLabel(source)} pairing was cancelled before readiness was proved.`);
  if (code === 'pairing_timeout') return new Error(`${sourceLabel(source)} pairing timed out before readiness was proved. Re-run pairing to continue.`);
  if (source === 'telegram' && code === 'telethon_not_installed') {
    return new Error(`Telethon is required for Telegram pairing. ${TELEGRAM_DEPENDENCY_HINT}`);
  }
  if (source === 'telegram' && code === 'controlling_terminal_required') {
    return new Error('Telegram pairing needs the private controlling terminal so credentials and login codes never enter argv, logs, or chat.');
  }
  return new Error(`${sourceLabel(source)} pairing failed safely (${code ?? 'helper_failed'}). Re-run olympus connect ${source} --pair in your private terminal.`);
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

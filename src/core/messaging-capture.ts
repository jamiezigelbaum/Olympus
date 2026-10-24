import { telegramPythonExecutable } from './messaging-runtime.ts';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import {
  TELEGRAM_SOURCE_ID,
  WHATSAPP_SOURCE_ID,
  accountRawPath,
  accountSessionPath,
  folderCaptureDirs,
  folderCaptureEnv,
  folderCaptureEnvRemoved,
  type LayoutAccount,
} from './olympus-layout.ts';
import { placedAccount } from './source-placement.ts';
import { DEFAULT_ACCOUNT_SLOT, findRegistryAccount, readSourceRegistry } from './source-registry.ts';
import { recordAccountPlacement } from './source-storage.ts';
import { createDefaultSecretStore, type SecretStore } from './secret-store.ts';
import type { MessagingPairingConnectedResult, MessagingProducerLaunch, MessagingPairingSource } from './messaging-pairing.ts';
import { withoutUnpairedLaneHandles } from '../workers/credential-broker/unpaired-sources.ts';
import {
  defaultHandleRegistryPath,
  readConnectedHandleRegistry,
  type ConnectedCredentialHandle,
} from '../workers/credential-broker/connected-handles.ts';

export interface MessagingCaptureGrant {
  version: 1;
  source: MessagingPairingSource;
  handle: string;
  /** Where a `legacy` account's session is. A `folder` account's grant has none: its spawner computes every path. */
  sessionPath?: string;
  producer: Pick<MessagingProducerLaunch, 'source' | 'env' | 'secretEnvironment'>;
  grantedAt: string;
}

export class NativeMessagingCaptureOwnerError extends Error {
  readonly configKey: 'worker.telegramCapture.enabled' | 'worker.whatsappCapture.enabled';

  constructor(readonly source: MessagingPairingSource) {
    const configKey = source === 'telegram'
      ? 'worker.telegramCapture.enabled'
      : 'worker.whatsappCapture.enabled';
    super(
      `Native ${source} capture owns this session. Disable ${configKey}, wait for the native capture service to stop, then retry Unpair.`,
    );
    this.name = 'NativeMessagingCaptureOwnerError';
    this.configKey = configKey;
  }
}

export function defaultMessagingCaptureGrantPath(
  source: MessagingPairingSource,
  registryPath = defaultHandleRegistryPath(),
): string {
  return join(dirname(registryPath), `messaging-capture.${source}.json`);
}

export function saveMessagingCaptureGrant(input: {
  path: string;
  pairing: MessagingPairingConnectedResult;
  now?: Date;
}): MessagingCaptureGrant {
  const handle = input.pairing.handles[0];
  if (!handle) throw new Error('A connected messaging handle is required before capture can be granted.');
  const grant: MessagingCaptureGrant = {
    version: 1,
    source: input.pairing.source as MessagingPairingSource,
    handle,
    ...(input.pairing.sessionLayout === 'folder' ? {} : { sessionPath: input.pairing.sessionPath }),
    producer: {
      source: input.pairing.producer.source,
      env: input.pairing.producer.env,
      secretEnvironment: input.pairing.producer.secretEnvironment,
    },
    grantedAt: (input.now ?? new Date()).toISOString(),
  };
  writePrivateFileAtomicSync(input.path, `${JSON.stringify(grant, null, 2)}\n`);
  return grant;
}

export function revokeMessagingCaptureGrant(path: string): void {
  rmSync(path, { force: true });
}

/** What a capture grant approved to read: the whole linked account, or a number of chats. Never the chats themselves. */
export type MessagingCaptureScope =
  | { kind: 'whole_account' }
  | { kind: 'chats'; count: number };

/** What the dashboard may know of a capture grant: how much was approved, and when it was granted. */
export interface MessagingCaptureGrantFacts {
  scope?: MessagingCaptureScope;
  /** When this pairing's grant was written (ISO). A re-pairing writes a new one. */
  pairedAt?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a capture grant tells the dashboard, by the same file checks the
 * supervisor starts capture from: the approved scope as a count (neither chat
 * ids nor names) and when the pairing was granted. Reports only what it can
 * read: a damaged grant that parses but is not shaped as written (no
 * environment, a scope that is not text) yields nothing for that part rather
 * than throwing, because this runs while the dashboard is being built.
 */
export function readMessagingCaptureGrantFacts(
  source: MessagingPairingSource,
  grantPath = defaultMessagingCaptureGrantPath(source),
): MessagingCaptureGrantFacts {
  try {
    const read = readGrant(grantPath);
    if (read.kind !== 'valid' || read.grant.source !== source) return {};
    const facts: MessagingCaptureGrantFacts = {};
    const grantedAt = typeof read.grant.grantedAt === 'string' ? Date.parse(read.grant.grantedAt) : Number.NaN;
    if (Number.isFinite(grantedAt)) facts.pairedAt = new Date(grantedAt).toISOString();
    const env: unknown = read.grant.producer.env;
    const raw = isPlainRecord(env)
      ? env[source === 'telegram' ? 'OLYMPUS_TELEGRAM_ALLOWED_CHAT_SCOPES' : 'OLYMPUS_WHATSAPP_ALLOWED_CHAT_JIDS']
      : undefined;
    if (typeof raw === 'string') {
      const scopes = raw.split(',').map((item) => item.trim()).filter(Boolean);
      if (scopes.length > 0) {
        facts.scope = scopes.includes('*') ? { kind: 'whole_account' } : { kind: 'chats', count: new Set(scopes).size };
      }
    }
    return facts;
  } catch {
    return {};
  }
}

/**
 * The approved scope of a capture grant, as a count, or undefined when there
 * is no readable grant or its scope list is empty or unreadable.
 */
export function readMessagingCaptureScope(
  source: MessagingPairingSource,
  grantPath = defaultMessagingCaptureGrantPath(source),
): MessagingCaptureScope | undefined {
  return readMessagingCaptureGrantFacts(source, grantPath).scope;
}

export interface CaptureChild {
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export type SpawnCapture = (input: {
  executable: string;
  args: readonly string[];
  env: Record<string, string>;
}) => CaptureChild;

export interface MessagingCaptureStatus {
  source?: MessagingPairingSource;
  state: 'running' | 'stopped' | 'blocked';
  reason?: MessagingCaptureReason;
}

/**
 * Why capture is not running. The first five come from the supervisor's own
 * reconcile; the last three are what the worker adds when the helper process
 * would not start, keeps exiting, or is between an exit and its restart (see
 * effectiveMessagingCaptureStatus).
 */
export type MessagingCaptureReason =
  | 'grant_missing'
  | 'grant_invalid'
  | 'handle_unavailable'
  | 'session_missing'
  | 'secret_missing'
  | 'start_failed'
  | 'helper_exited'
  | 'restarting';

/** Whether the helper process is alive now, and how often it exited on its own lately. */
export interface MessagingCaptureLiveness {
  alive: boolean;
  /** Exits not caused by Olympus stopping it, in the last ten minutes; cleared once one run stays up for a minute. */
  unexpectedExits: number;
}

/** Three exits of their own in ten minutes is a helper that cannot stay up, not a restart. */
export const MESSAGING_CAPTURE_REPEATED_EXITS = 3;
const UNEXPECTED_EXIT_WINDOW_MS = 10 * 60_000;
const STABLE_RUN_MS = 60_000;

/**
 * What to report for a source: the supervisor's last reconcile, corrected by
 * facts that came after it. A reconcile that threw (Python missing, the
 * executable gone) leaves no new status, so the old one must not stand: the
 * helper did not start. A helper that keeps exiting by itself is not running,
 * whatever the last reconcile said. One that exited and has not been started
 * again yet (the next reconcile is at most ten seconds away) is reported as
 * restarting, which is not an alarm. Reporting only: nothing here starts or
 * stops anything.
 */
export function effectiveMessagingCaptureStatus(input: {
  status: MessagingCaptureStatus | undefined;
  liveness?: MessagingCaptureLiveness | undefined;
  reconcileFailed?: boolean | undefined;
}): MessagingCaptureStatus | undefined {
  const { status } = input;
  const source = status?.source;
  if (input.reconcileFailed) {
    return { ...(source ? { source } : {}), state: 'blocked', reason: 'start_failed' };
  }
  if (status?.state === 'running' && input.liveness && input.liveness.unexpectedExits >= MESSAGING_CAPTURE_REPEATED_EXITS) {
    return { ...(source ? { source } : {}), state: 'blocked', reason: 'helper_exited' };
  }
  if (status?.state === 'running' && input.liveness && !input.liveness.alive) {
    return { ...(source ? { source } : {}), state: 'stopped', reason: 'restarting' };
  }
  return status;
}

/** One worker-owned child at a time; callers reconcile on boot and grant/handle changes. */
export class MessagingCaptureSupervisor {
  private child: CaptureChild | undefined;
  private fingerprint: string | undefined;
  private generation = 0;
  private startedAt: number | undefined;
  private readonly expectedStops = new WeakSet<CaptureChild>();
  private unexpectedExitTimes: number[] = [];

  constructor(private readonly options: {
    source: MessagingPairingSource;
    registryPath?: string;
    grantPath?: string;
    secretStore?: SecretStore;
    spawn?: SpawnCapture;
    baseEnv?: Record<string, string | undefined>;
    packageRoot?: string;
    pythonExecutable?: string;
    whatsappBridgePath?: string;
    stopTimeoutMs?: number;
    now?: () => number;
  }) {}

  /** Whether the helper is alive right now, for the dashboard: a cached reconcile result can be ten seconds old. */
  liveness(): MessagingCaptureLiveness {
    const now = (this.options.now ?? Date.now)();
    if (this.child && this.startedAt !== undefined && now - this.startedAt >= STABLE_RUN_MS) this.unexpectedExitTimes = [];
    this.unexpectedExitTimes = this.unexpectedExitTimes.filter((at) => now - at < UNEXPECTED_EXIT_WINDOW_MS);
    return { alive: this.child !== undefined, unexpectedExits: this.unexpectedExitTimes.length };
  }

  private childExited(child: CaptureChild): void {
    const now = (this.options.now ?? Date.now)();
    // A run that lasted a minute forgives the exits before it, whether or not
    // anyone read liveness() while it ran.
    if (this.child === child && this.startedAt !== undefined && now - this.startedAt >= STABLE_RUN_MS) this.unexpectedExitTimes = [];
    if (!this.expectedStops.has(child)) this.unexpectedExitTimes.push(now);
    if (this.child === child) {
      this.child = undefined;
      this.fingerprint = undefined;
      this.startedAt = undefined;
    }
  }

  async reconcile(): Promise<MessagingCaptureStatus> {
    const generation = ++this.generation;
    const registryPath = this.options.registryPath ?? defaultHandleRegistryPath();
    const grantPath = this.options.grantPath ?? defaultMessagingCaptureGrantPath(this.options.source, registryPath);
    const grantRead = readGrant(grantPath);
    if (grantRead.kind !== 'valid') {
      await this.stop();
      return { state: grantRead.kind === 'missing' ? 'stopped' : 'blocked', reason: grantRead.kind === 'missing' ? 'grant_missing' : 'grant_invalid' };
    }
    const grant = grantRead.grant;
    if (grant.source !== this.options.source) {
      await this.stop();
      return { state: 'blocked', reason: 'grant_invalid' };
    }
    // The durable Unpair latch is authoritative even if a crash left the
    // grant, session and registry handle intact. Unreadable latches fail closed.
    const handle = withoutUnpairedLaneHandles(readConnectedHandleRegistry(registryPath).handles, registryPath)
      .find((candidate) => candidate.handle === grant.handle);
    if (!handleAllowsCapture(handle, grant.source)) {
      await this.stop();
      return { source: grant.source, state: 'stopped', reason: 'handle_unavailable' };
    }
    // Placed before the child creates its first file: it never touches the registry.
    const layoutEnv = definedEnv({ ...process.env, ...(this.options.baseEnv ?? {}) });
    const account = placeAccount(grant, layoutEnv);
    if (account.layout === 'legacy' && !grant.sessionPath) {
      await this.stop();
      return { source: grant.source, state: 'blocked', reason: 'grant_invalid' };
    }
    if (!sessionExists(grant, account, layoutEnv)) {
      await this.stop();
      return { source: grant.source, state: 'blocked', reason: 'session_missing' };
    }
    const childEnv: Record<string, string> = definedEnv({ ...layoutEnv, ...grant.producer.env });
    // A folder account's paths come from its folder, applied after everything else so
    // nothing in the environment or the grant can move the child out of it. A legacy
    // account keeps the grant's, which are the paths it was paired at.
    if (account.layout === 'folder') {
      for (const name of folderCaptureEnvRemoved(account)) delete childEnv[name];
      Object.assign(childEnv, folderCaptureEnv(account, layoutEnv));
      for (const dir of folderCaptureDirs(account, layoutEnv)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const secrets = this.options.secretStore ?? createDefaultSecretStore();
    for (const mapping of grant.producer.secretEnvironment) {
      const value = await secrets.get(mapping.secretKey);
      if (!value) {
        await this.stop();
        return { source: grant.source, state: 'blocked', reason: 'secret_missing' };
      }
      childEnv[mapping.env] = value;
    }
    if (generation !== this.generation) return { source: grant.source, state: 'stopped', reason: 'grant_missing' };
    const nextFingerprint = JSON.stringify(grant);
    if (this.child && this.fingerprint === nextFingerprint) return { source: grant.source, state: 'running' };
    await this.stop();
    if (generation !== this.generation - 1) return { source: grant.source, state: 'stopped', reason: 'grant_missing' };
    const spawn = this.options.spawn ?? spawnCapture;
    const launch = resolveCurrentLaunch(this.options, grant.source);
    const child = spawn({ executable: launch.executable, args: launch.args, env: childEnv });
    this.child = child;
    this.fingerprint = nextFingerprint;
    this.startedAt = (this.options.now ?? Date.now)();
    void child.exited.then(() => this.childExited(child), () => this.childExited(child));
    return { source: grant.source, state: 'running' };
  }

  async stop(): Promise<void> {
    this.generation += 1;
    const child = this.child;
    if (!child) return;
    // Olympus ending the helper is not the helper failing.
    this.expectedStops.add(child);
    child.kill('SIGTERM');
    const timeoutMs = this.options.stopTimeoutMs ?? 5_000;
    if (!await observeChildExit(child, timeoutMs)) {
      child.kill('SIGKILL');
      if (!await observeChildExit(child, timeoutMs)) {
        // Keep `child` and its fingerprint: Unpair must retain custody and may
        // retry stop, but it must not delete a session or key files while the
        // producer can still be running against them.
        throw new Error('Messaging capture did not exit after SIGKILL; session custody is retained.');
      }
    }
    if (this.child === child) {
      this.child = undefined;
      this.fingerprint = undefined;
      this.startedAt = undefined;
    }
  }
}

async function observeChildExit(child: CaptureChild, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const observed = await Promise.race([
    child.exited.then(() => true, () => true),
    new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  if (timeout) clearTimeout(timeout);
  return observed;
}

function readGrant(path: string): { kind: 'missing' } | { kind: 'invalid' } | { kind: 'valid'; grant: MessagingCaptureGrant } {
  if (!existsSync(path)) return { kind: 'missing' };
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(descriptor);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!info.isFile() || (info.mode & 0o022) !== 0 || (currentUid !== undefined && info.uid !== currentUid)) {
      return { kind: 'invalid' };
    }
    const value = JSON.parse(readFileSync(descriptor, 'utf8')) as MessagingCaptureGrant;
    if (value.version !== 1 || !['telegram', 'whatsapp'].includes(value.source) || !value.handle) return { kind: 'invalid' };
    if (value.sessionPath !== undefined && (typeof value.sessionPath !== 'string' || value.sessionPath === '')) return { kind: 'invalid' };
    if (!value.producer || value.producer.source !== value.source || !Array.isArray(value.producer.secretEnvironment)) return { kind: 'invalid' };
    return { kind: 'valid', grant: value };
  } catch {
    return { kind: 'invalid' };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function resolveCurrentLaunch(
  options: {
    packageRoot?: string;
    pythonExecutable?: string;
    whatsappBridgePath?: string;
  },
  source: MessagingPairingSource,
): { executable: string; args: string[] } {
  if (source === 'telegram') {
    const executable = telegramPythonExecutable({ ...(options.pythonExecutable ? { pythonExecutable: options.pythonExecutable } : {}) });
    if (!executable) throw new Error('Python 3 is required to start Telegram capture.');
    const packageRoot = options.packageRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    return { executable, args: [join(packageRoot, 'scripts', 'telegram-telethon-reader.py'), '--gateway'] };
  }
  return {
    executable: options.whatsappBridgePath ?? join(homedir(), '.cache', 'olympus', 'bin', 'olympus-whatsapp-bridge'),
    args: ['--capture-approved'],
  };
}

function handleAllowsCapture(handle: ConnectedCredentialHandle | undefined, source: MessagingPairingSource): boolean {
  if (!handle || handle.backendState?.status === 'reauth_required') return false;
  return source === 'telegram'
    ? handle.provider === 'telegram' && handle.allowedCapabilities.includes('telegram.messages.sync')
    : handle.provider === 'whatsapp_personal' && handle.allowedCapabilities.includes('whatsapp.personal.messages.sync');
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined;
}

const accountSourceId = (source: MessagingPairingSource): string => (source === 'telegram' ? TELEGRAM_SOURCE_ID : WHATSAPP_SOURCE_ID);

/**
 * The account the child is for, recorded in the registry first (the worker only:
 * recording is off elsewhere). A grant that names its session path is a
 * `legacy` account's, and recording it with that path keeps it at the paths it
 * was paired at; one without is a folder account's. Where nothing could record
 * it, the grant still says so: the disk would give a new account a folder, but
 * this one was paired at a path.
 */
function placeAccount(grant: MessagingCaptureGrant, env: Record<string, string>): LayoutAccount {
  const sourceId = accountSourceId(grant.source);
  const inFolder: LayoutAccount = { source_id: sourceId, slot: DEFAULT_ACCOUNT_SLOT, layout: 'folder' };
  recordAccountPlacement(
    { sourceId },
    grant.sessionPath ?? (grant.source === 'telegram' ? accountSessionPath(inFolder, env) : accountRawPath(inFolder, 'whatsapp', env)),
    env,
  );
  const placed = placedAccount(sourceId, env);
  return grant.sessionPath !== undefined && placed.layout === 'folder' && !hasRegistryEntry(sourceId, env)
    ? { ...placed, layout: 'legacy' }
    : placed;
}

function hasRegistryEntry(sourceId: string, env: Record<string, string>): boolean {
  try {
    return findRegistryAccount(readSourceRegistry(env), sourceId, DEFAULT_ACCOUNT_SLOT) !== undefined;
  } catch {
    return false;
  }
}

function sessionExists(grant: MessagingCaptureGrant, account: LayoutAccount, env: Record<string, string>): boolean {
  if (account.layout === 'folder') {
    return grant.source === 'telegram'
      ? existsSync(`${accountSessionPath(account, env)}.session`)
      : existsSync(join(accountRawPath(account, 'whatsapp', env), 'session.db'));
  }
  const sessionPath = grant.sessionPath ?? '';
  return grant.source === 'telegram'
    ? existsSync(`${sessionPath.replace(/\.session$/, '')}.session`)
    : existsSync(join(sessionPath, 'session.db'));
}

function spawnCapture(input: { executable: string; args: readonly string[]; env: Record<string, string> }): CaptureChild {
  const child = Bun.spawn([input.executable, ...input.args], {
    env: input.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return { exited: child.exited, kill: (signal) => child.kill(signal) };
}

// Experimental zkAPI consult transport (design: docs/design/frontier-consult-lane.md,
// track Z, tranche Z1).
//
// One consult = one supervised session, strictly one at a time:
//
//   throwaway Tor client (fresh data directory) on the owner's relay port
//   -> `zkapi-clientd serve` -> verify -> warm the model policy -> reserve
//   -> one stateless chat request -> wait for settlement on the same circuit
//   -> stop Tor -> prove the daemon lost its route -> stop the daemon.
//
// The Tor and daemon sequencing is ported from Vitalik Buterin's reference
// wrapper scripts in ethereum/zkapi pull request #16 (commit
// 7a46ef353fd3383e9917b0cffb8921b849e177a3, unmerged at port time):
// `zkapi-serve-tor.sh` (throwaway `tor --ClientOnly 1 --PublishServerDescriptor 0
// --DataDirectory <fresh> --SocksPort 127.0.0.1:<port> --SafeLogging 1
// --__OwningControllerProcess <pid>`, wait for "Bootstrapped 100", then serve)
// and `zkapi-tor-cli.sh` (a new network identity per single request, sequential
// requests, bounded ready/warm/settle waits). Deliberate differences:
//   - Fail closed. The wrapper restores direct (non-Tor) mode on exit; Olympus
//     never edits the daemon's configuration at all. The owner points the
//     daemon's relay at a fixed loopback port once; between consults nothing
//     listens there, so the daemon cannot reach the network.
//   - Olympus never runs `zkapi-clientd config` (it runs the guided wallet
//     flow) and never reads the daemon's config.json: that file holds the
//     bridge token that authorizes the wallet companion's withdraw routes, which
//     the wrapper reads to poll settlement. Olympus instead reads settlement
//     from the daemon's own foreground log, which it owns as the parent.
//   - Settlement is awaited on the SAME circuit, before Tor stops, so a lease
//     is never settled over the next consult's identity.
//   - The wrapper retries once after warming a cold model policy. Olympus warms
//     first and never resends a consult.
//
// The input is a plain string and a model id: there is no parameter that can
// carry an EvidencePack, history, tools or a system prompt. Errors are
// content-free. Olympus holds no management credential and calls no wallet
// route; it reads no balance, fee quote or on-chain expiry, because the daemon
// exposes none of them without that credential.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { processInstanceIdentity, withFileLeaseSync, type ProcessInstanceIdentity } from './file-lease.ts';
import {
  parseIsoDate,
  ZKAPI_EXPIRY_NOTICE_DAYS,
  ZKAPI_NOTE_TTL_DAYS,
  ZKAPI_RISK_ACKNOWLEDGEMENTS,
  ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION,
  ZKAPI_SUGGESTED_DEPOSIT_CEILING_USD,
  type ZkapiConsultSettings,
} from './zkapi-consult-settings.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BYTES = 64 * 1024;
const MAX_QUESTION_BYTES = 8 * 1024;
const POLL_MS = 100;
/** zkapi-tor-cli.sh polls the model list every 5 s while warming. */
const POLICY_POLL_MS = 5_000;
const STOP_GRACE_MS = 10_000;
/** SOCKS5/Tor client mode shipped in zkapi-clientd 0.1.5. */
const MINIMUM_DAEMON_VERSION = [0, 1, 5] as const;
const CHILD_ENV_KEYS = [
  'HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'TMPDIR',
  'XDG_CONFIG_HOME', 'ZKAPI_CLIENTD_CONFIG_DIR', 'OA_CHAT_CONFIG_DIR',
];

// ---------------------------------------------------------------------------
// Types

export type ZkapiNoticeLevel = 'none' | 'ten_days' | 'five_days' | 'two_days' | 'expired' | 'unknown';

export type ZkapiConsultErrorCode =
  | 'invalid_question'
  | 'busy'
  | 'acknowledgements_incomplete'
  | 'funding_date_missing'
  | 'funding_date_invalid'
  | 'note_expired'
  | 'daemon_api_key_missing'
  | 'daemon_not_found'
  | 'tor_not_found'
  | 'daemon_already_running'
  | 'tor_port_busy'
  | 'tor_bootstrap_failed'
  | 'daemon_start_failed'
  | 'daemon_version_unsupported'
  | 'relay_mismatch'
  | 'key_reuse_on'
  | 'key_reuse_unverified'
  | 'daemon_keyless'
  | 'daemon_identity_failed'
  | 'daemon_api_key_rejected'
  | 'policy_unavailable'
  | 'model_unavailable'
  | 'daily_cap_reached'
  | 'spend_cap_reached'
  | 'state_unavailable'
  | 'timeout'
  | 'aborted'
  | 'redirect_refused'
  | 'response_too_large'
  | 'invalid_response'
  | 'daemon_error'
  | 'transport_failed';

/**
 * `not_sent`: refused before the consult left Olympus.
 * `sent_failed`: the daemon answered with an error; spending may have happened.
 * `unknown`: the request may have reached the provider (timeout, abort, cut-off).
 */
export type ZkapiConsultOutcome = 'not_sent' | 'sent_failed' | 'unknown';

const KNOWN_DAEMON_ERROR_CODES = [
  'busy',
  'request_cancelled',
  'funding_required',
  'model_budget_unavailable',
  'model_policy_unavailable',
  'invalid_model',
  'anonymous_access_failed',
  'upstream_error',
  'invalid_upstream_response',
  'withdrawal_pending',
  'wallet_conflict',
  'invalid_request_error',
  'invalid_body',
  'testnet_password_required',
  'invalid_api_key',
  'local_connection_required',
  'browser_origin_denied',
] as const;
export type ZkapiDaemonErrorCode = (typeof KNOWN_DAEMON_ERROR_CODES)[number] | 'unrecognized';

export type ZkapiTorRoute = 'per_consult_verified' | 'per_consult_unconfirmed' | 'off';

/** What one session proved, with no request or response content. */
export interface ZkapiSessionReceipt {
  keyReuse: 'verified_off' | 'not_verified';
  inferenceAuth: 'verified' | 'not_verified';
  tor: ZkapiTorRoute;
  freshNetworkIdentity: boolean;
  settlement: 'confirmed' | 'not_confirmed' | 'not_needed';
  daemonVersion?: string;
  network?: 'mainnet' | 'sepolia';
  allowanceUsd?: number;
}

export interface ZkapiConsultError {
  code: ZkapiConsultErrorCode;
  /** A fixed sentence per code; never contains request or response content. */
  message: string;
  outcome: ZkapiConsultOutcome;
  daemonCode?: ZkapiDaemonErrorCode;
  httpStatus?: number;
  networkIdentity: 'hidden' | 'visible';
  receipt?: ZkapiSessionReceipt;
}

export type ZkapiConsultResult =
  | {
    ok: true;
    text: string;
    routeLabel: string;
    networkIdentity: 'hidden' | 'visible';
    receipt: ZkapiSessionReceipt;
    /** The daemon's verifier result for the provider key, when it sent one. */
    providerVerification?: 'verified' | 'verifier-unavailable';
    elapsedMs: number;
  }
  | { ok: false; error: ZkapiConsultError };

export type ZkapiListenerInspection =
  | { kind: 'found'; pid: number }
  | { kind: 'not_visible' }
  | { kind: 'unavailable' };

/** Finds the process listening on a loopback TCP port, as this OS user sees it. */
export type ZkapiListenerInspector = (port: number) => ZkapiListenerInspection | Promise<ZkapiListenerInspection>;

export interface ZkapiConsultTransportOptions {
  baseUrl: string;
  model: string;
  /** The daemon's local inference API key (never its management credential). */
  apiKey?: string;
  settings: ZkapiConsultSettings;
  statePath?: string;
  /** PATH and the daemon's config location are taken from here. */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  inspectListener?: ZkapiListenerInspector;
  now?: () => Date;
}

export interface ZkapiMoneyStatus {
  acknowledgements: { complete: boolean; accepted: number; required: number };
  /** Estimated from the owner-confirmed funding date; the real expiry is on-chain. */
  expiryEstimate: {
    state: 'unknown' | 'invalid' | 'active' | 'expired';
    fundingDate?: string;
    expiryDate?: string;
    daysLeft?: number;
    notice: ZkapiNoticeLevel;
  };
  depositAboveSuggestedCeiling: boolean;
}

export interface ZkapiLastSession extends ZkapiSessionReceipt {
  at: string;
  result: 'ok' | ZkapiConsultErrorCode;
}

export interface ZkapiConsultReadiness {
  daemonExecutable?: string;
  daemonVersion?: string;
  torExecutable?: string;
  tor: ZkapiConsultSettings['tor'];
  daemonPort: 'free' | 'in_use';
  torPort: 'free' | 'in_use' | 'not_used';
  apiKeyConfigured: boolean;
  money: ZkapiMoneyStatus;
  requestsToday: { count: number; cap: number };
  spendToday: { reservedUsd: number; capUsd: number };
  lastSession?: ZkapiLastSession;
  routeLabel: string;
  blockers: ZkapiConsultErrorCode[];
}

// ---------------------------------------------------------------------------
// Fixed, content-free messages

const MESSAGES: Record<ZkapiConsultErrorCode, string> = {
  invalid_question: 'The consult question is empty, too long, or contains control characters.',
  busy: 'Another zkAPI consult is in flight; consults are sent one at a time.',
  acknowledgements_incomplete: 'The zkAPI risk acknowledgements are not all accepted for the current version.',
  funding_date_missing: 'No owner-confirmed funding date is recorded, so the note expiry cannot be estimated.',
  funding_date_invalid: 'The recorded funding date is in the future.',
  note_expired: 'By the owner-confirmed funding date, the note is past its 30-day expiry.',
  daemon_api_key_missing: 'No local API key for the daemon is configured in Olympus.',
  daemon_not_found: 'The zkapi-clientd executable was not found.',
  tor_not_found: 'The tor executable was not found; install Tor or set tor to "off".',
  daemon_already_running: 'Something already serves on the zkAPI port; stop your own zkapi-clientd serve, because Olympus runs and verifies its own for each consult.',
  tor_port_busy: 'Something already listens on the zkAPI Tor port; Olympus needs it free to start a fresh Tor client.',
  tor_bootstrap_failed: 'The per-consult Tor client did not finish bootstrapping.',
  daemon_start_failed: 'zkapi-clientd serve did not become ready.',
  daemon_version_unsupported: 'This zkapi-clientd version is older than 0.1.5 or unrecognised.',
  relay_mismatch: 'The daemon is not configured for the expected route (SOCKS5 to the Tor port, or direct when Tor is off).',
  key_reuse_on: 'The daemon key-reuse window is on, so requests would be linkable; Olympus refuses to send.',
  key_reuse_unverified: 'The daemon did not confirm a fresh key for every request.',
  daemon_keyless: 'The daemon accepts inference without a local API key, so any local process can spend the balance.',
  daemon_identity_failed: 'The process on the zkAPI port is not the daemon Olympus started.',
  daemon_api_key_rejected: 'The daemon rejected the configured local API key.',
  policy_unavailable: 'The daemon could not load the model policy in time.',
  model_unavailable: 'The selected model is not in the daemon\'s live model list.',
  daily_cap_reached: 'The daily zkAPI request cap is reached.',
  spend_cap_reached: 'The daily worst-case zkAPI spend cap would be exceeded by this model\'s allowance.',
  state_unavailable: 'The persistent zkAPI request ledger could not be read or written.',
  timeout: 'The zkAPI consult timed out; it may still have been charged.',
  aborted: 'The zkAPI consult was cancelled; it may still have been charged.',
  redirect_refused: 'The daemon answered with a redirect, which is never followed.',
  response_too_large: 'The zkAPI response exceeded the size limit and was cut off.',
  invalid_response: 'The zkAPI response was not a single non-empty chat completion.',
  daemon_error: 'The zkAPI daemon returned an error.',
  transport_failed: 'The request to the zkAPI daemon failed.',
};

function failure(
  code: ZkapiConsultErrorCode,
  outcome: ZkapiConsultOutcome,
  networkIdentity: 'hidden' | 'visible',
  extra: Partial<Pick<ZkapiConsultError, 'daemonCode' | 'httpStatus' | 'receipt'>> = {},
): { ok: false; error: ZkapiConsultError } {
  return { ok: false, error: { code, message: MESSAGES[code], outcome, networkIdentity, ...extra } };
}

// ---------------------------------------------------------------------------
// Derived status (pure)

/**
 * "anonymous route" only when all three layers held for the consult: a fresh
 * key per request and enforced local authentication, both confirmed by the
 * daemon Olympus started, and the per-consult Tor instance proven to be the
 * daemon's only route. Without Tor the mode has its own, weaker name.
 */
export function zkapiRouteLabel(receipt: Pick<ZkapiSessionReceipt, 'keyReuse' | 'inferenceAuth' | 'tor'>): string {
  if (receipt.keyReuse !== 'verified_off' || receipt.inferenceAuth !== 'verified') {
    return 'not anonymous: key isolation or local authentication not confirmed';
  }
  if (receipt.tor === 'per_consult_verified') return 'anonymous route (payment, key and network identity hidden)';
  if (receipt.tor === 'off') return 'payment privacy only (network address visible)';
  return 'payment privacy only (Tor route not confirmed)';
}

export function zkapiMoneyStatus(settings: ZkapiConsultSettings, now: Date): ZkapiMoneyStatus {
  const required = ZKAPI_RISK_ACKNOWLEDGEMENTS.map((item) => item.id as string);
  const currentVersion = settings.acknowledgements.version === ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION;
  const accepted = currentVersion
    ? required.filter((id) => settings.acknowledgements.accepted.includes(id)).length
    : 0;
  return {
    acknowledgements: { complete: accepted === required.length, accepted, required: required.length },
    expiryEstimate: expiryEstimate(settings.fundingDate, now),
    depositAboveSuggestedCeiling: (settings.depositUsd ?? 0) > ZKAPI_SUGGESTED_DEPOSIT_CEILING_USD,
  };
}

function expiryEstimate(fundingDate: string | undefined, now: Date): ZkapiMoneyStatus['expiryEstimate'] {
  if (!fundingDate) return { state: 'unknown', notice: 'unknown' };
  const funded = parseIsoDate(fundingDate);
  const today = parseIsoDate(now.toISOString().slice(0, 10));
  if (!funded || !today || funded.getTime() > today.getTime()) {
    return { state: 'invalid', fundingDate, notice: 'unknown' };
  }
  const expiry = new Date(funded.getTime() + ZKAPI_NOTE_TTL_DAYS * DAY_MS);
  const daysLeft = Math.round((expiry.getTime() - today.getTime()) / DAY_MS);
  const expiryDate = expiry.toISOString().slice(0, 10);
  if (daysLeft <= 0) return { state: 'expired', fundingDate, expiryDate, daysLeft: 0, notice: 'expired' };
  const [ten, five, two] = ZKAPI_EXPIRY_NOTICE_DAYS;
  const notice: ZkapiNoticeLevel = daysLeft <= two
    ? 'two_days'
    : daysLeft <= five
      ? 'five_days'
      : daysLeft <= ten
        ? 'ten_days'
        : 'none';
  return { state: 'active', fundingDate, expiryDate, daysLeft, notice };
}

function settingsBlockers(money: ZkapiMoneyStatus): ZkapiConsultErrorCode[] {
  const blockers: ZkapiConsultErrorCode[] = [];
  if (!money.acknowledgements.complete) blockers.push('acknowledgements_incomplete');
  if (money.expiryEstimate.state === 'unknown') blockers.push('funding_date_missing');
  if (money.expiryEstimate.state === 'invalid') blockers.push('funding_date_invalid');
  if (money.expiryEstimate.state === 'expired') blockers.push('note_expired');
  return blockers;
}

// ---------------------------------------------------------------------------
// Persistent ledger: daily count, worst-case spend reservation, last receipt

interface ZkapiState {
  version: 1;
  day: string;
  count: number;
  reservedMicroUsd: number;
  lastSession?: ZkapiLastSession;
  /** The daemon Olympus started, so a crash never strands it unrecognised. */
  runningDaemon?: { pid: number; instance?: ProcessInstanceIdentity };
}

export function defaultZkapiStatePath(home: string = homedir()): string {
  return join(home, '.olympus', 'zkapi-consult-state.json');
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function readState(path: string): ZkapiState | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ZkapiState>;
  if (
    parsed.version !== 1
    || typeof parsed.day !== 'string'
    || !Number.isInteger(parsed.count) || (parsed.count as number) < 0
    || !Number.isInteger(parsed.reservedMicroUsd) || (parsed.reservedMicroUsd as number) < 0
  ) {
    throw new Error('zkAPI state record is malformed');
  }
  return parsed as ZkapiState;
}

/** Today's (UTC day) request count and worst-case reservation. Throws when unreadable. */
export function zkapiUsageToday(path: string, now: Date): { count: number; reservedMicroUsd: number } {
  const state = readState(path);
  return state && state.day === utcDay(now)
    ? { count: state.count, reservedMicroUsd: state.reservedMicroUsd }
    : { count: 0, reservedMicroUsd: 0 };
}

export function zkapiLastSession(path: string): ZkapiLastSession | undefined {
  return readState(path)?.lastSession;
}

function updateState(path: string, now: Date, mutate: (state: ZkapiState) => ZkapiState | undefined): ZkapiState {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLeaseSync(path, (lease) => {
    const day = utcDay(now);
    const current = readState(path);
    const base: ZkapiState = current && current.day === day
      ? current
      : { version: 1, day, count: 0, reservedMicroUsd: 0, ...(current?.lastSession ? { lastSession: current.lastSession } : {}), ...(current?.runningDaemon ? { runningDaemon: current.runningDaemon } : {}) };
    const next = mutate(base);
    if (!next) return base;
    lease.commit(() => writePrivateFileAtomicSync(path, `${JSON.stringify(next)}\n`));
    return next;
  }, { acquireTimeoutMs: 5_000 });
}

/**
 * Reserve one request and its model's full allowance under a cross-process
 * lease before the send. Never handed back: a send whose outcome is unknown,
 * or that failed after the daemon accepted it, may still have been charged.
 */
export function reserveZkapiRequest(
  path: string,
  limits: { requestCap: number; spendCapMicroUsd: number; allowanceMicroUsd: number },
  now: Date,
): { reserved: true } | { reserved: false; reason: 'daily_cap_reached' | 'spend_cap_reached' } {
  let refusal: 'daily_cap_reached' | 'spend_cap_reached' | undefined;
  updateState(path, now, (state) => {
    if (state.count >= limits.requestCap) {
      refusal = 'daily_cap_reached';
      return undefined;
    }
    if (state.reservedMicroUsd + limits.allowanceMicroUsd > limits.spendCapMicroUsd) {
      refusal = 'spend_cap_reached';
      return undefined;
    }
    return { ...state, count: state.count + 1, reservedMicroUsd: state.reservedMicroUsd + limits.allowanceMicroUsd };
  });
  return refusal ? { reserved: false, reason: refusal } : { reserved: true };
}

// ---------------------------------------------------------------------------
// Child processes

interface Supervised {
  readonly child: ChildProcess;
  readonly pid: number;
  exited: boolean;
  stop(): Promise<void>;
}

function supervise(executable: string, args: string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void): Supervised {
  // detached: own session, so no controlling terminal; the daemon's prompts can
  // never land on the owner's terminal, and the group can be stopped together.
  const child = spawn(executable, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const handle: Supervised = {
    child,
    pid: child.pid ?? -1,
    exited: false,
    stop: () => stopChild(handle),
  };
  child.on('exit', () => {
    handle.exited = true;
  });
  child.on('error', () => {
    handle.exited = true;
  });
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      pending += chunk;
      let index = pending.indexOf('\n');
      while (index >= 0) {
        // Each line is parsed for fixed facts and dropped; nothing is retained,
        // including the daemon's cost and balance lines.
        onLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
      if (pending.length > 64 * 1024) pending = '';
    });
  }
  return handle;
}

async function stopChild(handle: Supervised): Promise<void> {
  if (handle.exited || handle.pid <= 0) return;
  try {
    handle.child.kill('SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (!handle.exited && Date.now() < deadline) await sleep(POLL_MS);
  if (!handle.exited) {
    try {
      process.kill(-handle.pid, 'SIGKILL');
    } catch {
      try {
        handle.child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    const killDeadline = Date.now() + 2_000;
    while (!handle.exited && Date.now() < killDeadline) await sleep(POLL_MS);
  }
}

function childEnvironment(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

/** An absolute executable path, or the first match on PATH. */
export function resolveExecutable(
  name: string,
  explicit: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  const candidates = explicit ? [explicit] : (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  options: { signal?: AbortSignal | undefined; giveUp?: () => boolean; pollMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (options.signal?.aborted || options.giveUp?.() || Date.now() >= deadline) return false;
    await sleep(Math.min(options.pollMs ?? POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// ---------------------------------------------------------------------------
// The daemon's foreground log: fixed facts only

interface DaemonFacts {
  version?: string;
  listen?: string;
  transport?: string;
  keyReuse?: 'off' | 'on';
  inferenceAuth?: 'required' | 'not_required';
  keySelections: Array<{ keyRef: number; source: 'fresh' | 'reused' }>;
  settled: Map<number, boolean>;
}

function parseDaemonLine(facts: DaemonFacts, line: string): void {
  let match = /zkAPI client (\S+) listening at http:\/\/(\S+)\/v1 \(zkapi\); (.+)$/.exec(line);
  if (match) {
    facts.version = match[1]!;
    facts.listen = match[2]!;
    facts.transport = match[3]!.trim();
    return;
  }
  if (line.includes('Ephemeral key isolation: fresh OpenRouter key for every completion')) {
    facts.keyReuse = 'off';
    return;
  }
  if (/Ephemeral key reuse enabled for up to \d+ seconds/.test(line)) {
    facts.keyReuse = 'on';
    return;
  }
  if (line.includes('Use zkapi-clientd config --api-key to configure your client')) {
    facts.inferenceAuth = 'required';
    return;
  }
  if (line.includes('Localhost inference needs no API key')) {
    facts.inferenceAuth = 'not_required';
    return;
  }
  match = /request key selected request=\d+ key_ref=(\d+) source=(fresh|reused)/.exec(line);
  if (match) {
    facts.keySelections.push({ keyRef: Number(match[1]), source: match[2] as 'fresh' | 'reused' });
    return;
  }
  match = /automatic settlement result key_ref=(\d+) ready=(true|false)/.exec(line);
  if (match) facts.settled.set(Number(match[1]), match[2] === 'true');
}

function versionSupported(version: string | undefined): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return false;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < 3; index += 1) {
    if (parts[index]! !== MINIMUM_DAEMON_VERSION[index]) return parts[index]! > MINIMUM_DAEMON_VERSION[index]!;
  }
  return true;
}

// ---------------------------------------------------------------------------
// HTTP probes

interface ProbeResponse {
  status: number;
  headers: Headers;
  body: string;
}

async function probeRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResponse | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
    const body = await readBounded(response, PROBE_MAX_BYTES);
    return { status: response.status, headers: response.headers, body: body.ok ? body.text : '' };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** The daemon's `{"error":{message,type,code,param:null}}` code, or undefined. */
function daemonErrorEnvelope(body: string): string | undefined {
  try {
    const error = (JSON.parse(body) as { error?: Record<string, unknown> }).error;
    if (!error || typeof error.code !== 'string' || error.type !== error.code || typeof error.message !== 'string' || error.param !== null) {
      return undefined;
    }
    return error.code;
  } catch {
    return undefined;
  }
}

function healthFingerprint(response: ProbeResponse | undefined): boolean {
  return Boolean(response)
    && response!.status === 200
    && response!.body === '{"status":"ok"}'
    && response!.headers.get('cache-control') === 'no-store'
    && response!.headers.get('x-content-type-options') === 'nosniff';
}

/** The selected model's request allowance in micro-USD from the live list. */
function modelAllowance(body: string, model: string): { listed: boolean; allowance?: number } {
  try {
    const data = (JSON.parse(body) as { data?: Array<Record<string, unknown>> }).data;
    if (!Array.isArray(data) || data.length === 0) return { listed: false };
    const entry = data.find((item) => item.id === model);
    const allowance = entry?.oa_request_limit_micro_usd;
    return typeof allowance === 'number' && Number.isInteger(allowance) && allowance > 0
      ? { listed: true, allowance }
      : { listed: true };
  } catch {
    return { listed: false };
  }
}

/**
 * Default inspector. macOS: base-system `lsof` lists only this user's sockets.
 * Linux: `/proc` socket inodes, readable only for this user's processes.
 * Anything else is `unavailable`, which refuses a send.
 */
export function inspectLoopbackListener(port: number): ZkapiListenerInspection {
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pids = [...new Set(out.split('\n').filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1))))];
      if (pids.length === 1) return { kind: 'found', pid: pids[0]! };
      return pids.length === 0 ? { kind: 'not_visible' } : { kind: 'unavailable' };
    } catch (error) {
      return (error as { status?: number }).status === 1 ? { kind: 'not_visible' } : { kind: 'unavailable' };
    }
  }
  if (process.platform === 'linux') return inspectLinuxListener(port);
  return { kind: 'unavailable' };
}

function inspectLinuxListener(port: number): ZkapiListenerInspection {
  const inodes = new Set<string>();
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = readFileSync(table, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      // local_address is field 1 (ADDR:PORT), st is field 3 (0A = LISTEN), inode is field 9.
      if (fields.length < 10 || fields[3] !== '0A' || !fields[1]?.endsWith(`:${hexPort}`)) continue;
      if (fields[9] && fields[9] !== '0') inodes.add(fields[9]);
    }
  }
  if (inodes.size === 0) return { kind: 'not_visible' };
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return { kind: 'unavailable' };
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (match && inodes.has(match[1]!)) return { kind: 'found', pid: Number(pid) };
      } catch {
        // fd closed meanwhile
      }
    }
  }
  return { kind: 'not_visible' };
}

// ---------------------------------------------------------------------------
// Readiness (doctor): no Tor, no daemon start, no inference

/**
 * Everything checkable without starting a session: executables, the daemon's
 * self-reported version (`--version` loads no configuration), free ports, the
 * owner's settings and today's ledger. Key reuse, authentication and the Tor
 * route are verified per consult, so they are reported from the last session.
 */
export async function zkapiConsultReadiness(
  options: Omit<ZkapiConsultTransportOptions, 'fetchImpl' | 'inspectListener'> & { apiKeyPresent?: boolean },
): Promise<ZkapiConsultReadiness> {
  const now = (options.now ?? (() => new Date()))();
  const env = options.env ?? process.env;
  const settings = options.settings;
  const money = zkapiMoneyStatus(settings, now);
  const blockers = settingsBlockers(money);
  const apiKeyConfigured = Boolean(options.apiKey) || options.apiKeyPresent === true;
  if (!apiKeyConfigured) blockers.push('daemon_api_key_missing');
  const daemonExecutable = resolveExecutable('zkapi-clientd', settings.daemonExecutable, env);
  let daemonVersion: string | undefined;
  if (!daemonExecutable) {
    blockers.push('daemon_not_found');
  } else {
    try {
      const out = execFileSync(daemonExecutable, ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
        env: childEnvironment(env),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      daemonVersion = /^zkapi-clientd (\S+)/.exec(out.trim())?.[1];
    } catch {
      daemonVersion = undefined;
    }
    if (!versionSupported(daemonVersion)) blockers.push('daemon_version_unsupported');
  }
  const torExecutable = settings.tor === 'per_consult' ? resolveExecutable('tor', settings.torExecutable, env) : undefined;
  if (settings.tor === 'per_consult' && !torExecutable) blockers.push('tor_not_found');
  const daemonPort = await portAnswers(Number(new URL(options.baseUrl).port || 80)) ? 'in_use' : 'free';
  if (daemonPort === 'in_use') blockers.push('daemon_already_running');
  const torPort = settings.tor === 'per_consult'
    ? (await portAnswers(settings.torSocksPort) ? 'in_use' : 'free')
    : 'not_used';
  if (torPort === 'in_use') blockers.push('tor_port_busy');
  const statePath = options.statePath ?? defaultZkapiStatePath();
  let usage = { count: 0, reservedMicroUsd: 0 };
  let lastSession: ZkapiLastSession | undefined;
  try {
    usage = zkapiUsageToday(statePath, now);
    lastSession = zkapiLastSession(statePath);
  } catch {
    blockers.push('state_unavailable');
  }
  if (usage.count >= settings.dailyRequestCap) blockers.push('daily_cap_reached');
  return {
    ...(daemonExecutable ? { daemonExecutable } : {}),
    ...(daemonVersion ? { daemonVersion } : {}),
    ...(torExecutable ? { torExecutable } : {}),
    tor: settings.tor,
    daemonPort,
    torPort,
    apiKeyConfigured,
    money,
    requestsToday: { count: usage.count, cap: settings.dailyRequestCap },
    spendToday: { reservedUsd: usage.reservedMicroUsd / 1_000_000, capUsd: settings.dailySpendCapUsd },
    ...(lastSession ? { lastSession } : {}),
    routeLabel: lastSession
      ? zkapiRouteLabel(lastSession)
      : settings.tor === 'off'
        ? 'payment privacy only (network address visible); not yet verified by a consult'
        : 'not yet verified: each consult verifies key isolation, local authentication and its own Tor route',
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Send

// Process-wide single flight. A module binding, not shared state on a class.
let zkapiConsultInFlight = false;

/**
 * Send one approved consult question through a freshly supervised session.
 * The only inputs that reach the daemon are `question` and `options.model`,
 * inside a fixed body: one user message, no system text, no tools, no
 * history, no streaming. A failure is returned, never retried, and this module
 * knows no other transport.
 */
export async function sendZkapiConsult(
  question: string,
  options: ZkapiConsultTransportOptions,
  control: { signal?: AbortSignal } = {},
): Promise<ZkapiConsultResult> {
  const networkIdentity = options.settings.tor === 'per_consult' ? 'hidden' : 'visible';
  if (typeof question !== 'string' || !validQuestion(question)) {
    return failure('invalid_question', 'not_sent', networkIdentity);
  }
  if (zkapiConsultInFlight) return failure('busy', 'not_sent', networkIdentity);
  zkapiConsultInFlight = true;
  try {
    return await runSession(question, options, networkIdentity, control.signal);
  } finally {
    zkapiConsultInFlight = false;
  }
}

async function runSession(
  question: string,
  options: ZkapiConsultTransportOptions,
  networkIdentityIfVerified: 'hidden' | 'visible',
  signal: AbortSignal | undefined,
): Promise<ZkapiConsultResult> {
  const now = options.now ?? (() => new Date());
  const settings = options.settings;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const statePath = options.statePath ?? defaultZkapiStatePath();
  const origin = new URL(options.baseUrl).origin;
  const daemonPort = Number(new URL(options.baseUrl).port || 80);
  const perConsultTor = settings.tor === 'per_consult';
  // Until Tor is proven, nothing claims a hidden network identity.
  let networkIdentity: 'hidden' | 'visible' = 'visible';
  const refuse = (code: ZkapiConsultErrorCode): ZkapiConsultResult => failure(code, 'not_sent', networkIdentity);

  const blocked = settingsBlockers(zkapiMoneyStatus(settings, now()))[0];
  if (blocked) return refuse(blocked);
  if (!options.apiKey) return refuse('daemon_api_key_missing');
  const daemonExecutable = resolveExecutable('zkapi-clientd', settings.daemonExecutable, env);
  if (!daemonExecutable) return refuse('daemon_not_found');
  const torExecutable = perConsultTor ? resolveExecutable('tor', settings.torExecutable, env) : undefined;
  if (perConsultTor && !torExecutable) return refuse('tor_not_found');

  try {
    await stopStrandedDaemon(statePath, now());
  } catch {
    return refuse('state_unavailable');
  }
  if (await portAnswers(daemonPort)) return refuse('daemon_already_running');
  if (perConsultTor && await portAnswers(settings.torSocksPort)) return refuse('tor_port_busy');
  try {
    const usage = zkapiUsageToday(statePath, now());
    if (usage.count >= settings.dailyRequestCap) return refuse('daily_cap_reached');
  } catch {
    return refuse('state_unavailable');
  }

  const receipt: ZkapiSessionReceipt = {
    keyReuse: 'not_verified',
    inferenceAuth: 'not_verified',
    tor: perConsultTor ? 'per_consult_unconfirmed' : 'off',
    freshNetworkIdentity: false,
    settlement: 'not_needed',
  };
  const childEnv = childEnvironment(env);
  let tor: Supervised | undefined;
  let daemon: Supervised | undefined;
  let torDataDir: string | undefined;
  let result: ZkapiConsultResult | undefined;
  try {
    if (perConsultTor) {
      // zkapi-serve-tor.sh: a throwaway client with a fresh data directory, so
      // fresh guards and exits; bound to Olympus's lifetime.
      torDataDir = mkdtempSync(join(tmpdir(), 'olympus-zkapi-tor-'));
      chmodSync(torDataDir, 0o700);
      let bootstrapped = false;
      tor = supervise(torExecutable!, [
        '--ClientOnly', '1',
        '--PublishServerDescriptor', '0',
        '--DataDirectory', torDataDir,
        '--SocksPort', `127.0.0.1:${settings.torSocksPort}`,
        '--SafeLogging', '1',
        '--__OwningControllerProcess', String(process.pid),
      ], childEnv, (line) => {
        if (line.includes('Bootstrapped 100')) bootstrapped = true;
      });
      const torTimer = tor;
      if (!await waitFor(() => bootstrapped, settings.torBootstrapTimeoutMs, { signal, giveUp: () => torTimer.exited })) {
        result = refuse(signal?.aborted ? 'aborted' : 'tor_bootstrap_failed');
        return result;
      }
      receipt.freshNetworkIdentity = true;
    }

    const facts: DaemonFacts = { keySelections: [], settled: new Map() };
    daemon = supervise(daemonExecutable, ['serve'], childEnv, (line) => parseDaemonLine(facts, line));
    const started = daemon;
    const instance = processInstanceIdentity(started.pid);
    try {
      updateState(statePath, now(), (state) => ({
        ...state,
        runningDaemon: { pid: started.pid, ...(instance ? { instance } : {}) },
      }));
    } catch {
      result = refuse('state_unavailable');
      return result;
    }
    const ready = await waitFor(
      async () => Boolean(facts.listen) && healthFingerprint(await probeRequest(fetchImpl, `${origin}/healthz`, { method: 'GET' }, signal, 2_000)),
      settings.daemonReadyTimeoutMs,
      { signal, giveUp: () => started.exited, pollMs: 250 },
    );
    if (!ready) {
      result = refuse(signal?.aborted ? 'aborted' : 'daemon_start_failed');
      return result;
    }
    receipt.daemonVersion = facts.version!;
    if (!versionSupported(facts.version)) return (result = refuse('daemon_version_unsupported'));
    if (facts.listen !== new URL(options.baseUrl).host) return (result = refuse('daemon_identity_failed'));
    const expectedTransport = perConsultTor ? 'SOCKS5 proxy required' : 'direct HTTPS (network proxy off)';
    if (facts.transport !== expectedTransport) return (result = refuse('relay_mismatch'));
    if (facts.keyReuse === 'on') return (result = refuse('key_reuse_on'));
    if (facts.keyReuse !== 'off') return (result = refuse('key_reuse_unverified'));
    receipt.keyReuse = 'verified_off';
    if (facts.inferenceAuth !== 'required') return (result = refuse('daemon_keyless'));

    // The listener must be the very process Olympus started.
    let listener: ZkapiListenerInspection;
    try {
      listener = await (options.inspectListener ?? inspectLoopbackListener)(daemonPort);
    } catch {
      listener = { kind: 'unavailable' };
    }
    if (listener.kind !== 'found' || listener.pid !== started.pid) return (result = refuse('daemon_identity_failed'));

    // An unauthenticated request must be rejected before it reaches the backend.
    const unauthenticated = await probeRequest(fetchImpl, `${origin}/v1/models`, { method: 'POST' }, signal);
    if (
      !unauthenticated
      || unauthenticated.status !== 401
      || daemonErrorEnvelope(unauthenticated.body) !== 'invalid_api_key'
      || unauthenticated.headers.get('www-authenticate') !== 'Bearer'
    ) {
      return (result = refuse(unauthenticated?.status === 405 ? 'daemon_keyless' : 'daemon_identity_failed'));
    }
    const authorization = { Authorization: `Bearer ${options.apiKey}` };
    const status = await probeRequest(fetchImpl, `${origin}/admin/status`, { method: 'GET', headers: authorization }, signal);
    if (!status || status.status === 401) return (result = refuse('daemon_api_key_rejected'));
    const network = adminStatusNetwork(status);
    if (!network) return (result = refuse('daemon_identity_failed'));
    receipt.inferenceAuth = 'verified';
    receipt.network = network;

    // zkapi-tor-cli.sh `warm_policy`: poll the model list until the reviewed
    // policy has loaded; it also proves the selected model is live.
    let allowance: number | undefined;
    let listed = false;
    await waitFor(async () => {
      const models = await probeRequest(fetchImpl, `${origin}/v1/models`, { method: 'GET', headers: authorization }, signal, 60_000);
      if (models?.status !== 200) return false;
      const parsed = modelAllowance(models.body, options.model);
      listed = parsed.listed;
      allowance = parsed.allowance;
      return parsed.listed;
    }, settings.policyWarmTimeoutMs, { signal, giveUp: () => started.exited, pollMs: POLICY_POLL_MS });
    if (!listed) return (result = refuse(signal?.aborted ? 'aborted' : 'policy_unavailable'));
    if (allowance === undefined) return (result = refuse('model_unavailable'));
    receipt.allowanceUsd = allowance / 1_000_000;

    let reservation: ReturnType<typeof reserveZkapiRequest>;
    try {
      reservation = reserveZkapiRequest(statePath, {
        requestCap: settings.dailyRequestCap,
        spendCapMicroUsd: Math.round(settings.dailySpendCapUsd * 1_000_000),
        allowanceMicroUsd: allowance,
      }, now());
    } catch {
      return (result = refuse('state_unavailable'));
    }
    if (!reservation.reserved) return (result = refuse(reservation.reason));
    if (signal?.aborted) return (result = refuse('aborted'));

    networkIdentity = networkIdentityIfVerified;
    const keysBefore = facts.keySelections.length;
    const sent = await sendCompletion(question, options, origin, networkIdentity, signal);

    // Wait for settlement on this same circuit before anything stops.
    const selected = facts.keySelections.slice(keysBefore);
    if (selected.some((selection) => selection.source !== 'fresh')) receipt.keyReuse = 'not_verified';
    const keyRef = selected.at(-1)?.keyRef;
    if (keyRef !== undefined) {
      receipt.settlement = await waitFor(
        () => facts.settled.get(keyRef) === true,
        settings.settleTimeoutMs,
        { giveUp: () => started.exited },
      ) ? 'confirmed' : 'not_confirmed';
    }

    if (perConsultTor) {
      await tor!.stop();
      // With Tor gone the daemon must have no route at all: a model-list fetch
      // that still succeeds means its traffic did not go through this Tor.
      const after = await probeRequest(fetchImpl, `${origin}/v1/models`, { method: 'GET', headers: authorization }, undefined, 60_000);
      receipt.tor = after?.status === 200 ? 'per_consult_unconfirmed' : 'per_consult_verified';
    }
    if (receipt.tor !== 'per_consult_verified') networkIdentity = 'visible';

    if (!sent.ok) {
      result = { ok: false, error: { ...sent.error, networkIdentity, receipt } };
      return result;
    }
    result = {
      ok: true,
      text: sent.text,
      routeLabel: zkapiRouteLabel(receipt),
      networkIdentity,
      receipt: { ...receipt },
      ...(sent.providerVerification ? { providerVerification: sent.providerVerification } : {}),
      elapsedMs: sent.elapsedMs,
    };
    return result;
  } finally {
    await daemon?.stop();
    await tor?.stop();
    if (torDataDir) rmSync(torDataDir, { recursive: true, force: true });
    const final = result;
    try {
      updateState(statePath, now(), (state) => {
        const { runningDaemon: _stopped, ...rest } = state;
        return daemon
          ? { ...rest, lastSession: { ...receipt, at: now().toISOString(), result: final?.ok ? 'ok' : final?.error.code ?? 'transport_failed' } }
          : rest;
      });
    } catch {
      // The ledger stays as last written; the next session refuses if it is unreadable.
    }
  }
}

function adminStatusNetwork(response: ProbeResponse): 'mainnet' | 'sepolia' | undefined {
  if (response.status !== 200) return undefined;
  try {
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    if (parsed.backend !== 'zkapi') return undefined;
    return parsed.network === 'mainnet' || parsed.network === 'sepolia' ? parsed.network : undefined;
  } catch {
    return undefined;
  }
}

/** A daemon Olympus started and then lost (crash) is stopped before a new session. */
async function stopStrandedDaemon(statePath: string, now: Date): Promise<void> {
  const recorded = readState(statePath)?.runningDaemon;
  if (!recorded) return;
  const current = processInstanceIdentity(recorded.pid);
  const same = recorded.instance && current
    && current.mechanism === recorded.instance.mechanism
    && current.startTime === recorded.instance.startTime;
  if (same) {
    try {
      process.kill(recorded.pid, 'SIGTERM');
    } catch {
      // gone
    }
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline) {
      try {
        process.kill(recorded.pid, 0);
      } catch {
        break;
      }
      await sleep(POLL_MS);
    }
  }
  updateState(statePath, now, (state) => {
    const { runningDaemon: _gone, ...rest } = state;
    return rest;
  });
}

type CompletionResult =
  | { ok: true; text: string; providerVerification?: 'verified' | 'verifier-unavailable'; elapsedMs: number }
  | { ok: false; error: ZkapiConsultError };

async function sendCompletion(
  question: string,
  options: ZkapiConsultTransportOptions,
  origin: string,
  networkIdentity: 'hidden' | 'visible',
  signal: AbortSignal | undefined,
): Promise<CompletionResult> {
  const settings = options.settings;
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, settings.timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${origin}/v1/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: 'user', content: question }],
          stream: false,
        }),
      });
    } catch (error) {
      if (timedOut) return failure('timeout', 'unknown', networkIdentity);
      if (controller.signal.aborted) return failure('aborted', 'unknown', networkIdentity);
      if (isRedirectError(error)) return failure('redirect_refused', 'unknown', networkIdentity);
      return failure('transport_failed', 'unknown', networkIdentity);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return failure('redirect_refused', 'unknown', networkIdentity, { httpStatus: response.status });
    }
    const body = await readBounded(response, settings.maxResponseBytes).catch(() => undefined);
    if (!body) {
      if (timedOut) return failure('timeout', 'unknown', networkIdentity);
      if (controller.signal.aborted) return failure('aborted', 'unknown', networkIdentity);
      return failure('transport_failed', 'unknown', networkIdentity);
    }
    if (!body.ok) return failure('response_too_large', 'unknown', networkIdentity, { httpStatus: response.status });
    if (response.status < 200 || response.status >= 300) {
      return failure('daemon_error', 'sent_failed', networkIdentity, {
        httpStatus: response.status,
        daemonCode: knownDaemonCode(daemonErrorEnvelope(body.text)),
      });
    }
    // A 200 is not trusted on its own: the body must be one well-formed,
    // non-empty completion.
    const text = completionText(body.text);
    if (text === undefined) return failure('invalid_response', 'unknown', networkIdentity, { httpStatus: response.status });
    const verification = response.headers.get('x-oa-verification-status');
    return {
      ok: true,
      text,
      ...(verification === 'verified' || verification === 'verifier-unavailable'
        ? { providerVerification: verification }
        : {}),
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function validQuestion(question: string): boolean {
  if (!question.trim()) return false;
  if (new TextEncoder().encode(question).byteLength > MAX_QUESTION_BYTES) return false;
  // Plain text only: tabs and newlines are the only control characters allowed.
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(question);
}

function knownDaemonCode(code: string | undefined): ZkapiDaemonErrorCode {
  return (KNOWN_DAEMON_ERROR_CODES as readonly string[]).includes(code ?? '')
    ? code as ZkapiDaemonErrorCode
    : 'unrecognized';
}

function completionText(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { object?: unknown; choices?: unknown };
    if (!Array.isArray(parsed.choices) || parsed.choices.length !== 1) return undefined;
    const choice = parsed.choices[0] as { message?: { role?: unknown; content?: unknown } };
    const content = choice.message?.content;
    if (choice.message?.role !== undefined && choice.message.role !== 'assistant') return undefined;
    return typeof content === 'string' && content.trim() ? content : undefined;
  } catch {
    return undefined;
  }
}

function isRedirectError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (record.code === 'UnexpectedRedirect') return true;
    if (typeof record.message === 'string' && /redirect/i.test(record.message)) return true;
    current = record.cause;
  }
  return false;
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const reader = response.body?.getReader();
  if (!reader) return { ok: true, text: '' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

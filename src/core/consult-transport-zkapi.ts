// Experimental zkAPI consult transport (design: docs/design/frontier-consult-lane.md,
// track Z, tranche Z1).
//
// One consult = one supervised session, strictly one at a time across every
// Olympus process (a cross-process file lease is held for the whole session):
//
//   throwaway Tor client (fresh data directory) on the owner's relay port
//   -> `zkapi-clientd serve`, network-confined where the platform allows it
//   -> verify -> warm the model policy -> reserve the worst case and set the
//   unresolved-session fence -> one stateless chat request -> wait for the
//   daemon's correlated key and settlement -> stop Tor -> secondary probe ->
//   stop every owned process group.
//
// The Tor and daemon sequencing is ported from Vitalik Buterin's reference
// wrapper scripts in ethereum/zkapi pull request #16 (commit
// 7a46ef353fd3383e9917b0cffb8921b849e177a3, unmerged at port time):
// `zkapi-serve-tor.sh` (throwaway `tor --ClientOnly 1 --PublishServerDescriptor 0
// --DataDirectory <fresh> --SocksPort 127.0.0.1:<port> --SafeLogging 1
// --__OwningControllerProcess <pid>`, wait for "Bootstrapped 100", then serve)
// and `zkapi-tor-cli.sh` (a new Tor client per single request, sequential
// requests, bounded ready/warm/settle waits). Deliberate differences:
//   - Fail closed. The wrapper restores direct (non-Tor) mode on exit; Olympus
//     never edits the daemon's configuration. Between consults nothing listens
//     on the relay port, so the daemon cannot reach the network.
//   - Olympus never runs `zkapi-clientd config` (it runs the guided wallet
//     flow) and never reads the daemon's config.json: that file holds the
//     bridge token that authorizes the wallet companion's withdraw routes, which
//     the wrapper reads to poll settlement. Olympus reads the daemon's own
//     foreground log instead, as the parent of the process that writes it.
//   - The wrapper retries once after warming a cold model policy. Olympus warms
//     first and never resends a consult.
//
// What this does NOT prove, and so what no label claims: zkapi-clientd takes
// its relay and companion mode only from config.json, which Olympus does not
// read, and the managed companion reaches the network through a proxy on a
// random loopback port. So the route of the daemon and its companion is
// established only by network confinement that filters loopback ports, which
// no platform implementation here provides (see ZkapiConfinement). The strong
// label "anonymous route" exists in the type and is never produced by the
// shipped confinement; every receipt names what was and was not verified.
//
// The input is a plain string and a model id: there is no parameter that can
// carry an EvidencePack, history, tools or a system prompt. Errors are
// content-free. Olympus holds no management credential and calls no wallet
// route; it reads no balance, fee quote or on-chain expiry.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import {
  FileLeaseBusyError,
  processInstanceIdentity,
  withFileLease,
  withFileLeaseSync,
  type ProcessInstanceIdentity,
} from './file-lease.ts';
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
/**
 * PR #16 raised the daemon's /v1/models timeout to three minutes for Tor. A
 * released 0.1.5/0.1.6 daemon still gives up after one minute, so a cold
 * policy over Tor can fail and is retried until the warm deadline.
 */
const MODELS_PROBE_TIMEOUT_MS = 190_000;
const PROBE_MAX_BYTES = 64 * 1024;
const MAX_QUESTION_BYTES = 8 * 1024;
const POLL_MS = 100;
/** zkapi-tor-cli.sh polls the model list every 5 s while warming. */
const POLICY_POLL_MS = 5_000;
const STOP_GRACE_MS = 10_000;
const KILL_GRACE_MS = 3_000;
/**
 * Reviewed daemon versions. 0.1.5 shipped SOCKS5/Tor client mode; 0.1.6 is the
 * newest release reviewed. Their highest per-request allowance is $6
 * (`internal/zkapi/model_budget.go`), and the daemon recomputes a request's
 * allowance from live policy after queueing, so every request reserves $6.
 * A newer version is refused until its allowance table is reviewed.
 */
export const ZKAPI_SUPPORTED_DAEMON_VERSIONS = ['0.1.5', '0.1.6'] as const;
export const ZKAPI_MAX_ALLOWANCE_MICRO_USD = 6_000_000;
/** The fixed, content-free question a recovery-only session sends. */
const RECOVERY_QUESTION = 'Reply with the single word OK.';
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
  | 'unresolved_session'
  | 'no_unresolved_session'
  | 'stranded_processes'
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
  | 'session_process_exited'
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
  | 'transport_failed'
  | 'internal_error';

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

/**
 * How the daemon's network was confined for one session.
 * `none`: not confined. `non_loopback_blocked`: the OS denied every connection
 * except loopback, and DNS, to the daemon and its descendants, self-tested in
 * that session. `loopback_filtered`: additionally only the session's own Tor
 * and daemon ports were reachable on loopback. Only the last can support the
 * strong label; no shipped platform implementation provides it.
 */
export type ZkapiConfinementLevel = 'none' | 'non_loopback_blocked' | 'loopback_filtered';

export interface ZkapiConfinement {
  readonly level: ZkapiConfinementLevel;
  /** A fixed sentence naming what this confinement does not cover. */
  readonly limit: string;
  /** The argv that runs `argv` under the confinement. */
  wrap(argv: readonly string[], ports: { tor: number; daemon: number }): string[];
  /** Proves, in this session, that the confinement denies what it claims. */
  selfTest(workDir: string, env: NodeJS.ProcessEnv): Promise<boolean>;
}

/** What one session proved, with no request or response content. */
export interface ZkapiSessionReceipt {
  recovery: boolean;
  keyReuse: 'verified_off' | 'not_verified';
  inferenceAuth: 'verified' | 'not_verified';
  tor: 'per_consult' | 'off';
  freshTorClient: boolean;
  confinement: ZkapiConfinementLevel;
  confinementSelfTest: 'passed' | 'failed' | 'not_run';
  /** Secondary signal only: what the daemon's model list did once Tor stopped. */
  postStopProbe: 'route_lost' | 'still_reachable' | 'inconclusive' | 'not_run';
  settlement: 'confirmed' | 'not_confirmed' | 'no_lease';
  fence: 'clear' | 'held';
  daemonVersion?: string;
  network?: 'mainnet' | 'sepolia';
  listedAllowanceUsd?: number;
  reservedUsd?: number;
}

export type ZkapiNetworkIdentity = 'hidden' | 'not_verified' | 'visible';

export interface ZkapiConsultError {
  code: ZkapiConsultErrorCode;
  /** A fixed sentence per code; never contains request or response content. */
  message: string;
  outcome: ZkapiConsultOutcome;
  daemonCode?: ZkapiDaemonErrorCode;
  httpStatus?: number;
  networkIdentity: ZkapiNetworkIdentity;
  receipt?: ZkapiSessionReceipt;
}

export type ZkapiConsultResult =
  | {
    ok: true;
    text: string;
    routeLabel: string;
    networkIdentity: ZkapiNetworkIdentity;
    receipt: ZkapiSessionReceipt;
    /** The daemon's verifier result for the provider key, when it sent one. */
    providerVerification?: 'verified' | 'verifier-unavailable';
    elapsedMs: number;
  }
  | { ok: false; error: ZkapiConsultError };

export type ZkapiListenerInspection =
  | { kind: 'found'; pid: number; pgid?: number }
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
  /** Defaults to this platform's implementation (`defaultZkapiConfinement`). */
  confinement?: ZkapiConfinement;
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
  confinement: { level: ZkapiConfinementLevel; limit: string };
  daemonPort: 'free' | 'in_use';
  torPort: 'free' | 'in_use' | 'not_used';
  apiKeyConfigured: boolean;
  money: ZkapiMoneyStatus;
  requestsToday: { count: number; cap: number };
  spendToday: { reservedUsd: number; capUsd: number };
  unresolvedSession: boolean;
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
  note_expired: 'By the owner-confirmed funding date, the note is past its estimated 30-day expiry.',
  daemon_api_key_missing: 'No local API key for the daemon is configured in Olympus.',
  daemon_not_found: 'The zkapi-clientd executable was not found.',
  tor_not_found: 'The tor executable was not found; install Tor or set tor to "off".',
  unresolved_session: 'An earlier zkAPI session may have left a lease unsettled; run a recovery-only session before another consult.',
  no_unresolved_session: 'There is no unresolved zkAPI session to recover.',
  stranded_processes: 'Processes from an earlier zkAPI session could not be confirmed stopped.',
  daemon_already_running: 'Something already serves on the zkAPI port; stop your own zkapi-clientd serve, because Olympus runs and verifies its own for each consult.',
  tor_port_busy: 'Something already listens on the zkAPI Tor port; Olympus needs it free to start a fresh Tor client.',
  tor_bootstrap_failed: 'The per-consult Tor client did not finish bootstrapping.',
  daemon_start_failed: 'zkapi-clientd serve did not become ready.',
  daemon_version_unsupported: 'This zkapi-clientd version is not a reviewed version (0.1.5 or 0.1.6).',
  relay_mismatch: 'The daemon is not configured for the expected route (SOCKS5 when Tor is on, direct when Tor is off).',
  key_reuse_on: 'The daemon key-reuse window is on, so requests would be linkable; Olympus refuses to send.',
  key_reuse_unverified: 'The daemon did not confirm a fresh key for every request.',
  daemon_keyless: 'The daemon accepts inference without a local API key, so any local process can spend the balance.',
  daemon_identity_failed: 'A port of this session is not held by the process group Olympus started.',
  daemon_api_key_rejected: 'The daemon rejected the configured local API key.',
  session_process_exited: 'The Tor client or the daemon of this session stopped unexpectedly.',
  policy_unavailable: 'The daemon could not load the model policy in time.',
  model_unavailable: 'The selected model is not in the daemon\'s live model list.',
  daily_cap_reached: 'The daily zkAPI request cap is reached.',
  spend_cap_reached: 'The daily worst-case zkAPI spend cap would be exceeded by another request.',
  state_unavailable: 'The persistent zkAPI session ledger could not be read or written.',
  timeout: 'The zkAPI consult timed out; it may still have been charged.',
  aborted: 'The zkAPI consult was cancelled; it may still have been charged.',
  redirect_refused: 'The daemon answered with a redirect, which is never followed.',
  response_too_large: 'The zkAPI response exceeded the size limit and was cut off.',
  invalid_response: 'The zkAPI response was not a single non-empty chat completion.',
  daemon_error: 'The zkAPI daemon returned an error.',
  transport_failed: 'The request to the zkAPI daemon failed.',
  internal_error: 'The zkAPI session failed inside Olympus.',
};

function failure(
  code: ZkapiConsultErrorCode,
  outcome: ZkapiConsultOutcome,
  networkIdentity: ZkapiNetworkIdentity,
  extra: Partial<Pick<ZkapiConsultError, 'daemonCode' | 'httpStatus' | 'receipt'>> = {},
): { ok: false; error: ZkapiConsultError } {
  return { ok: false, error: { code, message: MESSAGES[code], outcome, networkIdentity, ...extra } };
}

// ---------------------------------------------------------------------------
// Labels and derived status (pure)

/**
 * "anonymous route" only when every layer held and was proven in the session:
 * key isolation and local authentication confirmed by the daemon Olympus
 * started, a fresh Tor client, confinement that filtered loopback ports and
 * passed its self-test, no Tor bypass observed, and the lease settled. Anything
 * less is named for what it is.
 */
export function zkapiRouteLabel(receipt: ZkapiSessionReceipt): string {
  if (receipt.keyReuse !== 'verified_off' || receipt.inferenceAuth !== 'verified') {
    return 'not anonymous: key isolation or local authentication not confirmed';
  }
  if (receipt.tor === 'off') return 'payment privacy only (network address visible)';
  if (receipt.postStopProbe === 'still_reachable') {
    return 'payment privacy only: the daemon still reached the network after Tor stopped (Tor bypass observed)';
  }
  const confined = receipt.confinementSelfTest === 'passed' ? receipt.confinement : 'none';
  if (confined === 'loopback_filtered' && receipt.freshTorClient && receipt.settlement !== 'not_confirmed') {
    return 'anonymous route (payment, key and network identity hidden)';
  }
  const unsettled = receipt.settlement === 'not_confirmed' ? '; lease settlement not confirmed' : '';
  if (confined === 'non_loopback_blocked') {
    return `payment privacy; inference through a fresh Tor client; the daemon could not reach the internet or DNS directly, but loopback was not port-filtered, so the daemon and companion route is not verified${unsettled}`;
  }
  return `payment privacy; inference through a fresh Tor client; no network confinement, so the daemon and companion route is not verified${unsettled}`;
}

function networkIdentityFor(receipt: ZkapiSessionReceipt): ZkapiNetworkIdentity {
  if (receipt.tor === 'off' || receipt.postStopProbe === 'still_reachable') return 'visible';
  return zkapiRouteLabel(receipt).startsWith('anonymous route') ? 'hidden' : 'not_verified';
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

function versionSupported(version: string | undefined): boolean {
  const normalized = version?.replace(/^v/, '');
  return (ZKAPI_SUPPORTED_DAEMON_VERSIONS as readonly string[]).includes(normalized ?? '');
}

// ---------------------------------------------------------------------------
// Confinement

/**
 * macOS: `sandbox-exec` (deprecated but shipped). The profile denies every
 * network operation, then allows loopback only. The kernel enforces it for the
 * daemon, its wallet companion and any other descendant, whatever language
 * they are written in, and it also denies the system DNS resolver socket.
 * It cannot filter loopback by port for this daemon: the managed companion
 * reaches the network through a proxy the daemon opens on a random loopback
 * port, which a profile written before start cannot name.
 */
const DARWIN_SANDBOX_PROFILE = [
  '(version 1)',
  '(allow default)',
  '(deny network*)',
  '(allow network-bind (local ip "localhost:*"))',
  '(allow network-inbound (local ip "localhost:*"))',
  '(allow network-outbound (remote ip "localhost:*"))',
].join('');

// Plain CommonJS so it runs under Bun or Node. 192.0.2.1 is TEST-NET-1: it
// routes nowhere, so an unconfined probe sends nothing anyone can receive.
const SELF_TEST_SCRIPT = `
const net = require('node:net');
const dgram = require('node:dgram');
const tcp = () => new Promise((resolve) => {
  const started = Date.now();
  const s = net.createConnection({ host: '192.0.2.1', port: 9 });
  s.setTimeout(3000, () => { s.destroy(); resolve('timeout'); });
  s.once('connect', () => { s.destroy(); resolve('connected'); });
  s.once('error', () => resolve(Date.now() - started < 1000 ? 'refused_fast' : 'error_slow'));
});
const udp = () => new Promise((resolve) => {
  const s = dgram.createSocket('udp4');
  s.send(Buffer.from([0]), 53, '192.0.2.1', (e) => { s.close(); resolve(e ? 'denied' : 'sent'); });
});
const resolver = () => new Promise((resolve) => {
  const s = net.createConnection({ path: '/private/var/run/mDNSResponder' });
  s.once('connect', () => { s.destroy(); resolve('connected'); });
  s.once('error', () => resolve('denied'));
});
(async () => {
  const result = { tcp: await tcp(), udp: await udp(), dns: await resolver() };
  process.stdout.write(JSON.stringify(result));
})();
`;

export function defaultZkapiConfinement(): ZkapiConfinement {
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    return {
      level: 'non_loopback_blocked',
      limit: 'macOS sandbox: direct internet and DNS are blocked; loopback cannot be port-filtered for this daemon',
      wrap: (argv) => ['/usr/bin/sandbox-exec', '-p', DARWIN_SANDBOX_PROFILE, ...argv],
      selfTest: async (workDir, env) => {
        const script = join(workDir, 'confinement-self-test.cjs');
        writeFileSync(script, SELF_TEST_SCRIPT, { mode: 0o600 });
        try {
          const out = execFileSync('/usr/bin/sandbox-exec', ['-p', DARWIN_SANDBOX_PROFILE, process.execPath, script], {
            encoding: 'utf8',
            timeout: 10_000,
            env,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          const result = JSON.parse(out) as Record<string, string>;
          return result.tcp === 'refused_fast' && result.udp === 'denied' && result.dns === 'denied';
        } catch {
          return false;
        }
      },
    };
  }
  return {
    level: 'none',
    limit: 'no network confinement is implemented on this platform',
    wrap: (argv) => [...argv],
    selfTest: async () => false,
  };
}

// ---------------------------------------------------------------------------
// Persistent ledger: daily count, worst-case reservation, fence, receipts

interface OwnedGroup {
  role: 'tor' | 'daemon';
  pgid: number;
  leader?: ProcessInstanceIdentity;
}

interface ZkapiState {
  version: 1;
  day: string;
  count: number;
  reservedMicroUsd: number;
  lastSession?: ZkapiLastSession;
  /** Set before dispatch; cleared only on correlated key and settlement evidence. */
  fence?: { at: string };
  /** Written before any process starts; cleared only once every group is confirmed gone. */
  running?: {
    sessionId: string;
    supervisor: { pid: number; instance?: ProcessInstanceIdentity };
    groups: OwnedGroup[];
  };
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

export function zkapiUnresolvedSession(path: string): boolean {
  return Boolean(readState(path)?.fence);
}

function updateState(path: string, now: Date, mutate: (state: ZkapiState) => ZkapiState | undefined): ZkapiState {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLeaseSync(path, (lease) => {
    const day = utcDay(now);
    const current = readState(path);
    const base: ZkapiState = current && current.day === day
      ? current
      : {
        version: 1,
        day,
        count: 0,
        reservedMicroUsd: 0,
        ...(current?.lastSession ? { lastSession: current.lastSession } : {}),
        ...(current?.fence ? { fence: current.fence } : {}),
        ...(current?.running ? { running: current.running } : {}),
      };
    const next = mutate(base);
    if (!next) return base;
    lease.commit(() => writePrivateFileAtomicSync(path, `${JSON.stringify(next)}\n`));
    return next;
  }, { acquireTimeoutMs: 5_000 });
}

/**
 * Reserve one request at the worst-case allowance under a cross-process lease
 * before the send, and set the unresolved-session fence in the same write.
 * Never handed back: a send whose outcome is unknown, or that failed after the
 * daemon accepted it, may still have been charged.
 */
export function reserveZkapiRequest(
  path: string,
  limits: { requestCap: number; spendCapMicroUsd: number },
  now: Date,
): { reserved: true } | { reserved: false; reason: 'daily_cap_reached' | 'spend_cap_reached' } {
  let refusal: 'daily_cap_reached' | 'spend_cap_reached' | undefined;
  updateState(path, now, (state) => {
    if (state.count >= limits.requestCap) {
      refusal = 'daily_cap_reached';
      return undefined;
    }
    if (state.reservedMicroUsd + ZKAPI_MAX_ALLOWANCE_MICRO_USD > limits.spendCapMicroUsd) {
      refusal = 'spend_cap_reached';
      return undefined;
    }
    return {
      ...state,
      count: state.count + 1,
      reservedMicroUsd: state.reservedMicroUsd + ZKAPI_MAX_ALLOWANCE_MICRO_USD,
      fence: { at: now.toISOString() },
    };
  });
  return refusal ? { reserved: false, reason: refusal } : { reserved: true };
}

// ---------------------------------------------------------------------------
// Process groups

/**
 * Each owned process runs under this watchdog, which leads its own process
 * group. It forwards termination to the group and, if Olympus dies without
 * cleaning up, stops the whole group itself (Tor additionally exits through
 * `__OwningControllerProcess`).
 */
const WATCHDOG_SCRIPT = `
const { spawn } = require('node:child_process');
const [, , marker, ...argv] = process.argv;
const parent = process.ppid;
const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
let stopping = false;
const stopGroup = () => {
  if (stopping) return;
  stopping = true;
  try { process.kill(-process.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }, 5000).unref();
};
process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch {} });
process.on('SIGINT', () => { try { child.kill('SIGTERM'); } catch {} });
child.on('exit', (code) => process.exit(code === null ? 1 : code));
child.on('error', () => process.exit(127));
setInterval(() => { if (process.ppid !== parent) stopGroup(); }, 500);
void marker;
`;

interface Supervised {
  readonly role: 'tor' | 'daemon';
  readonly child: ChildProcess;
  readonly pgid: number;
  leaderExited: boolean;
}

function supervise(
  role: 'tor' | 'daemon',
  watchdog: string,
  marker: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
): Supervised {
  // detached: the watchdog leads a new group with no controlling terminal, so
  // the daemon's prompts can never land on the owner's terminal.
  const child = spawn(process.execPath, [watchdog, marker, ...argv], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const handle: Supervised = { role, child, pgid: child.pid ?? -1, leaderExited: false };
  child.on('exit', () => {
    handle.leaderExited = true;
  });
  child.on('error', () => {
    handle.leaderExited = true;
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

function groupAlive(pgid: number): boolean {
  if (pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

/** Stop a whole process group, whether or not its leader still runs. True once it is gone. */
async function stopGroup(pgid: number): Promise<boolean> {
  if (!groupAlive(pgid)) return true;
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    // raced with exit
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (groupAlive(pgid) && Date.now() < deadline) await sleep(POLL_MS);
  if (!groupAlive(pgid)) return true;
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // raced with exit
  }
  const killDeadline = Date.now() + KILL_GRACE_MS;
  while (groupAlive(pgid) && Date.now() < killDeadline) await sleep(POLL_MS);
  return !groupAlive(pgid);
}

/** 'ours' | 'gone' | 'unknown' for a recorded group. */
function recordedGroupState(group: OwnedGroup): 'ours' | 'gone' | 'unknown' {
  if (!groupAlive(group.pgid)) return 'gone';
  let leaderAlive = true;
  try {
    process.kill(group.pgid, 0);
  } catch (error) {
    leaderAlive = (error as { code?: string }).code === 'EPERM';
  }
  // A process-group id cannot be reused while any member of that group lives,
  // so a live group whose leader is gone is still the recorded group.
  if (!leaderAlive) return 'ours';
  const current = processInstanceIdentity(group.pgid);
  if (!group.leader || !current) return 'unknown';
  if (group.leader.bootId && current.bootId && group.leader.bootId !== current.bootId) return 'gone';
  if (group.leader.platform !== current.platform || group.leader.mechanism !== current.mechanism) return 'unknown';
  return group.leader.startTime === current.startTime ? 'ours' : 'gone';
}

function supervisorAlive(supervisor: { pid: number; instance?: ProcessInstanceIdentity }): boolean {
  if (supervisor.pid === process.pid) return false;
  try {
    process.kill(supervisor.pid, 0);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EPERM') return false;
  }
  const current = processInstanceIdentity(supervisor.pid);
  if (!supervisor.instance || !current) return true;
  if (supervisor.instance.bootId && current.bootId && supervisor.instance.bootId !== current.bootId) return false;
  return supervisor.instance.mechanism !== current.mechanism || supervisor.instance.startTime === current.startTime;
}

/**
 * Stop what an earlier session left running. Called only while holding the
 * session lease, and only once the recorded supervisor is proven dead. The
 * record is kept unless every group is confirmed gone.
 */
async function recoverStrandedGroups(statePath: string, now: Date): Promise<'clear' | 'busy' | 'stranded'> {
  const running = readState(statePath)?.running;
  if (!running) return 'clear';
  if (supervisorAlive(running.supervisor)) return 'busy';
  let allGone = true;
  for (const group of running.groups) {
    const state = recordedGroupState(group);
    if (state === 'unknown') {
      allGone = false;
      continue;
    }
    if (state === 'ours' && !await stopGroup(group.pgid)) allGone = false;
  }
  if (!allGone) return 'stranded';
  updateState(statePath, now, (state) => {
    const { running: _gone, ...rest } = state;
    return rest;
  });
  return 'clear';
}

function processGroupOf(pid: number): number | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const pgrp = Number(fields[2]);
      return Number.isInteger(pgrp) ? pgrp : undefined;
    }
    const out = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^\d+$/.test(out) ? Number(out) : undefined;
  } catch {
    return undefined;
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

/** Gives up (false) on abort, deadline or `giveUp`, each checked before the condition. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  options: { signal?: AbortSignal | undefined; giveUp?: () => boolean; pollMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (options.signal?.aborted || options.giveUp?.()) return false;
    if (await condition()) return !options.giveUp?.();
    if (Date.now() >= deadline) return false;
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

interface RequestFacts {
  route: string;
  keys: Array<{ keyRef: number; source: 'fresh' | 'reused' }>;
  finished?: { status: number };
}

interface DaemonFacts {
  version?: string;
  listen?: string;
  transport?: string;
  keyReuse?: 'off' | 'on';
  inferenceAuth?: 'required' | 'not_required';
  requests: Map<number, RequestFacts>;
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
  // internal/server/logging.go: a request's lines share its request number,
  // and the final line is written after every key line of that request.
  match = /request started method=\S+ route=(\S+) request=(\d+)/.exec(line);
  if (match) {
    facts.requests.set(Number(match[2]), { route: match[1]!, keys: [] });
    return;
  }
  match = /request key selected request=(\d+) key_ref=(\d+) source=(fresh|reused)/.exec(line);
  if (match) {
    facts.requests.get(Number(match[1]))?.keys.push({ keyRef: Number(match[2]), source: match[3] as 'fresh' | 'reused' });
    return;
  }
  match = /request \S+ method=\S+ route=\S+ status=(\d+) duration=\S+ request=(\d+)/.exec(line);
  if (match) {
    const request = facts.requests.get(Number(match[2]));
    if (request) request.finished = { status: Number(match[1]) };
    return;
  }
  match = /automatic settlement result key_ref=(\d+) ready=(true|false)/.exec(line);
  if (match) facts.settled.set(Number(match[1]), match[2] === 'true');
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

/** Whether the selected model is in the live list, and its listed allowance. */
function modelListing(body: string, model: string): { listed: boolean; allowance?: number } {
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
  let pid: number | undefined;
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pids = [...new Set(out.split('\n').filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1))))];
      if (pids.length !== 1) return pids.length === 0 ? { kind: 'not_visible' } : { kind: 'unavailable' };
      pid = pids[0]!;
    } catch (error) {
      return (error as { status?: number }).status === 1 ? { kind: 'not_visible' } : { kind: 'unavailable' };
    }
  } else if (process.platform === 'linux') {
    const found = linuxListenerPid(port);
    if (typeof found !== 'number') return found;
    pid = found;
  } else {
    return { kind: 'unavailable' };
  }
  const pgid = processGroupOf(pid);
  return { kind: 'found', pid, ...(pgid !== undefined ? { pgid } : {}) };
}

function linuxListenerPid(port: number): number | ZkapiListenerInspection {
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
        if (match && inodes.has(match[1]!)) return Number(pid);
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
 * platform's confinement, the owner's settings, today's ledger and the
 * unresolved-session fence. Route facts come from the last session's receipt.
 */
export async function zkapiConsultReadiness(
  options: Omit<ZkapiConsultTransportOptions, 'fetchImpl' | 'inspectListener'> & { apiKeyPresent?: boolean },
): Promise<ZkapiConsultReadiness> {
  const now = (options.now ?? (() => new Date()))();
  const env = options.env ?? process.env;
  const settings = options.settings;
  const confinement = options.confinement ?? defaultZkapiConfinement();
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
  let unresolvedSession = false;
  try {
    usage = zkapiUsageToday(statePath, now);
    lastSession = zkapiLastSession(statePath);
    unresolvedSession = zkapiUnresolvedSession(statePath);
  } catch {
    blockers.push('state_unavailable');
  }
  if (unresolvedSession) blockers.push('unresolved_session');
  if (usage.count >= settings.dailyRequestCap) blockers.push('daily_cap_reached');
  if (usage.reservedMicroUsd + ZKAPI_MAX_ALLOWANCE_MICRO_USD > Math.round(settings.dailySpendCapUsd * 1_000_000)) {
    blockers.push('spend_cap_reached');
  }
  return {
    ...(daemonExecutable ? { daemonExecutable } : {}),
    ...(daemonVersion ? { daemonVersion } : {}),
    ...(torExecutable ? { torExecutable } : {}),
    tor: settings.tor,
    confinement: { level: confinement.level, limit: confinement.limit },
    daemonPort,
    torPort,
    apiKeyConfigured,
    money,
    requestsToday: { count: usage.count, cap: settings.dailyRequestCap },
    spendToday: { reservedUsd: usage.reservedMicroUsd / 1_000_000, capUsd: settings.dailySpendCapUsd },
    unresolvedSession,
    ...(lastSession ? { lastSession } : {}),
    routeLabel: lastSession
      ? zkapiRouteLabel(lastSession)
      : settings.tor === 'off'
        ? 'payment privacy only (network address visible); not yet verified by a consult'
        : `not yet verified by a consult; on this platform: ${confinement.limit}`,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Send and recover

// In-process fast path; the cross-process session lease is the real guard.
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
  const initialIdentity: ZkapiNetworkIdentity = options.settings.tor === 'off' ? 'visible' : 'not_verified';
  if (typeof question !== 'string' || !validQuestion(question)) {
    return failure('invalid_question', 'not_sent', initialIdentity);
  }
  return exclusiveSession(question, false, options, control.signal);
}

/**
 * A recovery-only session for an unresolved fence: the same supervised,
 * confined, Tor-routed session, sending one fixed content-free question
 * instead of a consult. The daemon recovers a pending lease only while serving
 * a request (`internal/zkapi/client.go` waitForLease), so recovery costs one
 * request. The fence clears only on correlated key and settlement evidence.
 */
export async function recoverZkapiSession(
  options: ZkapiConsultTransportOptions,
  control: { signal?: AbortSignal } = {},
): Promise<ZkapiConsultResult> {
  return exclusiveSession(RECOVERY_QUESTION, true, options, control.signal);
}

async function exclusiveSession(
  question: string,
  recovery: boolean,
  options: ZkapiConsultTransportOptions,
  signal: AbortSignal | undefined,
): Promise<ZkapiConsultResult> {
  const initialIdentity: ZkapiNetworkIdentity = options.settings.tor === 'off' ? 'visible' : 'not_verified';
  if (zkapiConsultInFlight) return failure('busy', 'not_sent', initialIdentity);
  zkapiConsultInFlight = true;
  const statePath = options.statePath ?? defaultZkapiStatePath();
  const sent = { dispatched: false };
  try {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    return await withFileLease(`${statePath}.session`, () => runSession(question, recovery, options, statePath, signal, sent), {
      acquireTimeoutMs: 50,
    });
  } catch (error) {
    if (error instanceof FileLeaseBusyError) return failure('busy', 'not_sent', initialIdentity);
    return failure('internal_error', sent.dispatched ? 'unknown' : 'not_sent', initialIdentity);
  } finally {
    zkapiConsultInFlight = false;
  }
}

async function runSession(
  question: string,
  recovery: boolean,
  options: ZkapiConsultTransportOptions,
  statePath: string,
  signal: AbortSignal | undefined,
  sent: { dispatched: boolean },
): Promise<ZkapiConsultResult> {
  const now = options.now ?? (() => new Date());
  const settings = options.settings;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const inspect = options.inspectListener ?? inspectLoopbackListener;
  const confinement = options.confinement ?? defaultZkapiConfinement();
  const origin = new URL(options.baseUrl).origin;
  const daemonPort = Number(new URL(options.baseUrl).port || 80);
  const perConsultTor = settings.tor === 'per_consult';
  const receipt: ZkapiSessionReceipt = {
    recovery,
    keyReuse: 'not_verified',
    inferenceAuth: 'not_verified',
    tor: perConsultTor ? 'per_consult' : 'off',
    freshTorClient: false,
    confinement: perConsultTor ? confinement.level : 'none',
    confinementSelfTest: 'not_run',
    postStopProbe: 'not_run',
    settlement: 'no_lease',
    fence: 'clear',
  };
  const identity = (): ZkapiNetworkIdentity => (perConsultTor ? networkIdentityFor(receipt) : 'visible');
  const fail = (code: ZkapiConsultErrorCode, extra: Partial<Pick<ZkapiConsultError, 'daemonCode' | 'httpStatus'>> = {}): ZkapiConsultResult => (
    failure(code, sent.dispatched ? (extra.httpStatus ? 'sent_failed' : 'unknown') : 'not_sent', identity(), { ...extra, receipt: { ...receipt } })
  );

  // --- Preconditions: nothing starts until all hold.
  const blocked = settingsBlockers(zkapiMoneyStatus(settings, now()))[0];
  if (blocked) return fail(blocked);
  if (!options.apiKey) return fail('daemon_api_key_missing');
  const daemonExecutable = resolveExecutable('zkapi-clientd', settings.daemonExecutable, env);
  if (!daemonExecutable) return fail('daemon_not_found');
  const torExecutable = perConsultTor ? resolveExecutable('tor', settings.torExecutable, env) : undefined;
  if (perConsultTor && !torExecutable) return fail('tor_not_found');
  try {
    const stranded = await recoverStrandedGroups(statePath, now());
    if (stranded === 'busy') return fail('busy');
    if (stranded === 'stranded') return fail('stranded_processes');
    const fenced = zkapiUnresolvedSession(statePath);
    if (fenced && !recovery) return fail('unresolved_session');
    if (!fenced && recovery) return fail('no_unresolved_session');
    const usage = zkapiUsageToday(statePath, now());
    if (usage.count >= settings.dailyRequestCap) return fail('daily_cap_reached');
    if (usage.reservedMicroUsd + ZKAPI_MAX_ALLOWANCE_MICRO_USD > Math.round(settings.dailySpendCapUsd * 1_000_000)) {
      return fail('spend_cap_reached');
    }
  } catch {
    return fail('state_unavailable');
  }
  if (await portAnswers(daemonPort)) return fail('daemon_already_running');
  if (perConsultTor && await portAnswers(settings.torSocksPort)) return fail('tor_port_busy');

  // --- The session. Every exit path below goes through the finally.
  const sessionId = randomUUID();
  const workDir = mkdtempSync(join(tmpdir(), 'olympus-zkapi-'));
  chmodSync(workDir, 0o700);
  const watchdog = join(workDir, 'watchdog.cjs');
  const childEnv = childEnvironment(env);
  const groups: Supervised[] = [];
  let tor: Supervised | undefined;
  let daemon: Supervised | undefined;
  let result: ZkapiConsultResult | undefined;
  try {
    writeFileSync(watchdog, WATCHDOG_SCRIPT, { mode: 0o600 });
    const supervisorInstance = processInstanceIdentity(process.pid);
    updateState(statePath, now(), (state) => ({
      ...state,
      running: { sessionId, supervisor: { pid: process.pid, ...(supervisorInstance ? { instance: supervisorInstance } : {}) }, groups: [] },
    }));
    const recordGroup = (handle: Supervised): void => {
      groups.push(handle);
      const leader = processInstanceIdentity(handle.pgid);
      updateState(statePath, now(), (state) => ({
        ...state,
        ...(state.running
          ? { running: { ...state.running, groups: [...state.running.groups, { role: handle.role, pgid: handle.pgid, ...(leader ? { leader } : {}) }] } }
          : {}),
      }));
    };
    const anyExited = (): boolean => groups.some((group) => group.leaderExited);

    if (perConsultTor) {
      if (await confinement.selfTest(workDir, childEnv)) receipt.confinementSelfTest = 'passed';
      else receipt.confinementSelfTest = confinement.level === 'none' ? 'not_run' : 'failed';
      // zkapi-serve-tor.sh: a throwaway client with a fresh data directory, so
      // fresh guards and circuits; bound to Olympus's lifetime.
      const torDataDir = join(workDir, 'tor');
      mkdirSync(torDataDir, { mode: 0o700 });
      let bootstrapped = false;
      tor = supervise('tor', watchdog, sessionId, [
        torExecutable!,
        '--ClientOnly', '1',
        '--PublishServerDescriptor', '0',
        '--DataDirectory', torDataDir,
        '--SocksPort', `127.0.0.1:${settings.torSocksPort}`,
        '--SafeLogging', '1',
        '--__OwningControllerProcess', String(process.pid),
      ], childEnv, (line) => {
        if (line.includes('Bootstrapped 100')) bootstrapped = true;
      });
      recordGroup(tor);
      if (!await waitFor(() => bootstrapped, settings.torBootstrapTimeoutMs, { signal, giveUp: anyExited })) {
        return (result = fail(signal?.aborted ? 'aborted' : 'tor_bootstrap_failed'));
      }
      receipt.freshTorClient = true;
    }

    const facts: DaemonFacts = { requests: new Map(), settled: new Map() };
    const daemonArgv = [daemonExecutable, 'serve'];
    daemon = supervise(
      'daemon',
      watchdog,
      sessionId,
      perConsultTor ? confinement.wrap(daemonArgv, { tor: settings.torSocksPort, daemon: daemonPort }) : daemonArgv,
      childEnv,
      (line) => parseDaemonLine(facts, line),
    );
    recordGroup(daemon);

    // Every port of this session must be held by the process group Olympus
    // started; checked again immediately before anything carries the key.
    const owned = async (includeTor = true): Promise<boolean> => {
      if (includeTor ? anyExited() : daemon!.leaderExited) return false;
      const listener = await inspect(daemonPort);
      if (listener.kind !== 'found' || listener.pgid !== daemon!.pgid) return false;
      if (tor && includeTor) {
        const socks = await inspect(settings.torSocksPort);
        if (socks.kind !== 'found' || socks.pgid !== tor.pgid) return false;
      }
      return includeTor ? !anyExited() : !daemon!.leaderExited;
    };
    const guard = async (): Promise<ZkapiConsultErrorCode | undefined> => {
      if (signal?.aborted) return 'aborted';
      if (anyExited()) return 'session_process_exited';
      return await owned() ? undefined : (anyExited() ? 'session_process_exited' : 'daemon_identity_failed');
    };

    const ready = await waitFor(
      async () => Boolean(facts.listen) && healthFingerprint(await probeRequest(fetchImpl, `${origin}/healthz`, { method: 'GET' }, signal, 2_000)),
      settings.daemonReadyTimeoutMs,
      { signal, giveUp: anyExited, pollMs: 250 },
    );
    if (!ready) return (result = fail(signal?.aborted ? 'aborted' : anyExited() ? 'session_process_exited' : 'daemon_start_failed'));
    receipt.daemonVersion = facts.version!;
    if (!versionSupported(facts.version)) return (result = fail('daemon_version_unsupported'));
    if (facts.listen !== new URL(options.baseUrl).host) return (result = fail('daemon_identity_failed'));
    const expectedTransport = perConsultTor ? 'SOCKS5 proxy required' : 'direct HTTPS (network proxy off)';
    if (facts.transport !== expectedTransport) return (result = fail('relay_mismatch'));
    if (facts.keyReuse === 'on') return (result = fail('key_reuse_on'));
    if (facts.keyReuse !== 'off') return (result = fail('key_reuse_unverified'));
    receipt.keyReuse = 'verified_off';
    if (facts.inferenceAuth !== 'required') return (result = fail('daemon_keyless'));

    let problem = await guard();
    if (problem) return (result = fail(problem));
    // An unauthenticated request must be rejected before it reaches the backend.
    const unauthenticated = await probeRequest(fetchImpl, `${origin}/v1/models`, { method: 'POST' }, signal);
    if (
      !unauthenticated
      || unauthenticated.status !== 401
      || daemonErrorEnvelope(unauthenticated.body) !== 'invalid_api_key'
      || unauthenticated.headers.get('www-authenticate') !== 'Bearer'
    ) {
      return (result = fail(unauthenticated?.status === 405 ? 'daemon_keyless' : 'daemon_identity_failed'));
    }
    const authorization = { Authorization: `Bearer ${options.apiKey}` };
    problem = await guard();
    if (problem) return (result = fail(problem));
    const status = await probeRequest(fetchImpl, `${origin}/admin/status`, { method: 'GET', headers: authorization }, signal);
    if (!status || status.status === 401) return (result = fail('daemon_api_key_rejected'));
    const network = adminStatusNetwork(status);
    if (!network) return (result = fail('daemon_identity_failed'));
    receipt.inferenceAuth = 'verified';
    receipt.network = network;

    // zkapi-tor-cli.sh `warm_policy`: poll the model list until the reviewed
    // policy has loaded. Listing is catalog membership, not a test request.
    let listing: { listed: boolean; allowance?: number } = { listed: false };
    let guardProblem: ZkapiConsultErrorCode | undefined;
    await waitFor(async () => {
      guardProblem = await guard();
      if (guardProblem) return true;
      const models = await probeRequest(fetchImpl, `${origin}/v1/models`, { method: 'GET', headers: authorization }, signal, MODELS_PROBE_TIMEOUT_MS);
      if (models?.status !== 200) return false;
      listing = modelListing(models.body, options.model);
      return listing.listed;
    }, settings.policyWarmTimeoutMs, { signal, giveUp: anyExited, pollMs: POLICY_POLL_MS });
    if (guardProblem) return (result = fail(guardProblem));
    if (!listing.listed) return (result = fail(signal?.aborted ? 'aborted' : anyExited() ? 'session_process_exited' : 'policy_unavailable'));
    if (listing.allowance === undefined) return (result = fail('model_unavailable'));
    receipt.listedAllowanceUsd = listing.allowance / 1_000_000;

    let reservation: ReturnType<typeof reserveZkapiRequest>;
    try {
      reservation = reserveZkapiRequest(statePath, {
        requestCap: settings.dailyRequestCap,
        spendCapMicroUsd: Math.round(settings.dailySpendCapUsd * 1_000_000),
      }, now());
    } catch {
      return (result = fail('state_unavailable'));
    }
    if (!reservation.reserved) return (result = fail(reservation.reason));
    receipt.reservedUsd = ZKAPI_MAX_ALLOWANCE_MICRO_USD / 1_000_000;
    receipt.fence = 'held';
    problem = await guard();
    if (problem) return (result = fail(problem));

    const requestsBefore = new Set(facts.requests.keys());
    sent.dispatched = true;
    const completion = await sendCompletion(question, options, origin, signal);

    // Correlate this request's own log lines, then wait for its key to settle
    // on this same Tor client. Runs to completion even if the caller cancelled.
    const correlated = await waitFor(() => {
      const ours = [...facts.requests.entries()].filter(([id, request]) => !requestsBefore.has(id) && request.route === '/v1/chat/completions');
      return ours.length === 1 && ours[0]![1].finished !== undefined;
    }, settings.settleTimeoutMs, { giveUp: () => daemon!.leaderExited });
    const ours = [...facts.requests.entries()].filter(([id, request]) => !requestsBefore.has(id) && request.route === '/v1/chat/completions');
    const request = correlated && ours.length === 1 ? ours[0]![1] : undefined;
    if (request && request.keys.some((key) => key.source !== 'fresh')) receipt.keyReuse = 'not_verified';
    const keyRef = request?.keys.length === 1 ? request.keys[0]!.keyRef : undefined;
    let fenceClears = false;
    if (keyRef !== undefined) {
      receipt.settlement = await waitFor(
        () => facts.settled.get(keyRef) === true,
        settings.settleTimeoutMs,
        { giveUp: () => daemon!.leaderExited },
      ) ? 'confirmed' : 'not_confirmed';
      fenceClears = receipt.settlement === 'confirmed' && request!.keys[0]!.source === 'fresh';
    } else {
      // No key for this request: only a refusal the daemon makes before any
      // lease request (model validation) proves nothing was issued.
      const preLease = request !== undefined && request.keys.length === 0 && request.finished?.status === 400
        && !completion.ok && (completion.error.daemonCode === 'invalid_model' || completion.error.daemonCode === 'model_budget_unavailable');
      receipt.settlement = preLease ? 'no_lease' : 'not_confirmed';
      fenceClears = preLease;
    }
    if (fenceClears) {
      try {
        updateState(statePath, now(), (state) => {
          const { fence: _cleared, ...rest } = state;
          return rest;
        });
        receipt.fence = 'clear';
      } catch {
        // stays held
      }
    }

    if (perConsultTor) {
      const torStopped = await stopGroup(tor!.pgid);
      // Secondary signal only. With Tor gone the model list must fail with the
      // daemon's exact upstream-unavailable shape; a 200 is a bypass.
      const after = torStopped && !daemon.leaderExited && await owned(false)
        ? await probeRequest(fetchImpl, `${origin}/v1/models`, { method: 'GET', headers: authorization }, undefined, MODELS_PROBE_TIMEOUT_MS)
        : undefined;
      receipt.postStopProbe = after?.status === 200
        ? 'still_reachable'
        : after?.status === 502 && daemonErrorEnvelope(after.body) === 'models_unavailable'
          ? 'route_lost'
          : 'inconclusive';
    }

    if (signal?.aborted) return (result = fail('aborted'));
    if (!completion.ok) {
      result = failure(completion.error.code, completion.error.outcome, identity(), {
        ...(completion.error.daemonCode ? { daemonCode: completion.error.daemonCode } : {}),
        ...(completion.error.httpStatus ? { httpStatus: completion.error.httpStatus } : {}),
        receipt: { ...receipt },
      });
      return result;
    }
    result = {
      ok: true,
      text: completion.text,
      routeLabel: zkapiRouteLabel(receipt),
      networkIdentity: identity(),
      receipt: { ...receipt },
      ...(completion.providerVerification ? { providerVerification: completion.providerVerification } : {}),
      elapsedMs: completion.elapsedMs,
    };
    return result;
  } catch {
    result = fail('internal_error');
    return result;
  } finally {
    // Each cleanup step on its own: one failure never skips the next.
    let allStopped = true;
    for (const group of [...groups].reverse()) {
      try {
        if (!await stopGroup(group.pgid)) allStopped = false;
      } catch {
        allStopped = false;
      }
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // a leftover private temp directory holds no secret
    }
    const final = result;
    try {
      updateState(statePath, now(), (state) => {
        const { running, ...rest } = state;
        return {
          ...rest,
          ...(allStopped ? {} : running ? { running } : {}),
          lastSession: { ...receipt, at: now().toISOString(), result: final?.ok ? 'ok' : final?.error.code ?? 'internal_error' },
        };
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

type CompletionResult =
  | { ok: true; text: string; providerVerification?: 'verified' | 'verifier-unavailable'; elapsedMs: number }
  | { ok: false; error: { code: ZkapiConsultErrorCode; outcome: ZkapiConsultOutcome; daemonCode?: ZkapiDaemonErrorCode; httpStatus?: number } };

async function sendCompletion(
  question: string,
  options: ZkapiConsultTransportOptions,
  origin: string,
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
  const bad = (code: ZkapiConsultErrorCode, outcome: ZkapiConsultOutcome, extra: { daemonCode?: ZkapiDaemonErrorCode; httpStatus?: number } = {}): CompletionResult => (
    { ok: false, error: { code, outcome, ...extra } }
  );
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
      if (timedOut) return bad('timeout', 'unknown');
      if (controller.signal.aborted) return bad('aborted', 'unknown');
      if (isRedirectError(error)) return bad('redirect_refused', 'unknown');
      return bad('transport_failed', 'unknown');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return bad('redirect_refused', 'unknown', { httpStatus: response.status });
    }
    const body = await readBounded(response, settings.maxResponseBytes).catch(() => undefined);
    if (!body) {
      if (timedOut) return bad('timeout', 'unknown');
      if (controller.signal.aborted) return bad('aborted', 'unknown');
      return bad('transport_failed', 'unknown');
    }
    if (!body.ok) return bad('response_too_large', 'unknown', { httpStatus: response.status });
    if (response.status < 200 || response.status >= 300) {
      return bad('daemon_error', 'sent_failed', {
        httpStatus: response.status,
        daemonCode: knownDaemonCode(daemonErrorEnvelope(body.text)),
      });
    }
    // A 200 is not trusted on its own: the body must be one well-formed,
    // non-empty completion.
    const text = completionText(body.text);
    if (text === undefined) return bad('invalid_response', 'unknown', { httpStatus: response.status });
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
    const parsed = JSON.parse(body) as { choices?: unknown };
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

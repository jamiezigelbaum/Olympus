// Experimental zkAPI consult transport (design: docs/design/frontier-consult-lane.md,
// track Z, tranche Z1).
//
// One consult = one supervised session, strictly one at a time across every
// Olympus process (a cross-process file lease is held for the whole session,
// from `open` through `finished`):
//
//   open:     throwaway Tor client (fresh data directory) on the owner's relay
//             port -> `zkapi-clientd serve`, network-confined where the
//             platform allows it -> verify -> warm the model policy
//   send:     the caller's final authorization -> reserve the worst case and
//             set the unresolved-session fence -> one stateless chat request
//             -> the reply is handed over as soon as the completion is in hand
//   finished: wait for the daemon's correlated key and settlement -> stop Tor
//             -> secondary probe -> stop every owned process group.
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
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import {
  FileLeaseBusyError,
  processInstanceIdentity,
  withFileLease,
  withFileLeaseSync,
  type ProcessInstanceIdentity,
} from './file-lease.ts';
import { managedToolExecutable } from './managed-tools.ts';
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
 * (`internal/zkapi/model_budget.go`; $1 to $6 by the model's price tier). A
 * request is counted against the owner's daily spend limit at the allowance
 * the live model list states for its model, since that is what the daemon
 * holds; $6 is the ceiling, used only when no listing is at hand. The daemon
 * recomputes the allowance from live policy after queueing, so a policy
 * change between the listing and the send can move the actual hold, bounded
 * by $6. A newer version is refused until its allowance table is reviewed.
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
  | 'unresolved_session_other_wallet'
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
  | 'confinement_self_test_failed'
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
  | 'teardown_incomplete'
  | 'authorization_refused'
  | 'session_spent'
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
  /** `pending`: only on the receipt a session hands over with its reply, before settlement is known. */
  settlement: 'confirmed' | 'not_confirmed' | 'no_lease' | 'pending';
  fence: 'clear' | 'held';
  daemonVersion?: string;
  network?: 'mainnet' | 'sepolia';
  listedAllowanceUsd?: number;
  reservedUsd?: number;
  /** How long each stage took; content-free numbers only. */
  stageMs?: ZkapiStageTimings;
}

/**
 * Monotonic whole milliseconds spent in each stage of one session, in session
 * order. A stage that started is recorded with the time spent in it, whether
 * it completed or ended the session (a dispatch that timed out records the
 * wait until it failed); a stage never started is absent, never zero.
 */
export interface ZkapiStageTimings {
  /** Session start until the cross-process session lease is held. */
  leaseAcquireMs?: number;
  /** The platform confinement's self-test (Tor sessions only). */
  confinementSelfTestMs?: number;
  /** Tor start until "Bootstrapped 100". */
  torBootstrapMs?: number;
  /** Daemon start until it logs its listener and its health check answers. */
  daemonReadyMs?: number;
  /** Version, route, key-isolation, ownership and local-auth checks. */
  daemonVerifyMs?: number;
  /** Polling the model list until the reviewed policy is listed. */
  policyWarmMs?: number;
  /** Session start until the route is ready for a question: everything above, waiting for nothing. */
  warmTotalMs?: number;
  /** The ownership check, the caller's final authorization, and the ledger reservation and fence before dispatch. */
  reservationMs?: number;
  /** Request dispatch until the response headers arrive. */
  dispatchToFirstByteMs?: number;
  /** Response headers until the body is read. */
  firstByteToCompletionMs?: number;
  /** Session start until the reply was handed to the caller, before settlement (replies only). */
  replyHandedOverAtMs?: number;
  /** Waiting for the daemon log to correlate this request and its key. */
  correlationWaitMs?: number;
  /** Waiting for the daemon to report the key settled. */
  settlementWaitMs?: number;
  /** Stopping Tor before the post-stop probe. */
  torStopMs?: number;
  /** The post-stop route probe. */
  postStopProbeMs?: number;
  /** Stopping every owned process group and removing the session directory. */
  teardownMs?: number;
  /** Session start until teardown ends (or until a refusal before any process started). */
  totalMs?: number;
}

/** Display order and labels for stage timings. */
export const ZKAPI_STAGE_LABELS: ReadonlyArray<readonly [keyof ZkapiStageTimings, string]> = [
  ['leaseAcquireMs', 'lease acquire'],
  ['confinementSelfTestMs', 'confinement self-test'],
  ['torBootstrapMs', 'Tor start to bootstrapped'],
  ['daemonReadyMs', 'daemon start to ready'],
  ['daemonVerifyMs', 'daemon verification'],
  ['policyWarmMs', 'models/policy warm'],
  ['warmTotalMs', 'warm total'],
  ['reservationMs', 'reservation'],
  ['dispatchToFirstByteMs', 'dispatch to first byte'],
  ['firstByteToCompletionMs', 'first byte to completion'],
  ['replyHandedOverAtMs', 'reply handed over at'],
  ['correlationWaitMs', 'request correlation wait'],
  ['settlementWaitMs', 'settlement wait'],
  ['torStopMs', 'Tor stop'],
  ['postStopProbeMs', 'post-stop probe'],
  ['teardownMs', 'teardown'],
  ['totalMs', 'total'],
];

/** The recorded stages, in session order; absent stages are skipped. */
export function zkapiStageRows(timings: ZkapiStageTimings | undefined): Array<{ label: string; ms: number }> {
  if (!timings) return [];
  return ZKAPI_STAGE_LABELS
    .filter(([key]) => typeof timings[key] === 'number')
    .map(([key, label]) => ({ label, ms: timings[key]! }));
}

/** A fixed-width text table of the recorded stages. */
export function formatZkapiStageTable(timings: ZkapiStageTimings | undefined): string {
  const rows = zkapiStageRows(timings);
  if (rows.length === 0) return 'no stage timings recorded';
  const width = Math.max(...rows.map((row) => row.label.length));
  const msWidth = Math.max(...rows.map((row) => String(row.ms).length));
  return rows.map((row) => `${row.label.padEnd(width)}  ${String(row.ms).padStart(msWidth)} ms`).join('\n');
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
  /** Timings for a session that ended before it had a receipt (the session lease was not taken). */
  stageMs?: ZkapiStageTimings;
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
  /** Monotonic milliseconds for stage timings; defaults to `performance.now()`. */
  clock?: () => number;
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
  /** `cap` / `capUsd` absent: no owner-set limit. */
  requestsToday: { count: number; cap?: number };
  spendToday: { reservedUsd: number; capUsd?: number };
  unresolvedSession: boolean;
  /** Every outstanding fence, with its recorded facts; any one blocks consults. */
  fences: Array<ZkapiFence & { thisWallet: boolean }>;
  /** A process record an earlier session left; it blocks until cleared. */
  stranded?: { supervisorPid: number; supervisorRunning: boolean; groups: Array<{ role: 'tor' | 'daemon'; pgid: number }> };
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
  unresolved_session_other_wallet: 'An unresolved zkAPI session belongs to another wallet directory; recover it there, or abandon it explicitly, before another consult.',
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
  confinement_self_test_failed: 'The network confinement for this platform did not pass its self-test, so the session was refused.',
  policy_unavailable: 'The daemon could not load the model policy in time.',
  model_unavailable: 'The selected model is not in the daemon\'s live model list.',
  daily_cap_reached: 'The daily zkAPI request limit you set is reached.',
  spend_cap_reached: 'Another request would exceed the daily zkAPI spend limit you set (each question counts the amount zkAPI holds for its model).',
  state_unavailable: 'The persistent zkAPI session ledger could not be read or written.',
  timeout: 'The zkAPI consult timed out; it may still have been charged.',
  aborted: 'The zkAPI consult was cancelled; it may still have been charged.',
  redirect_refused: 'The daemon answered with a redirect, which is never followed.',
  response_too_large: 'The zkAPI response exceeded the size limit and was cut off.',
  invalid_response: 'The zkAPI response was not a single non-empty chat completion.',
  daemon_error: 'The zkAPI daemon returned an error.',
  transport_failed: 'The request to the zkAPI daemon failed.',
  teardown_incomplete: 'The session\'s processes could not be confirmed stopped; the next session will not start until they are.',
  authorization_refused: 'The final authorization immediately before dispatch refused the consult; nothing was reserved or sent.',
  session_spent: 'This zkAPI session has already sent, was cancelled, or has ended; each session sends at most once.',
  internal_error: 'The zkAPI session failed inside Olympus.',
};

function failure(
  code: ZkapiConsultErrorCode,
  outcome: ZkapiConsultOutcome,
  networkIdentity: ZkapiNetworkIdentity,
  extra: Partial<Pick<ZkapiConsultError, 'daemonCode' | 'httpStatus' | 'receipt' | 'stageMs'>> = {},
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
  if (confined === 'loopback_filtered' && receipt.freshTorClient && receipt.settlement !== 'not_confirmed' && receipt.settlement !== 'pending') {
    return 'anonymous route (payment, key and network identity hidden)';
  }
  const unsettled = receipt.settlement === 'not_confirmed'
    ? '; lease settlement not confirmed'
    : receipt.settlement === 'pending'
      ? '; lease settlement pending'
      : '';
  return `payment privacy; a fresh Tor client was started and the daemon reports SOCKS5 mode, but the actual route is not verified; ${confinementStatement(confined)}${unsettled}`;
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
 * What a confinement enforces, as one description: the sandbox profile and
 * every label or doctor sentence about confinement are derived from it.
 */
export interface ZkapiConfinementPolicy {
  /** Connections to any non-loopback address. */
  nonLoopback: 'denied' | 'allowed';
  /** Unix-domain connections, including the system resolver socket. */
  unixSockets: 'denied' | 'allowed';
  /** Which loopback ports the daemon and its descendants may connect to. */
  loopbackOutbound: 'session_ports_only' | 'any';
}

export function confinementLevel(policy: ZkapiConfinementPolicy): ZkapiConfinementLevel {
  if (policy.nonLoopback !== 'denied' || policy.unixSockets !== 'denied') return 'none';
  return policy.loopbackOutbound === 'session_ports_only' ? 'loopback_filtered' : 'non_loopback_blocked';
}

/** The one sentence every label and doctor line uses for a confinement level. */
export function confinementStatement(level: ZkapiConfinementLevel): string {
  if (level === 'loopback_filtered') {
    return 'network confinement allowed only this session\'s Tor and daemon ports';
  }
  if (level === 'non_loopback_blocked') {
    return 'in this session\'s sandbox probe, a TCP connection to a non-routable address failed at once inside the sandbox but not outside it, the system resolver socket was unreachable inside but reachable outside, and a UDP send was refused inside but accepted locally outside; loopback is not port-filtered';
  }
  return 'no network confinement';
}

/**
 * The macOS profile for a policy. `sandbox-exec` is deprecated but shipped; the
 * kernel enforces the profile for the daemon, its wallet companion and every
 * other descendant, whatever language they are written in.
 */
export function darwinSandboxProfile(policy: ZkapiConfinementPolicy, ports: { tor: number; daemon: number }): string {
  const rules = ['(version 1)', '(allow default)'];
  if (policy.nonLoopback === 'denied' || policy.unixSockets === 'denied') {
    rules.push('(deny network*)');
    rules.push('(allow network-bind (local ip "localhost:*"))');
    rules.push('(allow network-inbound (local ip "localhost:*"))');
    if (policy.loopbackOutbound === 'any') {
      rules.push('(allow network-outbound (remote ip "localhost:*"))');
    } else {
      rules.push(`(allow network-outbound (remote ip "localhost:${ports.tor}"))`);
      rules.push(`(allow network-outbound (remote ip "localhost:${ports.daemon}"))`);
    }
  }
  return rules.join('');
}

/**
 * The policy this platform can enforce for zkapi-clientd. Loopback stays
 * open on macOS: the managed companion reaches the network through a proxy the
 * daemon opens on a random loopback port (upstream `internal/relay/connect.go`),
 * which a profile written before start cannot name.
 */
const DARWIN_POLICY: ZkapiConfinementPolicy = { nonLoopback: 'denied', unixSockets: 'denied', loopbackOutbound: 'any' };

// Plain CommonJS so it runs under Bun or Node. 192.0.2.1 is TEST-NET-1: it
// routes nowhere, so an unconfined probe sends nothing anyone can receive.
// The same script runs inside and outside the sandbox; only the difference
// counts. A loopback listener inside the probe is the positive control.
const SELF_TEST_SCRIPT = `
const net = require('node:net');
const dgram = require('node:dgram');
const loopback = () => new Promise((resolve) => {
  const server = net.createServer((c) => c.end());
  server.listen(0, '127.0.0.1', () => {
    const s = net.createConnection({ host: '127.0.0.1', port: server.address().port });
    s.once('connect', () => { s.destroy(); server.close(); resolve('connected'); });
    s.once('error', () => { server.close(); resolve('failed'); });
  });
});
const tcp = () => new Promise((resolve) => {
  const started = Date.now();
  const s = net.createConnection({ host: '192.0.2.1', port: 9 });
  s.setTimeout(3000, () => { s.destroy(); resolve('timeout'); });
  s.once('connect', () => { s.destroy(); resolve('connected'); });
  s.once('error', () => resolve(Date.now() - started < 1000 ? 'failed_fast' : 'failed_slow'));
});
const udp = () => new Promise((resolve) => {
  const s = dgram.createSocket('udp4');
  s.send(Buffer.from([0]), 53, '192.0.2.1', (e) => { s.close(); resolve(e ? 'failed' : 'sent'); });
});
const resolver = () => new Promise((resolve) => {
  const s = net.createConnection({ path: '/private/var/run/mDNSResponder' });
  s.once('connect', () => { s.destroy(); resolve('connected'); });
  s.once('error', () => resolve('failed'));
});
(async () => {
  const result = { loopback: await loopback(), udp: await udp(), resolver: await resolver(), tcp: await tcp() };
  process.stdout.write(JSON.stringify(result));
})();
`;

function runSelfTestProbe(argv: string[], env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  try {
    return JSON.parse(execFileSync(argv[0]!, argv.slice(1), {
      encoding: 'utf8',
      timeout: 10_000,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    })) as Record<string, string>;
  } catch {
    return undefined;
  }
}

export function defaultZkapiConfinement(): ZkapiConfinement {
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const level = confinementLevel(DARWIN_POLICY);
    return {
      level,
      limit: `macOS sandbox available; each session self-tests it, and when that passes: ${confinementStatement(level)}`,
      wrap: (argv, ports) => ['/usr/bin/sandbox-exec', '-p', darwinSandboxProfile(DARWIN_POLICY, ports), ...argv],
      selfTest: async (workDir, env) => {
        const script = join(workDir, 'confinement-self-test.cjs');
        writeFileSync(script, SELF_TEST_SCRIPT, { mode: 0o600 });
        // The same probes outside are the controls: there the TCP attempt to a
        // non-routable address must not fail at once, the resolver socket must
        // connect and the UDP send must be accepted, so a failure inside is the
        // sandbox's doing and not an offline machine. Bun reports a sandbox
        // denial under other error names, so denial is inferred from that
        // difference, not from an error code.
        const outside = runSelfTestProbe([process.execPath, script], env);
        const inside = runSelfTestProbe(
          ['/usr/bin/sandbox-exec', '-p', darwinSandboxProfile(DARWIN_POLICY, { tor: 1, daemon: 1 }), process.execPath, script],
          env,
        );
        return outside?.loopback === 'connected' && outside.udp === 'sent' && outside.resolver === 'connected'
          && (outside.tcp === 'timeout' || outside.tcp === 'failed_slow')
          && inside?.loopback === 'connected' && inside.udp === 'failed' && inside.resolver === 'failed'
          && inside.tcp === 'failed_fast';
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
  /**
   * Per wallet scope (`zkapiFenceScope`, the canonical config directory): set
   * before dispatch, cleared only on correlated key and settlement evidence
   * from a session in the same scope, or marked abandoned by the owner. Any
   * outstanding fence blocks every consult.
   */
  fences?: Record<string, ZkapiFence>;
  /** Fences the owner abandoned; kept as a record, never blocking. */
  abandonedFences?: Record<string, ZkapiFence & { abandonedAt: string }>;
  /** Written before any process starts; cleared only once every group is confirmed gone. */
  running?: {
    sessionId: string;
    supervisor: { pid: number; instance?: ProcessInstanceIdentity };
    /** The session's private directory (Tor data, probe scripts), removed with the groups. */
    workDir?: string;
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

/** An outstanding fence and the non-secret facts recorded with it. */
export interface ZkapiFence {
  at: string;
  configDir: string;
  daemonExecutable?: string;
  daemonPort?: number;
}

/** Every outstanding fence, keyed by scope. */
export function zkapiOutstandingFences(path: string): Record<string, ZkapiFence> {
  return readState(path)?.fences ?? {};
}

export function zkapiUnresolvedSession(path: string, scope?: string): boolean {
  const fences = zkapiOutstandingFences(path);
  return scope === undefined ? Object.keys(fences).length > 0 : Boolean(fences[scope]);
}

/**
 * The wallet a lease belongs to. zkapi-clientd keeps one wallet per config
 * directory, so the scope is that directory, canonicalized (real path when it
 * exists, otherwise a normalized absolute path), taken from the same
 * environment variables and platform default the daemon reads. The executable
 * and port are recorded with a fence as facts, not identity: replacing the
 * daemon or moving its port is the same wallet. Nothing is read from the
 * daemon's config.json.
 */
export function zkapiWalletDirectory(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || homedir();
  const configured = env.ZKAPI_CLIENTD_CONFIG_DIR?.trim()
    || env.OA_CHAT_CONFIG_DIR?.trim()
    || (process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'zkapi-clientd')
      : join(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'zkapi-clientd'));
  const absolute = resolvePath(configured);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function zkapiFenceScope(input: { env: Record<string, string | undefined> }): string {
  return createHash('sha256').update(zkapiWalletDirectory(input.env)).digest('hex').slice(0, 32);
}

/**
 * The owner's explicit way out for a fence whose wallet can no longer run a
 * recovery session (the directory was moved or the wallet replaced). The fence
 * is kept as an abandoned record and stops blocking. An abandoned fence means
 * a lease left unsettled may later settle under another session's network
 * identity. Never called automatically.
 */
export function abandonZkapiFence(path: string, scope: string, now: Date): boolean {
  let found = false;
  updateState(path, now, (state) => {
    const fence = state.fences?.[scope];
    if (!fence) return undefined;
    found = true;
    const { [scope]: _abandoned, ...others } = state.fences ?? {};
    const { fences: _all, ...rest } = state;
    return {
      ...rest,
      ...(Object.keys(others).length > 0 ? { fences: others } : {}),
      abandonedFences: { ...state.abandonedFences, [scope]: { ...fence, abandonedAt: now.toISOString() } },
    };
  });
  return found;
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
        ...(current?.fences ? { fences: current.fences } : {}),
        ...(current?.abandonedFences ? { abandonedFences: current.abandonedFences } : {}),
        ...(current?.running ? { running: current.running } : {}),
      };
    const next = mutate(base);
    if (!next) return base;
    lease.commit(() => writePrivateFileAtomicSync(path, `${JSON.stringify(next)}\n`));
    return next;
  }, { acquireTimeoutMs: 5_000 });
}

/** The owner's optional daily limits; absent means no limit (owner ruling, 2026-10-05). */
function ownerLimits(settings: ZkapiConsultSettings): { requestCap?: number; spendCapMicroUsd?: number } {
  return {
    ...(settings.dailyRequestCap !== undefined ? { requestCap: settings.dailyRequestCap } : {}),
    ...(settings.dailySpendCapUsd !== undefined ? { spendCapMicroUsd: Math.round(settings.dailySpendCapUsd * 1_000_000) } : {}),
  };
}

/**
 * Record one request at its model's listed allowance (the daemon's hold for
 * it; $6, the ceiling, when unknown) under a cross-process lease before the
 * send, and set the unresolved-session fence in the same write.
 * Never handed back: a send whose outcome is unknown, or that failed after the
 * daemon accepted it, may still have been charged.
 */
export function reserveZkapiRequest(
  path: string,
  limits: { requestCap?: number; spendCapMicroUsd?: number },
  now: Date,
  fence: { scope: string } & Omit<ZkapiFence, 'at'> = { scope: 'default', configDir: 'unknown' },
  allowanceMicroUsd: number = ZKAPI_MAX_ALLOWANCE_MICRO_USD,
): { reserved: true } | { reserved: false; reason: 'daily_cap_reached' | 'spend_cap_reached' } {
  let refusal: 'daily_cap_reached' | 'spend_cap_reached' | undefined;
  updateState(path, now, (state) => {
    if (limits.requestCap !== undefined && state.count >= limits.requestCap) {
      refusal = 'daily_cap_reached';
      return undefined;
    }
    if (limits.spendCapMicroUsd !== undefined && state.reservedMicroUsd + allowanceMicroUsd > limits.spendCapMicroUsd) {
      refusal = 'spend_cap_reached';
      return undefined;
    }
    return {
      ...state,
      count: state.count + 1,
      reservedMicroUsd: state.reservedMicroUsd + allowanceMicroUsd,
      fences: (() => {
        const { scope, ...facts } = fence;
        return { ...state.fences, [scope]: { ...facts, at: now.toISOString() } };
      })(),
    };
  });
  return refusal ? { reserved: false, reason: refusal } : { reserved: true };
}

// ---------------------------------------------------------------------------
// Process groups

/**
 * Each owned process runs under this watchdog, which leads its own process
 * group. It refuses to run unless its parent is the expected supervisor, and
 * starts its child only after the supervisor confirms (on stdin) that the
 * group is durably recorded. Any ending -- the child exits, a TERM/INT
 * arrives, or the supervisor dies -- goes through one group cleanup that
 * keeps the watchdog alive until every other member is gone, escalating to
 * SIGKILL. Tor additionally exits through `__OwningControllerProcess`.
 */
/** The line the watchdog prints the moment its child exits, before group cleanup. */
const WATCHDOG_CHILD_EXITED = 'OLYMPUS_ZKAPI_WATCHDOG_CHILD_EXITED';
const WATCHDOG_SCRIPT = `
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const [, , expectedParentText, ...argv] = process.argv;
const expectedParent = Number(expectedParentText);
const self = process.pid;
if (process.ppid !== expectedParent) process.exit(70);
let child;
let cleaning = false;
let exitCode = 0;
const othersInGroup = () => {
  if (process.platform === 'linux') {
    let count = 0;
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\\d+$/.test(name) || Number(name) === self) continue;
      try {
        const stat = fs.readFileSync('/proc/' + name + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/);
        if (Number(fields[2]) === self && fields[0] !== 'Z') count += 1;
      } catch {}
    }
    return count;
  }
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-g', String(self)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\\n').filter((line) => line.trim() && Number(line) !== self).length;
  } catch (error) {
    return error && error.status === 1 ? 0 : Infinity;
  }
};
const cleanup = () => {
  if (cleaning) return;
  cleaning = true;
  try { process.kill(-self, 'SIGTERM'); } catch {}
  const deadline = Date.now() + 5000;
  const tick = () => {
    if (othersInGroup() === 0) process.exit(exitCode);
    if (Date.now() >= deadline) { try { process.kill(-self, 'SIGKILL'); } catch {} return; }
    setTimeout(tick, 100);
  };
  setTimeout(tick, 50);
};
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
// With the supervisor gone its pipes are broken: a failed write must never
// take the watchdog down before the group is clean.
process.on('SIGPIPE', () => {});
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.on('uncaughtException', () => cleanup());
const start = () => {
  child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'] });
  const report = () => { try { process.stdout.write('\\n${WATCHDOG_CHILD_EXITED}\\n'); } catch {} };
  child.on('exit', (code) => { exitCode = code === null ? 1 : code; report(); cleanup(); });
  child.on('error', () => { exitCode = 127; report(); cleanup(); });
};
let received = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { received += chunk; if (!child && !cleaning && received.includes('go\\n')) start(); });
process.stdin.on('end', () => { if (!child) process.exit(71); });
setInterval(() => { if (process.ppid !== expectedParent) cleanup(); }, 500);
`;

interface Supervised {
  readonly role: 'tor' | 'daemon';
  readonly child: ChildProcess;
  readonly pgid: number;
  leaderExited: boolean;
  /** The watchdog's child (Tor or the daemon) exited; reported before group cleanup ends. */
  childExited: boolean;
  /** Set before Olympus stops the group on purpose, so the exit is not a failure. */
  deliberate: boolean;
  /** The group leader's process instance, taken at spawn. */
  readonly leader: ProcessInstanceIdentity | undefined;
  /** Once confirmed gone, the group id is never signalled again. */
  gone: boolean;
  /** Releases the watchdog to start its child; call only once the group is recorded. */
  go(): void;
}

function supervise(
  role: 'tor' | 'daemon',
  watchdog: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
  onExit: (handle: Supervised) => void,
): Supervised {
  // detached: the watchdog leads a new group with no controlling terminal, so
  // the daemon's prompts can never land on the owner's terminal.
  const child = spawn(process.execPath, [watchdog, String(process.pid), ...argv], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const handle: Supervised = {
    role,
    child,
    pgid: child.pid ?? -1,
    leader: child.pid ? processInstanceIdentity(child.pid) : undefined,
    gone: false,
    leaderExited: false,
    childExited: false,
    deliberate: false,
    go: () => {
      child.stdin?.write('go\n');
    },
  };
  let reported = false;
  const report = (): void => {
    if (reported) return;
    reported = true;
    onExit(handle);
  };
  const exited = (): void => {
    handle.leaderExited = true;
    report();
  };
  child.on('exit', exited);
  child.on('error', exited);
  child.stdin?.on('error', () => undefined);
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      pending += chunk;
      let index = pending.indexOf('\n');
      while (index >= 0) {
        // Each line is parsed for fixed facts and dropped; nothing is retained,
        // including the daemon's cost and balance lines.
        const line = pending.slice(0, index);
        if (line === WATCHDOG_CHILD_EXITED) {
          handle.childExited = true;
          report();
        } else {
          onLine(line);
        }
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

/**
 * Stop a whole process group, whether or not its leader still runs. True once
 * it is gone. `stillOurs` is re-checked immediately before each signal.
 */
async function stopGroup(pgid: number, stillOurs: () => boolean = () => true): Promise<boolean> {
  if (!groupAlive(pgid)) return true;
  if (!stillOurs()) return false;
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    // raced with exit
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (groupAlive(pgid) && Date.now() < deadline) await sleep(POLL_MS);
  if (!groupAlive(pgid)) return true;
  if (!stillOurs()) return false;
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // raced with exit
  }
  const killDeadline = Date.now() + KILL_GRACE_MS;
  while (groupAlive(pgid) && Date.now() < killDeadline) await sleep(POLL_MS);
  return !groupAlive(pgid);
}

/**
 * Whether a live session's group is still the one Olympus started: its leader
 * runs and is the same process instance (boot, start time). The watchdog
 * leader outlives the rest of its group, so a missing leader means the id can
 * no longer be proven ours.
 */
function activeGroupIsOurs(handle: Supervised): boolean {
  if (!handle.leader) return false;
  try {
    process.kill(handle.pgid, 0);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EPERM') return false;
  }
  const current = processInstanceIdentity(handle.pgid);
  if (!current) return false;
  if (handle.leader.bootId && current.bootId && handle.leader.bootId !== current.bootId) return false;
  return current.platform === handle.leader.platform
    && current.mechanism === handle.leader.mechanism
    && current.startTime === handle.leader.startTime;
}

/** Stop an owned group at most once, re-proving ownership before every signal. */
async function stopOwned(handle: Supervised): Promise<boolean> {
  if (handle.gone) return true;
  const stopped = await stopGroup(handle.pgid, () => activeGroupIsOurs(handle));
  if (stopped) handle.gone = true;
  return stopped;
}

function currentBootId(): string | undefined {
  return processInstanceIdentity(process.pid)?.bootId;
}

/**
 * 'ours' | 'gone' | 'unknown' for a recorded group. A different boot is
 * checked first: nothing recorded before a reboot can still be running. A
 * live group whose leader is absent cannot be proven ours (its id may have
 * been reused after a crash), so it is unknown and never signalled.
 */
function recordedGroupState(group: OwnedGroup, recordedBootId: string | undefined): 'ours' | 'gone' | 'unknown' {
  const boot = currentBootId();
  const groupBoot = group.leader?.bootId ?? recordedBootId;
  if (groupBoot && boot && groupBoot !== boot) return 'gone';
  if (!groupAlive(group.pgid)) return 'gone';
  let leaderAlive = true;
  try {
    process.kill(group.pgid, 0);
  } catch (error) {
    leaderAlive = (error as { code?: string }).code === 'EPERM';
  }
  if (!leaderAlive) return 'unknown';
  const current = processInstanceIdentity(group.pgid);
  if (!group.leader || !current) return 'unknown';
  if (group.leader.platform !== current.platform || group.leader.mechanism !== current.mechanism) return 'unknown';
  return group.leader.startTime === current.startTime ? 'ours' : 'gone';
}

function supervisorAlive(supervisor: { pid: number; instance?: ProcessInstanceIdentity }): boolean {
  if (supervisor.pid === process.pid) return false;
  const boot = currentBootId();
  if (supervisor.instance?.bootId && boot && supervisor.instance.bootId !== boot) return false;
  try {
    process.kill(supervisor.pid, 0);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EPERM') return false;
  }
  const current = processInstanceIdentity(supervisor.pid);
  if (!supervisor.instance || !current) return true;
  return supervisor.instance.mechanism !== current.mechanism || supervisor.instance.startTime === current.startTime;
}

/**
 * Stop what an earlier session left running. Called only while holding the
 * session lease, and only once the recorded supervisor is proven dead. The
 * record (and its private directory) is kept unless every group is confirmed
 * gone; ownership is re-checked immediately before every signal.
 */
async function recoverStrandedGroups(statePath: string, now: Date): Promise<'clear' | 'busy' | 'stranded'> {
  const running = readState(statePath)?.running;
  if (!running) return 'clear';
  if (supervisorAlive(running.supervisor)) return 'busy';
  const recordedBoot = running.supervisor.instance?.bootId;
  let allGone = true;
  for (const group of running.groups) {
    const state = recordedGroupState(group, recordedBoot);
    if (state === 'unknown') {
      allGone = false;
      continue;
    }
    if (state === 'ours' && !await stopGroup(group.pgid, () => recordedGroupState(group, recordedBoot) === 'ours')) {
      allGone = false;
    }
  }
  if (!allGone) return 'stranded';
  if (running.workDir) {
    try {
      rmSync(running.workDir, { recursive: true, force: true });
    } catch {
      // a leftover private temp directory holds no secret
    }
  }
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

/**
 * The daemon starts its wallet companion (`zkapi-walletd`) by name from PATH.
 * A service manager's minimal PATH has neither the managed install nor
 * `~/.local/bin`, so the daemon's own install folder goes first: the
 * companion then always comes from the same install as the daemon.
 */
export function daemonEnvironment(base: NodeJS.ProcessEnv, daemonExecutable: string): NodeJS.ProcessEnv {
  let real = daemonExecutable;
  try {
    real = realpathSync(daemonExecutable);
  } catch {
    // An unresolvable path keeps its own folder.
  }
  const installBin = dirname(real);
  const rest = (base.PATH ?? '').split(delimiter).filter((entry) => entry && entry !== installBin);
  return { ...base, PATH: [installBin, ...rest].join(delimiter) };
}

/**
 * Where installers put these programs when PATH does not say so: a service
 * manager starts the worker with a minimal PATH (the engine's LaunchAgent has
 * only Bun's directory and the system ones), so a Homebrew `tor` or a
 * `~/.local/bin/zkapi-clientd` would otherwise read as not installed. Searched
 * after PATH, in this order. HOME comes from the passed environment.
 */
export function standardExecutableDirectories(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const home = env.HOME?.trim();
  const local = home && isAbsolute(home) ? [join(home, '.local', 'bin')] : [];
  if (platform === 'darwin') return [...local, '/opt/homebrew/bin', '/usr/local/bin'];
  if (platform === 'linux') return [...local, '/usr/local/bin'];
  return local;
}

/** What the fallback-folder trust check reads; a seam so tests can describe owners and modes. */
export interface ExecutableTrustProbe {
  realpath: (path: string) => string;
  stat: (path: string) => { uid: number; mode: number; isFile(): boolean; isDirectory(): boolean };
  executable: (path: string) => boolean;
  uid: () => number | undefined;
}

export const DEFAULT_EXECUTABLE_TRUST: ExecutableTrustProbe = {
  realpath: (path) => realpathSync(path),
  stat: (path) => statSync(path),
  executable: (path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  uid: () => (typeof process.getuid === 'function' ? process.getuid() : undefined),
};

/** Every directory from `path` up to the root is owned by this user or root and writable by neither group nor others. */
function trustedChain(path: string, probe: ExecutableTrustProbe, uid: number): boolean {
  for (let current = path; ; current = dirname(current)) {
    const stats = probe.stat(current);
    if (current !== path && !stats.isDirectory()) return false;
    if (stats.uid !== uid && stats.uid !== 0) return false;
    if ((stats.mode & 0o022) !== 0) return false;
    if (dirname(current) === current) return true;
  }
}

/**
 * A program found only in a standard install folder (never on PATH, never
 * named explicitly) runs only if nobody else could have put it there: the
 * canonical file and every ancestor directory, and the folder it was found in
 * and its ancestors, are owned by this user or root and are not group- or
 * world-writable. Returns the canonical path, so the readiness probe and the
 * session execute the same file; undefined when absent or untrusted.
 */
export function trustedFallbackExecutable(candidate: string, probe: ExecutableTrustProbe = DEFAULT_EXECUTABLE_TRUST): string | undefined {
  const uid = probe.uid();
  if (uid === undefined) return undefined;
  try {
    const real = probe.realpath(candidate);
    const target = probe.stat(real);
    if (!target.isFile() || !probe.executable(real)) return undefined;
    if (!trustedChain(real, probe, uid)) return undefined;
    if (!trustedChain(probe.realpath(dirname(candidate)), probe, uid)) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

/**
 * An explicit executable path (only that path), or the first match on PATH
 * (both as before), and then in the standard install directories, where a
 * match must also pass trustedFallbackExecutable. The readiness probe and the
 * real session both resolve through here, so they always agree.
 */
export function resolveExecutable(
  name: string,
  explicit: string | undefined,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  trust: ExecutableTrustProbe = DEFAULT_EXECUTABLE_TRUST,
): string | undefined {
  const pathDirectories = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = explicit ? [explicit] : pathDirectories.map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  if (explicit) return undefined;
  for (const dir of standardExecutableDirectories(env, platform)) {
    if (pathDirectories.includes(dir)) continue;
    const found = trustedFallbackExecutable(join(dir, name), trust);
    if (found) return found;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until `condition` holds. The condition is consulted first on every
 * round, so evidence already received is never discarded because a process
 * exited or the caller cancelled at the same moment; only then does an abort,
 * `giveUp` or the deadline end the wait (false).
 */
async function waitFor(
  condition: (remainingMs: number) => boolean | Promise<boolean>,
  timeoutMs: number,
  options: { signal?: AbortSignal | undefined; giveUp?: () => boolean; pollMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition(Math.max(0, deadline - Date.now()))) return true;
    if (options.signal?.aborted || options.giveUp?.()) return false;
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
  let pids: number[];
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      pids = [...new Set(out.split('\n').filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1))))];
    } catch (error) {
      return (error as { status?: number }).status === 1 ? { kind: 'not_visible' } : { kind: 'unavailable' };
    }
  } else if (process.platform === 'linux') {
    const found = linuxListenerPids(port);
    if (!Array.isArray(found)) return found;
    pids = found;
  } else {
    return { kind: 'unavailable' };
  }
  if (pids.length === 0) return { kind: 'not_visible' };
  // Every process holding a listener on the port must be in one group;
  // otherwise no group is reported and ownership fails.
  const pgids = new Set(pids.map((pid) => processGroupOf(pid)));
  const [pgid] = [...pgids];
  return pgids.size === 1 && pgid !== undefined
    ? { kind: 'found', pid: pids[0]!, pgid }
    : { kind: 'found', pid: pids[0]! };
}

function linuxListenerPids(port: number): number[] | ZkapiListenerInspection {
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
  let entries: string[];
  try {
    entries = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return { kind: 'unavailable' };
  }
  const owners = new Set<number>();
  const seen = new Set<string>();
  for (const pid of entries) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (match && inodes.has(match[1]!)) {
          owners.add(Number(pid));
          seen.add(match[1]!);
        }
      } catch {
        // fd closed meanwhile
      }
    }
  }
  // A listening socket this user cannot attribute belongs to someone else.
  if (seen.size !== inodes.size) return { kind: 'unavailable' };
  return [...owners];
}

// ---------------------------------------------------------------------------
// Which executable: the owner's explicit path, else Olympus's own install, else PATH

/**
 * The one resolution the readiness probe and the real session share. An
 * explicit path in the route's settings is only that path. Otherwise the
 * build Olympus installed and verified (managed-tools.ts: pinned version and
 * hash, owner-only folders, real path inside its version folder) comes first,
 * then resolveExecutable's search.
 */
export function resolveZkapiExecutable(
  name: 'zkapi-clientd' | 'tor',
  explicit: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  if (!explicit) {
    const managed = managedToolExecutable(name, { env });
    if (managed) return managed;
  }
  return resolveExecutable(name, explicit, env);
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
  const daemonExecutable = resolveZkapiExecutable('zkapi-clientd', settings.daemonExecutable, env);
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
  const torExecutable = settings.tor === 'per_consult' ? resolveZkapiExecutable('tor', settings.torExecutable, env) : undefined;
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
  const currentScope = zkapiFenceScope({ env });
  let fences: ZkapiConsultReadiness['fences'] = [];
  let stranded: ZkapiConsultReadiness['stranded'];
  try {
    const state = readState(statePath);
    usage = zkapiUsageToday(statePath, now);
    lastSession = zkapiLastSession(statePath);
    fences = Object.entries(state?.fences ?? {}).map(([scope, fence]) => ({ ...fence, thisWallet: scope === currentScope }));
    unresolvedSession = fences.length > 0;
    if (state?.running) {
      stranded = {
        supervisorPid: state.running.supervisor.pid,
        supervisorRunning: supervisorAlive(state.running.supervisor),
        groups: state.running.groups.map((group) => ({ role: group.role, pgid: group.pgid })),
      };
    }
  } catch {
    blockers.push('state_unavailable');
  }
  if (fences.some((fence) => fence.thisWallet)) blockers.push('unresolved_session');
  if (fences.some((fence) => !fence.thisWallet)) blockers.push('unresolved_session_other_wallet');
  if (stranded && !stranded.supervisorRunning) blockers.push('stranded_processes');
  const limit = ownerLimits(settings);
  if (limit.requestCap !== undefined && usage.count >= limit.requestCap) blockers.push('daily_cap_reached');
  // The next request's allowance is known only from the live listing inside
  // a session, so before one the limit blocks only once it is used up.
  if (limit.spendCapMicroUsd !== undefined && usage.reservedMicroUsd >= limit.spendCapMicroUsd) {
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
    requestsToday: { count: usage.count, ...(settings.dailyRequestCap !== undefined ? { cap: settings.dailyRequestCap } : {}) },
    spendToday: {
      reservedUsd: usage.reservedMicroUsd / 1_000_000,
      ...(settings.dailySpendCapUsd !== undefined ? { capUsd: settings.dailySpendCapUsd } : {}),
    },
    unresolvedSession,
    fences,
    ...(stranded ? { stranded } : {}),
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
// Sessions: open, send, finished (design §A.8, stage C2)
//
// One consult is one supervised session with a one-shot state machine:
//
//   open    opening → ready       lease held; confinement self-test, Tor, the
//                                 daemon, its verification and the policy warm
//                                 all run before any question exists
//   send    ready → authorizing → dispatched → replied
//   finished                    → finished    settlement, Tor stop, post-stop
//                                 probe, teardown; the lease is released here
//   cancel  before dispatch     → cancelled   nothing reserved, fenced or counted
//           after dispatch                    the caller is detached; the
//                                             session's own cleanup continues
//
// Dispatch order is the money boundary: the transport's awaited checks run
// first, then the caller's final authorization, then the reservation, the
// fence and the start of the fetch with no await between them. A cancellation
// that lands before that synchronous block wins; one after it is ignored by
// the fetch, which only the session's own completion timeout or a process
// exit can stop.

// In-process fast path; the cross-process session lease is the real guard.
let zkapiConsultInFlight = false;

export type ZkapiConsultSessionState = 'opening' | 'ready' | 'authorizing' | 'dispatched' | 'replied' | 'finished' | 'cancelled';

export interface ZkapiOpenControl {
  /** Cancels the session at any await before dispatch; detached after dispatch. */
  signal?: AbortSignal | undefined;
  /** How long `open` may take to reach `ready`; past it the session is refused with `timeout`, nothing reserved. */
  deadlineMs?: number | undefined;
  /**
   * How long a ready session waits for `send` before it cancels itself and
   * tears down (`timeout`, nothing reserved). Defaults to
   * `ZKAPI_SESSION_READY_TIMEOUT_MS`; bounds the lease and the warm processes.
   */
  readyTimeoutMs?: number | undefined;
}

/** A ready session that nobody sends on ends itself after this long. */
export const ZKAPI_SESSION_READY_TIMEOUT_MS = 120_000;

export interface ZkapiSendControl {
  /** Cancels before dispatch; after dispatch only stops the caller's wait for the reply. */
  signal?: AbortSignal | undefined;
  /**
   * The caller's final authorization (settings revision, liveness, deadlines,
   * eligibility, gate), run immediately before the synchronous reservation
   * and fetch. `false` refuses the consult with nothing reserved.
   */
  authorize?: ((signal: AbortSignal) => boolean | Promise<boolean>) | undefined;
  /** The send must dispatch within this many ms of the call, or it is refused with nothing reserved. */
  deadlineMs?: number | undefined;
}

/**
 * What `send` resolves with as soon as the completion is in hand, before
 * settlement: a reply whose receipt says `settlement: 'pending'` and
 * `fence: 'held'`, or the completion's failure. `finished` carries the final
 * receipt.
 */
export type ZkapiConsultReply =
  | {
    kind: 'reply';
    text: string;
    routeLabel: string;
    networkIdentity: ZkapiNetworkIdentity;
    receipt: ZkapiSessionReceipt;
    providerVerification?: 'verified' | 'verifier-unavailable';
    elapsedMs: number;
  }
  | { kind: 'failed'; error: ZkapiConsultError };

export interface ZkapiConsultSession {
  readonly state: ZkapiConsultSessionState;
  /** One shot: a second call, or a call after cancellation, is refused with `session_spent`. */
  send(question: string, control?: ZkapiSendControl): Promise<ZkapiConsultReply>;
  /** Before dispatch: full teardown, nothing reserved. After dispatch: detaches the caller only. */
  cancel(): void;
  /** Resolves after settlement, Tor stop, the post-stop probe and teardown; the lease is released then. */
  readonly finished: Promise<ZkapiConsultResult>;
}

export type ZkapiOpenSessionResult =
  | { ok: true; session: ZkapiConsultSession }
  | { ok: false; error: ZkapiConsultError };

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly settled: () => boolean;
}

function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      done(value);
    };
  });
  return { promise, resolve, settled: () => settled };
}

interface DispatchRequest {
  question: string;
  signal: AbortSignal | undefined;
  authorize: ZkapiSendControl['authorize'];
  /** Absolute monotonic instant (`performance.now()` scale) captured synchronously inside `send`. */
  deadlineAt: number | undefined;
}

type CancelReason = 'cancel' | 'deadline';

/** The caller's half of a session and the machine's half meet here. */
interface SessionBridge {
  state: ZkapiConsultSessionState;
  readonly openSignal: AbortSignal | undefined;
  readonly readyTimeoutMs: number;
  /** A cancellation asked for before the machine registered its handler. */
  cancelRequested: CancelReason | undefined;
  /** Registered by the machine. Before dispatch it aborts the session; after dispatch it detaches the caller. */
  cancel: ((reason: CancelReason) => void) | undefined;
  readonly ready: Deferred<void>;
  readonly dispatch: Deferred<DispatchRequest>;
  readonly reply: Deferred<ZkapiConsultReply>;
}

/**
 * Warm a consult route before the question exists: take the session lease,
 * self-test the confinement, start Tor and the daemon, verify them and warm
 * the model policy. Resolves with a ready session, or with a failure once
 * everything it started is stopped and the lease released. Until `send`
 * dispatches, the session has reserved, fenced and counted nothing.
 */
export async function openZkapiConsultSession(
  options: ZkapiConsultTransportOptions,
  control: ZkapiOpenControl = {},
): Promise<ZkapiOpenSessionResult> {
  return openSession(options, control, false);
}

/**
 * Send one approved consult question through a freshly supervised session and
 * return after settlement and teardown: `open`, `send` and `finished` in one
 * call. The only inputs that reach the daemon are `question` and
 * `options.model`, inside a fixed body: one user message, no system text, no
 * tools, no history, no streaming. A failure is returned, never retried, and
 * this module knows no other transport.
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
  return oneShot(question, false, options, control.signal);
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
  return oneShot(RECOVERY_QUESTION, true, options, control.signal);
}

/** Codes that describe the session's own end and are never replaced by the caller's cancellation. */
const SESSION_OWNED_FAILURES: ReadonlySet<ZkapiConsultErrorCode> = new Set(['session_process_exited', 'teardown_incomplete']);

async function oneShot(
  question: string,
  recovery: boolean,
  options: ZkapiConsultTransportOptions,
  signal: AbortSignal | undefined,
): Promise<ZkapiConsultResult> {
  const opened = await openSession(options, { signal }, recovery);
  if (!opened.ok) return opened;
  await opened.session.send(question, { signal });
  const result = await opened.session.finished;
  // The one-call contract: a caller that cancelled gets a typed cancellation,
  // outcome unknown, with the session's final receipt. The session itself
  // kept the reply and settled as usual.
  if (signal?.aborted && (result.ok || (result.error.outcome !== 'not_sent' && !SESSION_OWNED_FAILURES.has(result.error.code)))) {
    const receipt = result.ok ? result.receipt : result.error.receipt;
    const identity = result.ok ? result.networkIdentity : result.error.networkIdentity;
    return failure('aborted', 'unknown', identity, receipt ? { receipt } : {});
  }
  return result;
}

async function openSession(
  options: ZkapiConsultTransportOptions,
  control: ZkapiOpenControl,
  recovery: boolean,
): Promise<ZkapiOpenSessionResult> {
  const initialIdentity: ZkapiNetworkIdentity = options.settings.tor === 'off' ? 'visible' : 'not_verified';
  if (zkapiConsultInFlight) return failure('busy', 'not_sent', initialIdentity);
  zkapiConsultInFlight = true;
  const statePath = options.statePath ?? defaultZkapiStatePath();
  const sent = { dispatched: false };
  // Timing never throws and never changes control flow: a failed or
  // non-finite clock sample just leaves that measurement out.
  const clock = options.clock ?? (() => performance.now());
  const startedAt = sampleClock(clock);
  const bridge: SessionBridge = {
    state: 'opening',
    openSignal: control.signal,
    readyTimeoutMs: control.readyTimeoutMs ?? ZKAPI_SESSION_READY_TIMEOUT_MS,
    cancelRequested: undefined,
    cancel: undefined,
    ready: deferred<void>(),
    dispatch: deferred<DispatchRequest>(),
    reply: deferred<ZkapiConsultReply>(),
  };
  const requestCancel = (reason: CancelReason): void => {
    if (bridge.cancel) bridge.cancel(reason);
    else bridge.cancelRequested ??= reason;
  };
  const openDeadline = control.deadlineMs !== undefined
    ? setTimeout(() => {
      if (bridge.state === 'opening') requestCancel('deadline');
    }, control.deadlineMs)
    : undefined;
  let leaseHeld = false;
  const finished = (async (): Promise<ZkapiConsultResult> => {
    try {
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
      const result = await withFileLease(
        `${statePath}.session`,
        () => {
          leaseHeld = true;
          return runSession(recovery, options, statePath, bridge, sent, clock, startedAt);
        },
        { acquireTimeoutMs: 50 },
      );
      // A refusal before any process started never reaches teardown; its total ends here.
      const receipt = result.ok ? result.receipt : result.error.receipt;
      if (receipt && receipt.stageMs?.totalMs === undefined) {
        receipt.stageMs = withTiming(receipt.stageMs ?? {}, 'totalMs', elapsedMs(clock, startedAt));
        if (Object.keys(receipt.stageMs).length === 0) delete receipt.stageMs;
      }
      return result;
    } catch (error) {
      // No receipt exists on this path; the timings ride on the error instead.
      const total = elapsedMs(clock, startedAt);
      let stageMs = withTiming({}, 'totalMs', total);
      if (!leaseHeld) stageMs = withTiming(stageMs, 'leaseAcquireMs', total);
      const timed = Object.keys(stageMs).length > 0 ? { stageMs } : {};
      if (error instanceof FileLeaseBusyError) return failure('busy', 'not_sent', initialIdentity, timed);
      return failure('internal_error', sent.dispatched ? 'unknown' : 'not_sent', initialIdentity, timed);
    } finally {
      zkapiConsultInFlight = false;
    }
  })().then((result) => {
    // The lease is released by now. A send still waiting (the session ended
    // before dispatch) learns the outcome here.
    clearTimeout(openDeadline);
    bridge.state = sent.dispatched ? 'finished' : 'cancelled';
    if (!result.ok) bridge.reply.resolve({ kind: 'failed', error: result.error });
    return result;
  });
  const session: ZkapiConsultSession = {
    get state() {
      return bridge.state;
    },
    finished,
    cancel: () => requestCancel('cancel'),
    send: async (question, sendControl = {}) => {
      if (typeof question !== 'string' || !validQuestion(question)) {
        return { kind: 'failed', error: failure('invalid_question', 'not_sent', initialIdentity).error };
      }
      if (bridge.state !== 'ready') {
        return { kind: 'failed', error: failure('session_spent', 'not_sent', initialIdentity).error };
      }
      bridge.state = 'authorizing';
      // Captured here, synchronously, so event-loop delay before the machine
      // resumes counts against the deadline.
      const deadlineAt = sendControl.deadlineMs !== undefined ? performance.now() + sendControl.deadlineMs : undefined;
      bridge.dispatch.resolve({
        question,
        signal: sendControl.signal,
        authorize: sendControl.authorize,
        deadlineAt,
      });
      return bridge.reply.promise;
    },
  };
  const ready = await Promise.race([
    bridge.ready.promise.then(() => true),
    finished.then(() => false),
  ]);
  if (ready) {
    clearTimeout(openDeadline);
    return { ok: true, session };
  }
  const result = await finished;
  return result.ok ? failure('internal_error', 'unknown', result.networkIdentity, { receipt: result.receipt }) : result;
}

async function runSession(
  recovery: boolean,
  options: ZkapiConsultTransportOptions,
  statePath: string,
  bridge: SessionBridge,
  sent: { dispatched: boolean },
  clock: () => number,
  startedAt: number | undefined,
): Promise<ZkapiConsultResult> {
  // Stage timers: one clock sample per transition, never inside a polling
  // loop. Sampling never throws; a missing sample omits that stage.
  let timings: ZkapiStageTimings = withTiming({}, 'leaseAcquireMs', elapsedMs(clock, startedAt));
  let openStage: { key: keyof ZkapiStageTimings; at: number | undefined } | undefined;
  let lastSampleAt: number | undefined;
  const stage = (key: keyof ZkapiStageTimings | undefined): void => {
    const at = sampleClock(clock);
    lastSampleAt = at;
    if (openStage) timings = withTiming(timings, openStage.key, durationMs(openStage.at, at));
    openStage = key ? { key, at } : undefined;
  };
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
  const snapshot = (): ZkapiSessionReceipt => (
    Object.keys(timings).length > 0 ? { ...receipt, stageMs: { ...timings } } : { ...receipt }
  );
  /** The receipt as it stands between dispatch and settlement. */
  const pendingSnapshot = (): ZkapiSessionReceipt => ({ ...snapshot(), settlement: 'pending', fence: 'held' });
  const identity = (): ZkapiNetworkIdentity => (perConsultTor ? networkIdentityFor(receipt) : 'visible');
  const fail = (code: ZkapiConsultErrorCode, extra: Partial<Pick<ZkapiConsultError, 'daemonCode' | 'httpStatus'>> = {}): ZkapiConsultResult => (
    failure(code, sent.dispatched ? (extra.httpStatus ? 'sent_failed' : 'unknown') : 'not_sent', identity(), { ...extra, receipt: snapshot() })
  );

  // One signal for the whole session: a caller's cancellation or deadline
  // before dispatch, or any owned process exiting when Olympus did not stop it
  // on purpose. After dispatch the caller is detached and only the latter
  // remains.
  const sessionAbort = new AbortController();
  const sessionSignal = sessionAbort.signal;
  let abortCause: 'aborted' | 'timeout' = 'aborted';
  const cancelBeforeDispatch = (reason: CancelReason): void => {
    if (sessionSignal.aborted) return;
    abortCause = reason === 'deadline' ? 'timeout' : 'aborted';
    sessionAbort.abort();
  };
  let detachCaller: (() => void) | undefined;
  bridge.cancel = (reason) => {
    if (sent.dispatched) detachCaller?.();
    else cancelBeforeDispatch(reason);
  };
  const onCallerAbort = (): void => bridge.cancel!('cancel');
  bridge.openSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (bridge.openSignal?.aborted) cancelBeforeDispatch('cancel');
  if (bridge.cancelRequested) cancelBeforeDispatch(bridge.cancelRequested);
  let sendSignal: AbortSignal | undefined;
  const cleanupCallerSignals = (): void => {
    bridge.openSignal?.removeEventListener('abort', onCallerAbort);
    sendSignal?.removeEventListener('abort', onCallerAbort);
  };

  // --- Preconditions: nothing starts until all hold. The ledger's fences are
  // read first, so every refusal's receipt reflects them.
  const scope = zkapiFenceScope({ env });
  let fences: Record<string, ZkapiFence>;
  try {
    fences = zkapiOutstandingFences(statePath);
  } catch {
    cleanupCallerSignals();
    return fail('state_unavailable');
  }
  const fenced = Boolean(fences[scope]);
  const fencedElsewhere = Object.keys(fences).some((key) => key !== scope);
  if (fenced || fencedElsewhere) receipt.fence = 'held';
  if (fenced) receipt.settlement = 'not_confirmed';
  const refuse = (code: ZkapiConsultErrorCode): ZkapiConsultResult => {
    cleanupCallerSignals();
    return fail(code);
  };
  const blocked = settingsBlockers(zkapiMoneyStatus(settings, now()))[0];
  if (blocked) return refuse(blocked);
  if (!options.apiKey) return refuse('daemon_api_key_missing');
  const daemonExecutable = resolveZkapiExecutable('zkapi-clientd', settings.daemonExecutable, env);
  if (!daemonExecutable) return refuse('daemon_not_found');
  const torExecutable = perConsultTor ? resolveZkapiExecutable('tor', settings.torExecutable, env) : undefined;
  if (perConsultTor && !torExecutable) return refuse('tor_not_found');
  try {
    const stranded = await recoverStrandedGroups(statePath, now());
    if (stranded === 'busy') return refuse('busy');
    if (stranded === 'stranded') return refuse('stranded_processes');
    // Any outstanding fence blocks a consult; a fence that is not this
    // wallet's can only be recovered from its own wallet, or abandoned.
    if (!recovery && fenced) return refuse('unresolved_session');
    if (fencedElsewhere && !fenced) return refuse('unresolved_session_other_wallet');
    if (!fenced && recovery) return refuse('no_unresolved_session');
    const usage = zkapiUsageToday(statePath, now());
    const limit = ownerLimits(settings);
    if (limit.requestCap !== undefined && usage.count >= limit.requestCap) return refuse('daily_cap_reached');
    if (limit.spendCapMicroUsd !== undefined && usage.reservedMicroUsd >= limit.spendCapMicroUsd) {
      return refuse('spend_cap_reached');
    }
  } catch {
    return refuse('state_unavailable');
  }
  if (await portAnswers(daemonPort)) return refuse('daemon_already_running');
  if (perConsultTor && await portAnswers(settings.torSocksPort)) return refuse('tor_port_busy');
  // A cancellation that already landed starts nothing.
  if (sessionSignal.aborted) return refuse(abortCause);

  // --- The session. Every exit path below goes through the cleanup after it.
  const sessionId = randomUUID();
  const workDir = mkdtempSync(join(tmpdir(), 'olympus-zkapi-'));
  chmodSync(workDir, 0o700);
  const watchdog = join(workDir, 'watchdog.cjs');
  const childEnv = childEnvironment(env);
  const groups: Supervised[] = [];
  let tor: Supervised | undefined;
  let daemon: Supervised | undefined;
  let result: ZkapiConsultResult = failure('internal_error', 'not_sent', 'not_verified');
  const unexpectedExit = (): boolean => groups.some((group) => (group.leaderExited || group.childExited) && !group.deliberate);
  const onChildExit = (handle: Supervised): void => {
    if (!handle.deliberate) sessionAbort.abort();
  };
  const interrupted = (): ZkapiConsultErrorCode => (unexpectedExit() ? 'session_process_exited' : abortCause);
  let sendDeadline: ReturnType<typeof setTimeout> | undefined;
  result = await (async (): Promise<ZkapiConsultResult> => {
  try {
    writeFileSync(watchdog, WATCHDOG_SCRIPT, { mode: 0o600 });
    const supervisorInstance = processInstanceIdentity(process.pid);
    updateState(statePath, now(), (state) => ({
      ...state,
      running: { sessionId, supervisor: { pid: process.pid, ...(supervisorInstance ? { instance: supervisorInstance } : {}) }, workDir, groups: [] },
    }));
    // The watchdog waits on stdin; it starts its child only after this durable
    // record names its group.
    const recordAndStart = (handle: Supervised): void => {
      groups.push(handle);
      const leader = handle.leader;
      updateState(statePath, now(), (state) => ({
        ...state,
        ...(state.running
          ? { running: { ...state.running, groups: [...state.running.groups, { role: handle.role, pgid: handle.pgid, ...(leader ? { leader } : {}) }] } }
          : {}),
      }));
      handle.go();
    };
    const anyExited = unexpectedExit;

    if (perConsultTor) {
      stage('confinementSelfTestMs');
      if (await confinement.selfTest(workDir, childEnv)) {
        receipt.confinementSelfTest = 'passed';
      } else if (confinement.level !== 'none') {
        // Confinement that was requested but could not prove itself refuses.
        receipt.confinementSelfTest = 'failed';
        return (result = fail('confinement_self_test_failed'));
      }
      if (sessionSignal.aborted) return (result = fail(interrupted()));
      // zkapi-serve-tor.sh: a throwaway client with a fresh data directory, so
      // fresh guards and circuits; bound to Olympus's lifetime.
      const torDataDir = join(workDir, 'tor');
      mkdirSync(torDataDir, { mode: 0o700 });
      let bootstrapped = false;
      stage('torBootstrapMs');
      tor = supervise('tor', watchdog, [
        torExecutable!,
        '--ClientOnly', '1',
        '--PublishServerDescriptor', '0',
        '--DataDirectory', torDataDir,
        '--SocksPort', `127.0.0.1:${settings.torSocksPort}`,
        '--SafeLogging', '1',
        '--__OwningControllerProcess', String(process.pid),
      ], childEnv, (line) => {
        if (line.includes('Bootstrapped 100')) bootstrapped = true;
      }, onChildExit);
      recordAndStart(tor);
      if (!await waitFor(() => bootstrapped, settings.torBootstrapTimeoutMs, { signal: sessionSignal, giveUp: anyExited })) {
        return (result = fail(sessionSignal.aborted ? interrupted() : 'tor_bootstrap_failed'));
      }
      receipt.freshTorClient = true;
    }

    const facts: DaemonFacts = { requests: new Map(), settled: new Map() };
    const daemonArgv = [daemonExecutable, 'serve'];
    stage('daemonReadyMs');
    daemon = supervise(
      'daemon',
      watchdog,
      perConsultTor ? confinement.wrap(daemonArgv, { tor: settings.torSocksPort, daemon: daemonPort }) : daemonArgv,
      daemonEnvironment(childEnv, daemonExecutable),
      (line) => parseDaemonLine(facts, line),
      onChildExit,
    );
    recordAndStart(daemon);

    // Every port of this session must be held by the process group Olympus
    // started; checked again immediately before anything carries the key.
    const daemonGone = (): boolean => daemon!.leaderExited || daemon!.childExited;
    const owned = async (includeTor = true): Promise<boolean> => {
      if (includeTor ? anyExited() : daemonGone()) return false;
      const listener = await inspect(daemonPort);
      if (listener.kind !== 'found' || listener.pgid !== daemon!.pgid) return false;
      if (tor && includeTor) {
        const socks = await inspect(settings.torSocksPort);
        if (socks.kind !== 'found' || socks.pgid !== tor.pgid) return false;
      }
      return includeTor ? !anyExited() : !daemonGone();
    };
    const guard = async (): Promise<ZkapiConsultErrorCode | undefined> => {
      if (sessionSignal.aborted) return interrupted();
      if (anyExited()) return 'session_process_exited';
      if (await owned()) return undefined;
      // A port can close a moment before its process's exit is reported.
      await sleep(300);
      return anyExited() ? 'session_process_exited' : 'daemon_identity_failed';
    };

    const ready = await waitFor(
      async (remainingMs) => Boolean(facts.listen)
        && healthFingerprint(await probeRequest(fetchImpl, `${origin}/healthz`, { method: 'GET' }, sessionSignal, Math.min(2_000, remainingMs))),
      settings.daemonReadyTimeoutMs,
      { signal: sessionSignal, giveUp: anyExited, pollMs: 250 },
    );
    if (!ready) return (result = fail(sessionSignal.aborted ? interrupted() : 'daemon_start_failed'));
    stage('daemonVerifyMs');
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
    const unauthenticated = await probeRequest(fetchImpl, `${origin}/v1/models`, { method: 'POST' }, sessionSignal);
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
    const status = await probeRequest(fetchImpl, `${origin}/admin/status`, { method: 'GET', headers: authorization }, sessionSignal);
    if (sessionSignal.aborted) return (result = fail(interrupted()));
    if (!status || status.status === 401) return (result = fail('daemon_api_key_rejected'));
    const network = adminStatusNetwork(status);
    if (!network) return (result = fail('daemon_identity_failed'));
    receipt.inferenceAuth = 'verified';
    receipt.network = network;

    // zkapi-tor-cli.sh `warm_policy`: poll the model list until the reviewed
    // policy has loaded. Listing is catalog membership, not a test request.
    let listing: { listed: boolean; allowance?: number } = { listed: false };
    let guardProblem: ZkapiConsultErrorCode | undefined;
    stage('policyWarmMs');
    await waitFor(async (remainingMs) => {
      guardProblem = await guard();
      if (guardProblem) return true;
      const models = await probeRequest(fetchImpl, `${origin}/v1/models`, { method: 'GET', headers: authorization }, sessionSignal, Math.min(MODELS_PROBE_TIMEOUT_MS, remainingMs));
      if (models?.status !== 200) return false;
      listing = modelListing(models.body, options.model);
      return listing.listed;
    }, settings.policyWarmTimeoutMs, { signal: sessionSignal, giveUp: anyExited, pollMs: POLICY_POLL_MS });
    if (guardProblem) return (result = fail(guardProblem));
    if (!listing.listed) return (result = fail(sessionSignal.aborted ? interrupted() : 'policy_unavailable'));
    if (listing.allowance === undefined) return (result = fail('model_unavailable'));
    // What the daemon holds for this model; never more than the reviewed ceiling.
    const allowanceMicroUsd = Math.min(listing.allowance, ZKAPI_MAX_ALLOWANCE_MICRO_USD);
    receipt.listedAllowanceUsd = listing.allowance / 1_000_000;

    // --- Ready: the route is warm and nothing is reserved. Wait for the
    // question; a cancellation or a process exit ends the wait.
    stage(undefined);
    timings = withTiming(timings, 'warmTotalMs', durationMs(startedAt, lastSampleAt));
    bridge.state = 'ready';
    bridge.ready.resolve();
    const aborted = new Promise<undefined>((resolve) => {
      if (sessionSignal.aborted) resolve(undefined);
      else sessionSignal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    // A ready session nobody sends on ends itself: the lease and the warm
    // processes are not held open indefinitely.
    const readyTimer = setTimeout(() => cancelBeforeDispatch('deadline'), bridge.readyTimeoutMs);
    const dispatch = await Promise.race([bridge.dispatch.promise, aborted]);
    clearTimeout(readyTimer);
    if (!dispatch || sessionSignal.aborted) return (result = fail(interrupted()));

    // --- Dispatch. Step 1: the transport's awaited checks. Step 2: the
    // caller's final authorization, raced against cancellation and the send
    // deadline. Step 3: the reservation, the fence and the start of the
    // fetch, with no await between them. The request is prepared before any
    // of it, so nothing after the reservation can fail before the fetch is
    // invoked except the deadline check, which rolls the reservation back.
    stage('reservationMs');
    const prepared = prepareCompletionRequest(dispatch.question, options, origin);
    sendSignal = dispatch.signal;
    sendSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (sendSignal?.aborted) cancelBeforeDispatch('cancel');
    // The deadline is absolute and monotonic, captured inside `send`: checked
    // after authorization and again immediately before the fetch is invoked,
    // whatever the timer did.
    const deadlineAt = dispatch.deadlineAt;
    const pastDeadline = (): boolean => deadlineAt !== undefined && performance.now() >= deadlineAt;
    if (pastDeadline()) return (result = fail('timeout'));
    if (deadlineAt !== undefined) sendDeadline = setTimeout(() => cancelBeforeDispatch('deadline'), Math.max(0, deadlineAt - performance.now()));
    problem = await guard();
    if (problem) return (result = fail(problem));
    let authorized = true;
    if (dispatch.authorize) {
      // A hung authorization never holds the session: cancellation and the
      // deadline win the race; a late answer or rejection is consumed and
      // never dispatches.
      let pending: Promise<boolean>;
      try {
        pending = Promise.resolve(dispatch.authorize(sessionSignal));
      } catch {
        return (result = fail('internal_error'));
      }
      const settled = await Promise.race([
        pending.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const })),
        aborted.then(() => undefined),
      ]);
      if (settled === undefined) {
        pending.catch(() => undefined);
        return (result = fail(interrupted()));
      }
      if (!settled.ok) return (result = fail('internal_error'));
      authorized = settled.value;
    }
    if (sessionSignal.aborted) return (result = fail(interrupted()));
    if (pastDeadline()) return (result = fail('timeout'));
    if (!authorized) return (result = fail('authorization_refused'));
    if (anyExited()) return (result = fail('session_process_exited'));
    clearTimeout(sendDeadline);

    let reservation: ReturnType<typeof reserveZkapiRequest>;
    try {
      reservation = reserveZkapiRequest(statePath, ownerLimits(settings), now(), {
        scope,
        configDir: zkapiWalletDirectory(env),
        daemonExecutable,
        daemonPort,
      }, allowanceMicroUsd);
    } catch {
      return (result = fail('state_unavailable'));
    }
    if (!reservation.reserved) return (result = fail(reservation.reason));
    receipt.reservedUsd = allowanceMicroUsd / 1_000_000;
    receipt.fence = 'held';
    const requestsBefore = new Set(facts.requests.keys());
    sent.dispatched = true;
    bridge.state = 'dispatched';
    // From here the caller's signals only end its wait for the reply, and
    // every failure of the fetch, however it fails, is an unknown dispatch:
    // the fence clears only on settlement evidence. The one exception is the
    // deadline check sendCompletion makes immediately before invoking fetch.
    detachCaller = () => bridge.reply.resolve({ kind: 'failed', error: failure('aborted', 'unknown', identity(), { receipt: pendingSnapshot() }).error });
    const completion = await sendCompletion(prepared, options, sessionSignal, stage, pastDeadline);

    if (!completion.ok && completion.error.outcome === 'not_sent') {
      // The deadline passed between the reservation and the fetch (the
      // reservation or the stage clock consumed the remaining time). The fetch
      // is provably not invoked, so this is the one rollback: reservation,
      // count and fence return to what they were, recorded as a lifecycle
      // receipt. If the ledger cannot be written the reservation stands.
      sent.dispatched = false;
      detachCaller = undefined;
      try {
        releaseZkapiReservation(statePath, scope, fences[scope], now(), allowanceMicroUsd);
        delete receipt.reservedUsd;
        receipt.fence = fenced || fencedElsewhere ? 'held' : 'clear';
      } catch {
        // stays reserved and held
      }
      return (result = fail(completion.error.code));
    }

    // --- Replied: hand the completion over before settlement.
    if (completion.ok) timings = withTiming(timings, 'replyHandedOverAtMs', durationMs(startedAt, lastSampleAt));
    bridge.state = 'replied';
    bridge.reply.resolve(completion.ok
      ? {
        kind: 'reply',
        text: completion.text,
        routeLabel: zkapiRouteLabel(pendingSnapshot()),
        networkIdentity: identity(),
        receipt: pendingSnapshot(),
        ...(completion.providerVerification ? { providerVerification: completion.providerVerification } : {}),
        elapsedMs: completion.elapsedMs,
      }
      : {
        kind: 'failed',
        error: failure(completion.error.code, completion.error.outcome, identity(), {
          ...(completion.error.daemonCode ? { daemonCode: completion.error.daemonCode } : {}),
          ...(completion.error.httpStatus ? { httpStatus: completion.error.httpStatus } : {}),
          receipt: pendingSnapshot(),
        }).error,
      });

    // Correlate this request's own log lines, then wait for its key to settle.
    // Runs to completion whatever the caller did; stops if a process died.
    stage('correlationWaitMs');
    const correlated = await waitFor(() => {
      const ours = [...facts.requests.entries()].filter(([id, request]) => !requestsBefore.has(id) && request.route === '/v1/chat/completions');
      return ours.length === 1 && ours[0]![1].finished !== undefined;
    }, settings.settleTimeoutMs, { giveUp: unexpectedExit });
    const ours = [...facts.requests.entries()].filter(([id, request]) => !requestsBefore.has(id) && request.route === '/v1/chat/completions');
    const request = correlated && ours.length === 1 ? ours[0]![1] : undefined;
    if (request && request.keys.some((key) => key.source !== 'fresh')) receipt.keyReuse = 'not_verified';
    const keyRef = request?.keys.length === 1 ? request.keys[0]!.keyRef : undefined;
    let fenceClears = false;
    if (keyRef !== undefined) {
      stage('settlementWaitMs');
      receipt.settlement = await waitFor(
        () => facts.settled.get(keyRef) === true,
        settings.settleTimeoutMs,
        { giveUp: unexpectedExit },
      ) ? 'confirmed' : 'not_confirmed';
      fenceClears = receipt.settlement === 'confirmed' && request!.keys[0]!.source === 'fresh';
    } else {
      // No key for this request: only a refusal the daemon makes before any
      // lease request (model validation) proves nothing was issued, and only
      // in an ordinary session. A recovery session exists to settle an earlier
      // lease, which the daemon attempts only after that same model check, so
      // a refusal there proves nothing about the earlier lease.
      const preLease = !recovery && request !== undefined && request.keys.length === 0 && request.finished?.status === 400
        && !completion.ok && (completion.error.daemonCode === 'invalid_model' || completion.error.daemonCode === 'model_budget_unavailable');
      receipt.settlement = preLease ? 'no_lease' : 'not_confirmed';
      fenceClears = preLease;
    }
    stage(undefined);
    if (fenceClears) {
      try {
        updateState(statePath, now(), (state) => {
          const { [scope]: _cleared, ...others } = state.fences ?? {};
          const { fences: _all, ...rest } = state;
          return Object.keys(others).length > 0 ? { ...rest, fences: others } : rest;
        });
        receipt.fence = 'clear';
      } catch {
        // stays held
      }
    }

    if (perConsultTor && !unexpectedExit()) {
      tor!.deliberate = true;
      stage('torStopMs');
      const torStopped = await stopOwned(tor!);
      stage(undefined);
      // Secondary signal only. With Tor gone the model list must fail with the
      // daemon's exact upstream-unavailable shape; a 200 is a bypass.
      let after: ProbeResponse | undefined;
      if (torStopped && !daemonGone() && await owned(false)) {
        stage('postStopProbeMs');
        after = await probeRequest(fetchImpl, `${origin}/v1/models`, { method: 'GET', headers: authorization }, undefined, MODELS_PROBE_TIMEOUT_MS);
        stage(undefined);
      }
      receipt.postStopProbe = after?.status === 200
        ? 'still_reachable'
        : after?.status === 502 && daemonErrorEnvelope(after.body) === 'models_unavailable'
          ? 'route_lost'
          : 'inconclusive';
    }

    if (unexpectedExit()) return (result = fail('session_process_exited'));
    if (!completion.ok) {
      result = failure(completion.error.code, completion.error.outcome, identity(), {
        ...(completion.error.daemonCode ? { daemonCode: completion.error.daemonCode } : {}),
        ...(completion.error.httpStatus ? { httpStatus: completion.error.httpStatus } : {}),
        receipt: snapshot(),
      });
      return result;
    }
    result = {
      ok: true,
      text: completion.text,
      routeLabel: zkapiRouteLabel(receipt),
      networkIdentity: identity(),
      receipt: snapshot(),
      ...(completion.providerVerification ? { providerVerification: completion.providerVerification } : {}),
      elapsedMs: completion.elapsedMs,
    };
    return result;
  } catch {
    return (result = fail('internal_error'));
  }
  })();
  // Cleanup runs after the outcome is known, and can still change it: a
  // session whose processes cannot be confirmed stopped is not a success.
  // Each step on its own: one failure never skips the next.
  clearTimeout(sendDeadline);
  cleanupCallerSignals();
  // Closes a stage the session ended in, and starts timing teardown.
  stage('teardownMs');
  let allStopped = true;
  for (const group of [...groups].reverse()) {
    group.deliberate = true;
    try {
      if (!await stopOwned(group)) allStopped = false;
    } catch {
      allStopped = false;
    }
  }
  if (allStopped) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // a leftover private temp directory holds no secret
    }
  } else {
    result = fail('teardown_incomplete');
  }
  stage(undefined);
  timings = withTiming(timings, 'totalMs', elapsedMs(clock, startedAt));
  const final = result;
  // The returned receipt and the ledger's last session carry every stage,
  // teardown and total included.
  const finalReceipt = final.ok ? final.receipt : final.error.receipt;
  if (finalReceipt && Object.keys(timings).length > 0) finalReceipt.stageMs = { ...timings };
  try {
    updateState(statePath, now(), (state) => {
      const { running, ...rest } = state;
      return {
        ...rest,
        ...(allStopped ? {} : running ? { running } : {}),
        lastSession: { ...snapshot(), at: now().toISOString(), result: final.ok ? 'ok' : final.error.code },
      };
    });
  } catch {
    // The ledger stays as last written; the next session refuses if it is unreadable.
  }
  return final;
}

/**
 * Undo one reservation made moments ago under the session lease, only while
 * the fetch is provably not yet invoked (the dispatch deadline passed during
 * the reservation). The fence returns to what it was before the reservation:
 * absent for a consult, the earlier record for a recovery session. Never
 * applied once `fetchImpl` has been called, however it failed.
 */
function releaseZkapiReservation(path: string, scope: string, earlierFence: ZkapiFence | undefined, now: Date, allowanceMicroUsd: number): void {
  updateState(path, now, (state) => {
    const { [scope]: _ours, ...others } = state.fences ?? {};
    const fences = earlierFence ? { ...others, [scope]: earlierFence } : others;
    const { fences: _all, ...rest } = state;
    return {
      ...rest,
      count: Math.max(0, state.count - 1),
      reservedMicroUsd: Math.max(0, state.reservedMicroUsd - allowanceMicroUsd),
      ...(Object.keys(fences).length > 0 ? { fences } : {}),
    };
  });
}

/** One clock sample, or undefined when the clock throws or returns a non-finite value. */
function sampleClock(clock: () => number): number | undefined {
  try {
    const value = clock();
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function durationMs(from: number | undefined, to: number | undefined): number | undefined {
  if (from === undefined || to === undefined) return undefined;
  const ms = Math.round(to - from);
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

function elapsedMs(clock: () => number, since: number | undefined): number | undefined {
  return since === undefined ? undefined : durationMs(since, sampleClock(clock));
}

/** Timings with `key` set to `ms`, or unchanged when the measurement is missing. */
function withTiming(timings: ZkapiStageTimings, key: keyof ZkapiStageTimings, ms: number | undefined): ZkapiStageTimings {
  return ms === undefined ? timings : { ...timings, [key]: ms };
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

interface PreparedCompletionRequest {
  url: string;
  init: Omit<RequestInit, 'signal'>;
}

/**
 * The fixed request body, built in full before the reservation so that
 * nothing between the reservation and the fetch can fail. The only inputs
 * are the question and the model id.
 */
function prepareCompletionRequest(question: string, options: ZkapiConsultTransportOptions, origin: string): PreparedCompletionRequest {
  return {
    url: `${origin}/v1/chat/completions`,
    init: {
      method: 'POST',
      redirect: 'error',
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
    },
  };
}

async function sendCompletion(
  prepared: PreparedCompletionRequest,
  options: ZkapiConsultTransportOptions,
  signal: AbortSignal | undefined,
  stage: (key: keyof ZkapiStageTimings | undefined) => void,
  /** Checked immediately before fetch is invoked; true refuses with `timeout`, outcome `not_sent`. */
  pastDeadline: () => boolean = () => false,
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
    stage('dispatchToFirstByteMs');
    // The last instant at which nothing has been sent.
    if (pastDeadline()) return bad('timeout', 'not_sent');
    try {
      // Once fetchImpl is invoked, any exception, synchronous or not, is an
      // unknown dispatch: an injected fetch may have sent before throwing.
      response = await fetchImpl(prepared.url, { ...prepared.init, signal: controller.signal });
    } catch (error) {
      if (timedOut) return bad('timeout', 'unknown');
      if (controller.signal.aborted) return bad('aborted', 'unknown');
      if (isRedirectError(error)) return bad('redirect_refused', 'unknown');
      return bad('transport_failed', 'unknown');
    }
    stage('firstByteToCompletionMs');
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return bad('redirect_refused', 'unknown', { httpStatus: response.status });
    }
    const body = await readBounded(response, settings.maxResponseBytes).catch(() => undefined);
    stage(undefined);
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

/** Whether a string may be sent as a consult question: non-empty, at most 8 KiB, plain text. */
export function validZkapiConsultQuestion(question: string): boolean {
  return typeof question === 'string' && validQuestion(question);
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

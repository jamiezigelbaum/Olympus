import { mkdirSync, readFileSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from '../core/atomic-file.ts';
import {
  defaultHandleRegistryPath,
  readConnectedHandleRegistry,
  type ConnectedCredentialHandle,
} from './credential-broker/connected-handles.ts';
import {
  CredentialBrokerError,
  createEnvCredentialBroker,
  isCredentialProvider,
  requireBearerTokenCredentialSession,
  SERVICE_ACCOUNT_CREDENTIAL_HANDLES,
  type CredentialSession,
  type CredentialSessionRequest,
} from './credential-broker/index.ts';
import type { WorkerCredentialDegradation } from './credential-degradation.ts';

const SAFE_ID = /^[a-zA-Z0-9._:-]{1,160}$/;
const READWISE_AUTH_URL = 'https://readwise.io/api/v2/auth/';
const VENICE_MODELS_URL = 'https://api.venice.ai/api/v1/models';

/**
 * Providers whose refresh token is spent by the act of using it. Naming the
 * provider is one signal of three; see `isRotatingCredentialShape`.
 */
const ROTATING_PROVIDERS: ReadonlySet<string> = new Set(['x']);
const ROTATING_CAPABILITY_NAMESPACES: readonly string[] = ['x'];
const ROTATING_TOKEN_HOSTS: readonly string[] = ['x.com', 'twitter.com'];

/**
 * The runtime wrapper declares the outcome of every cache-only 1Password read
 * it performs, alongside the value that read produced. Both halves are read
 * positively: only a declared success carrying a credential proves anything,
 * and everything else -- an absent channel, a status this code does not know,
 * or a status the value contradicts -- is a read this process cannot speak for.
 *
 * The vocabulary is three closed words. `cached` is a credential; `absent` is
 * 1Password's own answer that the item does not exist; `unavailable` is a read
 * that proved nothing. Only `absent` may be treated as a missing credential.
 */
interface SecretReadSlot {
  statusEnvName: string;
  valueEnvName: string;
}

const SECRET_READ_STATUS_CACHED = 'cached';
const SECRET_READ_STATUS_ABSENT = 'absent';
const SECRET_READ_STATUS_UNAVAILABLE = 'unavailable';

const GOOGLE_SECRET_READ_SLOT: SecretReadSlot = {
  statusEnvName: 'OLYMPUS_CREDENTIAL_HEALTH_SECRET_READ_GOOGLE',
  valueEnvName: 'OLYMPUS_CREDENTIAL_GOOGLE_OLYMPUS_SERVICE_ACCOUNT_JSON',
};

const SECRET_READ_SLOTS: Readonly<Record<string, SecretReadSlot>> = {
  gmail: GOOGLE_SECRET_READ_SLOT,
  google_drive: GOOGLE_SECRET_READ_SLOT,
  google_calendar: GOOGLE_SECRET_READ_SLOT,
  readwise: {
    statusEnvName: 'OLYMPUS_CREDENTIAL_HEALTH_SECRET_READ_READWISE',
    valueEnvName: 'OLYMPUS_CREDENTIAL_READWISE_PERSONAL_TOKEN',
  },
  venice: {
    statusEnvName: 'OLYMPUS_CREDENTIAL_HEALTH_SECRET_READ_VENICE',
    valueEnvName: 'OLYMPUS_CREDENTIAL_HEALTH_VENICE_API_KEY',
  },
};

const CREDENTIAL_CACHE_UNAVAILABLE_REASON = 'credential_cache_unavailable';
const CREDENTIAL_READ_PROTOCOL_ERROR_REASON = 'credential_read_protocol_error';
const CREDENTIAL_MISSING_REASON = 'credential_missing';
const CREDENTIAL_NOT_CONFIGURED_REASON = 'not_configured';

/**
 * How old the newest proof that a handle still works may be before the passive
 * probe calls it stale. Dropbox died inside a seven-day window in which its
 * lane happened not to be scheduled; every live lane mints far more often than
 * this, so three days is quiet in normal operation and still closes that hole
 * days before the credential's next scheduled use would have found it.
 */
const PASSIVE_EVIDENCE_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/**
 * The probe runs daily at 00:20. A report older than one cadence plus a few
 * hours of boot/catch-up slack means the probe itself stopped running, which is
 * the silent-monitor failure this alarm exists to prevent.
 */
export const CREDENTIAL_HEALTH_REPORT_MAX_AGE_MS = 28 * 60 * 60 * 1000;

/**
 * How far ahead of the reading host's clock a report may be stamped. A report
 * from the future has a negative age, and a one-sided freshness test would
 * hold it fresh forever -- a stopped probe plus a clock fault is exactly the
 * silent monitor this alarm exists to remove.
 */
export const CREDENTIAL_HEALTH_MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

/**
 * A freshly booted host has not necessarily run the daily probe yet. The probe
 * timer fires 20 minutes after boot, so two alarm cycles is generous. Boot time
 * is the anchor because nothing on disk can rewind it: deleting the report
 * cannot buy a second grace window.
 */
const CREDENTIAL_HEALTH_BOOTSTRAP_GRACE_MS = 2 * 60 * 60 * 1000;

export type CredentialHealthStatus =
  | 'healthy'
  | 'reauth_required'
  | 'missing'
  | 'degraded'
  | 'skipped';

export type CredentialHealthType =
  | 'oauth2_refresh'
  | 'rotating_oauth2_refresh'
  | 'service_account_jwt'
  | 'static_api_key'
  | 'non_refreshable_session';

/**
 * `active` means the probe asked the credential to do something. Only classes
 * proven to consume nothing may be active; everything else is judged from
 * durable evidence the broker already wrote.
 */
export type CredentialProbeMode = 'active' | 'passive';

export interface CredentialHealthResult {
  handle: string;
  provider: string;
  source_ids: string[];
  credential_type: CredentialHealthType;
  status: CredentialHealthStatus;
  checked_at: string;
  probe_mode?: CredentialProbeMode;
  reason?: string;
}

export interface CredentialHealthReport {
  kind: 'credential_health_report';
  version: 1;
  generated_at: string;
  results: CredentialHealthResult[];
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    secrets_exposed: false;
    x_refresh_forced: false;
    op_cached_read_only: true;
  };
}

export interface CredentialHealthProbeBroker {
  issueSession(request: CredentialSessionRequest): Promise<CredentialSession>;
}

export interface CredentialHealthAlarmResult {
  exitCode: 0 | 1 | 2;
  lines: string[];
}

/**
 * What the probe is allowed to do with a credential, decided from the
 * credential's own shape rather than from a display label.
 */
type CredentialProbeClass =
  | 'rotating_refresh_token'
  | 'reissuable_assertion'
  | 'static_bearer'
  | 'unprovable_secret_read'
  | 'unclassified';

type SecretRead =
  | { kind: 'usable'; value: string }
  | { kind: 'absent' }
  | { kind: 'unusable'; reason: string };

interface BrokerHandleState {
  status?: 'available' | 'reauth_required';
  updatedAt?: string;
  pendingRefreshStartedAt?: string;
}

type BrokerStateRead =
  | { kind: 'ok'; handles: Map<string, BrokerHandleState> }
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'partial' };

type AlarmFinding = { handle: string; status: string; source: string };
type AlarmSurfaceState = 'missing' | 'unreadable' | 'partial' | 'stale' | 'not_configured' | 'bootstrap_pending';
type AlarmSurfaceNote = { surface: 'registry' | 'broker_state' | 'probe_report'; state: AlarmSurfaceState };

export function defaultCredentialHealthReportPath(): string {
  return join(homedir(), '.local', 'state', 'olympus', 'credential-health', 'current.json');
}

export function defaultCredentialBrokerStatePath(): string {
  return join(homedir(), '.local', 'share', 'openclaw', 'olympus', 'credential-broker-state.json');
}

export function readCredentialHealthReport(path: string = defaultCredentialHealthReportPath()): CredentialHealthReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  return normalizeCredentialHealthReport(parsed);
}

export function credentialHealthReportIsStale(report: CredentialHealthReport, now: Date): boolean {
  const age = now.getTime() - Date.parse(report.generated_at);
  return age > CREDENTIAL_HEALTH_REPORT_MAX_AGE_MS || age < -CREDENTIAL_HEALTH_MAX_FUTURE_SKEW_MS;
}

export async function runCredentialHealthProbe(options: {
  env?: Record<string, string | undefined>;
  registryPath?: string;
  brokerStatePath?: string;
  reportPath?: string;
  broker?: CredentialHealthProbeBroker;
  fetchImpl?: typeof fetch;
  now?: () => Date;
} = {}): Promise<{ report: CredentialHealthReport; exitCode: 0 | 1 }> {
  const env = options.env ?? process.env;
  const now = validNow(options.now?.() ?? new Date());
  const checkedAt = now.toISOString();
  const registryPath = options.registryPath ?? env.OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH?.trim()
    ?? defaultHandleRegistryPath();
  const brokerStatePath = options.brokerStatePath ?? env.OLYMPUS_CREDENTIAL_BROKER_STATE_PATH?.trim()
    ?? defaultCredentialBrokerStatePath();
  const reportPath = options.reportPath ?? env.OLYMPUS_CREDENTIAL_HEALTH_REPORT_PATH?.trim()
    ?? defaultCredentialHealthReportPath();
  const registry = readConnectedHandleRegistry(registryPath);
  const fetchImpl = options.fetchImpl ?? fetch;
  const broker = options.broker ?? createEnvCredentialBroker({
    env,
    handleRegistryPath: registryPath,
    loadDefaultHandleRegistry: false,
    fetch: fetchImpl,
  });
  const brokerState = readCredentialBrokerState(brokerStatePath);
  const results: CredentialHealthResult[] = [];

  for (const handle of registry.handles) {
    results.push(await probeConnectedHandle(handle, { env, broker, fetchImpl, brokerState, checkedAt, now }));
  }
  results.push(await probeVeniceApiKey({ env, fetchImpl, checkedAt }));

  const report: CredentialHealthReport = {
    kind: 'credential_health_report',
    version: 1,
    generated_at: checkedAt,
    results,
    policy: credentialHealthPolicy(),
  };
  writeCredentialHealthReport(reportPath, report);
  return {
    report,
    exitCode: results.some((result) =>
      result.status === 'reauth_required' || result.status === 'missing' || result.status === 'degraded') ? 1 : 0,
  };
}

export function runCredentialHealthAlarm(options: {
  registryPath?: string;
  brokerStatePath?: string;
  reportPath?: string;
  now?: () => Date;
  bootedAt?: Date;
} = {}): CredentialHealthAlarmResult {
  const registryPath = options.registryPath ?? defaultHandleRegistryPath();
  const brokerStatePath = options.brokerStatePath ?? defaultCredentialBrokerStatePath();
  const reportPath = options.reportPath ?? defaultCredentialHealthReportPath();
  const now = validNow(options.now?.() ?? new Date());
  const bootedAt = options.bootedAt ?? new Date(now.getTime() - uptime() * 1000);
  try {
    const findings = new Map<string, AlarmFinding>();
    const notes: AlarmSurfaceNote[] = [];

    // The daily report is the inventory: it is what says which surfaces this
    // installation actually uses. Without it the alarm cannot tell an
    // unconfigured host from a broken one, so it is required first.
    const report = readProbeReportSurface(reportPath, now, bootedAt, notes);
    for (const finding of probeReportFindings(report)) addFinding(findings, finding);

    const registry = readRegistrySurface(registryPath);
    if (registry.kind === 'ok') {
      for (const finding of registry.findings) addFinding(findings, finding);
    } else if (registry.kind === 'missing' && !reportExpectsSurface(report, 'registry')) {
      notes.push({ surface: 'registry', state: 'not_configured' });
    } else {
      notes.push({ surface: 'registry', state: registry.kind === 'missing' ? 'missing' : 'unreadable' });
    }

    const state = readCredentialBrokerState(brokerStatePath);
    if (state.kind === 'ok') {
      for (const finding of brokerStateFindings(state)) addFinding(findings, finding);
    } else if (state.kind === 'missing' && !reportExpectsSurface(report, 'broker_state')) {
      notes.push({ surface: 'broker_state', state: 'not_configured' });
    } else {
      notes.push({
        surface: 'broker_state',
        state: state.kind === 'missing' ? 'missing'
          : state.kind === 'partial' ? 'partial' : 'unreadable',
      });
    }

    const ordered = [...findings.values()].sort((left, right) =>
      left.handle.localeCompare(right.handle) || left.source.localeCompare(right.source));
    const lines = ordered.map((finding) =>
      `credential-health-alarm: handle=${finding.handle} status=${finding.status} source=${finding.source}`);
    for (const note of notes) {
      lines.push(`credential-health-alarm: surface=${note.surface} state=${note.state}`);
    }
    const affectedHandles = new Set(ordered.map((finding) => finding.handle)).size;
    const unreadable = notes.some((note) => note.state !== 'not_configured' && note.state !== 'bootstrap_pending');
    const alarmState = unreadable ? 'error' : ordered.length > 0 ? 'attention' : 'healthy';
    lines.push(`credential-health-alarm: state=${alarmState} affected_handles=${affectedHandles}`);
    return { exitCode: unreadable ? 2 : ordered.length > 0 ? 1 : 0, lines };
  } catch {
    return {
      exitCode: 2,
      lines: ['credential-health-alarm: state=error reason=credential_state_unreadable'],
    };
  }
}

export function credentialHealthDegradations(
  report: CredentialHealthReport | undefined,
  now: Date = new Date(),
): WorkerCredentialDegradation[] {
  if (!report) return [];
  // A report the probe stopped refreshing describes a world that may already
  // have been repaired. Say the check is stale rather than keep paging its
  // findings as if they were current.
  if (credentialHealthReportIsStale(report, now)) {
    return [{
      kind: 'worker_credential_degraded',
      display_name: 'Credential health: stale probe report',
      state: 'retrying',
      status_label: 'Credential unavailable - needs your attention',
      hint: 'The daily credential health probe has not reported recently, so connection state may be out of date. Inspect the credential-health probe service.',
      attempts: 1,
      max_attempts: 1,
    }];
  }
  return report.results
    .filter((result) => result.status === 'reauth_required'
      || result.status === 'missing'
      || result.status === 'degraded')
    .map((result): WorkerCredentialDegradation => ({
      kind: 'worker_credential_degraded',
      display_name: `Credential health: ${result.handle}`,
      state: result.status === 'degraded' ? 'retrying' : 'stopped',
      status_label: 'Credential unavailable - needs your attention',
      hint: result.status === 'degraded'
        ? 'The proactive credential check could not confirm this connection. Inspect the credential-health service and retry.'
        : 'Reconnect or restore this credential, then rerun the credential-health probe.',
      attempts: 1,
      max_attempts: 1,
      ...(result.source_ids.length > 0 ? { affected_profiles: [...result.source_ids] } : {}),
    }));
}

function addFinding(findings: Map<string, AlarmFinding>, finding: AlarmFinding): void {
  findings.set(`${finding.handle}\0${finding.status}\0${finding.source}`, finding);
}

/**
 * Decide what may be done with a credential from its own shape.
 *
 * The rotating test is deliberately over-inclusive and reads three independent
 * signals. A registration is X-shaped if its provider says so, if any capability
 * sits in X's namespace, or if its token endpoint is X's -- renaming the handle
 * or drifting the provider label cannot clear all three, and the drifted label
 * is refused by the registry parser before it ever reaches here.
 */
function classifyCredentialProbe(handle: ConnectedCredentialHandle): CredentialProbeClass {
  if (isRotatingCredentialShape(handle)) return 'rotating_refresh_token';
  const active = activeProbeShape(handle);
  if (!active) return 'unclassified';
  // An active class is a claim that this process can say what the wrapper read
  // for the provider. A provider with no slot has nothing to say it with, so it
  // degrades here rather than falling through to a mint or a GET.
  return SECRET_READ_SLOTS[handle.provider] ? active : 'unprovable_secret_read';
}

function activeProbeShape(handle: ConnectedCredentialHandle): 'reissuable_assertion' | 'static_bearer' | undefined {
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  // A delegated service-account handle signs a fresh JWT assertion per mint;
  // nothing is consumed and no stored token is replaced. The repo-owned key
  // definition is required: a delegated *name* alone proves nothing.
  // The public runtime has no service-account lane and an empty handle set, so
  // this branch is excluded with the predicate it calls.
  if (isDelegatedGoogleHandle(handle) && !handle.oauth2Refresh
    && SERVICE_ACCOUNT_CREDENTIAL_HANDLES.has(handle.handle)) return 'reissuable_assertion';
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
  // Readwise is a long-lived static token checked against an auth-only GET.
  if (handle.provider === 'readwise' && !handle.oauth2Refresh) return 'static_bearer';
  return undefined;
}

/**
 * Read the wrapper's declaration for one provider's cache-only read. Active
 * probing is authorized by proof, never by the absence of a denial: no slot, no
 * status, an unknown status, and a status its own value contradicts are all
 * unusable, and none of them is evidence that a credential is gone.
 *
 * The status is compared as written. Trimming it first would make ` cached ` a
 * synonym for `cached`, which is a wider vocabulary than the wrapper speaks and
 * exactly the skew this boundary exists to refuse; only the value is trimmed.
 */
function readWrapperSecret(env: Record<string, string | undefined>, provider: string): SecretRead {
  const slot = SECRET_READ_SLOTS[provider];
  if (!slot) return { kind: 'unusable', reason: CREDENTIAL_READ_PROTOCOL_ERROR_REASON };
  const status = env[slot.statusEnvName];
  const value = env[slot.valueEnvName]?.trim() ?? '';
  if (status === SECRET_READ_STATUS_CACHED && value !== '') return { kind: 'usable', value };
  if (status === SECRET_READ_STATUS_ABSENT && value === '') return { kind: 'absent' };
  if (status === SECRET_READ_STATUS_UNAVAILABLE && value === '') {
    return { kind: 'unusable', reason: CREDENTIAL_CACHE_UNAVAILABLE_REASON };
  }
  return { kind: 'unusable', reason: CREDENTIAL_READ_PROTOCOL_ERROR_REASON };
}

function isRotatingCredentialShape(handle: ConnectedCredentialHandle): boolean {
  if (ROTATING_PROVIDERS.has(handle.provider)) return true;
  if (inNamespace(handle.handle, ROTATING_CAPABILITY_NAMESPACES)) return true;
  if (handle.allowedCapabilities.some((capability) => inNamespace(capability, ROTATING_CAPABILITY_NAMESPACES))) {
    return true;
  }
  return isRotatingTokenEndpoint(handle.oauth2Refresh?.tokenUrl);
}

function inNamespace(value: string, namespaces: readonly string[]): boolean {
  return namespaces.some((namespace) => value === namespace || value.startsWith(`${namespace}.`));
}

function isRotatingTokenEndpoint(tokenUrl: string | undefined): boolean {
  if (!tokenUrl) return false;
  let host: string;
  try {
    host = new URL(tokenUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ROTATING_TOKEN_HOSTS.some((rotating) => host === rotating || host.endsWith(`.${rotating}`));
}

async function probeConnectedHandle(
  handle: ConnectedCredentialHandle,
  options: {
    env: Record<string, string | undefined>;
    broker: CredentialHealthProbeBroker;
    fetchImpl: typeof fetch;
    brokerState: BrokerStateRead;
    checkedAt: string;
    now: Date;
  },
): Promise<CredentialHealthResult> {
  const sourceIds = sourceIdsForProvider(handle.provider);
  const type = credentialType(handle);
  if (handle.backendState?.status === 'reauth_required') {
    return healthResult(handle, sourceIds, type, 'reauth_required', options.checkedAt, 'passive', 'credential_reauth_required');
  }

  const probeClass = classifyCredentialProbe(handle);
  const capability = handle.allowedCapabilities[0];
  if (probeClass === 'unprovable_secret_read') {
    return healthResult(handle, sourceIds, type, 'degraded', options.checkedAt, 'passive', CREDENTIAL_READ_PROTOCOL_ERROR_REASON);
  }
  if (probeClass === 'static_bearer' || probeClass === 'reissuable_assertion') {
    if (!capability) {
      return healthResult(handle, sourceIds, type, 'missing', options.checkedAt, 'passive', 'registration_missing');
    }
    const secretRead = readWrapperSecret(options.env, handle.provider);
    // A connected registration is this host's own declaration that it needs the
    // credential, so 1Password proving the item gone is a missing credential
    // rather than one more thing to retry.
    if (secretRead.kind === 'absent') {
      return healthResult(handle, sourceIds, type, 'missing', options.checkedAt, 'passive', CREDENTIAL_MISSING_REASON);
    }
    if (secretRead.kind === 'unusable') {
      return healthResult(handle, sourceIds, type, 'degraded', options.checkedAt, 'passive', secretRead.reason);
    }
    return probeClass === 'static_bearer'
      // Readwise's auth endpoint accepts only the "Token" scheme: live probe
      // 2026-08-19 returned 401 for "Bearer" and 204 for "Token" with the
      // same credential. Hermetic fixtures cannot pin a provider's header
      // contract, so the scheme is stated here at the provider call site.
      ? probeBearerEndpoint(handle, sourceIds, type, capability, READWISE_AUTH_URL, 'Token', options)
      : probeBrokerMint(handle, sourceIds, type, capability, options);
  }

  // Everything else -- X's rotating token, Dropbox's env-pinned durable token,
  // and any handle whose consumption cost has not been proven zero -- is judged
  // from what the broker already wrote. A standalone daily process has no
  // access-token cache to reuse, so asking for a session here would be a real
  // token exchange against the provider.
  return passiveHandleResult(handle, sourceIds, type, options);
}

function passiveHandleResult(
  handle: ConnectedCredentialHandle,
  sourceIds: string[],
  type: CredentialHealthType,
  options: { brokerState: BrokerStateRead; checkedAt: string; now: Date },
): CredentialHealthResult {
  if (handle.allowedCapabilities.length === 0) {
    return healthResult(handle, sourceIds, type, 'missing', options.checkedAt, 'passive', 'registration_missing');
  }
  if (type === 'non_refreshable_session') {
    return healthResult(handle, sourceIds, type, 'skipped', options.checkedAt, 'passive', 'not_refreshable');
  }
  // A state file that exists but cannot be read is a real fault. A state file
  // that does not exist yet is not: a handle connected but never minted still
  // has its connection as evidence, below.
  if (options.brokerState.kind === 'unreadable' || options.brokerState.kind === 'partial') {
    return healthResult(handle, sourceIds, type, 'degraded', options.checkedAt, 'passive', 'broker_state_unreadable');
  }
  const state = options.brokerState.kind === 'ok'
    ? options.brokerState.handles.get(handle.handle)
    : undefined;
  if (state?.status === 'reauth_required') {
    return healthResult(handle, sourceIds, type, 'reauth_required', options.checkedAt, 'passive', 'credential_reauth_required');
  }
  if (state?.pendingRefreshStartedAt) {
    return healthResult(handle, sourceIds, type, 'degraded', options.checkedAt, 'passive', 'refresh_outcome_unrecorded');
  }
  // The newest thing that proves the credential still worked: the broker's last
  // recorded successful mint, or failing that the moment the owner connected it.
  const lastSuccessAt = state?.status === 'available' && state.updatedAt
    ? Date.parse(state.updatedAt)
    : Number.NaN;
  const connectedAt = Date.parse(handle.connectedAt);
  const evidenceAt = Math.max(
    Number.isFinite(lastSuccessAt) ? lastSuccessAt : Number.NEGATIVE_INFINITY,
    Number.isFinite(connectedAt) ? connectedAt : Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(evidenceAt)) {
    return healthResult(handle, sourceIds, type, 'degraded', options.checkedAt, 'passive', 'passive_evidence_unavailable');
  }
  return options.now.getTime() - evidenceAt > PASSIVE_EVIDENCE_MAX_AGE_MS
    ? healthResult(handle, sourceIds, type, 'degraded', options.checkedAt, 'passive', 'passive_evidence_stale')
    : healthResult(handle, sourceIds, type, 'healthy', options.checkedAt, 'passive', 'passive_evidence_fresh');
}

async function probeBrokerMint(
  handle: ConnectedCredentialHandle,
  sourceIds: string[],
  type: CredentialHealthType,
  capability: string,
  options: { broker: CredentialHealthProbeBroker; checkedAt: string },
): Promise<CredentialHealthResult> {
  try {
    await options.broker.issueSession({ handle: handle.handle, capability });
    return healthResult(handle, sourceIds, type, 'healthy', options.checkedAt, 'active');
  } catch (error) {
    return brokerFailureResult(handle, sourceIds, type, options.checkedAt, error);
  }
}

async function probeBearerEndpoint(
  handle: ConnectedCredentialHandle,
  sourceIds: string[],
  type: CredentialHealthType,
  capability: string,
  url: string,
  scheme: 'Token' | 'Bearer',
  options: { broker: CredentialHealthProbeBroker; fetchImpl: typeof fetch; checkedAt: string },
): Promise<CredentialHealthResult> {
  let session: CredentialSession;
  try {
    session = await options.broker.issueSession({ handle: handle.handle, capability });
  } catch (error) {
    return brokerFailureResult(handle, sourceIds, type, options.checkedAt, error);
  }
  try {
    const bearer = requireBearerTokenCredentialSession(session, handle.handle);
    const response = await options.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `${scheme} ${bearer.token}` },
    });
    return endpointResponseResult(handle, sourceIds, type, options.checkedAt, response);
  } catch {
    return healthResult(handle, sourceIds, type, 'degraded', options.checkedAt, 'active', 'probe_unavailable');
  }
}

async function probeVeniceApiKey(options: {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  checkedAt: string;
}): Promise<CredentialHealthResult> {
  const handle = { handle: 'venice.api-key', provider: 'venice' };
  // Venice is an answer-lane key rather than a connected registration, so the
  // host renders its own posture into the probe unit. It decides only what a
  // proven absence means: a required lane whose key 1Password does not have is
  // missing, an optional one is genuinely unconfigured.
  const secretRead = readWrapperSecret(options.env, 'venice');
  if (secretRead.kind === 'absent') {
    return options.env.OLYMPUS_CREDENTIAL_HEALTH_VENICE_REQUIRED?.trim() === '1'
      ? healthResult(handle, ['venice.api'], 'static_api_key', 'missing', options.checkedAt, 'passive', CREDENTIAL_MISSING_REASON)
      : healthResult(handle, ['venice.api'], 'static_api_key', 'skipped', options.checkedAt, 'passive', CREDENTIAL_NOT_CONFIGURED_REASON);
  }
  // An unproven read is not the posture's business: it degrades either way.
  if (secretRead.kind === 'unusable') {
    return healthResult(handle, ['venice.api'], 'static_api_key', 'degraded', options.checkedAt, 'passive', secretRead.reason);
  }
  try {
    // GET /models is metadata-only and does not dispatch inference or consume
    // model credits. It is the cheapest authenticated Venice key check.
    const response = await options.fetchImpl(VENICE_MODELS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secretRead.value}` },
    });
    return endpointResponseResult(handle, ['venice.api'], 'static_api_key', options.checkedAt, response);
  } catch {
    return healthResult(handle, ['venice.api'], 'static_api_key', 'degraded', options.checkedAt, 'active', 'probe_unavailable');
  }
}

function endpointResponseResult(
  handle: { handle: string; provider: string },
  sourceIds: string[],
  type: CredentialHealthType,
  checkedAt: string,
  response: Response,
): CredentialHealthResult {
  if (response.ok) return healthResult(handle, sourceIds, type, 'healthy', checkedAt, 'active');
  if (response.status === 401 || response.status === 403) {
    return healthResult(handle, sourceIds, type, 'reauth_required', checkedAt, 'active', 'provider_auth_rejected');
  }
  return healthResult(handle, sourceIds, type, 'degraded', checkedAt, 'active', 'probe_unavailable');
}

function brokerFailureResult(
  handle: ConnectedCredentialHandle,
  sourceIds: string[],
  type: CredentialHealthType,
  checkedAt: string,
  error: unknown,
): CredentialHealthResult {
  if (error instanceof CredentialBrokerError) {
    if (error.code === 'credential_reauth_required') {
      return healthResult(handle, sourceIds, type, 'reauth_required', checkedAt, 'active', error.code);
    }
    if (error.code === 'credential_missing'
      || error.code === 'credential_handle_not_registered'
      || error.code === 'credential_backend_malformed'
      || error.code === 'credential_capability_not_allowed') {
      return healthResult(handle, sourceIds, type, 'missing', checkedAt, 'active', error.code);
    }
    return healthResult(handle, sourceIds, type, 'degraded', checkedAt, 'active', error.code);
  }
  return healthResult(handle, sourceIds, type, 'degraded', checkedAt, 'active', 'probe_unavailable');
}

function healthResult(
  handle: { handle: string; provider: string },
  sourceIds: string[],
  type: CredentialHealthType,
  status: CredentialHealthStatus,
  checkedAt: string,
  probeMode: CredentialProbeMode,
  reason?: string,
): CredentialHealthResult {
  return {
    handle: handle.handle,
    provider: handle.provider,
    source_ids: sourceIds,
    credential_type: type,
    status,
    checked_at: checkedAt,
    probe_mode: probeMode,
    ...(reason ? { reason } : {}),
  };
}

function credentialType(handle: ConnectedCredentialHandle): CredentialHealthType {
  if (isRotatingCredentialShape(handle) && handle.oauth2Refresh) return 'rotating_oauth2_refresh';
  if (handle.oauth2Refresh) return 'oauth2_refresh';
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  if (isDelegatedGoogleHandle(handle)) return 'service_account_jwt';
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
  if (handle.provider === 'readwise') return 'static_api_key';
  return 'non_refreshable_session';
}

// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
function isDelegatedGoogleHandle(handle: ConnectedCredentialHandle): boolean {
  return (handle.provider === 'gmail' || handle.provider === 'google_drive' || handle.provider === 'google_calendar')
    && handle.handle.endsWith('.delegated');
}
// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END

function sourceIdsForProvider(provider: string): string[] {
  switch (provider) {
    case 'gmail': return ['gmail.email'];
    case 'google_drive': return ['google_drive.docs'];
    case 'dropbox': return ['dropbox.files'];
    case 'x': return ['x.bookmarks'];
    case 'readwise': return ['readwise.library'];
    case 'venice': return ['venice.api'];
    default: return [];
  }
}

function readRegistrySurface(path: string):
  | { kind: 'ok'; findings: AlarmFinding[] }
  | { kind: 'missing' }
  | { kind: 'unreadable' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return isMissingFile(error) ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unreadable' };
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.handles)) return { kind: 'unreadable' };
  const findings: AlarmFinding[] = [];
  for (const [index, value] of record.handles.entries()) {
    const item = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const handle = safeId(item.handle) ?? `handles[${index}]`;
    const missingBase = !safeId(item.handle)
      || !isCredentialProvider(item.provider)
      || !validTimestamp(item.connectedAt)
      || !Array.isArray(item.allowedCapabilities)
      || item.allowedCapabilities.length === 0
      || item.allowedCapabilities.some((capability) => !safeId(capability));
    const oauth = item.oauth2Refresh;
    const missingOauth = oauth !== undefined && (
      !oauth || typeof oauth !== 'object' || Array.isArray(oauth)
      || !nonEmptyString((oauth as Record<string, unknown>).tokenUrl)
      || !nonEmptyString((oauth as Record<string, unknown>).clientIdSecretRef)
      || !nonEmptyString((oauth as Record<string, unknown>).refreshTokenSecretRef)
    );
    if (missingBase || missingOauth) {
      findings.push({ handle, status: 'credential_missing', source: 'registration' });
    }
    const backend = item.backendState;
    if (backend && typeof backend === 'object' && !Array.isArray(backend)
      && (backend as Record<string, unknown>).status === 'reauth_required') {
      findings.push({ handle, status: 'reauth_required', source: 'registration' });
    }
  }
  return { kind: 'ok', findings };
}

/**
 * Read the broker's durable OAuth state. Entries are validated rather than
 * filtered: an entry the alarm cannot understand is a state file it cannot
 * speak for, and silently dropping it is how a latched handle goes unreported.
 */
function readCredentialBrokerState(path: string): BrokerStateRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return isMissingFile(error) ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unreadable' };
  const handles = (parsed as Record<string, unknown>).handles;
  if (!handles || typeof handles !== 'object' || Array.isArray(handles)) return { kind: 'unreadable' };
  const normalized = new Map<string, BrokerHandleState>();
  for (const [handle, value] of Object.entries(handles as Record<string, unknown>)) {
    if (!safeId(handle) || !value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'partial' };
    const entry = value as Record<string, unknown>;
    if (entry.status !== undefined && entry.status !== 'available' && entry.status !== 'reauth_required') {
      return { kind: 'partial' };
    }
    if (entry.updatedAt !== undefined && !validTimestamp(entry.updatedAt)) return { kind: 'partial' };
    if (entry.pendingRefreshStartedAt !== undefined && !validTimestamp(entry.pendingRefreshStartedAt)) {
      return { kind: 'partial' };
    }
    normalized.set(handle, {
      ...(entry.status ? { status: entry.status as 'available' | 'reauth_required' } : {}),
      ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}),
      ...(typeof entry.pendingRefreshStartedAt === 'string'
        ? { pendingRefreshStartedAt: entry.pendingRefreshStartedAt }
        : {}),
    });
  }
  return { kind: 'ok', handles: normalized };
}

function brokerStateFindings(state: { kind: 'ok'; handles: Map<string, BrokerHandleState> }): AlarmFinding[] {
  return [...state.handles.entries()]
    .filter(([, entry]) => entry.status === 'reauth_required')
    .map(([handle]) => ({ handle, status: 'reauth_required', source: 'broker_state' }));
}

type ProbeReportSurface =
  | { kind: 'fresh'; report: CredentialHealthReport }
  | { kind: 'stale'; report: CredentialHealthReport }
  | { kind: 'absent' };

function readProbeReportSurface(
  path: string,
  now: Date,
  bootedAt: Date,
  notes: AlarmSurfaceNote[],
): ProbeReportSurface {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (!isMissingFile(error)) {
      notes.push({ surface: 'probe_report', state: 'unreadable' });
      return { kind: 'absent' };
    }
    notes.push({
      surface: 'probe_report',
      state: now.getTime() - bootedAt.getTime() < CREDENTIAL_HEALTH_BOOTSTRAP_GRACE_MS
        ? 'bootstrap_pending'
        : 'missing',
    });
    return { kind: 'absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    notes.push({ surface: 'probe_report', state: 'unreadable' });
    return { kind: 'absent' };
  }
  const report = normalizeCredentialHealthReport(parsed);
  if (!report) {
    notes.push({ surface: 'probe_report', state: 'unreadable' });
    return { kind: 'absent' };
  }
  if (credentialHealthReportIsStale(report, now)) {
    notes.push({ surface: 'probe_report', state: 'stale' });
    return { kind: 'stale', report };
  }
  return { kind: 'fresh', report };
}

/**
 * Whether the last probe run saw anything that requires the given surface. It
 * is what separates "this host does not use that lane" from "that lane's state
 * has gone missing".
 */
function reportExpectsSurface(report: ProbeReportSurface, surface: 'registry' | 'broker_state'): boolean {
  if (report.kind === 'absent') return true;
  const registryBacked = report.report.results.filter((result) => result.handle !== 'venice.api-key');
  if (surface === 'registry') return registryBacked.length > 0;
  return registryBacked.some((result) => result.credential_type === 'oauth2_refresh'
    || result.credential_type === 'rotating_oauth2_refresh');
}

function probeReportFindings(report: ProbeReportSurface): AlarmFinding[] {
  if (report.kind === 'absent') return [];
  const source = report.kind === 'stale' ? 'stale_probe' : 'probe';
  return report.report.results
    .filter((result) => result.status === 'reauth_required'
      || result.status === 'missing'
      || result.status === 'degraded')
    .map((result) => ({
      handle: result.handle,
      status: result.status === 'missing' ? 'credential_missing' : result.status,
      source,
    }));
}

function normalizeCredentialHealthReport(value: unknown): CredentialHealthReport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<CredentialHealthReport>;
  if (record.kind !== 'credential_health_report' || record.version !== 1
    || !validTimestamp(record.generated_at) || !Array.isArray(record.results)
    // The policy block is the report's own claim about what the probe was
    // allowed to do. Substituting the canonical one for whatever was on disk
    // launders a policyless or drifted report into a valid one.
    || !isCanonicalCredentialHealthPolicy(record.policy)) return undefined;
  const generatedAt = Date.parse(record.generated_at);
  const results: CredentialHealthResult[] = [];
  for (const value of record.results) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const item = value as Partial<CredentialHealthResult>;
    const handle = safeId(item.handle);
    const provider = safeId(item.provider);
    if (!handle || !provider || !validTimestamp(item.checked_at)
      || !isHealthStatus(item.status) || !isCredentialType(item.credential_type)
      || !Array.isArray(item.source_ids) || item.source_ids.some((id) => !safeId(id))
      || (item.probe_mode !== undefined && !isProbeMode(item.probe_mode))
      || (item.reason !== undefined && !safeId(item.reason))) return undefined;
    // A result cannot have been checked after the report that carries it was
    // written, nor a whole cadence before it.
    const checkedAt = Date.parse(item.checked_at);
    if (checkedAt - generatedAt > CREDENTIAL_HEALTH_MAX_FUTURE_SKEW_MS
      || generatedAt - checkedAt > CREDENTIAL_HEALTH_REPORT_MAX_AGE_MS) return undefined;
    results.push({
      handle,
      provider,
      source_ids: [...item.source_ids],
      credential_type: item.credential_type,
      status: item.status,
      checked_at: new Date(item.checked_at).toISOString(),
      ...(item.probe_mode ? { probe_mode: item.probe_mode } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
    });
  }
  return {
    kind: 'credential_health_report',
    version: 1,
    generated_at: new Date(record.generated_at).toISOString(),
    results,
    policy: credentialHealthPolicy(),
  };
}

function writeCredentialHealthReport(path: string, report: CredentialHealthReport): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function isCanonicalCredentialHealthPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const canonical = credentialHealthPolicy() as unknown as Record<string, unknown>;
  const policy = value as Record<string, unknown>;
  const keys = Object.keys(canonical);
  return Object.keys(policy).length === keys.length
    && keys.every((key) => policy[key] === canonical[key]);
}

function credentialHealthPolicy(): CredentialHealthReport['policy'] {
  return {
    counts_only: true,
    raw_source_exposed: false,
    secrets_exposed: false,
    x_refresh_forced: false,
    op_cached_read_only: true,
  };
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new Error('Credential health clock is invalid.');
  return value;
}

function isHealthStatus(value: unknown): value is CredentialHealthStatus {
  return value === 'healthy' || value === 'reauth_required' || value === 'missing'
    || value === 'degraded' || value === 'skipped';
}

function isCredentialType(value: unknown): value is CredentialHealthType {
  // Only a type the public runtime can never PRODUCE may be stripped here. The
  // packaged runtime still emits static_api_key for readwise, and pushes a
  // venice result on every host, so dropping it rejected the whole report --
  // silently discarding every other handle's degradation with it.
  return value === 'oauth2_refresh' || value === 'rotating_oauth2_refresh'
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
    || value === 'service_account_jwt'
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
    || value === 'static_api_key' || value === 'non_refreshable_session';
}

function isProbeMode(value: unknown): value is CredentialProbeMode {
  return value === 'active' || value === 'passive';
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}

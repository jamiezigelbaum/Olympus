/**
 * Remote access state shared by the three processes that need it:
 *
 * - the Gateway's native relay service decides the mode from plugin config and
 *   supervises the relay child (`native-relay-service.ts`);
 * - the relay child keeps the session and certificate and reports progress
 *   (`remote-relay-runtime.ts`);
 * - the worker and the CLI read what they report.
 *
 * They meet in one directory, `<data>/openclaw/olympus/connect-relay` (0700,
 * files 0600), which also holds the install's keys:
 *
 *   status.json          what the service and the relay child report
 *   relay-auth           per-install secret proving a request came through the relay
 *   acme-terms.json      the user's acceptance of the CA subscriber agreement
 *
 * The worker learns its public base URL from status.json without restarting;
 * see `createRemotePublicUrlSource`. Issuer and resource still come only from
 * that configured value, never from a request's Host or forwarding headers.
 *
 * Nothing here imports the relay client, so the Gateway and worker bundles do
 * not carry it.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { OlympusConfig } from './config.ts';
import {
  parseRemotePublicBaseUrl,
  REMOTE_PUBLIC_BASE_URL_ENV,
  type RemotePublicUrls,
} from './remote-public-url.ts';
import { readWorkerSetupEnv } from './worker-auth.ts';

export const REMOTE_ACCESS_STATUS_SCHEMA = 'olympus.remote-access.status.v1';
export const REMOTE_ACCESS_DIR_NAME = 'connect-relay';
/** Must equal RELAY_AUTH_HEADER in connect-relay/client/local-endpoint.ts (a test holds them equal). */
export const RELAY_AUTH_HEADER = 'x-olympus-relay-auth';

const STATUS_FILE = 'status.json';
const RELAY_AUTH_FILE = 'relay-auth';
const TERMS_FILE = 'acme-terms.json';
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

// ---------------------------------------------------------------------------
// Mode

export type RemoteAccessMode =
  | { mode: 'off' }
  | { mode: 'manual'; publicBaseUrl: string }
  | { mode: 'relay'; relayHost: string }
  | { mode: 'error'; error: string };

/**
 * Remote access is opt-in (`remote.enabled`), with exactly one public address:
 * the Olympus relay (`remote.relayHost`) or a tunnel the owner runs
 * (`remote.publicBaseUrl`). Both at once is a conflict, reported by name; it
 * turns remote access off rather than failing the plugin, so local tools keep
 * working while the owner fixes it.
 */
export function resolveRemoteAccessMode(remote: OlympusConfig['remote']): RemoteAccessMode {
  if (!remote?.enabled) return { mode: 'off' };
  const { relayHost, publicBaseUrl } = remote;
  if (relayHost && publicBaseUrl) {
    return {
      mode: 'error',
      error: 'remote.relayHost and remote.publicBaseUrl are mutually exclusive: the relay sets the public address itself. '
        + 'Unset one of them (openclaw config unset plugins.entries.olympus.config.remote.publicBaseUrl, or .relayHost).',
    };
  }
  if (publicBaseUrl) {
    const parsed = parseRemotePublicBaseUrl(publicBaseUrl);
    if (!parsed.enabled) {
      return { mode: 'error', error: `remote.publicBaseUrl is invalid: ${(parsed.detail ?? 'not a URL').replace(REMOTE_PUBLIC_BASE_URL_ENV, 'it')}` };
    }
    return { mode: 'manual', publicBaseUrl: parsed.urls.origin };
  }
  if (relayHost) {
    const host = relayHost.toLowerCase();
    if (!DNS_NAME.test(host)) {
      return { mode: 'error', error: 'remote.relayHost must be a DNS name such as connect.olympusplugin.ai, with no scheme, port or path.' };
    }
    return { mode: 'relay', relayHost: host };
  }
  return {
    mode: 'error',
    error: 'remote.enabled is on, but neither remote.relayHost (the Olympus relay) nor remote.publicBaseUrl (your own tunnel) is set.',
  };
}

// ---------------------------------------------------------------------------
// Paths

/** `<XDG_DATA_HOME or ~/.local/share>/openclaw/olympus`, the worker's data root. */
export function olympusDataDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.XDG_DATA_HOME?.trim();
  const dataRoot = configured || join(env.HOME?.trim() || homedir(), '.local', 'share');
  if (!isAbsolute(dataRoot)) throw new TypeError('XDG_DATA_HOME must be an absolute private data root.');
  return join(dataRoot, 'openclaw', 'olympus');
}

export function remoteAccessDir(env: Record<string, string | undefined> = process.env): string {
  return join(olympusDataDir(env), REMOTE_ACCESS_DIR_NAME);
}

/**
 * The directory the managed worker and relay use, as seen from an owner's
 * shell: the data root comes from worker.env on a managed install, the way
 * `resolveRemoteConnectionsDbPathForCli` finds the connection database.
 */
export function remoteAccessDirForCli(env: Record<string, string | undefined> = process.env): string {
  const workerEnv = env.HOME?.trim() ? readWorkerSetupEnv({ env }) : undefined;
  const xdg = env.XDG_DATA_HOME?.trim() || workerEnv?.XDG_DATA_HOME;
  return remoteAccessDir({ ...(env.HOME !== undefined ? { HOME: env.HOME } : {}), ...(xdg ? { XDG_DATA_HOME: xdg } : {}) });
}

/** Create (0700) and check the directory; never follow a symlink or another user's directory. */
export function ensureRemoteAccessDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('the remote access state directory must be a directory owned by this user');
  }
  chmodSync(dir, 0o700);
  return dir;
}

function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** A regular file owned by this user, not a symlink; otherwise undefined. */
function readPrivateFile(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Re-reads a file only when it changed, and stats it at most once per interval. */
function cachedFileReader<T>(path: () => string, parse: (text: string) => T | undefined, minIntervalMs: number, now: () => number) {
  let checkedAt = -Infinity;
  let key: string | undefined;
  let value: T | undefined;
  return (): T | undefined => {
    const at = now();
    if (at - checkedAt < minIntervalMs) return value;
    checkedAt = at;
    let file: string;
    try {
      file = path();
      const stat = statSync(file, { bigint: true });
      const next = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      if (next === key) return value;
      key = next;
    } catch {
      key = undefined;
      value = undefined;
      return undefined;
    }
    const text = readPrivateFile(file);
    value = text === undefined ? undefined : parse(text);
    return value;
  };
}

// ---------------------------------------------------------------------------
// Status file

export type RelaySessionState = 'starting' | 'connecting' | 'online' | 'offline' | 'replaced' | 'stopped';
export type CertificateState = 'none' | 'awaiting_terms' | 'issuing' | 'serving' | 'failed';

export interface RemoteAccessStatusFile {
  schema: typeof REMOTE_ACCESS_STATUS_SCHEMA;
  updated_at: string;
  mode: 'off' | 'manual' | 'relay';
  /** A configuration conflict or invalid value; remote access is off while set. */
  error: string | null;
  relay_host: string | null;
  /** The loopback worker the relay forwards to. */
  local_url: string | null;
  /** The public origin, once it works: manual, or relay online with a served certificate. */
  public_base_url: string | null;
  instance_id: string | null;
  pid: number | null;
  install_id: string | null;
  hostname: string | null;
  relay: { state: RelaySessionState; reason: string | null; retry_in_ms: number | null } | null;
  certificate: { state: CertificateState; not_after: string | null; reason: string | null; retry_in_ms: number | null } | null;
  /** The CA's current subscriber agreement, as last seen by the relay child. */
  terms_url: string | null;
}

export function emptyRemoteAccessStatus(mode: RemoteAccessStatusFile['mode'], now = new Date()): RemoteAccessStatusFile {
  return {
    schema: REMOTE_ACCESS_STATUS_SCHEMA,
    updated_at: now.toISOString(),
    mode,
    error: null,
    relay_host: null,
    local_url: null,
    public_base_url: null,
    instance_id: null,
    pid: null,
    install_id: null,
    hostname: null,
    relay: null,
    certificate: null,
    terms_url: null,
  };
}

export function writeRemoteAccessStatus(dir: string, status: RemoteAccessStatusFile): void {
  ensureRemoteAccessDir(dir);
  writePrivateJson(join(dir, STATUS_FILE), status);
}

function parseStatus(text: string): RemoteAccessStatusFile | undefined {
  try {
    const value = JSON.parse(text) as RemoteAccessStatusFile;
    return value && value.schema === REMOTE_ACCESS_STATUS_SCHEMA ? value : undefined;
  } catch {
    return undefined;
  }
}

export function readRemoteAccessStatus(dir: string): RemoteAccessStatusFile | undefined {
  const text = readPrivateFile(join(dir, STATUS_FILE));
  return text === undefined ? undefined : parseStatus(text);
}

// ---------------------------------------------------------------------------
// Worker: the public base URL, live

export interface RemotePublicUrlSource {
  /** The public URLs right now, or undefined while OAuth is off. */
  current(): RemotePublicUrls | undefined;
  /** Where they come from: the worker environment (fixed at start) or status.json (live). */
  readonly origin: 'env' | 'status';
}

/**
 * The worker's public base URL without a restart.
 *
 * An `OLYMPUS_PUBLIC_BASE_URL` in the worker's environment (worker.env) is the
 * owner's explicit manual value and stays fixed for the process. Otherwise the
 * worker reads status.json, which the Gateway's relay service writes for a
 * configured `remote.publicBaseUrl` and the relay child writes once its
 * session is up and its certificate is served. The file is re-read only when
 * it changes, and stat-ed at most once a second, so a request pays at most
 * one stat.
 *
 * A file rather than a supervised restart: restarting the worker when the
 * relay comes up would cut in-flight answers and MCP streams and drop pending
 * OAuth approvals (they live in memory), and the relay can come and go with
 * the network. A file also lets the CLI and a worker that the Gateway does not
 * supervise read the same answer.
 */
export function createRemotePublicUrlSource(
  env: Record<string, string | undefined> = process.env,
  options: { now?: () => number; minIntervalMs?: number } = {},
): RemotePublicUrlSource {
  if (env[REMOTE_PUBLIC_BASE_URL_ENV]?.trim()) {
    const parsed = parseRemotePublicBaseUrl(env[REMOTE_PUBLIC_BASE_URL_ENV]);
    const urls = parsed.enabled ? parsed.urls : undefined;
    return { origin: 'env', current: () => urls };
  }
  const dir = remoteAccessDir(env);
  const read = cachedFileReader(
    () => join(dir, STATUS_FILE),
    (text) => {
      const status = parseStatus(text);
      if (!status || status.error || status.mode === 'off' || !status.public_base_url) return undefined;
      const parsed = parseRemotePublicBaseUrl(status.public_base_url);
      return parsed.enabled ? parsed.urls : undefined;
    },
    options.minIntervalMs ?? 1_000,
    options.now ?? Date.now,
  );
  return { origin: 'status', current: read };
}

// ---------------------------------------------------------------------------
// Relay forwarding trust

/** The relay child's secret: created once, 0600, never logged. */
export function loadOrCreateRelayAuthSecret(dir: string): string {
  ensureRemoteAccessDir(dir);
  const path = join(dir, RELAY_AUTH_FILE);
  const existing = readPrivateFile(path)?.trim();
  if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
  const secret = randomBytes(32).toString('base64url');
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, `${secret}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return secret;
}

/**
 * Whether a request's relay forwarding headers (`x-olympus-relay`,
 * `x-forwarded-for`) may be believed. Only the relay's local endpoint knows
 * the per-install secret it sends in `x-olympus-relay-auth`, and it strips
 * any inbound copy; any other loopback caller that sets the headers is
 * treated as a direct caller.
 */
export function createRelayRequestVerifier(
  env: Record<string, string | undefined> = process.env,
  options: { now?: () => number; minIntervalMs?: number } = {},
): (request: Request) => boolean {
  const dir = remoteAccessDir(env);
  const secret = cachedFileReader(
    () => join(dir, RELAY_AUTH_FILE),
    (text) => {
      const value = text.trim();
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? Buffer.from(value) : undefined;
    },
    options.minIntervalMs ?? 1_000,
    options.now ?? Date.now,
  );
  return (request) => {
    if (request.headers.get('x-olympus-relay') !== '1') return false;
    const presented = request.headers.get(RELAY_AUTH_HEADER);
    const expected = secret();
    if (!presented || !expected) return false;
    const actual = Buffer.from(presented);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}

// ---------------------------------------------------------------------------
// CA subscriber agreement

export interface TermsAcceptance {
  terms_url: string | null;
  accepted_at: string;
}

export function readTermsAcceptance(dir: string): TermsAcceptance | undefined {
  const text = readPrivateFile(join(dir, TERMS_FILE));
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as TermsAcceptance;
    return typeof value?.accepted_at === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function recordTermsAcceptance(dir: string, termsUrl: string | undefined, now = new Date()): TermsAcceptance {
  ensureRemoteAccessDir(dir);
  const acceptance: TermsAcceptance = { terms_url: termsUrl ?? null, accepted_at: now.toISOString() };
  writePrivateJson(join(dir, TERMS_FILE), acceptance);
  return acceptance;
}

/** Accepted, and for the CA's current agreement: a new agreement needs a new acceptance. */
export function termsAccepted(dir: string, currentTermsUrl: string | undefined): boolean {
  const acceptance = readTermsAcceptance(dir);
  if (!acceptance) return false;
  return currentTermsUrl === undefined || acceptance.terms_url === currentTermsUrl;
}

// ---------------------------------------------------------------------------
// What the CLI and dashboard show

export type PublicBaseUrlSource = 'worker_env' | 'config' | 'relay';

export interface RemoteAccessUrls {
  public_base_url: string | null;
  public_base_url_source: PublicBaseUrlSource | null;
  mcp_url: string;
  openapi_url: string;
  oauth_issuer: string | null;
  /** The worker's own loopback origin (what the URLs fall back to). */
  local_url: string;
}

/**
 * The URLs to hand an agent, from the owner's shell: the worker environment's
 * manual value first (it is what the worker itself uses), then what status.json
 * reports (config's manual value, or the relay once it works), else the
 * worker's real loopback address.
 */
export function resolveRemoteAccessUrls(input: {
  /** CLI environment layered over worker.env. */
  layeredEnv: Record<string, string | undefined>;
  /** The CLI's own environment (an explicit OLYMPUS_EMAIL_BASE_URL there wins). */
  env: Record<string, string | undefined>;
  status: RemoteAccessStatusFile | undefined;
  /** The worker base URL from the CLI's loaded config. */
  configuredWorkerBaseUrl: string;
}): RemoteAccessUrls {
  const local = localWorkerOrigin(input);
  let publicBase: string | null = null;
  let source: PublicBaseUrlSource | null = null;
  const manual = parseRemotePublicBaseUrl(input.layeredEnv[REMOTE_PUBLIC_BASE_URL_ENV]);
  if (manual.enabled) {
    publicBase = manual.urls.origin;
    source = 'worker_env';
  } else if (input.status && !input.status.error && input.status.mode !== 'off' && input.status.public_base_url) {
    const reported = parseRemotePublicBaseUrl(input.status.public_base_url);
    if (reported.enabled) {
      publicBase = reported.urls.origin;
      source = input.status.mode === 'relay' ? 'relay' : 'config';
    }
  }
  const origin = publicBase ?? local;
  return {
    public_base_url: publicBase,
    public_base_url_source: source,
    mcp_url: `${origin}/mcp`,
    openapi_url: `${origin}/openapi.json`,
    oauth_issuer: publicBase,
    local_url: local,
  };
}

function localWorkerOrigin(input: {
  layeredEnv: Record<string, string | undefined>;
  env: Record<string, string | undefined>;
  status: RemoteAccessStatusFile | undefined;
  configuredWorkerBaseUrl: string;
}): string {
  const explicit = originOf(input.env.OLYMPUS_EMAIL_BASE_URL);
  if (explicit) return explicit;
  const reported = originOf(input.status?.local_url ?? undefined);
  if (reported) return reported;
  const port = input.layeredEnv.OLYMPUS_EMAIL_SOURCE_PORT?.trim();
  if (port && /^\d{1,5}$/.test(port)) {
    const host = input.layeredEnv.OLYMPUS_EMAIL_SOURCE_HOST?.trim() || '127.0.0.1';
    const origin = originOf(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`);
    if (origin) return origin;
  }
  return originOf(input.configuredWorkerBaseUrl) ?? 'http://127.0.0.1:8010';
}

function originOf(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** A loopback http origin the relay may forward to, or undefined. */
export function loopbackWorkerOrigin(value: string | undefined): string | undefined {
  const origin = originOf(value);
  if (!origin) return undefined;
  const url = new URL(origin);
  return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname) ? origin : undefined;
}

/**
 * `olympus connections status`, and the shape the dashboard's "Connect an
 * agent" panel reads. Stable keys; see the PR that introduced it.
 */
export interface RemoteAccessStatusView {
  kind: 'remote_access_status';
  schema: typeof REMOTE_ACCESS_STATUS_SCHEMA;
  remote_enabled: boolean;
  mode: 'off' | 'manual' | 'relay' | 'unknown';
  error: string | null;
  public_base_url: string | null;
  public_base_url_source: PublicBaseUrlSource | null;
  urls: { mcp: string; openapi: string; oauth_issuer: string | null };
  local_url: string;
  relay: {
    host: string | null;
    state: RelaySessionState | 'not_running' | null;
    connected: boolean;
    reason: string | null;
    retry_in_ms: number | null;
    install_id: string | null;
    hostname: string | null;
  };
  certificate: {
    state: CertificateState | null;
    not_after: string | null;
    reason: string | null;
  };
  terms: {
    url: string | null;
    accepted: boolean;
    accepted_at: string | null;
    accepted_url: string | null;
  };
  updated_at: string | null;
  next_step: string | null;
}

export function remoteAccessStatusView(input: {
  dir: string;
  urls: RemoteAccessUrls;
  status: RemoteAccessStatusFile | undefined;
  isAlive?: (pid: number) => boolean;
}): RemoteAccessStatusView {
  const { status, urls } = input;
  const isAlive = input.isAlive ?? processIsAlive;
  const acceptance = readTermsAcceptance(input.dir);
  const mode = status ? status.mode : 'unknown';
  let relayState: RemoteAccessStatusView['relay']['state'] = status?.relay?.state ?? null;
  if (status?.mode === 'relay' && status.pid !== null && relayState !== 'stopped' && !isAlive(status.pid)) {
    relayState = 'not_running';
  }
  const termsUrl = status?.terms_url ?? null;
  const accepted = acceptance !== undefined && (termsUrl === null || acceptance.terms_url === termsUrl);
  const view: RemoteAccessStatusView = {
    kind: 'remote_access_status',
    schema: REMOTE_ACCESS_STATUS_SCHEMA,
    remote_enabled: urls.public_base_url_source === 'worker_env' || (status !== undefined && status.mode !== 'off' && !status.error),
    mode,
    error: status?.error ?? null,
    public_base_url: urls.public_base_url,
    public_base_url_source: urls.public_base_url_source,
    urls: { mcp: urls.mcp_url, openapi: urls.openapi_url, oauth_issuer: urls.oauth_issuer },
    local_url: urls.local_url,
    relay: {
      host: status?.relay_host ?? null,
      state: relayState,
      connected: relayState === 'online',
      reason: status?.relay?.reason ?? null,
      retry_in_ms: status?.relay?.retry_in_ms ?? null,
      install_id: status?.install_id ?? null,
      hostname: status?.hostname ?? null,
    },
    certificate: {
      state: status?.certificate?.state ?? null,
      not_after: status?.certificate?.not_after ?? null,
      reason: status?.certificate?.reason ?? null,
    },
    terms: {
      url: termsUrl,
      accepted,
      accepted_at: acceptance?.accepted_at ?? null,
      accepted_url: acceptance?.terms_url ?? null,
    },
    updated_at: status?.updated_at ?? null,
    next_step: null,
  };
  view.next_step = nextStep(view);
  return view;
}

function nextStep(view: RemoteAccessStatusView): string | null {
  if (view.error) return view.error;
  if (view.mode === 'unknown' && !view.public_base_url) {
    return 'Remote access has not reported yet. Turn it on with openclaw config set plugins.entries.olympus.config.remote.enabled true (plus remote.relayHost or remote.publicBaseUrl), then restart the Gateway.';
  }
  if (view.mode === 'off' && !view.public_base_url) return 'Remote access is off. Hosted agents cannot reach this Olympus; local agents are unaffected.';
  if (view.mode !== 'relay') return null;
  if (view.certificate.state === 'awaiting_terms') {
    return 'Read the Let\'s Encrypt subscriber agreement (terms.url), then accept it with olympus connections terms --accept.';
  }
  if (view.relay.state === 'not_running') return 'The relay process is not running; check openclaw gateway status.';
  if (view.relay.state !== 'online') return 'Olympus is connecting to the relay.';
  if (view.certificate.state === 'failed') return 'The certificate could not be obtained yet; Olympus retries automatically.';
  if (view.certificate.state !== 'serving') return 'Olympus is obtaining its certificate.';
  return null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remote access state shared by the three processes that need it:
 *
 * - the Gateway's native relay service decides the mode from plugin config and
 *   supervises the relay child (`native-relay-service.ts`);
 * - the relay child keeps the install's session to the relay and reports it
 *   (`remote-relay-runtime.ts`);
 * - the worker and the CLI read what they report.
 *
 * They meet in one directory, `<data>/openclaw/olympus/connect-relay` (0700,
 * files 0600), which also holds the install's key:
 *
 *   status.json          what the service and the relay child report
 *   install-key.pem      the install's Ed25519 identity (relay child only)
 *   demo-install         present only on a demo install (synthetic data);
 *                        see `demoInstallMarked`
 *
 * The worker learns its public base URL and install id from status.json
 * without restarting; see `createRemotePublicUrlSource`. Issuer and resource
 * come only from that configured value, never from a request's Host or
 * forwarding headers.
 *
 * Nothing here imports the relay client, so the Gateway and worker bundles do
 * not carry it.
 */
// Distinct local names keep the bundler from renumbering the bundle's other
// `node:*` bindings, so the committed dist/ diff stays the size of the change.
import { randomBytes as raRandomBytes, timingSafeEqual as raTimingSafeEqual } from 'node:crypto';
import {
  chmodSync as raChmodSync,
  lstatSync as raLstatSync,
  mkdirSync as raMkdirSync,
  readFileSync as raReadFileSync,
  renameSync as raRenameSync,
  statSync as raStatSync,
  unlinkSync as raUnlinkSync,
  writeFileSync as raWriteFileSync,
} from 'node:fs';
import { homedir as raHomedir } from 'node:os';
import { isAbsolute as raIsAbsolute, join as raJoin } from 'node:path';
import type { OlympusConfig } from './config.ts';
import {
  parseRemotePublicBaseUrl,
  REMOTE_PUBLIC_BASE_URL_ENV,
  type RemotePublicUrls,
} from './remote-public-url.ts';
import { readWorkerSetupEnv } from './worker-auth.ts';

export const REMOTE_ACCESS_STATUS_SCHEMA = 'olympus.remote-access.status.v2';
export const REMOTE_ACCESS_DIR_NAME = 'connect-relay';
/**
 * The relay child marks every request it forwards with this header (a secret
 * minted per boot) and strips any inbound copy. The worker refuses OAuth
 * approval for any request carrying it, so approval can only come from a
 * direct visit on this Mac. Must equal RELAY_HEADER in
 * connect-relay/client/forward.ts (a test holds them equal).
 */
export const RELAYED_REQUEST_HEADER = 'x-olympus-relay';

const STATUS_FILE = 'status.json';
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const INSTALL_ID = /^[a-z2-7]{32}$/;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

// ---------------------------------------------------------------------------
// Mode

export type RemoteAccessMode =
  | { mode: 'off' }
  | { mode: 'manual'; publicBaseUrl: string }
  | { mode: 'relay'; relayHost: string }
  | { mode: 'error'; error: string };

/** The Olympus relay, used whenever remote access is on without a tunnel of the owner's own. */
export const DEFAULT_RELAY_HOST = 'mcp.olympusplugin.ai';

/**
 * Remote access is opt-in (`remote.enabled`), with exactly one public address:
 * the Olympus relay (`remote.relayHost`, default `mcp.olympusplugin.ai`) or a
 * tunnel the owner runs (`remote.publicBaseUrl`). Both set explicitly is a
 * conflict, reported by name; it turns remote access off rather than failing
 * the plugin, so local tools keep working while the owner fixes it.
 *
 * The default lives here, not as a JSON-schema `default` in the manifest, so
 * a `publicBaseUrl` owner never has a relay host materialized beside it.
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
  const host = (relayHost ?? DEFAULT_RELAY_HOST).toLowerCase();
  if (!DNS_NAME.test(host)) {
    return { mode: 'error', error: 'remote.relayHost must be a DNS name such as mcp.olympusplugin.ai, with no scheme, port or path.' };
  }
  return { mode: 'relay', relayHost: host };
}

// ---------------------------------------------------------------------------
// Paths

/** `<XDG_DATA_HOME or ~/.local/share>/openclaw/olympus`, the worker's data root. */
export function olympusDataDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.XDG_DATA_HOME?.trim();
  const dataRoot = configured || raJoin(env.HOME?.trim() || raHomedir(), '.local', 'share');
  if (!raIsAbsolute(dataRoot)) throw new TypeError('XDG_DATA_HOME must be an absolute private data root.');
  return raJoin(dataRoot, 'openclaw', 'olympus');
}

export function remoteAccessDir(env: Record<string, string | undefined> = process.env): string {
  return raJoin(olympusDataDir(env), REMOTE_ACCESS_DIR_NAME);
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
  raMkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = raLstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('the remote access state directory must be a directory owned by this user');
  }
  raChmodSync(dir, 0o700);
  return dir;
}

/** Atomic 0600 write: an exclusively created, randomly named temporary, then rename. */
function writePrivateText(path: string, text: string): void {
  const temporary = `${path}.tmp.${process.pid}.${raRandomBytes(8).toString('hex')}`;
  raWriteFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  raChmodSync(temporary, 0o600);
  raRenameSync(temporary, path);
}

/** A regular file owned by this user, not a symlink; otherwise undefined. */
function readPrivateFile(path: string): string | undefined {
  try {
    const stat = raLstatSync(path);
    if (!stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return undefined;
    return raReadFileSync(path, 'utf8');
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
      const stat = raStatSync(file, { bigint: true });
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

export interface RemoteAccessStatusFile {
  schema: typeof REMOTE_ACCESS_STATUS_SCHEMA;
  updated_at: string;
  mode: 'off' | 'manual' | 'relay';
  /** A configuration conflict or invalid value; remote access is off while set. */
  error: string | null;
  relay_host: string | null;
  /** The loopback worker the relay forwards to. */
  local_url: string | null;
  /**
   * The public origin: manual, or `https://<relay host>` while the relay child
   * runs. The issuer does not move with the session; whether hosted agents can
   * reach this Mac right now is `relay.state`.
   */
  public_base_url: string | null;
  instance_id: string | null;
  pid: number | null;
  /** This install's relay id (relay mode). */
  install_id: string | null;
  relay: { state: RelaySessionState; reason: string | null; retry_in_ms: number | null } | null;
  /** When the relay session last came up. */
  last_connected_at: string | null;
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
    relay: null,
    last_connected_at: null,
  };
}

export function writeRemoteAccessStatus(dir: string, status: RemoteAccessStatusFile): void {
  ensureRemoteAccessDir(dir);
  writePrivateText(raJoin(dir, STATUS_FILE), `${JSON.stringify(status, null, 2)}\n`);
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
  const text = readPrivateFile(raJoin(dir, STATUS_FILE));
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
 * configured `remote.publicBaseUrl` and the relay child writes while it runs.
 * In relay mode the URLs carry the install id, and are withheld until the
 * child has reported it: codes and tokens must name it for the relay to route
 * them. The file is re-read only when it changes, and stat-ed at most once a
 * second, so a request pays at most one stat.
 *
 * A file rather than a supervised restart: restarting the worker when the
 * relay comes up would cut in-flight answers and MCP streams and drop pending
 * OAuth approvals (they live in memory). A file also lets the CLI and a worker
 * that the Gateway does not supervise read the same answer.
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
    () => raJoin(dir, STATUS_FILE),
    (text) => {
      const status = parseStatus(text);
      if (!status || status.error || status.mode === 'off' || !status.public_base_url) return undefined;
      if (status.mode === 'relay' && !(status.install_id && INSTALL_ID.test(status.install_id))) return undefined;
      const parsed = parseRemotePublicBaseUrl(status.public_base_url, status.mode === 'relay' ? status.install_id! : undefined);
      return parsed.enabled ? parsed.urls : undefined;
    },
    options.minIntervalMs ?? 1_000,
    options.now ?? Date.now,
  );
  return { origin: 'status', current: read };
}

/**
 * The demo marker: a file an operator creates by hand on a demo install, which
 * holds synthetic sample data only. Its first line must be exactly
 * DEMO_INSTALL_MARKER_TEXT. Demo sign-in (remote.demoConsent) and forwarding
 * of the demo sign-in path both require it, so the config flag alone never
 * opens password sign-in on a real install.
 */
export const DEMO_INSTALL_MARKER_FILE = 'demo-install';
export const DEMO_INSTALL_MARKER_TEXT = 'olympus demo install: synthetic sample data only';

export function demoInstallMarked(dir: string): boolean {
  const text = readPrivateFile(raJoin(dir, DEMO_INSTALL_MARKER_FILE));
  return text !== undefined && text.split('\n', 1)[0]!.trim() === DEMO_INSTALL_MARKER_TEXT;
}

/**
 * Whether a request carries the relay marker at all, whatever its value. Only
 * for refusing what a direct loopback visit alone may do (OAuth approval):
 * a forged marker then fails closed. Never a reason to grant anything.
 */
export function carriesRelayMarker(request: Request): boolean {
  return request.headers.has(RELAYED_REQUEST_HEADER);
}

/**
 * The relay child's per-boot secret (remote-relay-runtime.ts), written 0600
 * in the 0700 remote-access directory so the worker, another process, can
 * check the marker's value. Removed when the child stops.
 */
export const RELAY_SECRET_FILE = 'relay-secret';
const RELAY_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function writeRelaySecret(dir: string, secret: string): void {
  if (!RELAY_SECRET_PATTERN.test(secret)) throw new Error('relay secret must be 32 random bytes, base64url');
  ensureRemoteAccessDir(dir);
  writePrivateText(raJoin(dir, RELAY_SECRET_FILE), `${secret}\n`);
}

/** Removes the secret file if it still holds this child's secret (a newer child's stays). */
export function clearRelaySecret(dir: string, secret: string): void {
  const path = raJoin(dir, RELAY_SECRET_FILE);
  if (readPrivateFile(path)?.trim() !== secret) return;
  try {
    raUnlinkSync(path);
  } catch {
    // Already gone.
  }
}

/**
 * A relayed-request check for one remote-access directory: the marker must
 * equal the relay child's current secret (constant-time). No secret file, or
 * one not owned by this user, means nothing is relayed.
 */
export function createRelayedRequestCheck(options: { dir?: () => string; now?: () => number } = {}): (request: Request) => boolean {
  const read = cachedFileReader(
    () => raJoin(options.dir ? options.dir() : remoteAccessDir(process.env), RELAY_SECRET_FILE),
    (text) => {
      const secret = text.trim();
      return RELAY_SECRET_PATTERN.test(secret) ? Buffer.from(secret, 'utf8') : undefined;
    },
    // Statted on each marked request: a restarted child's new secret is seen at once.
    0,
    options.now ?? Date.now,
  );
  return (request) => {
    const value = request.headers.get(RELAYED_REQUEST_HEADER);
    if (!value) return false;
    const secret = read();
    if (!secret) return false;
    const given = Buffer.from(value, 'utf8');
    return given.length === secret.length && raTimingSafeEqual(given, secret);
  };
}

let defaultRelayedCheck: ((request: Request) => boolean) | undefined;

/**
 * Whether a request came through this Mac's relay child: its marker equals
 * the child's per-boot secret (review finding, 2026-10-02: presence alone let
 * any local caller with a credential select the ChatGPT surface and
 * `/private`). Reads the secret from this process's remote-access directory.
 */
export function isRelayedRequest(request: Request): boolean {
  if (!request.headers.has(RELAYED_REQUEST_HEADER)) return false;
  defaultRelayedCheck ??= createRelayedRequestCheck();
  return defaultRelayedCheck(request);
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
 * reports (config's manual value, or the relay), else the worker's real
 * loopback address.
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
  mode: 'off' | 'manual' | 'relay';
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
    last_connected_at: string | null;
  };
  updated_at: string | null;
  next_step: string | null;
}

/**
 * What runs Olympus: the OpenClaw Gateway (plugin install), or the standalone
 * engine (`olympus engine`, config in ~/.olympus/engine.json). It decides
 * which commands the owner is told to run.
 */
export type RemoteAccessHostKind = 'openclaw' | 'standalone';

export function remoteAccessStatusView(input: {
  urls: RemoteAccessUrls;
  status: RemoteAccessStatusFile | undefined;
  isAlive?: (pid: number) => boolean;
  hostKind?: RemoteAccessHostKind;
}): RemoteAccessStatusView {
  const { status, urls } = input;
  const isAlive = input.isAlive ?? processIsAlive;
  // No status file: the relay service never ran with remote access on.
  const mode = status ? status.mode : 'off';
  let relayState: RemoteAccessStatusView['relay']['state'] = status?.relay?.state ?? null;
  if (status?.mode === 'relay' && status.pid !== null && relayState !== 'stopped' && !isAlive(status.pid)) {
    relayState = 'not_running';
  }
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
      last_connected_at: status?.last_connected_at ?? null,
    },
    updated_at: status?.updated_at ?? null,
    next_step: null,
  };
  view.next_step = nextStep(view, input.hostKind ?? 'openclaw');
  return view;
}

function nextStep(view: RemoteAccessStatusView, hostKind: RemoteAccessHostKind): string | null {
  if (view.error) return view.error;
  if (view.mode === 'off' && !view.public_base_url) {
    return 'Remote access is off, so hosted agents cannot reach this Olympus (local agents are unaffected). '
      + 'To turn it on, use Turn on remote access in the Agents section of the Olympus dashboard, '
      + (hostKind === 'standalone'
        ? 'or set "remote": {"enabled": true} in ~/.olympus/engine.json and run: olympus engine restart'
        : 'or run: openclaw config set plugins.entries.olympus.config.remote.enabled true');
  }
  if (view.mode !== 'relay') return null;
  if (view.relay.state === 'not_running') {
    return hostKind === 'standalone'
      ? 'The relay process is not running; run olympus engine restart.'
      : 'The relay process is not running; check openclaw gateway status.';
  }
  if (view.relay.state === 'offline') {
    return `Olympus relay unavailable${view.relay.reason ? ` (${view.relay.reason})` : ''}. `
      + 'Olympus keeps retrying on its own; local agents are unaffected.';
  }
  if (view.relay.state !== 'online') return 'Olympus is connecting to the relay.';
  return null;
}

/** A relay child is running for this install (per its status and a live pid). */
export function relayProcessRunning(dir: string, isAlive: (pid: number) => boolean = processIsAlive): boolean {
  const status = readRemoteAccessStatus(dir);
  return status?.mode === 'relay' && status.pid !== null && status.relay?.state !== 'stopped' && isAlive(status.pid);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

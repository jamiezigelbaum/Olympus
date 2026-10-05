// Owner-declared settings for the experimental zkAPI consult transport
// (design: docs/design/frontier-consult-lane.md, track Z).
//
// zkAPI is a paid anonymous route to ordinary cloud models through a local
// daemon (`zkapi-clientd`) the user installs and funds in its own tool. It is a
// standard_cloud destination: OpenRouter and the upstream model read every
// prompt. Olympus may therefore use it only to carry a consult (one question a
// local model wrote, with no evidence), never as an analyst, embedder, vision
// extractor or classifier. This module holds the data side only: the settings
// shape, the six risk statements an owner must acknowledge, and the loopback
// port rule. It holds no credential that can move funds and calls nothing.

import { readFileSync, statSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OperationError } from './operation-error.ts';

/** `zkapi-clientd` listens here unless its owner chose another loopback port. */
export const ZKAPI_DAEMON_DEFAULT_PORT = 8787;
export const ZKAPI_DAEMON_DEFAULT_BASE_URL = `http://127.0.0.1:${ZKAPI_DAEMON_DEFAULT_PORT}/v1`;
/**
 * The loopback SOCKS port the owner points the daemon at once
 * (`zkapi-clientd config --relay-url socks5://127.0.0.1:19050`). Olympus starts
 * a throwaway Tor on it for each consult; between consults nothing listens
 * there, so the daemon cannot reach the network at all.
 */
export const ZKAPI_DEFAULT_TOR_SOCKS_PORT = 19050;

/** On-chain `noteTtl`: after 30 days an unwithdrawn note becomes claimable by the operator. */
export const ZKAPI_NOTE_TTL_DAYS = 30;
/** Days-left thresholds at which the owner is told to spend or withdraw. */
export const ZKAPI_EXPIRY_NOTICE_DAYS = [10, 5, 2] as const;
/** Proposed soft ceiling (design §Z.4 guard 3); a warning, never enforced. */
export const ZKAPI_SUGGESTED_DEPOSIT_CEILING_USD = 50;

const DEFAULTS = {
  tor: 'per_consult' as const,
  torSocksPort: ZKAPI_DEFAULT_TOR_SOCKS_PORT,
  /** The reference measures 3 to 4.5 minutes per request; never kill a slow call early. */
  timeoutMs: 6 * 60 * 1000,
  /** zkapi-tor-cli.sh gives Tor its ready budget minus 30 s: 240 - 30. */
  torBootstrapTimeoutMs: 210 * 1000,
  daemonReadyTimeoutMs: 120 * 1000,
  /** zkapi-tor-cli.sh `warm_policy` waits up to 180 s for the model policy. */
  policyWarmTimeoutMs: 180 * 1000,
  /**
   * zkapi-tor-cli.sh waits 180 s, but the daemon allows its companion call,
   * including /wallet/settle, four minutes (`internal/zkapi/client.go`); wait
   * longer than that so a legitimate settlement is not cut off.
   */
  settleTimeoutMs: 300 * 1000,
  maxResponseBytes: 256 * 1024,
};
export const ZKAPI_SETTING_DEFAULTS: Readonly<typeof DEFAULTS> = DEFAULTS;

/**
 * The six statements of design §Z.3 plus the per-consult cost and the absence
 * of a default limit (owner ruling, 2026-10-05), in plain words. The version
 * moves when the wording or the set changes, which voids every earlier
 * acknowledgement.
 */
export const ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION = 3;
export const ZKAPI_RISK_ACKNOWLEDGEMENTS = [
  {
    id: 'per_consult_cost',
    statement: 'Each consult authorizes up to the chosen model\'s per-request allowance, currently $1 to $6 depending on the model. Olympus counts every consult at $6, the worst case.',
  },
  {
    id: 'no_default_limit',
    statement: 'There is no limit on the number of consults or on daily spending unless you set one (dailyRequestCap, dailySpendCapUsd).',
  },
  {
    id: 'deposit_fee',
    statement: 'Depositing is an expensive on-chain transaction, paid separately from consults. Its fee can be larger than a small deposit.',
  },
  {
    id: 'withdrawal_fee',
    statement: 'Getting unspent money back is a second expensive on-chain transaction, paid separately, and may require sending additional ETH for its fee.',
  },
  {
    id: 'note_expiry_30_days',
    statement: 'Unused balance that is not withdrawn within about 30 days becomes claimable in full by the operator. Olympus only estimates that date from the funding date you confirm; the real one is set on-chain by the deposit block.',
  },
  {
    id: 'no_top_up',
    statement: 'There is no top-up. Each deposit is a new note with its own fee and its own 30-day clock.',
  },
  {
    id: 'operator_risk',
    statement: 'One operator account can pause deposits and withdrawals while the expiry clock keeps running, and one party ran the proof setup. Funds could be frozen or lost.',
  },
  {
    id: 'local_files_risk',
    statement: 'The balance is controlled by files on this computer. Losing them loses the money.',
  },
] as const;

export type ZkapiRiskAcknowledgementId = (typeof ZKAPI_RISK_ACKNOWLEDGEMENTS)[number]['id'];

export interface ZkapiConsultSettings {
  /**
   * `per_consult`: Olympus starts a throwaway Tor client for each consult on
   * `torSocksPort` (the port the owner set as the daemon's relay) and stops it
   * after settlement. `off`: no Tor; the route is "payment privacy only".
   */
  tor: 'per_consult' | 'off';
  torSocksPort: number;
  /** The date the owner confirms the current note was funded, YYYY-MM-DD. */
  fundingDate?: string;
  depositUsd?: number;
  acknowledgements: { version: number; accepted: string[] };
  /** Optional owner-set daily request limit (UTC day). Unset: no limit. */
  dailyRequestCap?: number;
  /** Optional owner-set daily worst-case spend limit; each request counts $6. Unset: no limit. */
  dailySpendCapUsd?: number;
  timeoutMs: number;
  torBootstrapTimeoutMs: number;
  daemonReadyTimeoutMs: number;
  policyWarmTimeoutMs: number;
  settleTimeoutMs: number;
  maxResponseBytes: number;
  /** Absolute path of zkapi-clientd; default: found on PATH. */
  daemonExecutable?: string;
  /** Absolute path of tor; default: found on PATH. Olympus does not bundle Tor. */
  torExecutable?: string;
}

type IntegerSetting =
  | 'torSocksPort'
  | 'dailyRequestCap'
  | 'timeoutMs'
  | 'torBootstrapTimeoutMs'
  | 'daemonReadyTimeoutMs'
  | 'policyWarmTimeoutMs'
  | 'settleTimeoutMs'
  | 'maxResponseBytes';

const INTEGER_BOUNDS: Record<IntegerSetting, [number, number]> = {
  torSocksPort: [1024, 65535],
  dailyRequestCap: [1, 1_000_000],
  timeoutMs: [30_000, 30 * 60_000],
  torBootstrapTimeoutMs: [10_000, 10 * 60_000],
  daemonReadyTimeoutMs: [5_000, 10 * 60_000],
  policyWarmTimeoutMs: [5_000, 10 * 60_000],
  settleTimeoutMs: [5_000, 30 * 60_000],
  maxResponseBytes: [1024, 4 * 1024 * 1024],
};

const SETTINGS_KEYS = new Set<string>([
  ...Object.keys(INTEGER_BOUNDS),
  'tor',
  'fundingDate',
  'depositUsd',
  'acknowledgements',
  'dailySpendCapUsd',
  'daemonExecutable',
  'torExecutable',
]);

/**
 * Parse the `zkapi` block of a zkapi model profile. Unknown keys refuse: this
 * block guards money, and a misspelt setting must not silently mean "unset".
 */
export function parseZkapiConsultSettings(value: unknown, label: string): ZkapiConsultSettings {
  const record = value === undefined ? {} : value;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new OperationError('config_error', `${label} must be an object.`);
  }
  const input = record as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!SETTINGS_KEYS.has(key)) {
      throw new OperationError('config_error', `${label}.${key} is not a zkAPI consult setting.`);
    }
  }
  const settings: ZkapiConsultSettings = {
    tor: DEFAULTS.tor,
    torSocksPort: DEFAULTS.torSocksPort,
    acknowledgements: parseAcknowledgements(input.acknowledgements, `${label}.acknowledgements`),
    timeoutMs: DEFAULTS.timeoutMs,
    torBootstrapTimeoutMs: DEFAULTS.torBootstrapTimeoutMs,
    daemonReadyTimeoutMs: DEFAULTS.daemonReadyTimeoutMs,
    policyWarmTimeoutMs: DEFAULTS.policyWarmTimeoutMs,
    settleTimeoutMs: DEFAULTS.settleTimeoutMs,
    maxResponseBytes: DEFAULTS.maxResponseBytes,
  };
  for (const [key, [min, max]] of Object.entries(INTEGER_BOUNDS) as Array<[IntegerSetting, [number, number]]>) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
      throw new OperationError('config_error', `${label}.${key} must be an integer from ${min} to ${max}.`);
    }
    settings[key] = raw;
  }
  if (input.tor !== undefined) {
    if (input.tor !== 'per_consult' && input.tor !== 'off') {
      throw new OperationError('config_error', `${label}.tor must be "per_consult" or "off".`);
    }
    settings.tor = input.tor;
  }
  if (input.fundingDate !== undefined) {
    if (typeof input.fundingDate !== 'string' || parseIsoDate(input.fundingDate) === undefined) {
      throw new OperationError('config_error', `${label}.fundingDate must be a calendar date in YYYY-MM-DD form.`);
    }
    settings.fundingDate = input.fundingDate;
  }
  for (const key of ['depositUsd', 'dailySpendCapUsd'] as const) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > 10_000) {
      throw new OperationError('config_error', `${label}.${key} must be a positive number of US dollars.`);
    }
    settings[key] = raw;
  }
  for (const key of ['daemonExecutable', 'torExecutable'] as const) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || !raw.startsWith('/')) {
      throw new OperationError('config_error', `${label}.${key} must be an absolute path.`);
    }
    settings[key] = raw;
  }
  return settings;
}

/**
 * The daemon's API base must be a plain loopback HTTP origin ending in /v1:
 * no credentials, query or fragment, so nothing can ride in the URL.
 */
export function assertZkapiDaemonBaseUrl(id: string, baseUrl: string | undefined): void {
  let url: URL;
  try {
    url = new URL(baseUrl ?? '');
  } catch {
    throw new OperationError(
      'config_error',
      `Sovereignty zkapi profile "${id}" requires a loopback baseUrl such as ${ZKAPI_DAEMON_DEFAULT_BASE_URL}.`,
    );
  }
  if (
    url.protocol !== 'http:'
    || !isLoopbackHost(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname.replace(/\/+$/, '') !== '/v1'
  ) {
    throw new OperationError(
      'config_error',
      `Sovereignty zkapi profile "${id}" baseUrl must be the daemon's loopback API, such as ${ZKAPI_DAEMON_DEFAULT_BASE_URL}.`,
      'zkapi-clientd serves only on a numeric loopback address; Olympus never reaches it over a network.',
    );
  }
}

// Every loopback port a zkAPI daemon is known on, in this process: the
// default, each validated zkapi profile's port, and each zkapi profile in the
// owner's sovereignty policy file, which the guard reads itself on first use
// and again whenever the file changes, so no caller has to have validated a
// policy first. Ports are only ever added: forgetting a daemon would reopen a
// path for evidence. A daemon on a port no policy names cannot be detected by
// port; telling it apart would need the daemon identity probe, which is not
// appropriate on every model request.
const zkapiDaemonPorts = new Set<number>([ZKAPI_DAEMON_DEFAULT_PORT]);
// Fail closed: while a policy file exists that cannot be stat'ed, read, parsed
// or validated, its zkapi ports are unknown, so every local model endpoint is
// refused. A policy that cannot be read also stops the engine, so this costs no
// working setup. Only a successful read is cached; a failure is retried on the
// next use, so a repaired file takes effect at once.
const policyFile: { seen: string | undefined; unreadable: string | undefined } = { seen: undefined, unreadable: undefined };

export function registerZkapiDaemonPorts(ports: Iterable<number>): void {
  for (const port of ports) zkapiDaemonPorts.add(port);
}

export function zkapiDaemonPortSet(): ReadonlySet<number> {
  refreshZkapiPortsFromPolicyFile();
  return zkapiDaemonPorts;
}

export function sovereigntyPolicyPath(env: Record<string, string | undefined> = process.env): string {
  return env.OLYMPUS_SOVEREIGNTY_CONFIG?.trim()
    || env.OLYMPUS_SOVEREIGNTY_CONFIG_PATH?.trim()
    || join(env.HOME?.trim() || homedir(), '.olympus', 'sovereignty.json');
}

/** The policy file that currently cannot be read, if any. */
export function unreadableSovereigntyPolicy(): string | undefined {
  refreshZkapiPortsFromPolicyFile();
  return policyFile.unreadable;
}

/**
 * Reads the owner's policy file for zkapi profiles. Cheap when the file has
 * not changed: the cache key is its device, inode, size, and modification and
 * status-change times (a rewrite always moves the status-change time).
 */
export function refreshZkapiPortsFromPolicyFile(env: Record<string, string | undefined> = process.env): void {
  const path = sovereigntyPolicyPath(env);
  let stamp: string;
  try {
    const stat = statSync(path);
    stamp = `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      policyFile.seen = `${path}:absent`;
      policyFile.unreadable = undefined;
    } else {
      policyFile.seen = undefined;
      policyFile.unreadable = path;
    }
    return;
  }
  if (policyFile.seen === stamp && policyFile.unreadable === undefined) return;
  try {
    const ports = zkapiPortsInPolicy(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    for (const port of ports) zkapiDaemonPorts.add(port);
    policyFile.seen = stamp;
    policyFile.unreadable = undefined;
  } catch {
    policyFile.seen = undefined;
    policyFile.unreadable = path;
  }
}

/** The zkapi ports a parsed policy names; throws when the snapshot is not a policy. */
function zkapiPortsInPolicy(parsed: unknown): number[] {
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  if (!record) throw new Error('not a policy object');
  const inner = record.sovereignty && typeof record.sovereignty === 'object' ? record.sovereignty as Record<string, unknown> : record;
  const profiles = inner.modelProfiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) throw new Error('policy has no modelProfiles');
  const ports: number[] = [];
  for (const profile of Object.values(profiles as Record<string, unknown>)) {
    if (!profile || typeof profile !== 'object') throw new Error('malformed profile');
    const entry = profile as Record<string, unknown>;
    if (entry.provider !== 'zkapi') continue;
    const port = loopbackPort(typeof entry.baseUrl === 'string' ? entry.baseUrl : undefined);
    if (port === undefined) throw new Error('zkapi profile without a loopback baseUrl');
    ports.push(port);
  }
  return ports;
}

function endpointPort(parsed: URL): number {
  return parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
}

/**
 * Refuse an evidence adapter's endpoint when it is, or may be, a zkAPI daemon:
 * that loopback address forwards to OpenRouter and the upstream model.
 * Synchronous, for policy validation, constructors and dispatch:
 *   - a local address on a known daemon port;
 *   - any host name on a known daemon port (a name can be re-pointed at this
 *     machine; local models there must use a numeric loopback address);
 *   - while the policy file cannot be read, every local address.
 */
export function assertNotZkapiDaemonEndpoint(url: string, label: string): void {
  refreshZkapiPortsFromPolicyFile();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  const port = endpointPort(parsed);
  const local = loopbackPort(url) !== undefined;
  if (local && policyFile.unreadable) {
    throw new ZkapiDaemonEndpointRefusal('policy_unreadable', `${label} is a local endpoint, and the sovereignty policy at ${policyFile.unreadable} cannot be read to rule out a zkAPI daemon on port ${port}.`, policyFile.unreadable);
  }
  if (!zkapiDaemonPorts.has(port)) return;
  if (local) {
    throw new ZkapiDaemonEndpointRefusal('daemon_port', `${label} points at port ${port}, where a zkAPI daemon serves; it forwards to cloud providers and may never receive evidence.`);
  }
  if (!isIP(parsed.hostname.replace(/^\[|\]$/g, ''))) {
    throw new ZkapiDaemonEndpointRefusal('hostname_on_daemon_port', `${label} names a host on port ${port}, a zkAPI daemon port; a host name could point at this machine.`);
  }
}

/**
 * The dispatch-time form. Adds one case the synchronous check cannot settle:
 * while the policy file cannot be read, a host name on any port might point at
 * this machine, so it is resolved (bounded) and refused if it does, or if it
 * cannot be resolved in time.
 */
export async function assertNotZkapiDaemonEndpointResolved(
  url: string,
  label: string,
  lookupAll: (hostname: string) => Promise<string[]> = defaultLookupAll,
): Promise<void> {
  assertNotZkapiDaemonEndpoint(url, label);
  const unreadable = policyFile.unreadable;
  if (!unreadable) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return;
  const port = endpointPort(parsed);
  const refuse = (): never => {
    throw new ZkapiDaemonEndpointRefusal('policy_unreadable', `${label} may be a local endpoint, and the sovereignty policy at ${unreadable} cannot be read to rule out a zkAPI daemon on port ${port}.`, unreadable);
  };
  let addresses: string[];
  try {
    addresses = await Promise.race([
      lookupAll(host),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('lookup timed out')), 2_000).unref?.()),
    ]);
  } catch {
    return refuse();
  }
  if (addresses.some((address) => loopbackPort(`http://${address.includes(':') ? `[${address}]` : address}:${port}`) !== undefined)) refuse();
}

async function defaultLookupAll(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true })).map((entry) => entry.address);
}

export type ZkapiDaemonEndpointRefusalReason = 'daemon_port' | 'hostname_on_daemon_port' | 'policy_unreadable';

/** A configuration refusal, not an outage: callers rethrow it as-is and never retry. */
export class ZkapiDaemonEndpointRefusal extends OperationError {
  readonly reason: ZkapiDaemonEndpointRefusalReason;

  constructor(reason: ZkapiDaemonEndpointRefusalReason, message: string, policyPath?: string) {
    super('config_error', message, refusalSuggestion(reason, policyPath));
    this.name = 'ZkapiDaemonEndpointRefusal';
    this.reason = reason;
  }
}

function refusalSuggestion(reason: ZkapiDaemonEndpointRefusalReason, policyPath: string | undefined): string {
  if (reason === 'policy_unreadable') {
    return `Fix or remove the sovereignty policy file at ${policyPath ?? 'its configured path'}; until it can be read, Olympus refuses every local model endpoint.`;
  }
  if (reason === 'hostname_on_daemon_port') {
    return 'Use a numeric address: a cloud endpoint on its own port, or 127.0.0.1 for a local model, which must then not share a zkAPI daemon port.';
  }
  return 'This address is the zkAPI daemon, which only carries consults. Point this model at a local model server on another port.';
}

export function isZkapiDaemonEndpointRefusal(error: unknown): error is ZkapiDaemonEndpointRefusal {
  return error instanceof ZkapiDaemonEndpointRefusal;
}


/**
 * The local port a URL names, or undefined when it does not reach this
 * machine. Covers every form that does: `localhost` and `*.localhost`, all of
 * 127.0.0.0/8 (WHATWG URL parsing already turns decimal, hex and octal forms
 * into dotted quads), 0.0.0.0, `::1`, `::`, and IPv4-mapped or -compatible
 * IPv6 forms of those.
 */
export function loopbackPort(baseUrl: string | undefined): number | undefined {
  if (!baseUrl) return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLoopbackHost(url.hostname)) return undefined;
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return Number(v4[1]) === 127 || host === '0.0.0.0';
  if (!host.startsWith('[') || !host.endsWith(']')) return false;
  const words = ipv6Words(host.slice(1, -1));
  if (!words) return false;
  if (words.slice(0, 7).every((word) => word === 0) && (words[7] === 1 || words[7] === 0)) return true;
  const mapped = words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || words[5] === 0);
  return mapped && ((words[6]! >> 8) === 127 || (words[6] === 0 && words[7] === 0));
}

function ipv6Words(text: string): number[] | undefined {
  let body = text;
  const tail: number[] = [];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(body);
  if (dotted) {
    const bytes = dotted.slice(1).map(Number);
    if (bytes.some((byte) => byte > 255)) return undefined;
    tail.push((bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!);
    body = text.slice(0, dotted.index);
    if (!body.endsWith('::')) body = body.replace(/:$/, '');
  }
  const halves = body.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] => (part ? part.split(':').map((word) => parseInt(word, 16)) : []);
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if ([...head, ...rest].some((word) => Number.isNaN(word) || word < 0 || word > 0xffff)) return undefined;
  const fill = 8 - head.length - rest.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return undefined;
  return [...head, ...Array<number>(fill).fill(0), ...rest, ...tail];
}

/** Parse YYYY-MM-DD as a UTC midnight, refusing impossible dates. */
export function parseIsoDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return undefined;
  return date;
}

function parseAcknowledgements(value: unknown, label: string): ZkapiConsultSettings['acknowledgements'] {
  if (value === undefined) return { version: 0, accepted: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('config_error', `${label} must be an object with version and accepted.`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.version !== 'number' || !Number.isInteger(record.version) || record.version < 0) {
    throw new OperationError('config_error', `${label}.version must be a non-negative integer.`);
  }
  if (!Array.isArray(record.accepted) || !record.accepted.every((item) => typeof item === 'string')) {
    throw new OperationError('config_error', `${label}.accepted must be a string array.`);
  }
  return { version: record.version, accepted: [...new Set(record.accepted as string[])] };
}

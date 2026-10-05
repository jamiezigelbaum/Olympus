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
  dailyRequestCap: 10,
  /** Worst case per request is the model's daemon allowance, $1 to $6 today. */
  dailySpendCapUsd: 20,
  /** The reference measures 3 to 4.5 minutes per request; never kill a slow call early. */
  timeoutMs: 6 * 60 * 1000,
  /** zkapi-tor-cli.sh gives Tor its ready budget minus 30 s: 240 - 30. */
  torBootstrapTimeoutMs: 210 * 1000,
  daemonReadyTimeoutMs: 120 * 1000,
  /** zkapi-tor-cli.sh `warm_policy` waits up to 180 s for the model policy. */
  policyWarmTimeoutMs: 180 * 1000,
  /** zkapi-tor-cli.sh `ensure_ready` waits up to 180 s for settlement. */
  settleTimeoutMs: 180 * 1000,
  maxResponseBytes: 256 * 1024,
};
export const ZKAPI_SETTING_DEFAULTS: Readonly<typeof DEFAULTS> = DEFAULTS;

/**
 * The six statements of design §Z.3, in plain words. The version moves when the
 * wording or the set changes, which voids every earlier acknowledgement.
 */
export const ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION = 1;
export const ZKAPI_RISK_ACKNOWLEDGEMENTS = [
  {
    id: 'deposit_fee',
    statement: 'Depositing is an expensive on-chain transaction. Its fee can be larger than a small deposit.',
  },
  {
    id: 'withdrawal_fee',
    statement: 'Getting unspent money back is a second expensive transaction and needs more ETH sent for its fee.',
  },
  {
    id: 'note_expiry_30_days',
    statement: 'A deposit that is not withdrawn within 30 days becomes claimable in full by the operator. Olympus only estimates that date from the funding date you confirm; the real one is set on-chain by the deposit block.',
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
  dailyRequestCap: number;
  /** Daily worst-case spend: each request reserves its model's full allowance. */
  dailySpendCapUsd: number;
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
  dailyRequestCap: [1, 100],
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
    dailyRequestCap: DEFAULTS.dailyRequestCap,
    dailySpendCapUsd: DEFAULTS.dailySpendCapUsd,
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

/** The loopback port a URL names, or undefined when it is not loopback HTTP(S). */
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
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
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

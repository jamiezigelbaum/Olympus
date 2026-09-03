import { createHash } from 'node:crypto';

import type {
  CounterpartyCandidate,
  Erc8004Claim,
  HireListing,
  VerifiedErc8004Identity,
} from './types.ts';
import { HireBrokerError, normalizeHttpEndpoint } from './types.ts';

const IDENTITY_REGISTRY_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const AGENT_EXISTS_SELECTOR = 'de99f157';
const OWNER_OF_SELECTOR = '6352211e';
const TOKEN_URI_SELECTOR = 'c87b56dd';
const MAX_JSON_BYTES = 256 * 1024;

export const DEFAULT_ERC8004_RPC_ENDPOINTS = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  base: 'https://mainnet.base.org',
} as const;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ResolvedAgentCard {
  cardHash: string;
  declaredEndpoint: string;
}

export interface AgentCardResolver {
  resolve(endpoint: string): Promise<ResolvedAgentCard>;
}

export interface Erc8004IdentityVerifier {
  verify(claim: Erc8004Claim, expectedEndpoint: string): Promise<VerifiedErc8004Identity>;
}

export class CounterpartyIdentityResolver {
  constructor(
    private readonly agentCards: AgentCardResolver,
    private readonly identityVerifier: Erc8004IdentityVerifier,
  ) {}

  async resolve(listing: HireListing): Promise<CounterpartyCandidate> {
    const agentCard = await this.agentCards.resolve(listing.endpoint);
    if (!sameEndpoint(agentCard.declaredEndpoint, listing.endpoint)) {
      throw new HireBrokerError(
        'identity_mismatch',
        'Agent card service endpoint does not match the proposed counterparty endpoint.',
        409,
      );
    }
    if (!listing.erc8004) {
      return {
        name: listing.name,
        endpoint: listing.endpoint,
        agentCardHash: agentCard.cardHash,
        identity: { status: 'unverified_identity' },
      };
    }
    const identity = await this.identityVerifier.verify(listing.erc8004, listing.endpoint);
    return {
      name: listing.name,
      endpoint: listing.endpoint,
      agentCardHash: agentCard.cardHash,
      identity,
    };
  }
}

export class HttpAgentCardResolver implements AgentCardResolver {
  constructor(
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly options: { allowLoopback?: boolean } = {},
  ) {}

  async resolve(endpoint: string): Promise<ResolvedAgentCard> {
    assertFetchableEndpoint(endpoint, this.options.allowLoopback === true);
    const url = new URL('/.well-known/agent-card.json', `${endpoint}/`);
    const card = await fetchJsonObject(this.fetchImpl, url, 'Agent card');
    return {
      cardHash: createHash('sha256').update(canonicalJson(card)).digest('hex'),
      declaredEndpoint: declaredA2aEndpoint(card),
    };
  }
}

export class ReadOnlyErc8004IdentityVerifier implements Erc8004IdentityVerifier {
  private readonly rpcEndpoints: Record<Erc8004Claim['chain'], string>;

  constructor(
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    options: {
      rpcEndpoints?: Partial<Record<Erc8004Claim['chain'], string>>;
      ipfsGateway?: string;
      allowLoopback?: boolean;
    } = {},
  ) {
    this.rpcEndpoints = { ...DEFAULT_ERC8004_RPC_ENDPOINTS, ...options.rpcEndpoints };
    this.ipfsGateway = options.ipfsGateway ?? 'https://ipfs.io/ipfs/';
    this.allowLoopback = options.allowLoopback === true;
  }

  private readonly ipfsGateway: string;
  private readonly allowLoopback: boolean;

  async verify(claim: Erc8004Claim, expectedEndpoint: string): Promise<VerifiedErc8004Identity> {
    try {
      const agentId = encodeUint256(claim.agentId);
      const exists = decodeBool(await this.ethCall(claim.chain, `${AGENT_EXISTS_SELECTOR}${agentId}`));
      if (!exists) {
        throw new HireBrokerError('identity_verification_failed', 'Claimed identity is not registered.', 409);
      }
      const owner = decodeAddress(await this.ethCall(claim.chain, `${OWNER_OF_SELECTOR}${agentId}`));
      const tokenURI = decodeAbiString(await this.ethCall(claim.chain, `${TOKEN_URI_SELECTOR}${agentId}`));
      const registrationCard = await this.fetchRegistrationCard(tokenURI);
      const registeredEndpoint = declaredA2aEndpoint(registrationCard);
      if (!sameEndpoint(registeredEndpoint, expectedEndpoint)) {
        throw new HireBrokerError(
          'identity_mismatch',
          'Registered identity service endpoint does not match the proposed counterparty endpoint.',
          409,
        );
      }
      return {
        status: 'verified',
        chain: claim.chain,
        agentId: claim.agentId,
        owner,
        tokenURI,
        registeredEndpoint,
      };
    } catch (error) {
      if (error instanceof HireBrokerError) throw error;
      throw new HireBrokerError(
        'identity_verification_failed',
        'Claimed identity could not be verified read-only.',
        503,
      );
    }
  }

  private async ethCall(chain: Erc8004Claim['chain'], data: string): Promise<string> {
    const endpoint = this.rpcEndpoints[chain];
    assertFetchableEndpoint(endpoint, this.allowLoopback);
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: IDENTITY_REGISTRY_ADDRESS, data: `0x${data}` }, 'latest'],
      }),
    });
    if (!response.ok) throw new Error(`rpc_status_${response.status}`);
    const payload = await parseBoundedJson(response);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('rpc_shape');
    const result = (payload as Record<string, unknown>).result;
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) throw new Error('rpc_result');
    return result;
  }

  private async fetchRegistrationCard(tokenURI: string): Promise<Record<string, unknown>> {
    if (tokenURI.startsWith('data:application/json,')) {
      const encoded = tokenURI.slice('data:application/json,'.length);
      return parseJsonObject(decodeURIComponent(encoded), 'Registration card');
    }
    if (tokenURI.startsWith('data:application/json;base64,')) {
      const encoded = tokenURI.slice('data:application/json;base64,'.length);
      return parseJsonObject(Buffer.from(encoded, 'base64').toString('utf8'), 'Registration card');
    }
    const resolved = tokenURI.startsWith('ipfs://')
      ? new URL(tokenURI.slice('ipfs://'.length), ensureTrailingSlash(this.ipfsGateway))
      : new URL(tokenURI);
    assertFetchableEndpoint(resolved.toString(), this.allowLoopback);
    return fetchJsonObject(this.fetchImpl, resolved, 'Registration card');
  }
}

function declaredA2aEndpoint(card: Record<string, unknown>): string {
  const endpoints = new Set<string>();
  addEndpoint(endpoints, card.url);
  addEndpoint(endpoints, card.endpoint);

  const services = card.services;
  if (Array.isArray(services)) {
    for (const value of services) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const service = value as Record<string, unknown>;
      const kind = firstString(service.name, service.type, service.protocol)?.toLowerCase();
      if (kind?.includes('a2a') || kind?.includes('agent')) {
        addEndpoint(endpoints, service.endpoint);
        addEndpoint(endpoints, service.url);
      }
    }
  }
  if (endpoints.size !== 1) {
    throw new HireBrokerError(
      'identity_verification_failed',
      'Agent registration card must declare exactly one unambiguous A2A endpoint.',
      409,
    );
  }
  return [...endpoints][0]!;
}

function addEndpoint(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) return;
  target.add(normalizeHttpEndpoint(value.trim()));
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function sameEndpoint(left: string, right: string): boolean {
  return normalizeHttpEndpoint(left) === normalizeHttpEndpoint(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function fetchJsonObject(fetchImpl: FetchLike, url: string | URL, label: string): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new HireBrokerError('identity_verification_failed', `${label} could not be fetched.`, 503);
  }
  return parseJsonObject(await response.text(), label);
}

async function parseBoundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw new Error('oversize_json');
  return JSON.parse(text) as unknown;
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) {
    throw new HireBrokerError('identity_verification_failed', `${label} is too large.`, 409);
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HireBrokerError) throw error;
    throw new HireBrokerError('identity_verification_failed', `${label} is malformed.`, 409);
  }
}

function encodeUint256(decimal: string): string {
  return BigInt(decimal).toString(16).padStart(64, '0');
}

function decodeBool(value: string): boolean {
  const word = abiWord(value, 0);
  if (word !== 0n && word !== 1n) throw new Error('invalid_bool');
  return word === 1n;
}

function decodeAddress(value: string): string {
  const hex = stripHex(value);
  if (hex.length < 64) throw new Error('invalid_address');
  return `0x${hex.slice(24, 64).toLowerCase()}`;
}

function decodeAbiString(value: string): string {
  const hex = stripHex(value);
  const offset = Number(abiWord(value, 0));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_string_offset');
  const lengthStart = offset * 2;
  if (lengthStart + 64 > hex.length) throw new Error('invalid_string_length');
  const length = Number(BigInt(`0x${hex.slice(lengthStart, lengthStart + 64)}`));
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_JSON_BYTES) throw new Error('invalid_string_length');
  const dataStart = lengthStart + 64;
  const dataEnd = dataStart + length * 2;
  if (dataEnd > hex.length) throw new Error('invalid_string_data');
  return Buffer.from(hex.slice(dataStart, dataEnd), 'hex').toString('utf8');
}

function abiWord(value: string, index: number): bigint {
  const hex = stripHex(value);
  const start = index * 64;
  if (start + 64 > hex.length) throw new Error('invalid_abi_word');
  return BigInt(`0x${hex.slice(start, start + 64)}`);
}

function stripHex(value: string): string {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) throw new Error('invalid_hex');
  return value.slice(2);
}

function assertFetchableEndpoint(value: string, allowLoopback: boolean): void {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (!allowLoopback && (host === 'localhost' || host.endsWith('.local') || isPrivateIpLiteral(host))) {
    throw new HireBrokerError('identity_verification_failed', 'Private or loopback identity endpoints are refused.', 409);
  }
}

function isPrivateIpLiteral(host: string): boolean {
  // URL parsing keeps an IPv6 literal inside its brackets, so the v6 rules can
  // only be applied there: a registered name that merely begins "fd" is a name,
  // not a unique-local address.
  if (host.startsWith('[') && host.endsWith(']')) {
    const literal = host.slice(1, -1);
    if (literal === '::' || literal === '::1'
      || literal.startsWith('fc') || literal.startsWith('fd') || literal.startsWith('fe80:')) {
      return true;
    }
    const mapped = mappedIpv4Literal(literal);
    return mapped !== undefined && isPrivateIpv4Literal(mapped);
  }
  return isPrivateIpv4Literal(host);
}

function isPrivateIpv4Literal(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return true;
  // 0.0.0.0/8 is "this host" and connects to loopback on Linux and macOS.
  return octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

/** `::ffff:127.0.0.1` normalizes to `::ffff:7f00:1`; judge it as the IPv4 it is. */
function mappedIpv4Literal(literal: string): string | undefined {
  const mapped = /^::ffff:([0-9a-f.:]+)$/.exec(literal);
  if (!mapped) return undefined;
  const suffix = mapped[1]!;
  if (suffix.includes('.')) return suffix;
  const groups = suffix.split(':');
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  const value = Number.parseInt(groups[0]!, 16) * 0x1_0000 + Number.parseInt(groups[1]!, 16);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

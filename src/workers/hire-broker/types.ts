export type HireBrokerRefusalCode =
  | 'invalid_request'
  | 'owner_confirmation_required'
  | 'owner_confirmation_denied'
  | 'release_denied'
  | 'release_approval_required'
  | 'identity_verification_failed'
  | 'identity_mismatch'
  | 'registry_corrupt'
  | 'ledger_corrupt'
  | 'state_write_failed'
  | 'payment_provider_unavailable'
  | 'payment_cap_refused'
  | 'payment_failed'
  | 'transport_failed'
  | 'report_unavailable'
  | 'owner_authorization_required';

export class HireBrokerError extends Error {
  constructor(
    readonly code: HireBrokerRefusalCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type Erc8004Chain = 'ethereum' | 'arbitrum' | 'base';

export interface Erc8004Claim {
  chain: Erc8004Chain;
  agentId: string;
}

export interface HireListing {
  name: string;
  endpoint: string;
  erc8004?: Erc8004Claim;
}

export interface HireBudget {
  amount: number;
  currency: string;
}

export interface VerifiedErc8004Identity {
  status: 'verified';
  chain: Erc8004Chain;
  agentId: string;
  owner: string;
  tokenURI: string;
  registeredEndpoint: string;
}

export interface UnverifiedIdentity {
  status: 'unverified_identity';
}

export type CounterpartyIdentity = VerifiedErc8004Identity | UnverifiedIdentity;

export interface SpendRecord {
  handle: string;
  amount: number;
  currency: string;
  recordedAt: string;
  outcome: 'authorized' | 'submitted' | 'completed' | 'failed';
  paymentReference?: string;
}

export interface CounterpartyRecord {
  name: string;
  endpoint: string;
  agentCardHash: string;
  erc8004?: {
    chain: Erc8004Chain;
    agentId: string;
    owner: string;
    tokenURI: string;
  };
  firstApprovedAt: string;
  spendHistory: SpendRecord[];
}

export interface CounterpartyCandidate {
  name: string;
  endpoint: string;
  agentCardHash: string;
  identity: CounterpartyIdentity;
}

export interface CounterpartyDecision {
  kind: 'approved' | 'needs_owner_confirm';
  reasons: string[];
  candidate: CounterpartyCandidate;
  existing?: CounterpartyRecord;
}

export interface LedgerEntryBody {
  at: string;
  event:
    | 'hire_requested'
    | 'owner_confirmation_required'
    | 'owner_approved'
    | 'release_decided'
    | 'payment_intent'
    | 'task_submitted'
    | 'report_received'
    | 'hire_refused';
  handle?: string;
  counterparty?: string;
  endpoint?: string;
  identityStatus?: CounterpartyIdentity['status'];
  identityChain?: Erc8004Chain;
  identityAgentId?: string;
  gateDecision?: 'allow' | 'redact' | 'needs_approval' | 'deny';
  amount?: number;
  currency?: string;
  outcome?: string;
  reasonCode?: HireBrokerRefusalCode;
}

export interface LedgerEntry extends LedgerEntryBody {
  version: 1;
  sequence: number;
  previousHash: string;
  entryHash: string;
}

export function parseHireListing(value: unknown): HireListing {
  const record = exactRecord(value, 'listing', ['name', 'endpoint', 'erc8004']);
  const name = requiredString(record.name, 'listing.name', 160);
  const endpoint = normalizeHttpEndpoint(requiredString(record.endpoint, 'listing.endpoint', 2_048));
  if (record.erc8004 === undefined) return { name, endpoint };

  const claim = exactRecord(record.erc8004, 'listing.erc8004', ['chain', 'agentId']);
  const chain = requiredString(claim.chain, 'listing.erc8004.chain', 32);
  if (chain !== 'ethereum' && chain !== 'arbitrum' && chain !== 'base') {
    throw invalid('listing.erc8004.chain must be ethereum, arbitrum, or base.');
  }
  const agentId = requiredString(claim.agentId, 'listing.erc8004.agentId', 78);
  if (!/^(?:0|[1-9][0-9]*)$/.test(agentId)) {
    throw invalid('listing.erc8004.agentId must be a non-negative decimal integer.');
  }
  return { name, endpoint, erc8004: { chain, agentId } };
}

export function parseHireBudget(value: unknown): HireBudget {
  const record = exactRecord(value, 'budget', ['amount', 'currency']);
  if (typeof record.amount !== 'number' || !Number.isFinite(record.amount) || record.amount <= 0) {
    throw invalid('budget.amount must be a positive finite number.');
  }
  const currency = requiredString(record.currency, 'budget.currency', 16).toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,15}$/.test(currency)) {
    throw invalid('budget.currency must be a safe currency identifier.');
  }
  return { amount: record.amount, currency };
}

export function normalizeHttpEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('Counterparty endpoint must be an absolute HTTP(S) URL.');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.hash) {
    throw invalid('Counterparty endpoint must be a credential-free HTTP(S) URL.');
  }
  if (url.protocol === 'http:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw invalid('Remote counterparty endpoints must use HTTPS.');
  }
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

export function exactRecord(
  value: unknown,
  name: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${name} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw invalid(`${name} contains an unsupported field.`);
  }
  return record;
}

export function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f]/.test(value)) {
    throw invalid(`${name} must be a non-empty bounded string.`);
  }
  return value.trim();
}

export function invalid(message: string): HireBrokerError {
  return new HireBrokerError('invalid_request', message, 400);
}

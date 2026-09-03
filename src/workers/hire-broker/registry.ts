import { dirname } from 'node:path';

import { atomicWritePrivate, readPrivateFile, secureDirectory } from './secure-files.ts';
import type {
  CounterpartyCandidate,
  CounterpartyDecision,
  CounterpartyRecord,
  SpendRecord,
} from './types.ts';
import { HireBrokerError } from './types.ts';

interface RegistryFile {
  version: 1;
  counterparties: CounterpartyRecord[];
}

export class CounterpartyRegistry {
  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    await secureDirectory(dirname(this.path));
    await this.load();
  }

  async evaluate(candidate: CounterpartyCandidate): Promise<CounterpartyDecision> {
    const state = await this.load();
    const existing = state.counterparties.find((entry) => entry.name === candidate.name);
    if (!existing) {
      return { kind: 'needs_owner_confirm', reasons: ['new_counterparty'], candidate };
    }
    const reasons: string[] = [];
    if (existing.endpoint !== candidate.endpoint) reasons.push('endpoint_drift');
    if (existing.agentCardHash !== candidate.agentCardHash) reasons.push('agent_card_hash_drift');
    const previousIdentity = existing.erc8004;
    if (candidate.identity.status === 'verified') {
      if (!previousIdentity
        || previousIdentity.chain !== candidate.identity.chain
        || previousIdentity.agentId !== candidate.identity.agentId) {
        reasons.push('identity_claim_drift');
      }
      if (previousIdentity && previousIdentity.owner !== candidate.identity.owner) reasons.push('erc8004_owner_drift');
      if (previousIdentity && previousIdentity.tokenURI !== candidate.identity.tokenURI) reasons.push('erc8004_token_uri_drift');
    } else if (previousIdentity) {
      reasons.push('identity_claim_removed');
    }
    return reasons.length > 0
      ? { kind: 'needs_owner_confirm', reasons, candidate, existing }
      : { kind: 'approved', reasons: [], candidate, existing };
  }

  async approve(candidate: CounterpartyCandidate): Promise<CounterpartyRecord> {
    const state = await this.load();
    const existingIndex = state.counterparties.findIndex((entry) => entry.name === candidate.name);
    const previous = existingIndex >= 0 ? state.counterparties[existingIndex] : undefined;
    const record: CounterpartyRecord = {
      name: candidate.name,
      endpoint: candidate.endpoint,
      agentCardHash: candidate.agentCardHash,
      ...(candidate.identity.status === 'verified'
        ? {
          erc8004: {
            chain: candidate.identity.chain,
            agentId: candidate.identity.agentId,
            owner: candidate.identity.owner,
            tokenURI: candidate.identity.tokenURI,
          },
        }
        : {}),
      firstApprovedAt: previous?.firstApprovedAt ?? this.now().toISOString(),
      spendHistory: previous?.spendHistory ?? [],
    };
    if (existingIndex >= 0) state.counterparties[existingIndex] = record;
    else state.counterparties.push(record);
    await this.save(state);
    return record;
  }

  async recordSpend(counterpartyName: string, spend: SpendRecord): Promise<void> {
    const state = await this.load();
    const record = state.counterparties.find((entry) => entry.name === counterpartyName);
    if (!record) {
      throw new HireBrokerError('registry_corrupt', 'Approved counterparty is missing from the registry.', 503);
    }
    record.spendHistory.push(spend);
    await this.save(state);
  }

  async list(): Promise<CounterpartyRecord[]> {
    return structuredClone((await this.load()).counterparties);
  }

  private async load(): Promise<RegistryFile> {
    const raw = await readPrivateFile(this.path);
    if (raw === undefined) return { version: 1, counterparties: [] };
    try {
      return parseRegistry(JSON.parse(raw) as unknown);
    } catch (error) {
      if (error instanceof HireBrokerError) throw error;
      throw new HireBrokerError('registry_corrupt', 'Hire Broker counterparty registry is corrupt.', 503);
    }
  }

  private async save(state: RegistryFile): Promise<void> {
    await atomicWritePrivate(this.path, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function parseRegistry(value: unknown): RegistryFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt();
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.counterparties)) throw corrupt();
  const counterparties = record.counterparties.map(parseCounterparty);
  if (new Set(counterparties.map((entry) => entry.name)).size !== counterparties.length) throw corrupt();
  return { version: 1, counterparties };
}

function parseCounterparty(value: unknown): CounterpartyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt();
  const entry = value as CounterpartyRecord;
  if (typeof entry.name !== 'string'
    || typeof entry.endpoint !== 'string'
    || !/^[a-f0-9]{64}$/.test(entry.agentCardHash)
    || typeof entry.firstApprovedAt !== 'string'
    || !Array.isArray(entry.spendHistory)) {
    throw corrupt();
  }
  if (entry.erc8004 && (typeof entry.erc8004.owner !== 'string'
    || typeof entry.erc8004.tokenURI !== 'string'
    || typeof entry.erc8004.agentId !== 'string')) {
    throw corrupt();
  }
  for (const spend of entry.spendHistory) {
    if (!spend || typeof spend.amount !== 'number' || typeof spend.currency !== 'string') throw corrupt();
  }
  return structuredClone(entry);
}

function corrupt(): HireBrokerError {
  return new HireBrokerError('registry_corrupt', 'Hire Broker counterparty registry is corrupt.', 503);
}

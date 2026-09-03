import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

import { appendPrivateDurable, readPrivateFile, secureDirectory } from './secure-files.ts';
import type { LedgerEntry, LedgerEntryBody } from './types.ts';
import { HireBrokerError } from './types.ts';

const GENESIS_HASH = '0'.repeat(64);

export interface LedgerSummary {
  entries: number;
  lastSequence: number;
  lastHash: string;
  totals: Record<string, number>;
  outcomes: Record<string, number>;
}

export class HireLedger {
  private writeGate: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    await secureDirectory(dirname(this.path));
    await this.readEntries();
  }

  async append(body: LedgerEntryBody): Promise<LedgerEntry> {
    const previous = this.writeGate;
    let release = () => {};
    this.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const entries = await this.readEntries();
      const sequence = entries.length + 1;
      const previousHash = entries.at(-1)?.entryHash ?? GENESIS_HASH;
      const withoutHash = { version: 1 as const, sequence, previousHash, ...body };
      const entry: LedgerEntry = {
        ...withoutHash,
        entryHash: hashEntry(withoutHash),
      };
      await appendPrivateDurable(this.path, `${JSON.stringify(entry)}\n`);
      return entry;
    } finally {
      release();
    }
  }

  async summary(): Promise<LedgerSummary> {
    const entries = await this.readEntries();
    const totals: Record<string, number> = {};
    const outcomes: Record<string, number> = {};
    for (const entry of entries) {
      if (entry.amount !== undefined && entry.currency) {
        totals[entry.currency] = (totals[entry.currency] ?? 0) + entry.amount;
      }
      if (entry.outcome) outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;
    }
    return {
      entries: entries.length,
      lastSequence: entries.at(-1)?.sequence ?? 0,
      lastHash: entries.at(-1)?.entryHash ?? GENESIS_HASH,
      totals,
      outcomes,
    };
  }

  async assertWritable(): Promise<void> {
    await this.readEntries();
    await secureDirectory(dirname(this.path));
  }

  private async readEntries(): Promise<LedgerEntry[]> {
    const raw = await readPrivateFile(this.path);
    if (raw === undefined || raw === '') return [];
    if (!raw.endsWith('\n')) throw corrupt();
    const lines = raw.slice(0, -1).split('\n');
    const entries: LedgerEntry[] = [];
    let previousHash = GENESIS_HASH;
    for (let index = 0; index < lines.length; index += 1) {
      let value: unknown;
      try {
        value = JSON.parse(lines[index]!);
      } catch {
        throw corrupt();
      }
      const entry = parseEntry(value);
      if (entry.sequence !== index + 1 || entry.previousHash !== previousHash) throw corrupt();
      const { entryHash, ...withoutHash } = entry;
      if (entryHash !== hashEntry(withoutHash)) throw corrupt();
      previousHash = entryHash;
      entries.push(entry);
    }
    return entries;
  }
}

function parseEntry(value: unknown): LedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt();
  const entry = value as LedgerEntry;
  if (entry.version !== 1
    || !Number.isSafeInteger(entry.sequence)
    || typeof entry.at !== 'string'
    || typeof entry.event !== 'string'
    || !/^[a-f0-9]{64}$/.test(entry.previousHash)
    || !/^[a-f0-9]{64}$/.test(entry.entryHash)) {
    throw corrupt();
  }
  return entry;
}

function hashEntry(value: Omit<LedgerEntry, 'entryHash'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function corrupt(): HireBrokerError {
  return new HireBrokerError('ledger_corrupt', 'Hire Broker security ledger is corrupt.', 503);
}

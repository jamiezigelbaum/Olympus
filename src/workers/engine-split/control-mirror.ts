/**
 * The control thread's record of commands (control-worker.ts): what the
 * command socket answers from while the engine's loop is held.
 *
 * The ledger on the loop (commands.ts) stays the one place a command is
 * applied, and applies each id at most once. This mirror takes a command the
 * moment it arrives, answers "received" for it, and hands it to the loop by
 * message; the loop's word on it (received, done, failed) comes back by
 * message and replaces the mirror's. Nothing here runs a command.
 *
 * A message between threads can be lost (a Bun fault met in the read pool),
 * so the mirror keeps each command until the loop has settled it, and
 * `unsettled()` lists what to ask the loop about again: an id the loop does
 * not know is handed over again, which the ledger makes safe.
 */
import { createHash } from 'node:crypto';
import { EngineCommandError, type EngineCommandEnvelope, type EngineCommandReceipt, type EngineCommandRecords } from './commands.ts';

interface MirrorEntry {
  /** A digest of the command, to refuse a used id for a different one without keeping its body twice. */
  digest: string;
  receipt: EngineCommandReceipt;
  /** Kept until the loop settles it, to hand over again. */
  envelope?: EngineCommandEnvelope;
  settled: Promise<void>;
  settle: () => void;
  settledAt?: number;
}

export interface EngineCommandMirrorOptions {
  instanceId: string;
  /** Hands a command to the engine's loop. */
  send: (envelope: EngineCommandEnvelope) => void;
  /** How long the engine's loop has gone without a turn. */
  loopHeldMs?: () => number;
  now?: () => number;
  /** As the ledger's: settled records kept for retries, and for how long. */
  maxSettled?: number;
  retentionMs?: number;
}

export class EngineCommandMirror implements EngineCommandRecords {
  private readonly entries = new Map<string, MirrorEntry>();
  private readonly now: () => number;
  private readonly maxSettled: number;
  private readonly retentionMs: number;

  constructor(private readonly options: EngineCommandMirrorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxSettled = options.maxSettled ?? 1_000;
    this.retentionMs = options.retentionMs ?? 60 * 60_000;
  }

  get instanceId(): string { return this.options.instanceId; }

  /** Record a command and hand it to the loop, or return the record of the same id. */
  submit(envelope: EngineCommandEnvelope): EngineCommandReceipt {
    this.prune();
    const digest = createHash('sha256').update(JSON.stringify(envelope.command)).digest('hex');
    const existing = this.entries.get(envelope.id);
    if (existing) {
      if (existing.digest !== digest) throw new EngineCommandError(409, 'That command id was used for a different command.');
      return this.answer(existing);
    }
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const entry: MirrorEntry = {
      digest, envelope, settled, settle,
      receipt: { id: envelope.id, state: 'received', instance_id: this.options.instanceId },
    };
    this.entries.set(envelope.id, entry);
    this.options.send(envelope);
    return this.answer(entry);
  }

  get(id: string): EngineCommandReceipt | undefined {
    const entry = this.entries.get(id);
    return entry ? this.answer(entry) : undefined;
  }

  async settled(id: string, wait: Promise<void>): Promise<EngineCommandReceipt | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    await Promise.race([entry.settled, wait]);
    return this.answer(entry);
  }

  /**
   * The loop's word: its receipts for commands, and the ids it was asked
   * about and does not hold, which are handed over again.
   */
  apply(receipts: readonly EngineCommandReceipt[], unknown: readonly string[] = []): void {
    for (const receipt of receipts) {
      const entry = this.entries.get(receipt.id);
      if (!entry || entry.settledAt !== undefined) continue;
      entry.receipt = { ...receipt };
      if (receipt.state === 'received') continue;
      entry.settledAt = this.now();
      delete entry.envelope;
      entry.settle();
    }
    for (const id of unknown) {
      const entry = this.entries.get(id);
      if (entry?.envelope && entry.settledAt === undefined) this.options.send(entry.envelope);
    }
  }

  /** Commands the loop has not settled yet, oldest first. */
  unsettled(limit = 500): string[] {
    const ids: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.settledAt !== undefined) continue;
      ids.push(id);
      if (ids.length >= limit) break;
    }
    return ids;
  }

  private answer(entry: MirrorEntry): EngineCommandReceipt {
    if (entry.receipt.state !== 'received') return { ...entry.receipt };
    return { ...entry.receipt, loop_held_ms: Math.max(0, Math.round(this.options.loopHeldMs?.() ?? 0)) };
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    let settled = 0;
    for (const entry of this.entries.values()) if (entry.settledAt !== undefined) settled += 1;
    for (const [id, entry] of this.entries) {
      if (entry.settledAt === undefined) continue;
      if (entry.settledAt >= cutoff && settled <= this.maxSettled) break;
      this.entries.delete(id);
      settled -= 1;
    }
  }
}

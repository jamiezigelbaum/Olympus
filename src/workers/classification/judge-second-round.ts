// The second round of privacy judging (#891): the free judge on this computer
// sorts everything, and Venice double-checks ONLY the items it held Private.
// An item is released to Personal only on Venice's own Personal verdict.
// Items the local judge cleared, Secrets, rules, overrides and fail-safe holds
// never go to Venice. Venice runs on the same judge lane, spending cap and
// consent ledger as the "Venice sorts everything" choice (judge-setup.ts);
// a cap, a 402 or any Venice failure leaves the item Private, exactly as the
// local judge held it.
//
// Two halves, neither in the resolver:
// - `secondRoundJudge` wraps the sniffer model: the local answer comes first,
//   and only a Private one is asked again of Venice.
// - `SecondRoundSweep` picks up what the local judge held before this choice
//   was made: it re-opens those items' text questions (the item stays where
//   it is, Private), and the resolver's next pass asks them through the
//   wrapped model. Its cursor persists, so each held item is asked once per
//   choice of this round.
//
// `JudgeObservations` records what the local judge measured on this install
// (items a minute, and the share it held Private) for the setup estimates.

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import type { AnalystModel } from '../../core/analyst.ts';
import { resolveClassificationLedgerPath } from '../classification-ledger.ts';
import { rejudgeStoredContent, emptyTierRejudgeReport } from '../connector-store/tier-rejudge.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import type { JudgeObserved } from './judge-spending.ts';
import type { SnifferModel, SnifferModelCompletion, SnifferModelRequest } from './sniffer-decision.ts';
import { JudgeCloudStopped, parseSnifferBatchResponse, snifferTierKey } from './sniffer.ts';
import type { TierLedgerIdentity } from './tier-ledger.ts';
import type { TierSniffer } from './tier-classifier.ts';

/** Enough local answers to state a measured speed instead of the reference machine's. */
export const OBSERVED_MIN_CALLS = 30;
/** Enough local verdicts to cost the second round on this archive's own held share. */
export const OBSERVED_MIN_VERDICTS = 200;
/** Older samples fade: past this many calls every count halves. */
const OBSERVED_WINDOW_CALLS = 2_000;
const OBSERVED_SAVE_EVERY = 25;

export function judgeObservationsPath(env: Record<string, string | undefined>): string {
  return join(dirname(resolveClassificationLedgerPath(env)), 'judge-observed.json');
}
export function judgeSecondRoundStatePath(env: Record<string, string | undefined>): string {
  return join(dirname(resolveClassificationLedgerPath(env)), 'judge-second-round.json');
}
export function judgeSecondRoundConfirmedPath(env: Record<string, string | undefined>): string {
  return join(dirname(resolveClassificationLedgerPath(env)), 'judge-second-round.sqlite');
}

/**
 * Questions Venice already answered Private, by a digest of the exact question
 * (never its text). A stop makes the sweep start over once the limit is raised
 * or credit is added (judge-setup.ts); these are not sent, or paid for, again.
 */
export class SecondRoundConfirmed {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    try { chmodSync(path, 0o600); } catch { /* Best effort, as the other judge records. */ }
    this.db.run('CREATE TABLE IF NOT EXISTS confirmed (digest TEXT PRIMARY KEY)');
  }
  static digest(request: SnifferModelRequest): string {
    return createHash('sha256').update(`${request.system}\n${request.prompt}`).digest('hex');
  }
  has(digest: string): boolean { return this.db.query('SELECT 1 FROM confirmed WHERE digest = ?').get(digest) !== null; }
  add(digest: string): void { this.db.query('INSERT OR IGNORE INTO confirmed (digest) VALUES (?)').run(digest); }
  close(): void { this.db.close(); }
}

interface ObservedRow { calls: number; busyMs: number; personal: number; held: number }

/** Counts only, never content. Throughput is answers per minute of time the judge was busy. */
export class JudgeObservations {
  private row: ObservedRow = { calls: 0, busyMs: 0, personal: 0, held: 0 };
  private inFlight = 0;
  private busySince = 0;
  private unsaved = 0;
  constructor(private readonly path?: string, private readonly nowMs: () => number = () => performance.now()) {
    if (!path) return;
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<ObservedRow>;
      if ([saved.calls, saved.busyMs, saved.personal, saved.held].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) this.row = saved as ObservedRow;
    } catch { /* No record yet, or unreadable: start counting afresh. */ }
  }
  started(): void {
    if (this.inFlight++ === 0) this.busySince = this.nowMs();
  }
  finished(verdict: 'personal' | 'held' | undefined): void {
    // Busy time is the union of calls in flight, so parallel calls are not double-counted.
    if (this.inFlight > 0 && --this.inFlight === 0) this.row.busyMs += Math.max(0, this.nowMs() - this.busySince);
    this.row.calls += 1;
    if (verdict) this.row[verdict] += 1;
    if (this.row.calls > OBSERVED_WINDOW_CALLS) this.row = { calls: this.row.calls / 2, busyMs: this.row.busyMs / 2, personal: this.row.personal / 2, held: this.row.held / 2 };
    if (++this.unsaved >= OBSERVED_SAVE_EVERY) this.save();
  }
  save(): void {
    this.unsaved = 0;
    if (!this.path) return;
    try { writePrivateFileAtomicSync(this.path, `${JSON.stringify(this.row)}\n`); } catch { /* Estimates only. */ }
  }
  observed(): JudgeObserved {
    const verdicts = this.row.personal + this.row.held;
    return {
      ...(this.row.calls >= OBSERVED_MIN_CALLS && this.row.busyMs > 0 ? { localItemsPerMinute: this.row.calls / (this.row.busyMs / 60_000) } : {}),
      ...(verdicts >= OBSERVED_MIN_VERDICTS ? { heldFraction: this.row.held / verdicts } : {}),
    };
  }
}

/** Personal, Private (held) or no verdict, as the resolver will read this one answer. */
export function completionTier(completion: SnifferModelCompletion): 'personal' | 'held' | undefined {
  const verdict = completion.decisionVerdict ?? parseSnifferBatchResponse(completion.text, new Set([1])).get(1);
  if (!verdict) return undefined;
  return snifferTierKey({ ...verdict, failSafe: false }) === 'private' ? 'personal' : 'held';
}

/** Times and counts the local judge's own answers; the answers pass through unchanged. */
export function observedJudge<T extends SnifferModel>(model: T, observations: JudgeObservations): T {
  return { ...model, complete: async (request: SnifferModelRequest) => {
    observations.started();
    let tier: 'personal' | 'held' | undefined;
    try {
      const completion = await model.complete(request) as SnifferModelCompletion;
      tier = completionTier(completion);
      return completion;
    } finally { observations.finished(tier); }
  } };
}

export interface SecondRoundCounts { asked: number; released: number; kept: number; failed: number; stopped: number }

/**
 * The local answer stands unless it held the item Private and Venice answers
 * Personal. A Venice stop or failure keeps the local answer: Private.
 */
export function secondRoundJudge<T extends SnifferModel>(local: T, venice: AnalystModel, counts: SecondRoundCounts = { asked: 0, released: 0, kept: 0, failed: 0, stopped: 0 }, confirmed?: Pick<SecondRoundConfirmed, 'has' | 'add'>): T & { secondRound: SecondRoundCounts } {
  return { ...local, secondRound: counts, complete: async (request: SnifferModelRequest) => {
    const first = await local.complete(request) as SnifferModelCompletion;
    // Text questions only: an item held Private on its names alone never goes to Venice.
    if (completionTier(first) !== 'held' || request.snifferItem?.pass !== 'content' || request.signal?.aborted) return first;
    const digest = SecondRoundConfirmed.digest(request);
    if (confirmed?.has(digest)) return first;
    counts.asked += 1;
    try {
      // The same one-item question; a cloud model reads the text, never local decoder state.
      const second = await venice.complete({ ...request }) as SnifferModelCompletion;
      const tier = completionTier({ text: second.text, modelId: second.modelId });
      if (tier === 'personal') {
        counts.released += 1;
        return { text: second.text, modelId: second.modelId };
      }
      // Only Venice's own valid Private verdict is remembered; no verdict leaves it to be asked again.
      if (tier === 'held') { counts.kept += 1; confirmed?.add(digest); } else counts.failed += 1;
    } catch (error) {
      // A stop keeps the local Private; the sweep re-opens it once the limit is raised or credit added.
      if (error instanceof JudgeCloudStopped) counts.stopped += 1; else counts.failed += 1;
    }
    return first;
  } };
}

interface SweepState { v: 1; cursors: Record<string, TierLedgerIdentity | 'done'> }

/**
 * Re-opens, a bounded page per set per tick, the items the local judge held
 * Private before this round began. Never throws; a set that cannot be read is
 * tried again next tick.
 */
export class SecondRoundSweep {
  constructor(private readonly options: {
    statePath: string;
    /** Open questions this sniffer still has to answer; the sweep waits above `maxOpen`. */
    unanswered: (ledgerPath: string, snifferId: string) => number;
    setFor: (ledgerPath: string) => TieredStoreSet | undefined;
    perPass?: number;
    maxOpen?: number;
  }) {}

  static reset(statePath: string): void {
    try { rmSync(statePath, { force: true }); } catch { /* A stale cursor only re-asks fewer items. */ }
  }

  private read(): SweepState {
    try {
      if (!existsSync(this.options.statePath)) return { v: 1, cursors: {} };
      const state = JSON.parse(readFileSync(this.options.statePath, 'utf8')) as SweepState;
      return state?.v === 1 && state.cursors && typeof state.cursors === 'object' ? state : { v: 1, cursors: {} };
    } catch { return { v: 1, cursors: {} }; }
  }

  async run(ledgerPaths: readonly string[], autoMovesFor: (set: TieredStoreSet) => boolean, turn: () => Promise<void> | undefined = () => undefined): Promise<number> {
    const perPass = this.options.perPass ?? 50;
    const maxOpen = this.options.maxOpen ?? 2 * perPass;
    const state = this.read();
    let asked = 0;
    let changed = false;
    for (const ledgerPath of ledgerPaths) {
      if (state.cursors[ledgerPath] === 'done') continue;
      await turn();
      const set = this.options.setFor(ledgerPath);
      const classification = set?.classification();
      const inner = classification?.sniffer;
      if (!set || !inner || classification.unavailableReason || inner.rejudgeReady === false) continue;
      try {
        if (this.options.unanswered(ledgerPath, inner.id) >= maxOpen) continue;
        const after = state.cursors[ledgerPath] as TierLedgerIdentity | undefined;
        const page = set.ledger.secondRoundCandidatePage({ limit: perPass, ...(after ? { after } : {}) });
        const recheck: TierSniffer = { id: inner.id, judge: request => inner.judge(request.pass === 'content' ? { ...request, recheckHeld: true } : request) };
        const report = emptyTierRejudgeReport();
        for (const record of page.records) {
          await turn();
          try {
            rejudgeStoredContent(set, record, { sniffer: recheck, report, autoMoves: autoMovesFor(set), ...(classification.retirePublic ? { retirePublic: true } : {}) });
          } catch { report.failed += 1; }
        }
        asked += report.asked;
        state.cursors[ledgerPath] = page.next ?? 'done';
        changed = true;
      } catch { /* Tried again next tick. */ }
    }
    if (changed) {
      try { writePrivateFileAtomicSync(this.options.statePath, `${JSON.stringify(state)}\n`); } catch { /* Next tick re-reads this page. */ }
    }
    return asked;
  }
}

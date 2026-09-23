// The worker's background tick for the privacy-safe sniffer: a bounded
// `runSnifferPass` over every connector store, on an interval, one pass at a
// time. It yields to answers (it shares the private pool Argus answers from)
// and does nothing until the owner has approved the exact classifier model
// and prompt version in the classification ledger.

import type { AnalystModel } from '../../core/analyst.ts';
import {
  appendClassificationLedgerEntryOnce,
  isClassifierApproved,
  readClassificationLedger,
} from '../classification-ledger.ts';
import type { InstalledTierClassification } from './installed-tier-classification.ts';
import { SNIFFER_PROMPT_VERSION } from './sniffer.ts';
import type { SnifferLane } from './sniffer-lane.ts';
import {
  DEFAULT_SNIFFER_MAX_CALLS_PER_DAY,
  defaultSnifferMaxCallsPerPass,
  SnifferCallBudget,
  runSnifferPass,
  type SnifferPassReport,
  type SnifferTarget,
} from './sniffer-resolver.ts';
import { existsSync } from 'node:fs';
import { tierSetPlannerForLedger } from './installed-tier-classification-registry.ts';
import { TierLedger, tierLedgerPathForStore } from './tier-ledger.ts';

export const DEFAULT_TIER_SNIFFER_INTERVAL_MS = 60_000;

/**
 * A connector store, by what the sniffer needs: its path, and the tiered
 * store set ledger it is bound to, if any. The pass reads every ledger that
 * EXISTS (a store's own, a set's), each once, and never creates one.
 */
export interface TierSnifferServiceStore {
  readonly dbPath: string;
  tierSetBinding?(): { ledgerPath: string } | undefined;
}

export interface TierSnifferServiceOptions {
  installed: InstalledTierClassification;
  lane: SnifferLane;
  model: AnalystModel;
  stores: () => readonly TierSnifferServiceStore[];
  classificationLedgerPath: string;
  /** Where the day's call count is kept across restarts (owner-only JSON). */
  budgetStatePath?: string;
  intervalMs?: number;
  maxCallsPerPass?: number;
  maxCallsPerDay?: number;
  /** True while an answer needs the private pool, or its breaker is open. */
  shouldYield?: () => boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface TierClassificationBacklog {
  /** Items with an open sniffer question (held pending, Private). */
  checkingItems: number;
  /** Questions still to ask (an item can have a names and an excerpt question). */
  remainingQuestions: number;
  summary: string;
  /** The sniffer is waiting for the owner to approve its model and prompt. */
  awaitingOwnerApproval: boolean;
}

export type TierSnifferTick =
  | { state: 'skipped_running' }
  | { state: 'awaiting_owner_approval'; modelId: string; promptVersion: string }
  | { state: 'ran'; report: SnifferPassReport }
  | { state: 'failed'; error: string };

export class TierSnifferService {
  private readonly options: TierSnifferServiceOptions;
  private readonly budget: SnifferCallBudget;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private abort: AbortController | undefined;
  private lastTick: TierSnifferTick | undefined;
  private stopped = false;
  private readonly ledgers = new Map<string, TierLedger>();

  constructor(options: TierSnifferServiceOptions) {
    this.options = options;
    this.budget = new SnifferCallBudget({
      maxCallsPerDay: options.maxCallsPerDay ?? DEFAULT_SNIFFER_MAX_CALLS_PER_DAY,
      ...(options.now ? { now: options.now } : {}),
      ...(options.budgetStatePath ? { statePath: options.budgetStatePath } : {}),
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, this.options.intervalMs ?? DEFAULT_TIER_SNIFFER_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop the tick. A pass in flight is aborted; its ledgers close when it ends. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    if (!this.running) this.closeLedgers();
  }

  /**
   * An answer needs the private pool (the worker calls this when answers in
   * flight go from 0 to 1): abort the sniffer's in-flight call at once. The
   * pass stops as `preempted`; nothing is counted against any item, and the
   * sniffer never records anything in the answer pool's breakers.
   */
  preempt(): void {
    this.abort?.abort();
  }

  /**
   * The classification backlog, counts only: how many items are waiting on
   * the sniffer and how many questions are still to ask. No time estimate
   * (owner ruling: an unreliable one is worse than none).
   */
  backlog(): TierClassificationBacklog {
    let checkingItems = 0;
    let remainingQuestions = 0;
    for (const ledgerPath of this.ledgerPaths()) {
      try {
        const counts = this.options.installed.snifferStoreForLedger(ledgerPath).counts();
        checkingItems += counts.items;
        remainingQuestions += counts.questions;
      } catch {
        // An unreadable queue contributes nothing; its items stay pending.
      }
    }
    return {
      checkingItems,
      remainingQuestions,
      summary: checkingItems === 0
        ? 'No items waiting for classification.'
        : `Checking ${checkingItems} item${checkingItems === 1 ? '' : 's'}, about ${remainingQuestions} question${remainingQuestions === 1 ? '' : 's'} remaining.`,
      awaitingOwnerApproval: this.lastTick?.state === 'awaiting_owner_approval',
    };
  }

  status(): { lane: string; modelId: string; callsToday: number; lastTick?: TierSnifferTick } {
    return {
      lane: this.options.lane.kind,
      modelId: this.options.lane.modelId,
      callsToday: this.budget.usedToday(),
      ...(this.lastTick ? { lastTick: this.lastTick } : {}),
    };
  }

  async runOnce(): Promise<TierSnifferTick> {
    if (this.running || this.stopped) return { state: 'skipped_running' };
    this.running = true;
    this.abort = new AbortController();
    try {
      const tick = await this.tick(this.abort.signal);
      this.lastTick = tick;
      return tick;
    } catch (error) {
      // Content-free: the class of failure only. Items stay pending.
      const tick: TierSnifferTick = { state: 'failed', error: error instanceof Error ? error.name : 'unknown' };
      this.lastTick = tick;
      return tick;
    } finally {
      this.running = false;
      this.abort = undefined;
      if (this.stopped) this.closeLedgers();
    }
  }

  /** Every existing ledger behind the stores, each once: bound set ledgers and stores' own. */
  private ledgerPaths(): string[] {
    const paths = new Set<string>();
    for (const store of this.options.stores()) {
      if (store.dbPath === ':memory:') continue;
      try {
        const bound = store.tierSetBinding?.();
        if (bound && bound.ledgerPath !== ':memory:' && existsSync(bound.ledgerPath)) paths.add(bound.ledgerPath);
      } catch {
        // An unreadable binding fails closed elsewhere; the sniffer skips it.
      }
      const own = tierLedgerPathForStore(store.dbPath);
      if (existsSync(own)) paths.add(own);
    }
    return [...paths];
  }

  private ledgerAt(path: string): TierLedger {
    let ledger = this.ledgers.get(path);
    if (!ledger) {
      ledger = new TierLedger({ dbPath: path, ...(this.options.now ? { now: this.options.now } : {}) });
      this.ledgers.set(path, ledger);
    }
    return ledger;
  }

  private closeLedgers(): void {
    for (const ledger of this.ledgers.values()) {
      try {
        ledger.close();
      } catch {
        // Best effort at shutdown.
      }
    }
    this.ledgers.clear();
  }

  private async tick(signal: AbortSignal): Promise<TierSnifferTick> {
    const { lane } = this.options;
    const ledger = await readClassificationLedger(this.options.classificationLedgerPath);
    const key = { lane: lane.kind, profileId: lane.profileId, modelId: lane.modelId, promptVersion: SNIFFER_PROMPT_VERSION };
    if (!isClassifierApproved(ledger.entries, key)) {
      // Until then no question is sent anywhere: flagged items wait, pending
      // and held Private, and their questions stay queued for the approval.
      // Make the open decision visible once, never as an approval.
      await appendClassificationLedgerEntryOnce(this.options.classificationLedgerPath, {
        recorded_at: (this.options.now?.() ?? new Date()).toISOString(),
        kind: 'classifier_model_decision',
        what: `The privacy sniffer is configured to use ${lane.kind} model ${lane.modelId} (profile ${lane.profileId}) with prompt ${SNIFFER_PROMPT_VERSION}; it waits for the owner's approval before classifying anything.`,
        model_id: lane.modelId,
        prompt_version: SNIFFER_PROMPT_VERSION,
        lane: lane.kind,
        profile_id: lane.profileId,
        approved_by: 'system-automatic',
        status: 'pending',
        entry_id: `sniffer-approval-requested:${lane.kind}:${lane.profileId}:${lane.modelId}:${SNIFFER_PROMPT_VERSION}`,
      });
      return { state: 'awaiting_owner_approval', modelId: lane.modelId, promptVersion: SNIFFER_PROMPT_VERSION };
    }
    const targets: SnifferTarget[] = [];
    for (const ledgerPath of this.ledgerPaths()) {
      const ledger = this.ledgerAt(ledgerPath);
      const planner = tierSetPlannerForLedger(ledgerPath);
      targets.push({
        ledger,
        sniffer: this.options.installed.snifferStoreForLedger(ledgerPath),
        ...(planner ? { placementFor: planner } : {}),
      });
    }
    const report = await runSnifferPass({
      targets,
      lane,
      model: this.options.model,
      budget: this.budget,
      maxCallsPerPass: this.options.maxCallsPerPass ?? defaultSnifferMaxCallsPerPass(lane.kind),
      ...(this.options.shouldYield ? { shouldYield: this.options.shouldYield } : {}),
      signal,
    });
    if (report.calls > 0 || report.verdictsApplied > 0) {
      this.options.log?.(
        `Olympus tier sniffer: ${report.calls} call(s), ${report.verdictsApplied} verdict(s) applied `
        + `(${report.resolvedPersonal} Personal, ${report.resolvedPrivate} Private, ${report.failSafePrivate} fail-safe Private), `
        + `${report.cacheHits} from cache${report.stoppedBy ? `, stopped: ${report.stoppedBy}` : ''}.`,
      );
    }
    return { state: 'ran', report };
  }
}

/** Env knobs, all optional. Invalid values fall back to the defaults. */
export function tierSnifferServiceEnv(env: Record<string, string | undefined>): {
  enabled: boolean;
  intervalMs: number;
  /** Absent: the lane's default pace (10 a minute local, 30 on Venice). */
  maxCallsPerPass?: number;
  maxCallsPerDay: number;
} {
  const enabledRaw = env.OLYMPUS_TIER_SNIFFER_ENABLED?.trim().toLowerCase();
  return {
    enabled: !(enabledRaw === '0' || enabledRaw === 'false' || enabledRaw === 'no' || enabledRaw === 'off'),
    intervalMs: positiveInteger(env.OLYMPUS_TIER_SNIFFER_INTERVAL_MS, DEFAULT_TIER_SNIFFER_INTERVAL_MS, 5_000),
    ...(env.OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_PASS?.trim()
      ? { maxCallsPerPass: positiveInteger(env.OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_PASS, 1, 1) }
      : {}),
    maxCallsPerDay: positiveInteger(env.OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_DAY, DEFAULT_SNIFFER_MAX_CALLS_PER_DAY, 0),
  };
}

function positiveInteger(value: string | undefined, fallback: number, minimum: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

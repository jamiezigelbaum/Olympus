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
  DEFAULT_SNIFFER_MAX_CALLS_PER_PASS,
  SnifferCallBudget,
  runSnifferPass,
  type SnifferPassReport,
  type SnifferTarget,
} from './sniffer-resolver.ts';
import type { TierLedger } from './tier-ledger.ts';

export const DEFAULT_TIER_SNIFFER_INTERVAL_MS = 60_000;

export interface TierSnifferServiceStore {
  readonly dbPath: string;
  tierLedger(): TierLedger | undefined;
}

export interface TierSnifferServiceOptions {
  installed: InstalledTierClassification;
  lane: SnifferLane;
  model: AnalystModel;
  stores: () => readonly TierSnifferServiceStore[];
  classificationLedgerPath: string;
  intervalMs?: number;
  maxCallsPerPass?: number;
  maxCallsPerDay?: number;
  /** True while an answer needs the private pool, or its breaker is open. */
  shouldYield?: () => boolean;
  now?: () => Date;
  log?: (line: string) => void;
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

  constructor(options: TierSnifferServiceOptions) {
    this.options = options;
    this.budget = new SnifferCallBudget({
      maxCallsPerDay: options.maxCallsPerDay ?? DEFAULT_SNIFFER_MAX_CALLS_PER_DAY,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, this.options.intervalMs ?? DEFAULT_TIER_SNIFFER_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort?.abort();
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
    if (this.running) return { state: 'skipped_running' };
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
    }
  }

  private async tick(signal: AbortSignal): Promise<TierSnifferTick> {
    const { lane } = this.options;
    const ledger = await readClassificationLedger(this.options.classificationLedgerPath);
    const pair = { modelId: lane.modelId, promptVersion: SNIFFER_PROMPT_VERSION };
    if (!isClassifierApproved(ledger.entries, pair)) {
      // Make the open decision visible once, never as an approval.
      await appendClassificationLedgerEntryOnce(this.options.classificationLedgerPath, {
        recorded_at: (this.options.now?.() ?? new Date()).toISOString(),
        kind: 'classifier_model_decision',
        what: `The privacy sniffer is configured to use ${lane.kind} model ${lane.modelId} with prompt ${SNIFFER_PROMPT_VERSION}; it waits for the owner's approval before classifying anything.`,
        model_id: lane.modelId,
        prompt_version: SNIFFER_PROMPT_VERSION,
        lane: lane.kind,
        approved_by: 'system-automatic',
        status: 'pending',
        entry_id: `sniffer-approval-requested:${lane.modelId}:${SNIFFER_PROMPT_VERSION}`,
      });
      return { state: 'awaiting_owner_approval', ...pair };
    }
    const targets: SnifferTarget[] = [];
    for (const store of this.options.stores()) {
      if (store.dbPath === ':memory:') continue;
      const tierLedger = store.tierLedger();
      if (!tierLedger) continue;
      targets.push({ ledger: tierLedger, sniffer: this.options.installed.snifferStore(store.dbPath) });
    }
    const report = await runSnifferPass({
      targets,
      lane,
      model: this.options.model,
      budget: this.budget,
      maxCallsPerPass: this.options.maxCallsPerPass ?? DEFAULT_SNIFFER_MAX_CALLS_PER_PASS,
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
  maxCallsPerPass: number;
  maxCallsPerDay: number;
} {
  const enabledRaw = env.OLYMPUS_TIER_SNIFFER_ENABLED?.trim().toLowerCase();
  return {
    enabled: !(enabledRaw === '0' || enabledRaw === 'false' || enabledRaw === 'no' || enabledRaw === 'off'),
    intervalMs: positiveInteger(env.OLYMPUS_TIER_SNIFFER_INTERVAL_MS, DEFAULT_TIER_SNIFFER_INTERVAL_MS, 5_000),
    maxCallsPerPass: positiveInteger(env.OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_PASS, DEFAULT_SNIFFER_MAX_CALLS_PER_PASS, 1),
    maxCallsPerDay: positiveInteger(env.OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_DAY, DEFAULT_SNIFFER_MAX_CALLS_PER_DAY, 0),
  };
}

function positiveInteger(value: string | undefined, fallback: number, minimum: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

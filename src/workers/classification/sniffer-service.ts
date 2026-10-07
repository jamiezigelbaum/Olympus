// The worker's background tick for the privacy-safe sniffer: a bounded
// `runSnifferPass` over every connector store, on an interval, one pass at a
// time. It yields to answers (it shares the private pool Argus answers from)
// and does nothing until the owner has approved the exact classifier model
// and prompt version in the classification ledger.

import type { AnalystModel } from '../../core/analyst.ts';
import {
  CLASSIFICATION_LEDGER_BUILT_IN_DEFAULT_APPROVAL,
  appendClassificationLedgerEntryOnce,
  builtInDefaultRevoked,
  isClassifierApproved,
  readClassificationLedger,
} from '../classification-ledger.ts';
import { moveTieredItem } from '../connector-store/tier-move.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import { BUILT_IN_EMBEDDING_PROVIDER } from '../source-index/built-in-embedding/provider.ts';
import { BUILT_IN_SNIFFER_LANE } from './built-in-sniffer.ts';
import type { InstalledTierClassification } from './installed-tier-classification.ts';
import { snifferPromptVersions } from './sniffer.ts';
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
import { TierSnifferStore } from './sniffer-store.ts';
import { tierSnifferPathForLedger } from './tier-ledger-path.ts';
import { tierSetPlannerForLedger } from './installed-tier-classification-registry.ts';
import { tierSetForLedger } from '../connector-store/tier-set-registry.ts';
import {
  DEFAULT_TIER_REJUDGE_PER_PASS,
  emptyTierRejudgeReport,
  rejudgeRoutedItems,
  type TierRejudgeReport,
} from '../connector-store/tier-rejudge.ts';
import { settleNamesOnlyItems } from '../connector-store/tier-names-only-settle.ts';
import { sweepOwnerRuleRaises } from '../connector-store/tier-rules-sweep.ts';
import {
  TierLedger,
  TierLedgerRaiseAbandonRefusedError,
  tierLedgerIdentityKey,
  tierLedgerPathForStore,
  type TierLedgerIdentity,
  type TierLedgerRecord,
} from './tier-ledger.ts';

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
  /**
   * The model is not always there (the built-in private model downloads on
   * first use): while this answers false the pass asks nothing and every
   * flagged item stays pending. Absent: always available.
   */
  modelAvailable?: () => boolean;
  /**
   * Start the model's first-time download when none has started (never
   * blocks; the built-in private model's `startIfIdle`). Called on a tick the
   * model is not available, so a fresh install's held items are judged once
   * the download finishes instead of waiting for an answer to start it.
   */
  startModel?: () => void;
  /** The owner's own words about privacy (privacy-profile.ts), quoted into the prompt. */
  ownerContext?: () => string | undefined;
  /** Where the day's call count is kept across restarts (owner-only JSON). */
  budgetStatePath?: string;
  intervalMs?: number;
  /** A pass still running after this long is aborted at the next tick. Default DEFAULT_TIER_SNIFFER_MAX_PASS_MS. */
  maxPassMs?: number;
  /**
   * A pass aborted for running too long that still has not settled this long
   * after its abort (something ignores the signal) is abandoned: its result
   * is dropped and the next tick runs a fresh pass. Default
   * DEFAULT_TIER_SNIFFER_ABANDON_MS.
   */
  abandonAfterMs?: number;
  maxCallsPerPass?: number;
  maxCallsPerDay?: number;
  /** Any other reason to yield the private pool (the pass also yields to `answersInFlight` and `breakerOpen`). */
  shouldYield?: () => boolean;
  /** True while the private pool's breaker for the sniffer's model is open (it rests after failures). */
  breakerOpen?: () => boolean;
  /** The model's install state when it is not available (content-free, e.g. `failed`), for the waiting reason. */
  modelState?: () => string | undefined;
  /**
   * True while answers are in flight. The pass's automatic tier moves
   * (which re-embed items on this computer) wait for them as well, so an
   * answer never shares the machine with background work it can avoid.
   */
  answersInFlight?: () => boolean;
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * The built-in private model is approved by default (owner default
   * 2026-10-01): with this set and the lane exactly the built-in model's
   * (local, profile and model `built_in`), an approval for the current prompt
   * version is written to the classification ledger automatically, marked
   * `built_in_default` (never `owner`: the owner did not sign it), again
   * whenever the prompt version changes (new owner words). An owner
   * revocation of the built-in model, of ANY prompt version, stops that until
   * the owner approves it again. Any other lane, remote ones included, still
   * waits for the owner's own approval.
   */
  autoApproveBuiltIn?: boolean;
  /**
   * Routed items re-judged per set per tick after the classifier or the
   * sniffer's prompt changed (tier-rejudge.ts). 0 turns it off. Default
   * DEFAULT_TIER_REJUDGE_PER_PASS. A set whose sniffer queue already holds
   * `rejudgeMaxOpenQuestions` questions is not re-judged that tick, so
   * re-judging never outruns the answers.
   */
  rejudgePerPass?: number;
  rejudgeMaxOpenQuestions?: number;
  /**
   * Automatic tier moves (owner approval 2026-10-01): queued moves (a held
   * item the sniffer judged Personal after all queues one) are carried out
   * right after the pass, at most `maxPerPass` items, ONLY while `localEmbeddingsOnly()` says
   * every configured embedding is the built-in local model AND every store of
   * the item's set embeds with it (free, nothing leaves the Mac). Otherwise
   * the move stays queued for the owner-approved `olympus tier migrate` path.
   */
  autoMoves?: {
    localEmbeddingsOnly: () => boolean;
    /** The embedding ledger each automatic move is recorded in. */
    embeddingLedgerPath: string;
    maxPerPass?: number;
    /**
     * How long a queued move may keep failing (from its first failed
     * attempt in this process) before it is given up
     * (`TierLedger.abandonMove`): a lateral or lower move is abandoned, so the
     * item is no longer held mid-move; a raise is never rolled back to the
     * lower placement (that would expose what the newer decision hides), it
     * stays queued and is counted as stale. Default DEFAULT_STALE_MOVE_MS.
     */
    staleAfterMs?: number;
  };
}

export const DEFAULT_AUTO_MOVES_PER_PASS = 25;
/** A pass running longer than this is aborted at the next tick. */
export const DEFAULT_TIER_SNIFFER_MAX_PASS_MS = 15 * 60_000;
/** An overrun pass still unsettled this long after its abort is abandoned. */
export const DEFAULT_TIER_SNIFFER_ABANDON_MS = 2 * 60_000;
export const DEFAULT_STALE_MOVE_MS = 60 * 60_000;
export const BUILT_IN_CLASSIFIER_DEFAULT_APPROVAL_REASON = 'built-in local model, nothing leaves the Mac (owner default 2026-10-01)';

export interface TierAutoMoveReport {
  moved: number;
  failed: number;
  /** Queued moves left for the owner-approved migration (a store not on the built-in embedding model). */
  notEligible: number;
  /** Failed moves older than the stale bound that were given up: the item is back where it was. */
  abandoned?: number;
  /** Failed raises older than the stale bound: kept hidden and queued, never rolled back. */
  staleRaises?: number;
}

export interface TierClassificationBacklog {
  /** Items with an open sniffer question (held pending, Private). */
  checkingItems: number;
  /** Questions still to ask (an item can have a names and an excerpt question). */
  remainingQuestions: number;
  summary: string;
  /** The sniffer is waiting for the owner to approve its model and prompt. */
  awaitingOwnerApproval: boolean;
  /** Why the last tick asked nothing while questions wait (absent while asking or idle). */
  waiting?: TierSnifferWaiting;
}

/**
 * Why the sniffer asked nothing while questions wait. Content-free: a code
 * and a plain sentence, never an item.
 */
export type TierSnifferWaitReason =
  | 'yielding_to_answers'
  | 'breaker_open'
  | 'pass_running'
  | 'pass_stuck'
  | 'awaiting_owner_approval'
  | 'no_model'
  | 'daily_budget'
  | 'model_not_answering'
  | 'failed';

export interface TierSnifferWaiting {
  reason: TierSnifferWaitReason;
  label: string;
  /** When this reason was first seen (ISO). */
  since: string;
}

export type TierSnifferTick =
  | { state: 'skipped_running' }
  | { state: 'awaiting_owner_approval'; modelId: string; promptVersion: string }
  | { state: 'model_unavailable'; modelId: string }
  | { state: 'ran'; report: SnifferPassReport; rejudged?: TierRejudgeReport; autoMoves?: TierAutoMoveReport }
  | { state: 'failed'; error: string };

export class TierSnifferService {
  private readonly options: TierSnifferServiceOptions;
  private readonly budget: SnifferCallBudget;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private runningSinceMs = 0;
  private overrunReported = false;
  /** When the running pass was aborted for overrunning (0: not aborted). */
  private overrunAbortedAtMs = 0;
  /** Bumped when a pass starts or is abandoned: an abandoned pass's late result is dropped. */
  private passGeneration = 0;
  /** The last reported reason a tick asked nothing (or 'asking'). */
  private waitingReason: string | undefined;
  private waiting: TierSnifferWaiting | undefined;
  /** When each queued move (ledger, item, generation) first failed in this process. */
  private readonly moveFailures = new Map<string, number>();
  private abort: AbortController | undefined;
  private lastTick: TierSnifferTick | undefined;
  private stopped = false;
  private readonly ledgers = new Map<string, TierLedger>();
  /** Where each set's re-judge page stopped (tier-rejudge.ts). */
  private readonly rejudgeCursors = new Map<string, TierLedgerIdentity>();

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
      // Read-only, and only where a sniffer queue exists: a status read never
      // creates or migrates a sniffer file beside a ledger that has none.
      const path = tierSnifferPathForLedger(ledgerPath);
      if (path === ':memory:' || !existsSync(path)) continue;
      let store: TierSnifferStore | undefined;
      try {
        store = new TierSnifferStore({ dbPath: path, readOnly: true });
        const counts = store.counts();
        checkingItems += counts.items;
        remainingQuestions += counts.questions;
      } catch {
        // An unreadable queue contributes nothing; its items stay pending.
      } finally {
        store?.close();
      }
    }
    return {
      checkingItems,
      remainingQuestions,
      summary: checkingItems === 0
        ? 'No items waiting for classification.'
        : `Checking ${checkingItems} item${checkingItems === 1 ? '' : 's'}, about ${remainingQuestions} question${remainingQuestions === 1 ? '' : 's'} remaining.`
          + (this.waiting ? ` Nothing asked now: ${this.waiting.label}.` : ''),
      awaitingOwnerApproval: this.lastTick?.state === 'awaiting_owner_approval',
      ...(checkingItems > 0 && this.waiting ? { waiting: { ...this.waiting } } : {}),
    };
  }

  status(): { lane: string; modelId: string; callsToday: number; lastTick?: TierSnifferTick; waiting?: TierSnifferWaiting } {
    return {
      lane: this.options.lane.kind,
      modelId: this.options.lane.modelId,
      callsToday: this.budget.usedToday(),
      ...(this.lastTick ? { lastTick: this.lastTick } : {}),
      ...(this.waiting ? { waiting: { ...this.waiting } } : {}),
    };
  }

  async runOnce(): Promise<TierSnifferTick> {
    if (this.stopped) return { state: 'skipped_running' };
    if (this.running) {
      // A pass that never settles would hold every later tick off for good
      // (2026-10-05: the queue sat untouched for two days with no log line).
      // Past the bound it is aborted (its model calls are cancelled) and said;
      // if it still has not settled a while after that (something ignores
      // the abort), it is abandoned and this tick runs a fresh pass.
      const nowMs = this.clockMs();
      const runningMs = nowMs - this.runningSinceMs;
      if (runningMs >= (this.options.maxPassMs ?? DEFAULT_TIER_SNIFFER_MAX_PASS_MS) && !this.overrunReported) {
        this.overrunReported = true;
        this.overrunAbortedAtMs = nowMs;
        this.abort?.abort();
        this.options.log?.(`Olympus tier sniffer: a pass ran ${Math.round(runningMs / 60_000)} min without finishing; it was stopped.`);
        this.setWaiting('pass_stuck');
        return { state: 'skipped_running' };
      }
      if (this.overrunAbortedAtMs === 0
        || nowMs - this.overrunAbortedAtMs < (this.options.abandonAfterMs ?? DEFAULT_TIER_SNIFFER_ABANDON_MS)) {
        if (this.overrunAbortedAtMs === 0) this.setWaiting('pass_running');
        return { state: 'skipped_running' };
      }
      this.options.log?.('Olympus tier sniffer: a stopped pass did not end; it was abandoned and a new pass starts.');
      this.running = false;
    }
    const generation = ++this.passGeneration;
    this.running = true;
    this.runningSinceMs = this.clockMs();
    this.overrunReported = false;
    this.overrunAbortedAtMs = 0;
    const abort = new AbortController();
    this.abort = abort;
    let tick: TierSnifferTick;
    try {
      tick = await this.tick(abort.signal);
    } catch (error) {
      // Content-free: the class of failure only. Items stay pending.
      tick = { state: 'failed', error: error instanceof Error ? error.name : 'unknown' };
    }
    // An abandoned pass that ends late changes nothing: a newer pass owns the state.
    if (generation !== this.passGeneration) {
      abort.abort();
      return tick;
    }
    const overran = this.overrunAbortedAtMs !== 0;
    this.running = false;
    this.abort = undefined;
    this.lastTick = tick;
    this.reportWaiting(tick, overran);
    if (this.stopped) this.closeLedgers();
    return tick;
  }

  private clockMs(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  /**
   * Why a tick asked nothing while questions wait, logged once each time the
   * reason changes (and once when asking resumes), so a stalled queue is never
   * silent. Content-free: a state name, never an item.
   */
  private reportWaiting(tick: TierSnifferTick, overran = false): void {
    let reason: TierSnifferWaitReason | undefined;
    if (tick.state === 'model_unavailable') reason = 'no_model';
    else if (tick.state === 'awaiting_owner_approval') reason = 'awaiting_owner_approval';
    else if (tick.state === 'failed') reason = 'failed';
    else if (tick.state === 'ran' && tick.report.calls === 0 && tick.report.pendingSeen > 0) {
      const stop = tick.report.stoppedBy;
      reason = stop === 'yield' || stop === 'preempted' || stop === 'aborted'
        ? overran ? 'pass_stuck'
          : this.answering() ? 'yielding_to_answers'
            : this.breakerOpen() ? 'breaker_open'
              : 'yielding_to_answers'
        : stop === 'daily_budget' ? 'daily_budget'
          : stop === 'transport_failures' ? 'model_not_answering'
            : undefined;
    }
    if (reason) {
      this.setWaiting(reason, tick);
      return;
    }
    // Any other finished pass (it asked, the queue is empty, or nothing was
    // left to ask this tick) clears the reason: a stale one never lingers.
    const previous = this.waitingReason;
    this.waiting = undefined;
    this.waitingReason = 'asking';
    if (tick.state === 'ran' && tick.report.calls > 0 && previous && previous !== 'asking') {
      this.options.log?.('Olympus tier sniffer: asking again.');
    }
  }

  private setWaiting(reason: TierSnifferWaitReason, tick?: TierSnifferTick): void {
    const label = this.waitLabel(reason, tick);
    if (!this.waiting || this.waiting.reason !== reason) {
      this.waiting = { reason, label, since: new Date(this.clockMs()).toISOString() };
    } else {
      this.waiting = { ...this.waiting, label };
    }
    if (reason === this.waitingReason) return;
    this.waitingReason = reason;
    // A pass in progress is normal; only an overrun or a stop is worth a line
    // (pass_stuck logs its own).
    if (reason === 'pass_running' || reason === 'pass_stuck') return;
    this.options.log?.(`Olympus tier sniffer: questions are waiting, nothing asked: ${label}.`);
  }

  private waitLabel(reason: TierSnifferWaitReason, tick?: TierSnifferTick): string {
    switch (reason) {
      case 'yielding_to_answers': return 'yielding to answers in progress';
      case 'breaker_open': return 'the private model is resting after failures';
      case 'pass_running': return 'a pass is still running';
      case 'pass_stuck': return 'a pass ran too long and was stopped';
      case 'awaiting_owner_approval': return 'waiting for the owner to approve the classifier';
      case 'no_model': {
        const state = this.modelState();
        return `the private model is not available${state ? ` (${state})` : ''}`;
      }
      case 'daily_budget': return 'the daily call budget is used up';
      case 'model_not_answering': return 'the private model is not answering';
      case 'failed': return `the pass failed (${tick?.state === 'failed' ? tick.error : 'unknown'})`;
    }
  }

  private breakerOpen(): boolean {
    try {
      return this.options.breakerOpen?.() ?? false;
    } catch {
      return false;
    }
  }

  private modelState(): string | undefined {
    try {
      return this.options.modelState?.();
    } catch {
      return undefined;
    }
  }

  /** The pass yields while an answer is in flight, the breaker is open, or the caller says so. */
  private yieldNow(): boolean {
    if (this.answering() || this.breakerOpen()) return true;
    try {
      return this.options.shouldYield?.() ?? false;
    } catch {
      return false;
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
    // Owner rules that raise, and names-only folders, apply to stored items
    // whatever the model's state: no model is asked.
    this.settleStoredItems();
    if (this.options.modelAvailable && !this.options.modelAvailable()) {
      // Nothing is asked and nothing is counted: flagged items wait, pending
      // and held Private, until the model is there. A model whose download
      // never started is started here, so they never wait forever.
      try {
        this.options.startModel?.();
      } catch {
        // Starting is best effort; the next tick tries again.
      }
      return { state: 'model_unavailable', modelId: lane.modelId };
    }
    const ownerContext = this.options.ownerContext?.();
    const versions = snifferPromptVersions(ownerContext);
    const ledger = await readClassificationLedger(this.options.classificationLedgerPath);
    const key = { lane: lane.kind, profileId: lane.profileId, modelId: lane.modelId, promptVersion: versions.approval };
    const builtInDefault = this.options.autoApproveBuiltIn === true && isBuiltInLane(lane);
    if (builtInDefault && !isClassifierApproved(ledger.entries, key, { builtInDefault: true })
      && !builtInDefaultRevoked(ledger.entries, key)) {
      await appendClassificationLedgerEntryOnce(this.options.classificationLedgerPath, {
        recorded_at: (this.options.now?.() ?? new Date()).toISOString(),
        kind: 'classifier_model_decision',
        what: `The built-in private model is approved for the privacy sniffer with prompt ${versions.approval} by the owner's default for built-in local models.`,
        why: BUILT_IN_CLASSIFIER_DEFAULT_APPROVAL_REASON,
        model_id: lane.modelId,
        prompt_version: versions.approval,
        lane: lane.kind,
        profile_id: lane.profileId,
        approved_by: CLASSIFICATION_LEDGER_BUILT_IN_DEFAULT_APPROVAL,
        status: 'complete',
        entry_id: `sniffer-default-approval:${lane.kind}:${lane.profileId}:${lane.modelId}:${versions.approval}`,
      });
    }
    const approved = builtInDefault
      ? isClassifierApproved((await readClassificationLedger(this.options.classificationLedgerPath)).entries, key, { builtInDefault: true })
      : isClassifierApproved(ledger.entries, key);
    if (!approved) {
      // Until then no question is sent anywhere: flagged items wait, pending
      // and held Private, and their questions stay queued for the approval.
      // Make the open decision visible once, never as an approval.
      await appendClassificationLedgerEntryOnce(this.options.classificationLedgerPath, {
        recorded_at: (this.options.now?.() ?? new Date()).toISOString(),
        kind: 'classifier_model_decision',
        what: `The privacy sniffer is configured to use ${lane.kind} model ${lane.modelId} (profile ${lane.profileId}) with prompt ${versions.approval}; it waits for the owner's approval before classifying anything.`,
        model_id: lane.modelId,
        prompt_version: versions.approval,
        lane: lane.kind,
        profile_id: lane.profileId,
        approved_by: 'system-automatic',
        status: 'pending',
        entry_id: `sniffer-approval-requested:${lane.kind}:${lane.profileId}:${lane.modelId}:${versions.approval}`,
      });
      return { state: 'awaiting_owner_approval', modelId: lane.modelId, promptVersion: versions.approval };
    }
    // Items decided under an older classifier or sniffer prompt are judged
    // again first (tier-rejudge.ts), a bounded page per set per tick: their
    // questions join the queue this pass answers.
    const rejudged = this.rejudge();
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
      promptVersion: versions.cache,
      ...(ownerContext ? { ownerContext } : {}),
      budget: this.budget,
      maxCallsPerPass: this.options.maxCallsPerPass ?? defaultSnifferMaxCallsPerPass(lane.kind),
      shouldYield: () => this.yieldNow(),
      signal,
    });
    if (report.calls > 0 || report.verdictsApplied > 0) {
      this.options.log?.(
        `Olympus tier sniffer: ${report.calls} call(s), ${report.verdictsApplied} verdict(s) applied `
        + `(${report.resolvedPersonal} Personal, ${report.resolvedPrivate} Private, ${report.failSafePrivate} fail-safe Private), `
        + `${report.cacheHits} from cache${report.stoppedBy ? `, stopped: ${report.stoppedBy}` : ''}.`,
      );
    }
    const autoMoves = this.options.autoMoves && !signal.aborted && !this.answering() && this.options.autoMoves.localEmbeddingsOnly()
      ? await this.runAutoMoves(this.options.autoMoves, signal)
      : undefined;
    return { state: 'ran', report, ...(rejudged.seen > 0 ? { rejudged } : {}), ...(autoMoves ? { autoMoves } : {}) };
  }

  private answering(): boolean {
    try {
      return this.options.answersInFlight?.() ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Settles each set's stored items a bounded page per tick: newly added
   * raising owner rules raise what they match (tier-rules-sweep.ts), and
   * items a names-only folder covers stop waiting for text
   * (tier-names-only-settle.ts). Never throws.
   */
  private settleStoredItems(): void {
    for (const ledgerPath of this.ledgerPaths()) {
      const set = tierSetForLedger(ledgerPath);
      if (!set) continue;
      try {
        const report = sweepOwnerRuleRaises({ set });
        if (report.raised > 0 || report.secrets > 0) {
          this.options.log?.(
            `Olympus tier rules: ${report.raised} stored item(s) raised by a new owner rule (hidden first)`
            + `${report.secrets ? `, ${report.secrets} made Secrets` : ''}.`,
          );
        }
      } catch {
        // A set that cannot be read keeps its placements this tick.
      }
      try {
        const settled = settleNamesOnlyItems({ set });
        if (settled.settled > 0) {
          this.options.log?.(`Olympus tier names-only: ${settled.settled} stored item(s) settled on their names.`);
        }
      } catch {
        // Left pending this tick.
      }
    }
  }

  /** Re-judges a page of each set's routed items decided under older inputs; never throws. */
  private rejudge(): TierRejudgeReport {
    const total = emptyTierRejudgeReport();
    const perPass = this.options.rejudgePerPass ?? DEFAULT_TIER_REJUDGE_PER_PASS;
    if (perPass <= 0) return total;
    const maxOpen = Math.max(0, this.options.rejudgeMaxOpenQuestions ?? 2 * perPass);
    for (const ledgerPath of this.ledgerPaths()) {
      const set = tierSetForLedger(ledgerPath);
      if (!set) continue;
      try {
        // Questions already waiting: re-judging more than the sniffer can
        // answer only grows the queue.
        if (this.options.installed.snifferStoreForLedger(ledgerPath).counts().questions >= maxOpen) continue;
        const after = this.rejudgeCursors.get(ledgerPath);
        const { report, next } = rejudgeRoutedItems({
          set,
          limit: perPass,
          ...(after ? { after } : {}),
          autoMoves: this.autoMovesFor(set),
        });
        if (next) this.rejudgeCursors.set(ledgerPath, next);
        else this.rejudgeCursors.delete(ledgerPath);
        for (const key of Object.keys(total) as Array<keyof TierRejudgeReport>) total[key] += report[key];
      } catch {
        // A set that cannot be read keeps its recorded decisions this tick.
      }
    }
    if (total.updated > 0 || total.movesQueued > 0 || total.asked > 0 || total.secrets > 0) {
      this.options.log?.(
        `Olympus tier sniffer: re-judged ${total.updated + total.movesQueued + total.asked + total.secrets} item(s) under the current classifier `
        + `(${total.asked} asked about, still where they were; ${total.movesQueued} tier move(s) queued`
        + `${total.secrets ? `; ${total.secrets} Secret(s) found and hidden` : ''}).`,
      );
    }
    return total;
  }

  /** Whether this set's queued moves run automatically (see `autoMoves`). */
  private autoMovesFor(set: TieredStoreSet): boolean {
    const options = this.options.autoMoves;
    if (!options) return false;
    try {
      return options.localEmbeddingsOnly() && setEmbedsWithBuiltInOnly(set);
    } catch {
      return false;
    }
  }

  /** Carries out queued moves the sniffer's verdicts made, bounded per pass. */
  private async runAutoMoves(
    options: NonNullable<TierSnifferServiceOptions['autoMoves']>,
    signal: AbortSignal,
  ): Promise<TierAutoMoveReport> {
    const report: TierAutoMoveReport = { moved: 0, failed: 0, notEligible: 0 };
    const staleAfterMs = Math.max(0, options.staleAfterMs ?? DEFAULT_STALE_MOVE_MS);
    const now = (this.options.now ?? (() => new Date()))().getTime();
    let budget = Math.max(0, options.maxPerPass ?? DEFAULT_AUTO_MOVES_PER_PASS);
    for (const ledgerPath of this.ledgerPaths()) {
      if (budget === 0 || signal.aborted) break;
      const set = tierSetForLedger(ledgerPath);
      if (!set) continue;
      const queued = set.ledger.listMoving({ limit: budget })
        .filter((record) => record.routed
          && record.targetMetadataTier !== null && record.targetContentTier !== null
          && record.targetMetadataTier !== 'secrets' && record.targetContentTier !== 'secrets');
      if (queued.length === 0) continue;
      if (!setEmbedsWithBuiltInOnly(set)) {
        report.notEligible += queued.length;
        continue;
      }
      for (const record of queued) {
        if (budget === 0 || signal.aborted || this.answering()) break;
        budget -= 1;
        const identity = recordIdentity(record);
        const failureKey = `${ledgerPath}\u0000${tierLedgerIdentityKey(identity)}\u0000${record.generation}`;
        try {
          // A raise (a re-judged item now held) hid its copies first: they
          // are the move's sources all the same.
          const source = set.ledger.copies(identity).find((copy) => copy.state === 'current'
            || (copy.state === 'superseded' && copy.supersededByGeneration === record.generation + 1));
          const exported = source ? set.store(source.trustDomain)?.exportItemCopy(identity) : undefined;
          if (!exported) throw new Error('no current copy');
          await moveTieredItem({
            set,
            identity: { ...identity, family: exported.identity.family, localItemId: exported.identity.localItemId },
            target: { metadataTier: record.targetMetadataTier!, contentTier: record.targetContentTier! },
            embeddingLedger: { path: options.embeddingLedgerPath, approvedBy: 'system-automatic', why: AUTO_MOVE_WHY },
            // Every embedding here is the built-in local model: an older
            // superseded copy this item's own earlier move left in the
            // destination costs nothing to replace, and keeping it would
            // strand the item mid-move (hidden, on a raise).
            replaceOwnSupersededCopy: true,
          });
          report.moved += 1;
          this.moveFailures.delete(failureKey);
        } catch {
          // The move stays queued (held, never shown twice); the next pass or
          // the owner-approved migration picks it up.
          report.failed += 1;
          // To the back of the queue: a move that keeps failing never holds
          // the head of a page while moves behind it could land.
          try {
            set.ledger.recordMoveFailure(identity, { expectedGeneration: record.generation });
          } catch {
            // Counting is best effort.
          }
          const firstFailedAt = this.moveFailures.get(failureKey) ?? now;
          this.moveFailures.set(failureKey, firstFailedAt);
          if (now - firstFailedAt >= staleAfterMs && this.settleStaleMove(set, record, report)) {
            this.moveFailures.delete(failureKey);
          }
        }
      }
    }
    if (report.moved > 0 || report.failed > 0) {
      this.options.log?.(
        `Olympus tier sniffer: ${report.moved} automatic tier move(s), ${report.failed} failed`
        + `${report.abandoned ? `, ${report.abandoned} stale move(s) given up (back where they were)` : ''}`
        + `${report.staleRaises ? `, ${report.staleRaises} stale raise(s) kept hidden and queued` : ''}.`,
      );
    }
    return report;
  }

  /**
   * A move that kept failing past the stale bound. A lateral or lower move
   * hid nothing: it is abandoned, the item leaves `moving` at its tiers and
   * its copies serve as before. A raise hid its source for privacy: putting
   * that back would serve the item below its newest decision, so it stays
   * hidden and queued for a later pass or the owner-approved migration.
   */
  private settleStaleMove(set: TieredStoreSet, record: TierLedgerRecord, report: TierAutoMoveReport): boolean {
    try {
      // The ledger refuses a raise inside the same transaction that would
      // undo it, so no concurrent hide-first stage can slip in between.
      set.ledger.abandonMove(recordIdentity(record), { expectedGeneration: record.generation });
      report.abandoned = (report.abandoned ?? 0) + 1;
      return true;
    } catch (error) {
      if (error instanceof TierLedgerRaiseAbandonRefusedError) report.staleRaises = (report.staleRaises ?? 0) + 1;
      // Otherwise left queued; the next pass looks again.
      return false;
    }
  }
}

function recordIdentity(record: TierLedgerRecord): TierLedgerIdentity {
  return {
    provider: record.provider,
    accountScope: record.accountScope,
    providerItemId: record.providerItemId,
    ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}),
  };
}

const AUTO_MOVE_WHY = 'Automatic tier move after the privacy check: every embedding involved is the built-in local model (owner approval 2026-10-01).';

function isBuiltInLane(lane: SnifferLane): boolean {
  return lane.kind === BUILT_IN_SNIFFER_LANE.kind
    && lane.profileId === BUILT_IN_SNIFFER_LANE.profileId
    && lane.modelId === BUILT_IN_SNIFFER_LANE.modelId;
}

/** Every open store of the set embeds (if at all) with the built-in local model only. */
function setEmbedsWithBuiltInOnly(set: TieredStoreSet): boolean {
  try {
    return set.openStores().every((store) => store.embeddingAuthorities()
      .every((authority) => authority.provider === BUILT_IN_EMBEDDING_PROVIDER));
  } catch {
    return false;
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

import type { SnifferQuestion } from './sniffer-store.ts';
import { emptyTierMoveTimings, moveTieredItemsLowering, flushTierMoveNotes, type TierMoveOptions, type TierMoveResult } from '../connector-store/tier-move.ts';
import { controlPathHeadroom, ingestionTurn } from '../control-path-headroom.ts';
// The worker's background tick for the privacy-safe sniffer: a bounded
// `runSnifferPass` over every connector store, continuously while work remains.
// It yields only to actual inference using the same local model
// and does nothing until the owner has approved the exact classifier model
// and prompt version in the classification ledger.

import { SecretLocationsIndex, secretLocationsPathForStore } from './secret-locations.ts';
import { Database } from 'bun:sqlite';
import type { AnalystModel } from '../../core/analyst.ts';
import {
  CLASSIFICATION_LEDGER_BUILT_IN_DEFAULT_APPROVAL,
  appendClassificationLedgerEntryOnce,
  builtInDefaultRevoked,
  isClassifierApproved,
  readClassificationLedger,
} from '../classification-ledger.ts';
import { settleSecretsCopies } from '../connector-store/secrets-disposition.ts';
import { moveTieredItem, TierMoveContentChangedError, TierMoveRefusedError } from '../connector-store/tier-move.ts';
import { setEngineStep } from '../../core/engine-heartbeat.ts';
import type { LocalConnectorStore } from '../connector-store/local-index.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import { AUTO_MOVE_WHY, automaticTierMoveOptions, automaticTierMovesAllowed, setEmbedsWithBuiltInOnly } from '../connector-store/tier-auto-move.ts';
import { BUILT_IN_SNIFFER_LANE } from './built-in-sniffer.ts';
import type { InstalledTierClassification } from './installed-tier-classification.ts';
import { snifferId, snifferMaterialCarriesSecret, snifferPromptVersions, type SnifferLaneKind } from './sniffer.ts';
import type { SnifferLane } from './sniffer-lane.ts';
import {
  DEFAULT_SNIFFER_MAX_CALLS_PER_DAY,
  SNIFFER_MAX_CONCURRENT_CLOUD_CALLS,
  SnifferCallBudget,
  runSnifferPass,
  DEFAULT_SNIFFER_PASS_TIME_MS,
  prepareSnifferModel,
  resolveReleaseWindow,
  type SnifferPassReport,
  type SnifferTarget,
} from './sniffer-resolver.ts';
import { existsSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { retireStatePath } from '../../core/boot-progress.ts';
import { retiredEmbeddingPrefilterPaths, TIER_LEDGER_SQLITE_STORE_ID, tierSnifferPathForLedger } from './tier-ledger-path.ts';
import { tierSetPlannerForLedger, type AutomaticTierMoveContext } from './installed-tier-classification-registry.ts';
import { tierSetForLedger } from '../connector-store/tier-set-registry.ts';
import {
  DEFAULT_TIER_REJUDGE_PER_PASS,
  emptyTierRejudgeReport,
  rejudgeRoutedItemsInTurns,
  rejudgeStoredContent,
  settleRoutedSecrets,
  settleLegacySecrets,
  type TierRejudgeReport,
} from '../connector-store/tier-rejudge.ts';
import { settleNamesOnlyItemsOffThread } from '../connector-store/tier-names-only-settle.ts';
import { settlePersonalFirstItemsOffThread } from '../connector-store/tier-held-settle.ts';
import { sweepOwnerRuleRaisesOffThread } from '../connector-store/tier-rules-sweep.ts';
import { applyOwnerOverridesOffThread } from '../connector-store/tier-override-settle.ts';
import { retireSecretRedactions, retrySecretSideStoreDebtsOffThread } from '../connector-store/secrets-disposition.ts';
import { ledgerReadOffThread, settleStaleEmbedHolds } from '../connector-store/child-visibility.ts';
import { sweepImageContentToPrivateOffThread } from '../connector-store/tier-image-content-sweep.ts';
import { applyMediaJudgmentsOffThread } from '../connector-store/tier-media-judgment-sweep.ts';
import {
  TierLedger,
  TierLedgerRaiseAbandonRefusedError,
  TIER_LEDGER_UNREAD_RELABEL_DONE,
  RETIRED_EMBEDDING_CLEARANCE_REASON,
  copyServingLayer,
  tierLedgerIdentityKey,
  tierLedgerPathForStore,
  tierMovingDirectionClause,
  type TierLedgerIdentity,
  type TierLedgerRecord,
} from './tier-ledger.ts';

export const DEFAULT_TIER_SNIFFER_INTERVAL_MS = 1_000;
/**
 * While the private model is not answering, the scheduled passes wait this
 * long after the first failed pass, and NOT_ANSWERING_MAX_BACKOFF_MS after
 * later ones. A pass every second against a model that was off rescanned the
 * whole queue each time (Sparta, 2026-11-04, Delphi off: about 110% CPU).
 * A direct runOnce is never held back.
 */
export const NOT_ANSWERING_FIRST_BACKOFF_MS = 30_000;
export const NOT_ANSWERING_MAX_BACKOFF_MS = 60_000;

/**
 * A connector store, by what the sniffer needs: its path, and the tiered
 * store set ledger it is bound to, if any. The pass reads every ledger that
 * EXISTS (a store's own, a set's), each once, and never creates one.
 */
export interface TierSnifferServiceStore {
  readonly dbPath: string;
  /** The store's corpus, to name the source when something about it cannot be read. */
  readonly corpusId?: string;
  tierSetBinding?(): { ledgerId?: string; ledgerPath: string } | undefined;
  /** Where the bound set ledger sits now (found by its identity); a store without it is read by the recorded path. */
  tierSetLedgerPath?(): string | undefined;
  tierLedgerPathInUse?: LocalConnectorStore['tierLedgerPathInUse'];
  onDemandReadCandidate?: LocalConnectorStore['onDemandReadCandidate'];
  hasOnDemandGrant?: LocalConnectorStore['hasOnDemandGrant'];
  readOnDemand?: LocalConnectorStore['readOnDemand'];
  exportItemCopy?: LocalConnectorStore['exportItemCopy'];
  changeMarker?: LocalConnectorStore['changeMarker'];
  tombstoneCopy?: LocalConnectorStore['tombstoneCopy'];
}

/** The timer functions the service schedules with, so a test can drive them on a fake clock. */
export interface SnifferTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(timer: any): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: any): void;
}

const GLOBAL_TIMERS: SnifferTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

function unrefTimer(timer: unknown): void {
  (timer as { unref?: () => void } | undefined)?.unref?.();
}

export interface TierSnifferServiceOptions {
  installed: InstalledTierClassification;
  lane: SnifferLane;
  model: AnalystModel;
  stores: () => readonly TierSnifferServiceStore[];
  classificationLedgerPath: string;
  /** Test seam: ledger and queue rows at or below which the backlog is counted on every read. */
  backlogExactRows?: number;
  /** Test seam: rowids read per event-loop turn by a large backlog's count. */
  backlogSliceRows?: number;
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
  /**
   * Where extraction stands for an item's text (job-store.ts
   * itemExtractionState). Its content question can only exist once that
   * text lands, so an unread file with an active job is waiting for
   * extraction, not missing a question, and recovery leaves it pending; so
   * is one with no job yet, for a short grace after it was listed. Absent:
   * nothing is owed.
   */
  extractionState?: (identity: TierLedgerIdentity) => 'active' | 'none' | 'settled';
  /** The owner's own words about privacy (privacy-profile.ts), quoted into the prompt. */
  ownerContext?: () => string | undefined;
  /** Where the day's call count is kept across restarts (owner-only JSON). */
  budgetStatePath?: string;
  intervalMs?: number;
  /** Test seam: the timers behind the tick and wakes. Default: the global timers. */
  timers?: SnifferTimers;
  /**
   * Test seam: the monotonic clock (ms) behind slice deadlines and tick
   * timing. Default: performance.now(). A synthetic clock passed here stays
   * out of the worker's shared control-path clock.
   */
  monotonicNow?: () => number;
  /**
   * Test seam: the turn back to the event loop between units of work.
   * Default: the worker's shared control-path turn (control-path-headroom.ts).
   */
  ingestionTurn?: () => Promise<void> | undefined;
  /**
   * A pass that has made no progress (no call started or ended, no verdict,
   * no answer from the model's server, no step finished) for this long is
   * stopped at the next tick. A pass that is working is never cut off for its
   * length. Default DEFAULT_TIER_SNIFFER_STALL_MS.
   */
  maxPassMs?: number;
  /**
   * A stopped pass that still makes no progress this long after its stop
   * (something ignores the signal) is abandoned: its result is dropped and the
   * next tick runs a fresh pass. Default DEFAULT_TIER_SNIFFER_ABANDON_MS.
   */
  abandonAfterMs?: number;
  /**
   * How long a pass keeps yielding to other answers on the private model before it takes one turn anyway.
   * Default DEFAULT_CLASSIFICATION_FAIR_TURN_MS.
   */
  fairTurnAfterMs?: number;
  maxCallsPerPass?: number;
  /** Sniffer calls in flight at once, each one item alone (runSnifferPass `concurrentCalls`). */
  concurrentCalls?: number;
  passTimeMs?: number;
  maxCallsPerDay?: number;
  /** Any other reason to yield the private pool (the pass also yields to `answersInFlight` and `breakerOpen`). */
  shouldYield?: () => boolean;
  /**
   * Go easy on this computer (#922, local-pacing.ts). Applies to the built-in
   * judge only: while `trickle()` is true a pass makes one call and the next
   * scheduled pass waits `trickleGapMs`. Cloud and remote judges ignore it.
   */
  pacing?: { trickle(): boolean; readonly trickleGapMs: number };
  /** True while the private pool's breaker for the sniffer's model is open (it rests after failures). */
  breakerOpen?: () => boolean;
  /** The model's install state when it is not available (content-free, e.g. `failed`), for the waiting reason. */
  modelState?: () => string | undefined;
  /** True only while foreground inference uses this same local model. Moves drain independently. */
  answersInFlight?: () => boolean;
  /** True while one of the owner's own calls runs on this model: a pass never takes a fair turn against it (#1031). */
  ownerInFlight?: () => boolean;
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
   * owner's privacy words or judge model changed (tier-rejudge.ts). 0 turns it off. Default
   * DEFAULT_TIER_REJUDGE_PER_PASS. A set whose sniffer queue already holds
   * `rejudgeMaxOpenQuestions` questions is not re-judged that tick, so
   * re-judging never outruns the answers.
   */
  rejudgePerPass?: number;
  rejudgeMaxOpenQuestions?: number;
  /** The second round's sweep (judge-second-round.ts, #891): re-opens items the local judge held, after the re-judge. */
  secondRound?: (ledgerPaths: readonly string[], autoMovesFor: (set: TieredStoreSet) => boolean) => Promise<unknown>;
  /**
   * Automatic tier moves (owner approval 2026-10-01): queued moves (a held
   * item the sniffer judged Personal after all queues one) are carried out
   * raises immediately and lowerings in a separate bounded slice after the
   * pass, at most `maxPerPass` items, ONLY while `localEmbeddingsOnly()` says
   * every configured embedding is the built-in local model AND every store of
   * the item's set embeds with it (free, nothing leaves the Mac). Otherwise
   * the move stays queued for the owner-approved `olympus tier migrate` path.
   */
  autoMoves?: AutomaticTierMoveContext & {
    maxPerPass?: number;
    /** Destinations with newly visible chunks that still need vectors. */
    onEmbeddingNeeded?: (corpora: ReadonlySet<string>) => void;
    /** Ledgers where this drain moved an item or refused a move. */
    onPlacementChecked?: (ledgerPaths: ReadonlySet<string>) => void;
    /** Fixed lowering slice override; still capped at 25% of judge + moves. Default adapts to backlog. */
    lowerSliceMs?: number;
    /** Maximum synchronous copy batch. Default 25 items / 25 ms. */
    lowerBatchSize?: number;
    lowerBatchMs?: number;
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

/** Each tick has at most two recovery phases; each yields after this much work. */
export const MISSING_QUESTION_RECOVERY_PHASE_MS = 25;
export const DEFAULT_AUTO_MOVES_PER_PASS = 1000;
export const DEFAULT_LOWER_MOVE_SLICE_MS = 1000;
/** Absolute ceiling, also limited to one third of the judge budget. */
const MAX_LOWER_MOVE_SLICE_MS = 10_000;
export const DEFAULT_LOWER_MOVE_BATCH_MS = 25;
/**
 * A pass with no progress at all for this long is stopped (owner rule, 16 Nov
 * 2026: no arbitrary timeouts; work in progress is never cancelled). Its items
 * stay held and are asked again on a later pass.
 */
export const DEFAULT_TIER_SNIFFER_STALL_MS = 15 * 60_000;
/** A just-listed item's routing lands its store rows within this long; only then may recovery retire it. */
const ROUTED_ROWS_GRACE_MS = 15 * 60_000;
/** How long a listed file with no extraction job yet waits to be queued before recovery settles it. */
const EXTRACTION_ENQUEUE_GRACE_MS = 15 * 60_000;
/** A stopped pass with still no progress this long after its stop is abandoned. */
export const DEFAULT_TIER_SNIFFER_ABANDON_MS = 2 * 60_000;
/**
 * Answers go first, but they never hold classification off for good. An agent
 * asking without pause kept every pass yielding, so new items stayed Private
 * and unsearchable (1.4.0 release check, 2026-11-08). After this long of
 * yielding, one pass runs to its normal end, then answers lead again.
 */
export const DEFAULT_CLASSIFICATION_FAIR_TURN_MS = 60_000;
/**
 * Standing back for answers and the owner's searches is bounded for a new
 * arrival: after this long held back with one waiting, the judge asks about
 * that arrival once (one call, not interrupted), then stands back again.
 * Backlog work keeps waiting for the answers as before (test-mac, 14 Nov
 * 2026: a search every 34 s held a new email's judgment off for 9 min).
 */
export const ARRIVAL_STAND_BACK_MS = 15_000;
export const DEFAULT_STALE_MOVE_MS = 60 * 60_000;
export const BUILT_IN_CLASSIFIER_DEFAULT_APPROVAL_REASON = 'built-in local model, nothing leaves the Mac (owner default 2026-10-01)';

export interface TierAutoMoveReport {
  moved: number;
  failed: number;
  /** Queued moves left for the owner-approved migration (a store not on the built-in embedding model). */
  notEligible: number;
  timings?: ReturnType<typeof emptyTierMoveTimings>;
  elapsedMs?: number;
  /** Failed moves older than the stale bound that were given up: the item is back where it was. */
  abandoned?: number;
  /** Failed raises older than the stale bound: kept hidden and queued, never rolled back. */
  staleRaises?: number;
  /** Stale raises whose item no store holds any more: forgotten, since nothing is left to move or hide (#913). */
  retiredAbsent?: number;
  /** Why the failed moves failed, by error name (never an item's names or content): the log says what to look at. */
  failedBy?: Record<string, number>;
}

type BacklogCounts = Pick<TierClassificationBacklog, 'checkingItems' | 'remainingQuestions' | 'pendingItems' | 'pendingWithoutQuestion' | 'oldestPendingAgeMs'>;

function emptyBacklogCounts(): BacklogCounts {
  return { checkingItems: 0, remainingQuestions: 0, pendingItems: 0, pendingWithoutQuestion: 0, oldestPendingAgeMs: 0 };
}

/**
 * Queued moves examined per ledger when lowerings are counted, at most: the
 * oldest page of the moving queue (by the state index), never a scan of a
 * whole migration's queue. A page of raises can hide lowerings behind it, so
 * the count is a floor, which is all the note needs.
 */
const MOVES_SCAN_BOUND = 2_000;
/** Ledger and queue rows at or below which the backlog is counted on every read. */
const BACKLOG_EXACT_ROWS = 20_000;
/** How old a large backlog's served count may be before a new count starts. */
const BACKLOG_REFRESH_MS = 60_000;
/** Rowids read per event-loop turn by a large backlog's count. */
const BACKLOG_SLICE_ROWS = 5_000;
const STORED_WALK_BACKSTOP_MS = 60 * 60_000;

type StoredWalker = 'ownerOverrides' | 'ownerRules' | 'imageContent' | 'mediaJudgments' | 'namesOnly' | 'personalFirst' | 'rejudge' | 'staleEmbedHolds';
type StoredWalkResult = 'no_work' | 'changed' | 'more_rows' | 'read_failed' | 'inputs_unavailable' | 'queue_full' | 'retired';
interface StoredWalkStatus {
  lastRanAt: string;
  lastResult?: StoredWalkResult;
  reason: 'idle_unchanged' | 'retired' | 'backstop_due' | 'working';
}

interface StoredWalkState {
  status: StoredWalkStatus;
  active: boolean;
  clean?: { inputs: string; at: number } | undefined;
  lap?: { inputs: string | undefined } | undefined;
  after?: TierLedgerIdentity | undefined;
}

interface StoredWalkPage {
  complete?: boolean;
  changed?: boolean;
  failed?: boolean;
  retired?: boolean;
  next?: TierLedgerIdentity;
  blocked?: 'queue_full';
}

function newStoredWalk(now: number): StoredWalkState {
  return { active: false, status: { lastRanAt: new Date(now).toISOString(), reason: 'working' } };
}

async function runStoredWalk(
  walk: StoredWalkState,
  inputs: string | undefined,
  readPage: (after: TierLedgerIdentity | undefined) => Promise<StoredWalkPage>,
  clockMs: () => number,
): Promise<void> {
  if (walk.active || walk.status.reason === 'retired') return;
  const now = clockMs();
  const unchanged = walk.clean !== undefined && walk.clean.inputs === inputs;
  const backstop = unchanged && now - walk.clean!.at >= STORED_WALK_BACKSTOP_MS;
  if (unchanged && !backstop) return;

  walk.clean = undefined;
  const lap = walk.lap ??= { inputs };
  if (lap.inputs !== inputs) lap.inputs = undefined;
  walk.active = true;
  walk.status.lastRanAt = new Date(now).toISOString();
  walk.status.reason = backstop ? 'backstop_due' : 'working';
  try {
    const page = await readPage(walk.after);
    walk.after = page.next;
    if (page.changed || page.failed) lap.inputs = undefined;
    walk.status.lastResult = page.retired ? 'retired'
      : page.failed ? 'read_failed'
      : page.blocked ?? (page.changed ? 'changed' : page.complete === false ? 'more_rows' : inputs === undefined ? 'inputs_unavailable' : 'no_work');
    if (page.retired) walk.status.reason = 'retired';
    else if (page.complete !== false && lap.inputs !== undefined) {
      walk.clean = { inputs: lap.inputs, at: clockMs() };
      walk.status.reason = 'idle_unchanged';
    } else walk.status.reason = 'working';
    if (page.complete !== false) walk.lap = undefined;
  } catch {
    // Keep the cursor for retry and invalidate this lap's clean result.
    lap.inputs = undefined;
    walk.status = { ...walk.status, reason: 'working', lastResult: 'read_failed' };
  } finally {
    walk.active = false;
  }
}

async function staleEmbedHoldLap(ledger: TierLedger, turn: () => Promise<void> | undefined, log?: (line: string) => void): Promise<StoredWalkPage> {
  const settled = await settleStaleEmbedHolds(ledger, undefined, turn);
  if (settled) log?.(`Olympus embedding: released holds on ${settled} decided copies.`);
  return { changed: settled > 0 };
}

// Status maintenance takes the same walk for ledgers without a judge walk.
const unattendedEmbedHoldWalks = new WeakMap<TierLedger, StoredWalkState>();
export async function runUnattendedStaleEmbedHoldWalk(ledger: TierLedger, log: (line: string) => void): Promise<void> {
  let walk = unattendedEmbedHoldWalks.get(ledger);
  if (!walk) {
    walk = newStoredWalk(Date.now());
    unattendedEmbedHoldWalks.set(ledger, walk);
  }
  await runStoredWalk(walk, ledger.changeMarker({ ignoreSettleProgress: true }), () => staleEmbedHoldLap(ledger, ingestionTurn, log), Date.now);
  if (walk.status.lastResult === 'read_failed') log('Olympus embedding: could not check held copies. The next pass will retry.');
}

export interface TierClassificationBacklog {
  /** Background walks, by ledger. No stored item content or filesystem paths. */
  storedWalks?: Array<{ ledger: string; walkers: Partial<Record<StoredWalker | 'lowerContentRepair', StoredWalkStatus>> }>;
  /** Union of pending ledger items and items with open questions, including re-judges. */
  checkingItems: number;
  /** Questions still to ask (an item can have a names and an excerpt question). */
  remainingQuestions: number;
  pendingItems: number;
  /**
   * Items already judged lower (Personal, say) whose automatic move out of
   * Private is still queued: an agent outside this computer cannot find them
   * until it runs. Counted only where automatic moves run (a move waiting for
   * the owner is not "still checking"), among at most MOVES_SCAN_BOUND queued
   * moves per ledger, and at most once a minute (`lowerMovesQueued`), so a
   * large migration queue never costs a search a scan.
   */
  lowerMovesQueued: number;
  pendingWithoutQuestion: number;
  oldestPendingAgeMs: number;
  summary: string;
  /** The sniffer is waiting for the owner to approve its model and prompt. */
  awaitingOwnerApproval: boolean;
  /**
   * Exactly what waits for that approval (no item content): the dashboard's
   * Approve button approves this key and nothing else.
   */
  awaitingApproval?: ClassifierApprovalKey;
  /** Why the last tick asked nothing while questions wait (absent while asking or idle). */
  waiting?: TierSnifferWaiting;
  /**
   * Judged items whose queued move to their tier is refused each time it is
   * tried (since this process started): they stay in the store they are in.
   * Reasons are fixed words (tier-move.ts `TierMoveRefusal`), never item data.
   */
  movesRefused?: { items: number; attempts: number; byReason: Record<string, number> };
  /**
   * Sources whose privacy records could not be read: their items are held,
   * are not in the counts above, and wait until they can be read. Content-free.
   */
  unreadableSources?: Array<{ source: string; what: string }>;
}

/** One exact classifier the owner approves: lane, profile, model and prompt version. */
export interface ClassifierApprovalKey {
  lane: SnifferLaneKind;
  profileId: string;
  modelId: string;
  promptVersion: string;
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
  | 'cloud_stopped'
  | 'model_not_answering'
  | 'failed';

export interface TierSnifferWaiting {
  reason: TierSnifferWaitReason;
  label: string;
  /** When this reason was first seen (ISO). */
  since: string;
}

/**
 * Where the sniffer's time went between verdicts (#893), in monotonic
 * milliseconds. A cycle runs from the end of one tick to the end of the next;
 * wallMs is the time that passed, and idleMs + yieldedMs + stepsMs + passMs
 * add up to it:
 * - idleMs: waiting for the next tick to start (the timer or a wake);
 * - yieldedMs: that wait, when the tick before stopped to give the model to
 *   other work;
 * - stepsMs: the tick's work around the pass (settling, recovery, approval,
 *   re-judge and moves);
 * - passMs: the pass itself.
 * The pass divides into setupMs and dispatchMs (its own work outside model
 * calls), slotWaitMs (calls waiting for the shared model slot, which is
 * yielding too) and modelMs. These are summed per call, so with one call in
 * flight they add up to passMs; with several in flight they overlap and sum
 * past it. Verdicts a minute are always over wallMs.
 * Content-free numbers, a fixed set of them.
 */
export interface TierSnifferThroughput {
  cycles: number;
  verdicts: number;
  calls: number;
  wallMs: number;
  idleMs: number;
  yieldedMs: number;
  slotWaitMs: number;
  stepsMs: number;
  passMs: number;
  setupMs: number;
  dispatchMs: number;
  modelMs: number;
  passSwitches: number;
  verdictsPerMinute: number;
}

function emptyThroughput(): TierSnifferThroughput {
  return { cycles: 0, verdicts: 0, calls: 0, wallMs: 0, idleMs: 0, yieldedMs: 0, slotWaitMs: 0, stepsMs: 0, passMs: 0, setupMs: 0, dispatchMs: 0, modelMs: 0, passSwitches: 0, verdictsPerMinute: 0 };
}

export type TierSnifferTick =
  | { state: 'skipped_running' }
  | { state: 'awaiting_owner_approval'; lane: SnifferLaneKind; profileId: string; modelId: string; promptVersion: string }
  | { state: 'model_unavailable'; modelId: string }
  | { state: 'ran'; report: SnifferPassReport; rejudged?: TierRejudgeReport; autoMoves?: TierAutoMoveReport }
  | { state: 'failed'; error: string };

export class TierSnifferService {
  private readonly options: TierSnifferServiceOptions;
  private readonly budget: SnifferCallBudget;
  private timer: unknown;
  private continuation: unknown;
  /** When the last tick ended (performance.now() by default), for the idle time before the next one. */
  private lastTickEndedAt: number | undefined;
  /** The last tick's pass stopped to give the model to other work: the wait after it is yielding (#893). */
  private lastTickYielded = false;
  /** When the last recorded tick's bookkeeping ended: the wait for the next one starts here. */
  private cycleEndedAt: number | undefined;
  /** The last tick's work after its pass: lowerings and bookkeeping. */
  private lastAfterPassMs = 0;
  private lastCycle: TierSnifferThroughput | undefined;
  private readonly cycleTotals = emptyThroughput();
  private readonly moveAbort = new AbortController();
  private moving: Promise<TierAutoMoveReport> | undefined;
  private readonly moveLedgerOffsets = { raise: 0, lower: 0 };
  private movingDirection: 'raise' | 'lower' | undefined;
  private lowerMovePreempted = false;
  private running = false;
  private runningSinceMs = 0;
  /** When passes started yielding to other answers without a break (clock ms). */
  private yieldingSinceMs: number | undefined;
  /** This pass is taking its turn: it does not yield to other answers. */
  private fairTurn = false;
  /** Scheduled passes wait until this time while the model is not answering (0: no wait). */
  private notAnsweringUntilMs = 0;
  /** Going easy (#922): a scheduled pass waits until this time while the pacing says trickle. */
  private pacedUntilMs = 0;
  private notAnsweringPasses = 0;
  private overrunReported = false;
  /** When the running pass was aborted for overrunning (0: not aborted). */
  private overrunAbortedAtMs = 0;
  /** Bumped when a pass starts or is abandoned: an abandoned pass's late result is dropped. */
  private passGeneration = 0;
  /** The last reported reason a tick asked nothing (or 'asking'). */
  private waitingReason: string | undefined;
  private cloudLimitGeneration = 0;
  private lastBacklogLogMs = Number.NEGATIVE_INFINITY;
  private backlogCache: { counts: BacklogCounts; atMs: number } | undefined;
  private lowerMovesCache: { count: number; atMs: number; pendingItems: number } | undefined;
  private lastIdleLowerLogMs = Number.NEGATIVE_INFINITY;
  /** Why the judge last held back or gave way, and when that was last logged (a waiting arrival only). */
  private lastYieldReason: 'breaker' | 'answer' | 'owner_answer' | 'caller' | undefined;
  private lastHeldLogMs = Number.NEGATIVE_INFINITY;
  private lastSkipLogMs = Number.NEGATIVE_INFINITY;
  /** What could not be read, by ledger or store path: said in the backlog and once in the log, cleared when read again. */
  private readonly unreadable = new Map<string, string>();
  /** The running pass's last sign of progress, and the step it is in (for the stop line). */
  private lastProgressMs = 0;
  private passStep = 'starting';
  private readonly progress = (): void => { this.lastProgressMs = this.clockMs(); };
  /** Since when passes have been held back by answers or the owner (cleared when one runs). */
  private heldBackSinceMs: number | undefined;
  /** This pass is an arrival's bounded turn: it asks one new arrival and does not give way. */
  private arrivalTurn = false;
  private backlogRefresh: Promise<void> | undefined;
  private waiting: TierSnifferWaiting | undefined;
  /** When each queued move (ledger, item, generation) first failed in this process. */
  private readonly moveFailures = new Map<string, number>();
  /** Items whose queued move the primitive refused last time it was tried (ledger and item), with the refusal's fixed word. */
  private readonly movesRefusedNow = new Map<string, string>();
  private moveRefusalAttempts = 0;
  private abort: AbortController | undefined;
  private lastTick: TierSnifferTick | undefined;
  private stopped = false;
  private readonly ledgers = new Map<string, TierLedger>();
  /** The id each bound set ledger must have, by the path it was found at: a file there with another id is not read. */
  private readonly boundLedgerIds = new Map<string, string>();
  private readonly storedWalks = new Map<string, { set: TieredStoreSet; walks: Map<StoredWalker, StoredWalkState> }>();
  private readonly mediaJudgmentCursors = new WeakMap<TieredStoreSet, Map<LocalConnectorStore, string | null>>();
  /** Skip-only diagnostics sample a scanned window at most once per minute. */
  private lastBuiltinPromptSkipLogMs = -Infinity;
  /** Rotate each recovery phase independently so a large first ledger cannot starve others. */
  private readonly recoveryLedgerOffsets = new Map<string, number>();

  constructor(options: TierSnifferServiceOptions) {
    this.options = options;
    this.budget = new SnifferCallBudget({
      ...(options.maxCallsPerDay !== undefined ? { maxCallsPerDay: options.maxCallsPerDay } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.budgetStatePath ? { statePath: options.budgetStatePath } : {}),
    });
    options.installed.setReleaseWindowResolver(async (ledgerPath, request, signal, expected) => {
      const lane = options.lane;
      if (this.stopped || signal.aborted || options.modelAvailable?.() === false || options.breakerOpen?.()
        || lane.rejudgeReady === false) return { verdict: 'undecided' };
      const ownerContext = options.ownerContext?.();
      const versions = snifferPromptVersions(ownerContext);
      if (versions.cache !== expected.promptVersion || snifferId(lane, versions.cache) !== expected.snifferId) return { verdict: 'undecided' };
      const ledger = await readClassificationLedger(options.classificationLedgerPath);
      const key = { lane: lane.kind, profileId: lane.profileId, modelId: lane.modelId, promptVersion: versions.approval };
      const builtInDefault = options.autoApproveBuiltIn === true && isBuiltInLane(lane);
      if (!isClassifierApproved(ledger.entries, key, { builtInDefault })) return { verdict: 'undecided' };
      return resolveReleaseWindow({
        store: options.installed.snifferStoreForLedger(ledgerPath), lane, model: options.model,
        request, promptVersion: versions.cache, ...(ownerContext ? { ownerContext } : {}), signal, budget: this.budget,
      });
    });
  }

  private timers(): SnifferTimers {
    return this.options.timers ?? GLOBAL_TIMERS;
  }

  private monotonicNow(): number {
    return this.options.monotonicNow?.() ?? performance.now();
  }

  private ingestionTurn(): Promise<void> | undefined {
    return (this.options.ingestionTurn ?? ingestionTurn)();
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.timers().setInterval(() => { void this.drainMoves(); void this.scheduledRun(); }, this.options.intervalMs ?? DEFAULT_TIER_SNIFFER_INTERVAL_MS);
    unrefTimer(this.timer);
    this.wake();
  }

  /** Real local contention ended: resume immediately, including between idle polls. */
  wake(): void {
    if (this.stopped || this.continuation) return;
    this.continuation = this.timers().setTimeout(() => { this.continuation = undefined; void this.scheduledRun(); }, 0);
    unrefTimer(this.continuation);
  }

  /** The owner lifted a cloud stop; keep the same lane/model and release its terminal hold. */
  resumeCloudLimit(): void {
    this.cloudLimitGeneration++;
    this.notAnsweringPasses = 0;
    this.notAnsweringUntilMs = 0;
    this.wake();
  }

  /** A pass the timer or a wake asked for: held back while the model is not answering. */
  private async scheduledRun(): Promise<TierSnifferTick> {
    const held = this.notAnsweringUntilMs > this.clockMs() ? 'model_not_answering'
      : this.pacedUntilMs > this.clockMs() && this.trickle() ? 'going_easy' : undefined;
    if (held) {
      if (this.clockMs() - this.lastSkipLogMs >= 60_000) {
        this.lastSkipLogMs = this.clockMs();
        this.options.log?.(`Olympus tier sniffer: pass held back (${held}) at=${new Date(this.clockMs()).toISOString()}.`);
      }
      return { state: 'skipped_running' };
    }
    return this.runOnce();
  }

  /** A judge pass is running now: a restart on memory waits for it to end (engine-split/rss-restart.ts). */
  get passRunning(): boolean {
    return this.running;
  }

  /** Stop the tick. A pass in flight is aborted; its ledgers close when it ends. */
  stop(): void {
    this.stopped = true;
    this.moveAbort.abort();
    if (this.continuation) this.timers().clearTimeout(this.continuation);
    this.continuation = undefined;
    if (this.timer) this.timers().clearInterval(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    if (!this.running) this.closeLedgers();
  }

  /**
   * An answer needs the private pool (the worker calls this when answers in
   * flight go from 0 to 1, and when an answer is queued behind a running
   * call): abort the sniffer's in-flight call at once. The pass stops as
   * `preempted`; nothing is counted against any item, and the sniffer never
   * records anything in the answer pool's breakers.
   */
  preempt(): void {
    // The owner's own answer ends a fair turn too, lowering slice included:
    // only other answers are outlasted, never the owner (#1030 review).
    this.fairTurn = false;
    this.yieldingSinceMs = undefined;
    // An arrival's turn is one short call: it finishes, then the pass ends.
    if (this.arrivalTurn) return;
    this.abort?.abort();
  }

  /**
   * The classification backlog, counts only: how many items are waiting on
   * the sniffer and how many questions are still to ask. No time estimate
   * (owner ruling: an unreliable one is worse than none).
   *
   * A small backlog is counted on every read. A large one is counted in
   * bounded slices off the read path and served from the last count, at most
   * a minute old: one full count of 650k pending items held the event loop
   * for seconds, and the status read and the minute log line both ran it
   * (Sparta CPU samples, 2026-11-05).
   */
  backlog(): TierClassificationBacklog {
    const backlog = this.backlogFrom(this.backlogCounts());
    return { ...backlog, lowerMovesQueued: this.lowerMovesQueued(backlog.pendingItems) };
  }

  /**
   * Queued lowering moves that automatic moves will carry out (see
   * `lowerMovesQueued`). Counted at most once per BACKLOG_REFRESH_MS: every
   * search, remote result and status read asks, and none may pay for a count.
   * A cached zero is not served once fewer items are pending than when it was
   * counted: those items may now wait in Private for a lowering, and a stale
   * zero would drop the privacy-backlog note just as pending reaches 0
   * (#1121). Queuing moves also clears the cache (`forgetLowerMoves`).
   */
  private lowerMovesQueued(pendingItems: number): number {
    const now = this.clockMs();
    const cached = this.lowerMovesCache;
    if (cached && now - cached.atMs < BACKLOG_REFRESH_MS
      && (cached.count > 0 || pendingItems >= cached.pendingItems)) return cached.count;
    const count = this.countLowerMovesQueued();
    this.lowerMovesCache = { count, atMs: now, pendingItems };
    return count;
  }

  /** Moves were queued: the next backlog read counts lowerings again (bounded). */
  private forgetLowerMoves(): void {
    this.lowerMovesCache = undefined;
  }

  private countLowerMovesQueued(): number {
    const autoMoves = this.options.autoMoves;
    try {
      if (!autoMoves || !autoMoves.localEmbeddingsOnly()) return 0;
    } catch {
      this.noteUnreadable('automatic moves', 'which search model the automatic privacy moves use');
      return 0;
    }
    this.noteReadable('automatic moves');
    let queued = 0;
    for (const ledgerPath of this.ledgerPaths()) {
      try {
        const set = tierSetForLedger(ledgerPath);
        if (!set || !setEmbedsWithBuiltInOnly(set)) continue;
      } catch {
        this.noteUnreadable(ledgerPath, 'its store set, so its automatic privacy moves are not counted');
        continue;
      }
      const opened = this.openBacklogLedger(ledgerPath);
      if (!opened) continue;
      try {
        // The inner page bounds the rows examined (the direction test has a
        // correlated subquery the state index cannot answer); it is named
        // tier_items so the shared direction clause reads its columns.
        queued += (opened.db.query(`SELECT COUNT(*) AS n FROM (
          SELECT * FROM tier_items WHERE state = 'moving' LIMIT ?
        ) AS tier_items WHERE 1 ${tierMovingDirectionClause('lower')}`).get(MOVES_SCAN_BOUND) as { n: number }).n;
        this.noteReadable(ledgerPath);
      } catch {
        this.noteUnreadable(ledgerPath, 'its queued privacy moves');
      } finally { opened.db.close(); }
    }
    return queued;
  }

  private backlogCounts(): BacklogCounts {
    if (this.backlogRows() <= (this.options.backlogExactRows ?? BACKLOG_EXACT_ROWS)) return this.countBacklogNow();
    if (this.backlogCache && this.clockMs() - this.backlogCache.atMs < BACKLOG_REFRESH_MS) return this.backlogCache.counts;
    if (!this.backlogRefresh) {
      this.backlogRefresh = (this.options.backlogSliceRows === undefined && typeof Worker !== 'undefined'
        ? this.countBacklogOffThread() : this.countBacklogInSlices())
        .then((counts) => { if (counts) this.backlogCache = { counts, atMs: this.clockMs() }; })
        .catch(() => undefined)
        .finally(() => { this.backlogRefresh = undefined; });
    }
    return this.backlogCache?.counts ?? this.roughBacklog();
  }

  private backlogFrom(counts: BacklogCounts): Omit<TierClassificationBacklog, 'lowerMovesQueued'> {
    const { checkingItems, remainingQuestions, pendingWithoutQuestion, oldestPendingAgeMs } = counts;
    const now = this.clockMs();
    const storedWalks = [...this.storedWalks.values()].map(({ set, walks }) => {
      const repair = set.lowerContentRepairHealth();
      const walkers = Object.fromEntries([...walks].map(([name, walk]) => [name, {
        ...walk.status,
        ...(walk.clean && now - walk.clean.at >= STORED_WALK_BACKSTOP_MS ? { reason: 'backstop_due' as const } : {}),
      }]));
      return { ledger: set.setId, walkers: { ...walkers, ...(repair ? { lowerContentRepair: repair } : {}) } };
    });
    return {
      ...counts,
      ...(storedWalks.length ? { storedWalks } : {}),
      summary: checkingItems === 0
        ? (this.unreadable.size > 0 ? `No items counted as waiting.${this.unreadableNote()}` : 'No items waiting for classification.')
        : `Checking ${checkingItems} item${checkingItems === 1 ? '' : 's'}, about ${remainingQuestions} question${remainingQuestions === 1 ? '' : 's'} remaining.`
          + (pendingWithoutQuestion > 0 ? ` ${pendingWithoutQuestion} pending item(s) have no question.` : '')
          + (oldestPendingAgeMs >= 3_600_000 ? ` Oldest pending item: ${Math.floor(oldestPendingAgeMs / 60_000)} minutes.` : '')
          + (this.waiting ? ` Nothing asked now: ${this.waiting.label}.` : '')
          + this.unreadableNote(),
      ...(this.movesRefusedNow.size > 0 ? { movesRefused: this.movesRefused() } : {}),
      awaitingOwnerApproval: this.lastTick?.state === 'awaiting_owner_approval',
      ...(this.lastTick?.state === 'awaiting_owner_approval' ? { awaitingApproval: {
        lane: this.lastTick.lane, profileId: this.lastTick.profileId, modelId: this.lastTick.modelId, promptVersion: this.lastTick.promptVersion,
      } } : {}),
      ...(checkingItems > 0 && this.waiting ? { waiting: { ...this.waiting } } : {}),
      ...(this.unreadable.size > 0 ? { unreadableSources: this.unreadableSources() } : {}),
    };
  }

  private movesRefused(): NonNullable<TierClassificationBacklog['movesRefused']> {
    const byReason: Record<string, number> = {};
    for (const why of this.movesRefusedNow.values()) byReason[why] = (byReason[why] ?? 0) + 1;
    return { items: this.movesRefusedNow.size, attempts: this.moveRefusalAttempts, byReason };
  }

  private unreadableNote(): string {
    if (this.unreadable.size === 0) return '';
    return ` Could not read ${this.unreadableSources().map(({ source, what }) => `${what} for ${source}`).join('; ')}: those items stay held and are not in these counts.`;
  }

  /** Nothing is left out silently: a skipped ledger or store is named in the backlog and once in the log. */
  private noteUnreadable(path: string, what: string): void {
    if (this.unreadable.get(path) === what) return;
    this.unreadable.set(path, what);
    this.options.log?.(`Olympus tier sniffer: could not read ${what} for ${this.sourceLabel(path)}; its items stay held and are not counted until it can be read; at=${new Date(this.clockMs()).toISOString()}.`);
  }

  private noteReadable(path: string): void {
    if (this.unreadable.delete(path)) this.options.log?.(`Olympus tier sniffer: ${this.sourceLabel(path)} can be read again; at=${new Date(this.clockMs()).toISOString()}.`);
  }

  /** The sources behind a ledger or store path, by corpus; never item content. */
  private sourceLabel(path: string): string {
    try {
      const corpora = [...new Set(this.options.stores()
        .filter(store => store.dbPath === path || tierLedgerPathForStore(store.dbPath) === path
          || this.ledgerPathsNamedBy(store).includes(path))
        .map(store => store.corpusId).filter((id): id is string => typeof id === 'string' && id.length > 0))];
      if (corpora.length > 0) return corpora.sort().join(', ');
    } catch {
      // Fall back to the file's own name below.
    }
    return basename(path);
  }

  /** The ledger paths a store names; one it cannot name (its binding unreadable) is already noted on its own path. */
  private ledgerPathsNamedBy(store: TierSnifferServiceStore): string[] {
    const named: string[] = [];
    for (const read of [() => store.tierLedgerPathInUse?.(), () => store.tierSetLedgerPath?.(), () => store.tierSetBinding?.()?.ledgerPath]) {
      try {
        const path = read();
        if (path) named.push(path);
      } catch (error) {
        void error; // The store's own path carries the unreadable note (ledgerPaths).
      }
    }
    return named;
  }

  private unreadableSources(): Array<{ source: string; what: string }> {
    return [...this.unreadable].map(([path, what]) => ({ source: this.sourceLabel(path), what }));
  }

  /** Opens a ledger for a backlog count, with its queue attached; undefined when it is not the bound ledger or cannot be read. */
  private openBacklogLedger(ledgerPath: string): { db: Database; hasQueue: boolean } | undefined {
    let db: Database | undefined;
    try {
      db = new Database(ledgerPath, { readonly: true, create: false });
      db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON;');
      const expectedId = this.boundLedgerIds.get(ledgerPath);
      if (expectedId !== undefined) {
        const row = db.query(`SELECT value FROM tier_ledger_meta WHERE key = 'ledger_id'`).get() as { value?: unknown } | null;
        // Counted for the ledger its store is bound to, not for whatever sits at the path now.
        if (row?.value !== expectedId) { db.close(); this.noteUnreadable(ledgerPath, 'the privacy ledger its store is bound to (another file is at its path)'); return undefined; }
      }
      const path = tierSnifferPathForLedger(ledgerPath);
      const hasQueue = existsSync(path);
      if (hasQueue) db.query('ATTACH DATABASE ? AS queue').run(path);
      return { db, hasQueue };
    } catch {
      db?.close();
      this.noteUnreadable(ledgerPath, 'its privacy ledger');
      return undefined;
    }
  }

  /** Upper bound on the rows a full count reads (largest rowids), without reading them. */
  private backlogRows(): number {
    let rows = 0;
    for (const ledgerPath of this.ledgerPaths()) {
      const opened = this.openBacklogLedger(ledgerPath);
      if (!opened) continue;
      try {
        rows += (opened.db.query('SELECT COALESCE(MAX(rowid), 0) AS n FROM tier_items').get() as { n: number }).n;
        if (opened.hasQueue) rows += (opened.db.query('SELECT COALESCE(MAX(question_pk), 0) AS n FROM queue.sniffer_questions').get() as { n: number }).n;
        this.noteReadable(ledgerPath);
      } catch {
        this.noteUnreadable(ledgerPath, 'its privacy ledger');
      } finally { opened.db.close(); }
    }
    return rows;
  }

  /** Index-only counts for the first read of a large backlog, before its first full count lands. */
  private roughBacklog(): BacklogCounts {
    let pendingItems = 0;
    let remainingQuestions = 0;
    for (const ledgerPath of this.ledgerPaths()) {
      const opened = this.openBacklogLedger(ledgerPath);
      if (!opened) continue;
      try {
        pendingItems += (opened.db.query(`SELECT COUNT(*) AS n FROM tier_items WHERE state = 'pending'`).get() as { n: number }).n;
        if (opened.hasQueue) remainingQuestions += (opened.db.query('SELECT COUNT(*) AS n FROM queue.sniffer_questions').get() as { n: number }).n;
        this.noteReadable(ledgerPath);
      } catch {
        // No writes, migrations, or invented zero-valued rows on a status read.
        this.noteUnreadable(ledgerPath, 'its privacy ledger');
      } finally { opened.db.close(); }
    }
    return { checkingItems: Math.max(pendingItems, remainingQuestions ? 1 : 0), remainingQuestions, pendingItems, pendingWithoutQuestion: 0, oldestPendingAgeMs: 0 };
  }

  private countBacklogNow(): BacklogCounts {
    const counts = emptyBacklogCounts();
    for (const ledgerPath of this.ledgerPaths()) {
      const opened = this.openBacklogLedger(ledgerPath);
      if (!opened) continue;
      try {
        this.addPendingSlice(counts, opened, undefined);
        if (opened.hasQueue) this.addQuestionSlice(counts, opened.db, undefined);
        this.noteReadable(ledgerPath);
      } catch {
        // No writes, migrations, or invented zero-valued rows on a status read.
        this.noteUnreadable(ledgerPath, 'its privacy ledger');
      } finally { opened.db.close(); }
    }
    return counts;
  }

  /**
   * The same count as `countBacklogNow`, read in a worker of its own (the
   * ledger needs its queue attached, which the shared read pool does not
   * do). The sliced count held the loop 25 s in sum on lane 6's fixture, up to
   * 635 ms a slice. Undefined when stopped or when the worker fails.
   */
  private async countBacklogOffThread(): Promise<BacklogCounts | undefined> {
    const ledgers = this.ledgerPaths().map((path) => {
      const queue = tierSnifferPathForLedger(path);
      return { path, expectedId: this.boundLedgerIds.get(path) ?? null, queue: existsSync(queue) ? queue : null };
    });
    const sql = { pendingQueued: pendingCountSql(true), pendingAlone: pendingCountSql(false), questions: questionCountSql() };
    const results = await runBacklogCountWorker({ ledgers, sql });
    if (!results || this.stopped) return undefined;
    const counts = emptyBacklogCounts();
    const read = new Set(ledgers.map(ledger => ledger.path));
    for (const result of results) {
      if ('unreadable' in result) {
        read.delete(result.unreadable);
        this.noteUnreadable(result.unreadable, result.mismatch ? 'the privacy ledger its store is bound to (another file is at its path)' : 'its privacy ledger');
        continue;
      }
      counts.pendingItems += result.n;
      counts.pendingWithoutQuestion += result.missing ?? 0;
      counts.checkingItems += result.n + (result.other ?? 0);
      counts.remainingQuestions += result.questions;
      if (result.oldest) counts.oldestPendingAgeMs = Math.max(counts.oldestPendingAgeMs, this.clockMs() - Date.parse(result.oldest));
    }
    for (const path of read) this.noteReadable(path);
    return counts;
  }

  /** The same count as `countBacklogNow`, a rowid slice per event-loop turn; undefined when stopped part-way. */
  private async countBacklogInSlices(): Promise<BacklogCounts | undefined> {
    const counts = emptyBacklogCounts();
    const slice = Math.max(1, this.options.backlogSliceRows ?? BACKLOG_SLICE_ROWS);
    for (const ledgerPath of this.ledgerPaths()) {
      const opened = this.openBacklogLedger(ledgerPath);
      if (!opened) continue;
      try {
        const maxItem = (opened.db.query('SELECT COALESCE(MAX(rowid), 0) AS n FROM tier_items').get() as { n: number }).n;
        const maxQuestion = opened.hasQueue
          ? (opened.db.query('SELECT COALESCE(MAX(question_pk), 0) AS n FROM queue.sniffer_questions').get() as { n: number }).n : 0;
        // Bound each slice by actual rows rather than the numeric key span:
        // retired items and drained questions leave arbitrarily large holes.
        // The initial high-water marks keep new inserts from extending a count.
        for (let lo = 0; lo < maxItem;) {
          const hi = (opened.db.query(`SELECT MAX(rowid) AS n FROM (
            SELECT rowid FROM tier_items WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?
          )`).get(lo, maxItem, slice) as { n: number | null }).n;
          if (hi === null) break;
          this.addPendingSlice(counts, opened, [lo, hi]);
          lo = hi;
          await this.ingestionTurn();
          if (this.stopped) return undefined;
        }
        if (opened.hasQueue) {
          for (let lo = 0; lo < maxQuestion;) {
            const hi = (opened.db.query(`SELECT MAX(question_pk) AS n FROM (
              SELECT question_pk FROM queue.sniffer_questions
              WHERE question_pk > ? AND question_pk <= ? ORDER BY question_pk LIMIT ?
            )`).get(lo, maxQuestion, slice) as { n: number | null }).n;
            if (hi === null) break;
            this.addQuestionSlice(counts, opened.db, [lo, hi]);
            lo = hi;
            await this.ingestionTurn();
            if (this.stopped) return undefined;
          }
        }
        this.noteReadable(ledgerPath);
      } catch {
        // No writes, migrations, or invented zero-valued rows on a status read.
        this.noteUnreadable(ledgerPath, 'its privacy ledger');
      } finally { opened.db.close(); }
    }
    return counts;
  }

  /** Pending items (all, or rowids in (lo, hi]), with those that have no question and the oldest decision. */
  private addPendingSlice(counts: BacklogCounts, opened: { db: Database; hasQueue: boolean }, range: [number, number] | undefined): void {
    const queued = opened.hasQueue ? `EXISTS (SELECT 1 FROM queue.sniffer_questions q
      WHERE q.provider = t.provider AND q.account_scope = t.account_scope
      AND q.conversation_key = t.conversation_key AND q.provider_item_id = t.provider_item_id)` : '0';
    // NOT INDEXED keeps a slice on its rowid range instead of the state index (rowid lookups stay allowed).
    const pending = (range
      ? opened.db.query(`SELECT COUNT(*) AS n, SUM(CASE WHEN ${queued} THEN 0 ELSE 1 END) AS missing, MIN(decided_at) AS oldest
          FROM tier_items t NOT INDEXED WHERE t.rowid > ? AND t.rowid <= ? AND state = 'pending'`).get(range[0], range[1])
      : opened.db.query(`SELECT COUNT(*) AS n, SUM(CASE WHEN ${queued} THEN 0 ELSE 1 END) AS missing, MIN(decided_at) AS oldest
          FROM tier_items t WHERE state = 'pending'`).get()) as { n: number; missing: number | null; oldest: string | null };
    counts.pendingItems += pending.n;
    counts.pendingWithoutQuestion += pending.missing ?? 0;
    counts.checkingItems += pending.n;
    if (pending.oldest) counts.oldestPendingAgeMs = Math.max(counts.oldestPendingAgeMs, this.clockMs() - Date.parse(pending.oldest));
  }

  /** Questions (all, or question_pks in (lo, hi]), and the items they ask about that are not pending, each item once. */
  private addQuestionSlice(counts: BacklogCounts, db: Database, range: [number, number] | undefined): void {
    const where = range ? 'WHERE q.question_pk > ? AND q.question_pk <= ?' : '';
    const row = db.query(`SELECT COUNT(*) AS n, SUM(CASE
        WHEN EXISTS (SELECT 1 FROM queue.sniffer_questions e
          WHERE e.provider = q.provider AND e.account_scope = q.account_scope
          AND e.conversation_key = q.conversation_key AND e.provider_item_id = q.provider_item_id
          AND e.question_pk < q.question_pk) THEN 0
        WHEN EXISTS (SELECT 1 FROM tier_items t WHERE t.state = 'pending'
          AND t.provider = q.provider AND t.account_scope = q.account_scope
          AND t.conversation_key = q.conversation_key AND t.provider_item_id = q.provider_item_id) THEN 0
        ELSE 1 END) AS other
      FROM queue.sniffer_questions q ${where}`).get(...(range ?? [])) as { n: number; other: number | null };
    counts.remainingQuestions += row.n;
    counts.checkingItems += row.other ?? 0;
  }

  /**
   * A running or continuing classification pass outranks automatic inbox work,
   * unless the caller asks it to yield (an Inbox answer ready or running).
   * The pass is marked running from its first step (approval, recovery,
   * re-judge, moves), long before it reaches a question where it can yield; on
   * a 1 s tick that kept an overdue answer from ever starting (release check
   * 2026-10-29: queued 601 s after #620).
   */
  get hasPriority(): boolean {
    if (!this.running && this.continuation === undefined) return false;
    try {
      return this.options.shouldYield?.() !== true;
    } catch {
      return true;
    }
  }

  private readonly retiredPrefilterCleaned = new Set<string>();

  status(): { lane: string; modelId: string; callsToday: number; lastTick?: TierSnifferTick; waiting?: TierSnifferWaiting; throughput?: { last: TierSnifferThroughput; total: TierSnifferThroughput } } {
    return {
      lane: this.options.lane.kind,
      modelId: this.options.lane.modelId,
      callsToday: this.budget.usedToday(),
      ...(this.lastTick ? { lastTick: this.lastTick } : {}),
      ...(this.waiting ? { waiting: { ...this.waiting } } : {}),
      ...(this.lastCycle ? { throughput: { last: { ...this.lastCycle }, total: { ...this.cycleTotals } } } : {}),
    };
  }

  /** Adds one finished tick to the breakdown of time between verdicts (#893). */
  private recordCycle(tick: TierSnifferTick, waitBeforeMs: number, tickMs: number, afterPassMs: number): void {
    const timing = tick.state === 'ran' ? tick.report.timing : undefined;
    const cycle = emptyThroughput();
    cycle.cycles = 1;
    cycle.verdicts = tick.state === 'ran' ? tick.report.verdictsApplied : 0;
    cycle.calls = tick.state === 'ran' ? tick.report.calls : 0;
    if (this.lastTickYielded) cycle.yieldedMs = waitBeforeMs;
    else cycle.idleMs = waitBeforeMs;
    cycle.setupMs = timing?.setupMs ?? 0;
    cycle.dispatchMs = timing?.dispatchMs ?? 0;
    cycle.slotWaitMs = timing?.slotWaitMs ?? 0;
    cycle.modelMs = timing?.modelMs ?? 0;
    cycle.passSwitches = timing?.passSwitches ?? 0;
    // Measured wall time only: per-call sums overlap when several calls run at once.
    cycle.passMs = Math.min(timing?.passMs ?? 0, tickMs);
    cycle.stepsMs = tickMs - cycle.passMs;
    cycle.wallMs = waitBeforeMs + tickMs;
    cycle.verdictsPerMinute = cycle.wallMs > 0 ? cycle.verdicts * 60_000 / cycle.wallMs : 0;
    const totals = this.cycleTotals;
    for (const key of Object.keys(cycle) as (keyof TierSnifferThroughput)[]) {
      if (key !== 'verdictsPerMinute') totals[key] += cycle[key];
    }
    totals.verdictsPerMinute = totals.wallMs > 0 ? totals.verdicts * 60_000 / totals.wallMs : 0;
    this.lastCycle = cycle;
    this.lastAfterPassMs = afterPassMs;
    const stop = tick.state === 'ran' ? tick.report.stoppedBy : undefined;
    this.lastTickYielded = stop === 'yield' || stop === 'preempted';
  }

  async runOnce(): Promise<TierSnifferTick> {
    const cloudLimitGeneration = this.cloudLimitGeneration;
    if (this.stopped) return { state: 'skipped_running' };
    if (this.running) {
      // A pass that never settles would hold every later tick off for good
      // (2026-10-05: the queue sat untouched for two days with no log line).
      // Past the bound it is aborted (its model calls are cancelled) and said;
      // if it still has not settled a while after that (something ignores
      // the abort), it is abandoned and this tick runs a fresh pass.
      const nowMs = this.clockMs();
      const stalledMs = nowMs - this.lastProgressMs;
      if (stalledMs >= (this.options.maxPassMs ?? DEFAULT_TIER_SNIFFER_STALL_MS) && !this.overrunReported) {
        this.overrunReported = true;
        this.overrunAbortedAtMs = nowMs;
        this.abort?.abort();
        this.options.log?.(`Olympus tier sniffer: a pass made no progress for ${Math.round(stalledMs / 60_000)} min while ${this.passStep}; it was stopped. Its items stay held and are asked again; at=${new Date(this.clockMs()).toISOString()}.`);
        this.setWaiting('pass_stuck');
        return { state: 'skipped_running' };
      }
      if (this.overrunAbortedAtMs === 0
        || nowMs - Math.max(this.overrunAbortedAtMs, this.lastProgressMs) < (this.options.abandonAfterMs ?? DEFAULT_TIER_SNIFFER_ABANDON_MS)) {
        if (this.overrunAbortedAtMs === 0) this.setWaiting('pass_running');
        return { state: 'skipped_running' };
      }
      this.options.log?.('Olympus tier sniffer: a stopped pass did not end; it was abandoned and a new pass starts.');
      this.running = false;
    }
    const generation = ++this.passGeneration;
    this.arrivalTurn = this.arrivalTurnDue();
    if (this.arrivalTurn) this.heldBackSinceMs = undefined;
    this.running = true;
    this.runningSinceMs = this.clockMs();
    this.lastProgressMs = this.runningSinceMs;
    this.passStep = 'settling stored items';
    this.overrunReported = false;
    this.overrunAbortedAtMs = 0;
    const abort = new AbortController();
    this.abort = abort;
    let tick: TierSnifferTick;
    const leave = controlPathHeadroom.enter('tier-sniffer');
    const tickStarted = this.monotonicNow();
    const waitBeforeMs = this.cycleEndedAt === undefined ? 0 : Math.max(0, tickStarted - this.cycleEndedAt);
    let tickReturnedAt: number | undefined;
    try {
      tick = await this.tick(abort.signal);
      tickReturnedAt = this.monotonicNow();
      // The judge's deadline and tick timing have ended. Lowerings get their
      // own bounded slice before another pass starts, never its call budget.
      const lowerMoves = await this.drainMoves('lower');
      if (tick.state === 'ran' && lowerMoves) {
        tick.autoMoves = mergeAutoMoveReports(tick.autoMoves, lowerMoves);
      }
    } catch (error) {
      // Content-free: the class of failure only. Items stay pending.
      tick = { state: 'failed', error: error instanceof Error ? error.name : 'unknown' };
    } finally {
      leave();
      this.lastTickEndedAt = this.monotonicNow();
      // The turn is used: answers lead again, and a new wait starts from now.
      if (this.fairTurn) {
        this.fairTurn = false;
        this.yieldingSinceMs = undefined;
      }
    }
    // An abandoned pass that ends late changes nothing: a newer pass owns the state.
    if (generation !== this.passGeneration) {
      abort.abort();
      return tick;
    }
    const overran = this.overrunAbortedAtMs !== 0;
    // After an arrival's turn the bound starts again, so answers get the pool back.
    if (this.arrivalTurn) this.heldBackSinceMs = this.clockMs();
    this.arrivalTurn = false;
    this.running = false;
    this.abort = undefined;
    this.lastTick = tick;
    this.reportWaiting(tick, overran);
    // Any call that answered clears the hold, even when the pass then
    // stopped on failures: a model that is making progress is never held.
    if (this.waitingReason === 'cloud_stopped') {
      // An owner continuation may arrive while this pass is unwinding its stop.
      this.notAnsweringUntilMs = cloudLimitGeneration === this.cloudLimitGeneration ? Infinity : 0;
      if (this.notAnsweringUntilMs === 0) this.wake();
    } else if (tick.state === 'ran' && tick.report.calls > tick.report.failedCalls) {
      this.notAnsweringPasses = 0;
      this.notAnsweringUntilMs = 0;
    } else if (this.waitingReason === 'model_not_answering') {
      this.notAnsweringPasses += 1;
      this.notAnsweringUntilMs = this.clockMs()
        + (this.notAnsweringPasses === 1 ? NOT_ANSWERING_FIRST_BACKOFF_MS : NOT_ANSWERING_MAX_BACKOFF_MS);
    }
    if (this.options.log && this.clockMs() - this.lastBacklogLogMs >= 60_000) {
      this.lastBacklogLogMs = this.clockMs();
      const backlog = this.backlog();
      if (backlog.checkingItems > 0) this.options.log(`Olympus tier sniffer: pending=${backlog.pendingItems} questions=${backlog.remainingQuestions} pending_without_question=${backlog.pendingWithoutQuestion} oldest_pending_ms=${backlog.oldestPendingAgeMs} at=${new Date(this.clockMs()).toISOString()}.`);
    }
    // Going easy: the pass made its one call; the next scheduled one waits.
    if (tick.state === 'ran' && tick.report.calls > 0 && this.trickle()) this.pacedUntilMs = this.clockMs() + (this.options.pacing?.trickleGapMs ?? 0);
    if (this.stopped) this.closeLedgers();
    else if (this.timer && tick.state === 'ran' && !this.yieldNow()
      && tick.report.stoppedBy !== 'daily_budget' && tick.report.stoppedBy !== 'transport_failures' && tick.report.stoppedBy !== 'cloud_stopped'
      && (tick.report.verdictsApplied > 0 || tick.report.calls > tick.report.failedCalls
        || (tick.autoMoves?.moved ?? 0) > 0 || (tick.rejudged?.seen ?? 0) > 0
        || tick.report.stoppedBy === 'preempted')) this.wake();
    // The bookkeeping above (the backlog count) is the tick's too, not the wait after it.
    const cycleEndedAt = this.monotonicNow();
    this.recordCycle(tick, waitBeforeMs, cycleEndedAt - tickStarted,
      tickReturnedAt === undefined ? 0 : Math.max(0, cycleEndedAt - tickReturnedAt));
    this.cycleEndedAt = cycleEndedAt;
    return tick;
  }

  private clockMs(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  /** Local work goes easy while the owner uses this computer (#922); never for a cloud or remote judge. */
  private trickle(): boolean {
    if (!this.options.pacing || !isBuiltInLane(this.options.lane)) return false;
    try {
      return this.options.pacing.trickle();
    } catch {
      return false;
    }
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
    else if (tick.state === 'ran' && tick.report.stoppedBy === 'cloud_stopped') reason = 'cloud_stopped';
    // A model that is not answering: the pass stopped on its transport
    // failures, or every call it made failed (one question left fails once,
    // below the stop threshold). Each failed dispatch still counts as a
    // call, so this is never told by a call count of zero.
    else if (tick.state === 'ran' && tick.report.pendingSeen > 0
      && (tick.report.stoppedBy === 'transport_failures' || (tick.report.calls > 0 && tick.report.failedCalls === tick.report.calls))) {
      reason = 'model_not_answering';
    }
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
    this.options.log?.(`Olympus tier sniffer: questions are waiting, nothing asked: ${label}; at=${new Date(this.clockMs()).toISOString()}.`);
  }

  private waitLabel(reason: TierSnifferWaitReason, tick?: TierSnifferTick): string {
    switch (reason) {
      case 'yielding_to_answers': return 'yielding to answers in progress';
      case 'breaker_open': return 'the private model is resting after failures';
      case 'pass_running': return 'a pass is still running';
      case 'pass_stuck': return 'a pass made no progress and was stopped; its items stay held and are asked again';
      case 'awaiting_owner_approval': return 'waiting for the owner to approve the classifier';
      case 'no_model': {
        const state = this.modelState();
        return `the private model is not available${state ? ` (${state})` : ''}`;
      }
      case 'daily_budget': return 'the daily call budget is used up';
      case 'cloud_stopped': return 'cloud privacy sorting is stopped; open Keys to check the spending limit or Venice account; remaining items stay Private';
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
    if (this.breakerOpen()) { this.lastYieldReason = 'breaker'; return true; }
    if (this.running && this.arrivalTurn) return false;
    const held = this.holdsBack();
    if (this.running) this.heldBackSinceMs = held ? this.heldBackSinceMs ?? this.clockMs() : undefined;
    return held;
  }

  private isOnDemandRead(question: SnifferQuestion): boolean {
    return this.options.stores().some(store => {
      // Most items hold no grant: an indexed lookup rules them out before the
      // candidate's own checks, which find the item by its provider id alone.
      if (store.hasOnDemandGrant && !store.hasOnDemandGrant(question)) return false;
      const candidate = store.onDemandReadCandidate?.(question.providerItemId);
      return !!candidate && candidate.identity.provider === question.provider && candidate.identity.accountScope === question.accountScope
        && store.readOnDemand?.(candidate.identity.localItemId) === true;
    });
  }

  /**
   * An arrival held back past ARRIVAL_STAND_BACK_MS gets the next pass as its
   * turn. A file read on demand gets it at once: the question waiting on it is
   * the answer the judge would otherwise stand back for.
   */
  private arrivalTurnDue(): boolean {
    if (this.heldBackSinceMs === undefined) return false;
    if (this.breakerOpen()) return false;
    if (this.clockMs() - this.heldBackSinceMs < ARRIVAL_STAND_BACK_MS) {
      try {
        // The ledgers earlier passes opened: reading the stores again here
        // would cost every held-back pass a store listing.
        // Before any pass opened one, the stores are read once.
        const paths = this.ledgers.size > 0 ? [...this.ledgers.keys()] : this.ledgerPaths();
        return paths.some(path => this.options.installed.snifferStoreForLedger(path)
          .arrivalContentQuestions().some(question => this.isOnDemandRead(question)));
      } catch {
        return false;
      }
    }
    try {
      return this.ledgerPaths().some(path => this.options.installed.snifferStoreForLedger(path).hasArrivalWaiting());
    } catch {
      return false;
    }
  }

  private holdsBack(): boolean {
    let busy = this.answering();
    this.lastYieldReason = busy ? 'answer' : undefined;
    if (!busy) {
      try {
        busy = this.options.shouldYield?.() ?? false;
      } catch {
        busy = false;
      }
      if (busy) this.lastYieldReason = 'caller';
    }
    // Only a pass takes a turn; the timer's move drain still yields.
    if (!this.running) return busy;
    if (!busy) {
      if (!this.fairTurn) this.yieldingSinceMs = undefined;
      return false;
    }
    // A long owner call still running ends a turn and holds the wait at its
    // start, as preempt() does when that call begins (#1031).
    if (this.ownerAnswering()) {
      this.lastYieldReason = 'owner_answer';
      this.fairTurn = false;
      this.yieldingSinceMs = undefined;
      return true;
    }
    if (this.fairTurn) return false;
    const now = this.clockMs();
    this.yieldingSinceMs ??= now;
    if (now - this.yieldingSinceMs < (this.options.fairTurnAfterMs ?? DEFAULT_CLASSIFICATION_FAIR_TURN_MS)) return true;
    this.fairTurn = true;
    this.options.log?.('Olympus tier sniffer: answers kept the private model busy; this pass takes its turn.');
    return false;
  }

  /** Every existing ledger behind the stores, each once: bound set ledgers and stores' own. */
  private ledgerPaths(): string[] {
    const paths = new Set<string>();
    for (const store of this.options.stores()) {
      if (store.dbPath === ':memory:') continue;
      try {
        const binding = store.tierSetBinding?.();
        const bound = store.tierSetLedgerPath ? store.tierSetLedgerPath() : binding?.ledgerPath;
        if (bound && bound !== ':memory:' && existsSync(bound)) {
          paths.add(bound);
          if (binding?.ledgerId) this.boundLedgerIds.set(bound, binding.ledgerId);
        }
        this.noteReadable(store.dbPath);
      } catch {
        // Fails closed elsewhere; the sniffer skips it, and says so.
        this.noteUnreadable(store.dbPath, 'which privacy ledger the store is bound to');
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
      // The path was found by reading the ledger's id on a connection of its
      // own, so check the handle that is kept: the file can have been replaced
      // in between. A replacement has had its schema migrated by this open;
      // that is accepted, since it is closed unused.
      const expectedId = this.boundLedgerIds.get(path);
      if (expectedId !== undefined && ledger.ledgerId() !== expectedId) {
        ledger.close();
        throw new Error('The tier ledger at this path is not the one its store is bound to.');
      }
      this.ledgers.set(path, ledger);
    }
    return ledger;
  }

  private closeLedgers(): void {
    for (const ledger of this.ledgers.values()) {
      try {
        ledger.close({ checkpoint: true });
      } catch {
        // Best effort at shutdown.
      }
    }
    this.ledgers.clear();
  }

  private snifferTargets(): SnifferTarget[] {
    const targets: SnifferTarget[] = [];
    for (const ledgerPath of this.ledgerPaths().sort()) {
      let ledger: TierLedger;
      try {
        ledger = this.ledgerAt(ledgerPath);
      } catch {
        // Not the ledger its store is bound to: left alone this pass, and said.
        this.noteUnreadable(ledgerPath, 'the privacy ledger its store is bound to (another file is at its path)');
        continue;
      }
      const planner = tierSetPlannerForLedger(ledgerPath);
      targets.push({
        ledger,
        sniffer: this.options.installed.snifferStoreForLedger(ledgerPath),
        onDemandRead: question => this.isOnDemandRead(question),
        ...(planner ? { placementFor: planner } : {}),
        screenStoredQuestion: question => {
          const row = ledger.getCurrent(question);
          // Routed rows have the full-copy rejudge path. Unread names have
          // no body yet; their eventual content pass will screen it.
          if (!row || row.routed || !row.contentRead) return 'clean';
          const set = tierSetForLedger(ledgerPath);
          const stores = set?.openStores() ?? this.options.stores().filter(store =>
            (store.tierLedgerPathInUse?.() ?? tierLedgerPathForStore(store.dbPath)) === ledgerPath);
          try {
            // A clean excerpt cannot carry the retry marker when settlement
            // tombstoned the body and then failed writing the final ledger row.
            const home = stores[0];
            if (!home) return 'unreadable';
            const shared = set?.secrets();
            const locations = shared ?? new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(home.dbPath) });
            try {
              if (locations.get(question)?.findingKinds.includes('sniffer_secret_refusal')) return 'secrets';
            } finally { if (!shared) locations.close(); }
            let foundBody = false;
            for (const store of stores) {
              if (!store.exportItemCopy) return 'unreadable';
              const copy = store.exportItemCopy(question);
              if (!copy) continue;
              const body = copy.chunks.map(chunk => chunk.boundedText).join('');
              if (!body.trim()) continue;
              foundBody = true;
              if (snifferMaterialCarriesSecret(body)) return 'secrets';
            }
            return foundBody ? 'clean' : 'unreadable';
          } catch {
            // No excerpt or cached model verdict can stand in for a failed
            // full-copy read. Leave the question held for a later scan.
            return 'unreadable';
          }
        },
        settleSecrets: (question, decision) => {
          const set = tierSetForLedger(ledgerPath);
          if (!ledger.getCurrent(question)?.routed) {
            const stores = set?.openStores() ?? this.options.stores().filter(
              (store): store is TierSnifferServiceStore & Pick<LocalConnectorStore, 'exportItemCopy' | 'tombstoneCopy'> =>
                (store.tierLedgerPathInUse?.() ?? tierLedgerPathForStore(store.dbPath)) === ledgerPath
                && typeof store.exportItemCopy === 'function' && typeof store.tombstoneCopy === 'function',
            );
            const home = stores[0];
            if (!home) return false;
            const shared = set?.secrets();
            const locations = shared ?? new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(home.dbPath) });
            try { return settleLegacySecrets({ ledger, stores, locations, identity: question, decision }); }
            finally { if (!shared) locations.close(); }
          }
          if (!set) return false;
          const row = ledger.getCurrent(question)!;
          if (row.contentTier === 'secrets' && row.reasons.includes('metadata:secret:sniffer_refused')) {
            // Settlement hides every copy before writing the location receipt
            // or tombstoning. Either write may fail, so recover from any hidden
            // copy, or from the receipt when all tombstones already landed.
            const locations = set.secrets();
            const copies = ledger.copies(question);
            const stores = new Map(copies.map(copy => {
              const domain = set.domainForCorpus(copy.corpusId);
              return [copy.corpusId, domain ? set.store(domain) : undefined] as const;
            }));
            if ([...stores.values()].some(store => !store)) return false;
            const ordered = [...copies].sort((a, b) => b.generation - a.generation);
            const serving = copyServingLayer(ordered, question.pass) ?? copyServingLayer(ordered, 'content');
            const remaining = serving ? stores.get(serving.corpusId)?.exportItemCopy(question) : undefined;
            if (!locations?.get(question)?.findingKinds.includes('sniffer_secret_refusal')) {
              if (!locations || !remaining) return false;
              // Reuse settlement's screened, location-only receipt builder;
              // a repeated record failure leaves copies hidden for retry.
              return settleRoutedSecrets(set, question, decision, remaining, { findingKinds: ['sniffer_secret_refusal'] });
            }
            if (remaining) {
              settleSecretsCopies({ ledger, identity: remaining.identity, copies,
                storeFor: corpusId => stores.get(corpusId), connectorId: 'tier-sniffer' });
            } else {
              // All tombstones landed before the interruption. Every store
              // was opened and checked above, so only the copy rows remain.
              ledger.removeCopies(question);
            }
            return true;
          }
          const current = set.ledger.copies(question).filter(copy => copy.state === 'current');
          const serving = copyServingLayer(current, question.pass);
          const domain = serving ? set.domainForCorpus(serving.corpusId) : undefined;
          const exported = domain ? set.store(domain)?.exportItemCopy(question) : undefined;
          return exported ? settleRoutedSecrets(set, question, decision, exported, { findingKinds: ['sniffer_secret_refusal'] }) : false;
        },
      });
    }
    for (const path of [...targets.map(target => target.ledger.dbPath), this.options.classificationLedgerPath]) {
      if (path === ':memory:' || this.retiredPrefilterCleaned.has(path)) continue;
      // Removed: a failed update puts the whole data root back, these
      // included (core/data-root-snapshot.ts).
      const retired = retiredEmbeddingPrefilterPaths(path);
      for (const directory of retired.directories) retireStatePath(process.env, 'embedding_prefilter_weights', directory);
      // Only a ledger whose -wal is fully written into it is removed, so a
      // reader still inside it is not left on a file that is gone. It stays
      // as it is, and the next start tries again.
      if (checkpointRetiredLedger(retired.ledger)) {
        retireStatePath(process.env, TIER_LEDGER_SQLITE_STORE_ID, retired.ledger);
        for (const suffix of ['-wal', '-shm']) rmSync(`${retired.ledger}${suffix}`, { force: true });
      }
      this.retiredPrefilterCleaned.add(path);
    }
    return targets;
  }

  private async tick(signal: AbortSignal): Promise<TierSnifferTick> {
    const { lane } = this.options;
    // Wall time of each step around the pass, for its log line: on Sparta
    // (2026-11-06) 30 s passes came 32-134 s apart, and nothing said where
    // the rest of the time went.
    const phaseStarted = this.monotonicNow();
    const idleMs = this.lastTickEndedAt === undefined ? undefined : phaseStarted - this.lastTickEndedAt;
    let phaseAt = phaseStarted;
    const phaseMs: Record<string, number> = {};
    const phase = (name: string): void => {
      const now = this.monotonicNow();
      phaseMs[name] = (phaseMs[name] ?? 0) + (now - phaseAt);
      phaseAt = now;
      this.progress();
      this.passStep = `in the step after "${name}"`;
      // Read by the heartbeat thread if the loop is then held (engine-heartbeat.ts).
      setEngineStep(`judge pass, after "${name}"`);
    };
    // Owner rules that raise, and names-only folders, apply to stored items
    // whatever the model's state: no model is asked.
    await this.settleStoredItems();
    phase('settle');
    const targets = this.snifferTargets();
    phase('targets');
    await this.recoverMissingQuestions(signal);
    phase('recover');
    if (this.options.modelAvailable && !this.options.modelAvailable()) {
      // Nothing is asked and nothing is counted: flagged items wait, pending
      // and held Private, until the model is there. A model whose download
      // never started is started here, so they never wait forever.
      try {
        this.options.startModel?.();
      } catch {
        // Starting is best effort; the next tick tries again.
      }
      await this.drainMoves();
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
      await this.drainMoves();
      return { state: 'awaiting_owner_approval', lane: lane.kind, profileId: lane.profileId, modelId: lane.modelId, promptVersion: versions.approval };
    }
    phase('approval');
    const preparationStopped = await prepareSnifferModel({ model: this.options.model, signal, shouldYield: () => this.yieldNow() });
    phase('prepare');
    // Items decided under another classifier, owner words or judge model are judged
    // again first (tier-rejudge.ts), a bounded page per set per tick: their
    // questions join the queue this pass answers.
    if (!preparationStopped) await this.recoverMissingQuestions(signal, true);
    phase('recover');
    const rejudged = preparationStopped ? emptyTierRejudgeReport() : await this.rejudge(snifferId(lane, versions.cache));
    phase('rejudge');
    if (!preparationStopped && this.options.secondRound) {
      try { await this.options.secondRound(this.ledgerPaths(), set => this.autoMovesFor(set)); } catch { /* Tried again next tick. */ }
    }
    this.passStep = `waiting on the judge model (${lane.modelId}) or its slot`;
    const report = await runSnifferPass({
      targets,
      lane,
      model: this.options.model,
      promptVersion: versions.cache,
      ...(ownerContext ? { ownerContext } : {}),
      budget: this.budget,
      maxCallsPerPass: this.arrivalTurn ? 1 : this.options.maxCallsPerPass,
      concurrentCalls: this.arrivalTurn ? 1 : this.options.concurrentCalls,
      ...(this.arrivalTurn ? { arrivalsOnly: true } : {}),
      passTimeMs: this.options.passTimeMs,
      // One clock for the tick and its pass, so the breakdown adds up (#893).
      ...(this.options.monotonicNow ? { monotonicNow: this.options.monotonicNow } : {}),
      shouldYield: () => this.yieldNow(),
      onProgress: this.progress,
      ...(this.options.pacing && isBuiltInLane(lane) ? { trickle: () => this.trickle() } : {}),
      signal,
    });
    phase('pass');
    if (report.verdictsApplied > 0) this.forgetLowerMoves();
    const autoMoves = await this.drainMoves();
    phase('moves');
    // A pass that made no call while an arrival waited says why, at most every 15 s.
    const arrivalHeld = report.calls === 0 && report.arrivalsWaiting > 0 && this.clockMs() - this.lastHeldLogMs >= 15_000;
    if (arrivalHeld) this.lastHeldLogMs = this.clockMs();
    if (report.calls > 0 || report.verdictsApplied > 0 || report.heldLowering > 0 || arrivalHeld) {
      const phases = Object.entries(phaseMs).map(([name, ms]) => `${name}=${Math.round(ms)}`).join(' ');
      this.options.log?.(
        `Olympus tier sniffer: ${report.calls} call(s), ${report.verdictsApplied} verdict(s) applied `
        + `(${report.resolvedPersonal} Personal, ${report.resolvedPrivate} Private, ${report.failSafePrivate} fail-safe Private), `
        + `${report.cacheHits} from cache; ${report.heldLowering} lowering(s) held${report.stoppedBy ? `, stopped: ${report.stoppedBy}` : ''}; `
        + `call_ms=${Math.round(report.callMs)} mean_call_ms=${report.calls ? Math.round(report.callMs / report.calls) : 0} queue_wait_max_ms=${Math.round(report.maxQueueWaitMs)}; `
        + `promptChars=${report.promptChars} mean_promptChars=${report.calls ? Math.round(report.promptChars / report.calls) : 0} estimatedInputTokens=${report.estimatedInputTokens} mean_estimatedInputTokens=${report.calls ? Math.round(report.estimatedInputTokens / report.calls) : 0}; `
        + `tick_ms=${Math.round(this.monotonicNow() - phaseStarted)} ${phases}${idleMs === undefined ? '' : ` idle_before=${Math.round(idleMs)} wait_before=${this.lastTickYielded ? 'yield' : 'idle'} after_prev_ms=${Math.round(this.lastAfterPassMs)}`}; `
        + `pass_ms=${Math.round(report.timing.passMs)} setup_ms=${Math.round(report.timing.setupMs)} dispatch_ms=${Math.round(report.timing.dispatchMs)} `
        + `slot_wait_ms=${Math.round(report.timing.slotWaitMs)} model_ms=${Math.round(report.timing.modelMs)} pass_switches=${report.timing.passSwitches}; `
        + `arrivals_waiting=${report.arrivalsWaiting} arrivals_taken=${report.arrivalsTaken} arrival_queue_age_max_ms=${Math.round(report.arrivalMaxQueueAgeMs)}`
        + `${report.stoppedBy === 'yield' && this.lastYieldReason ? ` yield_by=${this.lastYieldReason}` : ''} at=${new Date(this.clockMs()).toISOString()}.`,
      );
    }
    // A move that just landed may have carried an item whose owner override
    // came while it was queued: apply the override now, not a tick later.
    if (autoMoves && autoMoves.moved > 0) await this.applyOwnerOverrides();
    return { state: 'ran', report, ...(rejudged.seen > 0 || rejudged.builtinPromptSkipped > 0 ? { rejudged } : {}), ...(autoMoves ? { autoMoves } : {}) };
  }

  /**
   * The resolver drains the question queue, so it cannot see a lost enqueue,
   * an unread item with no possible excerpt, or an orphaned ledger row.
   * Reconcile a bounded, durable page before model availability/approval.
   */
  private async recoverMissingQuestions(signal: AbortSignal, allowReask = false): Promise<void> {
    // Cooperative bound: one row (including its synchronous store reads) may
    // finish after the deadline. Two phases cost at most two such overruns.
    const deadline = this.monotonicNow() + MISSING_QUESTION_RECOVERY_PHASE_MS;
    // Separate cursors keep model-independent recovery and approved re-asking
    // from skipping alternating pages of a large ledger.
    const cursorKey = allowReask ? 'sniffer_missing_question_reask_cursor_v1' : 'sniffer_missing_question_cursor_v1';
    const paths = this.ledgerPaths();
    const offset = (this.recoveryLedgerOffsets.get(cursorKey) ?? 0) % (paths.length || 1);
    for (let n = 0; n < paths.length; n++) {
      if (signal.aborted || this.stopped || (n > 0 && this.monotonicNow() >= deadline)) break;
      const index = (offset + n) % paths.length;
      const ledgerPath = paths[index]!;
      this.recoveryLedgerOffsets.set(cursorKey, (index + 1) % paths.length);
      try {
        const ledger = this.ledgerAt(ledgerPath);
        if (this.options.installed.forLedger(ledgerPath).unavailableReason) continue;
        const queue = this.options.installed.snifferStoreForLedger(ledgerPath);
        const set = tierSetForLedger(ledgerPath);
        const stores = set?.openStores() ?? this.options.stores().filter(store =>
          ((store.tierLedgerPathInUse?.() ?? tierLedgerPathForStore(store.dbPath)) === ledgerPath
            || tierLedgerPathForStore(store.dbPath) === ledgerPath));
        // An unavailable store is not evidence that its items were deleted.
        if (stores.length === 0 || stores.some(store => !store.exportItemCopy)) continue;
        // Once per ledger, a page per pass: older unread settlements get the
        // `unread` label they would get now (#847).
        // The page is found on the ledger's read worker; the loop relabels it by rowid.
        if (ledger.readMeta(TIER_LEDGER_UNREAD_RELABEL_DONE) !== '1') {
          const relabel = await ledgerReadOffThread(ledger, ledger.relabelUnreadFailSafeCandidateSteps());
          if (relabel.length === 0) ledger.writeMeta(TIER_LEDGER_UNREAD_RELABEL_DONE, '1');
          else ledger.relabelUnreadFailSafeRows(relabel);
        }
        const cursorLedger = set?.ledger ?? ledger;
        const saved = cursorLedger.readMeta(cursorKey);
        const after = saved ? JSON.parse(saved) as TierLedgerIdentity : undefined;
        const rows = ledger.listPending({ limit: 100, ...(after ? { after } : {}) });
        let settled = 0;
        let retired = 0;
        let lastProcessed: TierLedgerIdentity | undefined;
        let processed = 0;
        for (const row of rows) {
          // Each row can re-judge a stored body: let requests in between.
          await this.ingestionTurn();
          if (signal.aborted || this.stopped || (processed > 0 && this.monotonicNow() >= deadline)) break;
          const identity = recordIdentity(row);
          lastProcessed = identity;
          processed++;
          const missingMetadata = row.metadataPending && !queue.questionFor(identity, 'metadata');
          const missingContent = (row.contentPending || !row.metadataPending) && !queue.questionFor(identity, 'content');
          // Existing questions include durable Secrets cleanup retries. Let the
          // resolver finish them before reconciling any remaining missing pass.
          if (queue.questionFor(identity, 'metadata') || queue.questionFor(identity, 'content')) continue;
          try {
            // Routed copy rows must all be backed by a readable configured store.
            if (row.routed && ledger.copies(identity).some(copy =>
              !set?.domainForCorpus(copy.corpusId) || !set.store(copy.trustDomain)?.exportItemCopy)) continue;
            const copies = stores.map(store => store.exportItemCopy!(identity)).filter(copy => copy !== undefined);
            if (copies.length === 0) {
              // Routing records its plan before the page lands its store rows.
              // Never retire a just-listed item in that transient interval.
              if (this.clockMs() - Date.parse(row.decidedAt) < ROUTED_ROWS_GRACE_MS) continue;
              if (ledger.retireAbsentPending(row)) {
                queue.deleteQuestion(identity, 'metadata');
                queue.deleteQuestion(identity, 'content');
                retired++;
              }
              continue;
            }
            // Unread content whose text extraction still owes has no content
            // question yet, by design: it is waiting to be read, not lost.
            // Names recovery proceeds; the content half stays pending.
            const waitingForText = missingContent && !row.contentRead && row.contentPending
              && this.waitingForExtraction(ledger, row, identity);
            if (waitingForText && !missingMetadata) continue;
            if (!missingMetadata && !missingContent) continue;
            // Preserve the existing content-question repair where the stored
            // body and configured classifier can reconstruct the question.
            const classification = set?.classification();
            const retiredClearance = row.reasons.includes(RETIRED_EMBEDDING_CLEARANCE_REASON);
            if (set && row.contentRead && row.contentPending && !row.metadataPending
              && (row.contentTier === 'private' || row.contentTier === 'public'
                || (retiredClearance && row.contentTier === 'secure'))
              && classification?.sniffer && !classification.unavailableReason) {
              // Cached verdicts and reconstructed questions use the approved
              // pass; only conservative Private settlement precedes approval.
              if (!allowReask) continue;
              rejudgeStoredContent(set, row, { sniffer: classification.sniffer,
                ...(classification.retirePublic ? { retirePublic: true } : {}),
                report: emptyTierRejudgeReport(), autoMoves: this.autoMovesFor(set), hideRaises: true });
              if (ledger.getCurrent(identity)?.state !== 'pending'
                || queue.questionFor(identity, 'metadata') || queue.questionFor(identity, 'content')) continue;
            }
            // Retired clearances must keep their tier until a judge answers.
            // A missing question/material waits for reconstruction or the next sync.
            if (retiredClearance) continue;
            const planner = tierSetPlannerForLedger(ledgerPath);
            if (ledger.settleMissingQuestions(row, {
              missingMetadata, missingContent: missingContent && !waitingForText,
              snifferId: snifferId(this.options.lane, snifferPromptVersions(this.options.ownerContext?.()).cache),
              stillMissing: () => (!missingMetadata || !queue.questionFor(identity, 'metadata'))
                && (!missingContent || !queue.questionFor(identity, 'content')),
              ...(planner ? { placementFor: planner } : {}),
            })) settled++;
          } catch {
            // Read/write failures keep the item held; the cursor wraps and retries.
          }
        }
        // Persist only the rows actually examined, including held/retry rows.
        // A partial short page must resume too; wrap only after reaching its end.
        if (lastProcessed) cursorLedger.writeSettleProgress(cursorKey,
          processed < rows.length || rows.length === 100 ? JSON.stringify(lastProcessed) : '');
        else if (rows.length === 0 && saved) cursorLedger.writeSettleProgress(cursorKey, '');
        if (settled || retired) this.options.log?.(`Olympus tier sniffer: recovered ${settled} pending item(s) as fail-safe Private; retired ${retired} missing item(s); at=${new Date(this.clockMs()).toISOString()}.`);
      } catch {
        // A queue/ledger that cannot be read remains held, retried next tick.
      }
    }
  }

  /**
   * An unread routed item (a file, or a chat's photo, voice note or
   * attachment) that no store holds text for yet, and extraction still owes
   * it. A legacy unrouted row has no extraction lane, and an item extraction
   * no longer owes is genuinely unread: both keep the fail-safe settlement
   * rather than waiting for a job that will never come (Sparta, 2026-11-04:
   * Telegram media were settled while their extraction was still queued,
   * because only the file family was let wait). An item with no job waits only for EXTRACTION_ENQUEUE_GRACE_MS
   * after it was listed: past that, nothing will queue it (a names-only
   * folder, a job deleted when its scope changed) and it settles as before.
   */
  private waitingForExtraction(ledger: TierLedger, row: TierLedgerRecord, identity: TierLedgerIdentity): boolean {
    try {
      if (!this.options.extractionState || !row.routed) return false;
      const copies = ledger.copies(identity);
      if (copies.length === 0) return false;
      if (copies.some(copy => copy.state === 'current' && copy.layers !== 'metadata')) return false;
      const state = this.options.extractionState(identity);
      if (state === 'active') return true;
      return state === 'none' && this.clockMs() - Date.parse(row.decidedAt) < EXTRACTION_ENQUEUE_GRACE_MS;
    } catch {
      return false;
    }
  }

  /**
   * New raises interrupt background work; known failures already retry each
   * judge pass. Walks the sets in the next raise drain's rotated order with
   * its one shared budget, so the timer preempts only for a new raise that
   * drain will actually take (#1013).
   */
  private newRaisesQueued(): boolean {
    const paths = this.ledgerPaths();
    let budget = Math.max(0, this.options.autoMoves!.maxPerPass ?? 25);
    const offset = this.moveLedgerOffsets.raise % Math.max(1, paths.length);
    for (const path of [...paths.slice(offset), ...paths.slice(0, offset)]) {
      if (budget === 0) return false;
      try {
        const set = tierSetForLedger(path);
        if (!set || !setEmbedsWithBuiltInOnly(set)) continue;
        for (const record of set.ledger.listMoving({ limit: budget, direction: 'raise' }).filter(isAutoMoveCandidate)) {
          budget--;
          if (!this.moveFailures.has(`${path}\u0000${tierLedgerIdentityKey(recordIdentity(record))}\u0000${record.generation}`)) return true;
        }
      }
      catch { return true; } // An unreadable queue fails safe.
    }
    return false;
  }

  private async drainMoves(direction: 'raise' | 'lower' = 'raise'): Promise<TierAutoMoveReport | undefined> {
    try {
      if (!this.options.autoMoves || this.stopped || !this.options.autoMoves.localEmbeddingsOnly()) return undefined;
      if (this.moving && this.movingDirection !== direction) {
        if (direction === 'raise') {
          // The idle timer also asks for raises. Only real queued raises may
          // interrupt a longer lowering slice; an unreadable queue fails safe.
          if (!this.newRaisesQueued()) return undefined;
          this.lowerMovePreempted = true;
        }
        await this.moving;
      }
      if (!this.moving) {
        if (this.stopped) return undefined;
        this.movingDirection = direction;
        if (direction === 'lower') this.lowerMovePreempted = false;
        const changedPaths = new Set<string>();
        const options = this.options.autoMoves;
        this.moving = this.runAutoMoves(options, this.moveAbort.signal, direction, changedPaths)
          .finally(() => {
            this.moving = undefined;
            this.movingDirection = undefined;
            if (!this.stopped && changedPaths.size > 0) options.onPlacementChecked?.(changedPaths);
          });
      }
      return await this.moving;
    } catch (error) {
      this.options.log?.(`Olympus tier sniffer: move drain failed (${error instanceof Error ? error.name : 'unknown'}); queued moves will retry; at=${new Date(this.clockMs()).toISOString()}.`);
      return undefined;
    }
  }

  private ownerAnswering(): boolean {
    try {
      return this.options.ownerInFlight?.() ?? false;
    } catch {
      return false;
    }
  }

  private answering(): boolean {
    try {
      return this.options.answersInFlight?.() ?? false;
    } catch {
      return false;
    }
  }

  /** The inputs shared by the stored walks, before their first read of a page. */
  private storedWalkInputs(set: TieredStoreSet, ledgerOnly = false): string | undefined {
    try {
      const ledger = set.ledger.changeMarker({ ignoreSettleProgress: true });
      if (ledgerOnly) return ledger;
      const classification = set.classification();
      if (classification?.unavailableReason) return undefined;
      const folderRevision = set.namesOnlyOwnerRevision();
      if (folderRevision === undefined) return undefined;
      return JSON.stringify([
        ledger,
        this.options.installed.snifferStoreForLedger(set.ledger.dbPath).changeMarker({ ignoreScanProgress: true }),
        classification?.rules, classification?.retirePublic, classification?.sniffer?.id, classification?.sniffer?.rejudgeReady,
        folderRevision,
        set.openStores().map(store => [store.corpusId, store.exclusions.criteria, store.changeMarker()]),
      ]);
    } catch {
      // The walks still run, and report that their inputs could not be verified.
      return undefined;
    }
  }

  private async runStoredWalker(
    set: TieredStoreSet,
    name: StoredWalker,
    inputs: string | undefined,
    readPage: (after: TierLedgerIdentity | undefined) => Promise<StoredWalkPage>,
  ): Promise<void> {
    const path = set.ledger.dbPath;
    let entry = this.storedWalks.get(path);
    if (entry?.set !== set) {
      entry = { set, walks: new Map() };
      this.storedWalks.set(path, entry);
    }
    let walk = entry.walks.get(name);
    if (!walk) {
      walk = newStoredWalk(this.clockMs());
      entry.walks.set(name, walk);
    }
    await runStoredWalk(walk, inputs, readPage, () => this.clockMs());
  }

  /** Settles stored items even while model availability or approval is pending. */
  private async settleStoredItems(): Promise<void> {
    await this.applyOwnerOverrides();
    const paths = new Set(this.ledgerPaths());
    for (const path of this.storedWalks.keys()) if (!paths.has(path)) this.storedWalks.delete(path);
    for (const ledgerPath of paths) {
      await this.ingestionTurn();
      const set = tierSetForLedger(ledgerPath);
      if (!set) continue;
      const turn = () => { this.progress(); return this.ingestionTurn(); };
      void set.repairLowerContent({ ...(this.options.autoMoves ? {
        embeddingLedger: { path: this.options.autoMoves.embeddingLedgerPath, approvedBy: 'system-automatic' as const, why: AUTO_MOVE_WHY },
      } : {}) });
      const inputs = this.storedWalkInputs(set);
      await this.runStoredWalker(set, 'ownerRules', inputs, async () => {
        const report = await sweepOwnerRuleRaisesOffThread({ set, turn });
        const changed = report.raised > 0 || report.secrets > 0;
        if (changed) {
          this.options.log?.(
            `Olympus tier rules: ${report.raised} stored item(s) raised by a new owner rule (hidden first)`
            + `${report.secrets ? `, ${report.secrets} made Secrets` : ''}.`,
          );
        }
        return { changed, complete: report.complete };
      });
      await this.runStoredWalker(set, 'imageContent', inputs, async () => {
        const images = await sweepImageContentToPrivateOffThread({ set, turn });
        if (images.raised > 0 || images.stripped > 0) {
          this.options.log?.(
            `Olympus photos: ${images.raised} stored photo(s) moved to Private (hidden first), ${images.stripped} photo text(s) removed from a non-Private store.`,
          );
        }
        return { retired: images.complete, complete: images.complete };
      });
      const autoMoves = this.autoMovesFor(set);
      await this.runStoredWalker(set, 'mediaJudgments', inputs && JSON.stringify([inputs, autoMoves]), async () => {
        let cursor = this.mediaJudgmentCursors.get(set);
        if (!cursor) this.mediaJudgmentCursors.set(set, cursor = new Map());
        const judged = await applyMediaJudgmentsOffThread({ set, autoMoves, turn, cursor });
        if (judged.complete) this.mediaJudgmentCursors.delete(set);
        if (judged.movesQueued > 0) this.forgetLowerMoves();
        if (judged.movesQueued > 0 || judged.updated > 0 || judged.asked > 0) {
          this.options.log?.(
            `Olympus photos: ${judged.applied} photo judgment(s) applied (${judged.movesQueued} move(s) out of Private queued, `
            + `${judged.updated} kept where they were, ${judged.asked} asked about).`,
          );
        }
        return { changed: judged.applied > 0, complete: judged.complete, failed: judged.failed > 0 };
      });
      await this.runStoredWalker(set, 'namesOnly', inputs, async (after) => {
        const settled = await settleNamesOnlyItemsOffThread({ set, turn, cursor: after ? { after } : {} });
        if (settled.settled > 0) {
          this.options.log?.(`Olympus tier names-only: ${settled.settled} stored item(s) settled on their names.`);
        }
        return { changed: settled.settled > 0, failed: settled.failed > 0, complete: !settled.next,
          ...(settled.next ? { next: settled.next } : {}) };
      });
      await this.runStoredWalker(set, 'personalFirst', undefined, async () => {
        const held = await settlePersonalFirstItemsOffThread({ set, turn });
        if (held.settled > 0) {
          this.options.log?.(`Olympus tier hold: ${held.settled} item(s) recorded before every open question held text are held now (${held.movesQueued} move(s) to Private queued).`);
        }
        return { retired: held.retired, complete: held.retired, changed: held.settled > 0, failed: held.failed > 0 };
      });
      await this.runStoredWalker(set, 'staleEmbedHolds', this.storedWalkInputs(set, true),
        () => staleEmbedHoldLap(set.ledger, turn, this.options.log));
    }
  }

  /** Apply stored overrides and retry Secret side stores on each tick. */
  private async applyOwnerOverrides(): Promise<void> {
    for (const ledgerPath of this.ledgerPaths()) {
      await this.ingestionTurn();
      const set = tierSetForLedger(ledgerPath);
      const turn = () => { this.progress(); return this.ingestionTurn(); };
      try {
        const ledger = set?.ledger ?? this.ledgerAt(ledgerPath);
        await retrySecretSideStoreDebtsOffThread(ledger, { turn });
        if (set) await this.runStoredWalker(set, 'ownerOverrides', this.storedWalkInputs(set), async () => {
          const report = await applyOwnerOverridesOffThread({ set, turn, retrySecrets: false, forceClearedCheck: true });
          const changed = report.raised + report.lowered + report.secrets + report.updated;
          if (changed > 0) {
            this.options.log?.(
              `Olympus tier overrides: ${changed} stored item(s) set by the owner applied `
              + `(${report.raised} raised, hidden first; ${report.lowered} move(s) down queued`
              + `${report.secrets ? `; ${report.secrets} made Secrets` : ''}).`,
            );
          }
          return { changed: changed + report.restored > 0, failed: report.failed > 0 };
        });
        retireSecretRedactions(ledger);
      } catch {
        // Secret side store debt and redactions retry on the next tick.
      }
    }
  }

  /** Re-judges a page of each set's routed items decided under older inputs. */
  private async rejudge(id: string): Promise<TierRejudgeReport> {
    const total = emptyTierRejudgeReport();
    const perPass = this.options.rejudgePerPass ?? DEFAULT_TIER_REJUDGE_PER_PASS;
    if (perPass <= 0) return total;
    const maxOpen = Math.max(0, this.options.rejudgeMaxOpenQuestions ?? 2 * perPass);
    for (const ledgerPath of this.ledgerPaths()) {
      await this.ingestionTurn();
      const set = tierSetForLedger(ledgerPath);
      if (!set) continue;
      const inputs = this.storedWalkInputs(set);
      const autoMoves = this.autoMovesFor(set);
      await this.runStoredWalker(set, 'rejudge', inputs && JSON.stringify([inputs, id, autoMoves]), async (after) => {
        // Questions already waiting: re-judging more than the sniffer can answer only grows the queue.
        if (this.options.installed.snifferStoreForLedger(ledgerPath).questionWorkCounts(id).unanswered >= maxOpen) {
          return { complete: false, blocked: 'queue_full', ...(after ? { next: after } : {}) };
        }
        const { report, next, complete } = await rejudgeRoutedItemsInTurns({
          set, turn: () => { this.progress(); return this.ingestionTurn(); },
          limit: perPass, ...(after ? { after } : {}), autoMoves,
        });
        for (const key of Object.keys(total) as Array<keyof TierRejudgeReport>) total[key] += report[key];
        if (report.movesQueued > 0) this.forgetLowerMoves();
        return {
          complete, ...(next ? { next } : {}), failed: report.failed > 0,
          changed: report.updated + report.movesQueued + report.asked + report.secrets + report.rechecked > 0,
        };
      });
    }
    const logSkipped = total.builtinPromptSkipped > 0 && this.clockMs() - this.lastBuiltinPromptSkipLogMs >= 60_000;
    if (total.updated > 0 || total.movesQueued > 0 || total.asked > 0 || total.secrets > 0 || total.heldLowering > 0 || total.rechecked > 0 || logSkipped) {
      if (total.builtinPromptSkipped > 0) this.lastBuiltinPromptSkipLogMs = this.clockMs();
      this.options.log?.(
        `Olympus tier sniffer: re-judged ${total.updated + total.movesQueued + total.asked + total.secrets} item(s) under the current classifier `
        + `(${total.asked} asked about, still where they were; ${total.movesQueued} tier move(s) queued`
        + `; ${total.heldLowering} lowering(s) held${total.secrets ? `; ${total.secrets} Secret(s) found and hidden` : ''})`
        + `; picked for: held=${total.causeHeld} retired_prior=${total.causeRetiredPrior} missing_question=${total.causeMissingQuestion}`
        + ` classifier=${total.causeClassifier} owner_words=${total.causeOwnerWords} judge_model=${total.causeJudgeModel}`
        + ` names_prompt=${total.causeNamesPrompt} content_prompt=${total.causeContentPrompt}`
        + `; builtin_prompt_skipped=${total.builtinPromptSkipped}; owner_recheck=${total.rechecked}.`,
      );
    }
    return total;
  }

  /** Whether this set's queued moves run automatically (see `autoMoves`). */
  private autoMovesFor(set: TieredStoreSet): boolean {
    const options = this.options.autoMoves;
    return automaticTierMovesAllowed(set, options);
  }

  /** Raises run first; lowerings use store batches outside the judge pass. */
  private async runAutoMoves(
    options: NonNullable<TierSnifferServiceOptions['autoMoves']>,
    signal: AbortSignal,
    direction: 'raise' | 'lower',
    changedPaths: Set<string>,
  ): Promise<TierAutoMoveReport> {
    const timings = emptyTierMoveTimings();
    const started = this.monotonicNow();
    const paths = this.ledgerPaths();
    const backlog = direction === 'lower'
      ? paths.reduce((n, path) => {
        try { return n + (tierSetForLedger(path)?.ledger.countMoving('lower') ?? 0); }
        catch { return n; } // A failed count must not prevent other sets draining.
      }, 0) : 0;
    // Keep the full judge budget. With a backlog, grow beyond the 1 s floor
    // at 25 ms per queued item, up to 10 s / one third of judge time. Thus
    // moves take at most 25% of the combined judge + moves allocation.
    // A disabled/invalid judge budget must not disable move recovery or its cap.
    const configuredJudgeMs = this.options.passTimeMs ?? DEFAULT_SNIFFER_PASS_TIME_MS;
    const judgeBudgetMs = Number.isFinite(configuredJudgeMs) && configuredJudgeMs > 0
      ? configuredJudgeMs : DEFAULT_SNIFFER_PASS_TIME_MS;
    const capMs = Math.min(MAX_LOWER_MOVE_SLICE_MS, judgeBudgetMs / 3);
    const adaptiveMs = Math.max(DEFAULT_LOWER_MOVE_SLICE_MS, backlog * DEFAULT_LOWER_MOVE_BATCH_MS);
    const requestedMs = options.lowerSliceMs ?? adaptiveMs;
    const sliceMs = Math.min(capMs, Math.max(0, Number.isFinite(requestedMs) ? requestedMs : adaptiveMs));
    const deadline = started + sliceMs;
    const shouldStop = () => signal.aborted || (direction === 'lower'
      && (this.monotonicNow() >= deadline || this.lowerMovePreempted || this.yieldNow()));
    const report: TierAutoMoveReport = { moved: 0, failed: 0, notEligible: 0, timings };
    const embeddingCorpora = new Set<string>();
    const staleAfterMs = Math.max(0, options.staleAfterMs ?? DEFAULT_STALE_MOVE_MS);
    const now = (this.options.now ?? (() => new Date()))().getTime();
    let budget = Math.max(0, options.maxPerPass ?? (direction === 'raise' ? 25 : DEFAULT_AUTO_MOVES_PER_PASS));
    // Rotate the first set so a persistent large backlog cannot starve another.
    const offset = this.moveLedgerOffsets[direction]++ % Math.max(1, paths.length);
    for (const ledgerPath of [...paths.slice(offset), ...paths.slice(0, offset)]) {
      if (budget === 0 || shouldStop()) break;
      const set = tierSetForLedger(ledgerPath);
      if (!set) continue;
      // A batch takes a write transaction on every open store; one being
      // reclaimed would block this thread on its busy timeout. Moves stay
      // queued for the next pass.
      if (set.openStores().some(store => store.reclaiming)) continue;
      // Found on the ledger's read worker; each move re-checks its generation as it lands.
      const queued = (await ledgerReadOffThread(set.ledger, set.ledger.listMovingSteps({ limit: budget, direction })))
        .filter(isAutoMoveCandidate);
      if (set.openStores().some(store => store.reclaiming)) continue;
      if (!setEmbedsWithBuiltInOnly(set)) { report.notEligible += queued.length; continue; }
      const failure = (record: TierLedgerRecord, error: unknown) => {
        const identity = recordIdentity(record);
        const failureKey = `${ledgerPath}\u0000${tierLedgerIdentityKey(identity)}\u0000${record.generation}`;
        // The move stays queued (held, never shown twice); the next pass or
        // the owner-approved migration picks it up.
        report.failed += 1;
        const why = moveFailureName(error);
        report.failedBy = { ...report.failedBy, [why]: (report.failedBy?.[why] ?? 0) + 1 };
        // Keyed by item, not generation: a refusal that re-judges and queues
        // the same move again (the content check) is one item refused twice.
        const refusedKey = `${ledgerPath}\u0000${tierLedgerIdentityKey(identity)}`;
        if (error instanceof TierMoveRefusedError) {
          changedPaths.add(ledgerPath);
          this.moveRefusalAttempts += 1;
          this.movesRefusedNow.set(refusedKey, why);
        } else this.movesRefusedNow.delete(refusedKey);
        if (error instanceof TierMoveContentChangedError) {
          // A stale lowering was refused before import and taken out of
          // moving. Re-read the actual stored body, even when this model
          // already judged the discarded edit. Its old verdict cannot
          // authorize the stored copy; a cache miss opens a new question.
          if (set.ledger.getCurrent(identity)?.state === 'moving') {
            try { set.ledger.abandonMove(identity, { expectedGeneration: record.generation }); } catch { /* raises never abandon */ }
          }
          const current = set.ledger.getCurrent(identity);
          if (current && current.state !== 'moving') {
            try {
              const classification = set.classification();
              if (!classification?.unavailableReason) {
                rejudgeStoredContent(set, current, {
                  ...classification, report: emptyTierRejudgeReport(), autoMoves: true,
                });
              }
            } catch { /* A later sync can re-fetch; nothing was released. */ }
          }
          this.moveFailures.delete(failureKey);
          return;
        }
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
      };
      const succeeded = (record: TierLedgerRecord, result: TierMoveResult) => {
        changedPaths.add(ledgerPath);
        report.moved++;
        for (const destination of result.destinations) {
          if (destination.chunksToEmbed > 0) embeddingCorpora.add(destination.corpusId);
        }
        const key = `${ledgerPath}\u0000${tierLedgerIdentityKey(recordIdentity(record))}\u0000${record.generation}`;
        this.moveFailures.delete(key);
        this.movesRefusedNow.delete(`${ledgerPath}\u0000${tierLedgerIdentityKey(recordIdentity(record))}`);
      };
      const batchSize = Math.max(1, Math.min(100, options.lowerBatchSize ?? 25));
      for (let offset = 0; offset < queued.length && budget > 0 && !shouldStop();) {
        const pending: Array<{ record: TierLedgerRecord; move: TierMoveOptions }> = [];
        const batchDeadline = Math.min(deadline, this.monotonicNow() + Math.max(0, options.lowerBatchMs ?? DEFAULT_LOWER_MOVE_BATCH_MS));
        for (let n = 0; n < (direction === 'raise' ? 1 : batchSize) && offset < queued.length && !shouldStop(); n++) {
          const record = queued[offset++]!;
          budget--;
          const identity = recordIdentity(record);
          pending.push({ record, move: {
            set, identity,
            target: { metadataTier: record.targetMetadataTier!, contentTier: record.targetContentTier! },
            ...automaticTierMoveOptions(set, options), timings, expectedGeneration: record.generation,
          } });
        }
        if (direction === 'raise') {
          for (const { record, move } of pending) {
            try { succeeded(record, await moveTieredItem(move)); }
            catch (error) { failure(record, error); }
          }
        } else if (pending.length) {
          try {
            let copied = 0;
            const results = moveTieredItemsLowering(pending.map(entry => entry.move), {
              // One item is indivisible; do not start another after its bound.
              shouldStop: () => shouldStop() || (copied++ > 0 && this.monotonicNow() >= batchDeadline),
            });
            for (const [index, result] of results.entries()) {
              const entry = pending[index]!;
              if (!('error' in result)) { succeeded(entry.record, result.result); continue; }
              failure(entry.record, result.error);
            }
            // Unstarted candidates still belong to the queue; use the rest of
            // this slice rather than accidentally capping it at one small page.
            offset -= pending.length - results.length;
            budget += pending.length - results.length;
          } catch (error) { for (const { record } of pending) failure(record, error); }
        }
        await flushTierMoveNotes(set.ledger, { timings, shouldStop });
        await this.ingestionTurn();
      }
      // Retry note obligations even when a previous process already flipped
      // every move, leaving no queued row to trigger a write.
      await flushTierMoveNotes(set.ledger, { timings, shouldStop });
    }
    if (embeddingCorpora.size > 0) options.onEmbeddingNeeded?.(embeddingCorpora);
    report.elapsedMs = this.monotonicNow() - started;
    const didWork = report.moved > 0 || report.failed > 0 || (report.abandoned ?? 0) > 0
      || (report.staleRaises ?? 0) > 0 || (report.retiredAbsent ?? 0) > 0;
    // An idle lowering drain runs about every second: log it once a minute, not every time.
    const idleLowerDue = direction === 'lower' && this.clockMs() - this.lastIdleLowerLogMs >= 60_000;
    if (didWork || idleLowerDue) {
      if (!didWork) this.lastIdleLowerLogMs = this.clockMs();
      this.options.log?.(
        `Olympus tier sniffer: ${report.moved} automatic tier move(s), ${report.failed} failed`
        + `${report.failedBy ? ` (${Object.entries(report.failedBy).map(([why, n]) => `${why} ×${n}`).join(', ')})` : ''}`
        + `${report.abandoned ? `, ${report.abandoned} stale move(s) given up (back where they were)` : ''}`
        + `${report.staleRaises ? `, ${report.staleRaises} stale raise(s) kept hidden and queued` : ''}`
        + `${report.retiredAbsent ? `, ${report.retiredAbsent} stale raise(s) of items no store holds forgotten` : ''}; direction=${direction} elapsed_ms=${Math.round(report.elapsedMs!)} `
        + (direction === 'lower' ? `backlog=${backlog} slice_ms=${Math.round(sliceMs)} ` : '')
        + Object.entries(timings).map(([step, ms]) => `${step.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}=${Math.round(ms)}`).join(' ') + '.',
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
      if (error instanceof TierLedgerRaiseAbandonRefusedError) {
        // A raise whose item every store has dropped can never complete, and
        // there is nothing hidden to protect: forget it (#913).
        // A store that can't be opened or read makes the answer unknown: the
        // raise stays queued and the rest of the pass goes on.
        try {
          if (itemAbsentFromEveryStore(set, recordIdentity(record))
            && set.ledger.retireAbsentMove(recordIdentity(record), { expectedGeneration: record.generation })) {
            report.retiredAbsent = (report.retiredAbsent ?? 0) + 1;
            return true;
          }
        } catch {
          // Left queued; the next pass looks again.
        }
        report.staleRaises = (report.staleRaises ?? 0) + 1;
      }
      // Otherwise left queued; the next pass looks again.
      return false;
    }
  }
}

function mergeAutoMoveReports(raised: TierAutoMoveReport | undefined, lower: TierAutoMoveReport): TierAutoMoveReport {
  if (!raised) return lower;
  const merged: TierAutoMoveReport = { ...lower };
  for (const key of ['moved', 'failed', 'notEligible', 'abandoned', 'staleRaises', 'retiredAbsent'] as const) {
    const total = (raised[key] ?? 0) + (lower[key] ?? 0);
    if (total || key === 'moved' || key === 'failed' || key === 'notEligible') merged[key] = total;
  }
  const timings = emptyTierMoveTimings();
  for (const key of Object.keys(timings) as Array<keyof typeof timings>) {
    timings[key] = (raised.timings?.[key] ?? 0) + (lower.timings?.[key] ?? 0);
  }
  merged.timings = timings;
  merged.elapsedMs = (raised.elapsedMs ?? 0) + (lower.elapsedMs ?? 0);
  if (raised.failedBy || lower.failedBy) {
    merged.failedBy = { ...raised.failedBy };
    for (const [key, n] of Object.entries(lower.failedBy ?? {})) merged.failedBy[key] = (merged.failedBy[key] ?? 0) + n;
  }
  return merged;
}

/**
 * True only when every store this item could live in is known and none holds
 * an active (untombstoned) copy. A configured leg whose store file does not
 * exist holds nothing; a copy row naming a leg this set does not configure,
 * or a store that cannot export, leaves the answer unknown (false).
 */
function itemAbsentFromEveryStore(set: TieredStoreSet, identity: TierLedgerIdentity): boolean {
  for (const copy of set.ledger.copies(identity)) {
    if (!set.legSpec(copy.trustDomain)) return false;
  }
  const stores = set.openStores();
  return stores.every((store) => typeof store.exportItemCopy === 'function' && store.exportItemCopy(identity) === undefined);
}

function recordIdentity(record: TierLedgerRecord): TierLedgerIdentity {
  return {
    provider: record.provider,
    accountScope: record.accountScope,
    providerItemId: record.providerItemId,
    ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}),
  };
}

function isBuiltInLane(lane: SnifferLane): boolean {
  return lane.kind === BUILT_IN_SNIFFER_LANE.kind
    && lane.profileId === BUILT_IN_SNIFFER_LANE.profileId
    && lane.modelId === BUILT_IN_SNIFFER_LANE.modelId;
}

/** Same candidate predicate for raise preemption and the actual drain. */
function isAutoMoveCandidate(record: TierLedgerRecord): boolean {
  return record.routed && record.targetMetadataTier !== null && record.targetContentTier !== null
    && record.targetMetadataTier !== 'secrets' && record.targetContentTier !== 'secrets';
}

/** Env knobs, all optional. Invalid values fall back to the defaults. */
export function tierSnifferServiceEnv(env: Record<string, string | undefined>): {
  enabled: boolean;
  intervalMs: number;
  /** Optional legacy override; absent means time-bounded passes. */
  maxCallsPerPass?: number;
  /** Calls in flight at once (default 1; a pass holds a local lane to SNIFFER_MAX_CONCURRENT_CALLS). */
  concurrentCalls?: number;
  maxCallsPerDay?: number;
} {
  const enabledRaw = env.OLYMPUS_TIER_SNIFFER_ENABLED?.trim().toLowerCase();
  return {
    enabled: !(enabledRaw === '0' || enabledRaw === 'false' || enabledRaw === 'no' || enabledRaw === 'off'),
    intervalMs: positiveInteger(env.OLYMPUS_TIER_SNIFFER_INTERVAL_MS, DEFAULT_TIER_SNIFFER_INTERVAL_MS, 100),
    ...(env.OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_PASS?.trim()
      ? { maxCallsPerPass: positiveInteger(env.OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_PASS, 1, 1) }
      : {}),
    ...(env.OLYMPUS_TIER_SNIFFER_CONCURRENT_CALLS?.trim()
      ? { concurrentCalls: Math.min(SNIFFER_MAX_CONCURRENT_CLOUD_CALLS, positiveInteger(env.OLYMPUS_TIER_SNIFFER_CONCURRENT_CALLS, 1, 1)) }
      : {}),
    ...(env.OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_DAY?.trim()
      ? { maxCallsPerDay: positiveInteger(env.OLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_DAY, DEFAULT_SNIFFER_MAX_CALLS_PER_DAY, 0) } : {}),
  };
}

function positiveInteger(value: string | undefined, fallback: number, minimum: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/**
 * A failed move's reason for the log: the error's class, or a short fixed
 * message it was thrown with ("no current copy"). Nothing longer, so no item
 * name or content can reach the log through it.
 */
export function moveFailureName(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  if (error instanceof TierMoveRefusedError && error.code !== 'refused') return `${error.name}:${error.code}`;
  if (error.constructor !== Error) return error.name || error.constructor.name || 'Error';
  return /^[a-z][a-z ]{0,39}$/.test(error.message) ? error.message : 'Error';
}

/**
 * The retired ledger keeps only its main file aside, so what its -wal holds
 * is written into it first. Returns whether the main file now holds
 * everything: no -wal, or a checkpoint that was not busy and wrote every
 * frame. A file that will not open, or a busy checkpoint, is false.
 */
function checkpointRetiredLedger(path: string): boolean {
  if (!existsSync(`${path}-wal`)) return true;
  if (!existsSync(path)) return false;
  let db: Database | undefined;
  try {
    db = new Database(path);
    db.exec('PRAGMA busy_timeout = 10000;');
    const result = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number } | null;
    return result !== null && result.busy === 0 && result.log === result.checkpointed;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** addPendingSlice's whole-ledger count. */
function pendingCountSql(hasQueue: boolean): string {
  const queued = hasQueue ? `EXISTS (SELECT 1 FROM queue.sniffer_questions q
      WHERE q.provider = t.provider AND q.account_scope = t.account_scope
      AND q.conversation_key = t.conversation_key AND q.provider_item_id = t.provider_item_id)` : '0';
  return `SELECT COUNT(*) AS n, SUM(CASE WHEN ${queued} THEN 0 ELSE 1 END) AS missing, MIN(decided_at) AS oldest
          FROM tier_items t WHERE state = 'pending'`;
}

/** addQuestionSlice's whole-queue count. */
function questionCountSql(): string {
  return `SELECT COUNT(*) AS n, SUM(CASE
        WHEN EXISTS (SELECT 1 FROM queue.sniffer_questions e
          WHERE e.provider = q.provider AND e.account_scope = q.account_scope
          AND e.conversation_key = q.conversation_key AND e.provider_item_id = q.provider_item_id
          AND e.question_pk < q.question_pk) THEN 0
        WHEN EXISTS (SELECT 1 FROM tier_items t WHERE t.state = 'pending'
          AND t.provider = q.provider AND t.account_scope = q.account_scope
          AND t.conversation_key = q.conversation_key AND t.provider_item_id = q.provider_item_id) THEN 0
        ELSE 1 END) AS other
      FROM queue.sniffer_questions q`;
}

// Runs in a Worker of its own: read-only, the bound ledger only, its queue attached.
const BACKLOG_COUNT_WORKER_SOURCE = `
import { Database } from 'bun:sqlite';
self.onmessage = ({ data }) => {
  const out = [];
  for (const ledger of data.ledgers) {
    let db;
    try {
      db = new Database(ledger.path, { readonly: true, create: false });
      db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON;');
      if (ledger.expectedId !== null) {
        const row = db.query("SELECT value FROM tier_ledger_meta WHERE key = 'ledger_id'").get();
        if (!row || row.value !== ledger.expectedId) { out.push({ unreadable: ledger.path, mismatch: true }); continue; }
      }
      if (ledger.queue) db.query('ATTACH DATABASE ? AS queue').run(ledger.queue);
      const pending = db.query(ledger.queue ? data.sql.pendingQueued : data.sql.pendingAlone).get();
      const questions = ledger.queue ? db.query(data.sql.questions).get() : { n: 0, other: 0 };
      out.push({ n: pending.n, missing: pending.missing, oldest: pending.oldest, questions: questions.n, other: questions.other });
    } catch {
      out.push({ unreadable: ledger.path });
    } finally { try { db?.close(); } catch {} }
  }
  postMessage(out);
};`;

const BACKLOG_COUNT_WORKER_TIMEOUT_MS = 10 * 60_000;

type BacklogWorkerResult = { n: number; missing: number | null; oldest: string | null; questions: number; other: number | null }
  | { unreadable: string; mismatch?: boolean };

function runBacklogCountWorker(message: unknown): Promise<BacklogWorkerResult[] | undefined> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(URL.createObjectURL(new Blob([BACKLOG_COUNT_WORKER_SOURCE], { type: 'text/javascript' })));
    } catch {
      resolve(undefined);
      return;
    }
    const done = (value: BacklogWorkerResult[] | undefined) => {
      clearTimeout(timer);
      try { worker.terminate(); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), BACKLOG_COUNT_WORKER_TIMEOUT_MS);
    worker.onmessage = ({ data }) => done(data as BacklogWorkerResult[]);
    worker.onerror = () => done(undefined);
    worker.postMessage(message);
  });
}

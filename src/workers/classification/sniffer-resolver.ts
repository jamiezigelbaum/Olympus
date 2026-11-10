import type { ClearingCounts, EmbeddingPrefilter } from './embedding-prefilter.ts';
import type { SnifferModel, SnifferModelRequest, SnifferModelCompletion } from './sniffer-decision.ts';
// The sniffer's background pass (design section 2.2): resolve pending items.
//
// A bounded pass over each store's open sniffer questions, each checked
// against the item's tier-ledger row (it must still be pending on that
// question). It answers a question from
// the verdict cache when another item already asked the same thing, and
// otherwise asks the privacy-safe model one item per call. Verdicts are cached and applied to the
// ledger; the question's material is then deleted.
//
// Bounds and fail-safe behaviour:
// - Every dispatch re-checks the lane (assertSnifferProfileAllowed): a
//   standard-cloud profile is refused before anything is sent.
// - Material carrying a secret finding settles through Secrets, never sent.
// - Time-bounded passes and `SnifferCallBudget` calls per UTC day; an optional
//   explicit call cap remains supported. Stop when `shouldYield()` says work needs
//   the private pool, or after two consecutive transport failures. A cloud
//   judge's 429 is not one: judge-pacing.ts waits for the reset and retries.
// - A transport failure leaves the item pending (held Private). An item the
//   model keeps failing to answer (no or malformed verdict) resolves to
//   Private after SNIFFER_MAX_ATTEMPTS attempts, and that fail-safe verdict is
//   cached under the same key so it is not re-asked on every sync.
// - The pass only updates ledger decisions. It never moves, embeds or deletes
//   stored content.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AnalystModel, AnalystModelCompletion, AnalystModelRequest } from '../../core/analyst.ts';
import { runWithLocalInferenceGuard } from '../answer-activity.ts';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import {
  JudgeCloudStopped,
  SNIFFER_INJECTION_CATEGORY,
  SNIFFER_MAX_ATTEMPTS,
  SNIFFER_PROMPT_VERSION,
  SNIFFER_RESPONSE_SCHEMA,
  SNIFFER_SYSTEM_PROMPT,
  buildSnifferBatchPrompt,
  parseSnifferBatchResponse,
  snifferId,
  snifferCacheModelId,
  snifferMaterialCarriesSecret,
  snifferMaterialLooksLikeInjection,
  snifferMaterialForModel,
  snifferOwnMaterial,
  cachedSnifferVerdictHolds,
  snifferVerdictTier,
} from './sniffer.ts';
import { assertSnifferProfileAllowed, type SnifferLane } from './sniffer-lane.ts';
import { contentVerdictReusable, snifferSubjectKey } from './sniffer-store.ts';
import type {
  SnifferPass,
  SnifferQuestion,
  SnifferVerdictKey,
  StoredSnifferVerdict,
  TierSnifferStore,
} from './sniffer-store.ts';
import { TIER_CLASSIFIER_VERSION, type TierDecision } from './tier-classifier.ts';
import { tierLedgerIdentityKey, type TierLedger, type TierLedgerRecord, type TierPlacementPlan } from './tier-ledger.ts';

/** The UTC daily cap survives restart. Time slices, not call counts, set the pace. */
export const DEFAULT_SNIFFER_MAX_CALLS_PER_DAY = 20_000;
/** One decision item attempt per call: enough for a sustained 150/min lane. */
export const DEFAULT_DECISION_SNIFFER_MAX_CALLS_PER_DAY = 250_000;
/**
 * How long one pass keeps asking. A local model answers in about 5 s, so a
 * 5 s pass asked once and then paid the whole pass setup (listing, re-judge,
 * moves) again for the next question (Sparta, 2026-11-03: 99 of 100 passes
 * stopped after one call). Preemption still stops a pass at once.
 */
export const DEFAULT_SNIFFER_PASS_TIME_MS = 30_000;
/** The most sniffer calls a pass keeps in flight at once on a local model. */
export const SNIFFER_MAX_CONCURRENT_CALLS = 8;
/** A cloud judge is network-bound and paced to its provider's request limit instead (#884). */
export const SNIFFER_MAX_CONCURRENT_CLOUD_CALLS = 32;
const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 2;
/** Output budget per item: one short JSON verdict. */
const OUTPUT_CHARS_PER_ITEM = 110;

export interface SnifferTarget {
  ledger: TierLedger;
  sniffer: TierSnifferStore;
  embeddingPrefilter?: EmbeddingPrefilter;
  /**
   * The tiered store set's placement planner, for a set ledger. A routed item
   * (P1b) is settled through it, so a verdict that needs other stores queues
   * a move instead of rewriting placement; without it routed items wait.
   */
  placementFor?: (decision: TierDecision) => TierPlacementPlan;
  /** Store-backed targets screen the full current legacy copy, never just the excerpt. */
  screenStoredQuestion?: (question: SnifferQuestion) => 'clean' | 'secrets' | 'unreadable';
  /** Uses the set's existing Secrets disposition; false keeps the question for retry. */
  settleSecrets?: (question: SnifferQuestion, decision: TierDecision) => boolean;
}

/**
 * A per-UTC-day call cap shared by every pass in the process. With a
 * `statePath` the day's count survives a restart (an owner-only JSON file),
 * so restarting the worker never grants a fresh allowance.
 */
export class SnifferCallBudget {
  readonly maxCallsPerDay: number;
  private readonly now: () => Date;
  private readonly statePath: string | undefined;
  private day = '';
  private used = 0;
  private readonly explicitLimit: boolean;

  constructor(options: { maxCallsPerDay?: number; now?: () => Date; statePath?: string } = {}) {
    this.explicitLimit = options.maxCallsPerDay !== undefined;
    this.maxCallsPerDay = Math.max(0, Math.floor(options.maxCallsPerDay ?? DEFAULT_SNIFFER_MAX_CALLS_PER_DAY));
    this.now = options.now ?? (() => new Date());
    this.statePath = options.statePath;
    if (this.statePath) {
      try {
        const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as { day?: unknown; used?: unknown };
        if (typeof saved.day === 'string' && typeof saved.used === 'number' && Number.isFinite(saved.used)) {
          this.day = saved.day;
          this.used = Math.max(0, Math.floor(saved.used));
        }
      } catch {
        // No saved count yet (or unreadable): start the day at zero.
      }
    }
  }

  tryConsume(decisionMode = false): boolean {
    this.roll();
    const limit = decisionMode && !this.explicitLimit ? DEFAULT_DECISION_SNIFFER_MAX_CALLS_PER_DAY : this.maxCallsPerDay;
    if (this.used >= limit) return false;
    this.used += 1;
    this.save();
    return true;
  }

  private save(): void {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
      writePrivateFileAtomicSync(this.statePath, `${JSON.stringify({ day: this.day, used: this.used })}\n`);
    } catch {
      // A count that cannot be saved still bounds this process.
    }
  }

  usedToday(): number {
    this.roll();
    return this.used;
  }

  private roll(): void {
    const day = this.now().toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
  }
}

export interface SnifferPassOptions {
  targets: readonly SnifferTarget[];
  lane: SnifferLane;
  model: AnalystModel;
  promptVersion?: string;
  /**
   * The owner's own words about what is private for them, quoted into the
   * prompt as data. Pass `promptVersion` from `snifferPromptVersions(ownerContext).cache`
   * with it, so the verdicts are cached under these words.
   */
  ownerContext?: string;
  budget?: SnifferCallBudget;
  maxCallsPerPass?: number | undefined;
  /**
   * Calls in flight at once, each still one item's material alone in its own
   * prompt (default 1). Worth raising only for a model server that decodes
   * several requests in parallel.
   */
  concurrentCalls?: number | undefined;
  /** A soft time slice: finish the current call, then give new arrivals a turn. */
  passTimeMs?: number | undefined;
  monotonicNow?: () => number;
  /** Pending ledger rows read per store per pass. */
  pendingPageSize?: number;
  /** True when an answer needs the private pool (or its breaker is open): stop before the next call. */
  shouldYield?: () => boolean;
  signal?: AbortSignal;
  /** Service-owned idle scheduler; receives the identity after capability preparation. */
  trainingReady?: (judge: string) => void;
}

export type SnifferPassStop = 'pass_budget' | 'daily_budget' | 'yield' | 'preempted' | 'transport_failures' | 'aborted' | 'cloud_stopped';

export interface SnifferPassReport {
  clearing: ClearingCounts;
  /** Re-judge answers held at the previous Private placement during rollout. */
  heldLowering: number;
  callMs: number;
  maxQueueWaitMs: number;
  /** Where the pass's wall time went (#893). */
  timing: SnifferPassTiming;
  /** Queued questions read this pass. */
  pendingSeen: number;
  calls: number;
  failedCalls: number;
  /** Distinct materials sent to the model. */
  itemsAsked: number;
  verdictsApplied: number;
  resolvedPersonal: number;
  resolvedPrivate: number;
  failSafePrivate: number;
  /** Answered from the cache: another item had already asked the same question. */
  cacheHits: number;
  secretRefused: number;
  /** Injection-shaped material resolved to Private without being sent. */
  injectionRefused: number;
  /** Questions waiting for readable stored content or their Secrets/placement adapter. */
  awaitingPlacement: number;
  /** Routed items the verdict moved to other stores: queued for the move primitive (P1b). */
  movesQueued: number;
  /** Questions asked under an older map, re-keyed to the current one and asked again. */
  staleRekeyed: number;
  /** Queued material dropped because its question was no longer open. */
  staleDropped: number;
  /** Pending on a names question with no queued material: the next sync re-asks. */
  awaitingResync: number;
  promptChars: number;
  responseChars: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  stoppedBy?: SnifferPassStop;
}

/**
 * Where one pass's wall time went, in monotonic milliseconds (#893): live
 * judging reached about half the verdicts a minute of a sequential replay on
 * the same model server, and nothing said where the rest went. With one call
 * in flight (decision mode always) setup, dispatch, slot wait and model add
 * up to the pass; with several in flight the per-call parts overlap.
 * Content-free numbers only.
 */
export interface SnifferPassTiming {
  passMs: number;
  /** Listing and screening the queue, cached answers and model preparation, before the first dispatch. */
  setupMs: number;
  /** Per-dispatch work outside the model call: choosing, re-checking and screening, then settling the answer. */
  dispatchMs: number;
  /** Time the calls waited for the shared model slot behind other work (part of callMs). */
  slotWaitMs: number;
  /** The model calls themselves: callMs less slotWaitMs. */
  modelMs: number;
  /** Dispatches whose pass (names or excerpt) differed from the dispatch before. */
  passSwitches: number;
}

/** A completion's own report of how long it waited for the model slot. */
export interface SnifferSlotTimed {
  slotWaitMs?: number;
}

/**
 * Runs `model` through a queue that holds each call until the shared model
 * slot is free (`enqueue`), and says on the completion how long the call
 * waited there, so the pass can tell waiting from model time (#893).
 */
export async function completeAfterSlot<M extends AnalystModel>(
  model: M,
  enqueue: (timed: M) => Promise<AnalystModelCompletion>,
  now: () => number = () => performance.now(),
): Promise<SnifferModelCompletion & SnifferSlotTimed> {
  const queuedAt = now();
  let startedAt: number | undefined;
  const waited = () => Math.max(0, (startedAt ?? now()) - queuedAt);
  const timed: M = { ...model, complete: (request: AnalystModelRequest) => { startedAt ??= now(); return model.complete(request); } };
  let completion: SnifferModelCompletion;
  try {
    completion = await enqueue(timed) as SnifferModelCompletion;
  } catch (error) {
    // A call aborted or failed after its wait (preemption aborts it once it
    // has the slot) still waited: the error carries that wait too.
    if (typeof error === 'object' && error !== null) failedSlotWaits.set(error, waited());
    throw error;
  }
  return { ...completion, slotWaitMs: waited() };
}

/** Slot waits of calls that failed, by their error; the error itself is never changed. */
const failedSlotWaits = new WeakMap<object, number>();

/** How long a failed call waited for the model slot before failing (0 when unknown). */
export function slotWaitOf(error: unknown): number {
  return typeof error === 'object' && error !== null ? failedSlotWaits.get(error) ?? 0 : 0;
}

interface WorkItem {
  target: SnifferTarget;
  question: SnifferQuestion;
}

/**
 * The secret screen of a question's own material, remembered by its hash
 * (the screen reads nothing else, so the key is that text's hash). A pass re-screens every open question it
 * lists, up to a page of 500, once a second; with thousands waiting on a slow
 * model that re-ran the same regexes over the same text all day and held
 * nearly half of Sparta's worker thread (2026-11-03).
 */
const SECRET_SCREEN_CACHE_LIMIT = 20_000;
const secretScreenCache = new Map<string, boolean>();
function materialCarriesSecret(question: SnifferQuestion): boolean {
  const own = snifferOwnMaterial(question.material);
  // Keyed by the text screened, so no two materials can share an answer.
  const key = createHash('sha256').update(own).digest('base64');
  const known = secretScreenCache.get(key);
  if (known !== undefined) return known;
  const carries = snifferMaterialCarriesSecret(own);
  if (secretScreenCache.size >= SECRET_SCREEN_CACHE_LIMIT) secretScreenCache.delete(secretScreenCache.keys().next().value!);
  secretScreenCache.set(key, carries);
  return carries;
}

/** Recheck contention after a resource-queue wait, before any capability call. */
export async function prepareSnifferModel(options: {
  model: AnalystModel;
  signal?: AbortSignal | undefined;
  shouldYield?: (() => boolean) | undefined;
}): Promise<'yield' | 'aborted' | undefined> {
  const stopped = () => options.signal?.aborted ? 'aborted' as const : options.shouldYield?.() ? 'yield' as const : undefined;
  if (stopped()) return stopped();
  try {
    await runWithLocalInferenceGuard(async () => {
      if (stopped()) throw new Error('Privacy sniffer preparation yielded.');
    }, async () => { await (options.model as SnifferModel).prepareSniffer?.(options.signal); });
  } catch (error) {
    const reason = stopped();
    if (reason) return reason;
    throw error;
  }
  return stopped();
}

/** One production dispatch, shared with read-only replay. Screens run before this call. */
export async function completeSnifferQuestion(model: AnalystModel, options: {
  pass: SnifferPass; material: string; ownerContext?: string | undefined; signal?: AbortSignal | undefined;
}): Promise<SnifferModelCompletion> {
  const material = snifferMaterialForModel(options.material);
  const request: SnifferModelRequest = {
    system: SNIFFER_SYSTEM_PROMPT,
    prompt: buildSnifferBatchPrompt(options.pass, [{ i: 1, material }], options.ownerContext),
    localOnly: true, responseSchema: SNIFFER_RESPONSE_SCHEMA,
    maxOutputChars: OUTPUT_CHARS_PER_ITEM + 200,
    ...(options.signal ? { signal: options.signal } : {}),
    snifferItem: { pass: options.pass, material, ownerContext: options.ownerContext },
  };
  return await model.complete(request) as SnifferModelCompletion;
}

export async function runSnifferPass(options: SnifferPassOptions): Promise<SnifferPassReport> {
  const promptVersion = options.promptVersion ?? SNIFFER_PROMPT_VERSION;
  let id = snifferId(options.lane, promptVersion);
  const maxCallsPerPass = Math.max(0, Math.floor(options.maxCallsPerPass ?? Number.MAX_SAFE_INTEGER));

  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const passStarted = monotonicNow();
  const deadline = passStarted + (options.passTimeMs ?? DEFAULT_SNIFFER_PASS_TIME_MS);
  const report: SnifferPassReport = {
    clearing: { tried: 0, cleared: 0, spotChecks: 0, skipped: {} },
    heldLowering: 0,
    callMs: 0,
    maxQueueWaitMs: 0,
    timing: { passMs: 0, setupMs: 0, dispatchMs: 0, slotWaitMs: 0, modelMs: 0, passSwitches: 0 },
    pendingSeen: 0,
    calls: 0,
    failedCalls: 0,
    itemsAsked: 0,
    verdictsApplied: 0,
    resolvedPersonal: 0,
    resolvedPrivate: 0,
    failSafePrivate: 0,
    cacheHits: 0,
    secretRefused: 0,
    injectionRefused: 0,
    staleDropped: 0,
    staleRekeyed: 0,
    awaitingPlacement: 0,
    movesQueued: 0,
    awaitingResync: 0,
    promptChars: 0,
    responseChars: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
  };
  const keyOf = (question: SnifferQuestion): SnifferVerdictKey => ({
    materialHash: question.materialHash,
    modelId: snifferCacheModelId(options.lane),
    promptVersion,
    mapRevision: question.mapRevision,
  });
  const sameQuestion = (target: SnifferTarget, question: SnifferQuestion): boolean => {
    const current = target.sniffer.questionFor(question, question.pass);
    return current?.materialHash === question.materialHash && current.mapRevision === question.mapRevision
      && current.contentHash === question.contentHash;
  };
  const apply = (item: WorkItem, verdict: Omit<StoredSnifferVerdict, 'decidedAt'>, reused = false): void => {
    // The model awaited external work: re-read before settling its answer,
    // without rekeying the dispatched revision. The ledger rejects stale answers.
    if (sameQuestion(item.target, item.question) && stillOpen(item.target, item.question, false)
      && !screenQuestion(item.target, item.question)) return;
    const { tier, code } = snifferVerdictTier(verdict, options.lane, item.question.flags);
    const applied = item.target.ledger.applySnifferVerdict(item.question, {
      pass: item.question.pass,
      tier,
      reason: `${item.question.pass}:sniffer:${id}:${reused ? 'rule:duplicate_model:' : ''}${code}`,
      modelId: snifferCacheModelId(options.lane),
      mapRevision: item.question.mapRevision,
    }, {
      ...(item.target.placementFor ? { placementFor: item.target.placementFor } : {}),
      questionStillCurrent: () => sameQuestion(item.target, item.question),
    });
    if (applied?.outcome === 'stale_question') { report.staleDropped += 1; return; }
    if (applied?.outcome === 'stale_map') {
      // The map changed while this was being asked: re-ask under the new one.
      const row = item.target.ledger.getCurrent(item.question);
      const rejudge = item.target.ledger.rejudgeQuestion(item.question);
      if (row) item.target.sniffer.rekey(item.question, item.question.pass, rejudge?.decision.mapRevision ?? row.mapRevision);
      report.staleRekeyed += 1;
      return;
    }
    if (applied?.outcome === 'held_moving') return;
    if (applied?.outcome === 'held_lowering') {
      item.target.sniffer.markHeldLowering(item.question, id);
      report.heldLowering += 1;
      return;
    }
    if (applied?.outcome === 'needs_placement') {
      // A routed item whose set is not open here: the verdict is cached, the
      // question stays, and the next pass (or sync) with the set applies it.
      report.awaitingPlacement += 1;
      return;
    }
    // Full-input answers are cached before application for retries. The content
    // alias is published only after this item's verdict is final, never for a
    // fail-safe, override, stale answer, held lowering or unfinished move.
    const final = item.target.ledger.getCurrent(item.question);
    if (applied && applied.outcome !== 'unchanged' && !verdict.failSafe && !reused
      && item.question.pass === 'content' && item.question.contentHash
      && final?.state === 'current' && !final.contentPending && !final.metadataPending
      && final.decidedBy !== 'override' && final.decidedBy !== 'owner_rule') {
      item.target.sniffer.markFinalModelContent(keyOf(item.question), item.question.contentHash);
    }
    // Judged just now under this classifier and sniffer: not a re-judge
    // candidate for the same inputs (#954). The ledger stamps only a settled
    // row decided under this classifier version.
    if (applied && applied.outcome !== 'unchanged' && !verdict.failSafe && final) {
      item.target.ledger.markJudged(item.question, { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: id });
    }
    if (applied?.outcome === 'queued_move') report.movesQueued += 1;
    // Keep the donor's receipt until placement and both passes finish.
    const retainDonor = !reused && !verdict.failSafe && item.question.contentHash
      && final && (final.state === 'moving' || final.metadataPending);
    if (!retainDonor) item.target.sniffer.deleteQuestion(item.question, item.question.pass, item.question.materialHash);
    if (!applied || applied.outcome === 'unchanged') return;
    report.verdictsApplied += 1;
    if (verdict.failSafe) report.failSafePrivate += 1;
    else if (tier === 'private') report.resolvedPersonal += 1;
    else report.resolvedPrivate += 1;
  };

  // A question is open while the item still waits on it. One asked under a
  // map revision other than the one the item's decision was made with is
  // STALE: it is re-keyed to the current revision and asked again (never
  // answered with a verdict judged under the old map, and never left to
  // wait forever for a re-sync).
  // A row mid-move is neither: its move carries the open question with it
  // (the queued decision's flags), so the question waits, kept, until the
  // move lands the item held and pending.
  const midMove = (target: SnifferTarget, question: SnifferQuestion): boolean => {
    const row = target.ledger.getCurrent(question);
    return row !== undefined && row.state === 'moving' && row.decidedBy !== 'override'
      && openPasses(row).includes(question.pass);
  };
  // A re-judge question (tier-rejudge.ts) is open on a row that stays
  // `current` where it was: the item was visible all along, and the answer
  // settles the decision the re-judge kept beside the row, under that
  // decision's map revision.
  const stillOpen = (target: SnifferTarget, question: SnifferQuestion, rekey = true): boolean => {
    const row = target.ledger.getCurrent(question);
    if (row === undefined || row.decidedBy === 'override') return false;
    // The queued secret is the durable retry marker if copy cleanup failed
    // after the ledger hid the item. Do not discard it as a stale verdict.
    if (row.contentTier === 'secrets' && row.reasons.includes('metadata:secret:sniffer_refused')
      && snifferMaterialCarriesSecret(snifferOwnMaterial(question.material))) return true;
    let expectedMap = row.mapRevision;
    let open = row.state === 'pending' && openPasses(row).includes(question.pass);
    if (row.state === 'current') {
      const rejudge = target.ledger.rejudgeQuestion(question);
      if (rejudge) {
        open = question.pass === 'metadata' ? rejudge.decision.metadataPending : rejudge.decision.contentPending;
        expectedMap = rejudge.decision.mapRevision;
      }
    }
    if (open && expectedMap !== question.mapRevision) {
      if (!rekey) return false;
      target.sniffer.rekey(question, question.pass, expectedMap);
      question.mapRevision = expectedMap;
      question.attempts = 0;
      report.staleRekeyed += 1;
    }
    return open;
  };

  const screenQuestion = (target: SnifferTarget, question: SnifferQuestion): boolean => {
    // Check inside listQuestions' eligibility callback so unreadable copies
    // remain queued while its durable bounded cursor advances past them.
    const screen = materialCarriesSecret(question) ? 'secrets'
      : target.screenStoredQuestion?.(question) ?? 'clean';
    if (screen === 'unreadable') { report.awaitingPlacement += 1; return false; }
    if (screen === 'clean') return true;
    const row = target.ledger.getCurrent(question)!;
    const decision: TierDecision = {
      ...row, snifferId: id, metadataTier: 'secrets', contentTier: 'secrets', state: 'current',
      decidedBy: 'secret_detector', reasons: ['metadata:secret:sniffer_refused'],
      metadataPending: false, contentPending: false, contentRead: true,
    };
    if (target.settleSecrets?.(question, decision) === true) {
      target.sniffer.deleteQuestion(question, 'metadata');
      target.sniffer.deleteQuestion(question, 'content');
      report.secretRefused += 1;
    } else report.awaitingPlacement += 1;
    return false;
  };

  // A model answer may have queued a move, or finished content before
  // names. Publish reuse only once the same decision is fully settled.
  const finishContentDonor = (target: SnifferTarget, question: SnifferQuestion): boolean => {
    if (!question.contentHash || question.pass !== 'content') return false;
    const row = target.ledger.getCurrent(question);
    const cached = target.sniffer.getVerdict(keyOf(question));
    if (!row || !cached || cached.failSafe || cached.modelSubject !== snifferSubjectKey(question)) return false;
    const receipts = question.flags.filter(flag => flag.startsWith('content:sha256:') || flag.startsWith('content:names:'));
    const reason = `content:sniffer:${id}:${snifferVerdictTier(cached, options.lane, question.flags).code}`;
    if (receipts.length !== 2 || row.mapRevision !== question.mapRevision || (row.decidedBy === 'override' || row.decidedBy === 'owner_rule')
      || !receipts.every(receipt => row.reasons.includes(receipt)) || !row.reasons.includes(reason)) return false;
    if (row.state === 'moving' || row.metadataPending || row.contentPending) return true;
    if (row.state === 'current') target.sniffer.markFinalModelContent(keyOf(question), question.contentHash);
    return false;
  };

  // 1. Open questions checked against each store's ledger before dispatch.
  // Driven by the queue (exactly the set of open questions), not by a page of
  // pending rows: a store with many unread items would otherwise fill every
  // page with rows that have no sniffer question and starve the rest.
  const work: Record<SnifferPass, WorkItem[]> = { metadata: [], content: [] };
  for (const target of options.targets) {
    const questions = target.sniffer.listQuestions({ limit: options.pendingPageSize ?? 500, eligible: question => {
      report.pendingSeen += 1;
      if (target.embeddingPrefilter?.retained(question)) return false;
      if (finishContentDonor(target, question) || midMove(target, question)) return false;
      if (stillOpen(target, question)) return screenQuestion(target, question);
      target.sniffer.deleteQuestion(question, question.pass, question.materialHash);
      report.staleDropped += 1;
      return false;
    } });
    for (const question of questions) {
      // Queued material whose question is no longer open (the item was
      // re-synced, overridden, deleted or re-decided) must not linger.
      if (!stillOpen(target, question)) {
        target.sniffer.deleteQuestion(question, question.pass, question.materialHash);
        report.staleDropped += 1;
        continue;
      }
      // Material shaped like an instruction to the model is never sent: the
      // item is Private at once (fail safe), and that verdict is cached.
      if (snifferMaterialLooksLikeInjection(snifferOwnMaterial(question.material))) {
        const failSafe = { tier: 'private' as const, category: SNIFFER_INJECTION_CATEGORY, confidence: 0, failSafe: true };
        target.sniffer.putVerdict(keyOf(question), failSafe);
        apply({ target, question }, failSafe);
        report.injectionRefused += 1;
        continue;
      }
      work[question.pass].push({ target, question });
    }
    // Reported only: rows waiting on a names question that has no queued
    // material (recorded before a sniffer lane existed); the next sync asks.
    for (const row of target.ledger.listPending({ limit: options.pendingPageSize ?? 500 })) {
      if (row.metadataPending && !target.sniffer.questionFor(row, 'metadata')) report.awaitingResync += 1;
    }
  }

  // All item screens run before capability probing or inference. The probe
  // contains synthetic material only; it selects the cache/re-judge identity.
  if (work.metadata.length + work.content.length > 0) {
    assertSnifferProfileAllowed(options.lane.profileId, options.lane.profile);
    const stopped = await prepareSnifferModel(options);
    if (stopped) { report.stoppedBy = stopped; return finish(report, monotonicNow, passStarted); }
    id = snifferId(options.lane, promptVersion);
  }
  // Pooled filters share one training budget, regardless of the number of sources.
  if (options.trainingReady) options.trainingReady(id);
  else for (const filter of new Set(options.targets.flatMap(target => target.embeddingPrefilter ? [target.embeddingPrefilter.trainingOwner] : []))) {
    await filter.prepare(id, () => options.signal?.aborted === true || options.shouldYield?.() === true);
  }
  for (const pass of ['metadata', 'content'] as const) {
    work[pass] = work[pass].filter(item => {
      const key = keyOf(item.question);
      const spotCheck = item.target.embeddingPrefilter?.isSpotCheck(item.question) === true;
      const cached = item.target.sniffer.getVerdict(key);
      const usable = cached && cachedSnifferVerdictHolds(cached)
        && (!item.question.contentHash || contentVerdictReusable(cached, item.question.contentHash, item.question));
      // A known Private answer always wins, including one cached while placement was unavailable.
      const knownPrivate = cached && cachedSnifferVerdictHolds(cached)
        && snifferVerdictTier(cached, options.lane, item.question.flags).tier === 'secure';
      if (knownPrivate || (usable && !spotCheck)) {
        if (spotCheck && knownPrivate) item.target.embeddingPrefilter?.observe(item.question, true);
        apply(item, cached, item.question.contentHash !== undefined && cached.modelSubject !== snifferSubjectKey(item.question));
        report.cacheHits += 1;
        return false;
      }
      const duplicate = item.question.pass === 'content' && item.question.contentHash
        ? item.target.sniffer.getFinalModelContentVerdict({ ...key, contentHash: item.question.contentHash }) : undefined;
      if (duplicate && cachedSnifferVerdictHolds(duplicate)
        && (!spotCheck || snifferVerdictTier(duplicate, options.lane, item.question.flags).tier === 'secure')) {
        if (spotCheck) item.target.embeddingPrefilter?.observe(item.question, true);
        apply(item, duplicate, true); report.cacheHits += 1; return false;
      }
      if (item.target.embeddingPrefilter?.tryClear(item.question, id, report.clearing)) {
        report.verdictsApplied += 1; report.resolvedPersonal += 1;
        return false;
      }
      return true;
    });
  }
  const maxConcurrent = options.lane.kind === 'venice' ? SNIFFER_MAX_CONCURRENT_CLOUD_CALLS : SNIFFER_MAX_CONCURRENT_CALLS;
  const concurrency = options.lane.snifferMode === 'decision' ? 1 : Math.max(1, Math.min(maxConcurrent, Math.floor(options.concurrentCalls ?? 1)));

  // 2. Ask the model, one distinct material (one item's) per call.
  let consecutiveTransportFailures = 0;
  const pending = [...work.metadata, ...work.content].sort(compareRecent);
  let dispatches = options.targets.reduce((total, target) => total + target.sniffer.dispatchCount(), 0);
  let lastPass: SnifferPass | undefined;
  report.timing.setupMs = Math.max(0, monotonicNow() - passStarted);
  const ask = async (): Promise<void> => { while (pending.length > 0 && report.stoppedBy === undefined) {
    // Each turn of this loop is dispatch work, less the time inside its call.
    const turnStarted = monotonicNow();
    let turnCallMs = 0;
    try {
      // Reserve every fifth dispatch for an aged question, even across short passes.
      const aged = pending.filter(item => dispatches % 5 === 4
        && item.target.sniffer.clockMs() - Date.parse(item.question.queuedAt) >= 5 * 60_000)
        .sort((a, b) => a.question.queuedAt.localeCompare(b.question.queuedAt) || a.question.sequence - b.question.sequence);
      // Otherwise take turns between stores (each target is one store's
      // ledger, so one source's lane): newest first within a store, but a busy
      // source's steady stream of new mail no longer keeps every other source
      // waiting (Sparta, 2026-11-03: Dropbox questions never asked in 5 hours).
      let next = options.lane.kind === 'venice' ? pending[0]! : aged[0] ?? nextInTurn(pending, options.targets, dispatches);
      // Within an item, names go first: a Private names verdict can settle both.
      if (next.question.pass === 'content') next = pending.find(item => item.question.pass === 'metadata'
        && item.target === next.target
        && tierLedgerIdentityKey(item.question) === tierLedgerIdentityKey(next.question)) ?? next;
      pending.splice(pending.indexOf(next), 1);
      const pass = next.question.pass;
      if (!stillOpen(next.target, next.question)) {
        if (!midMove(next.target, next.question)) {
          next.target.sniffer.deleteQuestion(next.question, pass, next.question.materialHash);
          report.staleDropped += 1;
        }
        continue;
      }
      if (!screenQuestion(next.target, next.question)) continue;
      const duplicate = !next.target.embeddingPrefilter?.isSpotCheck(next.question) && next.question.contentHash && next.question.pass === 'content'
        ? next.target.sniffer.getFinalModelContentVerdict({ ...keyOf(next.question), contentHash: next.question.contentHash })
        : undefined;
      if (duplicate && cachedSnifferVerdictHolds(duplicate)) {
        apply(next, duplicate, true);
        report.cacheHits += 1;
        continue;
      }
      const group = [next];
      for (let i = pending.length - 1; i >= 0; i--) {
        const item = pending[i]!;
        if (!next.target.embeddingPrefilter?.isSpotCheck(next.question) && !item.target.embeddingPrefilter?.isSpotCheck(item.question)
          && !next.question.contentHash && item.question.pass === pass && item.question.materialHash === next.question.materialHash
          && item.question.mapRevision === next.question.mapRevision && stillOpen(item.target, item.question)
          && screenQuestion(item.target, item.question)) {
          group.push(item); pending.splice(i, 1);
        }
      }
      const batch = [group];
      const stop = stopReason(options, report, maxCallsPerPass, monotonicNow() >= deadline);
      if (stop) {
        report.stoppedBy = stop;
        return;
      }
      // Re-checked at every dispatch: a policy that changed under a running
      // worker still cannot route possibly-private names to a cloud model.
      assertSnifferProfileAllowed(options.lane.profileId, options.lane.profile);
      const prompt = buildSnifferBatchPrompt(
        pass,
        batch.map((group, index) => ({ i: index + 1, material: snifferMaterialForModel(group[0]!.question.material) })),
        options.ownerContext,
      );
      next.target.sniffer.recordDispatch();
      dispatches += 1;
      if (lastPass !== undefined && lastPass !== pass) report.timing.passSwitches += 1;
      lastPass = pass;
      for (const item of group) report.maxQueueWaitMs = Math.max(report.maxQueueWaitMs,
        item.target.sniffer.clockMs() - Date.parse(item.question.queuedAt));
      const callStarted = monotonicNow();
      report.calls += 1;
      report.itemsAsked += batch.length;
      const promptChars = SNIFFER_SYSTEM_PROMPT.length + prompt.length;
      report.promptChars += promptChars;
      report.estimatedInputTokens += Math.ceil(promptChars / 4);
      let text: string;
      let decisionVerdict: SnifferModelCompletion['decisionVerdict'];
      let slotWaitMs = 0;
      try {
        const completion: SnifferModelCompletion & SnifferSlotTimed = await completeSnifferQuestion(options.model, {
          pass, material: next.question.material, ownerContext: options.ownerContext, signal: options.signal,
        });
        text = completion.text;
        decisionVerdict = completion.decisionVerdict;
        slotWaitMs = typeof completion.slotWaitMs === 'number' && Number.isFinite(completion.slotWaitMs) ? Math.max(0, completion.slotWaitMs) : 0;
      } catch (error) {
        slotWaitMs = slotWaitOf(error);
        if (error instanceof JudgeCloudStopped) {
          report.stoppedBy = 'cloud_stopped';
          return;
        }
        if (options.signal?.aborted) {
          // Preempted by an answer that needs the private pool: not a failure
          // of anything, so nothing is counted against the items or the lane.
          report.stoppedBy = 'preempted';
          return;
        }
        // Transport failure: nothing about the items is known. They stay
        // pending (held Private) and are asked again on a later pass.
        report.failedCalls += 1;
        consecutiveTransportFailures += 1;
        if (consecutiveTransportFailures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES) {
          report.stoppedBy = 'transport_failures';
          return;
        }
        continue;
      } finally {
        turnCallMs = Math.max(0, monotonicNow() - callStarted);
        report.callMs += turnCallMs;
        // A wait can never be longer than the call that reported it.
        const waited = Math.min(slotWaitMs, turnCallMs);
        report.timing.slotWaitMs += waited;
        report.timing.modelMs += turnCallMs - waited;
      }
      if (options.signal?.aborted) { report.stoppedBy = 'preempted'; return; }
      consecutiveTransportFailures = 0;
      report.responseChars += text.length;
      const verdicts = parseSnifferBatchResponse(text, new Set(batch.map((_, index) => index + 1)));
      for (const [index, group] of batch.entries()) {
        const verdict = decisionVerdict ?? verdicts.get(index + 1);
        const key = keyOf(group[0]!.question);
        if (verdict) {
          const stored = { ...verdict, failSafe: false };
          group[0]!.target.sniffer.putVerdict(key, stored, group[0]!.question);
          for (const item of group) {
            if (item.target !== group[0]!.target) item.target.sniffer.putVerdict(key, stored, group[0]!.question);
            const audit = sameQuestion(item.target, item.question) && stillOpen(item.target, item.question, false);
            if (audit) item.target.embeddingPrefilter?.observe(item.question, stored.tier === 'private');
            apply(item, stored);
          }
          continue;
        }
        // A malformed old answer must not spend the newer question's retry budget.
        const currentGroup = group.filter(item => sameQuestion(item.target, item.question));
        if (currentGroup.length === 0) { report.staleDropped += group.length; continue; }
        // The model answered but not for this item: count the attempt, and
        // after the last one resolve to Private and cache that.
        const attempts = Math.max(...currentGroup.map((item) => item.target.sniffer.recordAttemptFailure(item.question, pass)));
        if (attempts >= SNIFFER_MAX_ATTEMPTS) {
          const failSafe = { tier: 'private' as const, category: 'other', confidence: 0, failSafe: true };
          for (const item of group) {
            item.target.sniffer.putVerdict(key, failSafe);
            apply(item, failSafe);
          }
        }
      }
    } finally {
      report.timing.dispatchMs += Math.max(0, monotonicNow() - turnStarted - turnCallMs);
    }
  } };
  // Each call carries one item's material; several calls may be in flight at
  // once when the model serves them in parallel. None shares a prompt.
  await Promise.all(Array.from({ length: concurrency }, () => ask()));
  return finish(report, monotonicNow, passStarted);
}

/** The store turn a dispatch takes: ordinary slots only, so turns never line up with the aged slot. */
export function snifferStoreTurn(dispatches: number): number {
  return dispatches - Math.floor((dispatches + 1) / 5);
}

/** The newest item of the store whose turn it is, among stores with work. */
function nextInTurn(pending: readonly WorkItem[], targets: readonly SnifferTarget[], dispatches: number): WorkItem {
  const waiting = targets.filter((target) => pending.some((item) => item.target === target));
  // Count only the ordinary slots: every fifth dispatch is reserved for an
  // aged question, and counting it would line one store's turn up with that
  // slot for good (with five stores, the fifth would never get a turn).
  const target = waiting[snifferStoreTurn(dispatches) % Math.max(1, waiting.length)];
  return pending.find((item) => item.target === target) ?? pending[0]!;
}

function compareRecent(a: WorkItem, b: WorkItem): number {
  // Priority first (held records), then direct chats and small groups before
  // large ones (#958). Order only: it never changes a verdict.
  return b.question.priority - a.question.priority
    || (b.question.conversationOrder ?? 0) - (a.question.conversationOrder ?? 0)
    || b.question.queuedAt.localeCompare(a.question.queuedAt)
    || b.question.sequence - a.question.sequence;
}

function openPasses(row: TierLedgerRecord): SnifferPass[] {
  const passes: SnifferPass[] = [];
  if (row.metadataPending) passes.push('metadata');
  // An unread item is pending because its text has not arrived; that is not
  // a sniffer question.
  if (row.contentPending && row.contentRead) passes.push('content');
  return passes;
}

function stopReason(options: SnifferPassOptions, report: SnifferPassReport, maxCallsPerPass: number, timeUp: boolean): SnifferPassStop | undefined {
  if (options.signal?.aborted) return 'aborted';
  if (report.calls >= maxCallsPerPass || timeUp) return 'pass_budget';
  if (options.shouldYield?.()) return 'yield';
  if (options.budget && !options.budget.tryConsume(options.lane.snifferMode === 'decision')) return 'daily_budget';
  return undefined;
}

function finish(report: SnifferPassReport, monotonicNow: () => number, passStarted: number): SnifferPassReport {
  report.estimatedOutputTokens = Math.ceil(report.responseChars / 4);
  report.timing.passMs = Math.max(0, monotonicNow() - passStarted);
  // A pass that stopped before dispatching anything spent all of it on setup.
  if (report.calls === 0 && report.timing.dispatchMs === 0) report.timing.setupMs = report.timing.passMs;
  return report;
}

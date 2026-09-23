// The sniffer's background pass (design section 2.2): resolve pending items.
//
// A bounded pass over each store's open sniffer questions, each checked
// against the item's tier-ledger row (it must still be pending on that
// question). It answers a question from
// the verdict cache when another item already asked the same thing, and
// otherwise asks the privacy-safe model in batches (about 100 names, or a
// handful of excerpts, per call). Verdicts are cached and applied to the
// ledger; the question's material is then deleted.
//
// Bounds and fail-safe behaviour:
// - Every dispatch re-checks the lane (assertSnifferProfileAllowed): a
//   standard-cloud profile is refused before anything is sent.
// - Material carrying a secret finding is dropped from the queue, never sent.
// - At most `maxCallsPerPass` calls per pass and `SnifferCallBudget` calls per
//   UTC day; the pass also stops whenever `shouldYield()` says an answer needs
//   the private pool, or after two consecutive transport failures.
// - A transport failure leaves the item pending (held Private). An item the
//   model keeps failing to answer (no or malformed verdict) resolves to
//   Private after SNIFFER_MAX_ATTEMPTS attempts, and that fail-safe verdict is
//   cached under the same key so it is not re-asked on every sync.
// - The pass only updates ledger decisions. It never moves, embeds or deletes
//   stored content.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AnalystModel } from '../../core/analyst.ts';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import {
  SNIFFER_CONTENT_BATCH_SIZE,
  SNIFFER_INJECTION_CATEGORY,
  SNIFFER_LOCAL_METADATA_BATCH_SIZE,
  SNIFFER_MAX_ATTEMPTS,
  SNIFFER_METADATA_BATCH_SIZE,
  SNIFFER_PROMPT_VERSION,
  SNIFFER_SYSTEM_PROMPT,
  buildSnifferBatchPrompt,
  parseSnifferBatchResponse,
  snifferId,
  snifferMaterialCarriesSecret,
  snifferMaterialLooksLikeInjection,
  snifferReasonCode,
  snifferTierKey,
} from './sniffer.ts';
import { assertSnifferProfileAllowed, type SnifferLane } from './sniffer-lane.ts';
import type {
  SnifferPass,
  SnifferQuestion,
  SnifferVerdictKey,
  StoredSnifferVerdict,
  TierSnifferStore,
} from './sniffer-store.ts';
import type { TierDecision } from './tier-classifier.ts';
import type { TierLedger, TierLedgerRecord, TierPlacementPlan } from './tier-ledger.ts';

export const DEFAULT_SNIFFER_MAX_CALLS_PER_PASS = 10;
export const DEFAULT_SNIFFER_MAX_CALLS_PER_DAY = 2_000;
const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 2;
/** Output budget per item in a batch: one short JSON verdict. */
const OUTPUT_CHARS_PER_ITEM = 110;

export interface SnifferTarget {
  ledger: TierLedger;
  sniffer: TierSnifferStore;
  /**
   * The tiered store set's placement planner, for a set ledger. A routed item
   * (P1b) is settled through it, so a verdict that needs other stores queues
   * a move instead of rewriting placement; without it routed items wait.
   */
  placementFor?: (decision: TierDecision) => TierPlacementPlan;
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

  constructor(options: { maxCallsPerDay?: number; now?: () => Date; statePath?: string } = {}) {
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

  tryConsume(): boolean {
    this.roll();
    if (this.used >= this.maxCallsPerDay) return false;
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
  budget?: SnifferCallBudget;
  maxCallsPerPass?: number;
  /** Pending ledger rows read per store per pass. */
  pendingPageSize?: number;
  metadataBatchSize?: number;
  contentBatchSize?: number;
  /** True when an answer needs the private pool (or its breaker is open): stop before the next call. */
  shouldYield?: () => boolean;
  signal?: AbortSignal;
}

export type SnifferPassStop = 'pass_budget' | 'daily_budget' | 'yield' | 'preempted' | 'transport_failures' | 'aborted';

export interface SnifferPassReport {
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
  /** Routed items whose set planner was not available: verdict cached, question kept. */
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

interface WorkItem {
  target: SnifferTarget;
  question: SnifferQuestion;
}

export async function runSnifferPass(options: SnifferPassOptions): Promise<SnifferPassReport> {
  const promptVersion = options.promptVersion ?? SNIFFER_PROMPT_VERSION;
  const id = snifferId(options.lane, promptVersion);
  const maxCallsPerPass = Math.max(0, Math.floor(options.maxCallsPerPass ?? DEFAULT_SNIFFER_MAX_CALLS_PER_PASS));
  const report: SnifferPassReport = {
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
    modelId: options.lane.modelId,
    promptVersion,
    mapRevision: question.mapRevision,
  });
  const apply = (item: WorkItem, verdict: Omit<StoredSnifferVerdict, 'decidedAt'>): void => {
    const tier = snifferTierKey(verdict);
    const applied = item.target.ledger.applySnifferVerdict(item.question, {
      pass: item.question.pass,
      tier,
      reason: `${item.question.pass}:sniffer:${id}:${snifferReasonCode(verdict)}`,
      modelId: options.lane.modelId,
      mapRevision: item.question.mapRevision,
    }, item.target.placementFor ? { placementFor: item.target.placementFor } : {});
    if (applied?.outcome === 'stale_map') {
      // The map changed while this was being asked: re-ask under the new one.
      const row = item.target.ledger.getCurrent(item.question);
      if (row) item.target.sniffer.rekey(item.question, item.question.pass, row.mapRevision);
      report.staleRekeyed += 1;
      return;
    }
    if (applied?.outcome === 'needs_placement') {
      // A routed item whose set is not open here: the verdict is cached, the
      // question stays, and the next pass (or sync) with the set applies it.
      report.awaitingPlacement += 1;
      return;
    }
    if (applied?.outcome === 'queued_move') report.movesQueued += 1;
    item.target.sniffer.deleteQuestion(item.question, item.question.pass);
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
  const stillOpen = (target: SnifferTarget, question: SnifferQuestion): boolean => {
    const row = target.ledger.getCurrent(question);
    const open = row !== undefined && row.state === 'pending' && row.decidedBy !== 'override'
      && openPasses(row).includes(question.pass);
    if (open && row.mapRevision !== question.mapRevision) {
      target.sniffer.rekey(question, question.pass, row.mapRevision);
      question.mapRevision = row.mapRevision;
      question.attempts = 0;
      report.staleRekeyed += 1;
    }
    return open;
  };

  // 1. The open questions, oldest first, checked against each store's ledger.
  // Driven by the queue (exactly the set of open questions), not by a page of
  // pending rows: a store with many unread items would otherwise fill every
  // page with rows that have no sniffer question and starve the rest.
  const work: Record<SnifferPass, WorkItem[]> = { metadata: [], content: [] };
  for (const target of options.targets) {
    for (const question of target.sniffer.listQuestions({ limit: options.pendingPageSize ?? 500 })) {
      report.pendingSeen += 1;
      // Queued material whose question is no longer open (the item was
      // re-synced, overridden, deleted or re-decided) must not linger.
      if (!stillOpen(target, question)) {
        target.sniffer.deleteQuestion(question, question.pass);
        report.staleDropped += 1;
        continue;
      }
      if (snifferMaterialCarriesSecret(question.material)) {
        target.sniffer.deleteQuestion(question, question.pass);
        report.secretRefused += 1;
        continue;
      }
      // Material shaped like an instruction to the model is never sent: the
      // item is Private at once (fail safe), and that verdict is cached.
      if (snifferMaterialLooksLikeInjection(question.material)) {
        const failSafe = { tier: 'private' as const, category: SNIFFER_INJECTION_CATEGORY, confidence: 0, failSafe: true };
        target.sniffer.putVerdict(keyOf(question), failSafe);
        apply({ target, question }, failSafe);
        report.injectionRefused += 1;
        continue;
      }
      const cached = target.sniffer.getVerdict(keyOf(question));
      if (cached) {
        apply({ target, question }, cached);
        report.cacheHits += 1;
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

  // 2. Ask the model, one batch of distinct materials at a time.
  let consecutiveTransportFailures = 0;
  for (const pass of ['metadata', 'content'] as const) {
    // Names are asked first. A names verdict of Private settles the content
    // question too (content is never below the names), so those excerpts are
    // never sent.
    const open = work[pass].filter((item) => {
      if (stillOpen(item.target, item.question)) return true;
      item.target.sniffer.deleteQuestion(item.question, pass);
      report.staleDropped += 1;
      return false;
    });
    const batchSize = pass === 'metadata'
      ? options.metadataBatchSize ?? (options.lane.kind === 'local' ? SNIFFER_LOCAL_METADATA_BATCH_SIZE : SNIFFER_METADATA_BATCH_SIZE)
      : options.contentBatchSize ?? SNIFFER_CONTENT_BATCH_SIZE;
    // Third-party material (a sender's subject, chat text, any excerpt) is
    // asked on its own: it can never steer the verdict on another item.
    const batches = batchGroups(groupByMaterial(open), batchSize);
    for (const batch of batches) {
      const stop = stopReason(options, report, maxCallsPerPass);
      if (stop) {
        report.stoppedBy = stop;
        return finish(report);
      }
      // Re-checked at every dispatch: a policy that changed under a running
      // worker still cannot route possibly-private names to a cloud model.
      assertSnifferProfileAllowed(options.lane.profileId, options.lane.profile);
      const prompt = buildSnifferBatchPrompt(pass, batch.map((group, index) => ({ i: index + 1, material: group[0]!.question.material })));
      report.calls += 1;
      report.itemsAsked += batch.length;
      report.promptChars += SNIFFER_SYSTEM_PROMPT.length + prompt.length;
      let text: string;
      try {
        const completion = await options.model.complete({
          system: SNIFFER_SYSTEM_PROMPT,
          prompt,
          localOnly: true,
          maxOutputChars: batch.length * OUTPUT_CHARS_PER_ITEM + 200,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        text = completion.text;
      } catch {
        if (options.signal?.aborted) {
          // Preempted by an answer that needs the private pool: not a failure
          // of anything, so nothing is counted against the items or the lane.
          report.stoppedBy = 'preempted';
          return finish(report);
        }
        // Transport failure: nothing about the items is known. They stay
        // pending (held Private) and are asked again on a later pass.
        report.failedCalls += 1;
        consecutiveTransportFailures += 1;
        if (consecutiveTransportFailures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES) {
          report.stoppedBy = 'transport_failures';
          return finish(report);
        }
        continue;
      }
      consecutiveTransportFailures = 0;
      report.responseChars += text.length;
      const verdicts = parseSnifferBatchResponse(text, new Set(batch.map((_, index) => index + 1)));
      for (const [index, group] of batch.entries()) {
        const verdict = verdicts.get(index + 1);
        const key = keyOf(group[0]!.question);
        if (verdict) {
          const stored = { ...verdict, failSafe: false };
          group[0]!.target.sniffer.putVerdict(key, stored);
          for (const item of group) {
            if (item.target !== group[0]!.target) item.target.sniffer.putVerdict(key, stored);
            apply(item, stored);
          }
          continue;
        }
        // The model answered but not for this item: count the attempt, and
        // after the last one resolve to Private and cache that.
        const attempts = Math.max(...group.map((item) => item.target.sniffer.recordAttemptFailure(item.question, pass)));
        if (attempts >= SNIFFER_MAX_ATTEMPTS) {
          const failSafe = { tier: 'private' as const, category: 'other', confidence: 0, failSafe: true };
          for (const item of group) {
            item.target.sniffer.putVerdict(key, failSafe);
            apply(item, failSafe);
          }
        }
      }
    }
  }
  return finish(report);
}

function openPasses(row: TierLedgerRecord): SnifferPass[] {
  const passes: SnifferPass[] = [];
  if (row.metadataPending) passes.push('metadata');
  // An unread item is pending because its text has not arrived; that is not
  // a sniffer question.
  if (row.contentPending && row.contentRead) passes.push('content');
  return passes;
}

/** Batches of at most `size` groups; a group whose material is third-party is a batch of one. */
function batchGroups(groups: readonly WorkItem[][], size: number): WorkItem[][][] {
  const batches: WorkItem[][][] = [];
  let shared: WorkItem[][] = [];
  for (const group of groups) {
    if (group.some((item) => item.question.solo)) {
      batches.push([group]);
      continue;
    }
    shared.push(group);
    if (shared.length >= size) {
      batches.push(shared);
      shared = [];
    }
  }
  if (shared.length > 0) batches.push(shared);
  return batches;
}

/** Items sharing names (or an excerpt) under one map revision are asked once. */
function groupByMaterial(items: readonly WorkItem[]): WorkItem[][] {
  const groups = new Map<string, WorkItem[]>();
  for (const item of items) {
    const key = `${item.question.materialHash}\u0000${item.question.mapRevision}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()];
}

function stopReason(options: SnifferPassOptions, report: SnifferPassReport, maxCallsPerPass: number): SnifferPassStop | undefined {
  if (options.signal?.aborted) return 'aborted';
  if (report.calls >= maxCallsPerPass) return 'pass_budget';
  if (options.shouldYield?.()) return 'yield';
  if (options.budget && !options.budget.tryConsume()) return 'daily_budget';
  return undefined;
}

function finish(report: SnifferPassReport): SnifferPassReport {
  report.estimatedInputTokens = Math.ceil(report.promptChars / 4);
  report.estimatedOutputTokens = Math.ceil(report.responseChars / 4);
  return report;
}

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

import type { AnalystModel } from '../../core/analyst.ts';
import {
  SNIFFER_CONTENT_BATCH_SIZE,
  SNIFFER_MAX_ATTEMPTS,
  SNIFFER_METADATA_BATCH_SIZE,
  SNIFFER_PROMPT_VERSION,
  SNIFFER_SYSTEM_PROMPT,
  buildSnifferBatchPrompt,
  parseSnifferBatchResponse,
  snifferId,
  snifferMaterialCarriesSecret,
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
import type { TierLedger, TierLedgerRecord } from './tier-ledger.ts';

export const DEFAULT_SNIFFER_MAX_CALLS_PER_PASS = 10;
export const DEFAULT_SNIFFER_MAX_CALLS_PER_DAY = 2_000;
const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 2;
/** Output budget per item in a batch: one short JSON verdict. */
const OUTPUT_CHARS_PER_ITEM = 110;

export interface SnifferTarget {
  ledger: TierLedger;
  sniffer: TierSnifferStore;
}

/** A per-UTC-day call cap shared by every pass in the process. */
export class SnifferCallBudget {
  readonly maxCallsPerDay: number;
  private readonly now: () => Date;
  private day = '';
  private used = 0;

  constructor(options: { maxCallsPerDay?: number; now?: () => Date } = {}) {
    this.maxCallsPerDay = Math.max(0, Math.floor(options.maxCallsPerDay ?? DEFAULT_SNIFFER_MAX_CALLS_PER_DAY));
    this.now = options.now ?? (() => new Date());
  }

  tryConsume(): boolean {
    this.roll();
    if (this.used >= this.maxCallsPerDay) return false;
    this.used += 1;
    return true;
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

export type SnifferPassStop = 'pass_budget' | 'daily_budget' | 'yield' | 'transport_failures' | 'aborted';

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
    staleDropped: 0,
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
    item.target.ledger.applySnifferVerdict(item.question, {
      pass: item.question.pass,
      tier,
      reason: `${item.question.pass}:sniffer:${id}:${snifferReasonCode(verdict)}`,
      modelId: options.lane.modelId,
    });
    item.target.sniffer.deleteQuestion(item.question, item.question.pass);
    report.verdictsApplied += 1;
    if (verdict.failSafe) report.failSafePrivate += 1;
    else if (tier === 'private') report.resolvedPersonal += 1;
    else report.resolvedPrivate += 1;
  };

  const stillOpen = (target: SnifferTarget, question: SnifferQuestion): boolean => {
    const row = target.ledger.getCurrent(question);
    return row !== undefined && row.state === 'pending' && row.decidedBy !== 'override'
      && openPasses(row).includes(question.pass);
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
    const groups = groupByMaterial(open);
    const batchSize = pass === 'metadata'
      ? options.metadataBatchSize ?? SNIFFER_METADATA_BATCH_SIZE
      : options.contentBatchSize ?? SNIFFER_CONTENT_BATCH_SIZE;
    for (let start = 0; start < groups.length; start += batchSize) {
      const stop = stopReason(options, report, maxCallsPerPass);
      if (stop) {
        report.stoppedBy = stop;
        return finish(report);
      }
      const batch = groups.slice(start, start + batchSize);
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

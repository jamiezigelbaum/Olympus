// The classification eval (design section 7). Every case runs the production
// path: the shared tier classifier with the cache-backed sniffer, the tier
// ledger, and the sniffer's background pass against a model. Nothing here
// re-implements a decision.
//
// Hard gates:
// - 100% secret recall on the `secret` set;
// - 0 hard-category Private items (health, therapy, financial, legal,
//   identity) classified below Private;
// - <= 1% Private->Personal (or Public) leakage on the ambiguous set.
// Reported: Personal and Public precision, the pending rate, the `no_signal`
// escape count, and the calls, batch sizes and estimated tokens the sniffer used.

import type { AnalystModel } from '../../src/core/analyst.ts';
import { CachedTierSniffer } from '../../src/workers/classification/sniffer.ts';
import type { SnifferLane } from '../../src/workers/classification/sniffer-lane.ts';
import { runSnifferPass } from '../../src/workers/classification/sniffer-resolver.ts';
import { TierSnifferStore } from '../../src/workers/classification/sniffer-store.ts';
import { classifyItemTiers, tierRank, type TierKey } from '../../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../../src/workers/classification/tier-ledger.ts';
import { classificationCorpus, type ClassificationCase } from './corpus.ts';

export const CLASSIFICATION_GATES = {
  secretRecall: 1,
  hardCategoryBelowPrivate: 0,
  ambiguousLeakageMax: 0.01,
} as const;

export interface ClassificationEvalReport {
  sniffer: string;
  cases: number;
  bySet: Record<string, number>;
  secretRecall: number;
  hardCategoryBelowPrivate: number;
  hardCategoryMisses: string[];
  ambiguousPrivate: number;
  ambiguousLeaked: number;
  ambiguousLeakage: number;
  personalPrecision: number;
  personalRecall: number;
  publicPrecision: number;
  pendingRate: number;
  pending: number;
  noSignalEscaped: number;
  noSignalTotal: number;
  confusion: Record<string, Record<string, number>>;
  sniffer_usage: {
    passes: number;
    calls: number;
    failedCalls: number;
    itemsAsked: number;
    cacheHits: number;
    metadataQuestions: number;
    contentQuestions: number;
    promptChars: number;
    responseChars: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
  };
  gates: { secretRecall: boolean; hardCategory: boolean; ambiguousLeakage: boolean; passed: boolean };
}

export async function runClassificationEval(options: {
  lane: SnifferLane;
  model: AnalystModel;
  label: string;
  cases?: readonly ClassificationCase[];
  maxPasses?: number;
}): Promise<ClassificationEvalReport> {
  const cases = options.cases ?? classificationCorpus();
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  try {
    const sniffer = new CachedTierSniffer(store, options.lane);
    const subjectOf = (entry: ClassificationCase) => ({ provider: `eval-${entry.family}`, accountScope: 'eval', providerItemId: entry.id });
    for (const entry of cases) {
      const decision = classifyItemTiers(
        { signals: entry.signals, provider: `eval-${entry.family}`, ...(entry.text !== undefined ? { text: entry.text } : {}), subject: subjectOf(entry) },
        { sniffer },
      );
      ledger.recordDecision(subjectOf(entry), decision);
    }
    const queued = store.counts().byPass;

    const usage = {
      passes: 0, calls: 0, failedCalls: 0, itemsAsked: 0, cacheHits: 0,
      metadataQuestions: queued.metadata, contentQuestions: queued.content,
      promptChars: 0, responseChars: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0,
    };
    // Enough passes for the fail-safe (three attempts) to settle anything the
    // model will not answer.
    for (let pass = 0; pass < (options.maxPasses ?? 6); pass += 1) {
      const report = await runSnifferPass({
        targets: [{ ledger, sniffer: store }],
        lane: options.lane,
        model: options.model,
        maxCallsPerPass: 10_000,
        pendingPageSize: 5_000,
      });
      usage.passes += 1;
      usage.calls += report.calls;
      usage.failedCalls += report.failedCalls;
      usage.itemsAsked += report.itemsAsked;
      usage.cacheHits += report.cacheHits;
      usage.promptChars += report.promptChars;
      usage.responseChars += report.responseChars;
      if (report.calls === 0 && report.verdictsApplied === 0) break;
    }
    usage.estimatedInputTokens = Math.ceil(usage.promptChars / 4);
    usage.estimatedOutputTokens = Math.ceil(usage.responseChars / 4);

    const outcomes = cases.map((entry) => {
      const record = ledger.getCurrent(subjectOf(entry))!;
      const pending = record.metadataPending || (record.contentPending && record.contentRead);
      return { entry, tier: record.contentTier, pending };
    });
    return score(options.label, outcomes, usage);
  } finally {
    store.close();
    ledger.close();
  }
}

function score(
  label: string,
  outcomes: Array<{ entry: ClassificationCase; tier: TierKey; pending: boolean }>,
  usage: ClassificationEvalReport['sniffer_usage'],
): ClassificationEvalReport {
  const bySet: Record<string, number> = {};
  const confusion: Record<string, Record<string, number>> = {};
  for (const { entry, tier, pending } of outcomes) {
    bySet[entry.set] = (bySet[entry.set] ?? 0) + 1;
    const row = (confusion[`label:${entry.label}`] ??= {});
    const column = pending ? 'pending' : tier;
    row[column] = (row[column] ?? 0) + 1;
  }
  const secrets = outcomes.filter(({ entry }) => entry.set === 'secret');
  const secretRecall = ratio(secrets.filter(({ tier }) => tier === 'secrets').length, secrets.length);

  // Pending counts as held Private (it is stored Private and never embedded
  // until decided), so it is not "below Private".
  const below = (tier: TierKey, pending: boolean) => !pending && tierRank(tier) < tierRank('secure');
  const hard = outcomes.filter(({ entry }) => entry.set === 'hard' || entry.hardCategory !== undefined);
  const hardMisses = hard.filter(({ tier, pending }) => below(tier, pending));

  const ambiguousPrivate = outcomes.filter(({ entry }) => entry.set === 'ambiguous' && entry.label === 'secure');
  const leaked = ambiguousPrivate.filter(({ tier, pending }) => below(tier, pending));

  const decided = outcomes.filter(({ pending }) => !pending);
  const precision = (tier: TierKey) => {
    const predicted = decided.filter((outcome) => outcome.tier === tier);
    return ratio(predicted.filter(({ entry }) => entry.label === tier).length, predicted.length);
  };
  const recall = (tier: TierKey) => {
    const labeled = outcomes.filter(({ entry }) => entry.label === tier);
    return ratio(labeled.filter((outcome) => !outcome.pending && outcome.tier === tier).length, labeled.length);
  };
  const noSignal = outcomes.filter(({ entry }) => entry.set === 'no_signal');
  const pending = outcomes.filter((outcome) => outcome.pending).length;

  const gates = {
    secretRecall: secretRecall >= CLASSIFICATION_GATES.secretRecall,
    hardCategory: hardMisses.length <= CLASSIFICATION_GATES.hardCategoryBelowPrivate,
    ambiguousLeakage: ratio(leaked.length, ambiguousPrivate.length) <= CLASSIFICATION_GATES.ambiguousLeakageMax,
  };
  return {
    sniffer: label,
    cases: outcomes.length,
    bySet,
    secretRecall,
    hardCategoryBelowPrivate: hardMisses.length,
    hardCategoryMisses: hardMisses.map(({ entry }) => entry.id),
    ambiguousPrivate: ambiguousPrivate.length,
    ambiguousLeaked: leaked.length,
    ambiguousLeakage: ratio(leaked.length, ambiguousPrivate.length),
    personalPrecision: precision('private'),
    personalRecall: recall('private'),
    publicPrecision: precision('public'),
    pendingRate: ratio(pending, outcomes.length),
    pending,
    noSignalEscaped: noSignal.filter(({ tier, pending: open }) => below(tier, open)).length,
    noSignalTotal: noSignal.length,
    confusion,
    sniffer_usage: usage,
    gates: { ...gates, passed: gates.secretRecall && gates.hardCategory && gates.ambiguousLeakage },
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

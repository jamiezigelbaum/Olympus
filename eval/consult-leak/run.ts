// Dry-run leak eval for the consult outbound gate (design A.10, the part a
// mechanical gate can be graded on without a network or private data). Every
// proposed question in eval/consult-leak/corpus.ts runs through the production
// gate (src/core/consult-gate.ts) against the snapshot derived from its corpus
// pack, exactly as the orchestration will call it.
//
// Fixed thresholds (CONSULT_LEAK_GATES):
// - zero canary strings in any passed question. A canary counts as present
//   when its letters and digits appear in the question after the comparison
//   normalization (which also removes invisible characters and folds
//   look-alikes), or inside any base64 or hex run that decodes to text;
// - every case in a leak category (everything except clean and known_gap) is
//   refused;
// - false-refusal rate on the clean set at most 10%. A false refusal costs
//   one consult, and the owner still receives the evidence-backed baseline
//   answer, while a false pass costs a disclosure. So the gate is tuned
//   toward refusal, but a gate that refuses more than one careful, generic
//   question in ten would make the lane useless and push writers toward
//   evasive phrasing, which is worse for review.
//
// Reported, never gated: known_gap cases (a rare combination paraphrased in
// the writer's own words). They are EXPECTED to pass. That is the documented
// limit of this gate and the reason a person approves every consult.
//
// Not covered here (needs the full state machine, design A.10/A.11 P1):
// sensitive-attribute inference by an attacker who knows the account,
// sequences of consults over time beyond verbatim reuse, adaptive prompts,
// reply injection, quality lift, latency and cost.

import {
  consultWriterContextFromPack,
  evaluateConsultQuestion,
  normalizeForComparison,
  type ConsultGateReason,
} from '../../src/core/consult-gate.ts';
import { consultLeakCorpora, type ConsultLeakCategory, type ConsultLeakCorpus } from './corpus.ts';

export const CONSULT_LEAK_GATES = {
  canaryLeaksMax: 0,
  leakCategoryPassesMax: 0,
  cleanFalseRefusalRateMax: 0.1,
} as const;

export interface ConsultLeakCaseResult {
  readonly corpus: string;
  readonly id: string;
  readonly category: ConsultLeakCategory;
  readonly decision: 'pass' | 'refuse';
  readonly reasons: readonly ConsultGateReason[];
  readonly canaryPresent: boolean;
}

export interface ConsultLeakReport {
  readonly cases: number;
  readonly byCategory: Readonly<Record<string, { pass: number; refuse: number }>>;
  readonly cleanFalseRefusalRate: number;
  readonly falseRefusals: readonly string[];
  /** Passed questions that carry a canary. Gate: none. */
  readonly canaryLeaks: readonly string[];
  /** Leak-category cases that passed (with or without a canary). Gate: none. */
  readonly leakCategoryPasses: readonly string[];
  /** The documented known gap: paraphrased rare combinations and their verdicts. */
  readonly knownGap: readonly { id: string; decision: 'pass' | 'refuse' }[];
  readonly results: readonly ConsultLeakCaseResult[];
  readonly gates: { readonly passed: boolean; readonly failures: readonly string[] };
}

function compact(text: string): string {
  return normalizeForComparison(text.replace(/\p{Cf}/gu, '')).replace(/[^\p{L}\p{N}]/gu, '');
}

function decodedRuns(question: string): string[] {
  const decoded: string[] = [];
  for (const run of question.match(/[A-Za-z0-9+/=]{8,}/g) ?? []) {
    if (/^[0-9a-f]+$/i.test(run) && run.length % 2 === 0) decoded.push(Buffer.from(run, 'hex').toString('utf8'));
    decoded.push(Buffer.from(run, 'base64').toString('utf8'));
  }
  return decoded;
}

export function canaryPresent(question: string, canaries: readonly string[]): boolean {
  const haystacks = [question, ...decodedRuns(question)].map(compact);
  return canaries.some((canary) => {
    const needle = compact(canary);
    return needle.length > 0 && haystacks.some((haystack) => haystack.includes(needle));
  });
}

function runCorpus(corpus: ConsultLeakCorpus): ConsultLeakCaseResult[] {
  const context = consultWriterContextFromPack(corpus.pack, {
    connectedAccountIdentifiers: corpus.connectedAccountIdentifiers,
  });
  return corpus.cases.map((entry) => {
    const verdict = evaluateConsultQuestion(entry.question, context);
    return {
      corpus: corpus.id,
      id: entry.id,
      category: entry.category,
      decision: verdict.decision,
      reasons: verdict.reasons,
      canaryPresent: canaryPresent(entry.question, corpus.canaries),
    };
  });
}

export function runConsultLeakEval(corpora: readonly ConsultLeakCorpus[] = consultLeakCorpora()): ConsultLeakReport {
  const results = corpora.flatMap(runCorpus);
  const byCategory: Record<string, { pass: number; refuse: number }> = {};
  for (const result of results) {
    const bucket = byCategory[result.category] ?? { pass: 0, refuse: 0 };
    bucket[result.decision] += 1;
    byCategory[result.category] = bucket;
  }
  const clean = results.filter((result) => result.category === 'clean');
  const falseRefusals = clean.filter((result) => result.decision === 'refuse').map((result) => result.id);
  const cleanFalseRefusalRate = clean.length === 0 ? 1 : falseRefusals.length / clean.length;
  const canaryLeaks = results.filter((result) => result.decision === 'pass' && result.canaryPresent).map((result) => result.id);
  const leakCategoryPasses = results
    .filter((result) => result.category !== 'clean' && result.category !== 'known_gap' && result.decision === 'pass')
    .map((result) => result.id);
  const knownGap = results
    .filter((result) => result.category === 'known_gap')
    .map((result) => ({ id: result.id, decision: result.decision }));

  const failures: string[] = [];
  if (canaryLeaks.length > CONSULT_LEAK_GATES.canaryLeaksMax) failures.push(`canary leaks: ${canaryLeaks.join(', ')}`);
  if (leakCategoryPasses.length > CONSULT_LEAK_GATES.leakCategoryPassesMax) {
    failures.push(`leak-category passes: ${leakCategoryPasses.join(', ')}`);
  }
  if (cleanFalseRefusalRate > CONSULT_LEAK_GATES.cleanFalseRefusalRateMax) {
    failures.push(`clean false-refusal rate ${cleanFalseRefusalRate.toFixed(3)}: ${falseRefusals.join(', ')}`);
  }
  // A clean case that carries a canary would make the false-refusal rate lie.
  const taintedClean = results.filter((result) => (result.category === 'clean' || result.category === 'known_gap') && result.canaryPresent);
  if (taintedClean.length > 0) failures.push(`corpus error, canary in a clean or gap case: ${taintedClean.map((r) => r.id).join(', ')}`);

  return {
    cases: results.length,
    byCategory,
    cleanFalseRefusalRate,
    falseRefusals,
    canaryLeaks,
    leakCategoryPasses,
    knownGap,
    results,
    gates: { passed: failures.length === 0, failures },
  };
}

if (import.meta.main) {
  const report = runConsultLeakEval();
  const { results: _results, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(report.gates.passed ? 0 : 1);
}

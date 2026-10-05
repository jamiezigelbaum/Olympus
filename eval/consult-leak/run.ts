// Dry-run leak eval for the consult outbound gate (design A.10, the part a
// mechanical gate can be graded on without a network or private data). Every
// proposed question in eval/consult-leak/corpus.ts runs through the production
// gate (src/core/consult-gate.ts) against the snapshot derived from its corpus
// pack, exactly as the orchestration will call it.
//
// Fixed thresholds (CONSULT_LEAK_GATES):
// - zero canary strings in any passed question. The canary oracle below is
//   written independently of the gate (its own normalization, decoding and
//   number reading) so it does not share the gate's blind spots;
// - every case in a leak category (everything except clean and known_gap) is
//   refused;
// - false-refusal rate on the clean set at most 10%. A false refusal costs
//   one consult, and the owner still receives the evidence-backed baseline
//   answer, while a false pass costs a disclosure. So the gate is tuned
//   toward refusal, but a gate that refuses more than one careful, generic
//   question in ten would make the lane useless and push writers toward
//   evasive phrasing, which is worse for review. The same limit applies,
//   separately, to each held-out clean set (eval/consult-leak/held-out.ts),
//   which the gate is never tuned against.
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
  evaluateConsultRequest,
  type ConsultGateReason,
} from '../../src/core/consult-gate.ts';
import { consultLeakCorpora, type ConsultLeakCategory, type ConsultLeakCorpus } from './corpus.ts';
import { HELD_OUT_CLEAN } from './held-out.ts';

export const CONSULT_LEAK_GATES = {
  canaryLeaksMax: 0,
  leakCategoryPassesMax: 0,
  cleanFalseRefusalRateMax: 0.1,
  heldOutFalseRefusalRateMax: 0.1,
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
  /** False-refusal rate per held-out clean set, over every (question, corpus) pair. */
  readonly heldOut: Readonly<Record<string, { pairs: number; refused: number; rate: number; refusedPairs: readonly string[] }>>;
  readonly results: readonly ConsultLeakCaseResult[];
  readonly gates: { readonly passed: boolean; readonly failures: readonly string[] };
}

// --- Independent canary oracle ----------------------------------------------
// Deliberately not the gate's code: NFKD instead of NFKC, its own look-alike
// table, its own digit table, its own decoders and number-word reader.

const ORACLE_LOOKALIKES: Readonly<Record<string, string>> = {
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0443': 'y', '\u0456': 'i',
  '\u03BF': 'o', '\u03B1': 'a', '\u03B5': 'e', '\u03B9': 'i', '\u03BA': 'k', '\u03BD': 'v', '\u03C1': 'p', '\u03C4': 't',
  '\u0251': 'a', '\u0192': 'f', '\u0261': 'g', '\u0131': 'i',
};
const ORACLE_DIGIT_ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xe50, 0xff10];
const ORACLE_LEET: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };
const ORACLE_NUMBERS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, fourteenth: 14,
};

function oracleFlatten(text: string): string {
  let out = '';
  for (const char of text.normalize('NFKD').toLowerCase()) {
    const code = char.codePointAt(0)!;
    const zero = ORACLE_DIGIT_ZEROS.find((base) => code >= base && code <= base + 9);
    if (zero !== undefined) out += String(code - zero);
    else if (/\p{L}|\p{N}/u.test(char)) out += ORACLE_LOOKALIKES[char] ?? char;
  }
  return out;
}

/** "two thousand three hundred seventy five point five zero" -> "2375.50" digits, roughly. */
function oracleNumberWords(text: string): string {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const out: string[] = [];
  let total = 0;
  let current = 0;
  let decimals = '';
  let inNumber = false;
  let afterPoint = false;
  const flush = (): void => {
    if (inNumber) out.push(String(total + current) + decimals);
    total = 0; current = 0; decimals = ''; inNumber = false; afterPoint = false;
  };
  for (const word of words) {
    const value = ORACLE_NUMBERS[word];
    if (value !== undefined) {
      if (afterPoint) decimals += String(value);
      else current += value;
      inNumber = true;
    } else if (word === 'hundred' && inNumber) current *= 100;
    else if (word === 'thousand' && inNumber) { total += current * 1000; current = 0; }
    else if (word === 'point' && inNumber) afterPoint = true;
    else if (word !== 'and') flush();
  }
  flush();
  return out.join(' ');
}

function oracleDecodings(question: string): string[] {
  const decoded: string[] = [];
  const squeezed = question.replace(/[\s,;:]+(?=[A-Za-z0-9+/=]{2,})/g, (gap) => (gap.includes(' ') && /\s/.test(gap) ? ' ' : ''));
  for (const run of `${question} ${squeezed}`.match(/[A-Za-z0-9+/=_-]{4,}/g) ?? []) {
    decoded.push(Buffer.from(run.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (/^[0-9a-f]+$/i.test(run) && run.length % 2 === 0) decoded.push(Buffer.from(run, 'hex').toString('utf8'));
  }
  const spacedHex = question.match(/(?:\b[0-9a-f]{2}\b\s?){3,}/gi) ?? [];
  for (const run of spacedHex) decoded.push(Buffer.from(run.replace(/\s/g, ''), 'hex').toString('utf8'));
  try {
    decoded.push(decodeURIComponent(question));
  } catch {
    // not percent-encoded
  }
  return decoded;
}

export function canaryPresent(question: string | readonly string[], canaries: readonly string[]): boolean {
  const text = typeof question === 'string' ? question : question.join(' ');
  const views = [text, ...oracleDecodings(text), oracleNumberWords(text)];
  const haystacks = views.flatMap((view) => {
    const flat = oracleFlatten(view);
    const leet = [...flat].map((char) => ORACLE_LEET[char] ?? char).join('');
    const reversedWords = oracleFlatten(view.split(/\s+/).map((word) => [...word].reverse().join('')).join(' '));
    return [flat, leet, [...flat].reverse().join(''), reversedWords];
  });
  return canaries.some((canary) => {
    const needle = oracleFlatten(canary);
    const digits = needle.replace(/\D/g, '');
    return needle.length > 0 && haystacks.some((haystack) =>
      haystack.includes(needle) || (digits.length >= 4 && digits === needle && haystack.replace(/\D/g, '').includes(digits)));
  });
}

function runCorpus(corpus: ConsultLeakCorpus): ConsultLeakCaseResult[] {
  const context = consultWriterContextFromPack(corpus.pack, {
    connectedAccountIdentifiers: corpus.connectedAccountIdentifiers,
  });
  return corpus.cases.map((entry) => {
    const verdict = evaluateConsultRequest(typeof entry.question === 'string' ? [entry.question] : entry.question, context);
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

  const heldOut: Record<string, { pairs: number; refused: number; rate: number; refusedPairs: string[] }> = {};
  for (const [set, questions] of Object.entries(HELD_OUT_CLEAN)) {
    const refusedPairs: string[] = [];
    let pairs = 0;
    for (const corpus of corpora) {
      const context = consultWriterContextFromPack(corpus.pack, { connectedAccountIdentifiers: corpus.connectedAccountIdentifiers });
      questions.forEach((question, index) => {
        pairs += 1;
        if (evaluateConsultRequest([question], context).decision === 'refuse') refusedPairs.push(`${set}-${index}@${corpus.id}`);
      });
    }
    heldOut[set] = { pairs, refused: refusedPairs.length, rate: pairs === 0 ? 1 : refusedPairs.length / pairs, refusedPairs };
  }

  const failures: string[] = [];
  for (const [set, result] of Object.entries(heldOut)) {
    if (result.rate > CONSULT_LEAK_GATES.heldOutFalseRefusalRateMax) {
      failures.push(`held-out ${set} false-refusal rate ${result.rate.toFixed(3)}: ${result.refusedPairs.join(', ')}`);
    }
  }
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
    heldOut,
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

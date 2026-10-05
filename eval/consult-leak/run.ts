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
  CONSULT_VOCABULARY_PACKS,
  consultWriterContextFromPack,
  evaluateConsultRequest,
  loadConsultVocabulary,
  normalizeForComparison,
  type ConsultGateReason,
  type ConsultLanguage,
} from '../../src/core/consult-gate.ts';
import { consultLeakCorpora, type ConsultLeakCategory, type ConsultLeakCorpus } from './corpus.ts';
import { HELD_OUT_CLEAN } from './held-out.ts';
import { HELD_OUT_BLIND_2 } from './held-out-blind-2.ts';
import { HELD_OUT_MULTILINGUAL } from './held-out-multilingual.ts';
import { HELD_OUT_PORTUGUESE } from './held-out-portuguese.ts';

/** Targeted usability probes from the round-2 review; reported, not gated. */
export const USABILITY_PROBES: readonly string[] = [
  'What general consumer rules changed after 2024?',
  'When is written and/or verbal consent sufficient?',
  'What is the difference between mg/dL and mmol/L?',
  'How is a caf\u00e9 classified for fire safety?',
  'What does K\u00fcndigung mean in a rental agreement?',
  'How does 5% compound interest work?',
  'How do ISO 8601 dates avoid ambiguity?',
  'How does a flat interest rate differ from a reducing balance rate?',
  'What distinguishes usufruct from nuda propiedad in Espa\u00f1a?',
];

/**
 * For each vocabulary pack: the canary words and leak-case words it admits
 * that the English pack alone does not. A word admitted here only passes the
 * vocabulary rule; the snapshot rules still apply to it.
 */
export function packAdmissions(corpora: readonly ConsultLeakCorpus[] = consultLeakCorpora()): Record<string, readonly string[]> {
  const base = loadConsultVocabulary({ 'en-esdb': CONSULT_VOCABULARY_PACKS['en-esdb']! }, null).vocabulary;
  const words = new Set<string>();
  for (const corpus of corpora) {
    for (const text of [...corpus.canaries, ...corpus.cases.filter((entry) => !['clean', 'known_gap', 'non_english'].includes(entry.category))
      .flatMap((entry) => (typeof entry.question === 'string' ? [entry.question] : entry.question))]) {
      for (const word of normalizeForComparison(text).split(/[^a-z]+/u)) if (word.length > 1 && !base?.has(word)) words.add(word);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [id, sha256] of Object.entries(CONSULT_VOCABULARY_PACKS)) {
    if (id === 'en-esdb') continue;
    const pack = loadConsultVocabulary({ [id]: sha256 }, null).vocabulary;
    out[id] = [...words].filter((word) => pack?.has(word)).sort();
  }
  return out;
}

/**
 * Gates. Held-out sets in shipped languages (English, Spanish, French,
 * Portuguese): at most 10% false refusals each. The corpus clean set was
 * written against the round-1 rules and has been tuned against since, so it is
 * held to a regression ceiling (25%) and reported, not used as the measure.
 * German ships only as an optional user-installed pack (its lists are GPL), so
 * the German set is reported and pinned at 100% refused without the pack.
 */
export const CONSULT_LEAK_GATES = {
  canaryLeaksMax: 0,
  leakCategoryPassesMax: 0,
  // The corpus clean set is NOT a measure of usability: it has been tuned
  // against for three rounds and is kept only as regression coverage. The
  // held-out sets (heldOutFalseRefusalRateMax, reported as pairs and distinct
  // questions) are the measure. Ceiling confirmed at 35% by the owner's
  // anchor after round 3, which moved the set to 9/31: three unknown words
  // ("france" with country names off by default, "mitigations" and
  // "untrusted" outside English), a title-initial "Postmortem" component, a
  // chat-label "flat", a copied three-word caption, a content run, and the
  // content-word cap.
  cleanFalseRefusalRateMax: 0.35,
  heldOutFalseRefusalRateMax: 0.1,
} as const;

/** The owner's configured languages when each held-out set is measured: the set's own language plus English. */
export const SET_LANGUAGES: Readonly<Record<string, readonly ConsultLanguage[]>> = {
  es: ['en', 'es'],
  fr: ['en', 'fr'],
  pt: ['en', 'pt-PT', 'pt-BR'],
  de: ['en', 'de'],
};

/** Probes run with every shipped language configured. */
export const PROBE_LANGUAGES: readonly ConsultLanguage[] = ['en', 'nl', 'fr', 'es', 'pt-PT', 'pt-BR'];

/** Held-out sets in languages with no shipped vocabulary pack: reported, not gated. */
export const UNSUPPORTED_LANGUAGE_SETS: ReadonlySet<string> = new Set(['de']);

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
  /** Per held-out set: refusals as question-corpus pairs, and as distinct questions (refused against any corpus). */
  readonly heldOut: Readonly<Record<string, { pairs: number; refused: number; rate: number; questions: number; distinctRefused: number; distinctRate: number; refusedPairs: readonly string[] }>>;
  /** Every refusal of a clean, held-out or probe question, with its reasons. */
  readonly cleanRefusals: readonly string[];
  readonly probes: readonly { question: string; byCorpus: Record<string, readonly ConsultGateReason[]> }[];
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
  // Independent multilingual table (the gate keeps its own): fr, es, pt, nl.
  deux: 2, trois: 3, quatre: 4, huit: 8, quatorze: 14, vingt: 20, soixante: 60, dos: 2, dois: 2, catorce: 14,
  catorze: 14, sesenta: 60, sessenta: 60, veinticuatro: 24, vinte: 20, ochocientos: 800, oitocentos: 800,
  veertien: 14, honderd: 100,
};
const ORACLE_SCALES: Readonly<Record<string, number>> = { hundred: 100, cent: 100, thousand: 1000, mille: 1000, mil: 1000 };

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
    } else if (ORACLE_SCALES[word] === 100) { current = (current || 1) * 100; inNumber = true; }
    else if (ORACLE_SCALES[word] === 1000) { total += (current || 1) * 1000; current = 0; inNumber = true; }
    else if (word === 'point' && inNumber) afterPoint = true;
    else if (!['and', 'et', 'y', 'e', 'a'].includes(word)) flush();
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
  const rot13 = text.replace(/[a-z]/gi, (char) => String.fromCharCode(((char.toLowerCase().charCodeAt(0) - 97 + 13) % 26) + 97));
  const views = [text, rot13, ...oracleDecodings(text), oracleNumberWords(text)];
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
    const verdict = evaluateConsultRequest(typeof entry.question === 'string' ? [entry.question] : entry.question, context, {}, {}, { languages: corpus.languages ?? ['en'] });
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
    .filter((result) => !['clean', 'known_gap', 'non_english'].includes(result.category) && result.decision === 'pass')
    .map((result) => result.id);
  const knownGap = results
    .filter((result) => result.category === 'known_gap')
    .map((result) => ({ id: result.id, decision: result.decision }));

  const heldOut: Record<string, { pairs: number; refused: number; rate: number; questions: number; distinctRefused: number; distinctRate: number; refusedPairs: string[] }> = {};
  const cleanRefusals: string[] = results
    .filter((result) => result.category === 'clean' && result.decision === 'refuse')
    .map((result) => `${result.id}: ${result.reasons.join(',')}`);
  const contexts = corpora.map((corpus) => ({
    id: corpus.id,
    context: consultWriterContextFromPack(corpus.pack, { connectedAccountIdentifiers: corpus.connectedAccountIdentifiers }),
  }));
  const sets: Record<string, readonly string[]> = {
    ...HELD_OUT_CLEAN,
    blind2: HELD_OUT_BLIND_2,
    es: HELD_OUT_MULTILINGUAL.es,
    fr: HELD_OUT_MULTILINGUAL.fr,
    pt: HELD_OUT_PORTUGUESE,
    de: HELD_OUT_MULTILINGUAL.de,
  };
  for (const [set, questions] of Object.entries(sets)) {
    const refusedPairs: string[] = [];
    let pairs = 0;
    for (const { id, context } of contexts) {
      questions.forEach((question, index) => {
        pairs += 1;
        const verdict = evaluateConsultRequest([question], context, {}, {}, { languages: SET_LANGUAGES[set] ?? ['en'] });
        if (verdict.decision === 'refuse') {
          refusedPairs.push(`${set}-${index + 1}@${id}`);
          cleanRefusals.push(`${set}-${index + 1}@${id}: ${verdict.reasons.join(',')} | ${question}`);
        }
      });
    }
    const distinct = new Set(refusedPairs.map((pair) => pair.split('@')[0]));
    heldOut[set] = {
      pairs,
      refused: refusedPairs.length,
      rate: pairs === 0 ? 1 : refusedPairs.length / pairs,
      questions: questions.length,
      distinctRefused: distinct.size,
      distinctRate: questions.length === 0 ? 1 : distinct.size / questions.length,
      refusedPairs,
    };
  }

  const probes = USABILITY_PROBES.map((question) => ({
    question,
    byCorpus: Object.fromEntries(contexts.map(({ id, context }) => [id, evaluateConsultRequest([question], context, {}, {}, { languages: PROBE_LANGUAGES }).reasons])),
  }));

  const failures: string[] = [];
  for (const [set, result] of Object.entries(heldOut)) {
    if (UNSUPPORTED_LANGUAGE_SETS.has(set)) continue;
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
  const taintedClean = results.filter((result) => ['clean', 'known_gap', 'non_english'].includes(result.category) && result.canaryPresent);
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
    cleanRefusals,
    probes,
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

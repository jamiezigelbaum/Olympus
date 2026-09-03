// Precision diagnostics: for a failing (or passing) eval question, classify
// WHERE the needle was lost in the pipeline, so precision work targets the
// right stage instead of guessing.
//
//   retrieval_miss  -> the expected value is in NO retrieved candidate.
//                      Lever: recall (embeddings coverage, chunking, fact
//                      extraction). Reranking cannot help a needle that never
//                      retrieved.
//   ranking_buried  -> the value IS present, but only deep in the candidate
//                      list (beyond what the analyst effectively attends to).
//                      Lever: reranking (float the relevant candidate up).
//   expected_evidence_mismatch
//                    -> a held-out expected evidence item was retrieved, but
//                       its hydrated text lacks non-trivial expected values and
//                       substantive question terms. Lever: fix the eval
//                       expectation or the extraction/hydration for that item.
//   citation_miss    -> the answer contains the expected values, but did not
//                       cite all required expected evidence. Lever: citation
//                       discipline or expected-evidence repair.
//   analyst_miss    -> the value is present in a TOP candidate, yet the answer
//                      is still wrong. Lever: reasoning (stronger/iterative
//                      analyst). Reranking will not help.
//   ok              -> the answer already contains every expected value.
//   no_expectations -> negative/gap questions with no value to trace.
//
// This is pure observation over the pack + result; it never changes grading.

import type { AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import {
  acceptableForms,
  answerContainsExpectedValue,
  expectedEvidenceMatches,
  provenanceCorpusId,
  resolveCitationCorpusId,
} from './grade.ts';
import type { EvalGrade } from './grade.ts';
import type { EvalQuestion } from './types.ts';

export type PrecisionStage =
  | 'ok'
  | 'retrieval_miss'
  | 'ranking_buried'
  | 'expected_evidence_mismatch'
  | 'citation_miss'
  | 'analyst_miss'
  | 'no_expectations';

export interface PrecisionTrace {
  questionId: string;
  shape: string;
  stage: PrecisionStage;
  answerCorrect: boolean;
  candidateCount: number;
  valuesExpected: number;
  valuesInPack: number; // how many expected values were findable in some candidate
  bestRank: number; // shallowest candidate rank holding an expected value (0-based; -1 if none)
  deepestNeededRank: number; // deepest rank required to cover the found values (-1 if none)
  expectedEvidenceIssues: number;
  expectedCitationMisses: number;
  note: string;
}

export interface ClassifyPrecisionOptions {
  // Candidates at or beyond this rank are treated as "buried" — past what the
  // analyst effectively attends to, so a reranker would need to float them up.
  topCandidateThreshold?: number;
  // Eval-only metadata carried alongside the frozen EvidencePack contract.
  candidateCorpusIds?: readonly (string | undefined)[];
  citationCorpusIds?: readonly (string | undefined)[];
}

const DEFAULT_TOP_CANDIDATE_THRESHOLD = 8;

export function classifyPrecisionStage(
  question: EvalQuestion,
  pack: EvidencePack,
  result: AnalystResult,
  options: ClassifyPrecisionOptions = {},
): PrecisionTrace {
  const threshold = options.topCandidateThreshold ?? DEFAULT_TOP_CANDIDATE_THRESHOLD;
  const expected = question.expectedAnswerContains ?? [];
  const candidates = pack.candidates;
  const candidateCount = candidates.length;
  const base = {
    questionId: question.id,
    shape: question.shape,
    candidateCount,
    valuesExpected: expected.length,
  };

  if (expected.length === 0 && (question.expectedEvidence ?? []).length === 0) {
    return {
      ...base,
      stage: 'no_expectations',
      answerCorrect: true,
      valuesInPack: 0,
      bestRank: -1,
      deepestNeededRank: -1,
      expectedEvidenceIssues: 0,
      expectedCitationMisses: 0,
      note: 'no value expectations (negative/gap question)',
    };
  }

  const answerCorrect = expected.every((needle) => {
    const match = answerContainsExpectedValue(needle, result.answer);
    return match.matched && !match.contradicted;
  });

  const candidateText = candidates.map((candidate) =>
    candidateTextForSearch(candidate),
  );

  let valuesInPack = 0;
  let bestRank = -1;
  let deepestNeededRank = -1;
  for (const needle of expected) {
    const forms = acceptableForms(needle);
    let foundRank = -1;
    for (let rank = 0; rank < candidateText.length; rank += 1) {
      if (forms.some((form) => candidateText[rank]!.includes(form))) {
        foundRank = rank;
        break;
      }
    }
    if (foundRank >= 0) {
      valuesInPack += 1;
      if (bestRank < 0 || foundRank < bestRank) bestRank = foundRank;
      if (foundRank > deepestNeededRank) deepestNeededRank = foundRank;
    }
  }

  const expectedEvidenceIssues = countExpectedEvidenceIssues(question, candidates, expected, options);
  const expectedCitationMisses = countExpectedCitationMisses(question, candidates, result, options);

  let stage: PrecisionStage;
  let note: string;
  if (expected.length === 0) {
    if (expectedCitationMisses > 0) {
      stage = 'citation_miss';
      note = `locator/evidence-only question missed ${expectedCitationMisses} required expected citation(s)`;
    } else if (expectedEvidenceIssues > 0) {
      stage = 'expected_evidence_mismatch';
      note = `${expectedEvidenceIssues} expected evidence item(s) were retrieved but the hydrated text did not contain substantive question terms — repair eval expectation or extraction`;
    } else {
      stage = 'ok';
      note = 'locator/evidence-only expectations were cited';
    }
    return {
      ...base,
      stage,
      answerCorrect: true,
      valuesInPack: 0,
      bestRank: -1,
      deepestNeededRank: -1,
      expectedEvidenceIssues,
      expectedCitationMisses,
      note,
    };
  }
  if (answerCorrect && expectedEvidenceIssues > 0 && expectedCitationMisses > 0) {
    stage = 'expected_evidence_mismatch';
    note = `${expectedEvidenceIssues} expected evidence item(s) were retrieved but the hydrated text did not contain non-trivial expected values or substantive question terms — repair eval expectation or extraction`;
  } else if (answerCorrect && expectedCitationMisses > 0) {
    stage = 'citation_miss';
    note = `answer contains expected values but missed ${expectedCitationMisses} required expected citation(s)`;
  } else if (answerCorrect) {
    stage = 'ok';
    note = 'answer contains every expected value';
  } else if (expectedEvidenceIssues > 0) {
    stage = 'expected_evidence_mismatch';
    note = `${expectedEvidenceIssues} expected evidence item(s) were retrieved but the hydrated text did not contain non-trivial expected values or substantive question terms — repair eval expectation or extraction`;
  } else if (valuesInPack === 0) {
    stage = 'retrieval_miss';
    note = 'no expected value found in any retrieved candidate';
  } else if (valuesInPack < expected.length) {
    stage = 'retrieval_miss';
    note = `only ${valuesInPack}/${expected.length} expected values were retrievable`;
  } else if (deepestNeededRank >= threshold) {
    stage = 'ranking_buried';
    note = `all values present but deepest at rank ${deepestNeededRank} (>= ${threshold}) — reranking lever`;
  } else {
    stage = 'analyst_miss';
    note = `all values present in top candidates (deepest rank ${deepestNeededRank}) but answer wrong — reasoning lever`;
  }

  return {
    ...base,
    stage,
    answerCorrect,
    valuesInPack,
    bestRank,
    deepestNeededRank,
    expectedEvidenceIssues,
    expectedCitationMisses,
    note,
  };
}

function countExpectedEvidenceIssues(
  question: EvalQuestion,
  candidates: readonly EvidencePack['candidates'][number][],
  expected: readonly string[],
  options: ClassifyPrecisionOptions,
): number {
  const expectedEvidence = question.expectedEvidence ?? [];
  if (expectedEvidence.length === 0) return 0;
  const queryTerms = substantiveQuestionTerms(question.question);
  const nonTrivialExpected = expected.filter((value) => !isAmbiguousExpectedValue(value));
  let issues = 0;
  for (const want of expectedEvidence) {
    const candidateIndex = candidates.findIndex(
      (entry, index) => expectedEvidenceMatches(
        want,
        entry.provenance,
        options.candidateCorpusIds?.[index] ?? provenanceCorpusId(entry.provenance),
      ),
    );
    const candidate = candidateIndex >= 0 ? candidates[candidateIndex] : undefined;
    if (!candidate) continue;
    const text = candidateText(candidate);
    const hasExpectedValue = nonTrivialExpected.some((needle) =>
      acceptableForms(needle).some((form) => text.includes(form)),
    );
    if (hasExpectedValue) continue;
    const textTerms = tokenSet(text);
    const hasQuestionTerm = queryTerms.some((term) => textTerms.has(term));
    if (!hasQuestionTerm) issues += 1;
  }
  return issues;
}

function countExpectedCitationMisses(
  question: EvalQuestion,
  candidates: readonly EvidencePack['candidates'][number][],
  result: AnalystResult,
  options: ClassifyPrecisionOptions,
): number {
  let misses = 0;
  for (const want of question.expectedEvidence ?? []) {
    const cited = result.citations.some(
      (citation, index) => expectedEvidenceMatches(
        want,
        citation.provenance,
        options.citationCorpusIds?.[index] ??
          resolveCitationCorpusId(
            citation.provenance,
            candidates,
            options.candidateCorpusIds ?? candidates.map((candidate) => provenanceCorpusId(candidate.provenance)),
          ),
      ),
    );
    if (!cited) misses += 1;
  }
  return misses;
}

function candidateText(candidate: EvidencePack['candidates'][number]): string {
  return candidateTextForSearch(candidate);
}

function candidateTextForSearch(candidate: EvidencePack['candidates'][number]): string {
  const citation = candidate.provenance.citation;
  return [
    ...candidate.chunks,
    ...tableText(candidate),
    ...(candidate.facts ?? []).map((fact) => fact.claim),
    citation?.title ?? '',
    citation?.sourceLabel ?? '',
    citation?.uri ?? '',
    citation?.authoredAt ?? '',
    citation?.updatedAt ?? '',
  ]
    .join('\n')
    .toLowerCase();
}

function tableText(candidate: EvidencePack['candidates'][number]): string[] {
  return (candidate.tables ?? []).flatMap((table) => [
    table.caption ?? '',
    table.columns.join(' '),
    ...table.rows.map((row) => row.join(' ')),
  ]);
}

function isAmbiguousExpectedValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^[a-z]$/.test(normalized);
}

const QUESTION_STOPWORDS = new Set([
  'about',
  'across',
  'answer',
  'and',
  'are',
  'cite',
  'details',
  'document',
  'documents',
  'each',
  'for',
  'from',
  'give',
  'into',
  'looking',
  'recorded',
  'source',
  'sources',
  'the',
  'value',
  'values',
  'what',
  'where',
  'which',
  'with',
]);

function substantiveQuestionTerms(question: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of question.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || QUESTION_STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
  }
  return terms;
}

function tokenSet(text: string): Set<string> {
  return new Set(text.match(/[a-z0-9]+/g) ?? []);
}

export function summarizePrecisionTraces(traces: readonly PrecisionTrace[]): {
  byStage: Record<PrecisionStage, number>;
  recommendation: string;
} {
  const byStage: Record<PrecisionStage, number> = {
    ok: 0,
    retrieval_miss: 0,
    ranking_buried: 0,
    expected_evidence_mismatch: 0,
    citation_miss: 0,
    analyst_miss: 0,
    no_expectations: 0,
  };
  for (const trace of traces) byStage[trace.stage] += 1;
  const levers: string[] = [];
  if (byStage.retrieval_miss > 0) levers.push(`${byStage.retrieval_miss} retrieval_miss → recall (embeddings/chunking/extraction)`);
  if (byStage.ranking_buried > 0) levers.push(`${byStage.ranking_buried} ranking_buried → reranking`);
  if (byStage.expected_evidence_mismatch > 0) levers.push(`${byStage.expected_evidence_mismatch} expected_evidence_mismatch → eval/extraction repair`);
  if (byStage.citation_miss > 0) levers.push(`${byStage.citation_miss} citation_miss → citation discipline / expected-evidence repair`);
  if (byStage.analyst_miss > 0) levers.push(`${byStage.analyst_miss} analyst_miss → reasoning (stronger/iterative analyst)`);
  const recommendation = levers.length > 0 ? levers.join('; ') : 'no precision failures to attribute';
  return { byStage, recommendation };
}

// referenced for the optional unused-import guard in some toolchains
export type { EvalGrade };

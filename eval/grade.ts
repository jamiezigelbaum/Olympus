// Grading for the held-out eval. Three dimensions are fully checkable now
// against the Analyst contract; the privacy dimension is graded when the
// analyst surfaces an opsec release audit (Phase 1), otherwise 'pending'.

import type { AnalystResult, EvidenceCandidate, EvidencePack } from '../src/core/contracts.ts';
import type { OpsecReleaseAudit } from '../src/core/opsec.ts';
import type { SourceIndexProvenance, SourceItemIdentity } from '../src/core/source-index/types.ts';
import type { EvalExpectedEvidence, EvalQuestion } from './types.ts';

export interface EvalGrade {
  questionId: string;
  shape: EvalQuestion['shape'];
  answerCorrect: boolean;
  evidenceCited: boolean;
  gapHonest: boolean;
  privacyRespected: boolean | 'pending';
  passed: boolean;
  detail: readonly string[];
}

export interface EvalGradeContext {
  packContainsSecureLocal?: boolean;
  citationCorpusIds?: readonly (string | undefined)[];
  genuineCoverageGapKinds?: readonly GenuineCoverageGapKind[];
}

export interface EvalPackGradeContext extends EvalGradeContext {
  candidateCorpusIds?: readonly (string | undefined)[];
}

export function gradeAnswer(
  question: EvalQuestion,
  result: AnalystResult,
  audit?: OpsecReleaseAudit,
  context: EvalGradeContext = {},
): EvalGrade {
  const detail: string[] = [];

  const answerCorrect = gradeAnswerCorrect(question, result, detail);
  const evidenceCited = gradeEvidenceCited(question, result, detail, context);
  const gapHonest = gradeGapHonest(question, result, detail, context);
  const privacyRespected = gradePrivacy(question, result, audit, detail, context);

  const passed =
    answerCorrect &&
    evidenceCited &&
    gapHonest &&
    (privacyRespected === true || privacyRespected === 'pending');

  return {
    questionId: question.id,
    shape: question.shape,
    answerCorrect,
    evidenceCited,
    gapHonest,
    privacyRespected,
    passed,
    detail,
  };
}

function gradeAnswerCorrect(
  question: EvalQuestion,
  result: AnalystResult,
  detail: string[],
): boolean {
  const expected = question.expectedAnswerContains ?? [];
  if (expected.length === 0) {
    detail.push('answerCorrect: n/a (no expectedAnswerContains set)');
    return true;
  }
  const matches = expected.map((needle) => ({ needle, match: answerContainsExpectedValue(needle, result.answer) }));
  const contradicted = matches.filter(({ match }) => match.contradicted).map(({ needle }) => needle);
  if (contradicted.length > 0) {
    detail.push(`answerCorrect: ${contradicted.length} expected answer value(s) were negated or contradicted`);
    return false;
  }
  const missing = matches.filter(({ match }) => !match.matched).map(({ needle }) => needle);
  if (missing.length > 0) {
    detail.push(`answerCorrect: missing ${missing.length} expected answer value(s)`);
    return false;
  }
  return true;
}

// Numeric and date expectations accept equivalent renderings — source
// documents and model output legitimately differ on locale formatting
// ("16,4" vs "16.4"; "22/04/2025" vs "2025-04-22"); the value is what matters.
// Equivalence is deliberately conservative: a value only counts when it appears
// as a token-bounded form and its immediate context does not negate/refute it.
export function acceptableForms(needle: string): string[] {
  const base = needle.toLowerCase();
  const dates = dateForms(base);
  if (dates.length > 0) return [base, ...dates];
  if (!/^[\d.,]+$/.test(base)) return [base];
  const swapped = base.replace(/[.,]/g, (mark) => (mark === ',' ? '.' : ','));
  return swapped !== base && numericLocaleSwapIsSafe(base, swapped) ? [base, swapped] : [base];
}

function dateForms(base: string): string[] {
  const match = /^(\d{1,4})([./-])(\d{1,2})\2(\d{1,4})$/.exec(base);
  if (!match) return [];
  const [, first, , second, third] = match as unknown as [string, string, string, string, string];
  let year: string, month: string, day: string, order: 'ymd' | 'dmy' | 'mdy';
  if (first.length === 4) {
    [year, month, day] = [first, second, third];
    order = 'ymd';
  } else if (third.length === 4) {
    const firstNumber = Number(first);
    const secondNumber = Number(second);
    if (firstNumber > 12) {
      [year, month, day] = [third, second, first];
      order = 'dmy';
    } else if (secondNumber > 12) {
      [year, month, day] = [third, first, second];
      order = 'mdy';
    } else {
      return [];
    }
  } else {
    return [];
  }
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return [];
  const pad = (value: string) => value.padStart(2, '0');
  const [yyyy, mm, dd] = [year, pad(month), pad(day)];
  const m = String(Number(month));
  const d = String(Number(day));
  const forms = [`${yyyy}-${mm}-${dd}`];
  if (order === 'ymd') {
    if (dayNumber > 12) {
      forms.push(`${dd}/${mm}/${yyyy}`, `${d}/${m}/${yyyy}`, `${dd}.${mm}.${yyyy}`, `${dd}-${mm}-${yyyy}`);
    }
    return forms;
  }
  if (order === 'dmy') {
    forms.push(`${dd}/${mm}/${yyyy}`, `${d}/${m}/${yyyy}`, `${dd}.${mm}.${yyyy}`, `${dd}-${mm}-${yyyy}`);
  } else {
    forms.push(`${mm}/${dd}/${yyyy}`, `${m}/${d}/${yyyy}`, `${mm}.${dd}.${yyyy}`, `${mm}-${dd}-${yyyy}`);
  }
  return forms;
}

interface ExpectedValueMatch {
  matched: boolean;
  contradicted: boolean;
}

export function answerContainsExpectedValue(needle: string, answer: string): ExpectedValueMatch {
  const haystack = answer.toLowerCase();
  let contradicted = false;
  for (const form of acceptableForms(needle)) {
    for (const index of tokenBoundedIndexes(haystack, form)) {
      if (isContradictedMatch(haystack, index, form.length)) {
        contradicted = true;
        continue;
      }
      return { matched: true, contradicted: false };
    }
  }
  return { matched: false, contradicted };
}

function numericLocaleSwapIsSafe(base: string, swapped: string): boolean {
  if (isAmbiguousSingleSeparatorNumber(base) || isAmbiguousSingleSeparatorNumber(swapped)) {
    return false;
  }
  const baseMagnitude = parseConservativeNumber(base);
  const swappedMagnitude = parseConservativeNumber(swapped);
  return baseMagnitude !== undefined &&
    swappedMagnitude !== undefined &&
    Math.abs(baseMagnitude - swappedMagnitude) < Number.EPSILON;
}

function isAmbiguousSingleSeparatorNumber(value: string): boolean {
  const match = /^(\d{1,3})([.,])(\d{3})$/.exec(value);
  return match !== null && Number(match[1]) !== 0;
}

function parseConservativeNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  const lastComma = value.lastIndexOf(',');
  const lastDot = value.lastIndexOf('.');
  const decimalMark = lastComma > lastDot ? ',' : '.';
  const thousandsMark = decimalMark === ',' ? '.' : ',';
  const decimalIndex = Math.max(lastComma, lastDot);
  const fraction = value.slice(decimalIndex + 1);
  const whole = value.slice(0, decimalIndex);
  const hasBothMarks = value.includes(',') && value.includes('.');
  const singleSeparator = !hasBothMarks;
  if (singleSeparator && fraction.length === 3 && Number(whole) !== 0) return undefined;
  if (hasBothMarks) {
    const groups = whole.split(thousandsMark);
    if (groups.length < 2 || groups.slice(1).some((group) => group.length !== 3)) return undefined;
  }
  const normalized = value.split(thousandsMark).join('').replace(decimalMark, '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tokenBoundedIndexes(haystack: string, needle: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= haystack.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    if (
      isTokenBoundary(haystack[index - 1])
      && isTokenBoundary(haystack[index + needle.length])
      && !isNumericContinuation(haystack, index, needle)
    ) {
      indexes.push(index);
    }
    offset = index + Math.max(1, needle.length);
  }
  return indexes;
}

function isTokenBoundary(char: string | undefined): boolean {
  return char === undefined || !/[a-z0-9]/.test(char);
}

// `.` and `,` are token boundaries, so a bare numeric expectation would
// otherwise be satisfied by a numerically different value that merely starts
// (or ends) with it — '612' by '612.5' or by '1,612'. The one continuation that
// preserves the value is an all-zero fractional tail ('1,234' vs '1,234.00');
// a three-digit zero run stays rejected because it is indistinguishable from a
// thousands group under the locale ambiguity this module already refuses.
function isNumericContinuation(haystack: string, index: number, needle: string): boolean {
  if (/^\d/.test(needle) && /\d[.,]$/.test(haystack.slice(Math.max(0, index - 2), index))) {
    return true;
  }
  if (!/\d$/.test(needle)) return false;
  const after = haystack.slice(index + needle.length);
  if (!/^[.,]\d/.test(after)) return false;
  const zeroTail = /^[.,](0+)(?!\d)/.exec(after);
  return zeroTail === null || zeroTail[1]!.length === 3;
}

function isContradictedMatch(haystack: string, index: number, length: number): boolean {
  const before = haystack.slice(Math.max(0, index - 48), index);
  const after = haystack.slice(index + length, Math.min(haystack.length, index + length + 72));
  if (/(?:^|[^a-z])(?:not|never|no|wasn['’]?t|isn['’]?t|aren['’]?t|weren['’]?t|is not|was not|not actually)\s+(?:the\s+)?(?:value\s+)?(?:was\s+)?$/.test(before)) {
    return true;
  }
  if (/^\s+(?:is|was|were|are)?\s*(?:incorrect|wrong|false|not correct|not the value)\b/.test(after)) {
    return true;
  }
  if (!isDateLikeForm(haystack.slice(index, index + length))) {
    const expectedNumber = firstNumericValue(haystack.slice(index, index + length));
    const actualMatch = /\b(?:actual|correct|real)\s+value\s+was\s+([-+]?\d[\d.,]*)/.exec(after);
    const actualNumber = actualMatch?.[1] ? parseConservativeNumber(actualMatch[1]) : undefined;
    if (expectedNumber !== undefined && actualNumber !== undefined && expectedNumber !== actualNumber) {
      return true;
    }
  }
  return false;
}

function isDateLikeForm(value: string): boolean {
  return /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(value) ||
    /^\d{1,2}[./-]\d{1,2}[./-]\d{4}$/.test(value);
}

function firstNumericValue(value: string): number | undefined {
  const match = /[-+]?\d[\d.,]*/.exec(value);
  return match ? parseConservativeNumber(match[0]) : undefined;
}

function gradeEvidenceCited(
  question: EvalQuestion,
  result: AnalystResult,
  detail: string[],
  context: EvalGradeContext,
): boolean {
  const expected = question.expectedEvidence ?? [];
  if (expected.length === 0) {
    detail.push('evidenceCited: n/a (no expectedEvidence set)');
    return true;
  }
  for (const want of expected) {
    const matched = result.citations.some((citation, citationIndex) =>
      expectedEvidenceMatches(
        want,
        citation.provenance,
        context.citationCorpusIds?.[citationIndex],
      ),
    );
    if (!matched) {
      detail.push(`evidenceCited: no citation for expected evidence item ${expected.indexOf(want) + 1}`);
      return false;
    }
  }
  return true;
}

function gradeGapHonest(
  question: EvalQuestion,
  result: AnalystResult,
  detail: string[],
  context: EvalGradeContext,
): boolean {
  if (!question.mustReportGap) return true;
  if ((context.genuineCoverageGapKinds?.length ?? 0) === 0) {
    detail.push('gapHonest: no genuine structured coverage degradation supported the reported gap');
    return false;
  }
  const meaningfulGaps = result.unanswered.filter(isMeaningfulGapText);
  if (meaningfulGaps.length === 0) {
    detail.push('gapHonest: expected a meaningful reported gap, but unanswered was empty or placeholder-only');
    return false;
  }
  const expectedTopics = expectedGapTopics(question);
  if (
    expectedTopics.length > 0 &&
    !meaningfulGaps.some((gap) => expectedTopics.some((topic) => gap.toLowerCase().includes(topic)))
  ) {
    detail.push('gapHonest: reported gap did not address the expected gap topic');
    return false;
  }
  return true;
}

function isMeaningfulGapText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 4) return false;
  if (/^(?:n\/a|na|none|null|unknown|placeholder|todo|tbd|-+|\?+)$/.test(normalized)) return false;
  return /[a-z0-9]/.test(normalized);
}

function expectedGapTopics(question: EvalQuestion): string[] {
  const text = [question.notes ?? '', question.question].join(' ').toLowerCase();
  const topics: string[] = [];
  if (/\b(?:ocr|scan|scanned|pdf|image|media|extract|extraction|unextractable|read)\b/.test(text)) {
    topics.push('ocr', 'scan', 'scanned', 'pdf', 'image', 'media', 'extract', 'extraction', 'read', 'metadata-only');
  }
  if (/\b(?:source|corpus|coverage|searched)\b/.test(text)) {
    topics.push('source', 'corpus', 'coverage', 'searched');
  }
  return [...new Set(topics)];
}

function gradePrivacy(
  question: EvalQuestion,
  result: AnalystResult,
  audit: OpsecReleaseAudit | undefined,
  detail: string[],
  context: EvalGradeContext,
): boolean | 'pending' {
  const packContainsSecureLocal = context.packContainsSecureLocal === true;
  if (!audit) {
    if (question.maxTrustDomain === 'secure_local' || packContainsSecureLocal || result.escalation) {
      detail.push('privacyRespected: fail (secure-local or escalation result requires an opsec audit)');
      return false;
    }
    detail.push('privacyRespected: pending (analyst did not surface an opsec audit)');
    return 'pending';
  }
  if (audit.raw_source_exposed !== false) {
    detail.push('privacyRespected: opsec audit reported raw source exposure');
    return false;
  }
  if (result.escalation && audit.release_decision.decision === 'deny') {
    detail.push('privacyRespected: escalation proposed but release was denied');
    return false;
  }
  const isReleasedDecision =
    audit.release_decision.decision === 'allow' ||
    audit.release_decision.decision === 'redact';
  const hasVisibleOutput =
    result.answer.trim().length > 0 ||
    result.citations.length > 0 ||
    result.unanswered.length > 0;
  const isCanonicalWithholdingOnly =
    result.citations.length === 0 &&
    result.unanswered.length === 0 &&
    isCanonicalWithholdingAnswer(result.answer);
  if (!isReleasedDecision && hasVisibleOutput && !isCanonicalWithholdingOnly) {
    detail.push('privacyRespected: visible answer, citations, or gaps present despite non-release decision');
    return false;
  }
  const citesSecureLocal = context.citationCorpusIds?.some((corpusId) => corpusId?.startsWith('secure_local.')) === true;
  const releasedSecureLocalContent =
    (question.maxTrustDomain === 'secure_local' || packContainsSecureLocal || citesSecureLocal) &&
    isReleasedDecision &&
    hasVisibleOutput &&
    !isSafeUnsupportedNoContentRelease(result, audit);
  if (releasedSecureLocalContent) {
    const hasSecureLocalCastorFact = audit.structured_evidence.some(
      (fact) =>
        fact.trust_domain === 'secure_local' &&
        fact.release_surface === 'castor_answer',
    );
    if (!hasSecureLocalCastorFact) {
      detail.push('privacyRespected: secure-local answer released without secure-local structured evidence');
      return false;
    }
  }
  return true;
}

function isCanonicalWithholdingAnswer(answer: string): boolean {
  const normalized = answer.trim();
  return normalized === 'I found matching source material, but this needs review before I can summarize it in this calling-assistant-safe path.'
    || normalized === 'I found matching source material, but it cannot be summarized in this calling-assistant-safe path.';
}

function isSafeUnsupportedNoContentRelease(result: AnalystResult, audit: OpsecReleaseAudit): boolean {
  if (result.citations.length > 0) return false;
  if (
    !audit.release_decision.reasons.includes('unsupported_answer_released_without_source_content') &&
    !audit.release_decision.reasons.includes('analyst_insufficient_no_source_content')
  ) {
    return false;
  }
  const text = [result.answer, ...result.unanswered].join(' ').toLowerCase();
  return (
    text.includes('could not extract a cited bounded answer') ||
    text.includes('could not read') ||
    text.includes('no matching source content was released')
  );
}

export function expectedEvidenceMatches(
  want: EvalExpectedEvidence,
  provenance: SourceIndexProvenance,
  corpusId: string | undefined,
): boolean {
  if (want.providerItemId && provenance.sourceItem.providerItemId !== want.providerItemId) {
    return false;
  }
  if (want.uri !== undefined && provenance.citation?.uri !== want.uri) return false;
  const wantCorpusId = want.corpusId.trim();
  if (wantCorpusId && corpusId !== wantCorpusId) return false;
  return true;
}

export type GenuineCoverageGapKind =
  | 'provider_window_or_cap'
  | 'adapter_absence'
  | 'lane_failure_or_timeout'
  | 'extraction_gap'
  | 'zero_evidence';

/**
 * Qualifying gaps must be evidence about what the pipeline could not cover.
 * Mechanical selection policy (for example `not_requested`) is never such
 * evidence and cannot make a coverage-negative answer pass.
 */
export function genuineCoverageGapKinds(pack: EvidencePack): GenuineCoverageGapKind[] {
  const kinds = new Set<GenuineCoverageGapKind>();
  if (pack.coverage.extractionGaps.some((gap) => gap.trim().length > 0)) {
    kinds.add('extraction_gap');
  }
  for (const skipped of pack.coverage.skippedCorpora) {
    const reason = skipped.reason.trim().toLowerCase();
    if (
      reason.includes('provider_window')
      || reason.includes('provider_cap')
      || reason.includes('window_exhausted')
    ) {
      kinds.add('provider_window_or_cap');
    } else if (
      reason === 'no_adapter'
      || reason.includes('adapter_absent')
      || reason.includes('adapter_unavailable')
    ) {
      kinds.add('adapter_absence');
    } else if (
      reason.includes('lane_failure')
      || reason.includes('lane_failed')
      || reason.includes('lane_timeout')
    ) {
      kinds.add('lane_failure_or_timeout');
    }
  }
  // Zero evidence is genuine whenever at least one corpus was actually
  // searched and returned nothing. Mechanical selection skips of OTHER
  // corpora (`not_requested` under a unified registry) say nothing about
  // the searched corpora and must not veto the gap: a single-corpus
  // request on the full-registry surface always skips every other corpus
  // mechanically, which made coverage-negative honesty structurally
  // ungradable there (live, 2026-07-25). An answer empty ONLY because
  // everything was mechanically skipped still fails the searched-corpora
  // requirement above.
  if (
    pack.candidates.length === 0
    && pack.coverage.searchedCorpora.length > 0
  ) {
    kinds.add('zero_evidence');
  }
  return [...kinds].sort();
}

export function isMechanicalSelectionReason(value: string): boolean {
  const reason = value.trim().toLowerCase();
  return reason === 'not_requested'
    || reason === 'not_selected'
    || reason === 'trust_domain_not_allowed'
    || reason === 'corpus_not_allowed'
    || reason === 'policy_filtered'
    || reason === 'disabled';
}

export function provenanceCorpusId(provenance: SourceIndexProvenance): string | undefined {
  return provenance.localIds?.corpus_id
    ?? provenance.localIds?.corpusId
    ?? provenance.providerIds?.corpus_id
    ?? provenance.providerIds?.corpusId;
}

export function resolveCitationCorpusId(
  provenance: SourceIndexProvenance,
  candidates: readonly EvidenceCandidate[],
  candidateCorpusIds: readonly (string | undefined)[],
): string | undefined {
  const direct = provenanceCorpusId(provenance);
  if (direct) return direct;

  const identicalIndex = candidates.findIndex((candidate) => candidate.provenance === provenance);
  if (identicalIndex >= 0) return candidateCorpusIds[identicalIndex];

  const matchedCorpusIds = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    if (!sourceItemsMatch(candidate.provenance.sourceItem, provenance.sourceItem)) continue;
    const corpusId = candidateCorpusIds[index] ?? provenanceCorpusId(candidate.provenance);
    if (corpusId) matchedCorpusIds.add(corpusId);
  }
  return matchedCorpusIds.size === 1 ? [...matchedCorpusIds][0] : undefined;
}

function sourceItemsMatch(left: SourceItemIdentity, right: SourceItemIdentity): boolean {
  return left.family === right.family
    && left.provider === right.provider
    && left.accountScope === right.accountScope
    && left.providerItemId === right.providerItemId
    && left.providerThreadId === right.providerThreadId
    && left.providerConversationId === right.providerConversationId
    && left.providerFileId === right.providerFileId
    && left.providerEventId === right.providerEventId
    && left.localItemId === right.localItemId
    && left.sourceVersion === right.sourceVersion;
}

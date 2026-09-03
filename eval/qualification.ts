import { createHash } from 'node:crypto';
import type {
  Analyst,
  AnalystResult,
  EvidenceCandidate,
  EvidencePack,
} from '../src/core/contracts.ts';
import type {
  SourceIndexAnswerEvidence,
  SourceIndexAnswerHandler,
  SourceIndexAnswerRequest,
  SourceIndexAnswerResult,
} from '../src/workers/source-index/answer-types.ts';
import {
  SOURCE_FAMILIES,
  type SourceFamily,
  type SourceIndexProvenance,
} from '../src/core/source-index/types.ts';
import { runEval, type EvalReport } from './run.ts';
import type { EvalDataset, EvalQuestion } from './types.ts';

export const QUALIFICATION_MIN_LEGACY_RECALL = 0.8;
export const QUALIFICATION_MAX_COUNT_DRIFT_RATIO = 0.1;

export type QualificationAuthority =
  | 'connector_store_loopback'
  | 'authenticated_source_answer';

export interface SourceAnswerEvalObservation {
  result: SourceIndexAnswerResult;
  /**
   * Optional structured coverage known by the adapter but not present on the
   * Castor wire result. This remains source-generic and content-free.
   */
  coverage?: {
    searchedCorpora?: readonly string[];
    skippedCorpora?: readonly { corpusId: string; reason: string }[];
    extractionGaps?: readonly string[];
  };
}

export interface SourceAnswerEvalAdapter {
  authority: QualificationAuthority;
  answer(question: EvalQuestion): Promise<SourceAnswerEvalObservation>;
}

export interface QualificationLegacyObservation {
  /** One-based ordinal in EvalDataset.questions; private question ids stay out of receipts. */
  questionOrdinal: number;
  answered: boolean;
  citationIds: readonly string[];
}

export interface SourceQualificationRun {
  authority: QualificationAuthority;
  report: EvalReport;
  comparisons: readonly QualificationComparisonResult[];
}

export interface QualificationComparisonResult {
  questionOrdinal: number;
  legacyCitationRecall: number;
  countDriftRatio: number;
  connectorAnswered: boolean;
  passed: boolean;
}

export interface RunSourceQualificationOptions {
  adapter: SourceAnswerEvalAdapter;
  legacyObservations?: readonly QualificationLegacyObservation[];
  questionTimeoutMs?: number;
  minLegacyRecall?: number;
  maxCountDriftRatio?: number;
}

export async function runSourceQualificationEval(
  dataset: EvalDataset,
  options: RunSourceQualificationOptions,
): Promise<SourceQualificationRun> {
  const outcomes = new WeakMap<EvidencePack, {
    result: AnalystResult;
    wire: SourceIndexAnswerResult;
  }>();
  const wireByOrdinal = new Map<number, SourceIndexAnswerResult>();
  let nextOrdinal = 0;
  const passthroughAnalyst: Analyst = {
    async analyze(pack) {
      const outcome = outcomes.get(pack);
      if (!outcome) throw new Error('Qualification adapter result was not bound to its EvidencePack.');
      return outcome.result;
    },
  };

  const report = await runEval(dataset, {
    ...(options.questionTimeoutMs !== undefined
      ? { questionTimeoutMs: options.questionTimeoutMs }
      : {}),
    continueOnQuestionError: true,
    async buildPack(question) {
      const ordinal = dataset.questions.indexOf(question) + 1 || ++nextOrdinal;
      const observation = await options.adapter.answer(question);
      assertSourceIndexAnswerResult(observation.result);
      const pack = packFromSourceAnswer(question, observation);
      const result = analystResultFromSourceAnswer(observation.result);
      outcomes.set(pack, { result, wire: observation.result });
      wireByOrdinal.set(ordinal, observation.result);
      return pack;
    },
    analyst: passthroughAnalyst,
    releaseFor(pack) {
      const outcome = outcomes.get(pack);
      if (!outcome) return undefined;
      return { result: outcome.result, audit: outcome.wire.opsec };
    },
  });

  const minLegacyRecall = options.minLegacyRecall ?? QUALIFICATION_MIN_LEGACY_RECALL;
  const maxCountDriftRatio = options.maxCountDriftRatio ?? QUALIFICATION_MAX_COUNT_DRIFT_RATIO;
  requireUnitInterval(minLegacyRecall, 'minimum legacy citation recall');
  requireUnitInterval(maxCountDriftRatio, 'maximum citation count drift ratio');
  const comparisons = (options.legacyObservations ?? []).map((legacy) => {
    if (
      !Number.isSafeInteger(legacy.questionOrdinal)
      || legacy.questionOrdinal < 1
      || legacy.questionOrdinal > dataset.questions.length
    ) {
      throw new Error('Qualification legacy observation has an invalid question ordinal.');
    }
    const connector = wireByOrdinal.get(legacy.questionOrdinal);
    const connectorCitationIds = connector?.evidence.map((item) => item.provider_item_id) ?? [];
    const recall = legacyCitationRecall(legacy.citationIds, connectorCitationIds);
    const drift = citationCountDriftRatio(legacy.citationIds, connectorCitationIds);
    const connectorAnswered = Boolean(connector?.answer.trim());
    return {
      questionOrdinal: legacy.questionOrdinal,
      legacyCitationRecall: finiteMetric(recall),
      countDriftRatio: finiteMetric(drift),
      connectorAnswered,
      passed:
        connectorAnswered
        && recall >= minLegacyRecall
        && drift <= maxCountDriftRatio,
    };
  });

  return {
    authority: options.adapter.authority,
    report,
    comparisons,
  };
}

export function createInProcessSourceAnswerEvalAdapter(options: {
  handler: SourceIndexAnswerHandler;
  requestForQuestion: (question: EvalQuestion) => SourceIndexAnswerRequest;
  coverageForResult?: (
    question: EvalQuestion,
    result: SourceIndexAnswerResult,
  ) => SourceAnswerEvalObservation['coverage'];
}): SourceAnswerEvalAdapter {
  return {
    authority: 'connector_store_loopback',
    async answer(question) {
      const result = await options.handler.answer(options.requestForQuestion(question));
      const coverage = options.coverageForResult?.(question, result);
      return { result, ...(coverage ? { coverage } : {}) };
    },
  };
}

export function createAuthenticatedSourceAnswerEvalAdapter(options: {
  endpoint: string;
  authorization: string;
  requestForQuestion: (question: EvalQuestion) => SourceIndexAnswerRequest;
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}): SourceAnswerEvalAdapter {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('Qualification source-answer endpoint must use HTTP or HTTPS.');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return {
    authority: 'authenticated_source_answer',
    async answer(question) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: options.authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(options.requestForQuestion(question)),
      });
      if (!response.ok) {
        throw new Error(`Qualification source-answer endpoint returned HTTP ${response.status}.`);
      }
      const result = await response.json() as SourceIndexAnswerResult;
      assertSourceIndexAnswerResult(result);
      return { result };
    },
  };
}

export function legacyCitationRecall(
  legacyCitationIds: readonly string[],
  connectorCitationIds: readonly string[],
): number {
  const expected = new Set(legacyCitationIds.map(sha256));
  if (expected.size === 0) return 1;
  const actual = new Set(connectorCitationIds.map(sha256));
  return [...expected].filter((value) => actual.has(value)).length / Math.max(1, expected.size);
}

export function citationCountDriftRatio(
  legacyCitationIds: readonly string[],
  connectorCitationIds: readonly string[],
): number {
  return Math.abs(connectorCitationIds.length - legacyCitationIds.length)
    / Math.max(1, legacyCitationIds.length);
}

export interface SourceQualificationReceiptBindings {
  source: string;
  gitSha: string;
  sourceWorkerPid: number;
  sourceWorkerCwdSha256: string;
  storeSha256: string;
  storeSchemaVersion: number;
  preservationReceiptSha256: string;
  reconcileReceiptSha256: string;
  /** Whole-manifest binding (emits version 1). Mutually exclusive with the projection. */
  manifestSha256?: string;
  /** Source-critical manifest-projection binding (emits version 2). */
  manifestXProjectionSha256?: string;
  dropinSha256: string;
  authorityBefore: 'legacy_index' | 'connector_store';
  authorityAfter: 'legacy_index' | 'connector_store';
  evaluatedAt: string;
  expiresAt: string;
}

interface SourceQualificationEvalReceiptCommon {
  kind: 'source_qualification_eval_receipt';
  source: string;
  status: 'green' | 'red';
  evaluated_at: string;
  expires_at: string;
  authority: {
    eval_surface: QualificationAuthority;
    before: 'legacy_index' | 'connector_store';
    after: 'legacy_index' | 'connector_store';
  };
  checks: {
    questions: number;
    positive_cases: number;
    coverage_gap_cases: number;
    exact_citation_cases: number;
    legacy_comparison_cases: number;
    ordinary_under_60s_cases: number;
    required_set_present: boolean;
  };
  evaluation: {
    passed: number;
    failed: number;
    legacy_min_recall: number;
    max_count_drift_ratio: number;
    comparisons_passed: boolean;
    question_results: readonly {
      ordinal: number;
      passed: boolean;
      answer_correct: boolean;
      evidence_cited: boolean;
      gap_honest: boolean;
      privacy_respected: boolean | 'pending';
      duration_ms: number;
      status: 'passed' | 'failed' | 'error' | 'timeout';
      failure_hashes: readonly string[];
    }[];
  };
  report_sha256: string;
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    resource_ids_exposed: false;
    source_paths_exposed: false;
    questions_exposed: false;
    expectations_exposed: false;
  };
  receipt_sha256: string;
}

interface SourceQualificationReceiptSharedBindings {
  git_sha: string;
  source_worker_pid: number;
  source_worker_cwd_sha256: string;
  store_sha256: string;
  store_schema_version: number;
  preservation_receipt_sha256: string;
  reconcile_receipt_sha256: string;
}

/** The original binding: the WHOLE host manifest file. */
export interface SourceQualificationEvalReceiptV1 extends SourceQualificationEvalReceiptCommon {
  version: 1;
  bindings: SourceQualificationReceiptSharedBindings & {
    manifest_sha256: string;
    dropin_sha256: string;
  };
}

/**
 * Version 2 replaces the whole-file manifest binding with the manifest's
 * source-critical projection, exactly as the X activation receipt's v3 did:
 * an unrelated family's host enablement can no longer invalidate a receipt
 * whose subject never depended on that key. The emitter chooses the
 * projection; the verifier accepts either, so receipts banked under v1 keep
 * verifying against the whole-file digest.
 */
export interface SourceQualificationEvalReceiptV2 extends SourceQualificationEvalReceiptCommon {
  version: 2;
  bindings: SourceQualificationReceiptSharedBindings & {
    manifest_x_projection_sha256: string;
    dropin_sha256: string;
  };
}

export type SourceQualificationEvalReceipt =
  | SourceQualificationEvalReceiptV1
  | SourceQualificationEvalReceiptV2;

const CONTENT_FREE_QUALIFICATION_POLICY = {
  counts_only: true as const,
  raw_source_exposed: false as const,
  source_text_returned: false as const,
  resource_ids_exposed: false as const,
  source_paths_exposed: false as const,
  questions_exposed: false as const,
  expectations_exposed: false as const,
};

export function buildSourceQualificationEvalReceipt(
  dataset: EvalDataset,
  run: SourceQualificationRun,
  bindings: SourceQualificationReceiptBindings,
): SourceQualificationEvalReceipt {
  assertReceiptBindings(bindings);
  const positiveCases = dataset.questions.filter((question) =>
    question.mustReportGap !== true
    && (
      (question.expectedAnswerContains?.length ?? 0) > 0
      || (question.expectedEvidence?.length ?? 0) > 0
    )).length;
  const coverageGapCases = dataset.questions.filter((question) => question.mustReportGap === true).length;
  const exactCitationCases = dataset.questions.filter((question) =>
    question.expectedEvidence?.some((expected) => expected.uri !== undefined)).length;
  const ordinaryUnder60sCases = dataset.questions.filter((question) =>
    question.maxDurationMs !== undefined
    && question.maxDurationMs <= 60_000
    && question.expectedEvidence?.some((expected) => expected.uri !== undefined)).length;
  const requiredSetPresent =
    positiveCases >= 1
    && coverageGapCases >= 1
    && exactCitationCases >= 1
    && run.comparisons.length >= 1
    && ordinaryUnder60sCases >= 1;
  const questionResults = run.report.grades.map((grade, index) => {
    const timing = run.report.timings[index];
    return {
      ordinal: index + 1,
      passed: grade.passed,
      answer_correct: grade.answerCorrect,
      evidence_cited: grade.evidenceCited,
      gap_honest: grade.gapHonest,
      privacy_respected: grade.privacyRespected,
      duration_ms: Math.max(0, Math.round(timing?.durationMs ?? 0)),
      status: timing?.status ?? (grade.passed ? 'passed' : 'failed'),
      failure_hashes: grade.passed
        ? []
        : grade.detail
          .filter((detail) => !detail.includes(': n/a'))
          .slice(0, 4)
          .map(sha256),
    };
  });
  const comparisonsPassed =
    run.comparisons.length > 0
    && run.comparisons.every((comparison) => comparison.passed);
  const legacyMinRecall = run.comparisons.length > 0
    ? Math.min(...run.comparisons.map((comparison) => comparison.legacyCitationRecall))
    : -1;
  const maxCountDriftRatio = run.comparisons.length > 0
    ? Math.max(...run.comparisons.map((comparison) => comparison.countDriftRatio))
    : -1;
  const report = {
    checks: {
      questions: dataset.questions.length,
      positive_cases: positiveCases,
      coverage_gap_cases: coverageGapCases,
      exact_citation_cases: exactCitationCases,
      legacy_comparison_cases: run.comparisons.length,
      ordinary_under_60s_cases: ordinaryUnder60sCases,
      required_set_present: requiredSetPresent,
    },
    evaluation: {
      passed: run.report.passed,
      failed: run.report.failed,
      legacy_min_recall: finiteMetric(legacyMinRecall),
      max_count_drift_ratio: finiteMetric(maxCountDriftRatio),
      comparisons_passed: comparisonsPassed,
      question_results: questionResults,
    },
  };
  const reportSha256 = sha256(JSON.stringify(report));
  const head = {
    source: bindings.source,
    status:
      run.report.failed === 0 && comparisonsPassed && requiredSetPresent
        ? 'green' as const
        : 'red' as const,
    evaluated_at: new Date(bindings.evaluatedAt).toISOString(),
    expires_at: new Date(bindings.expiresAt).toISOString(),
    authority: {
      eval_surface: run.authority,
      before: bindings.authorityBefore,
      after: bindings.authorityAfter,
    },
  };
  const sharedBindings: SourceQualificationReceiptSharedBindings = {
    git_sha: bindings.gitSha,
    source_worker_pid: bindings.sourceWorkerPid,
    source_worker_cwd_sha256: bindings.sourceWorkerCwdSha256,
    store_sha256: bindings.storeSha256,
    store_schema_version: bindings.storeSchemaVersion,
    preservation_receipt_sha256: bindings.preservationReceiptSha256,
    reconcile_receipt_sha256: bindings.reconcileReceiptSha256,
  };
  const tail = {
    ...report,
    report_sha256: reportSha256,
    policy: CONTENT_FREE_QUALIFICATION_POLICY,
  };
  // Key order is the wire format: receipt_sha256 signs JSON.stringify of
  // everything above it, so the projection digest occupies exactly the slot
  // the whole-file digest held.
  if (bindings.manifestXProjectionSha256 !== undefined) {
    const draft = {
      kind: 'source_qualification_eval_receipt' as const,
      version: 2 as const,
      ...head,
      bindings: {
        ...sharedBindings,
        manifest_x_projection_sha256: bindings.manifestXProjectionSha256,
        dropin_sha256: bindings.dropinSha256,
      },
      ...tail,
    };
    return { ...draft, receipt_sha256: sha256(JSON.stringify(draft)) };
  }
  const draft = {
    kind: 'source_qualification_eval_receipt' as const,
    version: 1 as const,
    ...head,
    bindings: {
      ...sharedBindings,
      manifest_sha256: bindings.manifestSha256 as string,
      dropin_sha256: bindings.dropinSha256,
    },
    ...tail,
  };
  return { ...draft, receipt_sha256: sha256(JSON.stringify(draft)) };
}

export interface SourceQualificationReceiptExpectation {
  source: string;
  evalSurface: QualificationAuthority;
  gitSha: string;
  sourceWorkerPid: number;
  sourceWorkerCwdSha256: string;
  storeSha256: string;
  storeSchemaVersion: number;
  preservationReceiptSha256: string;
  reconcileReceiptSha256: string;
  /**
   * Supply the digest each banked receipt version needs. A verifier that holds
   * both accepts a v1 receipt against the whole-file digest and a v2 receipt
   * against the projection; a receipt whose digest was not supplied is
   * refused rather than skipped.
   */
  manifestSha256?: string;
  manifestXProjectionSha256?: string;
  dropinSha256: string;
  authorityBefore: 'legacy_index' | 'connector_store';
  authorityAfter: 'legacy_index' | 'connector_store';
  asOf: string;
}

export function verifySourceQualificationEvalReceipt(
  receipt: SourceQualificationEvalReceipt,
  expected: SourceQualificationReceiptExpectation,
): void {
  if (
    receipt.kind !== 'source_qualification_eval_receipt'
    || (receipt.version !== 1 && receipt.version !== 2)
    || receipt.source !== expected.source
    || receipt.status !== 'green'
    || receipt.checks?.required_set_present !== true
    || receipt.evaluation?.failed !== 0
    || receipt.evaluation?.comparisons_passed !== true
  ) {
    throw new Error('Source qualification eval receipt is not green and complete.');
  }
  const evaluatedAt = Date.parse(receipt.evaluated_at);
  const expiresAt = Date.parse(receipt.expires_at);
  const asOf = Date.parse(expected.asOf);
  if (
    !Number.isFinite(evaluatedAt)
    || !Number.isFinite(expiresAt)
    || !Number.isFinite(asOf)
    || evaluatedAt > asOf + 30_000
    || expiresAt <= asOf
  ) {
    throw new Error('Source qualification eval receipt is stale or has invalid timestamps.');
  }
  const manifestMatches = receipt.version === 2
    ? expected.manifestXProjectionSha256 !== undefined
      && receipt.bindings.manifest_x_projection_sha256 === expected.manifestXProjectionSha256
    : expected.manifestSha256 !== undefined
      && receipt.bindings.manifest_sha256 === expected.manifestSha256;
  const bindingsMatch =
    receipt.bindings.git_sha === expected.gitSha
    && receipt.bindings.source_worker_pid === expected.sourceWorkerPid
    && receipt.bindings.source_worker_cwd_sha256 === expected.sourceWorkerCwdSha256
    && receipt.bindings.store_sha256 === expected.storeSha256
    && receipt.bindings.store_schema_version === expected.storeSchemaVersion
    && receipt.bindings.preservation_receipt_sha256 === expected.preservationReceiptSha256
    && receipt.bindings.reconcile_receipt_sha256 === expected.reconcileReceiptSha256
    && manifestMatches
    && receipt.bindings.dropin_sha256 === expected.dropinSha256
    && receipt.authority.eval_surface === expected.evalSurface
    && receipt.authority.before === expected.authorityBefore
    && receipt.authority.after === expected.authorityAfter;
  if (!bindingsMatch) throw new Error('Source qualification eval receipt binding mismatch.');
  const report = { checks: receipt.checks, evaluation: receipt.evaluation };
  if (receipt.report_sha256 !== sha256(JSON.stringify(report))) {
    throw new Error('Source qualification eval report digest mismatch.');
  }
  const { receipt_sha256: digest, ...unsigned } = receipt;
  if (digest !== sha256(JSON.stringify(unsigned))) {
    throw new Error('Source qualification eval receipt self-digest mismatch.');
  }
  if (JSON.stringify(receipt.policy) !== JSON.stringify(CONTENT_FREE_QUALIFICATION_POLICY)) {
    throw new Error('Source qualification eval receipt is not content-free.');
  }
}

export async function runProvisionalQualificationContract(options: {
  flipToConnectorStore(): Promise<void>;
  runPostFlipEval(): Promise<SourceQualificationEvalReceipt>;
  rollbackToLegacy(): Promise<void>;
  readAuthority(): Promise<'legacy_index' | 'connector_store'>;
}): Promise<SourceQualificationEvalReceipt> {
  await options.flipToConnectorStore();
  try {
    const receipt = await options.runPostFlipEval();
    if (receipt.status !== 'green') throw new Error('Provisional source qualification eval was red.');
    return receipt;
  } catch (error) {
    await options.rollbackToLegacy();
    if (await options.readAuthority() !== 'legacy_index') {
      throw new Error('Provisional source qualification rollback did not restore legacy read authority.', {
        cause: error,
      });
    }
    throw error;
  }
}

function packFromSourceAnswer(
  question: EvalQuestion,
  observation: SourceAnswerEvalObservation,
): EvidencePack {
  const result = observation.result;
  const candidates = result.evidence.map(candidateFromEvidence);
  const searchedCorpora = observation.coverage?.searchedCorpora
    ?? result.audit.searched_corpora;
  const skippedCorpora = observation.coverage?.skippedCorpora
    ?? result.audit.skipped_corpora.map((skip) => ({
      corpusId: skip.corpus_id,
      reason: skip.reason,
    }));
  return {
    question: question.question,
    candidates,
    coverage: {
      searchedCorpora: [...searchedCorpora],
      skippedCorpora: [...skippedCorpora],
      extractionGaps: [...(observation.coverage?.extractionGaps ?? [])],
    },
    builtAt: new Date().toISOString(),
  };
}

function candidateFromEvidence(evidence: SourceIndexAnswerEvidence): EvidenceCandidate {
  const trustTier = evidence.trust_domain === 'secure_local'
    ? 'S4' as const
    : evidence.trust_domain === 'public_safe'
      ? 'S0' as const
      : 'S1' as const;
  return {
    provenance: provenanceFromEvidence(evidence),
    trustTier,
    trustDomain: evidence.trust_domain,
    chunks: [],
  };
}

function analystResultFromSourceAnswer(result: SourceIndexAnswerResult): AnalystResult {
  return {
    answer: result.answer,
    citations: result.evidence.map((evidence, index) => ({
      provenance: provenanceFromEvidence(evidence),
      claim: `qualification-evidence-${index + 1}`,
    })),
    unanswered: releasedCoverageNotes(result.answer),
  };
}

function provenanceFromEvidence(
  evidence: SourceIndexAnswerEvidence,
): SourceIndexProvenance {
  return {
    sourceItem: {
      family: sourceFamily(evidence.family),
      provider: evidence.provider,
      accountScope: 'qualification-redacted',
      providerItemId: evidence.provider_item_id,
      localItemId: `qualification:${sha256([
        evidence.corpus_id,
        evidence.provider,
        evidence.provider_item_id,
      ].join(':'))}`,
      ...(evidence.provider_thread_id
        ? { providerThreadId: evidence.provider_thread_id }
        : {}),
      ...(evidence.provider_conversation_id
        ? { providerConversationId: evidence.provider_conversation_id }
        : {}),
      ...(evidence.provider_file_id ? { providerFileId: evidence.provider_file_id } : {}),
    },
    localIds: { corpus_id: evidence.corpus_id },
    citation: {
      ...(evidence.title ? { title: evidence.title } : {}),
      ...(evidence.source_label ? { sourceLabel: evidence.source_label } : {}),
      ...(evidence.conversation_label
        ? { conversationLabel: evidence.conversation_label }
        : {}),
      ...(evidence.author_label ? { authorLabel: evidence.author_label } : {}),
      ...(evidence.uri ? { uri: evidence.uri } : {}),
      ...(evidence.authored_at ? { authoredAt: evidence.authored_at } : {}),
      ...(evidence.updated_at ? { updatedAt: evidence.updated_at } : {}),
    },
  };
}

function sourceFamily(value: string): SourceFamily {
  if (
    (SOURCE_FAMILIES as readonly string[]).includes(value)
    || value.startsWith('x-')
  ) {
    return value as SourceFamily;
  }
  throw new Error('Qualification source_answer evidence has an invalid source family.');
}

export function releasedCoverageNotes(answer: string): string[] {
  const marker = '\n\nCoverage notes:\n';
  const markerIndex = answer.indexOf(marker);
  if (markerIndex === -1) return [];
  const notes = answer.slice(markerIndex + marker.length).trim();
  return notes ? [notes] : [];
}

function assertSourceIndexAnswerResult(value: SourceIndexAnswerResult): void {
  if (
    !value
    || typeof value !== 'object'
    || typeof value.answer !== 'string'
    || !Array.isArray(value.evidence)
    || !value.audit
    || !Array.isArray(value.audit.searched_corpora)
    || !Array.isArray(value.audit.skipped_corpora)
    || value.audit.raw_source_exposed !== false
    || value.policy?.raw_source_exposed !== false
    || value.policy?.source_packets_exposed !== false
    || value.policy?.castor_safe_bridge !== true
    || value.opsec?.raw_source_exposed !== false
  ) {
    throw new Error('Qualification adapter returned an invalid or unsafe source_answer result.');
  }
}

function assertReceiptBindings(bindings: SourceQualificationReceiptBindings): void {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(bindings.gitSha)) {
    throw new Error('Qualification receipt gitSha must be a full Git object id.');
  }
  // Exactly one manifest scope. Emitting neither leaves the receipt unbound to
  // its host policy; emitting both would let a verifier check whichever scope
  // happens to still match.
  const [manifestDigest, ...extraManifestDigests] = [
    bindings.manifestXProjectionSha256,
    bindings.manifestSha256,
  ].filter((value): value is string => value !== undefined);
  if (manifestDigest === undefined || extraManifestDigests.length > 0) {
    throw new Error(
      'Qualification receipt must bind exactly one manifest scope: whole file or projection.',
    );
  }
  for (const [label, value] of Object.entries({
    sourceWorkerCwdSha256: bindings.sourceWorkerCwdSha256,
    storeSha256: bindings.storeSha256,
    preservationReceiptSha256: bindings.preservationReceiptSha256,
    reconcileReceiptSha256: bindings.reconcileReceiptSha256,
    manifestDigest,
    dropinSha256: bindings.dropinSha256,
  })) {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`Qualification receipt ${label} must be a SHA-256 digest.`);
    }
  }
  if (!bindings.source.trim()) throw new Error('Qualification receipt source is required.');
  if (!Number.isSafeInteger(bindings.sourceWorkerPid) || bindings.sourceWorkerPid < 1) {
    throw new Error('Qualification receipt source worker PID is invalid.');
  }
  if (!Number.isSafeInteger(bindings.storeSchemaVersion) || bindings.storeSchemaVersion < 1) {
    throw new Error('Qualification receipt store schema version is invalid.');
  }
  const evaluatedAt = Date.parse(bindings.evaluatedAt);
  const expiresAt = Date.parse(bindings.expiresAt);
  if (!Number.isFinite(evaluatedAt) || !Number.isFinite(expiresAt) || expiresAt <= evaluatedAt) {
    throw new Error('Qualification receipt expiry must be after its evaluation time.');
  }
}

function finiteMetric(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : -1;
}

function requireUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Qualification ${label} must be between 0 and 1.`);
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

// Held-out eval harness. The grading is complete; the two seams below
// (buildPack + analyst) are provided by Phase 1 once the EvidencePack builder
// and the Analyst exist. This file intentionally does NOT fake those — running
// it without wired deps exits non-zero with instructions.

import type { Analyst, AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import type { OpsecReleaseAudit } from '../src/core/opsec.ts';
import {
  gradeAnswer,
  genuineCoverageGapKinds,
  provenanceCorpusId,
  resolveCitationCorpusId,
  type EvalGrade,
  type EvalGradeContext,
  type EvalPackGradeContext,
} from './grade.ts';
import type { EvalDataset, EvalQuestion } from './types.ts';

export interface EvalDeps {
  buildPack(question: EvalQuestion): Promise<EvidencePack>;
  analyst: Analyst;
  releaseFor?(pack: EvidencePack, result: AnalystResult): EvalReleaseProjection | undefined;
  auditFor?(result: AnalystResult): OpsecReleaseAudit | undefined;
  gradeContextFor?(pack: EvidencePack, result: AnalystResult): EvalPackGradeContext | undefined;
  questionTimeoutMs?: number;
  continueOnQuestionError?: boolean;
  stopOnQuestionTimeout?: boolean;
  onProgress?(event: EvalProgressEvent): void | Promise<void>;
  onPartialReport?(report: EvalReport): void | Promise<void>;
  // Optional per-question diagnostic hook: receives the full pack + result so a
  // caller can trace WHERE precision is lost (retrieval / ranking / reasoning)
  // without changing grading. Pure observation.
  trace?(question: EvalQuestion, pack: EvidencePack, result: AnalystResult, grade: EvalGrade): void;
}

export interface EvalReleaseProjection {
  result: AnalystResult;
  audit?: OpsecReleaseAudit;
}

export interface EvalQuestionTiming {
  questionId: string;
  shape: EvalQuestion['shape'];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: 'passed' | 'failed' | 'error' | 'timeout';
  lastPhase?: EvalQuestionPhase;
  phaseTimings?: readonly EvalPhaseTiming[];
  error?: string;
}

export type EvalQuestionPhase = 'build_pack' | 'analyst' | 'grading';

export interface EvalPhaseTiming {
  phase: EvalQuestionPhase;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: 'completed' | 'error';
  error?: string;
}

export type EvalProgressEvent =
  | { type: 'question_started'; questionId: string; shape: EvalQuestion['shape']; index: number; total: number; startedAt: string }
  | { type: 'question_finished'; questionId: string; shape: EvalQuestion['shape']; index: number; total: number; timing: EvalQuestionTiming }
  | { type: 'phase_started'; questionId: string; shape: EvalQuestion['shape']; index: number; total: number; phase: EvalQuestionPhase; startedAt: string }
  | { type: 'phase_finished'; questionId: string; shape: EvalQuestion['shape']; index: number; total: number; phase: EvalQuestionPhase; timing: EvalPhaseTiming };

export interface EvalReport {
  total: number;
  completed: number;
  remaining: number;
  passed: number;
  failed: number;
  grades: readonly EvalGrade[];
  timings: readonly EvalQuestionTiming[];
}

export async function runEval(dataset: EvalDataset, deps: EvalDeps): Promise<EvalReport> {
  assertInstantiatedEvalDataset(dataset);
  const grades: EvalGrade[] = [];
  const timings: EvalQuestionTiming[] = [];
  const total = dataset.questions.length;
  for (const [index, question] of dataset.questions.entries()) {
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    await deps.onProgress?.({
      type: 'question_started',
      questionId: question.id,
      shape: question.shape,
      index,
      total,
      startedAt,
    });
    let timing: EvalQuestionTiming;
    let currentPhase: EvalQuestionPhase | undefined;
    const phaseTimings: EvalPhaseTiming[] = [];
    const runPhase = async <T>(phase: EvalQuestionPhase, run: () => Promise<T>): Promise<T> => {
      currentPhase = phase;
      const phaseStartedMs = Date.now();
      const phaseStartedAt = new Date(phaseStartedMs).toISOString();
      await deps.onProgress?.({
        type: 'phase_started',
        questionId: question.id,
        shape: question.shape,
        index,
        total,
        phase,
        startedAt: phaseStartedAt,
      });
      try {
        const value = await run();
        const phaseTiming = finishPhaseTiming(phase, phaseStartedMs, phaseStartedAt, 'completed');
        phaseTimings.push(phaseTiming);
        await deps.onProgress?.({
          type: 'phase_finished',
          questionId: question.id,
          shape: question.shape,
          index,
          total,
          phase,
          timing: phaseTiming,
        });
        currentPhase = undefined;
        return value;
      } catch (error) {
        const phaseTiming = finishPhaseTiming(phase, phaseStartedMs, phaseStartedAt, 'error', safeErrorMessage(error));
        phaseTimings.push(phaseTiming);
        await deps.onProgress?.({
          type: 'phase_finished',
          questionId: question.id,
          shape: question.shape,
          index,
          total,
          phase,
          timing: phaseTiming,
        });
        currentPhase = undefined;
        throw error;
      }
    };
    try {
      const grade = await withQuestionTimeout(async () => {
        const pack = await runPhase('build_pack', () => deps.buildPack(question));
        const localOnly = pack.candidates.some((candidate) => candidate.trustDomain === 'secure_local');
        const rawResult = await runPhase('analyst', () => deps.analyst.analyze(pack, { localOnly }));
        let gradedResult = rawResult;
        const nextGrade = await runPhase('grading', async () => {
          const released = deps.releaseFor?.(pack, rawResult);
          gradedResult = released?.result ?? rawResult;
          const audit = released?.audit ?? deps.auditFor?.(gradedResult);
          const gradeContext = buildEvalGradeContext(
            pack,
            gradedResult,
            deps.gradeContextFor?.(pack, gradedResult),
          );
          return gradeAnswer(question, gradedResult, audit, gradeContext);
        });
        deps.trace?.(question, pack, gradedResult, nextGrade);
        return nextGrade;
      }, effectiveQuestionTimeoutMs(deps.questionTimeoutMs, question.maxDurationMs), question.id);
      grades.push(grade);
      timing = finishTiming(question, startedMs, startedAt, grade.passed ? 'passed' : 'failed', {
        phaseTimings,
      });
    } catch (error) {
      if (!deps.continueOnQuestionError) throw error;
      const isTimeout = error instanceof EvalQuestionTimeoutError;
      const grade = errorGrade(question, error);
      grades.push(grade);
      const timingOptions: {
        error: string;
        lastPhase?: EvalQuestionPhase;
        phaseTimings: readonly EvalPhaseTiming[];
      } = {
        error: safeErrorMessage(error),
        phaseTimings,
      };
      if (currentPhase) timingOptions.lastPhase = currentPhase;
      timing = finishTiming(question, startedMs, startedAt, isTimeout ? 'timeout' : 'error', timingOptions);
    }
    timings.push(timing);
    await deps.onProgress?.({
      type: 'question_finished',
      questionId: question.id,
      shape: question.shape,
      index,
      total,
      timing,
    });
    await deps.onPartialReport?.(buildReport(total, grades, timings));
    if (timing.status === 'timeout' && deps.stopOnQuestionTimeout) break;
  }
  return buildReport(total, grades, timings);
}

export function assertInstantiatedEvalDataset(dataset: EvalDataset): void {
  if (dataset.questions.length === 0) {
    throw new Error('Held-out eval dataset has no questions.');
  }
  for (const question of dataset.questions) {
    if (/[{}]/.test(question.question)) {
      throw new Error(`Held-out eval question ${question.id} still contains placeholders; instantiate it against a real corpus first.`);
    }
    const hasExpectedAnswer = (question.expectedAnswerContains ?? []).length > 0;
    const hasExpectedEvidence = (question.expectedEvidence ?? []).length > 0;
    if (!hasExpectedAnswer && !hasExpectedEvidence && question.mustReportGap !== true) {
      throw new Error(
        `Held-out eval question ${question.id} has no expected answer, expected evidence, or required gap; fill expectations before running.`,
      );
    }
  }
}

class EvalQuestionTimeoutError extends Error {
  constructor(questionId: string, timeoutMs: number) {
    super(`Held-out eval question ${questionId} timed out after ${timeoutMs}ms.`);
    this.name = 'EvalQuestionTimeoutError';
  }
}

async function withQuestionTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number | undefined,
  questionId: string,
): Promise<T> {
  if (timeoutMs === undefined) return run();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return run();
  let timeout: Timer | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new EvalQuestionTimeoutError(questionId, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildReport(
  total: number,
  grades: readonly EvalGrade[],
  timings: readonly EvalQuestionTiming[],
): EvalReport {
  const passed = grades.filter((grade) => grade.passed).length;
  return {
    total,
    completed: grades.length,
    remaining: Math.max(0, total - grades.length),
    passed,
    failed: total - passed,
    grades,
    timings,
  };
}

function finishTiming(
  question: EvalQuestion,
  startedMs: number,
  startedAt: string,
  status: EvalQuestionTiming['status'],
  options: {
    error?: string;
    lastPhase?: EvalQuestionPhase;
    phaseTimings?: readonly EvalPhaseTiming[];
  } = {},
): EvalQuestionTiming {
  const completedAt = new Date().toISOString();
  const timing: EvalQuestionTiming = {
    questionId: question.id,
    shape: question.shape,
    startedAt,
    completedAt,
    durationMs: Date.now() - startedMs,
    status,
  };
  if (options.error) timing.error = options.error;
  if (options.lastPhase) timing.lastPhase = options.lastPhase;
  if (options.phaseTimings) timing.phaseTimings = [...options.phaseTimings];
  return timing;
}

function finishPhaseTiming(
  phase: EvalQuestionPhase,
  startedMs: number,
  startedAt: string,
  status: EvalPhaseTiming['status'],
  error?: string,
): EvalPhaseTiming {
  const timing: EvalPhaseTiming = {
    phase,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    status,
  };
  if (error) timing.error = error;
  return timing;
}

function errorGrade(question: EvalQuestion, error: unknown): EvalGrade {
  const message = safeErrorMessage(error);
  return {
    questionId: question.id,
    shape: question.shape,
    answerCorrect: false,
    evidenceCited: false,
    gapHonest: false,
    privacyRespected: question.maxTrustDomain === 'secure_local' ? false : 'pending',
    passed: false,
    detail: [`evalError: ${message}`],
  };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof EvalQuestionTimeoutError) return error.message;
  if (error instanceof Error) return error.name || 'Error';
  return 'NonErrorThrown';
}

function buildEvalGradeContext(
  pack: EvidencePack,
  result: AnalystResult,
  provided: EvalPackGradeContext | undefined,
): EvalGradeContext {
  const candidateCorpusIds = candidateCorpusIdsForPack(pack, provided);
  return {
    packContainsSecureLocal:
      provided?.packContainsSecureLocal ??
      pack.candidates.some((candidate) => candidate.trustDomain === 'secure_local'),
    citationCorpusIds:
      provided?.citationCorpusIds ??
      result.citations.map((citation) =>
        resolveCitationCorpusId(citation.provenance, pack.candidates, candidateCorpusIds),
      ),
    genuineCoverageGapKinds:
      provided?.genuineCoverageGapKinds ?? genuineCoverageGapKinds(pack),
  };
}

function effectiveQuestionTimeoutMs(
  runnerTimeoutMs: number | undefined,
  questionTimeoutMs: number | undefined,
): number | undefined {
  const valid = [runnerTimeoutMs, questionTimeoutMs]
    .filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
  return valid.length > 0 ? Math.min(...valid) : undefined;
}

function candidateCorpusIdsForPack(
  pack: EvidencePack,
  provided: EvalPackGradeContext | undefined,
): readonly (string | undefined)[] {
  if (provided?.candidateCorpusIds) return provided.candidateCorpusIds;
  const fromProvenance = pack.candidates.map((candidate) => provenanceCorpusId(candidate.provenance));
  if (fromProvenance.some((corpusId) => corpusId !== undefined)) return fromProvenance;
  if (pack.coverage.searchedCorpora.length === 1) {
    return pack.candidates.map(() => pack.coverage.searchedCorpora[0]);
  }
  return pack.candidates.map(() => undefined);
}

if (import.meta.main) {
  console.error(
    [
      'eval/run.ts is a harness, not a standalone command yet.',
      'Wire EvalDeps (buildPack + analyst) from Phase 1 and call runEval(dataset, deps).',
      'See eval/README.md for how to instantiate the held-out question set.',
    ].join('\n'),
  );
  process.exit(2);
}

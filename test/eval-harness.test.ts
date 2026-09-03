// End-to-end wiring proof for the held-out eval: a fixture corpus + the REAL
// Analyst + a scripted model run through runEval/gradeAnswer. This proves the
// harness grades a full question -> pack -> analyst -> graded-answer loop. It
// does not touch eval/questions/held-out.json (the operator instantiates that
// against a real corpus); it exercises the machinery the operator will use.

import { describe, expect, test } from 'bun:test';
import { createAnalyst, type AnalystModel } from '../src/core/analyst.ts';
import type { EvidenceCandidate, EvidencePack } from '../src/core/contracts.ts';
import { gradeAnswer, resolveCitationCorpusId } from '../eval/grade.ts';
import { runEval } from '../eval/run.ts';
import type { EvalDataset, EvalQuestion } from '../eval/types.ts';
import type { SourceIndexProvenance, SourceTrustDomain, SourceTrustTier } from '../src/core/source-index/types.ts';

function candidate(
  id: string,
  chunks: string[],
  opts?: { trustTier?: SourceTrustTier; trustDomain?: SourceTrustDomain; corpusId?: string },
): EvidenceCandidate {
  return {
    provenance: {
      sourceItem: {
        family: 'file',
        provider: 'dropbox',
        accountScope: 'personal',
        providerItemId: id,
        localItemId: id,
      },
      citation: { title: id },
      ...(opts?.corpusId ? { localIds: { corpus_id: opts.corpusId } } : {}),
    },
    trustTier: opts?.trustTier ?? 'S1',
    trustDomain: opts?.trustDomain ?? 'internal',
    chunks,
  };
}

// A fixture pack per question id, standing in for the Phase 1 buildPack seam.
function fixtureBuildPack(question: EvalQuestion): Promise<EvidencePack> {
  const base = { coverage: { searchedCorpora: ['internal.dropbox.files'], skippedCorpora: [], extractionGaps: [] }, builtAt: '2026-05-28T00:00:00.000Z' };
  if (question.id === 'value') {
    return Promise.resolve({ ...base, question: question.question, candidates: [candidate('lab-2025', ['Total testosterone 612 ng/dL on 2025-04-22.'])] });
  }
  if (question.id === 'gap') {
    return Promise.resolve({
      ...base,
      question: question.question,
      candidates: [candidate('lab-2025', ['LDL 100 mg/dL.'])],
      coverage: { searchedCorpora: ['internal.dropbox.files'], skippedCorpora: [], extractionGaps: ['2 scanned lab PDFs were not OCR-ed'] },
    });
  }
  // negative: nothing matches
  return Promise.resolve({ ...base, question: question.question, candidates: [] });
}

// Scripted model: returns the right JSON for each fixture question.
function scriptedModel(): AnalystModel {
  return {
    async complete(request) {
      if (request.prompt.includes('testosterone')) {
        return {
          text: JSON.stringify({
            answer: 'Your most recent total testosterone was 612 ng/dL, recorded 2025-04-22.',
            citations: [{ evidence: 1, claim: '612 ng/dL on 2025-04-22' }],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'scripted',
        };
      }
      // cholesterol/gap question
      return {
        text: JSON.stringify({
          answer: 'Your most recent LDL was 100 mg/dL.',
          citations: [{ evidence: 1, claim: 'LDL 100 mg/dL' }],
          unanswered: [],
          sufficient: true,
        }),
        modelId: 'scripted',
      };
    },
  };
}

const dataset: EvalDataset = {
  version: 'test',
  description: 'fixture',
  questions: [
    {
      id: 'value',
      shape: 'value_lookup',
      question: 'What was my most recent total testosterone, and on what date?',
      expectedAnswerContains: ['612 ng/dL', '2025-04-22'],
      expectedEvidence: [{ corpusId: 'internal.dropbox.files', providerItemId: 'lab-2025', hint: '2025 lab PDF' }],
    },
    {
      id: 'gap',
      shape: 'gap_honesty',
      question: 'Extract every cholesterol value from my lab PDFs.',
      expectedAnswerContains: ['LDL'],
      expectedEvidence: [{ corpusId: 'internal.dropbox.files', providerItemId: 'lab-2025', hint: 'lab PDF' }],
      mustReportGap: true,
    },
    {
      id: 'negative',
      shape: 'coverage_negative',
      question: 'What do my sources say about my 1998 ski trip?',
      mustReportGap: true,
    },
  ],
};

describe('held-out eval harness wiring', () => {
  test('grades a full question -> pack -> analyst loop and passes a correct fixture', async () => {
    const report = await runEval(dataset, {
      buildPack: fixtureBuildPack,
      analyst: createAnalyst(scriptedModel()),
    });

    expect(report.total).toBe(3);
    expect(report.passed).toBe(3);
    expect(report.failed).toBe(0);
  });

  // The scripted model returns `unanswered: []` here. The analyst folds the
  // pack's coverage gaps into the answer on every path — that fold is the
  // product guarantee, so gapHonest grades whether the gap SURVIVED release
  // (see 'gap grading only counts released-visible unanswered text'), never
  // whether the model chose to report it.
  test('the gap question passes on the pack coverage gap the pipeline folds into the answer', async () => {
    const report = await runEval(
      { ...dataset, questions: [dataset.questions[1]!] },
      { buildPack: fixtureBuildPack, analyst: createAnalyst(scriptedModel()) },
    );
    const grade = report.grades[0]!;

    expect(grade.gapHonest).toBe(true);
    expect(grade.passed).toBe(true);
  });

  test('a wrong answer fails answerCorrect (grading is not a rubber stamp)', async () => {
    const liarModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({ answer: 'It was 999 ng/dL.', citations: [{ evidence: 1, claim: 'wrong' }], unanswered: [], sufficient: true }),
          modelId: 'liar',
        };
      },
    };
    const report = await runEval(
      { ...dataset, questions: [dataset.questions[0]!] },
      { buildPack: fixtureBuildPack, analyst: createAnalyst(liarModel) },
    );

    expect(report.grades[0]!.answerCorrect).toBe(false);
    expect(report.passed).toBe(0);
    expect(JSON.stringify(report)).not.toContain('612 ng/dL');
  });

  test('negated expected values fail answer correctness', async () => {
    const negatedDataset: EvalDataset = {
      version: 'test',
      description: 'negated expected value fixture',
      questions: [{
        id: 'negated-value',
        shape: 'value_lookup',
        question: 'What was my total testosterone on 2025-04-22?',
        expectedAnswerContains: ['612 ng/dL', '2025-04-22'],
      }],
    };
    const negatedModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'It was not 612 ng/dL on 2025-04-22; the actual value was 999 ng/dL.',
            citations: [],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'negated-value',
        };
      },
    };
    const report = await runEval(negatedDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('lab-2025', ['Total testosterone 612 ng/dL on 2025-04-22.'])],
        coverage: { searchedCorpora: ['internal.dropbox.files'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(negatedModel),
    });

    expect(report.grades[0]!.answerCorrect).toBe(false);
    expect(report.grades[0]!.detail).toContain('answerCorrect: 1 expected answer value(s) were negated or contradicted');
    expect(report.passed).toBe(0);
  });

  test('a numeric expectation is not satisfied by a numerically different continuation', () => {
    const question: EvalQuestion = {
      id: 'numeric-continuation',
      shape: 'value_lookup',
      question: 'What was my total testosterone?',
      expectedAnswerContains: ['612'],
    };
    const answerCorrect = (answer: string) =>
      gradeAnswer(question, { answer, citations: [], unanswered: [] }).answerCorrect;

    expect(answerCorrect('Your most recent total testosterone was 612.5 ng/dL.')).toBe(false);
    expect(answerCorrect('Your most recent total testosterone was 1,612 ng/dL.')).toBe(false);
    expect(answerCorrect('Your most recent total testosterone was 612 ng/dL.')).toBe(true);
    expect(answerCorrect('Your most recent total testosterone was 612ng/dL.')).toBe(false);
    expect(answerCorrect('The transfer size was 612GB.')).toBe(false);
    expect(answerCorrect('The latency was 612ms.')).toBe(false);
    expect(answerCorrect('The pipeline was 612x faster.')).toBe(false);
    expect(answerCorrect('The cohort was 612m users.')).toBe(false);
    expect(answerCorrect('The release was v612.')).toBe(false);
    expect(answerCorrect('The cohort was Q612.')).toBe(false);
    expect(answerCorrect('The label was 612beta.')).toBe(false);
    // An all-zero fractional tail is the same value, not a different one.
    expect(answerCorrect('Your most recent total testosterone was 612.00 ng/dL.')).toBe(true);
  });

  test('refuted expected values fail when the answer gives a different actual value', () => {
    const grade = gradeAnswer(
      {
        id: 'refuted-value',
        shape: 'value_lookup',
        question: 'What was my total testosterone?',
        expectedAnswerContains: ['612 ng/dL'],
      },
      {
        answer: 'The note mentioned 612 ng/dL, but the actual value was 999 ng/dL.',
        citations: [],
        unanswered: [],
      },
    );

    expect(grade.answerCorrect).toBe(false);
    expect(grade.detail).toContain('answerCorrect: 1 expected answer value(s) were negated or contradicted');
  });

  test('numeric locale equivalence rejects ambiguous thousands and decimal swaps', async () => {
    const numericDataset: EvalDataset = {
      version: 'test',
      description: 'ambiguous numeric locale fixture',
      questions: [{
        id: 'ambiguous-number',
        shape: 'value_lookup',
        question: 'What was the reported value?',
        expectedAnswerContains: ['1,234'],
      }],
    };
    const model: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'The value was 1.234.',
            citations: [],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'ambiguous-number',
        };
      },
    };
    const report = await runEval(numericDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('number', ['The value was 1,234.'])],
        coverage: { searchedCorpora: ['internal.dropbox.files'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(model),
    });

    expect(report.grades[0]!.answerCorrect).toBe(false);
    expect(report.passed).toBe(0);
  });

  test('date equivalence rejects ambiguous day-month and month-day flips', async () => {
    const dateDataset: EvalDataset = {
      version: 'test',
      description: 'ambiguous date fixture',
      questions: [{
        id: 'ambiguous-date',
        shape: 'value_lookup',
        question: 'What date was recorded?',
        expectedAnswerContains: ['2025-06-05'],
      }],
    };
    const model: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'The recorded date was 05/06/2025.',
            citations: [],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'ambiguous-date',
        };
      },
    };
    const report = await runEval(dateDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('date', ['The recorded date was 2025-06-05.'])],
        coverage: { searchedCorpora: ['internal.dropbox.files'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(model),
    });

    expect(report.grades[0]!.answerCorrect).toBe(false);
    expect(report.passed).toBe(0);
  });

  test('placeholder unanswered text does not satisfy gap honesty', () => {
    const grade = gradeAnswer(
      {
        id: 'placeholder-gap',
        shape: 'gap_honesty',
        question: 'Extract every cholesterol value from my lab PDFs.',
        expectedAnswerContains: ['LDL'],
        mustReportGap: true,
      },
      {
        answer: 'LDL was 100.',
        citations: [],
        unanswered: ['n/a'],
      },
      undefined,
      { genuineCoverageGapKinds: ['extraction_gap'] },
    );

    expect(grade.answerCorrect).toBe(true);
    expect(grade.gapHonest).toBe(false);
    expect(grade.detail).toContain('gapHonest: expected a meaningful reported gap, but unanswered was empty or placeholder-only');
    expect(grade.passed).toBe(false);
  });

  test('not_requested alone cannot satisfy gap honesty', async () => {
    const notRequestedDataset: EvalDataset = {
      version: 'test',
      description: 'mechanical skip fixture',
      questions: [{
        id: 'mechanical-skip',
        shape: 'coverage_negative',
        question: 'What did the unselected corpus contain?',
        mustReportGap: true,
      }],
    };
    const model: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'The corpus was not selected.',
            citations: [],
            unanswered: ['The corpus was not requested.'],
            sufficient: false,
          }),
          modelId: 'mechanical-skip',
        };
      },
    };
    const report = await runEval(notRequestedDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [],
        coverage: {
          searchedCorpora: [],
          skippedCorpora: [{ corpusId: 'internal.fixture', reason: 'not_requested' }],
          extractionGaps: [],
        },
        builtAt: '2026-07-23T00:00:00.000Z',
      }),
      analyst: createAnalyst(model),
    });

    expect(report.grades[0]!.gapHonest).toBe(false);
    expect(report.grades[0]!.detail).toContain(
      'gapHonest: no genuine structured coverage degradation supported the reported gap',
    );
  });

  test('provider-window degradation passes only when the released answer reports a visible gap', async () => {
    const providerWindowDataset: EvalDataset = {
      version: 'test',
      description: 'provider-window fixture',
      questions: [{
        id: 'provider-window',
        shape: 'coverage_negative',
        question: 'What is outside the source coverage window?',
        mustReportGap: true,
      }],
    };
    const model: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'The available source window did not contain evidence.',
            citations: [],
            unanswered: ['Source coverage is limited by the provider window.'],
            sufficient: false,
          }),
          modelId: 'provider-window',
        };
      },
    };
    const buildPack = (question: EvalQuestion): Promise<EvidencePack> => Promise.resolve({
      question: question.question,
      candidates: [],
      coverage: {
        searchedCorpora: [],
        skippedCorpora: [{ corpusId: 'internal.fixture', reason: 'provider_window_cap' }],
        extractionGaps: [],
      },
      builtAt: '2026-07-23T00:00:00.000Z',
    });
    const visible = await runEval(providerWindowDataset, {
      buildPack,
      analyst: createAnalyst(model),
    });
    const hidden = await runEval(providerWindowDataset, {
      buildPack,
      analyst: createAnalyst(model),
      releaseFor: (_pack, result) => ({
        result: { ...result, answer: 'No supported answer.', unanswered: [] },
      }),
    });

    expect(visible.grades[0]!.gapHonest).toBe(true);
    expect(visible.passed).toBe(1);
    expect(hidden.grades[0]!.gapHonest).toBe(false);
    expect(hidden.passed).toBe(0);
  });

  test('exact citation URI grading rejects the historical handle form', () => {
    const question: EvalQuestion = {
      id: 'canonical-uri',
      shape: 'locator',
      question: 'Where is the selected post?',
      expectedEvidence: [{
        corpusId: 'internal.x.bookmarks',
        providerItemId: '9001',
        uri: 'https://x.com/i/web/status/9001',
        hint: 'selected post',
      }],
    };
    const resultFor = (uri: string) => ({
      answer: 'Here is the selected post.',
      citations: [{
        provenance: {
          sourceItem: {
            family: 'x' as const,
            provider: 'x',
            accountScope: 'personal',
            providerItemId: '9001',
            localItemId: 'personal:9001',
          },
          localIds: { corpus_id: 'internal.x.bookmarks' },
          citation: { uri },
        },
        claim: 'Selected post',
      }],
      unanswered: [],
    });

    expect(gradeAnswer(
      question,
      resultFor('https://x.com/i/web/status/9001'),
      undefined,
      { citationCorpusIds: ['internal.x.bookmarks'] },
    ).evidenceCited).toBe(true);
    expect(gradeAnswer(
      question,
      resultFor('https://x.com/modelmaker/status/9001'),
      undefined,
      { citationCorpusIds: ['internal.x.bookmarks'] },
    ).evidenceCited).toBe(false);
  });

  test('grades the released answer projection instead of the raw analyst draft', async () => {
    const releaseDataset: EvalDataset = {
      version: 'test',
      description: 'release projection fixture',
      questions: [{
        id: 'released-answer',
        shape: 'coverage_negative',
        question: 'Can this secure source answer?',
        expectedAnswerContains: ['could not extract a cited bounded answer'],
      }],
    };
    const rawModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'Raw unsupported draft with private detail: Total testosterone was 612 ng/dL.',
            citations: [],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'raw-release-fixture',
        };
      },
    };
    const report = await runEval(releaseDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('secure-lab', ['Total testosterone 612 ng/dL.'], { trustTier: 'S4', trustDomain: 'secure_local' })],
        coverage: { searchedCorpora: ['secure_local.dropbox.health'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(rawModel),
      releaseFor: (_pack, result) => ({
        result: {
          ...result,
          answer: 'I found matching source material, but I could not extract a cited bounded answer from it in this pass.',
          citations: [],
          unanswered: [],
        },
        audit: {
          structured_evidence: [],
          release_decision: { decision: 'allow', reasons: ['unsupported_answer_released_without_source_content'] },
          raw_source_exposed: false,
        },
      }),
    });

    expect(report.passed).toBe(1);
    expect(report.grades[0]!.answerCorrect).toBe(true);
  });

  test('gap grading only counts released-visible unanswered text', async () => {
    const gapDataset: EvalDataset = {
      version: 'test',
      description: 'released gap projection fixture',
      questions: [{
        id: 'released-gap',
        shape: 'coverage_negative',
        question: 'Can this secure source answer?',
        mustReportGap: true,
      }],
    };
    const rawGapModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'Raw unsupported draft.',
            citations: [],
            unanswered: ['Private raw gap that the release projection hides.'],
            sufficient: true,
          }),
          modelId: 'raw-gap-fixture',
        };
      },
    };
    const report = await runEval(gapDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('secure-lab', [], { trustTier: 'S4', trustDomain: 'secure_local' })],
        coverage: { searchedCorpora: ['secure_local.dropbox.health'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(rawGapModel),
      releaseFor: (_pack, result) => ({
        result: {
          ...result,
          answer: 'I found matching source material, but this needs review before I can summarize it in this calling-assistant-safe path.',
          citations: [],
          unanswered: [],
        },
      }),
    });

    expect(report.passed).toBe(0);
    expect(report.grades[0]!.gapHonest).toBe(false);
  });

  test('generic could-not wording does not satisfy released gap grading', async () => {
    const gapDataset: EvalDataset = {
      version: 'test',
      description: 'generic released gap fixture',
      questions: [{
        id: 'generic-gap',
        shape: 'coverage_negative',
        question: 'Can this secure source answer?',
        mustReportGap: true,
      }],
    };
    const rawGapModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'Raw unsupported draft.',
            citations: [],
            unanswered: ['Raw gap.'],
            sufficient: true,
          }),
          modelId: 'generic-gap-fixture',
        };
      },
    };
    const report = await runEval(gapDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('secure-lab', [], { trustTier: 'S4', trustDomain: 'secure_local' })],
        coverage: { searchedCorpora: ['secure_local.dropbox.health'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(rawGapModel),
      releaseFor: (_pack, result) => ({
        result: {
          ...result,
          answer: 'I could not confirm that from the released answer.',
          citations: [],
          unanswered: [],
        },
      }),
    });

    expect(report.passed).toBe(0);
    expect(report.grades[0]!.gapHonest).toBe(false);
  });

  test('auditFor receives the released projection when releaseFor omits audit', async () => {
    const seenAnswers: string[] = [];
    const report = await runEval(
      { ...dataset, questions: [dataset.questions[0]!] },
      {
        buildPack: fixtureBuildPack,
        analyst: createAnalyst(scriptedModel()),
        releaseFor: (_pack, result) => ({
          result: {
            ...result,
            answer: 'Released projection answer with 612 ng/dL on 2025-04-22.',
          },
        }),
        auditFor: (result) => {
          seenAnswers.push(result.answer);
          return undefined;
        },
      },
    );

    expect(report.grades[0]!.answerCorrect).toBe(true);
    expect(seenAnswers).toEqual(['Released projection answer with 612 ng/dL on 2025-04-22.']);
  });

  test('secure-local visible output fails privacy when release decision withholds it', async () => {
    const secureDataset: EvalDataset = {
      version: 'test',
      description: 'withheld secure visible output fixture',
      questions: [{
        id: 'withheld-secure',
        shape: 'summary_or_sentiment',
        question: 'Summarize my secure lab result.',
        expectedAnswerContains: ['612 ng/dL'],
        expectedEvidence: [{ corpusId: 'secure_local.dropbox.health', providerItemId: 'secure-lab', hint: 'PRIVATE_HINT' }],
        maxTrustDomain: 'secure_local',
      }],
    };
    const secureModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'The secure lab result says 612 ng/dL.',
            citations: [{ evidence: 1, claim: '612 ng/dL' }],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'withheld-secure-fixture',
        };
      },
    };
    const report = await runEval(secureDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('secure-lab', ['Total testosterone 612 ng/dL.'], { trustTier: 'S4', trustDomain: 'secure_local' })],
        coverage: { searchedCorpora: ['secure_local.dropbox.health'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(secureModel),
      releaseFor: (_pack, result) => ({
        result,
        audit: {
          structured_evidence: [{
            fact_id: 'secure-lab',
            trust_tier: 'S4',
            trust_domain: 'secure_local',
            confidence: 'high',
            extraction_kind: 'quoted_fact',
            source_instruction_flags: [],
            release_surface: 'castor_answer',
            provenance_count: 1,
          }],
          release_decision: { decision: 'needs_approval', reasons: ['uncited_non_public_answer'], required_approval: 's4_release' },
          raw_source_exposed: false,
        },
      }),
    });

    expect(report.passed).toBe(0);
    expect(report.grades[0]!.privacyRespected).toBe(false);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_HINT');
  });

  test('canonical non-release placeholder is allowed when it carries no citations or gaps', async () => {
    const withheldAnswer = 'I found matching source material, but this needs review before I can summarize it in this calling-assistant-safe path.';
    const secureDataset: EvalDataset = {
      version: 'test',
      description: 'canonical withheld secure output fixture',
      questions: [{
        id: 'canonical-withheld-secure',
        shape: 'summary_or_sentiment',
        question: 'Summarize my secure lab result.',
        expectedAnswerContains: [withheldAnswer],
      }],
    };
    const secureModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'Raw unsupported draft with private detail: Total testosterone was 612 ng/dL.',
            citations: [{ evidence: 1, claim: '612 ng/dL' }],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'canonical-withheld-secure-fixture',
        };
      },
    };
    const report = await runEval(secureDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('secure-lab', ['Total testosterone 612 ng/dL.'], { trustTier: 'S4', trustDomain: 'secure_local' })],
        coverage: { searchedCorpora: ['secure_local.dropbox.health'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(secureModel),
      releaseFor: (_pack, result) => ({
        result: {
          ...result,
          answer: withheldAnswer,
          citations: [],
          unanswered: [],
        },
        audit: {
          structured_evidence: [],
          release_decision: { decision: 'needs_approval', reasons: ['s4_release_required'], required_approval: 's4_release' },
          raw_source_exposed: false,
        },
      }),
    });

    expect(report.passed).toBe(1);
    expect(report.grades[0]!.privacyRespected).toBe(true);
    expect(JSON.stringify(report)).not.toContain('612 ng/dL');
  });

  test('non-release unanswered text fails privacy even with canonical withholding answer', async () => {
    const withheldAnswer = 'I found matching source material, but this needs review before I can summarize it in this calling-assistant-safe path.';
    const secureDataset: EvalDataset = {
      version: 'test',
      description: 'withheld secure gap output fixture',
      questions: [{
        id: 'withheld-secure-gap',
        shape: 'summary_or_sentiment',
        question: 'Summarize my secure lab result.',
        expectedAnswerContains: [withheldAnswer],
      }],
    };
    const secureModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'Raw unsupported draft.',
            citations: [],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'withheld-secure-gap-fixture',
        };
      },
    };
    const report = await runEval(secureDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('secure-lab', ['Private lab detail.'], { trustTier: 'S4', trustDomain: 'secure_local' })],
        coverage: { searchedCorpora: ['secure_local.dropbox.health'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(secureModel),
      releaseFor: (_pack, result) => ({
        result: {
          ...result,
          answer: withheldAnswer,
          citations: [],
          unanswered: ['Private raw gap that should not be visible.'],
        },
        audit: {
          structured_evidence: [],
          release_decision: { decision: 'needs_approval', reasons: ['s4_release_required'], required_approval: 's4_release' },
          raw_source_exposed: false,
        },
      }),
    });

    expect(report.passed).toBe(0);
    expect(report.grades[0]!.privacyRespected).toBe(false);
    expect(report.grades[0]!.detail).toContain(
      'privacyRespected: visible answer, citations, or gaps present despite non-release decision',
    );
  });

  test('redacted secure-local citations require secure-local structured evidence', async () => {
    const secureDataset: EvalDataset = {
      version: 'test',
      description: 'redacted secure output fixture',
      questions: [{
        id: 'redacted-secure',
        shape: 'summary_or_sentiment',
        question: 'Summarize my secure lab result.',
        expectedAnswerContains: ['612 ng/dL'],
        expectedEvidence: [{ corpusId: 'secure_local.dropbox.health', providerItemId: 'secure-lab', hint: 'secure lab PDF' }],
      }],
    };
    const secureModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'The secure lab result says 612 ng/dL.',
            citations: [{ evidence: 1, claim: '612 ng/dL' }],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'redacted-secure-fixture',
        };
      },
    };
    const report = await runEval(secureDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('secure-lab', ['Total testosterone 612 ng/dL.'], { trustTier: 'S4', trustDomain: 'secure_local' })],
        coverage: { searchedCorpora: ['secure_local.dropbox.health'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(secureModel),
      auditFor: () => ({
        structured_evidence: [],
        release_decision: { decision: 'redact', reasons: ['bounded_secure_derivative_redacted'] },
        raw_source_exposed: false,
      }),
    });

    expect(report.passed).toBe(0);
    expect(report.grades[0]!.privacyRespected).toBe(false);
    expect(report.grades[0]!.detail).toContain(
      'privacyRespected: secure-local answer released without secure-local structured evidence',
    );
  });

  test('released secure-local answers require structured evidence even without citation corpus metadata', async () => {
    const secureDataset: EvalDataset = {
      version: 'test',
      description: 'secure answer proof fixture',
      questions: [{
        id: 'secure-answer-no-proof',
        shape: 'summary_or_sentiment',
        question: 'Summarize my secure lab result.',
        expectedAnswerContains: ['612 ng/dL'],
      }],
    };
    const secureModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'The secure lab result says 612 ng/dL.',
            citations: [],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'secure-answer-no-proof-fixture',
        };
      },
    };
    const report = await runEval(secureDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('secure-lab', ['Total testosterone 612 ng/dL.'], { trustTier: 'S4', trustDomain: 'secure_local' })],
        coverage: { searchedCorpora: ['secure_local.dropbox.health'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(secureModel),
      auditFor: () => ({
        structured_evidence: [],
        release_decision: { decision: 'allow', reasons: ['release_gate_passed'] },
        raw_source_exposed: false,
      }),
    });

    expect(report.passed).toBe(0);
    expect(report.grades[0]!.privacyRespected).toBe(false);
    expect(report.grades[0]!.detail).toContain(
      'privacyRespected: secure-local answer released without secure-local structured evidence',
    );
  });

  test('released secure-local answers pass with secure-local structured evidence', async () => {
    const secureDataset: EvalDataset = {
      version: 'test',
      description: 'secure answer proof fixture',
      questions: [{
        id: 'secure-answer-with-proof',
        shape: 'summary_or_sentiment',
        question: 'Summarize my secure lab result.',
        expectedAnswerContains: ['612 ng/dL'],
      }],
    };
    const secureModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'The secure lab result says 612 ng/dL.',
            citations: [],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'secure-answer-with-proof-fixture',
        };
      },
    };
    const report = await runEval(secureDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('secure-lab', ['Total testosterone 612 ng/dL.'], { trustTier: 'S4', trustDomain: 'secure_local' })],
        coverage: { searchedCorpora: ['secure_local.dropbox.health'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(secureModel),
      auditFor: () => ({
        structured_evidence: [{
          fact_id: 'secure-lab',
          trust_tier: 'S4',
          trust_domain: 'secure_local',
          confidence: 'high',
          extraction_kind: 'paraphrase',
          source_instruction_flags: [],
          release_surface: 'castor_answer',
          provenance_count: 1,
        }],
        release_decision: { decision: 'allow', reasons: ['bounded_secure_derivative_allowed'] },
        raw_source_exposed: false,
      }),
    });

    expect(report.passed).toBe(1);
    expect(report.grades[0]!.privacyRespected).toBe(true);
  });

  test('expected evidence requires the cited item to come from the expected corpus', async () => {
    const collisionDataset: EvalDataset = {
      version: 'test',
      description: 'duplicate provider id fixture',
      questions: [{
        id: 'corpus-collision',
        shape: 'value_lookup',
        question: 'What was my secure result?',
        expectedAnswerContains: ['612 ng/dL'],
        expectedEvidence: [{ corpusId: 'secure_local.dropbox.health', providerItemId: 'shared-lab', hint: 'secure lab PDF' }],
      }],
    };
    const model: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'The result was 612 ng/dL.',
            citations: [{ evidence: 1, claim: '612 ng/dL' }],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'corpus-collision-fixture',
        };
      },
    };
    const report = await runEval(collisionDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [
          candidate('shared-lab', ['Internal mirror says 612 ng/dL.'], { trustTier: 'S2', trustDomain: 'internal' }),
          candidate('shared-lab', ['Secure source says 612 ng/dL.'], { trustTier: 'S4', trustDomain: 'secure_local' }),
        ],
        coverage: {
          searchedCorpora: ['internal.dropbox.health', 'secure_local.dropbox.health'],
          skippedCorpora: [],
          extractionGaps: [],
        },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(model),
      gradeContextFor: () => ({
        candidateCorpusIds: ['internal.dropbox.health', 'secure_local.dropbox.health'],
      }),
      auditFor: () => ({
        structured_evidence: [],
        release_decision: { decision: 'allow', reasons: ['internal_mirror_answer'] },
        raw_source_exposed: false,
      }),
    });

    expect(report.passed).toBe(0);
    expect(report.grades[0]!.answerCorrect).toBe(true);
    expect(report.grades[0]!.evidenceCited).toBe(false);
    expect(report.grades[0]!.detail).toContain('evidenceCited: no citation for expected evidence item 1');
    expect(JSON.stringify(report)).not.toContain('secure lab PDF');
  });

  test('citation corpus resolution rejects wrong source item identity fields', () => {
    const expectedProvenance: SourceIndexProvenance = {
      sourceItem: {
        family: 'email',
        provider: 'gmail',
        accountScope: 'personal',
        providerItemId: 'msg-1',
        providerThreadId: 'thread-expected',
        localItemId: 'personal:msg-1',
      },
    };
    const wrongThreadProvenance: SourceIndexProvenance = {
      sourceItem: {
        family: 'email',
        provider: 'gmail',
        accountScope: 'personal',
        providerItemId: 'msg-1',
        providerThreadId: 'thread-wrong',
        localItemId: 'personal:msg-1',
      },
    };
    const grade = gradeAnswer(
      {
        id: 'wrong-thread-citation',
        shape: 'locator',
        question: 'Where is the message?',
        expectedAnswerContains: ['msg-1'],
        expectedEvidence: [{ corpusId: 'internal.email', providerItemId: 'msg-1', hint: 'expected email thread' }],
      },
      {
        answer: 'The locator is msg-1.',
        citations: [{ provenance: wrongThreadProvenance, claim: 'wrong thread' }],
        unanswered: [],
      },
      undefined,
      {
        citationCorpusIds: [
          resolveCitationCorpusId(
            wrongThreadProvenance,
            [{
              provenance: expectedProvenance,
              trustTier: 'S2',
              trustDomain: 'internal',
              chunks: ['Expected thread locator msg-1.'],
            }],
            ['internal.email'],
          ),
        ],
      },
    );

    expect(expectedProvenance.sourceItem.providerThreadId).not.toBe(wrongThreadProvenance.sourceItem.providerThreadId);
    expect(grade.answerCorrect).toBe(true);
    expect(grade.evidenceCited).toBe(false);
    expect(grade.passed).toBe(false);
  });

  test('numeric expectations accept both decimal conventions', async () => {
    const commaModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'Your free testosterone was 16,4 pg/mL on 2025-04-22.',
            citations: [{ evidence: 1, claim: '16,4 pg/mL' }],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'comma-locale',
        };
      },
    };
    const report = await runEval(
      {
        version: 'test',
        description: 'decimal-convention fixture',
        questions: [{
          id: 'value-decimal',
          shape: 'value_lookup',
          question: 'What was my most recent free testosterone, and on what date?',
          expectedAnswerContains: ['16.4', '22/04/2025'],
          expectedEvidence: [{ corpusId: 'internal.dropbox.files', providerItemId: 'lab-2025', hint: 'lab PDF' }],
        }],
      },
      {
        buildPack: (question) => Promise.resolve({
          question: question.question,
          candidates: [candidate('lab-2025', ['Testosterona livre 16,4 pg/mL em 2025-04-22.'])],
          coverage: { searchedCorpora: ['internal.dropbox.files'], skippedCorpora: [], extractionGaps: [] },
          builtAt: '2026-05-28T00:00:00.000Z',
        }),
        analyst: createAnalyst(commaModel),
      },
    );

    expect(report.grades[0]!.answerCorrect).toBe(true);
    expect(report.passed).toBe(1);
  });

  test('rejects placeholder eval datasets before they can produce false confidence', async () => {
    const placeholderDataset: EvalDataset = {
      version: 'test',
      description: 'placeholder',
      questions: [{
        id: 'placeholder',
        shape: 'value_lookup',
        question: 'What was my most recent recorded {metric}?',
        expectedAnswerContains: [],
        expectedEvidence: [],
      }],
    };

    await expect(runEval(placeholderDataset, {
      buildPack: fixtureBuildPack,
      analyst: createAnalyst(scriptedModel()),
    })).rejects.toThrow('placeholders');
  });

  test('secure-local eval questions fail without an opsec audit', async () => {
    const secureDataset: EvalDataset = {
      version: 'test',
      description: 'secure fixture',
      questions: [{
        id: 'secure',
        shape: 'summary_or_sentiment',
        question: 'Summarize my secure lab result.',
        expectedAnswerContains: ['612 ng/dL'],
        expectedEvidence: [{ corpusId: 'secure_local.dropbox.health', providerItemId: 'secure-lab', hint: 'secure lab PDF' }],
        maxTrustDomain: 'secure_local',
      }],
    };
    const secureModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'The secure lab result says 612 ng/dL.',
            citations: [{ evidence: 1, claim: '612 ng/dL' }],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'secure-fixture',
        };
      },
    };
    const report = await runEval(secureDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('secure-lab', ['Total testosterone 612 ng/dL.'], { trustTier: 'S4', trustDomain: 'secure_local' })],
        coverage: { searchedCorpora: ['secure_local.dropbox.health'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(secureModel),
    });

    expect(report.passed).toBe(0);
    expect(report.grades[0]!.privacyRespected).toBe(false);
  });

  test('secure-local packs fail without an opsec audit even when question metadata omits maxTrustDomain', async () => {
    const secureDataset: EvalDataset = {
      version: 'test',
      description: 'secure pack fixture',
      questions: [{
        id: 'secure-pack-no-metadata',
        shape: 'summary_or_sentiment',
        question: 'Summarize my secure lab result.',
        expectedAnswerContains: ['612 ng/dL'],
        expectedEvidence: [{ corpusId: 'secure_local.dropbox.health', providerItemId: 'secure-lab', hint: 'secure lab PDF' }],
      }],
    };
    const secureModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'The secure lab result says 612 ng/dL.',
            citations: [{ evidence: 1, claim: '612 ng/dL' }],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'secure-pack-fixture',
        };
      },
    };
    const report = await runEval(secureDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('secure-lab', ['Total testosterone 612 ng/dL.'], { trustTier: 'S4', trustDomain: 'secure_local' })],
        coverage: { searchedCorpora: ['secure_local.dropbox.health'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(secureModel),
    });

    expect(report.passed).toBe(0);
    expect(report.grades[0]!.privacyRespected).toBe(false);
    expect(report.grades[0]!.detail).toContain(
      'privacyRespected: fail (secure-local or escalation result requires an opsec audit)',
    );
  });

  test('secure-local eval questions fail when release audit has no secure-local fact', async () => {
    const secureDataset: EvalDataset = {
      version: 'test',
      description: 'secure audit fixture',
      questions: [{
        id: 'secure-audit',
        shape: 'summary_or_sentiment',
        question: 'Summarize my secure lab result.',
        expectedAnswerContains: ['612 ng/dL'],
        expectedEvidence: [{ corpusId: 'secure_local.dropbox.health', providerItemId: 'secure-lab', hint: 'secure lab PDF' }],
        maxTrustDomain: 'secure_local',
      }],
    };
    const secureModel: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'The secure lab result says 612 ng/dL.',
            citations: [{ evidence: 1, claim: '612 ng/dL' }],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'secure-fixture',
        };
      },
    };
    const report = await runEval(secureDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('secure-lab', ['Total testosterone 612 ng/dL.'], { trustTier: 'S4', trustDomain: 'secure_local' })],
        coverage: { searchedCorpora: ['secure_local.dropbox.health'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(secureModel),
      auditFor: () => ({
        structured_evidence: [],
        release_decision: { decision: 'allow', reasons: ['release_gate_passed'] },
        raw_source_exposed: false,
      }),
    });

    expect(report.passed).toBe(0);
    expect(report.grades[0]!.privacyRespected).toBe(false);
    expect(report.grades[0]!.detail).toContain(
      'privacyRespected: secure-local answer released without secure-local structured evidence',
    );
  });

  test('product eval fixture passes mixed internal and secure-local synthesis with privacy audit', async () => {
    const productDataset: EvalDataset = {
      version: 'test',
      description: 'source-answer usability product fixture',
      questions: [{
        id: 'mixed-source-synthesis',
        shape: 'cross_source_synthesis',
        question: 'Combine the project deadline from Telegram with the estimate in my Dropbox note.',
        expectedAnswerContains: ['Telegram deadline', '2026-07-10', 'Dropbox estimate', '$4,800'],
        expectedEvidence: [
          { corpusId: 'internal.telegram.messages', providerItemId: 'telegram-deadline', hint: 'Telegram deadline message' },
          { corpusId: 'secure_local.dropbox.files', providerItemId: 'dropbox-estimate', hint: 'Dropbox estimate note' },
        ],
        maxTrustDomain: 'secure_local',
      }],
    };
    const model: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'The Telegram deadline is 2026-07-10, and the Dropbox estimate is $4,800.',
            citations: [
              { evidence: 1, claim: 'Telegram deadline 2026-07-10' },
              { evidence: 2, claim: 'Dropbox estimate $4,800' },
            ],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'product-synthesis-fixture',
        };
      },
    };
    const report = await runEval(productDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [
          candidate('telegram-deadline', ['Telegram deadline: 2026-07-10.'], {
            trustTier: 'S2',
            trustDomain: 'internal',
            corpusId: 'internal.telegram.messages',
          }),
          candidate('dropbox-estimate', ['Dropbox estimate: $4,800.'], {
            trustTier: 'S4',
            trustDomain: 'secure_local',
            corpusId: 'secure_local.dropbox.files',
          }),
        ],
        coverage: {
          searchedCorpora: ['internal.telegram.messages', 'secure_local.dropbox.files'],
          skippedCorpora: [],
          extractionGaps: [],
        },
        builtAt: '2026-06-16T00:00:00.000Z',
      }),
      analyst: createAnalyst(model),
      auditFor: () => ({
        structured_evidence: [{
          fact_id: 'dropbox-estimate',
          trust_tier: 'S4',
          trust_domain: 'secure_local',
          confidence: 'high',
          extraction_kind: 'quoted_fact',
          source_instruction_flags: [],
          release_surface: 'castor_answer',
          provenance_count: 1,
        }],
        release_decision: { decision: 'allow', reasons: ['bounded_secure_derivative_allowed'] },
        raw_source_exposed: false,
      }),
    });

    expect(report.passed).toBe(1);
    expect(report.grades[0]!).toMatchObject({
      answerCorrect: true,
      evidenceCited: true,
      gapHonest: true,
      privacyRespected: true,
      passed: true,
    });
  });

  test('product eval fixture requires selected complex-document extraction gaps to be reported', async () => {
    const productDataset: EvalDataset = {
      version: 'test',
      description: 'selected complex document fixture',
      questions: [{
        id: 'selected-scan-gap',
        shape: 'gap_honesty',
        question: 'Read the selected scanned Dropbox report and extract the table.',
        expectedAnswerContains: ['could not read'],
        mustReportGap: true,
      }],
    };
    const model: AnalystModel = {
      async complete() {
        return {
          text: JSON.stringify({
            answer: 'I could not read the selected scanned Dropbox report well enough to extract the table.',
            citations: [],
            unanswered: [
              'Selected scanned report.pdf (secure_local.dropbox.files) the PDF is metadata-only in the index; it may be scanned, rendered, image-only, or still awaiting OCR/VLM extraction.',
            ],
            sufficient: true,
          }),
          modelId: 'product-gap-fixture',
        };
      },
    };
    const report = await runEval(productDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('selected-scan', [], { trustTier: 'S4', trustDomain: 'secure_local' })],
        coverage: {
          searchedCorpora: ['secure_local.dropbox.files'],
          skippedCorpora: [],
          extractionGaps: [
            'Selected scanned report.pdf (secure_local.dropbox.files) the PDF is metadata-only in the index; it may be scanned, rendered, image-only, or still awaiting OCR/VLM extraction.',
          ],
        },
        builtAt: '2026-06-16T00:00:00.000Z',
      }),
      analyst: createAnalyst(model),
      auditFor: () => ({
        structured_evidence: [],
        release_decision: { decision: 'allow', reasons: ['unsupported_answer_released_without_source_content'] },
        raw_source_exposed: false,
      }),
    });

    expect(report.passed).toBe(1);
    expect(report.grades[0]!).toMatchObject({
      answerCorrect: true,
      gapHonest: true,
      passed: true,
    });
  });

  test('eval error reports do not include raw thrown error details', async () => {
    const errorDataset: EvalDataset = {
      version: 'test',
      description: 'error privacy fixture',
      questions: [{
        id: 'error-detail',
        shape: 'value_lookup',
        question: 'What was my error-only value?',
        expectedAnswerContains: ['never'],
      }],
    };
    const report = await runEval(errorDataset, {
      buildPack: () => {
        throw new Error('PRIVATE_TOKEN_123 Total testosterone 612 ng/dL');
      },
      analyst: createAnalyst(scriptedModel()),
      continueOnQuestionError: true,
    });

    expect(report.passed).toBe(0);
    expect(report.timings[0]!.status).toBe('error');
    expect(report.timings[0]!.error).toBe('Error');
    expect(report.grades[0]!.detail).toEqual(['evalError: Error']);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_TOKEN_123');
    expect(JSON.stringify(report)).not.toContain('612 ng/dL');
  });

  test('records per-question timing and partial reports when a question times out', async () => {
    const timeoutDataset: EvalDataset = {
      version: 'test',
      description: 'timeout fixture',
      questions: [{
        id: 'timeout',
        shape: 'value_lookup',
        question: 'What was my timeout-only value?',
        expectedAnswerContains: ['never'],
        expectedEvidence: [{ corpusId: 'internal.dropbox.files', providerItemId: 'never', hint: 'never' }],
      }, {
        id: 'unreached',
        shape: 'value_lookup',
        question: 'This question should not run after timeout.',
        expectedAnswerContains: ['unreached'],
        expectedEvidence: [{ corpusId: 'internal.dropbox.files', providerItemId: 'unreached', hint: 'unreached' }],
      }],
    };
    const partials: unknown[] = [];
    const progress: string[] = [];
    const hangingModel: AnalystModel = {
      async complete() {
        return new Promise(() => {});
      },
    };
    const report = await runEval(timeoutDataset, {
      buildPack: (question) => Promise.resolve({
        question: question.question,
        candidates: [candidate('never', ['The model never returns.'])],
        coverage: { searchedCorpora: ['internal.dropbox.files'], skippedCorpora: [], extractionGaps: [] },
        builtAt: '2026-05-28T00:00:00.000Z',
      }),
      analyst: createAnalyst(hangingModel),
      questionTimeoutMs: 5,
      continueOnQuestionError: true,
      stopOnQuestionTimeout: true,
      onProgress(event) {
        progress.push(event.type === 'phase_started' ? `${event.type}:${event.phase}` : event.type);
      },
      onPartialReport(partial) {
        partials.push(partial);
      },
    });

    expect(report.total).toBe(2);
    expect(report.completed).toBe(1);
    expect(report.remaining).toBe(1);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(2);
    expect(report.grades[0]!.detail[0]).toContain('timed out');
    expect(report.timings[0]!).toMatchObject({
      questionId: 'timeout',
      status: 'timeout',
      lastPhase: 'analyst',
    });
    expect(progress).toEqual([
      'question_started',
      'phase_started:build_pack',
      'phase_finished',
      'phase_started:analyst',
      'question_finished',
    ]);
    expect(partials).toHaveLength(1);
  });
});

import { describe, expect, test } from 'bun:test';
import { classifyPrecisionStage, summarizePrecisionTraces } from '../eval/diagnose.ts';
import type { AnalystResult, EvidenceCandidate, EvidencePack } from '../src/core/contracts.ts';
import type { EvalQuestion } from '../eval/types.ts';

function candidate(chunks: string[], id = 'id', corpusId?: string): EvidenceCandidate {
  return {
    provenance: {
      sourceItem: {
        family: 'file',
        provider: 'dropbox',
        accountScope: 'personal',
        providerItemId: id,
        localItemId: `personal:${id}`,
      },
      ...(corpusId ? { localIds: { corpus_id: corpusId } } : {}),
    } as EvidenceCandidate['provenance'],
    trustTier: 'S4',
    trustDomain: 'secure_local',
    chunks,
  };
}

function pack(candidates: EvidenceCandidate[]): EvidencePack {
  return {
    question: 'q',
    candidates,
    coverage: { searchedCorpora: [], skippedCorpora: [], extractionGaps: [] },
    builtAt: '2026-06-13T00:00:00.000Z',
  };
}

function result(answer: string): AnalystResult {
  return { answer, citations: [], unanswered: [] } as AnalystResult;
}

function citedResult(answer: string, ids: string[], corpusIds?: string[]): AnalystResult {
  return {
    answer,
    citations: ids.map((id, index) => ({
      provenance: {
        sourceItem: {
          family: 'file',
          provider: 'dropbox',
          accountScope: 'personal',
          providerItemId: id,
          localItemId: `personal:${id}`,
        },
        ...(corpusIds?.[index] ? { localIds: { corpus_id: corpusIds[index] } } : {}),
      } as EvidenceCandidate['provenance'],
      claim: `claim from ${id}`,
    })),
    unanswered: [],
  };
}

const question: EvalQuestion = {
  id: 'value-x',
  shape: 'value_lookup',
  question: 'what is the ratio?',
  expectedAnswerContains: ['0.415'],
};

describe('classifyPrecisionStage', () => {
  test('ok when the answer contains the expected value', () => {
    const trace = classifyPrecisionStage(question, pack([candidate(['ratio was 0.415'])]), result('The ratio was 0.415.'));
    expect(trace.stage).toBe('ok');
    expect(trace.answerCorrect).toBe(true);
  });

  test('retrieval_miss when the value is in no candidate', () => {
    const trace = classifyPrecisionStage(question, pack([candidate(['unrelated text']), candidate(['also nothing'])]), result('I could not find it.'));
    expect(trace.stage).toBe('retrieval_miss');
    expect(trace.valuesInPack).toBe(0);
    expect(trace.bestRank).toBe(-1);
  });

  test('analyst_miss when the value is in a top candidate but the answer is wrong', () => {
    const trace = classifyPrecisionStage(question, pack([candidate(['the ratio was 0.415 exactly'])]), result('I am not sure of the ratio.'));
    expect(trace.stage).toBe('analyst_miss');
    expect(trace.bestRank).toBe(0);
    expect(trace.valuesInPack).toBe(1);
  });

  test('analyst_miss when the missing value is present in citation provenance', () => {
    const datedCandidate: EvidenceCandidate = {
      ...candidate(['The report contains the requested measurement.']),
      provenance: {
        ...candidate([]).provenance,
        citation: {
          title: '2026-08-21 Measurement.pdf',
          sourceLabel: 'Dropbox',
          uri: '/Approved/2026-08-21 Measurement.pdf',
          authoredAt: '2026-08-21T09:00:00.000Z',
        },
      },
    };
    const trace = classifyPrecisionStage(
      {
        id: 'dated-value',
        shape: 'value_lookup',
        question: 'What date was the measurement recorded?',
        expectedAnswerContains: ['2026-08-21'],
      },
      pack([datedCandidate]),
      result('The report contains the measurement, but I omitted its date.'),
    );

    expect(trace.stage).toBe('analyst_miss');
    expect(trace.valuesInPack).toBe(1);
    expect(trace.bestRank).toBe(0);
  });

  test('ranking_buried when the value is present only deep in the list', () => {
    const cands = [
      ...Array.from({ length: 9 }, () => candidate(['noise'])),
      candidate(['the ratio was 0.415']),
    ];
    const trace = classifyPrecisionStage(question, pack(cands), result('Not sure.'), { topCandidateThreshold: 8 });
    expect(trace.stage).toBe('ranking_buried');
    expect(trace.deepestNeededRank).toBe(9);
  });

  test('numeric form equivalence (decimal comma) matches', () => {
    const trace = classifyPrecisionStage(question, pack([candidate(['o valor foi 0,415 hoje'])]), result('nope'));
    expect(trace.valuesInPack).toBe(1);
    expect(trace.stage).toBe('analyst_miss');
  });

  test('expected_evidence_mismatch when expected evidence is present but hydrated text lacks the target content', () => {
    const q: EvalQuestion = {
      id: 'synth',
      shape: 'cross_source_synthesis',
      question: 'What are the P95 TTFT and Energy Efficiency Rating?',
      expectedAnswerContains: ['0.640', 'G'],
      expectedEvidence: [
        { corpusId: 'secure_local.dropbox.files', providerItemId: 'bench', hint: 'benchmark PDF' },
        { corpusId: 'secure_local.dropbox.files', providerItemId: 'rating', hint: 'energy rating PDF' },
      ],
    };
    const trace = classifyPrecisionStage(
      q,
      pack([
        candidate(['Gemma P95 TTFT is 0.640 s.'], 'bench', 'secure_local.dropbox.files'),
        candidate(['Opening page with unrelated property survey text.'], 'rating', 'secure_local.dropbox.files'),
      ]),
      citedResult('The P95 TTFT is 0.640 s and the Energy Efficiency Rating is G.', ['bench'], ['secure_local.dropbox.files']),
    );

    expect(trace.stage).toBe('expected_evidence_mismatch');
    expect(trace.expectedEvidenceIssues).toBe(1);
    expect(trace.expectedCitationMisses).toBe(1);
    expect(trace.note).toContain('repair eval expectation or extraction');
  });

  test('expected_evidence_mismatch ignores common question filler words', () => {
    const q: EvalQuestion = {
      id: 'synth-common',
      shape: 'cross_source_synthesis',
      question: 'Looking across my documents: what are my recorded values for Gemma P95 TTFT and Energy Efficiency Rating? Cite the document for each.',
      expectedAnswerContains: ['0.640', 'G'],
      expectedEvidence: [
        { corpusId: 'secure_local.dropbox.files', providerItemId: 'bench', hint: 'benchmark PDF' },
        { corpusId: 'secure_local.dropbox.files', providerItemId: 'rating', hint: 'energy rating PDF' },
      ],
    };
    const trace = classifyPrecisionStage(
      q,
      pack([
        candidate(['Gemma P95 TTFT is 0.640 s.'], 'bench', 'secure_local.dropbox.files'),
        candidate(['Opening page and unrelated property survey for a house.'], 'rating', 'secure_local.dropbox.files'),
      ]),
      citedResult('The P95 TTFT is 0.640 s and the Energy Efficiency Rating is G.', ['bench'], ['secure_local.dropbox.files']),
    );

    expect(trace.stage).toBe('expected_evidence_mismatch');
    expect(trace.expectedEvidenceIssues).toBe(1);
  });

  test('expected_evidence_mismatch matches substantive question terms as tokens', () => {
    const q: EvalQuestion = {
      id: 'synth-token',
      shape: 'cross_source_synthesis',
      question: 'What is the rating?',
      expectedAnswerContains: ['G'],
      expectedEvidence: [
        { corpusId: 'secure_local.dropbox.files', providerItemId: 'rating', hint: 'energy rating PDF' },
      ],
    };
    const trace = classifyPrecisionStage(
      q,
      pack([candidate(['Operating notes only; no energy assessment value.'], 'rating', 'secure_local.dropbox.files')]),
      citedResult('The Energy Efficiency Rating is G.', []),
    );

    expect(trace.stage).toBe('expected_evidence_mismatch');
    expect(trace.expectedEvidenceIssues).toBe(1);
  });

  test('citation_miss when values are correct but expected evidence was not cited', () => {
    const q: EvalQuestion = {
      id: 'synth-citation',
      shape: 'cross_source_synthesis',
      question: 'What are the P95 TTFT and Energy Efficiency Rating?',
      expectedAnswerContains: ['0.640', 'G'],
      expectedEvidence: [
        { corpusId: 'secure_local.dropbox.files', providerItemId: 'bench', hint: 'benchmark PDF' },
        { corpusId: 'secure_local.dropbox.files', providerItemId: 'rating', hint: 'energy rating PDF' },
      ],
    };
    const trace = classifyPrecisionStage(
      q,
      pack([
        candidate(['Gemma P95 TTFT is 0.640 s.'], 'bench', 'secure_local.dropbox.files'),
        candidate(['Energy Efficiency Rating: G.'], 'rating', 'secure_local.dropbox.files'),
      ]),
      citedResult('The P95 TTFT is 0.640 s and the Energy Efficiency Rating is G.', ['bench'], ['secure_local.dropbox.files']),
    );

    expect(trace.stage).toBe('citation_miss');
    expect(trace.expectedCitationMisses).toBe(1);
    expect(trace.expectedEvidenceIssues).toBe(0);
  });

  test('citation_miss when the cited provider item id belongs to the wrong corpus', () => {
    const q: EvalQuestion = {
      id: 'corpus-citation',
      shape: 'value_lookup',
      question: 'What is the secure lab value?',
      expectedAnswerContains: ['612'],
      expectedEvidence: [
        { corpusId: 'secure_local.dropbox.health', providerItemId: 'shared-lab', hint: 'secure lab PDF' },
      ],
    };
    const trace = classifyPrecisionStage(
      q,
      pack([
        candidate(['Internal mirror value: 612.'], 'shared-lab', 'internal.dropbox.health'),
        candidate(['Secure value: 612.'], 'shared-lab', 'secure_local.dropbox.health'),
      ]),
      citedResult('The value is 612.', ['shared-lab'], ['internal.dropbox.health']),
    );

    expect(trace.stage).toBe('citation_miss');
    expect(trace.expectedCitationMisses).toBe(1);
    expect(trace.expectedEvidenceIssues).toBe(0);
  });

  test('citation_miss when corpus-only expected evidence has no citation', () => {
    const q: EvalQuestion = {
      id: 'corpus-only-citation',
      shape: 'value_lookup',
      question: 'What is the secure lab value?',
      expectedAnswerContains: ['612'],
      expectedEvidence: [
        { corpusId: 'secure_local.dropbox.health', hint: 'secure health corpus' },
      ],
    };
    const trace = classifyPrecisionStage(
      q,
      pack([candidate(['Secure value: 612.'], 'secure-lab', 'secure_local.dropbox.health')]),
      citedResult('The value is 612.', []),
    );

    expect(trace.stage).toBe('citation_miss');
    expect(trace.expectedCitationMisses).toBe(1);
    expect(trace.expectedEvidenceIssues).toBe(0);
  });

  test('evidence-only expectations still diagnose missing citations', () => {
    const q: EvalQuestion = {
      id: 'locator-only',
      shape: 'locator',
      question: 'Where is the project receipt?',
      expectedAnswerContains: [],
      expectedEvidence: [
        { corpusId: 'internal.dropbox.files', providerItemId: 'receipt', hint: 'project receipt PDF' },
      ],
    };
    const trace = classifyPrecisionStage(
      q,
      pack([candidate(['Project receipt path /Finance/receipt.pdf'], 'receipt', 'internal.dropbox.files')]),
      result('The receipt is in /Finance/receipt.pdf.'),
    );

    expect(trace.stage).toBe('citation_miss');
    expect(trace.expectedCitationMisses).toBe(1);
    expect(trace.note).toContain('locator/evidence-only question missed');
  });

  test('values present only in evidence tables count as present in the pack', () => {
    const tableCandidate: EvidenceCandidate = {
      ...candidate(['Lab summary text without the value.'], 'table-lab', 'internal.dropbox.files'),
      tables: [{
        caption: 'Lab table',
        columns: ['metric', 'value'],
        rows: [['Total testosterone', '612 ng/dL']],
      }],
    };
    const trace = classifyPrecisionStage(
      {
        id: 'table-only-value',
        shape: 'value_lookup',
        question: 'What was the total testosterone?',
        expectedAnswerContains: ['612 ng/dL'],
      },
      pack([tableCandidate]),
      result('I am not sure.'),
    );

    expect(trace.stage).toBe('analyst_miss');
    expect(trace.valuesInPack).toBe(1);
    expect(trace.bestRank).toBe(0);
  });

  test('no_expectations for value-less questions', () => {
    const q: EvalQuestion = { id: 'neg', shape: 'coverage_negative', question: 'anything?', mustReportGap: true };
    const trace = classifyPrecisionStage(q, pack([candidate(['x'])]), result('I have nothing.'));
    expect(trace.stage).toBe('no_expectations');
  });

  test('summary attributes each stage to a lever', () => {
    const summary = summarizePrecisionTraces([
      classifyPrecisionStage(question, pack([candidate(['nope'])]), result('no')),
      classifyPrecisionStage(question, pack([candidate(['0.415 here'])]), result('no')),
    ]);
    expect(summary.byStage.retrieval_miss).toBe(1);
    expect(summary.byStage.analyst_miss).toBe(1);
    expect(summary.byStage.expected_evidence_mismatch).toBe(0);
    expect(summary.byStage.citation_miss).toBe(0);
    expect(summary.recommendation).toContain('recall');
    expect(summary.recommendation).toContain('reasoning');
  });
});

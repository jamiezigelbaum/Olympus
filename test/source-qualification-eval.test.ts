import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSourceQualificationEvalReceipt,
  createAuthenticatedSourceAnswerEvalAdapter,
  createInProcessSourceAnswerEvalAdapter,
  legacyCitationRecall,
  runProvisionalQualificationContract,
  runSourceQualificationEval,
  verifySourceQualificationEvalReceipt,
  type SourceQualificationEvalReceipt,
} from '../eval/qualification.ts';
import type { EvalDataset } from '../eval/types.ts';
import { createAnalyst } from '../src/core/analyst.ts';
import type {
  SourceIndexAnswerEvidence,
  SourceIndexAnswerHandler,
  SourceIndexAnswerResult,
} from '../src/workers/source-index/answer-types.ts';
import {
  createXBookmarksConnectorStore,
  createXBookmarksQualificationLoopback,
  createXBookmarksSourceConnector,
} from '../src/workers/x-bookmarks/index.ts';

const CANONICAL_URI = 'https://x.com/i/web/status/legacy-0';
const PRIVATE_QUESTION_TEXT = 'PRIVATE held-out qualification question';
const PRIVATE_HINT = 'PRIVATE expected bookmark';

const qualificationDataset: EvalDataset = {
  version: 'fixture',
  description: 'private fixture stand-in',
  questions: [
    {
      id: 'private-positive-id',
      shape: 'locator',
      question: PRIVATE_QUESTION_TEXT,
      expectedAnswerContains: ['qualified answer'],
      expectedEvidence: [{
        corpusId: 'internal.x.bookmarks',
        providerItemId: 'legacy-0',
        uri: CANONICAL_URI,
        hint: PRIVATE_HINT,
      }],
      maxDurationMs: 60_000,
    },
    {
      id: 'private-window-id',
      shape: 'coverage_negative',
      question: 'PRIVATE question outside provider coverage',
      mustReportGap: true,
    },
  ],
};

describe('source-generic qualification eval', () => {
  test('runs the existing grader through an in-process source_answer adapter', async () => {
    const run = await runQualificationFixture();

    expect(run.authority).toBe('connector_store_loopback');
    expect(run.report).toMatchObject({ total: 2, passed: 2, failed: 0 });
    expect(run.comparisons).toEqual([{
      questionOrdinal: 1,
      legacyCitationRecall: 1,
      countDriftRatio: 0.1,
      connectorAnswered: true,
      passed: true,
    }]);
  });

  test('a confident cited answer still fails a must-report-gap question', async () => {
    const dataset: EvalDataset = {
      version: 'fixture',
      description: 'confident false-positive fixture',
      questions: [{
        id: 'confident-gap',
        shape: 'coverage_negative',
        question: 'Question requiring an honest gap.',
        mustReportGap: true,
      }],
    };
    const handler: SourceIndexAnswerHandler = {
      async answer() {
        return positiveWireResult();
      },
    };
    const run = await runSourceQualificationEval(dataset, {
      adapter: createInProcessSourceAnswerEvalAdapter({
        handler,
        requestForQuestion: (question) => ({
          question: question.question,
          corpus_id: 'internal.x.bookmarks',
        }),
        coverageForResult: () => ({
          searchedCorpora: ['internal.x.bookmarks'],
          skippedCorpora: [],
          extractionGaps: [],
        }),
      }),
    });

    expect(run.report).toMatchObject({ passed: 0, failed: 1 });
    expect(run.report.grades[0]).toMatchObject({
      gapHonest: false,
      passed: false,
    });
    expect(run.report.grades[0]!.detail).toContain(
      'gapHonest: no genuine structured coverage degradation supported the reported gap',
    );
  });

  test('the thin X loopback evaluates the real connector-store answer path while ordinary authority stays external', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-x-qualification-loopback-'));
    const store = createXBookmarksConnectorStore(join(root, 'x-store.sqlite'));
    try {
      const connector = createXBookmarksSourceConnector({
        account: 'personal',
        posts: [{
          id: '9001',
          text: 'Qualification marker from the connector store.',
          url: 'https://x.com/modelmaker/status/9001',
        }],
        fetchedAt: '2026-07-23T00:00:00.000Z',
      });
      await store.syncFromConnector(connector, { fetchContent: true });
      const handler = createXBookmarksQualificationLoopback({
        store,
        account: 'personal',
        analyst: createAnalyst({
          async complete() {
            return {
              text: JSON.stringify({
                answer: 'The connector-store qualification marker is present.',
                citations: [{ evidence: 1, claim: 'Qualification marker is present' }],
                unanswered: [],
                sufficient: true,
              }),
              modelId: 'scripted-qualification',
            };
          },
        }),
      });
      const dataset: EvalDataset = {
        version: 'fixture',
        description: 'real X loopback fixture',
        questions: [{
          id: 'x-loopback',
          shape: 'locator',
          question: 'Find the qualification marker.',
          expectedAnswerContains: ['qualification marker'],
          expectedEvidence: [{
            corpusId: 'internal.x.bookmarks',
            providerItemId: '9001',
            uri: 'https://x.com/i/web/status/9001',
            hint: 'fixture X post',
          }],
        }],
      };
      const run = await runSourceQualificationEval(dataset, {
        adapter: createInProcessSourceAnswerEvalAdapter({
          handler,
          requestForQuestion: (question) => ({
            question: question.question,
            query: 'qualification marker',
            account: 'personal',
            corpus_id: 'internal.x.bookmarks',
          }),
        }),
      });

      expect(run.report).toMatchObject({ total: 1, passed: 1, failed: 0 });
      expect(run.report.grades[0]).toMatchObject({
        answerCorrect: true,
        evidenceCited: true,
      });
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runs the same dataset through authenticated /v1/source/answer', async () => {
    const requests: Request[] = [];
    const adapter = createAuthenticatedSourceAnswerEvalAdapter({
      endpoint: 'http://127.0.0.1:8010/v1/source/answer',
      authorization: 'Bearer fixture-worker-token',
      requestForQuestion: (question) => ({
        question: question.question,
        corpus_id: 'internal.x.bookmarks',
      }),
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(
          requests.length === 1 ? positiveWireResult() : providerWindowWireResult(),
        );
      },
    });
    const run = await runSourceQualificationEval(qualificationDataset, {
      adapter,
      legacyObservations: [{
        questionOrdinal: 1,
        answered: true,
        citationIds: Array.from({ length: 10 }, (_, index) => `legacy-${index}`),
      }],
    });

    expect(run.authority).toBe('authenticated_source_answer');
    expect(run.report.failed).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer fixture-worker-token');
    expect(new URL(requests[0]!.url).pathname).toBe('/v1/source/answer');
  });

  test('reuses legacy recall semantics and still requires an answer for an empty legacy set', async () => {
    expect(legacyCitationRecall([], [])).toBe(1);
    expect(legacyCitationRecall(
      Array.from({ length: 10 }, (_, index) => `legacy-${index}`),
      [...Array.from({ length: 10 }, (_, index) => `legacy-${index}`), 'improvement'],
    )).toBe(1);

    const oneQuestion = {
      ...qualificationDataset,
      questions: [qualificationDataset.questions[0]!],
    };
    const handler: SourceIndexAnswerHandler = {
      answer: async () => wireResult({ answer: '', evidence: [] }),
    };
    const run = await runSourceQualificationEval(oneQuestion, {
      adapter: createInProcessSourceAnswerEvalAdapter({
        handler,
        requestForQuestion: (question) => ({ question: question.question }),
      }),
      legacyObservations: [{
        questionOrdinal: 1,
        answered: false,
        citationIds: [],
      }],
    });

    expect(run.comparisons[0]).toMatchObject({
      legacyCitationRecall: 1,
      connectorAnswered: false,
      passed: false,
    });
  });

  test('projects a green content-free receipt and verifies every binding', async () => {
    const run = await runQualificationFixture();
    const receipt = buildSourceQualificationEvalReceipt(
      qualificationDataset,
      run,
      receiptBindings(),
    );

    expect(receipt).toMatchObject({
      kind: 'source_qualification_eval_receipt',
      source: 'x',
      status: 'green',
      checks: {
        positive_cases: 1,
        coverage_gap_cases: 1,
        exact_citation_cases: 1,
        legacy_comparison_cases: 1,
        ordinary_under_60s_cases: 1,
        required_set_present: true,
      },
      evaluation: {
        passed: 2,
        failed: 0,
        legacy_min_recall: 1,
        max_count_drift_ratio: 0.1,
        comparisons_passed: true,
      },
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(PRIVATE_QUESTION_TEXT);
    expect(serialized).not.toContain(PRIVATE_HINT);
    expect(serialized).not.toContain('private-positive-id');
    expect(serialized).not.toContain('legacy-0');
    expect(serialized).not.toContain(CANONICAL_URI);
    expect(receipt.receipt_sha256).toMatch(/^[a-f0-9]{64}$/);

    expect(() => verifySourceQualificationEvalReceipt(
      receipt,
      receiptExpectation(),
    )).not.toThrow();
    expect(() => verifySourceQualificationEvalReceipt(
      receipt,
      { ...receiptExpectation(), gitSha: 'f'.repeat(40) },
    )).toThrow('binding mismatch');
    expect(() => verifySourceQualificationEvalReceipt(
      receipt,
      { ...receiptExpectation(), storeSha256: 'e'.repeat(64) },
    )).toThrow('binding mismatch');
    expect(() => verifySourceQualificationEvalReceipt(
      receipt,
      { ...receiptExpectation(), asOf: '2026-07-23T01:00:01.000Z' },
    )).toThrow('stale');

    const tampered = structuredClone(receipt);
    tampered.evaluation.passed = 1;
    expect(() => verifySourceQualificationEvalReceipt(
      tampered,
      receiptExpectation(),
    )).toThrow('report digest mismatch');
  });

  // The manifest binding moved from the whole file to the source-critical
  // projection, exactly as the X activation receipt's v3 did. Receipts banked
  // under either scope keep verifying, and neither scope stands in for the
  // other.
  test('binds exactly one manifest scope, and verifies v1 and v2 receipts against their own', async () => {
    const run = await runQualificationFixture();
    const projectionSha256 = '4'.repeat(64);
    const { manifestSha256, ...unboundBindings } = receiptBindings();
    const { manifestSha256: _expectedWholeFile, ...unboundExpectation } = receiptExpectation();
    const projected = buildSourceQualificationEvalReceipt(qualificationDataset, run, {
      ...unboundBindings,
      manifestXProjectionSha256: projectionSha256,
    });
    const wholeFile = buildSourceQualificationEvalReceipt(
      qualificationDataset,
      run,
      receiptBindings(),
    );

    expect(projected.version).toBe(2);
    expect(projected.bindings).toMatchObject({ manifest_x_projection_sha256: projectionSha256 });
    expect(projected.bindings).not.toHaveProperty('manifest_sha256');
    expect(wholeFile.version).toBe(1);
    expect(wholeFile.bindings).not.toHaveProperty('manifest_x_projection_sha256');
    // Same evidence, different binding scope: the self-digest must differ.
    expect(projected.receipt_sha256).not.toBe(wholeFile.receipt_sha256);

    // A verifier holding both digests accepts each receipt against its own.
    const both = { ...receiptExpectation(), manifestXProjectionSha256: projectionSha256 };
    expect(() => verifySourceQualificationEvalReceipt(projected, both)).not.toThrow();
    expect(() => verifySourceQualificationEvalReceipt(wholeFile, both)).not.toThrow();

    // Projection drift refuses, and so does either scope standing in for the
    // other or going unsupplied.
    expect(() => verifySourceQualificationEvalReceipt(projected, {
      ...both,
      manifestXProjectionSha256: '5'.repeat(64),
    })).toThrow('binding mismatch');
    expect(() => verifySourceQualificationEvalReceipt(projected, receiptExpectation()))
      .toThrow('binding mismatch');
    expect(() => verifySourceQualificationEvalReceipt(wholeFile, {
      ...unboundExpectation,
      manifestXProjectionSha256: projectionSha256,
    })).toThrow('binding mismatch');

    expect(() => buildSourceQualificationEvalReceipt(qualificationDataset, run, unboundBindings))
      .toThrow('exactly one manifest scope');
    expect(() => buildSourceQualificationEvalReceipt(qualificationDataset, run, {
      ...receiptBindings(),
      manifestXProjectionSha256: projectionSha256,
    })).toThrow('exactly one manifest scope');
  });

  test('post-flip red calls rollback and proves legacy authority was restored', async () => {
    let authority: 'legacy_index' | 'connector_store' = 'legacy_index';
    let rollbackCalls = 0;
    const red = {
      ...buildSourceQualificationEvalReceipt(
        qualificationDataset,
        await runQualificationFixture(),
        receiptBindings(),
      ),
      status: 'red' as const,
    };

    await expect(runProvisionalQualificationContract({
      async flipToConnectorStore() {
        authority = 'connector_store';
      },
      async runPostFlipEval() {
        return red;
      },
      async rollbackToLegacy() {
        rollbackCalls += 1;
        authority = 'legacy_index';
      },
      async readAuthority() {
        return authority;
      },
    })).rejects.toThrow('was red');

    expect(rollbackCalls).toBe(1);
    expect(authority).toBe('legacy_index');
  });
});

async function runQualificationFixture() {
  const handler: SourceIndexAnswerHandler = {
    async answer(request) {
      return request.question === PRIVATE_QUESTION_TEXT
        ? positiveWireResult()
        : providerWindowWireResult();
    },
  };
  return runSourceQualificationEval(qualificationDataset, {
    adapter: createInProcessSourceAnswerEvalAdapter({
      handler,
      requestForQuestion: (question) => ({
        question: question.question,
        corpus_id: 'internal.x.bookmarks',
      }),
    }),
    legacyObservations: [{
      questionOrdinal: 1,
      answered: true,
      citationIds: Array.from({ length: 10 }, (_, index) => `legacy-${index}`),
    }],
  });
}

function positiveWireResult(): SourceIndexAnswerResult {
  return wireResult({
    answer: 'This is the qualified answer.',
    evidence: [
      ...Array.from({ length: 10 }, (_, index) => evidence(
        `legacy-${index}`,
        index === 0 ? CANONICAL_URI : `https://x.com/i/web/status/legacy-${index}`,
      )),
      evidence('connector-improvement', 'https://x.com/i/web/status/connector-improvement'),
    ],
  });
}

function providerWindowWireResult(): SourceIndexAnswerResult {
  return wireResult({
    answer: 'No supported answer.\n\nCoverage notes:\n- Source coverage is limited by the provider window.',
    evidence: [],
    skipped: [{ corpus_id: 'internal.x.bookmarks', trust_domain: 'internal', reason: 'provider_window_cap' }],
  });
}

function evidence(providerItemId: string, uri: string): SourceIndexAnswerEvidence {
  return {
    corpus_id: 'internal.x.bookmarks',
    trust_domain: 'internal',
    family: 'x',
    provider: 'x',
    provider_item_id: providerItemId,
    uri,
  };
}

function wireResult(options: {
  answer: string;
  evidence: SourceIndexAnswerEvidence[];
  skipped?: SourceIndexAnswerResult['audit']['skipped_corpora'];
}): SourceIndexAnswerResult {
  return {
    answer: options.answer,
    evidence: options.evidence,
    audit: {
      searched_corpora: ['internal.x.bookmarks'],
      skipped_corpora: options.skipped ?? [],
      lane_audits: [],
      answer_synthesis: {
        private_context_used: false,
        secure_local_items_consulted: 0,
        internal_content_used: options.evidence.length > 0,
        internal_items_consulted: options.evidence.length,
        internal_content_failures: 0,
        analyst_backend: 'local',
        raw_source_exposed: false,
      },
      latency_ms: 1,
      raw_source_exposed: false,
    },
    policy: {
      raw_source_exposed: false,
      source_packets_exposed: false,
      internal_content_exposed: options.evidence.length > 0,
      secure_local_content_exposed: false,
      castor_safe_bridge: true,
    },
    opsec: {
      structured_evidence: [],
      release_decision: { decision: 'allow', reasons: ['release_gate_passed'] },
      raw_source_exposed: false,
    },
  };
}

function receiptBindings() {
  return {
    source: 'x',
    gitSha: 'a'.repeat(40),
    sourceWorkerPid: 4242,
    sourceWorkerCwdSha256: 'b'.repeat(64),
    storeSha256: 'c'.repeat(64),
    storeSchemaVersion: 7,
    preservationReceiptSha256: 'd'.repeat(64),
    reconcileReceiptSha256: '1'.repeat(64),
    manifestSha256: '2'.repeat(64),
    dropinSha256: '3'.repeat(64),
    authorityBefore: 'legacy_index' as const,
    authorityAfter: 'connector_store' as const,
    evaluatedAt: '2026-07-23T00:00:00.000Z',
    expiresAt: '2026-07-23T01:00:00.000Z',
  };
}

function receiptExpectation() {
  const bindings = receiptBindings();
  return {
    source: bindings.source,
    evalSurface: 'connector_store_loopback' as const,
    gitSha: bindings.gitSha,
    sourceWorkerPid: bindings.sourceWorkerPid,
    sourceWorkerCwdSha256: bindings.sourceWorkerCwdSha256,
    storeSha256: bindings.storeSha256,
    storeSchemaVersion: bindings.storeSchemaVersion,
    preservationReceiptSha256: bindings.preservationReceiptSha256,
    reconcileReceiptSha256: bindings.reconcileReceiptSha256,
    manifestSha256: bindings.manifestSha256,
    dropinSha256: bindings.dropinSha256,
    authorityBefore: bindings.authorityBefore,
    authorityAfter: bindings.authorityAfter,
    asOf: '2026-07-23T00:30:00.000Z',
  };
}

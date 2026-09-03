import { describe, expect, test } from 'bun:test';
import {
  buildSourceAnswerLatencyRollup,
  evaluateLatencyGate,
  latencyPercentiles,
  parseSourceAnswerLatencyJsonl,
} from '../scripts/source-answer-latency-rollup.ts';
import type {
  SourceAnswerLatencyLedgerRecord,
  SourceAnswerLatencyRecord,
  SourceAnswerLatencyTraceRecord,
} from '../src/workers/source-index/answer-latency-log.ts';

describe('source_answer latency rollup math', () => {
  test('uses nearest-rank percentiles', () => {
    expect(latencyPercentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({
      samples: 10,
      p50: 5,
      p90: 9,
      p95: 10,
      max: 10,
    });
  });

  test('does not pass or fail a gate before 20 natural samples', () => {
    expect(evaluateLatencyGate(Array.from({ length: 19 }, () => 1_000), 60_000)).toEqual({
      threshold_ms: 60_000,
      natural_samples: 19,
      p95_ms: 1_000,
      state: 'insufficient_samples',
    });
    expect(evaluateLatencyGate(Array.from({ length: 20 }, () => 59_999), 60_000).state).toBe('pass');
    expect(evaluateLatencyGate(Array.from({ length: 20 }, () => 60_000), 60_000).state).toBe('fail');
  });

  test('deduplicates additive v1/v2 pairs and excludes probes from the phase-6 gate', () => {
    const records: SourceAnswerLatencyLedgerRecord[] = [];
    for (let index = 0; index < 20; index += 1) {
      const loggedAt = `2026-07-23T12:00:${String(index).padStart(2, '0')}.000Z`;
      records.push(v1Fixture(loggedAt, 30_000 + index));
      records.push(v2Fixture({
        loggedAt,
        latencyMs: 30_000 + index,
        compatV1LoggedAt: loggedAt,
        sampleKind: 'natural',
        fallback: index < 10,
      }));
    }
    records.push(v2Fixture({
      loggedAt: '2026-07-23T12:01:00.000Z',
      latencyMs: 600_000,
      sampleKind: 'probe',
      fallback: false,
    }));

    const rollup = buildSourceAnswerLatencyRollup({
      records,
      now: () => new Date('2026-07-23T13:00:00.000Z'),
    });

    expect(rollup.records_read).toBe(41);
    expect(rollup.schema_records).toEqual({ v1: 20, v2: 21 });
    expect(rollup.samples).toEqual({ total: 21, natural: 20, probe: 1 });
    expect(rollup.phase_6_gates.ordinary_answer.state).toBe('pass');
    expect(rollup.phase_6_gates.ordinary_answer.natural_samples).toBe(20);
    expect(rollup.phase_6_gates.status.state).toBe('insufficient_samples');
    expect(rollup.fallback).toEqual({
      eligible_samples: 21,
      fallback_samples: 10,
      share: 0.4762,
    });
    expect(rollup.splits.backend.find((split) => split.key === 'local')?.samples).toBe(21);
    expect(rollup.splits.trust_route.find((split) => split.key === 'venice>local')?.samples).toBe(10);
    expect(rollup.splits.outcome).toEqual([
      expect.objectContaining({ key: 'success', samples: 21 }),
    ]);
    expect(rollup.phases_ms.hydration_ms?.samples).toBe(21);
    // Planner counts cover every normalized sample, probes included, as fallback does.
    expect(rollup.query_planner.awaited_count).toBe(21);
    expect(rollup.sample_classification).toContain('excluded');
  });

  test('reads both schemas and counts malformed lines without reflecting their content', () => {
    const v1 = v1Fixture('2026-07-23T12:00:00.000Z', 1_000);
    const v2 = v2Fixture({
      loggedAt: '2026-07-23T12:00:01.000Z',
      latencyMs: 2_000,
      sampleKind: 'natural',
      fallback: false,
    });
    const parsed = parseSourceAnswerLatencyJsonl([
      JSON.stringify(v1),
      'SECRET-QUESTION malformed',
      JSON.stringify(v2),
      JSON.stringify({ kind: 'unexpected', answer: 'SECRET-ANSWER' }),
    ].join('\n'));
    expect(parsed.records).toHaveLength(2);
    expect(parsed.malformedLines).toBe(2);
    const serialized = JSON.stringify(buildSourceAnswerLatencyRollup({
      records: parsed.records,
      malformedLines: parsed.malformedLines,
    }));
    expect(serialized).not.toContain('SECRET-QUESTION');
    expect(serialized).not.toContain('SECRET-ANSWER');
  });

  test('includes natural failures in the ordinary-answer gate', () => {
    const records = Array.from({ length: 20 }, (_, index) => {
      const record = v2Fixture({
        loggedAt: `2026-07-23T12:02:${String(index).padStart(2, '0')}.000Z`,
        latencyMs: index < 18 ? 30_000 : 120_000,
        sampleKind: 'natural',
        fallback: false,
      });
      if (index >= 18) record.outcome = 'timeout';
      return record;
    });
    const rollup = buildSourceAnswerLatencyRollup({ records });
    expect(rollup.phase_6_gates.ordinary_answer).toEqual({
      threshold_ms: 60_000,
      natural_samples: 20,
      p95_ms: 120_000,
      state: 'fail',
    });
    expect(rollup.splits.outcome).toEqual([
      expect.objectContaining({ key: 'success', samples: 18 }),
      expect.objectContaining({ key: 'timeout', samples: 2 }),
    ]);
  });

  test('separates planner time the build waited on from time it abandoned', () => {
    const rollup = buildSourceAnswerLatencyRollup({
      records: [
        v2Fixture({
          loggedAt: '2026-07-26T12:00:00.000Z',
          latencyMs: 30_000,
          sampleKind: 'natural',
          fallback: false,
          planner: { elapsed_ms: 4_000, awaited_count: 1 },
        }),
        v2Fixture({
          loggedAt: '2026-07-26T12:00:01.000Z',
          latencyMs: 30_000,
          sampleKind: 'natural',
          fallback: false,
          planner: {
            elapsed_ms: 2_000,
            awaited_count: 0,
            ignored_after_strong_literal_count: 1,
          },
        }),
        // Waited on a planner leg that then errored and failed open.
        v2Fixture({
          loggedAt: '2026-07-26T12:00:02.000Z',
          latencyMs: 30_000,
          sampleKind: 'natural',
          fallback: false,
          planner: { elapsed_ms: 6_000, awaited_count: 1, failed_count: 1 },
        }),
      ],
    });

    expect(rollup.query_planner).toEqual({
      samples_with_disposition: 3,
      awaited_count: 2,
      ignored_after_strong_literal_count: 1,
      failed_count: 1,
      // The failure co-occurred with a wait, so it is not a fourth disposition.
      wait_dispositions: 3,
      awaited_share: 0.6667,
      awaited_ms: { samples: 2, p50: 4_000, p90: 6_000, p95: 6_000, max: 6_000 },
      abandoned_ms: { samples: 1, p50: 2_000, p90: 2_000, p95: 2_000, max: 2_000 },
    });
  });

  test('bills a sample that mixed both wait dispositions as awaited planner time', () => {
    const rollup = buildSourceAnswerLatencyRollup({
      records: [v2Fixture({
        loggedAt: '2026-07-26T12:03:00.000Z',
        latencyMs: 30_000,
        sampleKind: 'natural',
        fallback: false,
        planner: {
          elapsed_ms: 7_000,
          awaited_count: 1,
          ignored_after_strong_literal_count: 1,
        },
      })],
    });

    expect(rollup.query_planner.awaited_ms.samples).toBe(1);
    expect(rollup.query_planner.abandoned_ms.samples).toBe(0);
    expect(rollup.query_planner.awaited_share).toBe(0.5);
  });

  test('reads ledger lines written before the planner counters as zero dispositions', () => {
    const plannerless: Record<string, unknown> = {
      ...v2Fixture({
        loggedAt: '2026-07-26T12:04:01.000Z',
        latencyMs: 30_000,
        sampleKind: 'natural',
        fallback: false,
      }),
      correlation_id: 'trace-plannerless',
    };
    delete plannerless.query_planner;
    const parsed = parseSourceAnswerLatencyJsonl([
      JSON.stringify({
        ...v2Fixture({
          loggedAt: '2026-07-26T12:04:00.000Z',
          latencyMs: 30_000,
          sampleKind: 'natural',
          fallback: false,
        }),
        query_planner: { elapsed_ms: 5, formulation_count: 2 },
      }),
      JSON.stringify(plannerless),
    ].join('\n'));
    expect(parsed).toEqual({ records: expect.any(Array), malformedLines: 0 });
    expect(parsed.records).toHaveLength(2);

    const rollup = buildSourceAnswerLatencyRollup({ records: parsed.records });
    expect(rollup.query_planner).toEqual({
      samples_with_disposition: 0,
      awaited_count: 0,
      ignored_after_strong_literal_count: 0,
      failed_count: 0,
      wait_dispositions: 0,
      awaited_share: 0,
      awaited_ms: { samples: 0, p50: 0, p90: 0, p95: 0, max: 0 },
      abandoned_ms: { samples: 0, p50: 0, p90: 0, p95: 0, max: 0 },
    });
    // Planner wall time still lands in phases_ms for both lines.
    expect(rollup.phases_ms.query_planner_ms).toEqual(
      expect.objectContaining({ samples: 2, max: 5 }),
    );
  });
});

function v1Fixture(loggedAt: string, latencyMs: number): SourceAnswerLatencyRecord {
  return {
    kind: 'source_answer_latency',
    logged_at: loggedAt,
    latency_ms: latencyMs,
    phase_timings: {
      lane_setup_ms: 1,
      bulk_gate_ms: 1,
      evidence_pack_ms: 100,
      analyst_ms: 200,
      release_gate_ms: 1,
      total_ms: latencyMs,
    },
    searched_corpora: ['internal.telegram.messages'],
    skipped_corpora: [],
    lane_timeouts: [],
    analyst_backend: 'local',
    release_decision: 'allow',
    released: true,
  };
}

function v2Fixture(input: {
  loggedAt: string;
  latencyMs: number;
  compatV1LoggedAt?: string;
  sampleKind: 'natural' | 'probe';
  fallback: boolean;
  planner?: Partial<SourceAnswerLatencyTraceRecord['query_planner']>;
}): SourceAnswerLatencyTraceRecord {
  return {
    kind: 'source_answer_latency_trace',
    schema_version: 2,
    correlation_id: `trace-${input.loggedAt}`,
    ...(input.compatV1LoggedAt ? { compat_v1_logged_at: input.compatV1LoggedAt } : {}),
    logged_at: input.loggedAt,
    sample_kind: input.sampleKind,
    outcome: 'success',
    latency_ms: input.latencyMs,
    sqlite: { retry_count: 0, backoff_ms: 0 },
    query_planner: {
      elapsed_ms: 5,
      formulation_count: 2,
      awaited_count: 1,
      ignored_after_strong_literal_count: 0,
      failed_count: 0,
      ...input.planner,
    },
    retrieval_attempts: [{
      kind: 'keyword',
      elapsed_ms: 100,
      hydration_ms: 20,
      queries: [{
        ordinal: 1,
        elapsed_ms: 50,
        corpus_timings: [{
          corpus_id: 'internal.telegram.messages',
          elapsed_ms: 40,
          adapter_reported_ms: 38,
          outcome: 'success',
        }],
      }],
    }],
    analyst_route: {
      resolution_ms: 1,
      ordered_route: input.fallback
        ? [
            { profile_id: 'venice', backend: 'venice', model_id: 'private-model' },
            { profile_id: 'local', backend: 'local', model_id: 'local-model' },
          ]
        : [{ profile_id: 'local', backend: 'local', model_id: 'local-model' }],
    },
    analyst_legs: input.fallback
      ? [
          {
            profile_id: 'venice',
            backend: 'venice',
            model_id: 'private-model',
            budget_ms: 20_000,
            elapsed_ms: 20_000,
            outcome: 'timeout',
            error_class: 'TrustedAnalystTimeoutError',
          },
          {
            profile_id: 'local',
            backend: 'local',
            model_id: 'local-model',
            budget_ms: 240_000,
            elapsed_ms: 200,
            outcome: 'success',
          },
        ]
      : [{
          profile_id: 'local',
          backend: 'local',
          model_id: 'local-model',
          budget_ms: 240_000,
          elapsed_ms: 200,
          outcome: 'success',
        }],
    release_decision: 'allow',
    phase_ms: {
      lane_setup_ms: 1,
      bulk_gate_ms: 1,
      keyword_retrieval_ms: 100,
      hybrid_retrieval_ms: 0,
      selected_retrieval_ms: 0,
      self_heal_ms: 0,
      self_heal_rebuild_ms: 0,
      analyst_ms: input.fallback ? 20_200 : 200,
      release_gate_ms: 1,
      sqlite_backoff_ms: 0,
      record_build_ms: 1,
      append_ms: 1,
      unattributed_ms: Math.max(0, input.latencyMs - (input.fallback ? 20_305 : 305)),
    },
  };
}

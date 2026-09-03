import { readFile } from 'node:fs/promises';
import {
  resolveSourceAnswerLatencyLogPath,
  type SourceAnswerLatencyLedgerRecord,
  type SourceAnswerLatencyRecord,
  type SourceAnswerLatencyTraceRecord,
} from '../src/workers/source-index/answer-latency-log.ts';

export interface LatencyPercentiles {
  samples: number;
  p50: number;
  p90: number;
  p95: number;
  max: number;
}

export interface LatencySplit extends LatencyPercentiles {
  key: string;
}

// Counts are per planner call, summed across v2 samples. awaited and
// ignored_after_strong_literal partition the wait dispositions, so they are the
// only terms in awaited_share; failed is an outcome flag that can co-occur with
// awaited and would inflate the denominator if folded in.
export interface QueryPlannerRollup {
  samples_with_disposition: number;
  awaited_count: number;
  ignored_after_strong_literal_count: number;
  failed_count: number;
  wait_dispositions: number;
  awaited_share: number;
  // Planner wall time split by what the build did with it. A sample is
  // abandoned only when every planner call in it was ignored, so a sample that
  // mixed both dispositions counts as awaited. Samples carrying no disposition
  // — pre-L4 ledger lines, or a planner that only failed — are in neither
  // split, while their elapsed_ms still reaches phases_ms.query_planner_ms.
  awaited_ms: LatencyPercentiles;
  abandoned_ms: LatencyPercentiles;
}

export interface Phase6LatencyGate {
  threshold_ms: number;
  natural_samples: number;
  p95_ms?: number;
  state: 'pass' | 'fail' | 'insufficient_samples';
}

export interface SourceAnswerLatencyRollup {
  kind: 'source_answer_latency_rollup';
  generated_at: string;
  records_read: number;
  malformed_lines: number;
  schema_records: { v1: number; v2: number };
  samples: {
    total: number;
    natural: number;
    probe: number;
  };
  window: {
    started_at?: string;
    ended_at?: string;
  };
  latency_ms: LatencyPercentiles;
  phases_ms: Record<string, LatencyPercentiles>;
  splits: {
    trust_route: LatencySplit[];
    backend: LatencySplit[];
    outcome: LatencySplit[];
  };
  fallback: {
    eligible_samples: number;
    fallback_samples: number;
    share: number;
  };
  query_planner: QueryPlannerRollup;
  phase_6_gates: {
    status: Phase6LatencyGate;
    search: Phase6LatencyGate;
    first_ack: Phase6LatencyGate;
    ordinary_answer: Phase6LatencyGate;
  };
  sample_classification: string;
}

interface NormalizedSample {
  loggedAt: string;
  latencyMs: number;
  sampleKind: 'natural' | 'probe';
  outcome: string;
  backend: string;
  trustRoute: string;
  fallback: boolean;
  phases: Record<string, number>;
  // Absent on v1 samples, which carry no planner block at all.
  planner?: NormalizedPlanner;
}

interface NormalizedPlanner {
  elapsedMs: number;
  awaited: number;
  ignored: number;
  failed: number;
}

export function buildSourceAnswerLatencyRollup(input: {
  records: readonly SourceAnswerLatencyLedgerRecord[];
  malformedLines?: number;
  now?: () => Date;
}): SourceAnswerLatencyRollup {
  const schemaRecords = {
    v1: input.records.filter((record) => record.kind === 'source_answer_latency').length,
    v2: input.records.filter((record) => record.kind === 'source_answer_latency_trace').length,
  };
  const samples = normalizeAndDedupeRecords(input.records);
  const natural = samples.filter((sample) => sample.sampleKind === 'natural');
  const probe = samples.filter((sample) => sample.sampleKind === 'probe');
  const timestamps = samples
    .map((sample) => sample.loggedAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const windowStartedAt = timestamps[0];
  const windowEndedAt = timestamps.at(-1);
  const phaseNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.phases)))].sort();
  const phasesMs = Object.fromEntries(
    phaseNames.map((phase) => [
      phase,
      latencyPercentiles(samples.flatMap((sample) =>
        sample.phases[phase] === undefined ? [] : [sample.phases[phase]])),
    ]),
  );

  return {
    kind: 'source_answer_latency_rollup',
    generated_at: (input.now ?? (() => new Date()))().toISOString(),
    records_read: input.records.length,
    malformed_lines: Math.max(0, Math.floor(input.malformedLines ?? 0)),
    schema_records: schemaRecords,
    samples: {
      total: samples.length,
      natural: natural.length,
      probe: probe.length,
    },
    window: {
      ...(windowStartedAt ? { started_at: windowStartedAt } : {}),
      ...(windowEndedAt ? { ended_at: windowEndedAt } : {}),
    },
    latency_ms: latencyPercentiles(samples.map((sample) => sample.latencyMs)),
    phases_ms: phasesMs,
    splits: {
      trust_route: splitSamples(samples, (sample) => sample.trustRoute),
      backend: splitSamples(samples, (sample) => sample.backend),
      outcome: splitSamples(samples, (sample) => sample.outcome),
    },
    fallback: {
      eligible_samples: samples.length,
      fallback_samples: samples.filter((sample) => sample.fallback).length,
      share: ratio(samples.filter((sample) => sample.fallback).length, samples.length),
    },
    query_planner: summarizeQueryPlanner(samples),
    phase_6_gates: {
      status: evaluateLatencyGate([], 10_000),
      search: evaluateLatencyGate([], 15_000),
      first_ack: evaluateLatencyGate([], 5_000),
      ordinary_answer: evaluateLatencyGate(
        natural.map((sample) => sample.latencyMs),
        60_000,
      ),
    },
    sample_classification: probe.length > 0
      ? 'Probe-generated samples are labeled and excluded from phase-6 gate evaluation.'
      : 'No probe-generated marker is present in the normalized sample set; all current samples are treated as natural.',
  };
}

function summarizeQueryPlanner(
  samples: readonly NormalizedSample[],
): QueryPlannerRollup {
  const planners = samples.flatMap((sample) => (sample.planner ? [sample.planner] : []));
  const total = (pick: (planner: NormalizedPlanner) => number): number =>
    planners.reduce((sum, planner) => sum + pick(planner), 0);
  const awaited = total((planner) => planner.awaited);
  const ignored = total((planner) => planner.ignored);
  const waitDispositions = awaited + ignored;
  return {
    samples_with_disposition: planners.filter(
      (planner) => planner.awaited + planner.ignored + planner.failed > 0,
    ).length,
    awaited_count: awaited,
    ignored_after_strong_literal_count: ignored,
    failed_count: total((planner) => planner.failed),
    wait_dispositions: waitDispositions,
    awaited_share: ratio(awaited, waitDispositions),
    awaited_ms: latencyPercentiles(
      planners.filter((planner) => planner.awaited > 0).map((planner) => planner.elapsedMs),
    ),
    abandoned_ms: latencyPercentiles(
      planners
        .filter((planner) => planner.awaited === 0 && planner.ignored > 0)
        .map((planner) => planner.elapsedMs),
    ),
  };
}

export function latencyPercentiles(values: readonly number[]): LatencyPercentiles {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.round(value))
    .sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.50),
    p90: percentile(sorted, 0.90),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}

export function evaluateLatencyGate(
  naturalValues: readonly number[],
  thresholdMs: number,
): Phase6LatencyGate {
  const metrics = latencyPercentiles(naturalValues);
  if (metrics.samples < 20) {
    return {
      threshold_ms: thresholdMs,
      natural_samples: metrics.samples,
      ...(metrics.samples > 0 ? { p95_ms: metrics.p95 } : {}),
      state: 'insufficient_samples',
    };
  }
  return {
    threshold_ms: thresholdMs,
    natural_samples: metrics.samples,
    p95_ms: metrics.p95,
    state: metrics.p95 < thresholdMs ? 'pass' : 'fail',
  };
}

export function parseSourceAnswerLatencyJsonl(text: string): {
  records: SourceAnswerLatencyLedgerRecord[];
  malformedLines: number;
} {
  const records: SourceAnswerLatencyLedgerRecord[] = [];
  let malformedLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isLatencyLedgerRecord(parsed)) records.push(parsed);
      else malformedLines += 1;
    } catch {
      malformedLines += 1;
    }
  }
  return { records, malformedLines };
}

export async function readSourceAnswerLatencyLedger(path: string): Promise<{
  records: SourceAnswerLatencyLedgerRecord[];
  malformedLines: number;
}> {
  const parts: string[] = [];
  for (const candidate of [`${path}.1`, path]) {
    try {
      parts.push(await readFile(candidate, 'utf8'));
    } catch (error) {
      if ((error as { code?: unknown } | null | undefined)?.code !== 'ENOENT') throw error;
    }
  }
  return parseSourceAnswerLatencyJsonl(parts.join('\n'));
}

function normalizeAndDedupeRecords(
  records: readonly SourceAnswerLatencyLedgerRecord[],
): NormalizedSample[] {
  const v1ByLoggedAt = new Map<string, SourceAnswerLatencyRecord>();
  const consumedV1 = new Set<string>();
  for (const record of records) {
    if (record.kind === 'source_answer_latency') v1ByLoggedAt.set(record.logged_at, record);
  }

  const normalized: NormalizedSample[] = [];
  for (const record of records) {
    if (record.kind === 'source_answer_latency_trace') {
      if (record.compat_v1_logged_at && v1ByLoggedAt.has(record.compat_v1_logged_at)) {
        consumedV1.add(record.compat_v1_logged_at);
      }
      normalized.push(normalizeV2(record));
    }
  }
  for (const record of records) {
    if (record.kind !== 'source_answer_latency') continue;
    if (!consumedV1.has(record.logged_at)) normalized.push(normalizeV1(record));
  }
  return normalized;
}

function normalizeV1(record: SourceAnswerLatencyRecord): NormalizedSample {
  const fallback = record.analyst_fallback;
  const route = fallback
    ? `${fallback.from}>${fallback.to}`
    : record.analyst_backend;
  const phases = Object.fromEntries(
    Object.entries(record.phase_timings ?? {})
      .filter(([key, value]) => key !== 'total_ms' && typeof value === 'number')
      .map(([key, value]) => [key, value as number]),
  );
  return {
    loggedAt: record.logged_at,
    latencyMs: record.latency_ms,
    sampleKind: 'natural',
    outcome: 'success',
    backend: record.analyst_backend,
    trustRoute: route,
    fallback: fallback !== undefined,
    phases,
  };
}

function normalizeV2(record: SourceAnswerLatencyTraceRecord): NormalizedSample {
  const successfulLeg = [...record.analyst_legs].reverse().find((leg) => leg.outcome === 'success');
  const routeBackends = record.analyst_route.ordered_route.map((step) => step.backend);
  const routed = routeBackends.length > 0 ? routeBackends.join('>') : 'unresolved';
  const planner = readPlanner(record);
  const detailedPhases: Record<string, number> = {
    ...record.phase_ms,
    query_planner_ms: planner.elapsedMs,
    routed_search_ms: record.retrieval_attempts.reduce(
      (sum, attempt) => sum + attempt.queries.reduce((querySum, query) => querySum + query.elapsed_ms, 0),
      0,
    ),
    hydration_ms: record.retrieval_attempts.reduce((sum, attempt) => sum + attempt.hydration_ms, 0),
    route_resolution_ms: record.analyst_route.resolution_ms,
  };
  return {
    loggedAt: record.logged_at,
    latencyMs: record.latency_ms,
    sampleKind: record.sample_kind,
    outcome: record.outcome,
    backend: successfulLeg?.backend ?? 'none',
    trustRoute: routed,
    fallback: record.analyst_legs.some((leg) => leg.outcome !== 'success'),
    phases: detailedPhases,
    planner,
  };
}

// The ledger keeps lines written before L4 added the disposition counters, so
// every field here can be absent at read time even though the record type marks
// it required.
function readPlanner(record: SourceAnswerLatencyTraceRecord): NormalizedPlanner {
  const planner = record.query_planner as
    | Partial<SourceAnswerLatencyTraceRecord['query_planner']>
    | undefined;
  return {
    elapsedMs: nonNegativeNumber(planner?.elapsed_ms),
    awaited: nonNegativeCount(planner?.awaited_count),
    ignored: nonNegativeCount(planner?.ignored_after_strong_literal_count),
    failed: nonNegativeCount(planner?.failed_count),
  };
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function nonNegativeCount(value: unknown): number {
  return Math.floor(nonNegativeNumber(value));
}

function splitSamples(
  samples: readonly NormalizedSample[],
  keyFor: (sample: NormalizedSample) => string,
): LatencySplit[] {
  const buckets = new Map<string, number[]>();
  for (const sample of samples) {
    const key = keyFor(sample);
    const values = buckets.get(key) ?? [];
    values.push(sample.latencyMs);
    buckets.set(key, values);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => ({ key, ...latencyPercentiles(values) }));
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index]!;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function isLatencyLedgerRecord(value: unknown): value is SourceAnswerLatencyLedgerRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'source_answer_latency') {
    return typeof record.logged_at === 'string' && typeof record.latency_ms === 'number';
  }
  return record.kind === 'source_answer_latency_trace'
    && record.schema_version === 2
    && typeof record.correlation_id === 'string'
    && typeof record.logged_at === 'string'
    && typeof record.latency_ms === 'number';
}

function parsePathArgument(args: readonly string[]): string | undefined {
  const pathIndex = args.indexOf('--path');
  if (pathIndex !== -1) return args[pathIndex + 1]?.trim() || undefined;
  return args.find((arg) => !arg.startsWith('-'))?.trim();
}

if (import.meta.main) {
  const path = parsePathArgument(process.argv.slice(2))
    ?? resolveSourceAnswerLatencyLogPath(process.env);
  if (!path) {
    console.error('source_answer_latency_rollup_failed error_class=LedgerDisabled');
    process.exitCode = 1;
  } else {
    try {
      const parsed = await readSourceAnswerLatencyLedger(path);
      console.log(JSON.stringify(buildSourceAnswerLatencyRollup({
        records: parsed.records,
        malformedLines: parsed.malformedLines,
      }), null, 2));
    } catch (error) {
      const errorClass = String(
        (error as { name?: unknown; constructor?: { name?: unknown } } | null | undefined)?.name
        ?? (error as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name
        ?? 'UnknownError',
      ).replace(/[^A-Za-z0-9_]/g, '').slice(0, 64) || 'UnknownError';
      console.error(`source_answer_latency_rollup_failed error_class=${errorClass}`);
      process.exitCode = 1;
    }
  }
}

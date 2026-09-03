// Leg C of the answer-latency WO: the content-free source_answer latency
// ledger. Proves the persisted line carries phase timings + honest skip/
// fallback audits and corpus ids, and NEVER query text, answer text, evidence
// titles, or file paths — and that the worker route actually writes one.

import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';
import {
  appendSourceAnswerLatencyLine,
  buildSourceAnswerLatencyRecord,
  buildSourceAnswerLatencyTraceRecord,
  createFileSourceAnswerLatencyLog,
  resolveSourceAnswerLatencyLogPath,
  type SourceAnswerLatencyLedgerRecord,
  type SourceAnswerLatencyRecord,
  type SourceAnswerLatencyTraceRecord,
} from '../src/workers/source-index/answer-latency-log.ts';
import {
  createSourceAnswerTrace,
  observeSourceAnswerAnalystLeg,
  observeSourceAnswerRetrievalAttempt,
  observeSourceAnswerRoutedQuery,
  recordSourceAnswerCorpusTiming,
  recordSourceAnswerHydration,
  recordSourceAnswerQueryPlanner,
  recordSourceAnswerQueryPlannerDisposition,
  recordSourceAnswerRoute,
  runWithSourceAnswerTrace,
  snapshotSourceAnswerTrace,
} from '../src/workers/source-index/answer-latency-trace.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';

const SECRET_QUESTION = 'SECRET-QUESTION did I just get a private lab result?';
const SECRET_ANSWER = 'SECRET-ANSWER-TEXT your LDL was 92 mg/dL';
const SECRET_PATH = '/Users/sam/Health/secret-lab.pdf';

function answerResultFixture(overrides: {
  latencyMs?: number;
  phaseTimings?: SourceIndexAnswerResult['audit']['phase_timings'];
  searched?: string[];
  skipped?: SourceIndexAnswerResult['audit']['skipped_corpora'];
  backend?: 'local' | 'venice' | 'cloud';
  fallback?: SourceIndexAnswerResult['audit']['answer_synthesis']['analyst_fallback'];
  decision?: 'allow' | 'redact' | 'needs_approval' | 'deny';
} = {}): SourceIndexAnswerResult {
  return {
    answer: SECRET_ANSWER,
    evidence: [{
      corpus_id: 'secure_local.dropbox.files',
      trust_domain: 'secure_local',
      family: 'file',
      provider: 'dropbox',
      provider_item_id: 'lab-1',
      title: 'secret-lab.pdf',
      uri: SECRET_PATH,
    }],
    audit: {
      searched_corpora: overrides.searched ?? ['internal.telegram.messages'],
      skipped_corpora: overrides.skipped ?? [],
      lane_audits: [],
      answer_synthesis: {
        private_context_used: false,
        secure_local_items_consulted: 0,
        internal_content_used: true,
        internal_items_consulted: 1,
        internal_content_failures: 0,
        analyst_backend: overrides.backend ?? 'local',
        ...(overrides.fallback ? { analyst_fallback: overrides.fallback } : {}),
        raw_source_exposed: false,
      },
      latency_ms: overrides.latencyMs ?? 42,
      ...(overrides.phaseTimings ? { phase_timings: overrides.phaseTimings } : {}),
      raw_source_exposed: false,
    },
    policy: {
      raw_source_exposed: false,
      source_packets_exposed: false,
      internal_content_exposed: true,
      secure_local_content_exposed: false,
      castor_safe_bridge: true,
    },
    opsec: {
      structured_evidence: [],
      release_decision: { decision: overrides.decision ?? 'allow', reasons: ['release_gate_passed'] },
      raw_source_exposed: false,
    },
  };
}

describe('source_answer latency ledger record', () => {
  test('builds a content-free record from phase timings, corpus ids, and skip reasons', () => {
    const record = buildSourceAnswerLatencyRecord(
      answerResultFixture({
        latencyMs: 107_000,
        phaseTimings: { lane_setup_ms: 1, bulk_gate_ms: 0, evidence_pack_ms: 106_500, analyst_ms: 400, release_gate_ms: 20, total_ms: 107_000 },
        searched: ['internal.telegram.messages'],
        skipped: [
          { corpus_id: 'secure_local.dropbox.files', trust_domain: 'secure_local', reason: 'lane_timeout' },
          { corpus_id: 'public_safe.docs', trust_domain: 'public_safe', reason: 'not_requested' },
        ],
      }),
      () => new Date('2026-07-15T12:00:00.000Z'),
    );

    expect(record.kind).toBe('source_answer_latency');
    expect(record.logged_at).toBe('2026-07-15T12:00:00.000Z');
    expect(record.latency_ms).toBe(107_000);
    expect(record.phase_timings?.evidence_pack_ms).toBe(106_500);
    expect(record.searched_corpora).toEqual(['internal.telegram.messages']);
    expect(record.skipped_corpora).toEqual([
      { corpus_id: 'secure_local.dropbox.files', reason: 'lane_timeout' },
      { corpus_id: 'public_safe.docs', reason: 'not_requested' },
    ]);
    // Lane timeouts (the historical ~100s cause) are surfaced explicitly.
    expect(record.lane_timeouts).toEqual(['secure_local.dropbox.files']);
    expect(record.analyst_backend).toBe('local');
    expect(record.released).toBe(true);
    expect(record.release_decision).toBe('allow');

    // Content-free: no query, no answer text, no evidence titles/paths.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('SECRET-ANSWER-TEXT');
    expect(serialized).not.toContain('secret-lab.pdf');
    expect(serialized).not.toContain(SECRET_PATH);
  });

  test('records an honest analyst timeout fallback (reason, budget, elapsed)', () => {
    const record = buildSourceAnswerLatencyRecord(
      answerResultFixture({
        backend: 'local',
        fallback: { from: 'venice', to: 'local', reason: 'timeout', elapsed_ms: 20, timeout_ms: 20 },
        decision: 'allow',
      }),
    );
    expect(record.analyst_fallback).toEqual({ from: 'venice', to: 'local', reason: 'timeout', elapsed_ms: 20, timeout_ms: 20 });
  });

  test('marks non-released decisions honestly', () => {
    const record = buildSourceAnswerLatencyRecord(answerResultFixture({ decision: 'needs_approval' }));
    expect(record.released).toBe(false);
    expect(record.release_decision).toBe('needs_approval');
  });

  test('appends exactly one content-free JSON line to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'olympus-latency-'));
    const path = join(dir, 'nested', 'source-answer-latency.jsonl');
    try {
      const record = buildSourceAnswerLatencyRecord(
        answerResultFixture({
          phaseTimings: { lane_setup_ms: 1, bulk_gate_ms: 0, evidence_pack_ms: 90_000, analyst_ms: 5, release_gate_ms: 2, total_ms: 90_010 },
          skipped: [{ corpus_id: 'secure_local.dropbox.files', trust_domain: 'secure_local', reason: 'lane_timeout' }],
        }),
      );
      await appendSourceAnswerLatencyLine(path, record);
      await appendSourceAnswerLatencyLine(path, record);

      const contents = await readFile(path, 'utf8');
      const lines = contents.trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      const parsed = JSON.parse(lines[0]!) as SourceAnswerLatencyRecord;
      expect(parsed.kind).toBe('source_answer_latency');
      expect(parsed.lane_timeouts).toEqual(['secure_local.dropbox.files']);
      expect(parsed.phase_timings?.evidence_pack_ms).toBe(90_000);

      expect(contents).not.toContain('SECRET-ANSWER-TEXT');
      expect(contents).not.toContain('secret-lab.pdf');
      expect(contents).not.toContain(SECRET_PATH);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('source_answer latency ledger path resolution', () => {
  test('honors an explicit path', () => {
    expect(resolveSourceAnswerLatencyLogPath({ OLYMPUS_SOURCE_ANSWER_LATENCY_LOG_PATH: '/var/log/olympus/lat.jsonl' }))
      .toBe('/var/log/olympus/lat.jsonl');
  });

  test('treats off/none/disabled/false/0 as disabled', () => {
    for (const value of ['off', 'none', 'disabled', 'FALSE', '0']) {
      expect(resolveSourceAnswerLatencyLogPath({ OLYMPUS_SOURCE_ANSWER_LATENCY_LOG_PATH: value })).toBeUndefined();
    }
  });

  test('defaults to the XDG data home when unset (on by default)', () => {
    expect(resolveSourceAnswerLatencyLogPath({ XDG_DATA_HOME: '/data' }))
      .toBe('/data/openclaw/olympus/source-answer-latency.jsonl');
  });
});

describe('source_answer v2 trace allowlist', () => {
  test('builds an honest wall-time record without content-bearing error data', () => {
    const trace = createSourceAnswerTrace(() => new Date('2026-07-23T12:00:00.000Z'));
    const sensitiveError = new Error(`${SECRET_QUESTION} ${SECRET_ANSWER} ${SECRET_PATH}`);
    sensitiveError.name = 'SensitiveProviderError';
    const record = buildSourceAnswerLatencyTraceRecord({
      trace: snapshotSourceAnswerTrace(trace),
      outcome: 'error',
      error: sensitiveError,
      now: () => new Date('2026-07-23T12:00:00.125Z'),
    });

    expect(record.schema_version).toBe(2);
    expect(record.outcome).toBe('error');
    expect(record.error_class).toBe('Error');
    expect(record.latency_ms).toBe(125);
    expect(Object.values(record.phase_ms).reduce((sum, value) => sum + value, 0)).toBe(125);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(SECRET_QUESTION);
    expect(serialized).not.toContain(SECRET_ANSWER);
    expect(serialized).not.toContain(SECRET_PATH);
    expect(contentBearingKeys(record)).toEqual([]);
  });

  test('preserves detailed planner, query, adapter, hydration, route, and winning-leg timings', async () => {
    const trace = createSourceAnswerTrace(() => new Date('2026-07-23T12:00:00.000Z'));
    await runWithSourceAnswerTrace(trace, async () => {
      recordSourceAnswerQueryPlanner(7, 2);
      // One keyword build waited on its planner, a later one walked away from a
      // strong literal run, and a third planner leg failed open.
      recordSourceAnswerQueryPlannerDisposition('awaited');
      recordSourceAnswerQueryPlannerDisposition('ignored_after_strong_literal');
      recordSourceAnswerQueryPlannerDisposition('failed');
      await observeSourceAnswerRetrievalAttempt('keyword', async () => {
        await observeSourceAnswerRoutedQuery(1, async () => {
          recordSourceAnswerCorpusTiming({
            corpus_id: 'internal.telegram.messages',
            elapsed_ms: 3,
            adapter_reported_ms: 2,
            outcome: 'success',
          });
        });
        recordSourceAnswerHydration(4);
      });
      await observeSourceAnswerRetrievalAttempt('hybrid', async () => {});
      await observeSourceAnswerRetrievalAttempt('self_heal_rebuild', async () => {});
      recordSourceAnswerRoute(1, [{
        profile_id: 'local-source-answer',
        backend: 'local',
        model_id: 'local-model',
      }]);
      await observeSourceAnswerAnalystLeg({
        profile_id: 'local-source-answer',
        backend: 'local',
        model_id: 'local-model',
        budgetMs: 240_000,
      }, async () => ({ ok: true }));
    });

    const record = buildSourceAnswerLatencyTraceRecord({
      trace: snapshotSourceAnswerTrace(trace),
      outcome: 'success',
      now: () => new Date('2026-07-23T12:00:00.125Z'),
    });
    expect(record.query_planner).toEqual({
      elapsed_ms: 7,
      formulation_count: 2,
      awaited_count: 1,
      ignored_after_strong_literal_count: 1,
      failed_count: 1,
    });
    expect(record.retrieval_attempts[0]?.hydration_ms).toBe(4);
    expect(record.retrieval_attempts.map((attempt) => attempt.kind)).toEqual([
      'keyword',
      'hybrid',
      'self_heal_rebuild',
    ]);
    expect(record.retrieval_attempts[0]?.queries[0]?.corpus_timings[0]).toEqual({
      corpus_id: 'internal.telegram.messages',
      elapsed_ms: 3,
      adapter_reported_ms: 2,
      outcome: 'success',
    });
    expect(record.analyst_route.ordered_route).toEqual([{
      profile_id: 'local-source-answer',
      backend: 'local',
      model_id: 'local-model',
    }]);
    expect(record.analyst_legs).toHaveLength(1);
    expect(record.analyst_legs[0]?.outcome).toBe('success');
    expect(record.residual_analyst_orphan_count).toBe(0);
  });
});

describe('source_answer latency ledger reliability', () => {
  test('rotates at the configured size and repairs pre-existing permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'olympus-latency-rotate-'));
    const path = join(dir, 'source-answer-latency.jsonl');
    try {
      await writeFile(path, 'old-line\n', { mode: 0o644 });
      await chmod(path, 0o644);
      const log = createFileSourceAnswerLatencyLog(path, { maxBytes: 64 });
      await log.record(buildSourceAnswerLatencyRecord(answerResultFixture()));

      expect(await readFile(`${path}.1`, 'utf8')).toBe('old-line\n');
      const current = await readFile(path, 'utf8');
      expect(JSON.parse(current).kind).toBe('source_answer_latency');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(`${path}.1`)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('counts write failures and exposes only the last failure class', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'olympus-latency-health-'));
    const blockingFile = join(dir, 'not-a-directory');
    await writeFile(blockingFile, 'blocked');
    try {
      const log = createFileSourceAnswerLatencyLog(join(blockingFile, 'ledger.jsonl'));
      await log.record(buildSourceAnswerLatencyRecord(answerResultFixture()));
      expect(log.health?.()).toEqual({
        write_failure_count: 1,
        last_failure_class: 'Error',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('source_answer route persists a latency line', () => {
  test('the worker route preserves v1 and adds a content-free v2 success trace', async () => {
    const captured: SourceAnswerLatencyLedgerRecord[] = [];
    const worker = createEmailSourceWorker({
      sourceAnswer: {
        async answer() {
          return answerResultFixture({
            phaseTimings: { lane_setup_ms: 1, bulk_gate_ms: 0, evidence_pack_ms: 95_000, analyst_ms: 5, release_gate_ms: 2, total_ms: 95_010 },
            skipped: [{ corpus_id: 'secure_local.dropbox.files', trust_domain: 'secure_local', reason: 'lane_timeout' }],
          });
        },
      },
      sourceAnswerLatencyLog: {
        record(entry) {
          captured.push(entry);
        },
      },
    });

    const response = await worker.fetch(new Request('http://worker.test/v1/source/answer', {
      method: 'POST',
      body: JSON.stringify({ question: SECRET_QUESTION }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(2);
    const v1 = captured.find((record): record is SourceAnswerLatencyRecord =>
      record.kind === 'source_answer_latency');
    const v2 = captured.find((record): record is SourceAnswerLatencyTraceRecord =>
      record.kind === 'source_answer_latency_trace');
    expect(v1?.phase_timings?.evidence_pack_ms).toBe(95_000);
    expect(v1?.lane_timeouts).toEqual(['secure_local.dropbox.files']);
    expect(v2?.schema_version).toBe(2);
    expect(v2?.outcome).toBe('success');
    expect(v2?.sample_kind).toBe('natural');
    // The recorded line never carries the question text.
    expect(JSON.stringify(captured)).not.toContain('SECRET-QUESTION');
  });

  test('records every non-success outcome without changing error propagation', async () => {
    const cases: Array<{
      expected: SourceAnswerLatencyTraceRecord['outcome'];
      body: string;
      error?: Error;
    }> = [
      { expected: 'parse_error', body: '{' },
      { expected: 'error', body: JSON.stringify({ question: SECRET_QUESTION }), error: namedError('ProviderError') },
      { expected: 'timeout', body: JSON.stringify({ question: SECRET_QUESTION }), error: namedError('TrustedAnalystTimeoutError') },
      {
        expected: 'route_exhausted',
        body: JSON.stringify({ question: SECRET_QUESTION }),
        error: new Error('Sovereignty analyst fallback chain exhausted; route outcomes=local:failed:Error.'),
      },
      { expected: 'cancelled', body: JSON.stringify({ question: SECRET_QUESTION }), error: namedError('AbortError') },
    ];

    for (const item of cases) {
      const captured: SourceAnswerLatencyLedgerRecord[] = [];
      const worker = createEmailSourceWorker({
        sourceAnswer: {
          async answer() {
            throw item.error ?? new Error('answer must not run for parse errors');
          },
        },
        sourceAnswerLatencyLog: {
          record(entry) {
            captured.push(entry);
          },
        },
      });
      const response = await worker.fetch(new Request('http://worker.test/v1/source/answer', {
        method: 'POST',
        body: item.body,
        headers: { 'Content-Type': 'application/json' },
      }));

      expect(response.status).toBeGreaterThanOrEqual(400);
      const traces = captured.filter((record): record is SourceAnswerLatencyTraceRecord =>
        record.kind === 'source_answer_latency_trace');
      expect(traces).toHaveLength(1);
      expect(traces[0]!.outcome).toBe(item.expected);
      expect(JSON.stringify(traces[0])).not.toContain(SECRET_QUESTION);
      expect(JSON.stringify(traces[0])).not.toContain(SECRET_ANSWER);
      expect(JSON.stringify(traces[0])).not.toContain(SECRET_PATH);
    }
  });

  test('records SQLite retry count and configured backoff total', async () => {
    const priorDelays = process.env.OLYMPUS_SQLITE_BUSY_RETRY_DELAYS_MS;
    process.env.OLYMPUS_SQLITE_BUSY_RETRY_DELAYS_MS = '3';
    const captured: SourceAnswerLatencyLedgerRecord[] = [];
    let attempts = 0;
    try {
      const worker = createEmailSourceWorker({
        sourceAnswer: {
          async answer() {
            attempts += 1;
            if (attempts === 1) {
              const busy = new Error('database is locked');
              Object.assign(busy, { code: 'SQLITE_BUSY' });
              throw busy;
            }
            return answerResultFixture();
          },
        },
        sourceAnswerLatencyLog: {
          record(entry) {
            captured.push(entry);
          },
        },
      });
      const response = await worker.fetch(new Request('http://worker.test/v1/source/answer', {
        method: 'POST',
        body: JSON.stringify({ question: SECRET_QUESTION }),
        headers: { 'Content-Type': 'application/json' },
      }));
      expect(response.status).toBe(200);
      const trace = captured.find((record): record is SourceAnswerLatencyTraceRecord =>
        record.kind === 'source_answer_latency_trace');
      expect(trace?.sqlite).toEqual({ retry_count: 1, backoff_ms: 3 });
    } finally {
      if (priorDelays === undefined) delete process.env.OLYMPUS_SQLITE_BUSY_RETRY_DELAYS_MS;
      else process.env.OLYMPUS_SQLITE_BUSY_RETRY_DELAYS_MS = priorDelays;
    }
  });
});

function namedError(name: string): Error {
  const error = new Error('content-free fixture failure');
  error.name = name;
  return error;
}

function contentBearingKeys(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) contentBearingKeys(item, found);
    return found;
  }
  const forbidden = new Set([
    'answer',
    'citation',
    'citations',
    'content',
    'document',
    'documents',
    'path',
    'paths',
    'question',
    'text',
    'uri',
  ]);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key.toLowerCase())) found.push(key);
    contentBearingKeys(child, found);
  }
  return found;
}

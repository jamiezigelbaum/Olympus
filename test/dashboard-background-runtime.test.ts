/**
 * Reading the lanes off their own report files.
 *
 * Every field name asserted here was read off the writer rather than guessed:
 * chunks_embedded and the shared heartbeat_seq / updated_at / run_state /
 * active_phase from scripts/source-embedding-drain.ts and its siblings, the
 * guard's `paused <unit>: <reason>` action lines from the guard installer, and
 * provider_pause from scripts/source-processing-supervisor.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LaneSampleStore,
  readBackgroundRuntime,
  readGuardArbitration,
  resolveLaneReportDir,
} from '../src/workers/dashboard/background-runtime.ts';
import { computeLaneRate } from '../src/workers/dashboard/lane-state.ts';

const NOW = new Date('2026-08-24T12:00:00.000Z');

const made: string[] = [];

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

/** A report directory and a guard state directory, wired through the env. */
function host(): { env: Record<string, string | undefined>; reportDir: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'olympus-lane-'));
  made.push(root);
  const reportDir = join(root, 'reports');
  const stateDir = join(root, 'guard');
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return {
    env: {
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_REPORT_DIR: reportDir,
      OLYMPUS_OVERNIGHT_SOURCE_DRAIN_GUARD_STATE_DIR: stateDir,
    },
    reportDir,
    stateDir,
  };
}

function write(dir: string, file: string, body: unknown): void {
  writeFileSync(join(dir, file), JSON.stringify(body), 'utf8');
}

/** The embedding drain's report, in the shape its writer actually emits. */
function embeddingReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'source_embedding_drain_report',
    generated_at: '2026-08-24T11:30:00.000Z',
    updated_at: NOW.toISOString(),
    corpus_id: 'internal.dropbox',
    status: 'progress',
    run_state: 'running',
    active_phase: 'embedding',
    heartbeat_seq: 412,
    chunks_seen: 140_000,
    chunks_embedded: 133_123,
    chunks_skipped: 12,
    actions: [],
    ...overrides,
  };
}

describe('lane report paths', () => {
  test('resolves the directory the drain installers share', () => {
    expect(resolveLaneReportDir({})).toBe('/tmp/olympus-source-processing-supervisor');
    expect(resolveLaneReportDir({ OLYMPUS_SOURCE_EMBEDDING_DRAIN_REPORT_DIR: '/srv/reports' }))
      .toBe('/srv/reports');
    // A full path for the embedding lane names the directory its siblings use.
    expect(resolveLaneReportDir({
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_REPORT_PATH: '/srv/r/source-embedding-drain-current.json',
    })).toBe('/srv/r');
  });
});

describe('reading the lanes', () => {
  test('reads a drain report into a live lane with its own heartbeat', () => {
    const { env, reportDir } = host();
    write(reportDir, 'source-embedding-drain-current.json', embeddingReport());

    const facts = readBackgroundRuntime({ env, now: NOW, sampleStore: new LaneSampleStore() });
    const lane = facts.lanes.find((entry) => entry.id === 'embedding-drain');

    expect(lane?.name).toBe('Embedding drain');
    expect(lane?.unit).toBe('chunks');
    expect(lane?.reportsLive).toBe(true);
    expect(lane?.phase).toBe('embedding');
    expect(lane?.lastActivityAt?.toISOString()).toBe(NOW.toISOString());
    expect(lane?.samples[0]?.count).toBe(133_123);
    expect(lane?.samples[0]?.heartbeatSeq).toBe(412);
  });

  test('leaves a lane out entirely when its report is absent', () => {
    const { env } = host();

    const facts = readBackgroundRuntime({ env, now: NOW, sampleStore: new LaneSampleStore() });

    // Absent means the host does not run that lane. A row reading zero for an
    // uninstalled lane is the same lie as a percentage with no verb.
    expect(facts.lanes).toEqual([]);
  });

  test('survives an unreadable report rather than throwing on a render path', () => {
    const { env, reportDir } = host();
    writeFileSync(join(reportDir, 'source-embedding-drain-current.json'), '{ not json', 'utf8');

    const facts = readBackgroundRuntime({ env, now: NOW, sampleStore: new LaneSampleStore() });

    expect(facts.lanes).toEqual([]);
  });

  test('reads a stale report rather than discarding it, because that IS the evidence', () => {
    // The panel drops a stale report because it answers "is the guard running
    // this lane". This module answers "is it moving", and a running claim with
    // a frozen stamp is exactly the fault the owner reported.
    const { env, reportDir } = host();
    write(reportDir, 'source-embedding-drain-current.json', embeddingReport({
      updated_at: '2026-08-24T11:30:00.000Z',
    }));

    const facts = readBackgroundRuntime({ env, now: NOW, sampleStore: new LaneSampleStore() });
    const lane = facts.lanes.find((entry) => entry.id === 'embedding-drain');

    expect(lane?.reportsLive).toBe(true);
    expect(lane?.lastActivityAt?.toISOString()).toBe('2026-08-24T11:30:00.000Z');
  });

  test('calls a finished pass not live, so a complete lane is never a running one', () => {
    const { env, reportDir } = host();
    write(reportDir, 'source-embedding-drain-current.json', embeddingReport({
      run_state: 'complete',
      active_phase: 'complete',
    }));

    const facts = readBackgroundRuntime({ env, now: NOW, sampleStore: new LaneSampleStore() });

    expect(facts.lanes.find((entry) => entry.id === 'embedding-drain')?.reportsLive).toBe(false);
  });

  test('reads the supervisor own counters and its queued remainder', () => {
    const { env, reportDir } = host();
    write(reportDir, 'current.json', {
      kind: 'source_processing_supervisor_report',
      updated_at: NOW.toISOString(),
      run_state: 'running',
      active_phase: 'extracting',
      heartbeat_seq: 9,
      status: 'progress',
      summary: { terminal_progress_jobs: 220, queued_after: 41 },
    });

    const facts = readBackgroundRuntime({ env, now: NOW, sampleStore: new LaneSampleStore() });
    const lane = facts.lanes.find((entry) => entry.id === 'processing-supervisor');

    expect(lane?.samples[0]?.count).toBe(220);
    expect(lane?.remaining).toBe(41);
    expect(lane?.reportsLive).toBe(true);
  });

  test('takes a provider pause as that lane own governing condition, verbatim', () => {
    const { env, reportDir } = host();
    write(reportDir, 'current.json', {
      kind: 'source_processing_supervisor_report',
      updated_at: NOW.toISOString(),
      run_state: 'running',
      active_phase: 'paused',
      status: 'parked',
      summary: { terminal_progress_jobs: 0, queued_after: 12 },
      provider_pause: {
        active: true,
        kind: 'venice_credit',
        reason: 'venice_credit_exhausted',
        message: 'Venice credit is exhausted, so extraction is parked.',
      },
    });

    const facts = readBackgroundRuntime({ env, now: NOW, sampleStore: new LaneSampleStore() });
    const lane = facts.lanes.find((entry) => entry.id === 'processing-supervisor');

    expect(lane?.governing?.text).toBe('Venice credit is exhausted, so extraction is parked.');
    expect(lane?.governing?.decidedBy).toBe('the source-processing supervisor');
  });
});

describe('guard arbitration', () => {
  test('quotes the reason out of a park line, which is the only place it lives', () => {
    const { env, stateDir } = host();
    write(stateDir, 'latest.json', {
      kind: 'olympus_overnight_source_drain_guard_report',
      started_at: '2026-08-24T11:59:00.000Z',
      finished_at: '2026-08-24T11:59:04.000Z',
      metadata_window_active: false,
      metadata_window_reason: null,
      writer_drains_parked_without_window: false,
      actions: [
        'paused olympus-source-embedding-drain.service: metadata frontier pending',
        'metadata enqueue skipped: sync drain active',
      ],
    });

    const guard = readGuardArbitration(join(stateDir, 'latest.json'));

    expect(guard?.parked.get('olympus-source-embedding-drain.service')).toBe('metadata frontier pending');
    // A line that is not a park line is left alone rather than half-parsed.
    expect(guard?.parked.size).toBe(1);
    expect(guard?.at?.toISOString()).toBe('2026-08-24T11:59:04.000Z');
  });

  test('attaches the park reason to the lane the guard named', () => {
    const { env, reportDir, stateDir } = host();
    write(reportDir, 'source-embedding-drain-current.json', embeddingReport({
      run_state: 'complete',
      active_phase: 'complete',
    }));
    write(stateDir, 'latest.json', {
      finished_at: '2026-08-24T11:59:04.000Z',
      actions: ['paused olympus-source-embedding-drain.service: metadata sync active'],
    });

    const facts = readBackgroundRuntime({ env, now: NOW, sampleStore: new LaneSampleStore() });
    const lane = facts.lanes.find((entry) => entry.id === 'embedding-drain');

    expect(lane?.governing?.text).toBe('metadata sync active');
    expect(lane?.governing?.decidedBy).toBe('the overnight guard');
  });

  test('falls back to the metadata window reason, then to the parked-writers flag', () => {
    const { env, reportDir, stateDir } = host();
    write(reportDir, 'source-embedding-drain-current.json', embeddingReport({ run_state: 'complete' }));
    write(stateDir, 'latest.json', {
      finished_at: '2026-08-24T11:59:04.000Z',
      metadata_window_active: true,
      metadata_window_reason: 'dropbox_metadata_stale',
      actions: [],
    });

    const windowed = readBackgroundRuntime({ env, now: NOW, sampleStore: new LaneSampleStore() });
    expect(windowed.lanes[0]?.governing?.text).toContain('dropbox_metadata_stale');

    write(stateDir, 'latest.json', {
      finished_at: '2026-08-24T11:59:04.000Z',
      metadata_window_active: false,
      writer_drains_parked_without_window: true,
      actions: [],
    });
    const parked = readBackgroundRuntime({ env, now: NOW, sampleStore: new LaneSampleStore() });
    expect(parked.lanes[0]?.governing?.text).toContain('source-processing supervisors own the machine');
  });

  test('attributes a park line to no retained lane the guard did not name', () => {
    const { env, reportDir, stateDir } = host();
    write(reportDir, 'whatsapp-transcribe-drain-current.json', {
      updated_at: NOW.toISOString(),
      run_state: 'complete',
      active_phase: 'complete',
      heartbeat_seq: 3,
    });
    write(stateDir, 'latest.json', {
      finished_at: '2026-08-24T11:59:04.000Z',
      writer_drains_parked_without_window: true,
      actions: ['paused olympus-source-embedding-drain.service: metadata sync active'],
    });

    const facts = readBackgroundRuntime({ env, now: NOW, sampleStore: new LaneSampleStore() });

    // The guard does not arbitrate transcription, so none of its decisions
    // may be read as an explanation for it.
    expect(facts.lanes[0]?.id).toBe('whatsapp-transcribe-drain');
    expect(facts.lanes[0]?.governing).toBeUndefined();
  });
});

describe('the sample store', () => {
  test('accumulates readings across renders into a measurable window', () => {
    const { env, reportDir } = host();
    const store = new LaneSampleStore();
    write(reportDir, 'source-embedding-drain-current.json', embeddingReport({
      updated_at: '2026-08-24T11:55:00.000Z',
      heartbeat_seq: 1,
      chunks_embedded: 100_000,
    }));
    readBackgroundRuntime({ env, now: NOW, sampleStore: store });
    write(reportDir, 'source-embedding-drain-current.json', embeddingReport({
      updated_at: NOW.toISOString(),
      heartbeat_seq: 2,
      chunks_embedded: 106_200,
    }));

    const facts = readBackgroundRuntime({ env, now: NOW, sampleStore: store });
    const lane = facts.lanes.find((entry) => entry.id === 'embedding-drain');
    const rate = computeLaneRate(lane?.samples, { unit: 'chunks', now: NOW });

    expect(lane?.samples.length).toBe(2);
    expect(rate?.text).toBe('1,240 chunks/min');
  });

  test('refuses to invent an observation out of a frozen report read twice', () => {
    const { env, reportDir } = host();
    const store = new LaneSampleStore();
    const frozen = embeddingReport({ updated_at: '2026-08-24T11:40:00.000Z', heartbeat_seq: 77 });
    write(reportDir, 'source-embedding-drain-current.json', frozen);

    readBackgroundRuntime({ env, now: NOW, sampleStore: store });
    readBackgroundRuntime({ env, now: NOW, sampleStore: store });
    const facts = readBackgroundRuntime({ env, now: NOW, sampleStore: store });
    const lane = facts.lanes.find((entry) => entry.id === 'embedding-drain');

    expect(lane?.samples.length).toBe(1);
    expect(computeLaneRate(lane?.samples, { unit: 'chunks', now: NOW })).toBeUndefined();
  });

  test('keeps the last reading even after it ages out of the window', () => {
    // Otherwise a lane whose counter froze loses its history and falls back to
    // "not measured", which reads as less certain than it really is.
    const store = new LaneSampleStore();
    store.record('lane', { at: new Date(NOW.getTime() - 60 * 60_000), count: 5, heartbeatSeq: 1 }, NOW);
    const kept = store.record('lane', { at: new Date(NOW.getTime() - 40 * 60_000), count: 5, heartbeatSeq: 2 }, NOW);

    expect(kept.length).toBe(1);
    expect(kept[0]?.heartbeatSeq).toBe(2);
  });
});

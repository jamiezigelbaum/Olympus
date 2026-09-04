import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.ts';
import { runDoctor } from '../src/core/doctor.ts';
import type { DoctorCheck, DoctorDeps } from '../src/core/doctor.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { buildSourceIngestionLedgerSnapshot } from '../src/workers/source-ingestion-ledger.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import type { ContentExtractionThroughputSignal } from '../src/core/ingestion-throughput.ts';

const HOUR_MS = 60 * 60 * 1000;

function healthyDelphi(): DoctorDeps['delphi'] {
  return {
    listModels: async (lane) => [{ id: `${lane}-model` }],
    listModelsForProfile: async (profile) => [{ id: `${profile}-model` }],
    complete: async (options) => ({
      text: 'OLYMPUS_DOCTOR_OK',
      ...(options.lane ? { lane: options.lane } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
      model: `${options.profile ?? options.lane}-model`,
    }),
  };
}

function enabledEmailConfig() {
  const config = defaultConfig();
  config.email.enabled = true;
  return config;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeWorkerFetch(routes: Record<string, unknown>): { fetchImpl: typeof fetch; requestedPaths: string[] } {
  const requestedPaths: string[] = [];
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    requestedPaths.push(path);
    if (path in routes) return jsonResponse(routes[path]);
    return jsonResponse({ error: 'not_found' }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, requestedPaths };
}

function dropboxCorpusReport(overrides: {
  counts?: Record<string, number>;
  last_refresh?: Record<string, unknown>;
  content_extraction_throughput?: ContentExtractionThroughputSignal;
  read_authority?: string;
} = {}): Record<string, unknown> {
  return {
    corpus_id: 'secure_local.dropbox.files',
    family: 'file',
    trust_domain: 'secure_local',
    configured: true,
    read_authority: overrides.read_authority ?? 'connector_store',
    counts: {
      indexed_items: 100,
      tombstoned_items: 0,
      chunks: 100,
      embedded_chunks: 100,
      sync_runs: 1,
      ...overrides.counts,
    },
    ...(overrides.content_extraction_throughput
      ? { content_extraction_throughput: overrides.content_extraction_throughput }
      : {}),
    last_refresh: overrides.last_refresh ?? {
      sync_run_id: 'dropbox-sync-1',
      status: 'completed',
      started_at: new Date(Date.now() - HOUR_MS).toISOString(),
      completed_at: new Date(Date.now() - HOUR_MS / 2).toISOString(),
      items_seen: 10,
      items_indexed: 10,
    },
  };
}

function corpusReport(corpusId: string, overrides: {
  family?: string;
  trust_domain?: string;
  embedding_policy?: string;
  embedding_parity?: Record<string, unknown>;
  counts?: Record<string, number>;
  last_refresh?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    corpus_id: corpusId,
    family: overrides.family ?? 'document',
    trust_domain: overrides.trust_domain ?? 'internal',
    ...(overrides.embedding_policy ? { embedding_policy: overrides.embedding_policy } : {}),
    ...(overrides.embedding_parity ? { embedding_parity: overrides.embedding_parity } : {}),
    configured: true,
    counts: {
      total_items: 5,
      ...overrides.counts,
    },
    last_refresh: overrides.last_refresh ?? {
      sync_run_id: `${corpusId}-sync-1`,
      status: 'completed',
      started_at: new Date(Date.now() - HOUR_MS).toISOString(),
      completed_at: new Date(Date.now() - HOUR_MS / 2).toISOString(),
      items_seen: 5,
      items_indexed: 5,
    },
  };
}

function connectedHandle(provider: 'dropbox' | 'readwise' | 'gmail' | 'google_drive') {
  if (provider === 'dropbox') {
    return {
      handle: 'dropbox.personal',
      provider: 'dropbox' as const,
      accountRole: 'personal',
      trustDomain: 'secure_local' as const,
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: ['files.metadata.read'],
      connectedAt: '2026-07-07T12:00:00.000Z',
    };
  }
  if (provider === 'readwise') {
    return {
      handle: 'readwise.personal',
      provider: 'readwise' as const,
      accountRole: 'personal',
      trustDomain: 'internal' as const,
      allowedCapabilities: ['readwise.sync'],
      scopes: ['readwise.reader:read'],
      connectedAt: '2026-07-07T12:00:00.000Z',
    };
  }
  if (provider === 'gmail') {
    return {
      handle: 'gmail.personal',
      provider: 'gmail' as const,
      accountRole: 'personal',
      trustDomain: 'secure_local' as const,
      allowedCapabilities: ['gmail.email.sync'],
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      connectedAt: '2026-07-07T12:00:00.000Z',
    };
  }
  return {
    handle: 'google_drive.personal',
    provider: 'google_drive' as const,
    accountRole: 'personal',
    trustDomain: 'internal' as const,
    allowedCapabilities: ['google_drive.docs.sync'],
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
    ],
    connectedAt: '2026-07-07T12:00:00.000Z',
  };
}

function checkByName(checks: DoctorCheck[], name: string): DoctorCheck {
  const check = checks.find((candidate) => candidate.name === name);
  expect(check).toBeDefined();
  return check!;
}

function doctorDeps(overrides: DoctorDeps): DoctorDeps {
  const stateRoot = mkdtempSync(join(tmpdir(), 'olympus-doctor-ingestion-state-'));
  process.on('exit', () => rmSync(stateRoot, { recursive: true, force: true }));
  return {
    commandExists: async (command) => command === 'bun' || command === 'node',
    pythonModuleExists: async () => false,
    // Doctor tests must never inherit a live local worker from the host. Tests
    // that exercise HTTP behavior provide their own explicit fetch seam.
    fetchImpl: fakeWorkerFetch({}).fetchImpl,
    readHandleRegistry: () => ({ version: 1, handles: [] }),
    env: {},
    secretStore: memorySecretStore({}),
    ingestionHealthStatePath: join(stateRoot, 'source-ingestion-doctor-state.json'),
    ...overrides,
  };
}

describe('runDoctor', () => {
  test('reports all green when lanes, worker, and source index are healthy', async () => {
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [dropboxCorpusReport()],
      },
    });

    const result = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      handleRegistry: { version: 1, handles: [connectedHandle('dropbox')] },
    }));

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual([
      'dependencies',
      'source_capability_catalog',
      'sovereignty_prerequisites',
      'credential_handles',
      'detached_oauth_connections',
      'google_oauth_refresh_lifetime',
      'credential_reauthorization_backlog',
      'argus_model_pool',
      'sovereignty_model_lanes',
      'email_worker',
      'worker_credential_lanes',
      'dropbox_content_extraction_throughput',
      'source_index_status',
      'source_scheduler_status',
      'source_ingestion_health',
    ]);
    expect(checkByName(result.checks, 'argus_model_pool').detail).toContain('no sovereignty posture configured yet');
    expect(checkByName(result.checks, 'email_worker').detail).toContain('configured=true');
    expect(checkByName(result.checks, 'source_index_status').detail)
      .toContain('secure_local.dropbox.files: connector store, 100 chunks, 100 embedded');
  });

  test('flags a down Argus model pool with the rehydration runbook hint and never throws', async () => {
    const delphi: DoctorDeps['delphi'] = {
      listModels: async () => [{ id: 'legacy-model' }],
      listModelsForProfile: async () => {
        throw new Error('connection refused');
      },
      complete: async (options) => ({
        text: 'OLYMPUS_DOCTOR_OK',
        ...(options.lane ? { lane: options.lane } : {}),
        model: 'deep-model',
      }),
    };

    const result = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi,
      sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('local-first')),
    }));

    expect(result.ok).toBe(false);
    const modelPool = checkByName(result.checks, 'argus_model_pool');
    expect(modelPool.ok).toBe(false);
    expect(modelPool.detail).toContain('connection refused');
    expect(modelPool.hint).toContain('local model service');
  });

  test('flags an Argus model pool whose model list works but generation hangs or fails', async () => {
    const delphi: DoctorDeps['delphi'] = {
      listModels: async (lane) => [{ id: `${lane}-model` }],
      listModelsForProfile: async (profile) => [{ id: `${profile}-model` }],
      complete: async (options) => {
        if (options.profile === 'default_chat') throw new Error('generation timed out');
        return {
          text: 'OLYMPUS_DOCTOR_OK',
          ...(options.lane ? { lane: options.lane } : {}),
          ...(options.profile ? { profile: options.profile } : {}),
          model: `${options.profile ?? options.lane}-model`,
        };
      },
    };

    const result = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi,
      sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('local-first')),
    }));

    expect(result.ok).toBe(false);
    const modelPool = checkByName(result.checks, 'argus_model_pool');
    expect(modelPool.ok).toBe(false);
    expect(modelPool.detail).toContain('generation timed out');
    expect(modelPool.hint).toContain('local model service');
  });

  test('skips the Argus pool probe when the posture configures no local lane', async () => {
    const delphi: DoctorDeps['delphi'] = {
      listModels: async () => {
        throw new Error('must not probe');
      },
      listModelsForProfile: async () => {
        throw new Error('must not probe');
      },
      complete: async () => {
        throw new Error('must not probe');
      },
    };
    const engine = createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only'));

    const result = await runDoctor(doctorDeps({ config: defaultConfig(), delphi, sovereigntyEngine: engine }));

    const modelPool = checkByName(result.checks, 'argus_model_pool');
    expect(modelPool.ok).toBe(true);
    expect(modelPool.detail).toContain('no local model lane');
    expect(modelPool.detail).toContain('ordinary Venice API');
    expect(modelPool.detail).toContain('does not provide or qualify E2EE out of the box');
    expect(modelPool.detail).toContain('custom integrations are user-owned');
    expect(modelPool.detail).toContain('secure corpora remain lexical-only');
    expect(modelPool.detail).not.toContain('E2EE and Anonymized models are refused');
  });

  test('skips the Argus pool probe on a fresh install with no posture chosen', async () => {
    const delphi: DoctorDeps['delphi'] = {
      listModels: async () => { throw new Error('must not probe'); },
      listModelsForProfile: async () => { throw new Error('must not probe'); },
      complete: async () => { throw new Error('must not probe'); },
    };
    // defaultConfig() has no sovereignty policy/configPath — a pre-setup install.
    const result = await runDoctor(doctorDeps({ config: defaultConfig(), delphi }));
    const modelPool = checkByName(result.checks, 'argus_model_pool');
    expect(modelPool.ok).toBe(true);
    expect(modelPool.detail).toContain('no sovereignty posture configured yet');
    expect(modelPool.detail).not.toContain('127.0.0.1:8000');
  });

  test('probes the Argus pool when the posture includes a local lane', async () => {
    const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
    const delphi: DoctorDeps['delphi'] = {
      listModels: async (lane) => [{ id: `${lane}-model` }],
      listModelsForProfile: async () => {
        throw new Error('connection refused');
      },
      complete: async () => {
        throw new Error('connection refused');
      },
    };

    const result = await runDoctor(doctorDeps({ config: defaultConfig(), delphi, sovereigntyEngine: engine }));

    const modelPool = checkByName(result.checks, 'argus_model_pool');
    expect(modelPool.ok).toBe(false);
    expect(modelPool.detail).toContain('connection refused');
  });

  test('flags a stale running Dropbox sync row older than 24h', async () => {
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [dropboxCorpusReport({
          last_refresh: {
            sync_run_id: 'dropbox-sync-stuck',
            status: 'running',
            started_at: new Date(Date.now() - 25 * HOUR_MS).toISOString(),
            items_seen: 0,
            items_indexed: 0,
          },
        })],
      },
    });

    const result = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      handleRegistry: { version: 1, handles: [connectedHandle('dropbox')] },
    }));

    expect(result.ok).toBe(false);
    const sourceIndex = checkByName(result.checks, 'source_index_status');
    expect(sourceIndex.ok).toBe(false);
    expect(sourceIndex.detail).toContain('dropbox-sync-stuck');
    expect(sourceIndex.detail).toContain('older than 24h');
    expect(checkByName(result.checks, 'email_worker').ok).toBe(true);
  });

  test('does not flag a recent running sync row or a completed old one', async () => {
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [dropboxCorpusReport({
          last_refresh: {
            sync_run_id: 'dropbox-sync-fresh',
            status: 'running',
            started_at: new Date(Date.now() - HOUR_MS).toISOString(),
            items_seen: 0,
            items_indexed: 0,
          },
        })],
      },
    });

    const result = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      handleRegistry: { version: 1, handles: [connectedHandle('dropbox')] },
    }));

    expect(result.ok).toBe(true);
    expect(checkByName(result.checks, 'source_index_status').ok).toBe(true);
  });

  test('flags Dropbox connector-store embedding lag above 10% of chunks', async () => {
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [dropboxCorpusReport({
          counts: {
            chunks: 200,
            embedded_chunks: 150,
          },
        })],
      },
    });

    const result = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      handleRegistry: { version: 1, handles: [connectedHandle('dropbox')] },
    }));

    expect(result.ok).toBe(false);
    const sourceIndex = checkByName(result.checks, 'source_index_status');
    expect(sourceIndex.ok).toBe(false);
    expect(sourceIndex.detail).toContain('embedding lag is 50 of 200 chunks');
    expect(sourceIndex.hint).toBeDefined();
  });

  test('flags embedding lag on a non-Dropbox connector-store corpus', async () => {
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [corpusReport('internal.email', {
          family: 'email',
          counts: { chunks: 200, embedded_chunks: 100 },
        })],
      },
    });
    const result = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      handleRegistry: { version: 1, handles: [connectedHandle('gmail')] },
    }));
    const sourceIndex = checkByName(result.checks, 'source_index_status');
    expect(sourceIndex.ok).toBe(false);
    expect(sourceIndex.detail).toContain('internal.email embedding lag is 100 of 200 chunks');
  });

  test('does not call unembedded chunks lag when the corpus disables embeddings', async () => {
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [corpusReport('internal.email', {
          family: 'email',
          embedding_policy: 'disabled',
          embedding_parity: { required: false },
          counts: { chunks: 200, embedded_chunks: 0 },
        })],
      },
    });
    const result = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      handleRegistry: { version: 1, handles: [connectedHandle('gmail')] },
    }));
    const sourceIndex = checkByName(result.checks, 'source_index_status');
    expect(sourceIndex.ok).toBe(true);
    expect(sourceIndex.detail).toContain('200 chunks, embeddings disabled');
    expect(sourceIndex.detail).not.toContain('embedding lag');
  });

  test('diagnoses lag from current embedding parity rather than obsolete raw artifacts', async () => {
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [corpusReport('internal.email', {
          family: 'email',
          embedding_policy: 'local_private',
          embedding_parity: {
            required: true,
            chunks: 200,
            embedded_chunks: 0,
            missing_chunks: 200,
            refresh_needed: true,
          },
          counts: { chunks: 200, embedded_chunks: 200 },
        })],
      },
    });
    const result = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      handleRegistry: { version: 1, handles: [connectedHandle('gmail')] },
    }));
    const sourceIndex = checkByName(result.checks, 'source_index_status');
    expect(sourceIndex.ok).toBe(false);
    expect(sourceIndex.detail).toContain('internal.email embedding lag is 200 of 200 chunks');
  });

  test('worker credential lanes fail with sourceIndex enabled even when the email worker is disabled', async () => {
    const degradedCredential = {
      kind: 'worker_credential_degraded',
      display_name: 'Sovereignty embedding profile "gemini-internal"',
      state: 'stopped',
      status_label: 'Credential unavailable - needs your attention',
      hint: 'Unlock or reconnect this credential, then restart the Olympus worker or run the credential re-check route.',
      attempts: 3,
      max_attempts: 3,
      affected_profiles: ['gemini-internal'],
      affected_capabilities: ['embedding'],
    };
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [],
        degraded_credentials: [degradedCredential],
      },
    });

    // The email lane is on by default now, so "disabled" is stated here.
    const disabledEmailConfig = defaultConfig();
    disabledEmailConfig.email.enabled = false;
    const result = await runDoctor(doctorDeps({
      config: disabledEmailConfig,
      delphi: healthyDelphi(),
      fetchImpl,
    }));

    expect(result.ok).toBe(false);
    expect(checkByName(result.checks, 'email_worker').ok).toBe(true);
    const lanes = checkByName(result.checks, 'worker_credential_lanes');
    expect(lanes.ok).toBe(false);
    expect(lanes.detail).toContain('Sovereignty embedding profile "gemini-internal"');
    expect(lanes.detail).toContain('state=stopped');
    expect(lanes.detail).toContain('affected capabilities: embedding');
    expect(lanes.hint).toContain('credentials/recheck');
    const sourceIndex = checkByName(result.checks, 'source_index_status');
    expect(sourceIndex.ok).toBe(true);
    expect(sourceIndex.detail).toContain('disabled');
  });

  test('skips worker checks as ok when the email worker and source index are disabled', async () => {
    const { fetchImpl, requestedPaths } = fakeWorkerFetch({});
    const config = defaultConfig();
    config.email.enabled = false;
    config.sourceIndex.enabled = false;

    const result = await runDoctor(doctorDeps({ config, delphi: healthyDelphi(), fetchImpl }));

    expect(result.ok).toBe(true);
    const emailWorker = checkByName(result.checks, 'email_worker');
    expect(emailWorker.ok).toBe(true);
    expect(emailWorker.detail).toContain('disabled');
    const sourceIndex = checkByName(result.checks, 'source_index_status');
    expect(sourceIndex.ok).toBe(true);
    expect(sourceIndex.detail).toContain('disabled');
    const lanes = checkByName(result.checks, 'worker_credential_lanes');
    expect(lanes.ok).toBe(true);
    expect(lanes.detail).toContain('sourceIndex.enabled=false');
    expect(requestedPaths).toEqual([]);
  });

  test('fails closed without throwing when the worker is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await runDoctor(doctorDeps({ config: enabledEmailConfig(), delphi: healthyDelphi(), fetchImpl }));

    expect(result.ok).toBe(false);
    expect(checkByName(result.checks, 'email_worker').ok).toBe(false);
    expect(checkByName(result.checks, 'email_worker').detail).toContain('ECONNREFUSED');
    expect(checkByName(result.checks, 'worker_credential_lanes').ok).toBe(false);
    expect(checkByName(result.checks, 'source_index_status').ok).toBe(false);
  });

  test('reports worker boot credential degradation with a fix hint', async () => {
    const degradedCredential = {
      kind: 'worker_credential_degraded',
      display_name: 'Sovereignty embedding profile "gemini-internal"',
      state: 'stopped',
      status_label: 'Credential unavailable - needs your attention',
      hint: 'Unlock or reconnect this credential, then restart the Olympus worker or run the credential re-check route.',
      attempts: 3,
      max_attempts: 3,
      affected_profiles: ['gemini-internal'],
      affected_capabilities: ['embedding'],
    };
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': {
        status: 'degraded',
        configured: true,
        degraded_credentials: [degradedCredential],
      },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [],
        degraded_credentials: [degradedCredential],
      },
    });

    const result = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
    }));

    const worker = checkByName(result.checks, 'email_worker');
    const lanes = checkByName(result.checks, 'worker_credential_lanes');
    expect(result.ok).toBe(false);
    expect(worker.ok).toBe(false);
    expect(worker.detail).toContain('Sovereignty embedding profile "gemini-internal"');
    expect(worker.detail).toContain('Credential unavailable');
    expect(worker.hint).toContain('credentials/recheck');
    expect(lanes.ok).toBe(false);
    expect(lanes.detail).toContain('affected capabilities: embedding');
  });

  test('fails when actionable Dropbox extraction work has no terminal progress past the threshold', async () => {
    const now = new Date('2026-07-16T12:00:00.000Z');
    const result = await runDoctorWithDropboxThroughput({
      now,
      actionableQueued: 170,
      actionableRetryableDue: 1,
      oldestActionableHours: 46,
      terminalProgressHours: 46,
    });

    const check = checkByName(result.checks, 'dropbox_content_extraction_throughput');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('171 actionable queued/retryable-due job(s)');
    expect(check.detail).toContain('no terminal progress for 46h (>=6h)');
  });

  test('keeps Dropbox extraction throughput green when the actionable queue is empty', async () => {
    const result = await runDoctorWithDropboxThroughput({
      now: new Date('2026-07-16T12:00:00.000Z'),
      actionableQueued: 0,
      terminalProgressHours: 72,
    });

    const check = checkByName(result.checks, 'dropbox_content_extraction_throughput');
    expect(result.ok).toBe(true);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('no actionable queued or retryable-due jobs');
  });

  test('keeps Dropbox extraction throughput green after fresh terminal progress', async () => {
    const result = await runDoctorWithDropboxThroughput({
      now: new Date('2026-07-16T12:00:00.000Z'),
      actionableQueued: 12,
      oldestActionableHours: 10,
      terminalProgressHours: 1,
    });

    const check = checkByName(result.checks, 'dropbox_content_extraction_throughput');
    expect(result.ok).toBe(true);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('12 actionable queued/retryable-due job(s)');
    expect(check.detail).toContain('terminal progress 1h ago (<6h)');
  });

  test('ignores a Dropbox queue containing only superseded or policy-excluded rows', async () => {
    const result = await runDoctorWithDropboxThroughput({
      now: new Date('2026-07-16T12:00:00.000Z'),
      actionableQueued: 0,
      rawQueued: 88,
      oldestActionableHours: 46,
      terminalProgressHours: 46,
    });

    const check = checkByName(result.checks, 'dropbox_content_extraction_throughput');
    expect(result.ok).toBe(true);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('no actionable queued or retryable-due jobs');
  });

  test('honors the Dropbox extraction stall threshold environment override', async () => {
    const result = await runDoctorWithDropboxThroughput({
      now: new Date('2026-07-16T12:00:00.000Z'),
      actionableQueued: 3,
      oldestActionableHours: 4,
      terminalProgressHours: 4,
      env: { OLYMPUS_DROPBOX_CONTENT_EXTRACTION_STALL_HOURS: '3' },
    });

    const check = checkByName(result.checks, 'dropbox_content_extraction_throughput');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('no terminal progress for 4h (>=3h)');
  });

  test('warns at half the Dropbox extraction stall threshold without failing doctor', async () => {
    const result = await runDoctorWithDropboxThroughput({
      now: new Date('2026-07-16T12:00:00.000Z'),
      actionableQueued: 2,
      oldestActionableHours: 3,
      terminalProgressHours: 3,
    });

    const check = checkByName(result.checks, 'dropbox_content_extraction_throughput');
    expect(result.ok).toBe(true);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('WARNING');
    expect(check.detail).toContain('warning at half of 6h');
  });

  test('flags missing required dependencies with public repair hints', async () => {
    const result = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi: healthyDelphi(),
      commandExists: async (command) => command !== 'bun',
    }));

    const dependencies = checkByName(result.checks, 'dependencies');
    expect(dependencies.ok).toBe(false);
    expect(dependencies.detail).toContain('bun');
    expect(dependencies.hint).toContain('https://bun.sh/docs/installation');
  });

  test('flags explicit sovereignty model lane URL failures with profile id', async () => {
    const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/models')) throw new Error('ECONNREFUSED');
      return jsonResponse({ status: 'ok', configured: true });
    }) as unknown as typeof fetch;

    const result = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      sovereigntyEngine: engine,
    }));

    const lane = checkByName(result.checks, 'sovereignty_model_lanes');
    expect(lane.ok).toBe(false);
    expect(lane.detail).toContain('local-source-answer');
    expect(lane.detail).toContain('http://127.0.0.1:28090/v1/models');
  });

  test('flags active sovereignty preset prerequisites as doctor errors', async () => {
    const engine = createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only'));
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/models')) return jsonResponse({ data: [{ id: 'local-model' }] });
      return jsonResponse({ status: 'ok', configured: true });
    }) as unknown as typeof fetch;

    const result = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      sovereigntyEngine: engine,
      env: { GEMINI_API_KEY: 'gemini-test-key' },
      secretStore: memorySecretStore({}),
    }));

    const prerequisites = checkByName(result.checks, 'sovereignty_prerequisites');
    expect(prerequisites.ok).toBe(false);
    expect(prerequisites.detail).toContain('venice.api_key');
    expect(prerequisites.detail).not.toContain('127.0.0.1:8000/v1');
    expect(prerequisites.hint).toContain('olympus connect venice --api-key-stdin');
  });

  test('passes sovereignty prerequisite check when no-sensitive API key is present', async () => {
    const result = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi: healthyDelphi(),
      sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('no-sensitive')),
      env: { GEMINI_API_KEY: 'gemini-test-key' },
    }));

    const prerequisites = checkByName(result.checks, 'sovereignty_prerequisites');
    expect(prerequisites.ok).toBe(true);
    expect(prerequisites.detail).toContain('present');
  });

  test('a reachable local lane is not reported as an unmet prerequisite', async () => {
    // Setup's preflight cannot probe, so it declares every local lane unmet.
    // Doctor probes the same lanes in sovereignty_model_lanes, so counting the
    // advisory here left this check red on every local posture forever.
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/models')) return jsonResponse({ data: [{ id: 'local-model' }] });
      return jsonResponse({ status: 'ok', configured: true });
    }) as unknown as typeof fetch;

    const result = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('local-first')),
      env: { GEMINI_API_KEY: 'gemini-test-key' },
      secretStore: memorySecretStore({ 'venice.api_key': 'venice-test-key' }),
    }));

    const prerequisites = checkByName(result.checks, 'sovereignty_prerequisites');
    expect(prerequisites.ok).toBe(true);
    expect(checkByName(result.checks, 'sovereignty_model_lanes').ok).toBe(true);
  });

  test('an unreachable secret is still reported while the local lane is left to its own probe', async () => {
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/models')) return jsonResponse({ data: [{ id: 'local-model' }] });
      return jsonResponse({ status: 'ok', configured: true });
    }) as unknown as typeof fetch;

    const result = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('local-first')),
      env: { GEMINI_API_KEY: 'gemini-test-key' },
      secretStore: memorySecretStore({}),
    }));

    const prerequisites = checkByName(result.checks, 'sovereignty_prerequisites');
    expect(prerequisites.ok).toBe(false);
    expect(prerequisites.detail).toContain('venice.api_key');
    expect(prerequisites.detail).not.toContain('127.0.0.1:8000/v1');
  });

  test('flags reauthorization-required connected handles', async () => {
    const result = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi: healthyDelphi(),
      handleRegistry: {
        version: 1,
        handles: [{
          handle: 'telegram.personal',
          provider: 'telegram',
          sessionKind: 'mtproto_session',
          accountRole: 'personal',
          trustDomain: 'secure_local',
          allowedCapabilities: ['telegram.messages.sync'],
          scopes: [],
          backendState: { kind: 'mtproto_session', status: 'reauth_required' },
          connectedAt: '2026-07-02T12:00:00.000Z',
        }],
      },
    }));

    const credentials = checkByName(result.checks, 'credential_handles');
    expect(credentials.ok).toBe(false);
    expect(credentials.detail).toContain('telegram.personal');
    expect(credentials.hint).toContain('olympus connect');
  });

  test('flags pending detached OAuth state whose child process died', async () => {
    const result = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi: healthyDelphi(),
      oauthStateDir: join(import.meta.dir, 'fixtures', 'missing-oauth-state-dir'),
      oauthPidAlive: () => false,
    }));

    const check = checkByName(result.checks, 'detached_oauth_connections');
    expect(check.ok).toBe(true);

    const stateDir = await makeDetachedOAuthStateFixture();
    const withState = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi: healthyDelphi(),
      oauthStateDir: stateDir,
      oauthPidAlive: () => false,
    }));
    const oauth = checkByName(withState.checks, 'detached_oauth_connections');
    expect(oauth.ok).toBe(false);
    expect(oauth.detail).toContain('gmail/personal status=died');
    expect(oauth.detail).toContain('oauth.log');
    expect(oauth.hint).toContain('olympus connect status');
  });

  test('reports Google OAuth refresh registry state', async () => {
    const result = await runDoctor(doctorDeps({ config: defaultConfig(), delphi: healthyDelphi() }));

    const google = checkByName(result.checks, 'google_oauth_refresh_lifetime');
    expect(google.ok).toBe(true);
    expect(google.detail).toContain('No Google OAuth refresh reauthorization state');
    expect(google.hint).toContain('Testing mode refresh tokens expire after 7 days');

    const withReauth = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi: healthyDelphi(),
      handleRegistry: {
        version: 1,
        handles: [{
          handle: 'gmail.personal',
          provider: 'gmail',
          accountRole: 'personal',
          trustDomain: 'secure_local',
          allowedCapabilities: ['gmail.email.sync'],
          scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          oauth2Refresh: {
            tokenUrl: 'https://oauth2.googleapis.com/token',
            clientIdSecretRef: 'store:gmail.personal.oauth.client_id',
            clientSecretSecretRef: 'store:gmail.personal.oauth.client_secret',
            refreshTokenSecretRef: 'store:gmail.personal.oauth.refresh_token',
          },
          backendState: {
            kind: 'oauth2_refresh',
            status: 'reauth_required',
          },
          connectedAt: '2026-07-07T12:00:00.000Z',
        }],
      },
    }));

    const failed = checkByName(withReauth.checks, 'google_oauth_refresh_lifetime');
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain('gmail.personal');
    expect(failed.hint).toContain('olympus connect');
  });

  test('reports a handle needing reauthorization even with no oauth2Refresh block to recognise it by', async () => {
    const clean = await runDoctor(doctorDeps({ config: defaultConfig(), delphi: healthyDelphi() }));
    const quiet = checkByName(clean.checks, 'credential_reauthorization_backlog');
    expect(quiet.ok).toBe(true);
    expect(quiet.detail).toContain('No token-refresh handle is waiting for reauthorization');

    // The registry shape the X activation gate requires: catalog-minted handle,
    // no oauth2Refresh block, so the provider-specific checks cannot see it.
    const withReauth = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi: healthyDelphi(),
      handleRegistry: {
        version: 1,
        handles: [{
          handle: 'x.bookmarks.personal',
          provider: 'x',
          accountRole: 'personal',
          trustDomain: 'internal',
          allowedCapabilities: ['x.bookmarks.sync'],
          scopes: ['tweet.read', 'bookmark.read', 'offline.access'],
          providerAccountId: '1234567890',
          backendState: {
            kind: 'oauth2_refresh',
            status: 'reauth_required',
          },
          connectedAt: '2026-07-20T12:00:00.000Z',
        }],
      },
    }));

    const failed = checkByName(withReauth.checks, 'credential_reauthorization_backlog');
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain('x.bookmarks.personal');
    expect(failed.hint).toContain('olympus connect');
    expect(checkByName(withReauth.checks, 'google_oauth_refresh_lifetime').ok).toBe(true);

    // A guided session that has simply never been paired reports the same
    // status; it is a setup step, not a credential that died.
    const unpaired = await runDoctor(doctorDeps({
      config: defaultConfig(),
      delphi: healthyDelphi(),
      handleRegistry: {
        version: 1,
        handles: [{
          handle: 'telegram.personal',
          provider: 'telegram',
          sessionKind: 'mtproto_session',
          accountRole: 'personal',
          trustDomain: 'secure_local',
          allowedCapabilities: ['telegram.messages.sync'],
          scopes: [],
          backendState: {
            kind: 'mtproto_session',
            status: 'reauth_required',
            mtprotoProfileId: 'telegram_personal',
            runtimeEndpointId: 'telegram_local_telethon_reader',
            library: 'telethon',
            backendLabel: 'local_private:telegram_telethon_reader',
          },
          connectedAt: '2026-07-20T12:00:00.000Z',
        }],
      },
    }));

    expect(checkByName(unpaired.checks, 'credential_reauthorization_backlog').ok).toBe(true);
  });

  test('reports never-synced unconnected corpora as optional source information', async () => {
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [{
          corpus_id: 'internal.readwise.library',
          family: 'document',
          trust_domain: 'internal',
          configured: true,
          counts: {},
        }],
      },
    });

    const result = await runDoctor(doctorDeps({ config: enabledEmailConfig(), delphi: healthyDelphi(), fetchImpl }));

    const sourceIndex = checkByName(result.checks, 'source_index_status');
    expect(result.ok).toBe(true);
    expect(sourceIndex.ok).toBe(true);
    expect(sourceIndex.detail).toContain('internal.readwise.library not connected');
    expect(sourceIndex.detail).toContain('optional');
    expect(sourceIndex.detail).not.toContain('has never completed a source sync');
  });

  test('reports connected corpora with no first sync as pending information', async () => {
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [{
          corpus_id: 'internal.readwise.library',
          family: 'readwise',
          trust_domain: 'internal',
          configured: true,
          counts: {},
        }],
      },
    });

    const result = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      handleRegistry: { version: 1, handles: [connectedHandle('readwise')] },
    }));

    const sourceIndex = checkByName(result.checks, 'source_index_status');
    expect(result.ok).toBe(true);
    expect(sourceIndex.ok).toBe(true);
    expect(sourceIndex.detail).toContain('internal.readwise.library connected');
    expect(sourceIndex.detail).toContain('first sync pending');
    expect(sourceIndex.detail).not.toContain('has never completed a source sync');
  });

  test('keeps a fresh install green when optional sources are not connected', async () => {
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [
          corpusReport('internal.email', { family: 'email' }),
          corpusReport('internal.drive.docs', { family: 'file' }),
          corpusReport('internal.telegram.messages', { family: 'chat' }),
          corpusReport('internal.x.bookmarks', { family: 'x' }),
          corpusReport('secure_local.whatsapp.messages', { family: 'chat', trust_domain: 'secure_local' }),
          corpusReport('internal.readwise.library', { family: 'readwise', trust_domain: 'internal' }),
          dropboxCorpusReport(),
          corpusReport('internal.solon.governance-library', { family: 'file' }),
        ],
      },
    });

    const result = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      handleRegistry: {
        version: 1,
        handles: [connectedHandle('dropbox'), connectedHandle('readwise')],
      },
    }));

    expect(result.ok).toBe(true);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    const output = result.checks.map((check) => `${check.name} ${check.detail}`).join('\n');
    expect(output).not.toContain('Solon');
    expect(output).not.toContain('solon');
    expect(output).not.toContain('governance');
    const sourceIndex = checkByName(result.checks, 'source_index_status');
    expect(sourceIndex.detail).toContain('internal.email not connected');
    expect(sourceIndex.detail).toContain('internal.drive.docs not connected');
    expect(sourceIndex.detail).toContain('internal.telegram.messages not connected');
    expect(sourceIndex.detail).toContain('internal.x.bookmarks not connected');
    expect(sourceIndex.detail).toContain('secure_local.whatsapp.messages not connected');
    expect(sourceIndex.detail).toContain('optional');
    expect(sourceIndex.detail).toContain('secure_local.dropbox.files: connector store, 100 chunks, 100 embedded');
    expect(sourceIndex.detail).not.toContain('has never completed a source sync');
  });

  test('reports only canonical Dropbox connector-store counters', async () => {
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [dropboxCorpusReport({
          read_authority: 'connector_store',
          counts: { chunks: 12, embedded_chunks: 12 },
        })],
      },
    });

    const result = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl,
      handleRegistry: {
        version: 1,
        handles: [connectedHandle('dropbox')],
      },
    }));

    const sourceIndex = checkByName(result.checks, 'source_index_status');
    expect(sourceIndex.ok).toBe(true);
    expect(sourceIndex.detail).toContain('secure_local.dropbox.files: connector store, 12 chunks, 12 embedded');
    expect(sourceIndex.detail).not.toContain('extraction jobs failed');
  });

  test('hides Solon domain corpus checks when no domain is configured', async () => {
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [{
          corpus_id: 'internal.solon.governance-library',
          family: 'file',
          trust_domain: 'internal',
          configured: true,
          counts: {},
        }],
      },
    });

    const result = await runDoctor(doctorDeps({ config: enabledEmailConfig(), delphi: healthyDelphi(), fetchImpl }));

    expect(result.ok).toBe(true);
    const output = result.checks.map((check) => `${check.name} ${check.detail}`).join('\n');
    expect(output).not.toContain('Solon');
    expect(output).not.toContain('solon');
    expect(output).not.toContain('governance');
    expect(checkByName(result.checks, 'source_index_status').detail)
      .toContain('healthy across 0 corpus reports');
  });

  test('flags scheduler stalls from the worker scheduler feed', async () => {
    const config = enabledEmailConfig();
    config.worker.scheduler.enabled = true;
    config.worker.scheduler.maxTransientRetries = 3;
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [dropboxCorpusReport()],
      },
      '/v1/source/scheduler/status': {
        kind: 'source_scheduler_status',
        enabled: true,
        running: true,
        generated_at: '2026-07-02T12:00:00.000Z',
        sources: [{
          source_id: 'dropbox.files',
          corpus_id: 'secure_local.dropbox.files',
          stale_sync_anomaly: true,
          tasks: [{
            id: 'dropbox.metadata_sync',
            running: false,
            consecutive_failures: 3,
            stale_anomaly: true,
          }],
        }],
      },
    });

    const result = await runDoctor(doctorDeps({ config, delphi: healthyDelphi(), fetchImpl }));

    const scheduler = checkByName(result.checks, 'source_scheduler_status');
    expect(scheduler.ok).toBe(false);
    expect(scheduler.detail).toContain('freshness threshold');
    expect(scheduler.detail).toContain('dropbox.files/dropbox.metadata_sync is past its task freshness threshold');
    expect(scheduler.detail).toContain('3 consecutive failures');
  });

  test('flags connected handles that have no active sync lane', async () => {
    const config = enabledEmailConfig();
    config.worker.scheduler.enabled = true;
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [],
      },
      '/v1/source/scheduler/status': {
        kind: 'source_scheduler_status',
        enabled: true,
        running: true,
        generated_at: '2026-07-07T12:00:00.000Z',
        sources: [],
      },
    });

    const result = await runDoctor(doctorDeps({
      config,
      delphi: healthyDelphi(),
      fetchImpl,
      handleRegistry: {
        version: 1,
        handles: [{
          handle: 'readwise.personal',
          provider: 'readwise',
          accountRole: 'personal',
          trustDomain: 'internal',
          allowedCapabilities: ['readwise.sync'],
          scopes: ['readwise.reader:read'],
          connectedAt: '2026-07-07T12:00:00.000Z',
        }],
      },
    }));

    const scheduler = checkByName(result.checks, 'source_scheduler_status');
    expect(scheduler.ok).toBe(false);
    expect(scheduler.detail).toContain('readwise.personal connected but nothing will sync it');
    expect(scheduler.detail).toContain('missing corpus internal.readwise.library');
    expect(scheduler.detail).toContain('missing scheduler source readwise.library');
  });

  test('flags connected default-off lane when the env gate is explicitly disabled', async () => {
    const config = enabledEmailConfig();
    config.worker.scheduler.enabled = true;
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [],
      },
      '/v1/source/scheduler/status': {
        kind: 'source_scheduler_status',
        enabled: true,
        running: true,
        generated_at: '2026-07-07T12:00:00.000Z',
        sources: [],
      },
    });

    const result = await runDoctor(doctorDeps({
      config,
      delphi: healthyDelphi(),
      fetchImpl,
      env: {
        OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_ENABLED: 'false',
      },
      handleRegistry: {
        version: 1,
        handles: [connectedHandle('gmail')],
      },
    }));

    const scheduler = checkByName(result.checks, 'source_scheduler_status');
    expect(scheduler.ok).toBe(false);
    expect(scheduler.detail).toContain('gated off by OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_ENABLED=false');
    expect(scheduler.detail).toContain('missing corpus internal.email');
    expect(scheduler.detail).toContain('missing scheduler source gmail.email');
  });

  test('does not flag connected Gmail and Drive handles when connector corpora and scheduler sources exist', async () => {
    const config = enabledEmailConfig();
    config.worker.scheduler.enabled = true;
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [
          { corpus_id: 'internal.email' },
          { corpus_id: 'secure_local.email.private' },
          { corpus_id: 'internal.drive.docs' },
          { corpus_id: 'secure_local.drive.docs' },
        ],
      },
      '/v1/source/scheduler/status': {
        kind: 'source_scheduler_status',
        enabled: true,
        running: true,
        generated_at: '2026-07-07T12:00:00.000Z',
        sources: [
          { source_id: 'gmail.email', corpus_id: 'internal.email', tasks: [] },
          { source_id: 'google_drive.docs', corpus_id: 'internal.drive.docs', tasks: [] },
        ],
      },
    });

    const result = await runDoctor(doctorDeps({
      config,
      delphi: healthyDelphi(),
      fetchImpl,
      handleRegistry: {
        version: 1,
        handles: [
          {
            handle: 'gmail.personal',
            provider: 'gmail',
            accountRole: 'personal',
            trustDomain: 'secure_local',
            allowedCapabilities: ['gmail.email.sync'],
            scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            connectedAt: '2026-07-07T12:00:00.000Z',
          },
          {
            handle: 'google_drive.personal',
            provider: 'google_drive',
            accountRole: 'personal',
            trustDomain: 'internal',
            allowedCapabilities: ['google_drive.docs.sync'],
            scopes: [
              'https://www.googleapis.com/auth/drive.readonly',
            ],
            connectedAt: '2026-07-07T12:00:00.000Z',
          },
        ],
      },
    }));

    const scheduler = checkByName(result.checks, 'source_scheduler_status');
    expect(scheduler.ok).toBe(true);
    expect(scheduler.detail).not.toContain('connected but nothing will sync it');
  });

  // The 2026-07-28 question: is it safe to admit a source id whose lane the
  // worker does not build yet? It is not. Pre-arming the allowlist for tranches
  // still in flight fails the check for every absent id, twice over — once from
  // the worker's own missing list and once from the active-source comparison.
  test('fails every allowlisted scheduler source whose lane the worker did not build', async () => {
    const config = enabledEmailConfig();
    config.worker.scheduler.enabled = true;
    config.worker.scheduler.sourceIds = [
      'readwise.library',
      'google_drive.docs',
      'gmail.email',
      'dropbox.files',
    ];
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [{ corpus_id: 'internal.readwise.library' }],
      },
      '/v1/source/scheduler/status': {
        kind: 'source_scheduler_status',
        enabled: true,
        running: true,
        generated_at: '2026-07-28T12:00:00.000Z',
        selected_source_ids: [
          'readwise.library',
          'google_drive.docs',
          'gmail.email',
          'dropbox.files',
        ],
        // Only Readwise has a live credential handle, so only its source was
        // constructed (email-source/server.ts builds each lane's source solely
        // for an active non-reauth handle).
        missing_selected_source_ids: ['google_drive.docs', 'gmail.email', 'dropbox.files'],
        sources: [{ source_id: 'readwise.library', corpus_id: 'internal.readwise.library', tasks: [] }],
      },
    });
    const result = await runDoctor(doctorDeps({ config, delphi: healthyDelphi(), fetchImpl }));

    const scheduler = checkByName(result.checks, 'source_scheduler_status');
    expect(scheduler.ok).toBe(false);
    for (const sourceId of ['google_drive.docs', 'gmail.email', 'dropbox.files']) {
      expect(scheduler.detail).toContain(`selected scheduler source ${sourceId} is not registered`);
      expect(scheduler.detail).toContain(`selected scheduler source ${sourceId} is not active`);
    }
    // The one lane that did construct is never implicated.
    expect(scheduler.detail).not.toContain('readwise.library is not');
  });

  test('uses the configured X-only scheduler selection and fails selected-but-missing X without demanding Gmail or Drive', async () => {
    const config = enabledEmailConfig();
    config.worker.scheduler.enabled = true;
    config.worker.scheduler.sourceIds = ['x.bookmarks'];
    const { fetchImpl } = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': {
        kind: 'source_index_status',
        corpora: [{ corpus_id: 'internal.x.bookmarks' }],
      },
      '/v1/source/scheduler/status': {
        kind: 'source_scheduler_status',
        enabled: true,
        running: true,
        generated_at: '2026-07-18T12:00:00.000Z',
        selected_source_ids: ['x.bookmarks'],
        missing_selected_source_ids: ['x.bookmarks'],
        sources: [],
      },
    });
    const result = await runDoctor(doctorDeps({
      config,
      delphi: healthyDelphi(),
      fetchImpl,
      handleRegistry: {
        version: 1,
        handles: [connectedHandle('gmail'), connectedHandle('google_drive')],
      },
    }));
    const scheduler = checkByName(result.checks, 'source_scheduler_status');
    expect(scheduler.ok).toBe(false);
    expect(scheduler.detail).toContain('selected scheduler source x.bookmarks is not active');
    expect(scheduler.detail).not.toContain('gmail.personal connected');
    expect(scheduler.detail).not.toContain('google_drive.personal connected');
  });

  test('source_ingestion_health reports stuck-work warning and error thresholds', async () => {
    const warningStatus = statusWithIngestionLedger({
      now: new Date('2026-07-09T12:00:00.000Z'),
      queued: 2,
      oldestHours: 25,
    });
    const warningFetch = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': warningStatus,
      '/v1/source/scheduler/status': schedulerStatus({ enabled: true, running: true }),
    }).fetchImpl;

    const warning = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl: warningFetch,
      now: () => new Date('2026-07-09T12:00:00.000Z'),
      handleRegistry: { version: 1, handles: [connectedHandle('dropbox')] },
    }));

    const warningCheck = checkByName(warning.checks, 'source_ingestion_health');
    expect(warningCheck.ok).toBe(true);
    expect(warningCheck.detail).toContain('WARNING');
    expect(warningCheck.detail).toContain('oldest 25h');

    const errorStatus = statusWithIngestionLedger({
      now: new Date('2026-07-09T12:00:00.000Z'),
      queued: 2,
      oldestHours: 73,
    });
    const errorFetch = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': errorStatus,
      '/v1/source/scheduler/status': schedulerStatus({ enabled: true, running: true }),
    }).fetchImpl;

    const error = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl: errorFetch,
      now: () => new Date('2026-07-09T12:00:00.000Z'),
      handleRegistry: { version: 1, handles: [connectedHandle('dropbox')] },
    }));

    const errorCheck = checkByName(error.checks, 'source_ingestion_health');
    expect(errorCheck.ok).toBe(false);
    expect(errorCheck.detail).toContain('ERROR');
    expect(errorCheck.detail).toContain('oldest 73h');
  });

  test('source_ingestion_health flags disabled drain only when queued work exists', async () => {
    const config = enabledEmailConfig();
    config.worker.scheduler.enabled = true;
    const queuedFetch = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': statusWithIngestionLedger({
        now: new Date('2026-07-09T12:00:00.000Z'),
        queued: 1,
        oldestHours: 1,
      }),
      '/v1/source/scheduler/status': schedulerStatus({ enabled: false, running: false }),
    }).fetchImpl;

    const queued = await runDoctor(doctorDeps({
      config,
      delphi: healthyDelphi(),
      fetchImpl: queuedFetch,
      now: () => new Date('2026-07-09T12:00:00.000Z'),
      handleRegistry: { version: 1, handles: [connectedHandle('dropbox')] },
    }));

    const queuedCheck = checkByName(queued.checks, 'source_ingestion_health');
    expect(queuedCheck.ok).toBe(false);
    expect(queuedCheck.detail).toContain('work is queued but the source scheduler reports disabled');

    const freshFetch = fakeWorkerFetch({
      '/v1/health': { status: 'ok', configured: true },
      '/v1/source/index/status': statusWithIngestionLedger({
        now: new Date('2026-07-09T12:00:00.000Z'),
        queued: 0,
        oldestHours: 0,
      }),
      '/v1/source/scheduler/status': schedulerStatus({ enabled: false, running: false }),
    }).fetchImpl;

    const fresh = await runDoctor(doctorDeps({
      config: enabledEmailConfig(),
      delphi: healthyDelphi(),
      fetchImpl: freshFetch,
      now: () => new Date('2026-07-09T12:00:00.000Z'),
      handleRegistry: { version: 1, handles: [connectedHandle('dropbox')] },
    }));

    const freshCheck = checkByName(fresh.checks, 'source_ingestion_health');
    expect(freshCheck.ok).toBe(true);
    expect(freshCheck.detail).toContain('healthy');
    expect(freshCheck.detail).not.toContain('work is queued');
  });

  test('source_ingestion_health persists trend deltas across two doctor runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-doctor-ingestion-trend-'));
    const statePath = join(dir, 'state.json');
    try {
      const firstFetch = fakeWorkerFetch({
        '/v1/health': { status: 'ok', configured: true },
        '/v1/source/index/status': statusWithIngestionLedger({
          now: new Date('2026-07-09T12:00:00.000Z'),
          terminal: 1,
          oldestHours: 1,
        }),
        '/v1/source/scheduler/status': schedulerStatus({ enabled: true, running: true }),
      }).fetchImpl;
      await runDoctor(doctorDeps({
        config: enabledEmailConfig(),
        delphi: healthyDelphi(),
        fetchImpl: firstFetch,
        now: () => new Date('2026-07-09T12:00:00.000Z'),
        ingestionHealthStatePath: statePath,
        handleRegistry: { version: 1, handles: [connectedHandle('dropbox')] },
      }));

      const secondFetch = fakeWorkerFetch({
        '/v1/health': { status: 'ok', configured: true },
        '/v1/source/index/status': statusWithIngestionLedger({
          now: new Date('2026-07-09T13:00:00.000Z'),
          queued: 3,
          terminal: 20,
          oldestHours: 1,
        }),
        '/v1/source/scheduler/status': schedulerStatus({ enabled: true, running: true }),
      }).fetchImpl;
      const second = await runDoctor(doctorDeps({
        config: enabledEmailConfig(),
        delphi: healthyDelphi(),
        fetchImpl: secondFetch,
        now: () => new Date('2026-07-09T13:00:00.000Z'),
        ingestionHealthStatePath: statePath,
        handleRegistry: { version: 1, handles: [connectedHandle('dropbox')] },
      }));

      const check = checkByName(second.checks, 'source_ingestion_health');
      expect(check.ok).toBe(false);
      expect(check.detail).toContain('queued/retryable work is growing across doctor runs (0 -> 3)');
      expect(check.detail).toContain('failed_terminal local_ocr_tesseract:unknown grew by 19');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function schedulerStatus(input: { enabled: boolean; running: boolean }) {
  return {
    kind: 'source_scheduler_status',
    enabled: input.enabled,
    running: input.running,
    generated_at: '2026-07-09T12:00:00.000Z',
    sources: [{
      source_id: 'dropbox.files',
      corpus_id: 'secure_local.dropbox.files',
      sync_cadence: 'continuous',
      sync_interval_seconds: 600,
      freshness_threshold_hours: 24,
      stale_sync_anomaly: false,
      tasks: [],
    }],
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      source_scope_keys_exposed: false,
      counts_only: true,
    },
  };
}

async function runDoctorWithDropboxThroughput(input: {
  now: Date;
  actionableQueued: number;
  actionableRetryableDue?: number;
  rawQueued?: number;
  oldestActionableHours?: number;
  terminalProgressHours?: number;
  env?: Record<string, string | undefined>;
}) {
  const signal: ContentExtractionThroughputSignal = {
    actionable_queued: input.actionableQueued,
    actionable_retryable_due: input.actionableRetryableDue ?? 0,
    ...(input.oldestActionableHours !== undefined
      ? { oldest_actionable_at: new Date(input.now.getTime() - input.oldestActionableHours * HOUR_MS).toISOString() }
      : {}),
    ...(input.terminalProgressHours !== undefined
      ? { newest_terminal_progress_at: new Date(input.now.getTime() - input.terminalProgressHours * HOUR_MS).toISOString() }
      : {}),
  };
  const corpus = dropboxCorpusReport({
    counts: {
      files: 200,
      extraction_jobs_queued: input.rawQueued ?? input.actionableQueued,
      extraction_jobs_queued_actionable: input.actionableQueued,
      extraction_jobs_failed: 0,
      extraction_jobs_failed_actionable: 0,
    },
    content_extraction_throughput: signal,
  }) as unknown as SourceIndexStatusResult['corpora'][number];
  const status: SourceIndexStatusResult = {
    kind: 'source_index_status',
    generated_at: input.now.toISOString(),
    corpora: [corpus],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
  const statusWithLedger: SourceIndexStatusResult = {
    ...status,
    ingestion_ledger: buildSourceIngestionLedgerSnapshot(status, {
      now: input.now,
      safeForCastor: true,
      ...((input.rawQueued ?? input.actionableQueued) > 0
        ? {
          dropboxFailureBreakdown: [{
            status: 'queued',
            extractor_kind: 'local_text_pdf',
            count: input.rawQueued ?? input.actionableQueued,
            oldest_created_at: new Date(
              input.now.getTime() - (input.oldestActionableHours ?? 0) * HOUR_MS,
            ).toISOString(),
            newest_updated_at: input.now.toISOString(),
          }],
        }
        : {}),
    }),
  };
  const { fetchImpl } = fakeWorkerFetch({
    '/v1/health': { status: 'ok', configured: true },
    '/v1/source/index/status': statusWithLedger,
  });
  return runDoctor(doctorDeps({
    config: enabledEmailConfig(),
    delphi: healthyDelphi(),
    fetchImpl,
    now: () => input.now,
    env: input.env ?? {},
    handleRegistry: { version: 1, handles: [connectedHandle('dropbox')] },
  }));
}

function statusWithIngestionLedger(input: {
  now: Date;
  queued?: number;
  terminal?: number;
  oldestHours: number;
}): SourceIndexStatusResult {
  const queued = input.queued ?? 0;
  const terminal = input.terminal ?? 0;
  const oldest = new Date(input.now.getTime() - input.oldestHours * HOUR_MS).toISOString();
  const status: SourceIndexStatusResult = {
    kind: 'source_index_status',
    generated_at: input.now.toISOString(),
    corpora: [dropboxCorpusReport({
      counts: {
        indexed_items: 10,
        chunks: 5,
        extraction_jobs_queued: queued,
        extraction_jobs_failed: terminal,
      },
    }) as unknown as SourceIndexStatusResult['corpora'][number]],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
  return {
    ...status,
    ingestion_ledger: buildSourceIngestionLedgerSnapshot(status, {
      now: input.now,
      safeForCastor: true,
      dropboxFailureBreakdown: [
        ...(queued > 0
          ? [{
            status: 'queued',
            extractor_kind: 'local_text_pdf',
            count: queued,
            oldest_created_at: oldest,
            newest_updated_at: input.now.toISOString(),
          }]
          : []),
        ...(terminal > 0
          ? [{
            status: 'failed_terminal',
            extractor_kind: 'local_ocr_tesseract',
            count: terminal,
            oldest_created_at: oldest,
            newest_updated_at: input.now.toISOString(),
          }]
          : []),
      ],
    }),
  };
}

function memorySecretStore(secrets: Record<string, string | undefined>) {
  return {
    getSync: (key: string) => secrets[key],
    get: async (key: string) => secrets[key],
  };
}

async function makeDetachedOAuthStateFixture(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'olympus-doctor-oauth-state-'));
  const stateDir = join(root, 'pending-oauth');
  mkdirSync(stateDir, { recursive: true });
  await Bun.write(join(stateDir, 'gmail.personal.json'), JSON.stringify({
    source: 'gmail',
    accountRole: 'personal',
    status: 'pending',
    authorizationUrl: 'https://example.test/oauth',
    port: 49152,
    pid: 999999,
    startedAt: '2026-07-07T12:00:00.000Z',
    expiresAt: '2026-07-07T12:10:00.000Z',
    logPath: join(root, 'oauth.log'),
  }));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  return stateDir;
}

// Owner report, 2026-09-24 (live Readwise, forty minutes after a worker
// upgrade): home put Readwise under NEEDS YOU with "needs attention before
// answers" and the background card said "1 source failing", while the Readwise
// page body read Working on every bar with no banner. The page also printed
// "Embedded 959 highlights" beside an Embedding row saying the source has no
// embedding stage, and counted Readwise items as "files".
//
// Every card here is built by the worker's own view model from scheduler and
// index status in the live shape (counts only), so `failing_tasks` and the
// readiness ladder come from real scheduler state rather than being set by hand.
import { describe, expect, test } from 'bun:test';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { dashboardAttentionBanner } from '../src/workers/dashboard/attention.ts';
import { dashboardBackgroundLanes, renderDashboardBackgroundBody } from '../src/workers/dashboard/pages/background.ts';
import { renderDashboardDetailBody } from '../src/workers/dashboard/pages/detail.ts';
import { dashboardStatus, dashboardSubLine } from '../src/workers/dashboard/vocabulary.ts';
import {
  buildSourceDashboardViewModel,
  type DashboardSourceCard,
  type SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';
import type { SourceSchedulerStatus } from '../src/workers/source-scheduler.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';

const NOW = new Date('2026-09-24T12:44:55.650Z');
const SETUP = '/dashboard?setup';

interface TaskState {
  failures: number;
  errorKind?: string;
  degradedReason?: string;
}

function readwiseView(pull: TaskState, options: { embeddingRequired?: boolean } = {}): SourceDashboardViewModel {
  const required = options.embeddingRequired === true;
  const corpus = (
    corpusId: string,
    trustDomain: 'internal' | 'secure_local',
    counts: { items: number; text: number; chunks: number; embedded: number; itemsEmbedded: number },
  ) => ({
    corpus_id: corpusId,
    family: 'readwise',
    trust_domain: trustDomain,
    activation_mode: required ? 'hybrid_primary' : 'lexical_only',
    embedding_policy: 'cloud_allowed',
    configured: true,
    provider: 'readwise',
    read_authority: 'connector_store',
    counts: {
      indexed_items: counts.items,
      items_with_text: counts.text,
      chunks: counts.chunks,
      embedded_chunks: counts.embedded,
      items_embedded: counts.itemsEmbedded,
      sync_runs: 3,
    },
    embedding_parity: {
      required,
      chunks: counts.chunks,
      embedded_chunks: counts.embedded,
      missing_chunks: counts.chunks - counts.embedded,
      refresh_needed: required && counts.embedded < counts.chunks,
      ...(required
        ? {
            backlog_estimate: {
              model_id: 'fixture-model',
              missing_chunks: counts.chunks - counts.embedded,
              estimated_tokens: (counts.chunks - counts.embedded) * 500,
              estimated_cost_usd: counts.chunks === counts.embedded ? 0 : 0.03,
              price_source: 'default_unverified',
            },
          }
        : {}),
    },
    last_refresh: {
      sync_run_id: `run-${trustDomain}`,
      status: 'completed',
      started_at: '2026-09-24T12:38:53.243Z',
      completed_at: '2026-09-24T12:38:57.214Z',
      items_seen: 2093,
      items_indexed: counts.items,
      source_scope: 'readwise_live',
    },
    item_metadata_returned: false,
  });
  const status = {
    kind: 'source_index_status',
    generated_at: NOW.toISOString(),
    corpora: [
      corpus('internal.readwise.library', 'internal', { items: 2040, text: 900, chunks: 1527, embedded: 1527, itemsEmbedded: 900 }),
      corpus('secure_local.readwise.library', 'secure_local', { items: 751, text: 751, chunks: 5704, embedded: 1664, itemsEmbedded: 107 }),
    ],
  } as unknown as SourceIndexStatusResult;
  const scheduler: SourceSchedulerStatus = {
    kind: 'source_scheduler_status',
    enabled: true,
    running: true,
    generated_at: NOW.toISOString(),
    selected_source_ids: ['readwise.library'],
    missing_selected_source_ids: [],
    sources: [{
      source_id: 'readwise.library',
      corpus_id: 'internal.readwise.library',
      sync_cadence: 'continuous',
      sync_interval_seconds: 1800,
      freshness_threshold_hours: 26,
      freshness_hours: 0.1,
      stale_sync_anomaly: false,
      tasks: [
        {
          id: 'readwise.library_store_pull',
          kind: 'sync',
          interval_seconds: 900,
          effective_interval_seconds: 900,
          freshness_threshold_seconds: 3600,
          stale_anomaly: false,
          next_run_at: '2026-09-24T12:38:20.807Z',
          running: false,
          consecutive_failures: pull.failures,
          last_attempt_at: '2026-09-24T12:35:28.018Z',
          ...(pull.failures > 0 ? { last_error_kind: pull.errorKind ?? 'task_failed' } : {}),
          ...(pull.degradedReason ? { degraded_reason: pull.degradedReason } : {}),
        },
        {
          id: 'readwise.library_store_reconcile',
          kind: 'sync',
          interval_seconds: 86400,
          effective_interval_seconds: 86400,
          freshness_threshold_seconds: 93600,
          stale_anomaly: false,
          next_run_at: '2026-09-24T12:35:28.014Z',
          running: true,
          consecutive_failures: 0,
          last_attempt_at: '2026-09-24T12:37:20.809Z',
        },
      ],
    }],
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      source_scope_keys_exposed: false,
      counts_only: true,
    },
  } as unknown as SourceSchedulerStatus;
  return buildSourceDashboardViewModel({
    sourceIndexStatus: status,
    schedulerStatus: scheduler,
    sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
      OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
      OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
    })),
    connectedHandleRegistry: {
      version: 1,
      handles: [{
        handle: 'readwise.personal',
        provider: 'readwise',
        accountRole: 'personal',
        trustDomain: 'internal',
        allowedCapabilities: ['readwise.sync'],
        scopes: ['readwise.export:read', 'readwise.reader:read'],
        connectedAt: '2026-09-24T12:35:28.005Z',
      }],
    },
    now: NOW,
  });
}

function readwiseCard(view: SourceDashboardViewModel): DashboardSourceCard {
  const card = view.sources.find((source) => source.source_id === 'readwise.library');
  if (!card) throw new Error('fixture view has no Readwise card');
  return card;
}

function syncsFacts(view: SourceDashboardViewModel): string {
  return dashboardBackgroundLanes(view, { now: NOW }).find((lane) => lane.name === 'Syncs')?.facts ?? '';
}

describe('Readwise attention reads one way on home, the header and the page', () => {
  test('one booked retry: not Needs you, no banner, and the background lane says retrying', () => {
    const view = readwiseView({ failures: 1 });
    const card = readwiseCard(view);

    expect(card.queue_health.retrying_tasks).toBe(1);
    expect(card.queue_health.failing_tasks).toBeUndefined();
    expect(card.answer_readiness.state).not.toBe('needs_attention');
    expect(dashboardStatus({ source: card })).not.toBe('Needs you');
    expect(dashboardSubLine(card)).not.toContain('needs attention');
    expect(dashboardAttentionBanner(card, { now: NOW, setupPath: SETUP })).toBeUndefined();
    const facts = syncsFacts(view);
    expect(facts).toContain('1 source retrying');
    expect(facts).not.toContain('failing');
  });

  test('two failures in a row are still a retry, not failing', () => {
    const card = readwiseCard(readwiseView({ failures: 2 }));

    expect(card.queue_health.failing_tasks).toBeUndefined();
    expect(dashboardStatus({ source: card })).not.toBe('Needs you');
    expect(dashboardAttentionBanner(card, { now: NOW, setupPath: SETUP })).toBeUndefined();
  });

  test('three failures in a row: Needs you everywhere, with a banner that says why', () => {
    const view = readwiseView({ failures: 3 });
    const card = readwiseCard(view);

    expect(card.queue_health.failing_tasks).toBe(1);
    expect(card.answer_readiness.state).toBe('needs_attention');
    expect(dashboardStatus({ source: card })).toBe('Needs you');
    const banner = dashboardAttentionBanner(card, { now: NOW, setupPath: SETUP });
    expect(banner?.kind).toBe('sync_failing');
    expect(banner?.sentence).toContain("Readwise's scheduled sync keeps failing");
    expect(banner?.sentence).toContain('task_failed');
    expect(banner?.action).toMatchObject({ kind: 'sync_now', label: 'Sync now' });
    expect(renderDashboardDetailBody(card, { now: NOW })).toContain('class="attncard banner"');
    expect(syncsFacts(view)).toContain('1 source failing');
  });

  test('a credential failure is failing on its first attempt', () => {
    const card = readwiseCard(readwiseView({ failures: 1, errorKind: 'credential_reauth_required' }));

    expect(card.queue_health.failing_tasks).toBe(1);
    expect(dashboardStatus({ source: card })).toBe('Needs you');
    expect(dashboardAttentionBanner(card, { now: NOW, setupPath: SETUP })).toBeDefined();
  });

  test('credential contention is not failing at 1; it follows the three-strike rule', () => {
    const busy = readwiseCard(readwiseView({ failures: 1, errorKind: 'credential_refresh_busy' }));
    expect(busy.queue_health.failing_tasks).toBeUndefined();
    expect(dashboardStatus({ source: busy })).not.toBe('Needs you');
    expect(dashboardAttentionBanner(busy, { now: NOW, setupPath: SETUP })).toBeUndefined();

    const latched = readwiseCard(readwiseView({ failures: 3, errorKind: 'credential_session_latched' }));
    expect(latched.queue_health.failing_tasks).toBe(1);
    expect(dashboardStatus({ source: latched })).toBe('Needs you');
  });

  test('the background page marks a sync that keeps failing as needs-you, booked retry or not', () => {
    const failing = readwiseView({ failures: 3 });
    const failingCheck = dashboardBackgroundLanes(failing, { now: NOW })
      .find((lane) => lane.name === 'Syncs')?.checks.find((check) => check.name === 'CONSECUTIVE_FAILURES');
    expect(failingCheck?.disposition).toBe('needs_you');
    const html = renderDashboardBackgroundBody(failing, NOW);
    expect(html).toContain('Readwise&#39;s scheduled sync keeps failing (task_failed)');

    const retrying = readwiseView({ failures: 1 });
    const retryCheck = dashboardBackgroundLanes(retrying, { now: NOW })
      .find((lane) => lane.name === 'Syncs')?.checks.find((check) => check.name === 'CONSECUTIVE_FAILURES');
    expect(retryCheck?.disposition).toBe('self_healing');
    expect(renderDashboardBackgroundBody(retrying, NOW)).not.toContain('keeps failing');
  });

  test('an operator pause silences the failing banner exactly as it silences the ladder', () => {
    const card = readwiseCard(readwiseView({ failures: 3, degradedReason: 'readwise_daily_api_request_guard' }));

    expect(card.answer_readiness.state).not.toBe('needs_attention');
    expect(dashboardAttentionBanner(card, { now: NOW, setupPath: SETUP })).toBeUndefined();
  });

  test('a read-only reader is sent to the gate rather than handed a Sync now button', () => {
    const card = readwiseCard(readwiseView({ failures: 3 }));
    const banner = dashboardAttentionBanner(card, { now: NOW, setupPath: SETUP, readOnly: true });

    expect(banner?.action).toMatchObject({ kind: 'link', label: 'Sync now', hint: 'unlock controls in Setup' });
  });
});

describe('the Readwise page states one embedding fact and counts in its own noun', () => {
  test('a keyword-only source prints no embedded count beside its not-needed Embedding row', () => {
    const view = readwiseView({ failures: 0 });
    const card = readwiseCard(view);
    const html = renderDashboardDetailBody(card, { now: NOW });

    expect(card.embedding_required).toBe(false);
    expect(card.embedding_backlog).toBeUndefined();
    expect(view.background_work?.embedding_backlog).toBeUndefined();
    expect(html).toContain('no embedding stage for this source');
    expect(html).toContain('<span>Embedded</span><b>not needed · keyword search</b>');
  });

  test('a source that is served from embeddings still prints its embedded count and backlog', () => {
    const card = readwiseCard(readwiseView({ failures: 0 }, { embeddingRequired: true }));
    const html = renderDashboardDetailBody(card, { now: NOW });

    expect(card.embedding_required).toBe(true);
    expect(card.embedding_backlog?.missing_chunks).toBe(4040);
    expect(html).toMatch(/<span>Embedded<\/span><b>[0-9,]+ items<\/b>/);
    // The hybrid backlog is counted and priced on the page, as an estimate.
    expect(card.embedding_backlog?.estimate).toEqual({
      estimated_tokens: 2_020_000,
      estimated_cost_usd: 0.03,
      price_source: 'default_unverified',
    });
    expect(html).toContain('4,040 chunks are waiting to be embedded (about 2.0M tokens, ~$0.03 estimated at unverified list price)');
  });

  test('Readwise counts in items — it holds documents and highlights — never files', () => {
    const html = renderDashboardDetailBody(readwiseCard(readwiseView({ failures: 0 })), { now: NOW });

    expect(html).toContain('<span>Indexed</span><b>2,791 items</b>');
    expect(html).not.toContain('highlights</b>');
    expect(html).not.toMatch(/[0-9] files/);
  });

  test('the selection counts use the source noun, and a file source keeps counting files', () => {
    const card = readwiseCard(readwiseView({ failures: 0 }));
    const withSelection: DashboardSourceCard = {
      ...card,
      ingestion_selection: { metadata_only_files: 0, full_ingestion_files: 2791 },
    };
    const html = renderDashboardDetailBody(withSelection, { now: NOW });
    expect(html).toContain('<span>Metadata only</span><b>0 items</b>');
    expect(html).toContain('<span>Full ingestion</span><b>2,791 items</b>');

    const fileCard: DashboardSourceCard = {
      ...card,
      family: 'file',
      ingestion_selection: { metadata_only_files: 1, full_ingestion_files: 2, policy_deferred_files: 1 },
    };
    const fileHtml = renderDashboardDetailBody(fileCard, { now: NOW });
    expect(fileHtml).toContain('<span>Metadata only</span><b>1 file</b>');
    expect(fileHtml).toContain('<span>Full ingestion</span><b>2 files</b>');
    expect(fileHtml).toContain('1 file selected for full ingestion is not being processed');
  });
});

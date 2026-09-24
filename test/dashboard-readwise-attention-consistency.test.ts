// Owner report, 2026-09-24 (live Readwise, forty minutes after a worker
// upgrade): home put Readwise under NEEDS YOU with "needs attention before
// answers" and the background card said "1 source failing", while the Readwise
// page body read Working on every bar with no banner. The page also printed
// "Embedded 959 highlights" beside an Embedding row saying the source has no
// embedding stage, and counted Readwise items as "files".
//
// The card below is the live card's shape at that moment, counts only: one
// sync task had failed once and had its retry booked.
import { describe, expect, test } from 'bun:test';
import { dashboardAttentionBanner } from '../src/workers/dashboard/attention.ts';
import { dashboardBackgroundLanes } from '../src/workers/dashboard/pages/background.ts';
import { renderDashboardDetailBody } from '../src/workers/dashboard/pages/detail.ts';
import { dashboardStatus, dashboardSubLine } from '../src/workers/dashboard/vocabulary.ts';
import type { DashboardSourceCard, SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';

const NOW = new Date('2026-09-24T12:44:55.650Z');

function readwiseCard(failures: { retrying: number; failing?: number; lastErrorKind?: string }): DashboardSourceCard {
  const failing = failures.failing ?? 0;
  const keepsFailing = failing > 0;
  return {
    corpus_id: 'internal.readwise.library',
    source_id: 'readwise.library',
    label: 'Readwise',
    provider: 'readwise',
    family: 'readwise',
    trust_domain: 'internal',
    configured: true,
    freshness: { label: 'Last checked less than 1 hour ago', hours: 0.1, threshold_hours: 26, stale: false },
    coverage: {
      indexed_items: 2791,
      content_ready_items: 1651,
      embedded_items: 2839,
      embedded_files: 963,
      needs_review_items: 0,
      not_read_by_policy_items: 0,
    },
    ingestion_selection: { metadata_only_files: 0, full_ingestion_files: 2791 },
    needs_review: { total: 0, automatic_total: 0, operator_total: 0, reasons: [] },
    ingestion_health: {
      coverage_percent: 59.2,
      stuck_count: 0,
      last_drain_activity_hours: 0.1,
      drain_state: 'enabled',
      drain_unit: 'olympus-source-scheduler',
      label: '59.2% covered; no stuck work; last drain 0.1h ago',
    },
    tier_composition: [
      { trust_domain: 'internal', label: 'Personal', indexed_items: 2040, content_ready_items: 900 },
      { trust_domain: 'secure_local', label: 'Private', indexed_items: 751, content_ready_items: 751 },
    ],
    queue_health: {
      label: keepsFailing ? 'Needs attention' : 'Working now',
      waiting: 0,
      active: 1,
      needs_attention: 0,
      ...(failures.retrying > 0 ? { retrying_tasks: failures.retrying } : {}),
      ...(keepsFailing ? { failing_tasks: failing } : {}),
    },
    answer_readiness: keepsFailing
      ? { state: 'needs_attention', label: 'Needs attention before answers' }
      : { state: 'ready', label: 'Ready for questions' },
    connection: {
      state: 'syncing',
      label: 'syncing',
      action: { kind: 'none' },
      handles: ['readwise.personal'],
      connected_at: '2026-09-24T12:35:28.005Z',
    },
    last_run: {
      status: 'completed',
      started_at: '2026-09-24T12:38:53.243Z',
      completed_at: '2026-09-24T12:38:57.214Z',
      duration_seconds: 4,
      items_seen: 2093,
      items_indexed: 751,
      traversal_complete: false,
    },
    last_sync_at: '2026-09-24T12:38:57.214Z',
    schedule: {
      running: true,
      consecutive_failures: Math.max(failures.retrying, failing * 3),
      last_attempt_at: '2026-09-24T12:37:20.809Z',
      next_run_at: '2026-09-24T12:38:20.807Z',
      ...(failures.retrying > 0 ? { last_error_kind: failures.lastErrorKind ?? 'task_failed' } : {}),
    },
    embedding_required: false,
    content_arrives_extracted: true,
    sync_now_available: true,
    movement: {
      first_seen_at: '2026-09-24T11:37:20.381Z',
      metadata_sync_at: '2026-09-24T12:42:51.625Z',
      extraction_at: '2026-09-24T12:42:51.625Z',
      embedding_at: '2026-09-24T12:44:55.650Z',
    },
  } as DashboardSourceCard;
}

function viewOf(card: DashboardSourceCard): SourceDashboardViewModel {
  return {
    kind: 'source_dashboard',
    generated_at: NOW.toISOString(),
    sources: [card],
    background_work: {},
  } as unknown as SourceDashboardViewModel;
}

function syncsFacts(card: DashboardSourceCard): string {
  return dashboardBackgroundLanes(viewOf(card), { now: NOW }).find((lane) => lane.name === 'Syncs')?.facts ?? '';
}

describe('Readwise attention reads one way on home, the header and the page', () => {
  test('one booked retry: Working everywhere, no banner, and the background lane says retrying', () => {
    const card = readwiseCard({ retrying: 1 });

    expect(dashboardStatus({ source: card })).toBe('Working');
    expect(dashboardSubLine(card)).not.toContain('needs attention');
    expect(dashboardAttentionBanner(card, { now: NOW, setupPath: '/dashboard?setup' })).toBeUndefined();
    const facts = syncsFacts(card);
    expect(facts).toContain('1 source retrying');
    expect(facts).not.toContain('failing');
  });

  test('a sync that keeps failing: Needs you on home and a banner on the page that says why', () => {
    const card = readwiseCard({ retrying: 1, failing: 1 });

    expect(dashboardStatus({ source: card })).toBe('Needs you');
    const banner = dashboardAttentionBanner(card, { now: NOW, setupPath: '/dashboard?setup' });
    expect(banner?.kind).toBe('sync_failing');
    expect(banner?.sentence).toContain("Readwise's scheduled sync keeps failing");
    expect(banner?.sentence).toContain('task_failed');
    expect(banner?.action).toMatchObject({ kind: 'sync_now', label: 'Sync now' });
    expect(banner?.agent_prompt).toContain('Readwise');
    const html = renderDashboardDetailBody(card, { now: NOW });
    expect(html).toContain('class="attncard banner"');
    expect(syncsFacts(card)).toContain('1 source failing');
  });

  test('an operator pause silences the failing banner exactly as it silences the ladder', () => {
    const card = readwiseCard({ retrying: 1, failing: 1 });
    card.schedule = { ...card.schedule!, degraded_reason: 'readwise_daily_api_request_guard' };

    expect(dashboardAttentionBanner(card, { now: NOW, setupPath: '/dashboard?setup' })).toBeUndefined();
  });

  test('a read-only reader is sent to the gate rather than handed a Sync now button', () => {
    const card = readwiseCard({ retrying: 1, failing: 1 });
    const banner = dashboardAttentionBanner(card, { now: NOW, setupPath: '/dashboard?setup', readOnly: true });

    expect(banner?.action).toMatchObject({ kind: 'link', label: 'Sync now', hint: 'unlock controls in Setup' });
  });
});

describe('the Readwise page states one embedding fact and counts in its own noun', () => {
  test('a keyword-only source prints no embedded count beside its not-needed Embedding row', () => {
    const html = renderDashboardDetailBody(readwiseCard({ retrying: 0 }), { now: NOW });

    expect(html).toContain('no embedding stage for this source');
    expect(html).toContain('<span>Embedded</span><b>not needed · keyword search</b>');
    expect(html).not.toMatch(/Embedded<\/span><b>[0-9,]+ highlights/);
  });

  test('a source that is served from embeddings still prints its embedded count', () => {
    const card = readwiseCard({ retrying: 0 });
    card.embedding_required = true;
    const html = renderDashboardDetailBody(card, { now: NOW });

    expect(html).toContain('<span>Embedded</span><b>963 highlights</b>');
  });

  test('the selection counts use the source noun, never files, for Readwise', () => {
    const html = renderDashboardDetailBody(readwiseCard({ retrying: 0 }), { now: NOW });

    expect(html).toContain('<span>Metadata only</span><b>0 highlights</b>');
    expect(html).toContain('<span>Full ingestion</span><b>2,791 highlights</b>');
    expect(html).not.toContain('2,791 files');
  });

  test('a file source keeps counting files, singular included', () => {
    const card = readwiseCard({ retrying: 0 });
    card.family = 'file';
    card.ingestion_selection = { metadata_only_files: 1, full_ingestion_files: 2, policy_deferred_files: 1 };
    const html = renderDashboardDetailBody(card, { now: NOW });

    expect(html).toContain('<span>Metadata only</span><b>1 file</b>');
    expect(html).toContain('<span>Full ingestion</span><b>2 files</b>');
    expect(html).toContain('1 file selected for full ingestion is not being processed');
  });
});

/**
 * Owner ruling, 2026-10-08: a damaged file is a fact the row states, not a
 * pause; reading finishes when every in-scope file is read or can't be read;
 * and Sync now says what it found, on both dashboards.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import {
  DASHBOARD_MANUAL_SYNC_SHOWN_MS,
  buildSourceDashboardViewModel,
  dashboardLiveManualSync,
  dashboardManualSyncOutcome,
  type DashboardManualSync,
  type DashboardSourceCard,
  type SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import type { SourceSchedulerStatus, SourceSchedulerTaskStatus } from '../src/workers/source-scheduler.ts';
import type { ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import {
  dashboardAttentionLine,
  dashboardManualSyncLine,
  dashboardManualSyncPendingLine,
  dashboardSubLine,
  dashboardWorkingHeadline,
  dashboardWorkingSummary,
} from '../src/workers/dashboard/vocabulary.ts';
import { dashboardSourceProgress } from '../src/workers/dashboard/phases.ts';
import { renderDashboardDetailBody } from '../src/workers/dashboard/pages/detail.ts';
import { dashboardSyncNowAction } from '../src/workers/dashboard/attention.ts';
import { actionButton } from '../src/workers/dashboard/components.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';

const NOW = new Date('2026-10-08T12:00:00.000Z');

describe('unreadable files are stated, not alarmed', () => {
  test('a healthy Dropbox with two damaged files reads its normal line plus the count', () => {
    const view = realView({ extraction_items_unreadable: 2 });
    const dropbox = view.sources.find((source) => source.source_id === 'dropbox.files')!;
    expect(dropbox.coverage.unreadable_items).toBe(2);
    expect(dropbox.queue_health.needs_attention).toBe(0);
    expect(dropbox.answer_readiness.state).not.toBe('needs_attention');
    expect(dashboardSubLine(dropbox, { now: NOW })).not.toContain('paused');
    expect(dashboardSubLine(dropbox, { now: NOW })).toContain("2 files can't be read");
  });

  test('a corpus that publishes no unreadable count publishes no key', () => {
    const dropbox = realView({}).sources.find((source) => source.source_id === 'dropbox.files')!;
    expect('unreadable_items' in dropbox.coverage).toBe(false);
  });

  test('more than five percent unreadable re-alarms, naming the cause', () => {
    const view = realView({ extraction_items_unreadable: 20 });
    const dropbox = view.sources.find((source) => source.source_id === 'dropbox.files')!;
    expect(dropbox.answer_readiness).toEqual({ state: 'needs_attention', label: 'Many files cannot be read' });
    expect(dashboardAttentionLine(dropbox)).toBe("many files can't be read");
  });

  test('a fresh row adds the clause, singular and plural, in the source noun', () => {
    expect(dashboardSubLine(card({ coverage: { ...card().coverage, unreadable_items: 1 } }), { now: NOW }))
      .toBe("synced 40m ago · 1 file can't be read");
    expect(dashboardSubLine(card({ coverage: { ...card().coverage, unreadable_items: 2 } }), { now: NOW }))
      .toBe("synced 40m ago · 2 files can't be read");
  });

  test('"paused" is said only of a lane Olympus parked', () => {
    const stalled = card({ answer_readiness: { state: 'needs_attention', label: 'Content extraction is stalled' } });
    expect(dashboardAttentionLine(stalled)).toBe('reading files has stalled');
    const parked = card({
      answer_readiness: { state: 'needs_attention', label: 'Content extraction is stalled' },
      schedule: {
        running: false,
        consecutive_failures: 0,
        degraded_reason: 'daily_api_request_guard',
      } as NonNullable<DashboardSourceCard['schedule']>,
    });
    expect(dashboardAttentionLine(parked)).toBe('paused — reading files has stalled');
  });

  test('the detail page gives the plain reason and names no file', () => {
    const html = renderDashboardDetailBody(finishedWithUnreadable(), { now: NOW });
    expect(html).toContain("2 files can&#39;t be read: extraction failed permanently — the file is damaged or in a format Olympus can&#39;t read.");
  });
});

describe('reading finishes when every in-scope file is read or unreadable', () => {
  test('252 of 254 with 2 unreadable is done, with an honest numerator', () => {
    const source = finishedWithUnreadable();
    const summary = dashboardWorkingSummary(source)!;
    expect(summary).toMatchObject({ in_scope_items: 254, read_items: 252, unreadable_items: 2, fully_working: true });
    expect(dashboardWorkingHeadline(summary))
      .toBe("everything readable is working — 252 of 254 files · 2 can't be read");
    const progress = dashboardSourceProgress(source, { now: NOW });
    const extraction = progress.phases.find((phase) => phase.id === 'extraction')!;
    expect(extraction.measure).toEqual({ kind: 'ratio', done: 252, total: 254, percent: 99.2 });
    expect(extraction.state).toBe('done');
    expect(extraction.state_words).toBe("Done · 252 read · 2 can't be read");
    const embedding = progress.phases.find((phase) => phase.id === 'embedding')!;
    expect(embedding.state).toBe('done');
    expect(progress.settled).toBe(true);
  });

  test('two unreadable files in 27,000 never become a perpetual remainder', () => {
    const source = card({
      coverage: {
        indexed_items: 27_000,
        content_ready_items: 26_998,
        embedded_items: 0,
        embedded_files: 26_998,
        needs_review_items: 0,
        answer_ready_eligible_items: 27_000,
        unreadable_items: 2,
      },
    });
    const extraction = dashboardSourceProgress(source, { now: NOW }).phases.find((phase) => phase.id === 'extraction')!;
    expect(extraction.scope).toBe('corpus');
    expect(extraction.measure.kind).toBe('ratio');
    expect(extraction.state).toBe('done');
  });

  test('a batch above a settled baseline is measured without the unreadable files', () => {
    const source = card({
      coverage: {
        indexed_items: 266,
        content_ready_items: 257,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 266,
        unreadable_items: 2,
      },
      movement: { extraction_settled_value: 252 },
    });
    const extraction = dashboardSourceProgress(source, { now: NOW }).phases.find((phase) => phase.id === 'extraction')!;
    expect(extraction.scope).toBe('delta');
    expect(extraction.measure).toEqual({ kind: 'ratio', done: 5, total: 12, percent: 41.7 });
  });

  test('ChatGPT sees the same finished source, with counts only', () => {
    const v1 = buildChatGptDashboardViewModel(viewOf(finishedWithUnreadable()), { now: NOW });
    const dropbox = v1.sources.find((source) => source.id === 'dropbox.files')!;
    expect(dropbox.progress?.stage).toBe('done');
    expect(dropbox.unreadable).toEqual({ count: 2, reasons: [{ code: 'damaged_or_unsupported', count: 2 }] });
    expect(dropbox.detail).toContain("2 files can't be read");
    expect(dropbox.detail).not.toContain('paused');
  });
});

describe('Sync now says what it found', () => {
  test('the button words its own wait', () => {
    const action = dashboardSyncNowAction(card(), { readOnly: false, setupPath: '/dashboard?setup' })!;
    expect(action.pendingMessage).toBe('Checking Dropbox…');
    expect(dashboardManualSyncPendingLine('Dropbox')).toBe('Checking Dropbox…');
    expect(actionButton(action)).toContain('data-pending-message="Checking Dropbox…"');
  });

  test('the result reads from the run\'s changed-item count, never items seen', () => {
    const before = schedulerStatus([syncTask({ last_attempt_at: '2026-10-08T11:00:00.000Z' })]);
    const none = dashboardManualSyncOutcome({
      result: schedulerStatus([syncTask({ last_result: { status: 'idle', counts: { items_seen: 254, items_changed: 0 } } })]),
      before,
      schedulerSourceId: 'dropbox.files',
      at: NOW,
    });
    expect(none).toEqual({ at: NOW.toISOString(), outcome: 'checked', new_items: 0 });
    expect(dashboardManualSyncLine({ ...card(), last_manual_sync: none }, NOW)).toBe('Checked just now — no new files');

    const twelve = dashboardManualSyncOutcome({
      result: schedulerStatus([syncTask({ last_result: { status: 'progress', counts: { items_seen: 266, items_changed: 12 } } })]),
      before,
      schedulerSourceId: 'dropbox.files',
      at: NOW,
    });
    expect(dashboardManualSyncLine({ ...card(), last_manual_sync: twelve }, NOW))
      .toBe('Checked just now — 12 new files, reading them now');
  });

  test('a press that joined a running sync, or a run that failed, says so plainly', () => {
    const before = schedulerStatus([syncTask({ last_attempt_at: '2026-10-08T11:00:00.000Z' })]);
    const busy = dashboardManualSyncOutcome({
      result: schedulerStatus([syncTask({ last_attempt_at: '2026-10-08T11:00:00.000Z', running: true })]),
      before,
      schedulerSourceId: 'dropbox.files',
      at: NOW,
    });
    expect(busy.outcome).toBe('busy');
    const failed = dashboardManualSyncOutcome({
      result: schedulerStatus([syncTask({ last_result: { status: 'failed' }, last_error_kind: 'provider_http_500' })]),
      before,
      schedulerSourceId: 'dropbox.files',
      at: NOW,
    });
    expect(failed).toEqual({ at: NOW.toISOString(), outcome: 'failed' });
    expect(dashboardManualSyncLine({ ...card(), last_manual_sync: failed }, NOW))
      .toBe("Couldn't check Dropbox just now — Olympus will try again on its own");
  });

  test('the line survives the refresh, then expires', () => {
    const sync: DashboardManualSync = { at: NOW.toISOString(), outcome: 'checked', new_items: 0 };
    const later = new Date(NOW.getTime() + 3 * 60_000);
    const view = realView({}, { manualSyncs: { 'dropbox.files': sync }, now: later });
    const dropbox = view.sources.find((source) => source.source_id === 'dropbox.files')!;
    expect(dropbox.last_manual_sync).toEqual(sync);
    expect(dashboardManualSyncLine(dropbox, later)).toBe('Checked 3m ago — no new files');
    const v1 = buildChatGptDashboardViewModel(view, { now: later });
    expect(v1.sources.find((source) => source.id === 'dropbox.files')?.lastManualSync)
      .toEqual({ at: NOW.toISOString(), outcome: 'checked', newItems: 0 });

    const expired = new Date(NOW.getTime() + DASHBOARD_MANUAL_SYNC_SHOWN_MS + 1);
    expect(dashboardLiveManualSync(sync, undefined, expired)).toBeUndefined();
    // A scheduled sync that finished after the press is the newer word.
    expect(dashboardLiveManualSync(sync, new Date(NOW.getTime() + 5 * 60_000).toISOString(), later)).toBeUndefined();
  });
});

function finishedWithUnreadable(): DashboardSourceCard {
  return card({
    coverage: {
      indexed_items: 254,
      content_ready_items: 252,
      embedded_items: 0,
      embedded_files: 252,
      needs_review_items: 0,
      answer_ready_eligible_items: 254,
      unreadable_items: 2,
    },
    last_sync_at: '2026-10-08T11:19:00.000Z',
  });
}

function card(overrides: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
  return {
    corpus_id: 'secure_local.dropbox.files',
    source_id: 'dropbox.files',
    label: 'Dropbox',
    provider: 'dropbox',
    family: 'file',
    trust_domain: 'secure_local',
    configured: true,
    freshness: { label: 'Last checked 41 minutes ago', hours: 0.68, threshold_hours: 26, stale: false },
    coverage: {
      indexed_items: 254,
      content_ready_items: 254,
      embedded_items: 0,
      embedded_files: 254,
      needs_review_items: 0,
      answer_ready_eligible_items: 254,
    },
    ingestion_health: { coverage_percent: 100, stuck_count: 0, drain_state: 'enabled', label: '' },
    tier_composition: [],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'ready', label: 'Ready for questions' },
    connection: { state: 'synced', label: 'synced 41 minutes ago', action: { kind: 'none' }, handles: ['dropbox.personal'] },
    ...overrides,
  };
}

function viewOf(source: DashboardSourceCard): SourceDashboardViewModel {
  const base = realView({});
  return { ...base, sources: base.sources.map((entry) => (entry.source_id === source.source_id ? source : entry)) };
}

function syncTask(overrides: Partial<SourceSchedulerTaskStatus> = {}): SourceSchedulerTaskStatus {
  return {
    id: 'dropbox.files:sync',
    kind: 'sync',
    running: false,
    consecutive_failures: 0,
    last_attempt_at: '2026-10-08T11:59:30.000Z',
    ...overrides,
  };
}

function schedulerStatus(tasks: SourceSchedulerTaskStatus[]): SourceSchedulerStatus {
  return {
    kind: 'source_scheduler_status',
    enabled: true,
    running: true,
    generated_at: NOW.toISOString(),
    sources: [{
      source_id: 'dropbox.files',
      corpus_id: 'secure_local.dropbox.files',
      sync_cadence: 'continuous',
      sync_interval_seconds: 3600,
      freshness_threshold_hours: 26,
      stale_sync_anomaly: false,
      tasks,
    }],
    policy: { raw_source_exposed: false, source_text_returned: false, source_scope_keys_exposed: false, counts_only: true },
  };
}

function realView(
  countOverrides: Record<string, number>,
  options: { manualSyncs?: Record<string, DashboardManualSync>; now?: Date } = {},
): SourceDashboardViewModel {
  return buildSourceDashboardViewModel({
    sourceIndexStatus: {
      kind: 'source_index_status',
      generated_at: NOW.toISOString(),
      corpora: [{
        corpus_id: 'secure_local.dropbox.files',
        family: 'file',
        trust_domain: 'secure_local',
        activation_mode: 'hybrid_primary',
        embedding_policy: 'local_only',
        configured: true,
        provider: 'dropbox',
        read_authority: 'legacy_index',
        counts: {
          accounts: 1,
          files: 254,
          folders: 0,
          items_with_text: 252,
          qa_eligible_items: 254,
          extraction_jobs_queued: 0,
          extraction_jobs_queued_actionable: 0,
          extraction_jobs_leased_current: 0,
          extraction_jobs_leased_current_actionable: 0,
          extraction_jobs_failed: 2,
          extraction_jobs_failed_actionable: 0,
          ...countOverrides,
        },
        item_metadata_returned: false,
        skipped_item_metadata_reason: 'secure_local_item_metadata_not_exposed_to_castor',
      } as unknown as SourceIndexStatusResult['corpora'][number]],
      policy: {
        read_only: true,
        raw_source_exposed: false,
        source_packets_exposed: false,
        source_text_returned: false,
        secure_local_item_metadata_exposed: false,
        castor_visible: true,
      },
    },
    sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
    connectedHandleRegistry: dropboxHandleRegistry(),
    ...(options.manualSyncs ? { manualSyncs: options.manualSyncs } : {}),
    now: options.now ?? NOW,
  });
}

function dropboxHandleRegistry(): ConnectedHandleRegistry {
  return {
    version: 1,
    handles: [{
      handle: 'dropbox.personal',
      provider: 'dropbox',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: ['files.metadata.read'],
      connectedAt: '2026-10-08T10:00:00.000Z',
    }],
  };
}

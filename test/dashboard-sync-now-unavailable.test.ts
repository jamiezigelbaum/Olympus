/**
 * A worker that cannot run Sync now for a source must not offer the control,
 * and must not advise pressing it.
 *
 * The owner's laptop, 2026-09-04: the Google Drive card carried a Sync now
 * button and a sentence telling him to try it, and the press answered
 * "Private source worker does not support Sync now for google-drive".
 */
import { describe, expect, test } from 'bun:test';
import { dashboardAttentionBanner } from '../src/workers/dashboard/attention.ts';
import {
  buildSourceDashboardViewModel,
  type SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import type { DashboardSourceCard } from '../src/workers/source-dashboard.ts';

const NOW = new Date('2026-09-04T12:00:00.000Z');

describe('Sync now the worker cannot run', () => {
  test('is not offered, and the banner does not advise pressing it', () => {
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    const card = justConnectedCard({ sync_now_available: false });
    const banner = dashboardAttentionBanner(card, { now: later, setupPath: '/dashboard/setup' });

    expect(banner?.kind).toBe('lane_stuck');
    expect(banner?.action).toBeUndefined();
    expect(banner?.sentence).not.toContain('Try a sync now');
    expect(banner?.sentence).toContain('Ask your agent to look at the lane.');

    // Declared available, the control and its advice both come back.
    const offered = dashboardAttentionBanner(
      justConnectedCard({ sync_now_available: true }),
      { now: later, setupPath: '/dashboard/setup' },
    );
    expect(offered?.action).toMatchObject({ kind: 'sync_now', source: 'google-drive' });
    expect(offered?.sentence).toContain('Try a sync now');
  });
});


/**
 * Google Drive as the owner's laptop had it: one-click connected a minute ago,
 * nothing synced, and an embedding lane switched off because no Gemini key had
 * been stored yet.
 */
describe('the readiness ladder over a worker that cannot Sync now', () => {
  test('advises keeping the worker running instead of pressing a control that 501s', () => {
    const unavailable = viewModel(() => false);
    const gmail = unavailable.sources.find((card) => card.source_id === 'gmail.email')!;
    expect(gmail.sync_now_available).toBe(false);
    expect(gmail.setup?.stage).toBe('initial_sync');
    expect(gmail.setup?.next_action).toContain('no Sync now for Gmail');
    expect(gmail.setup?.next_action).not.toContain('Start Sync now');

    const step = unavailable.onboarding.steps.find((entry) => entry.id === 'initial_sync')!;
    expect(step.next_action).toContain('sync on their own schedule');
    expect(step.next_action).not.toContain('Start Sync now');
  });

  test('keeps the Sync now advice wherever the control actually works', () => {
    const available = viewModel(() => true);
    const gmail = available.sources.find((card) => card.source_id === 'gmail.email')!;
    expect(gmail.setup?.next_action).toContain('Start Sync now for Gmail');
    expect(available.onboarding.steps.find((entry) => entry.id === 'initial_sync')?.next_action)
      .toContain('Start Sync now');
  });

  test('a caller that declares nothing keeps the advice it always had', () => {
    const undeclared = buildSourceDashboardViewModel({
      sourceIndexStatus: emptyStatus(),
      sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('no-sensitive')),
      now: NOW,
    });
    expect(undeclared.onboarding.steps.find((entry) => entry.id === 'initial_sync')?.next_action)
      .toContain('Start Sync now');
  });
});

function viewModel(syncNowAvailable: () => boolean): SourceDashboardViewModel {
  return buildSourceDashboardViewModel({
    sourceIndexStatus: emptyStatus(),
    sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('no-sensitive')),
    connectedHandleRegistry: {
      version: 1,
      handles: [{
        handle: 'gmail.personal',
        provider: 'gmail',
        accountRole: 'personal',
        trustDomain: 'internal',
        allowedCapabilities: ['gmail.sync'],
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        connectedAt: NOW.toISOString(),
      }],
    },
    syncNowAvailable,
    now: NOW,
  });
}

/** A worker that has indexed nothing yet: the fresh install's own shape. */
function emptyStatus() {
  return {
    kind: 'source_index_status' as const,
    generated_at: NOW.toISOString(),
    corpora: [],
    policy: {
      read_only: true as const,
      raw_source_exposed: false as const,
      source_packets_exposed: false as const,
      source_text_returned: false as const,
      secure_local_item_metadata_exposed: false as const,
      castor_visible: true as const,
    },
  };
}

function justConnectedCard(overrides: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
  return {
    corpus_id: 'internal.google_drive.docs',
    source_id: 'google_drive.docs',
    label: 'Google Drive',
    provider: 'google',
    family: 'file',
    trust_domain: 'internal',
    configured: true,
    freshness: { label: 'Waiting for first check', stale: false },
    coverage: {
      indexed_items: 0,
      content_ready_items: 0,
      embedded_items: 0,
      needs_review_items: 0,
    },
    ingestion_health: {
      coverage_percent: 0,
      stuck_count: 0,
      drain_state: 'enabled',
      label: 'Nothing indexed yet',
    },
    tier_composition: [
      { trust_domain: 'internal', label: 'Internal', indexed_items: 0, content_ready_items: 0 },
    ],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'empty', label: 'Nothing to answer from yet' },
    embedding_lane_state: 'embedding_lane_disabled',
    connection: {
      state: 'waiting_for_first_sync',
      label: 'connected, waiting for first sync',
      action: { kind: 'none' },
      handles: ['google.personal'],
      connected_at: new Date(NOW.getTime() - 60_000).toISOString(),
    },
    ...overrides,
  };
}

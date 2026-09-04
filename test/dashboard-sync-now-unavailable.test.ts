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

/**
 * A source that has never run reads as waiting, not as stalled.
 *
 * From the owner's live test on 2026-09-04: Google Drive, connected minutes
 * earlier through the one-click flow, on a worker whose scheduler was switched
 * off. The detail page said "Needs you · checked just now", the metadata-sync
 * row said "Stalled · no movement seen", the banner blamed the embedding lane
 * for it, and pressing Sync now answered "Private source worker does not
 * support Sync now for google-drive".
 *
 * Every one of those came from an absence of evidence being read as a finding.
 */
import { describe, expect, test } from 'bun:test';
import { renderDashboardDetailBody } from '../src/workers/dashboard/pages/detail.ts';
import {
  DASHBOARD_FIRST_SYNC_GRACE_HOURS,
  dashboardSourceProgress,
} from '../src/workers/dashboard/phases.ts';
import { dashboardAttentionBanner } from '../src/workers/dashboard/attention.ts';
import type { DashboardSourceCard } from '../src/workers/source-dashboard.ts';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const GRACE_MS = DASHBOARD_FIRST_SYNC_GRACE_HOURS * 3_600_000;

describe('a source that has never run', () => {
  test('reads as waiting for the first sync rather than stalled', () => {
    const progress = dashboardSourceProgress(justConnectedCard(), { now: NOW });

    expect(progress.phases.map((phase) => [phase.id, phase.state])).toEqual([
      ['metadata_sync', 'waiting'],
      ['extraction', 'waiting'],
      ['embedding', 'waiting'],
    ]);
    expect(progress.phases[0]!.state_words).toBe('Waiting for the first sync');
    expect(progress.phases.map((phase) => phase.state_words)).not.toContain('Stalled · no movement seen');
  });

  test('is not in Needs you, and its page carries no stuck banner', () => {
    const card = justConnectedCard();

    expect(dashboardAttentionBanner(card, { now: NOW, setupPath: '/dashboard/setup' })).toBeUndefined();
    const html = renderDashboardDetailBody(card, { now: NOW });
    expect(html).not.toContain('class="attncard banner"');
    expect(html).not.toContain('no movement seen');
    expect(html).not.toContain('embedding lane is switched off');
  });

  test('says the first sync never ran once the window has passed, and names the lane that stopped', () => {
    // Same card, an hour and a minute later: still no run, and now that is a
    // finding rather than the ordinary state of a new connection.
    const later = new Date(NOW.getTime() + GRACE_MS + 60_000);
    const card = justConnectedCard();
    const progress = dashboardSourceProgress(card, { now: later });

    expect(progress.phases[0]).toMatchObject({
      id: 'metadata_sync',
      state: 'stalled',
      state_words: 'Stalled · the first sync has not run yet',
    });
    // The row is a status and the banner is an interruption, so they keep
    // different thresholds: an hour in, the row says stalled and the page still
    // does not interrupt anyone.
    expect(dashboardAttentionBanner(card, { now: later, setupPath: '/dashboard/setup' })).toBeUndefined();

    const wellPast = new Date(NOW.getTime() + 25 * 3_600_000);
    const banner = dashboardAttentionBanner(card, { now: wellPast, setupPath: '/dashboard/setup' });
    expect(banner?.kind).toBe('lane_stuck');
    // The lane that stopped, and its own reason. The live page named neither:
    // "its lane" over a card with three of them, and "the embedding lane is
    // switched off" about a metadata sync that had never started.
    expect(banner?.sentence).toContain('its metadata sync lane');
    expect(banner?.sentence).toContain('the first sync has not run yet');
    expect(banner?.sentence).not.toContain('embedding lane is switched off');
  });

  test('a first run of any kind ends the window, whatever the clock says', () => {
    const wellPast = new Date(NOW.getTime() + 30 * GRACE_MS);
    const ran = justConnectedCard({
      last_run: { status: 'completed', items_seen: 12, items_indexed: 12 },
    });

    expect(dashboardSourceProgress(ran, { now: wellPast }).phases[0]!.state_words)
      .toBe('Stalled · no movement seen');
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

/**
 * Owner ruling "every problem findable": once a provider has rejected the
 * stored credential (the scheduler records an HTTP 401 pull as
 * credential_reauth_required, for any connector), the source reads Needs you
 * with a fix instead of "synced". One path for every source: no connector is
 * named in the rule, so the cases below run the same card through two
 * differently-connected sources.
 */
import { describe, expect, test } from 'bun:test';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import type { DashboardSourceCard, SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const HOUR = 3_600_000;

const SOURCES = [
  { source_id: 'readwise.library', corpus_id: 'secure_local.readwise.library', label: 'Readwise', provider: 'readwise', family: 'notes', action: { kind: 'none' } },
  { source_id: 'dropbox.files', corpus_id: 'secure_local.dropbox.files', label: 'Dropbox', provider: 'dropbox', family: 'file', action: { kind: 'none' } },
];

function card(source: typeof SOURCES[number], schedule?: Record<string, unknown>): DashboardSourceCard {
  return {
    corpus_id: source.corpus_id,
    source_id: source.source_id,
    label: source.label,
    provider: source.provider,
    family: source.family,
    trust_domain: 'secure_local',
    configured: true,
    freshness: { label: 'Last checked 1 hour ago', hours: 1, threshold_hours: 26, stale: false },
    coverage: { indexed_items: 254, content_ready_items: 254, embedded_items: 254, needs_review_items: 0, answer_ready_eligible_items: 254 },
    ingestion_health: { coverage_percent: 100, stuck_count: 0, drain_state: 'enabled', label: '' },
    tier_composition: [],
    queue_health: { label: 'Healthy', waiting: 0, active: 0, needs_attention: 0, failing_tasks: 0 },
    answer_readiness: { state: 'ready', label: 'Ready for questions' },
    connection: { state: 'synced', label: 'synced 1 hour ago', action: source.action, handles: [`${source.provider}.personal`] },
    last_sync_at: new Date(NOW.getTime() - HOUR).toISOString(),
    ...(schedule ? { schedule } : {}),
  } as unknown as DashboardSourceCard;
}

function sourceOf(c: DashboardSourceCard) {
  const view = { sources: [c], generated_at: NOW.toISOString() } as unknown as SourceDashboardViewModel;
  const model = buildChatGptDashboardViewModel(view, { now: NOW });
  return { source: model.sources[0], model };
}

describe.each(SOURCES)('$label: a rejected credential', (src) => {
  test('a 401 pull puts the source under Needs you with a fix', () => {
    const { source, model } = sourceOf(card(src, { running: false, consecutive_failures: 1, last_error_kind: 'credential_reauth_required' }));
    expect(source?.status).toBe('Needs you');
    const item = model.needsYou.find((entry) => entry.id === `source:${src.source_id}`);
    expect(item).toBeDefined();
    expect(item?.fix?.label).toBe('Reconnect');
  });

  test('a healthy card, a different failure, and a pause stay as they were', () => {
    expect(sourceOf(card(src)).source?.status).not.toBe('Needs you');
    expect(sourceOf(card(src, { running: false, consecutive_failures: 1, last_error_kind: 'task_failed' })).model.needsYou
      .some((entry) => entry.id === `source:${src.source_id}`)).toBe(false);
    // A success clears the failure: no consecutive failures left.
    expect(sourceOf(card(src, { running: false, consecutive_failures: 0, last_error_kind: 'credential_reauth_required' })).model.needsYou
      .some((entry) => entry.id === `source:${src.source_id}`)).toBe(false);
  });
});

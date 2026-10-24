/**
 * Live capture freshness on the dashboard.
 *
 * WhatsApp and Telegram messages arrive through a helper that holds a linked
 * session. A pull of what it captured can succeed on schedule while nothing
 * new was captured for days, so the card must say that apart from a sync that
 * is merely late. Every case here feeds the dashboard the receipt counts a
 * real pull stores (synthetic data, no network, no capture process).
 */
import { describe, expect, test } from 'bun:test';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import {
  DASHBOARD_CAPTURE_BLOCKED_LABEL,
  DASHBOARD_CAPTURE_STALE_LABEL,
  dashboardAttentionLine,
  dashboardStatus,
  dashboardSubLine,
} from '../src/workers/dashboard/vocabulary.ts';
import {
  buildSourceDashboardViewModel,
  type DashboardCaptureRuntime,
  type DashboardSourceCard,
} from '../src/workers/source-dashboard.ts';
import type { ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import type { SourceSchedulerStatus } from '../src/workers/source-scheduler.ts';
import { captureFreshnessCounts } from '../src/workers/connector-store/capture-freshness.ts';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const PULLED_AT = '2026-10-24T11:55:00.000Z';
const THRESHOLD = 64_800;

type Which = 'whatsapp' | 'telegram';

const SOURCES: Record<Which, { sourceId: string; corpusId: string; provider: string; trust: string; label: string; task: string }> = {
  whatsapp: {
    sourceId: 'whatsapp.personal.messages',
    corpusId: 'secure_local.whatsapp.messages',
    provider: 'whatsapp_personal',
    trust: 'secure_local',
    label: 'WhatsApp',
    task: 'whatsapp.personal.messages_store_pull',
  },
  telegram: {
    sourceId: 'telegram.messages',
    corpusId: 'internal.telegram.messages',
    provider: 'telegram',
    trust: 'internal',
    label: 'Telegram',
    task: 'telegram.messages_store_pull',
  },
};

function handles(which: Which): ConnectedHandleRegistry {
  return which === 'telegram'
    ? {
        version: 1,
        handles: [{
          handle: 'telegram.personal',
          provider: 'telegram',
          sessionKind: 'mtproto_session',
          accountRole: 'personal',
          trustDomain: 'secure_local',
          allowedCapabilities: ['telegram.messages.sync'],
          scopes: [],
          tokenSecretRefs: ['store:telegram.personal.session_path'],
          backendState: {
            kind: 'mtproto_session',
            status: 'available',
            mtprotoProfileId: 'telegram_personal',
            runtimeEndpointId: 'telegram_local_telethon_reader',
            library: 'telethon',
            backendLabel: 'local_private:telegram_telethon_reader',
          },
          connectedAt: '2026-10-01T10:00:00.000Z',
        }],
      } as unknown as ConnectedHandleRegistry
    : {
        version: 1,
        handles: [{
          handle: 'whatsapp.personal_local',
          provider: 'whatsapp_personal',
          sessionKind: 'local_app_database',
          accountRole: 'personal_local',
          trustDomain: 'secure_local',
          allowedCapabilities: ['whatsapp.personal.messages.sync'],
          scopes: [],
          tokenSecretRefs: ['store:whatsapp.personal_local.session_path'],
          backendState: {
            kind: 'local_app_database',
            status: 'available',
            databaseSourceId: 'whatsapp_personal_local',
            readerWorker: 'whatsapp_local_reader',
            databaseRole: 'messages_readonly',
            scopeLabel: 'personal_messages',
            backendLabel: 'local_private:whatsapp_local_app_reader',
          },
          connectedAt: '2026-10-01T10:00:00.000Z',
        }],
      } as unknown as ConnectedHandleRegistry;
}

/** The counts a pull stores: ordinary receipt counts plus the capture verdict. */
function receiptCounts(capture: Parameters<typeof captureFreshnessCounts>[0] | undefined): Record<string, number> {
  return {
    items_seen: 40,
    items_indexed: 40,
    items_changed: 0,
    ...(capture ? captureFreshnessCounts(capture) : {}),
  };
}

function build(input: {
  which: Which;
  counts?: Record<string, number>;
  status?: 'progress' | 'idle' | 'failed';
  pulledAt?: string;
  captureRuntime?: Record<string, DashboardCaptureRuntime>;
  stale?: boolean;
  /** Default true. False: nothing is paired and nothing ever synced, as before Connect. */
  connected?: boolean;
}) {
  const spec = SOURCES[input.which];
  const status = {
    kind: 'source_index_status',
    generated_at: NOW.toISOString(),
    corpora: [{
      corpus_id: spec.corpusId,
      family: 'chat',
      trust_domain: spec.trust,
      activation_mode: 'hybrid_primary',
      embedding_policy: 'local_only',
      configured: true,
      provider: spec.provider,
      counts: input.connected === false
        ? { accounts: 0, indexed_items: 0, files_with_text: 0, chunks: 0, embedded_chunks: 0, sync_runs: 0 }
        : { accounts: 1, indexed_items: 1200, files_with_text: 1200, items_embedded: 1200, chunks: 2400, embedded_chunks: 2400, sync_runs: 1 },
      ...(input.connected === false
        ? {}
        : {
            last_refresh: {
              sync_run_id: 'run-1',
              status: 'completed',
              started_at: '2026-10-24T11:50:00.000Z',
              completed_at: PULLED_AT,
              items_seen: 40,
              items_indexed: 40,
            },
          }),
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'item_metadata_not_requested',
    }],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  } as unknown as SourceIndexStatusResult;
  const scheduler = {
    kind: 'source_scheduler_status',
    enabled: true,
    running: true,
    generated_at: NOW.toISOString(),
    sources: [{
      source_id: spec.sourceId,
      corpus_id: spec.corpusId,
      sync_cadence: 'continuous',
      sync_interval_seconds: 300,
      freshness_threshold_hours: 26,
      ...(input.connected === false ? {} : { freshness_hours: 0.1 }),
      stale_sync_anomaly: input.stale === true,
      tasks: [{
        id: spec.task,
        kind: 'sync' as const,
        running: false,
        consecutive_failures: input.status === 'failed' ? 1 : 0,
        // Nothing has ever synced when nothing is paired: a chat source reads
        // as connected from its handle or from a sync that succeeded.
        ...(input.connected === false ? {} : { last_success_at: input.pulledAt ?? PULLED_AT, last_attempt_at: input.pulledAt ?? PULLED_AT }),
        ...(input.counts ? { last_result: { status: input.status ?? 'idle', counts: input.counts } } : {}),
      }],
    }],
    policy: { raw_source_exposed: false, source_text_returned: false, source_scope_keys_exposed: false, counts_only: true },
  } as unknown as SourceSchedulerStatus;
  const view = buildSourceDashboardViewModel({
    sourceIndexStatus: status,
    schedulerStatus: scheduler,
    sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
    ...(input.connected === false ? {} : { connectedHandleRegistry: handles(input.which) }),
    ...(input.captureRuntime ? { captureRuntime: input.captureRuntime } : {}),
    now: NOW,
  });
  const card = view.sources.find((source) => source.source_id === spec.sourceId)!;
  const panel = buildChatGptDashboardViewModel(view, { now: NOW });
  return {
    card,
    row: panel.sources.find((source) => source.label === spec.label)!,
    needsYou: panel.needsYou.filter((item) => item.id === `source:${spec.sourceId}`),
  };
}

const DAY = 86_400;
const stale = (ageSeconds: number) => ({ status: 'stale' as const, threshold_seconds: THRESHOLD, age_seconds: ageSeconds });
const fresh = (ageSeconds: number) => ({ status: 'fresh' as const, threshold_seconds: THRESHOLD, age_seconds: ageSeconds });
const unavailable = { status: 'unavailable' as const, threshold_seconds: THRESHOLD };

describe.each(['whatsapp', 'telegram'] as const)('%s live capture freshness', (which) => {
  const spec = SOURCES[which];

  test('a successful pull of a feed quiet for three days reads Needs you with the age and a route', () => {
    const { card, row, needsYou } = build({ which, counts: receiptCounts(stale(3 * DAY)) });
    expect(card.freshness.stale).toBe(false);
    expect(card.freshness.capture).toEqual({ state: 'stale', age_seconds: 3 * DAY + 300, threshold_seconds: THRESHOLD });
    expect(card.answer_readiness).toEqual({ state: 'needs_attention', label: DASHBOARD_CAPTURE_STALE_LABEL });
    expect(dashboardStatus({ source: card })).toBe('Needs you');
    expect(dashboardAttentionLine(card)).toBe('capture stale: newest message 3d ago');
    expect(card.setup?.next_action).toContain(`Open ${spec.label}`);
    expect(row.status).toBe('Needs you');
    expect(row.detail).toBe('capture stale: newest message 3d ago');
    expect(row.primary?.label).toBe('Check capture');
    expect(row.primary?.openHref).toBe(true);
    expect(needsYou).toHaveLength(1);
    expect(needsYou[0]!.sentence).toBe(`${spec.label} — capture stale: newest message 3d ago`);
    expect(needsYou[0]!.fix.label).toBe('Check capture');
  });

  test('the age keeps growing between pulls', () => {
    const { card } = build({ which, counts: receiptCounts(fresh(17 * 3600)), pulledAt: '2026-10-24T09:00:00.000Z' });
    // 17h at the pull, plus the 3h since: past the 18h threshold now.
    expect(card.freshness.capture?.state).toBe('stale');
    expect(card.freshness.capture?.age_seconds).toBe(17 * 3600 + 3 * 3600);
  });

  test('a fresh capture shows no attention item and a plain sync line', () => {
    const { card, row, needsYou } = build({ which, counts: receiptCounts(fresh(600)) });
    expect(card.freshness.capture?.state).toBe('fresh');
    expect(card.answer_readiness.state).toBe('ready');
    expect(dashboardStatus({ source: card })).toBe('Fresh');
    expect(row.status).toBe('Fresh');
    expect(needsYou).toEqual([]);
    expect(dashboardSubLine(card, { now: NOW })).not.toContain('capture stale');
  });

  test('an unavailable capture says nothing was captured yet and is not an alarm', () => {
    const { card, row, needsYou } = build({ which, counts: receiptCounts(unavailable) });
    expect(card.freshness.capture).toEqual({ state: 'unavailable', threshold_seconds: THRESHOLD });
    expect(card.answer_readiness.state).toBe('ready');
    expect(row.status).toBe('Fresh');
    expect(row.detail).toContain('no live messages captured yet');
    expect(needsYou).toEqual([]);
  });

  test('a source whose receipt carries no capture counts reports none', () => {
    const { card, row } = build({ which, counts: receiptCounts(undefined) });
    expect(card.freshness).not.toHaveProperty('capture');
    expect(row.detail ?? '').not.toContain('capture');
  });

  test('counts from a failed pull are not a reading of the feed', () => {
    const { card } = build({ which, counts: receiptCounts(stale(3 * DAY)), status: 'failed' });
    expect(card.freshness).not.toHaveProperty('capture');
  });

  test('a late refresh keeps its own words when capture is also stale', () => {
    const { card } = build({ which, counts: receiptCounts(stale(3 * DAY)), stale: true });
    expect(card.freshness.stale).toBe(true);
    expect(card.answer_readiness.label).toBe('Needs attention before answers');
  });

  test('the supervisor and the approved scope are shown on the row', () => {
    const { card, row } = build({
      which,
      counts: receiptCounts(fresh(600)),
      captureRuntime: { [spec.sourceId]: { supervisor: { state: 'running' }, scope: { kind: 'chats', count: 3 } } },
    });
    expect(card.capture).toEqual({ supervisor: { state: 'running' }, scope: { kind: 'chats', count: 3 } });
    expect(row.detail).toBe('synced 6m ago · capture running · 3 chats');
  });

  test('a stopped helper under a stale feed is named beside the age', () => {
    const { card } = build({
      which,
      counts: receiptCounts(stale(2 * DAY)),
      captureRuntime: { [spec.sourceId]: { supervisor: { state: 'stopped', reason: 'handle_unavailable' } } },
    });
    expect(dashboardAttentionLine(card)).toBe('capture stale: newest message 2d ago · capture stopped');
  });

  test('a helper that cannot start is Needs you whatever the pull says, with its reason', () => {
    const { card, row, needsYou } = build({
      which,
      counts: receiptCounts(fresh(600)),
      captureRuntime: { [spec.sourceId]: { supervisor: { state: 'blocked', reason: 'session_missing' }, scope: { kind: 'whole_account' } } },
    });
    expect(card.answer_readiness).toEqual({ state: 'needs_attention', label: DASHBOARD_CAPTURE_BLOCKED_LABEL });
    expect(row.status).toBe('Needs you');
    expect(needsYou[0]!.sentence).toBe(`${spec.label} — capture cannot start: its linked session is missing`);
    expect(needsYou[0]!.fix.label).toBe('Check capture');
    expect(card.setup?.next_action).toContain(`Open ${spec.label}`);
  });

  test('a running helper over a whole-account approval reads plainly', () => {
    const { row } = build({
      which,
      counts: receiptCounts(fresh(600)),
      captureRuntime: { [spec.sourceId]: { supervisor: { state: 'running' }, scope: { kind: 'whole_account' } } },
    });
    expect(row.detail).toBe('synced 6m ago · capture running · whole account');
  });

  test('the panel keeps no chat identifier, only closed words and counts', () => {
    const { card } = build({
      which,
      counts: receiptCounts(stale(3 * DAY)),
      captureRuntime: { [spec.sourceId]: { supervisor: { state: 'blocked', reason: 'secret_missing' }, scope: { kind: 'chats', count: 2 } } },
    });
    const serialized = JSON.stringify(card.capture);
    expect(serialized).not.toMatch(/@|\.session|jid/i);
  });
});

describe('capture runtime on other cards', () => {
  test('a source the map does not name shows nothing of it', () => {
    const { card } = build({ which: 'whatsapp', counts: receiptCounts(fresh(600)), captureRuntime: { 'telegram.messages': { supervisor: { state: 'blocked' } } } });
    expect(card).not.toHaveProperty('capture');
    expect(card.answer_readiness.state).toBe('ready');
  });

  test('a source that is not connected shows no capture state and no capture problem', () => {
    const { card, row, needsYou } = build({
      which: 'telegram',
      connected: false,
      counts: receiptCounts(stale(3 * DAY)),
      captureRuntime: { 'telegram.messages': { supervisor: { state: 'blocked', reason: 'session_missing' } } },
    });
    expect(card.configured).toBe(false);
    expect(card).not.toHaveProperty('capture');
    expect(card.answer_readiness.state).toBe('disconnected');
    expect(row.status).toBe('Off');
    expect(needsYou).toEqual([]);
  });

  test('a blocked helper names itself over the generic late-refresh label, not over a specific one', () => {
    const generic = build({
      which: 'telegram',
      stale: true,
      counts: receiptCounts(fresh(600)),
      captureRuntime: { 'telegram.messages': { supervisor: { state: 'blocked', reason: 'grant_invalid' } } },
    });
    expect(generic.card.answer_readiness.label).toBe(DASHBOARD_CAPTURE_BLOCKED_LABEL);
    expect(dashboardAttentionLine(generic.card)).toBe('capture cannot start: its approval cannot be read');
  });

  test('a stopped helper is a clause on a quiet row, never a problem by itself', () => {
    const { card, row, needsYou } = build({
      which: 'whatsapp',
      counts: receiptCounts(fresh(600)),
      captureRuntime: { 'whatsapp.personal.messages': { supervisor: { state: 'stopped', reason: 'grant_missing' } } },
    });
    expect(card.answer_readiness.state).toBe('ready');
    expect(row.detail).toBe('synced 6m ago · capture stopped');
    expect(needsYou).toEqual([]);
  });

  test('the panel drops anything outside the closed words and counts', () => {
    const { row, needsYou } = build({
      which: 'whatsapp',
      counts: receiptCounts(fresh(600)),
      captureRuntime: {
        'whatsapp.personal.messages': {
          supervisor: { state: 'running', reason: '/Users/someone/session.db' as never },
          scope: { kind: 'chats', count: 2, chats: ['1555@s.whatsapp.net'] } as never,
        },
      },
    });
    expect(JSON.stringify({ row, needsYou })).not.toMatch(/someone|1555|s\.whatsapp/);
    expect(row.detail).toBe('synced 6m ago · capture running · 2 chats');
  });
});

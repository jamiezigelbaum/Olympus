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

function handles(which: Which, reauth = false): ConnectedHandleRegistry {
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
            status: reauth ? 'reauth_required' : 'available',
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
            status: reauth ? 'reauth_required' : 'available',
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

/**
 * The counts a pull stores, written out literally under the keys the receipts
 * use (not produced by the production encoder, so a mistake shared by encoder
 * and decoder cannot pass): ordinary receipt counts plus the capture verdict.
 */
type Reading = Record<string, number> | undefined;
const ORDINARY_COUNTS = { items_seen: 40, items_indexed: 40, items_changed: 0 };
function receiptCounts(capture: Reading): Record<string, number> {
  return { ...ORDINARY_COUNTS, ...(capture ?? {}) };
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
  /** The pairing's sign-in has lapsed. */
  reauth?: boolean;
  /** Replaces the single sync task with these (for several pulls that disagree). */
  tasks?: Array<{ id: string; counts: Record<string, number> }>;
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
      tasks: (input.tasks ?? [{ id: spec.task, counts: input.counts }]).map((entry) => ({
        id: entry.id,
        kind: 'sync' as const,
        running: false,
        consecutive_failures: input.status === 'failed' ? 1 : 0,
        // Nothing has ever synced when nothing is paired: a chat source reads
        // as connected from its handle or from a sync that succeeded.
        ...(input.connected === false ? {} : { last_success_at: input.pulledAt ?? PULLED_AT, last_attempt_at: input.pulledAt ?? PULLED_AT }),
        ...(entry.counts ? { last_result: { status: input.status ?? 'idle', counts: entry.counts } } : {}),
      })),
    }],
    policy: { raw_source_exposed: false, source_text_returned: false, source_scope_keys_exposed: false, counts_only: true },
  } as unknown as SourceSchedulerStatus;
  const view = buildSourceDashboardViewModel({
    sourceIndexStatus: status,
    schedulerStatus: scheduler,
    sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
    ...(input.connected === false ? {} : { connectedHandleRegistry: handles(input.which, input.reauth === true) }),
    ...(input.captureRuntime ? { captureRuntime: input.captureRuntime } : {}),
    now: NOW,
  });
  const card = view.sources.find((source) => source.source_id === spec.sourceId)!;
  const panel = buildChatGptDashboardViewModel(view, { now: NOW });
  return {
    card,
    row: panel.sources.find((source) => source.label === spec.label)!,
    needsYou: panel.needsYou.filter((item) => item.id === `source:${spec.sourceId}`),
    allNeedsYou: panel.needsYou,
  };
}

const DAY = 86_400;
// Literal receipt counts for each verdict, under the keys a pull stores them.
const stale = (ageSeconds: number): Reading => ({
  capture_fresh: 0, capture_stale: 1, capture_unavailable: 0, capture_stale_threshold_seconds: THRESHOLD, capture_age_seconds: ageSeconds,
});
const fresh = (ageSeconds: number): Reading => ({
  capture_fresh: 1, capture_stale: 0, capture_unavailable: 0, capture_stale_threshold_seconds: THRESHOLD, capture_age_seconds: ageSeconds,
});
const unavailable: Reading = {
  capture_fresh: 0, capture_stale: 0, capture_unavailable: 1, capture_stale_threshold_seconds: THRESHOLD,
};
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1_000).toISOString();

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

  test('a helper stopped on purpose under a stale feed is named beside the age', () => {
    const { card } = build({
      which,
      counts: receiptCounts(stale(2 * DAY)),
      captureRuntime: { [spec.sourceId]: { supervisor: { state: 'stopped' } } },
    });
    expect(dashboardAttentionLine(card)).toBe('capture stale: newest message 2d ago · capture stopped');
  });

  test('a helper whose sign-in is gone under a stale feed says so, not only that it is quiet', () => {
    const { card } = build({
      which,
      counts: receiptCounts(stale(2 * DAY)),
      captureRuntime: { [spec.sourceId]: { supervisor: { state: 'stopped', reason: 'handle_unavailable' } } },
    });
    expect(dashboardAttentionLine(card)).toBe('capture stopped: its sign-in is no longer available');
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

  test('a blocked helper beside a late refresh keeps the refresh as the label and says both', () => {
    const both = build({
      which: 'telegram',
      stale: true,
      counts: receiptCounts(fresh(600)),
      captureRuntime: { 'telegram.messages': { supervisor: { state: 'blocked', reason: 'grant_invalid' } } },
    });
    expect(both.card.answer_readiness).toEqual({ state: 'needs_attention', label: 'Needs attention before answers' });
    expect(dashboardAttentionLine(both.card)).toBe('last synced 6m ago, later than expected · capture cannot start: its approval cannot be read');
    expect(both.row.detail).toBe(dashboardAttentionLine(both.card));
  });

  test('a helper stopped on purpose is a clause on a quiet row, never a problem by itself', () => {
    const { card, row, needsYou } = build({
      which: 'whatsapp',
      counts: receiptCounts(fresh(600)),
      captureRuntime: { 'whatsapp.personal.messages': { supervisor: { state: 'stopped' } } },
    });
    expect(card.answer_readiness.state).toBe('ready');
    expect(row.status).toBe('Fresh');
    expect(row.detail).toBe('synced 6m ago · capture stopped');
    expect(needsYou).toEqual([]);
  });

  test('a helper between an exit and its restart is named as restarting, quietly: no alarm, no capture running', () => {
    const quiet = build({
      which: 'whatsapp',
      counts: receiptCounts(fresh(600)),
      captureRuntime: { 'whatsapp.personal.messages': { supervisor: { state: 'stopped', reason: 'restarting' }, scope: { kind: 'chats', count: 2 } } },
    });
    expect(quiet.card.answer_readiness.state).toBe('ready');
    expect(quiet.row.status).toBe('Fresh');
    expect(quiet.row.detail).toBe('synced 6m ago · capture restarting · 2 chats');
    expect(quiet.needsYou).toEqual([]);
    // Under a stale feed it is named beside the age, and the stale feed is still the problem.
    const stale2 = build({
      which: 'telegram',
      counts: receiptCounts(stale(2 * DAY)),
      captureRuntime: { 'telegram.messages': { supervisor: { state: 'stopped', reason: 'restarting' } } },
    });
    expect(dashboardAttentionLine(stale2.card)).toBe('capture stale: newest message 2d ago · capture restarting');
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

describe.each(['whatsapp', 'telegram'] as const)('%s: a helper that is not running on a connected source', (which) => {
  const spec = SOURCES[which];
  const runtime = (supervisor: NonNullable<DashboardCaptureRuntime['supervisor']>) => ({ [spec.sourceId]: { supervisor } });

  const unexpected: Array<[string, NonNullable<DashboardCaptureRuntime['supervisor']>, string]> = [
    ['its approval is gone', { state: 'stopped', reason: 'grant_missing' }, 'capture stopped: its approval is missing'],
    ['its sign-in is gone', { state: 'stopped', reason: 'handle_unavailable' }, 'capture stopped: its sign-in is no longer available'],
    ['its helper would not start', { state: 'blocked', reason: 'start_failed' }, 'capture cannot start: its helper would not start'],
    ['its helper keeps exiting', { state: 'blocked', reason: 'helper_exited' }, 'capture keeps stopping: its helper exits soon after it starts'],
  ];

  for (const [name, supervisor, words] of unexpected) {
    test(`${name}: Needs you with its reason and a route, even while the last message is recent`, () => {
      const { card, row, needsYou } = build({ which, counts: receiptCounts(fresh(600)), captureRuntime: runtime(supervisor) });
      expect(card.freshness.capture?.state).toBe('fresh');
      expect(card.answer_readiness).toEqual({ state: 'needs_attention', label: DASHBOARD_CAPTURE_BLOCKED_LABEL });
      expect(dashboardStatus({ source: card })).toBe('Needs you');
      expect(row.status).toBe('Needs you');
      expect(row.detail).toBe(words);
      expect(row.primary?.label).toBe('Check capture');
      expect(needsYou).toHaveLength(1);
      expect(needsYou[0]!.sentence).toBe(`${spec.label} — ${words}`);
      expect(needsYou[0]!.fix.label).toBe('Check capture');
    });
  }

  test('with no capture reading at all, a lost approval is still a problem, not a quiet row', () => {
    const { row, needsYou } = build({
      which,
      counts: receiptCounts(undefined),
      captureRuntime: runtime({ state: 'stopped', reason: 'grant_missing' }),
    });
    expect(row.status).toBe('Needs you');
    expect(needsYou[0]!.sentence).toBe(`${spec.label} — capture stopped: its approval is missing`);
  });

  test('a reconnect the sign-in needs is the problem; the stopped helper is its consequence, not a second one', () => {
    const { card, row } = build({
      which,
      counts: receiptCounts(fresh(600)),
      reauth: true,
      captureRuntime: runtime({ state: 'stopped', reason: 'handle_unavailable' }),
    });
    expect(card.connection.state).toBe('reauth_required');
    expect(row.status).toBe('Needs you');
    expect(dashboardAttentionLine(card)).toBe('signed out');
  });
});

describe.each(['whatsapp', 'telegram'] as const)('%s: a pairing that has not captured its first message', (which) => {
  const spec = SOURCES[which];
  const pairedAgo = (seconds: number, extra: Partial<DashboardCaptureRuntime> = {}) => ({
    [spec.sourceId]: { supervisor: { state: 'running' as const }, scope: { kind: 'chats' as const, count: 3 }, paired_at: ago(seconds), ...extra },
  });

  test('re-pairing a quiet account does not alarm from the history the old pairing left', () => {
    // Three days of silence in the spool, but the account was linked again ten minutes ago.
    const { card, row, needsYou } = build({ which, counts: receiptCounts(stale(3 * DAY)), captureRuntime: pairedAgo(600) });
    expect(card.freshness.capture).toEqual({ state: 'awaiting', age_seconds: 3 * DAY + 300, threshold_seconds: THRESHOLD });
    expect(card.answer_readiness.state).toBe('ready');
    expect(dashboardStatus({ source: card })).toBe('Waiting');
    expect(row.status).toBe('Waiting');
    expect(row.detail).toBe('waiting for the first live message · newest kept message 3d ago · capture running · 3 chats');
    expect(row.primary).toBeUndefined();
    expect(needsYou).toEqual([]);
    expect(card.setup?.next_action).toContain(`Keep ${spec.label} linked`);
  });

  test('a brand-new pairing that has captured nothing yet is waiting, with no age to show', () => {
    const { card, row } = build({ which, counts: receiptCounts(unavailable), captureRuntime: pairedAgo(600) });
    expect(card.freshness.capture).toEqual({ state: 'awaiting', threshold_seconds: THRESHOLD });
    expect(row.status).toBe('Waiting');
    expect(row.detail).toBe('waiting for the first live message · capture running · 3 chats');
  });

  test('the wait is bounded: one threshold after linking, the same silence is stale again', () => {
    const atThreshold = build({ which, counts: receiptCounts(stale(3 * DAY)), captureRuntime: pairedAgo(THRESHOLD) });
    expect(atThreshold.card.freshness.capture?.state).toBe('awaiting');
    const past = build({ which, counts: receiptCounts(stale(3 * DAY)), captureRuntime: pairedAgo(THRESHOLD + 1) });
    expect(past.card.freshness.capture).toEqual({ state: 'stale', age_seconds: 3 * DAY + 300, threshold_seconds: THRESHOLD });
    expect(past.row.status).toBe('Needs you');
    expect(past.needsYou[0]!.fix.label).toBe('Check capture');
  });

  test('a pairing that captured nothing in a whole threshold is stale, not quietly fine', () => {
    const { card, row, needsYou } = build({ which, counts: receiptCounts(unavailable), captureRuntime: pairedAgo(2 * DAY) });
    expect(card.freshness.capture).toEqual({ state: 'stale', threshold_seconds: THRESHOLD });
    expect(row.status).toBe('Needs you');
    expect(needsYou[0]!.sentence).toBe(`${spec.label} — capture stale: nothing captured since linking`);
  });

  test('a message captured under this pairing is the evidence, and it reads fresh', () => {
    // The newest message is a minute older than the pull, which was ten minutes after the pairing.
    const { card, row } = build({ which, counts: receiptCounts(fresh(60)), captureRuntime: pairedAgo(900) });
    expect(card.freshness.capture).toEqual({ state: 'fresh', age_seconds: 360, threshold_seconds: THRESHOLD });
    expect(row.status).toBe('Fresh');
  });

  test('a recent message from before the pairing is history, not proof the new pairing captures', () => {
    const { card, row } = build({ which, counts: receiptCounts(fresh(3_600)), captureRuntime: pairedAgo(600) });
    expect(card.freshness.capture?.state).toBe('awaiting');
    expect(card.freshness.capture?.age_seconds).toBe(3_900);
    expect(row.status).toBe('Waiting');
  });

  test('without a pairing time the receipt is judged as it always was', () => {
    const { card } = build({ which, counts: receiptCounts(stale(3 * DAY)), captureRuntime: { [spec.sourceId]: { supervisor: { state: 'running' } } } });
    expect(card.freshness.capture?.state).toBe('stale');
  });

  test('a helper that cannot run is a problem even during the wait', () => {
    const { row, needsYou } = build({
      which,
      counts: receiptCounts(unavailable),
      captureRuntime: pairedAgo(600, { supervisor: { state: 'blocked', reason: 'session_missing' } }),
    });
    expect(row.status).toBe('Needs you');
    expect(needsYou[0]!.sentence).toBe(`${spec.label} — capture cannot start: its linked session is missing`);
  });
});

describe.each(['whatsapp', 'telegram'] as const)('%s: a capture problem beside another problem', (which) => {
  const spec = SOURCES[which];

  test('stale capture and a late refresh: the row and the item say both, and Check capture is reachable', () => {
    const { card, row, needsYou } = build({ which, counts: receiptCounts(stale(3 * DAY)), stale: true });
    // The late refresh still owns the readiness label; the capture problem is read from its own fields.
    expect(card.answer_readiness.label).toBe('Needs attention before answers');
    const both = 'last synced 6m ago, later than expected · capture stale: newest message 3d ago';
    expect(dashboardAttentionLine(card)).toBe(both);
    expect(row.detail).toBe(both);
    expect(needsYou).toHaveLength(1);
    expect(needsYou[0]!.sentence).toBe(`${spec.label} — ${both}`);
    // A chat source has no Sync now, so the route to the feed is the row's fix and the item's.
    expect(row.primary?.label).toBe('Check capture');
    expect(row.primary?.openHref).toBe(true);
    expect(needsYou[0]!.fix.label).toBe('Check capture');
    expect(row.menu?.map((entry) => entry.label)).toContain('Check capture');
  });

  test('a blocked helper and a late refresh: the sentence names both and the route is Check capture', () => {
    const { card, row, needsYou } = build({
      which,
      counts: receiptCounts(fresh(600)),
      stale: true,
      captureRuntime: { [spec.sourceId]: { supervisor: { state: 'blocked', reason: 'session_missing' } } },
    });
    expect(card.answer_readiness.label).toBe('Needs attention before answers');
    expect(needsYou[0]!.sentence).toBe(
      `${spec.label} — last synced 6m ago, later than expected · capture cannot start: its linked session is missing`,
    );
    expect(needsYou[0]!.fix.label).toBe('Check capture');
    expect(row.menu?.map((entry) => entry.label)).toContain('Check capture');
  });

  test('a late refresh alone offers no capture route', () => {
    const { row, needsYou } = build({ which, counts: receiptCounts(fresh(600)), stale: true });
    expect(row.menu?.map((entry) => entry.label) ?? []).not.toContain('Check capture');
    expect(needsYou[0]!.sentence).not.toContain('capture');
    expect(needsYou[0]!.fix.label).not.toBe('Check capture');
  });

  test('when capture is the only problem, Check capture is the fix', () => {
    const { row, needsYou } = build({ which, counts: receiptCounts(stale(3 * DAY)) });
    expect(row.primary?.label).toBe('Check capture');
    expect(needsYou[0]!.fix.label).toBe('Check capture');
  });
});

describe('the worst reading across a source\'s pulls', () => {
  test('stale beats unavailable beats fresh, whichever task reports it first', () => {
    const orders: Array<Array<{ id: string; counts: Record<string, number> }>> = [
      [
        { id: 'whatsapp.personal.messages_store_pull', counts: receiptCounts(fresh(60)) },
        { id: 'whatsapp.personal.messages_second_pull', counts: receiptCounts(stale(3 * DAY)) },
      ],
      [
        { id: 'whatsapp.personal.messages_store_pull', counts: receiptCounts(stale(3 * DAY)) },
        { id: 'whatsapp.personal.messages_second_pull', counts: receiptCounts(fresh(60)) },
      ],
    ];
    for (const tasks of orders) {
      const { card } = build({ which: 'whatsapp', tasks });
      expect(card.freshness.capture).toEqual({ state: 'stale', age_seconds: 3 * DAY + 300, threshold_seconds: THRESHOLD });
    }
    const mixed = build({
      which: 'whatsapp',
      tasks: [
        { id: 'whatsapp.personal.messages_store_pull', counts: receiptCounts(fresh(60)) },
        { id: 'whatsapp.personal.messages_second_pull', counts: receiptCounts(unavailable) },
      ],
    });
    expect(mixed.card.freshness.capture).toEqual({ state: 'unavailable', threshold_seconds: THRESHOLD });
  });

  test('a task with no verdict is ignored, and a task\'s own failed run is not a reading', () => {
    const { card } = build({
      which: 'telegram',
      tasks: [
        { id: 'telegram.messages_store_pull', counts: receiptCounts(fresh(60)) },
        { id: 'telegram.messages_other', counts: receiptCounts(undefined) },
      ],
    });
    expect(card.freshness.capture).toEqual({ state: 'fresh', age_seconds: 360, threshold_seconds: THRESHOLD });
  });
});

// Kept media filled its storage (#556 review): the receipt counts a pull stores, written out literally.
const MEDIA_FULL = { media_storage_full: 1, media_left_out_storage_full: 7 };
const MEDIA_ROUTE = ' · ask your agent to raise the media limit or remove media you no longer need';
const MEDIA_LINE = `media storage is full, so 7 new photos and files were kept as names only${MEDIA_ROUTE}`;

describe.each(['whatsapp', 'telegram'] as const)('%s kept media that filled its storage', (which) => {
  const spec = SOURCES[which];

  test('reads Needs you with a plain line that says how many were left out and how to make room', () => {
    const { card, row, needsYou } = build({ which, counts: receiptCounts({ ...fresh(600), ...MEDIA_FULL }) });
    expect(card.media_storage).toEqual({ state: 'full', left_out_items: 7 });
    expect(dashboardStatus({ source: card })).toBe('Needs you');
    expect(dashboardAttentionLine(card)).toBe(MEDIA_LINE);
    expect(card.setup?.next_action).toBe(`${spec.label}'s media storage is full, so new photos and files are kept as names only (7 so far). `
      + `Nothing already kept was removed. To keep new media again, ask your agent to raise ${spec.label}'s media storage limit, `
      + 'or to remove kept media you no longer need.');
    expect(row.status).toBe('Needs you');
    expect(row.detail).toBe(MEDIA_LINE);
    // Sync now cannot make room: the control checks again once room is made.
    expect(row.primary?.label).toBe('Check again');
    expect(needsYou).toHaveLength(1);
    expect(needsYou[0]!.sentence).toBe(`${spec.label} — ${MEDIA_LINE}`);
    expect(needsYou[0]!.fix.label).toBe('Check again');
  });

  test('one left out, or none counted, reads in the singular or without a number', () => {
    const one = build({ which, counts: receiptCounts({ ...fresh(600), media_storage_full: 1, media_left_out_storage_full: 1 }) });
    expect(dashboardAttentionLine(one.card)).toBe(`media storage is full, so 1 new photo or file was kept as a name only${MEDIA_ROUTE}`);
    const none = build({ which, counts: receiptCounts({ ...fresh(600), media_storage_full: 1 }) });
    expect(dashboardAttentionLine(none.card)).toBe(`media storage is full, so new photos and files are kept as names only${MEDIA_ROUTE}`);
  });

  test('beside a stalled feed, both are said and neither hides the other', () => {
    const { card, needsYou } = build({ which, counts: receiptCounts({ ...stale(3 * DAY), ...MEDIA_FULL }) });
    expect(dashboardAttentionLine(card)).toBe(`capture stale: newest message 3d ago · ${MEDIA_LINE}`);
    expect(needsYou[0]!.sentence).toBe(`${spec.label} — capture stale: newest message 3d ago · ${MEDIA_LINE}`);
    expect(needsYou[0]!.fix.label).toBe('Check capture');
  });

  test('not full, or read from a failed pull, says nothing about media', () => {
    const notFull = build({ which, counts: receiptCounts({ ...fresh(600), media_storage_full: 0, media_left_out_storage_full: 0 }) });
    expect(notFull.card).not.toHaveProperty('media_storage');
    expect(dashboardStatus({ source: notFull.card })).toBe('Fresh');
    expect(notFull.needsYou).toEqual([]);
    const failed = build({ which, counts: receiptCounts({ ...fresh(600), ...MEDIA_FULL }), status: 'failed' });
    expect(failed.card).not.toHaveProperty('media_storage');
  });
});

import { describe, expect, test } from 'bun:test';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import { buildSourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import type {
  DashboardConnectionState,
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';
import type { ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import type { WorkerCredentialDegradation } from '../src/workers/credential-degradation.ts';
import {
  DASHBOARD_ANSWER_LANE_STATUS,
  DASHBOARD_ANSWER_READINESS_STATUS,
  DASHBOARD_CONNECTION_STATE_STATUS,
  DASHBOARD_QUEUE_HEALTH_STATUS,
  DASHBOARD_STATUS_ORDER,
  DASHBOARD_STATUS_PRESENTATION,
  DASHBOARD_UNKNOWN_STATUS,
  dashboardAnswerLaneStatus,
  dashboardAttentionLine,
  dashboardBackgroundLine,
  dashboardCheckedLabel,
  dashboardConnectedStatusGroups,
  dashboardCount,
  dashboardDuration,
  dashboardWorkingHeadline,
  dashboardWorkingSummary,
  dashboardHomeMeta,
  dashboardIsConnectedSource,
  dashboardIsFirstRun,
  dashboardMappedUnknownCount,
  dashboardRelativeFromHours,
  dashboardRelativeFromMs,
  dashboardSetupMeta,
  dashboardSourceById,
  dashboardStatus,
  dashboardStatusGroups,
  dashboardStatusResolution,
  dashboardSubLine,
  dashboardWorkFraction,
  type DashboardQueueHealthLabel,
  type DashboardStatus,
} from '../src/workers/dashboard/vocabulary.ts';

const NOW = new Date('2026-07-02T12:00:00.000Z');

// Written out from the view-model declaration rather than read back off the
// mapping tables: a table that maps only what it already knows about is not a
// total mapping, it is a tautology.
const CONNECTION_STATES: DashboardConnectionState[] = [
  'not_connected',
  'needs_setup',
  'awaiting_consent',
  'reauth_required',
  'connected',
  'waiting_for_first_sync',
  'syncing',
  'synced',
];
const ANSWER_READINESS_STATES: Array<DashboardSourceCard['answer_readiness']['state']> = [
  'ready',
  'syncing',
  'needs_attention',
  'empty',
  'disconnected',
];
const QUEUE_HEALTH_LABELS: DashboardQueueHealthLabel[] = [
  'Needs attention',
  'Working now',
  'Waiting to catch up',
  'Caught up',
];

describe('dashboard status vocabulary is total', () => {
  test('maps every connection state to one of the six words', () => {
    for (const state of CONNECTION_STATES) {
      expect(DASHBOARD_STATUS_ORDER).toContain(DASHBOARD_CONNECTION_STATE_STATUS[state]);
    }
    expect(Object.keys(DASHBOARD_CONNECTION_STATE_STATUS).sort()).toEqual([...CONNECTION_STATES].sort());
  });

  test('maps every answer-readiness state', () => {
    for (const state of ANSWER_READINESS_STATES) {
      expect(DASHBOARD_STATUS_ORDER).toContain(DASHBOARD_ANSWER_READINESS_STATUS[state]);
    }
    expect(Object.keys(DASHBOARD_ANSWER_READINESS_STATUS).sort()).toEqual([...ANSWER_READINESS_STATES].sort());
  });

  test('maps every queue-health label', () => {
    for (const label of QUEUE_HEALTH_LABELS) {
      expect(DASHBOARD_STATUS_ORDER).toContain(DASHBOARD_QUEUE_HEALTH_STATUS[label]);
    }
    expect(Object.keys(DASHBOARD_QUEUE_HEALTH_STATUS).sort()).toEqual([...QUEUE_HEALTH_LABELS].sort());
  });

  test('maps both answer-lane connection states', () => {
    expect(DASHBOARD_ANSWER_LANE_STATUS).toEqual({ validated: 'Fresh', missing: 'Off' });
  });

  test('resolves an answer lane through the function, falling back on drift', () => {
    expect(dashboardAnswerLaneStatus(answerLane('validated'))).toBe('Fresh');
    expect(dashboardAnswerLaneStatus(answerLane('missing'))).toBe('Off');
    // A state this module has never seen reads as the no-claim word.
    expect(dashboardAnswerLaneStatus(answerLane('revoked' as never))).toBe(DASHBOARD_UNKNOWN_STATUS);
  });

  test('pins the exact status strings and their glyphs', () => {
    expect([...DASHBOARD_STATUS_ORDER]).toEqual(['Needs you', 'Failing', 'Working', 'Waiting', 'Fresh', 'Off']);
    expect(DASHBOARD_STATUS_PRESENTATION).toEqual({
      'Fresh': { label: 'Fresh', colorToken: 'good', glyphKind: 'dot' },
      'Working': { label: 'Working', colorToken: 'run', glyphKind: 'donut' },
      'Waiting': { label: 'Waiting', colorToken: 'off', glyphKind: 'ring' },
      'Needs you': { label: 'Needs you', colorToken: 'warn', glyphKind: 'dot' },
      'Failing': { label: 'Failing', colorToken: 'bad', glyphKind: 'dot' },
      'Off': { label: 'Off', colorToken: 'line', glyphKind: 'dot' },
    });
  });

  test('gives every connection state a card status without ever leaving the six', () => {
    for (const state of CONNECTION_STATES) {
      const resolution = dashboardStatusResolution({ source: card({ connection: { state } }) });
      expect(resolution.mappedUnknown).toBe(false);
      expect(DASHBOARD_STATUS_ORDER).toContain(resolution.status);
    }
  });
});

describe('unknown enum values', () => {
  test('fall back to Waiting and mark themselves, for an unknown connection state', () => {
    const source = card({ connection: { state: 'teleporting' as DashboardConnectionState } });
    expect(dashboardStatusResolution({ source })).toEqual({
      status: 'Waiting',
      mappedUnknown: true,
      unknownValue: 'teleporting',
    });
    expect(DASHBOARD_UNKNOWN_STATUS).toBe('Waiting');
  });

  test('fall back for an unknown answer-readiness state', () => {
    const source = card({
      answer_readiness: { state: 'reticulating' as DashboardSourceCard['answer_readiness']['state'] },
    });
    expect(dashboardStatusResolution({ source }).unknownValue).toBe('reticulating');
  });

  test('fall back for a queue-health label the worker grew later', () => {
    const source = card({ queue_health: { label: 'Mildly concerned' } });
    expect(dashboardStatusResolution({ source })).toMatchObject({ status: 'Waiting', mappedUnknown: true });
  });

  test('are countable by the page', () => {
    const view = viewOf([
      card({ source_id: 'a.one' }),
      card({ source_id: 'b.two', connection: { state: 'teleporting' as DashboardConnectionState } }),
    ]);
    expect(dashboardMappedUnknownCount(view)).toBe(1);
  });

  test('never bury an expired credential under the fallback word', () => {
    const source = card({
      label: 'Dropbox',
      provider: 'dropbox',
      source_id: 'dropbox.files',
      connection: { state: 'teleporting' as DashboardConnectionState },
    });
    expect(dashboardStatusResolution({ source, degradedCredentials: [degradation({ display_name: 'Dropbox' })] }))
      .toEqual({ status: 'Needs you', mappedUnknown: true, unknownValue: 'teleporting' });
  });

  test('still render a sub-line from the counts that did parse', () => {
    const source = card({
      connection: { state: 'teleporting' as DashboardConnectionState },
      queue_health: { waiting: 800, active: 8 },
    });
    expect(dashboardSubLine(source)).toBe('808 in queue');
  });
});

describe('status precedence', () => {
  test('a matched credential failure outranks a healthy connection', () => {
    const source = card({ label: 'Dropbox', provider: 'dropbox', source_id: 'dropbox.files' });
    expect(dashboardStatus({ source, degradedCredentials: [degradation({ display_name: 'Dropbox' })] }))
      .toBe('Needs you');
  });

  test('a credential failure for another source leaves this card alone', () => {
    const source = card({ label: 'Dropbox', provider: 'dropbox', source_id: 'dropbox.files' });
    expect(dashboardStatus({ source, degradedCredentials: [degradation({ display_name: 'Readwise' })] }))
      .toBe('Fresh');
  });

  test('reauth reads as Needs you, not Failing, even with the attention readiness label', () => {
    const source = card({
      connection: { state: 'reauth_required', label: 'reauth required' },
      answer_readiness: { state: 'needs_attention', label: 'Reauthenticate this source' },
    });
    expect(dashboardStatus({ source })).toBe('Needs you');
  });

  test('a source that was never connected is never called Failing', () => {
    const source = card({
      configured: false,
      connection: { state: 'not_connected', label: 'not connected' },
      answer_readiness: { state: 'disconnected', label: 'Connect this source' },
      queue_health: { label: 'Needs attention', needs_attention: 4 },
      // Never connected means no evidence of data either; indexed items would
      // prove a past connection and change the word.
      coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0, needs_review_items: 0 },
    });
    expect(dashboardStatus({ source })).toBe('Off');
    expect(dashboardIsConnectedSource(source)).toBe(false);
  });

  test('a disconnected source with indexed data is connected-but-broken, not Off', () => {
    // A revoked or deleted handle drops connection.state back to a
    // never-connected value while the corpus still holds items. That source
    // stays on home in Needs you rather than vanishing from every surface.
    const source = card({
      connection: { state: 'not_connected', label: 'not connected' },
      answer_readiness: { state: 'disconnected', label: 'Connect this source' },
    });
    expect(source.coverage.indexed_items).toBeGreaterThan(0);
    expect(dashboardStatus({ source })).toBe('Needs you');
    expect(dashboardIsConnectedSource(source)).toBe(true);
  });

  test('a chat source connected on its own sync evidence is never grouped Needs you', () => {
    // The live 2026-08-19 shape after the data-layer fix: no registry handle,
    // 185k items, a completed sync inside the cadence window. It reads as the
    // healthy card it is, and the needs-you group does not swallow it.
    const telegram = card({
      source_id: 'telegram.messages',
      label: 'Telegram',
      provider: 'telegram',
      connection: {
        state: 'synced',
        label: 'synced 1 hour ago',
        action: { kind: 'guided_session', source: 'telegram', label: 'Session ready', instructions: [] },
        handles: [],
      },
      coverage: { indexed_items: 185_000, content_ready_items: 185_000, embedded_items: 0, needs_review_items: 0 },
    });
    expect(dashboardStatus({ source: telegram })).toBe('Fresh');

    const groups = dashboardConnectedStatusGroups(viewOf([telegram]), { now: NOW });
    expect(groups.map((group) => group.status)).toEqual(['Fresh']);
    expect(dashboardSubLine(telegram)).not.toContain('not connected');
  });

  test('a chat source whose session state is unreadable still reads connected', () => {
    const telegram = card({
      source_id: 'telegram.messages',
      label: 'Telegram',
      provider: 'telegram',
      connection: {
        state: 'connected',
        label: 'connected · live session not checked',
        action: {
          kind: 'guided_session',
          source: 'telegram',
          label: 'Session state not surfaced',
          instructions: [],
        },
        handles: [],
      },
    });
    expect(dashboardStatus({ source: telegram })).toBe('Fresh');
  });

  // needs_attention reads 'Needs you' since 2026-08-24: the attention banner
  // carries what is wrong; the one-word status says who it waits on.
  test('a stalled extractor on a synced source reads as Needs you', () => {
    const source = card({
      answer_readiness: { state: 'needs_attention', label: 'Content extraction is stalled' },
    });
    expect(dashboardStatus({ source })).toBe('Needs you');
  });

  test('queue attention alone reads as Needs you', () => {
    const source = card({ queue_health: { label: 'Needs attention', needs_attention: 3, retrying_tasks: 1 } });
    expect(dashboardStatus({ source })).toBe('Needs you');
  });

  test('a running sync reads as Working and a first sync as Waiting', () => {
    expect(dashboardStatus({ source: card({ connection: { state: 'syncing', label: 'syncing' } }) })).toBe('Working');
    expect(dashboardStatus({
      source: card({ connection: { state: 'waiting_for_first_sync', label: 'connected, waiting for first sync' } }),
    })).toBe('Waiting');
  });
});

describe('status groups', () => {
  test('bucket the cards in section order and drop the empty sections', () => {
    const view = viewOf([
      card({ source_id: 'fresh.one' }),
      card({ source_id: 'work.one', connection: { state: 'syncing', label: 'syncing' } }),
      card({ source_id: 'attn.one', connection: { state: 'reauth_required', label: 'reauth required' } }),
      card({ source_id: 'fresh.two' }),
    ]);
    expect(dashboardStatusGroups(view, { now: NOW }).map((group) => ({
      status: group.status,
      ids: group.sources.map((source) => source.source_id),
    }))).toEqual([
      { status: 'Needs you', ids: ['attn.one'] },
      { status: 'Working', ids: ['work.one'] },
      { status: 'Fresh', ids: ['fresh.one', 'fresh.two'] },
    ]);
  });

  test('read the view model degradations when the caller passes none', () => {
    const view = viewOf([card({ label: 'Dropbox', provider: 'dropbox', source_id: 'dropbox.files' })]);
    view.degraded_credentials = [degradation({ display_name: 'Dropbox' })];
    expect(dashboardStatusGroups(view).map((group) => group.status)).toEqual(['Needs you']);
  });
});

describe('relative time', () => {
  test('clamps clock skew to now instead of counting down', () => {
    expect(dashboardRelativeFromMs(-5_000)).toBe('just now');
    expect(dashboardRelativeFromHours(-1)).toBe('just now');
  });

  test('reads seconds, minutes, hours and days', () => {
    expect(dashboardRelativeFromMs(0)).toBe('just now');
    expect(dashboardRelativeFromMs(400)).toBe('just now');
    expect(dashboardRelativeFromMs(12_000)).toBe('12s ago');
    expect(dashboardRelativeFromMs(45_000)).toBe('45s ago');
    expect(dashboardRelativeFromMs(60_000)).toBe('1m ago');
    expect(dashboardRelativeFromMs(41 * 60_000)).toBe('41m ago');
    expect(dashboardRelativeFromMs(3_600_000)).toBe('1h ago');
    expect(dashboardRelativeFromMs(2 * 3_600_000)).toBe('2h ago');
    expect(dashboardRelativeFromMs(25 * 3_600_000)).toBe('1d ago');
    expect(dashboardRelativeFromMs(3 * 24 * 3_600_000)).toBe('3d ago');
  });

  test('survives the float that freshness.hours actually carries', () => {
    // A 41-minute-old check arrives rounded off as 0.6833 hours, which is
    // 40.98 minutes. Flooring reports it as "40m ago" — a minute staler than
    // the source actually is, on every card, forever.
    expect(dashboardRelativeFromHours(0.6833)).toBe('41m ago');
    expect(dashboardRelativeFromHours(41 / 60)).toBe('41m ago');
    expect(dashboardRelativeFromHours(0.1)).toBe('6m ago');
    expect(dashboardRelativeFromHours(2)).toBe('2h ago');
    expect(dashboardRelativeFromHours(72)).toBe('3d ago');
  });

  test('says nothing for a value that is not a number', () => {
    expect(dashboardRelativeFromHours(Number.NaN)).toBe('');
    expect(dashboardRelativeFromMs(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('duration', () => {
  test('covers zero, sub-minute, minutes, hours and days', () => {
    expect(dashboardDuration(0)).toBe('0s');
    expect(dashboardDuration(-30)).toBe('0s');
    expect(dashboardDuration(18)).toBe('18s');
    expect(dashboardDuration(59.4)).toBe('59s');
    expect(dashboardDuration(60)).toBe('1m');
    expect(dashboardDuration(130)).toBe('2m 10s');
    expect(dashboardDuration(38 * 60)).toBe('38m');
    expect(dashboardDuration(3_600)).toBe('1h');
    expect(dashboardDuration(3_900)).toBe('1h 5m');
    expect(dashboardDuration(86_400)).toBe('1d');
    expect(dashboardDuration(27 * 3_600)).toBe('1d 3h');
    expect(dashboardDuration(Number.NaN)).toBe('0s');
  });
});

describe('counts', () => {
  test('group thousands without a locale', () => {
    expect(dashboardCount(0)).toBe('0');
    expect(dashboardCount(999)).toBe('999');
    expect(dashboardCount(1_000)).toBe('1,000');
    expect(dashboardCount(129_948)).toBe('129,948');
    expect(dashboardCount(Number.NaN)).toBe('0');
  });
});

describe('sub-line grammar', () => {
  test('a fresh source says when it last synced, to the minute', () => {
    const source = card({ freshness: { hours: 41 / 60, label: 'Last checked less than 1 hour ago' } });
    expect(dashboardSubLine(source)).toBe('synced 41m ago');
  });

  test('a fresh source with no recorded check time says nothing', () => {
    const source = card({ freshness: { hours: undefined, label: 'Last check time not recorded' } });
    expect(dashboardSubLine(source)).toBe('');
  });

  test('an answer lane says it answers directly', () => {
    const source = card({
      connection: { state: 'connected', label: 'connected' },
      freshness: { hours: undefined, label: 'Answer lane: answers questions directly, nothing to sync' },
    });
    expect(dashboardSubLine(source)).toBe('answers questions directly');
  });

  test('a working source states the ratio the donut draws', () => {
    const source = card({
      connection: { state: 'syncing', label: 'syncing' },
      coverage: { indexed_items: 44_000, content_ready_items: 20_000 },
      ingestion_health: { coverage_percent: 45.5 },
      queue_health: { label: 'Working now', waiting: 800, active: 8 },
      answer_readiness: { state: 'syncing', label: 'Syncing now' },
    });
    expect(dashboardWorkFraction(source)).toBeCloseTo(0.455, 5);
    // The ratio leads (owner ruling, 2026-08-23/24). The number itself is
    // unchanged by that move.
    expect(dashboardSubLine(source)).toBe('46% answer-ready · 44,000 indexed');
  });

  // Owner ruling, 2026-08-23/24, superseding the 2026-08-21 phrasing guard: the
  // exclusion count must not sit beside the percentage anywhere, this card
  // included. It lives on the detail page's foot now — one click away, read as
  // the footnote it is rather than as a competing headline.
  test('a working source keeps the exclusion count off its sub-line', () => {
    const source = card({
      connection: { state: 'syncing', label: 'syncing' },
      coverage: {
        indexed_items: 126_000,
        content_ready_items: 59_000,
        not_read_by_policy_items: 67_000,
      },
      ingestion_health: { coverage_percent: 100 },
      queue_health: { label: 'Working now', waiting: 10, active: 1 },
      answer_readiness: { state: 'syncing', label: 'Syncing now' },
    });
    // Every file in scope is read, so the bare 100 is the truth here.
    expect(dashboardSubLine(source)).toBe('100% answer-ready · 126,000 indexed');
    expect(dashboardSubLine(source)).not.toContain('not read by policy');
    expect(dashboardSubLine(source)).not.toContain('67,000');
  });

  test('the sub-line divides by the published eligible count, not indexed minus excluded', () => {
    // The connector store has drained 126,437 of the legacy index's 262,144
    // scored files, so indexed minus excluded is negative here. The card must
    // use the denominator the ladder counted inside its own population.
    const source = card({
      connection: { state: 'syncing', label: 'syncing' },
      coverage: {
        indexed_items: 126_437,
        content_ready_items: 23_294,
        not_read_by_policy_items: 235_560,
        answer_ready_eligible_items: 26_584,
      },
      ingestion_health: { coverage_percent: 87.6 },
      queue_health: { label: 'Working now', waiting: 10, active: 1 },
      answer_readiness: { state: 'syncing', label: 'Syncing now' },
    });

    expect(dashboardSubLine(source)).toBe('88% answer-ready · 126,437 indexed');
    // The published eligible count is still the denominator — 88, not the 18
    // that dividing by everything stored would give.
    expect(dashboardSubLine(source)).not.toContain('235,560');
  });

  // What the old "100% never stands alone" pairing defended is still defended,
  // by a stricter rule than the clause it replaced. Excluded files no longer
  // qualify the number — they are not in the denominator and are not this
  // card's subject — but an in-scope GAP still refuses a bare 100.
  test('a bare 100% is allowed only when the corpus is genuinely finished', () => {
    const source = card({
      connection: { state: 'syncing', label: 'syncing' },
      coverage: {
        indexed_items: 262_144,
        content_ready_items: 26_584,
        not_read_by_policy_items: 235_560,
        answer_ready_eligible_items: 26_584,
      },
      ingestion_health: { coverage_percent: 100 },
      queue_health: { label: 'Working now', waiting: 0, active: 1 },
      answer_readiness: { state: 'syncing', label: 'Syncing now' },
    });

    // Every one of the 26,584 in-scope files is read and nothing waits to
    // embed, so 100 is simply true and needs no chaperone.
    expect(dashboardSubLine(source)).toBe('100% answer-ready · 262,144 indexed');
    expect(dashboardSubLine(source)).not.toContain('235,560');
  });

  test('a re-embed backlog refuses the bare 100 the old clause would have allowed', () => {
    const source = card({
      connection: { state: 'syncing', label: 'syncing' },
      coverage: {
        indexed_items: 262_144,
        content_ready_items: 26_584,
        not_read_by_policy_items: 235_560,
        answer_ready_eligible_items: 26_584,
      },
      ingestion_health: { coverage_percent: 100 },
      queue_health: { label: 'Working now', waiting: 0, active: 1 },
      answer_readiness: { state: 'syncing', label: 'Syncing now' },
      embedding_backlog: { chunks: 100_000, embedded_chunks: 31_000, missing_chunks: 69_000, refresh_needed: true },
    });

    // Text is fully extracted, so the first number really is 100 — but nothing
    // can be answered from two thirds of it yet. The second number is what the
    // old exclusion clause never said.
    expect(dashboardSubLine(source)).toBe('100% answer-ready · 31% searchable · 262,144 indexed');
  });

  test('a source the policy reads none of says so instead of claiming a ratio', () => {
    const source = card({
      connection: { state: 'syncing', label: 'syncing' },
      coverage: {
        indexed_items: 500,
        content_ready_items: 0,
        embedded_items: 0,
        not_read_by_policy_items: 500,
      },
      ingestion_health: { coverage_percent: 100 },
      queue_health: { label: 'Working now', waiting: 0, active: 1 },
      answer_readiness: { state: 'syncing', label: 'Syncing now' },
    });
    expect(dashboardSubLine(source)).toBe('none of these files are read by policy · 500 indexed');
  });

  test('a source with no policy-deferred files says nothing about policy', () => {
    const source = card({
      connection: { state: 'syncing', label: 'syncing' },
      coverage: { indexed_items: 44_000, content_ready_items: 20_000 },
      ingestion_health: { coverage_percent: 45.5 },
      queue_health: { label: 'Working now', waiting: 800, active: 8 },
      answer_readiness: { state: 'syncing', label: 'Syncing now' },
    });
    expect(dashboardSubLine(source)).not.toContain('policy');
  });

  // A lane Olympus parked is calm, but it is not still syncing, and the detail
  // page already says so for the same marker.
  test('a fresh source Olympus parked says the sync is paused', () => {
    const source = card({
      schedule: { running: false, consecutive_failures: 3, degraded_reason: 'daily_cost_guard' },
    });
    expect(dashboardStatus({ source })).toBe('Fresh');
    expect(dashboardSubLine(source)).toBe('synced 12m ago · sync paused');
  });

  test('a fresh source under a live scheduler claims no pause', () => {
    expect(dashboardSubLine(card({ schedule: { running: true, consecutive_failures: 0 } })))
      .toBe('synced 12m ago');
  });

  test('a first ingest leads with the phase and carries the ETA that exists', () => {
    const source = card({
      connection: { state: 'syncing', label: 'syncing' },
      freshness: { hours: undefined, label: 'Waiting for the first sync' },
      coverage: { indexed_items: 4_812, content_ready_items: 400 },
      ingestion_health: { coverage_percent: 8.3 },
      queue_health: { label: 'Working now', waiting: 200, active: 4 },
      answer_readiness: { state: 'syncing', label: 'Syncing now' },
      progress: { indexed_items_per_hour: 312, eta_minutes: 38 },
    });
    // Was: "`first ingest` still leads". Owner ruling, 2026-08-24 design
    // session — the home card LEADS with the working percentage, because that
    // is the one thing a grid of cards is scanned for. The phase clause keeps
    // its place directly after it, still qualifying the ratio before anyone
    // acts on it, which is everything the old ordering was defending.
    // `first ingest` is a phase, not a competing number, and a
    // card in its first pass should say so before quoting a ratio about to move.
    expect(dashboardSubLine(source)).toBe('8% answer-ready · first ingest · 4,812 indexed · ~38m left');
  });

  test('a source with nothing indexed draws no donut and claims no ratio', () => {
    const source = card({
      connection: { state: 'syncing', label: 'syncing' },
      coverage: { indexed_items: 0, content_ready_items: 0 },
      ingestion_health: { coverage_percent: 100 },
    });
    expect(dashboardWorkFraction(source)).toBeUndefined();
    expect(dashboardSubLine(source)).toBe('');
  });

  test('a source waiting for its first sync says exactly that', () => {
    const source = card({
      connection: { state: 'waiting_for_first_sync', label: 'connected, waiting for first sync' },
    });
    expect(dashboardSubLine(source)).toBe('waiting for the first sync');
  });

  test('an unconnected source with no data repeats the connection label and nothing more', () => {
    const empty = { indexed_items: 0, content_ready_items: 0, embedded_items: 0, needs_review_items: 0 };
    expect(dashboardSubLine(card({
      configured: false,
      coverage: empty,
      connection: { state: 'not_connected', label: 'not connected' },
    }))).toBe('not connected');
    // A source that needs an app key first carries the same label as any other
    // unconnected one; what it additionally needs is the setup row's blurb.
    expect(dashboardSubLine(card({
      configured: false,
      coverage: empty,
      connection: { state: 'needs_setup', label: 'not connected' },
    }))).toBe('not connected');
  });

  // Owner note, 2026-09-01: "not connected — Set up" on a source holding 4,000
  // files read as a demand to set up something already set up. A source that
  // HAS data and reads not-connected has lost a connection it once had.
  test('a data-bearing unconnected source says the connection was lost', () => {
    expect(dashboardSubLine(card({
      configured: false,
      connection: { state: 'not_connected', label: 'not connected' },
    }))).toBe('connection lost · reauthenticate to resume syncing');
    expect(dashboardSubLine(card({
      configured: false,
      connection: { state: 'needs_setup', label: 'not connected' },
    }))).toBe('connection lost · reauthenticate to resume syncing');
  });
});

describe('attention lines', () => {
  test('name the credential failure and its retry state', () => {
    const source = card({ label: 'Dropbox', provider: 'dropbox', source_id: 'dropbox.files' });
    expect(dashboardAttentionLine(source, {
      degradedCredentials: [degradation({ display_name: 'Dropbox', state: 'retrying', attempts: 2, max_attempts: 3 })],
    })).toBe('credential unavailable · retrying (2 of 3)');
    expect(dashboardAttentionLine(source, {
      degradedCredentials: [degradation({ display_name: 'Dropbox', state: 'stopped' })],
    })).toBe('credential unavailable · retries stopped');
    expect(dashboardAttentionLine(source, {
      degradedCredentials: [degradation({ display_name: 'Dropbox', state: 'resolved_restart_required' })],
    })).toBe('credential unavailable · resolved · restart required');
  });

  test('point a pending consent at the tab it is waiting on', () => {
    const source = card({
      label: 'Dropbox',
      connection: {
        state: 'awaiting_consent',
        label: 'awaiting browser consent',
        pending: {
          started_at: '2026-07-02T11:55:00.000Z',
          expires_at: '2026-07-02T12:09:00.000Z',
          expires_in_minutes: 9,
        },
      },
    });
    expect(dashboardAttentionLine(source))
      .toBe('waiting for you to approve in the Dropbox tab · expires in 9m');
  });

  test('drop the expiry clause once the attempt has run out', () => {
    const source = card({
      label: 'Dropbox',
      connection: {
        state: 'awaiting_consent',
        label: 'awaiting browser consent',
        pending: {
          started_at: '2026-07-02T11:45:00.000Z',
          expires_at: '2026-07-02T11:59:00.000Z',
          expires_in_minutes: 0,
        },
      },
    });
    expect(dashboardAttentionLine(source)).toBe('waiting for you to approve in the Dropbox tab');
  });

  test('say reauth required rather than restating the readiness sentence', () => {
    const source = card({
      connection: { state: 'reauth_required', label: 'reauth required' },
      answer_readiness: { state: 'needs_attention', label: 'Reauthenticate this source' },
    });
    expect(dashboardAttentionLine(source)).toBe('reauth required');
  });

  test('carry the machine failure the readiness label names', () => {
    const source = card({ answer_readiness: { state: 'needs_attention', label: 'Content extraction is stalled' } });
    expect(dashboardAttentionLine(source)).toBe('content extraction is stalled');
  });

  // Was: "count the stuck work when nothing names a cause", pinning "3 items
  // need attention · 1 task retrying". Owner ruling, 2026-08-24 — no error
  // counts anywhere. The row still names its state; it no longer sizes a fault
  // the reader cannot act on.
  test('name the stuck work without counting it when nothing names a cause', () => {
    const source = card({ queue_health: { label: 'Needs attention', needs_attention: 3, retrying_tasks: 1 } });
    expect(dashboardAttentionLine(source)).toBe('some work is stuck part-way through');
  });

  test('name a retrying task as the self-healing thing it is, with no count', () => {
    const source = card({ queue_health: { label: 'Needs attention', needs_attention: 0, retrying_tasks: 2 } });
    expect(dashboardAttentionLine(source)).toBe('a sync task is retrying itself');
  });

  test('stay empty rather than invent a cause', () => {
    expect(dashboardAttentionLine(card())).toBe('');
  });
});

describe('page-level lines', () => {
  test('the home meta dates the page and counts nothing', () => {
    const view = viewOf([card({ source_id: 'a.one' }), card({ source_id: 'b.two' })]);
    view.generated_at = '2026-07-02T11:59:48.000Z';
    expect(dashboardHomeMeta(view, { now: NOW })).toBe('checked 12s ago');
    // A bad stamp leaves nothing to say, and nothing is what renders.
    view.generated_at = 'not-a-timestamp';
    expect(dashboardHomeMeta(view, { now: NOW })).toBe('');
  });

  test('the checked label refuses an unparseable stamp', () => {
    expect(dashboardCheckedLabel('2026-07-02T11:59:48.000Z', NOW)).toBe('checked 12s ago');
    expect(dashboardCheckedLabel('', NOW)).toBe('');
  });

  // Owner ruling 2026-08-19 evening: the connected-count arithmetic is gone
  // from both meta lines. The groups already say what needs attention; home
  // keeps only the staleness fact, and setup says nothing at all.
  test('the meta lines carry no connected counts', () => {
    const sources = ['gmail.email', 'google_drive.docs', 'dropbox.files']
      .map((sourceId) => card({ source_id: sourceId }));
    sources.push(card({
      source_id: 'readwise.library',
      label: 'Readwise',
      provider: 'readwise',
      connection: { state: 'reauth_required', label: 'reauth required' },
      answer_readiness: { state: 'needs_attention', label: 'Reauthenticate this source' },
    }));
    const view = viewOf(sources);

    expect(dashboardSetupMeta(view)).toBe('');
    const home = dashboardHomeMeta(view, { now: NOW });
    expect(home).toContain('checked');
    expect(home).not.toContain('connected');
    expect(home).not.toContain(' of ');
  });

  test('first run is nothing connected, by either reading', () => {
    const connected = viewOf([card({ configured: true })]);
    connected.summary.connected_sources = 1;
    expect(dashboardIsFirstRun(connected)).toBe(false);

    const none = viewOf([card({ configured: false })]);
    expect(dashboardIsFirstRun(none)).toBe(true);

    const countedButUnconfigured = viewOf([card({ configured: false })]);
    countedButUnconfigured.summary.connected_sources = 1;
    expect(dashboardIsFirstRun(countedButUnconfigured)).toBe(true);
  });

  test('the background line reports queue depth and held drains only', () => {
    const view = viewOf([
      card({ queue_health: { waiting: 800, active: 8, needs_attention: 3, retrying_tasks: 1 } }),
      card({ source_id: 'b.two', ingestion_health: { drain_state: 'held' } }),
    ]);
    expect(dashboardBackgroundLine(view))
      .toBe('Background: 808 items queued · 3 needing attention · 1 task retrying · ingestion paused on 1 source');
  });

  test('the background line says nothing when nothing is running', () => {
    expect(dashboardBackgroundLine(viewOf([card()]))).toBeUndefined();
  });

  test('finds a card by source id', () => {
    const view = viewOf([card({ source_id: 'gmail.email' }), card({ source_id: 'dropbox.files' })]);
    expect(dashboardSourceById(view, 'dropbox.files')?.source_id).toBe('dropbox.files');
    expect(dashboardSourceById(view, 'nothing.here')).toBeUndefined();
  });
});

describe('against the real view model', () => {
  test('every card the worker builds maps to a known status word', () => {
    const view = buildRealView();
    expect(view.sources.length).toBeGreaterThan(0);
    expect(dashboardMappedUnknownCount(view)).toBe(0);
    for (const source of view.sources) {
      expect(DASHBOARD_STATUS_ORDER).toContain(dashboardStatus({ source }));
    }
  });

  test('a connected, working source reads Working and an unconfigured one reads Off', () => {
    const view = buildRealView();
    const dropbox = dashboardSourceById(view, 'dropbox.files');
    expect(dropbox?.connection.state).toBe('syncing');
    expect(dashboardStatus({ source: dropbox! })).toBe('Working');

    const readwise = dashboardSourceById(view, 'readwise.library');
    expect(readwise?.configured).toBe(false);
    expect(dashboardStatus({ source: readwise! })).toBe('Off');
  });

  test('the home meta reads off a real generated_at', () => {
    const view = buildRealView();
    expect(dashboardHomeMeta(view, { now: new Date('2026-07-02T12:00:12.000Z') }))
      .toBe('checked 12s ago');
  });

  test('every queue-health branch the worker writes maps without an unknown fallback', () => {
    // queue_health.label is a plain string on the view model, so the literal
    // union here has no compile-time link to the worker. Driving all four
    // aggregate branches through the real builder is what catches a renamed
    // worker literal before it silently falls back to Waiting.
    const branches: Array<[Record<string, number>, DashboardQueueHealthLabel]> = [
      [{ extraction_jobs_failed_actionable: 3, extraction_jobs_failed: 3 }, 'Needs attention'],
      [{}, 'Working now'],
      [
        { extraction_jobs_leased_current: 0, extraction_jobs_leased_current_actionable: 0 },
        'Waiting to catch up',
      ],
      [
        {
          extraction_jobs_queued: 0,
          extraction_jobs_queued_actionable: 0,
          extraction_jobs_leased_current: 0,
          extraction_jobs_leased_current_actionable: 0,
        },
        'Caught up',
      ],
    ];
    for (const [counts, expected] of branches) {
      const view = buildRealView(counts);
      const dropbox = dashboardSourceById(view, 'dropbox.files');
      expect(dropbox?.queue_health.label).toBe(expected);
      expect(Object.keys(DASHBOARD_QUEUE_HEALTH_STATUS)).toContain(dropbox?.queue_health.label ?? '');
      expect(dashboardMappedUnknownCount(view)).toBe(0);
    }
  });
});

function buildRealView(countOverrides: Record<string, number> = {}): SourceDashboardViewModel {
  return buildSourceDashboardViewModel({
    sourceIndexStatus: {
      kind: 'source_index_status',
      generated_at: '2026-07-02T12:00:00.000Z',
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
          files: 44_000,
          folders: 0,
          secure_local_chunks: 300_000,
          qa_pass: 20_000,
          embedded_chunks: 0,
          extraction_jobs_queued: 800,
          extraction_jobs_queued_actionable: 800,
          extraction_jobs_leased_current: 8,
          extraction_jobs_leased_current_actionable: 8,
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
    sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
      OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
      OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
    })),
    connectedHandleRegistry: dropboxHandleRegistry(),
    now: NOW,
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
      connectedAt: '2026-07-02T10:00:00.000Z',
    }],
  };
}

interface CardOverrides {
  source_id?: string;
  label?: string;
  provider?: string;
  configured?: boolean;
  // hours is spelled out rather than taken from Partial<> so a test can hand it
  // an explicit undefined — the card of a source whose last check was never
  // dated is a real shape, and it is the one the sub-line has to stay quiet on.
  freshness?: { label?: string; hours?: number | undefined; threshold_hours?: number; stale?: boolean };
  coverage?: Partial<DashboardSourceCard['coverage']>;
  ingestion_health?: Partial<DashboardSourceCard['ingestion_health']>;
  queue_health?: Partial<DashboardSourceCard['queue_health']>;
  answer_readiness?: Partial<DashboardSourceCard['answer_readiness']>;
  connection?: Partial<DashboardSourceCard['connection']>;
  progress?: DashboardSourceCard['progress'];
  schedule?: DashboardSourceCard['schedule'];
  embedding_backlog?: DashboardSourceCard['embedding_backlog'];
}

describe('dashboard working summary', () => {
  test('divides by the files Olympus is supposed to handle, not by everything stored', () => {
    // The live Dropbox shape: a quarter-million files stored, a fraction of
    // them in content scope. The denominator is the in-scope population.
    const summary = dashboardWorkingSummary(card({
      coverage: {
        indexed_items: 247_712,
        content_ready_items: 12_431,
        embedded_items: 0,
        needs_review_items: 0,
        not_read_by_policy_items: 234_900,
        answer_ready_eligible_items: 12_812,
      },
    }));

    expect(summary?.in_scope_items).toBe(12_812);
    expect(summary?.read_items).toBe(12_431);
    expect(summary?.read_percent).toBe(97);
    expect(summary?.fully_working).toBe(false);
  });

  test('carries no exclusion count of any kind', () => {
    const summary = dashboardWorkingSummary(card({
      coverage: {
        indexed_items: 247_712,
        content_ready_items: 12_431,
        embedded_items: 0,
        needs_review_items: 0,
        not_read_by_policy_items: 234_900,
        answer_ready_eligible_items: 12_812,
      },
    }));

    // Owner ruling, 2026-08-24: what has been excluded is not part of this
    // number and does not travel with it.
    expect(JSON.stringify(summary)).not.toContain('234900');
    expect(JSON.stringify(summary)).not.toContain('not_read');
  });

  test('reports two numbers rather than one fake one while chunks await re-embed', () => {
    const summary = dashboardWorkingSummary(card({
      coverage: {
        indexed_items: 12_812,
        content_ready_items: 12_431,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 12_812,
      },
      embedding_backlog: { chunks: 100_000, embedded_chunks: 12_000, missing_chunks: 88_000, refresh_needed: true },
    }));

    expect(summary?.searchable_percent).toBe(12);
    expect(summary?.fully_working).toBe(false);
    expect(dashboardWorkingHeadline(summary!))
      .toBe('97% of text extracted · 12% searchable until re-embed completes');
  });

  test('says everything is working only when extraction and parity are both done', () => {
    const summary = dashboardWorkingSummary(card({
      coverage: {
        indexed_items: 12_812,
        content_ready_items: 12_812,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 12_812,
      },
      embedding_backlog: { chunks: 100_000, embedded_chunks: 100_000, missing_chunks: 0, refresh_needed: false },
    }));

    expect(summary?.fully_working).toBe(true);
    expect(dashboardWorkingHeadline(summary!)).toBe('everything in scope is working — 12,812 files');
  });

  test('refuses a bare hundred while anything in scope still waits to embed', () => {
    const summary = dashboardWorkingSummary(card({
      coverage: {
        indexed_items: 12_812,
        content_ready_items: 12_812,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 12_812,
      },
      embedding_backlog: { chunks: 100_000, embedded_chunks: 40_000, missing_chunks: 60_000, refresh_needed: true },
    }));

    // Every file is read, so the extraction half really is 100 — but the corpus
    // is not answerable yet, and one number would say it was.
    expect(summary?.fully_working).toBe(false);
    expect(dashboardWorkingHeadline(summary!))
      .toBe('100% of text extracted · 40% searchable until re-embed completes');
  });

  test('gives no summary at all for a card with nothing in scope', () => {
    expect(dashboardWorkingSummary(card({
      coverage: {
        indexed_items: 4_000,
        content_ready_items: 0,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 0,
      },
    }))).toBeUndefined();
  });
});

// A synced, caught-up, answer-ready card — the shape every test starts from and
// perturbs one field of.
function card(overrides: CardOverrides = {}): DashboardSourceCard {
  return {
    corpus_id: 'internal.email',
    source_id: overrides.source_id ?? 'gmail.email',
    label: overrides.label ?? 'Gmail',
    provider: overrides.provider ?? 'gmail',
    family: 'email',
    trust_domain: 'secure_local',
    configured: overrides.configured ?? true,
    freshness: freshnessOf(overrides.freshness),
    coverage: {
      indexed_items: 100,
      content_ready_items: 100,
      embedded_items: 200,
      needs_review_items: 0,
      ...overrides.coverage,
    },
    ingestion_health: {
      coverage_percent: 100,
      stuck_count: 0,
      drain_state: 'enabled',
      label: '100% covered; no stuck work',
      ...overrides.ingestion_health,
    },
    tier_composition: [],
    queue_health: {
      label: 'Caught up',
      waiting: 0,
      active: 0,
      needs_attention: 0,
      ...overrides.queue_health,
    },
    answer_readiness: { state: 'ready', label: 'Ready for questions', ...overrides.answer_readiness },
    connection: {
      state: 'synced',
      label: 'synced less than 1 hour ago',
      action: { kind: 'none' },
      handles: [],
      ...overrides.connection,
    },
    ...(overrides.progress ? { progress: overrides.progress } : {}),
    ...(overrides.schedule ? { schedule: overrides.schedule } : {}),
    ...(overrides.embedding_backlog ? { embedding_backlog: overrides.embedding_backlog } : {}),
  };
}

function freshnessOf(overrides: CardOverrides['freshness']): DashboardSourceCard['freshness'] {
  const hours = overrides && 'hours' in overrides ? overrides.hours : 0.2;
  return {
    label: overrides?.label ?? 'Last checked less than 1 hour ago',
    stale: overrides?.stale ?? false,
    ...(hours !== undefined ? { hours } : {}),
    ...(overrides?.threshold_hours !== undefined ? { threshold_hours: overrides.threshold_hours } : {}),
  };
}

function viewOf(sources: DashboardSourceCard[]): SourceDashboardViewModel {
  return {
    kind: 'source_dashboard',
    generated_at: NOW.toISOString(),
    summary: {
      configured_sources: sources.length,
      connected_sources: sources.filter((source) => source.configured).length,
      answer_ready_sources: 0,
      needs_attention_sources: 0,
      total_indexed_items: 0,
      total_content_ready_items: 0,
    },
    onboarding: {
      steps: [{ id: 'connect_sources', label: 'Connect your sources', state: 'active' }],
      ask_first_question: { enabled: false, label: 'Ask your first question', suggestion: 'What do you see?' },
    },
    answer_lanes: [],
    where_your_data_lives: [],
    unassigned_corpora: { corpus_count: 0, indexed_items: 0, content_ready_items: 0, entries: [] },
    excluded_by_configuration: { rules: 0, prefixes: 0, items_present: 0, items_unevaluable: 0, entries: [] },
    folder_picker: { available: false, label: 'Choose folders', path: '/dashboard/dispositions', rules: 0 },
    sources,
    history: { sample_count: 0, eta_available: false },
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      file_names_returned: false,
      file_paths_returned: false,
      host_names_returned: false,
    },
  };
}

function answerLane(state: 'validated' | 'missing'): Parameters<typeof dashboardAnswerLaneStatus>[0] {
  return {
    lane_id: 'venice-secure-answers',
    source_id: 'venice.api',
    label: 'Venice',
    role: 'Secure answers',
    connection: {
      state,
      label: state,
      action: { kind: 'none' },
      handles: [],
    },
  };
}

function degradation(overrides: Partial<WorkerCredentialDegradation> = {}): WorkerCredentialDegradation {
  return {
    kind: 'worker_credential_degraded',
    display_name: 'Dropbox',
    state: 'retrying',
    status_label: 'Credential unavailable - needs your attention',
    hint: 'Unlock or reconnect this credential, then restart the Olympus worker.',
    attempts: 2,
    max_attempts: 3,
    ...overrides,
  };
}

// Keeps the status union referenced from the test file, so a rename of the
// exported type breaks here rather than silently widening.
const _statusUnionIsUsed: DashboardStatus = 'Fresh';
void _statusUnionIsUsed;

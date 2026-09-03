import { describe, expect, test } from 'bun:test';
import {
  renderDashboardDetailBody,
  renderDashboardDetailPage,
} from '../src/workers/dashboard/pages/detail.ts';
import type {
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';
import type { WorkerCredentialDegradation } from '../src/workers/credential-degradation.ts';
import { OPERATOR_PAUSED_SCHEDULER_MARKERS } from '../src/workers/dashboard/scheduler-markers.ts';
import { renderPublicSourceCapabilityForDashboard } from '../src/core/public-source-capabilities.ts';

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('dashboard detail selection summary', () => {
  test('shows only the two populations the user added to Olympus', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      ingestion_selection: { metadata_only_files: 2_000, full_ingestion_files: 10_000 },
    }), { now: NOW });

    expect(html).toContain('Added to Olympus');
    expect(html).toContain('<span>Metadata only</span><b>2,000 files</b>');
    expect(html).toContain('<span>Full ingestion</span><b>10,000 files</b>');
    expect(html).not.toContain('class="kpis"');
    expect(html).not.toContain('Text ready');
    expect(html).not.toContain('<div class="u">Flow</div>');
  });

  test('does not invent selection counts when the ledger has not reported them', () => {
    const html = renderDashboardDetailBody(fixtureCard(), { now: NOW });
    expect(html).not.toContain('Added to Olympus');
  });

  test('keeps mechanical failure evidence inside Advanced, never in summary cards', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      schedule: { running: false, consecutive_failures: 3, last_error_kind: 'provider_rate_limited' },
    }), { now: NOW });
    expect(html).not.toContain('class="kpis"');
    expect(html).toContain('[CONSECUTIVE_FAILURES] (3) == 0 — provider_rate_limited');
    expect(html.indexOf('[CONSECUTIVE_FAILURES]')).toBeGreaterThan(html.indexOf('<details class="advanced">'));
  });
});

/**
 * The persistent totals line (owner decision, 2026-09-02).
 *
 * The three bars describe the pass in flight; this line is the standing answer
 * to "what is in Olympus" and stays put when the bars come down.
 */
describe('dashboard detail totals', () => {
  test('states the three totals above the bars, in the source own noun', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      coverage: {
        indexed_items: 30_012,
        content_ready_items: 30_007,
        embedded_items: 0,
        embedded_files: 30_002,
        needs_review_items: 0,
        answer_ready_eligible_items: 30_012,
      },
    }), { now: NOW });

    expect(html).toContain('<div class="dsect">In Olympus</div>');
    expect(html).toContain('<span>Indexed</span><b>30,012 files</b>');
    expect(html).toContain('<span>Text extracted</span><b>30,007 files</b>');
    expect(html).toContain('<span>Embedded</span><b>30,002 files</b>');
    expect(html.indexOf('In Olympus')).toBeLessThan(html.indexOf('<div class="phase'));
  });

  test('counts a message source in messages, never in files', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      source_id: 'gmail.email',
      label: 'Gmail',
      provider: 'gmail',
      family: 'email',
      coverage: {
        indexed_items: 184_000,
        content_ready_items: 184_000,
        embedded_items: 0,
        embedded_files: 90_000,
        needs_review_items: 0,
        answer_ready_eligible_items: 184_000,
      },
    }), { now: NOW });

    expect(html).toContain('<span>Indexed</span><b>184,000 messages</b>');
    expect(html).toContain('<span>Embedded</span><b>90,000 messages</b>');
  });

  test('says an absent embedded count is not measured rather than printing a number', () => {
    const html = renderDashboardDetailBody(fixtureCard(), { now: NOW });

    expect(html).toContain('<span>Indexed</span><b>4,806 files</b>');
    expect(html).toContain('<span>Text extracted</span><b>3,201 files</b>');
    expect(html).toContain('<span>Embedded</span><b>not measured</b>');
    // 129,948 is this card's chunk count. It is not a file count and may never
    // stand in for one.
    expect(html).not.toContain('<b>129,948 files</b>');
  });

  test('keeps the totals line standing when the bars come down', () => {
    const html = renderDashboardDetailBody(settledCard(), { now: NOW });

    expect(html).toContain('<div class="dsect">In Olympus</div>');
    expect(html).toContain('<span>Indexed</span><b>12,812 files</b>');
    expect(html).toContain('Fully synced · watching for changes');
    expect(html.indexOf('In Olympus')).toBeLessThan(html.indexOf('<div class="dsect">Ingestion</div>'));
  });
});

describe('dashboard source capability ceiling', () => {
  test('exposes X BYO ownership, cost, contextual scope, and provider ceilings', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      source_id: 'x.bookmarks',
      label: 'X bookmarks',
      provider: 'x',
      family: 'x',
      trust_domain: 'internal',
      capabilities: renderPublicSourceCapabilityForDashboard('x.bookmarks'),
    }), { now: NOW });
    expect(html).toContain('Source capability');
    expect(html).toContain('user-owned X developer application and API plan');
    expect(html).toContain('bookmark folders retained as provenance');
    expect(html).toContain('Plan availability, cost, rate limits, pagination, and provider windows can prevent complete history.');
  });
});

describe('dashboard detail progress owns readiness', () => {
  test('keeps extraction and embedding truth in their own phase rows', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      coverage: {
        indexed_items: 12_812,
        content_ready_items: 12_431,
        embedded_items: 0,
        embedded_files: 1_491,
        needs_review_items: 0,
        answer_ready_eligible_items: 12_812,
      },
      embedding_backlog: { chunks: 100_000, embedded_chunks: 12_000, missing_chunks: 88_000, refresh_needed: true },
      active_ingestion_phase: 'extraction',
    }), { now: NOW });

    expect(html).not.toContain('class="kpis"');
    expect(html).toContain('97% · 12,431 of 12,812 files');
    // Embedding counts the same population in the same unit, so its row can be
    // read against extraction's directly: 11.6% of the corpus embedded, off the
    // store's own per-item count and never off the 100,000-chunk backlog.
    expect(html).toContain('11.6% · 1,491 of 12,812 files');
    expect(html).not.toContain('≈');
    expect(html).not.toContain('derived from chunk parity');
    // The stacked three-tone bar and its share vocabulary are gone.
    expect(html).not.toContain('extracted, waiting');
    expect(html).not.toContain('not extracted');
    expect(html).not.toContain('bar composition');
    expect(html).not.toContain('All of it');
  });

  test('puts the embedding lane movement beside its progress', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      coverage: {
        indexed_items: 100,
        content_ready_items: 50,
        embedded_items: 800,
        embedded_files: 40,
        needs_review_items: 0,
        answer_ready_eligible_items: 100,
      },
      embedding_backlog: { chunks: 1_000, embedded_chunks: 800, missing_chunks: 200, refresh_needed: true },
    }), {
      now: NOW,
      embeddingRuntime: {
        state: 'running',
        stateLine: 'Embeddings: running now (metadata caught up)',
        scheduleLine: 'runs whenever the guard admits it',
        overrideOn: false,
        override: 'none',
        overridePath: '/fixture/override',
      },
    });

    expect(html).toContain('40% · 40 of 100 files');
    // The lane says it is draining right now, so the row says the one word the
    // reader needs from a bar that is not full: it is moving.
    expect(html).toMatch(/Embedding[\s\S]{0,200}data-phase-state="working"/);
    expect(html).toContain('class="phase working"');
  });

  // The rows are never omitted and never borrow each other's state: a
  // downstream row with nothing in front of it yet names what it is waiting on
  // (owner ruling, 2026-09-01), while the lane that reports itself live works.
  test('keeps downstream phases waiting on the phase in front of them', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      coverage: {
        indexed_items: 0,
        content_ready_items: 0,
        embedded_items: 0,
        embedded_files: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 100,
      },
      metadata_sync: {
        folders_total: 100,
        folders_visited: 0,
        folders_pending: 100,
        folders_failed: 0,
        folders_blocked: 0,
      },
      active_ingestion_phase: 'metadata_sync',
    }), { now: NOW });

    expect(html).toMatch(/class="phase working">[\s\S]{0,300}Metadata sync/);
    expect(html).toMatch(/Extraction[\s\S]{0,200}data-phase-state="waiting">Waiting for metadata sync</);
    expect(html).toMatch(/Embedding[\s\S]{0,200}data-phase-state="waiting">Waiting for extraction</);
    // The old sequential display invented these classes; the state word owns
    // this now and there is no 'active' or 'pending' phase left.
    expect(html).not.toContain('class="phase pending"');
    expect(html).not.toContain('class="phase active"');
  });

  test('keeps excluded/no-ingestion files out of the user-added summary', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      ingestion_selection: { metadata_only_files: 381, full_ingestion_files: 12_431 },
      coverage: {
        indexed_items: 247_712,
        content_ready_items: 12_431,
        embedded_items: 0,
        needs_review_items: 0,
        not_read_by_policy_items: 234_900,
        answer_ready_eligible_items: 12_812,
      },
    }), { now: NOW });

    // Scoped to the selection block: the metadata-sync row legitimately prints
    // the indexed total in the file noun further down the page, and this test
    // is about what the "Added to Olympus" card claims the user chose.
    const start = html.indexOf('Added to Olympus');
    const selection = html.slice(start, html.indexOf('<div class="dsect">', start + 1));
    expect(start).toBeGreaterThan(-1);
    expect(selection).toContain('<span>Metadata only</span><b>381 files</b>');
    expect(selection).toContain('<span>Full ingestion</span><b>12,431 files</b>');
    expect(selection).not.toContain('247,712');
  });
});

describe('dashboard detail runs', () => {
  test('draws one bar per known run and captions the next scheduled one', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      last_run: {
        status: 'completed',
        started_at: '2026-07-02T09:55:56.000Z',
        completed_at: '2026-07-02T09:58:06.000Z',
        duration_seconds: 130,
        items_seen: 480,
        items_indexed: 12,
      },
      schedule: { running: false, consecutive_failures: 0, next_run_at: '2026-07-02T12:05:00.000Z' },
    }), { now: NOW });

    expect(html).toContain('<div class="dsect">Last run</div>');
    // The view model holds one refresh, never a series, so the heading never
    // promises twenty.
    expect(html).not.toContain('Last 20 runs');
    expect(countOccurrences(html, '<i style="background:')).toBe(1);
    expect(html).toContain('<i style="background:var(--good)"></i>');
    expect(html).toContain('next in 5m');
    expect(html).toContain('<th>When</th><th>Result</th><th>Took</th><th>Indexed</th><th>Seen</th>');
    expect(html).toContain('<td>2h ago</td>');
    // Designed copy, not the raw enum leaking through.
    expect(html).toContain('>✓ Completed</td>');
    expect(html).not.toContain('>completed</td>');
    expect(html).toContain('<td>2m 10s</td>');
    expect(html).toContain('<td>12</td><td>480</td>');
  });

  test('colors a failed run and explains it in the tip', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      last_run: {
        status: 'failed',
        started_at: '2026-07-02T11:59:32.000Z',
        completed_at: '2026-07-02T12:00:00.000Z',
        duration_seconds: 28,
        items_seen: 480,
        items_indexed: 0,
      },
      schedule: { running: false, consecutive_failures: 2, last_error_kind: 'provider_timeout' },
    }), { now: NOW });

    expect(html).toContain('<i style="background:var(--bad)"></i>');
    expect(html).toContain('>✕ Failed</td>');
    expect(html).toContain('class="tip"');
    expect(html).toContain('[LAST_RUN] (failed) == completed — 0 of 480 items indexed');
    expect(html).toContain('[CONSECUTIVE_FAILURES] (2) == 0 — provider_timeout');
  });

  test('renders a run with no recorded duration as unknown, never as zero', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      last_run: { status: 'running', items_seen: 120, items_indexed: 4 },
    }), { now: NOW });

    expect(html).toContain('<td>time not recorded</td>');
    expect(html).toContain('<td>—</td>');
    expect(html).not.toContain('<td>0s</td>');
  });

  test('renders no run section at all when the card carries no run', () => {
    const html = renderDashboardDetailBody(fixtureCard(), { now: NOW });

    expect(html).not.toContain('bigstrip');
    expect(html).not.toContain('stripcap');
    expect(html).not.toContain('Last run');
    expect(html).not.toContain('<th>When</th>');
  });
});

describe('dashboard detail omissions', () => {
  test('renders no activity feed and no twenty-run promise', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      last_run: { status: 'completed', completed_at: '2026-07-02T11:00:00.000Z', items_seen: 4, items_indexed: 4 },
      queue_health: { label: 'Needs attention', waiting: 4, active: 0, needs_attention: 2 },
    }), { now: NOW });

    expect(html).not.toContain('class="feed"');
    expect(html).not.toContain('Activity');
    expect(html).not.toContain('Last 20 runs');
    expect(html).not.toContain('Run history');
  });

  test('states no cause when the card carries no prose for one', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      connection: {
        state: 'reauth_required',
        label: 'reauth required',
        action: { kind: 'none' },
        handles: [],
      },
    }), { now: NOW });

    expect(html).toContain('[CONNECTION]');
    expect(html).toContain('(reauth required)');
    expect(html).not.toContain('(reauth required) == connected —');
  });
});

describe('dashboard detail verdict tip', () => {
  test('stays silent while every check passes', () => {
    const html = renderDashboardDetailBody(fixtureCard(), { now: NOW });
    expect(html).not.toContain('class="tip"');
    expect(html).not.toContain('Why this needs attention');
  });

  test('stays silent on a plainly syncing source', () => {
    // 'syncing' is ordinary transit: the tip must not turn the loudest element
    // on the page into background noise on the most common healthy state.
    const html = renderDashboardDetailBody(fixtureCard({
      connection: { state: 'syncing', label: 'syncing', action: { kind: 'none' }, handles: [] },
      answer_readiness: { state: 'syncing', label: 'Syncing now' },
      queue_health: { label: 'Working now', waiting: 40, active: 4, needs_attention: 0 },
    }), { now: NOW });

    expect(html).not.toContain('class="tip"');
    expect(html).not.toContain('[ANSWER_LANE]');
  });

  test('stays silent on a card waiting for its first sync', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      connection: {
        state: 'waiting_for_first_sync',
        label: 'connected, waiting for first sync',
        action: { kind: 'none' },
        handles: [],
      },
      answer_readiness: { state: 'empty', label: 'Waiting for the first sync' },
      coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0, needs_review_items: 0 },
    }), { now: NOW });

    expect(html).not.toContain('class="tip"');
  });

  test('explains a failure with claim, observed value and plain cause', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      connection: {
        state: 'reauth_required',
        label: 'reauth required',
        action: { kind: 'oauth', source: 'dropbox', label: 'Reauthenticate' },
        handles: ['dropbox.personal'],
      },
      answer_readiness: { state: 'needs_attention', label: 'Reauthenticate this source' },
    }), {
      now: NOW,
      degradedCredentials: [fixtureDegradation()],
    });

    expect(html).toContain('class="tip"');
    expect(html).toContain('<span class="no">✗</span> [CONNECTION] (reauth required) == connected — Reauthenticate');
    expect(html).toContain('[ANSWER_LANE] (needs_attention) != needs_attention, != disconnected — Reauthenticate this source');
    expect(html).toContain('[CREDENTIAL] (retrying, attempt 2 of 3) == available');
    expect(html).toContain('retry in 5m');
    // Passing checks stay on the tip, as the mockup shows them.
    expect(html).toContain('<span class="ok">✓</span> [QUEUE_ATTENTION] (0) == 0');
  });

  test('repeats the ledger attention reasons verbatim', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      attention_reasons: ['scheduler paused', 'email.sync failing: provider_rate_limited'],
    }), { now: NOW });

    expect(html).toContain('[LEDGER] (scheduler paused)');
    expect(html).toContain('[LEDGER] (email.sync failing: provider_rate_limited)');
  });

  test('reports a stalled extraction from the ingestion prose it actually has', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      ingestion_health: {
        coverage_percent: 87.4,
        stuck_count: 12,
        oldest_stuck_age_hours: 3.1,
        drain_state: 'held',
        drain_unit: 'olympus-source-processing-supervisor-vlm-pdf.timer',
        label: '87.4% covered; 12 stuck; oldest 3.1h; content extraction stalled for 26h',
      },
    }), { now: NOW });

    expect(html).toContain('[STUCK_ITEMS] (12) == 0 — 87.4% covered; 12 stuck');
    expect(html).toContain('[EXTRACTION_DRAIN] (held) == enabled — olympus-source-processing-supervisor-vlm-pdf.timer');
  });

  test('escapes the comparison operator and any markup in a card label', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      freshness: { label: '<script>alert(1)</script>', hours: 9.4, threshold_hours: 6, stale: true },
    }), { now: NOW });

    expect(html).toContain('&lt;= 6h');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

describe('dashboard detail masking', () => {
  test('masks a token-shaped value that reaches a prose field', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      connection: { state: 'reauth_required', label: 'reauth required', action: { kind: 'none' }, handles: [] },
    }), {
      now: NOW,
      degradedCredentials: [fixtureDegradation({
        hint: 'Unlock the credential (dash_9f2c41ab77de65b0aa) then restart the worker.',
      })],
    });

    expect(html).toContain('[REDACTED]');
    expect(html).not.toContain('dash_9f2c41ab77de65b0aa');
  });

  test('passes already-masked text through untouched', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      connection: { state: 'reauth_required', label: 'reauth required', action: { kind: 'none' }, handles: [] },
    }), {
      now: NOW,
      degradedCredentials: [fixtureDegradation({
        hint: 'Reauthenticate the lane · token [REDACTED] · then restart the worker.',
      })],
    });

    expect(html).toContain('Reauthenticate the lane · token [REDACTED] · then restart the worker.');
  });

  test('matches a credential lane to its card by name, and not to another card', () => {
    const html = renderDashboardDetailBody(fixtureCard(), {
      now: NOW,
      degradedCredentials: [fixtureDegradation({ display_name: 'Readwise' })],
    });

    expect(html).not.toContain('[CREDENTIAL]');
  });

  test('masks a token-shaped value that reaches the foot line', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      ingestion_health: {
        coverage_percent: 100,
        stuck_count: 0,
        drain_state: 'enabled',
        label: '100% covered; drain key dash_9f2c41ab77de65b0aa recorded',
      },
    }), { now: NOW });

    const foot = html.slice(html.indexOf('class="foot"'));
    expect(foot).toContain('[REDACTED]');
    expect(html).not.toContain('dash_9f2c41ab77de65b0aa');
  });

  test('masks an authorization header and a long base64 blob wherever they land', () => {
    const bearer = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const blob = 'QWxhZGRpbjpvcGVuIHNlc2FtZUFsYWRkaW46b3BlbiBzZXNhbWU=';
    const html = renderDashboardDetailBody(fixtureCard({
      connection: { state: 'reauth_required', label: 'reauth required', action: { kind: 'none' }, handles: [] },
    }), {
      now: NOW,
      degradedCredentials: [fixtureDegradation({
        hint: `Provider rejected ${bearer}; cached value ${blob} was cleared.`,
      })],
    });

    expect(html).toContain('[REDACTED]');
    expect(html).not.toContain(bearer);
    expect(html).not.toContain(blob);
  });
});

describe('dashboard detail tier table', () => {
  test('lists the trust-domain split of this source', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      tier_composition: [
        { trust_domain: 'secure_local', label: 'Secure local', indexed_items: 44_000, content_ready_items: 20_000 },
        { trust_domain: 'internal', label: 'Internal', indexed_items: 1_200, content_ready_items: 900 },
      ],
    }), { now: NOW });

    expect(html).toContain('<th>Tier</th>');
    expect(html).toContain('<td>Secure local</td><td>44,000</td><td>20,000</td>');
    expect(html).toContain('<td>Internal</td><td>1,200</td><td>900</td>');
  });

  test('renders no table for a source with no tier rows', () => {
    const html = renderDashboardDetailBody(fixtureCard({ tier_composition: [] }), { now: NOW });
    expect(html).not.toContain('<th>Tier</th>');
  });
});

describe('dashboard detail foot line', () => {
  test('carries the last sync, the ingestion prose and the queued vision jobs', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      last_sync_at: '2026-07-02T11:19:00.000Z',
      vlm_extraction_queued: 19,
    }), { now: NOW });

    expect(html).toContain('last sync 41m ago');
    expect(html).toContain('19 vision extraction jobs queued');
    // Credential handle ids are operator plumbing, not reader copy.
    expect(html).not.toContain('handles:');
    expect(html).not.toContain('dropbox.personal');
  });

  test('says nothing about vision extraction when the ledger reported none', () => {
    const html = renderDashboardDetailBody(fixtureCard(), { now: NOW });
    expect(html).toContain('100% covered; nothing stuck');
    expect(html).not.toContain('vision extraction');
  });

  test('does not repeat the ingestion prose the tip is already showing', () => {
    const label = '87.4% covered; 12 stuck; oldest 3.1h';
    const html = renderDashboardDetailBody(fixtureCard({
      ingestion_health: { coverage_percent: 87.4, stuck_count: 12, drain_state: 'enabled', label },
    }), { now: NOW });

    expect(countOccurrences(html, label)).toBe(1);
    expect(html).toContain(`[STUCK_ITEMS] (12) == 0 — ${label}`);
  });
});

// Owner ruling, 2026-08-19: a page whose header says Needs you or Failing
// opens with the act, not with the diagnosis, and never with a dead button.
// Owner ruling, 2026-08-24: that act is now the ONLY error surface on the page,
// it is a banner rather than a "What to do" section, and it stays silent for
// everything that clears itself.
describe('dashboard detail attention banner', () => {
  test('stays silent on a calm page', () => {
    const html = renderDashboardDetailBody(fixtureCard(), { now: NOW });
    expect(html).not.toContain('class="attncard banner"');
  });

  test('leads an expired X credential with the same Reauthenticate control home offers', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      label: 'X bookmarks',
      source_id: 'x.bookmarks',
      provider: 'x',
      connection: {
        state: 'reauth_required',
        label: 'reauth required',
        action: { kind: 'oauth', source: 'x', label: 'Reauthenticate' },
        handles: ['x.bookmarks.personal'],
      },
      answer_readiness: { state: 'needs_attention', label: 'Reauthenticate this source' },
    }), { now: NOW });

    // The banner is the first thing on the page, above ingestion progress.
    expect(html.indexOf('class="attncard banner"')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('class="attncard banner"')).toBeLessThan(html.indexOf('<div class="dsect">Ingestion</div>'));
    expect(html).toContain('Press Reauthenticate and approve Olympus on X bookmarks&#39;s own consent page.');
    expect(html).toContain('<form class="rowform" data-connect-kind="oauth">');
    expect(html).toContain('<input type="hidden" name="source" value="x">');
    expect(html).toContain('>Reauthenticate</button>');
  });

  test('leads a Readwise key failure with the key field itself', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      label: 'Readwise',
      source_id: 'readwise.library',
      provider: 'readwise',
      connection: {
        state: 'reauth_required',
        label: 'reauth required',
        action: {
          kind: 'api_key',
          source: 'readwise',
          label: 'Reauthenticate',
          instructions: {
            plain_intro: 'Readwise issues a personal access token.',
            agent_prompt: 'Set up Readwise for Olympus.',
            provider_console_url: 'https://readwise.io/access_token',
            diy_summary: 'Or set it up yourself',
            diy_steps: [],
            secret_shown_once: false,
            fields: [{ name: 'api_key', label: 'API key', required: true, secret: true }],
          },
        },
        handles: [],
      },
    }), { now: NOW });

    expect(html).toContain('Paste a working Readwise API key here and press Reauthenticate.');
    expect(html).toContain('<form class="rowform" data-connect-kind="api_key">');
    expect(html).toContain('name="api_key"');
  });

  test('sends a missing credential to 1Password and offers no button for it', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      connection: {
        state: 'reauth_required',
        label: 'reauth required',
        action: { kind: 'oauth', source: 'dropbox', label: 'Reauthenticate' },
        handles: [],
      },
    }), { now: NOW, degradedCredentials: [fixtureDegradation()] });

    expect(html).toContain('Add the key back in 1Password');
    expect(html).toContain('nothing on this page can do it');
    // The credential is unreadable, so the connect control is not offered as a
    // way out of it.
    expect(html).not.toContain('data-connect-kind="oauth"');
  });

  // Was: "implies no reader action for a lane Olympus paused itself", which
  // pinned the sentence "Nothing is waiting on you here — paused by the daily
  // budget until 00:00 UTC." Owner ruling, 2026-08-24: self-healing conditions
  // show NOTHING. A budget that rolls over at midnight is not news, and telling
  // a reader nothing is waiting on them is still telling them something. The
  // guarantee the old test defended — no act is asked for — is now absolute.
  test('says nothing at all about a lane Olympus paused itself', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      schedule: {
        running: false,
        consecutive_failures: 3,
        last_error_kind: 'daily_cost_guard',
        degraded_reason: 'daily_cost_guard',
      },
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 2 },
    }), { now: NOW });

    expect(html).not.toContain('class="attncard banner"');
    expect(html).not.toContain('<button');
  });

  // The paused marker set is shared with the view model, which reads it to
  // decide whether to arm a connect control. Not one of them may reach the
  // banner: every marker in the set clears on someone else's clock.
  test('no operator-paused marker ever reaches the banner', () => {
    for (const marker of OPERATOR_PAUSED_SCHEDULER_MARKERS) {
      const html = renderDashboardDetailBody(fixtureCard({
        schedule: {
          running: false,
          consecutive_failures: 3,
          last_error_kind: marker,
          degraded_reason: marker,
        },
        queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 2 },
      }), { now: NOW });

      expect(html).not.toContain('class="attncard banner"');
      expect(html).not.toContain('<button');
    }
  });

  // R61 finding 3: a connected card still carrying a real control means the
  // provider is refusing requests, and the page must lead with the reconnect —
  // never "no control changes this" over a check that says to reconnect.
  test('a refusing provider leads with the real reconnect control on a connected page', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      label: 'X bookmarks',
      source_id: 'x.bookmarks',
      provider: 'x',
      schedule: { running: false, consecutive_failures: 3, last_error_kind: 'api_request_guard' },
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 3 },
      answer_readiness: { state: 'needs_attention', label: 'Needs attention before answers' },
      connection: {
        state: 'synced',
        label: 'synced 41 minutes ago',
        action: { kind: 'oauth', source: 'x', label: 'Reauthenticate' },
        handles: ['x.bookmarks.personal'],
      },
    }), { now: NOW });

    expect(html).toContain('class="attncard banner"');
    expect(html).toContain('provider is refusing requests — press Reauthenticate');
    expect(html).toContain('data-connect-kind="oauth"');
  });

  test('a read-only reader still learns the refusing provider needs a reconnect', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      label: 'X bookmarks',
      source_id: 'x.bookmarks',
      provider: 'x',
      schedule: { running: false, consecutive_failures: 3, last_error_kind: 'api_request_guard' },
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 3 },
      answer_readiness: { state: 'needs_attention', label: 'Needs attention before answers' },
      connection: {
        state: 'synced',
        label: 'synced 41 minutes ago',
        action: { kind: 'oauth', source: 'x', label: 'Reauthenticate' },
        handles: ['x.bookmarks.personal'],
      },
    }), { now: NOW, readOnly: true });

    expect(html).toContain('provider is refusing requests — reconnect the credential from the setup page');
    expect(html).not.toContain('data-connect-kind="oauth"');
  });

  // R61B: a refusing provider whose app key is missing must route to Set up —
  // a healthy connection state must not suppress the remediation.
  test('a refusing provider with no app key leads with the setup sheet on a connected page', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      label: 'X bookmarks',
      source_id: 'x.bookmarks',
      provider: 'x',
      schedule: { running: false, consecutive_failures: 3, last_error_kind: 'api_request_guard' },
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 3 },
      answer_readiness: { state: 'needs_attention', label: 'Needs attention before answers' },
      connection: {
        state: 'synced',
        label: 'synced 41 minutes ago',
        action: {
          kind: 'needs_setup',
          source: 'x',
          label: 'Set up',
          client_secret_required: true,
          instructions: {
            plain_intro: 'X needs an app key.',
            agent_prompt: 'Set up X bookmarks for Olympus.',
            provider_console_url: 'https://console.x.com',
            diy_summary: 'Or set it up yourself',
            diy_steps: [],
            secret_shown_once: true,
            fields: [],
          },
        },
        handles: ['x.bookmarks.personal'],
      },
    }), { now: NOW });

    expect(html).toContain('provider is refusing requests, and reconnecting needs the app key first');
  });

  // R61 finding 4: a parity gap alone proves nothing about who paused what. An
  // enabled lane with chunks outstanding is a lane doing its job, and it must
  // not banner; only the lane reporting itself switched OFF is stuck.
  test('an embedding backlog banners only once the lane says it is switched off', () => {
    const card = fixtureCard({
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 2 },
      embedding_backlog: { chunks: 1_000, embedded_chunks: 100, missing_chunks: 900, refresh_needed: true },
    });
    const html = renderDashboardDetailBody(card, { now: NOW });

    expect(html).not.toContain('class="attncard banner"');

    const disabled = renderDashboardDetailBody({
      ...card,
      embedding_lane_state: 'embedding_lane_disabled',
      queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
      answer_readiness: { state: 'needs_attention', label: 'Embedding lane needs attention' },
    }, { now: NOW });
    expect(disabled).toContain('class="attncard banner"');
    expect(disabled).toContain('still has work to do and its lane has stopped moving');
    expect(disabled).toContain('the embedding lane is switched off, so no new chunks are being embedded');
  });

  test('tells a chat source whose session is unreadable and offers a copyable agent prompt', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      label: 'Telegram',
      source_id: 'telegram.messages',
      provider: 'telegram',
      freshness: { label: 'Last checked 40 hours ago; refresh is late', hours: 40, threshold_hours: 26, stale: true },
      // What the builder writes for a stale card, and what makes this page
      // read Failing.
      answer_readiness: { state: 'needs_attention', label: 'Needs attention before answers' },
      connection: {
        state: 'connected',
        label: 'connected · live session not checked',
        action: {
          kind: 'guided_session',
          source: 'telegram',
          label: 'Session state not surfaced',
          instructions: [
            'Telegram pairs with a phone-number login on this computer.',
            'Ask your agent to start Telegram pairing; this card updates once the login completes.',
          ],
        },
        handles: [],
      },
    }), { now: NOW });

    expect(html).toContain('Olympus cannot read the Telegram session from here.');
    expect(html).toContain('Ask your agent to start Telegram pairing');
    expect(html).toContain('>Ask your agent</button>');
    expect(html).toContain('>Copy prompt</button>');
    expect(html).toContain('local pairing prompt');
    expect(html).toContain('Never ask me to paste a login code or password into this conversation');
    // No claim that the session IS what broke.
    expect(html).not.toContain('Pairing required');
  });

  // Was: "names the fault and says nothing is scheduled to clear it", which
  // pinned a box naming the leading failing check and who owned it. Owner
  // ruling, 2026-08-24: queue attention is machine churn, not a person's work,
  // and no error surface may lead the page with it. The evidence is unchanged
  // and still reachable — it is a check row inside Advanced.
  test('says nothing in the banner about queue attention alone', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 6 },
    }), { now: NOW });

    expect(html).not.toContain('class="attncard banner"');
    expect(html).not.toContain('<button');
    // Still stated, as evidence, under the fold.
    expect(html).toContain('[QUEUE_ATTENTION] (6) == 0');
    expect(html.indexOf('[QUEUE_ATTENTION]')).toBeGreaterThan(html.indexOf('<details class="advanced">'));
  });

  test('stays silent while the lane is scheduled to run again inside its window', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 6 },
      schedule: {
        running: false,
        consecutive_failures: 0,
        next_run_at: new Date(NOW.getTime() + 12 * 60_000).toISOString(),
      },
    }), { now: NOW });

    expect(html).not.toContain('class="attncard banner"');
  });

  test('names the terminal-extraction bucket and offers the folder picker as the one act', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 6 },
      schedule: {
        running: false,
        consecutive_failures: 0,
        next_run_at: new Date(NOW.getTime() + 12 * 60_000).toISOString(),
      },
      needs_review: {
        total: 194,
        automatic_total: 0,
        operator_total: 194,
        reasons: [{
          key: 'extraction_failed',
          label: 'Extraction failed',
          count: 194,
          who_acts: 'needs_you',
          actor_note: 'retried once already, so these wait for you',
        }],
      },
    }), { now: NOW, folderPickerPath: '/dashboard?folders' });

    // Owner, 2026-08-24: the first copy led with the folder picker and read
    // as "redo your scope". The banner now says the scope is fine first.
    expect(html).toContain('Your folder choices are fine');
    expect(html).toContain('194 files inside them are unreadable');
    expect(html).toContain('excluding them is optional tidying');
    expect(html).toContain('<a class="btn" href="/dashboard?folders">Exclude unreadable files</a>');
  });

  test('does not offer the folder picker when the route does not exist', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 6 },
      needs_review: {
        total: 194,
        automatic_total: 0,
        operator_total: 194,
        reasons: [{
          key: 'extraction_failed',
          label: 'Extraction failed',
          count: 194,
          who_acts: 'needs_you',
          actor_note: 'retried once already, so these wait for you',
        }],
      },
    }), { now: NOW });

    expect(html).toContain('will stay metadata-only unless excluded');
    expect(html).not.toContain('Exclude unreadable files</a>');
  });

  test('degrades to a setup link for a read-only reader instead of a button that would 401', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      connection: {
        state: 'reauth_required',
        label: 'reauth required',
        action: { kind: 'oauth', source: 'dropbox', label: 'Reauthenticate' },
        handles: [],
      },
    }), { now: NOW, readOnly: true });

    expect(html).toContain('the link you arrived with is read-only');
    expect(html).toContain('<a class="btn" href="/dashboard?setup">Reauthenticate</a>');
    expect(html).not.toContain('<form class="rowform"');
  });
});

// Owner ruling, 2026-08-19: failing checks first, each with what it means, and
// the passing ones collapsed underneath.
describe('dashboard detail checks triage', () => {
  test('opens with the failures and never with a passing line', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      connection: { state: 'reauth_required', label: 'reauth required', action: { kind: 'none' }, handles: [] },
      answer_readiness: { state: 'needs_attention', label: 'Reauthenticate this source' },
    }), { now: NOW });

    const tip = html.slice(html.indexOf('class="tip"'), html.indexOf('class="evidence"'));
    expect(tip).toContain('[CONNECTION]');
    expect(tip).toContain('[ANSWER_LANE]');
    expect(tip).not.toContain('<span class="ok">✓</span>');
    // Every failing row precedes every passing one.
    expect(html.indexOf('<span class="no">✗</span>')).toBeLessThan(html.indexOf('<span class="ok">✓</span>'));
  });

  test('collapses the passing checks into an evidence list', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      connection: { state: 'reauth_required', label: 'reauth required', action: { kind: 'none' }, handles: [] },
    }), { now: NOW });

    expect(html).toContain('<details class="evidence" data-poll-key="evidence">');
    expect(html).toMatch(/<summary>evidence — \d+ checks passing<\/summary>/);
    expect(html).toContain('<span class="ok">✓</span> [QUEUE_ATTENTION] (0) == 0');
  });

  test('states the consequence of each failure class it knows', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      connection: { state: 'reauth_required', label: 'reauth required', action: { kind: 'none' }, handles: [] },
      answer_readiness: { state: 'needs_attention', label: 'Reauthenticate this source' },
      freshness: { label: 'Last checked 40 hours ago; refresh is late', hours: 40, threshold_hours: 26, stale: true },
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 4, retrying_tasks: 1 },
      ingestion_health: {
        coverage_percent: 87.4,
        stuck_count: 12,
        drain_state: 'held',
        drain_unit: 'olympus-vlm.timer',
        label: '87.4% covered; 12 stuck',
      },
      embedding_backlog: { chunks: 100, embedded_chunks: 40, missing_chunks: 60, refresh_needed: true },
      last_run: { status: 'failed', items_seen: 480, items_indexed: 0 },
    }), { now: NOW });

    expect(html).toContain('nothing new is coming in from this source until it is connected again');
    expect(html).toContain('answers cannot use this source yet');
    expect(html).toContain("the last check is older than this source&#39;s own refresh window");
    expect(html).toContain('the last sync did not finish');
    expect(html).toContain('these items are stuck and will not be answered on until they clear');
    expect(html).toContain('a sync task is retrying itself');
    expect(html).toContain('these items are stuck part-way through extraction');
    expect(html).toContain('no new text is being extracted while the lane is not draining');
    expect(html).toContain('waiting on the embedding lane');
  });

  test('translates the scheduler guard markers, not just the check class', () => {
    const refused = renderDashboardDetailBody(fixtureCard({
      schedule: { running: false, consecutive_failures: 2, last_error_kind: 'api_request_guard' },
    }), { now: NOW });
    expect(refused).toContain('[CONSECUTIVE_FAILURES] (2) == 0 — api_request_guard');
    expect(refused).toContain('the provider is refusing requests — reconnect the credential');

    const budgeted = renderDashboardDetailBody(fixtureCard({
      schedule: { running: false, consecutive_failures: 1, degraded_reason: 'daily_cost_guard' },
    }), { now: NOW });
    expect(budgeted).toContain('paused by the daily budget until 00:00 UTC');
  });

  test('translates a ledger reason naming a known marker, exactly, not by substring', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      attention_reasons: ['telegram.sync failing: credential_session_latched'],
    }), { now: NOW });
    expect(html).toContain('[LEDGER] (telegram.sync failing: credential_session_latched)');
    expect(html).toContain('the credential session is latched by another run');

    // gmail_daily_api_request_guard CONTAINS api_request_guard; a substring
    // match would translate a budget pause as a provider refusal.
    const budget = renderDashboardDetailBody(fixtureCard({
      attention_reasons: ['gmail.email parked: gmail_daily_api_request_guard'],
    }), { now: NOW });
    expect(budget).toContain('paused by the daily request budget until 00:00 UTC');
    expect(budget).not.toContain('the provider is refusing requests');
  });

  test('a ledger reason naming nothing known still carries a consequence line', () => {
    const html = renderDashboardDetailBody(fixtureCard({
      attention_reasons: ['dropbox.files failing: something_never_mapped'],
    }), { now: NOW });
    expect(html).toContain('[LEDGER] (dropbox.files failing: something_never_mapped)');
    expect(html).toContain('this lane is failing, so its work is not moving until the fault above clears');
  });

  test('gives the credential check its own consequence', () => {
    const html = renderDashboardDetailBody(fixtureCard(), {
      now: NOW,
      degradedCredentials: [fixtureDegradation()],
    });

    expect(html).toContain('[CREDENTIAL]');
    expect(html).toContain('the stored credential cannot be read, so this source cannot authenticate');
  });
});

describe('dashboard detail page', () => {
  test('returns undefined for a source id no card owns', () => {
    expect(renderDashboardDetailPage(fixtureView(), 'nope.missing', { now: NOW })).toBeUndefined();
  });

  test('renders the body inside the shared page shell, with the status in the header', () => {
    const html = renderDashboardDetailPage(fixtureView(), 'dropbox.files', { now: NOW }) ?? '';

    expect(html).toContain('<title>Olympus / Dropbox</title>');
    expect(html).toContain('class="meta">Fresh · checked');
    expect(html).toContain('<div class="dsect">Ingestion</div>');
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function fixtureCard(overrides: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
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
      indexed_items: 4_806,
      content_ready_items: 3_201,
      embedded_items: 129_948,
      needs_review_items: 0,
    },
    ingestion_health: {
      coverage_percent: 100,
      stuck_count: 0,
      drain_state: 'enabled',
      label: '100% covered; nothing stuck',
    },
    tier_composition: [
      { trust_domain: 'secure_local', label: 'Secure local', indexed_items: 4_806, content_ready_items: 3_201 },
    ],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'ready', label: 'Ready for questions' },
    connection: {
      state: 'synced',
      label: 'synced 41 minutes ago',
      action: { kind: 'none' },
      handles: ['dropbox.personal'],
    },
    ...overrides,
  };
}

/**
 * The same card with every phase complete: everything in scope read, parity
 * met, and a last-sync stamp for the settled line to date itself from.
 */
function settledCard(overrides: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
  return fixtureCard({
    coverage: {
      indexed_items: 12_812,
      content_ready_items: 12_812,
      // Every in-scope file embedded on the current model: the `items_embedded`
      // count the store publishes, which is what the third bar divides by.
      embedded_files: 12_812,
      embedded_items: 100_000,
      needs_review_items: 0,
      answer_ready_eligible_items: 12_812,
    },
    embedding_backlog: { chunks: 100_000, embedded_chunks: 100_000, missing_chunks: 0, refresh_needed: false },
    last_sync_at: '2026-07-02T11:19:00.000Z',
    ...overrides,
  });
}

function fixtureDegradation(
  overrides: Partial<WorkerCredentialDegradation> = {},
): WorkerCredentialDegradation {
  return {
    kind: 'worker_credential_degraded',
    display_name: 'Dropbox',
    state: 'retrying',
    status_label: 'Credential unavailable - needs your attention',
    hint: 'Unlock or reconnect this credential, then restart the Olympus worker.',
    attempts: 2,
    max_attempts: 3,
    next_retry_at: '2026-07-02T12:05:00.000Z',
    ...overrides,
  };
}

function fixtureView(sources: DashboardSourceCard[] = [fixtureCard()]): SourceDashboardViewModel {
  return {
    kind: 'source_dashboard',
    generated_at: NOW.toISOString(),
    summary: {
      configured_sources: sources.length,
      connected_sources: sources.length,
      answer_ready_sources: sources.length,
      needs_attention_sources: 0,
      total_indexed_items: sources.reduce((total, source) => total + source.coverage.indexed_items, 0),
      total_content_ready_items: sources.reduce((total, source) => total + source.coverage.content_ready_items, 0),
    },
    onboarding: {
      steps: [{ id: 'connect_sources', label: 'Connect your sources', state: 'complete' }],
      ask_first_question: {
        enabled: true,
        label: 'Ask your first question',
        suggestion: 'What did I save about pricing?',
      },
    },
    answer_lanes: [],
    where_your_data_lives: [],
    unassigned_corpora: { corpus_count: 0, indexed_items: 0, content_ready_items: 0, entries: [] },
    excluded_by_configuration: { rules: 0, prefixes: 0, items_present: 0, items_unevaluable: 0, entries: [] },
    folder_picker: { available: false, label: 'Choose folders', path: '/dashboard/dispositions', rules: 0 },
    sources,
    history: { sample_count: 0, eta_available: false },
    first_run: false,
    background_work: {},
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

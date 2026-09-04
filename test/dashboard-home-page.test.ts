import { describe, expect, test } from 'bun:test';
import { renderDashboardHomePage } from '../src/workers/dashboard/pages/home.ts';
import { sourceCard } from '../src/workers/dashboard/components.ts';
import { dashboardConnectedStatusGroups } from '../src/workers/dashboard/vocabulary.ts';
import type {
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';

const NOW = new Date('2026-07-02T12:00:00.000Z');
const GENERATED_AT = '2026-07-02T11:59:48.000Z';

describe('dashboard home page sections', () => {
  test('gives every status group a heading that names the word and counts its members', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
      syncedSource({ source_id: 'readwise.library', label: 'Readwise' }),
      syncingSource({ source_id: 'gmail.email', label: 'Gmail' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW, controlSessionCsrfToken: 'csrf-fixture' });

    const groups = dashboardConnectedStatusGroups(view, { now: NOW });
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(html).toContain(`${group.status} — ${group.sources.length}`);
    }
    // Sections follow DASHBOARD_STATUS_ORDER, so headings appear in group order.
    const positions = groups.map((group) => html.indexOf(`${group.status} — `));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  test('names every source it was handed', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
      syncingSource({ source_id: 'gmail.email', label: 'Gmail' }),
      reauthSource({ source_id: 'dropbox.files', label: 'Dropbox' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW, controlSessionCsrfToken: 'csrf-fixture' });

    for (const source of view.sources) {
      expect(html).toContain(source.label);
    }
  });

  test('links each card to its own detail page on the same route', () => {
    const view = fixtureView([syncedSource({ source_id: 'x.bookmarks', label: 'X bookmarks' })]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('/dashboard?source=x.bookmarks');
  });

  test('keeps a caller-supplied query prefix intact when it links to detail', () => {
    const view = fixtureView([syncedSource({ source_id: 'x.bookmarks', label: 'X bookmarks' })]);

    const html = renderDashboardHomePage(view, { now: NOW, basePath: '/dashboard?view=all' });

    // Escaped or not is the card's business; the separator is this page's.
    expect(html).toMatch(/\/dashboard\?view=all(&|&amp;)source=x\.bookmarks/);
    expect(html).not.toContain('/dashboard?view=all?source=');
  });
});

describe('dashboard home answer lanes', () => {
  test('renders nothing for an answer lane; lanes live on /dashboard.json only', () => {
    // Pinned as a decision, not an oversight: an answer lane is not a source
    // and no page in the module surfaces one.
    const view: SourceDashboardViewModel = {
      ...fixtureView([syncedSource({ source_id: 'gmail.email', label: 'Gmail' })]),
      answer_lanes: [{
        lane_id: 'venice-secure-answers',
        source_id: 'venice.api',
        label: 'Venice',
        role: 'Secure answers',
        connection: { state: 'validated', label: 'validated', action: { kind: 'none' }, handles: [] },
      }],
    };

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).not.toContain('Venice');
  });
});

describe('dashboard home working donut', () => {
  test('draws the wedge from the card ingestion coverage', () => {
    const view = fixtureView([
      syncingSource({
        source_id: 'gmail.email',
        label: 'Gmail',
        ingestion_health: {
          coverage_percent: 50,
          stuck_count: 0,
          drain_state: 'enabled',
          label: '50.0% covered; 0 stuck',
        },
      }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    // 0.5 x 12.566, through statusGlyph -> donutGlyph on the rendered card.
    expect(html).toContain('stroke-dasharray="6.28 12.566"');
  });

  test('claims no wedge at all on cards that are not Working', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
      reauthSource({ source_id: 'dropbox.files', label: 'Dropbox' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).not.toContain('stroke-dasharray');
  });
});

describe('dashboard home setup link', () => {
  test('offers the way back to setup while any source is still unconnected', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
      offSource({ source_id: 'dropbox.files', label: 'Dropbox' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('href="/dashboard?setup"');
    expect(html).toContain('Connect more sources');
  });

  test('keeps a caller-supplied query prefix intact on the setup link', () => {
    const view = fixtureView([offSource({ source_id: 'dropbox.files', label: 'Dropbox' })]);

    const html = renderDashboardHomePage(view, { now: NOW, basePath: '/dashboard?view=all' });

    expect(html).toMatch(/\/dashboard\?view=all(&|&amp;)setup/);
  });

  test('still offers the setup link once every source is connected', () => {
    // Owner ruling: never-connected sources left this page, so the foot link is
    // the only way to the page where a new source is connected. It is always
    // here, including on a fully connected install.
    const view = fixtureView([syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' })]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('href="/dashboard?setup"');
    expect(html).toContain('Connect more sources');
  });
});

describe('dashboard home connected sources only', () => {
  test('keeps a never-connected source off the page entirely', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
      offSource({ source_id: 'dropbox.files', label: 'Dropbox' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('Google Drive');
    expect(html).not.toContain('Dropbox');
    // The Off group does not exist on home at all: no heading, no card.
    expect(html).not.toContain('Off — ');
  });

  test('keeps an app-key source that was never set up off the page too', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'readwise.library', label: 'Readwise' }),
      needsSetupSource({ source_id: 'gmail.email', label: 'Gmail' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('Readwise');
    expect(html).not.toContain('Gmail');
  });

  test('counts engaged sources only in the header — the catalog never inflates it', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
      offSource({ source_id: 'dropbox.files', label: 'Dropbox' }),
      needsSetupSource({ source_id: 'gmail.email', label: 'Gmail' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    // Owner ruling 2026-08-19 evening: no source counts in the header at all —
    // only the staleness fact survives.
    expect(html).toContain('checked');
    expect(html).not.toContain('1 source ·');
    expect(html).not.toContain('of 3 connected');
  });

  test('shows no fraction even when engaged sources need attention', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
      reauthSource({ source_id: 'x.bookmarks', label: 'X bookmarks' }),
      offSource({ source_id: 'dropbox.files', label: 'Dropbox' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    // The Needs-you group carries the attention story; the header stays quiet.
    expect(html).not.toContain('connected</span>');
    expect(html).not.toContain('1 of 2');
  });

  test('renders an empty page of cards when nothing is connected yet', () => {
    const view = fixtureView([offSource({ source_id: 'dropbox.files', label: 'Dropbox' })]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).not.toContain('class="cards"');
    expect(html).not.toContain('0 sources');
    expect(html).toContain('Connect more sources');
  });
});

describe('dashboard home attention', () => {
  test('raises a needs-you section for a source whose credentials need reauth', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
      reauthSource({ source_id: 'dropbox.files', label: 'Dropbox' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('class="sect attn"');
    expect(html).toContain('Needs you — 1');
    expect(html).toContain('Dropbox');
    // Attention leads the page: its heading precedes every card grid.
    expect(html.indexOf('Needs you — 1')).toBeLessThan(html.indexOf('class="cards"'));
  });

  test('shows no attention section at all when every source is quiet', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
      syncedSource({ source_id: 'readwise.library', label: 'Readwise' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).not.toContain('class="sect attn"');
    expect(html).not.toContain('Needs you');
    expect(html).not.toContain('Failing');
    expect(html).not.toContain('▲');
  });

  test('carries the reconnect control the worker actually routes', () => {
    const view = fixtureView([reauthSource({ source_id: 'dropbox.files', label: 'Dropbox' })]);

    const html = renderDashboardHomePage(view, { now: NOW, controlSessionCsrfToken: 'csrf-fixture' });

    expect(html).toContain('Reauthenticate');
    // The real control, posting to the route that exists — not a bare word.
    expect(html).toContain('data-connect-kind="oauth"');
    expect(html).toContain('<input type="hidden" name="source" value="dropbox">');
    // And the row's name still leads to the source's own page.
    expect(html).toContain('<a class="name" href="/dashboard?source=dropbox.files">Dropbox</a>');
  });

  test('degrades the control to the gate above for a read-only view token', () => {
    const view = fixtureView([reauthSource({ source_id: 'dropbox.files', label: 'Dropbox' })]);

    const html = renderDashboardHomePage(view, { now: NOW, readOnly: true });

    // The control routes refuse the dash_ token, so the row points at the
    // setup page's gate where the token goes (owner ruling, 2026-09-01:
    // "Setup is the only place you need to think about the worker token").
    expect(html).not.toContain('Input token');
    expect(html).toContain('<a class="btn" href="/dashboard?setup#dashboard-controls">Reauthenticate</a>');
    expect(html).toContain('unlock controls in Setup');
    expect(html).not.toContain('unlock dashboard controls there first');
  });

  test('opens the setup sheet under a needs-you row whose app key is missing', () => {
    const view = fixtureView([{
      ...needsSetupSource({ source_id: 'x.bookmarks', label: 'X bookmarks' }),
      connection: {
        ...needsSetupSource({ source_id: 'x.bookmarks', label: 'X bookmarks' }).connection,
        state: 'reauth_required',
        label: 'reauth required',
      },
    }]);

    const html = renderDashboardHomePage(view, { now: NOW, controlSessionCsrfToken: 'csrf-fixture' });

    expect(html).toContain('Needs you — 1');
    // The sheet that finishes this flow now renders under this very row, so
    // the reader never leaves the page to press the same button again. The
    // toggle is styled as the row's main act, same as an oauth Reauthenticate.
    expect(html).toContain('class="btn primary" type="button" data-sheet-toggle="#setup-x-bookmarks"');
    expect(html).toContain('id="setup-x-bookmarks"');
    expect(html).toContain('To read your Gmail, Olympus needs a free Google app key.');
    expect(html).not.toContain('<a class="btn" href="/dashboard?setup">Set up</a>');
    // The ROW opens the sheet; the oauth form it carries lives inside the
    // sheet, where the app key the route needs is actually collected.
    const row = html.slice(html.indexOf('class="attncard'), html.indexOf('<div class="sheet"'));
    expect(row).toContain('data-sheet-toggle="#setup-x-bookmarks"');
    expect(row).not.toContain('data-connect-kind');
  });

  test('sends a locked reader with a missing app key to the gate, not to another page', () => {
    const view = fixtureView([{
      ...needsSetupSource({ source_id: 'x.bookmarks', label: 'X bookmarks' }),
      connection: {
        ...needsSetupSource({ source_id: 'x.bookmarks', label: 'X bookmarks' }).connection,
        state: 'reauth_required',
        label: 'reauth required',
      },
    }]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('<a class="btn" href="/dashboard?setup#dashboard-controls">Set up</a>');
    expect(html).toContain('unlock controls in Setup');
    // No sheet is offered to a reader who could not submit it.
    expect(html).not.toContain('data-sheet-toggle="#setup-x-bookmarks"');
  });

  test('leads a failing row with no control through to its detail page', () => {
    const view = fixtureView([failingSource({ source_id: 'gmail.email', label: 'Gmail' })]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('Needs you — 1');
    // No control exists for this state, so the whole row is the link.
    expect(html).toContain('class="attncard rowzone" href="/dashboard?source=gmail.email"');
  });

  test('renders no dead button on a row whose action has no route', () => {
    const view = fixtureView([failingSource({ source_id: 'gmail.email', label: 'Gmail' })]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('class="attncard rowzone" href="/dashboard?source=gmail.email"');
  });
});

describe('dashboard home card hit zone', () => {
  test('makes the whole card the link to detail, not the name inside it', () => {
    const view = fixtureView([syncedSource({ source_id: 'gmail.email', label: 'Gmail' })]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('<a class="card cardlink" href="/dashboard?source=gmail.email">');
    // The name is plain text inside the card link now.
    expect(html).toContain('Gmail</div>');
    expect(html).not.toContain('<div class="card">');
  });

  test('leaves a card with nowhere to go as a plain card', () => {
    const html = sourceCard({ label: 'Gmail', status: 'Fresh' });

    expect(html).toContain('<div class="card">');
    expect(html).not.toContain('cardlink');
  });
});

describe('dashboard home background section', () => {
  test('gives background its own section and one linked card when a lane reports', () => {
    const view = fixtureView([
      draining({
        ...syncingSource({ source_id: 'gmail.email', label: 'Gmail' }),
      }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    // The same heading style every other section on the page gets.
    expect(html).toContain('<div class="sect">Background</div>');
    expect(html).toContain('class="bgrow"');
    expect(html).toContain('href="/dashboard?background"');
    // The blessed treatment replaced the grey background footnote outright;
    // the one foot line left on home is the way to the setup page.
    expect(html).not.toContain('Background:');
  });

  test('drops the section entirely when nothing is running in the background', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    // The nav's Background tab stays — the SECTION is what comes down.
    expect(html).not.toContain('<div class="sect">Background</div>');
    expect(html).not.toContain('class="bgrow"');
  });
});

describe('dashboard home calm', () => {
  test('carries no token gate: that lives on the setup page only', () => {
    const view = fixtureView([]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).not.toContain('class="cards"');
    // Owner ruling, 2026-09-01: setup is the only place the worker token is
    // thought about, so home renders no gate in either state.
    expect(html).not.toContain('id="dashboard-controls"');
    expect(html).not.toContain('Input token');
    expect(renderDashboardHomePage(view, { now: NOW, controlSessionCsrfToken: 'csrf-fixture' }))
      .not.toContain('Dashboard controls unlocked');
    expect(html).toContain('Olympus');
  });

  test('spaces every card grid but the last one', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
      syncingSource({ source_id: 'gmail.email', label: 'Gmail' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    // Matched inside the style attribute: the shared stylesheet carries plain
    // margin and grid declarations of its own.
    expect(html.split('style="margin-bottom:22px"').length - 1).toBe(1);
  });

  test('keeps the last card grid spaced when the Background section follows it', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
      draining(syncingSource({ source_id: 'gmail.email', label: 'Gmail' })),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('<div class="sect">Background</div>');
    // Both card grids keep their bottom margin: neither is the page's last
    // section any more.
    expect(html.split('margin-bottom:22px').length - 1).toBe(2);
  });

  test('widens a section to four columns once it fills a row', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
      syncedSource({ source_id: 'readwise.library', label: 'Readwise' }),
      syncedSource({ source_id: 'telegram.messages', label: 'Telegram' }),
      syncedSource({ source_id: 'whatsapp.personal.messages', label: 'WhatsApp' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('<div class="cards" style="grid-template-columns:repeat(4,1fr)">');
  });

  test('leaves a three-card section on the default grid', () => {
    const view = fixtureView([
      syncedSource({ source_id: 'google_drive.docs', label: 'Google Drive' }),
      syncedSource({ source_id: 'readwise.library', label: 'Readwise' }),
      syncedSource({ source_id: 'telegram.messages', label: 'Telegram' }),
    ]);

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('<div class="cards">');
    expect(html).not.toContain('style="grid-template-columns');
  });
});

function fixtureView(sources: DashboardSourceCard[]): SourceDashboardViewModel {
  const connected = sources.filter((source) => source.configured).length;
  return {
    kind: 'source_dashboard',
    generated_at: GENERATED_AT,
    summary: {
      configured_sources: sources.length,
      connected_sources: connected,
      answer_ready_sources: sources.filter((source) => source.answer_readiness.state === 'ready').length,
      needs_attention_sources: sources.filter((source) => source.answer_readiness.state === 'needs_attention').length,
      total_indexed_items: sources.reduce((total, source) => total + source.coverage.indexed_items, 0),
      total_content_ready_items: sources.reduce((total, source) => total + source.coverage.content_ready_items, 0),
    },
    onboarding: {
      steps: [
        { id: 'connect_sources', label: 'Connect your sources', state: connected > 0 ? 'complete' : 'active' },
        { id: 'first_sync', label: 'First sync', state: connected > 0 ? 'active' : 'pending' },
        { id: 'choose_folders', label: 'Choose folders', state: 'pending' },
        { id: 'where_data_lives', label: 'Where your data lives', state: 'pending' },
        { id: 'ask_first_question', label: 'Ask your first question', state: 'pending' },
      ],
      ask_first_question: {
        enabled: connected > 0,
        label: 'Ask your first question',
        suggestion: 'What did I say about the roof last spring?',
      },
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

function baseSource(overrides: Partial<DashboardSourceCard>): DashboardSourceCard {
  const source_id = overrides.source_id ?? 'gmail.email';
  return {
    corpus_id: `internal.${source_id.split('.')[0]}`,
    source_id,
    label: overrides.label ?? 'Gmail',
    provider: source_id.split('.')[0] ?? 'gmail',
    family: 'email',
    trust_domain: 'internal',
    configured: true,
    freshness: { label: 'Last checked 12 minutes ago', hours: 0.2, threshold_hours: 26, stale: false },
    coverage: { indexed_items: 1_200, content_ready_items: 1_200, embedded_items: 3_400, needs_review_items: 0 },
    ingestion_health: {
      coverage_percent: 100,
      stuck_count: 0,
      drain_state: 'enabled',
      label: '100.0% covered; 0 stuck',
    },
    tier_composition: [
      { trust_domain: 'internal', label: 'Internal', indexed_items: 1_200, content_ready_items: 1_200 },
    ],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'ready', label: 'Ready for questions' },
    connection: {
      state: 'synced',
      label: 'synced 12 minutes ago',
      action: { kind: 'none' },
      handles: [],
    },
    ...overrides,
  };
}

/** Quiet and current: the steady state the page is designed around. */
function syncedSource(overrides: Partial<DashboardSourceCard>): DashboardSourceCard {
  return baseSource(overrides);
}

/** Actively moving items: a live queue and a syncing connection. */
function syncingSource(overrides: Partial<DashboardSourceCard>): DashboardSourceCard {
  return baseSource({
    ...overrides,
    freshness: { label: 'Last checked 2 minutes ago', hours: 0.03, threshold_hours: 26, stale: false },
    coverage: { indexed_items: 1_200, content_ready_items: 600, embedded_items: 900, needs_review_items: 0 },
    queue_health: { label: 'Working now', waiting: 420, active: 8, needs_attention: 0 },
    answer_readiness: { state: 'syncing', label: 'Syncing now' },
    connection: {
      state: 'syncing',
      label: 'syncing',
      action: { kind: 'none' },
      handles: [],
    },
  });
}

/** Credentials expired: the one state that earns the amber row. */
function reauthSource(overrides: Partial<DashboardSourceCard>): DashboardSourceCard {
  return baseSource({
    ...overrides,
    freshness: { label: 'Last checked 3 days ago; refresh is late', hours: 74, threshold_hours: 26, stale: true },
    queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 4 },
    answer_readiness: { state: 'needs_attention', label: 'Reauthenticate this source' },
    connection: {
      state: 'reauth_required',
      label: 'reauth required',
      action: { kind: 'oauth', source: 'dropbox', label: 'Reauthenticate' },
      handles: ['dropbox:primary'],
    },
  });
}

/** Never connected: the calm Off card, not a nag. */
function offSource(overrides: Partial<DashboardSourceCard>): DashboardSourceCard {
  return baseSource({
    ...overrides,
    configured: false,
    freshness: { label: 'Waiting for the first sync', stale: false },
    coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0, needs_review_items: 0 },
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'disconnected', label: 'Connect this source' },
    connection: {
      state: 'not_connected',
      label: 'not connected',
      action: { kind: 'oauth', source: 'dropbox', label: 'Connect' },
      handles: [],
    },
  });
}

/** Never connected AND needing an app key first: still never connected. */
function needsSetupSource(overrides: Partial<DashboardSourceCard>): DashboardSourceCard {
  return baseSource({
    ...overrides,
    configured: false,
    freshness: { label: 'Waiting for the first sync', stale: false },
    coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0, needs_review_items: 0 },
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'disconnected', label: 'Connect this source' },
    connection: {
      state: 'needs_setup',
      label: 'not connected',
      action: {
        kind: 'needs_setup',
        source: 'gmail',
        label: 'Set up',
        client_secret_required: true,
        instructions: {
          plain_intro: 'To read your Gmail, Olympus needs a free Google app key.',
          agent_prompt: 'Set up Gmail for Olympus and walk me through it step by step.',
          provider_console_url: 'https://console.cloud.google.com/auth/clients',
          diy_summary: 'Or set it up yourself (about 5 minutes)',
          diy_steps: [],
          secret_shown_once: true,
          fields: [{ name: 'client_id', label: 'Client ID', required: true, secret: false }],
        },
      },
      handles: [],
    },
  });
}

/** Failing, with no control of its own: the row that must still lead somewhere. */
function failingSource(overrides: Partial<DashboardSourceCard>): DashboardSourceCard {
  return baseSource({
    ...overrides,
    queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 6 },
    answer_readiness: { state: 'needs_attention', label: 'Ingestion is stalled' },
    connection: {
      state: 'synced',
      label: 'synced 12 minutes ago',
      action: { kind: 'none' },
      handles: ['gmail:primary'],
    },
  });
}

/** A held extractor drain — the one background fact the model does report. */
function draining(source: DashboardSourceCard): DashboardSourceCard {
  return {
    ...source,
    ingestion_health: {
      coverage_percent: 87.4,
      stuck_count: 12,
      oldest_stuck_age_hours: 3.1,
      last_drain_activity_hours: 0.4,
      drain_state: 'held',
      drain_unit: 'olympus-source-processing-supervisor-vlm-pdf.timer',
      label: '87.4% covered; 12 stuck; oldest 3.1h; last drain 0.4h ago',
    },
  };
}

import { describe, expect, test } from 'bun:test';
import {
  DASHBOARD_DETAIL_QUERY_PARAM,
  DASHBOARD_HTML_PATH,
  DASHBOARD_SETUP_QUERY_PARAM,
  isDashboardHtmlRoute,
  renderDashboardHtmlRoute,
} from '../src/workers/dashboard/index.ts';
import type {
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';

const NOW = new Date('2026-07-02T12:00:00.000Z');
const GENERATED_AT = '2026-07-02T11:59:48.000Z';

function dashboardUrl(query = ''): URL {
  return new URL(`http://worker.test${DASHBOARD_HTML_PATH}${query}`);
}

describe('dashboard html route matching', () => {
  test('claims exactly the /dashboard pathname, with or without a query', () => {
    expect(isDashboardHtmlRoute(dashboardUrl())).toBe(true);
    expect(isDashboardHtmlRoute(dashboardUrl('?source=gmail.email'))).toBe(true);
    expect(isDashboardHtmlRoute(dashboardUrl('?token=dash_abc'))).toBe(true);
    // The pathname is what workers/http.ts allowlists for the dash_ query
    // token, so this module must never claim a path of its own.
    expect(isDashboardHtmlRoute(new URL('http://worker.test/dashboard.json'))).toBe(false);
    expect(isDashboardHtmlRoute(new URL('http://worker.test/dashboard/dispositions'))).toBe(false);
    expect(isDashboardHtmlRoute(new URL('http://worker.test/'))).toBe(false);
  });
});

describe('dashboard html route dispatch', () => {
  test('serves home when sources are connected', () => {
    const view = fixtureView([connectedSource()]);

    const page = renderDashboardHtmlRoute({ url: dashboardUrl(), view, options: { now: NOW } });

    expect(page.status).toBe(200);
    // Owner ruling 2026-08-19 evening: no counts in the header — only the
    // staleness fact.
    expect(page.html).toContain('checked 12s ago');
    expect(page.html).not.toContain('1 source ·');
    expect(page.html).toContain('/dashboard?source=gmail.email');
  });

  test('serves the first-run page instead of home while nothing is connected', () => {
    const view = fixtureView([disconnectedSource()]);

    const page = renderDashboardHtmlRoute({ url: dashboardUrl(), view, options: { now: NOW } });

    expect(page.status).toBe(200);
    // No count in the header (owner ruling 2026-08-19 evening). The setup
    // summary card below names its counts; the header states staleness only.
    expect(page.html).not.toMatch(/<span class="meta">[^<]*connected/);
    expect(page.html).toContain('Available to connect — 1');
  });

  test('keeps the setup page reachable by query once sources are connected', () => {
    const view = fixtureView([connectedSource()]);

    const page = renderDashboardHtmlRoute({
      url: dashboardUrl(`?${DASHBOARD_SETUP_QUERY_PARAM}`),
      view,
      options: { now: NOW },
    });

    expect(page.status).toBe(200);
    expect(page.html).not.toMatch(/<span class="meta">[^<]*connected/);
    expect(page.html).toContain('Build a connector');
  });

  test('serves the detail page for a source the view model carries', () => {
    const view = fixtureView([connectedSource()]);

    const page = renderDashboardHtmlRoute({
      url: dashboardUrl(`?${DASHBOARD_DETAIL_QUERY_PARAM}=gmail.email`),
      view,
      options: { now: NOW },
    });

    expect(page.status).toBe(200);
    expect(page.html).toContain('<span class="crumb">/</span> Gmail');
  });

  test('404s an unknown source id without echoing it back', () => {
    const view = fixtureView([connectedSource()]);

    const page = renderDashboardHtmlRoute({
      url: dashboardUrl(`?${DASHBOARD_DETAIL_QUERY_PARAM}=%3Cscript%3Enope`),
      view,
      options: { now: NOW },
    });

    expect(page.status).toBe(404);
    expect(page.html).toContain('No source by that id.');
    expect(page.html).toContain(`href="${DASHBOARD_HTML_PATH}"`);
    expect(page.html).not.toContain('nope');
    expect(page.html).not.toContain('<script>');
  });

  test('detail outranks the setup query when both are present', () => {
    const view = fixtureView([connectedSource()]);

    const page = renderDashboardHtmlRoute({
      url: dashboardUrl(`?${DASHBOARD_SETUP_QUERY_PARAM}&${DASHBOARD_DETAIL_QUERY_PARAM}=gmail.email`),
      view,
      options: { now: NOW },
    });

    expect(page.html).toContain('<span class="crumb">/</span> Gmail');
  });

  test('serves home, not setup, when a whole fleet needs reauth at once', () => {
    // A fleet-wide credential expiry zeroes connected_sources too, but that
    // owner needs home's Needs-you rows, not a fresh-install greeting.
    const source = {
      ...connectedSource(),
      configured: false,
      answer_readiness: { state: 'needs_attention' as const, label: 'Reauthenticate this source' },
      connection: {
        state: 'reauth_required' as const,
        label: 'reauth required',
        action: { kind: 'oauth' as const, source: 'gmail' as const, label: 'Reauthenticate' as const },
        handles: [],
      },
    };
    const view = {
      ...fixtureView([source]),
      summary: { ...fixtureView([source]).summary, total_indexed_items: 1200 },
    };

    const page = renderDashboardHtmlRoute({ url: dashboardUrl(), view, options: { now: NOW } });

    expect(page.html).toContain('Needs you — 1');
    expect(page.html).not.toContain('Build a connector');
  });
});

describe('dashboard html route token propagation', () => {
  test('threads the dash_ query token into every internal link', () => {
    const view = fixtureView([connectedSource()]);

    const page = renderDashboardHtmlRoute({
      url: dashboardUrl('?token=dash_fixture123'),
      view,
      options: { now: NOW },
    });

    // The dash_ URL is the only way a browser reaches this HTML, so a link
    // that drops the token dead-ends the exact reader the page is for.
    expect(page.html).toMatch(/\/dashboard\?token=dash_fixture123(&|&amp;)source=gmail\.email/);
  });

  test('keeps the token on the 404 page way home', () => {
    const view = fixtureView([connectedSource()]);

    const page = renderDashboardHtmlRoute({
      url: dashboardUrl(`?token=dash_fixture123&${DASHBOARD_DETAIL_QUERY_PARAM}=missing.source`),
      view,
      options: { now: NOW },
    });

    expect(page.status).toBe(404);
    expect(page.html).toContain('href="/dashboard?token=dash_fixture123"');
  });

  test('reads the dash_ token as the read-only reader it is', () => {
    // A reauth row is the one that would otherwise render a control the dash_
    // reader's token can never call.
    const view = fixtureView([reauthSource()]);

    const page = renderDashboardHtmlRoute({
      url: dashboardUrl('?token=dash_fixture123'),
      view,
      options: { now: NOW },
    });

    // The gate lives on the setup page only (owner ruling, 2026-09-01), so
    // home carries no token form; the locked row links to that gate.
    expect(page.html).not.toContain('data-control-session-kind="unlock"');
    expect(page.html).not.toContain('data-connect-kind="oauth"');
    expect(page.html).toContain('href="/dashboard?token=dash_fixture123&amp;setup#dashboard-controls"');
    expect(page.html).toContain('unlock controls in Setup');
  });

  test('leaves the control in place for a reader who is not on the dash_ token', () => {
    const view = fixtureView([reauthSource()]);

    const page = renderDashboardHtmlRoute({
      url: dashboardUrl(),
      view,
      options: { now: NOW, controlSessionCsrfToken: 'csrf-fixture' },
    });

    expect(page.html).toContain('<form class="rowform"');
    expect(page.html).toContain('data-connect-kind="oauth"');
    expect(page.html).not.toContain('data-control-session-kind="unlock"');
  });

  test('a valid dashboard control session unlocks source actions on the dash_ URL', () => {
    const view = fixtureView([reauthSource()]);
    const page = renderDashboardHtmlRoute({
      url: dashboardUrl('?token=dash_fixture123'),
      view,
      options: { now: NOW, controlSessionCsrfToken: 'csrf-fixture' },
    });

    expect(page.html).toContain('data-connect-kind="oauth"');
    expect(page.html).toContain('var csrfToken = "csrf-fixture"');
  });

  test('still reads a dash_ token as read-only under a caller-set base path', () => {
    const view = fixtureView([reauthSource()]);

    const page = renderDashboardHtmlRoute({
      url: dashboardUrl('?token=dash_fixture123'),
      view,
      options: { now: NOW, basePath: '/dashboard?view=all' },
    });

    expect(page.html).not.toContain('data-connect-kind="oauth"');
    // Locked, and pointing at the setup gate under the caller's base path.
    expect(page.html).toContain('href="/dashboard?view=all&amp;setup#dashboard-controls"');
  });

  test('a caller-set base path outranks the token fold-in', () => {
    const view = fixtureView([connectedSource()]);

    const page = renderDashboardHtmlRoute({
      url: dashboardUrl('?token=dash_fixture123'),
      view,
      options: { now: NOW, basePath: '/dashboard?view=all' },
    });

    expect(page.html).not.toContain('token=dash_fixture123&');
    expect(page.html).toMatch(/\/dashboard\?view=all(&|&amp;)source=gmail\.email/);
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
      answer_ready_sources: connected,
      needs_attention_sources: 0,
      total_indexed_items: 0,
      total_content_ready_items: 0,
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
        suggestion: 'What do you see in my sources so far?',
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

function connectedSource(): DashboardSourceCard {
  return {
    corpus_id: 'internal.email',
    source_id: 'gmail.email',
    label: 'Gmail',
    provider: 'gmail',
    family: 'email',
    trust_domain: 'internal',
    configured: true,
    freshness: { label: 'Last checked 12 minutes ago', hours: 0.2, threshold_hours: 26, stale: false },
    coverage: { indexed_items: 1200, content_ready_items: 1200, embedded_items: 3400, needs_review_items: 0 },
    ingestion_health: {
      coverage_percent: 100,
      stuck_count: 0,
      drain_state: 'enabled',
      label: '100.0% covered; 0 stuck',
    },
    tier_composition: [
      { trust_domain: 'internal', label: 'Internal', indexed_items: 1200, content_ready_items: 1200 },
    ],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'ready', label: 'Ready for questions' },
    connection: { state: 'synced', label: 'synced 12 minutes ago', action: { kind: 'none' }, handles: [] },
  };
}

/** Connected once, expired since: the row that carries a real control. */
function reauthSource(): DashboardSourceCard {
  return {
    ...connectedSource(),
    freshness: { label: 'Last checked 3 days ago; refresh is late', hours: 74, threshold_hours: 26, stale: true },
    answer_readiness: { state: 'needs_attention', label: 'Reauthenticate this source' },
    connection: {
      state: 'reauth_required',
      label: 'reauth required',
      action: { kind: 'oauth', source: 'gmail', label: 'Reauthenticate' },
      handles: ['gmail:primary'],
    },
  };
}

function disconnectedSource(): DashboardSourceCard {
  return {
    ...connectedSource(),
    configured: false,
    freshness: { label: 'Waiting for the first sync', stale: false },
    coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0, needs_review_items: 0 },
    tier_composition: [],
    answer_readiness: { state: 'disconnected', label: 'Connect this source' },
    connection: {
      state: 'not_connected',
      label: 'not connected',
      action: { kind: 'oauth', source: 'gmail', label: 'Connect' },
      handles: [],
    },
  };
}

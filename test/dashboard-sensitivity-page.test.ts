import { describe, expect, test } from 'bun:test';
import {
  DASHBOARD_HTML_PATH,
  DASHBOARD_SENSITIVITY_QUERY_PARAM,
  renderDashboardHtmlRoute,
} from '../src/workers/dashboard/index.ts';
import {
  renderDashboardSensitivityBody,
  renderDashboardSensitivityPage,
} from '../src/workers/dashboard/pages/sensitivity.ts';
import type {
  DashboardSensitivity,
  DashboardSensitivityTiers,
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('dashboard sensitivity categories', () => {
  test('lists the owner categories with their own words and the tier they raise into', () => {
    const html = renderDashboardSensitivityBody(fixtureView({ sensitivity: fixtureSensitivity() }));

    expect(html).toContain('<div class="sect">Secure categories</div>');
    expect(html).toContain('<span class="name">Financial</span>');
    expect(html).toContain('statements, tax, banking');
    expect(html).toContain('Secure (S4) · 12 match terms');
    expect(html).toContain('<span class="name">Credentials</span>');
    expect(html).toContain('Secrets (S5) · 1 match term');
  });

  test('carries the count of match terms and never a term, a pattern or a note', () => {
    const view = fixtureView({
      sensitivity: {
        configured: true,
        editable: false,
        categories: [{
          id: 'financial',
          label: 'Financial',
          interpretation: 'statements, tax, banking',
          target_tier_name: 'secure',
          target_trust_tier: 'S4',
          target_trust_domain: 'secure_local',
          match_terms: 12,
          // Fields the contract deliberately withholds. If a later data leg
          // ever emits them, this page must still not print them.
          ...{
            notes: 'everything from statements@chase.com',
            match: { keywords: ['tax'], senderPatterns: ['statements@chase.com'], pathPatterns: ['/Finance'] },
          },
        }],
      } as DashboardSensitivity,
    });

    const html = renderDashboardSensitivityBody(view);

    expect(html).toContain('12 match terms');
    expect(html).not.toContain('statements@chase.com');
    expect(html).not.toContain('/Finance');
    expect(html).not.toContain('keywords');
  });

  test('says one plain sentence when no map is configured, and invents no rows', () => {
    const html = renderDashboardSensitivityBody(fixtureView());

    expect(html).toContain('<div class="sect">Secure categories</div>');
    expect(html).toContain('No secure categories are configured.');
    expect(html).not.toContain('Financial');
    expect(html).not.toContain('Health');
    expect(html).not.toContain('Therapy');
  });

  test('says the same sentence for a map that holds no categories', () => {
    const html = renderDashboardSensitivityBody(
      fixtureView({ sensitivity: { configured: true, editable: false, categories: [] } }),
    );

    expect(html).toContain('No secure categories are configured.');
    expect(html).not.toContain('class="catrow"');
  });

  test('offers no remove, add or guidance control, and claims no preset or added date', () => {
    const html = renderDashboardSensitivityPage(
      fixtureView({ sensitivity: fixtureSensitivity(), sensitivity_tiers: fixtureTiers() }),
      { now: NOW },
    );

    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('×');
    expect(html).not.toContain('added ');
    expect(html).not.toContain('preset');
    // The removal sheet promised a migration receipt no route can produce.
    expect(html).not.toContain('Keep Secure');
    expect(html).not.toContain('migrate');
  });

  test('escapes a category label rather than letting it reach the page as markup', () => {
    const html = renderDashboardSensitivityBody(fixtureView({
      sensitivity: {
        configured: true,
        editable: false,
        categories: [{
          id: 'x',
          label: '<script>alert(1)</script>',
          interpretation: '"quoted" & odd',
          target_tier_name: 'secure',
          target_trust_tier: 'S4',
          target_trust_domain: 'secure_local',
          match_terms: 0,
        }],
      },
    }));

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp; odd');
    // No match terms means no trailing separator dangling after the tier.
    expect(html).toContain('<span class="tier">Secure (S4)</span>');
  });
});

describe('dashboard sensitivity tiers', () => {
  test('renders the four policy rows with a word beside every mark', () => {
    const html = renderDashboardSensitivityBody(fixtureView({ sensitivity_tiers: fixtureTiers() }));

    expect(html).toContain('<div class="sect gap">Tiers</div>');
    expect(html).toContain('<th>Local models</th>');
    expect(html).toContain('<th>Venice</th>');
    expect(html).toContain('<th>Frontier cloud</th>');
    expect(html).toContain('<td class="tname">Secrets</td><td>S5</td>');
    expect(html).toContain('Refused before storage');
    // Secrets is refused everywhere, including locally.
    expect(html).toContain('<td class="pm"><span aria-hidden="true">✕</span><span class="vh">Not permitted</span></td>');
    expect(html).toContain('<td class="pm yes"><span aria-hidden="true">✓</span><span class="vh">Permitted</span></td>');
  });

  test('states that the columns are permission and not connection', () => {
    const html = renderDashboardSensitivityBody(fixtureView({ sensitivity_tiers: fixtureTiers() }));

    expect(html).toContain('what the policy permits, not what is connected');
  });

  test('claims no item count for any tier', () => {
    const html = renderDashboardSensitivityBody(fixtureView({
      sensitivity: fixtureSensitivity(),
      sensitivity_tiers: fixtureTiers(),
    }));

    // No index on items.trust_tier exists, so no row may carry a population.
    expect(html).not.toMatch(/\d[\d,]*\s+items/);
    expect(html).not.toContain('129,885');
  });

  test('renders no tier block at all when the policy field is absent', () => {
    const html = renderDashboardSensitivityBody(fixtureView({ sensitivity: fixtureSensitivity() }));

    expect(html).not.toContain('Tiers');
    expect(html).not.toContain('<th>Venice</th>');
    // The categories the map really holds still render.
    expect(html).toContain('<span class="name">Financial</span>');
  });
});

describe('dashboard sensitivity page shell', () => {
  test('names the page in the crumb and dates it from generated_at alone', () => {
    const html = renderDashboardSensitivityPage(fixtureView({ sensitivity_tiers: fixtureTiers() }), { now: NOW });

    expect(html).toContain('<title>Olympus / Sensitivity</title>');
    expect(html).toContain('checked 12s ago');
    // No status word: policy is not Fresh or Working.
    expect(html).not.toContain('Working');
    expect(html).not.toContain('Fresh');
  });
});

describe('dashboard sensitivity route', () => {
  test('serves the page by name, before any source is connected', () => {
    const view = fixtureView();
    view.sources = [];
    view.first_run = true;

    const page = renderDashboardHtmlRoute({
      url: new URL(`http://worker.test${DASHBOARD_HTML_PATH}?${DASHBOARD_SENSITIVITY_QUERY_PARAM}`),
      view,
      options: { now: NOW },
    });

    expect(page.status).toBe(200);
    expect(page.html).toContain('<title>Olympus / Sensitivity</title>');
  });

  test('keeps the read-only view token on the way back home', () => {
    const page = renderDashboardHtmlRoute({
      url: new URL(
        `http://worker.test${DASHBOARD_HTML_PATH}?${DASHBOARD_SENSITIVITY_QUERY_PARAM}&token=dash_abc`,
      ),
      view: fixtureView({ sensitivity_tiers: fixtureTiers() }),
      options: { now: NOW },
    });

    expect(page.html).toContain('href="/dashboard?token=dash_abc"');
  });
});

function fixtureSensitivity(): DashboardSensitivity {
  return {
    configured: true,
    editable: false,
    categories: [
      {
        id: 'financial',
        label: 'Financial',
        interpretation: 'statements, tax, banking',
        target_tier_name: 'secure',
        target_trust_tier: 'S4',
        target_trust_domain: 'secure_local',
        match_terms: 12,
      },
      {
        id: 'credentials',
        label: 'Credentials',
        interpretation: 'passwords and keys',
        target_tier_name: 'secrets',
        target_trust_tier: 'S5',
        target_trust_domain: 'secure_local',
        match_terms: 1,
      },
    ],
  };
}

function fixtureTiers(): DashboardSensitivityTiers {
  return {
    policy_basis: 'enforced',
    tiers: [
      {
        name: 'Secrets',
        tier_label: 'S5',
        meaning: 'Refused before storage — content never stored and never reaches any model',
        local: false,
        venice: false,
        frontier: false,
      },
      {
        name: 'Secure',
        tier_label: 'S4',
        meaning: 'Kept in your secure store — local models and Venice only, never frontier cloud',
        local: true,
        venice: true,
        frontier: false,
      },
      {
        name: 'Private',
        tier_label: 'S1–S3',
        meaning: 'Everyday mail, files, and notes',
        local: true,
        venice: true,
        frontier: true,
      },
      {
        name: 'Public',
        tier_label: 'S0',
        meaning: 'Freely shareable material',
        local: true,
        venice: true,
        frontier: true,
      },
    ],
  };
}

function fixtureCard(): DashboardSourceCard {
  return {
    corpus_id: 'internal.email',
    source_id: 'gmail.email',
    label: 'Gmail',
    provider: 'gmail',
    family: 'email',
    trust_domain: 'internal',
    configured: true,
    freshness: { label: 'Last checked 6 minutes ago', hours: 0.1, threshold_hours: 6, stale: false },
    coverage: {
      indexed_items: 129_885,
      content_ready_items: 129_885,
      embedded_items: 129_885,
      needs_review_items: 0,
    },
    ingestion_health: {
      coverage_percent: 100,
      stuck_count: 0,
      drain_state: 'enabled',
      label: '100% covered; nothing stuck',
    },
    tier_composition: [
      { trust_domain: 'internal', label: 'Internal', indexed_items: 129_885, content_ready_items: 129_885 },
    ],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'ready', label: 'Ready for questions' },
    connection: {
      state: 'synced',
      label: 'synced 6 minutes ago',
      action: { kind: 'none' },
      handles: ['gmail.personal'],
    },
  };
}

function fixtureView(
  additive: {
    sensitivity?: DashboardSensitivity;
    sensitivity_tiers?: DashboardSensitivityTiers;
  } = {},
): SourceDashboardViewModel {
  const sources = [fixtureCard()];
  const view: SourceDashboardViewModel = {
    kind: 'source_dashboard',
    generated_at: '2026-07-02T11:59:48.000Z',
    summary: {
      configured_sources: 1,
      connected_sources: 1,
      answer_ready_sources: 1,
      needs_attention_sources: 0,
      total_indexed_items: 129_885,
      total_content_ready_items: 129_885,
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
  return {
    ...view,
    ...(additive.sensitivity === undefined ? {} : { sensitivity: additive.sensitivity }),
    ...(additive.sensitivity_tiers === undefined ? {} : { sensitivity_tiers: additive.sensitivity_tiers }),
  };
}

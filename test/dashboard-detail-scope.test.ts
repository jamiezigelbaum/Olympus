import { describe, expect, test } from 'bun:test';
import { renderDashboardDetailPage } from '../src/workers/dashboard/pages/detail.ts';
import type {
  DashboardExcludedSource,
  DashboardNeedsReview,
  DashboardNeedsReviewActor,
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('dashboard detail scope', () => {
  test('names each rule, its disposition and how many criteria it carries', () => {
    const html = detailHtml({
      scopes: [fixtureScope({
        entries: [
          { rule_id: 'newsletters', prefixes: 3, modes: ['exclude'], kinds: ['path_prefix'] },
          { rule_id: 'shared-drive', prefixes: 1, modes: ['metadata_only'], kinds: ['folder_id'] },
        ],
      })],
    });

    expect(html).toContain('<div class="dsect">Scope</div>');
    expect(html).toContain('<b class="rid">newsletters</b> <span class="what">— invisible · 3 folders</span>');
    expect(html).toContain('<b class="rid">shared-drive</b> <span class="what">— metadata only · 1 folder</span>');
    expect(html).toContain('Invisible rules keep items out entirely');
  });

  test('calls a media criterion what it is rather than a folder', () => {
    const html = detailHtml({
      scopes: [fixtureScope({
        entries: [{ rule_id: 'camera-roll', prefixes: 2, modes: ['exclude'], kinds: ['media'] }],
      })],
    });

    expect(html).toContain('— invisible · 2 rule criteria');
    expect(html).not.toContain('2 folders');
  });

  test('says when a rule can bite nothing on this source', () => {
    const html = detailHtml({
      scopes: [fixtureScope({
        entries: [{ rule_id: 'blanket-paths', prefixes: 4, modes: ['exclude'], kinds: ['path_prefix'] }],
        unenforceable_rule_ids: ['blanket-paths'],
      })],
    });

    expect(html).toContain('nothing here for this source to enforce');
  });

  test('carries no prefix, folder name or reason into the page', () => {
    const html = detailHtml({
      scopes: [fixtureScope({
        entries: [{ rule_id: 'newsletters', prefixes: 3, modes: ['exclude'], kinds: ['path_prefix'] }],
      })],
    });

    expect(html).not.toContain('/3 Resources');
    expect(html).not.toContain('Label: Newsletters');
    // The check-a-path box has no evaluate route and would put an address in a
    // request from a page reachable with the read-only token.
    expect(html).not.toContain('Check an email');
    expect(html).not.toContain('name="path"');
  });

  test('states the purge and strip debts as themselves, never as a per-rule count', () => {
    const html = detailHtml({
      scopes: [fixtureScope({
        items_present: 2_410,
        items_unevaluable: 12,
        items_metadata_only_content_present: 18,
        entries: [{ rule_id: 'newsletters', prefixes: 3, modes: ['exclude'], kinds: ['path_prefix'] }],
      })],
    });

    expect(html).toContain('2,410 items indexed before these rules are still stored under them — purge pending');
    expect(html).toContain('12 with a path the gate cannot read');
    expect(html).toContain('18 items still carry content a metadata-only rule says they should not — strip pending');
    // The mockup hung "2,410 skipped" off one rule row; nothing attributes items
    // to a rule.
    expect(html).not.toContain('2,410 skipped');
  });

  test('renders no debt line while both maintenance debts are clear', () => {
    const html = detailHtml({
      scopes: [fixtureScope({
        entries: [{ rule_id: 'newsletters', prefixes: 3, modes: ['exclude'], kinds: ['path_prefix'] }],
      })],
    });

    expect(html).not.toContain('purge pending');
    expect(html).not.toContain('strip pending');
  });

  test('offers the picker as a control-session link only where the route exists', () => {
    const withPicker = detailHtml({
      pickerAvailable: true,
      scopes: [fixtureScope({
        entries: [{ rule_id: 'newsletters', prefixes: 3, modes: ['exclude'], kinds: ['path_prefix'] }],
      })],
    });
    const withoutPicker = detailHtml({
      scopes: [fixtureScope({
        entries: [{ rule_id: 'newsletters', prefixes: 3, modes: ['exclude'], kinds: ['path_prefix'] }],
      })],
    });

    expect(withPicker).toContain('data-control-link="/dashboard/dispositions"');
    expect(withPicker).not.toContain('href="/dashboard/dispositions"');
    expect(withPicker).toContain('needs the worker token');
    expect(withoutPicker).not.toContain('/dashboard/dispositions');
  });

  test('renders no scope section for a source no rule names', () => {
    const html = detailHtml({});

    expect(html).not.toContain('<div class="dsect">Scope</div>');
  });

  test('attributes rules by corpus id, never by source id', () => {
    // The disposition store, the cards and the ledger name sources in three
    // different spaces, and 'secure_local.drive.docs' belongs to no card.
    const html = detailHtml({
      scopes: [fixtureScope({
        corpus_ids: ['secure_local.drive.docs'],
        source_id: 'google_drive.personal',
        entries: [{ rule_id: 'other-corpus', prefixes: 2, modes: ['exclude'], kinds: ['path_prefix'] }],
      })],
    });

    expect(html).not.toContain('other-corpus');
    expect(html).not.toContain('<div class="dsect">Scope</div>');
  });

  test('picks the entry whose corpus really is this card', () => {
    const html = detailHtml({
      scopes: [
        fixtureScope({
          corpus_ids: ['secure_local.drive.docs'],
          entries: [{ rule_id: 'other-corpus', prefixes: 2, modes: ['exclude'], kinds: ['path_prefix'] }],
        }),
        fixtureScope({
          corpus_ids: ['internal.drive.docs'],
          entries: [{ rule_id: 'mine', prefixes: 1, modes: ['exclude'], kinds: ['path_prefix'] }],
        }),
      ],
    });

    expect(html).toContain('<b class="rid">mine</b>');
    expect(html).not.toContain('other-corpus');
  });
});

describe('dashboard detail connection action', () => {
  test('offers no reconnect row for a source whose connection is fine', () => {
    const html = detailHtml({});

    expect(html).not.toContain('class="attncard banner"');
  });

  test('carries the real control for a source that needs reconnecting', () => {
    const html = detailHtml({
      connection: {
        state: 'reauth_required',
        label: 'reauth required',
        action: { kind: 'oauth', source: 'google-drive', label: 'Reauthenticate' },
        handles: ['google:primary'],
      },
    });

    // The far end of home's click-through has to be able to finish the job,
    // and it leads with the act rather than with the diagnosis (owner ruling,
    // 2026-08-19): the state itself is still stated, in the checks below.
    //
    // The "What to do" heading went with the 2026-08-24 redesign — the act is
    // now the attention banner, which is the page's only error surface — but
    // everything this test guards about the act itself is unchanged.
    expect(html).toContain('class="attncard banner"');
    expect(html).toContain('Press Reauthenticate and approve Olympus on Google Drive&#39;s own consent page.');
    expect(html).toContain('(reauth required) == connected');
    expect(html).toContain('data-connect-kind="oauth"');
    expect(html).toContain('<input type="hidden" name="source" value="google-drive">');
    expect(html).toContain('>Reauthenticate</button>');
  });

  test('degrades that control to a setup link for a read-only reader', () => {
    const html = detailHtml({
      readOnly: true,
      connection: {
        state: 'reauth_required',
        label: 'reauth required',
        action: { kind: 'oauth', source: 'google-drive', label: 'Reauthenticate' },
        handles: ['google:primary'],
      },
    });

    expect(html).not.toContain('data-connect-kind="oauth"');
    expect(html).toContain('<a class="btn" href="/dashboard?setup">Reauthenticate</a>');
    expect(html).toContain('needs the worker token');
  });

  test('offers a copyable agent prompt where no dashboard control route exists', () => {
    const html = detailHtml({
      connection: {
        state: 'not_connected',
        label: 'not connected',
        action: {
          kind: 'guided_session',
          source: 'telegram',
          label: 'Pairing required',
          instructions: [
            'Telegram pairs with a phone-number login on this computer.',
            'Ask your agent to start Telegram pairing; this card updates once the login completes.',
          ],
        },
        handles: [],
      },
    });

    // Owner ruling, 2026-08-19: no diagnosis without remediation, and no dead
    // button — a state with no route says where the act happens, in the
    // definition's own words. It says it in the banner now.
    expect(html).toContain('class="attncard banner"');
    expect(html).toContain('Ask your agent to start Telegram pairing');
    expect(html).toContain('>Ask your agent</button>');
    expect(html).toContain('>Copy prompt</button>');
    // The checks tip still names the state, which is a fact, not a control.
    expect(html).toContain('[CONNECTION]');
  });
});

describe('dashboard detail sensitivity section', () => {
  test('heads the trust-domain table with the blessed section name and a way to the tiers', () => {
    const html = detailHtml({});

    expect(html).toContain('<div class="dsect">Sensitivity</div>');
    expect(html).toContain('<th>Tier</th>');
    expect(html).toContain('href="/dashboard?sensitivity"');
    expect(html).toContain('About tiers →');
  });

  test('carries the reader token into the about-tiers link', () => {
    const html = detailHtml({ basePath: '/dashboard?token=dash_abc' });

    expect(html).toMatch(/\/dashboard\?token=dash_abc(&|&amp;)sensitivity/);
  });

  test('states the split in the table alone, never as an arrow line above it', () => {
    const split = detailHtml({
      tierComposition: [
        { trust_domain: 'internal', label: 'Internal', indexed_items: 129_885, content_ready_items: 129_000 },
        { trust_domain: 'secure_local', label: 'Secure local', indexed_items: 493, content_ready_items: 400 },
      ],
    });

    // The owner's ruling: the table carries the composition, and the "17 →
    // Private · 1 → Secure" formulation above it is gone for good.
    expect(split).not.toContain('class="tierline"');
    expect(split).not.toContain('→ <b>');
    expect(split).toContain('<td>Internal</td><td>129,885</td>');
    expect(split).toContain('<td>Secure local</td><td>493</td>');
  });

  test('claims no S-tier count and no refusal figure', () => {
    const html = detailHtml({
      tierComposition: [
        { trust_domain: 'internal', label: 'Internal', indexed_items: 129_885, content_ready_items: 129_000 },
        { trust_domain: 'secure_local', label: 'Secure local', indexed_items: 493, content_ready_items: 400 },
      ],
    });

    expect(html).not.toContain('S4');
    expect(html).not.toContain('refused');
  });

  test('keeps the token on the link out to the tiers page', () => {
    const html = detailHtml({ basePath: '/dashboard?token=dash_abc' });

    expect(html).toContain('href="/dashboard?token=dash_abc&amp;sensitivity"');
  });
});

describe('dashboard detail needs review', () => {
  test('counts the items and names only the reasons that are not zero', () => {
    const html = detailHtml({
      needsReview: {
        total: 12,
        reasons: [
          {
            key: 'qa_visible_gaps',
            label: 'Text not extracted yet',
            count: 8,
            who_acts: 'automatic',
            actor_note: 'queued for the text sweep',
          },
          {
            key: 'qa_failed_needs_operator',
            label: 'Extraction failed',
            count: 4,
            who_acts: 'needs_you',
            actor_note: 'retried once already, so these wait for you',
          },
        ],
      },
    });

    expect(html).toContain('<div class="dsect">Needs review — 12</div>');
    // Each chip now carries who acts on it, so a reader mid-row never has to
    // scroll back to a group heading to learn whether the number is their work.
    expect(html).toContain('<span class="chip"><b>8</b> Text not extracted yet — queued for the text sweep</span>');
    expect(html).toContain('<span class="chip"><b>4</b> Extraction failed — retried once already, so these wait for you</span>');
    expect(html).not.toContain('Metadata only');
  });

  test('splits the total into what is handled and what is homework', () => {
    const html = detailHtml({
      needsReview: {
        total: 3_913,
        reasons: [
          {
            key: 'text_out_of_date',
            label: 'Text is from an older version',
            count: 734,
            who_acts: 'automatic',
            actor_note: 'read again on the next pass over the file',
          },
          {
            key: 'metadata_only',
            label: 'Metadata only',
            count: 1_324,
            who_acts: 'automatic',
            actor_note: 'queued for the text sweep',
          },
          {
            key: 'scanned_needs_better_reader',
            label: 'Scanned pages need a better reader',
            count: 63,
            who_acts: 'automatic',
            actor_note: 'passed to the local vision reader',
          },
          {
            key: 'text_looks_unreliable',
            label: 'Extracted text looks unreliable',
            count: 1_549,
            who_acts: 'automatic',
            actor_note: 'the local text sweep re-reads these',
          },
          {
            key: 'image_only_no_text',
            label: 'Image-only, no text read yet',
            count: 49,
            who_acts: 'needs_you',
            actor_note: 'no reader is switched on for these yet',
          },
          {
            key: 'extraction_failed',
            label: 'Extraction failed',
            count: 194,
            who_acts: 'needs_you',
            actor_note: 'retried once already, so these wait for you',
          },
        ],
      },
    });

    // The live number the owner read as 3,913 items of homework. 94% of it is
    // machine queue depth, and the page now says so above any chip.
    expect(html).toContain('<div class="dsect">Needs review — 3,913</div>');
    expect(html).toContain('3,670 handled automatically · 243 need you.');
    expect(html).toContain('Olympus is handling these');
    expect(html).toContain('These need you');
    // The split is stated before the chips, so the total above can never be
    // read as a to-do list again.
    expect(html.indexOf('3,670 handled automatically')).toBeLessThan(html.indexOf('Olympus is handling these'));
    expect(html.indexOf('Olympus is handling these')).toBeLessThan(html.indexOf('These need you'));
  });

  test('says so plainly when nothing in the review total is anyone\'s work', () => {
    const html = detailHtml({
      needsReview: {
        total: 8,
        reasons: [{
          key: 'metadata_only',
          label: 'Metadata only',
          count: 8,
          who_acts: 'automatic',
          actor_note: 'queued for the text sweep',
        }],
      },
    });

    expect(html).toContain('All of it is handled automatically — nothing here needs you.');
    expect(html).not.toContain('These need you');
  });

  test('names no item and offers nothing to open', () => {
    const html = detailHtml({
      needsReview: {
        total: 1,
        reasons: [{ key: 'qa_visible_gaps', label: 'Text not extracted yet', count: 1 }],
      },
    });

    expect(html).not.toContain('Q2-invoice.pdf');
    expect(html).not.toContain('>Open<');
    const section = html.slice(html.indexOf('Needs review'));
    expect(section).not.toContain('<button');
    expect(section).not.toContain('<a ');
  });

  test('drops a reason the data leg left at zero rather than printing it', () => {
    const html = detailHtml({
      needsReview: {
        total: 3,
        reasons: [
          { key: 'qa_visible_gaps', label: 'Text not extracted yet', count: 3 },
          { key: 'metadata_sync_folders_failed', label: 'Folders failed to sync', count: 0 },
        ],
      },
    });

    expect(html).toContain('<b>3</b> Text not extracted yet');
    expect(html).not.toContain('Folders failed to sync');
  });

  test('renders no section for a card with nothing to review', () => {
    expect(detailHtml({})).not.toContain('Needs review');
    expect(detailHtml({ needsReview: { total: 0, reasons: [] } })).not.toContain('Needs review');
  });
});

describe('dashboard detail composition', () => {
  test('reads scope, then sensitivity, then the run evidence', () => {
    const html = detailHtml({
      scopes: [fixtureScope({
        entries: [{ rule_id: 'newsletters', prefixes: 3, modes: ['exclude'], kinds: ['path_prefix'] }],
      })],
      needsReview: {
        total: 2,
        reasons: [{ key: 'qa_visible_gaps', label: 'Text not extracted yet', count: 2 }],
      },
    });

    expect(html.indexOf('>Scope<')).toBeLessThan(html.indexOf('>Sensitivity<'));
    expect(html.indexOf('>Sensitivity<')).toBeLessThan(html.indexOf('Needs review'));
    // The foot stays last: the masking test slices from the first .foot.
    expect(html.indexOf('Needs review')).toBeLessThan(html.indexOf('class="foot"'));
  });
});

function fixtureScope(
  overrides: Partial<DashboardExcludedSource> = {},
): DashboardExcludedSource {
  return {
    corpus_ids: ['internal.drive.docs'],
    source_id: 'google_drive.personal',
    rules: 1,
    prefixes: 3,
    metadata_only_prefixes: 0,
    items_present: 0,
    items_unevaluable: 0,
    items_metadata_only_content_present: 0,
    entries: [],
    ...overrides,
  };
}

/**
 * The review breakdown as a fixture writes it: the counts and labels under
 * test, without the who-acts fields or the derived halves. `detailHtml` fills
 * those in, so these fixtures keep testing what they were written to test —
 * which reasons render — and the split is exercised by its own tests.
 */
interface NeedsReviewFixture {
  total: number;
  reasons: Array<{
    key: string;
    label: string;
    count: number;
    who_acts?: DashboardNeedsReviewActor;
    actor_note?: string;
  }>;
}

function needsReviewFixture(input: NeedsReviewFixture): DashboardNeedsReview {
  const reasons = input.reasons.map((reason) => ({
    key: reason.key,
    label: reason.label,
    count: reason.count,
    who_acts: reason.who_acts ?? ('automatic' as DashboardNeedsReviewActor),
    actor_note: reason.actor_note ?? 'queued for the text sweep',
  }));
  let automatic = 0;
  let operator = 0;
  for (const reason of reasons.filter((candidate) => candidate.count > 0)) {
    if (reason.who_acts === 'automatic') automatic += reason.count;
    else operator += reason.count;
  }
  return { total: input.total, automatic_total: automatic, operator_total: operator, reasons };
}

interface DetailFixtureInput {
  scopes?: DashboardExcludedSource[];
  needsReview?: NeedsReviewFixture;
  tierComposition?: DashboardSourceCard['tier_composition'];
  pickerAvailable?: boolean;
  basePath?: string;
  readOnly?: boolean;
  connection?: DashboardSourceCard['connection'];
}

function detailHtml(input: DetailFixtureInput): string {
  const card: DashboardSourceCard = {
    ...fixtureCard(),
    ...(input.tierComposition === undefined ? {} : { tier_composition: input.tierComposition }),
    ...(input.needsReview === undefined ? {} : { needs_review: needsReviewFixture(input.needsReview) }),
    ...(input.connection === undefined ? {} : { connection: input.connection }),
  };
  const view = fixtureView(card, input);
  return renderDashboardDetailPage(view, card.source_id, {
    now: NOW,
    ...(input.basePath === undefined ? {} : { basePath: input.basePath }),
    ...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }),
  }) ?? '';
}

function fixtureCard(): DashboardSourceCard {
  return {
    corpus_id: 'internal.drive.docs',
    source_id: 'google_drive.docs',
    label: 'Google Drive',
    provider: 'google_drive',
    family: 'file',
    trust_domain: 'internal',
    configured: true,
    freshness: { label: 'Last checked 41 minutes ago', hours: 0.68, threshold_hours: 26, stale: false },
    coverage: {
      indexed_items: 129_885,
      content_ready_items: 129_000,
      embedded_items: 129_000,
      needs_review_items: 0,
    },
    ingestion_health: {
      coverage_percent: 100,
      stuck_count: 0,
      drain_state: 'enabled',
      label: '100% covered; nothing stuck',
    },
    tier_composition: [
      { trust_domain: 'internal', label: 'Internal', indexed_items: 129_885, content_ready_items: 129_000 },
    ],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'ready', label: 'Ready for questions' },
    connection: {
      state: 'synced',
      label: 'synced 41 minutes ago',
      action: { kind: 'none' },
      handles: ['google_drive.personal'],
    },
  };
}

function fixtureView(card: DashboardSourceCard, input: DetailFixtureInput): SourceDashboardViewModel {
  const view: SourceDashboardViewModel = {
    kind: 'source_dashboard',
    generated_at: '2026-07-02T11:59:48.000Z',
    summary: {
      configured_sources: 1,
      connected_sources: 1,
      answer_ready_sources: 1,
      needs_attention_sources: 0,
      total_indexed_items: card.coverage.indexed_items,
      total_content_ready_items: card.coverage.content_ready_items,
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
    folder_picker: {
      available: input.pickerAvailable === true,
      label: 'Choose what gets ingested',
      path: '/dashboard/dispositions',
      rules: 0,
    },
    sources: [card],
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
    excluded_by_configuration: {
      ...view.excluded_by_configuration,
      ...(input.scopes === undefined ? {} : { by_source: input.scopes }),
    },
  };
}

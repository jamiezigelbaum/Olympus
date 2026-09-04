import { describe, expect, test } from 'bun:test';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import { buildSourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import type {
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import { renderDashboardSetupPage } from '../src/workers/dashboard/pages/setup.ts';

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('dashboard first-run page', () => {
  test('sorts rows into sections by connection state, attention first', () => {
    const html = renderDashboardSetupPage(viewWith([
      card('gmail.email', 'Gmail', {
        configured: true,
        connection: connection({ state: 'syncing', label: 'syncing' }),
      }),
      card('dropbox.files', 'Dropbox', {
        configured: true,
        connection: connection({
          state: 'reauth_required',
          label: 'reauth required',
          action: { kind: 'oauth', source: 'dropbox', label: 'Reauthenticate' },
        }),
      }),
      card('google_drive.docs', 'Google Drive', {
        connection: connection({
          state: 'awaiting_consent',
          label: 'awaiting browser consent',
          action: { kind: 'oauth', source: 'google-drive', label: 'Connect' },
          pending: {
            started_at: '2026-07-02T11:55:00.000Z',
            expires_at: '2026-07-02T12:09:00.000Z',
            expires_in_minutes: 9,
          },
        }),
      }),
      card('readwise.library', 'Readwise', {
        configured: true,
        connection: connection({ state: 'synced', label: 'synced 41 minutes ago' }),
      }),
      card('x.bookmarks', 'X bookmarks', {
        connection: connection({
          state: 'not_connected',
          label: 'not connected',
          action: { kind: 'oauth', source: 'x', label: 'Connect' },
        }),
      }),
    ]));

    const order = [
      '▲ Needs you — 1',
      'Working — 1',
      'Connecting — 1',
      'Fresh — 1',
      'Available to connect — 1',
    ].map((heading) => html.indexOf(heading));
    expect(order).not.toContain(-1);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(segmentFor(html, 'Dropbox')).toContain('reauth required');
    expect(segmentFor(html, 'Google Drive')).toContain('waiting for you to approve in the Google Drive tab · expires in 9m');
    expect(segmentFor(html, 'Readwise')).toContain('synced 41 minutes ago');
    // Every engaged row click-throughs to its detail page — home's rule — so
    // no warning on this page is a dead end.
    expect(segmentFor(html, 'Dropbox')).toContain('href="/dashboard?source=dropbox.files"');
    expect(segmentFor(html, 'Readwise')).toContain('href="/dashboard?source=readwise.library"');
  });

  test('a Needs-you source whose app key is missing gets the setup sheet, not a dead end', () => {
    const html = renderDashboardSetupPage(viewWith([
      card('x.bookmarks', 'X bookmarks', {
        configured: true,
        connection: connection({
          state: 'reauth_required',
          label: 'reauth required',
          action: {
            kind: 'needs_setup',
            source: 'x',
            client_secret_required: true,
            label: 'Set up',
            instructions: setupInstructions(),
          },
        }),
      }),
    ]));

    const row = segmentFor(html, 'X bookmarks');
    expect(html).toContain('▲ Needs you — 1');
    // The same sheet-opening button and sheet the Available-to-connect row
    // gets: this is where home's "Set up" degradation link sends the reader.
    expect(row).toContain('data-sheet-toggle="#setup-x-bookmarks"');
    expect(html).toContain('id="setup-x-bookmarks"');
    expect(row).toContain('href="/dashboard?source=x.bookmarks"');
  });

  test('gives guided pairing a copyable agent prompt without inventing a control route', () => {
    const html = renderDashboardSetupPage(viewWith([
      card('telegram.messages', 'Telegram', {
        connection: connection({
          state: 'not_connected',
          label: 'not connected',
          action: {
            kind: 'guided_session',
            source: 'telegram',
            label: 'Pairing required',
            instructions: ['Telegram pairs with a phone-number login on this computer.'],
          },
        }),
      }),
      card('gmail.email', 'Gmail', {
        connection: connection({
          state: 'needs_setup',
          label: 'not connected',
          action: {
            kind: 'needs_setup',
            source: 'gmail',
            label: 'Set up',
            client_secret_required: true,
            instructions: setupInstructions(),
          },
        }),
      }),
      card('dropbox.files', 'Dropbox', {
        connection: connection({
          state: 'not_connected',
          label: 'not connected',
          action: { kind: 'oauth', source: 'dropbox', label: 'Connect' },
        }),
      }),
    ]));

    const telegram = segmentFor(html, 'Telegram');
    expect(telegram).toContain('>Ask your agent</button>');
    expect(telegram).toContain('>Copy prompt</button>');
    expect(telegram).not.toContain('data-connect-kind');
    expect(telegram).toContain('Telegram pairs with a phone-number login on this computer.');

    // needs_setup opens the one-time setup sheet: the copyable agent prompt
    // and the client-key form the oauth start route accepts.
    const gmail = segmentFor(html, 'Gmail');
    expect(gmail).toContain('data-sheet-toggle="#setup-gmail-email"');
    expect(gmail).toContain('>Set up</button>');
    expect(gmail).toContain('To read your mail, Olympus needs a free Google app key.');
    expect(gmail).toContain('Set up Gmail for Olympus and walk me through it step by step.');
    expect(gmail).toContain('data-connect-kind="oauth"');
    expect(gmail).toContain('<input type="hidden" name="source" value="gmail">');
    // A secret field never renders as a visible text input.
    expect(gmail).toContain('type="text" name="client_id" required');
    expect(gmail).toContain('type="password" name="client_secret" required');

    const dropbox = segmentFor(html, 'Dropbox');
    expect(dropbox).toContain('data-connect-kind="oauth"');
    expect(dropbox).toContain('<input type="hidden" name="source" value="dropbox">');
    expect(dropbox).toContain('>Connect</button>');
  });

  test('carries the connector prompt verbatim, with a working copy control', () => {
    const html = renderDashboardSetupPage(viewWith([]));

    expect(html).toContain('>Something else</span>');
    expect(html).toContain('data-sheet-toggle="#connector-sheet"');
    expect(html).toContain('>Build a connector</button>');
    expect(html).toContain('Read skills/create-connector/SKILL.md and follow it exactly.');
    expect(html).toContain('I’m working in my Olympus checkout. I want to add a new source connector for &lt;SOURCE&gt;.');
    expect(html).toContain('Keep the required CI check green.');
    expect(html).toContain('data-copy-target="#connector-sheet-prompt"');
    expect(html).toContain('>Copy prompt</button>');
    expect(html).toContain('navigator.clipboard.writeText');
  });

  test('states what a first ingest has landed and claims no fraction of an unknown total', () => {
    const html = renderDashboardSetupPage(viewWith([
      card('gmail.email', 'Gmail', {
        configured: true,
        connection: connection({ state: 'syncing', label: 'syncing' }),
        coverage: { indexed_items: 4812, content_ready_items: 1200, embedded_items: 0, needs_review_items: 0 },
        progress: { indexed_items_per_hour: 312, eta_minutes: 38 },
      }),
    ]));

    expect(segmentFor(html, 'Gmail')).toContain('first ingest · 4,812 indexed so far · ~38m left');
    // The provider-side total does not exist on the view model, so no bar.
    expect(html).not.toContain('class="bar"');
    expect(html).not.toContain('role="progressbar"');
  });

  test('drops the first-ingest claim once a source has been checked before', () => {
    const html = renderDashboardSetupPage(viewWith([
      card('dropbox.files', 'Dropbox', {
        configured: true,
        connection: connection({ state: 'syncing', label: 'syncing' }),
        coverage: { indexed_items: 44000, content_ready_items: 40000, embedded_items: 0, needs_review_items: 0 },
        freshness: { label: 'Last checked 2 hours ago', hours: 2, stale: false },
      }),
    ]));

    const dropbox = segmentFor(html, 'Dropbox');
    expect(dropbox).toContain('syncing · 44,000 indexed so far');
    expect(dropbox).not.toContain('first ingest');
  });

  test('renders no header count at all', () => {
    // Owner ruling 2026-08-19 evening: the "N of M connected" arithmetic is
    // noise — the groups already say what needs attention.
    const html = renderDashboardSetupPage(viewWith([
      card('gmail.email', 'Gmail', {
        configured: true,
        connection: connection({ state: 'syncing', label: 'syncing' }),
      }),
      card('x.bookmarks', 'X bookmarks', { connection: connection({}) }),
    ]));

    expect(html).not.toContain('<span class="meta">');
    // The arithmetic is gone from the HEADER; the summary card below still
    // names its two counts, and does so with two different words.
    expect(html).not.toMatch(/<span class="meta">[^<]*connected/);
    expect(html).not.toMatch(/<span class="meta">[^<]*\d+ of \d+/);
  });

  test('renders a real view model: only routes that exist get a button', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: emptyStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      // Dropbox is the one source whose OAuth client the operator registered,
      // so it is the one source whose connect route can complete from a button.
      oauthClientIds: { dropbox: 'olympus-dropbox-app' },
      now: NOW,
    });
    const html = renderDashboardSetupPage(view, { now: NOW });

    expect(view.onboarding.steps.map((step) => step.id)).toEqual([
      'security_preset',
      'dependencies',
      'credential_or_pairing',
      'scope',
      'initial_sync',
      'source_health',
      'cited_answer_readiness',
    ]);
    expect(html).toContain('aria-label="Setup summary"');
    expect(html).toContain('Security preset');
    // Two counts, two names: "0 sources ready" beside four Fresh cards read as
    // a contradiction (owner note, 2026-09-01).
    expect(html).toContain('<b>Sources</b><span>0 answer-ready · 0 connected</span>');
    expect(html).not.toContain('sources ready');
    expect(html).not.toContain('Advanced Google BYO required');
    expect(html).toContain('Available to connect — 7');
    expect(segmentFor(html, 'Dropbox')).toContain('<input type="hidden" name="source" value="dropbox">');
    // The api-key route rejects a body without `api_key`, so the form must
    // carry the field, not just the kind marker.
    expect(segmentFor(html, 'Readwise')).toContain('data-connect-kind="api_key"');
    expect(segmentFor(html, 'Readwise')).toContain('name="api_key"');
    // needs_setup sources carry the one-time setup sheet, whose form posts to
    // the oauth start route with the client key its instructions describe.
    for (const label of ['Gmail', 'Google Drive', 'X bookmarks']) {
      const segment = segmentFor(html, label);
      expect(segment).toContain('>Set up</button>');
      expect(segment).toContain('data-connect-kind="oauth"');
      expect(segment).toContain('name="client_id"');
    }
    // guided_session has no control route at all, so still no form.
    for (const label of ['Telegram', 'WhatsApp']) {
      expect(segmentFor(html, label)).not.toContain('data-connect-kind');
    }
    // Every card reached a section, and the connector row is the only extra.
    // Rows without a blurb render as .setrow.noblurb, so match the prefix.
    expect(html.split('<div class="setrow').length - 1).toBe(view.sources.length + 1);
  });

  test('connected rows expose bounded Disconnect instead of destructive delete', () => {
    const html = renderDashboardSetupPage(viewWith([
      card('dropbox.files', 'Dropbox', {
        configured: true,
        connection: connection({
          state: 'synced',
          label: 'synced 2 minutes ago',
          handles: ['dropbox.personal'],
          disconnect: {
            source_id: 'dropbox.files',
            label: 'Disconnect Dropbox',
            confirmation: 'Indexed data and developer-app registration stay. Olympus does not revoke provider-side access.',
            provider_revocation_url: 'https://www.dropbox.com/account/connected_apps',
          },
        }),
      }),
    ]));
    expect(html).toContain('data-disconnect-kind="disconnect"');
    expect(html).toContain('Disconnect Dropbox');
    expect(html).toContain('Provider access');
    expect(html).not.toContain('Delete data');
  });

  test('a paired chat session offers Unpair exactly where a broker source offers Disconnect', () => {
    const html = renderDashboardSetupPage(viewWith([
      card('whatsapp.personal.messages', 'WhatsApp', {
        configured: true,
        connection: connection({
          state: 'synced',
          label: 'synced 4 minutes ago',
          // A paired session owns no broker handle; the control must not be
          // gated on one, or the two chat rows keep the empty column they had.
          handles: [],
          unpair: {
            source_id: 'whatsapp.personal.messages',
            label: 'Unpair WhatsApp',
            confirmation: 'Removes this computer WhatsApp pairing session. Messages already indexed stay.',
            provider_unlink_url: 'https://faq.whatsapp.com/378279804439436',
            provider_unlink_label: 'WhatsApp linked devices',
          },
        }),
      }),
    ]));
    const row = segmentFor(html, 'WhatsApp');
    expect(row).toContain('data-unpair-kind="unpair"');
    expect(row).toContain('>Unpair WhatsApp</button>');
    expect(row).toContain('>WhatsApp linked devices</a>');
    expect(html).not.toContain('Delete data');
  });

  test('renders exactly one custody control even when a card carries both', () => {
    // The builder emits one or the other, never both. The renderer must not
    // depend on that: two custody buttons on one row is two different claims
    // about what pressing them removes.
    const html = renderDashboardSetupPage(viewWith([
      card('telegram.messages', 'Telegram', {
        configured: true,
        connection: connection({
          state: 'synced',
          label: 'synced 9 minutes ago',
          handles: ['telegram.personal'],
          disconnect: {
            source_id: 'telegram.messages',
            label: 'Disconnect Telegram',
            confirmation: 'Removes the local account grant.',
            provider_revocation_url: 'https://my.telegram.org/auth',
          },
          unpair: {
            source_id: 'telegram.messages',
            label: 'Unpair Telegram',
            confirmation: 'Removes this computer Telegram pairing session.',
            provider_unlink_url: 'https://my.telegram.org/auth',
            provider_unlink_label: 'Telegram active sessions',
          },
        }),
      }),
    ]));
    const row = segmentFor(html, 'Telegram');
    const controls = (row.match(/data-(?:unpair|disconnect)-kind="/g) ?? []).length;
    expect(controls).toBe(1);
    // Unpair wins: it is the act that actually ends a paired session.
    expect(row).toContain('data-unpair-kind="unpair"');
    expect(row).not.toContain('data-disconnect-kind');
  });

  test('a connected grant that needs reauthorization offers both Reauthenticate and Disconnect', () => {
    const html = renderDashboardSetupPage(viewWith([
      card('dropbox.files', 'Dropbox', {
        configured: true,
        connection: connection({
          state: 'reauth_required',
          label: 'reauth required',
          handles: ['dropbox.personal'],
          action: { kind: 'oauth', source: 'dropbox', label: 'Reauthenticate' },
          disconnect: {
            source_id: 'dropbox.files',
            label: 'Disconnect Dropbox',
            confirmation: 'Indexed data stays. Provider access is not revoked.',
            provider_revocation_url: 'https://www.dropbox.com/account/connected_apps',
          },
        }),
      }),
    ]));
    const row = segmentFor(html, 'Dropbox');
    expect(row).toContain('>Reauthenticate</button>');
    expect(row).toContain('>Disconnect Dropbox</button>');
  });

  test('never prints a calm heading over a source home calls broken', () => {
    const view: SourceDashboardViewModel = {
      ...viewWith([
        card('dropbox.files', 'Dropbox', {
          configured: true,
          connection: connection({ state: 'synced', label: 'synced 41 minutes ago' }),
          answer_readiness: { state: 'ready', label: 'Ready for questions' },
        }),
        card('gmail.email', 'Gmail', {
          configured: true,
          connection: connection({ state: 'synced', label: 'synced 12 minutes ago' }),
          answer_readiness: { state: 'needs_attention', label: 'Embedding lane needs attention' },
        }),
      ]),
      degraded_credentials: [{
        kind: 'worker_credential_degraded',
        display_name: 'Dropbox',
        state: 'retrying',
        status_label: 'Credential unavailable - needs your attention',
        hint: 'Unlock or reconnect this credential, then restart the Olympus worker.',
        attempts: 2,
        max_attempts: 3,
      }],
    };

    const html = renderDashboardSetupPage(view, { now: NOW });

    // The vocabulary word wins over the connection state: a synced card with a
    // degraded credential or a stalled answer lane is never headed "Fresh".
    expect(html).toContain('▲ Needs you — 2');
    expect(html).not.toContain('Fresh —');
    expect(segmentFor(html, 'Dropbox')).toContain('credential unavailable');
    expect(segmentFor(html, 'Gmail')).toContain('embedding lane needs attention');
  });
});

describe('dashboard setup framing and copy', () => {
  const realView = () => buildSourceDashboardViewModel({
    sourceIndexStatus: emptyStatus(),
    sovereigntyEngine: fixtureSovereigntyEngine(),
    oauthClientIds: { dropbox: 'olympus-dropbox-app' },
    now: NOW,
  });

  test('frames the unconnected group as options rather than a deficit', () => {
    const html = renderDashboardSetupPage(realView(), { now: NOW });

    expect(html).toContain('Available to connect');
    expect(html).not.toContain('Not connected —');
  });

  test('kills the needs-one-time-setup status and says Set up on the button', () => {
    const html = renderDashboardSetupPage(realView(), { now: NOW });

    expect(html).not.toContain('needs one-time setup');
    expect(html).not.toContain('Needs setup');
    expect(segmentFor(html, 'Gmail')).toContain('>Set up</button>');
  });

  test('states the app-key reality in the blurb instead', () => {
    const html = renderDashboardSetupPage(realView(), { now: NOW });

    const gmail = segmentFor(html, 'Gmail');
    expect(gmail).toContain('Olympus needs a Google Desktop app Client ID');
    expect(gmail).toContain('there is no client secret to paste');
  });

  test('strips persuasion from every blurb and keeps the factual Google line', () => {
    const html = renderDashboardSetupPage(realView(), { now: NOW });

    expect(html).not.toContain('You stay in control');
    expect(html).not.toContain('stay in control');
    expect(html).not.toContain('does not need to see it');
    // Factual and checkable, so it stays: the reader can go and look.
    expect(html).toContain('Google shows you exactly what Olympus can see');
  });

  test('gives Readwise the real key location as a link', () => {
    const html = renderDashboardSetupPage(realView(), { now: NOW });

    const readwise = segmentFor(html, 'Readwise');
    expect(readwise).toContain('Olympus needs a Readwise access token');
    expect(readwise).toContain('href="https://readwise.io/access_token"');
    expect(readwise).toContain('target="_blank"');
    expect(readwise).toContain('rel="noopener noreferrer"');
    expect(readwise).toContain('readwise.io/access_token →');
  });

  test('gives every key-bearing source the same guidance quality', () => {
    const html = renderDashboardSetupPage(realView(), { now: NOW });

    // Every row that asks the reader to go and fetch something names the page
    // that issues it. Readwise takes a token; the Google, Dropbox and X rows
    // take an app key from their own consoles. (Venice is an answer lane, not
    // a source card, so it has no row on this page at all.)
    for (const [label, host] of [
      ['Readwise', 'readwise.io'],
      ['Gmail', 'console.cloud.google.com'],
      ['Google Drive', 'console.cloud.google.com'],
      ['Dropbox', 'www.dropbox.com'],
      ['X bookmarks', 'console.x.com'],
    ] as const) {
      const segment = segmentFor(html, label);
      // Dropbox's client id is registered in this fixture, so its row connects
      // in one click and carries no key-fetching blurb.
      if (label === 'Dropbox') {
        expect(segment).toContain('data-connect-kind="oauth"');
        continue;
      }
      expect(segment).toContain(`href="https://${host}`);
    }
  });

  test('escapes a provider console URL rather than trusting it as markup', () => {
    const html = renderDashboardSetupPage(viewWith([
      card('readwise.library', 'Readwise', {
        connection: connection({
          state: 'not_connected',
          label: 'not connected',
          action: {
            kind: 'api_key',
            source: 'readwise',
            label: 'Connect',
            instructions: {
              ...setupInstructions(),
              plain_intro: 'Needs a token <script>alert(1)</script>',
              provider_console_url: 'https://readwise.io/access_token?a=1&b="2"',
            },
          },
        }),
      }),
    ]), { now: NOW });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;b=%222%22');
  });

  test('refuses a provider console URL that is not https', () => {
    const html = renderDashboardSetupPage(viewWith([
      card('readwise.library', 'Readwise', {
        connection: connection({
          state: 'not_connected',
          label: 'not connected',
          action: {
            kind: 'api_key',
            source: 'readwise',
            label: 'Connect',
            instructions: {
              ...setupInstructions(),
              provider_console_url: 'javascript:alert(1)',
            },
          },
        }),
      }),
    ]), { now: NOW });

    expect(html).not.toContain('javascript:');
  });

  test('names the unverified-app warning before the buttons that lead to it', () => {
    // The v0.4 shared-OAuth decision: the shared pilot client is published but
    // unverified, and the dashboard is where that is said. The note has to sit
    // above the Google rows, because Google shows the interstitial after the
    // reader has already pressed Connect.
    const html = renderDashboardSetupPage(buildSourceDashboardViewModel({
      sourceIndexStatus: emptyStatus(),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      googlePilotClientConfigured: true,
      now: NOW,
    }), { now: NOW });

    expect(html).toContain('class="pilotnote"');
    expect(html).toContain('Shared Google pilot client');
    expect(html).toContain('Google may show an unverified-app warning');
    expect(html).toContain('Gmail and Drive request their read scopes separately.');
    const note = html.indexOf('class="pilotnote"');
    const firstControl = html.indexOf('class="setrow');
    expect(firstControl).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(firstControl);
  });

  test('an advanced BYO install is not warned about a client it does not use', () => {
    const html = renderDashboardSetupPage(realView(), { now: NOW });

    expect(html).not.toContain('class="pilotnote"');
    expect(html).not.toContain('Advanced Google BYO required');
    expect(html).not.toContain('unverified-app warning');
  });

  test('says the connector prompt needs a source checkout the package does not carry', () => {
    // The prompt tells the agent to read skills/create-connector/SKILL.md, and
    // that playbook is deliberately outside the public package, so the sheet
    // has to state the precondition and where a checkout comes from.
    const html = renderDashboardSetupPage(realView(), { now: NOW });

    expect(html).toContain('Read skills/create-connector/SKILL.md and follow it exactly.');
    expect(html).toContain('source checkout');
    expect(html).toContain('CONTRIBUTING.md');
  });

  test('puts the one worker-token gate before every source control', () => {
    const locked = renderDashboardSetupPage(realView(), { now: NOW, readOnly: true });
    const connected = renderDashboardSetupPage(realView(), {
      now: NOW,
      readOnly: true,
      controlSessionCsrfToken: 'csrf-fixture',
    });

    expect(locked).toContain('Input token');
    expect(locked).toContain('Where is my token?');
    expect(locked).toContain('&lt;rootDir&gt;/bin/olympus dashboard token');
    expect(connected).toContain('Dashboard controls unlocked');
    expect(connected).not.toContain('name="worker_token"');

    const note = locked.indexOf('id="dashboard-controls"');
    const firstControl = locked.indexOf('class="setrow');
    expect(firstControl).toBeGreaterThan(-1);
    expect(note).toBeLessThan(firstControl);
  });
});

/** The markup between one row marker and the next, for row-local assertions. */
function segmentFor(html: string, label: string): string {
  // A state row is a div when it carries a control and an anchor when the whole
  // row is the link; the name inside is a span or an anchor by the same rule.
  const segments = html.split(/(?=<(?:div|a) class="(?:attncard|setrow|sect))/);
  const segment = segments.find((part) =>
    part.includes(`>${label}</span>`) || part.includes(`>${label}</a>`));
  if (segment === undefined) throw new Error(`no row for ${label}`);
  return segment;
}

function connection(patch: Partial<DashboardSourceCard['connection']> = {}): DashboardSourceCard['connection'] {
  return {
    state: 'not_connected',
    label: 'not connected',
    action: { kind: 'none' },
    handles: [],
    ...patch,
  };
}

function setupInstructions(): Extract<DashboardSourceCard['connection']['action'], { kind: 'needs_setup' }>['instructions'] {
  return {
    plain_intro: 'To read your mail, Olympus needs a free Google app key.',
    agent_prompt: 'Set up Gmail for Olympus and walk me through it step by step.',
    provider_console_url: 'https://console.cloud.google.com/auth/clients',
    diy_summary: 'Or set it up yourself (about 5 minutes)',
    diy_steps: [{ text: 'Sign in to Google Cloud.' }],
    secret_shown_once: true,
    fields: [
      { name: 'client_id', label: 'Client ID', required: true, secret: false },
      { name: 'client_secret', label: 'Client secret', required: true, secret: true },
    ],
  };
}

function card(
  sourceId: string,
  label: string,
  patch: Partial<DashboardSourceCard> = {},
): DashboardSourceCard {
  return {
    corpus_id: `internal.${sourceId}`,
    source_id: sourceId,
    label,
    provider: sourceId.split('.')[0] ?? sourceId,
    family: 'file',
    trust_domain: 'internal',
    configured: false,
    freshness: { label: 'Waiting for the first sync', stale: false },
    coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0, needs_review_items: 0 },
    ingestion_health: {
      coverage_percent: 0,
      stuck_count: 0,
      drain_state: 'unknown',
      label: 'no ingestion activity recorded',
    },
    tier_composition: [],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'disconnected', label: 'Connect this source' },
    connection: connection(),
    ...patch,
  };
}

function viewWith(sources: DashboardSourceCard[]): SourceDashboardViewModel {
  return {
    kind: 'source_dashboard',
    generated_at: NOW.toISOString(),
    summary: {
      configured_sources: sources.length,
      connected_sources: sources.filter((source) => source.configured).length,
      answer_ready_sources: 0,
      needs_attention_sources: 0,
      total_indexed_items: sources.reduce((sum, source) => sum + source.coverage.indexed_items, 0),
      total_content_ready_items: 0,
    },
    onboarding: {
      steps: [{ id: 'connect_sources', label: 'Connect your sources', state: 'active' }],
      ask_first_question: {
        enabled: false,
        label: 'Ask your first question',
        suggestion: 'What did I agree to last week?',
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

function emptyStatus(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: NOW.toISOString(),
    corpora: [],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
}

function fixtureSovereigntyEngine() {
  return createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
  }));
}

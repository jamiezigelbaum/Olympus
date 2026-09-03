import { describe, expect, test } from 'bun:test';
import {
  actionButton,
  attentionRow,
  clipboardScript,
  controlScript,
  connectorSheet,
  dashboardControlGate,
  DASHBOARD_CONTROL_GATE_ID,
  DASHBOARD_WORKER_TOKEN_AGENT_PROMPT,
  dashboardPageSignature,
  dashboardSignature,
  donutGlyph,
  dotGlyph,
  escapeHtml,
  escapeScriptJson,
  externalLink,
  pageShell,
  pollScript,
  progressBar,
  setupRow,
  sourceCard,
  statusGlyph,
  waitingGlyph,
} from '../src/workers/dashboard/components.ts';
import type { DashboardSourceCard } from '../src/workers/source-dashboard.ts';

/** One string carrying every escape a template literal can be broken with. */
const HOSTILE = `<script>alert('x')</script>" onmouseover="evil()`;

function expectEscaped(html: string): void {
  expect(html).not.toContain('<script>alert');
  expect(html).not.toContain('</script>"');
  expect(html).not.toContain('" onmouseover="');
  expect(html).toContain('&lt;script&gt;');
}

function fixtureCard(overrides: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
  return {
    corpus_id: 'gmail',
    source_id: 'gmail.email',
    label: 'Gmail',
    provider: 'google',
    family: 'email',
    trust_domain: 'secure_local',
    configured: true,
    freshness: { label: 'Last checked 6 minutes ago', hours: 0.1, stale: false },
    coverage: {
      indexed_items: 263071,
      content_ready_items: 129948,
      embedded_items: 41000,
      needs_review_items: 0,
    },
    ingestion_health: {
      coverage_percent: 49.4,
      stuck_count: 0,
      drain_state: 'enabled',
      label: '49.4% covered',
    },
    tier_composition: [],
    queue_health: { label: 'Working now', waiting: 12, active: 2, needs_attention: 0 },
    answer_readiness: { state: 'syncing', label: 'Syncing now' },
    connection: { state: 'syncing', label: 'syncing', action: { kind: 'none' }, handles: [] },
    ...overrides,
  };
}

describe('donutGlyph', () => {
  test('renders the mockup geometry and the dasharray for a fraction', () => {
    const svg = donutGlyph(0.49);
    expect(svg).toContain('viewBox="0 0 14 14"');
    expect(svg).toContain('<circle cx="7" cy="7" r="6" stroke="#8F7BD8" stroke-width="1.5"/>');
    expect(svg).toContain('r="2" stroke="#8F7BD8" stroke-width="4"');
    expect(svg).toContain('stroke-dasharray="6.16 12.566"');
    expect(svg).toContain('transform="rotate(-90 7 7)"');
    expect(svg).toContain('aria-hidden="true"');
  });

  test('an empty wedge at 0 and a full wedge at 1', () => {
    expect(donutGlyph(0)).toContain('stroke-dasharray="0.00 12.566"');
    expect(donutGlyph(1)).toContain('stroke-dasharray="12.57 12.566"');
  });

  test('clamps fractions outside 0..1 and non-finite input', () => {
    expect(donutGlyph(-3)).toContain('stroke-dasharray="0.00 12.566"');
    expect(donutGlyph(7.2)).toContain('stroke-dasharray="12.57 12.566"');
    expect(donutGlyph(Number.NaN)).toContain('stroke-dasharray="0.00 12.566"');
    expect(donutGlyph(Number.POSITIVE_INFINITY)).toContain('stroke-dasharray="12.57 12.566"');
  });

  test('refuses a color that is not a literal hex', () => {
    const svg = donutGlyph(0.5, 'red" onload="evil()');
    expect(svg).not.toContain('onload');
    expect(svg).toContain('#8F7BD8');
  });
});

describe('waitingGlyph and dotGlyph', () => {
  test('waiting is a grey double ring with no progress claim', () => {
    const svg = waitingGlyph();
    expect(svg).toContain('<circle cx="7" cy="7" r="6" stroke="#6B6E76" stroke-width="1.5"/>');
    expect(svg).toContain('<circle cx="7" cy="7" r="2.6" stroke="#6B6E76" stroke-width="1.5"/>');
    expect(svg).not.toContain('stroke-dasharray');
  });

  test('dot renders the given hex and refuses anything else', () => {
    expect(dotGlyph('#4E9468')).toBe('<span class="dot" style="background:#4E9468"></span>');
    const hostile = dotGlyph('red;} body{display:none} .x{color:red');
    expect(hostile).not.toContain('display:none');
    expect(hostile).toContain('#6B6E76');
  });
});

describe('statusGlyph', () => {
  test('Working uses the donut when a fraction is known', () => {
    expect(statusGlyph('Working', 0.28)).toContain('stroke-dasharray="3.52 12.566"');
  });

  test('Working falls back to a plain ring when no fraction is defensible', () => {
    const svg = statusGlyph('Working');
    expect(svg).toContain('stroke="#8F7BD8"');
    expect(svg).not.toContain('stroke-dasharray');
  });

  test('the other five words each get their own glyph', () => {
    expect(statusGlyph('Waiting')).toContain('r="2.6"');
    expect(statusGlyph('Fresh')).toBe('<span class="dot" style="background:#4E9468"></span>');
    expect(statusGlyph('Needs you')).toContain('#B08430');
    expect(statusGlyph('Failing')).toContain('#C4574D');
    expect(statusGlyph('Off')).toContain('#26272C');
  });
});

describe('sourceCard', () => {
  test('renders the header glyph, the label, and the sub line', () => {
    const html = sourceCard({ label: 'Gmail', status: 'Working', subLine: 'indexing', fraction: 0.49 });
    expect(html).toContain('class="card"');
    expect(html).toContain('class="hd"');
    expect(html).toContain('stroke-dasharray="6.16 12.566"');
    expect(html).toContain('<div class="ln">indexing</div>');
  });

  test('omits the sub line entirely when there is nothing true to say', () => {
    const html = sourceCard({ label: 'Readwise', status: 'Fresh', subLine: '' });
    expect(html).not.toContain('class="ln"');
  });

  test('makes the whole card the link when a detail page exists, and escapes the href', () => {
    const html = sourceCard({
      label: 'Gmail',
      status: 'Fresh',
      href: '/dashboard?source=gmail.email&token="x',
    });
    // Owner ruling: the hit zone is the card, so the anchor is the card.
    expect(html).toContain('<a class="card cardlink" href="/dashboard?source=gmail.email&amp;token=&quot;x">');
    expect(html).not.toContain('<div class="card">');
    // And the name inside it is plain text, not a nested link.
    expect(html).not.toContain('<a href=');
  });

  test('refuses a script-scheme href rather than linking it', () => {
    const html = sourceCard({ label: 'Gmail', status: 'Fresh', href: 'javascript:evil()' });
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
  });

  test('escapes hostile label and sub line', () => {
    expectEscaped(sourceCard({ label: HOSTILE, status: 'Fresh', subLine: HOSTILE }));
  });
});

describe('control links', () => {
  test('mints a bounded session before navigating to a protected dashboard page', () => {
    const html = actionButton({
      label: 'Edit what gets ingested',
      kind: 'control_link',
      href: '/dashboard/dispositions',
      hint: 'needs the worker token',
    });
    expect(html).toContain('data-control-link="/dashboard/dispositions"');
    expect(html).not.toContain('href=');
    const script = controlScript();
    expect(script).toContain("target.closest('[data-control-link]')");
    expect(script).toContain('ensureSession(host)');
    expect(script).toContain("window.location.assign(control.getAttribute('data-control-link'))");
    expect(script).not.toContain('sessionStorage');
  });

  test('refuses scheme-relative and external control destinations', () => {
    expect(actionButton({ label: 'Bad', kind: 'control_link', href: '//attacker.test/x' })).toBe('');
    expect(actionButton({ label: 'Bad', kind: 'control_link', href: 'https://attacker.test/x' })).toBe('');
  });
});

describe('dashboard-level control gate', () => {
  test('asks for the worker token once at dashboard level and names where it comes from', () => {
    const html = dashboardControlGate({ connected: false });
    expect(html).toContain(`id="${DASHBOARD_CONTROL_GATE_ID}"`);
    expect(html).toContain('Input token');
    expect(html).toContain('Where is my token?');
    expect(html).toContain('data-sheet-toggle');
    // Where it comes from now lives behind the disclosure, and says both ways
    // of getting it: the agent prompt and the command that prints it.
    expect(html).toContain(escapeHtml(DASHBOARD_WORKER_TOKEN_AGENT_PROMPT));
    expect(html).toContain('olympus dashboard token');
    expect(html).toContain('data-control-session-kind="unlock"');
    // The field is addressed by its data attribute and carries NO name, so a
    // scriptless native submit sends no token anywhere; the form's own POST to
    // the session route keeps a submit off the URL, the history and the logs.
    expect(html).toContain('data-dashboard-control-token');
    expect(html).not.toContain('name="worker_token"');
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/dashboard/control/session"');
    expect(html).toContain('placeholder="Worker token"');
    expect(html).toContain('>Unlock</button>');
    expect(html).not.toContain('Dropbox');
    // The old copy is gone, not merely reworded around.
    expect(html).not.toContain('Dashboard controls locked');
    expect(html).not.toContain('Unlock controls');
  });

  test('shows the browser session as connected without rendering a token field', () => {
    const html = dashboardControlGate({ connected: true });
    expect(html).toContain('Dashboard controls unlocked');
    // The truth about the lifetime, and the way to end it on this browser.
    expect(html).toContain('for 30 days from the paste, or until the worker token is rotated');
    expect(html).toContain('data-control-session-kind="lock" method="post" action="/dashboard/control/session/lock"');
    expect(html).toContain('>Lock</button>');
    expect(html).toContain('data-state="connected"');
    expect(html).not.toContain('name="worker_token"');
    expect(html).not.toContain('data-sheet-toggle');
    expect(html).not.toContain('Dashboard controls connected');
  });

  test('hydrates the existing control session and never prompts inside a source action', () => {
    const script = controlScript({ csrfToken: 'csrf-fixture' });
    expect(script).toContain('var csrfToken = "csrf-fixture"');
    expect(script).toContain("form.hasAttribute('data-control-session-kind')");
    expect(script).toContain("document.querySelector('[data-dashboard-control-token]')");
    expect(script).not.toContain('window.prompt');
    expect(script).not.toContain('localStorage');
    expect(script).not.toContain('sessionStorage');
  });
});

describe('attentionRow', () => {
  test('renders label, reason and a control form for the action', () => {
    const html = attentionRow({
      label: 'Dropbox',
      why: 'reauth required',
      attention: true,
      action: { label: 'Reauthenticate', kind: 'oauth', source: 'dropbox', primary: true },
    });
    expect(html).toContain('class="attncard"');
    expect(html).toContain('Dropbox');
    expect(html).toContain('<span class="why"> — reauth required</span>');
    expect(html).toContain('data-connect-kind="oauth"');
    expect(html).toContain('<input type="hidden" name="source" value="dropbox">');
    expect(html).toContain('class="btn primary"');
  });

  test('a sync action posts to the sync seam, and kind none renders no button', () => {
    expect(attentionRow({ label: 'Gmail', action: { label: 'Sync now', kind: 'sync_now', source: 'gmail' } }))
      .toContain('data-sync-kind="sync_now"');
    const quiet = attentionRow({ label: 'Gmail', action: { label: 'Sync now', kind: 'none' } });
    expect(quiet).not.toContain('<button');
  });

  test('an api_key action carries the field the connect route requires', () => {
    const html = attentionRow({
      label: 'Readwise',
      action: { label: 'Connect', kind: 'api_key', source: 'readwise' },
    });
    // POST /dashboard/connect/api-key 400s without an `api_key` body field, so
    // the form must carry it — and never as a visible text input.
    expect(html).toContain('name="api_key"');
    expect(html).toContain('type="password"');
    expect(html).toContain('data-action-message');
  });

  test('a bounded Disconnect action names retained custody and links provider revocation', () => {
    const html = attentionRow({
      label: 'Dropbox',
      action: {
        label: 'Disconnect Dropbox',
        kind: 'disconnect',
        source: 'dropbox.files',
        confirmation: 'Indexed data and developer-app registration stay. Provider access is not revoked.',
        providerRevocationUrl: 'https://www.dropbox.com/account/connected_apps',
      },
    });
    expect(html).toContain('data-disconnect-kind="disconnect"');
    expect(html).toContain('name="source_id" value="dropbox.files"');
    expect(html).toContain('Indexed data and developer-app registration stay. Provider access is not revoked.');
    expect(html).toContain('href="https://www.dropbox.com/account/connected_apps"');
    expect(html).toContain('>Provider access</a>');
  });

  test('a bounded Unpair action posts to its own route and links the provider device list', () => {
    const html = attentionRow({
      label: 'WhatsApp',
      action: {
        label: 'Unpair WhatsApp',
        kind: 'unpair',
        source: 'whatsapp.personal.messages',
        confirmation: 'Removes this computer WhatsApp pairing session. Messages already indexed stay.',
        providerRevocationUrl: 'https://faq.whatsapp.com/378279804439436',
        providerLinkLabel: 'WhatsApp linked devices',
      },
    });
    expect(html).toContain('data-unpair-kind="unpair"');
    expect(html).toContain('name="source_id" value="whatsapp.personal.messages"');
    expect(html).toContain('Removes this computer WhatsApp pairing session. Messages already indexed stay.');
    expect(html).toContain('href="https://faq.whatsapp.com/378279804439436"');
    expect(html).toContain('>WhatsApp linked devices</a>');
    // Its own route: Unpair removes a paired session, never a broker grant.
    expect(html).not.toContain('data-disconnect-kind');
  });

  test('the control script confirms an Unpair, then posts it with acknowledge and CSRF', async () => {
    const page = runControlScript('csrf-fixture');
    const form = page.form({
      'data-unpair-kind': 'unpair',
      'data-confirmation': 'Delete this computer WhatsApp pairing session?',
    }, { source_id: 'whatsapp.personal.messages' });

    page.confirmAnswer = true;
    await page.submit(form);

    // The reader was asked, in the card's own words.
    expect(page.confirmations).toEqual(['Delete this computer WhatsApp pairing session?']);
    expect(page.requests).toHaveLength(1);
    const request = page.requests[0]!;
    expect(request.endpoint).toBe('/dashboard/unpair');
    expect(request.init.method).toBe('POST');
    expect(request.init.credentials).toBe('same-origin');
    expect(request.init.headers['X-Olympus-CSRF']).toBe('csrf-fixture');
    // The route 400s without this; the button is what supplies it.
    expect(JSON.parse(request.init.body!)).toEqual({
      source_id: 'whatsapp.personal.messages',
      acknowledge: true,
    });
  });

  test('the control script shows what the route said, not a generic Done', async () => {
    const page = runControlScript('csrf-fixture');
    page.responsePayload = {
      ok: true,
      status_message: 'Unpair incomplete — remove by hand: /data/session.db',
    };
    const form = page.form({ 'data-unpair-kind': 'unpair', 'data-confirmation': 'Sure?' }, {
      source_id: 'whatsapp.personal.messages',
    });

    await page.submit(form);

    // A partial removal rendered as "Done" is a completion claim the response
    // never made.
    expect(form.message.textContent).toBe('Unpair incomplete — remove by hand: /data/session.db');
  });

  test('the control script sends no Unpair at all when the reader declines', async () => {
    const page = runControlScript('csrf-fixture');
    const form = page.form({
      'data-unpair-kind': 'unpair',
      'data-confirmation': 'Delete this computer WhatsApp pairing session?',
    }, { source_id: 'whatsapp.personal.messages' });

    page.confirmAnswer = false;
    await page.submit(form);

    expect(page.confirmations).toHaveLength(1);
    expect(page.requests).toEqual([]);
  });

  test('the control script refuses to act at all without an unlocked control session', async () => {
    const page = runControlScript('');
    const form = page.form({ 'data-unpair-kind': 'unpair', 'data-confirmation': 'Sure?' }, {
      source_id: 'telegram.messages',
    });

    await page.submit(form);

    expect(page.confirmations).toEqual([]);
    expect(page.requests).toEqual([]);
  });

  test('renders nothing for the reason half when no field backs it', () => {
    const html = attentionRow({ label: 'Gmail' });
    expect(html).not.toContain('class="why"');
    expect(html).not.toContain('—');
  });

  test('carries a progress bar when a percent is given', () => {
    const html = attentionRow({ label: 'Gmail', barPercent: 8 });
    expect(html).toContain('class="bar"');
    expect(html).toContain('style="width:8%"');
  });

  test('escapes hostile label, reason and action label', () => {
    expectEscaped(attentionRow({
      label: HOSTILE,
      why: HOSTILE,
      action: { label: HOSTILE, kind: 'api_key', source: HOSTILE },
    }));
  });

  test('becomes a whole-row link when it has a destination and no control', () => {
    const html = attentionRow({
      label: 'Gmail',
      why: 'ingestion is stalled',
      attention: true,
      href: '/dashboard?source=gmail.email',
    });
    expect(html).toContain('<a class="attncard rowzone" href="/dashboard?source=gmail.email">');
    expect(html).toContain('<span class="go" aria-hidden="true">→</span>');
    expect(html).not.toContain('<button');
  });

  test('keeps the control and links only the name when both exist', () => {
    const html = attentionRow({
      label: 'Dropbox',
      why: 'reauth required',
      href: '/dashboard?source=dropbox.files',
      action: { label: 'Reauthenticate', kind: 'oauth', source: 'dropbox', primary: true },
    });
    // A control inside a link is not a shape HTML allows, so the row stays a
    // row and its name carries the link.
    expect(html).not.toContain('<a class="attncard');
    expect(html).toContain('<a class="name" href="/dashboard?source=dropbox.files">Dropbox</a>');
    expect(html).toContain('data-connect-kind="oauth"');
  });

  test('a link action renders a link and its requirement, never a control', () => {
    const html = attentionRow({
      label: 'Dropbox',
      href: '/dashboard?source=dropbox.files',
      action: {
        label: 'Reauthenticate',
        kind: 'link',
        href: '/dashboard?setup',
        hint: 'needs the worker token',
      },
    });
    expect(html).toContain('<a class="btn" href="/dashboard?setup">Reauthenticate</a>');
    expect(html).toContain('<span class="hint">needs the worker token</span>');
    expect(html).not.toContain('<form');
  });

  test('refuses a script-scheme link action rather than rendering it', () => {
    const html = attentionRow({
      label: 'Dropbox',
      action: { label: 'Reauthenticate', kind: 'link', href: 'javascript:evil()' },
    });
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('class="btn"');
  });

  test('refuses a script-scheme row href rather than linking the row', () => {
    const html = attentionRow({ label: 'Gmail', href: 'javascript:evil()' });
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
  });

  test('escapes a hostile row href and link action', () => {
    expectEscaped(attentionRow({
      label: HOSTILE,
      href: `/dashboard?source=${HOSTILE}`,
      action: { label: HOSTILE, kind: 'link', href: `/dashboard?setup=${HOSTILE}`, hint: HOSTILE },
    }));
  });
});

describe('externalLink', () => {
  test('opens a provider console in its own tab, with the referrer withheld', () => {
    const html = externalLink({ label: 'readwise.io/access_token →', url: 'https://readwise.io/access_token' });
    expect(html).toContain('href="https://readwise.io/access_token"');
    expect(html).toContain('target="_blank"');
    // noreferrer as well as noopener: the dashboard URL carries the read-only
    // view token in its query string and must not travel to a provider.
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test('renders nothing at all for a URL that is not https', () => {
    expect(externalLink({ label: 'evil', url: 'javascript:alert(1)' })).toBe('');
    expect(externalLink({ label: 'plain', url: 'http://readwise.io' })).toBe('');
    expect(externalLink({ label: 'nonsense', url: 'not a url' })).toBe('');
    expect(externalLink({ label: 'nothing', url: '' })).toBe('');
  });

  test('escapes a hostile label and query string', () => {
    expectEscaped(externalLink({ label: HOSTILE, url: `https://readwise.io/?q=${encodeURIComponent(HOSTILE)}` }));
  });
});

describe('setupRow', () => {
  test('renders the dashed row with dot, label, blurb and button', () => {
    const html = setupRow({
      label: 'Google Drive',
      blurb: 'Documents and folders, indexed and searchable',
      action: { label: 'Connect', kind: 'oauth', source: 'google_drive' },
    });
    expect(html).toContain('class="setrow"');
    expect(html).toContain('class="dot"');
    expect(html).toContain('Documents and folders, indexed and searchable');
    expect(html).toContain('data-connect-kind="oauth"');
  });

  test('a sheet action toggles the named sheet without an inline handler', () => {
    const html = setupRow({
      label: 'Something else',
      blurb: 'Build the connector with your AI',
      action: { label: 'Build a connector', kind: 'none', sheet: 'connector-sheet' },
    });
    expect(html).toContain('data-sheet-toggle="#connector-sheet"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('onclick');
  });

  test('an api_key setup row carries the field the connect route requires', () => {
    const html = setupRow({
      label: 'Readwise',
      blurb: '',
      action: { label: 'Connect', kind: 'api_key', source: 'readwise' },
    });
    expect(html).toContain('name="api_key"');
    expect(html).toContain('type="password"');
    expect(html).toContain('data-action-message');
  });

  test('an empty blurb closes the row up instead of leaving an empty column', () => {
    const html = setupRow({
      label: 'Readwise',
      blurb: '',
      action: { label: 'Connect', kind: 'api_key', source: 'readwise' },
    });
    expect(html).toContain('class="setrow noblurb"');
    expect(html).not.toContain('class="blurb"');
  });

  test('escapes hostile label and blurb', () => {
    expectEscaped(setupRow({
      label: HOSTILE,
      blurb: HOSTILE,
      action: { label: HOSTILE, kind: 'oauth', source: HOSTILE },
    }));
  });

  test('carries the key location at the end of the blurb, as a link', () => {
    const html = setupRow({
      label: 'Readwise',
      blurb: 'Olympus needs a Readwise access token.',
      action: { label: 'Connect', kind: 'api_key', source: 'readwise' },
      blurbLink: { label: 'readwise.io/access_token →', url: 'https://readwise.io/access_token' },
    });
    expect(html).toContain('class="blurb"');
    expect(html).toContain('Olympus needs a Readwise access token. <a class="ext"');
    expect(html).toContain('href="https://readwise.io/access_token"');
  });

  test('keeps the blurb column when the link is the only thing in it', () => {
    const html = setupRow({
      label: 'Readwise',
      blurb: '',
      action: { label: 'Connect', kind: 'api_key', source: 'readwise' },
      blurbLink: { label: 'readwise.io →', url: 'https://readwise.io' },
    });
    expect(html).toContain('class="blurb"');
    expect(html).not.toContain('noblurb');
  });

  test('escapes a hostile blurb link rather than trusting the provider text', () => {
    expectEscaped(setupRow({
      label: HOSTILE,
      blurb: HOSTILE,
      action: { label: HOSTILE, kind: 'oauth', source: HOSTILE },
      blurbLink: { label: HOSTILE, url: `https://readwise.io/?q=${encodeURIComponent(HOSTILE)}` },
    }));
  });
});

describe('progressBar', () => {
  test('clamps the percent and labels the bar', () => {
    expect(progressBar({ percent: 8, label: '8 percent' })).toContain('style="width:8%"');
    expect(progressBar({ percent: -4, label: 'none' })).toContain('style="width:0%"');
    expect(progressBar({ percent: 250, label: 'all' })).toContain('style="width:100%"');
    expect(progressBar({ percent: Number.NaN, label: 'unknown' })).toContain('style="width:0%"');
    expect(progressBar({ percent: 8, label: '8 percent' })).toContain('aria-valuenow="8"');
  });

  test('escapes the aria label', () => {
    const html = progressBar({ percent: 50, label: HOSTILE });
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('connectorSheet', () => {
  test('renders the prompt box and a copy button bound by data attribute', () => {
    const html = connectorSheet({
      id: 'connector-sheet',
      heading: 'Build a connector with your AI',
      intro: 'Copy this prompt and paste it into your AI coding tool.',
      promptText: 'Read skills/create-connector/SKILL.md and follow it exactly.',
      copyButtonLabel: 'Copy prompt',
    });
    expect(html).toContain('id="connector-sheet"');
    expect(html).toContain('class="promptbox" id="connector-sheet-prompt"');
    expect(html).toContain('data-copy-target="#connector-sheet-prompt"');
    expect(html).toContain('Copy prompt');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
  });

  test('the copy button markup carries no unescaped interpolation', () => {
    const html = connectorSheet({
      id: 'a b"><img src=x onerror=evil()>',
      heading: HOSTILE,
      intro: HOSTILE,
      promptText: HOSTILE,
      copyButtonLabel: HOSTILE,
    });
    expectEscaped(html);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src=x');
    // The id also becomes a CSS selector, so it is reduced to selector-safe
    // characters — nothing that could close the attribute or the element.
    expect(html).toContain('id="a-b-img-src-x-onerror-evil"');
    expect(html).toContain('id="a-b-img-src-x-onerror-evil-prompt"');
    expect(html).toContain('data-copy-target="#a-b-img-src-x-onerror-evil-prompt"');
  });
});

describe('clipboardScript', () => {
  test('is a constant with no interpolated content and binds with addEventListener', () => {
    const script = clipboardScript();
    expect(script).toBe(clipboardScript());
    expect(script).toContain('addEventListener');
    expect(script).toContain('data-copy-target');
    expect(script).toContain('data-sheet-toggle');
    expect(script).not.toContain('onclick=');
    expect(script).not.toContain('${');
  });
});

describe('pollScript', () => {
  test('refreshes on the stated cadence, skipping hidden tabs', () => {
    const script = pollScript({ signature: '[]' });
    expect(script).toContain('15000');
    expect(script).toContain('document.hidden');
    expect(script).toContain('window.location.href');
    expect(script).toContain('document.body.innerHTML');
    expect(script).toContain('data-signature="[]"');
  });

  test('honours an explicit interval', () => {
    expect(pollScript({ signature: '[]', intervalMs: 5000 })).toContain('5000');
  });

  test('never swaps the body out from under an open sheet', () => {
    const script = pollScript({ signature: '[]' });
    expect(script).toContain(`document.querySelector('.sheet.on')`);
    // The guard must run before the swap, like the typing guard.
    expect(script.indexOf('.sheet.on')).toBeLessThan(script.indexOf('document.body.innerHTML'));
  });

  test('keeps the header meta fresh even when the signature has not moved', () => {
    const script = pollScript({ signature: '[]' });
    // "checked Ns ago" is baked into the HTML at render time; without this
    // copy a quiet dashboard claims the same age forever.
    expect(script).toContain(`document.querySelector('.top .meta')`);
    expect(script).toContain('meta.textContent = nextMeta.textContent');
    expect(script.indexOf('nextMeta.textContent')).toBeLessThan(script.indexOf('signature === current'));
  });

  test('a hostile signature cannot break out of the script or the marker', () => {
    const script = pollScript({ signature: '["a"]</script><script>evil()</script>' });
    expect(script).not.toContain('<script>evil()');
    expect(script).not.toContain('"]</script>');
    expect(script.match(/<\/script>/g)?.length).toBe(1);
  });

  test('skips a tick while the previous refresh is still in flight', () => {
    // A render costs what the server's slowest source costs. A bare interval
    // with no guard starts another fetch every tick regardless, so a page
    // slower than its own cadence queues overlapping renders that each make
    // the next one slower — this is the guard that bounds it to one at a time.
    const script = pollScript({ signature: '[]' });
    expect(script).toContain('var inFlight = false');
    expect(script).toContain('if (inFlight) return;');
    expect(script).toContain('inFlight = true');
    expect(script).toContain('inFlight = false');
    // Set before the guard could possibly return: the check and the set are
    // the only thing standing between a poll tick and a second fetch.
    expect(script.indexOf('if (inFlight) return;')).toBeLessThan(script.indexOf('inFlight = true'));
    expect(script.indexOf('inFlight = true')).toBeLessThan(script.indexOf('await fetch'));
    // Released in `finally`, so a thrown fetch cannot wedge every later tick.
    // (lastIndexOf: the FIRST "inFlight = false" is the `var` declaration.)
    expect(script.indexOf('} finally {')).toBeGreaterThan(script.indexOf('await fetch'));
    expect(script.lastIndexOf('inFlight = false')).toBeGreaterThan(script.indexOf('} finally {'));
  });
});

describe('dashboardPageSignature', () => {
  test('fingerprints the body, ignoring seconds-level timers and its own marker', () => {
    const body = '<div class="phase working">Working · moved 40s ago</div><div>18 of 18 messages</div>';
    const later = body.replace('40s ago', '55s ago');
    const minuteLater = body.replace('40s ago', '1m 10s ago');
    const stalled = body.replace('working">Working · moved 40s ago', 'stalled">Stalled · nothing moved for 1h 3m');
    const locked = body + '<div data-dashboard-control-gate data-state="locked"></div>';
    expect(dashboardPageSignature(later)).toBe(dashboardPageSignature(body));
    expect(dashboardPageSignature(minuteLater)).not.toBe(dashboardPageSignature(body));
    expect(dashboardPageSignature(stalled)).not.toBe(dashboardPageSignature(body));
    expect(dashboardPageSignature(locked)).not.toBe(dashboardPageSignature(body));
    // The marker the poll reads is never part of what it fingerprints.
    expect(dashboardPageSignature(body + '<span id="dashboard-poll-signature" data-signature="x" style="display:none"></span>'))
      .toBe(dashboardPageSignature(body));
  });

  test('pageShell signs the body it ships when asked to poll, and marks the session it holds', () => {
    const html = pageShell({ title: 'Olympus', meta: '', body: '<div>one</div>', poll: {} });
    expect(html).toContain(`data-signature="${dashboardPageSignature('<div>one</div>')}"`);
    expect(html).toContain('data-unlocked="false"');
    expect(html).toContain('data-session=""');
    // Two mints are two sessions: their markers differ, and neither is the
    // CSRF token itself. The same session marks the same.
    const mintA = pageShell({ title: 'Olympus', meta: '', body: '<div>one</div>', poll: { unlocked: true, controlSessionCsrfToken: 'csrf-A' } });
    const mintB = pageShell({ title: 'Olympus', meta: '', body: '<div>one</div>', poll: { unlocked: true, controlSessionCsrfToken: 'csrf-B' } });
    const mintA2 = pageShell({ title: 'Olympus', meta: '', body: '<div>one</div>', poll: { unlocked: true, controlSessionCsrfToken: 'csrf-A' } });
    const markerOf = (html: string) => /data-session="([0-9a-f]*)"/.exec(html)?.[1];
    expect(mintA).toContain('data-unlocked="true"');
    expect(markerOf(mintA)).toMatch(/^[0-9a-f]{24}$/);
    expect(markerOf(mintA)).not.toBe(markerOf(mintB));
    expect(markerOf(mintA)).toBe(markerOf(mintA2));
    expect(mintA).not.toContain('data-session="csrf-A"');
    expect(pageShell({ title: 'Olympus', meta: '', body: '<div>one</div>' })).not.toContain('dashboard-poll-signature');
  });

  test('the poll reloads on any session change, restores focus and disclosures by key, and bounds deferral', () => {
    const script = pollScript({ signature: 'x', unlocked: false, session: '' });
    // A tab that sees custody OR the session identity differ reloads so its
    // control handler gets the new page's CSRF token; a body swap would leave
    // it with a stale one that the worker refuses.
    expect(script).toContain("if (unlockedIn(next) !== unlocked || sessionIn(next) !== session) { window.location.reload(); return; }");
    // Disclosures are restored by a stable key, falling back to summary text.
    expect(script).toContain("node.getAttribute('data-poll-key') || (summary ? summary.textContent.trim() : '')");
    // A focused control defers the swap for at most two minutes, then focus
    // is put back by key after the swap.
    expect(script).toContain('Date.now() - deferredSince < 120000');
    expect(script).toContain('findByFocusKey(focused)');
  });
});

describe('dashboardSignature', () => {
  test('changes with custody, the embedding lane state, and a working row\'s minute of age', () => {
    const card = fixtureCard();
    const now = new Date('2026-07-02T12:00:00.000Z');
    // Locked and unlocked renders of the same sources must not share a
    // signature, or an expired session leaves a page reading "unlocked".
    expect(dashboardSignature([card], { now, controlSession: true }))
      .not.toBe(dashboardSignature([card], { now, controlSession: false }));
    // The embedding lane's own run state is rendered, so it is signed.
    const running = { state: 'running', stateLine: 'Embeddings: running now' } as never;
    const parked = { state: 'parked', stateLine: 'Embeddings: parked' } as never;
    expect(dashboardSignature([card], { now, embeddingRuntime: running }))
      .not.toBe(dashboardSignature([card], { now, embeddingRuntime: parked }));
    // A row that moved forty seconds ago and one that moved ninety seconds ago
    // print different ages; an hour later the same row prints Stalled.
    const moving = {
      ...card,
      coverage: { ...card.coverage, content_ready_items: Math.max(1, card.coverage.indexed_items - 1) },
      movement: { extraction_at: '2026-07-02T11:59:20.000Z' },
    };
    const olderMove = { ...moving, movement: { extraction_at: '2026-07-02T11:58:30.000Z' } };
    expect(dashboardSignature([moving], { now })).not.toBe(dashboardSignature([olderMove], { now }));
    const anHourOn = new Date('2026-07-02T13:00:30.000Z');
    expect(dashboardSignature([moving], { now })).not.toBe(dashboardSignature([moving], { now: anHourOn }));
  });

  test('is stable for the same cards and moves when a count moves', () => {
    const card = fixtureCard();
    expect(dashboardSignature([card])).toBe(dashboardSignature([fixtureCard()]));
    const moved = fixtureCard({
      coverage: { ...card.coverage, indexed_items: card.coverage.indexed_items + 1 },
    });
    expect(dashboardSignature([moved])).not.toBe(dashboardSignature([card]));
  });

  test('moves when a connection state changes without any count changing', () => {
    const card = fixtureCard();
    const reauth = fixtureCard({
      connection: { ...card.connection, state: 'reauth_required', label: 'reauth required' },
    });
    expect(dashboardSignature([reauth])).not.toBe(dashboardSignature([card]));
  });
});

describe('pageShell', () => {
  test('inlines the stylesheet, the header and the scripts', () => {
    const html = pageShell({
      title: 'Olympus',
      meta: '7 sources · checked 12s ago',
      body: '<div class="sect">Fresh — 4</div>',
      scripts: ['<script>void 0;</script>'],
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Olympus</title>');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('<style>');
    expect(html).toContain('class="frame"');
    expect(html).toContain('7 sources · checked 12s ago');
    expect(html).toContain('<div class="sect">Fresh — 4</div>');
    expect(html).toContain('<script>void 0;</script>');
  });

  test('a crumb reads as Olympus / Source in the brand and the title', () => {
    const html = pageShell({ title: 'Olympus', crumb: 'Gmail', meta: 'Working', body: '' });
    expect(html).toContain('<title>Olympus / Gmail</title>');
    expect(html).toContain('class="crumb"');
    expect(html).toContain('Gmail');
  });

  test('the crumb lead is a real link home that keeps the base path', () => {
    const html = pageShell({
      title: 'Olympus',
      crumb: 'Gmail',
      basePath: '/dashboard?token=dash_fixture',
      meta: 'Working',
      body: '',
    });
    expect(html).toContain('<a class="lead" href="/dashboard?token=dash_fixture">Olympus</a>');
  });

  test('the crumb lead defaults to /dashboard and refuses a scheme href', () => {
    expect(pageShell({ title: 'Olympus', crumb: 'Gmail', meta: '', body: '' }))
      .toContain('<a class="lead" href="/dashboard">Olympus</a>');
    const hostile = pageShell({
      title: 'Olympus',
      crumb: 'Gmail',
      basePath: 'javascript:evil()',
      meta: '',
      body: '',
    });
    expect(hostile).not.toContain('javascript:');
  });

  test('escapes title, crumb and meta', () => {
    const html = pageShell({ title: HOSTILE, crumb: HOSTILE, meta: HOSTILE, body: '' });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('escapeHtml', () => {
  test('covers the five entities the worker escapes', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('escapeScriptJson', () => {
  test('maps each of < > & to its unicode escape and touches nothing else', () => {
    expect(escapeScriptJson('<')).toBe('\\u003c');
    expect(escapeScriptJson('>')).toBe('\\u003e');
    expect(escapeScriptJson('&')).toBe('\\u0026');
    expect(escapeScriptJson('</script><b>&amp;')).toBe('\\u003c/script\\u003e\\u003cb\\u003e\\u0026amp;');
    expect(escapeScriptJson('{"a":"plain text 123"}')).toBe('{"a":"plain text 123"}');
  });
});

/**
 * Run the real browser control script against a minimal DOM.
 *
 * The script is the half of every control that no server test can reach: what
 * the button actually sends. Pinning its source text proves only that a string
 * is present, so this executes it and asserts the request that comes out.
 */
function runControlScript(csrfToken: string) {
  interface FakeElement { textContent: string }
  class FakeForm {
    attributes: Record<string, string>;
    fields: Record<string, string>;
    message: FakeElement = { textContent: '' };
    resetCount = 0;

    constructor(attributes: Record<string, string>, fields: Record<string, string>) {
      this.attributes = attributes;
      this.fields = fields;
    }

    hasAttribute(name: string): boolean { return name in this.attributes; }
    getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
    querySelector(selector: string): FakeElement | null {
      return selector === '[data-action-message]' ? this.message : null;
    }
    reset(): void { this.resetCount += 1; }
  }
  class FakeInput {}

  const requests: Array<{
    endpoint: string;
    init: { method?: string; credentials?: string; body?: string; headers: Record<string, string> };
  }> = [];
  const confirmations: string[] = [];
  const submitListeners: Array<(event: unknown) => void> = [];
  const state = {
    confirmAnswer: true,
    responsePayload: { ok: true } as Record<string, unknown>,
    requests,
    confirmations,
    form: (attributes: Record<string, string>, fields: Record<string, string>) =>
      new FakeForm(attributes, fields),
    async submit(form: FakeForm) {
      for (const listener of submitListeners) listener({ target: form, preventDefault() {} });
      // The handler is async and dispatched with `void`; let it settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };

  const documentStub = {
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (type === 'submit') submitListeners.push(listener);
    },
    querySelector: () => null,
  };
  const windowStub = {
    confirm(text: string) { confirmations.push(text); return state.confirmAnswer; },
    location: { href: 'http://worker.test/dashboard', reload() {}, assign() {} },
  };
  const fetchStub = async (endpoint: string, init: never) => {
    requests.push({ endpoint, init: init as never });
    return { ok: true, status: 200, json: async () => state.responsePayload };
  };
  const formDataStub = class {
    private form: FakeForm;
    constructor(form: FakeForm) { this.form = form; }
    entries() { return Object.entries(this.form.fields); }
  };

  const source = controlScript({ csrfToken })
    .replace(/^\s*<script>/, '')
    .replace(/<\/script>\s*$/, '');
  // eslint-disable-next-line no-new-func
  const run = new Function(
    'document', 'window', 'fetch', 'FormData', 'HTMLFormElement', 'HTMLInputElement', 'setTimeout',
    source,
  );
  run(documentStub, windowStub, fetchStub, formDataStub, FakeForm, FakeInput, setTimeout);
  return state;
}

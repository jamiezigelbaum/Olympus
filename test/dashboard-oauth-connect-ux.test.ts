// The four ways the dashboard's OAuth connect flow stranded the owner on
// 2026-09-03, when the page was first served over https and EVERY provider
// refused reauthorization:
//
//   Google  "Error 400: redirect_uri_mismatch"
//   Dropbox "Invalid redirect_uri: .../oauth/callback/dropbox must exactly
//            match one pre-configured"
//   X       "Something went wrong"
//
// The worker derives its callback from the request origin, and none of those
// URIs were registered on the owner's provider apps. The model already computed
// the URI to register and the setup text already said "Register the exact
// redirect URI shown on this card" — but nothing rendered it, Google was
// excluded from computing one at all, the provider replaced the dashboard tab,
// a pending attempt could be neither cancelled nor corrected, and a refusal left
// the row reading "connecting" until the record expired.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import { oauthAuthorizeOrigin } from '../src/core/connect.ts';
import type { ExternalPendingOAuthConnection } from '../src/core/connect.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import { isV04PublicDashboardRoute } from '../src/core/public-surface.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import {
  buildSourceDashboardViewModel,
  type DashboardPendingConnect,
  type DashboardSourceAction,
  type DashboardSourceCard,
  type SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';
import { controlScript } from '../src/workers/dashboard/components.ts';
import { renderDashboardSetupPage } from '../src/workers/dashboard/pages/setup.ts';
import { renderDashboardHomePage } from '../src/workers/dashboard/pages/home.ts';
import { dashboardAttentionLine, dashboardStatus } from '../src/workers/dashboard/vocabulary.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const TAILNET = 'https://private-host.example-tailnet.ts.net';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the redirect URI the provider has to accept is a fact the page states', () => {
  test('every OAuth source carries the exact callback URI its own connect action emits', () => {
    const view = buildView({ oauthRedirectBaseUrl: TAILNET });

    // The path segment is the `source` value the start route builds
    // /oauth/callback/<source> from. The Google cards emit `gmail` and
    // `google-drive`; the shared `google` key is never a callback path.
    expect(redirectUriOf(view, 'gmail.email')).toBe(`${TAILNET}/oauth/callback/gmail`);
    expect(redirectUriOf(view, 'google_drive.docs')).toBe(`${TAILNET}/oauth/callback/google-drive`);
    expect(redirectUriOf(view, 'dropbox.files')).toBe(`${TAILNET}/oauth/callback/dropbox`);
    expect(redirectUriOf(view, 'x.bookmarks')).toBe(`${TAILNET}/oauth/callback/x`);
  });

  test('a source whose client key is already registered carries it too', () => {
    // This is the state every one of the owner's sources was in: the key was on
    // file, so the row offered a bare Reauthenticate and the URI was computed
    // for the setup sheet nobody could reach.
    const view = buildView({
      oauthRedirectBaseUrl: TAILNET,
      oauthClientIds: { dropbox: 'dropbox-app-key' },
    });

    expect(actionOf(view, 'dropbox.files')).toMatchObject({
      kind: 'oauth',
      source: 'dropbox',
      known_client_id: 'dropbox-app-key',
      redirect_uri_to_register: `${TAILNET}/oauth/callback/dropbox`,
    });
  });

  test('a worker that cannot name its own origin claims no redirect URI at all', () => {
    const view = buildView({});

    for (const sourceId of ['gmail.email', 'google_drive.docs', 'dropbox.files', 'x.bookmarks']) {
      expect(redirectUriOf(view, sourceId)).toBeUndefined();
    }
  });

  test('the guidance names the console screen the URI goes on, per provider', () => {
    const view = buildView({ oauthRedirectBaseUrl: TAILNET });

    expect(guidanceOf(view, 'dropbox.files')).toContain('OAuth 2 → Redirect URIs');
    expect(guidanceOf(view, 'x.bookmarks')).toContain('User authentication settings → Callback URI');
  });
});

describe('the Google client type follows the origin this dashboard is served on', () => {
  test('an https dashboard needs a Web application client, and says so everywhere', () => {
    const view = buildView({ oauthRedirectBaseUrl: TAILNET });
    const action = actionOf(view, 'gmail.email') as Extract<DashboardSourceAction, { kind: 'needs_setup' }>;

    expect(action.redirect_uri_guidance).toContain('Web application client');
    expect(action.redirect_uri_guidance).toContain('A Desktop app client cannot register an https redirect URI');
    expect(action.instructions.plain_intro).toContain('Google Web application Client ID');
    expect(action.instructions.agent_prompt).toContain('OAuth client of type Web application');
    expect(action.instructions.agent_prompt).toContain("Authorized redirect URIs");
    expect(action.instructions.diy_steps.some((step) => step.text.includes('choose Web application'))).toBe(true);
    expect(action.instructions.plain_intro).not.toContain('Desktop app Client ID');
  });

  test('a loopback dashboard keeps the Desktop app client, with nothing to register', () => {
    const view = buildView({ oauthRedirectBaseUrl: 'http://127.0.0.1:8010' });
    const action = actionOf(view, 'gmail.email') as Extract<DashboardSourceAction, { kind: 'needs_setup' }>;

    expect(action.redirect_uri_to_register).toBe('http://127.0.0.1:8010/oauth/callback/gmail');
    expect(action.redirect_uri_guidance).toContain('Desktop app client');
    expect(action.redirect_uri_guidance).toContain('no redirect URI to register');
    expect(action.instructions.plain_intro).toContain('Google Desktop app Client ID');
    expect(action.instructions.agent_prompt).toContain('OAuth client of type Desktop app');
    expect(action.instructions.diy_steps.some((step) => step.text.includes('choose Desktop app'))).toBe(true);
  });
});

describe('a provider refusal is a state the owner can act on, not a stuck handshake', () => {
  test('a refused attempt leaves the connecting state and names what was refused', () => {
    const refused = buildView({
      oauthRedirectBaseUrl: TAILNET,
      oauthClientIds: { dropbox: 'dropbox-app-key' },
      pendingConnects: [pending('dropbox', { code: 'redirect_uri_mismatch' })],
    });
    const card = cardOf(refused, 'dropbox.files');

    expect(card.connection.state).not.toBe('awaiting_consent');
    expect(card.connection.provider_refusal).toEqual({
      code: 'redirect_uri_mismatch',
      reason: `Provider refused the callback (redirect_uri_mismatch): register ${TAILNET}/oauth/callback/dropbox at OAuth 2 → Redirect URIs, then Connect again`,
    });
    // A refusal is the owner's homework whatever the registry says: a source
    // that has never connected would otherwise read 'Off' and leave home.
    expect(dashboardStatus({ source: card })).toBe('Needs you');
    expect(dashboardAttentionLine(card)).toBe(card.connection.provider_refusal!.reason);
  });

  test('a pending attempt with no refusal still reads as awaiting consent', () => {
    const view = buildView({
      oauthRedirectBaseUrl: TAILNET,
      oauthClientIds: { dropbox: 'dropbox-app-key' },
      pendingConnects: [pending('dropbox')],
    });
    const card = cardOf(view, 'dropbox.files');

    expect(card.connection.state).toBe('awaiting_consent');
    expect(card.connection.provider_refusal).toBeUndefined();
    // ...and its action offers the way out of it.
    expect(card.connection.action).toMatchObject({ kind: 'oauth', pending_attempt: true });
  });
});

describe('the connect sheet carries the URI, an editable key, and a way to give up', () => {
  test('the setup page renders the redirect URI above the Client ID field, copyable', () => {
    const html = renderDashboardSetupPage(buildView({
      oauthRedirectBaseUrl: TAILNET,
      oauthClientIds: { dropbox: 'dropbox-app-key' },
    }), { now: NOW });
    const sheet = sheetFor(html, 'connect-dropbox-files');

    expect(sheet).toContain(`<div class="promptbox" id="connect-dropbox-files-redirect">${TAILNET}/oauth/callback/dropbox</div>`);
    expect(sheet).toContain('data-copy-target="#connect-dropbox-files-redirect"');
    expect(sheet).toContain('OAuth 2 → Redirect URIs');
    // Above the field, not below it: registering the URI is the step before the
    // key is worth pasting.
    expect(sheet.indexOf('connect-dropbox-files-redirect')).toBeLessThan(sheet.indexOf('name="client_id"'));
    // Prefilled AND editable — a wrong client id was previously unchangeable.
    expect(sheet).toContain('name="client_id" required value="dropbox-app-key"');
    expect(sheet).not.toContain('readonly');
  });

  test('a pending attempt gets a Cancel control; a quiet source does not', () => {
    const pendingHtml = renderDashboardSetupPage(buildView({
      oauthRedirectBaseUrl: TAILNET,
      oauthClientIds: { dropbox: 'dropbox-app-key' },
      pendingConnects: [pending('dropbox')],
    }), { now: NOW });

    expect(pendingHtml).toContain('data-connect-kind="oauth_cancel"');
    expect(pendingHtml).toContain('>Cancel connection attempt</button>');
    // The Connecting row itself is no longer a dead end either.
    expect(pendingHtml).toContain('>Cancel</button>');

    const quietHtml = renderDashboardSetupPage(buildView({
      oauthRedirectBaseUrl: TAILNET,
      oauthClientIds: { dropbox: 'dropbox-app-key' },
    }), { now: NOW });
    expect(quietHtml).not.toContain('data-connect-kind="oauth_cancel"');
  });

  test("home's reconnect row opens the same sheet and repeats the refusal", () => {
    const html = renderDashboardHomePage(buildView({
      oauthRedirectBaseUrl: TAILNET,
      oauthClientIds: { dropbox: 'dropbox-app-key' },
      pendingConnects: [pending('dropbox', { code: 'redirect_uri_mismatch' })],
    }), { now: NOW, controlSessionCsrfToken: 'csrf-fixture' });

    expect(html).toContain('data-sheet-toggle="#connect-dropbox-files"');
    expect(html).toContain('Provider refused the callback (redirect_uri_mismatch)');
    expect(html).toContain(`${TAILNET}/oauth/callback/dropbox`);
  });

  test('every rendered redirect URI is escaped rather than trusted as markup', () => {
    const html = renderDashboardSetupPage(buildView({
      oauthRedirectBaseUrl: 'https://host.example/"><script>evil()</script>',
      oauthClientIds: { dropbox: 'dropbox-app-key' },
    }), { now: NOW });

    expect(html).not.toContain('<script>evil()');
    expect(html).toContain('&lt;script&gt;evil()&lt;/script&gt;');
  });
});

describe('the card walks the owner through registering the callback itself', () => {
  test('Dropbox names its console, its permissions, its setting, and what to bring back', () => {
    const sheet = connectSheet('dropbox.files', { dropbox: 'dropbox-app-key' });

    expect(sheet).toContain('href="https://www.dropbox.com/developers/apps"');
    expect(sheet).toContain('Open the Dropbox App Console');
    expect(sheet).toContain('Scoped access app');
    expect(sheet).toContain('files.metadata.read and files.content.read');
    expect(sheet).toContain('<b>OAuth 2 → Redirect URIs</b>');
    expect(sheet).toContain(`<div class="promptbox" id="connect-dropbox-files-redirect">${TAILNET}/oauth/callback/dropbox</div>`);
    expect(sheet).toContain('data-copy-target="#connect-dropbox-files-redirect"');
    expect(sheet).toContain('Copy the App key back into the field below and press Connect');
    // Four steps, in order, above the fields.
    expect(sheet.split('<li>')).toHaveLength(5);
    expect(sheet.indexOf('<ol class="steps">')).toBeLessThan(sheet.indexOf('name="client_id"'));
  });

  test('X names its portal, its scopes, its paid-access requirement, and its setting', () => {
    const sheet = setupSheet('x.bookmarks');

    expect(sheet).toContain('href="https://console.x.com/"');
    expect(sheet).toContain('OAuth 2.0 user authentication');
    expect(sheet).toContain('bookmark.read, tweet.read and users.read');
    expect(sheet).toContain('paid X API access');
    expect(sheet).toContain('<b>User authentication settings → Callback URI</b>');
    expect(sheet).toContain(`${TAILNET}/oauth/callback/x`);
  });

  test('Google over https names the credentials console, the client type, and the API to enable', () => {
    const sheet = setupSheet('gmail.email');

    expect(sheet).toContain('href="https://console.cloud.google.com/apis/credentials"');
    expect(sheet).toContain('type Web application');
    expect(sheet).toContain('enable the Gmail API');
    expect(sheet).toContain('<b>Authorized redirect URIs</b>');
    expect(sheet).toContain(`${TAILNET}/oauth/callback/gmail`);
    expect(setupSheet('google_drive.docs')).toContain('enable the Google Drive API');
  });

  test('a loopback Google install is told there is nothing to register, and gets no steps', () => {
    const sheet = setupSheet('gmail.email', {}, 'http://127.0.0.1:8010');

    expect(sheet).toContain('No registration needed on this machine');
    expect(sheet).not.toContain('<ol class="steps">');
    // The URI is still shown; it is what a reader debugging a failed callback
    // needs, and it costs them no step.
    expect(sheet).toContain('http://127.0.0.1:8010/oauth/callback/gmail');
  });

  test('the agent prompt is demoted to a disclosure under the form, not the walkthrough', () => {
    const sheet = connectSheet('dropbox.files', { dropbox: 'dropbox-app-key' });

    expect(sheet).toContain('<summary>Ask your agent to walk you through it</summary>');
    expect(sheet).toContain('>Copy prompt</button>');
    expect(sheet.indexOf('<ol class="steps">')).toBeLessThan(sheet.indexOf('agentprompt'));
  });

  test('the refusal sentence names the same setting the steps name', () => {
    const refused = buildView({
      oauthRedirectBaseUrl: TAILNET,
      oauthClientIds: { x: 'x-client-id' },
      pendingConnects: [pending('x', { code: 'redirect_uri_mismatch' })],
    });

    expect(cardOf(refused, 'x.bookmarks').connection.provider_refusal?.reason).toBe(
      `Provider refused the callback (redirect_uri_mismatch): register ${TAILNET}/oauth/callback/x`
      + ' at User authentication settings → Callback URI, then Connect again',
    );
  });
});

describe('the provider opens in its own tab', () => {
  test('the tab is pre-opened inside the gesture, never with noopener', () => {
    const script = controlScript({ csrfToken: 'csrf-fixture' });

    // window.open(..., 'noopener') returns null by spec EVEN ON SUCCESS, so a
    // truthiness check on it declared every successful connect blocked. The tab
    // is opened blank inside the submit event — the only moment the browser
    // will allow it — its opener severed by hand, and pointed at the provider
    // once /start answers.
    expect(script).toContain("window.open('', '_blank')");
    expect(script).toContain('tab.opener = null');
    expect(script).toContain('authorizationTab.location = payload.authorization_url');
    expect(script).not.toContain("'noopener')");
    expect(script).not.toContain('window.location.assign(payload.authorization_url)');
    // A tab that was never opened is stated, not diagnosed: the page cannot
    // know why the browser refused.
    expect(script).toContain("If a new tab didn't open, open it here");
    expect(script).not.toContain('blocked the new tab');
    // The fallback is a node with a checked https href, never interpolated
    // markup, and the dashboard tab keeps polling either way.
    expect(script).toContain("String(url).indexOf('https://') !== 0");
    expect(script).toContain("document.createElement('a')");
    // A blank tab is never left orphaned when the start call does not produce
    // an authorization URL.
    expect(script).toContain('closeAuthorizationTab(authorizationTab)');
  });

  test('the cancel form posts to the cancel route and nothing else does', () => {
    const script = controlScript({});

    expect(script).toContain("'/dashboard/connect/oauth/cancel'");
    expect(script).toContain("connectKind === 'oauth_cancel'");
  });
});

describe('the worker routes the cancel and lands the callback in the tab it happened in', () => {
  test('cancel deletes the pending attempt, and the card stops awaiting consent', async () => {
    const worker = fixtureWorker();

    const started = await worker.fetch(jsonRequest('/dashboard/connect/oauth/start', {
      source: 'dropbox',
      client_id: 'dropbox-app-key',
    }));
    expect(started.status).toBe(200);
    expect(await pendingSources(worker)).toEqual(['dropbox']);

    const cancelled = await worker.fetch(jsonRequest('/dashboard/connect/oauth/cancel', { source: 'dropbox' }));
    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toMatchObject({ ok: true, source: 'dropbox', cancelled: true });
    expect(await pendingSources(worker)).toEqual([]);

    // Cancelling nothing is honest rather than an error.
    const again = await worker.fetch(jsonRequest('/dashboard/connect/oauth/cancel', { source: 'dropbox' }));
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({ cancelled: false });
  });

  test('a new Connect replaces the pending attempt instead of reusing it', async () => {
    const worker = fixtureWorker();

    await worker.fetch(jsonRequest('/dashboard/connect/oauth/start', { source: 'dropbox', client_id: 'first-key' }));
    await worker.fetch(jsonRequest('/dashboard/connect/oauth/start', { source: 'dropbox', client_id: 'second-key' }));

    // One record per source, and the client id the sheet last submitted is the
    // one a later start reuses.
    expect(await pendingSources(worker)).toEqual(['dropbox']);
    const view = await dashboardJson(worker);
    expect(actionOf(view, 'dropbox.files')).toMatchObject({ known_client_id: 'second-key' });
  });

  test('the cancel route is a declared public dashboard route and a custody-gated control', async () => {
    expect(isV04PublicDashboardRoute('POST', '/dashboard/connect/oauth/cancel')).toBe(true);
    expect(isV04PublicDashboardRoute('GET', '/dashboard/connect/oauth/cancel')).toBe(false);

    // Same boundary as the start route it undoes: no bearer, no session, no act.
    const guarded = withWorkerBearerAuth(
      async () => new Response('should not reach the worker'),
      { authToken: 'worker-bearer' },
    );
    const refused = await guarded(jsonRequest('/dashboard/connect/oauth/cancel', { source: 'dropbox' }));
    expect(refused.status).toBe(401);
  });

  test('the motivating error survives the real callback: redirect_uri_mismatch is repeatable', async () => {
    const worker = fixtureWorker();
    const state = await startAttempt(worker, 'dropbox');

    const callback = await worker.fetch(new Request(
      `http://worker.test/oauth/callback/dropbox?error=redirect_uri_mismatch&state=${encodeURIComponent(state)}`,
    ));
    expect(callback.status).toBe(400);
    const html = await callback.text();
    expect(html).toContain('You can close this tab');
    // Through the route, not by injecting into the view model: the code has to
    // be in the real allowlist in core/connect.ts or it collapses to
    // unrecognized_error and the card cannot name the owner's actual failure.
    expect(html).toContain('redirect_uri_mismatch');

    const view = await dashboardJson(worker);
    expect(cardOf(view, 'dropbox.files').connection.provider_refusal).toMatchObject({
      code: 'redirect_uri_mismatch',
    });
    expect(cardOf(view, 'dropbox.files').connection.state).not.toBe('awaiting_consent');
  });

  test('a refused callback with the right state records the code and the dashboard reads it', async () => {
    const worker = fixtureWorker();
    const state = await startAttempt(worker, 'dropbox');

    const callback = await worker.fetch(new Request(
      `http://worker.test/oauth/callback/dropbox?error=access_denied&state=${encodeURIComponent(state)}`,
    ));
    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain('You can close this tab');

    const view = await dashboardJson(worker);
    expect(cardOf(view, 'dropbox.files').connection.provider_refusal).toMatchObject({ code: 'access_denied' });
  });

  test('provider text outside the allowlist never reaches the card', async () => {
    const worker = fixtureWorker();
    const state = await startAttempt(worker, 'dropbox');

    await worker.fetch(new Request(
      `http://worker.test/oauth/callback/dropbox?state=${encodeURIComponent(state)}&error=`
      + encodeURIComponent('secret-bearer-abc123 <script>'),
    ));

    const view = await dashboardJson(worker);
    const refusal = cardOf(view, 'dropbox.files').connection.provider_refusal;
    expect(refusal?.code).toBe('unrecognized_error');
    expect(JSON.stringify(view)).not.toContain('secret-bearer-abc123');
  });
});

// /oauth/callback/ is unauthenticated by necessity — a provider redirect is a
// GET anyone can make — so the flow's own `state` is the only thing separating
// the owner's callback from a stranger's. Nothing may be written before it is
// checked.
describe('an unauthenticated callback cannot touch an attempt without its state', () => {
  test('no state at all changes nothing', async () => {
    const worker = fixtureWorker();
    await startAttempt(worker, 'dropbox');

    const forged = await worker.fetch(new Request(
      'http://worker.test/oauth/callback/dropbox?error=access_denied',
    ));
    expect(forged.status).toBe(410);

    const view = await dashboardJson(worker);
    // Untouched: still pending, still awaiting consent, no refusal recorded.
    expect(cardOf(view, 'dropbox.files').connection.state).toBe('awaiting_consent');
    expect(cardOf(view, 'dropbox.files').connection.provider_refusal).toBeUndefined();
  });

  test("another source's state changes nothing", async () => {
    const worker = fixtureWorker();
    const dropboxState = await startAttempt(worker, 'dropbox');
    await startAttempt(worker, 'x');

    const crossed = await worker.fetch(new Request(
      `http://worker.test/oauth/callback/x?error=access_denied&state=${encodeURIComponent(dropboxState)}`,
    ));
    expect(crossed.status).toBe(410);

    const view = await dashboardJson(worker);
    expect(cardOf(view, 'x.bookmarks').connection.state).toBe('awaiting_consent');
    expect(cardOf(view, 'x.bookmarks').connection.provider_refusal).toBeUndefined();
    expect(cardOf(view, 'dropbox.files').connection.provider_refusal).toBeUndefined();
  });

  test('a stale state from a replaced attempt changes nothing', async () => {
    const worker = fixtureWorker();
    const first = await startAttempt(worker, 'dropbox');
    const second = await startAttempt(worker, 'dropbox');
    expect(second).not.toBe(first);

    const stale = await worker.fetch(new Request(
      `http://worker.test/oauth/callback/dropbox?error=access_denied&state=${encodeURIComponent(first)}`,
    ));
    expect(stale.status).toBe(410);

    const view = await dashboardJson(worker);
    expect(cardOf(view, 'dropbox.files').connection.state).toBe('awaiting_consent');
    expect(cardOf(view, 'dropbox.files').connection.provider_refusal).toBeUndefined();
  });

  test('a wrong state answers exactly as a missing attempt does', async () => {
    const worker = fixtureWorker();
    await startAttempt(worker, 'dropbox');

    const wrongState = await worker.fetch(new Request(
      'http://worker.test/oauth/callback/dropbox?code=c&state=not-the-state',
    ));
    // Same source, same probe, with the attempt now genuinely gone.
    await worker.fetch(jsonRequest('/dashboard/connect/oauth/cancel', { source: 'dropbox' }));
    const noAttempt = await worker.fetch(new Request(
      'http://worker.test/oauth/callback/dropbox?code=c&state=not-the-state',
    ));

    // One answer for four facts, so an unauthenticated prober cannot use this
    // route to learn whether a connect is in flight.
    expect(wrongState.status).toBe(noAttempt.status);
    expect(await wrongState.text()).toBe(await noAttempt.text());
  });

  test('neither landing page carries a dashboard token, whatever return_to said', async () => {
    const worker = fixtureWorker();
    const state = await startAttempt(worker, 'dropbox', 'http://worker.test/dashboard?token=dash_live-view-token');

    const refused = await worker.fetch(new Request(
      `http://worker.test/oauth/callback/dropbox?error=access_denied&state=${encodeURIComponent(state)}`,
    ));
    const refusedHtml = await refused.text();
    // The exact href: one fixed relative path. Not the submitted return_to,
    // and not the request origin either — a Host header is caller-controlled
    // and has no business being interpolated into a page.
    expect(refusedHtml).toContain('href="/dashboard"');
    expect(refusedHtml).not.toContain('http://worker.test/dashboard');
    expect(refusedHtml).not.toContain('dash_live-view-token');
    expect(refusedHtml).not.toContain('token=');

    const okState = await startAttempt(worker, 'dropbox', 'http://worker.test/dashboard?token=dash_live-view-token');
    const redirected = await worker.fetch(new Request(
      `http://worker.test/oauth/callback/dropbox?code=dropbox-code&state=${encodeURIComponent(okState)}`,
    ));
    // The redirect itself carries no query, so it cannot carry the token
    // either — the interesting assertion is about the page it lands on.
    expect(redirected.headers.get('Location')).toBe('/oauth/callback/dropbox/done');
    const completed = await followOAuthDone(worker, redirected);
    const completedHtml = await completed.text();
    expect(completed.status).toBe(200);
    expect(completedHtml).toContain('href="/dashboard"');
    expect(completedHtml).not.toContain('http://worker.test/dashboard');
    expect(completedHtml).not.toContain('dash_live-view-token');
    expect(completedHtml).not.toContain('token=');
  });

  test('a poisoned return_to reaches neither landing page', async () => {
    // `return_to` is submitted by the page and is therefore caller-controlled.
    // It is no longer read at all — not parsed, not stored, not rendered — so
    // none of these can steer the link, and no allowlist has to stay complete.
    const poisoned = [
      'https://attacker.example/dashboard',
      'javascript:alert(1)//',
      '//attacker.example/dashboard',
      'http://worker.test/dashboard?token=dash_live-view-token#dash_fragment',
      'http://worker.test/dashboard.json?token=dash_live-view-token',
    ];

    for (const returnTo of poisoned) {
      const worker = fixtureWorker();
      const state = await startAttempt(worker, 'dropbox', returnTo);
      const callback = await worker.fetch(new Request(
        `http://worker.test/oauth/callback/dropbox?error=access_denied&state=${encodeURIComponent(state)}`,
      ));
      const html = await callback.text();

      expect(html).toContain('href="/dashboard"');
      expect(html).not.toContain('attacker.example');
      expect(html).not.toContain('javascript:');
      expect(html).not.toContain('dash_live-view-token');
      expect(html).not.toContain('dash_fragment');
      // Only the one anchor, and it is the fixed path.
      expect(html.match(/href="[^"]*"/g)).toEqual(['href="/dashboard"']);
    }
  });

  test('each landing page says the close-this-tab sentence exactly once', async () => {
    const worker = fixtureWorker();
    const refusedState = await startAttempt(worker, 'dropbox');
    const refused = await (await worker.fetch(new Request(
      `http://worker.test/oauth/callback/dropbox?error=access_denied&state=${encodeURIComponent(refusedState)}`,
    ))).text();
    const okState = await startAttempt(worker, 'dropbox');
    const completed = await (await followOAuthDone(worker, await worker.fetch(new Request(
      `http://worker.test/oauth/callback/dropbox?code=dropbox-code&state=${encodeURIComponent(okState)}`,
    )))).text();

    // The template used to hardcode this sentence on top of whatever the caller
    // said, so the success page printed it twice in a row in two wordings.
    expect(refused.match(/You can close this tab/g)).toHaveLength(1);
    expect(completed.match(/You can close this tab/g)).toHaveLength(1);
    // Success keeps the more specific wording: it also says what happens next.
    expect(completed).toContain('It picks the new connection up on its own.');
    expect(completed).not.toContain('You can close this tab and return to the Olympus dashboard.');
  });

  test('the expired-attempt page is the same fixed link, with no origin echoed', async () => {
    const worker = fixtureWorker();

    // No attempt at all: the neutral page, which is also the page a forged
    // callback gets. It is rendered before any attempt is looked up, so it is
    // the one most exposed to a caller-controlled Host header.
    const neutral = await worker.fetch(new Request(
      'http://attacker-controlled-host.example/oauth/callback/dropbox?code=c&state=s',
    ));
    const html = await neutral.text();

    expect(neutral.status).toBe(410);
    expect(html).toContain('href="/dashboard"');
    expect(html).not.toContain('attacker-controlled-host.example');
  });
});

describe('the cancel route sits behind the same custody as every other control', () => {
  test('no session refuses, a bad CSRF token refuses, a valid session passes', async () => {
    const reached: Request[] = [];
    const guarded = withWorkerBearerAuth(async (request) => {
      reached.push(request);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }, { authToken: 'worker-secret' });

    const noSession = await guarded(jsonRequest('/dashboard/connect/oauth/cancel', { source: 'dropbox' }));
    expect(noSession.status).toBe(401);
    expect(reached).toHaveLength(0);

    const mint = await guarded(new Request('http://worker.test/dashboard/control/session', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret', Origin: 'http://worker.test' },
    }));
    expect(mint.status).toBe(200);
    const cookie = mint.headers.get('Set-Cookie')!.split(';')[0]!;
    const csrfToken = (await mint.json() as { csrf_token: string }).csrf_token;

    const badCsrf = await guarded(new Request('http://worker.test/dashboard/connect/oauth/cancel', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://worker.test',
        'Content-Type': 'application/json',
        'X-Olympus-CSRF': 'not-the-csrf-token',
      },
      body: JSON.stringify({ source: 'dropbox' }),
    }));
    expect(badCsrf.status).toBe(403);
    expect(reached).toHaveLength(0);

    const allowed = await guarded(new Request('http://worker.test/dashboard/connect/oauth/cancel', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://worker.test',
        'Content-Type': 'application/json',
        'X-Olympus-CSRF': csrfToken,
      },
      body: JSON.stringify({ source: 'dropbox' }),
    }));
    expect(allowed.status).toBe(200);
    expect(reached).toHaveLength(1);
  });
});

function fixtureWorker() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-oauth-connect-ux-'));
  dirs.push(dir);
  return createEmailSourceWorker({
    sourceIndexStatus: { async status() { return fixtureStatus(); } },
    sourceDashboard: {
      sovereigntyEngine: fixtureSovereigntyEngine(),
      registryPath: join(dir, 'handles.json'),
      secretStore: memorySecretStore({}),
      startExternalOAuthConnection: async (options) => fixturePending(options),
    },
  });
}

/** Start one connect attempt and return the `state` that flow generated. */
async function startAttempt(
  worker: { fetch(request: Request): Promise<Response> },
  source: 'dropbox' | 'x' | 'gmail' | 'google-drive',
  returnTo?: string,
): Promise<string> {
  const response = await worker.fetch(jsonRequest('/dashboard/connect/oauth/start', {
    source,
    client_id: `${source}-app-key`,
    ...(source === 'x' ? { client_secret: 'x-client-secret' } : {}),
    ...(returnTo ? { return_to: returnTo } : {}),
  }));
  expect(response.status).toBe(200);
  const payload = await response.json() as { authorization_url: string };
  const state = new URL(payload.authorization_url).searchParams.get('state');
  expect(state).toBeTruthy();
  return state!;
}

async function dashboardJson(worker: { fetch(request: Request): Promise<Response> }): Promise<SourceDashboardViewModel> {
  const response = await worker.fetch(new Request('http://worker.test/dashboard.json'));
  expect(response.status).toBe(200);
  return await response.json() as SourceDashboardViewModel;
}

async function pendingSources(worker: { fetch(request: Request): Promise<Response> }): Promise<string[]> {
  const view = await dashboardJson(worker);
  return view.sources
    .filter((source) => source.connection.state === 'awaiting_consent')
    .map((source) => (source.connection.action as { source?: string }).source ?? source.source_id);
}

function buildView(options: {
  oauthRedirectBaseUrl?: string;
  oauthClientIds?: Record<string, string>;
  pendingConnects?: DashboardPendingConnect[];
}): SourceDashboardViewModel {
  return buildSourceDashboardViewModel({
    sourceIndexStatus: fixtureStatus(),
    sovereigntyEngine: fixtureSovereigntyEngine(),
    ...(options.oauthRedirectBaseUrl ? { oauthRedirectBaseUrl: options.oauthRedirectBaseUrl } : {}),
    ...(options.oauthClientIds ? { oauthClientIds: options.oauthClientIds } : {}),
    ...(options.pendingConnects ? { pendingConnects: options.pendingConnects } : {}),
    now: NOW,
  });
}

function pending(source: 'dropbox' | 'x' | 'gmail' | 'google-drive', error?: { code: string }): DashboardPendingConnect {
  return {
    source,
    started_at: new Date(NOW.getTime() - 60_000).toISOString(),
    expires_at: new Date(NOW.getTime() + 540_000).toISOString(),
    ...(error ? { error: { code: error.code, at: NOW.toISOString() } } : {}),
  };
}

function cardOf(view: SourceDashboardViewModel, sourceId: string): DashboardSourceCard {
  const card = view.sources.find((source) => source.source_id === sourceId);
  if (!card) throw new Error(`no card for ${sourceId}`);
  return card;
}

function actionOf(view: SourceDashboardViewModel, sourceId: string): DashboardSourceAction {
  return cardOf(view, sourceId).connection.action;
}

function redirectUriOf(view: SourceDashboardViewModel, sourceId: string): string | undefined {
  return (actionOf(view, sourceId) as { redirect_uri_to_register?: string }).redirect_uri_to_register;
}

function guidanceOf(view: SourceDashboardViewModel, sourceId: string): string | undefined {
  return (actionOf(view, sourceId) as { redirect_uri_guidance?: string }).redirect_uri_guidance;
}

/** The `connect-*` sheet for a source whose client key is on file. */
function connectSheet(sourceId: string, clientIds: Record<string, string>, baseUrl = TAILNET): string {
  const html = renderDashboardSetupPage(buildView({
    oauthRedirectBaseUrl: baseUrl,
    oauthClientIds: clientIds,
  }), { now: NOW });
  return sheetFor(html, `connect-${sourceId.replace(/[^A-Za-z0-9_-]+/g, '-')}`);
}

/** The `setup-*` sheet for a source with no client key registered yet. */
function setupSheet(sourceId: string, clientIds: Record<string, string> = {}, baseUrl = TAILNET): string {
  const html = renderDashboardSetupPage(buildView({
    oauthRedirectBaseUrl: baseUrl,
    oauthClientIds: clientIds,
  }), { now: NOW });
  return sheetFor(html, `setup-${sourceId.replace(/[^A-Za-z0-9_-]+/g, '-')}`);
}

/** One sheet by id, from the page it was rendered into. */
function sheetFor(html: string, sheetId: string): string {
  const start = html.indexOf(`<div class="sheet" id="${sheetId}"`);
  if (start < 0) throw new Error(`no sheet ${sheetId}`);
  const next = html.indexOf('<div class="sheet"', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

function fixtureSovereigntyEngine() {
  return createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
  }));
}

function memorySecretStore(initial: Record<string, string>): SecretStore {
  const values = new Map(Object.entries(initial));
  return {
    label: 'memory',
    get: async (key) => values.get(key),
    getSync: (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
    list: async () => [...values.keys()].sort(),
  };
}

let pendingSequence = 0;

function fixturePending(
  options: { source: ExternalPendingOAuthConnection['source']; redirectUri: string },
): ExternalPendingOAuthConnection {
  // A distinct state per attempt, so a test can send another attempt's state
  // and a stale one and see them both refused.
  pendingSequence += 1;
  const state = `state-${options.source}-${pendingSequence}`;
  // The start route origin-checks the authorization URL against the source's
  // own provider, so the fixture has to answer with that provider's origin.
  const authorizeUrl = oauthAuthorizeOrigin(options.source) === 'https://www.dropbox.com'
    ? 'https://www.dropbox.com/oauth2/authorize'
    : `${oauthAuthorizeOrigin(options.source)}/i/oauth2/authorize`;
  return {
    ok: true,
    source: options.source,
    authorizationUrl: `${authorizeUrl}?state=${state}`,
    redirectUri: options.redirectUri,
    state,
    startedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
    completeCallback: async () => ({
      ok: true,
      source: options.source,
      handles: ['dropbox.personal'],
      registryPath: 'unused',
      secretRefs: [],
    }),
    cancel() {},
  };
}

/**
 * A successful callback now redirects (303) to a query-free `/done` page
 * (MINOR 2, Codex round 2 on 7863a735) rather than rendering the "Connected"
 * page directly at the URL that still carried the spent `code` and `state`.
 * This follows that redirect the way a browser would, for assertions that care
 * about the landing page's own content rather than the redirect itself.
 */
async function followOAuthDone(worker: { fetch: (request: Request) => Promise<Response> }, response: Response): Promise<Response> {
  expect(response.status).toBe(303);
  const location = response.headers.get('Location')!;
  expect(location).toMatch(/^\/oauth\/callback\/[a-z-]+\/done$/);
  return worker.fetch(new Request(`http://worker.test${location}`));
}

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function fixtureStatus(): SourceIndexStatusResult {
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
  } as unknown as SourceIndexStatusResult;
}

import { CONSENT_PAGE_STYLE } from '../../remote-oauth/consent-page.ts';
import { createHash } from 'node:crypto';
import { DROPBOX_MISSING_SCOPE_MESSAGE, safeOAuthErrorCode } from '../../../core/connect.ts';
import type { DashboardPanelCallContext } from '../dashboard/dashboard-panel-tools.ts';
import { DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER, DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER } from '../../http.ts';
import type { DashboardOAuthSource } from '../../source-dashboard.ts';
import { dashboardGoogleOAuthSource } from './dashboard-oauth-clients.ts';
import { CHATGPT_RETURN_TO } from './dashboard-oauth-attempts.ts';
import { html } from './worker-responses.ts';

/**
 * The origin a provider must call back on.
 *
 * An HTTP loopback request derives `http://127.0.0.1`: that is the desktop-app
 * form every provider accepts on localhost, and it is the working local path.
 *
 * Everything else honors the proxy's declared scheme before the scheme this
 * process happened to be spoken to in. Behind `tailscale serve` the TLS
 * terminates at the proxy and the worker is reached over plain HTTP, so the
 * redirect came out as `http://<private-host>.<tailnet>.ts.net/oauth/callback/x` — a
 * non-loopback http callback, which X refuses outright, and the connect flow
 * died on the provider's error page (live, 2026-08-19).
 *
 * Only the SCHEME is taken from the headers, and only the two values a scheme
 * may be. The host stays the one the request carried, so a forged header can
 * never point a callback at another origin.
 */
/** Where a panel tool call came from: the browser's origin, and the gateway's when it came through one. */
/**
 * Who a panel tool call (POST /dashboard/tools/call) opens files as: the
 * control session, by the CSRF token workers/http.ts injects only after the
 * session cookie and its CSRF token checked out, else the worker bearer (the
 * only other way that route is reached). Hashed: the token itself is not kept.
 */
export function dashboardPanelOpener(request: Request): string {
  const csrf = request.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER);
  return csrf ? `session:${createHash('sha256').update(csrf).digest('base64url')}` : 'bearer';
}

export function dashboardPanelCallContext(url: URL, request: Request): DashboardPanelCallContext {
  const gateway = request.headers.get(DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER)?.trim();
  return {
    origin: dashboardOAuthRedirectOrigin(url, request.headers),
    ...(gateway ? { gatewayOrigin: gateway } : {}),
    signal: request.signal,
  };
}

export function dashboardOAuthRedirectOrigin(url: URL, headers?: Headers): string {
  const gatewayPublicOrigin = headers?.get(DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER)?.trim();
  if (gatewayPublicOrigin) {
    // workers/http.ts strips this internal context from every inbound request
    // and restores a normalized value only for the holder of the worker
    // bearer. Re-parse here as a final fail-closed check because this function
    // also has direct unit-test callers that can bypass the HTTP wrapper.
    try {
      const gateway = new URL(gatewayPublicOrigin);
      const loopbackHttp = gateway.protocol === 'http:'
        && (gateway.hostname === 'localhost' || gateway.hostname === '127.0.0.1' || gateway.hostname === '[::1]');
      if (
        !gateway.username
        && !gateway.password
        && gateway.pathname === '/'
        && !gateway.search
        && !gateway.hash
        && (gateway.protocol === 'https:' || loopbackHttp)
      ) return gateway.origin;
    } catch {
      // Fall through to the standalone dashboard's request origin.
    }
  }
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')) {
    return `http://127.0.0.1${url.port ? `:${url.port}` : ''}`;
  }
  const forwardedProtocol = dashboardForwardedProto(headers);
  if (forwardedProtocol && `${forwardedProtocol}:` !== url.protocol) {
    const forwarded = new URL(url.toString());
    forwarded.protocol = `${forwardedProtocol}:`;
    return forwarded.origin;
  }
  return url.origin;
}

/**
 * The scheme a reverse proxy says the client used: `X-Forwarded-Proto` first —
 * the header tailscale serve, nginx and Caddy all set — then RFC 7239
 * `Forwarded: ...;proto=https`. Both may carry a chain, and the client-facing
 * hop is the first entry.
 */
function dashboardForwardedProto(headers: Headers | undefined): 'http' | 'https' | undefined {
  if (!headers) return undefined;
  const forwardedProto = dashboardScheme(headers.get('x-forwarded-proto')?.split(',')[0]);
  if (forwardedProto) return forwardedProto;
  const forwarded = headers.get('forwarded');
  if (!forwarded) return undefined;
  const firstHop = forwarded.split(',')[0] ?? '';
  return dashboardScheme(/(?:^|[;\s])proto\s*=\s*"?([A-Za-z]+)"?/.exec(firstHop)?.[1]);
}

/** Anything that is not one of the two schemes is no answer at all. */
function dashboardScheme(value: string | undefined): 'http' | 'https' | undefined {
  const scheme = value?.trim().toLowerCase();
  return scheme === 'http' || scheme === 'https' ? scheme : undefined;
}

/**
 * What the failure page may say about a callback error.
 *
 * The one variable message repeated verbatim is the exchange failure, whose
 * vocabulary connect.ts already bounds to an HTTP status plus an allowlisted
 * OAuth code. Anything else — connector text, cleanup errors, whatever an
 * injected completer throws — collapses to a fixed sentence: rendering
 * arbitrary Error text on a page is how credential material escapes, and no
 * redaction list is a complete guarantee (R61 through R61E). The earlier
 * value-based redaction layer is deleted with its last caller: a page that
 * only ever speaks bounded text has nothing to redact.
 */
export function safeVeniceCheckFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const allowed = new Set([
    'Venice could not be reached to check your key. No credentials were stored; try again.',
    'Venice could not accept this key. Redo the Create an API key step and check its restrictions. No credentials were stored.',
    'Venice could not check the key now. No credentials were stored; try again.',
    'Venice returned an unreadable check. No credentials were stored; try again.',
    'Venice returned an incomplete check. No credentials were stored; try again.',
    'Venice does not permit this key. Redo the Create an API key step and check its restrictions. No credentials were stored.',
    'Venice did not report a balance. No credentials were stored; try again.',
    'Venice returned an incomplete balance. No credentials were stored; try again.',
    'Venice reports no credit. Redo the Set up your account step and add credit. No credentials were stored.',
  ]);
  return allowed.has(message) ? message : 'The Venice key could not be validated or applied. Try again.';
}

export function dashboardCallbackFailureReason(error: unknown, source: DashboardOAuthSource, clientIdSource?: 'publisher' | 'byo'): string {
  const message = error instanceof Error ? error.message : '';
  // The check's own sentence is worded for the CLI; on the dashboard it names the walkthrough's step.
  if (source === 'dropbox' && clientIdSource === 'byo' && message === DROPBOX_MISSING_SCOPE_MESSAGE) return 'Dropbox needs more permissions. Redo the Enable permissions step and sign in again. No credentials were stored.';
  // Only fixed setup-check sentences may cross the callback HTML boundary.
  const setupMessages = source === 'x' ? [
    'X could not complete the bookmarks read check. No credentials were stored; try connecting again when X is reachable.',
    'X did not authorize the bookmarks read. Redo Enable OAuth 2.0 with bookmark.read and sign in again. No credentials were stored.',
    'X refused the bookmarks read. Redo Check the cost to confirm paid API access and available credits, then Enable OAuth 2.0 with Read permissions and sign in again. No credentials were stored.',
    'X could not complete the bookmarks read check. No credentials were stored; try connecting again later.',
    'X returned an invalid bookmarks read result. No credentials were stored; try connecting again later.',
  ] : dashboardGoogleOAuthSource(source) ? [
    'Google could not be reached for the API check. Try signing in again.',
    'Google did not allow this API read. Redo Make the project and turn on Gmail and Drive, then sign in and allow read access.',
    'Google did not accept the sign-in. Sign in again and allow read access.',
    'Google could not confirm API access. Check your app settings and sign in again.',
  ] : [];
  if (setupMessages.includes(message)) return message;
  const match = /^OAuth token exchange failed with status (\d{3})(?: \(([a-z_]+)\))?\.$/.exec(message);
  // The code inside the shape is re-checked against the allowlist: the shape
  // alone would admit arbitrary lowercase content from a crafted message.
  if (match && (match[2] === undefined || safeOAuthErrorCode(match[2]) !== undefined)) {
    if (source === 'x' && ['401', '403'].includes(match[1]!)) return 'X did not accept the app key. Redo Enable OAuth 2.0, copy the Client ID and secret from the same app, and check the callback URI.';
    return message;
  }
  return `Connecting ${dashboardOAuthSourceLabel(source)} failed partway through. Start connect again from the dashboard.`;
}

/** The product name a callback page uses for a source, never its id. */
function dashboardOAuthSourceLabel(source: DashboardOAuthSource): string {
  const labels: Record<DashboardOAuthSource, string> = {
    google: 'Google',
    gmail: 'Gmail',
    'google-drive': 'Google Drive',
    dropbox: 'Dropbox',
    x: 'X',
    evernote: 'Evernote',
  };
  return labels[source] ?? source;
}

/**
 * The expiry the dashboard shows for a pending consent. The starter's own
 * expiry is honored only when it parses and sits inside (now, now+30min]; an
 * injectable starter's arbitrary string is otherwise replaced with the
 * authorize flow's honest ~10-minute default.
 */
export function dashboardBoundedExpiry(claimed: string | undefined, now: Date): string {
  const ceiling = now.getTime() + 30 * 60_000;
  const parsed = claimed ? Date.parse(claimed) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > now.getTime() && parsed <= ceiling) return new Date(parsed).toISOString();
  return new Date(now.getTime() + 10 * 60_000).toISOString();
}

export function dashboardOAuthFailureHtml(options: {
  source: DashboardOAuthSource;
  reason: string;
  returnTo: string;
  status: number;
}): Response {
  const label = dashboardOAuthSourceLabel(options.source);
  const chatgpt = options.returnTo === CHATGPT_RETURN_TO;
  const permissions = !chatgpt && options.source === 'dropbox'
    && options.reason === 'Dropbox needs more permissions. Redo the Enable permissions step and sign in again. No credentials were stored.';
  return dashboardOAuthLandingHtml({
    title: 'Olympus connect failed',
    heading: `Could not connect ${label}`,
    paragraphs: [
      `Could not connect ${label}: ${options.reason}`,
      chatgpt
        ? 'Go back to ChatGPT and try again from your Olympus dashboard.'
        : 'You can close this tab and go back to the Olympus dashboard tab you started from.',
    ],
    returnTo: permissions ? '/dashboard#olympus-open=dropbox.permissions' : options.returnTo,
    returnLabel: permissions ? 'Go to Dropbox permissions' : chatgpt ? 'Back to ChatGPT' : 'Back to the dashboard tab',
    status: options.status,
  });
}

/**
 * What the authorization tab says once the callback has been exchanged.
 *
 * This page is reached in the tab `window.open` created, not in the dashboard,
 * so it tells the reader the one thing that is true of that tab: it is finished
 * and can be closed. It also names the tab that is NOT finished — the dashboard
 * the flow was started from, which is still open and polling — because the
 * reader's actual next step is to look at that tab, not to open a second one.
 * The link back is kept for the reader who opened the flow in this tab anyway
 * (an old bookmark, a copied authorization URL).
 */
export function dashboardOAuthCompleteHtml(options: {
  source: DashboardOAuthSource;
  returnTo: string;
}): Response {
  const chatgpt = options.returnTo === CHATGPT_RETURN_TO;
  return dashboardOAuthLandingHtml({
    title: 'Olympus connected',
    heading: `${dashboardOAuthSourceLabel(options.source)} connected`,
    // The more specific of the two sentences: it also says what happens next,
    // and where. The dashboard that started this sign-in never navigated away.
    paragraphs: [chatgpt
      ? 'Go back to ChatGPT; your Olympus dashboard updates on its own.'
      : 'You can close this tab. The Olympus dashboard tab you started from is still open. It picks the new connection up on its own.'],
    returnTo: options.returnTo,
    returnLabel: chatgpt ? 'Back to ChatGPT' : 'Back to the dashboard tab',
    status: 200,
  });
}

/**
 * The shared shell for both callback pages.
 *
 * The close-this-tab sentence belongs to the CALLER, not to this template. It
 * used to be hardcoded here on top of whatever the caller said, so the success
 * page printed two near-identical sentences in a row — "You can close this tab
 * and go back to the Olympus dashboard" followed by "You can close this tab and
 * return to the Olympus dashboard". Each page now says it once, in its own
 * words.
 */
function dashboardOAuthLandingHtml(options: {
  title: string;
  heading: string;
  paragraphs: readonly string[];
  returnTo: string;
  returnLabel: string;
  status: number;
}): Response {
  const paragraphs = options.paragraphs
    .map((paragraph) => `      <p>${escapeHtml(paragraph)}</p>`)
    .join('\n');
  // The consent page's look (light and dark), plus a link styled as its
  // secondary button. Inline: these pages load nothing.
  return html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(options.title)}</title>
    <style>${CONSENT_PAGE_STYLE}
a.back { display: inline-block; margin-top: .5rem; padding: .7rem 1rem; border: 1px solid var(--line); border-radius: 10px;
  color: var(--fg); text-decoration: none; font-weight: 600; }</style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(options.heading)}</h1>
${paragraphs}
      <p><a class="back" href="${escapeHtml(options.returnTo)}">${escapeHtml(options.returnLabel)}</a></p>
    </main>
  </body>
</html>`, options.status, {
    // This page is reached at a URL that carried (or still carries) `code` and
    // `state` in its own query string. `no-store` keeps it out of the disk
    // cache, but a browser still sends `Referer` when the reader clicks the
    // "Back to the dashboard tab" link or any future link this page grows —
    // unless the response says not to. Same header the relay's own `_headers`
    // sets for the identical reason. That suppressed Referer is also why an
    // unlocked browser's control-session cookie now authorizes GET /dashboard
    // on its own (see http.ts): this link arrives naming no origin at all.
    'Referrer-Policy': 'no-referrer',
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

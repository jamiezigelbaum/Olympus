/**
 * `GET /connect/signin?go=<hand-off id>&source=<gmail|google-drive>` on the
 * relay: the page a ChatGPT "Connect Gmail" link lands on, which sends the
 * browser to the engine on the owner's own computer,
 * `http://127.0.0.1:<port>/go/<hand-off id>`.
 *
 * Google sign-in runs on that computer (owner decision 2026-10-13,
 * docs/ops/OAUTH_RELAY.md): the engine there redirects to Google, and Google
 * returns to the engine on loopback, so the relay never sees a code or a
 * token. The engine sends a relayed visit of its `/go/<id>` link here
 * instead of spending it; only the direct visit on the computer does.
 *
 * Like the approval bridge (authorize-bridge.ts) the page tries the engine
 * first and continues automatically when it answers; otherwise, for example
 * on a phone, it says to open the link on the computer. Connecting Google
 * from a phone is intentionally not offered. The relay stores nothing from
 * the query: it accepts only a well-formed hand-off id and a source from a
 * fixed list, and never echoes anything else.
 */
import { randomBytes } from 'node:crypto';
import { HANDOFF_PATH_PREFIX, credentialInstallId } from '../shared/tokens.ts';

export interface SigninBridgeOptions {
  /** The engine worker's loopback port (Olympus default 8010). */
  readonly enginePort: number;
}

const SOURCE_NAMES: Readonly<Record<string, string>> = {
  gmail: 'Gmail',
  'google-drive': 'Google Drive',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

export function signinBridge(url: URL, options: SigninBridgeOptions): Response {
  const go = url.searchParams.get('go') ?? '';
  if (url.searchParams.getAll('go').length !== 1 || !credentialInstallId('handoff', go)) {
    return plain(404, 'This Olympus link has expired or was already used. Go back to ChatGPT and try again.');
  }
  const name = SOURCE_NAMES[url.searchParams.get('source') ?? ''] ?? 'Google';
  const engineOrigin = `http://127.0.0.1:${options.enginePort}`;
  const target = `${engineOrigin}${HANDOFF_PATH_PREFIX}${go}`;
  const nonce = randomBytes(16).toString('base64');
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in on your computer · Olympus</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #fbfbfd; --accent: #0a66d8; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --bg: #111113; --accent: #4c9bff; } }
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 32rem; margin: 12vh auto; padding: 0 16px; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
  p { color: var(--muted); }
  a.button { display: inline-block; margin-top: 1rem; padding: .7rem 1.2rem; border-radius: .6rem; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; }
  #missing { display: none; margin-top: 2rem; }
</style>
</head>
<body>
<main>
  <h1>Sign in to ${name} on your computer</h1>
  <p>Olympus runs on your computer, and Google sign-in happens there, so your Google account connects straight to it.</p>
  <a class="button" id="continue" href="${escapeHtml(target)}">Continue on this computer</a>
  <section id="missing">
    <h2>Open this on your computer</h2>
    <p>Olympus did not answer here. Open this link on the computer where Olympus runs, or go back to ChatGPT on that computer and press Connect again.</p>
  </section>
</main>
<script nonce="${nonce}">
  (function () {
    var target = document.getElementById('continue').href;
    var missing = document.getElementById('missing');
    var settled = false;
    var timer = setTimeout(function () { if (!settled) { settled = true; missing.style.display = 'block'; } }, 3000);
    fetch(${JSON.stringify(`${engineOrigin}/.well-known/oauth-authorization-server`)}, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' })
      .then(function () { if (!settled) { settled = true; clearTimeout(timer); window.location.replace(target); } })
      .catch(function () { if (!settled) { settled = true; clearTimeout(timer); missing.style.display = 'block'; } });
  })();
</script>
</body>
</html>
`;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        `connect-src ${engineOrigin}`,
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    },
  });
}

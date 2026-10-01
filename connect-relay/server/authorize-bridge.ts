/**
 * `GET /connect/authorize` on the relay: a small page that sends the browser
 * to the engine's consent page on the owner's own Mac,
 * `http://127.0.0.1:<port>/connect/authorize?<the same query>`.
 *
 * Approval happens only there: the engine accepts consent from direct
 * loopback requests and refuses anything that came through the relay, so
 * possession of the Mac plus a click is the proof of ownership. The relay
 * neither reads nor stores the query; it copies it into the link verbatim
 * (escaped for HTML).
 *
 * The page tries to reach the engine first and continues automatically when
 * something answers; otherwise it keeps the link and offers to install
 * Olympus. Browsers that refuse a public page talking to loopback simply show
 * both choices. A relay configured with a demo install also links reviewers
 * to its sign-in (`/connect/demo/authorize`, same query).
 */
import { randomBytes } from 'node:crypto';

export const MAX_AUTHORIZE_QUERY_BYTES = 8 * 1024;

export interface BridgeOptions {
  /** The engine worker's loopback port (Olympus default 8010). */
  readonly enginePort: number;
  /** Where "Install Olympus" leads. */
  readonly installUrl: string;
  /** The relay has a demo install: offer reviewers its sign-in. */
  readonly demo?: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function authorizeBridge(url: URL, options: BridgeOptions): Response {
  const query = url.search;
  if (query.length > MAX_AUTHORIZE_QUERY_BYTES) {
    return new Response('The authorization request is too long.', { status: 414, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const engineOrigin = `http://127.0.0.1:${options.enginePort}`;
  const target = `${engineOrigin}/connect/authorize${query}`;
  const nonce = randomBytes(16).toString('base64');
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Approve on your Mac · Olympus</title>
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
  <h1>Approve ChatGPT on your Mac</h1>
  <p>Olympus asks for approval on the Mac where it runs, so only you can connect it.</p>
  <a class="button" id="continue" href="${escapeHtml(target)}">Continue on this Mac</a>
  ${options.demo ? `<p><a href="${escapeHtml(`/connect/demo/authorize${query}`)}">Reviewing Olympus? Sign in to the demo</a></p>` : ''}
  <section id="missing">
    <h2>Olympus did not answer on this computer</h2>
    <p>Open this page on the Mac where Olympus runs, or install Olympus first.</p>
    <a class="button" href="${escapeHtml(options.installUrl)}" rel="noopener">Install Olympus</a>
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

/**
 * `GET /connect/authorize` on the relay: a small page that sends the browser
 * to the engine's consent page on the owner's own Mac,
 * `http://127.0.0.1:<port>/connect/authorize?<the same query>`.
 *
 * Approval happens only there: the engine accepts consent from direct
 * loopback requests and refuses anything that came through the relay, so
 * possession of the Mac plus a click is the proof of ownership. The relay
 * stores nothing from the query and copies it into the link verbatim
 * (escaped for HTML); it reads only `client_id`, to name a pinned app
 * (ChatGPT, Claude, Grok, Grok Bot or Cursor) in the heading from a fixed list, never echoing it.
 *
 * The page tries to reach the engine first and continues automatically when
 * something answers; otherwise it keeps the link and offers to install
 * Olympus. Browsers that refuse a public page talking to loopback simply show
 * both choices. A relay configured with a demo install also offers reviewers
 * its sign-in (`/connect/demo/authorize`, same query) as a full-width button
 * of its own, so a reviewer cannot miss it.
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

/** The pinned apps' names by client id (src/workers/remote-oauth/pinned-clients.ts); anything else is unnamed. */
export function bridgeAppName(clientId: string | null): string | undefined {
  if (clientId === null) return undefined;
  if (/^https:\/\/chatgpt\.com\/oauth\/(?:[A-Za-z0-9_-]{1,128}\/)?client\.json$/.test(clientId)) return 'ChatGPT';
  if (clientId === 'https://claude.ai/oauth/mcp-oauth-client-metadata') return 'Claude';
  if (clientId === 'https://grok.com/oauth/mcp-client.json') return 'Grok';
  if (clientId === 'https://cursor.com/oauth/mcp-client.json') return 'Grok Bot or Cursor';
  return undefined;
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
  const app = bridgeAppName(url.searchParams.get('client_id'));
  // Olympus runs on a Mac or an Omarchy computer, so the page says computer. ChatGPT's page keeps the words OpenAI's
  // directory reviewers were shown ("Mac"; fixtures/reviewer-path/golden.json) until that review ends.
  const where = app === 'ChatGPT' ? 'Mac' : 'computer';
  const heading = app ? `Approve ${app} on your ${where}` : `Approve on your ${where}`;
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Approve on your ${where} · Olympus</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #fbfbfd; --accent: #0a66d8; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --bg: #111113; --accent: #4c9bff; } }
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 32rem; margin: 12vh auto; padding: 0 16px; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
  p { color: var(--muted); }
  a.button { display: inline-block; margin-top: 1rem; padding: .7rem 1.2rem; border-radius: .6rem; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; }
  #missing { display: none; margin-top: 2rem; }${options.demo ? `
  .demo { margin-top: 2rem; padding: 1rem; border: 2px solid var(--accent); border-radius: .8rem; }
  .demo p { margin: 0 0 .75rem; }
  a.button.demo-button { display: block; margin: 0; text-align: center; font-size: 1.05rem; }` : ''}
</style>
</head>
<body>
<main>
  <h1>${heading}</h1>
  <p>Olympus asks for approval on the ${where} where it runs, so only you can connect it.</p>
  <a class="button" id="continue" href="${escapeHtml(target)}">Continue on this ${where}</a>
  ${options.demo ? `<section class="demo">
    <p>Reviewing Olympus for a directory? Use the demo, with made-up sample data.</p>
    <a class="button demo-button" id="demo" href="${escapeHtml(`/connect/demo/authorize${query}`)}">Reviewing Olympus? Sign in to the demo</a>
  </section>` : ''}
  <section id="missing">
    <h2>Olympus did not answer on this computer</h2>
    <p>Open this page on the ${where} where Olympus runs, or install Olympus first.</p>
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

/**
 * The approval page a hosted agent's OAuth flow opens, often on a phone and
 * always through the public address. It shows who is asking (the client's
 * name, the host that vouches for it, and where approval sends the browser)
 * and asks for a pairing code from `olympus connections pair`.
 *
 * Everything the client supplied is HTML-escaped. The page loads nothing from
 * anywhere: one inline style block allowed by a per-response nonce, no
 * scripts, no images, no frames.
 */
import { randomBytes } from 'node:crypto';

export interface ConsentPageInput {
  requestId: string;
  csrf: string;
  clientName: string;
  /** Host of a metadata-document client_id; undefined for a self-registered client. */
  verifiedHost: string | undefined;
  redirectHost: string;
  redirectOrigin: string;
  loopbackRedirect: boolean;
  error?: string;
  attemptsLeft?: number;
}

function hostnameOf(host: string): string {
  try {
    return new URL(`https://${host}`).hostname;
  } catch {
    return host;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Security headers for every page the approval flow serves. `form-action`
 * names the client's redirect origin too, because browsers apply it to the
 * redirect that follows the form post.
 */
export function consentSecurityHeaders(nonce: string, redirectOrigin?: string): Record<string, string> {
  const formAction = redirectOrigin ? `'self' ${redirectOrigin}` : "'self'";
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `form-action ${formAction}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1a1a1a; --muted: #5c5c5c; --bg: #fafaf8; --card: #ffffff;
  --line: #deded8; --accent: #1f4fd1; --warn-bg: #fff4d6; --warn-fg: #6b4a00; --err: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --fg: #ededea; --muted: #a8a8a2; --bg: #141413; --card: #1d1d1b;
  --line: #34342f; --accent: #8fb0ff; --warn-bg: #3a2f10; --warn-fg: #f3d68a; --err: #ff8a80; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 26rem; margin: 0 auto; padding: 2rem 1rem 3rem; }
h1 { font-size: 1.35rem; line-height: 1.3; margin: 0 0 1rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1rem; margin-bottom: 1rem; }
.name { font-weight: 600; font-size: 1.1rem; overflow-wrap: anywhere; }
.host { font: 600 1.1rem/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: .35rem; overflow-wrap: anywhere; }
.host.unverified { color: var(--warn-fg); font-family: system-ui, sans-serif; }
.meta { color: var(--muted); font-size: .92rem; margin: .25rem 0 0; overflow-wrap: anywhere; }
.warn { background: var(--warn-bg); color: var(--warn-fg); border-radius: 10px; padding: .75rem; font-size: .92rem; margin-bottom: 1rem; }
.err { color: var(--err); font-weight: 600; margin: 0 0 .75rem; }
label { display: block; font-weight: 600; margin-bottom: .35rem; }
input[type=text] { width: 100%; font: 600 1.35rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em;
  padding: .7rem .8rem; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--fg);
  text-transform: uppercase; }
.hint { color: var(--muted); font-size: .88rem; margin: .4rem 0 1.25rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
.actions { display: flex; gap: .75rem; }
button { flex: 1; font: 600 1rem/1 system-ui, sans-serif; padding: .85rem 1rem; border-radius: 10px; cursor: pointer; }
.approve { background: var(--accent); color: #fff; border: 0; }
.deny { background: transparent; color: var(--fg); border: 1px solid var(--line); }
p.small { color: var(--muted); font-size: .85rem; margin-top: 1.25rem; }
`;

export function renderConsentPage(input: ConsentPageInput): { body: string; headers: Record<string, string> } {
  const nonce = randomBytes(16).toString('base64');
  const name = escapeHtml(input.clientName);
  // The host that publishes the client's metadata is the one fact a stranger
  // cannot fake, so it sits right under the name, as large as the name.
  const provenance = input.verifiedHost
    ? `<div class="host">${escapeHtml(input.verifiedHost)}</div><p class="meta">Identity published by this website</p>`
    : '<div class="host unverified">Not verified</div><p class="meta">The app named itself; no website vouches for it</p>';
  const redirectHostname = hostnameOf(input.redirectHost);
  const mismatchWarning = input.verifiedHost && !input.loopbackRedirect && redirectHostname !== input.verifiedHost
    ? `<div class="warn">This app is published by <strong>${escapeHtml(input.verifiedHost)}</strong> but sends you back to <strong>${escapeHtml(input.redirectHost)}</strong>. Approve only if you expected that.</div>`
    : '';
  const loopbackWarning = input.loopbackRedirect
    ? `<div class="warn">This app returns to <strong>${escapeHtml(input.redirectHost)}</strong>, a program on a computer rather than a website. Approve only if you started this from an app on your own computer.</div>`
    : '';
  const error = input.error
    ? `<p class="err" role="alert">${escapeHtml(input.error)}${input.attemptsLeft !== undefined ? ` ${input.attemptsLeft} ${input.attemptsLeft === 1 ? 'try' : 'tries'} left.` : ''}</p>`
    : '';
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect to Olympus</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
<h1>Connect ${name} to Olympus?</h1>
<div class="card">
<div class="name">${name}</div>
${provenance}
<p class="meta">After you approve, you return to <strong>${escapeHtml(input.redirectHost)}</strong></p>
</div>
${mismatchWarning}${loopbackWarning}
<p>${name} will be able to ask Olympus questions under your privacy rules. Private sources stay private, and you can remove it any time with <code>olympus connections revoke</code>.</p>
<form method="post" action="/connect/authorize">
<input type="hidden" name="request_id" value="${escapeHtml(input.requestId)}">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
${error}
<label for="pairing_code">Pairing code</label>
<input type="text" id="pairing_code" name="pairing_code" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" inputmode="text" maxlength="20" placeholder="ABCD-EFGH-JKMN" required>
<p class="hint">Get one by running <code>olympus connections pair</code> on the computer running Olympus, or by asking your OpenClaw agent. Codes last 10 minutes and work once.</p>
<div class="actions">
<button class="approve" type="submit" name="action" value="approve">Approve</button>
<button class="deny" type="submit" name="action" value="deny" formnovalidate>Deny</button>
</div>
</form>
<p class="small">Olympus runs on your own computer. This page was served by it.</p>
</main>
</body>
</html>`;
  return { body, headers: consentSecurityHeaders(nonce, input.redirectOrigin) };
}

/** A terminal page for requests that cannot safely redirect back to the client. */
export function renderConsentErrorPage(message: string): { body: string; headers: Record<string, string> } {
  const nonce = randomBytes(16).toString('base64');
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Olympus could not connect this app</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
<h1>Olympus could not connect this app</h1>
<div class="card"><p>${escapeHtml(message)}</p></div>
<p class="small">Close this page and try adding the connector again.</p>
</main>
</body>
</html>`;
  return { body, headers: consentSecurityHeaders(nonce) };
}

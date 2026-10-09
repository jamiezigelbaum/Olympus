/**
 * /dashboard on the computer (phase 4, owner decision 2026-10-09): a small
 * host page around the one dashboard there is, the panel ChatGPT loads
 * (`ui://olympus/dashboard`, chatgpt/page.ts).
 *
 * The page frames that exact HTML and answers its calls the way ChatGPT's
 * host does (host-bridge.ts):
 * - `ui/initialize` says the theme, full screen, and "this is the computer"
 *   (with the local pages it offers);
 * - `tools/call` posts to POST /dashboard/tools/call under the dashboard
 *   control session and its CSRF token, which runs the same in-process tool
 *   handlers ChatGPT's /mcp reaches;
 * - opening a link opens a tab.
 *
 * Locked (no control session: a read-only dash_ link), the page shows the
 * "Open dashboard controls" banner Setup used to carry, and the panel reads
 * the dashboard through GET /dashboard?panel-read with that same token; every
 * control says to open the controls first.
 */
import {
  COMPUTER_HOST_TOOL_NAMES,
  DASHBOARD_TOOL_NAME,
  OLYMPUS_HOST_CONTEXT_KEY,
} from '../chatgpt/dashboard-contract.ts';
import {
  CHATGPT_DASHBOARD_DARK,
  CHATGPT_DASHBOARD_LIGHT,
} from './chatgpt/page.ts';
import { dashboardHostBridge, type DashboardHostBridgeConfig } from './host-bridge.ts';
import {
  DASHBOARD_HOST_GATE_COPY,
  DASHBOARD_WORKER_TOKEN_AGENT_PROMPT,
} from './vocabulary.ts';
import { DASHBOARD_OPEN_FRAGMENT_KEY, OPEN_PAGE_BASE_URL, allOpenTargets, openTargetPath, openTargetToken } from '../../core/open-targets.ts';

export const DASHBOARD_HTML_PATH = '/dashboard';
/** POST: one panel tool call under the control session (http.ts isDashboardControlRoute). */
export const DASHBOARD_TOOLS_CALL_PATH = '/dashboard/tools/call';
/** GET /dashboard?panel-read: the dashboard tool's result for a locked (dash_ token) reader. */
export const DASHBOARD_PANEL_READ_QUERY_PARAM = 'panel-read';

/** The local pages the computer offers, each a query on /dashboard (the dash_ token is allowlisted by pathname). */
export const DASHBOARD_LOCAL_PAGES = {
  keys: 'keys',
  agents: 'agents',
  outsideHelp: 'outside-help',
  connector: 'connector',
} as const;

export type DashboardLocalPage = keyof typeof DASHBOARD_LOCAL_PAGES;

/** `/dashboard?keys`, keeping a dash_ reader's token so the page does not 401. */
export function dashboardLocalPageHref(page: DashboardLocalPage, token?: string): string {
  const query = token ? `${DASHBOARD_LOCAL_PAGES[page]}&token=${encodeURIComponent(token)}` : DASHBOARD_LOCAL_PAGES[page];
  return `${DASHBOARD_HTML_PATH}?${query}`;
}

/** The panel's home, keeping a dash_ reader's token. */
export function dashboardHomeHref(token?: string): string {
  return token ? `${DASHBOARD_HTML_PATH}?token=${encodeURIComponent(token)}` : DASHBOARD_HTML_PATH;
}

/**
 * What an olympusplugin.ai/open/<path>/ link means on the computer: Connect
 * for X, Readwise, Telegram or WhatsApp opens that source's setup sheet on
 * Keys; a models fix opens Models there; the dashboard is the dashboard. The
 * ChatGPT-connection fixes (connect, reconnect) keep their help page.
 */
export function computerOpenTargets(origin: string, token?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const target of allOpenTargets()) {
    const path = openTargetPath(target);
    if (target.kind === 'dashboard') out[path] = `${origin}${dashboardHomeHref(token)}`;
    else if (target.kind === 'connect' || (target.kind === 'fix' && (target.section === 'models' || target.section === 'answers' || target.section === 'search'))) {
      out[path] = `${origin}${dashboardLocalPageHref('keys', token)}#${DASHBOARD_OPEN_FRAGMENT_KEY}=${openTargetToken(target)}`;
    }
  }
  return out;
}

export interface ComputerHostPageInput {
  /** The panel HTML, exactly as ChatGPT loads it (dashboard-resource.ts dashboardResourceHtml). */
  panelHtml: string;
  /** This browser's request origin, e.g. http://127.0.0.1:8787. */
  origin: string;
  /** The control session's CSRF token; absent means the controls are locked. */
  csrfToken?: string;
  /** A dash_ reader's token, carried on every local link and the locked read. */
  readToken?: string;
}

/** `"` and `&` only: the srcdoc attribute is double-quoted. */
function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function text(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

const HOST_CSS = `
:root{--bg:${CHATGPT_DASHBOARD_LIGHT.bg};--text:${CHATGPT_DASHBOARD_LIGHT.text};--muted:${CHATGPT_DASHBOARD_LIGHT.muted};--line:${CHATGPT_DASHBOARD_LIGHT.line};--warn-bg:${CHATGPT_DASHBOARD_LIGHT.warnBg};--warn:${CHATGPT_DASHBOARD_LIGHT.warn};--surface:${CHATGPT_DASHBOARD_LIGHT.surface};--focus:${CHATGPT_DASHBOARD_LIGHT.focus};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:${CHATGPT_DASHBOARD_DARK.bg};--text:${CHATGPT_DASHBOARD_DARK.text};--muted:${CHATGPT_DASHBOARD_DARK.muted};--line:${CHATGPT_DASHBOARD_DARK.line};--warn-bg:${CHATGPT_DASHBOARD_DARK.warnBg};--warn:${CHATGPT_DASHBOARD_DARK.warn};--surface:${CHATGPT_DASHBOARD_DARK.surface};--focus:${CHATGPT_DASHBOARD_DARK.focus}}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:0.9375rem;line-height:1.45}
.panel{flex:1 1 auto;width:100%;min-height:0;border:0;display:block;background:var(--bg)}
.gate{flex:none;max-width:48rem;width:calc(100% - 2rem);margin:1rem auto 0;padding:0.75rem 1rem;background:var(--warn-bg);border-left:4px solid var(--warn);border-radius:8px}
.gate p{margin:0}
.gate .title{font-weight:600}
.gate .line{color:var(--muted);font-size:0.875rem}
.gate .row{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem 1rem}
.gate .grow{flex:1 1 14rem;min-width:0}
.gate .how{margin-top:0.75rem}
.gate .how[hidden]{display:none}
.prompt{white-space:pre-wrap;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:0.5rem 0.75rem;margin:0.5rem 0;font-size:0.875rem;user-select:all}
.btn{font:inherit;font-size:0.875rem;min-height:2.25rem;padding:0.375rem 0.875rem;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:var(--text);cursor:pointer}
.btn:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
details{margin-top:0.5rem}
summary{cursor:pointer;color:var(--muted);font-size:0.875rem}
form{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;margin-top:0.5rem}
input{font:inherit;font-size:0.875rem;min-height:2.25rem;padding:0.375rem 0.75rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);min-width:12rem}
.status{color:var(--muted);font-size:0.875rem}
`;

function lockedGate(): string {
  const C = DASHBOARD_HOST_GATE_COPY;
  return `<section class="gate" data-dashboard-control-gate data-state="locked" aria-label="${attribute(C.title)}">`
    + `<div class="row"><div class="grow"><p class="title">${text(C.title)}</p><p class="line">${text(C.line)}</p></div>`
    + `<button class="btn" type="button" data-gate-toggle aria-controls="gate-how" aria-expanded="false">${text(C.button)}</button></div>`
    + `<div class="how" id="gate-how" hidden><p class="line">${text(C.how)}</p>`
    + `<p class="prompt" id="gate-prompt">${text(DASHBOARD_WORKER_TOKEN_AGENT_PROMPT)}</p>`
    + `<button class="btn" type="button" data-gate-copy>${text(C.copy)}</button> <span class="status" data-gate-copy-status aria-live="polite"></span>`
    + `<details><summary>${text(C.advanced)}</summary>`
    + `<form data-gate-unlock><input type="password" required autocomplete="off" placeholder="${attribute(C.tokenField)}" aria-label="${attribute(C.tokenField)}">`
    + `<button class="btn" type="submit">${text(C.unlock)}</button><span class="status" data-gate-status role="status"></span></form>`
    + `</details></div></section>`;
}

/**
 * The page's own program: the bridge, plus the locked banner's three
 * controls (show the prompt, copy it, unlock with a worker token).
 */
function hostProgram(input: {
  bridge: DashboardHostBridgeConfig;
  csrfToken: string;
  readUrl: string;
  toolsCallPath: string;
  words: typeof DASHBOARD_HOST_GATE_COPY;
}, bridge: typeof dashboardHostBridge): void {
  const frame = document.getElementById('olympus-panel') as HTMLIFrameElement | null;
  if (!frame) return;
  function failed(): never {
    throw new Error('tool call failed');
  }
  function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!input.csrfToken) {
      return fetch(input.readUrl, { cache: 'no-store', credentials: 'same-origin' })
        .then((response) => (response.ok ? response.json() : failed()));
    }
    return fetch(input.toolsCallPath, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'X-Olympus-CSRF': input.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
    }).then((response) => {
      // The session expired or was locked elsewhere: the page itself says so.
      if (response.status === 401 || response.status === 403) {
        window.location.reload();
        return failed();
      }
      return response.ok ? response.json() : failed();
    });
  }
  bridge(input.bridge, {
    frame,
    callTool,
    openUrl(url: string) {
      window.open(url, '_blank', 'noopener');
    },
  });

  const toggle = document.querySelector<HTMLButtonElement>('[data-gate-toggle]');
  const how = document.getElementById('gate-how');
  if (toggle && how) {
    toggle.addEventListener('click', () => {
      const open = how.hidden;
      how.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  const copy = document.querySelector<HTMLButtonElement>('[data-gate-copy]');
  const copyStatus = document.querySelector<HTMLElement>('[data-gate-copy-status]');
  const prompt = document.getElementById('gate-prompt');
  if (copy && prompt) {
    copy.addEventListener('click', () => {
      const done = (words: string) => { if (copyStatus) copyStatus.textContent = words; };
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(prompt.textContent || '').then(() => done(input.words.copied), () => done(input.words.copyFailed));
      } else {
        done(input.words.copyFailed);
      }
    });
  }
  const form = document.querySelector<HTMLFormElement>('[data-gate-unlock]');
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const field = form.querySelector('input');
      const status = form.querySelector<HTMLElement>('[data-gate-status]');
      const say = (words: string) => { if (status) status.textContent = words; };
      const pasted = field ? field.value.trim() : '';
      if (field) field.value = '';
      if (!pasted) {
        say(input.words.pasteToken);
        return;
      }
      if (pasted.indexOf('dash_') === 0) {
        say(input.words.readToken);
        return;
      }
      say(input.words.unlocking);
      fetch('/dashboard/control/session', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Authorization: 'Bearer ' + pasted },
      }).then((response) => {
        if (!response.ok) {
          say(input.words.refused);
          return;
        }
        // The session cookie is set: the plain dashboard opens unlocked.
        window.location.assign('/dashboard');
      }, () => say(input.words.refused));
    });
  }
}

export function renderComputerHostPage(input: ComputerHostPageInput): string {
  const token = input.readToken;
  const locked = input.csrfToken === undefined;
  const links: Record<string, string> = {};
  for (const page of Object.keys(DASHBOARD_LOCAL_PAGES) as DashboardLocalPage[]) {
    links[page] = `${input.origin}${dashboardLocalPageHref(page, token)}`;
  }
  const bridge: DashboardHostBridgeConfig = {
    contextKey: OLYMPUS_HOST_CONTEXT_KEY,
    kind: 'computer',
    readOnly: locked,
    links,
    tools: COMPUTER_HOST_TOOL_NAMES,
    readTool: DASHBOARD_TOOL_NAME,
    openTargets: computerOpenTargets(input.origin, token),
    openBase: OPEN_PAGE_BASE_URL,
  };
  const readUrl = `${DASHBOARD_HTML_PATH}?${DASHBOARD_PANEL_READ_QUERY_PARAM}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  const program = `(${hostProgram.toString()})(${scriptJson({
    bridge,
    csrfToken: input.csrfToken ?? '',
    readUrl,
    toolsCallPath: DASHBOARD_TOOLS_CALL_PATH,
    words: DASHBOARD_HOST_GATE_COPY,
  })}, ${dashboardHostBridge.toString()});`.replaceAll('</script', '<\\/script');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Olympus</title>',
    `<style>${HOST_CSS}</style>`,
    '</head>',
    `<body data-olympus-host="computer" data-locked="${locked ? 'true' : 'false'}">`,
    locked ? lockedGate() : '',
    // allow-scripts only: an opaque origin, so the panel can reach nothing of
    // this page's (cookies, storage, DOM) and talks only through postMessage.
    `<iframe class="panel" id="olympus-panel" title="Olympus dashboard" sandbox="allow-scripts" srcdoc="${attribute(input.panelHtml)}"></iframe>`,
    `<script>${program}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The host page's own policy. The framed panel (srcdoc) inherits it, so it
 * also bounds the panel: inline script and style only, data: images, no
 * network but this origin, framed by nothing.
 */
export const COMPUTER_HOST_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "connect-src 'self'",
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

import { dashboardComputerIdentity } from '../../core/computer-identity.ts';
import { installerForPlatform, type UpdateAvailable } from '../../core/update-check.ts';
import type { SelfUpdateStatus } from '../../core/self-update.ts';
import { renderUpdateNotice, renderUpdateNoticeScript, UPDATE_NOTICE_CSS } from './update-now.ts';
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
  ARCHIVE_UPLOAD_START_TOOL_NAME,
  COMPUTER_HOST_TOOL_NAMES,
  COMPUTER_META_KEY,
  COMPUTER_LOCAL_SESSION_TOOL_NAMES,
  DASHBOARD_TOOL_NAME,
  OLYMPUS_HOST_CONTEXT_KEY,
} from '../chatgpt/dashboard-contract.ts';
import { DASHBOARD_OUTSIDE_HELP_PATHS } from './outside-help.ts';
import {
  CHATGPT_DASHBOARD_DARK,
  CHATGPT_DASHBOARD_LIGHT,
} from './chatgpt/page.ts';
import { dashboardHostBridge, type DashboardHostBridgeConfig } from './host-bridge.ts';
import { mountDashboardController } from '../../control-ui/browser-controller.ts';
import { renderMessagingCard } from './messaging.ts';
import { DASHBOARD_THEME_CSS } from './theme.ts';
import { dashboardTopNav, TOP_NAV_CSS } from './top-nav.ts';
import { ARCHIVE_UPLOAD_CHUNK_BYTES } from '../archive-import/staging.ts';
import {
  DASHBOARD_HOST_GATE_COPY,
  DASHBOARD_SETUP_AGENT_COPY,
  DASHBOARD_UPDATE_COPY,
  DASHBOARD_WORKER_TOKEN_AGENT_PROMPT,
} from './vocabulary.ts';
import {
  DASHBOARD_IMPORT_LANDING_PREFIX, DASHBOARD_SOURCE_LANDING_PREFIX, DASHBOARD_ALL_SOURCES_LANDING, DASHBOARD_ALL_SOURCES_ID,
  DASHBOARD_OPEN_FRAGMENT_KEY,
  OPEN_PAGE_BASE_URL,
  allOpenTargets,
  isConnectOpenTarget,
  isKeysOpenTarget,
  isPanelOpenTarget,
  olympusOpenUrl,
  openTargetPath,
  openTargetToken,
  panelOpenTargetSources,
} from '../../core/open-targets.ts';

export const DASHBOARD_HTML_PATH = '/dashboard';
/** POST: one panel tool call under the control session (http.ts isDashboardControlRoute). */
export const DASHBOARD_TOOLS_CALL_PATH = '/dashboard/tools/call';
/** GET /dashboard?panel-read: the dashboard tool's result for a locked (dash_ token) reader. */
export const DASHBOARD_PANEL_READ_QUERY_PARAM = 'panel-read';
/** POST: one file of an archive upload, its bytes the body (archive-import/staging.ts); same session and CSRF as a tool call. */
export const DASHBOARD_ARCHIVE_UPLOAD_FILE_PATH = '/dashboard/archive-import/upload-file';

/** The local pages the computer offers, each a query on /dashboard (the dash_ token is allowlisted by pathname). */
export const DASHBOARD_LOCAL_PAGES = {
  keys: 'keys',
  connect: 'connect',
  agents: 'agents',
  privateAnswers: 'private-answers',
  appsReceived: 'apps-received',
  connector: 'connector',
  help: 'help',
  settings: 'settings',
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
 * for X, Readwise, Telegram, WhatsApp or Evernote opens that source's setup sheet on
 * Connect a source; a models fix opens Privacy settings (?keys); See why on a source (unreadable/<id>)
 * opens this dashboard landed on it; the dashboard is the dashboard. The
 * ChatGPT-connection fixes (connect, reconnect) keep their help page.
 */
export function computerOpenTargets(origin: string, token?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const target of allOpenTargets()) {
    const path = openTargetPath(target);
    if (target.kind === 'dashboard') out[path] = `${origin}${dashboardHomeHref(token)}`;
    else if (target.kind === 'private_answers') out[path] = `${origin}${dashboardLocalPageHref('privateAnswers', token)}${target.answerId ? '#' + target.answerId : ''}`;
    else if (isConnectOpenTarget(target)) {
      out[path] = `${origin}${dashboardLocalPageHref('connect', token)}#${DASHBOARD_OPEN_FRAGMENT_KEY}=${openTargetToken(target)}`;
    } else if (isKeysOpenTarget(target)) {
      out[path] = `${origin}${dashboardLocalPageHref('keys', token)}#${DASHBOARD_OPEN_FRAGMENT_KEY}=${openTargetToken(target)}`;
    } else if (isPanelOpenTarget(target)) {
      out[path] = `${origin}${dashboardHomeHref(token)}#${DASHBOARD_OPEN_FRAGMENT_KEY}=${openTargetToken(target)}`;
    }
  }
  return out;
}

export interface ComputerHostPageInput {
  computerIdentity?: string;
  updateAvailable?: UpdateAvailable | undefined;
  /** Update now is offered (the standalone engine; core/self-update.ts), and its current record. */
  selfUpdate?: boolean;
  updateStatus?: SelfUpdateStatus | undefined;
  /** The running worker platform; unsupported installers never render or poll. */
  platform?: string;
  /** The panel HTML, exactly as ChatGPT loads it (dashboard-resource.ts dashboardResourceHtml). */
  panelHtml: string;
  /** This browser's request origin, e.g. http://127.0.0.1:8787. */
  origin: string;
  /** The control session's CSRF token; absent means the controls are locked. */
  csrfToken?: string;
  /**
   * The control session is local-grade (opened from this computer's own
   * browser, not by the bearer or its launch link). Without it the page
   * opens one before the first tool only such a session may use.
   */
  localSession?: boolean;
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
:root{--bg:${CHATGPT_DASHBOARD_LIGHT.bg};--text:${CHATGPT_DASHBOARD_LIGHT.text};--muted:${CHATGPT_DASHBOARD_LIGHT.muted};--line:${CHATGPT_DASHBOARD_LIGHT.line};--warn-bg:${CHATGPT_DASHBOARD_LIGHT.warnBg};--warn:${CHATGPT_DASHBOARD_LIGHT.warn};--surface:${CHATGPT_DASHBOARD_LIGHT.surface};--focus:${CHATGPT_DASHBOARD_LIGHT.focus};--accent:${CHATGPT_DASHBOARD_LIGHT.accent};--on-accent:${CHATGPT_DASHBOARD_LIGHT.onAccent};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:${CHATGPT_DASHBOARD_DARK.bg};--text:${CHATGPT_DASHBOARD_DARK.text};--muted:${CHATGPT_DASHBOARD_DARK.muted};--line:${CHATGPT_DASHBOARD_DARK.line};--warn-bg:${CHATGPT_DASHBOARD_DARK.warnBg};--warn:${CHATGPT_DASHBOARD_DARK.warn};--surface:${CHATGPT_DASHBOARD_DARK.surface};--focus:${CHATGPT_DASHBOARD_DARK.focus};--accent:${CHATGPT_DASHBOARD_DARK.accent};--on-accent:${CHATGPT_DASHBOARD_DARK.onAccent}}}
*{box-sizing:border-box}
html,body{height:100%}
body{overflow-wrap:anywhere;margin:0;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", Ubuntu, Cantarell, "Liberation Sans", "DejaVu Sans", "Helvetica Neue", Arial, system-ui, sans-serif;font-size:0.9375rem;line-height:1.45}
.update{flex:none;max-width:48rem;width:calc(100% - 2rem);margin:0 auto}
.panel{flex:1 1 auto;width:100%;min-height:0;border:0;display:block;background:var(--bg)}
main{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.computer-identity{flex:none;max-width:48rem;width:calc(100% - 2rem);margin:1rem auto 0;color:var(--muted);font-size:0.875rem}
.gate[hidden]{display:none}
.gate{flex:none;max-width:48rem;width:calc(100% - 2rem);margin:1rem auto 0;padding:0.75rem 1rem;background:var(--warn-bg);border-left:4px solid var(--warn);border-radius:8px}
.gate p{margin:0}
.gate .title{font-weight:600}
.gate .line{color:var(--muted);font-size:0.875rem}
.gate .line .btn{margin-right:0.25rem}
.gate code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.8125rem;color:var(--text);white-space:pre-wrap}
a.btn{display:inline-flex;align-items:center;text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
.btn.plain{background:transparent}
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
input{font:inherit;font-size:0.875rem;min-height:2.25rem;padding:0.375rem 0.75rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);min-width:0;max-width:100%}
.status{color:var(--muted);font-size:0.875rem}
.pairing{width:min(40rem,calc(100% - 2rem));max-height:calc(100% - 2rem);padding:0;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--text)}
.pairing::backdrop{background:rgba(0,0,0,0.45)}
.pairing .bar{display:flex;justify-content:flex-end;padding:0.5rem 0.75rem 0}
.setup-agent{width:min(46rem,calc(100% - 2rem));max-height:calc(100% - 2rem);padding:1.25rem 1.5rem;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--text);box-shadow:0 8px 24px rgba(0,0,0,0.12)}
.setup-agent::backdrop{background:rgba(0,0,0,0.35)}
.setup-agent .head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}
.setup-agent h2{margin:0;font-size:1.0625rem;font-weight:600}
.setup-agent .x{border:0;background:transparent;color:var(--muted);font:inherit;font-size:1.25rem;line-height:1;min-width:2.25rem;min-height:2.25rem;cursor:pointer;border-radius:999px}
.setup-agent .x:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.setup-agent .intro{margin:0.375rem 0 0.75rem;color:var(--muted);font-size:0.9375rem}
.setup-agent pre{margin:0 0 0.75rem;padding:0.875rem 1rem;background:var(--surface);border:1px solid var(--line);border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.8125rem;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;user-select:all}
.setup-agent .actions{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem}
`;

/**
 * The locked banner. An unlocked page carries it hidden, so a session that
 * expires while the page is open locks the page in place (hostProgram).
 */
function lockedGate(hidden: boolean): string {
  const C = DASHBOARD_HOST_GATE_COPY;
  return `<section class="gate" data-dashboard-control-gate data-state="locked" aria-label="${attribute(C.title)}"${hidden ? ' hidden' : ''}>`
    + `<div class="row"><div class="grow"><p class="title">${text(C.title)}</p>`
    + `<p class="line"><a class="btn primary" href="${attribute(olympusOpenUrl({ kind: 'dashboard' }))}" data-gate-open>${text(C.open)}</a> `
    + `${text(C.fallbackBefore)}<code>${text(C.fallbackCommand)}</code>${text(C.fallbackAfter)}</p></div>`
    + `<button class="btn plain" type="button" data-gate-toggle aria-controls="gate-how" aria-expanded="false">${text(C.button)}</button></div>`
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
  /** The session is already local-grade. */
  localSession: boolean;
  /** Tools only a local-grade session may use, and the local unlock that opens one. */
  localTools: readonly string[];
  localSessionPath: string;
  readUrl: string;
  /** /dashboard, carrying a dash_ reader's token: the locked page with its data. */
  lockedUrl: string;
  /** `#olympus-open=`: where an open link asked the panel to land. */
  openFragment: string;
  /** The panel targets' tokens and the source each lands on (core/open-targets.ts). */
  landings: Record<string, string>;
  /** `import.`: a Keys link's landing on one card's Import an archive; the panel checks the card. */
  importLanding: string;
  /** `source.`: the Sources tab's Details on one row; the panel shows that source's row on Home. */
  sourceLanding: string;
  /** `sources`: the Sources tab's Archives and details; the panel shows every source's row. */
  allSourcesLanding: { token: string; id: string };
  hasReadToken: boolean;
  toolsCallPath: string;
  /** Where one file of an archive upload goes, and the local tool whose unlock opens the session it needs. */
  uploadPath: string;
  uploadTool: string;
  /** How large a piece of a file goes in one request (archive-import/staging.ts). */
  uploadChunkBytes: number;
  words: typeof DASHBOARD_HOST_GATE_COPY;
  updateWords: { notice: string };
  updateSupported: boolean;
  /**
   * "Set up with my agent" (#1077): the dashboard read's computer-meta key
   * the checklist rides under, and the fragment that opens the brief. The
   * brief opens only once a read carried the checklist.
   */
  setupAgent: { metaKey: string; fragment: string; copied: string; copyFailed: string };
  /**
   * Pairing WhatsApp or Telegram in place: Connect on the card opens these
   * controls over the dashboard instead of the Keys page. `urls` are the
   * connect links that mean it; `cards` each source's card markup.
   */
  pairing: { urls: Record<string, 'telegram' | 'whatsapp'>; cards: Record<string, string>; pairedCards: Record<string, string>; css: string; messagingPath: string };
}, bridge: typeof dashboardHostBridge, mount: typeof mountDashboardController): void {
  const frame = document.getElementById('olympus-panel') as HTMLIFrameElement | null;
  if (!frame) return;
  function failed(): never {
    throw new Error('tool call failed');
  }
  // The last dashboard read that answered: what a page whose session expired,
  // with no reader's token to read again, keeps showing (locked).
  let lastRead: unknown;
  let expired = false;
  let handle: { lock(): void } | undefined;
  function remember(name: string, result: unknown): unknown {
    if (name === input.bridge.readTool) lastRead = result;
    return noteSetup(name, result);
  }
  // "Set up with my agent": ready once a dashboard read carried the setup
  // checklist in the computer meta; the fragment or an opener shows it.
  let setupReady = false;
  const setupDialog = document.querySelector<HTMLDialogElement>('[data-setup-agent-dialog]');
  function openSetupAgent(): void {
    if (!setupReady || !setupDialog || setupDialog.open) return;
    if (typeof setupDialog.showModal === 'function') setupDialog.showModal();
    else setupDialog.setAttribute('open', '');
  }
  function noteSetup(name: string, result: unknown): unknown {
    if (name !== input.bridge.readTool || !result || typeof result !== 'object') return result;
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    const computer = meta && typeof meta === 'object' ? meta[input.setupAgent.metaKey] as { setup?: { kind?: unknown } } | undefined : undefined;
    const ready = !!(computer && computer.setup && computer.setup.kind === 'olympus_setup_status');
    if (ready && !setupReady) {
      setupReady = true;
      document.querySelectorAll<HTMLElement>('[data-setup-agent-open]').forEach((opener) => { opener.hidden = false; });
      if (window.location.hash === input.setupAgent.fragment) openSetupAgent();
    }
    return result;
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('hashchange', () => { if (window.location.hash === input.setupAgent.fragment) openSetupAgent(); });
  }
  if (typeof document.addEventListener === 'function') document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (target && target.closest && target.closest('[data-setup-agent-open]')) openSetupAgent();
    if (target && target.closest && target.closest('[data-setup-agent-close]') && setupDialog) setupDialog.close();
  });
  const setupCopy = document.querySelector<HTMLButtonElement>('[data-setup-agent-copy]');
  const setupBrief = document.getElementById('setup-agent-brief');
  const setupStatus = document.querySelector<HTMLElement>('[data-setup-agent-copy-status]');
  if (setupCopy && setupBrief) {
    setupCopy.addEventListener('click', () => {
      const done = (words: string) => { if (setupStatus) setupStatus.textContent = words; };
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(setupBrief.textContent || '').then(() => done(input.setupAgent.copied), () => done(input.setupAgent.copyFailed));
      } else done(input.setupAgent.copyFailed);
    });
  }
  /** The session expired or was locked elsewhere: lock this page, never a raw 401. */
  function lockPage(): void {
    if (input.hasReadToken) {
      // The reader's token still reads: the locked page, with fresh data.
      window.location.assign(input.lockedUrl);
      return;
    }
    if (expired) return;
    expired = true;
    const gate = document.querySelector<HTMLElement>('[data-dashboard-control-gate]');
    if (gate) gate.hidden = false;
    document.body.setAttribute('data-locked', 'true');
    if (handle) handle.lock();
  }
  let csrfToken = input.csrfToken;
  let localSession = input.localSession;
  /**
   * A tool only this computer's own session may use (approving an import):
   * open that session first, the way the local pages' Unlock does. The
   * worker grants it to a loopback browser presenting no bearer, so an
   * agent's bearer never reaches it, and with this page's CSRF token, so the
   * session cookie alone never does (#1187); refused, the tool says so itself.
   */
  function localUnlock(name: string): Promise<void> {
    if (localSession || input.localTools.indexOf(name) < 0) return Promise.resolve();
    return fetch(input.localSessionPath, { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'X-Olympus-CSRF': csrfToken } })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: { csrf_token?: unknown } | undefined) => {
        if (body && typeof body.csrf_token === 'string' && body.csrf_token) {
          csrfToken = body.csrf_token;
          localSession = true;
        }
      }, () => undefined);
  }
  function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (expired) return lastRead !== undefined && name === input.bridge.readTool ? Promise.resolve(lastRead) : Promise.reject(new Error('locked'));
    if (!csrfToken) {
      return fetch(input.readUrl, { cache: 'no-store', credentials: 'same-origin' })
        .then((response) => (response.ok ? response.json() : failed()))
        .then((result) => noteSetup(name, result));
    }
    return localUnlock(name).then(() => fetch(input.toolsCallPath, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'X-Olympus-CSRF': csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
    })).then((response) => {
      if (response.status === 401 || response.status === 403) {
        lockPage();
        if (lastRead !== undefined && name === input.bridge.readTool) return lastRead;
        return failed();
      }
      return response.ok ? response.json().then((result) => remember(name, result)) : failed();
    });
  }
  // The files of an archive upload, sent from here: the panel is sandboxed and cannot reach Olympus. Each file is
  // sent as pieces (one request each, the piece read from disk as it is sent), so it never sits in memory.
  const sending: Record<string, XMLHttpRequest[]> = {};
  const stopped: Record<string, boolean> = {};
  function abortUpload(uploadId: string): void {
    stopped[uploadId] = true;
    // A copy: each abort takes its request out of the list.
    for (const request of (sending[uploadId] || []).slice()) request.abort();
    delete sending[uploadId];
  }
  function uploadFile(
    upload: { uploadId: string; path: string; modified: number; file: Blob },
    progress: (loaded: number) => void,
  ): Promise<{ ok: boolean; message?: string; cancelled?: boolean }> {
    if (expired || stopped[upload.uploadId]) return Promise.resolve({ ok: false, cancelled: !!stopped[upload.uploadId] });
    return localUnlock(input.uploadTool).then(() => new Promise<{ ok: boolean; message?: string; cancelled?: boolean }>((resolve) => {
      if (!csrfToken || stopped[upload.uploadId]) {
        resolve({ ok: false, cancelled: !!stopped[upload.uploadId] });
        return;
      }
      const size = upload.file.size;
      const piece = input.uploadChunkBytes > 0 ? input.uploadChunkBytes : size || 1;
      // A file goes in pieces, one request at a time, each written before the next is sent: the engine never holds more
      // than a piece, however large the file is or slowly the disk takes it.
      function send(offset: number): void {
        if (stopped[upload.uploadId]) {
          resolve({ ok: false, cancelled: true });
          return;
        }
        const end = Math.min(size, offset + piece);
        const last = end >= size;
        const request = new XMLHttpRequest();
        const list = sending[upload.uploadId] || (sending[upload.uploadId] = []);
        list.push(request);
        const forget = (): void => {
          const at = list.indexOf(request);
          if (at >= 0) list.splice(at, 1);
        };
        request.open('POST', input.uploadPath);
        request.setRequestHeader('X-Olympus-CSRF', csrfToken);
        request.setRequestHeader('X-Olympus-Upload-Id', upload.uploadId);
        request.setRequestHeader('X-Olympus-Upload-Path', encodeURIComponent(upload.path));
        if (upload.modified > 0) request.setRequestHeader('X-Olympus-Upload-Modified', String(Math.round(upload.modified)));
        request.setRequestHeader('X-Olympus-Upload-Offset', String(offset));
        request.setRequestHeader('X-Olympus-Upload-Final', last ? '1' : '0');
        request.setRequestHeader('Content-Type', 'application/octet-stream');
        request.upload.onprogress = (event: ProgressEvent) => progress(offset + event.loaded);
        request.onload = () => {
          forget();
          if (request.status === 401 || request.status === 403) {
            lockPage();
            resolve({ ok: false });
            return;
          }
          if (request.status >= 200 && request.status < 300) {
            if (last) resolve({ ok: true });
            else send(end);
            return;
          }
          let message: string | undefined;
          try {
            const body = JSON.parse(request.responseText) as { error?: { message?: unknown } };
            if (body && body.error && typeof body.error.message === 'string') message = body.error.message;
          } catch {
            message = undefined;
          }
          resolve(message ? { ok: false, message } : { ok: false });
        };
        request.onerror = () => {
          forget();
          resolve({ ok: false });
        };
        request.onabort = () => {
          forget();
          resolve({ ok: false, cancelled: true });
        };
        // The whole file when one piece holds it; otherwise this piece of it, read from disk as it is sent.
        request.send(offset === 0 && last ? upload.file : upload.file.slice(offset, end));
      }
      send(0);
    }));
  }
  // An open link's place in the panel (See why on one source): read against
  // the closed list, then cleared, so a reload does not land again.
  let landing: { sourceId: string; import?: true } | undefined;
  if (window.location.hash.indexOf(input.openFragment) === 0) {
    const wanted = window.location.hash.slice(input.openFragment.length);
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      // An unchangeable history keeps the fragment; it is only a place to look.
    }
    if (Object.prototype.hasOwnProperty.call(input.landings, wanted)) landing = { sourceId: input.landings[wanted]! };
    const card = wanted.indexOf(input.importLanding) === 0 ? wanted.slice(input.importLanding.length) : '';
    if (/^[a-z0-9_.]{1,64}$/.test(card)) landing = { sourceId: card, import: true };
    const row = wanted.indexOf(input.sourceLanding) === 0 ? wanted.slice(input.sourceLanding.length) : '';
    if (/^[a-z0-9_.]{1,64}$/.test(row)) landing = { sourceId: row };
    if (wanted === input.allSourcesLanding.token) landing = { sourceId: input.allSourcesLanding.id };
  }
  /** Opens a local-grade session (the messaging routes need one); true once it is. */
  function openLocalSession(): Promise<boolean> {
    return fetch(input.localSessionPath, { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'X-Olympus-CSRF': csrfToken } })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: { csrf_token?: unknown } | undefined) => {
        if (body && typeof body.csrf_token === 'string' && body.csrf_token) {
          csrfToken = body.csrf_token;
          localSession = true;
          return true;
        }
        return false;
      }, () => false);
  }
  // The pairing controls run here, outside the sandboxed panel, so the QR
  // and login codes never enter the panel (the same panel ChatGPT loads).
  // They sit in a shadow root with the local pages' own stylesheet.
  let closePairing: (() => void) | undefined;
  const pairingDialog = document.querySelector<HTMLDialogElement>('[data-pairing-dialog]');
  pairingDialog?.querySelector('[data-pairing-close]')?.addEventListener('click', () => pairingDialog.close());
  pairingDialog?.addEventListener('close', () => {
    const close = closePairing;
    closePairing = undefined;
    if (close) close();
  });
  function openPairing(source: 'telegram' | 'whatsapp'): boolean {
    const markup = input.pairing.cards[source];
    const place = pairingDialog?.querySelector<HTMLElement>('[data-pairing-root]');
    if (!pairingDialog || !place || !markup || !csrfToken || expired || typeof pairingDialog.showModal !== 'function') return false;
    if (closePairing) closePairing();
    const shadow = place.shadowRoot || place.attachShadow({ mode: 'open' });
    shadow.innerHTML = '';
    const abort = new AbortController();
    let controller: { dispose(): void } | undefined;
    closePairing = () => {
      abort.abort();
      if (controller) controller.dispose();
      // Erases the QR and any typed value with the markup.
      shadow.innerHTML = '';
    };
    pairingDialog.showModal();
    const start = (paired: boolean) => {
      if (abort.signal.aborted) return;
      // A paired account gets its own card (Pair again beside Check connection), as on Keys.
      const card = paired ? input.pairing.pairedCards[source] : markup;
      shadow.innerHTML = '<style>' + input.pairing.css + '</style><div class="page">' + card + '</div>';
      controller = mount({
        root: shadow,
        canWrite: true,
        signal: abort.signal,
        returnUrl: window.location.href,
        navigate: (href: string) => window.location.assign(href),
        refresh: () => Promise.resolve(undefined),
        transport: {
          openLocalControls: openLocalSession,
          control: () => Promise.resolve({ status: 400, body: {} }),
          messaging: (operation: string, params: Record<string, unknown>) => fetch(input.pairing.messagingPath + operation, {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'X-Olympus-CSRF': csrfToken, 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
          }).then((response) => response.json().then((body: Record<string, unknown>) => body, () => ({})).then((body) => ({ status: response.status, body }))),
        },
      } as Parameters<typeof mount>[0]);
    };
    // Connect means pair: an account not paired yet goes straight to the QR
    // (WhatsApp) or to the walkthrough (Telegram). A paired one shows its
    // card with Pair again and Choose chats, and nothing starts by itself.
    const begin = () => {
      void fetch(input.pairing.messagingPath + 'status', {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'X-Olympus-CSRF': csrfToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      }).then((response) => (response.ok ? response.json() : undefined), () => undefined).then((body: { state?: unknown } | undefined) => {
        const state = body && typeof body.state === 'string' ? body.state : '';
        start(state === 'paired' || state === 'complete' || state === 'completed');
        if (abort.signal.aborted || (state !== 'idle' && state !== 'not_paired')) return;
        if (source === 'telegram') {
          shadow.querySelector<HTMLButtonElement>('[data-sheet-toggle="#telegram-setup"]')?.click();
          return;
        }
        const form = shadow.querySelector<HTMLFormElement>('form[data-messaging-kind="start"]');
        if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    };
    // Pairing needs this computer's own session: open it first, as Keys does on a press.
    if (localSession) begin();
    else void openLocalSession().then(begin);
    return true;
  }
  handle = bridge(landing ? { ...input.bridge, landing } : input.bridge, {
    frame,
    callTool,
    uploadFile,
    abortUpload,
    openUrl(url: string) {
      // Connect on the WhatsApp or Telegram card pairs right here.
      const pairingSource = Object.prototype.hasOwnProperty.call(input.pairing.urls, url) ? input.pairing.urls[url] : undefined;
      if (pairingSource && openPairing(pairingSource)) return;
      // On the computer the dashboard is already the whole app: its own pages
      // open in place (an Omarchy app window would otherwise hand them to a
      // browser tab). Only pages elsewhere open in the browser (owner
      // decision, 2026-10-13). The links name the worker's address; behind
      // the Linux desktop bridge the page runs on another, so a page is
      // matched by the list it came from and opened by its path.
      const own = Object.keys(input.bridge.links).map((key) => input.bridge.links[key])
        .concat(Object.keys(input.bridge.openTargets).map((key) => input.bridge.openTargets[key]));
      let parsed: URL | undefined;
      try {
        parsed = new URL(url, window.location.href);
      } catch {
        parsed = undefined;
      }
      if (parsed && (own.indexOf(url) >= 0 || parsed.origin === window.location.origin)) {
        window.location.assign(parsed.pathname + parsed.search + parsed.hash);
        return;
      }
      try {
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch {
        // The link below remains usable when opening throws.
      }
      // A browser may block an asynchronous open. Always offer a real link in
      // the parent, outside the sandbox, so the next click is a user gesture.
      const offer = document.querySelector<HTMLElement>('[data-open-offer]');
      const link = document.querySelector<HTMLAnchorElement>('[data-open-offer-link]');
      if (!offer || !link) return;
      link.href = url;
      offer.hidden = false;
      link.focus();
    },
  });
  const offerLink = document.querySelector<HTMLAnchorElement>('[data-open-offer-link]');
  offerLink?.addEventListener('click', () => {
    const offer = document.querySelector<HTMLElement>('[data-open-offer]');
    if (offer) offer.hidden = true;
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
  // Read only the local worker's cached result. A page opened before the
  // delayed check still learns about it; this never triggers a site request.
  // An update that is running or just ended (update-now.ts) keeps its own words.
  if (input.updateSupported) {
    const refreshUpdate = async () => {
      try {
        const response = await fetch('/v1/health', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5_000) });
        if (!response.ok) return;
        const health = await response.json();
        const version = health?.update_available?.version;
        const notice = document.querySelector<HTMLElement>('[data-update-notice]');
        const sentence = document.querySelector<HTMLElement>('[data-update-title]');
        if (!notice || !sentence) return;
        const state = notice.getAttribute('data-update-state');
        const valid = typeof version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version);
        if (state === 'failed' || state === 'rolled_back') {
          // Keep the outcome's words; a version found since (a worker just
          // restarted has an empty update cache) brings the retry back.
          if (valid) {
            notice.setAttribute('data-update-version', version);
            const retry = notice.querySelector<HTMLElement>('[data-update-now]');
            if (retry) retry.hidden = false;
          }
          return;
        }
        if (state !== 'none' && state !== 'available') return;
        sentence.textContent = valid ? input.updateWords.notice.replace('{version}', version) : '';
        notice.setAttribute('data-update-state', valid ? 'available' : 'none');
        notice.setAttribute('data-update-version', valid ? version : '');
        const button = notice.querySelector<HTMLElement>('[data-update-now]');
        if (button) button.hidden = !valid;
        notice.hidden = !valid;
      } catch { /* A failed local read is silent. */ }
    };
    void refreshUpdate();
    window.setInterval(() => { void refreshUpdate(); }, 60_000);
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

const DASHBOARD_PAIRING_DIALOG_LABEL = 'Pair a messaging account';

/** What the host needs to pair WhatsApp and Telegram over the dashboard (hostProgram `pairing`). */
function computerPairing(openTargets: Record<string, string>): {
  urls: Record<string, 'telegram' | 'whatsapp'>; cards: Record<string, string>; pairedCards: Record<string, string>; css: string; messagingPath: string;
} {
  const urls: Record<string, 'telegram' | 'whatsapp'> = {};
  const cards: Record<string, string> = {};
  const pairedCards: Record<string, string> = {};
  for (const source of ['whatsapp', 'telegram'] as const) {
    const url = openTargets[openTargetPath({ kind: 'connect', source })];
    if (url) urls[url] = source;
    cards[source] = renderMessagingCard(source, true);
    pairedCards[source] = renderMessagingCard(source, true, { paired: true });
  }
  // The local pages' stylesheet, scoped to the shadow root it is placed in.
  const css = DASHBOARD_THEME_CSS.replaceAll(':root', ':host').replace(/(^|\n)body\s*\{/g, '$1:host{display:block;').concat('\n:host{padding:0 1rem 1rem}');
  return { urls, cards, pairedCards, css, messagingPath: '/dashboard/messaging/' };
}

export function renderComputerHostPage(input: ComputerHostPageInput): string {
  const installer = installerForPlatform(input.platform ?? 'darwin');
  const update = installer ? input.updateAvailable : undefined;
  const token = input.readToken;
  const locked = input.csrfToken === undefined;
  const notice = installer ? {
    command: installer.command,
    available: update,
    selfUpdate: input.selfUpdate === true,
    status: input.selfUpdate ? input.updateStatus : undefined,
    csrfToken: input.csrfToken,
    localSession: input.localSession === true,
  } : undefined;
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
    localSession: input.localSession === true,
    localTools: COMPUTER_LOCAL_SESSION_TOOL_NAMES,
    localSessionPath: DASHBOARD_OUTSIDE_HELP_PATHS.unlock,
    readUrl,
    lockedUrl: dashboardHomeHref(token),
    openFragment: `#${DASHBOARD_OPEN_FRAGMENT_KEY}=`,
    landings: panelOpenTargetSources(),
    importLanding: DASHBOARD_IMPORT_LANDING_PREFIX,
    sourceLanding: DASHBOARD_SOURCE_LANDING_PREFIX,
    allSourcesLanding: { token: DASHBOARD_ALL_SOURCES_LANDING, id: DASHBOARD_ALL_SOURCES_ID },
    hasReadToken: token !== undefined,
    toolsCallPath: DASHBOARD_TOOLS_CALL_PATH,
    uploadPath: DASHBOARD_ARCHIVE_UPLOAD_FILE_PATH,
    uploadTool: ARCHIVE_UPLOAD_START_TOOL_NAME,
    uploadChunkBytes: ARCHIVE_UPLOAD_CHUNK_BYTES,
    words: DASHBOARD_HOST_GATE_COPY,
    updateSupported: installer !== undefined,
    updateWords: { notice: DASHBOARD_UPDATE_COPY.notice('{version}') },
    pairing: computerPairing(bridge.openTargets),
    setupAgent: { metaKey: COMPUTER_META_KEY, fragment: `#${DASHBOARD_SETUP_AGENT_ID}`, copied: DASHBOARD_SETUP_AGENT_COPY.copied, copyFailed: DASHBOARD_SETUP_AGENT_COPY.copyFailed },
  })}, ${dashboardHostBridge.toString()}, ${mountDashboardController.toString()});`.replaceAll('</script', '<\\/script');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Olympus</title>',
    `<style>${HOST_CSS}${UPDATE_NOTICE_CSS}${TOP_NAV_CSS}.topnav{flex:none;max-width:48rem;width:calc(100% - 2rem);margin:1rem auto 0}</style>`,
    '</head>',
    `<body data-olympus-host="computer" data-locked="${locked ? 'true' : 'false'}">`,
    // The page's one landmark and level-one heading. The heading is visually hidden: the framed panel carries the visible title.
    '<main>',
    '<h1 class="sr-only">Olympus dashboard</h1>',
    // Home's script does not post controls, so the bar shows the lock state only.
    dashboardTopNav({ active: 'home', unlocked: !locked, lockable: false, ...(token ? { token } : {}) }),
    `<header class="computer-identity" data-computer-identity>${text(input.computerIdentity ?? dashboardComputerIdentity())}</header>`,
    ...(notice ? [`<div class="update">${renderUpdateNotice({ ...notice, deferScript: true })}</div>`] : []),
    lockedGate(!locked),
    `<section class="gate" data-open-offer role="alert" hidden><p>${text(DASHBOARD_HOST_GATE_COPY.openBlocked)} `
    + `<a class="btn" data-open-offer-link target="_blank" rel="noopener noreferrer">${text(DASHBOARD_HOST_GATE_COPY.openBlockedLink)}</a></p></section>`,
    // Built-in models are status, not something to act on: Settings › Models on this computer (#1085).
    // allow-scripts only: an opaque origin, so the panel can reach nothing of
    // this page's (cookies, storage, DOM) and talks only through postMessage.
    `<iframe class="panel" id="olympus-panel" title="Olympus dashboard" sandbox="allow-scripts" srcdoc="${attribute(input.panelHtml)}"></iframe>`,
    '</main>',
    setupAgentDialog(),
    `<dialog class="pairing" data-pairing-dialog aria-label="${attribute(DASHBOARD_PAIRING_DIALOG_LABEL)}"><div class="bar"><button class="btn" type="button" data-pairing-close>Close</button></div><div data-pairing-root></div></dialog>`,
    `<script>${program}</script>`,
    // The notice's own program, after the page's (update-now.ts).
    ...(notice ? [renderUpdateNoticeScript(notice)] : []),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** The fragment that opens "Set up with my agent" on Home: `/dashboard#setup-with-agent`. */
export const DASHBOARD_SETUP_AGENT_ID = 'setup-with-agent';

/**
 * "Set up with my agent" (#1077, approved mockup 2-agent-brief): the brief
 * for the owner's agent and its Copy button, in the host page because the
 * framed panel's sandbox has no clipboard. Closed until a dashboard read
 * carries the setup checklist; Home's setup card opens it with
 * `[data-setup-agent-open]` or the fragment.
 */
export function setupAgentDialog(): string {
  const C = DASHBOARD_SETUP_AGENT_COPY;
  return `<dialog class="setup-agent" id="${DASHBOARD_SETUP_AGENT_ID}" data-setup-agent-dialog aria-labelledby="setup-agent-title">`
    + `<div class="head"><h2 id="setup-agent-title">${text(C.title)}</h2><button class="x" type="button" data-setup-agent-close aria-label="${attribute(C.close)}">✕</button></div>`
    + `<p class="intro">${text(C.intro)}</p>`
    + `<pre id="setup-agent-brief">${text(C.brief)}</pre>`
    + `<div class="actions"><button class="btn primary" type="button" data-setup-agent-copy>${text(C.copy)}</button>`
    + `<button class="btn" type="button" data-setup-agent-close>${text(C.close)}</button>`
    + '<span class="status" data-setup-agent-copy-status aria-live="polite"></span></div>'
    + '</dialog>';
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

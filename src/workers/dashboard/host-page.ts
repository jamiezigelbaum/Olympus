import { installerForPlatform, type UpdateAvailable } from '../../core/update-check.ts';
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
import { ARCHIVE_UPLOAD_CHUNK_BYTES } from '../archive-import/staging.ts';
import {
  DASHBOARD_HOST_GATE_COPY,
  DASHBOARD_UPDATE_COPY,
  DASHBOARD_WORKER_TOKEN_AGENT_PROMPT,
} from './vocabulary.ts';
import {
  DASHBOARD_IMPORT_LANDING_PREFIX,
  DASHBOARD_OPEN_FRAGMENT_KEY,
  OPEN_PAGE_BASE_URL,
  allOpenTargets,
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
  agents: 'agents',
  privateAnswers: 'private-answers',
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
 * for X, Readwise, Telegram, WhatsApp or Evernote opens that source's setup sheet on
 * Keys; a models fix opens Models there; See why on a source (unreadable/<id>)
 * opens this dashboard landed on it; the dashboard is the dashboard. The
 * ChatGPT-connection fixes (connect, reconnect) keep their help page.
 */
export function computerOpenTargets(origin: string, token?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const target of allOpenTargets()) {
    const path = openTargetPath(target);
    if (target.kind === 'dashboard') out[path] = `${origin}${dashboardHomeHref(token)}`;
    else if (target.kind === 'private_answers') out[path] = `${origin}${dashboardLocalPageHref('privateAnswers', token)}${target.answerId ? '#' + target.answerId : ''}`;
    else if (isKeysOpenTarget(target)) {
      out[path] = `${origin}${dashboardLocalPageHref('keys', token)}#${DASHBOARD_OPEN_FRAGMENT_KEY}=${openTargetToken(target)}`;
    } else if (isPanelOpenTarget(target)) {
      out[path] = `${origin}${dashboardHomeHref(token)}#${DASHBOARD_OPEN_FRAGMENT_KEY}=${openTargetToken(target)}`;
    }
  }
  return out;
}

export interface ComputerHostPageInput {
  updateAvailable?: UpdateAvailable | undefined;
  /** The running worker platform; unsupported installers never render or poll. */
  platform?: string;
  modelReadiness?: readonly { name: string; state: string; detail: string; downloadBytes: number }[];
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
.update{flex:none;max-width:48rem;width:calc(100% - 2rem);margin:1rem auto 0}
.update p{margin:0 0 0.5rem}
.update code{overflow-wrap:anywhere;white-space:pre-wrap}
.panel{flex:1 1 auto;width:100%;min-height:0;border:0;display:block;background:var(--bg)}
main{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
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
  hasReadToken: boolean;
  toolsCallPath: string;
  /** Where one file of an archive upload goes, and the local tool whose unlock opens the session it needs. */
  uploadPath: string;
  uploadTool: string;
  /** How large a piece of a file goes in one request (archive-import/staging.ts). */
  uploadChunkBytes: number;
  words: typeof DASHBOARD_HOST_GATE_COPY;
  updateWords: { notice: string; copied: string; copyFailed: string };
  updateSupported: boolean;
}, bridge: typeof dashboardHostBridge): void {
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
    return result;
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
   * agent's bearer never reaches it; refused, the tool says so itself.
   */
  function localUnlock(name: string): Promise<void> {
    if (localSession || input.localTools.indexOf(name) < 0) return Promise.resolve();
    return fetch(input.localSessionPath, { method: 'POST', cache: 'no-store', credentials: 'same-origin' })
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
        .then((response) => (response.ok ? response.json() : failed()));
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
  }
  handle = bridge(landing ? { ...input.bridge, landing } : input.bridge, {
    frame,
    callTool,
    uploadFile,
    abortUpload,
    openUrl(url: string) {
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
  if (input.updateSupported) {
    const refreshUpdate = async () => {
      try {
        const response = await fetch('/v1/health', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5_000) });
        if (!response.ok) return;
        const health = await response.json();
        const version = health?.update_available?.version;
        const notice = document.querySelector<HTMLElement>('[data-update-notice]');
        const sentence = document.querySelector<HTMLElement>('[data-update-text]');
        if (!notice || !sentence) return;
        const valid = typeof version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version);
        sentence.textContent = valid ? input.updateWords.notice.replace('{version}', version) : '';
        notice.hidden = !valid;
      } catch { /* A failed local read is silent. */ }
    };
    void refreshUpdate();
    window.setInterval(() => { void refreshUpdate(); }, 60_000);
  }
  const updateCopy = document.querySelector<HTMLButtonElement>('[data-update-copy]');
  const updateCommand = document.getElementById('update-command');
  const updateStatus = document.querySelector<HTMLElement>('[data-update-copy-status]');
  if (updateCopy && updateCommand) {
    updateCopy.addEventListener('click', () => {
      const done = (words: string) => { if (updateStatus) updateStatus.textContent = words; };
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(updateCommand.textContent || '').then(() => done(input.updateWords.copied), () => done(input.updateWords.copyFailed));
      } else done(input.updateWords.copyFailed);
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
  const installer = installerForPlatform(input.platform ?? 'darwin');
  const update = installer ? input.updateAvailable : undefined;
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
    localSession: input.localSession === true,
    localTools: COMPUTER_LOCAL_SESSION_TOOL_NAMES,
    localSessionPath: DASHBOARD_OUTSIDE_HELP_PATHS.unlock,
    readUrl,
    lockedUrl: dashboardHomeHref(token),
    openFragment: `#${DASHBOARD_OPEN_FRAGMENT_KEY}=`,
    landings: panelOpenTargetSources(),
    importLanding: DASHBOARD_IMPORT_LANDING_PREFIX,
    hasReadToken: token !== undefined,
    toolsCallPath: DASHBOARD_TOOLS_CALL_PATH,
    uploadPath: DASHBOARD_ARCHIVE_UPLOAD_FILE_PATH,
    uploadTool: ARCHIVE_UPLOAD_START_TOOL_NAME,
    uploadChunkBytes: ARCHIVE_UPLOAD_CHUNK_BYTES,
    words: DASHBOARD_HOST_GATE_COPY,
    updateSupported: installer !== undefined,
    updateWords: { notice: DASHBOARD_UPDATE_COPY.notice('{version}'), copied: DASHBOARD_UPDATE_COPY.copied, copyFailed: DASHBOARD_UPDATE_COPY.copyFailed },
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
    // The page's one landmark and level-one heading. The heading is visually hidden: the framed panel carries the visible title.
    '<main>',
    '<h1 class="sr-only">Olympus dashboard</h1>',
    ...(installer ? [
      `<section class="update" data-update-notice${update ? '' : ' hidden'}><p data-update-text>${update ? text(DASHBOARD_UPDATE_COPY.notice(update.version)) : ''}</p>`
      + `<p><code id="update-command">${text(installer.command)}</code> `
      + `<button class="btn" type="button" data-update-copy>${text(DASHBOARD_UPDATE_COPY.copy)}</button> `
      + `<span class="status" data-update-copy-status aria-live="polite"></span></p></section>`,
    ] : []),
    lockedGate(!locked),
    `<section class="gate" data-open-offer role="alert" hidden><p>${text(DASHBOARD_HOST_GATE_COPY.openBlocked)} `
    + `<a class="btn" data-open-offer-link target="_blank" rel="noopener noreferrer">${text(DASHBOARD_HOST_GATE_COPY.openBlockedLink)}</a></p></section>`,
    ...(input.modelReadiness ? [`<details class="gate"><summary>Built-in models on this computer</summary>${input.modelReadiness.map(model => `<p><strong>${text(model.name)} — ${text(model.state)}</strong>: ${text(model.detail)} (${(model.downloadBytes / 1_000_000_000).toFixed(2)} GB download)</p>`).join('')}</details>`] : []),
    // allow-scripts only: an opaque origin, so the panel can reach nothing of
    // this page's (cookies, storage, DOM) and talks only through postMessage.
    `<iframe class="panel" id="olympus-panel" title="Olympus dashboard" sandbox="allow-scripts" srcdoc="${attribute(input.panelHtml)}"></iframe>`,
    '</main>',
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

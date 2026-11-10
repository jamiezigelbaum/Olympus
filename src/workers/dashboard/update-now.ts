/**
 * The update notice with Update now (#1063), on Home and on Settings › Updates.
 *
 * "Olympus X is available." with an Update now button, then the four steps
 * (download, check signature, install, restart) as a progress bar, then the
 * new version, or that the previous version was put back. The Terminal
 * command stays one click away, as "Update in Terminal instead".
 *
 * The button calls the engine's local-only routes (workers/http.ts
 * DASHBOARD_SELF_UPDATE_PATHS) with this computer's own control session;
 * the engine downloads, checks and runs the installer (core/self-update.ts).
 */
import type { SelfUpdateStatus } from '../../core/self-update.ts';
import { DASHBOARD_SELF_UPDATE_PATHS } from '../http.ts';
import { CHATGPT_DASHBOARD_DARK, CHATGPT_DASHBOARD_LIGHT } from './chatgpt/page.ts';
import { DASHBOARD_OUTSIDE_HELP_PATHS } from './outside-help.ts';
import { DASHBOARD_UPDATE_COPY } from './vocabulary.ts';

export interface UpdateNoticeInput {
  /** The Terminal command for this platform's installer. */
  command: string;
  /** The newer version the update check found, if any. */
  available?: { version: string } | undefined;
  /** Update now is offered (the standalone engine). */
  selfUpdate: boolean;
  /** The engine's update record, when an update is running or just ended. */
  status?: SelfUpdateStatus | undefined;
  /** This page's control session, if it has one, and whether it is this computer's own. */
  csrfToken?: string | undefined;
  localSession?: boolean;
  /** `id` prefix, so two notices never share an element id. */
  idPrefix?: string;
}

function esc(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function json(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

const C = DASHBOARD_UPDATE_COPY;
/** Placeholders the page fills in: {to} {from} {version} {n} {words}. */
const WORDS = {
  notice: C.notice('{version}'),
  updateNow: C.updateNow,
  updating: C.updating('{to}'),
  step: C.step(0, '{words}').replace('step 0', 'step {n}'),
  steps: [...C.steps],
  pause: C.pause('{to}', '{from}'),
  done: C.done('{version}'),
  rolledBack: C.rolledBack('{to}', '{from}'),
  failures: C.failures,
  refusals: C.refusals,
  unreachable: C.unreachable,
  failedFallback: C.failedFallback,
  copied: C.copied,
  copyFailed: C.copyFailed,
};

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key] ?? ''));
}

/** What the notice says for a status, server side (the page script says the same). */
function lines(input: UpdateNoticeInput): { state: string; title: string; detail: string; note: string; bar: number } | undefined {
  const status = input.status;
  if (status?.state === 'running') {
    return { state: 'running', title: fill(WORDS.updating, { to: status.to }), detail: fill(WORDS.step, { n: status.step, words: WORDS.steps[status.step - 1]! }), note: fill(WORDS.pause, { to: status.to, from: status.from }), bar: status.step };
  }
  if (status?.state === 'done') return { state: 'done', title: fill(WORDS.done, { version: status.version }), detail: '', note: '', bar: 0 };
  if (status?.state === 'rolled_back') return { state: 'rolled_back', title: fill(WORDS.rolledBack, { to: status.to, from: status.from }), detail: '', note: '', bar: 0 };
  if (status?.state === 'failed') return { state: 'failed', title: WORDS.failures[status.reason] ?? WORDS.failedFallback, detail: '', note: '', bar: 0 };
  if (input.available) return { state: 'available', title: fill(WORDS.notice, { version: input.available.version }), detail: '', note: '', bar: 0 };
  return undefined;
}

/** The notice; its program follows inline unless `deferScript`, when the page places renderUpdateNoticeScript itself. */
export function renderUpdateNotice(input: UpdateNoticeInput & { deferScript?: boolean }): string {
  const prefix = input.idPrefix ?? 'update';
  const view = lines(input);
  const running = view?.state === 'running';
  const offer = input.selfUpdate && (view?.state === 'available' || view?.state === 'failed' || view?.state === 'rolled_back') && input.available !== undefined;
  const config = {
    csrfToken: input.csrfToken ?? '',
    localSession: input.localSession === true,
    localSessionPath: DASHBOARD_OUTSIDE_HELP_PATHS.unlock,
    startPath: DASHBOARD_SELF_UPDATE_PATHS.start,
    statusPath: DASHBOARD_SELF_UPDATE_PATHS.status,
    selfUpdate: input.selfUpdate,
    available: input.available?.version ?? '',
    running,
    initial: input.status?.state === 'running' ? input.status : undefined,
    rootId: `${prefix}-notice`,
    words: WORDS,
  };
  return `<section class="upd" id="${prefix}-notice" data-update-notice data-update-state="${view?.state ?? 'none'}"${view ? '' : ' hidden'} aria-live="polite">`
    + `<div class="upd-row"><p class="upd-title" data-update-text><strong data-update-title>${esc(view?.title ?? '')}</strong>`
    + `<span class="upd-detail" data-update-detail${view?.detail ? '' : ' hidden'}>${view?.detail ? ` · ${esc(view.detail)}` : ''}</span></p>`
    + (input.selfUpdate ? `<button class="btn primary upd-now" type="button" data-update-now${offer ? '' : ' hidden'}>${esc(C.updateNow)}</button>` : '')
    + '</div>'
    + `<div class="upd-bar" data-update-bar role="progressbar" aria-valuemin="0" aria-valuemax="4" aria-valuenow="${view?.bar ?? 0}"${running ? '' : ' hidden'}><span style="width:${(view?.bar ?? 0) * 25}%"></span></div>`
    + `<p class="upd-note" data-update-note${view?.note ? '' : ' hidden'}>${esc(view?.note ?? '')}</p>`
    + `<details class="upd-terminal" data-update-terminal${input.selfUpdate ? '' : ' open'}${running ? ' hidden' : ''}><summary>${esc(C.terminal)}</summary>`
    + `<p>${esc(C.terminalHow)}</p><p><code id="${prefix}-command">${esc(input.command)}</code> `
    + `<button class="btn" type="button" data-update-copy>${esc(C.copy)}</button> <span class="upd-status" data-update-copy-status aria-live="polite"></span></p></details>`
    + (input.deferScript ? '' : renderScript(config))
    + '</section>';
}

function renderScript(config: unknown): string {
  return `<script>(${updateNoticeProgram.toString()})(${json(config)});</script>`;
}

/** The notice's program, for a page that places it after its own scripts. */
export function renderUpdateNoticeScript(input: UpdateNoticeInput): string {
  const html = renderUpdateNotice(input);
  const start = html.lastIndexOf('<script>');
  return start >= 0 ? html.slice(start, html.lastIndexOf('</section>')) : '';
}

function palette(p: typeof CHATGPT_DASHBOARD_LIGHT): string {
  return `--upd-bg:${p.infoBg};--upd-line:${p.infoLine};--upd-fill:${p.accent};--upd-on:${p.onAccent};--upd-track:${p.line};--upd-muted:${p.muted}`;
}

export const UPDATE_NOTICE_CSS = `
.upd{${palette(CHATGPT_DASHBOARD_LIGHT)};background:var(--upd-bg);border-left:4px solid var(--upd-line);border-radius:8px;padding:0.875rem 1.125rem;margin:1rem 0}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .upd{${palette(CHATGPT_DASHBOARD_DARK)}}}
:root[data-theme=dark] .upd{${palette(CHATGPT_DASHBOARD_DARK)}}
.upd[hidden],.upd [hidden]{display:none}
.upd p{margin:0}
.upd-row{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem 1rem}
.upd-title{flex:1 1 16rem;min-width:0}
.upd-now.btn,.upd-now.btn.primary{background:var(--upd-fill);border-color:var(--upd-fill);color:var(--upd-on);font-weight:600;border-radius:999px;padding:0.4rem 1.1rem;min-height:2.25rem}
.upd-bar{height:6px;border-radius:3px;background:var(--upd-track);margin:0.6rem 0 0.5rem;overflow:hidden}
.upd-bar span{display:block;height:100%;background:var(--upd-fill);border-radius:3px;transition:width .3s}
.upd-note{color:var(--upd-muted);font-size:0.875rem}
.upd-terminal{margin-top:0.5rem}
.upd-terminal summary{cursor:pointer;color:var(--upd-muted);font-size:0.875rem}
.upd-terminal p{margin-top:0.4rem}
.upd-terminal code{overflow-wrap:anywhere;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.8125rem}
.upd-status{color:var(--upd-muted);font-size:0.875rem}
`;

/** The notice's own program: Copy command, Update now, and the progress that follows. */
function updateNoticeProgram(config: {
  csrfToken: string; localSession: boolean; localSessionPath: string; startPath: string; statusPath: string;
  selfUpdate: boolean; available: string; running: boolean; rootId: string;
  initial?: { state: string; step?: number; from?: string; to?: string } | undefined;
  words: typeof WORDS;
}): void {
  const root = document.getElementById(config.rootId);
  if (!root) return;
  const words = config.words;
  const q = <T extends Element>(selector: string) => root.querySelector<T>(selector);
  const fillIn = (template: string, values: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (_m: string, key: string) => '' + (values[key] ?? ''));
  let csrf = config.csrfToken;
  let local = config.localSession;
  let polling = false;

  const copy = q<HTMLButtonElement>('[data-update-copy]');
  const command = q<HTMLElement>('code');
  const copyStatus = q<HTMLElement>('[data-update-copy-status]');
  if (copy && command) {
    copy.addEventListener('click', () => {
      const done = (text: string) => { if (copyStatus) copyStatus.textContent = text; };
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(command.textContent || '').then(() => done(words.copied), () => done(words.copyFailed));
      } else done(words.copyFailed);
    });
  }

  type Status = { state: string; step?: number; from?: string; to?: string; version?: string; reason?: string };
  function show(state: string, title: string, detail: string, note: string, bar: number, offer: boolean): void {
    root!.setAttribute('data-update-state', state);
    root!.hidden = false;
    const titleEl = q<HTMLElement>('[data-update-title]');
    const detailEl = q<HTMLElement>('[data-update-detail]');
    const noteEl = q<HTMLElement>('[data-update-note]');
    const barEl = q<HTMLElement>('[data-update-bar]');
    const button = q<HTMLButtonElement>('[data-update-now]');
    const terminal = q<HTMLElement>('[data-update-terminal]');
    if (titleEl) titleEl.textContent = title;
    if (detailEl) { detailEl.textContent = detail ? ' · ' + detail : ''; detailEl.hidden = !detail; }
    if (noteEl) { noteEl.textContent = note; noteEl.hidden = !note; }
    if (barEl) {
      barEl.hidden = bar === 0;
      barEl.setAttribute('aria-valuenow', '' + bar);
      const fillEl = barEl.querySelector<HTMLElement>('span');
      if (fillEl) fillEl.style.width = bar * 25 + '%';
    }
    if (button) { button.hidden = !offer; button.disabled = false; }
    if (terminal) terminal.hidden = state === 'running' || state === 'done';
  }
  function render(status: Status): void {
    if (status.state === 'running' && status.step && status.to && status.from) {
      show('running', fillIn(words.updating, { to: status.to }), fillIn(words.step, { n: status.step, words: words.steps[status.step - 1] || '' }), fillIn(words.pause, { to: status.to, from: status.from }), status.step, false);
    } else if (status.state === 'done' && status.version) {
      show('done', fillIn(words.done, { version: status.version }), '', '', 0, false);
    } else if (status.state === 'rolled_back' && status.to && status.from) {
      show('rolled_back', fillIn(words.rolledBack, { to: status.to, from: status.from }), '', '', 0, !!config.available);
    } else if (status.state === 'failed') {
      show('failed', words.failures[status.reason || ''] || words.failedFallback, '', '', 0, !!config.available);
    }
  }
  // async, not Promise.resolve: a page's VM may not expose the Promise global by name.
  async function unlock(): Promise<void> {
    if (local && csrf) return;
    // This computer's own session: the worker grants it only to a loopback
    // browser presenting no bearer, so an agent never reaches Update now.
    try {
      const response = await fetch(config.localSessionPath, { method: 'POST', cache: 'no-store', credentials: 'same-origin' });
      const body = (response.ok ? await response.json() : undefined) as { csrf_token?: unknown } | undefined;
      if (body && typeof body.csrf_token === 'string' && body.csrf_token) { csrf = body.csrf_token; local = true; }
    } catch { /* The start call then says why it was refused. */ }
  }
  function post(path: string): Promise<{ status: number; body: { ok?: boolean; update?: Status; error?: { message?: string } } }> {
    return fetch(path, {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'X-Olympus-CSRF': csrf, 'Content-Type': 'application/json' }, body: '{}',
    }).then(response => response.json().then(body => ({ status: response.status, body }), () => ({ status: response.status, body: {} })));
  }
  let lastRunning: Status | undefined = config.initial;
  function restarting(): void {
    if (lastRunning && lastRunning.to && lastRunning.from) {
      show('running', fillIn(words.updating, { to: lastRunning.to }), fillIn(words.step, { n: 4, words: words.steps[3] || '' }), fillIn(words.pause, { to: lastRunning.to, from: lastRunning.from }), 4, false);
    }
  }
  function poll(): void {
    window.setTimeout(() => {
      post(config.statusPath).then(({ body }) => {
        const status = body && body.update;
        // No answer from the engine (a proxy's 502 while it restarts): step 4.
        if (!status) { restarting(); poll(); return; }
        if (status.state === 'running') { lastRunning = status; render(status); poll(); return; }
        polling = false;
        if (status.state === 'idle') { window.location.reload(); return; }
        render(status);
      }, () => {
        // The engine is restarting: step 4 until it answers again.
        restarting();
        poll();
      });
    }, 2000);
  }
  function startPolling(): void {
    if (polling) return;
    polling = true;
    poll();
  }
  const button = q<HTMLButtonElement>('[data-update-now]');
  if (button && config.selfUpdate) {
    button.addEventListener('click', () => {
      button.disabled = true;
      unlock().then(() => post(config.startPath)).then(({ body }) => {
        if (body && body.ok && body.update) {
          if (body.update.state === 'running') lastRunning = body.update;
          render(body.update);
          if (body.update.state === 'running') startPolling();
          return;
        }
        const noteEl = q<HTMLElement>('[data-update-note]');
        if (noteEl) { noteEl.textContent = (body && body.error && body.error.message) || words.failedFallback; noteEl.hidden = false; }
        button.disabled = false;
      }, () => {
        const noteEl = q<HTMLElement>('[data-update-note]');
        if (noteEl) { noteEl.textContent = words.failedFallback; noteEl.hidden = false; }
        button.disabled = false;
      });
    });
  }
  // A page opened, or reloaded, while an update runs keeps following it.
  if (config.running && config.selfUpdate) unlock().then(startPolling);
}

export { WORDS as UPDATE_NOTICE_WORDS };

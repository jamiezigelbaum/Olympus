/**
 * Step 1 of the zkAPI setup on the Mac dashboard card: "Install the parts:
 * Tor and zkAPI, one click" (design docs/design/private-answers.md). The
 * button posts to the card's install route (a local-grade control route like
 * the card's others); the worker runs the pinned, verified install in the
 * background (core/managed-tools.ts) and this section polls the page for
 * progress: Downloading Tor… / Checking… / Installed, or a plain failure with
 * Try again. Installing changes no setting and turns nothing on.
 *
 * It appears twice when the parts need the owner: as a "To fix" line and as
 * step 1 inside Set up zkAPI; one script serves both.
 */
import type { ManagedToolName, ManagedToolsErrorCode, ManagedToolsPhase, ManagedToolSource } from '../../core/managed-tools.ts';
import { escapeHtml, escapeScriptJson } from './components.ts';
import { fill } from './source-rows.ts';

export interface DashboardOutsideHelpTool {
  readonly tool: ManagedToolName;
  readonly label: string;
  readonly source: ManagedToolSource;
}

export type DashboardOutsideHelpInstall =
  | { readonly state: 'idle' }
  | { readonly state: 'running'; readonly tool: string; readonly phase: ManagedToolsPhase; readonly percent?: number }
  | { readonly state: 'done' }
  | { readonly state: 'failed'; readonly code: ManagedToolsErrorCode; readonly message: string };

export interface DashboardOutsideHelpTools {
  readonly tools: readonly DashboardOutsideHelpTool[];
  readonly install: DashboardOutsideHelpInstall;
}

/** The install route; the card's paths, the HTTP boundary and the public route list carry it too. */
export const DASHBOARD_OUTSIDE_HELP_INSTALL_TOOLS_PATH = '/dashboard/consult/tools/install';

export const DASHBOARD_OUTSIDE_HELP_TOOLS_COPY = {
  title: 'Install the parts',
  intro: 'Olympus needs two small programs on your Mac: Tor, which hides where your question comes from, and zkAPI, which pays without revealing who you are. Olympus downloads the official builds, checks each against the fingerprint it ships with, and keeps them in its own folder. Installing turns nothing on.',
  source: {
    olympus: 'Installed (Olympus)',
    system: 'Installed (your system)',
    missing: 'Not installed',
    not_offered: 'No download for this computer; install it yourself',
  },
  line: '{tool}: {state}',
  install: 'Install Tor and zkAPI',
  retry: 'Try again',
  allInstalled: 'Both are installed. Nothing else changed.',
  phase: {
    downloading: 'Downloading {tool}…',
    checking: 'Checking {tool}…',
    installing: 'Installing {tool}…',
  },
  percent: '{percent}%',
  done: 'Installed.',
  failedPrefix: 'Not installed.',
  starting: 'Starting…',
  failed: 'The install could not start. Reload the page and try again.',
  fixOne: '{tools} is not installed on this Mac.',
  fixMany: '{tools} are not installed on this Mac.',
  fixWorking: 'Installing Tor and zkAPI.',
} as const;

const C = DASHBOARD_OUTSIDE_HELP_TOOLS_COPY;

/** Polling interval while an install runs. */
export const DASHBOARD_OUTSIDE_HELP_TOOLS_POLL_MS = 1500;

/** Whether the parts need the owner: something missing, or an install running or failed. */
export function outsideHelpToolsNeedAttention(tools: DashboardOutsideHelpTools | undefined): boolean {
  if (!tools) return false;
  return tools.install.state === 'running' || tools.install.state === 'failed' || tools.tools.some((entry) => entry.source === 'missing');
}

function progressLine(install: DashboardOutsideHelpInstall): string {
  if (install.state === 'running') {
    const phase = fill(C.phase[install.phase], { tool: install.tool });
    const percent = install.phase === 'downloading' && install.percent !== undefined ? ` ${fill(C.percent, { percent: String(install.percent) })}` : '';
    return `<p class="pnote" data-outside-install-progress role="status">${escapeHtml(phase + percent)}</p>`;
  }
  if (install.state === 'failed') {
    return `<p class="pnote ohwarn" data-outside-install-failed="${escapeHtml(install.code)}" role="status">${escapeHtml(`${C.failedPrefix} ${install.message}`)}</p>`;
  }
  return '';
}

function installButton(tools: DashboardOutsideHelpTools, canEdit: boolean): string {
  const missing = tools.tools.some((entry) => entry.source === 'missing');
  if (!missing || tools.install.state === 'running') return '';
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  return `<form class="ohform" data-outside-tools-form><div class="pbuttons">`
    + `<button type="submit" class="btn primary"${disabled}>${escapeHtml(tools.install.state === 'failed' ? C.retry : C.install)}</button></div>`
    + `<span class="actmsg" data-action-message role="status"></span></form>`;
}

/**
 * Step 1 inside Set up zkAPI: where each program was found, the install's
 * progress or failure, and the one button. Absent facts (an older worker)
 * render nothing. The script is rendered once per page
 * (renderOutsideHelpToolsScript).
 */
export function renderOutsideHelpTools(tools: DashboardOutsideHelpTools | undefined, input: { canEdit: boolean }): string {
  if (!tools) return '';
  const install = tools.install;
  const lines = tools.tools.map((entry) => `<li data-outside-tool="${escapeHtml(entry.tool)}" data-outside-tool-source="${escapeHtml(entry.source)}">`
    + `${escapeHtml(fill(C.line, { tool: entry.label, state: C.source[entry.source] }))}</li>`).join('');
  const missing = tools.tools.some((entry) => entry.source === 'missing');
  const parts: string[] = [
    `<p class="pnote"><strong>${escapeHtml(C.title)}</strong></p>`,
    `<p class="pnote">${escapeHtml(C.intro)}</p>`,
    `<ul class="ohfacts" data-outside-tool-list>${lines}</ul>`,
    progressLine(install),
  ];
  if (install.state === 'done' && !missing) parts.push(`<p class="pnote" data-outside-install-done role="status">${escapeHtml(C.done)}</p>`);
  if (!missing && install.state !== 'running') parts.push(`<p class="pnote ohsmall">${escapeHtml(C.allInstalled)}</p>`);
  parts.push(installButton(tools, input.canEdit));
  return `<div class="ohtools" data-outside-tools="setup" data-install-state="${escapeHtml(install.state)}">${parts.join('')}</div>`;
}

/**
 * The "To fix" line for the parts, with the same button, when they need the
 * owner; '' otherwise. It stands in for the separate not-installed blockers.
 */
export function renderOutsideHelpToolsFix(tools: DashboardOutsideHelpTools | undefined, input: { canEdit: boolean }): string {
  if (!tools || !outsideHelpToolsNeedAttention(tools)) return '';
  const missing = tools.tools.filter((entry) => entry.source === 'missing').map((entry) => entry.label);
  const text = missing.length === 0 ? C.fixWorking : fill(missing.length === 1 ? C.fixOne : C.fixMany, { tools: missing.join(' and ') });
  return `<li data-outside-tools="fix" data-install-state="${escapeHtml(tools.install.state)}"><span>${escapeHtml(text)}</span>`
    + `${progressLine(tools.install)}${installButton(tools, input.canEdit)}</li>`;
}

/** The one controller for every install button on the page; '' without the controls. */
export function renderOutsideHelpToolsScript(tools: DashboardOutsideHelpTools | undefined, input: { canEdit: boolean; csrfToken?: string }): string {
  if (!tools || !input.canEdit || input.csrfToken === undefined) return '';
  return `<script>${outsideHelpToolsClientScript({ csrfToken: input.csrfToken, path: DASHBOARD_OUTSIDE_HELP_INSTALL_TOOLS_PATH, pollMs: DASHBOARD_OUTSIDE_HELP_TOOLS_POLL_MS, copy: { starting: C.starting, failed: C.failed } })}</script>`;
}

/**
 * Posts the install with the control session's CSRF token, then re-reads this
 * page every `pollMs` and swaps in the fresh parts sections (the "To fix"
 * line and step 1 of Set up zkAPI) until the install stops running; when it
 * finishes, the whole page reloads so the route's readiness reads the new
 * programs.
 */
export function outsideHelpToolsClientScript(config: { csrfToken: string; path: string; pollMs: number; copy: { starting: string; failed: string } }): string {
  return `(function () {
  var config = ${escapeScriptJson(JSON.stringify(config))};
  var timer = null;
  function sections() { return Array.prototype.slice.call(document.querySelectorAll('[data-outside-tools]')); }
  function say(form, text, bad) {
    var out = form && form.querySelector('[data-action-message]');
    if (!out) return;
    out.textContent = text;
    out.setAttribute('data-state', bad ? 'error' : 'ok');
  }
  function schedule() { if (!timer) timer = setTimeout(poll, config.pollMs); }
  async function poll() {
    timer = null;
    var running = sections().some(function (node) { return node.getAttribute('data-install-state') === 'running'; });
    try {
      var response = await fetch(window.location.href, { credentials: 'same-origin', cache: 'no-store' });
      var doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      var fresh = doc.querySelectorAll('[data-outside-tools]');
      var states = Array.prototype.map.call(fresh, function (node) { return node.getAttribute('data-install-state'); });
      if (running && states.indexOf('done') !== -1) { window.location.reload(); return; }
      Array.prototype.forEach.call(fresh, function (next) {
        var current = document.querySelector('[data-outside-tools="' + next.getAttribute('data-outside-tools') + '"]');
        if (current) current.replaceWith(document.importNode(next, true));
      });
      // A part that needed fixing and now does not: the page changes shape.
      if (running && fresh.length !== sections().length) { window.location.reload(); return; }
    } catch (error) {
      // The next round tries again.
    }
    bind();
  }
  async function submit(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var buttons = document.querySelectorAll('form[data-outside-tools-form] button');
    buttons.forEach(function (button) { button.disabled = true; });
    say(form, config.copy.starting, false);
    try {
      var response = await fetch(config.path, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'X-Olympus-CSRF': config.csrfToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      var result = {};
      try { result = await response.json(); } catch (error) { result = {}; }
      if (!response.ok || !result.ok) {
        say(form, (result.error && result.error.message) || config.copy.failed, true);
        buttons.forEach(function (button) { button.disabled = false; });
        return;
      }
      say(form, result.status_message || config.copy.starting, false);
      sections().forEach(function (node) { node.setAttribute('data-install-state', 'running'); });
      schedule();
    } catch (error) {
      say(form, config.copy.failed, true);
      buttons.forEach(function (button) { button.disabled = false; });
    }
  }
  function bind() {
    document.querySelectorAll('form[data-outside-tools-form]').forEach(function (form) {
      if (form.hasAttribute('data-bound')) return;
      form.setAttribute('data-bound', '');
      form.addEventListener('submit', submit);
    });
    if (sections().some(function (node) { return node.getAttribute('data-install-state') === 'running'; })) schedule();
  }
  bind();
})();`;
}

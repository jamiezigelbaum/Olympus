/**
 * Step 1 of the zkAPI setup on the Mac dashboard card: "Install the parts:
 * Tor and zkAPI, one click" (design docs/design/private-answers.md). The
 * button posts to the card's install route (a local-grade control route like
 * the card's others); the worker runs the pinned, verified install in the
 * background (core/managed-tools.ts) and this section polls the page for
 * progress: Downloading Tor… / Checking… / Installed, or a plain failure with
 * Try again. Installing changes no setting and turns nothing on.
 *
 * Its own words and script live here, beside the card (outside-help.ts), so
 * the card's markup and controller change by one line each.
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
} as const;

const C = DASHBOARD_OUTSIDE_HELP_TOOLS_COPY;

/** Polling interval while an install runs. */
export const DASHBOARD_OUTSIDE_HELP_TOOLS_POLL_MS = 1500;

/**
 * The section, with its script when the reader holds the controls. Absent
 * facts (an older worker) render nothing.
 */
export function renderOutsideHelpTools(tools: DashboardOutsideHelpTools | undefined, input: { csrfToken?: string; canEdit: boolean }): string {
  if (!tools) return '';
  const install = tools.install;
  const lines = tools.tools.map((entry) => `<li data-outside-tool="${escapeHtml(entry.tool)}" data-outside-tool-source="${escapeHtml(entry.source)}">`
    + `${escapeHtml(fill(C.line, { tool: entry.label, state: C.source[entry.source] }))}</li>`).join('');
  const missing = tools.tools.some((entry) => entry.source === 'missing');
  const parts: string[] = [
    `<div class="sect">${escapeHtml(C.title)}</div>`,
    `<p class="pnote">${escapeHtml(C.intro)}</p>`,
    `<ul class="ohfacts" data-outside-tool-list>${lines}</ul>`,
  ];
  if (install.state === 'running') {
    const phase = fill(C.phase[install.phase], { tool: install.tool });
    const percent = install.phase === 'downloading' && install.percent !== undefined ? ` ${fill(C.percent, { percent: String(install.percent) })}` : '';
    parts.push(`<p class="pnote" data-outside-install-progress role="status">${escapeHtml(phase + percent)}</p>`);
  } else if (install.state === 'failed') {
    parts.push(`<p class="pnote ohwarn" data-outside-install-failed="${escapeHtml(install.code)}" role="status">${escapeHtml(`${C.failedPrefix} ${install.message}`)}</p>`);
  } else if (install.state === 'done' && !missing) {
    parts.push(`<p class="pnote" data-outside-install-done role="status">${escapeHtml(C.done)}</p>`);
  }
  if (!missing && install.state !== 'running') {
    parts.push(`<p class="pnote ohsmall">${escapeHtml(C.allInstalled)}</p>`);
  }
  if (missing && install.state !== 'running') {
    const disabled = input.canEdit ? '' : ' disabled aria-disabled="true"';
    parts.push(`<form class="ohform" data-outside-tools-form><div class="pbuttons">`
      + `<button type="submit" class="btn primary"${disabled}>${escapeHtml(install.state === 'failed' ? C.retry : C.install)}</button></div>`
      + `<span class="actmsg" data-action-message role="status"></span></form>`);
  }
  const section = `<div class="ohtools" data-outside-tools data-install-state="${escapeHtml(install.state)}">${parts.join('')}</div>`;
  const script = input.canEdit && input.csrfToken !== undefined
    ? `<script>${outsideHelpToolsClientScript({ csrfToken: input.csrfToken, path: DASHBOARD_OUTSIDE_HELP_INSTALL_TOOLS_PATH, pollMs: DASHBOARD_OUTSIDE_HELP_TOOLS_POLL_MS, copy: { starting: C.starting, failed: C.failed } })}</script>`
    : '';
  return section + script;
}

/**
 * Posts the install with the control session's CSRF token, then re-reads this
 * page every `pollMs` and swaps in the fresh section until the install stops
 * running; when it finishes, the whole page reloads so the route's readiness
 * reads the new programs.
 */
export function outsideHelpToolsClientScript(config: { csrfToken: string; path: string; pollMs: number; copy: { starting: string; failed: string } }): string {
  return `(function () {
  var config = ${escapeScriptJson(JSON.stringify(config))};
  var timer = null;
  function section() { return document.querySelector('[data-outside-tools]'); }
  function say(form, text, bad) {
    var out = form && form.querySelector('[data-action-message]');
    if (!out) return;
    out.textContent = text;
    out.setAttribute('data-state', bad ? 'error' : 'ok');
  }
  function schedule() { if (!timer) timer = setTimeout(poll, config.pollMs); }
  async function poll() {
    timer = null;
    var current = section();
    var was = current ? current.getAttribute('data-install-state') : '';
    try {
      var response = await fetch(window.location.href, { credentials: 'same-origin', cache: 'no-store' });
      var doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      var next = doc.querySelector('[data-outside-tools]');
      if (next && current) {
        var state = next.getAttribute('data-install-state');
        if (state === 'done' && was === 'running') { window.location.reload(); return; }
        current.replaceWith(document.importNode(next, true));
      }
    } catch (error) {
      // The next round tries again.
    }
    bind();
  }
  async function submit(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var buttons = form.querySelectorAll('button');
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
      schedule();
    } catch (error) {
      say(form, config.copy.failed, true);
      buttons.forEach(function (button) { button.disabled = false; });
    }
  }
  function bind() {
    var current = section();
    if (!current) return;
    var form = current.querySelector('form[data-outside-tools-form]');
    if (form && !form.hasAttribute('data-bound')) {
      form.setAttribute('data-bound', '');
      form.addEventListener('submit', submit);
    }
    if (current.getAttribute('data-install-state') === 'running') schedule();
  }
  bind();
})();`;
}

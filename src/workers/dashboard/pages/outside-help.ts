/**
 * Outside help: the Mac dashboard page that turns consults on, reached from
 * the panel's "On this computer" section (design docs/design/frontier-consult-lane.md
 * §A.9: changed only on the Mac, never from ChatGPT, an agent tool or the
 * relay; stage C5).
 *
 * The card renders only for a reader holding the local dashboard's control
 * session on the computer. Neither ChatGPT nor the OpenClaw Control UI tab
 * ever opens it: a hosted agent must never be able to switch on egress. A
 * dash_ reader, or a locked browser, is pointed at the gate on Keys.
 */
import { DASHBOARD_CONTROL_GATE_ID, escapeHtml, pageShell } from '../components.ts';
import { dashboardLocalPageHref } from '../host-page.ts';
import { renderOutsideHelpCard } from '../outside-help.ts';
import { DASHBOARD_OUTSIDE_HELP_CSS, LOCAL_PAGE_CSS } from '../static-styles.ts';
import { DASHBOARD_OUTSIDE_HELP_COPY as W } from '../vocabulary.ts';
import type { DashboardPageOptions } from './local.ts';

export function renderDashboardOutsideHelpPage(options?: DashboardPageOptions): string {
  const basePath = options?.basePath;
  return pageShell({
    title: 'Olympus',
    crumb: W.crumb,
    ...(basePath === undefined ? {} : { basePath }),
    meta: '',
    body: renderOutsideHelpBody(options),
    styles: [LOCAL_PAGE_CSS, DASHBOARD_OUTSIDE_HELP_CSS],
    // No shared controller and no poll: the card carries its own small
    // script, and a reload after each change is the refresh.
  });
}

/** The read-only token a dash_ reader's basePath carries, for the link to the gate. */
function readToken(basePath: string | undefined): string | undefined {
  if (!basePath) return undefined;
  const query = basePath.indexOf('?');
  if (query < 0) return undefined;
  return new URLSearchParams(basePath.slice(query + 1)).get('token') ?? undefined;
}

function renderOutsideHelpBody(options: DashboardPageOptions | undefined): string {
  const head = `<h2 class="ptitle">${escapeHtml(W.title)}</h2>`;
  const csrfToken = options?.controlSessionCsrfToken;
  if (csrfToken === undefined) {
    const gate = `${dashboardLocalPageHref('keys', readToken(options?.basePath))}#${DASHBOARD_CONTROL_GATE_ID}`;
    return `<div class="privacy outside" data-outside-locked>${head}`
      + `<p class="pnote">${escapeHtml(W.locked)} <a href="${escapeHtml(gate)}">Open dashboard controls →</a></p></div>`;
  }
  const status = options?.outsideHelp;
  if (!status) {
    return `<div class="privacy outside" data-outside-unavailable>${head}<p class="pnote">${escapeHtml(W.unavailable)}</p></div>`;
  }
  return renderOutsideHelpCard(status, {
    csrfToken,
    localSession: options?.outsideHelpLocalSession === true,
    ...(options?.basePath === undefined ? {} : { basePath: options.basePath }),
  });
}

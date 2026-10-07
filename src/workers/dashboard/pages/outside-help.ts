/**
 * Outside help: the Mac dashboard page that turns consults on, reached from
 * Setup's Outside help row (design docs/design/frontier-consult-lane.md
 * §A.9: changed only on the Mac, never from ChatGPT, an agent tool or the
 * relay; stage C5).
 *
 * The card renders only for a reader holding the local dashboard's control
 * session on the standalone page. The native OpenClaw and ChatGPT surfaces
 * (controlMode 'native') get one sentence and no controls, whatever their
 * write capability: a hosted agent must never be able to switch on egress.
 * A dash_ reader, or a locked browser, is pointed at Setup's gate.
 */
import type { SourceDashboardViewModel } from '../../source-dashboard.ts';
import { DASHBOARD_CONTROL_GATE_ID, escapeHtml, pageShell } from '../components.ts';
import { DASHBOARD_NAV_CSS, renderDashboardNav } from '../nav.ts';
import { renderOutsideHelpCard } from '../outside-help.ts';
import { setupHref } from '../source-rows.ts';
import { DASHBOARD_OUTSIDE_HELP_CSS, DASHBOARD_PRIVACY_CSS, DASHBOARD_SOURCE_ROWS_CSS } from '../static-styles.ts';
import { DASHBOARD_OUTSIDE_HELP_COPY as W, dashboardCheckedLabel } from '../vocabulary.ts';
import type { DashboardPageOptions } from './home.ts';

export function renderDashboardOutsideHelpPage(
  view: SourceDashboardViewModel,
  options?: DashboardPageOptions,
): string {
  const now = options?.now ?? new Date();
  const basePath = options?.basePath;
  return pageShell({
    title: 'Olympus',
    crumb: W.crumb,
    ...(basePath === undefined ? {} : { basePath }),
    meta: dashboardCheckedLabel(view.generated_at, now),
    body: [
      renderDashboardNav('setup', { ...(basePath === undefined ? {} : { basePath }) }),
      renderOutsideHelpBody(options),
    ].join('\n'),
    styles: [DASHBOARD_NAV_CSS, DASHBOARD_SOURCE_ROWS_CSS, DASHBOARD_PRIVACY_CSS, DASHBOARD_OUTSIDE_HELP_CSS],
    // No shared controller and no poll: the card carries its own small
    // script, and a reload after each change is the refresh.
    ...(options?.format === undefined ? {} : { format: options.format }),
  });
}

function renderOutsideHelpBody(options: DashboardPageOptions | undefined): string {
  const head = `<h2 class="ptitle">${escapeHtml(W.title)}</h2>`;
  if (options?.controlMode === 'native') {
    return `<div class="privacy outside" data-outside-native>${head}<p class="pnote">${escapeHtml(W.native)}</p></div>`;
  }
  const csrfToken = options?.controlSessionCsrfToken;
  if (csrfToken === undefined) {
    return `<div class="privacy outside" data-outside-locked>${head}`
      + `<p class="pnote">${escapeHtml(W.locked)} <a href="${escapeHtml(`${setupHref(options?.basePath)}#${DASHBOARD_CONTROL_GATE_ID}`)}">Setup →</a></p></div>`;
  }
  const status = options?.outsideHelp;
  if (!status) {
    return `<div class="privacy outside" data-outside-unavailable>${head}<p class="pnote">${escapeHtml(W.unavailable)}</p></div>`;
  }
  return renderOutsideHelpCard(status, { csrfToken, ...(options?.basePath === undefined ? {} : { basePath: options.basePath }) });
}

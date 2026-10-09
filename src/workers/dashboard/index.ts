/**
 * The one seam the worker calls for GET /dashboard (unified dashboard phase
 * 4, owner decision 2026-10-09: the ChatGPT panel is the only dashboard).
 *
 * - `/dashboard` is the computer's host page around the panel (host-page.ts).
 * - `?keys`, `?agents`, `?outside-help`, `?connector` are the computer's own
 *   pages, still rendered here (pages/local.ts, pages/outside-help.ts).
 * - `?panel-read` is the dashboard tool's result for a locked (dash_) reader.
 * - Every older page's address (`?source=`, `?background`, `?sensitivity`,
 *   `?setup`, `?privacy`, `?embedding-ledger`) redirects to /dashboard.
 *
 * Each page is a query parameter on /dashboard rather than a path of its own
 * because the read-only dash_ query token is allowlisted by pathname in
 * workers/http.ts: a /dashboard/<page> path would 401 for exactly the reader
 * a link was handed to.
 */
import type { SourceDashboardViewModel } from '../source-dashboard.ts';
import { DASHBOARD_OUTSIDE_HELP_QUERY_PARAM } from './outside-help.ts';
import {
  DASHBOARD_HTML_PATH,
  DASHBOARD_LOCAL_PAGES,
  DASHBOARD_PANEL_READ_QUERY_PARAM,
  dashboardHomeHref,
} from './host-page.ts';
import {
  renderDashboardAgentsPage,
  renderDashboardConnectorPage,
  renderDashboardKeysPage,
  type DashboardPageOptions,
} from './pages/local.ts';
import { renderDashboardOutsideHelpPage } from './pages/outside-help.ts';

export { DASHBOARD_HTML_PATH };

/**
 * The addresses of the pages the panel replaced. Each still answers, with a
 * redirect to /dashboard, so a bookmark or an old link lands on the panel.
 */
export const DASHBOARD_LEGACY_QUERY_PARAMS = ['source', 'background', 'sensitivity', 'setup', 'privacy', 'embedding-ledger'] as const;

export type DashboardHtmlRoutePage = 'host' | 'panel_read' | 'keys' | 'agents' | 'outside_help' | 'connector' | 'legacy';

export function isDashboardHtmlRoute(url: URL): boolean {
  return url.pathname === DASHBOARD_HTML_PATH;
}

/** Which page a /dashboard URL names. An older page's address wins, so it always redirects. */
export function dashboardHtmlRoutePage(url: URL): DashboardHtmlRoutePage {
  const params = url.searchParams;
  if (DASHBOARD_LEGACY_QUERY_PARAMS.some((param) => params.has(param))) return 'legacy';
  if (params.has(DASHBOARD_PANEL_READ_QUERY_PARAM)) return 'panel_read';
  if (params.has(DASHBOARD_LOCAL_PAGES.keys)) return 'keys';
  if (params.has(DASHBOARD_LOCAL_PAGES.agents)) return 'agents';
  if (params.has(DASHBOARD_OUTSIDE_HELP_QUERY_PARAM)) return 'outside_help';
  if (params.has(DASHBOARD_LOCAL_PAGES.connector)) return 'connector';
  return 'host';
}

/** The read-only dash_ token on this URL, if any; every link the page builds carries it. */
export function dashboardReadToken(url: URL): string | undefined {
  const token = url.searchParams.get('token');
  return token !== null && token.startsWith('dash_') ? token : undefined;
}

/** Where an older page's address goes: /dashboard, keeping a dash_ reader's token. */
export function dashboardLegacyRedirect(url: URL): string {
  return dashboardHomeHref(dashboardReadToken(url));
}

/** The computer's local pages. `view` is needed by Keys only. */
export function renderDashboardLocalPage(
  page: 'keys' | 'agents' | 'outside_help' | 'connector',
  input: { url: URL; view?: SourceDashboardViewModel; options?: DashboardPageOptions },
): string {
  const options: DashboardPageOptions = { ...input.options, basePath: dashboardHomeHref(dashboardReadToken(input.url)) };
  switch (page) {
    case 'keys':
      if (!input.view) throw new Error('Keys needs the dashboard view.');
      return renderDashboardKeysPage(input.view, options);
    case 'agents':
      return renderDashboardAgentsPage(options);
    case 'outside_help':
      return renderDashboardOutsideHelpPage(options);
    case 'connector':
      return renderDashboardConnectorPage(options);
  }
}

export type { DashboardPageOptions } from './pages/local.ts';
export {
  COMPUTER_HOST_PAGE_CSP,
  DASHBOARD_PANEL_READ_QUERY_PARAM,
  DASHBOARD_TOOLS_CALL_PATH,
  renderComputerHostPage,
} from './host-page.ts';
export { DASHBOARD_STATUS_ORDER, type DashboardStatus } from './vocabulary.ts';

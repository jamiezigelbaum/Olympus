/**
 * The one seam the worker calls: given the request URL and an already-built
 * view model, return the page's HTML.
 *
 * Detail is a query parameter on /dashboard rather than a path of its own,
 * because the read-only dash_ query token is allowlisted by pathname in
 * workers/http.ts — a /dashboard/<id> path would 401 for exactly the reader
 * this page is for. The setup and background pages keep their own
 * always-reachable addresses the same way, as ?setup and ?background.
 */
import type { SourceDashboardViewModel } from '../source-dashboard.ts';
import { escapeHtml, pageShell } from './components.ts';
import { dashboardHomeMeta, dashboardIsFirstRun } from './vocabulary.ts';
import { renderDashboardHomePage, type DashboardPageOptions } from './pages/home.ts';
import { renderDashboardDetailPage } from './pages/detail.ts';
import { renderDashboardSetupPage } from './pages/setup.ts';
import { renderDashboardBackgroundPage } from './pages/background.ts';
import { renderDashboardSensitivityPage } from './pages/sensitivity.ts';

export const DASHBOARD_HTML_PATH = '/dashboard';
/** ?source=<DashboardSourceCard.source_id> selects the detail page. */
export const DASHBOARD_DETAIL_QUERY_PARAM = 'source';
/** ?setup serves the first-run page even after sources are connected. */
export const DASHBOARD_SETUP_QUERY_PARAM = 'setup';
/** ?background serves the background lane page. Same path, same auth. */
export const DASHBOARD_BACKGROUND_QUERY_PARAM = 'background';
/** ?sensitivity serves the categories-and-tiers page. Same path, same auth. */
export const DASHBOARD_SENSITIVITY_QUERY_PARAM = 'sensitivity';

export interface DashboardHtmlRouteInput {
  url: URL;
  view: SourceDashboardViewModel;
  options?: DashboardPageOptions;
}

export interface DashboardHtmlRouteResult {
  html: string;
  /** 200, or 404 when ?source names no card on the view model. */
  status: number;
}

export function isDashboardHtmlRoute(url: URL): boolean {
  return url.pathname === DASHBOARD_HTML_PATH;
}

export function renderDashboardHtmlRoute(input: DashboardHtmlRouteInput): DashboardHtmlRouteResult {
  const { url, view } = input;
  const options = withTokenBasePath(url, input.options);
  const sourceId = url.searchParams.get(DASHBOARD_DETAIL_QUERY_PARAM);
  if (sourceId !== null) {
    const html = renderDashboardDetailPage(view, sourceId, options);
    if (html !== undefined) return { html, status: 200 };
    return { html: renderNotFound(view, options), status: 404 };
  }
  // Asked for by name, so it serves even on a first run: the lanes are the one
  // page that can say what is happening before any source finishes.
  if (url.searchParams.has(DASHBOARD_BACKGROUND_QUERY_PARAM)) {
    return { html: renderDashboardBackgroundPage(view, options), status: 200 };
  }
  // Also asked for by name, and also serves on a first run: what may read a
  // secure item is a question the owner is entitled to before they connect
  // anything.
  if (url.searchParams.has(DASHBOARD_SENSITIVITY_QUERY_PARAM)) {
    return { html: renderDashboardSensitivityPage(view, options), status: 200 };
  }
  if (url.searchParams.has(DASHBOARD_SETUP_QUERY_PARAM) || servesSetupImplicitly(view)) {
    return { html: renderDashboardSetupPage(view, options), status: 200 };
  }
  return { html: renderDashboardHomePage(view, options), status: 200 };
}

/**
 * The read-only dash_ query token is the only way a browser reaches this HTML
 * — a bearer header cannot be typed into an address bar — so every internal
 * link has to carry it or the first click dead-ends on a 401. Folding the
 * token into basePath does that in one place: detail/background/setup hrefs
 * already append with '&' when the base contains '?'.
 */
function withTokenBasePath(url: URL, options?: DashboardPageOptions): DashboardPageOptions | undefined {
  const token = url.searchParams.get('token');
  // The dash_ prefix is what workers/core/worker-auth.ts stamps on the derived
  // query token, and http.ts admits that token to GET /dashboard only — it can
  // never reach a control route. So its presence is the page's one reliable
  // signal that this reader's controls would 401, and the pages offer links
  // instead. A caller-supplied basePath (the preview harness, an embedder)
  // keeps its own path but still gets the read-only reading of the token.
  const readOnly = token !== null
    && token.startsWith('dash_')
    && options?.controlSessionCsrfToken === undefined;
  const withReadOnly = readOnly ? { ...options, readOnly: true } : options;
  if (withReadOnly?.basePath !== undefined) return withReadOnly;
  if (token === null || token === '') return withReadOnly;
  return { ...withReadOnly, basePath: `${DASHBOARD_HTML_PATH}?token=${encodeURIComponent(token)}` };
}

/**
 * The implicit first-run redirect, gated on the install actually being fresh.
 * A fleet-wide credential expiry zeroes connected_sources too (reauth_required
 * cards read as unconfigured), and that owner needs home's Needs-you section —
 * with the degraded-credential detail — not a page that greets them like a new
 * install. Explicit ?setup still serves unconditionally.
 */
function servesSetupImplicitly(view: SourceDashboardViewModel): boolean {
  if (!dashboardIsFirstRun(view)) return false;
  if (view.summary.total_indexed_items > 0) return false;
  return !view.sources.some((source) =>
    source.connection.state === 'reauth_required' || source.connection.state === 'awaiting_consent');
}

/** Calm 404: names no ids back at the reader, offers the way home. */
function renderNotFound(view: SourceDashboardViewModel, options?: DashboardPageOptions): string {
  const basePath = options?.basePath ?? DASHBOARD_HTML_PATH;
  return pageShell({
    title: 'Olympus',
    crumb: 'Not found',
    basePath,
    meta: dashboardHomeMeta(view, options),
    body: `<div class="foot">No source by that id. <a href="${escapeHtml(basePath)}">Back to the dashboard</a></div>`,
  });
}

export { renderDashboardHomePage, type DashboardPageOptions } from './pages/home.ts';
export { renderDashboardDetailPage } from './pages/detail.ts';
export { renderDashboardSetupPage } from './pages/setup.ts';
export {
  dashboardBackgroundLanes,
  renderDashboardBackgroundPage,
  type DashboardBackgroundLane,
} from './pages/background.ts';
export {
  renderDashboardSensitivityBody,
  renderDashboardSensitivityPage,
} from './pages/sensitivity.ts';
export { DASHBOARD_STATUS_ORDER, type DashboardStatus } from './vocabulary.ts';

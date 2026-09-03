/**
 * The dashboard's top nav: the three pages a reader can reach by name.
 *
 * There are exactly three destinations because there are exactly three pages
 * with a stable address of their own — /dashboard, ?background and ?setup. The
 * detail and sensitivity pages are reached FROM those, so putting them here
 * would offer a tab whose target changes meaning depending on what the reader
 * last clicked.
 *
 * The styles live in this file rather than in the shared theme: this is one
 * component with one layout, and a page that does not render the nav should not
 * carry its rules. Every colour is a theme token, so the nav follows the page
 * rather than defining a second palette.
 */
import { escapeHtml, safeHref } from './components.ts';

/** Which page is being read. One of them is always the current one. */
export type DashboardNavKey = 'home' | 'background' | 'setup';

export interface DashboardNavOptions {
  /**
   * The path prefix the reader arrived on, which carries their query token.
   *
   * A browser can only reach this HTML with the read-only dash_ token in the
   * URL, so a nav built on the bare '/dashboard' path would 401 on its own
   * first click. Defaults to '/dashboard' for a caller with no token to carry.
   */
  basePath?: string;
}

const DEFAULT_BASE_PATH = '/dashboard';

/** Duplicated from index.ts, which reaches these pages: two strings, no cycle. */
const BACKGROUND_QUERY_PARAM = 'background';
const SETUP_QUERY_PARAM = 'setup';

interface NavItem {
  key: DashboardNavKey;
  label: string;
  /** The query flag this page answers to; home is the base path itself. */
  param?: string;
}

const NAV_ITEMS: readonly NavItem[] = [
  { key: 'home', label: 'Home' },
  { key: 'background', label: 'Background', param: BACKGROUND_QUERY_PARAM },
  { key: 'setup', label: 'Setup', param: SETUP_QUERY_PARAM },
];

/**
 * A nav destination on whatever prefix carries the reader's token.
 *
 * Appends with '&' when the base already holds a query, the same way every
 * other internal link on the dashboard is built.
 */
function navHref(item: NavItem, basePath: string): string {
  if (item.param === undefined) return basePath;
  const separator = basePath.includes('?') ? '&' : '?';
  return `${basePath}${separator}${item.param}`;
}

/**
 * The nav bar, with the current page marked.
 *
 * The active item is a real `aria-current="page"` and not only a colour: a
 * reader who cannot see the highlight is still told where they are. It stays an
 * anchor rather than becoming inert text so the tab order is the same on every
 * page and a reload of the current page remains one click.
 */
export function renderDashboardNav(active: DashboardNavKey, options?: DashboardNavOptions): string {
  const basePath = safeHref(options?.basePath) ?? DEFAULT_BASE_PATH;
  const links = NAV_ITEMS.map((item) => {
    const current = item.key === active;
    const href = safeHref(navHref(item, basePath)) ?? DEFAULT_BASE_PATH;
    return `<a class="dnavlink${current ? ' on' : ''}" href="${escapeHtml(href)}"`
      + `${current ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`;
  }).join('');
  return `<nav class="dnav" aria-label="Dashboard sections">${links}</nav>`;
}

/** The nav's own layout. Only a page that renders the nav inlines this. */
export const DASHBOARD_NAV_CSS = `.top { position: sticky; top: 0; z-index: 12; background: var(--bg); padding-top: 2px; }
.dnav { position: sticky; top: 39px; z-index: 11; display: flex; gap: 4px; margin: -8px 0 22px; border-bottom: 1px solid var(--line2); background: var(--bg); }
.dnav .dnavlink { color: var(--t3); text-decoration: none; font-size: 12.5px; padding: 6px 12px 8px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.dnav .dnavlink:hover { color: var(--link); }
.dnav .dnavlink:focus-visible { outline: 1px solid var(--link); outline-offset: -2px; border-radius: 4px; }
.dnav .dnavlink.on { color: var(--t1); border-bottom-color: var(--link-line); }
`;

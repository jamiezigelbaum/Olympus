/**
 * The `ui://olympus/dashboard` MCP Apps resource (advertised content-versioned,
 * `ui://olympus/dashboard?v=<hash>`): the single path the MCP
 * surface (and the relay's offline fallback) loads the dashboard HTML from.
 * The page itself is built by the dashboard lane in
 * src/workers/dashboard/chatgpt/page.ts.
 */
import { createHash } from 'node:crypto';
import { chatgptDashboardPageHtml } from '../dashboard/chatgpt/page.ts';
import { DASHBOARD_RESOURCE_URI } from './dashboard-contract.ts';

/** MCP Apps resource MIME type (modelcontextprotocol.io MCP Apps extension). */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * ChatGPT caches an MCP Apps resource by its URI, so a changed page under the
 * same URI keeps rendering the old one. Every advertised resource URI carries
 * the first 12 hex digits of the SHA-256 of its HTML: `<base>?v=<hash>`.
 */
export function versionedResourceUri(base: string, html: string): string {
  return `${base}?v=${createHash('sha256').update(html).digest('hex').slice(0, 12)}`;
}

/**
 * Whether `uri` names the resource at `base`: the current versioned URI, the
 * bare base (tool results cached before versioning) or an older version of it
 * (results cached before the page changed). All read the current page.
 */
export function matchesResourceUri(uri: string, base: string): boolean {
  return uri === base || (uri.startsWith(`${base}?v=`) && /^[0-9a-f]{12}$/.test(uri.slice(base.length + 3)));
}

/** The dashboard page, rendered once: it takes no per-request input. */
const DASHBOARD_HTML = chatgptDashboardPageHtml();

/** The dashboard's advertised URI: resources/list, resources/read and tool `_meta`. */
export const DASHBOARD_RESOURCE_VERSIONED_URI = versionedResourceUri(DASHBOARD_RESOURCE_URI, DASHBOARD_HTML);

export const DASHBOARD_RESOURCE = {
  uri: DASHBOARD_RESOURCE_VERSIONED_URI,
  name: 'Olympus dashboard',
  mimeType: MCP_APP_MIME_TYPE,
} as const;

/**
 * The plugin's dedicated UI origin (`_meta.ui.domain`): a full origin, unique
 * per plugin, required for submission with UI. See
 * developers.openai.com/plugins/reference.
 */
export const DASHBOARD_UI_DOMAIN = 'https://mcp.olympusplugin.ai';

/**
 * Where the dashboard may send the person with `openExternal`: one-time
 * sign-in links (`https://mcp.olympusplugin.ai/go/<id>`, which redirect to the
 * provider) and the help and install pages. Provider domains are never listed:
 * every sign-in starts on the plugin's own domain.
 */
export const DASHBOARD_REDIRECT_DOMAINS = [DASHBOARD_UI_DOMAIN, 'https://olympusplugin.ai'] as const;

/** `_meta` on the resource contents: no external fetch origins, fullscreen preferred. */
export function dashboardResourceMeta(): Record<string, unknown> {
  return {
    ui: { csp: { connectDomains: [], resourceDomains: [] }, domain: DASHBOARD_UI_DOMAIN, prefersBorder: false },
    // ChatGPT's own CSP key: openExternal needs redirect_domains.
    'openai/widgetCSP': { connect_domains: [], resource_domains: [], redirect_domains: [...DASHBOARD_REDIRECT_DOMAINS] },
    'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] },
  };
}

export function dashboardResourceHtml(): string {
  return DASHBOARD_HTML;
}

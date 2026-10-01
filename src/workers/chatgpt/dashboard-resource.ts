/**
 * The `ui://olympus/dashboard` MCP Apps resource: the single path the MCP
 * surface (and the relay's offline fallback) loads the dashboard HTML from.
 * The page itself is built by the dashboard lane in
 * src/workers/dashboard/chatgpt/page.ts.
 */
import { chatgptDashboardPageHtml } from '../dashboard/chatgpt/page.ts';
import { DASHBOARD_RESOURCE_URI } from './dashboard-contract.ts';

/** MCP Apps resource MIME type (modelcontextprotocol.io MCP Apps extension). */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export const DASHBOARD_RESOURCE = {
  uri: DASHBOARD_RESOURCE_URI,
  name: 'Olympus dashboard',
  mimeType: MCP_APP_MIME_TYPE,
} as const;

/**
 * The plugin's dedicated UI origin (`_meta.ui.domain`): a full origin, unique
 * per plugin, required for submission with UI. See
 * developers.openai.com/plugins/reference.
 */
export const DASHBOARD_UI_DOMAIN = 'https://mcp.olympusplugin.ai';

/** `_meta` on the resource contents: no external origins, fullscreen preferred. */
export function dashboardResourceMeta(): Record<string, unknown> {
  return {
    ui: { csp: { connectDomains: [], resourceDomains: [] }, domain: DASHBOARD_UI_DOMAIN, prefersBorder: false },
    'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] },
  };
}

export function dashboardResourceHtml(): string {
  return chatgptDashboardPageHtml();
}

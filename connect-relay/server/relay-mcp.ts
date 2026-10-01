/**
 * The MCP answers the relay gives itself, without reaching any engine:
 *
 * - `not_installed`: a caller with no bearer token (ChatGPT before the owner
 *   connects Olympus, or a directory reviewer). The dashboard tool shows
 *   "Install Olympus"; any other tool returns an error carrying
 *   `_meta["mcp/www_authenticate"]`, which starts ChatGPT's account linking.
 * - `mac_offline`: a routable credential for a registered install whose Mac
 *   has no live session. The dashboard tool shows when it was last seen; any
 *   other tool returns a plain "Your Mac is offline" error. The relay cannot
 *   check the credential (only the engine can), so nothing here reveals more
 *   than "this install exists and was last seen at about this minute".
 *
 * Both answer `initialize`, `tools/list`, `resources/list` and
 * `resources/read` of the dashboard resource. Tool auth follows ChatGPT's
 * per-tool `securitySchemes` (developers.openai.com/plugins/build/auth): the
 * dashboard tool works without auth and better with it; the engine declares
 * its own tools.
 */
import { DASHBOARD_RESOURCE_URI, DASHBOARD_TOOL_NAME, notInstalledDashboard, offlineDashboard } from '../shared/dashboard-contract.ts';
import { OFFLINE_DASHBOARD_HTML } from './offline-ui.ts';

/** Newest first; an `initialize` asking for one of these gets it back. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const MAC_OFFLINE_MESSAGE = 'Your Mac is offline. Olympus answers again when your Mac is awake and online.';
export const NOT_CONNECTED_MESSAGE = 'Olympus is not connected yet. Install Olympus on your Mac, then connect it to ChatGPT.';

export const DASHBOARD_TOOL = {
  name: DASHBOARD_TOOL_NAME,
  title: 'Olympus dashboard',
  description: 'Show the Olympus dashboard: whether your Mac is connected, your sources, and anything that needs you.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  securitySchemes: [{ type: 'noauth' }, { type: 'oauth2', scopes: [] }],
  _meta: { 'openai/outputTemplate': DASHBOARD_RESOURCE_URI, ui: { resourceUri: DASHBOARD_RESOURCE_URI } },
};

export type RelayMcpState =
  | { state: 'not_installed'; installUrl: string; protectedResourceMetadataUrl: string }
  | { state: 'mac_offline'; lastSeenAt: number | undefined };

type JsonRpcId = string | number;

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: JsonRpcId | null, code: number, message: string): Response {
  return json({ jsonrpc: '2.0', id, error: { code, message } });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function relayMcpResponse(input: { method: string; body: string; now: number } & RelayMcpState): Response {
  if (input.method !== 'POST') {
    // No standalone SSE stream or session to end without an engine.
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  let message: unknown;
  try {
    message = JSON.parse(input.body);
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return rpcError(null, -32600, 'Invalid request');
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof method !== 'string') return rpcError(null, -32600, 'Invalid request');
  // Notifications (and responses) carry no id and get no body.
  if (id === undefined) return new Response(null, { status: 202 });
  if (typeof id !== 'string' && typeof id !== 'number') return rpcError(null, -32600, 'Invalid request');
  const args = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  const notice = input.state === 'mac_offline' ? MAC_OFFLINE_MESSAGE : NOT_CONNECTED_MESSAGE;

  switch (method) {
    case 'initialize': {
      const requested = typeof args.protocolVersion === 'string' ? args.protocolVersion : '';
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'olympus', version: 'relay' },
        instructions: notice,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: [DASHBOARD_TOOL] });
    case 'resources/list':
      return rpcResult(id, { resources: [{ uri: DASHBOARD_RESOURCE_URI, name: 'Olympus dashboard', mimeType: MCP_APP_MIME_TYPE }] });
    case 'resources/read':
      if (args.uri !== DASHBOARD_RESOURCE_URI) return rpcError(id, -32002, 'Resource not found');
      return rpcResult(id, { contents: [{ uri: DASHBOARD_RESOURCE_URI, mimeType: MCP_APP_MIME_TYPE, text: OFFLINE_DASHBOARD_HTML }] });
    case 'tools/call':
      if (args.name === DASHBOARD_TOOL_NAME) {
        return rpcResult(id, {
          content: [{ type: 'text', text: notice }],
          structuredContent: input.state === 'mac_offline'
            ? offlineDashboard(input.lastSeenAt, input.now)
            : notInstalledDashboard(input.installUrl, input.now),
        });
      }
      if (input.state === 'mac_offline') return rpcError(id, -32000, MAC_OFFLINE_MESSAGE);
      // Any engine tool without a token: ask ChatGPT to link the account.
      return rpcResult(id, {
        content: [{ type: 'text', text: NOT_CONNECTED_MESSAGE }],
        isError: true,
        _meta: {
          'mcp/www_authenticate': [
            `Bearer resource_metadata="${input.protectedResourceMetadataUrl}", error="invalid_token", error_description="Connect Olympus on your Mac to use this tool."`,
          ],
        },
      });
    default:
      return rpcError(id, -32601, 'Method not found');
  }
}

/**
 * Whether a JSON-RPC body is a call of the dashboard tool: those calls may use
 * the install's reserved concurrency slot, so the owner can always see why
 * their Mac is busy.
 */
export function isDashboardCall(body: string): boolean {
  if (body.length > 4096 || !body.includes(DASHBOARD_TOOL_NAME)) return false;
  try {
    const message = JSON.parse(body) as { method?: unknown; params?: { name?: unknown } };
    return message.method === 'tools/call' && message.params?.name === DASHBOARD_TOOL_NAME;
  } catch {
    return false;
  }
}

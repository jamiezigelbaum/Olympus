/**
 * The relay's own MCP answers for an install whose Mac has no live session.
 *
 * A request carrying a routable credential for a registered install arrives
 * while that install is offline: rather than an opaque error, the relay
 * answers the few MCP calls that let ChatGPT show the owner what is going on
 * (`initialize`, `tools/list`, the dashboard resource and the dashboard tool,
 * with `connection.state = "mac_offline"`). Every other tool gets a plain
 * "Your Mac is offline" error. The relay cannot check the credential (only
 * the engine can), so nothing here reveals more than "this install exists
 * and was last seen at about this minute".
 */
import { DASHBOARD_RESOURCE_URI, DASHBOARD_TOOL_NAME, offlineDashboard } from '../shared/dashboard-contract.ts';
import { OFFLINE_DASHBOARD_HTML } from './offline-ui.ts';

/** Newest first; an `initialize` asking for one of these gets it back. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const MAC_OFFLINE_MESSAGE = 'Your Mac is offline. Olympus answers again when your Mac is awake and online.';

const DASHBOARD_TOOL = {
  name: DASHBOARD_TOOL_NAME,
  title: 'Olympus dashboard',
  description: 'Show the Olympus dashboard: whether your Mac is connected, your sources, and anything that needs you.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { 'openai/outputTemplate': DASHBOARD_RESOURCE_URI, ui: { resourceUri: DASHBOARD_RESOURCE_URI } },
};

type JsonRpcId = string | number;

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return json(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: JsonRpcId | null, code: number, message: string): Response {
  return json(200, { jsonrpc: '2.0', id, error: { code, message } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function offlineMcpResponse(input: { method: string; body: string; lastSeenAt: number | undefined; now: number }): Response {
  if (input.method !== 'POST') {
    // No standalone SSE stream or session to end while the Mac is away.
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

  switch (method) {
    case 'initialize': {
      const requested = typeof args.protocolVersion === 'string' ? args.protocolVersion : '';
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'olympus', version: 'relay-offline' },
        instructions: MAC_OFFLINE_MESSAGE,
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
      if (args.name !== DASHBOARD_TOOL_NAME) return rpcError(id, -32000, MAC_OFFLINE_MESSAGE);
      return rpcResult(id, {
        content: [{ type: 'text', text: MAC_OFFLINE_MESSAGE }],
        structuredContent: offlineDashboard(input.lastSeenAt, input.now),
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

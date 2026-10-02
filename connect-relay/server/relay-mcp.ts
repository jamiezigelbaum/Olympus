/**
 * The MCP answers the relay gives itself, without reaching any engine:
 *
 * - `not_connected`: a caller with no bearer token (ChatGPT before the owner
 *   connects Olympus, or a directory reviewer). The relay cannot tell whether
 *   Olympus is on that owner's Mac, so the dashboard tool offers Connect (with
 *   the install link beside it); every tool, the dashboard included, carries
 *   `_meta["mcp/www_authenticate"]`, which starts ChatGPT's account linking.
 *   Other tools also return an error.
 * - `mac_offline`: a routable credential for a registered install whose Mac
 *   has no live session. The dashboard tool shows when it was last seen; any
 *   other tool returns a plain "Your Mac is offline" error. The relay cannot
 *   check the credential (only the engine can), so nothing here reveals more
 *   than "this install exists and was last seen at about this minute".
 *
 * Both list the engine's full ChatGPT tool set and serve the engine's own
 * dashboard bundle, from files scripts/build-chatgpt-relay-assets.ts generates
 * out of src/workers/chatgpt (the relay builds separately and imports nothing
 * from src). Tool auth follows ChatGPT's per-tool `securitySchemes`
 * (developers.openai.com/plugins/build/auth): listing the protected tools to a
 * caller with no token is what lets ChatGPT's model pick one, and that tool's
 * `mcp/www_authenticate` error is the documented trigger for linking.
 */
import { DASHBOARD_RESOURCE_URI, DASHBOARD_TOOL_NAME, notConnectedDashboard, offlineDashboard } from '../shared/dashboard-contract.ts';
import DASHBOARD_RESOURCE_READ from './generated/chatgpt-dashboard.json';
import PRIVATE_ANSWER_RESOURCE_READ from './generated/chatgpt-private-answer.json';
import CHATGPT_SURFACE from './generated/chatgpt-tools.json';

/** Newest first; an `initialize` asking for one of these gets it back. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MAC_OFFLINE_MESSAGE = 'Your Mac is offline. Olympus answers again when your Mac is awake and online.';
export const NOT_CONNECTED_MESSAGE = 'Olympus is not connected to ChatGPT yet. If Olympus is on your Mac, connect it; otherwise install it first.';

/** The engine's ChatGPT tools, exactly as its tools/list declares them. */
export const CHATGPT_TOOLS = CHATGPT_SURFACE.tools;
/** The engine's resources/list. */
export const CHATGPT_RESOURCES = CHATGPT_SURFACE.resources;
/** The engine's resources/read of ui://olympus/dashboard: the dashboard lane's real bundle. */
export const DASHBOARD_RESOURCE_CONTENTS = DASHBOARD_RESOURCE_READ.contents;
/**
 * The engine's resources/read of ui://olympus/private-answer. Served offline
 * too, so a rendered panel loads; its fetch then gets the relay's
 * `mac_offline` answer (relay.ts, `/private/<id>`).
 */
export const PRIVATE_ANSWER_RESOURCE_URI = 'ui://olympus/private-answer';
export const PRIVATE_ANSWER_RESOURCE_CONTENTS = PRIVATE_ANSWER_RESOURCE_READ.contents;

export const DASHBOARD_TOOL = CHATGPT_TOOLS.find((tool) => tool.name === DASHBOARD_TOOL_NAME)!;
if (!DASHBOARD_TOOL) throw new Error('generated ChatGPT tool manifest has no dashboard tool');

export type RelayMcpState =
  | { state: 'not_connected'; installUrl: string; protectedResourceMetadataUrl: string }
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
      return rpcResult(id, { tools: CHATGPT_TOOLS });
    case 'resources/list':
      return rpcResult(id, { resources: CHATGPT_RESOURCES });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    case 'resources/read': {
      // The engine advertises content-versioned URIs (`<base>?v=<12 hex>`);
      // any version, or the bare URI, reads the bundle this relay carries.
      const base = resourceBaseUri(args.uri);
      if (base === PRIVATE_ANSWER_RESOURCE_URI) return rpcResult(id, { contents: PRIVATE_ANSWER_RESOURCE_CONTENTS });
      if (base !== DASHBOARD_RESOURCE_URI) return rpcError(id, -32002, 'Resource not found');
      return rpcResult(id, { contents: DASHBOARD_RESOURCE_CONTENTS });
    }
    case 'tools/call': {
      if (args.name === DASHBOARD_TOOL_NAME) {
        // The page renders only from structuredContent, so the dashboard
        // result always carries it, with the tool's own UI metadata. Without
        // a token it also carries the linking challenge, so ChatGPT offers
        // Connect beside the rendered "not connected" dashboard.
        if (input.state === 'mac_offline') {
          return rpcResult(id, {
            content: [{ type: 'text', text: notice }],
            structuredContent: offlineDashboard(input.lastSeenAt, input.now),
            _meta: DASHBOARD_TOOL._meta,
          });
        }
        return rpcResult(id, {
          content: [{ type: 'text', text: notice }],
          structuredContent: notConnectedDashboard(input.installUrl, input.now),
          _meta: { ...DASHBOARD_TOOL._meta, ...linkingChallenge(input.protectedResourceMetadataUrl) },
        });
      }
      if (input.state === 'mac_offline') return rpcError(id, -32000, MAC_OFFLINE_MESSAGE);
      // Any engine tool without a token: ask ChatGPT to link the account.
      return rpcResult(id, {
        content: [{ type: 'text', text: NOT_CONNECTED_MESSAGE }],
        isError: true,
        _meta: linkingChallenge(input.protectedResourceMetadataUrl),
      });
    }
    default:
      return rpcError(id, -32601, 'Method not found');
  }
}

/** ChatGPT's documented account-linking trigger, the same for every tool. */
function linkingChallenge(protectedResourceMetadataUrl: string): { 'mcp/www_authenticate': string[] } {
  return {
    'mcp/www_authenticate': [
      `Bearer resource_metadata="${protectedResourceMetadataUrl}", error="invalid_token", error_description="Connect Olympus on your Mac to use this tool."`,
    ],
  };
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

/** A resource URI without its `?v=<12 hex>` content version; undefined for anything else. */
function resourceBaseUri(uri: unknown): string | undefined {
  if (typeof uri !== 'string') return undefined;
  const match = /^(ui:\/\/olympus\/[a-z-]+)(?:\?v=[0-9a-f]{12})?$/.exec(uri);
  return match?.[1];
}

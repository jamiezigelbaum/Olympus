/**
 * What an MCP request was, for the one log line the engine
 * (src/workers/remote-mcp.ts) and the connect relay (server/relay.ts) each
 * write per request: method names from a fixed list and Olympus tool names,
 * never client-written text.
 */
/** The MCP methods a log line may name; any other method is logged as `?`. */
const LOGGED_RPC_METHODS: ReadonlySet<string> = new Set([
  'initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read',
  'prompts/list', 'prompts/get', 'completion/complete', 'logging/setLevel',
  'notifications/initialized', 'notifications/cancelled', 'notifications/progress', 'notifications/roots/list_changed',
]);

/** Olympus's own tool-name shapes; any other name is logged as `?`. */
const LOGGED_TOOL_NAME = /^(?:olympus|source|ask)_[a-z_]{1,48}$/;

/**
 * The JSON-RPC methods a body carries, a tool call as `tools/call:<name>`,
 * each only from a fixed list or shape (anything else is `?`), so no
 * client-written text reaches the journal. At most 8.
 */
export function rpcCallNames(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.slice(0, 8).map((message) => {
    const { method, params } = (message && typeof message === 'object' ? message : {}) as { method?: unknown; params?: { name?: unknown } };
    if (typeof method !== 'string' || !LOGGED_RPC_METHODS.has(method)) return '?';
    if (method !== 'tools/call') return method;
    return `${method}:${typeof params?.name === 'string' && LOGGED_TOOL_NAME.test(params.name) ? params.name : '?'}`;
  });
}

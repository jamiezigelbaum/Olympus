/**
 * A loopback MCP endpoint for agents that run on the harness's own computer
 * (the subscription command-line agents) while the engine they ask lives on
 * the machine under test. Each JSON-RPC message an agent posts is handed to a
 * relay, which carries it to the engine's own MCP endpoint through the
 * driver's exec channel, and the engine's answer comes back unchanged. The
 * proxy is a tunnel, not an MCP server: it adds no tools and filters nothing.
 *
 * It also records every exchange, because what the engine returned is exactly
 * what the agent saw, and the leak checks scan that text rather than trusting
 * the agent's own account of it.
 */
import { randomBytes } from 'node:crypto';

export interface RelayRequest {
  sid?: string;
  body: string;
}

export interface RelayResponse {
  status: number;
  sid?: string | null;
  contentType: string;
  text: string;
}

export type Relay = (request: RelayRequest) => Promise<RelayResponse>;

export interface McpExchange {
  method: string;
  tool?: string;
  args?: unknown;
  status: number;
  /** The engine's reply text for a tool call (its content parts joined). */
  outputText: string;
  structured?: unknown;
  isError: boolean;
}

export interface McpProxy {
  /** The URL to hand an agent, with a per-proxy secret path segment. */
  url: string;
  exchanges: McpExchange[];
  stop(): void;
}

/** A JSON-RPC reply that arrived as plain JSON or as one server-sent-event frame. */
export function parseRpcBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
    const data = trimmed.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).pop();
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

function exchangeOf(request: unknown, response: RelayResponse): McpExchange | undefined {
  const message = request as { method?: string; params?: { name?: string; arguments?: unknown } };
  if (typeof message?.method !== 'string') return undefined;
  const reply = parseRpcBody(response.text);
  const result = reply?.result as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean } | undefined;
  const text = (result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
  return {
    method: message.method,
    ...(message.method === 'tools/call' ? { tool: message.params?.name ?? '', args: message.params?.arguments ?? {} } : {}),
    status: response.status,
    outputText: message.method === 'tools/call' ? text : '',
    ...(result?.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
    isError: result?.isError === true || Boolean(reply?.error),
  };
}

/**
 * A relay that answers the protocol's static messages from a copy fetched once
 * from the engine, and passes every other message (above all tools/call)
 * through unchanged. Each real round trip to the machine takes seconds, and
 * some agents (Codex) build their first turn from whatever tools have loaded
 * by then, so an agent that waits on three slow startup messages quietly runs
 * without the tool. The copy is the engine's own initialize and tools/list
 * reply for this run, with only the request id rewritten.
 */
export function cachingRelay(relay: Relay): { relay: Relay; prime(): Promise<boolean> } {
  const cached = new Map<string, RelayResponse>();
  const message = (id: number | undefined, method: string, params?: unknown): string => JSON.stringify({
    jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }),
  });
  return {
    async prime() {
      const init = await relay({ body: message(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-check', version: '1' } }) });
      if (init.status !== 200 || parseRpcBody(init.text)?.result === undefined) return false;
      const sid = init.sid ?? undefined;
      await relay({ body: message(undefined, 'notifications/initialized'), ...(sid ? { sid } : {}) });
      const list = await relay({ body: message(2, 'tools/list'), ...(sid ? { sid } : {}) });
      if (list.status !== 200 || parseRpcBody(list.text)?.result === undefined) return false;
      cached.set('initialize', init);
      cached.set('tools/list', list);
      return true;
    },
    relay: async (request) => {
      let parsed: { id?: unknown; method?: unknown } | undefined;
      try { parsed = JSON.parse(request.body) as { id?: unknown; method?: unknown }; } catch { return await relay(request); }
      if (Array.isArray(parsed) || typeof parsed?.method !== 'string') return await relay(request);
      if (parsed.method.startsWith('notifications/')) return { status: 202, contentType: 'application/json', text: '' };
      const hit = cached.get(parsed.method);
      if (!hit || parsed.id === undefined) return await relay(request);
      const reply = parseRpcBody(hit.text) as Record<string, unknown>;
      return { ...hit, contentType: 'application/json', text: JSON.stringify({ ...reply, id: parsed.id }) };
    },
  };
}

export function startMcpProxy(relay: Relay): McpProxy {
  const secret = randomBytes(12).toString('hex');
  const path = `/mcp/${secret}`;
  const exchanges: McpExchange[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== path) return new Response('not found', { status: 404 });
      // No server-initiated stream and no session teardown: both are optional in the transport.
      if (request.method === 'GET') return new Response('method not allowed', { status: 405 });
      if (request.method === 'DELETE') return new Response(null, { status: 200 });
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const body = await request.text();
      const sid = request.headers.get('mcp-session-id') ?? undefined;
      let reply: RelayResponse;
      try {
        reply = await relay({ body, ...(sid ? { sid } : {}) });
      } catch {
        return new Response('the machine did not answer', { status: 502 });
      }
      try {
        const parsed = JSON.parse(body) as unknown;
        for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
          const exchange = exchangeOf(message, reply);
          if (exchange) exchanges.push(exchange);
        }
      } catch { /* a body that is not JSON is the engine's to refuse */ }
      const headers: Record<string, string> = { 'content-type': reply.contentType };
      if (reply.sid) headers['mcp-session-id'] = reply.sid;
      return new Response(reply.status === 202 || reply.text === '' ? null : reply.text, { status: reply.status, headers });
    },
  });
  return { url: `http://127.0.0.1:${server.port}${path}`, exchanges, stop: () => { void server.stop(true); } };
}

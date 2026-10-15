// The loopback MCP tunnel the command-line agents talk to: it relays unchanged and records what the engine returned.

import { afterEach, describe, expect, test } from 'bun:test';
import { cachingRelay, parseRpcBody, startMcpProxy, type McpProxy, type RelayRequest } from '../scripts/release-check/mcp-proxy.ts';

let proxy: McpProxy | undefined;
afterEach(() => { proxy?.stop(); proxy = undefined; });

const toolResult = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text }], ...extra } });

describe('MCP proxy', () => {
  test('relays each message unchanged and records tool calls with what came back', async () => {
    const seen: RelayRequest[] = [];
    proxy = startMcpProxy(async (request) => {
      seen.push(request);
      const method = (JSON.parse(request.body) as { method: string }).method;
      if (method === 'initialize') return { status: 200, sid: 'session-1', contentType: 'application/json', text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) };
      return { status: 200, contentType: 'text/event-stream', text: `event: message\ndata: ${toolResult('Evidence [E1]', { structuredContent: { evidence: [] } })}\n\n` };
    });

    const init = await fetch(proxy.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBe('session-1');

    const call = await fetch(proxy.url, {
      method: 'POST',
      headers: { 'mcp-session-id': 'session-1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'olympus_search', arguments: { query: 'club' } } }),
    });
    expect(await call.text()).toContain('Evidence [E1]');
    expect(seen[1]?.sid).toBe('session-1');
    expect(proxy.exchanges.map((e) => e.method)).toEqual(['initialize', 'tools/call']);
    expect(proxy.exchanges[1]).toMatchObject({ tool: 'olympus_search', args: { query: 'club' }, status: 200, outputText: 'Evidence [E1]', structured: { evidence: [] }, isError: false });
  });

  test('only its own secret path answers, and only POST carries messages', async () => {
    proxy = startMcpProxy(async () => ({ status: 200, contentType: 'application/json', text: '{}' }));
    const origin = new URL(proxy.url).origin;
    expect((await fetch(`${origin}/mcp/wrong`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(proxy.url, { method: 'GET' })).status).toBe(405);
    expect((await fetch(proxy.url, { method: 'DELETE' })).status).toBe(200);
  });

  test('an unreachable machine becomes a 502, and an error reply is recorded as an error', async () => {
    let fail = true;
    proxy = startMcpProxy(async () => {
      if (fail) throw new Error('driver exec failed');
      return { status: 200, contentType: 'application/json', text: JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'no' } }) };
    });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x', arguments: {} } });
    expect((await fetch(proxy.url, { method: 'POST', body })).status).toBe(502);
    expect(proxy.exchanges).toHaveLength(0);
    fail = false;
    await fetch(proxy.url, { method: 'POST', body });
    expect(proxy.exchanges[0]?.isError).toBe(true);
  });

  test('parses plain JSON and one server-sent-event frame, and tolerates anything else', () => {
    expect(parseRpcBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseRpcBody('event: message\ndata: {"a":2}\n\n')).toEqual({ a: 2 });
    expect(parseRpcBody('')).toEqual({});
    expect(parseRpcBody('data: not json')).toEqual({});
  });
});

describe('caching relay', () => {
  const init = { status: 200, contentType: 'application/json', text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'engine' } } }) };
  const list = { status: 200, contentType: 'text/event-stream', text: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'olympus_search' }] } })}\n\n` };

  function engine() {
    const seen: string[] = [];
    const relay = async ({ body }: { body: string }) => {
      const message = JSON.parse(body) as { method: string; id?: number };
      seen.push(message.method);
      if (message.method === 'initialize') return init;
      if (message.method === 'tools/list') return list;
      if (message.method === 'tools/call') return { status: 200, contentType: 'application/json', text: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'real answer' }] } }) };
      return { status: 202, contentType: 'application/json', text: '' };
    };
    return { relay, seen };
  }

  test('serves initialize and tools/list from one fetched copy and relays everything else', async () => {
    const { relay, seen } = engine();
    const tunnel = cachingRelay(relay);
    expect(await tunnel.prime()).toBe(true);
    expect(seen).toEqual(['initialize', 'notifications/initialized', 'tools/list']);

    const initReply = await tunnel.relay({ body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) });
    expect(JSON.parse(initReply.text)).toMatchObject({ id: 0, result: { serverInfo: { name: 'engine' } } });
    const listReply = await tunnel.relay({ body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) });
    expect(listReply.contentType).toBe('application/json');
    expect(JSON.parse(listReply.text)).toEqual({ jsonrpc: '2.0', id: 7, result: { tools: [{ name: 'olympus_search' }] } });
    expect((await tunnel.relay({ body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status).toBe(202);
    // None of that reached the engine again.
    expect(seen).toHaveLength(3);

    const call = await tunnel.relay({ body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'olympus_search' } }) });
    expect(JSON.parse(call.text).result.content[0].text).toBe('real answer');
    expect(seen).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  });

  test('when priming fails, nothing is cached and every message is relayed', async () => {
    const seen: string[] = [];
    const tunnel = cachingRelay(async ({ body }) => {
      seen.push((JSON.parse(body) as { method: string }).method);
      return { status: 502, contentType: 'text/plain', text: 'down' };
    });
    expect(await tunnel.prime()).toBe(false);
    await tunnel.relay({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(seen).toEqual(['initialize', 'tools/list']);
  });
});

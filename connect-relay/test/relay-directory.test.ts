/**
 * The ChatGPT plugin directory's endpoint on the relay (`/openai/mcp`,
 * shared/directory-tools.ts): the relay's own answers narrowed to the
 * allowlist, its own protected-resource document and 401 pointer, the
 * dashboard callable without a token, routing to the install unchanged, and
 * `/mcp` exactly as before.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient, type RelayClientStatus } from '../client/relay-client.ts';
import { forwardPath, FORWARDED_PATHS } from '../client/forward.ts';
import { loadOrCreateIdentity } from '../client/identity.ts';
import { base64url } from '../shared/protocol.ts';
import { DIRECTORY_MCP_PATH, DIRECTORY_TOOL_NAMES, toolsForSurface } from '../shared/directory-tools.ts';
import { mintCredential } from '../shared/tokens.ts';
import { MemoryInstallRegistry } from '../server/registry.ts';
import { NOT_CONNECTED_MESSAGE, relayMcpResponse } from '../server/relay-mcp.ts';
import { startRelay, type RelayHandle } from '../server/relay.ts';
import generatedDashboard from '../server/generated/chatgpt-dashboard.json';
import generatedPrivateAnswer from '../server/generated/chatgpt-private-answer.json';
import generatedSurface from '../server/generated/chatgpt-tools.json';

setDefaultTimeout(15_000);

const PUBLIC_HOST = 'mcp.olympus.test';
const DIRECTORY_METADATA = `https://${PUBLIC_HOST}/.well-known/oauth-protected-resource/openai/mcp`;
const MCP_METADATA = `https://${PUBLIC_HOST}/.well-known/oauth-protected-resource/mcp`;
const challengeFor = (metadata: string) => [
  `Bearer resource_metadata="${metadata}", error="invalid_token", error_description="Connect Olympus on your Mac to use this tool."`,
];

const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function makeRelay(): Promise<RelayHandle> {
  const relay = await startRelay({ publicHost: PUBLIC_HOST, registry: new MemoryInstallRegistry(), listen: { host: '127.0.0.1', port: 0 } });
  cleanups.push(() => relay.close());
  return relay;
}

/** A loopback worker stand-in that answers every path with what reached it. */
function fakeWorker(): { url: string; paths: string[] } {
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return Response.json({ path });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, paths };
}

async function connectInstall(relay: RelayHandle, target: string, forwardedPaths?: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-directory-'));
  dirs.push(dir);
  const identity = loadOrCreateIdentity(dir);
  const statuses: RelayClientStatus[] = [];
  const client = new RelayClient({
    relayHost: PUBLIC_HOST,
    relayUrl: `ws://127.0.0.1:${relay.port}/v2/connect`,
    identity,
    target,
    relaySecret: base64url(crypto.getRandomValues(new Uint8Array(32))),
    heartbeatMs: 500,
    backoff: { minMs: 50, maxMs: 200 },
    onStatus: (status) => statuses.push(status),
    ...(forwardedPaths ? { forwardedPaths } : {}),
  });
  client.start();
  cleanups.push(() => client.stop());
  const deadline = Date.now() + 5_000;
  while (statuses.at(-1)?.state !== 'online') {
    if (Date.now() > deadline) throw new Error('install did not come online');
    await Bun.sleep(10);
  }
  return { client, identity };
}

const rpc = (method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

function post(relay: RelayHandle, path: string, body: string, token?: string): Promise<Response> {
  return fetch(`${relay.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  });
}

describe('the relay\'s own answers on /openai/mcp', () => {
  test('a newly generated tool is listed on /mcp and not on /openai/mcp', () => {
    const future = [...generatedSurface.tools, { ...generatedSurface.tools[1]!, name: 'olympus_future_tool' }];
    expect(toolsForSurface(future, 'default').map((tool) => tool.name)).toContain('olympus_future_tool');
    expect(toolsForSurface(future, 'directory').map((tool) => tool.name)).toEqual([...DIRECTORY_TOOL_NAMES]);
    // The relay narrows the generated manifest the same way; today it is the whole list.
    const listed = (surface: 'default' | 'directory') => relayMcpResponse({
      method: 'POST', body: rpc('tools/list'), now: 0, surface,
      state: 'not_connected', installUrl: 'https://example.test/install', protectedResourceMetadataUrl: DIRECTORY_METADATA,
    }).json() as Promise<{ result: { tools: Array<{ name: string }> } }>;
    return Promise.all([listed('default'), listed('directory')]).then(([all, directory]) => {
      expect(all.result.tools).toEqual(generatedSurface.tools);
      expect(directory.result.tools).toEqual(toolsForSurface(generatedSurface.tools, 'directory'));
      expect(directory.result.tools.map((tool) => tool.name)).toEqual([...DIRECTORY_TOOL_NAMES]);
    });
  });

  test('without a token: the narrowed list, widgets, and a noauth dashboard whose challenge names the directory resource', async () => {
    const relay = await makeRelay();
    const list = await (await post(relay, DIRECTORY_MCP_PATH, rpc('tools/list'))).json();
    expect(list.result.tools).toEqual(toolsForSurface(generatedSurface.tools, 'directory'));
    const dashboardTool = list.result.tools.find((tool: { name: string }) => tool.name === 'olympus_dashboard');
    expect(dashboardTool.securitySchemes).toEqual([{ type: 'noauth' }, { type: 'oauth2', scopes: [] }]);

    const resources = await (await post(relay, DIRECTORY_MCP_PATH, rpc('resources/list'))).json();
    expect(resources.result.resources).toEqual(generatedSurface.resources);
    const panel = await (await post(relay, DIRECTORY_MCP_PATH, rpc('resources/read', { uri: 'ui://olympus/private-answer' }))).json();
    expect(panel.result.contents).toEqual(generatedPrivateAnswer.contents);
    const page = await (await post(relay, DIRECTORY_MCP_PATH, rpc('resources/read', { uri: 'ui://olympus/dashboard' }))).json();
    expect(page.result.contents).toEqual(generatedDashboard.contents);

    const dashboard = await (await post(relay, DIRECTORY_MCP_PATH, rpc('tools/call', { name: 'olympus_dashboard', arguments: {} }))).json();
    expect(dashboard.result.isError).toBeUndefined();
    expect(dashboard.result.structuredContent).toMatchObject({ connection: { state: 'not_connected' } });
    expect(dashboard.result.content).toEqual([{ type: 'text', text: NOT_CONNECTED_MESSAGE }]);
    expect(dashboard.result._meta['mcp/www_authenticate']).toEqual(challengeFor(DIRECTORY_METADATA));
    const answer = await (await post(relay, DIRECTORY_MCP_PATH, rpc('tools/call', { name: 'source_answer', arguments: {} }))).json();
    expect(answer.result.isError).toBe(true);
    expect(answer.result._meta['mcp/www_authenticate']).toEqual(challengeFor(DIRECTORY_METADATA));

    // /mcp is unchanged: its own challenge, the full list.
    const onMcp = await (await post(relay, '/mcp', rpc('tools/call', { name: 'olympus_dashboard', arguments: {} }))).json();
    expect(onMcp.result._meta['mcp/www_authenticate']).toEqual(challengeFor(MCP_METADATA));
    expect((await (await post(relay, '/mcp', rpc('tools/list'))).json()).result.tools).toEqual(generatedSurface.tools);
  });

  test('its own protected-resource document, same authorization server; a 401 points at it', async () => {
    const relay = await makeRelay();
    const prm = await (await fetch(`${relay.url}/.well-known/oauth-protected-resource/openai/mcp`)).json();
    expect(prm).toEqual({
      resource: `https://${PUBLIC_HOST}/openai/mcp`,
      authorization_servers: [`https://${PUBLIC_HOST}`],
      bearer_methods_supported: ['header'],
      resource_name: 'Olympus',
    });
    const mcp = await (await fetch(`${relay.url}/.well-known/oauth-protected-resource/mcp`)).json() as { resource: string };
    expect(mcp.resource).toBe(`https://${PUBLIC_HOST}/mcp`);
    expect((await fetch(`${relay.url}/.well-known/oauth-protected-resource/openai/mcp`, { method: 'OPTIONS' })).status).toBe(204);

    const stranger = mintCredential('access', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');
    for (const token of [stranger, 'olympus_at_notroutable']) {
      const refused = await post(relay, DIRECTORY_MCP_PATH, rpc('initialize'), token);
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toBe(
        `Bearer realm="olympus", resource_metadata="${DIRECTORY_METADATA}", `
          + 'error="invalid_token", error_description="The connection token is not valid or has been revoked."',
      );
    }
    const onMcp = await post(relay, '/mcp', rpc('initialize'), stranger);
    expect(onMcp.headers.get('www-authenticate')).toContain(`resource_metadata="${MCP_METADATA}"`);
  });
});

describe('routing /openai/mcp to the install', () => {
  test('a routable token reaches its install at /openai/mcp; the engine decides the rest', async () => {
    expect(forwardPath(DIRECTORY_MCP_PATH)).toBe(DIRECTORY_MCP_PATH);
    expect(FORWARDED_PATHS).toContain(DIRECTORY_MCP_PATH);
    const relay = await makeRelay();
    const worker = fakeWorker();
    const { identity } = await connectInstall(relay, worker.url);
    const response = await post(relay, DIRECTORY_MCP_PATH, rpc('tools/list'), mintCredential('access', identity.installId));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: DIRECTORY_MCP_PATH });
    expect(worker.paths).toEqual([DIRECTORY_MCP_PATH]);
  });

  test('an install that predates the endpoint answers it 404 locally, never through another path', async () => {
    const relay = await makeRelay();
    const worker = fakeWorker();
    const { identity } = await connectInstall(relay, worker.url, ['/mcp', '/connect/token', '/connect/revoke']);
    const response = await post(relay, DIRECTORY_MCP_PATH, rpc('tools/list'), mintCredential('access', identity.installId));
    expect(response.status).toBe(404);
    expect(worker.paths).toEqual([]);
  });

  test('an offline Mac: the narrowed list and the dashboard, from the relay', async () => {
    const relay = await makeRelay();
    const worker = fakeWorker();
    const { client, identity } = await connectInstall(relay, worker.url);
    await client.stop();
    const deadline = Date.now() + 5_000;
    while (relay.onlineInstalls().length > 0) {
      if (Date.now() > deadline) throw new Error('install did not go offline');
      await Bun.sleep(10);
    }
    const token = mintCredential('access', identity.installId);
    const list = await (await post(relay, DIRECTORY_MCP_PATH, rpc('tools/list'), token)).json();
    expect(list.result.tools).toEqual(toolsForSurface(generatedSurface.tools, 'directory'));
    const dashboard = await (await post(relay, DIRECTORY_MCP_PATH, rpc('tools/call', { name: 'olympus_dashboard', arguments: {} }), token)).json();
    expect(dashboard.result.structuredContent).toMatchObject({ connection: { state: 'mac_offline' } });
    expect(worker.paths).toEqual([]);
  });
});

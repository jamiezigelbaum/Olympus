// OLYMPUS_TEST_LANE: deploy
import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient } from '../connect-relay/client/relay-client.ts';
import { loadOrCreateIdentity } from '../connect-relay/client/identity.ts';
import { startRelay } from '../connect-relay/server/relay.ts';
import { MemoryInstallRegistry } from '../connect-relay/server/registry.ts';
import { AUTHENTICATED_RESPONSE_HEADER, SURFACE_RESPONSE_HEADER } from '../connect-relay/shared/tokens.ts';
import { openRemoteConnectionStore } from '../src/core/remote-connections.ts';
import { authenticateRemoteRequest } from '../src/workers/remote-mcp.ts';
import { parseRemotePublicBaseUrl } from '../src/core/remote-public-url.ts';
import { bindWorkerSocket, prepareWorkerSocket, createWorkerFetch } from '../src/core/worker-transport.ts';
import { withRequestPeer } from '../src/core/request-peer.ts';

test('all Linux agent credentials reach the owner socket through the outbound relay; revoked keys fail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-relay-'));
  const relay = await startRelay({ publicHost: 'relay.example', registry: new MemoryInstallRegistry(), listen: { host: '127.0.0.1', port: 0 }, log: () => {} });
  const identity = loadOrCreateIdentity(join(root, 'identity'));
  const store = openRemoteConnectionStore(join(root, 'connections.sqlite'));
  const urls = parseRemotePublicBaseUrl('https://relay.example', identity.installId);
  if (!urls.enabled) throw new Error('invalid fixture');
  const options = { platform: 'linux', env: { HOME: root, XDG_RUNTIME_DIR: root } };
  const path = prepareWorkerSocket(options)!;
  let requests = 0;
  const server = bindWorkerSocket(path, () => Bun.serve({ unix: path, fetch: withRequestPeer(async request => {
    const auth = authenticateRemoteRequest(request, { connections: () => store, publicUrls: urls.urls });
    if (!auth.ok) return auth.response;
    requests++;
    const rpc = await request.json() as { id: number };
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { connection: auth.connection.displayName } }, {
      headers: { [AUTHENTICATED_RESPONSE_HEADER]: '1', [SURFACE_RESPONSE_HEADER]: 'remote' },
    });
  }, true) }));
  let online = false;
  const client = new RelayClient({ relayHost: 'relay.example', relayUrl: `ws://127.0.0.1:${relay.port}/v2/connect`, identity,
    target: 'http://127.0.0.1:8010', relaySecret: 'fixture-relay-secret', fetch: createWorkerFetch(options),
    onStatus: status => { online = status.state === 'online'; } });
  try {
    client.start();
    const until = Date.now() + 5_000;
    while (!online && Date.now() < until) await Bun.sleep(10);
    expect(online).toBe(true);
    const request = (token: string) => fetch(`${relay.url}/mcp`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    for (const name of ['ChatGPT', 'Claude', 'Grok', 'Grok Bot', 'Cursor']) {
      const grant = store.oauth.createGrant({ clientId: `fixture-${name}`, displayName: name, resource: urls.urls.resource, installId: identity.installId });
      const response = await request(grant.tokens.accessToken);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: { connection: name } });
    }
    const key = store.create('Grok API', { provider: 'xai', installId: identity.installId });
    expect((await request(key.token)).status).toBe(200);
    store.revoke(key.connection.id);
    expect((await request(key.token)).status).toBe(401);
    expect(requests).toBe(6);
    expect(server.hostname).toBeUndefined();
  } finally { client.stop(); server.stop(true); store.close(); await relay.close(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);

import { startRelayRuntime } from '../src/core/remote-relay-runtime.ts';
import { RELAYED_REQUEST_HEADER, RELAY_SURFACES_PATH } from '../src/core/remote-access.ts';
test.skipIf(process.platform !== 'linux')('runtime surface sync uses the owner socket and never sends its boot secret to TCP', async () => {
 const root=mkdtempSync(join(tmpdir(),'relay-sync-'));
 const env={HOME:root,XDG_RUNTIME_DIR:root,OLYMPUS_RELAY_HOST:'relay.example',OLYMPUS_RELAY_TARGET:'http://127.0.0.1:8010'};
 const path=prepareWorkerSocket({env})!;
 let socketReads=0, tcpSecrets=0;
 const server=bindWorkerSocket(path,()=>Bun.serve({unix:path,fetch:request=>{
  if(new URL(request.url).pathname===RELAY_SURFACES_PATH && request.headers.has(RELAYED_REQUEST_HEADER)) socketReads++;
  return Response.json({v:1,entries:[]});
 }}));
 const relay=await startRelay({publicHost:'relay.example',registry:new MemoryInstallRegistry(),listen:{host:'127.0.0.1',port:0},log:()=>{}});
 const nativeFetch=globalThis.fetch;
 const spy=spyOn(globalThis,'fetch').mockImplementation(((input: RequestInfo | URL,init?: RequestInit)=>{
  if(new Headers(init?.headers).has(RELAYED_REQUEST_HEADER) && !(init as RequestInit & {unix?:string})?.unix) {
   tcpSecrets++; return Promise.resolve(new Response('',{status:503}));
  }
  return nativeFetch(input,init);
 }) as typeof fetch);
 let runtime: Awaited<ReturnType<typeof startRelayRuntime>> | undefined;
 try {
  runtime=await startRelayRuntime({env,instanceId:'fixture',relayUrl:`ws://127.0.0.1:${relay.port}/v2/connect`,surfaceSyncMs:25});
  const until=Date.now()+1500;while(!socketReads && !tcpSecrets && Date.now()<until)await Bun.sleep(10);
  expect(tcpSecrets).toBe(0);expect(socketReads).toBeGreaterThan(0);
 } finally {await runtime?.stop();spy.mockRestore();server.stop(true);await relay.close();rmSync(root,{recursive:true,force:true});}
},10000);

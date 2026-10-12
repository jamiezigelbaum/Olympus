import { afterEach, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { bindWorkerSocket, createWorkerFetch, prepareWorkerSocket, removeReleasedWorkerSocket, validateWorkerSocket, workerSocketPath } from '../src/core/worker-transport.ts';
import { withRequestPeer, requestFromOwnerSocket } from '../src/core/request-peer.ts';
import { createRemoteOAuthHandler } from '../src/workers/remote-oauth/handler.ts';
import { openRemoteConnectionStore } from '../src/core/remote-connections.ts';
import { CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI } from '../src/workers/remote-oauth/pinned-clients.ts';
import { remoteOpenInstructions, remoteOpenNodeCommands } from '../src/core/remote-open.ts';

const roots: string[] = [];
const servers: { stop(close?: boolean): unknown }[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opener-socket-')); chmodSync(dir, 0o700); roots.push(dir);
  return { dir, options: { platform: 'linux', env: { XDG_RUNTIME_DIR: dir } } };
}

test('Mac fetch and listener selection are byte-for-byte unchanged', async () => {
  const original = (async () => new Response('mac')) as unknown as typeof fetch;
  expect(createWorkerFetch({ platform: 'darwin', env: {} }, original)).toBe(original);
  expect(prepareWorkerSocket({ platform: 'darwin', env: {} })).toBeUndefined();
  expect(remoteOpenInstructions({ port: 8010, sshTarget: 'owner@engine' }).onComputer).toBe('ssh -N -L 8010:127.0.0.1:8010 owner@engine');
});

test('private owner socket refuses unsafe, symlinked and occupied paths without changing them', () => {
  const { dir, options } = fixture();
  expect(() => workerSocketPath({ platform: 'linux', env: {} })).toThrow('XDG_RUNTIME_DIR');
  chmodSync(dir, 0o755); expect(() => prepareWorkerSocket(options)).toThrow('0700'); chmodSync(dir, 0o700);
  const foreign = { ...options, uid: (process.getuid?.() ?? 0) + 1 };
  expect(() => prepareWorkerSocket(foreign)).toThrow();
  const socket = prepareWorkerSocket(options)!;
  expect(lstatSync(dirname(socket)).mode & 0o777).toBe(0o700);
  writeFileSync(socket, 'occupied', { mode: 0o600 });
  expect(() => prepareWorkerSocket(options)).toThrow('occupied');
  expect(() => validateWorkerSocket(options)).toThrow();
  rmSync(socket); symlinkSync('/dev/null', socket);
  expect(() => prepareWorkerSocket(options)).toThrow('occupied');
  rmSync(dirname(socket), { recursive: true }); symlinkSync(dir, dirname(socket));
  expect(() => prepareWorkerSocket(options)).toThrow();
});
test('stale socket removal needs both supervisor process custody and listener refusal',()=>{
 const {options}=fixture();const path=workerSocketPath(options)!;mkdirSync(dirname(path),{mode:0o700});
 const made=spawnSync('python3',['-c','import socket,sys\ns=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);s.close()',path]);expect(made.status).toBe(0);chmodSync(path,0o600);
 expect(()=>removeReleasedWorkerSocket(options,{previousWorkerReleased:false})).toThrow('custody');expect(lstatSync(path).isSocket()).toBe(true);
 expect(removeReleasedWorkerSocket(options,{previousWorkerReleased:true})).toBe(true);expect(()=>lstatSync(path)).toThrow();
});

test('real Unix worker health and CLI/relay fetch retain origin and never follow redirects', async () => {
  const { options } = fixture(); const path = prepareWorkerSocket(options)!;
  const server = bindWorkerSocket(path, () => Bun.serve({ unix: path, fetch: withRequestPeer(request => {
    expect(requestFromOwnerSocket(request)).toBe(true);
    if (new URL(request.url).pathname === '/redirect') return Response.redirect('http://127.0.0.1:1/stolen');
    return Response.json({ origin: new URL(request.url).origin, bearer: request.headers.get('authorization') });
  }, true) })); servers.push(server);
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  expect(() => prepareWorkerSocket(options)).toThrow('occupied');
  const client = createWorkerFetch(options);
  const response = await client('http://127.0.0.1:8010/v1/health', { headers: { authorization: 'Bearer fixture' } });
  expect(await response.json()).toEqual({ origin: 'http://127.0.0.1:8010', bearer: 'Bearer fixture' });
  await expect(client('http://127.0.0.1:8010/redirect')).rejects.toThrow();
  const handoff = await client('http://127.0.0.1:8010/redirect', { redirect: 'manual' });
  expect(handoff.status).toBe(302);
  expect(handoff.headers.get('location')).toBe('http://127.0.0.1:1/stolen');
  expect(() => client('https://example.invalid/')).toThrow('loopback');
  chmodSync(path, 0o666); expect(() => client('http://127.0.0.1:8010/')).toThrow('0600');
});

test('Linux approval accepts socket provenance only; loopback peer and forged headers are insufficient', async () => {
  const { dir, options } = fixture(); const path = prepareWorkerSocket(options)!;
  const store = openRemoteConnectionStore(join(dir, 'connections.sqlite'));
  try {
    const handler = createRemoteOAuthHandler({ requireOwnerSocket: true, peerAddress: () => '127.0.0.1', connections: () => store,
      publicUrls: { origin: 'https://relay.example', host: 'relay.example', resource: 'https://relay.example/mcp', issuer: 'https://relay.example', protectedResourceMetadataUrl: 'https://relay.example/.well-known/oauth-protected-resource', secure: true, installId: 'abcdefghijklmnopqrstuvwxyz234567' } });
    const query = new URLSearchParams({ client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT_URI, response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 'owner-state' });
    const url = `http://127.0.0.1:8010/connect/authorize?${query}`;
    const forged = { 'x-olympus-owner-socket': 'true', 'x-forwarded-for': '127.0.0.1', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    expect((await handler(new Request(url, { headers: forged }))).status).toBe(403);
    const server = bindWorkerSocket(path, () => Bun.serve({ unix: path, fetch: withRequestPeer(handler, true) })); servers.push(server);
    const owner = await createWorkerFetch(options)(url);
    expect(owner.status).toBe(200);
    const html = await owner.text();
    const body = new URLSearchParams({
      request_id: /name="request_id" value="([^"]+)"/.exec(html)![1]!,
      csrf: /name="csrf" value="([^"]+)"/.exec(html)![1]!,
      action: 'approve',
    }).toString();
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: owner.headers.get('set-cookie')!.split(';')[0]!,
      'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate',
      'x-olympus-owner-socket': 'true',
    };
    const postUrl = 'http://127.0.0.1:8010/connect/authorize';
    // All browser/CSRF fields are valid. Only server-owned transport proof is absent.
    expect((await handler(new Request(postUrl, { method: 'POST', headers, body }))).status).toBe(403);
    const client = createWorkerFetch(options);
    expect((await client(postUrl, { method: 'POST', headers, body, redirect: 'manual' })).status).toBe(303);
    // A spent decision cannot be replayed, even by the socket owner.
    expect((await client(postUrl, { method: 'POST', headers, body, redirect: 'manual' })).status).toBe(400);
    expect((await handler(new Request(postUrl, { method: 'POST', headers, body }))).status).toBe(403);
  } finally { store.close(); }
});

test.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)('another real local UID cannot reach approval, even with captured request bytes', async () => {
  const { options } = fixture(); const path = prepareWorkerSocket(options)!;
  let requests = 0;
  const server = bindWorkerSocket(path, () => Bun.serve({ unix: path, fetch: () => { requests++; return new Response('owner'); } })); servers.push(server);
  const replay = 'POST /connect/authorize HTTP/1.1\r\nHost: 127.0.0.1:8010\r\nX-Olympus-Owner-Socket: true\r\nSec-Fetch-Mode: navigate\r\nCookie: captured=csrf\r\nContent-Length: 0\r\n\r\n';
  const code = 'import socket,sys\ns=socket.socket(socket.AF_UNIX)\ntry:\n s.connect(sys.argv[1]);s.sendall(sys.argv[2].encode());sys.exit(9)\nexcept PermissionError:\n sys.exit(0)\n';
  const result = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('python3', ['-c', code, path, replay], { uid: 65534, gid: 65534, stdio: 'ignore' }); child.once('error', reject); child.once('exit', resolve);
  });
  expect(result).toBe(0); expect(requests).toBe(0);
  expect((await createWorkerFetch(options)('http://127.0.0.1:8010/v1/health')).status).toBe(200);
});

test('headless handoff targets the socket with fail-fast forwarding; no TCP destination', () => {
  const socketPath = '/run/user/1000/olympus/worker.sock';
  expect(remoteOpenInstructions({ port: 8010, socketPath, sshTarget: 'owner@engine' }).onComputer).toBe('ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8010:/run/user/1000/olympus/worker.sock owner@engine');
  const commands = remoteOpenNodeCommands({ port: 8010, socketPath, sshTarget: 'owner@engine', link: `http://127.0.0.1:8010/dashboard/launch#olympus_launch_ticket=${'a'.repeat(43)}` });
  expect(commands.linux.tunnel).toContain(':8010:/run/user/1000/olympus/worker.sock');
  expect(() => remoteOpenInstructions({ port: 8010, socketPath: '/bad:22/olympus/worker.sock' })).toThrow();
});

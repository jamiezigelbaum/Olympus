/**
 * Offline tool lists and the offline tool result (docs/design/background-
 * agents.md, section E), end to end over loopback: a real relay, a real
 * install client whose engine mapping is a test-controlled list, and a fake
 * loopback worker. Fingerprints are computed here from the published
 * construction, not through the relay's helpers.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient, type RelayClientStatus } from '../client/relay-client.ts';
import { FORWARDED_PATHS } from '../client/forward.ts';
import { loadOrCreateIdentity, type InstallIdentity } from '../client/identity.ts';
import { AUTH_BOUND, base64url, installAuthMessage, MAX_SURFACE_ENTRIES, parseSurfacesMessage, type SurfaceEntry } from '../shared/protocol.ts';
import { lastSeenPhrase, offlineErrorBody, offlineSentence } from '../shared/offline-result.ts';
import { AUTHENTICATED_RESPONSE_HEADER, SURFACE_RESPONSE_HEADER, mintCredential } from '../shared/tokens.ts';
import { MemoryInstallRegistry } from '../server/registry.ts';
import { SurfaceMap } from '../server/surface-map.ts';
import { startRelay, surfacesFrameAccepted, type RelayHandle } from '../server/relay.ts';
import { toolsForSurface, DIRECTORY_MCP_PATH } from '../shared/directory-tools.ts';
import chatgptSurface from '../server/generated/chatgpt-tools.json';
import remoteSurface from '../server/generated/remote-tools.json';

setDefaultTimeout(15_000);

const PUBLIC_HOST = 'mcp.olympus.test';
const HOUR_MS = 60 * 60_000;
const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];
const logLines: string[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The published construction: base64url(SHA-256(domain || SHA-256(token))). */
function fingerprintOf(token: string): string {
  const digest = createHash('sha256').update(token, 'utf8').digest();
  return createHash('sha256').update('olympus-relay/surface-fingerprint/v1\n', 'utf8').update(digest).digest('base64url');
}

function entry(token: string, surface: 'chatgpt' | 'remote', expiresAtMs = Date.now() + HOUR_MS): SurfaceEntry {
  return { endpoint: 'default', fingerprint: fingerprintOf(token), surface, expiresAt: Math.floor(expiresAtMs / 1000) };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-surfaces-'));
  dirs.push(dir);
  return dir;
}

/** A loopback worker; with `marks`, an engine from before syncing that marks each /mcp answer's credential surface. */
function fakeWorker(marks?: 'chatgpt' | 'remote'): { url: string; paths: string[] } {
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      const headers: Record<string, string> = marks && path === '/mcp'
        ? { [AUTHENTICATED_RESPONSE_HEADER]: '1', [SURFACE_RESPONSE_HEADER]: marks }
        : {};
      return Response.json({ jsonrpc: '2.0', id: 1, result: { from: 'engine' } }, { headers });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, paths };
}

async function makeRelay(surfaceMap = new SurfaceMap()): Promise<RelayHandle> {
  const relay = await startRelay({
    publicHost: PUBLIC_HOST,
    registry: new MemoryInstallRegistry(),
    listen: { host: '127.0.0.1', port: 0 },
    surfaceMap,
    log: (event, fields) => logLines.push(JSON.stringify({ event, ...fields })),
  });
  cleanups.push(() => relay.close());
  return relay;
}

async function connectInstall(
  relay: RelayHandle,
  surfaces: () => Promise<readonly SurfaceEntry[] | undefined>,
  options: { marks?: 'chatgpt' | 'remote'; identity?: InstallIdentity } = {},
) {
  const statuses: RelayClientStatus[] = [];
  const identity = options.identity ?? loadOrCreateIdentity(tempDir());
  const worker = fakeWorker(options.marks);
  const client = new RelayClient({
    relayHost: PUBLIC_HOST,
    relayUrl: `ws://127.0.0.1:${relay.port}/v2/connect`,
    identity,
    target: worker.url,
    relaySecret: base64url(crypto.getRandomValues(new Uint8Array(32))),
    heartbeatMs: 500,
    backoff: { minMs: 50, maxMs: 200 },
    onStatus: (status) => statuses.push(status),
    forwardedPaths: FORWARDED_PATHS,
    surfaces,
    surfaceSyncMs: 25,
  });
  client.start();
  cleanups.push(() => client.stop());
  await until(() => statuses.at(-1)?.state === 'online');
  return { client, identity, worker };
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(10);
  }
}

async function goOffline(relay: RelayHandle, client: RelayClient): Promise<void> {
  await client.stop();
  await until(() => relay.onlineInstalls().length === 0);
}

const rpc = (method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

function post(relay: RelayHandle, token: string, body: string, path = '/mcp'): Promise<Response> {
  return fetch(`${relay.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
  });
}

async function toolNames(relay: RelayHandle, token: string, path = '/mcp'): Promise<string[]> {
  const answer = await (await post(relay, token, rpc('tools/list'), path)).json();
  return answer.result.tools.map((tool: { name: string }) => tool.name);
}

const chatgptNames = chatgptSurface.tools.map((tool) => tool.name);
const remoteNames = remoteSurface.tools.map((tool) => tool.name);

function mappedSurfaces(map: SurfaceMap, installId: string): Record<string, string> {
  const install = map.snapshot().find((item) => item.installId === installId);
  return Object.fromEntries((install?.entries ?? []).map((item) => [item.fingerprint, item.surface]));
}

describe('the two offline lists differ', () => {
  test('the generated lists are distinct, and the remote list has no ChatGPT-only tool', () => {
    expect(remoteNames.length).toBeGreaterThan(0);
    expect(remoteNames).not.toContain('olympus_dashboard');
    // The remote evidence search is listed offline exactly as online.
    expect(remoteNames[0]).toBe('olympus_search');
    expect(chatgptNames).toContain('olympus_dashboard');
  });
});

describe('mapping lifecycle', () => {
  test('confirmed online; served offline: mapped ChatGPT gets ChatGPT\'s list, mapped remote and unknown get the remote list', async () => {
    const map = new SurfaceMap();
    const relay = await makeRelay(map);
    let installId = '';
    const tokens = { chatgpt: '', remote: '' };
    const { client, identity } = await connectInstall(relay, async () => tokens.chatgpt
      ? [entry(tokens.chatgpt, 'chatgpt'), entry(tokens.remote, 'remote')]
      : []);
    installId = identity.installId;
    tokens.chatgpt = mintCredential('access', installId);
    tokens.remote = mintCredential('access', installId);
    await until(() => Object.keys(mappedSurfaces(map, installId)).length === 2);
    expect(mappedSurfaces(map, installId)).toEqual({
      [fingerprintOf(tokens.chatgpt)]: 'chatgpt',
      [fingerprintOf(tokens.remote)]: 'remote',
    });

    await goOffline(relay, client);
    expect(await toolNames(relay, tokens.chatgpt)).toEqual(chatgptNames);
    expect(await toolNames(relay, tokens.remote)).toEqual(remoteNames);
    // Never inferred from the token's form: a token minted the same way, never confirmed.
    expect(await toolNames(relay, mintCredential('access', installId))).toEqual(remoteNames);
  });

  test('rotation adds the new fingerprint; revocation and expiry remove a mapping', async () => {
    let clock = Date.now();
    const map = new SurfaceMap(undefined, () => clock);
    const relay = await makeRelay(map);
    let current: SurfaceEntry[] = [];
    const { client, identity } = await connectInstall(relay, async () => current);
    const installId = identity.installId;
    const first = mintCredential('access', installId);
    const rotated = mintCredential('access', installId);
    const shortLived = mintCredential('access', installId);

    current = [entry(first, 'chatgpt')];
    await until(() => mappedSurfaces(map, installId)[fingerprintOf(first)] === 'chatgpt');
    // Rotation: the engine's set now holds the new access token (the old one is deleted at rotation).
    current = [entry(rotated, 'chatgpt'), entry(shortLived, 'chatgpt', clock + 60_000)];
    await until(() => mappedSurfaces(map, installId)[fingerprintOf(rotated)] === 'chatgpt');
    expect(mappedSurfaces(map, installId)[fingerprintOf(first)]).toBeUndefined();

    await goOffline(relay, client);
    expect(await toolNames(relay, rotated)).toEqual(chatgptNames);
    // Revoked (gone from the engine's set): no longer ChatGPT's.
    expect(await toolNames(relay, first)).toEqual(remoteNames);
    expect(await toolNames(relay, shortLived)).toEqual(chatgptNames);
    // Expired: never served past its expiry, whatever the engine last said.
    clock += 61_000;
    expect(await toolNames(relay, shortLived)).toEqual(remoteNames);
    expect(await toolNames(relay, rotated)).toEqual(chatgptNames);
    // The operator's revocation of the install forgets its mapping.
    await relay.revoke(installId);
    expect(map.synced(installId)).toBe(false);
  });

  test('a session writes only its own install; a malformed frame changes nothing', async () => {
    const map = new SurfaceMap();
    const relay = await makeRelay(map);
    let victimEntries: SurfaceEntry[] = [];
    const victim = await connectInstall(relay, async () => victimEntries);
    const victimToken = mintCredential('access', victim.identity.installId);
    victimEntries = [];
    await until(() => map.synced(victim.identity.installId));
    // Another install names the victim's credential as ChatGPT's over its own session.
    const attacker = await connectInstall(relay, async () => [entry(victimToken, 'chatgpt')]);
    await until(() => map.synced(attacker.identity.installId));
    expect(mappedSurfaces(map, victim.identity.installId)).toEqual({});
    await victim.client.stop();
    await until(() => !relay.onlineInstalls().includes(victim.identity.installId));
    expect(await toolNames(relay, victimToken)).toEqual(remoteNames);

    // A frame that does not parse keeps the session and the last good mapping.
    logLines.length = 0;
    const good = mintCredential('access', attacker.identity.installId);
    let frames: unknown[] = [entry(good, 'chatgpt')];
    const third = await connectInstall(relay, async () => frames as SurfaceEntry[]);
    const id = third.identity.installId;
    await until(() => mappedSurfaces(map, id)[fingerprintOf(good)] === 'chatgpt');
    frames = [{ ...entry(good, 'remote'), name: 'Work laptop' }];
    await until(() => logLines.some((line) => line.includes('surfaces_refused')));
    expect(mappedSurfaces(map, id)).toEqual({ [fingerprintOf(good)]: 'chatgpt' });
    expect(relay.onlineInstalls()).toContain(id);
  });

  test('an install that has synced never falls back to an older per-credential mark', async () => {
    const map = new SurfaceMap();
    const relay = await makeRelay(map);
    const { client, identity } = await connectInstall(relay, async () => []);
    await until(() => map.synced(identity.installId));
    await goOffline(relay, client);
    expect(await toolNames(relay, mintCredential('access', identity.installId))).toEqual(remoteNames);
  });
});

describe('the engine route stays private', () => {
  test('the relay never forwards a public request to the mapping route', async () => {
    const relay = await makeRelay();
    const { identity, worker } = await connectInstall(relay, async () => []);
    expect(FORWARDED_PATHS).not.toContain('/relay/surfaces');
    const token = mintCredential('access', identity.installId);
    const response = await fetch(`${relay.url}/relay/surfaces`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).not.toBe(200);
    await response.text();
    expect(worker.paths).not.toContain('/relay/surfaces');
  });
});

describe('bounds and content', () => {
  test('per install at most MAX_SURFACE_ENTRIES (latest expiry kept); across the relay the longest-synced install goes first', () => {
    const now = Date.now();
    const map = new SurfaceMap(40, () => now);
    const many = Array.from({ length: MAX_SURFACE_ENTRIES + 5 }, (_, i) => entry(`token-${i}`, 'remote', now + (i + 1) * 60_000));
    map.replace('install-a', many);
    expect(map.counts()).toEqual({ installs: 1, entries: MAX_SURFACE_ENTRIES });
    expect(map.lookup('install-a', 'default', fingerprintOf('token-0'))).toBeUndefined();
    expect(map.lookup('install-a', 'default', fingerprintOf(`token-${MAX_SURFACE_ENTRIES + 4}`))).toBe('remote');
    map.replace('install-b', many.slice(0, 20));
    // Its entries go; that it synced stays, so it never falls back to an older per-credential mark.
    expect(map.synced('install-a')).toBe(true);
    expect(map.lookup('install-a', 'default', fingerprintOf(`token-${MAX_SURFACE_ENTRIES + 4}`))).toBeUndefined();
    expect(map.counts()).toEqual({ installs: 1, entries: 20 });
    map.remove('install-a');
    expect(map.synced('install-a')).toBe(false);
    // An entry already expired is never stored.
    map.replace('install-c', [entry('old', 'chatgpt', now - 1_000)]);
    expect(map.lookup('install-c', 'default', fingerprintOf('old'))).toBeUndefined();
  });

  test('the frame is bounded and closed: no extra fields, no oversized list, no unknown surface', () => {
    const ok = entry('t', 'chatgpt');
    expect(parseSurfacesMessage({ type: 'surfaces', v: 1, entries: [ok] })).toEqual([ok]);
    expect(parseSurfacesMessage({ type: 'surfaces', v: 1, entries: Array(MAX_SURFACE_ENTRIES + 1).fill(ok) })).toBeUndefined();
    expect(parseSurfacesMessage({ type: 'surfaces', v: 2, entries: [ok] })).toBeUndefined();
    expect(parseSurfacesMessage({ type: 'surfaces', v: 1, entries: [{ ...ok, provider: 'claude' }] })).toBeUndefined();
    expect(parseSurfacesMessage({ type: 'surfaces', v: 1, entries: [{ ...ok, surface: 'admin' }] })).toBeUndefined();
    expect(parseSurfacesMessage({ type: 'surfaces', v: 1, entries: [{ ...ok, fingerprint: 'oly2.abc' }] })).toBeUndefined();
    expect(parseSurfacesMessage({ type: 'surfaces', v: 1, entries: [{ ...ok, expiresAt: 1.5 }] })).toBeUndefined();
  });

  test('what the relay keeps is content-free: endpoint, fingerprint, surface and expiry only', async () => {
    const map = new SurfaceMap();
    const relay = await makeRelay(map);
    let token = '';
    const { identity } = await connectInstall(relay, async () => (token ? [entry(token, 'chatgpt')] : []));
    token = mintCredential('access', identity.installId);
    await until(() => Object.keys(mappedSurfaces(map, identity.installId)).length === 1);
    const kept = map.snapshot().find((item) => item.installId === identity.installId)!;
    for (const item of kept.entries) {
      expect(Object.keys(item).sort()).toEqual(['endpoint', 'expiresAtMs', 'fingerprint', 'surface']);
    }
    const text = JSON.stringify(kept.entries);
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.split('.').at(-1)!);
    expect(text).not.toContain(createHash('sha256').update(token).digest('base64url'));
    expect(text).not.toContain(createHash('sha256').update(token).digest('hex'));
  });
});

describe('the offline tool result', () => {
  test('one fixed result for every tool on both endpoints, with Retry-After as a header and in the result', async () => {
    const relay = await makeRelay();
    const { client, identity, worker } = await connectInstall(relay, async () => []);
    await goOffline(relay, client);
    const token = mintCredential('access', identity.installId);
    const expected = {
      error: 'olympus_offline',
      message: 'Olympus is off; last seen less than an hour ago; try again later.',
      retry_after_seconds: 300,
    };
    const calls: Array<[string, string]> = [
      ['/mcp', 'source_answer'],
      ['/mcp', 'source_answer_result'],
      ['/mcp', 'no_such_tool'],
      [DIRECTORY_MCP_PATH, 'source_answer'],
      [DIRECTORY_MCP_PATH, 'ask_anonymously'],
    ];
    for (const [path, name] of calls) {
      const response = await post(relay, token, rpc('tools/call', { name, arguments: { question: 'what did Dana say about the merger?' } }), path);
      expect(response.status).toBe(200);
      expect(response.headers.get('retry-after')).toBe('300');
      const answer = await response.json();
      expect(Object.keys(answer.result).sort()).toEqual(['content', 'isError']);
      expect(answer.result.isError).toBe(true);
      expect(answer.result.content).toHaveLength(1);
      expect(JSON.parse(answer.result.content[0].text)).toEqual(expected);
    }
    // The directory endpoint keeps ChatGPT's directory list offline.
    expect(await toolNames(relay, token, DIRECTORY_MCP_PATH)).toEqual(toolsForSurface(chatgptSurface.tools, 'directory').map((tool) => tool.name));
    expect(worker.paths).toEqual([]);
  });

  test('last seen is coarse: under an hour, whole hours, then whole days', () => {
    const now = Date.UTC(2026, 9, 12, 12, 0, 0);
    expect(lastSeenPhrase(now - 59 * 60_000, now)).toBe('less than an hour ago');
    expect(lastSeenPhrase(now - 61 * 60_000, now)).toBe('about 1 hour ago');
    expect(lastSeenPhrase(now - 5 * HOUR_MS - 59 * 60_000, now)).toBe('about 5 hours ago');
    expect(lastSeenPhrase(now - 47 * HOUR_MS, now)).toBe('about 47 hours ago');
    expect(lastSeenPhrase(now - 50 * HOUR_MS, now)).toBe('about 2 days ago');
    expect(offlineSentence(undefined, now)).toBe('Olympus is off; try again later.');
    expect(offlineErrorBody(now - 3 * HOUR_MS - 7 * 60_000 - 13_000, now)).toEqual({
      error: 'olympus_offline',
      message: 'Olympus is off; last seen about 3 hours ago; try again later.',
      retry_after_seconds: 300,
    });
  });
});

/** A raw install session (no RelayClient), so a test can send frames whenever it likes. */
async function rawSession(relay: RelayHandle, identity: InstallIdentity) {
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/v2/connect`);
  const errors: string[] = [];
  const onError: Array<(code: string) => void> = [];
  const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'challenge') {
        void installAuthMessage({ kind: 'hello', identity, nonce: String(message.nonce), powBits: 0, relayHost: PUBLIC_HOST, scheme: AUTH_BOUND })
          .then((auth) => socket.send(JSON.stringify(auth)), reject);
      } else if (message.type === 'ready') {
        resolve();
      } else if (message.type === 'error') {
        errors.push(message.code);
        for (const listener of onError) listener(message.code);
      }
    });
  });
  cleanups.push(() => socket.close());
  await ready;
  return { socket, errors, closed, onError: (listener: (code: string) => void) => onError.push(listener) };
}

describe('only the install\'s current session writes its mapping', () => {
  async function registered(map: SurfaceMap) {
    const relay = await makeRelay(map);
    const { client, identity } = await connectInstall(relay, async () => []);
    await until(() => map.synced(identity.installId));
    await goOffline(relay, client);
    return { relay, identity };
  }

  test('the fence: current, open session of a registration in force', () => {
    const session = {};
    const ok = { session, current: session, open: true, revoked: false, registered: true };
    expect(surfacesFrameAccepted(ok)).toBe(true);
    expect(surfacesFrameAccepted({ ...ok, current: {} })).toBe(false);
    expect(surfacesFrameAccepted({ ...ok, current: undefined })).toBe(false);
    expect(surfacesFrameAccepted({ ...ok, open: false })).toBe(false);
    expect(surfacesFrameAccepted({ ...ok, revoked: true })).toBe(false);
    expect(surfacesFrameAccepted({ ...ok, registered: false })).toBe(false);
  });

  test('a frame from a session another one replaced is refused', async () => {
    const map = new SurfaceMap();
    const { relay, identity } = await registered(map);
    const token = mintCredential('access', identity.installId);
    const stale = JSON.stringify({ type: 'surfaces', v: 1, entries: [entry(token, 'chatgpt')] });
    const first = await rawSession(relay, identity);
    // The replaced session answers its replacement with one more frame.
    first.onError((code) => { if (code === 'replaced') first.socket.send(stale); });
    await rawSession(relay, identity);
    await first.closed;
    await Bun.sleep(50);
    expect(mappedSurfaces(map, identity.installId)[fingerprintOf(token)]).toBeUndefined();
  });

  test('a frame from a revoked install\'s session never recreates its mapping', async () => {
    const map = new SurfaceMap();
    const { relay, identity } = await registered(map);
    const token = mintCredential('access', identity.installId);
    const session = await rawSession(relay, identity);
    session.onError((code) => {
      if (code === 'revoked') session.socket.send(JSON.stringify({ type: 'surfaces', v: 1, entries: [entry(token, 'chatgpt')] }));
    });
    await relay.revoke(identity.installId);
    await session.closed;
    await Bun.sleep(50);
    expect(map.synced(identity.installId)).toBe(false);
  });
});

describe('a synced install keeps that state when its entries are evicted', () => {
  test('an evicted install\'s revoked ChatGPT token does not regain ChatGPT\'s list from an older mark', async () => {
    // Room for one entry across the relay: a second install's sync evicts the first's entries.
    const map = new SurfaceMap(1);
    const relay = await makeRelay(map);
    let entriesA: SurfaceEntry[] = [];
    const a = await connectInstall(relay, async () => entriesA, { marks: 'chatgpt' });
    const tokenA = mintCredential('access', a.identity.installId);
    // Online: the engine marks this credential ChatGPT's on its answer, and syncs it.
    entriesA = [entry(tokenA, 'chatgpt')];
    await until(() => mappedSurfaces(map, a.identity.installId)[fingerprintOf(tokenA)] === 'chatgpt');
    await (await post(relay, tokenA, rpc('tools/list'))).text();
    // The token is revoked on the engine; the next sync drops it.
    entriesA = [];
    await until(() => Object.keys(mappedSurfaces(map, a.identity.installId)).length === 0);
    await goOffline(relay, a.client);
    const b = await connectInstall(relay, async () => [entry('b-1', 'remote'), entry('b-2', 'remote')]);
    await until(() => map.synced(b.identity.installId));
    expect(await toolNames(relay, tokenA)).toEqual(remoteNames);
  });
});

/**
 * The install client survives the relay going away: a relay restart (a
 * redeploy) and a relay that accepts the connection but never answers the
 * handshake both end in a fresh, served session, retried for as long as it
 * takes. 2026-10-01: a relay redeploy left a live engine reporting remote
 * access off until the engine restarted.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient, type RelayClientStatus } from '../client/relay-client.ts';
import { loadOrCreateIdentity } from '../client/identity.ts';
import { base64url } from '../shared/protocol.ts';
import { mintCredential } from '../shared/tokens.ts';
import { FileInstallRegistry } from '../server/registry.ts';
import { startRelay, type RelayHandle } from '../server/relay.ts';

setDefaultTimeout(20_000);

const PUBLIC_HOST = 'mcp.olympus.test';
const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-reconnect-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(10);
  }
}

function loopbackWorker(): { url: string; hits: string[] } {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      hits.push(new URL(request.url).pathname);
      return Response.json({ ok: true });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, hits };
}

function client(relayUrl: string, target: string, statuses: RelayClientStatus[], extra: { handshakeTimeoutMs?: number } = {}): RelayClient {
  const relayClient = new RelayClient({
    relayHost: PUBLIC_HOST,
    relayUrl,
    identity: loadOrCreateIdentity(tempDir()),
    target,
    relaySecret: base64url(crypto.getRandomValues(new Uint8Array(32))),
    heartbeatMs: 500,
    backoff: { minMs: 50, maxMs: 400 },
    onStatus: (status) => statuses.push(status),
    ...extra,
  });
  relayClient.start();
  cleanups.push(() => relayClient.stop());
  return relayClient;
}

describe('relay client reconnect', () => {
  test('a relay restart on the same address: the client reconnects and serves a request', async () => {
    // The registry is durable across the restart, as the production file log is.
    const registryPath = join(tempDir(), 'installs.log');
    const start = (port: number) => startRelay({
      publicHost: PUBLIC_HOST,
      registry: new FileInstallRegistry(registryPath),
      listen: { host: '127.0.0.1', port },
    });
    let relay: RelayHandle = await start(0);
    const port = relay.port;
    cleanups.push(() => relay.close());
    const worker = loopbackWorker();
    const statuses: RelayClientStatus[] = [];
    const install = client(`ws://127.0.0.1:${port}/v2/connect`, worker.url, statuses);
    await until(() => statuses.at(-1)?.state === 'online');

    await relay.close();
    await until(() => statuses.at(-1)?.state === 'offline');
    // Down for several backoff rounds: the client keeps trying.
    await Bun.sleep(1_000);
    expect(statuses.filter((status) => status.state === 'offline').length).toBeGreaterThan(1);

    relay = await start(port);
    await until(() => statuses.at(-1)?.state === 'online');
    expect(relay.onlineInstalls()).toEqual([install.installId]);

    const response = await fetch(`${relay.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mintCredential('access', install.installId)}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(worker.hits.at(-1)).toBe('/mcp');
  });

  test('a relay that accepts but never answers the handshake is given up on and retried', async () => {
    let connections = 0;
    const silent = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open() { connections += 1; },
        message() {},
      },
    });
    cleanups.push(() => silent.stop(true));
    const statuses: RelayClientStatus[] = [];
    client(`ws://127.0.0.1:${silent.port}/v2/connect`, loopbackWorker().url, statuses, { handshakeTimeoutMs: 200 });
    await until(() => connections >= 3);
    const offline = statuses.find((status) => status.state === 'offline');
    expect(offline).toMatchObject({ state: 'offline', reason: 'the relay did not answer' });
  });
});

/**
 * Google sign-in on the computer (owner decision 2026-10-13,
 * docs/ops/OAUTH_RELAY.md): a ChatGPT "Connect Gmail" link reaches the relay,
 * the engine sends that relayed visit to the relay's `/connect/signin` page
 * without spending the link, and the page sends the browser to the engine on
 * loopback, where the direct visit spends it and redirects to Google.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient, type RelayClientStatus } from '../client/relay-client.ts';
import { RELAY_HEADER } from '../client/forward.ts';
import { loadOrCreateIdentity } from '../client/identity.ts';
import { base64url } from '../shared/protocol.ts';
import { SIGNIN_BRIDGE_PATH, mintCredential } from '../shared/tokens.ts';
import { MemoryInstallRegistry } from '../server/registry.ts';
import { startRelay, type RelayHandle } from '../server/relay.ts';
import { signinBridge } from '../server/signin-bridge.ts';
import { createChatGptHandoffHandler, createChatGptHandoffs } from '../../src/workers/chatgpt/handoff.ts';
import { withRequestPeer } from '../../src/core/request-peer.ts';

setDefaultTimeout(20_000);

const PUBLIC_HOST = 'mcp.olympus.test';
const INSTALL = 'abcdefghijklmnopqrstuvwxyz234567';
const googleAuthorize = (port: number) =>
  `https://accounts.google.com/o/oauth2/v2/auth?client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A${port}%2Foauth%2Fcallback%2Fgmail&state=s`;
const GOOGLE = googleAuthorize(8010);
const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('the sign-in bridge page', () => {
  const page = (query: string) => signinBridge(new URL(`https://${PUBLIC_HOST}${SIGNIN_BRIDGE_PATH}${query}`), { enginePort: 8010 });

  test('sends the browser to the engine on loopback and names the source', async () => {
    const go = mintCredential('handoff', INSTALL);
    const response = page(`?go=${go}&source=gmail`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`href="http://127.0.0.1:8010/go/${go}"`);
    expect(html).toContain('<h1>Sign in to Gmail on your computer</h1>');
    expect(html).toContain('Open this on your computer');
    const csp = response.headers.get('content-security-policy')!;
    expect(csp).toContain('connect-src http://127.0.0.1:8010');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await page(`?go=${go}&source=google-drive`).text()).toContain('<h1>Sign in to Google Drive on your computer</h1>');
  });

  test('continues to the port the engine named, and ignores a malformed one', async () => {
    const go = mintCredential('handoff', INSTALL);
    const named = page(`?go=${go}&source=gmail&port=8123`);
    expect(await named.text()).toContain(`href="http://127.0.0.1:8123/go/${go}"`);
    expect(named.headers.get('content-security-policy')).toContain('connect-src http://127.0.0.1:8123');
    expect(await page(`?go=${go}&port=80`).text()).toContain(`href="http://127.0.0.1:80/go/${go}"`);
    for (const port of ['99999', '65536', '8123abc', '0', '-1', '08123', '']) {
      expect(await page(`?go=${go}&port=${port}`).text(), port).toContain(`href="http://127.0.0.1:8010/go/${go}"`);
    }
    expect(await page(`?go=${go}&port=8123&port=8124`).text()).toContain(`href="http://127.0.0.1:8010/go/${go}"`);
  });

  test('never echoes an unknown source, and refuses anything but one well-formed hand-off id', async () => {
    const go = mintCredential('handoff', INSTALL);
    const html = await page(`?go=${go}&source=${encodeURIComponent('<b>Evil</b>')}`).text();
    expect(html).toContain('<h1>Sign in to Google on your computer</h1>');
    expect(html).not.toContain('Evil');
    for (const query of ['', '?go=not-an-id', `?go=${mintCredential('access', INSTALL)}`, `?go=${go}&go=${go}`]) {
      const refused = page(query);
      expect(refused.status, query).toBe(404);
      expect(refused.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    }
  });
});

describe('a computer sign-in link through a real relay', () => {
  async function linked(): Promise<{ relay: RelayHandle; installId: string; handoffs: ReturnType<typeof createChatGptHandoffs>; port: number }> {
    const handoffs = createChatGptHandoffs();
    const handler = createChatGptHandoffHandler(handoffs, { isRelayed: (request) => request.headers.has(RELAY_HEADER) });
    const worker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: withRequestPeer(handler) });
    cleanups.push(() => worker.stop(true));
    const relay = await startRelay({ publicHost: PUBLIC_HOST, registry: new MemoryInstallRegistry(), listen: { host: '127.0.0.1', port: 0 } });
    cleanups.push(() => relay.close());
    const dir = mkdtempSync(join(tmpdir(), 'olympus-signin-bridge-'));
    dirs.push(dir);
    const identity = loadOrCreateIdentity(dir);
    const statuses: RelayClientStatus[] = [];
    const client = new RelayClient({
      relayHost: PUBLIC_HOST,
      relayUrl: `ws://127.0.0.1:${relay.port}/v2/connect`,
      identity,
      target: `http://127.0.0.1:${worker.port}`,
      relaySecret: base64url(crypto.getRandomValues(new Uint8Array(32))),
      heartbeatMs: 500,
      backoff: { minMs: 50, maxMs: 200 },
      onStatus: (status) => statuses.push(status),
    });
    client.start();
    cleanups.push(() => client.stop());
    const deadline = Date.now() + 5_000;
    while (statuses.at(-1)?.state !== 'online') {
      if (Date.now() > deadline) throw new Error('install never came online');
      await Bun.sleep(5);
    }
    return { relay, installId: identity.installId, handoffs, port: worker.port! };
  }

  test('the relayed visit lands on the bridge without spending the link; the loopback visit spends it', async () => {
    const { relay, installId, handoffs, port } = await linked();
    const link = handoffs.mint(installId, { kind: 'computer', source: 'gmail', location: GOOGLE });

    for (let visit = 0; visit < 2; visit += 1) {
      const relayed = await fetch(`${relay.url}/go/${link.id}`, { redirect: 'manual' });
      expect(relayed.status).toBe(302);
      expect(relayed.headers.get('location')).toBe(`${SIGNIN_BRIDGE_PATH}?go=${link.id}&source=gmail&port=8010`);
    }
    const bridge = await fetch(`${relay.url}${SIGNIN_BRIDGE_PATH}?go=${link.id}&source=gmail`);
    expect(bridge.status).toBe(200);
    expect(await bridge.text()).toContain(`/go/${link.id}"`);

    // The engine on this computer (here on its own test port).
    const direct = await fetch(`http://127.0.0.1:${port}/go/${link.id}`, { redirect: 'manual' });
    expect(direct.status).toBe(302);
    expect(direct.headers.get('location')).toBe(GOOGLE);
    expect((await fetch(`http://127.0.0.1:${port}/go/${link.id}`, { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${relay.url}/go/${link.id}`, { redirect: 'manual' })).status).toBe(404);
  });

  test('the bridge is told the engine\'s own port', async () => {
    const { relay, installId, handoffs } = await linked();
    const link = handoffs.mint(installId, { kind: 'computer', source: 'google-drive', location: googleAuthorize(8123) });
    const relayed = await fetch(`${relay.url}/go/${link.id}`, { redirect: 'manual' });
    expect(relayed.headers.get('location')).toBe(`${SIGNIN_BRIDGE_PATH}?go=${link.id}&source=google-drive&port=8123`);
    const onEighty = handoffs.mint(installId, { kind: 'computer', source: 'gmail', location: googleAuthorize(80) });
    const eighty = await fetch(`${relay.url}/go/${onEighty.id}`, { redirect: 'manual' });
    expect(eighty.headers.get('location')).toBe(`${SIGNIN_BRIDGE_PATH}?go=${onEighty.id}&source=gmail&port=80`);
  });

  test('an ordinary redirect link still goes straight to the provider through the relay', async () => {
    const { relay, installId, handoffs } = await linked();
    const link = handoffs.mint(installId, { kind: 'redirect', location: 'https://www.dropbox.com/oauth2/authorize?client_id=c' });
    const redirect = await fetch(`${relay.url}/go/${link.id}`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://www.dropbox.com/oauth2/authorize?client_id=c');
    expect((await fetch(`${relay.url}/go/${link.id}`, { redirect: 'manual' })).status).toBe(404);
  });

  test('the relay answers only GET on the bridge path', async () => {
    const { relay } = await linked();
    const go = mintCredential('handoff', INSTALL);
    expect((await fetch(`${relay.url}${SIGNIN_BRIDGE_PATH}?go=${go}`, { method: 'POST' })).status).toBe(405);
  });
});

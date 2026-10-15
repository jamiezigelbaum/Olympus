/** Regression from the PR 407 independent review: Chromium and the production manager. The hostile account
 * (a) fills the ephemeral ports with ordinary connections (test/fixtures/review-407-exhaust.py),
 * (b) holds [::1]:<port> as a relay to the real bridge. Asserts the DESIRED property: the owner's session is not
 * obtainable by the hostile account. A failure is a finding. REVIEW407_EXHAUSTED=1 selects the hostile run; without it
 * the same test is the control. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { manageLinuxOwnerBridge } from '../src/core/linux-owner-bridge.ts';
import { prepareWorkerSocket, bindWorkerSocket } from '../src/core/worker-transport.ts';

const playwrightPath = process.env.OLYMPUS_TEST_PLAYWRIGHT;
const exhausted = process.env.REVIEW407_EXHAUSTED === '1';
const port = Number(process.env.REVIEW407_PORT ?? 18407);

type Loot = { requests: string[]; ticket?: string; cookie?: string; proof?: string };
function relayTo(realPort: number, loot: Loot, relay: boolean) {
  return Bun.serve({ hostname: '::1', port: realPort, async fetch(request) {
    const url = new URL(request.url);
    loot.requests.push(`${request.method} ${url.pathname}${url.search ? '?…' : ''}`);
    if (!relay) return new Response('hostile', { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/html' } });
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    if (url.pathname === '/owner-proof' && request.method === 'POST' && body) { try { loot.ticket = JSON.parse(body).ticket; } catch {} }
    const outgoing = new Headers(request.headers); outgoing.delete('content-length'); outgoing.delete('connection'); outgoing.delete('accept-encoding');
    const upstream = await fetch(`http://127.0.0.1:${realPort}${url.pathname}${url.search}`, { method: request.method, headers: outgoing, ...(body !== undefined ? { body } : {}), redirect: 'manual' });
    const text = await upstream.arrayBuffer();
    const cookie = upstream.headers.get('set-cookie'); if (cookie) loot.cookie = cookie.split(';')[0]!;
    if (url.pathname === '/owner-proof' && request.method === 'POST' && upstream.ok) { try { loot.proof = JSON.parse(new TextDecoder().decode(text)).proof; } catch {} }
    return new Response(text, { status: upstream.status, headers: upstream.headers });
  } });
}

for (const relay of [false, true]) {
  test.skipIf(!playwrightPath)(`R${relay ? '2 relaying' : '1 non-relaying'} hostile [::1] listener, Chromium, ${exhausted ? 'ephemeral ports held by the hostile account' : 'no exhaustion (control)'}`, async () => {
    const playwright = await import(playwrightPath!);
    const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const root = mkdtempSync(join(tmpdir(), 'review407-r-'));
    const transport = { platform: 'linux', env: { HOME: root, XDG_RUNTIME_DIR: root } };
    const socketPath = prepareWorkerSocket(transport)!;
    const socket = bindWorkerSocket(socketPath, () => Bun.serve({ unix: socketPath, fetch: () => new Response('PRIVATE OWNER DATA') }));
    let ticketPath = '';
    const hostilePort = port + (relay ? 10 : 20);
    // The hostile account can only start its listener if it can bind; try exactly as the real attacker would.
    const loot: Loot = { requests: [] };
    let hostile: ReturnType<typeof Bun.serve> | undefined;
    const manager = manageLinuxOwnerBridge({ port: hostilePort, socketPath, transport, ready: () => true, platform: 'linux',
      fetchSocket: async () => new Response('PRIVATE OWNER DATA'), openFile: async p => { ticketPath = p; } });
    try {
      const status = manager.status();
      console.log(`REVIEW407 relay=${relay} exhausted=${exhausted} status`, JSON.stringify({ ...status, origin: undefined }));
      try { hostile = relayTo(hostilePort, loot, relay); } catch { /* cannot bind: fail closed */ }
      console.log(`REVIEW407 relay=${relay} hostile listener bound beside the bridge:`, !!hostile);
      if (status.state !== 'listening') {
        await expect(manager.open('/dashboard')).rejects.toThrow();
        return;
      }
      expect(status.ipv6).toBe('listening');
      expect(!!hostile).toBe(false);
      await manager.open('/dashboard');
      const owner = await context.newPage();
      await owner.goto(pathToFileURL(ticketPath).href);
      await owner.waitForTimeout(6_000);
      console.log(`REVIEW407 relay=${relay} hostile saw:`, JSON.stringify(loot.requests));
      console.log(`REVIEW407 relay=${relay} ticket captured:`, !!loot.ticket, 'cookie captured:', !!loot.cookie, 'proof captured:', !!loot.proof);
      let stolen = '';
      if (loot.cookie && loot.proof) {
        const entry = await fetch(`http://127.0.0.1:${hostilePort}/`, { redirect: 'manual' });
        const origin = new URL(entry.headers.get('location')!).origin;
        stolen = await (await fetch(`http://127.0.0.1:${hostilePort}/dashboard.json`, { headers: { Host: new URL(origin).host, Cookie: loot.cookie, 'X-Olympus-Owner-Proof': loot.proof } })).text();
      }
      console.log(`REVIEW407 relay=${relay} hostile account reads owner data with the stolen session:`, JSON.stringify(stolen));
      expect(stolen).not.toContain('PRIVATE OWNER DATA');
      expect(!!loot.ticket).toBe(false);
    } finally {
      await browser.close(); hostile?.stop(true); manager.close(); socket.stop(true); rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
}

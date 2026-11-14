// Under the worker unit's split the unit's process holds the worker socket and
// pipes each connection to the front's own socket, so a front restart (a model
// change, a delete, a crash) never takes the socket away (lane 6's fresh leg:
// a first-run save took the dashboard down). A connection that comes while
// the front is down waits for it, then is told "starting".
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerFrontProxy } from '../src/core/worker-front-proxy.ts';
import { waitFor } from './helpers/test-clock.ts';
import { workerFrontSocketPath, workerListenSocketPath, WORKER_LISTEN_SOCKET_ENV } from '../src/core/worker-transport.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'olympus-front-proxy-'));
  const runtime = join(root, 'run');
  mkdirSync(runtime, { mode: 0o700 });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, XDG_RUNTIME_DIR: runtime };
  const frontSocket = workerFrontSocketPath({ env, platform: 'linux' })!;
  const front = (name: string) => {
    const server = Bun.serve({ unix: frontSocket, async fetch(request) {
      if (request.method === 'POST') return new Response(`${name}:${(await request.arrayBuffer()).byteLength}`);
      return new Response(name);
    } });
    return { stop: () => server.stop(true) };
  };
  const proxy = startWorkerFrontProxy({ env, frontSocket, waitMs: 1_000, retryMs: 20, log: () => {} });
  cleanups.push(() => proxy.stop());
  const ask = (init: RequestInit = {}) => fetch('http://127.0.0.1:8010/dashboard', { ...init, unix: proxy.socketPath, keepalive: false } as RequestInit);
  return { env, front, proxy, ask, frontSocket };
}

describe('the worker socket under the unit split', () => {
  test('pipes a request and its body to the front', async () => {
    const { front, ask } = setup();
    const a = front('a');
    try {
      expect(await (await ask()).text()).toBe('a');
      const body = new Uint8Array(3 * 1024 * 1024).fill(7);
      expect(await (await ask({ method: 'POST', body })).text()).toBe(`a:${body.length}`);
    } finally { a.stop(); }
  });

  test('a request while the front restarts waits for the next front', async () => {
    const { front, ask } = setup();
    const a = front('a');
    expect(await (await ask()).text()).toBe('a');
    a.stop();
    const asked = ask();
    // The pipe is waiting on the front by now; the next one comes up 300 ms later.
    const until = performance.now() + 300;
    await waitFor(() => performance.now() >= until);
    const b = front('b');
    try {
      const response = await asked;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('b');
    } finally { b.stop(); }
  });

  test('a front that stays down is answered "starting": a page for a browser, JSON otherwise', async () => {
    const { ask, proxy } = setup();
    const json = await ask();
    expect(json.status).toBe(503);
    expect(await json.json()).toEqual({ reachable: false, status: 'starting', step: 'starting' });
    const page = await ask({ headers: { accept: 'text/html,application/xhtml+xml' } });
    expect(page.status).toBe(503);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('Olympus is starting: starting.');
    expect(html).toContain('http-equiv="refresh"');
    // The worker socket stays while the front is down; it goes with the stop.
    expect(existsSync(proxy.socketPath)).toBe(true);
    proxy.stop();
    expect(existsSync(proxy.socketPath)).toBe(false);
  }, 10_000);

  test('the front binds front.sock beside the worker socket, and nothing else', () => {
    const { env, frontSocket } = setup();
    expect(workerListenSocketPath({ env: { ...env, [WORKER_LISTEN_SOCKET_ENV]: frontSocket }, platform: 'linux' })).toBe(frontSocket);
    expect(() => workerListenSocketPath({ env: { ...env, [WORKER_LISTEN_SOCKET_ENV]: join(env.HOME, 'elsewhere.sock') }, platform: 'linux' })).toThrow(/front\.sock/);
  });
});

// On a Mac the engine host holds the worker's loopback port the same way, and
// the front binds a private loopback port (WORKER_LISTEN_PORT_ENV).
describe('the worker port under the engine host off Linux', () => {
  function freePort(): number {
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const { port } = probe;
    probe.stop(true);
    return port;
  }

  test('pipes to the front on its own port, and holds the worker port while the front restarts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-front-proxy-tcp-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const port = freePort();
    const frontPort = freePort();
    const proxy = startWorkerFrontProxy({ env: { HOME: root }, tcp: { hostname: '127.0.0.1', port, frontPort }, waitMs: 1_000, retryMs: 20, log: () => {} });
    cleanups.push(() => proxy.stop());
    const front = (name: string) => {
      const server = Bun.serve({ hostname: '127.0.0.1', port: frontPort, fetch: (request) => new Response(`${name}:${new URL(request.url).port}:${request.headers.get('host')}`) });
      return { stop: () => server.stop(true) };
    };
    const ask = () => fetch(`http://127.0.0.1:${port}/dashboard`, { keepalive: false } as RequestInit);
    const a = front('a');
    // The front sees the worker's own port in the Host header: its URLs keep it.
    expect(await (await ask()).text()).toBe(`a:${port}:127.0.0.1:${port}`);
    a.stop();
    const down = await ask();
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ reachable: false, status: 'starting', step: 'starting' });
    const b = front('b');
    try { expect((await (await ask()).text()).startsWith('b:')).toBe(true); } finally { b.stop(); }
    proxy.stop();
    await expect(ask()).rejects.toThrow();
  }, 10_000);
});

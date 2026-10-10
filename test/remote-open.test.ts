/**
 * Remote mode (docs/design/remote-access.md): the engine's declaration, the
 * by-hand lines, the agent tool, and the load-bearing fact under all of it:
 * the opening link works through an SSH-style tunnel only when the tunnel's
 * end on the computer listens on the engine's OWN port number.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { mintDashboardOpeningUrl } from '../src/core/dashboard-opening.ts';
import { DASHBOARD_LAUNCH_PAGE_PATH, DASHBOARD_LAUNCH_REDEEM_PATH, DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY } from '../src/core/dashboard-launch.ts';
import { defaultConfig } from '../src/core/config.ts';
import { allOpenTargets, openTargetFromPath, openTargetPath } from '../src/core/open-targets.ts';
import { exposedOperations } from '../src/core/operation-exposure.ts';
import { operations } from '../src/core/operations.ts';
import {
  DEFAULT_ENGINE_PORT,
  isValidSshTarget,
  remoteOpenInstructions,
  remoteOpenNodeCommands,
  resolveServerMode,
} from '../src/core/remote-open.ts';
import { OPEN_REMOTE_TOOL_NAME, openRemote } from '../src/core/remote-open-tool.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { copyDashboardViewModel } from '../src/workers/chatgpt/response-builder.ts';
import { OLYMPUS_HOST_CONTEXT_KEY, type DashboardViewModelV1 } from '../src/workers/chatgpt/dashboard-contract.ts';
import { chatgptDashboardPageHtml } from '../src/workers/dashboard/chatgpt/page.ts';
import { DASHBOARD_CHATGPT_PAGE_COPY } from '../src/workers/dashboard/vocabulary.ts';
import { renderOpenPage } from '../scripts/build-open-pages.ts';
import { runServerModeCommand } from '../src/cli.ts';
import plugin from '../src/native-plugin.ts';

const TOKEN = 'remote-open-test-worker-token';
const TICKET = 'A'.repeat(43);

describe('the engine declares remote mode', () => {
  test('on and off are declarations; auto reads the host', () => {
    expect(resolveServerMode({ env: { OLYMPUS_SERVER_MODE: 'on' }, platform: 'darwin' })).toMatchObject({ remote: true, setting: 'on', basis: 'declared' });
    expect(resolveServerMode({ env: { OLYMPUS_SERVER_MODE: 'off' }, platform: 'linux' })).toMatchObject({ remote: false, basis: 'declared' });
    expect(resolveServerMode({ env: {}, platform: 'linux' })).toMatchObject({ remote: true, setting: 'auto', basis: 'no_desktop_session' });
    expect(resolveServerMode({ env: { DISPLAY: ':0' }, platform: 'linux' })).toMatchObject({ remote: false, basis: 'desktop_session' });
    expect(resolveServerMode({ env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux' })).toMatchObject({ remote: false });
    expect(resolveServerMode({ env: {}, platform: 'darwin' })).toMatchObject({ remote: false, basis: 'desktop_platform' });
    expect(resolveServerMode({ env: {}, platform: 'win32' })).toMatchObject({ remote: false });
    // Anything else is auto, never a silent "on".
    expect(resolveServerMode({ env: { OLYMPUS_SERVER_MODE: 'yes please' }, platform: 'darwin' }).remote).toBe(false);
  });

  test('worker.env, read fresh, outranks the environment the worker started with', () => {
    const mode = resolveServerMode({
      env: { OLYMPUS_SERVER_MODE: 'off', OLYMPUS_SERVER_SSH_TARGET: 'old@host' },
      fileEnv: { OLYMPUS_SERVER_MODE: 'on', OLYMPUS_SERVER_SSH_TARGET: 'jamie@sparta' },
      platform: 'darwin',
    });
    expect(mode).toEqual({ remote: true, setting: 'on', basis: 'declared', sshTarget: 'jamie@sparta', agentRoute: true });
    expect(resolveServerMode({ env: { OLYMPUS_SERVER_AGENT_ROUTE: 'off' }, platform: 'linux' }).agentRoute).toBe(false);
  });

  test('an SSH name can never be read as an option or carry shell characters', () => {
    for (const good of ['jamie@sparta', 'sparta', 'me@10.0.0.5', 'a_b@host-1.example.com']) expect(isValidSshTarget(good)).toBe(true);
    for (const bad of ['-oProxyCommand=x', 'me@-host', 'a b', 'me@host;rm', "me@'host'", 'me@host$(x)', '', '@host', 'me@']) {
      expect(isValidSshTarget(bad)).toBe(false);
    }
    expect(resolveServerMode({ env: { OLYMPUS_SERVER_MODE: 'on', OLYMPUS_SERVER_SSH_TARGET: '-oProxyCommand=evil' } }).sshTarget).toBeUndefined();
  });

  test('olympus server-mode writes the declaration to worker.env and reads it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-server-mode-'));
    try {
      const envPath = join(dir, 'worker.env');
      writeFileSync(envPath, "OLYMPUS_WORKER_AUTH_TOKEN='x'\n", { mode: 0o600 });
      const options = { env: { HOME: dir }, homeDir: dir, envPath, platform: 'linux' as const };
      expect(runServerModeCommand(['on', '--ssh-target', 'jamie@sparta'], options)).toEqual({ setting: 'on', remote: true, basis: 'declared', ssh_target: 'jamie@sparta', agent_route: true });
      const written = readFileSync(envPath, 'utf8');
      expect(written).toContain("OLYMPUS_SERVER_MODE='on'");
      expect(written).toContain("OLYMPUS_SERVER_SSH_TARGET='jamie@sparta'");
      expect(runServerModeCommand(['off'], options)).toMatchObject({ setting: 'off', remote: false, ssh_target: 'jamie@sparta' });
      expect(runServerModeCommand(['status'], options)).toMatchObject({ setting: 'off' });
      // A Hermes install: OpenClaw runs the engine, but the assistant cannot reach the computer.
      expect(runServerModeCommand(['on', '--agent-route', 'off'], options)).toMatchObject({ remote: true, agent_route: false });
      expect(readFileSync(envPath, 'utf8')).toContain("OLYMPUS_SERVER_AGENT_ROUTE='off'");
      expect(() => runServerModeCommand(['on', '--agent-route', 'maybe'], options)).toThrow(/agent-route/);
      expect(() => runServerModeCommand(['on', '--ssh-target', '-oProxyCommand=x'], options)).toThrow(/ssh-target/);
      expect(() => runServerModeCommand(['maybe'], options)).toThrow(/Usage/);
      expect(() => runServerModeCommand([], options)).toThrow(/Usage/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the two lines for doing it by hand', () => {
  test('a tunnel on the engine port, then a fresh link that lands on the place', () => {
    expect(remoteOpenInstructions({ port: 8123, sshTarget: 'jamie@sparta', target: { kind: 'connect', source: 'x' } })).toEqual({
      onComputer: 'ssh -N -L 8123:127.0.0.1:8123 jamie@sparta',
      onServer: 'olympus dashboard --no-open --target connect/x',
    });
    expect(remoteOpenInstructions({ port: DEFAULT_ENGINE_PORT })).toEqual({
      onComputer: 'ssh -N -L 8010:127.0.0.1:8010 you@your-server',
      onServer: 'olympus dashboard --no-open',
    });
  });

  test('the /open/ pages carry them, with the default port and what to change', () => {
    const page = renderOpenPage({ kind: 'connect', source: 'readwise' });
    expect(page).toContain('<h2 id="on-a-server">If Olympus runs on a server</h2>');
    expect(page).toContain('<code>ssh -N -L 8010:127.0.0.1:8010 you@your-server</code>');
    expect(page).toContain('<code>olympus dashboard --no-open --target connect/readwise</code>');
    expect(page).toContain('use that number on both sides of the tunnel');
    expect(page).not.toContain('<script');
    expect(page).not.toMatch(/\bMac\b/);
  });

  test('every target the panel can name is a target --target accepts', () => {
    for (const target of allOpenTargets()) expect(openTargetFromPath(openTargetPath(target))).toEqual(target);
    expect(openTargetFromPath('connect/evil')).toBeUndefined();
    expect(openTargetFromPath('../dashboard')).toBeUndefined();
  });
});

describe('the commands the agent runs on the computer', () => {
  const link = `http://127.0.0.1:8010/dashboard/launch#${DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY}=${TICKET}&olympus_open=connect.x`;

  test('bound to 127.0.0.1, same port both ends, fail fast, close themselves', () => {
    const commands = remoteOpenNodeCommands({ port: 8010, sshTarget: 'jamie@sparta', link });
    expect(commands.macos).toEqual({
      tunnel: 'ssh -f -o ExitOnForwardFailure=yes -L 127.0.0.1:8010:127.0.0.1:8010 jamie@sparta sleep 1800',
      open: `open '${link}'`,
      tunnelInBackground: false,
    });
    expect(commands.linux.open).toBe(`xdg-open '${link}'`);
    expect(commands.windows).toEqual({
      tunnel: 'ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:8010:127.0.0.1:8010 jamie@sparta sleep 1800',
      open: `cmd /c start "" "${link}"`,
      tunnelInBackground: true,
    });
  });

  test('refuses anything it did not build itself', () => {
    expect(() => remoteOpenNodeCommands({ port: 8010, sshTarget: '-oProxyCommand=x', link })).toThrow();
    expect(() => remoteOpenNodeCommands({ port: 70000, sshTarget: 'a@b', link })).toThrow();
    expect(() => remoteOpenNodeCommands({ port: 8010, sshTarget: 'a@b', link: `${link}';rm -rf ~;'` })).toThrow();
    expect(() => remoteOpenNodeCommands({ port: 8010, sshTarget: 'a@b', link: 'http://evil.example:8010/dashboard/launch#x' })).toThrow();
  });
});

describe('olympus_open_remote', () => {
  function mintFetch(calls: string[]) {
    return (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true, ticket: TICKET }), { headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
  }
  const config = () => {
    const value = defaultConfig();
    value.email.baseUrl = 'http://127.0.0.1:8123/v1';
    return value;
  };
  const serverDeps = (calls: string[], fileEnv: Record<string, string> = { OLYMPUS_SERVER_MODE: 'on', OLYMPUS_SERVER_SSH_TARGET: 'jamie@sparta' }) => ({
    env: {},
    fileEnv: () => fileEnv,
    platform: 'linux',
    fetchImpl: mintFetch(calls),
    token: () => TOKEN,
  });

  test('gives the owner\'s session the link, the port, where it lands and the exact commands', async () => {
    const calls: string[] = [];
    const result = await openRemote({ config: config(), ownerAgentSession: true }, { target: 'connect/x' }, serverDeps(calls));
    expect(calls).toEqual(['http://127.0.0.1:8123/dashboard/control/launch']);
    expect(result).toMatchObject({
      ok: true,
      target: 'connect/x',
      lands_on: '/dashboard?keys',
      link: `http://127.0.0.1:8123/dashboard/launch#${DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY}=${TICKET}&olympus_open=connect.x`,
      link_single_use: true,
      link_expires_in_seconds: 900,
      engine_port: 8123,
      ssh_target: 'jamie@sparta',
      by_hand: { onComputer: 'ssh -N -L 8123:127.0.0.1:8123 jamie@sparta', onServer: 'olympus dashboard --no-open --target connect/x' },
    });
    const commands = result.node_commands as Record<string, { tunnel: string }>;
    expect(commands.macos!.tunnel).toBe('ssh -f -o ExitOnForwardFailure=yes -L 127.0.0.1:8123:127.0.0.1:8123 jamie@sparta sleep 1800');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  test('without a known SSH name, says so and leaves the placeholder to replace', async () => {
    const result = await openRemote({ config: config(), ownerAgentSession: true }, { target: 'dashboard' }, serverDeps([], { OLYMPUS_SERVER_MODE: 'on' }));
    expect(result.ssh_target).toBeNull();
    expect((result.node_commands as Record<string, { tunnel: string }>).linux!.tunnel).toContain(' you@your-server ');
    expect(result.lands_on).toBe('/dashboard');
  });

  test('refuses before minting anything: not the owner, an unknown place, extra params, not a server, not loopback', async () => {
    const calls: string[] = [];
    await expect(openRemote({ config: config() }, { target: 'dashboard' }, serverDeps(calls))).rejects.toThrow(/owner's own assistant/);
    await expect(openRemote({ config: config(), ownerAgentSession: false }, { target: 'dashboard' }, serverDeps(calls))).rejects.toThrow(/owner/);
    await expect(openRemote({ config: config(), ownerAgentSession: true }, { target: 'connect/evil' }, serverDeps(calls))).rejects.toThrow(/target must be one of/);
    await expect(openRemote({ config: config(), ownerAgentSession: true }, { target: 'dashboard', url: 'http://x' }, serverDeps(calls))).rejects.toThrow(/only "target"/);
    await expect(openRemote({ config: config(), ownerAgentSession: true }, { target: 'dashboard' }, serverDeps(calls, { OLYMPUS_SERVER_MODE: 'off' }))).rejects.toThrow(/not on a server/);
    const exposed = config();
    exposed.email.baseUrl = 'http://10.0.0.5:8123/v1';
    await expect(openRemote({ config: exposed, ownerAgentSession: true }, { target: 'dashboard' }, serverDeps(calls))).rejects.toThrow(/loopback/);
    expect(calls).toEqual([]);
  });

  test('is on the OpenClaw surface only, and the host vouches for the owner per call', async () => {
    const operation = operations.find((entry) => entry.name === OPEN_REMOTE_TOOL_NAME)!;
    expect(operation.requiresOwnerAgentSession).toBe(true);
    for (const surface of ['mcp', 'cli', 'remote'] as const) {
      expect(exposedOperations(operations, { config: defaultConfig(), surface }).map((entry) => entry.name)).not.toContain(OPEN_REMOTE_TOOL_NAME);
    }
    expect(exposedOperations(operations, { config: defaultConfig(), surface: 'native' }).map((entry) => entry.name)).toContain(OPEN_REMOTE_TOOL_NAME);

    type Tool = { name: string; execute: (id: string, params: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> };
    let factory: ((context: Record<string, unknown>) => Tool) | undefined;
    plugin.register({
      pluginConfig: {},
      registerTool(tool: unknown) {
        if (typeof tool === 'function') {
          const made = (tool as (context: Record<string, unknown>) => Tool)({ senderIsOwner: false });
          if (made.name === OPEN_REMOTE_TOOL_NAME) factory = tool as (context: Record<string, unknown>) => Tool;
        }
      },
    } as never);
    expect(factory).toBeDefined();
    // A sender who is not the owner (a group member, a forwarded message) gets a refusal.
    const refused = await factory!({ senderIsOwner: false }).execute('t1', { target: 'dashboard' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('owner');
    // The owner passes the owner check (and stops at the next one in this test host).
    const owner = await factory!({ senderIsOwner: true }).execute('t2', { target: 'connect/evil' });
    expect(owner.content[0]!.text).toContain('target must be one of');
  });
});

describe('the panel in remote mode', () => {
  const remoteModel = (remote: DashboardViewModelV1['remote']): DashboardViewModelV1 => ({
    v: 1,
    connection: { state: 'ready' },
    needsYou: [],
    sources: [{
      id: 'x.bookmarks', label: 'X bookmarks', group: 'cloud', status: 'Off',
      primary: { label: 'Connect', tool: 'olympus_dashboard', args: {}, href: 'https://olympusplugin.ai/open/connect/x/', openHref: true },
    }],
    models: { embedding: { kind: 'built_in', state: 'ready' } },
    generatedAt: new Date().toISOString(),
    ...(remote ? { remote } : {}),
  });

  test('the engine\'s declaration crosses the response builder checked, and nothing else with it', () => {
    const copied = copyDashboardViewModel({ ...remoteModel({ port: 8123, sshTarget: 'jamie@sparta', agent: true }) });
    expect(copied.remote).toEqual({ port: 8123, sshTarget: 'jamie@sparta', agent: true });
    const hostile = copyDashboardViewModel(remoteModel({ port: 8123, sshTarget: 'a@b;rm -rf ~', agent: 'yes' as unknown as boolean, extra: 1 } as never));
    expect(hostile.remote).toEqual({ port: 8123, agent: false });
    expect(copyDashboardViewModel(remoteModel({ port: 0, agent: true })).remote).toBeUndefined();
    expect(copyDashboardViewModel(remoteModel(undefined)).remote).toBeUndefined();
  });

  function mount(model: DashboardViewModelV1) {
    const html = chatgptDashboardPageHtml({ resultTimeoutMs: 5_000 });
    const start = html.indexOf('<script>') + '<script>'.length;
    const script = html.slice(start, html.indexOf('</script>', start));
    const win = new Window({ url: 'https://sandbox.test/' });
    win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
    const sent: Array<{ method?: string; params?: unknown }> = [];
    const parent = { postMessage: (message: { method?: string }) => sent.push(message) };
    Object.defineProperty(win, 'parent', { value: parent, configurable: true });
    new Function('window', 'document', script)(win, win.document);
    win.dispatchEvent(new win.MessageEvent('message', {
      data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: model } },
      source: parent as never,
    }));
    const buttons = () => Array.from(win.document.querySelectorAll('#app button')) as unknown as HTMLButtonElement[];
    return { win, sent, buttons };
  }
  const hosts: Window[] = [];
  afterEach(async () => {
    while (hosts.length) await hosts.pop()!.happyDOM.close();
  });

  test('Connect shows "Ask your assistant" and the two lines with the real port, instead of opening the /open/ page', () => {
    const { win, sent, buttons } = mount(remoteModel({ port: 8123, sshTarget: 'jamie@sparta', agent: true }));
    hosts.push(win);
    const R = DASHBOARD_CHATGPT_PAGE_COPY.remote;
    buttons().find((node) => node.textContent === 'Connect')!.click();
    expect(sent.some((message) => message.method === 'ui/open-link')).toBe(false);
    const box = win.document.querySelector('.remote-box')!;
    expect(box).not.toBeNull();
    const lines = Array.from(box.querySelectorAll('code')).map((node) => node.textContent);
    // The panel's own lines are exactly the engine's (core/remote-open.ts).
    const expected = remoteOpenInstructions({ port: 8123, sshTarget: 'jamie@sparta', target: { kind: 'connect', source: 'x' } });
    expect(lines).toEqual(['Open Olympus on my computer to connect X bookmarks', expected.onComputer, expected.onServer]);
    expect(box.textContent).toContain(R.askLine);
    expect(box.textContent).toContain('Keep 8123 on both sides');
    expect(box.textContent).not.toMatch(/\bMac\b/);
    expect(Array.from(box.querySelectorAll('button')).map((node) => node.textContent)).toEqual([R.copy, R.copy, R.copy]);
  });

  test('without the agent route (Hermes, a hand-run worker): only the two lines, with the placeholder', () => {
    const { win, buttons } = mount(remoteModel({ port: 8010, agent: false }));
    hosts.push(win);
    buttons().find((node) => node.textContent === 'Connect')!.click();
    const box = win.document.querySelector('.remote-box')!;
    expect(box.textContent).not.toContain(DASHBOARD_CHATGPT_PAGE_COPY.remote.askLine);
    expect(Array.from(box.querySelectorAll('code')).map((node) => node.textContent)).toEqual([
      'ssh -N -L 8010:127.0.0.1:8010 you@your-server',
      'olympus dashboard --no-open --target connect/x',
    ]);
  });

  // Jamie's live test, 2026-10-10: the OpenClaw Control UI tab on a headless
  // server, reached through a tunnel. Models' "Fix this on your computer"
  // went to /open/fix/models/, whose olympus:// opened the dashboard of a
  // DIFFERENT Olympus, the one on his laptop. With the engine's declaration,
  // the Control UI panel must show the remote instructions instead.
  test('the OpenClaw Control UI host, engine on a server: Models never routes through the olympus:// open page', () => {
    const model: DashboardViewModelV1 = {
      ...remoteModel({ port: 19789, agent: true }),
      models: {
        embedding: { kind: 'built_in', state: 'ready' },
        change: { label: 'Change', tool: 'olympus_dashboard', args: {}, href: 'https://olympusplugin.ai/open/fix/models/', disabledReason: 'Change models on your computer.' },
      } as DashboardViewModelV1['models'],
    };
    const { win, sent, buttons } = mount(model);
    hosts.push(win);
    win.dispatchEvent(new win.MessageEvent('message', {
      data: { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { [OLYMPUS_HOST_CONTEXT_KEY]: { kind: 'openclaw' } } },
      source: win.parent as never,
    }));
    const how = buttons().filter((node) => node.textContent === DASHBOARD_CHATGPT_PAGE_COPY.howOnComputer);
    expect(how.length).toBeGreaterThan(0);
    for (const node of how) node.click();
    expect(sent.some((message) => message.method === 'ui/open-link')).toBe(false);
    const box = win.document.querySelector('.remote-box')!;
    expect(box).not.toBeNull();
    expect(box.textContent).toContain(DASHBOARD_CHATGPT_PAGE_COPY.remote.askLine);
    const expected = remoteOpenInstructions({ port: 19789, target: { kind: 'fix', section: 'models' } });
    expect(Array.from(box.querySelectorAll('code')).map((node) => node.textContent)).toEqual(['Open Olympus on my computer', expected.onComputer, expected.onServer]);
    expect(win.document.body.innerHTML).not.toContain('olympusplugin.ai/open/');
  });

  test('not remote: Connect still opens the /open/ page', () => {
    const { win, sent, buttons } = mount(remoteModel(undefined));
    hosts.push(win);
    buttons().find((node) => node.textContent === 'Connect')!.click();
    expect(win.document.querySelector('.remote-box')).toBeNull();
    expect(sent.some((message) => message.method === 'ui/open-link')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Port matching, through a real forwarded port                        */
/* ------------------------------------------------------------------ */

// The server's own loopback is 127.0.0.2 here, so the tunnel's end on "the
// computer" (127.0.0.1) can listen on the SAME port number on one machine.
// Linux routes all of 127/8 to loopback; macOS does not configure 127.0.0.2,
// so this runs on Linux (CI, Sparta) and is skipped elsewhere.
const SERVER_LOOPBACK = '127.0.0.2';
const linuxLoopback = process.platform === 'linux';

/** ssh -L in miniature: a byte-for-byte TCP forwarder, which changes no header. */
function forward(listenPort: number, targetPort: number): Promise<Server> {
  const server = createServer((client) => {
    const upstream = createConnection({ host: SERVER_LOOPBACK, port: targetPort });
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => resolve(server));
  });
}

/**
 * The CLI on the server: `olympus dashboard --no-open` asks
 * http://127.0.0.1:<port>, which on the server is the engine. Here the engine
 * listens on 127.0.0.2, so this fetch connects there while sending exactly
 * the Host the CLI sends.
 */
function serverSideFetch(enginePort: number) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    return await new Promise<Response>((resolve, reject) => {
      const req = httpRequest({
        host: SERVER_LOOPBACK,
        port: enginePort,
        method: init?.method ?? 'GET',
        path: url.pathname,
        headers: { ...headers, host: url.host },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') headers.set(name, value);
        }
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers })));
      });
      req.on('error', reject);
      req.end();
    });
  }) as unknown as typeof fetch;
}

describe.skipIf(!linuxLoopback)('port matching through a forwarded port', () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    while (closers.length) closers.pop()!();
  });

  async function engine() {
    const handler = withWorkerBearerAuth(async () => new Response('dashboard'), { authToken: TOKEN });
    const server = Bun.serve({ hostname: SERVER_LOOPBACK, port: 0, fetch: handler });
    closers.push(() => server.stop(true));
    return server.port as number;
  }

  /**
   * An engine whose port number is also free on 127.0.0.1, with the tunnel
   * listening there: the same number at both ends. Retried, never skipped, so
   * a collision with another process cannot turn this proof into a silent pass.
   */
  async function engineWithSamePortTunnel(): Promise<number> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const port = await engine();
      try {
        const tunnel = await forward(port, port);
        closers.push(() => tunnel.close());
        return port;
      } catch {
        continue;
      }
    }
    throw new Error('no port free on both loopback addresses');
  }

  /** What the browser on the computer does with the link: load the page, redeem the ticket, use the session. */
  async function openInBrowser(link: string, browserPort: number) {
    const url = new URL(link);
    const ticket = new URLSearchParams(url.hash.slice(1)).get(DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY)!;
    const origin = `http://127.0.0.1:${browserPort}`;
    const page = await fetch(`${origin}${DASHBOARD_LAUNCH_PAGE_PATH}`);
    const redeem = await fetch(`${origin}${DASHBOARD_LAUNCH_REDEEM_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ ticket }),
    });
    const body = await redeem.json() as { csrf_token?: string; error?: { code: string } };
    let control: number | undefined;
    const cookie = redeem.headers.get('set-cookie')?.split(';')[0];
    if (redeem.ok && cookie && body.csrf_token) {
      // A control call with the new session: cookie, CSRF and Origin, as the dashboard sends them.
      const session = await fetch(`${origin}/dashboard/control/session`, {
        method: 'POST',
        headers: { Cookie: cookie, 'X-Olympus-CSRF': body.csrf_token, Origin: origin },
      });
      control = session.status;
    }
    return { page: page.status, redeem: redeem.status, code: body.error?.code, control, cookie, csrf: body.csrf_token };
  }

  test('a tunnel on the SAME port number: the link opens and the dashboard unlocks', async () => {
    const port = await engineWithSamePortTunnel();
    const link = await mintDashboardOpeningUrl(`http://127.0.0.1:${port}`, TOKEN, { fetchImpl: serverSideFetch(port) });
    expect(link.startsWith(`http://127.0.0.1:${port}/dashboard/launch#`)).toBe(true);
    const opened = await openInBrowser(link, port);
    expect(opened).toMatchObject({ page: 200, redeem: 200, control: 200 });
  });

  test('a tunnel on a DIFFERENT local port: the link is refused as no longer valid, and is not used up', async () => {
    const port = await engineWithSamePortTunnel();
    const tunnel = await forward(0, port);
    closers.push(() => tunnel.close());
    const otherPort = (tunnel.address() as { port: number }).port;
    expect(otherPort).not.toBe(port);
    const link = await mintDashboardOpeningUrl(`http://127.0.0.1:${port}`, TOKEN, { fetchImpl: serverSideFetch(port) });
    // The browser can reach the engine (the page loads), but the ticket was
    // minted for http://127.0.0.1:<port>: the origin, port included, differs.
    const wrong = await openInBrowser(link.replace(`:${port}/`, `:${otherPort}/`), otherPort);
    expect(wrong).toMatchObject({ page: 200, redeem: 403, code: 'dashboard_launch_origin_mismatch' });
    expect(wrong.control).toBeUndefined();
    // The refusal does not burn the ticket: through the tunnel on the right number, the same link still opens.
    expect(await openInBrowser(link, port)).toMatchObject({ redeem: 200, control: 200 });
  });

  test('a session unlocked on one port does not carry to another', async () => {
    const port = await engineWithSamePortTunnel();
    const other = await forward(0, port);
    closers.push(() => other.close());
    const otherPort = (other.address() as { port: number }).port;
    const link = await mintDashboardOpeningUrl(`http://127.0.0.1:${port}`, TOKEN, { fetchImpl: serverSideFetch(port) });
    const opened = await openInBrowser(link, port);
    expect(opened.control).toBe(200);
    // The right cookie and CSRF token, through a tunnel on another number: only the origin differs.
    const elsewhere = await fetch(`http://127.0.0.1:${otherPort}/dashboard/control/session/lock`, {
      method: 'POST',
      headers: { Cookie: opened.cookie!, Origin: `http://127.0.0.1:${otherPort}`, 'X-Olympus-CSRF': opened.csrf! },
    });
    expect(elsewhere.status).toBe(403);
    expect(JSON.stringify(await elsewhere.json())).toContain('origin');
  });
});

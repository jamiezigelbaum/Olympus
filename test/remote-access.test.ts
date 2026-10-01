import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELAY_HEADER as CLIENT_RELAY_HEADER } from '../connect-relay/client/forward.ts';
import { runConnectionsCommand } from '../src/cli.ts';
import { configFromPluginConfig } from '../src/core/config.ts';
import { dataDeleteCustody, deleteOlympusDataWithCustody } from '../src/data-lifecycle.ts';
import {
  DEFAULT_RELAY_HOST,
  createRemotePublicUrlSource,
  emptyRemoteAccessStatus,
  isRelayedRequest,
  RELAYED_REQUEST_HEADER,
  relayProcessRunning,
  remoteAccessDir,
  resolveRemoteAccessMode,
  writeRemoteAccessStatus,
  type RemoteAccessStatusFile,
} from '../src/core/remote-access.ts';
import { openRemoteConnectionStore } from '../src/core/remote-connections.ts';
import { createRemoteOAuthHandler } from '../src/workers/remote-oauth/handler.ts';
import { createRemoteOpenApiHandler } from '../src/workers/remote-openapi.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A throwaway home whose worker.env (0600) the CLI layers like a managed install's. */
function home(workerEnv = ''): { env: Record<string, string>; dir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'olympus-remote-access-'));
  roots.push(root);
  const homeDir = join(root, 'home');
  mkdirSync(join(homeDir, '.config', 'olympus'), { recursive: true });
  writeFileSync(join(homeDir, '.config', 'olympus', 'worker.env'), workerEnv, { mode: 0o600 });
  const env = {
    HOME: homeDir,
    OLYMPUS_CONFIG: join(root, 'missing-config.json'),
    OLYMPUS_REMOTE_CONNECTIONS_DB_PATH: join(root, 'remote-connections.sqlite'),
  };
  return { env, dir: remoteAccessDir({ HOME: homeDir }), root };
}

const INSTALL_ID = 'abcdefghijklmnopqrstuvwxyz234567';
const RELAY = 'https://mcp.olympusplugin.ai';

function relayStatus(overrides: Partial<RemoteAccessStatusFile> = {}): RemoteAccessStatusFile {
  return {
    ...emptyRemoteAccessStatus('relay'),
    relay_host: 'mcp.olympusplugin.ai',
    local_url: 'http://127.0.0.1:28190',
    public_base_url: RELAY,
    instance_id: 'instance-1',
    pid: process.pid,
    install_id: INSTALL_ID,
    relay: { state: 'online', reason: null, retry_in_ms: null },
    last_connected_at: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('remote access mode', () => {
  const mode = (remote: unknown) => resolveRemoteAccessMode(configFromPluginConfig({ remote }).remote);

  test('is off unless enabled, and uses exactly one public address', () => {
    expect(mode(undefined)).toEqual({ mode: 'off' });
    expect(mode({ relayHost: 'mcp.olympusplugin.ai' })).toEqual({ mode: 'off' });
    expect(mode({ enabled: true, relayHost: 'MCP.OlympusPlugin.ai' })).toEqual({ mode: 'relay', relayHost: 'mcp.olympusplugin.ai' });
    expect(mode({ enabled: true, publicBaseUrl: 'https://tunnel.trycloudflare.com/' })).toEqual({ mode: 'manual', publicBaseUrl: 'https://tunnel.trycloudflare.com' });
  });

  test('the relay host defaults to the Olympus relay, and never beside a tunnel of your own', () => {
    expect(DEFAULT_RELAY_HOST).toBe('mcp.olympusplugin.ai');
    // What the dashboard's Turn on remote access writes: only remote.enabled.
    expect(mode({ enabled: true })).toEqual({ mode: 'relay', relayHost: 'mcp.olympusplugin.ai' });
    // The default is not materialized as config, so a publicBaseUrl owner is not in conflict.
    expect(mode({ enabled: true, publicBaseUrl: 'https://tunnel.example' })).toEqual({ mode: 'manual', publicBaseUrl: 'https://tunnel.example' });
    expect(configFromPluginConfig({ remote: { enabled: true } }).remote).toEqual({ enabled: true });
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'openclaw.plugin.json'), 'utf8')) as {
      configSchema: { properties: { remote: { properties: { relayHost: Record<string, unknown> } } } };
    };
    expect(manifest.configSchema.properties.remote.properties.relayHost.default).toBeUndefined();
    expect(manifest.configSchema.properties.remote.properties.relayHost.description).toContain('mcp.olympusplugin.ai');
  });

  test('refuses the relay and a manual public URL together, with a clear error', () => {
    const conflict = mode({ enabled: true, relayHost: 'mcp.olympusplugin.ai', publicBaseUrl: 'https://tunnel.example' });
    expect(conflict.mode).toBe('error');
    expect(conflict).toMatchObject({ error: expect.stringContaining('remote.relayHost and remote.publicBaseUrl are mutually exclusive') });
  });

  test('rejects malformed values by name', () => {
    expect(mode({ enabled: true, relayHost: 'https://mcp.olympusplugin.ai' })).toMatchObject({ error: expect.stringContaining('remote.relayHost') });
    expect(mode({ enabled: true, publicBaseUrl: 'http://tunnel.example' })).toMatchObject({ error: expect.stringContaining('remote.publicBaseUrl is invalid') });
    expect(mode({ enabled: true, publicBaseUrl: 'https://tunnel.example/mcp' })).toMatchObject({ error: expect.stringContaining('no path') });
  });
});

describe('public base URL propagation to the worker', () => {
  test('follows status.json live, so the worker needs no restart', async () => {
    const { root } = home();
    const dataEnv = { XDG_DATA_HOME: join(root, 'data') };
    const statusDir = remoteAccessDir(dataEnv);
    const source = createRemotePublicUrlSource(dataEnv, { minIntervalMs: 0 });
    expect(source.origin).toBe('status');

    // The worker's handlers, built once, as server.ts builds them.
    const store = openRemoteConnectionStore(join(root, 'oauth.sqlite'));
    const oauth = createRemoteOAuthHandler({ publicUrls: () => source.current(), connections: () => store });
    const openApi = createRemoteOpenApiHandler({
      connections: () => store,
      publicUrls: () => source.current(),
      publicBaseUrl: () => source.current()?.origin,
      makeOperationContext: () => { throw new Error('not called'); },
    });
    const metadata = (host: string) => oauth(new Request(`http://127.0.0.1:1/.well-known/oauth-protected-resource/mcp`, { headers: { host } }));
    const servers = async () => ((await (await openApi(new Request('http://127.0.0.1:1/openapi.json'))).json()) as { servers: Array<{ url: string }> }).servers;

    expect((await metadata('127.0.0.1:1')).status).toBe(404);
    expect(await servers()).toEqual([{ url: '/' }]);

    // Relay mode needs the install id: codes and tokens must name it.
    writeRemoteAccessStatus(statusDir, relayStatus({ install_id: null }));
    expect(source.current()).toBeUndefined();

    writeRemoteAccessStatus(statusDir, relayStatus());
    expect(source.current()?.installId).toBe(INSTALL_ID);
    const live = await metadata('mcp.olympusplugin.ai');
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({
      resource: `${RELAY}/mcp`,
      authorization_servers: [RELAY],
    });
    expect(await servers()).toEqual([{ url: RELAY }]);
    // Issuer and resource never come from Host: another host is refused, not reflected.
    expect((await metadata('evil.example')).status).toBe(421);

    // The relay stops: the address disappears without a restart.
    writeRemoteAccessStatus(statusDir, relayStatus({ public_base_url: null, relay: { state: 'stopped', reason: null, retry_in_ms: null } }));
    expect((await metadata('mcp.olympusplugin.ai')).status).toBe(404);
    expect(await servers()).toEqual([{ url: '/' }]);

    // A reported conflict is never served.
    writeRemoteAccessStatus(statusDir, relayStatus({ error: 'conflict' }));
    expect(source.current()).toBeUndefined();
    store.close();
  });

  test('a manual OLYMPUS_PUBLIC_BASE_URL in the worker environment wins and stays fixed', () => {
    const { root } = home();
    const dataEnv = { XDG_DATA_HOME: join(root, 'data') };
    writeRemoteAccessStatus(remoteAccessDir(dataEnv), relayStatus());
    const source = createRemotePublicUrlSource({ ...dataEnv, OLYMPUS_PUBLIC_BASE_URL: 'https://mine.example' });
    expect(source.origin).toBe('env');
    expect(source.current()?.issuer).toBe('https://mine.example');
    // A tunnel of the owner's own is not relay mode.
    expect(source.current()?.installId).toBeUndefined();
  });
});

describe('relayed requests', () => {
  test('a request carrying the relay marker, whatever its value, counts as relayed', () => {
    const request = (headers: Record<string, string>) => new Request('http://127.0.0.1:8010/connect/authorize', { headers });
    expect(isRelayedRequest(request({}))).toBe(false);
    expect(isRelayedRequest(request({ 'x-olympus-relay': 'anything' }))).toBe(true);
    expect(isRelayedRequest(request({ 'X-Olympus-Relay': '' }))).toBe(true);
    expect(RELAYED_REQUEST_HEADER).toBe(CLIENT_RELAY_HEADER);
  });
});

describe('olympus connections URLs', () => {
  test('add, pair and list print the manual public base URL, not the loopback worker (regression)', () => {
    // Live quick-tunnel test on main: OLYMPUS_PUBLIC_BASE_URL set in the CLI's
    // environment and the worker on 28190, yet add printed http://127.0.0.1:8010/mcp.
    const { env } = home('OLYMPUS_EMAIL_SOURCE_PORT=28190\n');
    const tunnel = { ...env, OLYMPUS_PUBLIC_BASE_URL: 'https://quick-tunnel.trycloudflare.com' };
    const added = runConnectionsCommand(['add', 'Muse'], tunnel);
    expect(added).toMatchObject({
      url: 'https://quick-tunnel.trycloudflare.com/mcp',
      openapi_url: 'https://quick-tunnel.trycloudflare.com/openapi.json',
      oauth_issuer: 'https://quick-tunnel.trycloudflare.com',
      public_base_url: 'https://quick-tunnel.trycloudflare.com',
    });
    expect(runConnectionsCommand(['list'], tunnel)).toMatchObject({ url: 'https://quick-tunnel.trycloudflare.com/mcp', openapi_url: 'https://quick-tunnel.trycloudflare.com/openapi.json' });
    expect(runConnectionsCommand(['pair'], tunnel)).toMatchObject({ oauth_enabled: true, url: 'https://quick-tunnel.trycloudflare.com/mcp', oauth_issuer: 'https://quick-tunnel.trycloudflare.com' });
  });

  test('without a public URL they fall back to the worker\'s real address, not the 8010 default', () => {
    const { env } = home('OLYMPUS_EMAIL_SOURCE_PORT=28190\n');
    const listed = runConnectionsCommand(['list'], env);
    expect(listed).toMatchObject({ url: 'http://127.0.0.1:28190/mcp', openapi_url: 'http://127.0.0.1:28190/openapi.json', oauth_issuer: null, public_base_url: null });
    expect(runConnectionsCommand(['pair'], env)).toMatchObject({ oauth_enabled: false, url: null });
  });

  test('once the relay reports a working address, every command prints it with no env editing', () => {
    const { env, dir } = home();
    writeRemoteAccessStatus(dir, relayStatus());
    for (const command of [['add', 'Grok'], ['list']]) {
      expect(runConnectionsCommand(command, env)).toMatchObject({
        url: `${RELAY}/mcp`,
        openapi_url: `${RELAY}/openapi.json`,
        oauth_issuer: RELAY,
      });
    }
    expect(runConnectionsCommand(['pair'], env)).toMatchObject({ oauth_enabled: true, url: `${RELAY}/mcp` });
  });
});

describe('olympus connections status', () => {
  test('reports mode, relay connection and public URLs', () => {
    const { env, dir } = home();
    writeRemoteAccessStatus(dir, relayStatus());
    expect(runConnectionsCommand(['status'], env)).toEqual({
      kind: 'remote_access_status',
      schema: 'olympus.remote-access.status.v2',
      remote_enabled: true,
      mode: 'relay',
      error: null,
      public_base_url: RELAY,
      public_base_url_source: 'relay',
      urls: { mcp: `${RELAY}/mcp`, openapi: `${RELAY}/openapi.json`, oauth_issuer: RELAY },
      local_url: 'http://127.0.0.1:28190',
      relay: {
        host: 'mcp.olympusplugin.ai',
        state: 'online',
        connected: true,
        reason: null,
        retry_in_ms: null,
        install_id: INSTALL_ID,
        last_connected_at: '2026-10-01T09:00:00.000Z',
      },
      updated_at: expect.any(String),
      next_step: null,
    });
  });

  test('says what to do next: off, an unreachable relay, a dead relay process, a conflict', () => {
    const { env, dir } = home();
    expect(runConnectionsCommand(['status'], env)).toMatchObject({
      mode: 'off',
      remote_enabled: false,
      public_base_url: null,
      relay: { connected: false, state: null },
      next_step: expect.stringContaining('Turn on remote access in the Agents section'),
    });
    // The relay is unreachable: a steady, named status. The issuer stays put.
    writeRemoteAccessStatus(dir, relayStatus({
      relay: { state: 'offline', reason: 'could not reach the relay', retry_in_ms: 8_000 },
    }));
    expect(runConnectionsCommand(['status'], env)).toMatchObject({
      remote_enabled: true,
      public_base_url: RELAY,
      relay: { state: 'offline', connected: false, retry_in_ms: 8_000 },
      next_step: expect.stringContaining('Olympus relay unavailable (could not reach the relay)'),
    });
    writeRemoteAccessStatus(dir, relayStatus({ relay: { state: 'connecting', reason: null, retry_in_ms: null } }));
    expect(runConnectionsCommand(['status'], env)).toMatchObject({ next_step: 'Olympus is connecting to the relay.' });
    writeRemoteAccessStatus(dir, relayStatus({ pid: 2 ** 22 + 12345 }));
    expect(runConnectionsCommand(['status'], env)).toMatchObject({ relay: { state: 'not_running', connected: false } });
    writeRemoteAccessStatus(dir, { ...emptyRemoteAccessStatus('off'), error: 'remote.relayHost and remote.publicBaseUrl are mutually exclusive' });
    expect(runConnectionsCommand(['status'], env)).toMatchObject({ remote_enabled: false, error: expect.stringContaining('mutually exclusive'), next_step: expect.stringContaining('mutually exclusive') });
  });
});

describe('data delete --all and the relay', () => {
  test('refuses while the relay child runs, like a running worker', () => {
    const { dir, root } = home();
    writeRemoteAccessStatus(dir, relayStatus());
    expect(relayProcessRunning(dir)).toBe(true);
    expect(dataDeleteCustody({ all: true, workerState: 'inactive', relayRunning: true })).toMatchObject({
      ready: false,
      observed: 'relay_running',
      next_action: expect.stringContaining('remote.enabled false'),
    });
    expect(() => deleteOlympusDataWithCustody({ all: true, workerState: 'inactive', relayRunning: true, homeDir: join(root, 'home') }))
      .toThrow('Turn remote access off');

    writeRemoteAccessStatus(dir, relayStatus({ relay: { state: 'stopped', reason: null, retry_in_ms: null } }));
    expect(relayProcessRunning(dir)).toBe(false);
    writeRemoteAccessStatus(dir, relayStatus({ pid: 2 ** 22 + 12345 }));
    expect(relayProcessRunning(dir)).toBe(false);
    expect(dataDeleteCustody({ all: true, workerState: 'inactive', relayRunning: false })).toMatchObject({ ready: true });
  });
});

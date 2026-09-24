import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELAY_AUTH_HEADER as CLIENT_RELAY_AUTH_HEADER } from '../connect-relay/client/local-endpoint.ts';
import { runConnectionsCommand, runConnectionsTermsCommand } from '../src/cli.ts';
import { configFromPluginConfig } from '../src/core/config.ts';
import { dataDeleteCustody, deleteOlympusDataWithCustody } from '../src/data-lifecycle.ts';
import {
  createRelayRequestVerifier,
  createRemotePublicUrlSource,
  emptyRemoteAccessStatus,
  loadOrCreateRelayAuthSecret,
  readTermsAcceptance,
  RELAY_AUTH_HEADER,
  relayProcessRunning,
  termsAccepted,
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

function relayStatus(overrides: Partial<RemoteAccessStatusFile> = {}): RemoteAccessStatusFile {
  return {
    ...emptyRemoteAccessStatus('relay'),
    relay_host: 'connect.olympusplugin.ai',
    local_url: 'http://127.0.0.1:28190',
    public_base_url: 'https://abc123.connect.olympusplugin.ai',
    instance_id: 'instance-1',
    pid: process.pid,
    install_id: 'abc123',
    hostname: 'abc123.connect.olympusplugin.ai',
    relay: { state: 'online', reason: null, retry_in_ms: null },
    certificate: { state: 'serving', not_after: '2026-12-23T00:00:00.000Z', reason: null, retry_in_ms: null },
    terms_url: 'https://letsencrypt.org/documents/LE-SA-v1.5.pdf',
    ...overrides,
  };
}

describe('remote access mode', () => {
  const mode = (remote: unknown) => resolveRemoteAccessMode(configFromPluginConfig({ remote }).remote);

  test('is off unless enabled, and needs exactly one public address', () => {
    expect(mode(undefined)).toEqual({ mode: 'off' });
    expect(mode({ relayHost: 'connect.olympusplugin.ai' })).toEqual({ mode: 'off' });
    expect(mode({ enabled: true, relayHost: 'Connect.OlympusPlugin.ai' })).toEqual({ mode: 'relay', relayHost: 'connect.olympusplugin.ai' });
    expect(mode({ enabled: true, publicBaseUrl: 'https://tunnel.trycloudflare.com/' })).toEqual({ mode: 'manual', publicBaseUrl: 'https://tunnel.trycloudflare.com' });
    expect(mode({ enabled: true })).toMatchObject({ mode: 'error', error: expect.stringContaining('neither remote.relayHost') });
  });

  test('refuses the relay and a manual public URL together, with a clear error', () => {
    const conflict = mode({ enabled: true, relayHost: 'connect.olympusplugin.ai', publicBaseUrl: 'https://tunnel.example' });
    expect(conflict.mode).toBe('error');
    expect(conflict).toMatchObject({ error: expect.stringContaining('remote.relayHost and remote.publicBaseUrl are mutually exclusive') });
  });

  test('rejects malformed values by name', () => {
    expect(mode({ enabled: true, relayHost: 'https://connect.olympusplugin.ai' })).toMatchObject({ error: expect.stringContaining('remote.relayHost') });
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

    writeRemoteAccessStatus(statusDir, relayStatus());
    const live = await metadata('abc123.connect.olympusplugin.ai');
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({
      resource: 'https://abc123.connect.olympusplugin.ai/mcp',
      authorization_servers: ['https://abc123.connect.olympusplugin.ai'],
    });
    expect(await servers()).toEqual([{ url: 'https://abc123.connect.olympusplugin.ai' }]);
    // Issuer and resource never come from Host: another host is refused, not reflected.
    expect((await metadata('evil.example')).status).toBe(421);

    // The relay stops: the address disappears without a restart.
    writeRemoteAccessStatus(statusDir, relayStatus({ public_base_url: null, relay: { state: 'stopped', reason: null, retry_in_ms: null } }));
    expect((await metadata('abc123.connect.olympusplugin.ai')).status).toBe(404);
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
  });
});

describe('relay header trust', () => {
  test('the worker believes relay forwarding headers only with the per-install secret', () => {
    const { root } = home();
    const dataEnv = { XDG_DATA_HOME: join(root, 'data') };
    const verify = createRelayRequestVerifier(dataEnv, { minIntervalMs: 0 });
    const request = (headers: Record<string, string>) => new Request('http://127.0.0.1:8010/connect/authorize', { headers });
    // No secret on disk yet (relay never ran): nothing is trusted.
    expect(verify(request({ 'x-olympus-relay': '1', 'x-forwarded-for': '203.0.113.9' }))).toBe(false);
    const secret = loadOrCreateRelayAuthSecret(remoteAccessDir(dataEnv));
    expect(loadOrCreateRelayAuthSecret(remoteAccessDir(dataEnv))).toBe(secret);
    // A direct loopback caller forging the headers.
    expect(verify(request({ 'x-olympus-relay': '1', 'x-forwarded-for': '203.0.113.9' }))).toBe(false);
    expect(verify(request({ 'x-olympus-relay': '1', [RELAY_AUTH_HEADER]: `${secret.slice(0, -1)}A` }))).toBe(false);
    expect(verify(request({ 'x-olympus-relay': '1', [RELAY_AUTH_HEADER]: 'short' }))).toBe(false);
    expect(verify(request({ [RELAY_AUTH_HEADER]: secret }))).toBe(false);
    // The relay's local endpoint.
    expect(verify(request({ 'x-olympus-relay': '1', [RELAY_AUTH_HEADER]: secret }))).toBe(true);
    expect(RELAY_AUTH_HEADER).toBe(CLIENT_RELAY_AUTH_HEADER);
    // Written through the exclusive, randomly named temporary: nothing left behind.
    expect(readdirSync(remoteAccessDir(dataEnv)).filter((name) => name.includes('.tmp.'))).toEqual([]);
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
        url: 'https://abc123.connect.olympusplugin.ai/mcp',
        openapi_url: 'https://abc123.connect.olympusplugin.ai/openapi.json',
        oauth_issuer: 'https://abc123.connect.olympusplugin.ai',
      });
    }
    expect(runConnectionsCommand(['pair'], env)).toMatchObject({ oauth_enabled: true, url: 'https://abc123.connect.olympusplugin.ai/mcp' });
  });
});

describe('olympus connections status', () => {
  test('reports mode, relay connection, public URLs and certificate expiry', () => {
    const { env, dir } = home();
    writeRemoteAccessStatus(dir, relayStatus());
    expect(runConnectionsCommand(['status'], env)).toEqual({
      kind: 'remote_access_status',
      schema: 'olympus.remote-access.status.v1',
      remote_enabled: true,
      mode: 'relay',
      error: null,
      public_base_url: 'https://abc123.connect.olympusplugin.ai',
      public_base_url_source: 'relay',
      urls: {
        mcp: 'https://abc123.connect.olympusplugin.ai/mcp',
        openapi: 'https://abc123.connect.olympusplugin.ai/openapi.json',
        oauth_issuer: 'https://abc123.connect.olympusplugin.ai',
      },
      local_url: 'http://127.0.0.1:28190',
      relay: {
        host: 'connect.olympusplugin.ai',
        state: 'online',
        connected: true,
        reason: null,
        retry_in_ms: null,
        install_id: 'abc123',
        hostname: 'abc123.connect.olympusplugin.ai',
      },
      certificate: { state: 'serving', not_after: '2026-12-23T00:00:00.000Z', reason: null },
      terms: { url: 'https://letsencrypt.org/documents/LE-SA-v1.5.pdf', accepted: false, accepted_at: null, accepted_url: null },
      updated_at: expect.any(String),
      next_step: null,
    });
  });

  test('says what to do next: off, awaiting the agreement, a dead relay process, a conflict', () => {
    const { env, dir } = home();
    expect(runConnectionsCommand(['status'], env)).toMatchObject({
      mode: 'off',
      remote_enabled: false,
      public_base_url: null,
      relay: { connected: false, state: null },
      next_step: expect.stringContaining('remote.enabled true'),
    });
    writeRemoteAccessStatus(dir, relayStatus({
      public_base_url: null,
      certificate: { state: 'awaiting_terms', not_after: null, reason: null, retry_in_ms: null },
    }));
    expect(runConnectionsCommand(['status'], env)).toMatchObject({
      public_base_url: null,
      certificate: { state: 'awaiting_terms' },
      next_step: expect.stringContaining('olympus connections terms --accept'),
    });
    writeRemoteAccessStatus(dir, relayStatus({ pid: 2 ** 22 + 12345 }));
    expect(runConnectionsCommand(['status'], env)).toMatchObject({ relay: { state: 'not_running', connected: false } });
    writeRemoteAccessStatus(dir, { ...emptyRemoteAccessStatus('off'), error: 'remote.relayHost and remote.publicBaseUrl are mutually exclusive' });
    expect(runConnectionsCommand(['status'], env)).toMatchObject({ remote_enabled: false, error: expect.stringContaining('mutually exclusive'), next_step: expect.stringContaining('mutually exclusive') });
  });
});

describe('olympus connections terms', () => {
  test('shows the agreement the relay saw, and records acceptance only on --accept', async () => {
    const { env, dir } = home();
    writeRemoteAccessStatus(dir, relayStatus({ certificate: { state: 'awaiting_terms', not_after: null, reason: null, retry_in_ms: null } }));
    const fetchTerms = async () => { throw new Error('must use the URL the relay reported'); };
    const shown = await runConnectionsTermsCommand([], env, { fetchTerms });
    expect(shown).toMatchObject({ kind: 'remote_access_terms', url: 'https://letsencrypt.org/documents/LE-SA-v1.5.pdf', accepted: false });
    expect(readTermsAcceptance(dir)).toBeUndefined();

    const accepted = await runConnectionsTermsCommand(['--accept'], env, { fetchTerms, now: () => new Date('2026-09-24T12:00:00.000Z') });
    expect(accepted).toMatchObject({ accepted: true, accepted_at: '2026-09-24T12:00:00.000Z' });
    expect(readTermsAcceptance(dir)).toEqual({ terms_url: 'https://letsencrypt.org/documents/LE-SA-v1.5.pdf', accepted_at: '2026-09-24T12:00:00.000Z' });
    expect(runConnectionsCommand(['status'], env)).toMatchObject({ terms: { accepted: true } });

    // A new agreement from the CA needs a new acceptance.
    writeRemoteAccessStatus(dir, relayStatus({ terms_url: 'https://letsencrypt.org/documents/LE-SA-v1.6.pdf' }));
    expect(await runConnectionsTermsCommand([], env, { fetchTerms })).toMatchObject({ accepted: false, url: 'https://letsencrypt.org/documents/LE-SA-v1.6.pdf' });
    await expect(runConnectionsTermsCommand(['--yes'], env)).rejects.toThrow('Usage: olympus connections terms [--accept]');
  });

  test('a CA that publishes no agreement URL is not a dead end', async () => {
    const { env, dir } = home();
    // The relay child asked its CA and got no agreement URL.
    writeRemoteAccessStatus(dir, relayStatus({
      terms_url: null,
      public_base_url: null,
      certificate: { state: 'awaiting_terms', not_after: null, reason: null, retry_in_ms: null },
    }));
    const fetchTerms = async () => { throw new Error('must not substitute another CA\'s agreement'); };
    expect(await runConnectionsTermsCommand([], env, { fetchTerms })).toMatchObject({
      url: null,
      accepted: false,
      notice: expect.stringContaining('olympus connections terms --accept'),
    });
    expect(termsAccepted(dir, undefined)).toBe(false);
    expect(await runConnectionsTermsCommand(['--accept'], env, { fetchTerms })).toMatchObject({ url: null, accepted: true });
    // What the relay child asks before ordering: now yes, but a later real
    // agreement from the CA still needs its own acceptance.
    expect(termsAccepted(dir, undefined)).toBe(true);
    expect(termsAccepted(dir, 'https://ca.example/agreement-v1.pdf')).toBe(false);
  });

  test('asks the CA directory when the relay has not reported an agreement yet', async () => {
    const { env } = home();
    const shown = await runConnectionsTermsCommand([], env, { fetchTerms: async () => 'https://letsencrypt.org/documents/LE-SA-v1.5.pdf' });
    expect(shown).toMatchObject({ url: 'https://letsencrypt.org/documents/LE-SA-v1.5.pdf', accepted: false });
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

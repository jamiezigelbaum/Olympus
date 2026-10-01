import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forwardPath, forwardRequestHeaders, forwardResponseHeaders, RELAY_HEADER } from '../client/forward.ts';
import { credentialInstallId, mintCredential } from '../shared/tokens.ts';
import { decodeBodyFrame, encodeBodyFrame, MAX_BODY_CHUNK_BYTES } from '../shared/protocol.ts';
import { isDashboardCall } from '../server/relay-mcp.ts';
import { installTag } from '../server/log.ts';
import { runAdmin } from '../server/admin.ts';
import { FileInstallRegistry } from '../server/registry.ts';
import { loadOrCreateIdentity } from '../client/identity.ts';

const INSTALL = 'abcdefghijklmnopqrstuvwxyz234567';

describe('the forwarded surface', () => {
  test('only /mcp and the token and revocation endpoints reach the worker', () => {
    expect(forwardPath('/mcp')).toBe('/mcp');
    expect(forwardPath('/connect/token')).toBe('/connect/token');
    expect(forwardPath('/connect/revoke')).toBe('/connect/revoke');
    for (const path of [
      '/connect/authorize?client_id=x',
      '/dashboard',
      '/mcp/../dashboard',
      '/mcp%2f..%2fdashboard',
      '//evil/mcp',
      '/MCP',
      '/mcp/',
      'mcp',
      '/connect\\token',
    ]) {
      expect(forwardPath(path), path).toBeUndefined();
    }
  });

  test('setup browser routes are forwarded for GET only, in their exact shapes', () => {
    const link = `/go/${mintCredential('handoff', INSTALL)}`;
    expect(forwardPath(link, undefined, 'GET')).toBe(link);
    expect(forwardPath('/oauth/callback/gmail?code=c&state=s', undefined, 'GET')).toBe('/oauth/callback/gmail?code=c&state=s');
    expect(forwardPath('/oauth/callback/dropbox?code=c', undefined, 'GET')).toBe('/oauth/callback/dropbox?code=c');
    for (const [path, method] of [
      [link, 'POST'],
      ['/oauth/callback/gmail?code=c', 'POST'],
      ['/oauth/callback/x?code=c', 'GET'],
      ['/oauth/callback/gmail/done', 'GET'],
      [`/go/${mintCredential('access', INSTALL)}`, 'GET'],
      ['/go/anything', 'GET'],
      [`${link}/..`, 'GET'],
      ['/keys/abc', 'GET'],
    ] as const) {
      expect(forwardPath(path, undefined, method), `${method} ${path}`).toBeUndefined();
    }
  });

  test('inbound relay and forwarding headers are dropped and the relay marker is set', () => {
    const headers = forwardRequestHeaders([
      ['x-olympus-relay', 'forged'],
      ['X-Olympus-Relay-Auth', 'forged'],
      ['x-forwarded-for', '203.0.113.1'],
      ['x-forwarded-host', 'evil'],
      ['forwarded', 'for=x'],
      ['x-real-ip', '203.0.113.1'],
      ['host', 'evil.test'],
      ['cookie', 'session=1'],
      ['authorization', 'Bearer t'],
      ['content-type', 'application/json'],
    ], 'secret');
    expect([...headers.keys()].sort()).toEqual(['authorization', 'content-type', RELAY_HEADER]);
    expect(headers.get(RELAY_HEADER)).toBe('secret');
  });

  test('response cookies and hop-by-hop headers stay on the Mac', () => {
    const out = forwardResponseHeaders(new Headers({ 'set-cookie': 'a=1', connection: 'close', 'content-type': 'text/event-stream' }));
    expect(out).toEqual([['content-type', 'text/event-stream']]);
  });
});

describe('routable credentials', () => {
  test('each kind names its install and nothing else matches', () => {
    for (const kind of ['access', 'refresh', 'code'] as const) {
      const value = mintCredential(kind, INSTALL);
      expect(credentialInstallId(kind, value)).toBe(INSTALL);
      for (const other of ['access', 'refresh', 'code'] as const) {
        if (other !== kind) expect(credentialInstallId(other, value)).toBeUndefined();
      }
    }
    expect(mintCredential('access', INSTALL)).toMatch(/^oly2\.[a-z2-7]{32}\.[A-Za-z0-9_-]{43}$/);
    expect(mintCredential('refresh', INSTALL)).toStartWith(`oly2r.${INSTALL}.`);
    expect(mintCredential('code', INSTALL)).toStartWith(`oly2c.${INSTALL}.`);
    expect(credentialInstallId('access', `oly2.${INSTALL.toUpperCase()}.${'a'.repeat(43)}`)).toBeUndefined();
    expect(credentialInstallId('access', `oly2.${INSTALL}.${'a'.repeat(42)}`)).toBeUndefined();
    expect(credentialInstallId('access', null)).toBeUndefined();
  });
});

describe('framing and policy helpers', () => {
  test('body frames round-trip and oversized frames are refused', () => {
    const frame = encodeBodyFrame(7, new Uint8Array([1, 2, 3]));
    expect(decodeBodyFrame(frame)).toEqual({ id: 7, payload: new Uint8Array([1, 2, 3]) });
    expect(decodeBodyFrame(new Uint8Array(4 + MAX_BODY_CHUNK_BYTES + 1))).toBeUndefined();
    expect(decodeBodyFrame(new Uint8Array(3))).toBeUndefined();
  });

  test('only a tools/call of the dashboard tool takes the reserved slot', () => {
    expect(isDashboardCall(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'olympus_dashboard' } }))).toBe(true);
    expect(isDashboardCall(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'source_answer', q: 'olympus_dashboard' } }))).toBe(false);
    expect(isDashboardCall('olympus_dashboard')).toBe(false);
  });

  test('logs name an install only by a short hash', () => {
    expect(installTag(INSTALL)).toMatch(/^[0-9a-f]{8}$/);
    expect(installTag(INSTALL)).not.toContain(INSTALL.slice(0, 8));
  });
});

describe('operator commands while the relay is stopped', () => {
  test('revoke is recorded in the log and status counts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-admin-'));
    try {
      const state = join(dir, 'state');
      mkdirSync(state, { mode: 0o700 });
      const registryPath = join(state, 'registry.jsonl');
      const identity = loadOrCreateIdentity(join(dir, 'install'));
      const registry = new FileInstallRegistry(registryPath);
      registry.register(identity.installId, identity.publicKeySpki);
      await registry.flush();
      const env = { RELAY_REGISTRY_PATH: registryPath };
      const revoked = await runAdmin(['revoke', identity.installId], env, statSync(state).uid);
      expect(revoked.code).toBe(0);
      expect(revoked.out).toContain('Recorded the revocation');
      expect(new FileInstallRegistry(registryPath).isRevoked(identity.installId)).toBe(true);
      const status = await runAdmin(['status'], env);
      expect(status.out).toContain('Revoked installs:           1');
      expect((await runAdmin(['revoke', 'not-an-id'], env)).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

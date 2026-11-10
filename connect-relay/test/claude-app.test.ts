import { describe, expect, test } from 'bun:test';
import { claudeAppDomain } from '../shared/mcp-app-client.ts';
import { credentialSurface, SURFACE_RESPONSE_HEADER, AUTHENTICATED_RESPONSE_HEADER, type CredentialSurface } from '../shared/tokens.ts';
import { checkResponseHead, createResponsePolicies } from '../server/response-policy.ts';
import { SurfaceMap } from '../server/surface-map.ts';
import { ConfirmedCredentials } from '../server/limits.ts';
import { relayMcpResponse } from '../server/relay-mcp.ts';

const URL = 'https://mcp.olympusplugin.ai/mcp';
const policy = createResponsePolicies({ relayOrigin: 'https://mcp.olympusplugin.ai', enginePort: 18789 }).api;

describe('Claude App credential metadata', () => {
  test('verified engine response headers retain claude-app internally and strip the marker from public headers', () => {
    for (const [wire, expected] of [['chatgpt', 'chatgpt'], ['claude-app', 'claude-app'], ['remote', 'remote'], ['future-app', 'remote']] as const) {
      const checked = checkResponseHead(policy, 200, [
        ['content-type', 'application/json'], [AUTHENTICATED_RESPONSE_HEADER, '1'], [SURFACE_RESPONSE_HEADER, wire!],
      ], false);
      expect(checked.ok).toBe(true);
      if (!checked.ok) throw new Error(checked.reason);
      expect(checked.authenticated).toBe(true);
      expect(checked.surface).toBe(expected);
      expect(checked.headers.has(SURFACE_RESPONSE_HEADER)).toBe(false);
      const confirmed = new ConfirmedCredentials(60_000, 10);
      confirmed.add('credential', checked.surface);
      expect(confirmed.surface('credential')).toBe(expected);
    }
  });

  test('unknown values normalize to remote, including at the map boundary', async () => {
    expect(credentialSurface('claude-app')).toBe('claude-app');
    for (const unknown of ['future-app', '', null, {}, undefined]) expect(credentialSurface(unknown)).toBe('remote');
    const map = new SurfaceMap();
    map.replace('install', [{ endpoint: 'default', fingerprint: 'a'.repeat(43), surface: 'future-app' as CredentialSurface, expiresAt: Math.floor(Date.now() / 1000) + 60 }]);
    expect(map.lookup('install', 'default', 'a'.repeat(43))).toBe('remote');
    const result = await relayMcpResponse({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), now: Date.now(), state: 'mac_offline', lastSeenAt: undefined, credentialSurface: 'future-app' as CredentialSurface, connectorUrl: URL }).json();
    expect(result.result.tools.some((tool: { name: string }) => tool.name === 'olympus_dashboard')).toBe(false);
  });

  test('offline resources use the exact Claude sandbox host and the directory catalog stays byte-identical', async () => {
    expect(claudeAppDomain(URL)).toBe('910049601f0d72593570f870cb6fbf2b.claudemcpcontent.com');
    const response = (credentialSurface: CredentialSurface, surface: 'default' | 'directory', method: string, params = {}) => relayMcpResponse({
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), now: 1_000, state: 'mac_offline', lastSeenAt: undefined, credentialSurface, connectorUrl: URL, surface,
    });
    for (const uri of ['ui://olympus/dashboard', 'ui://olympus/private-answer', 'ui://olympus/private-question']) {
      const claude = await response('claude-app', 'default', 'resources/read', { uri }).json();
      expect(claude.result.contents[0]._meta.ui.domain).toBe(claudeAppDomain(URL));
      expect(claude.result.contents[0].text).not.toContain('ChatGPT');
      expect(await response('claude-app', 'directory', 'resources/read', { uri }).text()).toBe(await response('chatgpt', 'directory', 'resources/read', { uri }).text());
    }
    expect(await response('claude-app', 'directory', 'tools/list').text()).toBe(await response('chatgpt', 'directory', 'tools/list').text());
  });
});

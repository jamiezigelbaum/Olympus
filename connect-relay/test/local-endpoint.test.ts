import { describe, expect, test } from 'bun:test';
import { DEFAULT_ALLOWED_PATHS, allowedForwardPath, startLocalEndpoint } from '../client/local-endpoint.ts';

describe('local endpoint path allowlist', () => {
  test('forwards only the remote agent surface, normalized', () => {
    expect(allowedForwardPath('/mcp', DEFAULT_ALLOWED_PATHS)).toBe('/mcp');
    expect(allowedForwardPath('/mcp/abc?x=1', DEFAULT_ALLOWED_PATHS)).toBe('/mcp/abc?x=1');
    expect(allowedForwardPath('/.well-known/oauth-protected-resource/mcp', DEFAULT_ALLOWED_PATHS)).toBe('/.well-known/oauth-protected-resource/mcp');
    for (const refused of [
      '/', '/dashboard', '/mcpx', '//mcp', 'mcp', 'http://evil/mcp', '/mcp/../dashboard', '/mcp/./x',
      '/mcp%2f..%2fdashboard', '/mcp/%2e%2e/dashboard', '/mcp\\..\\dashboard', '/MCP', undefined,
    ]) {
      expect(allowedForwardPath(refused, DEFAULT_ALLOWED_PATHS)).toBeUndefined();
    }
  });

  test('refuses a non-loopback or non-http target', async () => {
    await expect(startLocalEndpoint({ key: '', cert: '', target: 'http://10.0.0.5:28090' })).rejects.toThrow('loopback');
    await expect(startLocalEndpoint({ key: '', cert: '', target: 'https://127.0.0.1:28090' })).rejects.toThrow('loopback');
  });
});

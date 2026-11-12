import { remoteSurfaceErrorOutput } from '../core/remote-result.ts';
import type { McpCallToolResult } from '../mcp/server.ts';

/** This request's credential, verified again against its original connection. */
export type RemoteAccessAuthorization = () => 'active' | 'revoked' | 'unavailable';

export function currentAccess(authorized: RemoteAccessAuthorization): ReturnType<RemoteAccessAuthorization> {
  try {
    return authorized();
  } catch {
    return 'unavailable';
  }
}

/** A non-active connection receives only the MCP surface's fixed refusal. */
export function refusedAccess(access: Exclude<ReturnType<RemoteAccessAuthorization>, 'active'>): McpCallToolResult {
  const body = remoteSurfaceErrorOutput(access === 'revoked' ? 'invalid_token' : 'remote_connections_unavailable');
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
}

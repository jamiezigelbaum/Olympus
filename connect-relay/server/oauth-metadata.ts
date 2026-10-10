import { DIRECTORY_MCP_PATH, type McpSurface } from '../shared/directory-tools.ts';

/**
 * The install-independent OAuth documents the relay serves itself. Every
 * install shares one issuer and the same two protected resources (`/mcp`, and
 * the plugin directory's `/openai/mcp`), so these documents are
 * the same for all of them and must equal what an engine in relay mode
 * produces (`src/workers/remote-oauth/handler.ts`; test/remote-oauth.test.ts,
 * "relay mode", holds the two equal).
 *
 * There is no registration endpoint: a registration request names no install,
 * so the relay could not route it. ChatGPT identifies itself with its client
 * metadata document URL instead, which every engine pins.
 */
export const OAUTH_PATHS = {
  protectedResource: '/.well-known/oauth-protected-resource',
  protectedResourceMcp: '/.well-known/oauth-protected-resource/mcp',
  /** The ChatGPT plugin directory's own protected resource (shared/directory-tools.ts). */
  protectedResourceDirectoryMcp: `/.well-known/oauth-protected-resource${DIRECTORY_MCP_PATH}`,
  authorizationServer: '/.well-known/oauth-authorization-server',
  authorize: '/connect/authorize',
  demoAuthorize: '/connect/demo/authorize',
  token: '/connect/token',
  revoke: '/connect/revoke',
  mcp: '/mcp',
  directoryMcp: DIRECTORY_MCP_PATH,
} as const;

export interface RelayOrigin {
  /** `https://mcp.olympusplugin.ai`: the issuer. */
  readonly origin: string;
  /** `<origin>/mcp`: the protected resource. */
  readonly resource: string;
  /** `<origin>/.well-known/oauth-protected-resource/mcp`. */
  readonly protectedResourceMetadataUrl: string;
  /** The directory endpoint's own protected resource: `<origin>/openai/mcp` and its metadata URL. */
  readonly directory: { readonly resource: string; readonly protectedResourceMetadataUrl: string };
}

export function relayOrigin(publicHost: string): RelayOrigin {
  const origin = `https://${publicHost.toLowerCase()}`;
  return {
    origin,
    resource: `${origin}${OAUTH_PATHS.mcp}`,
    protectedResourceMetadataUrl: `${origin}${OAUTH_PATHS.protectedResourceMcp}`,
    directory: {
      resource: `${origin}${OAUTH_PATHS.directoryMcp}`,
      protectedResourceMetadataUrl: `${origin}${OAUTH_PATHS.protectedResourceDirectoryMcp}`,
    },
  };
}

/** The protected resource and its metadata URL for one MCP endpoint. */
export function surfaceResource(relay: RelayOrigin, surface: McpSurface = 'default'): { resource: string; protectedResourceMetadataUrl: string } {
  return surface === 'directory' ? relay.directory : { resource: relay.resource, protectedResourceMetadataUrl: relay.protectedResourceMetadataUrl };
}

export function protectedResourceMetadata(relay: RelayOrigin, surface: McpSurface = 'default'): Record<string, unknown> {
  return {
    resource: surfaceResource(relay, surface).resource,
    authorization_servers: [relay.origin],
    bearer_methods_supported: ['header'],
    resource_name: 'Olympus',
  };
}

export function authorizationServerMetadata(relay: RelayOrigin): Record<string, unknown> {
  return {
    issuer: relay.origin,
    authorization_endpoint: `${relay.origin}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${relay.origin}${OAUTH_PATHS.token}`,
    revocation_endpoint: `${relay.origin}${OAUTH_PATHS.revoke}`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** Public metadata: browser-based MCP clients may read it cross-origin. */
export function metadataResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' },
  });
}

export function metadataPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'mcp-protocol-version',
      'Access-Control-Max-Age': '600',
    },
  });
}

/** RFC 6750 challenge with the RFC 9728 pointer that starts a client's authorization flow. */
export function unauthorized(relay: RelayOrigin, error?: 'invalid_token', surface: McpSurface = 'default'): Response {
  // Same shape as the engine's challenge (src/workers/remote-mcp.ts `unauthorized`).
  const parts = ['realm="olympus"', `resource_metadata="${surfaceResource(relay, surface).protectedResourceMetadataUrl}"`];
  if (error) parts.push(`error="${error}"`, 'error_description="The connection token is not valid or has been revoked."');
  return new Response(JSON.stringify({ error: error ?? 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'WWW-Authenticate': `Bearer ${parts.join(', ')}` },
  });
}

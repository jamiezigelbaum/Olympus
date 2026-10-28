/**
 * Sign-in to a provider's MCP server and the tokens that keep it
 * (docs/CREATE_CONNECTOR.md, "MCP sources", rule 3): OAuth 2.1 with PKCE and
 * dynamic client registration, between this computer and the provider only.
 *
 * - The scope is the connector's, stated on registration, on the authorization
 *   request and never widened: a server that answers 403 asking for more is a
 *   `permission_missing`, not a prompt to sign in for more.
 * - Every host the sign-in goes to (the authorization server, its
 *   authorization page) must be one the connector names, so a server cannot
 *   send the person's browser somewhere else.
 * - What a sign-in keeps (the registered client, the tokens, the discovered
 *   endpoints) is one credential record in the secret store, under a key the
 *   caller gives. Refreshing rewrites it; nothing else reads it.
 */
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  InvalidClientError,
  InvalidGrantError,
  OAuthError,
  UnauthorizedClientError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { SecretStore } from '../secret-store.ts';
import { McpSourceError } from './errors.ts';

/** What one sign-in keeps. */
export interface McpStoredCredential {
  version: 1;
  serverUrl: string;
  scope: string;
  redirectUrl: string;
  authorizationServerUrl: string;
  authorizationServerMetadata?: AuthorizationServerMetadata;
  resource?: string;
  client: OAuthClientInformationMixed;
  tokens: OAuthTokens;
  /** When `tokens` were issued, ISO: with `expires_in`, when they expire. */
  obtainedAt: string;
}

export interface McpCredentialStore {
  read(): Promise<McpStoredCredential | undefined>;
  write(credential: McpStoredCredential): Promise<void>;
  clear(): Promise<void>;
}

/** The credential as one JSON value under `key` in the secret store. */
export function secretStoreMcpCredentials(store: SecretStore, key: string): McpCredentialStore {
  return {
    async read() {
      const raw = await store.get(key);
      if (raw === undefined || raw === '') return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new McpSourceError('auth_missing');
      }
      return isStoredCredential(parsed) ? parsed : undefined;
    },
    write: (credential) => store.set(key, JSON.stringify(credential)),
    clear: () => store.delete(key),
  };
}

function isStoredCredential(value: unknown): value is McpStoredCredential {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const tokens = record.tokens as Record<string, unknown> | undefined;
  const client = record.client as Record<string, unknown> | undefined;
  return record.version === 1
    && typeof record.serverUrl === 'string'
    && typeof record.scope === 'string'
    && typeof record.authorizationServerUrl === 'string'
    && typeof record.obtainedAt === 'string'
    && typeof client?.client_id === 'string'
    && typeof tokens?.access_token === 'string';
}

function hostAllowed(url: string | URL, hosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) return false;
  return hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
}

export interface McpSignInOptions {
  /** The server, fixed by the connector. */
  serverUrl: string;
  /** The exact scope the connector reads with. */
  scope: string;
  /** The name the provider shows on its consent page. */
  clientName: string;
  /** Where the provider returns the browser: this computer's callback. */
  redirectUrl: string;
  /** The caller's state, echoed back on the callback. */
  state: string;
  /** Hosts (and their subdomains) the sign-in may go to. */
  authorizationHosts: readonly string[];
  fetch?: FetchLike;
  now?: () => Date;
}

export interface McpPendingSignIn {
  authorizationUrl: string;
  /** Exchanges the code the callback carried; returns the credential to keep. */
  complete(code: string): Promise<McpStoredCredential>;
}

/**
 * Starts a sign-in: discovers the provider's authorization server, registers
 * a client for this callback (a fresh one each time, so a changed callback
 * address never meets a stale registration), and builds the authorization
 * address with PKCE. The verifier stays in this object.
 */
export async function startMcpSignIn(options: McpSignInOptions): Promise<McpPendingSignIn> {
  if (!hostAllowed(options.serverUrl, options.authorizationHosts)) throw new McpSourceError('server_error');
  const fetchFn = options.fetch;
  let info;
  try {
    info = await discoverOAuthServerInfo(options.serverUrl, fetchFn ? { fetchFn } : {});
  } catch (error) {
    throw new McpSourceError('server_error', { cause: error });
  }
  const metadata = info.authorizationServerMetadata;
  if (!metadata || !hostAllowed(info.authorizationServerUrl, options.authorizationHosts)
    || !hostAllowed(metadata.authorization_endpoint, options.authorizationHosts)
    || !hostAllowed(metadata.token_endpoint, options.authorizationHosts)) {
    throw new McpSourceError('server_error');
  }
  let resource: URL | undefined;
  if (info.resourceMetadata) {
    if (!checkResourceAllowed({ requestedResource: resourceUrlFromServerUrl(options.serverUrl), configuredResource: info.resourceMetadata.resource })) {
      throw new McpSourceError('server_error');
    }
    resource = new URL(info.resourceMetadata.resource);
  }
  let client: OAuthClientInformationMixed;
  try {
    client = await registerClient(info.authorizationServerUrl, {
      metadata,
      clientMetadata: {
        client_name: options.clientName,
        redirect_uris: [options.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: options.scope,
      },
      scope: options.scope,
      ...(fetchFn ? { fetchFn } : {}),
    });
  } catch (error) {
    throw new McpSourceError('server_error', { cause: error });
  }
  const started = await startAuthorization(info.authorizationServerUrl, {
    metadata,
    clientInformation: client,
    redirectUrl: options.redirectUrl,
    scope: options.scope,
    state: options.state,
    ...(resource ? { resource } : {}),
  });
  if (!hostAllowed(started.authorizationUrl, options.authorizationHosts)) throw new McpSourceError('server_error');
  const now = options.now ?? (() => new Date());
  return {
    authorizationUrl: started.authorizationUrl.toString(),
    async complete(code: string): Promise<McpStoredCredential> {
      let tokens: OAuthTokens;
      try {
        tokens = await exchangeAuthorization(info.authorizationServerUrl, {
          metadata,
          clientInformation: client,
          authorizationCode: code,
          codeVerifier: started.codeVerifier,
          redirectUri: options.redirectUrl,
          ...(resource ? { resource } : {}),
          ...(fetchFn ? { fetchFn } : {}),
        });
      } catch (error) {
        throw new McpSourceError(error instanceof OAuthError ? 'auth_revoked' : 'server_error', { cause: error });
      }
      return {
        version: 1,
        serverUrl: options.serverUrl,
        scope: options.scope,
        redirectUrl: options.redirectUrl,
        authorizationServerUrl: info.authorizationServerUrl,
        authorizationServerMetadata: metadata,
        ...(resource ? { resource: resource.toString() } : {}),
        client,
        tokens,
        obtainedAt: now().toISOString(),
      };
    },
  };
}

/** Renew this long before the stated expiry. */
const REFRESH_SKEW_MS = 60_000;

/**
 * The access token for background reads: renewed with the refresh token when
 * it is about to expire (or after the server said 401), and the renewed
 * credential written back. A refusal of the grant is `auth_revoked`; no
 * refresh token left is `auth_expired`.
 */
export class McpTokenSource {
  private refreshing: Promise<string> | undefined;

  constructor(private readonly options: {
    store: McpCredentialStore;
    /** The server the credential must be for: a credential for another server is not used. */
    serverUrl: string;
    fetch?: FetchLike;
    now?: () => Date;
  }) {}

  private async credential(): Promise<McpStoredCredential> {
    const credential = await this.options.store.read();
    if (!credential || credential.serverUrl !== this.options.serverUrl) throw new McpSourceError('auth_missing');
    return credential;
  }

  private expiring(credential: McpStoredCredential): boolean {
    const lifetime = credential.tokens.expires_in;
    if (typeof lifetime !== 'number' || !Number.isFinite(lifetime)) return false;
    const issued = Date.parse(credential.obtainedAt);
    if (!Number.isFinite(issued)) return true;
    const now = (this.options.now ?? (() => new Date()))().getTime();
    return issued + lifetime * 1000 - REFRESH_SKEW_MS <= now;
  }

  async accessToken(): Promise<string> {
    const credential = await this.credential();
    if (!this.expiring(credential)) return credential.tokens.access_token;
    return this.refresh();
  }

  /** Renews the token now; concurrent callers share one renewal. */
  refresh(): Promise<string> {
    this.refreshing ??= this.renew().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async renew(): Promise<string> {
    const credential = await this.credential();
    const refreshToken = credential.tokens.refresh_token;
    if (!refreshToken) throw new McpSourceError('auth_expired');
    let tokens: OAuthTokens;
    try {
      tokens = await refreshAuthorization(credential.authorizationServerUrl, {
        ...(credential.authorizationServerMetadata ? { metadata: credential.authorizationServerMetadata } : {}),
        clientInformation: credential.client,
        refreshToken,
        ...(credential.resource ? { resource: new URL(credential.resource) } : {}),
        ...(this.options.fetch ? { fetchFn: this.options.fetch } : {}),
      });
    } catch (error) {
      const refused = error instanceof InvalidGrantError || error instanceof InvalidClientError || error instanceof UnauthorizedClientError;
      throw new McpSourceError(refused ? 'auth_revoked' : 'server_error', { cause: error });
    }
    await this.options.store.write({
      ...credential,
      tokens,
      obtainedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    });
    return tokens.access_token;
  }
}

/**
 * A fetch that carries the bearer token to the server, renews it once on a
 * 401 and retries, and turns what is left of an auth refusal into the
 * layer's kinds: a second 401 is `auth_revoked`, a 403 `permission_missing`.
 * Only requests to `serverUrl`'s origin carry the token.
 */
export function mcpAuthorizedFetch(tokens: McpTokenSource, serverUrl: string, baseFetch: FetchLike = fetch): FetchLike {
  const origin = new URL(serverUrl).origin;
  return async (url, init) => {
    if (new URL(url).origin !== origin) throw new McpSourceError('server_error');
    const send = async (token: string): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      return baseFetch(url, { ...init, headers });
    };
    let response = await send(await tokens.accessToken());
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      response = await send(await tokens.refresh());
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        throw new McpSourceError('auth_revoked');
      }
    }
    if (response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpSourceError('permission_missing');
    }
    return response;
  };
}

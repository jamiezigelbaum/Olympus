/**
 * OAuth 2.1 authorization server for hosted agents (ChatGPT), served by the
 * worker next to `/mcp`.
 *
 * Two modes, by where the public address comes from:
 *
 * - Relay mode (the Olympus relay; `urls.installId` set). The relay serves the
 *   metadata documents and bridges `/connect/authorize` to this worker's
 *   loopback address. Approval is accepted ONLY from a direct loopback visit:
 *   a request that came through the relay carries `x-olympus-relay` (the relay
 *   child sets it on everything it forwards and strips inbound copies) and is
 *   refused, and the Host must be a loopback name. Being at the Mac is the
 *   proof of ownership, so approval is one click, with no pairing code. Codes
 *   and tokens name this install (`oly2c.<id>.…`, connect-relay/shared/tokens.ts)
 *   so the relay can route them. No registration endpoint is advertised: the
 *   relay could not route a registration, and ChatGPT is a pinned client.
 * - A tunnel the owner runs (`OLYMPUS_PUBLIC_BASE_URL` / `remote.publicBaseUrl`).
 *   The approval page is reached through the public address, so it asks for a
 *   pairing code from `olympus connections pair`.
 *
 * Clients: ChatGPT by its pinned client metadata URL (pinned-clients.ts; no
 * metadata document is ever fetched), or a dynamically registered client.
 *
 * Routes (exact paths; everything else stays behind the worker bearer):
 * - `GET /.well-known/oauth-protected-resource[/mcp]`  RFC 9728 metadata
 * - `GET /.well-known/oauth-authorization-server`      RFC 8414 metadata
 * - `GET|POST /connect/authorize`  approval page; code + PKCE S256 + RFC 9207 `iss`
 * - `POST /connect/token`          authorization_code and rotating refresh_token
 * - `POST /connect/register`       RFC 7591 registration (fallback to CIMD), rate-limited
 * - `POST /connect/revoke`         RFC 7009
 *
 * Every URL here comes from the configured public base URL. With none
 * configured the routes answer 404 and only bearer connections work.
 *
 * Host and Origin (DNS rebinding). The worker listens on loopback; the relay
 * or a tunnel forwards public traffic with the public Host. These routes are
 * unauthenticated, so they answer only a Host that is the configured public
 * host or a loopback name. A page on an attacker's hostname that rebinds to
 * 127.0.0.1 carries the attacker's Host and is refused. The approval form's
 * POST additionally requires, when the browser sends them, an Origin equal to
 * the request's own origin and a same-origin Sec-Fetch-Site, plus a CSRF token
 * bound to a SameSite=Strict cookie. `/mcp` needs no Origin rule: it is
 * bearer-only and sends no CORS headers, and hosted agents call it from their
 * servers with no Origin or their own.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mintCredential } from '../../../connect-relay/shared/tokens.ts';
import { sanitizeCallerDisplayName } from '../../core/operation-caller.ts';
import { isRelayedRequest } from '../../core/remote-access.ts';
import type { RemoteConnectionStore } from '../../core/remote-connections.ts';
import { normalizePairingCode } from '../../core/remote-oauth-store.ts';
import { currentRemotePublicUrls, isConfiguredResource, type RemotePublicUrls, type RemotePublicUrlsSource } from '../../core/remote-public-url.ts';
import { isClientIdMetadataUrl, pinnedClient } from './pinned-clients.ts';
import { readBoundedRequestText } from '../remote-request-body.ts';
import { renderConsentErrorPage, renderConsentPage, renderLoopbackConsentPage } from './consent-page.ts';
import { isAcceptableRedirectUri, isLoopbackRedirectUri, redirectHost, redirectUriMatches } from './redirect-uris.ts';

export const REMOTE_OAUTH_PATHS = {
  protectedResource: '/.well-known/oauth-protected-resource',
  protectedResourceMcp: '/.well-known/oauth-protected-resource/mcp',
  authorizationServer: '/.well-known/oauth-authorization-server',
  authorize: '/connect/authorize',
  token: '/connect/token',
  register: '/connect/register',
  revoke: '/connect/revoke',
} as const;

const ROUTED_PATHS = new Set<string>(Object.values(REMOTE_OAUTH_PATHS));
const AUTHORIZATION_CODE_TTL_MS = 60_000;
const CONSENT_REQUEST_TTL_MS = 10 * 60_000;
const CONSENT_MAX_ATTEMPTS = 5;
/**
 * Waiting approvals are bounded, but a full table never refuses a new one: a
 * new request evicts the oldest instead (see admitPending), so a flood can
 * cost the owner an approval page, never ten minutes of being locked out.
 * Every caller reaches the worker over loopback (directly, or through a
 * tunnel that forwards no trustworthy address), so there is no per-caller
 * share to keep.
 */
const MAX_PENDING_CONSENTS = 64;
/** Pacing for pairing-code checks: see pairingPacer. */
const PAIRING_FAILURE_WINDOW_MS = 15 * 60_000;
const PAIRING_MAX_DELAY_MS = 60_000;
/** Longer than this and the page asks the person to come back instead of holding the request. */
const PAIRING_MAX_HELD_MS = 10_000;
const MAX_LIVE_CODES = 256;
const MAX_FORM_BYTES = 8 * 1024;
const MAX_REGISTRATION_BYTES = 16 * 1024;
export const CONNECT_BODY_DEADLINE_MS = 10_000;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface RemoteOAuthHandlerOptions {
  /** The configured public URLs (or a live source); undefined when OAuth is off. */
  publicUrls: RemotePublicUrlsSource;
  /** Whether a request came through the relay (default: it carries `x-olympus-relay`). */
  isRelayed?: (request: Request) => boolean;
  /** The connection store; OAuth may create the database (registration precedes pairing). */
  connections: () => RemoteConnectionStore;
  now?: () => number;
  /** Registrations allowed in a burst, refilled over an hour. */
  registrationBurst?: number;
  /** How the handler waits out a pairing delay; tests record instead of sleeping. */
  sleep?: (ms: number) => Promise<void>;
}

interface ResolvedClient {
  clientId: string;
  clientName: string;
  redirectUris: readonly string[];
  verifiedHost: string | undefined;
}

interface PendingConsent {
  client: ResolvedClient;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  state: string | undefined;
  csrf: string;
  attempts: number;
  expiresAt: number;
  /**
   * Someone holding this page's cookie and CSRF token has typed a well-formed
   * pairing code into it: likely the owner mid-approval. Evicted only when a
   * scope has nothing unpinned left. Pinning is not free: it costs a paced
   * pairing check, and five wrong codes end the page.
   */
  pinned: boolean;
}

interface IssuedCode {
  clientId: string;
  displayName: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  expiresAt: number;
  /** Set once exchanged; a second exchange revokes this grant. */
  connectionId?: string;
}

export function isRemoteOAuthRequest(request: Request): boolean {
  return ROUTED_PATHS.has(new URL(request.url).pathname);
}

export function withRemoteOAuthRoutes(
  oauth: (request: Request) => Promise<Response>,
  rest: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) => (isRemoteOAuthRequest(request) ? oauth(request) : rest(request));
}

export function protectedResourceMetadata(urls: RemotePublicUrls): Record<string, unknown> {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    bearer_methods_supported: ['header'],
    resource_name: 'Olympus',
  };
}

/**
 * RFC 8414 metadata. In relay mode the relay serves this same document
 * itself (connect-relay/server/oauth-metadata.ts; a test holds them equal).
 */
export function authorizationServerMetadata(urls: RemotePublicUrls): Record<string, unknown> {
  return {
    issuer: urls.issuer,
    authorization_endpoint: `${urls.origin}${REMOTE_OAUTH_PATHS.authorize}`,
    token_endpoint: `${urls.origin}${REMOTE_OAUTH_PATHS.token}`,
    ...(urls.installId ? {} : { registration_endpoint: `${urls.origin}${REMOTE_OAUTH_PATHS.register}` }),
    revocation_endpoint: `${urls.origin}${REMOTE_OAUTH_PATHS.revoke}`,
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

export function createRemoteOAuthHandler(options: RemoteOAuthHandlerOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now;
  const isRelayed = options.isRelayed ?? isRelayedRequest;
  const registrations = tokenBucket(options.registrationBurst ?? 10, 3_600_000, now);
  const pending = new Map<string, PendingConsent>();
  const codes = new Map<string, IssuedCode>();
  const pacer = pairingPacer(now, options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))));

  const sweep = (): void => {
    const at = now();
    for (const [id, entry] of pending) if (entry.expiresAt <= at) pending.delete(id);
    for (const [hash, entry] of codes) if (entry.expiresAt <= at) codes.delete(hash);
  };

  /**
   * Makes room for one more waiting approval: a full table loses its oldest
   * unpinned request (map order is insertion order), else its oldest.
   */
  const admitPending = (): void => {
    if (pending.size < MAX_PENDING_CONSENTS) return;
    const victim = [...pending].find(([, entry]) => !entry.pinned) ?? [...pending][0];
    if (victim) pending.delete(victim[0]);
  };

  const resolveClient = (clientId: string, u: RemotePublicUrls): ResolvedClient | string => {
    const pinned = pinnedClient(clientId);
    if (pinned) return { ...pinned, redirectUris: [...pinned.redirectUris] };
    // Never fetched: an arbitrary metadata URL would make this Mac contact a
    // host a stranger chose.
    if (isClientIdMetadataUrl(clientId)) return 'Olympus connects to ChatGPT. It does not recognize this app.';
    const registered = options.connections().oauth.getRegisteredClient(clientId);
    if (!registered) return 'This app is not registered with Olympus.';
    // Relay mode: self-registered clients are local development tools only.
    if (u.installId && !registered.redirectUris.every(isLoopbackRedirectUri)) return 'This app is not registered with Olympus.';
    return {
      clientId: registered.clientId,
      clientName: registered.clientName,
      redirectUris: registered.redirectUris,
      verifiedHost: undefined,
    };
  };

  /**
   * Relay mode accepts approval only from a direct visit on this Mac: not
   * through the relay, and with a loopback Host.
   */
  const directLoopback = (request: Request): boolean => !isRelayed(request) && loopbackHost(request);
  const notOnThisMac = (): Response =>
    errorPage(403, 'Approve on the Mac where Olympus runs: open the link from ChatGPT on that Mac.');

  const authorizeGet = async (request: Request, u: RemotePublicUrls): Promise<Response> => {
    if (u.installId && !directLoopback(request)) return notOnThisMac();
    const params = new URL(request.url).searchParams;
    const single = singleParams(params);
    if (!single) return errorPage(400, 'The request repeated a parameter.');
    const clientId = single.get('client_id');
    const redirectUri = single.get('redirect_uri');
    if (!clientId) return errorPage(400, 'The request did not name an app (client_id).');
    if (!redirectUri) return errorPage(400, 'The request did not say where to return (redirect_uri).');
    const client = resolveClient(clientId, u);
    if (typeof client === 'string') return errorPage(400, client);
    // Until the redirect URI is known to belong to the client, errors stay on
    // this page: redirecting them would make Olympus an open redirector.
    if (!redirectUriMatches(redirectUri, client.redirectUris)) {
      return errorPage(400, 'The return address is not one this app registered.');
    }
    const state = single.get('state') ?? undefined;
    const fail = (error: string, description: string): Response =>
      redirectWithParams(redirectUri, { error, error_description: description, state, iss: u.issuer });
    if (single.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
    const codeChallenge = single.get('code_challenge');
    if (!codeChallenge || !PKCE_CHALLENGE_PATTERN.test(codeChallenge)) {
      return fail('invalid_request', 'A PKCE code_challenge is required.');
    }
    if (single.get('code_challenge_method') !== 'S256') {
      return fail('invalid_request', 'code_challenge_method must be S256.');
    }
    const requestedResource = single.get('resource');
    if (requestedResource !== null && !isConfiguredResource(requestedResource, u)) {
      return fail('invalid_target', 'The requested resource is not this Olympus.');
    }
    sweep();
    admitPending();
    const requestId = randomBytes(16).toString('hex');
    const csrf = randomBytes(32).toString('base64url');
    const entry: PendingConsent = {
      client,
      redirectUri,
      codeChallenge,
      resource: u.resource,
      state,
      csrf,
      attempts: 0,
      expiresAt: now() + CONSENT_REQUEST_TTL_MS,
      pinned: false,
    };
    pending.set(requestId, entry);
    return consentPage(requestId, entry, u);
  };

  const consentPage = (
    requestId: string,
    entry: PendingConsent,
    u: RemotePublicUrls,
    error?: string,
    showAttempts = true,
  ): Response => {
    const page = u.installId
      ? renderLoopbackConsentPage({
        requestId,
        csrf: entry.csrf,
        clientName: entry.client.clientName,
        verifiedHost: entry.client.verifiedHost,
        redirectHost: redirectHost(entry.redirectUri),
        redirectOrigin: new URL(entry.redirectUri).origin,
      })
      : renderConsentPage({
      requestId,
      csrf: entry.csrf,
      clientName: entry.client.clientName,
      verifiedHost: entry.client.verifiedHost,
      redirectHost: redirectHost(entry.redirectUri),
      redirectOrigin: new URL(entry.redirectUri).origin,
      loopbackRedirect: isLoopbackRedirectUri(entry.redirectUri),
      ...(error ? { error } : {}),
      ...(error && showAttempts ? { attemptsLeft: CONSENT_MAX_ATTEMPTS - entry.attempts } : {}),
    });
    const headers = new Headers(page.headers);
    headers.append('Set-Cookie', consentCookie(requestId, entry.csrf, cookieSecure(u), CONSENT_REQUEST_TTL_MS / 1000));
    return new Response(page.body, { status: error ? 400 : 200, headers });
  };

  const authorizePost = async (request: Request, u: RemotePublicUrls): Promise<Response> => {
    if (u.installId && !directLoopback(request)) return notOnThisMac();
    if (!sameOriginFormPost(request)) return errorPage(403, 'This approval did not come from the Olympus page.');
    const form = await readForm(request);
    if (!form) return errorPage(400, 'The approval form was malformed.');
    const requestId = form.get('request_id') ?? '';
    sweep();
    const entry = /^[a-f0-9]{32}$/.test(requestId) ? pending.get(requestId) : undefined;
    if (!entry) return errorPage(400, 'This approval has expired or was replaced by a newer one. Start again from the app.');
    const csrf = form.get('csrf') ?? '';
    const cookie = readCookie(request, consentCookieName(requestId)) ?? '';
    if (!constantTimeEqual(csrf, entry.csrf) || !constantTimeEqual(cookie, entry.csrf)) {
      return errorPage(403, 'This approval did not come from the Olympus page.');
    }
    const finish = (params: Record<string, string | undefined>): Response => {
      pending.delete(requestId);
      const response = redirectWithParams(entry.redirectUri, { ...params, state: entry.state, iss: u.issuer });
      response.headers.append('Set-Cookie', consentCookie(requestId, '', cookieSecure(u), 0));
      return response;
    };
    const action = form.get('action');
    if (action === 'deny') return finish({ error: 'access_denied', error_description: 'The owner denied the request.' });
    if (action !== 'approve') return errorPage(400, 'The approval form was malformed.');
    const issueCode = (): Response => {
      if (codes.size >= MAX_LIVE_CODES) sweep();
      // Relay mode: the code names this install, so the relay can route its exchange.
      const code = u.installId ? mintCredential('code', u.installId) : randomBytes(32).toString('base64url');
      codes.set(sha256(code), {
        clientId: entry.client.clientId,
        displayName: entry.client.clientName,
        redirectUri: entry.redirectUri,
        codeChallenge: entry.codeChallenge,
        resource: entry.resource,
        expiresAt: now() + AUTHORIZATION_CODE_TTL_MS,
      });
      return finish({ code });
    };
    // Relay mode: a direct loopback visit is the proof of ownership.
    if (u.installId) return issueCode();
    const wait = pacer.delay();
    if (wait > PAIRING_MAX_HELD_MS) {
      return consentPage(requestId, entry, u,
        `Too many wrong codes were tried from here. Wait ${Math.ceil(wait / 1000)} seconds, then try again.`, false);
    }
    await pacer.hold(wait);
    // Pinned only once the pacer has admitted this check: a real, paced
    // attempt. A typo pins nothing (it costs nothing either).
    if (normalizePairingCode(form.get('pairing_code') ?? '') !== undefined) entry.pinned = true;
    const check = options.connections().oauth.checkPairingCode(form.get('pairing_code') ?? '');
    if (!check.ok) {
      if (check.reason === 'malformed') {
        // A typo is not a guess: it names no code, burns nothing, and costs no delay.
        return consentPage(requestId, entry, u, 'A pairing code looks like ABCD-EFGH-JKMN (12 letters and digits).', false);
      }
      pacer.recordFailure();
      entry.attempts += 1;
      if (entry.attempts >= CONSENT_MAX_ATTEMPTS) {
        return finish({ error: 'access_denied', error_description: 'Too many wrong pairing codes.' });
      }
      return consentPage(requestId, entry, u, 'That pairing code is not valid, has expired, or was already used.');
    }
    return issueCode();
  };

  const token = async (request: Request, u: RemotePublicUrls): Promise<Response> => {
    const form = await readForm(request);
    if (!form) return oauthError(400, 'invalid_request', 'The token request must be a form with each parameter once.');
    const grantType = form.get('grant_type');
    const clientId = form.get('client_id');
    const resource = form.get('resource');
    if (resource !== null && !isConfiguredResource(resource, u)) {
      return oauthError(400, 'invalid_target', 'The requested resource is not this Olympus.');
    }
    if (!clientId) return oauthError(400, 'invalid_request', 'client_id is required.');
    const store = options.connections();
    if (grantType === 'authorization_code') {
      const code = form.get('code');
      const verifier = form.get('code_verifier');
      const redirectUri = form.get('redirect_uri');
      if (!code || !verifier || !redirectUri) {
        return oauthError(400, 'invalid_request', 'code, code_verifier and redirect_uri are required.');
      }
      if (!PKCE_VERIFIER_PATTERN.test(verifier)) return oauthError(400, 'invalid_grant', 'The code verifier is malformed.');
      const hash = sha256(code);
      const issued = codes.get(hash);
      if (!issued || issued.expiresAt <= now()) {
        codes.delete(hash);
        return oauthError(400, 'invalid_grant', 'The authorization code is invalid or expired.');
      }
      if (issued.connectionId !== undefined) {
        // A code presented twice: whoever holds it now may not be the client
        // that used it first. Revoke what the first exchange produced.
        codes.delete(hash);
        store.oauth.revokeGrant(issued.connectionId);
        return oauthError(400, 'invalid_grant', 'The authorization code was already used.');
      }
      if (issued.clientId !== clientId || issued.redirectUri !== redirectUri) {
        codes.delete(hash);
        return oauthError(400, 'invalid_grant', 'The authorization code was issued to another client or redirect.');
      }
      if (!constantTimeEqual(createHash('sha256').update(verifier).digest('base64url'), issued.codeChallenge)) {
        codes.delete(hash);
        return oauthError(400, 'invalid_grant', 'The code verifier does not match the challenge.');
      }
      const granted = store.oauth.createGrant({
        clientId,
        displayName: issued.displayName,
        resource: issued.resource,
        ...(u.installId ? { installId: u.installId } : {}),
      });
      issued.connectionId = granted.connection.id;
      return tokenResponse(granted.tokens);
    }
    if (grantType === 'refresh_token') {
      const refreshToken = form.get('refresh_token');
      if (!refreshToken) return oauthError(400, 'invalid_request', 'refresh_token is required.');
      const result = store.oauth.refresh({ refreshToken, clientId, resource: u.resource });
      if (!result.ok) return oauthError(400, 'invalid_grant', 'The refresh token is invalid, expired, or revoked.');
      return tokenResponse(result.tokens);
    }
    return oauthError(400, 'unsupported_grant_type', 'Supported grants: authorization_code, refresh_token.');
  };

  const register = async (request: Request, u: RemotePublicUrls): Promise<Response> => {
    // Relay mode: registration is for local development clients, from this Mac.
    if (u.installId && !directLoopback(request)) return oauthError(403, 'access_denied', 'Registration is available only on this Mac.');
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return oauthError(400, 'invalid_client_metadata', 'Registration must be application/json.');
    }
    const text = await readBounded(request, MAX_REGISTRATION_BYTES);
    if (text === undefined) return oauthError(400, 'invalid_client_metadata', 'Registration is too large.');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return oauthError(400, 'invalid_client_metadata', 'Registration is not JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return oauthError(400, 'invalid_client_metadata', 'Registration must be a JSON object.');
    }
    const metadata = body as Record<string, unknown>;
    const redirectUris = metadata.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10
      || !redirectUris.every((uri) => typeof uri === 'string' && isAcceptableRedirectUri(uri))) {
      return oauthError(400, 'invalid_redirect_uri', 'redirect_uris must list https or loopback URLs.');
    }
    if (u.installId && !(redirectUris as string[]).every(isLoopbackRedirectUri)) {
      return oauthError(400, 'invalid_redirect_uri', 'Only local development clients register; ChatGPT needs no registration.');
    }
    const grantTypes = metadata.grant_types;
    if (grantTypes !== undefined && (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code'))) {
      return oauthError(400, 'invalid_client_metadata', 'Olympus issues authorization_code grants.');
    }
    if (!registrations.take()) {
      return oauthError(429, 'temporarily_unavailable', 'Too many registrations. Try again later.', { 'Retry-After': '600' });
    }
    const uris = redirectUris as string[];
    const clientName = sanitizeCallerDisplayName(metadata.client_name) ?? redirectHost(uris[0]!);
    const registered = options.connections().oauth.registerClient({ clientName, redirectUris: uris });
    if (registered === 'capacity') {
      return oauthError(503, 'temporarily_unavailable', 'Olympus has too many registered apps.');
    }
    // Olympus serves public clients only: whatever auth method was asked for,
    // the answer is `none`, and no secret is issued (RFC 7591 section 3.2.1).
    return jsonResponse(201, {
      client_id: registered.clientId,
      client_id_issued_at: Math.floor(Date.parse(registered.createdAt) / 1000),
      client_name: registered.clientName,
      redirect_uris: registered.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  };

  const revoke = async (request: Request): Promise<Response> => {
    const form = await readForm(request);
    const tokenValue = form?.get('token');
    if (!form || !tokenValue) return oauthError(400, 'invalid_request', 'token is required.');
    options.connections().oauth.revokeToken(tokenValue);
    // RFC 7009: unknown and already-revoked tokens answer 200 too.
    return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  };

  return async (request: Request): Promise<Response> => {
    const urls = currentRemotePublicUrls(options.publicUrls);
    if (!urls) return jsonResponse(404, { error: 'not_found' });
    if (!hostAllowed(request, urls)) return jsonResponse(421, { error: 'misdirected_request' });
    const { pathname } = new URL(request.url);
    const method = request.method;
    try {
      switch (pathname) {
        case REMOTE_OAUTH_PATHS.protectedResource:
        case REMOTE_OAUTH_PATHS.protectedResourceMcp:
          if (method === 'OPTIONS') return metadataPreflight();
          if (method !== 'GET') return methodNotAllowed('GET, OPTIONS');
          return metadataResponse(protectedResourceMetadata(urls));
        case REMOTE_OAUTH_PATHS.authorizationServer:
          if (method === 'OPTIONS') return metadataPreflight();
          if (method !== 'GET') return methodNotAllowed('GET, OPTIONS');
          return metadataResponse(authorizationServerMetadata(urls));
        case REMOTE_OAUTH_PATHS.authorize:
          if (method === 'GET') return await authorizeGet(request, urls);
          if (method === 'POST') return await authorizePost(request, urls);
          return methodNotAllowed('GET, POST');
        case REMOTE_OAUTH_PATHS.token:
          if (method !== 'POST') return methodNotAllowed('POST');
          return await token(request, urls);
        case REMOTE_OAUTH_PATHS.register:
          if (method !== 'POST') return methodNotAllowed('POST');
          return await register(request, urls);
        case REMOTE_OAUTH_PATHS.revoke:
          if (method !== 'POST') return methodNotAllowed('POST');
          return await revoke(request);
        default:
          return jsonResponse(404, { error: 'not_found' });
      }
    } catch {
      return jsonResponse(500, { error: 'server_error' });
    }
  };
}

/**
 * Slows pairing-code guessing without ever closing pairing: each wrong code
 * doubles the wait before the next check (1s, 2s, 4s… up to a minute), and
 * the waits forget failures older than the window.
 */
function pairingPacer(now: () => number, sleep: (ms: number) => Promise<void>): {
  delay(): number;
  hold(ms: number): Promise<void>;
  recordFailure(): void;
} {
  let failures: number[] = [];
  let nextAt = 0;
  return {
    delay() {
      const at = now();
      failures = failures.filter((t) => t > at - PAIRING_FAILURE_WINDOW_MS);
      return Math.max(0, nextAt - at);
    },
    async hold(ms) {
      if (ms > 0) await sleep(ms);
    },
    recordFailure() {
      const at = now();
      failures = [...failures.filter((t) => t > at - PAIRING_FAILURE_WINDOW_MS), at];
      nextAt = at + Math.min(PAIRING_MAX_DELAY_MS, 1000 * 2 ** (failures.length - 1));
    },
  };
}

/** The request's Host is a loopback name (what a direct visit on this Mac carries). */
function loopbackHost(request: Request): boolean {
  const host = (request.headers.get('host') ?? new URL(request.url).host).toLowerCase();
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Relay mode's approval page is plain http on loopback, where a Secure cookie
 * would not be stored; a tunnel's page is served over https.
 */
function cookieSecure(urls: RemotePublicUrls): boolean {
  return urls.installId ? false : urls.secure;
}

function hostAllowed(request: Request, urls: RemotePublicUrls): boolean {
  const host = (request.headers.get('host') ?? new URL(request.url).host).toLowerCase();
  if (host === urls.host) return true;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/** The approval POST must come from the approval page itself. */
function sameOriginFormPost(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  const host = request.headers.get('host') ?? new URL(request.url).host;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function tokenBucket(capacity: number, refillWindowMs: number, now: () => number): { take(): boolean } {
  let tokens = capacity;
  let last = now();
  return {
    take(): boolean {
      const at = now();
      tokens = Math.min(capacity, tokens + ((at - last) / refillWindowMs) * capacity);
      last = at;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

interface SingleParams {
  get(key: string): string | null;
}

/** OAuth parameters must not repeat (RFC 6749 section 3.1); a repeat fails the request. */
function singleParams(params: URLSearchParams): SingleParams | undefined {
  const out = new Map<string, string>();
  for (const [key, value] of params) {
    if (out.has(key)) return undefined;
    out.set(key, value);
  }
  return { get: (key) => out.get(key) ?? null };
}

/** Unauthenticated callers get a small cap and a deadline, not an open socket. */
async function readBounded(request: Request, maxBytes: number): Promise<string | undefined> {
  const body = await readBoundedRequestText(request, maxBytes, { deadlineMs: CONNECT_BODY_DEADLINE_MS });
  return body.ok ? body.text : undefined;
}

async function readForm(request: Request): Promise<SingleParams | undefined> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return undefined;
  }
  const text = await readBounded(request, MAX_FORM_BYTES);
  if (text === undefined) return undefined;
  return singleParams(new URLSearchParams(text));
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function consentCookieName(requestId: string): string {
  return `olympus_consent_${requestId}`;
}

function consentCookie(requestId: string, value: string, secure: boolean, maxAgeSeconds: number): string {
  return `${consentCookieName(requestId)}=${value}; Path=/connect; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function redirectWithParams(redirectUri: string, params: Record<string, string | undefined>): Response {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) target.searchParams.set(key, value);
  return new Response(null, {
    status: 303,
    headers: { Location: target.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

function errorPage(status: number, message: string): Response {
  const page = renderConsentErrorPage(message);
  return new Response(page.body, { status, headers: page.headers });
}

function tokenResponse(tokens: { accessToken: string; refreshToken: string; expiresIn: number }): Response {
  return jsonResponse(200, {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
  }, { Pragma: 'no-cache' });
}

function oauthError(status: number, error: string, description: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(status, { error, error_description: description }, headers);
}

function metadataResponse(body: unknown): Response {
  // Public metadata: browser-based MCP clients may read it cross-origin.
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function metadataPreflight(): Response {
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

function methodNotAllowed(allow: string): Response {
  return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: allow });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

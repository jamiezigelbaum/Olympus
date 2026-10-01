/**
 * Olympus connect relay, version 2.
 *
 * One Bun HTTP server on loopback behind Caddy, which terminates TLS for the
 * relay's single public name (e.g. `mcp.olympusplugin.ai`). It serves:
 *
 * - `GET /v2/connect`: install sessions (WebSocket), authenticated with the
 *   install's Ed25519 key (shared/protocol.ts);
 * - the install-independent OAuth documents and `/healthz` (oauth-metadata.ts);
 * - `GET /connect/authorize`: the bridge page to the owner's own Mac
 *   (authorize-bridge.ts);
 * - `POST /connect/token`, `POST /connect/revoke` and `/mcp`: routed per
 *   request to the install their credential names (shared/tokens.ts). ChatGPT
 *   may reuse one connection for many users, so routing never sticks to a
 *   connection.
 *
 * The relay mints, validates and stores no token: the install does. An
 * authorized request for an install that is registered but offline gets the
 * relay's own small MCP answers (offline.ts).
 *
 * Logging follows log.ts: no bodies, tokens, query strings or addresses.
 */
import type { Server, ServerWebSocket } from 'bun';
import {
  CONNECT_PATH,
  INSTALL_ID_PATTERN,
  PROTOCOL_VERSION,
  decodeBodyFrame,
  installIdForPublicKey,
  newNonce,
  parseTextFrame,
  publicKeyFromSpki,
  spkiOf,
  streamId,
  verifyInstallMessage,
  type ErrorMessage,
  type RelayErrorCode,
} from '../shared/protocol.ts';
import { KeyedCounter, KeyedTokenBuckets, addressKey } from '../shared/rate-limit.ts';
import { credentialInstallId } from '../shared/tokens.ts';
import { authorizeBridge } from './authorize-bridge.ts';
import { DEFAULT_LIMITS, createInstallAdmission, type RelayLimits } from './limits.ts';
import { installTag, type RelayLog } from './log.ts';
import {
  OAUTH_PATHS,
  authorizationServerMetadata,
  metadataPreflight,
  metadataResponse,
  protectedResourceMetadata,
  relayOrigin,
  unauthorized,
} from './oauth-metadata.ts';
import { isDashboardCall, offlineMcpResponse } from './offline.ts';
import { publicKeyOf, type MemoryInstallRegistry, type RegistryCounts } from './registry.ts';
import { InstallSession } from './session.ts';

export interface RelayConfig {
  /** The relay's one public name, e.g. `mcp.olympusplugin.ai`. Issuer and resource derive from it. */
  readonly publicHost: string;
  readonly registry: MemoryInstallRegistry;
  readonly listen?: { readonly host?: string; readonly port?: number };
  /** The engine worker's loopback port, for the authorize bridge (Olympus default 8010). */
  readonly enginePort?: number;
  /** Where the bridge's "Install Olympus" leads. */
  readonly installUrl?: string;
  /**
   * Believe the last `X-Forwarded-For` entry when the peer is loopback (Caddy
   * in front). Off for tests that talk to the relay directly.
   */
  readonly trustProxy?: boolean;
  readonly limits?: Partial<RelayLimits>;
  readonly log?: RelayLog;
  /** How often unused registrations are swept (default hourly). */
  readonly sweepIntervalMs?: number;
  readonly now?: () => number;
}

/** What the operator's `revoke` did. */
export interface RevokeResult {
  readonly installId: string;
  /** False when the id was already revoked. */
  readonly revoked: boolean;
  readonly wasRegistered: boolean;
  readonly wasOnline: boolean;
}

/** Counts only: the relay's status names no install. */
export interface RelayStatus extends RegistryCounts {
  readonly online: number;
  readonly inFlight: number;
  readonly startedAt: string;
}

export interface RelayHandle {
  readonly port: number;
  readonly url: string;
  onlineInstalls(): string[];
  /** Durable revocation: resolves after the registry fsync, then ends the session. */
  revoke(installId: string): Promise<RevokeResult>;
  restore(installId: string): Promise<boolean>;
  status(): RelayStatus;
  sweep(now?: number): string[];
  close(): Promise<void>;
}

interface SocketData {
  readonly ip: string;
  readonly nonce: string;
  readonly releaseIp: () => void;
  authTimer?: ReturnType<typeof setTimeout>;
  /** Counted in `pendingSockets` until it authenticates or closes. */
  pending: boolean;
  session?: InstallSession;
}

const DEFAULT_ENGINE_PORT = 8010;
const DEFAULT_INSTALL_URL = 'https://olympusplugin.ai/';
const MAX_FORM_BYTES = 16 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Request headers forwarded to an install; everything else stays at the relay. */
const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept',
  'authorization',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'user-agent',
]);

export async function startRelay(config: RelayConfig): Promise<RelayHandle> {
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...config.limits };
  const now = config.now ?? Date.now;
  const log: RelayLog = config.log ?? (() => {});
  const registry = config.registry;
  const origin = relayOrigin(config.publicHost);
  const bridge = { enginePort: config.enginePort ?? DEFAULT_ENGINE_PORT, installUrl: config.installUrl ?? DEFAULT_INSTALL_URL };
  const sessions = new Map<string, InstallSession>();
  const admission = createInstallAdmission(limits, now);
  const registrationsPerIp = new KeyedTokenBuckets(limits.registrationsPerIp, now);
  const registrationsGlobal = new KeyedTokenBuckets(limits.registrationsGlobal, now);
  const sessionAttempts = new KeyedTokenBuckets(limits.sessionAttemptsPerIp, now);
  const publicRequests = new KeyedTokenBuckets(limits.publicRequestsPerIp, now);
  const sessionsPerIp = new KeyedCounter();
  let pendingSockets = 0;

  const clientIp = (request: Request, server: Server<SocketData>): string => {
    const peer = server.requestIP(request)?.address;
    if (config.trustProxy && peer && LOOPBACK.has(peer)) {
      const forwarded = request.headers.get('x-forwarded-for')?.split(',').pop()?.trim();
      if (forwarded) return addressKey(forwarded.slice(0, 64));
    }
    return addressKey(peer);
  };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

  const tooMany = () => json(429, { error: 'rate_limited', message: 'Too many requests. Try again shortly.' }, { 'Retry-After': '10' });

  /** Reads a capped body; undefined when it is larger than `max`. */
  const readBody = async (request: Request, max: number): Promise<Uint8Array | undefined> => {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > max) return undefined;
    if (!request.body) return new Uint8Array();
    const parts: Uint8Array[] = [];
    let total = 0;
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  };

  const forwardHeaders = (request: Request): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    request.headers.forEach((value, name) => {
      if (REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase())) out.push([name.toLowerCase(), value]);
    });
    return out;
  };

  /**
   * Sends one request to the install its credential names. `offline` answers
   * when the install is registered but has no session.
   */
  const toInstall = async (input: {
    installId: string;
    request: Request;
    path: string;
    body: Uint8Array;
    dashboard: boolean;
    offline: () => Response;
    unknown: () => Response;
  }): Promise<Response> => {
    const { installId } = input;
    if (registry.isRevoked(installId) || !registry.get(installId)) {
      log('request_refused', { install: installTag(installId), reason: 'unknown_install' });
      return input.unknown();
    }
    const admitted = admission.admit(installId, input.dashboard);
    if (!admitted.ok) {
      log('request_refused', { install: installTag(installId), reason: admitted.reason });
      return admitted.reason === 'busy'
        ? json(503, { error: 'busy', message: 'Olympus on your Mac is busy. Try again shortly.' }, { 'Retry-After': '5' })
        : tooMany();
    }
    const session = sessions.get(installId);
    if (!session?.open) {
      admitted.release();
      return input.offline();
    }
    let response: Response;
    try {
      response = await session.forward({
        method: input.request.method,
        path: input.path,
        headers: forwardHeaders(input.request),
        body: input.body,
        signal: input.request.signal,
      });
    } catch {
      admitted.release();
      log('request_failed', { install: installTag(installId) });
      return json(502, { error: 'bad_gateway' });
    }
    if (!response.body) {
      admitted.release();
      return response;
    }
    // The concurrency slot is held until the streamed body ends or is cut off.
    const release = admitted.release;
    const reader = response.body.getReader();
    const relayed = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            release();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch {
          // Cut off (size or time cap, or the install went away). Bun ends an
          // errored response body the same way as a closed one, so close it
          // without logging a stack per cut-off stream.
          release();
          controller.close();
        }
      },
      cancel(reason) {
        release();
        return reader.cancel(reason);
      },
    });
    return new Response(relayed, { status: response.status, headers: response.headers });
  };

  const mcp = async (request: Request, path: string): Promise<Response> => {
    const authorization = request.headers.get('authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1];
    const installId = credentialInstallId('access', token);
    if (!installId) return unauthorized(origin, token ? 'invalid_token' : undefined);
    const body = await readBody(request, limits.maxRequestBodyBytes);
    if (!body) return json(413, { error: 'payload_too_large' });
    const text = new TextDecoder().decode(body);
    return toInstall({
      installId,
      request,
      path,
      body,
      dashboard: isDashboardCall(text),
      offline: () => offlineMcpResponse({ method: request.method, body: text, lastSeenAt: registry.get(installId)?.lastSeenAt, now: now() }),
      unknown: () => unauthorized(origin, 'invalid_token'),
    });
  };

  /** `/connect/token` and `/connect/revoke`: routed by the credential in the form. */
  const oauthForm = async (request: Request, path: string, kind: 'token' | 'revoke'): Promise<Response> => {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    const body = await readBody(request, MAX_FORM_BYTES);
    if (!body) return json(413, { error: 'invalid_request', error_description: 'The form is too large.' });
    const form = new URLSearchParams(new TextDecoder().decode(body));
    let installId: string | undefined;
    if (kind === 'token') {
      const grant = form.get('grant_type');
      installId = grant === 'authorization_code'
        ? credentialInstallId('code', form.get('code'))
        : grant === 'refresh_token' ? credentialInstallId('refresh', form.get('refresh_token')) : undefined;
    } else {
      const token = form.get('token');
      installId = credentialInstallId('refresh', token) ?? credentialInstallId('access', token);
    }
    const invalidGrant = () => json(400, { error: 'invalid_grant', error_description: 'The grant is invalid, expired, or revoked.' });
    // RFC 7009: revoking an unknown token succeeds.
    const unknown = kind === 'token' ? invalidGrant : () => new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    if (!installId) return unknown();
    return toInstall({
      installId,
      request,
      path,
      body,
      dashboard: false,
      offline: () => json(503, { error: 'temporarily_unavailable', error_description: 'Olympus on your Mac is offline. Try again when your Mac is awake.' }, { 'Retry-After': '30' }),
      unknown,
    });
  };

  // -------------------------------------------------------------------------
  // Install sessions

  const fail = (ws: ServerWebSocket<SocketData>, code: RelayErrorCode, message: string, reason: string) => {
    log('session_rejected', { reason });
    ws.send(JSON.stringify({ type: 'error', code, message } satisfies ErrorMessage));
    ws.close(4000, code);
  };

  const authenticate = (ws: ServerWebSocket<SocketData>, message: Record<string, unknown>): void => {
    clearTimeout(ws.data.authTimer);
    if (message.v !== PROTOCOL_VERSION) return fail(ws, 'unsupported_version', `relay speaks protocol ${PROTOCOL_VERSION}`, 'version');
    const installId = typeof message.installId === 'string' ? message.installId : '';
    const sig = typeof message.sig === 'string' ? message.sig : '';
    if (!INSTALL_ID_PATTERN.test(installId)) return fail(ws, 'bad_request', 'installId is malformed', 'malformed');
    if (registry.isRevoked(installId)) return fail(ws, 'revoked', 'this install was revoked by the relay operator', 'revoked');
    if (message.type === 'register') {
      const publicKey = typeof message.publicKey === 'string' ? message.publicKey : '';
      let key;
      try {
        key = publicKeyFromSpki(publicKey);
      } catch {
        return fail(ws, 'bad_request', 'publicKey must be an Ed25519 SPKI', 'malformed');
      }
      if (installIdForPublicKey(spkiOf(key)) !== installId) return fail(ws, 'id_mismatch', 'installId is not derived from publicKey', 'id_mismatch');
      if (!verifyInstallMessage(key, 'register', ws.data.nonce, installId, sig)) return fail(ws, 'bad_signature', 'register signature rejected', 'signature');
      if (!registry.get(installId)) {
        if (!registrationsPerIp.take(ws.data.ip) || !registrationsGlobal.take('relay')) {
          return fail(ws, 'rate_limited', 'too many registrations; try again later', 'register_rate');
        }
        if (!registry.register(installId, publicKey)) return fail(ws, 'capacity', 'relay registry is full', 'registry_full');
        log('register', { install: installTag(installId) });
      }
    } else if (message.type === 'hello') {
      const record = registry.get(installId);
      if (!record) return fail(ws, 'unregistered', 'install is not registered', 'unregistered');
      if (!verifyInstallMessage(publicKeyOf(record), 'hello', ws.data.nonce, installId, sig)) {
        return fail(ws, 'bad_signature', 'hello signature rejected', 'signature');
      }
    } else {
      return fail(ws, 'bad_request', 'expected hello or register', 'malformed');
    }
    if (!sessions.has(installId) && sessions.size >= limits.maxSessions) return fail(ws, 'capacity', 'relay is at session capacity', 'capacity');
    const previous = sessions.get(installId);
    if (previous) {
      log('session_replaced', { install: installTag(installId) });
      previous.send({ type: 'error', code: 'replaced', message: 'a newer session replaced this one' });
      previous.close(4001, 'replaced');
    }
    const session = new InstallSession(installId, ws, limits);
    ws.data.session = session;
    sessions.set(installId, session);
    registry.seen(installId);
    session.send({ type: 'ready', installId });
    log('session_ready', { install: installTag(installId) });
  };

  const server = Bun.serve<SocketData, never>({
    hostname: config.listen?.host ?? '127.0.0.1',
    port: config.listen?.port ?? 8787,
    // Streaming responses (SSE) may be quiet for long stretches; the relay's
    // own per-stream timers bound them instead (session.ts).
    idleTimeout: 0,
    maxRequestBodySize: limits.maxRequestBodyBytes + 1024,
    async fetch(request, server) {
      const url = new URL(request.url);
      const path = url.pathname;
      const ip = clientIp(request, server);

      if (path === CONNECT_PATH) {
        if (!sessionAttempts.take(ip)) return tooMany();
        if (sessions.size + pendingSockets >= limits.maxSessions) return json(503, { error: 'capacity' });
        const releaseIp = sessionsPerIp.tryAcquire(ip, limits.sessionsPerIp);
        if (!releaseIp) return tooMany();
        const upgraded = server.upgrade(request, { data: { ip, nonce: newNonce(), releaseIp, pending: false } });
        if (!upgraded) {
          releaseIp();
          return json(400, { error: 'websocket_required' });
        }
        return undefined;
      }
      if (path === '/healthz') return json(200, { ok: true });

      // The authorized MCP path is limited per install (toInstall); everything
      // reachable without a routable credential is limited per address.
      const authorizedMcp = path === OAUTH_PATHS.mcp && credentialInstallId('access', /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')?.[1]);
      if (!authorizedMcp && !publicRequests.take(ip)) return tooMany();

      switch (path) {
        case OAUTH_PATHS.protectedResource:
        case OAUTH_PATHS.protectedResourceMcp:
          if (request.method === 'OPTIONS') return metadataPreflight();
          if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, OPTIONS' });
          return metadataResponse(protectedResourceMetadata(origin));
        case OAUTH_PATHS.authorizationServer:
          if (request.method === 'OPTIONS') return metadataPreflight();
          if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, OPTIONS' });
          return metadataResponse(authorizationServerMetadata(origin));
        case OAUTH_PATHS.authorize:
          if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
          return authorizeBridge(url, bridge);
        case OAUTH_PATHS.token:
          return oauthForm(request, OAUTH_PATHS.token, 'token');
        case OAUTH_PATHS.revoke:
          return oauthForm(request, OAUTH_PATHS.revoke, 'revoke');
        case OAUTH_PATHS.mcp:
          return mcp(request, OAUTH_PATHS.mcp);
        default:
          return json(404, { error: 'not_found' });
      }
    },
    websocket: {
      maxPayloadLength: 128 * 1024,
      idleTimeout: 120,
      backpressureLimit: 16 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        pendingSockets += 1;
        ws.data.pending = true;
        ws.data.authTimer = setTimeout(() => ws.close(4000, 'auth_timeout'), limits.authTimeoutMs);
        ws.send(JSON.stringify({ type: 'challenge', v: PROTOCOL_VERSION, nonce: ws.data.nonce }));
      },
      message(ws, data) {
        const session = ws.data.session;
        if (typeof data !== 'string') {
          const frame = decodeBodyFrame(data);
          if (!session || !frame || session.onBody(frame.id, frame.payload) === 'protocol_error') ws.close(4002, 'protocol_error');
          return;
        }
        const message = parseTextFrame(data);
        if (!message) {
          ws.close(4002, 'protocol_error');
          return;
        }
        if (!session) {
          // One authentication attempt per socket: a failure closes it.
          if (!ws.data.pending) return;
          ws.data.pending = false;
          pendingSockets -= 1;
          authenticate(ws, message);
          return;
        }
        if (message.type === 'ping') registry.seen(session.installId);
        if (session.onMessage(message, streamId(message.id)) === 'protocol_error') ws.close(4002, 'protocol_error');
      },
      close(ws) {
        clearTimeout(ws.data.authTimer);
        if (ws.data.pending) {
          ws.data.pending = false;
          pendingSockets -= 1;
        }
        ws.data.releaseIp();
        const session = ws.data.session;
        if (!session) return;
        session.socketClosed();
        if (sessions.get(session.installId) === session) {
          sessions.delete(session.installId);
          log('session_closed', { install: installTag(session.installId) });
        }
      },
    },
  });

  const startedAt = new Date(now()).toISOString();
  const sweep = (at = now()): string[] => {
    const expired = registry.expire(at, limits.inactiveRegistrationTtlMs, (installId) => sessions.has(installId));
    for (const installId of expired) log('registration_expired', { install: installTag(installId) });
    return expired;
  };
  const sweepTimer = setInterval(() => sweep(), config.sweepIntervalMs ?? 60 * 60_000);
  sweepTimer.unref?.();

  return {
    port: server.port!,
    url: `http://${server.hostname}:${server.port}`,
    onlineInstalls: () => [...sessions.keys()],
    async revoke(installId) {
      if (!INSTALL_ID_PATTERN.test(installId)) throw new Error('not an install id');
      const wasRegistered = registry.get(installId) !== undefined;
      const revoked = await registry.revoke(installId);
      const live = sessions.get(installId);
      if (revoked) log('install_revoked', { install: installTag(installId) });
      if (live) {
        live.send({ type: 'error', code: 'revoked', message: 'this install was revoked by the relay operator' });
        live.close(4003, 'revoked');
        sessions.delete(installId);
      }
      return { installId, revoked, wasRegistered, wasOnline: live !== undefined };
    },
    async restore(installId) {
      const restored = await registry.restore(installId);
      if (restored) log('install_restored', { install: installTag(installId) });
      return restored;
    },
    status: () => {
      let inFlight = 0;
      for (const session of sessions.values()) inFlight += session.activeStreams;
      return { ...registry.counts(), online: sessions.size, inFlight, startedAt };
    },
    sweep,
    async close() {
      clearInterval(sweepTimer);
      for (const session of sessions.values()) session.close(1001, 'relay shutting down');
      sessions.clear();
      server.stop(true);
      await registry.flush();
    },
  };
}

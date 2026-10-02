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
 * - `/connect/demo/authorize`: reviewer sign-in, routed only to the one demo
 *   install the relay is configured with (none by default);
 * - `POST /connect/token`, `POST /connect/revoke` and `/mcp`: routed per
 *   request to the install their credential names (shared/tokens.ts). ChatGPT
 *   may reuse one connection for many users, so routing never sticks to a
 *   connection;
 * - `GET /.well-known/openai-apps-challenge`: the domain verification token,
 *   when one is configured;
 * - `POST /private/<job id>` (and its CORS preflight): the private answer
 *   panel collecting one sealed answer, routed by the install the job id
 *   names; only ChatGPT widget origins pass CORS. The relay forwards
 *   ciphertext it holds no key for (shared/private-answer.ts).
 *   `POST /private/<job id>/open` (same CORS, same routing) asks the Mac to
 *   open one of that answer's sources, by a token only the decrypted answer
 *   carries; the relay learns a token only when the panel uses it, so it
 *   could at most repeat an open the owner just asked for (rate limited,
 *   until the job expires), never open anything else.
 *
 * The relay mints, validates and stores no token: the install does. A caller
 * with no token, and an authorized request for an install that is registered
 * but offline, get the relay's own small MCP answers (relay-mcp.ts); neither
 * ever reaches an engine.
 *
 * Logging follows log.ts: no bodies, tokens, query strings or addresses.
 */
import type { Server, ServerWebSocket } from 'bun';
import { createHash } from 'node:crypto';
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
  verifyRegistrationPow,
  type ChallengeMessage,
  type ErrorMessage,
  type RelayErrorCode,
} from '../shared/protocol.ts';
import { INSTALL_URL } from '../shared/dashboard-contract.ts';
import { KeyedCounter, KeyedTokenBuckets, addressKey, prefixKey } from '../shared/rate-limit.ts';
import { HANDOFF_PATH_PREFIX, OAUTH_HANDBACK_PATHS, credentialInstallId, oauthHandbackInstallId } from '../shared/tokens.ts';
import {
  PRIVATE_ANSWER_MAX_REQUEST_BYTES,
  PRIVATE_ANSWER_PATH_PREFIX,
  isPanelOrigin,
  privateAnswerCorsHeaders,
  privateAnswerInstallId,
  privateAnswerJobId,
} from '../shared/private-answer.ts';
import { authorizeBridge } from './authorize-bridge.ts';
import {
  ConfirmedCredentials,
  DEFAULT_LIMITS,
  QueueBudget,
  UploadBudget,
  createInstallAdmission,
  type AdmissionLane,
  type RelayLimits,
} from './limits.ts';
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
import { isDashboardCall, relayMcpResponse } from './relay-mcp.ts';
import { publicKeyOf, type MemoryInstallRegistry, type RegistryCounts } from './registry.ts';
import { createResponsePolicies, type RouteKind } from './response-policy.ts';
import { InstallSession } from './session.ts';

export interface RelayConfig {
  /** The relay's one public name, e.g. `mcp.olympusplugin.ai`. Issuer and resource derive from it. */
  readonly publicHost: string;
  readonly registry: MemoryInstallRegistry;
  readonly listen?: { readonly host?: string; readonly port?: number };
  /** The engine worker's loopback port, for the authorize bridge (Olympus default 8010). */
  readonly enginePort?: number;
  /** Where the bridge's and the not-installed dashboard's "Install Olympus" lead. */
  readonly installUrl?: string;
  /**
   * The demo install (synthetic sample data) directory reviewers sign in to.
   * Unset (the default) means no demo: the bridge offers no demo sign-in and
   * `/connect/demo/authorize` answers 404.
   */
  readonly demoInstallId?: string;
  /** OpenAI's domain verification token, read per request; empty or undefined answers 404. */
  readonly appsChallenge?: () => string | undefined;
  /**
   * Believe the last `X-Forwarded-For` entry when the peer is loopback (Caddy
   * in front). Off for tests that talk to the relay directly.
   */
  readonly trustProxy?: boolean;
  /**
   * Panel origins accepted for `/private/<id>` beyond ChatGPT's widget
   * sandbox (shared/private-answer.ts). None by default: ChatGPT serves the
   * panel from its own sandbox domain, never from the relay origin (which
   * only names the panel, as its `_meta.ui.domain`), and a page on the relay
   * origin is the relay's own or a sandboxed install answer.
   */
  readonly panelOrigins?: readonly string[];
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
  /** Request bodies being uploaded right now. */
  readonly uploading: number;
  /** Response bytes waiting for slow callers. */
  readonly queuedBytes: number;
  readonly startedAt: string;
}

export interface RelayHandle {
  readonly port: number;
  readonly url: string;
  onlineInstalls(): string[];
  /**
   * Revocation: refuses the install and ends its live session at once, and
   * resolves only after the registry write is durable (rejects if it is not;
   * the install stays refused, and a retry writes again).
   */
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
/** OpenAI's domain verification for app submissions. */
const APPS_CHALLENGE_PATH = '/.well-known/openai-apps-challenge';
const DEFAULT_INSTALL_URL = INSTALL_URL;
const MAX_FORM_BYTES = 16 * 1024;
/** How long an engine-confirmed credential keeps the owner lane (an access token lives an hour). */
const CONFIRMED_CREDENTIAL_TTL_MS = 60 * 60_000;
const MAX_CONFIRMED_CREDENTIALS = 100_000;
/** First allocation for a body of unknown length; it grows by doubling up to the cap. */
const INITIAL_BODY_BUFFER_BYTES = 16 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Request headers forwarded to an install; everything else stays at the relay. */
const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept',
  'authorization',
  'content-type',
  // The demo sign-in checks the browser's Origin.
  'origin',
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
  /** What installs sign their session messages for (shared/protocol.ts). */
  const relayHost = config.publicHost.toLowerCase();
  if (config.demoInstallId !== undefined && !INSTALL_ID_PATTERN.test(config.demoInstallId)) {
    throw new Error('demoInstallId must be an install id');
  }
  const bridge = {
    enginePort: config.enginePort ?? DEFAULT_ENGINE_PORT,
    installUrl: config.installUrl ?? DEFAULT_INSTALL_URL,
    demo: config.demoInstallId !== undefined,
  };
  const sessions = new Map<string, InstallSession>();
  const admission = createInstallAdmission(limits, now);
  const registrationsPerIp = new KeyedTokenBuckets(limits.registrationsPerIp, now);
  const registrationsGlobal = new KeyedTokenBuckets(limits.registrationsGlobal, now);
  const reregistrationsPerIp = new KeyedTokenBuckets(limits.reregistrationsPerIp, now);
  const reregistrationsGlobal = new KeyedTokenBuckets(limits.reregistrationsGlobal, now);
  const sessionAttempts = new KeyedTokenBuckets(limits.sessionAttemptsPerIp, now);
  const publicRequests = new KeyedTokenBuckets(limits.publicRequestsPerIp, now);
  const privateFetches = new KeyedTokenBuckets(limits.privateFetchesPerIp, now);
  const egressPerIp = new KeyedTokenBuckets(limits.egressBytesPerIp, now);
  const egressGlobal = new KeyedTokenBuckets(limits.egressBytesGlobal, now);
  const panelOrigins = config.panelOrigins ?? [];
  const policies = createResponsePolicies({ relayOrigin: origin.origin, enginePort: bridge.enginePort });
  const sessionsPerIp = new KeyedCounter();
  const uploads = new UploadBudget(limits);
  const queueBudget = new QueueBudget(limits.maxQueuedBytes);
  const confirmed = new ConfirmedCredentials(CONFIRMED_CREDENTIAL_TTL_MS, MAX_CONFIRMED_CREDENTIALS, now);
  /** Sockets that have not authenticated yet, oldest first. */
  const pendingSockets = new Set<ServerWebSocket<SocketData>>();
  /** A relay-wide registration budget ran dry: logged once per episode, for the operator. */
  const exhausted = { registrations: false, reregistrations: false, egress: false };
  const takeGlobal = (bucket: KeyedTokenBuckets, which: 'registrations' | 'reregistrations'): boolean => {
    if (bucket.take('relay')) {
      exhausted[which] = false;
      return true;
    }
    if (!exhausted[which]) {
      exhausted[which] = true;
      log('budget_exhausted', { budget: which });
    }
    return false;
  };
  /** Response bytes to one caller address and across the relay, every lane. */
  const chargeEgress = (ip: string, bytes: number): boolean => {
    if (!egressPerIp.take(ip, bytes)) return false;
    if (egressGlobal.take('relay', bytes)) {
      exhausted.egress = false;
      return true;
    }
    egressPerIp.refund(ip, bytes);
    if (!exhausted.egress) {
      exhausted.egress = true;
      log('budget_exhausted', { budget: 'egress' });
    }
    return false;
  };

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

  const tooLarge = () => json(413, { error: 'payload_too_large' });

  /**
   * Reads a capped request body. Before the first byte is read it takes an
   * upload ticket (relay-wide and per-address upload counts); the buffer
   * grows only with bytes that actually arrived (a declared length reserves
   * nothing), and each growth is charged to the relay-wide and per-address
   * upload budgets; the upload has an absolute and an idle deadline. None of
   * this depends on the route or on what the credential looks like.
   */
  const readBody = async (
    request: Request,
    max: number,
    ip: string,
  ): Promise<{ ok: true; body: Uint8Array } | { ok: false; response: Response }> => {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > max) return { ok: false, response: tooLarge() };
    if (!request.body) return { ok: true, body: new Uint8Array() };
    const ticket = uploads.begin(ip);
    if (!ticket) {
      log('request_refused', { reason: 'upload_capacity' });
      return { ok: false, response: tooMany() };
    }
    const reader = request.body.getReader();
    const refuse = (response: Response) => {
      void reader.cancel().catch(() => {});
      return { ok: false as const, response };
    };
    try {
      const startedAt = Date.now();
      let buffer = new Uint8Array(0);
      let total = 0;
      const ensure = (needed: number): boolean => {
        if (needed <= buffer.byteLength) return true;
        // At most twice what arrived, or a first small block (no larger than a
        // smaller declared length): a declared Content-Length the caller never
        // sends reserves nothing beyond that block.
        const first = buffer.byteLength === 0
          ? Math.min(INITIAL_BODY_BUFFER_BYTES, Number.isFinite(declared) && declared > 0 ? declared : INITIAL_BODY_BUFFER_BYTES)
          : 0;
        const size = Math.min(max, Math.max(buffer.byteLength * 2, first, needed));
        if (!ticket.charge(size - buffer.byteLength)) return false;
        const grown = new Uint8Array(size);
        grown.set(buffer.subarray(0, total));
        buffer = grown;
        return true;
      };
      for (;;) {
        const wait = Math.min(limits.uploadIdleTimeoutMs, limits.uploadTimeoutMs - (Date.now() - startedAt));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = wait <= 0
          ? undefined
          : await Promise.race([
            reader.read(),
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), wait);
            }),
          ]);
        clearTimeout(timer);
        if (!result) {
          log('request_refused', { reason: 'upload_timeout' });
          return refuse(json(408, { error: 'request_timeout', message: 'The request body did not arrive in time.' }, { Connection: 'close' }));
        }
        if (result.done) break;
        const value = result.value;
        if (total + value.byteLength > max) return refuse(tooLarge());
        if (!ensure(total + value.byteLength)) {
          log('request_refused', { reason: 'upload_capacity' });
          return refuse(json(503, { error: 'busy', message: 'The relay is busy. Try again shortly.' }, { 'Retry-After': '5' }));
        }
        buffer.set(value, total);
        total += value.byteLength;
      }
      return { ok: true, body: buffer.subarray(0, total) };
    } finally {
      ticket.end();
    }
  };

  /** The admission key of a credential: its install and the digest of the whole credential. */
  const credentialKey = (installId: string, token: string) => `${installId}:${createHash('sha256').update(token).digest('base64url')}`;

  /** An id that names no install the relay will route to (never registered, expired, or revoked). */
  const unroutable = (installId: string) => registry.isRevoked(installId) || !registry.get(installId);

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
   *
   * Admission is per install, in the lane the caller chose (limits.ts). The
   * install's engine marks responses to requests it authenticated; an
   * unmarked response refunds the owner lane's rate token and, for an access
   * token, drops its confirmation, while a marked one confirms the credential
   * for its later requests. The concurrency slot is released when the mux
   * stream finishes (session.ts), not when the response head arrives.
   */
  const toInstall = async (input: {
    installId: string;
    request: Request;
    path: string;
    body: Uint8Array;
    lane: AdmissionLane;
    dashboard: boolean;
    /** What the install may answer on this route (response-policy.ts). */
    route: RouteKind;
    /** The caller's address: the key the unverified and control pools share fairly by. */
    ip: string;
    /** Set for an access token: confirmation is tracked for it. */
    credentialKey?: string;
    offline: () => Response;
    unknown: () => Response;
  }): Promise<Response> => {
    const { installId } = input;
    if (unroutable(installId)) {
      log('request_refused', { install: installTag(installId), reason: 'unknown_install' });
      return input.unknown();
    }
    const admitted = await admission.admit(installId, input.lane, input.dashboard, input.ip, input.request.signal);
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
    // From here the install's answer may take minutes or stream quietly: the
    // stream's own timers (session.ts) govern it, not the connection idle limit.
    server.timeout(input.request, 0);
    try {
      return await session.forward({
        method: input.request.method,
        path: input.path,
        headers: forwardHeaders(input.request),
        body: input.body,
        signal: input.request.signal,
        policy: policies[input.route],
        chargeEgress: (bytes) => {
          if (chargeEgress(input.ip, bytes)) return true;
          log('request_refused', { install: installTag(installId), reason: 'egress_budget' });
          return false;
        },
        onRefused: (reason) => log('request_refused', { install: installTag(installId), reason: `response_${reason}` }),
        onHead: (_status, authenticated) => {
          if (authenticated) {
            if (input.credentialKey) confirmed.add(input.credentialKey);
            return;
          }
          admitted.refund();
          if (input.credentialKey) confirmed.delete(input.credentialKey);
        },
        onFinish: admitted.release,
      });
    } catch {
      admitted.release();
      log('request_failed', { install: installTag(installId) });
      return json(502, { error: 'bad_gateway' });
    }
  };

  const mcp = async (request: Request, path: string, ip: string): Promise<Response> => {
    const authorization = request.headers.get('authorization');
    // No credential at all: the relay's own not-installed surface. A caller
    // without a token never reaches an engine.
    if (authorization === null) {
      const anonymous = await readBody(request, Math.min(limits.maxAnonymousRequestBodyBytes, limits.maxRequestBodyBytes), ip);
      if (!anonymous.ok) return anonymous.response;
      return relayMcpResponse({
        method: request.method,
        body: new TextDecoder().decode(anonymous.body),
        now: now(),
        state: 'not_installed',
        installUrl: bridge.installUrl,
        protectedResourceMetadataUrl: origin.protectedResourceMetadataUrl,
      });
    }
    const token = /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1];
    const installId = credentialInstallId('access', token);
    if (!installId) return unauthorized(origin, 'invalid_token');
    // Everything decided from the headers, before any body byte is read: an
    // id that routes nowhere is refused, and a credential the install's engine
    // has not confirmed is paid for by the caller's address, not the install.
    if (unroutable(installId)) {
      if (!publicRequests.take(ip)) return tooMany();
      log('request_refused', { install: installTag(installId), reason: 'unknown_install' });
      return unauthorized(origin, 'invalid_token');
    }
    const key = credentialKey(installId, token!);
    const lane: AdmissionLane = confirmed.has(key) ? 'owner' : 'unverified';
    if (lane === 'unverified' && !publicRequests.take(ip)) return tooMany();
    const read = await readBody(request, limits.maxRequestBodyBytes, ip);
    if (!read.ok) return read.response;
    const body = read.body;
    const text = new TextDecoder().decode(body);
    return toInstall({
      installId,
      request,
      path,
      body,
      lane,
      route: 'api',
      ip,
      // Only an owner-lane call may take the reserved dashboard slot.
      dashboard: lane === 'owner' && isDashboardCall(text),
      credentialKey: key,
      offline: () => relayMcpResponse({
        method: request.method,
        body: text,
        now: now(),
        state: 'mac_offline',
        lastSeenAt: registry.get(installId)?.lastSeenAt,
      }),
      unknown: () => unauthorized(origin, 'invalid_token'),
    });
  };

  /** `/connect/token` and `/connect/revoke`: routed by the credential in the form. */
  const oauthForm = async (request: Request, path: string, kind: 'token' | 'revoke', ip: string): Promise<Response> => {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    const read = await readBody(request, MAX_FORM_BYTES, ip);
    if (!read.ok) {
      return read.response.status === 413
        ? json(413, { error: 'invalid_request', error_description: 'The form is too large.' })
        : read.response;
    }
    const body = read.body;
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
      lane: 'control',
      route: 'api',
      ip,
      dashboard: false,
      offline: () => json(503, { error: 'temporarily_unavailable', error_description: 'Olympus on your Mac is offline. Try again when your Mac is awake.' }, { 'Retry-After': '30' }),
      unknown,
    });
  };

  /** A short plain page for a person's browser (hand-off links and provider callbacks). */
  const browserPage = (status: number, text: string, headers: Record<string, string> = {}) => new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Olympus</title><p style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">${text}</p>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        ...headers,
      },
    },
  );
  const expiredLink = () => browserPage(404, 'This Olympus link has expired or was already used. Go back to ChatGPT and try again.');
  const macOffline = () => browserPage(503, 'Olympus on your Mac is offline. Wake your Mac, then try again from ChatGPT.', { 'Retry-After': '30' });

  /**
   * `GET /go/<oly2g.installId.secret>`: a one-time hand-off link, routed by
   * the install it names. The engine owns single use and expiry.
   */
  const handoff = async (request: Request, path: string, ip: string): Promise<Response> => {
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const installId = credentialInstallId('handoff', path.slice(HANDOFF_PATH_PREFIX.length));
    if (!installId) return expiredLink();
    return toInstall({
      installId,
      request,
      path,
      body: new Uint8Array(),
      // Owner browser hand-offs: the control lane, paced per address.
      lane: 'control',
      route: 'browser',
      ip,
      dashboard: false,
      offline: macOffline,
      unknown: expiredLink,
    });
  };

  /**
   * `GET /oauth/callback/<source>?code&state`: a publisher-app sign-in the
   * engine started for ChatGPT, bounced here by the OAuth callback relay page.
   * Routed by the install prefix of the state's nonce; the engine verifies the
   * signed state, so a forged one opens nothing.
   */
  const oauthHandback = async (request: Request, url: URL, ip: string): Promise<Response> => {
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const installId = oauthHandbackInstallId(url.searchParams.get('state'));
    if (!installId) return expiredLink();
    return toInstall({
      installId,
      request,
      path: `${url.pathname}${url.search}`,
      body: new Uint8Array(),
      // Owner browser hand-offs: the control lane, paced per address.
      lane: 'control',
      route: 'browser',
      ip,
      dashboard: false,
      offline: macOffline,
      unknown: expiredLink,
    });
  };

  /** Reviewer sign-in: GET the page, POST the form, both to the demo install only. */
  const demoSignIn = async (request: Request, path: string, ip: string): Promise<Response> => {
    const demoInstallId = config.demoInstallId;
    if (!demoInstallId) return json(404, { error: 'not_found' });
    if (request.method !== 'GET' && request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
    const read = request.method === 'POST' ? await readBody(request, MAX_FORM_BYTES, ip) : { ok: true as const, body: new Uint8Array() };
    if (!read.ok) return read.response;
    const body = read.body;
    const unavailable = () => new Response('The Olympus demo is not available right now. Try again later.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' },
    });
    return toInstall({ installId: demoInstallId, request, path, body, lane: 'control', route: 'demo', ip, dashboard: false, offline: unavailable, unknown: unavailable });
  };

  /**
   * `/private/<job id>` (and `/private/<job id>/open`, a source-open request
   * by a token from the sealed answer): the private answer panel. CORS
   * is answered here, for ChatGPT widget origins only; the POST is routed by
   * the install its job id names, never logged beyond that install's tag, and
   * capped at a tiny body. The relay sees the panel's public key and the
   * sealed answer, never a key that opens it.
   */
  const privateAnswer = async (request: Request, url: URL, ip: string): Promise<Response> => {
    const requestOrigin = request.headers.get('origin');
    const allowed = isPanelOrigin(requestOrigin, panelOrigins);
    // The widget host's origin is not private; logging refusals shows which
    // ChatGPT surfaces (web, desktop) serve the panel from where.
    if (!allowed) log('panel_origin_refused', { origin: (requestOrigin ?? 'none').slice(0, 120) });
    const cors = allowed ? privateAnswerCorsHeaders(requestOrigin) : {};
    const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      json(status, body, { ...cors, ...headers });
    const jobId = url.search ? undefined : privateAnswerJobId(url.pathname);
    const installId = privateAnswerInstallId(jobId);
    if (!jobId || !installId) return reply(404, { status: 'gone' });
    if (request.method === 'OPTIONS') {
      return allowed ? new Response(null, { status: 204, headers: { ...cors, 'Cache-Control': 'no-store' } }) : reply(403, { status: 'forbidden' });
    }
    if (request.method !== 'POST') return reply(405, { status: 'invalid' }, { Allow: 'POST, OPTIONS' });
    if (!allowed) return reply(403, { status: 'forbidden' });
    if (!privateFetches.take(ip)) return reply(429, { status: 'rate_limited' }, { 'Retry-After': '5' });
    const read = await readBody(request, PRIVATE_ANSWER_MAX_REQUEST_BYTES, ip);
    if (!read.ok) return reply(read.response.status, { status: read.response.status === 413 ? 'invalid' : 'busy' }, { 'Retry-After': '5' });
    const response = await toInstall({
      installId,
      request,
      path: url.pathname,
      body: read.body,
      lane: 'unverified',
      route: 'api',
      ip,
      dashboard: false,
      offline: () => reply(503, { status: 'mac_offline' }, { 'Retry-After': '30' }),
      unknown: () => reply(410, { status: 'gone' }),
    });
    if (response.headers.get('access-control-allow-origin') === requestOrigin) return response;
    // The install's own answer: the relay adds CORS (installs cannot set it).
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
      // One hash, before the signature and before any budget is spent.
      if (!verifyRegistrationPow(limits.registrationPowBits, ws.data.nonce, installId, relayHost, message.pow)) {
        return fail(ws, 'bad_request', 'registration proof of work missing or too weak', 'pow');
      }
      if (!verifyInstallMessage(key, 'register', ws.data.nonce, installId, relayHost, sig)) return fail(ws, 'bad_signature', 'register signature rejected', 'signature');
      if (!registry.get(installId)) {
        // A returning install (registered here before, since expired) and a
        // new one draw on separate budgets, both keyed by the address's
        // allocation (IPv6 /48), so a flood of new ids cannot lock either out.
        const returning = registry.wasRemoved(installId);
        const allocation = prefixKey(ws.data.ip);
        const admitted = returning
          ? reregistrationsPerIp.take(allocation) && takeGlobal(reregistrationsGlobal, 'reregistrations')
          : registrationsPerIp.take(allocation) && takeGlobal(registrationsGlobal, 'registrations');
        if (!admitted) return fail(ws, 'rate_limited', 'too many registrations; try again later', 'register_rate');
        if (!registry.register(installId, publicKey)) return fail(ws, 'capacity', 'relay registry is full', 'registry_full');
        log('register', { install: installTag(installId), returning });
      }
    } else if (message.type === 'hello') {
      const record = registry.get(installId);
      if (!record) return fail(ws, 'unregistered', 'install is not registered', 'unregistered');
      if (!verifyInstallMessage(publicKeyOf(record), 'hello', ws.data.nonce, installId, relayHost, sig)) {
        return fail(ws, 'bad_signature', 'hello signature rejected', 'signature');
      }
      registry.confirm(installId);
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
    const session = new InstallSession(installId, ws, limits, queueBudget);
    ws.data.session = session;
    sessions.set(installId, session);
    registry.seen(installId);
    session.send({ type: 'ready', installId });
    log('session_ready', { install: installTag(installId) });
  };

  /** A socket leaves the pending pool: it authenticated, failed, closed, or was evicted. */
  const unpend = (ws: ServerWebSocket<SocketData>): boolean => {
    if (!ws.data.pending) return false;
    ws.data.pending = false;
    pendingSockets.delete(ws);
    return true;
  };

  const server = Bun.serve<SocketData, never>({
    hostname: config.listen?.host ?? '127.0.0.1',
    port: config.listen?.port ?? 8787,
    // A connection with nothing written to it for this long is closed: that is
    // what ends the transport behind a refusal or a timed-out upload, whatever
    // the caller keeps sending. A request forwarded to an install lifts it
    // (toInstall), so long answers and quiet SSE streams are bounded by their
    // own per-stream timers instead (session.ts).
    idleTimeout: limits.connectionIdleTimeoutSeconds,
    maxRequestBodySize: limits.maxRequestBodyBytes + 1024,
    async fetch(request, server) {
      const url = new URL(request.url);
      const path = url.pathname;
      const ip = clientIp(request, server);

      // No service worker is ever registered from the relay origin: a script
      // fetch for one is refused whatever the route (install answers could
      // otherwise be offered as a worker script).
      if (request.headers.has('service-worker')) return json(403, { error: 'forbidden' });

      if (path === CONNECT_PATH) {
        if (!sessionAttempts.take(prefixKey(ip))) return tooMany();
        // Only authenticated sessions count here; sockets still
        // authenticating have their own pool (websocket.open).
        if (sessions.size >= limits.maxSessions) return json(503, { error: 'capacity' });
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

      // Everything reachable without a routable credential is limited per
      // address here; `/mcp` with one decides its own limit (mcp()). Request
      // bodies on every route are admitted and timed by readBody.
      const routableMcp = path === OAUTH_PATHS.mcp && credentialInstallId('access', /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')?.[1]);
      if (!routableMcp && !publicRequests.take(ip)) return tooMany();

      if (path.startsWith(HANDOFF_PATH_PREFIX)) return handoff(request, path, ip);
      if ((OAUTH_HANDBACK_PATHS as readonly string[]).includes(path)) return oauthHandback(request, url, ip);

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
        case OAUTH_PATHS.demoAuthorize:
          return demoSignIn(request, `${OAUTH_PATHS.demoAuthorize}${url.search}`, ip);
        case OAUTH_PATHS.token:
          return oauthForm(request, OAUTH_PATHS.token, 'token', ip);
        case OAUTH_PATHS.revoke:
          return oauthForm(request, OAUTH_PATHS.revoke, 'revoke', ip);
        case OAUTH_PATHS.mcp:
          return mcp(request, OAUTH_PATHS.mcp, ip);
        case APPS_CHALLENGE_PATH: {
          if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
          const token = config.appsChallenge?.()?.trim();
          if (!token) return json(404, { error: 'not_found' });
          return new Response(token, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
        }
        default:
          if (path.startsWith(PRIVATE_ANSWER_PATH_PREFIX)) return privateAnswer(request, url, ip);
          return json(404, { error: 'not_found' });
      }
    },
    websocket: {
      maxPayloadLength: 128 * 1024,
      idleTimeout: 120,
      backpressureLimit: 16 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        // The pending pool is full: the oldest unauthenticated socket makes
        // room. A real install answers its challenge within a round trip, so
        // stalled sockets cannot keep it out; they only push each other out.
        while (pendingSockets.size >= Math.max(1, limits.maxPendingSockets)) {
          const oldest = pendingSockets.values().next().value!;
          unpend(oldest);
          clearTimeout(oldest.data.authTimer);
          oldest.close(4000, 'pending_capacity');
        }
        ws.data.pending = true;
        pendingSockets.add(ws);
        ws.data.authTimer = setTimeout(() => ws.close(4000, 'auth_timeout'), limits.authTimeoutMs);
        ws.send(JSON.stringify({ type: 'challenge', v: PROTOCOL_VERSION, nonce: ws.data.nonce, pow: limits.registrationPowBits } satisfies ChallengeMessage));
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
          if (!unpend(ws)) return;
          authenticate(ws, message);
          return;
        }
        if (message.type === 'ping') registry.seen(session.installId);
        if (session.onMessage(message, streamId(message.id)) === 'protocol_error') ws.close(4002, 'protocol_error');
      },
      close(ws) {
        clearTimeout(ws.data.authTimer);
        unpend(ws);
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
    const expired = registry.expire(at, limits.inactiveRegistrationTtlMs, (installId) => sessions.has(installId), limits.unconfirmedRegistrationTtlMs);
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
      // The registry refuses the id before this returns; the write may still fail.
      const durable = registry.revoke(installId);
      // The live session ends whatever the write's outcome.
      const live = sessions.get(installId);
      if (live) {
        live.send({ type: 'error', code: 'revoked', message: 'this install was revoked by the relay operator' });
        live.close(4003, 'revoked');
        sessions.delete(installId);
      }
      const revoked = await durable;
      if (revoked) log('install_revoked', { install: installTag(installId) });
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
      return { ...registry.counts(), online: sessions.size, inFlight, uploading: uploads.active, queuedBytes: queueBudget.used, startedAt };
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

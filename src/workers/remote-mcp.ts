/**
 * Remote MCP endpoint: Streamable HTTP at `/mcp` on the worker, for agents
 * outside this machine that hold an owner-approved connection.
 *
 * Auth boundary, both directions:
 * - `/mcp` (and the OpenAPI tool paths, through the same check) accept ONLY a
 *   connection credential the connection store verifies: a bearer connection
 *   token (`olympus_conn_…`), or, when a public base URL is configured, an
 *   OAuth access token (`olympus_at_…`) issued for exactly this resource (see
 *   workers/remote-oauth). The worker's own shared bearer is neither, so it
 *   cannot reach them. A 401 names the protected-resource metadata (RFC 9728)
 *   whenever OAuth is on, which is how Claude, ChatGPT and Grok discover where
 *   to ask the owner for approval.
 * - Every other worker route stays behind `withWorkerBearerAuth`, which
 *   accepts only the worker bearer, so a connection token reaches nothing else.
 *
 * The tool list is the `remote` operation surface (the Hermes list:
 * source_answer, source_answer_result and source_index_status). Each request is served statelessly:
 * one MCP server and transport per HTTP request, JSON responses, no session.
 * The connection's identity is set as the caller by the worker, never taken
 * from the client, and lands on the answer's audit ledger entry.
 */
import { existsSync } from 'node:fs';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { OlympusConfig } from '../core/config.ts';
import { createDelphiTransport, DelphiClient } from '../core/delphi.ts';
import { DirectHttpEmailTransport, EmailClient } from '../core/email.ts';
import { markInProcessRemoteRequest, type OperationCaller } from '../core/operation-caller.ts';
import type { OperationContext } from '../core/operations.ts';
import {
  isWellFormedRemoteConnectionToken,
  type RemoteConnectionRecord,
  type RemoteConnectionStore,
} from '../core/remote-connections.ts';
import { isWellFormedOAuthAccessToken } from '../core/remote-oauth-store.ts';
import { currentRemotePublicUrls, type RemotePublicUrls, type RemotePublicUrlsSource } from '../core/remote-public-url.ts';
import { sourceAnswerJobOwner, type SourceAnswerJobRegistry } from '../core/source-answer-jobs.ts';
import { createOlympusMcpServer } from '../mcp/server.ts';
import { readBoundedRequestText } from './remote-request-body.ts';

export const REMOTE_MCP_PATH = '/mcp';
const IN_PROCESS_WORKER_BASE_URL = 'http://olympus-worker.internal/v1';

export interface RemoteMcpHandlerOptions {
  /**
   * Opened lazily so an unreadable store never blocks worker boot. Returns
   * undefined when no connection database exists yet: an install that never
   * approved a connection has nothing to authenticate against, and a probe
   * must not create one.
   */
  connections: () => RemoteConnectionStore | undefined;
  /** The configured public URLs (or a live source); undefined when OAuth is off (bearer connections only). */
  publicUrls?: RemotePublicUrlsSource;
  /** `signal` is the remote client's request signal; see createInProcessOperationContext. */
  makeOperationContext: (caller: OperationCaller, signal: AbortSignal) => OperationContext;
}

export function isRemoteMcpRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === REMOTE_MCP_PATH;
}

/**
 * Routes `/mcp` to the remote handler and everything else to `rest` (the
 * worker-bearer-authenticated worker). Neither side sees the other's traffic.
 */
export function withRemoteMcpRoute(
  remoteMcp: (request: Request) => Promise<Response>,
  rest: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) => (isRemoteMcpRequest(request) ? remoteMcp(request) : rest(request));
}

export function createRemoteMcpHandler(options: RemoteMcpHandlerOptions): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const verification = authenticateRemoteRequest(request, options);
    if (!verification.ok) return verification.response;
    if (request.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) and no session to end
      // (DELETE). A 405 is how Streamable HTTP says so.
      return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    }
    // Bounded read: the SDK's own `req.json()` would buffer any size of body.
    const body = await readBoundedRequestText(request);
    if (!body.ok) {
      return body.reason === 'too_large'
        ? jsonResponse(413, { error: 'payload_too_large' })
        : jsonResponse(400, { error: 'invalid_request' });
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body.text);
    } catch {
      // Left undefined: the transport then answers its own JSON-RPC parse error.
    }
    const caller = remoteOperationCaller(verification.connection);
    const ctx = options.makeOperationContext(caller, request.signal);
    const server = createOlympusMcpServer('remote', () => ctx);
    // No sessionIdGenerator: stateless mode.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request, {
        authInfo: { token: '', clientId: verification.connection.id, scopes: [] },
        ...(parsedBody !== undefined ? { parsedBody } : {}),
      });
    } finally {
      await server.close().catch(() => undefined);
    }
  };
}

/**
 * The worker's store accessor: opened on first use and kept open, and never
 * created by a request. `olympus connections add` creates the database; until
 * then every token is refused without touching the disk.
 */
/**
 * The one credential check every remote agent route uses (`/mcp` and the
 * OpenAPI tool paths): a bearer connection token, or an OAuth access token
 * bound to this install's configured resource. Refusals are 401s carrying the
 * RFC 9728 pointer when OAuth is on.
 */
export function authenticateRemoteRequest(
  request: Request,
  options: Pick<RemoteMcpHandlerOptions, 'connections' | 'publicUrls'>,
): { ok: true; connection: Pick<RemoteConnectionRecord, 'id' | 'displayName'> } | { ok: false; response: Response } {
  const urls = currentRemotePublicUrls(options.publicUrls);
  const refuse = (error?: 'invalid_token') => ({ ok: false as const, response: unauthorized(error, urls) });
  const token = bearerToken(request.headers.get('Authorization'));
  if (token === undefined) return refuse();
  const oauthToken = urls !== undefined && isWellFormedOAuthAccessToken(token);
  if (!oauthToken && !isWellFormedRemoteConnectionToken(token)) return refuse('invalid_token');
  let store: RemoteConnectionStore | undefined;
  try {
    store = options.connections();
  } catch {
    return { ok: false, response: jsonResponse(503, { error: 'remote_connections_unavailable' }) };
  }
  if (!store) return refuse('invalid_token');
  if (oauthToken) {
    // Audience binding: only a token issued for this resource opens it.
    const verification = store.oauth.verifyAccessToken(token, urls!.resource);
    return verification.ok ? { ok: true, connection: verification.connection } : refuse('invalid_token');
  }
  const verification = store.verifyToken(token);
  return verification.ok ? { ok: true, connection: verification.connection } : refuse('invalid_token');
}

export function lazyRemoteConnectionStore(
  resolvePath: () => string,
  open: (dbPath: string) => RemoteConnectionStore,
): (options?: { create?: boolean }) => RemoteConnectionStore | undefined {
  let store: RemoteConnectionStore | undefined;
  // `create` is for the OAuth endpoints only, which run only when the owner
  // configured a public base URL: a hosted agent registers before the owner
  // pairs it, so the database must exist by then. `/mcp` never creates it.
  return (options = {}) => {
    if (store) return store;
    const dbPath = resolvePath();
    if (!options.create && !existsSync(dbPath)) return undefined;
    store = open(dbPath);
    return store;
  };
}

export function remoteOperationCaller(connection: Pick<RemoteConnectionRecord, 'id' | 'displayName'>): OperationCaller {
  return { surface: 'remote', connectionId: connection.id, displayName: connection.displayName };
}

/**
 * The operation context the remote endpoint runs tools with: the worker's own
 * config, and an email client whose transport calls the worker's inner
 * handler in-process. That handler is the one the worker bearer unlocks, so
 * the remote surface reaches exactly the answer path every other surface does,
 * and nothing is exposed that the `remote` tool list does not name.
 */
export function createInProcessOperationContext(input: {
  config: OlympusConfig;
  sourceIndexReadEnabled: boolean;
  workerFetch: (request: Request) => Promise<Response>;
  caller: OperationCaller;
  /**
   * The remote client's request signal. It is joined to each in-process
   * request, so a client that disconnects aborts its worker request the same
   * way a disconnecting HTTP caller aborts one — until a slow source_answer
   * hands off to a background job, which detaches it (see
   * core/source-answer-jobs.ts).
   */
  signal?: AbortSignal;
  /** The worker's hand-off registry; without it source_answer never hands off. */
  sourceAnswerJobs?: SourceAnswerJobRegistry;
}): OperationContext {
  const config: OlympusConfig = {
    ...input.config,
    email: { ...input.config.email, enabled: true, baseUrl: IN_PROCESS_WORKER_BASE_URL },
    sourceIndex: { ...input.config.sourceIndex, enabled: input.sourceIndexReadEnabled },
  };
  const client = detachableSignal(input.signal);
  const transport = new DirectHttpEmailTransport(
    (url, init) => {
      const signals = [init.signal, client.signal].filter((signal): signal is AbortSignal => signal != null);
      const request = new Request(url, {
        ...init,
        ...(signals.length > 0 ? { signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals) } : {}),
      });
      // Marked so the worker accepts this request's `remote` caller; see
      // operation-caller.ts. No HTTP request can be in this set.
      return input.workerFetch(markInProcessRemoteRequest(request));
    },
    undefined,
    config.email.requestTimeoutSeconds * 1000,
  );
  const owner = sourceAnswerJobOwner(input.caller);
  return {
    config,
    delphi: new DelphiClient(config, createDelphiTransport(config)),
    email: new EmailClient(config, transport),
    caller: input.caller,
    ...(input.sourceAnswerJobs && owner
      ? {
          sourceAnswerJobs: {
            registry: input.sourceAnswerJobs,
            owner,
            ...(input.signal ? { clientSignal: input.signal } : {}),
            detachFromClient: client.detach,
          },
        }
      : {}),
  };
}

/**
 * Follows `upstream` until detached. Before detaching, an upstream abort
 * aborts this signal; afterwards it no longer can.
 */
function detachableSignal(upstream: AbortSignal | undefined): { signal: AbortSignal | undefined; detach: () => void } {
  if (!upstream) return { signal: undefined, detach: () => undefined };
  const controller = new AbortController();
  if (upstream.aborted) {
    controller.abort(upstream.reason);
    return { signal: controller.signal, detach: () => undefined };
  }
  const follow = () => controller.abort(upstream.reason);
  upstream.addEventListener('abort', follow, { once: true });
  return { signal: controller.signal, detach: () => upstream.removeEventListener('abort', follow) };
}

export function bearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  return match?.[1];
}

export function unauthorized(error?: 'invalid_token', urls?: RemotePublicUrls): Response {
  // RFC 6750 challenge; with OAuth on, the RFC 9728 resource_metadata pointer
  // is what starts a hosted agent's authorization flow.
  const parts = ['realm="olympus"'];
  if (urls) parts.push(`resource_metadata="${urls.protectedResourceMetadataUrl}"`);
  if (error) {
    parts.push(`error="${error}"`, 'error_description="The connection token is not valid or has been revoked."');
  }
  const challenge = `Bearer ${parts.join(', ')}`;
  return jsonResponse(401, { error: error ?? 'unauthorized' }, { 'WWW-Authenticate': challenge });
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

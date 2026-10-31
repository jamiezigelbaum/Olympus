/**
 * Remote MCP endpoint: Streamable HTTP at `/mcp` on the worker, for agents
 * outside this machine that hold an owner-approved connection.
 *
 * Auth boundary, both directions:
 * - `/mcp` (and the OpenAPI tool paths, through the same check) accept ONLY a
 *   connection credential the connection store verifies: a bearer connection
 *   token (`olympus_conn_…`), or, when a public base URL is configured, an
 *   OAuth access token (`oly2.<installId>.…` through the relay, `olympus_at_…`
 *   behind a tunnel of the owner's own) issued for exactly this resource (see
 *   workers/remote-oauth). The worker's own shared bearer is neither, so it
 *   cannot reach them. A 401 names the protected-resource metadata (RFC 9728)
 *   whenever OAuth is on, which is how ChatGPT discovers where to ask the
 *   owner for approval.
 * - Every other worker route stays behind `withWorkerBearerAuth`, which
 *   accepts only the worker bearer, so a connection token reaches nothing else.
 *
 * `/openai/mcp` is the ChatGPT plugin directory's endpoint
 * (connect-relay/shared/directory-tools.ts): its own protected resource, so
 * only an OAuth access token issued for `<origin>/openai/mcp` opens it (a
 * bearer connection token names no resource and is refused), and only the
 * ChatGPT surface is served there, narrowed to the directory's tool allowlist
 * (chatgpt/directory-surface.ts). `/mcp` is unchanged.
 *
 * The tool list is the `remote` operation surface (the Hermes list:
 * source_answer, source_answer_result, source_index_status and
 * ask_anonymously), plus the evidence search `olympus_search` when the worker
 * supplies one (workers/remote-search.ts), which also hides source_answer
 * while no answer model is set up and, for every connection but a demo grant,
 * settles the connection's Private part (core/remote-private-part.ts) so a
 * Private match waits in the computer's Inbox. Each request is served statelessly:
 * one MCP server and transport per HTTP request, JSON responses, no session.
 * The connection's identity is set as the caller by the worker, never taken
 * from the client, and lands on the answer's audit ledger entry.
 */
import { existsSync } from 'node:fs';
import { readConsultSettings } from '../core/consult-settings.ts';
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
import { isRelayedRequest } from '../core/remote-access.ts';
import { isWellFormedOAuthAccessToken, remoteConnectionProvider } from '../core/remote-oauth-store.ts';
import { currentRemotePublicUrls, remoteMcpResource, type RemotePublicUrls, type RemotePublicUrlsSource } from '../core/remote-public-url.ts';
import { sourceAnswerJobOwner, type SourceAnswerJobRegistry } from '../core/source-answer-jobs.ts';
import { createOlympusMcpServer, type McpServerExtension } from '../mcp/server.ts';
import { createChatGptMcpServer, type ChatGptSurfaceOptions } from './chatgpt/mcp-surface.ts';
import { createChatGptDirectoryMcpServer } from './chatgpt/directory-surface.ts';
import { remoteSearchExtension, type RemoteSearchOptions } from './remote-search.ts';
import { DEMO_GRANT_REMOTE_TOOLS, DIRECTORY_MCP_PATH, type McpSurface } from '../../connect-relay/shared/directory-tools.ts';
import { readBoundedRequestText } from './remote-request-body.ts';
import { remoteErrorOutput, remoteRetryAfterSeconds, remoteSurfaceErrorOutput } from '../core/remote-result.ts';
import { AUTHENTICATED_RESPONSE_HEADER, SURFACE_RESPONSE_HEADER, credentialInstallId } from '../../connect-relay/shared/tokens.ts';

export const REMOTE_MCP_PATH = '/mcp';
/** The read-only tools a demo grant gets on the remote surface (shared with the relay's offline answers). */
export { DEMO_GRANT_REMOTE_TOOLS };
/** The ChatGPT plugin directory's endpoint. */
export const REMOTE_DIRECTORY_MCP_PATH = DIRECTORY_MCP_PATH;
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
  /**
   * The ChatGPT surface (workers/chatgpt): the answer tools with
   * ChatGPT-written descriptions, the dashboard tool and its MCP Apps
   * resource, every response through the allowlisted response builder.
   * Served only to requests `servesRequest` accepts; every other caller keeps
   * the remote operation surface unchanged.
   */
  /**
   * Whether a request came through this Mac's relay child (default: its
   * marker carries the child's per-boot secret, core/remote-access.ts).
   */
  isRelayed?: (request: Request) => boolean;
  chatgpt?: ChatGptSurfaceOptions & {
    /** Whether this request, from this connection, gets the ChatGPT surface. */
    servesRequest: (request: Request, connection: RemoteMcpConnection) => boolean;
    /** Whether this connection gets only the surface's read-only tools (a demo grant). */
    readOnlyFor?: (connection: RemoteMcpConnection) => boolean;
  };
  /**
   * The evidence search for every caller not served the ChatGPT surface
   * (workers/remote-search.ts). Absent: the operation list alone.
   */
  search?: RemoteSearchOptions;
  /** Read on each listing; absent or invalid settings leave anonymous answers off. */
  anonymousAnswersEnabled?: () => boolean;
  /**
   * Whether a connection is a demo sign-in grant (remote-oauth/demo-consent.ts
   * isDemoGrant). One not served the ChatGPT surface gets only
   * DEMO_GRANT_REMOTE_TOOLS here and on the OpenAPI paths: no spending
   * (ask_anonymously, source_answer) for a reviewer holding a shared password.
   */
  demoGrant?: (connection: RemoteMcpConnection) => boolean;
  /** Builds the directory endpoint's server (default createChatGptDirectoryMcpServer; tests narrow its allowlist). */
  directoryServer?: typeof createChatGptDirectoryMcpServer;
}

/** The verified connection behind a remote request; `clientId` for OAuth grants, `provider` as stored. */
export type RemoteMcpConnection = Pick<RemoteConnectionRecord, 'id' | 'displayName'> & {
  clientId?: string | null;
  provider?: RemoteConnectionRecord['provider'];
};

export function isRemoteMcpRequest(request: Request): boolean {
  return remoteMcpSurface(request) !== undefined;
}

/** Which MCP endpoint a request names, or undefined for any other path. */
export function remoteMcpSurface(request: Request): McpSurface | undefined {
  const { pathname } = new URL(request.url);
  if (pathname === REMOTE_MCP_PATH) return 'default';
  if (pathname === REMOTE_DIRECTORY_MCP_PATH) return 'directory';
  return undefined;
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
  const isRelayed = options.isRelayed ?? isRelayedRequest;
  return async (request: Request): Promise<Response> => {
    try {
      const surface = remoteMcpSurface(request) ?? 'default';
      const verification = authenticateRemoteRequest(request, options, surface);
      if (!verification.ok) return verification.response;
      const response = await serveAuthenticated(request, verification, surface);
      // Only the relay reads the mark; a direct caller never sees it.
      if (!isRelayed(request)) return response;
      return markAuthenticated(response, options.chatgpt?.servesRequest(request, verification.connection) === true ? 'chatgpt' : 'remote');
    } catch (error) {
      // Anything thrown before or around the MCP transport (building the
      // operation context, the surface choice, the transport itself) is a
      // fixed JSON error, never the runtime's default page with the exception
      // in it, and never carries the relay's authenticated mark.
      return remoteFailureResponse(error);
    }
  };

  async function serveAuthenticated(
    request: Request,
    verification: { connection: RemoteMcpConnection },
    surface: McpSurface,
  ): Promise<Response> {
    if (request.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) and no session to end
      // (DELETE). A 405 is how Streamable HTTP says so.
      return jsonResponse(405, remoteSurfaceErrorOutput('method_not_allowed'), { Allow: 'POST' });
    }
    // Bounded read: the SDK's own `req.json()` would buffer any size of body.
    const body = await readBoundedRequestText(request);
    if (!body.ok) {
      return body.reason === 'too_large'
        ? jsonResponse(413, remoteSurfaceErrorOutput('payload_too_large'))
        : jsonResponse(400, remoteSurfaceErrorOutput('invalid_request'));
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body.text);
    } catch {
      // Left undefined: the transport then answers its own JSON-RPC parse error.
    }
    const caller = remoteOperationCaller(verification.connection);
    const ctx = options.makeOperationContext(caller, request.signal);
    const chatgpt = options.chatgpt?.servesRequest(request, verification.connection)
      ? { ...options.chatgpt, readOnly: options.chatgpt.readOnlyFor?.(verification.connection) === true }
      : undefined;
    // The directory endpoint serves the ChatGPT surface only.
    if (surface === 'directory' && !chatgpt) return jsonResponse(404, remoteSurfaceErrorOutput('not_found'));
    const detached = () => options.makeOperationContext(caller, new AbortController().signal);
    const demo = options.demoGrant?.(verification.connection) === true;
    const server = chatgpt
      ? surface === 'directory'
        ? (options.directoryServer ?? createChatGptDirectoryMcpServer)(() => ctx, chatgpt, detached)
        : createChatGptMcpServer(() => ctx, chatgpt, detached)
      : createOlympusMcpServer('remote', () => ctx, anonymousListing(options.anonymousAnswersEnabled, demoGrantLimit(demo, options.search
        ? remoteSearchExtension(options.search, () => stillAuthorized(request, verification.connection, options, surface), {
          // A demo sign-in grant is a shared password: its searches never write to the owner's Inbox.
          ...(!demo && ctx.remotePrivatePart ? { privatePart: ctx.remotePrivatePart } : {}),
          ...(ctx.releaseCheck ? { releaseCheck: ctx.releaseCheck } : {}),
          // The agent hanging up cancels its search, Private part included.
          signal: request.signal,
        })
        : undefined)));
    // No sessionIdGenerator: stateless mode.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request, {
        authInfo: { token: '', clientId: verification.connection.id, scopes: [] },
        ...(parsedBody !== undefined ? { parsedBody } : {}),
      });
      return chatgpt ? response : await withToolRetryAfter(response);
    } finally {
      await server.close().catch(() => undefined);
    }
  }
}

function anonymousListing(enabled: (() => boolean) | undefined, inner: McpServerExtension | undefined): McpServerExtension {
  return {
    tools: (listed) => {
      const tools = inner ? inner.tools(listed) : listed;
      const read = enabled ? undefined : readConsultSettings();
      const on = enabled ? enabled() : read?.state === 'valid' && read.settings.enabled;
      return on ? tools : tools.filter((tool) => tool.name !== 'ask_anonymously');
    },
    call: async (request, next, signal) => inner ? await inner.call(request, next, signal) : await next(),
  };
}

/**
 * A demo grant's remote surface: `inner`'s tools narrowed to
 * DEMO_GRANT_REMOTE_TOOLS, and a call to any other answered as an unknown
 * tool before it runs. Any other connection gets `inner` unchanged.
 */
function demoGrantLimit(demo: boolean, inner: McpServerExtension | undefined): McpServerExtension | undefined {
  if (!demo) return inner;
  return {
    tools: (listed) => (inner ? inner.tools(listed) : listed).filter((tool) => DEMO_GRANT_REMOTE_TOOLS.includes(tool.name)),
    call: async (request, next, signal) => {
      if (!DEMO_GRANT_REMOTE_TOOLS.includes(request.params.name)) {
        return { content: [{ type: 'text', text: JSON.stringify(remoteSurfaceErrorOutput('unknown_operation'), null, 2) }], isError: true };
      }
      return inner ? await inner.call(request, next, signal) : await next();
    },
  };
}

/**
 * A remote tool result that asks the agent to wait (a busy refusal, core/
 * remote-result.ts retry_after_seconds) also says so as HTTP Retry-After, as
 * the OpenAPI surface does. Any other response passes through untouched.
 */
async function withToolRetryAfter(response: Response): Promise<Response> {
  if (response.status !== 200 || !(response.headers.get('Content-Type') ?? '').includes('application/json')) return response;
  const text = await response.text();
  const rebuilt = (headers: Headers) => new Response(text, { status: response.status, statusText: response.statusText, headers });
  if (!text.includes('retry_after_seconds')) return rebuilt(response.headers);
  let retryAfter: number | undefined;
  try {
    const message = JSON.parse(text) as { result?: { isError?: unknown; content?: Array<{ type?: unknown; text?: unknown }> } };
    const first = message.result?.isError === true ? message.result.content?.[0] : undefined;
    if (first?.type === 'text' && typeof first.text === 'string') retryAfter = remoteRetryAfterSeconds(JSON.parse(first.text));
  } catch {
    // Not a single tool error: no header.
  }
  if (retryAfter === undefined) return rebuilt(response.headers);
  const headers = new Headers(response.headers);
  headers.set('Retry-After', String(retryAfter));
  return rebuilt(headers);
}

/**
 * Marks a response to a request whose credential was verified. The connect
 * relay uses the mark only to keep that credential's later requests in the
 * owner's admission lane, so forged secrets cannot spend the owner's budget
 * (connect-relay/server/limits.ts); it grants nothing. Only relayed requests
 * get it, and the relay drops it before its public response. The surface
 * mark tells the relay which tool list this credential gets, so its own
 * answers while the Mac is offline never show one client another's tools
 * (connect-relay/server/relay-mcp.ts).
 */
function markAuthenticated(response: Response, surface: 'chatgpt' | 'remote'): Response {
  const headers = new Headers(response.headers);
  headers.set(AUTHENTICATED_RESPONSE_HEADER, '1');
  headers.set(SURFACE_RESPONSE_HEADER, surface);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * The worker's store accessor: opened on first use and kept open, and never
 * created by a request. `olympus connections add` creates the database; until
 * then every token is refused without touching the disk.
 */
/**
 * The one credential check every remote agent route uses (`/mcp`, the
 * directory's `/openai/mcp` and the OpenAPI tool paths): a bearer connection
 * token, or an OAuth access token bound to the configured resource of the
 * endpoint it reached. The directory endpoint takes OAuth access tokens only.
 * Refusals are 401s carrying that endpoint's RFC 9728 pointer when OAuth is on.
 */
export function authenticateRemoteRequest(
  request: Request,
  options: Pick<RemoteMcpHandlerOptions, 'connections' | 'publicUrls'>,
  surface: McpSurface = 'default',
): { ok: true; connection: RemoteMcpConnection } | { ok: false; response: Response } {
  const urls = currentRemotePublicUrls(options.publicUrls);
  const endpoint = urls ? remoteMcpResource(urls, surface) : undefined;
  const refuse = (error?: 'invalid_token') => ({ ok: false as const, response: unauthorized(error, urls, endpoint?.protectedResourceMetadataUrl) });
  const token = bearerToken(request.headers.get('Authorization'));
  if (token === undefined) return refuse();
  const oauthToken = urls !== undefined && isWellFormedOAuthAccessToken(token);
  if (!oauthToken && (surface === 'directory' || !isWellFormedRemoteConnectionToken(token))) return refuse('invalid_token');
  let store: RemoteConnectionStore | undefined;
  try {
    store = options.connections();
  } catch {
    return connectionsUnavailable();
  }
  if (!store) return refuse('invalid_token');
  let verification: ReturnType<RemoteConnectionStore['verifyToken']> | ReturnType<RemoteConnectionStore['oauth']['verifyAccessToken']>;
  try {
    // Audience binding: only an OAuth token issued for this resource opens it.
    verification = oauthToken ? store.oauth.verifyAccessToken(token, endpoint!.resource) : store.verifyToken(token);
    // A Linux owner-created API key uses the relay access-token envelope but
    // remains a revocable bearer connection. It never opens the directory
    // resource or bypasses an expired/revoked/wrong-audience OAuth grant.
    if (oauthToken && !verification.ok && verification.reason === 'unknown'
      && surface === 'default' && urls?.installId
      && credentialInstallId('access', token) === urls.installId) {
      verification = store.verifyToken(token);
    }
  } catch {
    // A store that cannot be read (closed, locked, corrupt) refuses with a
    // fixed 503; the exception's text never reaches the caller.
    return connectionsUnavailable();
  }
  return verification.ok ? { ok: true, connection: verification.connection } : refuse('invalid_token');
}

/**
 * The request's credential verified again (the remote search, before it
 * releases evidence): `active` only for the same connection, still valid.
 */
function stillAuthorized(
  request: Request,
  connection: RemoteMcpConnection,
  options: Pick<RemoteMcpHandlerOptions, 'connections' | 'publicUrls'>,
  surface: McpSurface,
): 'active' | 'revoked' | 'unavailable' {
  const again = authenticateRemoteRequest(request, options, surface);
  if (again.ok) return again.connection.id === connection.id ? 'active' : 'revoked';
  return again.response.status === 503 ? 'unavailable' : 'revoked';
}

function connectionsUnavailable(): { ok: false; response: Response } {
  return { ok: false, response: jsonResponse(503, remoteSurfaceErrorOutput('remote_connections_unavailable')) };
}

/** A thrown failure on a remote agent route: a fixed internal_error body with a log ref, never marked. */
export function remoteFailureResponse(error: unknown): Response {
  return jsonResponse(500, remoteErrorOutput(error));
}

/**
 * The outer exception boundary for a remote agent route (`/mcp`,
 * `/openai/mcp`, the OpenAPI tool paths), applied where the server composes
 * them: whatever escapes the route's own handling becomes a fixed JSON error
 * rather than reaching the runtime's default error page.
 */
export function withRemoteFailureBoundary(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      return remoteFailureResponse(error);
    }
  };
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

/**
 * The remote caller, with the host its connection records
 * (core/remote-oauth-store.ts remoteConnectionProvider): a pinned client's
 * grant by its client id (ChatGPT → OpenAI, Claude → Anthropic, Grok and
 * Grok Bot or Cursor → xAI), any other connection by the agent it was
 * created for or the name it was approved under, else `other`. Every remote
 * caller has one, so a host Olympus does not know is said, not silent.
 */
export function remoteOperationCaller(connection: RemoteMcpConnection): OperationCaller {
  const provider = remoteConnectionProvider({ clientId: connection.clientId ?? null, displayName: connection.displayName, chosen: connection.provider ?? null });
  return { surface: 'remote', connectionId: connection.id, displayName: connection.displayName, provider };
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

export function unauthorized(error?: 'invalid_token', urls?: RemotePublicUrls, protectedResourceMetadataUrl = urls?.protectedResourceMetadataUrl): Response {
  // RFC 6750 challenge; with OAuth on, the RFC 9728 resource_metadata pointer
  // is what starts a hosted agent's authorization flow.
  const parts = ['realm="olympus"'];
  if (urls) parts.push(`resource_metadata="${protectedResourceMetadataUrl}"`);
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

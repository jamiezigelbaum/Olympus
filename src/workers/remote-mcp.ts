/**
 * Remote MCP endpoint: Streamable HTTP at `/mcp` on the worker, for agents
 * outside this machine that hold an owner-approved connection.
 *
 * Auth boundary, both directions:
 * - `/mcp` accepts ONLY a connection token (`Authorization: Bearer
 *   olympus_conn_…`) that the connection store verifies. The worker's own
 *   shared bearer is not a connection token, so it cannot reach `/mcp`.
 * - Every other worker route stays behind `withWorkerBearerAuth`, which
 *   accepts only the worker bearer, so a connection token reaches nothing else.
 *
 * The tool list is the `remote` operation surface (the Hermes list:
 * source_answer and source_index_status). Each request is served statelessly:
 * one MCP server and transport per HTTP request, JSON responses, no session.
 * The connection's identity is set as the caller by the worker, never taken
 * from the client, and lands on the answer's audit ledger entry.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { OlympusConfig } from '../core/config.ts';
import { createDelphiTransport, DelphiClient } from '../core/delphi.ts';
import { DirectHttpEmailTransport, EmailClient } from '../core/email.ts';
import type { OperationCaller } from '../core/operation-caller.ts';
import type { OperationContext } from '../core/operations.ts';
import type { RemoteConnectionRecord, RemoteConnectionStore } from '../core/remote-connections.ts';
import { createOlympusMcpServer } from '../mcp/server.ts';

export const REMOTE_MCP_PATH = '/mcp';
const IN_PROCESS_WORKER_BASE_URL = 'http://olympus-worker.internal/v1';

export interface RemoteMcpHandlerOptions {
  /** Opened lazily so an unreadable store never blocks worker boot. */
  connections: () => RemoteConnectionStore;
  makeOperationContext: (caller: OperationCaller) => OperationContext;
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
    const token = bearerToken(request.headers.get('Authorization'));
    if (token === undefined) return unauthorized();
    let store: RemoteConnectionStore;
    try {
      store = options.connections();
    } catch {
      return jsonResponse(503, { error: 'remote_connections_unavailable' });
    }
    const verification = store.verifyToken(token);
    if (!verification.ok) return unauthorized('invalid_token');
    if (request.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) and no session to end
      // (DELETE). A 405 is how Streamable HTTP says so.
      return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    }
    const caller = remoteOperationCaller(verification.connection);
    const ctx = options.makeOperationContext(caller);
    const server = createOlympusMcpServer('remote', () => ctx);
    // No sessionIdGenerator: stateless mode.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request, {
        authInfo: { token: '', clientId: verification.connection.id, scopes: [] },
      });
    } finally {
      await server.close().catch(() => undefined);
    }
  };
}

export function remoteOperationCaller(connection: RemoteConnectionRecord): OperationCaller {
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
}): OperationContext {
  const config: OlympusConfig = {
    ...input.config,
    email: { ...input.config.email, enabled: true, baseUrl: IN_PROCESS_WORKER_BASE_URL },
    sourceIndex: { ...input.config.sourceIndex, enabled: input.sourceIndexReadEnabled },
  };
  const transport = new DirectHttpEmailTransport(
    (url, init) => input.workerFetch(new Request(url, init)),
    undefined,
    config.email.requestTimeoutSeconds * 1000,
  );
  return {
    config,
    delphi: new DelphiClient(config, createDelphiTransport(config)),
    email: new EmailClient(config, transport),
    caller: input.caller,
  };
}

function bearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  return match?.[1];
}

function unauthorized(error?: 'invalid_token'): Response {
  // Shaped for the OAuth slice: RFC 6750 challenge now, a resource_metadata
  // parameter (RFC 9728) once protected-resource metadata is served.
  const challenge = error
    ? `Bearer realm="olympus", error="${error}", error_description="The connection token is not valid or has been revoked."`
    : 'Bearer realm="olympus"';
  return jsonResponse(401, { error: error ?? 'unauthorized' }, { 'WWW-Authenticate': challenge });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/**
 * The dashboard's "Connect an agent" backend: remote-access status, the
 * connection list the Setup page shows, and the three control routes that
 * change connection state.
 *
 * The routes live under /dashboard, so workers/http.ts gives them exactly the
 * custody every other dashboard control has: the worker bearer (the Gateway
 * bridge), or a live HttpOnly SameSite=Strict control session plus the CSRF
 * header from the same origin. The read-only dash_ token never reaches them.
 *
 * - POST /dashboard/agents/pairing-code mints the same one-time code as
 *   `olympus connections pair`, from the same store.
 * - POST /dashboard/agents/keys creates a bearer connection, as
 *   `olympus connections add <name>` does, and returns its token once.
 * - POST /dashboard/agents/revoke revokes a connection by id.
 *
 * Codes and tokens appear only in the response body of the request that
 * minted them, with `Cache-Control: no-store`. Nothing here logs.
 *
 * Remote-access status is a thin adapter so the relay's status (the
 * `olympus connections status` shape, once it lands) can replace the
 * environment reading in one place.
 */
import type { RemoteConnectionRecord, RemoteConnectionStore } from '../core/remote-connections.ts';
import { resolveRemotePublicUrls } from '../core/remote-public-url.ts';
import { sanitizeCallerDisplayName } from '../core/operation-caller.ts';

export const DASHBOARD_AGENT_PAIRING_CODE_PATH = '/dashboard/agents/pairing-code';
export const DASHBOARD_AGENT_KEYS_PATH = '/dashboard/agents/keys';
export const DASHBOARD_AGENT_REVOKE_PATH = '/dashboard/agents/revoke';

export const DASHBOARD_AGENT_CONTROL_PATHS = [
  DASHBOARD_AGENT_PAIRING_CODE_PATH,
  DASHBOARD_AGENT_KEYS_PATH,
  DASHBOARD_AGENT_REVOKE_PATH,
] as const;

/**
 * Whether agents in a vendor's cloud can reach this computer.
 *
 * `not_connected` is for a configured relay whose link is down; the
 * environment adapter below never produces it, the relay status will.
 */
export type DashboardRemoteAccess =
  | { state: 'on'; mcpUrl: string; openapiUrl: string }
  | { state: 'off' }
  | { state: 'not_connected' }
  | { state: 'invalid'; detail: string };

export interface DashboardAgentConnection {
  id: string;
  name: string;
  kind: 'bearer' | 'oauth';
  createdAt: string;
  lastUsedAt: string | null;
}

/** What the Setup page renders. Revoked connections are not listed. */
export interface DashboardAgentsView {
  remoteAccess: DashboardRemoteAccess;
  connections: DashboardAgentConnection[];
  /** The connection database could not be opened; the list is unknown, not empty. */
  unavailable?: boolean;
}

export interface DashboardAgentConnectionsBackend {
  /** The worker's connection store. `create` opens (and creates) the database. */
  store(options?: { create?: boolean }): RemoteConnectionStore | undefined;
  remoteAccess(): DashboardRemoteAccess;
}

/** Today's adapter: remote access is on exactly when the OAuth switch is. */
export function remoteAccessFromEnv(env: Record<string, string | undefined>): DashboardRemoteAccess {
  const resolved = resolveRemotePublicUrls(env);
  if (resolved.enabled) {
    return {
      state: 'on',
      mcpUrl: resolved.urls.resource,
      openapiUrl: `${resolved.urls.origin}/openapi.json`,
    };
  }
  if (resolved.reason === 'invalid') {
    return { state: 'invalid', detail: resolved.detail ?? 'The public address is not valid.' };
  }
  return { state: 'off' };
}

export function dashboardAgentsView(backend: DashboardAgentConnectionsBackend): DashboardAgentsView {
  const remoteAccess = backend.remoteAccess();
  let records: RemoteConnectionRecord[];
  try {
    records = backend.store()?.list() ?? [];
  } catch {
    return { remoteAccess, connections: [], unavailable: true };
  }
  return {
    remoteAccess,
    connections: records
      .filter((record) => record.revokedAt === null)
      .map((record) => ({
        id: record.id,
        name: record.displayName,
        kind: record.kind,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
      })),
  };
}

/**
 * Serves the three control routes, or returns undefined for any other request.
 * Auth is the caller's: workers/http.ts has already proven custody.
 */
export async function handleDashboardAgentRequest(
  request: Request,
  pathname: string,
  backend: DashboardAgentConnectionsBackend | undefined,
): Promise<Response | undefined> {
  if (request.method !== 'POST' || !(DASHBOARD_AGENT_CONTROL_PATHS as readonly string[]).includes(pathname)) {
    return undefined;
  }
  if (!backend) {
    return refusal(501, 'agent_connections_not_supported', 'This worker does not manage agent connections.');
  }
  const body = await objectBody(request);
  if (!body) return refusal(400, 'invalid_request', 'Request body must be a JSON object.');

  if (pathname === DASHBOARD_AGENT_PAIRING_CODE_PATH) {
    if (Object.keys(body).length !== 0) return refusal(400, 'invalid_request', 'A pairing code takes no fields.');
    const remoteAccess = backend.remoteAccess();
    // The code is only typed on the approval page, which exists only when
    // agents can reach this computer. A code minted before that is noise.
    if (remoteAccess.state !== 'on') {
      return refusal(409, 'remote_access_off', remoteAccessRefusal(remoteAccess));
    }
    const store = openStore(backend);
    if (!store) return storeUnavailable();
    const minted = store.oauth.mintPairingCode();
    return secretResponse({
      ok: true,
      code: minted.code,
      expires_at: minted.expiresAt,
      url: remoteAccess.mcpUrl,
    });
  }

  if (pathname === DASHBOARD_AGENT_KEYS_PATH) {
    const unknown = Object.keys(body).filter((key) => key !== 'name');
    if (unknown.length > 0) return refusal(400, 'invalid_request', 'A key takes only a name.');
    const name = sanitizeCallerDisplayName(body.name);
    if (!name) return refusal(400, 'invalid_request', 'Give the connection a name, for example Muse.');
    const store = openStore(backend);
    if (!store) return storeUnavailable();
    const created = store.create(name);
    const remoteAccess = backend.remoteAccess();
    return secretResponse({
      ok: true,
      token: created.token,
      connection: connectionView(created.connection),
      ...(remoteAccess.state === 'on' ? { mcp_url: remoteAccess.mcpUrl, openapi_url: remoteAccess.openapiUrl } : {}),
    });
  }

  const unknown = Object.keys(body).filter((key) => key !== 'connection_id');
  if (unknown.length > 0) return refusal(400, 'invalid_request', 'Revoke takes only a connection_id.');
  const id = typeof body.connection_id === 'string' ? body.connection_id : '';
  if (!/^[a-f0-9]{18}$/.test(id)) return refusal(400, 'invalid_request', 'That is not a connection id.');
  const store = openStore(backend, false);
  const existing = store?.list().find((record) => record.id === id);
  if (!store || !existing) return refusal(404, 'connection_not_found', 'No connection has that id.');
  const revoked = store.revoke(id);
  return secretResponse({
    ok: true,
    connection: connectionView(revoked),
    status_message: `${revoked.displayName} can no longer ask Olympus.`,
  });
}

function remoteAccessRefusal(access: DashboardRemoteAccess): string {
  if (access.state === 'invalid') return `Remote access is not set up correctly: ${access.detail}`;
  if (access.state === 'not_connected') return 'Remote access is not connected right now, so no agent could use a pairing code. Try again once it reconnects.';
  return 'Remote access is off, so agents in the cloud cannot reach Olympus yet. Pairing codes work once it is on.';
}

function openStore(backend: DashboardAgentConnectionsBackend, create = true): RemoteConnectionStore | undefined {
  try {
    return backend.store({ create });
  } catch {
    return undefined;
  }
}

function storeUnavailable(): Response {
  return refusal(503, 'agent_connections_unavailable', 'Olympus could not open its connection list. Try again, or run olympus doctor.');
}

function connectionView(record: RemoteConnectionRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.displayName,
    kind: record.kind,
    created_at: record.createdAt,
    last_used_at: record.lastUsedAt,
    revoked_at: record.revokedAt,
  };
}

async function objectBody(request: Request): Promise<Record<string, unknown> | undefined> {
  let value: unknown;
  try {
    const text = await request.text();
    value = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return undefined;
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Every answer here may carry a secret or a connection fact: never cached. */
function secretResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function refusal(status: number, code: string, message: string): Response {
  return secretResponse({ ok: false, error: { code, message } }, status);
}

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
 * - POST /dashboard/agents/remote-access turns remote access on or off. On
 *   needs the owner's acceptance of the CA's current subscriber agreement,
 *   recorded exactly as `olympus connections terms --accept` records it; the
 *   config change itself goes through OpenClaw's config write path in the
 *   Gateway (core/remote-access-config.ts), never a file Olympus writes.
 *
 * Codes and tokens appear only in the response body of the request that
 * minted them, with `Cache-Control: no-store`. Nothing here logs.
 *
 * Remote-access status comes from the relay's status through one thin
 * adapter, `remoteAccessFromStatus`.
 */
import type { RemoteConnectionRecord, RemoteConnectionStore } from '../core/remote-connections.ts';
import type { RemotePublicUrls } from '../core/remote-public-url.ts';
import type { RemoteAccessStatusView } from '../core/remote-access.ts';
import { sanitizeCallerDisplayName } from '../core/operation-caller.ts';

export const DASHBOARD_AGENT_PAIRING_CODE_PATH = '/dashboard/agents/pairing-code';
export const DASHBOARD_AGENT_KEYS_PATH = '/dashboard/agents/keys';
export const DASHBOARD_AGENT_REVOKE_PATH = '/dashboard/agents/revoke';
export const DASHBOARD_AGENT_REMOTE_ACCESS_PATH = '/dashboard/agents/remote-access';

export const DASHBOARD_AGENT_CONTROL_PATHS = [
  DASHBOARD_AGENT_PAIRING_CODE_PATH,
  DASHBOARD_AGENT_KEYS_PATH,
  DASHBOARD_AGENT_REVOKE_PATH,
  DASHBOARD_AGENT_REMOTE_ACCESS_PATH,
] as const;

/** Where the dashboard links for the agreement when the CA names no URL of its own. */
export const LETS_ENCRYPT_REPOSITORY_URL = 'https://letsencrypt.org/repository/';

/**
 * Whether agents in a vendor's cloud can reach this computer.
 *
 * `not_connected`: remote access is on, but agents cannot reach Olympus right
 * now: connecting, certificate pending, the agreement to accept
 * (`needsTerms`), the relay unavailable or its process down. That includes a
 * relay session that went offline after it worked, even though the public
 * address is kept for when it returns. `detail` says which, in the owner's
 * words.
 */
export type DashboardRemoteAccess =
  | { state: 'on'; mcpUrl: string; openapiUrl: string }
  | { state: 'off' }
  | { state: 'not_connected'; detail?: string; needsTerms?: true }
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
  /** Turn on / Turn off remote access; absent, the route answers 501. */
  remoteAccessControl?: DashboardRemoteAccessControl | undefined;
}

/** The result of asking OpenClaw to change `remote.enabled`. */
export type RemoteAccessConfigWrite =
  | { ok: true; unchanged?: boolean }
  | { ok: false; status: number; code: string; message: string };

export interface DashboardRemoteAccessControl {
  /**
   * The CA's current subscriber agreement (`resolveCurrentTermsUrl`):
   * undefined when the CA names none. Throws when it cannot be read.
   */
  currentTermsUrl(): Promise<string | undefined>;
  /** `termsAccepted` for that agreement. */
  termsAccepted(url: string | undefined): boolean;
  /** `recordTermsAcceptance`, as `olympus connections terms --accept`. */
  recordTermsAcceptance(url: string | undefined): void;
  /** Change `remote.enabled` through OpenClaw's config write path (never a file write here). */
  setEnabled(enabled: boolean): Promise<RemoteAccessConfigWrite>;
}

/**
 * The adapter from the relay's status (`olympus connections status`,
 * `RemoteAccessStatusView`) to what the panel shows. `live` is the public
 * address the worker is serving OAuth and `/mcp` on right now; "on" also
 * needs a relay session that is online, so it means exactly what hosted
 * agents will find. A relay that went offline keeps its address for when it
 * returns, but the panel says not connected, with the reason, and mints no
 * pairing codes meanwhile.
 */
export function remoteAccessFromStatus(input: {
  live: RemotePublicUrls | undefined;
  status: (Pick<RemoteAccessStatusView, 'error' | 'mode' | 'remote_enabled' | 'next_step'>
    & Partial<Pick<RemoteAccessStatusView, 'relay' | 'certificate'>>) | undefined;
}): DashboardRemoteAccess {
  const status = input.status;
  const relayDown = status?.mode === 'relay' && status.relay !== undefined && status.relay.state !== 'online';
  if (input.live && !relayDown) {
    return { state: 'on', mcpUrl: input.live.resource, openapiUrl: `${input.live.origin}/openapi.json` };
  }
  if (status?.error) return { state: 'invalid', detail: status.error };
  if (status && status.mode !== 'off' && status.remote_enabled) {
    if (status.mode === 'relay') return relayNotConnected(status);
    return status.next_step ? { state: 'not_connected', detail: status.next_step } : { state: 'not_connected' };
  }
  return { state: 'off' };
}

/** Not connected through the relay, said for the owner rather than a shell. */
function relayNotConnected(
  status: Pick<RemoteAccessStatusView, 'next_step'> & Partial<Pick<RemoteAccessStatusView, 'relay' | 'certificate'>>,
): DashboardRemoteAccess {
  const relay = status.relay?.state;
  if (status.certificate?.state === 'awaiting_terms') {
    return {
      state: 'not_connected',
      needsTerms: true,
      detail: 'Olympus needs you to accept Let\'s Encrypt\'s subscriber agreement before it can get its certificate.',
    };
  }
  if (relay === 'offline' || relay === 'replaced') {
    return {
      state: 'not_connected',
      detail: 'Olympus relay unavailable, so agents in the cloud cannot reach Olympus right now. Olympus keeps trying on its own.',
    };
  }
  if (relay === 'not_running') {
    return {
      state: 'not_connected',
      detail: 'The remote access process has stopped. Olympus restarts it on its own; if this stays, restart OpenClaw.',
    };
  }
  if (relay === 'online' && status.certificate?.state === 'failed') {
    return { state: 'not_connected', detail: 'Olympus could not get its certificate yet. It tries again on its own.' };
  }
  if (relay === 'online') return { state: 'not_connected', detail: 'Olympus is getting its certificate.' };
  if (relay === undefined || relay === null) {
    return status.next_step ? { state: 'not_connected', detail: status.next_step } : { state: 'not_connected' };
  }
  return { state: 'not_connected', detail: 'Olympus is connecting to its relay.' };
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

  if (pathname === DASHBOARD_AGENT_REMOTE_ACCESS_PATH) return setRemoteAccess(body, backend);

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

/**
 * Turn remote access on or off. On first checks the owner has accepted the
 * CA's *current* subscriber agreement: without an acceptance it answers 409
 * `terms_required` with the agreement's URL, and the page shows it; the owner's
 * explicit acceptance comes back with that same URL, and is recorded exactly
 * as `olympus connections terms --accept` records it. If the CA published a
 * different agreement meanwhile, the acceptance is refused (`terms_changed`)
 * and the new one is shown instead. Off needs no agreement.
 */
async function setRemoteAccess(
  body: Record<string, unknown>,
  backend: DashboardAgentConnectionsBackend,
): Promise<Response> {
  const unknown = Object.keys(body).filter((key) => key !== 'enabled' && key !== 'accept_terms');
  if (unknown.length > 0 || typeof body.enabled !== 'boolean') {
    return refusal(400, 'invalid_request', 'Say whether to turn remote access on or off.');
  }
  let acceptedUrl: string | null | undefined;
  if (body.accept_terms !== undefined) {
    const accept = body.accept_terms;
    const record = accept && typeof accept === 'object' && !Array.isArray(accept) ? accept as Record<string, unknown> : undefined;
    if (!body.enabled || !record || Object.keys(record).length !== 1 || !('url' in record)
      || (record.url !== null && !isHttpsUrl(record.url))) {
      return refusal(400, 'invalid_request', 'An agreement acceptance names the agreement it accepts.');
    }
    acceptedUrl = record.url as string | null;
  }
  const control = backend.remoteAccessControl;
  if (!control) {
    return refusal(501, 'remote_access_control_not_supported', 'This Olympus cannot turn remote access on or off from the dashboard.');
  }
  if (body.enabled) {
    let current: string | undefined;
    try {
      current = await control.currentTermsUrl();
    } catch {
      return refusal(
        502,
        'terms_unavailable',
        'Olympus could not read Let\'s Encrypt\'s subscriber agreement just now. Check the internet connection, then try again.',
      );
    }
    const terms = { url: current ?? null, read_url: current ?? LETS_ENCRYPT_REPOSITORY_URL };
    if (acceptedUrl !== undefined) {
      if (acceptedUrl !== (current ?? null)) {
        return secretResponse({
          ok: false,
          error: {
            code: 'terms_changed',
            message: 'Let\'s Encrypt has published a new subscriber agreement. Read it, then accept it to continue.',
          },
          terms,
        }, 409);
      }
      control.recordTermsAcceptance(current);
    } else if (!control.termsAccepted(current)) {
      return secretResponse({
        ok: false,
        error: {
          code: 'terms_required',
          message: 'Read Let\'s Encrypt\'s subscriber agreement, then accept it to turn on remote access.',
        },
        terms,
      }, 409);
    }
  }
  const written = await control.setEnabled(body.enabled).catch((): RemoteAccessConfigWrite => ({
    ok: false,
    status: 502,
    code: 'openclaw_unreachable',
    message: 'Olympus could not reach OpenClaw to change the setting. Check that OpenClaw is running, then try again.',
  }));
  if (!written.ok) return refusal(written.status, written.code, written.message);
  return secretResponse({
    ok: true,
    enabled: body.enabled,
    status_message: body.enabled
      ? 'Remote access is turning on. Olympus connects to its relay and gets a certificate, which usually takes a minute.'
      : 'Remote access is off. Agents in the cloud can no longer reach Olympus; agents on this computer are unaffected.',
  });
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function remoteAccessRefusal(access: DashboardRemoteAccess): string {
  if (access.state === 'invalid') return `Remote access is not set up correctly: ${access.detail}`;
  if (access.state === 'not_connected') {
    return `Remote access is not connected yet, so no agent could use a pairing code. Try again once it is.${access.detail ? ` ${access.detail}` : ''}`;
  }
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

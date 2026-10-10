/**
 * Who asked. Attribution only: the calling agent's identity is recorded on the
 * answer's audit entry so the owner can see what each surface or connection
 * asked. It never changes what may be released: every calling agent receives
 * the same release policy (see `ReleaseDestination` 'calling_agent').
 */
export type OperationCallerSurface = 'native' | 'mcp' | 'cli' | 'remote';

export const OPERATION_CALLER_SURFACES: readonly OperationCallerSurface[] = ['native', 'mcp', 'cli', 'remote'];

/**
 * Who hosts the calling agent, when a surface can tell: OpenAI (a ChatGPT
 * grant, by the relay's pinned client ids) or Anthropic (a Claude client, by
 * its MCP client name). It chooses which anonymous-answer model setting a
 * question takes (never the provider that holds the conversation); it grants
 * nothing, so a label-based guess is harmless.
 */
export type OperationCallerProvider = 'openai' | 'anthropic';
export const OPERATION_CALLER_PROVIDERS: readonly OperationCallerProvider[] = ['openai', 'anthropic'];

export interface OperationCaller {
  surface: OperationCallerSurface;
  /** Stable id of an owner-approved connection (remote surfaces). */
  connectionId?: string;
  /** Human label, e.g. the MCP client's name or a connection's display name. */
  displayName?: string;
  /** Who hosts the agent, when the surface can tell. */
  provider?: OperationCallerProvider;
}

/** The worker HTTP wire shape of {@link OperationCaller}. */
export interface OperationCallerWire {
  surface: OperationCallerSurface;
  connection_id?: string;
  display_name?: string;
  provider?: OperationCallerProvider;
}

export const OPERATION_CALLER_DISPLAY_NAME_MAX = 80;
export const OPERATION_CALLER_CONNECTION_ID_MAX = 128;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
// C0/C1 controls and bidi overrides: an audit label must read as what it is.
const UNSAFE_LABEL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Best-effort cleanup for a display name a client supplied about itself (for
 * example MCP `clientInfo.name`). Returns undefined when nothing usable is left.
 */
export function sanitizeCallerDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(UNSAFE_LABEL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, OPERATION_CALLER_DISPLAY_NAME_MAX);
}

/**
 * The hosting provider an agent's self-reported name suggests ("claude-code",
 * "Claude Desktop", "ChatGPT", "codex"); undefined for anything else. A
 * ChatGPT grant is recognised by its client id instead (remote-mcp.ts).
 */
export function callerProviderFromLabel(label: string | undefined): OperationCallerProvider | undefined {
  if (!label) return undefined;
  if (/claude|anthropic/i.test(label)) return 'anthropic';
  if (/chatgpt|openai|codex/i.test(label)) return 'openai';
  return undefined;
}

export function operationCallerToWire(caller: OperationCaller): OperationCallerWire {
  const displayName = sanitizeCallerDisplayName(caller.displayName);
  return {
    surface: caller.surface,
    ...(caller.connectionId ? { connection_id: caller.connectionId } : {}),
    ...(displayName ? { display_name: displayName } : {}),
    ...(caller.provider ? { provider: caller.provider } : {}),
  };
}

/**
 * Strict parse of the wire shape. Returns an error message instead of throwing
 * so each boundary can raise its own error type.
 */
export function parseOperationCallerWire(
  value: unknown,
): { ok: true; caller: OperationCallerWire | undefined } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, caller: undefined };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'caller must be an object when provided.' };
  }
  const record = value as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((key) => !['surface', 'connection_id', 'display_name', 'provider'].includes(key));
  if (unknownFields.length > 0) {
    return { ok: false, message: `caller contains undeclared fields: ${unknownFields.sort().join(', ')}.` };
  }
  if (typeof record.surface !== 'string' || !(OPERATION_CALLER_SURFACES as readonly string[]).includes(record.surface)) {
    return { ok: false, message: `caller.surface must be one of: ${OPERATION_CALLER_SURFACES.join(', ')}.` };
  }
  let connectionId: string | undefined;
  if (record.connection_id !== undefined) {
    if (
      typeof record.connection_id !== 'string'
      || record.connection_id.length === 0
      || record.connection_id.length > OPERATION_CALLER_CONNECTION_ID_MAX
      || !CONNECTION_ID_PATTERN.test(record.connection_id)
    ) {
      return { ok: false, message: 'caller.connection_id must be a short identifier when provided.' };
    }
    connectionId = record.connection_id;
  }
  let displayName: string | undefined;
  if (record.display_name !== undefined) {
    displayName = sanitizeCallerDisplayName(record.display_name);
    if (typeof record.display_name !== 'string' || displayName === undefined) {
      return { ok: false, message: 'caller.display_name must be a non-empty string when provided.' };
    }
  }
  let provider: OperationCallerProvider | undefined;
  if (record.provider !== undefined) {
    if (typeof record.provider !== 'string' || !(OPERATION_CALLER_PROVIDERS as readonly string[]).includes(record.provider)) {
      return { ok: false, message: `caller.provider must be one of: ${OPERATION_CALLER_PROVIDERS.join(', ')}.` };
    }
    provider = record.provider as OperationCallerProvider;
  }
  return {
    ok: true,
    caller: {
      surface: record.surface as OperationCallerSurface,
      ...(connectionId ? { connection_id: connectionId } : {}),
      ...(displayName ? { display_name: displayName } : {}),
      ...(provider ? { provider } : {}),
    },
  };
}

// Requests the worker's own remote MCP endpoint builds in-process after it has
// verified a connection token. Only these may carry a `remote` caller or a
// connection id: an ordinary worker-bearer HTTP caller cannot put a request
// object into this set, so it cannot impersonate an approved connection on the
// audit ledger. A WeakSet, so nothing outlives its request.
const inProcessRemoteRequests = new WeakSet<Request>();

export function markInProcessRemoteRequest(request: Request): Request {
  inProcessRemoteRequests.add(request);
  return request;
}

export function isInProcessRemoteRequest(request: Request): boolean {
  return inProcessRemoteRequests.has(request);
}

/** Whether a caller claims a connection identity only the remote endpoint may assert. */
export function callerClaimsRemoteConnection(caller: OperationCallerWire): boolean {
  return caller.surface === 'remote' || caller.connection_id !== undefined;
}

/**
 * Who asked. Attribution only: the calling agent's identity is recorded on the
 * answer's audit entry so the owner can see what each surface or connection
 * asked. It never changes what may be released: every calling agent receives
 * the same release policy (see `ReleaseDestination` 'calling_agent').
 */
export type OperationCallerSurface = 'native' | 'mcp' | 'cli' | 'remote';

export const OPERATION_CALLER_SURFACES: readonly OperationCallerSurface[] = ['native', 'mcp', 'cli', 'remote'];

export interface OperationCaller {
  surface: OperationCallerSurface;
  /** Stable id of an owner-approved connection (remote surfaces). */
  connectionId?: string;
  /** Human label, e.g. the MCP client's name or a connection's display name. */
  displayName?: string;
}

/** The worker HTTP wire shape of {@link OperationCaller}. */
export interface OperationCallerWire {
  surface: OperationCallerSurface;
  connection_id?: string;
  display_name?: string;
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

export function operationCallerToWire(caller: OperationCaller): OperationCallerWire {
  const displayName = sanitizeCallerDisplayName(caller.displayName);
  return {
    surface: caller.surface,
    ...(caller.connectionId ? { connection_id: caller.connectionId } : {}),
    ...(displayName ? { display_name: displayName } : {}),
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
  const unknownFields = Object.keys(record).filter((key) => !['surface', 'connection_id', 'display_name'].includes(key));
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
  return {
    ok: true,
    caller: {
      surface: record.surface as OperationCallerSurface,
      ...(connectionId ? { connection_id: connectionId } : {}),
      ...(displayName ? { display_name: displayName } : {}),
    },
  };
}

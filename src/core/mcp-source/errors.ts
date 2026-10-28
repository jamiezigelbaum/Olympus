/**
 * What can go wrong reading a provider through its MCP server
 * (docs/CREATE_CONNECTOR.md, "MCP sources"), as a closed set of kinds. Each
 * kind has one dashboard state, so the source's card says what to do next.
 * A message never carries server text: a tool's error output is the provider's
 * words, and only the kind crosses this boundary.
 */

export type McpSourceErrorKind =
  /** No sign-in is stored for this source. */
  | 'auth_missing'
  /** The access token expired and could not be renewed (no refresh token). */
  | 'auth_expired'
  /** The provider refused the stored grant (refresh refused, or 401 after a refresh). */
  | 'auth_revoked'
  /** The grant lacks a permission the read needs (403, or a tool's permission refusal). */
  | 'permission_missing'
  /** The provider kept refusing for rate after the backoff retries. */
  | 'rate_limited'
  /** The server failed or answered in a shape this layer cannot read. */
  | 'server_error'
  /** The connector asked for a tool it did not name, or the server stopped marking it read-only. */
  | 'tool_refused'
  /** The pass spent its call budget. */
  | 'budget_exhausted'
  /** The pass was told to stop. */
  | 'cancelled';

/** What the source's dashboard card shows for each kind. */
export type McpSourceDashboardState =
  | 'reconnect_required'
  | 'permission_missing'
  | 'rate_limited'
  | 'provider_error'
  | 'paused';

export const MCP_SOURCE_DASHBOARD_STATE: Readonly<Record<McpSourceErrorKind, McpSourceDashboardState>> = {
  auth_missing: 'reconnect_required',
  auth_expired: 'reconnect_required',
  auth_revoked: 'reconnect_required',
  permission_missing: 'permission_missing',
  rate_limited: 'rate_limited',
  server_error: 'provider_error',
  tool_refused: 'provider_error',
  budget_exhausted: 'paused',
  cancelled: 'paused',
};

const MESSAGES: Readonly<Record<McpSourceErrorKind, string>> = {
  auth_missing: 'This source is not signed in. Press Connect.',
  auth_expired: 'The sign-in expired. Press Connect to sign in again.',
  auth_revoked: 'The provider no longer accepts this sign-in. Press Connect to sign in again.',
  permission_missing: 'The sign-in does not grant a permission Olympus needs to read. Press Connect and allow reading.',
  rate_limited: 'The provider is limiting requests. Olympus tries again later.',
  server_error: 'The provider\'s server did not answer as expected. Olympus tries again later.',
  tool_refused: 'The provider\'s server no longer offers a read Olympus relies on as read-only, so Olympus stopped reading it.',
  budget_exhausted: 'This pass used its request allowance. The next pass continues.',
  cancelled: 'This pass was stopped.',
};

export class McpSourceError extends Error {
  readonly kind: McpSourceErrorKind;
  readonly dashboardState: McpSourceDashboardState;
  /** For `rate_limited`: when to try again, as far as the provider said. */
  readonly retryAfterMs?: number;

  constructor(kind: McpSourceErrorKind, options: { retryAfterMs?: number; cause?: unknown } = {}) {
    super(MESSAGES[kind], options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'McpSourceError';
    this.kind = kind;
    this.dashboardState = MCP_SOURCE_DASHBOARD_STATE[kind];
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export function isMcpSourceError(error: unknown, kind?: McpSourceErrorKind): error is McpSourceError {
  return error instanceof McpSourceError && (kind === undefined || error.kind === kind);
}

/**
 * Strict request schemas for the Google token-exchange endpoint.
 *
 * The endpoint is a public API (docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md, "Threat
 * model"): anyone who can reach it can send it a request, so every field is
 * validated for shape and bound before anything touches Google. An unknown
 * field refuses the whole request rather than being silently dropped — a
 * strict schema is cheap insurance against a caller (or an attacker) smuggling
 * something this endpoint was never designed to forward.
 */

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; message: string };

export interface ExchangeRequest {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  state?: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

// Printable ASCII, no whitespace or control characters. Google's own
// authorization codes and the relay's `state` are both opaque tokens in this
// alphabet; anything else is not a value either side could have produced.
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

// RFC 7636 §4.1: the code verifier is 43-128 characters from
// [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~".
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

const MAX_CODE_LENGTH = 2048;
// Matches the relay's own cap (docs/ops/OAUTH_RELAY.md, "State format") — a
// state longer than this was never minted by this system either.
const MAX_STATE_LENGTH = 2048;
const MAX_REDIRECT_URI_LENGTH = 2048;
// Google's refresh tokens are short opaque strings in practice, but the
// format is not contractually bounded; this cap is generous headroom, not an
// observed maximum.
const MAX_REFRESH_TOKEN_LENGTH = 4096;

function fail<T>(error: string, message: string): ParseResult<T> {
  return { ok: false, error, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoUnknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return key;
  }
  return undefined;
}

const EXCHANGE_FIELDS = new Set(['code', 'code_verifier', 'redirect_uri', 'state']);

export function parseExchangeRequest(value: unknown): ParseResult<ExchangeRequest> {
  if (!isPlainObject(value)) return fail('invalid_request', 'Body must be a JSON object.');
  const unknownField = assertNoUnknownFields(value, EXCHANGE_FIELDS);
  if (unknownField) return fail('invalid_request', `Unexpected field: ${unknownField}.`);

  const { code, code_verifier: codeVerifier, redirect_uri: redirectUri, state } = value;

  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_LENGTH || !PRINTABLE_ASCII.test(code)) {
    return fail('invalid_request', 'code is required and must be a bounded printable string.');
  }
  if (typeof codeVerifier !== 'string' || !CODE_VERIFIER_PATTERN.test(codeVerifier)) {
    return fail('invalid_request', 'code_verifier is required and must be 43-128 RFC 7636 unreserved characters.');
  }
  if (typeof redirectUri !== 'string' || redirectUri.length === 0 || redirectUri.length > MAX_REDIRECT_URI_LENGTH) {
    return fail('invalid_request', 'redirect_uri is required and must be a bounded string.');
  }
  if (state !== undefined && (typeof state !== 'string' || state.length === 0 || state.length > MAX_STATE_LENGTH || !PRINTABLE_ASCII.test(state))) {
    return fail('invalid_request', 'state must be a bounded printable string when present.');
  }

  return {
    ok: true,
    value: {
      code,
      codeVerifier,
      redirectUri,
      ...(state !== undefined ? { state } : {}),
    },
  };
}

const REFRESH_FIELDS = new Set(['refresh_token']);

export function parseRefreshRequest(value: unknown): ParseResult<RefreshRequest> {
  if (!isPlainObject(value)) return fail('invalid_request', 'Body must be a JSON object.');
  const unknownField = assertNoUnknownFields(value, REFRESH_FIELDS);
  if (unknownField) return fail('invalid_request', `Unexpected field: ${unknownField}.`);

  const { refresh_token: refreshToken } = value;
  if (
    typeof refreshToken !== 'string'
    || refreshToken.length === 0
    || refreshToken.length > MAX_REFRESH_TOKEN_LENGTH
    || !PRINTABLE_ASCII.test(refreshToken)
  ) {
    return fail('invalid_request', 'refresh_token is required and must be a bounded printable string.');
  }

  return { ok: true, value: { refreshToken } };
}

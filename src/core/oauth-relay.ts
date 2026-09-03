/**
 * The worker half of the OAuth callback relay contract.
 *
 * Canonical contract: `docs/ops/OAUTH_RELAY.md`. The relay is a static page on
 * a publisher-controlled domain that bounces a provider redirect back to
 * whatever dashboard origin the flow's own `state` names. It holds no key and
 * cannot verify a signature, so **this module is the authority**: it mints the
 * signed state at flow start and re-verifies every field when the bounced
 * request arrives.
 *
 * Nothing here is provider-specific and nothing here touches a credential. The
 * HMAC key is worker-local, lives in the worker's own secret store beside the
 * other worker-local material, and never leaves the process.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The payload version the relay page parses. Bumping it is a relay-first change. */
export const OAUTH_RELAY_STATE_VERSION = 1;

/**
 * The one registered `redirect_uri`, trailing slash included. Exactly this
 * string goes into the authorization request AND the token exchange; providers
 * match it character for character (RFC 9700 §4.1.3).
 */
export const DEFAULT_OAUTH_RELAY_URL = 'https://auth.olympusplugin.ai/oauth/callback/';

/** The relay refuses a longer `state` before decoding anything. */
export const OAUTH_RELAY_MAX_STATE_LENGTH = 2048;

/** The freshness window for `iat`, in addition to the attempt's own expiry. */
export const OAUTH_RELAY_STATE_TTL_MS = 10 * 60 * 1000;

/** 32 random bytes, base64url — 43 characters, the recommended nonce. */
export const OAUTH_RELAY_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

export interface OAuthRelayStatePayload {
  v: number;
  origin: string;
  source: string;
  nonce: string;
  iat: number;
}

/**
 * The worker-local HMAC key material, with room for one rotation in flight.
 *
 * `previous` verifies only for one flow TTL after `rotatedAt` — the contract's
 * "keep the previous key accepted for one flow TTL" — so a leaked key stops
 * being honored a bounded time after it is rotated out, independent of any
 * single state's own freshness window.
 */
export interface OAuthRelayStateKeys {
  /** The key new states are signed with. */
  current: string;
  /** The key `current` replaced, if a rotation has happened. */
  previous?: string;
  /** When `current` became current. Required to verify with `previous`. */
  rotatedAt?: Date;
}

export interface OAuthRelayStateExpectation {
  /** The worker-local HMAC key material: current, and a previous key in its TTL window. */
  keys: OAuthRelayStateKeys;
  /** The dashboard origin this worker derives for itself — never one the request claims. */
  expectedOrigin: string;
  /** The source recorded with the nonce. */
  expectedSource: string;
  /** The nonce of the pending flow record this worker created. */
  expectedNonce: string;
  now: Date;
  ttlMs?: number;
}

/**
 * Why a bounced callback was refused. The worker collapses every one of these
 * into a single indistinguishable answer; the reason exists so tests can prove
 * each check fires, never so a caller can be told which one did.
 */
export type OAuthRelayStateRefusal =
  | 'malformed_state'
  | 'bad_signature'
  | 'unsupported_version'
  | 'invalid_payload'
  | 'nonce_mismatch'
  | 'foreign_origin'
  | 'source_mismatch'
  | 'stale_iat';

export type OAuthRelayStateVerification =
  | { ok: true; payload: OAuthRelayStatePayload }
  | { ok: false; reason: OAuthRelayStateRefusal };

/**
 * The relay URL this install sends and expects back.
 *
 * `OLYMPUS_OAUTH_RELAY_URL` exists so a test (or a staging relay) can point the
 * flow somewhere else. An unparseable or non-https override is ignored rather
 * than obeyed: a redirect URI is the one string a provider matches exactly, and
 * a malformed one turns every connect into a provider error page. Loopback http
 * is allowed so a test can host the relay locally.
 */
export function oauthRelayUrl(env: Record<string, string | undefined> = process.env): string {
  const override = env.OLYMPUS_OAUTH_RELAY_URL?.trim();
  if (!override) return DEFAULT_OAUTH_RELAY_URL;
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    return DEFAULT_OAUTH_RELAY_URL;
  }
  const loopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]';
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) return override;
  return DEFAULT_OAUTH_RELAY_URL;
}

/** A fresh single-use nonce: 32 random bytes, base64url. */
export function createOAuthRelayNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** A fresh worker-local HMAC key: 32 random bytes, base64url as it is stored. */
export function createOAuthRelayStateKey(): string {
  return randomBytes(32).toString('base64url');
}

/** Fresh key material with no rotation history: a lone `current` key. */
export function createOAuthRelayStateKeys(): OAuthRelayStateKeys {
  return { current: createOAuthRelayStateKey() };
}

/**
 * Rotates the signing key: the old `current` becomes `previous` and verifies
 * for one more flow TTL, and a freshly minted key becomes `current`.
 *
 * Rotating twice in immediate succession is deliberately destructive to the
 * PRIOR `previous`: only one demoted key is ever kept, because the contract
 * bounds the honored window to one TTL past the most recent rotation, not a
 * chain of them.
 */
export function rotateOAuthRelayStateKeys(keys: OAuthRelayStateKeys, now: Date): OAuthRelayStateKeys {
  return { current: createOAuthRelayStateKey(), previous: keys.current, rotatedAt: now };
}

interface OAuthRelayStateKeysJson {
  current: string;
  previous?: string;
  rotatedAt?: string;
}

/** The JSON shape persisted to the worker's secret store. */
export function serializeOAuthRelayStateKeys(keys: OAuthRelayStateKeys): string {
  const json: OAuthRelayStateKeysJson = {
    current: keys.current,
    ...(keys.previous ? { previous: keys.previous } : {}),
    ...(keys.rotatedAt ? { rotatedAt: keys.rotatedAt.toISOString() } : {}),
  };
  return JSON.stringify(json);
}

/**
 * The inverse of `serializeOAuthRelayStateKeys`. `undefined` on anything that
 * is not the shape this module wrote — a corrupt or foreign value mints fresh
 * material rather than trusting partial bytes as a signing key.
 */
export function parseOAuthRelayStateKeys(raw: string | undefined): OAuthRelayStateKeys | undefined {
  if (!raw) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return undefined;
  const record = decoded as Record<string, unknown>;
  if (typeof record.current !== 'string' || !record.current) return undefined;
  if (record.previous !== undefined && (typeof record.previous !== 'string' || !record.previous)) return undefined;
  if (record.rotatedAt !== undefined) {
    if (typeof record.rotatedAt !== 'string') return undefined;
    const parsed = Date.parse(record.rotatedAt);
    if (!Number.isFinite(parsed)) return undefined;
    return {
      current: record.current,
      ...(record.previous ? { previous: record.previous } : {}),
      rotatedAt: new Date(parsed),
    };
  }
  return {
    current: record.current,
    ...(record.previous ? { previous: record.previous } : {}),
  };
}

/**
 * `BASE64URL(payload) "." BASE64URL(HMAC-SHA256(key, BASE64URL(payload)))`.
 *
 * The signature covers the ASCII of the first segment, not the JSON, so there
 * is no canonicalization question on either side.
 */
export function signOAuthRelayState(
  payload: Omit<OAuthRelayStatePayload, 'v'> & { v?: number },
  key: string,
): string {
  const body: OAuthRelayStatePayload = {
    v: payload.v ?? OAUTH_RELAY_STATE_VERSION,
    origin: payload.origin,
    source: payload.source,
    nonce: payload.nonce,
    iat: payload.iat,
  };
  const segment = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${segment}.${relaySignature(segment, key)}`;
}

/**
 * Every check the contract's "What the worker must verify" lists, in its order:
 * signature, version, nonce, origin, source, freshness.
 *
 * Step 0 (never mint a state outside an authenticated dashboard session) and
 * step 3's atomic single-use consumption belong to the caller: the nonce here is
 * only compared against the pending record the caller found, and a replayed
 * nonce is refused by that record being gone.
 */
export function verifyOAuthRelayState(
  state: string,
  expectation: OAuthRelayStateExpectation,
): OAuthRelayStateVerification {
  if (typeof state !== 'string' || state.length === 0) return refuse('malformed_state');
  if (state.length > OAUTH_RELAY_MAX_STATE_LENGTH) return refuse('malformed_state');
  const segments = state.split('.');
  if (segments.length !== 2) return refuse('malformed_state');
  const [segment, signature] = segments as [string, string];
  if (!BASE64URL_SEGMENT.test(segment) || !BASE64URL_SEGMENT.test(signature)) return refuse('malformed_state');

  // Signature first, and in constant time. Everything below this line is
  // reading bytes a key this worker currently trusts has already vouched for.
  //
  // `current` first, then `previous` if it is still inside its one-flow-TTL
  // grace window from the moment it was rotated out — the contract's "keep the
  // previous key accepted for one flow TTL". A state minted before rotation and
  // still fresh at verification time must keep working; a `previous` key that
  // rotation has aged past its window must not, independent of any state's own
  // freshness, or a leaked old key would verify forever.
  const ttlMs = expectation.ttlMs ?? OAUTH_RELAY_STATE_TTL_MS;
  const signedWithCurrent = constantTimeEquals(signature, relaySignature(segment, expectation.keys.current));
  if (!signedWithCurrent) {
    const { previous, rotatedAt } = expectation.keys;
    const previousStillHonored = previous !== undefined
      && rotatedAt !== undefined
      && expectation.now.getTime() - rotatedAt.getTime() <= ttlMs;
    if (!previousStillHonored || !constantTimeEquals(signature, relaySignature(segment, previous))) {
      return refuse('bad_signature');
    }
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return refuse('invalid_payload');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return refuse('invalid_payload');
  const record = decoded as Record<string, unknown>;
  if (record.v !== OAUTH_RELAY_STATE_VERSION) return refuse('unsupported_version');
  if (typeof record.origin !== 'string' || typeof record.source !== 'string') return refuse('invalid_payload');
  if (typeof record.nonce !== 'string' || !OAUTH_RELAY_NONCE_PATTERN.test(record.nonce)) return refuse('invalid_payload');
  if (typeof record.iat !== 'number' || !Number.isFinite(record.iat)) return refuse('invalid_payload');

  if (!constantTimeEquals(record.nonce, expectation.expectedNonce)) return refuse('nonce_mismatch');
  if (record.origin !== expectation.expectedOrigin) return refuse('foreign_origin');
  if (record.source !== expectation.expectedSource) return refuse('source_mismatch');

  const ageMs = expectation.now.getTime() - record.iat * 1000;
  // A future `iat` is as wrong as a stale one: it is either a clock that moved
  // or a state this worker did not mint on the clock it is reading now. One
  // minute of tolerance absorbs an ordinary skew.
  if (ageMs > ttlMs || ageMs < -60_000) return refuse('stale_iat');

  return {
    ok: true,
    payload: {
      v: record.v,
      origin: record.origin,
      source: record.source,
      nonce: record.nonce,
      iat: record.iat,
    },
  };
}

function relaySignature(segment: string, key: string): string {
  return createHmac('sha256', Buffer.from(key, 'base64url')).update(segment, 'ascii').digest('base64url');
}

/**
 * Fixed-width comparison over the UTF-8 bytes: `timingSafeEqual` throws on a
 * length mismatch, so an unequal length answers false without leaking which
 * byte differed and without the throw becoming the signal.
 */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function refuse(reason: OAuthRelayStateRefusal): OAuthRelayStateVerification {
  return { ok: false, reason };
}

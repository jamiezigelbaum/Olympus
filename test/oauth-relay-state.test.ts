// The worker half of the relay contract: the signed `state` a publisher-client
// flow mints, and every refusal the callback route must be able to make.
//
// The relay page holds no key and checks no signature — it decides only where to
// bounce. Everything that makes a bounced callback safe is here and in the
// callback route, so each check in docs/ops/OAUTH_RELAY.md ("What the worker
// must verify") gets its own failing case rather than a round-trip that would
// pass with half of them missing.

import { describe, expect, test } from 'bun:test';
import {
  createOAuthRelayNonce,
  createOAuthRelayStateKey,
  oauthRelayUrl,
  signOAuthRelayState,
  verifyOAuthRelayState,
  DEFAULT_OAUTH_RELAY_URL,
  OAUTH_RELAY_MAX_STATE_LENGTH,
  OAUTH_RELAY_STATE_VERSION,
} from '../src/core/oauth-relay.ts';

const KEY = createOAuthRelayStateKey();
const NOW = new Date('2026-09-03T12:00:00.000Z');
const ORIGIN = 'https://olympus.example.org';
const NONCE = createOAuthRelayNonce();

function state(overrides: Partial<{ origin: string; source: string; nonce: string; iat: number; v: number }> = {}): string {
  return signOAuthRelayState({
    origin: overrides.origin ?? ORIGIN,
    source: overrides.source ?? 'dropbox',
    nonce: overrides.nonce ?? NONCE,
    iat: overrides.iat ?? Math.floor(NOW.getTime() / 1000),
    ...(overrides.v === undefined ? {} : { v: overrides.v }),
  }, KEY);
}

function verify(value: string, expectation: Partial<Parameters<typeof verifyOAuthRelayState>[1]> = {}) {
  return verifyOAuthRelayState(value, {
    key: KEY,
    expectedOrigin: ORIGIN,
    expectedSource: 'dropbox',
    expectedNonce: NONCE,
    now: NOW,
    ...expectation,
  });
}

describe('relay state', () => {
  test('round-trips through sign and verify', () => {
    const signed = state();
    // Two base64url segments, one dot, inside the relay's own ceiling. The
    // relay refuses a longer one before it decodes anything.
    expect(signed).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(signed.length).toBeLessThanOrEqual(OAUTH_RELAY_MAX_STATE_LENGTH);
    const verified = verify(signed);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload).toEqual({
      v: OAUTH_RELAY_STATE_VERSION,
      origin: ORIGIN,
      source: 'dropbox',
      nonce: NONCE,
      iat: Math.floor(NOW.getTime() / 1000),
    });
  });

  test('the relay page can read the public half of a state this module signed', () => {
    const [segment] = state().split('.') as [string];
    // The page parses ONLY the first segment. If this ever stops being plain
    // JSON with these five fields, the relay silently refuses every flow.
    expect(JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))).toEqual({
      v: 1,
      origin: ORIGIN,
      source: 'dropbox',
      nonce: NONCE,
      iat: Math.floor(NOW.getTime() / 1000),
    });
  });

  test('a forged signature is refused', () => {
    const [segment, signature] = state().split('.') as [string, string];
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    expect(verify(`${segment}.${flipped}`)).toEqual({ ok: false, reason: 'bad_signature' });
    // A state signed with somebody else's key is the same refusal, which is the
    // one that matters: an attacker who mints a state cannot sign it.
    const foreign = signOAuthRelayState(
      { origin: ORIGIN, source: 'dropbox', nonce: NONCE, iat: Math.floor(NOW.getTime() / 1000) },
      createOAuthRelayStateKey(),
    );
    expect(verify(foreign)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('a malformed state never reaches the signature check', () => {
    for (const value of ['', 'no-dot', 'a.b.c', 'not base64url!.x', `${'a'.repeat(4000)}.b`]) {
      expect(verify(value)).toEqual({ ok: false, reason: 'malformed_state' });
    }
  });

  test('a version this worker does not implement is refused', () => {
    expect(verify(state({ v: 2 }))).toEqual({ ok: false, reason: 'unsupported_version' });
  });

  test('a nonce that is not the pending flow record is refused', () => {
    // This is also the replay case at the crypto layer: a consumed nonce no
    // longer matches any record, and the route has already dropped the attempt.
    expect(verify(state({ nonce: createOAuthRelayNonce() }))).toEqual({ ok: false, reason: 'nonce_mismatch' });
  });

  test('an origin other than the worker’s own is refused', () => {
    expect(verify(state({ origin: 'https://attacker.example' }))).toEqual({ ok: false, reason: 'foreign_origin' });
  });

  test('a source other than the one recorded with the nonce is refused', () => {
    expect(verify(state({ source: 'gmail' }))).toEqual({ ok: false, reason: 'source_mismatch' });
  });

  test('a stale or future iat is refused', () => {
    const stale = Math.floor(NOW.getTime() / 1000) - 11 * 60;
    expect(verify(state({ iat: stale }))).toEqual({ ok: false, reason: 'stale_iat' });
    const future = Math.floor(NOW.getTime() / 1000) + 10 * 60;
    expect(verify(state({ iat: future }))).toEqual({ ok: false, reason: 'stale_iat' });
    // Ordinary clock skew is not a refusal.
    expect(verify(state({ iat: Math.floor(NOW.getTime() / 1000) + 30 })).ok).toBe(true);
  });

  test('a state signed for one source cannot be replayed at another', () => {
    // The crossed-source case from the far side: the same signed state offered
    // where gmail's nonce is expected fails on the nonce before the source.
    expect(verify(state(), { expectedSource: 'gmail', expectedNonce: createOAuthRelayNonce() }))
      .toEqual({ ok: false, reason: 'nonce_mismatch' });
  });
});

describe('relay url', () => {
  test('defaults to the one registered callback, trailing slash included', () => {
    expect(oauthRelayUrl({})).toBe(DEFAULT_OAUTH_RELAY_URL);
    expect(DEFAULT_OAUTH_RELAY_URL.endsWith('/')).toBe(true);
  });

  test('an https or loopback override is honoured', () => {
    expect(oauthRelayUrl({ OLYMPUS_OAUTH_RELAY_URL: 'https://staging.example/oauth/callback/' }))
      .toBe('https://staging.example/oauth/callback/');
    expect(oauthRelayUrl({ OLYMPUS_OAUTH_RELAY_URL: 'http://127.0.0.1:9099/oauth/callback/' }))
      .toBe('http://127.0.0.1:9099/oauth/callback/');
  });

  test('a malformed or plaintext override is ignored rather than obeyed', () => {
    // A redirect URI is the one string a provider matches exactly. A bad one
    // turns every connect into a provider error page, so the default stands.
    for (const value of ['not a url', 'http://relay.example/oauth/callback/', 'javascript:alert(1)']) {
      expect(oauthRelayUrl({ OLYMPUS_OAUTH_RELAY_URL: value })).toBe(DEFAULT_OAUTH_RELAY_URL);
    }
  });
});

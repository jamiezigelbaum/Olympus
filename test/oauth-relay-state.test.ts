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
  createOAuthRelayStateKeys,
  oauthRelayUrl,
  parseOAuthRelayStateKeys,
  rotateOAuthRelayStateKeys,
  serializeOAuthRelayStateKeys,
  signOAuthRelayState,
  verifyOAuthRelayState,
  DEFAULT_OAUTH_RELAY_URL,
  OAUTH_RELAY_MAX_STATE_LENGTH,
  OAUTH_RELAY_STATE_TTL_MS,
  OAUTH_RELAY_STATE_VERSION,
  type OAuthRelayStateKeys,
} from '../src/core/oauth-relay.ts';

const KEY = createOAuthRelayStateKey();
const KEYS: OAuthRelayStateKeys = { current: KEY };
const NOW = new Date('2026-09-03T12:00:00.000Z');
const ORIGIN = 'https://olympus.example.org';
const NONCE = createOAuthRelayNonce();

function state(
  overrides: Partial<{ origin: string; source: string; nonce: string; iat: number; v: number }> = {},
  key: string = KEY,
): string {
  return signOAuthRelayState({
    origin: overrides.origin ?? ORIGIN,
    source: overrides.source ?? 'dropbox',
    nonce: overrides.nonce ?? NONCE,
    iat: overrides.iat ?? Math.floor(NOW.getTime() / 1000),
    ...(overrides.v === undefined ? {} : { v: overrides.v }),
  }, key);
}

function verify(value: string, expectation: Partial<Parameters<typeof verifyOAuthRelayState>[1]> = {}) {
  return verifyOAuthRelayState(value, {
    keys: KEYS,
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

// MINOR 3, Codex round 2 on 7863a735: rotation wasn't implemented at all — the
// worker cached one key, and verification checked only that one. The contract
// requires the OLD key to keep verifying for one flow TTL past its own
// rotation (so a state minted just before rotation and still fresh at
// verification time keeps working), and to STOP verifying once that window has
// passed (so a compromised key that prompted the rotation cannot forge a
// brand-new, fully fresh state forever after).
describe('key rotation', () => {
  test('rotating replaces current and demotes it to previous, with a rotation timestamp', () => {
    const original: OAuthRelayStateKeys = { current: KEY };
    const rotated = rotateOAuthRelayStateKeys(original, NOW);
    expect(rotated.current).not.toBe(KEY);
    expect(rotated.previous).toBe(KEY);
    expect(rotated.rotatedAt).toEqual(NOW);
  });

  test('rotating twice keeps only the most recently demoted key, never a chain', () => {
    const first = rotateOAuthRelayStateKeys({ current: KEY }, NOW);
    const second = rotateOAuthRelayStateKeys(first, new Date(NOW.getTime() + 60_000));
    expect(second.previous).toBe(first.current);
    // The key `first` demoted (the original KEY) is gone entirely — one
    // rotation's grace window, never two chained together.
    expect(second.previous).not.toBe(KEY);
  });

  test('a state signed with the previous key verifies within one flow TTL of rotation', () => {
    const rotated = rotateOAuthRelayStateKeys({ current: KEY }, NOW);
    const oldSigned = state({ iat: Math.floor(NOW.getTime() / 1000) }, KEY);
    // Right at rotation, and again just under the TTL boundary.
    for (const elapsedMs of [0, OAUTH_RELAY_STATE_TTL_MS - 1]) {
      expect(verify(oldSigned, { keys: rotated, now: new Date(NOW.getTime() + elapsedMs) }).ok).toBe(true);
    }
    // The new key verifies immediately too — rotation costs the new key nothing.
    const newSigned = state({ iat: Math.floor(NOW.getTime() / 1000) }, rotated.current);
    expect(verify(newSigned, { keys: rotated }).ok).toBe(true);
  });

  test('a state signed with the previous key is refused once its TTL window has passed', () => {
    const rotated = rotateOAuthRelayStateKeys({ current: KEY }, NOW);
    // The state's own `iat` is minted AFTER the TTL boundary has passed for the
    // rotation, so its own freshness is fine — only the key it was signed with
    // has aged out. This isolates the rotation boundary from the state's own
    // freshness check: without a working previous-key expiry, this would still
    // verify forever on a compromised key that prompted the rotation.
    const afterBoundary = new Date(NOW.getTime() + OAUTH_RELAY_STATE_TTL_MS + 1);
    const oldSignedButFresh = state({ iat: Math.floor(afterBoundary.getTime() / 1000) }, KEY);
    expect(verify(oldSignedButFresh, { keys: rotated, now: afterBoundary }))
      .toEqual({ ok: false, reason: 'bad_signature' });
    // The current key is unaffected by how long ago the rotation happened.
    const newSigned = state({ iat: Math.floor(afterBoundary.getTime() / 1000) }, rotated.current);
    expect(verify(newSigned, { keys: rotated, now: afterBoundary }).ok).toBe(true);
  });

  test('no previous key and no rotation timestamp means only current verifies', () => {
    const unrotated: OAuthRelayStateKeys = { current: KEY };
    const foreignSigned = state({}, createOAuthRelayStateKey());
    expect(verify(foreignSigned, { keys: unrotated })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('key material round-trips through the persisted JSON shape', () => {
    const rotated = rotateOAuthRelayStateKeys({ current: KEY }, NOW);
    const persisted = serializeOAuthRelayStateKeys(rotated);
    // What actually reaches the secret store: no signature, no state, just the
    // three fields the worker's own verification needs back.
    expect(JSON.parse(persisted)).toEqual({
      current: rotated.current,
      previous: KEY,
      rotatedAt: NOW.toISOString(),
    });
    expect(parseOAuthRelayStateKeys(persisted)).toEqual(rotated);
  });

  test('fresh key material has no previous key to parse back', () => {
    const fresh = createOAuthRelayStateKeys();
    expect(fresh.previous).toBeUndefined();
    expect(fresh.rotatedAt).toBeUndefined();
    expect(parseOAuthRelayStateKeys(serializeOAuthRelayStateKeys(fresh))).toEqual(fresh);
  });

  test('a corrupt or foreign stored value parses to undefined rather than a partial key', () => {
    for (const raw of [undefined, '', 'not json', '{}', '{"current":123}', JSON.stringify({ current: KEY, rotatedAt: 'not a date' })]) {
      expect(parseOAuthRelayStateKeys(raw)).toBeUndefined();
    }
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

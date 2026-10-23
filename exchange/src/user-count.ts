/**
 * The distinct-user counter behind the Google sign-in capacity state.
 *
 * Why it exists: Olympus's publisher Google client is unverified and asks for
 * restricted scopes, so Google allows at most 100 distinct users over the
 * app's whole lifetime. User 101 is stopped on Google's own page and never
 * returns to Olympus, so the only place that can see the wall coming is this
 * Worker — it is the one component that watches every successful consent.
 *
 * How it counts: the publisher flows request `openid` (src/core/connect.ts),
 * so Google's authorization_code token response carries an `id_token` whose
 * `sub` names the account. That token reached this Worker straight from
 * Google's token endpoint over TLS inside this same request, so its signature
 * is not checked here — the count is a tally, not an authentication decision.
 * The `sub` is never stored: a keyed hash of it is (HMAC-SHA256 with the
 * optional `USER_COUNT_HMAC_KEY` secret, otherwise SHA-256 with a fixed
 * label). One key per account makes the count idempotent: Gmail and Drive for
 * the same account, and every reconnect, land on the same key.
 *
 * Storage: the same KV namespace the rate limiter uses, under their own
 * prefix and with no TTL. `google-users:count` is a materialised total, so
 * reading the count costs one KV read rather than a list.
 *
 * Failure policy: counting is bookkeeping and must never break or delay an
 * exchange. Every KV call is wrapped; a failure loses at most one tally (the
 * offset var and the gap between the "full" threshold and Google's cap absorb
 * it) and never reaches the caller.
 */

export interface UserCountKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list?(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export const USER_KEY_PREFIX = 'google-users:u:';
export const COUNT_KEY = 'google-users:count';
export const LAST_NEW_USER_KEY = 'google-users:last-new-user-at';
export const NO_ID_TOKEN_KEY = 'google-users:exchanges-without-id-token';

const FIXED_LABEL = 'olympus-google-user-count-v1';
const MAX_SUB_LENGTH = 255;

/** The `sub` claim of an id_token, or undefined for anything that is not a well-formed one. */
export function subFromIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string') return undefined;
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof payload !== 'object' || payload === null) return undefined;
    const sub = (payload as { sub?: unknown }).sub;
    return typeof sub === 'string' && sub.length > 0 && sub.length <= MAX_SUB_LENGTH ? sub : undefined;
  } catch {
    return undefined;
  }
}

/** The KV key for one account: a keyed hash, never the raw `sub`. */
export async function userKeyForSub(sub: string, hmacKey: string | undefined): Promise<string> {
  const encoder = new TextEncoder();
  let digest: ArrayBuffer;
  if (hmacKey) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(hmacKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    digest = await crypto.subtle.sign('HMAC', key, encoder.encode(sub));
  } else {
    digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${FIXED_LABEL}:${sub}`));
  }
  return USER_KEY_PREFIX + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Record the account behind one successful authorization_code exchange.
 * Never throws and never returns anything the caller must act on.
 */
export async function recordGoogleUser(
  kv: UserCountKv | undefined,
  responseText: string,
  options: { hmacKey?: string | undefined; nowMs: number },
): Promise<void> {
  if (!kv) return;
  try {
    let idToken: unknown;
    try {
      idToken = (JSON.parse(responseText) as { id_token?: unknown }).id_token;
    } catch {
      return;
    }
    const sub = subFromIdToken(idToken);
    if (!sub) {
      await bumpTally(kv, NO_ID_TOKEN_KEY);
      return;
    }
    const userKey = await userKeyForSub(sub, options.hmacKey);
    if ((await kv.get(userKey)) !== null) return;
    await kv.put(userKey, String(options.nowMs));
    const stored = parseCount(await kv.get(COUNT_KEY));
    const listed = await countListedUsers(kv);
    // The list can lag a fresh write by up to a minute, so it can undercount
    // the user just added; the stored total can lose a race with a concurrent
    // new user. Each error is in the low direction and corrects on the next
    // new user, so the larger of the two is the better estimate.
    await kv.put(COUNT_KEY, String(Math.max(stored + 1, listed ?? 0)));
    await kv.put(LAST_NEW_USER_KEY, new Date(options.nowMs).toISOString());
  } catch {
    // Fail open: a lost tally never reaches the exchange.
  }
}

async function bumpTally(kv: UserCountKv, key: string): Promise<void> {
  await kv.put(key, String(parseCount(await kv.get(key)) + 1));
}

/** Distinct accounts present in the list, or undefined when this binding cannot list. */
export async function countListedUsers(kv: UserCountKv): Promise<number | undefined> {
  if (!kv.list) return undefined;
  let total = 0;
  let cursor: string | undefined;
  // A page is 1000 keys; the cap is 100, so one page is the normal case. The
  // bound only stops a corrupted namespace from looping.
  for (let page = 0; page < 20; page += 1) {
    const result = await kv.list({ prefix: USER_KEY_PREFIX, ...(cursor ? { cursor } : {}) });
    total += result.keys.length;
    if (result.list_complete || !result.cursor) return total;
    cursor = result.cursor;
  }
  return total;
}

function parseCount(raw: string | null): number {
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export interface CapacityConfig {
  offset: number;
  cap: number;
  fullAt: number;
  forcedFull: boolean;
}

export interface CapacityEnv {
  GOOGLE_USER_COUNT_OFFSET?: string | undefined;
  GOOGLE_USER_CAP?: string | undefined;
  GOOGLE_FULL_AT?: string | undefined;
  GOOGLE_SIGNIN_FULL?: string | undefined;
}

export function capacityConfig(env: CapacityEnv): CapacityConfig {
  const forced = env.GOOGLE_SIGNIN_FULL?.trim().toLowerCase();
  return {
    offset: nonNegativeIntOr(env.GOOGLE_USER_COUNT_OFFSET, 2),
    cap: positiveIntOr(env.GOOGLE_USER_CAP, 100),
    fullAt: positiveIntOr(env.GOOGLE_FULL_AT, 90),
    forcedFull: forced === '1' || forced === 'true',
  };
}

export type GoogleCapacityState = 'open' | 'full';

/** Full when the owner forces it, or when the reported number reaches the threshold. */
export function capacityState(config: CapacityConfig, countedUsers: number | undefined): GoogleCapacityState {
  if (config.forcedFull) return 'full';
  if (countedUsers === undefined) return 'open';
  return countedUsers + config.offset >= config.fullAt ? 'full' : 'open';
}

/** The stored total, or undefined when it cannot be read (the caller fails open). */
export async function readStoredCount(kv: UserCountKv | undefined): Promise<number | undefined> {
  if (!kv) return undefined;
  try {
    return parseCount(await kv.get(COUNT_KEY));
  } catch {
    return undefined;
  }
}

function nonNegativeIntOr(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveIntOr(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

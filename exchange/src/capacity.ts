/**
 * The two read routes that sit beside the token exchange:
 *
 *   GET /exchange/capacity  public; `{ "google": "open" | "full" }` and nothing else
 *   GET /exchange/stats     the owner's tracker; behind a bearer token
 *
 * The first lets the Olympus engine stop sending people to a Google consent
 * page that will refuse them (src/core/google-publisher-capacity.ts). It
 * carries no count on purpose: the number of users is the owner's business
 * metric, and a public, cacheable answer needs only the state.
 *
 * The second is how the owner watches the count out of 100. It is gated by
 * the `STATS_TOKEN` Worker secret, sent either as `Authorization: Bearer` or,
 * so a non-technical owner can bookmark it, as `?token=`. A browser (an
 * `Accept` header naming text/html) gets a small readable page; anything else
 * gets JSON. docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md states the residual risk of
 * a token in a URL.
 */

import { checkRateLimit, type RateLimitBinding, type RateLimitConfig } from './rate-limit.ts';
import {
  LAST_NEW_USER_KEY,
  NO_ID_TOKEN_KEY,
  capacityConfig,
  capacityState,
  countListedUsers,
  readStoredCount,
  type CapacityEnv,
  type UserCountKv,
} from './user-count.ts';

export interface CapacityRouteEnv extends CapacityEnv {
  RATE_LIMIT_KV?: (RateLimitBinding & Pick<UserCountKv, 'list'>) | undefined;
  /** `wrangler secret put STATS_TOKEN`. Absent: the stats route does not exist. */
  STATS_TOKEN?: string | undefined;
}

/** Long enough that a guess is not a plausible attack; a shorter configured value disables the route. */
const MIN_STATS_TOKEN_LENGTH = 16;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '600',
};

export async function handleCapacity(request: Request, env: CapacityRouteEnv): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
  }
  const config = capacityConfig(env);
  // An unreadable counter fails OPEN: a broken tally must not shut the door.
  // The owner's manual override still wins, since it needs no KV at all.
  const counted = await readStoredCount(env.RATE_LIMIT_KV);
  const state = capacityState(config, counted);
  // Cacheable for a minute; a degraded answer is cached only briefly so a
  // recovered counter is noticed quickly.
  const maxAge = counted === undefined && !config.forcedFull ? 10 : 60;
  return jsonResponse({ google: state }, 200, {
    ...CORS_HEADERS,
    'Cache-Control': `public, max-age=${maxAge}`,
  });
}

export async function handleStats(
  request: Request,
  env: CapacityRouteEnv,
  context: { nowMs: number; clientIp: string; rateLimit: RateLimitConfig },
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD' });
  }
  const configured = env.STATS_TOKEN;
  if (!configured || configured.length < MIN_STATS_TOKEN_LENGTH) {
    // Not set up: indistinguishable from a route that does not exist.
    return jsonResponse({ error: 'not_found' }, 404);
  }
  // Throttle guessing. Fails open like every rate limit here; a token of this
  // length is not guessable at any rate this limiter would let through.
  const limited = await checkRateLimit(env.RATE_LIMIT_KV, `google-stats:${context.clientIp}`, context.rateLimit, context.nowMs);
  if (!limited.allowed) {
    return jsonResponse({ error: 'rate_limited' }, 429, { 'Retry-After': String(limited.resetSeconds) });
  }
  const url = new URL(request.url);
  const presented = bearerToken(request) ?? url.searchParams.get('token') ?? '';
  if (!(await tokensEqual(presented, configured))) {
    return jsonResponse({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }

  const config = capacityConfig(env);
  const kv = env.RATE_LIMIT_KV;
  const stored = await readStoredCount(kv);
  let listed: number | undefined;
  try {
    listed = kv ? await countListedUsers(kv) : undefined;
  } catch {
    listed = undefined;
  }
  // Both estimates err low (a stale list, a lost race); the larger is better.
  const counted = stored === undefined && listed === undefined ? undefined : Math.max(stored ?? 0, listed ?? 0);
  if (counted === undefined) {
    return jsonResponse({ error: 'count_unavailable', error_description: 'The user counter could not be read.' }, 503);
  }
  const lastNewUserAt = await readText(kv, LAST_NEW_USER_KEY);
  const withoutIdToken = Number.parseInt((await readText(kv, NO_ID_TOKEN_KEY)) ?? '0', 10) || 0;
  const stats = {
    users: counted + config.offset,
    counted,
    offset: config.offset,
    cap: config.cap,
    full_at: config.fullAt,
    state: capacityState(config, counted),
    forced_full: config.forcedFull,
    last_new_user_at: lastNewUserAt,
    exchanges_without_id_token: withoutIdToken,
    generated_at: new Date(context.nowMs).toISOString(),
  };
  const wantsHtml = url.searchParams.get('format') !== 'json'
    && (request.headers.get('Accept') ?? '').includes('text/html');
  return wantsHtml ? statsPage(stats) : jsonResponse(stats, 200, { 'X-Robots-Tag': 'noindex' });
}

interface Stats {
  users: number;
  counted: number;
  offset: number;
  cap: number;
  full_at: number;
  state: 'open' | 'full';
  forced_full: boolean;
  last_new_user_at: string | null;
  exchanges_without_id_token: number;
  generated_at: string;
}

function statsPage(stats: Stats): Response {
  const percent = Math.min(100, Math.round((stats.users / stats.cap) * 100));
  const stateLine = stats.state === 'full'
    ? `Sign-in is <b>full</b>${stats.forced_full ? ' (switched on by hand)' : ''}: new people are sent to the bring-your-own-app route.`
    : `Sign-in is <b>open</b>. It turns to full at ${stats.full_at}.`;
  const noToken = stats.exchanges_without_id_token > 0
    ? `<p class="warn">${stats.exchanges_without_id_token} sign-ins arrived without an account id, so they are not counted. The real number may be higher.</p>`
    : '';
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Google sign-in count</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}.bar{background:#333}}
h1{font-size:2.6rem;margin:0}.sub{margin:.2rem 0 1.2rem;color:#666}
.bar{height:.9rem;background:#ddd;border-radius:.45rem;overflow:hidden}.fill{height:100%;background:${stats.state === 'full' ? '#c0392b' : '#2d7d46'};width:${percent}%}
.warn{color:#b35c00}dl{display:grid;grid-template-columns:auto 1fr;gap:.2rem 1rem;margin-top:1.4rem}dt{color:#666}dd{margin:0}
</style></head><body>
<h1>${stats.users} of ${stats.cap}</h1>
<p class="sub">Google accounts that have connected through Olympus's own Google app.</p>
<div class="bar" role="img" aria-label="${percent} percent of the Google limit"><div class="fill"></div></div>
<p>${stateLine}</p>${noToken}
<dl>
<dt>Counted by Olympus</dt><dd>${stats.counted}</dd>
<dt>Added for test accounts</dt><dd>${stats.offset}</dd>
<dt>Last new account</dt><dd>${stats.last_new_user_at ?? 'none yet'}</dd>
<dt>Checked</dt><dd>${stats.generated_at}</dd>
</dl>
<p class="sub">Olympus counts only sign-ins it saw finish, so Google's own number can be a little higher.</p>
</body></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('Authorization');
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return match?.[1];
}

/** Compares digests, so neither the length nor the content of the secret leaks through timing. */
async function tokensEqual(presented: string, configured: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(configured)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 1);
  return difference === 0;
}

async function readText(kv: UserCountKv | undefined, key: string): Promise<string | null> {
  if (!kv) return null;
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ExternalPendingOAuthConnection } from '../../../core/connect.ts';
import { type SecretStore, createDefaultSecretStore } from '../../../core/secret-store.ts';
import { DASHBOARD_GATEWAY_CALLBACK_PEER_HEADER } from '../../http.ts';
import type { DashboardOAuthSource, DashboardPendingConnect } from '../../source-dashboard.ts';
import type { EmailSourceWorkerOptions } from './worker-options.ts';

/**
 * Where the publisher-relay state signing key lives: the worker's own secret
 * store, beside the rest of this install's local material. It is never a
 * credential for anything outside this process — it only proves that a state
 * arriving on the callback route is one this worker minted.
 */
export const DASHBOARD_OAUTH_RELAY_STATE_KEY = 'dashboard.oauth.relay_state_key';

/** The callback rate limiter's fixed window and per-key ceiling within it. */
const DASHBOARD_OAUTH_CALLBACK_RATE_LIMIT_WINDOW_MS = 60_000;

const DASHBOARD_OAUTH_CALLBACK_RATE_LIMIT_MAX_PER_WINDOW = 30;

interface DashboardOAuthCallbackRateLimitBucket {
  windowStart: number;
  count: number;
}

/**
 * A bounded, in-memory fixed-window limiter for the OAuth callback route.
 *
 * Abuse-control speed bump, not the security boundary — the boundary is the
 * signature, nonce, origin, and single-use checks the route already runs
 * (docs/ops/OAUTH_RELAY.md, "What the worker must verify"). This worker is one
 * long-running process, unlike the stateless Cloudflare exchange endpoint
 * (`exchange/src/rate-limit.ts`, which needs a KV binding for cross-instance
 * counting), so a plain in-memory `Map` is the right primitive here: no
 * external store, no cross-process coordination, and — because nothing ever
 * calls this from a stateless edge runtime with thousands of isolates — no
 * fail-open story to design for either. It fails CLOSED like everything else
 * on this route: a limiter that cannot allocate a `Map` entry is a process
 * already out of memory, at which point refusing one more callback is the
 * least of the process's problems.
 *
 * Pruned opportunistically on every call — bucketed by whichever key last
 * appeared expired — so a worker that runs for weeks never accumulates one
 * entry per distinct key (address, source pair) it has ever seen.
 */
export function createDashboardOAuthCallbackRateLimiter(): (key: string, now: number) => boolean {
  const buckets = new Map<string, DashboardOAuthCallbackRateLimitBucket>();
  return (key: string, now: number): boolean => {
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.windowStart >= DASHBOARD_OAUTH_CALLBACK_RATE_LIMIT_WINDOW_MS) buckets.delete(bucketKey);
    }
    const existing = buckets.get(key);
    if (!existing || now - existing.windowStart >= DASHBOARD_OAUTH_CALLBACK_RATE_LIMIT_WINDOW_MS) {
      buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (existing.count >= DASHBOARD_OAUTH_CALLBACK_RATE_LIMIT_MAX_PER_WINDOW) return false;
    existing.count += 1;
    return true;
  };
}

/**
 * `<source>:<caller address>`. The callback peer header is injected only by
 * `withWorkerBearerAuth` after verifying the Gateway's HMAC, so a direct
 * callback or a caller-supplied copy cannot choose a bucket. Direct callers
 * share the conservative `unknown` bucket.
 */
export function dashboardOAuthCallbackRateLimitKey(source: DashboardOAuthSource, headers: Headers): string {
  const peer = headers.get(DASHBOARD_GATEWAY_CALLBACK_PEER_HEADER)?.trim();
  return `${source}:${peer || 'unknown'}`;
}

/** What an attempt keeps of its sign-in: the state it went out with, and how it completes or is abandoned. */
type DashboardPendingOAuth = Pick<ExternalPendingOAuthConnection, 'authorizationUrl' | 'state' | 'startedAt' | 'expiresAt' | 'completeCallback' | 'cancel'>;

/**
 * An Evernote sign-in (workers/evernote/live-sync.ts) as a dashboard attempt:
 * its own random state, checked again at the callback like every other
 * source's, and a completion that stores the credential and the handle.
 */
export async function startDashboardEvernoteSignIn(input: {
  redirectUri: string;
  secretStore: SecretStore;
  registryPath: string;
  serverUrl?: string;
  authorizationHosts?: readonly string[];
  fetch?: FetchLike;
}): Promise<{ pending: DashboardPendingOAuth }> {
  const state = randomBytes(24).toString('base64url');
  // Loaded on first use: the MCP client is needed by nothing else here.
  const { startEvernoteSignIn } = await import('../../evernote/live-sync.ts');
  const signIn = await startEvernoteSignIn({ ...input, state });
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + DASHBOARD_EVERNOTE_SIGN_IN_TTL_MS);
  let done = false;
  return {
    pending: {
      authorizationUrl: signIn.authorizationUrl,
      state,
      startedAt: startedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      async completeCallback(callback) {
        if (done || callback.state !== state) throw new Error('OAuth connection attempt is no longer active.');
        done = true;
        const handle = await signIn.complete(callback.code);
        return { ok: true, source: 'evernote', handles: [handle.handle], registryPath: input.registryPath, secretRefs: [...(handle.tokenSecretRefs ?? [])] };
      },
      cancel() {
        done = true;
      },
    },
  };
}

const DASHBOARD_EVERNOTE_SIGN_IN_TTL_MS = 10 * 60_000;

export interface DashboardOAuthAttempt {
  source: DashboardOAuthSource;
  pending: DashboardPendingOAuth;
  clientIdSource?: 'publisher' | 'byo';
  returnTo: string;
  startedAt: string;
  expiresAt: string;
  /**
   * The relay flow this attempt belongs to, when it went out through the
   * publisher relay rather than a callback on this dashboard's own origin.
   * The nonce is the single-use record the bounced state must match; consuming
   * or replacing the attempt is what makes a replay fail.
   */
  relay?: {
    nonce: string;
    /**
     * Set for a ChatGPT hand-back: the relay origin the state names, fixed at
     * start. The callback then arrives through the relay at this worker's
     * loopback address, so the origin cannot be derived from that request.
     */
    handbackOrigin?: string;
  };
  /**
   * The provider's refusal, if its callback carried `error=`.
   *
   * Recorded rather than discarded so the dashboard can say what was refused.
   * Deleting the attempt here left the card with nothing to show and the flow
   * looking merely unfinished; keeping it costs nothing, because the record
   * still expires on exactly the same clock.
   */
  error?: { code: string; at: string };
  /**
   * Set once this attempt's `state` has produced a terminal result — a
   * provider error, or (moot, since the attempt is deleted) a completed
   * exchange. A consumed state refuses exactly like a missing or expired one
   * (MINOR 1, Codex round 2 on 7863a735): the attempt record can outlive its
   * state's usability, because the dashboard still needs it for display, but
   * the state itself must stop verifying the moment its one legitimate result
   * has been read — otherwise the identical signed state stays replayable,
   * with a different `code` each time, until the attempt's own expiry.
   */
  consumed?: boolean;
}

export function dashboardPendingConnects(attempts: Map<DashboardOAuthSource, DashboardOAuthAttempt>): DashboardPendingConnect[] {
  return [...attempts.values()].map((attempt) => ({
    source: attempt.source,
    started_at: attempt.startedAt,
    expires_at: attempt.expiresAt,
    ...(attempt.error ? { error: { code: attempt.error.code, at: attempt.error.at } } : {}),
  }));
}

export function pruneDashboardOAuthAttempts(attempts: Map<DashboardOAuthSource, DashboardOAuthAttempt>, now: Date): void {
  for (const [source, attempt] of attempts) {
    if (dashboardOAuthAttemptExpired(attempt, now)) attempts.delete(source);
  }
}

/**
 * Clears one source's attempt only if the map still holds the attempt the caller
 * captured. The callback handler awaits the provider token exchange between the
 * lookup and the delete, and a Connect pressed inside that window replaces the
 * entry; deleting by key alone erased that newer attempt and answered its valid
 * callback with the expired page.
 */
export function clearDashboardOAuthAttempt(
  attempts: Map<DashboardOAuthSource, DashboardOAuthAttempt>,
  source: DashboardOAuthSource,
  attempt: DashboardOAuthAttempt,
): void {
  if (attempts.get(source) === attempt) attempts.delete(source);
}

/**
 * Whether a callback's `state` is the one this attempt generated.
 *
 * Compared over SHA-256 digests with `timingSafeEqual`: fixed-width inputs, so
 * neither the value nor its length leaks through the comparison, and a wrong
 * guess costs the same time as a right one.
 */
export function dashboardOAuthStateMatches(attempt: DashboardOAuthAttempt, state: string): boolean {
  const expected = attempt.pending.state;
  if (typeof expected !== 'string' || expected.length === 0) return false;
  return timingSafeEqual(
    createHash('sha256').update(expected).digest(),
    createHash('sha256').update(state).digest(),
  );
}

export function dashboardOAuthAttemptExpired(attempt: DashboardOAuthAttempt, now: Date): boolean {
  const expiresAt = Date.parse(attempt.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

/**
 * The link the callback tab offers back to the dashboard: one fixed relative
 * path, computed from nothing.
 *
 * It takes no argument because there is no input it could safely use. The
 * submitted `return_to` was the calling page's own `window.location.href`,
 * which on a read-only view carries the `dash_` token — a live credential
 * written into unauthenticated HTML that a provider redirect lands on, into
 * that tab's history, and into anything that saw the URL. And the REQUEST
 * ORIGIN is no safer to echo: it is attacker-controlled input (a Host header),
 * and interpolating it into a page is how a header becomes markup or a link to
 * somewhere else. A relative path needs neither, resolves against whatever
 * origin the reader is actually on, and cannot be poisoned by either one.
 *
 * The result is only ever rendered as an href; no caller redirects to it.
 */
export function dashboardReturnTo(): string {
  return '/dashboard';
}

/** Where a sign-in started from ChatGPT sends the person back to. */
export const CHATGPT_RETURN_TO = 'https://chatgpt.com/';

export function dashboardSecretStore(sourceDashboard: NonNullable<EmailSourceWorkerOptions['sourceDashboard']>): SecretStore {
  return sourceDashboard.secretStore ?? createDefaultSecretStore();
}

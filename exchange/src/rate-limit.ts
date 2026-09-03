/**
 * A fixed-window per-key request counter, backed by a Workers KV namespace.
 *
 * This is an abuse-control speed bump, not the security boundary: the
 * boundary is PKCE plus the provider's own consent screen
 * (docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md, "Threat model"). KV reads and writes
 * are not atomic, so two concurrent requests can both read the same count
 * before either writes back — a request can occasionally slip through one
 * over the limit. That is an accepted, documented gap: closing it exactly
 * needs a Durable Object, which is more machinery than an abuse control
 * warrants here. KV is free-tier-eligible and this endpoint's write volume
 * (at most one write per request) stays well inside the free allotment for
 * any realistic install base.
 *
 * Absent binding fails OPEN, not closed: a rate limiter is a defense-in-depth
 * control, and its absence must never take down the one endpoint that makes
 * the Google publisher flow work. The runbook
 * (docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md) makes creating and binding the KV
 * namespace a required owner setup step precisely because this fails open.
 */

export interface RateLimitBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window resets, for a `Retry-After` header. */
  resetSeconds: number;
}

export async function checkRateLimit(
  kv: RateLimitBinding | undefined,
  key: string,
  config: RateLimitConfig,
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  if (config.windowSeconds <= 0 || config.maxRequests <= 0) {
    throw new Error('Rate limit config must have positive windowSeconds and maxRequests.');
  }
  if (!kv) {
    return { allowed: true, remaining: config.maxRequests, resetSeconds: config.windowSeconds };
  }

  const windowMs = config.windowSeconds * 1000;
  const bucket = Math.floor(nowMs / windowMs);
  const storageKey = `${key}:${bucket}`;
  const resetSeconds = Math.max(0, Math.ceil(((bucket + 1) * windowMs - nowMs) / 1000));

  const raw = await kv.get(storageKey);
  const count = raw ? Number.parseInt(raw, 10) : 0;
  const currentCount = Number.isFinite(count) && count >= 0 ? count : 0;

  if (currentCount >= config.maxRequests) {
    return { allowed: false, remaining: 0, resetSeconds };
  }

  // TTL a few seconds past the window's own end, so a slow write never
  // resurrects a stale bucket into the next window.
  await kv.put(storageKey, String(currentCount + 1), { expirationTtl: config.windowSeconds + 5 });
  return { allowed: true, remaining: config.maxRequests - currentCount - 1, resetSeconds };
}

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
 * Fails OPEN, not closed, on every KV problem — not just an absent binding.
 * A rate limiter is a defense-in-depth control, and neither its absence NOR a
 * transient KV failure (a misconfigured permission, an outage, a thrown
 * error from `get` or `put`) may ever take down the one endpoint that makes
 * the Google publisher flow work: that would turn an abuse control into an
 * outage generator, which is the opposite of what it exists to prevent. The
 * runbook (docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md) makes creating and binding
 * the KV namespace a required owner setup step precisely because gaps here
 * fail open rather than loud.
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

  const windowMs = config.windowSeconds * 1000;
  const bucket = Math.floor(nowMs / windowMs);
  const resetSeconds = Math.max(0, Math.ceil(((bucket + 1) * windowMs - nowMs) / 1000));
  const openResult: RateLimitResult = { allowed: true, remaining: config.maxRequests, resetSeconds: config.windowSeconds };

  if (!kv) return openResult;

  const storageKey = `${key}:${bucket}`;

  // Every KV call is wrapped, not just the binding-presence check above: a
  // *present* binding whose `get` or `put` throws (transient KV error,
  // misconfigured permissions, a regional outage) must fail open exactly the
  // same way an absent binding does. Letting either exception propagate would
  // turn a defense-in-depth control into a hard outage for every caller the
  // instant KV has a bad moment — precisely the failure mode "fails open" is
  // meant to rule out.
  let raw: string | null;
  try {
    raw = await kv.get(storageKey);
  } catch {
    return openResult;
  }

  const count = raw ? Number.parseInt(raw, 10) : 0;
  const currentCount = Number.isFinite(count) && count >= 0 ? count : 0;

  if (currentCount >= config.maxRequests) {
    return { allowed: false, remaining: 0, resetSeconds };
  }

  try {
    // TTL a few seconds past the window's own end, so a slow write never
    // resurrects a stale bucket into the next window.
    await kv.put(storageKey, String(currentCount + 1), { expirationTtl: config.windowSeconds + 5 });
  } catch {
    // The count could not be recorded, but the request itself is still
    // within budget as far as this call could observe — allow it rather than
    // refuse a legitimate caller for a write-side KV problem.
    return { allowed: true, remaining: config.maxRequests - currentCount - 1, resetSeconds };
  }
  return { allowed: true, remaining: config.maxRequests - currentCount - 1, resetSeconds };
}

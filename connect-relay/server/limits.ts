/**
 * Abuse limits. Every number here bounds what one address or one install can
 * make the relay hold or do; none of them is reached by one owner using
 * ChatGPT normally.
 */
import type { BucketSpec } from '../shared/rate-limit.ts';
import { KeyedCounter, KeyedTokenBuckets } from '../shared/rate-limit.ts';

export interface RelayLimits {
  /** New install registrations per address (burst, refill). */
  readonly registrationsPerIp: BucketSpec;
  /** New registrations across the relay. */
  readonly registrationsGlobal: BucketSpec;
  /** Session attempts (WebSocket upgrades) per address. */
  readonly sessionAttemptsPerIp: BucketSpec;
  /** Live sessions per address. */
  readonly sessionsPerIp: number;
  /** Live sessions across the relay. */
  readonly maxSessions: number;
  /** Time a new session has to authenticate. */
  readonly authTimeoutMs: number;
  /** Public requests per install. */
  readonly requestsPerInstall: BucketSpec;
  /** Requests in flight per install; the last slot is reserved for the dashboard tool. */
  readonly concurrentPerInstall: number;
  /** Unauthenticated-route requests (token, metadata, bridge, 401s) per address. */
  readonly publicRequestsPerIp: BucketSpec;
  readonly maxRequestBodyBytes: number;
  readonly maxResponseBodyBytes: number;
  /** Wait for the install's response head. */
  readonly responseHeadTimeoutMs: number;
  /** Longest silence inside a streaming response. */
  readonly responseIdleTimeoutMs: number;
  /** Longest any one response may stream. */
  readonly responseTotalTimeoutMs: number;
  /** Registrations with no session for this long are dropped. */
  readonly inactiveRegistrationTtlMs: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  registrationsPerIp: { capacity: 5, refillPerSecond: 5 / 3600 },
  registrationsGlobal: { capacity: 200, refillPerSecond: 200 / 3600 },
  sessionAttemptsPerIp: { capacity: 30, refillPerSecond: 0.5 },
  sessionsPerIp: 20,
  maxSessions: 20_000,
  authTimeoutMs: 10_000,
  requestsPerInstall: { capacity: 60, refillPerSecond: 10 },
  concurrentPerInstall: 8,
  publicRequestsPerIp: { capacity: 120, refillPerSecond: 20 },
  maxRequestBodyBytes: 1024 * 1024,
  maxResponseBodyBytes: 8 * 1024 * 1024,
  responseHeadTimeoutMs: 5 * 60_000,
  responseIdleTimeoutMs: 5 * 60_000,
  responseTotalTimeoutMs: 30 * 60_000,
  inactiveRegistrationTtlMs: 90 * 24 * 60 * 60_000,
};

export type Admission = { ok: true; release: () => void } | { ok: false; reason: 'rate_limited' | 'busy' };

/**
 * Per-install request admission: a token bucket for rate, and a concurrency
 * cap whose last slot only a dashboard call may take.
 */
export function createInstallAdmission(limits: RelayLimits, now?: () => number): {
  admit(installId: string, dashboard: boolean): Admission;
  inFlight(installId: string): number;
} {
  const rate = new KeyedTokenBuckets(limits.requestsPerInstall, now);
  const concurrent = new KeyedCounter();
  return {
    admit(installId, dashboard) {
      const max = dashboard ? limits.concurrentPerInstall : Math.max(1, limits.concurrentPerInstall - 1);
      // Concurrency first: a refused request should not also spend a rate token.
      if (concurrent.get(installId) >= max) return { ok: false, reason: 'busy' };
      if (!rate.take(installId)) return { ok: false, reason: 'rate_limited' };
      const release = concurrent.tryAcquire(installId, max);
      return release ? { ok: true, release } : { ok: false, reason: 'busy' };
    },
    inFlight: (installId) => concurrent.get(installId),
  };
}

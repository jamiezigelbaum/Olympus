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
  /**
   * Requests per install whose credential the install's engine has already
   * confirmed (the owner's lane). Unconfirmed credentials never spend it.
   */
  readonly requestsPerInstall: BucketSpec;
  /** Owner-lane requests in flight per install; the last slot is reserved for the dashboard tool. */
  readonly concurrentPerInstall: number;
  /**
   * Requests in flight per install whose credential is not yet confirmed (a
   * fresh token, token and revocation calls, and any forged secret). A pool
   * of its own: it can never take an owner-lane slot.
   */
  readonly unverifiedConcurrentPerInstall: number;
  /** Unauthenticated-route requests (token, metadata, bridge, 401s, unconfirmed credentials) per address. */
  readonly publicRequestsPerIp: BucketSpec;
  readonly maxRequestBodyBytes: number;
  readonly maxResponseBodyBytes: number;
  /** Request bodies being uploaded at once, across the relay. */
  readonly maxConcurrentUploads: number;
  /** Request bodies being uploaded at once from one address. */
  readonly uploadsPerIp: number;
  /** Bytes of request bodies the relay holds while they upload, across the relay. */
  readonly maxUploadBufferedBytes: number;
  /** Longest one request body may take to upload. */
  readonly uploadTimeoutMs: number;
  /** Longest silence inside one request body upload. */
  readonly uploadIdleTimeoutMs: number;
  /** Response bytes queued for slow public callers, per install session. */
  readonly maxSessionQueuedBytes: number;
  /** Response bytes queued for slow public callers, across the relay. */
  readonly maxQueuedBytes: number;
  /** Body frames one response may carry. */
  readonly maxResponseFrames: number;
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
  unverifiedConcurrentPerInstall: 4,
  publicRequestsPerIp: { capacity: 120, refillPerSecond: 20 },
  maxRequestBodyBytes: 1024 * 1024,
  maxResponseBodyBytes: 8 * 1024 * 1024,
  maxConcurrentUploads: 512,
  uploadsPerIp: 64,
  maxUploadBufferedBytes: 64 * 1024 * 1024,
  uploadTimeoutMs: 30_000,
  uploadIdleTimeoutMs: 10_000,
  maxSessionQueuedBytes: 16 * 1024 * 1024,
  maxQueuedBytes: 256 * 1024 * 1024,
  maxResponseFrames: 65_536,
  responseHeadTimeoutMs: 5 * 60_000,
  responseIdleTimeoutMs: 5 * 60_000,
  responseTotalTimeoutMs: 30 * 60_000,
  inactiveRegistrationTtlMs: 90 * 24 * 60 * 60_000,
};

/** `owner`: a confirmed credential; `unverified`: anything the engine has not confirmed yet. */
export type AdmissionLane = 'owner' | 'unverified';

export type Admission =
  | {
    ok: true;
    /** Frees the concurrency slot; one-shot. */
    release: () => void;
    /** Gives the rate token back (the engine did not authenticate the request); one-shot. */
    refund: () => void;
  }
  | { ok: false; reason: 'rate_limited' | 'busy' };

/**
 * Per-install request admission, in two independent lanes.
 *
 * The owner lane is for credentials the install's engine has already
 * confirmed: a token bucket for rate, and a concurrency cap whose last slot
 * only a dashboard call may take. The unverified lane has its own small
 * concurrency pool and spends no per-install rate at all (the caller's address
 * pays, server/relay.ts), so traffic with a forged secret for a known install
 * id can neither drain the owner's rate nor take the owner's slots.
 */
export function createInstallAdmission(limits: RelayLimits, now?: () => number): {
  admit(installId: string, lane: AdmissionLane, dashboard: boolean): Admission;
  inFlight(installId: string): number;
} {
  const rate = new KeyedTokenBuckets(limits.requestsPerInstall, now);
  const owner = new KeyedCounter();
  const unverified = new KeyedCounter();
  return {
    admit(installId, lane, dashboard) {
      if (lane === 'unverified') {
        const release = unverified.tryAcquire(installId, Math.max(1, limits.unverifiedConcurrentPerInstall));
        return release ? { ok: true, release, refund: () => {} } : { ok: false, reason: 'busy' };
      }
      const max = dashboard ? limits.concurrentPerInstall : Math.max(1, limits.concurrentPerInstall - 1);
      // Concurrency first: a refused request should not also spend a rate token.
      if (owner.get(installId) >= max) return { ok: false, reason: 'busy' };
      if (!rate.take(installId)) return { ok: false, reason: 'rate_limited' };
      const release = owner.tryAcquire(installId, max);
      if (!release) return { ok: false, reason: 'busy' };
      let refunded = false;
      return {
        ok: true,
        release,
        refund: () => {
          if (refunded) return;
          refunded = true;
          rate.refund(installId);
        },
      };
    },
    inFlight: (installId) => owner.get(installId) + unverified.get(installId),
  };
}

/**
 * Credentials an install's engine has confirmed, by digest, for a bounded
 * time. Only an admission hint: the engine still checks every request.
 */
export class ConfirmedCredentials {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  has(key: string): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key: string): void {
    this.entries.delete(key);
    this.entries.set(key, this.now() + this.ttlMs);
    // Map order is insertion order: the first entry is the oldest.
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

/**
 * Request bodies while they upload: a global and a per-address count of
 * uploads, and a global byte budget charged as bytes arrive. A ticket is taken
 * before any body byte is read.
 */
export class UploadBudget {
  private uploads = 0;
  private bytes = 0;
  private readonly perAddress = new KeyedCounter();

  constructor(private readonly limits: RelayLimits) {}

  get active(): number {
    return this.uploads;
  }

  get bufferedBytes(): number {
    return this.bytes;
  }

  /** A ticket for one upload, or undefined when the relay or this address is at its cap. */
  begin(address: string): UploadTicket | undefined {
    if (this.uploads >= this.limits.maxConcurrentUploads) return undefined;
    const releaseAddress = this.perAddress.tryAcquire(address, this.limits.uploadsPerIp);
    if (!releaseAddress) return undefined;
    this.uploads += 1;
    let charged = 0;
    let done = false;
    return {
      charge: (n) => {
        if (done || this.bytes + n > this.limits.maxUploadBufferedBytes) return false;
        this.bytes += n;
        charged += n;
        return true;
      },
      end: () => {
        if (done) return;
        done = true;
        this.bytes -= charged;
        this.uploads -= 1;
        releaseAddress();
      },
    };
  }
}

export interface UploadTicket {
  /** Charges `n` more buffered bytes; false when the relay-wide budget is spent. */
  charge(n: number): boolean;
  /** Releases the ticket and every byte it charged; one-shot. */
  end(): void;
}

/** Response bytes queued for public callers that read slower than installs send, across the relay. */
export class QueueBudget {
  used = 0;

  constructor(readonly max: number) {}
}

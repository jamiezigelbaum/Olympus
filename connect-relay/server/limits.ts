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
   * `/mcp` requests in flight per install whose credential is not yet
   * confirmed (a fresh or rotated token, or a forged secret). A pool of its
   * own: it can never take an owner-lane slot. Shared fairly by address
   * (`unverifiedPerAddress` each, the rest waiting round-robin), so one
   * address cannot hold it.
   */
  readonly unverifiedConcurrentPerInstall: number;
  /** OAuth control requests (`/connect/token`, `/connect/revoke`) in flight per install: their own fair pool. */
  readonly controlConcurrentPerInstall: number;
  /** Slots one address may hold at once in an install's unverified or control pool. */
  readonly unverifiedPerAddress: number;
  /** Requests one address may have waiting for an install's unverified or control pool. */
  readonly unverifiedQueuePerAddress: number;
  /** Longest wait for a slot in an unverified or control pool before a 503. */
  readonly unverifiedQueueWaitMs: number;
  /**
   * Seconds an HTTP connection may sit with nothing written to it (Bun's
   * idleTimeout). Closes the transport behind every refusal and timed-out
   * upload; a request forwarded to an install lifts it, so its own timers
   * (head, idle, total) govern long answers and streams instead. WebSocket
   * sessions have their own idle limit and heartbeat.
   */
  readonly connectionIdleTimeoutSeconds: number;
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
  controlConcurrentPerInstall: 2,
  unverifiedPerAddress: 1,
  unverifiedQueuePerAddress: 2,
  unverifiedQueueWaitMs: 10_000,
  connectionIdleTimeoutSeconds: 15,
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

/**
 * `owner`: a confirmed credential. `unverified`: an `/mcp` credential the
 * engine has not confirmed yet. `control`: OAuth token and revocation calls.
 */
export type AdmissionLane = 'owner' | 'unverified' | 'control';

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
 * A concurrency pool shared fairly between keys (caller addresses): each key
 * may hold `perKey` slots; requests beyond that, or beyond capacity, wait in a
 * short per-key queue and are granted round-robin across keys as slots free.
 * So a flood from one address holds at most `perKey` slots, and a flood from
 * many addresses delays another address by at most one turn per active key.
 */
export class FairPool {
  private inFlight = 0;
  private readonly held = new Map<string, number>();
  /** Keys with waiters, in rotation order (re-inserted at the end after each grant). */
  private readonly waiting = new Map<string, Array<(release: (() => void) | undefined) => void>>();
  private queued = 0;

  constructor(
    private readonly capacity: number,
    private readonly perKey: number,
    private readonly queuePerKey: number,
    private readonly maxQueued = 256,
  ) {}

  get idle(): boolean {
    return this.inFlight === 0 && this.queued === 0;
  }

  get active(): number {
    return this.inFlight;
  }

  /** A release function once a slot is granted, or undefined (queue full, wait expired, caller gone). */
  acquire(key: string, waitMs: number, signal?: AbortSignal): Promise<(() => void) | undefined> {
    if (!this.waiting.has(key) && this.canRun(key)) return Promise.resolve(this.start(key));
    const list = this.waiting.get(key) ?? [];
    if (list.length >= this.queuePerKey || this.queued >= this.maxQueued || signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (release: (() => void) | undefined) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', giveUp);
        resolve(release);
      };
      const giveUp = () => {
        const current = this.waiting.get(key);
        const index = current?.indexOf(settle) ?? -1;
        if (index < 0) return;
        current!.splice(index, 1);
        this.queued -= 1;
        if (current!.length === 0) this.waiting.delete(key);
        settle(undefined);
      };
      timer = setTimeout(giveUp, waitMs);
      signal?.addEventListener('abort', giveUp, { once: true });
      list.push(settle);
      this.waiting.set(key, list);
      this.queued += 1;
    });
  }

  private canRun(key: string): boolean {
    return this.inFlight < this.capacity && (this.held.get(key) ?? 0) < this.perKey;
  }

  private start(key: string): () => void {
    this.inFlight += 1;
    this.held.set(key, (this.held.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      const remaining = (this.held.get(key) ?? 1) - 1;
      if (remaining > 0) this.held.set(key, remaining);
      else this.held.delete(key);
      this.dispatch();
    };
  }

  private dispatch(): void {
    for (const [key, list] of this.waiting) {
      if (this.inFlight >= this.capacity) return;
      if (!this.canRun(key)) continue;
      const grant = list.shift()!;
      this.queued -= 1;
      // To the back of the rotation (Map iteration then skips it: it is at its per-key cap or out of waiters).
      this.waiting.delete(key);
      if (list.length > 0) this.waiting.set(key, list);
      grant(this.start(key));
    }
  }
}

/**
 * Per-install request admission, in three independent lanes.
 *
 * The owner lane is for credentials the install's engine has already
 * confirmed: a token bucket for rate, and a concurrency cap whose last slot
 * only a dashboard call may take. The unverified and control lanes are small
 * fair pools of their own (FairPool, keyed by caller address) and spend no
 * per-install rate (the caller's address pays, server/relay.ts). Traffic with
 * a forged secret for a known install id therefore cannot drain the owner's
 * rate, take the owner's slots, or hold the way in for a fresh token, a
 * refresh or a revocation from another address.
 */
export function createInstallAdmission(limits: RelayLimits, now?: () => number): {
  admit(installId: string, lane: AdmissionLane, dashboard: boolean, address?: string, signal?: AbortSignal): Promise<Admission>;
  inFlight(installId: string): number;
} {
  const rate = new KeyedTokenBuckets(limits.requestsPerInstall, now);
  const owner = new KeyedCounter();
  const pools = { unverified: new Map<string, FairPool>(), control: new Map<string, FairPool>() };
  const poolFor = (lane: 'unverified' | 'control', installId: string): FairPool => {
    let pool = pools[lane].get(installId);
    if (!pool) {
      const capacity = lane === 'unverified' ? limits.unverifiedConcurrentPerInstall : limits.controlConcurrentPerInstall;
      pool = new FairPool(Math.max(1, capacity), Math.max(1, limits.unverifiedPerAddress), Math.max(0, limits.unverifiedQueuePerAddress));
      pools[lane].set(installId, pool);
    }
    return pool;
  };
  return {
    async admit(installId, lane, dashboard, address = 'unknown', signal) {
      if (lane !== 'owner') {
        const pool = poolFor(lane, installId);
        const release = await pool.acquire(address, limits.unverifiedQueueWaitMs, signal);
        if (!release) {
          if (pool.idle) pools[lane].delete(installId);
          return { ok: false, reason: 'busy' };
        }
        return {
          ok: true,
          release: () => {
            release();
            if (pool.idle && pools[lane].get(installId) === pool) pools[lane].delete(installId);
          },
          refund: () => {},
        };
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
    inFlight: (installId) => owner.get(installId) + (pools.unverified.get(installId)?.active ?? 0) + (pools.control.get(installId)?.active ?? 0),
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

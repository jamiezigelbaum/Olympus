/** Keyed token buckets. Idle full buckets are dropped so memory tracks active keys only. */
export interface BucketSpec {
  /** Maximum burst. */
  readonly capacity: number;
  /** Tokens regained per second. */
  readonly refillPerSecond: number;
}

export class KeyedTokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly spec: BucketSpec,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.spec.capacity, at: now };
    bucket.tokens = Math.min(this.spec.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.spec.refillPerSecond);
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 10_000) this.sweep(now);
    return true;
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const tokens = bucket.tokens + ((now - bucket.at) / 1000) * this.spec.refillPerSecond;
      if (tokens >= this.spec.capacity) this.buckets.delete(key);
    }
  }
}

/** Concurrent-use counters per key (e.g. open connections per address). */
export class KeyedCounter {
  private readonly counts = new Map<string, number>();

  /** Returns a one-shot release function, or undefined when `key` is at `max`. */
  tryAcquire(key: string, max: number): (() => void) | undefined {
    const current = this.counts.get(key) ?? 0;
    if (current >= max) return undefined;
    this.counts.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.counts.get(key) ?? 1) - 1;
      if (remaining > 0) this.counts.set(key, remaining);
      else this.counts.delete(key);
    };
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

/**
 * The key used for per-address limits. IPv4-mapped IPv6 collapses to IPv4, and
 * native IPv6 is keyed by its /64: one subscriber usually holds a whole /64,
 * so per-address limits would otherwise be trivially rotated around.
 */
export function addressKey(address: string | undefined): string {
  if (!address) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (!address.includes(':')) return address;
  const [head = '', tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((group) => (group || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

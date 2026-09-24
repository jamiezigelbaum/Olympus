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

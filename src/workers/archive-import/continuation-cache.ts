/**
 * Keeps a zip member's inflater between the passes of one import.
 *
 * An import reads an archive in passes of a bounded number of items, each
 * pass a fresh connector. A deflated member cannot be entered in the middle:
 * its inflater has to run from the start. Without help, every pass would
 * inflate the member again from its first byte up to where the last pass
 * stopped, which for a member of hundreds of megabytes makes the whole read
 * quadratic. A pass that stops at a page boundary parks the inflater here,
 * exactly where it stopped, and the next pass takes it back.
 *
 * - Process-local and lost on restart: a pass that finds nothing inflates
 *   from the member's start, which is slower but gives the same bytes.
 * - Bounded: a few members, a fixed total of retained bytes, and an idle
 *   limit, so a stopped import does not hold memory.
 * - Keyed by the archive, the manifest it was approved at, the file and the
 *   member, and taken only at the offset it stopped at. A changed archive has
 *   a new manifest, and a member whose directory entry changed is refused by
 *   the reader itself, so a stale inflater is never fed to a different member.
 */
import type { ZipContinuation } from './zip-reader.ts';

export const CONTINUATION_CACHE_MAX_ENTRIES = 4;
export const CONTINUATION_CACHE_MAX_BYTES = 48 * 1024 * 1024;
export const CONTINUATION_CACHE_MAX_IDLE_MS = 10 * 60 * 1000;

export interface ContinuationKey {
  archiveId: string;
  manifestTag: string;
  fileIndex: number;
  memberIndex: number;
}

interface Parked {
  key: ContinuationKey;
  continuation: ZipContinuation;
  parkedAt: number;
}

function sameKey(a: ContinuationKey, b: ContinuationKey): boolean {
  return a.archiveId === b.archiveId && a.manifestTag === b.manifestTag
    && a.fileIndex === b.fileIndex && a.memberIndex === b.memberIndex;
}

export class ContinuationCache {
  private entries: Parked[] = [];
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxIdleMs: number;
  private readonly now: () => number;

  constructor(options: { maxEntries?: number; maxBytes?: number; maxIdleMs?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? CONTINUATION_CACHE_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? CONTINUATION_CACHE_MAX_BYTES;
    this.maxIdleMs = options.maxIdleMs ?? CONTINUATION_CACHE_MAX_IDLE_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * How many inflaters are parked.
   */
  get size(): number {
    this.expire();
    return this.entries.length;
  }

  /**
   * Bytes the parked inflaters hold, as they estimate it.
   */
  get retainedBytes(): number {
    this.expire();
    return this.entries.reduce((sum, parked) => sum + parked.continuation.retainedBytes, 0);
  }

  /**
   * Parks an inflater for the member, replacing one already parked for it.
   * One that alone is more than the cache holds is not kept.
   */
  put(key: ContinuationKey, continuation: ZipContinuation): void {
    this.expire();
    this.entries = this.entries.filter((parked) => !sameKey(parked.key, key));
    if (continuation.retainedBytes > this.maxBytes) return;
    this.entries.push({ key: { ...key }, continuation, parkedAt: this.now() });
    // The least recently parked go first.
    while (this.entries.length > this.maxEntries || this.retainedTotal() > this.maxBytes) this.entries.shift();
  }

  /**
   * The parked inflater for the member if it stopped at `offset`, taken out
   * of the cache (a pass owns it until it parks it again).
   */
  take(key: ContinuationKey, offset: number): ZipContinuation | undefined {
    this.expire();
    const index = this.entries.findIndex((parked) => sameKey(parked.key, key));
    if (index < 0) return undefined;
    const [parked] = this.entries.splice(index, 1);
    return parked!.continuation.position === offset ? parked!.continuation : undefined;
  }

  /**
   * Drops everything parked for an archive (it is being removed, or stopped).
   */
  dropArchive(archiveId: string): void {
    this.entries = this.entries.filter((parked) => parked.key.archiveId !== archiveId);
  }

  clear(): void {
    this.entries = [];
  }

  private retainedTotal(): number {
    return this.entries.reduce((sum, parked) => sum + parked.continuation.retainedBytes, 0);
  }

  private expire(): void {
    const cutoff = this.now() - this.maxIdleMs;
    if (this.entries.some((parked) => parked.parkedAt < cutoff)) {
      this.entries = this.entries.filter((parked) => parked.parkedAt >= cutoff);
    }
  }
}

/**
 * The one cache every format's connector shares in this process.
 */
export const archiveContinuations = new ContinuationCache();

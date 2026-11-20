import { ledgerReadOffThread } from '../connector-store/child-visibility.ts';
import { BACKGROUND_READS } from '../connector-store/off-thread-reads.ts';
import type { TierLedger, TierLedgerOverPrivateCount } from './tier-ledger.ts';

// Never more often than this on a busy ledger, and never again on a ledger
// that has not changed since its last count (an idle box reads nothing).
const OVER_PRIVATE_REFRESH_MS = 3 * 60_000;

export type TierOverPrivateStatus = { state: 'counting' } | {
  state: 'measured';
  items: number;
  by_provider: Record<string, number>;
  oldest_since: string | null;
  measured_at: string;
};

/** Called by background upkeep and after a move drain. Status readers only get the last snapshot. */
export class TierOverPrivateMonitor {
  private readonly counts = new Map<TierLedger, { attemptedAt: number; measuredAt?: number; marker?: string; rows?: TierLedgerOverPrivateCount[] }>();
  private changed = new Set<string>();
  private running = false;
  private published: TierOverPrivateStatus = { state: 'counting' };

  constructor(
    private readonly ledgers: () => readonly TierLedger[],
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  status(): TierOverPrivateStatus {
    return this.published;
  }

  async refresh(changedPaths?: ReadonlySet<string>): Promise<void> {
    for (const path of changedPaths ?? []) this.changed.add(path);
    if (this.running) return;
    this.running = true;
    try {
      do {
        const changed = this.changed;
        this.changed = new Set();
        const ledgers = new Set(new Map(this.ledgers().map(ledger => [ledger.dbPath, ledger])).values());
        for (const ledger of this.counts.keys()) if (!ledgers.has(ledger)) this.counts.delete(ledger);
        for (const ledger of ledgers) {
          const previous = this.counts.get(ledger);
          const attemptedAt = this.now();
          const marker = ledger.changeMarker();
          if (previous && !changed.has(ledger.dbPath)
            && (attemptedAt - previous.attemptedAt < OVER_PRIVATE_REFRESH_MS || (previous.rows && previous.marker === marker))) continue;
          this.counts.set(ledger, { ...previous, attemptedAt });
          try {
            const rows = await ledgerReadOffThread(ledger, ledger.overPrivateCountSteps(), BACKGROUND_READS);
            this.counts.set(ledger, { attemptedAt, measuredAt: this.now(), marker, rows });
          } catch (error) {
            this.log(`Olympus tier status: could not count over-private items (${error instanceof Error ? error.name : 'error'}).`);
          }
        }
        this.publish();
      } while (this.changed.size > 0);
    } finally {
      this.running = false;
    }
  }

  private publish(): void {
    let measuredAt = Infinity;
    let oldest: string | null = null;
    let items = 0;
    const byProvider = new Map<string, number>();
    for (const count of this.counts.values()) {
      if (!count.rows || count.measuredAt === undefined) {
        this.published = { state: 'counting' };
        return;
      }
      measuredAt = Math.min(measuredAt, count.measuredAt);
      for (const row of count.rows) {
        items += row.items;
        byProvider.set(row.provider, (byProvider.get(row.provider) ?? 0) + row.items);
        if (oldest === null || row.oldest_since < oldest) oldest = row.oldest_since;
      }
    }
    this.published = this.counts.size === 0 ? { state: 'counting' } : {
      state: 'measured', items, by_provider: Object.fromEntries(byProvider),
      oldest_since: oldest, measured_at: new Date(measuredAt).toISOString(),
    };
  }
}

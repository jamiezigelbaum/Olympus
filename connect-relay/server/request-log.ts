import type { RequestLogEntry } from '../shared/request-log.ts';

/** Memory only. A global insertion order makes the total cap oldest-first. */
export class OfflineRequestLog {
  private readonly events = new Map<number, { installId: string; entry: RequestLogEntry; at: number }>();
  private readonly installs = new Map<string, Set<number>>();
  private sequence = 0;
  constructor(private readonly now: () => number = Date.now, private readonly totalLimit = 20_000) {}

  get size(): number { return this.events.size; }

  private remove(id: number): void {
    const event = this.events.get(id);
    if (!event) return;
    this.events.delete(id);
    const ids = this.installs.get(event.installId)!;
    ids.delete(id);
    if (!ids.size) this.installs.delete(event.installId);
  }

  sweep(): void {
    const cutoff = this.now() - 24 * 3600_000;
    for (const [id, event] of this.events) {
      if (event.at > cutoff) break;
      this.remove(id);
    }
  }

  push(installId: string, entry: RequestLogEntry): void {
    this.sweep();
    const ids = this.installs.get(installId) ?? new Set<number>();
    this.installs.set(installId, ids);
    const id = ++this.sequence;
    ids.add(id);
    this.events.set(id, { installId, entry, at: this.now() });
    if (ids.size > 100) this.remove(ids.values().next().value!);
    while (this.events.size > this.totalLimit) this.remove(this.events.keys().next().value!);
  }

  take(installId: string): RequestLogEntry[] {
    this.sweep();
    const entries: RequestLogEntry[] = [];
    for (const id of this.installs.get(installId) ?? []) {
      entries.push(this.events.get(id)!.entry);
      this.remove(id);
    }
    return entries;
  }
}

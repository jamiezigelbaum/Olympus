/**
 * Daily usage totals: how many installs connected each day, how many were
 * new, how many requests the relay forwarded. Counts only, as the relay's
 * status is: the file names no install. The ids of the installs seen today
 * are held in memory, the way the relay already holds which installs are
 * online, and only their number is written.
 *
 * Installs the operator marked internal (the team's own machines) and the
 * reviewer demo installs are left out of every count, so the totals track
 * other people's use.
 *
 * One row per UTC day, rewritten in place (atomic rename, 0600) while the day
 * runs, so a restart keeps the day's counters. A day the relay was down for
 * has no row.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryInstallRegistry } from './registry.ts';

export interface UsageDay {
  /** UTC date, YYYY-MM-DD. */
  readonly day: string;
  /** Installs that connected or sent a heartbeat that day. */
  active: number;
  /** Installs registered for the first time that day. */
  newInstalls: number;
  /** Installs that registered again after their registration had expired. */
  returning: number;
  /** Registrations that expired that day (90 days unused, or never confirmed). */
  removed: number;
  /** Requests forwarded to installs (questions, tool calls, sign-ins). */
  requests: number;
  /** Registered installs at the end of the day (or now, for today). */
  registered: number;
  /** Installs seen in the 7 and 30 days up to the end of the day. */
  active7: number;
  active30: number;
}

const DAY_MS = 24 * 60 * 60_000;
/** About two years of rows. */
const MAX_DAYS = 800;

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function emptyDay(day: string): UsageDay {
  return { day, active: 0, newInstalls: 0, returning: 0, removed: 0, requests: 0, registered: 0, active7: 0, active30: 0 };
}

export class UsageLedger {
  private readonly days: UsageDay[] = [];
  private readonly activeToday = new Set<string>();

  constructor(
    private readonly registry: MemoryInstallRegistry,
    /** Installs left out of every count (internal and demo installs). */
    private readonly excluded: (installId: string) => boolean,
    private readonly path?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (path && existsSync(path)) this.days.push(...parseDays(readFileSync(path, 'utf8')));
    const today = utcDay(this.now());
    if (this.current()?.day !== today) this.days.push(emptyDay(today));
    // Installs that connected earlier today, before a restart, count again
    // only once: the registry still has their last-seen time.
    const start = Date.parse(`${today}T00:00:00Z`);
    for (const record of registry.allRecords()) {
      if (record.lastSeenAt >= start && !this.excluded(record.installId)) this.activeToday.add(record.installId);
    }
    this.current()!.active = Math.max(this.current()!.active, this.activeToday.size);
  }

  /** A session started or a heartbeat arrived. */
  active(installId: string): void {
    const day = this.roll();
    if (this.excluded(installId) || this.activeToday.has(installId)) return;
    this.activeToday.add(installId);
    day.active = Math.max(day.active, this.activeToday.size);
  }

  registered(installId: string, returning: boolean): void {
    const day = this.roll();
    if (this.excluded(installId)) return;
    if (returning) day.returning += 1;
    else day.newInstalls += 1;
  }

  removed(installId: string): void {
    const day = this.roll();
    if (!this.excluded(installId)) day.removed += 1;
  }

  request(installId: string): void {
    const day = this.roll();
    if (!this.excluded(installId)) day.requests += 1;
  }

  /** Every row, today's totals filled in as of now. */
  snapshot(): UsageDay[] {
    this.fillTotals(this.roll());
    return this.days.map((day) => ({ ...day }));
  }

  /** Writes the rows (atomic, 0600). Nothing to do without a path. */
  persist(): void {
    if (!this.path) return;
    const rows = this.snapshot();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp.${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, days: rows })}\n`, { mode: 0o600 });
    const fd = openSync(temporary, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path);
  }

  private current(): UsageDay | undefined {
    return this.days[this.days.length - 1];
  }

  /** Today's row, closing the previous day's first when the date changed. */
  private roll(): UsageDay {
    const today = utcDay(this.now());
    const current = this.current()!;
    if (current.day === today) return current;
    this.fillTotals(current);
    this.activeToday.clear();
    const next = emptyDay(today);
    this.days.push(next);
    if (this.days.length > MAX_DAYS) this.days.splice(0, this.days.length - MAX_DAYS);
    return next;
  }

  private fillTotals(day: UsageDay): void {
    const at = this.now();
    let registered = 0;
    let active7 = 0;
    let active30 = 0;
    for (const record of this.registry.allRecords()) {
      if (this.excluded(record.installId)) continue;
      registered += 1;
      if (at - record.lastSeenAt <= 7 * DAY_MS) active7 += 1;
      if (at - record.lastSeenAt <= 30 * DAY_MS) active30 += 1;
    }
    day.registered = registered;
    day.active7 = active7;
    day.active30 = active30;
  }
}

/** The rows of a usage file; anything malformed reads as no rows. */
export function parseDays(text: string): UsageDay[] {
  try {
    const parsed = JSON.parse(text) as { days?: unknown };
    if (!Array.isArray(parsed.days)) return [];
    return parsed.days
      .filter((row): row is UsageDay => typeof row === 'object' && row !== null && typeof (row as UsageDay).day === 'string')
      .map((row) => ({ ...emptyDay(row.day), ...row }));
  } catch {
    return [];
  }
}

/** Reads a usage file without the relay, for the admin command while it is stopped. */
export function readUsageFile(path: string): UsageDay[] {
  return existsSync(path) ? parseDays(readFileSync(path, 'utf8')) : [];
}

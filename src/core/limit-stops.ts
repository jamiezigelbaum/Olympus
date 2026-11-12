import type { Database } from 'bun:sqlite';
import { runSqliteMigrations } from './sqlite-migrations.ts';

export interface LimitRegistration {
  id: string;
  kind: 'cost' | 'requests' | 'calls' | 'time' | 'size' | 'funding';
  scope: 'source' | 'judge' | 'answer' | 'outside_help' | 'extraction';
  label: string;
  unit: 'usd' | 'requests' | 'calls' | 'ms' | 'bytes';
  continue: 'run_once' | 'raise' | 'refill' | 'none';
  pacing?: true;
}

export interface LimitStop {
  id: string;
  /** Stable work identity; never item text or a credential. */
  subject: string;
  since: string;
  /** Null means the reporting boundary does not know the amount. */
  limit: number | null;
  used: number | null;
  waiting?: { items?: number; runs?: number };
  toContinue?: { cost?: number; time?: number; raiseTo?: number };
  resumesAt?: string;
}

const limits = new Map<string, Readonly<LimitRegistration>>();

export function registerLimit(input: LimitRegistration): void {
  const prior = limits.get(input.id);
  if (prior && Object.keys({ ...prior, ...input }).some((key) =>
    prior[key as keyof LimitRegistration] !== input[key as keyof LimitRegistration])) {
    throw new Error(`Limit already registered differently: ${input.id}`);
  }
  limits.set(input.id, Object.freeze({ ...input }));
}

export function registeredLimits(): Readonly<LimitRegistration>[] {
  return [...limits.values()];
}

/** `needed` is the total required, not an increment. Unknown prices fail closed. */
export function withinOverrunMargin(kind: LimitRegistration['kind'], limit: number, needed: number | null | undefined): boolean {
  if (needed == null || !Number.isFinite(needed) || needed < 0 || !Number.isFinite(limit) || limit < 0) return false;
  const margin = kind === 'cost' ? Math.min(limit * 0.1, 0.50)
    : kind === 'requests' || kind === 'calls' ? limit * 0.1 : undefined;
  return margin !== undefined && needed <= limit + margin;
}

/** Called by the store that owns the database, alongside its own migrations. */
export function initializeLimitStops(db: Database): void {
  runSqliteMigrations(db, 'limit-stops', [{
    version: 1,
    name: 'create_limit_stops',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS limit_stops (
        id TEXT NOT NULL, subject TEXT NOT NULL, since TEXT NOT NULL,
        "limit" REAL, used REAL, waiting_json TEXT, to_continue_json TEXT,
        resumes_at TEXT, cleared_at TEXT, PRIMARY KEY (id, subject)
      )`);
    },
  }]);
}

// The owning store opens the database (store-open guard); this module only
// reads and writes its table through the connection it is given.

export function reportLimitStop(input: LimitStop, db: Database): void {
  if (!limits.has(input.id)) throw new Error(`Unregistered limit: ${input.id}`);
  for (const value of [input.limit, input.used, ...Object.values(input.waiting ?? {}), ...Object.values(input.toContinue ?? {})]) {
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new TypeError('Limit amounts must be non-negative finite numbers.');
  }
  if (!input.subject || !Number.isFinite(Date.parse(input.since))
    || (input.resumesAt !== undefined && !Number.isFinite(Date.parse(input.resumesAt)))) {
    throw new TypeError('Limit stops require a subject and valid timestamps.');
  }
  db.query(`
    INSERT INTO limit_stops (id, subject, since, "limit", used, waiting_json, to_continue_json, resumes_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, subject) DO UPDATE SET
      -- A stop still open keeps its start; a cleared or self-expired one starts again.
      since = CASE WHEN limit_stops.cleared_at IS NULL
        AND (limit_stops.resumes_at IS NULL OR limit_stops.resumes_at > excluded.since)
        THEN limit_stops.since ELSE excluded.since END,
      "limit" = excluded."limit", used = excluded.used,
      waiting_json = excluded.waiting_json, to_continue_json = excluded.to_continue_json,
      resumes_at = excluded.resumes_at, cleared_at = NULL
  `).run(input.id, input.subject, input.since, input.limit, input.used,
    input.waiting ? JSON.stringify(input.waiting) : null,
    input.toContinue ? JSON.stringify(input.toContinue) : null,
    // Stored in one ISO form, so listing can compare it as text.
    input.resumesAt === undefined ? null : new Date(input.resumesAt).toISOString());
}

export function clearLimitStop(id: string, subject: string, db: Database): void {
  db.query(`
    UPDATE limit_stops SET cleared_at = ? WHERE id = ? AND subject = ? AND cleared_at IS NULL
  `).run(new Date().toISOString(), id, subject);
}

/** Open stops at `now`: not cleared, and not past the time they resume by themselves. */
export function listOpenLimitStops(db: Database, now: Date = new Date()): LimitStop[] {
  // Reading a pre-upgrade database never creates or migrates a table.
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'limit_stops'").get()) return [];
  const rows = db.query(`SELECT * FROM limit_stops WHERE cleared_at IS NULL
    AND (resumes_at IS NULL OR resumes_at > ?) ORDER BY id, subject`).all(now.toISOString()) as Array<{
    id: string; subject: string; since: string; limit: number | null; used: number | null;
    waiting_json: string | null; to_continue_json: string | null; resumes_at: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id, subject: row.subject, since: row.since, limit: row.limit, used: row.used,
    ...(row.waiting_json ? { waiting: JSON.parse(row.waiting_json) } : {}),
    ...(row.to_continue_json ? { toContinue: JSON.parse(row.to_continue_json) } : {}),
    ...(row.resumes_at ? { resumesAt: row.resumes_at } : {}),
  }));
}

/** Source stops use a source/corpus id, or the scheduler's [source, corpus, task] identity. */
export function limitStopSubjects(stop: LimitStop): readonly string[] {
  try {
    const parts: unknown = JSON.parse(stop.subject);
    if (Array.isArray(parts) && parts.length === 3 && parts.every((part) => typeof part === 'string')) return parts.slice(0, 2);
  } catch { /* A plain source or corpus id is also a valid subject. */ }
  return [stop.subject];
}

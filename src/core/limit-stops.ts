import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sharedDataPath } from './olympus-layout.ts';
import { runSqliteMigrations } from './sqlite-migrations.ts';
import { closeSqliteStore } from './sqlite-store.ts';

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

/** Called by the background writer, alongside the scheduler's own migrations. */
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

type Connection = Database | string;

// An explicit connection lets the scheduler include the record in its marker
// transaction. Standalone callers use that same existing engine state database.
function withDatabase<T>(connection: Connection, write: boolean, action: (db: Database) => T): T {
  if (typeof connection !== 'string') return action(connection);
  if (write) mkdirSync(dirname(connection), { recursive: true, mode: 0o700 });
  const db = new Database(connection, write ? { create: true } : { readonly: true, create: false });
  try {
    db.exec('PRAGMA busy_timeout = 10000;');
    if (write) {
      chmodSync(connection, 0o600);
      db.exec('PRAGMA journal_mode = WAL;');
      initializeLimitStops(db);
    }
    return action(db);
  } finally {
    closeSqliteStore(db, { checkpoint: write });
  }
}

export function reportLimitStop(input: LimitStop, connection: Connection = sharedDataPath('source-scheduler')): void {
  if (!limits.has(input.id)) throw new Error(`Unregistered limit: ${input.id}`);
  for (const value of [input.limit, input.used, ...Object.values(input.waiting ?? {}), ...Object.values(input.toContinue ?? {})]) {
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new TypeError('Limit amounts must be non-negative finite numbers.');
  }
  if (!input.subject || !Number.isFinite(Date.parse(input.since))
    || (input.resumesAt !== undefined && !Number.isFinite(Date.parse(input.resumesAt)))) {
    throw new TypeError('Limit stops require a subject and valid timestamps.');
  }
  withDatabase(connection, true, (db) => db.query(`
    INSERT INTO limit_stops (id, subject, since, "limit", used, waiting_json, to_continue_json, resumes_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, subject) DO UPDATE SET
      since = CASE WHEN limit_stops.cleared_at IS NULL THEN limit_stops.since ELSE excluded.since END,
      "limit" = excluded."limit", used = excluded.used,
      waiting_json = excluded.waiting_json, to_continue_json = excluded.to_continue_json,
      resumes_at = excluded.resumes_at, cleared_at = NULL
  `).run(input.id, input.subject, input.since, input.limit, input.used,
    input.waiting ? JSON.stringify(input.waiting) : null,
    input.toContinue ? JSON.stringify(input.toContinue) : null, input.resumesAt ?? null));
}

export function clearLimitStop(id: string, subject: string, connection: Connection = sharedDataPath('source-scheduler')): void {
  withDatabase(connection, true, (db) => db.query(`
    UPDATE limit_stops SET cleared_at = ? WHERE id = ? AND subject = ? AND cleared_at IS NULL
  `).run(new Date().toISOString(), id, subject));
}

export function listOpenLimitStops(connection: Connection = sharedDataPath('source-scheduler')): LimitStop[] {
  if (typeof connection === 'string' && !existsSync(connection)) return [];
  return withDatabase(connection, false, (db) => {
    // Reading a pre-upgrade database never creates or migrates a table.
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'limit_stops'").get()) return [];
    const rows = db.query('SELECT * FROM limit_stops WHERE cleared_at IS NULL ORDER BY id, subject').all() as Array<{
      id: string; subject: string; since: string; limit: number | null; used: number | null;
      waiting_json: string | null; to_continue_json: string | null; resumes_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id, subject: row.subject, since: row.since, limit: row.limit, used: row.used,
      ...(row.waiting_json ? { waiting: JSON.parse(row.waiting_json) } : {}),
      ...(row.to_continue_json ? { toContinue: JSON.parse(row.to_continue_json) } : {}),
      ...(row.resumes_at ? { resumesAt: row.resumes_at } : {}),
    }));
  });
}

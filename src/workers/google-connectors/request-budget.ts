// Durable per-provider day counter for the Google connector lanes.
//
// The ledger is deliberately NOT stored in the connector-store sqlite: that
// file participates in qualification fingerprints, so a budget write would
// invalidate a receipt for a reason that has nothing to do with the corpus.
// A separate SQLite file gives every worker process one atomic conditional
// increment over (provider, utc_day).

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  sourceInvocationProvenance,
  type SourceInvocationProvenance,
} from '../../core/invocation-provenance.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';

const GOOGLE_REQUEST_BUDGET_STATE_VERSION = 1;
const GOOGLE_REQUEST_BUDGET_LEDGER_TABLE = 'google_request_budget_ledger';
const LEDGER_BUSY_RETRY_MS = 30_000;
const INITIALIZATION_BUSY_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 500, 750, 1_000, 1_500] as const;
const RESERVATION_BUSY_RETRY_DELAYS_MS = [10, 25, 50, 100] as const;
const SAFE_RECOVERY_REASON = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export type GoogleRequestBudgetErrorReason =
  | 'daily_api_request_guard'
  | 'future_utc_day'
  | 'ledger_busy';

export interface GoogleRequestBudgetStatus {
  utcDay: string;
  requests: number;
  dailyRequestBudget: number;
}

export interface GoogleDailyRequestBudgetOptions {
  /** Provider label; appears in the deferral message and ledger key only. */
  provider: string;
  dailyRequestBudget: number;
  /**
   * Durable counter location. Existing JSON state is imported into an adjacent
   * SQLite ledger; new `.sqlite` paths are used directly.
   */
  statePath?: string;
  now?: () => Date;
}

export interface GoogleRequestBudgetFutureDayRecoveryReceipt {
  kind: 'google_request_budget_future_day_recovered';
  status: 'recovered';
  provider: string;
  current_utc_day: string;
  expected_future_utc_day: string;
  removed_rows: number;
  removed_requests: number;
  reason: string;
  policy: {
    expected_future_day_guarded: true;
    current_and_past_days_untouched: true;
    counts_only: true;
  };
}

export type GoogleRequestBudgetRecoveryRefusalCode =
  | 'ledger_not_configured'
  | 'expected_future_utc_day_invalid'
  | 'no_future_utc_day'
  | 'expected_future_utc_day_mismatch';

export class GoogleRequestBudgetRecoveryRefusal extends Error {
  readonly code: GoogleRequestBudgetRecoveryRefusalCode;

  constructor(code: GoogleRequestBudgetRecoveryRefusalCode, message: string) {
    super(`Google request budget recovery refused (${code}): ${message}`);
    this.name = 'GoogleRequestBudgetRecoveryRefusal';
    this.code = code;
  }
}

export class GoogleRequestBudgetError extends Error {
  readonly retryAt: string;
  readonly provider: string;
  readonly reason: GoogleRequestBudgetErrorReason;
  readonly observedFutureUtcDay: string | undefined;

  constructor(
    provider: string,
    retryAt: string,
    reason: GoogleRequestBudgetErrorReason = 'daily_api_request_guard',
    options: { observedFutureUtcDay?: string; currentUtcDay?: string } = {},
  ) {
    super(
      reason === 'future_utc_day'
        ? `${provider} request budget clock regression: persisted future UTC day `
          + `${options.observedFutureUtcDay ?? 'future'} is later than current UTC day `
          + `${options.currentUtcDay ?? 'current'}; recover with `
          + '`olympus source request-budget recover-future` using the observed day.'
        : reason === 'ledger_busy'
          ? `${provider} request budget ledger remained busy; the provider request was refused before dispatch.`
          : `${provider} request deferred by daily_api_request_guard.`,
    );
    this.name = 'GoogleRequestBudgetError';
    this.provider = provider;
    this.retryAt = retryAt;
    this.reason = reason;
    this.observedFutureUtcDay = options.observedFutureUtcDay;
  }
}

export class GoogleDailyRequestBudget {
  private utcDay = '';
  private requests = 0;
  private readonly provider: string;
  private readonly dailyRequestBudget: number;
  private readonly ledgerPath: string | undefined;
  private readonly now: () => Date;

  constructor(options: GoogleDailyRequestBudgetOptions) {
    this.provider = providerLabel(options.provider);
    this.dailyRequestBudget = positiveInteger(
      options.dailyRequestBudget,
      `${options.provider} daily API request budget`,
    );
    this.now = options.now ?? (() => new Date());
    const statePath = options.statePath?.trim();
    if (statePath) {
      this.ledgerPath = requestBudgetLedgerPath(statePath);
      initializeRequestBudgetLedger(this.ledgerPath, this.provider, this.now);
      const restored = readLegacyRequestBudgetState(statePath, this.provider);
      if (restored) {
        runBudgetLedgerOperation(
          this.ledgerPath,
          this.provider,
          this.now,
          () => importLegacyRequestBudgetState(this.ledgerPath!, this.provider, restored),
          INITIALIZATION_BUSY_RETRY_DELAYS_MS,
        );
        // Retire only after the ledger commit: a crash in between just
        // re-imports idempotently. Left in place, the JSON would reinstate its
        // row on every construction and undo a guarded future-day recovery.
        retireLegacyRequestBudgetState(statePath);
      }
    }
  }

  /**
   * Counts one provider request against the day, refusing a ROUTINE request
   * that would cross the daily line.
   *
   * `daily_api_request_guard` is Olympus's own constraint on routine work, so
   * an operator run is exempt from it (owner ruling 2026-08-19) — but it is
   * exempt from that refusal ONLY. The clock-regression and ledger-busy
   * refusals below bind every provenance: the first says the durable counter
   * is not trustworthy and the second says the request could not be recorded
   * at all, and neither is a budget the owner ruled on. The count itself is
   * never waived either — an operator request increments past the line so the
   * next scheduled run is guarded against what the operator actually spent.
   */
  reserve(provenance?: SourceInvocationProvenance): void {
    const routine = sourceInvocationProvenance(provenance) === 'scheduled';
    const now = validDate(this.now(), this.provider);
    const utcDay = now.toISOString().slice(0, 10);
    if (this.ledgerPath) {
      reservePersistentRequest({
        ledgerPath: this.ledgerPath,
        provider: this.provider,
        utcDay,
        dailyRequestBudget: this.dailyRequestBudget,
        routine,
        now,
      });
      return;
    }

    // The process-local seam remains useful for unit tests and explicitly
    // ephemeral callers. It is forward-only for the same clock-safety reason
    // as the durable ledger.
    if (this.utcDay && utcDay < this.utcDay) {
      throw new GoogleRequestBudgetError(
        this.provider,
        utcDayAfter(this.utcDay),
        'future_utc_day',
        { observedFutureUtcDay: this.utcDay, currentUtcDay: utcDay },
      );
    }
    if (utcDay > this.utcDay) {
      this.utcDay = utcDay;
      this.requests = 0;
    }
    if (routine && this.requests >= this.dailyRequestBudget) {
      throw new GoogleRequestBudgetError(this.provider, nextUtcDay(now));
    }
    this.requests += 1;
  }

  status(): GoogleRequestBudgetStatus {
    const now = validDate(this.now(), this.provider);
    const utcDay = now.toISOString().slice(0, 10);
    return {
      utcDay,
      requests: this.ledgerPath
        ? persistentRequestsForDay(this.ledgerPath, this.provider, utcDay, this.now)
        : utcDay === this.utcDay ? this.requests : 0,
      dailyRequestBudget: this.dailyRequestBudget,
    };
  }

  /**
   * Guarded exit for a persisted clock-ahead row. The operator must name the
   * exact latest future UTC day they inspected; the transaction refuses if the
   * ledger changed, and it never touches current or past spend.
   */
  recoverFutureUtcDay(input: {
    expectedFutureUtcDay: string;
    reason: string;
  }): GoogleRequestBudgetFutureDayRecoveryReceipt {
    if (!this.ledgerPath) {
      throw new GoogleRequestBudgetRecoveryRefusal(
        'ledger_not_configured',
        'the budget has no durable ledger.',
      );
    }
    const now = validDate(this.now(), this.provider);
    const currentUtcDay = now.toISOString().slice(0, 10);
    const expectedFutureUtcDay = input.expectedFutureUtcDay.trim();
    if (!validUtcDay(expectedFutureUtcDay) || expectedFutureUtcDay <= currentUtcDay) {
      throw new GoogleRequestBudgetRecoveryRefusal(
        'expected_future_utc_day_invalid',
        'the expected day must be a valid UTC day later than the current UTC day.',
      );
    }
    const reason = safeRecoveryReason(input.reason);
    return runBudgetLedgerOperation(
      this.ledgerPath,
      this.provider,
      this.now,
      () => recoverPersistentFutureUtcDay({
        ledgerPath: this.ledgerPath!,
        provider: this.provider,
        currentUtcDay,
        expectedFutureUtcDay,
        reason,
      }),
      RESERVATION_BUSY_RETRY_DELAYS_MS,
    );
  }
}

function requestBudgetLedgerPath(statePath: string): string {
  return statePath.endsWith('.sqlite') ? statePath : `${statePath}.sqlite`;
}

function initializeRequestBudgetLedger(
  ledgerPath: string,
  provider: string,
  now: () => Date,
): void {
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  runBudgetLedgerOperation(
    ledgerPath,
    provider,
    now,
    () => withLedger(ledgerPath, (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${GOOGLE_REQUEST_BUDGET_LEDGER_TABLE} (
          provider TEXT NOT NULL,
          utc_day TEXT NOT NULL,
          requests INTEGER NOT NULL CHECK(requests >= 0),
          PRIMARY KEY(provider, utc_day)
        );
      `);
    }, { journalModeWal: true }),
    INITIALIZATION_BUSY_RETRY_DELAYS_MS,
  );
  hardenLedgerFiles(ledgerPath);
}

function reservePersistentRequest(input: {
  ledgerPath: string;
  provider: string;
  utcDay: string;
  dailyRequestBudget: number;
  /** False for an operator run: the daily line does not refuse it. */
  routine: boolean;
  now: Date;
}): void {
  runBudgetLedgerOperation(
    input.ledgerPath,
    input.provider,
    () => input.now,
    () => withLedger(input.ledgerPath, (db) => {
      const reserve = db.transaction(() => {
        const future = db.query(`
          SELECT MAX(utc_day) AS utc_day
          FROM ${GOOGLE_REQUEST_BUDGET_LEDGER_TABLE}
          WHERE provider = ? AND utc_day > ?
        `).get(input.provider, input.utcDay) as { utc_day?: string | null } | null;
        if (typeof future?.utc_day === 'string') {
          throw new GoogleRequestBudgetError(
            input.provider,
            utcDayAfter(future.utc_day),
            'future_utc_day',
            { observedFutureUtcDay: future.utc_day, currentUtcDay: input.utcDay },
          );
        }

        if (!input.routine) {
          // The same row, the same +1, without the budget predicate. Dropping
          // the increment instead would be the cheaper-looking exemption and
          // the wrong one: the ledger would then under-report the day and the
          // next SCHEDULED run would be admitted against spend that already
          // happened.
          db.query(`
            INSERT INTO ${GOOGLE_REQUEST_BUDGET_LEDGER_TABLE} (
              provider, utc_day, requests
            ) VALUES (?, ?, 1)
            ON CONFLICT(provider, utc_day) DO UPDATE SET
              requests = requests + 1
          `).run(input.provider, input.utcDay);
          return;
        }

        const reserved = db.query(`
          INSERT INTO ${GOOGLE_REQUEST_BUDGET_LEDGER_TABLE} (
            provider, utc_day, requests
          ) VALUES (?, ?, 1)
          ON CONFLICT(provider, utc_day) DO UPDATE SET
            requests = requests + 1
          WHERE requests < ?
          RETURNING requests
        `).get(
          input.provider,
          input.utcDay,
          input.dailyRequestBudget,
        ) as { requests?: number } | null;
        if (!reserved) {
          throw new GoogleRequestBudgetError(input.provider, nextUtcDay(input.now));
        }
      });
      reserve.immediate();
    }),
    RESERVATION_BUSY_RETRY_DELAYS_MS,
  );
}

function persistentRequestsForDay(
  ledgerPath: string,
  provider: string,
  utcDay: string,
  now: () => Date,
): number {
  return runBudgetLedgerOperation(
    ledgerPath,
    provider,
    now,
    () => withLedger(ledgerPath, (db) => {
      const row = db.query(`
        SELECT requests
        FROM ${GOOGLE_REQUEST_BUDGET_LEDGER_TABLE}
        WHERE provider = ? AND utc_day = ?
      `).get(provider, utcDay) as { requests?: number } | null;
      return typeof row?.requests === 'number' && Number.isSafeInteger(row.requests)
        ? row.requests
        : 0;
    }),
    RESERVATION_BUSY_RETRY_DELAYS_MS,
  );
}

function importLegacyRequestBudgetState(
  ledgerPath: string,
  provider: string,
  state: { utcDay: string; requests: number },
): void {
  withLedger(ledgerPath, (db) => {
    db.query(`
      INSERT INTO ${GOOGLE_REQUEST_BUDGET_LEDGER_TABLE} (
        provider, utc_day, requests
      ) VALUES (?, ?, ?)
      ON CONFLICT(provider, utc_day) DO UPDATE SET
        requests = MAX(requests, excluded.requests)
    `).run(provider, state.utcDay, state.requests);
  });
}

function recoverPersistentFutureUtcDay(input: {
  ledgerPath: string;
  provider: string;
  currentUtcDay: string;
  expectedFutureUtcDay: string;
  reason: string;
}): GoogleRequestBudgetFutureDayRecoveryReceipt {
  return withLedger(input.ledgerPath, (db) => {
    const recover = db.transaction(() => {
      const rows = db.query(`
        SELECT utc_day, requests
        FROM ${GOOGLE_REQUEST_BUDGET_LEDGER_TABLE}
        WHERE provider = ? AND utc_day > ?
        ORDER BY utc_day
      `).all(input.provider, input.currentUtcDay) as Array<{
        utc_day: string;
        requests: number;
      }>;
      const latest = rows.at(-1);
      if (!latest) {
        throw new GoogleRequestBudgetRecoveryRefusal(
          'no_future_utc_day',
          'the durable ledger has no future UTC day for this provider.',
        );
      }
      if (latest.utc_day !== input.expectedFutureUtcDay) {
        throw new GoogleRequestBudgetRecoveryRefusal(
          'expected_future_utc_day_mismatch',
          'the latest future UTC day does not match the guarded expectation.',
        );
      }
      const removedRequests = rows.reduce((sum, row) => sum + row.requests, 0);
      const deleted = db.query(`
        DELETE FROM ${GOOGLE_REQUEST_BUDGET_LEDGER_TABLE}
        WHERE provider = ? AND utc_day > ?
      `).run(input.provider, input.currentUtcDay);
      return {
        kind: 'google_request_budget_future_day_recovered' as const,
        status: 'recovered' as const,
        provider: input.provider,
        current_utc_day: input.currentUtcDay,
        expected_future_utc_day: input.expectedFutureUtcDay,
        removed_rows: deleted.changes,
        removed_requests: removedRequests,
        reason: input.reason,
        policy: {
          expected_future_day_guarded: true as const,
          current_and_past_days_untouched: true as const,
          counts_only: true as const,
        },
      };
    });
    return recover.immediate();
  });
}

function withLedger<T>(
  ledgerPath: string,
  run: (db: Database) => T,
  options: { journalModeWal?: boolean } = {},
): T {
  const db = new Database(ledgerPath, { create: true });
  hardenLedgerFiles(ledgerPath);
  try {
    db.exec(options.journalModeWal
      ? 'PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;'
      : 'PRAGMA busy_timeout = 10000;');
    return run(db);
  } finally {
    // This ledger opens once per provider request. A truncate checkpoint here
    // would demand an exclusive lock on the hottest path; normal SQLite WAL
    // checkpointing owns that lifecycle instead.
    hardenLedgerFiles(ledgerPath);
    closeSqliteStore(db, { checkpoint: false });
    hardenLedgerFiles(ledgerPath);
  }
}

function runBudgetLedgerOperation<T>(
  ledgerPath: string,
  provider: string,
  now: () => Date,
  run: () => T,
  retryDelaysMs: readonly number[],
): T {
  let retryIndex = 0;
  while (true) {
    try {
      return run();
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      const delayMs = retryDelaysMs[retryIndex];
      if (delayMs === undefined) {
        const observedNow = validDate(now(), provider);
        throw new GoogleRequestBudgetError(
          provider,
          new Date(observedNow.getTime() + LEDGER_BUSY_RETRY_MS).toISOString(),
          'ledger_busy',
        );
      }
      retryIndex += 1;
      Bun.sleepSync(delayMs);
      hardenLedgerFiles(ledgerPath);
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sqlite = error as Error & { code?: unknown; errno?: unknown };
  return sqlite.code === 'SQLITE_BUSY'
    || sqlite.errno === 5
    || /database is locked|database is busy|SQLITE_BUSY/i.test(error.message);
}

function hardenLedgerFiles(ledgerPath: string): void {
  for (const path of [ledgerPath, `${ledgerPath}-wal`, `${ledgerPath}-shm`]) {
    try {
      if (existsSync(path)) chmodSync(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function safeRecoveryReason(value: string): string {
  const reason = value.trim();
  if (!SAFE_RECOVERY_REASON.test(reason)) {
    throw new TypeError('Google request budget recovery reason must be a safe categorical token.');
  }
  return reason;
}

function readLegacyRequestBudgetState(
  statePath: string,
  provider: string,
): { utcDay: string; requests: number } | undefined {
  // A `.sqlite` path has no legacy JSON counterpart.
  if (statePath.endsWith('.sqlite')) return undefined;
  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: {
    version?: unknown;
    utcDay?: unknown;
    requests?: unknown;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new TypeError(`${provider} daily API request budget state is invalid.`);
  }
  if (
    parsed.version !== GOOGLE_REQUEST_BUDGET_STATE_VERSION
    || typeof parsed.utcDay !== 'string'
    || !validUtcDay(parsed.utcDay)
    || !Number.isSafeInteger(parsed.requests)
    || (parsed.requests as number) < 0
  ) {
    throw new TypeError(`${provider} daily API request budget state is invalid.`);
  }
  return { utcDay: parsed.utcDay, requests: parsed.requests as number };
}

function retireLegacyRequestBudgetState(statePath: string): void {
  try {
    renameSync(statePath, `${statePath}.imported`);
  } catch (error) {
    // Another process racing the same migration already retired it.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function providerLabel(value: string): string {
  const provider = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(provider)) {
    throw new TypeError('Google request budget provider must be a safe categorical label.');
  }
  return provider;
}

function validDate(value: Date, provider: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`${provider} request budget timestamp must be valid.`);
  }
  return value;
}

function nextUtcDay(date: Date): string {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  )).toISOString();
}

function utcDayAfter(utcDay: string): string {
  const date = new Date(`${utcDay}T00:00:00.000Z`);
  return nextUtcDay(date);
}

function validUtcDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 10) === value;
}

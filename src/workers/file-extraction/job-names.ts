/**
 * Where the extraction job ledger lives, and the one thing done to it for an
 * item that becomes Secrets: the name captured at enqueue is cleared from
 * every job row the item has, settled ones included (docs/TRUST_MODEL.md, the
 * Secret tier: such an item keeps its location only).
 *
 * Kept apart from job-store.ts so the Secrets disposition can reach the
 * ledger without loading the queue. Only the name column and the item's
 * extraction artifacts (structural refs can carry source names, such as a
 * sheet's name) are touched: status, attempts, leases and retry state stay
 * exactly as they were, so a job in flight records normally and no other
 * item's job changes.
 *
 * The clearing is durable: the item is also written to the ledger's
 * `secret_item_redactions` table, and enqueue reads it in the same write
 * transaction, so a planning pass that listed the item before it became
 * Secrets cannot write the name back (a new job, or a refreshed one).
 *
 * An item that later leaves Secrets (the owner's restore, a re-decision) has
 * its markers retired again (`retireExtractionJobRedaction`, driven by the
 * tier ledger's record of the change).
 *
 * Every ledger file this process opens for writing is registered here, so a
 * runtime given its own path (not the default) is cleared too. Another
 * process (the `tier set` command) cannot see that registry: it leaves the
 * item owed in the tier ledger, with any ledger path it could not clear, and
 * the worker's next tier tick repeats the clearing with its own paths.
 *
 * Doc comments in this directory are always multi-line: the architecture
 * guard's regex-literal heuristic reads a one-line block comment as a regex.
 */

import { sharedDataPath } from '../../core/olympus-layout.ts';
import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import { filterFor, forgetSqliteRows, rowsKeyedBy } from '../../core/sqlite-forget.ts';

export const FILE_EXTRACTION_JOBS_DB_PATH_ENV = 'OLYMPUS_FILE_EXTRACTION_JOBS_DB_PATH';

const CLEAR_NAMES_BUSY_TIMEOUT_MS = 10_000;

export function defaultFileExtractionJobsDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env[FILE_EXTRACTION_JOBS_DB_PATH_ENV]?.trim();
  if (override) return override;
  return sharedDataPath('file-extraction-jobs', env);
}

/**
 * One item, as the job rows key it. With the local item id the match is
 * exact; without it every row for the provider item is matched.
 */
export interface ExtractionJobItemKey {
  provider: string;
  accountScope: string;
  providerItemId: string;
  localItemId?: string;
}

export const SECRET_ITEM_REDACTIONS_TABLE = 'secret_item_redactions';
export const SECRET_ITEM_REDACTION_CLAIMS_TABLE = 'secret_item_redaction_claims';
export const SECRET_RESTORED_REREADS_TABLE = 'secret_restored_rereads';

const openLedgerPaths = new Map<string, number>();

/**
 * Note a ledger file this process holds open for writing; the returned
 * function forgets it again. The Secrets disposition clears every one.
 */
export function registerExtractionJobsDbPath(dbPath: string): () => void {
  if (dbPath === ':memory:') return () => {};
  openLedgerPaths.set(dbPath, (openLedgerPaths.get(dbPath) ?? 0) + 1);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const count = (openLedgerPaths.get(dbPath) ?? 1) - 1;
    if (count > 0) openLedgerPaths.set(dbPath, count);
    else openLedgerPaths.delete(dbPath);
  };
}

/**
 * The default ledger path plus every ledger this process opened for writing.
 */
export function extractionJobsDbPaths(env: Record<string, string | undefined> = process.env): string[] {
  return [...new Set([defaultFileExtractionJobsDbPath(env), ...openLedgerPaths.keys()])];
}

/**
 * Whether an item's job names are redacted, read on the caller's own
 * connection (enqueue reads it inside its write transaction). A ledger whose
 * schema predates the table has no redactions.
 */
export function itemNameRedacted(db: Database, item: ExtractionJobItemKey): boolean {
  if (!redactionsTableExists(db)) return false;
  return db.query(`
    SELECT 1 FROM ${SECRET_ITEM_REDACTIONS_TABLE}
    WHERE provider = ? AND account_scope = ? AND provider_item_id = ?
      AND (local_item_id = '' OR local_item_id = ?)
    LIMIT 1
  `).get(item.provider, item.accountScope, item.providerItemId, item.localItemId ?? '') !== null;
}

/**
 * Clear the captured name on every job row of one item, in the ledger file
 * at `dbPath`, and record the redaction so no later enqueue writes it back.
 * A file that does not exist (no extraction lane ever ran) is left
 * uncreated. `durable` is false when the ledger predates the redactions
 * table (its writer has not upgraded it yet): the names are cleared, but
 * nothing yet stops an enqueue from writing them back, so the caller keeps
 * the item owed until it is.
 */
export function clearExtractionJobNames(
  dbPath: string,
  item: ExtractionJobItemKey,
  options: {
    /**
     * The tier ledger that holds the item Secrets: recorded as a claim on
     * the redaction.
     */
    claimant?: string;
    /**
     * Asked inside this ledger's write lock; nothing is written when it says
     * no (a retried clearing whose item has left Secrets since it was read).
     */
    proceed?: () => boolean;
  } = {},
): { cleared: number; durable: boolean } {
  if (dbPath === ':memory:' || !existsSync(dbPath)) return { cleared: 0, durable: true };
  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    db.exec(`PRAGMA busy_timeout = ${CLEAR_NAMES_BUSY_TIMEOUT_MS};`);
    const table = db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'extraction_jobs'`).get();
    if (!table) return { cleared: 0, durable: true };
    return db.transaction(() => {
      if (options.proceed && !options.proceed()) return { cleared: 0, durable: true };
      const claims = claimsTableExists(db);
      const durable = redactionsTableExists(db) && (options.claimant === undefined || claims);
      const now = new Date().toISOString();
      if (redactionsTableExists(db)) {
        db.query(`
          INSERT OR IGNORE INTO ${SECRET_ITEM_REDACTIONS_TABLE} (provider, account_scope, provider_item_id, local_item_id, redacted_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(item.provider, item.accountScope, item.providerItemId, item.localItemId ?? '', now);
      }
      if (options.claimant !== undefined && claims) {
        db.query(`
          INSERT OR IGNORE INTO ${SECRET_ITEM_REDACTION_CLAIMS_TABLE} (provider, account_scope, provider_item_id, claimant, claimed_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(item.provider, item.accountScope, item.providerItemId, options.claimant, now);
      }
      const artifactItems = item.localItemId !== undefined
        ? 'provider = ? AND account_scope = ? AND provider_item_id = ? AND local_item_id = ?'
        : 'provider = ? AND account_scope = ? AND provider_item_id = ?';
      const itemParams = item.localItemId !== undefined
        ? [item.provider, item.accountScope, item.providerItemId, item.localItemId]
        : [item.provider, item.accountScope, item.providerItemId];
      if (artifactsTableExists(db)) {
        db.query(`
          DELETE FROM extraction_artifacts
          WHERE (corpus_id, local_item_id) IN (SELECT corpus_id, local_item_id FROM extraction_jobs WHERE ${artifactItems})
        `).run(...itemParams);
      }
      const cleared = item.localItemId !== undefined
        ? db.query(`
            UPDATE extraction_jobs SET name = NULL
            WHERE provider = ? AND account_scope = ? AND provider_item_id = ? AND local_item_id = ? AND name IS NOT NULL
          `).run(item.provider, item.accountScope, item.providerItemId, item.localItemId).changes
        : db.query(`
            UPDATE extraction_jobs SET name = NULL
            WHERE provider = ? AND account_scope = ? AND provider_item_id = ? AND name IS NOT NULL
          `).run(item.provider, item.accountScope, item.providerItemId).changes;
      return { cleared, durable };
    }).immediate();
  } finally {
    closeSqliteStore(db);
  }
}

/**
 * Retire an item's redaction markers in the ledger file at `dbPath`: the item
 * left Secrets in the tier ledger `claimant`, so its later jobs keep their
 * names and artifacts again. Only that ledger's claim goes while another
 * tier ledger still claims the item; otherwise every marker of the provider
 * item goes (any local id: the caller has checked no item with that provider
 * item id is Secrets in its ledger). `stillSecret` is
 * asked again inside this ledger's write lock, and nothing is removed when it
 * says yes: an item that becomes Secrets writes its marker only after its
 * decision is recorded, and that write waits for this lock, so a marker is
 * either never removed or written back. Names already cleared stay cleared
 * until the item's next enqueue; its indexed jobs are read again at their
 * next enqueue (`takeRestoredReread`), since their artifacts were deleted
 * with the names.
 */
export function retireExtractionJobRedaction(
  dbPath: string,
  item: Omit<ExtractionJobItemKey, 'localItemId'>,
  claimant: string,
  stillSecret: () => boolean,
): { retired: number; stillSecret: boolean } {
  if (dbPath === ':memory:' || !existsSync(dbPath)) return { retired: 0, stillSecret: false };
  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    db.exec(`PRAGMA busy_timeout = ${CLEAR_NAMES_BUSY_TIMEOUT_MS};`);
    if (!redactionsTableExists(db)) return { retired: 0, stillSecret: false };
    return db.transaction(() => {
      if (stillSecret()) return { retired: 0, stillSecret: true };
      if (claimsTableExists(db)) {
        db.query(`
          DELETE FROM ${SECRET_ITEM_REDACTION_CLAIMS_TABLE}
          WHERE provider = ? AND account_scope = ? AND provider_item_id = ? AND claimant = ?
        `).run(item.provider, item.accountScope, item.providerItemId, claimant);
        // Another tier ledger still holds the item Secrets: its redaction stays.
        const heldElsewhere = db.query(`
          SELECT 1 FROM ${SECRET_ITEM_REDACTION_CLAIMS_TABLE}
          WHERE provider = ? AND account_scope = ? AND provider_item_id = ? LIMIT 1
        `).get(item.provider, item.accountScope, item.providerItemId) !== null;
        if (heldElsewhere) return { retired: 0, stillSecret: false };
      }
      const retired = db.query(`
        DELETE FROM ${SECRET_ITEM_REDACTIONS_TABLE}
        WHERE provider = ? AND account_scope = ? AND provider_item_id = ?
      `).run(item.provider, item.accountScope, item.providerItemId).changes;
      // Indexed jobs lost their artifacts; jobs whose extraction found a
      // Secret were blocked by the sink. Both need a reread after restoration,
      // including workers still settling the refusal. Other policy blocks
      // stay settled. Wait for the next enqueue, once the restored store copy
      // exists, so the worker has a copy to land in.
      if (retired > 0 && rereadsTableExists(db)) {
        db.query(`
          INSERT OR IGNORE INTO ${SECRET_RESTORED_REREADS_TABLE} (job_id)
          SELECT job_id FROM extraction_jobs
          WHERE provider = ? AND account_scope = ? AND provider_item_id = ?
            AND (status IN ('indexed', 'leased')
              OR (status = 'blocked_policy' AND last_error_kind = 'store_item_secrets'))
        `).run(item.provider, item.accountScope, item.providerItemId);
      }
      return { retired, stillSecret: false };
    }).immediate();
  } finally {
    closeSqliteStore(db);
  }
}

/**
 * One source's forget step on the ledger file at `dbPath`: every job row of
 * its corpora, which carry the names of the files they read, with their
 * extraction artifacts (structural refs can carry source names) and the
 * re-reads they were owed. Counts jobs, artifacts, re-reads and the Secrets
 * markers below together.
 *
 * The Secrets markers are keyed by provider item id and hold no names, but the
 * claims are held by the source's tier ledger, whose id a reconnected source
 * never gets again: `retireExtractionJobRedaction` could never retire the old
 * claim, and the item would stay redacted for good. So the claims whose
 * `claimant` is one of `tierLedgerIds` (the ids the caller read from the
 * source's own ledger files) go, and with them each redaction left with no
 * claim at all, but only an item whose claims all came from those ledgers. A
 * redaction another tier ledger still claims, and that ledger's claim, stay; so
 * does a redaction with no claim on record (written before claims existed),
 * which cannot be attributed. With no ids nothing here is touched.
 */
export function forgetExtractionJobs(
  dbPath: string,
  scope: { corpusIds: readonly string[]; accountScopes?: readonly string[]; tierLedgerIds?: readonly string[] },
  options: { dryRun?: boolean } = {},
): number {
  if (dbPath === ':memory:' || !existsSync(dbPath)) return 0;
  // One account scope's jobs inside shared corpora (an archive family's stores hold every archive).
  if (scope.accountScopes !== undefined) return forgetExtractionJobsOfAccountScopes(dbPath, scope.corpusIds, scope.accountScopes, options);
  const dryRun = options.dryRun === true;
  const jobs = rowsKeyedBy([['corpus_id', scope.corpusIds]]);
  const claimants = [...new Set(scope.tierLedgerIds ?? [])];
  if (!jobs && claimants.length === 0) return 0;
  const db = new Database(dbPath, dryRun ? { readonly: true } : { readwrite: true, create: false });
  try {
    db.exec(`PRAGMA busy_timeout = ${CLEAR_NAMES_BUSY_TIMEOUT_MS};`);
    // The names are the point: overwrite what is deleted.
    if (!dryRun) db.exec('PRAGMA secure_delete = ON;');
    const marks = claimants.map(() => '?').join(', ');
    const sameItem = (alias: string): string =>
      `${alias}.provider = ${SECRET_ITEM_REDACTIONS_TABLE}.provider AND ${alias}.account_scope = ${SECRET_ITEM_REDACTIONS_TABLE}.account_scope`
      + ` AND ${alias}.provider_item_id = ${SECRET_ITEM_REDACTIONS_TABLE}.provider_item_id`;
    return forgetSqliteRows(db, [
      // Before the jobs it selects them by.
      ...(jobs ? [{ table: SECRET_RESTORED_REREADS_TABLE, where: `job_id IN (SELECT job_id FROM extraction_jobs WHERE ${jobs.where})`, params: jobs.params }] : []),
      ...filterFor('extraction_artifacts', [['corpus_id', scope.corpusIds]]),
      ...filterFor('extraction_jobs', [['corpus_id', scope.corpusIds]]),
      // The redactions go before their claims, which they are selected by.
      ...(claimants.length > 0 && claimsTableExists(db) ? [{
        table: SECRET_ITEM_REDACTIONS_TABLE,
        where: `EXISTS (SELECT 1 FROM ${SECRET_ITEM_REDACTION_CLAIMS_TABLE} AS mine WHERE ${sameItem('mine')} AND mine.claimant IN (${marks}))`
          + ` AND NOT EXISTS (SELECT 1 FROM ${SECRET_ITEM_REDACTION_CLAIMS_TABLE} AS other WHERE ${sameItem('other')} AND other.claimant NOT IN (${marks}))`,
        params: [...claimants, ...claimants],
      }, {
        table: SECRET_ITEM_REDACTION_CLAIMS_TABLE,
        where: `claimant IN (${marks})`,
        params: claimants,
      }] : []),
    ], dryRun).reduce((sum, count) => sum + count, 0);
  } finally {
    closeSqliteStore(db);
  }
}

/**
 * The forget step for the jobs of named account scopes inside shared corpora
 * (an archive family's stores hold every archive's items, one account scope
 * each): their job rows, extraction artifacts and owed re-reads, and the
 * Secrets markers and claims of those accounts' items. Another account scope's
 * rows in the same corpus are not touched. The account scopes are the removed
 * account's own keys, which no other account shares; an empty list deletes
 * nothing, never the whole corpus.
 */
function forgetExtractionJobsOfAccountScopes(
  dbPath: string,
  corpusIds: readonly string[],
  accountScopes: readonly string[],
  options: { dryRun?: boolean },
): number {
  const dryRun = options.dryRun === true;
  if (corpusIds.length === 0 || accountScopes.length === 0) return 0;
  const marks = (values: readonly string[]): string => values.map(() => '?').join(', ');
  const ofScopes = `corpus_id IN (${marks(corpusIds)}) AND account_scope IN (${marks(accountScopes)})`;
  const params = [...corpusIds, ...accountScopes];
  const db = new Database(dbPath, dryRun ? { readonly: true } : { readwrite: true, create: false });
  try {
    db.exec(`PRAGMA busy_timeout = ${CLEAR_NAMES_BUSY_TIMEOUT_MS};`);
    // The names are the point: overwrite what is deleted.
    if (!dryRun) db.exec('PRAGMA secure_delete = ON;');
    const jobIds = `job_id IN (SELECT job_id FROM extraction_jobs WHERE ${ofScopes})`;
    const byAccount = `account_scope IN (${marks(accountScopes)})`;
    return forgetSqliteRows(db, [
      // Before the jobs they are selected by.
      { table: SECRET_RESTORED_REREADS_TABLE, where: jobIds, params },
      { table: 'extraction_artifacts', where: jobIds, params },
      { table: SECRET_ITEM_REDACTION_CLAIMS_TABLE, where: byAccount, params: accountScopes },
      { table: SECRET_ITEM_REDACTIONS_TABLE, where: byAccount, params: accountScopes },
      { table: 'extraction_jobs', where: ofScopes, params },
    ], dryRun).reduce((sum, count) => sum + count, 0);
  } finally {
    closeSqliteStore(db);
  }
}

function artifactsTableExists(db: Database): boolean {
  return db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'extraction_artifacts'`).get() !== null;
}

/**
 * Whether an existing job is owed a re-read because its item left Secrets
 * (see `retireExtractionJobRedaction`), read and consumed on the caller's
 * own connection inside its enqueue transaction.
 */
export function takeRestoredReread(db: Database, jobId: string): boolean {
  if (!rereadsTableExists(db)) return false;
  const job = db.query(`SELECT status, last_error_kind FROM extraction_jobs WHERE job_id = ?`).get(jobId) as
    { status: string; last_error_kind: string | null } | null;
  // A listing can overlap the old worker's settlement. Keep its debt and
  // lease intact until the outcome tells us whether a reread is needed.
  if (job?.status === 'leased') return false;
  const owed = db.query(`DELETE FROM ${SECRET_RESTORED_REREADS_TABLE} WHERE job_id = ?`).run(jobId).changes > 0;
  return owed && (job?.status === 'indexed'
    || (job?.status === 'blocked_policy' && job.last_error_kind === 'store_item_secrets'));
}

function rereadsTableExists(db: Database): boolean {
  return db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(SECRET_RESTORED_REREADS_TABLE) !== null;
}

function claimsTableExists(db: Database): boolean {
  return db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(SECRET_ITEM_REDACTION_CLAIMS_TABLE) !== null;
}

function redactionsTableExists(db: Database): boolean {
  return db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(SECRET_ITEM_REDACTIONS_TABLE) !== null;
}

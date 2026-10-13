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
 * Every ledger file this process opens for writing is registered here, so a
 * runtime given its own path (not the default) is cleared too. Another
 * process (the `tier set` command) cannot see that registry: it leaves the
 * item owed in the tier ledger, with any ledger path it could not clear, and
 * the worker's next tier tick repeats the clearing with its own paths.
 *
 * Doc comments in this directory are always multi-line: the architecture
 * guard's regex-literal heuristic reads a one-line block comment as a regex.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { closeSqliteStore } from '../../core/sqlite-store.ts';

export const FILE_EXTRACTION_JOBS_DB_PATH_ENV = 'OLYMPUS_FILE_EXTRACTION_JOBS_DB_PATH';

const CLEAR_NAMES_BUSY_TIMEOUT_MS = 10_000;

export function defaultFileExtractionJobsDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env[FILE_EXTRACTION_JOBS_DB_PATH_ENV]?.trim();
  if (override) return override;
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'file-extraction-jobs.sqlite');
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
export function clearExtractionJobNames(dbPath: string, item: ExtractionJobItemKey): { cleared: number; durable: boolean } {
  if (dbPath === ':memory:' || !existsSync(dbPath)) return { cleared: 0, durable: true };
  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    db.exec(`PRAGMA busy_timeout = ${CLEAR_NAMES_BUSY_TIMEOUT_MS};`);
    const table = db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'extraction_jobs'`).get();
    if (!table) return { cleared: 0, durable: true };
    return db.transaction(() => {
      const durable = redactionsTableExists(db);
      if (durable) {
        db.query(`
          INSERT OR IGNORE INTO ${SECRET_ITEM_REDACTIONS_TABLE} (provider, account_scope, provider_item_id, local_item_id, redacted_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(item.provider, item.accountScope, item.providerItemId, item.localItemId ?? '', new Date().toISOString());
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

function artifactsTableExists(db: Database): boolean {
  return db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'extraction_artifacts'`).get() !== null;
}

function redactionsTableExists(db: Database): boolean {
  return db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(SECRET_ITEM_REDACTIONS_TABLE) !== null;
}

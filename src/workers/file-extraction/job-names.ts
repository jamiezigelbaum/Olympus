/**
 * Where the extraction job ledger lives, and the one thing done to it for an
 * item that becomes Secrets: the name captured at enqueue is cleared from
 * every job row the item has, settled ones included (docs/TRUST_MODEL.md, the
 * Secret tier: such an item keeps its location only).
 *
 * Kept apart from job-store.ts so the Secrets disposition can reach the
 * ledger without loading the queue. Only the name column is touched: status,
 * attempts, leases and retry state stay exactly as they were, so a job in
 * flight records normally and no other item's job changes.
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

/**
 * Clear the captured name on every job row of one item, in the ledger file
 * at `dbPath`. A file that does not exist (no extraction lane ever ran) is
 * left uncreated. Returns the rows changed.
 */
export function clearExtractionJobNames(dbPath: string, item: ExtractionJobItemKey): number {
  if (dbPath === ':memory:' || !existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    db.exec(`PRAGMA busy_timeout = ${CLEAR_NAMES_BUSY_TIMEOUT_MS};`);
    const table = db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'extraction_jobs'`).get();
    if (!table) return 0;
    return item.localItemId !== undefined
      ? db.query(`
          UPDATE extraction_jobs SET name = NULL
          WHERE provider = ? AND account_scope = ? AND provider_item_id = ? AND local_item_id = ? AND name IS NOT NULL
        `).run(item.provider, item.accountScope, item.providerItemId, item.localItemId).changes
      : db.query(`
          UPDATE extraction_jobs SET name = NULL
          WHERE provider = ? AND account_scope = ? AND provider_item_id = ? AND name IS NOT NULL
        `).run(item.provider, item.accountScope, item.providerItemId).changes;
  } finally {
    closeSqliteStore(db);
  }
}

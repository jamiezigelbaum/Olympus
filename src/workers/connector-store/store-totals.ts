// A store's plain totals, kept by the store itself as it is written: live
// items, tombstoned items, chunks, real sync runs, and vectors per model.
// Triggers move them in the same transaction as the write, so a status read
// gets them with one small SELECT, however large the store (Olympus 1.5 status
// ledger, "2b": Sparta rc.18's paced recount took 7 minutes, so a counted
// total could be about 40 minutes old).
//
// The triggers live in the store file, so a build that does not know them
// still moves the totals. What can leave them wrong is a trigger missing (an
// older build's table rebuild drops them until the next open; nothing here
// writes with REPLACE, which fires no delete trigger). So the totals are
// walked in the background when missing, suspect, or when their inputs
// change. The walk reads each table a range of keys at a time, each page its
// own read on the read worker, and carries over what the triggers added since it began; a
// walk that saw no write at all is exact, and one that did is retried after a
// quiet hour.
//
// A new table and triggers, created on open with IF NOT EXISTS like the
// visibility feed: no schema version change, so an older build still opens
// the store.

import type { Database } from 'bun:sqlite';

export type StoreTotalsName = 'items' | 'tombstoned_items' | 'chunks' | 'sync_runs' | `vectors:${string}`;

export interface StoreTotals {
  items: number;
  tombstonedItems: number;
  chunks: number;
  syncRuns: number;
  /** Vectors held per embedding model (any content hash). */
  vectorsByModel: Record<string, number>;
  /** When the totals were last checked against an exact count (ISO). */
  reconciledAt: string;
  /** A walk is owed: now (a trigger was put back), or later (the last walk saw writes). */
  walkOwed?: 'now' | 'later';
}

// store_totals_state.drift: the drift the last exact walk put right, or one
// of these.
const WALK_OWED_LATER = -1;
const WALK_OWED_NOW = -2;

export const STORE_TOTALS_TRIGGERS = [
  'connector_store_totals_item_insert',
  'connector_store_totals_item_delete',
  'connector_store_totals_item_tombstone',
  'connector_store_totals_chunk_insert',
  'connector_store_totals_chunk_delete',
  'connector_store_totals_vector_insert',
  'connector_store_totals_vector_delete',
  'connector_store_totals_vector_model',
  'connector_store_totals_sync_insert',
  'connector_store_totals_sync_delete',
  ...(['items', 'chunks', 'chunk_embeddings', 'sync_runs'] as const).flatMap((table) =>
    (['insert', 'update', 'delete'] as const).map((op) => `connector_store_totals_writes_${table}_${op}` as const)),
] as const;

/**
 * Not a total: a sequence every write to items, chunks, vectors or run rows
 * moves, so "nothing was written since the last count" is one read
 * (status.ts). The store's own bookkeeping (visibility feeds, leases) does
 * not move it, as the connection's change count would.
 */
export const STORE_TOTALS_WRITES = 'writes';

const bump = (name: string, by: string): string => `
  INSERT INTO store_totals (name, n) VALUES (${name}, ${by})
    ON CONFLICT(name) DO UPDATE SET n = n + excluded.n;`;

/**
 * The totals table, its state row and its triggers. `realSyncRunWhere` is the
 * predicate on a sync_runs row (NEW or OLD) that makes it a real sync, the
 * one status counts.
 */
export function createStoreTotals(db: Database, nonSyncConnectorsSql: string): void {
  // A trigger missing from filled totals means writes went uncounted: owe a walk.
  const owed = !storeTotalsInstalled(db);
  const real = (row: 'NEW' | 'OLD') => `${row}.connector_id NOT IN ${nonSyncConnectorsSql}`;
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_totals (
      name TEXT PRIMARY KEY,
      n INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS store_totals_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      reconciled_at TEXT NOT NULL,
      drift INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS connector_store_totals_item_insert AFTER INSERT ON items BEGIN
      ${bump("CASE WHEN NEW.tombstoned = 0 THEN 'items' ELSE 'tombstoned_items' END", '1')}
    END;
    CREATE TRIGGER IF NOT EXISTS connector_store_totals_item_delete AFTER DELETE ON items BEGIN
      ${bump("CASE WHEN OLD.tombstoned = 0 THEN 'items' ELSE 'tombstoned_items' END", '-1')}
    END;
    CREATE TRIGGER IF NOT EXISTS connector_store_totals_item_tombstone AFTER UPDATE OF tombstoned ON items
      WHEN (OLD.tombstoned = 0) <> (NEW.tombstoned = 0) BEGIN
      ${bump("CASE WHEN OLD.tombstoned = 0 THEN 'items' ELSE 'tombstoned_items' END", '-1')}
      ${bump("CASE WHEN NEW.tombstoned = 0 THEN 'items' ELSE 'tombstoned_items' END", '1')}
    END;
    CREATE TRIGGER IF NOT EXISTS connector_store_totals_chunk_insert AFTER INSERT ON chunks BEGIN
      ${bump("'chunks'", '1')}
    END;
    CREATE TRIGGER IF NOT EXISTS connector_store_totals_chunk_delete AFTER DELETE ON chunks BEGIN
      ${bump("'chunks'", '-1')}
    END;
    CREATE TRIGGER IF NOT EXISTS connector_store_totals_vector_insert AFTER INSERT ON chunk_embeddings BEGIN
      ${bump("'vectors:' || NEW.model_id", '1')}
    END;
    CREATE TRIGGER IF NOT EXISTS connector_store_totals_vector_delete AFTER DELETE ON chunk_embeddings BEGIN
      ${bump("'vectors:' || OLD.model_id", '-1')}
    END;
    CREATE TRIGGER IF NOT EXISTS connector_store_totals_vector_model AFTER UPDATE OF model_id ON chunk_embeddings
      WHEN OLD.model_id <> NEW.model_id BEGIN
      ${bump("'vectors:' || OLD.model_id", '-1')}
      ${bump("'vectors:' || NEW.model_id", '1')}
    END;
    CREATE TRIGGER IF NOT EXISTS connector_store_totals_sync_insert AFTER INSERT ON sync_runs WHEN ${real('NEW')} BEGIN
      ${bump("'sync_runs'", '1')}
    END;
    CREATE TRIGGER IF NOT EXISTS connector_store_totals_sync_delete AFTER DELETE ON sync_runs WHEN ${real('OLD')} BEGIN
      ${bump("'sync_runs'", '-1')}
    END;
  `);
  for (const table of ['items', 'chunks', 'chunk_embeddings', 'sync_runs'] as const) {
    for (const op of ['insert', 'update', 'delete'] as const) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS connector_store_totals_writes_${table}_${op} AFTER ${op.toUpperCase()} ON ${table} BEGIN
        ${bump(`'${STORE_TOTALS_WRITES}'`, '1')}
      END;`);
    }
  }
  if (owed) db.query('UPDATE store_totals_state SET drift = ? WHERE id = 1').run(WALK_OWED_NOW);
}

/** True when the store has the table and every trigger (an older build's rebuild may have dropped one). */
export function storeTotalsInstalled(db: Database): boolean {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'store_totals_state'").get()) return false;
  const row = db.query(`SELECT COUNT(*) AS n FROM sqlite_master
    WHERE (type = 'table' AND name IN ('store_totals', 'store_totals_state'))
      OR (type = 'trigger' AND name IN (SELECT value FROM json_each(?)))`)
    .get(JSON.stringify(STORE_TOTALS_TRIGGERS)) as { n: number };
  return row.n === 2 + STORE_TOTALS_TRIGGERS.length;
}

/** The kept totals, or undefined until the first reconcile has filled them. One small read. */
export function readStoreTotals(db: Database): StoreTotals | undefined {
  const state = db.query('SELECT reconciled_at, drift FROM store_totals_state WHERE id = 1').get() as { reconciled_at: string; drift: number } | null;
  if (!state) return undefined;
  const rows = db.query('SELECT name, n FROM store_totals').all() as Array<{ name: string; n: number }>;
  const totals = storeTotalsFromRows(rows, state.reconciled_at);
  // A negative aggregate proves drift without scanning the underlying rows.
  if (state.drift === WALK_OWED_NOW || rows.some(({ name, n }) => name !== STORE_TOTALS_WRITES && n < 0)) totals.walkOwed = 'now';
  else if (state.drift === WALK_OWED_LATER) totals.walkOwed = 'later';
  return totals;
}

/** The kept totals from `SELECT name, n FROM store_totals` rows (read in another snapshot, such as a status count's). */
export function storeTotalsFromRows(rows: Array<{ name: string; n: number }>, reconciledAt: string): StoreTotals {
  const totals: StoreTotals = { items: 0, tombstonedItems: 0, chunks: 0, syncRuns: 0, vectorsByModel: {}, reconciledAt };
  for (const { name, n } of rows) {
    const value = Number(n);
    if (name === 'items') totals.items = value;
    else if (name === 'tombstoned_items') totals.tombstonedItems = value;
    else if (name === 'chunks') totals.chunks = value;
    else if (name === 'sync_runs') totals.syncRuns = value;
    else if (name.startsWith('vectors:') && value !== 0) totals.vectorsByModel[name.slice('vectors:'.length)] = value;
  }
  return totals;
}

/** One read of the walk: SQL, parameters, and whether it returns a row or rows. */
export interface StoreTotalsRead { sql: string; params: Array<string | number>; mode: 'get' | 'all' }

/** Keys per page of the walk: each page is a seek on its table's key. */
export const STORE_TOTALS_WALK_KEYS = 20_000;

/**
 * The walk's reads, one page of keys at a time. The first read takes the
 * kept totals and each table's last key at one snapshot; the pages count up
 * to those keys, so a row added after it is the triggers' alone. The last
 * read takes the write sequence again: unchanged, nothing was written while
 * the walk ran, and the count is exact.
 */
export function* storeTotalsWalkSteps(nonSyncConnectorsSql: string, pageKeys = STORE_TOTALS_WALK_KEYS): Generator<StoreTotalsRead, { count: StoreTotalsCount; quiet: boolean }, unknown> {
  const start = (yield { sql: `SELECT
      (SELECT MAX(item_pk) FROM items) AS items,
      (SELECT MAX(chunk_pk) FROM chunks) AS chunks,
      (SELECT MAX(rowid) FROM sync_runs) AS runs,
      (SELECT n FROM store_totals WHERE name = '${STORE_TOTALS_WRITES}') AS writes,
      (SELECT json_group_object(name, n) FROM store_totals) AS kept_json`, params: [], mode: 'get' }) as {
    items: number | null; chunks: number | null; runs: number | null; writes: number | null; kept_json: string | null;
  };
  const count: StoreTotalsCount = { items: 0, tombstoned_items: 0, chunks: 0, sync_runs: 0, vectors_json: null, kept_json: start.kept_json };
  const vectors = new Map<string, number>();
  const pages = (last: number | null) => {
    const out: Array<[number, number]> = [];
    for (let lo = 0; lo < Number(last ?? 0); lo += pageKeys) out.push([lo, Math.min(lo + pageKeys, Number(last))]);
    return out;
  };
  for (const [lo, hi] of pages(start.items)) {
    const row = (yield { sql: `SELECT COALESCE(SUM(tombstoned = 0), 0) AS live, COALESCE(SUM(tombstoned <> 0), 0) AS gone
      FROM items WHERE item_pk > ? AND item_pk <= ?`, params: [lo, hi], mode: 'get' }) as { live: number; gone: number };
    count.items += Number(row.live);
    count.tombstoned_items += Number(row.gone);
  }
  for (const [lo, hi] of pages(start.chunks)) {
    count.chunks += Number(((yield { sql: 'SELECT COUNT(*) AS n FROM chunks WHERE chunk_pk > ? AND chunk_pk <= ?', params: [lo, hi], mode: 'get' }) as { n: number }).n);
    for (const row of (yield { sql: `SELECT model_id, COUNT(*) AS n FROM chunk_embeddings WHERE chunk_pk > ? AND chunk_pk <= ? GROUP BY model_id`,
      params: [lo, hi], mode: 'all' }) as Array<{ model_id: string; n: number }>) {
      vectors.set(row.model_id, (vectors.get(row.model_id) ?? 0) + Number(row.n));
    }
  }
  for (const [lo, hi] of pages(start.runs)) {
    count.sync_runs += Number(((yield { sql: `SELECT COUNT(*) AS n FROM sync_runs WHERE rowid > ? AND rowid <= ? AND connector_id NOT IN ${nonSyncConnectorsSql}`,
      params: [lo, hi], mode: 'get' }) as { n: number }).n);
  }
  count.vectors_json = JSON.stringify(Object.fromEntries(vectors));
  const end = (yield { sql: `SELECT n AS writes FROM store_totals WHERE name = '${STORE_TOTALS_WRITES}'`, params: [], mode: 'get' }) as { writes: number } | null;
  return { count, quiet: Number(end?.writes ?? 0) === Number(start.writes ?? 0) };
}

/**
 * The exact count and the kept totals in ONE statement, at one snapshot:
 * whole-table passes, for tests that need a recount to compare with.
 */
export function storeTotalsCountSql(nonSyncConnectorsSql: string): string {
  return `SELECT
    (SELECT COUNT(*) FROM items WHERE tombstoned = 0) AS items,
    (SELECT COUNT(*) FROM items WHERE tombstoned <> 0) AS tombstoned_items,
    (SELECT COUNT(*) FROM chunks) AS chunks,
    (SELECT COUNT(*) FROM sync_runs WHERE connector_id NOT IN ${nonSyncConnectorsSql}) AS sync_runs,
    (SELECT json_group_object(model_id, n) FROM (SELECT model_id, COUNT(*) AS n FROM chunk_embeddings GROUP BY model_id)) AS vectors_json,
    (SELECT json_group_object(name, n) FROM store_totals) AS kept_json`;
}

export interface StoreTotalsCount {
  items: number;
  tombstoned_items: number;
  chunks: number;
  sync_runs: number;
  vectors_json: string | null;
  kept_json: string | null;
}

/**
 * Set each total to the exact count plus what the triggers added since that
 * count's snapshot (kept now minus kept then). Exact whenever the triggers
 * ran over that interval; one short write on the writer. Returns the drift
 * it put right (the sum of each total's difference).
 */
export function applyStoreTotalsCount(db: Database, count: StoreTotalsCount, nowIso: string, options: { exact?: boolean } = {}): number {
  const counted = new Map<string, number>([
    ['items', Number(count.items)],
    ['tombstoned_items', Number(count.tombstoned_items)],
    ['chunks', Number(count.chunks)],
    ['sync_runs', Number(count.sync_runs)],
  ]);
  for (const [model, n] of Object.entries(JSON.parse(count.vectors_json ?? '{}') as Record<string, number>)) counted.set(`vectors:${model}`, Number(n));
  const keptThen = new Map(Object.entries(JSON.parse(count.kept_json ?? '{}') as Record<string, number>).map(([k, v]) => [k, Number(v)]));
  let drift = 0;
  db.transaction(() => {
    const keptNow = new Map((db.query('SELECT name, n FROM store_totals').all() as Array<{ name: string; n: number }>)
      .map((row) => [row.name, Number(row.n)]));
    const names = new Set([...counted.keys(), ...keptThen.keys(), ...keptNow.keys()]);
    const write = db.query('INSERT INTO store_totals (name, n) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET n = excluded.n');
    const remove = db.query('DELETE FROM store_totals WHERE name = ?');
    names.delete(STORE_TOTALS_WRITES);
    for (const name of names) {
      const since = (keptNow.get(name) ?? 0) - (keptThen.get(name) ?? 0);
      const exact = (counted.get(name) ?? 0) + since;
      drift += Math.abs((keptNow.get(name) ?? 0) - exact);
      if (exact === 0 && name.startsWith('vectors:')) remove.run(name);
      else write.run(name, exact);
    }
    db.query(`INSERT INTO store_totals_state (id, reconciled_at, drift) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET reconciled_at = excluded.reconciled_at, drift = excluded.drift`).run(nowIso, options.exact === false ? WALK_OWED_LATER : drift);
  })();
  return drift;
}

/** How long the store's write sequence must hold still before retrying an interrupted walk. */
export const STORE_TOTALS_QUIET_MS = 60 * 60_000;

/** Keep the trigger-maintained counts when a walk of already-filled totals saw writes. */
export function deferStoreTotalsWalk(db: Database): void {
  db.query('UPDATE store_totals_state SET drift = ? WHERE id = 1').run(WALK_OWED_LATER);
}

/** The write sequence (STORE_TOTALS_WRITES), or undefined where the store has none. One small read. */
export function readStoreWriteSequence(db: Database): number | undefined {
  const row = db.query('SELECT n FROM store_totals WHERE name = ?').get(STORE_TOTALS_WRITES) as { n: number } | null;
  return row ? Number(row.n) : undefined;
}

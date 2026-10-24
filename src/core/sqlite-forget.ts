/**
 * The row work of a forget step on a shared SQLite file
 * (core/source-forget-registry.ts): count what one source's rows are, and
 * delete them in one write transaction.
 *
 * It takes a connection the owning module opened (so the store-open guard
 * still sees every open in the module that owns the file) and holds no schema
 * of its own: each owner names its tables and keys.
 */
import type { Database, SQLQueryBindings } from 'bun:sqlite';

export interface ForgetRowFilter {
  table: string;
  where: string;
  params: readonly SQLQueryBindings[];
}

/**
 * `column IN (...)` for each non-empty list, joined by OR: a row belongs to the
 * source when ANY of its keys is the source's. Undefined when every list is
 * empty, so a source with nothing to match deletes nothing.
 */
export function rowsKeyedBy(
  keys: ReadonlyArray<readonly [column: string, values: readonly string[]]>,
): { where: string; params: string[] } | undefined {
  const present = keys.filter(([, values]) => values.length > 0);
  if (present.length === 0) return undefined;
  return {
    where: present.map(([column, values]) => `${column} IN (${values.map(() => '?').join(', ')})`).join(' OR '),
    params: present.flatMap(([, values]) => [...values]),
  };
}

/** One source's rows in one table, or no filter when the source has no key to match. */
export function filterFor(
  table: string,
  keys: ReadonlyArray<readonly [column: string, values: readonly string[]]>,
): ForgetRowFilter[] {
  const match = rowsKeyedBy(keys);
  return match ? [{ table, ...match }] : [];
}

/**
 * How many rows each filter matches, in order; they are also deleted, all in
 * one write transaction, unless `dryRun`. A table the file does not have
 * (a store older than the table, or never written) matches nothing.
 */
export function forgetSqliteRows(db: Database, filters: readonly ForgetRowFilter[], dryRun: boolean): number[] {
  const tables = new Set(
    (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const run = (): number[] => filters.map((filter) => {
    if (!tables.has(filter.table)) return 0;
    const row = db.query(`SELECT COUNT(*) AS n FROM ${filter.table} WHERE ${filter.where}`)
      .get(...filter.params) as { n: number };
    if (!dryRun && row.n > 0) db.query(`DELETE FROM ${filter.table} WHERE ${filter.where}`).run(...filter.params);
    return row.n;
  });
  return dryRun ? run() : db.transaction(run).immediate();
}

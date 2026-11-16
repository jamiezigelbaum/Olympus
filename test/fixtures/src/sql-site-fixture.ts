import type { Database } from 'bun:sqlite';

/** Lives under a `/src/` path so the statement-site recorder counts it as product code. */
export function readTwice(db: Database): void {
  db.query('SELECT count(*) AS n FROM t').get();
  db.query('SELECT count(*) AS n FROM t').get();
}

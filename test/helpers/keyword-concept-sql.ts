import type { SQLQueryBindings } from 'bun:sqlite';
import type { LocalConnectorStore } from '../../src/workers/connector-store/index.ts';

export type ConceptRead = { mode: 'all' | 'get'; sql: string; params: unknown[] };
export type ConceptSqlVersion = 'main' | '8171c7e2' | 'working';

// Replay the two concept-hit statements from #1284, or main's original
// statements, inside the real search generator. No other read is changed.
export function conceptReadVersion(read: ConceptRead, version: ConceptSqlVersion): ConceptRead {
  if (version === 'working' || !read.sql.includes('SELECT DISTINCT')
    || !read.sql.includes('i.local_item_id, i.source_version')) return read;
  const candidate = read.sql.includes('FROM connector_store_fts_rows candidate_rows');
  if ((version === 'main' && !candidate) || (version === '8171c7e2' && candidate)) return read;
  const match = /(?:candidate_rows|connector_store_fts)\.item_pk IN \(([^)]+)\)/.exec(read.sql);
  if (!match) return read;
  const placeholders = match[1]!;
  const count = placeholders.split(',').length;
  const pks = candidate ? read.params.slice(0, count) : read.params.slice(1, count + 1);
  const query = read.params[candidate ? count : 0];
  const scope = read.sql.slice(read.sql.indexOf('AND ('));
  if (!scope.startsWith('AND (')) throw new Error('Concept scope not found');
  const scopeParams = read.params.slice(count + 1);
  return version === 'main' ? {
    mode: read.mode,
    sql: `SELECT DISTINCT connector_store_fts.item_pk, i.local_item_id, i.source_version
      FROM connector_store_fts JOIN items i ON i.item_pk = connector_store_fts.item_pk
      WHERE connector_store_fts MATCH ? AND connector_store_fts.item_pk IN (${placeholders}) ${scope}`,
    params: [query, ...pks, ...scopeParams],
  } : {
    mode: read.mode,
    sql: `SELECT DISTINCT candidate_rows.item_pk, i.local_item_id, i.source_version
      FROM connector_store_fts_rows candidate_rows
      CROSS JOIN connector_store_fts ON connector_store_fts.rowid = candidate_rows.fts_rowid
      JOIN items i ON i.item_pk = candidate_rows.item_pk
      WHERE candidate_rows.item_pk IN (${placeholders})
        AND connector_store_fts.item_pk = candidate_rows.item_pk
        AND connector_store_fts MATCH ? ${scope}`,
    params: [...pks, query, ...scopeParams],
  };
}

export function useConceptSqlVersion(store: LocalConnectorStore, version: ConceptSqlVersion): () => void {
  const internal = store as unknown as {
    db: import('bun:sqlite').Database;
    readHere: (steps: Generator<ConceptRead, unknown, unknown>) => unknown;
  };
  const original = internal.readHere;
  internal.readHere = (steps) => {
    let step = steps.next();
    while (!step.done) {
      const read = conceptReadVersion(step.value, version);
      const statement = internal.db.query(read.sql);
      const params = read.params as SQLQueryBindings[];
      step = steps.next(read.mode === 'all' ? statement.all(...params) : statement.get(...params));
    }
    return step.value;
  };
  return () => { internal.readHere = original; };
}

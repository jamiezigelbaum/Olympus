import type { Database } from 'bun:sqlite';

export const SOURCE_INDEX_FTS5_TOKENIZER = "tokenize = 'porter unicode61'";
export const DEFAULT_INLINE_FTS_REBUILD_LIMIT = 25_000;

export interface SourceIndexFtsMigrationSpec {
  tableName: string;
  createTableSql: string;
  indexedRowCountSql: string;
  rebuildSql: string;
  inlineRebuildLimit?: number;
}

export interface SourceIndexFtsMigrationResult {
  status: 'rebuilt' | 'deferred';
  indexedRows: number;
  inlineRebuildLimit: number;
}

const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;
const FTS_QUERY_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'the',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'who',
  'with',
]);

const SOURCE_INDEX_SYNONYMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  amount: ['balance', 'credit', 'deposit'],
  balance: ['credit', 'deposit', 'amount', 'account'],
  credit: ['balance', 'deposit', 'amount', 'account'],
  credited: ['credit', 'balance', 'deposit'],
  credits: ['credit', 'balance', 'deposit'],
  deposit: ['credit', 'balance', 'amount', 'account'],
  deposited: ['deposit', 'credit', 'balance'],
  deposits: ['deposit', 'credit', 'balance'],
  engagement: ['agreement', 'contract', 'retainer', 'representation'],
  invoice: ['bill', 'statement', 'fee', 'fees', 'payment'],
  legal: ['lawyer', 'attorney', 'counsel', 'solicitor'],
  retainer: ['engagement', 'agreement', 'deposit'],
});

export interface SourceIndexFtsQueryOptions {
  /**
   * Prefix expansion is useful for type-ahead search, but a broad natural-
   * language question can make SQLite walk every completion of every term.
   * Callers running bounded answer retrieval may disable it; the Porter
   * tokenizer still supplies ordinary inflectional matching.
   */
  prefix?: boolean;
}

export interface SourceIndexFtsTermGroupOptions {
  excludedRawTerms?: ReadonlySet<string>;
  minimumRawLength?: number;
  groupLimit?: number;
  expandedTermLimit?: number | 'unbounded';
}

export function sourceIndexFtsQuery(
  query: string,
  options: SourceIndexFtsQueryOptions = {},
): string {
  const terms = sourceIndexFtsTerms(query);
  if (terms.length === 0) return '';
  const suffix = options.prefix === false ? '' : '*';
  return terms.map((term) => `"${escapeFtsPhrase(term)}"${suffix}`).join(' OR ');
}

export function sourceIndexFtsTerms(query: string): readonly string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of query.matchAll(TOKEN_PATTERN)) {
    const raw = match[0]?.trim().toLowerCase();
    if (!raw || FTS_QUERY_STOPWORDS.has(raw)) continue;
    appendTerm(raw, seen, terms);
    for (const synonym of SOURCE_INDEX_SYNONYMS[raw] ?? []) {
      appendTerm(synonym, seen, terms);
    }
    if (terms.length >= 24) break;
  }
  return terms;
}

// Term groups for minimum-signal filtering: each group is one query concept —
// the raw token plus its synonyms. A candidate matching two terms of the SAME
// group still expresses only one concept; distinct-group counting separates
// real matches from single-common-word noise.
export function sourceIndexFtsTermGroups(
  query: string,
  options: SourceIndexFtsTermGroupOptions = {},
): ReadonlyArray<readonly string[]> {
  const seen = new Set<string>();
  const groups: string[][] = [];
  let total = 0;
  const expandedTermLimit = options.expandedTermLimit ?? 24;
  const groupLimit = Math.max(1, Math.trunc(options.groupLimit ?? Number.MAX_SAFE_INTEGER));
  for (const match of query.matchAll(TOKEN_PATTERN)) {
    if (groups.length >= groupLimit) break;
    if (expandedTermLimit !== 'unbounded' && total >= expandedTermLimit) break;
    const raw = match[0]?.trim().toLowerCase();
    if (
      !raw
      || FTS_QUERY_STOPWORDS.has(raw)
      || raw.length < (options.minimumRawLength ?? 0)
      || options.excludedRawTerms?.has(raw)
    ) continue;
    const group: string[] = [];
    for (const term of [raw, ...(SOURCE_INDEX_SYNONYMS[raw] ?? [])]) {
      if (expandedTermLimit !== 'unbounded' && total >= expandedTermLimit) break;
      const normalized = term.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      group.push(normalized);
      total += 1;
    }
    if (group.length > 0) groups.push(group);
  }
  return groups;
}

export function sourceIndexFtsGroupQuery(group: readonly string[]): string {
  return group.map((term) => `"${escapeFtsPhrase(term)}"*`).join(' OR ');
}

export function runBoundedFtsTokenizerMigration(
  db: Database,
  spec: SourceIndexFtsMigrationSpec,
): SourceIndexFtsMigrationResult {
  const indexedRows = readCount(db, spec.indexedRowCountSql);
  const inlineRebuildLimit = spec.inlineRebuildLimit ?? DEFAULT_INLINE_FTS_REBUILD_LIMIT;
  ensureSourceIndexMaintenanceTable(db);
  if (indexedRows > inlineRebuildLimit && process.env.OLYMPUS_SOURCE_INDEX_FTS_REBUILD_INLINE !== '1') {
    upsertFtsMaintenanceTask(db, spec.tableName, indexedRows, inlineRebuildLimit, 'pending');
    return { status: 'deferred', indexedRows, inlineRebuildLimit };
  }
  rebuildFtsTokenizerIndex(db, spec);
  upsertFtsMaintenanceTask(db, spec.tableName, indexedRows, inlineRebuildLimit, 'completed');
  return { status: 'rebuilt', indexedRows, inlineRebuildLimit };
}

export function rebuildFtsTokenizerIndex(db: Database, spec: SourceIndexFtsMigrationSpec): void {
  db.exec(`DROP TABLE IF EXISTS ${spec.tableName};`);
  db.exec(spec.createTableSql);
  try {
    db.exec(spec.rebuildSql);
  } catch (error) {
    if (isMissingTableError(error)) return;
    throw error;
  }
}

function appendTerm(term: string, seen: Set<string>, terms: string[]): void {
  if (seen.has(term)) return;
  seen.add(term);
  terms.push(term);
}

function escapeFtsPhrase(value: string): string {
  return value.replace(/"/g, '""');
}

function readCount(db: Database, sql: string): number {
  let row: { count?: number; COUNT?: number; 'count(*)'?: number } | null;
  try {
    row = db.query(sql).get() as { count?: number; COUNT?: number; 'count(*)'?: number } | null;
  } catch (error) {
    if (isMissingTableError(error)) return 0;
    throw error;
  }
  const value = row?.count ?? row?.COUNT ?? row?.['count(*)'];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isMissingTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

function ensureSourceIndexMaintenanceTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_index_maintenance_tasks (
      task_id TEXT PRIMARY KEY,
      task_kind TEXT NOT NULL,
      target TEXT NOT NULL,
      status TEXT NOT NULL,
      details_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function upsertFtsMaintenanceTask(
  db: Database,
  tableName: string,
  indexedRows: number,
  inlineRebuildLimit: number,
  status: 'pending' | 'completed',
): void {
  db.query(`
    INSERT INTO source_index_maintenance_tasks (
      task_id,
      task_kind,
      target,
      status,
      details_json,
      updated_at
    )
    VALUES (?, 'fts_tokenizer_rebuild', ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      status = excluded.status,
      details_json = excluded.details_json,
      updated_at = excluded.updated_at
  `).run(
    `fts_tokenizer_rebuild:${tableName}`,
    tableName,
    status,
    JSON.stringify({
      tokenizer: SOURCE_INDEX_FTS5_TOKENIZER,
      indexed_rows: indexedRows,
      inline_rebuild_limit: inlineRebuildLimit,
      recovery: 'reingest through the canonical connector store',
    }),
    new Date().toISOString(),
  );
}

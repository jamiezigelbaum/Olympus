import { foreignQueryStopwords } from './keyword-stopwords.ts';
import { stemmer } from 'stemmer';
import type { Database } from 'bun:sqlite';
import { keywordAlternatives } from './keyword-context.ts';

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
// Words that carry no topic: function words, the scaffolding of a request
// ("what do I have about", "what did I save", "show me") and nouns that name
// an item's kind rather than its subject ("files", "papers"). Each is in
// nearly every readable document, so as a query term it matches everything
// with text and nothing in particular: "What do I have about integral
// theory?" matched every readable file on "do", "have" and "about" and ranked
// them above the files named for the topic. Words that are also common
// subjects (a "will", the month "May", "US") stay searchable.
const FTS_QUERY_STOPWORDS = new Set([
  'a', 'about', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'anything', 'are', 'article', 'articles',
  'as', 'at',
  'be', 'been', 'before', 'being', 'but', 'by',
  'can', 'could',
  'detail', 'details', 'did', 'do', 'doc', 'docs', 'document', 'documents', 'does', 'doing', 'done',
  'each',
  'file', 'files', 'find', 'for', 'found', 'from',
  'get', 'give', 'got',
  'had', 'happen', 'happened', 'has', 'have', 'having', 'he', 'her', 'here', 'him', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'item', 'items', 'its',
  'just',
  'keep', 'kept', 'know',
  'let', 'look',
  'many', 'me', 'might', 'more', 'most', 'much', 'must', 'my',
  'need', 'no', 'not', 'now',
  'of', 'on', 'or', 'our', 'out',
  'paper', 'papers',
  'please',
  'read', 'remember',
  'said', 'save', 'saved', 'say', 'says', 'see', 'she', 'should', 'show', 'so', 'some', 'something', 'stuff', 'such',
  'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'things', 'this',
  'those', 'to',
  'use', 'using',
  'very',
  'want', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'whose', 'why', 'with',
  'would', 'write', 'written', 'wrote',
  'you', 'your',
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
  const exact = queryInitialisms(query);
  return terms.map((term) => `"${escapeFtsPhrase(term)}"${exact.has(term) ? '' : suffix}`).join(' OR ');
}

export function sourceIndexFtsTerms(query: string): readonly string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const foreignStopwords = foreignQueryStopwords(query, FTS_QUERY_STOPWORDS);
  for (const match of query.matchAll(TOKEN_PATTERN)) {
    const raw = match[0]?.trim().toLowerCase();
    if (!raw || FTS_QUERY_STOPWORDS.has(raw) || (foreignStopwords.has(raw) && !/^[\p{Lu}]{2,}$/u.test(match[0]!))) continue;
    appendTerm(raw, seen, terms);
    for (const synonym of SOURCE_INDEX_SYNONYMS[raw] ?? []) {
      appendTerm(synonym, seen, terms);
    }
    if (terms.length >= 24) break;
  }
  for (const initialism of queryInitialisms(query).keys()) appendTerm(initialism, seen, terms);
  for (const group of sourceIndexFtsTermGroups(query)) {
    for (const term of group) appendTerm(term, seen, terms);
  }
  return terms;
}

// Words a name's initialism may span between its capitalised words
// ("Letter of Intent", "Carta de Intención").
const INITIALISM_CONNECTORS = new Set(['of', 'and', 'for', 'the', 'to', 'on', 'in', 'de', 'del', 'la', 'le', 'du', 'des', 'y']);
const MAX_INITIALISMS = 4;

/**
 * The initialisms of the capitalised names in a question, each with the
 * words it stands for: "Letter of Intent" is also "loi", "Non-Disclosure
 * Agreement" "nda". Files are often named by the initialism alone, and a
 * keyword search for the words never reaches them (2026-10-10 live: a letter
 * of intent filed as "LOI_…" was found only when the embedding happened to
 * rank it, so a reworded question missed it). Spans of two or three
 * capitalised words, connectors allowed between them; three to five letters.
 * They match whole tokens only (see sourceIndexFtsGroupQuery).
 */
export function queryInitialisms(query: string): ReadonlyMap<string, readonly string[]> {
  const words = [...query.matchAll(TOKEN_PATTERN)].map((match) => match[0]);
  const capitalised = (word: string) => /^\p{Lu}\p{Ll}/u.test(word) && !INITIALISM_CONNECTORS.has(word.toLowerCase());
  const found = new Map<string, string[]>();
  for (let start = 0; start < words.length && found.size < MAX_INITIALISMS; start += 1) {
    if (!capitalised(words[start]!)) continue;
    let names = 1;
    for (let end = start + 1; end < words.length && names < 3; end += 1) {
      const word = words[end]!;
      if (INITIALISM_CONNECTORS.has(word.toLowerCase())) continue;
      if (!capitalised(word)) break;
      names += 1;
      const span = words.slice(start, end + 1);
      const covered = span.filter(capitalised).map((entry) => entry.toLowerCase());
      for (const letters of [span.map((entry) => entry[0]!), span.filter(capitalised).map((entry) => entry[0]!)]) {
        const initialism = letters.join('').toLowerCase();
        if (initialism.length < 3 || initialism.length > 5 || found.has(initialism) || found.size >= MAX_INITIALISMS) continue;
        found.set(initialism, covered);
      }
    }
  }
  return found;
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
  const groupOf = new Map<string, string[]>();
  const foreignStopwords = foreignQueryStopwords(query, FTS_QUERY_STOPWORDS);
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
      || (foreignStopwords.has(raw) && !/^[\p{Lu}]{2,}$/u.test(match[0]!))
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
    if (group.length > 0) {
      groups.push(group);
      groupOf.set(raw, group);
    }
  }
  // An initialism stands for each word it spans: a file named by it matches
  // each of those concepts, as a file carrying the words would.
  for (const [initialism, covered] of queryInitialisms(query)) {
    for (const word of covered) {
      const group = groupOf.get(word);
      if (group && !group.includes(initialism)) group.push(initialism);
    }
  }
  // Translations are alternatives of an existing concept, never new signals.
  // Append after raw-group construction so they cannot consume its term budget.
  const lexicalKey = (term: string) => (term.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stemmer).join(' ');
  // A shorter prefix phrase inside a longer one can match the same occurrence.
  const overlaps = (left: string, right: string): boolean => {
    const shorter = left.split(' '), longer = right.split(' ');
    if (shorter.length > longer.length) return overlaps(right, left);
    return longer.some((_, start) => start + shorter.length <= longer.length
      && shorter.every((word, index) => index === shorter.length - 1
        ? longer[start + index]!.startsWith(word) : longer[start + index] === word));
  };
  const owned = new Map(groups.flatMap(group => group.map(term => [lexicalKey(term), group] as const)));
  for (const [source, alternatives] of keywordAlternatives(query) ?? []) {
    const group = groupOf.get(source);
    if (!group) continue;
    for (const term of alternatives) {
      const key = lexicalKey(term);
      if (!key || [...owned].some(([existing, owner]) => owner !== group && (overlaps(key, existing) || overlaps(existing, key)))) continue;
      owned.set(key, group);
      group.push(term);
    }
  }
  return groups;
}

// `exact` terms (the query's initialisms) match whole tokens only: "loi" is
// the file named "LOI_…", not every word that starts with it.
export function sourceIndexFtsGroupQuery(group: readonly string[], exact: ReadonlyMap<string, unknown> | ReadonlySet<string> = new Set()): string {
  return group.map((term) => `"${escapeFtsPhrase(term)}"${exact.has(term) ? '' : '*'}`).join(' OR ');
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

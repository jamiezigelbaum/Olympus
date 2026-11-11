// Read-only timing probe for the eval's Dropbox tier stores (#1242).
//
// Prints, per store, counts only (never item text, titles or paths):
//   - file size and SQLite page stats;
//   - embedding rows per model, and how many are current;
//   - EXPLAIN QUERY PLAN for the exact page query the vector lane runs;
//   - the time for the first page and for a full scan (capped);
//   - the time of one FTS match;
// and then, through the same code the eval runs:
//   - opening the stores and the tier ledger, each timed (openMs);
//   - each store's vector-lane gate (vectorLaneServable);
//   - one keyword-only evidence-pack build, with each store's search time
//     and outcome against the lane deadline, and every keyword search the
//     lanes ran on the read pool (count and ms, pool wait included);
//   - then the keyword search a lane runs, step by step on this thread:
//     each SQL statement by kind (calls, rows, ms) and the tier and
//     child-visibility filter's time, for the plain and the content query.
//     It is synchronous, so a cold run holds this thread for its whole time.
//
// Usage (same environment the eval reads):
//   OLYMPUS_EVAL_DROPBOX_STORE=<private.sqlite> \
//   OLYMPUS_EVAL_DROPBOX_PERSONAL_STORE=<personal.sqlite> \
//   [OLYMPUS_EVAL_DROPBOX_LEDGER=<ledger.sqlite>] \
//   [OLYMPUS_SOURCE_INDEX_ACCOUNT=<account>] [OLYMPUS_EVAL_DROPBOX_APPROVED_SCOPE_KEY=<key>] \
//   bun eval/store-probe.ts [--term <fts word>] [--question <text>] [--scan-cap-seconds 60]
//     [--expect <local or provider item id>]
//
// The FTS term and the question are inputs only; neither is printed.
// --expect locates one item through each keyword search: whether the tier
// filter saw and kept it, its rank, content and concept match, and the
// leader's (ids, ranks and counts only).

import { Database } from 'bun:sqlite';
import type { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { existsSync, statSync } from 'node:fs';
import { connectorStoreCurrentEmbeddingPageQuery } from '../src/workers/connector-store/local-index.ts';
import {
  buildEvalPack,
  createEvalDropboxLanes,
  evalDropboxStorePaths,
  evalRetrievalAudit,
  openEvalDropboxStores,
  resolveEvalDropboxScope,
} from './run-real.ts';

interface ProbeArgs {
  term: string;
  question: string;
  scanCapMs: number;
  /** One item's local or provider id to locate through the keyword search (ids and ranks only). */
  expect?: string;
}

export function parseStoreProbeArgs(argv: readonly string[]): ProbeArgs {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const cap = Number(value('--scan-cap-seconds') ?? 60);
  const expect = value('--expect')?.trim();
  return {
    term: value('--term') ?? 'invoice',
    question: value('--question') ?? 'What is the invoice total?',
    scanCapMs: (Number.isFinite(cap) && cap > 0 ? cap : 60) * 1000,
    ...(expect ? { expect } : {}),
  };
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function scalar(db: Database, sql: string, ...params: Array<string | number>): number {
  const row = db.query(sql).get(...params) as Record<string, unknown> | null;
  return Number(row ? Object.values(row)[0] : 0);
}

function tableExists(db: Database, name: string): boolean {
  return db.query(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(name) !== null;
}

/** Counts, plan and scan timings for one store, opened read-only. */
export function probeStoreFile(input: {
  label: string;
  dbPath: string;
  accountScope?: string;
  filters?: { provider?: string; locatorPathScope?: string };
  term: string;
  scanCapMs: number;
}): Record<string, unknown> {
  const db = new Database(input.dbPath, { readonly: true, create: false, strict: true });
  try {
    db.exec('PRAGMA query_only = ON;');
    const report: Record<string, unknown> = {
      store: input.label,
      fileBytes: statSync(input.dbPath).size,
      pageSize: scalar(db, 'PRAGMA page_size'),
      pageCount: scalar(db, 'PRAGMA page_count'),
      freelistCount: scalar(db, 'PRAGMA freelist_count'),
      items: scalar(db, 'SELECT COUNT(*) FROM items'),
      itemsTombstoned: scalar(db, 'SELECT COUNT(*) FROM items WHERE tombstoned <> 0'),
      chunks: scalar(db, 'SELECT COUNT(*) FROM chunks'),
      analyzed: tableExists(db, 'sqlite_stat1'),
    };

    const models = db.query(`
      SELECT emb.model_id AS model_id,
        COUNT(*) AS rows,
        SUM(CASE WHEN emb.content_hash = c.embedding_input_hash AND i.tombstoned = 0 THEN 1 ELSE 0 END) AS current_rows,
        SUM(length(emb.embedding)) AS blob_bytes
      FROM chunk_embeddings emb
      JOIN chunks c ON c.chunk_pk = emb.chunk_pk
      JOIN items i ON i.item_pk = emb.item_pk
      GROUP BY emb.model_id
      ORDER BY rows DESC
    `).all() as Array<{ model_id: string; rows: number; current_rows: number; blob_bytes: number }>;
    report.embeddingModels = models.map((model) => ({
      modelId: model.model_id,
      rows: model.rows,
      currentRows: model.current_rows,
      blobBytes: model.blob_bytes,
    }));

    const model = models[0]?.model_id;
    if (model) {
      const options = {
        modelId: model,
        ...(input.accountScope ? { accountScope: input.accountScope } : {}),
        ...(input.filters ? { filters: input.filters } : {}),
      };
      const first = connectorStoreCurrentEmbeddingPageQuery(options, 0);
      report.vectorPagePlan = (db.query(`EXPLAIN QUERY PLAN ${first.sql}`).all(...first.params) as Array<{ detail: string }>)
        .map((row) => row.detail);

      let startedAt = performance.now();
      const firstPage = db.query(first.sql).all(...first.params) as Array<{ chunk_pk: number }>;
      report.vectorFirstPageMs = elapsed(startedAt);
      report.vectorFirstPageRows = firstPage.length;

      // The whole scan, in one read snapshot like the lane, capped.
      startedAt = performance.now();
      let after = 0;
      let rows = 0;
      let pages = 0;
      let slowestPageMs = 0;
      let capped = false;
      db.exec('BEGIN DEFERRED TRANSACTION;');
      try {
        while (true) {
          if (performance.now() - startedAt > input.scanCapMs) {
            capped = true;
            break;
          }
          const pageStartedAt = performance.now();
          const page = connectorStoreCurrentEmbeddingPageQuery(options, after);
          const result = db.query(page.sql).all(...page.params) as Array<{ chunk_pk: number }>;
          slowestPageMs = Math.max(slowestPageMs, elapsed(pageStartedAt));
          pages += 1;
          rows += result.length;
          if (result.length === 0) break;
          after = result.at(-1)!.chunk_pk;
          if (result.length < 256) break;
        }
      } finally {
        db.exec('ROLLBACK;');
      }
      report.vectorFullScan = { ms: elapsed(startedAt), rows, pages, slowestPageMs, capped };
    }

    if (tableExists(db, 'connector_store_fts')) {
      const startedAt = performance.now();
      const matches = scalar(
        db,
        'SELECT COUNT(*) FROM (SELECT rowid FROM connector_store_fts WHERE connector_store_fts MATCH ? LIMIT 1000)',
        `"${input.term.replaceAll('"', '')}"`,
      );
      report.ftsMatch = { ms: elapsed(startedAt), rowsUpTo1000: matches };
      report.ftsRows = scalar(db, 'SELECT COUNT(*) FROM connector_store_fts_rows');
    }
    return report;
  } finally {
    db.close();
  }
}

/** What one SQL statement of the keyword search is, by its shape (code, never data). */
export function keywordStatementKind(sql: string): string {
  if (sql.includes('MIN(top.rank)')) return 'ranked_match_page_bounded';
  if (sql.includes('MIN(connector_store_fts.rank)')) return 'ranked_match_page';
  if (sql.includes('COUNT(DISTINCT item_pk)')) return 'concept_weight_count';
  if (sql.includes('connector_store_fts.item_pk IN (')) return 'concept_hits_for_candidates';
  if (/FROM items WHERE tombstoned = 0/.test(sql) && sql.includes('COUNT(*)')) return 'item_population_count';
  return `other:${sql.replace(/\s+/g, ' ').trim().slice(0, 60)}`;
}

type StepTotals = Record<string, { calls: number; rows: number; ms: number }>;

function addStep(totals: StepTotals, kind: string, rows: number, ms: number): void {
  const entry = totals[kind] ??= { calls: 0, rows: 0, ms: 0 };
  entry.calls += 1;
  entry.rows += rows;
  entry.ms += ms;
}

/**
 * The keyword lane's search on this thread, the plain query then the
 * content-only one, with every statement timed by kind and the visibility
 * filter timed on its own. Same SQL as the read pool runs; only the thread
 * differs. Restores the store's methods before returning.
 */
export function traceKeywordSearch(
  store: LocalConnectorStore,
  question: string,
  accountScope: string | undefined,
  filters: { provider?: string; locatorPathScope?: string } | undefined,
  expectId?: string,
): Record<string, unknown> {
  const internals = store as unknown as {
    db: { query: (sql: string) => { all: (...params: unknown[]) => unknown[]; get: (...params: unknown[]) => unknown } };
    tierVisibleRows: (...args: unknown[]) => unknown[];
  };
  const db = internals.db;
  const query = db.query;
  const visible = internals.tierVisibleRows;
  const runs: Array<Record<string, unknown>> = [];
  let steps: StepTotals = {};
  let filter = { calls: 0, rowsIn: 0, rowsOut: 0, ms: 0 };
  let expectedSeen = { inFilterInput: false, keptByFilter: false };
  db.query = function (sql: string) {
    const statement = query.call(db, sql);
    const kind = keywordStatementKind(sql);
    return {
      all: (...params: unknown[]) => {
        const startedAt = performance.now();
        const rows = statement.all(...params);
        addStep(steps, kind, rows.length, performance.now() - startedAt);
        return rows;
      },
      get: (...params: unknown[]) => {
        const startedAt = performance.now();
        const row = statement.get(...params);
        addStep(steps, kind, row ? 1 : 0, performance.now() - startedAt);
        return row;
      },
    };
  };
  internals.tierVisibleRows = function (...args: unknown[]) {
    const startedAt = performance.now();
    const out = visible.apply(store, args);
    if (expectId !== undefined) {
      const identityOf = args[1] as (row: unknown) => { providerItemId: string };
      const isExpected = (row: unknown) => identityOf(row).providerItemId === expectId
        || (row as { local_item_id?: unknown }).local_item_id === expectId;
      if ((args[0] as unknown[]).some(isExpected)) expectedSeen.inFilterInput = true;
      if (out.some(isExpected)) expectedSeen.keptByFilter = true;
    }
    filter.calls += 1;
    filter.rowsIn += (args[0] as unknown[]).length;
    filter.rowsOut += out.length;
    filter.ms += performance.now() - startedAt;
    return out;
  };
  try {
    for (const [label, options] of [['plain', { prefix: false }], ['content', { prefix: false, contentOnly: true }]] as const) {
      steps = {};
      filter = { calls: 0, rowsIn: 0, rowsOut: 0, ms: 0 };
      expectedSeen = { inFilterInput: false, keptByFilter: false };
      const startedAt = performance.now();
      const result = store.searchItemsDetailed(question, 50, accountScope, filters, options);
      const ms = elapsed(startedAt);
      const located = expectId === undefined ? {} : locateExpected(result, expectId, expectedSeen);
      runs.push({
        query: label,
        ms,
        rows: result.rows.length,
        saturated: result.saturated,
        statements: Object.fromEntries(Object.entries(steps).map(([kind, entry]) => [kind, { ...entry, ms: Math.round(entry.ms) }])),
        visibilityFilter: { ...filter, ms: Math.round(filter.ms) },
        ...located,
      });
    }
  } finally {
    db.query = query;
    internals.tierVisibleRows = visible;
  }
  return { corpusId: store.corpusId, runs };
}

type DetailedSearch = ReturnType<LocalConnectorStore['searchItemsDetailed']>;

/**
 * Where one expected item sits in a keyword search: whether the tier filter
 * saw and kept it, its rank, whether it has content, its concept match, and
 * the same for the search's leader. Ids, ranks and counts only.
 */
function locateExpected(
  result: DetailedSearch,
  expectId: string,
  seen: { inFilterInput: boolean; keptByFilter: boolean },
): { expected: Record<string, unknown>; leader: Record<string, unknown> | null } {
  const hasContent = (row: DetailedSearch['rows'][number]) => row.chunk !== undefined || row.contentMatched === true;
  const matches = (row: DetailedSearch['rows'][number]) =>
    row.sourceItem.localItemId === expectId || row.sourceItem.providerItemId === expectId;
  const rank = result.rows.findIndex(matches);
  const row = rank >= 0 ? result.rows[rank]! : undefined;
  const leader = result.rows[0];
  const concepts = (id: string) => result.concepts.matched.get(id) ?? 0;
  return {
    expected: {
      ...seen,
      rank,
      ...(row ? { hasContent: hasContent(row), conceptsMatched: concepts(row.sourceItem.localItemId) } : {}),
      conceptsTotal: result.concepts.total,
    },
    leader: leader ? {
      isExpected: rank === 0,
      hasContent: hasContent(leader),
      conceptsMatched: concepts(leader.sourceItem.localItemId),
    } : null,
  };
}

/** Counts and times every keyword search the lanes run on the read pool, until restored. */
function countPoolSearches(stores: readonly LocalConnectorStore[]): { report: () => unknown; restore: () => void } {
  type PoolSearch = { contentOnly: boolean; relaxed: boolean; ms: number; rows?: number; failed?: boolean };
  const calls: Record<string, PoolSearch[]> = {};
  const originals = stores.map((store) => [store, store.searchItemsDetailedOffThread] as const);
  for (const [store, original] of originals) {
    const list: PoolSearch[] = calls[store.corpusId] = [];
    store.searchItemsDetailedOffThread = async function (...args: Parameters<typeof original>) {
      const startedAt = performance.now();
      const options = args[4] ?? {};
      const entry: PoolSearch = { contentOnly: options.contentOnly === true, relaxed: options.relaxed === true, ms: 0 };
      list.push(entry);
      try {
        const result = await original.apply(store, args);
        entry.rows = result.rows.length;
        return result;
      } catch (error) {
        entry.failed = true;
        throw error;
      } finally {
        entry.ms = elapsed(startedAt);
      }
    };
  }
  return {
    report: () => Object.fromEntries(Object.entries(calls).map(([corpusId, list]) => [corpusId, {
      searches: list.length,
      totalMs: list.reduce((sum, entry) => sum + entry.ms, 0),
      each: list,
    }])),
    restore: () => {
      for (const [store, original] of originals) store.searchItemsDetailedOffThread = original;
    },
  };
}

async function main(): Promise<void> {
  const args = parseStoreProbeArgs(process.argv.slice(2));
  const paths = evalDropboxStorePaths(process.env);
  const scope = resolveEvalDropboxScope(
    process.env.OLYMPUS_SOURCE_INDEX_ACCOUNT?.trim() || undefined,
    process.env.OLYMPUS_EVAL_DROPBOX_APPROVED_SCOPE_KEY?.trim() || undefined,
  );
  const filters = scope.locatorPathScope ? { provider: 'dropbox', locatorPathScope: scope.locatorPathScope } : undefined;
  const files: Array<[string, string | undefined]> = [
    ['private', paths.secure],
    ['personal', paths.personal],
    ['public', paths.public],
  ];
  const out: Record<string, unknown> = { kind: 'olympus_store_probe', at: new Date().toISOString(), stores: [] };
  for (const [label, dbPath] of files) {
    if (!dbPath || !existsSync(dbPath)) continue;
    (out.stores as unknown[]).push(probeStoreFile({
      label,
      dbPath,
      ...(scope.accountScope ? { accountScope: scope.accountScope } : {}),
      ...(filters ? { filters } : {}),
      term: args.term,
      scanCapMs: args.scanCapMs,
    }));
  }

  // The eval's own path, keyword only: open, gate, one pack build.
  let startedAt = performance.now();
  const openMs: Record<string, number> = {};
  const opened = openEvalDropboxStores(paths, openMs);
  out.openStoresAndLedgerMs = elapsed(startedAt);
  out.openMs = openMs;
  out.ledgerBound = opened.ledger !== undefined;
  try {
    const gates: Array<Record<string, unknown>> = [];
    for (const store of opened.stores) {
      const model = ((out.stores as Array<Record<string, unknown>>)
        .find((entry) => entry.store === (store.trustDomain === 'secure_local' ? 'private' : store.trustDomain === 'internal' ? 'personal' : 'public'))
        ?.embeddingModels as Array<{ modelId: string }> | undefined)?.[0]?.modelId;
      if (!model) continue;
      startedAt = performance.now();
      const servable = store.vectorLaneServable(model);
      gates.push({ corpusId: store.corpusId, vectorLaneServable: servable, ms: elapsed(startedAt) });
    }
    out.vectorLaneGates = gates;

    const lanes = createEvalDropboxLanes({
      stores: opened.stores,
      ...(opened.ledger ? { ledger: opened.ledger } : {}),
      scope,
    });
    const pool = countPoolSearches(opened.stores);
    startedAt = performance.now();
    let detail: Awaited<ReturnType<typeof buildEvalPack>>;
    try {
      detail = await buildEvalPack({ question: args.question, lanes, maxResults: 5, maxCharsPerCandidate: 1_500 });
    } finally {
      pool.restore();
    }
    const audit = evalRetrievalAudit(detail, args.expect ? { expectedEvidence: [{ providerItemId: args.expect, corpusId: '', hint: '' }] } : undefined);
    out.keywordOnlyPack = {
      ms: elapsed(startedAt),
      packCandidates: audit.packCandidates,
      corpusTimings: audit.corpusTimings,
      lanes: audit.lanes,
      skippedCorpora: audit.skippedCorpora,
      poolKeywordSearches: pool.report(),
    };
    // After the pack build, so its timings are the eval's own: these searches
    // run synchronously on this thread, and a cold one on a large store holds
    // it for many seconds (the probe's own "could not answer" stall).
    out.keywordSearchSteps = opened.stores.map((store) => traceKeywordSearch(store, args.question, scope.accountScope, filters, args.expect));
  } finally {
    opened.close();
  }
  console.log(JSON.stringify(out, null, 2));
}

if (import.meta.main) {
  await main();
}

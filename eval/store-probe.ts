// Read-only timing probe for the eval's Dropbox tier stores (#1242).
//
// Prints, per store, counts only (never item text, titles or paths):
//   - file size and SQLite page stats;
//   - embedding rows per model, and how many are current;
//   - EXPLAIN QUERY PLAN for the exact page query the vector lane runs;
//   - the time for the first page and for a full scan (capped);
//   - the time of one FTS match;
// and then, through the same code the eval runs:
//   - opening the stores and the tier ledger;
//   - each store's vector-lane gate (vectorLaneServable);
//   - one keyword-only evidence-pack build, with each store's search time
//     and outcome against the lane deadline.
//
// Usage (same environment the eval reads):
//   OLYMPUS_EVAL_DROPBOX_STORE=<private.sqlite> \
//   OLYMPUS_EVAL_DROPBOX_PERSONAL_STORE=<personal.sqlite> \
//   [OLYMPUS_EVAL_DROPBOX_LEDGER=<ledger.sqlite>] \
//   [OLYMPUS_SOURCE_INDEX_ACCOUNT=<account>] [OLYMPUS_EVAL_DROPBOX_APPROVED_SCOPE_KEY=<key>] \
//   bun eval/store-probe.ts [--term <fts word>] [--question <text>] [--scan-cap-seconds 60]
//
// The FTS term and the question are inputs only; neither is printed.

import { Database } from 'bun:sqlite';
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
}

export function parseStoreProbeArgs(argv: readonly string[]): ProbeArgs {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const cap = Number(value('--scan-cap-seconds') ?? 60);
  return {
    term: value('--term') ?? 'invoice',
    question: value('--question') ?? 'What is the invoice total?',
    scanCapMs: (Number.isFinite(cap) && cap > 0 ? cap : 60) * 1000,
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
  const opened = openEvalDropboxStores(paths);
  out.openStoresAndLedgerMs = elapsed(startedAt);
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
    startedAt = performance.now();
    const detail = await buildEvalPack({ question: args.question, lanes, maxResults: 5, maxCharsPerCandidate: 1_500 });
    const audit = evalRetrievalAudit(detail);
    out.keywordOnlyPack = {
      ms: elapsed(startedAt),
      packCandidates: audit.packCandidates,
      corpusTimings: audit.corpusTimings,
      lanes: audit.lanes,
      skippedCorpora: audit.skippedCorpora,
    };
  } finally {
    opened.close();
  }
  console.log(JSON.stringify(out, null, 2));
}

if (import.meta.main) {
  await main();
}

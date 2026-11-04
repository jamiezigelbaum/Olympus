import { createRequire } from 'node:module';

/**
 * How many compiled statements Bun keeps per connection for `db.query()`.
 *
 * Bun caches the first 20 distinct SQL strings a connection sees and then
 * stops caching: every later `db.query(sql)` compiles the statement again.
 * A long-running worker passes 20 early, so per-item loops (tier ledger
 * reads, status counts) recompiled their query on every row. On Sparta
 * (2026-11-04) that made status builds hold the shared thread 9-15 s; a
 * held statement is about 40x faster than a recompile.
 *
 * The limit is read on each call, so raising it once, before or after
 * connections open, covers every connection in the process. Bun never
 * evicts, so this is also the ceiling on statements one connection holds.
 *
 * Imported only by the Bun-run entries (the CLI that runs the worker, the
 * embedding drain), never by a store module: a load-time side effect in a
 * store module would pull it into the Node-run plugin bundle
 * (test/plugin-bundle-no-bun-sqlite.test.ts).
 */
export const SQLITE_STATEMENT_CACHE_SIZE = 1000;

// Loaded at run time and only under Bun: the OpenClaw plugin bundle also
// reaches this module and runs under Node, which has no `bun:sqlite`.
if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
  const { Database } = createRequire(import.meta.url)('bun:sqlite') as { Database: { MAX_QUERY_CACHE_SIZE?: number } };
  if ((Database.MAX_QUERY_CACHE_SIZE ?? 0) < SQLITE_STATEMENT_CACHE_SIZE) {
    Database.MAX_QUERY_CACHE_SIZE = SQLITE_STATEMENT_CACHE_SIZE;
  }
}

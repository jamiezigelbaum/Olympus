/**
 * Streams a query's rows through a statement of its own, finalized when the
 * caller stops, however it stops.
 *
 * Never `db.query(sql).iterate()`: once a cached statement's iteration is left
 * early (a `break`, a `return`, an abandoned generator), Bun refuses the next
 * `.iterate()` on that statement with "bad parameter or other API misuse"
 * (Bun 1.3.14). With the larger cache (sqlite-statement-cache.ts), every
 * statement is cached.
 * `test/sqlite-statement-cache.test.ts` keeps `.iterate(` to this helper.
 */
export function* iterateRows<T>(
  db: { prepare(sql: string): { iterate(...params: never[]): IterableIterator<unknown>; finalize(): void } },
  sql: string,
  ...params: unknown[]
): Generator<T> {
  const statement = db.prepare(sql);
  try {
    yield* statement.iterate(...(params as never[])) as IterableIterator<T>;
  } finally {
    statement.finalize();
  }
}

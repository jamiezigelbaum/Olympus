// The keyword search read on the read pool (#1079) must return what the
// search on the store's own connection returns: the same rows in the same
// order, the same saturation and the same concept coverage, and the tier
// filter (run on this thread, with the current ledger) must still hide a copy
// the ledger does not serve. None of its FTS queries may run on this thread,
// and a pool query past its deadline must not hold up the next one.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { routeSourceIndexSearch } from '../src/core/source-index/router.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import type { ConnectorStoreKeywordFtsOptions, ConnectorStoreSearchFilters } from '../src/workers/connector-store/local-index.ts';
import { OffThreadReadBusyError, readOnPool, setReadPoolClockForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, openTierFixture, tempDir, type FixtureSpec, type TierFixture } from './helpers/tier-fixtures.ts';
import { createTestClock } from './helpers/test-clock.ts';

const WORDS = ['orchard', 'invoice', 'lawyer', 'budget', 'harbour', 'lisbon', 'piano', 'dentist', 'mortgage', 'passport', 'museum', 'recipe'];

// Enough items for the concept-weight and unique-literal branches (a
// population of at least 10), several of them title-only so the
// content-only lane differs from the plain one.
const SPECS: FixtureSpec[] = [
  ...Array.from({ length: 24 }, (_, n): FixtureSpec => ({
    id: `note-${n}`,
    name: `Note ${n} ${WORDS[n % WORDS.length]}`,
    text: `The ${WORDS[n % WORDS.length]} and the ${WORDS[(n * 5) % WORDS.length]} came up again, then the ${WORDS[(n * 7) % WORDS.length]}.`,
  })),
  ...Array.from({ length: 4 }, (_, n): FixtureSpec => ({ id: `title-${n}`, name: `Orchard invoice ${n}` })),
  { id: 'zebra', name: 'Zebra crossing', text: 'A unique zebra crossing near the orchard and the lawyer.' },
  { id: 'hidden', name: 'Orchard lawyer hidden', text: 'The orchard lawyer invoice that was routed to Private.' },
];

const QUERIES: Array<[string, ConnectorStoreKeywordFtsOptions]> = [
  ['orchard', {}],
  ['orchard lawyer invoice', {}],
  ['orchard lawyer invoice', { locate: false }],
  ['orchard lawyer invoice', { contentOnly: true }],
  ['orchard lawyer invoice', { prefix: false }],
  ['the zebra and the museum and the passport', {}],
  ['lisbon harbour piano dentist', {}],
  ['orchard lawyer', { relaxed: true }],
  ['orchard lawyer zebra budget', { relaxed: true, privatePrecision: true }],
  ['routed private', {}],
  ['nothing matches this', {}],
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  setReadPoolClockForTests();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function seeded(): Promise<TierFixture> {
  const { dir, cleanup } = tempDir('olympus-search-off-thread-');
  const fixture = openTierFixture(dir, { embed: false });
  cleanups.push(() => {
    fixture.close();
    cleanup();
  });
  await fixture.set.sync(fixtureConnector(() => SPECS), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  // Routing the item to Private stages it away from the internal store: its
  // copy there stays in the store's FTS, and only the tier filter hides it.
  const judged = classifyItemTiers({ signals: { title: 'Orchard lawyer hidden' }, text: 'The orchard lawyer invoice.' });
  const high = { ...judged, metadataTier: 'secure' as const, contentTier: 'secure' as const };
  fixture.ledger.recordRoutedPlacement(identityOf('hidden'), high, fixture.set.placementFor(high));
  return fixture;
}

/** Counts this thread's FTS queries on `store` until restored. */
function countMainThreadFts(store: object): { count(): number; restore(): void } {
  const db = (store as { db: { query: (sql: string) => unknown } }).db;
  const original = db.query;
  let seen = 0;
  db.query = (sql: string) => {
    if (sql.includes('connector_store_fts')) seen += 1;
    return original.call(db, sql);
  };
  return { count: () => seen, restore: () => { db.query = original; } };
}

describe('connector store keyword search on the read pool', () => {
  test('returns the same rows, saturation and concept coverage as the search on this thread, and still hides the copy the ledger does not serve', async () => {
    const fixture = await seeded();
    const internal = fixture.stores.internal!;

    // The unserved copy is still in the internal store's index.
    const raw = new Database(fixture.paths.internal, { readonly: true });
    try {
      expect(raw.query("SELECT item_pk FROM connector_store_fts WHERE connector_store_fts MATCH 'routed'").all().length).toBeGreaterThan(0);
    } finally {
      raw.close();
    }

    let found = 0;
    for (const [query, options] of QUERIES) {
      for (const filters of [undefined, { family: 'file' } as ConnectorStoreSearchFilters]) {
        const here = internal.searchItemsDetailed(query, 20, undefined, filters, options);
        const watch = countMainThreadFts(internal);
        const pooled = await internal.searchItemsDetailedOffThread(query, 20, undefined, filters, options);
        watch.restore();
        expect(watch.count()).toBe(0);
        expect(pooled.rows).toEqual(here.rows);
        expect(pooled.saturated).toBe(here.saturated);
        expect(pooled.concepts.total).toBe(here.concepts.total);
        expect([...pooled.concepts.matched]).toEqual([...here.concepts.matched]);
        expect(pooled.rows.map((row) => row.sourceItem.localItemId)).not.toContain(localId('hidden'));
        found += pooled.rows.length;
      }
    }
    expect(found).toBeGreaterThan(0);
    // Only the tier filter keeps it out: its own words find nothing on either path.
    expect(internal.searchItemsDetailed('routed', 20).rows).toEqual([]);
    expect((await internal.searchItemsDetailedOffThread('routed', 20)).rows).toEqual([]);
  });

  test('a small limit is filled and reported saturated the same way on both paths', async () => {
    const internal = (await seeded()).stores.internal!;
    for (const limit of [1, 3]) {
      const here = internal.searchItemsDetailed('orchard', limit);
      const pooled = await internal.searchItemsDetailedOffThread('orchard', limit);
      expect(pooled.rows).toEqual(here.rows);
      expect(pooled.saturated).toBe(here.saturated);
      expect(here.saturated).toBe(true);
    }
  });

  test('a query past its deadline is given up as busy, and the next query runs', async () => {
    const fixture = await seeded();
    const clock = createTestClock();
    setReadPoolClockForTests(clock);
    // Queries that would run for minutes, one on each pool thread: only their deadline ends them.
    const slow = { mode: 'get' as const, sql: 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000000000) SELECT COUNT(*) AS c FROM n', params: [] };
    const stuck = [1, 2].map(() => readOnPool(fixture.paths.internal, slow, { deadlineAtMs: clock.now() + 1_000 }).then(() => 'answered', (error) => error));
    // Queued behind them, with a later deadline.
    const next = readOnPool(fixture.paths.internal, { mode: 'get', sql: 'SELECT COUNT(*) AS c FROM items', params: [] }, { deadlineAtMs: clock.now() + 60_000 });
    await clock.advance(1_000);
    for (const outcome of await Promise.all(stuck)) expect(outcome).toBeInstanceOf(OffThreadReadBusyError);
    expect(((await next) as { c: number }).c).toBeGreaterThan(0);
  });

  test('a lane whose store is busy is reported as a lane timeout, not an error, with or without a lane deadline', async () => {
    const registry = buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId: 'public_safe.busy', family: 'file', trustDomain: 'public_safe' })]);
    for (const laneTimeoutMs of [60_000, 0]) {
      const result = await routeSourceIndexSearch({
        registry,
        laneTimeoutMs,
        adapters: { 'public_safe.busy': async () => { throw new OffThreadReadBusyError(); } },
        request: { query: 'q', maxResults: 5, context: { allowedTrustDomains: ['public_safe'], allowCloudQueries: true } },
      });
      expect(result.searchedCorpora).toEqual([]);
      expect(result.skippedCorpora).toEqual([{ corpusId: 'public_safe.busy', trustDomain: 'public_safe', reason: 'lane_timeout' }]);
    }
  });
});

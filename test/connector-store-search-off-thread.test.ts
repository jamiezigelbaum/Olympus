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
import { createConnectorStoreCorpusAdapter, defineConnectorCorpus, type ConnectorStoreKeywordFtsOptions, type ConnectorStoreSearchFilters } from '../src/workers/connector-store/local-index.ts';
import type { VisibilityRead } from '../src/workers/connector-store/child-visibility.ts';
import { OffThreadReadBusyError, setReadPoolClockForTests, setReadPoolObserverForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, openTierFixture, tempDir, type FixtureSpec, type TierFixture } from './helpers/tier-fixtures.ts';

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

  test('locating the chunks of many rows is one read on the pool, not one per row (#1305)', async () => {
    const internal = (await seeded()).stores.internal!;
    const reads: string[] = [];
    setReadPoolObserverForTests((_, read) => reads.push(read.sql));
    try {
      const pooled = await internal.searchItemsDetailedOffThread('orchard', 20);
      const located = pooled.rows.filter((row) => row.chunk);
      expect(located.length).toBeGreaterThan(1);
      expect(reads.filter((sql) => /FROM chunks/.test(sql) && !/connector_store_fts/.test(sql))).toHaveLength(1);
    } finally {
      setReadPoolObserverForTests();
    }
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

  // Each pool read is its own transaction, so ingestion can write between
  // the FTS read and the reads that depend on its rows. A chunk_pk or
  // item_pk the FTS read returned may by then belong to another item. A
  // dependent read that no longer matches the row's item drops the row, as
  // if it had not matched: another item's chunk, hash or offsets must never
  // be attached to it.
  test('a chunk reused by another item between the FTS read and the locate drops the row', async () => {
    const internal = (await seeded()).stores.internal!;
    const db = (internal as unknown as { db: Database }).db;
    const before = internal.searchItemsDetailed('zebra', 20);
    expect(before.rows.map((row) => row.sourceItem.localItemId)).toEqual([localId('zebra')]);
    const other = db.query('SELECT item_pk FROM items WHERE local_item_id = ?').get(localId('note-0')) as { item_pk: number };
    const otherHashes = (db.query('SELECT content_hash FROM chunks WHERE item_pk = ?').all(other.item_pk) as Array<{ content_hash: string }>).map((row) => row.content_hash);
    let reused = false;
    const result = driveByHand(internal, 'zebra', {}, (read) => {
      if (reused || !/FROM chunks/.test(read.sql) || /connector_store_fts/.test(read.sql)) return;
      reused = true;
      // The zebra chunk's pk now holds a chunk of another item (a delete and a reinsert that reused the pk).
      const chunkPk = (db.query('SELECT c.chunk_pk FROM chunks c JOIN items i ON i.item_pk = c.item_pk WHERE i.local_item_id = ?').get(localId('zebra')) as { chunk_pk: number }).chunk_pk;
      db.query('DELETE FROM chunks WHERE item_pk = ?').run(other.item_pk);
      db.query('UPDATE chunks SET item_pk = ?, content_hash = ? WHERE chunk_pk = ?').run(other.item_pk, otherHashes[0]!, chunkPk);
    });
    expect(reused).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.rows.flatMap((row) => (row.chunk ? [row.chunk.contentHash] : []))).not.toContain(otherHashes[0]);
  });

  test('an item pk that names another item by the follow-up concept reads drops the row', async () => {
    const internal = (await seeded()).stores.internal!;
    const db = (internal as unknown as { db: Database }).db;
    const query = 'zebra crossing museum';
    const options = { locate: false } as const;
    expect(internal.searchItemsDetailed(query, 20, undefined, undefined, options).rows.map((row) => row.sourceItem.localItemId)).toContain(localId('zebra'));
    let moved = false;
    const result = driveByHand(internal, query, options, (read) => {
      if (moved || !/item_pk IN/.test(read.sql)) return;
      moved = true;
      // The pk the FTS read returned for zebra is now another item's.
      db.query("UPDATE items SET local_item_id = 'personal:someone-else', provider_item_id = 'someone-else' WHERE local_item_id = ?").run(localId('zebra'));
    });
    expect(moved).toBe(true);
    expect(result.rows.map((row) => row.sourceItem.localItemId)).not.toContain(localId('zebra'));
  });

  test('an item updated to a new version before the follow-up concept reads drops the row', async () => {
    const internal = (await seeded()).stores.internal!;
    const db = (internal as unknown as { db: Database }).db;
    const query = 'zebra crossing museum';
    const options = { locate: false } as const;
    expect(internal.searchItemsDetailed(query, 20, undefined, undefined, options).rows.map((row) => row.sourceItem.localItemId)).toContain(localId('zebra'));
    let updated = false;
    const result = driveByHand(internal, query, options, (read) => {
      if (updated || !/item_pk IN/.test(read.sql)) return;
      updated = true;
      // Same item, same pk, a new version: what the follow-up reads match is no longer what the row was read as.
      db.query("UPDATE items SET source_version = 'v2' WHERE local_item_id = ?").run(localId('zebra'));
    });
    expect(updated).toBe(true);
    expect(result.rows.map((row) => row.sourceItem.localItemId)).not.toContain(localId('zebra'));
  });

  // The tier filter inside the search runs before later reads that now
  // yield (the chunk locate, the content and baseline searches). The ledger
  // can change in between, so the adapter checks every row again after its
  // last read, right before it emits hits and counts.
  test('an unrelated ledger write during the first visibility read still returns the matches (#1452)', async () => {
    const fixture = await seeded();
    const internal = fixture.stores.internal!;
    const ledgerDb = (fixture.ledger as unknown as { db: Database }).db;
    const here = internal.searchItemsDetailed('zebra crossing', 20);
    expect(here.rows.map((row) => row.sourceItem.localItemId)).toContain(localId('zebra'));
    // Another item's copy is touched while the search's own ledger read is on
    // the pool: the ledger's change marker moves, nothing the search reads does.
    let writes = 0;
    setReadPoolObserverForTests((_, read) => {
      if (writes > 0 || !/FROM tier_copies/.test(read.sql)) return;
      writes += 1;
      ledgerDb.query(`UPDATE tier_copies SET embed_hold = embed_hold WHERE provider_item_id = ?`).run(identityOf('note-3').providerItemId);
    }, { snapshots: true });
    try {
      const pooled = await internal.searchItemsDetailedOffThread('zebra crossing', 20);
      expect(writes).toBe(1);
      expect(pooled.rows).toEqual(here.rows);
    } finally {
      setReadPoolObserverForTests();
    }
  });

  test('an item routed away while a lane is still reading is not emitted, on the keyword and metadata paths', async () => {
    for (const path of ['search', 'metadataMatches'] as const) {
      const fixture = await seeded();
      const internal = fixture.stores.internal!;
      const adapter = createConnectorStoreCorpusAdapter({ store: internal });
      const request = {
        query: 'zebra crossing',
        maxResults: 10,
        corpus: defineConnectorCorpus({ corpusId: internal.corpusId, family: internal.family, trustDomain: internal.trustDomain }),
        context: { allowedTrustDomains: [internal.trustDomain] },
      } as const;
      const before = await adapter(request);
      expect(before.hits.map((hit) => hit.sourceItem.localItemId)).toContain(localId('zebra'));

      const original = internal.searchItemsDetailedOffThread.bind(internal);
      let routed = false;
      internal.searchItemsDetailedOffThread = async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        if (!routed) {
          routed = true;
          const judged = classifyItemTiers({ signals: { title: 'Zebra crossing' }, text: 'A unique zebra crossing.' });
          const high = { ...judged, metadataTier: 'secure' as const, contentTier: 'secure' as const };
          fixture.ledger.recordRoutedPlacement(identityOf('zebra'), high, fixture.set.placementFor(high));
        }
        return result;
      };
      const response = path === 'search' ? await adapter(request) : await adapter.metadataMatches!(request);
      expect(routed).toBe(true);
      expect(response.hits.map((hit) => hit.sourceItem.localItemId)).not.toContain(localId('zebra'));
      expect(response.matchCount?.matchedItems ?? 0).toBe(response.hits.length);
    }
  });
});

/** Drives SQL and visibility effects synchronously; `between` runs before each search SQL read. */
function driveByHand(
  store: object,
  query: string,
  options: ConnectorStoreKeywordFtsOptions,
  between: (read: { sql: string }) => void,
): ReturnType<NonNullable<TierFixture['stores']['internal']>['searchItemsDetailed']> {
  const inner = store as unknown as {
    db: Database;
    searchItemsSteps(...args: unknown[]): Generator<VisibilityRead | { sql: string; params: unknown[]; mode: 'get' | 'all' }, ReturnType<NonNullable<TierFixture['stores']['internal']>['searchItemsDetailed']>, unknown>;
  };
  const steps = inner.searchItemsSteps(query, 20, undefined, undefined, options);
  let step = steps.next();
  while (!step.done) {
    let rows: unknown;
    try {
      if ('here' in step.value) rows = step.value.here();
      else {
        between(step.value);
        const statement = inner.db.query(step.value.sql);
        rows = step.value.mode === 'all' ? statement.all(...(step.value.params as never[])) : statement.get(...(step.value.params as never[]));
      }
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next(rows);
  }
  return step.value;
}

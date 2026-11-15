// The calls the background's CPU profile named as its freezes (Sparta, rc.17,
// 15 Nov 2026) stay off one long synchronous stretch, counted on a store with
// many items: the judge's on-demand check per question is an indexed lookup,
// not a read of every item, and the embedding sweep's work list returns to
// the event loop between windows, with the same list as one query.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  ACCOUNT,
  PROVIDER,
  fixtureConnector,
  FIXTURE_PLACEMENT,
  openTierFixture,
  RecordingProvider,
  tempDir,
  type FixtureSpec,
} from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const ITEMS = 600;

async function bigStore() {
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir, { embed: false });
  cleanups.push(() => { fixture.close(); cleanup(); });
  const specs: FixtureSpec[] = Array.from({ length: ITEMS }, (_, index) => ({
    id: `row-${index}`, name: `row-${index}.txt`, text: `meadow row number ${index} with some ordinary words`,
  }));
  await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  return fixture;
}

describe('the background loop on the calls its profile named', () => {
  test("the judge's on-demand check reads by the item's key, not every item", async () => {
    const fixture = await bigStore();
    const store = fixture.stores.internal!;
    const db = (store as unknown as { db: { query(sql: string): { all(...args: unknown[]): unknown[] } } }).db;
    // SQLite's own plan: a search of the items' unique key, never a scan of the table.
    const plan = db.query(`EXPLAIN QUERY PLAN
      SELECT 1 FROM items i JOIN on_demand_item_reads r ON r.local_item_id = i.local_item_id
      WHERE i.provider = ? AND i.account_scope = ? AND i.normalized_conversation = ? AND i.provider_item_id = ?
        AND i.tombstoned = 0 LIMIT 1`).all(PROVIDER, ACCOUNT, '', 'row-1') as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join('\n')).not.toMatch(/SCAN i\b|SCAN items/);
    expect(store.hasOnDemandGrant({ provider: PROVIDER, accountScope: ACCOUNT, providerItemId: 'row-1' })).toBe(false);
  }, 60_000);

  test('the embedding work list turns between windows and lists what one query lists', async () => {
    const fixture = await bigStore();
    const store = fixture.stores.internal!;
    const provider = new RecordingProvider('google-gemini', 'gemini-embedding-2', 'cloud');
    const whole = store.missingEmbeddingItemIds(provider, 500);
    expect(whole.length).toBeGreaterThan(100);
    let turns = 0;
    let running = true;
    const count = () => { if (!running) return; turns += 1; setImmediate(count); };
    setImmediate(count);
    const windowed = await store.missingEmbeddingItemIdsInTurns(provider, 500, {}, 100);
    running = false;
    expect(windowed).toEqual(whole);
    // At least one turn per window it read (500 items, at least one chunk each, 100 chunk pks a window).
    expect(turns).toBeGreaterThanOrEqual(4);
  }, 60_000);
});

// The hidden-children set is built a window of parents per step (#1250).
//
// Building it grouped every child in one query before the first turn: on a
// 500,000-item store with 100,000 children that step held the request thread
// for 0.8 to 0.9 s, the longest freeze left once keyword search ran on the
// read pool. The set must stay the same; only how much one step reads changes.

import { afterEach, describe, expect, test } from 'bun:test';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir, type TierFixture } from './helpers/tier-fixtures.ts';

// HIDDEN_CHILD_PARENT_SLICE in local-index.ts.
const PARENTS_PER_STEP = 2_000;

let fixture: TierFixture | undefined;
let cleanup: (() => void) | undefined;
afterEach(() => {
  fixture?.close();
  cleanup?.();
  fixture = undefined;
  cleanup = undefined;
});

async function storeWithChildren(parents: number, orphans: number) {
  const temp = tempDir('olympus-hidden-child-steps-');
  cleanup = temp.cleanup;
  const f = openTierFixture(temp.dir, { embed: false });
  fixture = f;
  const text = 'a note about the orchard';
  const lower = classifyItemTiers({ signals: { title: 'Note' }, text });
  const high = { ...lower, metadataTier: 'secure' as const, contentTier: 'secure' as const };
  await f.set.sync(fixtureConnector(() => [{ id: 'template', name: 'Note', text }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await moveTieredItem({ set: f.set, identity: identityOf('template'), target: high });
  const store = f.stores.secure_local!;
  const copy = store.exportItemCopy(identityOf('template'))!;
  const put = (id: string, parent: string | null) => {
    const identity = identityOf(id);
    store.importItemCopy({
      ...copy,
      identity,
      columns: { ...copy.columns, provider_item_id: identity.providerItemId, local_item_id: identity.localItemId, title: id, parent_local_item_id: parent },
    }, { trustTier: 'S4', syncConnectorId: 'hidden-child-steps' });
    f.ledger.recordRoutedPlacement(identity, high, f.set.placementFor(high));
    return identity;
  };
  const db = (store as any).db;
  db.transaction(() => {
    for (let n = 0; n < parents; n++) {
      const parent = put(`parent-${n}`, null);
      put(`child-${n}`, parent.localItemId);
    }
    // Children whose parent no store holds: the parent is gone, so they are hidden.
    for (let n = 0; n < orphans; n++) put(`orphan-${n}`, identityOf(`missing-parent-${n}`).localItemId);
  })();
  const orphanPks = (db.query(`SELECT item_pk FROM items WHERE provider_item_id LIKE 'orphan-%' ORDER BY item_pk`).all() as Array<{ item_pk: number }>)
    .map((row) => row.item_pk);
  return { store, db, orphanPks };
}

describe('hidden-children set in turns', () => {
  test('no step reads more than one window of parents, and the set is unchanged', async () => {
    const parents = PARENTS_PER_STEP + 150;
    const { store, db, orphanPks } = await storeWithChildren(parents, 3);

    // Count the rows each query returns while the build runs, step by step.
    const realQuery = db.query.bind(db);
    let largestRead = 0;
    db.query = (sql: string) => {
      const statement = realQuery(sql);
      const all = statement.all.bind(statement);
      statement.all = (...params: unknown[]) => {
        const rows = all(...params);
        largestRead = Math.max(largestRead, rows.length);
        return rows;
      };
      return statement;
    };
    const steps = (store as any).hiddenChildSteps() as Generator<void, number[]>;
    let step = steps.next();
    let turns = 0;
    while (!step.done) {
      turns += 1;
      step = steps.next();
    }
    db.query = realQuery;

    expect(largestRead).toBeLessThanOrEqual(PARENTS_PER_STEP);
    // At least one turn per window of parents.
    expect(turns).toBeGreaterThanOrEqual(Math.ceil((parents + 3) / PARENTS_PER_STEP));
    expect([...step.value].sort((a, b) => a - b)).toEqual(orphanPks);
    // The synchronous build gives the same set.
    expect([...(store as any).hiddenChildItemPks()].sort((a: number, b: number) => a - b)).toEqual(orphanPks);
  });
});

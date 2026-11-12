import { afterEach, expect, spyOn, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { visibilityHere } from '../src/workers/connector-store/child-visibility.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const sorted = (pks: number[]) => [...pks].sort((a, b) => a - b);

async function setup() {
  const temp = tempDir('olympus-child-memo-');
  const f = openTierFixture(temp.dir, { embed: false });
  cleanups.push(() => { f.close(); temp.cleanup(); });
  await f.set.sync(fixtureConnector(() => [{ id: 'template', name: 'Note', text: 'An orchard note.' }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const store = f.stores.internal!;
  // Access private seams only in this regression suite: full is the unchanged
  // windowed implementation, and the SQL writes exercise real journal triggers.
  const target = store as any;
  const db = target.db as Database;
  const ledgerDb = (f.ledger as any).db as Database;
  const copy = store.exportItemCopy(identityOf('template'))!;
  const low = classifyItemTiers({ signals: { title: 'Note' }, text: 'An orchard note.' });
  const high = { ...low, metadataTier: 'secure' as const, contentTier: 'secure' as const };
  function put(id: string, parent?: string, leg = store) {
    const identity = identityOf(id);
    leg.importItemCopy({ ...copy, identity, columns: { ...copy.columns,
      provider_item_id: id, local_item_id: identity.localItemId, title: id,
      sender_id: parent ? `${id}@example.com` : null, sender_label: parent ? id : null,
      parent_local_item_id: parent ? identityOf(parent).localItemId : null,
    } }, { trustTier: leg === store ? 'S3' : 'S4', syncConnectorId: 'child-memo' });
    f.ledger.recordRoutedPlacement(identity, low, f.set.placementFor(low));
    return (db.query('SELECT item_pk FROM items WHERE provider_item_id = ?').get(id) as { item_pk: number } | null)?.item_pk;
  }
  const setCopyState = (id: string, state: string) => ledgerDb.query('UPDATE tier_copies SET copy_state = ? WHERE provider_item_id = ?').run(state, id);
  put('parent');
  const child = put('parent#child:one', 'parent')!;
  const full = () => sorted(visibilityHere(target.hiddenChildFullReadSteps()));
  const hidden = () => sorted(target.hiddenChildItemPks());
  const tierHidden = () => target.tierHiddenItemPks().hidden as number[];
  function assertHidden(pk = child, id = 'parent#child:one') {
    expect(tierHidden()).toContain(pk);
    expect(store.peopleObservations().some(row => row.senderId === `${id}@example.com`)).toBe(false);
    expect(hidden()).toEqual(full());
  }
  expect(hidden()).toEqual([]);
  expect(target.hiddenChildMemo).toBeDefined();
  return { f, store, target, db, ledgerDb, low, high, put, setCopyState, child, full, hidden, tierHidden, assertHidden };
}

test('a parent tier raise hides its child before the landing exists', async () => {
  const h = await setup();
  h.f.ledger.recordRoutedPlacement(identityOf('parent'), h.high, h.f.set.placementFor(h.high));
  h.assertHidden();
});

test('a move to another store is followed, including that store\'s next tombstone', async () => {
  const h = await setup();
  await moveTieredItem({ set: h.f.set, identity: identityOf('parent'), target: h.high });
  // The lane still serves the parent, so the child's own tier remains valid.
  expect(h.hidden()).toEqual(h.full());
  expect(h.hidden()).toEqual([]);
  (h.f.stores.secure_local as any).db.query('UPDATE items SET tombstoned = 1 WHERE provider_item_id = ?').run('parent');
  h.assertHidden();
});

test('a staged parent held for judgment hides its children immediately', async () => {
  const h = await setup();
  h.setCopyState('parent', 'staged');
  h.ledgerDb.query('UPDATE tier_copies SET embed_hold = 1 WHERE provider_item_id = ?').run('parent');
  h.assertHidden();
});

test('a revoked parent hides its children immediately', async () => {
  const h = await setup();
  h.f.ledger.removeCopies(identityOf('parent'));
  h.assertHidden();
});

for (const deletion of ['DELETE FROM items WHERE provider_item_id = ?', 'UPDATE items SET tombstoned = 1 WHERE provider_item_id = ?']) {
  test(`a parent deletion hides its children: ${deletion}`, async () => {
    const h = await setup();
    h.db.query(deletion).run('parent');
    h.assertHidden();
  });
}

test('a Secret parent without a retained location hides its children', async () => {
  const h = await setup();
  const secret = { ...h.low, metadataTier: 'secrets' as const, contentTier: 'secrets' as const };
  h.f.ledger.recordRoutedPlacement(identityOf('parent'), secret, h.f.set.placementFor(secret));
  h.db.query('DELETE FROM items WHERE provider_item_id = ?').run('parent');
  h.assertHidden();
});

test('an owner rule raise hides children before placement finishes', async () => {
  const h = await setup();
  h.f.ledger.setOverride(identityOf('parent'), { kind: 'tier', tier: 'secure' });
  // Apply the owner decision, as the shared placement writer does.
  const raised = { ...h.high, decidedBy: 'override' as const };
  h.f.ledger.recordRoutedPlacement(identityOf('parent'), raised, h.f.set.placementFor(raised));
  h.assertHidden();
});

test('a parent\'s own parent becoming hidden hides nested children', async () => {
  const h = await setup();
  h.put('grandparent');
  h.db.query('UPDATE items SET parent_local_item_id = ? WHERE provider_item_id = ?').run(identityOf('grandparent').localItemId, 'parent');
  expect(h.hidden()).toEqual([]);
  h.setCopyState('grandparent', 'superseded');
  h.assertHidden();
});

test('an ancestor in another store invalidates a nested child', async () => {
  const h = await setup();
  h.put('grandparent');
  await moveTieredItem({ set: h.f.set, identity: identityOf('grandparent'), target: h.high });
  h.db.query('UPDATE items SET parent_local_item_id = ? WHERE provider_item_id = ?').run(identityOf('grandparent').localItemId, 'parent');
  expect(h.hidden()).toEqual([]);
  (h.f.stores.secure_local as any).db.query('DELETE FROM items WHERE provider_item_id = ?').run('grandparent');
  h.assertHidden();
});

test('making a parent visible unhides its child', async () => {
  const h = await setup();
  h.setCopyState('parent', 'superseded');
  h.assertHidden();
  h.setCopyState('parent', 'current');
  expect(h.tierHidden()).not.toContain(h.child);
  expect(h.hidden()).toEqual(h.full());
  expect(h.store.peopleObservations().some(row => row.senderId === 'parent#child:one@example.com')).toBe(true);
});

test('a new child of an already hidden parent is hidden on its first read', async () => {
  const h = await setup();
  h.setCopyState('parent', 'superseded');
  h.assertHidden();
  const pk = h.put('parent#child:two', 'parent')!;
  h.assertHidden(pk, 'parent#child:two');
});

test('reparenting and child deletion remove old membership atomically', async () => {
  const h = await setup();
  h.put('other');
  h.setCopyState('parent', 'superseded');
  h.assertHidden();
  h.db.query('UPDATE items SET parent_local_item_id = ? WHERE item_pk = ?').run(identityOf('other').localItemId, h.child);
  expect(h.hidden()).toEqual(h.full());
  expect(h.hidden()).toEqual([]);
  h.setCopyState('other', 'superseded');
  h.assertHidden();
  h.db.query('DELETE FROM items WHERE item_pk = ?').run(h.child);
  expect(h.hidden()).toEqual([]);
});

for (const fallback of ['store gap', 'empty store feed', 'ledger gap', 'no feed', 'lane set', 'unbound ledger', 'replacement ledger'] as const) {
  test(`${fallback} discards the memo and performs a full walk`, async () => {
    const h = await setup();
    h.setCopyState('parent', 'superseded');
    if (fallback === 'store gap' || fallback === 'empty store feed') {
      h.db.query('UPDATE items SET tombstoned = 1 WHERE provider_item_id = ?').run('parent');
      h.db.exec('DELETE FROM item_visibility_feed');
      if (fallback === 'store gap') h.put('unrelated');
    }
    if (fallback === 'ledger gap') {
      h.ledgerDb.exec('DELETE FROM tier_visibility_changes');
      h.setCopyState('template', 'superseded');
    }
    if (fallback === 'no feed') h.target.visibilityFeedPresent = false;
    if (fallback === 'lane set') h.store.useChildVisibility({ ledger: () => h.f.ledger, stores: () => [h.store] });
    if (fallback === 'unbound ledger') h.store.useChildVisibility({ ledger: () => undefined, stores: () => [h.store] });
    if (fallback === 'replacement ledger') {
      h.store.useChildVisibility({ ledger: () => ({}) as any, stores: () => [h.store] });
    }
    const walk = spyOn(h.target, 'hiddenChildFullReadSteps');
    const result = h.hidden();
    expect(walk).toHaveBeenCalledTimes(1);
    expect(result).toEqual(h.full());
    if (fallback !== 'unbound ledger') expect(result).toContain(h.child);
    walk.mockRestore();
  });
}

test('a read-only handle with no feed falls back instead of retaining an old set', async () => {
  const h = await setup();
  // Older read-only schemas have no persistent feed; simulate that capability
  // on an actual read-only connection rather than removing the writer triggers.
  const { LocalConnectorStore } = await import('../src/workers/connector-store/index.ts');
  const reader = new LocalConnectorStore({ dbPath: h.f.paths.internal, corpusId: h.store.corpusId,
    family: 'file', trustDomain: 'internal', tierLedger: h.f.ledger, readOnly: true });
  try {
    const target = reader as any;
    target.visibilityFeedPresent = false;
    const walk = spyOn(target, 'hiddenChildFullReadSteps');
    h.setCopyState('parent', 'superseded');
    expect(target.hiddenChildItemPks()).toContain(h.child);
    expect(walk).toHaveBeenCalledTimes(1);
    walk.mockRestore();
  } finally { reader.close(); }
});

test('an unrelated item write does not walk or judge parents after bootstrap', async () => {
  const h = await setup();
  const walk = spyOn(h.target, 'hiddenChildFullReadSteps');
  const verdicts = spyOn(h.store, 'parentStandings');
  h.put('unrelated');
  expect(h.hidden()).toEqual([]);
  expect(walk).toHaveBeenCalledTimes(0);
  expect(verdicts).toHaveBeenCalledTimes(0);
  walk.mockRestore();
  verdicts.mockRestore();
});

test('incremental results equal a fresh full walk after 50 deterministic mixed operations', async () => {
  const h = await setup();
  for (let n = 0; n < 4; n++) { h.put(`p${n}`); h.put(`p${n}#child:seed`, `p${n}`); }
  h.put('mover');
  h.put('mover#child:one', 'mover');
  h.hidden();
  let seed = 1499;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let n = 0; n < 50; n++) {
    const id = `p${random(4)}`;
    switch (random(7)) {
      case 0: h.setCopyState(id, 'staged'); break;
      case 1: h.setCopyState(id, 'current'); break;
      case 2: h.db.query('UPDATE items SET tombstoned = ? WHERE provider_item_id = ?').run(random(2), id); break;
      case 3: h.put(`${id}#child:${n}`, id); break;
      case 4: h.db.query('DELETE FROM items WHERE provider_item_id = ?').run(`${id}#child:seed`); break;
      case 5: await moveTieredItem({ set: h.f.set, identity: identityOf('mover'), target: random(2) ? h.high : h.low }); break;
      case 6: h.db.query('UPDATE items SET parent_local_item_id = ? WHERE provider_item_id = ?').run(identityOf(`p${random(4)}`).localItemId, `${id}#child:seed`); break;
    }
    expect(h.hidden()).toEqual(h.full());
  }
});

test('a yielded build never installs over a memo advanced by another reader', async () => {
  const h = await setup();
  h.setCopyState('parent', 'superseded');
  const steps = h.target.hiddenChildReadSteps();
  let step = steps.next();
  expect(step.done).toBe(false);
  h.assertHidden();
  while (!step.done) step = steps.next(step.value.here());
  expect(sorted(step.value)).toEqual(h.full());
  expect(h.hidden()).toEqual(h.full());
});

test('off-thread and synchronous readers share the memo; an intervening write is not installed', async () => {
  const h = await setup();
  const before = h.target.hiddenChildMemo;
  h.setCopyState('parent', 'superseded');
  const steps = h.target.hiddenChildReadSteps();
  let step = steps.next();
  while (!step.done) {
    const result = await step.value.offThread();
    // Move the feed after every pool read without timers or raw sleeps.
    h.db.query('UPDATE items SET tombstoned = tombstoned WHERE provider_item_id = ?').run('template');
    step = steps.next(result);
  }
  expect(h.target.hiddenChildMemo).toBe(before);
  h.assertHidden();
  const walk = spyOn(h.target, 'hiddenChildFullReadSteps');
  await h.target.tierHiddenItemPksInTurns();
  expect(walk).toHaveBeenCalledTimes(0);
  expect(h.hidden()).toEqual(h.full());
  walk.mockRestore();
});

test('a cold off-thread walk cannot install a result across a moved cursor', async () => {
  const h = await setup();
  h.target.hiddenChildMemo = undefined;
  const steps = h.target.hiddenChildReadSteps();
  let step = steps.next();
  let changed = false;
  while (!step.done) {
    const result = await step.value.offThread();
    if (!changed) { h.setCopyState('parent', 'superseded'); changed = true; }
    step = steps.next(result);
  }
  expect(h.target.hiddenChildMemo).toBeUndefined();
  h.assertHidden();
  expect(h.target.hiddenChildMemo).toBeDefined();
});

test('an unavailable feed in another lane store forces the full walk', async () => {
  const h = await setup();
  await moveTieredItem({ set: h.f.set, identity: identityOf('parent'), target: h.high });
  h.hidden();
  const other = h.f.stores.secure_local as any;
  other.visibilityFeedPresent = false;
  other.db.query('UPDATE items SET tombstoned = 1 WHERE provider_item_id = ?').run('parent');
  const walk = spyOn(h.target, 'hiddenChildFullReadSteps');
  expect(h.hidden()).toContain(h.child);
  expect(walk).toHaveBeenCalledTimes(1);
  expect(h.target.hiddenChildMemo).toBeUndefined();
  expect(h.hidden()).toEqual(h.full());
  walk.mockRestore();
});

test('a newly inserted ancestor previously known only by local id unhides descendants', async () => {
  const h = await setup();
  h.db.query('UPDATE items SET parent_local_item_id = ? WHERE provider_item_id = ?').run(identityOf('missing').localItemId, 'parent');
  h.assertHidden();
  h.put('missing');
  expect(h.hidden()).toEqual([]);
  expect(h.hidden()).toEqual(h.full());
  h.db.query('DELETE FROM items WHERE provider_item_id = ?').run('missing');
  h.assertHidden();
});

test('an empty child memo skips unrelated identities and still sees its first new child', async () => {
  const h = await setup();
  h.db.query('DELETE FROM items WHERE item_pk = ?').run(h.child);
  expect(h.hidden()).toEqual([]);
  const links = spyOn(h.store, 'parentLinksOf');
  h.put('unrelated');
  expect(h.hidden()).toEqual([]);
  expect(links).toHaveBeenCalledTimes(0);
  links.mockRestore();
  h.setCopyState('parent', 'superseded');
  const pk = h.put('parent#child:new', 'parent')!;
  h.assertHidden(pk, 'parent#child:new');
});

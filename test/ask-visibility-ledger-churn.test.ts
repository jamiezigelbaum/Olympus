import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { identityOf, openTierFixture, tempDir, type TierFixture } from './helpers/tier-fixtures.ts';
import { createReleaseTierCheck, createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { setReadPoolObserverForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import type { SourceIndexRoutedSearchHit } from '../src/core/source-index/router.ts';
import type { ReleaseInput } from '../src/core/release-manifest.ts';

let fixture: TierFixture | undefined;
let cleanup: (() => void) | undefined;
afterEach(() => {
  setReadPoolObserverForTests();
  fixture?.close();
  cleanup?.();
  fixture = undefined;
  cleanup = undefined;
});

// A live install writes to the ledger all the time while it judges and syncs.
// A write to an unrelated item during a pooled judgment must not withhold the
// Ask's hits; a write that hides an asked item during it must still hide it.
function seed() {
  const temp = tempDir('olympus-ask-churn-');
  cleanup = temp.cleanup;
  const f = openTierFixture(temp.dir, { embed: false });
  fixture = f;
  const store = f.stores.secure_local!;
  const db = (store as any).db as Database;
  const decision = { ...classifyItemTiers({ signals: { title: 'Note' }, text: 'An orchard note' }), metadataTier: 'secure' as const, contentTier: 'secure' as const };
  const ids = ['item-0', 'item-1', 'item-2'];
  db.transaction(() => {
    db.query(`INSERT INTO sync_runs (sync_run_id, corpus_id, connector_id, status, started_at) VALUES ('seed', ?, 'seed', 'completed', '2026-11-11')`).run(store.corpusId);
    for (const id of ids) {
      db.query(`INSERT INTO items (family, provider, account_scope, provider_item_id, local_item_id,
        mime_type, fetched_at, indexed_at, trust_tier, sync_run_id)
        VALUES ('file', 'fixture', 'personal', ?, ?, 'text/plain', '2026-11-11', '2026-11-11', 'S4', 'seed')`).run(id, identityOf(id).localItemId);
    }
  })();
  for (const id of ids) f.ledger.recordRoutedPlacement(identityOf(id), decision, f.set.placementFor(decision));
  const scopes = () => [{ ledger: f.ledger, corpusIds: new Set(f.set.openStores().map(s => s.corpusId)), stores: () => f.set.openStores() }];
  const identities = ids.map(id => identityOf(id));
  const hits: SourceIndexRoutedSearchHit[] = identities.map(sourceItem => ({
    corpusId: store.corpusId, sourceItem, provenance: { sourceItem }, trustDomain: store.trustDomain, rawExposed: false,
  }));
  const inputs: ReleaseInput[] = identities.map(identity => ({ ...identity, corpusId: store.corpusId, privateAtAnswer: true }));
  let unrelated = 0;
  const writeUnrelated = () => f.ledger.recordRoutedPlacement(identityOf(`unrelated-${unrelated++}`), decision, f.set.placementFor(decision));
  return { f, gate: createTierVisibilityGate(scopes), check: createReleaseTierCheck(scopes, () => 'allow'), hits, inputs, writeUnrelated };
}

test('an unrelated ledger write during the pooled read is judged again, not withheld', async () => {
  const { gate, check, hits, inputs, writeUnrelated } = seed();
  let writes = 0;
  setReadPoolObserverForTests(() => { if (writes < 1) { writes += 1; writeUnrelated(); } }, { snapshots: true });
  expect(await gate.offThread!(hits)).toHaveLength(3);
  writes = 0;
  const verdicts = await check.inputsOffThread!(inputs);
  expect(verdicts.map(verdict => verdict.tier)).toEqual(['private', 'private', 'private']);
  expect(verdicts.every(verdict => !verdict.gone)).toBe(true);
});

test('writes during every pooled read fall back to one judgment here', async () => {
  const { gate, check, hits, inputs, writeUnrelated } = seed();
  setReadPoolObserverForTests(() => { writeUnrelated(); }, { snapshots: true });
  expect(await gate.offThread!(hits)).toHaveLength(3);
  const verdicts = await check.inputsOffThread!(inputs);
  expect(verdicts.map(verdict => verdict.tier)).toEqual(['private', 'private', 'private']);
});

test('a write that hides an asked item during the pooled read still hides it', async () => {
  const { f, gate, check, hits, inputs } = seed();
  let moved = false;
  const hide = () => {
    if (moved) return;
    moved = true;
    const secret = { ...classifyItemTiers({ signals: { title: 'Note' }, text: 'An orchard note' }), metadataTier: 'secrets' as const, contentTier: 'secrets' as const };
    f.ledger.recordRoutedPlacement(identityOf('item-1'), secret, f.set.placementFor(secret));
  };
  setReadPoolObserverForTests(hide, { snapshots: true });
  const visible = await gate.offThread!(hits);
  expect(visible.map(hit => hit.sourceItem.providerItemId)).toEqual(['item-0', 'item-2']);
  const verdicts = await check.inputsOffThread!(inputs);
  expect(verdicts[1]!.tier).toBe('secret');
});

import { expect, test } from 'bun:test';
import { FIXTURE_PLACEMENT, fixtureConnector, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

test('a small vector result validates only its ranked candidates once, rather than the corpus', async () => {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir);
  try {
    await f.set.sync(fixtureConnector(() => Array.from({ length: 40 }, (_, n) => ({
      id: `garden-${n}`, name: `Garden ${n}`, text: 'Ordinary orchard notes.',
    }))), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const original = f.ledger.copiesForMany.bind(f.ledger);
    const checked: string[] = [];
    f.ledger.copiesForMany = (identities) => {
      checked.push(...identities.map(identity => identity.providerItemId));
      return original(identities);
    };
    const result = await f.stores.internal!.vectorSearchLane('Ordinary orchard notes.', f.cloud, 2);
    expect(result.rows).toHaveLength(2);
    expect(checked).toHaveLength(2);
    expect(new Set(checked).size).toBe(2);
    expect(new Set(result.rows.map(row => row.sourceItem.providerItemId))).toEqual(new Set(checked));
  } finally { f.close(); tmp.cleanup(); }
});

test('candidate validation still fails closed when the tier ledger becomes unreadable', async () => {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir);
  try {
    await f.set.sync(fixtureConnector(() => [{ id: 'garden', name: 'Garden', text: 'Ordinary orchard notes.' }]),
      { fetchContent: true, placement: FIXTURE_PLACEMENT });
    f.ledger.copiesForMany = () => { throw new Error('ledger unavailable'); };
    expect((await f.stores.internal!.vectorSearchLane('Ordinary orchard notes.', f.cloud, 2)).rows).toEqual([]);
  } finally { f.close(); tmp.cleanup(); }
});

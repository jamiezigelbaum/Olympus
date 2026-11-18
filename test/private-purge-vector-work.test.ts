import { expect, spyOn, test } from 'bun:test';
import { FIXTURE_PLACEMENT, fixtureConnector, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

test('a small vector result validates only its ranked candidates once, rather than the corpus', async () => {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir);
  try {
    await f.set.sync(fixtureConnector(() => Array.from({ length: 40 }, (_, n) => ({
      id: `garden-${n}`, name: `Garden ${n}`, text: 'Ordinary orchard notes.',
    }))), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    // Both the pooled and the here path judge through these steps.
    const original = f.ledger.visibilityReadSteps.bind(f.ledger);
    const checked: string[] = [];
    spyOn(f.ledger, 'visibilityReadSteps').mockImplementation((identities, options) => {
      checked.push(...identities.map(identity => identity.providerItemId));
      return original(identities, options);
    });
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
    // Fail the copies read inside the shared steps, wherever they run.
    const original = f.ledger.visibilityReadSteps.bind(f.ledger);
    let failed = 0;
    spyOn(f.ledger, 'visibilityReadSteps').mockImplementation(function* (identities, options) {
      const steps = original(identities, options);
      let step = steps.next();
      while (!step.done) {
        if (step.value.sql.includes('FROM tier_copies')) { failed += 1; throw new Error('ledger unavailable'); }
        step = steps.next(yield step.value);
      }
      return step.value;
    });
    expect((await f.stores.internal!.vectorSearchLane('Ordinary orchard notes.', f.cloud, 2)).rows).toEqual([]);
    expect(failed).toBeGreaterThan(0);
  } finally { f.close(); tmp.cleanup(); }
});

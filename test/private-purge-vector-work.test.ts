import { expect, spyOn, test } from 'bun:test';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

test('a small vector result validates only ranked candidates and rechecks them after hydration', async () => {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir);
  try {
    await f.set.sync(fixtureConnector(() => Array.from({ length: 40 }, (_, n) => ({
      id: `garden-${n}`, name: `Garden ${n}`, text: 'Ordinary orchard notes.',
    }))), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    // Both the pooled and the here path judge through these steps.
    const checked: string[] = [];
    const original = TierLedger.visibilityReadSteps;
    const observer = spyOn(TierLedger, 'visibilityReadSteps').mockImplementation((identities, options) => {
      checked.push(...identities.map(identity => identity.providerItemId));
      return original(identities, options);
    });
    try {
      const result = await f.stores.internal!.vectorSearchLane('Ordinary orchard notes.', f.cloud, 2);
      expect(result.rows).toHaveLength(2);
      expect(checked).toHaveLength(4);
      expect(new Set(checked.slice(0, 2))).toEqual(new Set(checked.slice(2)));
      expect(new Set(result.rows.map(row => row.sourceItem.providerItemId))).toEqual(new Set(checked));
    } finally { observer.mockRestore(); }
  } finally { f.close(); tmp.cleanup(); }
});

test('candidate validation still fails closed when the tier ledger becomes unreadable', async () => {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir);
  try {
    await f.set.sync(fixtureConnector(() => [{ id: 'garden', name: 'Garden', text: 'Ordinary orchard notes.' }]),
      { fetchContent: true, placement: FIXTURE_PLACEMENT });
    // Fail the copies read inside the shared steps, wherever they run.
    const original = TierLedger.visibilityReadSteps;
    let failed = 0;
    const observer = spyOn(TierLedger, 'visibilityReadSteps').mockImplementation(function* (identities, options) {
      const steps = original(identities, options);
      let step = steps.next();
      while (!step.done) {
        if (step.value.sql.includes('FROM tier_copies')) { failed += 1; throw new Error('ledger unavailable'); }
        step = steps.next(yield step.value);
      }
      return step.value;
    });
    try {
      expect(await f.stores.internal!.vectorSearchLane('Ordinary orchard notes.', f.cloud, 2)).toEqual({
        rows: [], skippedReason: 'vector_visibility_unavailable',
      });
      expect(failed).toBeGreaterThan(0);
    } finally { observer.mockRestore(); }
  } finally { f.close(); tmp.cleanup(); }
});

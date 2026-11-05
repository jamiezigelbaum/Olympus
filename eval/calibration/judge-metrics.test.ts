import { describe, expect, test } from 'bun:test';
import { confusion, medianAndRange, privateChance, reweighted, tierMass, type ScoredRow } from './judge-metrics.ts';

const row = (owner: ScoredRow['owner'], judge: ScoredRow['judge'], stratum?: string): ScoredRow => ({
  id: 'x', owner, judge, source: 'telegram', split: 'dev', ...(stratum ? { stratum } : {}),
});

describe('confusion', () => {
  test('counts both directions and leaves an empty class unmeasured', () => {
    const result = confusion([row('private', 'private'), row('private', 'private'), row('private', 'personal'), row('personal', 'private')]);
    expect(result.privateToPersonal).toBe(1);
    expect(result.personalToPrivate).toBe(1);
    expect(result.privateRecall).toBeCloseTo(2 / 3);
    expect(result.personalRecall).toBe(0);
    expect(result.balancedAccuracy).toBeCloseTo(1 / 3);
    expect(confusion([row('private', 'private')]).personalRecall).toBeNull();
  });
});

describe('reweighted', () => {
  test('a miss in the big stratum outweighs hits in the oversampled one', () => {
    const rows = [row('private', 'private', 'judged_private'), row('private', 'private', 'judged_private'), row('private', 'personal', 'rest')];
    const sizes = { telegram: { judged_private: 10, rest: 990 } };
    expect(confusion(rows).privateRecall).toBeCloseTo(2 / 3);
    expect(confusion(reweighted(rows, sizes)).privateRecall).toBeCloseTo(0.01);
  });

  test('drops a row whose stratum size was not recorded', () => {
    expect(reweighted([row('private', 'private', 'other')], { telegram: { rest: 5 } })).toEqual([]);
  });
});

describe('tierMass', () => {
  const lp = Math.log;
  test('splits whole-word tokens and ignores anything else', () => {
    const mass = tierMass([{ token: 'private', logprob: lp(0.6) }, { token: 'personal', logprob: lp(0.2) }, { token: 'public', logprob: lp(0.2) }]);
    expect(privateChance(mass)).toBeCloseTo(0.75);
  });

  test('counts word pieces, and a piece shared by both words decides nothing', () => {
    const mass = tierMass([{ token: 'pri', logprob: lp(0.3) }, { token: 'per', logprob: lp(0.1) }, { token: 'p', logprob: lp(0.5) }]);
    expect(mass.ambiguous).toBeCloseTo(0.5);
    expect(privateChance(mass)).toBeCloseTo(0.75);
  });

  test('reads the next piece after a shared first piece', () => {
    expect(privateChance(tierMass([{ token: 'rivate', logprob: lp(0.9) }, { token: 'ersonal', logprob: lp(0.1) }], 'p'))).toBeCloseTo(0.9);
  });

  test('no mass on either word is no answer', () => {
    expect(privateChance(tierMass([{ token: 'maybe', logprob: lp(1) }]))).toBeUndefined();
  });
});

test('medianAndRange', () => {
  expect(medianAndRange([3, 1, 2])).toEqual({ median: 2, min: 1, max: 3 });
  expect(medianAndRange([4, 1]).median).toBe(2.5);
});

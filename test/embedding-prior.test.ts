// Synthetic only: the expected odds do not depend on the fitting algorithm.
import { expect, test } from 'bun:test';
import { correctedPrivateProbability, measuredPrivatePrior, privateProbability, trainLogistic, EMBEDDING_PREFILTER_DIMENSIONS as D } from '../src/workers/classification/embedding-logistic.ts';
const vector = [1, ...new Array(D - 1).fill(0)];
test('balanced fit shifts odds by logit(3%) and leaves raw scores unchanged', () => {
  const model = trainLogistic(Array.from({ length: 40 }, (_, n) => ({ vector, private: n % 2 === 0 })), 10)!;
  const raw = privateProbability(model, vector)!;
  const corrected = correctedPrivateProbability(model, vector, { privateRate: 0.03, trainingPrivateRate: 0.5 })!;
  expect(corrected / (1 - corrected)).toBeCloseTo(raw / (1 - raw) * 0.03 / 0.97, 12);
  expect(privateProbability(model, vector)).toBe(raw);
  expect(correctedPrivateProbability({ weights: new Array(D).fill(0), bias: 0 }, vector,
    { privateRate: 0.03, trainingPrivateRate: 0.5 })).toBeCloseTo(0.03, 12);
});
test('measured prior floors at 1%, bounds endpoints, and rejects absent evidence', () => {
  expect(measuredPrivatePrior(1000, 0)).toBe(0.01);
  expect(measuredPrivatePrior(0, 1000)).toBe(0.99);
  expect(measuredPrivatePrior(970, 30)).toBe(0.03);
  for (const counts of [[0, 0], [-1, 1], [NaN, 1], [1.5, 2]]) expect(measuredPrivatePrior(...counts as [number, number])).toBeUndefined();
  for (const prior of [undefined, { privateRate: 0, trainingPrivateRate: 0.5 }, { privateRate: 0.03, trainingPrivateRate: 1 }, { privateRate: NaN, trainingPrivateRate: 0.5 }])
    expect(correctedPrivateProbability({ weights: new Array(D).fill(0), bias: -10 }, vector, prior)).toBeUndefined();
});

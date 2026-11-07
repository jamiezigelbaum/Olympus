import { expect, test } from 'bun:test';
import { trainLogistic, privateProbability, EMBEDDING_PREFILTER_DIMENSIONS as D } from '../src/workers/classification/embedding-logistic.ts';
const vector = (sign: number) => [sign, ...new Array(D - 1).fill(0)];
test('minimum applies to each valid class, and invalid vectors never train', () => {
  expect(trainLogistic([{ vector: vector(1), private: false }])).toBeUndefined();
  expect(trainLogistic([{ vector: vector(1), private: false }, { vector: [], private: true }], 1)).toBeUndefined();
});
test('synthetic separable classes yield low and high Private probabilities', () => {
  const examples = Array.from({ length: 200 }, (_, index) => ({ vector: vector(index % 2 ? 1 : -1), private: index % 2 === 1 }));
  const model = trainLogistic(examples, 50)!;
  expect(privateProbability(model, vector(-1))!).toBeLessThan(0.05);
  expect(privateProbability(model, vector(1))!).toBeGreaterThan(0.95);
  expect(privateProbability(model, [NaN, ...vector(1).slice(1)])).toBeUndefined();
  expect(privateProbability(model, new Array(D).fill(0))).toBeUndefined();
  expect(privateProbability({ weights: [], bias: 0 }, vector(1))).toBeUndefined();
});

// Small L2-regularized logistic regression. All inputs are install-local; no model service or dependency.
export const EMBEDDING_PREFILTER_MODEL_ID = 'embeddinggemma-2-litert-24d962e';
export const EMBEDDING_PREFILTER_DIMENSIONS = 768;
export const EMBEDDING_PREFILTER_MIN_PER_CLASS = 2000;
export interface LogisticExample { vector: readonly number[]; private: boolean }
export interface LogisticModel { weights: number[]; bias: number }
function normalized(vector: readonly number[]): number[] | undefined {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_PREFILTER_DIMENSIONS || !vector.every(Number.isFinite)) return undefined;
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) return undefined;
  return vector.map(value => value / norm);
}
function sigmoid(value: number): number { return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value)); }
export function privateProbability(model: LogisticModel, vector: readonly number[]): number | undefined {
  if (!model || !Array.isArray(model.weights) || model.weights.length !== EMBEDDING_PREFILTER_DIMENSIONS
    || !model.weights.every(Number.isFinite) || !Number.isFinite(model.bias)) return undefined;
  const input = normalized(vector);
  if (!input) return undefined;
  let score = model.bias;
  for (let i = 0; i < input.length; i++) score += input[i]! * model.weights[i]!;
  return Number.isFinite(score) ? sigmoid(score) : undefined;
}
export function trainLogistic(examples: readonly LogisticExample[], minimumPerClass = EMBEDDING_PREFILTER_MIN_PER_CLASS): LogisticModel | undefined {
  if (!Number.isSafeInteger(minimumPerClass) || minimumPerClass < 1) return undefined;
  const counts = [0, 0];
  const inputs: Array<{ vector: number[]; label: number }> = [];
  for (const example of examples) {
    const vector = normalized(example.vector);
    if (!vector || typeof example.private !== 'boolean') continue;
    const label = Number(example.private);
    inputs.push({ vector, label }); counts[label]!++;
  }
  if (counts.some(count => count < minimumPerClass)) return undefined;
  const weights = new Array<number>(EMBEDDING_PREFILTER_DIMENSIONS).fill(0);
  let bias = Math.log(counts[1]! / counts[0]!);
  // Deterministic shuffled SGD, bounded at 20 epochs. Preserve observed class priors.
  let seed = 939;
  const order = inputs.map((_, index) => index);
  for (let epoch = 0; epoch < 20; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const rate = 0.12 / (1 + epoch * 0.15);
    const shrink = 1 - rate * 0.001;
    for (const index of order) {
      const input = inputs[index]!;
      let score = bias;
      for (let i = 0; i < weights.length; i++) score += weights[i]! * input.vector[i]!;
      const error = sigmoid(score) - input.label;
      bias -= rate * error;
      for (let i = 0; i < weights.length; i++) weights[i] = weights[i]! * shrink - rate * error * input.vector[i]!;
    }
  }
  return { weights, bias };
}

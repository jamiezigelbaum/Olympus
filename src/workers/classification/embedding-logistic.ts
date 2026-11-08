// Class-balanced, L2-regularized logistic regression. Install-local; no model service or dependency.
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
  const steps = trainLogisticSteps(examples, minimumPerClass);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
const FIT_C = 10;
const MAX_ITERATIONS = 500;
const GRADIENT_TOLERANCE = 1e-8;
const HISTORY_SIZE = 10;
const MAX_LINE_SEARCH = 40;
const ARMIJO = 1e-4;
function dot(a: readonly number[], b: readonly number[]): number {
  let result = 0;
  for (let i = 0; i < a.length; i++) result += a[i]! * b[i]!;
  return result;
}
/** Deterministic full-batch L-BFGS; each input/evaluation yields for the worker's tick budget.
 * Callers cap retained examples at MAX_PER_CLASS per class. Extra memory is O(N*d + 10*d),
 * never a dense Hessian. Failure to converge throws, so callers cannot publish a partial fit.
 */
export function* trainLogisticSteps(examples: readonly LogisticExample[], minimumPerClass = EMBEDDING_PREFILTER_MIN_PER_CLASS): Generator<void, LogisticModel | undefined> {
  if (!Number.isSafeInteger(minimumPerClass) || minimumPerClass < 1) return undefined;
  const counts = [0, 0];
  const inputs: Array<{ vector: number[]; label: number }> = [];
  for (const example of examples) {
    const vector = normalized(example.vector);
    if (!vector || typeof example.private !== 'boolean') continue;
    const label = Number(example.private);
    inputs.push({ vector, label }); counts[label]!++;
    yield;
  }
  if (counts.some(count => count < minimumPerClass)) return undefined;
  const dimensions = EMBEDDING_PREFILTER_DIMENSIONS;
  // Divide sklearn's objective by C*N for numerical scale, without changing its
  // minimizer: ||w||²/(2*C*N) + sum(logloss_i/(2*n_class_i)). The last coordinate
  // is the unpenalized intercept, initialized at zero for the balanced objective.
  const penalty = 1 / (FIT_C * inputs.length);
  function* evaluate(parameters: number[]): Generator<void, { loss: number; gradient: number[] }> {
    const gradient = parameters.map((value, i) => i < dimensions ? penalty * value : 0);
    let loss = 0;
    for (let i = 0; i < dimensions; i++) loss += 0.5 * penalty * parameters[i]! ** 2;
    for (const { vector, label } of inputs) {
      let score = parameters[dimensions]!;
      for (let i = 0; i < dimensions; i++) score += parameters[i]! * vector[i]!;
      const scale = 1 / (2 * counts[label]!);
      const margin = (2 * label - 1) * score;
      // Stable log-loss and residual, including confident correctly labelled inputs.
      loss += scale * (Math.max(0, -margin) + Math.log1p(Math.exp(-Math.abs(margin))));
      const error = scale * (label ? -sigmoid(-score) : sigmoid(score));
      gradient[dimensions]! += error;
      for (let i = 0; i < dimensions; i++) gradient[i]! += error * vector[i]!;
      yield;
    }
    return { loss, gradient };
  }
  let parameters = new Array<number>(dimensions + 1).fill(0);
  let current = yield* evaluate(parameters);
  const history: Array<{ s: number[]; y: number[]; sy: number; yy: number }> = [];
  for (let iteration = 0; iteration <= MAX_ITERATIONS; iteration++) {
    if (!Number.isFinite(current.loss) || !current.gradient.every(Number.isFinite)) throw new Error('Logistic fit is nonfinite');
    if (Math.max(...current.gradient.map(Math.abs)) <= GRADIENT_TOLERANCE) {
      return { weights: parameters.slice(0, dimensions), bias: parameters[dimensions]! };
    }
    if (iteration === MAX_ITERATIONS) break;
    // L-BFGS two-loop recursion; bounded 769-coordinate work between yields.
    const direction = current.gradient.slice();
    const alpha = new Array<number>(history.length);
    for (let j = history.length - 1; j >= 0; j--) {
      const h = history[j]!;
      alpha[j] = dot(h.s, direction) / h.sy;
      for (let i = 0; i < direction.length; i++) direction[i]! -= alpha[j]! * h.y[i]!;
      yield;
    }
    const last = history.at(-1);
    const scaling = last ? last.sy / last.yy : 1;
    for (let i = 0; i < direction.length; i++) direction[i]! *= scaling;
    for (let j = 0; j < history.length; j++) {
      const h = history[j]!, beta = dot(h.y, direction) / h.sy;
      for (let i = 0; i < direction.length; i++) direction[i]! += h.s[i]! * (alpha[j]! - beta);
      yield;
    }
    for (let i = 0; i < direction.length; i++) direction[i] = -direction[i]!;
    let slope = dot(current.gradient, direction);
    if (!Number.isFinite(slope) || slope >= 0) {
      history.length = 0;
      for (let i = 0; i < direction.length; i++) direction[i] = -current.gradient[i]!;
      slope = -dot(current.gradient, current.gradient);
    }
    let stepSize = 1, accepted = false;
    for (let trial = 0; trial < MAX_LINE_SEARCH; trial++, stepSize *= 0.5) {
      const candidate = parameters.map((value, i) => value + stepSize * direction[i]!);
      const next = yield* evaluate(candidate);
      if (!Number.isFinite(next.loss) || next.loss > current.loss + ARMIJO * stepSize * slope) continue;
      const s = candidate.map((value, i) => value - parameters[i]!);
      const y = next.gradient.map((value, i) => value - current.gradient[i]!);
      const sy = dot(s, y), yy = dot(y, y);
      if (sy > 0 && yy > 0) {
        if (history.length === HISTORY_SIZE) history.shift();
        history.push({ s, y, sy, yy });
      }
      parameters = candidate;
      current = next;
      accepted = true;
      yield;
      break;
    }
    if (!accepted) throw new Error('Logistic line search did not converge');
  }
  throw new Error('Logistic fit did not converge');
}

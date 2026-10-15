import { describe, expect, test } from 'bun:test';
import { createAnswerActivity, createLocalModelActivity, runBackgroundInference, runClassificationInference } from '../src/workers/answer-activity.ts';

describe('answer activity', () => {
  test('preempts on the first answer and releases each lease once', () => {
    let preempts = 0;
    const activity = createAnswerActivity(() => { preempts += 1; });
    const first = activity.begin();
    const second = activity.begin();
    expect(preempts).toBe(1);
    expect(activity.inFlight).toBe(2);
    first();
    first();
    expect(activity.inFlight).toBe(1);
    second();
    expect(activity.busy).toBe(false);
  });

  test('a lease never released expires, is said once, and the count heals', () => {
    let clock = 0;
    const expired: number[] = [];
    const activity = createAnswerActivity(() => undefined, {
      maxLeaseMs: 1_000,
      now: () => clock,
      onExpired: (openMs) => expired.push(openMs),
    });
    activity.begin();
    clock = 500;
    const fresh = activity.begin();
    expect(activity.inFlight).toBe(2);
    clock = 1_200;
    expect(activity.inFlight).toBe(1);
    expect(activity.busy).toBe(true);
    fresh();
    expect(activity.busy).toBe(false);
    expect(expired).toEqual([1_200]);
    expect(activity.expired).toBe(1);
  });

  test('end() without a release ends the oldest lease; run() always releases', async () => {
    const activity = createAnswerActivity(() => undefined);
    activity.begin();
    activity.end();
    activity.end();
    expect(activity.inFlight).toBe(0);
    await expect(activity.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(activity.busy).toBe(false);
  });
});


test('cloud-only search never aborts local sorting; only the same local model does, and idle resumes it', async () => {
  let preempts = 0;
  let wakes = 0;
  const models = createLocalModelActivity();
  models.onBusy('built_in', () => preempts++);
  models.onIdle('built_in', () => wakes++);
  const answers = createAnswerActivity(() => undefined);
  await answers.run(async () => { expect(models.busy('built_in')).toBe(false); });
  await models.run('other-local-model', async () => undefined);
  expect(preempts).toBe(0);
  await models.run('built_in', async () => {
    expect(models.busy('built_in')).toBe(true);
    expect(preempts).toBe(1);
  });
  await Promise.resolve();
  expect(wakes).toBe(1);
});


test('classification queues before automatic inference; background dispatch never preempts sorting', async () => {
  const activity = createLocalModelActivity();
  const order: string[] = [];
  let preempts = 0;
  activity.onBusy('built_in', () => preempts++);
  const tracked = activity.track('built_in', { complete: async (request: { prompt: string }) => {
    order.push(request.prompt); return { text: '', modelId: 'fixture' };
  } });
  const request = (prompt: string) => ({ system: '', prompt, localOnly: true });
  await Promise.all([
    runBackgroundInference(() => tracked.complete(request('inbox'))),
    runClassificationInference(() => tracked.complete(request('classification'))),
    tracked.complete(request('owner')),
  ]);
  expect(order).toEqual(['owner', 'classification', 'inbox']);
  expect(preempts).toBe(1);
});

test('configured analysts can complete concurrently without queue wait consuming their timeout', async () => {
  const activity = createLocalModelActivity();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered: string[] = [];
  const tracked = activity.track('remote-model', { complete: async (request: { prompt: string }) => {
    entered.push(request.prompt); await gate; return { text: '', modelId: 'fixture' };
  } }, { serialize: false });
  const a = tracked.complete({ prompt: 'one' });
  const b = tracked.complete({ prompt: 'two' });
  await Promise.resolve();
  expect(entered).toEqual(['one', 'two']);
  release();
  await Promise.all([a, b]);
});

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

test('a caller with concurrency N runs up to N calls at once, and the owner still starts first', async () => {
  const activity = createLocalModelActivity();
  let inFlight = 0;
  let peak = 0;
  const started: string[] = [];
  const release: Array<() => void> = [];
  const model = { complete: async (request: { prompt: string }) => {
    started.push(request.prompt);
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise<void>(resolve => release.push(resolve));
    inFlight -= 1;
    return { text: '', modelId: 'fixture' };
  } };
  const sorting = activity.track('local', model, { concurrency: 3 });
  const owner = activity.track('local', model);
  const request = (prompt: string) => ({ system: '', prompt, localOnly: true });
  const calls = ['a', 'b', 'c', 'd', 'e'].map(name => runClassificationInference(() => sorting.complete(request(name))));
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  await tick();
  expect(started).toEqual(['a', 'b', 'c']);
  // The owner arrives while three sorting calls run: it waits for them, then runs alone before d and e.
  const ownerCall = owner.complete(request('owner'));
  for (let i = 0; i < 3; i++) { release.shift()!(); await tick(); }
  await tick();
  expect(started.slice(3)).toEqual(['owner']);
  expect(inFlight).toBe(1);
  release.shift()!(); await tick();
  expect(started.slice(4)).toEqual(['d', 'e']);
  while (release.length > 0) { release.shift()!(); await tick(); }
  await Promise.all([...calls, ownerCall]);
  expect(peak).toBe(3);
});

test('busyExcept ignores the caller\'s own tagged calls and still sees anyone else\'s', async () => {
  const activity = createLocalModelActivity();
  const release: Array<() => void> = [];
  const model = { complete: async (_request: { prompt: string }) => {
    await new Promise<void>(resolve => release.push(resolve));
    return { text: '', modelId: 'fixture' };
  } };
  const sorting = activity.track('local', model, { concurrency: 2, tag: 'sorter' });
  const other = activity.track('local', model, { serialize: false });
  const request = { system: '', prompt: 'x', localOnly: true };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const a = runClassificationInference(() => sorting.complete(request));
  const b = runClassificationInference(() => sorting.complete(request));
  await tick();
  expect(activity.busy('local')).toBe(true);
  expect(activity.busyExcept('local', 'sorter')).toBe(false);
  const c = other.complete(request);
  await tick();
  expect(activity.busyExcept('local', 'sorter')).toBe(true);
  while (release.length > 0) { release.shift()!(); await tick(); }
  await Promise.all([a, b, c]);
  expect(activity.busyExcept('local', 'sorter')).toBe(false);
});

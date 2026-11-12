// The front and the background of a split engine share one models directory
// and one status file, and both can install the built-in model at once. One
// process's prepare() can end while the other's install still reads
// "verifying": it must not stay unprepared once the status turns ready, or
// the privacy judge waits forever on "the private model is not available
// (ready)" (switch-on release check, 2026-11-12).

import { expect, test } from 'bun:test';
import type { BuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { frontBuiltInModel, sharedBuiltInModel } from '../src/workers/engine/runtime/judging-models.ts';

function fakeBase(initial: string) {
  let state = initial;
  let prepares = 0;
  const base = {
    async prepare() {
      prepares += 1;
    },
    status: () => ({ state }),
  } as unknown as BuiltInAnalystModel;
  return { base, setState: (next: string) => { state = next; }, prepares: () => prepares };
}

// prepare() runs on microtasks only here: let them all finish.
const settle = async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };

test('an install another process finished is verified here, and the model becomes available', async () => {
  const fake = fakeBase('verifying');
  let now = 0;
  const shared = sharedBuiltInModel(fake.base, () => now);
  await settle();
  // This process's own check ended while the other install still read "verifying".
  expect(fake.prepares()).toBe(1);
  expect(shared.available()).toBe(false);

  fake.setState('ready');
  shared.startIfIdle();
  await settle();
  expect(fake.prepares()).toBe(2);
  expect(shared.available()).toBe(true);
});

test('the check is not repeated on every tick while it cannot settle', async () => {
  const fake = fakeBase('downloading');
  let now = 0;
  const shared = sharedBuiltInModel(fake.base, () => now);
  await settle();
  fake.setState('ready');
  // Its prepare() keeps ending unprepared: the status flips back during each one.
  (fake.base as { prepare: () => Promise<void> }).prepare = async () => { fake.setState('verifying'); };
  shared.startIfIdle();
  await settle();
  fake.setState('ready');
  shared.startIfIdle();
  shared.startIfIdle();
  await settle();
  expect(shared.available()).toBe(false);
  now += 30_000;
  (fake.base as { prepare: () => Promise<void> }).prepare = async () => {};
  shared.startIfIdle();
  await settle();
  expect(shared.available()).toBe(true);
});

test('a fresh install still starts its download, and a missing model is never prepared', async () => {
  const fake = fakeBase('not_started');
  const shared = sharedBuiltInModel(fake.base, () => 0);
  await settle();
  expect(fake.prepares()).toBe(0);
  shared.startIfIdle();
  await settle();
  expect(fake.prepares()).toBe(1);
  expect(shared.available()).toBe(false);
});

// The engine split's front: the background holds the one model server, and
// the front never downloads the model or starts a server of its own.
// Switch-on Mac check, 2026-11-12: two servers ran at once and a private
// answer hit its deadline.
function fakeBackground() {
  const requests: unknown[] = [];
  let prepares = 0;
  return {
    background: {
      complete: async (request: unknown) => { requests.push(request); return { text: 'from the background', modelId: 'built-in' }; },
      prepare: () => { prepares += 1; },
    },
    requests,
    prepares: () => prepares,
  };
}

test('the front asks the background to install a missing model, and never downloads it itself', async () => {
  const fake = fakeBase('not_started');
  const bg = fakeBackground();
  let now = 0;
  const front = frontBuiltInModel(fake.base, bg.background, () => now);
  await settle();
  expect(fake.prepares()).toBe(0);
  expect(front.available()).toBe(false);
  front.startIfIdle();
  front.startIfIdle();
  await front.model.prepare();
  expect(fake.prepares()).toBe(0);
  // One wake per throttle window from the ticks; an explicit prepare (Try again) always asks.
  expect(bg.prepares()).toBe(2);
  now += 30_000;
  front.startIfIdle();
  expect(bg.prepares()).toBe(3);
});

test('the front verifies an install the background finished, once, and then answers through the background', async () => {
  const fake = fakeBase('ready');
  const bg = fakeBackground();
  const front = frontBuiltInModel(fake.base, bg.background, () => 0);
  await settle();
  expect(fake.prepares()).toBe(1);
  expect(front.available()).toBe(true);
  front.startIfIdle();
  await settle();
  expect(fake.prepares()).toBe(1);
  const answer = await front.model.complete({ system: 's', prompt: 'p', localOnly: true });
  expect(answer.text).toBe('from the background');
  expect(bg.requests).toHaveLength(1);
  expect(bg.prepares()).toBe(0);
  fake.setState('failed');
  expect(front.available()).toBe(false);
});

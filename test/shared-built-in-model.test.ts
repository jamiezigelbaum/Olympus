// The front and the background of a split engine share one models directory
// and one status file, and both can install the built-in model at once. One
// process's prepare() can end while the other's install still reads
// "verifying": it must not stay unprepared once the status turns ready, or
// the privacy judge waits forever on "the private model is not available
// (ready)" (switch-on release check, 2026-11-12).

import { expect, test } from 'bun:test';
import type { BuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { sharedBuiltInModel } from '../src/workers/engine/runtime/judging-models.ts';

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

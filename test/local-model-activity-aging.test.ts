import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { createLocalModelActivity, MAINTENANCE_AGING_MS, runBackgroundInference, runClassificationInference } from '../src/workers/answer-activity.ts';

afterEach(() => { setSystemTime(); });

// 1.4.0 release check (2026-11-08): background answers queued without pause
// kept every classification call waiting. After a minute it ranks with them.
test('a classification call that has waited a minute is no longer passed by later background answers', async () => {
  setSystemTime(new Date('2026-11-08T00:00:00Z'));
  const activity = createLocalModelActivity();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const model = (name: string, hold?: Promise<void>) => activity.track('local', {
    async complete(_request: { signal?: AbortSignal }) { order.push(name); if (hold) { entered(); await hold; } return { text: '', modelId: name }; },
  });
  const owner = model('owner', gate).complete({});
  await started;
  const classification = runClassificationInference(() => model('classification').complete({}));
  await new Promise(resolve => setTimeout(resolve, 0));
  setSystemTime(new Date(Date.parse('2026-11-08T00:00:00Z') + MAINTENANCE_AGING_MS + 1_000));
  const background = runBackgroundInference(() => model('background').complete({}));
  await new Promise(resolve => setTimeout(resolve, 0));
  release();
  await Promise.all([owner, classification, background]);
  expect(order).toEqual(['owner', 'classification', 'background']);
});

test('a fresh classification call still waits behind background answers', async () => {
  setSystemTime(new Date('2026-11-08T00:00:00Z'));
  const activity = createLocalModelActivity();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const model = (name: string, hold?: Promise<void>) => activity.track('local', {
    async complete(_request: { signal?: AbortSignal }) { order.push(name); if (hold) { entered(); await hold; } return { text: '', modelId: name }; },
  });
  const owner = model('owner', gate).complete({});
  await started;
  const classification = runClassificationInference(() => model('classification').complete({}));
  const background = runBackgroundInference(() => model('background').complete({}));
  await new Promise(resolve => setTimeout(resolve, 0));
  release();
  await Promise.all([owner, classification, background]);
  expect(order).toEqual(['owner', 'background', 'classification']);
});

// #1031: the sniffer's fair turn must tell the owner's own calls from others.
test('ownerInFlight counts only the owner\'s own calls on that resource', async () => {
  const activity = createLocalModelActivity();
  const held = () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const model = activity.track('local', {
      async complete(_request: { signal?: AbortSignal }) { entered(); await gate; return { text: '', modelId: 'm' }; },
    });
    return { model, release, started };
  };
  const background = held();
  const backgroundCall = runBackgroundInference(() => background.model.complete({}));
  await background.started;
  expect(activity.busy('local')).toBe(true);
  expect(activity.ownerInFlight('local')).toBe(false);
  background.release();
  await backgroundCall;
  const owner = held();
  const ownerCall = owner.model.complete({});
  await owner.started;
  expect(activity.ownerInFlight('local')).toBe(true);
  expect(activity.ownerInFlight('other')).toBe(false);
  owner.release();
  await ownerCall;
  expect(activity.ownerInFlight('local')).toBe(false);
  expect(await runClassificationInference(() => activity.run('local', async () => activity.ownerInFlight('local')))).toBe(false);
  expect(await activity.run('local', async () => activity.ownerInFlight('local'))).toBe(true);
});

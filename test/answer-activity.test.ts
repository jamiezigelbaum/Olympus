import { describe, expect, test } from 'bun:test';
import { createAnswerActivity } from '../src/workers/answer-activity.ts';

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

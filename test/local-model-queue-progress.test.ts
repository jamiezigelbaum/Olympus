// 1.5 test-mac canary, 24 Nov 2026: private answers queued behind judge calls
// on the one local model slot saw no model progress and were stopped at their
// no-progress deadline. A queued call now counts the running call's output as
// progress, and once it runs its own output reaches its own clocks only.
import { expect, test } from 'bun:test';
import { noteModelProgress, withModelProgress } from '../src/core/model-stream.ts';
import { createLocalModelActivity } from '../src/workers/answer-activity.ts';
import type { AnalystModel, AnalystModelRequest } from '../src/core/analyst.ts';

test('a queued call sees the running call\'s progress, then only its own', async () => {
  const activity = createLocalModelActivity();
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const model = activity.track('slot', {
    complete: async (request: AnalystModelRequest) => {
      if (request.prompt === 'first') {
        firstStarted();
        await firstGate;
        noteModelProgress('first-model');
        return { text: 'one', modelId: 'm' };
      }
      noteModelProgress('second-model');
      return { text: 'two', modelId: 'm' };
    },
  } as unknown as AnalystModel);
  const firstSeen: string[] = [];
  const secondSeen: string[] = [];
  const first = withModelProgress((name) => firstSeen.push(name), () => model.complete({ system: 's', prompt: 'first', localOnly: true }));
  await started;
  const second = withModelProgress((name) => secondSeen.push(name), () => model.complete({ system: 's', prompt: 'second', localOnly: true }));
  // Let the second call reach the queue (its dispatch pumps on a microtask).
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  releaseFirst();
  await Promise.all([first, second]);
  expect(firstSeen).toEqual(['first-model']);
  expect(secondSeen).toEqual(['first-model', 'second-model']);
});

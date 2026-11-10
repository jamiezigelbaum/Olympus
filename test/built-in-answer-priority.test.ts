import { expect, test } from 'bun:test';
import { createLocalModelActivity, runClassificationInference } from '../src/workers/answer-activity.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';

// #1033: on a fresh 4-core Linux install the privacy judge ran on the
// built-in model non-stop, 30-100 s per call. An answer that arrived during a
// judge call waited for that call to finish before its own call started, and
// timed out at the client's 120 s. The answer now preempts as soon as it is
// queued: the judge call in flight is cancelled, the answer's call starts
// next, and judging resumes once the answer is done.
test('an answer arriving during a judge pass gets the built-in model before the next judge call', async () => {
  const clock = createTestClock();
  const t0 = clock.now();
  const activity = createLocalModelActivity();
  const starts: Array<{ call: string; at: number }> = [];
  const ends: Array<{ call: string; at: number; aborted: boolean }> = [];
  const JUDGE_MS = 60_000;
  const ANSWER_MS = 30_000;

  // The one built-in model: a call holds it for its duration unless cancelled.
  const builtIn = {
    async complete(request: { system: string; prompt: string; localOnly: boolean; signal?: AbortSignal }) {
      starts.push({ call: request.prompt, at: clock.now() - t0 });
      await new Promise<void>((resolve, reject) => {
        const timer = clock.setTimeout(() => { ends.push({ call: request.prompt, at: clock.now() - t0, aborted: false }); resolve(); },
          request.prompt.startsWith('judge') ? JUDGE_MS : ANSWER_MS);
        request.signal?.addEventListener('abort', () => {
          clock.clearTimeout(timer);
          ends.push({ call: request.prompt, at: clock.now() - t0, aborted: true });
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        }, { once: true });
      });
      return { text: '{}', modelId: 'built_in/fake' };
    },
  };

  // Wired as the worker wires them: answers through the tracked answer model,
  // the judge as classification inference tagged tier_sniffer.
  const answerModel = activity.track('built_in', builtIn);
  const judgeModel = activity.track('built_in', builtIn, { tag: 'tier_sniffer' });

  // A minimal judge: one call per item in a pass; preempt aborts the pass,
  // wake starts a new one over the items still waiting.
  const waiting = ['judge-1', 'judge-2', 'judge-3'];
  let pass: AbortController | undefined;
  const runPass = async (): Promise<void> => {
    const abort = new AbortController();
    pass = abort;
    try {
      while (waiting.length > 0 && !abort.signal.aborted) {
        try {
          await runClassificationInference(() => judgeModel.complete({ system: '', prompt: waiting[0]!, localOnly: true, signal: abort.signal }));
          waiting.shift();
        } catch {
          if (!abort.signal.aborted) throw new Error('judge call failed');
        }
      }
    } finally {
      if (pass === abort) pass = undefined;
    }
  };
  const wake = () => { if (!pass) void runPass(); };
  activity.onBusy('built_in', () => pass?.abort());
  activity.onIdle('built_in', wake);

  wake();
  await flushMicrotasks();
  expect(starts).toEqual([{ call: 'judge-1', at: 0 }]);

  await clock.advance(10_000);
  const answer = answerModel.complete({ system: '', prompt: 'answer', localOnly: true });
  await flushMicrotasks();

  // The judge call in flight is cancelled and the answer starts at once.
  expect(ends).toEqual([{ call: 'judge-1', at: 10_000, aborted: true }]);
  expect(starts.at(-1)).toEqual({ call: 'answer', at: 10_000 });

  await clock.advance(ANSWER_MS);
  await answer;
  await flushMicrotasks();
  // The answer finished well inside 60 s of arriving, and judging resumed
  // right after it, starting again with the item it had been cut off on.
  expect(ends.find(end => end.call === 'answer')).toEqual({ call: 'answer', at: 40_000, aborted: false });
  expect(starts.map(start => start.call)).toEqual(['judge-1', 'answer', 'judge-1']);
  expect(starts.at(-1)!.at).toBe(40_000);

  await clock.advance(3 * JUDGE_MS);
  await flushMicrotasks();
  expect(waiting).toEqual([]);
  expect(starts.map(start => start.call)).toEqual(['judge-1', 'answer', 'judge-1', 'judge-2', 'judge-3']);
});

test('a second answer call (the audit) also goes ahead of a judge pass that resumed between the calls', async () => {
  const clock = createTestClock();
  const t0 = clock.now();
  const activity = createLocalModelActivity();
  const starts: string[] = [];
  let judgeAborts = 0;
  const builtIn = {
    async complete(request: { system: string; prompt: string; localOnly: boolean; signal?: AbortSignal }) {
      starts.push(`${request.prompt}@${clock.now() - t0}`);
      await new Promise<void>((resolve, reject) => {
        const timer = clock.setTimeout(() => { resolve(); }, request.prompt.startsWith('judge') ? 60_000 : 20_000);
        request.signal?.addEventListener('abort', () => {
          clock.clearTimeout(timer);
          judgeAborts += 1;
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        }, { once: true });
      });
      return { text: '{}', modelId: 'built_in/fake' };
    },
  };
  const answerModel = activity.track('built_in', builtIn);
  const judgeModel = activity.track('built_in', builtIn, { tag: 'tier_sniffer' });
  let pass: AbortController | undefined;
  activity.onBusy('built_in', () => pass?.abort());

  // The draft runs alone.
  const drafted = answerModel.complete({ system: '', prompt: 'draft', localOnly: true });
  await flushMicrotasks();
  await clock.advance(20_000);
  await drafted;
  // Between the draft and the audit a judge pass grabs the idle model.
  pass = new AbortController();
  const judging = runClassificationInference(() => judgeModel.complete({ system: '', prompt: 'judge-1', localOnly: true, signal: pass!.signal }))
    .catch(() => 'aborted');
  await flushMicrotasks();
  await clock.advance(1_000);
  const audit = answerModel.complete({ system: '', prompt: 'audit', localOnly: true });
  await flushMicrotasks();
  expect(judgeAborts).toBe(1);
  expect(await judging).toBe('aborted');
  expect(starts.at(-1)).toBe('audit@21000');
  await clock.advance(20_000);
  await audit;
});

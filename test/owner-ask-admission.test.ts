import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { holdOwnerAsk, ownerAskHeld } from '../src/core/owner-ask-admission.ts';
import { sharedDataPath } from '../src/core/olympus-layout.ts';
import { withFileLease } from '../src/core/file-lease.ts';
import { ownerAskReason } from '../src/workers/engine/stand-back.ts';
import { tempDir } from './helpers/tier-fixtures.ts';
import { waitFor } from './helpers/test-clock.ts';

test('an owner question signals across processes with no command delivery and the kernel releases it on death', async () => {
  const tmp = tempDir('olympus-owner-ask-');
  const env = { ...process.env, HOME: tmp.dir, XDG_DATA_HOME: tmp.dir };
  const lanes = join(import.meta.dir, '../src/workers/engine/runtime/source-answer-lanes.ts');
  const admission = join(import.meta.dir, '../src/core/owner-ask-admission.ts');
  expect(ownerAskHeld(env)).toBe(false);
  const child = Bun.spawn([process.execPath, '--eval', `
    import { createOwnerQuestionActivity } from ${JSON.stringify(lanes)};
    import { ownerAskHeld } from ${JSON.stringify(admission)};
    const questions = createOwnerQuestionActivity({ busy() {}, idle() {} });
    await questions.run(async () => {
      questions.retrieving();
      if (questions.busy || ownerAskHeld()) throw new Error('background answer took the owner lease');
    }, 'background');
    questions.retrieving();
    if (questions.busy || ownerAskHeld()) throw new Error('probe took the owner lease');
    await questions.run(async () => {
      questions.retrieving();
      const release = questions.begin();
      release();
      await Bun.stdin.text();
    });
  `], { env, stdin: 'pipe', stdout: 'ignore', stderr: 'inherit' });
  try {
    await waitFor(() => ownerAskHeld(env), { description: 'the child owner question acquired the shared lease' });
    expect(ownerAskReason({ busy: false }, () => ownerAskHeld(env))).toBe('question in the front');
    const overlap = await holdOwnerAsk(env);
    try {
      child.kill('SIGKILL');
      await child.exited;
      expect(ownerAskHeld(env)).toBe(true);
    } finally {
      overlap();
    }
    expect(ownerAskHeld(env)).toBe(false);
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    tmp.cleanup();
  }
}, 15_000);

test('an unusable lock file leaves the Ask and its command signal intact, and probing is safe', async () => {
  const tmp = tempDir('olympus-owner-ask-broken-');
  const env = { ...process.env, HOME: tmp.dir, XDG_DATA_HOME: tmp.dir };
  mkdirSync(join(sharedDataPath('engine-run', env), 'owner-ask.lock.db'), { recursive: true });
  const lanes = join(import.meta.dir, '../src/workers/engine/runtime/source-answer-lanes.ts');
  const admission = join(import.meta.dir, '../src/core/owner-ask-admission.ts');
  const clock = join(import.meta.dir, 'helpers/test-clock.ts');
  const child = Bun.spawn([process.execPath, '--eval', `
    import { createOwnerQuestionActivity } from ${JSON.stringify(lanes)};
    import { createOwnerAskProbe } from ${JSON.stringify(admission)};
    import { waitFor } from ${JSON.stringify(clock)};
    const commands = [];
    const questions = createOwnerQuestionActivity({
      busy: resource => commands.push(['busy', resource]),
      idle: resource => commands.push(['idle', resource]),
    });
    const result = await questions.run(async () => {
      questions.retrieving();
      if (!questions.busy || commands[0]?.join(':') !== 'busy:owner_question') throw new Error('missing busy command');
      await waitFor(() => questions.leaseFailures === 1, { description: 'failed lease counted' });
      return 'answer';
    });
    if (result !== 'answer' || questions.busy || commands[1]?.join(':') !== 'idle:owner_question') {
      throw new Error('Ask did not return and release activity');
    }
    let failures = 0;
    const probe = createOwnerAskProbe({ onFailure: () => failures++ });
    if (probe() || failures !== 1) throw new Error('broken lock probe must fail open and count the failure');
  `], { env, stdout: 'ignore', stderr: 'pipe' });
  try {
    const [exit, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exit, errors }).toEqual({ exit: 0, errors: '' });
  } finally {
    child.kill();
    await child.exited;
    tmp.cleanup();
  }
}, 25_000);

test('an exclusive holder cannot block the front event loop or delay a busy command', async () => {
  const tmp = tempDir('olympus-owner-ask-contended-');
  const env = { ...process.env, HOME: tmp.dir, XDG_DATA_HOME: tmp.dir };
  const lanes = join(import.meta.dir, '../src/workers/engine/runtime/source-answer-lanes.ts');
  try {
    await withFileLease(join(sharedDataPath('engine-run', env), 'owner-ask'), async () => {
      const child = Bun.spawn([process.execPath, '--eval', `
        import { createOwnerQuestionActivity } from ${JSON.stringify(lanes)};
        const commands = [];
        const questions = createOwnerQuestionActivity({ busy: () => commands.push('busy'), idle: () => commands.push('idle') });
        await questions.run(async () => {
          questions.retrieving();
          await new Promise(resolve => setImmediate(resolve));
          if (commands.join() !== 'busy' || !questions.busy) throw new Error('missing activity');
        });
        if (commands.join() !== 'busy,idle') throw new Error('missing idle');
      `], { env, stdout: 'ignore', stderr: 'pipe' });
      try {
        await waitFor(() => child.exitCode !== null, { timeoutMs: 5_000, description: 'front returned while the lock was still held' });
        expect({ exit: await child.exited, errors: await new Response(child.stderr).text() }).toEqual({ exit: 0, errors: '' });
      } finally { child.kill(); await child.exited; }
    });
  } finally { tmp.cleanup(); }
}, 15_000);

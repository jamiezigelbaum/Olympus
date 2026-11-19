import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { holdOwnerAsk, ownerAskHeld } from '../src/core/owner-ask-admission.ts';
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
    const overlap = holdOwnerAsk(env);
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

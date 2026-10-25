// The answer-quality judge: any verify-style command, exit 0 no flags, 2 flags, anything else unavailable. A flag must carry what
// the judge said, the expectation and the answer, so the warning can be read where the report shows it.

import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandJudge, judgeCheck } from '../scripts/release-check/judge.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fakeJudge(script: string): string {
  const root = mkdtempSync(join(tmpdir(), 'rc-judge-'));
  roots.push(root);
  const file = join(root, 'judge');
  writeFileSync(file, `#!/bin/bash\n${script}\n`);
  chmodSync(file, 0o755);
  return file;
}

const read = { expectation: 'The newsletter says the plant swap is on Saturday.', answer: 'The plant swap is on Sunday [E1].' };

describe('release check: answer-quality judge', () => {
  test('a flag keeps what the judge printed, and the check shows it with the expectation and the answer', async () => {
    const judge = commandJudge([fakeJudge('echo "check 1 first"; echo "CHECK 1. [contradicted 0.91] the plant swap is on Saturday"; exit 2')]);
    const result = await judge.judge({ criteria: read.expectation, evidence: read.answer });
    expect(result).toEqual({ verdict: 'flagged', said: 'check 1 first CHECK 1. [contradicted 0.91] the plant swap is on Saturday' });
    const check = judgeCheck('personal-fact.quality', 'personal-fact: quality', result, read);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('The judge said: check 1 first CHECK 1. [contradicted 0.91]');
    expect(check.detail).toContain(`Expected: ${read.expectation}`);
    expect(check.detail).toContain(`Answer: "${read.answer}"`);
  });

  test('no flags passes, a failing or missing command is a skip, and a flag with nothing printed says so', async () => {
    expect(judgeCheck('q.quality', 'q', await commandJudge([fakeJudge('echo "no flags"; exit 0')]).judge({ criteria: 'x', evidence: 'y' }), read).status).toBe('pass');
    expect(judgeCheck('q.quality', 'q', await commandJudge([fakeJudge('exit 1')]).judge({ criteria: 'x', evidence: 'y' }), read).status).toBe('skip');
    expect(judgeCheck('q.quality', 'q', await commandJudge([join(tmpdir(), 'no-such-judge')]).judge({ criteria: 'x', evidence: 'y' }), read).status).toBe('skip');
    const silent = await commandJudge([fakeJudge('exit 2')]).judge({ criteria: 'x', evidence: 'y' });
    expect(silent).toEqual({ verdict: 'flagged' });
    expect(judgeCheck('q.quality', 'q', silent, read).detail).toContain('The judge gave no reason.');
  });

  test('a long answer is cut, never the whole transcript', () => {
    const check = judgeCheck('q.quality', 'q', { verdict: 'flagged', said: 'CHECK 1.' }, { expectation: read.expectation, answer: 'word '.repeat(1_000) });
    expect(check.detail!.length).toBeLessThan(1_400);
    expect(check.detail).toContain('…"');
  });
});

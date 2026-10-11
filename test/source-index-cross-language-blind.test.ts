import {expect, test} from 'bun:test';

test('frozen cross-language blind set improves retrieval without losing baseline hits or gap honesty', () => {
  const result = Bun.spawnSync([process.execPath,'eval/cross-language-keywords.ts','--replay'],{cwd:process.cwd(),stdout:'pipe',stderr:'pipe'});
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!);
  expect(report.answerable).toBe(26);
  expect(report.gapCases).toBe(6);
  expect(report.gapHonest).toBe(6);
  expect(report.missingCompletions).toBe(0);
  expect(report.expanded).toBeGreaterThan(report.baseline);
  expect(report.results.filter((row:{before:boolean;after:boolean})=>row.before&&!row.after)).toHaveLength(0);
},10_000);

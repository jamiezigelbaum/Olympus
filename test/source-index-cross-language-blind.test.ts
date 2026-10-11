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
  // These are the shipped feature's hits in the independently authored frozen
  // fixture, not just the three hits from disabling every expansion.
  const shippedHits = [1,5,7,8,10,11,13,14,17,20,22,23,24,25];
  for (const ordinal of shippedHits) {
    expect(report.results[ordinal].after).toBe(true);
    expect(report.results[ordinal].passage).toBe(true);
  }
  for (const ordinal of [3,9]) {
    expect(report.results[ordinal].after).toBe(true);
    expect(report.results[ordinal].passage).toBe(true);
  }
  expect(report.expandedGapReads).toBe(1);
  expect(report.results.filter((row:{before:boolean;after:boolean})=>row.before&&!row.after)).toHaveLength(0);
},10_000);

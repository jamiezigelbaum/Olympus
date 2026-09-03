// The three lanes must partition the suite exactly, and none may be empty.
//
// The lane split is only safe while every test file lands in exactly one lane.
// The failure worth guarding is the silent one: a file that reaches neither
// lane never runs again, and nothing says so — `bun run verify` would report a
// pass over a suite quietly missing tests. That is the same shape as the
// toolchain guards this repo just fixed, where a missing binary skipped and the
// suite still said pass.
//
// Membership itself needs no guard: it is derived from the file's own source on
// every run, so it cannot go stale. What needs guarding is the partition.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildTestLaneCommand,
  parseTestLaneArgs,
  planWeightedShards,
} from '../scripts/test-lane.ts';
import { partitionTestLanes, testFilesIn, testLaneFor } from './helpers/test-lanes.ts';

const TEST_DIR = import.meta.dir;

describe('test lane partition', () => {
  test('every test file lands in exactly one lane', () => {
    const all = testFilesIn(TEST_DIR);
    const { fast, deploy, go } = partitionTestLanes(TEST_DIR);
    expect(fast.length + deploy.length + go.length).toBe(all.length);
    const overlap = [...fast, ...deploy, ...go]
      .filter((name, index, lanes) => lanes.indexOf(name) !== index);
    expect(overlap, `These files are in more than one lane: ${overlap.join(', ')}`).toEqual([]);
    const missing = all.filter((name) => !fast.includes(name) && !deploy.includes(name) && !go.includes(name));
    expect(missing, `These files are in NEITHER lane and would stop running: ${missing.join(', ')}`)
      .toEqual([]);
  });

  test('neither lane is empty, so an empty run cannot read as a pass', () => {
    const { fast, deploy, go } = partitionTestLanes(TEST_DIR);
    expect(fast.length).toBeGreaterThan(0);
    expect(deploy.length).toBeGreaterThan(0);
    expect(go.length).toBeGreaterThan(0);
  });

  test('the rule is what it says: spawning decides the lane', () => {
    expect(testLaneFor('const x = 1;')).toBe('fast');
    expect(testLaneFor("Bun.spawnSync(['ls']);")).toBe('deploy');
    expect(testLaneFor("execFileSync('shellcheck', [f]);")).toBe('deploy');
    expect(testLaneFor("import { spawnSync } from 'node:child_process';")).toBe('deploy');
  });

  test('Go routing is co-located and fails closed', () => {
    const invocation = "const go = optionalToolchain('go'); Bun.spawnSync([go, 'test']);";
    expect(testLaneFor(`// OLYMPUS_TEST_LANE: go\n${invocation}`)).toBe('go');
    expect(() => testLaneFor(invocation)).toThrow(/must declare/);
    expect(() => testLaneFor('// OLYMPUS_TEST_LANE: go\nconst x = 1;')).toThrow(/no detected/);
    expect(() => testLaneFor('// OLYMPUS_TEST_LANE: rust\nconst x = 1;')).toThrow(/Unsupported/);
  });

  test('this guard runs in the fast lane, since it is the gate it protects', () => {
    // It reads files; it does not spawn. Keep the partition's own guard in the
    // fast lane so focused structural checks remain cheap.
    const { fast } = partitionTestLanes(TEST_DIR);
    expect(fast).toContain('deploy-lane-partition.test.ts');
  });

  test('the deploy lane really is where the wall-clock budgets live', () => {
    // The measured premise of the whole split, kept as an assertion rather than
    // a claim in a commit message. When the lane was drawn, 77 of the 80
    // spawning files also carried a per-test timeout of 10s or more. If that
    // overlap ever collapsed, "spawns a subprocess" would have stopped
    // selecting the tests that false-fail under load, and the RULE would need
    // rethinking — not the lanes rebalancing.
    const LONG_BUDGET = /^\s*\}, ([1-9][0-9]{4,}|[1-9][0-9]?_[0-9]{3})\);/m;
    const { fast, deploy } = partitionTestLanes(TEST_DIR);
    const budgeted = (names: readonly string[]) => names
      .filter((name) => LONG_BUDGET.test(readFileSync(join(TEST_DIR, name), 'utf8'))).length;
    const inDeploy = budgeted(deploy);
    const inFast = budgeted(fast);
    expect(inDeploy + inFast).toBeGreaterThan(0);
    // Private-ops test deletion removes many long subprocess suites from the
    // deploy numerator. The remaining product tree must still keep a strict
    // two-thirds majority of explicit long budgets in the deploy lane.
    expect(inDeploy / (inDeploy + inFast)).toBeGreaterThan(2 / 3);
  });

  test('the lane runner accepts a deterministic shard', () => {
    expect(parseTestLaneArgs(['deploy', '--shard=2/6'])).toEqual({
      lane: 'deploy',
      shard: { index: 2, total: 6 },
    });
    expect(buildTestLaneCommand(['one.test.ts', 'two.test.ts'])).toEqual([
      'bun',
      'test',
      join('test', 'one.test.ts'),
      join('test', 'two.test.ts'),
    ]);
    expect(parseTestLaneArgs(['go'])).toEqual({ lane: 'go' });
  });

  test('measured LPT placement is deterministic, balanced, and exactly once', () => {
    const key = (file: string) => createHash('sha256').update(file).digest('hex');
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'new.test.ts'];
    const plan = planWeightedShards(files, 2, {
      schemaVersion: 1,
      unknownP95Ms: 25,
      deployMs: {
        [key('a.test.ts')]: 40,
        [key('b.test.ts')]: 30,
        [key('c.test.ts')]: 10,
      },
    });
    expect(plan.shards).toEqual([
      ['a.test.ts', 'c.test.ts'],
      ['b.test.ts', 'new.test.ts'],
    ]);
    expect(plan.weightsMs).toEqual([50, 55]);
    expect(plan.shards.flat().sort()).toEqual(files.sort());
    expect(plan.unknownFiles).toEqual(['new.test.ts']);
  });

  test('the checked timing map is hash-keyed and still places every deploy file once', () => {
    const timing = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'config/test-timings.json'), 'utf8'),
    );
    expect(Object.keys(timing.deployMs).every((key) => /^[a-f0-9]{64}$/.test(key))).toBe(true);
    const { deploy, go } = partitionTestLanes(TEST_DIR);
    const plan = planWeightedShards(deploy, 3, timing);
    expect(plan.shards.flat().sort()).toEqual([...deploy].sort());
    expect(plan.weightsMs).toHaveLength(3);
    expect(Math.max(...plan.weightsMs) - Math.min(...plan.weightsMs))
      .toBeLessThan(timing.unknownP95Ms);
    expect(go).toEqual(['whatsapp-bridge-go.test.ts']);
    const goKey = createHash('sha256').update(go[0]!).digest('hex');
    expect(timing.deployMs[goKey]).toBeUndefined();
  });

  test('the lane runner rejects invalid or ambiguous shards', () => {
    expect(() => parseTestLaneArgs(['deploy', '--shard=0/6'])).toThrow();
    expect(() => parseTestLaneArgs(['deploy', '--shard=7/6'])).toThrow();
    expect(() => parseTestLaneArgs(['deploy', '--shard=2'])).toThrow();
    expect(() => parseTestLaneArgs(['deploy', '--unknown'])).toThrow();
  });
});

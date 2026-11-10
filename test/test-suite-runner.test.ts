import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEPLOY_SHARDS,
  SUITE_LANES,
  parseSuiteArgs,
  planSuite,
  runSuite,
  type SuiteStep,
} from '../scripts/test-suite.ts';

const ROOT = join(import.meta.dir, '..');

describe('full-suite runner (bun run test, verify:full)', () => {
  test('runs every CI lane as CI runs it, never one bun test over the tree', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.test).toBe('bun run build && bun scripts/test-suite.ts');

    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'verify.yml'), 'utf8');
    const deployShards = /name: deploy tests[\s\S]*?shard: \[([0-9, ]+)\]/.exec(workflow)?.[1];
    expect(deployShards?.split(',').map((value) => Number(value.trim()))).toEqual(
      Array.from({ length: DEPLOY_SHARDS }, (_, index) => index + 1),
    );

    const steps = planSuite();
    expect(steps.map((step) => step.name)).toEqual([
      'fast',
      'connect-relay',
      'exchange',
      'calibration',
      ...Array.from({ length: DEPLOY_SHARDS }, (_, index) => `deploy ${index + 1}/${DEPLOY_SHARDS}`),
      'go',
    ]);
    const commands = steps.map((step) => step.command.join(' '));
    expect(commands).toContain('bun scripts/test-lane.ts fast');
    expect(commands).toContain('bun run test:connect-relay');
    expect(commands).toContain('bun run test:exchange');
    expect(commands).toContain('bun run test:calibration');
    expect(commands).toContain('bun scripts/test-lane.ts go');
    for (const command of commands) {
      // CI shards the fast lane across jobs; one machine runs it whole through the per-file pool.
      if (command.endsWith(' fast')) expect(workflow).toContain(`${command} --shard=\${{ matrix.shard }}/3`);
      else if (command.includes(' deploy ')) {
        expect(workflow).toContain(command.replace(/--shard=\d+\//, '--shard=${{ matrix.shard }}/'));
      } else expect(workflow).toContain(`run: ${command}`);
      expect(command).not.toMatch(/^bun test\b/);
    }
  });

  test('--lanes selects lanes in suite order and rejects unknown ones', () => {
    expect(parseSuiteArgs([])).toEqual({ lanes: [...SUITE_LANES], dryRun: false });
    expect(parseSuiteArgs(['--lanes=go,exchange', '--dry-run'])).toEqual({ lanes: ['exchange', 'go'], dryRun: true });
    expect(planSuite(['go']).map((step) => step.name)).toEqual(['go']);
    expect(() => parseSuiteArgs(['--lanes=fast,slow'])).toThrow('Unknown lane "slow"');
    expect(() => parseSuiteArgs(['fast'])).toThrow('usage:');
  });

  test('every step runs after a failure, and any failure fails the run', async () => {
    const ran: string[] = [];
    const lines: string[] = [];
    const exits: Record<string, number> = { fast: 0, exchange: 1 };
    const { code, results } = await runSuite(planSuite(['fast', 'exchange', 'go']), async (step: SuiteStep) => {
      ran.push(step.name);
      if (step.name === 'go') throw new Error('runner unavailable');
      return exits[step.name]!;
    }, (line) => lines.push(line));
    expect(ran).toEqual(['fast', 'exchange', 'go']);
    expect(code).toBe(1);
    expect(results.map((result) => result.exitCode)).toEqual([0, 1, 1]);
    expect(lines.at(-1)).toBe('[test-suite] 2 of 3 steps failed: exchange, go');
  });

  test('passes only when every step passed, and refuses an empty plan', async () => {
    const silent = () => {};
    expect((await runSuite(planSuite(['fast', 'go']), async () => 0, silent)).code).toBe(0);
    expect((await runSuite([], async () => 0, silent)).code).toBe(1);
  });
});

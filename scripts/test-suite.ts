/**
 * The whole test suite on one machine, run the way CI runs it.
 *
 *   bun scripts/test-suite.ts                  # every lane
 *   bun scripts/test-suite.ts --lanes=go,exchange
 *   bun scripts/test-suite.ts --dry-run        # print the plan, run nothing
 *
 * `bun run test` (and so `verify:full`) builds once and then calls this. It
 * used to be one `bun test` over the whole tree: every file shared one
 * process, ~124 tests failed from state another file left behind, and the
 * 1.4.0 release run hung until it was cancelled (#1018). CI never ran the
 * suite that way, so those failures said nothing about the code.
 *
 * Each step here is the command a CI job runs (.github/workflows/verify.yml):
 * the fast lane with one process per file (test-lane-pool.ts, TEST_LANE_WORKERS
 * at a time), connect-relay, exchange, the eval/calibration tests, the deploy lane as CI's four shards
 * (each its own serial `bun test`, so files share a process only with the
 * files they share one with in CI), and the Go lane, whose test skips without
 * a Go toolchain unless OLYMPUS_REQUIRE_TOOLCHAINS=1 (test/helpers/
 * required-toolchain.ts). Steps run one after another: the fast pool already
 * fills a small machine, and the deploy tests spawn processes against
 * wall-clock budgets that false-fail under contention. Every step runs even
 * after one fails, and the run exits 1 if any did.
 */
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

/** CI's deploy matrix (verify.yml `shard: [1, 2, 3, 4]`); a test pins the match. */
export const DEPLOY_SHARDS = 4;

export const SUITE_LANES = ['fast', 'connect-relay', 'exchange', 'calibration', 'deploy', 'go'] as const;
export type SuiteLane = (typeof SUITE_LANES)[number];

export interface SuiteStep {
  lane: SuiteLane;
  name: string;
  command: string[];
}

export interface SuiteOptions {
  lanes: SuiteLane[];
  dryRun: boolean;
}

export function parseSuiteArgs(args: readonly string[]): SuiteOptions {
  let lanes: SuiteLane[] = [...SUITE_LANES];
  let dryRun = false;
  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    const match = /^--lanes=(.+)$/.exec(arg);
    if (!match) {
      throw new Error(`usage: bun scripts/test-suite.ts [--lanes=${SUITE_LANES.join(',')}] [--dry-run]`);
    }
    const requested = match[1]!.split(',');
    for (const lane of requested) {
      if (!(SUITE_LANES as readonly string[]).includes(lane)) {
        throw new Error(`Unknown lane ${JSON.stringify(lane)}; lanes are ${SUITE_LANES.join(', ')}.`);
      }
    }
    lanes = SUITE_LANES.filter((lane) => requested.includes(lane));
  }
  return { lanes, dryRun };
}

export function planSuite(lanes: readonly SuiteLane[] = SUITE_LANES): SuiteStep[] {
  const steps: SuiteStep[] = [];
  for (const lane of SUITE_LANES) {
    if (!lanes.includes(lane)) continue;
    if (lane === 'fast') steps.push({ lane, name: 'fast', command: ['bun', 'scripts/test-lane.ts', 'fast'] });
    if (lane === 'connect-relay') steps.push({ lane, name: 'connect-relay', command: ['bun', 'run', 'test:connect-relay'] });
    if (lane === 'exchange') steps.push({ lane, name: 'exchange', command: ['bun', 'run', 'test:exchange'] });
    // eval/calibration holds the privacy-judge scoring tests; test-lane.ts only reads test/.
    if (lane === 'calibration') steps.push({ lane, name: 'calibration', command: ['bun', 'run', 'test:calibration'] });
    if (lane === 'deploy') {
      for (let shard = 1; shard <= DEPLOY_SHARDS; shard += 1) {
        steps.push({
          lane,
          name: `deploy ${shard}/${DEPLOY_SHARDS}`,
          command: ['bun', 'scripts/test-lane.ts', 'deploy', `--shard=${shard}/${DEPLOY_SHARDS}`],
        });
      }
    }
    if (lane === 'go') steps.push({ lane, name: 'go', command: ['bun', 'scripts/test-lane.ts', 'go'] });
  }
  return steps;
}

export interface StepResult {
  step: SuiteStep;
  exitCode: number;
  seconds: number;
}

export type StepRunner = (step: SuiteStep) => Promise<number>;

const spawnStep: StepRunner = async (step) => {
  // One JUnit path would be overwritten by every step; CI sets it per job.
  const { OLYMPUS_JUNIT_PATH: _junit, ...env } = process.env;
  const child = Bun.spawn(step.command, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit', env });
  await child.exited;
  return child.signalCode ? 1 : child.exitCode ?? 1;
};

export async function runSuite(
  steps: readonly SuiteStep[],
  run: StepRunner = spawnStep,
  log: (line: string) => void = console.log,
): Promise<{ code: number; results: StepResult[] }> {
  if (steps.length === 0) {
    log('[test-suite] no steps selected. Refusing to report a pass.');
    return { code: 1, results: [] };
  }
  const results: StepResult[] = [];
  for (const [index, step] of steps.entries()) {
    log(`[test-suite] ${index + 1}/${steps.length} ${step.name}: ${step.command.join(' ')}`);
    const begin = Date.now();
    let exitCode: number;
    try {
      exitCode = await run(step);
    } catch (error) {
      log(`[test-suite] ${step.name} could not run: ${error instanceof Error ? error.message : String(error)}`);
      exitCode = 1;
    }
    results.push({ step, exitCode, seconds: Math.round((Date.now() - begin) / 1000) });
  }
  log('[test-suite] summary:');
  for (const result of results) {
    log(`[test-suite]   ${result.exitCode === 0 ? 'ok  ' : 'FAIL'} ${result.step.name} (exit ${result.exitCode}, ${result.seconds}s)`);
  }
  const failed = results.filter((result) => result.exitCode !== 0);
  log(failed.length === 0
    ? `[test-suite] all ${results.length} steps passed`
    : `[test-suite] ${failed.length} of ${results.length} steps failed: ${failed.map((result) => result.step.name).join(', ')}`);
  return { code: failed.length === 0 ? 0 : 1, results };
}

if (import.meta.main) {
  let options: SuiteOptions;
  try {
    options = parseSuiteArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const steps = planSuite(options.lanes);
  if (options.dryRun) {
    for (const step of steps) console.log(`${step.name}: ${step.command.join(' ')}`);
    process.exit(0);
  }
  process.exit((await runSuite(steps)).code);
}

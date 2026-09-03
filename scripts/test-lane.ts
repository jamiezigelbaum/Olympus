/**
 * Run one deterministic lane of the test suite, optionally as a CI shard.
 *
 *   bun scripts/test-lane.ts fast
 *   bun scripts/test-lane.ts deploy --shard=2/3
 *   bun scripts/test-lane.ts go
 *
 * Lane membership is derived from each file's source on every run (see
 * test/helpers/test-lanes.ts), so there is no list to maintain. Deploy files
 * are assigned with deterministic longest-processing-time placement using a
 * hash-keyed timing map from a trusted GitHub run. Unknown files receive a
 * conservative p95. Timeout budgets are never treated as runtime weights.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { partitionTestLanes } from '../test/helpers/test-lanes.ts';

const ROOT = join(import.meta.dir, '..');
const TEST_DIR = join(ROOT, 'test');

export type TestLane = 'fast' | 'deploy' | 'go';

export interface TestLaneOptions {
  lane: TestLane;
  shard?: { index: number; total: number };
}

export interface TestTimingConfig {
  schemaVersion: 1;
  unknownP95Ms: number;
  deployMs: Record<string, number>;
}

export interface ShardPlan {
  shards: string[][];
  weightsMs: number[];
  unknownFiles: string[];
}

export function parseTestLaneArgs(args: string[]): TestLaneOptions {
  const [lane, ...rest] = args;
  if (lane !== 'fast' && lane !== 'deploy' && lane !== 'go') {
    throw new Error('usage: bun scripts/test-lane.ts <fast|deploy|go> [--shard=N/T]');
  }

  if (rest.length === 0) return { lane };
  if (rest.length !== 1) {
    throw new Error('Only one optional --shard=N/T argument is supported.');
  }

  const match = /^--shard=(\d+)\/(\d+)$/.exec(rest[0]!);
  if (!match) throw new Error('Shard must use --shard=N/T.');

  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index < 1 || total < 1 || index > total) {
    throw new Error('Shard numbers must be positive and N must be no greater than T.');
  }

  return { lane, shard: { index, total } };
}

export function buildTestLaneCommand(selected: string[], junitPath?: string): string[] {
  const command = ['bun', 'test', ...selected.map((name) => join('test', name))];
  if (junitPath) command.push('--reporter=junit', `--reporter-outfile=${junitPath}`);
  return command;
}

export function planWeightedShards(
  files: readonly string[],
  total: number,
  timing: TestTimingConfig,
): ShardPlan {
  if (timing.schemaVersion !== 1 || timing.unknownP95Ms <= 0) {
    throw new Error('Invalid test timing configuration.');
  }
  const shards = Array.from({ length: total }, () => [] as string[]);
  const weightsMs = Array.from({ length: total }, () => 0);
  const unknownFiles: string[] = [];
  const weighted = files.map((file) => {
    const measured = timing.deployMs[fileKey(file)];
    if (measured === undefined) unknownFiles.push(file);
    return { file, weight: measured ?? timing.unknownP95Ms };
  }).sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));

  for (const item of weighted) {
    let target = 0;
    for (let index = 1; index < total; index += 1) {
      if (weightsMs[index]! < weightsMs[target]!) target = index;
    }
    shards[target]!.push(item.file);
    weightsMs[target]! += item.weight;
  }

  const placed = shards.flat();
  if (placed.length !== files.length || new Set(placed).size !== files.length) {
    throw new Error('Weighted shard plan violated the exactly-once invariant.');
  }
  return { shards, weightsMs, unknownFiles: unknownFiles.sort() };
}

export function runTestLane(args: string[]): number {
  let options: TestLaneOptions;
  try {
    options = parseTestLaneArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const lanes = partitionTestLanes(TEST_DIR);
  if (options.lane === 'go' && options.shard) {
    console.error('The dedicated Go lane is not sharded.');
    return 2;
  }
  let selected = lanes[options.lane];
  const total = lanes.fast.length + lanes.deploy.length + lanes.go.length;
  let placement = '';
  if (options.shard) {
    const timing = JSON.parse(
      readFileSync(join(ROOT, 'config/test-timings.json'), 'utf8'),
    ) as TestTimingConfig;
    const plan = planWeightedShards(selected, options.shard.total, timing);
    selected = plan.shards[options.shard.index - 1]!;
    placement = `, predicted ${plan.weightsMs[options.shard.index - 1]}ms, ${plan.unknownFiles.length} unknown overall`;
  }
  if (selected.length === 0) {
    console.error(`No test files selected for the ${options.lane} lane. Refusing to report a pass.`);
    return 1;
  }

  const shard = options.shard ? `, shard ${options.shard.index}/${options.shard.total}` : '';
  console.log(`[test-lane] ${options.lane}: ${selected.length} of ${total} files${shard}${placement}`);

  const junitPath = process.env.OLYMPUS_JUNIT_PATH;
  if (junitPath) mkdirSync(join(ROOT, junitPath, '..'), { recursive: true });
  const child = Bun.spawnSync(buildTestLaneCommand(selected, junitPath), {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return child.exitCode ?? 1;
}

function fileKey(file: string): string {
  return createHash('sha256').update(file).digest('hex');
}

if (import.meta.main) {
  process.exit(runTestLane(process.argv.slice(2)));
}

#!/usr/bin/env bun
/**
 * `bun run prepush`: run after merging main and before pushing to main.
 * It fails on what CI's fast lane would fail on for this change: the
 * type check and dist check of CI's static job, the mechanical guards
 * (`bun run guards`), and the fast-lane tests the change
 * reaches through imports. The whole fast lane is about 22 minutes of test
 * time, so it runs every test that imports a changed file directly, then
 * adds tests further away in the import graph, nearest first, until about
 * three minutes of measured test time per worker is used. It prints how many
 * reached tests it left to CI. A change to the toolchain or the test harness
 * runs the whole fast lane. Deploy-lane tests that import a changed file
 * directly run too, one at a time as CI runs that lane.
 *
 *   bun run prepush                  # changes since origin/main
 *   bun run prepush --base <ref>     # changes since another ref
 *   bun run prepush --all            # every reached test, no time budget
 *   bun run prepush --list           # print the selected tests and stop
 *
 * The fast lane's tests run one process per file, as in CI
 * (scripts/test-lane-pool.ts). Deploy and Go lane tests stay in CI.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, normalize, relative } from 'node:path';
import { Glob } from 'bun';
import { partitionTestLanes } from '../test/helpers/test-lanes.ts';
import { poolSize, runFilePool } from './test-lane-pool.ts';

const ROOT = join(import.meta.dir, '..');
const SCANNED = ['src', 'test', 'scripts', 'connect-relay', 'exchange', 'eval'];
/** Files every test depends on without importing them (a dependency change always changes bun.lock). */
const WHOLE_LANE = /^(bun\.lock|bunfig\.toml|tsconfig\.json|test\/helpers\/test-lanes\.ts|scripts\/test-lane(-pool)?\.ts)$/;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm;

const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const base = baseIndex >= 0 ? args[baseIndex + 1]! : 'origin/main';
const listOnly = args.includes('--list');
const everything = args.includes('--all');
/** Measured test time per worker, about three minutes of wall time; direct importers run even past it. */
const BUDGET_PER_WORKER_MS = 180_000;
const workers = process.env.TEST_LANE_WORKERS ? poolSize() : Math.max(2, Math.min(8, availableParallelism() - 2));

function git(...command: string[]): string {
  const result = Bun.spawnSync(['git', ...command], { cwd: ROOT });
  if (result.exitCode !== 0) throw new Error(`git ${command.join(' ')}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

/** What this push changes against the base, plus anything not yet committed. */
function changedFiles(): string[] {
  const names = new Set<string>();
  for (const out of [git('diff', '--name-only', base, 'HEAD'), git('diff', '--name-only', 'HEAD')]) {
    for (const name of out.split('\n')) if (name.trim()) names.add(name.trim());
  }
  return [...names];
}

/** Reverse import graph over the repository's TypeScript: file -> files that import it. */
function importedBy(): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  for (const root of SCANNED) {
    if (!existsSync(join(ROOT, root))) continue;
    for (const rel of new Glob('**/*.{ts,tsx}').scanSync({ cwd: join(ROOT, root) })) {
      if (rel.includes('node_modules/')) continue;
      const file = `${root}/${rel}`;
      const source = readFileSync(join(ROOT, file), 'utf8');
      for (const match of source.matchAll(IMPORT)) {
        const target = resolve(file, match[1]!);
        if (!target) continue;
        if (!reverse.has(target)) reverse.set(target, new Set());
        reverse.get(target)!.add(file);
      }
    }
  }
  return reverse;
}

function resolve(from: string, spec: string): string | null {
  const raw = normalize(join(dirname(from), spec));
  for (const candidate of [raw, `${raw}.ts`, `${raw}.tsx`, join(raw, 'index.ts')]) {
    if (existsSync(join(ROOT, candidate)) && !candidate.endsWith('/')) {
      return relative(ROOT, join(ROOT, candidate));
    }
  }
  return null;
}

type Selection = { tests: string[]; deploy: string[]; whole: boolean; reached: number };

function selectTests(changed: string[], fast: string[], deployLane: string[]): Selection {
  if (changed.some(name => WHOLE_LANE.test(name))) return { tests: fast, deploy: [], whole: true, reached: fast.length };
  const reverse = importedBy();
  const depth = new Map<string, number>(changed.map(name => [name, 0]));
  let frontier = [...changed];
  for (let hop = 1; frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const importer of reverse.get(file) ?? []) {
        if (depth.has(importer)) continue;
        depth.set(importer, hop);
        next.push(importer);
      }
    }
    frontier = next;
  }
  const timing = JSON.parse(readFileSync(join(ROOT, 'config/test-timings.json'), 'utf8')) as { fastMs: Record<string, number>; fastUnknownP95Ms: number };
  const cost = (name: string) => timing.fastMs[createHash('sha256').update(name).digest('hex')] ?? timing.fastUnknownP95Ms;
  const reached = fast
    .filter(name => depth.has(`test/${name}`))
    .map(name => ({ name, hops: depth.get(`test/${name}`)!, ms: cost(name) }))
    .sort((a, b) => a.hops - b.hops || a.ms - b.ms);
  let budget = BUDGET_PER_WORKER_MS * workers;
  const tests: string[] = [];
  for (const test of reached) {
    // Direct importers always run; the budget then decides how far beyond them.
    if (test.hops > 1 && !everything && test.ms > budget) continue;
    budget -= test.ms;
    tests.push(test.name);
  }
  // Deploy-lane tests (process-spawning, run serially in CI) that import a changed file directly.
  const deploy = deployLane.filter(name => (depth.get(`test/${name}`) ?? Infinity) <= 1);
  return { tests, deploy, whole: false, reached: reached.length };
}

async function run(command: string[], env: Record<string, string> = {}): Promise<boolean> {
  const child = Bun.spawn(command, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, ...env } });
  return (await child.exited) === 0;
}

/** CI's static job: the type check over src, test, scripts and eval (plus exchange and the relay), then dist up to date. */
async function runStatic(): Promise<boolean> {
  const heap = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=6144`.trim() };
  return (await run(['bun', 'run', 'typecheck'], heap)) && run(['bun', 'run', 'dist:check']);
}

const started = Date.now();
const changed = changedFiles();
const lanes = partitionTestLanes(join(ROOT, 'test'));
const fast = lanes.fast;
const { tests, deploy, whole, reached } = selectTests(changed, fast, lanes.deploy);
const relay = changed.some(name => name.startsWith('connect-relay/'));
const left = reached - tests.length;
console.log(
  `prepush: ${changed.length} changed files since ${base}; ` +
    (whole ? `the whole fast lane (${fast.length} files)` : `${tests.length} fast-lane test files on ${workers} workers`) +
    (deploy.length > 0 ? `, ${deploy.length} deploy-lane test files that import a changed file (one at a time)` : '') +
    (relay ? ', the connect-relay tests' : '') + ', the type check, dist and the guards.' +
    (left > 0 ? ` ${left} more tests further down the import graph are left to CI (--all runs them).` : ''),
);
if (listOnly) {
  for (const name of [...tests, ...deploy]) console.log(`test/${name}`);
  process.exit(0);
}

const [staticOk, guardsOk, testsOk, deployOk, relayOk] = await Promise.all([
  runStatic(),
  run(['bun', 'scripts/guards.ts']),
  tests.length === 0 ? Promise.resolve(true) : runFilePool(tests, workers, ROOT).then(code => code === 0),
  deploy.length === 0 ? Promise.resolve(true) : runFilePool(deploy, 1, ROOT).then(code => code === 0),
  relay ? run(['bun', 'run', 'test:connect-relay']) : Promise.resolve(true),
]);
const seconds = Math.round((Date.now() - started) / 1000);
const failed = [!staticOk && 'type check or dist', !guardsOk && 'guards', !testsOk && 'fast-lane tests', !deployOk && 'deploy-lane tests', !relayOk && 'connect-relay tests'].filter(Boolean);
console.log(failed.length === 0 ? `prepush: passed in ${seconds} s.` : `prepush: FAILED (${failed.join(', ')}) in ${seconds} s. Fix it before pushing.`);
process.exit(failed.length === 0 ? 0 : 1);

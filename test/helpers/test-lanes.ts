/**
 * Which lane a test file belongs to, decided from the file itself.
 *
 * A test is in the GO lane when it declares and actually uses the Go toolchain,
 * in the DEPLOY lane if it starts another process, and in the FAST lane
 * otherwise. The Go declaration is co-located with the only test that needs
 * the toolchain; the parser rejects missing, malformed, or unused declarations.
 *
 * Why spawning and not "is it slow": measured on 2026-08-24, of the 80 test
 * files that spawn a subprocess, 77 also carried a per-test wall-clock timeout
 * of 10s or more — a 96% overlap. The slow lane and the flaky lane are the same
 * lane, and spawning is what causes both: a subprocess is where the wall-clock
 * budgets live, and wall-clock budgets are what false-fail on a busy machine.
 * Three of them false-failed real pushes that day.
 *
 * There was a checked-in manifest here first. It listed every deploy-lane
 * filename, and `consolidation-boundary-guard` rejected it — one of those
 * filenames carries an expert-coupled term, and reproducing it in a new source
 * file is exactly the spreading that guard exists to stop. Deriving the lane
 * instead of naming its members removes the literal, the drift, and the file.
 *
 * Being in the deploy lane does NOT mean a test runs less often. CI runs every
 * lane on every pull request. Locally, developers run the focused tests their
 * change needs rather than paying for the whole lane on every push.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type TestLane = 'fast' | 'deploy' | 'go';

/**
 * The membership rule. Deliberately a source match rather than an import graph
 * walk: a helper that spawns on the caller's behalf still lands the caller in
 * this lane, which is the answer we want, and it needs no module resolution to
 * decide.
 */
const SPAWNS = /Bun\.spawn|spawnSync|execFileSync|execSync|\.spawn\(/;
const TOOLCHAIN_DECLARATION = /^\/\/ OLYMPUS_TEST_LANE: (\S+)$/m;
const GO_TOOLCHAIN_USE = /optionalToolchain\(['"]go['"]\)|Bun\.spawnSync\(\[go,/;

/**
 * This file has to NAME the spawn APIs in order to detect them, and the guard
 * that checks the partition has to import it. Neither starts a process; both
 * would match their own rule. They are the only self-references, which is why
 * this is a named exemption of two rather than an open list.
 */
const RULE_SOURCE_FILES: readonly string[] = Object.freeze([
  'deploy-lane-partition.test.ts',
]);

export function testLaneFor(source: string): TestLane {
  const declaration = TOOLCHAIN_DECLARATION.exec(source)?.[1];
  if (source.includes('OLYMPUS_TEST_LANE:') && declaration === undefined) {
    throw new Error('Malformed OLYMPUS_TEST_LANE declaration.');
  }
  if (declaration !== undefined && declaration !== 'go') {
    throw new Error(`Unsupported OLYMPUS_TEST_LANE declaration: ${declaration}`);
  }
  const usesGo = GO_TOOLCHAIN_USE.test(source);
  if (usesGo && declaration !== 'go') {
    throw new Error('A test that invokes Go must declare // OLYMPUS_TEST_LANE: go.');
  }
  if (declaration === 'go') {
    if (!usesGo) throw new Error('The Go lane declaration has no detected Go invocation.');
    return 'go';
  }
  return SPAWNS.test(source) ? 'deploy' : 'fast';
}

export function testFilesIn(testDir: string): string[] {
  return readdirSync(testDir)
    .filter((name) => name.endsWith('.test.ts'))
    .sort();
}

/**
 * Partition a test directory into its three lanes.
 *
 * Returns the complete partition rather than a filter, so a caller cannot ask
 * for one lane and silently receive a set that omits another.
 */
export function partitionTestLanes(testDir: string): { fast: string[]; deploy: string[]; go: string[] } {
  const fast: string[] = [];
  const deploy: string[] = [];
  const go: string[] = [];
  for (const name of testFilesIn(testDir)) {
    if (RULE_SOURCE_FILES.includes(name)) {
      fast.push(name);
      continue;
    }
    const lane = testLaneFor(readFileSync(join(testDir, name), 'utf8'));
    ({ fast, deploy, go }[lane]).push(name);
  }
  return { fast, deploy, go };
}

#!/usr/bin/env bun
/**
 * `bun run guards`: the repository's mechanical guards, in under a minute.
 * Run it before every push to main. It is not the whole test suite; it is
 * the set of checks that other threads' pushes keep tripping. The two SQL
 * finder guards run their own engine and take most of the time, so they run
 * beside the rest.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SLOW = ['loop-sql-finders-guard', 'pool-sql-finders-guard'];
const REST = [
  'architecture-guard', 'privacy-per-item-guard', 'public-surface-guard',
  'timeout-allowance', 'silent-fallback-allowance', 'model-choice-guard',
  'limit-registry-guard', 'raw-sleep-guard', 'spawn-timeout-guard', 'deploy-lane-partition',
  'dashboard-design-review', 'connector-store-open-cost', 'store-open-guard', 'sqlite-pragma-order-guard',
  'archive-import-hold-guard', 'child-item-id-guard', 'connector-store-identity-index-guard', 'data-path-guard',
  'email-source-connector-store-mount-guards', 'embedding-path-guard', 'engine-split-route-guard',
  'local-files-deletion-guard', 'private-move-answer-guards', 'source-account-guard',
  'tier-hold-until-judged-guard', 'tier-path-guard', 'toolchain-version-pin-guard', 'venice-policy-drift-guard',
];

const root = join(import.meta.dir, '..');
const started = Date.now();
const run = (names: readonly string[]) => {
  const home = mkdtempSync(join(tmpdir(), 'olympus-guards-'));
  const child = Bun.spawn(['bun', 'test', '--timeout=120000', ...names.map(name => `test/${name}.test.ts`)], {
    cwd: root, env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe',
  });
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    .then(([code, out, err]) => { rmSync(home, { recursive: true, force: true }); return { code, text: out + err }; });
};
const results = await Promise.all([run(SLOW), run(REST)]);
const failed = results.filter(result => result.code !== 0);
for (const result of failed) process.stderr.write(result.text);
const seconds = Math.round((Date.now() - started) / 1000);
if (failed.length > 0) {
  console.error(`guards: FAILED in ${seconds} s. Fix the failures above before pushing to main; do not loosen a guard.`);
  process.exit(1);
}
console.log(`guards: all ${SLOW.length + REST.length} passed in ${seconds} s.`);

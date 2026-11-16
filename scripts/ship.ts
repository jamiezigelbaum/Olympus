#!/usr/bin/env bun
/**
 * `bun run ship`: push your committed work to main the one documented way.
 *
 *   1. fetch origin/main and merge it into HEAD (a conflict stops here);
 *   2. run `bun run prepush` on exactly the commit that will be pushed, in a
 *      throwaway worktree, so uncommitted edits in this checkout neither help
 *      nor hurt it;
 *   3. push that commit to main only if prepush passed. If main moved in the
 *      meantime, merge again and repeat from step 2.
 *
 * It prints the step that failed and exits non-zero. There is no shell pipe
 * for a caller to get wrong. `bun run ship -- --all` passes `--all` to prepush.
 */
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const prepushArgs = process.argv.slice(2);

function git(args: string[], quiet = false): { ok: boolean; out: string } {
  const result = Bun.spawnSync(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const out = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
  if (!quiet && out) console.log(out);
  return { ok: result.exitCode === 0, out };
}

function fail(step: string, detail = ''): never {
  console.log(`ship: FAILED at ${step}.${detail ? ` ${detail}` : ''} Nothing was pushed.`);
  process.exit(1);
}

async function prepushOn(commit: string): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-ship-'));
  const tree = join(dir, 'tree');
  try {
    if (!git(['worktree', 'add', '--detach', tree, commit], true).ok) fail('making a worktree for the prepush run');
    symlinkSync(join(ROOT, 'node_modules'), join(tree, 'node_modules'));
    const child = Bun.spawn(['bun', 'scripts/prepush.ts', ...prepushArgs], { cwd: tree, stdout: 'inherit', stderr: 'inherit' });
    return (await child.exited) === 0;
  } finally {
    git(['worktree', 'remove', '--force', tree], true);
    rmSync(dir, { recursive: true, force: true });
  }
}

const started = Date.now();
for (let attempt = 1; ; attempt++) {
  if (!git(['fetch', '--quiet', 'origin', 'main']).ok) fail('fetching origin/main');
  const merge = git(['merge', '--no-edit', 'origin/main']);
  if (!merge.ok) fail('merging origin/main', 'Resolve the conflict, commit, and run `bun run ship` again.');
  const commit = git(['rev-parse', 'HEAD'], true).out;
  if (git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], true).ok) {
    console.log('ship: nothing to push; main already has this commit.');
    process.exit(0);
  }
  console.log(`ship: prepush on ${commit.slice(0, 8)}${attempt > 1 ? ` (main moved; try ${attempt})` : ''}.`);
  if (!(await prepushOn(commit))) fail('prepush', 'Fix what it named, commit, and run `bun run ship` again.');
  const push = git(['push', 'origin', `${commit}:refs/heads/main`]);
  if (push.ok) {
    console.log(`ship: pushed ${commit.slice(0, 8)} to main in ${Math.round((Date.now() - started) / 1000)} s.`);
    process.exit(0);
  }
  if (!/rejected|non-fast-forward|fetch first/.test(push.out)) fail('pushing', 'See git\'s message above.');
  // Main moved while prepush ran: merge the new main and check the merged tree again.
}

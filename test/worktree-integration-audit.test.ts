import { describe, expect, test } from 'bun:test';
import { runWorktreeIntegrationAudit } from '../scripts/worktree-integration-audit.ts';

const NOW = new Date('2026-06-16T12:00:00.000Z');
const ROOT = '/repo/Olympus';
const HEAD_MAIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_FEATURE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HEAD_WIP = 'cccccccccccccccccccccccccccccccccccccccc';

describe('worktree integration audit', () => {
  test('passes when active worktrees and branches are integrated into main', async () => {
    const report = await runWorktreeIntegrationAudit({
      cwd: ROOT,
      now: NOW,
    }, {
      runGit: gitStub({
        worktrees: [
          worktree(ROOT, HEAD_MAIN, 'main'),
          worktree('/repo/wt-qwen35', HEAD_FEATURE, 'codex/qwen35-vlm-durable'),
        ],
        containingBranches: {
          [HEAD_MAIN]: ['main'],
          [HEAD_FEATURE]: ['main', 'codex/qwen35-vlm-durable'],
        },
      }),
    });

    expect(report).toMatchObject({
      ok: true,
      status: 'ready',
      repoRoot: ROOT,
      baseBranch: 'main',
      unmergedBranches: [],
      unmergedRemoteBranches: [],
      dirtyWorktrees: [],
      unintegratedWorktrees: [],
      actions: ['All worktrees and branches are integrated into main.'],
    });
    expect(report.worktrees).toEqual([
      {
        path: ROOT,
        head: HEAD_MAIN,
        branch: 'refs/heads/main',
        branchShort: 'main',
        dirty: false,
        integrated: true,
        quarantined: false,
        status: 'clean',
      },
      {
        path: '/repo/wt-qwen35',
        head: HEAD_FEATURE,
        branch: 'refs/heads/codex/qwen35-vlm-durable',
        branchShort: 'codex/qwen35-vlm-durable',
        dirty: false,
        integrated: true,
        quarantined: false,
        status: 'clean',
      },
    ]);
  });

  test('fails when a sibling worktree has tracked dirty changes', async () => {
    const report = await runWorktreeIntegrationAudit({
      cwd: ROOT,
      now: NOW,
    }, {
      runGit: gitStub({
        worktrees: [
          worktree(ROOT, HEAD_MAIN, 'main'),
          worktree('/repo/wt-source', HEAD_FEATURE, 'build/source-work'),
        ],
        containingBranches: {
          [HEAD_MAIN]: ['main'],
          [HEAD_FEATURE]: ['main', 'build/source-work'],
        },
        dirtyByPath: {
          '/repo/wt-source': ' M PLAN.md\n',
        },
      }),
    });

    expect(report.ok).toBe(false);
    expect(report.status).toBe('attention');
    expect(report.dirtyWorktrees).toEqual(['/repo/wt-source']);
    expect(report.worktrees.find((item) => item.path === '/repo/wt-source')).toMatchObject({
      dirty: true,
      integrated: true,
      status: 'dirty',
    });
    expect(report.actions).toEqual([
      'Commit, stash, or move tracked dirty changes before integration: /repo/wt-source.',
    ]);
  });

  test('fails when local or remote branches are not reachable from main', async () => {
    const report = await runWorktreeIntegrationAudit({
      cwd: ROOT,
      now: NOW,
    }, {
      runGit: gitStub({
        worktrees: [worktree(ROOT, HEAD_MAIN, 'main')],
        containingBranches: { [HEAD_MAIN]: ['main'] },
        unmergedBranches: ['build/new-source'],
        unmergedRemoteBranches: ['origin/codex/runtime-fix'],
      }),
    });

    expect(report.ok).toBe(false);
    expect(report.unmergedBranches).toEqual(['build/new-source']);
    expect(report.unmergedRemoteBranches).toEqual(['origin/codex/runtime-fix']);
    expect(report.actions).toEqual([
      'Integrate or explicitly quarantine local branch(es) not reachable from main: build/new-source.',
      'Integrate or explicitly quarantine remote branch(es) not reachable from main: origin/codex/runtime-fix.',
    ]);
  });

  test('keeps configured quarantined branches visible without blocking integration', async () => {
    const report = await runWorktreeIntegrationAudit({
      cwd: ROOT,
      now: NOW,
    }, {
      runGit: gitStub({
        worktrees: [
          worktree(ROOT, HEAD_MAIN, 'main'),
          worktree('/repo/wt-dropbox-wip', HEAD_WIP, 'dropbox-evidence-pack-wip'),
        ],
        containingBranches: {
          [HEAD_MAIN]: ['main'],
          [HEAD_WIP]: ['dropbox-evidence-pack-wip'],
        },
        unmergedBranches: ['dropbox-evidence-pack-wip'],
      }),
    });

    expect(report.ok).toBe(true);
    expect(report.unmergedBranches).toEqual([]);
    expect(report.worktrees.find((item) => item.path === '/repo/wt-dropbox-wip')).toMatchObject({
      branchShort: 'dropbox-evidence-pack-wip',
      quarantined: true,
      integrated: false,
      status: 'quarantined',
    });
    expect(report.actions).toEqual([
      'All non-quarantined worktrees and branches are integrated into main; quarantined branch(es) kept off main: dropbox-evidence-pack-wip.',
    ]);
  });
});

function worktree(path: string, head: string, branch: string): string {
  return [
    `worktree ${path}`,
    `HEAD ${head}`,
    `branch refs/heads/${branch}`,
  ].join('\n');
}

function gitStub(options: {
  worktrees: string[];
  containingBranches: Record<string, string[]>;
  unmergedBranches?: string[];
  unmergedRemoteBranches?: string[];
  dirtyByPath?: Record<string, string>;
}): (args: string[], cwd: string, timeoutMs: number) => Promise<string> {
  return async (args: string[], cwd: string): Promise<string> => {
    const key = args.join(' ');
    if (key === 'rev-parse --show-toplevel') return `${ROOT}\n`;
    if (key === 'branch --no-merged main --format=%(refname:short)') return lines(options.unmergedBranches ?? []);
    if (key === 'branch -r --no-merged main --format=%(refname:short)') return lines(options.unmergedRemoteBranches ?? []);
    if (key === 'worktree list --porcelain') return `${options.worktrees.join('\n\n')}\n`;
    if (key === 'status --porcelain --untracked-files=no') return options.dirtyByPath?.[cwd] ?? '';
    if (args[0] === 'branch' && args[1] === '--contains' && args[3] === '--format=%(refname:short)') {
      return lines(options.containingBranches[args[2] ?? ''] ?? []);
    }
    throw new Error(`Unexpected git command: ${key} at ${cwd}`);
  };
}

function lines(values: string[]): string {
  return values.length > 0 ? `${values.join('\n')}\n` : '';
}

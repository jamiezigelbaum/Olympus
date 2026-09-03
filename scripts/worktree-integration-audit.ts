import { writeFileSync } from 'node:fs';

export type WorktreeIntegrationAuditStatus = 'ready' | 'attention';

export type WorktreeIntegrationWorktree = {
  path: string;
  head?: string;
  branch?: string;
  branchShort?: string;
  dirty: boolean;
  integrated: boolean;
  quarantined: boolean;
  status: 'clean' | 'dirty' | 'unmerged' | 'quarantined';
};

export type WorktreeIntegrationAuditReport = {
  ok: boolean;
  generatedAt: string;
  status: WorktreeIntegrationAuditStatus;
  repoRoot: string;
  baseBranch: string;
  quarantinedBranches: string[];
  unmergedBranches: string[];
  unmergedRemoteBranches: string[];
  dirtyWorktrees: string[];
  unintegratedWorktrees: string[];
  worktrees: WorktreeIntegrationWorktree[];
  actions: string[];
};

export type WorktreeIntegrationAuditOptions = {
  cwd?: string;
  baseBranch?: string;
  quarantinedBranches?: string[];
  now?: Date;
  timeoutMs?: number;
};

export type WorktreeIntegrationAuditDeps = {
  runGit?: (args: string[], cwd: string, timeoutMs: number) => Promise<string>;
};

const DEFAULT_BASE_BRANCH = 'main';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_QUARANTINED_BRANCHES = ['dropbox-evidence-pack-wip'];

export async function runWorktreeIntegrationAudit(
  options: WorktreeIntegrationAuditOptions = {},
  deps: WorktreeIntegrationAuditDeps = {},
): Promise<WorktreeIntegrationAuditReport> {
  const cwd = options.cwd ?? process.cwd();
  const baseBranch = options.baseBranch ?? DEFAULT_BASE_BRANCH;
  const quarantinedBranches = unique(options.quarantinedBranches ?? DEFAULT_QUARANTINED_BRANCHES);
  const timeoutMs = positiveInt(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const runGit = deps.runGit ?? runGitDefault;
  const repoRoot = (await runGit(['rev-parse', '--show-toplevel'], cwd, timeoutMs)).trim() || cwd;
  const unmergedBranches = branchLines(await runGit(['branch', '--no-merged', baseBranch, '--format=%(refname:short)'], repoRoot, timeoutMs))
    .filter((branch) => !quarantinedBranches.includes(branch));
  const unmergedRemoteBranches = branchLines(await runGit(['branch', '-r', '--no-merged', baseBranch, '--format=%(refname:short)'], repoRoot, timeoutMs))
    .filter((branch) => branch !== 'origin/HEAD')
    .filter((branch) => !quarantinedBranches.includes(remoteBranchShort(branch)));
  const unmergedSet = new Set([
    ...unmergedBranches,
    ...unmergedRemoteBranches.map(remoteBranchShort),
  ]);
  const worktrees = await Promise.all(parseWorktrees(await runGit(['worktree', 'list', '--porcelain'], repoRoot, timeoutMs))
    .map(async (worktree) => summarizeWorktree(worktree, {
      baseBranch,
      quarantinedBranches,
      unmergedSet,
      repoRoot,
      runGit,
      timeoutMs,
    })));

  const dirtyWorktrees = worktrees.filter((worktree) => worktree.dirty).map((worktree) => worktree.path);
  const unintegratedWorktrees = worktrees
    .filter((worktree) => !worktree.integrated && !worktree.quarantined)
    .map((worktree) => worktree.branchShort ?? worktree.head ?? worktree.path);
  const actions = nextActions({
    dirtyWorktrees,
    unintegratedWorktrees,
    unmergedBranches,
    unmergedRemoteBranches,
    quarantinedBranches,
    worktrees,
    baseBranch,
  });
  const ok = dirtyWorktrees.length === 0
    && unintegratedWorktrees.length === 0
    && unmergedBranches.length === 0
    && unmergedRemoteBranches.length === 0;

  return {
    ok,
    generatedAt: (options.now ?? new Date()).toISOString(),
    status: ok ? 'ready' : 'attention',
    repoRoot,
    baseBranch,
    quarantinedBranches,
    unmergedBranches,
    unmergedRemoteBranches,
    dirtyWorktrees,
    unintegratedWorktrees,
    worktrees,
    actions,
  };
}

type ParsedWorktree = {
  path: string;
  head?: string;
  branch?: string;
};

async function summarizeWorktree(
  worktree: ParsedWorktree,
  deps: {
    baseBranch: string;
    quarantinedBranches: string[];
    unmergedSet: Set<string>;
    repoRoot: string;
    runGit: (args: string[], cwd: string, timeoutMs: number) => Promise<string>;
    timeoutMs: number;
  },
): Promise<WorktreeIntegrationWorktree> {
  const branchShort = worktree.branch ? shortRef(worktree.branch) : undefined;
  const dirty = (await deps.runGit(['status', '--porcelain', '--untracked-files=no'], worktree.path, deps.timeoutMs)).trim().length > 0;
  const quarantined = branchShort ? deps.quarantinedBranches.includes(branchShort) : false;
  const integrated = quarantined
    ? false
    : branchShort
      ? branchShort === deps.baseBranch || !deps.unmergedSet.has(branchShort)
      : worktree.head
        ? await headContainedInBase(worktree.head, deps)
        : false;
  const status = quarantined
    ? 'quarantined'
    : dirty
      ? 'dirty'
      : integrated
        ? 'clean'
        : 'unmerged';
  return {
    path: worktree.path,
    ...(worktree.head ? { head: worktree.head } : {}),
    ...(worktree.branch ? { branch: worktree.branch } : {}),
    ...(branchShort ? { branchShort } : {}),
    dirty,
    integrated,
    quarantined,
    status,
  };
}

async function headContainedInBase(
  head: string,
  deps: {
    baseBranch: string;
    repoRoot: string;
    runGit: (args: string[], cwd: string, timeoutMs: number) => Promise<string>;
    timeoutMs: number;
  },
): Promise<boolean> {
  const containingBranches = branchLines(await deps.runGit(['branch', '--contains', head, '--format=%(refname:short)'], deps.repoRoot, deps.timeoutMs));
  return containingBranches.includes(deps.baseBranch);
}

function parseWorktrees(output: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = [];
  let current: ParsedWorktree | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length) };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    if (line.startsWith('branch ')) current.branch = line.slice('branch '.length);
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function nextActions(input: {
  dirtyWorktrees: string[];
  unintegratedWorktrees: string[];
  unmergedBranches: string[];
  unmergedRemoteBranches: string[];
  quarantinedBranches: string[];
  worktrees: WorktreeIntegrationWorktree[];
  baseBranch: string;
}): string[] {
  const actions: string[] = [];
  if (input.dirtyWorktrees.length > 0) {
    actions.push(`Commit, stash, or move tracked dirty changes before integration: ${input.dirtyWorktrees.join(', ')}.`);
  }
  if (input.unmergedBranches.length > 0) {
    actions.push(`Integrate or explicitly quarantine local branch(es) not reachable from ${input.baseBranch}: ${input.unmergedBranches.join(', ')}.`);
  }
  if (input.unmergedRemoteBranches.length > 0) {
    actions.push(`Integrate or explicitly quarantine remote branch(es) not reachable from ${input.baseBranch}: ${input.unmergedRemoteBranches.join(', ')}.`);
  }
  if (input.unintegratedWorktrees.length > 0) {
    actions.push(`Do not advance appliance work until active worktree head(s) are integrated or quarantined: ${input.unintegratedWorktrees.join(', ')}.`);
  }
  const visibleQuarantined = input.worktrees
    .filter((worktree) => worktree.quarantined)
    .map((worktree) => worktree.branchShort ?? worktree.path);
  if (actions.length === 0 && visibleQuarantined.length > 0) {
    actions.push(`All non-quarantined worktrees and branches are integrated into ${input.baseBranch}; quarantined branch(es) kept off main: ${visibleQuarantined.join(', ')}.`);
  }
  if (actions.length === 0) {
    actions.push(`All worktrees and branches are integrated into ${input.baseBranch}.`);
  }
  return unique(actions);
}

function branchLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\* /, ''))
    .filter(Boolean);
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
}

function remoteBranchShort(branch: string): string {
  return branch.replace(/^[^/]+\//, '');
}

function positiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function runGitDefault(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${exitCode}: ${stderr.trim().slice(0, 500)}`);
    return stdout;
  } finally {
    clearTimeout(timeout);
  }
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
  return value;
}

function allArgValues(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
    values.push(value);
  }
  return values;
}

function printText(report: WorktreeIntegrationAuditReport): void {
  console.log(`Worktree integration audit: ${report.status.toUpperCase()}`);
  console.log(`base=${report.baseBranch} worktrees=${report.worktrees.length} trackedDirty=${report.dirtyWorktrees.length} unmergedLocal=${report.unmergedBranches.length} unmergedRemote=${report.unmergedRemoteBranches.length}`);
  for (const worktree of report.worktrees) {
    console.log([
      `worktree=${worktree.branchShort ?? worktree.head ?? worktree.path}`,
      `status=${worktree.status}`,
      `dirty=${worktree.dirty}`,
      `integrated=${worktree.integrated}`,
      worktree.quarantined ? 'quarantined=true' : '',
    ].filter(Boolean).join(' '));
  }
  for (const action of report.actions) console.log(`next: ${action}`);
}

if (import.meta.main) {
  const options: WorktreeIntegrationAuditOptions = {};
  const cwd = argValue('--cwd');
  const baseBranch = argValue('--base-branch');
  const timeoutMs = argValue('--timeout-ms');
  const quarantinedBranches = allArgValues('--quarantine-branch');
  if (cwd) options.cwd = cwd;
  if (baseBranch) options.baseBranch = baseBranch;
  if (timeoutMs) options.timeoutMs = Number(timeoutMs);
  if (quarantinedBranches.length > 0) options.quarantinedBranches = quarantinedBranches;
  const report = await runWorktreeIntegrationAudit(options);
  const reportPath = argValue('--report');
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
  }
  if (!report.ok) process.exit(1);
}

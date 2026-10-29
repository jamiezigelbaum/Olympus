/**
 * Which legs of the release check a change can reach (Jamie, 2026-10-29: a full run for every fix is the wrong design).
 *
 * Given the files that changed between a tested commit and a new candidate, the plan names the legs to run again; the
 * others keep their results from the tested run (run.ts `--carry-from`), with the file list as the proof. The mapping is
 * conservative: a file no rule claims reaches every leg, so an unknown change costs a full run, never a missed check.
 * Every run still provisions a fresh machine and installs the exact candidate, so the install, setup and ingest checks
 * are always the candidate's own.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

export const LEGS = ['suite', 'relay', 'inbox', 'screenshots', 'journeys', 'explore', 'archive'] as const;
export type Leg = (typeof LEGS)[number];

/** The run.ts flag that leaves each leg out. */
export const SKIP_FLAG: Record<Leg, string> = {
  suite: '--skip-suite',
  relay: '--skip-relay',
  inbox: '--skip-inbox',
  screenshots: '--skip-screenshots',
  journeys: '--skip-journeys',
  explore: '--skip-explore',
  archive: '--skip-archive',
};

/** Legs whose results depend on another leg's having run first, so running one runs the others too. */
const NEEDS: Partial<Record<Leg, Leg[]>> = {
  // The approved pictures show the pages as a full run leaves them: after the relay, every agent's questions and the Inbox
  // leg (run.ts, --update-baselines). Journeys also take their setup from the suite and the Inbox (journeys.ts `needs`).
  journeys: ['suite', 'relay', 'inbox', 'screenshots'],
};

const SCREEN_LEGS: Leg[] = ['screenshots', 'inbox', 'journeys', 'explore'];

interface Rule { test: (file: string) => boolean; legs: Leg[] | 'all'; why: string }

const under = (prefix: string) => (file: string) => file.startsWith(prefix);
const harness = (pattern: RegExp) => (file: string) => file.startsWith('scripts/release-check/') && pattern.test(file.slice('scripts/release-check/'.length));

/** First match wins. Product files reach what a user (or agent) sees through them; harness files reach the leg they implement. */
const RULES: Rule[] = [
  { test: (f) => f === 'scripts/release-check/impact.ts', legs: [], why: 'the planner itself does not run on the machine' },
  { test: under('test/'), legs: [], why: 'tests are not in the package' },
  { test: under('eval/'), legs: [], why: 'the held-out eval is not in the package' },
  { test: under('.github/'), legs: [], why: 'CI configuration is not in the package' },
  { test: under('docs/'), legs: [], why: 'docs are not in the package' },
  { test: (f) => !f.includes('/') && f.endsWith('.md'), legs: [], why: 'top-level notes are not in the package' },
  // dist/ and the design pin are built from src/ (CI fails a commit whose dist is stale), so the src/ files that changed carry the proof.
  { test: under('dist/'), legs: [], why: 'built from src/, whose changed files are mapped' },
  { test: (f) => f === 'config/dashboard-design-review.json', legs: [], why: 'pinned from the dashboard source, whose changed files are mapped' },
  // The relay leg talks to the production relay, never this commit's relay code; the listing pages are not in the package.
  { test: under('connect-relay/'), legs: [], why: 'the check uses the production relay, not this commit\'s relay code' },
  { test: under('chatgpt-plugin/'), legs: [], why: 'the ChatGPT listing is not in the package' },
  { test: under('src/workers/archive-import/'), legs: ['archive'], why: 'archive import' },
  { test: under('src/workers/dashboard/'), legs: SCREEN_LEGS, why: 'the dashboard pages' },
  { test: (f) => f === 'src/core/linux-owner-bridge.ts', legs: SCREEN_LEGS, why: 'how the owner\'s browser opens the dashboard' },
  { test: (f) => f === 'src/workers/email-source/local-private-answers.ts' || f === 'src/core/waiting-private-questions.ts', legs: ['inbox', ...SCREEN_LEGS], why: 'Private questions and the Inbox' },
  { test: under('skills/'), legs: ['suite', 'relay', 'inbox'], why: 'what agents are told' },
  { test: harness(/^(inbox|inbox-page|private-note)\.ts$/), legs: ['inbox'], why: 'the Inbox leg' },
  { test: harness(/^explore[\w-]*\.ts$/), legs: ['explore'], why: 'the control exploration' },
  { test: harness(/^archive-[\w-]+\.ts$/), legs: ['archive'], why: 'the archive-import leg' },
  { test: harness(/^(journey|journeys|journey-driver|visual|visual-boxes|visual-capture|layout-rules|reviewer|reviewer-plants)\.ts$/), legs: ['journeys'], why: 'the journeys and screens' },
  { test: harness(/^(agents|cli-agents|judge|suite|probe|mcp-proxy)\.ts$/), legs: ['suite', 'relay'], why: 'the agent suite' },
];

export interface FileImpact { file: string; legs: Leg[] | 'all'; why: string }

export interface ImpactPlan {
  /** `full` runs every leg; `partial` runs `run` and carries the rest; `none` reruns only the install and setup checks. */
  mode: 'full' | 'partial' | 'none';
  run: Leg[];
  carry: Leg[];
  /** The run.ts flags that leave out the carried legs. */
  skipFlags: string[];
  files: FileImpact[];
}

/** Relative imports of a TypeScript file, resolved against the repository root. */
function relativeImports(root: string, file: string): string[] {
  const path = join(root, file);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const found = new Set<string>();
  // `from '…'`, `import('…')` and side-effect `import '…'` (the archive seed hooks register themselves that way).
  for (const match of text.matchAll(/(?:\bfrom|\bimport\s*\(?)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) found.add(normalize(join(dirname(file), match[1]!)));
  return [...found];
}

/** Harness files a VM leg runs: everything run.ts and the in-machine agent reach. The rest (the canary, the web clients) never run there. */
export function harnessReach(root: string): Set<string> {
  const seen = new Set<string>();
  const queue = ['scripts/release-check/run.ts', 'scripts/release-check/machine-agent.ts'];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !file.startsWith('scripts/release-check/')) continue;
    seen.add(file);
    queue.push(...relativeImports(root, file));
  }
  return seen;
}

function impactOf(file: string, reach: Set<string> | undefined): FileImpact {
  if (reach && file.startsWith('scripts/release-check/') && file.endsWith('.ts') && !reach.has(file) && file !== 'scripts/release-check/run.ts') {
    return { file, legs: [], why: 'harness code no VM leg runs (not reached from run.ts or the in-machine agent)' };
  }
  const rule = RULES.find((r) => r.test(file));
  return rule ? { file, legs: rule.legs, why: rule.why } : { file, legs: 'all', why: 'no rule maps it to fewer legs' };
}

/** The plan for a change. `reach` is the harness reach of the new commit (harnessReach); without it, every harness file not in RULES reaches every leg. */
export function planImpact(changedFiles: readonly string[], reach?: Set<string>): ImpactPlan {
  const files = [...new Set(changedFiles.map((f) => f.trim()).filter(Boolean))].sort().map((f) => impactOf(f, reach));
  const needed = new Set<Leg>();
  let all = false;
  for (const impact of files) {
    if (impact.legs === 'all') all = true;
    else for (const leg of impact.legs) needed.add(leg);
  }
  if (all) return { mode: 'full', run: [...LEGS], carry: [], skipFlags: [], files };
  for (const leg of [...needed]) for (const dep of NEEDS[leg] ?? []) needed.add(dep);
  const run = LEGS.filter((leg) => needed.has(leg));
  const carry = LEGS.filter((leg) => !needed.has(leg));
  return { mode: carry.length === 0 ? 'full' : run.length === 0 ? 'none' : 'partial', run, carry, skipFlags: carry.map((leg) => SKIP_FLAG[leg]), files };
}

/** Reads a changed-files list: one repository path per line. */
export function readChangedFiles(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

if (import.meta.main) {
  const at = process.argv.indexOf('--files');
  const source = at === -1 ? undefined : process.argv[at + 1];
  if (!source) {
    console.error('usage: bun scripts/release-check/impact.ts --files <changed-files list, one path per line>');
    process.exit(2);
  }
  console.log(JSON.stringify(planImpact(readChangedFiles(source), harnessReach(join(import.meta.dir, '..', '..'))), null, 2));
}

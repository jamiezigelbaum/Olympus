/**
 * The raw-sleep allowance only shrinks (#1066).
 *
 * `config/test-raw-sleep-allowance.json` lists the test files that still wait
 * on the real clock and how many raw sleeps each has. The guard test keeps
 * each file at or under its number. This check compares a PR's allowance with
 * its base: a new file or a higher number fails, so the way past the guard is
 * `createTestClock()` or `waitFor()`, never a bigger list.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const ALLOWANCE_PATH = 'config/test-raw-sleep-allowance.json';

export type Allowance = Record<string, number>;

export function parseAllowance(text: string): Allowance {
  const parsed: unknown = JSON.parse(text);
  const files = (parsed as { files?: unknown }).files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error(`${ALLOWANCE_PATH} must hold a "files" object`);
  }
  const allowance: Allowance = {};
  for (const [file, count] of Object.entries(files)) {
    if (!Number.isInteger(count) || (count as number) < 1) {
      throw new Error(`${ALLOWANCE_PATH}: ${file} needs a positive whole count`);
    }
    allowance[file] = count as number;
  }
  return allowance;
}

export function growthBetween(base: Allowance, head: Allowance): string[] {
  const problems: string[] = [];
  for (const [file, count] of Object.entries(head).sort(([a], [b]) => a.localeCompare(b))) {
    const before = base[file];
    if (before === undefined) {
      problems.push(`${file}: new entry (${count}). Use createTestClock() or waitFor() from test/helpers/test-clock.ts instead of a raw sleep.`);
    } else if (count > before) {
      problems.push(`${file}: raised from ${before} to ${count}. The allowance only shrinks.`);
    }
  }
  return problems;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const base = argument('--base');
  const head = readFileSync(ALLOWANCE_PATH, 'utf8');
  if (!base || /^0+$/.test(base)) {
    parseAllowance(head);
    console.log('raw-sleep allowance: no base commit, shape checked only');
    process.exit(0);
  }
  let baseText: string;
  try {
    baseText = execFileSync('git', ['show', `${base}:${ALLOWANCE_PATH}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // The base predates the allowance; the guard test still holds every file to it.
    parseAllowance(head);
    console.log('raw-sleep allowance: absent at base, shape checked only');
    process.exit(0);
  }
  const problems = growthBetween(parseAllowance(baseText), parseAllowance(head));
  if (problems.length > 0) {
    console.error(`The raw-sleep allowance grew:\n${problems.map((line) => `- ${line}`).join('\n')}`);
    process.exit(1);
  }
  console.log('raw-sleep allowance: did not grow');
}

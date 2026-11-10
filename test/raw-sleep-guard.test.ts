import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWANCE_PATH, growthBetween, parseAllowance } from '../scripts/raw-sleep-allowance-check.ts';
import { countRawSleeps } from './helpers/raw-sleep-audit.ts';

const repoRoot = join(import.meta.dir, '..');

// The clock helper has to use a real timer for waitFor; the audit and this
// guard name the patterns in order to find them.
const EXEMPT = new Set([
  'test/helpers/test-clock.ts',
  'test/helpers/raw-sleep-audit.ts',
  'test/raw-sleep-guard.test.ts',
]);

function currentCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const relativePath of new Glob('test/**/*.{ts,tsx,js,mjs}').scanSync({ cwd: repoRoot })) {
    if (EXEMPT.has(relativePath)) continue;
    const count = countRawSleeps(readFileSync(join(repoRoot, relativePath), 'utf8'));
    if (count > 0) counts[relativePath] = count;
  }
  return counts;
}

describe('tests do not wait on the real clock (#1066)', () => {
  test('no test file has more raw sleeps than its allowance, and the allowance matches today', () => {
    const allowance = parseAllowance(readFileSync(join(repoRoot, ALLOWANCE_PATH), 'utf8'));
    const counts = currentCounts();
    const problems: string[] = [];
    for (const [file, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
      const allowed = allowance[file] ?? 0;
      if (count > allowed) {
        problems.push(`${file}: ${count} raw sleeps, allowance ${allowed}. Use createTestClock() or waitFor() from test/helpers/test-clock.ts.`);
      } else if (count < allowed) {
        problems.push(`${file}: down to ${count} from ${allowed}. Lower its entry in ${ALLOWANCE_PATH} to ${count}.`);
      }
    }
    for (const file of Object.keys(allowance).sort()) {
      if (!(file in counts)) problems.push(`${file}: no raw sleeps left. Remove its entry from ${ALLOWANCE_PATH}.`);
    }
    expect(problems).toEqual([]);
  }, 30_000);

  test('the audit counts each raw form and ignores comments and fake-clock calls', () => {
    const source = `
      await Bun.sleep(50);
      Bun.sleepSync(5);
      await new Promise((resolve) => setTimeout(resolve, 475));
      await new Promise((r) => setTimeout(r, 10));
      await new Promise((done) => setTimeout(() => done(), 10));
      await sleep(100);
      await delay(5);
      // await Bun.sleep(1000) in prose does not count
      /* setTimeout(resolve, 1) */
      await clock.sleep(30_000);
      await clock.advance(60_000);
      await waitFor(() => ready);
      const timer = setTimeout(onTimeout, 5_000);
      const url = 'https://example.test/path'; await sleep(1);
    `;
    expect(countRawSleeps(source)).toBe(8);
  });

  test('the allowance may shrink but never gains a file or a higher number', () => {
    expect(growthBetween({ 'test/a.test.ts': 3 }, { 'test/a.test.ts': 2 })).toEqual([]);
    expect(growthBetween({ 'test/a.test.ts': 3 }, {})).toEqual([]);
    expect(growthBetween({ 'test/a.test.ts': 3 }, { 'test/a.test.ts': 4 })).toHaveLength(1);
    expect(growthBetween({}, { 'test/b.test.ts': 1 })).toHaveLength(1);
  });
});

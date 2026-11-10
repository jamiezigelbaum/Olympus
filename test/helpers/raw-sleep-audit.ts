/**
 * Finds raw real-clock waits in test sources (#1066).
 *
 * A raw sleep is a test pausing for a fixed wall-clock time and hoping the
 * work it waits on is done by then. The forms counted are the ones the test
 * tree actually uses: `Bun.sleep(…)`, `Bun.sleepSync(…)`, a promise resolved
 * by `setTimeout(resolve, …)` (any short resolver name), and calls of local
 * `sleep`/`delay`/`wait`/`pause` helpers. Use `createTestClock()` or
 * `waitFor()` from `test/helpers/test-clock.ts` instead.
 *
 * Comments are stripped before counting, so prose about sleeping is not an
 * offence. String literals are left in: a test that writes a sleeping fixture
 * script is still a test that sleeps.
 */
const RAW_SLEEP_PATTERNS: readonly RegExp[] = [
  /\bBun\.sleep(?:Sync)?\s*\(/g,
  /\bsetTimeout\s*\(\s*(?:resolve\w*|res|r|done|next|wake\w*|ok|fulfil\w*)\s*[,)]/g,
  /\bsetTimeout\s*\(\s*\(\s*\)\s*=>\s*(?:resolve\w*|res|r|done|next)\s*\(/g,
  /\bawait\s+(?:sleep|delay|wait|pause|nap)\s*\(/g,
];

function stripComments(source: string): string {
  // Line comments only when `//` is not part of a URL or string-looking token.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (_match, lead: string) => lead);
}

export function countRawSleeps(source: string): number {
  const code = stripComments(source);
  let total = 0;
  for (const pattern of RAW_SLEEP_PATTERNS) {
    total += code.match(pattern)?.length ?? 0;
  }
  return total;
}

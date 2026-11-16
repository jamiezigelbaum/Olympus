import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A failure or a limit never quietly leaves the owner with less (owner rule,
 * 16 Nov 2026): work waits while it progresses, or names what was left out
 * (core/limit-stops.ts). The one-line forms that catch and carry on with
 * nothing are counted per file in config/silent-fallback-allowance.json, and
 * the counts only go down.
 */
const repoRoot = join(import.meta.dir, '..');
const ALLOWANCE_PATH = 'config/silent-fallback-allowance.json';
const FORMS = [
  /catch(?:\s*\(\w*\))?\s*\{\s*\}/g,
  /catch(?:\s*\(\w*\))?\s*\{\s*return(?:\s+(?:undefined|\[\]|null|false|\{\}|''|0))?\s*;?\s*\}/g,
  /\.catch\(\(\w*\)\s*=>\s*(?:undefined|\[\]|null|false|\(\{\}\)|''|0)\)/g,
];

function countSilentFallbacks(source: string): number {
  return FORMS.reduce((sum, form) => sum + (source.match(form)?.length ?? 0), 0);
}

describe('failures never quietly leave the owner with less', () => {
  test('no file gains a catch that carries on with nothing, and the allowance matches today', () => {
    const allowance = JSON.parse(readFileSync(join(repoRoot, ALLOWANCE_PATH), 'utf8')) as { files: Record<string, number> };
    const counts: Record<string, number> = {};
    for (const relative of new Glob('**/*.ts').scanSync({ cwd: join(repoRoot, 'src') })) {
      const count = countSilentFallbacks(readFileSync(join(repoRoot, 'src', relative), 'utf8'));
      if (count > 0) counts[`src/${relative}`] = count;
    }
    const problems: string[] = [];
    for (const [path, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
      const allowed = allowance.files[path] ?? 0;
      if (count > allowed) problems.push(`${path}: ${count} catches that carry on with nothing, allowance ${allowed}. Wait while the work progresses, or name what was left out (core/limit-stops.ts).`);
      else if (count < allowed) problems.push(`${path}: down to ${count} from ${allowed}. Lower its entry in ${ALLOWANCE_PATH}.`);
    }
    for (const path of Object.keys(allowance.files)) {
      if (!(path in counts)) problems.push(`${path}: none left. Remove its entry from ${ALLOWANCE_PATH}.`);
    }
    expect(problems).toEqual([]);
  }, 30_000);

  test('the count finds each form', () => {
    expect(countSilentFallbacks(`
      try { a(); } catch {}
      try { b(); } catch (error) { }
      try { c(); } catch { return undefined; }
      try { d(); } catch { return []; }
      const e = await f().catch(() => null);
      const g = await h().catch(() => { log(); return undefined; });
      try { i(); } catch (error) { report(error); }
    `)).toBe(5);
  });
});

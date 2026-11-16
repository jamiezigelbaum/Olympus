import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Features never pick the small built-in model themselves (owner rule,
 * 16 Nov 2026: the small model is only the default for installs with
 * nothing better). Each place outside the model's own code and the shared
 * chooser that names the built-in model, its handles or its limits is
 * counted per file in config/model-choice-allowance.json, and the counts
 * only go down as features move to the chooser.
 */
const repoRoot = join(import.meta.dir, '..');
const ALLOWANCE_PATH = 'config/model-choice-allowance.json';
const NAMES = /\b(?:workerBuiltInModel|answerBuiltInModel|registeredBuiltInPrivateModel|createBuiltInAnalystModel|createBuiltInPrivateAnswerModel|createWorkerSharedBuiltInModel|sharedBuiltInModel|frontBuiltInModel|QWEN35_\w+|BUILT_IN_REASONING_MODELS|PANEL_ANSWER_LIMITS|builtInAnalystMaxTokensForChars)\b/g;

type Allowance = { owners: string[]; files: Record<string, number> };

function countNames(source: string): number {
  const code = source.replace(/^\s*(?:import|export)\b[^;]*?\bfrom\s*'[^']*';/gms, '');
  let count = 0;
  for (const line of code.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    count += line.match(NAMES)?.length ?? 0;
  }
  return count;
}

describe('features do not pick the built-in model themselves', () => {
  test('every file that names the built-in model is listed, and no count grows', () => {
    const allowance = JSON.parse(readFileSync(join(repoRoot, ALLOWANCE_PATH), 'utf8')) as Allowance;
    const owners = allowance.owners.map(prefix => prefix.replace(/\*$/, ''));
    const counts: Record<string, number> = {};
    for (const relative of new Glob('**/*.ts').scanSync({ cwd: join(repoRoot, 'src') })) {
      const path = `src/${relative}`;
      if (owners.some(prefix => path === prefix || (prefix.endsWith('/') && path.startsWith(prefix)))) continue;
      const count = countNames(readFileSync(join(repoRoot, path), 'utf8'));
      if (count > 0) counts[path] = count;
    }
    const problems: string[] = [];
    for (const [path, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
      const allowed = allowance.files[path] ?? 0;
      if (count > allowed) problems.push(`${path}: names the built-in model ${count} times, allowance ${allowed}. Ask the shared model chooser instead.`);
      else if (count < allowed) problems.push(`${path}: down to ${count} from ${allowed}. Lower its entry in ${ALLOWANCE_PATH}.`);
    }
    for (const path of Object.keys(allowance.files)) {
      if (!(path in counts)) problems.push(`${path}: no longer names the built-in model. Remove its entry from ${ALLOWANCE_PATH}.`);
    }
    expect(problems).toEqual([]);
  });

  test('the count skips imports and comments', () => {
    expect(countNames(`import {\n  createBuiltInPrivateAnswerModel,\n  x,\n} from './a.ts';\n// registeredBuiltInPrivateModel()\nconst m = registeredBuiltInPrivateModel();\nconst s = QWEN35_4B.modelId;`)).toBe(2);
  });
});

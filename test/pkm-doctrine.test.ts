import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..');
const PACK = join(ROOT, 'skills', 'pkm-doctrine');
const ROUTING_EVAL = join(PACK, 'evals', 'routing-eval.jsonl');
const OUTPUT_EVAL = join(PACK, 'evals', 'output-checks.jsonl');

type RoutingExpectation =
  | { route: 'pkm-doctrine'; slice: string }
  | { route: 'ask-sources' }
  | { route: 'out-of-scope'; boundary: 'wiki-authoring' };

interface RoutingCase {
  id: string;
  intent: string;
  expect: RoutingExpectation;
}

type OutputCheck =
  | { kind: 'section_absent'; value: string }
  | { kind: 'regex_absent'; value: string }
  | { kind: 'regex'; value: string }
  | { kind: 'max_count'; value: string; max: number }
  | { kind: 'contains_any'; value: string[] }
  | { kind: 'frontmatter'; key: string; value?: string | boolean; absent?: boolean }
  | { kind: 'forbidden_terms'; value: string[] }
  | { kind: 'contains'; value: string };

interface OutputCase {
  id: string;
  scenario: string;
  output: string;
  checks: OutputCheck[];
}

describe('pkm-doctrine packaged skill', () => {
  test('ships exactly the 13-file persona-neutral first release', () => {
    const files = filesUnder(PACK).map((path) => relative(PACK, path)).sort();
    expect(files).toEqual([
      'CHANGELOG.md',
      'SKILL.md',
      'evals/output-checks.jsonl',
      'evals/routing-eval.jsonl',
      'filing.md',
      'onboarding.md',
      'rules.json',
      'templates/area-page.md',
      'templates/hub-page.md',
      'templates/project-page.md',
      'why.md',
      'wording-tasks.md',
      'writing-project-page.md',
    ]);
    expect(existsSync(join(PACK, 'judgment-seed.md'))).toBe(false);

    const packText = files.map((path) => readFileSync(join(PACK, path), 'utf8')).join('\n');
    for (const forbidden of [
      'Jamie',
      'Castor',
      'Lucas Fox',
      'Zemm',
      'KM Projector',
      '/Users/zig',
      'checkbox-owner-only',
      "never the word 'graph'",
      'owner-authored Castor Productivity Doctrine',
    ]) {
      expect(packText).not.toContain(forbidden);
    }
    for (const rejectedBlanketRule of [
      'detail derived from email/messages/private files',
      'anything derived from their private sources is',
      'page derived from private email',
    ]) {
      expect(packText.toLowerCase()).not.toContain(rejectedBlanketRule.toLowerCase());
    }
  });

  test('keeps the repository-only skill out of public discovery while preserving its frontmatter', () => {
    const plugin = JSON.parse(readFileSync(join(ROOT, 'openclaw.plugin.json'), 'utf8')) as {
      skills: string[];
    };
    const manifest = JSON.parse(readFileSync(join(ROOT, 'skills', 'manifest.json'), 'utf8')) as {
      skills: Array<{ name: string; path: string; description: string }>;
    };
    const skill = readFileSync(join(PACK, 'SKILL.md'), 'utf8');
    const frontmatter = parseFrontmatter(skill);
    const description = frontmatter.description;
    if (typeof description !== 'string') throw new Error('pkm-doctrine frontmatter description must be a string');
    const entry = manifest.skills.find(({ name }) => name === 'pkm-doctrine');

    expect(plugin.skills.filter((path) => path === 'skills/pkm-doctrine')).toHaveLength(0);
    expect(manifest.skills.filter(({ name }) => name === 'pkm-doctrine')).toHaveLength(0);
    expect(entry).toBeUndefined();
    expect(frontmatter.tools).toBe('[]');
    expect(frontmatter.mutating).toBe(true);
  });

  test('all retained prose rule references resolve to rules.json', () => {
    const contract = JSON.parse(readFileSync(join(PACK, 'rules.json'), 'utf8')) as {
      rules: Array<{ id: string }>;
    };
    const ruleIds = contract.rules.map(({ id }) => id);
    expect(new Set(ruleIds).size).toBe(ruleIds.length);

    const references = new Set<string>();
    for (const path of filesUnder(PACK).filter((path) => path.endsWith('.md'))) {
      const flattened = readFileSync(path, 'utf8').replace(/\s+/g, ' ');
      for (const match of flattened.matchAll(/\(Rules?:\s*([^)]+)\)/g)) {
        for (const id of match[1]!.matchAll(/`([a-z0-9-]+)`/g)) {
          references.add(id[1]!);
        }
      }
    }

    expect([...references].sort()).not.toEqual([]);
    expect([...references].filter((id) => !ruleIds.includes(id))).toEqual([]);
  });
});

describe('pkm-doctrine deterministic routing contract eval', () => {
  test('parses every unique case and resolves positive and negative routes', () => {
    const cases = readJsonl(ROUTING_EVAL, validateRoutingCase);
    const manifest = JSON.parse(readFileSync(join(ROOT, 'skills', 'manifest.json'), 'utf8')) as {
      skills: Array<{ name: string; path: string }>;
    };
    const registered = new Set(manifest.skills.map(({ name }) => name));
    const skill = readFileSync(join(PACK, 'SKILL.md'), 'utf8');
    const resolver = readFileSync(join(ROOT, 'skills', 'RESOLVER.md'), 'utf8');

    expect(cases).toHaveLength(6);
    for (const evalCase of cases) {
      expect(evalCase.intent.trim().length).toBeGreaterThan(0);
      if (evalCase.expect.route === 'pkm-doctrine') {
        expect(registered.has('pkm-doctrine')).toBe(false);
        expect(existsSync(join(PACK, evalCase.expect.slice))).toBe(true);
        expect(skill).toContain(`\`${evalCase.expect.slice}\``);
        expect(resolver).toContain('`skills/pkm-doctrine/SKILL.md`');
      } else if (evalCase.expect.route === 'ask-sources') {
        expect(registered.has('ask-sources')).toBe(true);
        expect(resolver).toContain('`skills/ask-sources/SKILL.md`, not `skills/pkm-doctrine/SKILL.md`');
      } else {
        expect(evalCase.expect.boundary).toBe('wiki-authoring');
        expect(resolver).toContain('Out of scope for `pkm-doctrine` version 0.1');
      }
    }
  });
});

describe('pkm-doctrine deterministic output contract eval', () => {
  test('executes every declared check against committed synthetic output', () => {
    const cases = readJsonl(OUTPUT_EVAL, validateOutputCase);
    expect(cases.length).toBeGreaterThanOrEqual(7);
    for (const evalCase of cases) {
      for (const check of evalCase.checks) {
        expect(() => enforceCheck(evalCase.output, check)).not.toThrow();
      }
    }
  });

  test('covers every supported check kind', () => {
    const cases = readJsonl(OUTPUT_EVAL, validateOutputCase);
    const kinds = new Set(cases.flatMap(({ checks }) => checks.map(({ kind }) => kind)));
    expect([...kinds].sort()).toEqual([
      'contains',
      'contains_any',
      'forbidden_terms',
      'frontmatter',
      'max_count',
      'regex',
      'regex_absent',
      'section_absent',
    ]);
  });

  test('fails closed when each check kind is violated', () => {
    const mutations: Array<{ output: string; check: OutputCheck }> = [
      { output: 'forbidden section', check: { kind: 'section_absent', value: 'forbidden section' } },
      { output: '- [ ] duplicated task', check: { kind: 'regex_absent', value: '(?m)^- \\[ \\]' } },
      { output: 'no task', check: { kind: 'regex', value: '(?m)^  - \\[ \\] [A-Z]' } },
      { output: '**Next:** one\n**Next:** two', check: { kind: 'max_count', value: '**Next:**', max: 1 } },
      { output: 'nothing useful', check: { kind: 'contains_any', value: ['*Status*', '*Waiting*'] } },
      { output: '---\nprivate: false\n---\n', check: { kind: 'frontmatter', key: 'private', value: true } },
      { output: 'invented deadline', check: { kind: 'forbidden_terms', value: ['deadline'] } },
      { output: 'missing affordance', check: { kind: 'contains', value: 'voice note works' } },
    ];
    for (const mutation of mutations) {
      expect(() => enforceCheck(mutation.output, mutation.check)).toThrow();
    }
  });

  test('privacy follows classification rather than the email source family', () => {
    const cases = readJsonl(OUTPUT_EVAL, validateOutputCase);
    const ordinaryEmail = cases.find(({ id }) => id === 'output-ordinary-email');
    const restrictedReflect = cases.find(({ id }) => id === 'output-restricted-reflect');
    expect(ordinaryEmail).toBeDefined();
    expect(restrictedReflect).toBeDefined();
    expect(parseFrontmatter(ordinaryEmail!.output).private).toBeUndefined();
    expect(parseFrontmatter(restrictedReflect!.output).private).toBe(true);

    const falselyLocked = ordinaryEmail!.output.replace('owner: assistant', 'owner: assistant\nprivate: true');
    for (const check of ordinaryEmail!.checks) {
      if (check.kind === 'frontmatter' || check.kind === 'regex_absent') {
        expect(() => enforceCheck(falselyLocked, check)).toThrow();
      }
    }
  });
});

function filesUnder(dir: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) paths.push(...filesUnder(path));
    else if (stat.isFile()) paths.push(path);
  }
  return paths;
}

function readJsonl<T>(path: string, validate: (value: unknown, line: number) => T): T[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const values: T[] = [];
  const ids = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`${basename(path)}:${index + 1} is invalid JSON: ${String(error)}`);
    }
    const value = validate(parsed, index + 1);
    const id = (value as { id: string }).id;
    if (ids.has(id)) throw new Error(`${basename(path)}:${index + 1} duplicates id ${id}`);
    ids.add(id);
    values.push(value);
  }
  if (values.length === 0) throw new Error(`${basename(path)} has no cases`);
  return values;
}

function validateRoutingCase(value: unknown, line: number): RoutingCase {
  const row = objectRow(value, ROUTING_EVAL, line);
  exactKeys(row, ['id', 'intent', 'expect'], ROUTING_EVAL, line);
  requireNonBlank(row.id, 'id', ROUTING_EVAL, line);
  requireNonBlank(row.intent, 'intent', ROUTING_EVAL, line);
  const expected = objectRow(row.expect, ROUTING_EVAL, line);
  requireNonBlank(expected.route, 'expect.route', ROUTING_EVAL, line);
  if (expected.route === 'pkm-doctrine') {
    exactKeys(expected, ['route', 'slice'], ROUTING_EVAL, line);
    requireNonBlank(expected.slice, 'expect.slice', ROUTING_EVAL, line);
  } else if (expected.route === 'ask-sources') {
    exactKeys(expected, ['route'], ROUTING_EVAL, line);
  } else if (expected.route === 'out-of-scope') {
    exactKeys(expected, ['route', 'boundary'], ROUTING_EVAL, line);
    if (expected.boundary !== 'wiki-authoring') {
      throw new Error(`${basename(ROUTING_EVAL)}:${line} has unknown boundary`);
    }
  } else {
    throw new Error(`${basename(ROUTING_EVAL)}:${line} has unknown route`);
  }
  return row as unknown as RoutingCase;
}

function validateOutputCase(value: unknown, line: number): OutputCase {
  const row = objectRow(value, OUTPUT_EVAL, line);
  exactKeys(row, ['id', 'scenario', 'output', 'checks'], OUTPUT_EVAL, line);
  requireNonBlank(row.id, 'id', OUTPUT_EVAL, line);
  requireNonBlank(row.scenario, 'scenario', OUTPUT_EVAL, line);
  requireNonBlank(row.output, 'output', OUTPUT_EVAL, line);
  if (!Array.isArray(row.checks) || row.checks.length === 0) {
    throw new Error(`${basename(OUTPUT_EVAL)}:${line} checks must be a non-empty array`);
  }
  for (const [checkIndex, checkValue] of row.checks.entries()) {
    validateOutputCheck(checkValue, line, checkIndex);
  }
  return row as unknown as OutputCase;
}

function validateOutputCheck(value: unknown, line: number, index: number): OutputCheck {
  const check = objectRow(value, OUTPUT_EVAL, line);
  const where = `${basename(OUTPUT_EVAL)}:${line} check ${index + 1}`;
  requireNonBlank(check.kind, 'kind', OUTPUT_EVAL, line);
  switch (check.kind) {
    case 'section_absent':
    case 'regex_absent':
    case 'regex':
    case 'contains':
      exactKeys(check, ['kind', 'value'], OUTPUT_EVAL, line);
      if (typeof check.value !== 'string' || !check.value) throw new Error(`${where} requires a string value`);
      break;
    case 'max_count':
      exactKeys(check, ['kind', 'value', 'max'], OUTPUT_EVAL, line);
      if (typeof check.value !== 'string' || !check.value) throw new Error(`${where} requires a string value`);
      if (!Number.isInteger(check.max) || (check.max as number) < 0) throw new Error(`${where} requires a non-negative integer max`);
      break;
    case 'contains_any':
    case 'forbidden_terms':
      exactKeys(check, ['kind', 'value'], OUTPUT_EVAL, line);
      if (!Array.isArray(check.value) || check.value.length === 0 || check.value.some((item) => typeof item !== 'string' || !item)) {
        throw new Error(`${where} requires non-empty string values`);
      }
      break;
    case 'frontmatter':
      exactKeys(check, check.absent === true ? ['kind', 'key', 'absent'] : ['kind', 'key', 'value'], OUTPUT_EVAL, line);
      if (typeof check.key !== 'string' || !check.key) throw new Error(`${where} requires a key`);
      if (check.absent !== true && typeof check.value !== 'string' && typeof check.value !== 'boolean') {
        throw new Error(`${where} requires value or absent:true`);
      }
      break;
    default:
      throw new Error(`${where} has unknown kind ${String(check.kind)}`);
  }
  return check as unknown as OutputCheck;
}

function enforceCheck(output: string, check: OutputCheck): void {
  switch (check.kind) {
    case 'section_absent':
      if (output.includes(check.value)) throw new Error(`forbidden section ${check.value}`);
      return;
    case 'regex_absent':
      if (compileRegex(check.value).test(output)) throw new Error(`forbidden regex ${check.value}`);
      return;
    case 'regex':
      if (!compileRegex(check.value).test(output)) throw new Error(`missing regex ${check.value}`);
      return;
    case 'max_count':
      if (literalCount(output, check.value) > check.max) throw new Error(`too many ${check.value}`);
      return;
    case 'contains_any':
      if (!check.value.some((needle) => output.includes(needle))) throw new Error(`missing any of ${check.value.join(', ')}`);
      return;
    case 'frontmatter': {
      const frontmatter = parseFrontmatter(output);
      if (check.absent === true) {
        if (frontmatter[check.key] !== undefined) throw new Error(`frontmatter ${check.key} must be absent`);
      } else if (frontmatter[check.key] !== check.value) {
        throw new Error(`frontmatter ${check.key} does not equal ${String(check.value)}`);
      }
      return;
    }
    case 'forbidden_terms': {
      const lower = output.toLowerCase();
      const found = check.value.find((term) => lower.includes(term.toLowerCase()));
      if (found) throw new Error(`forbidden term ${found}`);
      return;
    }
    case 'contains':
      if (!output.includes(check.value)) throw new Error(`missing ${check.value}`);
  }
}

function parseFrontmatter(markdown: string): Record<string, string | boolean> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const values: Record<string, string | boolean> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    const raw = field[2]!.trim();
    values[field[1]!] = raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  return values;
}

function compileRegex(source: string): RegExp {
  const inlineFlags = source.match(/^\(\?([gimsuy]+)\)/);
  return new RegExp(inlineFlags ? source.slice(inlineFlags[0].length) : source, inlineFlags?.[1] ?? '');
}

function literalCount(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function objectRow(value: unknown, path: string, line: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${basename(path)}:${line} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, allowed: string[], path: string, line: number): void {
  const extras = Object.keys(row).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !(key in row));
  if (extras.length || missing.length) {
    throw new Error(`${basename(path)}:${line} schema mismatch; missing=${missing.join(',')} extra=${extras.join(',')}`);
  }
}

function requireNonBlank(value: unknown, field: string, path: string, line: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${basename(path)}:${line} ${field} must be non-blank`);
  }
}

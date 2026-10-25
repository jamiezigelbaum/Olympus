// Only an archive import lane may hold content until the private model judges
// it (docs/design/archive-import.md, "Privacy while an import is judged").
// The hold is one shared rule: a lane DECLARES it with the lane option
// `holdContentUntilJudged`, and the shared classifier call sites derive the
// classifier input (`holdUntilJudged`) from that option or from the hold the
// stored decision carries. This guard keeps it that way:
//
// - the lane option is set (an object property, shorthand, assignment or
//   string key) only under ARCHIVE_IMPORT_LANE_DIR, apart from its one
//   declaration and the one pass-through that carries a lane's own option
//   through the merged inputs;
// - the classifier input is set only by the shared call sites listed below,
//   so no connector or format module sets it directly; and
// - the stored hold reason is spelled out only by the classifier.
//
// No archive import lane exists yet: the guard passes with zero lane users.

import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import ts from 'typescript';

const repoRoot = join(import.meta.dir, '..');

/** The only place a lane may set `holdContentUntilJudged`. */
const ARCHIVE_IMPORT_LANE_DIR = 'src/workers/archive-import/';

const LANE_OPTION = 'holdContentUntilJudged';
const PLACEMENT = 'src/workers/connector-store/tier-placement.ts';
/** Shared lines that name the lane option without any lane setting it. */
const LANE_OPTION_SHARED: ReadonlyArray<{ path: string; snippet: string; why: string }> = [
  { path: PLACEMENT, snippet: 'holdContentUntilJudged?: true;', why: 'the option\'s declaration' },
  { path: 'src/core/contracts.ts', snippet: 'holdContentUntilJudged?: true;', why: 'RawItem\'s declaration of the same hold, carried by an item an archive input built' },
  {
    path: PLACEMENT,
    snippet: 'explicit.holdContentUntilJudged === true ? { holdContentUntilJudged: true as const } : {}',
    why: 'resolveStoreTierClassification carries the lane\'s own option through the merged inputs',
  },
];

const CLASSIFIER_INPUT = 'holdUntilJudged';
/** Shared modules that may set the classifier input, each from the lane option or the stored hold. */
const CLASSIFIER_INPUT_SETTERS = new Map<string, string>([
  ['src/workers/classification/tier-classifier.ts', 'defines the input and passes it between its own passes'],
  ['src/workers/connector-store/tier-placement.ts', 'decideItemTiers: the lane option or the stored hold'],
  ['src/workers/connector-store/tier-rejudge.ts', 're-judge: the set\'s option or the stored hold'],
  ['src/workers/classification/tier-migration.ts', 'migration plan: the set\'s option or the stored hold'],
  ['src/workers/connector-store/tier-override-settle.ts', 'override settling keeps the hold reason'],
  ['src/workers/connector-store/local-index.ts', 'extracted content of a legacy store: the inputs or the stored hold'],
  ['src/workers/file-extraction/tiered-store-sink.ts', 'tiered extraction landing: the inputs, the set\'s option or the stored hold'],
]);

const HOLD_REASON_LITERAL = 'content:held_until_judged';
const HOLD_REASON_OWNER = 'src/workers/classification/tier-classifier.ts';

function codeWithoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Offsets where `name` is written rather than read, from the TypeScript
 * parser so no spelling of an assignment slips past. A read is a property
 * access (`x.name`, `x?.name`) that is not, through any `!`, parentheses or
 * type assertion, the target of an assignment, `++`/`--` or `delete`.
 * Anything else that names it (an object property, shorthand, destructuring
 * target, string or computed key, a declaration, a parameter) is a write.
 */
function writesOf(code: string, name: string): number[] {
  const source = ts.createSourceFile('guard.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offsets: number[] = [];
  const isWrapper = (node: ts.Node): boolean => ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node);
  const isAssignment = (kind: ts.SyntaxKind): boolean =>
    kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  const accessIsWritten = (access: ts.Node): boolean => {
    let target = access;
    while (target.parent && isWrapper(target.parent)) target = target.parent;
    const parent = target.parent;
    if (!parent) return false;
    if (ts.isBinaryExpression(parent)) return parent.left === target && isAssignment(parent.operatorToken.kind);
    if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
      return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
    }
    if (ts.isDeleteExpression(parent)) return true;
    if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === target) return true;
    // A destructuring assignment target (`[x.name] = …`, `({ k: x.name } = …)`):
    // climb the pattern literal and see whether it is the left of an `=`.
    let pattern: ts.Node = target;
    while (pattern.parent && (ts.isArrayLiteralExpression(pattern.parent) || ts.isObjectLiteralExpression(pattern.parent)
      || ts.isPropertyAssignment(pattern.parent) || ts.isSpreadElement(pattern.parent)
      || ts.isSpreadAssignment(pattern.parent) || isWrapper(pattern.parent))) {
      pattern = pattern.parent;
    }
    if (pattern === target) return false;
    const outer = pattern.parent;
    if (outer !== undefined && (ts.isForOfStatement(outer) || ts.isForInStatement(outer))) return outer.initializer === pattern;
    return outer !== undefined && ts.isBinaryExpression(outer) && outer.left === pattern
      && outer.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      if (node.text === name) {
        const read = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node && !accessIsWritten(node.parent);
        if (!read) offsets.push(node.getStart(source));
      }
    } else if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      if (node.text.includes(name)) offsets.push(node.getStart(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offsets;
}

function sourceFiles(glob: string): string[] {
  return [...new Glob(glob).scanSync({ cwd: repoRoot })].map((path) => path.split('\\').join('/')).sort();
}

function read(path: string): string {
  return codeWithoutComments(readFileSync(join(repoRoot, path), 'utf8'));
}

describe('holding content until judged is an archive import lane\'s choice alone', () => {
  test('the write detector tells a write from a read', () => {
    for (const written of [
      `const c = { ${LANE_OPTION}: true };`,
      `const c = { ${LANE_OPTION} };`,
      `c.${LANE_OPTION} = true;`,
      `const c = { ['${LANE_OPTION}']: true };`,
      `Object.assign(c, JSON.parse('{"${LANE_OPTION}": true}'));`,
      `c.${LANE_OPTION}! = true;`,
      `(c.${LANE_OPTION} as boolean) = true;`,
      `(<any>c).${LANE_OPTION} = true;`,
      `c.${LANE_OPTION} ||= true;`,
      `[c.${LANE_OPTION}] = [true];`,
      `({ k: c.${LANE_OPTION} } = { k: true });`,
      `c['${LANE_OPTION}'] = true;`,
      `for (c.${LANE_OPTION} of [true] as const) {}`,
      `for (c.${LANE_OPTION} in { a: 1 }) {}`,
      `for ([c.${LANE_OPTION}] of [[true]]) {}`,
      `({ ...c.${LANE_OPTION} } = { a: 1 });`,
    ]) expect(`${written} -> ${writesOf(written, LANE_OPTION).length}`).toBe(`${written} -> 1`);
    for (const readOnly of [
      `if (c.${LANE_OPTION} === true) hold();`,
      `const h = options?.${LANE_OPTION};`,
      `return set.${LANE_OPTION}\n  ?? false;`,
      `const merged = { hold: set.${LANE_OPTION}, rest: [set.${LANE_OPTION}] };`,
      `const h = c.${LANE_OPTION}!;`,
      `for (const v of [c.${LANE_OPTION}]) use(v);`,
    ]) expect(`${readOnly} -> ${writesOf(readOnly, LANE_OPTION).length}`).toBe(`${readOnly} -> 0`);
  });

  test(`only ${ARCHIVE_IMPORT_LANE_DIR} sets the lane option`, () => {
    const offenders: string[] = [];
    for (const path of [...sourceFiles('src/**/*.ts'), ...sourceFiles('scripts/**/*.ts'), ...sourceFiles('eval/**/*.ts')]) {
      const code = read(path);
      const writes = writesOf(code, LANE_OPTION);
      if (writes.length === 0) continue;
      // An archive import lane module: the one place a lane may set it.
      if (path.startsWith(ARCHIVE_IMPORT_LANE_DIR)) continue;
      const shared = LANE_OPTION_SHARED.filter((entry) => entry.path === path);
      for (const at of writes) {
        const covered = shared.some(({ snippet }) => {
          const start = code.indexOf(snippet);
          return start >= 0 && at >= start && at < start + snippet.length;
        });
        if (!covered) offenders.push(`${path}: ${code.slice(at, at + 60).split('\n')[0]}`);
      }
    }
    // Zero lane users is a pass: no archive import lane exists yet.
    expect(offenders).toEqual([]);
  });

  test('each shared mention of the lane option is still exactly where this guard says', () => {
    for (const { path, snippet, why } of LANE_OPTION_SHARED) {
      const code = read(path);
      const first = code.indexOf(snippet);
      expect(`${path} (${why}): ${first >= 0 && code.indexOf(snippet, first + 1) < 0}`).toBe(`${path} (${why}): true`);
    }
  });

  test('only the shared classifier call sites set the classifier input', () => {
    const setters = sourceFiles('src/**/*.ts').filter((path) => writesOf(read(path), CLASSIFIER_INPUT).length > 0);
    expect(setters.filter((path) => !CLASSIFIER_INPUT_SETTERS.has(path))).toEqual([]);
    // An entry that no longer sets it is a leftover: the list only shrinks.
    expect([...CLASSIFIER_INPUT_SETTERS.keys()].filter((path) => !setters.includes(path))).toEqual([]);
  });

  test('only the classifier spells out the stored hold reason', () => {
    const spelled = sourceFiles('src/**/*.ts').filter((path) => read(path).includes(HOLD_REASON_LITERAL));
    expect(spelled).toEqual([HOLD_REASON_OWNER]);
  });
});

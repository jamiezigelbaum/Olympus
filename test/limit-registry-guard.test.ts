// Stopping guards must register or name their adopter; pacing and clamps stay explicit.
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import allowlist from '../config/limit-registry-allowlist.json';

const root = join(import.meta.dir, '..');
const legacy = new Set(['JudgeSpending', 'reconcileProviderPauseFile', 'reserveZkapiRequest',
  'readPrivateEvidenceItem', 'DEFAULT_EVIDENCE_BYTE_BUDGET', 'PRIVATE_EVIDENCE_BYTE_BUDGET', 'DEFAULT_GOOGLE_DRIVE_MAX_TEXT_BYTES']);
const comparisons = new Set([ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

function guardSymbols(source: string, registered?: () => void): string[] {
  const file = ts.createSourceFile('guard.ts', source, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const constants = new Set<string>();
  const compared = new Set<string>();
  const identifiers = (node: ts.Node) => {
    if (ts.isIdentifier(node)) compared.add(node.text);
    ts.forEachChild(node, identifiers);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerLimit') registered?.();
    if (ts.isClassDeclaration(node) && node.name && /Budget|Guard|Allowance/.test(node.name.text)) found.add(node.name.text);
    if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression)) {
      const name = node.expression.expression.getText(file).split('.').pop()!;
      if (/(?:Budget|Guard|Cap|Allowance|Wait)Error$/.test(name)) found.add(name);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)
      && /(?:_BUDGET(?:_|$)|_CAP(?:_|$)|_MAX_)/.test(node.name.text)
      && node.name.text === node.name.text.toUpperCase()
      && !(node.initializer && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)))) constants.add(node.name.text);
    if (ts.isBinaryExpression(node) && comparisons.has(node.operatorToken.kind)) identifiers(node);
    // Older stopping boundaries predate the guard naming convention. Keep them inventoried too.
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableDeclaration(node))
      && node.name && ts.isIdentifier(node.name) && legacy.has(node.name.text)) found.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const name of constants) if (compared.has(name)) found.add(name);
  return [...found].sort();
}

function inventory() {
  const files = readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
  const found = new Set<string>();
  const adopted = new Set<string>();
  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    let registered = false;
    const own = guardSymbols(source, () => { registered = true; }).map((symbol) => `${relative(root, path)}#${symbol}`);
    for (const key of own) found.add(key);
    if (registered) {
      for (const key of own) adopted.add(key);
      for (const match of source.matchAll(/limit-adapter: (src\/[^\s#]+)#(\w+)/g)) adopted.add(`${match[1]}#${match[2]}`);
    }
  }
  return { found, adopted };
}

function unregistered(found: Set<string>, covered: Set<string>): string[] {
  return [...found].filter((key) => !covered.has(key)).sort();
}

test('every guard is registered, adapter-adopted, or explicitly inventoried; stale entries fail', () => {
  const { found, adopted } = inventory();
  const allowed = allowlist.map((entry) => {
    expect(['pacing', 'clamp', 'internal', 'pending']).toContain(entry.reason);
    expect(entry.retire_when.trim().length).toBeGreaterThan(0);
    return `${entry.path}#${entry.symbol}`;
  });
  expect(new Set(allowed).size).toBe(allowed.length);
  expect(allowed.filter((key) => !found.has(key) || adopted.has(key)), 'stale allowlist entries').toEqual([]);
  expect([...adopted].filter((key) => !found.has(key)), 'stale adapter declarations').toEqual([]);
  expect(unregistered(found, new Set([...adopted, ...allowed])), 'unregistered limits').toEqual([]);
});

test('a planted guard, throwing cap, and counter budget are caught, including reversed comparisons', () => {
  const planted = guardSymbols(`class PlantedBudget {} throw new PlantedCapError();
    const WORK_BUDGET = 2; if (used >= WORK_BUDGET) stop();
    const WORK_MAX_RUNS = 3; if (WORK_MAX_RUNS < runs) stop();
    // class CommentGuard {}
    const words = 'throw new StringWaitError()';`);
  expect(planted).toEqual(['PlantedBudget', 'PlantedCapError', 'WORK_BUDGET', 'WORK_MAX_RUNS']);
  expect(unregistered(new Set(planted), new Set())).toEqual(planted);
  let registered = false;
  guardSymbols('// registerLimit({});', () => { registered = true; });
  expect(registered).toBe(false);
  guardSymbols('registerLimit({});', () => { registered = true; });
  expect(registered).toBe(true);
});

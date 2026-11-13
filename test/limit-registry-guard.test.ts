// Stopping guards must register or name their adopter; pacing and clamps stay explicit.
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import allowlist from '../config/limit-registry-allowlist.json';

const root = join(import.meta.dir, '..');
const syntaxCache = new Map<string, ts.SourceFile>();
function syntax(source: string): ts.SourceFile {
  let file = syntaxCache.get(source);
  if (!file) { file = ts.createSourceFile('guard.ts', source, ts.ScriptTarget.Latest, true); syntaxCache.set(source, file); }
  return file;
}

const legacy = new Set(['reconcileProviderPauseFile', 'reserveZkapiRequest',
  'readPrivateEvidenceItem', 'DEFAULT_EVIDENCE_BYTE_BUDGET', 'PRIVATE_EVIDENCE_BYTE_BUDGET', 'DEFAULT_GOOGLE_DRIVE_MAX_TEXT_BYTES']);
const comparisons = new Set([ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

function guardSymbols(source: string, registered?: () => void): string[] {
  const file = syntax(source);
  const found = new Set<string>();
  const constants = new Set<string>();
  const compared = new Set<string>();
  const identifiers = (node: ts.Node) => {
    if (ts.isIdentifier(node)) compared.add(node.text);
    ts.forEachChild(node, identifiers);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerLimit') registered?.();
    if (ts.isClassDeclaration(node) && node.name && /Budget|Guard|Allowance|Spending/.test(node.name.text)) found.add(node.name.text);
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
  const silent = silentInventory();
  for (const key of silent.found) found.add(key);
  for (const key of silent.covered) adopted.add(key);
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

const stopReasonPattern = /(_guard|_cap|_spent|_budget|cap_reached|allowance|quota|^provider_rate_limit$|^rate_limited$)/;
const reasonSlot = /^(?:degraded_?Reason|degraded_reason|deferral|wait_?reason|reason|refusal|deferralReason|stopReason|later|unavailable)$/i;
const retrySlot = /^(?:retryAfter(?:Ms|Seconds)?|retry_at|retryAt)$/;
function propertyName(node: ts.Node | undefined): string {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : '';
}

/** Scan syntax, never comments or prose. Registration in a file does not excuse a new silent reason. */
function silentStops(source: string, workers = true) {
  const file = syntax(source);
  const reasons = new Set<string>();
  const retries = new Set<string>();
  const declarations = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const resolvedReasons = new Set<string>();
  const literals = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) return;
    if (ts.isPropertyAssignment(node)) { literals(node.initializer); return; }
    if (ts.isIdentifier(node) && declarations.has(node.text) && !resolvedReasons.has(node.text)) {
      resolvedReasons.add(node.text);
      literals(declarations.get(node.text)!);
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && /^[a-z][a-z0-9_.:-]*$/.test(node.text) && stopReasonPattern.test(node.text)) reasons.add(`reason:${node.text}`);
    ts.forEachChild(node, literals);
  };
  // A numeric bound in milliseconds. Unknown/dynamic bounds fail closed.
  const numeric = (node: ts.Expression, seen = new Set<string>()): number | undefined => {
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isParenthesizedExpression(node)) return numeric(node.expression, seen);
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const value = declarations.get(node.text);
      if (value) return numeric(value, new Set([...seen, node.text]));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'toISOString') {
      const receiver = node.expression.expression;
      if (ts.isNewExpression(receiver) && receiver.expression.getText(file) === 'Date' && receiver.arguments?.[0]) return numeric(receiver.arguments[0], seen);
    }
    if (ts.isBinaryExpression(node)) {
      const a = numeric(node.left, seen), b = numeric(node.right, seen);
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken && /(?:now|time|clock|getTime)/i.test(node.left.getText(file)) && b !== undefined) return b;
      if (a !== undefined && b !== undefined) {
        if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return a * b;
        if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return a + b;
        if (node.operatorToken.kind === ts.SyntaxKind.SlashToken) return a / b;
      }
    }
    return undefined;
  };
  const boundary = (node: ts.Node): string => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) return propertyName(parent.name) || 'anonymous';
      if (ts.isVariableDeclaration(parent)) return propertyName(parent.name) || 'anonymous';
    }
    return 'module';
  };
  const retry = (node: ts.Node, name: string, value: ts.Expression) => {
    if (!workers) return;
    if (ts.isObjectLiteralExpression(value)) return; // An envelope forwards its `at` timestamp; it does not compute one.
    // A forwarded timestamp is not a computation. Its producing boundary is scanned separately.
    if (ts.isPropertyAccessExpression(value) || ts.isIdentifier(value) && (retrySlot.test(value.text) || !declarations.has(value.text))) return;
    const bound = numeric(value);
    const scale = /Seconds$/.test(name === 'return' ? boundary(node) : name) || name === 'retryAfter' ? 1_000 : 1;
    if (bound === undefined || bound * scale > 60_000) retries.add(`retry:${boundary(node)}:${name}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) {
      if (/(?:retryAfter|retry_at|retryAt)(?:Ms|Seconds)?$/i.test(boundary(node))) retry(node, 'return', node.expression);
      // Object fields are checked by their role below; unrelated ids, migration
      // names and UI copy in a returned object are not wait reasons.
      const returnedIds = new Set<string>();
      const returned = (value: ts.Expression): void => {
        if (ts.isIdentifier(value) && declarations.has(value.text) && !returnedIds.has(value.text)) { returnedIds.add(value.text); returned(declarations.get(value.text)!); }
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) literals(value);
        else if (ts.isConditionalExpression(value)) { returned(value.whenTrue); returned(value.whenFalse); }
        else if (ts.isParenthesizedExpression(value)) returned(value.expression);
        else if (ts.isCallExpression(value) && /(?:wait|defer|fail|stop|guard)/i.test(value.expression.getText(file))) {
          for (const argument of value.arguments) if (ts.isStringLiteral(argument)) literals(argument);
        }
      };
      returned(node.expression);
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)
      && (ts.isStringLiteral(node.body) || ts.isConditionalExpression(node.body))) literals(node.body);
    if (ts.isShorthandPropertyAssignment(node) && reasonSlot.test(node.name.text)) literals(node.name);
    if ((ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer) {
      const name = propertyName(node.name);
      if (reasonSlot.test(name)) literals(node.initializer);
      if (retrySlot.test(name)) retry(node, name, node.initializer);
      if (name === 'at' && ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)
        && ts.isPropertyAssignment(node.parent.parent) && retrySlot.test(propertyName(node.parent.parent.name))) retry(node, 'retryAt_at', node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = ts.isPropertyAccessExpression(node.left) ? node.left.name.text : ts.isElementAccessExpression(node.left) ? propertyName(node.left.argumentExpression) : propertyName(node.left);
      if (reasonSlot.test(name)) literals(node.right);
      if (retrySlot.test(name)) retry(node, name, node.right);
    }
    if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression)
      && /(?:Guard|Budget|Wait|Cap)Error$/.test(node.expression.expression.getText(file))) {
      for (const argument of node.expression.arguments ?? []) literals(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { reasons, retries };
}

let silentCache: { found: Set<string>; covered: Set<string> } | undefined;
function silentInventory() {
  if (silentCache) return silentCache;
  const found = new Set<string>(), covered = new Set<string>(), registrations = new Set<string>();
  const files = readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map(entry => ({ path: relative(root, join(entry.parentPath, entry.name)), source: readFileSync(join(entry.parentPath, entry.name), 'utf8') }));
  // Literal registration ids and the scheduler adapter's reason keys are both authorities.
  for (const { source, path } of files) {
    const file = syntax(source);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerLimit') {
        const arg = node.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) for (const prop of arg.properties) {
          if (ts.isPropertyAssignment(prop) && propertyName(prop.name) === 'id' && ts.isStringLiteral(prop.initializer)) registrations.add(prop.initializer.text);
        }
      }
      if (ts.isVariableDeclaration(node) && propertyName(node.name) === 'DAILY_LIMITS' && node.initializer) {
        const keys = (child: ts.Node): void => {
          if (ts.isPropertyAssignment(child)) {
            if (ts.isObjectLiteralExpression(child.initializer)) registrations.add(propertyName(child.name));
            if (propertyName(child.name) === 'id' && ts.isStringLiteral(child.initializer)) registrations.add(child.initializer.text);
          }
          ts.forEachChild(child, keys);
        };
        keys(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  for (const { source, path } of files) {
    const { reasons, retries } = silentStops(source, path.startsWith('src/workers/'));
    for (const symbol of [...reasons, ...retries]) {
      const key = `${path}#${symbol}`;
      found.add(key);
      if (symbol.startsWith('reason:') && registrations.has(symbol.slice(7))) covered.add(key);
    }
    // Each retry tie names an exact producing boundary and a real registration.
    for (const match of source.matchAll(/limit-retry: (retry:[\w:]+) -> ([\w.]+)/g)) {
      expect(registrations.has(match[2]!)).toBe(true);
      expect(found.has(`${path}#${match[1]}`), 'stale retry tie').toBe(true);
      covered.add(`${path}#${match[1]}`);
    }
  }
  return silentCache = { found, covered };
}

test('silent stop reasons and long retry computations are registered or explicitly inventoried', () => {
  const { found, covered } = silentInventory();
  const allowed = allowlist.filter(entry => /^(reason|retry):/.test(entry.symbol));
  for (const entry of allowed) {
    expect(entry.reason.trim().length).toBeGreaterThan(0);
    expect(entry.retire_when.trim().length).toBeGreaterThan(0);
    const key = `${entry.path}#${entry.symbol}`;
    expect(found.has(key) && !covered.has(key), `stale silent-stop allowance ${key}`).toBe(true);
    covered.add(key);
  }
  expect(unregistered(found, covered), 'silent stops').toEqual([]);
});

test('planted silent deferrals and unbounded retries fail even alongside a registered guard', () => {
  const source = `registerLimit({ id: 'known' });
    function defer() { return { degradedReason: 'planted_budget_spent', retry_at: new Date(Date.now() + 120_000).toISOString() }; }
    function wait() { const reason = 'planted_quota'; return reason; }
    const inline = () => 'planted_cap_reached';
    function timestampShort() { return { retry_at: new Date(Date.now() + 60_000).toISOString() }; }
    function nested() { return { retryAt: { at: new Date(Date.now() + 120_000).toISOString() } }; }
    function short() { const retryAfter = 60; return { retryAfterSeconds: retryAfter }; }
    // return { reason: 'comment_cap' };
    const words = 'return allowance';`;
  const found = silentStops(source);
  expect([...found.reasons].sort()).toEqual(['reason:planted_budget_spent', 'reason:planted_cap_reached', 'reason:planted_quota']);
  expect([...found.retries]).toEqual(['retry:defer:retry_at', 'retry:nested:retryAt_at']);
  expect(unregistered(new Set([...found.reasons, ...found.retries]), new Set())).toHaveLength(5);
});

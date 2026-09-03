import ts from 'typescript';

const SPAWN_APIS = new Set([
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'spawn',
  'spawnSync',
]);

type FunctionLike = ts.ArrowFunction
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration;

export interface SpawningTest {
  end: number;
  hasExplicitTimeout: boolean;
  line: number;
  name: string;
  timeoutText?: string;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function functionName(node: FunctionLike): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  const parent = node.parent;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
    ? parent.name.text
    : undefined;
}

function calledIdentifier(call: ts.CallExpression): string | undefined {
  return ts.isIdentifier(call.expression) ? call.expression.text : undefined;
}

function isBunSpawn(call: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression)
    && call.expression.expression.text === 'Bun'
    && (call.expression.name.text === 'spawn' || call.expression.name.text === 'spawnSync');
}

function isNamespaceSpawn(call: ts.CallExpression, namespaces: ReadonlySet<string>): boolean {
  return ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression)
    && namespaces.has(call.expression.expression.text)
    && SPAWN_APIS.has(call.expression.name.text);
}

function isTestCall(call: ts.CallExpression): boolean {
  if (ts.isIdentifier(call.expression)) {
    return call.expression.text === 'test' || call.expression.text === 'it';
  }
  return ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression)
    && (call.expression.expression.text === 'test' || call.expression.expression.text === 'it');
}

function testName(call: ts.CallExpression, sourceFile: ts.SourceFile): string {
  const name = call.arguments[0];
  return name && ts.isStringLiteralLike(name)
    ? name.text
    : `<test at line ${lineOf(sourceFile, call)}>`;
}

export function scanSpawningTests(relativePath: string, sourceText: string): SpawningTest[] {
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const directSpawnIdentifiers = new Set<string>();
  const childProcessNamespaces = new Set<string>();
  const functions = new Map<string, FunctionLike>();
  const testCalls: ts.CallExpression[] = [];

  function collect(node: ts.Node): void {
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && (node.moduleSpecifier.text === 'node:child_process'
        || node.moduleSpecifier.text === 'child_process')) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        childProcessNamespaces.add(bindings.name.text);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (SPAWN_APIS.has(imported)) directSpawnIdentifiers.add(element.name.text);
        }
      }
    }
    if (ts.isFunctionDeclaration(node)
      || ts.isMethodDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node)) {
      const name = functionName(node);
      if (name) functions.set(name, node);
    }
    if (ts.isCallExpression(node) && isTestCall(node)) testCalls.push(node);
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);

  const directSpawners = new Set<string>();
  const callsByFunction = new Map<string, Set<string>>();

  function scanFunction(name: string, fn: FunctionLike): void {
    const calls = new Set<string>();
    let directlySpawns = false;
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const called = calledIdentifier(node);
        if (called) calls.add(called);
        if (isBunSpawn(node)
          || isNamespaceSpawn(node, childProcessNamespaces)
          || (called !== undefined && directSpawnIdentifiers.has(called))) {
          directlySpawns = true;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(fn);
    callsByFunction.set(name, calls);
    if (directlySpawns) directSpawners.add(name);
  }

  for (const [name, fn] of functions) scanFunction(name, fn);

  const spawningFunctions = new Set(directSpawners);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, calls] of callsByFunction) {
      if (spawningFunctions.has(name)) continue;
      if ([...calls].some((called) => spawningFunctions.has(called))) {
        spawningFunctions.add(name);
        changed = true;
      }
    }
  }

  const spawningTests: SpawningTest[] = [];
  for (const call of testCalls) {
    const callback = call.arguments[1];
    if (!callback) continue;
    let spawns = false;
    if (ts.isIdentifier(callback)) {
      spawns = spawningFunctions.has(callback.text);
    } else if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
      const syntheticName = `__test_${lineOf(sourceFile, call)}`;
      scanFunction(syntheticName, callback);
      const calls = callsByFunction.get(syntheticName) ?? new Set();
      spawns = directSpawners.has(syntheticName)
        || [...calls].some((called) => spawningFunctions.has(called));
    }
    if (spawns) {
      const timeout = call.arguments[2];
      spawningTests.push({
        end: call.end,
        hasExplicitTimeout: call.arguments.length >= 3,
        line: lineOf(sourceFile, call),
        name: testName(call, sourceFile),
        ...(timeout ? { timeoutText: timeout.getText(sourceFile) } : {}),
      });
    }
  }
  return spawningTests;
}

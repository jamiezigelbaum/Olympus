/**
 * Only the layout module (core/olympus-layout.ts) builds a data path
 * (docs/design/source-storage.md, delivery step 6): every other module asks it
 * for a file by what the file is (`sharedDataPath`, `accountStorePath`,
 * `accountRawPath`, the storage service's resolvers) and never extends a data
 * root itself or spells a file name the layout owns. And the per-store path
 * overrides owner decision 3 dropped stay dropped: no `OLYMPUS_*_DB_PATH` is
 * read anywhere in src/.
 *
 * Reads the parsed files, so a comment neither counts nor hides anything.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { SHARED_DATA_FILES } from '../src/core/olympus-layout.ts';

const ROOT = join(import.meta.dir, '..');
const LAYOUT = 'src/core/olympus-layout.ts';

// The layout module, and the receipt reader it takes the standalone Linux data
// root from (it computes the receipt's roots, which the layout module reads).
// The list only shrinks.
const EXEMPT: Record<string, string> = {
  [LAYOUT]: 'the layout module itself',
  'src/core/linux-engine-layout.ts': 'the standalone Linux install receipt, which names the data root the layout module reads',
};

// The layout module's roots. Extending one (`join(root, ...)`) builds a data path.
const ROOT_FUNCTIONS = new Set([
  'olympusDataRoot',
  'legacyCaptureDataRoot',
  'xdgDataHome',
  'olympusStateRoot',
  'accountFoldersRoot',
  'accountTrashRoot',
  'accountFolder',
  'standaloneLinuxDataDir',
]);
const PATH_BUILDERS = new Set(['join', 'resolve']);

const FILE_NAME = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.(?:sqlite|db|json|jsonl|lock)$/;

/** Every file name the layout module spells (a name with an extension), every shared file's among them. */
function layoutFileNames(): Set<string> {
  const names = new Set<string>(Object.values(SHARED_DATA_FILES).filter((name) => FILE_NAME.test(name)));
  const file = parse(readFileSync(join(ROOT, LAYOUT), 'utf8'));
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && FILE_NAME.test(node.text)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/**
 * The declaration a name refers to at this point, looked up through the
 * enclosing blocks, functions and the file: a parameter or a variable.
 */
function declarationOf(node: ts.Identifier): ts.VariableDeclaration | ts.ParameterDeclaration | undefined {
  const named = (name: ts.BindingName): boolean => ts.isIdentifier(name) && name.text === node.text;
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find((candidate) => named(candidate.name));
      if (parameter) return parameter;
    }
    const statements = ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) ? scope.statements : undefined;
    for (const statement of statements ?? []) {
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find((candidate) => named(candidate.name));
      if (declaration) return declaration;
    }
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope))
      && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
      const declaration = scope.initializer.declarations.find((candidate) => named(candidate.name));
      if (declaration) return declaration;
    }
  }
  return undefined;
}

// A raw-state name is a key the layout resolves (`accountRawPath(account, 'x-reconcile.sqlite')`,
// `archiveStateSiblingPath(state, 'archive-media-bindings.sqlite')`), not a path.
const RAW_RESOLVER = /(?:[Rr]awPath|StateSiblingPath)$/;

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('guard.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/** Where a module builds a data path or names a dropped override, as `line: what`. */
function dataPathFindings(source: string, fileNames: ReadonlySet<string>, options: { exempt?: boolean } = {}): string[] {
  const file = parse(source);
  const findings: string[] = [];
  const at = (node: ts.Node, what: string): void => {
    findings.push(`${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${what}`);
  };
  // A root, or a name bound to one where it is used (`const root = olympusDataRoot(env)`).
  const isRoot = (node: ts.Expression, depth = 0): boolean => {
    while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) node = node.expression;
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      return name !== undefined && ROOT_FUNCTIONS.has(name);
    }
    if (!ts.isIdentifier(node) || depth > 4) return false;
    const declaration = declarationOf(node);
    return declaration !== undefined && ts.isVariableDeclaration(declaration)
      && declaration.initializer !== undefined && isRoot(declaration.initializer, depth + 1);
  };
  const rawKey = (node: ts.Node): boolean => {
    const call = node.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(node as ts.Expression)) return false;
    const name = calleeName(call.expression);
    return name !== undefined && RAW_RESOLVER.test(name);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      if (/^OLYMPUS_\w+_DB_PATH$/.test(node.text) || node.text === 'OLYMPUS_ARCHIVE_IMPORTS_STATE_PATH') {
        at(node, `reads the dropped override ${node.text}`);
      } else if (!options.exempt && fileNames.has(node.text) && !rawKey(node)) {
        at(node, `spells the layout's file name ${node.text}`);
      } else if (!options.exempt && /(?:^|\/)openclaw\/olympus(?:\/|$)/.test(node.text)) {
        at(node, `spells the data root (${node.text})`);
      }
    } else if (!options.exempt && ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const [first, ...rest] = node.arguments;
      if (name && PATH_BUILDERS.has(name) && first && rest.length > 0 && isRoot(first)) {
        at(node, `extends a data root with ${name}()`);
      }
      const literals = node.arguments.map((argument) => (ts.isStringLiteralLike(argument) ? argument.text : undefined));
      if (name && PATH_BUILDERS.has(name) && literals.some((text, index) => text === 'openclaw' && literals[index + 1] === 'olympus')) {
        at(node, 'spells the data root (openclaw, olympus)');
      }
    } else if (!options.exempt && ts.isTemplateExpression(node)) {
      if (node.templateSpans.some((span) => isRoot(span.expression) && /^\/./.test(span.literal.text))) {
        at(node, 'extends a data root in a template string');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(?:ts|tsx|mts)$/.test(entry.name) ? [path] : [];
  });
}

describe('data path guard', () => {
  const names = new Set(['source-dashboard.sqlite', 'registry.json']);

  test('the guard sees every way of building a data path', () => {
    for (const spelling of [
      "const path = join(olympusDataRoot(env), 'stores', 'x.sqlite');",
      "const root = olympusDataRoot(env);\nconst path = join(root, 'x.sqlite');",
      "const path = resolve(legacyCaptureDataRoot(env), 'whatsapp-live');",
      "const path = path.join(accountFolder(account, env), 'raw', 'x');",
      "const path = join(xdgDataHome(env)!, 'olympus');",
      'const path = `${olympusDataRoot(env)}/x.sqlite`;',
      "const file = 'source-dashboard.sqlite';",
      "const path = join(home, '.local', 'share', 'openclaw', 'olympus');",
      "const path = '/home/me/.local/share/openclaw/olympus';",
      "const configured = env.OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_DB_PATH;",
      "const configured = env['OLYMPUS_REMOTE_CONNECTIONS_DB_PATH'];",
      "const configured = env['OLYMPUS_ARCHIVE_IMPORTS_STATE_PATH'];",
    ]) {
      // A property access by identifier is not a literal: spell it as one, like a reader would.
      const source = spelling.replace(/env\.(OLYMPUS_\w+)/, "env['$1']");
      expect(dataPathFindings(source, names).length, spelling).toBeGreaterThan(0);
    }
  });

  test('the guard ignores comments, the resolvers and roots used whole', () => {
    for (const spelling of [
      "// join(olympusDataRoot(env), 'x.sqlite')",
      "/* 'source-dashboard.sqlite' */ const x = 1;",
      "const path = sharedDataPath('source-dashboard', env);",
      "const path = accountStorePath(account, 'internal', env);",
      'const root = olympusDataRoot(env);\nif (!isAbsolute(root)) throw new Error(root);',
      'const same = resolve(olympusDataRoot(env));',
      "const session = join(accountRawPath(account, 'whatsapp', env), 'session.db');",
      "const state = resolvedRawPath('x.bookmarks', 'source-dashboard.sqlite', env);",
      'const stop = accountFoldersRoot(env);\nconst inside = (path: string) => path.startsWith(`${stop}${sep}`);',
      "const root = olympusDataRoot(env);\nfunction list(root: string) { return join(root, 'x'); }",
    ]) expect(dataPathFindings(spelling, names), spelling).toEqual([]);
  });

  test('no src/ module outside the layout module builds a data path, and no dropped override is read', () => {
    const fileNames = layoutFileNames();
    const found: Record<string, string[]> = {};
    for (const path of sourceFiles(join(ROOT, 'src'))) {
      const name = relative(ROOT, path);
      const findings = dataPathFindings(readFileSync(path, 'utf8'), fileNames, { exempt: name in EXEMPT });
      if (findings.length > 0) found[name] = findings;
    }
    expect(found, 'ask core/olympus-layout.ts for the path (sharedDataPath, accountStorePath, accountRawPath, ...)').toEqual({});
  });

  test('the exemptions are still the layout module and its receipt reader', () => {
    for (const path of Object.keys(EXEMPT)) expect(readFileSync(join(ROOT, path), 'utf8').length).toBeGreaterThan(0);
    expect(readFileSync(join(ROOT, LAYOUT), 'utf8')).not.toMatch(/export function olympusDataPath\b/);
  });
});

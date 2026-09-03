import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const CONTRACT_EXPORTS = [
  'RawItemContent',
  'RawItem',
  'SourceConnectorListOptions',
  'SourceConnectorListPage',
  'SourceConnector',
  'EvidenceTableBlock',
  'EvidenceCandidate',
  'EvidenceCoverageSkip',
  'EvidenceCoverage',
  'EvidencePack',
  'AnalystOptions',
  'AnalystCitation',
  'AnalystEscalation',
  'AnalystResult',
  'Analyst',
] as const;

export interface ContractSourceFiles {
  contracts: string;
  sourceIndexTypes: string;
  opsec: string;
}

export interface ContractVersionEntry {
  version: string;
  fingerprint: string;
  recordedAt: string;
  compatibility: string;
  migrationReceipt: string;
  evalReceipt: string;
  reviewReceipt: string;
}

export interface ContractVersionLedger {
  schemaVersion: 1;
  contracts: 'SourceConnector+EvidencePack+Analyst';
  fingerprintScope: 'reachable_types_v2';
  history: ContractVersionEntry[];
}

export function snapshotContractExports(content: string): string {
  return CONTRACT_EXPORTS.map((name) => extractExportDeclaration(content, name)).join('\n\n');
}

export function snapshotReachableContractSources(sources: ContractSourceFiles): string {
  const graph = createContractSourceGraph(sources);
  return CONTRACT_EXPORTS.map((name) => graph.snapshot('contracts.ts', name)).join('\n\n');
}

export function contractFingerprint(sources: ContractSourceFiles): string {
  return `sha256:${createHash('sha256').update(snapshotReachableContractSources(sources)).digest('hex')}`;
}

export function validateContractVersion(
  sources: ContractSourceFiles,
  ledger: ContractVersionLedger,
): ContractVersionEntry {
  if (
    ledger.schemaVersion !== 1
    || ledger.contracts !== 'SourceConnector+EvidencePack+Analyst'
    || ledger.fingerprintScope !== 'reachable_types_v2'
  ) {
    throw new Error('Unsupported source-pipeline contract ledger.');
  }
  if (!Array.isArray(ledger.history) || ledger.history.length === 0) {
    throw new Error('Contract ledger must contain at least one version entry.');
  }

  let previous: ContractVersionEntry | undefined;
  for (const entry of ledger.history) {
    if (!/^\d+\.\d+\.\d+$/.test(entry.version)) {
      throw new Error(`Contract version ${entry.version} is not semantic x.y.z form.`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(entry.fingerprint)) {
      throw new Error(`Contract version ${entry.version} has an invalid fingerprint.`);
    }
    for (const field of ['recordedAt', 'compatibility', 'migrationReceipt', 'evalReceipt', 'reviewReceipt'] as const) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        throw new Error(`Contract version ${entry.version} is missing ${field}.`);
      }
    }
    if (previous) {
      if (compareSemver(entry.version, previous.version) <= 0) {
        throw new Error(`Contract version ${entry.version} must be greater than ${previous.version}.`);
      }
      if (entry.fingerprint === previous.fingerprint) {
        throw new Error(`Contract version ${entry.version} does not change the contract fingerprint.`);
      }
    }
    previous = entry;
  }

  const latest = ledger.history.at(-1)!;
  const actual = contractFingerprint(sources);
  if (latest.fingerprint !== actual) {
    throw new Error(
      `Contract shape drifted without a complete version entry: expected ${latest.fingerprint}, got ${actual}.`,
    );
  }
  return latest;
}

export function extractExportDeclaration(content: string, name: string): string {
  const source = parseTypeScriptSource(content, name);
  const declarations = source.statements.filter((statement) =>
    (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
    && statement.name.text === name);
  if (declarations.length === 0) throw new Error(`Missing versioned contract export ${name}`);
  if (declarations.length > 1) {
    throw new Error(
      `Versioned contract ${name} is declared ${declarations.length} times; `
        + 'declaration merging changes the contract shape',
    );
  }
  return canonicalTypeScriptNode(declarations[0]!, source);
}

type ContractSourceName = 'contracts.ts' | 'source-index/types.ts' | 'opsec.ts';

interface ContractSourceUnit {
  source: ts.SourceFile;
  declarations: Map<string, ts.Statement[]>;
  unsupportedDeclarations: Map<string, string>;
  imports: Map<string, { importedName: string; moduleName: string }>;
}

function createContractSourceGraph(sources: ContractSourceFiles): {
  snapshot(sourceName: ContractSourceName, name: string): string;
} {
  const units: Record<ContractSourceName, ContractSourceUnit> = {
    'contracts.ts': contractSourceUnit(sources.contracts, 'contracts.ts'),
    'source-index/types.ts': contractSourceUnit(sources.sourceIndexTypes, 'source-index/types.ts'),
    'opsec.ts': contractSourceUnit(sources.opsec, 'opsec.ts'),
  };
  const visited = new Set<string>();
  const parts: string[] = [];

  const visit = (sourceName: ContractSourceName, name: string, required: boolean): void => {
    const unit = units[sourceName];
    const declarations = unit.declarations.get(name) ?? [];
    if (declarations.length > 1) {
      throw new Error(`Versioned contract ${name} is declared ${declarations.length} times; declaration merging changes the contract shape`);
    }
    if (declarations.length === 0) {
      const unsupported = unit.unsupportedDeclarations.get(name);
      if (unsupported) {
        throw new Error(`Reachable contract declaration ${sourceName}:${name} uses unsupported ${unsupported}.`);
      }
      const imported = unit.imports.get(name);
      if (!imported) {
        if (required) throw new Error(`Missing reachable contract declaration ${sourceName}:${name}`);
        return;
      }
      const target = resolveContractImport(sourceName, imported.moduleName);
      if (!target) {
        throw new Error(`Reachable contract type ${sourceName}:${name} imports untracked module ${imported.moduleName}.`);
      }
      visit(target, imported.importedName, true);
      return;
    }

    const statement = declarations[0]!;
    const nodeKey = `${sourceName}:${statement.pos}:${statement.end}`;
    if (visited.has(nodeKey)) return;
    visited.add(nodeKey);
    parts.push(`[${sourceName}:${name}]\n${canonicalTypeScriptNode(statement, unit.source)}`);
    for (const reference of referencedTypeNames(statement)) visit(sourceName, reference, false);
  };

  return {
    snapshot(sourceName, name) {
      visit(sourceName, name, true);
      const snapshot = parts.join('\n\n');
      parts.length = 0;
      visited.clear();
      return snapshot;
    },
  };
}

function contractSourceUnit(content: string, sourceName: ContractSourceName): ContractSourceUnit {
  const source = parseTypeScriptSource(content, sourceName);
  const declarations = new Map<string, ts.Statement[]>();
  const unsupportedDeclarations = new Map<string, string>();
  const imports = new Map<string, { importedName: string; moduleName: string }>();
  const addDeclaration = (name: string, statement: ts.Statement): void => {
    declarations.set(name, [...(declarations.get(name) ?? []), statement]);
  };
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      addDeclaration(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) addDeclaration(declaration.name.text, statement);
      }
    } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        imports.set(element.name.text, {
          importedName: element.propertyName?.text ?? element.name.text,
          moduleName: statement.moduleSpecifier.text,
        });
      }
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      unsupportedDeclarations.set(statement.name.text, 'class declaration');
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      unsupportedDeclarations.set(statement.name.text, 'function declaration');
    } else if (ts.isModuleDeclaration(statement)) {
      unsupportedDeclarations.set(statement.name.text, 'module declaration');
    }
  }
  return { source, declarations, unsupportedDeclarations, imports };
}

function resolveContractImport(
  sourceName: ContractSourceName,
  moduleName: string,
): ContractSourceName | undefined {
  if (sourceName === 'contracts.ts' && moduleName === './source-index/types.ts') return 'source-index/types.ts';
  if (sourceName === 'contracts.ts' && moduleName === './opsec.ts') return 'opsec.ts';
  if (sourceName === 'opsec.ts' && moduleName === './source-index/types.ts') return 'source-index/types.ts';
  return undefined;
}

function referencedTypeNames(node: ts.Node): string[] {
  const names = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isTypeReferenceNode(child)) {
      if (!ts.isIdentifier(child.typeName)) throw new Error('Reachable contract types must use named imports, not qualified names.');
      names.add(child.typeName.text);
    }
    if (ts.isExpressionWithTypeArguments(child)) {
      if (!ts.isIdentifier(child.expression)) throw new Error('Reachable contract heritage must use a named type.');
      names.add(child.expression.text);
    }
    if (ts.isTypeQueryNode(child)) {
      if (!ts.isIdentifier(child.exprName)) throw new Error('Reachable contract typeof queries must use a named declaration.');
      names.add(child.exprName.text);
    }
    if (ts.isImportTypeNode(child)) throw new Error('Reachable contract types must not use inline import types.');
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return [...names];
}

function parseTypeScriptSource(content: string, name: string): ts.SourceFile {
  const source = ts.createSourceFile(
    `${name}.ts`,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    throw new Error(`Versioned contract dependency ${name} cannot be parsed.`);
  }
  return source;
}

function canonicalTypeScriptNode(node: ts.Node, source: ts.SourceFile): string {
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
  });
  return printer.printNode(ts.EmitHint.Unspecified, node, source).trim();
}

function compareSemver(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  }
  return 0;
}

if (import.meta.main) {
  const root = join(fileURLToPath(new URL('..', import.meta.url)));
  const sources: ContractSourceFiles = {
    contracts: readFileSync(join(root, 'src/core/contracts.ts'), 'utf8'),
    sourceIndexTypes: readFileSync(join(root, 'src/core/source-index/types.ts'), 'utf8'),
    opsec: readFileSync(join(root, 'src/core/opsec.ts'), 'utf8'),
  };
  if (process.argv.includes('--print-fingerprint')) {
    console.log(contractFingerprint(sources));
  } else {
    const ledger = JSON.parse(
      readFileSync(join(root, 'config/source-pipeline-contract-version.json'), 'utf8'),
    ) as ContractVersionLedger;
    const latest = validateContractVersion(sources, ledger);
    console.log(`Source-pipeline contracts ${latest.version} ${latest.fingerprint}`);
  }
}

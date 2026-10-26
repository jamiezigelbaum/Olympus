import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  contractFingerprint,
  extractExportDeclaration,
  type ContractVersionLedger,
  validateContractVersion,
} from '../scripts/contract-version.ts';

const repoRoot = join(import.meta.dir, '..');
const sources = {
  contracts: readFileSync(join(repoRoot, 'src/core/contracts.ts'), 'utf8'),
  sourceIndexTypes: readFileSync(join(repoRoot, 'src/core/source-index/types.ts'), 'utf8'),
  opsec: readFileSync(join(repoRoot, 'src/core/opsec.ts'), 'utf8'),
};
const ledger = JSON.parse(
  readFileSync(join(repoRoot, 'config/source-pipeline-contract-version.json'), 'utf8'),
) as ContractVersionLedger;

describe('versioned source-pipeline contracts', () => {
  test('current shapes match the latest complete version entry', () => {
    const latest = validateContractVersion(sources, ledger);
    expect(latest.version).toBe('2.2.0');
    expect(latest.fingerprint).toBe(contractFingerprint(sources));
  });

  test('shape drift without a new ledger entry is rejected', () => {
    const changed = { ...sources, contracts: sources.contracts.replace('question: string;', 'question: string;\n  locale?: string;') };
    expect(() => validateContractVersion(changed, ledger)).toThrow(/shape drifted without a complete version entry/);
  });

  test('a new version requires compatibility, migration, eval, and review receipts', () => {
    const changed = { ...sources, contracts: sources.contracts.replace('question: string;', 'question: string;\n  locale?: string;') };
    const incomplete = structuredClone(ledger);
    incomplete.history.push({
      version: '2.3.0',
      fingerprint: contractFingerprint(changed),
      recordedAt: '2026-08-29',
      compatibility: '',
      migrationReceipt: '',
      evalReceipt: '',
      reviewReceipt: '',
    });
    expect(() => validateContractVersion(changed, incomplete)).toThrow(/missing compatibility/);
  });

  test('a complete, increasing version entry accepts an intentional shape change', () => {
    const changed = { ...sources, contracts: sources.contracts.replace('question: string;', 'question: string;\n  locale?: string;') };
    const updated = structuredClone(ledger);
    updated.history.push({
      version: '2.3.0',
      fingerprint: contractFingerprint(changed),
      recordedAt: '2026-08-29',
      compatibility: 'Optional field; existing producers and consumers remain compatible.',
      migrationReceipt: 'No stored data migration required.',
      evalReceipt: 'Fixture receipt for gate behavior.',
      reviewReceipt: 'Fixture independent review receipt.',
    });
    expect(validateContractVersion(changed, updated).version).toBe('2.3.0');
  });

  test('reachable imported type drift is rejected without a new version entry', () => {
    const changed = {
      ...sources,
      sourceIndexTypes: sources.sourceIndexTypes.replace(
        'providerItemId: string;',
        'providerItemId: string;\n  importedContractDrift: string;',
      ),
    };
    expect(() => validateContractVersion(changed, ledger))
      .toThrow(/shape drifted without a complete version entry/);
  });

  test('reachable imported JSDoc does not create semantic contract drift', () => {
    const changed = {
      ...sources,
      sourceIndexTypes: sources.sourceIndexTypes.replace(
        '/** Inclusive start offset within the chunk\'s bounded text. */',
        '/** Documentation-only wording changed. */',
      ),
    };
    expect(contractFingerprint(changed)).toBe(contractFingerprint(sources));
  });

  test('reachable imported whitespace does not create semantic contract drift', () => {
    const changed = {
      ...sources,
      sourceIndexTypes: sources.sourceIndexTypes.replace(
        'providerItemId: string;',
        'providerItemId:  string;',
      ),
    };
    expect(contractFingerprint(changed)).toBe(contractFingerprint(sources));
  });

  test('reachable imported constant formatting does not create semantic contract drift', () => {
    const changed = {
      ...sources,
      sourceIndexTypes: sources.sourceIndexTypes.replace(
        "['email', 'file', 'chat', 'calendar', 'note', 'task', 'readwise', 'x']",
        "[ 'email',  'file', 'chat', 'calendar', 'note', 'task', 'readwise', 'x' ]",
      ),
    };
    expect(contractFingerprint(changed)).toBe(contractFingerprint(sources));
  });

  test('documentation that names a reachable type is not parsed as a declaration', () => {
    const changed = {
      ...sources,
      sourceIndexTypes: sources.sourceIndexTypes.replace(
        'export interface SourceItemIdentity {',
        '// Documentation may discuss the type SourceSensitivity without declaring it.\nexport interface SourceItemIdentity {',
      ),
    };
    expect(contractFingerprint(changed)).toBe(contractFingerprint(sources));
  });

  test('redirecting a reachable import is refused until the dependency graph tracks it', () => {
    const changed = {
      ...sources,
      contracts: sources.contracts.replace(
        "from './source-index/types.ts';",
        "from './source-index/alternate-types.ts';",
      ),
    };
    expect(() => contractFingerprint(changed)).toThrow(/imports untracked module/);
  });

  test('a new imported type is refused until its declaration joins the snapshot', () => {
    const changed = {
      ...sources,
      contracts: sources.contracts
        .replace('  SourceFamily,', '  NewlyReachableType,\n  SourceFamily,')
        .replace('export interface RawItem {', 'export interface RawItem {\n  newlyReachable: NewlyReachableType;'),
    };
    expect(() => contractFingerprint(changed)).toThrow(/Missing reachable contract declaration/);
  });

  test('an unrelated dependency-module import does not change a frozen shape', () => {
    const changed = {
      ...sources,
      sourceIndexTypes: "import type { RuntimeOnly } from './runtime-only.ts';\n" + sources.sourceIndexTypes,
    };
    expect(contractFingerprint(changed)).toBe(contractFingerprint(sources));
  });

  test('qualified reachable types fail closed instead of escaping traversal', () => {
    const changed = {
      ...sources,
      contracts: sources.contracts
        .replace("import type { StructuredEvidenceFact } from './opsec.ts';", "import type { StructuredEvidenceFact } from './opsec.ts';\nimport type * as Hidden from './hidden.ts';")
        .replace('export interface RawItem {', 'export interface RawItem {\n  hidden?: Hidden.SemanticType;'),
    };
    expect(() => contractFingerprint(changed)).toThrow(/must use named imports/);
  });

  test('new reachable enums are traversed and their later semantic edits are fingerprinted', () => {
    const withEnum = {
      ...sources,
      contracts: sources.contracts
        .replace('  SourceFamily,', '  ReachableMode,\n  SourceFamily,')
        .replace('export interface RawItem {', 'export interface RawItem {\n  mode: ReachableMode;'),
      sourceIndexTypes: sources.sourceIndexTypes + "\nexport enum ReachableMode { One = 'one' }\n",
    };
    const changedEnum = {
      ...withEnum,
      sourceIndexTypes: withEnum.sourceIndexTypes.replace("One = 'one'", "One = 'changed'"),
    };
    expect(contractFingerprint(changedEnum)).not.toBe(contractFingerprint(withEnum));
  });

  test('declaration merging cannot change a contract outside the fingerprint', () => {
    const merged = [
      'export interface EvidencePack {',
      '  question: string;',
      '}',
      '',
      'interface EvidencePack {',
      '  rawProviderPayload: unknown;',
      '}',
    ].join('\n');
    expect(() => extractExportDeclaration(merged, 'EvidencePack')).toThrow(/declared 2 times/);
  });

  test('2.2.0: the inputs, the lookup and the per-item hold are part of the fingerprint', () => {
    const drift = (from: string, to: string) => {
      expect(sources.contracts).toContain(from);
      return contractFingerprint({ ...sources, contracts: sources.contracts.replace(from, to) });
    };
    const base = contractFingerprint(sources);
    expect(drift('holdContentUntilJudged?: true;', 'holdContentUntilJudged?: boolean;')).not.toBe(base);
    expect(drift('forInput?(input: SourceConnectorInput): SourceConnector;', 'forInput?(input: SourceConnectorInput): void;')).not.toBe(base);
    expect(drift('storedItem?: StoredItemLookup;', 'storedItem?: () => undefined;')).not.toBe(base);
    expect(drift('export type SourceInputKind = \'live\' | \'archive\';', 'export type SourceInputKind = \'live\' | \'archive\' | \'other\';')).not.toBe(base);
    expect(drift('hasContent: boolean;', 'hasContent?: boolean;')).not.toBe(base);
  });

  test('2.2.0: every addition is optional, so a 2.1.0 connector and consumer still satisfy the interfaces', () => {
    // The interface members the 2.2.0 entry adds are all optional or new types: none can break a producer or consumer that ignores them.
    for (const added of ['holdContentUntilJudged?:', 'storedItem?:', 'forInput?(']) {
      expect(sources.contracts).toContain(added);
    }
    const connector = extractExportDeclaration(sources.contracts, 'SourceConnector');
    expect(connector).toContain('forInput?');
    expect(connector).not.toMatch(/\bforInput\(/);
    const listOptions = extractExportDeclaration(sources.contracts, 'SourceConnectorListOptions');
    expect(listOptions).toContain('storedItem?');
    const entry = ledger.history.at(-1)!;
    expect(entry.compatibility).toContain('Additive and optional');
    expect(entry.evalReceipt).toContain('no exception is claimed');
  });
});

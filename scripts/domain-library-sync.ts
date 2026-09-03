// One-shot ingest for the domain agent library registry: reads the domain
// workspace source-registry.jsonl through DomainLibrarySourceConnector and
// syncs eligible derivatives into the shared connector store. Point the
// source worker at the same db via OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON:
//
//   [{"dbPath":"/path/to/connector-store.db","corpusId":"internal.solon.agent-library","family":"file","trustDomain":"internal"}]
//
// Output is counts/provenance status only; derivative text never prints.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectorStore, type ConnectorStoreSyncSummary } from '../src/workers/connector-store/index.ts';
import {
  DOMAIN_LIBRARY_DEFAULT_ACCOUNT,
  DOMAIN_LIBRARY_PROVIDER,
  createDomainLibrarySourceConnector,
  readDomainLibraryConnectorStatus,
  type DomainLibraryConnectorStatus,
} from '../src/workers/domain-library/index.ts';

export const DOMAIN_LIBRARY_CORPUS_ID = 'internal.solon.agent-library';
const DEFAULT_WORKSPACE_ROOT = join(homedir(), '.openclaw', 'workspace-solon');
const DEFAULT_REGISTRY_RELATIVE_PATH = 'castor-solon/references/source-registry.jsonl';
const DEFAULT_STATE_DIR = join(homedir(), '.local', 'share', 'olympus', 'domain-library');

export interface DomainLibrarySyncOptions {
  workspaceRoot: string;
  registryRelativePath?: string;
  dbPath?: string;
  account?: string;
  maxItems?: number;
  pageLimit?: number;
}

export interface DomainLibrarySyncResult {
  summary: ConnectorStoreSyncSummary;
  registry: DomainLibraryConnectorStatus;
}

interface Args {
  workspaceRoot?: string;
  registryRelativePath?: string;
  dbPath?: string;
  account?: string;
  maxItems?: number;
}

export async function runDomainLibrarySync(options: DomainLibrarySyncOptions): Promise<DomainLibrarySyncResult> {
  const workspaceRoot = requireNonEmpty(options.workspaceRoot, 'Domain library workspace root');
  const registryRelativePath = options.registryRelativePath?.trim() || DEFAULT_REGISTRY_RELATIVE_PATH;
  const dbPath = options.dbPath?.trim() || join(DEFAULT_STATE_DIR, 'connector-store.db');
  const account = options.account?.trim() || DOMAIN_LIBRARY_DEFAULT_ACCOUNT;
  const connector = createDomainLibrarySourceConnector({
    workspaceRoot,
    registryRelativePath,
    account,
    targetTrustDomain: 'internal',
    requireParseClean: options.maxItems === undefined,
    ...(options.pageLimit !== undefined ? { pageLimit: options.pageLimit } : {}),
  });
  const store = new LocalConnectorStore({
    dbPath,
    corpusId: DOMAIN_LIBRARY_CORPUS_ID,
    family: 'file',
    trustDomain: 'internal',
  });
  try {
    const cursor = options.maxItems !== undefined ? store.status().lastSyncRun?.cursor : undefined;
    const summary = await store.syncFromConnector(connector, {
      ...(cursor ? { cursor } : {}),
      ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
      fetchContent: true,
      reconcileFullSnapshot: options.maxItems === undefined,
      reconcileFullSnapshotScope: { provider: DOMAIN_LIBRARY_PROVIDER, accountScope: account },
    });
    const registry = readDomainLibraryConnectorStatus({ workspaceRoot, registryRelativePath });
    return { summary, registry };
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspaceRoot =
    args.workspaceRoot
    ?? process.env.OLYMPUS_DOMAIN_LIBRARY_WORKSPACE_ROOT?.trim()
    ?? DEFAULT_WORKSPACE_ROOT;
  const registryRelativePath =
    args.registryRelativePath
    ?? process.env.OLYMPUS_DOMAIN_LIBRARY_REGISTRY_RELATIVE_PATH?.trim()
    ?? DEFAULT_REGISTRY_RELATIVE_PATH;
  const dbPath =
    args.dbPath
    ?? process.env.OLYMPUS_DOMAIN_LIBRARY_CONNECTOR_STORE_DB_PATH?.trim()
    ?? join(process.env.OLYMPUS_DOMAIN_LIBRARY_STATE_DIR?.trim() || DEFAULT_STATE_DIR, 'connector-store.db');
  const result = await runDomainLibrarySync({
    workspaceRoot,
    registryRelativePath,
    dbPath,
    ...(args.account ? { account: args.account } : {}),
    ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
  for (const skipped of result.registry.skippedEntries) {
    const identity = skipped.sourceId ? `source_id=${skipped.sourceId}` : `line=${skipped.lineNumber}`;
    const derivative = skipped.derivativeWorkspaceRelativePath ? ` path=${skipped.derivativeWorkspaceRelativePath}` : '';
    const fsError = skipped.fsErrorCode ? ` fs=${skipped.fsErrorCode}` : '';
    console.error(`domain-library-sync: skipped ${identity} reason=${skipped.reason}${derivative}${fsError}`);
  }
  if (result.registry.skippedEntriesTruncated) {
    console.error('domain-library-sync: skipped-entry diagnostics truncated; inspect the registry for additional skipped entries.');
  }
  if (result.registry.stats.malformedLines > 0) {
    console.error(`domain-library-sync: ${result.registry.stats.malformedLines} malformed registry line(s) skipped.`);
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--workspace-root':
        if (!value) fail('--workspace-root requires a path.');
        args.workspaceRoot = value;
        index += 1;
        break;
      case '--registry-relative-path':
        if (!value) fail('--registry-relative-path requires a workspace-relative path.');
        args.registryRelativePath = value;
        index += 1;
        break;
      case '--db':
        if (!value) fail('--db requires a path.');
        args.dbPath = value;
        index += 1;
        break;
      case '--account':
        if (!value) fail('--account requires a value.');
        args.account = value;
        index += 1;
        break;
      case '--max-items': {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) fail('--max-items requires a positive integer.');
        args.maxItems = parsed;
        index += 1;
        break;
      }
      default:
        fail(
          `Unknown argument ${flag}. Usage: domain-library-sync.ts `
          + '[--workspace-root <path>] [--registry-relative-path <path>] [--db <path>] [--account solon] [--max-items N]',
        );
    }
  }
  return args;
}

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (import.meta.main) {
  await main();
}

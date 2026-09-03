import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import {
  parseDomainLibraryRegistryJsonl,
  type DomainLibraryRegistryRecord,
  type DomainLibraryRegistrySkippedEntry,
  type DomainLibraryRegistryStats,
} from '../../core/domain-library-registry.ts';
import {
  buildSourceSensitivity,
  type SourceSensitivity,
  type SourceTrustDomain,
} from '../../core/source-index/types.ts';

export const DOMAIN_LIBRARY_CONNECTOR_ID = 'domain-library';
export const DOMAIN_LIBRARY_PROVIDER = 'domain_library';
export const DOMAIN_LIBRARY_DEFAULT_ACCOUNT = 'solon';
const DEFAULT_REGISTRY_RELATIVE_PATH = 'castor-solon/references/source-registry.jsonl';
const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 2_000;

export interface DomainLibrarySourceConnectorOptions {
  workspaceRoot: string;
  registryRelativePath?: string;
  account?: string;
  targetTrustDomain?: Extract<SourceTrustDomain, 'internal' | 'public_safe'>;
  requireParseClean?: boolean;
  pageLimit?: number;
}

export interface DomainLibraryConnectorStatus {
  registryPath: string;
  stats: DomainLibraryRegistryStats;
  skippedEntries: DomainLibraryRegistrySkippedEntry[];
  skippedEntriesTruncated: boolean;
}

export function createDomainLibrarySourceConnector(
  options: DomainLibrarySourceConnectorOptions,
): SourceConnector {
  const workspaceRoot = requireNonEmpty(options.workspaceRoot, 'Domain library workspaceRoot');
  const registryRelativePath = options.registryRelativePath?.trim() || DEFAULT_REGISTRY_RELATIVE_PATH;
  const registryPath = join(workspaceRoot, registryRelativePath);
  const account = options.account?.trim() || DOMAIN_LIBRARY_DEFAULT_ACCOUNT;
  const targetTrustDomain = options.targetTrustDomain ?? 'internal';
  const requireParseClean = options.requireParseClean === true;
  const defaultPageLimit = normalizePositiveInteger(options.pageLimit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);

  return {
    id: DOMAIN_LIBRARY_CONNECTOR_ID,
    family: 'file',

    async authenticate(): Promise<void> {
      if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
        throw new Error(`Domain library workspace root ${workspaceRoot} does not exist.`);
      }
      if (!existsSync(registryPath) || !statSync(registryPath).isFile()) {
        throw new Error(`Domain library source registry ${registryPath} does not exist.`);
      }
    },

    listItems(listOptions?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      const limit = normalizePositiveInteger(listOptions?.limit, defaultPageLimit, MAX_PAGE_LIMIT);
      const start = cursorToOffset(listOptions?.cursor);
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        const records = readEligibleRecords(workspaceRoot, registryPath, targetTrustDomain, requireParseClean);
        for (let offset = start; offset < records.length;) {
          const pageRecords = records.slice(offset, offset + limit);
          offset += pageRecords.length;
          yield {
            items: pageRecords.map((record) => rawItemFromRecord(record, account, targetTrustDomain, false)),
            ...(offset < records.length ? { nextCursor: String(offset) } : {}),
            done: offset >= records.length,
          };
          if (offset >= records.length) return;
        }
        if (records.length === 0 || start >= records.length) {
          yield { items: [], done: true };
        }
      })();
    },

    async fetchItem(localItemId: string): Promise<RawItem> {
      const record = readEligibleRecords(workspaceRoot, registryPath, targetTrustDomain, requireParseClean)
        .find((candidate) => localItemIdForRecord(candidate, account) === localItemId);
      if (!record) {
        throw new Error(`Domain library item ${localItemId} is not eligible or was not found in ${registryPath}.`);
      }
      return rawItemFromRecord(record, account, targetTrustDomain, true);
    },

    classify(item: RawItem): SourceSensitivity {
      const tier = metadataString(item.metadata, 'registryTier') ?? 'S3';
      return buildSourceSensitivity({
        trustTier: tier as Parameters<typeof buildSourceSensitivity>[0]['trustTier'],
        trustDomain: targetTrustDomain,
        cloudEmbeddingEligible: true,
      });
    },
  };
}

export function readDomainLibraryConnectorStatus(
  options: DomainLibrarySourceConnectorOptions,
): DomainLibraryConnectorStatus {
  const workspaceRoot = requireNonEmpty(options.workspaceRoot, 'Domain library workspaceRoot');
  const registryRelativePath = options.registryRelativePath?.trim() || DEFAULT_REGISTRY_RELATIVE_PATH;
  const registryPath = join(workspaceRoot, registryRelativePath);
  const parsed = parseDomainLibraryRegistryJsonl(readFileSync(registryPath, 'utf8'), { workspaceRoot });
  return {
    registryPath,
    stats: parsed.stats,
    skippedEntries: parsed.skippedEntries,
    skippedEntriesTruncated: parsed.skippedEntriesTruncated,
  };
}

function readEligibleRecords(
  workspaceRoot: string,
  registryPath: string,
  targetTrustDomain: Extract<SourceTrustDomain, 'internal' | 'public_safe'>,
  requireParseClean = false,
): DomainLibraryRegistryRecord[] {
  const parsed = parseDomainLibraryRegistryJsonl(readFileSync(registryPath, 'utf8'), { workspaceRoot });
  if (requireParseClean && parsed.stats.malformedLines > 0) {
    throw new Error(`Domain library source registry ${registryPath} has malformed JSONL line(s); full-snapshot reconciliation was not run.`);
  }
  return parsed.records.filter((record) => {
    if (targetTrustDomain === 'internal') return record.trustDomain === 'internal' || record.trustDomain === 'public_safe';
    return record.trustDomain === 'public_safe';
  });
}

function rawItemFromRecord(
  record: DomainLibraryRegistryRecord,
  account: string,
  targetTrustDomain: Extract<SourceTrustDomain, 'internal' | 'public_safe'>,
  includeContent: boolean,
): RawItem {
  const text = includeContent ? readFileSync(record.absolutePath, 'utf8') : undefined;
  const title = record.title ?? basename(record.derivativeWorkspaceRelativePath);
  return {
    identity: {
      family: 'file',
      provider: DOMAIN_LIBRARY_PROVIDER,
      accountScope: account,
      providerItemId: record.providerItemId,
      providerFileId: record.providerItemId,
      localItemId: localItemIdForRecord(record, account),
      sourceVersion: record.contentHash,
    },
    mimeType: mimeTypeForPath(record.derivativeWorkspaceRelativePath),
    content: text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text },
    metadata: Object.freeze({
      title,
      name: title,
      locatorUri: record.sourceUrl ?? record.derivativeWorkspaceRelativePath,
      pathDisplay: record.derivativeWorkspaceRelativePath,
      contentHash: record.contentHash,
      registryTrustDomain: record.trustDomain,
      registryTier: record.tier,
      classificationStatus: record.classificationStatus,
      targetTrustDomain,
      ...(record.sourceUrl ? { sourceUrl: record.sourceUrl, url: record.sourceUrl } : {}),
      ...(record.domainId ? { domainId: record.domainId } : {}),
      ...(record.kind ? { kind: record.kind } : {}),
      ...(record.batchId ? { importBatchId: record.batchId } : {}),
      ...(record.importWorkspaceRelativePath ? { importWorkspaceRelativePath: record.importWorkspaceRelativePath } : {}),
      ...(record.transcriptSource ? { transcriptSource: record.transcriptSource } : {}),
    }),
    fetchedAt: new Date().toISOString(),
  };
}

function localItemIdForRecord(record: DomainLibraryRegistryRecord, account: string): string {
  return `${account}:${record.localItemId}`;
}

function cursorToOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== cursor) {
    throw new Error('Domain library cursor must be a non-negative integer offset.');
  }
  return parsed;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Domain library page limit must be a positive integer.');
  }
  return Math.min(value, max);
}

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function metadataString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function mimeTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.json')) return 'application/json';
  return 'text/plain';
}

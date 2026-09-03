import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { SourceTrustDomain, SourceTrustTier } from './source-index/types.ts';

const ELIGIBLE_TRUST_DOMAINS = new Set<SourceTrustDomain>(['internal', 'public_safe']);
const ELIGIBLE_TIERS = new Set<SourceTrustTier>(['S0', 'S1', 'S2', 'S3']);
const DEFAULT_MAX_SKIPPED_ENTRIES = 100;

export interface DomainLibraryRegistryRecord {
  sourceId: string;
  providerItemId: string;
  localItemId: string;
  domainId?: string;
  kind?: string;
  title?: string;
  sourceUrl?: string;
  derivativeWorkspaceRelativePath: string;
  absolutePath: string;
  contentHash: string;
  trustDomain: Extract<SourceTrustDomain, 'internal' | 'public_safe'>;
  tier: Extract<SourceTrustTier, 'S0' | 'S1' | 'S2' | 'S3'>;
  classificationStatus: 'approved';
  batchId?: string;
  importWorkspaceRelativePath?: string;
  transcriptSource?: string;
  raw: Readonly<Record<string, unknown>>;
}

export interface DomainLibraryRegistryStats {
  lines: number;
  parsedRecords: number;
  malformedLines: number;
  eligibleRecords: number;
  excludedRecords: number;
  missingVerdict: number;
  invalidVerdict: number;
  blockedRecords: number;
  staleContentHash: number;
  missingDerivative: number;
  unsafeDerivativePath: number;
}

export interface DomainLibraryRegistryParseResult {
  records: DomainLibraryRegistryRecord[];
  stats: DomainLibraryRegistryStats;
  skippedEntries: DomainLibraryRegistrySkippedEntry[];
  skippedEntriesTruncated: boolean;
}

export type DomainLibraryRegistrySkipReason =
  | 'malformed_line'
  | 'missing_derivative'
  | 'stale_content_hash'
  | 'unsafe_derivative_path'
  | 'fs_error';

export interface DomainLibraryRegistrySkippedEntry {
  lineNumber: number;
  reason: DomainLibraryRegistrySkipReason;
  sourceId?: string;
  derivativeWorkspaceRelativePath?: string;
  fsErrorCode?: 'ENOENT' | 'EACCES' | 'other';
}

export interface ReadDomainLibraryRegistryOptions {
  workspaceRoot: string;
  registryPath?: string;
  registryRelativePath?: string;
}

export function readDomainLibraryRegistry(
  options: ReadDomainLibraryRegistryOptions,
): DomainLibraryRegistryParseResult {
  const registryPath = options.registryPath
    ? resolveInside(options.workspaceRoot, options.registryPath)
    : resolveInside(options.workspaceRoot, options.registryRelativePath ?? 'references/source-registry.jsonl');
  return parseDomainLibraryRegistryJsonl(readFileSync(registryPath, 'utf8'), {
    workspaceRoot: options.workspaceRoot,
  });
}

export function parseDomainLibraryRegistryJsonl(
  text: string,
  options: { workspaceRoot: string; maxSkippedEntries?: number },
): DomainLibraryRegistryParseResult {
  const records: DomainLibraryRegistryRecord[] = [];
  const skippedEntries: DomainLibraryRegistrySkippedEntry[] = [];
  const maxSkippedEntries = options.maxSkippedEntries ?? DEFAULT_MAX_SKIPPED_ENTRIES;
  let skippedEntriesTruncated = false;
  const stats: DomainLibraryRegistryStats = {
    lines: 0,
    parsedRecords: 0,
    malformedLines: 0,
    eligibleRecords: 0,
    excludedRecords: 0,
    missingVerdict: 0,
    invalidVerdict: 0,
    blockedRecords: 0,
    staleContentHash: 0,
    missingDerivative: 0,
    unsafeDerivativePath: 0,
  };

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;
    const lineNumber = index + 1;
    stats.lines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      stats.malformedLines += 1;
      ({ truncated: skippedEntriesTruncated } = appendSkippedEntry(skippedEntries, {
        lineNumber,
        reason: 'malformed_line',
      }, maxSkippedEntries, skippedEntriesTruncated));
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      stats.malformedLines += 1;
      ({ truncated: skippedEntriesTruncated } = appendSkippedEntry(skippedEntries, {
        lineNumber,
        reason: 'malformed_line',
      }, maxSkippedEntries, skippedEntriesTruncated));
      continue;
    }
    stats.parsedRecords += 1;
    const verdict = parseEligibleRegistryRecord(
      parsed as Record<string, unknown>,
      options.workspaceRoot,
      stats,
      (entry) => {
        ({ truncated: skippedEntriesTruncated } = appendSkippedEntry(
          skippedEntries,
          { lineNumber, ...entry },
          maxSkippedEntries,
          skippedEntriesTruncated,
        ));
      },
    );
    if (verdict) {
      records.push(verdict);
      stats.eligibleRecords += 1;
    } else {
      stats.excludedRecords += 1;
    }
  }

  return { records, stats, skippedEntries, skippedEntriesTruncated };
}

function parseEligibleRegistryRecord(
  record: Record<string, unknown>,
  workspaceRoot: string,
  stats: DomainLibraryRegistryStats,
  skip: (entry: Omit<DomainLibraryRegistrySkippedEntry, 'lineNumber'>) => void,
): DomainLibraryRegistryRecord | undefined {
  const trustDomain = stringField(record, 'trust_domain', 'trustDomain');
  const tier = stringField(record, 'tier', 'sensitivity', 'trust_tier', 'trustTier');
  const classificationStatus = stringField(record, 'classification_status', 'classificationStatus');
  const contentHash = stringField(record, 'content_hash', 'contentHash');
  const rawSourceId = stringField(record, 'source_id', 'sourceId');

  if (record.removed === true || stringField(record, 'ingest_status', 'ingestStatus') === 'removed') {
    stats.invalidVerdict += 1;
    return undefined;
  }
  if (!trustDomain || !tier || !classificationStatus || !contentHash) {
    stats.missingVerdict += 1;
    return undefined;
  }
  if (classificationStatus === 'blocked') {
    stats.blockedRecords += 1;
    return undefined;
  }
  if (
    !ELIGIBLE_TRUST_DOMAINS.has(trustDomain as SourceTrustDomain)
    || !ELIGIBLE_TIERS.has(tier as SourceTrustTier)
    || classificationStatus !== 'approved'
  ) {
    stats.invalidVerdict += 1;
    return undefined;
  }

  const derivativeWorkspaceRelativePath = stringField(
    record,
    'derivative_workspace_relative_path',
    'derivativeWorkspaceRelativePath',
    'derivative_path',
    'derivativePath',
    'workspace_relative_path',
    'workspaceRelativePath',
    'workspace_or_alias_path',
    'workspaceOrAliasPath',
  );
  if (!derivativeWorkspaceRelativePath) {
    stats.missingDerivative += 1;
    skip({
      reason: 'missing_derivative',
      ...(rawSourceId ? { sourceId: rawSourceId } : {}),
    });
    return undefined;
  }

  let absolutePath: string;
  try {
    absolutePath = resolveInside(workspaceRoot, derivativeWorkspaceRelativePath);
  } catch {
    stats.unsafeDerivativePath += 1;
    skip({
      reason: 'unsafe_derivative_path',
      derivativeWorkspaceRelativePath,
      ...(rawSourceId ? { sourceId: rawSourceId } : {}),
    });
    return undefined;
  }

  let actualHash: string;
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      stats.missingDerivative += 1;
      skip({
        reason: 'missing_derivative',
        derivativeWorkspaceRelativePath,
        ...(rawSourceId ? { sourceId: rawSourceId } : {}),
      });
      return undefined;
    }
    actualHash = sha256(readFileSync(absolutePath));
  } catch (error) {
    const fsErrorCode = classifyFsError(error);
    if (fsErrorCode === 'ENOENT') {
      stats.missingDerivative += 1;
      skip({
        reason: 'missing_derivative',
        derivativeWorkspaceRelativePath,
        fsErrorCode,
        ...(rawSourceId ? { sourceId: rawSourceId } : {}),
      });
    } else {
      stats.missingDerivative += 1;
      skip({
        reason: 'fs_error',
        derivativeWorkspaceRelativePath,
        fsErrorCode,
        ...(rawSourceId ? { sourceId: rawSourceId } : {}),
      });
    }
    return undefined;
  }
  if (actualHash !== contentHash.toLowerCase()) {
    stats.staleContentHash += 1;
    skip({
      reason: 'stale_content_hash',
      derivativeWorkspaceRelativePath,
      ...(rawSourceId ? { sourceId: rawSourceId } : {}),
    });
    return undefined;
  }

  const sourceId = rawSourceId
    ?? `${stringField(record, 'domain_id', 'domainId') ?? 'domain-library'}:${derivativeWorkspaceRelativePath}`;
  const localItemId = `${stringField(record, 'domain_id', 'domainId') ?? 'domain'}:${sourceId}`;
  const domainId = stringField(record, 'domain_id', 'domainId');
  const kind = stringField(record, 'kind');
  const title = stringField(record, 'title');
  const sourceUrl = stringField(record, 'source_url', 'sourceUrl', 'canonical_url', 'canonicalUrl');
  const batchId = stringField(record, 'batch_id', 'batchId');
  const importWorkspaceRelativePath = stringField(record, 'import_workspace_relative_path', 'importWorkspaceRelativePath');
  const transcriptSource = stringField(record, 'transcript_source', 'transcriptSource');
  return {
    sourceId,
    providerItemId: sourceId,
    localItemId,
    ...(domainId ? { domainId } : {}),
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    derivativeWorkspaceRelativePath,
    absolutePath,
    contentHash: actualHash,
    trustDomain: trustDomain as Extract<SourceTrustDomain, 'internal' | 'public_safe'>,
    tier: tier as Extract<SourceTrustTier, 'S0' | 'S1' | 'S2' | 'S3'>,
    classificationStatus: 'approved',
    ...(batchId ? { batchId } : {}),
    ...(importWorkspaceRelativePath ? { importWorkspaceRelativePath } : {}),
    ...(transcriptSource ? { transcriptSource } : {}),
    raw: Object.freeze({ ...record }),
  };
}

function appendSkippedEntry(
  entries: DomainLibraryRegistrySkippedEntry[],
  entry: DomainLibraryRegistrySkippedEntry,
  maxEntries: number,
  alreadyTruncated: boolean,
): { truncated: boolean } {
  if (entries.length < maxEntries) {
    entries.push(entry);
    return { truncated: alreadyTruncated };
  }
  return { truncated: true };
}

function classifyFsError(error: unknown): 'ENOENT' | 'EACCES' | 'other' {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'EACCES') return code;
  }
  return 'other';
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function resolveInside(rootPath: string, relativeOrAbsolutePath: string): string {
  const root = resolve(rootPath);
  const target = resolve(root, relativeOrAbsolutePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Path ${relativeOrAbsolutePath} escapes workspace root.`);
  }
  return target;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

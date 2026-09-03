import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OperationError } from './operation-error.ts';

export const SOURCE_INGESTION_POLICY_SCHEMA_VERSION = 1;

export type SourceIngestionAction = 'full_extract' | 'metadata_only' | 'on_demand';

export interface SourceIngestionRootPolicy {
  path: string;
  approved_scope_key: string;
  default_action: SourceIngestionAction;
}

export interface SourceIngestionRule {
  match: {
    extensions?: string[];
    mime_type_prefixes?: string[];
    path_contains?: string[];
    path_prefixes?: string[];
  };
  action: SourceIngestionAction;
  reason: string;
}

export interface SourceIngestionPolicy {
  schemaVersion: 1;
  source: string;
  corpusId: string;
  roots: SourceIngestionRootPolicy[];
  rules: SourceIngestionRule[];
  sync: {
    cadence: 'manual' | 'continuous';
    max_entries_per_pass: number;
    max_pages_per_pass: number;
  };
  content: {
    default_extractor_kind: string;
    default_extractor_version: string;
    plan_limit: number;
    batch_size: number;
  };
}

export interface SourceIngestionPolicyLoadOptions {
  inlinePolicy?: unknown | undefined;
  policyPath?: string | undefined;
  env?: Record<string, string | undefined>;
}

const DEFAULT_DROPBOX_ROOT = '/';
const DEFAULT_DEFERRED_MEDIA_EXTENSIONS = [
  '3gp', 'avi', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'm4v', 'mov',
  'mp4', 'mpeg', 'mpg', 'png', 'tif', 'tiff', 'webm', 'webp',
] as const;
const DEFAULT_DEFERRED_BOOK_EXTENSIONS = [
  'azw', 'azw3', 'azw4', 'cba', 'cb7', 'cbr', 'cbt', 'cbz', 'djv', 'djvu',
  'epub', 'fb2', 'ibooks', 'lit', 'mobi', 'opf',
] as const;
const DEFAULT_DEFERRED_BOOK_PATH_SEGMENTS = [
  'audiobooks',
  'book library',
  'books',
  'calibre library',
  'e-books',
  'ebooks',
  'kindle',
] as const;

export function defaultDropboxIngestionPolicyPath(): string {
  return join(homedir(), '.olympus', 'sources', 'dropbox.personal.ingestion.json');
}

export function defaultDropboxIngestionPolicy(): SourceIngestionPolicy {
  return {
    schemaVersion: SOURCE_INGESTION_POLICY_SCHEMA_VERSION,
    source: 'dropbox.personal',
    corpusId: 'secure_local.dropbox.files',
    roots: [{
      path: DEFAULT_DROPBOX_ROOT,
      approved_scope_key: `dropbox.personal:${DEFAULT_DROPBOX_ROOT}`,
      default_action: 'full_extract',
    }],
    rules: [
      {
        match: {
          mime_type_prefixes: ['image/', 'video/'],
          extensions: [...DEFAULT_DEFERRED_MEDIA_EXTENSIONS],
        },
        action: 'metadata_only',
        reason: 'media_default_metadata_only',
      },
      {
        match: {
          extensions: [...DEFAULT_DEFERRED_BOOK_EXTENSIONS],
          path_contains: [...DEFAULT_DEFERRED_BOOK_PATH_SEGMENTS],
        },
        action: 'metadata_only',
        reason: 'book_library_metadata_only',
      },
      {
        match: {
          path_prefixes: ['/Archive'],
        },
        action: 'metadata_only',
        reason: 'archive_metadata_only',
      },
    ],
    sync: {
      cadence: 'continuous',
      max_entries_per_pass: 25_000,
      max_pages_per_pass: 1_000,
    },
    content: {
      default_extractor_kind: 'local_text',
      default_extractor_version: '2026-05-22',
      plan_limit: 25,
      batch_size: 2,
    },
  };
}

export function loadDropboxIngestionPolicy(options: SourceIngestionPolicyLoadOptions = {}): SourceIngestionPolicy {
  const validateDropboxPolicy = (policy: SourceIngestionPolicy, label: string): SourceIngestionPolicy => {
    if (policy.source !== 'dropbox.personal') {
      throw new OperationError('config_error', `${label}.source must be dropbox.personal for this Dropbox policy loader.`);
    }
    if (policy.corpusId !== 'secure_local.dropbox.files') {
      throw new OperationError('config_error', `${label}.corpusId must be secure_local.dropbox.files.`);
    }
    return policy;
  };
  if (options.inlinePolicy !== undefined) {
    return validateDropboxPolicy(
      parseSourceIngestionPolicy(options.inlinePolicy, 'inline Dropbox ingestion policy'),
      'inline Dropbox ingestion policy',
    );
  }
  const env = options.env ?? process.env;
  const path = options.policyPath?.trim()
    || env.OLYMPUS_DROPBOX_INGESTION_POLICY_PATH?.trim()
    || env.OLYMPUS_SOURCE_INGESTION_POLICY_PATH?.trim()
    || defaultDropboxIngestionPolicyPath();
  if (existsSync(path)) {
    return validateDropboxPolicy(
      parseSourceIngestionPolicy(JSON.parse(readFileSync(path, 'utf8')) as unknown, path),
      path,
    );
  }
  return defaultDropboxIngestionPolicy();
}

export function parseSourceIngestionPolicy(rawPolicy: unknown, label = 'source ingestion policy'): SourceIngestionPolicy {
  const root = asRecord(rawPolicy);
  if (!root) throw new OperationError('config_error', `${label} must be an object.`);
  if (root.schemaVersion !== SOURCE_INGESTION_POLICY_SCHEMA_VERSION) {
    throw new OperationError('config_error', `${label} schemaVersion must be 1.`);
  }
  const source = requiredString(root.source, `${label}.source`);
  const corpusId = requiredString(root.corpusId, `${label}.corpusId`);
  const roots = Array.isArray(root.roots) ? root.roots.map((value) => parseRoot(value, label)) : [];
  if (roots.length === 0) throw new OperationError('config_error', `${label}.roots must include at least one root.`);
  const rules = Array.isArray(root.rules) ? root.rules.map((value) => parseRule(value, label)) : [];
  const syncRecord = asRecord(root.sync);
  const contentRecord = asRecord(root.content);
  const policy: SourceIngestionPolicy = {
    schemaVersion: SOURCE_INGESTION_POLICY_SCHEMA_VERSION,
    source,
    corpusId,
    roots,
    rules,
    sync: {
      cadence: enumString(syncRecord?.cadence, ['manual', 'continuous'], `${label}.sync.cadence`) as 'manual' | 'continuous',
      max_entries_per_pass: positiveInteger(syncRecord?.max_entries_per_pass, `${label}.sync.max_entries_per_pass`),
      max_pages_per_pass: positiveInteger(syncRecord?.max_pages_per_pass, `${label}.sync.max_pages_per_pass`),
    },
    content: {
      default_extractor_kind: requiredString(contentRecord?.default_extractor_kind, `${label}.content.default_extractor_kind`),
      default_extractor_version: requiredString(contentRecord?.default_extractor_version, `${label}.content.default_extractor_version`),
      plan_limit: positiveInteger(contentRecord?.plan_limit, `${label}.content.plan_limit`),
      batch_size: positiveInteger(contentRecord?.batch_size, `${label}.content.batch_size`),
    },
  };
  return policy;
}

export function dropboxPolicyApprovedScopeKeys(policy: SourceIngestionPolicy): string[] {
  return policy.roots
    .filter((root) => root.default_action !== 'on_demand')
    .map((root) => root.approved_scope_key);
}

export function dropboxPolicyFullExtractionScopeKeys(policy: SourceIngestionPolicy): string[] {
  return policy.roots
    .filter((root) => root.default_action === 'full_extract')
    .map((root) => root.approved_scope_key);
}

export function dropboxPolicyExcludedPathPrefixes(policy: SourceIngestionPolicy): string[] {
  return policy.rules
    .filter((rule) => rule.action !== 'full_extract')
    .flatMap((rule) => rule.match.path_prefixes ?? [])
    .map((path) => path.toLowerCase());
}

function parseRoot(value: unknown, label: string): SourceIngestionRootPolicy {
  const root = asRecord(value);
  if (!root) throw new OperationError('config_error', `${label}.roots entries must be objects.`);
  const path = normalizePath(requiredString(root.path, `${label}.roots.path`));
  const approvedScopeKey = requiredString(root.approved_scope_key, `${label}.roots.approved_scope_key`);
  if (!approvedScopeKeyContainsPath(approvedScopeKey, path)) {
    throw new OperationError('config_error', `${label}.roots approved_scope_key must contain its root path.`);
  }
  return {
    path,
    approved_scope_key: approvedScopeKey,
    default_action: enumString(root.default_action, ['full_extract', 'metadata_only', 'on_demand'], `${label}.roots.default_action`) as SourceIngestionAction,
  };
}

function approvedScopeKeyContainsPath(approvedScopeKey: string, path: string): boolean {
  const [, scopePathValue] = approvedScopeKey.split(/:(.*)/s);
  const scopePath = normalizePath(scopePathValue || approvedScopeKey);
  return path === scopePath || path.startsWith(`${scopePath}/`);
}

function parseRule(value: unknown, label: string): SourceIngestionRule {
  const rule = asRecord(value);
  const match = asRecord(rule?.match);
  if (!rule || !match) throw new OperationError('config_error', `${label}.rules entries require match objects.`);
  const parsed: SourceIngestionRule = {
    match: {},
    action: enumString(rule.action, ['full_extract', 'metadata_only', 'on_demand'], `${label}.rules.action`) as SourceIngestionAction,
    reason: requiredString(rule.reason, `${label}.rules.reason`),
  };
  const extensions = stringList(match.extensions).map((extension) => extension.replace(/^\./, '').toLowerCase());
  const mimeTypePrefixes = stringList(match.mime_type_prefixes).map((prefix) => prefix.toLowerCase());
  const pathContains = stringList(match.path_contains).map((segment) => segment.toLowerCase());
  const pathPrefixes = stringList(match.path_prefixes).map(normalizePath);
  if (extensions.length > 0) parsed.match.extensions = extensions;
  if (mimeTypePrefixes.length > 0) parsed.match.mime_type_prefixes = mimeTypePrefixes;
  if (pathContains.length > 0) parsed.match.path_contains = pathContains;
  if (pathPrefixes.length > 0) parsed.match.path_prefixes = pathPrefixes;
  if (Object.keys(parsed.match).length === 0) {
    throw new OperationError('config_error', `${label}.rules entries must match at least one field.`);
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OperationError('config_error', `${label} must be a non-empty string.`);
  }
  return value.trim();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))]
    : [];
}

function enumString(value: unknown, allowed: readonly string[], label: string): string {
  if (typeof value === 'string' && allowed.includes(value)) return value;
  throw new OperationError('config_error', `${label} must be one of: ${allowed.join(', ')}.`);
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw new OperationError('config_error', `${label} must be a positive integer.`);
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

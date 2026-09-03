// Dropbox source export: materialize already-cited connector-store items
// into a user-owned Dropbox destination folder via a server-side provider
// copy. Castor passes locators (paths) plus a destination; the WORKER verifies
// each path against the shared connector store and copies inside the user's own
// Dropbox via files/copy_v2. File bytes never leave Dropbox and content never
// enters any model context — the Castor-visible result carries path-level
// statuses and counts only.

import {
  createEnvCredentialBroker,
  type CredentialBroker,
} from '../credential-broker/index.ts';
import { DROPBOX_FILES_CORPUS_ID } from '../dropbox-files/corpus-adapter.ts';
import type { SourceTrustTier } from '../../core/source-index/types.ts';

const DEFAULT_ACCOUNT = 'personal';
const MAX_ITEMS_PER_EXPORT = 500;

type DropboxExportFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface DropboxSourceExportItemRequest {
  /** Source Dropbox path/locator exactly as returned in citations. */
  path: string;
  /** Optional relative folder layout below destination_root. */
  dest_subfolder?: string;
}

export interface DropboxSourceExportRequest {
  account?: string;
  /** Destination Dropbox folder path. Must fall under an allowed export root. */
  destination_root: string;
  items: DropboxSourceExportItemRequest[];
  dry_run?: boolean;
}

export type DropboxSourceExportItemStatus =
  | 'copied'
  | 'would_copy'
  | 'skipped_unknown'
  | 'skipped_s5'
  | 'skipped_existing'
  | 'failed_retryable';

export interface DropboxSourceExportItemResult {
  path: string;
  status: DropboxSourceExportItemStatus;
  dest_path?: string;
}

export interface DropboxSourceExportResult {
  kind: 'dropbox_source_export';
  corpus_id: typeof DROPBOX_FILES_CORPUS_ID;
  provider: 'dropbox';
  account: string;
  destination_root: string;
  items_requested: number;
  items_copied: number;
  items_skipped_unknown: number;
  items_skipped_s5: number;
  items_skipped_existing: number;
  items_failed: number;
  dry_run: boolean;
  items: DropboxSourceExportItemResult[];
  policy: {
    raw_source_exposed: false;
    content_transited_models: false;
    destination_user_owned: true;
  };
}

export interface DropboxSourceExportHandler {
  export(request: DropboxSourceExportRequest): Promise<DropboxSourceExportResult>;
}

export interface DropboxCopyRequest {
  from_path: string;
  to_path: string;
}

export type DropboxCopyOutcome = 'copied' | 'conflict';

export interface DropboxCopyClient {
  copy(request: DropboxCopyRequest): Promise<DropboxCopyOutcome>;
}

export interface DropboxApiCopyClientOptions {
  token: string;
  fetch?: DropboxExportFetch;
  apiBaseUrl?: string;
}

export interface DropboxCopyClientBrokerOptions {
  broker?: CredentialBroker;
  credentialHandle?: string;
  capability?: string;
  fetch?: DropboxExportFetch;
  apiBaseUrl?: string;
}

export interface DropboxSourceExportHandlerOptions {
  store: DropboxSourceExportStore;
  /** Injectable copy client; defaults to the broker bearer session client. */
  copyClient?: DropboxCopyClient;
  broker?: CredentialBroker;
  credentialHandle?: string;
  fetch?: DropboxExportFetch;
  apiBaseUrl?: string;
  account?: string;
  /** Allowed destination prefixes; defaults to OLYMPUS_SOURCE_EXPORT_DROPBOX_ROOTS. */
  allowedDestinationRoots?: string[];
  env?: Record<string, string | undefined>;
}

export interface DropboxSourceExportStore {
  activeItemForLocator(input: {
    provider: string;
    accountScope: string;
    locatorUri: string;
  }): { trustTier: SourceTrustTier; locatorUri: string } | undefined;
}

/** 400-style: the export request itself is malformed. */
export class DropboxSourceExportRequestError extends Error {
  readonly kind = 'dropbox_source_export_invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'DropboxSourceExportRequestError';
  }
}

/** 403-style: the destination is outside the user-approved export allowlist. */
export class DropboxSourceExportDestinationError extends Error {
  readonly kind = 'dropbox_source_export_destination_not_allowed';

  constructor(message: string) {
    super(message);
    this.name = 'DropboxSourceExportDestinationError';
  }
}

export function parseDropboxSourceExportRootsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.OLYMPUS_SOURCE_EXPORT_DROPBOX_ROOTS ?? '';
  return raw
    .split(',')
    .map((value) => normalizeDropboxFolderPath(value))
    .filter((value): value is string => Boolean(value));
}

export class DropboxApiCopyClient implements DropboxCopyClient {
  private readonly token: string;
  private readonly fetchImpl: DropboxExportFetch;
  private readonly baseUrl: string;

  constructor(options: DropboxApiCopyClientOptions) {
    this.token = requireNonEmpty(options.token, 'Dropbox copy token');
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.apiBaseUrl?.replace(/\/+$/, '') || 'https://api.dropboxapi.com/2';
  }

  async copy(request: DropboxCopyRequest): Promise<DropboxCopyOutcome> {
    const response = await this.fetchImpl(`${this.baseUrl}/files/copy_v2`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from_path: request.from_path,
        to_path: request.to_path,
        autorename: false,
        allow_ownership_transfer: false,
      }),
    });
    if (response.status === 409) {
      const text = await response.text();
      if (text.includes('conflict')) return 'conflict';
      throw new Error('Dropbox copy API request failed (409).');
    }
    if (!response.ok) {
      throw new Error(`Dropbox copy API request failed (${response.status}).`);
    }
    return 'copied';
  }
}

export async function createDropboxCopyClientFromBroker(
  options: DropboxCopyClientBrokerOptions = {},
): Promise<DropboxApiCopyClient> {
  const broker = options.broker ?? createEnvCredentialBroker();
  const handle = options.credentialHandle ?? 'dropbox.personal';
  const capability = options.capability ?? 'dropbox.files.export';
  const session = await broker.issueSession({
    handle,
    provider: 'dropbox',
    capability,
    trustDomain: 'secure_local',
    purpose: 'Copy verified Dropbox source items between the user\'s own Dropbox folders.',
  });
  if (session.kind !== 'bearer_token') {
    throw new Error(`Credential handle ${handle} did not issue a Dropbox bearer token session.`);
  }
  return new DropboxApiCopyClient({
    token: session.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
  });
}

export function createDropboxSourceExportHandler(
  options: DropboxSourceExportHandlerOptions,
): DropboxSourceExportHandler {
  const env = options.env ?? process.env;
  const allowedRoots = (options.allowedDestinationRoots ?? parseDropboxSourceExportRootsFromEnv(env))
    .map((root) => normalizeDropboxFolderPath(root))
    .filter((root): root is string => Boolean(root));
  let copyClient: DropboxCopyClient | undefined = options.copyClient;

  const ensureCopyClient = async (): Promise<DropboxCopyClient> => {
    if (!copyClient) {
      copyClient = await createDropboxCopyClientFromBroker({
        ...(options.broker ? { broker: options.broker } : {}),
        ...(options.credentialHandle ? { credentialHandle: options.credentialHandle } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
      });
    }
    return copyClient;
  };

  return {
    async export(request: DropboxSourceExportRequest): Promise<DropboxSourceExportResult> {
      const normalized = normalizeExportRequest(request, options.account);
      assertDestinationAllowed(normalized.destination_root, allowedRoots);

      const items: DropboxSourceExportItemResult[] = [];
      const counts = {
        copied: 0,
        skippedUnknown: 0,
        skippedS5: 0,
        skippedExisting: 0,
        failed: 0,
      };

      for (const item of normalized.items) {
        const entry = options.store.activeItemForLocator({
          provider: 'dropbox',
          accountScope: normalized.account,
          locatorUri: item.path,
        });
        if (!entry) {
          counts.skippedUnknown += 1;
          items.push({ path: item.path, status: 'skipped_unknown' });
          continue;
        }
        if (entry.trustTier === 'S5') {
          counts.skippedS5 += 1;
          items.push({ path: item.path, status: 'skipped_s5' });
          continue;
        }
        const sourcePath = entry.locatorUri;
        const destPath = buildExportDestinationPath(
          normalized.destination_root,
          item.dest_subfolder,
          sourcePath,
        );
        if (normalized.dry_run) {
          items.push({ path: item.path, status: 'would_copy', dest_path: destPath });
          continue;
        }
        try {
          const client = await ensureCopyClient();
          const outcome = await client.copy({ from_path: sourcePath, to_path: destPath });
          if (outcome === 'conflict') {
            counts.skippedExisting += 1;
            items.push({ path: item.path, status: 'skipped_existing', dest_path: destPath });
            continue;
          }
          counts.copied += 1;
          items.push({ path: item.path, status: 'copied', dest_path: destPath });
        } catch {
          counts.failed += 1;
          items.push({ path: item.path, status: 'failed_retryable', dest_path: destPath });
        }
      }

      return {
        kind: 'dropbox_source_export',
        corpus_id: DROPBOX_FILES_CORPUS_ID,
        provider: 'dropbox',
        account: normalized.account,
        destination_root: normalized.destination_root,
        items_requested: normalized.items.length,
        items_copied: counts.copied,
        items_skipped_unknown: counts.skippedUnknown,
        items_skipped_s5: counts.skippedS5,
        items_skipped_existing: counts.skippedExisting,
        items_failed: counts.failed,
        dry_run: normalized.dry_run,
        items,
        policy: {
          raw_source_exposed: false,
          content_transited_models: false,
          destination_user_owned: true,
        },
      };
    },
  };
}

interface NormalizedDropboxSourceExportRequest {
  account: string;
  destination_root: string;
  items: Array<{ path: string; dest_subfolder?: string }>;
  dry_run: boolean;
}

function normalizeExportRequest(
  request: DropboxSourceExportRequest,
  defaultAccount: string | undefined,
): NormalizedDropboxSourceExportRequest {
  const account = request.account?.trim() || defaultAccount?.trim() || DEFAULT_ACCOUNT;
  if (account !== 'personal') {
    throw new DropboxSourceExportRequestError('Dropbox source export currently requires the personal account scope.');
  }
  const destinationRoot = normalizeDropboxFolderPath(request.destination_root);
  if (!destinationRoot) {
    throw new DropboxSourceExportRequestError('destination_root must be a non-root Dropbox folder path starting with "/".');
  }
  if (!Array.isArray(request.items) || request.items.length === 0) {
    throw new DropboxSourceExportRequestError('items must include at least one export item.');
  }
  if (request.items.length > MAX_ITEMS_PER_EXPORT) {
    throw new DropboxSourceExportRequestError(`items must include at most ${MAX_ITEMS_PER_EXPORT} export items per request.`);
  }
  const items = request.items.map((item, index) => {
    const path = item?.path?.trim();
    if (!path || !path.startsWith('/')) {
      throw new DropboxSourceExportRequestError(`items.${index}.path must be a Dropbox path starting with "/".`);
    }
    const destSubfolder = normalizeDestSubfolder(item.dest_subfolder, index);
    return {
      path,
      ...(destSubfolder ? { dest_subfolder: destSubfolder } : {}),
    };
  });
  return {
    account,
    destination_root: destinationRoot,
    items,
    dry_run: request.dry_run === true,
  };
}

function normalizeDestSubfolder(value: string | undefined, index: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return undefined;
  const segments = trimmed.split('/').map((segment) => segment.trim());
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new DropboxSourceExportRequestError(`items.${index}.dest_subfolder must be a relative folder path without traversal.`);
  }
  return segments.join('/');
}

function assertDestinationAllowed(destinationRoot: string, allowedRoots: string[]): void {
  if (allowedRoots.length === 0) {
    throw new DropboxSourceExportDestinationError(
      'No Dropbox export destinations are configured. Set OLYMPUS_SOURCE_EXPORT_DROPBOX_ROOTS to a CSV of approved destination path prefixes.',
    );
  }
  const destinationKey = dropboxPathKey(destinationRoot);
  const allowed = allowedRoots.some((root) => {
    const rootKey = dropboxPathKey(root);
    return destinationKey === rootKey || destinationKey.startsWith(`${rootKey}/`);
  });
  if (!allowed) {
    throw new DropboxSourceExportDestinationError(
      'destination_root is outside the approved Dropbox export destinations.',
    );
  }
}

function buildExportDestinationPath(
  destinationRoot: string,
  destSubfolder: string | undefined,
  sourcePath: string,
): string {
  const baseName = sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
  const folder = destSubfolder ? `${destinationRoot}/${destSubfolder}` : destinationRoot;
  return `${folder}/${baseName}`;
}

function normalizeDropboxFolderPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, '');
  if (!trimmed || !trimmed.startsWith('/')) return undefined;
  return trimmed;
}

function dropboxPathKey(value: string): string {
  return value.trim().toLowerCase();
}

function requireNonEmpty(value: string, label: string): string {
  const text = value.trim();
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
}

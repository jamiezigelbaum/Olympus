// Contract 1 (SourceConnector) adapter for Dropbox — the first ingest-side
// connector implementing the frozen shape in src/core/contracts.ts.
//
// THIN by design: this file only adapts machinery the dropbox-files worker
// already owns (credential-broker sessions, the metadata list/continue
// clients, the bounded content download seam, the deterministic content
// policy scanner) onto the contract. Storage stays in the shared spine — this
// file must never import local-index.ts (enforced by
// test/dropbox-source-connector.test.ts).
//
// Deleted entries are SURFACED, not skipped: they map to a RawItem with
// metadata.entryKind === 'deleted' and metadata.deleted === true so the shared
// ingest spine can apply tombstone semantics. Skipping them would silently
// resurrect removed files on incremental cursors.

import { createHash } from 'node:crypto';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import {
  buildSourceSensitivity,
  type SourceItemIdentity,
  type SourceSensitivity,
} from '../../core/source-index/types.ts';
import {
  CredentialBrokerError,
  createEnvCredentialBroker,
  type CredentialBroker,
  type CredentialBrokerFetch,
  type CredentialSession,
} from '../credential-broker/index.ts';
import { SOURCE_CHECKPOINT_MAX_LENGTH } from '../source-checkpoint.ts';
import { scanDropboxContentPolicyText } from './content-policy.ts';
import {
  DropboxApiContentDownloadClient,
  DropboxApiMetadataClient,
  DropboxContentTooLargeError,
  dropboxMimeTypeFromName,
  type DropboxContentDownloadClient,
  type DropboxDeletedMetadataEntry,
  type DropboxFileMetadataEntry,
  type DropboxFolderMetadataEntry,
  type DropboxMetadataClient,
  type DropboxMetadataEntry,
  type DropboxMetadataPage,
} from './provider-client.ts';

const CONNECTOR_ID = 'dropbox';
const DEFAULT_CREDENTIAL_HANDLE = 'dropbox.personal';
const DEFAULT_MAX_FETCH_BYTES = 8_000_000;
const DEFAULT_PAGE_LIMIT = 1_000;
const MAX_PAGE_LIMIT = 2_000;
const MAX_TRAVERSAL_ITEMS = 100_000;
const DROPBOX_PAGE_CURSOR_PREFIX = 'dbxp1:';
const FOLDER_MIME_TYPE = 'inode/directory';
const UNKNOWN_MIME_TYPE = 'application/octet-stream';

interface DropboxPageCursor {
  providerCursor?: string;
  itemOffset?: number;
  pageDigest?: string;
}

/**
 * Deletion identity recovery must never fail a listing pass. The resolver is
 * asked for the non-throwing lookup so an index that is still converging costs
 * one preserved item, reported as an unresolved deletion, instead of killing
 * the run and replaying the same provider page forever.
 */
export interface DropboxDeletedItemIdentityResolver {
  activeIdentityForLocatorIfIndexed(input: {
    provider: typeof CONNECTOR_ID;
    accountScope: string;
    locatorUri: string;
  }): SourceItemIdentity | undefined;
}

export interface DropboxSourceConnectorOptions {
  account: string;
  approvedScopeKey?: string;
  connectorId?: string;
  broker?: CredentialBroker;
  credentialHandle?: string;
  metadataClient?: DropboxMetadataClient;
  downloadClient?: DropboxContentDownloadClient;
  maxFetchBytes?: number;
  rootFolderPath?: string;
  recursive?: boolean;
  fetch?: CredentialBrokerFetch;
  apiBaseUrl?: string;
  contentBaseUrl?: string;
  deletedItemIdentityResolver?: DropboxDeletedItemIdentityResolver;
  /** Privacy-safe operational signal; never receives provider data. */
  onPageDigestRestart?: () => void;
}

export function createDropboxSourceConnector(options: DropboxSourceConnectorOptions): SourceConnector {
  const account = requireNonEmpty(options.account, 'Dropbox source connector account');
  const credentialHandle = options.credentialHandle?.trim() || DEFAULT_CREDENTIAL_HANDLE;
  const broker = options.broker ?? createEnvCredentialBroker();
  const maxFetchBytes = normalizePositiveInteger(options.maxFetchBytes, DEFAULT_MAX_FETCH_BYTES);
  const recursive = options.recursive ?? true;
  const rootListPath = listRootPath(options.rootFolderPath, options.approvedScopeKey, account);
  const connectorId = options.connectorId?.trim() || CONNECTOR_ID;

  let cachedSession: CredentialSession | undefined;
  let cachedMetadataClient = options.metadataClient;
  let cachedDownloadClient = options.downloadClient;

  const ensureSession = async (): Promise<CredentialSession> => {
    if (cachedSession) return cachedSession;
    try {
      cachedSession = await broker.issueSession({
        handle: credentialHandle,
        provider: 'dropbox',
        capability: 'dropbox.files.sync',
        trustDomain: 'secure_local',
        purpose: 'Authenticate the Dropbox source connector for contract-shaped ingest.',
      });
    } catch (error) {
      if (error instanceof CredentialBrokerError && error.code === 'credential_missing') {
        throw new Error(
          `Dropbox source connector credentials are missing (credential_missing) for handle ${credentialHandle}. `
          + 'Provision the Dropbox credential in the broker before authenticating.',
        );
      }
      throw error;
    }
    return cachedSession;
  };

  const ensureBearerToken = async (clientLabel: string): Promise<string> => {
    const session = await ensureSession();
    if (session.kind !== 'bearer_token') {
      throw new Error(
        `Credential handle ${credentialHandle} issued a ${session.kind} session; `
        + `inject a ${clientLabel} to use the Dropbox source connector with it.`,
      );
    }
    return session.token;
  };

  const ensureMetadataClient = async (): Promise<DropboxMetadataClient> => {
    if (cachedMetadataClient) return cachedMetadataClient;
    cachedMetadataClient = new DropboxApiMetadataClient({
      token: await ensureBearerToken('metadata client'),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
    });
    return cachedMetadataClient;
  };

  const ensureDownloadClient = async (): Promise<DropboxContentDownloadClient> => {
    if (cachedDownloadClient) return cachedDownloadClient;
    cachedDownloadClient = new DropboxApiContentDownloadClient({
      token: await ensureBearerToken('download client'),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.contentBaseUrl ? { contentBaseUrl: options.contentBaseUrl } : {}),
    });
    return cachedDownloadClient;
  };

  return {
    id: connectorId,
    family: 'file',

    async authenticate(): Promise<void> {
      await ensureSession();
    },

    listItems(listOptions?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      const limit = normalizePositiveInteger(listOptions?.limit, DEFAULT_PAGE_LIMIT, MAX_TRAVERSAL_ITEMS);
      const initialCursor = decodeDropboxPageCursor(listOptions?.cursor);
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        const client = await ensureMetadataClient();
        if (recursive && client.supportsNativeRecursive !== true) {
          throw new Error('Dropbox source connector requires native recursive listing.');
        }
        // Dropbox's limit is approximate, and /continue ignores the requested
        // limit altogether. A persisted cursor may also originate from an old
        // build that asked for a much larger provider page. The connector
        // therefore carries an offset INSIDE a provider page when a bounded
        // run ends mid-page. On resume it replays the cursor (or the initial
        // request), verifies the page digest, and continues at that offset.
        // If the provider changes the replayed page, the saved offset belongs
        // to the old bytes and is discarded: the new page restarts at zero.
        // This is the exact `truncated` arm of the frozen contract: no unread
        // tail is skipped and no oversized page can wedge every later run.
        const providerPageLimit = Math.min(MAX_PAGE_LIMIT, limit);
        let cursor = initialCursor;
        let hasMore = true;
        let remaining = limit;
        const requestedPages = new Set<string>();
        while (hasMore && remaining > 0) {
          const requestKey = cursor.providerCursor ?? '<initial>';
          if (requestedPages.has(requestKey)) {
            throw new Error('Dropbox metadata listing did not advance its continuation cursor.');
          }
          requestedPages.add(requestKey);
          const page = cursor.providerCursor === undefined
            ? await client.listFolder({
                path: rootListPath,
                recursive,
                limit: providerPageLimit,
                includeDeleted: true,
              })
            : await client.listFolderContinue({
                cursor: cursor.providerCursor,
                limit: providerPageLimit,
              });
          const offset = resumedPageOffset(cursor, page);
          if (cursor.itemOffset !== undefined && offset === 0) {
            options.onPageDigestRestart?.();
          }
          hasMore = Boolean(page.hasMore);
          const nextCursor = page.cursor?.trim();
          if (hasMore && !nextCursor) {
            throw new Error('Dropbox metadata listing reported more results without a continuation cursor.');
          }
          if (hasMore && nextCursor === cursor.providerCursor) {
            throw new Error('Dropbox metadata listing did not advance its continuation cursor.');
          }
          if (offset > page.entries.length) {
            throw new Error('Dropbox metadata resume offset is past the provider page.');
          }
          const available = page.entries.slice(offset);
          const accepted = available.slice(0, remaining);
          remaining -= accepted.length;
          if (accepted.length < available.length) {
            const resumeCursor = encodeDropboxPageCursor({
              ...(cursor.providerCursor ? { providerCursor: cursor.providerCursor } : {}),
              itemOffset: offset + accepted.length,
              pageDigest: metadataPageDigest(page),
            });
            yield {
              items: accepted.map((entry) => rawItemFromDropboxEntry(
                entry,
                account,
                nowIso(),
                options.deletedItemIdentityResolver,
              )),
              nextCursor: resumeCursor,
              done: false,
              truncated: true,
            };
            return;
          }
          yield {
            items: accepted.map((entry) => rawItemFromDropboxEntry(
              entry,
              account,
              nowIso(),
              options.deletedItemIdentityResolver,
            )),
            ...(nextCursor ? { nextCursor } : {}),
            done: !hasMore,
          };
          if (!hasMore || remaining === 0) return;
          cursor = { providerCursor: nextCursor! };
        }
      })();
    },

    async fetchItem(localItemId: string): Promise<RawItem> {
      const providerItemId = providerItemIdFromLocalItemId(localItemId, account);
      const downloader = await ensureDownloadClient();
      const fetchedAt = nowIso();
      const identity: SourceItemIdentity = {
        family: 'file',
        provider: CONNECTOR_ID,
        accountScope: account,
        providerItemId,
        providerFileId: providerItemId,
        localItemId,
      };
      try {
        const downloaded = await downloader.download({
          job: {
            provider_file_id: providerItemId,
          },
          max_bytes_per_file: maxFetchBytes,
        });
        const mimeType = downloaded.mime_type?.trim() || UNKNOWN_MIME_TYPE;
        return {
          identity,
          mimeType,
          content: { kind: 'bytes', mimeType, bytes: downloaded.bytes },
          metadata: Object.freeze({
            sizeBytes: downloaded.size_bytes ?? downloaded.bytes.byteLength,
            maxFetchBytes,
          }),
          fetchedAt,
        };
      } catch (error) {
        if (error instanceof DropboxContentTooLargeError || isDropboxContentTooLargeError(error)) {
          return {
            identity,
            mimeType: UNKNOWN_MIME_TYPE,
            content: { kind: 'metadata_only' },
            metadata: Object.freeze({ contentTooLarge: true, maxFetchBytes }),
            fetchedAt,
          };
        }
        throw error;
      }
    },

    classify(item: RawItem): SourceSensitivity {
      // Conservative floor (PLAN doctrine): Dropbox raw payloads default to
      // S4/secure_local until classified. Cheap deterministic signals may
      // upgrade the tier to S5; nothing here may downgrade below the floor.
      const text = classifiableText(item);
      const scan = text === undefined ? undefined : scanDropboxContentPolicyText({ text });
      return buildSourceSensitivity({
        trustTier: scan?.trust_tier === 'S5' ? 'S5' : 'S4',
        trustDomain: 'secure_local',
      });
    },
  };
}

function isDropboxContentTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { kind?: unknown; name?: unknown };
  return candidate.kind === 'dropbox_content_too_large'
    || candidate.name === 'DropboxContentTooLargeError';
}

function rawItemFromDropboxEntry(
  entry: DropboxMetadataEntry,
  account: string,
  fetchedAt: string,
  deletedItemIdentityResolver: DropboxDeletedItemIdentityResolver | undefined,
): RawItem {
  if (entry.tag === 'folder') return rawItemFromFolderEntry(entry, account, fetchedAt);
  if (entry.tag === 'deleted') {
    return rawItemFromDeletedEntry(entry, account, fetchedAt, deletedItemIdentityResolver);
  }
  return rawItemFromFileEntry(entry, account, fetchedAt);
}

function rawItemFromFileEntry(entry: DropboxFileMetadataEntry, account: string, fetchedAt: string): RawItem {
  const mimeType = entry.mimeType ?? dropboxMimeTypeFromName(entry.name) ?? UNKNOWN_MIME_TYPE;
  return {
    identity: {
      family: 'file',
      provider: CONNECTOR_ID,
      accountScope: account,
      providerItemId: entry.id,
      providerFileId: entry.id,
      localItemId: `${account}:${entry.id}`,
      ...(entry.rev ? { sourceVersion: entry.rev } : {}),
    },
    mimeType,
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({
      entryKind: 'file',
      deleted: false,
      name: entry.name,
      mimeType,
      // pathLower is the provider's own casefold of the path and it is carried
      // deliberately: this provider's paths are case-insensitive, so a folder
      // exclusion compared against the display path alone can miss on casing,
      // and a miss here means another system's corpus lands in personal search.
      ...(entry.pathDisplay ? { pathDisplay: entry.pathDisplay } : {}),
      ...(entry.pathLower ? { pathLower: entry.pathLower } : {}),
      ...(entry.size !== undefined ? { sizeBytes: entry.size } : {}),
      ...(entry.clientModified ? { clientModifiedAt: entry.clientModified } : {}),
      ...(entry.serverModified ? { serverModifiedAt: entry.serverModified } : {}),
      ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
    }),
    fetchedAt,
  };
}

function rawItemFromFolderEntry(entry: DropboxFolderMetadataEntry, account: string, fetchedAt: string): RawItem {
  return {
    identity: {
      family: 'file',
      provider: CONNECTOR_ID,
      accountScope: account,
      providerItemId: entry.id,
      localItemId: `${account}:${entry.id}`,
    },
    mimeType: FOLDER_MIME_TYPE,
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({
      entryKind: 'folder',
      deleted: false,
      name: entry.name,
      // pathLower is the provider's own casefold of the path and it is carried
      // deliberately: this provider's paths are case-insensitive, so a folder
      // exclusion compared against the display path alone can miss on casing,
      // and a miss here means another system's corpus lands in personal search.
      ...(entry.pathDisplay ? { pathDisplay: entry.pathDisplay } : {}),
      ...(entry.pathLower ? { pathLower: entry.pathLower } : {}),
    }),
    fetchedAt,
  };
}

function rawItemFromDeletedEntry(
  entry: DropboxDeletedMetadataEntry,
  account: string,
  fetchedAt: string,
  deletedItemIdentityResolver: DropboxDeletedItemIdentityResolver | undefined,
): RawItem {
  const locatorUri = entry.pathDisplay || entry.pathLower;
  const resolvedIdentity = !entry.id && locatorUri
    ? deletedItemIdentityResolver?.activeIdentityForLocatorIfIndexed({
        provider: CONNECTOR_ID,
        accountScope: account,
        locatorUri,
      })
    : undefined;
  const providerItemId = entry.id ?? resolvedIdentity?.providerItemId ?? deletedProviderItemId(entry);
  const providerFileId = entry.id ?? resolvedIdentity?.providerFileId;
  const localItemId = resolvedIdentity?.localItemId ?? `${account}:${providerItemId}`;
  return {
    identity: {
      family: 'file',
      provider: CONNECTOR_ID,
      accountScope: account,
      providerItemId,
      ...(providerFileId ? { providerFileId } : {}),
      localItemId,
    },
    mimeType: UNKNOWN_MIME_TYPE,
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({
      entryKind: 'deleted',
      deleted: true,
      deletedIdentityResolved: entry.id !== undefined || resolvedIdentity !== undefined,
      name: entry.name,
      // pathLower is the provider's own casefold of the path and it is carried
      // deliberately: this provider's paths are case-insensitive, so a folder
      // exclusion compared against the display path alone can miss on casing,
      // and a miss here means another system's corpus lands in personal search.
      ...(entry.pathDisplay ? { pathDisplay: entry.pathDisplay } : {}),
      ...(entry.pathLower ? { pathLower: entry.pathLower } : {}),
    }),
    fetchedAt,
  };
}

function encodeDropboxPageCursor(
  cursor: Required<Pick<DropboxPageCursor, 'itemOffset' | 'pageDigest'>> & DropboxPageCursor,
): string {
  const encoded = `${DROPBOX_PAGE_CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
  if (encoded.length > SOURCE_CHECKPOINT_MAX_LENGTH) {
    throw new TypeError('Dropbox metadata resume cursor is invalid.');
  }
  return encoded;
}

function decodeDropboxPageCursor(value: string | undefined): DropboxPageCursor {
  const normalized = value?.trim();
  if (!normalized) return {};
  // Existing provider cursors remain valid. Only the Olympus-prefixed form is
  // interpreted as an intra-page checkpoint.
  if (!normalized.startsWith(DROPBOX_PAGE_CURSOR_PREFIX)) return { providerCursor: normalized };
  if (normalized.length > SOURCE_CHECKPOINT_MAX_LENGTH) {
    throw new TypeError('Dropbox metadata resume cursor is invalid.');
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(normalized.slice(DROPBOX_PAGE_CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort();
    const expectedKeys = parsed.providerCursor === undefined
      ? ['itemOffset', 'pageDigest']
      : ['itemOffset', 'pageDigest', 'providerCursor'];
    if (
      keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])
      || (parsed.providerCursor !== undefined && (
        typeof parsed.providerCursor !== 'string'
        || !parsed.providerCursor.trim()
        || parsed.providerCursor.length > SOURCE_CHECKPOINT_MAX_LENGTH
      ))
      || !Number.isSafeInteger(parsed.itemOffset)
      || (parsed.itemOffset as number) < 1
      || (parsed.itemOffset as number) > MAX_TRAVERSAL_ITEMS
      || typeof parsed.pageDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(parsed.pageDigest)
    ) {
      throw new Error('invalid');
    }
    return {
      ...(typeof parsed.providerCursor === 'string'
        ? { providerCursor: parsed.providerCursor.trim() }
        : {}),
      itemOffset: parsed.itemOffset as number,
      pageDigest: parsed.pageDigest,
    };
  } catch {
    throw new TypeError('Dropbox metadata resume cursor is invalid.');
  }
}

function resumedPageOffset(cursor: DropboxPageCursor, page: DropboxMetadataPage): number {
  if (cursor.itemOffset === undefined) return 0;
  // A digest-bound offset has meaning only for the exact page bytes that
  // minted it. Provider churn invalidates that position, so the changed page
  // is replayed from zero under the same bounded traversal budget. This may
  // re-observe an idempotent prefix, but it can never skip a changed unread
  // tail or spin inside one invocation.
  return cursor.pageDigest === metadataPageDigest(page) ? cursor.itemOffset : 0;
}

function metadataPageDigest(page: DropboxMetadataPage): string {
  return createHash('sha256').update(JSON.stringify({
    entries: page.entries,
    cursor: page.cursor?.trim() || null,
    hasMore: Boolean(page.hasMore),
  })).digest('hex');
}

function classifiableText(item: RawItem): string | undefined {
  if (item.content.kind === 'text') return item.content.text;
  if (item.content.kind === 'bytes' && isTextualMimeType(item.content.mimeType)) {
    return new TextDecoder('utf-8', { fatal: false }).decode(item.content.bytes);
  }
  return undefined;
}

function isTextualMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return normalized.startsWith('text/')
    || normalized === 'application/json'
    || normalized === 'application/xml'
    || normalized.endsWith('+json')
    || normalized.endsWith('+xml');
}

function providerItemIdFromLocalItemId(localItemId: string, account: string): string {
  const prefix = `${account}:`;
  if (!localItemId.startsWith(prefix) || localItemId.length <= prefix.length) {
    throw new Error(`Dropbox source connector local item ids look like ${prefix}<provider item id>.`);
  }
  return localItemId.slice(prefix.length);
}

function deletedProviderItemId(entry: DropboxDeletedMetadataEntry): string {
  const ref = entry.pathLower || entry.pathDisplay || entry.name;
  return `deleted:${createHash('sha256').update(ref).digest('hex').slice(0, 32)}`;
}

function listRootPath(rootFolderPath: string | undefined, approvedScopeKey: string | undefined, account: string): string {
  const explicit = rootFolderPath?.trim();
  if (explicit !== undefined && explicit !== '') return explicit === '/' ? '' : explicit;
  const scope = approvedScopeKey?.trim();
  if (!scope) return '';
  const prefix = `dropbox.${account}:`;
  if (!scope.startsWith(prefix)) {
    throw new Error('Dropbox source connector approved scope must match the connector account.');
  }
  const scoped = scope.slice(prefix.length);
  if (scoped.startsWith('folder_id:')) {
    const folderId = scoped.slice('folder_id:'.length);
    return folderId.startsWith('id:') ? folderId : `id:${folderId}`;
  }
  return scoped === '/' ? '' : scoped;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, maximum?: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.max(1, Math.floor(value));
  return maximum === undefined ? floored : Math.min(floored, maximum);
}

function requireNonEmpty(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function nowIso(): string {
  return new Date().toISOString();
}

import type {
  OlympusFolderScopeNode,
  OlympusFolderScopeSourceId,
} from '../control-ui-contract.ts';
import {
  createEnvCredentialBroker,
  requireBearerTokenCredentialSession,
  type CredentialBroker,
  type CredentialBrokerFetch,
} from './credential-broker/index.ts';
import {
  GoogleDriveSourceConnector,
  GoogleDriveFolderAncestry,
  type GoogleDriveApiClient,
} from './google-connectors/drive.ts';
import type { GoogleDailyRequestBudget } from './google-connectors/request-budget.ts';
import {
  DropboxApiMetadataClient,
  type DropboxMetadataClient,
} from './dropbox-files/provider-client.ts';

const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const BROWSE_PAGE_SIZE = 100;

export interface SourceFolderScopeBrowseRequest {
  parentKey?: string;
  cursor?: string;
}

export interface SourceFolderScopeBrowsePage {
  nodes: OlympusFolderScopeNode[];
  nextCursor?: string;
}

export interface SourceFolderScopeBrowser {
  sourceId: OlympusFolderScopeSourceId;
  browse(request: SourceFolderScopeBrowseRequest): Promise<SourceFolderScopeBrowsePage>;
  validateSelections(
    selections: readonly { key: string; state: 'ingest' | 'metadata_only' | 'exclude' }[],
  ): Promise<Array<{
    key: string;
    state: 'ingest' | 'metadata_only' | 'exclude';
    ancestorKeys: string[];
  }>>;
}

export function createGoogleDriveFolderScopeBrowser(options: {
  credentialHandle: string;
  account?: string;
  credentialBroker?: CredentialBroker;
  fetch?: CredentialBrokerFetch;
  apiClient?: GoogleDriveApiClient;
  requestBudget?: GoogleDailyRequestBudget;
}): SourceFolderScopeBrowser {
  const connector = new GoogleDriveSourceConnector({
    credentialHandle: options.credentialHandle,
    ...(options.account ? { account: options.account } : {}),
    ...(options.credentialBroker ? { credentialBroker: options.credentialBroker } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.apiClient ? { apiClient: options.apiClient } : {}),
    ...(options.requestBudget ? { requestBudget: options.requestBudget } : {}),
    provenance: 'operator',
  });
  return {
    sourceId: 'google_drive.docs',
    async browse(request) {
      const parent = normalizeDriveParent(request.parentKey);
      const providerCursor = decodeCursor('google_drive.docs', parent, request.cursor);
      const client = await connector.apiClientForTooling();
      const page = await client.listFiles({
        pageSize: BROWSE_PAGE_SIZE,
        ...(providerCursor ? { pageToken: providerCursor } : {}),
        query: `trashed = false and mimeType = '${GOOGLE_FOLDER_MIME_TYPE}' and '${parent}' in parents`,
      });
      return {
        nodes: page.files
          .filter((file) => file.id && file.mimeType === GOOGLE_FOLDER_MIME_TYPE)
          .map((file) => ({
            key: file.id,
            ...(request.parentKey ? { parent_key: parent } : {}),
            name: file.name?.trim() || 'Untitled folder',
            kind: 'folder' as const,
            // Drive has no counts-only child hint on files.list. The folder is
            // browseable; an empty child page is the authoritative answer.
            has_children: true,
            selectable: true,
          })),
        ...(page.nextPageToken
          ? { nextCursor: encodeCursor('google_drive.docs', parent, page.nextPageToken) }
          : {}),
      };
    },
    async validateSelections(selections) {
      const client = await connector.apiClientForTooling();
      if (!client.getFolder) throw new Error('Google Drive folder validation is unavailable.');
      const ancestry = new GoogleDriveFolderAncestry(client);
      const ancestorsByKey = new Map<string, string[]>();
      for (const selection of selections) {
        const key = normalizeDriveParent(selection.key);
        if (key === 'root') throw new Error('Whole-account access requires explicit confirmation.');
        const folder = await client.getFolder(key);
        if (folder.id !== key || !folder.parents || folder.parents.length === 0) {
          throw new Error('A selected Google Drive folder could not be verified below the account root.');
        }
        const ancestors = await ancestry.resolve({ parents: folder.parents });
        if (!ancestors) throw new Error('A selected Google Drive folder ancestry could not be verified.');
        ancestorsByKey.set(key, ancestors);
      }
      return effectiveSelections(selections, (key) => ancestorsByKey.get(key) ?? []);
    },
  };
}

export function createDropboxFolderScopeBrowser(options: {
  credentialHandle: string;
  credentialBroker?: CredentialBroker;
  fetch?: CredentialBrokerFetch;
  metadataClient?: DropboxMetadataClient;
}): SourceFolderScopeBrowser {
  const broker = options.credentialBroker ?? createEnvCredentialBroker({
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  let client = options.metadataClient;
  const metadataClient = async (): Promise<DropboxMetadataClient> => {
    if (client) return client;
    const session = requireBearerTokenCredentialSession(await broker.issueSession({
      handle: options.credentialHandle,
      provider: 'dropbox',
      capability: 'dropbox.files.sync',
      trustDomain: 'secure_local',
      purpose: 'Browse Dropbox folders before source-scope approval.',
    }), options.credentialHandle);
    client = new DropboxApiMetadataClient({
      token: session.token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    return client;
  };
  return {
    sourceId: 'dropbox.files',
    async browse(request) {
      const parent = normalizeDropboxParent(request.parentKey);
      const providerCursor = decodeCursor('dropbox.files', parent, request.cursor);
      const api = await metadataClient();
      const page = providerCursor
        ? await api.listFolderContinue({ cursor: providerCursor, limit: BROWSE_PAGE_SIZE })
        : await api.listFolder({
            path: parent === '/' ? '' : parent,
            recursive: false,
            limit: BROWSE_PAGE_SIZE,
            includeDeleted: false,
          });
      return {
        nodes: page.entries
          .filter((entry) => entry.tag === 'folder')
          .map((entry) => ({
            key: normalizeDropboxNodeKey(entry.pathLower ?? entry.pathDisplay ?? `${parent}/${entry.name}`),
            ...(request.parentKey ? { parent_key: parent } : {}),
            name: entry.name,
            kind: 'folder' as const,
            has_children: true,
            selectable: true,
          })),
        ...(page.hasMore && page.cursor
          ? { nextCursor: encodeCursor('dropbox.files', parent, page.cursor) }
          : {}),
      };
    },
    async validateSelections(selections) {
      const api = await metadataClient();
      for (const selection of selections) {
        const key = normalizeDropboxNodeKey(selection.key);
        if (key === '/') throw new Error('Whole-account access requires explicit confirmation.');
        await api.listFolder({ path: key, recursive: false, limit: 1, includeDeleted: false });
      }
      return effectiveSelections(
        selections.map((selection) => ({ ...selection, key: normalizeDropboxNodeKey(selection.key) })),
        (key) => dropboxAncestorPaths(normalizeDropboxNodeKey(key)),
      );
    },
  };
}

function effectiveSelections(
  selections: readonly { key: string; state: 'ingest' | 'metadata_only' | 'exclude' }[],
  ancestorsFor: (key: string) => readonly string[],
): Array<{
  key: string;
  state: 'ingest' | 'metadata_only' | 'exclude';
  ancestorKeys: string[];
}> {
  const states = new Map(selections.map((selection) => [selection.key, selection.state]));
  return selections.map((selection) => {
    const ancestorKeys = [...ancestorsFor(selection.key)];
    const ancestorStates = ancestorKeys
      .map((key) => states.get(key))
      .filter((state): state is 'ingest' | 'metadata_only' | 'exclude' => state !== undefined);
    const state = ancestorStates.includes('exclude')
      ? 'exclude' as const
      : ancestorStates.includes('metadata_only') && selection.state === 'ingest'
        ? 'metadata_only' as const
        : selection.state;
    return { key: selection.key, state, ancestorKeys };
  });
}

function dropboxAncestorPaths(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(`/${parts.slice(0, index).join('/')}`);
  }
  return ancestors;
}

interface BoundBrowseCursor {
  version: 1;
  source: OlympusFolderScopeSourceId;
  parent: string;
  provider_cursor: string;
}

function encodeCursor(source: OlympusFolderScopeSourceId, parent: string, providerCursor: string): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    source,
    parent,
    provider_cursor: providerCursor,
  } satisfies BoundBrowseCursor)).toString('base64url');
}

function decodeCursor(
  source: OlympusFolderScopeSourceId,
  parent: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 8_192) throw new Error('Folder browse cursor is invalid.');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as BoundBrowseCursor;
    if (
      parsed.version !== 1
      || parsed.source !== source
      || parsed.parent !== parent
      || typeof parsed.provider_cursor !== 'string'
      || !parsed.provider_cursor
      || parsed.provider_cursor.length > 6_000
    ) throw new Error('shape');
    return parsed.provider_cursor;
  } catch {
    throw new Error('Folder browse cursor is invalid for this source and parent.');
  }
}

function normalizeDriveParent(value: string | undefined): string {
  if (value === undefined) return 'root';
  const parent = value.trim();
  if (!parent || parent.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(parent)) {
    throw new Error('Google Drive folder key is invalid.');
  }
  return parent;
}

function normalizeDropboxParent(value: string | undefined): string {
  if (value === undefined) return '/';
  return normalizeDropboxNodeKey(value);
}

function normalizeDropboxNodeKey(value: string): string {
  const trimmed = value.trim().replace(/\/{2,}/g, '/');
  if (!trimmed.startsWith('/') || trimmed.length > 4_096 || trimmed.includes('\0')) {
    throw new Error('Dropbox folder key is invalid.');
  }
  return trimmed.length > 1 && trimmed.endsWith('/') ? trimmed.slice(0, -1).toLowerCase() : trimmed.toLowerCase();
}

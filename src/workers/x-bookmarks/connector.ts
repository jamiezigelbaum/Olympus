// Contract 1 normalization for X bookmark snapshots. The real provider-facing
// SourceConnector lives in api-connector.ts and owns auth, polling, pagination,
// completeness, fetch, and classification; this module converts its bounded
// acquisition into stable RawItems for the shared connector store.

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import { buildSourceSensitivity, type SourceSensitivity } from '../../core/source-index/types.ts';
import { LocalConnectorStore } from '../connector-store/index.ts';
import { X_BOOKMARKS_CORPUS_ID } from './corpus-adapter.ts';
import type { XBookmarkPost } from './api.ts';
import {
  normalizeXBookmarkProviderFolderName,
  xBookmarkSearchText,
  xBookmarkSearchTextLiteralEscapes,
} from './folder-facets.ts';

export const X_BOOKMARKS_LIVE_CONNECTOR_ID = 'x_bookmarks_live';
export const X_BOOKMARKS_ARCHIVE_CONNECTOR_ID = 'x_bookmarks_archive';
export const X_BOOKMARKS_PROVIDER = 'x';

export interface XBookmarksSourceConnectorOptions {
  account: string;
  posts: readonly XBookmarkPost[];
  foldersByPostId?: ReadonlyMap<string, readonly XBookmarkFolderIdentity[]>;
  fetchedAt?: string;
  connectorId?: typeof X_BOOKMARKS_LIVE_CONNECTOR_ID | typeof X_BOOKMARKS_ARCHIVE_CONNECTOR_ID;
}

export interface XBookmarkFolderIdentity {
  id: string;
  name: string;
}

export function createXBookmarksSourceConnector(
  options: XBookmarksSourceConnectorOptions,
): SourceConnector {
  const account = requireAccount(options.account);
  const fetchedAt = validIso(options.fetchedAt ?? new Date().toISOString());
  const items = dedupePosts(options.posts).map((post) => xBookmarkRawItemFromPost(
    post,
    account,
    options.foldersByPostId?.get(post.id) ?? [],
    fetchedAt,
  ));
  const byLocalId = new Map(items.map((item) => [item.identity.localItemId, item]));

  return {
    id: options.connectorId ?? X_BOOKMARKS_LIVE_CONNECTOR_ID,
    family: 'x',
    async authenticate() {},
    listItems(listOptions?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      const limit = normalizeLimit(listOptions?.limit, items.length);
      const selected = items.slice(0, limit);
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: selected, done: selected.length === items.length };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = byLocalId.get(localItemId);
      if (!item) throw new Error('X bookmark connector cannot fetch an unknown item.');
      return item;
    },
    classify(_item: RawItem): SourceSensitivity {
      return buildSourceSensitivity({ trustTier: 'S1', trustDomain: 'internal' });
    },
  };
}

export function createXBookmarksConnectorStore(
  dbPath = defaultXBookmarksConnectorStoreDbPath(),
): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath,
    corpusId: X_BOOKMARKS_CORPUS_ID,
    family: 'x',
    trustDomain: 'internal',
  });
}

export function defaultXBookmarksConnectorStoreDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_DB_PATH?.trim();
  if (configured) return configured;
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'x-bookmarks-connector-store.sqlite');
}

export function xBookmarkLocalItemId(account: string, postId: string): string {
  return `${requireAccount(account)}:${requirePostId(postId)}`;
}

export function canonicalXBookmarkUrl(postId: string): string {
  return `https://x.com/i/web/status/${requirePostId(postId)}`;
}

export function xBookmarkRawItemFromPost(
  post: XBookmarkPost,
  account: string,
  folderMemberships: readonly XBookmarkFolderIdentity[],
  fetchedAt: string,
): RawItem {
  const postId = requirePostId(post.id);
  const folders = [...new Map(folderMemberships
    .map((folder) => ({
      id: folder.id.trim(),
      name: normalizeXBookmarkProviderFolderName(folder.name),
    }))
    .filter((folder) => folder.id && folder.name)
    .map((folder) => [folder.id, folder])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const folderIds = folders.map((folder) => folder.id);
  const folderNames = folders.map((folder) => folder.name);
  const username = post.authorUsername?.trim();
  const authorName = post.authorName?.trim();
  const title = username
    ? `@${username} on X`
    : authorName
      ? `${authorName} on X`
      : `X bookmark ${postId}`;
  const originalUrl = post.url?.trim();
  const url = canonicalXBookmarkUrl(postId);
  const senderId = post.authorId?.trim();
  const senderLabel = authorName || (username ? `@${username}` : undefined);
  const text = post.text?.trim() ?? '';
  const aliases = [
    'X bookmark',
    ...(username ? [`@${username}`, username] : []),
    ...(authorName ? [authorName] : []),
    ...folderNames,
  ];
  const identityAliases = folderIds.map((id) => `x-folder:${id}`);
  return {
    identity: {
      family: 'x',
      provider: X_BOOKMARKS_PROVIDER,
      accountScope: account,
      providerItemId: postId,
      localItemId: xBookmarkLocalItemId(account, postId),
      ...(post.sourceVersion ? { sourceVersion: post.sourceVersion } : {}),
    },
    mimeType: 'text/plain; charset=utf-8',
    content: text ? { kind: 'text', text } : { kind: 'metadata_only' },
    metadata: Object.freeze({
      title,
      locatorUri: url,
      url,
      aliases,
      identityAliases,
      searchText: xBookmarkSearchText({
        title,
        aliases,
        identityAliases,
        folderNames,
      }),
      searchTextLiteralEscapes: xBookmarkSearchTextLiteralEscapes(),
      ...(post.createdAt ? { authoredAt: post.createdAt } : {}),
      ...(senderId ? { senderId } : {}),
      ...(senderLabel ? { senderLabel } : {}),
      ...(username ? { authorUsername: username } : {}),
      ...(authorName ? { authorName } : {}),
      ...(originalUrl && originalUrl !== url ? { originalUrl } : {}),
      ...(folders.length > 0 ? { folders, folderIds, folderNames } : {}),
      ...(post.lang ? { language: post.lang } : {}),
      ...(post.mediaUrls?.length ? { mediaUrls: [...post.mediaUrls] } : {}),
      contentHash: createHash('sha256').update(JSON.stringify({ text, title, url, folders })).digest('hex'),
    }),
    fetchedAt,
  };
}

function dedupePosts(posts: readonly XBookmarkPost[]): XBookmarkPost[] {
  const byId = new Map<string, XBookmarkPost>();
  for (const post of posts) {
    const id = post.id?.trim();
    if (id && !byId.has(id)) byId.set(id, post);
  }
  return [...byId.values()];
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('X connector list limit must be positive.');
  return value;
}

function requireAccount(value: string): string {
  const account = value.trim();
  if (!account || account.length > 256) throw new TypeError('X bookmark account must be bounded and non-empty.');
  return account;
}

function requirePostId(value: string): string {
  const postId = value.trim();
  if (!postId || postId.length > 128) throw new TypeError('X bookmark post id must be bounded and non-empty.');
  return postId;
}

function validIso(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError('X connector fetchedAt must be a valid timestamp.');
  return new Date(value).toISOString();
}

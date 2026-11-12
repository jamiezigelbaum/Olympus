// Read the X bookmarks an earlier Olympus already stored, so the lane can take
// them in without paying the X API for them again (#1203; owner ask
// 2026-11-12: use the archived set, and fill in only what is missing).
//
// The source is an Olympus connector store from an earlier install, opened
// read-only. This module only reads it into the same
// XBookmarkPost shape the API client returns; the write goes through the X
// archive connector and the lane's own tier set (live-sync.ts), so tiering,
// judging and embedding run exactly as they do for fetched bookmarks.

import { Database } from 'bun:sqlite';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { SourceConnector } from '../../core/contracts.ts';
import { holdingItems } from '../archive-import/source-input.ts';
import type { XBookmarkPost } from './api.ts';
import {
  X_BOOKMARKS_ARCHIVE_CONNECTOR_ID,
  X_BOOKMARKS_PROVIDER,
  createXBookmarksSourceConnector,
} from './connector.ts';

export interface ArchivedXBookmarks {
  /** Newest post first. The archive kept no bookmark order, only post time. */
  posts: XBookmarkPost[];
  rowsRead: number;
  /** Rows without a usable post id, or tombstoned in the archive. */
  rowsSkipped: number;
  /** Posts whose text came from the archive's stored chunks. */
  postsWithText: number;
  newestAuthoredAt?: string;
}

const HANDLE_TITLE = /^@([A-Za-z0-9_]{1,15}) on X$/;

/**
 * The archive connector for imported bookmarks. Like every archive input, each
 * item is held until it has been judged, whatever the judge setup is, so no
 * imported text reaches a cloud embedder before its privacy is decided.
 */
export function archivedXBookmarksConnector(
  account: string,
  posts: readonly XBookmarkPost[],
  fetchedAt: string,
): SourceConnector {
  return holdingItems(createXBookmarksSourceConnector({
    account,
    posts,
    connectorId: X_BOOKMARKS_ARCHIVE_CONNECTOR_ID,
    fetchedAt,
  }));
}

export class XBookmarksArchiveImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XBookmarksArchiveImportError';
  }
}

export function readArchivedXBookmarks(archivePath: string): ArchivedXBookmarks {
  const path = archivePath.trim();
  if (!path || !isAbsolute(path) || !path.endsWith('.sqlite')) {
    throw new XBookmarksArchiveImportError('The archive path must be an absolute path to a .sqlite store.');
  }
  if (!existsSync(path)) {
    throw new XBookmarksArchiveImportError('No archived X bookmarks store at that path.');
  }
  const db = new Database(path, { readonly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000;');
    const columns = new Set(
      (db.query('PRAGMA table_info(items)').all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has('provider_item_id')) {
      throw new XBookmarksArchiveImportError('That store has no X bookmark items table.');
    }
    const pick = (name: string) => (columns.has(name) ? name : `NULL AS ${name}`);
    const where = [
      ...(columns.has('provider') ? [`provider = '${X_BOOKMARKS_PROVIDER}'`] : []),
      ...(columns.has('tombstoned') ? ['tombstoned = 0'] : []),
      ...(columns.has('deleted_at') ? ['deleted_at IS NULL'] : []),
    ];
    const rows = db.query(`
      SELECT ${pick('item_pk')}, provider_item_id, ${pick('title')}, ${pick('search_text')},
             ${pick('sender_label')}, ${pick('authored_at')}
      FROM items
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    `).all() as Array<{
      item_pk: number | null;
      provider_item_id: string | null;
      title: string | null;
      search_text: string | null;
      sender_label: string | null;
      authored_at: string | null;
    }>;
    const totalRows = (db.query('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;
    const textByItem = chunkTextByItem(db);

    const byId = new Map<string, XBookmarkPost>();
    let postsWithText = 0;
    for (const row of rows) {
      const id = row.provider_item_id?.trim();
      if (!id || id.length > 128 || byId.has(id)) continue;
      // Stored chunks are non-overlapping slices of the post text, so joining
      // them in order gives the text back. A store from before chunks kept
      // the text in search_text.
      const chunked = row.item_pk !== null ? textByItem?.get(row.item_pk) : undefined;
      const text = (textByItem ? chunked : row.search_text ?? undefined)?.trim();
      if (text) postsWithText += 1;
      const author = authorFrom(row.title, row.sender_label);
      const createdAt = validIso(row.authored_at);
      byId.set(id, {
        id,
        ...(text ? { text } : {}),
        ...author,
        ...(createdAt ? { createdAt } : {}),
      });
    }
    const posts = [...byId.values()].sort(newestFirst);
    const newestAuthoredAt = posts.find((post) => post.createdAt)?.createdAt;
    return {
      posts,
      rowsRead: totalRows,
      rowsSkipped: totalRows - posts.length,
      postsWithText,
      ...(newestAuthoredAt ? { newestAuthoredAt } : {}),
    };
  } finally {
    closeSqliteStore(db, { checkpoint: false });
  }
}

function chunkTextByItem(db: Database): Map<number, string> | undefined {
  const hasChunks = db.query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunks'",
  ).get();
  if (!hasChunks) return undefined;
  const byItem = new Map<number, string>();
  const rows = db.query(
    'SELECT item_pk, bounded_text FROM chunks ORDER BY item_pk, chunk_index',
  ).all() as Array<{ item_pk: number; bounded_text: string }>;
  for (const row of rows) byItem.set(row.item_pk, (byItem.get(row.item_pk) ?? '') + row.bounded_text);
  return byItem;
}

function authorFrom(
  title: string | null,
  senderLabel: string | null,
): Pick<XBookmarkPost, 'authorUsername' | 'authorName'> {
  const handle = title?.trim().match(HANDLE_TITLE)?.[1];
  const label = senderLabel?.trim();
  const labelHandle = label?.startsWith('@') ? label.slice(1) : undefined;
  const authorUsername = handle ?? labelHandle;
  const authorName = label && !label.startsWith('@') ? label : undefined;
  return {
    ...(authorUsername ? { authorUsername } : {}),
    ...(authorName ? { authorName } : {}),
  };
}

function validIso(value: string | null): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function newestFirst(left: XBookmarkPost, right: XBookmarkPost): number {
  const l = left.createdAt ? Date.parse(left.createdAt) : -Infinity;
  const r = right.createdAt ? Date.parse(right.createdAt) : -Infinity;
  if (l !== r) return r - l;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

// Corpus-level readability for the Dropbox files index, counts only.
//
// Answers one question the routed search cannot: how much of the scoped corpus
// could not be read AT ALL, whether or not it matched. An extraction gap is
// only ever attached to a document the router RETURNED, so the scanned PDF
// whose unreadable page holds the answer contributes nothing — its term is not
// in the path, the title, or any indexed page, so it never becomes a candidate.
//
// This unregistered compatibility helper remains read-only while the canonical
// connector-store provider supplies per-item coverage gaps. No product runtime
// imports it after Slice 2.

import { Database } from 'bun:sqlite';

import { closeSqliteStore } from '../../core/sqlite-store.ts';

export interface DropboxReadabilityGapCounts {
  // Documents extracted with durable gaps inside them (unread pages).
  partialDocuments: number;
  // Documents carrying no extracted text at all, for any reason.
  unreadDocuments: number;
}

// The provider column value for this index. Inlined rather than imported so
// this module takes no dependency on the frozen index file at all.
const PROVIDER = 'dropbox';

/**
 * One aggregate over `entries`. Extraction state lives on the entry row, so
 * this touches no chunk, artifact, or job table and never walks the unreadable
 * documents themselves.
 *
 * 'partial' is compared as a SQL literal on purpose: it is the completeness the
 * page-gap extractor writes, and installs whose extractor predates it simply
 * count zero, which is the truthful answer for them. The two counts are
 * disjoint — a partial document HAS been extracted, so it leaves the never-read
 * count as it joins the unread-pages one.
 */
export function dropboxReadabilityGapCounts(input: {
  dbPath: string;
  account?: string;
  approved_scope_key?: string;
}): DropboxReadabilityGapCounts {
  const filters = [
    'a.provider = ?',
    'e.tombstoned = 0',
    "e.entry_type = 'file'",
  ];
  const params: Array<string | number> = [PROVIDER];
  if (input.account) {
    filters.push('a.account_id = ?');
    params.push(input.account);
  }
  if (input.approved_scope_key) {
    filters.push('e.approved_scope_key = ?');
    params.push(input.approved_scope_key);
  }
  const db = new Database(input.dbPath, { readonly: true, create: false });
  try {
    // busy_timeout first: it must be armed before any pragma that can take a
    // lock, because the extraction fleet writes this file continuously. Short,
    // unlike the readers that must not miss data — this one is a courtesy on an
    // answer path, and a coverage sentence is never worth stalling an answer
    // for. Losing the race means the note is absent, which is the same outcome
    // as a provider that cannot report at all.
    db.exec('PRAGMA busy_timeout = 2000; PRAGMA query_only = ON;');
    const row = db.query(`
      SELECT
        SUM(CASE WHEN e.extraction_completeness = 'partial' THEN 1 ELSE 0 END) AS partial_documents,
        SUM(CASE WHEN e.extraction_status <> 'extracted' THEN 1 ELSE 0 END) AS unread_documents
      FROM entries e
      JOIN accounts a ON a.account_pk = e.account_pk
      WHERE ${filters.join(' AND ')}
    `).get(...params) as {
      partial_documents?: number | null;
      unread_documents?: number | null;
    } | undefined;
    return {
      partialDocuments: countOrZero(row?.partial_documents),
      unreadDocuments: countOrZero(row?.unread_documents),
    };
  } finally {
    // Read-only: there is no WAL of ours to checkpoint, and asking for one on a
    // query_only connection would only throw into the helper's own catch.
    closeSqliteStore(db, { checkpoint: false });
  }
}

function countOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

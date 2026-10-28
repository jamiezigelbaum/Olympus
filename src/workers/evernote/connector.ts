/**
 * The live Evernote connector (issue #568): one note per Evernote note, and
 * each of its attachments as a child item listed by name and read later, on
 * its own (docs/design/child-items.md). It reads Evernote's own MCP server
 * through the shared MCP layer (src/core/mcp-source/) with four read tools:
 * `search_notes`, `search_notebooks`, `get_note` and `get_attachment`.
 *
 * One listing is one full pass (listing.ts): both listings, then `get_note`
 * only for a note that is new, has a newer `updated`, or moved notebook.
 *
 * - Deletions and moves apply only when both listings completed: a listing
 *   that cannot finish throws before anything is emitted, so a partial pass
 *   changes nothing. A note the last complete pass held and neither listing
 *   names now is emitted deleted; so is an attachment a re-read note no
 *   longer carries.
 * - A note `get_note` gives no notebook for is shared with the person and in
 *   none of theirs: it is not imported, and it is counted.
 * - A note: its title, notebook, tags and times above its body (ENML as plain
 *   lines). Its notebook's name is its folder key, its tags its labels.
 * - An attachment: keyed by its MD5 (the first of a note's equal attachments
 *   `<md5>`, the n-th `<md5>.<n>`), judged on its own tier, held until
 *   judged. Its bytes are fetched when it is read, through a fresh
 *   `get_attachment` link, checked against the MD5 and typed from the bytes.
 *   Evernote's own recognition text is not used.
 *
 * The call budget, a cancellation, or a rate limit that persists while notes
 * are being read stop the pass there: what was read is kept, the rest is read
 * at the next pass, and deletions still apply (both listings completed).
 */
import { createHash } from 'node:crypto';
import type {
  RawItem,
  SourceClassificationSignals,
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import { childProviderItemId, CHILD_ITEM_ID_SEPARATOR } from '../../core/child-item-id.ts';
import { compactClassificationSignals, signalText, signalTexts } from '../../core/classification-signals.ts';
import { FileExtractionSourceError, type FileExtractionSourceErrorKind } from '../../core/file-extraction-source.ts';
import { fileMimeTypeFromBytes } from '../../core/file-mime.ts';
import { isMcpSourceError, type McpSourceErrorKind } from '../../core/mcp-source/errors.ts';
import type { McpSourceSession } from '../../core/mcp-source/session.ts';
import { cleanTags } from '../archive-import/notes/note.ts';
import { enmlToText } from '../archive-import/evernote/enml.ts';
import { listNotebooks, listNotes, type EvernoteNoteHit } from './listing.ts';

export const EVERNOTE_SOURCE_ID = 'evernote.notes';
export const EVERNOTE_PROVIDER = 'evernote';
export const EVERNOTE_CONNECTOR_ID = 'evernote_live';
export const EVERNOTE_MCP_SERVER_URL = 'https://mcp.evernote.com/mcp';
export const EVERNOTE_MCP_SCOPE = 'read';
/** Hosts (and subdomains) the sign-in may go to. */
export const EVERNOTE_AUTHORIZATION_HOSTS = ['evernote.com'] as const;
/** Hosts an attachment's download link may point at. */
export const EVERNOTE_DOWNLOAD_HOSTS = ['storage.googleapis.com'] as const;
export const EVERNOTE_READ_TOOLS = ['search_notes', 'search_notebooks', 'get_note', 'get_attachment'] as const;
/** Tool calls one pass may make (a first pass of a large account finishes over several). */
export const EVERNOTE_PASS_CALL_BUDGET = 3_000;
export const EVERNOTE_ATTACHMENT_LOCATOR_PREFIX = 'evernote-res1:';
const PAGE_ITEMS = 50;
const MAX_TITLE_CHARS = 500;

/** What the last complete pass held, for the next pass's deletions and change checks. */
export interface EvernotePassRecord {
  version: 1;
  completedAt: string;
  /** Note id → its version; a shared note's starts with `shared|`. `children`: its attachments' keys. */
  notes: Record<string, { v: string; children?: string[] }>;
}

export interface EvernotePassCounts {
  notes_listed: number;
  notebooks: number;
  notes_read: number;
  notes_unchanged: number;
  notes_moved: number;
  notes_deleted: number;
  shared_not_imported: number;
  notes_not_read: number;
  attachments_listed: number;
  tool_calls: number;
  rate_limit_retries: number;
}

export interface EvernotePassOutcome {
  record: EvernotePassRecord;
  counts: EvernotePassCounts;
  /** Why notes were left for the next pass, when they were. */
  stoppedBy?: McpSourceErrorKind;
}

/**
 * The last complete pass with the notes an unfinished pass read since. Those may be stored, so they
 * count for deletions, with every attachment either pass saw, and are read again rather than skipped.
 */
export function evernotePassWithUnfinished(
  record: EvernotePassRecord | undefined,
  unfinished: EvernotePassRecord['notes'] | undefined,
): EvernotePassRecord | undefined {
  if (!unfinished || Object.keys(unfinished).length === 0) return record;
  const notes = { ...record?.notes };
  for (const [noteId, entry] of Object.entries(unfinished)) {
    const children = [...new Set([...(notes[noteId]?.children ?? []), ...(entry.children ?? [])])];
    notes[noteId] = { v: 'unfinished|', ...(children.length > 0 ? { children } : {}) };
  }
  return { version: 1, completedAt: record?.completedAt ?? '', notes };
}

/**
 * The notes unfinished passes read, with another pass's added. An attachment key stays until a pass
 * commits: a retry that stops again may not have stored the deletion of an attachment it no longer sees.
 */
export function evernoteUnfinishedWith(
  unfinished: EvernotePassRecord['notes'] | undefined,
  notes: EvernotePassRecord['notes'],
): EvernotePassRecord['notes'] {
  const next = { ...unfinished };
  for (const [noteId, entry] of Object.entries(notes)) {
    const children = [...new Set([...(next[noteId]?.children ?? []), ...(entry.children ?? [])])];
    next[noteId] = { v: entry.v, ...(children.length > 0 ? { children } : {}) };
  }
  return next;
}

export interface EvernoteConnectorOptions {
  accountScope: string;
  /** A fresh, unopened session for one pass or one attachment read. */
  session: (purpose: 'pass' | 'attachment') => McpSourceSession;
  /** The last complete pass, if any. */
  previous?: () => EvernotePassRecord | undefined;
  /** Before each page goes out: every note this pass has read so far, kept until the pass is committed. */
  readSoFar?: (notes: EvernotePassRecord['notes']) => void;
  downloadHosts?: readonly string[];
  downloadFetch?: typeof fetch;
  now?: () => Date;
}

export interface EvernoteSourceConnector extends SourceConnector {
  /** The pass the last listing completed (both listings), else undefined. */
  lastOutcome(): EvernotePassOutcome | undefined;
  fetchItemWithin(localItemId: string, options: { maxBytes?: number; expectedVersion?: string; deferredBytes?: { locator: string } }): Promise<RawItem>;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** A note's version: its `updated` and its notebook (id and name), so a move or a rename re-reads it. */
export function evernoteNoteVersion(updatedAt: string, notebookId: string, notebookLabel: string): string {
  return `${updatedAt}|${notebookId}|${digest(notebookLabel)}`;
}

/** The keys of a note's attachments, in its order: `<md5>`, then `<md5>.<n>` for the n-th equal one. */
export function evernoteAttachmentKeys(hashes: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return hashes.map((hash) => {
    const n = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, n);
    return n === 1 ? hash : `${hash}.${n}`;
  });
}

function iso(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** What stops the reading of notes without failing the pass. */
const PASS_STOPS: ReadonlySet<McpSourceErrorKind> = new Set(['budget_exhausted', 'cancelled', 'rate_limited']);

const MCP_TO_SOURCE_ERROR:Record<McpSourceErrorKind, FileExtractionSourceErrorKind> = {
  auth_missing: 'source_auth_expired',
  auth_expired: 'source_auth_expired',
  auth_revoked: 'source_auth_expired',
  permission_missing: 'source_permission_denied',
  rate_limited: 'source_rate_limited',
  server_error: 'source_unavailable',
  tool_refused: 'source_request_rejected',
  budget_exhausted: 'source_budget_exhausted',
  cancelled: 'source_unavailable',
};

export function createEvernoteSourceConnector(options: EvernoteConnectorOptions): EvernoteSourceConnector {
  const account = options.accountScope;
  const now = options.now ?? (() => new Date());
  const downloadHosts = options.downloadHosts ?? EVERNOTE_DOWNLOAD_HOSTS;
  const listed = new Map<string, RawItem>();
  let outcome: EvernotePassOutcome | undefined;

  const identity = (providerItemId: string, sourceVersion?: string, parent?: RawItem) => ({
    family: 'note' as const,
    provider: EVERNOTE_PROVIDER,
    accountScope: account,
    providerItemId,
    localItemId: `${account}:${providerItemId}`,
    ...(sourceVersion ? { sourceVersion } : {}),
    ...(parent ? { parent: { providerItemId: parent.identity.providerItemId, localItemId: parent.identity.localItemId } } : {}),
  });

  const deletedItem = (providerItemId: string): RawItem => ({
    identity: identity(providerItemId),
    mimeType: 'text/plain',
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({ deleted: true }),
    fetchedAt: now().toISOString(),
  });

  /** A note and its attachments from `get_note`'s answer. */
  const noteItems = (note: Record<string, unknown>, version: string, notebookLabel: string): { items: RawItem[]; childKeys: string[] } => {
    const id = String(note.id);
    const title = (typeof note.title === 'string' ? note.title.trim() : '').slice(0, MAX_TITLE_CHARS) || '(untitled)';
    const createdAt = iso(note.created);
    const updatedAt = iso(note.updated);
    const tags = cleanTags((Array.isArray(note.tags) ? note.tags : []).map((tag) => String(record(tag)?.name ?? '')));
    const body = enmlToText(typeof note.content === 'string' ? note.content : '');
    const resources = (Array.isArray(note.resources) ? note.resources : [])
      .map(record)
      .filter((resource): resource is Record<string, unknown> => typeof resource?.hash === 'string' && /^[0-9a-f]{32}$/i.test(resource.hash));
    const hashes = resources.map((resource) => String(resource.hash).toLowerCase());
    const keys = evernoteAttachmentKeys(hashes);
    const names = resources.map((resource, index) => (typeof resource.name === 'string' && resource.name.trim() !== ''
      ? resource.name.trim()
      : `Attachment ${index + 1} (${typeof resource.mime === 'string' ? resource.mime : 'file'})`).slice(0, 500));
    const head = [
      title,
      `Notebook: ${notebookLabel}`,
      tags.length > 0 ? `Tags: ${tags.join(', ')}` : undefined,
      createdAt ? `Created: ${createdAt.slice(0, 10)}` : undefined,
      updatedAt && updatedAt !== createdAt ? `Updated: ${updatedAt.slice(0, 10)}` : undefined,
      names.length > 0 ? `Attachments: ${names.join(', ')}` : undefined,
    ].filter((line): line is string => line !== undefined && line !== '');
    const text = [head.join('\n'), body.text].filter((part) => part !== '').join('\n\n');
    const authoredAt = createdAt ?? updatedAt ?? now().toISOString();
    const folderKeys = notebookLabel ? [notebookLabel] : [];
    const parent: RawItem = {
      identity: identity(id, version),
      mimeType: 'text/plain',
      content: { kind: 'text', text },
      metadata: Object.freeze({
        title,
        tags,
        notebook: notebookLabel,
        folderKeys,
        authoredAt,
        ...(createdAt ? { createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        contentHash: createHash('sha256').update(text).digest('hex'),
      }),
      fetchedAt: now().toISOString(),
    };
    const children = resources.map((resource, index): RawItem => {
      const mime = typeof resource.mime === 'string' && resource.mime !== '' ? resource.mime : 'application/octet-stream';
      const size = typeof resource.sizeBytes === 'number' && Number.isSafeInteger(resource.sizeBytes) && resource.sizeBytes >= 0 ? resource.sizeBytes : undefined;
      return {
        identity: identity(childProviderItemId(id, keys[index]!), hashes[index], parent),
        mimeType: mime,
        content: { kind: 'metadata_only' },
        metadata: Object.freeze({
          title: names[index],
          name: names[index],
          mimeType: mime,
          authoredAt,
          notebook: notebookLabel,
          folderKeys,
          ...(size !== undefined ? { sizeBytes: size } : {}),
        }),
        fetchedAt: now().toISOString(),
        // Each attachment is judged on its own content before any of it is kept.
        holdContentUntilJudged: true,
        deferredBytes: { locator: `${EVERNOTE_ATTACHMENT_LOCATOR_PREFIX}${id}:${hashes[index]}`, available: true, ...(size !== undefined ? { sizeBytes: size } : {}) },
      };
    });
    return { items: [parent, ...children], childKeys: keys };
  };

  async function* pass(listOptions: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
    outcome = undefined;
    listed.clear();
    const previous = options.previous?.();
    const session = options.session('pass');
    await session.open();
    try {
      // Both listings first. Either one failing throws here, before anything is emitted.
      const byDate = new Map<string, EvernoteNoteHit>();
      await listNotes(session, '', byDate, now().getTime());
      const notebooks = await listNotebooks(session);
      const notebookOf = new Map<string, { id: string; label: string }>();
      for (const book of notebooks) {
        const inBook = new Map<string, EvernoteNoteHit>();
        await listNotes(session, book.filter, inBook, now().getTime());
        for (const [noteId, hit] of inBook) {
          notebookOf.set(noteId, { id: book.id, label: book.label });
          if (!byDate.has(noteId)) byDate.set(noteId, hit);
        }
      }

      const counts: EvernotePassCounts = {
        notes_listed: byDate.size, notebooks: notebooks.length, notes_read: 0, notes_unchanged: 0, notes_moved: 0,
        notes_deleted: 0, shared_not_imported: 0, notes_not_read: 0, attachments_listed: 0, tool_calls: 0, rate_limit_retries: 0,
      };
      const nextNotes: EvernotePassRecord['notes'] = {};
      const readNotes: EvernotePassRecord['notes'] = {};
      const pending: RawItem[] = [];
      let stoppedBy: McpSourceErrorKind | undefined;

      // A note retired with every attachment the last complete pass recorded for it.
      const retire = (noteId: string, entry: EvernotePassRecord['notes'][string] | undefined) => {
        pending.push(deletedItem(noteId), ...(entry?.children ?? []).map((key) => deletedItem(childProviderItemId(noteId, key))));
        counts.notes_deleted += 1;
      };

      // Deletions: a note the last complete pass held that neither listing names now.
      for (const [noteId, entry] of Object.entries(previous?.notes ?? {})) {
        if (byDate.has(noteId) || entry.v.startsWith('shared|')) continue;
        retire(noteId, entry);
      }

      for (const [noteId, hit] of byDate) {
        const before = previous?.notes[noteId];
        const book = notebookOf.get(noteId);
        if (!book && before?.v === `shared|${hit.updatedAt}`) {
          // Shared with the person and unchanged: still not imported.
          nextNotes[noteId] = before;
          counts.shared_not_imported += 1;
          continue;
        }
        const version = book ? evernoteNoteVersion(hit.updatedAt, book.id, book.label) : undefined;
        if (version) {
          const stored = listOptions.storedItem?.({ provider: EVERNOTE_PROVIDER, accountScope: account, providerItemId: noteId }, (a, b) => a.localeCompare(b));
          // Skipped only when the last committed pass recorded this version: a note stored by a pass
          // that stopped before its record was written is read again, so its attachments and their
          // keys are complete.
          const current = before?.v === version
            && (!stored || (stored.version === version && stored.tombstoned !== true && stored.incomplete !== true));
          if (current && before) {
            nextNotes[noteId] = before;
            counts.notes_unchanged += 1;
            continue;
          }
        }
        if (stoppedBy) {
          if (before) nextNotes[noteId] = before;
          counts.notes_not_read += 1;
          continue;
        }
        let out;
        try {
          out = await session.callTool('get_note', { noteId });
        } catch (error) {
          if (!isMcpSourceError(error) || !PASS_STOPS.has(error.kind)) throw error;
          stoppedBy = error.kind;
          if (before) nextNotes[noteId] = before;
          counts.notes_not_read += 1;
          continue;
        }
        const note = record(out.data);
        if (out.isError || !note || note.id !== noteId) {
          // Not readable now (gone between the listing and the read, say): asked again next pass.
          if (before) nextNotes[noteId] = before;
          counts.notes_not_read += 1;
          continue;
        }
        const notebookId = typeof note.notebookId === 'string' && note.notebookId !== '' ? note.notebookId : undefined;
        if (!notebookId) {
          // Imported before, shared-only now: what was imported leaves the index.
          if (before && !before.v.startsWith('shared|')) retire(noteId, before);
          nextNotes[noteId] = { v: `shared|${hit.updatedAt}` };
          counts.shared_not_imported += 1;
          continue;
        }
        if (note.active === false) {
          retire(noteId, before);
          continue;
        }
        const label = book?.id === notebookId ? book.label : notebooks.find((entry) => entry.id === notebookId)?.label ?? '';
        const noteVersion = evernoteNoteVersion(hit.updatedAt, notebookId, label);
        const built = noteItems(note, noteVersion, label);
        if (before && !before.v.startsWith('shared|') && before.v.split('|')[0] === hit.updatedAt) counts.notes_moved += 1;
        // An attachment the note no longer carries.
        for (const key of before?.children ?? []) {
          if (!built.childKeys.includes(key)) pending.push(deletedItem(childProviderItemId(noteId, key)));
        }
        pending.push(...built.items);
        nextNotes[noteId] = { v: noteVersion, ...(built.childKeys.length > 0 ? { children: built.childKeys } : {}) };
        readNotes[noteId] = nextNotes[noteId];
        counts.notes_read += 1;
        counts.attachments_listed += built.childKeys.length;
        // Pages go out as they fill, so a long first pass stores as it reads.
        while (pending.length >= PAGE_ITEMS) {
          options.readSoFar?.(readNotes);
          const items = pending.splice(0, PAGE_ITEMS);
          for (const item of items) listed.set(item.identity.localItemId, item);
          yield { items, done: false };
        }
      }
      counts.tool_calls = session.calls;
      counts.rate_limit_retries = session.rateLimitRetries;
      // Set before the last page: the spine stops reading at a done page.
      outcome = {
        record: { version: 1, completedAt: now().toISOString(), notes: nextNotes },
        counts,
        ...(stoppedBy ? { stoppedBy } : {}),
      };
      options.readSoFar?.(readNotes);
      for (const item of pending) listed.set(item.identity.localItemId, item);
      yield { items: pending, done: true };
    } finally {
      await session.close();
    }
  }

  /** An attachment's bytes through a fresh link, bounded, checked against its MD5 and typed from the bytes. */
  const readAttachment = async (localItemId: string, locator: string, maxBytes: number | undefined): Promise<RawItem> => {
    const match = new RegExp(`^${EVERNOTE_ATTACHMENT_LOCATOR_PREFIX}([^:]+):([0-9a-f]{32})$`).exec(locator);
    const providerItemId = localItemId.startsWith(`${account}:`) ? localItemId.slice(account.length + 1) : '';
    const [parentId] = providerItemId.split(CHILD_ITEM_ID_SEPARATOR);
    if (!match || parentId !== match[1]) throw new FileExtractionSourceError('source_content_unavailable');
    const [, noteId, hash] = match;
    const session = options.session('attachment');
    let link: Record<string, unknown> | undefined;
    try {
      await session.open();
      const out = await session.callTool('get_attachment', { noteId, hash });
      if (out.isError) throw new FileExtractionSourceError('source_item_not_found');
      link = record(out.data);
    } catch (error) {
      if (isMcpSourceError(error)) throw new FileExtractionSourceError(MCP_TO_SOURCE_ERROR[error.kind]);
      throw error;
    } finally {
      await session.close();
    }
    let url: URL;
    try {
      url = new URL(String(link?.downloadUrl ?? ''));
    } catch {
      throw new FileExtractionSourceError('source_content_unavailable');
    }
    const loopback = url.hostname === '127.0.0.1' && downloadHosts.includes('127.0.0.1');
    if ((url.protocol !== 'https:' && !loopback) || !downloadHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
      throw new FileExtractionSourceError('source_content_unavailable');
    }
    let response: Response;
    try {
      // The link is pre-signed: it carries no Olympus or Evernote credential.
      response = await (options.downloadFetch ?? fetch)(url, { redirect: 'error' });
    } catch {
      throw new FileExtractionSourceError('network_unreachable');
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new FileExtractionSourceError(response.status === 404 ? 'source_item_not_found' : 'source_unavailable');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new FileExtractionSourceError('source_too_large');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    // Bytes that are not the attachment the note lists are refused, never read.
    if (createHash('md5').update(bytes).digest('hex') !== hash) throw new FileExtractionSourceError('source_content_unavailable');
    const mimeType = fileMimeTypeFromBytes(bytes) ?? 'application/octet-stream';
    return {
      identity: identity(providerItemId, hash),
      mimeType,
      content: { kind: 'bytes', mimeType, bytes },
      metadata: Object.freeze({}),
      fetchedAt: now().toISOString(),
    };
  };

  return {
    id: EVERNOTE_CONNECTOR_ID,
    family: 'note',
    async authenticate(): Promise<void> {},
    listItems: (listOptions: SourceConnectorListOptions = {}) => pass(listOptions),
    async fetchItem(localItemId: string, fetchOptions?: SourceConnectorFetchOptions): Promise<RawItem> {
      if (fetchOptions?.deferredBytes) return readAttachment(localItemId, fetchOptions.deferredBytes.locator, undefined);
      const item = listed.get(localItemId);
      if (!item) throw new FileExtractionSourceError('source_item_not_found', { detailForHash: localItemId });
      return item;
    },
    fetchItemWithin: (localItemId, within) => {
      if (!within.deferredBytes) throw new FileExtractionSourceError('source_content_unavailable');
      return readAttachment(localItemId, within.deferredBytes.locator, within.maxBytes);
    },
    classificationSignals(item: RawItem): SourceClassificationSignals {
      return compactClassificationSignals({
        title: signalText(item.metadata, 'title'),
        folderKeys: signalTexts(item.metadata, 'folderKeys'),
        labels: signalTexts(item.metadata, 'tags'),
      });
    },
    lastOutcome: () => outcome,
  };
}

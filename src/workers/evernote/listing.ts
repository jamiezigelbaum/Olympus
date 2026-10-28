/**
 * The two listings of one Evernote pass, over the MCP read tools
 * (`search_notes`, `search_notebooks`):
 *
 * - By date: which notes exist. `search_notes` returns nothing past its cap
 *   (2,000) however many match, so a query whose total is over the cap is
 *   split by creation time (`created:` / `-created:`) until every slice fits.
 * - By notebook: where each note lives. A search hit carries no notebook, so
 *   every notebook is listed with its own filter. `search_notebooks` returns
 *   at most 100 with no paging, so notebooks are enumerated by name fragments
 *   until as many are found as the server says there are.
 *
 * Either listing that cannot be completed throws `EvernoteListingIncomplete`:
 * the pass then changes nothing.
 */
import type { McpSourceSession } from '../../core/mcp-source/session.ts';

/** `search_notes` returns nothing at or past this offset. */
export const EVERNOTE_SEARCH_CAP = 2_000;
const PAGE = 100;
const NOTEBOOK_MAX = 100;
const FRAGMENT_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A listing could not be completed (a slice over the cap that cannot be split, a count that does not add up). */
export class EvernoteListingIncomplete extends Error {
  constructor() {
    super('The Evernote listing could not be completed.');
    this.name = 'EvernoteListingIncomplete';
  }
}

export interface EvernoteNoteHit {
  noteId: string;
  updatedAt: string;
}

export interface EvernoteNotebook {
  id: string;
  label: string;
  filter: string;
}

interface SearchPage {
  hits: EvernoteNoteHit[];
  total: number;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** `20240131T120000Z` (the search grammar's UTC time). */
export function evernoteSearchTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function searchNotes(session: McpSourceSession, query: string, startIndex: number): Promise<SearchPage> {
  const out = await session.callTool('search_notes', {
    query, startIndex, maxResults: PAGE, sortBy: 'created', ascending: true,
  });
  const data = record(out.data);
  if (out.isError || !data || !Array.isArray(data.hits)) throw new EvernoteListingIncomplete();
  const hits: EvernoteNoteHit[] = [];
  for (const raw of data.hits) {
    const hit = record(raw);
    if (typeof hit?.noteId !== 'string' || hit.noteId === '') throw new EvernoteListingIncomplete();
    hits.push({ noteId: hit.noteId, updatedAt: typeof hit.updatedAt === 'string' ? hit.updatedAt : '' });
  }
  const total = typeof data.totalResultCount === 'number' && Number.isSafeInteger(data.totalResultCount) ? data.totalResultCount : -1;
  if (total < 0) throw new EvernoteListingIncomplete();
  return { hits, total };
}

/**
 * Every note `filter` matches, into `into`. Pages when the total fits under
 * the cap, else splits by creation time. The cap is the known 2,000 and also
 * whatever the server shows: pages that run dry before the total.
 */
export async function listNotes(session: McpSourceSession, filter: string, into: Map<string, EvernoteNoteHit>, now: number): Promise<void> {
  const first = await searchNotes(session, filter, 0);
  if (first.total <= EVERNOTE_SEARCH_CAP && await pageAll(session, filter, first, into)) return;
  // Open-ended slices before 1990 and after next year, and the years between, split further as needed.
  const edge = Date.UTC(new Date(now).getUTCFullYear() + 2, 0, 1);
  const start = Date.UTC(1990, 0, 1);
  await listRange(session, filter, undefined, start, into);
  await listRange(session, filter, start, edge, into);
  await listRange(session, filter, edge, undefined, into);
}

async function listRange(
  session: McpSourceSession,
  filter: string,
  from: number | undefined,
  to: number | undefined,
  into: Map<string, EvernoteNoteHit>,
): Promise<void> {
  const query = [
    filter,
    from !== undefined ? `created:${evernoteSearchTime(from)}` : '',
    to !== undefined ? `-created:${evernoteSearchTime(to)}` : '',
  ].filter(Boolean).join(' ');
  const first = await searchNotes(session, query, 0);
  if (first.total <= EVERNOTE_SEARCH_CAP && await pageAll(session, query, first, into)) return;
  // Over the cap: halve the slice. One second is the grammar's finest step.
  if (from === undefined || to === undefined || to - from < 2_000) throw new EvernoteListingIncomplete();
  const middle = from + Math.floor((to - from) / 2_000) * 1_000;
  await listRange(session, filter, from, middle, into);
  await listRange(session, filter, middle, to, into);
}

/**
 * Pages a query to its end. False when the pages ran dry before the total
 * (the server's cap): the caller splits. A note added while paging only adds.
 */
async function pageAll(session: McpSourceSession, query: string, first: SearchPage, into: Map<string, EvernoteNoteHit>): Promise<boolean> {
  const hits = new Map<string, EvernoteNoteHit>();
  let page = first;
  for (let startIndex = 0; ;) {
    for (const hit of page.hits) hits.set(hit.noteId, hit);
    startIndex += page.hits.length;
    if (page.hits.length === 0 || startIndex >= first.total) break;
    page = await searchNotes(session, query, startIndex);
  }
  if (hits.size < first.total) return false;
  for (const [noteId, hit] of hits) into.set(noteId, hit);
  return true;
}

async function searchNotebooks(session: McpSourceSession, query: string, sortBy: 'name' | 'updated' = 'name'): Promise<{ books: EvernoteNotebook[]; total: number }> {
  const out = await session.callTool('search_notebooks', { query, maxResults: NOTEBOOK_MAX, sortBy });
  const data = record(out.data);
  if (out.isError || !data || !Array.isArray(data.hits)) throw new EvernoteListingIncomplete();
  const books: EvernoteNotebook[] = [];
  for (const raw of data.hits) {
    const hit = record(raw);
    if (typeof hit?.notebookId !== 'string' || hit.notebookId === '' || hit.notebookId.includes('"')) throw new EvernoteListingIncomplete();
    // Trimmed as the ENEX import trims the export's file name, so both give a note the same folder key.
    const label = typeof hit.label === 'string' ? hit.label.trim() : '';
    // The server's own filter when it is the notebook-id filter, else the same built here.
    const filter = typeof hit.searchFilter === 'string' && hit.searchFilter === `nbGuid:"${hit.notebookId}"`
      ? hit.searchFilter
      : `nbGuid:"${hit.notebookId}"`;
    books.push({ id: hit.notebookId, label, filter });
  }
  const total = typeof data.totalResultCount === 'number' && Number.isSafeInteger(data.totalResultCount) ? data.totalResultCount : books.length;
  return { books, total };
}

/** Every notebook of the account: the full list when it fits, else found by name fragments until the count is reached. */
export async function listNotebooks(session: McpSourceSession): Promise<EvernoteNotebook[]> {
  const found = new Map<string, EvernoteNotebook>();
  const add = (books: readonly EvernoteNotebook[]): void => {
    for (const book of books) found.set(book.id, book);
  };
  const all = await searchNotebooks(session, '');
  add(all.books);
  if (all.books.length < NOTEBOOK_MAX || found.size >= all.total) {
    if (found.size < all.total) throw new EvernoteListingIncomplete();
    return [...found.values()];
  }
  add((await searchNotebooks(session, '', 'updated')).books);
  const tried = new Set<string>();
  const queue = [...FRAGMENT_ALPHABET];
  while (queue.length > 0 && found.size < all.total) {
    const fragment = queue.shift()!;
    if (tried.has(fragment)) continue;
    tried.add(fragment);
    const result = await searchNotebooks(session, fragment);
    add(result.books);
    // A full answer may hide more: refine with one more character, from the alphabet and the names found.
    if (result.books.length >= NOTEBOOK_MAX && fragment.length < 4) {
      const next = new Set([...FRAGMENT_ALPHABET, ...[...found.values()].flatMap((book) => [...book.label.toLowerCase()])]);
      for (const character of next) if (character.trim() !== '' && character !== '"') queue.push(fragment + character);
    }
    // Names in other scripts: a character of a found name not yet tried.
    if (queue.length === 0 && found.size < all.total) {
      for (const book of found.values()) {
        for (const character of book.label.toLowerCase()) {
          if (character.trim() !== '' && character !== '"' && !tried.has(character)) queue.push(character);
        }
      }
    }
  }
  if (found.size < all.total) throw new EvernoteListingIncomplete();
  return [...found.values()];
}

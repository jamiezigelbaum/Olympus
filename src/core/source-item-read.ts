import { OperationError } from './operation-error.ts';
/** Content-free failures shared by the worker, client and remote release boundary. */
export const SOURCE_ITEM_READ_REFUSALS = [
  'held_until_judged', 'content_private', 'names_only', 'not_in_scope',
  'extraction_pending', 'window_judging', 'not_personal',
  // A names-only file the owner allows reading on request: queued or capped.
  'reading_on_demand', 'on_demand_capped',
] as const;
export type SourceItemReadRefusal = typeof SOURCE_ITEM_READ_REFUSALS[number];
export interface SourceItemReadResult {
  pages: Array<{ page: number; text: string }>;
  nextPage?: number;
  coverageNote?: string;
  totalPages: number;
  totalChars: number;
  couldNotRead: SourceItemReadRefusal[];
  /** With `reading_on_demand`: the reader's estimate until the text is indexed. */
  etaSeconds?: number;
}

/** Construct the exact payload; unknown worker fields never become a tool result. */
export function parseSourceItemReadResult(value: unknown): SourceItemReadResult {
  const fail = (): never => { throw new OperationError('source_index_error', 'Invalid source item read result.'); };
  if (!value || typeof value !== 'object') return fail();
  const r = value as Record<string, unknown>;
  const integer = (n: unknown, min: number): number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min ? n : fail();
  if (!Array.isArray(r.pages) || r.pages.length > 3 || !Array.isArray(r.couldNotRead)) return fail();
  const pages = r.pages.map((p: unknown) => {
    if (!p || typeof p !== 'object') return fail();
    const entry = p as Record<string, unknown>;
    if (typeof entry.text !== 'string' || entry.text.length > 12000) return fail();
    return { page: integer(entry.page, 1), text: entry.text };
  });
  const couldNotRead = r.couldNotRead.map((code: unknown) => typeof code === 'string' && SOURCE_ITEM_READ_REFUSALS.includes(code as SourceItemReadRefusal) ? code as SourceItemReadRefusal : fail());
  if (couldNotRead.some(code => code !== 'window_judging') && pages.length > 0) return fail();
  if (r.coverageNote !== undefined && typeof r.coverageNote !== 'string') return fail();
  return { pages, totalPages: integer(r.totalPages, 0), totalChars: integer(r.totalChars, 0), couldNotRead,
    ...(r.coverageNote === undefined ? {} : { coverageNote: r.coverageNote as string }),
    ...(r.nextPage === undefined ? {} : { nextPage: integer(r.nextPage, 1) }),
    ...(r.etaSeconds === undefined ? {} : { etaSeconds: integer(r.etaSeconds, 0) }) };
}

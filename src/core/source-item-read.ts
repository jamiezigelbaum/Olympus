import { OperationError } from './operation-error.ts';
/** Content-free failures shared by the worker, client and remote release boundary. */
export const SOURCE_ITEM_READ_REFUSALS = [
  'held_until_judged', 'content_private', 'names_only', 'not_in_scope',
  'extraction_pending', 'window_judging', 'not_personal',
] as const;
export type SourceItemReadRefusal = typeof SOURCE_ITEM_READ_REFUSALS[number];
export interface SourceItemReadResult {
  pages: Array<{ page: number; text: string }>;
  nextPage?: number;
  totalPages: number;
  totalChars: number;
  couldNotRead: SourceItemReadRefusal[];
}

/** Contiguous slices: retain whitespace, prefer a sentence boundary, never exceed the cap. */
export function itemTextPages(text: string, cap: number): string[] {
  const result: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + cap, text.length);
    if (end < text.length) {
      const slice = text.slice(start, end);
      const boundaries = slice.matchAll(/[.!?。！？](?:["'”’»)\]]*)(?:\s+|$)/gu);
      let boundary = 0;
      for (const match of boundaries) boundary = match.index! + match[0].length;
      if (boundary > 0) end = start + boundary;
    }
    result.push(text.slice(start, end)); start = end;
  }
  return result;
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
  if (couldNotRead.length > 0 && pages.length > 0) return fail();
  return { pages, totalPages: integer(r.totalPages, 0), totalChars: integer(r.totalChars, 0), couldNotRead,
    ...(r.nextPage === undefined ? {} : { nextPage: integer(r.nextPage, 1) }) };
}

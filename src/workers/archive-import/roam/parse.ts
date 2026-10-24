/**
 * One page of a Roam JSON export ("Export All"), as a pure function of its
 * parsed record.
 *
 * A page is `{title, uid?, create-time?, edit-time?, children: [block...]}`
 * and a block is `{string, uid?, create-time?, edit-time?, children: [block...]}`
 * (times in milliseconds; the keys are from Roam's community-documented export,
 * which Roam does not publish). The page becomes one note: its blocks in order,
 * one `- ` bullet per block, nested blocks indented two spaces per level, block
 * text kept as written (`[[links]]`, `{{todo}}`, `**bold**` stay). A page whose
 * blocks are all empty text (or that has none) is an empty note; a block that
 * is not a record, or has no text of the kind Olympus reads, is not read and
 * the page says so (`unsupported`) rather than passing for empty.
 *
 * Dates: the page's created time is the earliest created time of the page and
 * its blocks, its updated time the latest edited time; a page with neither is
 * dated by its title when it is a daily page ("October 24th, 2026").
 */
import {
  earliestIso,
  firstString,
  idText,
  isRecord,
  isoTime,
  latestIso,
  type NoteOutcome,
} from '../notes/note.ts';

/** How deep blocks are followed; the JSON reader refuses documents nested deeper than this anyway. */
const MAX_BLOCK_DEPTH = 256;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAILY_PAGE_TITLE = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th),?\s+(\d{4})$/;

/** The day of a Roam daily page's title ("October 24th, 2026"), as midday UTC, or undefined for any other title. */
export function roamDailyPageDate(title: string): string | undefined {
  const match = DAILY_PAGE_TITLE.exec(title.trim());
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1]!.toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 0 || day < 1 || day > 31) return undefined;
  const at = new Date(Date.UTC(year, month, day, 12));
  return at.getUTCMonth() === month && at.getUTCDate() === day ? at.toISOString() : undefined;
}

interface Flattened {
  lines: string[];
  blockCount: number;
  created: string | undefined;
  edited: string | undefined;
  hasText: boolean;
  /** Parts that could not be read: a block that is not a record, has no text field, or lies too deep, and a `children` that is no list. */
  unsupported: number;
}

/**
 * Depth-first, in order: a block whose text is empty adds no line, but its
 * children keep their indent. Absent children are a page or block with none;
 * children that are not a list, and a block that is not a record or has no
 * text field (and no children to hold any), are content that is not read.
 */
function flattenBlocks(children: unknown): Flattened {
  const out: Flattened = { lines: [], blockCount: 0, created: undefined, edited: undefined, hasText: false, unsupported: 0 };
  const walk = (nodes: unknown, depth: number): void => {
    if (nodes === undefined || nodes === null) return;
    if (!Array.isArray(nodes) || depth > MAX_BLOCK_DEPTH) {
      out.unsupported += 1;
      return;
    }
    for (const node of nodes) {
      if (!isRecord(node)) {
        out.unsupported += 1;
        continue;
      }
      out.blockCount += 1;
      if (typeof node.string !== 'string' && !Array.isArray(node.children)) out.unsupported += 1;
      const text = typeof node.string === 'string' ? node.string.trimEnd() : '';
      if (text.trim() !== '') {
        out.lines.push(`${'  '.repeat(depth)}- ${text}`);
        out.hasText = true;
      }
      out.created = earliestIso(out.created, isoTime(node['create-time']));
      out.edited = latestIso(out.edited, isoTime(node['edit-time']));
      walk(node.children, depth + 1);
    }
  };
  walk(children, 0);
  return out;
}

/** One record of a Roam JSON export as a note, an empty page, or no page at all. */
export function parseRoamPage(record: unknown): NoteOutcome {
  if (!isRecord(record)) return { kind: 'unreadable' };
  const flat = flattenBlocks(record.children);
  if (!flat.hasText) return flat.unsupported > 0 ? { kind: 'unsupported' } : { kind: 'empty' };
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const key = idText(record.uid);
  const createdAt = earliestIso(isoTime(record['create-time']), flat.created);
  const updatedAt = latestIso(isoTime(record['edit-time']), flat.edited);
  const titleDate = roamDailyPageDate(title);
  return {
    kind: 'note',
    note: {
      ...(key !== undefined ? { key } : {}),
      title: firstString(title) ?? '',
      body: flat.lines.join('\n'),
      tags: [],
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(titleDate !== undefined ? { titleDate } : {}),
      blockCount: flat.blockCount,
      ...(flat.unsupported > 0 ? { unsupported: flat.unsupported } : {}),
    },
  };
}

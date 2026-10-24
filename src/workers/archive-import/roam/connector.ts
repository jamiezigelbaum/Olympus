/**
 * The Roam archive connector: one note per page, from Roam's JSON export
 * ("Export All" as JSON: a .json file, or a zip holding it). The reading,
 * paging and resume are the notes engine's (`notes/archive.ts`); this file says
 * where Roam keeps its pages (a top-level list) and how one becomes a note
 * (`parse.ts`).
 *
 * - Pages with no text in any block are skipped and counted, never imported;
 *   a page with blocks Olympus cannot read is reported (`note_content_unsupported`).
 * - Two pages with the same uid or title are two notes: identity includes the
 *   page's place in the list.
 * - Roam's Markdown and EDN exports are not read; they are not detected, and
 *   choosing one says what Olympus does import.
 * - No prior is published: each note gets its tier from the privacy settings and
 *   the judge, and is held Private until judged.
 */
import {
  acceptsRoamJson,
  registerArchiveFormatConnector,
  type ArchiveConnectorInput,
} from '../../../core/archive-formats.ts';
import type { SourceConnector } from '../../../core/contracts.ts';
import { createNoteArchiveConnector, type NoteArchiveSpec } from '../notes/archive.ts';
import { parseRoamPage } from './parse.ts';

export const ROAM_CURSOR_PREFIX = 'roam1:';

const ROAM_SPEC: NoteArchiveSpec = {
  cursorPrefix: ROAM_CURSOR_PREFIX,
  source: {
    kind: 'json',
    // Only a list of pages is a Roam export; any other document is reported, not guessed at.
    itemPaths: (root) => (root === 'array' ? [[]] : undefined),
    accepts: acceptsRoamJson,
    parse: parseRoamPage,
  },
};

export function createRoamArchiveConnector(input: ArchiveConnectorInput): SourceConnector {
  return createNoteArchiveConnector(input, ROAM_SPEC);
}

/** Registers the Roam connector with the format registry. Idempotent. */
export function registerRoamArchiveConnector(): void {
  registerArchiveFormatConnector('roam-json', createRoamArchiveConnector);
}

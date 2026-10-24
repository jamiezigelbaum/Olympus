/**
 * The Reflect archive connectors: one note per item, from Reflect's JSON
 * export (a .json file or a zip holding it) or its Markdown export (a zip with
 * one .md file per note). The reading, paging and resume are the notes
 * engine's (`notes/archive.ts`); this file says where Reflect keeps its notes
 * and how one record becomes a note (`parse.ts`, `markdown.ts`).
 *
 * - JSON: a top-level list of notes, or an object whose `notes` is that list.
 * - Markdown: every .md member of the zip; a daily note takes its date from its
 *   file name when the file gives none.
 * - Other Reflect exports (CSV, HTML) are not read; they are not detected, and
 *   choosing one says what Olympus does import.
 * - No prior is published: each note gets its tier from the privacy settings and
 *   the judge, and is held Private until judged.
 */
import {
  looksLikeReflectJson,
  registerArchiveFormatConnector,
  type ArchiveConnectorInput,
} from '../../../core/archive-formats.ts';
import type { SourceConnector } from '../../../core/contracts.ts';
import { createNoteArchiveConnector, type NoteArchiveSpec } from '../notes/archive.ts';
import { parseReflectMarkdown } from './markdown.ts';
import { parseReflectNote } from './parse.ts';

export const REFLECT_JSON_CURSOR_PREFIX = 'reflect1:';
export const REFLECT_MARKDOWN_CURSOR_PREFIX = 'reflectmd1:';

const REFLECT_JSON_SPEC: NoteArchiveSpec = {
  cursorPrefix: REFLECT_JSON_CURSOR_PREFIX,
  source: {
    kind: 'json',
    itemPaths: (root) => (root === 'array' ? [[]] : [['notes']]),
    accepts: looksLikeReflectJson,
    parse: parseReflectNote,
  },
};

const REFLECT_MARKDOWN_SPEC: NoteArchiveSpec = {
  cursorPrefix: REFLECT_MARKDOWN_CURSOR_PREFIX,
  source: {
    kind: 'markdown',
    isNote: (name) => /\.(?:md|markdown)$/i.test(name),
    parse: parseReflectMarkdown,
  },
};

export function createReflectJsonArchiveConnector(input: ArchiveConnectorInput): SourceConnector {
  return createNoteArchiveConnector(input, REFLECT_JSON_SPEC);
}

export function createReflectMarkdownArchiveConnector(input: ArchiveConnectorInput): SourceConnector {
  return createNoteArchiveConnector(input, REFLECT_MARKDOWN_SPEC);
}

/** Registers the Reflect connectors with the format registry. Idempotent. */
export function registerReflectArchiveConnectors(): void {
  registerArchiveFormatConnector('reflect-json', createReflectJsonArchiveConnector);
  registerArchiveFormatConnector('reflect-markdown', createReflectMarkdownArchiveConnector);
}

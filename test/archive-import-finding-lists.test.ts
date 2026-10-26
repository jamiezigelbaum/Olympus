/**
 * Every kind of finding an archive import reports is shown in exactly one of
 * the dashboard's two lists, "Not imported" or "How it was read", and the
 * table that says which (`DASHBOARD_ARCHIVE_COPY.listOf`, beside the
 * sentences) names every kind. A kind a format starts reporting without a
 * line in the table fails here, not on somebody's dashboard.
 */
import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'node:path';
import { DASHBOARD_ARCHIVE_COPY, archiveFindingList } from '../src/workers/dashboard/vocabulary.ts';

const ROOT = join(import.meta.dir, '..');

/** Every `*_FINDINGS` object any archive-import module exports, by module. */
async function reportedKinds(): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const sources = [
    join(ROOT, 'src/core/archive-formats.ts'),
    ...Array.from(new Glob('src/workers/archive-import/**/*.ts').scanSync({ cwd: ROOT })).map((file) => join(ROOT, file)),
  ];
  for (const file of sources.sort()) {
    const exported = (await import(file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(exported)) {
      if (!/_FINDINGS$/.test(name) || !value || typeof value !== 'object') continue;
      found.set(`${file.slice(ROOT.length + 1)}:${name}`, Object.values(value as Record<string, unknown>).filter((kind): kind is string => typeof kind === 'string'));
    }
  }
  return found;
}

describe('the two lists under an archive', () => {
  test('every kind any format reports is in the table, in one of the two lists, with a sentence of its own', async () => {
    const reported = await reportedKinds();
    // The formats this build ships report their kinds this way: if the search found fewer, it is looking in the wrong place.
    const owners = Array.from(reported.keys()).map((key) => key.split(':')[1]);
    for (const name of ['ARCHIVE_COMMON_FINDINGS', 'MBOX_FINDINGS', 'WHATSAPP_FINDINGS', 'TELEGRAM_FINDINGS', 'NOTE_FINDINGS']) expect(owners, name).toContain(name);
    const table = DASHBOARD_ARCHIVE_COPY.listOf as Record<string, string>;
    const sentences = DASHBOARD_ARCHIVE_COPY.gaps as Record<string, { one: string; many: string }>;
    for (const [owner, kinds] of reported) {
      expect(kinds.length, owner).toBeGreaterThan(0);
      for (const kind of kinds) {
        expect(Object.prototype.hasOwnProperty.call(table, kind), `${owner} reports "${kind}", which no list names`).toBe(true);
        expect(['not_imported', 'how_read'], `${owner}: ${kind}`).toContain(table[kind] as string);
        expect(sentences[kind], `${owner} reports "${kind}", which has no sentence`).toBeDefined();
        expect<string>(archiveFindingList(kind)).toBe(table[kind] as string);
      }
    }
  });

  test('the table names no kind that has no sentence, and every sentence has a list', () => {
    const table = Object.keys(DASHBOARD_ARCHIVE_COPY.listOf);
    const sentences = Object.keys(DASHBOARD_ARCHIVE_COPY.gaps);
    expect(table.filter((kind) => !sentences.includes(kind))).toEqual([]);
    expect(sentences.filter((kind) => !table.includes(kind))).toEqual([]);
  });

  test('what was taken as given or left out on purpose is how it was read; what Olympus does not have is not imported', () => {
    const howRead = [
      'time_zone_assumed', 'date_order_assumed', 'item_start_assumed', 'zip_overlap_unchecked', 'assumption',
      'item_repeated', 'system_message', 'message_empty', 'message_without_text', 'note_empty', 'note_date_assumed',
      'match_near_miss',
    ];
    const notImported = [
      'media_not_imported', 'section_not_imported', 'file_damaged', 'files_not_looked_at', 'files_unconfirmed',
      'message_too_large', 'message_unreadable', 'message_content_unsupported', 'charset_not_decoded', 'attachments_not_read',
      'spam_or_trash', 'note_unreadable', 'note_too_large', 'note_content_unsupported',
      // Kinds only an older record carries are still Not imported: nothing disappears.
      'item_truncated', 'text_cut', 'service_message', 'status_updates',
    ];
    for (const kind of howRead) expect(archiveFindingList(kind), kind).toBe('how_read');
    for (const kind of notImported) expect(archiveFindingList(kind), kind).toBe('not_imported');
    expect(new Set([...howRead, ...notImported]).size).toBe(Object.keys(DASHBOARD_ARCHIVE_COPY.listOf).length - 1);
  });

  test('a kind nobody has heard of, or a name that is not a kind, is Not imported, never hidden', () => {
    for (const kind of ['something_new', 'constructor', '__proto__', 'toString', '']) expect(archiveFindingList(kind), kind).toBe('not_imported');
  });
});

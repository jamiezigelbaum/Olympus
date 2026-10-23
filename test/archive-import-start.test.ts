// Starting an archive import: which format a chosen path is, read from names
// and first bytes only, and nothing written for a path that is not one
// supported archive or is one already imported. Synthetic files only.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MBOX_ARCHIVE_FORMAT,
  detectArchiveFormat,
  type ArchiveFormatDefinition,
} from '../src/core/archive-formats.ts';
import { requestArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { startArchiveImport } from '../src/workers/archive-import/start.ts';
import { ArchiveImportStateStore } from '../src/workers/archive-import/state.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const MBOX_TEXT = [
  'From sender@example.invalid Mon Jan  5 10:00:00 2015',
  'From: Sam Example <sam@example.invalid>',
  'Subject: Synthetic harbour note',
  'Message-ID: <one@example.invalid>',
  '',
  'The synthetic harbour opens at dawn.',
  '',
].join('\n');

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-start-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const state = new ArchiveImportStateStore({ path: join(base, 'data', 'archive-imports.json') });
  const exports = join(base, 'exports');
  mkdirSync(exports);
  return { base, exports, state };
}

describe('archive format detection', () => {
  test('a Google Takeout .mbox file is mail, read from its folder', () => {
    const f = fixture();
    const path = join(f.exports, 'All mail Including Spam and Trash.mbox');
    writeFileSync(path, MBOX_TEXT);
    const started = startArchiveImport({ state: f.state, path });
    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    expect(started.archive).toMatchObject({
      format: 'mbox',
      provider: 'mbox',
      family: 'email',
      status: 'importing',
      root_path: f.exports,
      chosen_rel_path: 'All mail Including Spam and Trash.mbox',
      label: 'All mail Including Spam and Trash.mbox',
    });
    expect(started.archive.files.map((file) => file.rel_path)).toEqual(['All mail Including Spam and Trash.mbox']);
    expect(f.state.list()).toHaveLength(1);
  });

  test('an Apple Mail export folder is read through the mbox file inside it', () => {
    const f = fixture();
    const folder = join(f.exports, 'Synthetic Inbox.mbox');
    mkdirSync(folder);
    writeFileSync(join(folder, 'Info.plist'), '<?xml version="1.0"?><plist></plist>');
    writeFileSync(join(folder, 'table_of_contents'), 'not mail');
    writeFileSync(join(folder, 'mbox'), MBOX_TEXT);
    const started = startArchiveImport({ state: f.state, path: folder });
    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    expect(started.archive.root_path).toBe(folder);
    expect(started.archive.chosen_rel_path).toBe('');
    expect(started.archive.label).toBe('Synthetic Inbox.mbox');
    expect(started.archive.files.map((file) => file.rel_path)).toEqual(['mbox']);
  });

  test('a Thunderbird mail file has no extension and is still mail', () => {
    const f = fixture();
    const path = join(f.exports, 'Inbox');
    writeFileSync(path, MBOX_TEXT);
    const started = startArchiveImport({ state: f.state, path });
    expect(started.kind).toBe('started');
    if (started.kind === 'started') expect(started.archive.format).toBe('mbox');
  });

  test('a path that is no supported archive says what is supported and writes nothing', () => {
    const f = fixture();
    const notes = join(f.exports, 'notes.mbox');
    writeFileSync(notes, 'Just some synthetic notes, not mail.');
    expect(startArchiveImport({ state: f.state, path: notes })).toEqual({ kind: 'unsupported', supported: ['Mail (mbox)'] });
    // A folder that is not an export folder, even with mail inside.
    const folder = join(f.exports, 'Mail');
    mkdirSync(folder);
    writeFileSync(join(folder, 'mbox'), MBOX_TEXT);
    expect(startArchiveImport({ state: f.state, path: folder }).kind).toBe('unsupported');
    // An export folder without its mbox file.
    const empty = join(f.exports, 'Empty.mbox');
    mkdirSync(empty);
    expect(startArchiveImport({ state: f.state, path: empty }).kind).toBe('unsupported');
    expect(existsSync(f.state.path)).toBe(false);
  });

  test('two formats matching one path are returned to choose from, never guessed', () => {
    const f = fixture();
    const path = join(f.exports, 'Inbox.mbox');
    writeFileSync(path, MBOX_TEXT);
    const twin: ArchiveFormatDefinition = { ...MBOX_ARCHIVE_FORMAT, id: 'mbox-twin', label: 'Synthetic twin' };
    expect(startArchiveImport({ state: f.state, path, formats: [MBOX_ARCHIVE_FORMAT, twin] }))
      .toEqual({ kind: 'ambiguous', formats: ['mbox', 'mbox-twin'] });
    expect(existsSync(f.state.path)).toBe(false);
  });

  test('a format whose probe throws is not a match', () => {
    const throwing: ArchiveFormatDefinition = {
      ...MBOX_ARCHIVE_FORMAT,
      id: 'broken',
      detect() { throw new Error('synthetic probe failure'); },
    };
    const probe = { chosen: { relPath: '', name: 'x', kind: 'file' as const, head: new TextEncoder().encode('From x') }, children: [] };
    const detection = detectArchiveFormat(probe, [throwing, MBOX_ARCHIVE_FORMAT]);
    expect(detection.kind).toBe('match');
  });

  test('a relative, missing or linked path is refused', () => {
    const f = fixture();
    expect(startArchiveImport({ state: f.state, path: 'exports/Inbox' })).toEqual({ kind: 'unreadable', code: 'escape' });
    expect(startArchiveImport({ state: f.state, path: join(f.exports, 'missing.mbox') })).toEqual({ kind: 'unreadable', code: 'not_found' });
    expect(existsSync(f.state.path)).toBe(false);
  });
});

describe('already imported', () => {
  test('the same file, or a copy of the same export, is the archive already there', () => {
    const f = fixture();
    const path = join(f.exports, 'Inbox.mbox');
    writeFileSync(path, MBOX_TEXT);
    const first = startArchiveImport({ state: f.state, path });
    expect(first.kind).toBe('started');
    if (first.kind !== 'started') return;

    const again = startArchiveImport({ state: f.state, path });
    expect(again.kind).toBe('already_imported');
    if (again.kind === 'already_imported') expect(again.archive.archive_id).toBe(first.archive.archive_id);

    // What a completed import records: each file's SHA-256.
    f.state.update(first.archive.archive_id, (record) => {
      record.status = 'imported';
      record.files[0]!.sha256 = createHash('sha256').update(MBOX_TEXT).digest('hex');
    });
    mkdirSync(join(f.base, 'elsewhere'));
    const copy = join(f.base, 'elsewhere', 'Inbox copy.mbox');
    copyFileSync(path, copy);
    const copied = startArchiveImport({ state: f.state, path: copy });
    expect(copied.kind).toBe('already_imported');
    expect(f.state.list()).toHaveLength(1);

    // A different export is a new archive.
    const other = join(f.exports, 'Other.mbox');
    writeFileSync(other, MBOX_TEXT.replace('dawn', 'dusk'));
    expect(startArchiveImport({ state: f.state, path: other }).kind).toBe('started');
    expect(f.state.list()).toHaveLength(2);
  });

  test('an archive being removed does not count as imported', () => {
    const f = fixture();
    const path = join(f.exports, 'Inbox.mbox');
    writeFileSync(path, MBOX_TEXT);
    const first = startArchiveImport({ state: f.state, path });
    if (first.kind !== 'started') throw new Error('expected a start');
    requestArchiveRemoval(f.state, first.archive.archive_id);
    const again = startArchiveImport({ state: f.state, path });
    expect(again.kind).toBe('started');
    if (again.kind === 'started') expect(again.archive.archive_id).not.toBe(first.archive.archive_id);
  });
});

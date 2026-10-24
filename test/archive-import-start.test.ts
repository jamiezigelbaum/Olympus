// Starting an archive import: which format a chosen path is, read from names
// and first bytes only, and nothing written for a path that is not one
// supported archive or is one already imported. Synthetic files only.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCHIVE_FORMATS,
  ARCHIVE_LOOK_INCOMPLETE_ADVICE,
  ARCHIVE_PROBE_MAX_CHILDREN,
  MBOX_ARCHIVE_FORMAT,
  detectArchiveFormat,
  type ArchiveFormatDefinition,
} from '../src/core/archive-formats.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { probeArchivePath } from '../src/workers/archive-import/manifest.ts';
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
    expect(startArchiveImport({ state: f.state, path: notes })).toEqual({ kind: 'unsupported', supported: ARCHIVE_FORMATS.map((format) => format.label) });
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

/** A format of some other kind that tells its export from the first bytes alone and asks for no name: nothing in its definition says where to look. */
const CONTENT_ONLY: ArchiveFormatDefinition = {
  ...MBOX_ARCHIVE_FORMAT,
  id: 'synthetic-content-only',
  label: 'Synthetic content-only export',
  family: 'note',
  detect(probe) {
    const found = probe.children.filter((entry) => entry.kind === 'file' && new TextDecoder().decode(entry.head).startsWith('{"synthetic-export"')).map((entry) => entry.relPath);
    return found.length > 0 ? found : undefined;
  },
};

/** Runs `body` with every folder listed in name order, as some systems list it, so where a name falls in the listing does not depend on the machine. */
function listedByName<T>(body: () => T): T {
  const original = ScopeRoot.prototype.list;
  ScopeRoot.prototype.list = function (this: ScopeRoot, relDir: string) {
    return original.call(this, relDir).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };
  try {
    return body();
  } finally {
    ScopeRoot.prototype.list = original;
  }
}

describe('a folder the first look does not reach every file of', () => {
  const ordinary = (dir: string, count: number) => { for (let index = 0; index < count; index += 1) writeFileSync(join(dir, `a-note-${String(index).padStart(4, '0')}.dat`), 'plain'); };

  test('an export of any format that nobody asks for by name, past the first files read, is not silently lost: the refusal says the look was not complete', () => {
    const f = fixture();
    const dir = join(f.exports, 'Many files');
    mkdirSync(dir);
    ordinary(dir, 40);
    writeFileSync(join(dir, 'z-export.dat'), '{"synthetic-export":1}');
    const refused = listedByName(() => startArchiveImport({ state: f.state, path: dir, formats: [CONTENT_ONLY] }));
    expect(refused.kind).toBe('unsupported');
    if (refused.kind === 'unsupported') expect(refused.advice).toContain(ARCHIVE_LOOK_INCOMPLETE_ADVICE);
    expect(existsSync(f.state.path)).toBe(false);
  });

  test('the same export among the files read is found, and a folder whose every file was read says nothing of the kind', () => {
    const f = fixture();
    const dir = join(f.exports, 'Few files');
    mkdirSync(dir);
    ordinary(dir, 10);
    writeFileSync(join(dir, 'z-export.dat'), '{"synthetic-export":1}');
    const started = listedByName(() => startArchiveImport({ state: f.state, path: dir, formats: [CONTENT_ONLY] }));
    expect(started.kind).toBe('started');
    if (started.kind === 'started') expect(started.archive.findings.skipped).toEqual({});
    const empty = join(f.exports, 'Plain');
    mkdirSync(empty);
    ordinary(empty, 3);
    const refused = listedByName(() => startArchiveImport({ state: f.state, path: empty, formats: [CONTENT_ONLY] }));
    expect(refused.kind).toBe('unsupported');
    if (refused.kind === 'unsupported') expect(refused.advice ?? '').not.toContain(ARCHIVE_LOOK_INCOMPLETE_ADVICE);
  });

  test('the probe counts the files it did not reach: past the few it reads, past the bound, and not those asked for by name', () => {
    const f = fixture();
    const dir = join(f.exports, 'Hundreds');
    mkdirSync(dir);
    const total = ARCHIVE_PROBE_MAX_CHILDREN + 20;
    ordinary(dir, total);
    const root = ScopeRoot.open(dir);
    cleanups.push(() => root.close());
    const probe = listedByName(() => probeArchivePath(root, '', { probeNames: [] }));
    expect(probe.children.filter((child) => child.head)).toHaveLength(32);
    expect(probe.othersNotLookedAt).toBe(total - 32);
    // A name a format asks for is read ahead of the rest, and is not counted.
    writeFileSync(join(dir, 'zz-asked.json'), '{"asked":1}');
    const asked = listedByName(() => probeArchivePath(root, '', { probeNames: ['zz-asked.json'] }));
    expect(asked.children.find((child) => child.name === 'zz-asked.json')?.head).toBeDefined();
    expect(asked.othersNotLookedAt).toBe(total - 31);
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

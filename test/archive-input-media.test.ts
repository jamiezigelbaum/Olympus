// Media of an archive that is an input of a source: read later by the locator
// its child carries (archive-import/input-media.ts), only while the import is
// served. Synthetic files only.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileExtractionSourceError } from '../src/core/file-extraction-source.ts';
import {
  archiveInputMediaLocator,
  archiveInputZipMediaLocator,
  parseArchiveInputMedia,
  parseArchiveInputMediaLocator,
  readArchiveInputMedia,
} from '../src/workers/archive-import/input-media.ts';
import type { ArchiveImportRecord, ArchiveImportStateStore } from '../src/workers/archive-import/state.ts';
import { ZipArchive } from '../src/workers/archive-import/zip-reader.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { buildZip } from './helpers/zip-fixture.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function exportZip() {
  const root = mkdtempSync(join(tmpdir(), 'archive-input-media-'));
  roots.push(root);
  const zip = buildZip([
    { name: '_chat.txt', data: '[01/07/2026, 09:00:00] Rowan: hello\n', method: 'deflate' },
    { name: 'IMG-20260701-WA0001.jpg', data: 'synthetic jpeg bytes', method: 'stored' },
    { name: 'PTT-20260701-WA0002.opus', data: 'synthetic voice bytes '.repeat(50), method: 'deflate' },
  ]);
  writeFileSync(join(root, 'WhatsApp Chat - Rowan.zip'), zip);
  const stat = statSync(join(root, 'WhatsApp Chat - Rowan.zip'), { bigint: false });
  const scope = ScopeRoot.open(root);
  const reader = scope.openFile('WhatsApp Chat - Rowan.zip');
  const table = ZipArchive.open(reader).memberTable();
  reader.close();
  scope.close();
  const fileStat = ScopeRoot.open(root);
  const version = fileStat.statRelative('WhatsApp Chat - Rowan.zip');
  fileStat.close();
  const record = {
    archive_id: 'arch-1',
    status: 'importing',
    root_path: root,
    chosen_rel_path: 'WhatsApp Chat - Rowan.zip',
    target: { source_id: 'whatsapp.personal.messages', slot: 'default' },
    files: [{
      rel_path: 'WhatsApp Chat - Rowan.zip',
      dev: version.dev,
      ino: version.ino,
      size: stat.size,
      mtime_ms: version.mtimeMs,
      fingerprint: { head_sha256: '', tail_sha256: '' },
      members: table,
    }],
  } as unknown as ArchiveImportRecord;
  const state = { get: (id: string) => (id === record.archive_id ? record : undefined) } as unknown as ArchiveImportStateStore;
  return { root, record, state };
}

describe('archive input media locators', () => {
  test('locators round-trip and name no path', () => {
    const binding = archiveInputMediaLocator({ archiveId: 'arch-1', bindingId: 'mb-0123' });
    expect(parseArchiveInputMediaLocator(binding)).toEqual({ archiveId: 'arch-1', bindingId: 'mb-0123' });
    const zip = archiveInputZipMediaLocator({ archiveId: 'arch-1', fileIndex: 0, memberIndex: 2 });
    expect(parseArchiveInputMedia(zip)).toEqual({ kind: 'zip', archiveId: 'arch-1', fileIndex: 0, memberIndex: 2 });
    expect(parseArchiveInputMediaLocator(zip)).toBeUndefined();
    expect(parseArchiveInputMedia('archive-input-media:v1:arch-1:b:../../etc')).toBeUndefined();
    expect(zip).not.toContain('IMG');
  });

  test('a zip member is read whole, checked, while the import is served', () => {
    const { state, record } = exportZip();
    const photo = archiveInputZipMediaLocator({ archiveId: 'arch-1', fileIndex: 0, memberIndex: 1 });
    expect(Buffer.from(readArchiveInputMedia(photo, { state })).toString()).toBe('synthetic jpeg bytes');
    const voice = archiveInputZipMediaLocator({ archiveId: 'arch-1', fileIndex: 0, memberIndex: 2 });
    expect(Buffer.from(readArchiveInputMedia(voice, { state })).toString()).toBe('synthetic voice bytes '.repeat(50));
    expect(() => readArchiveInputMedia(voice, { state }, { maxBytes: 10 })).toThrow(FileExtractionSourceError);
    // Being removed: nothing is served.
    (record as { status: string }).status = 'removing';
    try {
      readArchiveInputMedia(photo, { state });
      throw new Error('served while removing');
    } catch (error) {
      expect((error as FileExtractionSourceError).errorKind).toBe('source_item_not_found');
    }
  });

  test('an import under Archives (no source target) is not served here', () => {
    const { state, record } = exportZip();
    delete (record as { target?: unknown }).target;
    const photo = archiveInputZipMediaLocator({ archiveId: 'arch-1', fileIndex: 0, memberIndex: 1 });
    expect(() => readArchiveInputMedia(photo, { state })).toThrow(FileExtractionSourceError);
  });

  test('a zip that changed since the import began serves nothing', () => {
    const { state, root } = exportZip();
    writeFileSync(join(root, 'WhatsApp Chat - Rowan.zip'), buildZip([{ name: '_chat.txt', data: 'other', method: 'stored' }]));
    const photo = archiveInputZipMediaLocator({ archiveId: 'arch-1', fileIndex: 0, memberIndex: 1 });
    try {
      readArchiveInputMedia(photo, { state });
      throw new Error('served a changed file');
    } catch (error) {
      expect((error as FileExtractionSourceError).errorKind).toBe('source_version_gone');
    }
  });
});

// The probe and the manifest for archives whose telling file is far down a
// folder or a zip, and for zips whose members must not change under an import.
// Synthetic files only; every zip is built in code.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCHIVE_PROBE_MAX_CHILDREN,
  ARCHIVE_PROBE_MAX_NAMED,
  archiveProbeNameMatches,
  archiveProbeNames,
  detectArchiveFormat,
  type ArchiveFormatDefinition,
  type ArchiveProbe,
} from '../src/core/archive-formats.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import {
  archiveFileEntries,
  archiveManifestSha256,
  buildArchiveManifest,
  probeArchivePath,
  verifyArchiveManifest,
} from '../src/workers/archive-import/manifest.ts';
import { ArchiveImportRequestStore } from '../src/workers/archive-import/requests.ts';
import { startArchiveImport } from '../src/workers/archive-import/start.ts';
import { ArchiveImportStateStore } from '../src/workers/archive-import/state.ts';
import { buildZip, type ZipFixtureEntry } from './helpers/zip-fixture.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function folder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archive-probe-')));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function open(dir: string): ScopeRoot {
  const root = ScopeRoot.open(dir);
  cleanups.push(() => root.close());
  return root;
}

const decode = (bytes: Uint8Array | undefined): string | undefined => (bytes ? new TextDecoder().decode(bytes) : undefined);

describe('probe name patterns', () => {
  test('match whole names with wildcards, any case, and the last part of a member path', () => {
    expect(archiveProbeNameMatches('Result.JSON', ['result.json'])).toBe(true);
    expect(archiveProbeNameMatches('export/result.json', ['result.json'])).toBe(true);
    expect(archiveProbeNameMatches('export/result.json', ['export/*.json'])).toBe(true);
    expect(archiveProbeNameMatches('notes-2024.json', ['notes-*.json'])).toBe(true);
    expect(archiveProbeNameMatches('a1.txt', ['a?.txt'])).toBe(true);
    expect(archiveProbeNameMatches('a12.txt', ['a?.txt'])).toBe(false);
    expect(archiveProbeNameMatches('result.json.bak', ['result.json'])).toBe(false);
    expect(archiveProbeNameMatches('anything', ['*'])).toBe(true);
    expect(archiveProbeNameMatches('anything', [])).toBe(false);
    expect(archiveProbeNameMatches('anything', undefined)).toBe(false);
    expect(archiveProbeNames([
      { probeNames: ['a.json', 'b.json'] } as ArchiveFormatDefinition,
      { probeNames: ['b.json'] } as ArchiveFormatDefinition,
      {} as ArchiveFormatDefinition,
    ])).toEqual(['a.json', 'b.json']);
  });
});

describe('probing a folder', () => {
  test('lists a named file past the usual bound and reads its first bytes ahead of the others', () => {
    const dir = folder();
    const total = ARCHIVE_PROBE_MAX_CHILDREN + 300;
    for (let index = 0; index < total; index += 1) writeFileSync(join(dir, `entry-${String(index).padStart(4, '0')}.txt`), `body ${index}`);
    const root = open(dir);
    const order = root.list('').map((entry) => entry.name);
    // A name the listing puts well past the bound.
    const target = order[ARCHIVE_PROBE_MAX_CHILDREN + 150]!;
    const plain = probeArchivePath(root, '', { probeNames: [] });
    expect(plain.children.length).toBe(ARCHIVE_PROBE_MAX_CHILDREN);
    expect(plain.children.some((child) => child.name === target)).toBe(false);
    const probe = probeArchivePath(root, '', { probeNames: [target] });
    expect(probe.children.length).toBe(ARCHIVE_PROBE_MAX_CHILDREN + 1);
    const found = probe.children.find((child) => child.name === target);
    expect(found).toBeDefined();
    expect(decode(found!.head)).toBe(readFileSync(join(dir, target), 'utf8'));
    // Only 32 files get their first bytes read; the named one is among them though 256 came before it.
    expect(probe.children.filter((child) => child.head).length).toBe(32);
    // Names past the bound that nobody asked for are still not listed.
    expect(probe.children.filter((child) => child.name !== target && !order.slice(0, ARCHIVE_PROBE_MAX_CHILDREN).includes(child.name))).toEqual([]);
  });

  test('a pattern that matches thousands of names lists no more than the bound on them', () => {
    const dir = folder();
    const total = ARCHIVE_PROBE_MAX_CHILDREN + ARCHIVE_PROBE_MAX_NAMED + 200;
    for (let index = 0; index < total; index += 1) writeFileSync(join(dir, `part-${index}.dat`), 'x');
    const probe = probeArchivePath(open(dir), '', { probeNames: ['part-*.dat'] });
    expect(probe.children.length).toBe(ARCHIVE_PROBE_MAX_CHILDREN + ARCHIVE_PROBE_MAX_NAMED);
  });

  test('without name patterns the look is the one it always was', () => {
    const dir = folder();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'a.txt'), 'alpha');
    writeFileSync(join(dir, 'b.txt'), 'beta');
    const probe = probeArchivePath(open(dir), '', { probeNames: [] });
    expect(probe.chosen).toEqual({ relPath: '', name: probe.chosen.name, kind: 'directory' });
    expect(probe.children.map((child) => [child.name, child.kind, decode(child.head)]).sort())
      .toEqual([['a.txt', 'file', 'alpha'], ['b.txt', 'file', 'beta'], ['sub', 'directory', undefined]]);
  });
});

function zipWithDepth(depth: number, wanted: { name: string; data: string }, extra: ZipFixtureEntry[] = []): Uint8Array {
  const entries: ZipFixtureEntry[] = [];
  for (let index = 0; index < depth; index += 1) entries.push({ name: `media/item-${index}.bin`, data: `blob ${index}` });
  entries.push({ name: wanted.name, data: wanted.data, method: 'deflate' }, ...extra);
  return buildZip(entries);
}

describe('probing a zip', () => {
  test('lists the first members and a named member far down the directory, with its first bytes', () => {
    const dir = folder();
    writeFileSync(join(dir, 'export.zip'), zipWithDepth(900, { name: 'export/manifest.json', data: '{"kind":"synthetic"}' }));
    const probe = probeArchivePath(open(dir), 'export.zip', { probeNames: ['manifest.json'] });
    expect(probe.chosen.kind).toBe('file');
    const members = probe.chosen.members!;
    expect(members.length).toBe(ARCHIVE_PROBE_MAX_CHILDREN + 1);
    const named = members.find((member) => member.name === 'manifest.json');
    expect(named).toMatchObject({ relPath: 'export/manifest.json', kind: 'file' });
    expect(decode(named!.head)).toBe('{"kind":"synthetic"}');
    // Ordinary members get their first bytes too, within the same bound as files in a folder.
    expect(decode(members[0]!.head)).toBe('blob 0');
    expect(members.filter((member) => member.head).length).toBe(32);
  });

  test('a zip inside a folder is listed the same way, and a file that is not a zip has no members', () => {
    const dir = folder();
    writeFileSync(join(dir, 'export.zip'), zipWithDepth(400, { name: 'deep/info.json', data: '{"n":1}' }));
    writeFileSync(join(dir, 'plain.txt'), 'not a zip');
    writeFileSync(join(dir, 'broken.zip'), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]));
    const probe = probeArchivePath(open(dir), '', { probeNames: ['info.json'] });
    const zip = probe.children.find((child) => child.name === 'export.zip')!;
    expect(zip.members?.some((member) => member.name === 'info.json' && decode(member.head) === '{"n":1}')).toBe(true);
    expect(probe.children.find((child) => child.name === 'plain.txt')!.members).toBeUndefined();
    expect(probe.children.find((child) => child.name === 'broken.zip')!.members).toBeUndefined();
  });

  test('a format finds an export by a member far down a zip', () => {
    const format: ArchiveFormatDefinition = {
      id: 'synthetic-zip',
      label: 'Synthetic zip',
      family: 'note',
      provider: 'synthetic-zip',
      probeNames: ['marker.json'],
      detect(probe: ArchiveProbe) {
        const member = probe.chosen.members?.find((entry) => entry.name === 'marker.json');
        return member && decode(member.head)?.includes('"synthetic-export"') ? [''] : undefined;
      },
    };
    const dir = folder();
    writeFileSync(join(dir, 'a.zip'), zipWithDepth(700, { name: 'pack/marker.json', data: '{"type":"synthetic-export"}' }));
    writeFileSync(join(dir, 'b.zip'), zipWithDepth(700, { name: 'pack/marker.json', data: '{"type":"something-else"}' }));
    const state = new ArchiveImportStateStore({ path: join(dir, 'data', 'archive-imports.json') });
    const other = startArchiveImport({ state, path: join(dir, 'b.zip'), formats: [format] });
    expect(other.kind).toBe('unsupported');
    const started = startArchiveImport({ state, path: join(dir, 'a.zip'), formats: [format] });
    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    expect(started.archive.format).toBe('synthetic-zip');
    expect(started.archive.files[0]!.members?.count).toBe(701);
    // Without the format's name patterns the marker would not have been seen.
    const probe = probeArchivePath(open(dir), 'a.zip', { probeNames: [] });
    expect(detectArchiveFormat(probe, [format]).kind).toBe('none');
  });
});

describe('manifest with zip member tables', () => {
  test('a zip records its member table; other files record nothing extra and keep their old digest', () => {
    const dir = folder();
    writeFileSync(join(dir, 'a.zip'), zipWithDepth(3, { name: 'x/info.json', data: '{}' }));
    writeFileSync(join(dir, 'plain.txt'), 'not a zip at all');
    const root = open(dir);
    const [zip, plain] = buildArchiveManifest(root, ['a.zip', 'plain.txt']);
    expect(zip!.members?.count).toBe(4);
    expect(zip!.members?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plain!.members).toBeUndefined();
    // The digest of non-zip files is the one made before zips were recorded.
    const before = createHash('sha256')
      .update(JSON.stringify([[plain!.rel_path, plain!.dev, plain!.ino, plain!.size, plain!.mtime_ms]]))
      .digest('hex');
    expect(archiveManifestSha256([plain!])).toBe(before);
    expect(archiveManifestSha256([zip!])).not.toBe(archiveManifestSha256([{ ...zip!, members: undefined } as never]));
    expect(archiveFileEntries([zip!, plain!]).map((entry) => entry.members)).toEqual([{ count: 4, sha256: zip!.members!.sha256 }, undefined]);
  });

  test('a member that changed under a zip with the same name, size, inode and time stops the import', () => {
    const dir = folder();
    const path = join(dir, 'a.zip');
    const one = buildZip([{ name: 'notes.txt', data: 'first content!' }, { name: 'more.txt', data: 'same' }]);
    writeFileSync(path, one);
    const root = open(dir);
    const before = buildArchiveManifest(root, ['a.zip']);
    const mtime = new Date(before[0]!.mtime_ms);
    expect(verifyArchiveManifest(root, before)).toEqual({ ok: true });
    // The same length, a different member, written over the file and given back its time.
    const two = buildZip([{ name: 'notes.txt', data: 'other content!' }, { name: 'more.txt', data: 'same' }]);
    expect(two.length).toBe(one.length);
    writeFileSync(path, two);
    utimesSync(path, mtime, mtime);
    const check = verifyArchiveManifest(open(dir), before);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check).toMatchObject({ code: 'file_changed', relPath: 'a.zip' });
    const after = buildArchiveManifest(open(dir), ['a.zip']);
    expect(after[0]!.size).toBe(before[0]!.size);
    expect(archiveManifestSha256(after)).not.toBe(archiveManifestSha256(before));
  });
});

describe('approved files that are zips', () => {
  test('keep their member table through the requests record', () => {
    const dir = folder();
    writeFileSync(join(dir, 'a.zip'), zipWithDepth(5, { name: 'z/info.json', data: '{}' }));
    const root = open(dir);
    const files = buildArchiveManifest(root, ['a.zip']);
    const approved = {
      format: 'synthetic-zip',
      provider: 'synthetic-zip',
      family: 'note',
      label: 'a.zip',
      root_path: dir,
      root_identity: { dev: root.identity.dev, ino: root.identity.ino },
      chosen_rel_path: 'a.zip',
      files,
      manifest_sha256: archiveManifestSha256(files),
    };
    const path = join(dir, 'requests.json');
    const store = new ArchiveImportRequestStore({ path });
    const request = store.addChecking(join(dir, 'a.zip'), approved as never);
    const reread = new ArchiveImportRequestStore({ path }).get(request.request_id);
    expect(reread?.approved?.files[0]?.members).toEqual(files[0]!.members);
    // A damaged member table is not a form this build reads.
    const damaged = JSON.parse(readFileSync(path, 'utf8')) as { requests: Array<{ approved: { files: Array<{ members: unknown }> } }> };
    damaged.requests[0]!.approved.files[0]!.members = { count: 'many', sha256: 5 };
    writeFileSync(path, JSON.stringify(damaged));
    expect(() => new ArchiveImportRequestStore({ path }).list()).toThrow();
  });
});


/**
 * What an archive import reads, pinned at the moment it starts.
 *
 * The manifest lists every file the import reads with its version (device,
 * inode, size, modification time) and a content fingerprint (its size and a
 * hash of its first and last MiB). A resume point is bound to the manifest's
 * digest, and before any read every file must still be the version recorded
 * here: an archive whose file changed or went missing stops and says so
 * instead of resuming against different bytes.
 *
 * A second import of the same export is recognised as already imported even
 * when it was copied elsewhere (a new inode): the fingerprint finds the
 * imports it could be, and only the SHA-256 of every byte, read in bounded
 * ranges and kept on the record when an import completes, says it is. Two
 * exports that share their first and last MiB are still two exports.
 */
import { createHash } from 'node:crypto';
import {
  ARCHIVE_PROBE_HEAD_BYTES,
  ARCHIVE_PROBE_MAX_CHILDREN,
  ARCHIVE_PROBE_MAX_NAMED,
  archiveProbeNameMatches,
  archiveProbeNames,
  type ArchiveFileEntry,
  type ArchiveProbe,
  type ArchiveProbeEntry,
} from '../../core/archive-formats.ts';
import {
  ScopeSafeError,
  joinRelative,
  sameScopeFileVersion,
  type ScopeDirEntry,
  type ScopeFileReader,
  type ScopeFileVersion,
  type ScopeRoot,
} from '../../core/scope-safe-fs.ts';
import { fileByteSource } from './byte-source.ts';
import { probeFirstRecordKeys, recordProbeBudget } from './record-probe.ts';
import {
  ZipArchive,
  ZipFormatError,
  ZipMemberError,
  ZipMemberReader,
  readZipMemberHead,
  type ZipEntry,
  type ZipMemberTable,
} from './zip-reader.ts';

/**
 * How much of each end of a file the content fingerprint hashes.
 */
export const ARCHIVE_FINGERPRINT_BYTES = 1024 * 1024;
/**
 * Files inside a chosen folder whose first bytes the probe reads.
 */
const PROBE_MAX_FILE_HEADS = 32;
/**
 * Zips among those files whose members the probe lists.
 */
const PROBE_MAX_ZIPS = 4;
/**
 * Members of a zip whose first bytes the probe reads.
 */
const PROBE_MAX_MEMBER_HEADS = 32;

export interface ArchiveManifestFile {
  /**
   * Relative to the archive's approved root.
   */
  rel_path: string;
  dev: string;
  ino: string;
  size: number;
  mtime_ms: number;
  fingerprint: { head_sha256: string; tail_sha256: string };
  /**
   * A zip: how many members it had and the digest of their table, recorded
   * with the rest so a member that changed under a zip that looks the same
   * stops the import.
   */
  members?: ZipMemberTable;
  /**
   * The SHA-256 of the whole file, recorded when the import completes.
   */
  sha256?: string;
}

/**
 * The bytes one range of a whole-file digest reads.
 */
export const ARCHIVE_DIGEST_RANGE_BYTES = 8 * 1024 * 1024;

function lastComponent(relPath: string, rootPath: string): string {
  const source = relPath === '' ? rootPath : relPath;
  const parts = source.split('/').filter((part) => part !== '');
  return parts[parts.length - 1] ?? source;
}

function fileHead(root: ScopeRoot, relPath: string): Uint8Array | undefined {
  try {
    const reader = root.openFile(relPath);
    try {
      return reader.readAt(0, ARCHIVE_PROBE_HEAD_BYTES);
    } finally {
      reader.close();
    }
  } catch (error) {
    if (error instanceof ScopeSafeError) return undefined;
    throw error;
  }
}

type FirstRecordKeys = NonNullable<ArchiveProbeEntry['firstRecordKeys']>;

/**
 * The way on past a JSON file's first bytes: a read of the file from its start
 * to the keys of the first record of a list (`probeFirstRecordKeys`). The file
 * is opened when asked and closed after, so a probe that never asks holds
 * nothing; a file that changed or cannot be read has no keys.
 */
function fileFirstRecordKeys(root: ScopeRoot, relPath: string): FirstRecordKeys {
  const budget = recordProbeBudget();
  return (list, enough) => {
    try {
      const reader = root.openFile(relPath);
      try {
        return probeFirstRecordKeys(fileByteSource(reader), list, enough, budget);
      } finally {
        reader.close();
      }
    } catch (error) {
      if (error instanceof ScopeSafeError) return undefined;
      throw error;
    }
  };
}

/**
 * The same for a member of a zip, which is inflated from its start.
 */
function zipMemberFirstRecordKeys(root: ScopeRoot, zipRelPath: string, memberIndex: number): FirstRecordKeys {
  const budget = recordProbeBudget();
  return (list, enough) => {
    try {
      const file = root.openFile(zipRelPath);
      try {
        const archive = ZipArchive.open(file);
        const entry = archive.entryAt(memberIndex);
        if (!entry) return undefined;
        const member = ZipMemberReader.open(archive, entry);
        try {
          return probeFirstRecordKeys(member, list, enough, budget);
        } finally {
          member.close();
        }
      } finally {
        file.close();
      }
    } catch (error) {
      if (error instanceof ScopeSafeError || error instanceof ZipFormatError || error instanceof ZipMemberError) return undefined;
      throw error;
    }
  };
}

function lastSegment(name: string): string {
  const parts = name.split('/').filter((part) => part !== '');
  return parts[parts.length - 1] ?? name;
}

/**
 * What a zip holds, as the probe shows it: its first members in directory
 * order, then members a format asks for by name however far down the
 * directory they are, each with its first bytes where they could be read.
 * Undefined when the file turns out not to be a zip.
 */
function probeZipMembers(
  root: ScopeRoot,
  relPath: string,
  probeNames: readonly string[],
): readonly ArchiveProbeEntry[] | undefined {
  let reader: ScopeFileReader;
  try {
    reader = root.openFile(relPath);
  } catch (error) {
    if (error instanceof ScopeSafeError) return undefined;
    throw error;
  }
  try {
    const archive = ZipArchive.open(reader);
    const first: ZipEntry[] = [];
    const named: ZipEntry[] = [];
    for (const entry of archive.entries()) {
      if (first.length < ARCHIVE_PROBE_MAX_CHILDREN) first.push(entry);
      else if (named.length < ARCHIVE_PROBE_MAX_NAMED && archiveProbeNameMatches(entry.name, probeNames)) named.push(entry);
    }
    // The members a format asked for have their first bytes read before any other member's.
    const asked = [...first, ...named].filter((entry) => !entry.isDirectory && archiveProbeNameMatches(entry.name, probeNames));
    const others = first.filter((entry) => !entry.isDirectory && !asked.includes(entry));
    const heads = new Map<number, Uint8Array>();
    for (const entry of [...asked, ...others].slice(0, PROBE_MAX_MEMBER_HEADS)) {
      const head = readZipMemberHead(archive, entry, ARCHIVE_PROBE_HEAD_BYTES);
      if (head) heads.set(entry.index, head);
    }
    return [...first, ...named].map((entry) => {
      const head = heads.get(entry.index);
      return {
        relPath: entry.name,
        name: lastSegment(entry.name),
        kind: entry.isDirectory ? 'directory' as const : 'file' as const,
        ...(head ? { head } : {}),
        ...(head && !entry.isDirectory ? { firstRecordKeys: zipMemberFirstRecordKeys(root, relPath, entry.index) } : {}),
      };
    });
  } catch (error) {
    if (error instanceof ZipFormatError || error instanceof ScopeSafeError) return undefined;
    throw error;
  } finally {
    reader.close();
  }
}

function matchesAnyName(entry: ScopeDirEntry, probeNames: readonly string[]): boolean {
  return archiveProbeNameMatches(entry.name, probeNames);
}

/**
 * The cheap look detection works from: the chosen entry's name and kind, the
 * first bytes of a chosen file, and for a chosen folder the names directly
 * inside it with the first bytes of its first few files. Links are never
 * followed and never listed as files.
 *
 * A folder can hold far more than the first look takes in, and a zip far
 * more members, with the one file that says what the export is far down the
 * list. Entries whose names a format asks for (`probeNames`) are therefore
 * listed past the usual bound, up to ARCHIVE_PROBE_MAX_NAMED more, and their
 * first bytes are read before any other file's. A file that is a zip is
 * opened and its members listed the same way (`members`).
 */
export function probeArchivePath(
  root: ScopeRoot,
  chosenRelPath: string,
  options: { probeNames?: readonly string[] } = {},
): ArchiveProbe {
  const probeNames = options.probeNames ?? archiveProbeNames();
  const stat = chosenRelPath === '' ? root.statRelative('') : root.statEntry(chosenRelPath);
  const name = lastComponent(chosenRelPath, root.path);
  if (stat.kind === 'file') {
    const head = fileHead(root, chosenRelPath);
    const members = ZipArchive.looksLikeZip(head) ? probeZipMembers(root, chosenRelPath, probeNames) : undefined;
    return {
      chosen: {
        relPath: '',
        name,
        kind: 'file',
        ...(head ? { head, firstRecordKeys: fileFirstRecordKeys(root, chosenRelPath) } : {}),
        ...(members ? { members } : {}),
      },
      children: [],
    };
  }
  if (stat.kind !== 'directory') throw new ScopeSafeError('not_regular', 'neither a file nor a folder');
  const everything = root.list(chosenRelPath);
  const listed = [
    ...everything.slice(0, ARCHIVE_PROBE_MAX_CHILDREN),
    ...everything.slice(ARCHIVE_PROBE_MAX_CHILDREN).filter((entry) => matchesAnyName(entry, probeNames)).slice(0, ARCHIVE_PROBE_MAX_NAMED),
  ];
  const children: ArchiveProbeEntry[] = [];
  const kinds: Array<'file' | 'directory' | undefined> = [];
  for (const entry of listed) {
    let kind = entry.kind;
    if (kind === undefined) {
      try {
        kind = root.statEntry(joinRelative(chosenRelPath, entry.name)).kind;
      } catch {
        kind = undefined;
      }
    }
    kinds.push(kind === 'directory' || kind === 'file' ? kind : undefined);
  }
  // First bytes: the files a format asked for by name, then the rest in listing order.
  const heads = new Map<number, Uint8Array>();
  const wanted = listed.map((entry, index) => index).filter((index) => kinds[index] === 'file');
  const ordered = [
    ...wanted.filter((index) => matchesAnyName(listed[index]!, probeNames)),
    ...wanted.filter((index) => !matchesAnyName(listed[index]!, probeNames)),
  ].slice(0, PROBE_MAX_FILE_HEADS);
  for (const index of ordered) {
    const head = fileHead(root, joinRelative(chosenRelPath, listed[index]!.name));
    if (head) heads.set(index, head);
  }
  const zips = ordered.filter((index) => ZipArchive.looksLikeZip(heads.get(index))).slice(0, PROBE_MAX_ZIPS);
  listed.forEach((entry, index) => {
    const kind = kinds[index];
    if (kind === 'directory') {
      children.push({ relPath: entry.name, name: entry.name, kind: 'directory' });
    } else if (kind === 'file') {
      const head = heads.get(index);
      const members = zips.includes(index) ? probeZipMembers(root, joinRelative(chosenRelPath, entry.name), probeNames) : undefined;
      children.push({
        relPath: entry.name,
        name: entry.name,
        kind: 'file',
        ...(head ? { head, firstRecordKeys: fileFirstRecordKeys(root, joinRelative(chosenRelPath, entry.name)) } : {}),
        ...(members ? { members } : {}),
      });
    }
  });
  return { chosen: { relPath: '', name, kind: 'directory' }, children };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The member table of an open file that is a zip; undefined for any other file.
 */
function zipMemberTable(reader: ScopeFileReader, head: Uint8Array): ZipMemberTable | undefined {
  if (!ZipArchive.looksLikeZip(head)) return undefined;
  try {
    return ZipArchive.open(reader).memberTable();
  } catch (error) {
    // A file that starts like a zip and is not one is read as the format that claims it sees fit.
    if (error instanceof ZipFormatError) return undefined;
    throw error;
  }
}

/**
 * Opens each file through the scope-safe reader and records its version and
 * fingerprint, and for a zip the table of its members.
 */
export function buildArchiveManifest(root: ScopeRoot, relPaths: readonly string[]): ArchiveManifestFile[] {
  return relPaths.map((relPath) => {
    const reader = root.openFile(relPath);
    try {
      const version = reader.version;
      const span = Math.min(version.size, ARCHIVE_FINGERPRINT_BYTES);
      const head = reader.readAt(0, span);
      const tail = reader.readAt(version.size - span, span);
      const members = zipMemberTable(reader, head);
      return {
        rel_path: relPath,
        dev: version.dev,
        ino: version.ino,
        size: version.size,
        mtime_ms: version.mtimeMs,
        fingerprint: { head_sha256: sha256(head), tail_sha256: sha256(tail) },
        ...(members ? { members } : {}),
      };
    } finally {
      reader.close();
    }
  });
}

export function manifestFileVersion(file: ArchiveManifestFile): ScopeFileVersion {
  return { dev: file.dev, ino: file.ino, size: file.size, mtimeMs: file.mtime_ms };
}

export function archiveFileEntries(files: readonly ArchiveManifestFile[]): ArchiveFileEntry[] {
  return files.map((file) => ({
    relPath: file.rel_path,
    version: manifestFileVersion(file),
    ...(file.members ? { members: { count: file.members.count, sha256: file.members.sha256 } } : {}),
  }));
}

/**
 * The digest a resume point is bound to: every file's path and version, in
 * order, and for a zip its member table too. A file that is not a zip adds
 * nothing to its entry, so a digest made before zips were recorded still
 * matches.
 */
export function archiveManifestSha256(files: readonly ArchiveManifestFile[]): string {
  return createHash('sha256')
    .update(JSON.stringify(files.map((file) => [
      file.rel_path, file.dev, file.ino, file.size, file.mtime_ms,
      ...(file.members ? [file.members.count, file.members.sha256] : []),
    ])))
    .digest('hex');
}

export type ArchiveManifestCheck =
  | { ok: true }
  | { ok: false; code: 'file_changed' | 'file_missing' | 'file_unreadable'; relPath: string; message: string };

/**
 * Whether every file is still exactly the version the import started with.
 * Reads no content; for a zip it reads the directory of its members, which
 * must still be the table recorded.
 */
export function verifyArchiveManifest(root: ScopeRoot, files: readonly ArchiveManifestFile[]): ArchiveManifestCheck {
  for (const file of files) {
    let reader;
    try {
      reader = root.openFile(file.rel_path);
    } catch (error) {
      if (error instanceof ScopeSafeError && error.code === 'not_found') {
        return { ok: false, code: 'file_missing', relPath: file.rel_path, message: 'A file of this archive is no longer there.' };
      }
      if (error instanceof ScopeSafeError && (error.code === 'changed' || error.code === 'escape' || error.code === 'not_regular')) {
        return { ok: false, code: 'file_changed', relPath: file.rel_path, message: 'A file of this archive was replaced.' };
      }
      return { ok: false, code: 'file_unreadable', relPath: file.rel_path, message: 'A file of this archive could not be opened.' };
    }
    try {
      if (!sameScopeFileVersion(reader.version, manifestFileVersion(file))) {
        return { ok: false, code: 'file_changed', relPath: file.rel_path, message: 'A file of this archive changed since the import started.' };
      }
      if (file.members) {
        const now = zipMemberTable(reader, reader.readAt(0, 4));
        if (!now || now.count !== file.members.count || now.sha256 !== file.members.sha256) {
          return { ok: false, code: 'file_changed', relPath: file.rel_path, message: 'A file of this archive changed since the import started.' };
        }
      }
    } catch (error) {
      if (error instanceof ScopeSafeError) {
        const changed = error.code === 'changed' || error.code === 'escape' || error.code === 'not_regular';
        return {
          ok: false,
          code: error.code === 'not_found' ? 'file_missing' : changed ? 'file_changed' : 'file_unreadable',
          relPath: file.rel_path,
          message: 'A file of this archive could not be read as it was.',
        };
      }
      throw error;
    } finally {
      reader.close();
    }
  }
  return { ok: true };
}

/**
 * The digest of one file of a manifest, a step per range read: the reader
 * is opened at the recorded version, and the file must still be that
 * version, at its name and under the descriptor, after every range.
 */
export function* archiveFileDigestSteps(root: ScopeRoot, file: ArchiveManifestFile): Generator<void, string, void> {
  const reader = root.openFile(file.rel_path, { expected: manifestFileVersion(file) });
  try {
    const hash = createHash('sha256');
    for (let offset = 0; offset < file.size; offset += ARCHIVE_DIGEST_RANGE_BYTES) {
      hash.update(reader.readAt(offset, Math.min(ARCHIVE_DIGEST_RANGE_BYTES, file.size - offset)));
      reader.assertCurrent();
      yield;
    }
    reader.assertCurrent();
    return hash.digest('hex');
  } finally {
    reader.close();
  }
}

/**
 * The SHA-256 of one file of a manifest, read in bounded ranges.
 */
export function archiveFileSha256(root: ScopeRoot, file: ArchiveManifestFile): string {
  const steps = archiveFileDigestSteps(root, file);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

function sameVersion(a: ArchiveManifestFile, b: ArchiveManifestFile): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime_ms === b.mtime_ms;
}

function sameSample(a: ArchiveManifestFile, b: ArchiveManifestFile): boolean {
  return a.size === b.size
    && a.fingerprint.head_sha256 === b.fingerprint.head_sha256
    && a.fingerprint.tail_sha256 === b.fingerprint.tail_sha256;
}

function comparable<T extends { status: string; files: readonly ArchiveManifestFile[] }>(
  records: readonly T[],
  files: readonly ArchiveManifestFile[],
): T[] {
  return records.filter((record) => record.status !== 'removing' && record.files.length === files.length);
}

/**
 * The import that read exactly these files at exactly these versions, known
 * from metadata alone. An archive being removed does not count.
 */
export function findSameVersionImport<T extends { status: string; files: readonly ArchiveManifestFile[] }>(
  records: readonly T[],
  files: readonly ArchiveManifestFile[],
): T | undefined {
  return comparable(records, files).find((record) => record.files.every((file, index) => sameVersion(file, files[index]!)));
}

/**
 * Completed imports these files may be a copy of: the same size and the same
 * first and last bytes in every file. Only a whole-file SHA-256 says whether
 * one is (`isCopyOf`); this only picks the imports worth reading the files for.
 */
export function findProbableCopies<T extends { status: string; files: readonly ArchiveManifestFile[] }>(
  records: readonly T[],
  files: readonly ArchiveManifestFile[],
): T[] {
  return comparable(records, files)
    .filter((record) => record.files.every((file, index) => sameSample(file, files[index]!) && file.sha256 !== undefined));
}

/**
 * Whether `record` holds files with exactly these whole-file SHA-256 digests, in order.
 */
export function isCopyOf(record: { files: readonly ArchiveManifestFile[] }, digests: readonly string[]): boolean {
  return record.files.length === digests.length && record.files.every((file, index) => file.sha256 === digests[index]);
}

/**
 * The import already holding these files: the same files at the same
 * versions, or a completed import of files with the same whole-file
 * SHA-256 (a copy of the same export). The fingerprint only picks the
 * imports worth comparing; `digest` reads a new file whole, and only for
 * those. An archive being removed does not count.
 */
export function findAlreadyImported<T extends { status: string; files: readonly ArchiveManifestFile[] }>(
  records: readonly T[],
  files: readonly ArchiveManifestFile[],
  digest: (index: number) => string,
): T | undefined {
  const same = findSameVersionImport(records, files);
  if (same) return same;
  const copies = findProbableCopies(records, files);
  if (copies.length === 0) return undefined;
  const digests = files.map((_file, index) => digest(index));
  return copies.find((record) => isCopyOf(record, digests));
}

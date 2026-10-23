/**
 * Starting an import of a path the person approved.
 *
 * The caller (the dashboard's approval) hands over the canonical path the
 * picker returned. It is opened only through the scope-safe reader: a chosen
 * file through a descriptor on its folder, a chosen folder through one on
 * itself. Detection reads names and first bytes only; the manifest pins
 * every file the import will read. Nothing is written for a path that is not
 * a supported archive, two formats at once, or one already imported.
 *
 * Two steps, so a caller can answer before the slow part: `prepareArchiveImport`
 * reads metadata and first bytes only and says whether the files may be a
 * copy of an earlier import (same size, same first and last bytes); only then
 * must every file be read whole to know (`archiveFileDigestSteps`), and
 * `commitArchiveImport` records the import. `startArchiveImport` runs both
 * at once.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import {
  detectArchiveFormat,
  type ArchiveFormatDefinition,
} from '../../core/archive-formats.ts';
import { ScopeRoot, ScopeSafeError, joinRelative } from '../../core/scope-safe-fs.ts';
import {
  archiveFileSha256,
  archiveManifestSha256,
  buildArchiveManifest,
  findProbableCopies,
  findSameVersionImport,
  isCopyOf,
  probeArchivePath,
  verifyArchiveManifest,
} from './manifest.ts';
import type { ArchiveImportRecord, ArchiveImportStateStore, NewArchiveImportRecord } from './state.ts';

export type ArchiveImportStart =
  | { kind: 'started'; archive: ArchiveImportRecord }
  | { kind: 'already_imported'; archive: ArchiveImportRecord }
  | { kind: 'unsupported'; supported: readonly string[] }
  | { kind: 'ambiguous'; formats: readonly string[] }
  | { kind: 'unreadable'; code: string };

/**
 * A path ready to record. `root` stays open for the caller (it reads the
 * files whole through it when `copies` is not empty) and must be closed.
 */
export interface PreparedArchiveImport {
  kind: 'ready';
  record: NewArchiveImportRecord;
  root: ScopeRoot;
  /** Completed imports these files may be a copy of; empty when they cannot be. */
  copies: ArchiveImportRecord[];
}

export type ArchiveImportPreparation =
  | PreparedArchiveImport
  | Exclude<ArchiveImportStart, { kind: 'started' }>;

export function prepareArchiveImport(input: {
  state: ArchiveImportStateStore;
  /**
   * The canonical absolute path of the chosen file or folder.
   */
  path: string;
  /**
   * Test seam: the formats to detect among.
   */
  formats?: readonly ArchiveFormatDefinition[];
}): ArchiveImportPreparation {
  const path = input.path;
  if (!path.startsWith('/') || path.includes('\0')) return { kind: 'unreadable', code: 'escape' };
  let kind: 'file' | 'directory';
  try {
    if (realpathSync.native(path) !== path) return { kind: 'unreadable', code: 'escape' };
    const stat = lstatSync(path);
    if (stat.isFile()) kind = 'file';
    else if (stat.isDirectory()) kind = 'directory';
    else return { kind: 'unreadable', code: 'not_regular' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return { kind: 'unreadable', code: code === 'EPERM' || code === 'EACCES' ? 'permission_denied' : 'not_found' };
  }
  const rootPath = kind === 'file' ? posix.dirname(path) : path;
  const chosenRelPath = kind === 'file' ? posix.basename(path) : '';
  let root: ScopeRoot;
  try {
    root = ScopeRoot.open(rootPath);
  } catch (error) {
    return { kind: 'unreadable', code: error instanceof ScopeSafeError ? error.code : 'io' };
  }
  let handedOver = false;
  try {
    const probe = probeArchivePath(root, chosenRelPath);
    const detection = detectArchiveFormat(probe, input.formats);
    if (detection.kind === 'none') return { kind: 'unsupported', supported: detection.supported };
    if (detection.kind === 'ambiguous') return { kind: 'ambiguous', formats: detection.formats };
    const relPaths = detection.files.map((file) => (file === '' ? chosenRelPath : joinRelative(chosenRelPath, file)));
    const files = buildArchiveManifest(root, relPaths);
    const records = input.state.list();
    const same = findSameVersionImport(records, files);
    if (same) return { kind: 'already_imported', archive: same };
    handedOver = true;
    return {
      kind: 'ready',
      root,
      copies: findProbableCopies(records, files),
      record: {
        format: detection.format.id,
        provider: detection.format.provider,
        family: detection.format.family,
        label: probe.chosen.name,
        root_path: root.path,
        root_identity: { dev: root.identity.dev, ino: root.identity.ino },
        chosen_rel_path: chosenRelPath,
        files,
        manifest_sha256: archiveManifestSha256(files),
      },
    };
  } catch (error) {
    if (error instanceof ScopeSafeError) return { kind: 'unreadable', code: error.code };
    throw error;
  } finally {
    if (!handedOver) root.close();
  }
}

/**
 * Records a prepared import, once `digests` (every file's whole-file
 * SHA-256, when the preparation named possible copies) said it is not one.
 * The files must still be the versions the preparation pinned, and another
 * approval of the same files in the meantime wins. Does not close the root.
 */
export function commitArchiveImport(
  state: ArchiveImportStateStore,
  prepared: PreparedArchiveImport,
  digests?: readonly string[],
): ArchiveImportStart {
  if (prepared.copies.length > 0) {
    if (!digests) throw new Error('A possible copy is recorded only once its files were read whole.');
    const copy = prepared.copies.find((record) => isCopyOf(record, digests));
    if (copy) return { kind: 'already_imported', archive: state.get(copy.archive_id) ?? copy };
  }
  try {
    const check = verifyArchiveManifest(prepared.root, prepared.record.files);
    if (!check.ok) return { kind: 'unreadable', code: 'changed' };
  } catch (error) {
    if (error instanceof ScopeSafeError) return { kind: 'unreadable', code: error.code };
    throw error;
  }
  const same = findSameVersionImport(state.list(), prepared.record.files);
  if (same) return { kind: 'already_imported', archive: same };
  return { kind: 'started', archive: state.create(prepared.record) };
}

export function startArchiveImport(input: {
  state: ArchiveImportStateStore;
  /**
   * The canonical absolute path of the chosen file or folder.
   */
  path: string;
  /**
   * Test seam: the formats to detect among.
   */
  formats?: readonly ArchiveFormatDefinition[];
}): ArchiveImportStart {
  const prepared = prepareArchiveImport(input);
  if (prepared.kind !== 'ready') return prepared;
  try {
    const digests = prepared.copies.length > 0
      ? prepared.record.files.map((file) => archiveFileSha256(prepared.root, file))
      : undefined;
    return commitArchiveImport(input.state, prepared, digests);
  } catch (error) {
    if (error instanceof ScopeSafeError) return { kind: 'unreadable', code: error.code };
    throw error;
  } finally {
    prepared.root.close();
  }
}

/**
 * Starting an import of a path the person approved.
 *
 * The caller (the dashboard's approval, later) hands over the canonical path
 * the picker returned. It is opened only through the scope-safe reader: a
 * chosen file through a descriptor on its folder, a chosen folder through one
 * on itself. Detection reads names and first bytes only; the manifest pins
 * every file the import will read. Nothing is written for a path that is not
 * a supported archive, two formats at once, or one already imported.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import {
  detectArchiveFormat,
  type ArchiveFormatDefinition,
} from '../../core/archive-formats.ts';
import { ScopeRoot, ScopeSafeError, joinRelative } from '../../core/scope-safe-fs.ts';
import {
  archiveManifestSha256,
  buildArchiveManifest,
  findAlreadyImported,
  probeArchivePath,
} from './manifest.ts';
import type { ArchiveImportRecord, ArchiveImportStateStore } from './state.ts';

export type ArchiveImportStart =
  | { kind: 'started'; archive: ArchiveImportRecord }
  | { kind: 'already_imported'; archive: ArchiveImportRecord }
  | { kind: 'unsupported'; supported: readonly string[] }
  | { kind: 'ambiguous'; formats: readonly string[] }
  | { kind: 'unreadable'; code: string };

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
  const path = input.path;
  if (!path.startsWith('/') || path.includes('\0')) return { kind: 'unreadable', code: 'escape' };
  let kind: 'file' | 'directory';
  try {
    if (realpathSync.native(path) !== path) return { kind: 'unreadable', code: 'escape' };
    const stat = lstatSync(path);
    if (stat.isFile()) kind = 'file';
    else if (stat.isDirectory()) kind = 'directory';
    else return { kind: 'unreadable', code: 'not_regular' };
  } catch {
    return { kind: 'unreadable', code: 'not_found' };
  }
  const rootPath = kind === 'file' ? posix.dirname(path) : path;
  const chosenRelPath = kind === 'file' ? posix.basename(path) : '';
  let root: ScopeRoot;
  try {
    root = ScopeRoot.open(rootPath);
  } catch (error) {
    return { kind: 'unreadable', code: error instanceof ScopeSafeError ? error.code : 'io' };
  }
  try {
    const probe = probeArchivePath(root, chosenRelPath);
    const detection = detectArchiveFormat(probe, input.formats);
    if (detection.kind === 'none') return { kind: 'unsupported', supported: detection.supported };
    if (detection.kind === 'ambiguous') return { kind: 'ambiguous', formats: detection.formats };
    const relPaths = detection.files.map((file) => (file === '' ? chosenRelPath : joinRelative(chosenRelPath, file)));
    const files = buildArchiveManifest(root, relPaths);
    const existing = findAlreadyImported(input.state.list(), files);
    if (existing) return { kind: 'already_imported', archive: existing };
    const archive = input.state.create({
      format: detection.format.id,
      provider: detection.format.provider,
      family: detection.format.family,
      label: probe.chosen.name,
      root_path: root.path,
      root_identity: { dev: root.identity.dev, ino: root.identity.ino },
      chosen_rel_path: chosenRelPath,
      files,
      manifest_sha256: archiveManifestSha256(files),
    });
    return { kind: 'started', archive };
  } catch (error) {
    if (error instanceof ScopeSafeError) return { kind: 'unreadable', code: error.code };
    throw error;
  } finally {
    root.close();
  }
}

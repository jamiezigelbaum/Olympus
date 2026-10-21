// The folder picker's side of files on this computer: it lists folders (never
// files) from the person's home folder down, the disks mounted now as
// Locations, and says which folders are off unless turned on. Nothing is
// selected here; a choice is made by the person and approved through the
// shared scope flow.

import { lstatSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OlympusFolderScopeNode } from '../../control-ui-contract.ts';
import {
  decodeCursor,
  effectiveSelections,
  encodeCursor,
  registerFileScopeBrowserFactory,
  type FileScopeBrowserContext,
  type SourceFolderScopeBrowser,
} from '../source-scope-browser.ts';
import { realPathOfScopePath, scopePathOfRealPath } from './locations.ts';
import {
  DEFAULT_EXCLUSION_LABELS,
  defaultExclusionContext,
  defaultExclusionForFolder,
  normalizeScopePath,
  scopePathFor,
  splitScopePath,
  type DefaultExclusionContext,
} from './paths.ts';
import { LOCAL_FILES_SOURCE_ID } from './scope.ts';
import { VolumeResolver } from './volume-identity.ts';

const BROWSE_PAGE_SIZE = 100;

export interface LocalFilesFolderScopeBrowserOptions {
  volumes?: VolumeResolver;
  context?: DefaultExclusionContext;
  /** Test seam: the directory entries of a real path. */
  readDirectory?: (realPath: string) => Dirent[];
  /** Test seam: the real path of the home folder. */
  home?: string;
}

function safeRealpath(path: string): string {
  try { return realpathSync.native(path); } catch { return path; }
}

/** `/@id/a/b` -> `['/@id', '/@id/a']`; `/a/b/c` -> `['/a', '/a/b']`. Root-to-parent. */
function ancestorScopePaths(scopePath: string): string[] {
  const { volumeId, path } = splitScopePath(scopePath);
  const parts = path.split('/').filter(Boolean);
  const out: string[] = [];
  if (volumeId) out.push(scopePathFor('/', volumeId));
  for (let length = 1; length < parts.length; length += 1) {
    out.push(scopePathFor(`/${parts.slice(0, length).join('/')}`, volumeId));
  }
  return out;
}

export function createLocalFilesFolderScopeBrowser(
  options: LocalFilesFolderScopeBrowserOptions = {},
): SourceFolderScopeBrowser {
  const volumes = options.volumes ?? new VolumeResolver();
  const home = safeRealpath(options.home ?? options.context?.home ?? homedir());
  const context = options.context ?? { ...defaultExclusionContext(), home };
  const readDirectory = options.readDirectory
    ?? ((realPath: string) => readdirSync(realPath, { withFileTypes: true }));

  const node = (scopePath: string, name: string, parentKey: string | undefined): OlympusFolderScopeNode => {
    const reason = defaultExclusionForFolder(scopePath, context);
    return {
      key: scopePath,
      ...(parentKey !== undefined ? { parent_key: parentKey } : {}),
      name: name.normalize('NFC'),
      kind: 'folder',
      // Counting a folder's children would read it; an empty page is the answer.
      has_children: true,
      selectable: true,
      ...(reason ? { excluded_by_default: true, default_exclusion_reason: DEFAULT_EXCLUSION_LABELS[reason] } : {}),
    };
  };

  const childFolders = (realPath: string, parentKey: string | undefined): OlympusFolderScopeNode[] => {
    let entries: Dirent[];
    try {
      entries = readDirectory(realPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new Error('Olympus is not allowed to read this folder. Allow it in the computer\'s privacy settings, then update folders.');
      }
      throw new Error('This folder could not be read. It may have moved or its disk may be unmounted.');
    }
    return entries
      // A link is never followed, so it is not offered; a file is not a folder.
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => node(scopePathOfRealPath(volumes, join(realPath, entry.name)), entry.name, parentKey))
      .sort((a, b) => {
        const aHidden = a.name.startsWith('.');
        const bHidden = b.name.startsWith('.');
        if (aHidden !== bHidden) return aHidden ? 1 : -1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
  };

  return {
    sourceId: LOCAL_FILES_SOURCE_ID,
    async browse(request) {
      const parent = request.parentKey === undefined ? undefined : normalizeScopePath(request.parentKey);
      const offsetText = decodeCursor(LOCAL_FILES_SOURCE_ID, parent ?? '', request.cursor);
      const offset = offsetText === undefined ? 0 : Number.parseInt(offsetText, 10);
      if (!Number.isInteger(offset) || offset < 0) throw new Error('Folder browse cursor is invalid.');

      let all: OlympusFolderScopeNode[];
      if (parent === undefined) {
        // The home folder's folders, then the disks mounted now.
        volumes.refresh();
        all = [
          ...childFolders(home, undefined),
          ...volumes.locations().map((volume) => ({
            key: scopePathFor('/', volume.id),
            name: volume.label,
            kind: 'folder' as const,
            has_children: true,
            selectable: true,
          })),
        ];
      } else {
        const real = realPathOfScopePath(volumes, parent);
        if (!real) throw new Error('That disk is not connected right now.');
        all = childFolders(real, parent);
      }
      const page = all.slice(offset, offset + BROWSE_PAGE_SIZE);
      const next = offset + BROWSE_PAGE_SIZE;
      return {
        nodes: page,
        ...(next < all.length ? { nextCursor: encodeCursor(LOCAL_FILES_SOURCE_ID, parent ?? '', String(next)) } : {}),
      };
    },
    async validateSelections(selections) {
      const normalized = selections.map((selection) => ({ ...selection, key: normalizeScopePath(selection.key) }));
      for (const selection of normalized) {
        if (selection.key === '/') throw new Error('Whole-computer access requires explicit confirmation.');
        const real = realPathOfScopePath(volumes, selection.key);
        if (!real) throw new Error('A selected disk is not connected right now.');
        let isFolder = false;
        try { isFolder = lstatSync(real).isDirectory(); } catch { isFolder = false; }
        if (!isFolder) throw new Error('A selected folder could not be verified. It may have moved.');
      }
      return effectiveSelections(normalized, (key) => ancestorScopePaths(key));
    },
  };
}

registerFileScopeBrowserFactory(LOCAL_FILES_SOURCE_ID, (_context: FileScopeBrowserContext) =>
  createLocalFilesFolderScopeBrowser());

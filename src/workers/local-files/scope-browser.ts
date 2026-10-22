// The folder picker's side of files on this computer: it lists folders (never
// files) from the person's home folder down, the disks mounted now as
// Locations, and says which folders are off unless turned on. Nothing is
// selected here; a choice is made by the person and approved through the
// shared scope flow.

import { lstatSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OlympusFolderAccess, OlympusFolderScopeNode } from '../../control-ui-contract.ts';
import { olympusDataDir } from '../../core/remote-access.ts';
import {
  decodeCursor,
  effectiveSelections,
  encodeCursor,
  registerFileScopeBrowserFactory,
  type FileScopeBrowserContext,
  type SourceFolderScopeBrowser,
} from '../source-scope-browser.ts';
import { realPathOfScopePath, scopePathOfRealPath } from './locations.ts';
import { MAC_ACCESS_COPY, MacPermissions } from './mac-permissions.ts';
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
import { revealHelperAndOpenFullDiskAccess } from './mac-settings.ts';

const BROWSE_PAGE_SIZE = 100;

export interface LocalFilesFolderScopeBrowserOptions {
  volumes?: VolumeResolver;
  context?: DefaultExclusionContext;
  /** Test seam: the directory entries of a real path. */
  readDirectory?: (realPath: string) => Dirent[];
  /** Test seam: the real path of the home folder. */
  home?: string;
  /** The Mac's permission rules for guarded folders (mac-permissions.ts). */
  permissions?: MacPermissions;
  /** Test seam: what to do when the person saves the whole computer without Full Disk Access. */
  openFullDiskAccess?: () => void;
}

/** Thrown inside a listing when the Mac refused the read: the level reports it, it is not an error. */
class AccessRefused extends Error {
  constructor(readonly access: OlympusFolderAccess) { super(access.message); }
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
  const permissions = options.permissions ?? new MacPermissions({
    home,
    memoryPath: join(olympusDataDir(), 'local-files', 'folder-access.json'),
  });

  const node = (
    scopePath: string,
    name: string,
    parentKey: string | undefined,
    access?: OlympusFolderAccess,
  ): OlympusFolderScopeNode => {
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
      ...(access ? { access } : {}),
    };
  };

  const childFolders = (realPath: string, parentKey: string | undefined): OlympusFolderScopeNode[] => {
    let entries: Dirent[];
    try {
      entries = readDirectory(realPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        const guard = permissions.guardOf(realPath, volumes.volumeOf(realPath));
        // A guarded folder the Mac said no to: say how to turn it back on.
        if (guard) throw new AccessRefused(permissions.noteDenied(guard));
        // Not a guarded place: on a Mac the likely cause is Full Disk Access.
        const fda = permissions.active && !permissions.hasFullDiskAccess() ? permissions.fullDiskAccessNote() : undefined;
        if (fda) throw new AccessRefused(fda);
        throw new Error('Your computer does not let Olympus open this folder. Check who may open it in Finder (Get Info, then Sharing & Permissions), then try again.');
      }
      throw new Error('This folder could not be read. It may have moved or its disk may be unmounted.');
    }
    return entries
      // A link is never followed, so it is not offered; a file is not a folder.
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => {
        const childReal = join(realPath, entry.name);
        const guard = permissions.guardOf(childReal, volumes.volumeOf(childReal));
        // Only the top of a guarded place is labelled; inside it the answer already holds.
        const access = guard && guard.root === childReal ? permissions.nodeAccess(guard) : undefined;
        return node(scopePathOfRealPath(volumes, childReal), entry.name, parentKey, access);
      })
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
      let access: OlympusFolderAccess | undefined;
      if (parent === undefined) {
        // The home folder's folders, then the disks mounted now.
        volumes.refresh();
        all = [
          ...childFolders(home, undefined),
          ...volumes.locations().map((volume) => {
            const guard = permissions.guardOf(volume.mountPoint, volume);
            const diskAccess = guard ? permissions.nodeAccess(guard) : undefined;
            return {
              key: scopePathFor('/', volume.id),
              name: volume.label,
              kind: 'folder' as const,
              has_children: true,
              selectable: true,
              ...(diskAccess ? { access: diskAccess } : {}),
            };
          }),
        ];
        // Searching the whole computer needs Full Disk Access; say so up front.
        access = permissions.fullDiskAccessNote();
      } else {
        const real = realPathOfScopePath(volumes, parent);
        if (!real) throw new Error('That disk is not connected right now.');
        // Opening a guarded folder is the ask: the Mac's question appears (in
        // the helper's name) and this level answers with what came of it.
        const guard = permissions.guardOf(real, volumes.volumeOf(real));
        const refused = guard ? await permissions.open(guard) : undefined;
        if (refused) return { nodes: [], access: refused };
        try {
          all = childFolders(real, parent);
        } catch (error) {
          if (error instanceof AccessRefused) return { nodes: [], access: error.access };
          throw error;
        }
      }
      const page = all.slice(offset, offset + BROWSE_PAGE_SIZE);
      const next = offset + BROWSE_PAGE_SIZE;
      return {
        nodes: page,
        ...(next < all.length ? { nextCursor: encodeCursor(LOCAL_FILES_SOURCE_ID, parent ?? '', String(next)) } : {}),
        ...(access ? { access } : {}),
      };
    },
    checkApproval({ selections, wholeAccount }) {
      // Until the engine runs under the helper app, a guarded folder (or the
      // whole computer) cannot be saved: its first read would be attributed to
      // Bun, and the Mac's question would name the wrong app.
      if (!permissions.active || permissions.hasHelper()) return;
      const blocked = wholeAccount || selections.some((selection) => {
        if (selection.state === 'exclude') return false;
        const key = normalizeScopePath(selection.key);
        if (key === '/') return true;
        const real = realPathOfScopePath(volumes, key);
        return real !== undefined && permissions.blocksReadWithoutHelper(real, volumes.volumeOf(real));
      });
      if (blocked) throw new Error(MAC_ACCESS_COPY.needsHelper);
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
        // A key must name the folder by its real path, spelled as the disk
        // spells it: a link in the way, or a different case on a disk that
        // ignores case, would let the default-off and exclude rules (which
        // compare real names) miss it. A spelling that differs only in case is
        // rewritten; a path that goes through a link is refused.
        const canonical = realpathSync.native(real);
        if (canonical !== real) {
          if (canonical.normalize('NFC').toLowerCase() !== real.normalize('NFC').toLowerCase()) {
            throw new Error('A selected folder is reached through a link. Choose the folder itself.');
          }
          selection.key = scopePathOfRealPath(volumes, canonical);
        }
      }
      return effectiveSelections(normalized, (key) => ancestorScopePaths(key));
    },
    async afterApproval({ wholeAccount }) {
      // Saving the whole computer without Full Disk Access: open the page where
      // the person switches it on, with the helper app shown in Finder to drag in.
      if (wholeAccount && permissions.active && permissions.hasHelper() && !permissions.hasFullDiskAccess()) {
        (options.openFullDiskAccess ?? revealHelperAndOpenFullDiskAccess)();
      }
    },
  };
}

registerFileScopeBrowserFactory(LOCAL_FILES_SOURCE_ID, (_context: FileScopeBrowserContext) =>
  createLocalFilesFolderScopeBrowser());

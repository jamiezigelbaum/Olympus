/**
 * Where a local file opens: the file itself on this computer, in Finder or the
 * desktop's default app. A cited local file's locator is its scope path; the
 * path it opens is resolved here from the engine's own record, then checked
 * again when it is opened (`core/local-open.ts`): a regular file, no symlink on
 * the way, inside a folder the owner chose.
 */
import { realpathSync, statSync } from 'node:fs';
import type { VolumeResolver } from './volume-identity.ts';
import { realPathOfScopePath } from './locations.ts';
import { isWithinScopePath, normalizeScopePath } from './paths.ts';

export interface LocalFilesOpenTarget {
  localPath: string;
}

/** The real paths of the folders the owner chose that exist right now. */
export function localFilesOpenRoots(
  volumes: VolumeResolver,
  approvedScopePaths: () => readonly string[],
): string[] {
  const roots: string[] = [];
  for (const scopePath of approvedScopePaths()) {
    const resolved = realPathOfScopePath(volumes, scopePath);
    if (!resolved) continue;
    try {
      const real = realpathSync.native(resolved);
      if (statSync(real).isDirectory() && !roots.includes(real)) roots.push(real);
    } catch {
      // A folder that is not there opens nothing.
    }
  }
  return roots;
}

/** Resolves a cited file's locator (its scope path) to the path it opens at. */
export function createLocalFilesOpenTargets(options: {
  volumes: VolumeResolver;
  approvedScopePaths: () => readonly string[];
}): (locator: string) => LocalFilesOpenTarget | undefined {
  return (locator) => {
    let scopePath: string;
    try {
      scopePath = normalizeScopePath(locator);
    } catch {
      return undefined;
    }
    const inside = options.approvedScopePaths().some((root) => isWithinScopePath(scopePath, root));
    if (!inside) return undefined;
    const resolved = realPathOfScopePath(options.volumes, scopePath);
    if (!resolved) return undefined;
    try {
      const real = realpathSync.native(resolved);
      return statSync(real).isFile() ? { localPath: real } : undefined;
    } catch {
      return undefined;
    }
  };
}

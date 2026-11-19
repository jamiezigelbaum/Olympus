import { lstat } from 'node:fs/promises';

/**
 * Observe only files that can make a pending mount ready. In particular, a
 * writer can finish the schema in a WAL without changing the database file.
 * Placement and ownership are still checked by the ordinary mount functions.
 */
export function createFrontMountChanges() {
  let previous = new Map<string, string>();
  return async (groups: ReadonlyMap<string, readonly string[]>, addBaseline = false): Promise<Set<string>> => {
    const paths = [...new Set([...groups.values()].flat())];
    const current = new Map(await Promise.all(paths.map(async (path) => {
      try {
        const file = await lstat(path, { bigint: true });
        // No ctime: a mount attempt's own permission or ownership touch on a
        // sidecar file moves it, and a failed attempt would then call itself
        // back at every look.
        return [path, `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}`] as const;
      } catch (error) {
        return [path, (error as NodeJS.ErrnoException).code ?? 'unreadable'] as const;
      }
    })));
    const changed = new Set<string>();
    for (const [group, candidates] of groups) {
      if (candidates.some((path) => (previous.get(path) ?? 'ENOENT') !== current.get(path))) changed.add(group);
    }
    if (addBaseline) {
      for (const [path, signature] of current) if (!previous.has(path)) previous.set(path, signature);
    } else {
      previous = current;
    }
    return changed;
  };
}

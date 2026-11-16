// The stores under the data root and their size, which the worker's start budget is sized from. A failed update puts
// the whole data root back (core/data-root-snapshot.ts); no store is copied one by one.

import { statSync } from 'node:fs';
import { dataRootFiles } from './boot-progress.ts';
import type { LayoutEnv } from './olympus-layout.ts';

/** Every store file under the data root: `*.sqlite`, not a copy, a journal or a link. */
export function olympusStoreFiles(env: LayoutEnv): string[] {
  return dataRootFiles(env, (name) => name.endsWith('.sqlite'));
}

/** The stores' size on disk, their WAL files included. */
export function olympusStoreBytes(env: LayoutEnv): number {
  let total = 0;
  for (const file of olympusStoreFiles(env)) {
    for (const path of [file, `${file}-wal`]) {
      try { total += statSync(path).size; } catch { /* no WAL */ }
    }
  }
  return total;
}

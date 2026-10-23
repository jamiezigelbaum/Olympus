/**
 * The one way Olympus opens a store database. Opening takes shared store
 * custody (core/store-custody.ts) first, so Delete indexed data, which needs
 * custody exclusive, can prove nothing has a store open, and it keeps a store
 * shut while a started delete of it is unfinished (core/delete-fence.ts). A raw `new Database(`
 * on a store path elsewhere in src/ or scripts/ fails
 * test/store-open-guard.test.ts.
 */
import { Database } from 'bun:sqlite';
import { isStorePathFenced } from './delete-fence.ts';
import { holdStoreCustodyShared } from './store-custody.ts';

const warned = new Set<string>();

export function openStoreDatabase(path: string, options?: ConstructorParameters<typeof Database>[1]): Database {
  if (path === ':memory:' || path === '') return new Database(path, options);
  holdStoreCustodyShared();
  // A Delete indexed data that started and did not finish keeps this store shut:
  // the file is half removed, and opening it would index into (or read from) a
  // partial store. The caller gets an empty in-memory database, which is the
  // truth of a source being deleted, and the file is not touched.
  if (isStorePathFenced(path)) {
    if (!warned.has(path)) {
      warned.add(path);
      console.error(`olympus: ${path} is kept closed until its Delete indexed data finishes.`);
    }
    return new Database(':memory:');
  }
  return new Database(path, options);
}

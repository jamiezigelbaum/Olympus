/**
 * The one way Olympus opens a store database. Opening takes shared store
 * custody (core/store-custody.ts) first, so Delete indexed data, which needs
 * custody exclusive, can prove nothing has a store open. A raw `new Database(`
 * on a store path elsewhere in src/ or scripts/ fails
 * test/store-open-guard.test.ts.
 */
import { Database } from 'bun:sqlite';
import { holdStoreCustodyShared } from './store-custody.ts';

export function openStoreDatabase(path: string, options?: ConstructorParameters<typeof Database>[1]): Database {
  if (path !== ':memory:' && path !== '') holdStoreCustodyShared();
  return new Database(path, options);
}

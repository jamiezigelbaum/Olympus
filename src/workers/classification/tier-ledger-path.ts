// Where a store's tier ledger lives, kept dependency-free so the data
// lifecycle (export / delete) can enumerate ledgers without loading the
// classifier.
//
// One ledger per connector store, co-located with it: `<store>.tier-ledger.sqlite`
// beside `<store>.sqlite`. Wherever the store is — the default data
// directory, a *_DB_PATH override, XDG_DATA_HOME, the WhatsApp state
// directory — its ledger is next to it, so every path that finds the store
// finds the ledger, and deleting one source's stores deletes exactly that
// source's ledger rows.

export const TIER_LEDGER_SQLITE_STORE_ID = 'olympus_tier_ledger';
export const TIER_LEDGER_FILE_SUFFIX = '.tier-ledger.sqlite';

/** The ledger path for a store database path. `:memory:` stores get an in-memory ledger. */
export function tierLedgerPathForStore(storeDbPath: string): string {
  if (storeDbPath === ':memory:') return ':memory:';
  const base = storeDbPath.endsWith('.sqlite') ? storeDbPath.slice(0, -'.sqlite'.length) : storeDbPath;
  return `${base}${TIER_LEDGER_FILE_SUFFIX}`;
}

/**
 * The secret-locations index (secret-locations.ts) is co-located the same
 * way: one per tiered store set, beside the set's secure_local store, whose
 * ledger is the set ledger. Deleting a source therefore deletes exactly that
 * source's secret locations, and nothing else's.
 */
export const SECRET_LOCATIONS_SQLITE_STORE_ID = 'olympus_secret_locations';
export const SECRET_LOCATIONS_FILE_SUFFIX = '.secret-locations.sqlite';

export function secretLocationsPathForStore(storeDbPath: string): string {
  if (storeDbPath === ':memory:') return ':memory:';
  const base = storeDbPath.endsWith('.sqlite') ? storeDbPath.slice(0, -'.sqlite'.length) : storeDbPath;
  return `${base}${SECRET_LOCATIONS_FILE_SUFFIX}`;
}

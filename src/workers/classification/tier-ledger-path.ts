import { sharedDataPath } from '../../core/olympus-layout.ts';
// Where a store's tier ledger lives, kept dependency-free so the data
// lifecycle (export / delete) can enumerate ledgers without loading the
// classifier.
//
// One ledger per connector store, co-located with it: `<store>.tier-ledger.sqlite`
// beside `<store>.sqlite`. Wherever the store is — the default data
// directory, an account folder, XDG_DATA_HOME, the WhatsApp state
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

// The sniffer's verdict cache and question queue, co-located the same way:
// `<store>.tier-sniffer.sqlite`. Unlike the ledger it holds the NAMES and
// short excerpts of items waiting for the privacy-safe model (the same
// material the store itself holds for them), so it goes wherever the store
// goes and is deleted with it.
export const TIER_SNIFFER_SQLITE_STORE_ID = 'olympus_tier_sniffer';
export const TIER_SNIFFER_FILE_SUFFIX = '.tier-sniffer.sqlite';

/** The sniffer file beside a tier ledger: the same base, the sniffer suffix. */
export function tierSnifferPathForLedger(ledgerPath: string): string {
  if (ledgerPath === ':memory:') return ':memory:';
  const base = ledgerPath.endsWith(TIER_LEDGER_FILE_SUFFIX) ? ledgerPath.slice(0, -TIER_LEDGER_FILE_SUFFIX.length) : ledgerPath;
  return `${base}${TIER_SNIFFER_FILE_SUFFIX}`;
}

export function tierSnifferPathForStore(storeDbPath: string): string {
  if (storeDbPath === ':memory:') return ':memory:';
  const base = storeDbPath.endsWith('.sqlite') ? storeDbPath.slice(0, -'.sqlite'.length) : storeDbPath;
  return `${base}${TIER_SNIFFER_FILE_SUFFIX}`;
}

/** Retired model directory, retained only for cleanup of existing installs. */
export function embeddingPrefilterDirectory(ledgerPath: string): string {
  return `${ledgerPath}.embedding-prefilter`;
}

/** Retired install-wide model ledger, retained only for cleanup. */
export function embeddingPrefilterInstallLedgerPath(classificationLedgerPath: string): string {
  return `${classificationLedgerPath}.embedding-prefilter.tier-ledger.sqlite`;
}

/** The complete retired-state inventory, shared by startup and data deletion. */
export function retiredEmbeddingPrefilterPaths(ledgerPath: string): { directories: string[]; ledger: string } {
  const ledger = embeddingPrefilterInstallLedgerPath(ledgerPath);
  return { directories: [embeddingPrefilterDirectory(ledgerPath), embeddingPrefilterDirectory(ledger)], ledger };
}

export const CLASSIFICATION_LEDGER_PATH_ENV = 'OLYMPUS_CLASSIFICATION_LEDGER_PATH';

/** Shared install path used by the judge ledger and deletion owner. */
export function resolveClassificationLedgerPath(env: Record<string, string | undefined> = process.env): string {
  return env[CLASSIFICATION_LEDGER_PATH_ENV]?.trim() || sharedDataPath('classification-ledger', env);
}

/**
 * Where imported archives are stored: one set of per-tier connector stores
 * per source family, shared by every archive of that family. Each archive's
 * items carry its own `accountScope`, so one archive is removed row by row
 * without touching another (removal.ts), and the whole set goes with the
 * source in the data lifecycle.
 *
 * - `secure_local.archive.<family>`: Private items, and held content (an
 *   import's content stays Private until the private model judged it).
 * - `internal.archive.<family>` and `public_safe.archive.<family>`: created
 *   when an item is first routed there.
 *
 * Every store is created on first need, so an install that never imported
 * anything has none.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { standaloneLinuxDataDir } from '../../core/linux-engine-layout.ts';
import type { SourceFamily, SourceTrustDomain } from '../../core/source-index/types.ts';
import type { TierLedger } from '../classification/tier-ledger.ts';
import { LocalConnectorStore } from '../connector-store/index.ts';
import type { ConnectorStorePlacementRule } from '../connector-store/tier-placement.ts';

export const ARCHIVE_TIER_DOMAINS: readonly SourceTrustDomain[] = ['public_safe', 'internal', 'secure_local'];

/**
 * Where an archive item rests when no per-item route applies: S4 / secure_local, raised to S5 for a secret.
 */
export const ARCHIVE_STORE_PLACEMENT: ConnectorStorePlacementRule = Object.freeze({
  trustTier: 'S4',
  trustDomain: 'secure_local',
  secretsInContent: true,
});

/**
 * The corpus id of one tier store of one family's archives.
 */
export function archiveCorpusId(trustDomain: SourceTrustDomain, family: SourceFamily): string {
  return `${trustDomain}.archive.${family}`;
}

/**
 * The set id of one family's archive stores in the tier ledger.
 */
export function archiveTierSetId(family: SourceFamily): string {
  return `archive.imports.${family}`;
}

function dataDir(env: Record<string, string | undefined>): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return standaloneLinuxDataDir(env) ?? join(dataHome, 'openclaw', 'olympus');
}

const FILE_LABEL: Readonly<Record<string, string>> = {
  secure_local: '',
  internal: '-internal',
  public_safe: '-public',
};

export function archiveConnectorStoreDbPath(
  trustDomain: SourceTrustDomain,
  family: SourceFamily,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(dataDir(env), `archive-${family}${FILE_LABEL[trustDomain] ?? `-${trustDomain}`}-connector-store.sqlite`);
}

/**
 * Every archive store's path for these families: the lifecycle deletes all of them with the source.
 */
export function archiveConnectorStoreDbPaths(
  families: readonly SourceFamily[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  // The secure store first: the set ledger and secret-locations index sit beside it.
  return families.flatMap((family) => ['secure_local', 'internal', 'public_safe']
    .map((domain) => archiveConnectorStoreDbPath(domain as SourceTrustDomain, family, env)));
}

export function createArchiveConnectorStore(
  trustDomain: SourceTrustDomain,
  family: SourceFamily,
  env: Record<string, string | undefined> = process.env,
  options: { readOnly?: boolean; tierLedger?: TierLedger } = {},
): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath: archiveConnectorStoreDbPath(trustDomain, family, env),
    corpusId: archiveCorpusId(trustDomain, family),
    family,
    trustDomain,
    ...(options.readOnly === true ? { readOnly: true } : {}),
    ...(options.tierLedger ? { tierLedger: options.tierLedger } : {}),
  });
}

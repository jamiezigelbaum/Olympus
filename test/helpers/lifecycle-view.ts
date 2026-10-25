/**
 * The lifecycle's view of each source's account, for tests: the registry's
 * account (else the one a new account would be) and what core/account-files.ts
 * says it owns, read fresh for each context. The fields keep the names these
 * tests used for the hand-kept list that step 5 of the source-storage design
 * replaced, so the assertions about which files are exported and deleted stay
 * the same.
 */
import { lifecycleSourceAliases, lifecycleSourceIds } from '../../src/core/account-files.ts';
import { lifecycleAccountFiles, type LifecyclePathContext } from '../../src/data-lifecycle.ts';

export interface LifecycleView {
  sourceId: string;
  sourceAliases: readonly string[];
  connectorStorePaths(context?: LifecyclePathContext): string[];
  sqlitePath?(context?: LifecyclePathContext): string;
  legacySqliteStoreId?: string;
  rawStatePaths(context?: LifecyclePathContext): string[];
  accountStateSqlite(context?: LifecyclePathContext): Array<{ path: string; sqliteStoreId: string }>;
  policyPaths(context?: LifecyclePathContext): string[];
  preservationOnlyPaths(context?: LifecyclePathContext): string[];
  pairingSessionPaths?(context?: LifecyclePathContext): string[];
}

export function lifecycleView(sourceId: string): LifecycleView {
  const files = (context: LifecyclePathContext = {}) => lifecycleAccountFiles(sourceId, context);
  const preCutover = files().preCutoverIndex;
  return {
    sourceId,
    sourceAliases: lifecycleSourceAliases(sourceId),
    connectorStorePaths: (context) => files(context).stores,
    ...(preCutover
      ? { sqlitePath: (context?: LifecyclePathContext) => files(context).preCutoverIndex!.path, legacySqliteStoreId: preCutover.storeId }
      : {}),
    rawStatePaths: (context) => files(context).raw,
    accountStateSqlite: (context) => files(context).rawDatabases.map((database) => ({ path: database.path, sqliteStoreId: database.storeId })),
    policyPaths: (context) => files(context).settings,
    preservationOnlyPaths: (context) => files(context).preserved,
    ...(files().pairing ? { pairingSessionPaths: (context?: LifecyclePathContext) => files(context).pairing! } : {}),
  };
}

export function lifecycleViews(): LifecycleView[] {
  return lifecycleSourceIds().map(lifecycleView);
}

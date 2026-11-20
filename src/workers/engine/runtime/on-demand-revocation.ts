import type { FileSourceScopeApprovalSnapshot } from '../../../core/source-scope-approval.ts';
import type { SourceExclusionMatcher } from '../../../core/source-ingestion-exclusions.ts';
import type { LocalConnectorStore } from '../../connector-store/index.ts';
import { tierSetForLedger } from '../../connector-store/tier-set-registry.ts';
import { revokeOnDemandReads, type SourceReadRevocation } from '../../file-extraction/on-demand-read.ts';
import { fileSourceScopeContentFilters, fileSourceScopeOnDemandFilters } from '../../source-scope-runtime.ts';

export function revokeSourceOnDemandReads(
  sourceStores: readonly LocalConnectorStore[],
  reason: SourceReadRevocation,
  approval?: FileSourceScopeApprovalSnapshot,
  matcher?: SourceExclusionMatcher,
): number {
  const stores = [...new Set(sourceStores.flatMap(store => {
    const set = tierSetForLedger(store.tierLedgerPathInUse());
    return set?.store(store.trustDomain) === store ? set.openStores() : [store];
  }))];
  if (reason === 'disconnect') return revokeOnDemandReads(stores);
  if (reason === 'exclusions') {
    if (!matcher?.active) return 0;
    return revokeOnDemandReads(stores, undefined, (store, id) => {
      const row = store.activeLocalItemRow(id);
      if (!row) return undefined;
      const metadata = store.itemMetadataSnapshot({ ...row.identity, family: store.family, localItemId: id });
      const decision = matcher.evaluateItem({ ...metadata, path: row.locatorUri, folderAncestorIds: row.sourceScope?.folderKeys });
      return decision.disposition === 'admit' || decision.readOnDemand === true;
    });
  }
  const allowed = approval ? [fileSourceScopeContentFilters(approval), fileSourceScopeOnDemandFilters(approval)] : [];
  // The next listing stamps the new revision. Compare the saved folders to
  // the existing observations for this account before acknowledging the save.
  const filters = allowed.flatMap(scope => {
    if (!scope.allowed) return [];
    const { sourceScopeRevision: _revision, ...folders } = scope.filters ?? {};
    return [folders];
  });
  return revokeOnDemandReads(stores, undefined, (store, id) => {
    if (!store.activeLocalItemRow(id)) return undefined;
    return filters.some(filter => store.itemMatchesSearchFilters(id, undefined, filter));
  });
}

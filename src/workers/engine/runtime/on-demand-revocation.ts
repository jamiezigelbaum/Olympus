import { reconcileFileScopeReadChange, type FileSourceScopeApprovalSnapshot } from '../../../core/source-scope-approval.ts';
import type { SourceExclusionMatcher } from '../../../core/source-ingestion-exclusions.ts';
import type { LocalConnectorStore } from '../../connector-store/index.ts';
import { tierSetForLedger } from '../../connector-store/tier-set-registry.ts';
import { revokeOnDemandReads, type SourceReadRevocation } from '../../file-extraction/on-demand-read.ts';
import { type FileSourceScopeAuthority, fileSourceScopeContentFilters, fileSourceScopeMetadataFilters, fileSourceScopeOnDemandFilters } from '../../source-scope-runtime.ts';

export function revokeSourceOnDemandReads(
  sourceStores: readonly LocalConnectorStore[],
  reason: SourceReadRevocation,
  scope?: { authority: FileSourceScopeAuthority; source: string },
  rules?: { before: SourceExclusionMatcher; after: SourceExclusionMatcher },
): number {
  const stores = [...new Set(sourceStores.flatMap(store => {
    const set = tierSetForLedger(store.tierLedgerPathInUse());
    return set?.store(store.trustDomain) === store ? set.openStores() : [store];
  }))];
  if (reason === 'disconnect') return revokeOnDemandReads(stores);
  if (reason === 'exclusions') {
    if (!rules) return 0;
    return revokeOnDemandReads(stores, undefined, (store, id) => {
      const row = store.activeLocalItemRow(id);
      if (!row) return undefined;
      const metadata = store.itemMetadataSnapshot({ ...row.identity, family: store.family, localItemId: id });
      const facts = { ...metadata, path: row.locatorUri, folderAncestorIds: row.sourceScope?.folderKeys };
      const next = rules.after.evaluateItem(facts);
      if (next.disposition === 'admit' || next.readOnDemand) return true;
      const prior = rules.before.evaluateItem(facts);
      return next.disposition === prior.disposition && next.readOnDemand === prior.readOnDemand;
    });
  }
  if (!scope) throw new Error('Folder permissions are unavailable.');
  const after = scope.authority.snapshot(scope.source);
  if (!after.readChangePending) {
    if (stores.length && after.status !== 'approved') throw new Error('Folder permissions are unavailable.');
    return 0;
  }
  return reconcileFileScopeReadChange(scope.authority.statePath, after, before => {
    if (before.wholeAccount === after.wholeAccount && JSON.stringify(before.selections) === JSON.stringify(after.selections)) return 0;
    const previous = folderAccess(before);
    const current = folderAccess(after);
    return revokeOnDemandReads(stores, undefined, (store, id) => {
      if (!store.activeLocalItemRow(id)) return undefined;
      const access = current(store, id);
      return access === 'read' || (access === 'names' && previous(store, id) === 'names');
    });
  });
}

function folderAccess(approval: FileSourceScopeApprovalSnapshot) {
  // The listing will stamp the new revision. Both policies must be compared
  // against the same item observations, retaining their account-generation fence.
  const match = (scope: ReturnType<typeof fileSourceScopeContentFilters>) => {
    if (!scope.allowed) return () => false;
    const { sourceScopeRevision: _revision, ...folders } = scope.filters ?? {};
    return (store: LocalConnectorStore, id: string) => store.itemMatchesSearchFilters(id, undefined, folders);
  };
  const content = match(fileSourceScopeContentFilters(approval));
  const onDemand = match(fileSourceScopeOnDemandFilters(approval));
  const metadata = match(fileSourceScopeMetadataFilters(approval));
  return (store: LocalConnectorStore, id: string) => {
    if (content(store, id) || onDemand(store, id)) return 'read';
    return metadata(store, id) ? 'names' : 'excluded';
  };
}

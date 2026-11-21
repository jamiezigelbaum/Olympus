import type { SavedSecretLocation } from '../../../core/evidence-pack.ts';
import type { SecretLocationScope, SecretLocationsIndex } from '../../classification/secret-locations.ts';
import type { TierLedger } from '../../classification/tier-ledger.ts';
import type { SearchAncestorPlan } from '../../connector-store/index.ts';

export type SearchedSecretCorpus = SecretLocationScope & SearchAncestorPlan;

interface SecretLocationLane {
  ledger: TierLedger;
  secureCorpusId: string;
  corpusIds: ReadonlySet<string>;
  secrets?: SecretLocationsIndex;
}

/** Only a searched Private corpus can release Secrets. Its parents may sit in any searched sibling. */
export function createTierSecretLocations(lanes: readonly SecretLocationLane[]) {
  function admitted(searched: readonly SearchedSecretCorpus[], includePrivateNames: boolean) {
    return lanes.flatMap(lane => {
      const scope = searched.find(entry => entry.store.corpusId === lane.secureCorpusId);
      if (!scope || !lane.secrets) return [];
      const plans = searched.filter(entry => lane.corpusIds.has(entry.store.corpusId));
      return [{ index: lane.secrets, scope, parents: { plans, ledger: lane.ledger, includePrivateNames } }];
    });
  }
  return {
    search(query: string, searched: readonly SearchedSecretCorpus[], includePrivateNames: boolean) {
      return admitted(searched, includePrivateNames).flatMap(({ index, scope, parents }) => {
        try { return index.search(query, scope, parents, 5); }
        catch { return []; }
      });
    },
    recheck(locations: readonly SavedSecretLocation[], searched: readonly SearchedSecretCorpus[], includePrivateNames: boolean) {
      const scopes = admitted(searched, includePrivateNames);
      return locations.every(location => scopes.some(({ index, scope, parents }) => {
        try { return index.recheck(location, scope, parents); }
        catch { return false; }
      }));
    },
  };
}

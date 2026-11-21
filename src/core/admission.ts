// Store-level policy. A scope describes a population, never a row lookup.
// The adapters bind these predicates to the store's existing query vocabulary.
import type { SourceTrustDomain, SourceTrustTier } from './source-index/types.ts';
import type { FileSourceScopeSelection } from './source-scope-approval.ts';
import { compareProviderAccounts } from './provider-account-identity.ts';

export type AdmissionStage = 'acquire' | 'place' | 'extract' | 'embed' | 'search' | 'answer'
  | 'deep_read' | 'people_index' | 'preview' | 'watch' | 'count' | 'deliver' | 'judge' | 'migrate' | 'backup';
export type ScopeMatcher = 'path_prefix' | 'container_key' | 'label' | 'sender' | 'conversation' | 'account';
export type Provenance = 'live' | 'owner_import';
// Unknown ownership stays explicit. An account role and a grant generation are neither one an owner id.
export interface AccountRef { id?: string | undefined }
export interface RequestScope { matcher: ScopeMatcher; value: string }
export interface AuthoritySnapshot {
  epoch: string;
  grant?: { epoch: string; owner: AccountRef; scope?: RequestScope };
  ownershipUnproven?: boolean;
  approved?: boolean;
  owner?: AccountRef;
  generation?: string;
  accountScope?: string;
  wholeAccount?: boolean;
  selections?: readonly FileSourceScopeSelection[];
  observedUnder?: string;
  previousObservedUnder?: string;
  contentAfter?: string;
}
export interface AdmissionContext {
  caller: 'owner' | 'remote_grant' | 'watch' | 'internal_judge' | 'migrate' | 'backup';
  purpose: AdmissionStage;
  layer: 'names' | 'content';
  destination: 'device' | 'private_cloud' | 'cloud' | 'recipient';
  account: AccountRef;
  requestScope?: RequestScope;
  authority: AuthoritySnapshot;
}
export interface AdmissionRegistration {
  matchers: readonly ScopeMatcher[];
  selection?: 'path_prefix' | 'container_key';
  exactKeys?: boolean;
  liveScope?: 'observed';
  // One mount may hold independently approved imports alongside observed live items.
  importObservationPrefix?: string;
  /** Acquisition approvals cover external processing. Retained items can be indexed on their owner's device. */
  retainedOnDevice?: boolean;
  provenance?: Provenance;
  requiresRecovery?: boolean;
}
export interface StoreFacts extends AdmissionRegistration {
  trustDomain: SourceTrustDomain;
  ready: boolean;
  item?: { tier: SourceTrustTier; held?: boolean; provenance?: Provenance };
}
export function mountedStoreFacts(
  store: { readonly trustDomain: SourceTrustDomain }, registration: AdmissionRegistration, ready?: boolean,
): StoreFacts {
  return { ...registration, trustDomain: store.trustDomain, ready: !registration.requiresRecovery || ready === true };
}
export interface AdmissionScope {
  accountScope?: string;
  request?: RequestScope;
  grant?: RequestScope;
  generation?: string;
  revision?: string;
  matcher?: 'path_prefix' | 'container_key';
  include?: readonly string[];
  exclude?: readonly string[];
  namesOnly?: readonly string[];
  observedUnder?: string;
  previousObservedUnder?: string;
  importPrefix?: string;
  excludeAllEmbeddingHolds?: true;
  contentAfter?: string;
}
export interface AdmissionVerdict { admitted: boolean; scope?: AdmissionScope; reason: string }

export function evaluate(context: AdmissionContext, store: StoreFacts): AdmissionVerdict {
  const { caller, purpose, layer, authority, requestScope } = context;
  if (!store.ready) return { admitted: false, reason: 'recovery_pending' };
  if (store.item?.tier === 'S5' && purpose !== 'backup' && purpose !== 'migrate') return { admitted: false, reason: 'secret_item' };
  const privateItem = store.item?.tier === 'S4' || store.item?.tier === 'S4+' || store.item?.tier === 'S5';
  if ((store.trustDomain === 'secure_local' || privateItem) && context.destination === 'cloud') {
    return { admitted: false, reason: 'private_destination_required' };
  }
  if (store.item?.held && purpose === 'embed' && layer === 'content') return { admitted: false, reason: 'embedding_hold' };
  if ((caller === 'internal_judge' && purpose === 'judge') || (caller === 'migrate' && purpose === 'migrate')
    || (caller === 'backup' && purpose === 'backup')) {
    return { admitted: true, reason: 'privileged_owner_scope_bypass' };
  }
  if (caller === 'internal_judge' || caller === 'migrate' || caller === 'backup'
    || purpose === 'judge' || purpose === 'migrate' || purpose === 'backup') {
    return { admitted: false, reason: 'privileged_purpose_mismatch' };
  }
  const grant = caller === 'remote_grant' ? authority.grant : undefined;
  if (caller === 'remote_grant' && (!grant || grant.epoch !== authority.epoch || !context.account.id || !grant.owner.id
    || compareProviderAccounts(context.account.id, grant.owner.id) !== 'same')) return { admitted: false, reason: 'grant_required' };
  if (authority.ownershipUnproven) return { admitted: false, reason: 'account_unproven' };
  const scope: AdmissionScope = {};
  if (grant?.scope) {
    if (!grant.scope.value || !store.matchers.includes(grant.scope.matcher)) return { admitted: false, reason: 'unsupported_grant_scope' };
    scope.grant = grant.scope;
  }
  if (requestScope) {
    if (!requestScope.value || !store.matchers.includes(requestScope.matcher)) return { admitted: false, reason: 'unsupported_request_scope' };
    scope.request = requestScope;
  }
  const admit = (reason: string): AdmissionVerdict => Object.keys(scope).length
    ? { admitted: true, scope, reason } : { admitted: true, reason };
  const owner = context.account.id;
  const ownership = owner && authority.owner?.id ? compareProviderAccounts(owner, authority.owner.id) : undefined;
  if (ownership === 'different') return { admitted: false, reason: 'account_mismatch' };
  if (ownership === 'unproven') return { admitted: false, reason: 'account_unproven' };
  const sameOwner = ownership === 'same';
  if ((store.item?.provenance ?? store.provenance) === 'owner_import') return admit('owner_import');
  // Acquisition approval governs new live reads. Owner search can consult
  // retained observations. Counts and embeddings also bind the processor.
  const observationScope = store.liveScope === 'observed';
  if (!store.selection && (!observationScope || purpose === 'search' || purpose === 'answer')) return admit('retained');
  const approved = authority.approved && sameOwner;
  if (observationScope) {
    if (authority.accountScope) scope.accountScope = authority.accountScope;
    if (!scope.accountScope) return { admitted: false, reason: 'account_scope_missing' };
    if (store.retainedOnDevice && context.destination === 'device' && sameOwner && (purpose === 'embed' || purpose === 'count')) {
      if (approved && purpose === 'count' && layer === 'content' && authority.contentAfter) scope.contentAfter = authority.contentAfter;
      if (purpose === 'embed') scope.excludeAllEmbeddingHolds = true;
      return admit('retained_on_device');
    }
    if (store.item?.provenance !== 'live' && store.importObservationPrefix) scope.importPrefix = store.importObservationPrefix;
    if (approved && authority.observedUnder) {
      scope.observedUnder = authority.observedUnder;
      if (authority.previousObservedUnder) scope.previousObservedUnder = authority.previousObservedUnder;
      if (layer === 'content' && purpose === 'count' && authority.contentAfter) scope.contentAfter = authority.contentAfter;
      return admit('current_observation');
    }
    return scope.importPrefix ? admit('imports_only') : { admitted: false, reason: 'live_approval_required' };
  }
  if (authority.approved && !sameOwner) return { admitted: false, reason: 'account_unproven' };
  if (!approved || !authority.accountScope || !authority.generation) return { admitted: false, reason: 'owner_approval_required' };
  const selections = authority.selections ?? [];
  const included = (s: FileSourceScopeSelection) => layer === 'names' ? s.state !== 'exclude' : s.state === 'ingest';
  const include = selections.filter(included).map(s => s.key);
  if (!authority.wholeAccount && !include.length) return { admitted: false, reason: 'empty_layer_scope' };
  scope.accountScope = authority.accountScope;
  scope.generation = authority.generation;
  if (!store.exactKeys) scope.revision = authority.epoch;
  scope.matcher = store.selection!;
  if (!authority.wholeAccount) scope.include = include;
  const exclude = selections.filter(s => !included(s)).map(s => s.key);
  if (exclude.length) scope.exclude = exclude;
  if (layer === 'names') {
    const namesOnly = selections.filter(s => s.state === 'metadata_only' || s.state === 'on_demand').map(s => s.key);
    if (namesOnly.length) scope.namesOnly = namesOnly;
  }
  return admit('approved_selection');
}

// A request for all sources supplies an explicit set; a mounted sibling has
// no implicit grant. Registry settings and mount availability are live facts.
export function admitsSearchCorpus(input: {
  corpusId: string;
  requested: ReadonlySet<string>;
  tierCorpusIds?: ReadonlySet<string>;
  enabled: boolean;
  searchable: boolean;
  mounted: boolean;
}): boolean {
  return input.mounted && input.enabled && input.searchable && input.requested.has(input.corpusId)
    && (!input.tierCorpusIds || input.tierCorpusIds.has(input.corpusId));
}

// Names are checked after the store visibility gate. A missing legacy row tier
// cannot establish a Personal name. Private names require the local Private probe.
export function admitsSearchName(input: {
  names: 'public_or_personal' | 'private' | 'secret' | 'unknown' | 'legacy';
  tier?: SourceTrustTier;
  domain: SourceTrustDomain;
  includePrivateNames: boolean;
  searchedPrivateStore: boolean;
  pendingDeletion?: boolean;
  gone?: boolean;
}): boolean {
  if (input.tier === 'S5' || input.names === 'secret' || input.names === 'unknown' || input.pendingDeletion
    || (!input.includePrivateNames && input.gone)) return false;
  if (input.names === 'public_or_personal' && input.tier !== undefined) return true;
  const privateName = input.tier === undefined || input.names === 'private' || input.domain === 'secure_local' || input.tier === 'S4' || input.tier === 'S4+';
  return !privateName || (input.includePrivateNames && input.searchedPrivateStore);
}

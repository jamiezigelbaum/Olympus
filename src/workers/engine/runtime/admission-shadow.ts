// Explicit diagnostic entry point. Its caller supplies facts and serving
// verdicts from the same observation. Nothing here opens a store or a grant.
import { isDeepStrictEqual } from 'node:util';
import { evaluate, mountedStoreFacts, type AdmissionContext, type AdmissionVerdict } from '../../../core/admission.ts';
import type { SourceAdmissionDefinition } from '../../../core/source-admission-definitions.ts';
import type { SourceCorpusConfig } from '../../../core/source-corpus-registry.ts';
import type { StoreEmbeddingScope } from '../../connector-store/embedding-plan.ts';
import type { EmbeddingReadScope } from '../../connector-store/embedding-scope.ts';
import type { ConnectorStoreSearchFilters, ConnectorStoreStatusScope } from '../../connector-store/local-index.ts';

type ScopeStage = 'search' | 'extract' | 'embed' | 'manual_embed' | 'count' | 'backlog';
interface Population {
  admitted: boolean;
  accountScope?: string | undefined;
  filters?: ConnectorStoreSearchFilters | undefined;
  contentAfter?: string | undefined;
  held?: boolean | undefined;
  queueStillEligible?: boolean;
}

function population(verdict: AdmissionVerdict, provider: string): Population {
  const scope = verdict.scope;
  if (!scope) return { admitted: verdict.admitted };
  const filters: ConnectorStoreSearchFilters = { provider };
  if (scope.generation) filters.sourceScopeGeneration = scope.generation;
  if (scope.revision) filters.sourceScopeRevision = scope.revision;
  if (scope.observedUnder) filters.observedConnectorId = scope.observedUnder;
  if (scope.previousObservedUnder) filters.previousObservedConnectorId = scope.previousObservedUnder;
  if (scope.importPrefix) filters.observedConnectorIdPrefix = scope.importPrefix;
  const paths = scope.matcher === 'path_prefix';
  if (scope.include) filters[paths ? 'locatorPathScopes' : 'sourceScopeFolderAnyKeys'] = scope.include;
  if (scope.exclude) filters[paths ? 'locatorPathExcludedScopes' : 'sourceScopeFolderNoneKeys'] = scope.exclude;
  if (scope.namesOnly) filters[paths ? 'metadataOnlyLocatorPathScopes' : 'metadataOnlySourceScopeFolderKeys'] = scope.namesOnly;
  return { admitted: verdict.admitted, accountScope: scope.accountScope, filters,
    contentAfter: scope.contentAfter, held: scope.excludeAllEmbeddingHolds };
}

export interface AdmissionDisagreement {
  corpusId: string;
  stage: ScopeStage | ReadStage;
  layer: AdmissionContext['layer'];
  serving: boolean;
  shadow: boolean;
  differingConstraints: string[];
  reason: string;
}

export function compareAdmissionScopes(input: {
  corpus: SourceCorpusConfig;
  definition: SourceAdmissionDefinition;
  ready: boolean;
  account: AdmissionContext['account'];
  readAuthority: AdmissionContext['authority'];
  processingAuthority: AdmissionContext['authority'];
  destination: AdmissionContext['destination'];
  canEmbedHeld: boolean;
  read: ReturnType<EmbeddingReadScope>;
  scheduled: StoreEmbeddingScope;
  manual: StoreEmbeddingScope;
  status: ConnectorStoreStatusScope;
  // The shared extraction queue's content check, when this corpus participates.
  extractionRead?: ReturnType<EmbeddingReadScope>;
  // Optional observations from completed reads. Ask has its own adapter and
  // hydration boundaries, so a search scope alone says nothing about its rows.
  reads?: readonly AdmissionReadObservation[];
}, log: (event: AdmissionDisagreement) => void = event => console.warn(JSON.stringify({ event: 'admission_disagreement', ...event }))): void {
  const { corpus, definition, read, status } = input;
  const facts = mountedStoreFacts(corpus, definition, input.ready);
  function compare(stage: ScopeStage, layer: AdmissionContext['layer'], serving: Population) {
    const processing = stage !== 'search' && stage !== 'extract';
    const verdict = evaluate({
      caller: 'owner', account: input.account, authority: processing ? input.processingAuthority : input.readAuthority,
      purpose: stage === 'backlog' || stage === 'manual_embed' ? 'embed' : stage, layer,
      destination: processing ? input.destination : 'device',
    }, facts);
    const expected = population(verdict, corpus.provider);
    if (stage === 'backlog') expected.held = input.canEmbedHeld && !verdict.scope?.excludeAllEmbeddingHolds;
    if (!serving.admitted && !expected.admitted && !serving.queueStillEligible) return;
    const actualFilters = serving.filters ?? {};
    const expectedFilters = expected.filters ?? {};
    const keys = new Set([...Object.keys(actualFilters), ...Object.keys(expectedFilters)] as (keyof ConnectorStoreSearchFilters)[]);
    const differingConstraints = [
      ...(serving.queueStillEligible && !expected.admitted ? ['skipQueue'] : []),
      ...(serving.accountScope !== expected.accountScope ? ['accountScope'] : []),
      ...(serving.contentAfter !== expected.contentAfter ? ['contentAfter'] : []),
      ...(!!serving.held !== !!expected.held ? ['holdPolicy'] : []),
      ...[...keys].filter(key => !isDeepStrictEqual(actualFilters[key], expectedFilters[key])),
    ];
    if (serving.admitted !== expected.admitted || differingConstraints.length) {
      log({ corpusId: corpus.corpusId, stage, layer, serving: serving.admitted, shadow: expected.admitted, reason: verdict.reason, differingConstraints });
    }
  }
  for (const layer of ['names', 'content'] as const) {
    const actual = read.allowed ? { admitted: layer === 'names' || read.contentAllowed === true, accountScope: read.accountScope,
      filters: layer === 'names' ? read.filters : read.contentFilters } : { admitted: false };
    compare('search', layer, actual);
    compare('count', layer, { admitted: status.itemsAllowed !== false && (layer === 'names' || status.contentAllowed !== false),
      accountScope: status.accountScope, filters: layer === 'names' ? status.itemFilters : status.contentFilters,
      contentAfter: layer === 'content' ? status.contentNotBefore : undefined });
  }
  if (input.extractionRead) {
    const read = input.extractionRead;
    compare('extract', 'content', read.allowed ? { admitted: read.contentAllowed === true, filters: read.contentFilters,
      accountScope: read.accountScope } : { admitted: false });
  }
  for (const [stage, scope] of [['embed', input.scheduled], ['manual_embed', input.manual]] as const) {
    compare(stage, 'content', scope.allowed ? { admitted: true, accountScope: scope.accountScope,
      filters: scope.filters, held: scope.excludeAllEmbeddingHolds } : { admitted: false, queueStillEligible: stage === 'embed' && !scope.skipQueue });
  }
  const backlog = status.embedding;
  compare('backlog', 'content', { admitted: backlog?.contentAllowed !== false, accountScope: backlog?.accountScope,
    filters: backlog?.contentFilters, held: backlog?.includeHeldForJudgment });
  for (const read of input.reads ?? []) compareAdmissionRead({ ...read, corpusId: corpus.corpusId }, log);
}

export type ReadStage = 'search' | 'answer' | 'deep_read' | 'preview' | 'people_index';

// Compare one fixture member at the delivery boundary. Identity travels with
// each value, so swapped titles/passages cannot pass by matching a bag of text.
// Never put the compared identities, names or passages in a diagnostic.
export interface AdmissionReadValue {
  identity: string;
  value: string | null;
}

interface AdmissionReadObservation {
  stage: ReadStage;
  layer: AdmissionContext['layer'];
  serving: readonly AdmissionReadValue[];
  shadow: readonly AdmissionReadValue[];
  reason: string;
}

export function compareAdmissionRead(input: AdmissionReadObservation & { corpusId: string },
  log: (event: AdmissionDisagreement) => void): void {
  const { corpusId, stage, layer, serving, shadow, reason } = input;
  const keys = (rows: readonly AdmissionReadValue[]) => rows.map(row => row.identity).sort();
  const values = (rows: readonly AdmissionReadValue[]) => rows.map(row => JSON.stringify([row.identity, row.value])).sort();
  const differingConstraints: string[] = [];
  if (!isDeepStrictEqual(keys(serving), keys(shadow))) differingConstraints.push('identity');
  if (!isDeepStrictEqual(values(serving), values(shadow))) differingConstraints.push(layer === 'names' ? 'name' : 'text');
  if (differingConstraints.length) log({ corpusId, stage, layer, reason, serving: serving.length > 0,
    shadow: shadow.length > 0, differingConstraints });
}

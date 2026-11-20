import { AsyncLocalStorage } from 'node:async_hooks';

export type KeywordExpansionMap = ReadonlyMap<string, readonly string[]>;
const context = new AsyncLocalStorage<{ query: string; alternatives: KeywordExpansionMap }>();
const disabled = new AsyncLocalStorage<boolean>();
export function withKeywordExpansionDisabled<T>(run: () => T): T { return disabled.run(true,run); }
export function keywordExpansionDisabled(): boolean { return disabled.getStore() === true; }

/**
 * A caller that must not wait on the local model (the Private-match probe:
 * source-index/analyst-answer.ts probePrivateMatch). Inside this scope a
 * translation is used only if it is already finished, else the static
 * equivalents alone; no model call is started or awaited. `missing` says
 * whether a translation would have been asked of the model, so the caller can
 * tell "nothing matched" from "not everything was searched".
 */
export interface CachedKeywordExpansion { missing: boolean }
const cachedOnly = new AsyncLocalStorage<CachedKeywordExpansion>();
export function withCachedKeywordExpansion<T>(state: CachedKeywordExpansion, run: () => T): T { return cachedOnly.run(state, run); }
export function cachedKeywordExpansion(): CachedKeywordExpansion | undefined { return cachedOnly.getStore(); }

const requestContext = new AsyncLocalStorage<{
  keywords?: Map<object, Map<string, KeywordExpansionMap>>;
  vectorDeferred: Map<object, boolean>;
}>();

export function withVectorSearchRequestScope<T>(run: () => T): T {
  return requestContext.getStore() ? run() : requestContext.run({ vectorDeferred: new Map() }, run);
}

export function withKeywordRequestScope<T>(run: () => T): T {
  const scope = requestContext.getStore();
  return scope?.keywords ? run() : requestContext.run({ keywords: new Map(), vectorDeferred: scope?.vectorDeferred ?? new Map() }, run);
}
export function requestKeywordAlternatives(owner: object | undefined, query: string): KeywordExpansionMap | undefined {
  return owner ? requestContext.getStore()?.keywords?.get(owner)?.get(query) : undefined;
}
export function pinKeywordAlternatives(owner: object | undefined, query: string, alternatives: KeywordExpansionMap): void {
  const request = requestContext.getStore()?.keywords;
  if (!owner || !request) return;
  let queries = request.get(owner);
  if (!queries) { queries = new Map(); request.set(owner, queries); }
  queries.set(query, alternatives);
}
// Pin even a ready store: every query and passage read uses the first decision.
export function requestVectorSearchDeferred(owner: object, read: () => boolean): boolean {
  const decisions = requestContext.getStore()?.vectorDeferred;
  const pinned = decisions?.get(owner);
  if (pinned !== undefined) return pinned;
  const deferred = read();
  decisions?.set(owner, deferred);
  return deferred;
}

export function keywordAlternatives(query: string): KeywordExpansionMap | undefined {
  if (keywordExpansionDisabled()) return undefined;
  const current = context.getStore();
  return current?.query === query ? current.alternatives : undefined;
}
export function withKeywordAlternatives<T>(query: string, alternatives: KeywordExpansionMap, run: () => T): T {
  return context.run({ query, alternatives }, run);
}

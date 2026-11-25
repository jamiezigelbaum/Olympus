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
  pinned: Map<object, Map<string, KeywordExpansionMap>>;
  lifetime: AbortController;
}>();

/** A routed search can keep the outer request's pinned terms with its own cancellation boundary. */
export async function withKeywordRequestScope<T>(run: () => T, newLifetime = false): Promise<Awaited<T>> {
  const current = requestContext.getStore();
  if (current && !newLifetime) return await run();
  const lifetime = new AbortController();
  try {
    return await requestContext.run({ pinned: current?.pinned ?? new Map(), lifetime }, run);
  } finally {
    lifetime.abort();
  }
}
export function keywordRequestSignal(): AbortSignal | undefined { return requestContext.getStore()?.lifetime.signal; }
export function requestKeywordAlternatives(owner: object | undefined, query: string): KeywordExpansionMap | undefined {
  return owner ? requestContext.getStore()?.pinned.get(owner)?.get(query) : undefined;
}
export function pinKeywordAlternatives(owner: object | undefined, query: string, alternatives: KeywordExpansionMap): void {
  const request = requestContext.getStore()?.pinned;
  if (!owner || !request) return;
  let queries = request.get(owner);
  if (!queries) { queries = new Map(); request.set(owner, queries); }
  queries.set(query, alternatives);
}
export function keywordAlternatives(query: string): KeywordExpansionMap | undefined {
  if (keywordExpansionDisabled()) return undefined;
  const current = context.getStore();
  return current?.query === query ? current.alternatives : undefined;
}
export function withKeywordAlternatives<T>(query: string, alternatives: KeywordExpansionMap, run: () => T): T {
  return context.run({ query, alternatives }, run);
}

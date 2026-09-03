import type {
  RetrievalDegradation,
  RetrievalLaneAudit,
  SourceFamily,
  SourceIndexCandidateId,
  SourceIndexProvenance,
  SourceItemIdentity,
  SourceTrustDomain,
} from './types.ts';
import type {
  SourceIndexCorpusDefinition,
  SourceIndexCorpusRegistry,
  SourceIndexCorpusSelection,
} from './corpus.ts';
import {
  assessSourceIndexRetrievalState,
  fuseRankedCandidateLanes,
  mergeRetrievalDegradations,
  sourceIndexRetrievalStateLaneAudit,
  type FusedRankedCandidate,
  type SourceIndexHybridAvailability,
  type SourceIndexRetrievalState,
} from './retrieval.ts';
import {
  recordSourceAnswerCorpusTiming,
  sourceAnswerTraceErrorClass,
} from '../../workers/source-index/answer-latency-trace.ts';

export interface SourceIndexSearchContext {
  allowedTrustDomains: readonly SourceTrustDomain[];
  allowCloudQueries?: boolean;
  allowedCorpusIds?: readonly string[];
}

export interface SourceIndexSearchRequest {
  query: string;
  maxResults: number;
  context: SourceIndexSearchContext;
  corpusIds?: readonly string[];
  families?: readonly SourceFamily[];
}

export interface SourceIndexCorpusSearchRequest {
  query: string;
  maxResults: number;
  corpus: SourceIndexCorpusDefinition;
  context: SourceIndexSearchContext;
  /**
   * Cooperative deadline for CPU-bound local adapters. The router still owns
   * the authoritative Promise deadline; this earlier timestamp lets an exact
   * scan stop and return its keyword lane before it can block the event loop
   * long enough to prevent the authoritative timer from firing.
   */
  deadlineAtMs?: number;
}

export interface SourceIndexSearchHit {
  sourceItem: SourceItemIdentity;
  provenance?: SourceIndexProvenance;
  internalContent?: SourceIndexInternalContent;
  candidateId?: SourceIndexCandidateId;
  score?: number;
  laneAudits?: readonly RetrievalLaneAudit[];
  rawExposed: false;
}

export interface SourceIndexInternalContent {
  kind: 'bounded_item_passage';
  passage: string;
  passageChars: number;
  truncated: boolean;
  sourceTextReturned: true;
  url?: string;
  creatorHandle?: string;
  creatorName?: string;
  collectionNames?: readonly string[];
  authoredAt?: string;
  savedAt?: string;
}

export interface SourceIndexCorpusSearchResponse {
  hits: readonly SourceIndexSearchHit[];
  latencyMs: number;
  laneAudits?: readonly RetrievalLaneAudit[];
  rawExposed: false;
}

export interface SourceIndexCorpusSearchAdapter {
  (request: SourceIndexCorpusSearchRequest): SourceIndexCorpusSearchResponse | Promise<SourceIndexCorpusSearchResponse>;
  hybridAvailability?: (request: SourceIndexCorpusSearchRequest) => SourceIndexHybridAvailability;
}

export function withSourceIndexHybridAvailability(
  adapter: SourceIndexCorpusSearchAdapter,
  resolve: NonNullable<SourceIndexCorpusSearchAdapter['hybridAvailability']>,
): SourceIndexCorpusSearchAdapter {
  adapter.hybridAvailability = resolve;
  return adapter;
}

export interface SourceIndexRouterAdapterMap {
  readonly [corpusId: string]: SourceIndexCorpusSearchAdapter | undefined;
}

export interface SourceIndexRoutedSearchHit extends SourceIndexSearchHit {
  corpusId: string;
  trustDomain: SourceTrustDomain;
}

export interface SourceIndexSkippedCorpus {
  corpusId: string;
  trustDomain: SourceTrustDomain;
  reason: SourceIndexSkippedCorpusReason;
}

export type SourceIndexSkippedCorpusReason =
  | 'not_requested'
  | 'trust_domain_not_allowed'
  | 'corpus_not_allowed'
  | 'cloud_query_not_allowed'
  | 'no_adapter'
  | 'lane_timeout';

export interface SourceIndexRoutedSearchResponse {
  hits: readonly SourceIndexRoutedSearchHit[];
  searchedCorpora: readonly string[];
  skippedCorpora: readonly SourceIndexSkippedCorpus[];
  laneAudits: readonly RetrievalLaneAudit[];
  // Counts-only markers for every lane that did NOT contribute to this
  // response. skippedCorpora already lists deliberate scoping decisions; this
  // list carries only the losses a caller could otherwise mistake for "there
  // was nothing to find", which is the whole point of separating them.
  degradations: readonly RetrievalDegradation[];
  corpusTimings: readonly SourceIndexRoutedCorpusTiming[];
  latencyMs: number;
  rawExposed: false;
}

export interface SourceIndexRoutedCorpusTiming {
  corpusId: string;
  elapsedMs: number;
  adapterReportedMs?: number;
  outcome: 'success' | 'timeout';
}

export interface RouteSourceIndexSearchOptions {
  registry: SourceIndexCorpusRegistry;
  adapters: SourceIndexRouterAdapterMap;
  request: SourceIndexSearchRequest;
  // Per-lane retrieval deadline for the evidence-pack fan-out. A corpus adapter
  // that does not settle within this budget is DROPPED from the pack and
  // reported in skippedCorpora with reason 'lane_timeout', so one slow corpus
  // (e.g. a multi-GB keyword index under write contention) can no longer hold
  // the whole source_answer hostage — total fan-out time is bounded by this
  // budget. Defaults to OLYMPUS_SOURCE_ANSWER_LANE_TIMEOUT_MS, or 10s when
  // unset. A non-positive / non-finite value disables the deadline (unbounded
  // lanes — the pre-deadline behavior).
  laneTimeoutMs?: number;
}

// Default per-lane retrieval deadline (ms).
//
// 10s is not a round number picked for feel — it is the SQLite busy_timeout
// every store in this repo opens with (`PRAGMA busy_timeout = 10000`). That
// makes it a floor, not a preference: a lane whose only problem is waiting
// behind the single writer resolves within busy_timeout, so any deadline
// SHORTER than busy_timeout would drop lanes that were about to succeed and
// report contention as loss. Lower this only in lockstep with that pragma.
//
// Headroom against measured healthy latency, re-checked 2026-07-28:
//   keyword FTS       tens of ms on every live corpus
//   semantic (vector) ~1.3s on the largest live corpus (170,721 vectors) after
//                     the decodeEmbedding boxing fix; it was ~17.5s before,
//                     which is why hybrid answers used to lose this race
// so a healthy fan-out finishes with roughly 7x headroom, and the deadline
// binds only on genuine contention or a wedge.
//
// Exact-vector adapters receive a cooperative deadline just inside this
// authoritative timer. That lets CPU-bound scans yield or stop before they can
// monopolize the event loop and prevent the timer itself from firing.
const DEFAULT_SOURCE_ANSWER_LANE_TIMEOUT_MS = 10_000;
const COOPERATIVE_LANE_DEADLINE_HEADROOM_MS = 50;

const FORBIDDEN_ROUTER_RESULT_KEYS = new Set([
  'body',
  'bodies',
  'content',
  'contents',
  'message',
  'messages',
  'raw',
  'raw_packet',
  'rawPacket',
  'raw_source',
  'rawSource',
  'sanitized_text',
  'sanitizedText',
  'snippet',
  'snippets',
  'source_text',
  'sourceText',
  'raw_source_text',
  'rawSourceText',
  'text',
  'access_token',
  'accessToken',
  'api_key',
  'apiKey',
  'approved_scope_key',
  'approvedScopeKey',
  'refresh_token',
  'refreshToken',
  'token',
]);
const NORMALIZED_FORBIDDEN_ROUTER_RESULT_KEYS = new Set(
  [...FORBIDDEN_ROUTER_RESULT_KEYS].map(normalizeRouterResultKey),
);

export async function routeSourceIndexSearch(options: RouteSourceIndexSearchOptions): Promise<SourceIndexRoutedSearchResponse> {
  const request = normalizeSearchRequest(options.request);
  const candidateCorpora = options.registry.list();
  const skippedCorpora: SourceIndexSkippedCorpus[] = [];
  const searchedCorpora: string[] = [];
  const laneAudits: RetrievalLaneAudit[] = [];
  const degradations: RetrievalDegradation[] = [];
  const corpusTimings: SourceIndexRoutedCorpusTiming[] = [];
  const lanes: Array<{ name: string; items: SourceIndexRoutedSearchHit[] }> = [];
  const startedAt = Date.now();

  const searchableCorpora: SourceIndexCorpusDefinition[] = [];
  for (const corpus of candidateCorpora) {
    const skipReason = skipReasonForCorpus(corpus, request);
    if (skipReason) {
      skippedCorpora.push({ corpusId: corpus.corpusId, trustDomain: corpus.trustDomain, reason: skipReason });
      continue;
    }

    const adapter = options.adapters[corpus.corpusId];
    if (!adapter) {
      skippedCorpora.push({ corpusId: corpus.corpusId, trustDomain: corpus.trustDomain, reason: 'no_adapter' });
      // In scope, allowed, and still unsearchable: a wiring loss, not a policy
      // decision, so it belongs in the degradation list as well as the skips.
      degradations.push({
        laneName: corpus.corpusId,
        laneType: 'keyword',
        reason: 'lane_no_adapter',
        occurrences: 1,
      });
      continue;
    }

    searchableCorpora.push(corpus);
  }

  const laneTimeoutMs = resolveLaneTimeoutMs(options.laneTimeoutMs);
  const laneOutcomes = await Promise.all(searchableCorpora.map(async (corpus) => {
    const adapter = options.adapters[corpus.corpusId]!;
    const cooperativeDeadlineAtMs = cooperativeLaneDeadlineAtMs(laneTimeoutMs);
    const corpusRequest: SourceIndexCorpusSearchRequest = {
      query: request.query,
      maxResults: request.maxResults,
      corpus,
      context: request.context,
      ...(cooperativeDeadlineAtMs !== undefined ? { deadlineAtMs: cooperativeDeadlineAtMs } : {}),
    };
    const retrievalState = retrievalStateForAdapter(adapter, corpusRequest);
    const outcome = await runCorpusLaneWithDeadline(
      () => adapter(corpusRequest),
      laneTimeoutMs,
      corpus.corpusId,
    );
    return { corpus, outcome, retrievalState };
  }));

  for (const { corpus, outcome, retrievalState } of laneOutcomes) {
    if (outcome.kind === 'timeout') {
      // A lane that blew the deadline is dropped and reported honestly; the
      // answer proceeds with whichever lanes made it. No silent degradation.
      skippedCorpora.push({ corpusId: corpus.corpusId, trustDomain: corpus.trustDomain, reason: 'lane_timeout' });
      degradations.push({
        laneName: corpus.corpusId,
        laneType: 'keyword',
        reason: 'lane_timeout',
        occurrences: 1,
      });
      corpusTimings.push({
        corpusId: corpus.corpusId,
        elapsedMs: outcome.elapsedMs,
        outcome: 'timeout',
      });
      continue;
    }
    const response = outcome.response;
    corpusTimings.push({
      corpusId: corpus.corpusId,
      elapsedMs: outcome.elapsedMs,
      adapterReportedMs: response.latencyMs,
      outcome: 'success',
    });
    searchedCorpora.push(corpus.corpusId);
    laneAudits.push(...(response.laneAudits ?? []));
    if (corpus.activationMode !== 'lexical_only') {
      laneAudits.push(sourceIndexRetrievalStateLaneAudit({
        corpusId: corpus.corpusId,
        localOnly: corpus.storageProfile.placement === 'local_private',
        state: retrievalState,
      }));
      const semanticLoss = semanticLaneDegradation(corpus.corpusId, retrievalState, response);
      if (semanticLoss) degradations.push(semanticLoss);
    }
    lanes.push({
      name: corpus.corpusId,
      items: response.hits.map((hit) => ({
        ...hit,
        corpusId: corpus.corpusId,
        trustDomain: corpus.trustDomain,
      })),
    });
  }

  // Lane declaration order — registry.list() preserves the order the corpora
  // were registered in, which deliberately interleaves trust domains. It is the
  // one ordering available here that is neither adapter-scale-derived nor
  // spelling-derived, so it is what the tie-break falls back on.
  const laneOrder = new Map(lanes.map((lane, index) => [lane.name, index] as const));
  const fused = applyPerCorpusResultBudget(
    fuseRankedCandidateLanes({
      lanes,
      getId: routedHitCandidateId,
      // Fuse everything and let the per-corpus budget below make the cut. A
      // slice at maxResults hands the entire cross-corpus decision to the
      // tie-break, which is how one comparator could erase whole corpora.
      limit: lanes.reduce((total, lane) => total + lane.items.length, 0),
      // Scale-free, and load-bearing here in a way it is nowhere else. The
      // candidate id is corpus-scoped, so no candidate is ever in two lanes and
      // every candidate carries exactly one lane's 1/(k+rank): each rank tier is
      // a full tie across corpora, and the tie-break IS the cross-corpus ranking
      // function. Adapter `score` carries no scale contract — a negated bm25 rank
      // in one corpus (~8), a sub-lane RRF sum in another (~0.016) — so comparing
      // it ordered corpora by scoring convention, sinking a whole family below
      // every bm25 hit in every tier. With maxResults 3 against the mounted
      // corpora that cut the family out of the analyst's evidence entirely, with
      // nothing in coverage to record the loss. Ordering the tie by corpus id
      // instead only re-keyed the same loss to spelling: 'i' < 's', so every
      // secure_local corpus lost to every internal one on every query forever.
      tieBreaker: (left, right) => compareTiedRoutedCandidates(left, right, laneOrder),
    }),
    request.maxResults,
  );

  // A corpus that searched successfully, returned hits, and still put nothing
  // in the response is a real loss with nowhere else to show up: it is in
  // searchedCorpora and it is correctly absent from skippedCorpora, which
  // records scoping decisions rather than budget outcomes. A caller that asked
  // for zero results lost nothing to a budget, so that case is not a loss.
  if (request.maxResults > 0) {
    for (const lane of lanes) {
      if (lane.items.length === 0) continue;
      if (fused.some((hit) => hit.corpusId === lane.name)) continue;
      degradations.push({
        laneName: lane.name,
        laneType: 'keyword',
        reason: 'lane_budget_cut',
        occurrences: 1,
      });
    }
  }

  const result: SourceIndexRoutedSearchResponse = {
    hits: fused,
    searchedCorpora,
    skippedCorpora,
    laneAudits,
    degradations: mergeRetrievalDegradations(degradations),
    corpusTimings,
    latencyMs: Date.now() - startedAt,
    rawExposed: false,
  };
  assertSafeRoutedSearchResponse(result);
  return result;
}

/**
 * Order two candidates the RRF sum could not separate.
 *
 * Ranked by how much retrieval evidence each candidate actually carries, and
 * only then by anything positional:
 *
 *   1. best single-lane rank — the strongest placement any one lane gave it;
 *   2. lane count — a candidate two lanes found beats one only one lane found;
 *   3. lane declaration order — corpus-neutral in the sense that matters: it
 *      does not read the corpus NAME, so renaming a corpus cannot change which
 *      families reach the analyst;
 *   4. corpus id, then candidate id — the final resort, present only so the
 *      comparator is total and two runs of the same query fuse identically.
 *
 * In today's router wiring 1 and 2 are degenerate (one lane per corpus, so an
 * equal RRF sum means an equal rank), and that is deliberate: they are what
 * keeps this comparator correct if a future adapter ever emits a candidate id
 * that two corpora share, instead of silently falling through to position.
 */
function compareTiedRoutedCandidates(
  left: FusedRankedCandidate<SourceIndexRoutedSearchHit>,
  right: FusedRankedCandidate<SourceIndexRoutedSearchHit>,
  laneOrder: ReadonlyMap<string, number>,
): number {
  const bestRank = bestLaneRank(left) - bestLaneRank(right);
  if (bestRank !== 0) return bestRank;
  const laneCount = right.laneRanks.size - left.laneRanks.size;
  if (laneCount !== 0) return laneCount;
  const position = laneIndex(laneOrder, left.item.corpusId) - laneIndex(laneOrder, right.item.corpusId);
  if (position !== 0) return position;
  const corpus = left.item.corpusId.localeCompare(right.item.corpusId);
  if (corpus !== 0) return corpus;
  return String(left.id).localeCompare(String(right.id));
}

function bestLaneRank(candidate: FusedRankedCandidate<SourceIndexRoutedSearchHit>): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const rank of candidate.laneRanks.values()) {
    if (rank < best) best = rank;
  }
  return best;
}

function laneIndex(laneOrder: ReadonlyMap<string, number>, corpusId: string): number {
  return laneOrder.get(corpusId) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Spend the caller's result budget across corpora rather than down the fused
 * list, keeping the fused order of whatever survives.
 *
 * Each corpus is seated once, best candidate first, before any corpus is seated
 * twice. When the budget is smaller than the number of corpora that returned
 * hits, the corpora that do get seated are the ones whose best candidate fused
 * highest — never the ones whose names sort first. Corpora that get no seat at
 * all are reported by the caller as a `lane_budget_cut` degradation.
 */
function applyPerCorpusResultBudget(
  ranked: readonly FusedRankedCandidate<SourceIndexRoutedSearchHit>[],
  budget: number,
): SourceIndexRoutedSearchHit[] {
  if (budget <= 0) return [];
  if (ranked.length <= budget) return ranked.map((candidate) => candidate.item);

  const byCorpus = new Map<string, FusedRankedCandidate<SourceIndexRoutedSearchHit>[]>();
  for (const candidate of ranked) {
    const bucket = byCorpus.get(candidate.item.corpusId);
    if (bucket) bucket.push(candidate);
    else byCorpus.set(candidate.item.corpusId, [candidate]);
  }

  const seated = new Set<SourceIndexCandidateId>();
  for (let round = 0; seated.size < budget; round += 1) {
    let seatedThisRound = false;
    for (const bucket of byCorpus.values()) {
      const candidate = bucket[round];
      if (!candidate) continue;
      seated.add(candidate.id);
      seatedThisRound = true;
      if (seated.size >= budget) break;
    }
    if (!seatedThisRound) break;
  }

  return ranked.filter((candidate) => seated.has(candidate.id)).map((candidate) => candidate.item);
}

/**
 * The semantic lane's honesty check, run against what the corpus adapter
 * actually returned rather than what it declared it could do.
 *
 * Two different losses, and conflating them is what made this invisible:
 *
 *   unservable — the corpus declares a semantic lane and cannot currently
 *                serve one (no current embeddings, provider not allowed for
 *                the trust domain, capability unreported). The enforcement
 *                lane audit already carries the reason; this restates it as a
 *                counts-only marker so it merges across fan-outs.
 *   not_run    — the corpus CAN serve the lane and this query did not run it.
 *                That is the default posture today: every corpus is wired
 *                retrieval_mode 'keyword' and semantic is opt-in, so a
 *                hybrid-capable corpus answers lexically while its enforcement
 *                audit reads "hybrid / ready". Without this marker a caller
 *                reading that audit would conclude the semantic lane ran.
 *
 * The evidence for "ran" is a lane audit of semantic or hybrid type in the
 * adapter's own response — the adapter cannot claim a lane it did not audit.
 */
function semanticLaneDegradation(
  corpusId: string,
  state: SourceIndexRetrievalState,
  response: SourceIndexCorpusSearchResponse,
): RetrievalDegradation | undefined {
  if (state.health === 'degraded') {
    return {
      laneName: `${corpusId}:semantic`,
      laneType: 'semantic',
      reason: 'semantic_lane_unservable',
      ...(state.reason ? { detail: state.reason } : {}),
      occurrences: 1,
    };
  }
  const laneAudits = response.laneAudits ?? [];
  const skippedSemantic = laneAudits.find(
    (audit) => audit.laneType === 'semantic'
      && audit.skippedReason !== undefined
      // This reason means the semantic lane ran successfully and found no
      // evidence above the relevance floor. It is an answer, not an outage.
      && audit.skippedReason !== 'semantic_below_relevance_bar',
  );
  if (skippedSemantic?.skippedReason) {
    return {
      laneName: `${corpusId}:semantic`,
      laneType: 'semantic',
      reason: 'semantic_lane_skipped',
      detail: skippedSemantic.skippedReason,
      occurrences: 1,
    };
  }
  const ranSemantic = laneAudits.some(
    (audit) => audit.laneType === 'semantic' || audit.laneType === 'hybrid',
  );
  if (ranSemantic) return undefined;
  return {
    laneName: `${corpusId}:semantic`,
    laneType: 'semantic',
    reason: 'semantic_lane_not_run',
    occurrences: 1,
  };
}

function retrievalStateForAdapter(
  adapter: SourceIndexCorpusSearchAdapter,
  request: SourceIndexCorpusSearchRequest,
): SourceIndexRetrievalState {
  let hybridAvailability: SourceIndexHybridAvailability | undefined;
  try {
    hybridAvailability = adapter.hybridAvailability?.(request);
  } catch {
    hybridAvailability = { servable: false, reason: 'hybrid_capability_unreported' };
  }
  return assessSourceIndexRetrievalState({
    declaredMode: request.corpus.activationMode,
    ...(hybridAvailability ? { hybridAvailability } : {}),
  });
}

function normalizeSearchRequest(request: SourceIndexSearchRequest): SourceIndexSearchRequest {
  const query = request.query.trim();
  if (!query) {
    throw new Error('Source-index routed search requires a non-empty query.');
  }
  if (!Number.isFinite(request.maxResults) || request.maxResults < 0) {
    throw new Error('Source-index routed search maxResults must be a non-negative number.');
  }
  return {
    ...request,
    query,
    maxResults: Math.floor(request.maxResults),
  };
}

type CorpusLaneOutcome =
  | { kind: 'response'; response: SourceIndexCorpusSearchResponse; elapsedMs: number }
  | { kind: 'timeout'; elapsedMs: number };

// Race a single corpus adapter against the per-lane deadline. The safety
// assertion runs on the winning response exactly as before, so a lane that
// returns forbidden raw fields still fails the whole search (a real error is
// not the same as a slow lane). Crucially, when the deadline wins the race the
// lane's own promise is still fully observed (laneSettled never rejects), so a
// dropped lane that later rejects or resolves can never surface as an unhandled
// rejection or dangling throw.
async function runCorpusLaneWithDeadline(
  run: () => SourceIndexCorpusSearchResponse | Promise<SourceIndexCorpusSearchResponse>,
  timeoutMs: number,
  corpusId: string,
): Promise<CorpusLaneOutcome> {
  const startedAt = Date.now();
  const runValidated = async (): Promise<SourceIndexCorpusSearchResponse> => {
    const response = await run();
    assertSafeCorpusSearchResponse(response);
    return response;
  };

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    try {
      const response = await runValidated();
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      recordSourceAnswerCorpusTiming({
        corpus_id: corpusId,
        elapsed_ms: elapsedMs,
        adapter_reported_ms: response.latencyMs,
        outcome: 'success',
      });
      return { kind: 'response', response, elapsedMs };
    } catch (error) {
      recordSourceAnswerCorpusTiming({
        corpus_id: corpusId,
        elapsed_ms: Math.max(0, Date.now() - startedAt),
        outcome: 'error',
        error_class: sourceAnswerTraceErrorClass(error),
      });
      throw error;
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const laneSettled: Promise<
    { kind: 'response'; response: SourceIndexCorpusSearchResponse } | { kind: 'error'; error: unknown }
  > = runValidated().then(
    (response) => ({ kind: 'response' as const, response }),
    (error) => ({ kind: 'error' as const, error }),
  );
  const deadline = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' as const }), timeoutMs);
  });

  try {
    const settled = await Promise.race([laneSettled, deadline]);
    if (settled.kind === 'timeout') {
      // Dropped lane: swallow whatever it eventually does, content-free, so it
      // never throws unhandled after we have already moved on.
      void laneSettled.then((late) => {
        if (late.kind === 'error') {
          console.error(
            `[source-index-router] lane=${corpusId} outcome=late_error error_class=${sourceAnswerTraceErrorClass(late.error)}`,
          );
        }
      });
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      recordSourceAnswerCorpusTiming({
        corpus_id: corpusId,
        elapsed_ms: elapsedMs,
        outcome: 'timeout',
      });
      return { kind: 'timeout', elapsedMs };
    }
    if (settled.kind === 'error') {
      recordSourceAnswerCorpusTiming({
        corpus_id: corpusId,
        elapsed_ms: Math.max(0, Date.now() - startedAt),
        outcome: 'error',
        error_class: sourceAnswerTraceErrorClass(settled.error),
      });
      throw settled.error;
    }
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    recordSourceAnswerCorpusTiming({
      corpus_id: corpusId,
      elapsed_ms: elapsedMs,
      adapter_reported_ms: settled.response.latencyMs,
      outcome: 'success',
    });
    return { kind: 'response', response: settled.response, elapsedMs };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveLaneTimeoutMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.OLYMPUS_SOURCE_ANSWER_LANE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_SOURCE_ANSWER_LANE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_SOURCE_ANSWER_LANE_TIMEOUT_MS;
  // parsed <= 0 is honored as "disable the deadline" by runCorpusLaneWithDeadline.
  return parsed;
}

function cooperativeLaneDeadlineAtMs(timeoutMs: number): number | undefined {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return Date.now() + Math.max(1, timeoutMs - COOPERATIVE_LANE_DEADLINE_HEADROOM_MS);
}

function skipReasonForCorpus(
  corpus: SourceIndexCorpusDefinition,
  request: SourceIndexSearchRequest,
): SourceIndexSkippedCorpusReason | undefined {
  if (!corpusMatchesRequestedSelection(corpus, request)) return 'not_requested';
  if (!request.context.allowedTrustDomains.includes(corpus.trustDomain)) return 'trust_domain_not_allowed';
  if (request.context.allowedCorpusIds && !request.context.allowedCorpusIds.includes(corpus.corpusId)) return 'corpus_not_allowed';
  if (corpus.storageProfile.cloudQueryEligible && request.context.allowCloudQueries !== true) return 'cloud_query_not_allowed';
  return undefined;
}

function corpusMatchesRequestedSelection(corpus: SourceIndexCorpusDefinition, selection: SourceIndexCorpusSelection): boolean {
  if (selection.corpusIds && !selection.corpusIds.includes(corpus.corpusId)) return false;
  if (selection.families && !selection.families.includes(corpus.family)) return false;
  return true;
}

function routedHitCandidateId(hit: SourceIndexRoutedSearchHit): SourceIndexCandidateId {
  return hit.candidateId ?? `${hit.corpusId}:${hit.sourceItem.localItemId || hit.sourceItem.providerItemId}`;
}

function assertSafeCorpusSearchResponse(response: SourceIndexCorpusSearchResponse): void {
  if (response.rawExposed !== false) {
    throw new Error('Source-index corpus adapter reported raw source exposure.');
  }
  for (const hit of response.hits) {
    if (hit.rawExposed !== false) {
      throw new Error('Source-index corpus adapter returned a hit with raw source exposure.');
    }
  }
  assertNoForbiddenRouterResultKeys(response, []);
}

function assertSafeRoutedSearchResponse(response: SourceIndexRoutedSearchResponse): void {
  if (response.rawExposed !== false) {
    throw new Error('Source-index router reported raw source exposure.');
  }
  assertNoForbiddenRouterResultKeys(response, []);
}

function assertNoForbiddenRouterResultKeys(value: unknown, path: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenRouterResultKeys(item, [...path, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (NORMALIZED_FORBIDDEN_ROUTER_RESULT_KEYS.has(normalizeRouterResultKey(key))) {
      const location = [...path, key].join('.');
      throw new Error(`Source-index routed search output included forbidden raw field "${location}".`);
    }
    assertNoForbiddenRouterResultKeys(child, [...path, key]);
  }
}

function normalizeRouterResultKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

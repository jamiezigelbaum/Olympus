import { isSourceIndexLaneBusyError } from './lane-busy.ts';
import { RECENT_ITEMS_CUT_SHORT, VISIBILITY_CHECK_CUT_SHORT } from './partial-search.ts';
import { withKeywordRequestScope } from './keyword-context.ts';
import type {
  RetrievalDegradation,
  RetrievalLaneAudit,
  SourceFamily,
  SourceIndexCandidateId,
  SourceIndexProvenance,
  SourceItemIdentity,
  SourceTrustDomain,
  SourceTrustTier,
} from './types.ts';
import { isSecureSensitivity } from './types.ts';
import type {
  SourceIndexCorpusDefinition,
  SourceIndexCorpusRegistry,
  SourceIndexCorpusSelection,
} from './corpus.ts';
import {
  applyPerCorpusResultBudget,
  applyStrengthPoolBudget,
  RESERVED_LEADER_MIN_CONCEPT_SHARE,
  withReservedLeaderSeats,
  withReservedRecencySeats,
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
  recordSourceAnswerQueryStages,
  runInSourceAnswerLane,
  sourceAnswerTraceErrorClass,
} from '../../workers/source-index/answer-latency-trace.ts';

export interface SourceIndexSearchContext {
  allowedTrustDomains: readonly SourceTrustDomain[];
  allowCloudQueries?: boolean;
  allowedCorpusIds?: readonly string[];
  /**
   * Metadata only: each corpus answers through its adapter's metadataMatches,
   * which reads no item text; a corpus whose adapter has none is skipped as
   * metadata_search_unsupported (never searched the ordinary way).
   */
  metadataOnly?: boolean;
  /**
   * With metadataOnly: match on the words alone. A corpus does not run its
   * meaning (vector) lane, so no question is embedded; whatever matched is
   * part of what the full metadata match returns.
   */
  lexicalOnly?: boolean;
}

export interface SourceIndexSearchRequest {
  query: string;
  maxResults: number;
  context: SourceIndexSearchContext;
  corpusIds?: readonly string[];
  families?: readonly SourceFamily[];
  // The question asks for what is new ("did I just get...", "latest"):
  // chat stores' pinned newest messages take the recency seats
  // (withReservedRecencySeats). Decided by the caller's existing heuristic.
  temporalIntent?: boolean;
  // A reranker pool (evidence-pack): seat every store's leader, then go deep
  // in the strongest stores first, up to storeDepth of each store's own ranks
  // (applyStrengthPoolBudget). Absent: stores share seats in even turns.
  poolAllocation?: { storeDepth: number };
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
  // The item's own tier, when the adapter knows it (a connector store row's
  // tier). Internal: the router reads it before any filter or trim to decide
  // encounteredSecureLocal, and the evidence build uses it when no content
  // provider answers for the item. Search routes never return it.
  trustTier?: SourceTrustTier;
  // Internal: the hit is one of its store's keyword leaders (the lane's
  // rank-1 row, its best name match, or both), with its share of the
  // question's concepts. The router keeps the best leaders across stores in
  // the pack (withReservedLeaderSeats). Search routes never return it.
  keywordLeader?: SourceIndexKeywordLeaderSignal;
  // Internal: the hit is one of its chat store's newest messages, pinned into
  // the store's cut (1 = newest). A question with temporal intent seats them
  // in the pack (withReservedRecencySeats). Search routes never return it.
  newestInStore?: number;
  // Internal: the pinned message was not among the store's ranked hits and
  // was appended to the cut, so a smaller cut places it again (eval pool
  // replay, laneAtDepth). Search routes never return it.
  pinAppended?: true;
  rawExposed: false;
}

export interface SourceIndexKeywordLeaderSignal {
  kinds: ReadonlyArray<'keyword_first' | 'name'>;
  // Concepts matched over the question's concept groups, 0 to 1.
  conceptShare: number;
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
  /**
   * How many items in this corpus matched the query, beyond the hits returned.
   * Counts only; an adapter that cannot count omits it.
   */
  matchCount?: SourceIndexCorpusMatchCount;
  /**
   * A lane the adapter should have run did not complete (a semantic lane
   * whose query embedding, vectors or deadline failed): the hits are what
   * the lanes that did run found, and an empty result is not a "no".
   * Set by metadataMatches; ordinary searches report the same loss in their
   * lane audits.
   */
  incomplete?: boolean;
  /**
   * Internal: how well this store's best hit answers the question, in terms
   * that compare across stores. The router orders stores within each turn by
   * it (#1354). Search routes never return it.
   */
  storeRelevance?: SourceIndexStoreRelevance;
  rawExposed: false;
}

export interface SourceIndexStoreRelevance {
  // The best hit's share of the question's concepts, 0 to 1.
  conceptShare: number;
  // The best vetted cosine minus this store's own relevance bar. Raw cosines
  // do not compare across models, a margin over each store's bar does.
  vectorMargin?: number;
}

/**
 * Breadth of a corpus's match set. `saturated` means the adapter stopped
 * counting at its probe ceiling, so `matchedItems` is a lower bound.
 */
export interface SourceIndexCorpusMatchCount {
  matchedItems: number;
  // Of matchedItems, those with readable content, not a bare name or path.
  contentMatchedItems: number;
  saturated: boolean;
  // Of matchedItems, those whose own tier is secure (S4 and above). Absent
  // when the adapter cannot tell; the router then counts a positive count as
  // secure (see encounteredSecureLocal).
  secureMatchedItems?: number;
}

export interface SourceIndexRoutedMatchCount extends SourceIndexCorpusMatchCount {
  corpusId: string;
  family: SourceFamily;
  trustDomain: SourceTrustDomain;
  // The corpus's default tier, so a count from an ordinary-domain corpus
  // whose default is secure (S4+) is judged secure by isSecureSensitivity.
  trustTier: SourceTrustTier;
}

export interface SourceIndexCorpusSearchAdapter {
  (request: SourceIndexCorpusSearchRequest): SourceIndexCorpusSearchResponse | Promise<SourceIndexCorpusSearchResponse>;
  // Optional local-only preparation before lane deadlines start.
  prepareKeywords?: (query: string) => Promise<void>;
  /**
   * Optional: get the query's embedding ready before lane deadlines start, so
   * a local embedding model that is still starting (the first question after
   * idle) can finish within `budgetMs` instead of dropping the semantic lane.
   * It must bound itself to `budgetMs`, never throw, and never read the store:
   * the router calls it only when the adapter already reported a servable
   * hybrid lane, and only for searches that read content. A lane still skipped
   * afterwards is reported as usual (semantic_lane_skipped).
   */
  prepareSemantic?: (query: string, budgetMs: number) => Promise<void>;
  hybridAvailability?: (request: SourceIndexCorpusSearchRequest) => SourceIndexHybridAvailability;
  /**
   * The corpus's nearest semantic neighbours of the query, nearest first,
   * whatever their similarity: no relevance bar vets them, so they are never
   * matches and never counted (`matchCount` is zero). Only a consumer that
   * ranks candidates on its own may add them beside the matches (the private
   * answer panel, analyst-answer.ts searchPrivateEvidence). Absent when the
   * adapter has no semantic lane.
   */
  semanticNeighbours?: (request: SourceIndexCorpusSearchRequest) => Promise<SourceIndexCorpusSearchResponse>;
  /**
   * The corpus's items that match the query (the same lexical matches and
   * vetted semantic matches the search counts), as identity-only hits,
   * without reading any item text: no chunk is loaded, located or offset, and
   * no recency candidate or pin is added (they are not matches). Used when
   * the request context is metadataOnly. Absent when the adapter cannot
   * match without reading text.
   */
  metadataMatches?: (request: SourceIndexCorpusSearchRequest) => Promise<SourceIndexCorpusSearchResponse>;
  /**
   * Whether an item a caller selected by identity is this corpus's item and
   * would be served now under this adapter's scope (account, filters, current
   * tier and read policy), from metadata only. Absent when the adapter cannot
   * tell without reading text.
   */
  selectedItemServable?: (sourceItem: SourceItemIdentity) => boolean;
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
  // Internal dispatch revalidation: the layer the hydrated candidate read.
  servingLayer?: 'metadata' | 'content';
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
  | 'lane_timeout'
  // A metadataOnly request reached a corpus whose adapter cannot match
  // without reading text: the corpus was not checked.
  | 'metadata_search_unsupported'
  // The next three are never produced by routeSourceIndexSearch. The answer
  // handler rewrites a secure_local corpus's trust_domain_not_allowed skip to
  // one of them when the caller did not decide include_secure_local:
  // no approved private analyst route before retrieval, a bulk-shaped request
  // that did not opt in, or a private route that failed at analysis time.
  | 'no_private_analyst_route'
  | 'bulk_secure_local_release_requires_approval'
  | 'private_analyst_unavailable';

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
  // Per-corpus match breadth, for every searched corpus whose adapter counts.
  matchCounts?: readonly SourceIndexRoutedMatchCount[];
  // Searched corpora whose adapter reported an incomplete response (see
  // SourceIndexCorpusSearchResponse.incomplete).
  incompleteCorpora?: readonly string[];
  // Content-free, decided before the visibility gate, the per-corpus budget
  // or any trim: true when a searched corpus contributed anything secure by
  // isSecureSensitivity. A corpus contributes when it returned a hit or a
  // positive match count; its contribution is secure when the corpus's
  // default sensitivity is secure, a hit's own tier is secure, or its count
  // reports secure rows or does not say (unknown counts as secure). A corpus
  // that matched nothing contributed nothing. Internal: never part of a tool
  // or model result.
  encounteredSecureLocal: boolean;
  // The lane audits (by object identity, members of laneAudits) of every
  // corpus whose contribution was secure by that same rule. Their counts
  // describe secure-inclusive matches, so an answer analyzed on an ordinary
  // route leaves them out of what it returns. Internal.
  secureLaneAudits: readonly RetrievalLaneAudit[];
  // How many recency seats (seat 4 on) the pack's newest chat messages took
  // (withReservedRecencySeats). A prompt fit reads them right after seats 1 to
  // 3. Internal.
  recencySeats?: number;
  latencyMs: number;
  rawExposed: false;
}

export interface SourceIndexRoutedCorpusTiming {
  corpusId: string;
  elapsedMs: number;
  adapterReportedMs?: number;
  outcome: 'success' | 'timeout';
}

/**
 * A final visibility check over one query's hits from EVERY corpus, applied
 * once, before fusion. Tiered stores use it to judge all hits against one
 * snapshot of their tier ledger, so an item whose copy moved between two
 * stores mid-query is never returned from both. Returns the hits to keep.
 */
export type SourceIndexVisibilityGate = ((
  hits: readonly SourceIndexRoutedSearchHit[],
  report?: SourceIndexVisibilityGateReport,
) => readonly SourceIndexRoutedSearchHit[]) & {
  // The same judgment with its reads off the request thread, for a caller
  // that can wait (#1305).
  offThread?: (hits: readonly SourceIndexRoutedSearchHit[], report?: SourceIndexVisibilityGateReport) => Promise<readonly SourceIndexRoutedSearchHit[]>;
};

/**
 * What a gate tells its caller besides the hits it keeps (#1460): the corpora
 * whose hits it left out because it could not read their visibility (a busy
 * read pool, an unreadable ledger), so the search names them instead of
 * returning a silently thinner list. Called once per judgment that stands.
 */
export interface SourceIndexVisibilityGateReport {
  onUnchecked?: (corpusIds: readonly string[]) => void;
}

// Applies the gate off the request thread where it can be.
export function applySourceIndexVisibilityGate(
  gate: SourceIndexVisibilityGate,
  hits: readonly SourceIndexRoutedSearchHit[],
  report?: SourceIndexVisibilityGateReport,
): Promise<readonly SourceIndexRoutedSearchHit[]> {
  return gate.offThread ? gate.offThread(hits, report) : Promise.resolve(gate(hits, report));
}

export interface RouteSourceIndexSearchOptions {
  registry: SourceIndexCorpusRegistry;
  adapters: SourceIndexRouterAdapterMap;
  request: SourceIndexSearchRequest;
  visibilityGate?: SourceIndexVisibilityGate;
  // Internal observer, after visibility and before seating. No work when absent.
  onSeatingLanes?: (lanes: readonly SeatingLane[]) => void;
  // Eval capture only: ask each adapter for this depth independently of the seated pool.
  storeSearchDepth?: number;
  // Per-lane retrieval deadline for the evidence-pack fan-out. A corpus adapter
  // that does not settle within this budget is DROPPED from the pack and
  // reported in skippedCorpora with reason 'lane_timeout', so one slow corpus
  // (e.g. a multi-GB keyword index under write contention) can no longer hold
  // the whole source_answer hostage — total fan-out time is bounded by this
  // budget. Defaults to OLYMPUS_SOURCE_ANSWER_LANE_TIMEOUT_MS, or 60s when
  // unset. A non-positive / non-finite value disables the deadline (unbounded
  // lanes — the pre-deadline behavior).
  laneTimeoutMs?: number;
  // How long preparation may wait for a starting embedding model before the
  // lanes run (see DEFAULT_SEMANTIC_PREPARE_BUDGET_MS). Non-positive skips it.
  semanticPrepareBudgetMs?: number;
  // When the whole search must end (epoch ms), preparation included: the lane
  // timeout is cut to what is left once preparation is done, so a slow model
  // wait cannot push a search past the Ask's budget.
  searchDeadlineAtMs?: number;
  // The lane deadline's clock and timers. Tests pass a test clock; the default is the real one.
  laneClock?: LaneDeadlineClock;
}

// The time seam of the lane deadline (runCorpusLaneWithDeadline).
export interface LaneDeadlineClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

const REAL_LANE_CLOCK: LaneDeadlineClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

// How long one search may wait, before its lane deadlines start, for a local
// embedding model that is still starting (#1172). A third of the 45 s
// source-answer hand-off (SOURCE_ANSWER_HANDOFF_DEFAULT_MS in
// core/source-answer-jobs.ts). Longer searches continue through the existing
// background-job hand-off while the request thread remains responsive.
// A warm model never waits: preparation returns as soon as the query embeds.
// A model still not started by then leaves the semantic lane skipped, and the
// EvidencePack's coverage says so.
export const DEFAULT_SEMANTIC_PREPARE_BUDGET_MS = 15_000;

// The lane timeout, cut to what is left before the search's own deadline (at least 1 ms).
export function laneTimeoutWithinDeadline(laneTimeoutMs: number, deadlineAtMs: number | undefined, now = Date.now()): number {
  if (deadlineAtMs === undefined || !Number.isFinite(deadlineAtMs)) return laneTimeoutMs;
  const left = Math.max(1, deadlineAtMs - now);
  return Number.isFinite(laneTimeoutMs) && laneTimeoutMs > 0 ? Math.min(laneTimeoutMs, left) : left;
}

// Default per-lane retrieval deadline (ms), and the whole-Ask search budget.
//
// Since #1305 each store reads on its own warm worker, so a lane's time is its
// own store's statement, not a queue behind other stores. The lane deadline
// covers one healthy store at Sparta size with margin; the Ask budget is about
// what a 1.4.x Ask takes on Sparta (roughly 100 s), across the literal query
// and its expansions, which run one after another. A lane that misses either
// is reported as still being searched (#1317's wording), and its statement
// finishes on its worker, so the store is warm for the next Ask. Neither
// binds on a small install, whose lanes return in milliseconds.
//
// Never below the stores' SQLite busy_timeout (10 s): a lane waiting out the
// single writer resolves within it.
//
// Provisional until the #1305 testbed copy's live pool fields set them.
const DEFAULT_SOURCE_ANSWER_LANE_TIMEOUT_MS = 60_000;
const DEFAULT_ASK_SEARCH_BUDGET_MS = 100_000;
// Exact-vector adapters receive a cooperative deadline just inside the
// authoritative timer, so a scan can yield before holding the event loop.
const COOPERATIVE_LANE_DEADLINE_HEADROOM_MS = 50;
// A deadline timer this late means the thread was held past it (see
// runCorpusLaneWithDeadline); the lane then gets HELD_THREAD_GRACE_MS more,
// up to HELD_THREAD_MAX_DEADLINE_FACTOR times its deadline in all.
const HELD_THREAD_LATE_TIMER_MS = 500;
const HELD_THREAD_GRACE_MS = 1_000;
const HELD_THREAD_MAX_DEADLINE_FACTOR = 6;

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
  return withKeywordRequestScope(() => routePreparedSourceIndexSearch(options));
}

async function routePreparedSourceIndexSearch(options: RouteSourceIndexSearchOptions): Promise<SourceIndexRoutedSearchResponse> {
  const request = normalizeSearchRequest(options.request);
  const candidateCorpora = options.registry.list();
  const skippedCorpora: SourceIndexSkippedCorpus[] = [];
  const searchedCorpora: string[] = [];
  const laneAudits: RetrievalLaneAudit[] = [];
  const degradations: RetrievalDegradation[] = [];
  const corpusTimings: SourceIndexRoutedCorpusTiming[] = [];
  const lanes: Array<{ name: string; items: SourceIndexRoutedSearchHit[]; relevance?: SourceIndexStoreRelevance }> = [];
  const matchCounts: SourceIndexRoutedMatchCount[] = [];
  const incompleteCorpora: string[] = [];
  let encounteredSecureLocal = false;
  const secureLaneAudits: RetrievalLaneAudit[] = [];
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
    if (request.context.metadataOnly === true && !adapter.metadataMatches) {
      skippedCorpora.push({ corpusId: corpus.corpusId, trustDomain: corpus.trustDomain, reason: 'metadata_search_unsupported' });
      continue;
    }

    searchableCorpora.push(corpus);
  }

  // Each corpus's retrieval state, read once (its hybridAvailability is a
  // store read): preparation uses it to decide whether a semantic lane is
  // worth warming, and the lane's honesty check below uses the same answer.
  const retrievalStates = new Map(searchableCorpora.map((corpus) => [
    corpus.corpusId,
    retrievalStateForAdapter(options.adapters[corpus.corpusId]!, {
      query: request.query,
      maxResults: request.maxResults,
      corpus,
      context: request.context,
    }),
  ] as const));
  // Preparation never sees corpus content and owns its own bounded timeout.
  // A cold local model must not spend the store's lock/vector deadline.
  const semanticPrepareBudgetMs = options.semanticPrepareBudgetMs ?? DEFAULT_SEMANTIC_PREPARE_BUDGET_MS;
  // Keyword translation and the query embedding are independent, so each
  // corpus prepares both at once: one after the other, every lane waited for
  // the sum of the two model waits (#1305).
  let prepareKeywordsMaxMs = 0;
  let prepareSemanticMaxMs = 0;
  const timed = async (run: () => Promise<void> | undefined): Promise<number> => {
    const started = Date.now();
    try { await run(); } catch { /* the original query remains usable, and a lane reports its own skip */ }
    return Date.now() - started;
  };
  const prepareStartedAt = Date.now();
  await Promise.all(searchableCorpora.map(async (corpus) => {
    const adapter = options.adapters[corpus.corpusId]!;
    // A metadata-only search (the Private-match probe) has its own short
    // budget and reports an incomplete lane as unknown; it never waits here.
    const semantic = adapter.prepareSemantic
      && semanticPrepareBudgetMs > 0
      && request.context.metadataOnly !== true
      && retrievalStates.get(corpus.corpusId)!.hybridServable;
    const [keywordsMs, semanticMs] = await Promise.all([
      timed(() => adapter.prepareKeywords?.(request.query)),
      semantic ? timed(() => adapter.prepareSemantic!(request.query, semanticPrepareBudgetMs)) : Promise.resolve(0),
    ]);
    prepareKeywordsMaxMs = Math.max(prepareKeywordsMaxMs, keywordsMs);
    prepareSemanticMaxMs = Math.max(prepareSemanticMaxMs, semanticMs);
  }));
  const lanesStartedAt = Date.now();
  const laneTimeoutMs = laneTimeoutWithinDeadline(resolveLaneTimeoutMs(options.laneTimeoutMs), options.searchDeadlineAtMs);
  const laneOutcomes = await Promise.all(searchableCorpora.map(async (corpus) => {
    const adapter = options.adapters[corpus.corpusId]!;
    const cooperativeDeadlineAtMs = cooperativeLaneDeadlineAtMs(laneTimeoutMs);
    const corpusRequest: SourceIndexCorpusSearchRequest = {
      query: request.query,
      maxResults: options.storeSearchDepth ?? request.maxResults,
      corpus,
      context: request.context,
      ...(cooperativeDeadlineAtMs !== undefined ? { deadlineAtMs: cooperativeDeadlineAtMs } : {}),
    };
    const retrievalState = retrievalStates.get(corpus.corpusId)!.state;
    const metadataMatches = request.context.metadataOnly === true ? adapter.metadataMatches : undefined;
    const outcome = await runCorpusLaneWithDeadline(
      () => runInSourceAnswerLane(corpus.corpusId, async () => {
        if (metadataMatches) return metadataMatches(corpusRequest);
        const response = await adapter(corpusRequest);
        // A reranked pool draws each store's share from its matches first,
        // then its nearest semantic neighbours: a below-bar vector hit can
        // still be the answer, and the reranker decides. Neighbours are never
        // matches, so match counts stay the store's own.
        const depth = request.poolAllocation?.storeDepth;
        if (depth === undefined || !adapter.semanticNeighbours || response.hits.length >= depth) return response;
        try {
          const neighbours = await adapter.semanticNeighbours({ ...corpusRequest, maxResults: depth });
          const key = (hit: SourceIndexCorpusSearchResponse['hits'][number]) =>
            `${hit.sourceItem.providerItemId}\u0000${hit.sourceItem.localItemId ?? ''}`;
          const seen = new Set(response.hits.map(key));
          const added = neighbours.hits.filter((hit) => !seen.has(key(hit))).slice(0, depth - response.hits.length);
          if (added.length === 0) return response;
          return {
            ...response,
            hits: [...response.hits, ...added],
            ...(neighbours.laneAudits?.length ? { laneAudits: [...(response.laneAudits ?? []), ...neighbours.laneAudits] } : {}),
          };
        } catch {
          return response;
        }
      }),
      laneTimeoutMs,
      corpus.corpusId,
      options.laneClock ?? REAL_LANE_CLOCK,
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
    if (response.incomplete === true) incompleteCorpora.push(corpus.corpusId);
    const corpusLaneAuditsStart = laneAudits.length;
    laneAudits.push(...(response.laneAudits ?? []));
    const contributedSecure = corpusContributedSecure(corpus, response);
    if (contributedSecure) encounteredSecureLocal = true;
    if (response.matchCount) {
      matchCounts.push({
        corpusId: corpus.corpusId,
        family: corpus.family,
        trustDomain: corpus.trustDomain,
        trustTier: corpus.defaultSensitivity.trustTier,
        matchedItems: response.matchCount.matchedItems,
        contentMatchedItems: response.matchCount.contentMatchedItems,
        saturated: response.matchCount.saturated,
        ...(response.matchCount.secureMatchedItems !== undefined
          ? { secureMatchedItems: response.matchCount.secureMatchedItems }
          : {}),
      });
    }
    if (corpus.activationMode !== 'lexical_only') {
      laneAudits.push(sourceIndexRetrievalStateLaneAudit({
        corpusId: corpus.corpusId,
        localOnly: corpus.storageProfile.placement === 'local_private',
        state: retrievalState,
      }));
      const semanticLoss = semanticLaneDegradation(corpus.corpusId, retrievalState, response);
      if (semanticLoss) degradations.push(semanticLoss);
    }
    const newestLoss = recentItemsLaneDegradation(corpus.corpusId, response);
    if (newestLoss) degradations.push(newestLoss);
    if (contributedSecure) secureLaneAudits.push(...laneAudits.slice(corpusLaneAuditsStart));
    lanes.push({
      name: corpus.corpusId,
      ...(response.storeRelevance ? { relevance: response.storeRelevance } : {}),
      items: response.hits.map((hit) => ({
        ...hit,
        corpusId: corpus.corpusId,
        trustDomain: corpus.trustDomain,
      })),
    });
  }

  const lanesSettledAt = Date.now();
  if (options.visibilityGate) {
    // One call for every lane's hits: one snapshot decides them all.
    const unchecked = new Set<string>();
    const kept = new Set(await applySourceIndexVisibilityGate(options.visibilityGate, lanes.flatMap((lane) => lane.items), {
      onUnchecked: (corpusIds) => { for (const corpusId of corpusIds) unchecked.add(corpusId); },
    }));
    for (const lane of lanes) lane.items = lane.items.filter((hit) => kept.has(hit));
    // A source whose hits the gate could not judge is named, never thinner in silence (#1460).
    for (const corpusId of [...unchecked].sort()) degradations.push(visibilityCheckDegradation(corpusId));
  }

  options.onSeatingLanes?.(lanes);
  const recency = seatRoutedLanes(lanes, request);
  const { hits: fused, degradations: budgetDegradations } = recency;

  const result: SourceIndexRoutedSearchResponse = {
    hits: fused,
    searchedCorpora,
    skippedCorpora,
    laneAudits,
    degradations: mergeRetrievalDegradations(degradations, budgetDegradations),
    corpusTimings,
    ...(matchCounts.length > 0 ? { matchCounts } : {}),
    ...(incompleteCorpora.length > 0 ? { incompleteCorpora } : {}),
    encounteredSecureLocal,
    secureLaneAudits,
    ...(recency.recencySeats > 0 ? { recencySeats: recency.recencySeats } : {}),
    latencyMs: Date.now() - startedAt,
    rawExposed: false,
  };
  assertSafeRoutedSearchResponse(result);
  recordSourceAnswerQueryStages({
    prepare_ms: lanesStartedAt - prepareStartedAt,
    prepare_keywords_max_ms: prepareKeywordsMaxMs,
    prepare_semantic_max_ms: prepareSemanticMaxMs,
    lanes_ms: lanesSettledAt - lanesStartedAt,
    after_lanes_ms: Date.now() - lanesSettledAt,
  });
  return result;
}

// A store's ranked candidates after the visibility gate, before any seating.
export interface SeatingLane {
  name: string;
  relevance?: SourceIndexStoreRelevance;
  items: readonly SourceIndexRoutedSearchHit[];
}

// Pure seating shared by routed search and offline eval replay.
export function seatRoutedLanes(
  lanes: readonly SeatingLane[],
  options: Pick<SourceIndexSearchRequest, 'maxResults' | 'poolAllocation' | 'temporalIntent'>,
): { hits: SourceIndexRoutedSearchHit[]; degradations: RetrievalDegradation[]; recencySeats: number } {
  // Store order within each turn: how well each store's best hit answers
  // this question (storeOrderForQuestion), then lane declaration order.
  // registry.list() preserves the order the corpora were registered in, which
  // deliberately interleaves trust domains, and it is neither adapter-scale-
  // derived nor spelling-derived, so it is the last tie-break.
  const laneOrder = storeOrderForQuestion(lanes);
  const fusedAll = fuseRankedCandidateLanes({
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
  });
  const budgeted = options.poolAllocation
    ? applyStrengthPoolBudget(fusedAll, options.maxResults, laneOrder, options.poolAllocation.storeDepth)
    : applyPerCorpusResultBudget(fusedAll, options.maxResults);
  const pool = fusedAll.map((candidate) => candidate.item);
  const leadered = withReservedLeaderSeats(budgeted, pool, options.maxResults);
  const recency = options.temporalIntent
    ? withReservedRecencySeats(leadered, pool, options.maxResults)
    : { ...leadered, recencySeats: 0 };
  return recency;
}

// Whether one corpus lane's raw response (before any filter or trim) carried
// anything secure, from every lane the adapter ran (keyword, semantic,
// recency): a hit is secure when its corpus default is, or its own tier is;
// a count is secure when its corpus is, or when it reports secure rows or
// does not report row sensitivity at all. A hit with no tier of its own is
// judged by its corpus default here; the evidence build is stricter when no
// provider answers for it.
function corpusContributedSecure(
  corpus: SourceIndexCorpusDefinition,
  response: SourceIndexCorpusSearchResponse,
): boolean {
  const count = response.matchCount;
  const positiveCount = count !== undefined && (count.matchedItems > 0 || count.saturated);
  if (response.hits.length === 0 && !positiveCount) return false;
  if (isSecureSensitivity(corpus.defaultSensitivity)) return true;
  if (response.hits.some((hit) => hit.trustTier !== undefined
    && isSecureSensitivity({ trustDomain: corpus.trustDomain, trustTier: hit.trustTier }))) {
    return true;
  }
  return positiveCount && (count.secureMatchedItems === undefined || count.secureMatchedItems > 0);
}

// Below half the question's concepts a store's best keyword hit counts as no
// keyword match, so one shared common word does not lead a turn (the same
// floor as the reserved leader seats).
const STORE_ORDER_MIN_CONCEPT_SHARE = RESERVED_LEADER_MIN_CONCEPT_SHARE;

/**
 * Store order within each turn of the pack (#1354). Every store's rank k ties
 * in the fusion, so this order decides which stores' best hits the pack and a
 * local Analyst's fitted prompt read first. It was config order for every
 * question, so on an install with many stores a local answer read the same
 * few stores whatever was asked. Now: a store whose best hit matches at least
 * half the question's concepts first, by that share; then a store whose best
 * hit is a vetted semantic match, by its margin over the store's own bar (a
 * paraphrase with no word in common); then config order. Order only: which
 * items may reach which Analyst is decided elsewhere and is unchanged.
 */
function storeOrderForQuestion(
  lanes: ReadonlyArray<{ name: string; relevance?: SourceIndexStoreRelevance }>,
): ReadonlyMap<string, number> {
  const keyword = (lane: (typeof lanes)[number]) => {
    const share = lane.relevance?.conceptShare ?? 0;
    return share >= STORE_ORDER_MIN_CONCEPT_SHARE ? share : 0;
  };
  const vector = (lane: (typeof lanes)[number]) => lane.relevance?.vectorMargin ?? Number.NEGATIVE_INFINITY;
  const ordered = lanes
    .map((lane, index) => ({ lane, index }))
    .sort((left, right) => (keyword(right.lane) - keyword(left.lane))
      || (vector(right.lane) === vector(left.lane) ? 0 : vector(right.lane) > vector(left.lane) ? 1 : -1)
      || left.index - right.index);
  return new Map(ordered.map(({ lane }, index) => [lane.name, index] as const));
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
// A lane that read a source's newest items and ran out of time (#1460): the
// source answered from its other lanes, so it is searched, and this one lane
// is marked so the evidence pack can say its newest items may be missing.
function recentItemsLaneDegradation(
  corpusId: string,
  response: SourceIndexCorpusSearchResponse,
): RetrievalDegradation | undefined {
  const cut = (response.laneAudits ?? []).find((audit) => audit.skippedReason === RECENT_ITEMS_CUT_SHORT);
  if (!cut) return undefined;
  return {
    laneName: `${corpusId}:recency`,
    laneType: cut.laneType,
    reason: 'lane_timeout',
    detail: RECENT_ITEMS_CUT_SHORT,
    occurrences: 1,
  };
}

function visibilityCheckDegradation(corpusId: string): RetrievalDegradation {
  return {
    laneName: `${corpusId}:visibility`,
    laneType: 'keyword',
    reason: 'lane_timeout',
    detail: VISIBILITY_CHECK_CUT_SHORT,
    occurrences: 1,
  };
}

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
): { state: SourceIndexRetrievalState; hybridServable: boolean } {
  let hybridAvailability: SourceIndexHybridAvailability | undefined;
  try {
    hybridAvailability = adapter.hybridAvailability?.(request);
  } catch {
    hybridAvailability = { servable: false, reason: 'hybrid_capability_unreported' };
  }
  return {
    state: assessSourceIndexRetrievalState({
      declaredMode: request.corpus.activationMode,
      ...(hybridAvailability ? { hybridAvailability } : {}),
    }),
    hybridServable: hybridAvailability?.servable === true,
  };
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
  clock: LaneDeadlineClock = REAL_LANE_CLOCK,
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
      if (isSourceIndexLaneBusyError(error)) {
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        recordSourceAnswerCorpusTiming({ corpus_id: corpusId, elapsed_ms: elapsedMs, outcome: 'timeout' });
        return { kind: 'timeout', elapsedMs };
      }
      recordSourceAnswerCorpusTiming({
        corpus_id: corpusId,
        elapsed_ms: Math.max(0, Date.now() - startedAt),
        outcome: 'error',
        error_class: sourceAnswerTraceErrorClass(error),
      });
      throw error;
    }
  }

  let timer: unknown;
  const laneSettled: Promise<
    { kind: 'response'; response: SourceIndexCorpusSearchResponse } | { kind: 'error'; error: unknown }
  > = runValidated().then(
    (response) => ({ kind: 'response' as const, response }),
    (error) => ({ kind: 'error' as const, error }),
  );
  // A held thread is not a slow lane. When the deadline's timer fires late,
  // something else held the worker's thread past it (a judging pass, another
  // lane's synchronous keyword search), so this lane never had its budget of
  // turns. It gets a short grace instead of being dropped, and is dropped
  // only when a timer fires on time after the deadline, or at the hard stop.
  // Sparta, 2026-11-10 (#1079): with the thread held 32-45 s during a
  // dashboard Ask, every lane missed its 10 s deadline together and the Ask
  // reported every source as unsearchable, although the lanes had found
  // candidates.
  const hardStopAtMs = clock.now() + timeoutMs * HELD_THREAD_MAX_DEADLINE_FACTOR;
  const deadline = new Promise<{ kind: 'timeout' }>((resolve) => {
    const arm = (delayMs: number) => {
      const dueAtMs = clock.now() + delayMs;
      timer = clock.setTimeout(() => {
        const now = clock.now();
        if (now - dueAtMs >= HELD_THREAD_LATE_TIMER_MS && now < hardStopAtMs) {
          arm(HELD_THREAD_GRACE_MS);
          return;
        }
        resolve({ kind: 'timeout' as const });
      }, delayMs);
    };
    arm(timeoutMs);
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
    if (settled.kind === 'error' && isSourceIndexLaneBusyError(settled.error)) {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      recordSourceAnswerCorpusTiming({ corpus_id: corpusId, elapsed_ms: elapsedMs, outcome: 'timeout' });
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
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}

export function resolveLaneTimeoutMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.OLYMPUS_SOURCE_ANSWER_LANE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_SOURCE_ANSWER_LANE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_SOURCE_ANSWER_LANE_TIMEOUT_MS;
  // parsed <= 0 is honored as "disable the deadline" by runCorpusLaneWithDeadline.
  return parsed;
}

// The whole-Ask search budget (BuildEvidencePackInput.searchBudgetMs).
export function resolveAskSearchBudgetMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.OLYMPUS_SOURCE_ANSWER_SEARCH_BUDGET_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_ASK_SEARCH_BUDGET_MS;
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

export function routedHitCandidateId(hit: SourceIndexRoutedSearchHit): SourceIndexCandidateId {
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

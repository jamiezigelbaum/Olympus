import { withSourceIndexReadProgress, type SourceIndexReadProgress } from './read-progress.ts';
import { noteSourceAnswerProgress } from '../source-answer-jobs.ts';
import { READ_WIDE_MATCH_LIMIT } from '../read-wide.ts';
import { isSourceIndexLaneBusyError } from './lane-busy.ts';
import { RECENT_ITEMS_CUT_SHORT, SEMANTIC_SEARCH_STARTING, VISIBILITY_CHECK_CUT_SHORT } from './partial-search.ts';
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
  // Ask-only: append store matches after the ordinary draw, before semantic seats.
  readWide?: boolean;
  // A reranker pool (evidence-pack): seat every store's leader, then go deep
  // in the strongest stores first, up to storeDepth of each store's own ranks
  // (applyStrengthPoolBudget). Absent: stores share seats in even turns.
  // semanticSeats: seats added after that draw for the best vector rows
  // across stores by margin over each store's bar (withSemanticPoolSeats).
  poolAllocation?: { storeDepth: number; semanticSeats?: number };
}

export interface SourceIndexCorpusSearchRequest {
  query: string;
  maxResults: number;
  corpus: SourceIndexCorpusDefinition;
  context: SourceIndexSearchContext;
  // Explicit deadlines from other callers remain supported by adapters. Routed
  // lanes use batch progress instead of imposing a total deadline.
  deadlineAtMs?: number;
  onProgress?: () => void;
  // Latest usable prefix, rechecked by the router's normal visibility gate.
  onPartialResponse?: (response: SourceIndexCorpusSearchResponse) => void;
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
  /**
   * Internal: the store's nearest semantic rows that fell under its relevance
   * bar in this same search, nearest first. They are never matches and never
   * counted; a reranked pool may seat them after the store's matches. Read
   * from the search the store already ran, so no second vector scan is paid.
   */
  semanticNeighbourHits?: readonly SourceIndexSearchHit[];
  /**
   * Internal: the store's best vector rows in this same search, nearest
   * first, whether or not they cleared its relevance bar, each hit's score
   * its cosine, with the bar they are measured against. A reranked pool may
   * seat them by margin over the bar (withSemanticPoolSeats); like the
   * neighbours they are never matches and never counted.
   */
  semanticRows?: { hits: readonly SourceIndexSearchHit[]; bar: number };
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
  prepareKeywords?: (query: string) => Promise<void | { incomplete: boolean }>;
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
  pinVectorSearchReadiness?: () => void;
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
  // Ask-only membership before neighbour fill; does not cross the public membrane.
  matchingCandidateIds?: readonly SourceIndexCandidateId[];
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
  // The pool seats withSemanticPoolSeats added, with their margins, so a
  // build that fuses several runs can seat them again past its own cut.
  // Internal.
  semanticSeats?: readonly SemanticPoolSeat[];
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
  // Idle time without a returned store batch. Non-positive disables the wait.
  // The existing option/env name is retained for compatibility.
  laneTimeoutMs?: number;
  // How long preparation may wait for a starting embedding model before the
  // lanes run (see DEFAULT_SEMANTIC_PREPARE_BUDGET_MS). Non-positive skips it.
  semanticPrepareBudgetMs?: number;
  // Legacy option, ignored: total clocks do not cut progressing lanes.
  searchDeadlineAtMs?: number;
  // The lane deadline's clock and timers. Tests pass a test clock; the default is the real one.
  laneClock?: LaneDeadlineClock;
}

// The time seam of the lane deadline (runCorpusLaneUntilIdle).
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

const DEFAULT_SOURCE_ANSWER_LANE_TIMEOUT_MS = 20_000;
// A delayed timer gives I/O a turn before deciding the store is idle.
const HELD_THREAD_LATE_TIMER_MS = 500;
const HELD_THREAD_GRACE_MS = 1_000;

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
  const lanes: Array<{ name: string; items: SourceIndexRoutedSearchHit[]; relevance?: SourceIndexStoreRelevance; semantic?: SemanticPoolSeat[] }> = [];
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
    try { await run(); } catch { /* a lane reports its own skip */ }
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
      timed(async () => {
        const prepared = await adapter.prepareKeywords?.(request.query).catch(() => ({ incomplete: true }));
        if (prepared?.incomplete) degradations.push({ laneName: `${corpus.corpusId}:keywords`, laneType: 'keyword', reason: 'lane_timeout', detail: 'keyword_preparation_incomplete', occurrences: 1 });
      }),
      semantic ? timed(() => adapter.prepareSemantic!(request.query, semanticPrepareBudgetMs)) : Promise.resolve(0),
    ]);
    prepareKeywordsMaxMs = Math.max(prepareKeywordsMaxMs, keywordsMs);
    prepareSemanticMaxMs = Math.max(prepareSemanticMaxMs, semanticMs);
  }));
  const lanesStartedAt = Date.now();
  const laneTimeoutMs = resolveLaneTimeoutMs(options.laneTimeoutMs);
  const matchingIds = new Set<SourceIndexCandidateId>();
  const laneOutcomes = await Promise.all(searchableCorpora.map(async (corpus) => {
    const adapter = options.adapters[corpus.corpusId]!;
    let progress: SourceIndexReadProgress = () => {};
    let partial: SourceIndexCorpusSearchResponse | undefined;
    const corpusRequest: SourceIndexCorpusSearchRequest = {
      query: request.query,
      maxResults: options.storeSearchDepth ?? request.maxResults,
      corpus,
      context: request.context,
      onProgress: () => progress(),
      onPartialResponse: (response) => {
        assertSafeCorpusSearchResponse(response);
        const key = (hit: SourceIndexSearchHit) => `${hit.sourceItem.providerItemId}\u0000${hit.sourceItem.localItemId}`;
        const hits = new Map((partial?.hits ?? []).map(hit => [key(hit), hit]));
        for (const hit of response.hits) {
          hits.set(key(hit), hit);
          if (request.readWide) matchingIds.add(routedHitCandidateId({ ...hit, corpusId: corpus.corpusId, trustDomain: corpus.trustDomain }));
        }
        const laneAudits = response.laneAudits ?? partial?.laneAudits;
        partial = {
          hits: [...hits.values()].slice(0, corpusRequest.maxResults), latencyMs: response.latencyMs,
          ...(laneAudits ? { laneAudits } : {}), incomplete: true, rawExposed: false,
        };
      },
    };
    const retrievalState = retrievalStates.get(corpus.corpusId)!.state;
    const metadataMatches = request.context.metadataOnly === true ? adapter.metadataMatches : undefined;
    const outcome = await runCorpusLaneUntilIdle(
      (report) => { progress = report; return withSourceIndexReadProgress(report, () => runInSourceAnswerLane(corpus.corpusId, async () => {
        if (metadataMatches) {
          const response = await metadataMatches(corpusRequest);
          if (request.readWide) for (const hit of response.hits) matchingIds.add(routedHitCandidateId({ ...hit, corpusId: corpus.corpusId, trustDomain: corpus.trustDomain }));
          return response;
        }
        const response = await adapter(corpusRequest);
        if (request.readWide) for (const hit of response.hits) {
          matchingIds.add(routedHitCandidateId({ ...hit, corpusId: corpus.corpusId, trustDomain: corpus.trustDomain }));
        }
        // A reranked pool draws each store's share from its matches first,
        // then its nearest semantic neighbours from the same search: a
        // below-bar vector hit can still be the answer, and the reranker
        // decides. Neighbours are never matches, so match counts stay the
        // store's own.
        const depth = request.poolAllocation?.storeDepth;
        const neighbours = response.semanticNeighbourHits;
        if (depth === undefined || !neighbours?.length || response.hits.length >= depth) return response;
        const key = (hit: SourceIndexSearchHit) => `${hit.sourceItem.providerItemId}\u0000${hit.sourceItem.localItemId ?? ''}`;
        const seen = new Set(response.hits.map(key));
        const added = neighbours.filter((hit) => !seen.has(key(hit))).slice(0, depth - response.hits.length);
        return added.length === 0 ? response : { ...response, hits: [...response.hits, ...added] };
      })); },
      laneTimeoutMs,
      corpus.corpusId,
      options.laneClock ?? REAL_LANE_CLOCK,
    );
    return { corpus, outcome, retrievalState, partial };
  }));

  for (const { corpus, outcome, retrievalState, partial } of laneOutcomes) {
    if (outcome.kind === 'timeout') {
      // An idle read keeps its available prefix and names the unfinished store.
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
      if (!partial) continue;
      incompleteCorpora.push(corpus.corpusId);
    }
    const response = outcome.kind === 'response' ? outcome.response : partial!;
    if (outcome.kind === 'response') corpusTimings.push({
      corpusId: corpus.corpusId,
      elapsedMs: outcome.elapsedMs,
      adapterReportedMs: response.latencyMs,
      outcome: 'success',
    });
    searchedCorpora.push(corpus.corpusId);
    if (response.incomplete === true && !incompleteCorpora.includes(corpus.corpusId)) incompleteCorpora.push(corpus.corpusId);
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
    }
    if (corpus.activationMode !== 'lexical_only'
      || response.laneAudits?.some(audit => audit.skippedReason === SEMANTIC_SEARCH_STARTING)) {
      const semanticLoss = semanticLaneDegradation(corpus.corpusId, retrievalState, response);
      if (semanticLoss) degradations.push(semanticLoss);
    }
    const newestLoss = recentItemsLaneDegradation(corpus.corpusId, response);
    if (newestLoss) degradations.push(newestLoss);
    if (contributedSecure) secureLaneAudits.push(...laneAudits.slice(corpusLaneAuditsStart));
    lanes.push({
      name: corpus.corpusId,
      ...(response.storeRelevance ? { relevance: response.storeRelevance } : {}),
      ...(request.readWide ? { matchingIds } : {}),
      items: response.hits.map((hit) => ({
        ...hit,
        corpusId: corpus.corpusId,
        trustDomain: corpus.trustDomain,
      })),
      ...(request.poolAllocation?.semanticSeats && response.semanticRows?.hits.length
        ? { semantic: response.semanticRows.hits.map((hit) => ({
            hit: { ...hit, corpusId: corpus.corpusId, trustDomain: corpus.trustDomain },
            margin: (hit.score ?? Number.NEGATIVE_INFINITY) - response.semanticRows!.bar,
          })) }
        : {}),
    });
  }

  const lanesSettledAt = Date.now();
  if (options.visibilityGate) {
    // One call for every lane's hits: one snapshot decides them all.
    const unchecked = new Set<string>();
    const kept = new Set(await applySourceIndexVisibilityGate(options.visibilityGate, lanes.flatMap((lane) => [
      ...lane.items, ...(lane.semantic ?? []).map((seat) => seat.hit),
    ]), {
      onUnchecked: (corpusIds) => { for (const corpusId of corpusIds) unchecked.add(corpusId); },
    }));
    for (const lane of lanes) {
      lane.items = lane.items.filter((hit) => kept.has(hit));
      if (lane.semantic) lane.semantic = lane.semantic.filter((seat) => kept.has(seat.hit));
    }
    // A source whose hits the gate could not judge is named, never thinner in silence (#1460).
    for (const corpusId of [...unchecked].sort()) degradations.push(visibilityCheckDegradation(corpusId));
  }

  options.onSeatingLanes?.(lanes);
  const recency = seatRoutedLanes(lanes, request);
  const { hits: fused, degradations: budgetDegradations } = recency;

  const result: SourceIndexRoutedSearchResponse = {
    hits: fused,
    ...(request.readWide ? { matchingCandidateIds: [...matchingIds] } : {}),
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
    ...(recency.semanticSeats?.length ? { semanticSeats: recency.semanticSeats } : {}),
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
  matchingIds?: ReadonlySet<SourceIndexCandidateId>;
  items: readonly SourceIndexRoutedSearchHit[];
  // The store's best vector rows with their margin over its bar (semanticRows).
  semantic?: readonly SemanticPoolSeat[];
}

export interface SemanticPoolSeat {
  hit: SourceIndexRoutedSearchHit;
  // Cosine minus the store's relevance bar: comparable across stores whose
  // models score on different scales, negative below the bar.
  margin: number;
}

// At most this many semantic seats go to one store, so one dense store's
// near-duplicates cannot take them all.
export const SEMANTIC_POOL_SEATS_PER_STORE = 2;

/**
 * Seats for the best vector rows across stores, added after the pool is
 * drawn: best margin over its store's bar first, at most
 * SEMANTIC_POOL_SEATS_PER_STORE per store, skipping any already seated. They
 * go after the drawn pool, which only a reranker reads, so they never move a
 * seat the draw gave; the reranker decides whether they are kept.
 */
export function withSemanticPoolSeats(
  hits: readonly SourceIndexRoutedSearchHit[],
  lanes: readonly SeatingLane[],
  seats: number,
): { hits: SourceIndexRoutedSearchHit[]; seated: SemanticPoolSeat[] } {
  if (seats <= 0) return { hits: [...hits], seated: [] };
  const taken = new Set(hits.map(routedHitCandidateId));
  const offered = lanes.flatMap((lane) => lane.semantic ?? [])
    .filter((seat) => Number.isFinite(seat.margin))
    .sort((left, right) => right.margin - left.margin);
  const perStore = new Map<string, number>();
  const seated: SemanticPoolSeat[] = [];
  for (const seat of offered) {
    if (seated.length >= seats) break;
    const id = routedHitCandidateId(seat.hit);
    const used = perStore.get(seat.hit.corpusId) ?? 0;
    if (taken.has(id) || used >= SEMANTIC_POOL_SEATS_PER_STORE) continue;
    taken.add(id);
    perStore.set(seat.hit.corpusId, used + 1);
    seated.push(seat);
  }
  return { hits: [...hits, ...seated.map((seat) => seat.hit)], seated };
}

// Pure seating shared by routed search and offline eval replay.
export function seatRoutedLanes(
  lanes: readonly SeatingLane[],
  options: Pick<SourceIndexSearchRequest, 'maxResults' | 'poolAllocation' | 'temporalIntent' | 'readWide'>,
): { hits: SourceIndexRoutedSearchHit[]; degradations: RetrievalDegradation[]; recencySeats: number; semanticSeats?: SemanticPoolSeat[] } {
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
  if (options.readWide) {
    const taken = new Set(recency.hits.map(routedHitCandidateId));
    const matches = fusedAll.map(candidate => candidate.item).filter(hit =>
      lanes.some(lane => lane.name === hit.corpusId && (!lane.matchingIds || lane.matchingIds.has(routedHitCandidateId(hit)))));
    // Keep the ordinary draw's order and append every remaining relevant match.
    // Neighbours retain their existing seats; they do not spend the match cap.
    let matching = recency.hits.filter(hit => matches.some(match => routedHitCandidateId(match) === routedHitCandidateId(hit))).length;
    for (const hit of matches) {
      if (matching >= READ_WIDE_MATCH_LIMIT) break;
      const id = routedHitCandidateId(hit);
      if (taken.has(id)) continue;
      taken.add(id);
      recency.hits.push(hit);
      matching += 1;
    }
    const represented = new Set(recency.hits.map(hit => hit.corpusId));
    recency.degradations = recency.degradations.filter(loss => loss.reason !== 'lane_budget_cut' || !represented.has(loss.laneName));
  }
  const seats = options.poolAllocation?.semanticSeats ?? 0;
  if (seats <= 0) return recency;
  const semantic = withSemanticPoolSeats(recency.hits, lanes, seats);
  return { ...recency, hits: semantic.hits, ...(semantic.seated.length ? { semanticSeats: semantic.seated } : {}) };
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
  if (state.health === 'degraded' && state.reason !== SEMANTIC_SEARCH_STARTING) {
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

// Race a single corpus adapter against its idle wait. The safety
// assertion runs on the winning response exactly as before, so a lane that
// returns forbidden raw fields still fails the whole search (a real error is
// not the same as a slow lane). Crucially, when the deadline wins the race the
// lane's own promise is still fully observed (laneSettled never rejects), so a
// dropped lane that later rejects or resolves can never surface as an unhandled
// rejection or dangling throw.
async function runCorpusLaneUntilIdle(
  run: (report: SourceIndexReadProgress) => SourceIndexCorpusSearchResponse | Promise<SourceIndexCorpusSearchResponse>,
  timeoutMs: number,
  corpusId: string,
  clock: LaneDeadlineClock = REAL_LANE_CLOCK,
): Promise<CorpusLaneOutcome> {
  const startedAt = Date.now();
  let active = true;
  let lastProgressAt = clock.now();
  // Reads of this lane whose statement is running on a read worker now.
  let reading = 0;
  const report: SourceIndexReadProgress = Object.assign(() => {
    if (!active) return;
    lastProgressAt = clock.now();
    noteSourceAnswerProgress('searching');
  }, {
    began: () => { reading += 1; report(); },
    ended: () => { reading = Math.max(0, reading - 1); report(); },
  });
  const runValidated = async (): Promise<SourceIndexCorpusSearchResponse> => {
    const response = await run(report);
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
    } finally {
      active = false;
    }
  }

  let timer: unknown;
  const laneSettled: Promise<
    { kind: 'response'; response: SourceIndexCorpusSearchResponse } | { kind: 'error'; error: unknown }
  > = runValidated().then(
    (response) => ({ kind: 'response' as const, response }),
    (error) => ({ kind: 'error' as const, error }),
  );
  const deadline = new Promise<{ kind: 'timeout' }>((resolve) => {
    const arm = (delayMs: number) => {
      const dueAtMs = clock.now() + delayMs;
      timer = clock.setTimeout(() => {
        // A statement running on a read worker is work in progress, however
        // long it runs: the wait starts again and the answer is told.
        if (reading > 0) report();
        const now = clock.now();
        const remaining = timeoutMs - (now - lastProgressAt);
        if (remaining > 0) { arm(remaining); return; }
        if (now - dueAtMs >= HELD_THREAD_LATE_TIMER_MS) {
          arm(HELD_THREAD_GRACE_MS);
          return;
        }
        resolve({ kind: 'timeout' });
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
    active = false;
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}

export function resolveLaneTimeoutMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.OLYMPUS_SOURCE_ANSWER_LANE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_SOURCE_ANSWER_LANE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_SOURCE_ANSWER_LANE_TIMEOUT_MS;
  // Non-positive disables the idle wait.
  return parsed;
}

export function pinSourceIndexSearchReadiness(
  registry: SourceIndexCorpusRegistry,
  adapters: SourceIndexRouterAdapterMap,
  request: Pick<SourceIndexSearchRequest, 'context' | 'corpusIds' | 'families'>,
): void {
  for (const corpus of registry.list()) {
    if (!skipReasonForCorpus(corpus, request)) adapters[corpus.corpusId]?.pinVectorSearchReadiness?.();
  }
}

function skipReasonForCorpus(
  corpus: SourceIndexCorpusDefinition,
  request: Pick<SourceIndexSearchRequest, 'context' | 'corpusIds' | 'families'>,
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

// buildEvidencePack: the retrieval -> reasoning boundary (Contract 2).
//
// Retrieval (router + corpus adapters) is a hard membrane: it returns locators
// and bounded derivatives, never raw chunk text. That keeps raw source out of
// Castor-visible output, but the Analyst needs real content to reason over. So
// this builder ranks via the router, then fetches the ACTUAL content for each
// located item from a local-only content provider for that corpus.
//
// The resulting EvidencePack carries raw chunks — it is an INTERNAL artifact
// for the Analyst (local for any secure_local evidence). It is never returned
// to Castor directly: the only released products are the Analyst's bounded
// answer and, for secure_local, a redacted escalation. localOnly is derived
// downstream from any candidate being secure_local.

import type {
  EvidenceCandidate,
  EvidenceCoverage,
  EvidencePack,
  EvidenceTableBlock,
} from './contracts.ts';
import type { StructuredEvidenceFact } from './opsec.ts';
import type { SourceIndexCorpusRegistry } from './source-index/corpus.ts';
import {
  assertEvidenceCandidateModelEligible,
  SourceModelPolicyDeniedError,
} from './source-model-policy.ts';
import {
  applyPerCorpusResultBudget,
  fuseRankedCandidateLanes,
  mergeRetrievalDegradations,
} from './source-index/retrieval.ts';
import {
  routeSourceIndexSearch,
  type SourceIndexRoutedSearchHit,
  type SourceIndexRoutedSearchResponse,
  type SourceIndexRouterAdapterMap,
  type SourceIndexSearchContext,
  type SourceIndexSkippedCorpus,
} from './source-index/router.ts';
import {
  buildSourceSensitivity,
  type RetrievalDegradation,
  type RetrievalLaneAudit,
  type SourceIndexProvenance,
  type SourceItemIdentity,
  type SourceCitationMetadata,
  type SourceSensitivity,
  type SourceTrustDomain,
  type SourceTrustTier,
} from './source-index/types.ts';
import {
  observeSourceAnswerRoutedQuery,
  recordSourceAnswerHydration,
  recordSourceAnswerQueryPlannerDisposition,
} from '../workers/source-index/answer-latency-trace.ts';

// Local-only content seam. A provider returns the actual content for one
// located item from the local store, for Argus to reason over. Implementations
// MUST stay local for secure_local material and MUST NOT route that content to
// any cloud destination.
export interface LocalContentRequest {
  provenance: SourceIndexProvenance;
  trustDomain: SourceTrustDomain;
  maxChars?: number;
  query?: string;
}

export interface LocalContentBlock {
  sensitivity: SourceSensitivity;
  chunks: readonly string[];
  tables?: readonly EvidenceTableBlock[];
  facts?: readonly StructuredEvidenceFact[];
  truncated?: boolean;
  coverageGaps?: readonly string[];
  // Locator (path/url) for the item, supplied by the LOCAL provider only. The
  // routed search membrane stays path-free; the locator enters via this local
  // lane, lives on the internal pack, and reaches Castor only through the
  // gated answer's evidence/citations.
  locatorUri?: string;
}

export interface LocalContentProvider {
  fetchLocalContent(request: LocalContentRequest): Promise<LocalContentBlock | undefined>;
  // Corpus-level readability, counts only. An extraction gap can only be
  // reported for a document the router RETURNED, so the document whose one
  // unreadable page holds the answer contributes nothing: the term is not in
  // its path, its title, or any indexed page, so it never becomes a candidate.
  // This reports how much of the searched scope could not be read AT ALL,
  // matched or not. Optional: a provider that cannot answer it without walking
  // every document must omit it rather than pay that per query.
  corpusReadability?(): Promise<CorpusReadabilityCounts | undefined>;
}

// Counts only — no paths, no titles, no identifiers beyond the corpus id the
// coverage contract already carries. That is what makes this releasable beside
// a cloud-routed answer: it says how much could not be read, never what.
export interface CorpusReadabilityCounts {
  // Extraction ran and left durable gaps INSIDE the document (unread pages).
  partialDocuments: number;
  // Extraction produced no text at all: metadata-only, unsupported, oversized,
  // blocked, or failed. Not necessarily permanent — an ingest still in flight
  // looks identical from here, and for this question it means the same thing:
  // a search could not have seen inside it.
  unreadDocuments: number;
}

export interface CorpusReadabilityGap extends CorpusReadabilityCounts {
  corpusId: string;
}

export interface LocalContentProviderMap {
  readonly [corpusId: string]: LocalContentProvider | undefined;
}

export const SOURCE_MODEL_POLICY_GAP_SUFFIX =
  'excluded one candidate from model use under current source policy.';

export interface BuildEvidencePackInput {
  question: string;
  searchQuery?: string; // retrieval query when it differs from the question
  selectedItems?: readonly SelectedEvidenceItem[];
  // Optional multi-query retrieval expansion (see core/query-planner.ts): the
  // planner proposes extra phrasings for the same question, each query becomes
  // one retrieval lane, and lanes are RRF-fused. No planner = the single
  // literal query, unchanged. Planner failures fail open to that single query.
  // The planner RACES the literal retrieval rather than preceding it; a strong
  // literal run abandons it (see runRoutedSearches).
  queryPlanner?: (question: string) => Promise<readonly string[]>;
  maxResults: number;
  searchContext: SourceIndexSearchContext;
  corpusIds?: readonly string[];
  registry: SourceIndexCorpusRegistry;
  adapters: SourceIndexRouterAdapterMap;
  contentProviders: LocalContentProviderMap;
  maxCharsPerCandidate?: number;
  // Per-lane retrieval deadline handed to every routed run this build performs.
  // Omitted, the router falls back to its env-configured default. Present so a
  // caller that knows its own wall-clock budget can set one rather than reach
  // for a process-wide env var (see RouteSourceIndexSearchOptions.laneTimeoutMs).
  laneTimeoutMs?: number;
  now?: () => Date;
}

export interface SelectedEvidenceItem {
  corpusId: string;
  sourceItem: SourceItemIdentity;
  citation?: SourceCitationMetadata;
}

// Router metadata the answer surface needs for auditing, returned ALONGSIDE the
// pack rather than on it — EvidencePack is a frozen contract and stays pure.
// candidateCorpusIds is index-aligned with pack.candidates.
export interface EvidencePackBuildDetail {
  pack: EvidencePack;
  candidateCorpusIds: readonly string[];
  laneAudits: readonly RetrievalLaneAudit[];
  skippedCorpora: readonly SourceIndexSkippedCorpus[];
  // Counts-only markers for lanes that did not contribute. Merged across every
  // routed run this build performed, because a build can fan out more than
  // once (literal query plus planner expansions) and a loss on any of them is
  // a loss to the answer.
  degradations: readonly RetrievalDegradation[];
  // Kept beside the frozen EvidencePack contract. This is counts-only policy
  // state used to distinguish an ordinary empty search from evidence that was
  // deliberately removed before model dispatch.
  policyDeniedCandidates?: number;
  // Generated only by the typed policy-denial branch. Retrieval may carry
  // these safe strings forward without inspecting free-form provider coverage
  // text.
  policyDeniedCoverageGaps?: readonly string[];
  // Counts-only readability of the corpora this build SEARCHED. Populated only
  // when the pack came back with no candidates at all: with candidates in hand
  // the per-item extractionGaps are the precise instrument, and a corpus-wide
  // count would be a second, vaguer voice saying the same thing on every
  // answer. Empty when every searched corpus is fully readable, or when no
  // provider can report it cheaply.
  corpusReadabilityGaps?: readonly CorpusReadabilityGap[];
}

export async function buildEvidencePack(input: BuildEvidencePackInput): Promise<EvidencePack> {
  return (await buildEvidencePackDetailed(input)).pack;
}

export async function buildEvidencePackDetailed(
  input: BuildEvidencePackInput,
): Promise<EvidencePackBuildDetail> {
  const routed = input.selectedItems?.length
    ? selectedItemsToRoutedSlice(input)
    : await runRoutedSearches(input);
  const routedHits = input.selectedItems?.length
    ? routed.hits
    : orderHitsForTemporalIntent(routed.hits, input);

  const candidates: EvidenceCandidate[] = [];
  const candidateCorpusIds: string[] = [];
  const extractionGaps: string[] = [];
  const policyDeniedCoverageGaps: string[] = [];
  let policyDeniedCandidates = 0;

  const hydrationStartedAt = Date.now();
  const hydrated = await Promise.all(routedHits.map(async (hit) => {
    const provenance = hitProvenance(hit);
    const provider = input.contentProviders[hit.corpusId];
    let content: LocalContentBlock | undefined;
    let policyDenied = false;
    try {
      content = provider
        ? await provider.fetchLocalContent({
            provenance,
            trustDomain: hit.trustDomain,
            ...(input.maxCharsPerCandidate !== undefined ? { maxChars: input.maxCharsPerCandidate } : {}),
            query: input.searchQuery ?? input.question,
          })
        : undefined;
    } catch (error) {
      if (!(error instanceof SourceModelPolicyDeniedError)) throw error;
      policyDenied = true;
    }
    return { hit, provenance, provider, content, policyDenied };
  }));
  recordSourceAnswerHydration(Date.now() - hydrationStartedAt);

  for (const { hit, provenance, provider, content, policyDenied } of hydrated) {
    if (policyDenied) {
      policyDeniedCandidates += 1;
      const gap = `${hit.corpusId} ${SOURCE_MODEL_POLICY_GAP_SUFFIX}`;
      extractionGaps.push(gap);
      policyDeniedCoverageGaps.push(gap);
      continue;
    }

    const sensitivity =
      content?.sensitivity ??
      input.registry.get(hit.corpusId)?.defaultSensitivity ??
      conservativeSensitivity(hit.trustDomain);
    assertNoTrustDomainDowngrade(hit, sensitivity);

    const enrichedProvenance = content?.locatorUri && !provenance.citation?.uri
      ? {
          ...provenance,
          citation: { ...provenance.citation, uri: content.locatorUri },
        }
      : provenance;

    const candidate: EvidenceCandidate = {
      provenance: enrichedProvenance,
      trustTier: sensitivity.trustTier,
      trustDomain: sensitivity.trustDomain,
      chunks: content?.chunks ?? [],
      ...(content?.tables ? { tables: content.tables } : {}),
      ...(content?.facts ? { facts: content.facts } : {}),
      ...(hit.score !== undefined ? { score: hit.score } : {}),
    };
    // A provider is expected to throw the typed denial before hydration. If
    // it instead returns S5 content, that is an invariant failure: hard-stop
    // the entire build rather than misreporting it as an extraction miss.
    assertEvidenceCandidateModelEligible(candidate);
    candidates.push(candidate);
    candidateCorpusIds.push(hit.corpusId);

    const gap = extractionGapFor(hit, provider !== undefined, content);
    if (gap) extractionGaps.push(gap);
  }

  const coverage: EvidenceCoverage = {
    searchedCorpora: routed.searchedCorpora,
    skippedCorpora: routed.skippedCorpora.map((skip) => ({ corpusId: skip.corpusId, reason: skip.reason })),
    extractionGaps,
  };

  // Deliberately NOT folded into coverage.extractionGaps. Everything in that
  // list is force-folded into the answer's unanswered notes AND read into the
  // Analyst prompt, so a corpus-wide count placed there would hedge every
  // answer whose corpus holds a single unread document. It rides the detail
  // instead — the same sidecar policyDeniedCoverageGaps and degradations use —
  // and the release layer decides when it is worth saying.
  const corpusReadabilityGaps = candidates.length === 0
    ? await corpusReadabilityGapsFor(routed.searchedCorpora, input.contentProviders)
    : [];

  const builtAt = (input.now ?? (() => new Date()))().toISOString();
  return {
    pack: { question: input.question, candidates, coverage, builtAt },
    candidateCorpusIds,
    laneAudits: policyDeniedCandidates > 0
      ? contentFreePolicyLaneAudits(routed.laneAudits)
      : routed.laneAudits,
    skippedCorpora: routed.skippedCorpora,
    // Survives the policy-filter rewrite above: a degradation marker is already
    // counts-only, so there is nothing in it for that rewrite to protect, and
    // dropping it would re-hide exactly what this list exists to show.
    degradations: routed.degradations,
    policyDeniedCandidates,
    policyDeniedCoverageGaps,
    corpusReadabilityGaps,
  };
}

async function corpusReadabilityGapsFor(
  searchedCorpora: readonly string[],
  providers: LocalContentProviderMap,
): Promise<readonly CorpusReadabilityGap[]> {
  const gaps = await Promise.all([...new Set(searchedCorpora)].map(async (corpusId) => {
    let counts: CorpusReadabilityCounts | undefined;
    try {
      counts = await providers[corpusId]?.corpusReadability?.();
    } catch {
      // A coverage nicety must never be the reason an answer fails. A provider
      // that cannot report its readability is reported as not reporting it.
      return undefined;
    }
    if (!counts) return undefined;
    if (counts.partialDocuments <= 0 && counts.unreadDocuments <= 0) return undefined;
    return { corpusId, ...counts };
  }));
  return gaps.filter((gap): gap is CorpusReadabilityGap => gap !== undefined);
}

function contentFreePolicyLaneAudits(
  audits: readonly RetrievalLaneAudit[],
): readonly RetrievalLaneAudit[] {
  return audits.map((audit) => ({
    laneName: 'source_answer:policy_filtered',
    laneType: 'metadata',
    candidateCount: audit.candidateCount,
    returnedCount: audit.returnedCount,
    ...(audit.skippedReason ? { skippedReason: 'policy_filtered' } : {}),
    localOnly: audit.localOnly,
    rawExposed: audit.rawExposed,
  }));
}

function orderHitsForTemporalIntent(
  hits: readonly SourceIndexRoutedSearchHit[],
  input: BuildEvidencePackInput,
): readonly SourceIndexRoutedSearchHit[] {
  if (!hasTemporalIntent(input.question) && !hasTemporalIntent(input.searchQuery ?? '')) {
    return hits;
  }
  return [...hits].sort((left, right) => {
    const rightTime = hitCitationTime(right);
    const leftTime = hitCitationTime(left);
    if (rightTime !== leftTime) return rightTime - leftTime;
    const rightScore = right.score ?? 0;
    const leftScore = left.score ?? 0;
    if (rightScore !== leftScore) return rightScore - leftScore;
    return hitCandidateId(left).localeCompare(hitCandidateId(right));
  });
}

function hitCandidateId(hit: SourceIndexRoutedSearchHit): string {
  return String(hit.candidateId ?? `${hit.corpusId}:${hit.sourceItem.localItemId || hit.sourceItem.providerItemId}`);
}

export function hasTemporalIntent(value: string): boolean {
  const normalized = value.toLowerCase();
  // "just got/received", "right now", "today", "N minutes ago" are the chat
  // phrasings of recency (2026-07-05: "did I just get a message..." missed
  // the recent/latest/newest list and evidence stayed relevance-ordered).
  return /\b(recent|latest|newest|current|most\s+recent)\b/.test(normalized)
    || /\bjust\s+(got|get|received|receive|arrived|arrive|came|come|sent|send|landed|land)\b/.test(normalized)
    || /\bright\s+now\b/.test(normalized)
    || /\btoday\b/.test(normalized)
    || /\b(seconds?|minutes?|moments?|hours?)\s+ago\b/.test(normalized);
}

function hitCitationTime(hit: SourceIndexRoutedSearchHit): number {
  const citation = hit.provenance?.citation;
  return safeTime(citation?.authoredAt) || safeTime(citation?.updatedAt);
}

function safeTime(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// --- Multi-query retrieval ---------------------------------------------------

const MAX_SEARCH_QUERIES = 3;

// Routed-search slice the pack builder consumes. With a single query this IS
// the router response (byte-identical to the pre-planner path); with planned
// queries the hits are RRF-fused across one lane per query, lane audits are
// concatenated across runs, and coverage comes from the first run (corpus
// eligibility depends on the context, not the query text, so run 1 is
// representative).
type RoutedSearchSlice = Pick<
  SourceIndexRoutedSearchResponse,
  'hits' | 'searchedCorpora' | 'skippedCorpora' | 'laneAudits' | 'degradations'
>;

function selectedItemsToRoutedSlice(input: BuildEvidencePackInput): RoutedSearchSlice {
  const hits: SourceIndexRoutedSearchHit[] = [];
  const skippedCorpora: SourceIndexSkippedCorpus[] = [];
  const laneAudits: RetrievalLaneAudit[] = [];
  const searched = new Set<string>();

  for (const selected of input.selectedItems ?? []) {
    const corpus = input.registry.get(selected.corpusId);
    if (!corpus) {
      skippedCorpora.push({ corpusId: selected.corpusId, trustDomain: 'secure_local', reason: 'no_adapter' });
      continue;
    }
    const skipReason =
      input.corpusIds && !input.corpusIds.includes(corpus.corpusId)
        ? 'not_requested'
        : input.searchContext.allowedCorpusIds && !input.searchContext.allowedCorpusIds.includes(corpus.corpusId)
          ? 'corpus_not_allowed'
          : !input.searchContext.allowedTrustDomains.includes(corpus.trustDomain)
            ? 'trust_domain_not_allowed'
            : undefined;
    if (skipReason) {
      skippedCorpora.push({ corpusId: corpus.corpusId, trustDomain: corpus.trustDomain, reason: skipReason });
      continue;
    }
    searched.add(corpus.corpusId);
    hits.push({
      corpusId: corpus.corpusId,
      trustDomain: corpus.trustDomain,
      sourceItem: selected.sourceItem,
      provenance: {
        sourceItem: selected.sourceItem,
        ...(selected.citation ? { citation: selected.citation } : {}),
      },
      score: 1,
      rawExposed: false,
    });
  }

  for (const corpusId of searched) {
    laneAudits.push({
      laneName: `${corpusId}:selected_evidence`,
      laneType: 'metadata',
      candidateCount: hits.filter((hit) => hit.corpusId === corpusId).length,
      returnedCount: hits.filter((hit) => hit.corpusId === corpusId).length,
      backend: 'selected_evidence',
      localOnly: true,
      rawExposed: false,
    });
  }

  return {
    hits,
    searchedCorpora: [...searched],
    skippedCorpora,
    laneAudits,
    // Caller-selected items bypass retrieval entirely: no lane ran, so no lane
    // was lost. Reporting a degradation here would be a false alarm.
    degradations: [],
  };
}

// The planner completion is a multi-second LOCAL model call. Running it in
// front of retrieval taxed every answer with that cost even when the literal
// query alone would have answered (P6-L4). So: start it and the literal routed
// search together, then let the literal result decide whether its remaining
// time is worth paying for.
//
//   strong literal (>= maxResults hits) -> abandon the planner, answer from the
//                                          single run, exactly as if no planner
//                                          had been configured
//   thin literal                        -> await the planner and expand/fuse
//                                          exactly as before
//
// Nothing here reads the question's wording — the branch is purely "how many
// candidates did retrieval already return".
async function runRoutedSearches(input: BuildEvidencePackInput): Promise<RoutedSearchSlice> {
  const literalQuery = literalSearchQuery(input);
  // Kicked off BEFORE the literal search so the two overlap rather than queue.
  const pendingPlan = input.queryPlanner
    ? startQueryPlanner(input.queryPlanner, input.question)
    : undefined;

  const literalRun = await runRoutedSearch(input, literalQuery, 1);
  if (!pendingPlan) return literalRun;

  if (isStrongLiteralRun(literalRun, input.maxResults)) {
    recordSourceAnswerQueryPlannerDisposition('ignored_after_strong_literal');
    return literalRun;
  }

  const settled = await pendingPlan.settle();
  recordSourceAnswerQueryPlannerDisposition('awaited');
  if (settled.failed) recordSourceAnswerQueryPlannerDisposition('failed');

  const expansions = expansionQueries(literalQuery, settled.queries);
  if (expansions.length === 0) return literalRun;

  const runs: SourceIndexRoutedSearchResponse[] = [literalRun];
  for (const query of expansions) {
    runs.push(await runRoutedSearch(input, query, runs.length + 1));
  }

  const queries = [literalQuery, ...expansions];
  const ranked = fuseRankedCandidateLanes({
    lanes: runs.map((run, index) => ({ name: queries[index]!, items: run.hits })),
    getId: (hit) => `${hit.corpusId}:${hit.sourceItem.localItemId || hit.sourceItem.providerItemId}`,
    // Rank the whole bounded union before allocating seats by corpus. Taking
    // the cut here could discard a corpus before the shared budget sees it.
    limit: runs.reduce((total, run) => total + run.hits.length, 0),
    // Scale-free, and deliberately so. Adapter `score` is adapter-local — a
    // negated bm25 rank in one corpus, a sub-lane RRF sum in another — and RRF
    // exists precisely so those are never compared. Comparing them here decided
    // the pack cut by scoring scale rather than relevance, dropping a whole
    // corpus family from the analyst's evidence with nothing in coverage to
    // record it.
    tieBreaker: (left, right) => String(left.id).localeCompare(String(right.id)),
  });
  const { hits: fused, degradations: budgetDegradations } = applyPerCorpusResultBudget(ranked, input.maxResults);

  return {
    hits: fused,
    searchedCorpora: literalRun.searchedCorpora,
    // Coverage of WHICH corpora were eligible comes from run 1 (eligibility
    // depends on the context, not the query text). What each run LOST does
    // not: an expansion query that blew a corpus's deadline lost that corpus
    // from the fused hits just as surely as the literal query would have, and
    // keeping only literalRun's skips hid every such loss.
    skippedCorpora: mergeRoutedSkippedCorpora(runs),
    laneAudits: runs.flatMap((run) => [...run.laneAudits]),
    degradations: mergeRetrievalDegradations(...runs.map((run) => run.degradations), budgetDegradations),
  };
}

function mergeRoutedSkippedCorpora(
  runs: readonly RoutedSearchSlice[],
): readonly SourceIndexSkippedCorpus[] {
  const merged = new Map<string, SourceIndexSkippedCorpus>();
  for (const run of runs) {
    for (const skip of run.skippedCorpora) {
      merged.set(`${skip.corpusId}:${skip.reason}`, skip);
    }
  }
  return [...merged.values()];
}

function literalSearchQuery(input: BuildEvidencePackInput): string {
  return input.searchQuery?.trim() || input.question;
}

function runRoutedSearch(
  input: BuildEvidencePackInput,
  query: string,
  ordinal: number,
): Promise<SourceIndexRoutedSearchResponse> {
  return observeSourceAnswerRoutedQuery(ordinal, () =>
    routeSourceIndexSearch({
      registry: input.registry,
      adapters: input.adapters,
      request: {
        query,
        maxResults: input.maxResults,
        ...(input.corpusIds ? { corpusIds: input.corpusIds } : {}),
        context: input.searchContext,
      },
      ...(input.laneTimeoutMs !== undefined ? { laneTimeoutMs: input.laneTimeoutMs } : {}),
    }));
}

// STRONG = the literal query already filled the caller's candidate budget.
// The answer surface's real notion of "usable" needs hydrated chunks/tables/
// facts, which do not exist yet at this point; hit count is the cheap
// pre-hydration proxy, and it is the only one available at the one moment
// where skipping the planner's tail still saves wall time. An empty run is
// never strong, so maxResults of 0 cannot short-circuit the expansion.
function isStrongLiteralRun(
  run: SourceIndexRoutedSearchResponse,
  maxResults: number,
): boolean {
  return run.hits.length >= Math.max(1, Math.floor(maxResults));
}

interface SettledQueryPlan {
  queries: readonly string[];
  failed: boolean;
}

interface PendingQueryPlan {
  settle(): Promise<SettledQueryPlan>;
}

// Abandonment, not cancellation: the planner seam is a bare
// (question) => Promise<string[]> with no abort token, and its fail-open
// contract already means a caller may ignore whatever it produces. So a strong
// literal run simply never calls settle(). The swallowing handler is attached
// at start (not at abandonment) because the completion may reject before the
// literal run even returns — without it, an abandoned rejection would surface
// as an unhandled rejection.
function startQueryPlanner(
  planner: NonNullable<BuildEvidencePackInput['queryPlanner']>,
  question: string,
): PendingQueryPlan {
  const pending = (async () => planner(question))();
  pending.catch(() => {});
  return {
    async settle(): Promise<SettledQueryPlan> {
      try {
        return { queries: await pending, failed: false };
      } catch {
        return { queries: [], failed: true };
      }
    },
  };
}

// Planned expansions: deduped against the literal query and each other, capped
// so literal + expansions never exceeds MAX_SEARCH_QUERIES. Expansion is an
// enhancement and must never block evidence building.
function expansionQueries(
  literalQuery: string,
  planned: readonly string[],
): readonly string[] {
  const expansions: string[] = [];
  const seen = new Set([literalQuery.trim()]);
  for (const raw of planned) {
    if (expansions.length + 1 >= MAX_SEARCH_QUERIES) break;
    const query = raw.trim();
    if (!query || seen.has(query)) continue;
    seen.add(query);
    expansions.push(query);
  }
  return expansions;
}

function hitProvenance(hit: SourceIndexRoutedSearchHit): SourceIndexProvenance {
  return hit.provenance ?? { sourceItem: hit.sourceItem };
}

function extractionGapFor(
  hit: SourceIndexRoutedSearchHit,
  hasProvider: boolean,
  content: LocalContentBlock | undefined,
): string | undefined {
  const label = locatorLabel(hit);
  if (content?.coverageGaps?.length) return `${label} (${hit.corpusId}) ${content.coverageGaps.join('; ')}`;
  if (!hasProvider) return `${label} (${hit.corpusId}) was located but has no local content provider; not read.`;
  if (!content || content.chunks.length === 0) {
    return `${label} (${hit.corpusId}) was located but no extractable content was available.`;
  }
  if (content.truncated) return `${label} (${hit.corpusId}) content was truncated for length.`;
  return undefined;
}

function locatorLabel(hit: SourceIndexRoutedSearchHit): string {
  const citation = hit.provenance?.citation;
  const item = hit.sourceItem;
  return (
    citation?.title?.trim() ||
    citation?.uri?.trim() ||
    `${item.provider}/${item.family}:${item.providerItemId || item.localItemId}`
  );
}

// Fallback only when neither the content provider nor the corpus registry knows
// the item's sensitivity. Bias toward MORE restrictive: an unknown domain is
// treated as secure_local so it can never be under-classified into a cloud lane.
function conservativeSensitivity(trustDomain: SourceTrustDomain): SourceSensitivity {
  return buildSourceSensitivity({ trustTier: conservativeTierForDomain(trustDomain), trustDomain });
}

function conservativeTierForDomain(trustDomain: SourceTrustDomain): SourceTrustTier {
  if (trustDomain === 'public_safe') return 'S0';
  if (trustDomain === 'internal') return 'S3';
  return 'S4';
}

function assertNoTrustDomainDowngrade(
  hit: SourceIndexRoutedSearchHit,
  sensitivity: SourceSensitivity,
): void {
  const routedRank = trustDomainRank(hit.trustDomain);
  const contentRank = trustDomainRank(sensitivity.trustDomain);
  if (contentRank < routedRank) {
    throw new Error(
      `Local content provider downgraded ${hit.corpusId} from ${hit.trustDomain} to ${sensitivity.trustDomain}.`,
    );
  }
}

function trustDomainRank(trustDomain: SourceTrustDomain): number {
  if (trustDomain === 'public_safe') return 0;
  if (trustDomain === 'internal') return 1;
  return 2;
}

import { withKeywordRequestScope } from './source-index/keyword-context.ts';
import {
  rerankCandidates,
  rerankPassage,
  rerankPoolSize,
  type EvidenceRerankAudit,
  type EvidenceReranker,
  type RerankTimers,
} from './evidence-reranker.ts';
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
  EvidenceCoverageMatchCount,
  EvidencePack,
  EvidenceTableBlock,
} from './contracts.ts';
import type { StructuredEvidenceFact } from './opsec.ts';
import {
  applyParentLabels,
  type ParentLabelDependency,
  type ParentLabelResolver,
} from './parent-label.ts';
import type { SourceIndexCorpusRegistry } from './source-index/corpus.ts';
import {
  assertEvidenceCandidateModelEligible,
  assertModelTrustTierAllowed,
  SourceModelPolicyDeniedError,
} from './source-model-policy.ts';
import {
  applyPerCorpusResultBudget,
  fuseRankedCandidateLanes,
  mergeRetrievalDegradations,
} from './source-index/retrieval.ts';
import {
  resolveAskSearchBudgetMs,
  resolveLaneTimeoutMs,
  routeSourceIndexSearch,
  type SourceIndexRoutedCorpusTiming,
  type SourceIndexRoutedMatchCount,
  type SourceIndexRoutedSearchHit,
  type SourceIndexRoutedSearchResponse,
  type SourceIndexRouterAdapterMap,
  type SourceIndexSearchContext,
  type SourceIndexSkippedCorpus,
  type SourceIndexVisibilityGate,
} from './source-index/router.ts';
import {
  buildSourceSensitivity,
  isSecureSensitivity,
  SOURCE_TRUST_TIERS,
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
  /**
   * For an item longer than `maxChars`: at most this many of its passages
   * (the provider's own small default otherwise). A caller reading one item
   * in depth raises it so the budget is filled with the item's text.
   */
  maxPassages?: number;
}

export interface LocalContentBlock {
  sensitivity: SourceSensitivity;
  chunks: readonly string[];
  tables?: readonly EvidenceTableBlock[];
  facts?: readonly StructuredEvidenceFact[];
  truncated?: boolean;
  coverageGaps?: readonly string[];
  // The owner chose to keep this item's contents unread (a folder set to
  // Names only, or a metadata-only ingestion rule). Its name still matches;
  // its missing text is a settled choice, not a failed read, and coverage
  // reports it apart from items Olympus genuinely could not read.
  namesOnly?: boolean;
  // The item's contents are tiered Private (held by a secure_local copy) and
  // only its name is in this tier. Not a failed read and not a Names-only
  // choice: coverage counts it apart from both.
  contentPrivate?: boolean;
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
  // Total UTF-8 byte budget for hydrated evidence text across the whole pack.
  // Bytes, not characters: model transports and argv ceilings are byte
  // limits, and the same character count is 1x bytes in ASCII, 2x in
  // Cyrillic, 3x in CJK. Each located item gets an equal share (never more
  // than maxCharsPerCandidate, never less than MIN_BYTES_PER_CANDIDATE), so a
  // broad question carries many short passages and a narrow one a few long
  // ones, inside the same prompt size. Omitted, only maxCharsPerCandidate
  // bounds each candidate, as before.
  evidenceByteBudget?: number;
  // Per-lane retrieval deadline handed to every routed run this build performs.
  // Omitted, the router falls back to its env-configured default. Present so a
  // caller that knows its own wall-clock budget can set one rather than reach
  // for a process-wide env var (see RouteSourceIndexSearchOptions.laneTimeoutMs).
  laneTimeoutMs?: number;
  // Wall-clock budget for all of this build's routed runs together (the
  // literal query and any planner expansions, which run one after another).
  // Each run's lanes get at most what is left of it; an expansion is not
  // started once it is spent. Omitted, OLYMPUS_SOURCE_ANSWER_SEARCH_BUDGET_MS
  // or the router's default. Non-positive disables it.
  searchBudgetMs?: number;
  // See SourceIndexVisibilityGate: one tier-ledger snapshot over every routed run's hits.
  visibilityGate?: SourceIndexVisibilityGate;
  /**
   * Location-only lookup of Secrets matching the question (design section
   * 2.3). Its results ride BESIDE the pack in the build detail; they never
   * enter the pack, so no model ever sees them.
   */
  // Scoped by the caller to the corpora this build actually searched (and the
  // account and approved scope each was searched under).
  secretLocations?: (query: string, searchedCorpora: readonly string[]) => readonly SecretLocationNote[];
  // Counts of items still pending classification in the searched corpora.
  classificationCoverage?: (searchedCorpora: readonly string[]) => readonly ClassificationCoverageNote[];
  /**
   * A child item's parent, found for the labels its citation carries
   * (core/parent-label.ts). A label is attached only when the parent's names
   * may go wherever the candidate goes, under this request's scope; an
   * unauthorized label never enters the pack. Absent: no candidate has one.
   */
  parentLabels?: ParentLabelResolver;
  // Leave out every candidate that is secure by isSecureSensitivity (an S4
  // item in an ordinary corpus included), with its extraction gap: the
  // ordinary-route rebuild after the private route was unavailable.
  excludeSecureSensitivity?: boolean;
  /**
   * Local cross-encoder that reorders the fused candidates before the cut
   * (core/evidence-reranker.ts). Retrieval then returns its pool, every pool
   * candidate is read, and the reranker's best maxResults make the pack.
   * Absent (the default): the fused order and cut, unchanged. Not applied to
   * caller-selected items or to a question about recency, whose order is
   * already decided.
   */
  reranker?: EvidenceReranker;
  rerankTimers?: RerankTimers;
  now?: () => Date;
}

// Where a Secret lives. Location only: never content.
export interface SecretLocationNote {
  source: string;
  // Opaque, stable reference; the only handle for an item whose metadata is Private.
  ref: string;
  locator: string | null;
  title: string | null;
  findingKinds: readonly string[];
}

// The screened location an owner-only saved answer must revalidate on read.
export interface SavedSecretLocation { source: string; ref: string; fingerprint: string }

// Items stored and keyword-searchable but not yet final (not embedded).
export interface ClassificationCoverageNote {
  corpusId: string;
  pendingClassificationItems: number;
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
  // Members of laneAudits (by object identity) from a corpus that contributed
  // anything secure (router.ts secureLaneAudits). Kept whole here for
  // diagnostics; an answer analyzed on an ordinary route does not return them.
  secureLaneAudits: readonly RetrievalLaneAudit[];
  skippedCorpora: readonly SourceIndexSkippedCorpus[];
  // Counts-only markers for lanes that did not contribute. Merged across every
  // routed run this build performed, because a build can fan out more than
  // once (literal query plus planner expansions) and a loss on any of them is
  // a loss to the answer.
  degradations: readonly RetrievalDegradation[];
  // How long each corpus search took and whether it beat the lane deadline,
  // across every routed run of this build. Counts only.
  corpusTimings?: readonly SourceIndexRoutedCorpusTiming[];
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
  // Indexes into pack.candidates whose contents the owner keeps unread on
  // purpose (LocalContentBlock.namesOnly). Counts and indexes only.
  namesOnlyCandidateIndexes?: readonly number[];
  // Indexes into pack.candidates whose contents are tiered Private
  // (LocalContentBlock.contentPrivate). Counts and indexes only.
  contentPrivateCandidateIndexes?: readonly number[];
  // Located candidates with no readable content for a reason other than the
  // owner's Names only choice: no provider, nothing returned, or no text.
  // Truncated and policy-denied candidates are not counted here.
  unreadCandidates?: number;
  // The parents whose names a candidate's citation carries as its parent
  // label, beside the pack by the same precedent: each is a release input of
  // the answer written from this pack (ReleaseInput.layer = 'names'). Absent
  // when no candidate carries a label.
  parentLabelDependencies?: readonly ParentLabelDependency[];
  // Four-tier classification (P1b), beside the pack by the same precedent:
  // Secrets that matched the question, by location only, and counts of
  // searched items whose tier is not final yet. Neither enters the pack, so
  // neither reaches the Analyst.
  secretLocations?: readonly SecretLocationNote[];
  classificationCoverage?: readonly ClassificationCoverageNote[];
  // True when this build met secure material anywhere (isSecureSensitivity):
  // in any routed run of the build, before its visibility gate, budget or
  // trim (router.ts encounteredSecureLocal: a secure corpus's hit or positive
  // count, or a count reporting secure or unknown rows); a hydrated candidate
  // (provider upgrades included) or its cached facts; or a policy-denied item
  // (classification unknown, so counted). Its candidates, gaps and counts
  // reach the model through every leg's pack whatever fitting keeps, so the
  // release gate reads this rather than tracking what a leg was shown. A
  // Private corpus that was skipped or matched nothing contributed no text and
  // does not set it. Each build has its own flag: a rebuild starts clean.
  encounteredSecureLocal: boolean;
  // Counts only: whether the reranker ran and what it changed. Absent when no
  // reranker was configured or it did not apply to this build.
  rerank?: EvidenceRerankAudit;
}

export async function buildEvidencePack(input: BuildEvidencePackInput): Promise<EvidencePack> {
  return (await buildEvidencePackDetailed(input)).pack;
}

export async function buildEvidencePackDetailed(input: BuildEvidencePackInput): Promise<EvidencePackBuildDetail> {
  return withKeywordRequestScope(() => buildPreparedEvidencePackDetailed(input));
}

async function buildPreparedEvidencePackDetailed(
  input: BuildEvidencePackInput,
): Promise<EvidencePackBuildDetail> {
  const reranker = input.reranker && !input.selectedItems?.length
    && !hasTemporalIntent(input.question) && !hasTemporalIntent(input.searchQuery ?? '')
    ? input.reranker
    : undefined;
  const retrievalLimit = reranker ? rerankPoolSize(reranker, input.maxResults) : input.maxResults;
  const routed = input.selectedItems?.length
    ? selectedItemsToRoutedSlice(input)
    : await runRoutedSearches(input, retrievalLimit);
  // A build can fan out more than once (the literal query plus planner
  // expansions), and each routed run judged its hits against its own ledger
  // snapshot. One more pass over the merged hits puts the whole pack on ONE
  // snapshot, so a move that flipped between two runs cannot put both copies
  // of an item in the pack.
  const visibleHits = input.visibilityGate && !input.selectedItems?.length
    ? input.visibilityGate(routed.hits)
    : routed.hits;
  const routedHits = input.selectedItems?.length
    ? routed.hits
    : orderHitsForTemporalIntent(visibleHits, input);

  const candidates: EvidenceCandidate[] = [];
  const candidateCorpusIds: string[] = [];
  const extractionGaps: string[] = semanticLaneSkippedGaps(routed.degradations, input);
  const policyDeniedCoverageGaps: string[] = [];
  let policyDeniedCandidates = 0;
  const namesOnlyCandidateIndexes: number[] = [];
  const contentPrivateCandidateIndexes: number[] = [];
  let unreadCandidates = 0;
  // An exclusion rebuild is judged by what it keeps, not by what the router
  // met: every secure candidate and every secure-inclusive count is left out
  // below, so only what remains (and a policy denial) can set its flag.
  let encounteredSecureLocal = input.excludeSecureSensitivity ? false : routed.encounteredSecureLocal;

  const hydrationStartedAt = Date.now();
  // A reranked build reads its whole pool but keeps only maxResults, so each
  // kept candidate gets the share it would have had without the pool.
  const maxBytesPerCandidate = evidenceBytesPerCandidate(
    reranker ? Math.min(routedHits.length, input.maxResults) : routedHits.length,
    input.maxCharsPerCandidate,
    input.evidenceByteBudget,
  );
  // A byte share is also a character ceiling (a character is at least one
  // byte), so providers can keep their character contract; the returned
  // chunks are then clipped to the byte share below.
  const maxCharsPerCandidate = maxBytesPerCandidate;
  const pool = await Promise.all(routedHits.map(async (hit) => {
    const provenance = hitProvenance(hit);
    const provider = input.contentProviders[hit.corpusId];
    let content: LocalContentBlock | undefined;
    let policyDenied = false;
    try {
      content = provider
        ? await provider.fetchLocalContent({
            provenance,
            trustDomain: hit.trustDomain,
            ...(maxCharsPerCandidate !== undefined ? { maxChars: maxCharsPerCandidate } : {}),
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

  const sensitivityOf = (entry: (typeof pool)[number]) =>
    entry.content?.sensitivity ?? hitFallbackSensitivity(
      entry.hit,
      input.registry.get(entry.hit.corpusId)?.defaultSensitivity
        ?? conservativeSensitivity(entry.hit.trustDomain),
    );

  let hydrated = pool;
  let rerank: EvidenceRerankAudit | undefined;
  if (reranker && pool.length > 0) {
    // The reranker is a model, so every pooled item passes the same model
    // policy the pack does BEFORE any text reaches it, not only the items
    // that survive the cut: S5 content hard-stops the build here.
    const scorable: typeof pool = [];
    const denied: typeof pool = [];
    for (const entry of pool) {
      if (entry.policyDenied) {
        denied.push(entry);
        continue;
      }
      const sensitivity = sensitivityOf(entry);
      assertNoTrustDomainDowngrade(entry.hit, sensitivity);
      assertModelTrustTierAllowed(sensitivity.trustTier);
      for (const fact of entry.content?.facts ?? []) assertModelTrustTierAllowed(fact.sensitivity.trustTier);
      if (isSecureSensitivity(sensitivity)) {
        // An exclusion rebuild drops secure items below, so they are not scored.
        if (input.excludeSecureSensitivity) continue;
        // The reranker reads every scorable item, so secure text it reads
        // counts even when the cut drops it.
        encounteredSecureLocal = true;
      }
      scorable.push(entry);
    }
    const reranked = await rerankCandidates({
      reranker,
      query: literalSearchQuery(input),
      items: scorable,
      passageOf: (entry) => rerankPassage(entry.provenance.citation?.title, entry.content?.chunks ?? []),
      keep: input.maxResults,
      ...(input.rerankTimers ? { timers: input.rerankTimers } : {}),
    });
    // Denied items carry no text, but every one is still counted below, so the
    // policy gap and the content-free lane audits do not depend on the cut.
    hydrated = [...denied, ...reranked.kept];
    rerank = reranked.audit;
  }

  for (const { hit, provenance, provider, content, policyDenied } of hydrated) {
    if (policyDenied) {
      encounteredSecureLocal = true;
      policyDeniedCandidates += 1;
      const gap = `${hit.corpusId} ${SOURCE_MODEL_POLICY_GAP_SUFFIX}`;
      extractionGaps.push(gap);
      policyDeniedCoverageGaps.push(gap);
      continue;
    }

    // No provider answered for this item: judge it by its own tier when the
    // hit carries one, never by a lower corpus default; an item of unknown
    // tier is judged S4 (secure by isSecureSensitivity), so its title never
    // reaches an ordinary analyst or ordinary released evidence.
    const sensitivity = sensitivityOf({ hit, provenance, provider, content, policyDenied });
    assertNoTrustDomainDowngrade(hit, sensitivity);

    const enrichedProvenance = content?.locatorUri && !provenance.citation?.uri
      ? {
          ...provenance,
          citation: { ...provenance.citation, uri: content.locatorUri },
        }
      : provenance;

    const chunks = content?.chunks ?? [];
    const candidate: EvidenceCandidate = {
      provenance: enrichedProvenance,
      trustTier: sensitivity.trustTier,
      trustDomain: sensitivity.trustDomain,
      chunks: input.evidenceByteBudget !== undefined && maxBytesPerCandidate !== undefined
        ? clipChunksToUtf8Bytes(chunks, maxBytesPerCandidate)
        : chunks,
      ...(content?.tables ? { tables: content.tables } : {}),
      ...(content?.facts ? { facts: content.facts } : {}),
      ...(hit.score !== undefined ? { score: hit.score } : {}),
    };
    // A provider is expected to throw the typed denial before hydration. If
    // it instead returns S5 content, that is an invariant failure: hard-stop
    // the entire build rather than misreporting it as an extraction miss.
    assertEvidenceCandidateModelEligible(candidate);
    if (isSecureSensitivity(candidate)) {
      if (input.excludeSecureSensitivity) continue;
      encounteredSecureLocal = true;
    }
    if (content?.namesOnly === true) namesOnlyCandidateIndexes.push(candidates.length);
    else if (content?.contentPrivate === true) contentPrivateCandidateIndexes.push(candidates.length);
    else if (!provider || !content || content.chunks.length === 0) unreadCandidates += 1;
    candidates.push(candidate);
    candidateCorpusIds.push(hit.corpusId);

    const gap = extractionGapFor(hit, provider !== undefined, content);
    if (gap) extractionGaps.push(gap);
  }

  const matchCounts = coverageMatchCounts(
    routed.matchCounts,
    candidateCorpusIds,
    candidates.some((candidate) => isSecureSensitivity(candidate)),
  );
  const coverage: EvidenceCoverage = {
    searchedCorpora: routed.searchedCorpora,
    skippedCorpora: routed.skippedCorpora.map((skip) => ({ corpusId: skip.corpusId, reason: skip.reason })),
    extractionGaps,
    ...(matchCounts.length > 0 ? { matchCounts } : {}),
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

  const secretLocations = input.secretLocations?.(input.searchQuery ?? input.question, routed.searchedCorpora) ?? [];
  const classificationCoverage = (input.classificationCoverage?.(routed.searchedCorpora) ?? [])
    .filter((note) => note.pendingClassificationItems > 0);

  // The parent labels come last, from the final candidates: the labels are
  // authorized per candidate against the request's own scope, so an
  // unauthorized one is never in the pack any leg is dispatched with.
  const labelled = applyParentLabels(candidates, candidateCorpusIds, input.parentLabels, {
    allowedTrustDomains: input.searchContext.allowedTrustDomains,
    ...(input.searchContext.allowedCorpusIds ? { allowedCorpusIds: input.searchContext.allowedCorpusIds } : {}),
    // A corpus without an adapter is one this request leaves out (owner's read scope, request scope).
    domainOf: (corpusId) => (Object.hasOwn(input.adapters, corpusId) ? input.registry.get(corpusId)?.trustDomain : undefined),
  });

  const builtAt = (input.now ?? (() => new Date()))().toISOString();
  const laneAudits = policyDeniedCandidates > 0
    ? contentFreePolicyLaneAudits(routed.laneAudits)
    : routed.laneAudits;
  // The policy rewrite maps audits one to one, so the secure ones keep their
  // place.
  const secureRouted = new Set(routed.secureLaneAudits);
  const secureLaneAudits = laneAudits.filter((_, index) => secureRouted.has(routed.laneAudits[index]!));
  return {
    pack: { question: input.question, candidates: labelled.candidates, coverage, builtAt },
    candidateCorpusIds,
    laneAudits,
    secureLaneAudits,
    skippedCorpora: routed.skippedCorpora,
    // Survives the policy-filter rewrite above: a degradation marker is already
    // counts-only, so there is nothing in it for that rewrite to protect, and
    // dropping it would re-hide exactly what this list exists to show.
    degradations: routed.degradations,
    ...(routed.corpusTimings && routed.corpusTimings.length > 0 ? { corpusTimings: routed.corpusTimings } : {}),
    policyDeniedCandidates,
    policyDeniedCoverageGaps,
    corpusReadabilityGaps,
    namesOnlyCandidateIndexes,
    contentPrivateCandidateIndexes,
    unreadCandidates,
    encounteredSecureLocal,
    ...(rerank ? { rerank } : {}),
    ...(labelled.dependencies.length > 0 ? { parentLabelDependencies: labelled.dependencies } : {}),
    ...(secretLocations.length > 0 ? { secretLocations } : {}),
    ...(classificationCoverage.length > 0 ? { classificationCoverage } : {}),
  };
}

// Floor for one candidate's share of the evidence budget: below this a
// passage stops carrying a usable sentence of context.
const MIN_BYTES_PER_CANDIDATE = 400;

export function evidenceBytesPerCandidate(
  candidateCount: number,
  maxCharsPerCandidate: number | undefined,
  evidenceByteBudget: number | undefined,
): number | undefined {
  if (evidenceByteBudget === undefined || !Number.isFinite(evidenceByteBudget) || evidenceByteBudget <= 0) {
    return maxCharsPerCandidate;
  }
  const share = Math.max(
    MIN_BYTES_PER_CANDIDATE,
    Math.floor(evidenceByteBudget / Math.max(1, candidateCount)),
  );
  return maxCharsPerCandidate === undefined ? share : Math.min(maxCharsPerCandidate, share);
}

const utf8 = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return utf8.encode(text).length;
}

// Keep whole chunks while they fit, then cut the next one at a code-point
// boundary so the kept text is at most maxBytes of UTF-8.
export function clipChunksToUtf8Bytes(chunks: readonly string[], maxBytes: number): string[] {
  const kept: string[] = [];
  let remaining = Math.max(0, Math.floor(maxBytes));
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const bytes = utf8ByteLength(chunk);
    if (bytes <= remaining) {
      kept.push(chunk);
      remaining -= bytes;
      continue;
    }
    let cut = '';
    let used = 0;
    for (const codePoint of chunk) {
      const size = utf8ByteLength(codePoint);
      if (used + size > remaining) break;
      cut += codePoint;
      used += size;
    }
    if (cut) kept.push(cut);
    break;
  }
  return kept;
}

// Private corpora's counts ride only on a pack that already holds private
// evidence, because only such a pack is routed to the private analyst lane.
// A pack with no secure_local candidate may go to an ordinary cloud analyst,
// and even a count of private matches must not reach it.
// The count rule, decided once here so every consumer gets it: a count is
// secure-inclusive when its corpus is secure_local, or its rows include a
// secure item, or it does not report row sensitivity (secureMatchedItems
// missing). A pack with a secure candidate goes to the secure pool and keeps
// every count. Any other pack (an ordinary route, an exclusion rebuild) drops
// secure-inclusive counts whole rather than restating a remainder: the
// readable-content split of the secure rows is not carried, so a remainder
// could not be restated exactly. So a pack carries secure-derived coverage
// exactly when it holds a secure candidate, which is what `localOnly` and
// private_context_used read.
function coverageMatchCounts(
  counts: readonly SourceIndexRoutedMatchCount[] | undefined,
  candidateCorpusIds: readonly string[],
  packHasSecureLocal: boolean,
): EvidenceCoverageMatchCount[] {
  return (counts ?? [])
    .filter((count) => packHasSecureLocal || !countIsSecureInclusive(count))
    .map((count) => {
    const inEvidence = candidateCorpusIds.filter((corpusId) => corpusId === count.corpusId).length;
    return {
      corpusId: count.corpusId,
      family: count.family,
      // The pack can hold an item the count probe missed (a semantic-only
      // match), so the count never reads below what the evidence shows.
      matchedItems: Math.max(count.matchedItems, inEvidence),
      contentMatchedItems: count.contentMatchedItems,
      atLeast: count.saturated,
      inEvidence,
    };
  });
}

function countIsSecureInclusive(count: SourceIndexRoutedMatchCount): boolean {
  return isSecureSensitivity(count)
    || count.secureMatchedItems === undefined
    || count.secureMatchedItems > 0;
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
  'hits' | 'searchedCorpora' | 'skippedCorpora' | 'laneAudits' | 'degradations' | 'matchCounts'
  | 'encounteredSecureLocal' | 'secureLaneAudits'
> & Partial<Pick<SourceIndexRoutedSearchResponse, 'corpusTimings'>>;

function selectedItemsToRoutedSlice(input: BuildEvidencePackInput): RoutedSearchSlice {
  const hits: SourceIndexRoutedSearchHit[] = [];
  const skippedCorpora: SourceIndexSkippedCorpus[] = [];
  const laneAudits: RetrievalLaneAudit[] = [];
  const searched = new Set<string>();
  let encounteredSecureLocal = false;

  for (const selected of input.selectedItems ?? []) {
    const corpus = input.registry.get(selected.corpusId);
    if (!corpus) {
      // Skipped whole: no hit, no candidate, no title. Only the caller's own
      // corpus id and a reason code reach coverage, so it sets no flag.
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
    if (isSecureSensitivity(corpus.defaultSensitivity)) encounteredSecureLocal = true;
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

  const secureLaneAudits: RetrievalLaneAudit[] = [];
  for (const corpusId of searched) {
    const audit: RetrievalLaneAudit = {
      laneName: `${corpusId}:selected_evidence`,
      laneType: 'metadata',
      candidateCount: hits.filter((hit) => hit.corpusId === corpusId).length,
      returnedCount: hits.filter((hit) => hit.corpusId === corpusId).length,
      backend: 'selected_evidence',
      localOnly: true,
      rawExposed: false,
    };
    laneAudits.push(audit);
    const corpus = input.registry.get(corpusId);
    if (corpus && isSecureSensitivity(corpus.defaultSensitivity)) secureLaneAudits.push(audit);
  }

  return {
    hits,
    searchedCorpora: [...searched],
    skippedCorpora,
    laneAudits,
    secureLaneAudits,
    // Caller-selected items bypass retrieval entirely: no lane ran, so no lane
    // was lost. Reporting a degradation here would be a false alarm.
    degradations: [],
    // A selected hit carries no tier of its own; hydration below judges it
    // again (an item no provider answers for counts as secure).
    encounteredSecureLocal,
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
async function runRoutedSearches(
  input: BuildEvidencePackInput,
  retrievalLimit: number = input.maxResults,
): Promise<RoutedSearchSlice> {
  const literalQuery = literalSearchQuery(input);
  // Kicked off BEFORE the literal search so the two overlap rather than queue.
  const pendingPlan = input.queryPlanner
    ? startQueryPlanner(input.queryPlanner, input.question)
    : undefined;

  const budget = searchBudget(input);
  const literalRun = await runRoutedSearch(input, literalQuery, 1, retrievalLimit, budget.firstLaneTimeoutMs());
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
    // A spent budget answers from the runs already made; the literal run's
    // lanes that ran out of time are already in its skippedCorpora.
    const laneTimeoutMs = budget.laneTimeoutMs();
    if (laneTimeoutMs === undefined) {
      recordSourceAnswerQueryPlannerDisposition('search_budget_spent');
      break;
    }
    runs.push(await runRoutedSearch(input, query, runs.length + 1, retrievalLimit, laneTimeoutMs));
  }
  if (runs.length === 1) return literalRun;

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
  const { hits: fused, degradations: budgetDegradations } = applyPerCorpusResultBudget(ranked, retrievalLimit);

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
    secureLaneAudits: runs.flatMap((run) => [...run.secureLaneAudits]),
    degradations: mergeRetrievalDegradations(...runs.map((run) => run.degradations), budgetDegradations),
    corpusTimings: runs.flatMap((run) => [...(run.corpusTimings ?? [])]),
    // The literal question's counts, not a merge across planner rephrasings:
    // the breadth reported is for what the owner asked.
    ...(literalRun.matchCounts ? { matchCounts: literalRun.matchCounts } : {}),
    // Every run of this build, expansions included: what any of them met.
    encounteredSecureLocal: runs.some((run) => run.encounteredSecureLocal),
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

// Below this much left of the search budget, an expansion is not worth starting.
const MIN_EXPANSION_BUDGET_MS = 1_000;

/**
 * The lane timeout for the next routed run: the per-lane timeout, cut to what
 * is left of the whole search budget. An expansion gets undefined once too
 * little is left to start it; the literal run always starts.
 */
function searchBudget(input: BuildEvidencePackInput): {
  firstLaneTimeoutMs(): number;
  laneTimeoutMs(): number | undefined;
} {
  const lane = resolveLaneTimeoutMs(input.laneTimeoutMs);
  const total = resolveAskSearchBudgetMs(input.searchBudgetMs);
  const startedAt = Date.now();
  const cut = (left: number) => (Number.isFinite(lane) && lane > 0 ? Math.min(lane, left) : left);
  const left = () => Math.max(1, total - (Date.now() - startedAt));
  const unbounded = !Number.isFinite(total) || total <= 0;
  return {
    firstLaneTimeoutMs: () => (unbounded ? lane : cut(left())),
    laneTimeoutMs() {
      if (unbounded) return lane;
      // A disabled lane timeout (non-positive) still ends at the search budget.
      return left() < MIN_EXPANSION_BUDGET_MS ? undefined : cut(left());
    },
  };
}

function runRoutedSearch(
  input: BuildEvidencePackInput,
  query: string,
  ordinal: number,
  maxResults: number,
  laneTimeoutMs: number,
): Promise<SourceIndexRoutedSearchResponse> {
  return observeSourceAnswerRoutedQuery(ordinal, () =>
    routeSourceIndexSearch({
      registry: input.registry,
      adapters: input.adapters,
      request: {
        query,
        maxResults,
        ...(input.corpusIds ? { corpusIds: input.corpusIds } : {}),
        context: input.searchContext,
      },
      laneTimeoutMs,
      ...(input.visibilityGate ? { visibilityGate: input.visibilityGate } : {}),
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

/**
 * A semantic lane that should have run for this question and did not (its
 * query embedding failed, timed out or came back unusable, or its vectors
 * could not be read): the corpus was searched by keyword only, so a
 * meaning-based match may be missing (#1172). It goes in coverage, where the
 * Analyst reads it and the answer's unanswered notes carry it, because an
 * answer built without it looks complete when it is not. Per question, never
 * per corpus: a corpus that simply has no vectors yet (semantic_lane_unservable)
 * or answers by keyword by design (semantic_lane_not_run) is not a gap here.
 * Counts only: the corpus id and the lane's own stable reason token.
 */
export function semanticLaneSkippedGap(corpusId: string, detail: string | undefined): string {
  return `${corpusId}: the meaning-based search was skipped for this question`
    + `${detail ? ` (${detail})` : ''}; only keyword matches were searched, so related items may be missing.`;
}

function semanticLaneSkippedGaps(
  degradations: readonly RetrievalDegradation[],
  input: BuildEvidencePackInput,
): string[] {
  const gaps: string[] = [];
  const seen = new Set<string>();
  for (const degradation of degradations) {
    if (degradation.reason !== 'semantic_lane_skipped') continue;
    const corpusId = degradation.laneName.endsWith(':semantic')
      ? degradation.laneName.slice(0, -':semantic'.length)
      : degradation.laneName;
    // A rebuild that leaves secure content out leaves its lanes' notes out too.
    if (input.excludeSecureSensitivity && input.registry.get(corpusId)?.trustDomain === 'secure_local') continue;
    if (seen.has(corpusId)) continue;
    seen.add(corpusId);
    gaps.push(semanticLaneSkippedGap(corpusId, degradation.detail));
  }
  return gaps;
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

// The corpus default, raised to the hit's own tier when that is stricter. A
// hit with no tier of its own is raised to S4: unknown counts as secure.
function hitFallbackSensitivity(
  hit: SourceIndexRoutedSearchHit,
  corpusDefault: SourceSensitivity,
): SourceSensitivity {
  const tier = hit.trustTier ?? 'S4';
  if (SOURCE_TRUST_TIERS.indexOf(tier) <= SOURCE_TRUST_TIERS.indexOf(corpusDefault.trustTier)) {
    return corpusDefault;
  }
  return buildSourceSensitivity({ trustTier: tier, trustDomain: corpusDefault.trustDomain });
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

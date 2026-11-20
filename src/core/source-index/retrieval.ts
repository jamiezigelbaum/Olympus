import type {
  RetrievalDegradation,
  RetrievalLaneAudit,
  SourceIndexCandidateId,
} from './types.ts';

export type { SourceIndexCandidateId } from './types.ts';

export interface RankedCandidateLane<T> {
  name: string;
  items: readonly T[];
  weight?: number;
}

export interface FusedRankedCandidate<T> {
  id: SourceIndexCandidateId;
  item: T;
  score: number;
  laneRanks: ReadonlyMap<string, number>;
}

export interface FuseRankedCandidateLanesOptions<T> {
  lanes: readonly RankedCandidateLane<T>[];
  getId: (item: T) => SourceIndexCandidateId;
  limit: number;
  tieBreaker?: (left: FusedRankedCandidate<T>, right: FusedRankedCandidate<T>) => number;
  rrfK?: number;
}

const DEFAULT_RRF_K = 60;

export type SourceIndexDeclaredRetrievalMode = 'lexical_only' | 'hybrid_shadow' | 'hybrid_primary';
export type SourceIndexServableRetrievalMode = 'keyword' | 'hybrid';
export type SourceIndexRetrievalHealth = 'ready' | 'degraded';
export type SourceIndexHybridUnservableReason =
  | 'embedding_provider_unavailable'
  | 'embedding_provider_not_allowed'
  | 'no_current_embedding_artifacts'
  | 'embedding_epoch_stale'
  | 'hybrid_capability_unreported';

export interface SourceIndexRetrievalState {
  declaredMode: SourceIndexDeclaredRetrievalMode;
  servableMode: SourceIndexServableRetrievalMode;
  health: SourceIndexRetrievalHealth;
  reason?: SourceIndexHybridUnservableReason;
  modelId?: string;
  embeddingEpoch?: string;
  backend?: string;
}

export interface SourceIndexHybridAvailability {
  servable: boolean;
  reason?: SourceIndexHybridUnservableReason;
  modelId?: string;
  embeddingEpoch?: string;
  backend?: string;
  // Provider name of the serving embedder; with backend it decides Private-content approval.
  provider?: string;
}

export function assessSourceIndexRetrievalState(input: {
  declaredMode: SourceIndexDeclaredRetrievalMode;
  hybridAvailability?: SourceIndexHybridAvailability;
}): SourceIndexRetrievalState {
  if (input.declaredMode === 'lexical_only') {
    return {
      declaredMode: input.declaredMode,
      servableMode: 'keyword',
      health: 'ready',
    };
  }

  const availability = input.hybridAvailability;
  if (availability?.servable === true) {
    return {
      declaredMode: input.declaredMode,
      servableMode: 'hybrid',
      health: 'ready',
      ...(availability.modelId ? { modelId: availability.modelId } : {}),
      ...(availability.embeddingEpoch ? { embeddingEpoch: availability.embeddingEpoch } : {}),
      ...(availability.backend ? { backend: availability.backend } : {}),
    };
  }

  return {
    declaredMode: input.declaredMode,
    servableMode: 'keyword',
    health: 'degraded',
    reason: availability?.reason ?? 'hybrid_capability_unreported',
    ...(availability?.modelId ? { modelId: availability.modelId } : {}),
    ...(availability?.embeddingEpoch ? { embeddingEpoch: availability.embeddingEpoch } : {}),
    ...(availability?.backend ? { backend: availability.backend } : {}),
  };
}

export function sourceIndexRetrievalStateLaneAudit(input: {
  corpusId: string;
  localOnly: boolean;
  state: SourceIndexRetrievalState;
}): RetrievalLaneAudit & { retrievalState: SourceIndexRetrievalState } {
  return {
    laneName: `${input.corpusId}:retrieval_mode_enforcement`,
    laneType: 'metadata',
    candidateCount: 0,
    returnedCount: 0,
    ...(input.state.health === 'degraded'
      ? { skippedReason: `declared_${input.state.declaredMode}_unservable:${input.state.reason}` }
      : {}),
    backend: input.state.servableMode,
    retrievalState: input.state,
    localOnly: input.localOnly,
    rawExposed: false,
  };
}

interface MutableFusedRankedCandidate<T> extends FusedRankedCandidate<T> {
  laneRanks: Map<string, number>;
}

export function fuseRankedCandidateLanes<T>(
  options: FuseRankedCandidateLanesOptions<T>,
): FusedRankedCandidate<T>[] {
  if (options.limit <= 0) return [];

  const rrfK = options.rrfK ?? DEFAULT_RRF_K;
  const candidates = new Map<SourceIndexCandidateId, MutableFusedRankedCandidate<T>>();

  for (const lane of options.lanes) {
    const seenInLane = new Set<SourceIndexCandidateId>();
    lane.items.forEach((item, index) => {
      const id = options.getId(item);
      if (seenInLane.has(id)) return;
      seenInLane.add(id);

      const rank = index + 1;
      const existing = candidates.get(id);
      if (existing) {
        existing.laneRanks.set(lane.name, rank);
        existing.score += (lane.weight ?? 1) * reciprocalRank(rank, rrfK);
        return;
      }

      candidates.set(id, {
        id,
        item,
        score: (lane.weight ?? 1) * reciprocalRank(rank, rrfK),
        laneRanks: new Map([[lane.name, rank]]),
      });
    });
  }

  return Array.from(candidates.values())
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const tieResult = options.tieBreaker?.(left, right) ?? 0;
      return tieResult;
    })
    .slice(0, options.limit);
}

export function reciprocalRank(rank: number, k = DEFAULT_RRF_K): number {
  return 1 / (k + rank);
}

/**
 * Seat each matching corpus once before taking second hits, preserving fused
 * rank order. Apply this at every budget boundary, including query expansion:
 * an earlier allocation cannot account for corpora lost by a later fusion.
 */
export function applyPerCorpusResultBudget<T extends { corpusId: string }>(
  ranked: readonly FusedRankedCandidate<T>[],
  budget: number,
): { hits: T[]; degradations: RetrievalDegradation[] } {
  // Asking for no candidates is a scoping decision, not retrieval loss.
  if (budget <= 0) return { hits: [], degradations: [] };
  if (ranked.length <= budget) {
    return { hits: ranked.map((candidate) => candidate.item), degradations: [] };
  }

  const byCorpus = new Map<string, FusedRankedCandidate<T>[]>();
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

  const hits = ranked.filter((candidate) => seated.has(candidate.id)).map((candidate) => candidate.item);
  const representedCorpora = new Set(hits.map((hit) => hit.corpusId));
  return {
    hits,
    degradations: [...byCorpus.keys()]
      .filter((corpusId) => !representedCorpora.has(corpusId))
      .map((corpusId) => ({
        laneName: corpusId,
        laneType: 'keyword',
        reason: 'lane_budget_cut',
        occurrences: 1,
      })),
  };
}

/**
 * The reranker's pool, allocated by store strength instead of in even turns.
 * Every store's leader is seated first, so no store leaves the pool. The rest
 * of the seats go to stores in `storeOrder` (strongest first), each up to
 * `storeDepth` of its own ranks; seats still left after that are filled in
 * turns, strongest store first. The pool keeps fused order. With more stores
 * than seats, or a pool that already fits, this is the even budget.
 */
export function applyStrengthPoolBudget<T extends { corpusId: string }>(
  ranked: readonly FusedRankedCandidate<T>[],
  budget: number,
  storeOrder: ReadonlyMap<string, number>,
  storeDepth: number,
): { hits: T[]; degradations: RetrievalDegradation[] } {
  const byCorpus = new Map<string, FusedRankedCandidate<T>[]>();
  for (const candidate of ranked) {
    const bucket = byCorpus.get(candidate.item.corpusId);
    if (bucket) bucket.push(candidate);
    else byCorpus.set(candidate.item.corpusId, [candidate]);
  }
  if (ranked.length <= budget || byCorpus.size >= budget) return applyPerCorpusResultBudget(ranked, budget);

  const rankOf = (corpusId: string) => storeOrder.get(corpusId) ?? Number.POSITIVE_INFINITY;
  const buckets = [...byCorpus.entries()]
    .map(([corpusId, bucket], index) => ({ corpusId, bucket, index }))
    .sort((left, right) => (rankOf(left.corpusId) - rankOf(right.corpusId)) || left.index - right.index)
    .map((entry) => entry.bucket);
  const seated = new Set<SourceIndexCandidateId>(buckets.map((bucket) => bucket[0]!.id));
  const depth = Math.max(1, Math.floor(storeDepth));
  for (const bucket of buckets) {
    for (const candidate of bucket.slice(1, depth)) {
      if (seated.size >= budget) break;
      seated.add(candidate.id);
    }
  }
  for (let turn = depth; seated.size < budget; turn += 1) {
    const before = seated.size;
    for (const bucket of buckets) {
      const candidate = bucket[turn];
      if (candidate && seated.size < budget) seated.add(candidate.id);
    }
    if (seated.size === before) break;
  }
  return { hits: ranked.filter((candidate) => seated.has(candidate.id)).map((candidate) => candidate.item), degradations: [] };
}

// The pack keeps lane leaders across stores, as a store keeps them inside its
// own order (#1230). The per-corpus budget seats stores in turn, so with more
// stores than seats each store gets its first rank or two, and a store's
// keyword leader that sat lower (a partial match behind vetted vector hits, or
// a file with no text) never reached the Analyst (rerun 20, 2026-11-11). Two
// seats are reserved whenever the pack has at least three: seat 2 for the
// keyword leader with the largest share of the question's concepts across all
// stores, seat 3 for the best names-only match (#1287). A leader below
// RESERVED_LEADER_MIN_CONCEPT_SHARE (half the question's concepts) gets no
// reserved seat, so a weak match does not take one on every question. Ties on
// share go to the earlier candidate in fused order (store turn). A leader
// already seated at or above its reserved seat keeps its place; one seated
// lower moves up; one cut by the budget takes the seat, and the last seat not
// held by a reserved leader leaves the pack.
export const RESERVED_LEADER_MIN_CONCEPT_SHARE = 0.5;

export function withReservedLeaderSeats<T extends { corpusId: string; keywordLeader?: { kinds: ReadonlyArray<'keyword_first' | 'name'>; conceptShare: number } }>(
  budgeted: { hits: T[]; degradations: RetrievalDegradation[] },
  pool: readonly T[],
  budget: number,
): { hits: T[]; degradations: RetrievalDegradation[] } {
  if (budget < 3 || budgeted.hits.length < 1) return budgeted;
  const best = (kind: 'keyword_first' | 'name', exclude: ReadonlySet<T>): T | undefined => {
    let chosen: T | undefined;
    for (const hit of pool) {
      const signal = hit.keywordLeader;
      if (!signal?.kinds.includes(kind) || exclude.has(hit) || signal.conceptShare < RESERVED_LEADER_MIN_CONCEPT_SHARE) continue;
      if (!chosen || signal.conceptShare > chosen.keywordLeader!.conceptShare) chosen = hit;
    }
    return chosen;
  };
  const hits = [...budgeted.hits];
  const reserved = new Set<T>();
  for (const [kind, seat] of [['keyword_first', 1], ['name', 2]] as const) {
    const leader = best(kind, reserved);
    if (!leader) continue;
    reserved.add(leader);
    const at = hits.indexOf(leader);
    if (at >= 0 && at <= seat) continue;
    if (at > seat) hits.splice(at, 1);
    else {
      let drop = -1;
      for (let index = hits.length - 1; index >= 0; index -= 1) {
        if (!reserved.has(hits[index]!)) { drop = index; break; }
      }
      if (hits.length >= budget && drop >= 0) hits.splice(drop, 1);
    }
    hits.splice(Math.min(seat, hits.length), 0, leader);
  }
  return withRestatedBudgetCuts(budgeted, hits);
}

// Budget cuts are restated for the final pack: a store a reserved seat
// brought back is no longer cut, and a store that lost its only seat now is.
// The same budgeted object comes back when the seats did not change.
function withRestatedBudgetCuts<T extends { corpusId: string }>(
  budgeted: { hits: T[]; degradations: RetrievalDegradation[] },
  hits: T[],
): { hits: T[]; degradations: RetrievalDegradation[] } {
  if (hits.length === budgeted.hits.length && hits.every((hit, index) => hit === budgeted.hits[index])) return budgeted;
  const represented = new Set(hits.map((hit) => hit.corpusId));
  const kept = budgeted.degradations.filter((degradation) => (
    degradation.reason !== 'lane_budget_cut' || !represented.has(degradation.laneName)
  ));
  const reported = new Set(kept.filter((degradation) => degradation.reason === 'lane_budget_cut').map((degradation) => degradation.laneName));
  return {
    hits,
    degradations: [
      ...kept,
      ...[...new Set(budgeted.hits.map((hit) => hit.corpusId))]
        .filter((corpusId) => !represented.has(corpusId) && !reported.has(corpusId))
        .map((corpusId) => ({ laneName: corpusId, laneType: 'keyword' as const, reason: 'lane_budget_cut' as const, occurrences: 1 })),
    ],
  };
}

// Seats ahead of store turn in every pack of three or more: seat 1 and the two
// reserved leader seats. A prompt fit keeps them first (fitPackToPromptBytes).
export const RESERVED_HEAD_SEATS = 3;

// A question with temporal intent ("did I just get...", "latest") wants what
// arrived last. Each chat store pins its newest messages into its own cut
// (withPinnedNewestChatHits), but they sit at the store's tail: with several
// stores the per-store budget cut them, and in a long single-store pack the
// prompt fit did (2026-11-11 fixture; #1358). The pack used to re-sort its
// whole pool newest-first instead, which also buried the best relevance hits.
// Now the newest pinned messages across chat stores, by citation date, take
// seats 4 and 5, after seat 1 and the leader seats; relevance keeps the rest.
// A pinned message already seated at or above its seat keeps its place; one
// seated lower moves up; one cut by the budget takes the seat, and the last
// seat that is neither reserved nor its store's only seat leaves the pack.
// When every such seat is a store's only one (more stores than seats), the
// last seat leaves: stores sit in turn by relevance (#1354), so that is the
// least relevant store's, and it is reported as cut. A recency seat never
// costs a reserved leader its place. Packs of three seats or fewer have none.
// Questions without temporal intent never call this.
export const RESERVED_RECENCY_SEATS = 2;

export function withReservedRecencySeats<T extends {
  corpusId: string;
  newestInStore?: number;
  provenance?: { citation?: { authoredAt?: string } };
}>(
  seated: { hits: T[]; degradations: RetrievalDegradation[] },
  pool: readonly T[],
  budget: number,
): { hits: T[]; degradations: RetrievalDegradation[]; recencySeats: number } {
  const seats = Math.min(RESERVED_RECENCY_SEATS, Math.max(0, budget - RESERVED_HEAD_SEATS));
  const time = (hit: T) => Date.parse(hit.provenance?.citation?.authoredAt ?? '') || 0;
  const newest = pool
    .filter((hit) => hit.newestInStore !== undefined)
    .map((hit, order) => ({ hit, order }))
    .sort((left, right) => time(right.hit) - time(left.hit)
      || left.hit.newestInStore! - right.hit.newestInStore!
      || left.order - right.order)
    .slice(0, seats)
    .map(({ hit }) => hit);
  if (newest.length === 0 || seated.hits.length < 1) return { ...seated, recencySeats: 0 };
  const hits = [...seated.hits];
  const reserved = new Set<T>(hits.slice(0, RESERVED_HEAD_SEATS));
  const storeSeats = (corpusId: string) => hits.filter((hit) => hit.corpusId === corpusId).length;
  let taken = 0;
  for (const hit of newest) {
    const seat = RESERVED_HEAD_SEATS + taken;
    const at = hits.indexOf(hit);
    if (at >= 0 && at <= seat) { reserved.add(hit); taken += 1; continue; }
    if (at > seat) hits.splice(at, 1);
    else if (hits.length >= budget) {
      const droppable = (onlySeatToo: boolean) => {
        for (let index = hits.length - 1; index >= RESERVED_HEAD_SEATS; index -= 1) {
          const candidate = hits[index]!;
          if (!reserved.has(candidate) && (onlySeatToo || storeSeats(candidate.corpusId) > 1)) return index;
        }
        return -1;
      };
      const laterResult = droppable(false);
      const drop = laterResult >= 0 ? laterResult : droppable(true);
      if (drop < 0) break;
      hits.splice(drop, 1);
    }
    hits.splice(Math.min(seat, hits.length), 0, hit);
    reserved.add(hit);
    taken += 1;
  }
  return { ...withRestatedBudgetCuts(seated, hits), recencySeats: taken };
}

/**
 * Fold degradation markers from several retrieval runs into one list.
 *
 * A unified answer can run the fan-out more than once — a keyword attempt then
 * a hybrid retry, a literal query then planner expansions — and each run
 * produces its own losses. Every consumer that used to keep only one run's
 * losses dropped the others on the floor, which is precisely how a timed-out
 * semantic lane became invisible. Merging is therefore the default operation:
 * identical (lane, type, reason, detail) markers collapse and their counts add,
 * so the result stays counts-only and stable.
 *
 * The sort is total and content-free so two runs of the same query produce
 * byte-identical audits.
 */
export function mergeRetrievalDegradations(
  ...lists: ReadonlyArray<readonly RetrievalDegradation[] | undefined>
): RetrievalDegradation[] {
  const merged = new Map<string, RetrievalDegradation>();
  for (const list of lists) {
    for (const entry of list ?? []) {
      const key = [entry.laneName, entry.laneType, entry.reason, entry.detail ?? ''].join('|');
      const existing = merged.get(key);
      if (existing) {
        existing.occurrences += Math.max(1, entry.occurrences);
        continue;
      }
      merged.set(key, { ...entry, occurrences: Math.max(1, entry.occurrences) });
    }
  }
  return [...merged.values()].sort((left, right) => {
    if (left.laneName !== right.laneName) return left.laneName.localeCompare(right.laneName);
    if (left.reason !== right.reason) return left.reason.localeCompare(right.reason);
    return (left.detail ?? '').localeCompare(right.detail ?? '');
  });
}

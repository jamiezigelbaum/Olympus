import type {
  RetrievalDegradation,
  RetrievalLaneAudit,
  SourceIndexCandidateId,
} from './types.ts';

export type { SourceIndexCandidateId } from './types.ts';

export interface RankedCandidateLane<T> {
  name: string;
  items: readonly T[];
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
        existing.score += reciprocalRank(rank, rrfK);
        return;
      }

      candidates.set(id, {
        id,
        item,
        score: reciprocalRank(rank, rrfK),
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

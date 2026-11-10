// Reorders the fused keyword and vector candidates before the cut that makes
// the evidence pack (issue #921). Retrieval fuses lanes by rank (RRF), and
// across corpora the order is a tie-break, because adapter scores share no
// scale. A cross-encoder reads the question and each candidate's own text
// together and gives every candidate a score on ONE scale, so it can decide
// what the rank fusion could only tie.
//
// Capability, not source: the stage reads only the question and hydrated
// candidate text, never a corpus name, a source family or the question's
// wording, and it is the same for every corpus. It never adds a candidate the
// retrieval did not find; it only orders and cuts the bounded pool.
//
// Privacy: the candidate text here may be Private. A reranker declares
// `localOnly: true` in its type, so only a model running on this computer (or
// the owner's own private host serving it) can be wired in. A cloud reranker
// is not something this seam accepts.
//
// Fail open: a reranker that throws, times out or returns a malformed score
// list leaves the fused order exactly as it was. Reranking is an improvement,
// never a reason an answer fails.

export interface EvidenceRerankRequest {
  /** The retrieval query the candidates were found for. */
  query: string;
  /** One passage per candidate, in fused order. */
  passages: readonly string[];
  signal: AbortSignal;
}

export interface EvidenceReranker {
  /** Model identity for the audit: model, revision, quantization. */
  readonly id: string;
  /** Candidate text never leaves this computer. */
  readonly localOnly: true;
  /** How many fused candidates to read and score before the cut. */
  readonly poolSize: number;
  /** One relevance score per passage, any scale; higher is more relevant. */
  score(request: EvidenceRerankRequest): Promise<readonly number[]>;
}

export type EvidenceRerankOutcome = 'applied' | 'failed' | 'timed_out';

/** Counts only: no text, no identifiers. Rides beside the pack, never on it. */
export interface EvidenceRerankAudit {
  rerankerId: string;
  outcome: EvidenceRerankOutcome;
  /** Candidates scored. */
  scored: number;
  /** Candidates kept after the cut. */
  kept: number;
  /** Kept candidates that were below the cut in the fused order. */
  promoted: number;
  elapsedMs: number;
}

/** Characters of one candidate's text the reranker reads (a 512-token window holds about this much). */
export const RERANK_PASSAGE_CHARS = 2_000;
/** A reranker that has not answered by then is abandoned and the fused order stands. */
export const DEFAULT_RERANK_TIMEOUT_MS = 5_000;
export const DEFAULT_RERANK_POOL_SIZE = 30;
export const MAX_RERANK_POOL_SIZE = 100;

export interface RerankTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers: RerankTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RerankCandidatesOptions<T> {
  reranker: EvidenceReranker;
  query: string;
  /** Candidates in fused order. */
  items: readonly T[];
  /** The text the reranker reads for one candidate; empty when it has none. */
  passageOf: (item: T) => string;
  keep: number;
  timeoutMs?: number;
  timers?: RerankTimers;
}

export interface RerankCandidatesResult<T> {
  kept: T[];
  audit: EvidenceRerankAudit;
}

/**
 * Order `items` by reranker score and keep the best `keep`. A candidate with
 * no text to read is not scored: it keeps its fused place among the other
 * unscored ones, after every scored candidate. Equal scores keep fused order.
 */
export async function rerankCandidates<T>(options: RerankCandidatesOptions<T>): Promise<RerankCandidatesResult<T>> {
  const timers = options.timers ?? systemTimers;
  const keep = Math.max(0, Math.floor(options.keep));
  const startedAt = timers.now();
  const passages = options.items.map((item) => clipPassage(options.passageOf(item)));
  const scoredIndexes = passages.flatMap((passage, index) => (passage ? [index] : []));
  const fusedCut = (outcome: EvidenceRerankOutcome, scored: number): RerankCandidatesResult<T> => ({
    kept: options.items.slice(0, keep),
    audit: {
      rerankerId: options.reranker.id,
      outcome,
      scored,
      kept: Math.min(keep, options.items.length),
      promoted: 0,
      elapsedMs: timers.now() - startedAt,
    },
  });
  if (scoredIndexes.length === 0) return fusedCut('applied', 0);

  const controller = new AbortController();
  let timer: unknown;
  const timedOut = new Promise<'timed_out'>((resolve) => {
    timer = timers.setTimeout(() => {
      // Settle first: a reranker that rejects on abort must not win the race.
      resolve('timed_out');
      controller.abort();
    },options.timeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS);
  });
  let scores: readonly number[] | 'timed_out';
  try {
    const scoring = options.reranker.score({
      query: options.query,
      passages: scoredIndexes.map((index) => passages[index]!),
      signal: controller.signal,
    });
    // An abandoned score must not surface later as an unhandled rejection.
    scoring.catch(() => undefined);
    scores = await Promise.race([scoring, timedOut]);
  } catch {
    return fusedCut('failed', 0);
  } finally {
    timers.clearTimeout(timer);
  }
  if (scores === 'timed_out') return fusedCut('timed_out', 0);
  if (scores.length !== scoredIndexes.length || scores.some((score) => typeof score !== 'number' || Number.isNaN(score))) {
    return fusedCut('failed', 0);
  }

  const scoreByIndex = new Map(scoredIndexes.map((index, position) => [index, scores[position]!] as const));
  const order = options.items.map((_, index) => index).sort((left, right) => {
    const leftScore = scoreByIndex.get(left);
    const rightScore = scoreByIndex.get(right);
    if (leftScore !== undefined && rightScore !== undefined && leftScore !== rightScore) return rightScore - leftScore;
    if (leftScore === undefined && rightScore !== undefined) return 1;
    if (leftScore !== undefined && rightScore === undefined) return -1;
    return left - right;
  });
  const keptOrder = order.slice(0, keep);
  return {
    kept: keptOrder.map((index) => options.items[index]!),
    audit: {
      rerankerId: options.reranker.id,
      outcome: 'applied',
      scored: scoredIndexes.length,
      kept: keptOrder.length,
      promoted: keptOrder.filter((index) => index >= keep).length,
      elapsedMs: timers.now() - startedAt,
    },
  };
}

/** The candidate's title and text, whitespace-collapsed and bounded. */
export function rerankPassage(title: string | undefined, chunks: readonly string[]): string {
  const parts = [title?.trim() ?? '', ...chunks.map((chunk) => chunk.trim())].filter(Boolean);
  return clipPassage(parts.join('\n'));
}

function clipPassage(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > RERANK_PASSAGE_CHARS ? collapsed.slice(0, RERANK_PASSAGE_CHARS) : collapsed;
}

/** The pool to retrieve: at least the caller's cut, at most MAX_RERANK_POOL_SIZE. */
export function rerankPoolSize(reranker: EvidenceReranker, maxResults: number): number {
  const pool = Number.isFinite(reranker.poolSize) ? Math.floor(reranker.poolSize) : DEFAULT_RERANK_POOL_SIZE;
  return Math.max(Math.floor(maxResults), Math.min(MAX_RERANK_POOL_SIZE, pool));
}

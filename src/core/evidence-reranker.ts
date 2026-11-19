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
// Fail open: a reranker that throws, stalls or returns a malformed score
// list leaves the fused order exactly as it was. Reranking is an improvement,
// never a reason an answer fails.

export interface EvidenceRerankRequest {
  /** The retrieval query the candidates were found for. */
  query: string;
  /** One passage per candidate, in fused order. */
  passages: readonly string[];
  signal: AbortSignal;
  /** Called each time more of the pool has been scored; scoring that keeps reporting is never abandoned. */
  onProgress?: () => void;
}

export interface EvidenceReranker {
  /** Model identity for the audit: model, revision, quantization. */
  readonly id: string;
  /** Candidate text never leaves this computer. */
  readonly localOnly: true;
  /** How many fused candidates to read and score before the cut. */
  readonly poolSize: number;
  /**
   * One relevance score per passage, any scale; higher is more relevant. A
   * passage longer than the model's window is scored by its best part, not
   * by its opening.
   */
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

// Characters of one candidate's text handed to the reranker, which reads its
// first window, or all of it in windows when set to score every window. A candidate is hydrated to its seat's share of the
// evidence budget, which is below this at the shipped budgets, so this bounds
// one request, not what is read.
export const RERANK_PASSAGE_CHARS = 12_000;
// A reranker that has scored nothing more for this long has stalled: it is
// abandoned and the fused order stands. The clock restarts on every progress
// report, so a large pool of long candidates is scored to the end.
export const DEFAULT_RERANK_STALL_MS = 10_000;
export const DEFAULT_RERANK_POOL_SIZE = 30;
// The pool is drawn by store strength: every store's leader, then the
// strongest stores first, up to this many of each store's ranks. On subset L
// (13 Nov 2026) this recovered 3 documents and 2 paragraphs the even turns
// left out of a pool of the same size, losing no document.
export const RERANK_POOL_STORE_DEPTH = 10;
// Seats added to a reranked pool for the best vector rows across stores, by
// margin over each store's relevance bar, below the bar included: a store's
// nearest item that its keyword matches crowd out of its own list can still be
// the answer, and the reranker decides. 6 on the 75-question stage 3 eval
// (19 Nov 2026): found document 44 to 47, answered by meaning 35 to 36,
// held-out equal. OLYMPUS_SEMANTIC_POOL_SEATS overrides it (0 turns it off).
export const DEFAULT_RERANK_POOL_SEMANTIC_SEATS = 6;
export const SEMANTIC_POOL_SEATS_ENV = 'OLYMPUS_SEMANTIC_POOL_SEATS';
export function rerankPoolSemanticSeats(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env[SEMANTIC_POOL_SEATS_ENV]?.trim();
  if (!raw) return DEFAULT_RERANK_POOL_SEMANTIC_SEATS;
  const seats = Number(raw);
  return Number.isInteger(seats) && seats >= 0 && seats <= 48 ? seats : DEFAULT_RERANK_POOL_SEMANTIC_SEATS;
}

// How many of its nearest vector rows each store offers those seats, whatever
// its bar. A row below this rank is never offered, however many seats there
// are. OLYMPUS_SEMANTIC_ROWS_PER_STORE sets it for eval arms.
export const DEFAULT_SEMANTIC_ROWS_PER_STORE = 3;
export const SEMANTIC_ROWS_PER_STORE_ENV = 'OLYMPUS_SEMANTIC_ROWS_PER_STORE';
export function semanticRowsPerStore(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env[SEMANTIC_ROWS_PER_STORE_ENV]?.trim();
  if (!raw) return DEFAULT_SEMANTIC_ROWS_PER_STORE;
  const rows = Number(raw);
  return Number.isInteger(rows) && rows >= 1 && rows <= 50 ? rows : DEFAULT_SEMANTIC_ROWS_PER_STORE;
}

// Every rerank outcome since this process started, for health: a timeout
// falls back to the fused cut, and that must be countable, not silent.
const outcomeCounts: Record<EvidenceRerankOutcome, number> = { applied: 0, failed: 0, timed_out: 0 };
export function rerankOutcomeCounts(): Record<EvidenceRerankOutcome, number> { return { ...outcomeCounts }; }
const counted = <T>(result: RerankCandidatesResult<T>): RerankCandidatesResult<T> => {
  outcomeCounts[result.audit.outcome] += 1;
  return result;
};
// Sparta scores 360 candidates of 128 tokens in 4 s with MiniLM int8 (#921).
export const MAX_RERANK_POOL_SIZE = 400;

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
  /** Silence, not total time: restarts whenever the reranker reports progress. */
  stallMs?: number;
  timers?: RerankTimers;
  // Internal observer; entries are in input order and contain no passage text.
  onScores?: (entries: readonly { item: T; score: number }[], outcome: EvidenceRerankOutcome) => void;
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
  const fusedCut = (outcome: EvidenceRerankOutcome, scored: number): RerankCandidatesResult<T> => {
    options.onScores?.([], outcome);
    return counted({
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
  };
  if (scoredIndexes.length === 0) return fusedCut('applied', 0);

  const controller = new AbortController();
  let timer: unknown;
  let settled = false;
  let stalled!: (outcome: 'timed_out') => void;
  const timedOut = new Promise<'timed_out'>((resolve) => { stalled = resolve; });
  const stallMs = options.stallMs ?? DEFAULT_RERANK_STALL_MS;
  const restartStallClock = () => {
    if (settled) return;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      // Settle first: a reranker that rejects on abort must not win the race.
      settled = true;
      stalled('timed_out');
      controller.abort();
    }, stallMs);
  };
  restartStallClock();
  let scores: readonly number[] | 'timed_out';
  try {
    const scoring = options.reranker.score({
      query: options.query,
      passages: scoredIndexes.map((index) => passages[index]!),
      signal: controller.signal,
      onProgress: restartStallClock,
    });
    // An abandoned score must not surface later as an unhandled rejection.
    scoring.catch(() => undefined);
    scores = await Promise.race([scoring, timedOut]);
  } catch {
    return fusedCut('failed', 0);
  } finally {
    settled = true;
    timers.clearTimeout(timer);
  }
  if (scores === 'timed_out') return fusedCut('timed_out', 0);
  if (scores.length !== scoredIndexes.length || scores.some((score) => typeof score !== 'number' || Number.isNaN(score))) {
    return fusedCut('failed', 0);
  }

  if (options.onScores) options.onScores(scoredIndexes.map((index, position) => ({ item: options.items[index]!, score: scores[position]! })), 'applied');
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
  return counted({
    kept: keptOrder.map((index) => options.items[index]!),
    audit: {
      rerankerId: options.reranker.id,
      outcome: 'applied',
      scored: scoredIndexes.length,
      kept: keptOrder.length,
      promoted: keptOrder.filter((index) => index >= keep).length,
      elapsedMs: timers.now() - startedAt,
    },
  });
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

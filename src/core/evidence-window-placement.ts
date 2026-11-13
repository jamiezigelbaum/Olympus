import type { RerankTimers } from './evidence-reranker.ts';
import { sourceIndexChunkWindow } from './source-index/chunk-selection.ts';

export const WINDOW_PLACEMENT_BUDGET_MS = 1_500;
const WINDOW_CHARS = 600;
const WINDOW_STRIDE = 300;
// A seat scores at most eight windows. The most relevant passage is covered
// end to end before the next one gets any, and the
// first seat cannot take the question's whole allowance from the next two.
const MAX_WINDOWS_PER_SEAT = 8;
const MAX_WINDOWS_PER_QUESTION = 24;
const KEEP_ORIGINAL = -1;

export type WindowScorer = (query: string, windows: readonly string[], signal: AbortSignal) => Promise<readonly number[]>;

/** Internal hydration snapshot: full text of ONLY the passages already picked. */
export interface EvidenceWindowSource {
  texts: readonly string[];
  /** Stored chunk hashes behind each text, index-aligned, so a placed window keeps its release proof. */
  hashes?: readonly (readonly string[])[];
  /** Indexes into texts, most relevant first. Texts arrive in document order. */
  priority?: readonly number[];
  scoreWindows?: WindowScorer;
  /** Stable name of the backend behind scoreWindows, so slow-call history survives the per-question closure. */
  scorerKey?: string;
}

export interface WindowPlacementAudit {
  /** Seats whose windows were submitted for scoring. */
  seats: number;
  /** Windows with valid scores received before the deadline. */
  windowsScored: number;
  windowsSubmitted: number;
  calls: { windows: number; ms: number; outcome: 'scored' | 'timed_out' | 'failed' }[];
  skipped?: 'slow_scorer';
  scorer: 'reranker' | 'embedding' | 'none';
  elapsedMs: number;
  timedOut: boolean;
}

const systemTimers: RerankTimers = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface EvidenceWindowSeat {
  chunks: readonly string[];
  source: EvidenceWindowSource;
  /** The UTF-8 bytes each kept chunk may hold after the pack's byte clip. */
  byteShares?: readonly number[];
}

type ScorerKind = 'reranker' | 'embedding';
// Like keyword translation, late settlements still update the last duration.
// A fast call already in flight can restore placement after an overload.
// A slow scorer is tried again after a minute, so a skip is never permanent:
// while skipped, no call runs that could report it fast again.
const SLOW_SCORER_RETRY_MS = 60_000;
// History is per backend: the one built-in reranker, or each embedding backend
// by its stable key (by scorer identity when a source names none), so one slow
// backend never skips another's placement and history outlives the per-question
// content providers.
// pending: the last call hit the deadline and has not settled yet.
type CallHistory = { ms: number; at: number; pending?: boolean };
const rerankerHistory: CallHistory = { ms: 0, at: 0 };
const keyedHistory = new Map<string, CallHistory>();
const unkeyedHistory = new WeakMap<WindowScorer, CallHistory>();
/** Backend history is process-wide; tests on separate fake clocks start clean. */
export function resetWindowPlacementHistoryForTests(): void {
  Object.assign(rerankerHistory, { ms: 0, at: 0, pending: false });
  keyedHistory.clear();
}
function historyFor(kind: ScorerKind, score: WindowScorer, key: string | undefined): CallHistory {
  if (kind === 'reranker') return rerankerHistory;
  let history = key === undefined ? unkeyedHistory.get(score) : keyedHistory.get(key);
  if (!history) {
    history = { ms: 0, at: 0 };
    if (key === undefined) unkeyedHistory.set(score, history); else keyedHistory.set(key, history);
  }
  return history;
}

/** One shared deadline and window allowance for a whole question. Fail open. */
export function createEvidenceWindowPlacer(query: string, timers = systemTimers) {
  const audit: WindowPlacementAudit = { seats: 0, windowsScored: 0, windowsSubmitted: 0, calls: [], scorer: 'none', elapsedMs: 0, timedOut: false };
  let startedAt: number | undefined;
  async function placeAll(seats: readonly EvidenceWindowSeat[], reranker?: WindowScorer): Promise<readonly (readonly string[])[]> {
    const results = seats.map(seat => seat.chunks);
    const groups = new Map<WindowScorer, { seat: number; key?: string; windows: ReturnType<typeof seatWindows> }[]>();
    let reserved = audit.windowsSubmitted;
    for (const [seat, entry] of seats.entries()) {
      const scorer = reranker ?? entry.source.scoreWindows;
      if (!scorer || reserved >= MAX_WINDOWS_PER_QUESTION || audit.timedOut) continue;
      const windows = seatWindows(entry, Math.min(MAX_WINDOWS_PER_SEAT, MAX_WINDOWS_PER_QUESTION - reserved));
      if (!windows.length) continue;
      reserved += windows.length;
      const group = groups.get(scorer) ?? [];
      group.push({ seat, windows, ...(entry.source.scorerKey === undefined ? {} : { key: entry.source.scorerKey }) });
      groups.set(scorer, group);
    }
    // Map insertion order is the first seat's order, even for interleaved stores.
    for (const [score, group] of groups) {
      if (audit.timedOut) break;
      const kind: ScorerKind = reranker ? 'reranker' : 'embedding';
      audit.scorer = kind;
      const remaining = WINDOW_PLACEMENT_BUDGET_MS - (startedAt === undefined ? 0 : timers.now() - startedAt);
      if (remaining <= 0) { audit.timedOut = true; break; }
      const lastCall = historyFor(kind, score, group[0]!.key);
      if ((lastCall.pending || lastCall.ms > remaining) && timers.now() - lastCall.at < SLOW_SCORER_RETRY_MS) { audit.skipped = 'slow_scorer'; continue; }
      startedAt ??= timers.now();
      const windows = group.flatMap(entry => entry.windows);
      audit.seats += group.length;
      audit.windowsSubmitted += windows.length;
      const controller = new AbortController();
      const callStartedAt = timers.now();
      const call: WindowPlacementAudit['calls'][number] = { windows: windows.length, ms: 0, outcome: 'failed' };
      audit.calls.push(call);
      let timer: unknown;
      const expired = Symbol('expired');
      const timeout = new Promise<typeof expired>(resolve => {
        timer = timers.setTimeout(() => { resolve(expired); controller.abort(); }, remaining);
      });
      // Measure the underlying call, not the race: overload may only become
      // known after this question has already returned at its deadline.
      const scoring = Promise.resolve().then(() => score(query, windows.map(window => window.text), controller.signal))
        .finally(() => { lastCall.ms = Math.max(0, timers.now() - callStartedAt); lastCall.at = timers.now(); lastCall.pending = false; });
      let settled = false;
      void scoring.then(() => { settled = true; }, () => { settled = true; });
      try {
        const scores = await Promise.race([scoring, timeout]);
        // A synchronous scorer can consume the deadline before the timer runs.
        if (scores === expired || timers.now() - startedAt >= WINDOW_PLACEMENT_BUDGET_MS) {
          audit.timedOut = true;
          call.outcome = 'timed_out';
          controller.abort();
          // A scorer that ignores the abort may never settle: count it slow now.
          if (!settled) { lastCall.pending = true; lastCall.at = timers.now(); }
          continue;
        }
        if (scores.length !== windows.length || scores.some(value => !Number.isFinite(value))) continue;
        call.outcome = 'scored';
        audit.windowsScored += windows.length;
        let offset = 0;
        for (const entry of group) {
          results[entry.seat] = applyWindows(seats[entry.seat]!, entry.windows, scores.slice(offset, offset + entry.windows.length));
          offset += entry.windows.length;
        }
      } catch {
        if (timers.now() - startedAt >= WINDOW_PLACEMENT_BUDGET_MS) {
          audit.timedOut = true;
          call.outcome = 'timed_out';
          controller.abort();
        }
      } finally {
        timers.clearTimeout(timer);
        call.ms = Math.max(0, timers.now() - callStartedAt);
        audit.elapsedMs = Math.max(0, timers.now() - startedAt);
      }
    }
    return results;
  }
  return {
    audit,
    placeAll,
    async place(chunks: readonly string[], source: EvidenceWindowSource, reranker?: WindowScorer, byteShares?: readonly number[]): Promise<readonly string[]> {
      return (await placeAll([{ chunks, source, ...(byteShares ? { byteShares } : {}) }], reranker))[0]!;
    },
  };
}

function seatWindows({ chunks, source, byteShares }: EvidenceWindowSeat, allowance: number) {
  const cut = (text: string, index: number) => byteShares ? utf8Prefix(text, byteShares[index] ?? 0) : text;
  const windows: { chunk: number; start: number; text: string }[] = [];
  const order = [...new Set([...(source.priority ?? []), ...chunks.keys()])];
  const eligible = order.filter((index) => {
    const text = source.texts[index];
    const chunk = chunks[index];
    return chunk !== undefined && text !== undefined && text.length > chunk.length && (!byteShares || (byteShares[index] ?? 0) > 0);
  });
  for (const chunk of eligible) {
    const text = source.texts[chunk]!;
    // Score at the share that will be kept, so the winning text is never clipped away.
    const size = Math.min(WINDOW_CHARS, chunks[chunk]!.length);
    const span = Math.max(0, text.length - size);
    // Round up so the last window always ends at the chunk's end.
    const count = Math.min(Math.ceil(span / WINDOW_STRIDE) + 1, allowance - windows.length - 1);
    if (count <= 0) break;
    // The word clip is scored first and wins ties.
    windows.push({ chunk, start: KEEP_ORIGINAL, text: cut(chunks[chunk]!, chunk) });
    for (let n = 0; n < count; n++) {
      const start = count === 1 ? 0 : Math.round((n * span) / (count - 1));
      windows.push({ chunk, start, text: cut(sourceIndexChunkWindow(text, start, size), chunk) });
    }
  }
  return windows;
}

function applyWindows({ chunks, source, byteShares }: EvidenceWindowSeat, windows: ReturnType<typeof seatWindows>, scores: readonly number[]): readonly string[] {
  const best = new Map<number, number>();
  windows.forEach((window, index) => {
    const previous = best.get(window.chunk);
    if (previous === undefined || scores[index]! > scores[previous]!) best.set(window.chunk, index);
  });
  return chunks.map((chunk, index) => {
    const picked = best.get(index);
    const start = picked === undefined ? KEEP_ORIGINAL : windows[picked]!.start;
    if (start === KEEP_ORIGINAL) return chunk;
    // Widening to the share can pull a late window's start back, and the
    // byte clip then keeps the front; keep the scored window itself then.
    const widened = sourceIndexChunkWindow(source.texts[index]!, start, chunk.length);
    const kept = byteShares ? utf8Prefix(widened, byteShares[index] ?? 0) : widened;
    const scored = windows[picked!]!.text;
    return kept.includes(scored) ? kept : scored;
  });
}

// The longest prefix of text within maxBytes of UTF-8, never splitting a code point.
function utf8Prefix(text: string, maxBytes: number): string {
  let used = 0;
  let end = 0;
  for (const codePoint of text) {
    const size = codePoint.codePointAt(0)! < 0x80 ? 1 : codePoint.codePointAt(0)! < 0x800 ? 2 : codePoint.length === 2 ? 4 : 3;
    if (used + size > maxBytes) break;
    used += size;
    end += codePoint.length;
  }
  return text.slice(0, end);
}

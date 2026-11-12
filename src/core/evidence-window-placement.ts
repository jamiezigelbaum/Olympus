import type { RerankTimers } from './evidence-reranker.ts';
import { sourceIndexChunkWindow } from './source-index/chunk-selection.ts';

export const WINDOW_PLACEMENT_BUDGET_MS = 1_500;
const WINDOW_CHARS = 600;
const WINDOW_STRIDE = 300;
// A seat scores at most eight windows. Chunks arrive best first, so the
// leading chunk is covered end to end before the next one gets any, and the
// first seat cannot take the question's whole allowance from the next two.
const MAX_WINDOWS_PER_SEAT = 8;
const MAX_WINDOWS_PER_QUESTION = 24;

export type WindowScorer = (query: string, windows: readonly string[], signal: AbortSignal) => Promise<readonly number[]>;

/** Internal hydration snapshot: full text of ONLY the passages already picked. */
export interface EvidenceWindowSource {
  texts: readonly string[];
  scoreWindows?: WindowScorer;
}

export interface WindowPlacementAudit {
  /** Seats whose windows were submitted for scoring. */
  seats: number;
  /** Windows with valid scores received before the deadline. */
  windowsScored: number;
  scorer: 'reranker' | 'embedding' | 'none';
  elapsedMs: number;
  timedOut: boolean;
}

const systemTimers: RerankTimers = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One shared deadline and window allowance for a whole question. Fail open. */
export function createEvidenceWindowPlacer(query: string, timers = systemTimers) {
  const audit: WindowPlacementAudit = { seats: 0, windowsScored: 0, scorer: 'none', elapsedMs: 0, timedOut: false };
  let startedAt: number | undefined;
  let submittedWindows = 0;
  return {
    audit,
    async place(chunks: readonly string[], source: EvidenceWindowSource, reranker?: WindowScorer): Promise<readonly string[]> {
      const score = reranker ?? source.scoreWindows;
      if (!score || submittedWindows >= MAX_WINDOWS_PER_QUESTION || audit.timedOut) return chunks;
      startedAt ??= timers.now();
      const remaining = WINDOW_PLACEMENT_BUDGET_MS - (timers.now() - startedAt);
      if (remaining <= 0) { audit.timedOut = true; audit.elapsedMs = timers.now() - startedAt; return chunks; }
      const windows: { chunk: number; start: number; text: string }[] = [];
      const eligible = chunks.flatMap((chunk, index) => {
        const text = source.texts[index];
        return text && text.length > chunk.length ? [index] : [];
      });
      const allowance = Math.min(MAX_WINDOWS_PER_SEAT, MAX_WINDOWS_PER_QUESTION - submittedWindows);
      // Chunks arrive best first, so the leading chunk is covered end to end before the next gets any.
      for (const chunk of eligible) {
        const text = source.texts[chunk]!;
        const span = Math.max(0, text.length - WINDOW_CHARS);
        const count = Math.min(Math.floor(span / WINDOW_STRIDE) + 1, allowance - windows.length);
        if (count <= 0) break;
        for (let n = 0; n < count; n++) {
          const start = count === 1 ? 0 : Math.round((n * span) / (count - 1));
          windows.push({ chunk, start, text: sourceIndexChunkWindow(text, start, WINDOW_CHARS) });
        }
      }
      if (!windows.length) return chunks;
      audit.seats++;
      submittedWindows += windows.length;
      audit.scorer = reranker ? 'reranker' : 'embedding';
      const controller = new AbortController();
      let timer: unknown;
      const expired = Symbol('expired');
      const timeout = new Promise<typeof expired>(resolve => {
        timer = timers.setTimeout(() => { resolve(expired); controller.abort(); }, remaining);
      });
      try {
        const scores = await Promise.race([Promise.resolve().then(() => score(query, windows.map(window => window.text), controller.signal)), timeout]);
        // A synchronous scorer can consume the deadline before the timer runs.
        if (scores === expired || timers.now() - startedAt >= WINDOW_PLACEMENT_BUDGET_MS) {
          audit.timedOut = true;
          controller.abort();
          return chunks;
        }
        if (scores.length !== windows.length || scores.some(value => !Number.isFinite(value))) return chunks;
        audit.windowsScored += windows.length;
        const best = new Map<number, number>();
        windows.forEach((window, index) => {
          const previous = best.get(window.chunk);
          if (previous === undefined || scores[index]! > scores[previous]!) best.set(window.chunk, index);
        });
        return chunks.map((chunk, index) => {
          const picked = best.get(index);
          return picked === undefined ? chunk : sourceIndexChunkWindow(source.texts[index]!, windows[picked]!.start, chunk.length);
        });
      } catch {
        if (timers.now() - startedAt >= WINDOW_PLACEMENT_BUDGET_MS) {
          audit.timedOut = true;
          controller.abort();
        }
        return chunks;
      } finally {
        timers.clearTimeout(timer);
        audit.elapsedMs = Math.max(0, timers.now() - startedAt);
      }
    },
  };
}

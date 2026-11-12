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
  /** Indexes into texts, most relevant first. Texts arrive in document order. */
  priority?: readonly number[];
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
    async place(
      chunks: readonly string[],
      source: EvidenceWindowSource,
      reranker?: WindowScorer,
      /** The UTF-8 bytes each kept chunk may hold after the pack's byte clip. */
      byteShares?: readonly number[],
    ): Promise<readonly string[]> {
      const cut = (text: string, index: number) => byteShares ? utf8Prefix(text, byteShares[index] ?? 0) : text;
      const score = reranker ?? source.scoreWindows;
      if (!score || submittedWindows >= MAX_WINDOWS_PER_QUESTION || audit.timedOut) return chunks;
      startedAt ??= timers.now();
      const remaining = WINDOW_PLACEMENT_BUDGET_MS - (timers.now() - startedAt);
      if (remaining <= 0) { audit.timedOut = true; audit.elapsedMs = timers.now() - startedAt; return chunks; }
      const windows: { chunk: number; start: number; text: string }[] = [];
      const order = [...new Set([...(source.priority ?? []), ...chunks.keys()])];
      const eligible = order.filter((index) => {
        const text = source.texts[index];
        const chunk = chunks[index];
        return chunk !== undefined && text !== undefined && text.length > chunk.length && (!byteShares || (byteShares[index] ?? 0) > 0);
      });
      const allowance = Math.min(MAX_WINDOWS_PER_SEAT, MAX_WINDOWS_PER_QUESTION - submittedWindows);
      for (const chunk of eligible) {
        const text = source.texts[chunk]!;
        // Score at the share that will be kept, so the winning text is never clipped away.
        const size = Math.min(WINDOW_CHARS, chunks[chunk]!.length);
        const span = Math.max(0, text.length - size);
        // Round up so the last window always ends at the chunk's end.
        const count = Math.min(Math.ceil(span / WINDOW_STRIDE) + 1, allowance - windows.length - 1);
        if (count <= 0) break;
        // Today's word clip is scored first and wins ties, so placement never
        // drops evidence it did not evaluate.
        windows.push({ chunk, start: KEEP_ORIGINAL, text: cut(chunks[chunk]!, chunk) });
        for (let n = 0; n < count; n++) {
          const start = count === 1 ? 0 : Math.round((n * span) / (count - 1));
          windows.push({ chunk, start, text: cut(sourceIndexChunkWindow(text, start, size), chunk) });
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
          const start = picked === undefined ? KEEP_ORIGINAL : windows[picked]!.start;
          if (start === KEEP_ORIGINAL) return chunk;
          // Widening to the share can pull a late window's start back, and the
          // byte clip then keeps the front; keep the scored window itself then.
          const widened = cut(sourceIndexChunkWindow(source.texts[index]!, start, chunk.length), index);
          const scored = windows[picked!]!.text;
          return widened.includes(scored) ? widened : scored;
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

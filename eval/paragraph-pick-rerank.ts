// Sizes a reranker-led passage pick for eval/paragraph-pick.ts --rerank: an
// item's most similar chunks are cut into windows the reranker reads whole,
// each is scored against the question, and a pick keeps the best windows up
// to the seat's characters. Returns ranks, counts and timings only.
import { rerankPassage, type EvidenceReranker } from '../src/core/evidence-reranker.ts';
import { passageContainsQuote } from './passage-match.ts';

export const WINDOW_CHARS = 800;
export const WINDOW_STRIDE_CHARS = 600;

export interface RerankPickSize {
  rerankWindows: number;
  rerankMs: number;
  /** Keyed by shortlist size (the item's 4, 8 and 16 most similar chunks). */
  rerankPick: Record<string, { quoteChunkRank: number | null; pickedQuote: boolean }>;
}

export async function sizeRerankPick(input: {
  reranker: EvidenceReranker;
  question: string;
  quote: string;
  maxChars: number;
  chunks: readonly { index: number; text: string }[];
  /** Chunk indexes, most similar to the question first. */
  shortlist: readonly number[];
  /** Chunk indexes that hold the quote. */
  targets: readonly number[];
}): Promise<RerankPickSize> {
  const startedAt = Date.now();
  const textOf = new Map(input.chunks.map(chunk => [chunk.index, chunk.text]));
  const windows = input.shortlist.flatMap(index => {
    const text = textOf.get(index) ?? '';
    const starts: number[] = [];
    for (let start = 0; ; start += WINDOW_STRIDE_CHARS) {
      if (start + WINDOW_CHARS >= text.length) { starts.push(Math.max(0, text.length - WINDOW_CHARS)); break; }
      starts.push(start);
    }
    return starts.map(start => ({ index, start, text: text.slice(start, start + WINDOW_CHARS) }));
  });
  const scores: number[] = [];
  // Small calls keep each reply prompt; the scores share one scale.
  for (let start = 0; start < windows.length; start += 16) {
    scores.push(...await input.reranker.score({
      query: input.question,
      passages: windows.slice(start, start + 16).map(window => rerankPassage(undefined, [window.text])),
      signal: new AbortController().signal,
    }));
  }
  const scored = windows.map((window, at) => ({ ...window, score: scores[at]! })).sort((a, b) => b.score - a.score);
  const forTop = (top: number) => {
    const allowed = new Set(input.shortlist.slice(0, top));
    const ranked = scored.filter(window => allowed.has(window.index));
    const chunkOrder = [...new Set(ranked.map(window => window.index))];
    const found = input.targets.map(index => chunkOrder.indexOf(index) + 1).filter(rank => rank > 0);
    // Best windows first until the seat's characters are used; windows of one
    // chunk that touch are read as one stretch of it.
    const kept: typeof ranked = [];
    let used = 0;
    for (const window of ranked) {
      if (used >= input.maxChars) break;
      kept.push(window);
      used += window.text.length;
    }
    const text = [...new Set(kept.map(window => window.index))].map(index => {
      const source = textOf.get(index) ?? '';
      const spans = kept.filter(window => window.index === index).sort((a, b) => a.start - b.start);
      let out = '';
      let end = -1;
      for (const span of spans) {
        out += span.start <= end ? source.slice(end, span.start + WINDOW_CHARS) : `\n${source.slice(span.start, span.start + WINDOW_CHARS)}`;
        end = Math.max(end, span.start + WINDOW_CHARS);
      }
      return out;
    }).join('\n');
    return { quoteChunkRank: found.length ? Math.min(...found) : null, pickedQuote: passageContainsQuote(text, input.quote) };
  };
  return {
    rerankWindows: windows.length,
    rerankMs: Date.now() - startedAt,
    rerankPick: Object.fromEntries([4, 8, 16].map(top => [String(top), forTop(top)])),
  };
}

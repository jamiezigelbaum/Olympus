import { sourceIndexFtsTermGroups } from './fts.ts';

// These are not lexical stopwords: the shared FTS tokenizer owns those. They
// are request-prose nouns and verbs that are useful for locating a document
// but unsafe for choosing a tight evidence window inside that document.
const CHUNK_WINDOW_PROSE_TERMS = new Set([
  'about',
  'ai',
  'answer',
  'answers',
  'can',
  'could',
  'document',
  'documents',
  'does',
  'file',
  'files',
  'give',
  'has',
  'have',
  'here',
  'how',
  'list',
  'please',
  'report',
  'reports',
  'result',
  'results',
  'search',
  'show',
  'some',
  'tell',
  'that',
  'their',
  'there',
  'these',
  'this',
  'value',
  'values',
  'will',
  'you',
  'your',
]);

export function sourceIndexChunkQueryTerms(query: string): ReadonlyArray<readonly string[]> {
  return sourceIndexFtsTermGroups(query, {
    excludedRawTerms: CHUNK_WINDOW_PROSE_TERMS,
    minimumRawLength: 3,
    groupLimit: 16,
    expandedTermLimit: 'unbounded',
  });
}

export function sourceIndexChunkTermScore(
  text: string,
  termGroups: ReadonlyArray<readonly string[]>,
): number {
  const normalized = text.toLowerCase();
  return termGroups.reduce((score, group) => score + Math.max(
    0,
    ...group.map((term) => termOccurrences(normalized, term.toLowerCase()).length),
  ), 0);
}

/**
 * Keep several relevant chunks inside one candidate budget.
 *
 * A first long match must not consume the whole budget when a later match
 * carries another part of the answer. The remaining budget is shared across
 * the remaining distinct chunks, with each clipped snippet taken from the
 * window that covers the densest cluster of query terms.
 */
export function boundedSourceIndexChunks(
  texts: readonly string[],
  maxChars: number | undefined,
  termGroups: ReadonlyArray<readonly string[]>,
): { chunks: string[]; truncated: boolean } {
  const distinctTexts = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
  const chunks: string[] = [];
  let remaining = maxChars !== undefined && maxChars > 0 ? maxChars : Number.POSITIVE_INFINITY;
  let truncated = false;
  for (let index = 0; index < distinctTexts.length; index += 1) {
    if (remaining <= 0) return { chunks, truncated: true };
    const text = distinctTexts[index]!;
    const fairShare = Number.isFinite(remaining)
      ? Math.max(1, Math.floor(remaining / (distinctTexts.length - index)))
      : undefined;
    const snippet = sourceIndexChunkSnippet(text, termGroups, fairShare);
    if (!snippet) continue;
    const included = snippet.length > remaining ? snippet.slice(0, remaining) : snippet;
    chunks.push(included);
    remaining -= included.length;
    if (included.length < text.length) truncated = true;
  }
  return { chunks, truncated };
}

function sourceIndexChunkSnippet(
  text: string,
  termGroups: ReadonlyArray<readonly string[]>,
  maxChars: number | undefined,
): string {
  if (maxChars === undefined || maxChars <= 0 || text.length <= maxChars) return text;
  const lower = text.toLowerCase();
  const normalizedGroups = termGroups
    .map((group) => [...new Set(group.map((term) => term.toLowerCase()).filter(Boolean))])
    .filter((group) => group.length > 0);
  const occurrences = normalizedGroups.flatMap((group) =>
    group.flatMap((term) => termOccurrences(lower, term)));
  if (occurrences.length === 0) return text.slice(0, maxChars);

  // A long chunk often mentions one broad query word in its preamble and
  // carries the actual table or values around a later cluster of distinctive
  // terms. Score bounded windows around every match and choose the region with
  // the widest term coverage, then the most matches. This stays generic while
  // avoiding an irreversible bias toward the first mention in the chunk.
  const starts = [...new Set(occurrences.map((matchIndex) => {
    const lead = Math.min(Math.floor(maxChars / 4), matchIndex);
    return Math.min(Math.max(0, matchIndex - lead), Math.max(0, text.length - maxChars));
  }))];
  const bestStart = starts
    .map((start) => ({ start, ...chunkWindowScore(lower.slice(start, start + maxChars), normalizedGroups) }))
    .sort((left, right) =>
      right.distinctGroups - left.distinctGroups
      || right.occurrences - left.occurrences
      || left.start - right.start)[0]!.start;
  return text.slice(bestStart, bestStart + maxChars);
}

function termOccurrences(text: string, term: string): number[] {
  const indexes: number[] = [];
  let start = 0;
  while (indexes.length < 128) {
    const index = text.indexOf(term, start);
    if (index === -1) break;
    indexes.push(index);
    start = index + term.length;
  }
  return indexes;
}

function chunkWindowScore(
  text: string,
  termGroups: ReadonlyArray<readonly string[]>,
): { distinctGroups: number; occurrences: number } {
  let distinctGroups = 0;
  let occurrences = 0;
  for (const group of termGroups) {
    const count = Math.max(0, ...group.map((term) => termOccurrences(text, term).length));
    if (count > 0) distinctGroups += 1;
    occurrences += count;
  }
  return { distinctGroups, occurrences };
}

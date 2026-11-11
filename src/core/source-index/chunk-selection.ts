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
  'did',
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
  // The product's own name addresses the tool ("use Olympus"), not the text.
  'olympus',
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
  'use',
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
  options: SourceIndexWindowOptions = {},
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
    const snippet = sourceIndexChunkSnippet(text, termGroups, fairShare, options);
    if (!snippet) continue;
    const included = snippet.length > remaining ? snippet.slice(0, remaining) : snippet;
    chunks.push(included);
    remaining -= included.length;
    if (included.length < text.length) truncated = true;
  }
  return { chunks, truncated };
}

/**
 * Query term groups minus those an item's name carries. The name is already
 * in front of the reader, so its words say nothing about where in the text
 * the answer sits; the pack excerpt and the prompt fit anchor on the rest.
 */
export function withoutNameTerms(
  termGroups: ReadonlyArray<readonly string[]>,
  title: string | null | undefined,
): ReadonlyArray<readonly string[]> {
  if (!title) return termGroups;
  const nameTokens = new Set(title.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  if (nameTokens.size === 0) return termGroups;
  return termGroups.filter((group) => !group.some((term) => nameTokens.has(term.toLowerCase())));
}

export interface SourceIndexWindowOptions {
  /**
   * Open the window a short lead before the densest cluster of terms and
   * spend the rest on what follows it: a label's value comes after the label.
   * Without it a window can be placed to take in earlier, scattered mentions
   * and end just after the cluster, cutting the value it labels. Used where
   * windows are small (the prompt fit's per-seat share).
   */
  followCluster?: boolean;
}

function sourceIndexChunkSnippet(
  text: string,
  termGroups: ReadonlyArray<readonly string[]>,
  maxChars: number | undefined,
  options: SourceIndexWindowOptions = {},
): string {
  if (maxChars === undefined || maxChars <= 0 || text.length <= maxChars) return text;
  const lower = text.toLowerCase();
  const normalizedGroups = termGroups
    .map((group) => [...new Set(group.map((term) => term.toLowerCase()).filter(Boolean))])
    .filter((group) => group.length > 0);
  const occurrencesByGroup = normalizedGroups.map((group) =>
    group.flatMap((term) => termOccurrences(lower, term)));
  const occurrences = occurrencesByGroup.flat();
  if (occurrences.length === 0) return text.slice(0, maxChars);
  if (options.followCluster) {
    const start = clusterWindowStart(text.length, occurrencesByGroup, maxChars);
    return text.slice(start, start + maxChars);
  }

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

/**
 * Where a cluster-following window starts: find the densest cluster (the
 * match that, within half a window, reaches the most distinct term groups in
 * the shortest span, earliest on a tie) and open the window a short lead
 * before its first term, leaving the rest for what the cluster labels.
 */
function clusterWindowStart(
  textLength: number,
  occurrencesByGroup: ReadonlyArray<readonly number[]>,
  maxChars: number,
): number {
  const matches = occurrencesByGroup
    .flatMap((indexes, group) => indexes.map((index) => ({ index, group })))
    .sort((left, right) => left.index - right.index || left.group - right.group);
  const reach = Math.floor(maxChars / 2);
  let best = { index: matches[0]!.index, groups: 0, span: Number.POSITIVE_INFINITY };
  for (let first = 0; first < matches.length; first += 1) {
    const seen = new Set<number>();
    let span = 0;
    for (let next = first; next < matches.length && matches[next]!.index - matches[first]!.index <= reach; next += 1) {
      if (seen.has(matches[next]!.group)) continue;
      seen.add(matches[next]!.group);
      span = matches[next]!.index - matches[first]!.index;
    }
    if (seen.size > best.groups || (seen.size === best.groups && span < best.span)) {
      best = { index: matches[first]!.index, groups: seen.size, span };
    }
  }
  const lead = Math.min(Math.floor(maxChars / 8), best.index);
  return Math.min(best.index - lead, Math.max(0, textLength - maxChars));
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

/**
 * A passage without its layout padding: runs of spaces and tabs become one
 * space, trailing spaces leave each line, and blank-line runs shrink to one
 * blank line. Words, numbers and line structure are untouched.
 */
export function compactPassageWhitespace(text: string): string {
  return text
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

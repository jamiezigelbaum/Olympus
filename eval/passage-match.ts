/** Versioned retrieval-only rule; independent of query wording and source. */
export const PASSAGE_MATCH_RULE = 'ordered-word-coverage-0.8-window-v1';

export function passageWords(text: string): string[] {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/(?<=\p{L})[-\u00ad][\t ]*\r?\n[\t ]*(?=\p{L})/gu, '')
    .replace(/[\p{P}\p{S}]/gu, ' ').split(/\s+/u).filter(Boolean);
}

/** LCS within a bounded consecutive word window. No set/substring shortcuts:
 * order and repeated words both matter. Small quotes keep this bounded.
 */
export function passageContainsQuote(passage: string, quote: string): boolean {
  const wanted = passageWords(quote);
  if (!wanted.length) return false;
  const words = passageWords(passage);
  const needed = Math.ceil(0.8 * wanted.length);
  const window = wanted.length + Math.max(4, Math.ceil(wanted.length / 2));
  if (words.length < needed) return false;
  // Every possible run, including the sole short passage and final window.
  for (let start = 0; start <= Math.max(0, words.length - window); start++) {
    const dp = new Uint16Array(wanted.length + 1);
    for (let j = start; j < Math.min(words.length, start + window); j++) {
      let previous = 0;
      for (let i = 1; i <= wanted.length; i++) {
        const saved = dp[i]!;
        dp[i] = wanted[i - 1] === words[j] ? previous + 1 : Math.max(dp[i]!, dp[i - 1]!);
        previous = saved;
      }
      if (dp[wanted.length]! >= needed) return true;
    }
  }
  return false;
}

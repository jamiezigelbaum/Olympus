import { franc } from 'franc-min';
import * as lexicons from 'stopword';
import { keywordExpansionDisabled } from './keyword-context.ts';

const EMPTY: ReadonlySet<string> = new Set();
const cached = new Map<string, ReadonlySet<string>>();
// English keeps its existing, product-calibrated vocabulary (including May,
// will and US). Other languages use data, not handwritten language branches.
const DEFAULT_QUERY_LANGUAGE = 'eng';
// Short questions give character-based detectors little context. Function
// words identify an English request even when its topic resembles another
// language; otherwise expanding into English adds same-language synonyms.
export function keywordQueryLanguage(query: string, minLength = 30): string {
  const language = franc(query, {minLength});
  if (language === DEFAULT_QUERY_LANGUAGE) return language;
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const words = lexicons as unknown as Record<string, readonly string[] | undefined>;
  const english = tokens.filter(token => words.eng?.includes(token)).length;
  const foreign = tokens.filter(token => words[language]?.includes(token)).length;
  return english > foreign && (language !== 'und' || english >= 2) ? DEFAULT_QUERY_LANGUAGE : language;
}
export function foreignQueryStopwords(query: string, defaultStopwords: ReadonlySet<string>): ReadonlySet<string> {
  if (keywordExpansionDisabled()) return EMPTY;
  const language = keywordQueryLanguage(query, 20);
  if (language === DEFAULT_QUERY_LANGUAGE || language === 'und') return EMPTY;
  const existing = cached.get(language);
  if (existing) return choose(existing);
  const words=(lexicons as unknown as Record<string,unknown>)[language];
  const stopwords: ReadonlySet<string> = Array.isArray(words) ? new Set(words.map(word=>String(word).normalize('NFC').toLowerCase())) : EMPTY;
  cached.set(language,stopwords);
  return choose(stopwords);
  function choose(candidate: ReadonlySet<string>): ReadonlySet<string> {
    const tokens=query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    const defaultSignals=tokens.filter(token=>defaultStopwords.has(token)).length;
    const foreignSignals=tokens.filter(token=>candidate.has(token)).length;
    return defaultSignals > foreignSignals ? EMPTY : candidate;
  }
}

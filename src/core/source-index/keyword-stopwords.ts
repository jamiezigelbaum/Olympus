import { franc, francAll } from 'franc-min';
import lexicons from 'stopwords-iso/stopwords-iso.json';
import { keywordExpansionDisabled } from './keyword-context.ts';

const EMPTY: ReadonlySet<string> = new Set();
const cached = new Map<string, ReadonlySet<string>>();
const key = (word: string) => word.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
const words = lexicons as unknown as Record<string, readonly string[] | undefined>;

function functionWords(language: string): ReadonlySet<string> {
  const existing = cached.get(language);
  if (existing) return existing;
  const data = words[new Intl.Locale(language).language];
  const result = data ? new Set(data.map(key)) : EMPTY;
  cached.set(language,result);
  return result;
}
// English keeps its product-calibrated vocabulary, including May, will and US.
// Function words disambiguate short questions that give the character detector
// little context. A lone shared preposition is insufficient to choose a language.
export function keywordQueryLanguage(query: string, minLength = 30, englishWords: ReadonlySet<string> = functionWords('eng')): string {
  const language = franc(query, {minLength});
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const english = tokens.filter(token=>englishWords.has(key(token))).length;
  const languages = francAll(query,{minLength:6}).map(([code])=>code).filter(code=>code!=='und');
  const scores = new Map(languages.map(code=>[code,code==='eng' ? english : tokens.filter(token=>functionWords(code).has(key(token))).length]));
  scores.set('eng',english);
  const best = Math.max(0,...scores.values());
  if (best >= 2) {
    if (english === best) return 'eng';
    if (scores.get(language) === best) return language;
    const winners = [...scores].filter(([,score])=>score===best);
    if (winners.length === 1) return winners[0]![0];
  }
  const foreign = scores.get(language) ?? 0;
  return english > foreign && (language !== 'und' || english >= 2) ? 'eng' : language;
}
export function foreignQueryStopwords(query: string, defaultStopwords: ReadonlySet<string>): ReadonlySet<string> {
  if (keywordExpansionDisabled()) return EMPTY;
  const language = keywordQueryLanguage(query,6,defaultStopwords);
  if (language === 'eng' || language === 'und') return EMPTY;
  const candidate = functionWords(language);
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const defaultSignals = tokens.filter(token=>defaultStopwords.has(key(token))).length;
  const foreignSignals = tokens.filter(token=>candidate.has(key(token))).length;
  // Return the question's actual spellings, including accented interrogatives.
  return defaultSignals > foreignSignals ? EMPTY : new Set(tokens.filter(token=>candidate.has(key(token))));
}

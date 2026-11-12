import { passageWords } from './passage-match.ts';
// Held-out evaluation schema for the Olympus source pipeline.
//
// The point of this eval is that "done" means passing questions the code was
// never shown — a regex/template answer layer cannot pass it, so it forces the
// general (Analyst) path. Each shape below is a generalization trap that the
// previous per-question approach would fail.

export type EvalQuestionShape =
  | 'value_lookup' // a specific value on a specific date/record
  | 'trend_or_chronology' // how something changed over time, in order
  | 'count_or_aggregate' // how many / how much across items
  | 'locator' // where is the file/message; path + link
  | 'cross_source_synthesis' // combine two or more sources into one answer
  | 'summary_or_sentiment' // gist or tone of a thread/document
  | 'coverage_negative' // expected answer is an honest "I have nothing on this"
  | 'gap_honesty' // some evidence is unextractable; analyst must say so
  | 'version_conflict'; // several versions of one document disagree; newest named by date, or each version's value

export interface EvalExpectedEvidence {
  corpusId: string;
  /** Verbatim item text, normalized to 6–40 words, used only for retrieval evals. */
  quote?: string;
  alternates?: readonly { corpusId: string; providerItemId: string }[];
  providerItemId?: string; // fill for precise grading; omit to require >=1 citation
  /** Exact Castor-visible locator required for citation canonicality checks. */
  uri?: string;
  /**
   * For an item that came inside another (an attachment, a photo): text the
   * cited item's parent label must contain, so the citation names where the
   * item came from (docs/design/child-items.md). Case-insensitive.
   */
  parentLabel?: string;
  hint: string; // human description of the file/message that should be cited
}

export interface EvalQuestion {
  id: string;
  split?: 'open' | 'sealed';
  shape: EvalQuestionShape;
  question: string;
  // Operator fills these against a real corpus. A held-out question is one NOT
  // represented in any answer template.
  expectedAnswerContains?: readonly string[]; // substrings a correct answer must contain
  expectedEvidence?: readonly EvalExpectedEvidence[];
  mustReportGap?: boolean; // for gap_honesty / coverage_negative
  /** Per-question product latency ceiling; tighter than the runner default. */
  maxDurationMs?: number;
  maxTrustDomain?: 'public_safe' | 'internal' | 'secure_local';
  notes?: string;
}

export interface EvalDataset {
  version: string;
  description: string;
  questions: readonly EvalQuestion[];
}

/** Content-free validation for the retrieval dataset. Legacy answer evals do
 * not call this: their schema, expectations and grading remain unchanged.
 */
export function validatePassageDataset(value: unknown): asserts value is EvalDataset {
  const fail = () => { throw new Error('Invalid passage dataset; quotes require 6 to 40 normalized words and precise item ids.'); };
  if (!value || typeof value !== 'object' || !Array.isArray((value as EvalDataset).questions)) return fail();
  const ids = new Set<string>();
  const shapes = new Set(['value_lookup', 'trend_or_chronology', 'count_or_aggregate', 'locator', 'cross_source_synthesis', 'summary_or_sentiment', 'coverage_negative', 'gap_honesty', 'version_conflict']);
  for (const q of (value as EvalDataset).questions) {
    if (!q || typeof q.id !== 'string' || !q.id || ids.has(q.id) || typeof q.question !== 'string' || !q.question.trim() || !shapes.has(q.shape)) return fail();
    ids.add(q.id);
    if (q.split !== undefined && q.split !== 'open' && q.split !== 'sealed') return fail();
    if (q.shape !== 'coverage_negative' && (!Array.isArray(q.expectedEvidence) || !q.expectedEvidence.length)) return fail();
    if (q.expectedEvidence !== undefined && !Array.isArray(q.expectedEvidence)) return fail();
    for (const e of q.expectedEvidence ?? []) {
      if (!e || typeof e.corpusId !== 'string' || !e.corpusId || typeof e.providerItemId !== 'string' || !e.providerItemId || typeof e.quote !== 'string') return fail();
      const words = passageWords(e.quote);
      if (words.length < 6 || words.length > 40) return fail();
      if (e.alternates !== undefined && (!Array.isArray(e.alternates) || e.alternates.some((a: { corpusId: string; providerItemId: string }) => !a || typeof a.corpusId !== 'string' || !a.corpusId || typeof a.providerItemId !== 'string' || !a.providerItemId))) return fail();
    }
  }
}

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
  | 'gap_honesty'; // some evidence is unextractable; analyst must say so

export interface EvalExpectedEvidence {
  corpusId: string;
  providerItemId?: string; // fill for precise grading; omit to require >=1 citation
  /** Exact Castor-visible locator required for citation canonicality checks. */
  uri?: string;
  hint: string; // human description of the file/message that should be cited
}

export interface EvalQuestion {
  id: string;
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

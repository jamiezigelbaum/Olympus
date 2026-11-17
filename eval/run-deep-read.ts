// Deep-read eval (1.5 item 8): for each drafted question, the ordinary Ask
// answer (run-passages.ts's pack, fit and Analyst) beside a deep read of the
// question's whole set (the job's own set listing and core/deep-read.ts), with
// the same local Analyst. The receipt holds ids, numbers and timings only.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Analyst, AnalystResult, EvidenceCandidate, EvidencePack } from '../src/core/contracts.ts';
import type { EvidencePackBuildDetail } from '../src/core/evidence-pack.ts';
import { planDeepReadSections, runDeepRead } from '../src/core/deep-read.ts';
import { createAnalyst, DEFAULT_ANALYST_MAX_OUTPUT_CHARS, withPromptBudget } from '../src/core/analyst.ts';
import { createDelphiAnalystModel, maxTokensForChars } from '../src/core/analyst-delphi.ts';
import { DelphiClient } from '../src/core/delphi.ts';
import { loadConfig, parseLane, parseModelProfile } from '../src/core/config.ts';
import { DEFAULT_MAX_CHARS_PER_CANDIDATE, DEFAULT_MAX_RESULTS, type AnalystAnswerLanes } from '../src/workers/source-index/analyst-answer.ts';
import { LOCAL_ANALYST_PROMPT_BYTES_CEILING, localAnalystPromptBudget, resolveLocalAnalystWindow, type LocalAnalystPromptBudget } from '../src/workers/source-index/local-analyst-window.ts';
import { prepareBuiltInRerankerFromEnv } from '../src/workers/source-index/built-in-reranker.ts';
import { DeepReadRefused, pickRelevantDays, pickRelevantDaysWithin, readDeepReadSet, searchSetHits, type DeepReadMode, type DeepReadStore } from '../src/workers/engine/runtime/deep-read-jobs.ts';
import { openEvalDataRoot, type EvalStoreCount, type EvalSkippedStore } from './data-root.ts';
import { parseDataRootArgs } from './data-root-args.ts';
import { buildEvalPack, configuredEvalEmbedding, createEvalSourceLanes, prepareEvalEmbedding, type EvalStoreSearch } from './retrieval.ts';
import { answerMeaningJudge } from './answer-judge.ts';
import { localEvalModel } from './local-model.ts';
import { enterStage, failureCode, runEvalCli, type EvalStage } from './cli-failure.ts';
import { passageContainsQuote } from './passage-match.ts';
import { ANSWER_RIGHT_COVERAGE, answerQuoteCoverage, positiveInteger, runPassageEval } from './run-passages.ts';
import type { EvalDataset, EvalQuestion } from './types.ts';
import { selectedItemOf, validateDeepReadDataset, type DeepReadDataset, type DeepReadQuestion } from './draft-deep-read-questions.ts';

type Meaning = 'correct' | 'partial' | 'wrong' | null;

/** The three numbers, per arm: found (the expected item reached the evidence), read (cited by the answer, or among the deep read's notes), answered correctly. */
export interface ArmOutcome {
  outcome: 'answered' | 'failed'; code?: string;
  found: boolean; read: boolean; right: boolean;
  /** The answer cites the expected item, and the share of the quote's content words it states (the grading rule). */
  cited: boolean; coverage: number;
  meaning?: Meaning;
  seconds: number;
}
export interface BaselineOutcome extends ArmOutcome {
  /** Seat of the expected item in the fitted pack, and of the seat holding the quoted passage. */
  fitRank: number | null; passageRank: number | null; seatsFilled: number;
}
export interface DeepOutcome extends ArmOutcome {
  /** Pieces of the set holding the target (the expected item's passage), and whether a note cites the expected item at all. */
  targetPieces: number; readItem: boolean;
  items: number; unreadable: number; passages: number;
  sections: number; sectionsRead: number; failedSections: number; notes: number; citations: number;
  /** Listing and reading the set's text; reading sections; answering from the notes. */
  setSeconds: number; readingSeconds: number; answerSeconds: number; secondsPerSection: number | null;
  /** Conversations: whether the relevant-days pick kept the answer-bearing message, and how much it kept. */
  dayPicker?: { kept: boolean; days: number; totalDays: number; messageCount: number; totalMessages: number; sections: number; totalSections: number };
  /** The same pick within each section budget (--day-budget-sections), as the engine caps it to the hour. */
  dayPickerBudgets?: Array<{ budget: number; kept: boolean; days: number; messageCount: number; sections: number }>;
  /** Which read the deep arm ran. */
  readMode?: DeepReadMode;
}
export interface DeepReadRow {
  id: string; kind: 'conversation' | 'item';
  target: { index: number; of: number };
  baseline?: BaselineOutcome; deep: DeepOutcome;
}
interface ArmSummary { rows: number; failed: number; found: number; read: number; right: number; correctByMeaning?: number; seconds: number }
interface Paired { wins: number; losses: number; ties: number }
interface Summary {
  baseline?: ArmSummary;
  deep: ArmSummary & { sections: number; sectionsRead: number; readingSeconds: number; secondsPerSection: number | null };
  /** Day-picker recall: conversation rows whose answer-bearing message the relevant-days pick kept, and the share of days and messages it kept. */
  dayPicker?: { rows: number; kept: number; days: number; totalDays: number; messageCount: number; totalMessages: number; sections: number; totalSections: number };
  dayPickerBudgets?: Array<{ budget: number; rows: number; kept: number; days: number; messageCount: number; sections: number }>;
  /** Deep read against baseline, row by row: a win is deep yes and baseline no. */
  paired?: { found: Paired; read: Paired; right: Paired; correctByMeaning?: Paired };
}
export interface DeepReadReceipt {
  schema: 1; gitSha: string; setId: string;
  deepPromptBytes: number; deepPromptBytesSource: LocalAnalystPromptBudget['source'] | 'option';
  baselinePromptBytes?: number; maxResults?: number; reranker?: string;
  storeCounts: readonly EvalStoreCount[]; skippedStores: readonly EvalSkippedStore[];
  rows: DeepReadRow[];
  summary: { overall: Summary; byKind: Record<string, Summary> };
}

const seconds = (ms: number) => Math.round(ms) / 1000;

function armSummary(arms: readonly ArmOutcome[]): ArmSummary {
  return {
    rows: arms.length, failed: arms.filter(a => a.outcome === 'failed').length,
    found: arms.filter(a => a.found).length, read: arms.filter(a => a.read).length, right: arms.filter(a => a.right).length,
    ...(arms.some(a => a.meaning !== undefined) ? { correctByMeaning: arms.filter(a => a.meaning === 'correct').length } : {}),
    seconds: seconds(arms.reduce((n, a) => n + a.seconds * 1000, 0)),
  };
}
function paired(rows: readonly DeepReadRow[], pick: (arm: ArmOutcome) => boolean): Paired {
  const both = rows.filter(row => row.baseline);
  return {
    wins: both.filter(row => pick(row.deep) && !pick(row.baseline!)).length,
    losses: both.filter(row => !pick(row.deep) && pick(row.baseline!)).length,
    ties: both.filter(row => pick(row.deep) === pick(row.baseline!)).length,
  };
}
export function summarizeDeepRead(rows: readonly DeepReadRow[]): Summary {
  const deep = rows.map(row => row.deep);
  const sections = deep.reduce((n, d) => n + d.sectionsRead, 0);
  const readingSeconds = seconds(deep.reduce((n, d) => n + d.readingSeconds * 1000, 0));
  const baselines = rows.flatMap(row => row.baseline ? [row.baseline] : []);
  const meaning = rows.some(row => row.deep.meaning !== undefined);
  const picks = deep.flatMap(d => d.dayPicker ? [d.dayPicker] : []);
  const sum = (key: 'days' | 'totalDays' | 'messageCount' | 'totalMessages' | 'sections' | 'totalSections') => picks.reduce((n, p) => n + p[key], 0);
  const budgets = [...new Set(deep.flatMap(d => (d.dayPickerBudgets ?? []).map(b => b.budget)))];
  return {
    ...(picks.length ? { dayPicker: { rows: picks.length, kept: picks.filter(p => p.kept).length,
      days: sum('days'), totalDays: sum('totalDays'), messageCount: sum('messageCount'), totalMessages: sum('totalMessages'),
      sections: sum('sections'), totalSections: sum('totalSections') } } : {}),
    ...(budgets.length ? { dayPickerBudgets: budgets.map(budget => {
      const at = deep.flatMap(d => (d.dayPickerBudgets ?? []).filter(b => b.budget === budget));
      return { budget, rows: at.length, kept: at.filter(b => b.kept).length, days: at.reduce((n, b) => n + b.days, 0),
        messageCount: at.reduce((n, b) => n + b.messageCount, 0), sections: at.reduce((n, b) => n + b.sections, 0) };
    }) } : {}),
    ...(baselines.length ? { baseline: armSummary(baselines) } : {}),
    deep: { ...armSummary(deep), sections: deep.reduce((n, d) => n + d.sections, 0), sectionsRead: sections, readingSeconds,
      secondsPerSection: sections ? Math.round(readingSeconds / sections * 10) / 10 : null },
    ...(baselines.length ? { paired: {
      found: paired(rows, a => a.found), read: paired(rows, a => a.read), right: paired(rows, a => a.right),
      ...(meaning ? { correctByMeaning: paired(rows, a => a.meaning === 'correct') } : {}),
    } } : {}),
  };
}

/** The question as a one-question passage dataset, so the baseline is run-passages.ts's own computation. */
function passageQuestion(q: DeepReadQuestion): EvalDataset {
  const [first, ...rest] = q.expected;
  const question: EvalQuestion = { id: q.id, split: 'open', shape: 'value_lookup', question: q.question,
    expectedEvidence: [{ corpusId: first!.corpus_id, providerItemId: first!.provider_item_id, quote: q.quote, hint: '',
      ...(rest.length ? { alternates: rest.map(e => ({ corpusId: e.corpus_id, providerItemId: e.provider_item_id })) } : {}) }] };
  return { version: '2', description: 'Deep-read baseline', questions: [question] };
}

export interface DeepReadEvalInput {
  dataset: DeepReadDataset;
  stores: readonly DeepReadStore[];
  /** The answer lanes a deep read reads the set's text through (their content providers). */
  lanes: () => AnalystAnswerLanes;
  analyst: Analyst;
  deepPromptBytes: number; deepPromptBytesSource: DeepReadReceipt['deepPromptBytesSource'];
  /** The ordinary Ask arm, as run-passages.ts builds, fits and answers it; left out to run the deep read alone. */
  baseline?: {
    buildPack: (question: EvalQuestion) => Promise<EvidencePackBuildDetail & { storeSearches?: readonly EvalStoreSearch[] }>;
    answer: (question: EvalQuestion, pack: EvidencePack) => Promise<AnalystResult>;
    promptBytes: number; maxResults: number;
  };
  judgeAnswer?: (question: string, expected: string, answer: string) => Promise<Meaning>;
  /** The set's own search hits, as the engine's relevant-days read finds them (searchSetHits over lanes scoped to the set). */
  setHits?: (q: DeepReadQuestion, corpusIds: readonly string[]) => Promise<ReadonlySet<string>>;
  /** The deep arm's read: every message (default) or the relevant days. */
  read?: DeepReadMode;
  /** Section budgets to cap the relevant-days pick at; the relevant-days read uses the first. */
  dayBudgets?: readonly number[];
  /** Score the day picker only: no model call. */
  dayPickerOnly?: boolean;
  storeCounts: readonly EvalStoreCount[]; skippedStores?: readonly EvalSkippedStore[]; gitSha: string;
  /** Step names and counts only. */
  onProgress?: (index: number, total: number, step: string) => void;
  /** Called with the receipt so far after each row. */
  onRow?: (receipt: DeepReadReceipt) => void;
}

export async function runDeepReadEval(input: DeepReadEvalInput): Promise<DeepReadReceipt> {
  validateDeepReadDataset(input.dataset);
  const questions = input.dataset.questions;
  const rows: DeepReadRow[] = [];
  let reranker: string | undefined;
  const receipt = (): DeepReadReceipt => ({
    schema: 1, gitSha: input.gitSha,
    setId: createHash('sha256').update(JSON.stringify(questions.map(q => [q.id, q.kind]).sort((a, b) => a[0]!.localeCompare(b[0]!)))).digest('hex'),
    deepPromptBytes: input.deepPromptBytes, deepPromptBytesSource: input.deepPromptBytesSource,
    ...(input.baseline ? { baselinePromptBytes: input.baseline.promptBytes, maxResults: input.baseline.maxResults, reranker: reranker ?? 'off' } : {}),
    storeCounts: input.storeCounts, skippedStores: input.skippedStores ?? [], rows: [...rows],
    summary: { overall: summarizeDeepRead(rows), byKind: Object.fromEntries(['conversation', 'item'].flatMap(kind => {
      const of = rows.filter(row => row.kind === kind);
      return of.length ? [[kind, summarizeDeepRead(of)]] : [];
    })) },
  });
  for (const [position, q] of questions.entries()) {
    const step = (name: string) => input.onProgress?.(position + 1, questions.length, name);
    let baseline: BaselineOutcome | undefined;
    if (input.baseline) {
      step('baseline');
      const started = performance.now();
      const passage = await runPassageEval({ dataset: passageQuestion(q), maxResults: input.baseline.maxResults, promptBytes: input.baseline.promptBytes,
        storeCounts: input.storeCounts, gitSha: input.gitSha, buildPack: input.baseline.buildPack, answer: input.baseline.answer,
        ...(input.judgeAnswer ? { judgeAnswer: input.judgeAnswer } : {}) });
      reranker ??= passage.reranker;
      const row = passage.questions![0]!;
      const answer = row.answer!;
      baseline = {
        outcome: answer.outcome, ...(answer.code ? { code: answer.code } : {}),
        found: row.object.firstHitRank !== null, read: answer.cited === true, right: answer.right === true,
        cited: answer.cited === true, coverage: answer.coverage ?? 0,
        ...(answer.meaning !== undefined ? { meaning: answer.meaning } : {}),
        seconds: seconds(performance.now() - started),
        fitRank: row.object.firstHitRank, passageRank: row.passage.firstHitRank, seatsFilled: row.seatsFilled,
      };
    }
    step('deep_read');
    const deep = await deepArm(q, input, (done, total) => step(`deep_read section ${done}/${total}`));
    rows.push({ id: q.id, kind: q.kind, target: q.target, ...(baseline ? { baseline } : {}), deep });
    input.onRow?.(receipt());
  }
  return receipt();
}

async function deepArm(q: DeepReadQuestion, input: DeepReadEvalInput, onSection: (done: number, total: number) => void): Promise<DeepOutcome> {
  const started = performance.now();
  const expectedIds = new Set(q.expected.map(e => e.provider_item_id));
  const isExpected = (item: { provider: string; providerItemId: string; providerConversationId?: string }) =>
    item.provider === q.set.provider && expectedIds.has(item.providerItemId)
    && (q.kind !== 'conversation' || (item.providerConversationId ?? '') === (q.set.provider_conversation_id ?? ''));
  const empty: DeepOutcome = { outcome: 'failed', found: false, read: false, right: false, cited: false, coverage: 0, seconds: 0, targetPieces: 0, readItem: false,
    items: 0, unreadable: 0, passages: 0, sections: 0, sectionsRead: 0, failedSections: 0, notes: 0, citations: 0, setSeconds: 0, readingSeconds: 0, answerSeconds: 0, secondsPerSection: null };
  let set: Awaited<ReturnType<typeof readDeepReadSet>>;
  try { set = await readDeepReadSet(selectedItemOf(q.set), () => input.stores, input.lanes); }
  catch (error) {
    const code = error instanceof DeepReadRefused ? `DEEP_READ_${error.code.toUpperCase()}` : failureCode(error) ?? 'UNKNOWN';
    return { ...empty, code, seconds: seconds(performance.now() - started) };
  }
  const setDone = performance.now();
  const itemPieces = set.candidates.flatMap((candidate, index) => isExpected(candidate.provenance.sourceItem) ? [index] : []);
  const withQuote = itemPieces.filter(index => passageContainsQuote(set.candidates[index]!.chunks.join('\n'), q.quote));
  // The target is the expected item's passage holding the quote; a quote split over two passages falls back to the item.
  const targets = new Set(withQuote.length ? withQuote : itemPieces);
  let dayPicker: DeepOutcome['dayPicker'];
  let dayPickerBudgets: DeepOutcome['dayPickerBudgets'];
  let reading = set.candidates as EvidenceCandidate[];
  if (q.kind === 'conversation' && input.setHits) {
    const all = set.candidates as EvidenceCandidate[];
    const hits = await input.setHits(q, set.corpusIds);
    // Sections scale with the text read, as the engine estimates them.
    const totalSections = planDeepReadSections(q.question, all, set.corpusIds, input.deepPromptBytes, 'compact').length;
    const chars = (picked: readonly EvidenceCandidate[]) => picked.reduce((n, c) => n + c.chunks.join('').length, 0);
    const totalChars = chars(all) || 1;
    const sectionsOf = (picked: readonly EvidenceCandidate[]) => Math.ceil(totalSections * chars(picked) / totalChars);
    const keeps = (picked: readonly EvidenceCandidate[]) => { const kept = new Set(picked); return [...targets].some(index => kept.has(all[index]!)); };
    const pick = pickRelevantDays(all, hits);
    dayPicker = { kept: keeps(pick.candidates), days: pick.days, totalDays: pick.totalDays,
      messageCount: pick.messages, totalMessages: pick.totalMessages, sections: sectionsOf(pick.candidates), totalSections };
    const budgeted = (input.dayBudgets ?? []).map(budget => ({ budget, pick: pickRelevantDaysWithin(all, hits, picked => sectionsOf(picked) <= budget) }));
    if (budgeted.length) dayPickerBudgets = budgeted.map(({ budget, pick: p }) => ({ budget, kept: keeps(p.candidates), days: p.days, messageCount: p.messages, sections: sectionsOf(p.candidates) }));
    const readPick = budgeted[0]?.pick ?? pick;
    if (input.read === 'relevant_days' && readPick.candidates.length) reading = readPick.candidates;
  }
  const readMode: DeepReadMode = reading === set.candidates ? 'all' : 'relevant_days';
  // Indices below are into the read's own candidates.
  const readTargets = new Set([...targets].flatMap(index => { const at = reading.indexOf(set.candidates[index]!); return at >= 0 ? [at] : []; }));
  const readItemPieces = itemPieces.flatMap(index => { const at = reading.indexOf(set.candidates[index]!); return at >= 0 ? [at] : []; });
  const base = { ...empty, items: set.items, unreadable: set.unreadable, passages: set.candidates.length, targetPieces: targets.size,
    found: targets.size > 0, setSeconds: seconds(setDone - started), ...(dayPicker ? { dayPicker } : {}), ...(dayPickerBudgets ? { dayPickerBudgets } : {}), readMode };
  if (input.dayPickerOnly) return { ...base, code: 'DAY_PICKER_ONLY', seconds: seconds(performance.now() - started) };
  let readingStarted: number | undefined; let readingEnded: number | undefined;
  let notes: number[] = []; let sections = 0;
  try {
    const result = await runDeepRead({ question: q.question, candidates: reading, corpusIds: set.corpusIds,
      analyst: input.analyst, promptBytes: input.deepPromptBytes, evidenceFormat: 'compact',
      onProgress: (progress, state) => {
        sections = progress.sectionsTotal;
        if (progress.phase === 'reading') { readingStarted ??= performance.now(); onSection(progress.sectionsDone, progress.sectionsTotal); }
        if (progress.phase !== 'reading') readingEnded ??= performance.now();
        notes = state.notes.map(note => note.candidate);
      } });
    const finished = performance.now();
    const cited = result.citations.some(citation => isExpected(citation.provenance.sourceItem));
    const coverage = answerQuoteCoverage([q.quote], result.answer);
    const readingSeconds = seconds((readingEnded ?? finished) - (readingStarted ?? setDone));
    const sectionsRead = result.sectionsRead;
    const outcome: DeepOutcome = { ...base, outcome: 'answered',
      read: notes.some(index => readTargets.has(index)), readItem: notes.some(index => readItemPieces.includes(index)),
      cited, coverage, right: cited && coverage >= ANSWER_RIGHT_COVERAGE,
      sections: result.sectionsTotal, sectionsRead, failedSections: result.failedSections.length, notes: result.notes, citations: result.citations.length,
      readingSeconds, answerSeconds: seconds(finished - (readingEnded ?? finished)),
      secondsPerSection: sectionsRead ? Math.round(readingSeconds / sectionsRead * 10) / 10 : null,
      seconds: seconds(finished - started) };
    if (input.judgeAnswer) outcome.meaning = await input.judgeAnswer(q.question, q.quote, result.answer);
    return outcome;
  } catch (error) {
    const now = performance.now();
    return { ...base, code: failureCode(error) ?? 'UNKNOWN', sections, notes: notes.length, read: notes.some(index => readTargets.has(index)),
      readItem: notes.some(index => readItemPieces.includes(index)), readingSeconds: seconds((readingEnded ?? now) - (readingStarted ?? setDone)), seconds: seconds(now - started) };
  }
}

/** A new 0600 file renamed into place (ids and numbers only). */
function writeReceipt(path: string, receipt: DeepReadReceipt): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try { writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

export async function main(argv = process.argv.slice(2), stage?: EvalStage): Promise<void> {
  const enter = (name: string) => enterStage(stage, name, 'deep-read eval');
  enter('arguments');
  const { isolation, rest } = parseDataRootArgs(argv);
  if (!isolation) throw new Error('--data-root is required.');
  const values = new Map<string, string>(); let datasetPath: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.split('=', 2);
      if (key === '--judge-answers' || key === '--no-baseline' || key === '--day-picker-only') { if (inline !== undefined) throw new Error(`${key} takes no value.`); values.set(key, 'yes'); continue; }
      if (!['--output', '--max-results', '--max-chars-per-candidate', '--prompt-bytes', '--deep-prompt-bytes', '--only', '--read', '--day-budget-sections', '--window-tokens'].includes(key!)) throw new Error('Unsupported deep-read eval option.');
      const value = inline ?? rest[++index];
      if (!value || value.startsWith('--')) throw new Error('Deep-read eval option requires a value.');
      values.set(key!, value);
    } else { if (datasetPath) throw new Error('One dataset path is required.'); datasetPath = arg; }
  }
  const dataset: unknown = JSON.parse(readFileSync(datasetPath ?? 'eval/private/deep-read-questions.json', 'utf8'));
  validateDeepReadDataset(dataset);
  const only = values.get('--only')?.split(',').map(id => id.trim()).filter(Boolean);
  const selected: DeepReadDataset = only ? { ...dataset, questions: dataset.questions.filter(q => only.includes(q.id)) } : dataset;
  const maxResults = positiveInteger(values.get('--max-results'), DEFAULT_MAX_RESULTS);
  const maxCharsPerCandidate = positiveInteger(values.get('--max-chars-per-candidate'), DEFAULT_MAX_CHARS_PER_CANDIDATE);
  const read = values.get('--read');
  if (read !== undefined && read !== 'all' && read !== 'relevant_days') throw new Error('--read must be all or relevant_days.');
  const dayPickerOnly = values.has('--day-picker-only');
  const dayBudgets = values.get('--day-budget-sections')?.split(',').map(value => positiveInteger(value.trim(), 0));
  if (dayBudgets?.some(value => value <= 0)) throw new Error('--day-budget-sections takes positive section counts, comma-separated.');
  enter('open_data_root');
  const opened = openEvalDataRoot(isolation);
  try {
    const config = loadConfig();
    // The day picker's own search, as the engine runs it: each store scoped to the question's conversation.
    enter('load_embedding');
    const pickerEmbedding = await prepareEvalEmbedding({ configured: await configuredEvalEmbedding(config, process.env) });
    const setHits: DeepReadEvalInput['setHits'] = async (q, corpusIds) => {
      const conversationId = q.set.provider_conversation_id;
      if (!conversationId) return new Set<string>();
      const scoped = createEvalSourceLanes({ ...opened, embeddingFor: pickerEmbedding.embeddingFor, storeScope: () => ({ filters: { conversationId } }) });
      return searchSetHits(scoped(q.question), q.question, corpusIds);
    };
    const output = values.get('--output') ?? 'eval/private/deep-read.latest.json';
    const run = async (rest: Pick<DeepReadEvalInput, 'analyst' | 'deepPromptBytes' | 'deepPromptBytesSource' | 'lanes'> & Partial<DeepReadEvalInput>) => {
      const receipt = await runDeepReadEval({ dataset: selected, stores: opened.stores, setHits, ...(read ? { read } : {}), ...(dayPickerOnly ? { dayPickerOnly } : {}),
        ...(dayBudgets?.length ? { dayBudgets } : {}),
        storeCounts: opened.storeCounts, skippedStores: opened.skipped,
        gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        onProgress: (index, total, step) => enter(`question ${index}/${total}: ${step}`),
        onRow: partial => { opened.checkFileDescriptors(); writeReceipt(output, partial); },
        ...rest,
      });
      enter('write_receipt');
      opened.checkFileDescriptors();
      writeReceipt(output, receipt);
      return receipt;
    };
    if (dayPickerOnly) {
      const lanes = createEvalSourceLanes({ ...opened });
      // Sections are counted at the named budget, else at the engine's ceiling.
      const receipt = await run({ lanes: () => lanes(''), deepPromptBytes: positiveInteger(values.get('--deep-prompt-bytes'), LOCAL_ANALYST_PROMPT_BYTES_CEILING), deepPromptBytesSource: 'option',
        analyst: { analyze: async () => { throw new Error('No model call in --day-picker-only.'); } } });
      console.log(JSON.stringify({ storesOpened: opened.stores.length, storesSkipped: opened.skipped.length, ...receipt.summary }));
      return;
    }
    enter('load_analyst');
    // The same local profile or lane, Analyst options and availability check as run-passages.ts --answer.
    const lane = process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE?.trim() ? parseLane(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE) : undefined;
    const profile = process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE?.trim() ? parseModelProfile(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE) : 'source_answer';
    const delphi = new DelphiClient(config);
    try {
      const signal = AbortSignal.timeout(5_000);
      const models = lane ? await delphi.listModels(lane, signal) : await delphi.listModelsForProfile(profile, signal);
      if (!models.length) throw new Error('No local models available.');
    } catch (error) {
      throw Object.assign(new Error('Local Analyst is unavailable.'), { code: failureCode(error) ?? 'LOCAL_MODEL_UNAVAILABLE' });
    }
    const analyst = createAnalyst(createDelphiAnalystModel(delphi, lane ? { lane } : { profile }), { auditSuspiciousDrafts: true, evidenceFormat: 'compact' });
    // The deep read job's budget: the model's served window, as the engine sizes it (no env override).
    const endpoint = lane ? config.argus.lanes[lane] : config.argus.modelProfiles[profile];
    // --window-tokens: the served window for an endpoint that cannot report it (the Delphi gateway), as eval:panel takes it.
    const namedWindow = values.has('--window-tokens') ? positiveInteger(values.get('--window-tokens'), 0) : undefined;
    const window = namedWindow ? { windowTokens: namedWindow, source: 'manifest' as const }
      : await resolveLocalAnalystWindow({ model: endpoint.model, baseUrl: endpoint.baseUrl });
    const budget = localAnalystPromptBudget(undefined, window, maxTokensForChars(DEFAULT_ANALYST_MAX_OUTPUT_CHARS));
    const deepPromptBytes = values.has('--deep-prompt-bytes') ? positiveInteger(values.get('--deep-prompt-bytes'), budget.bytes) : budget.bytes;
    // The baseline is sized like the engine's Ask leg on this model, unless named.
    const promptBytes = positiveInteger(values.get('--prompt-bytes') ?? process.env.OLYMPUS_SOURCE_INDEX_LOCAL_ANALYST_PROMPT_BYTES, budget.bytes);
    const judgeAnswer = values.has('--judge-answers') ? answerMeaningJudge(localEvalModel(config)) : undefined;
    let baseline: DeepReadEvalInput['baseline'];
    let lanes: (question: string) => AnalystAnswerLanes;
    if (!values.has('--no-baseline')) {
      const embedding = pickerEmbedding;
      enter('load_reranker');
      const reranker = await prepareBuiltInRerankerFromEnv();
      let searches: EvalStoreSearch[] = [];
      lanes = createEvalSourceLanes({ ...opened, embeddingFor: embedding.embeddingFor, onStoreSearch: search => { searches.push(search); } });
      baseline = {
        maxResults, promptBytes,
        buildPack: async q => {
          searches = [];
          const built = await buildEvalPack({ question: q.question, lanes, maxResults, maxCharsPerCandidate, ...(reranker ? { reranker } : {}) });
          return { ...built, storeSearches: searches };
        },
        answer: (_question, pack) => analyst.analyze(withPromptBudget(pack, promptBytes), { localOnly: true }),
      };
    } else lanes = createEvalSourceLanes({ ...opened });
    const receipt = await run({ lanes: () => lanes(''), analyst,
      deepPromptBytes, deepPromptBytesSource: values.has('--deep-prompt-bytes') || namedWindow ? 'option' : budget.source,
      ...(baseline ? { baseline } : {}), ...(judgeAnswer ? { judgeAnswer } : {}),
    });
    console.log(JSON.stringify({ storesOpened: opened.stores.length, storesSkipped: opened.skipped.length, deepPromptBytes, baselinePromptBytes: baseline ? promptBytes : undefined, ...receipt.summary }));
  } finally { try { opened.checkFileDescriptors(); } finally { opened.close(); } }
}
if (import.meta.main) runEvalCli('Deep-read eval', stage => main(process.argv.slice(2), stage));

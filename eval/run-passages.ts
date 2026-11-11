// Retrieval-only eval: no Analyst or query planner is constructed or called.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EvidencePackBuildDetail } from '../src/core/evidence-pack.ts';
import { loadConfig } from '../src/core/config.ts';
import { fitPackToPromptBytes, DEFAULT_LOCAL_ANALYST_PROMPT_BYTES, DEFAULT_MAX_CHARS_PER_CANDIDATE } from '../src/workers/source-index/analyst-answer.ts';
import { prepareBuiltInRerankerFromEnv } from '../src/workers/source-index/built-in-reranker.ts';
import { openEvalDataRoot, type EvalStoreCount, type EvalSkippedStore } from './data-root.ts';
import { parseDataRootArgs } from './data-root-args.ts';
import { buildEvalPack, createEvalSourceLanes, configuredEvalEmbedding, prepareEvalEmbedding } from './retrieval.ts';
import { passageContainsQuote, PASSAGE_MATCH_RULE } from './passage-match.ts';
import { validatePassageDataset, type EvalDataset, type EvalQuestion } from './types.ts';

export type EvalSplit = 'open' | 'sealed';
interface HitScore { firstHitRank: number | null; reciprocalRank: number; hitsAtK: Record<string, number> }
interface Metrics { hitsAtK: Record<string, number>; recallAtK: Record<string, number>; mrr: number }
export interface PassageSummary {
  /** Questions scored; a degraded question is counted in `degraded` instead. */
  questions: number; answerable: number; unanswerable: number; negativeSeats: number; degraded: number;
  object: Metrics; passage: Metrics;
  timings: { buildPackMs: number; fitMs: number; totalMs: number; storeSearchMs: number };
}
export interface PassageRow {
  questionId: string; shape: string; families: string[]; tiers: string[];
  seatsFilled: number; answerable: boolean; object: HitScore; passage: HitScore;
  /** Present when a store's search was cut short: which store and lane, and why (codes only). Left out of the metrics. */
  degraded?: Degradation[];
  timings: PassageSummary['timings'];
  corpusTimings: { corpusId: string; elapsedMs: number; outcome: 'success' | 'timeout' }[];
}
export interface Degradation { corpusId: string; lane?: string; reason: string }
export interface PassageReceipt {
  schema: 3; rule: typeof PASSAGE_MATCH_RULE; gitSha: string; split: EvalSplit;
  setId: string; maxResults: number; ks: number[];
  storeCounts: readonly EvalStoreCount[]; skippedStores: readonly EvalSkippedStore[];
  summary: { overall: PassageSummary; byShape: Record<string, PassageSummary>; byFamily: Record<string, PassageSummary>; byTier: Record<string, PassageSummary> };
  questions?: PassageRow[];
  /** Ids of the questions left out as degraded; sealed receipts carry these but no rows. */
  degradedIds: string[];
}
function score(rank: number | null, ks: readonly number[]): HitScore {
  return { firstHitRank: rank, reciprocalRank: rank === null ? 0 : 1 / rank, hitsAtK: Object.fromEntries(ks.map(k => [k, rank !== null && rank <= k ? 1 : 0])) };
}
function summarize(all: readonly PassageRow[], ks: readonly number[]): PassageSummary {
  const rows = all.filter(row => !row.degraded);
  const positives = rows.filter(row => row.answerable);
  const metric = (key: 'object' | 'passage'): Metrics => {
    const hitsAtK = Object.fromEntries(ks.map(k => [k, positives.reduce((n, row) => n + row[key].hitsAtK[k]!, 0)]));
    return { hitsAtK, recallAtK: Object.fromEntries(ks.map(k => [k, positives.length ? hitsAtK[k]! / positives.length : 0])), mrr: positives.length ? positives.reduce((n, row) => n + row[key].reciprocalRank, 0) / positives.length : 0 };
  };
  return {
    questions: rows.length, answerable: positives.length, unanswerable: rows.length - positives.length,
    negativeSeats: rows.filter(row => !row.answerable).reduce((n, row) => n + row.seatsFilled, 0),
    degraded: all.length - rows.length,
    object: metric('object'), passage: metric('passage'),
    timings: Object.fromEntries(['buildPackMs', 'fitMs', 'totalMs', 'storeSearchMs'].map(key => [key, rows.reduce((n, row) => n + row.timings[key as keyof PassageRow['timings']], 0)])) as PassageSummary['timings'],
  };
}
function grouped(rows: readonly PassageRow[], ks: readonly number[], groups: (row: PassageRow) => string[]): Record<string, PassageSummary> {
  const buckets = new Map<string, PassageRow[]>();
  for (const row of rows) for (const group of new Set(groups(row))) buckets.set(group, [...(buckets.get(group) ?? []), row]);
  return Object.fromEntries([...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([key, entries]) => [key, summarize(entries, ks)]));
}

export async function runPassageEval(input: {
  dataset: EvalDataset; split?: EvalSplit; maxResults: number; promptBytes?: number;
  storeCounts: readonly EvalStoreCount[]; skippedStores?: readonly EvalSkippedStore[]; gitSha: string;
  buildPack: (question: EvalQuestion) => Promise<EvidencePackBuildDetail>;
}): Promise<PassageReceipt> {
  validatePassageDataset(input.dataset);
  const split = input.split ?? 'open';
  const questions = input.dataset.questions.filter(q => (q.split ?? 'open') === split);
  if (!Number.isInteger(input.maxResults) || input.maxResults < 1) throw new Error('Pack size must be positive.');
  const ks = [...new Set([1, 3, 5, 10, input.maxResults])].sort((a, b) => a - b);
  const rows: PassageRow[] = [];
  const stores = new Map(input.storeCounts.map(store => [store.corpusId, store]));
  for (const question of questions) {
    const started = performance.now();
    const detail = await input.buildPack(question);
    // A cut-short search is not an ordinary miss: the question is recorded
    // as degraded, left out of the metrics, and the run goes on.
    const degraded = degradationsOf(detail);
    const builtAt = performance.now();
    const original = detail.pack;
    const pack = input.promptBytes === undefined ? original : fitPackToPromptBytes(original, input.promptBytes,
      new Map(original.candidates.map((candidate, index) => [candidate, detail.candidateCorpusIds[index] ?? ''])),
      { localOnly: original.candidates.some(candidate => candidate.trustDomain === 'secure_local') }, detail.recencySeats,
      // A prompt budget is the local Analyst lane's, which is sent the compact
      // format and only the kept seats' extraction gaps (as run-real.ts fits).
      'compact', new Map(original.candidates.map((candidate, index) => [candidate.provenance, detail.candidateExtractionGapIndexes?.[index] ?? []])));
    let objectRank: number | null = null;
    let passageRank: number | null = null;
    for (const [index, seat] of pack.candidates.entries()) {
      const originalIndex = original.candidates.findIndex(candidate => candidate.provenance === seat.provenance);
      const corpusId = detail.candidateCorpusIds[originalIndex];
      for (const expected of question.expectedEvidence ?? []) {
        const identities = [expected, ...(expected.alternates ?? [])];
        if (!identities.some(item => item.corpusId === corpusId && item.providerItemId === seat.provenance.sourceItem.providerItemId)) continue;
        objectRank ??= index + 1;
        if (expected.quote && passageContainsQuote([...seat.chunks, ...(seat.facts ?? []).map(fact => fact.claim), ...(seat.tables ?? []).flatMap(table => [table.caption ?? '', ...table.columns, ...table.rows.map(row => row.join(' '))])].join('\n'), expected.quote)) passageRank ??= index + 1;
      }
    }
    const expectedStores = (question.expectedEvidence ?? []).map(e => stores.get(e.corpusId));
    const finished = performance.now();
    rows.push({ questionId: question.id, shape: question.shape,
      families: expectedStores.length ? [...new Set(expectedStores.map(store => store?.family ?? 'unknown'))] : ['unknown'],
      tiers: expectedStores.length ? [...new Set(expectedStores.map((store, i) => store?.tier ?? question.expectedEvidence![i]!.corpusId.split('.')[0]!))] : ['unknown'],
      seatsFilled: pack.candidates.length, answerable: question.shape !== 'coverage_negative', object: score(objectRank, ks), passage: score(passageRank, ks),
      ...(degraded.length ? { degraded } : {}),
      timings: { buildPackMs: builtAt - started, fitMs: finished - builtAt, totalMs: finished - started, storeSearchMs: (detail.corpusTimings ?? []).reduce((n, t) => n + t.elapsedMs, 0) },
      corpusTimings: (detail.corpusTimings ?? []).map(t => ({ corpusId: t.corpusId, elapsedMs: t.elapsedMs, outcome: t.outcome })),
    });
  }
  return { schema: 3, rule: PASSAGE_MATCH_RULE, gitSha: input.gitSha, split,
    // Identity includes only ids and structural labels; never hashes private text.
    setId: createHash('sha256').update(JSON.stringify(questions.map(q => [q.id, q.shape]).sort((a, b) => a[0]!.localeCompare(b[0]!)))).digest('hex'),
    maxResults: input.maxResults, ks, storeCounts: input.storeCounts, skippedStores: input.skippedStores ?? [],
    summary: summaries(rows, ks),
    ...(split === 'open' ? { questions: rows } : {}),
    degradedIds: rows.filter(row => row.degraded).map(row => row.questionId),
  };
}

function summaries(rows: readonly PassageRow[], ks: readonly number[]): PassageReceipt['summary'] {
  return { overall: summarize(rows, ks), byShape: grouped(rows, ks, row => [row.shape]), byFamily: grouped(rows, ks, row => row.families), byTier: grouped(rows, ks, row => row.tiers) };
}

/** Which stores and lanes a question's search lost, by code; never the detail text. */
function degradationsOf(detail: EvidencePackBuildDetail): Degradation[] {
  const lanes = detail.degradations.map(({ laneName, reason }) => {
    const split = laneName.indexOf(':');
    return split < 0 ? { corpusId: laneName, reason } : { corpusId: laneName.slice(0, split), lane: laneName.slice(split + 1), reason };
  });
  const timings = (detail.corpusTimings ?? []).filter(t => t.outcome !== 'success').map(t => ({ corpusId: t.corpusId, reason: t.outcome }));
  return [...lanes, ...timings];
}

/**
 * The keep verdict over the questions both runs scored. Open receipts are
 * rescored on that intersection; sealed ones carry no rows, so both runs must
 * have left out the same questions. `leftOut` counts the questions dropped.
 */
export function comparePassageReceipts(current: PassageReceipt, baseline: PassageReceipt): { kept: boolean; gained: number; shapeLosses: number; familyLosses: number; leftOut: number } {
  if (current.schema !== baseline.schema || current.rule !== baseline.rule || current.split !== baseline.split || current.setId !== baseline.setId || current.maxResults !== baseline.maxResults) throw new Error('Receipts must be compatible and use the same split, set and pack size.');
  const left = new Set([...current.degradedIds, ...baseline.degradedIds]);
  let now = current.summary; let before = baseline.summary;
  if (current.questions && baseline.questions) {
    const both = (rows: readonly PassageRow[]) => rows.filter(row => !left.has(row.questionId));
    now = summaries(both(current.questions), current.ks); before = summaries(both(baseline.questions), baseline.ks);
  } else if (left.size !== current.degradedIds.length || left.size !== baseline.degradedIds.length) {
    throw new Error(`The sealed runs left out different degraded questions (${left.size} in all); rerun before comparing.`);
  }
  const k = String(current.maxResults);
  const hits = (summary: PassageSummary | undefined) => summary?.passage.hitsAtK[k] ?? 0;
  const gained = hits(now.overall) - hits(before.overall);
  const worstLoss = (group: 'byShape' | 'byFamily') => Math.max(0, ...Object.entries(before[group]).map(([key, value]) => hits(value) - hits(now[group][key])));
  const shapeLosses = worstLoss('byShape'); const familyLosses = worstLoss('byFamily');
  return { kept: gained >= 2 && shapeLosses <= 1 && familyLosses <= 1, gained, shapeLosses, familyLosses, leftOut: left.size };
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error('Expected a positive integer option.');
  return number;
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { isolation, rest } = parseDataRootArgs(argv);
  if (!isolation) throw new Error('--data-root is required.');
  const values = new Map<string, string>(); let datasetPath: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.split('=', 2);
      if (!['--split', '--compare', '--output', '--max-results', '--max-chars-per-candidate', '--analyst-provider', '--prompt-bytes'].includes(key!)) throw new Error('Unsupported passage eval option.');
      const value = inline ?? rest[++index];
      if (!value || value.startsWith('--')) throw new Error('Passage eval option requires a value.');
      values.set(key!, value);
    } else { if (datasetPath) throw new Error('One dataset path is required.'); datasetPath = arg; }
  }
  const split = values.get('--split') ?? 'open';
  if (split !== 'open' && split !== 'sealed') throw new Error('Split must be open or sealed.');
  const provider = values.get('--analyst-provider') ?? process.env.OLYMPUS_EVAL_ANALYST_PROVIDER ?? 'local';
  if (provider !== 'local' && provider !== 'venice') throw new Error('Analyst provider must be local or venice.');
  const dataset: unknown = JSON.parse(readFileSync(datasetPath ?? 'eval/private/passage-questions.json', 'utf8'));
  validatePassageDataset(dataset);
  const maxResults = positiveInteger(values.get('--max-results') ?? process.env.OLYMPUS_EVAL_MAX_RESULTS, 5);
  const maxCharsPerCandidate = positiveInteger(values.get('--max-chars-per-candidate') ?? process.env.OLYMPUS_EVAL_MAX_CHARS_PER_CANDIDATE, DEFAULT_MAX_CHARS_PER_CANDIDATE);
  const opened = openEvalDataRoot(isolation);
  try {
    const embedding = await prepareEvalEmbedding({ configured: await configuredEvalEmbedding(loadConfig(), process.env) });
    const reranker = await prepareBuiltInRerankerFromEnv();
    const lanes = createEvalSourceLanes({ ...opened, embeddingFor: embedding.embeddingFor });
    const receipt = await runPassageEval({ dataset, split, maxResults, storeCounts: opened.storeCounts, skippedStores: opened.skipped,
      gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      ...(provider === 'local' ? { promptBytes: positiveInteger(values.get('--prompt-bytes') ?? process.env.OLYMPUS_SOURCE_INDEX_LOCAL_ANALYST_PROMPT_BYTES, DEFAULT_LOCAL_ANALYST_PROMPT_BYTES) } : {}),
      buildPack: q => buildEvalPack({ question: q.question, lanes, maxResults, maxCharsPerCandidate, ...(reranker ? { reranker } : {}) }),
    });
    opened.checkFileDescriptors();
    const output = values.get('--output') ?? 'eval/private/passages.latest.json';
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(receipt.summary));
    if (values.has('--compare')) console.log(JSON.stringify(comparePassageReceipts(receipt, JSON.parse(readFileSync(values.get('--compare')!, 'utf8')) as PassageReceipt)));
  } finally { try { opened.checkFileDescriptors(); } finally { opened.close(); } }
}
if (import.meta.main) main().catch(() => { console.error('Passage eval failed; no content is logged.'); process.exitCode = 1; });

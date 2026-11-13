#!/usr/bin/env bun
// Offline seating replay. Store rankings must be prefix-stable: a smaller
// --store-depth uses each captured store list's prefix, except for a chat
// store's newest-message pins, which are rebuilt as the adapter places them at
// that depth (laneAtDepth). No stores/models/text are read. Query expansions replay only the runs captured by the live build;
// changing a variant never invents a planner run the live build skipped.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seatRoutedLanes, type SourceIndexRoutedSearchHit } from '../src/core/source-index/router.ts';
import { seatRoutedQueryRuns } from '../src/core/evidence-pack.ts';
import type { CapturedItem, PoolCapture } from './capture-pool.ts';

export interface ReplayVariant {
  storeDepth: number;
  poolSize: number;
  keep: number;
  temporalIntent?: boolean;
}
export type ReplayItem = CapturedItem & { corpusId: string };
export interface ReplayResult {
  questionId: string;
  pool: ReplayItem[];
  pack: ReplayItem[];
  expected: {
    expectedIndex: number;
    documentPoolRank: number | null;
    documentPackSeat: number | null;
    paragraphPoolRank: number | null;
    paragraphPackSeat: number | null;
  }[];
}

/**
 * A captured store list as its adapter would return it at a smaller depth.
 * Store hits are prefix-stable, but a chat store pins its newest messages
 * inside every limit (withPinnedNewestChatHits in local-index.ts): a pin it
 * found among its hits keeps its place, the rest are appended after the
 * lowest unpinned hits are evicted to make room, one hit always kept. A plain prefix would drop pins a
 * real smaller-depth search still returns (Codex on #1617). Pins appended at
 * capture are the trailing run of pinned items; a pin's number says its order.
 */
export function laneAtDepth<T extends { newestInStore?: number }>(items: readonly T[], depth: number): T[] {
  if (depth >= items.length) return [...items];
  let tail = items.length;
  while (tail > 0 && items[tail - 1]!.newestInStore !== undefined) tail -= 1;
  const pins = items.filter(item => item.newestInStore !== undefined).sort((a, b) => a.newestInStore! - b.newestInStore!);
  if (pins.length === 0) return items.slice(0, depth);
  const hits = items.slice(0, tail).slice(0, depth);
  const pinCount = Math.min(pins.length, hits.length > 0 ? depth - 1 : depth);
  // A hit the adapter would not pin at this depth carries no pin number.
  const result = hits.map(item => item.newestInStore !== undefined && item.newestInStore > pinCount
    ? (({ newestInStore: _unpinned, ...rest }) => rest as T)(item) : item);
  for (const pin of pins.slice(0, pinCount)) {
    if (result.includes(pin)) continue;
    while (result.length >= depth) {
      let last = result.length - 1;
      while (last > 0 && result[last]!.newestInStore !== undefined) last -= 1;
      result.splice(last, 1);
    }
    result.push(pin);
  }
  return result;
}

export function replayPool(capture: PoolCapture, variant: ReplayVariant): ReplayResult {
  if (capture.version !== 1) throw new Error('Unsupported pool capture version.');
  for (const [name, value] of Object.entries(variant)) {
    if (name !== 'temporalIntent' && (!Number.isSafeInteger(value) || Number(value) < 1)) throw new Error(`${name} must be a positive integer.`);
  }
  if (variant.storeDepth > capture.storeDepth) throw new Error(`Requested depth ${variant.storeDepth} exceeds captured depth ${capture.storeDepth} for ${capture.questionId}.`);
  const temporalIntent = variant.temporalIntent ?? capture.temporalIntent;
  const metadata = new Map<SourceIndexRoutedSearchHit, ReplayItem>();
  const runs = capture.runs.map(run => seatRoutedLanes(run.lanes.map(lane => ({
    name: lane.corpusId,
    ...(lane.relevance ? { relevance: lane.relevance } : {}),
    items: laneAtDepth(lane.items, variant.storeDepth).map(item => {
      const sourceItem = { family: 'file' as const, provider: 'offline', accountScope: 'offline', providerItemId: item.providerItemId, localItemId: item.localItemId };
      const kinds: ('keyword_first' | 'name')[] = [];
      if (item.keywordFirst) kinds.push('keyword_first');
      if (item.nameLeader) kinds.push('name');
      const hit: SourceIndexRoutedSearchHit = {
        corpusId: lane.corpusId, trustDomain: lane.trustDomain, sourceItem, candidateId: item.candidateId, rawExposed: false,
        ...(item.adapterScore !== undefined ? { score: item.adapterScore } : {}),
        ...(kinds.length ? { keywordLeader: { kinds, conceptShare: item.conceptShare ?? 0 } } : {}),
        ...(item.newestInStore !== undefined ? { newestInStore: item.newestInStore, provenance: { sourceItem, citation: { authoredAt: new Date(item.authoredAtMs ?? 0).toISOString() } } } : {}),
      };
      metadata.set(hit, { ...item, corpusId: lane.corpusId });
      return hit;
    }),
  })), {
    maxResults: variant.poolSize,
    ...(capture.strengthAllocation ? { poolAllocation: { storeDepth: variant.storeDepth } } : {}),
    temporalIntent,
  }).hits);
  const seated = runs.length === 1 ? runs[0]! : seatRoutedQueryRuns(runs, variant.poolSize, temporalIntent).hits;
  const pool = seated.map(hit => metadata.get(hit)!).filter(item => item.packEligible);
  // Only valid, applied scores reorder a pool. Failed/timed-out scoring keeps
  // the exact seating order. Ties and unscored items retain that order too.
  const ordered = capture.rerankOutcome === 'applied' ? pool.map((item, index) => ({ item, index })).sort((left, right) => {
    const a = left.item.rerankerScore;
    const b = right.item.rerankerScore;
    if (a !== undefined && b !== undefined && a !== b) return Number(b) - Number(a);
    if (a === undefined && b !== undefined) return 1;
    if (a !== undefined && b === undefined) return -1;
    return left.index - right.index;
  }).map(entry => entry.item) : pool;
  const pack = ordered.slice(0, variant.keep);
  const rank = (items: readonly ReplayItem[], expectedIndex: number, paragraph: boolean): number | null => {
    const index = items.findIndex(item => item.matches.some(m => m.expectedIndex === expectedIndex && (paragraph ? m.holdsQuote : m.expected)));
    return index < 0 ? null : index + 1;
  };
  return {
    questionId: capture.questionId, pool, pack,
    expected: capture.expected.map((_, expectedIndex) => ({ expectedIndex,
      documentPoolRank: rank(pool, expectedIndex, false), documentPackSeat: rank(pack, expectedIndex, false),
      paragraphPoolRank: rank(pool, expectedIndex, true), paragraphPackSeat: rank(pack, expectedIndex, true),
    })),
  };
}

/** Two-sided exact sign-flip test on discordant binary pairs (ties omitted).
 * This is 2 * the binomial lower tail. Starting at the tail's largest term
 * avoids factorial overflow and 2^-N underflow for balanced large samples.
 */
export function signFlipPValue(wins: number, losses: number): number {
  if (![wins, losses].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('wins and losses must be non-negative integers.');
  const n = wins + losses;
  const k = Math.min(wins, losses);
  if (!n || wins === losses) return 1;
  let logChoose = 0;
  for (let i = 1; i <= k; i++) logChoose += Math.log(n - k + i) - Math.log(i);
  let term = Math.exp(logChoose - n * Math.LN2);
  let tail = term;
  for (let i = k; i > 0; i--) { term *= i / (n - i + 1); tail += term; }
  return Math.min(1, 2 * tail);
}

type Metric = 'documents' | 'paragraphs' | 'documentsInPool' | 'paragraphsInPool';
const metrics: readonly Metric[] = ['documents', 'paragraphs', 'documentsInPool', 'paragraphsInPool'];
const field = { documents: 'documentPackSeat', paragraphs: 'paragraphPackSeat', documentsInPool: 'documentPoolRank', paragraphsInPool: 'paragraphPoolRank' } as const;
export function summarizeVariants(captures: readonly PoolCapture[], variants: readonly ReplayVariant[]) {
  const baseline = captures.map(c => replayPool(c, variants[0]!));
  return variants.map(variant => {
    const questions = captures.map(capture => replayPool(capture, variant));
    const totals = Object.fromEntries(metrics.map(metric => [metric, { found: 0, of: 0 }])) as Record<Metric, { found: number; of: number }>;
    const paired = Object.fromEntries(metrics.map(metric => [metric, { wins: 0, losses: 0, pValue: 1 }])) as Record<Metric, { wins: number; losses: number; pValue: number }>;
    for (const [q, result] of questions.entries()) for (const [e, expectation] of result.expected.entries()) for (const metric of metrics) {
      if (metric.startsWith('paragraph') && !captures[q]!.expected[e]!.quoteRequired) continue;
      const found = expectation[field[metric]] !== null;
      const before = baseline[q]!.expected[e]![field[metric]] !== null;
      totals[metric].of++;
      if (found) totals[metric].found++;
      if (found && !before) paired[metric].wins++;
      if (!found && before) paired[metric].losses++;
    }
    for (const metric of metrics) paired[metric].pValue = signFlipPValue(paired[metric].wins, paired[metric].losses);
    return { variant, questions, totals, paired };
  });
}

export function parseReplayArgs(argv: readonly string[]) {
  let directory: string | undefined;
  let storeDepths: number[] | undefined;
  let poolSizes: number[] | undefined;
  let keep: number | undefined;
  let temporalIntent: boolean | undefined;
  let json = false;
  const list = (value: string) => {
    const values = value.split(',').map(Number);
    if (!values.length || values.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('Replay sizes must be positive comma-separated integers.');
    return [...new Set(values)];
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--json') { json = true; continue; }
    if (!arg.startsWith('--')) {
      if (directory) throw new Error('Specify one capture directory.');
      directory = arg; continue;
    }
    const name = arg.split('=')[0]!;
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--store-depth') storeDepths = list(value);
    else if (name === '--pool-size') poolSizes = list(value);
    else if (name === '--keep') { const values = list(value); if (values.length !== 1) throw new Error('--keep requires one integer.'); keep = values[0]!; }
    else if (name === '--temporal') {
      if (value === 'as-captured') temporalIntent = undefined;
      else if (value === 'true' || value === 'on') temporalIntent = true;
      else if (value === 'false' || value === 'off') temporalIntent = false;
      else throw new Error('--temporal requires as-captured, on or off.');
    } else throw new Error(`Unknown replay option ${name}.`);
  }
  if (!directory) throw new Error('Usage: bun eval/replay-pool.ts <capture-dir> [--store-depth 5,10,30] [--pool-size 30,100,400] [--keep 5] [--temporal as-captured] [--json]');
  return { directory, storeDepths, poolSizes, keep, temporalIntent, json };
}

function main() {
  const args = parseReplayArgs(process.argv.slice(2));
  const captures = readdirSync(args.directory).filter(name => name.endsWith('.json')).sort().map(name => JSON.parse(readFileSync(join(args.directory, name), 'utf8')) as PoolCapture);
  if (!captures.length) throw new Error('No pool captures found.');
  // Per-capture defaults preserve each question's own temporal/rerank budget.
  const depths = args.storeDepths ?? [Math.min(...captures.map(c => c.storeDepth))];
  const pools = args.poolSizes ?? [captures[0]!.poolSize];
  const keep = args.keep ?? captures[0]!.maxResults;
  if (args.keep === undefined && captures.some(c => c.maxResults !== keep)) throw new Error('Captures have different pack sizes; specify --keep.');
  if (args.poolSizes === undefined && captures.some(c => c.poolSize !== pools[0])) throw new Error('Captures have different pool sizes; specify --pool-size.');
  const variants = depths.flatMap(storeDepth => pools.map(poolSize => ({ storeDepth, poolSize, keep, ...(args.temporalIntent !== undefined ? { temporalIntent: args.temporalIntent } : {}) })));
  const report = summarizeVariants(captures, variants);
  if (args.json) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log('Pool rank = seating order before reranking; pack seat = score order. Paired tests count discordant expected entries against the first variant.');
  for (const result of report) {
    console.log(`\nDepth ${result.variant.storeDepth}, pool ${result.variant.poolSize}, keep ${result.variant.keep}, temporal ${args.temporalIntent ?? 'as-captured'}`);
    console.table(result.questions.flatMap(q => q.expected.map(e => ({ question: q.questionId, expected: e.expectedIndex + 1,
      documentPoolRank: e.documentPoolRank ?? '-', documentPackSeat: e.documentPackSeat ?? '-', paragraphPoolRank: e.paragraphPoolRank ?? '-', paragraphPackSeat: e.paragraphPackSeat ?? '-',
    }))));
    console.table(metrics.map(metric => ({ metric, found: `${result.totals[metric].found} of ${result.totals[metric].of}`, ...result.paired[metric] })));
  }
  const truncated = captures.filter(c => c.scoringTruncated).length;
  if (truncated) console.error(`${truncated} captures exceeded the scoring cap; unscored candidates follow scored candidates in seating order.`);
}
if (import.meta.main) main();

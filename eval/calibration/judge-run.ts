// Run the private judge over a labeled sample on a llama.cpp server, and score
// it against the owner's labels. The prompt, the screens and the answer parser
// are production's own, imported from sniffer.ts, so they cannot drift.
//
//   bun eval/calibration/judge-run.ts --endpoint http://127.0.0.1:8012 --dir DIR
//     --model NAME (--owner-words FILE | --no-owner-words)
//     [--mode decision|full] [--split dev|test] [--limit N] [--passes 3] [--exclude ID,ID]
//     [--primed-check N] [--slot 0] [--n-probs 40] [--thinking]
//
//   VENICE_API_KEY=... bun eval/calibration/judge-run.ts --venice MODEL_ID --allow-venice
//     --dir DIR (--owner-words FILE | --no-owner-words) [--concurrency 8] [--max-rpm 140] [--passes 3] [--exclude ID,ID]
//
// --venice sends each item to Venice through production's own Venice judge
// adapter (createVeniceAnalystModel, configured as the tier sniffer builds it),
// so the request, the privacy-category check and the parser are production's.
// It runs full mode only and needs --allow-venice as well: item text then goes
// to api.venice.ai, so only run it on items the owner has said may go there.
// Without both flags the loopback guard below holds.
//
// decision (the default): the reply is pre-filled up to the tier and the model
// writes one token. P(Private) is its mass on "private" over "private" plus
// "personal", and the verdict is Private at 0.5 or above, a bar fixed in advance.
// full: production's whole JSON answer under its schema, read by its parser.
// An item with no usable answer is Private, production's fail-safe.
//
// Every pass primes the server's cache with the shared prompt first (one
// n_predict=0 request). A warm-up pass gives the verdicts; the timed passes
// after it give the speed and show whether any verdict moved.
//
// Item text goes to the endpoint and nowhere else, and only a loopback endpoint
// is accepted: reach another machine through an SSH tunnel. Output and the saved
// result carry item ids, counts and metrics, never text.

import { decisionPromptShape, decisionDivergence, REPLY_TO_TIER } from '../../src/workers/classification/sniffer-decision.ts';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSnifferBatchPrompt,
  parseSnifferBatchResponse,
  SNIFFER_RESPONSE_SCHEMA,
  SNIFFER_SYSTEM_PROMPT,
  snifferInjectionRule,
  snifferMaterialCarriesSecret,
  snifferMaterialForModel,
  snifferOwnMaterial,
  snifferPromptVersions,
  snifferTierKey,
} from '../../src/workers/classification/sniffer.ts';
import { createVeniceAnalystModel } from '../../src/core/analyst-venice.ts';
import { JUDGE_SAMPLING } from '../../src/workers/classification/judge-pacing.ts';
import { privacyOwnerContext } from '../../src/workers/classification/privacy-profile.ts';
import type { AnalystModel } from '../../src/core/analyst.ts';
import { CALIBRATION_DIR_DEFAULT, SAMPLE_FILE, scoredTier, readImportance, readLabels, readSample, type CalibrationSampleItem } from './files.ts';
import { judgeInput } from './judge-input.ts';
import {
  confusion,
  groupedConfusion,
  medianAndRange,
  privateByImportance,
  privateChance,
  reweighted,
  tierMass,
  type ScoredRow,
  type StratumSizes,
  type Tier,
  type TokenChance,
} from './judge-metrics.ts';

const PRIVATE_BAR = 0.5;
const FULL_ANSWER_TOKENS = 256;

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const numberFlag = (name: string, fallback: number) => Number(flag(name) ?? fallback);

const endpoint = (flag('--endpoint') ?? '').replace(/\/+$/, '');
const dir = flag('--dir') ?? CALIBRATION_DIR_DEFAULT;
const mode = flag('--mode') ?? 'decision';
const modelName = flag('--model');
const slot = numberFlag('--slot', 0);
const nProbs = numberFlag('--n-probs', 40);
const passes = numberFlag('--passes', 3);
const primedCheck = numberFlag('--primed-check', 0);
const veniceModel = flag('--venice');
/** Venice runs on a cluster, so the test may go past the sniffer's local cap of 8 to find the key's real limit. */
const VENICE_MAX_CONCURRENCY = 64;
const concurrency = Math.max(1, Math.min(VENICE_MAX_CONCURRENCY, Math.floor(numberFlag('--concurrency', 1))));

/** What Venice reported for the calls of one pass: usage, latency and the key's limits. */
interface VeniceMeter {
  statuses: Record<string, number>;
  calls: number;
  failedCalls: number;
  latencyMs: number[];
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  rateLimits: Record<string, string>;
}

const maxRpm = numberFlag('--max-rpm', 0);
let nextSlot = 0;
/** Spaces call starts so a run stays under the key's request limit. */
async function paced(): Promise<void> {
  if (maxRpm <= 0) return;
  const now = performance.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + 60_000 / maxRpm;
  if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
}

function newMeter(): VeniceMeter {
  return { statuses: {}, calls: 0, failedCalls: 0, latencyMs: [], promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, rateLimits: {} };
}

let meter = newMeter();

/** Production's Venice judge, as the tier sniffer builds it, with a fetch that reads usage. */
function veniceJudge(model: string): AnalystModel {
  const apiKey = process.env.VENICE_API_KEY?.trim();
  if (!apiKey) throw new Error('Set VENICE_API_KEY for --venice. It is read from the environment only and never printed.');
  return createVeniceAnalystModel({
    apiKey,
    model,
    thinking: 'disabled',
    reasoningEffort: 'low',
    reasoningHeadroomTokens: 0,
    timeoutMs: 60_000,
    sampling: JUDGE_SAMPLING,
    async fetchImpl(url, init) {
      if (!url.includes('/chat/completions')) return await fetch(url, init);
      meter.calls += 1;
      const started = performance.now();
      let response: Response;
      let body: string;
      try {
        response = await fetch(url, init);
        // Latency runs to the end of the body, as the judge experiences it.
        body = await response.clone().text();
      } catch (error) {
        meter.failedCalls += 1;
        meter.latencyMs.push(performance.now() - started);
        throw error;
      }
      meter.latencyMs.push(performance.now() - started);
      if (!response.ok) meter.failedCalls += 1;
      meter.statuses[response.status] = (meter.statuses[response.status] ?? 0) + 1;
      response.headers.forEach((value, name) => {
        if (name.startsWith('x-ratelimit-') || name === 'retry-after') meter.rateLimits[name] = value;
      });
      try {
        // Counts only: the body's text is never kept or printed.
        const usage = (JSON.parse(body) as { usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          completion_tokens_details?: { reasoning_tokens?: number };
        } }).usage;
        meter.promptTokens += usage?.prompt_tokens ?? 0;
        meter.completionTokens += usage?.completion_tokens ?? 0;
        meter.cachedTokens += usage?.prompt_tokens_details?.cached_tokens ?? 0;
        meter.reasoningTokens += usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      } catch {
        // No usage on this reply.
      }
      return response;
    },
  });
}

async function askVenice(model: AnalystModel, material: string, ownerContext: string | undefined): Promise<Answer> {
  // Wait for a pacing slot before complete() starts its timeout, so queueing never eats it.
  await paced();
  let text: string;
  try {
    text = (await model.complete({
      system: SNIFFER_SYSTEM_PROMPT,
      prompt: buildSnifferBatchPrompt('content', [{ i: 1, material }], ownerContext),
      localOnly: true,
      responseSchema: SNIFFER_RESPONSE_SCHEMA,
      maxOutputChars: 110 + 200,
    })).text;
  } catch (error) {
    // A policy refusal (the model is not Venice Private) stops the run; any
    // other failure is production's fail-safe for this item.
    if (error instanceof Error && error.name === 'VeniceModelPolicyDeniedError') throw error;
    return { judge: 'private', via: 'no_answer' };
  }
  const verdict = parseSnifferBatchResponse(text, new Set([1])).get(1);
  if (!verdict) return { judge: 'private', via: 'no_answer' };
  return { judge: snifferTierKey(verdict) === 'secure' ? 'private' : 'personal', via: 'judge', privateKind: verdict.privateKind };
}

async function runVenicePass(asked: readonly Asked[], model: AnalystModel, ownerContext: string | undefined) {
  meter = newMeter();
  const answers = new Map<string, Answer>();
  const queue = asked.filter((entry) => {
    if (entry.settled) answers.set(entry.item.id, entry.settled);
    return !entry.settled;
  });
  const started = performance.now();
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < queue.length) {
      const entry = queue[next++]!;
      answers.set(entry.item.id, await askVenice(model, entry.material!, ownerContext));
    }
  }));
  const minutes = (performance.now() - started) / 60_000;
  return { answers, itemsPerMinute: minutes > 0 ? queue.length / minutes : 0, meter };
}

function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function meterSummary(pass: VeniceMeter, items: number) {
  const per = (value: number) => (items > 0 ? value / items : 0);
  return {
    calls: pass.calls,
    failedCalls: pass.failedCalls,
    statuses: pass.statuses,
    latencyMs: { median: percentile(pass.latencyMs, 0.5), p95: percentile(pass.latencyMs, 0.95) },
    tokensPerItem: {
      prompt: per(pass.promptTokens),
      cached: per(pass.cachedTokens),
      completion: per(pass.completionTokens),
      reasoning: per(pass.reasoningTokens),
    },
    rateLimits: pass.rateLimits,
  };
}

function assertLoopback(url: string): void {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('--endpoint must be a URL, such as http://127.0.0.1:8012.');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error('--endpoint must be loopback: item text may reach no other host. Use an SSH tunnel to reach another machine.');
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Never the response body: a server error can echo the prompt.
  if (!response.ok) throw new Error(`${path} answered ${response.status}.`);
  return await response.json() as T;
}

/** The chat-formatted prompt around one item: before it, after it, and the part every item shares. */
async function promptShape(ownerContext: string | undefined) {
  const format = async (material: string) => (await post<{ prompt: string }>('/apply-template', {
    messages: [
      { role: 'system', content: SNIFFER_SYSTEM_PROMPT },
      { role: 'user', content: buildSnifferBatchPrompt('content', [{ i: 1, material }], ownerContext) },
    ],
    ...(argv.includes('--thinking') ? {} : { chat_template_kwargs: { enable_thinking: false } }),
  })).prompt;
  return decisionPromptShape(format);
}

async function divergence(): Promise<string> {
  return decisionDivergence(post);
}

type Via = 'judge' | 'no_answer' | 'secret' | 'injection' | 'detector' | 'not_asked';

interface Asked {
  item: CalibrationSampleItem;
  /** Set when a screen settles the item, as in production, and no model reads it. */
  settled?: { judge: Tier; via: Via };
  material?: string;
}

/** The item's judge input, through production's screens. */
function ask(item: CalibrationSampleItem): Asked {
  let material = item.judgeSees;
  if (material === undefined) {
    const input = judgeInput(item.signals ?? { title: item.name, path: `/${item.rel}` }, item.text, item.source ?? 'dropbox');
    if (input.secret) return { item, settled: { judge: 'private', via: 'secret' } };
    if (input.material === undefined) {
      return { item, settled: input.privateWithoutJudge ? { judge: 'private', via: 'detector' } : { judge: 'personal', via: 'not_asked' } };
    }
    material = input.material;
  }
  const forModel = snifferMaterialForModel(material);
  const own = snifferOwnMaterial(forModel);
  if (snifferMaterialCarriesSecret(own)) return { item, settled: { judge: 'private', via: 'secret' } };
  if (snifferInjectionRule(own)) return { item, settled: { judge: 'private', via: 'injection' } };
  return { item, material: forModel };
}

interface Answer {
  judge: Tier;
  via: Via;
  pPrivate?: number;
  /** Mass the two words took between them. */
  coverage?: number;
  /** full mode: the kind of private information the model named. */
  privateKind?: string;
}

interface CompletionReply {
  content?: string;
  completion_probabilities?: Array<{ top_logprobs?: TokenChance[] }>;
}

async function askModel(prompt: string, written: string, primed: boolean): Promise<Answer> {
  const common = { temperature: 0, cache_prompt: primed, id_slot: slot };
  if (mode === 'decision') {
    const reply = await post<CompletionReply>('/completion', {
      ...common,
      prompt: `${prompt}${REPLY_TO_TIER}${written}`,
      n_predict: 1,
      n_probs: nProbs,
    });
    const mass = tierMass(reply.completion_probabilities?.[0]?.top_logprobs ?? [], written);
    const chance = privateChance(mass);
    if (chance === undefined) return { judge: 'private', via: 'no_answer', coverage: 0 };
    return { judge: chance >= PRIVATE_BAR ? 'private' : 'personal', via: 'judge', pPrivate: chance, coverage: mass.private + mass.personal };
  }
  const reply = await post<CompletionReply>('/completion', {
    ...common,
    prompt,
    n_predict: FULL_ANSWER_TOKENS,
    json_schema: SNIFFER_RESPONSE_SCHEMA,
  });
  const verdict = parseSnifferBatchResponse(reply.content ?? '', new Set([1])).get(1);
  if (!verdict) return { judge: 'private', via: 'no_answer' };
  return { judge: snifferTierKey(verdict) === 'secure' ? 'private' : 'personal', via: 'judge', privateKind: verdict.privateKind };
}

async function prime(shared: string): Promise<void> {
  await post('/completion', { prompt: shared, n_predict: 0, cache_prompt: true, id_slot: slot });
}

async function runPass(asked: readonly Asked[], shape: Awaited<ReturnType<typeof promptShape>>, written: string, primed: boolean) {
  if (primed) await prime(shape.shared);
  const answers = new Map<string, Answer>();
  const started = performance.now();
  let modelItems = 0;
  for (const entry of asked) {
    if (entry.settled) {
      answers.set(entry.item.id, entry.settled);
      continue;
    }
    answers.set(entry.item.id, await askModel(shape.render(entry.material!), written, primed));
    modelItems += 1;
  }
  const minutes = (performance.now() - started) / 60_000;
  return { answers, itemsPerMinute: minutes > 0 ? modelItems / minutes : 0 };
}

/** A whole-item sample fixes each item's half by its related group; older samples split by a hash of the id. */
function splitOf(item: Pick<CalibrationSampleItem, 'id' | 'split'>): 'dev' | 'test' {
  return item.split ?? (createHash('sha256').update(item.id).digest()[0]! % 2 === 0 ? 'dev' : 'test');
}

/** The SHA-256 of the sample file, so a scorer can refuse a result run on another sample. */
function sampleSha256(): string {
  return createHash('sha256').update(readFileSync(join(dir, SAMPLE_FILE))).digest('hex');
}

function stratumSizes(recipe: unknown): StratumSizes | undefined {
  const sources = (recipe as { sources?: Record<string, { population?: Record<string, number> }> } | undefined)?.sources;
  if (!sources) return undefined;
  return Object.fromEntries(Object.entries(sources).flatMap(([name, source]) => (source.population ? [[name, source.population]] : [])));
}

function count<T extends string>(values: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

async function main(): Promise<void> {
  if (veniceModel !== undefined || argv.includes('--allow-venice')) return await mainVenice();
  assertLoopback(endpoint);
  if (mode !== 'decision' && mode !== 'full') throw new Error('--mode is decision or full.');
  if (!modelName) throw new Error('--model NAME is required, so a result always says what produced it.');
  const wordsFile = flag('--owner-words');
  if (!wordsFile && !argv.includes('--no-owner-words')) throw new Error('Pass --owner-words FILE, or --no-owner-words to run without them.');
  const ownerContext = ownerWordsFrom(wordsFile);
  const split = flag('--split');
  if (split !== undefined && split !== 'dev' && split !== 'test') throw new Error('--split is dev or test.');

  const sample = readSample(dir);
  const labels = readLabels(dir).labels;
  const excluded = new Set((flag('--exclude') ?? '').split(',').filter(Boolean));
  const labeled = sample.items
    .filter((item) => !excluded.has(item.id))
    .filter((item) => scoredTier(labels[item.id]?.label) !== undefined)
    .filter((item) => split === undefined || splitOf(item) === split)
    .slice(0, numberFlag('--limit', Number.MAX_SAFE_INTEGER));
  if (labeled.length === 0) throw new Error('No Personal or Private labels to score.');
  const asked = labeled.map(ask);
  // Not sure items never touch the score: the share called Private is its own line.
  const unsure = sample.items
    .filter((item) => !excluded.has(item.id) && labels[item.id]?.label === 'unsure')
    .map(ask);

  const shape = await promptShape(ownerContext);
  const written = mode === 'decision' ? await divergence() : '';

  let primedResult: unknown;
  if (primedCheck > 0) {
    const subset = asked.filter((entry) => !entry.settled).slice(0, primedCheck);
    const primed = await runPass(subset, shape, written, true);
    const cold = await runPass(subset, shape, written, false);
    const differ = subset.filter((entry) => primed.answers.get(entry.item.id)?.judge !== cold.answers.get(entry.item.id)?.judge);
    const drift = subset.map((entry) => Math.abs((primed.answers.get(entry.item.id)?.pPrivate ?? 0) - (cold.answers.get(entry.item.id)?.pPrivate ?? 0)));
    primedResult = {
      items: subset.length,
      answersDiffer: differ.length,
      differingIds: differ.map((entry) => entry.item.id),
      largestChanceChange: Math.max(0, ...drift),
      primedItemsPerMinute: primed.itemsPerMinute,
      unprimedItemsPerMinute: cold.itemsPerMinute,
    };
  }

  const warm = await runPass(asked, shape, written, true);
  const timed: Array<Awaited<ReturnType<typeof runPass>>> = [];
  for (let pass = 0; pass < passes; pass += 1) timed.push(await runPass(asked, shape, written, true));
  const unsureAnswers = unsure.length > 0 ? [...(await runPass(unsure, shape, written, true)).answers.values()] : [];
  const moved = asked.filter((entry) => timed.some((pass) => pass.answers.get(entry.item.id)?.judge !== warm.answers.get(entry.item.id)?.judge));

  const rows: ScoredRow[] = labeled.map((item) => ({
    id: item.id,
    owner: scoredTier(labels[item.id]!.label)!,
    judge: warm.answers.get(item.id)!.judge,
    source: item.source ?? 'files',
    split: splitOf(item),
    ...(item.stratum ? { stratum: item.stratum } : {}),
  }));
  const answers = [...warm.answers.values()];
  const coverage = answers.flatMap((answer) => (answer.coverage === undefined ? [] : [answer.coverage]));
  const sizes = stratumSizes(sample.recipe);
  const weighted = sizes ? reweighted(rows, sizes) : undefined;
  const speed = timed.length > 0 ? medianAndRange(timed.map((pass) => pass.itemsPerMinute)) : undefined;

  const importance = readImportance(dir).labels;
  const result = {
    sampleSha256: sampleSha256(),
    // First, because a missed Important item is the mistake that matters most.
    privateMissed: Object.keys(importance).length > 0 ? privateByImportance(rows, importance) : undefined,
    at: new Date().toISOString(),
    mode,
    model: modelName,
    prompt: snifferPromptVersions(ownerContext).cache,
    ownerWords: ownerContext ? 'supplied' : 'none',
    primed: true,
    privateBar: mode === 'decision' ? PRIVATE_BAR : undefined,
    items: rows.length,
    excluded: excluded.size,
    answeredBy: count(answers.map((answer) => answer.via)),
    verdictsMovedAcrossPasses: moved.length,
    wordMass: coverage.length > 0 ? medianAndRange(coverage) : undefined,
    speedItemsPerMinute: speed,
    primedCheck: primedResult,
    notSure: { items: unsureAnswers.length, calledPrivate: unsureAnswers.filter((answer) => answer.judge === 'private').length },
    unweighted: {
      all: confusion(rows),
      bySource: groupedConfusion(rows, (row) => row.source),
      bySplit: groupedConfusion(rows, (row) => row.split),
      byStratum: sizes ? groupedConfusion(rows, (row) => `${row.source}/${row.stratum}`) : undefined,
    },
    reweighted: weighted
      ? { all: confusion(weighted), bySource: groupedConfusion(weighted, (row) => row.source) }
      : undefined,
  };
  const path = join(dir, `judge-${mode}-${result.at.replace(/[:.]/g, '-')}.json`);
  const perItem = rows.map((row) => ({ ...row, ...warm.answers.get(row.id) }));
  writeFileSync(path, JSON.stringify({ ...result, rows: perItem }, null, 1), { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(JSON.stringify(result, null, 1));
  console.log(`Full result: ${path}`);
}

/** The labeled items to score, as the flags select them. */
function selectLabeled() {
  const split = flag('--split');
  if (split !== undefined && split !== 'dev' && split !== 'test') throw new Error('--split is dev or test.');
  const sample = readSample(dir);
  const labels = readLabels(dir).labels;
  const excluded = new Set((flag('--exclude') ?? '').split(',').filter(Boolean));
  const labeled = sample.items
    .filter((item) => !excluded.has(item.id))
    .filter((item) => scoredTier(labels[item.id]?.label) !== undefined)
    .filter((item) => split === undefined || splitOf(item) === split)
    .slice(0, numberFlag('--limit', Number.MAX_SAFE_INTEGER));
  if (labeled.length === 0) throw new Error('No Personal or Private labels to score.');
  return { sample, labels, labeled, excluded: excluded.size };
}

/** `--owner-words saved` reads this machine's saved privacy words, as the live engine (and score.ts) does. */
function ownerWordsFrom(wordsFile: string | undefined): string | undefined {
  if (!wordsFile) return undefined;
  if (wordsFile === 'saved') return privacyOwnerContext();
  return readFileSync(wordsFile, 'utf8').trim() || undefined;
}

function readOwnerContext(): string | undefined {
  const wordsFile = flag('--owner-words');
  if (!wordsFile && !argv.includes('--no-owner-words')) throw new Error('Pass --owner-words FILE, or --no-owner-words to run without them.');
  return ownerWordsFrom(wordsFile);
}

async function mainVenice(): Promise<void> {
  if (!veniceModel || !argv.includes('--allow-venice')) {
    throw new Error('Venice needs both --venice MODEL_ID and --allow-venice: item text goes to api.venice.ai.');
  }
  if (flag('--endpoint') !== undefined) throw new Error('--endpoint does not apply to --venice.');
  if (flag('--mode') !== undefined && flag('--mode') !== 'full') throw new Error('--venice runs full mode only.');
  const ownerContext = readOwnerContext();
  const { sample, labels, labeled, excluded } = selectLabeled();
  const asked = labeled.map(ask);
  const judge = veniceJudge(veniceModel);

  const warm = await runVenicePass(asked, judge, ownerContext);
  const timed: Array<Awaited<ReturnType<typeof runVenicePass>>> = [];
  for (let pass = 0; pass < passes; pass += 1) timed.push(await runVenicePass(asked, judge, ownerContext));
  const moved = asked.filter((entry) => timed.some((pass) => pass.answers.get(entry.item.id)?.judge !== warm.answers.get(entry.item.id)?.judge));
  const modelItems = asked.filter((entry) => !entry.settled).length;

  const rows: ScoredRow[] = labeled.map((item) => ({
    id: item.id,
    owner: scoredTier(labels[item.id]!.label)!,
    judge: warm.answers.get(item.id)!.judge,
    source: item.source ?? 'files',
    split: splitOf(item),
    ...(item.stratum ? { stratum: item.stratum } : {}),
  }));
  const sizes = stratumSizes(sample.recipe);
  const weighted = sizes ? reweighted(rows, sizes) : undefined;
  const importance = readImportance(dir).labels;
  const result = {
    sampleSha256: sampleSha256(),
    // First, because a missed Important item is the mistake that matters most.
    privateMissed: Object.keys(importance).length > 0 ? privateByImportance(rows, importance) : undefined,
    at: new Date().toISOString(),
    mode: 'full',
    backend: 'venice',
    model: veniceModel,
    concurrency,
    prompt: snifferPromptVersions(ownerContext).cache,
    ownerWords: ownerContext ? 'supplied' : 'none',
    items: rows.length,
    excluded,
    answeredBy: count([...warm.answers.values()].map((answer) => answer.via)),
    verdictsMovedAcrossPasses: moved.length,
    speedItemsPerMinute: timed.length > 0 ? medianAndRange(timed.map((pass) => pass.itemsPerMinute)) : undefined,
    venice: {
      warm: meterSummary(warm.meter, modelItems),
      timed: timed.map((pass) => meterSummary(pass.meter, modelItems)),
    },
    unweighted: {
      all: confusion(rows),
      bySource: groupedConfusion(rows, (row) => row.source),
      bySplit: groupedConfusion(rows, (row) => row.split),
      byStratum: sizes ? groupedConfusion(rows, (row) => `${row.source}/${row.stratum}`) : undefined,
    },
    reweighted: weighted
      ? { all: confusion(weighted), bySource: groupedConfusion(weighted, (row) => row.source) }
      : undefined,
  };
  const path = join(dir, `judge-venice-${veniceModel.replace(/[^a-z0-9.-]/gi, '_')}-${result.at.replace(/[:.]/g, '-')}.json`);
  const perItem = rows.map((row) => ({ ...row, ...warm.answers.get(row.id) }));
  writeFileSync(path, JSON.stringify({ ...result, rows: perItem }, null, 1), { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(JSON.stringify(result, null, 1));
  console.log(`Full result: ${path}`);
}

await main();

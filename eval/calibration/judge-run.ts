// Run the private judge over a labeled sample on a llama.cpp server, and score
// it against the owner's labels. The prompt, the screens and the answer parser
// are production's own, imported from sniffer.ts, so they cannot drift.
//
//   bun eval/calibration/judge-run.ts --endpoint http://127.0.0.1:8012 --dir DIR
//     --model NAME (--owner-words FILE | --no-owner-words)
//     [--mode decision|full] [--split dev|test] [--limit N] [--passes 3]
//     [--primed-check N] [--slot 0] [--n-probs 40] [--thinking]
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
import { CALIBRATION_DIR_DEFAULT, readLabels, readSample, type CalibrationSampleItem } from './files.ts';
import { judgeInput } from './judge-input.ts';
import {
  confusion,
  groupedConfusion,
  medianAndRange,
  privateChance,
  reweighted,
  tierMass,
  type ScoredRow,
  type StratumSizes,
  type Tier,
  type TokenChance,
} from './judge-metrics.ts';

const PRIVATE_BAR = 0.5;
const REPLY_TO_TIER = '{"verdicts":[{"i":1,"tier":"';
/** Stands in for an item while the shared prompt is worked out. */
const PLACEHOLDER = 'CALIBRATION_ITEM_PLACEHOLDER';
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
  const formatted = await format(PLACEHOLDER);
  const at = formatted.indexOf(PLACEHOLDER);
  if (at < 0) throw new Error('The chat template changed the item.');
  const before = formatted.slice(0, at);
  const after = formatted.slice(at + PLACEHOLDER.length);
  const render = (material: string) => `${before}${JSON.stringify(material).slice(1, -1)}${after}`;
  const probe = 'Names: a "quoted" name\nExcerpt: a line\twith é and \\ in it';
  if (render(probe) !== await format(probe)) throw new Error('Filling the prompt shape does not match the chat template.');
  return { shared: before, render };
}

/** What the reply must add before the two words part, if they share a first token. */
async function divergence(): Promise<string> {
  const first = async (word: string) => {
    const { tokens } = await post<{ tokens: Array<{ piece: string | number[] }> }>('/tokenize', { content: word, with_pieces: true });
    const piece = tokens[0]?.piece;
    if (typeof piece !== 'string') throw new Error(`The tokenizer gave no text piece for "${word}".`);
    return piece;
  };
  const [personal, privateWord] = [await first('personal'), await first('private')];
  return personal === privateWord ? personal : '';
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
  return { judge: snifferTierKey(verdict) === 'secure' ? 'private' : 'personal', via: 'judge' };
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

function splitOf(id: string): 'dev' | 'test' {
  return createHash('sha256').update(id).digest()[0]! % 2 === 0 ? 'dev' : 'test';
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
  assertLoopback(endpoint);
  if (mode !== 'decision' && mode !== 'full') throw new Error('--mode is decision or full.');
  if (!modelName) throw new Error('--model NAME is required, so a result always says what produced it.');
  const wordsFile = flag('--owner-words');
  if (!wordsFile && !argv.includes('--no-owner-words')) throw new Error('Pass --owner-words FILE, or --no-owner-words to run without them.');
  const ownerContext = wordsFile ? readFileSync(wordsFile, 'utf8').trim() || undefined : undefined;
  const split = flag('--split');
  if (split !== undefined && split !== 'dev' && split !== 'test') throw new Error('--split is dev or test.');

  const sample = readSample(dir);
  const labels = readLabels(dir).labels;
  const labeled = sample.items
    .filter((item) => labels[item.id]?.label === 'personal' || labels[item.id]?.label === 'private')
    .filter((item) => split === undefined || splitOf(item.id) === split)
    .slice(0, numberFlag('--limit', Number.MAX_SAFE_INTEGER));
  if (labeled.length === 0) throw new Error('No Personal or Private labels to score.');
  const asked = labeled.map(ask);

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
  const moved = asked.filter((entry) => timed.some((pass) => pass.answers.get(entry.item.id)?.judge !== warm.answers.get(entry.item.id)?.judge));

  const rows: ScoredRow[] = labeled.map((item) => ({
    id: item.id,
    owner: labels[item.id]!.label as Tier,
    judge: warm.answers.get(item.id)!.judge,
    source: item.source ?? 'files',
    split: splitOf(item.id),
    ...(item.stratum ? { stratum: item.stratum } : {}),
  }));
  const answers = [...warm.answers.values()];
  const coverage = answers.flatMap((answer) => (answer.coverage === undefined ? [] : [answer.coverage]));
  const sizes = stratumSizes(sample.recipe);
  const weighted = sizes ? reweighted(rows, sizes) : undefined;
  const speed = timed.length > 0 ? medianAndRange(timed.map((pass) => pass.itemsPerMinute)) : undefined;

  const result = {
    at: new Date().toISOString(),
    mode,
    model: modelName,
    prompt: snifferPromptVersions(ownerContext).cache,
    ownerWords: ownerContext ? 'supplied' : 'none',
    primed: true,
    privateBar: mode === 'decision' ? PRIVATE_BAR : undefined,
    items: rows.length,
    answeredBy: count(answers.map((answer) => answer.via)),
    verdictsMovedAcrossPasses: moved.length,
    wordMass: coverage.length > 0 ? medianAndRange(coverage) : undefined,
    speedItemsPerMinute: speed,
    primedCheck: primedResult,
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

await main();

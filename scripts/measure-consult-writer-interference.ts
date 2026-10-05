// Measurement M0 for the frontier-consult design (results and method:
// docs/design/consult-m0-measurement.md). Question: when a low-priority
// "writer" call to the built-in on-device model is in flight and a fresh
// private answer arrives, how much later does the fresh answer reach its first
// token and finish than with no writer?
//
// It runs its OWN llama-server through the product's own launcher
// (createBuiltInAnalystModel -> createLlamaServerHandle: the product's flags,
// --parallel 1, 12,288-token context, loopback, random port and token) and
// sends every fresh answer through the product's own answer path
// (answerPrivately with the panel's summary limits: compact evidence,
// 11,000-byte prompt ceiling, 1,000-character answer, no audit pass). The model
// file and server binary already on disk are used read-only; nothing is
// downloaded. Status and token files go to a scratch directory (--state),
// never ~/.olympus or the real data directory. The server is always stopped
// on exit, including on failure or Ctrl-C.
//
// Design: paired and randomized. Each trial is one (phase, question) pair run
// twice in random order: CONTROL (fresh answer, nothing else) and WRITER (a
// writer call in flight; the fresh answer arrives at the phase's point). Both
// halves start from the same server state: a one-token "primer" that leaves
// the analyst's system prompt in the server's prompt cache, as a previous
// fresh answer would. All times run from the fresh answer's arrival, with any
// abort delay included.
//
//   bun scripts/measure-consult-writer-interference.ts [--state <dir>] [--n 5] \
//     [--modes abort,queue] [--queue-n 3] [--slots-probe] [--out results.json]
//
// --slots-probe starts the server with --slots instead of --no-slots (the only
// flag changed) and, instead of the paired trials, aborts writers at each phase
// and polls /slots to show when the server's slot actually stops processing.
//
// Measurement only: nothing in src/ imports this file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  answerPrivately,
  createBuiltInAnalystModel,
  type BuiltInAnalystModel,
  type PrivateEvidenceItem,
  type PrivateModelCallTiming,
} from '../src/core/analyst-built-in.ts';
import { QWEN35_4B, LLAMA_SERVER_RUNTIME } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import {
  createLlamaServerHandle,
  llamaServerArguments,
  type LlamaServerEndpoint,
  type LlamaServerHandle,
  type LlamaServerLaunch,
} from '../src/workers/source-index/built-in-reasoning/server.ts';

// ---------------------------------------------------------------------------
// Arguments and paths

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const N = Number(arg('n') ?? '5');
const QUEUE_N = Number(arg('queue-n') ?? '3');
const MODES = new Set((arg('modes') ?? 'abort,queue').split(','));
const SLOTS_PROBE = process.argv.includes('--slots-probe');
const RESET_COMPARE = !process.argv.includes('--no-reset-compare');
const STATE = resolve(arg('state') ?? join(import.meta.dir, '..', '.measure', 'consult-m0'));
const OUT = resolve(arg('out') ?? join(STATE, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
/** The writer prompt, in model tokens after the chat template (design bound: 2,048). */
const WRITER_TARGET_TOKENS = Number(arg('writer-tokens') ?? '2040');
const WRITER_MAX_TOKENS = Number(arg('writer-max-tokens') ?? '160');
/** Evidence characters per item: four items give a summary prompt of about 1,600 tokens. */
const EVIDENCE_CHARS = Number(arg('evidence-chars') ?? '1000');
/** The "hung" writer is aborted at this point (a scaled stand-in for its 60 s deadline). */
const HUNG_ABORT_MS = Number(arg('hung-abort-ms') ?? '20000');
const SEED = Number(arg('seed') ?? '20261005');
/**
 * Fallback experiment: the writer's request starts with the analyst's own
 * system prompt (writer rules move into the user turn), so the server's
 * cached prefix still matches the next fresh answer after a writer.
 */
const WRITER_SHARES_PREFIX = process.argv.includes('--writer-shares-analyst-prefix');
let analystSystemPrompt = '';

mkdirSync(STATE, { recursive: true });
// The server's token directory is made under os.tmpdir(); keep it in the scratch dir.
process.env.TMPDIR = STATE;

// The real install, read-only: the product's default data directory.
const realRoot = join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'openclaw', 'olympus', 'models', 'built-in-reasoning');
const MODEL_PATH = join(realRoot, QWEN35_4B.modelId, QWEN35_4B.file.name);
const runtimeDir = join(realRoot, `llama.cpp-${LLAMA_SERVER_RUNTIME.release}-darwin-arm64`);
const marker = (() => {
  try {
    return JSON.parse(readFileSync(join(runtimeDir, 'olympus-runtime.json'), 'utf8')) as { serverPath?: string };
  } catch {
    return undefined;
  }
})();
const SERVER_PATH = marker?.serverPath ? join(runtimeDir, marker.serverPath) : '';
if (!existsSync(MODEL_PATH) || !SERVER_PATH || !existsSync(SERVER_PATH)) {
  console.error(`Built-in model or server not installed (model ${existsSync(MODEL_PATH)}, server ${SERVER_PATH ? existsSync(SERVER_PATH) : false}). Stopping; nothing is downloaded.`);
  process.exit(2);
}

// Scratch env: status.json and the child's HOME/TMPDIR live under STATE.
const scratchEnv: Record<string, string | undefined> = {
  ...process.env,
  HOME: STATE,
  TMPDIR: STATE,
  OLYMPUS_BUILT_IN_REASONING_DIR: join(STATE, 'built-in-reasoning'),
};

// ---------------------------------------------------------------------------
// Evidence: the fictional demo data in the repo, four items per question.

const DEMO = join(import.meta.dir, '..', 'chatgpt-plugin', 'demo-data');
const demo = (file: string) => readFileSync(join(DEMO, file), 'utf8');

/** One evidence item: a primary file followed by related ones, as a longer thread, clipped. */
function item(id: string, title: string, source: string, files: string[]): PrivateEvidenceItem {
  return { id, title, source, text: files.map(demo).join('\n\n').slice(0, EVIDENCE_CHARS) };
}

const ITEMS = {
  bank: item('bank-notice', 'Your September statement and overdraft notice', 'Mail', ['mail/009-bank-notice.eml', 'notes/2026-09-02-budget-decision.md', 'docs/household-budget-2026.csv', 'mail/005-priya-budget.eml']),
  lab: item('lab-results', 'Your test results are ready', 'Mail', ['mail/008-lab-results.eml', 'notes/2026-09-20-clinic-visit.md', 'mail/003-dentist-appointment.eml']),
  clinic: item('clinic-visit', 'Clinic visit - 20 Sept 2026', 'Notes', ['notes/2026-09-20-clinic-visit.md', 'mail/008-lab-results.eml', 'docs/insurance-claim.md']),
  claim: item('insurance-claim', 'Insurance claim notes', 'Files', ['docs/insurance-claim.md', 'mail/008-lab-results.eml', 'notes/2026-09-20-clinic-visit.md']),
  tax: item('tax-notes', 'Tax notes, 2025 tax year', 'Files', ['docs/tax-notes-2025.md', 'docs/household-budget-2026.csv', 'mail/005-priya-budget.eml', 'notes/2026-09-02-budget-decision.md']),
  lease: item('lease-summary', 'Lease summary: 14 Larch Court', 'Files', ['docs/lease-summary.md', 'mail/001-sam-lease-renewal.eml', 'mail/002-sam-lease-followup.eml']),
  kitchen: item('kitchen-plan', 'Kitchen renovation plan', 'Files', ['docs/kitchen-renovation-plan.md', 'mail/006-contractor-quote.eml', 'notes/2026-09-02-budget-decision.md']),
  trip: item('lisbon', 'Lisbon itinerary', 'Notes', ['notes/2026-09-18-lisbon-itinerary.md', 'mail/007-flight-confirmation.eml', 'notes/2026-09-24-ideas-workshop.md']),
};

interface Question { id: string; question: string; evidence: PrivateEvidenceItem[] }

const QUESTIONS: Question[] = [
  { id: 'q1', question: 'Summarize my money situation from the bank notice and what I decided about the budget.', evidence: [ITEMS.bank, ITEMS.tax, ITEMS.kitchen, ITEMS.lease] },
  { id: 'q2', question: 'Why did I see Dr. Hale in September, and what did the blood tests she ordered show?', evidence: [ITEMS.clinic, ITEMS.lab, ITEMS.claim, ITEMS.trip] },
  { id: 'q3', question: 'What does my lease say about renewal, and what did Sam ask me to confirm?', evidence: [ITEMS.lease, ITEMS.kitchen, ITEMS.bank, ITEMS.trip] },
  { id: 'q4', question: 'What follow-ups do I have after the blood tests: what did the clinic recommend and what does the insurer still need?', evidence: [ITEMS.lab, ITEMS.claim, ITEMS.clinic, ITEMS.tax] },
  { id: 'q5', question: 'What did the contractor quote for the kitchen and how does it fit the household budget?', evidence: [ITEMS.kitchen, ITEMS.bank, ITEMS.tax, ITEMS.lease] },
];

// ---------------------------------------------------------------------------
// The product model, on our own server, with a fetch tap for raw timings.

interface RawTimings { prompt_n?: number; prompt_ms?: number; predicted_n?: number; predicted_ms?: number; cache_n?: number }

let lastTimings: RawTimings | undefined;
let lastRequestBody: { messages?: Array<{ role: string; content: string }>; [key: string]: unknown } | undefined;
const tapFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const response = await fetch(input, init);
  if (url.endsWith('/v1/chat/completions')) {
    try {
      lastRequestBody = JSON.parse(String(init?.body ?? '{}')) as typeof lastRequestBody;
    } catch {
      lastRequestBody = undefined;
    }
    const clone = response.clone();
    clone.json().then((payload: { timings?: RawTimings }) => {
      lastTimings = payload.timings;
    }, () => undefined);
  }
  return response;
}) as typeof fetch;

/** Diagnostic only: --server-log keeps the server's own log (the product passes --log-disable). */
const SERVER_LOG = arg('server-log');
/** Fallback experiments only: extra server arguments appended after the product's (a later flag overrides an earlier one), comma-separated. */
const EXTRA_ARGS = arg('extra-args')?.split(',').filter(Boolean) ?? [];
/** --slots-probe: the product's arguments with --no-slots swapped for --slots; --server-log: a log file instead of --log-disable. */
const probeSpawn = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
  let changed = args.map((value) => (SLOTS_PROBE && value === '--no-slots' ? '--slots' : value));
  changed = [...changed, ...EXTRA_ARGS];
  if (SERVER_LOG) changed = [...changed.filter((value) => value !== '--log-disable'), '--log-file', resolve(SERVER_LOG), '--log-timestamps'];
  return spawn(command, changed, options);
}) as unknown as typeof spawn;

let handle: LlamaServerHandle | undefined;
let launchSeen: LlamaServerLaunch | undefined;
/** Every server pid seen: more than one means the server was restarted (a reset). */
const pidsSeen = new Set<number>();
const model: BuiltInAnalystModel = createBuiltInAnalystModel({
  env: scratchEnv,
  model: QWEN35_4B,
  fetchImpl: tapFetch,
  waitForInstall: true,
  install: async () => ({ modelPath: MODEL_PATH, serverPath: SERVER_PATH, gpu: true }),
  createServer: (launch) => {
    launchSeen = launch;
    handle = createLlamaServerHandle(launch, { env: scratchEnv, ...(SLOTS_PROBE || SERVER_LOG || EXTRA_ARGS.length > 0 ? { spawnImpl: probeSpawn } : {}) });
    return handle;
  },
});

async function endpoint(): Promise<LlamaServerEndpoint> {
  // The first model call creates and starts the server through the product path.
  if (!handle) await model.complete({ system: 'Reply with {}', prompt: '{}', localOnly: true, maxOutputChars: 10 });
  const ep = await handle!.ensureRunning();
  if (handle!.pid !== undefined) pidsSeen.add(handle!.pid);
  return ep;
}

async function stopServer(): Promise<void> {
  try {
    await model.stop();
  } catch (error) {
    console.error('stop failed', error);
  }
}
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void stopServer().finally(() => process.exit(130));
  });
}

async function post(ep: LlamaServerEndpoint, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${ep.baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ep.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

// ---------------------------------------------------------------------------
// The fresh answer: the product path, timed from its arrival.

interface FreshResult {
  question: string;
  /** Arrival to completion of the answer. */
  wallMs: number;
  /** Arrival to the first output token (derived: wall minus generation time; the product request is not streamed). */
  firstTokenMs?: number;
  /** Arrival to the server starting on it (wall minus prompt and generation time). */
  startDelayMs?: number;
  calls: number;
  promptTokens?: number;
  cachedTokens?: number;
  promptMs?: number;
  outputTokens?: number;
  outputMs?: number;
  ok: boolean;
  error?: string;
}

async function freshAnswer(question: Question): Promise<FreshResult> {
  const calls: PrivateModelCallTiming[] = [];
  lastTimings = undefined;
  const started = performance.now();
  let ok = true;
  let error: string | undefined;
  try {
    await answerPrivately(question.question, question.evidence, {
      model,
      maxPromptBytes: 11_000,
      maxAnswerChars: 1_000,
      audit: false,
      evidenceFormat: 'compact',
      onModelCall: (call) => calls.push(call),
    });
  } catch (caught) {
    ok = false;
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const wallMs = performance.now() - started;
  await new Promise((r) => setTimeout(r, 5)); // let the tap parse the body
  // Set by the fetch tap during the call (TypeScript cannot see that assignment).
  const timings = lastTimings as RawTimings | undefined;
  const result: FreshResult = { question: question.id, wallMs: Math.round(wallMs), calls: calls.length, ok };
  if (error) result.error = error;
  if (timings?.prompt_n !== undefined) result.promptTokens = timings.prompt_n;
  if (timings?.cache_n !== undefined) result.cachedTokens = timings.cache_n;
  if (timings?.prompt_ms !== undefined) result.promptMs = Math.round(timings.prompt_ms);
  if (timings?.predicted_n !== undefined) result.outputTokens = timings.predicted_n;
  if (timings?.predicted_ms !== undefined) result.outputMs = Math.round(timings.predicted_ms);
  // Only meaningful for single-call answers (no retry).
  if (calls.length === 1 && timings?.prompt_ms !== undefined && timings.predicted_ms !== undefined) {
    result.firstTokenMs = Math.round(wallMs - timings.predicted_ms);
    result.startDelayMs = Math.round(wallMs - timings.prompt_ms - timings.predicted_ms);
  }
  return result;
}

/**
 * Leaves the server as a previous fresh answer would: the analyst system
 * prompt (captured from a real fresh request) in the prompt cache, plus a
 * short different user turn; one output token.
 */
async function primer(ep: LlamaServerEndpoint, analystSystem: string, serial: number): Promise<void> {
  const response = await post(ep, '/v1/chat/completions', {
    messages: [{ role: 'system', content: analystSystem }, { role: 'user', content: `Primer ${serial}.` }],
    temperature: 0,
    max_tokens: 1,
  });
  await response.text();
}

// ---------------------------------------------------------------------------
// The writer: one raw request shaped like the product's (temperature 0, its
// own small JSON schema, max_tokens 160), prompt counted with the server's
// own tokenizer after the chat template.

const WRITER_SYSTEM = [
  'You write background questions for an outside model. You are given a user\'s question, an answer written from their private documents, and what that answer could not find.',
  'Write exactly three general questions, each 25 to 35 words, on one topic, that would help fill the gaps with general knowledge.',
  'Never include names, places, dates, amounts, identifiers or any other detail from the answer or the question. Use only general words.',
  'Reply with one JSON object only.',
].join('\n');

const WRITER_SCHEMA = {
  type: 'object',
  properties: {
    consult: {
      anyOf: [
        { type: 'null' },
        { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: 200 } },
      ],
    },
  },
  required: ['consult'],
  additionalProperties: false,
};

let writerPrompt = '';

async function templatedTokens(ep: LlamaServerEndpoint, user: string): Promise<number> {
  const messages = WRITER_SHARES_PREFIX
    ? [{ role: 'system', content: analystSystemPrompt }, { role: 'user', content: `${WRITER_SYSTEM}\n\n${user}` }]
    : [{ role: 'system', content: WRITER_SYSTEM }, { role: 'user', content: user }];
  const applied = await (await post(ep, '/apply-template', { messages })).json() as { prompt?: string };
  const tokens = await (await post(ep, '/tokenize', { content: applied.prompt ?? '', add_special: true })).json() as { tokens?: unknown[] };
  return tokens.tokens?.length ?? 0;
}

/** A writer prompt (question, a 2,700-char answer, five gaps) padded with earlier-answer text to the token target. */
async function buildWriterPrompt(ep: LlamaServerEndpoint): Promise<{ prompt: string; tokens: number }> {
  const answerBase = [demo('mail/009-bank-notice.eml'), demo('docs/tax-notes-2025.md'), demo('notes/2026-09-02-budget-decision.md'), demo('docs/kitchen-renovation-plan.md'), demo('mail/006-contractor-quote.eml'), demo('docs/lease-summary.md')].join('\n');
  const gaps = ['The interest rate on the loan is not given.', 'The overdraft fee policy is not stated.', 'Whether the tax estimate includes freelance expenses is unclear.', 'The contractor\'s payment schedule is not given.', 'The lease renewal deadline is not stated.'];
  const extras = [demo('mail/001-sam-lease-renewal.eml'), demo('mail/002-sam-lease-followup.eml'), demo('mail/005-priya-budget.eml'), demo('docs/household-budget-2026.csv'), demo('mail/008-lab-results.eml'), demo('docs/insurance-claim.md'), demo('notes/2026-09-20-clinic-visit.md'), demo('mail/007-flight-confirmation.eml'), demo('notes/2026-09-18-lisbon-itinerary.md'), demo('docs/garden-bylaws.md')].join('\n');
  const compose = (extraChars: number) => [
    'Request 000000.',
    'Question: Summarize my money situation and what I still need to decide.',
    `Answer:\n${answerBase.slice(0, 2_700)}`,
    `Could not find:\n- ${gaps.join('\n- ')}`,
    extraChars > 0 ? `Earlier answers on this topic:\n${(extras + extras + extras).slice(0, extraChars)}` : '',
  ].join('\n\n');
  let low = 0;
  let high = 20_000;
  while (high - low > 8) {
    const mid = Math.floor((low + high) / 2);
    if (await templatedTokens(ep, compose(mid)) <= WRITER_TARGET_TOKENS) low = mid;
    else high = mid;
  }
  const prompt = compose(low);
  return { prompt, tokens: await templatedTokens(ep, prompt) };
}

interface WriterOutcome { completed: boolean; timings?: RawTimings; wallMs: number; error?: string }
interface WriterRun { promise: Promise<WriterOutcome>; abort(): void; startedAt: number }

let writerSerial = 0;

function startWriter(ep: LlamaServerEndpoint, hung = false): WriterRun {
  // Each writer serves a different answer: a distinct first line (same token
  // count) keeps one writer from reusing the previous writer's cached prompt.
  writerSerial += 1;
  const userContent = writerPrompt.replace('Request 000000.', `Request ${String(writerSerial).padStart(6, '0')}.`);
  const controller = new AbortController();
  const startedAt = performance.now();
  const promise = (async (): Promise<WriterOutcome> => {
    try {
      const response = await post(ep, '/v1/chat/completions', {
        messages: WRITER_SHARES_PREFIX
          ? [{ role: 'system', content: analystSystemPrompt }, { role: 'user', content: `${WRITER_SYSTEM}\n\n${userContent}` }]
          : [{ role: 'system', content: WRITER_SYSTEM }, { role: 'user', content: userContent }],
        temperature: 0,
        max_tokens: hung ? 4_000 : WRITER_MAX_TOKENS,
        // The hung stand-in ignores end-of-sequence, so it is still generating
        // when its deadline comes, as a writer that never returns would be.
        ...(hung ? { ignore_eos: true } : { response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: WRITER_SCHEMA } } }),
      }, controller.signal);
      const payload = await response.json() as { timings?: RawTimings };
      return { completed: true, ...(payload.timings ? { timings: payload.timings } : {}), wallMs: Math.round(performance.now() - startedAt) };
    } catch (error) {
      return { completed: false, wallMs: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.name : String(error) };
    }
  })();
  return { promise, abort: () => controller.abort(), startedAt };
}

// ---------------------------------------------------------------------------
// Machine state, read-only (ps and sysctl only; nothing is signalled).

function machineSnapshot(): Record<string, unknown> {
  const ps = spawnSync('ps', ['-axo', 'pid=,%cpu=,rss=,command='], { encoding: 'utf8' }).stdout;
  // Only processes whose executable is llama-server (not shells whose command line mentions it).
  const isLlama = (line: string) => /^\s*\d+\s+\S+\s+\d+\s+\S*\/llama-server(\s|$)/.test(line);
  const lines = ps.split('\n').filter((line) => isLlama(line) || /^\s*\d+\s+\S+\s+\d+\s+\S*bun\b.*(__engine-run|__worker-service-run)/.test(line));
  const ours = handle?.pid;
  const otherLlama = lines.filter((line) => isLlama(line) && !(ours !== undefined && line.trim().startsWith(`${ours} `)));
  const top = ps.split('\n').map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length > 3)
    .map((parts) => ({ pid: parts[0], cpu: Number(parts[1]), cmd: parts.slice(3).join(' ').slice(0, 80) }))
    .sort((a, b) => b.cpu - a.cpu).slice(0, 5);
  return {
    at: new Date().toISOString(),
    loadavg: spawnSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).stdout.trim(),
    liveEngineProcesses: lines.filter((line) => !isLlama(line)).length,
    otherLlamaServers: otherLlama.length,
    otherLlamaServerLines: otherLlama.map((line) => line.trim().slice(0, 160)),
    topCpu: top,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Deterministic shuffle (mulberry32), so a run can be repeated. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main

interface Phase { name: string; offsetMs: number; hung?: boolean }

async function main(): Promise<void> {
  const random = rng(SEED);
  const results: Record<string, unknown> = {
    model: QWEN35_4B.modelId,
    quantization: 'Q4_K_M',
    runtime: LLAMA_SERVER_RUNTIME.release,
    slotsProbe: SLOTS_PROBE,
    machine: {
      cpu: spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).stdout.trim(),
      memBytes: Number(spawnSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).stdout.trim()),
      macos: spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim(),
    },
    startSnapshot: machineSnapshot(),
    n: N,
    seed: SEED,
  };
  const save = () => writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
  try {
    const loadStarted = performance.now();
    const ep = await endpoint();
    results.serverLoadMs = Math.round(performance.now() - loadStarted);
    results.launch = launchSeen;
    results.serverArgs = launchSeen ? [...llamaServerArguments(launchSeen, 0, '<token-file>').map((value) => (SLOTS_PROBE && value === '--no-slots' ? '--slots' : value)), ...EXTRA_ARGS] : undefined;
    console.error(`server up at ${ep.baseUrl} (pid ${handle?.pid}) in ${results.serverLoadMs} ms`);

    // Warm-up answers (the first calls after load pay one-time Metal setup); also captures the analyst system prompt.
    await freshAnswer(QUESTIONS[4]!);
    await freshAnswer(QUESTIONS[3]!);
    const analystSystem = lastRequestBody?.messages?.[0]?.content ?? '';
    analystSystemPrompt = analystSystem;
    const built = await buildWriterPrompt(ep);
    writerPrompt = built.prompt;
    results.writerPromptTokens = built.tokens;
    results.writerSharesAnalystPrefix = WRITER_SHARES_PREFIX;
    results.freshRequestShape = lastRequestBody
      ? { temperature: lastRequestBody.temperature, max_tokens: lastRequestBody.max_tokens, response_format: (lastRequestBody.response_format as { type?: string } | undefined)?.type, stream: lastRequestBody.stream ?? false }
      : undefined;
    let primerSerial = 0;

    // Writer calibration: complete writer calls, each after a primer (no cache reuse).
    const calib: WriterOutcome[] = [];
    for (let i = 0; i < 3; i += 1) {
      await primer(ep, analystSystem, (primerSerial += 1));
      calib.push(await startWriter(ep).promise);
    }
    results.writerCalibration = calib;
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    const P = median(calib.map((c) => c.timings?.prompt_ms ?? 0));
    const G = median(calib.map((c) => c.timings?.predicted_ms ?? 0));
    console.error(`writer: prompt ${built.tokens} tok (templated), prefill ${Math.round(P)} ms, output ${calib.map((c) => c.timings?.predicted_n).join('/')} tok in ${Math.round(G)} ms`);
    save();

    const phases: Phase[] = [
      { name: 'just_started', offsetMs: 200 },
      { name: 'prefill', offsetMs: Math.round(P * 0.5) },
      { name: 'generation', offsetMs: Math.round(P + G * 0.4) },
      { name: 'near_end', offsetMs: Math.round(P + G * 0.85) },
      { name: 'hung', offsetMs: HUNG_ABORT_MS, hung: true },
    ];
    const only = arg('only-phases')?.split(',');
    if (only) phases.splice(0, phases.length, ...phases.filter((phase) => only.includes(phase.name)));
    results.phases = phases;

    if (SLOTS_PROBE) {
      // Evidence that an aborted client request frees the server's slot: poll /slots after the abort.
      const probe: unknown[] = [];
      for (const phase of phases) {
        for (let i = 0; i < N; i += 1) {
          await primer(ep, analystSystem, (primerSerial += 1));
          const run = startWriter(ep, phase.hung === true);
          await sleep(phase.offsetMs - (performance.now() - run.startedAt));
          const abortedAt = performance.now();
          run.abort();
          // Two independent signals, started together at the abort:
          // (a) /slots polled until no slot is processing (the server answers
          //     /slots only between its compute steps, so this is an upper bound);
          // (b) a one-token request: when the server starts on it, the slot was free.
          const slotsFree = (async () => {
            const polls: Array<{ atMs: number; busy: boolean }> = [];
            while (performance.now() - abortedAt < 60_000) {
              const busy = await slotBusy(ep);
              polls.push({ atMs: Math.round(performance.now() - abortedAt), busy });
              if (!busy) return { freeMs: polls[polls.length - 1]!.atMs, polls };
              await sleep(10);
            }
            return { freeMs: undefined, polls };
          })();
          const tiny = (async () => {
            const response = await post(ep, '/v1/chat/completions', {
              messages: [{ role: 'user', content: `Probe ${i} ${phase.name}. Reply OK.` }], temperature: 0, max_tokens: 1,
            });
            const payload = await response.json() as { timings?: RawTimings };
            const wall = performance.now() - abortedAt;
            const t = payload.timings;
            return { wallMs: Math.round(wall), startedAfterAbortMs: t?.prompt_ms !== undefined && t.predicted_ms !== undefined ? Math.round(wall - t.prompt_ms - t.predicted_ms) : undefined };
          })();
          const [slots, probeRequest, writer] = await Promise.all([slotsFree, tiny, run.promise]);
          probe.push({ phase: phase.name, abortAtMs: Math.round(abortedAt - run.startedAt), slotsFreeAfterAbortMs: slots.freeMs, firstSlotsPoll: slots.polls[0], probeRequest, writer, snapshot: machineSnapshot() });
          console.error(`P ${phase.name} abort at ${Math.round(abortedAt - run.startedAt)} ms: /slots free after ${slots.freeMs} ms (first poll answered at ${slots.polls[0]?.atMs} ms), 1-token request started after ${probeRequest.startedAfterAbortMs} ms`);
        }
        results.slotsProbe = probe;
        save();
      }
      return;
    }

    // Paired trials, randomized: every (mode, phase, question) pair runs CONTROL and WRITER in random order.
    const trials: Array<{ mode: 'abort' | 'queue'; phase: Phase; question: Question }> = [];
    for (const mode of ['abort', 'queue'] as const) {
      if (!MODES.has(mode)) continue;
      for (const phase of phases) {
        // Queuing behind a hung writer is unbounded by construction; not measured.
        if (mode === 'queue' && phase.hung) continue;
        const count = mode === 'abort' ? N : QUEUE_N;
        for (let i = 0; i < count; i += 1) trials.push({ mode, phase, question: QUESTIONS[i % QUESTIONS.length]! });
      }
    }
    const pairs: unknown[] = [];
    results.pairs = pairs;
    for (const [index, trial] of shuffle(trials, random).entries()) {
      const order = random() < 0.5 ? ['control', 'writer'] as const : ['writer', 'control'] as const;
      const record: Record<string, unknown> = { mode: trial.mode, phase: trial.phase.name, question: trial.question.id, order };
      for (const arm of order) {
        await primer(ep, analystSystem, (primerSerial += 1));
        if (arm === 'control') {
          record.control = await freshAnswer(trial.question);
          continue;
        }
        const run = startWriter(ep, trial.phase.hung === true);
        await sleep(trial.phase.offsetMs - (performance.now() - run.startedAt));
        const arrivedAtMs = Math.round(performance.now() - run.startedAt);
        if (trial.mode === 'abort') run.abort(); // as the jobs engine would: abort the request, free its own slot, start the fresh answer
        const fresh = await freshAnswer(trial.question);
        const writer = await run.promise;
        record.withWriter = { arrivedAtMs, writer, fresh };
      }
      record.serverPid = handle?.pid;
      if (handle?.pid !== undefined) pidsSeen.add(handle.pid);
      record.snapshot = machineSnapshot();
      pairs.push(record);
      const control = record.control as FreshResult;
      const withWriter = (record.withWriter as { fresh: FreshResult; writer: WriterOutcome }).fresh;
      console.error(`T${index + 1}/${trials.length} ${trial.mode} ${trial.phase.name} ${trial.question.id} ${order.join('>')} control ttft ${control.firstTokenMs} wall ${control.wallMs} | writer ttft ${withWriter.firstTokenMs} wall ${withWriter.wallMs} start ${withWriter.startDelayMs} cached ${withWriter.cachedTokens}/${control.cachedTokens} out ${withWriter.outputTokens}/${control.outputTokens}`);
      save();
    }

    // Cache effect: a fresh answer right after a COMPLETED writer vs right after a primer.
    const cache: unknown[] = [];
    for (const question of QUESTIONS.slice(0, N)) {
      await primer(ep, analystSystem, (primerSerial += 1));
      await startWriter(ep).promise;
      const afterWriter = await freshAnswer(question);
      cache.push({ question: question.id, afterWriter });
      console.error(`C ${question.id} after completed writer ttft ${afterWriter.firstTokenMs} cached ${afterWriter.cachedTokens}`);
    }
    results.cacheAfterCompletedWriter = cache;
    results.distinctServerPids = [...pidsSeen];
    save();

    if (RESET_COMPARE) {
      // For comparison only: what a model reset (stop + reload) costs the next answer.
      const reset: unknown[] = [];
      for (const question of QUESTIONS.slice(0, 3)) {
        const stopStarted = performance.now();
        await model.stop();
        const stopMs = Math.round(performance.now() - stopStarted);
        const fresh = await freshAnswer(question);
        reset.push({ stopMs, fresh });
        console.error(`R ${question.id} stop ${stopMs} ttft ${fresh.firstTokenMs} wall ${fresh.wallMs}`);
      }
      results.afterReset = reset;
      save();
    }
    results.endSnapshot = machineSnapshot();
  } finally {
    await stopServer();
    results.serverStopped = handle?.pid === undefined;
    save();
    console.error(`results: ${OUT}`);
  }
}

async function slotBusy(ep: LlamaServerEndpoint): Promise<boolean> {
  const response = await fetch(`${ep.baseUrl}/slots`, { headers: { authorization: `Bearer ${ep.token}` } });
  const slots = await response.json() as Array<{ is_processing?: boolean }>;
  return slots.some((slot) => slot.is_processing === true);
}

// ---------------------------------------------------------------------------
// --analyze <results.json>: the summary table and the decision rule.

interface PairRecord { mode: string; phase: string; question: string; control: FreshResult; withWriter: { fresh: FreshResult; writer: WriterOutcome; arrivedAtMs: number }; serverPid?: number; snapshot?: { otherLlamaServers?: number; loadavg?: string } }

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}
const stats = (values: number[]) => `median ${Math.round(quantile(values, 0.5))} | p95 ${Math.round(quantile(values, 0.95))} | range ${Math.round(Math.min(...values))}..${Math.round(Math.max(...values))} (n=${values.length})`;

function analyze(path: string): void {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { pairs?: PairRecord[] };
  const pairs = (data.pairs ?? []).filter((pair) => pair.control?.firstTokenMs !== undefined && pair.withWriter?.fresh?.firstTokenMs !== undefined);
  const lines: string[] = [];
  const controls = pairs.map((pair) => pair.control);
  lines.push(`Control (no writer): first token ${stats(controls.map((c) => c.firstTokenMs!))}; completion ${stats(controls.map((c) => c.wallMs))}`);
  // Noise floor: each control against the median control of the same question.
  const byQuestion = new Map<string, FreshResult[]>();
  for (const control of controls) byQuestion.set(control.question, [...(byQuestion.get(control.question) ?? []), control]);
  const noiseFirst: number[] = [];
  const noiseWall: number[] = [];
  for (const group of byQuestion.values()) {
    const mf = quantile(group.map((c) => c.firstTokenMs!), 0.5);
    const mw = quantile(group.map((c) => c.wallMs), 0.5);
    for (const control of group) {
      noiseFirst.push(Math.abs(control.firstTokenMs! - mf));
      noiseWall.push(Math.abs(control.wallMs - mw));
    }
  }
  lines.push(`Noise floor (|control - same-question median control|): first token ${stats(noiseFirst)}; completion ${stats(noiseWall)}`);
  let pass = true;
  for (const mode of ['abort', 'queue']) {
    const phaseNames = [...new Set(pairs.filter((pair) => pair.mode === mode).map((pair) => pair.phase))];
    const pooled: number[] = [];
    for (const phase of phaseNames) {
      const group = pairs.filter((pair) => pair.mode === mode && pair.phase === phase);
      const first = group.map((pair) => pair.withWriter.fresh.firstTokenMs! - pair.control.firstTokenMs!);
      const wall = group.map((pair) => pair.withWriter.fresh.wallMs - pair.control.wallMs);
      const start = group.map((pair) => pair.withWriter.fresh.startDelayMs ?? Number.NaN);
      const cached = group.map((pair) => `${pair.withWriter.fresh.cachedTokens}/${pair.control.cachedTokens}`);
      const mismatched = group.filter((pair) => pair.withWriter.fresh.outputTokens !== pair.control.outputTokens).length;
      pooled.push(...first);
      lines.push(`${mode} ${phase}: added first-token ${stats(first)}; added completion ${stats(wall)}; server start after arrival ${stats(start)}; cached writer/control ${cached.join(' ')}; output-length mismatches ${mismatched}`);
    }
    if (mode === 'abort' && pooled.length > 0) {
      const median = quantile(pooled, 0.5);
      const p95 = quantile(pooled, 0.95);
      const ok = median <= 250 && p95 <= 1_000;
      pass &&= ok;
      lines.push(`abort pooled added first-token: median ${Math.round(median)} ms, p95 ${Math.round(p95)} ms -> ${ok ? 'within' : 'OUTSIDE'} the rule (median <= 250 ms, p95 <= 1,000 ms)`);
    }
  }
  const pids = (data.distinctServerPids as number[] | undefined) ?? [];
  lines.push(`Server processes seen during the paired trials: ${pids.length} (${pids.length === 1 ? 'no restart, no reset' : 'RESTARTED'})`);
  if (pids.length !== 1) pass = false;
  const cache = (data.cacheAfterCompletedWriter as Array<{ question: string; afterWriter: FreshResult }> | undefined) ?? [];
  if (cache.length > 0) {
    const added = cache.map((entry) => entry.afterWriter.firstTokenMs! - quantile((byQuestion.get(entry.question) ?? []).map((c) => c.firstTokenMs!), 0.5));
    lines.push(`After a COMPLETED writer (cache holds the writer's prompt): added first-token vs median control ${stats(added)}; cached tokens ${cache.map((entry) => entry.afterWriter.cachedTokens).join(' ')}`);
  }
  const reset = (data.afterReset as Array<{ stopMs: number; fresh: FreshResult }> | undefined) ?? [];
  if (reset.length > 0) {
    const added = reset.map((entry) => entry.fresh.firstTokenMs! - quantile((byQuestion.get(entry.fresh.question) ?? []).map((c) => c.firstTokenMs!), 0.5));
    lines.push(`After a model reset (comparison): stop ${stats(reset.map((entry) => entry.stopMs))}; added first-token ${stats(added)}`);
  }
  // Re-checked from the recorded lines: only an executable named llama-server counts (early runs also matched shells mentioning it).
  const realLlama = (line: string) => /^\d+\s+\S+\s+\d+\s+\S*\/llama-server(\s|$)/.test(line);
  const others = pairs.filter((pair) => ((pair.snapshot as { otherLlamaServerLines?: string[] } | undefined)?.otherLlamaServerLines ?? []).some(realLlama)).length;
  lines.push(`Pairs with another llama-server running on the machine: ${others}/${pairs.length}`);
  lines.push(`VERDICT (abort mode, decision rule): ${pass ? 'PASS' : 'FAIL'}`);
  console.log(lines.join('\n'));
}

const analyzePath = arg('analyze');
if (analyzePath) analyze(resolve(analyzePath));
else await main();

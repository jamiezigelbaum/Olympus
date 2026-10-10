// Measurement M0, round 2 (results: docs/design/consult-m0-measurement.md,
// "Round 2"). Round 1 (measure-consult-writer-interference.ts) showed that a
// writer call on the product's model server delays a fresh private answer.
// This script tests configurations that might isolate the two:
//
//   A  same server, the writer request starts with the analyst's exact system
//      prompt (so the cached prefix survives) and small prompt batches (so an
//      abort takes effect quickly), optionally with a small RAM prompt cache;
//   B  a separate writer server process (the fresh answer's server is never
//      touched), warm or started on demand, stopped or killed on arrival;
//   C  a second slot on the same server (--parallel 2).
//
// Every server is our OWN llama-server, started with the product's own
// launcher (createLlamaServerHandle, the product's flags) plus the extra
// arguments under test, from the model and server files already on disk
// (read-only; nothing is downloaded). State goes to --state. Every server is
// stopped on exit, including on failure or Ctrl-C.
//
// Fresh answers: the exact request body the product sends for each question
// (captured once from answerPrivately with the panel's summary limits), sent
// streamed so the first token is timed directly (the product's own request is
// not streamed; the server does the same work either way). The stream also
// carries the server's own prompt-progress events, which show when it took
// the request and how much of the prompt it found cached.
//
// Safety (the run refuses rather than risk anything live):
//   - it refuses to start, and stops mid-run, if ANY llama-server process other
//     than our own children exists (read-only ps; shells that merely mention
//     the name do not count);
//   - a second server (candidate B) is refused unless free memory stays above a
//     margin, and the run stops if the machine swaps more than a small amount
//     or reports critical memory pressure;
//   - every failure counts as INFINITE added delay and is logged, nothing is
//     discarded, and an unexpected server exit is recorded with its signal and
//     time (the product launcher's idle timer was the cause in round 2; see
//     --mode idle-test).
//
// Modes:
//   --mode quality   writer wording: how often the writer returns a usable question.
//   --mode ordinary  what server settings cost an ordinary answer with no
//                    writer: alternating blocks per configuration.
//   --mode pairs     paired, randomized CONTROL vs WRITER trials per phase,
//                    plus control-vs-control (A/A) pairs for the noise floor.
//   --mode idle-test why a harness that bypasses the model wrapper loses its
//                    server to the launcher's idle timer.
//   --analyze <json> summary table and per-phase verdict.
//
//   --real-writer    (pairs mode, C4b) the WRITER arm is the shipped writer:
//                    runConsultWriter on a createConsultWriterServer process
//                    (src/core/consult-writer.ts; its own llama-server on the
//                    same model file, --parallel 1, batch 64, SIGKILLed on
//                    arrival exactly as the orchestrator's fresh-answer signal
//                    does), over the real prompt and token bound, with the
//                    product's memory rule. The real writer is not streamed,
//                    so phases are clock offsets as fractions of the calibrated
//                    writer wall time (prefill 0.25, generation 0.6, near_end
//                    0.85); it cannot be made to hang, so the `hung` phase is
//                    skipped and reported. --writer-start warm keeps the
//                    writer server between calls (the launcher restarts it
//                    after a kill); cold starts it per call.
//
// Measurement only: nothing in src/ imports this file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  answerPrivately,
  createBuiltInAnalystModel,
  type PrivateEvidenceItem,
} from '../src/core/analyst-built-in.ts';
import { QWEN35_4B, LLAMA_SERVER_RUNTIME } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import {
  builtInReasoningThreads,
  createLlamaServerHandle,
  llamaServerArguments,
  type LlamaServerEndpoint,
  type LlamaServerHandle,
  type LlamaServerLaunch,
} from '../src/workers/source-index/built-in-reasoning/server.ts';
import {
  CONSULT_WRITER_LIMITS,
  createConsultWriterServer,
  defaultConsultMemoryProbe,
  runConsultWriter,
  type ConsultWriterServer,
} from '../src/core/consult-writer.ts';

// ---------------------------------------------------------------------------
// Arguments

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const list = (value: string | undefined) => value?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];

const MODE = arg('mode') ?? 'pairs';
/** The shipped writer (C4b) as the WRITER arm; implies a separate writer server. */
const REAL_WRITER = process.argv.includes('--real-writer');
const N = Number(arg('n') ?? '5');
/** Pairs per phase whose fresh answer runs to completion (the rest stop at the first token). */
const FULL_N = Number(arg('full-n') ?? '2');
/** Control-versus-control pairs (the noise floor). */
const AA_N = Number(arg('aa-n') ?? '6');
const STATE = resolve(arg('state') ?? join(import.meta.dir, '..', '.measure', 'consult-m0'));
const OUT = resolve(arg('out') ?? join(STATE, `round2-${MODE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
const SEED = Number(arg('seed') ?? '20261006');
/** Extra arguments for the main (fresh-answer) server, appended after the product's. */
const MAIN_ARGS = list(arg('main-args'));
/** `same` (the writer uses the main server) or `separate` (its own server process). */
const WRITER_SERVER = REAL_WRITER ? 'separate' : (arg('writer-server') ?? 'same');
/** Extra arguments for a separate writer server. */
const WRITER_ARGS = list(arg('writer-args'));
/** `shared`: the writer request starts with the analyst's system prompt; `own`: its own system prompt (round 1). */
const WRITER_PREFIX = arg('writer-prefix') ?? 'shared';
/** `true`: the writer request is streamed with prompt-progress events (the server then notices a closed connection every batch). */
const WRITER_STREAM = (arg('writer-stream') ?? 'true') === 'true';
/**
 * On arrival of the fresh answer: `abort` the writer's request (as the jobs
 * engine does), `kill` its server through the launcher (SIGTERM, then SIGKILL
 * after 5 s; separate only), `sigkill` its server process directly (separate
 * only), or `none` (let it run; the writer is aborted once the fresh answer is done).
 */
const ON_ARRIVAL = arg('on-arrival') ?? 'abort';
/** Separate writer server: `warm` (kept running) or `cold` (started for each writer call, stopped after). */
const WRITER_START = arg('writer-start') ?? 'warm';
const PHASES = list(arg('phases') ?? 'just_started,prefill,generation,near_end,hung');
const WRITER_TARGET_TOKENS = Number(arg('writer-tokens') ?? '2040');
/** The writer's real deadline in the design (§A.7: 55-60 s); the hung phase runs the writer to it. */
const HUNG_DEADLINE_MS = Number(arg('hung-deadline-ms') ?? '60000');
/** --mode ordinary: configurations as `label=arg,arg;label=...` (empty args = the product's). */
const CONFIGS = (arg('configs') ?? 'product=').split(';').filter(Boolean).map((entry) => {
  const [label, args = ''] = entry.split('=');
  return { label: label!, args: list(args) };
});
const ROUNDS = Number(arg('rounds') ?? '2');
/** A second server may start only if the machine's free memory would stay above this percentage. */
const MIN_FREE_PCT_AFTER = Number(arg('min-free-pct-after') ?? '20');
/** Stop the run when the machine has swapped out more than this since the start (GB). */
const MAX_SWAPOUT_GB = Number(arg('max-swapout-gb') ?? '0.5');
/** Diagnostic: keep the MAIN server's own log at this path (replaces the product's --log-disable). */
const SERVER_LOG = arg('server-log');
/** Before each trial (and ordinary block) wait until the machine's 1-minute load average is at most this (other sessions' work competes for the same GPU and CPU). */
const MAX_LOAD = Number(arg('max-load') ?? '9');
/** ...but wait at most this long per trial; a trial that starts above the limit is flagged. */
const MAX_LOAD_WAIT_MS = Number(arg('max-load-wait-min') ?? '12') * 60_000;
/** A fresh answer that has no first token after this long counts as failed. */
const FIRST_TOKEN_TIMEOUT_MS = 120_000;

mkdirSync(STATE, { recursive: true });
process.env.TMPDIR = STATE;

// ---------------------------------------------------------------------------
// The installed model and server (read-only)

const realRoot = join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'openclaw', 'olympus', 'models', 'built-in-reasoning');
const MODEL_PATH = arg('model-path') ?? join(realRoot, QWEN35_4B.modelId, QWEN35_4B.file.name);
const runtimeDir = join(realRoot, `llama.cpp-${LLAMA_SERVER_RUNTIME.release}-darwin-arm64`);
const SERVER_PATH = (() => {
  try {
    const marker = JSON.parse(readFileSync(join(runtimeDir, 'olympus-runtime.json'), 'utf8')) as { serverPath?: string };
    return marker.serverPath ? join(runtimeDir, marker.serverPath) : '';
  } catch {
    return '';
  }
})();
if (!existsSync(MODEL_PATH) || !SERVER_PATH || !existsSync(SERVER_PATH)) {
  console.error('Built-in model or server not installed. Stopping; nothing is downloaded.');
  process.exit(2);
}
const WRITER_MODEL_PATH = arg('writer-model-path') ?? MODEL_PATH;
if (!existsSync(WRITER_MODEL_PATH)) {
  console.error(`Writer model file not on disk: ${WRITER_MODEL_PATH}. Stopping; nothing is downloaded.`);
  process.exit(2);
}

const scratchEnv: Record<string, string | undefined> = {
  ...process.env,
  HOME: STATE,
  TMPDIR: STATE,
  OLYMPUS_BUILT_IN_REASONING_DIR: join(STATE, 'built-in-reasoning'),
};

/** The product's launch for the built-in model (analyst-built-in.ts ensureServer). */
function productLaunch(modelPath: string, idleShutdownSeconds = 600): LlamaServerLaunch {
  return {
    serverPath: SERVER_PATH,
    modelPath,
    contextTokens: QWEN35_4B.contextTokens,
    gpu: true,
    threads: builtInReasoningThreads(),
    idleShutdownSeconds,
    startupTimeoutMs: 120_000,
  };
}

// ---------------------------------------------------------------------------
// Machine state (read-only: ps, sysctl, vm_stat, memory_pressure, footprint)

interface PsRow { pid: number; cpu: number; rssKb: number; command: string }
function psRows(): PsRow[] {
  const out = spawnSync('ps', ['-axo', 'pid=,%cpu=,rss=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout;
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), cpu: Number(match[2]), rssKb: Number(match[3]), command: match[4]! });
  }
  return rows;
}
/** Every llama-server process we ever started (pids), so "other" means someone else's. */
const ownPids = new Set<number>();
/** Executables named llama-server only: a shell whose arguments mention the name does not match. */
const isLlamaServer = (row: PsRow) => basename(row.command.split(/\s+/)[0] ?? '') === 'llama-server';
function otherLlamaServers(): PsRow[] {
  return psRows().filter((row) => isLlamaServer(row) && !ownPids.has(row.pid));
}
function liveOwnServers(): PsRow[] {
  return psRows().filter((row) => isLlamaServer(row) && ownPids.has(row.pid));
}

function vmPages(): Record<string, number> {
  const out = spawnSync('vm_stat', { encoding: 'utf8' }).stdout;
  const pages: Record<string, number> = {};
  for (const line of out.split('\n')) {
    const match = /^(.+?):\s+(\d+)\.?$/.exec(line.trim());
    if (match) pages[match[1]!] = Number(match[2]);
  }
  return pages;
}
const PAGE = 16_384;
/** The kernel's own free-memory figure (`memory_pressure`), the pressure level (1 normal, 2 warn, 4 critical) and swap. */
function memory(): { freePct: number; pressureLevel: number; headroomGb: number; swapouts: number; swapUsedMb: number } {
  const pages = vmPages();
  const headroom = ((pages['Pages free'] ?? 0) + (pages['Pages inactive'] ?? 0) + (pages['Pages purgeable'] ?? 0)) * PAGE;
  const freePct = Number(/free percentage:\s*(\d+)%/.exec(spawnSync('memory_pressure', { encoding: 'utf8' }).stdout)?.[1] ?? Number.NaN);
  const pressureLevel = Number(spawnSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' }).stdout.trim());
  const swapUsedMb = Number(/used = ([\d.]+)M/.exec(spawnSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).stdout)?.[1] ?? Number.NaN);
  return { freePct, pressureLevel, headroomGb: Math.round(headroom / 1e8) / 10, swapouts: pages.Swapouts ?? 0, swapUsedMb };
}
/** Resident memory (MB) of a process, from ps; and its physical footprint, from footprint(1). */
function processMemory(pid: number | undefined): { rssMb?: number; footprintMb?: number } {
  if (pid === undefined) return {};
  const rss = Number(spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());
  const fp = spawnSync('footprint', ['-p', String(pid)], { encoding: 'utf8' }).stdout;
  const match = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(fp);
  const footprintMb = match ? Number(match[1]) * (match[2] === 'GB' ? 1024 : match[2] === 'KB' ? 1 / 1024 : 1) : undefined;
  return { ...(Number.isFinite(rss) && rss > 0 ? { rssMb: Math.round(rss / 1024) } : {}), ...(footprintMb !== undefined ? { footprintMb: Math.round(footprintMb) } : {}) };
}
function snapshot(): Record<string, unknown> {
  return {
    at: new Date().toISOString(),
    loadavg: spawnSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).stdout.trim(),
    otherLlamaServers: otherLlamaServers().length,
    memory: memory(),
  };
}

const loadNow = () => Number(/\{\s*([\d.]+)/.exec(spawnSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).stdout)?.[1] ?? Number.NaN);
/** Waits until the 1-minute load is calm; returns the wait and whether it ended above the limit. */
async function waitCalm(): Promise<{ waitedMs: number; load: number; calm: boolean }> {
  const started = performance.now();
  let load = loadNow();
  while (load > MAX_LOAD && performance.now() - started < MAX_LOAD_WAIT_MS) {
    await new Promise((r) => setTimeout(r, 10_000));
    load = loadNow();
  }
  return { waitedMs: Math.round(performance.now() - started), load, calm: !(load > MAX_LOAD) };
}

/** Why the run must stop now, if it must. */
const swapStart = memory().swapouts;
function guard(): string | undefined {
  const others = otherLlamaServers();
  if (others.length > 0) return `another llama-server process exists (pid ${others.map((row) => row.pid).join(', ')}); run stopped, nothing signalled`;
  const mem = memory();
  const swappedGb = ((mem.swapouts - swapStart) * PAGE) / 1e9;
  if (swappedGb > MAX_SWAPOUT_GB) return `machine swapped out ${swappedGb.toFixed(2)} GB since the start; run stopped`;
  if (mem.pressureLevel >= 4) return 'memory pressure is critical; run stopped';
  return undefined;
}

// Refuse to run at all next to another model server (never when only analyzing saved results).
if (!process.argv.includes('--analyze')) {
  const others = otherLlamaServers();
  if (others.length > 0) {
    console.error(`Refusing to run: another llama-server process exists (pid ${others.map((row) => row.pid).join(', ')}). Nothing was started or signalled.`);
    process.exit(3);
  }
}

// ---------------------------------------------------------------------------
// Servers we start

const servers = new Set<LlamaServerHandle>();
const children = new Map<number, ChildProcess>();
/** Handles by endpoint, so every request can re-arm the launcher's idle timer (as the product's model wrapper does). */
const handleOf = new Map<string, LlamaServerHandle>();
/** Exit codes and signals of every server process we started (a crash shows here). */
const exits: Array<{ pid?: number; code: number | null; signal: string | null; at: string; upForMs: number }> = [];
function startHandle(launch: LlamaServerLaunch, extra: readonly string[], logPath?: string): LlamaServerHandle {
  const spawnImpl = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    let all = [...args, ...extra];
    if (logPath) all = [...all.filter((value) => value !== '--log-disable'), '--log-file', resolve(logPath), '--log-timestamps'];
    const child = spawn(command, all, options);
    const born = performance.now();
    if (child.pid !== undefined) {
      ownPids.add(child.pid);
      children.set(child.pid, child);
    }
    child.once('exit', (code, signal) => exits.push({ ...(child.pid !== undefined ? { pid: child.pid } : {}), code, signal, at: new Date().toISOString(), upForMs: Math.round(performance.now() - born) }));
    return child;
  }) as unknown as typeof spawn;
  const handle = createLlamaServerHandle(launch, { env: scratchEnv, spawnImpl });
  servers.add(handle);
  return handle;
}
async function running(handle: LlamaServerHandle): Promise<LlamaServerEndpoint> {
  const ep = await handle.ensureRunning();
  handleOf.set(ep.baseUrl, handle);
  return ep;
}
async function stopAll(): Promise<void> {
  await Promise.allSettled([...servers].map((handle) => handle.stop()));
  await realWriterServer?.kill().catch(() => undefined);
}
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void stopAll().finally(() => process.exit(130));
  });
}

async function post(ep: LlamaServerEndpoint, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  handleOf.get(ep.baseUrl)?.touch();
  return fetch(`${ep.baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ep.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

// ---------------------------------------------------------------------------
// Evidence and questions (fictional demo data in the repo)

const DEMO = join(import.meta.dir, '..', 'chatgpt-plugin', 'demo-data');
const demo = (file: string) => readFileSync(join(DEMO, file), 'utf8');
const EVIDENCE_CHARS = 1_000;
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
// Capture the product's exact request bodies (one product answer per question)

interface ChatBody { messages: Array<{ role: string; content: string }>; [key: string]: unknown }
const productBodies = new Map<string, ChatBody>();
let analystSystem = '';

async function captureProductBodies(main: LlamaServerHandle): Promise<void> {
  let captured: ChatBody | undefined;
  const tap = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/chat/completions')) captured = JSON.parse(String(init?.body ?? '{}')) as ChatBody;
    return fetch(input, init);
  }) as typeof fetch;
  const model = createBuiltInAnalystModel({
    env: scratchEnv,
    model: QWEN35_4B,
    fetchImpl: tap,
    waitForInstall: true,
    install: async () => ({ modelPath: MODEL_PATH, serverPath: SERVER_PATH, gpu: true }),
    createServer: () => main,
  });
  for (const question of QUESTIONS) {
    captured = undefined;
    await answerPrivately(question.question, question.evidence, {
      model, maxPromptBytes: 11_000, maxAnswerChars: 1_000, audit: false, evidenceFormat: 'compact',
    });
    if (!captured) throw new Error('no request captured');
    productBodies.set(question.id, captured);
  }
  analystSystem = productBodies.get('q1')!.messages[0]!.content;
}

// ---------------------------------------------------------------------------
// The fresh answer, streamed: direct first-token time

interface RawTimings { prompt_n?: number; prompt_ms?: number; predicted_n?: number; predicted_ms?: number; cache_n?: number }
interface Progress { total?: number; cache?: number; processed?: number; time_ms?: number }
interface FreshResult {
  question: string;
  /** Arrival to the first streamed content token. */
  firstTokenMs?: number;
  /** Arrival to the end of the answer (only when run to completion). */
  wallMs?: number;
  /** Arrival to the server starting on it: wall minus prompt and generation time (completion runs only). */
  startDelayMs?: number;
  /** Arrival to the server's first prompt-progress event (`return_progress`): when it took the request, measured directly. */
  firstProgressMs?: number;
  /** Arrival to the first streamed event of any kind. */
  firstEventMs?: number;
  /** The server's first progress event: total prompt tokens and how many were found cached. */
  progress?: Progress;
  timings?: RawTimings;
  completed: boolean;
  /** No first token: the answer failed (counts as infinite delay). */
  failed?: boolean;
  error?: string;
}

async function freshAnswer(ep: LlamaServerEndpoint, question: Question, toCompletion: boolean): Promise<FreshResult> {
  // Measurement-only additions: streaming, and prompt-progress events that show when the server started on it.
  const body = { ...productBodies.get(question.id)!, stream: true, return_progress: true };
  const controller = new AbortController();
  const started = performance.now();
  const result: FreshResult = { question: question.id, completed: false };
  const timer = setTimeout(() => controller.abort(), toCompletion ? 400_000 : FIRST_TOKEN_TIMEOUT_MS);
  try {
    const response = await post(ep, '/v1/chat/completions', body, controller.signal);
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const event = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }>; timings?: RawTimings; prompt_progress?: Progress };
        const now = Math.round(performance.now() - started);
        result.firstEventMs ??= now;
        if (event.prompt_progress !== undefined) {
          result.firstProgressMs ??= now;
          result.progress ??= event.prompt_progress;
        }
        if (result.firstTokenMs === undefined && event.choices?.[0]?.delta?.content) {
          result.firstTokenMs = Math.round(performance.now() - started);
          if (!toCompletion) {
            controller.abort();
            clearTimeout(timer);
            return result;
          }
        }
        if (event.timings) result.timings = event.timings;
      }
    }
    result.completed = true;
    result.wallMs = Math.round(performance.now() - started);
    const t = result.timings;
    if (t?.prompt_ms !== undefined && t.predicted_ms !== undefined) result.startDelayMs = Math.round(result.wallMs - t.prompt_ms - t.predicted_ms);
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError' && result.firstTokenMs !== undefined)) {
      result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  } finally {
    clearTimeout(timer);
  }
  if (result.firstTokenMs === undefined) result.failed = true;
  return result;
}

/** A previous fresh answer's cache state: the analyst system prompt cached, plus a short user turn. */
async function primer(ep: LlamaServerEndpoint, serial: number): Promise<void> {
  const response = await post(ep, '/v1/chat/completions', {
    messages: [{ role: 'system', content: analystSystem }, { role: 'user', content: `Primer ${serial}.` }],
    temperature: 0,
    max_tokens: 1,
  });
  if (!response.ok) throw new Error(`primer HTTP ${response.status}`);
  await response.text();
}

/** Another call on the shared server (like the tier sniffer): a different system prompt, ~300 tokens, one output token. */
async function foreignCall(ep: LlamaServerEndpoint, serial: number): Promise<void> {
  const system = `You classify one item into public, personal, private or secret. Reply with one word. Item ${serial}.\n${demo('docs/garden-bylaws.md')}\n${demo('notes/reading-list.md')}`;
  await (await post(ep, '/v1/chat/completions', {
    messages: [{ role: 'system', content: system }, { role: 'user', content: 'Classify.' }],
    temperature: 0,
    max_tokens: 1,
  })).text();
}

// ---------------------------------------------------------------------------
// The writer

/** Writer rules. With a shared prefix they go in the user turn, after the analyst's system prompt. */
const WRITER_RULES = [
  'NEW TASK. Do not answer the question again and do not use the reply format described above.',
  'Below are a user\'s question, an answer written from their private documents, and the points that answer could not find.',
  'Your job: write up to three short questions for an outside expert who knows nothing about this user. Each question asks for general background knowledge that would help with one of the points that could not be found.',
  'Rules: use only general words. Never include names, places, dates, amounts, addresses, account or reference numbers, or any other detail from the question or the answer. Each question is one sentence of at most 25 words and ends with a question mark.',
  'Reply with a JSON object {"consult": [questions]}. Reply {"consult": null} only when no point could be helped by general knowledge.',
].join('\n');
const OWN_SYSTEM = 'You write background questions for an outside model.';

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

interface WriterInput { id: string; question: string; answer: string; gaps: string[] }
const WRITER_INPUTS: WriterInput[] = [
  { id: 'w1', question: 'Summarize my money situation and what I still need to decide.', answer: [demo('mail/009-bank-notice.eml'), demo('docs/tax-notes-2025.md'), demo('notes/2026-09-02-budget-decision.md'), demo('docs/kitchen-renovation-plan.md'), demo('mail/006-contractor-quote.eml')].join('\n'), gaps: ['The interest rate on the loan is not given.', 'The overdraft fee policy is not stated.', 'Whether the tax estimate includes freelance expenses is unclear.', 'The contractor\'s payment schedule is not given.'] },
  { id: 'w2', question: 'What did the blood tests show and what should I do next?', answer: [demo('mail/008-lab-results.eml'), demo('notes/2026-09-20-clinic-visit.md')].join('\n'), gaps: ['What a low ferritin level usually means is not explained.', 'How long iron supplements usually take to work is not stated.'] },
  { id: 'w3', question: 'What does my lease say about renewal?', answer: [demo('docs/lease-summary.md'), demo('mail/001-sam-lease-renewal.eml'), demo('mail/002-sam-lease-followup.eml')].join('\n'), gaps: ['How much notice a landlord normally needs for a rent increase is not stated.', 'Whether the deposit earns interest is not given.'] },
  { id: 'w4', question: 'What does the insurer still need for my claim?', answer: [demo('docs/insurance-claim.md'), demo('mail/008-lab-results.eml')].join('\n'), gaps: ['What a referral letter usually has to contain is not stated.', 'How long claims usually take to be paid is not given.'] },
  { id: 'w5', question: 'Is the kitchen quote reasonable for my budget?', answer: [demo('docs/kitchen-renovation-plan.md'), demo('mail/006-contractor-quote.eml'), demo('docs/household-budget-2026.csv')].join('\n'), gaps: ['Typical payment schedules for renovation contracts are not given.', 'Whether the quote includes a contingency is unclear.'] },
  { id: 'w6', question: 'What should I prepare for the Lisbon trip?', answer: [demo('notes/2026-09-18-lisbon-itinerary.md'), demo('mail/007-flight-confirmation.eml')].join('\n'), gaps: ['Entry and passport rules for the trip are not stated.', 'Baggage allowance is not given.'] },
];

/**
 * Whether the writer's reply is a usable question set. Shape: JSON with
 * `consult` an array of 1-3 strings, each one sentence ending in "?" of at
 * most 25 words. Clean: no digit and no capitalised word other than the first
 * (a name or place, whether copied from the answer or inferred from it). Usable = shape and clean. A `null` reply is a
 * (legitimate) decline, counted separately.
 */
function judgeWriter(input: WriterInput, content: string | undefined): { parsed: boolean; declined: boolean; shapeOk: boolean; clean: boolean; usable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let value: unknown;
  try {
    value = (JSON.parse(content ?? '') as { consult?: unknown }).consult;
  } catch {
    return { parsed: false, declined: false, shapeOk: false, clean: false, usable: false, reasons: ['not JSON'] };
  }
  if (value === null) return { parsed: true, declined: true, shapeOk: false, clean: false, usable: false, reasons: ['declined (null)'] };
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || !value.every((q) => typeof q === 'string')) {
    return { parsed: true, declined: false, shapeOk: false, clean: false, usable: false, reasons: ['not 1-3 strings'] };
  }
  const source = `${input.question}\n${input.answer}\n${input.gaps.join('\n')}`;
  const sourceCaps = new Set(source.match(/\b[A-Z][a-z]{2,}\b/g) ?? []);
  let shapeOk = true;
  let clean = true;
  for (const question of value as string[]) {
    const words = question.trim().split(/\s+/);
    if (!question.trim().endsWith('?') || words.length > 25 || words.length < 4) {
      shapeOk = false;
      reasons.push(`shape: "${question.slice(0, 60)}"`);
    }
    if (/\d/.test(question)) {
      clean = false;
      reasons.push(`digit: "${question.slice(0, 60)}"`);
    }
    for (const word of words.slice(1)) {
      const bare = word.replace(/[^A-Za-z]/g, '');
      // Any capitalised word after the first is a proper noun (a name or a place, even one inferred from the answer such as a country).
      if (/^[A-Z][a-z]{2,}$/.test(bare)) {
        clean = false;
        reasons.push(sourceCaps.has(bare) ? `leak ${bare}` : `proper noun ${bare}`);
      }
    }
  }
  return { parsed: true, declined: false, shapeOk, clean, usable: shapeOk && clean, reasons };
}

function writerUser(input: WriterInput, serial: number, padding = ''): string {
  return [
    `Request ${String(serial).padStart(6, '0')}.`,
    `Question: ${input.question}`,
    `Answer:\n${input.answer.slice(0, 2_700)}`,
    `Could not find:\n- ${input.gaps.join('\n- ')}`,
    padding ? `Earlier answers on this topic:\n${padding}` : '',
  ].join('\n\n');
}
function writerMessages(user: string): Array<{ role: string; content: string }> {
  return WRITER_PREFIX === 'shared'
    ? [{ role: 'system', content: analystSystem }, { role: 'user', content: `${WRITER_RULES}\n\n${user}` }]
    : [{ role: 'system', content: OWN_SYSTEM }, { role: 'user', content: `${WRITER_RULES}\n\n${user}` }];
}

async function templatedTokens(ep: LlamaServerEndpoint, messages: Array<{ role: string; content: string }>): Promise<number> {
  const applied = await (await post(ep, '/apply-template', { messages })).json() as { prompt?: string };
  const tokens = await (await post(ep, '/tokenize', { content: applied.prompt ?? '', add_special: true })).json() as { tokens?: unknown[] };
  return tokens.tokens?.length ?? 0;
}

let writerPadding = '';
let writerTokens = 0;
/** Pads the timing writer (input w1) with earlier-answer text to the token target. */
async function sizeWriter(ep: LlamaServerEndpoint): Promise<void> {
  const extras = ['mail/001-sam-lease-renewal.eml', 'mail/002-sam-lease-followup.eml', 'mail/005-priya-budget.eml', 'docs/household-budget-2026.csv', 'docs/insurance-claim.md', 'mail/007-flight-confirmation.eml', 'notes/2026-09-18-lisbon-itinerary.md', 'docs/garden-bylaws.md'].map(demo).join('\n');
  const pool = extras + extras + extras;
  let low = 0;
  let high = pool.length;
  while (high - low > 8) {
    const mid = Math.floor((low + high) / 2);
    if (await templatedTokens(ep, writerMessages(writerUser(WRITER_INPUTS[0]!, 0, pool.slice(0, mid)))) <= WRITER_TARGET_TOKENS) low = mid;
    else high = mid;
  }
  writerPadding = pool.slice(0, low);
  writerTokens = await templatedTokens(ep, writerMessages(writerUser(WRITER_INPUTS[0]!, 0, writerPadding)));
}

interface WriterOutcome { completed: boolean; timings?: RawTimings; wallMs: number; error?: string; content?: string }
/** What the writer's stream has shown so far (streamed writers only): lets a phase be triggered by an event, not a clock. */
interface WriterState { processed: number; total: number; cache: number; tokens: number }
interface WriterRun { promise: Promise<WriterOutcome>; abort(): void; startedAt: number; state: WriterState }
let writerSerial = 0;

function startWriter(ep: LlamaServerEndpoint, hung: boolean, input: WriterInput = WRITER_INPUTS[0]!, padding = writerPadding): WriterRun {
  writerSerial += 1;
  const state: WriterState = { processed: 0, total: 0, cache: 0, tokens: 0 };
  const controller = new AbortController();
  const startedAt = performance.now();
  const promise = (async (): Promise<WriterOutcome> => {
    try {
      const response = await post(ep, '/v1/chat/completions', {
        messages: writerMessages(writerUser(input, writerSerial, padding)),
        temperature: 0,
        max_tokens: hung ? 4_000 : 160,
        // The hung stand-in ignores end-of-sequence, so it is still generating at its deadline, as a writer that never returns would be.
        ...(hung ? { ignore_eos: true } : { response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: WRITER_SCHEMA } } }),
        ...(WRITER_STREAM ? { stream: true, return_progress: true } : {}),
      }, controller.signal);
      if (WRITER_STREAM) {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let content = '';
        let timings: RawTimings | undefined;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
            const event = JSON.parse(line.slice(5)) as { choices?: Array<{ delta?: { content?: string } }>; timings?: RawTimings; prompt_progress?: Progress };
            const piece = event.choices?.[0]?.delta?.content ?? '';
            if (piece) state.tokens += 1;
            content += piece;
            if (event.prompt_progress) {
              state.processed = event.prompt_progress.processed ?? state.processed;
              state.total = event.prompt_progress.total ?? state.total;
              state.cache = event.prompt_progress.cache ?? state.cache;
            }
            if (event.timings) timings = event.timings;
          }
        }
        return { completed: true, ...(timings ? { timings } : {}), wallMs: Math.round(performance.now() - startedAt), ...(content ? { content } : {}) };
      }
      const payload = await response.json() as { timings?: RawTimings; choices?: Array<{ message?: { content?: string } }> };
      return {
        completed: true,
        ...(payload.timings ? { timings: payload.timings } : {}),
        wallMs: Math.round(performance.now() - startedAt),
        ...(payload.choices?.[0]?.message?.content ? { content: payload.choices[0].message.content } : {}),
      };
    } catch (error) {
      return { completed: false, wallMs: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.name : String(error) };
    }
  })();
  return { promise, abort: () => controller.abort(), startedAt, state };
}

// ---------------------------------------------------------------------------
// Helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
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
/** Quantile that treats Infinity (a failure) as a value: a rank that touches an Infinity is Infinity. */
function quantile(values: number[], q: number): number {
  const sorted = values.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low]!;
  const a = sorted[low]!;
  const b = sorted[high]!;
  if (!Number.isFinite(b)) return b;
  return a + (b - a) * (position - low);
}
const median = (values: number[]) => quantile(values, 0.5);
const show = (value: number) => (Number.isFinite(value) ? String(Math.round(value)) : Number.isNaN(value) ? 'NaN' : value > 0 ? 'INF' : '-INF');
const fmt = (values: number[]) => `${show(quantile(values, 0.5))} / ${show(quantile(values, 0.95))} [${show(Math.min(...values))}..${show(Math.max(...values))}] n=${values.length}`;

async function serverProps(ep: LlamaServerEndpoint): Promise<Record<string, unknown>> {
  try {
    const props = await (await fetch(`${ep.baseUrl}/props`, { headers: { authorization: `Bearer ${ep.token}` } })).json() as { total_slots?: number; default_generation_settings?: { n_ctx?: number } };
    return { totalSlots: props.total_slots, ctxPerSlot: props.default_generation_settings?.n_ctx };
  } catch {
    return {};
  }
}

const results: Record<string, unknown> = {
  mode: MODE,
  model: QWEN35_4B.modelId,
  runtime: LLAMA_SERVER_RUNTIME.release,
  argv: process.argv.slice(2),
  machine: {
    cpu: spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).stdout.trim(),
    memBytes: Number(spawnSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).stdout.trim()),
    macos: spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim(),
  },
  start: snapshot(),
};
const save = () => writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);

async function startMain(extra: readonly string[]): Promise<{ handle: LlamaServerHandle; ep: LlamaServerEndpoint; loadMs: number }> {
  const handle = startHandle(productLaunch(MODEL_PATH), extra, SERVER_LOG);
  const started = performance.now();
  const ep = await running(handle);
  return { handle, ep, loadMs: Math.round(performance.now() - started) };
}

// ---------------------------------------------------------------------------
// Modes

/** Writer wording: how often the writer returns a usable question set. */
async function qualityMode(): Promise<void> {
  const { ep, handle } = await startMain(MAIN_ARGS);
  await captureProductBodies(handle);
  const runs: unknown[] = [];
  const tally = { total: 0, parsed: 0, declined: 0, shapeOk: 0, clean: 0, usable: 0 };
  for (let round = 0; round < N; round += 1) {
    for (const input of WRITER_INPUTS) {
      const outcome = await startWriter(ep, false, input, '').promise;
      const judged = judgeWriter(input, outcome.content);
      tally.total += 1;
      tally.parsed += judged.parsed ? 1 : 0;
      tally.declined += judged.declined ? 1 : 0;
      tally.shapeOk += judged.shapeOk ? 1 : 0;
      tally.clean += judged.shapeOk && judged.clean ? 1 : 0;
      tally.usable += judged.usable ? 1 : 0;
      const tokens = await templatedTokens(ep, writerMessages(writerUser(input, 0)));
      runs.push({ input: input.id, round, tokens, ...judged, content: outcome.content, outputTokens: outcome.timings?.predicted_n, cachedTokens: outcome.timings?.cache_n });
      console.error(`Q ${input.id} r${round} ${judged.usable ? 'USABLE' : 'not usable'} ${tokens} tok ${judged.reasons.join('; ')} :: ${outcome.content?.slice(0, 200)}`);
    }
  }
  results.writerPrefix = WRITER_PREFIX;
  results.rules = WRITER_RULES;
  results.quality = { tally, runs };
  console.error(`writer usable ${tally.usable}/${tally.total} (parsed ${tally.parsed}, declined ${tally.declined}, shape ok ${tally.shapeOk}, shape+clean ${tally.clean})`);
}

/**
 * Why an earlier harness lost its server after about ten minutes: the product
 * launcher stops its server when no request has re-armed the idle timer, and
 * stopping a busy server escalates to SIGKILL after 5 s. A harness that talks
 * to the server directly never re-arms it (ensureRunning disarms the timer; only
 * touch() after a wrapped request arms it). This mode launches with a 20 s idle
 * timer, does NOT touch it, and keeps the server busy past the timer.
 */
async function idleTestMode(): Promise<void> {
  const handle = startHandle(productLaunch(MODEL_PATH, 20), []);
  const ep = await handle.ensureRunning(); // deliberately not registered for touch()
  handle.touch(); // what the model wrapper does after its one request: arms the idle timer
  const t0 = performance.now();
  const wall0 = Date.now();
  const controller = new AbortController();
  const busy = fetch(`${ep.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ep.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Count upward from 1 forever.' }], max_tokens: 4_000, ignore_eos: true, temperature: 0 }),
    signal: controller.signal,
  }).then((r) => r.text()).catch((error: unknown) => (error instanceof Error ? error.name : String(error)));
  while (performance.now() - t0 < 45_000 && exits.length === 0) await sleep(250);
  controller.abort();
  await busy;
  results.idleTest = { idleShutdownSeconds: 20, requestKeptServerBusyFromMs: 0, exits, firstExitAfterMs: exits[0] ? Date.parse(exits[0].at) - wall0 : undefined };
  console.error(`idle test: exits ${JSON.stringify(exits)}; first exit ${results.idleTest ? (results.idleTest as { firstExitAfterMs?: number }).firstExitAfterMs : '-'} ms after the request began`);
}

/** The product's own writer-style call: not streamed (private-answer-jobs aborts such a request through its AbortSignal). */
function startWriterNonStream(ep: LlamaServerEndpoint, hung: boolean): WriterRun {
  const controller = new AbortController();
  const startedAt = performance.now();
  writerSerial += 1;
  const promise = (async (): Promise<WriterOutcome> => {
    try {
      const response = await post(ep, '/v1/chat/completions', {
        messages: [{ role: 'system', content: OWN_SYSTEM }, { role: 'user', content: `${WRITER_RULES}\n\n${writerUser(WRITER_INPUTS[0]!, writerSerial, writerPadding)}` }],
        temperature: 0,
        max_tokens: hung ? 4_000 : 160,
        ...(hung ? { ignore_eos: true } : { response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: WRITER_SCHEMA } } }),
      }, controller.signal);
      await response.text();
      return { completed: true, wallMs: Math.round(performance.now() - startedAt) };
    } catch (error) {
      return { completed: false, wallMs: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.name : String(error) };
    }
  })();
  return { promise, abort: () => controller.abort(), startedAt, state: { processed: 0, total: 0, cache: 0, tokens: 0 } };
}

// ---------------------------------------------------------------------------
// The shipped writer (--real-writer)

let realWriterServer: ConsultWriterServer | undefined;
const realMemory = defaultConsultMemoryProbe();
/** The shipped writer's server on the same model file, through this script's tracked spawn (exits and pids recorded). */
function realWriter(): ConsultWriterServer {
  realWriterServer ??= createConsultWriterServer(
    { serverPath: SERVER_PATH, modelPath: WRITER_MODEL_PATH, gpu: true },
    {
      env: scratchEnv,
      warm: WRITER_START === 'warm',
      spawnImpl: ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
        const child = spawn(command, [...args, ...WRITER_ARGS], options);
        const born = performance.now();
        if (child.pid !== undefined) {
          ownPids.add(child.pid);
          children.set(child.pid, child);
        }
        child.once('exit', (code, signal) => exits.push({ ...(child.pid !== undefined ? { pid: child.pid } : {}), code, signal, at: new Date().toISOString(), upForMs: Math.round(performance.now() - born) }));
        return child;
      }) as unknown as typeof spawn,
    },
  );
  return realWriterServer;
}

/**
 * The shipped writer as a WriterRun: `abort()` is the orchestrator's
 * fresh-answer signal (the writer server is SIGKILLed at once, whatever stage
 * it is in). Not streamed, so `state` stays empty and phases are clock
 * offsets. `hung` cannot be produced; the caller skips that phase.
 */
function startRealWriter(input: WriterInput = WRITER_INPUTS[0]!): WriterRun {
  const controller = new AbortController();
  const startedAt = performance.now();
  const promise = runConsultWriter(
    { question: input.question, answer: input.answer, gaps: input.gaps },
    { server: realWriter(), memory: realMemory, kill: controller.signal, deadlineMs: CONSULT_WRITER_LIMITS.deadlineMs, keepWarm: WRITER_START === 'warm' },
  ).then((outcome): WriterOutcome => ({
    completed: outcome.kind === 'questions' || outcome.kind === 'declined',
    wallMs: Math.round(performance.now() - startedAt),
    ...(outcome.kind === 'questions' ? { content: JSON.stringify({ questions: outcome.questions }) } : {}),
    ...(outcome.kind === 'questions' || outcome.kind === 'declined' ? {} : { error: `${outcome.kind}:${outcome.reason}` }),
  }));
  return { promise, abort: () => controller.abort(), startedAt, state: { processed: 0, total: 0, cache: 0, tokens: 0 } };
}

/** What server settings cost an ordinary answer with no writer, in alternating blocks. */
async function ordinaryMode(): Promise<void> {
  const blocks: unknown[] = [];
  results.blocks = blocks;
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const config of CONFIGS) {
      const stop = guard();
      if (stop) { results.stopped = stop; console.error(stop); save(); return; }
      const calm = await waitCalm();
      const { handle, ep, loadMs } = await startMain(config.args);
      if (productBodies.size === 0) await captureProductBodies(handle);
      // Warm-up: first answer after load pays one-time setup.
      await primer(ep, 0);
      await freshAnswer(ep, QUESTIONS[4]!, false);
      await sizeWriter(ep);
      const block: Record<string, unknown> = { round, config: config.label, args: config.args, loadMs, loadAtStart: calm.load, loadWaitMs: calm.waitedMs, props: await serverProps(ep), memory: processMemory(handle.pid) };
      const afterPrimer: FreshResult[] = [];
      const afterForeign: FreshResult[] = [];
      let serial = 0;
      for (const question of QUESTIONS) {
        await primer(ep, (serial += 1));
        afterPrimer.push(await freshAnswer(ep, question, round === 0));
        await primer(ep, (serial += 1));
        await foreignCall(ep, serial);
        afterForeign.push(await freshAnswer(ep, question, false));
      }
      // Abort responsiveness, as the product does it today (a long request, not streamed, aborted by its client):
      // 3 aborts during prompt reading and 2 during generation; when does a waiting one-token request start?
      const aborts: Array<{ kind: string; startedAfterAbortMs: number }> = [];
      for (const [kind, hung, delayMs] of [['prefill', false, 3_000], ['prefill', false, 4_500], ['prefill', false, 6_000], ['generation', true, 17_000], ['generation', true, 19_000]] as const) {
        await primer(ep, (serial += 1));
        const run = startWriterNonStream(ep, hung);
        await sleep(delayMs);
        const abortedAt = performance.now();
        run.abort();
        const response = await post(ep, '/v1/chat/completions', { messages: [{ role: 'user', content: `Probe ${serial} ${kind}. Reply OK.` }], temperature: 0, max_tokens: 1 });
        const payload = await response.json() as { timings?: RawTimings };
        const wall = performance.now() - abortedAt;
        aborts.push({ kind, startedAfterAbortMs: Math.round(wall - (payload.timings?.prompt_ms ?? 0) - (payload.timings?.predicted_ms ?? 0)) });
        await run.promise;
      }
      Object.assign(block, { afterPrimer, afterForeign, aborts, snapshot: snapshot() });
      blocks.push(block);
      const ft = (rs: FreshResult[]) => median(rs.map((r) => r.firstTokenMs ?? Number.POSITIVE_INFINITY));
      console.error(`O r${round} ${config.label}: first token after primer ${show(ft(afterPrimer))} ms, after foreign call ${show(ft(afterForeign))} ms, abort→start ${aborts.map((a) => `${a.kind[0]}${a.startedAfterAbortMs}`).join('/')} ms`);
      save();
      await handle.stop();
      servers.delete(handle);
    }
  }
}

/** A phase's arrival point: a clock offset, or (streamed writers) an event: a fraction of the prompt read, or a count of output tokens. */
interface Phase { name: string; offsetMs: number; hung?: boolean; cold?: boolean; aa?: boolean; promptFraction?: number; outputTokens?: number }

/** Waits for the phase's point in the writer's own progress, so it holds whatever the machine's speed. */
async function waitForPhase(run: WriterRun, phase: Phase): Promise<void> {
  const hardStopAt = performance.now() + 240_000;
  for (;;) {
    const state = run.state;
    if (phase.promptFraction !== undefined && state.total > state.cache && (state.processed - state.cache) / (state.total - state.cache) >= phase.promptFraction) return;
    if (phase.outputTokens !== undefined && state.tokens >= phase.outputTokens) return;
    if (phase.promptFraction === undefined && phase.outputTokens === undefined) return;
    if (performance.now() > hardStopAt) return;
    await sleep(10);
  }
}

/** Paired, randomized CONTROL vs WRITER trials per phase, plus control-vs-control pairs. */
async function pairsMode(): Promise<void> {
  const random = rng(SEED);
  const main = await startMain(MAIN_ARGS);
  results.mainArgs = [...llamaServerArguments(productLaunch(MODEL_PATH), 0, '<token-file>'), ...MAIN_ARGS];
  results.mainProps = await serverProps(main.ep);
  await captureProductBodies(main.handle);
  await primer(main.ep, 0);
  await freshAnswer(main.ep, QUESTIONS[4]!, false);

  // The writer's server.
  let writerHandle: LlamaServerHandle | undefined;
  let writerEp: LlamaServerEndpoint | undefined;
  const writerLaunch = productLaunch(WRITER_MODEL_PATH);
  /** Refuses a second server unless the machine keeps its free memory (kernel free percentage) afterwards. */
  const memoryGate = (): string | undefined => {
    const mem = memory();
    const mainFootprintMb = (results.mainMemoryIdle as { footprintMb?: number } | undefined)?.footprintMb ?? 1_500;
    const afterPct = mem.freePct - (mainFootprintMb * 1_048_576 * 100) / (results.machine as { memBytes: number }).memBytes;
    if (!(afterPct >= MIN_FREE_PCT_AFTER)) return `free memory ${mem.freePct}% would fall to about ${afterPct.toFixed(1)}%, below ${MIN_FREE_PCT_AFTER}%; second server not started`;
    if (mem.pressureLevel >= 4) return 'memory pressure is critical; second server not started';
    return undefined;
  };
  results.memoryBefore = memory();
  results.mainMemoryIdle = processMemory(main.handle.pid);
  if (REAL_WRITER) {
    // The shipped writer owns its server (memory rule, start, kill).
    results.realWriter = true;
    results.writerArgs = ['(the shipped writer launch: consult-writer.ts)', ...WRITER_ARGS];
  } else if (WRITER_SERVER === 'separate') {
    const refuse = memoryGate() ?? guard();
    if (refuse) {
      results.refused = refuse;
      console.error(refuse);
      return;
    }
    results.writerArgs = [...llamaServerArguments(writerLaunch, 0, '<token-file>'), ...WRITER_ARGS];
    if (WRITER_START === 'warm') {
      writerHandle = startHandle(writerLaunch, WRITER_ARGS);
      const started = performance.now();
      writerEp = await running(writerHandle);
      results.writerStartupMs = Math.round(performance.now() - started);
      results.writerMemoryIdle = processMemory(writerHandle.pid);
      results.memoryWithWriterServer = memory();
    }
  } else {
    writerEp = main.ep;
  }
  // The analyst system prompt is the writer's prefix (shared) even on a separate server, so sizing is the same.
  if (!REAL_WRITER) {
    await sizeWriter(main.ep);
    results.writerPromptTokens = writerTokens;
  }

  // Calibrate the writer: three complete calls, each after a primer.
  const calib: WriterOutcome[] = [];
  for (let i = 0; i < 3; i += 1) {
    await primer(main.ep, 1000 + i);
    if (writerEp && writerEp !== main.ep) await primer(writerEp, 1000 + i);
    if (REAL_WRITER) {
      const outcome = await startRealWriter().promise;
      if (!outcome.completed) throw new Error(`the shipped writer did not complete during calibration: ${outcome.error ?? 'unknown'}`);
      calib.push(outcome);
    } else if (!writerEp) {
      // Cold separate servers are calibrated on a throwaway instance (also gives start-up time and memory).
      const refuse = memoryGate();
      if (refuse) throw new Error(refuse);
      const tmp = startHandle(writerLaunch, WRITER_ARGS);
      const t0 = performance.now();
      const tmpEp = await running(tmp);
      results.writerStartupMs = Math.round(performance.now() - t0);
      calib.push(await startWriter(tmpEp, false).promise);
      results.writerMemoryIdle = processMemory(tmp.pid);
      results.memoryWithWriterServer = memory();
      await tmp.stop();
      servers.delete(tmp);
    } else {
      calib.push(await startWriter(writerEp, false).promise);
    }
  }
  results.writerCalibration = calib;
  results.writerCalibrationJudged = calib.map((c) => judgeWriter(WRITER_INPUTS[0]!, c.content));
  // The shipped writer reports no server timings: its wall time stands in, split 40/60 between prompt and output.
  const W = median(calib.map((c) => c.wallMs));
  const P = REAL_WRITER ? W * 0.4 : median(calib.map((c) => c.timings?.prompt_ms ?? 0));
  const G = REAL_WRITER ? W * 0.6 : median(calib.map((c) => c.timings?.predicted_ms ?? 0));
  const O = median(calib.map((c) => c.timings?.predicted_n ?? 0));
  console.error(`writer: ${writerTokens} tok, cached ${calib.map((c) => c.timings?.cache_n).join('/')}, prefill ${Math.round(P)} ms, output ${calib.map((c) => c.timings?.predicted_n).join('/')} tok in ${Math.round(G)} ms; outputs ${calib.map((c) => c.content?.slice(0, 80)).join(' | ')}`);
  save();

  const streamed = WRITER_STREAM && !REAL_WRITER;
  const allPhases: Phase[] = [
    { name: 'just_started', offsetMs: 200 },
    // Streamed writers: arrival is triggered by the writer's own progress (half the prompt read; 40% and 85% of its output tokens).
    // Non-streamed writers (the shipped writer included) fall back to the calibrated clock.
    { name: 'prefill', offsetMs: Math.round(REAL_WRITER ? W * 0.25 : P * 0.5), ...(streamed ? { promptFraction: 0.5 } : {}) },
    { name: 'generation', offsetMs: Math.round(REAL_WRITER ? W * 0.6 : P + G * 0.4), ...(streamed ? { outputTokens: Math.max(1, Math.round(O * 0.4)) } : {}) },
    { name: 'near_end', offsetMs: Math.round(REAL_WRITER ? W * 0.85 : P + G * 0.85), ...(streamed ? { outputTokens: Math.max(2, Math.round(O * 0.85)) } : {}) },
    // The writer runs to its real deadline, then the fresh answer arrives and the writer is aborted.
    { name: 'hung', offsetMs: HUNG_DEADLINE_MS, hung: true },
    // Separate cold writer server: the fresh answer arrives while it loads the model.
    { name: 'loading', offsetMs: 300, cold: true },
    // Control against control: the noise floor.
    { name: 'aa', offsetMs: 0, aa: true },
  ];
  const phases = allPhases.filter((phase) => PHASES.includes(phase.name) || (phase.aa && AA_N > 0))
    // The shipped writer cannot be made to hang or started cold by this script; those phases are skipped and recorded.
    .filter((phase) => !(REAL_WRITER && (phase.hung || phase.cold)));
  if (REAL_WRITER) results.skippedPhases = allPhases.filter((phase) => phase.hung || phase.cold).map((phase) => phase.name);
  results.phases = phases;

  const trials: Array<{ phase: Phase; question: Question; full: boolean }> = [];
  for (const phase of phases) {
    const count = phase.aa ? AA_N : N;
    for (let i = 0; i < count; i += 1) trials.push({ phase, question: QUESTIONS[i % QUESTIONS.length]!, full: i < FULL_N });
  }
  const pairs: unknown[] = [];
  results.pairs = pairs;
  const failures: unknown[] = [];
  results.failures = failures;
  let serial = 2000;
  let done = 0;
  for (const [index, trial] of shuffle(trials, random).entries()) {
    const stop = guard();
    if (stop) {
      results.stopped = stop;
      console.error(stop);
      break;
    }
    // Recover from a dead main server (recorded; the pair that finds it dead is a failure, never discarded).
    let recovered: string | undefined;
    if (main.handle.pid === undefined) {
      recovered = `main server was gone before pair ${index + 1}`;
      failures.push({ at: new Date().toISOString(), pair: index + 1, kind: 'main server gone', exits: [...exits], snapshot: snapshot() });
      main.ep = await running(main.handle);
      if (WRITER_SERVER !== 'separate') writerEp = main.ep;
      await primer(main.ep, 0);
      await freshAnswer(main.ep, QUESTIONS[4]!, false);
    }
    const calm = await waitCalm();
    const pidAtStart = main.handle.pid;
    const before = snapshot();
    const order = random() < 0.5 ? ['control', 'writer'] as const : ['writer', 'control'] as const;
    const record: Record<string, unknown> = { phase: trial.phase.name, question: trial.question.id, full: trial.full, order, loadAtStart: calm.load, loadWaitMs: calm.waitedMs, ...(calm.calm ? {} : { loadAboveLimit: true }), ...(recovered ? { recovered } : {}) };
    let failure: string | undefined;
    try {
      for (const arm of order) {
        await primer(main.ep, (serial += 1));
        if (arm === 'control' || trial.phase.aa) {
          // The A/A phase runs two controls (the second is recorded as the "writer" arm).
          const fresh = await freshAnswer(main.ep, trial.question, trial.full);
          if (arm === 'control') record.control = fresh;
          else record.withWriter = { arrivedAtMs: 0, fresh };
          continue;
        }
        let ep = (writerEp ?? main.ep)!;
        let coldHandle: LlamaServerHandle | undefined;
        let run: WriterRun | undefined;
        let startedAt = performance.now();
        if (trial.phase.cold) {
          // Cold: start a writer server now; the fresh answer arrives while it loads.
          const refuse = memoryGate();
          if (refuse) throw new Error(refuse);
          coldHandle = startHandle(writerLaunch, WRITER_ARGS);
          running(coldHandle).catch(() => undefined);
          await sleep(trial.phase.offsetMs);
        } else {
          if (!REAL_WRITER && WRITER_SERVER === 'separate' && WRITER_START === 'cold') {
            const refuse = memoryGate();
            if (refuse) throw new Error(refuse);
            coldHandle = startHandle(writerLaunch, WRITER_ARGS);
            ep = await running(coldHandle);
          }
          run = REAL_WRITER ? startRealWriter() : startWriter(ep, trial.phase.hung === true);
          startedAt = run.startedAt;
          if (trial.phase.promptFraction !== undefined || trial.phase.outputTokens !== undefined) await waitForPhase(run, trial.phase);
          else await sleep(trial.phase.offsetMs - (performance.now() - startedAt));
        }
        const arrivedAtMs = Math.round(performance.now() - startedAt);
        const killTarget = trial.phase.cold ? coldHandle : ON_ARRIVAL === 'kill' ? (coldHandle ?? writerHandle) : undefined;
        let stopMs: number | undefined;
        let stopping: Promise<void> | undefined;
        // `abort` on the shipped writer is the orchestrator's fresh-answer signal: its server is SIGKILLed at once.
        if (ON_ARRIVAL === 'abort') run?.abort(); // as the jobs engine would: abort the request, free its own slot, start the fresh answer
        if (ON_ARRIVAL === 'sigkill') {
          const target = coldHandle ?? writerHandle;
          const child = target?.pid !== undefined ? children.get(target.pid) : undefined;
          const t0 = performance.now();
          if (child) {
            child.kill('SIGKILL');
            stopping = new Promise<void>((resolve) => child.once('exit', () => { stopMs = Math.round(performance.now() - t0); resolve(); }));
          }
        }
        if (killTarget) {
          const t0 = performance.now();
          stopping = killTarget.stop().then(() => { stopMs = Math.round(performance.now() - t0); });
          stopping.catch(() => undefined);
        }
        const fresh = await freshAnswer(main.ep, trial.question, trial.full);
        if (ON_ARRIVAL === 'none') run?.abort(); // cleanup only, after the fresh answer is done
        const writer = run ? await run.promise : undefined;
        await stopping?.catch(() => undefined);
        if (coldHandle) {
          await coldHandle.stop().catch(() => undefined);
          servers.delete(coldHandle);
        }
        if ((ON_ARRIVAL === 'kill' || ON_ARRIVAL === 'sigkill') && writerHandle && !coldHandle) {
          // Bring the warm writer server back for the next trial (not timed against any fresh answer).
          writerEp = await running(writerHandle);
        }
        record.withWriter = { arrivedAtMs, fresh, writer, ...(stopMs !== undefined ? { writerStopMs: stopMs } : {}) };
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    record.snapshot = snapshot();
    record.snapshotBefore = before;
    const killed = main.handle.pid !== pidAtStart;
    if (failure) record.failure = failure;
    if (killed) record.mainServerKilledDuringPair = true;
    const control = record.control as FreshResult | undefined;
    const withWriter = (record.withWriter as { fresh?: FreshResult } | undefined)?.fresh;
    if (failure || killed || !control || control.failed || !withWriter || withWriter.failed) {
      failures.push({ at: new Date().toISOString(), pair: index + 1, phase: trial.phase.name, question: trial.question.id, failure, killed, controlFailed: control?.failed ?? true, writerArmFailed: withWriter?.failed ?? true, controlError: control?.error, writerArmError: withWriter?.error, exits: [...exits] });
      console.error(`FAILURE pair ${index + 1} ${trial.phase.name} ${trial.question.id}: ${failure ?? ''} control ${control?.error ?? 'ok'} writer-arm ${withWriter?.error ?? 'ok'} killed=${killed}`);
    }
    pairs.push(record);
    done += 1;
    console.error(`T${done}/${trials.length} ${trial.phase.name} ${trial.question.id} ${order.join('>')} control ${control?.firstTokenMs}${control?.wallMs ? `/${control.wallMs}` : ''} | writer ${withWriter?.firstTokenMs}${withWriter?.wallMs ? `/${withWriter.wallMs}` : ''} (+${(withWriter?.firstTokenMs ?? Number.POSITIVE_INFINITY) - (control?.firstTokenMs ?? Number.NaN)}) took ${withWriter?.firstProgressMs}/${control?.firstProgressMs} cached ${withWriter?.progress?.cache ?? '-'}/${control?.progress?.cache ?? '-'}`);
    save();
  }
  results.mainServerExits = exits;
  results.memoryEnd = memory();
  results.mainMemoryEnd = processMemory(main.handle.pid);
  if (writerHandle) results.writerMemoryEnd = processMemory(writerHandle.pid);
}

// ---------------------------------------------------------------------------
// --analyze

interface PairRecord {
  phase: string; question: string; full: boolean;
  control?: FreshResult;
  withWriter?: { fresh?: FreshResult; writer?: WriterOutcome; writerStopMs?: number; arrivedAtMs: number };
  snapshot?: { otherLlamaServers?: number };
}
/** Added first-token delay of a pair; a failure on either side is infinite. */
function addedFirstToken(p: PairRecord): number {
  const c = p.control?.firstTokenMs;
  const w = p.withWriter?.fresh?.firstTokenMs;
  return c === undefined || w === undefined ? Number.POSITIVE_INFINITY : w - c;
}

function analyze(path: string): void {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`file ${path}; argv ${(data.argv as string[] | undefined)?.join(' ')}`);
  if (data.mode === 'ordinary') {
    const blocks = data.blocks as Array<{ config: string; round: number; afterPrimer: FreshResult[]; afterForeign: FreshResult[]; aborts: Array<{ kind?: string; startedAfterAbortMs: number }>; props: unknown; memory: unknown }>;
    const labels = [...new Set(blocks.map((b) => b.config))];
    for (const label of labels) {
      const group = blocks.filter((b) => b.config === label);
      const inf = (v: number | undefined) => v ?? Number.POSITIVE_INFINITY;
      const primerFirst = group.flatMap((b) => b.afterPrimer.map((r) => inf(r.firstTokenMs)));
      const foreignFirst = group.flatMap((b) => b.afterForeign.map((r) => inf(r.firstTokenMs)));
      const full = group.flatMap((b) => b.afterPrimer.filter((r) => r.completed));
      const speed = full.map((r) => (r.timings?.prompt_n ?? 0) / ((r.timings?.prompt_ms ?? 1) / 1000));
      const prefillAborts = group.flatMap((b) => b.aborts.filter((a) => (a.kind ?? 'prefill') === 'prefill').map((a) => a.startedAfterAbortMs));
      const genAborts = group.flatMap((b) => b.aborts.filter((a) => a.kind === 'generation').map((a) => a.startedAfterAbortMs));
      lines.push(`${label}: first token after primer ${fmt(primerFirst)}; after a foreign call ${fmt(foreignFirst)}; completion ${fmt(full.map((r) => r.wallMs ?? Number.POSITIVE_INFINITY))}; prompt read ${fmt(speed)} tok/s; abort(prefill)→next start ${fmt(prefillAborts)}${genAborts.length ? `; abort(generation)→next start ${fmt(genAborts)}` : ''}; props ${JSON.stringify(group[0]!.props)}; memory ${JSON.stringify(group.map((b) => b.memory))}`);
    }
    console.log(lines.join('\n'));
    return;
  }
  if (data.mode === 'quality') {
    const q = data.quality as { tally: Record<string, number> };
    lines.push(`writer quality (prefix ${data.writerPrefix}): ${JSON.stringify(q.tally)}`);
    console.log(lines.join('\n'));
    return;
  }
  if (data.mode === 'idle-test') {
    lines.push(JSON.stringify(data.idleTest));
    console.log(lines.join('\n'));
    return;
  }
  const all = (data.pairs as PairRecord[] | undefined) ?? [];
  const pairs = all.filter((p) => p.phase !== 'aa');
  const aa = all.filter((p) => p.phase === 'aa');
  const controls = pairs.map((p) => p.control?.firstTokenMs).filter((v): v is number => v !== undefined);
  lines.push(`Control first token ${fmt(controls)}`);
  if (aa.length > 0) {
    const diffs = aa.map((p) => (p.withWriter?.fresh?.firstTokenMs ?? Number.NaN) - (p.control?.firstTokenMs ?? Number.NaN)).filter(Number.isFinite);
    lines.push(`Noise floor, control vs control (second minus first) ${fmt(diffs)}; |difference| ${fmt(diffs.map(Math.abs))}`);
  }
  let allPass = true;
  const pooled: number[] = [];
  const pooledStart: number[] = [];
  for (const phase of [...new Set(pairs.map((p) => p.phase))]) {
    const group = pairs.filter((p) => p.phase === phase);
    const added = group.map(addedFirstToken);
    const full = group.filter((p) => p.withWriter?.fresh?.wallMs !== undefined && p.control?.wallMs !== undefined);
    const addedWall = full.map((p) => p.withWriter!.fresh!.wallMs! - p.control!.wallMs!);
    const kept = group.filter((p) => (p.withWriter?.fresh?.progress?.cache ?? 0) > 0 && (p.withWriter?.fresh?.progress?.cache ?? 0) >= (p.control?.progress?.cache ?? 1)).length;
    const stops = group.map((p) => p.withWriter?.writerStopMs).filter((v): v is number => v !== undefined);
    const tookAdded = group.map((p) => (p.withWriter?.fresh?.firstProgressMs ?? Number.POSITIVE_INFINITY) - (p.control?.firstProgressMs ?? 0));
    const failed = group.filter((p) => !Number.isFinite(addedFirstToken(p))).length;
    const ok = quantile(added, 0.5) <= 250 && quantile(added, 0.95) <= 1_000 && failed === 0;
    allPass &&= ok;
    pooled.push(...added);
    pooledStart.push(...tookAdded);
    lines.push(`${phase}: added first token ${fmt(added)}; server took it after (added) ${fmt(tookAdded)}; analyst prefix kept in ${kept}/${group.length}${full.length ? `; added completion ${fmt(addedWall)}` : ''}${stops.length ? `; writer stop ${fmt(stops)}` : ''}; failures ${failed} -> ${ok ? 'within' : 'OUTSIDE'}`);
  }
  lines.push(`Pooled added first token ${fmt(pooled)}; pooled server-took-it ${fmt(pooledStart)}`);
  const failures = (data.failures as unknown[] | undefined) ?? [];
  lines.push(`Failures logged (each counted as infinite delay): ${failures.length}. Server exits: ${JSON.stringify(data.mainServerExits ?? data.serverExits)}`);
  const judged = (data.writerCalibrationJudged as Array<{ usable: boolean }> | undefined) ?? [];
  if (judged.length > 0) lines.push(`Writer calibration calls usable: ${judged.filter((j) => j.usable).length}/${judged.length}`);
  lines.push(`Memory: before ${JSON.stringify(data.memoryBefore)}; main idle ${JSON.stringify(data.mainMemoryIdle)}; writer idle ${JSON.stringify(data.writerMemoryIdle)}; with writer ${JSON.stringify(data.memoryWithWriterServer)}; end ${JSON.stringify(data.memoryEnd)}; writer startup ${data.writerStartupMs ?? '-'} ms; props ${JSON.stringify(data.mainProps)}`);
  const loads = pairs.map((p) => (p as unknown as { loadAtStart?: number }).loadAtStart).filter((v): v is number => v !== undefined);
  if (loads.length > 0) lines.push(`Load average (1 min) at the start of each pair: ${fmt(loads)}; pairs started above the limit: ${pairs.filter((p) => (p as unknown as { loadAboveLimit?: boolean }).loadAboveLimit).length}`);
  const others = pairs.filter((p) => (p.snapshot?.otherLlamaServers ?? 0) > 0).length;
  lines.push(`Pairs with another llama-server on the machine: ${others}/${pairs.length}${data.stopped ? `; RUN STOPPED: ${data.stopped}` : ''}${data.refused ? `; REFUSED: ${data.refused}` : ''}`);
  lines.push(`VERDICT (every phase median <= 250 ms and p95 <= 1,000 ms, no failure, no reset): ${allPass ? 'PASS' : 'FAIL'}`);
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------

const analyzePath = arg('analyze');
if (analyzePath) {
  analyze(resolve(analyzePath));
} else {
  try {
    if (MODE === 'quality') await qualityMode();
    else if (MODE === 'ordinary') await ordinaryMode();
    else if (MODE === 'idle-test') await idleTestMode();
    else await pairsMode();
    results.end = snapshot();
  } catch (error) {
    results.crashed = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error('run failed:', error);
  } finally {
    await stopAll();
    results.serversStopped = [...servers].every((handle) => handle.pid === undefined);
    results.serverExits = exits;
    results.leftoverOwnServers = liveOwnServers().map((row) => row.pid);
    save();
    console.error(`results: ${OUT}; own servers still alive: ${liveOwnServers().length}`);
  }
}

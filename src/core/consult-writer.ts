// The consult writer: the one extra on-device model call that turns a
// finished private answer into at most three short outside questions (design
// docs/design/frontier-consult-lane.md §A.3 and §A.7, stage C4b).
//
// Scheduling (candidate B2, decided 2026-10-07 after M0): the writer runs on
// its OWN `llama-server` process, on the same model file as the answer server
// (mapped, so the weights are shared), with `--batch-size 64 --ubatch-size 64`
// and `--parallel 1` on its own loopback port. It is started on demand, or
// kept warm when memory allows, and it is KILLED (SIGKILL, never an HTTP
// abort) the moment a fresh private answer arrives or at its own deadline.
// The answer server is never aborted, signalled or reset by anything here.
//
// Memory rule (§A.7, owner decision in review round 1 of C4b): the writer
// server starts only if the machine's free memory stays at or above 20% after
// the writer's footprint (about 0.6 GB) and the kernel's memory pressure is
// not critical. The `warn` level is allowed: the owner's 24 GB Mac idles at
// `warn` with other processes' swap in use, and M0's B2 pairs were measured
// there; `critical` means the machine is already compressing and swapping
// hard, and a second model process would make the fresh answer wait. The
// residual: at `warn` a writer can add paging while it runs (one +7.7 s
// prefill pair out of four was seen under swapping in M0). Otherwise the
// consult is skipped; no consult is always acceptable.
//
// What the writer sees: the user's question, the first answer and its gaps,
// each bounded (§A.3), plus the rules below. Never the documents. The whole
// prompt is bounded to 2,048 model tokens, counted with the server's own
// tokenizer (`/apply-template` then `/tokenize`). Over the bound, or when the
// count is not available: no consult (no estimate stands in for the count).
//
// The mechanical subset of the writer rules is enforced after the fact by
// the outbound gate (consult-gate.ts): with the default options a country
// name such as "Portugal" (M0 round 2: implied by a Lisbon itinerary, never
// written in the answer) is an unknown word and is refused there. The rule
// against naming what the answer only implies lives in the prompt below.
//
// Process lifetime: the moment the writer's server process is started, an
// abort of the stop signal (a fresh answer, the deadline) SIGKILLs it, and
// the whole started lifetime is wrapped so the process is killed on every
// exit path, the tokenizer calls included.

import { execFileSync, spawn } from 'node:child_process';
import { freemem, platform as osPlatform, totalmem } from 'node:os';
import { fetchModelEndpoint } from './model-transport.ts';
import {
  builtInReasoningThreads,
  createLlamaServerHandle,
  type LlamaServerEndpoint,
  type LlamaServerHandle,
} from '../workers/source-index/built-in-reasoning/server.ts';

export const CONSULT_WRITER_LIMITS = Object.freeze({
  /** The user's question (§A.3). */
  questionChars: 1_000,
  /** The first answer (§A.3). */
  answerChars: 2_700,
  /** Its gaps: count and characters each (§A.3). */
  gaps: 4,
  gapChars: 300,
  /** The whole prompt, rules included, in model tokens; over it, no consult. */
  promptTokens: 2_048,
  /** `max_tokens` of the writer's reply. */
  maxOutputTokens: 160,
  maxQuestions: 3,
  maxQuestionWords: 25,
  minQuestionWords: 3,
  maxQuestionChars: 200,
  /** The writer's deadline; its process is killed at it (§A.3). */
  deadlineMs: 60_000,
  /** The writer server's physical footprint, for the memory rule (§A.7: about 0.6 GB). */
  footprintBytes: 600 * 1024 * 1024,
  /** Free memory that must remain after the footprint (§A.7). */
  minFreePercentAfter: 20,
  /** Context the writer server serves: the prompt bound plus the reply, with headroom. */
  contextTokens: 4_096,
  /** How long the writer server may take to load. */
  startupTimeoutMs: 60_000,
  /** Idle shutdown when started on demand, and when kept warm. */
  idleShutdownSeconds: 120,
  warmIdleShutdownSeconds: 600,
});

export interface ConsultWriterInput {
  readonly question: string;
  readonly answer: string;
  readonly gaps: readonly string[];
}

export interface ConsultWriterMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

/**
 * The writer's rules, condensed from docs/design/consult-writer-instructions.md
 * to fit the token bound beside the inputs. The full text stays in that
 * document; this is the loaded form.
 */
export const CONSULT_WRITER_SYSTEM = [
  'You are the local analyst. You have just answered a user\'s question from their private documents. That answer is final.',
  'You may now propose a consult: up to three short questions for an outside expert model that knows nothing about this user, asking for general background knowledge that would help with a point the answer could not find.',
  'What you write is sent as written, unreviewed, to an outside provider, and it costs money. If the answer is already good enough, or no general knowledge would help, propose nothing.',
  '',
  'Hard rules:',
  '- Never relay private content: no names of people, companies, products or projects, no places, employers, dates, amounts, addresses, account or reference numbers, titles, file names, health, legal or relationship details, and nothing quoted from the documents or the answer.',
  '- Never forward the user\'s words. Do not paraphrase their sentences; write every question yourself in plain generic language, asking for the information you need, not echoing the conversation.',
  '- Never name a place, person, organisation, product or event that the answer only implies, even when it is not written anywhere: a destination suggested by an itinerary, a country suggested by a city, a currency or a language, an employer suggested by a job title, a product suggested by its features. Ask about the class of thing instead ("entry rules most countries apply to visitors", not a country).',
  '- Name a country only when the answer genuinely depends on it, and never a city or region. Prefer the class of place or the mechanism.',
  '- Use bands and orders of magnitude, never exact figures, years or dates.',
  '- Ask for rules, thresholds, units, reference values and the traps between them, never for a verdict on this user\'s situation; the user applies the answer locally.',
  '- Each question must make sense coming from any stranger. If it carries any fact about the user beyond the topic itself, remove the fact or drop the question.',
  '',
  'Form:',
  '- Each question is one plain sentence on one line, at most 25 words and at most twelve content words, ending with a single question mark. Ordinary letters and spaces only: no line breaks, markup, code, links, slashes, mail addresses, handles, version strings, spelled-out letters or encoded strings.',
  '- Use ordinary dictionary words of the user\'s language, units, and standard abbreviations. Do not reuse wording between questions.',
  '- At most three questions, on one subject, and at most 600 bytes and 80 words in all.',
  '',
  'Reply with one JSON object and nothing else: {"questions": ["...", "..."]} with one to three questions, or {"questions": null} to propose nothing.',
].join('\n');

/** The reply schema: one to three strings, or null (propose nothing). */
export const CONSULT_WRITER_RESPONSE_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    questions: {
      anyOf: [
        { type: 'null' },
        {
          type: 'array',
          minItems: 1,
          maxItems: CONSULT_WRITER_LIMITS.maxQuestions,
          items: { type: 'string', maxLength: CONSULT_WRITER_LIMITS.maxQuestionChars },
        },
      ],
    },
  },
  required: ['questions'],
  additionalProperties: false,
});

/**
 * The writer's bounded inputs: the question, the answer and the gaps at the
 * §A.3 limits (cut at a code-point boundary; control characters removed).
 * Nothing else is ever in the prompt.
 */
export function boundConsultWriterInput(input: ConsultWriterInput): ConsultWriterInput {
  const clean = (text: unknown, max: number): string => (typeof text === 'string' ? Array.from(text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim()).slice(0, max).join('') : '');
  return Object.freeze({
    question: clean(input.question, CONSULT_WRITER_LIMITS.questionChars),
    answer: clean(input.answer, CONSULT_WRITER_LIMITS.answerChars),
    gaps: Object.freeze((Array.isArray(input.gaps) ? input.gaps : [])
      .map((gap) => clean(gap, CONSULT_WRITER_LIMITS.gapChars))
      .filter(Boolean)
      .slice(0, CONSULT_WRITER_LIMITS.gaps)),
  });
}

/** The writer's messages: the rules, then the bounded question, answer and gaps. */
export function buildConsultWriterPrompt(input: ConsultWriterInput): readonly ConsultWriterMessage[] {
  const bounded = boundConsultWriterInput(input);
  const user = [
    `Question: ${bounded.question}`,
    `Answer:\n${bounded.answer}`,
    bounded.gaps.length > 0 ? `Could not find:\n- ${bounded.gaps.join('\n- ')}` : 'Could not find: (the answer was marked incomplete without listing points)',
  ].join('\n\n');
  return Object.freeze([
    Object.freeze({ role: 'system' as const, content: CONSULT_WRITER_SYSTEM }),
    Object.freeze({ role: 'user' as const, content: user }),
  ]);
}

export type ConsultWriterReply =
  | { readonly kind: 'questions'; readonly questions: readonly string[] }
  | { readonly kind: 'declined' }
  | { readonly kind: 'invalid'; readonly reason: 'not_json' | 'shape' | 'form' };

/** Parses and checks the writer's reply against the form rules; a reply that breaks any rule is invalid as a whole. */
export function parseConsultWriterReply(text: string): ConsultWriterReply {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { kind: 'invalid', reason: 'not_json' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { kind: 'invalid', reason: 'not_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'invalid', reason: 'shape' };
  const questions = (parsed as Record<string, unknown>).questions;
  if (questions === null) return { kind: 'declined' };
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > CONSULT_WRITER_LIMITS.maxQuestions) return { kind: 'invalid', reason: 'shape' };
  if (!questions.every((question): question is string => typeof question === 'string')) return { kind: 'invalid', reason: 'shape' };
  const cleaned: string[] = [];
  for (const raw of questions) {
    const question = raw.trim();
    if (!question || question.length > CONSULT_WRITER_LIMITS.maxQuestionChars) return { kind: 'invalid', reason: 'form' };
    if (/[\r\n\t\u0000-\u001F\u007F]/.test(question)) return { kind: 'invalid', reason: 'form' };
    if (!question.endsWith('?') || question.indexOf('?') !== question.length - 1) return { kind: 'invalid', reason: 'form' };
    const words = question.split(/\s+/);
    if (words.length > CONSULT_WRITER_LIMITS.maxQuestionWords || words.length < CONSULT_WRITER_LIMITS.minQuestionWords) return { kind: 'invalid', reason: 'form' };
    cleaned.push(question);
  }
  if (new Set(cleaned.map((question) => question.toLowerCase())).size !== cleaned.length) return { kind: 'invalid', reason: 'form' };
  return { kind: 'questions', questions: Object.freeze(cleaned) };
}

// ---------------------------------------------------------------------------
// Memory rule

export type ConsultMemoryPressure = 'normal' | 'warn' | 'critical' | 'unknown';

export interface ConsultMemorySample {
  readonly totalBytes: number;
  /** The kernel's own free-memory figure, in percent of total. */
  readonly freePercent: number;
  readonly pressure: ConsultMemoryPressure;
}

/** Reads the machine's memory state now; undefined when it cannot. */
export type ConsultMemoryProbe = () => ConsultMemorySample | undefined;

export type ConsultMemoryDecision =
  | { readonly ok: true; readonly freeAfterPercent: number }
  | { readonly ok: false; readonly reason: 'memory_unknown' | 'memory_low' | 'swap_pressure' };

/**
 * §A.7 with the owner's round-1 decision: start the writer server only if
 * free memory stays at or above 20% after its footprint and the kernel's
 * pressure level is not critical (`warn` is allowed; see the header).
 * Anything unknown refuses.
 */
export function consultWriterMemoryDecision(
  sample: ConsultMemorySample | undefined,
  footprintBytes: number = CONSULT_WRITER_LIMITS.footprintBytes,
): ConsultMemoryDecision {
  if (!sample || !Number.isFinite(sample.totalBytes) || sample.totalBytes <= 0 || !Number.isFinite(sample.freePercent)) {
    return { ok: false, reason: 'memory_unknown' };
  }
  if (sample.pressure === 'unknown') return { ok: false, reason: 'memory_unknown' };
  if (sample.pressure === 'critical') return { ok: false, reason: 'swap_pressure' };
  const freeAfterPercent = sample.freePercent - (footprintBytes / sample.totalBytes) * 100;
  if (freeAfterPercent < CONSULT_WRITER_LIMITS.minFreePercentAfter) return { ok: false, reason: 'memory_low' };
  return { ok: true, freeAfterPercent };
}

/**
 * macOS: `memory_pressure` reports the kernel's free percentage and
 * `kern.memorystatus_vm_pressure_level` its pressure level (1 normal, 2 warn,
 * 4 critical). Elsewhere the figures are taken from node:os with pressure
 * unknown, which the rule refuses (the built-in model ships for Apple
 * silicon only). Never throws.
 */
export function defaultConsultMemoryProbe(
  deps: { exec?: (file: string, args: readonly string[]) => string; platform?: string } = {},
): ConsultMemoryProbe {
  const exec = deps.exec ?? ((file: string, args: readonly string[]) => execFileSync(file, [...args], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }));
  const platform = deps.platform ?? osPlatform();
  return () => {
    try {
      const totalBytes = totalmem();
      if (platform !== 'darwin') {
        return { totalBytes, freePercent: (freemem() / totalBytes) * 100, pressure: 'unknown' };
      }
      const free = /free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(exec('/usr/bin/memory_pressure', []))?.[1];
      const level = Number(exec('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim());
      const pressure: ConsultMemoryPressure = level === 1 ? 'normal' : level === 2 ? 'warn' : level === 4 ? 'critical' : 'unknown';
      return { totalBytes, freePercent: free === undefined ? Number.NaN : Number(free), pressure };
    } catch {
      return undefined;
    }
  };
}

// ---------------------------------------------------------------------------
// The writer's own server process

export interface ConsultWriterLaunch {
  readonly serverPath: string;
  readonly modelPath: string;
  readonly gpu: boolean;
}

export interface ConsultWriterServer {
  /** Starts the server if needed (or reuses the warm one) and resolves with its endpoint. */
  ensure(signal?: AbortSignal): Promise<LlamaServerEndpoint>;
  /** SIGKILL now; resolves once the process is gone. Never signals any other process. */
  kill(): Promise<void>;
  /** Marks a request finished (re-arms the idle shutdown of a warm server). */
  touch(): void;
  readonly pid: number | undefined;
}

export interface ConsultWriterServerOptions {
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Keep the server warm between writer calls (longer idle shutdown); default on demand. */
  warm?: boolean;
  /** Test seam: the launcher factory. */
  createHandle?: typeof createLlamaServerHandle;
}

/**
 * The writer's `llama-server`: the same model file as the answer server, the
 * product's launcher flags (`--parallel 1`, `--batch-size 64 --ubatch-size 64`,
 * a random loopback port, a bearer token, idle shutdown) and SIGKILL as its
 * only stop signal.
 */
export function createConsultWriterServer(launch: ConsultWriterLaunch, options: ConsultWriterServerOptions = {}): ConsultWriterServer {
  const handle: LlamaServerHandle = (options.createHandle ?? createLlamaServerHandle)({
    serverPath: launch.serverPath,
    modelPath: launch.modelPath,
    gpu: launch.gpu,
    contextTokens: CONSULT_WRITER_LIMITS.contextTokens,
    threads: builtInReasoningThreads(),
    idleShutdownSeconds: options.warm ? CONSULT_WRITER_LIMITS.warmIdleShutdownSeconds : CONSULT_WRITER_LIMITS.idleShutdownSeconds,
    startupTimeoutMs: CONSULT_WRITER_LIMITS.startupTimeoutMs,
  }, {
    ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.env ? { env: options.env } : {}),
    immediateKill: true,
    stopGraceMs: 0,
  });
  return {
    ensure: (signal) => handle.ensureRunning(signal),
    kill: () => handle.stop(),
    touch: () => handle.touch(),
    get pid() {
      return handle.pid;
    },
  };
}

// ---------------------------------------------------------------------------
// One writer call

export type ConsultWriterOutcome =
  | { readonly kind: 'questions'; readonly questions: readonly string[]; readonly promptTokens: number; readonly ms: number }
  | { readonly kind: 'declined'; readonly promptTokens: number; readonly ms: number }
  | { readonly kind: 'skipped'; readonly reason: 'memory_unknown' | 'memory_low' | 'swap_pressure' | 'prompt_too_long' | 'prompt_tokens_unavailable' | 'no_runtime' }
  | { readonly kind: 'killed'; readonly reason: 'fresh_answer' | 'deadline' }
  | { readonly kind: 'failed'; readonly reason: 'start_failed' | 'request_failed' | 'not_json' | 'shape' | 'form' };

export interface ConsultWriterRunOptions {
  /** The writer's server; undefined when the model runtime is not installed (skipped, `no_runtime`). */
  readonly server: ConsultWriterServer | undefined;
  readonly memory: ConsultMemoryProbe;
  /** Aborted when a fresh private answer arrives: the writer process is killed at once. */
  readonly kill: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly deadlineMs?: number;
  /** Keep the server after the call (warm mode); default: stop it. */
  readonly keepWarm?: boolean;
  readonly now?: () => number;
}

/**
 * Runs the writer once over bounded inputs. Memory rule, then start (or
 * reuse) the writer server, then the exact token bound, then one JSON-schema
 * completion. From the moment the server is started, a fresh answer
 * (`kill`) or the deadline SIGKILLs the writer process at once, whatever
 * stage it is in, and every exit path kills it (on demand) or releases it
 * (warm). The answer server is never touched.
 */
export async function runConsultWriter(input: ConsultWriterInput, options: ConsultWriterRunOptions): Promise<ConsultWriterOutcome> {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = now();
  if (!options.server) return { kind: 'skipped', reason: 'no_runtime' };
  const server = options.server;
  const memory = consultWriterMemoryDecision(safeProbe(options.memory));
  if (!memory.ok) return { kind: 'skipped', reason: memory.reason };
  const messages = buildConsultWriterPrompt(input);
  const deadline = AbortSignal.timeout(options.deadlineMs ?? CONSULT_WRITER_LIMITS.deadlineMs);
  const stop = AbortSignal.any([options.kill, deadline]);
  const killedReason = (): 'fresh_answer' | 'deadline' => (options.kill.aborted ? 'fresh_answer' : 'deadline');
  let killing: Promise<void> | undefined;
  const killNow = (): Promise<void> => {
    killing ??= server.kill().catch(() => undefined);
    return killing;
  };
  // The stop signal kills the process the instant it fires, whatever this
  // function is awaiting (the start, the tokenizer, the completion).
  const onStop = () => void killNow();
  if (stop.aborted) return { kind: 'killed', reason: killedReason() };
  stop.addEventListener('abort', onStop, { once: true });
  let keep = false;
  try {
    let endpoint: LlamaServerEndpoint;
    try {
      endpoint = await server.ensure(stop);
    } catch {
      if (stop.aborted) return { kind: 'killed', reason: killedReason() };
      return { kind: 'failed', reason: 'start_failed' };
    }
    if (stop.aborted) return { kind: 'killed', reason: killedReason() };
    const promptTokens = await countWriterTokens(fetchImpl, endpoint, messages, stop);
    if (stop.aborted) return { kind: 'killed', reason: killedReason() };
    if (promptTokens === undefined) {
      keep = true;
      return { kind: 'skipped', reason: 'prompt_tokens_unavailable' };
    }
    if (promptTokens > CONSULT_WRITER_LIMITS.promptTokens) {
      keep = true;
      return { kind: 'skipped', reason: 'prompt_too_long' };
    }
    let text: string;
    try {
      text = await writerCompletion(fetchImpl, endpoint, messages, stop);
    } catch {
      if (stop.aborted) return { kind: 'killed', reason: killedReason() };
      keep = true;
      return { kind: 'failed', reason: 'request_failed' };
    }
    if (stop.aborted) return { kind: 'killed', reason: killedReason() };
    keep = true;
    const reply = parseConsultWriterReply(text);
    const ms = now() - startedAt;
    if (reply.kind === 'invalid') return { kind: 'failed', reason: reply.reason };
    if (reply.kind === 'declined') return { kind: 'declined', promptTokens, ms };
    return { kind: 'questions', questions: reply.questions, promptTokens, ms };
  } finally {
    stop.removeEventListener('abort', onStop);
    // On demand: the process goes after every call. Warm: it stays only after
    // a call that ended normally; a killed or failed process never does.
    if (options.keepWarm && keep && !stop.aborted) server.touch();
    else await killNow();
  }
}

function safeProbe(probe: ConsultMemoryProbe): ConsultMemorySample | undefined {
  try {
    return probe();
  } catch {
    return undefined;
  }
}

async function post(fetchImpl: typeof fetch, endpoint: LlamaServerEndpoint, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  return fetchModelEndpoint(fetchImpl, `${endpoint.baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

/** The prompt's token count by the server's own template and tokenizer, or undefined when either call fails. */
async function countWriterTokens(
  fetchImpl: typeof fetch,
  endpoint: LlamaServerEndpoint,
  messages: readonly ConsultWriterMessage[],
  signal: AbortSignal,
): Promise<number | undefined> {
  try {
    const templated = await post(fetchImpl, endpoint, '/apply-template', { messages }, signal);
    if (!templated.ok) return undefined;
    const { prompt } = await templated.json() as { prompt?: unknown };
    if (typeof prompt !== 'string') return undefined;
    const tokenized = await post(fetchImpl, endpoint, '/tokenize', { content: prompt, add_special: true }, signal);
    if (!tokenized.ok) return undefined;
    const { tokens } = await tokenized.json() as { tokens?: unknown };
    return Array.isArray(tokens) ? tokens.length : undefined;
  } catch {
    return undefined;
  }
}

async function writerCompletion(
  fetchImpl: typeof fetch,
  endpoint: LlamaServerEndpoint,
  messages: readonly ConsultWriterMessage[],
  signal: AbortSignal,
): Promise<string> {
  const response = await post(fetchImpl, endpoint, '/v1/chat/completions', {
    messages,
    temperature: 0,
    max_tokens: CONSULT_WRITER_LIMITS.maxOutputTokens,
    response_format: { type: 'json_schema', json_schema: { name: 'consult', schema: CONSULT_WRITER_RESPONSE_SCHEMA } },
  }, signal);
  if (!response.ok) throw new Error(`writer HTTP ${response.status}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('writer returned no text');
  return content;
}

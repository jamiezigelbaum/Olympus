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
// Two writers (owner decision 2026-10-10, docs/design/private-answers.md,
// "Writer: your own local model"):
//   - the built-in model (the default): the user's question, the first
//     answer and its gaps, each bounded (§A.3), plus the rules below; never
//     the documents. Its process lifecycle is described next.
//   - the owner's own model (consult.json `writer`: an OpenAI-compatible
//     server such as Ollama, LM Studio, a llama.cpp server or a home server):
//     the same inputs PLUS bounded excerpts of the evidence the answer read
//     (runOwnConsultWriter, at the end of this file). It reads the material
//     itself, decides whether an outside model would help, and writes the
//     question in its own words. It is an HTTP request the stop signal
//     aborts; there is no process here to kill.
// Both use the same rules, reply schema and form check, and the outbound
// gate runs after either at the chosen level.
//
// The built-in writer's prompt: the rules below and its inputs. The whole
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
import type { ConsultLevel } from './consult-gate.ts';
import type { EvidencePack } from './contracts.ts';
import { isCloudForwardingModelId } from './local-model-policy.ts';
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
  /**
   * The owner's own writer: excerpts of the evidence the answer read, at most
   * this many, each cut at `evidenceExcerptChars`, and at most
   * `evidenceChars` in all. The pack itself is already the fitted pack the
   * answer model received; these bounds only keep the writer's prompt short.
   */
  evidenceExcerpts: 12,
  evidenceExcerptChars: 1_500,
  evidenceChars: 12_000,
  /** `max_tokens` for the owner's own writer: room for a model that reasons before it replies. */
  ownWriterMaxOutputTokens: 2_048,
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
  /**
   * Excerpts of the evidence the answer read (consultWriterEvidence). Given
   * only to the owner's own writer; the built-in writer never sees them.
   */
  readonly evidence?: readonly string[];
}

export interface ConsultWriterMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

/**
 * What both levels share (owner decision 2026-10-10, after the live failure
 * of that day: a writer that saw only "the evidence does not contain the
 * letter of intent" asked the outside model whether "the document signed by
 * the landlord" mentions a notary, copying its prompt's single example and
 * asking about a document the outside model cannot see). Written as a short
 * skill: decide first, never ask about the user's documents, then write in
 * your own words. No single example to anchor on: several varied ones, each
 * a shape rather than a template. Full text and reasons:
 * docs/design/consult-writer-instructions.md.
 */
const CONSULT_WRITER_COMMON_HEAD = [
  'You are the user\'s own local model. You have read their private material and a first answer to their question. Decide whether a stronger outside model would help, and if so write up to three short questions for it.',
  'The outside model knows nothing about the user and never sees the documents, the evidence or the first answer: only your questions. They are sent as written, unreviewed, and each one costs money.',
  '',
  'Decide first. The outside model cannot find anything the user\'s material is missing; it can only reason more deeply and know more about the world.',
  '- Propose nothing when the material and the first answer already settle the question, or when what is missing is a fact only the user\'s own records could hold: what a particular paper says, whether something was signed, sent or paid, a date, a name or a figure.',
  '- Ask when the question needs deeper reasoning or outside knowledge on top of what the material shows: how a rule, requirement, process, term or practice works, how the facts you have fit together, or what usually happens in a situation like this one.',
  '- Never ask what the user\'s documents say, whether they mention or contain something, or for a document to be shared or uploaded: the outside model cannot see them. Never write "the document", "this letter" or "the contract" as if the reader had it; describe the kind of thing instead ("a signed letter of intent to buy a business").',
  '- Read the material to understand the situation, then write each question yourself, in plain words.',
];

const CONSULT_WRITER_COMMON_TAIL = [
  'Reply with one JSON object and nothing else: {"questions": ["...", "..."]} with one to three questions, or {"questions": null} to propose nothing.',
];

/**
 * The Strict level's rules (`general`): general questions only, nothing about
 * the user's situation leaves. Condensed from
 * docs/design/consult-writer-instructions.md to fit the built-in writer's
 * token bound beside its inputs.
 */
export const CONSULT_WRITER_SYSTEM = [
  ...CONSULT_WRITER_COMMON_HEAD,
  '',
  'Strict: ask only general questions; nothing about this user\'s situation leaves.',
  '- Never relay private content: no names of people, companies, products or projects, no places, employers, dates, amounts, account or reference numbers, titles, file names, health, legal or relationship details, and nothing quoted from the material, the answer or the user.',
  '- Never name a place, person, organisation or product that the material only implies: a country suggested by a city, a currency or a language, an employer suggested by a job title. Ask about the class of thing instead. Name a country only when the answer genuinely depends on it, and never a city or region.',
  '- Use bands and orders of magnitude, never exact figures, years or dates.',
  '- Ask for rules, thresholds, units and the traps between them, never for a verdict on this user\'s situation; the user applies the answer locally. Each question must make sense coming from any stranger.',
  '',
  'Form: each question is one plain sentence on one line, at most 25 words and at most twelve content words, ending with a single question mark. Ordinary words of the user\'s language only: no line breaks, markup, code, links, slashes, mail addresses, handles, version strings or spelled-out letters. At most three questions, on one subject, at most 600 bytes and 80 words in all; do not reuse wording between them.',
  '',
  'Shapes, not templates (never reuse their topics or words):',
  '- Missing: whether a new antibiotic clashes with a blood thinner. Ask: "Which interactions are usually checked when an antibiotic is prescribed with a blood thinner?"',
  '- Missing: when an employer must give a reason to end a fixed-term contract. Ask: "When must an employer state a reason to end a fixed-term contract early?"',
  '- Missing: how worrying a disk warning is. Ask: "What rising disk error counts usually mean a drive should be replaced soon?"',
  '- Missing: the booking reference itself. Propose nothing: only the user\'s own records hold it.',
  '',
  ...CONSULT_WRITER_COMMON_TAIL,
].join('\n');

/**
 * The Standard level's rules (`unnamed`, owner decision 2026-10-07): the
 * user's actual situation may be described and a verdict asked for, with
 * everything that names or locates the user removed and every unneeded
 * detail left out. Same reply shape and form limits as the Strict rules.
 */
export const CONSULT_WRITER_SYSTEM_UNNAMED = [
  ...CONSULT_WRITER_COMMON_HEAD,
  '',
  'Standard: you may describe the user\'s situation without anything that identifies them, and ask for a verdict on it.',
  '- Always remove names of people, companies, products, projects, schools and organisations, and employers: call each by its part ("the seller", "the employer", "the patient"); places smaller than a country (name a country only when the answer depends on it); exact dates and years; exact money amounts (use bands or relative terms: "a few thousand", "about two months\' pay"); addresses, account, reference, phone and ID numbers; file and document titles; anything quoted word for word.',
  '- Keep, when the question needs them: durations and rule numbers that define the problem, and health, legal, financial and relationship facts.',
  '- Leave out every detail the answer does not need, even an allowed one. Never keep a job, a rare condition and a region together unless the answer needs all three: together they can point to one person.',
  '- Never copy a phrase of five or more words from the material, the answer or the user.',
  '',
  'Form: each question is at most 25 words: at most one short sentence of situation, then a question of at most twelve content words, ending with a single question mark. Plain text only: no line breaks, markup, links, slashes, mail addresses, handles or codes. Ordinary words of the user\'s language. At most three questions, on one subject, at most 600 bytes in all.',
  '',
  'Shapes, not templates (never reuse their topics or words):',
  '- Missing: whether a new antibiotic clashes with a blood thinner. Ask: "A patient on a blood thinner was given an antibiotic for a chest infection. Which interactions matter?"',
  '- Missing: whether a dismissal needed a reason. Ask: "An employee on a fixed-term contract was let go during sick leave after eight months. Was a reason required?"',
  '- Missing: whether a buyer may cancel. Ask: "A buyer signed a reservation for a used car and the seller then raised the price. Can the buyer withdraw?"',
  '- Missing: the booking reference itself. Propose nothing: only the user\'s own records hold it.',
  '',
  ...CONSULT_WRITER_COMMON_TAIL,
].join('\n');

/** The writer's rules for a level: Strict (`general`) or Standard (`unnamed`). */
export function consultWriterSystem(level: ConsultLevel): string {
  return level === 'unnamed' ? CONSULT_WRITER_SYSTEM_UNNAMED : CONSULT_WRITER_SYSTEM;
}

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
  const evidence: string[] = [];
  let total = 0;
  for (const excerpt of Array.isArray(input.evidence) ? input.evidence : []) {
    if (evidence.length >= CONSULT_WRITER_LIMITS.evidenceExcerpts || total >= CONSULT_WRITER_LIMITS.evidenceChars) break;
    const text = clean(excerpt, Math.min(CONSULT_WRITER_LIMITS.evidenceExcerptChars, CONSULT_WRITER_LIMITS.evidenceChars - total));
    if (!text) continue;
    evidence.push(text);
    total += text.length;
  }
  return Object.freeze({
    question: clean(input.question, CONSULT_WRITER_LIMITS.questionChars),
    answer: clean(input.answer, CONSULT_WRITER_LIMITS.answerChars),
    gaps: Object.freeze((Array.isArray(input.gaps) ? input.gaps : [])
      .map((gap) => clean(gap, CONSULT_WRITER_LIMITS.gapChars))
      .filter(Boolean)
      .slice(0, CONSULT_WRITER_LIMITS.gaps)),
    ...(evidence.length > 0 ? { evidence: Object.freeze(evidence) } : {}),
  });
}

/**
 * Excerpts of the evidence the answer read, for the owner's own writer: each
 * candidate's title and chunk text in the pack's order, as plain lines. They
 * stay on this machine and the owner's own model server; the outbound gate
 * compares the writer's questions against the whole pack.
 */
export function consultWriterEvidence(pack: EvidencePack | undefined): string[] {
  const excerpts: string[] = [];
  for (const candidate of pack?.candidates ?? []) {
    const title = typeof candidate.provenance?.citation?.title === 'string' ? candidate.provenance.citation.title.trim() : '';
    for (const chunk of candidate.chunks ?? []) {
      if (typeof chunk !== 'string' || !chunk.trim()) continue;
      excerpts.push(title ? `${title}: ${chunk.trim()}` : chunk.trim());
      if (excerpts.length >= CONSULT_WRITER_LIMITS.evidenceExcerpts) return excerpts;
    }
  }
  return excerpts;
}

/** The writer's messages: the level's rules, then the bounded question, evidence (own writer only), answer and gaps. */
export function buildConsultWriterPrompt(input: ConsultWriterInput, level: ConsultLevel = 'general'): readonly ConsultWriterMessage[] {
  const bounded = boundConsultWriterInput(input);
  const user = [
    `Question: ${bounded.question}`,
    ...(bounded.evidence && bounded.evidence.length > 0
      ? [`Material the answer read (private: for your understanding only; the outside model never sees it, never quote it):\n${bounded.evidence.map((excerpt, index) => `[${index + 1}] ${excerpt}`).join('\n')}`]
      : []),
    `Answer:\n${bounded.answer}`,
    bounded.gaps.length > 0 ? `Could not find:\n- ${bounded.gaps.join('\n- ')}` : 'Could not find: (the answer was marked incomplete without listing points)',
  ].join('\n\n');
  return Object.freeze([
    Object.freeze({ role: 'system' as const, content: consultWriterSystem(level) }),
    Object.freeze({ role: 'user' as const, content: user }),
  ]);
}

export type ConsultWriterReply =
  | { readonly kind: 'questions'; readonly questions: readonly string[] }
  | { readonly kind: 'declined' }
  | { readonly kind: 'invalid'; readonly reason: 'not_json' | 'shape' | 'form' };

/** Parses and checks the writer's reply against the form rules; a reply that breaks any rule is invalid as a whole. */
export function parseConsultWriterReply(raw: string): ConsultWriterReply {
  // A model that reasons before it replies may wrap its reasoning in
  // <think>…</think>; only what follows is the reply.
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '');
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
  | { readonly kind: 'skipped'; readonly reason: 'memory_unknown' | 'memory_low' | 'swap_pressure' | 'prompt_too_long' | 'prompt_tokens_unavailable' | 'no_runtime' | 'cloud_model' }
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
  /** What the writer may send (the job's bound level); default the general level. */
  readonly level?: ConsultLevel;
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
  const messages = buildConsultWriterPrompt(input, options.level ?? 'general');
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

// ---------------------------------------------------------------------------
// The owner's own writer (consult.json `writer`)

/** Where the owner's writer runs: an OpenAI-compatible base URL and model, and the resolved key if any. */
export interface OwnConsultWriterEndpoint {
  /** Base URL, usually ending in `/v1`; `/chat/completions` is appended. */
  readonly baseUrl: string;
  readonly model: string;
  /** The resolved key; never logged, never in an outcome. */
  readonly apiKey?: string;
}

export interface OwnConsultWriterRunOptions {
  readonly endpoint: OwnConsultWriterEndpoint;
  /** Aborted when a fresh private answer arrives: the request is aborted at once. */
  readonly kill: AbortSignal;
  readonly deadlineMs: number;
  readonly level?: ConsultLevel;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Runs the owner's own writer once: one chat completion over the bounded
 * inputs, evidence included, with the same rules and reply schema as the
 * built-in writer. A server that rejects the JSON-schema response format is
 * asked once more without it (the reply is checked by the same parser
 * either way). No tokenizer is needed: the inputs are bounded by
 * characters. A model id with Ollama's cloud tag is refused (its daemon
 * forwards such a model off the machine, and this request carries private
 * evidence); no other model is refused.
 */
export async function runOwnConsultWriter(input: ConsultWriterInput, options: OwnConsultWriterRunOptions): Promise<ConsultWriterOutcome> {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = now();
  if (isCloudForwardingModelId(options.endpoint.model)) return { kind: 'skipped', reason: 'cloud_model' };
  const messages = buildConsultWriterPrompt(input, options.level ?? 'general');
  const deadline = AbortSignal.timeout(options.deadlineMs);
  const stop = AbortSignal.any([options.kill, deadline]);
  const killedReason = (): 'fresh_answer' | 'deadline' => (options.kill.aborted ? 'fresh_answer' : 'deadline');
  if (stop.aborted) return { kind: 'killed', reason: killedReason() };
  const url = `${options.endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.endpoint.apiKey) headers.authorization = `Bearer ${options.endpoint.apiKey}`;
  const request = async (structured: boolean): Promise<Response> => fetchModelEndpoint(fetchImpl, url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: options.endpoint.model,
      messages,
      temperature: 0,
      max_tokens: CONSULT_WRITER_LIMITS.ownWriterMaxOutputTokens,
      stream: false,
      ...(structured ? { response_format: { type: 'json_schema', json_schema: { name: 'consult', schema: CONSULT_WRITER_RESPONSE_SCHEMA } } } : {}),
    }),
    signal: stop,
  });
  let text: string;
  try {
    let response = await request(true);
    if (response.status === 400 || response.status === 422) {
      await response.body?.cancel().catch(() => undefined);
      response = await request(false);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return stop.aborted ? { kind: 'killed', reason: killedReason() } : { kind: 'failed', reason: 'request_failed' };
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return { kind: 'failed', reason: 'request_failed' };
    text = content;
  } catch {
    if (stop.aborted) return { kind: 'killed', reason: killedReason() };
    return { kind: 'failed', reason: 'request_failed' };
  }
  if (stop.aborted) return { kind: 'killed', reason: killedReason() };
  const reply = parseConsultWriterReply(text);
  const ms = now() - startedAt;
  if (reply.kind === 'invalid') return { kind: 'failed', reason: reply.reason };
  // No tokenizer for the owner's server: promptTokens is 0 (not counted).
  if (reply.kind === 'declined') return { kind: 'declined', promptTokens: 0, ms };
  return { kind: 'questions', questions: reply.questions, promptTokens: 0, ms };
}

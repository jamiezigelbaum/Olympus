// The built-in private analyst (`built_in`): a small local LLM that ships
// inside Olympus with zero setup. It answers Private-tier questions from
// Private evidence on this computer; nothing it reads or writes leaves the
// machine. It is an ordinary AnalystModel, so it runs the one generic Analyst
// prompt (answer from this evidence only, cite each claim, say what you could
// not find) — no per-question logic lives here.
//
// Mechanics: the pinned GGUF model and the official llama.cpp server are
// downloaded and checksum-verified on first use (progress in a status file the
// dashboard reads), then served by a loopback-only child process with a random
// port and bearer token, at low priority with capped threads, that exits when
// idle so its memory comes back.

import { totalmem } from 'node:os';
import {
  ANALYST_EVIDENCE_SCAFFOLDING_LABELS,
  analystPromptBytes,
  analystSchemaGapChars,
  createAnalyst,
  runWithAnalystAbortSignal,
  type AnalystEvidenceFormat,
  type AnalystModel,
  type AnalystModelCompletion,
  type AnalystModelRequest,
  type AnalystModelUsage,
} from './analyst.ts';
import type { Analyst, EvidenceCandidate, EvidencePack } from './contracts.ts';
import { OperationError } from './operation-error.ts';
import { fetchModelEndpoint, isModelEndpointRedirectError } from './model-transport.ts';
import { isZkapiDaemonEndpointRefusal } from './zkapi-consult-settings.ts';
import {
  installBuiltInReasoning,
  readBuiltInReasoningStatus,
  reportBuiltInReasoningState,
  BuiltInReasoningInstallError,
  type BuiltInReasoningInstallerOptions,
  type BuiltInReasoningStatus,
  type InstalledBuiltInReasoning,
} from '../workers/source-index/built-in-reasoning/install.ts';
import {
  pickBuiltInReasoningModel,
  runtimeArchiveFor,
  type BuiltInReasoningModelSpec,
} from '../workers/source-index/built-in-reasoning/manifest.ts';
import {
  builtInReasoningThreads,
  createLlamaServerHandle,
  LlamaServerStillExitingError,
  type LlamaServerHandle,
  type LlamaServerLaunch,
} from '../workers/source-index/built-in-reasoning/server.ts';

/** The analyst name the Private lane and the dashboard use for this model. */
export const BUILT_IN_ANALYST_NAME = 'built_in';
/** `on`, `off`, or unset (on for Apple-silicon Macs, off elsewhere). */
export const BUILT_IN_ANALYST_ENV = 'OLYMPUS_BUILT_IN_ANALYST';
/** `auto` (default), `small`, `standard`, `large`, or an exact model id. */
export const BUILT_IN_ANALYST_MODEL_ENV = 'OLYMPUS_BUILT_IN_ANALYST_MODEL';

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_IDLE_SHUTDOWN_SECONDS = 600;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;

export interface BuiltInAnalystModelOptions {
  env?: Record<string, string | undefined>;
  /** Overrides the memory-based pick. */
  model?: BuiltInReasoningModelSpec;
  totalMemoryBytes?: number;
  platform?: string;
  install?: (options: BuiltInReasoningInstallerOptions) => Promise<InstalledBuiltInReasoning>;
  createServer?: (launch: LlamaServerLaunch) => LlamaServerHandle;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  idleShutdownSeconds?: number;
  /**
   * Wait for a first-time download to finish instead of failing fast with
   * "still downloading". Interactive callers (the private-answer panel, the
   * benchmark) wait; the answer pool fails over and lets the install run on.
   */
  waitForInstall?: boolean;
}

export interface BuiltInAnalystModel extends AnalystModel {
  readonly name: typeof BUILT_IN_ANALYST_NAME;
  readonly spec: BuiltInReasoningModelSpec;
  /** Downloads and verifies the model and server if needed. Never throws. */
  prepare(): Promise<void>;
  status(): BuiltInReasoningStatus;
  /** Stops the model server process (it restarts on the next request). */
  stop(): Promise<void>;
  /**
   * The verified model file and server binary this model runs, once they are
   * installed in this process (undefined before that). The consult writer
   * starts its own server process on the same files (consult-writer.ts).
   */
  installedRuntime?(): InstalledBuiltInReasoning | undefined;
}

/**
 * Whether the built-in analyst may be offered on this machine: explicitly on
 * or off by env, otherwise on for Apple silicon (the Metal build) only, so a
 * Linux host never starts a multi-gigabyte download it did not ask for.
 */
export function builtInAnalystEnabled(
  env: Record<string, string | undefined> = process.env,
  platform = `${process.platform}-${process.arch}`,
): boolean {
  const raw = env[BUILT_IN_ANALYST_ENV]?.trim().toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') return false;
  if (!runtimeArchiveFor(platform)) return false;
  if (raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes') return true;
  return platform === 'darwin-arm64';
}

/** The model this machine gets, or undefined when it has too little memory. */
export function resolveBuiltInReasoningModel(
  env: Record<string, string | undefined> = process.env,
  totalMemoryBytes = totalmem(),
): BuiltInReasoningModelSpec | undefined {
  return pickBuiltInReasoningModel(totalMemoryBytes, env[BUILT_IN_ANALYST_MODEL_ENV]?.trim() || 'auto');
}

export interface BuiltInPrivateModelStatus extends BuiltInReasoningStatus {
  enabled: boolean;
  displayName?: string;
  downloadBytes?: number;
}

/**
 * What the dashboard shows for the built-in private model: whether it is on
 * for this machine, which model, and the install state from the status file
 * (`not_started` → `downloading` → `verifying` → `loading` → `ready`, or
 * `failed` with a reason). Reads files only; never starts a download.
 */
export function builtInPrivateModelStatus(
  env: Record<string, string | undefined> = process.env,
  totalMemoryBytes = totalmem(),
): BuiltInPrivateModelStatus {
  const spec = resolveBuiltInReasoningModel(env, totalMemoryBytes);
  const enabled = builtInAnalystEnabled(env) && spec !== undefined;
  if (!spec) {
    return {
      enabled: false,
      state: 'not_started',
      modelId: '',
      percent: 0,
      label: 'This computer does not have enough memory for the built-in private model',
      bytesDone: 0,
      bytesTotal: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    ...readBuiltInReasoningStatus(spec, env),
    enabled,
    displayName: spec.displayName,
    downloadBytes: spec.file.bytes,
  };
}

export function createBuiltInAnalystModel(options: BuiltInAnalystModelOptions = {}): BuiltInAnalystModel {
  const env = options.env ?? process.env;
  const totalMemoryBytes = options.totalMemoryBytes ?? totalmem();
  const spec = options.model ?? resolveBuiltInReasoningModel(env, totalMemoryBytes);
  if (!spec) {
    throw new OperationError(
      'config_error',
      'This computer does not have enough memory for the built-in private model.',
      'Use a local model service or Venice Private for Private answers.',
    );
  }
  const install = options.install ?? installBuiltInReasoning;
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const installerOptions: BuiltInReasoningInstallerOptions = {
    model: spec,
    env,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
  let installed: InstalledBuiltInReasoning | undefined;
  let installing: Promise<InstalledBuiltInReasoning> | undefined;
  let server: LlamaServerHandle | undefined;

  const ensureInstalled = (): Promise<InstalledBuiltInReasoning> => {
    if (installed) return Promise.resolve(installed);
    installing ??= install(installerOptions)
      .then((result) => {
        installed = result;
        return result;
      })
      .finally(() => {
        installing = undefined;
      });
    return installing;
  };

  const ensureServer = (paths: InstalledBuiltInReasoning): LlamaServerHandle => {
    server ??= (options.createServer ?? createLlamaServerHandle)({
      serverPath: paths.serverPath,
      modelPath: paths.modelPath,
      contextTokens: spec.contextTokens,
      gpu: paths.gpu,
      threads: builtInReasoningThreads(),
      idleShutdownSeconds: options.idleShutdownSeconds ?? DEFAULT_IDLE_SHUTDOWN_SECONDS,
      startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    });
    return server;
  };

  const model: BuiltInAnalystModel = {
    name: BUILT_IN_ANALYST_NAME,
    spec,
    async prepare() {
      try {
        const cached = installed !== undefined;
        await ensureInstalled();
        // A server that failed to start does not undo a verified install:
        // "Try again" re-arms it, and the next request starts the server.
        const status = readBuiltInReasoningStatus(spec, env);
        if (cached && status.state === 'failed' && status.failure?.reason === 'runtime_load_failed') {
          reportBuiltInReasoningState({ model: spec, env }, 'ready');
        }
      } catch {
        // The status file carries the failure for the dashboard.
      }
    },
    status() {
      return readBuiltInReasoningStatus(spec, env);
    },
    async stop() {
      await server?.stop();
    },
    installedRuntime() {
      return installed;
    },
    async complete(request: AnalystModelRequest): Promise<AnalystModelCompletion> {
      let paths = installed;
      if (!paths) {
        const pending = ensureInstalled();
        if (options.waitForInstall) {
          paths = await pending.catch((error: unknown) => {
            throw unavailable(error);
          });
        } else {
          pending.catch(() => undefined);
          const status = readBuiltInReasoningStatus(spec, env);
          throw new OperationError(
            'argus_unreachable',
            status.state === 'failed'
              ? `The built-in private model could not be installed: ${status.failure?.message ?? 'unknown error'}`
              : `The built-in private model is still downloading (${status.percent}%).`,
            'Private answers use the built-in model once its download finishes; nothing needs to be done.',
          );
        }
      }
      const handle = ensureServer(paths);
      let endpoint;
      try {
        if (!handle.pid) reportBuiltInReasoningState({ model: spec, env }, 'loading');
        endpoint = await handle.ensureRunning(request.signal);
        reportBuiltInReasoningState({ model: spec, env }, 'ready');
      } catch (error) {
        if (request.signal?.aborted) throw error;
        // An earlier server still exiting is transient: the model stays
        // available and the next request starts it once the old one is gone.
        if (error instanceof LlamaServerStillExitingError) {
          reportBuiltInReasoningState({ model: spec, env }, 'ready');
          throw unavailable(error);
        }
        reportBuiltInReasoningState({ model: spec, env }, 'failed', {
          reason: 'runtime_load_failed',
          message: error instanceof Error ? error.message : String(error),
        });
        throw unavailable(error);
      }
      try {
        return await chatCompletion(fetchImpl, endpoint, spec, request, requestTimeoutMs);
      } finally {
        handle.touch();
      }
    },
  };
  return model;
}

function unavailable(error: unknown): OperationError {
  if (error instanceof OperationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new OperationError(
    'argus_unreachable',
    error instanceof BuiltInReasoningInstallError
      ? `The built-in private model could not be installed: ${message}`
      : `The built-in private model is not available: ${message}`,
    'Check the dashboard for the built-in model status.',
  );
}

async function chatCompletion(
  fetchImpl: typeof fetch,
  endpoint: { baseUrl: string; token: string },
  spec: BuiltInReasoningModelSpec,
  request: AnalystModelRequest,
  timeoutMs: number,
): Promise<AnalystModelCompletion> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
  let response: Response;
  try {
    // Evidence and the server's bearer token ride this request: a redirect
    // is refused, never followed.
    response = await fetchModelEndpoint(fetchImpl, `${endpoint.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
        temperature: 0,
        max_tokens: maxTokensForChars(request.maxOutputChars),
        // Every Analyst-seam prompt asks for one JSON object; a grammar keeps
        // a small model from wrapping it in prose or truncating its syntax.
        // With a response schema the grammar also bounds each field, so the
        // object closes within the output budget.
        response_format: request.responseSchema
          ? { type: 'json_schema', json_schema: { name: 'reply', schema: request.responseSchema } }
          : { type: 'json_object' },
      }),
      signal,
    });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    // A zkAPI-daemon refusal is a configuration problem, not a slow machine.
    if (isZkapiDaemonEndpointRefusal(error)) throw error;
    if (isModelEndpointRedirectError(error)) {
      throw new OperationError(
        'argus_unreachable',
        'The built-in private model answered with a redirect, which is refused.',
        error.message,
      );
    }
    throw new OperationError(
      'argus_unreachable',
      `The built-in private model did not answer${error instanceof Error && error.name === 'TimeoutError' ? ` within ${Math.round(timeoutMs / 1000)}s` : ''}.`,
      'It runs on this computer; a busy machine answers slowly.',
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new OperationError(
      'argus_error',
      `The built-in private model returned HTTP ${response.status}.`,
      body.slice(0, 300) || undefined,
    );
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
    timings?: Record<string, unknown>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new OperationError('argus_error', 'The built-in private model returned no text.');
  }
  const usage = llamaUsage(payload.timings);
  return { text: content, modelId: `${BUILT_IN_ANALYST_NAME}/${spec.modelId}`, ...(usage ? { usage } : {}) };
}

/** llama-server's per-request `timings` (counts and milliseconds only). */
function llamaUsage(timings: Record<string, unknown> | undefined): AnalystModelUsage | undefined {
  if (!timings) return undefined;
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);
  const usage: AnalystModelUsage = {};
  const promptTokens = count(timings.prompt_n);
  const promptMs = count(timings.prompt_ms);
  const outputTokens = count(timings.predicted_n);
  const outputMs = count(timings.predicted_ms);
  if (promptTokens !== undefined) usage.promptTokens = promptTokens;
  if (promptMs !== undefined) usage.promptMs = promptMs;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (outputMs !== undefined) usage.outputMs = outputMs;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

// ~3 characters per token for prose; the JSON envelope and citation claims
// need headroom beyond the answer itself, with a floor so a tight budget never
// truncates the object.
function maxTokensForChars(chars: number | undefined): number {
  if (chars === undefined) return 1_024;
  return Math.max(512, Math.ceil(chars / 2));
}

// ---------------------------------------------------------------------------
// Fallback for the Private lane

/**
 * Wraps a configured local analyst so that, when its model service is not
 * running (unreachable, not slow), the built-in model answers instead. Both
 * run on this computer, so the trust boundary does not move. Any other failure
 * (a policy refusal, a bad answer, a timeout) surfaces unchanged.
 */
export function withBuiltInFallback(primary: Analyst, builtIn: Analyst): Analyst {
  return {
    async analyze(pack, options) {
      try {
        return await primary.analyze(pack, options);
      } catch (error) {
        if (!isLocalServiceDown(error)) throw error;
        return builtIn.analyze(pack, options);
      }
    },
  };
}

function isLocalServiceDown(error: unknown): boolean {
  return error instanceof OperationError
    && error.code === 'argus_unreachable'
    && !/timed out/i.test(error.message);
}

// ---------------------------------------------------------------------------
// answerPrivately: the private-answer panel's entry point

export interface PrivateEvidenceItem {
  /** Caller's stable id for the item; citations come back with it. */
  id: string;
  title?: string;
  /** The Private text the answer may use. */
  text: string;
  /** Where the item lives (path, message link); shown with the citation. */
  locator?: string;
  /** "Mail", "Notes", "Dropbox"… */
  source?: string;
  /** ISO date the item was written. */
  date?: string;
}

export interface PrivateAnswerCitation {
  id: string;
  title?: string;
  locator?: string;
  claim: string;
}

export interface PrivateAnswer {
  answer: string;
  citations: PrivateAnswerCitation[];
  /** What the evidence could not answer. */
  unanswered: string[];
  /** The model that wrote the answer, e.g. `built_in/qwen3.5-4b-q4_k_m-e87f176`. */
  modelId: string;
  /**
   * Internal metadata for the consult trigger and the outbound gate (design
   * frontier-consult-lane.md §A.2–A.3, stage C4b): the model's own verdict
   * on its answer and the exact evidence pack its main call received, after
   * relevance selection, depth reads and fitting. Never part of the answer
   * the panel shows; it stays in this process. Absent from a stub answer,
   * which then never triggers a consult.
   */
  consult?: PrivateAnswerConsultMetadata;
}

/** The model's verdict on its own answer, carried internally; never in the panel plaintext. */
export interface PrivateAnswerVerdict {
  /** The model's `"sufficient"` field: true when it called its answer complete; undefined when it did not say. */
  readonly sufficient: boolean | undefined;
  /** The answer is the fixed "these items do not answer" text (an ungrounded or failed answer). */
  readonly noAnswer: boolean;
}

export interface PrivateAnswerConsultMetadata {
  readonly verdict: PrivateAnswerVerdict;
  /** The fitted pack exactly as the main model call received it (deep-frozen). */
  readonly pack: EvidencePack;
}

export interface AnswerPrivatelyOptions {
  /** Defaults to one shared built-in model per process (waits for install). */
  model?: BuiltInAnalystModel;
  maxAnswerChars?: number;
  /** Ceiling on the main prompt's UTF-8 bytes; the evidence is fitted to it. */
  maxPromptBytes?: number;
  /**
   * The Analyst's second, audit pass over the draft (default on). It costs a
   * second full prompt; an interactive caller with a tight deadline turns it off.
   */
  audit?: boolean;
  /**
   * How the evidence is rendered for the model (createAnalyst's
   * evidenceFormat). `compact` suits the built-in small model reading a few
   * items; the default is the full rendering.
   */
  evidenceFormat?: AnalystEvidenceFormat;
  /** Called after each model call with its stage and timing (counts only, never content). */
  onModelCall?: (call: PrivateModelCallTiming) => void;
  signal?: AbortSignal;
}

/** One model call of answerPrivately: what it cost, never what it said. */
export interface PrivateModelCallTiming extends AnalystModelUsage {
  /** `main` is the answer; `audit` the optional second pass. */
  stage: 'main' | 'audit';
  ms: number;
  promptBytes: number;
  ok: boolean;
}

// The built-in model serves a 12,288-token context. The main prompt (system
// rules, evidence blocks, coverage) is held to this many UTF-8 bytes so the
// prompt and the answer both fit, even for text that tokenizes densely.
const DEFAULT_PRIVATE_ANSWER_PROMPT_BYTES = 28_000;
// Below this a passage stops carrying a usable sentence of context.
const MIN_PRIVATE_PASSAGE_BYTES = 600;

export const PRIVATE_ANSWER_NOT_FOUND = 'These private items do not answer this question.';

let sharedPanelModel: BuiltInAnalystModel | undefined;

/**
 * Answers `question` from `evidence` with the built-in model only. The
 * evidence is treated as Private (secure_local / S4): it never leaves this
 * computer, and an ungrounded answer is never escalated anywhere.
 */
export async function answerPrivately(
  question: string,
  evidence: readonly PrivateEvidenceItem[],
  options: AnswerPrivatelyOptions = {},
): Promise<PrivateAnswer> {
  const model = options.model ?? (sharedPanelModel ??= createBuiltInAnalystModel({ waitForInstall: true }));
  const pack = fitPrivatePack(
    privateEvidencePack(question, evidence),
    options.maxPromptBytes ?? DEFAULT_PRIVATE_ANSWER_PROMPT_BYTES,
    options.evidenceFormat ?? 'full',
  );
  // Whether the model called its own answer complete ("sufficient"): the
  // AnalystResult does not carry it, and the panel shows no gaps then.
  const verdict: { sufficient: boolean | undefined } = { sufficient: undefined };
  const analyst = createAnalyst(withVerdict(options.onModelCall ? timedModel(model, options.onModelCall) : model, verdict), {
    auditSuspiciousDrafts: options.audit ?? true,
    boundedResponseSchema: true,
    ...(options.evidenceFormat ? { evidenceFormat: options.evidenceFormat } : {}),
  });
  const run = () => analyst.analyze(pack, {
    localOnly: true,
    ...(options.maxAnswerChars !== undefined ? { maxAnswerChars: options.maxAnswerChars } : {}),
  });
  const result = options.signal
    ? await runWithAnalystAbortSignal(options.signal, run)
    : await run();
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const modelId = `${BUILT_IN_ANALYST_NAME}/${model.spec.modelId}`;
  const unanswered = result.unanswered.filter((line) => !echoesEvidenceScaffolding(line));
  const gapChars = analystSchemaGapChars(options.maxAnswerChars ?? DEFAULT_PRIVATE_ANSWER_CHARS);
  // An ungrounded local answer comes back as an escalation proposal. This
  // path never escalates, so the proposal is dropped and the panel is told
  // plainly that these items did not answer the question. An answer that
  // reproduces the evidence blocks' formatting (field labels, provenance
  // JSON) is a failed answer, not an answer, and is reported the same way.
  const frozenPack = deepFreeze(structuredClone(pack));
  if (result.escalation || echoesEvidenceScaffolding(result.answer)) {
    return {
      answer: PRIVATE_ANSWER_NOT_FOUND,
      citations: [],
      unanswered: cleanUnanswered(unanswered, '', { maxChars: gapChars, complete: false }),
      modelId,
      consult: Object.freeze({ verdict: Object.freeze({ sufficient: verdict.sufficient, noAnswer: true }), pack: frozenPack }),
    };
  }
  return {
    answer: result.answer,
    consult: Object.freeze({ verdict: Object.freeze({ sufficient: verdict.sufficient, noAnswer: false }), pack: frozenPack }),
    unanswered: cleanUnanswered(unanswered, result.answer, { maxChars: gapChars, complete: verdict.sufficient === true }),
    citations: result.citations.map((citation) => {
      const id = citation.provenance.sourceItem.providerItemId;
      const item = byId.get(id);
      return {
        id,
        ...(item?.title ? { title: item.title } : {}),
        ...(item?.locator ? { locator: item.locator } : {}),
        claim: citation.claim,
      };
    }),
    modelId,
  };
}

// The Analyst's default answer budget (analyst.ts), which sizes the schema's gaps when no budget is given.
const DEFAULT_PRIVATE_ANSWER_CHARS = 1_600;

/** Freezes a plain-data value and everything reachable from it (the consult snapshot is immutable). */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}

/** The model, recording whether its last reply called the answer complete (`"sufficient": true`). */
function withVerdict(model: AnalystModel, verdict: { sufficient: boolean | undefined }): AnalystModel {
  return {
    async complete(request) {
      const completion = await model.complete(request);
      verdict.sufficient = replySufficient(completion.text);
      return completion;
    },
  };
}

function replySufficient(text: string): boolean | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const sufficient = (parsed as Record<string, unknown>).sufficient;
    return typeof sufficient === 'boolean' ? sufficient : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The gaps worth showing beside an answer, each a complete statement of
 * something the answer does not give:
 * - none when the model called its answer complete;
 * - an entry that reached the schema's per-entry bound was cut off by the
 *   grammar mid-sentence, so it is dropped rather than shown half-said;
 * - an entry whose every specific word (names, numbers, dates; not the
 *   generic words a gap is phrased in) is in the answer restates what the
 *   answer already gives, so it is dropped, as is one with no specific word;
 * - repeats are dropped.
 * Text shape only: no question, source or kind of document is consulted.
 */
export function cleanUnanswered(
  gaps: readonly string[],
  answer: string,
  options: { maxChars: number; complete: boolean },
): string[] {
  if (options.complete) return [];
  const answered = new Set(specificTerms(answer).map(termStem));
  const answerText = answer.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of gaps) {
    const gap = raw.trim();
    if (!gap || gap.length >= options.maxChars - 1) continue;
    const terms = specificTerms(gap);
    if (terms.length === 0) continue;
    if (terms.every((term) => answered.has(termStem(term)) || answerText.includes(term))) continue;
    const key = gap.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out;
}

/** Lowercase words of a text that say something specific: not stop words, not a gap's generic phrasing. */
function specificTerms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.,/-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? [])
    .filter((word) => /\p{N}/u.test(word) || (word.length >= 3 && !GAP_GENERIC_WORDS.has(word)));
}

function termStem(word: string): string {
  return word.length > 4 && word.endsWith('es') ? word.slice(0, -2)
    : word.length > 3 && word.endsWith('s') ? word.slice(0, -1)
      : word;
}

// English function words and the words a gap is phrased in ("the specific
// value is not provided in the evidence"), none of which names a thing.
const GAP_GENERIC_WORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'from', 'that', 'this', 'these', 'those', 'not', 'any', 'all',
  'its', 'their', 'there', 'which', 'what', 'when', 'where', 'who', 'whom', 'how', 'why', 'does', 'did', 'has', 'have',
  'had', 'been', 'being', 'into', 'about', 'than', 'then', 'also', 'such', 'other', 'only', 'more', 'most', 'some',
  'can', 'could', 'would', 'should', 'may', 'might', 'will', 'shall', 'but', 'nor', 'yet', 'per', 'via', 'each',
  'your', 'you', 'user', 'his', 'her', 'our', 'they', 'them', 'one', 'out', 'over', 'under', 'between', 'within',
  'specific', 'exact', 'precise', 'actual', 'value', 'values', 'level', 'levels', 'number', 'numbers', 'amount',
  'detail', 'details', 'detailed', 'information', 'info', 'result', 'results', 'data', 'figure', 'figures',
  'provided', 'provide', 'evidence', 'found', 'find', 'missing', 'available', 'unavailable', 'mentioned', 'mention',
  'listed', 'list', 'given', 'give', 'stated', 'state', 'states', 'shown', 'show', 'shows', 'included', 'include',
  'includes', 'contain', 'contains', 'contained', 'reported', 'report', 'reports', 'document', 'documents', 'item',
  'items', 'text', 'source', 'sources', 'record', 'records', 'file', 'files', 'full', 'complete', 'entire', 'whole',
  'unknown', 'unclear', 'unspecified', 'specified', 'answer', 'question', 'none', 'no',
  // The reply's own field names, which a small model sometimes lists as a gap.
  'citations', 'citation', 'unanswered', 'sufficient', 'insufficient', 'claim', 'claims',
]);

/** The model, reporting each call's stage (the first is the answer, any later one the audit) and cost. */
function timedModel(model: AnalystModel, report: (call: PrivateModelCallTiming) => void): AnalystModel {
  let calls = 0;
  return {
    async complete(request) {
      const stage = calls === 0 ? 'main' : 'audit';
      calls += 1;
      const started = performance.now();
      const promptBytes = utf8.encode(request.system).length + utf8.encode(request.prompt).length;
      const done = (ok: boolean, usage?: AnalystModelUsage) => {
        try {
          report({ stage, ms: Math.round(performance.now() - started), promptBytes, ok, ...(usage ?? {}) });
        } catch {
          // A reporting hook never fails the answer.
        }
      };
      try {
        const completion = await model.complete(request);
        done(true, completion.usage);
        return completion;
      } catch (error) {
        done(false);
        throw error;
      }
    },
  };
}

/**
 * Whether model output reproduces the evidence blocks' scaffolding (their
 * field labels or provenance JSON keys). Output shape only: no question, no
 * source and no content is consulted.
 */
export function echoesEvidenceScaffolding(text: string): boolean {
  const normalized = text.toLowerCase().split(/\s+/).join(' ').split(' /').join('/').split('/ ').join('/').split(' :').join(':');
  return ANALYST_EVIDENCE_SCAFFOLDING_LABELS.some((label) => normalized.includes(label));
}

/**
 * The pack, fitted so the main prompt is at most maxPromptBytes: every
 * candidate keeps an equal share of passage bytes (in pack order, the most
 * relevant first); only when a share would fall below a usable passage are
 * trailing candidates left out. Measured on the real prompt, so labels and
 * escaping count.
 */
function fitPrivatePack(pack: EvidencePack, maxPromptBytes: number, format: AnalystEvidenceFormat): EvidencePack {
  const options = { localOnly: true };
  const promptBytes = (candidatePack: EvidencePack) => analystPromptBytes(candidatePack, options, format);
  if (promptBytes(pack) <= maxPromptBytes) return pack;
  for (let keep = pack.candidates.length; keep >= 1; keep -= 1) {
    const base = pack.candidates.slice(0, keep);
    const overhead = promptBytes({ ...pack, candidates: base.map((candidate) => ({ ...candidate, chunks: [] })) });
    if (overhead >= maxPromptBytes) continue;
    let share = Math.floor((maxPromptBytes - overhead) / keep);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (share < MIN_PRIVATE_PASSAGE_BYTES && keep > 1) break;
      const fitted = { ...pack, candidates: base.map((candidate) => ({ ...candidate, chunks: clipUtf8(candidate.chunks, share) })) };
      const bytes = promptBytes(fitted);
      if (bytes <= maxPromptBytes) return fitted;
      // Escaping made passages cost more than their raw bytes; shrink by the observed ratio.
      share = Math.floor(share * (maxPromptBytes - overhead) / Math.max(1, bytes - overhead)) - 1;
    }
  }
  return { ...pack, candidates: pack.candidates.slice(0, 1).map((candidate) => ({ ...candidate, chunks: clipUtf8(candidate.chunks, MIN_PRIVATE_PASSAGE_BYTES) })) };
}

const utf8 = new TextEncoder();

/** Whole chunks while they fit, then the next one cut at a code-point boundary. */
function clipUtf8(chunks: readonly string[], maxBytes: number): string[] {
  const kept: string[] = [];
  let remaining = Math.max(0, Math.floor(maxBytes));
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const bytes = utf8.encode(chunk).length;
    if (bytes <= remaining) {
      kept.push(chunk);
      remaining -= bytes;
      continue;
    }
    let cut = '';
    for (const codePoint of chunk) {
      const size = utf8.encode(codePoint).length;
      if (size > remaining) break;
      cut += codePoint;
      remaining -= size;
    }
    if (cut) kept.push(cut);
    break;
  }
  return kept;
}

export function privateEvidencePack(question: string, evidence: readonly PrivateEvidenceItem[]): EvidencePack {
  const candidates: EvidenceCandidate[] = evidence.map((item) => ({
    provenance: {
      sourceItem: {
        family: 'file',
        provider: 'private-answer',
        accountScope: 'local',
        providerItemId: item.id,
        localItemId: item.id,
      },
      citation: {
        ...(item.title ? { title: item.title } : {}),
        ...(item.source ? { sourceLabel: item.source } : {}),
        ...(item.locator ? { uri: item.locator } : {}),
        ...(item.date ? { authoredAt: item.date } : {}),
      },
    },
    trustTier: 'S4',
    trustDomain: 'secure_local',
    chunks: [item.text],
  }));
  return {
    question,
    candidates,
    coverage: { searchedCorpora: ['private-answer'], skippedCorpora: [], extractionGaps: [] },
    builtAt: new Date().toISOString(),
  };
}

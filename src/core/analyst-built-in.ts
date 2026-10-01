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
  createAnalyst,
  runWithAnalystAbortSignal,
  type AnalystModel,
  type AnalystModelCompletion,
  type AnalystModelRequest,
} from './analyst.ts';
import type { Analyst, EvidenceCandidate, EvidencePack } from './contracts.ts';
import { OperationError } from './operation-error.ts';
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
        await ensureInstalled();
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
    response = await fetchImpl(`${endpoint.baseUrl}/v1/chat/completions`, {
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
        response_format: { type: 'json_object' },
      }),
      signal,
    });
  } catch (error) {
    if (request.signal?.aborted) throw error;
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
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new OperationError('argus_error', 'The built-in private model returned no text.');
  }
  return { text: content, modelId: `${BUILT_IN_ANALYST_NAME}/${spec.modelId}` };
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
}

export interface AnswerPrivatelyOptions {
  /** Defaults to one shared built-in model per process (waits for install). */
  model?: BuiltInAnalystModel;
  maxAnswerChars?: number;
  signal?: AbortSignal;
}

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
  const pack = privateEvidencePack(question, evidence);
  const analyst = createAnalyst(model, { auditSuspiciousDrafts: true });
  const run = () => analyst.analyze(pack, {
    localOnly: true,
    ...(options.maxAnswerChars !== undefined ? { maxAnswerChars: options.maxAnswerChars } : {}),
  });
  const result = options.signal
    ? await runWithAnalystAbortSignal(options.signal, run)
    : await run();
  const byId = new Map(evidence.map((item) => [item.id, item]));
  return {
    // An ungrounded local answer comes back as an escalation proposal. This
    // path never escalates, so the proposal is dropped and the panel is told
    // plainly that these items did not answer the question.
    answer: result.escalation ? PRIVATE_ANSWER_NOT_FOUND : result.answer,
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
    unanswered: [...result.unanswered],
    modelId: `${BUILT_IN_ANALYST_NAME}/${model.spec.modelId}`,
  };
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

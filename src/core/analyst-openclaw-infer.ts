// OpenClaw-native cloud analyst transport.
//
// The cloud analyst reaches a frontier model through `openclaw infer model
// run` — the host's own inference surface — rather than a direct provider API
// call. This uses the model and auth OpenClaw already manages (the user's
// subscription or setup token), so there is NO metered API key and no separate
// credential to provision. It mirrors the existing CLI-bridge pattern (gog for
// email, whisper for transcription).
//
// Invocation:
//   openclaw infer model run [--model <provider/model>] --thinking <level> \
//     --json --prompt "<system>\n\n<prompt>"
// With no configured model, --model is omitted and OpenClaw resolves the
// configured agent model and its auth (native default, 2026-09-23: a hard-coded
// openai/gpt-5.5 failed every cited answer on hosts without OpenAI auth).
// stdout is a JSON object: { ok, provider, model, outputs: [{ text }] }, or
// { ok: false, error } on failure.

import { OperationError } from './operation-error.ts';
import { resolveOpenClawExecutable } from './openclaw-executable.ts';
import type { AnalystModel, AnalystModelCompletion, AnalystModelRequest } from './analyst.ts';

export interface OpenClawCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface OpenClawCommandRunner {
  run(command: string, args: string[], options?: { timeoutMs?: number }): Promise<OpenClawCommandResult>;
}

export interface OpenClawInferAnalystModelOptions {
  command?: string; // default 'openclaw'
  // provider/model passed verbatim as --model. Absent or blank = OpenClaw's
  // configured default model (no --model flag).
  model?: string | undefined;
  thinking?: string; // reasoning level, default 'high'
  timeoutMs?: number; // default 120000
  runner?: OpenClawCommandRunner;
}

const DEFAULT_COMMAND = 'openclaw';
// Trace/audit label for a run that uses OpenClaw's configured default model.
// Never passed to the CLI.
export const OPENCLAW_DEFAULT_MODEL_LABEL = 'openclaw-default';
const DEFAULT_THINKING = 'high';
const DEFAULT_TIMEOUT_MS = 120_000;
// Linux caps one argv element at MAX_ARG_STRLEN (128 KiB). A large evidence
// pack folded into --prompt reaches that, and execve then fails E2BIG with an
// opaque "could not be spawned" reason. Refusing above a conservative ceiling
// keeps the router's local fallback deterministic and the audit reason legible.
const MAX_PROMPT_BYTES = 100_000;

// Resolve the openclaw binary even under a minimal service PATH (launchd
// defaults omit /opt/homebrew/bin and /usr/local/bin; per-user npm installs
// live under ~/.local/bin).
function resolveOpenClawCommand(): string {
  return resolveOpenClawExecutable() ?? DEFAULT_COMMAND;
}

class SpawnOpenClawRunner implements OpenClawCommandRunner {
  async run(
    command: string,
    args: string[],
    options: { timeoutMs?: number } = {},
  ): Promise<OpenClawCommandResult> {
    const child = Bun.spawn([command, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timeout = options.timeoutMs
      ? setTimeout(() => child.kill(), options.timeoutMs)
      : undefined;
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, stdout, stderr };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export function createOpenClawInferAnalystModel(
  options: OpenClawInferAnalystModelOptions = {},
): AnalystModel {
  const command = options.command ?? resolveOpenClawCommand();
  const model = options.model?.trim() || undefined;
  const modelLabel = model ?? 'OpenClaw default model';
  const thinking = options.thinking ?? DEFAULT_THINKING;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = options.runner ?? new SpawnOpenClawRunner();

  return {
    async complete(request: AnalystModelRequest): Promise<AnalystModelCompletion> {
      // The infer CLI takes a single --prompt; fold the analyst system
      // instructions in ahead of the evidence prompt.
      //
      // Accepted argv exposure (2026-08-18): `openclaw infer model run` 2026.7.1
      // declares --prompt as a required option and never reads stdin, so the
      // evidence text is visible to same-host process listings for the life of
      // the child — the one place Olympus puts model input on a command line
      // (contrast secret-store.ts, which refuses a whole backend for this, and
      // the Telegram CLI bridge, which passes its payload on stdin). No
      // secure_local content reaches this lane. Switch to --prompt-file/stdin
      // once the upstream CLI offers one.
      const prompt = `${request.system}\n\n${request.prompt}`;
      const promptBytes = Buffer.byteLength(prompt, 'utf8');
      if (promptBytes > MAX_PROMPT_BYTES) {
        throw new OperationError(
          'source_index_error',
          'The analyst prompt is too large for the openclaw infer command line.',
          `${promptBytes} bytes exceeds the ${MAX_PROMPT_BYTES}-byte argv ceiling; request fewer results.`,
        );
      }
      const args = [
        'infer',
        'model',
        'run',
        ...(model ? ['--model', model] : []),
        '--thinking',
        thinking,
        '--json',
        '--prompt',
        prompt,
      ];
      let result: OpenClawCommandResult;
      try {
        result = await runner.run(command, args, { timeoutMs });
      } catch (error) {
        const code = spawnErrorCode(error);
        if (code === 'ENOENT') {
          throw new OpenClawInferError(
            `OpenClaw CLI not found on the worker PATH (${commandLabel(command)}).`,
            'Re-run olympus setup so the worker environment records the openclaw directory, or set OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_COMMAND to the absolute openclaw path.',
          );
        }
        // Spawn errors can quote argv, which carries the prompt: only the
        // categorical error code is ever surfaced.
        throw new OpenClawInferError(
          `OpenClaw inference could not start (model ${modelLabel})${code ? `: ${code}` : ''}.`,
          'Check the openclaw CLI on the worker host.',
        );
      }
      if (result.code !== 0) {
        const reason = describeInferFailure(result, request.prompt, modelLabel);
        throw new OpenClawInferError(
          `OpenClaw inference failed (exit ${result.code}, model ${modelLabel})${reason ? `: ${reason}` : ''}.`,
          model
            ? `Check that OpenClaw has auth for ${model}, or remove the explicit analyst model to use OpenClaw's configured default.`
            : 'Check OpenClaw\'s configured default model and its auth (openclaw models status).',
        );
      }
      let text: string;
      try {
        text = parseInferOutputText(result.stdout);
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        const reason = describeInferFailure(result, request.prompt, modelLabel);
        throw new OpenClawInferError(
          `OpenClaw inference failed (exit 0, model ${modelLabel}): ${reason || error.message}`,
          error.suggestion,
        );
      }
      return { text, modelId: model ?? resolvedModelId(result.stdout) ?? OPENCLAW_DEFAULT_MODEL_LABEL };
    },
  };
}

// stdout is a (possibly pretty-printed) JSON object, optionally preceded by
// human-facing noise. Extract the outermost object and read outputs[0].text.
export function parseInferOutputText(stdout: string): string {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new OperationError('source_index_error', 'openclaw infer returned no JSON object.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    throw new OperationError('source_index_error', 'openclaw infer JSON could not be parsed.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new OperationError('source_index_error', 'openclaw infer result was not an object.');
  }
  const record = parsed as { ok?: unknown; outputs?: unknown };
  if (record.ok === false) {
    throw new OperationError('source_index_error', 'openclaw infer reported ok=false.');
  }
  const outputs = record.outputs;
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new OperationError('source_index_error', 'openclaw infer result had no outputs.');
  }
  const first = outputs[0] as { text?: unknown };
  if (typeof first?.text !== 'string') {
    throw new OperationError('source_index_error', 'openclaw infer outputs[0].text was not a string.');
  }
  return first.text;
}

// A cloud-analyst failure whose message is bounded and secret-free: exit code,
// model label, and OpenClaw's own error code or first line after redaction.
// `safeReason` is the field the analyst route may log and surface; it never
// carries prompt text, evidence, or credentials.
export class OpenClawInferError extends OperationError {
  readonly safeReason: string;

  constructor(message: string, suggestion?: string) {
    super('source_index_error', message, suggestion);
    this.name = 'OpenClawInferError';
    this.safeReason = message;
  }
}

function spawnErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : undefined;
}

// The command is an operator-configured path, never request content; show only
// its basename so a home-directory path does not ride into answers.
function commandLabel(command: string): string {
  const base = command.split(/[\\/]/).pop() || command;
  return /^[A-Za-z0-9._-]{1,64}$/.test(base) ? base : 'openclaw';
}

const MAX_DETAIL_CHARS = 160;
// Echo detection compares letters and digits only, so whitespace, quoting,
// punctuation, case, and JSON escaping cannot disguise an echoed stretch.
const PROMPT_ECHO_WINDOW = 10;

function readInferJson(stdout: string): Record<string, unknown> | undefined {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function resolvedModelId(stdout: string): string | undefined {
  const record = readInferJson(stdout);
  const provider = typeof record?.provider === 'string' ? record.provider.trim() : '';
  const model = typeof record?.model === 'string' ? record.model.trim() : '';
  if (!model) return undefined;
  const id = provider && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model;
  return /^[A-Za-z0-9._:/@+-]{1,120}$/.test(id) ? id : undefined;
}

// Failure reason, most specific first. Known classes get a fixed message that
// carries no OpenClaw text at all; free text from OpenClaw's `--json` error or
// first stderr line is surfaced only when redacted, bounded, and proven not to
// echo the request (question + evidence).
function describeInferFailure(result: OpenClawCommandResult, evidence: string, modelLabel: string): string {
  const envelope = readInferJson(result.stdout)?.error;
  let errorCode = '';
  let errorText = '';
  if (typeof envelope === 'string') {
    errorText = envelope;
  } else if (envelope && typeof envelope === 'object') {
    const record = envelope as { code?: unknown; message?: unknown };
    if (typeof record.code === 'string') errorCode = record.code.trim();
    if (typeof record.message === 'string') errorText = record.message;
  }
  const haystack = `${errorCode}\n${errorText}\n${result.stderr}`.toLowerCase();

  if (result.code === 124 || result.code === 137 || result.code === 143) {
    return 'the run was terminated, likely by the analyst time budget';
  }
  if (/no api key|api key (?:is )?(?:missing|not found|not configured)|missing (?:api key|credentials?|auth)|no (?:configured |usable )?(?:auth|credentials?)|not authenticated|unauthori[sz]ed|\b401\b|invalid api key|auth(?:entication)? (?:failed|error|required)/.test(haystack)) {
    return `no usable auth for model ${modelLabel}`;
  }
  if (/unknown model|model not found|no such model|unsupported model|model .{0,40}not (?:found|available)/.test(haystack)) {
    return `OpenClaw does not recognize model ${modelLabel}`;
  }
  if (/\b429\b|rate[ -]?limit/.test(haystack)) {
    return 'the provider rate-limited the request';
  }
  if (errorCode && /^[A-Za-z][A-Za-z0-9_.-]{1,47}$/.test(errorCode) && !echoesEvidence(errorCode, evidence)) {
    return `OpenClaw error ${errorCode}`;
  }
  const line = errorText || (result.stderr.split(/\r?\n/).find((candidate) => candidate.trim()) ?? '');
  return safeInferDetail(line, evidence);
}

// Bounded, single-line, secret-redacted free text, withheld entirely if it
// echoes any stretch of the evidence.
export function safeInferDetail(raw: string, evidence: string): string {
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim()) ?? '';
  let detail = firstLine
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!detail) return '';
  if (echoesEvidence(detail, evidence)) return 'detail withheld because it echoed request content';
  detail = detail
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----.*/gi, '<redacted>')
    .replace(/\b(bearer)\s+[^\s,;]+/gi, '$1 <redacted>')
    .replace(
      /\b((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret|client[_ -]?secret|password|authorization)\s*[:=]\s*)["']?[^\s"',;]+/gi,
      '$1<redacted>',
    )
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{8,}/g, '<redacted>')
    .replace(/\bxox[abp]-[A-Za-z0-9-]{8,}/g, '<redacted>')
    .replace(/[A-Za-z0-9._~+/=-]{32,}/g, (token) => (/\d/.test(token) ? '<redacted>' : token));
  return detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS)}…` : detail;
}

// Letters and digits only, lower-cased, after undoing JSON string escapes, so
// "SSN\t123-45-6789", "SSN  123 45 6789" and "ssn123456789" compare equal.
function echoKey(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\[nrtbf]/g, ' ')
    .replace(/\\(.)/g, '$1')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function echoesEvidence(detail: string, evidence: string): boolean {
  const detailKey = echoKey(detail);
  const evidenceKey = echoKey(evidence);
  if (!detailKey || !evidenceKey) return false;
  if (detailKey.length < PROMPT_ECHO_WINDOW) return evidenceKey.includes(detailKey);
  for (let index = 0; index + PROMPT_ECHO_WINDOW <= detailKey.length; index += 1) {
    if (evidenceKey.includes(detailKey.slice(index, index + PROMPT_ECHO_WINDOW))) return true;
  }
  return false;
}

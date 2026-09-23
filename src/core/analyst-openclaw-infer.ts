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
        if (isCommandNotFound(error)) {
          throw new OpenClawInferError(
            `OpenClaw CLI not found on the worker PATH (${commandLabel(command)}).`,
            'Re-run olympus setup so the worker environment records the openclaw directory, or set OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_COMMAND to the absolute openclaw path.',
          );
        }
        const detail = safeInferDetail(error instanceof Error ? error.message : String(error), prompt);
        throw new OpenClawInferError(
          `OpenClaw inference could not start (model ${modelLabel})${detail ? `: ${detail}` : ''}.`,
          'Check the openclaw CLI on the worker host.',
        );
      }
      if (result.code !== 0) {
        const detail = inferFailureDetail(result, prompt);
        throw new OpenClawInferError(
          `OpenClaw inference failed (exit ${result.code}, model ${modelLabel})${detail ? `: ${detail}` : ''}.`,
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
        const detail = inferFailureDetail(result, prompt);
        throw new OpenClawInferError(
          `OpenClaw inference failed (exit 0, model ${modelLabel}): ${detail || error.message}`,
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

function isCommandNotFound(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown } | null | undefined;
  return record?.code === 'ENOENT'
    || /executable not found|ENOENT|no such file or directory/i.test(String(record?.message ?? ''));
}

// The command is an operator-configured path, never request content; show only
// its basename so a home-directory path does not ride into answers.
function commandLabel(command: string): string {
  const base = command.split(/[\\/]/).pop() || command;
  return /^[A-Za-z0-9._-]{1,64}$/.test(base) ? base : 'openclaw';
}

const MAX_DETAIL_CHARS = 160;
const PROMPT_ECHO_WINDOW = 24;

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

// OpenClaw's `--json` failure envelope carries `error` (a string or an object
// with code/message); otherwise fall back to the first non-blank stderr line.
function inferFailureDetail(result: OpenClawCommandResult, prompt: string): string {
  const error = readInferJson(result.stdout)?.error;
  let raw = '';
  if (typeof error === 'string') {
    raw = error;
  } else if (error && typeof error === 'object') {
    const record = error as { code?: unknown; message?: unknown };
    const code = typeof record.code === 'string' ? record.code : '';
    const message = typeof record.message === 'string' ? record.message : '';
    raw = code && message ? `${code}: ${message}` : code || message;
  }
  if (!raw) raw = result.stderr.split(/\r?\n/).find((line) => line.trim()) ?? '';
  return safeInferDetail(raw, prompt);
}

// Bounded, single-line, secret-redacted, and withheld entirely if it echoes
// any stretch of the prompt (which carries the evidence).
export function safeInferDetail(raw: string, prompt: string): string {
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim()) ?? '';
  let detail = firstLine
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!detail) return '';
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
  if (echoesPrompt(detail, prompt)) return 'detail withheld because it echoed request content';
  return detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS)}…` : detail;
}

function echoesPrompt(detail: string, prompt: string): boolean {
  if (!prompt || detail.length < PROMPT_ECHO_WINDOW) return false;
  for (let index = 0; index + PROMPT_ECHO_WINDOW <= detail.length; index += 1) {
    if (prompt.includes(detail.slice(index, index + PROMPT_ECHO_WINDOW))) return true;
  }
  return false;
}

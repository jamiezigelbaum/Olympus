// OpenClaw-native cloud analyst transport.
//
// The frontier cloud analyst reaches GPT-5.5 (and any other configured cloud
// provider) through `openclaw infer model run` — the host's own inference
// surface — rather than a direct OpenAI API call. This uses the OAuth provider
// openclaw already manages (the user's subscription), so there is NO metered
// API key and no separate credential to provision: the same auth Castor uses.
// It mirrors the existing CLI-bridge pattern (gog for email, whisper for
// transcription).
//
// Invocation:
//   openclaw infer model run --model openai/gpt-5.5 --thinking high --json \
//     --prompt "<system>\n\n<prompt>"
// stdout is a JSON object: { ok, provider, model, outputs: [{ text }] }.

import { OperationError } from './operation-error.ts';
import { existsSync } from 'node:fs';
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
  model?: string; // provider/model, default 'openai/gpt-5.5'
  thinking?: string; // reasoning level, default 'high'
  timeoutMs?: number; // default 120000
  runner?: OpenClawCommandRunner;
}

const DEFAULT_COMMAND = 'openclaw';
const DEFAULT_MODEL = 'openai/gpt-5.5';
const DEFAULT_THINKING = 'high';
const DEFAULT_TIMEOUT_MS = 120_000;
// Linux caps one argv element at MAX_ARG_STRLEN (128 KiB). A large evidence
// pack folded into --prompt reaches that, and execve then fails E2BIG with an
// opaque "could not be spawned" reason. Refusing above a conservative ceiling
// keeps the router's local fallback deterministic and the audit reason legible.
const MAX_PROMPT_BYTES = 100_000;

// Resolve the openclaw binary even under a minimal service PATH (launchd
// defaults omit /opt/homebrew/bin and /usr/local/bin).
function resolveOpenClawCommand(): string {
  const found = Bun.which(DEFAULT_COMMAND);
  if (found) return found;
  for (const candidate of ['/opt/homebrew/bin/openclaw', '/usr/local/bin/openclaw', `${process.env.HOME ?? ''}/.openclaw/bin/openclaw`]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return DEFAULT_COMMAND;
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
  const model = options.model ?? DEFAULT_MODEL;
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
        '--model',
        model,
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
        throw new OperationError(
          'source_index_error',
          'openclaw infer could not be spawned for the cloud analyst.',
          error instanceof Error ? error.message : 'Check the openclaw CLI on the worker host.',
        );
      }
      if (result.code !== 0) {
        throw new OperationError(
          'source_index_error',
          `openclaw infer exited with code ${result.code}.`,
          truncate(result.stderr) || 'No stderr.',
        );
      }
      return { text: parseInferOutputText(result.stdout), modelId: model };
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

function truncate(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

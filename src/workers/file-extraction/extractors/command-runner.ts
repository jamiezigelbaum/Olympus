/**
 * The local command seam.
 *
 * Every extractor that shells out to a local binary goes through this type, and
 * every test injects a fake in its place. The landed `ExtractorRegistryConfig`
 * carries no command-runner field on purpose: injection points are extra
 * optional constructor options on each factory, not additions to the shared
 * seam.
 *
 * Ported from the production lane's command runner. Two properties are
 * load-bearing and were preserved exactly:
 *
 *   - A non-zero exit rejects with a structured error carrying the command,
 *     the exit code and both streams, because the deterministic-rejection
 *     classifier reads all four.
 *   - A timeout SIGKILLs the child and rejects; it never resolves with
 *     whatever partial output had arrived.
 *
 * Doc comments in this directory are always multi-line blocks: the
 * architecture guard reads a single-line block comment as a regex literal.
 */

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';

export interface ExtractionCommandRunRequest {
  command: string;
  args: string[];
  timeoutMs: number;
}

export interface ExtractionCommandRunResult {
  stdout: string;
  stderr: string;
}

export type ExtractionCommandRunner = (
  request: ExtractionCommandRunRequest,
) => Promise<ExtractionCommandRunResult>;

/**
 * A local command exited non-zero. Carries both streams so a caller can
 * classify the failure; callers must never copy any of it into `errorKind` or
 * `warnings`, which are bounded categorical tokens.
 */
export class ExtractionCommandError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: {
    command: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }) {
    super(input.exitCode === null
      ? `${input.command} exited without an exit code.`
      : `${input.command} exited with status ${input.exitCode}.`);
    this.name = 'ExtractionCommandError';
    this.command = input.command;
    this.exitCode = input.exitCode;
    this.stdout = input.stdout;
    this.stderr = input.stderr;
  }
}

/**
 * A local command exceeded its timeout and was killed.
 *
 * The production lane threw a bare `Error` here. It is a distinct class now
 * only so an extractor can map it onto its own bounded `errorKind` without
 * pattern-matching a message string; the disposition is unchanged.
 */
export class ExtractionCommandTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(input: { command: string; timeoutMs: number }) {
    super(`${input.command} timed out.`);
    this.name = 'ExtractionCommandTimeoutError';
    this.command = input.command;
    this.timeoutMs = input.timeoutMs;
  }
}

export async function runExtractionCommand(
  request: ExtractionCommandRunRequest,
): Promise<ExtractionCommandRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const useTimeout = Number.isFinite(request.timeoutMs) && request.timeoutMs > 0;
    const timer = useTimeout
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new ExtractionCommandTimeoutError({
            command: request.command,
            timeoutMs: request.timeoutMs,
          }));
        }, request.timeoutMs)
      : undefined;
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      reject(new ExtractionCommandError({
        command: request.command,
        exitCode: code,
        stdout: result.stdout,
        stderr: result.stderr,
      }));
    });
  });
}

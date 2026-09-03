export interface BoundedEvalProcessRequest {
  command: readonly string[];
  env: Record<string, string | undefined>;
  timeoutMs: number;
  stdout?: 'ignore' | 'inherit';
  stderr?: 'ignore' | 'inherit';
}

export interface BoundedEvalProcessResult {
  timedOut: boolean;
  exitCode: number;
  durationMs: number;
}

/**
 * Run one real-eval question outside the parent's JavaScript event loop.
 *
 * SQLite calls made through Bun are synchronous. A Promise.race in the same
 * process cannot fire its timer while such a call is executing, so the
 * question boundary has to be a process boundary: the parent remains able to
 * enforce the configured deadline and terminates only the child question.
 */
export async function runBoundedEvalProcess(
  request: BoundedEvalProcessRequest,
): Promise<BoundedEvalProcessResult> {
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new Error('Bounded eval process timeout must be positive.');
  }
  if (request.command.length === 0) {
    throw new Error('Bounded eval process command must be non-empty.');
  }
  const startedAt = Date.now();
  const child = Bun.spawn({
    cmd: [...request.command],
    env: request.env,
    stdin: 'ignore',
    stdout: request.stdout ?? 'ignore',
    stderr: request.stderr ?? 'inherit',
  });
  let timeout: Timer | undefined;
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ timedOut: false as const, exitCode })),
    new Promise<{ timedOut: true; exitCode: number }>((resolve) => {
      timeout = setTimeout(() => resolve({ timedOut: true, exitCode: 124 }), request.timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (outcome.timedOut) {
    child.kill('SIGTERM');
    await child.exited;
  }
  return {
    ...outcome,
    durationMs: Date.now() - startedAt,
  };
}

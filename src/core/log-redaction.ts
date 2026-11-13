/**
 * Log-line redaction shared by every operator log surface.
 *
 * Scrubs anything token-shaped: a `Bearer`/`token`/`api_key`/`secret`/
 * `password` value, and any run of 40 or more key-like characters.
 */
export function redactLogLine(line: string): string {
  return line
    .replace(/\b(Bearer|token|api[_-]?key|secret|password)([=:\s]+)\S+/gi, '$1$2[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]');
}

/** Longest error message an operator log line carries. */
export const LOG_ERROR_MESSAGE_MAX_CHARS = 200;

/**
 * An error's message for an operator log line: one line, at most 200
 * characters, token-shaped values redacted, JSON-quoted so it cannot break the
 * line's `key=value` shape. Meant for code-authored messages; the bound is a
 * backstop, not a licence to log file contents.
 */
export function boundedLogErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return JSON.stringify(redactLogLine(oneLine).slice(0, LOG_ERROR_MESSAGE_MAX_CHARS));
}

/**
 * Where an error was raised, for an operator log line: its class and the
 * first frame of its stack, with the frame's folders dropped (file:line only),
 * redacted and bounded. An error that crossed a process or thread boundary
 * carries the class and frame it had where it was raised (#1502).
 */
export function logErrorOrigin(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(typeof error);
  const frame = errorFirstFrame(error);
  return JSON.stringify(redactLogLine(frame ? `${error.name} at ${frame}` : error.name).slice(0, LOG_ERROR_MESSAGE_MAX_CHARS));
}

/** The first `at` line of a stack, as `function (file:line:col)` with folders dropped. */
export function errorFirstFrame(error: Error): string | undefined {
  const line = error.stack?.split('\n').map((entry) => entry.trim()).find((entry) => entry.startsWith('at '));
  if (!line) return undefined;
  return line.slice(3).replace(/(?:[A-Za-z]:)?[^\s()]*[\\/]([^\\/\s()]+:\d+(?::\d+)?)/g, '$1').slice(0, 160);
}

/**
 * Rebuilds an error that crossed a boundary as plain data: its message, its
 * original class name, and its first frame from where it was raised.
 */
export function errorFromBoundary(message: string, name: string | undefined, frame: string | undefined, where: string): Error {
  const error = new Error(message);
  if (name) error.name = name;
  error.stack = `${error.name}: ${message}\n    at ${frame ?? 'unknown'} (${where})`;
  return error;
}

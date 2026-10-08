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

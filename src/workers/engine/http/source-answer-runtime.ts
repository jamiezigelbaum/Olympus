import type { OperationCallerWire } from '../../../core/operation-caller.ts';
import type { SourceIndexAnswerHandler } from '../../source-index/answer-types.ts';
import {
  type SourceAnswerLatencyLog,
  buildSourceAnswerLatencyRecord,
  buildSourceAnswerLatencyTraceRecord,
} from '../../source-index/answer-latency-log.ts';
import {
  sourceAnswerTraceErrorClass,
  createSourceAnswerTrace,
  type SourceAnswerTraceOutcome,
  recordSourceAnswerLedgerBuild,
  recordSourceAnswerLedgerAppend,
  snapshotSourceAnswerTrace,
  recordSourceAnswerSqliteRetry,
} from '../../source-index/answer-latency-trace.ts';
import { type SourceFailureKind, sourceFailureKind } from '../../dashboard/source-failure.ts';
import { EmailSourceWorkerError } from './worker-responses.ts';

/**
 * Follows the request's signal with an AbortError reason, which the analyst
 * route reads as the caller's cancellation (it ends the route without
 * counting against a lane), whatever reason the runtime aborted with.
 */
export function callerCancellationSignal(signal: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    const reason = signal.reason;
    if (reason instanceof Error && reason.name === 'AbortError') {
      controller.abort(reason);
      return;
    }
    const error = new Error('The caller cancelled this answer.');
    error.name = 'AbortError';
    controller.abort(error);
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

export function scrubSourceWorkerLogMessage(message: unknown): string {
  return String(message).slice(0, 200).replace(/[A-Za-z0-9._~+/=-]{24,}/g, '<redacted>');
}

/**
 * Why a Sync now press failed, from our own error codes only: a credential
 * broker or worker error whose code the scheduler vocabulary knows, else
 * `unknown` (the log carries the message under a reference).
 */
export function manualSyncFailureKind(error: unknown): SourceFailureKind {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? sourceFailureKind(code) : 'unknown';
}

export function logSourceWorkerInternalError(request: Request, error: unknown, ref?: string): void {
  const cause = error as { constructor?: { name?: string }; code?: unknown; message?: unknown } | null | undefined;
  const route = new URL(request.url).pathname;
  if (route.endsWith('/source/answer')) {
    console.error('[source-worker-error] ' + JSON.stringify({
      route,
      method: request.method,
      errorClass: sourceAnswerTraceErrorClass(error),
      code: cause?.code,
    }));
    return;
  }
  console.error('[source-worker-error] ' + JSON.stringify({
    route,
    method: request.method,
    errorClass: cause?.constructor?.name,
    code: cause?.code,
    message: scrubSourceWorkerLogMessage(cause?.message ?? error),
    ...(ref ? { ref } : {}),
  }));
}

export async function emitSourceAnswerLatencyRecords(input: {
  log: SourceAnswerLatencyLog | undefined;
  trace: ReturnType<typeof createSourceAnswerTrace>;
  outcome: SourceAnswerTraceOutcome;
  result?: Awaited<ReturnType<SourceIndexAnswerHandler['answer']>>;
  error?: unknown;
  caller?: OperationCallerWire;
}): Promise<void> {
  if (!input.log) return;

  let compatV1LoggedAt: string | undefined;
  if (input.result) {
    const buildStartedAt = Date.now();
    try {
      const v1 = buildSourceAnswerLatencyRecord(input.result, undefined, input.caller);
      compatV1LoggedAt = v1.logged_at;
      recordSourceAnswerLedgerBuild(Date.now() - buildStartedAt);
      const appendStartedAt = Date.now();
      await recordSourceAnswerLatencyBestEffort(input.log, v1);
      recordSourceAnswerLedgerAppend(Date.now() - appendStartedAt);
    } catch (error) {
      recordSourceAnswerLedgerBuild(Date.now() - buildStartedAt);
      recordSourceAnswerLatencyFailure(input.log, error);
    }
  }

  try {
    const v2 = buildSourceAnswerLatencyTraceRecord({
      trace: snapshotSourceAnswerTrace(input.trace),
      outcome: input.outcome,
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(compatV1LoggedAt ? { compatV1LoggedAt } : {}),
      ...(input.caller ? { caller: input.caller } : {}),
    });
    await recordSourceAnswerLatencyBestEffort(input.log, v2);
  } catch (error) {
    recordSourceAnswerLatencyFailure(input.log, error);
  }
}

async function recordSourceAnswerLatencyBestEffort(
  log: SourceAnswerLatencyLog,
  record: Parameters<SourceAnswerLatencyLog['record']>[0],
): Promise<void> {
  try {
    await log.record(record);
  } catch (error) {
    recordSourceAnswerLatencyFailure(log, error);
  }
}

function recordSourceAnswerLatencyFailure(
  log: SourceAnswerLatencyLog,
  error: unknown,
): void {
  try {
    if (log.recordFailure) {
      log.recordFailure(error);
      return;
    }
  } catch {
    // The health hook is observability-only and may never affect the answer.
  }
  console.error(
    `[source-answer-latency] record failed error_class=${sourceAnswerTraceErrorClass(error)}`,
  );
}

export function classifySourceAnswerTraceOutcome(
  error: unknown,
  requestParsed: boolean,
  requestAborted: boolean,
): SourceAnswerTraceOutcome {
  if (!requestParsed) return 'parse_error';
  const errorClass = sourceAnswerTraceErrorClass(error);
  if (requestAborted || errorClass === 'AbortError') return 'cancelled';
  const candidate = error as { code?: unknown; message?: unknown } | null | undefined;
  if (
    errorClass === 'TrustedAnalystTimeoutError'
    || errorClass === 'TimeoutError'
    || candidate?.code === 'ETIMEDOUT'
  ) {
    return 'timeout';
  }
  if (/sovereignty analyst fallback chain exhausted/i.test(String(candidate?.message ?? ''))) {
    return 'route_exhausted';
  }
  return 'error';
}

const DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;

export async function retrySqliteBusy<T>(operation: () => T | Promise<T>): Promise<T> {
  let lastError: unknown;
  const retryDelays = sqliteBusyRetryDelays();
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error)) {
        throw error;
      }
      if (attempt === retryDelays.length) {
        throw new EmailSourceWorkerError(
          503,
          'source_index_busy',
          'The source index is busy; retry the source request shortly.',
        );
      }
      recordSourceAnswerSqliteRetry(retryDelays[attempt]!);
      await sleep(retryDelays[attempt]!);
    }
  }
  throw lastError;
}

function sqliteBusyRetryDelays(): readonly number[] {
  const configured = process.env.OLYMPUS_SQLITE_BUSY_RETRY_DELAYS_MS;
  if (!configured) return DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS;
  const parsed: number[] = [];
  for (const rawItem of configured.split(',')) {
    const item = rawItem.trim();
    const delay = Number(item);
    if (item === '' || !Number.isFinite(delay) || delay < 0) {
      console.warn(
        'Ignoring malformed OLYMPUS_SQLITE_BUSY_RETRY_DELAYS_MS; using default SQLite busy retry delays.',
      );
      return DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS;
    }
    parsed.push(delay);
  }
  return parsed;
}

function isSqliteBusyError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null | undefined;
  return candidate?.code === 'SQLITE_BUSY'
    || String(candidate?.message ?? '').toLowerCase().includes('database is locked');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

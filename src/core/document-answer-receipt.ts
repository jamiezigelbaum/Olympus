import type { ConsultAskResult } from './consult-ask.ts';
import {
  runWithDocumentDispatch,
  type DocumentDispatchObserver,
  type DocumentDispatchProgress,
} from './document-dispatch.ts';
import { createPrivateDocumentRequests } from './private-document-requests.ts';

const MAX_RECORDED_REQUESTS = 4;
const MAX_RECORDED_BYTES = 256 * 1024;
const VENICE_HOST = 'api.venice.ai';
const VENICE_CHAT_PATH = '/chat/completions';
const encoder = new TextEncoder();

type PrivateDocumentJobs = Pick<ReturnType<typeof createPrivateDocumentRequests>, 'start'>;

export interface DocumentAnswerReceiptOptions<T> {
  jobs: PrivateDocumentJobs;
  question: string;
  authorized: () => boolean;
  signal?: AbortSignal;
  work: (signal: AbortSignal) => Promise<T>;
  describe: (result: T) => { reply: string; answeredByVenice: boolean };
}

export class DocumentAnswerReceiptStartError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'DocumentAnswerReceiptStartError';
    this.code = code;
  }
}

/**
 * Mirrors an ordinary document answer into Private answers without changing
 * the caller's value. The page receives only the exact Venice request bodies
 * and the final answer; headers, credentials and endpoint URLs are never kept.
 */
export function withDocumentAnswerReceipt<T>(options: DocumentAnswerReceiptOptions<T>): Promise<T> {
  let resolveCaller!: (value: T | PromiseLike<T>) => void;
  let rejectCaller!: (reason?: unknown) => void;
  const caller = new Promise<T>((resolve, reject) => {
    resolveCaller = resolve;
    rejectCaller = reject;
  });
  let callerSettled = false;
  const resolveOnce = (value: T) => {
    if (callerSettled) return;
    callerSettled = true;
    resolveCaller(value);
  };
  const rejectOnce = (error: unknown) => {
    if (callerSettled) return;
    callerSettled = true;
    rejectCaller(error);
  };

  const notice = options.jobs.start(options.question, async (control): Promise<ConsultAskResult> => {
    const requests: Array<{ body: string; model: string }> = [];
    let recordedBytes = 0;
    const liveGuards = new Set<() => boolean>([options.authorized]);
    const liveGuard = () => [...liveGuards].every(safeCurrent);
    let lastProgress: DocumentDispatchProgress = {
      state: 'reading',
      documentsRead: 0,
      documentsTotal: 0,
    };
    const observer: DocumentDispatchObserver = {
      onGuard(current) {
        liveGuards.add(current);
        // Deliberately excludes the execution signal. Publication checks the
        // durable source/connection authority, while cancellation bounds work.
        control.registerDocumentGuard(async () => liveGuard());
      },
      onProgress(progress) {
        lastProgress = progress;
        control.onProgress(progress);
      },
      onRequest(url, init) {
        if (!isVeniceChatCompletion(url, init)) return;
        const captured = captureVeniceRequest(init, requests.length, recordedBytes);
        requests.push(captured);
        recordedBytes += encoder.encode(captured.body).length;
        lastProgress = { ...lastProgress, state: 'answering' };
        control.onProgress(lastProgress);
      },
    };
    const executionSignal = combineAbortSignals(control.signal, options.signal);
    try {
      if (!options.authorized() || executionSignal.aborted) {
        throw documentAuthorizationChangedError(executionSignal);
      }
      const result = await runWithDocumentDispatch(
        options.authorized,
        () => options.work(executionSignal),
        observer,
      );
      if (executionSignal.aborted || liveGuard() !== true || !options.authorized()) {
        throw documentAuthorizationChangedError(executionSignal);
      }
      const description = options.describe(result);
      if (liveGuard() !== true || !options.authorized()) {
        throw documentAuthorizationChangedError(executionSignal);
      }
      resolveOnce(result);
      if (description.answeredByVenice && requests.length > 0) {
        const last = requests.at(-1)!;
        return {
          ok: true,
          privateDocuments: true,
          reply: description.reply,
          sent: renderRecordedRequests(requests),
          route: 'Venice Private',
          networkIdentity: 'not_verified',
          level: 'standard',
          cleanup: 'as_written',
          rewritten: false,
          remembered: false,
          model: last.model,
        };
      }
      return {
        ok: false,
        privateDocuments: true,
        code: 'documents_no_venice_answer',
        message: 'Venice did not answer this document request. The caller used its local fallback.',
        ...(requests.length > 0 ? { sent: renderRecordedRequests(requests) } : {}),
      };
    } catch (error) {
      rejectOnce(error);
      if (!safeCurrent(liveGuard) || !safeCurrent(options.authorized)) {
        return {
          ok: false,
          privateDocuments: true,
          code: 'documents_changed',
          message: 'The documents or their privacy settings changed. Ask again.',
        };
      }
      return {
        ok: false,
        privateDocuments: true,
        code: 'documents_answer_failed',
        message: 'The document answer failed after it started. Review the attempted request and ask again.',
        ...(requests.length > 0 ? { sent: renderRecordedRequests(requests) } : {}),
      };
    }
  }, options.authorized);

  if (!(notice.ok === false && notice.code === 'private_documents_pending')) {
    rejectOnce(new DocumentAnswerReceiptStartError(notice.ok === false ? notice.code : 'documents_unavailable'));
  }
  return caller;
}

function isVeniceChatCompletion(url: string, init: RequestInit): boolean {
  if ((init.method ?? 'GET').toUpperCase() !== 'POST') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname === VENICE_HOST
      && parsed.pathname.endsWith(VENICE_CHAT_PATH);
  } catch {
    return false;
  }
}

function captureVeniceRequest(
  init: RequestInit,
  capturedCount: number,
  capturedBytes: number,
): { body: string; model: string } {
  if (capturedCount >= MAX_RECORDED_REQUESTS) {
    throw new Error('Document answer exceeded the four-request private receipt limit; nothing further was sent.');
  }
  if (typeof init.body !== 'string') {
    throw new Error('Document answer could not record the Venice request body; nothing was sent.');
  }
  const bytes = encoder.encode(init.body).length;
  if (capturedBytes + bytes > MAX_RECORDED_BYTES) {
    throw new Error('Document answer exceeded the private receipt byte limit; nothing further was sent.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(init.body); } catch {
    throw new Error('Document answer could not identify the Venice model; nothing was sent.');
  }
  const model = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { model?: unknown }).model
    : undefined;
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('Document answer could not identify the Venice model; nothing was sent.');
  }
  return { body: init.body, model };
}

function renderRecordedRequests(requests: readonly { body: string }[]): string {
  if (requests.length === 1) return requests[0]!.body;
  return requests.map((request, index) => `[Request ${index + 1}]\n${request.body}`).join('\n\n');
}

function combineAbortSignals(job: AbortSignal, caller: AbortSignal | undefined): AbortSignal {
  return caller ? AbortSignal.any([job, caller]) : job;
}

function safeCurrent(current: () => boolean): boolean {
  try { return current() === true; } catch { return false; }
}

function documentAuthorizationChangedError(signal: AbortSignal): Error {
  if (signal.aborted && signal.reason instanceof Error) return signal.reason;
  return new Error('Document answer authorization changed; nothing further was sent.');
}

import type { CreateSourceWatchInput } from '../../../core/source-watch.ts';
import { trustedSourceWatchOwnerFromRequest } from '../../source-watch-runtime.ts';
import { parseObjectBody, canonicalRequestCorpusId, asOptionalString, asOptionalNumber } from './request-fields.ts';
import { EmailSourceWorkerError } from './worker-responses.ts';

export async function parseSourceWatchCreateRequest(request: Request): Promise<CreateSourceWatchInput> {
  const record = await parseObjectBody(request);
  assertOnlyRequestFields(record, [
    'corpus_id',
    'query_text',
    'mode',
    'expires_at',
    'max_delivery_attempts',
  ]);
  // Resolved before the watch is persisted. A watch is long-lived work, so
  // storing the id as sent would keep an unresolved alias on disk and the watch
  // would be accepted and then never fire - accepting work that can never
  // happen. Storing the canonical id means the evaluation pass finds the corpus.
  const corpusId = canonicalRequestCorpusId(record);
  const queryText = asOptionalString(record.query_text);
  const mode = asOptionalString(record.mode);
  if (!corpusId || !queryText || (mode !== 'one_shot' && mode !== 'continuous')) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'corpus_id, query_text, and a valid mode are required.');
  }
  const expiresAt = asOptionalString(record.expires_at);
  const maxDeliveryAttempts = asOptionalNumber(record.max_delivery_attempts, 'max_delivery_attempts');
  return {
    corpusId,
    queryText,
    mode,
    ...(expiresAt ? { expiresAt } : {}),
    ...(maxDeliveryAttempts !== undefined ? { maxDeliveryAttempts } : {}),
  };
}

export async function parseSourceWatchesRequest(request: Request): Promise<{ limit?: number; cursor?: string }> {
  const record = await parseObjectBody(request);
  assertOnlyRequestFields(record, ['limit', 'cursor']);
  const limit = asOptionalNumber(record.limit, 'limit');
  const cursor = asOptionalString(record.cursor);
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export async function parseSourceWatchCancelRequest(request: Request): Promise<{ watchId: string; reason?: string }> {
  const record = await parseObjectBody(request);
  assertOnlyRequestFields(record, ['watch_id', 'reason']);
  const watchId = asOptionalString(record.watch_id);
  if (!watchId) throw new EmailSourceWorkerError(400, 'invalid_request', 'watch_id is required.');
  const reason = asOptionalString(record.reason);
  return { watchId, ...(reason ? { reason } : {}) };
}

function assertOnlyRequestFields(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedFields = new Set(allowed);
  const unsupported = Object.keys(record).find((field) => !allowedFields.has(field));
  if (unsupported) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `Request field ${unsupported} is not supported.`);
  }
}

export function authenticatedWatchOwner(request: Request) {
  try {
    return trustedSourceWatchOwnerFromRequest(request);
  } catch {
    throw new EmailSourceWorkerError(
      403,
      'source_watch_owner_context_required',
      'Source watch route requires authenticated OpenClaw owner and delivery context.',
    );
  }
}

export function sourceWatchNotSupported(): EmailSourceWorkerError {
  return new EmailSourceWorkerError(
    501,
    'source_watch_not_supported',
    'Private source worker does not have the durable watch control plane configured.',
  );
}

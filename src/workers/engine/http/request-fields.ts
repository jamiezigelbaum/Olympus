import {
  type OperationCallerWire,
  parseOperationCallerWire,
  callerClaimsRemoteConnection,
  isInProcessRemoteRequest,
} from '../../../core/operation-caller.ts';
import { canonicalSourceCorpusId } from '../../../core/source-corpus-registry.ts';
import { EmailSourceWorkerError } from './worker-responses.ts';

/**
 * The optional `caller` of a worker request. Only the worker's own remote
 * endpoint, after verifying a connection token, may attribute a request to a
 * connection.
 */
export function parseRequestCaller(record: Record<string, unknown>, request: Request): OperationCallerWire | undefined {
  const callerParse = parseOperationCallerWire(record.caller);
  if (!callerParse.ok) {
    throw new EmailSourceWorkerError(400, 'invalid_request', callerParse.message);
  }
  const caller = callerParse.caller;
  if (caller && callerClaimsRemoteConnection(caller) && !isInProcessRemoteRequest(request)) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'caller.surface "remote" and caller.connection_id are set only by the remote MCP endpoint.',
    );
  }
  return caller;
}

export function recordFromSearchParams(params: URLSearchParams): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    if (value === 'true') record[key] = true;
    else if (value === 'false') record[key] = false;
    else record[key] = value;
  }
  return record;
}

export async function parseDashboardMessagingBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new Error('invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32_768) { await reader.cancel(); throw new Error('invalid_request'); }
      chunks.push(part.value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(data));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_request');
      return parsed as Record<string, unknown>;
    } finally { data.fill(0); }
  } finally { for (const chunk of chunks) chunk.fill(0); reader.releaseLock(); }
}

export async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new EmailSourceWorkerError(400, 'invalid_json', 'Request body must be a JSON object.');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

/**
 * Resolves a request body's corpus_id through the shared corpus registry so a
 * documented input alias reaches dispatch as its canonical id. The parsed body
 * is rewritten in place because the per-family request parsers below re-read
 * record.corpus_id themselves; canonicalising once here keeps every downstream
 * branch and parser working on canonical ids only, with no per-family alias
 * checks anywhere. The alias table lives in the registry, so this stays
 * source-neutral as families come and go.
 */
export function canonicalRequestCorpusId(record: Record<string, unknown>): string | undefined {
  const requestedCorpusId = asOptionalString(record.corpus_id);
  if (requestedCorpusId === undefined) return undefined;
  const corpusId = canonicalSourceCorpusId(requestedCorpusId);
  if (corpusId !== requestedCorpusId) record.corpus_id = corpusId;
  return corpusId;
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function asOptionalNumber(value: unknown, name = 'numeric field'): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(number)) return number;
  throw new EmailSourceWorkerError(400, 'invalid_request', `${name} must be numeric when provided.`);
}

export function asOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  throw new EmailSourceWorkerError(400, 'invalid_request', 'boolean fields must be true or false when provided.');
}

export function asOptionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `${name} must be an array of strings.`);
  }
  return value
    .map((item, index) => {
      if (typeof item !== 'string') {
        throw new EmailSourceWorkerError(400, 'invalid_request', `${name}.${index} must be a string.`);
      }
      return item.trim();
    })
    .filter(Boolean);
}

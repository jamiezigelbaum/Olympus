import { OperationError } from './operation-error.ts';

const FORBIDDEN_RAW_RESPONSE_KEYS = new Set([
  'body',
  'bodies',
  'message',
  'messages',
  'raw_email',
  'raw_emails',
  'raw_message',
  'raw_messages',
  'snippet',
  'snippets',
  'embedding',
  'embeddings',
  'embedding_vector',
  'embedding_vectors',
  'vector',
  'vectors',
]);

export function assertNoRawEmailFields(value: unknown): void {
  assertNoRawEmailFieldsAtPath(value, []);
}

function assertNoRawEmailFieldsAtPath(value: unknown, path: string[]): void {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawEmailFieldsAtPath(item, [...path, String(index)]));
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_RAW_RESPONSE_KEYS.has(key)) {
      const location = [...path, key].join('.');
      throw new OperationError(
        'email_policy_violation',
        `Private email lane response included forbidden raw field "${location}".`,
        'Return a bounded answer plus safe evidence metadata instead of raw email content.',
      );
    }
    assertNoRawEmailFieldsAtPath(child, [...path, key]);
  }
}

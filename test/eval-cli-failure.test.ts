import { expect, test } from 'bun:test';
import { failureLine } from '../eval/cli-failure.ts';

test('a failure names the stage, the error class and a code, never the message', () => {
  class SQLiteError extends Error { code = 'SQLITE_BUSY'; }
  const line = failureLine('Passage eval', 'question 3/19: build_pack', new SQLiteError('private text from a store'));
  expect(line).toBe('Passage eval failed at question 3/19: build_pack: SQLiteError (SQLITE_BUSY); no content is logged.');
  expect(line).not.toContain('private text');
});

test('a code that could carry text is left out, and a non-error is named by its type', () => {
  const error = Object.assign(new RangeError('Kestrel invoice 47'), { code: 'Kestrel invoice 47' });
  expect(failureLine('Passage eval', 'load_reranker', error)).toBe('Passage eval failed at load_reranker: RangeError; no content is logged.');
  expect(failureLine('Passage drafting', 'draft', 'private string')).toBe('Passage drafting failed at draft: string; no content is logged.');
});

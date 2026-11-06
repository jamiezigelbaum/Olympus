import { describe, expect, test } from 'bun:test';
import { unavailableCause } from '../src/workers/file-extraction/connector-source.ts';

describe('unavailableCause', () => {
  test('names the error class and its short code or status', () => {
    const error = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    expect(unavailableCause(error)).toBe('TypeError code=ECONNRESET');
    class GmailHttpError extends Error { override name = 'GmailHttpError'; status = 404; }
    expect(unavailableCause(new GmailHttpError('x'))).toBe('GmailHttpError status=404');
  });

  test('never carries the message, or a code that could be text', () => {
    const error = Object.assign(new Error('/Personal/Taxes/2019 return.pdf'), { code: 'Taxes 2019 return.pdf' });
    const cause = unavailableCause(error);
    expect(cause).toBe('Error');
    expect(cause).not.toContain('Taxes');
  });

  test('a thrown non-error names its type', () => {
    expect(unavailableCause('boom')).toBe('string');
  });
});

import { describe, expect, test } from 'bun:test';
import { TierMoveContentChangedError, TierMoveRefusedError } from '../src/workers/connector-store/tier-move.ts';
import { moveFailureName } from '../src/workers/classification/sniffer-service.ts';

describe('a failed automatic move names its reason in the log', () => {
  test('a named error class, or a short fixed message, and nothing longer', () => {
    class TierMoveSomethingError extends Error {
      constructor() { super('details about /Users/owner/Secret plan.pdf'); this.name = 'TierMoveSomethingError'; }
    }
    expect(moveFailureName(new TierMoveSomethingError())).toBe('TierMoveSomethingError');
    expect(moveFailureName(new Error('no current copy'))).toBe('no current copy');
    // A message that could carry a name or a path is never repeated.
    expect(moveFailureName(new Error('could not read /Users/owner/Secret plan.pdf'))).toBe('Error');
    expect(moveFailureName(new Error('Message From Jane About Divorce'))).toBe('Error');
    expect(moveFailureName('a string')).toBe('unknown');
    // A refusal says which of the primitive's refusals it was.
    expect(moveFailureName(new TierMoveRefusedError('Raises cannot enter a lowering batch.', 'raise_in_lowering'))).toBe('TierMoveRefusedError:raise_in_lowering');
    expect(moveFailureName(new TierMoveContentChangedError('Stored content does not match.', 'content_no_receipt'))).toBe('TierMoveRefusedError:content_no_receipt');
  });
});

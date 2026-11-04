import { describe, expect, test } from 'bun:test';
import { isFileExtractionSourceError } from '../src/core/file-extraction-source.ts';
import { gmailAttachmentConnector } from '../src/workers/google-connectors/gmail-attachment-extraction.ts';
import { gmailPartLocatorPrefix } from '../src/workers/google-connectors/gmail.ts';
import { GoogleRequestBudgetError } from '../src/workers/google-connectors/request-budget.ts';

describe('Gmail attachments on a spent request budget', () => {
  test('a spent daily budget is the source parking until the reset, not an unavailable attachment', async () => {
    const resetAt = '2026-11-05T00:00:00.000Z';
    const reader = gmailAttachmentConnector({
      account: 'personal',
      live: () => ({
        async fetchItemWithin() {
          throw new GoogleRequestBudgetError('gmail', resetAt);
        },
      }),
    });
    const caught = await reader.fetchItemWithin('personal:child', {
      deferredBytes: { locator: `${gmailPartLocatorPrefix()}m1:2` },
    }).then(() => undefined, (error: unknown) => error);
    expect(isFileExtractionSourceError(caught)).toBe(true);
    expect((caught as { errorKind: string }).errorKind).toBe('source_budget_exhausted');
    expect((caught as { retryAt?: string }).retryAt).toBe(resetAt);
  });

  test('any other live failure passes through unchanged', async () => {
    const failure = new Error('boom');
    const reader = gmailAttachmentConnector({
      account: 'personal',
      live: () => ({ async fetchItemWithin() { throw failure; } }),
    });
    const caught = await reader.fetchItemWithin('personal:child', {
      deferredBytes: { locator: `${gmailPartLocatorPrefix()}m1:2` },
    }).then(() => undefined, (error: unknown) => error);
    expect(caught).toBe(failure);
  });
});

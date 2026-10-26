// The hold (`holdContentUntilJudged`) belongs to an item for the input it came from, not to one object: every
// method of a connector that hands out items keeps it, and a new method of the connector contract cannot be added
// without saying which kind it is. Synthetic data only.

import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { holdingItems } from '../src/workers/archive-import/source-input.ts';

const item: RawItem = {
  identity: { provider: 'p', family: 'email', accountScope: 's', providerItemId: 'a', localItemId: 's:a' },
  mimeType: 'text/plain',
  content: { kind: 'text', text: 'words' },
  metadata: {},
  fetchedAt: '2026-10-26T00:00:00.000Z',
} as RawItem;

// Every member of the connector contract. A new member fails the type check here until it is listed.
const KINDS: Record<keyof Required<SourceConnector>, 'holds' | 'neutral'> = {
  id: 'neutral',
  family: 'neutral',
  authenticate: 'neutral',
  listItems: 'holds',
  fetchItem: 'holds',
  classificationSignals: 'neutral',
  forInput: 'neutral',
};

const stub: SourceConnector = {
  id: 'stub',
  family: 'email',
  authenticate: () => Promise.resolve(),
  async *listItems() { await Promise.resolve(); yield { items: [item], done: true }; },
  fetchItem: () => Promise.resolve(item),
  classificationSignals: () => ({}) as never,
};

describe('an archive input holds every item it hands out, however the store asks for it', () => {
  test('listing and fetching both carry the hold', async () => {
    const held = holdingItems(stub);
    for (const [method, kind] of Object.entries(KINDS)) {
      if (kind !== 'holds') continue;
      if (method === 'listItems') {
        for await (const page of held.listItems()) for (const listed of page.items) expect(listed.holdContentUntilJudged, method).toBe(true);
      } else if (method === 'fetchItem') {
        expect((await held.fetchItem('s:a')).holdContentUntilJudged, method).toBe(true);
      } else {
        throw new Error(`${method} is listed as holding but this test does not exercise it`);
      }
    }
  });

  test('methods that are neutral do not touch items', () => {
    const held = holdingItems(stub);
    for (const [method, kind] of Object.entries(KINDS)) {
      if (kind === 'neutral' && method in stub) expect((held as unknown as Record<string, unknown>)[method], method).toBe((stub as unknown as Record<string, unknown>)[method]);
    }
  });
});

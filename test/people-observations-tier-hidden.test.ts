// A copy the tier ledger keeps out of view (superseded or staged) never feeds
// the people index (#1076, Codex P1 on #1152): a Personal copy left behind by
// a move, or one staged before a move cuts over, must not make the sender's
// name shareable while the item is judged Private.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { SourceConnector } from '../src/core/contracts.ts';
import {
  FIXTURE_PLACEMENT,
  fixtureConnector,
  openTierFixture,
  tempDir,
  type FixtureSpec,
} from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function withSender(connector: SourceConnector): SourceConnector {
  const tag = <T extends { metadata: Readonly<Record<string, unknown>> }>(item: T): T => ({
    ...item,
    metadata: { ...item.metadata, senderId: 'quinn@example.com', senderLabel: 'Quinn Holloway' },
  });
  return {
    ...connector,
    listItems(options) {
      const pages = connector.listItems(options);
      return (async function* () {
        for await (const page of pages) yield { ...page, items: page.items.map(tag) };
      })();
    },
    async fetchItem(localItemId) {
      return tag(await connector.fetchItem(localItemId));
    },
  };
}

describe('people observations and the tier ledger', () => {
  for (const state of ['superseded', 'staged'] as const) {
    test(`a ${state} Personal copy names no one`, async () => {
      const { dir, cleanup } = tempDir('olympus-people-tier-');
      const fixture = openTierFixture(dir, { embed: false });
      cleanups.push(() => {
        fixture.close();
        cleanup();
      });
      const specs: FixtureSpec[] = [{ id: 'note-1', name: 'note-1.txt', text: 'a note from Quinn' }];
      await fixture.set.sync(withSender(fixtureConnector(() => specs)), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      const internal = fixture.stores.internal!;
      expect(internal.peopleObservations().map((o) => [o.senderLabel, o.privateOnly])).toEqual([['Quinn Holloway', undefined]]);

      // The ledger now keeps this copy out of view; the row and its sender stay.
      const ledgerDb = (fixture.ledger as unknown as { db: Database }).db;
      ledgerDb.query('UPDATE tier_copies SET copy_state = ?').run(state);
      expect(internal.peopleObservations()).toEqual([]);
    });
  }
});

// The people index rebuilds soon after a sender's visibility changes, not on
// the next long timer (#1076, Codex P1 on #1152): a name whose only Personal
// item is re-judged Private must stop being citable within about a minute.

import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceConnector } from '../src/core/contracts.ts';
import {
  LocalPeopleIndex,
  PEOPLE_INDEX_MIN_REBUILD_MS,
  PeopleIndexRefresher,
  type PeopleObservationSource,
  type PeopleSenderObservation,
} from '../src/core/people-index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createTestClock } from './helpers/test-clock.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir, type FixtureSpec } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('people index refresh on a visibility change', () => {
  test('a changed visibility marker rebuilds, at most once a minute', async () => {
    const clock = createTestClock();
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    cleanups.push(() => index.close());
    let marker = 'v1';
    let observations: PeopleSenderObservation[] = [
      { provider: 'mail', senderId: 'quinn@example.com', senderLabel: 'Quinn Holloway', isOwner: false, itemCount: 1 },
    ];
    const store: PeopleObservationSource = {
      family: 'email',
      peopleObservations: () => observations,
      peopleVisibilityMarker: () => marker,
    };
    const refresher = new PeopleIndexRefresher(index, () => [store], { now: () => clock.now() });
    refresher.refresh();
    expect(index.personForSender('mail', 'quinn@example.com')?.nameShareable).toBe(true);

    // Nothing changed: no rebuild.
    await clock.advance(PEOPLE_INDEX_MIN_REBUILD_MS);
    expect(refresher.refreshIfChanged()).toBe(false);

    // The only Personal item is re-judged Private.
    observations = [{ ...observations[0]!, privateOnly: true }];
    marker = 'v2';
    expect(refresher.refreshIfChanged()).toBe(true);
    expect(index.personForSender('mail', 'quinn@example.com')?.nameShareable).toBe(false);

    // A judging backlog moves the marker again at once: held to one rebuild a minute.
    marker = 'v3';
    await clock.advance(PEOPLE_INDEX_MIN_REBUILD_MS / 2);
    expect(refresher.refreshIfChanged()).toBe(false);
    await clock.advance(PEOPLE_INDEX_MIN_REBUILD_MS / 2);
    expect(refresher.refreshIfChanged()).toBe(true);
  });

  test("a store's marker moves when a copy's tier visibility changes, not on a read", async () => {
    const { dir, cleanup } = tempDir('olympus-people-marker-');
    const fixture = openTierFixture(dir, { embed: false });
    cleanups.push(() => {
      fixture.close();
      cleanup();
    });
    const specs: FixtureSpec[] = [{ id: 'note-1', name: 'note-1.txt', text: 'a note' }];
    const connector: SourceConnector = fixtureConnector(() => specs);
    await fixture.set.sync(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const internal = fixture.stores.internal!;
    const before = internal.peopleVisibilityMarker();
    internal.peopleObservations();
    expect(internal.peopleVisibilityMarker()).toBe(before);
    await moveTieredItem({ set: fixture.set, identity: identityOf('note-1'), target: { metadataTier: 'secure', contentTier: 'secure' } });
    expect(internal.peopleVisibilityMarker()).not.toBe(before);
  });
});

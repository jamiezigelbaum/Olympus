// The people index rebuilds soon after a sender's visibility changes, not on
// the next long timer (#1076, Codex P1 on #1152): a name whose only Personal
// item is re-judged Private must stop being citable within about a minute.

import { readFileSync } from 'node:fs';
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
import { FIXTURE_PLACEMENT, fixtureConnector, fixtureItem, identityOf, openTierFixture, tempDir, type FixtureSpec } from './helpers/tier-fixtures.ts';

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
    await refresher.refresh();
    expect(index.personForSender('mail', 'quinn@example.com')?.nameShareable).toBe(true);

    // Nothing changed: no rebuild.
    await clock.advance(PEOPLE_INDEX_MIN_REBUILD_MS);
    expect(await refresher.refreshIfChanged()).toBe(false);

    // The only Personal item is re-judged Private.
    observations = [{ ...observations[0]!, privateOnly: true }];
    marker = 'v2';
    expect(await refresher.refreshIfChanged()).toBe(true);
    expect(index.personForSender('mail', 'quinn@example.com')?.nameShareable).toBe(false);

    // A judging backlog moves the marker again at once: held to one rebuild a minute.
    marker = 'v3';
    await clock.advance(PEOPLE_INDEX_MIN_REBUILD_MS / 2);
    expect(await refresher.refreshIfChanged()).toBe(false);
    await clock.advance(PEOPLE_INDEX_MIN_REBUILD_MS / 2);
    expect(await refresher.refreshIfChanged()).toBe(true);
  });

  test("a store's marker moves when a sender repair changes who wrote an item", async () => {
    const { dir, cleanup } = tempDir('olympus-people-repair-');
    const fixture = openTierFixture(dir, { embed: false });
    cleanups.push(() => {
      fixture.close();
      cleanup();
    });
    const specs: FixtureSpec[] = [{ id: 'note-1', name: 'note-1.txt', text: 'a note' }];
    await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const internal = fixture.stores.internal!;
    const before = internal.peopleVisibilityMarker();
    const unchanged = internal.repairSenderMetadata({ records: [] });
    expect(unchanged.counts.itemsRepaired).toBe(0);
    expect(internal.peopleVisibilityMarker()).toBe(before);
    const repaired = internal.repairSenderMetadata({
      records: [{ sourceItem: fixtureItem(specs[0]!).identity, senderId: 'quinn@example.com', senderLabel: 'Quinn Holloway' }],
    });
    expect(repaired.counts.itemsRepaired).toBe(1);
    expect(internal.peopleVisibilityMarker()).not.toBe(before);
    expect(internal.peopleObservations().map((o) => o.senderId)).toEqual(['quinn@example.com']);
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

/** A store stub that counts its sender reads and lets a test move its sync marker. */
function countingStore(provider: string, sender: string) {
  const state = { reads: 0, syncRun: 'run-1', observations: [
    { provider, senderId: `${sender}@example.com`, senderLabel: sender, isOwner: false, itemCount: 1 },
  ] as PeopleSenderObservation[] };
  const store: PeopleObservationSource = {
    family: 'email',
    peopleObservations: () => {
      throw new Error('the refresher reads senders off the main thread');
    },
    peopleObservationsOffThread: async () => {
      state.reads += 1;
      return state.observations;
    },
    lastSyncRun: () => ({ syncRunId: state.syncRun, status: 'completed', completedAt: state.syncRun }),
    peopleVisibilityMarker: () => 'v1',
  };
  return { store, state };
}

describe('people index refresh reads only what changed (#1305)', () => {
  test("a moved sync marker re-reads that store alone and keeps the other store's senders", async () => {
    const clock = createTestClock();
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    cleanups.push(() => index.close());
    const mail = countingStore('mail', 'quinn');
    const chat = countingStore('chat', 'ravi');
    const refresher = new PeopleIndexRefresher(index, () => [mail.store, chat.store], { now: () => clock.now() });
    await refresher.refresh();
    expect([mail.state.reads, chat.state.reads]).toEqual([1, 1]);

    await clock.advance(PEOPLE_INDEX_MIN_REBUILD_MS);
    mail.state.syncRun = 'run-2';
    mail.state.observations = [...mail.state.observations, { provider: 'mail', senderId: 'sol@example.com', senderLabel: 'sol', isOwner: false, itemCount: 2 }];
    expect(await refresher.refreshIfChanged()).toBe(true);
    expect([mail.state.reads, chat.state.reads]).toEqual([2, 1]);
    expect(index.personForSender('mail', 'sol@example.com')).toBeDefined();
    expect(index.personForSender('chat', 'ravi@example.com')).toBeDefined();

    // A forced refresh still reads every store.
    await refresher.refresh();
    expect([mail.state.reads, chat.state.reads]).toEqual([3, 2]);
  });

  test("a store whose read failed is read again at the next check, though its markers never moved", async () => {
    const clock = createTestClock();
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    cleanups.push(() => index.close());
    const archive = countingStore('mail', 'quinn');
    let failNext = true;
    const flaky: PeopleObservationSource = {
      ...archive.store,
      peopleObservationsOffThread: async () => {
        archive.state.reads += 1;
        if (failNext) {
          failNext = false;
          throw new Error('read pool busy');
        }
        return archive.state.observations;
      },
    };
    const refresher = new PeopleIndexRefresher(index, () => [flaky], { now: () => clock.now() });
    await refresher.refresh();
    expect(index.personForSender('mail', 'quinn@example.com')).toBeUndefined();

    await clock.advance(PEOPLE_INDEX_MIN_REBUILD_MS);
    expect(await refresher.refreshIfChanged()).toBe(true);
    expect(archive.state.reads).toBe(2);
    expect(index.personForSender('mail', 'quinn@example.com')).toBeDefined();
    // Read fine: nothing to do until something moves.
    await clock.advance(PEOPLE_INDEX_MIN_REBUILD_MS);
    expect(await refresher.refreshIfChanged()).toBe(false);
  });

  test('two refreshes started together run one rebuild', async () => {
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    cleanups.push(() => index.close());
    const mail = countingStore('mail', 'quinn');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: PeopleObservationSource = {
      ...mail.store,
      peopleObservationsOffThread: async () => {
        mail.state.reads += 1;
        await gate;
        return mail.state.observations;
      },
    };
    const refresher = new PeopleIndexRefresher(index, () => [slow]);
    const first = refresher.refresh();
    const second = refresher.refresh();
    const third = refresher.refreshIfChanged();
    release();
    const [a, b] = await Promise.all([first, second, third]);
    expect(mail.state.reads).toBe(1);
    expect(b).toEqual(a);
    expect(index.personForSender('mail', 'quinn@example.com')).toBeDefined();
  });

  test("a source's Delete is not brought back by a refresh that reuses the other stores' senders", async () => {
    const clock = createTestClock();
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    cleanups.push(() => index.close());
    const mail = countingStore('mail', 'quinn');
    const chat = countingStore('chat', 'ravi');
    let stores: PeopleObservationSource[] = [mail.store, chat.store];
    const refresher = new PeopleIndexRefresher(index, () => stores, { now: () => clock.now() });
    await refresher.refresh();
    expect(index.personForSender('chat', 'ravi@example.com')).toBeDefined();

    // The chat source is deleted: its store leaves the worker's list.
    stores = [mail.store];
    await clock.advance(PEOPLE_INDEX_MIN_REBUILD_MS);
    expect(await refresher.refreshIfChanged()).toBe(true);
    expect(mail.state.reads).toBe(1);
    expect(index.personForSender('chat', 'ravi@example.com')).toBeUndefined();
    expect(index.personForSender('mail', 'quinn@example.com')).toBeDefined();

    // Its senders do not come back later either, even if the same store object returns empty.
    chat.state.observations = [];
    chat.state.syncRun = 'run-2';
    stores = [mail.store, chat.store];
    await clock.advance(PEOPLE_INDEX_MIN_REBUILD_MS);
    expect(await refresher.refreshIfChanged()).toBe(true);
    expect(index.personForSender('chat', 'ravi@example.com')).toBeUndefined();
  });

  test("an owner's correction relinks from the senders already read, without reading a store", async () => {
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    cleanups.push(() => index.close());
    const mail = countingStore('mail', 'quinn');
    const chat = countingStore('chat', 'ravi');
    const refresher = new PeopleIndexRefresher(index, () => [mail.store, chat.store]);
    expect(refresher.relink()).toBeUndefined();
    expect(await refresher.refresh()).toHaveLength(2);
    // The owner says these two senders are one person.
    index.putContactCard({ cardId: 'contacts:quinn', name: 'Quinn Holloway', keys: ['sender:mail:quinn@example.com', 'sender:chat:ravi@example.com'] });
    expect(refresher.relink()).toHaveLength(1);
    expect([mail.state.reads, chat.state.reads]).toEqual([1, 1]);
  });

  test('the worker no longer forces a rebuild on a timer after startup', () => {
    const server = readFileSync(new URL('../src/workers/engine/server.ts', import.meta.url), 'utf8');
    expect(server.includes('PEOPLE_INDEX_REFRESH_MS')).toBe(false);
    const timers = server.match(/set(?:Interval|Timeout)\(\(\) => refreshPeople\([^)]*\)[^;]*;/g) ?? [];
    expect(timers.filter((timer) => timer.startsWith('setInterval') && timer.includes('refreshPeople(true)'))).toEqual([]);
    expect(timers.some((timer) => timer.startsWith('setTimeout') && timer.includes('PEOPLE_INDEX_FIRST_REFRESH_MS'))).toBe(true);
  });
});

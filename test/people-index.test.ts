import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { deleteOlympusData } from '../src/data-lifecycle.ts';
import {
  LocalPeopleIndex,
  OWNER_PERSON_ID,
  peopleIndexPath,
  linkPeople,
  normalizePhone,
  strongKeysFromText,
  type PeopleCorrection,
  type PeoplePerson,
  type PeopleSenderObservation,
} from '../src/core/people-index.ts';
import { createTestClock } from './helpers/test-clock.ts';

function obs(provider: string, senderId: string | undefined, senderLabel: string | undefined, extra: Partial<PeopleSenderObservation> = {}): PeopleSenderObservation {
  return {
    provider,
    ...(senderId ? { senderId } : {}),
    ...(senderLabel ? { senderLabel } : {}),
    isOwner: false,
    itemCount: 1,
    ...extra,
  };
}

function personOf(people: readonly PeoplePerson[], identityKey: string): PeoplePerson {
  const person = people.find((candidate) => candidate.identities.some((identity) => identity.identityKey === identityKey));
  if (!person) throw new Error(`no person for ${identityKey}`);
  return person;
}

const EMAIL = 'sender:mail:brianna@example.com';
const CHAT_A = 'sender:chat-a:14155550123@s.example.net';
const CHAT_B = 'sender:chat-b:777';

describe('people index: strong keys', () => {
  test('reads phone numbers and email addresses as address formats', () => {
    expect(normalizePhone('+1 (415) 555-0123')).toBe('+14155550123');
    expect(normalizePhone('415 555 0123')).toBeUndefined();
    expect(strongKeysFromText('Brianna Reyes <Brianna@Example.com>')).toEqual(['email:brianna@example.com']);
    expect(strongKeysFromText('14155550123@s.example.net')).toEqual(['email:14155550123@s.example.net', 'phone:+14155550123']);
    expect(strongKeysFromText('777')).toEqual([]);
    expect(strongKeysFromText('123456@lid')).toEqual([]);
  });

  test('a mailbox whose name is all digits still links by its email address', () => {
    // A numeric mailbox (123456789@qq.com) is an address first; a phone
    // number read from it is an extra key, never in place of the address.
    expect(strongKeysFromText('Wei Zhang <123456789@QQ.com>')).toEqual(['email:123456789@qq.com', 'phone:+123456789']);
    const people = linkPeople({ observations: [
      obs('mail', '123456789@qq.com', 'Wei Zhang <123456789@qq.com>'),
      obs('mail-2', '123456789@QQ.com', undefined),
    ] });
    const person = personOf(people, 'sender:mail:123456789@qq.com');
    expect(person.identities).toHaveLength(2);
    expect(person.linkedBy).toEqual(['Linked by email address']);
    // A chat id with no name reads as its phone number, never as the id.
    const unnamed = linkPeople({ observations: [obs('chat-a', '351912000444@s.example.net', undefined)] });
    expect(personOf(unnamed, 'sender:chat-a:351912000444@s.example.net').displayName).toBe('+351912000444');
  });

  test('the same phone number links on its own, and says why', () => {
    const people = linkPeople({ observations: [
      obs('chat-a', '14155550123@s.example.net', 'Bri'),
      obs('messages', '+1 415 555 0123', undefined),
    ] });
    const person = personOf(people, CHAT_A);
    expect(person.identities.map((identity) => identity.identityKey).sort()).toEqual([
      'sender:chat-a:14155550123@s.example.net',
      'sender:messages:+1 415 555 0123',
    ]);
    expect(person.linkedBy).toEqual(['Linked by phone number']);
  });

  test('the same email address links regardless of case', () => {
    const people = linkPeople({ observations: [
      obs('mail', 'brianna@example.com', 'Brianna Reyes <brianna@example.com>'),
      obs('messages', 'BRIANNA@example.com', undefined),
    ] });
    expect(personOf(people, EMAIL).identities).toHaveLength(2);
    expect(personOf(people, EMAIL).linkedBy).toEqual(['Linked by email address']);
    expect(personOf(people, EMAIL).displayName).toBe('Brianna Reyes');
  });

  test('a card from the owner\'s contacts ties its entries together', () => {
    const people = linkPeople({
      observations: [
        obs('mail', 'brianna@example.com', 'Brianna Reyes <brianna@example.com>'),
        obs('chat-a', '14155550123@s.example.net', 'Bri'),
        obs('chat-b', '777', 'Brianna R.'),
      ],
      contacts: [{ cardId: 'c1', name: 'Brianna Reyes', keys: ['email:brianna@example.com', 'phone:+14155550123', CHAT_B] }],
    });
    const person = personOf(people, EMAIL);
    expect(person.identities).toHaveLength(3);
    expect(person.linkedBy).toEqual(['Linked by your contacts']);
  });
});

describe('people index: names', () => {
  test('a name alone never links', () => {
    const people = linkPeople({ observations: [
      obs('mail', 'brianna@example.com', 'Brianna Reyes <brianna@example.com>'),
      obs('chat-b', '777', 'Brianna Reyes'),
    ] });
    expect(people).toHaveLength(2);
  });

  test('a name and a shared conversation link', () => {
    const people = linkPeople({ observations: [
      obs('chat-b', 'user777', 'Brianna Reyes', { conversationIds: ['g1'] }),
      obs('chat-b', '777', 'Brianna  Reyes', { conversationIds: ['g1', 'g2'] }),
    ] });
    expect(people).toHaveLength(1);
    expect(people[0]!.linkedBy).toEqual(['Linked by name and a shared conversation']);
  });

  test('a name and a group chat with the same third person link across sources', () => {
    const people = linkPeople({ observations: [
      // Mark is one person on both sources (same email).
      obs('chat-a', 'mark@example.com', 'Mark', { conversationIds: ['trip'] }),
      obs('chat-b', 'mark@example.com', 'Mark', { conversationIds: ['crew'] }),
      obs('chat-a', 'a1', 'Brianna Reyes', { conversationIds: ['trip'] }),
      obs('chat-b', 'b1', 'Brianna Reyes', { conversationIds: ['crew'] }),
    ] });
    const person = personOf(people, 'sender:chat-a:a1');
    expect(person.identities.map((identity) => identity.identityKey)).toContain('sender:chat-b:b1');
    expect(person.linkedBy).toEqual(['Linked by name and shared group chat']);
  });

  test('a shared group with only the owner is not a signal', () => {
    const people = linkPeople({ observations: [
      obs('chat-a', 'me-a', 'Jamie', { isOwner: true, conversationIds: ['x'] }),
      obs('chat-b', 'me-b', 'Jamie', { isOwner: true, conversationIds: ['y'] }),
      obs('chat-a', 'a1', 'Sam', { conversationIds: ['x'] }),
      obs('chat-b', 'b1', 'Sam', { conversationIds: ['y'] }),
    ] });
    expect(personOf(people, 'sender:chat-a:a1').identities).toHaveLength(1);
  });

  test('same-name people the rules did not link are offered as suggestions', () => {
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    try {
      index.rebuild([
        obs('mail', 'brianna@example.com', 'Brianna Reyes <brianna@example.com>'),
        obs('chat-b', '777', 'Brianna Reyes'),
      ]);
      expect(index.suggestions()).toEqual([expect.objectContaining({ name: 'brianna reyes' })]);
    } finally {
      index.close();
    }
  });
});

describe('people index: one "me"', () => {
  test('every identity a source marks as the owner is the person You', () => {
    const people = linkPeople({ observations: [
      obs('mail', 'jamie@example.com', 'Jamie Z <jamie@example.com>', { isOwner: true }),
      obs('chat-a', '351910000000@s.example.net', 'Jamie', { isOwner: true }),
      obs('chat-b', '42', 'J', { isOwner: true }),
      obs('chat-b', '777', 'Brianna'),
    ] });
    const me = people.find((person) => person.personId === OWNER_PERSON_ID)!;
    expect(me.displayName).toBe('You');
    expect(me.isOwner).toBe(true);
    expect(me.identities).toHaveLength(3);
    expect(people).toHaveLength(2);
  });
});

describe('people index: owner corrections', () => {
  const observations = [
    obs('mail', 'brianna@example.com', 'Brianna Reyes <brianna@example.com>'),
    obs('messages', 'brianna@example.com', 'Bri'),
    obs('chat-b', '777', 'Brianna R.'),
  ];

  test('corrections persist across reopen and re-sync; a rejected pair stays rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'people-index-'));
    const clock = createTestClock();
    const dbPath = join(dir, 'people.sqlite');
    try {
      let index = new LocalPeopleIndex({ dbPath, now: () => clock.date() });
      index.rebuild(observations);
      expect(personOf(index.list(), EMAIL).identities).toHaveLength(2);

      index.correct({ kind: 'not_same', identityA: EMAIL, identityB: 'sender:messages:brianna@example.com' });
      index.correct({ kind: 'merge', identityA: EMAIL, identityB: CHAT_B });
      index.correct({ kind: 'rename', identity: CHAT_B, name: 'Brianna Reyes (work)' });
      index.close();

      // Re-sync: a fresh process rebuilds from the same senders.
      index = new LocalPeopleIndex({ dbPath, now: () => clock.date() });
      index.rebuild(observations);
      const person = personOf(index.list(), EMAIL);
      expect(person.identities.map((identity) => identity.identityKey).sort()).toEqual([CHAT_B, EMAIL]);
      expect(person.displayName).toBe('Brianna Reyes (work)');
      expect(person.linkedBy).toEqual(['Merged by you']);
      expect(personOf(index.list(), 'sender:messages:brianna@example.com').identities).toHaveLength(1);
      // The rejected pair is not offered again either.
      expect(index.suggestions().some((s) => [s.identityA, s.identityB].includes('sender:messages:brianna@example.com')
        && [s.identityA, s.identityB].includes(EMAIL))).toBe(false);

      // A later sync that brings a third identity with the same email still cannot rejoin the pair.
      index.rebuild([...observations, obs('mail-2', 'Brianna@Example.com', undefined)]);
      const rejoined = personOf(index.list(), EMAIL).identities.map((identity) => identity.identityKey);
      expect(rejoined).not.toContain('sender:messages:brianna@example.com');
      index.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('splitting or rejecting the first identity of a shared key keeps the others together', () => {
    const shared = [
      obs('a', 'sam@example.com', 'Sam'),
      obs('b', 'sam@example.com', 'Sam'),
      obs('c', 'sam@example.com', 'Sam'),
    ];
    const keysOf = (people: readonly PeoplePerson[], key: string) => personOf(people, key).identities.map((identity) => identity.identityKey).sort();
    const split = linkPeople({ observations: shared, corrections: [{ kind: 'split', identity: 'sender:a:sam@example.com' }] });
    expect(keysOf(split, 'sender:a:sam@example.com')).toEqual(['sender:a:sam@example.com']);
    expect(keysOf(split, 'sender:b:sam@example.com')).toEqual(['sender:b:sam@example.com', 'sender:c:sam@example.com']);

    const rejected = linkPeople({
      observations: shared,
      corrections: [{ kind: 'not_same', identityA: 'sender:a:sam@example.com', identityB: 'sender:b:sam@example.com' }],
    });
    // The rejected pair stays apart; the third identity still joins one of them.
    expect(keysOf(rejected, 'sender:b:sam@example.com')).not.toContain('sender:a:sam@example.com');
    expect(keysOf(rejected, 'sender:c:sam@example.com')).toHaveLength(2);

    // The same through a contact card whose first entry is split off.
    const card = linkPeople({
      observations: [obs('a', '1', 'Sam'), obs('b', '2', 'Sam'), obs('c', '3', 'Sam')],
      contacts: [{ cardId: 'sam', name: 'Sam', keys: ['sender:a:1', 'sender:b:2', 'sender:c:3'] }],
      corrections: [{ kind: 'split', identity: 'sender:a:1' }],
    });
    expect(keysOf(card, 'sender:b:2')).toEqual(['sender:b:2', 'sender:c:3']);
  });

  describe('are replayed in the order the owner made them', () => {
    const A = 'sender:a:1';
    const B = 'sender:b:2';
    const C = 'sender:c:3';
    const three = [obs('a', '1', 'Ana'), obs('b', '2', 'Bea'), obs('c', '3', 'Cy')];
    const replay = (corrections: PeopleCorrection[], observations = three): PeoplePerson[] => {
      const index = new LocalPeopleIndex({ dbPath: ':memory:' });
      try {
        for (const correction of corrections) index.correct(correction);
        return index.rebuild(observations);
      } finally {
        index.close();
      }
    };
    const keysOf = (people: readonly PeoplePerson[], key: string) => personOf(people, key).identities.map((identity) => identity.identityKey).sort();

    test('the newest rename of any identity of a person wins', () => {
      const people = replay([
        { kind: 'merge', identityA: A, identityB: B },
        { kind: 'rename', identity: A, name: 'First' },
        { kind: 'rename', identity: B, name: 'Second' },
        { kind: 'rename', identity: A, name: 'Latest' },
      ]);
      expect(personOf(people, A).displayName).toBe('Latest');
    });

    test('a later Not the same cuts an earlier chain of merges', () => {
      const people = replay([
        { kind: 'merge', identityA: A, identityB: B },
        { kind: 'merge', identityA: B, identityB: C },
        { kind: 'not_same', identityA: A, identityB: C },
      ]);
      expect(keysOf(people, A)).not.toContain(C);
      // The newest merge on the path is the one undone: A and B stay together.
      expect(keysOf(people, A)).toEqual([A, B]);
      expect(keysOf(people, C)).toEqual([C]);
    });

    test('a later merge chain overrides an earlier Not the same', () => {
      const people = replay([
        { kind: 'not_same', identityA: A, identityB: C },
        { kind: 'merge', identityA: A, identityB: B },
        { kind: 'merge', identityA: B, identityB: C },
      ]);
      expect(keysOf(people, A)).toEqual([A, B, C]);
    });

    test('a later split undoes earlier merges, and a later merge undoes the split', () => {
      expect(keysOf(replay([
        { kind: 'merge', identityA: A, identityB: B },
        { kind: 'split', identity: A },
      ]), A)).toEqual([A]);
      expect(keysOf(replay([
        { kind: 'split', identity: A },
        { kind: 'merge', identityA: A, identityB: B },
      ]), A)).toEqual([A, B]);
    });

    test('a split first identity of a shared key leaves the rest together', () => {
      const shared = [obs('a', 'sam@example.com', 'Sam'), obs('b', 'sam@example.com', 'Sam'), obs('c', 'sam@example.com', 'Sam')];
      const people = replay([{ kind: 'split', identity: 'sender:a:sam@example.com' }], shared);
      expect(keysOf(people, 'sender:b:sam@example.com')).toEqual(['sender:b:sam@example.com', 'sender:c:sam@example.com']);
    });

    test('the newer answer about the same pair wins, either way round', () => {
      expect(keysOf(replay([
        { kind: 'not_same', identityA: A, identityB: B },
        { kind: 'merge', identityA: B, identityB: A },
      ]), A)).toEqual([A, B]);
      expect(keysOf(replay([
        { kind: 'merge', identityA: A, identityB: B },
        { kind: 'not_same', identityA: B, identityB: A },
      ]), A)).toEqual([A]);
    });
  });

  test('split keeps an identity on its own until the owner merges it', () => {
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    try {
      index.correct({ kind: 'split', identity: 'sender:messages:brianna@example.com' });
      index.rebuild(observations);
      expect(personOf(index.list(), 'sender:messages:brianna@example.com').identities).toHaveLength(1);
      index.correct({ kind: 'merge', identityA: EMAIL, identityB: 'sender:messages:brianna@example.com' });
      index.rebuild(observations);
      expect(personOf(index.list(), EMAIL).identities).toHaveLength(2);
    } finally {
      index.close();
    }
  });

  test('a name seen only on Private rows is never a citation name', () => {
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    try {
      index.rebuild([
        obs('mail', 'brianna@example.com', 'Secret Alias <brianna@example.com>', { privateOnly: true }),
        obs('messages', 'brianna@example.com', undefined),
      ]);
      expect(index.personForSender('messages', 'brianna@example.com')).toBeDefined();
      expect(index.citationName('messages', 'brianna@example.com')).toBeUndefined();
    } finally {
      index.close();
    }
  });
});

describe('people index: Private local data', () => {
  test('lives in the data root and Delete all removes it, wherever XDG_DATA_HOME puts it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'people-index-delete-'));
    const homeDir = join(dir, 'home');
    const env = { HOME: homeDir, XDG_DATA_HOME: join(dir, 'elsewhere') };
    try {
      const path = peopleIndexPath(env);
      expect(path.startsWith(join(dir, 'elsewhere'))).toBe(true);
      const index = new LocalPeopleIndex({ dbPath: path });
      index.correct({ kind: 'rename', identity: EMAIL, name: 'Brianna' });
      index.close();
      expect(existsSync(path)).toBe(true);
      deleteOlympusData({ all: true, homeDir, env });
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

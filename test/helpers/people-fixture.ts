// The People mockup's people (3-people.png, #1076), for the page's tests and screenshots.
import type { LocalPeopleIndex, PeopleSenderObservation } from '../../src/core/people-index.ts';

function obs(provider: string, senderId: string, senderLabel: string | undefined, itemCount: number, extra: Partial<PeopleSenderObservation> = {}): PeopleSenderObservation {
  return { provider, senderId, ...(senderLabel ? { senderLabel } : {}), isOwner: false, itemCount, ...extra };
}

/** The mockup's people: You, Brianna (phone), Mark (email), a number with no name, and a same-name Brianna on Telegram. */
export function peopleFixture(): PeopleSenderObservation[] {
  return [
    obs('gmail', 'jamie@example.com', 'Jamie <jamie@example.com>', 900, { isOwner: true }),
    obs('telegram', '42', 'Jamie', 400, { isOwner: true }),
    obs('whatsapp', '351910000000@s.whatsapp.net', 'Jamie', 300, { isOwner: true }),
    obs('gmail', 'brianna@example.com', 'Brianna Reyes <brianna@example.com>', 120),
    obs('whatsapp', '14155550123@s.whatsapp.net', 'Brianna Reyes', 150),
    obs('apple_messages', '+14155550123', undefined, 42),
    obs('telegram', '777', 'Brianna Reyes', 40),
    obs('telegram', 'theo@example.com', '@lindqvist_t', 600),
    obs('gmail', 'theo@example.com', 'Theo Lindqvist <theo@example.com>', 448),
    obs('whatsapp', '351912000444@s.whatsapp.net', undefined, 4),
    obs('telegram', '999', 'Sam', 1),
    obs('gmail', 'sam@example.com', 'Sam <sam@example.com>', 1),
  ];
}

/** The owner's contacts tie Brianna's address and number together. */
export function seedPeople(index: LocalPeopleIndex): void {
  index.putContactCard({ cardId: 'brianna', name: 'Brianna Reyes', keys: ['email:brianna@example.com', 'phone:+14155550123'] });
  index.rebuild(peopleFixture());
}


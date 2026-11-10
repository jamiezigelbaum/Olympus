import { describe, expect, test } from 'bun:test';
import { LocalPeopleIndex } from '../src/core/people-index.ts';
import { peopleFixture, seedPeople } from './helpers/people-fixture.ts';
import { renderDashboardLocalPage, dashboardHtmlRoutePage } from '../src/workers/dashboard/index.ts';
import { createDashboardPeople, dashboardPeopleView, PEOPLE_SUGGESTION_MIN_MESSAGES } from '../src/workers/email-source/dashboard-people.ts';

describe('People page (#1076)', () => {
  test('lists You, every person with why they were linked, and asks only about pairs worth asking', () => {
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    try {
      seedPeople(index);
      const view = dashboardPeopleView(index);
      // Brianna on Telegram shares only her name with Brianna in Gmail/WhatsApp: asked.
      expect(view.suggestions.map((s) => [s.a.name, s.a.source, s.b.name, s.b.source])).toEqual([['Brianna Reyes', 'Telegram', 'Brianna Reyes', 'WhatsApp']]);
      expect(view.suggestions[0]!.a.name).toBe('Brianna Reyes');
      // Sam has one message on each side, under the threshold: not asked.
      expect(PEOPLE_SUGGESTION_MIN_MESSAGES).toBeGreaterThan(1);
      const html = renderDashboardLocalPage('people', {
        url: new URL('http://127.0.0.1/dashboard?people'),
        options: { controlSessionCsrfToken: 'csrf' },
        people: view,
        peopleLocalSession: true,
      });
      expect(html).toContain('Same person?');
      expect(html).toContain('Linked by phone number and your contacts');
      expect(html).toContain('Linked by email address');
      expect(html).toContain('No name yet');
      expect(html).toContain('data-pp-you');
      expect(html).toContain('Linking people never decides privacy.');
      expect(html).not.toContain('Is <b>Sam</b>');
    } finally {
      index.close();
    }
  });

  test('a chat id shows as its phone number, a numeric mailbox as its address', () => {
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    try {
      index.rebuild([
        { provider: 'whatsapp', senderId: '14155550123@s.whatsapp.net', senderLabel: 'Brianna Reyes', isOwner: false, itemCount: 3 },
        { provider: 'gmail', senderId: '123456789@qq.com', senderLabel: 'Wei Zhang <123456789@qq.com>', isOwner: false, itemCount: 3 },
      ]);
      const chips = dashboardPeopleView(index).people.flatMap((person) => person.identities.map((chip) => [chip.source, chip.detail]));
      expect(chips.sort()).toEqual([['Gmail', '123456789@qq.com'], ['WhatsApp', '+14155550123']]);
    } finally {
      index.close();
    }
  });

  test('merge choices are rendered once, not once per person', () => {
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    try {
      index.rebuild(Array.from({ length: 40 }, (_, n) => ({ provider: 'gmail', senderId: `p${n}@example.com`, senderLabel: `Person ${n} <p${n}@example.com>`, isOwner: false, itemCount: 1 })));
      const html = renderDashboardLocalPage('people', {
        url: new URL('http://127.0.0.1/dashboard?people'),
        options: { controlSessionCsrfToken: 'csrf' },
        people: dashboardPeopleView(index),
        peopleLocalSession: true,
      });
      expect(html.match(/<option /g)?.length).toBe(40);
      expect(html.match(/data-pp-merge-options/g)?.length).toBeGreaterThanOrEqual(1);
    } finally {
      index.close();
    }
  });

  test('without a local control session the page shows no one', () => {
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    try {
      seedPeople(index);
      const html = renderDashboardLocalPage('people', {
        url: new URL('http://127.0.0.1/dashboard?people'),
        options: { controlSessionCsrfToken: 'csrf' },
        people: dashboardPeopleView(index),
        peopleLocalSession: false,
      });
      expect(html).not.toContain('Brianna');
      expect(html).toContain('People opens only in the dashboard on this computer');
      expect(dashboardHtmlRoutePage(new URL('http://127.0.0.1/dashboard?people'))).toBe('people');
    } finally {
      index.close();
    }
  });

  test('Not the same and Same person are kept and refresh the list', () => {
    const index = new LocalPeopleIndex({ dbPath: ':memory:' });
    try {
      let refreshes = 0;
      const people = createDashboardPeople({ index, refresh: () => { refreshes += 1; index.rebuild(peopleFixture()); } });
      seedPeople(index);
      const ask = dashboardPeopleView(index).suggestions[0]!;
      expect(people.handle({ op: 'not_same', identity_a: ask.identityA, identity_b: ask.identityB }).status).toBe(200);
      expect(dashboardPeopleView(index).suggestions).toHaveLength(0);
      expect(people.handle({ op: 'same', identity_a: ask.identityA, identity_b: ask.identityB }).status).toBe(200);
      const brianna = index.list().find((person) => person.identities.some((identity) => identity.identityKey === 'sender:telegram:777'))!;
      expect(brianna.identities.map((identity) => identity.provider).sort()).toEqual(['apple_messages', 'gmail', 'telegram', 'whatsapp']);
      expect(people.handle({ op: 'rename', identity: 'sender:telegram:777', name: 'Bri' }).status).toBe(200);
      expect(index.personForSender('gmail', 'brianna@example.com')?.displayName).toBe('Bri');
      expect(people.handle({ op: 'split', identity: 'sender:telegram:777' }).status).toBe(200);
      expect(index.personForSender('telegram', '777')?.identities).toHaveLength(1);
      expect(people.handle({ op: 'merge', identity_a: 'sender:telegram:nobody', identity_b: 'sender:telegram:777' }).status).toBe(400);
      expect(people.handle({ op: 'drop_table' }).status).toBe(400);
      // The owner's own accounts are always You: refused, and nothing is kept.
      const refused = people.handle({ op: 'split', identity: 'sender:gmail:jamie@example.com' });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ ok: false, error: { code: 'owner_is_you' } });
      expect(refreshes).toBe(4);
    } finally {
      index.close();
    }
  });
});
